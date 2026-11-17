import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The composition actually passes the BYO resolver — #462.
 *
 * ## Why this file exists, measured
 *
 * `workspace-model.test.ts` proves the resolver reads the right row and decrypts the right key.
 * `module.test.ts` proves `structuredGenerateFrom` generates with whatever a resolver hands it. Both
 * suites were green, and then removing `workspaceModel:` from **both** composition sites left
 * **1275 of 1275 tests passing** — a resolver that was correct, tested, and reached by nobody.
 *
 * That is the same defect the feature itself was: a capability built and not connected. Proving the
 * two halves separately is exactly what fails to catch it, because the seam is what neither half owns.
 *
 * ## What it asserts, and why not something cheaper
 *
 * Not "a function was passed" — a composition could pass `async () => undefined` and satisfy that
 * while serving every workspace the platform's key. So the captured resolver is **called**, and the
 * assertion is on the SQL that reaches the composition's *own* `sql` executor: the right table, and
 * the tenant id from the context it was handed.
 *
 * That is the property that matters and it cannot be satisfied by a stub.
 */

const MODEL_ENV = { RETINUE_MODEL_API_KEY: "platform-key", RETINUE_MODEL_PROVIDER: "google" };

type Captured = { workspaceModel?: (context: { tenantId: string }) => Promise<unknown> };

/**
 * Wrap `structuredGenerateFrom` where the composition imports it, keeping the real implementation.
 *
 * `importActual` rather than a stub: a composition that stopped calling it at all would otherwise pass,
 * and the point of this file is to catch exactly that class of omission.
 */
const captureFrom = async (build: (sql: { query: (sql: string, params: readonly unknown[]) => Promise<never[]> }) => Promise<unknown>) => {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  let captured: Captured | undefined;

  vi.resetModules();
  vi.doMock("../deployment.js", async () => {
    const real = await vi.importActual<Record<string, unknown>>("../deployment.js");
    return {
      ...real,
      structuredGenerateFrom: async (env: unknown, deps?: Captured) => {
        captured = deps;
        return (real["structuredGenerateFrom"] as (e: unknown, d?: unknown) => Promise<unknown>)(env, deps);
      },
    };
  });

  await build({
    query: async (sql: string, params: readonly unknown[]) => {
      queries.push({ sql, params });
      return [];
    },
  });

  return { captured, queries };
};

afterEach(() => {
  vi.doUnmock("../deployment.js");
  vi.resetModules();
});

describe("the BYO model reaches the composition, not just the unit test", () => {
  it("the engine builds a generator bound to its own database", async () => {
    for (const [key, value] of Object.entries(MODEL_ENV)) process.env[key] ??= value;
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";

    const { captured, queries } = await captureFrom(async (sql) => {
      const { createShareFlowEngine } = await import("../engine.js");
      return createShareFlowEngine({
        config: { databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" } as never,
        sql: sql as never,
      });
    });

    expect(captured?.workspaceModel, "the engine generates without ever looking up the workspace's provider").toBeTypeOf(
      "function",
    );

    // Called, not merely present: a resolver that answers `undefined` for everyone would pass the
    // check above and serve every workspace the platform's key.
    await captured?.workspaceModel?.({ tenantId: "7f000000-0000-0000-0000-00000000000a" });

    const lookup = queries.find((q) => q.sql.includes("workspace_llm_configs"));
    expect(lookup, "the engine's resolver does not read workspace_llm_configs").toBeDefined();
    expect(lookup?.params, "the resolver is not bound to the calling workspace").toEqual([
      "7f000000-0000-0000-0000-00000000000a",
    ]);
  });

  it("the tool/API surface builds one too — both compositions, because either alone leaves a hole", async () => {
    /**
     * `shareFlowDeps` is what serves `POST /api/tools/:name`, which is how the web app's generate
     * button, repurpose and the campaign planner all reach a model. Wiring only the engine would have
     * fixed the assistant's tools and left every one of those on the platform's key — and the two
     * call sites are far enough apart in the file that fixing one and believing both were done is the
     * obvious mistake.
     */
    for (const [key, value] of Object.entries(MODEL_ENV)) process.env[key] ??= value;
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";

    const { captured, queries } = await captureFrom(async (sql) => {
      const { shareFlowDeps } = await import("../module.js");
      return shareFlowDeps({
        config: { databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" } as never,
        sql: sql as never,
      } as never);
    });

    expect(captured?.workspaceModel, "the tool surface generates without looking up the workspace's provider").toBeTypeOf(
      "function",
    );

    await captured?.workspaceModel?.({ tenantId: "7f000000-0000-0000-0000-00000000000b" });

    const lookup = queries.find((q) => q.sql.includes("workspace_llm_configs"));
    expect(lookup, "the tool surface's resolver does not read workspace_llm_configs").toBeDefined();
    expect(lookup?.params).toEqual(["7f000000-0000-0000-0000-00000000000b"]);
  });
});

/**
 * The engine chooses the turn's model **from the context** — #462, second half.
 *
 * `resolveModel: () => resolved` threw both arguments away, so every workspace was served the
 * deployment's model on every conversational turn. With the platform's Google credits depleted that
 * stopped being an accounting issue and became "the assistant does not answer" for workspaces that had
 * a working provider of their own configured.
 *
 * Asserted by **driving the model the engine handed back** and watching which database the lookup hits
 * and for which tenant. A test that only checked `resolveModel` returned something would pass against
 * the exact line this replaces.
 */
describe("a conversational turn picks up the workspace's model", () => {
  it("looks the calling workspace up when the turn's model is first used", async () => {
    for (const [key, value] of Object.entries(MODEL_ENV)) process.env[key] ??= value;
    process.env["PUBLIC_APP_URL"] ??= "https://test.invalid";

    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const captured: Array<Record<string, unknown>> = [];

    vi.resetModules();
    /**
     * A faithful miniature of `wrapLanguageModel`, so the engine's real lazy proxy can be driven.
     *
     * Not the identity: the engine builds its model through `lazyWrap`, which exposes `doStream` and
     * hides the middleware. Standing in something that actually routes `doStream` through
     * `wrapStream` is what makes this test exercise the same path production does.
     */
    vi.doMock("ai", async () => {
      const real = await vi.importActual<Record<string, unknown>>("ai");
      return {
        ...real,
        wrapLanguageModel: ({ model, middleware }: { model: never; middleware: never }) => ({
          doStream: (params: unknown) =>
            (middleware as { wrapStream: (o: unknown) => unknown }).wrapStream({
              doStream: () => (model as { doStream: (p: unknown) => unknown }).doStream(params),
              params,
            }),
          doGenerate: (params: unknown) =>
            (middleware as { wrapGenerate: (o: unknown) => unknown }).wrapGenerate({
              doGenerate: () => (model as { doGenerate: (p: unknown) => unknown }).doGenerate(params),
              params,
            }),
        }),
      };
    });
    vi.doMock("@retinue/agentkit/runtime", async () => {
      const real = await vi.importActual<Record<string, unknown>>("@retinue/agentkit/runtime");
      return {
        ...real,
        createDefaultEngine: (deps: Record<string, unknown>) => {
          captured.push(deps);
          return { run: async function* () { /* never iterated */ } };
        },
      };
    });

    const { createShareFlowEngine } = await import("../engine.js");
    await createShareFlowEngine({
      config: { databaseUrl: "postgres://x/y", redisUrl: "redis://127.0.0.1:6379" } as never,
      sql: {
        query: async (sql: string, params: readonly unknown[]) => {
          queries.push({ sql, params });
          return [];
        },
      } as never,
    });

    const resolveModel = captured[0]?.["resolveModel"] as
      | ((manifest: unknown, context: unknown) => { model: unknown })
      | undefined;
    expect(resolveModel, "the engine was built without a model resolver").toBeTypeOf("function");

    const tenantId = "7f000000-0000-0000-0000-0000000000cc";
    const turn = resolveModel?.({}, { tenantId });
    expect(turn?.model, "resolveModel returned no model").toBeDefined();

    // Nothing should have been looked up yet: the engine calls resolveModel synchronously, so the
    // lookup has to wait for the first model call. That laziness is the whole mechanism.
    expect(queries.some((q) => q.sql.includes("workspace_llm_configs"))).toBe(false);

    /**
     * Driven the way the engine drives it. The deployment's model underneath is never reached here —
     * it would need a real provider — so a rejection from it is fine; the lookup has already happened
     * by then, which is what this asserts on.
     */
    const model = turn?.model as { doStream: (params: unknown) => Promise<unknown> };
    await model.doStream({ prompt: [] }).catch(() => undefined);

    const lookup = queries.find((q) => q.sql.includes("workspace_llm_configs"));
    expect(lookup, "a turn never looks up the workspace's provider").toBeDefined();
    expect(lookup?.params, "the turn is not scoped to the calling workspace").toEqual([tenantId]);

    vi.doUnmock("ai");
    vi.doUnmock("@retinue/agentkit/runtime");
    vi.resetModules();
  });
});
