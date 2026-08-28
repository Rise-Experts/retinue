/**
 * X — REQ-053 (#227), task #230.
 *
 * AC-3 is the reason this file exists. X reports a 15-minute burst limit and a 24-hour cap identically, as
 * `429`, and a naive handler treats them the same — so a run that exhausts its daily cap sits in exponential
 * backoff against a limit that resets *tomorrow*, burning its whole budget waiting for something that cannot
 * happen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import { classifyRateLimit, createXToolkit, MAX_POST_LENGTH, postLength, X_AUTH, X_TOOL_NAMES } from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const toolkit = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createXToolkit({
    credentialRef: "x",
    resolver: createStaticCredentialResolver({ x: "bearer-test" }),
    tier: "basic",
    fetchImpl,
    ...extra,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown, extra: Record<string, unknown> = {}) => {
  const tools = await toolkit(fetchImpl, extra).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...X_TOOL_NAMES]);
  });

  it("keeps x_delete_post destructive, whatever #228 decided about publishing", async () => {
    /**
     * AC-2 states this explicitly, and it is worth pinning: #228 decided publishing keeps `external-write`,
     * and a deletion is a *different* question. It is irreversible and it is public, so `destroys()` — which
     * sets effect, approval and idempotency together and forbids overriding any of them.
     */
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    expect(byName.get("x_delete_post")).toMatchObject({
      effect: "destructive",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
      category: "publishing",
    });
    expect(byName.get("x_post")).toMatchObject({
      effect: "external-write",
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
      category: "publishing",
    });
    for (const read of ["x_search_posts", "x_get_post", "x_get_user", "x_list_user_posts"]) {
      expect(byName.get(read), read).toMatchObject({ effect: "read", approvalPolicy: "never" });
    }
  });

  it("records that reading and posting need different credentials", () => {
    // Both are bearers on the wire and are not interchangeable: an app-only bearer cannot post, because a post
    // needs a user context. That is exactly what `modes` exists to record.
    expect(X_AUTH).toEqual({ modes: ["token", "oauth2"], schemes: ["bearer"] });
  });
});

describe("the daily cap is not the burst limit — AC-3", () => {
  const failure = (headers: Record<string, string>) => ({ ok: false as const, url: "u", kind: "http-error" as const, status: 429, reason: "Too Many Requests", headers });

  it("treats an exhausted 24-hour cap as NOT retryable", () => {
    /**
     * The specific failure mode this AC names. Marking it retryable makes the runtime back off against a limit
     * that resets tomorrow — and `retryAfterMs` is deliberately absent, because a delay that long is not a
     * delay, it is a different day.
     */
    const result = classifyRateLimit(
      failure({ "x-user-limit-24hour-remaining": "0", "x-user-limit-24hour-reset": String(Math.floor(Date.now() / 1000) + 60_000) }),
    );
    expect(result?.retryable).toBe(false);
    expect(result?.retryAfterMs).toBeUndefined();
    expect(result?.message).toContain("24-hour cap");
    expect(result?.message).toContain("waiting will not help");
  });

  it("treats the 15-minute burst limit as retryable, with the wait X states", () => {
    const reset = Math.floor(Date.now() / 1000) + 300;
    const result = classifyRateLimit(failure({ "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(reset) }));
    expect(result?.retryable).toBe(true);
    expect(result?.retryAfterMs).toBeGreaterThan(290_000);
    expect(result?.retryAfterMs).toBeLessThanOrEqual(300_000);
  });

  it("honours the app-level daily cap as well as the user one", () => {
    const result = classifyRateLimit(failure({ "x-app-limit-24hour-remaining": "0" }));
    expect(result?.retryable).toBe(false);
  });

  it("stays retryable when the daily cap still has room, even on a 429", () => {
    // Without this, "any 24-hour header present means stop" would strand a run that hit only its burst limit.
    const result = classifyRateLimit(failure({ "x-user-limit-24hour-remaining": "150", "x-rate-limit-reset": "0" }));
    expect(result?.retryable).toBe(true);
  });

  it("ignores anything that is not a 429", () => {
    expect(classifyRateLimit({ ok: false, url: "u", kind: "http-error", status: 500, reason: "x" })).toBeUndefined();
  });

  it("does not sit in backoff against a cap, end to end through the tool", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: "Too Many Requests" }, 429, {
        "x-user-limit-24hour-remaining": "0",
        "x-user-limit-24hour-reset": String(Math.floor(Date.now() / 1000) + 40_000),
      }),
    ) as unknown as typeof fetch;
    const result = (await run("x_get_post", fetchImpl, { id: "1" })) as { ok: false; error: { code: string; retryable: boolean } };
    expect(result.error).toMatchObject({ code: "rate_limited", retryable: false });
    // One attempt, no retry loop.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("reads say what they could see", () => {
  it("reports the search window on every result, not only empty ones", async () => {
    // An empty result means "nothing matched", "your tier cannot see back that far" or "your tier cannot do
    // this", and the API does not distinguish them.
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "1", text: "hi", public_metrics: {} }], meta: {} })) as unknown as typeof fetch;
    const result = (await run("x_search_posts", fetchImpl, { query: "retry budget" })) as {
      data: { searched: string; tier: string; posts: unknown[] };
    };
    expect(result.data.searched).toBe("the last 7 days");
    expect(result.data.tier).toBe("basic");
    expect(result.data.posts).toHaveLength(1);
  });

  it("refuses a search on the free tier locally, saying it is a subscription and not a permission", async () => {
    // X answers 403 with a "client-not-enrolled" message that a model reads as transient and retries.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("x_search_posts", fetchImpl, { query: "x" }, { tier: "free" })) as {
      ok: false;
      error: { code: string; retryable: boolean; message: string };
    };
    expect(result.error).toMatchObject({ code: "capability_unavailable", retryable: false });
    expect(result.error.message).toContain("subscription, not a permission");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says the full archive on pro", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], meta: {} })) as unknown as typeof fetch;
    const result = (await run("x_search_posts", fetchImpl, { query: "x" }, { tier: "pro" })) as { data: { searched: string } };
    expect(result.data.searched).toBe("the full archive");
  });

  it("resolves author ids into handles from the expansion", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "1", text: "hi", author_id: "u1", public_metrics: { like_count: 3 } }],
        includes: { users: [{ id: "u1", username: "ada" }] },
        meta: {},
      }),
    ) as unknown as typeof fetch;
    const result = (await run("x_search_posts", fetchImpl, { query: "x" })) as { data: { posts: { author: string; likes: number }[] } };
    // A bare author id is unreadable; the expansion exists precisely so it need not be.
    expect(result.data.posts[0]).toMatchObject({ author: "@ada", likes: 3 });
  });

  it("reports truncation from the pagination token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], meta: { next_token: "abc" } })) as unknown as typeof fetch;
    const result = (await run("x_search_posts", fetchImpl, { query: "x" })) as { data: { truncated: boolean } };
    expect(result.data.truncated).toBe(true);
  });

  it("refuses x_get_user without exactly one of handle or id", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const input of [{}, { handle: "a", id: "1" }]) {
      const result = (await run("x_get_user", fetchImpl, input)) as { ok: false; error: { message: string } };
      expect(result.error.message).toContain("exactly one");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strips a leading @ from a handle rather than sending it", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return jsonResponse({ data: { id: "1", username: "ada", public_metrics: {} } });
    }) as unknown as typeof fetch;
    await run("x_get_user", fetchImpl, { handle: "@ada" });
    expect(urls[0]).toContain("/by/username/ada");
    expect(urls[0]).not.toContain("%40");
  });
});

describe("publishing is checked before it is public", () => {
  it("counts a post in code points, not UTF-16 units", () => {
    /**
     * `String.length` counts UTF-16 units, so 200 emoji measure 400 and would be refused wrongly — while X
     * counts what a person would call characters. Wrong in either direction produces a confusing failure about
     * a post that looks the right length.
     */
    expect(postLength("hello")).toBe(5);
    expect(postLength("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
  });

  it("refuses an over-long post locally and says how long it is", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("x_post", fetchImpl, { text: "a".repeat(MAX_POST_LENGTH + 1) })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain(`at most ${MAX_POST_LENGTH} characters and this one is 281`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts 280 emoji, which naive length counting would reject", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "9", text: "x" } })) as unknown as typeof fetch;
    const result = (await run("x_post", fetchImpl, { text: "😀".repeat(MAX_POST_LENGTH) })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("refuses an empty post", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("x_post", fetchImpl, { text: "" })) as { ok: false; error: { message: string } };
    expect(result.error.message).toContain("no text");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a reply as a reply rather than a new post", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return jsonResponse({ data: { id: "9", text: "x" } });
    }) as unknown as typeof fetch;
    await run("x_post", fetchImpl, { text: "hi", replyToId: "123" });
    expect(body.reply).toEqual({ in_reply_to_tweet_id: "123" });
  });

  it("treats a 200 saying deleted:false as a failure", async () => {
    // X answers 200 with `{"data":{"deleted":false}}` when it declined — the same envelope lesson as Slack's
    // `ok: false`, and a status check misses it entirely.
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { deleted: false } })) as unknown as typeof fetch;
    const result = (await run("x_delete_post", fetchImpl, { id: "1" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("was not deleted");
  });

  it("reports a successful delete", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { deleted: true } })) as unknown as typeof fetch;
    const result = (await run("x_delete_post", fetchImpl, { id: "1" })) as { ok: true; data: { deleted: boolean } };
    expect(result.data.deleted).toBe(true);
  });
});

describe("failures and credentials", () => {
  it("says a 403 may be a tier rather than a scope, because X does not distinguish them", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "not permitted" }, 403)) as unknown as typeof fetch;
    const result = (await run("x_get_post", fetchImpl, { id: "1" })) as { ok: false; error: { code: string; message: string } };
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.message).toContain("access tier");
  });

  it("reads no environment variable anywhere in the package source", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = readFileSync(`${here}../index.ts`, "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });

  it("resolves the credential on every call, not once at construction", async () => {
    let resolved = 0;
    const provider = createXToolkit({
      credentialRef: "x",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "bearer", token: `t${resolved}` };
        },
      },
      fetchImpl: vi.fn(async () => jsonResponse({ data: { id: "1" } })) as unknown as typeof fetch,
    });
    const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === "x_get_post");
    await tool?.execute({ context, input: { id: "1" } });
    await tool?.execute({ context, input: { id: "2" } });
    expect(resolved).toBe(2);
  });
});
