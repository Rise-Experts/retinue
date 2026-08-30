/**
 * Discord — REQ-053 (#227), task #231.
 *
 * The shape is deliberately `tools-slack`'s, so most of what is asserted here is the *same* contract. AC-3 is
 * the genuinely new part: a bot that was never invited fails identically to a bad token, and the remedies could
 * not be more different.
 */
import { readFileSync } from "node:fs";
import type { ConversationId } from "@retinue/agentkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  classifyAccess,
  createDiscordToolkit,
  DISCORD_AUTH,
  DISCORD_TOOL_NAMES,
  discordCodeOf,
  MAX_MESSAGE_LENGTH,
  messageLength,
  nearestArchive,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"), principalId: asId("p1"), roleIds: [], locale: "en",
  timezone: "UTC", requestId: asId("req1"), conversationId: asId<ConversationId>("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const toolkit = (fetchImpl: typeof fetch) =>
  createDiscordToolkit({
    credentialRef: "discord",
    // `Authorization: Bot <token>` — the word `Bot` is part of the value.
    resolver: createStaticCredentialResolver({ discord: { scheme: "custom-header", header: "Authorization", value: "Bot abc" } }),
    fetchImpl,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

const failure = (status: number, reason: string) => ({ ok: false as const, url: "u", kind: "http-error" as const, status, reason });

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...DISCORD_TOOL_NAMES]);
  });

  it("leaves the reaction ungated and gates every message write", async () => {
    // Consistent with `tools-slack`: a reaction carries no content and is trivially reversible.
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("discord_add_reaction")).toMatchObject({ effect: "internal-write", approvalPolicy: "never" });
    for (const write of ["discord_send_message", "discord_reply_message", "discord_create_thread"]) {
      expect(byName.get(write), write).toMatchObject({ effect: "external-write", approvalPolicy: "always", requiresIdempotencyKey: true });
    }
    for (const read of ["discord_list_channels", "discord_read_messages", "discord_get_message"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
  });

  it("sends the token in Discord's `Bot <token>` form", async () => {
    expect(DISCORD_AUTH).toEqual({ modes: ["token"], schemes: ["custom-header"] });
    let seen: Headers | undefined;
    const fetchImpl = vi.fn(async (_u: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers);
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    await run("discord_list_channels", fetchImpl, { guildId: "g1" });
    expect(seen?.get("authorization")).toBe("Bot abc");
  });
});

describe("an uninvited bot is not a bad token — AC-3", () => {
  it("names the invite as the remedy for Missing Access", () => {
    /**
     * The single most common support question on this platform. Conflating the two sends whoever is debugging
     * to regenerate a token that was fine.
     */
    for (const code of [50001, 50013, 10003, 10004]) {
      const result = classifyAccess(failure(403, `That URL returned 403: {"code":${code},"message":"Missing Access"}`));
      expect(result?.message, String(code)).toContain("not a credential problem");
      expect(result?.message).toContain("Invite it");
      expect(result?.retryable).toBe(false);
    }
  });

  it("names the token as the remedy for a bare 401", () => {
    const result = classifyAccess(failure(401, "That URL returned 401: {}"));
    expect(result?.message).toContain("*is* a credential problem");
    expect(result?.message).toContain("Bot <token>");
  });

  it("leaves anything else to the shared default", () => {
    expect(classifyAccess(failure(500, "boom"))).toBeUndefined();
    expect(classifyAccess(failure(429, "slow"))).toBeUndefined();
  });

  it("parses Discord's error code out of the reason, and survives what it cannot parse", () => {
    expect(discordCodeOf('returned 403: {"code":50001}')).toBe(50001);
    expect(discordCodeOf("no json")).toBeUndefined();
    expect(discordCodeOf("returned 403: {broken")).toBeUndefined();
  });

  it("reaches the model as a distinguishable failure end to end", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 50001, message: "Missing Access" }, 403)) as unknown as typeof fetch;
    const result = (await run("discord_read_messages", fetchImpl, { channelId: "c1" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("not a member of that server");
  });
});

describe("reads and writes behave like Slack's", () => {
  it("keeps only channels these tools can post to", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([{ id: "1", name: "general", type: 0 }, { id: "2", name: "voice", type: 2 }, { id: "3", name: "news", type: 5 }]),
    ) as unknown as typeof fetch;
    const result = (await run("discord_list_channels", fetchImpl, { guildId: "g" })) as { data: { channels: { id: string }[] } };
    expect(result.data.channels.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("reports truncation and how to continue, since Discord pages by snowflake", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ id: String(i), author: { username: "a" }, content: "x" }));
    const fetchImpl = vi.fn(async () => jsonResponse(messages)) as unknown as typeof fetch;
    const result = (await run("discord_read_messages", fetchImpl, { channelId: "c", limit: 50 })) as {
      data: { truncated: boolean; continueBeforeId: string };
    };
    expect(result.data.truncated).toBe(true);
    expect(result.data.continueBeforeId).toBe("49");
  });

  it("does not claim truncation for a short page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: "1", author: {} }])) as unknown as typeof fetch;
    const result = (await run("discord_read_messages", fetchImpl, { channelId: "c", limit: 50 })) as { data: { truncated: boolean } };
    expect(result.data.truncated).toBe(false);
  });

  it("cannot @everyone by quoting text that contains it", async () => {
    /**
     * Discord's default honours every mention in the content, which makes an accidental mass-ping a
     * one-character mistake — and an agent relaying a user's text is exactly how that happens.
     */
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return jsonResponse({ id: "m1" });
    }) as unknown as typeof fetch;
    await run("discord_send_message", fetchImpl, { channelId: "c", text: "hey @everyone" });
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("counts a message in code points and refuses an over-long one locally", async () => {
    expect(messageLength("😀😀")).toBe(2);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("discord_send_message", fetchImpl, { channelId: "c", text: "a".repeat(MAX_MESSAGE_LENGTH + 1) })) as {
      ok: false; error: { message: string };
    };
    expect(result.error.message).toContain(`at most ${MAX_MESSAGE_LENGTH}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("snaps an archive duration to one Discord accepts", () => {
    // Discord takes only these four and rejects anything else with a validation error naming no field.
    expect(nearestArchive(1440)).toBe(1440);
    expect(nearestArchive(90)).toBe(60);
    expect(nearestArchive(5000)).toBe(4320);
    expect(nearestArchive(99999)).toBe(10080);
  });

  it("refuses a thread name Discord would reject", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("discord_create_thread", fetchImpl, { channelId: "c", messageId: "m", name: "" })) as {
      ok: false; error: { message: string };
    };
    expect(result.error.message).toContain("1 and 100 characters");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads no environment variable anywhere in the package source — AC-6", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });
});
