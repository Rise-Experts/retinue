/**
 * One service factory, and the scan that keeps it that way.
 *
 * `engine.ts` (the worker's composition — every conversation) called `createShareFlowServices` with
 * six fields while `module.ts` (the API host — `POST /api/tools/:name`) passed nine. The three
 * missing were `readMediaBytes`, `storeMedia` and `mermaidBundlePath`, so inside a conversation
 * `capture_website`, `render_diagram` and `generate_pdf` refused with "no media store is configured",
 * and `read_pdf`/`describe_image` refused the asset source — while every direct test of those tools
 * passed, because a direct call goes through the *host's* composition.
 *
 * A behavioural test cannot catch that: each composition is correct in isolation, and the defect is
 * that they differ. So this scans the source, the way `layout.test.ts` scans for a stale `requires`
 * list — because the offence is which factory a call site reaches for.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shareFlowServicesFrom } from "../services.js";
import { createInternalWebApp } from "../internal.js";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");

describe("the shared service factory", () => {
  it("is the only caller of createShareFlowServices", () => {
    /**
     * The guard. Any other call site is a second argument list, and a second argument list is how the
     * worker ended up without a media store while the host had one.
     */
    const callers = readdirSync(appDir)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => {
        const text = readFileSync(resolve(appDir, name), "utf8");
        // Comments stripped: this file and `services.ts` both *describe* the call in prose.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        return code.includes("createShareFlowServices(");
      });

    expect(callers).toEqual(["services.ts"]);
  });

  it("wires the media store when the deployment can reach the app", () => {
    /**
     * The three fields whose absence was the bug. Asserted through the *services* the factory returns
     * rather than by inspecting its arguments, because what matters is that a tool can store a file.
     */
    const services = shareFlowServicesFrom({
      sql: { query: async () => [] } as never,
      transaction: (async (fn: never) => fn) as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: {
        // `connectionSetupFrom` requires this one — an OAuth redirect has to know its own origin.
        PUBLIC_APP_URL: "https://chorus.test",
        WEB_INTERNAL_URL: "http://web:3000",
        SHARED_API_SECRET: "secret",
        RETINUE_MERMAID_BUNDLE: "/app/vendor/mermaid.min.js",
      },
    });

    // A media service that has a store does not refuse; one without it throws `provider_unavailable`.
    expect(services.media).toBeDefined();
    expect(services.render).toBeDefined();
  });

  it("still composes when the app is unreachable, so a checkout runs with narrower capabilities", () => {
    /**
     * Absent `WEB_INTERNAL_URL`, the media hop is genuinely unavailable and the tools say so by name.
     * That is a narrower deployment rather than a broken one — and it must not throw at construction,
     * or a local checkout could not start at all.
     */
    expect(() =>
      shareFlowServicesFrom({
        sql: { query: async () => [] } as never,
        transaction: (async (fn: never) => fn) as never,
        search: undefined as never,
        fetchPage: undefined as never,
        generate: (async () => ({ text: "" })) as never,
        // No `WEB_INTERNAL_URL`: the media hop is genuinely unavailable and the tools say so by name.
        env: { PUBLIC_APP_URL: "https://chorus.test" },
      }),
    ).not.toThrow();
  });
});

/**
 * Replying, which had no send at all.
 *
 * `EngagementService.reply` takes an optional `send` and refuses without one — *"This deployment cannot
 * send replies: no platform connector is wired."* That is exactly what a user got when they asked the
 * assistant to answer a comment: `find_tools`, `learn_tools`, `list_comments`, two `reply_to_comment`
 * attempts, and a refusal. The web app has had the connector and the internal endpoint all along; the
 * two were never connected.
 *
 * Asserted by **calling the service** and reading the HTTP request, not by checking a field is defined:
 * a wire that exists and posts the wrong action is the same outage with better types. This is the shape
 * of test that was missing when the worker's composition silently dropped `storeMedia`.
 */
describe("the reply send", () => {
  const context = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "user-1", roleIds: ["editor"] } as never;
  const COMMENT_ID = "22222222-2222-4222-8222-222222222222";

  /** A comment row for the read, and a claimed id for the update. */
  const sqlWithComment = () =>
    ({
      async query(text: string) {
        if (/^\s*update/iu.test(text)) return [{ id: COMMENT_ID }];
        return [
          {
            id: COMMENT_ID,
            workspace_id: String((context as unknown as { tenantId: string }).tenantId),
            platform: "instagram",
            external_id: "ig-comment-1",
            author_name: "Sofia B",
            author_handle: "@sofiab",
            post_ref: "p-1",
            content: "Do you ship to Austria?",
            reply: null,
            reply_status: "needs_review",
            replied_at: null,
            created_at: new Date("2026-09-09T06:32:03Z"),
          },
        ];
      },
    }) as never;

  const services = (fetchImpl: typeof fetch) =>
    shareFlowServicesFrom({
      sql: sqlWithComment(),
      // Runs the callback against the same fake, which is what the real runner does with a connection.
      transaction: { transaction: async (fn: (tx: unknown) => unknown) => fn(sqlWithComment()) } as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: {
        PUBLIC_APP_URL: "https://chorus.test",
        WEB_INTERNAL_URL: "http://web:3000",
        SHARED_API_SECRET: "secret",
      },
      fetchImpl,
    });

  it("sends through the app's internal endpoint when the assistant replies", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ commentId: COMMENT_ID, platform: "instagram", sent: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await services(fetchImpl).engagement.reply(context, {
      commentId: COMMENT_ID as never,
      text: "On its way — thanks for asking.",
      // Required, and required for a reason: it is what makes a retried reply not a second public one.
      idempotencyKey: "reply-1",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://web:3000/api/internal/post-ops");
    /**
     * `send-reply`, not `reply`. The runtime marks the row `sent` *before* sending — so a crash cannot
     * produce a second public reply — and the app's `reply` action refuses exactly that state as
     * "already been replied to". Posting the wrong action is a 409 on every single reply.
     */
    expect(call.body["action"]).toBe("send-reply");
    expect(call.body["commentId"]).toBe(COMMENT_ID);
    expect(call.body["text"]).toBe("On its way — thanks for asking.");
    // The tenant comes from the execution context, never from the model's input.
    expect(call.body["workspaceId"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(call.headers["x-internal-secret"]).toBe("secret");
  });

  it("reports the platform's own refusal rather than a status code", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "Replying is not supported on linkedin yet — reply in the linkedin app instead." }),
        { status: 400 },
      )) as unknown as typeof fetch;

    await expect(
      services(fetchImpl).engagement.reply(context, { commentId: COMMENT_ID as never, text: "hello", idempotencyKey: "reply-1" }),
    ).rejects.toThrow(/did not confirm it|not supported on linkedin/);
  });

  it("refuses by name when the deployment cannot reach the app", async () => {
    /**
     * Narrower capabilities over a broken one. Without `WEB_INTERNAL_URL` there is no send, and `reply`
     * says so in a sentence a person can act on — "reply in the platform's own app instead" — rather
     * than claiming a comment and failing at the last step.
     */
    const offline = shareFlowServicesFrom({
      sql: sqlWithComment(),
      transaction: { transaction: async (fn: (tx: unknown) => unknown) => fn(sqlWithComment()) } as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: { PUBLIC_APP_URL: "https://chorus.test" },
    });

    await expect(
      offline.engagement.reply(context, { commentId: COMMENT_ID as never, text: "hello", idempotencyKey: "reply-1" }),
    ).rejects.toThrow(/no platform connector is wired/);
  });
});


/**
 * "Publish now" that means now — #403.
 *
 * `PublishingDeps.enqueue` was written with two call sites and a comment saying a deployment that wants
 * ShareFlow's latency back "supplies `enqueue`". Nothing supplied it. So every assistant publish wrote a
 * PENDING row and waited for the reconciliation sweep — five minutes of grace plus a cron tick — while the
 * same action taken in the app went out in seconds, and both reported success immediately.
 *
 * Two tests, because the omission had two halves: the hop has to say the right thing, and the factory has to
 * use it at all.
 */
describe("the publish enqueue", () => {
  const context = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "user-1", roleIds: ["editor"] } as never;

  it("asks the app to queue the row it already wrote", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ enqueued: true, jobId: "job-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    await createInternalWebApp({ baseUrl: "http://web:3000", secret: "secret", fetchImpl }).enqueuePublish({
      context,
      scheduledItemId: "33333333-3333-4333-8333-333333333333",
      delayMs: 0,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://web:3000/api/internal/enqueue-publish");
    /**
     * Deliberately not `/api/internal/publish`, which takes a `postId` and does the whole fan-out. The row
     * exists by the time this is called, and `scheduled_items` has no unique constraint on
     * `(post_id, social_account_id)` — so repeating the fan-out would publish the post twice.
     */
    expect(call.body["scheduledItemId"]).toBe("33333333-3333-4333-8333-333333333333");
    expect(call.body["delayMs"]).toBe(0);
    // The tenant comes from the execution context; the endpoint uses it to check the item is really theirs.
    expect(call.body["workspaceId"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(call.headers["x-internal-secret"]).toBe("secret");
  });

  /**
   * The generalised guard, and the one that would have caught this.
   *
   * A capability reachable over the internal hop is worth nothing until the factory hands it to a service.
   * `enqueuePublish` was not the first: `storeMedia` was silently dropped from the worker's composition and
   * every direct test of the media tools still passed. So rather than asserting this one field, assert that
   * **every** method `InternalWebApp` offers is named in the composition — a new one that nobody wires fails
   * here instead of failing quietly in production.
   */
  /**
   * Every optional capability the factory accepts is either supplied or listed here — #320.
   *
   * The test above scans one level too low. It asks whether every method the *hop* offers is passed to
   * a service, so a capability the hop never offered is invisible to it: `MediaDeps.convert` was
   * declared, referenced twelve times by the adapter, backed by a shipped `convert-media` route, and
   * supplied by nobody. `convert_media` answered *"this deployment cannot convert media"* on a
   * container where `WEB_INTERNAL_URL` was set, and the scan above was green the whole time.
   *
   * It was not alone. `scheduleWrite` had the same shape — #425's route shipped, the wire did not, and
   * both schedule writes refused on a deployment that could reach the app. Neither was caught by a
   * test, because a declared-and-unsupplied option is a *hole*, and the suite only had assertions
   * about things that exist.
   *
   * So the hole is the assertion now. A new optional capability either gets wired or gets named below,
   * with the reason it is not.
   */
  it("supplies every optional capability, or names the ones it deliberately does not", () => {
    /** Not supplied, each for a stated reason. Shrinking this list is the point; growing it needs one. */
    const DELIBERATELY_UNWIRED: Readonly<Record<string, string>> = {
      // Documented default: "Defaults to `media`, the bucket this schema ships."
      mediaBucket: "the adapter's own default is correct for every deployment",
      // No real gaps left. #451 emptied this list: `deletePostFrom`, `checkMediaStorage`,
      // `configuredPlatforms`, `probe` and finally `isSuppressed` all found suppliers in the app,
      // which is where every one of them had to live — they each need something the shareflow
      // package cannot see (this process's env, the signing key, an outbound request, or a table
      // that did not exist until #451 built it).
    };

    const config = readFileSync(resolve(appDir, "..", "adapters", "index.ts"), "utf8");
    const optional = [...config.matchAll(/^\s*readonly ([a-zA-Z]+)\?:/gm)].map((m) => m[1]!);
    // The parse must find something, or every assertion below passes vacuously.
    expect(optional.length).toBeGreaterThan(10);

    const composition = readdirSync(appDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(resolve(appDir, name), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const unwired = optional.filter(
      (key) => !new RegExp(`\\b${key}\\s*:`).test(composition) && !(key in DELIBERATELY_UNWIRED),
    );
    expect(
      unwired,
      "these capabilities are declared, implemented and supplied by nobody — the tool that needs one " +
        "refuses on a deployment that could serve it. Wire it, or name it in DELIBERATELY_UNWIRED",
    ).toEqual([]);

    // And the list cannot rot: a name here that has since been wired, or removed, is itself a failure.
    const stale = Object.keys(DELIBERATELY_UNWIRED).filter((key) => !optional.includes(key));
    expect(stale, "these are named as unwired but are no longer optional capabilities").toEqual([]);
  });

  /**
   * The same hole, **one level deeper** — REQ-013, #265.
   *
   * The assertion above scans `ShareFlowAdapterConfig`'s optional fields. `GeneratorConfig`'s are
   * invisible to it, and that is where the next instance of this bug was hiding: `voiceExamples` was
   * declared on the generator and supplied by nobody, so `generate_content` and `generate_campaign`
   * wrote every caption in the product without ever seeing the workspace's voice corpus — while the
   * column, the toggle, the coverage selector and a context provider all worked, and REQ-013 read as
   * finished.
   *
   * A sabotage proved the gap was real: deleting the `voiceExamples:` line from the composition root
   * left all 255 tests green.
   *
   * The generator is the adapter whose config the composition assembles piece by piece, so it is the
   * one that can have this hole. If another adapter grows optional capabilities, add it here.
   */
  it("supplies every optional capability the generator declares", () => {
    const UNWIRED: Readonly<Record<string, string>> = {};

    const generator = readFileSync(resolve(appDir, "..", "adapters", "model", "generator.ts"), "utf8");
    const start = generator.indexOf("export type GeneratorConfig = {");
    expect(start, "GeneratorConfig not found — this scan has drifted from the file").toBeGreaterThan(-1);
    const body = generator.slice(start, generator.indexOf("\n};", start));
    const optional = [...body.matchAll(/^\s*readonly ([a-zA-Z]+)\?:/gm)].map((m) => m[1]!);
    // The parse must find something, or every assertion below passes vacuously.
    expect(optional.length, "no optional capabilities parsed out of GeneratorConfig").toBeGreaterThan(0);

    const composition = readFileSync(resolve(appDir, "..", "adapters", "index.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const unwired = optional.filter(
      (key) => !new RegExp(`\\b${key}\\s*:`).test(composition) && !(key in UNWIRED),
    );
    expect(
      unwired,
      "the generator declares these and the composition supplies none of them, so every caption this " +
        "product writes goes without them. Wire it, or name it in UNWIRED with the reason",
    ).toEqual([]);

    const stale = Object.keys(UNWIRED).filter((key) => !optional.includes(key));
    expect(stale, "named as unwired but no longer an optional capability").toEqual([]);
  });

  it("wires every method the internal hop offers", () => {
    const app = createInternalWebApp({
      baseUrl: "http://web:3000",
      secret: "secret",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    /*
     * The whole composition layer, not just `services.ts`. `signMediaUrl` is consumed by `mediaBytesFrom`
     * in `deployment.ts`, which is handed the client rather than one method — so a scan of the factory
     * alone reports a capability that is wired perfectly well.
     */
    const composition = readdirSync(appDir)
      .filter((name) => name.endsWith(".ts") && name !== "internal.ts")
      .map((name) => readFileSync(resolve(appDir, name), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const unwired = Object.keys(app).filter((method) => !composition.includes(`internal.${method}`));
    expect(unwired, "these internal capabilities exist and nothing passes them to a service").toEqual([]);
  });
});

/**
 * Media generation, which had both halves and no join — #496, found on production running /image.
 *
 * `services.ts` passed `generateMedia` and `getMediaGeneration`; `createShareFlowServices` declared
 * neither and forwarded neither, and because the keys arrive through a spread TypeScript's excess-
 * property check never saw them. `generate_media` answered "no route to the app" on a deployment that
 * had one. Asserted by calling the service and reading the request, as the reply test above does.
 */
describe("media generation", () => {
  const context = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "33333333-3333-4333-8333-333333333333", roleIds: ["editor"] } as never;

  const services = (fetchImpl: typeof fetch) =>
    shareFlowServicesFrom({
      sql: { query: async () => [] } as never,
      transaction: (async (fn: never) => fn) as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: { PUBLIC_APP_URL: "https://chorus.test", WEB_INTERNAL_URL: "http://web:3000", SHARED_API_SECRET: "secret" },
      fetchImpl,
    });

  it("starts a job through the app's generate-media route", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ jobId: "44444444-4444-4444-8444-444444444444", provider: "higgsfield" }), { status: 200 });
    }) as unknown as typeof fetch;

    const started = await services(fetchImpl).media.generate(context, { kind: "image", prompt: "pumpkin soup", aspectRatio: "4:5" });

    expect(started).toMatchObject({ jobId: "44444444-4444-4444-8444-444444444444", provider: "higgsfield" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://web:3000/api/internal/generate-media");
    expect(seen[0]!.body).toMatchObject({ action: "start", kind: "image", prompt: "pumpkin soup" });
  });

  it("names the conversation, so the app can send the project avatar's reference photos (#524)", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ jobId: "44444444-4444-4444-8444-444444444444" }), { status: 200 });
    }) as unknown as typeof fetch;
    await services(fetchImpl).media.generate({ ...(context as object), conversationId: "conv-9" } as never, { kind: "image", prompt: "Nova" });
    expect(seen[0]).toMatchObject({ conversationId: "conv-9" });
  });

  it("passes the job's reference note back to check_media_job (#524)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jobId: "j1", kind: "image", status: "succeeded", assets: [], references: { sent: 0, skipped: "z_image takes no reference photos" } }), { status: 200 })) as unknown as typeof fetch;
    await expect(services(fetchImpl).media.getGeneration(context, { jobId: "44444444-4444-4444-8444-444444444444" })).resolves.toMatchObject({
      references: { sent: 0, skipped: "z_image takes no reference photos" },
    });
  });

  it("reads a job through the same route", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jobId: "j1", kind: "image", status: "succeeded", assets: [{ id: "a1", mime: "image/png" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(services(fetchImpl).media.getGeneration(context, { jobId: "44444444-4444-4444-8444-444444444444" })).resolves.toMatchObject({
      state: "succeeded",
      assets: [{ id: "a1", mimeType: "image/png" }],
    });
  });
});

/**
 * The guard for the whole family: every dependency `services.ts` hands the factory must be one the
 * factory declares. A key it does not declare is dropped silently — that is how `generateMedia` was lost.
 */
describe("every dependency services.ts passes is declared", () => {
  it("names no key the adapter config does not have", () => {
    const services = readFileSync(resolve(appDir, "services.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const config = readFileSync(resolve(appDir, "../adapters/index.ts"), "utf8");
    const declared = new Set([...config.matchAll(/^\s+readonly (\w+)\??:/gm)].map((m) => m[1]!));
    const passed = [...services.matchAll(/^\s{6,}(\w+): internal\.\w+/gm)].map((m) => m[1]!);
    expect(passed.length).toBeGreaterThan(5); // the scan found the block at all
    expect(passed.filter((key) => !declared.has(key))).toEqual([]);
  });
});

/** Post templates reach the app — #525. Asserted end to end, the way media generation is above. */
describe("template rendering", () => {
  const context = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    principalId: "33333333-3333-4333-8333-333333333333",
    conversationId: "conv-1",
    roleIds: ["editor"],
  } as never;

  it("renders through the app's project-templates route, in the conversation's project", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ projectId: "p1", assets: [{ id: "a1", label: "Quote card — Hi" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const services = shareFlowServicesFrom({
      sql: { query: async (text: string) => (text.includes("from public.project_conversations") ? [{ id: "p1", name: "AI", instructions: "", defaults: {} }] : []) } as never,
      transaction: (async (fn: never) => fn) as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: { PUBLIC_APP_URL: "https://chorus.test", WEB_INTERNAL_URL: "http://web:3000", SHARED_API_SECRET: "secret" },
      fetchImpl,
    });

    await expect(services.projects.renderTemplate(context, { template: "quote", text: "Hi" })).resolves.toEqual({ assets: [{ id: "a1", label: "Quote card — Hi" }] });
    expect(seen[0]!.url).toBe("http://web:3000/api/internal/project-templates");
    expect(seen[0]!.body).toMatchObject({ conversationId: "conv-1", template: "quote", text: "Hi", userId: "33333333-3333-4333-8333-333333333333" });
  });
});

describe("stock media (#615)", () => {
  const compose = (env: Record<string, string>, fetchImpl?: typeof fetch) =>
    shareFlowServicesFrom({
      sql: { query: async () => [] } as never,
      transaction: (async (fn: never) => fn) as never,
      search: undefined as never,
      fetchPage: undefined as never,
      generate: (async () => ({ text: "" })) as never,
      env: { PUBLIC_APP_URL: "https://chorus.test", ...env },
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  const context = { tenantId: "t1", principalId: "p1" } as never;

  it("refuses by name without PEXELS_API_KEY, and with a blank one", async () => {
    for (const env of [{}, { PEXELS_API_KEY: "   " }] as Record<string, string>[]) {
      await expect(compose(env).research.searchStockMedia!(context, { query: "coffee", kind: "photo", count: 3 })).rejects.toThrow(
        "Stock media is not enabled on this deployment — set PEXELS_API_KEY.",
      );
    }
  });

  it("sends the configured key only in the Authorization header", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ total_results: 0, photos: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await compose({ PEXELS_API_KEY: "test-key" }, fetchImpl).research.searchStockMedia!(context, { query: "coffee", kind: "photo", count: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.startsWith("https://api.pexels.com/v1/search?")).toBe(true);
    expect(seen[0]!.url).not.toContain("test-key");
    expect(seen[0]!.headers.authorization).toBe("test-key");
  });
});
