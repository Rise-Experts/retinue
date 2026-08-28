/**
 * Telegram — REQ-053 (#227), task #231.
 *
 * AC-5 is the interesting one: "respected by construction, not by retrying into it" is a claim, and a claim
 * about pacing has to be demonstrated rather than described. So the pacer is tested directly, with an injected
 * clock, and then through the tool.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  classifyAccess,
  createPacer,
  createTelegramToolkit,
  MAX_MESSAGE_LENGTH,
  MIN_SEND_GAP_MS,
  TELEGRAM_AUTH,
  TELEGRAM_TOOL_NAMES,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"), principalId: asId("p1"), roleIds: [], locale: "en",
  timezone: "UTC", requestId: asId("req1"), conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A clock that only moves when the code under test sleeps, so a test costs no real seconds. */
const fakeClock = () => {
  let ms = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => ms,
    sleep: async (wait: number) => {
      slept.push(wait);
      ms += wait;
    },
    advance: (by: number) => {
      ms += by;
    },
    slept,
  };
};

const toolkit = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createTelegramToolkit({
    credentialRef: "telegram",
    resolver: createStaticCredentialResolver({ telegram: "123:ABC" }),
    fetchImpl,
    ...extra,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown, extra: Record<string, unknown> = {}) => {
  const tools = await toolkit(fetchImpl, extra).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

const ok = (result: unknown = { message_id: 7 }) => jsonResponse({ ok: true, result });

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...TELEGRAM_TOOL_NAMES]);
  });

  it("makes the delete destructive and gates every other write", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("telegram_delete_message")).toMatchObject({
      effect: "destructive", approvalPolicy: "always", requiresIdempotencyKey: true,
    });
    for (const write of ["telegram_send_message", "telegram_send_media", "telegram_edit_message", "telegram_pin_message"]) {
      expect(byName.get(write), write).toMatchObject({ effect: "external-write", approvalPolicy: "always" });
    }
    expect(byName.get("telegram_get_chat")).toMatchObject({ effect: "read", approvalPolicy: "never" });
    expect(TELEGRAM_AUTH).toEqual({ modes: ["token"], schemes: ["bearer"] });
  });

  it("puts the token in the path, which is where Telegram wants it", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return ok({ id: 1, type: "group" });
    }) as unknown as typeof fetch;
    await run("telegram_get_chat", fetchImpl, { chatId: "-100" });
    expect(urls[0]).toContain("/bot123:ABC/getChat");
  });

  it("has no getUpdates tool, because inbound delivery is not a tool call", async () => {
    // A polling tool would hold a request open and compete with the deployment's own webhook for the same
    // updates — Telegram delivers each update once.
    const names = (await toolkit(vi.fn() as unknown as typeof fetch).listTools(context)).map((t) => t.descriptor.name);
    expect(names.some((name) => /update|poll/i.test(name))).toBe(false);
  });
});

describe("sends are paced by construction — AC-5", () => {
  it("spaces two sends to the same chat by the per-chat gap", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ gapMs: 1000, now: clock.now, sleep: clock.sleep });
    await pacer.send("a", async () => "first");
    await pacer.send("a", async () => "second");
    // The second send waited rather than discovering the limit by being refused.
    expect(clock.slept).toEqual([1000]);
  });

  it("does not make different chats wait for each other", async () => {
    // A single global queue would be simpler and wrong: a bot serving fifty conversations would serialise all
    // of them behind the slowest.
    const clock = fakeClock();
    const pacer = createPacer({ gapMs: 1000, now: clock.now, sleep: clock.sleep });
    await pacer.send("a", async () => 1);
    await pacer.send("b", async () => 2);
    expect(clock.slept).toEqual([]);
  });

  it("does not wait when the gap has already passed", async () => {
    const clock = fakeClock();
    const pacer = createPacer({ gapMs: 1000, now: clock.now, sleep: clock.sleep });
    await pacer.send("a", async () => 1);
    clock.advance(5000);
    await pacer.send("a", async () => 2);
    expect(clock.slept).toEqual([]);
  });

  it("serialises concurrent sends to one chat, so neither sees an empty gap", async () => {
    /**
     * The race a naive "check the last send time" pacer loses: two calls issued together both read the same
     * stale timestamp and both fire immediately.
     */
    const clock = fakeClock();
    const pacer = createPacer({ gapMs: 1000, now: clock.now, sleep: clock.sleep });
    const order: string[] = [];
    await Promise.all([
      pacer.send("a", async () => { order.push("first"); }),
      pacer.send("a", async () => { order.push("second"); }),
    ]);
    expect(order).toEqual(["first", "second"]);
    expect(clock.slept).toEqual([1000]);
  });

  it("keeps a chat's queue alive after a failed send", async () => {
    // A rejected promise left in the chain would poison that chat forever.
    const clock = fakeClock();
    const pacer = createPacer({ gapMs: 1000, now: clock.now, sleep: clock.sleep });
    await expect(pacer.send("a", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    await expect(pacer.send("a", async () => "recovered")).resolves.toBe("recovered");
  });

  it("uses Telegram's documented floor", () => {
    expect(MIN_SEND_GAP_MS).toBe(1000);
  });

  it("paces through the tool, not only the helper", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const provider = createTelegramToolkit({
      credentialRef: "telegram",
      resolver: createStaticCredentialResolver({ telegram: "t" }),
      fetchImpl, now: clock.now, sleep: clock.sleep,
    });
    const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === "telegram_send_message");
    await tool?.execute({ context, input: { chatId: "-1", text: "a" } });
    await tool?.execute({ context, input: { chatId: "-1", text: "b" } });
    expect(clock.slept).toEqual([1000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not pace an edit, which is not a send", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const provider = createTelegramToolkit({
      credentialRef: "telegram",
      resolver: createStaticCredentialResolver({ telegram: "t" }),
      fetchImpl, now: clock.now, sleep: clock.sleep,
    });
    const tools = await provider.listTools(context);
    const send = tools.find((t) => t.descriptor.name === "telegram_send_message");
    const edit = tools.find((t) => t.descriptor.name === "telegram_edit_message");
    await send?.execute({ context, input: { chatId: "-1", text: "a" } });
    await edit?.execute({ context, input: { chatId: "-1", messageId: 1, text: "b" } });
    expect(clock.slept).toEqual([]);
  });
});

describe("the envelope, access and defaults", () => {
  it("reads Telegram's 200-with-ok:false as a failure", async () => {
    // The fourth vendor in this repository to answer 200 with an error envelope.
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, description: "chat not found" })) as unknown as typeof fetch;
    const result = (await run("telegram_get_chat", fetchImpl, { chatId: "x" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("chat not found");
  });

  it("honours retry_after from the envelope rather than guessing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, description: "Too Many Requests", parameters: { retry_after: 12 } })) as unknown as typeof fetch;
    const result = (await run("telegram_get_chat", fetchImpl, { chatId: "x" })) as {
      ok: false; error: { code: string; retryable: boolean; retryAfterMs: number };
    };
    expect(result.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 12_000 });
  });

  it("tells an uninvited bot apart from a bad token — AC-3", () => {
    const notMember = classifyAccess({ ok: false, url: "u", kind: "http-error", status: 403, reason: "Forbidden: bot is not a member" });
    expect(notMember?.message).toContain("not a credential problem");
    expect(notMember?.message).toContain("has never");
    const badToken = classifyAccess({ ok: false, url: "u", kind: "http-error", status: 401, reason: "Unauthorized" });
    expect(badToken?.message).toContain("*is* a credential problem");
    expect(classifyAccess({ ok: false, url: "u", kind: "http-error", status: 500, reason: "boom" })).toBeUndefined();
  });

  it("sends plain text unless markdown is asked for", async () => {
    /**
     * `MarkdownV2` requires escaping a dozen characters, and one unescaped `.` or `-` makes Telegram reject
     * the whole message — so plain text is the safe default rather than the convenient one.
     */
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return ok();
    }) as unknown as typeof fetch;
    await run("telegram_send_message", fetchImpl, { chatId: "-1", text: "a-b.c" });
    expect(body.parse_mode).toBeUndefined();
  });

  it("pins silently by default", async () => {
    // Pinning notifies every member of a group; a notification to a thousand people is not a side effect an
    // agent should cause by omission.
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return ok(true);
    }) as unknown as typeof fetch;
    const result = (await run("telegram_pin_message", fetchImpl, { chatId: "-1", messageId: 5 })) as { data: { notified: boolean } };
    expect(body.disable_notification).toBe(true);
    expect(result.data.notified).toBe(false);
  });

  it("refuses an over-long or empty message locally", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const text of ["", "a".repeat(MAX_MESSAGE_LENGTH + 1)]) {
      const result = (await run("telegram_send_message", fetchImpl, { chatId: "-1", text })) as { ok: false };
      expect(result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads no environment variable anywhere in the package source — AC-6", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });
});
