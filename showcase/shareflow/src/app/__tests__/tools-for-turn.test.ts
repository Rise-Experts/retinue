/**
 * What the model is handed for a turn — retinue REQ-041 (#190).
 *
 * The first assertion here is the one that matters most, and it is a bug the reference application
 * shipped and then chased into the platform: drop `inputSchema` when mapping a descriptor and
 * `streamModelTurn` substitutes a permissive object schema, the SDK has nothing to parse streamed
 * arguments into, and **every tool call arrives as `{}`**.
 *
 * The symptom is indistinguishable from a platform streaming bug — calls with empty arguments,
 * requested work silently not happening — and it took reading the SDK's raw chunks to find the fault
 * was in the mapping. So it gets a test.
 */
import { describe, expect, it, vi } from "vitest";

import { FIND_TOOLS_SCHEMA, createBuildTools, withLearnableSchemas } from "../tools-for-turn.js";
import { SOCIAL_ASSISTANT_PRELOADED_TOOLS } from "../../manifests/index.js";

const context = { tenantId: "t1", principalId: "p1", roleIds: ["editor"] } as never;

const registry = (catalog: {
  preloaded?: readonly unknown[];
  discoverable?: readonly unknown[];
  meta?: readonly unknown[];
}) => {
  const asked: unknown[] = [];
  const executed: unknown[] = [];
  return {
    asked,
    executed,
    registry: {
      async catalog(_context: unknown, policy: unknown) {
        asked.push(policy);
        return { preloaded: catalog.preloaded ?? [], discoverable: catalog.discoverable ?? [], meta: catalog.meta ?? [] };
      },
      async execute(_context: unknown, call: unknown) {
        executed.push(call);
        return { ok: true };
      },
    } as never,
  };
};

const descriptor = (name: string, inputSchema?: unknown) => ({
  name,
  description: name + " does a thing",
  ...(inputSchema === undefined ? {} : { inputSchema }),
});

describe("the tools handed to the model", () => {
  it("carries each preloaded tool's input schema", async () => {
    /**
     * **The `{}` bug.** Without this the provider gets no schema for the tool, invents a permissive
     * one, and every argument the model streams is discarded.
     */
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
    const { registry: r } = registry({ preloaded: [descriptor("get_post_draft", schema)] });
    const tools = await createBuildTools(r)(context);
    expect(tools).toHaveLength(1);
    expect((tools[0] as unknown as { inputSchema?: unknown }).inputSchema).toEqual(schema);
  });

  it("omits the field entirely for a tool that declares no schema", async () => {
    // Absent rather than `undefined` or `{}`: a tool with no arguments and a tool whose schema was
    // dropped must not look the same to the provider.
    const { registry: r } = registry({ preloaded: [descriptor("check_media_storage")] });
    const tools = await createBuildTools(r)(context);
    expect(tools[0]).not.toHaveProperty("inputSchema");
  });

  it("asks for the manifest's preloaded set and NO categories", async () => {
    /**
     * **The categories line was the empty-answer bug**, and this assertion is the whole of it.
     *
     * The registry preloads a tool when `preloadNames.has(name) || preloadCategories.has(category)`.
     * This used to pass `SHAREFLOW_TOOL_CATEGORIES` — every category ShareFlow has — so the second
     * clause matched every tool and all fifty-eight were preloaded while `discoverable` stayed empty.
     *
     * Measured against a real Gemini call, from a local run of the actual worker against a real
     * database:
     *
     *   with every category   61 declarations, 45,467 bytes of them, 12,162 prompt tokens,
     *                         **7 of 29 model calls returned an empty candidate**
     *   with none             21 declarations, ~5,500 prompt tokens, **0 of 95**
     *
     * An "empty candidate" is `finishReason: STOP` with a candidate carrying no `parts` at all, which
     * the platform's `finish` handler — reading `totalUsage` and never `finishReason` — reports as a
     * completed run with nothing in it. From the app: send a message, watch nothing appear, and find
     * nothing wrong to retry.
     *
     * `preloaded` still comes from the manifest so the two cannot disagree about the named set.
     */
    const { registry: r, asked } = registry({});
    await createBuildTools(r)(context);
    const policy = asked[0] as { preloaded: readonly string[]; categories: readonly string[] };
    expect(policy.preloaded).toEqual([...SOCIAL_ASSISTANT_PRELOADED_TOOLS]);
    expect(policy.categories).toEqual([]);
  });

  it("declares exactly the preloaded set and the meta-tools, and nothing else", async () => {
    /**
     * The count, because the failure mode is a *number*: what reached the model was 61 declarations
     * where the design says 21, and no test looked at how many there were. A discoverable entry must
     * stay discoverable — reachable through `find_tools` and `execute_tool`, not declared up front.
     */
    const { registry: r } = registry({
      preloaded: [descriptor("list_accounts", { type: "object" }), descriptor("list_post_drafts", { type: "object" })],
      discoverable: [descriptor("delete_post"), descriptor("render_diagram")],
      meta: [descriptor("find_tools"), descriptor("execute_tool")],
    });
    const tools = await createBuildTools(r)(context);
    expect(tools.map((t) => (t as { name: string }).name)).toEqual([
      "list_accounts",
      "list_post_drafts",
      "find_tools",
      "execute_tool",
    ]);
  });

  it("hands over find_tools when the registry has a search, with an explicit schema", async () => {
    /**
     * Without it the lazy catalogue is built, tested and unreachable: this deployment preloads two of
     * forty-six tools, so a model with no way to search has forty-four it can never call. That is the
     * difference between a deferral and an amputation.
     *
     * The schema is written out because a meta-tool descriptor carries none — and a permissive one
     * would reproduce the `{}` bug for the one tool whose whole purpose is a query string.
     */
    const { registry: r } = registry({ meta: [descriptor("find_tools")] });
    const tools = await createBuildTools(r)(context);
    const find = tools.find((tool) => (tool as unknown as { name: string }).name === "find_tools");
    expect(find).toBeDefined();
    expect((find as unknown as { inputSchema: unknown }).inputSchema).toBe(FIND_TOOLS_SCHEMA);
    expect(FIND_TOOLS_SCHEMA.required).toContain("query");
  });

  it("omits find_tools when no search is wired", async () => {
    /**
     * From `catalog.meta` rather than assumed. A `find_tools` handed to a registry with no search would
     * be a tool that always fails, which costs a turn to discover and teaches the model not to try
     * again.
     */
    const { registry: r } = registry({ meta: [] });
    expect(await createBuildTools(r)(context)).toEqual([]);
  });

  it("routes execution back through the registry, under the turn's own context", async () => {
    /**
     * Not a captured context from build time. The registry re-authorises on execute, and a tool
     * executing under a different principal's context than the one that asked for it is the
     * worker-identity bug in a new place.
     */
    const { registry: r, executed } = registry({ preloaded: [descriptor("list_post_drafts", { type: "object" })] });
    const tools = await createBuildTools(r)(context);
    await (tools[0] as unknown as { execute: (input: unknown) => Promise<unknown> }).execute({ limit: 5 });
    expect(executed).toEqual([{ name: "list_post_drafts", input: { limit: 5 } }]);
  });
});

/**
 * The meta-tools, and the half that was missing.
 *
 * `find_tools` was wired and `execute_tool` was not, which is worse than wiring neither: the model
 * could discover a tool it had no way to call. It then emits a function call by that name — never
 * declared — and Gemini answers `finishReason: UNEXPECTED_TOOL_CALL` with an empty candidate. The
 * platform's `finish` handler ignores `finishReason`, so the run completed with **zero parts**: no
 * text, no error, no tool call. The assistant answered nothing, deterministically, for any prompt
 * needing one of the fifty-six tools outside the preloaded two.
 *
 * Every direct test passed throughout, because `POST /api/tools/:name` bypasses the model. That is
 * what these assertions exist to stop happening again: they check the *model's* surface, not the
 * tool's.
 */
describe("the registry meta-tools", () => {
  const META = [
    { name: "find_tools", description: "search" },
    { name: "execute_tool", description: "run one" },
    { name: "learn_tools", description: "fetch schemas" },
    { name: "load_skill", description: "load instructions" },
  ];

  it("hands over execute_tool, so a discovered tool can actually be called", async () => {
    const { registry: r } = registry({ meta: META });
    const tools = await createBuildTools(r)(context);
    const execute = tools.find((t) => (t as { name: string }).name === "execute_tool");

    expect(execute, "execute_tool must reach the model — without it discovery leads nowhere").toBeDefined();
    /**
     * The schema is the registry's own `unwrapExecuteTool` shape. A permissive object here would put
     * the tool back in the state that started this: declared, called, and arriving with no `name`.
     */
    const schema = (execute as { inputSchema: { required: string[]; properties: Record<string, unknown> } }).inputSchema;
    expect(schema.required).toEqual(["name"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["idempotencyKey", "input", "name"]);
  });

  it("hands over learn_tools and load_skill with their own schemas", async () => {
    const { registry: r } = registry({ meta: META });
    const tools = await createBuildTools(r)(context);
    const byName = new Map(tools.map((t) => [(t as { name: string }).name, t]));

    expect([...byName.keys()].sort()).toEqual(["execute_tool", "find_tools", "learn_tools", "load_skill"]);
    expect((byName.get("learn_tools") as { inputSchema: { required: string[] } }).inputSchema.required).toEqual(["names"]);
    // Seven skills ship active; without this the model cannot load any of them.
    expect((byName.get("load_skill") as { inputSchema: { required: string[] } }).inputSchema.required).toEqual(["name"]);
  });

  it("declares only what the platform offers, so it cannot advertise a call the registry refuses", async () => {
    // `read_tool_output` has no `execute` branch in the registry; offering it would be a dead call.
    const { registry: r } = registry({ meta: [{ name: "find_tools", description: "search" }] });
    const tools = await createBuildTools(r)(context);
    expect(tools.map((t) => (t as { name: string }).name)).toEqual(["find_tools"]);
  });

  it("never declares a meta-tool this host has no schema for", async () => {
    /**
     * The inverse guard. `read_tool_output`, `ask_questions` and `request_approval` appear in the
     * platform's catalogue and are deliberately not handed over — the first has no registry branch,
     * the other two belong to the HITL subsystem. A permissive fallback schema would declare all
     * three and turn each into a call the model makes and nothing serves.
     */
    const { registry: r } = registry({
      meta: [
        { name: "read_tool_output", description: "read a spilled result" },
        { name: "ask_questions", description: "ask the user" },
        { name: "request_approval", description: "ask permission" },
      ],
    });
    expect(await createBuildTools(r)(context)).toEqual([]);
  });

  it("routes every meta-tool's execution back through the registry under the turn's context", async () => {
    const { registry: r, executed } = registry({ meta: META });
    const tools = await createBuildTools(r)(context);
    for (const t of tools) await (t as { execute: (i: unknown) => Promise<unknown> }).execute({ probe: true });

    expect(executed.map((c) => (c as { name: string }).name).sort()).toEqual([
      "execute_tool",
      "find_tools",
      "learn_tools",
      "load_skill",
    ]);
  });
});

/**
 * `learn_tools`' schemas, and the **hard run failure** they caused.
 *
 * The registry answers `learn_tools` with the descriptors themselves, and every ShareFlow descriptor
 * carries a Zod schema. So the tool result handed back to the model contained live Zod instances —
 * objects with methods — and the AI SDK validates its prompt before it sends one:
 *
 *   Invalid prompt: The messages do not match the ModelMessage[] schema.
 *
 * The run failed. Not a bad answer: no model call at all, on exactly the turns where the model did the
 * right thing — `find_tools` to discover, `learn_tools` to read the schema, and then nothing. Three of
 * eighteen sweep prompts died this way, all three of them ones whose tool is not preloaded, which made
 * it look like a category of question the assistant could not answer.
 */
describe("learn_tools answers in JSON Schema", () => {
  const zodish = (shape: unknown) => ({
    _def: { typeName: "ZodObject" },
    safeParse: () => ({ success: true }),
    shape,
  });

  const learning = (tools: readonly unknown[]) => {
    const calls: unknown[] = [];
    const inner = {
      async catalog() {
        return { preloaded: [], discoverable: [], meta: [] };
      },
      async execute(_context: unknown, call: { name: string }) {
        calls.push(call);
        return { ok: true, data: { tools } };
      },
    } as never;
    return { calls, wrapped: withLearnableSchemas(inner) };
  };

  it("converts a Zod input schema into JSON Schema", async () => {
    const { wrapped } = learning([
      { name: "list_leads", description: "list them", inputSchema: (await import("zod")).z.object({ limit: (await import("zod")).z.number() }) },
    ]);
    const result = (await wrapped.execute(context, { name: "learn_tools", input: { names: ["list_leads"] } })) as {
      data: { tools: readonly { inputSchema: { type?: string; properties?: Record<string, unknown> } }[] };
    };
    const schema = result.data.tools[0]!.inputSchema;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toContain("limit");
    // The value must survive `JSON.stringify` unchanged, which is the property the SDK actually checks.
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toContain("_def");
  });

  it("drops a schema it cannot convert rather than passing the object on", async () => {
    // An unconvertible Zod instance is precisely the value that fails prompt validation. The
    // description survives, so the model can still ask for the tool through `execute_tool`.
    const { wrapped } = learning([{ name: "odd_tool", description: "does a thing", inputSchema: zodish({}) }]);
    const result = (await wrapped.execute(context, { name: "learn_tools", input: { names: ["odd_tool"] } })) as {
      data: { tools: readonly Record<string, unknown>[] };
    };
    expect(result.data.tools[0]!["inputSchema"]).toBeUndefined();
    expect(result.data.tools[0]!["description"]).toBe("does a thing");
  });

  it("leaves a JSON schema exactly as it was", async () => {
    const schema = { type: "object", properties: { id: { type: "string" } } };
    const { wrapped } = learning([{ name: "get_post_draft", inputSchema: schema }]);
    const result = (await wrapped.execute(context, { name: "learn_tools", input: { names: ["get_post_draft"] } })) as {
      data: { tools: readonly { inputSchema: unknown }[] };
    };
    expect(result.data.tools[0]!.inputSchema).toEqual(schema);
  });

  it("touches nothing on any other call", async () => {
    // Only `learn_tools` carries schemas out of the registry. A blanket rewrite of every result would
    // be a second, invisible transformation of app data on its way to the model.
    const schema = zodish({});
    const { wrapped, calls } = learning([{ name: "x", inputSchema: schema }]);
    const result = await wrapped.execute(context, { name: "execute_tool", input: { name: "list_leads" } });
    // Identity, not equality: the point is that the value was not rebuilt on its way through.
    expect((result as { data: { tools: readonly { inputSchema: unknown }[] } }).data.tools[0]!.inputSchema).toBe(schema);
    expect(calls).toEqual([{ name: "execute_tool", input: { name: "list_leads" } }]);
  });

  it("passes a failed result through untouched", async () => {
    const inner = {
      async catalog() {
        return { preloaded: [], discoverable: [], meta: [] };
      },
      async execute() {
        return { ok: false, error: { code: "invalid_input", message: "learn_tools needs `names`", retryable: false } };
      },
    } as never;
    const result = await withLearnableSchemas(inner).execute(context, { name: "learn_tools", input: {} });
    expect(result).toEqual({ ok: false, error: { code: "invalid_input", message: "learn_tools needs `names`", retryable: false } });
  });
});

/**
 * `execute_tool` may not proxy a gated tool.
 *
 * The platform's HITL wrapper resolves a descriptor before deciding anything, and hands the call to
 * the raw runner when there is none:
 *
 * ```js
 * const [descriptor] = await deps.tools.learn(ctx, [call.name]);
 * if (!descriptor) return { outcome: "result", result: await deps.tools.execute(ctx, call) };
 * ```
 *
 * `execute_tool` is a meta-tool and is absent from `learn`'s corpus, so a gated tool routed through it
 * takes that branch. The registry's gate still fires — it is unbypassable — but `approval_required`
 * arrives as an ordinary result instead of an interaction, and the engine turns an unexpected result
 * into a thrown error. Measured before the fix: `delete_post` by name raised `approval-requested`; the
 * same call through `execute_tool` returned a result and raised **zero** approvals, and the run failed
 * with "Tool delete_post requires approval" — no card, nothing pending, an approval that cannot exist.
 *
 * Two things close it, and both are tested. Preloading every gated tool restores the direct path
 * (`manifests.test.ts`), and because `catalog()` puts a tool in `preloaded` **or** `discoverable` and
 * never both, `find_tools` can no longer surface one for `execute_tool` to proxy. That second half is
 * a property of the platform's catalogue partitioning rather than a promise to this deployment, so the
 * refusal below holds it independently.
 */
describe("execute_tool and the approval gate", () => {
  const gated = (approvalPolicy: string) => {
    const executed: string[] = [];
    const inner = {
      async catalog() {
        return { preloaded: [], discoverable: [], meta: [] };
      },
      async learn(_context: unknown, names: readonly string[]) {
        return names.map((name) => ({ name, approvalPolicy }));
      },
      async execute(_context: unknown, call: { name: string }) {
        executed.push(call.name);
        return { ok: true, data: {} };
      },
    } as never;
    return { executed, wrapped: withLearnableSchemas(inner) };
  };

  const viaExecuteTool = (name: string) => ({
    name: "execute_tool",
    input: { name, input: {}, idempotencyKey: "k" },
  });

  it("refuses to proxy a tool that needs approval, and says to call it directly", async () => {
    const { executed, wrapped } = gated("always");
    const result = (await wrapped.execute(context, viaExecuteTool("delete_post"))) as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_input");
    // The advice has to be actionable, which is why the preload invariant exists: the tool *is* declared.
    expect(result.error.message).toContain("call it directly");
    expect(result.error.message).toContain("delete_post");
    // And the call never reached the registry, so there is no unapproved execution to worry about.
    expect(executed).toEqual([]);
  });

  it("refuses a policy-gated tool too, not only an always-gated one", async () => {
    // `approvalPolicy` has three values and only `never` is safe here; a check for `=== "always"`
    // would leave `policy` — the tenant-configurable one — going through the broken route.
    const { wrapped } = gated("policy");
    const result = (await wrapped.execute(context, viaExecuteTool("some_tool"))) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("proxies an ungated tool untouched, because that is what the lazy catalogue is for", async () => {
    /**
     * The other half of the guarantee. Thirty-eight of the fifty-eight tools are reachable only
     * through `execute_tool`; a guard that refused all of them would replace an unapprovable action
     * with an unreachable catalogue.
     */
    const { executed, wrapped } = gated("never");
    const result = (await wrapped.execute(context, viaExecuteTool("list_campaigns"))) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(executed).toEqual(["execute_tool"]);
  });

  it("leaves a direct call to a gated tool alone, so the gate can raise a real approval", async () => {
    // The refusal is about the *route*, not the tool. A direct call must reach the registry and come
    // back `approval_required`, which is what the HITL wrapper turns into a permission card.
    const { executed, wrapped } = gated("always");
    const result = (await wrapped.execute(context, {
      name: "delete_post",
      input: {},
      idempotencyKey: "k",
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(executed).toEqual(["delete_post"]);
  });

  it("ignores an execute_tool call with no target rather than throwing on it", async () => {
    // The platform validates this itself; the guard must not turn a malformed call into a crash.
    const { executed, wrapped } = gated("always");
    expect(((await wrapped.execute(context, { name: "execute_tool", input: {} })) as { ok: boolean }).ok).toBe(true);
    expect(executed).toEqual(["execute_tool"]);
  });
});
