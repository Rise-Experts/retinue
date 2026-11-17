/**
 * The worker's half of the app module — retinue REQ-041 (#190).
 *
 * Every assertion here corresponds to something that failed when a real turn was driven through a real
 * worker against a real database. That sequence is the interesting part, because each failure was
 * instant, deterministic, and invisible to the build:
 *
 *   1. `dist/app/module.js must default-export an `engine` for the worker command`
 *   2. `A TransactionRunner is required` — the worker supplies none, and `requireRunner` refused
 *   3. `deps.buildContext is not a function` — the contract has a fourth member
 *   4. `engine.run is not a function` — the worker does not await the factory
 *   5. `config.authorization.filterTools is not a function` — a cast hid two missing methods
 *
 * Five contract violations, none of which a typecheck could see, because four of them were behind a
 * cast and the fifth was a missing property on an object literal the platform types as `never`.
 */
import { describe, expect, it, vi } from "vitest";

import { SOCIAL_ASSISTANT_LIMITS, SOCIAL_ASSISTANT_VERSION, shareFlowManifest } from "../compose.js";
import { PLACEHOLDER_AUTHORIZATION, createAuthenticator, runnerFor } from "../deployment.js";
import { buildWorkerContext } from "../worker-context.js";
import app from "../module.js";

describe("the app module's contract", () => {
  it("exports all four members the worker names", () => {
    /**
     * `{ authenticate, deps, engine, buildContext }`. The API host needs the first two and boots
     * happily without the rest, which is what made this worth asserting: a deployment can look
     * completely healthy — /healthz 200, /readyz 200, `sendMessage` accepted — while every run fails
     * the instant a worker claims it.
     */
    for (const member of ["authenticate", "deps", "engine", "buildContext"]) {
      expect(typeof (app as unknown as Record<string, unknown>)[member], member).toMatch(/function/);
    }
  });

  it("returns an engine synchronously, not a promise", () => {
    /**
     * The worker does `engine: app.engine({ config, sql })` and never awaits it. An `async` factory
     * therefore hands it a Promise, and the run dies with `engine.run is not a function` — a message
     * naming a method the caller never wrote, which is a confusing way to learn about a contract.
     */
    const engine = app.engine({ config: { databaseUrl: "postgres://x/y" }, sql: { query: async () => [] } as never });
    expect(engine).not.toBeInstanceOf(Promise);
    expect(typeof (engine as unknown as { run: unknown }).run).toBe("function");
  });

  it("defers construction to the first run, and builds exactly once", async () => {
    /**
     * Construction resolves a model, opens a pool and imports adapters, so it cannot happen inside a
     * synchronous factory. Deferring it to `run` is exact rather than approximate because `AgentEngine`
     * has one method returning an async iterable.
     *
     * **Counted, not assumed.** A first version of this test asserted only that iteration failed
     * without a database, which passed just as happily with `built =` in place of `built ??=` — a
     * rebuild per run, meaning a model handle and a Postgres pool per turn. Under load that is a
     * connection leak that looks like the database refusing connections.
     */
    let constructions = 0;
    vi.doMock("../engine.js", () => ({
      createShareFlowEngine: async () => {
        constructions += 1;
        return {
          run: async function* () {
            yield { type: "probe" };
          },
        };
      },
    }));
    vi.resetModules();
    const { default: fresh } = await import("../module.js");
    const engine = fresh.engine({ config: { databaseUrl: "postgres://x/y" }, sql: { query: async () => [] } as never }) as unknown as {
      run: (i: unknown) => AsyncIterable<unknown>;
    };

    // Nothing is built until the iterator is pulled.
    const first = engine.run({});
    expect(constructions).toBe(0);

    for await (const event of first) void event;
    expect(constructions).toBe(1);

    // A second turn reuses it.
    for await (const event of engine.run({})) void event;
    expect(constructions, "the engine must be built once per process, not once per run").toBe(1);
    vi.doUnmock("../engine.js");
    vi.resetModules();
  });
});

describe("the worker's execution context", () => {
  const run = {
    id: "r1",
    tenantId: "t1",
    conversationId: "c1",
    principalId: "p1",
    roleIds: ["editor"],
  } as never;

  it("takes the identity from the run", () => {
    const context = buildWorkerContext(run);
    expect(String(context.tenantId)).toBe("t1");
    expect(String(context.principalId)).toBe("p1");
    expect([...context.roleIds]).toEqual(["editor"]);
  });

  it("refuses a run with no principal rather than substituting one", () => {
    /**
     * **The security assertion.** The reference application hardcoded a worker principal and a role of
     * `editor`, and it cost them two bugs: every principal's memories and usage were attributed to one
     * invented identity, and a viewer whose run was admitted at the API boundary executed with editor
     * rights, because the worker re-authorises with the context it is handed.
     */
    expect(() => buildWorkerContext({ ...(run as object), principalId: undefined } as never)).toThrow(
      /no principal/,
    );
    expect(() => buildWorkerContext({ ...(run as object), roleIds: undefined } as never)).toThrow(/no principal/);
  });

  it("never widens the roles it was given", () => {
    // A viewer stays a viewer. This is the half that a hardcoded `["editor"]` broke silently.
    expect([...buildWorkerContext({ ...(run as object), roleIds: ["viewer"] } as never).roleIds]).toEqual(["viewer"]);
  });
});

describe("the authorization placeholder", () => {
  const context = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;

  it("implements every method the interface declares", async () => {
    /**
     * It was `{ can }` cast through `as unknown as AuthorizationPolicy` — which typechecked, booted, and
     * failed the first real turn with `config.authorization.filterTools is not a function`. The cast is
     * gone, so the compiler checks this now; the test is here because the *behaviour* of each method
     * still matters, and because a future cast would silently reopen the hole.
     */
    for (const method of ["can", "filterTools", "scope"]) {
      expect(typeof (PLACEHOLDER_AUTHORIZATION as unknown as Record<string, unknown>)[method], method).toBe(
        "function",
      );
    }
  });

  it("passes every tool through rather than returning none", async () => {
    /**
     * The direction matters. An authorization layer returning an empty list looks like a working policy
     * that denies everything, and the symptom is an assistant saying it has no tools while the
     * catalogue shows forty-six.
     */
    const tools = [{ name: "list_post_drafts" }, { name: "publish_post_now" }] as never;
    expect(await PLACEHOLDER_AUTHORIZATION.filterTools(context, tools)).toHaveLength(2);
  });

  it("scopes to the caller's own tenant, with no row filter", async () => {
    const scope = await PLACEHOLDER_AUTHORIZATION.scope(context, "post");
    expect(scope.tenantId).toBe("t1");
    // Absent, not `{}`: an empty filter matches nothing in some query builders and everything in
    // others, so it has no single meaning. Absent has one.
    expect(scope).not.toHaveProperty("filter");
  });
});

describe("the transaction runner", () => {
  it("prefers a runner the caller supplied", async () => {
    const supplied = (async () => undefined) as never;
    expect(await runnerFor({ runner: supplied, config: { databaseUrl: "postgres://x/y" } })).toBe(supplied);
  });

  it("refuses when it has neither a runner nor a URL to open one from", async () => {
    /**
     * `publish-once` rests on `SELECT … FOR UPDATE` held across statements: `scheduled_items` has no
     * unique constraint on `(post_id, social_account_id)`, so a concurrent retry without a real
     * transaction publishes twice. Refusing is right; refusing when a URL *is* available was not, and
     * it stopped the worker from starting at all.
     */
    await expect(runnerFor({ config: {} })).rejects.toThrow(/TransactionRunner is required/);
    await expect(runnerFor({})).rejects.toThrow(/TransactionRunner is required/);
  });

  it("memoises per connection, so one process opens one pool", async () => {
    // `deps` and `engine` are both called in a worker. Two pools per process is a connection leak that
    // only shows up under load.
    const config = { databaseUrl: "postgres://memo-test/db", databaseSchema: "retinue" };
    const first = await runnerFor({ config });
    expect(await runnerFor({ config })).toBe(first);
  });

  it("is a TransactionRunner, not a ConnectionOpener wearing the type", async () => {
    /**
     * **The cast that broke every transaction in the worker.** This line read
     * `createPoolOpener(pool, searchPath) as unknown as TransactionRunner`, and the two are different
     * shapes:
     *
     *     ConnectionOpener    <T>(fn) => Promise<T>            — a function
     *     TransactionRunner   { transaction<T>(fn) }           — an object with a method
     *
     * So every adapter that opened a transaction called `.transaction(...)` on a function and threw
     * `deps.transaction.transaction is not a function`. Seen live, from the app: an approved
     * `reply_to_comment` failed with exactly that after the user had already said yes — the worst
     * moment for it, because the approval is spent and the row is already claimed. Replying,
     * publish-once and the conversation slot all sat on this.
     *
     * `main.ts` builds the scope correctly, which is why the HTTP surface never showed it. The cast is
     * why the compiler never asked. Asserted on the *shape*, because the type is exactly what lied.
     */
    const runner = await runnerFor({ config: { databaseUrl: "postgres://shape-test/db" } });

    expect(typeof runner).toBe("object");
    expect(typeof (runner as { transaction?: unknown }).transaction).toBe("function");
    // And not the other thing: a bare opener is callable, and this must not be.
    expect(typeof (runner as unknown as () => void)).not.toBe("function");
  });

  it("keys the memo on the schema, not only the URL", async () => {
    /**
     * Two runners on the same database and different schemas are not interchangeable: one would hold a
     * lock on a table in the wrong namespace, which is not an error — just a lock on a row that is not
     * there.
     */
    const url = "postgres://memo-test-2/db";
    const a = await runnerFor({ config: { databaseUrl: url, databaseSchema: "retinue" } });
    const b = await runnerFor({ config: { databaseUrl: url, databaseSchema: "public" } });
    expect(a).not.toBe(b);
    /**
     * Ten seconds, and the number is not about the assertion.
     *
     * This takes **7ms** locally and timed out at the 5s default once in CI (run 34851…, commit
     * ebee1cc0), then passed on a rerun of the same commit with no change. What it spends its time on
     * is two dynamic imports inside `runnerFor` — `pg` and `@retinue/agentkit/adapters/postgres` — and
     * on a cold runner with 54 test files competing those can block for far longer than the work here.
     *
     * Raised rather than left flaky, because a red CI that goes green on a rerun teaches people to
     * rerun. If this ever fails at ten seconds, it is not the imports and the cause is worth finding.
     */
  }, 10_000);
});

describe("the manifest", () => {
  it("is one manifest, with the transcribed limits", () => {
    /**
     * `deps` used to compose its own, with a three-sentence prompt and limits disagreeing with the
     * engine's on five of nine fields — so the catalogue the GraphQL surface renders described one
     * assistant while the worker executed another.
     *
     * 18 tool calls comes from `ai_backend`'s generalist, not from here: a cutover that quietly changed
     * a ceiling would change the behaviour the parity comparison is meant to hold still.
     */
    expect(SOCIAL_ASSISTANT_LIMITS.maxToolCalls).toBe(18);
    const manifest = shareFlowManifest();
    expect(manifest.version).toBe(SOCIAL_ASSISTANT_VERSION);
    expect((manifest.limits as unknown as { maxToolCalls: number }).maxToolCalls).toBe(18);
  });

  it("carries the assembled prompt, not a summary of it", () => {
    // The clause about untrusted input is the one that must never be paraphrased away.
    expect(shareFlowManifest().instructions).toContain("untrusted data");
    expect(shareFlowManifest().instructions.length).toBeGreaterThan(1_500);
  });
});

describe("what `deps` exposes for the shadow runner", () => {
  /**
   * `createShadowTurnRunner` needs the manifest and the tool providers, and composing a second app to
   * get them would give the shadow path a different tool surface from the live path. A shadow run that
   * could do things a real one cannot — or vice versa — is not a measurement of anything, which is the
   * same argument the runner's own header makes about its authorization policy.
   *
   * So `deps` returns both, from the composition that also built the registry, and these assert they
   * are that one rather than a copy.
   */
  const depsFor = async () => {
    /**
     * A key, because `deps` refuses without one — the module's own guarantee, doing its job. Setting it
     * here rather than weakening the refusal: a test that needed the refusal relaxed to run would be a
     * test arguing against the thing it is testing around.
     */
    process.env["RETINUE_MODEL_API_KEY"] ??= "sk-test-not-a-real-key";
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";
    const sql = { query: async () => [] } as never;
    return app.deps({
      config: { redisUrl: "redis://127.0.0.1:6379", databaseUrl: "postgres://x/y" },
      sql,
      runner: (async (fn: (s: unknown) => unknown) => fn(sql)) as never,
    });
  };

  it("returns the tool providers, non-empty", async () => {
    const deps = (await depsFor()) as unknown as { providers?: readonly unknown[] };
    expect(deps.providers, "the shadow runner cannot resolve a tool without them").toBeDefined();
    expect((deps.providers ?? []).length).toBeGreaterThan(0);
  });

  it("returns the same manifest the engine executes, prompt included", async () => {
    /**
     * Not a second manifest. Comparing the instructions is the discriminating check: two manifests
     * built from the same factory would be equal, and a second *composition* with its own prompt — which
     * is exactly what `deps` had before `compose.ts` — would not.
     */
    const deps = (await depsFor()) as unknown as { manifest?: { instructions?: string; version?: number } };
    expect(deps.manifest?.version).toBe(SOCIAL_ASSISTANT_VERSION);
    expect(deps.manifest?.instructions).toBe(shareFlowManifest().instructions);
  });

  it("names an authorization policy the shadow runner can register", async () => {
    /**
     * The platform refuses to construct an agent whose manifest names an unregistered policy rather than
     * falling back to a permissive default. The shadow runner is handed
     * `{ [manifest.authorizationPolicyId]: policy }`, so a manifest with no id would silently register
     * nothing under `undefined` and the runner would refuse at the first shadow turn.
     */
    const deps = (await depsFor()) as unknown as { manifest?: { authorizationPolicyId?: string } };
    expect(deps.manifest?.authorizationPolicyId).toBeTruthy();
  });
});

/**
 * What the engine hands `createDefaultEngine` — the fields whose absence is silent.
 *
 * `DefaultEngineDeps` makes almost everything optional, and each optional field has a documented
 * consequence when it is missing. Three were missing here, and the deps object was `as never`-cast, so
 * nothing said so:
 *
 *   systemPrompt   absent → the manifest instructions alone. The prompt promised the workspace's brand
 *                  profile and carried no context at all.
 *   approvals      absent → "no HITL: tool calls go straight to `buildTools`' own `execute`". Nothing
 *                  could raise an approval, so `publish_post_now` could not run by any path.
 *   questions      absent → "a run that parked on a question resumes with no idea it was answered, and
 *                  the model asks the same question again".
 *
 * And `loadManifest` returned `shareFlowManifest()`, which is the five-field *seed* for
 * `socialAssistantManifest` — so the engine ran on a manifest with no id, no toolPolicy, no skillPolicy
 * and no contextProviderIds. The cast is what let that compile; it is gone, and this asserts the shape
 * that replaced it.
 */
describe("the engine's own deps", () => {
  const captured: Record<string, unknown>[] = [];

  const build = async (config: Record<string, unknown>) => {
    captured.length = 0;
    process.env["RETINUE_MODEL_API_KEY"] ??= "sk-test-not-a-real-key";
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";
    vi.resetModules();
    vi.doMock("@retinue/agentkit/runtime", async () => {
      const real = await vi.importActual<Record<string, unknown>>("@retinue/agentkit/runtime");
      return {
        ...real,
        createDefaultEngine: (deps: Record<string, unknown>) => {
          captured.push(deps);
          return { run: async function* () { /* never iterated here */ } };
        },
      };
    });
    const { createShareFlowEngine } = await import("../engine.js");
    return createShareFlowEngine({ config: config as never, sql: { query: async () => [] } as never });
  };

  it("passes a system prompt, an approval loop and a question resumer", async () => {
    await build({ databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" });
    const deps = captured[0] ?? {};

    expect(typeof deps["systemPrompt"], "no systemPrompt means no context in the prompt").toBe("function");
    expect(typeof (deps["approvals"] as { runTool?: unknown })?.runTool, "no approvals means no HITL").toBe("function");
    expect(typeof (deps["questions"] as { answered?: unknown })?.answered).toBe("function");
    expect(typeof deps["buildTools"]).toBe("function");
  });

  it("serves the built manifest, not the seed", async () => {
    await build({ databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" });
    const loadManifest = captured[0]?.["loadManifest"] as (i: { version: number }) => Promise<Record<string, unknown>>;
    const manifest = await loadManifest({ version: SOCIAL_ASSISTANT_VERSION });

    // The four fields the seed does not have. Each one is a policy something downstream reads.
    expect(manifest["id"]).toBeTruthy();
    expect(manifest["toolPolicy"]).toBeDefined();
    expect(manifest["skillPolicy"]).toBeDefined();
    expect(manifest["contextProviderIds"]).toBeDefined();
    // And it is still the prompt the host serves, so the two paths describe one assistant.
    expect(manifest["instructions"]).toBe(shareFlowManifest().instructions);
  });

  it("refuses to build without a queue, naming what the pause would cost", async () => {
    /**
     * An approval parks the run and the decision that resumes it is dispatched as a job. With no queue
     * the pause is permanent — a user approves a publish and watches nothing happen — so this refuses
     * at construction rather than at the first approval.
     */
    await expect(build({ databaseUrl: "postgres://x/y" })).rejects.toThrow(/RETINUE_REDIS_URL is required/);
  });
});


/**
 * A turn runs as the role its caller holds — #406.
 *
 * It did not. `createAuthenticator` read `roleIds: (headers.get("x-roles") ?? "editor")`, the web proxy
 * sent three headers and no `x-roles` among them, and so **every assistant turn ran as an editor
 * whatever the caller actually was**. A VIEWER could ask the assistant to publish and it would —
 * and tightening RLS would not have stopped it, because publishing goes through an internal route on a
 * service-role client that never consults RLS.
 *
 * The same defect was already found and fixed in the worker. `worker-context.ts` states it: *"a
 * hardcoded `roleIds: ["editor"]` gave a viewer editor rights ... the catalogue filtering that makes a
 * viewer read-only held on the API side only"* — and the fix there was to refuse a run with no recorded
 * principal rather than substitute one, because *"guessing is what produced both bugs"*. This is the
 * other half of the same lesson: the friendliest default is the worst one.
 */
describe("the role a turn runs as", () => {
  const authenticate = (headers: Record<string, string>) => {
    const auth = createAuthenticator({ SHARED_API_SECRET: "s3cret" });
    return auth({
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    } as never);
  };

  const base = { "x-api-secret": "s3cret", "x-workspace-id": "t1", "x-user-id": "p1" };

  it("refuses a request that carries no role rather than assuming one", () => {
    // Exactly the request the proxy used to send. It must not resolve to an editor.
    expect(authenticate(base)).toBeNull();
  });

  it("refuses an empty or whitespace-only role header", () => {
    // A header that exists and says nothing is the same absence with more confidence.
    expect(authenticate({ ...base, "x-roles": "" })).toBeNull();
    expect(authenticate({ ...base, "x-roles": "  ,  " })).toBeNull();
  });

  it("carries the role it was given, lower-cased", () => {
    expect(authenticate({ ...base, "x-roles": "viewer" })?.roleIds).toEqual(["viewer"]);
    expect(authenticate({ ...base, "x-roles": "VIEWER" })?.roleIds).toEqual(["viewer"]);
    expect(authenticate({ ...base, "x-roles": "editor, viewer" })?.roleIds).toEqual(["editor", "viewer"]);
  });

  it("still refuses a caller with no tenant or no principal", () => {
    // The pre-existing guarantee, asserted here so adding the role check did not weaken it.
    expect(authenticate({ ...base, "x-workspace-id": "", "x-roles": "editor" })).toBeNull();
    expect(authenticate({ ...base, "x-user-id": "", "x-roles": "editor" })).toBeNull();
  });
});

describe("what a read-only caller may do", () => {
  const viewer = { tenantId: "t1", principalId: "p1", roleIds: ["viewer"] } as never;
  const editor = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;
  const both = { tenantId: "t1", principalId: "p1", roleIds: ["viewer", "editor"] } as never;

  const tools = [
    { name: "list_post_drafts", effect: "read", category: "posts" },
    { name: "get_post_metrics", effect: "read", category: "analytics" },
    { name: "create_post_draft", effect: "internal-write", category: "posts" },
    { name: "publish_post_now", effect: "external-write", category: "publishing" },
    { name: "delete_post", effect: "destructive", category: "publishing" },
    { name: "find_tools", effect: "read", category: "meta" },
  ] as never;

  it("hands a viewer the read tools and withholds every writing one", async () => {
    /**
     * Filtered rather than refused at execution, because the two are different experiences. A model
     * handed `publish_post_now` and then refused has spent a turn and tells the user something went
     * wrong. A model that never sees it says "I can draft this, but publishing needs an editor" —
     * which is the true sentence.
     */
    const allowed = (await PLACEHOLDER_AUTHORIZATION.filterTools(viewer, tools)).map((t) => t.name);

    expect(allowed).toEqual(["list_post_drafts", "get_post_metrics", "find_tools"]);
    expect(allowed).not.toContain("create_post_draft");
    expect(allowed).not.toContain("publish_post_now");
    expect(allowed).not.toContain("delete_post");
  });

  it("discriminates on effect rather than on a list of names", async () => {
    /**
     * The reason this cannot rot. `effect` is derived by `defineTool` once per tool, so a tool
     * relabelled `destructive` leaves the viewer's catalogue automatically. A hand-kept list of "the
     * safe ones" is the artefact that goes on saying yes after somebody changes an effect — the same
     * reasoning the approval gate uses, and the same reason `manifests.test.ts` derives its set.
     */
    const relabelled = [{ name: "list_post_drafts", effect: "destructive", category: "posts" }] as never;
    expect(await PLACEHOLDER_AUTHORIZATION.filterTools(viewer, relabelled)).toEqual([]);
  });

  it("leaves an editor's catalogue untouched", async () => {
    // The direction that matters as much: an authorization layer that quietly narrows everyone is a
    // policy denying everything, and the symptom is an assistant that says it has no tools.
    expect(await PLACEHOLDER_AUTHORIZATION.filterTools(editor, tools)).toHaveLength(6);
  });

  it("treats someone who is a viewer and an editor as an editor", async () => {
    // `every`, not `some`. A person read-only in one capacity and not in another is not read-only.
    expect(await PLACEHOLDER_AUTHORIZATION.filterTools(both, tools)).toHaveLength(6);
  });

  it("treats a role it does not recognise as read-only", async () => {
    /**
     * Fail closed. A role added by a later migration, or a typo in a seed, must not be handed write
     * access by an `else`. This is the shape of the original bug in miniature: `?? "editor"` was one
     * character of optimism about an unknown.
     */
    const unknown = { tenantId: "t1", principalId: "p1", roleIds: ["auditor"] } as never;
    expect(await PLACEHOLDER_AUTHORIZATION.filterTools(unknown, tools)).toHaveLength(3);
  });

  it("denies a write action at `can`, not only in the catalogue", async () => {
    /**
     * The layer behind the filter. A tool name the model already knew, a resumed run, or a
     * `POST /api/tools/:name` from the product all reach `execute` without passing through the
     * catalogue — so the filter is the nice experience and this is the part that holds.
     */
    const write = await PLACEHOLDER_AUTHORIZATION.can(viewer, "publish", { type: "post", id: "p1" } as never);
    expect(write.allow).toBe(false);
    expect(write.reason).toContain("read");

    const read = await PLACEHOLDER_AUTHORIZATION.can(viewer, "read", { type: "post", id: "p1" } as never);
    expect(read.allow).toBe(true);

    expect((await PLACEHOLDER_AUTHORIZATION.can(editor, "publish", { type: "post", id: "p1" } as never)).allow).toBe(true);
  });
});
