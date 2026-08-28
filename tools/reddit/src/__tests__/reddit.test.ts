/**
 * Reddit — REQ-053 (#227), task #230.
 *
 * Two ACs carry the risk, and both are about Reddit misleading you:
 *
 * - AC-4: a missing `User-Agent` earns a `429` that looks exactly like a rate limit and is not.
 * - AC-5: a comment tree is unbounded, nested, and full of `more` placeholders that hide whole branches.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { asId, type ExecutionContext } from "@retinue/agentkit";

import {
  createRedditToolkit,
  flattenComments,
  MAX_COMMENT_DEPTH,
  REDDIT_AUTH,
  REDDIT_TOOL_NAMES,
  userAgentString,
} from "../index.js";

const context: ExecutionContext = {
  tenantId: asId("t1"),
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  conversationId: asId("c1"),
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const AGENT = { appId: "retinue-example", version: "1.0.0", contact: "acme_bot" };

const toolkit = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createRedditToolkit({
    credentialRef: "reddit",
    resolver: createStaticCredentialResolver({ reddit: "bearer-test" }),
    userAgent: AGENT,
    fetchImpl,
    ...extra,
  });

const run = async (name: string, fetchImpl: typeof fetch, input: unknown) => {
  const tools = await toolkit(fetchImpl).listTools(context);
  const tool = tools.find((t) => t.descriptor.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute({ context, input });
};

/** Reddit's nested Listing shape, which is what `flattenComments` has to survive. */
const comment = (author: string, body: string, replies?: unknown) => ({
  kind: "t1",
  data: { author, body, score: 1, created_utc: 1, ...(replies === undefined ? {} : { replies }) },
});
const listing = (...children: unknown[]) => ({ kind: "Listing", data: { children } });

describe("the toolkit contract — AC-1, AC-2", () => {
  it("exports its names and declares exactly those tools", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    expect(tools.map((t) => t.descriptor.name)).toEqual([...REDDIT_TOOL_NAMES]);
  });

  it("classifies both writes as publishing, per #228", async () => {
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const byName = new Map(tools.map((t) => [t.descriptor.name, t.descriptor]));
    for (const name of ["reddit_submit_post", "reddit_comment"]) {
      expect(byName.get(name), name).toMatchObject({
        category: "publishing",
        effect: "external-write",
        approvalPolicy: "always",
        requiresIdempotencyKey: true,
      });
    }
  });

  it("declares OAuth only, and leaves refresh to the resolver — AC-6", () => {
    /**
     * A module-level token cache here would be shared by every tenant in the process, so one tenant's token
     * would serve another's request — and the failure would be invisible until an audit asked whose account
     * posted. The seam is the resolver, which is per call.
     */
    expect(REDDIT_AUTH).toEqual({ modes: ["oauth2"], schemes: ["bearer"] });
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    // No cache of any kind at module scope.
    expect(source).not.toMatch(/let\s+\w*[Tt]oken/);
    expect(source).not.toMatch(/new Map\(\)/);
  });
});

describe("the User-Agent is required, not defaulted — AC-4", () => {
  it("sends Reddit's requested format on every request", async () => {
    /**
     * Reddit answers a missing or generic User-Agent with a 429 that looks exactly like a rate limit — so a
     * client backs off, retries, is refused again, and concludes the API is overloaded.
     */
    let seen: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Headers }) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ data: { children: [] } });
    }) as unknown as typeof fetch;
    await run("reddit_search", fetchImpl, { query: "x" });
    expect(seen?.get("user-agent")).toBe("retinue:retinue-example:1.0.0 (by /u/acme_bot)");
  });

  it("refuses to build without one, at construction rather than at first use", () => {
    // A shared default would make every deployment look like one client to Reddit's limiter, which is exactly
    // what the requirement exists to prevent.
    for (const bad of [{ appId: "", version: "1", contact: "a" }, { appId: "a", version: "", contact: "a" }, { appId: "a", version: "1", contact: "  " }]) {
      expect(() => createRedditToolkit({
        credentialRef: "reddit",
        resolver: createStaticCredentialResolver({ reddit: "t" }),
        userAgent: bad as never,
      })).toThrow(/User-Agent/);
    }
  });

  it("accepts a contact that is already a /u/ or an email", () => {
    expect(userAgentString({ appId: "a", version: "1", contact: "/u/ada" })).toBe("retinue:a:1 (by /u/ada)");
    expect(userAgentString({ appId: "a", version: "1", contact: "ada@x.test" })).toBe("retinue:a:1 (by ada@x.test)");
  });

  it("says in a 429 that the User-Agent is not the cause, since it is set", async () => {
    // The message exists so whoever is debugging does not spend an hour on the wrong hypothesis.
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "slow down" }, 429)) as unknown as typeof fetch;
    const result = (await run("reddit_search", fetchImpl, { query: "x" })) as { ok: false; error: { code: string; message: string } };
    expect(result.error.code).toBe("rate_limited");
    expect(result.error.message).toContain("retinue:retinue-example");
  });
});

describe("comment trees are bounded and say so — AC-5", () => {
  it("flattens a nested tree", () => {
    const tree = listing(comment("a", "top", listing(comment("b", "reply"))));
    const result = flattenComments(tree);
    expect(result.comments[0]?.author).toBe("a");
    expect(result.comments[0]?.replies[0]?.body).toBe("reply");
    expect(result.truncated).toBe(false);
  });

  it("stops at the depth bound and reports it", () => {
    const deep = listing(comment("a", "1", listing(comment("b", "2", listing(comment("c", "3"))))));
    const result = flattenComments(deep, { depth: 1 });
    expect(result.stoppedBy).toBe("depth");
    expect(result.truncated).toBe(true);
    expect(result.comments[0]?.replies[0]?.replies).toEqual([]);
  });

  it("stops at the count bound and reports it", () => {
    const many = listing(...Array.from({ length: 50 }, (_, i) => comment("a", String(i))));
    const result = flattenComments(many, { count: 10 });
    expect(result.stoppedBy).toBe("count");
    expect(result.read).toBe(10);
  });

  it("records a `more` placeholder as truncation rather than ignoring it", () => {
    /**
     * The subtle one. A `more` child means Reddit withheld a whole branch, and a walker that skips it silently
     * returns a plausible tree that is missing the busiest sub-thread — with nothing to say so.
     */
    const withMore = listing(comment("a", "top"), { kind: "more", data: { count: 240 } });
    const result = flattenComments(withMore);
    expect(result.stoppedBy).toBe("more");
    expect(result.truncated).toBe(true);
    expect(result.comments).toHaveLength(1);
  });

  it("does not claim truncation for a thread that fitted", () => {
    // Without this, a walker hardcoded to `truncated: true` would pass every test above.
    const result = flattenComments(listing(comment("a", "only")));
    expect(result.truncated).toBe(false);
    expect(result.stoppedBy).toBeNull();
  });

  it("survives the shapes Reddit actually sends, including empty replies", () => {
    // `replies` is `""` — not `null`, not absent — when a comment has none. Treating it as an object throws.
    const result = flattenComments(listing({ kind: "t1", data: { author: "a", body: "b", replies: "" } }));
    expect(result.comments).toHaveLength(1);
    for (const input of [undefined, null, {}, [], "text", { data: {} }]) {
      expect(() => flattenComments(input)).not.toThrow();
    }
  });

  it("names a deleted author rather than reporting nothing", () => {
    const result = flattenComments(listing({ kind: "t1", data: { body: "x" } }));
    expect(result.comments[0]?.author).toBe("[deleted]");
  });

  it("surfaces truncation through the tool, with the limit that stopped it", async () => {
    const deep = listing(comment("a", "1", listing(comment("b", "2", listing(comment("c", "3"))))));
    const fetchImpl = vi.fn(async () =>
      jsonResponse([listing({ kind: "t3", data: { title: "T", author: "a", is_self: true, selftext: "body" } }), deep]),
    ) as unknown as typeof fetch;
    const result = (await run("reddit_get_post", fetchImpl, { id: "abc", maxDepth: 1 })) as {
      data: { truncated: boolean; truncatedBy: string; post: { title: string } };
    };
    expect(result.data.post.title).toBe("T");
    expect(result.data.truncated).toBe(true);
    expect(result.data.truncatedBy).toBe("depth");
  });

  it("uses a sensible default depth", () => {
    expect(MAX_COMMENT_DEPTH).toBe(4);
  });
});

describe("writes name what Reddit will not tell you in advance", () => {
  it("says in the description that subreddit rules are not checked", async () => {
    /**
     * This is the honest limit AC-7 asks the docs to state, and it belongs in the tool's own description too —
     * the model reads that, not the website. Rules, karma gates, account age and flair are invisible to the
     * API, so a submission that breaks one is accepted and removed minutes later.
     */
    const tools = await toolkit(vi.fn() as unknown as typeof fetch).listTools(context);
    const description = tools.find((t) => t.descriptor.name === "reddit_submit_post")?.descriptor.description ?? "";
    expect(description).toContain("not exposed by the API");
    expect(description).toContain("removed by a moderator");
  });

  it("refuses a submission that is neither a link nor a self post", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const input of [{ subreddit: "r", title: "t" }, { subreddit: "r", title: "t", text: "a", url: "b" }]) {
      const result = (await run("reddit_submit_post", fetchImpl, input)) as { ok: false; error: { message: string } };
      expect(result.error.message).toContain("exactly one");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads Reddit's 200-with-errors envelope as a failure", async () => {
    // Reddit answers 200 with its errors inside `json.errors` — the same lesson as Slack's `ok: false`.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ json: { errors: [["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there"]] } }),
    ) as unknown as typeof fetch;
    const result = (await run("reddit_submit_post", fetchImpl, { subreddit: "r", title: "t", text: "b" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("SUBREDDIT_NOTALLOWED");
    expect(result.error.message).toContain("subreddit rule");
  });

  it("refuses a bare id for a comment parent, since t1_ and t3_ are different objects", async () => {
    // A bare id would comment on the wrong thing, and Reddit accepts whichever the prefix names.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("reddit_comment", fetchImpl, { parentId: "abc123", text: "hi" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("t3_");
    expect(result.error.message).toContain("t1_");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a well-formed fullname", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ json: { errors: [], data: { things: [{ data: { name: "t1_new" } }] } } }),
    ) as unknown as typeof fetch;
    const result = (await run("reddit_comment", fetchImpl, { parentId: "t3_abc", text: "hi" })) as { ok: true; data: { id: string } };
    expect(result.data.id).toBe("t1_new");
  });

  it("refuses an over-long title locally, because Reddit's error names no field", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = (await run("reddit_submit_post", fetchImpl, { subreddit: "r", title: "a".repeat(301), text: "b" })) as {
      ok: false;
      error: { message: string };
    };
    expect(result.error.message).toContain("1 and 300 characters");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a 403 as a subreddit restriction the API does not expose", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403)) as unknown as typeof fetch;
    const result = (await run("reddit_list_subreddit", fetchImpl, { subreddit: "private" })) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(result.error.code).toBe("unauthorized");
    expect(result.error.message).toContain("karma or account age");
  });

  it("returns a user's karma, which is what subreddit gates are set against", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { name: "ada", link_karma: 10, comment_karma: 20 } })) as unknown as typeof fetch;
    const result = (await run("reddit_get_user", fetchImpl, { username: "/u/ada" })) as {
      data: { username: string; postKarma: number };
    };
    expect(result.data).toMatchObject({ username: "ada", postKarma: 10 });
  });
});

describe("credentials come only from the resolver — AC-6", () => {
  it("reads no environment variable anywhere in the package source", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });

  it("resolves the credential on every call, so a refresh cannot leak across tenants", async () => {
    let resolved = 0;
    const provider = createRedditToolkit({
      credentialRef: "reddit",
      resolver: {
        async resolve() {
          resolved += 1;
          return { scheme: "bearer", token: `t${resolved}` };
        },
      },
      userAgent: AGENT,
      fetchImpl: vi.fn(async () => jsonResponse({ data: { children: [] } })) as unknown as typeof fetch,
    });
    const tool = (await provider.listTools(context)).find((t) => t.descriptor.name === "reddit_search");
    await tool?.execute({ context, input: { query: "a" } });
    await tool?.execute({ context, input: { query: "b" } });
    expect(resolved).toBe(2);
  });
});
