/**
 * The artifact tools against the **old** runtime's contract — REQ-041 AC-4 (#190).
 *
 * This is the file `CAPABILITY_INVENTORY` names as the `contractTest` for `create_artifact`,
 * `update_artifact` and `get_artifact`, so what it has to establish is not "the tools work" but the five
 * clauses of `BEHAVIOURAL_CONTRACT`: the same inputs refused, the same shape written, the same side effects in
 * the same order, the same behaviour on retry, and the same approval requirement.
 *
 * The approval clause is the one that matters most in general, and here it is the least dramatic: all three
 * old tools are `@tool(requires_confirmation=False)` and all three replacements are `read` or
 * `internal-write`, so `approvalParity` reports `not-gated` for each. It is asserted anyway — a future
 * `destructive` reclassification would change it, and a *silent* change to what a person is asked to confirm
 * is the failure mode the whole comparison exists for.
 *
 * The ordering clause is asserted against the database in `adapters/postgres/__tests__/services.test.ts`,
 * because "archived before the update" is a claim about two statements and a stub cannot fail it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  ARTIFACT_MAX_CHARS,
  ARTIFACT_MAX_TITLE,
  ARTIFACT_TOOL_FACTORIES,
  ARTIFACT_TOOL_NAMES,
  createArtifactTool,
  createShareFlowToolProvider,
  getArtifactTool,
  updateArtifactTool,
  type Artifact,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const ARTIFACT: Artifact = {
  id: asId("a1"),
  title: "Q3 content plan",
  kind: "markdown",
  content: "# Plan\n\nFirst paragraph.",
  version: 1,
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T09:00:00.000Z",
  reference: "chorus-artifact:550e8400-e29b-41d4-a716-446655440000",
};

let calls: { method: string; args: Record<string, unknown> }[];

const services = (over: Partial<Artifact> = {}): ShareFlowServices =>
  ({
    artifacts: {
      async create(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "create", args });
        return { ...ARTIFACT, ...over };
      },
      async revise(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "revise", args });
        return { ...ARTIFACT, version: 2, ...over };
      },
      async get(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "get", args });
        return { ...ARTIFACT, ...over };
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, over: Partial<Artifact> = {}): Tool =>
  factory.build({ services: services(over), deps: { authorization: allowAll, idempotency } });

/** A unique key per call, so a loop cannot assert against a replayed earlier result. */
let callCounter = 0;
const run = (tool: Tool, input: unknown, key?: string): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key ?? `k${(callCounter += 1)}` });

const dataOf = (result: ToolResult): Record<string, unknown> =>
  (result as { data: Record<string, unknown> }).data;
const errorOf = (result: ToolResult): { code: string; message: string } =>
  (result as { error: { code: string; message: string } }).error;

beforeEach(() => {
  calls = [];
  callCounter = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("the same shape is written, and the same shape returned", () => {
  it("returns what the old tool returned, and not the document", async () => {
    /**
     * The old tool's docstring names its result exactly: `{"id", "title", "kind", "version", "reference"}`.
     * Content is deliberately absent, and the reason is the context window: the model was just handed the
     * document, so echoing 200,000 characters back adds nothing and costs the turn.
     */
    const result = await run(build(createArtifactTool), {
      title: "Q3 content plan",
      kind: "markdown",
      content: "# Plan\n\nFirst paragraph.",
    });
    const data = dataOf(result);
    expect(Object.keys(data).sort()).toEqual(["artifactId", "kind", "reference", "title", "updatedAt", "version"]);
    expect(data["content"]).toBeUndefined();
    expect(data["reference"]).toBe(ARTIFACT.reference);
  });

  it("returns the document when reading, because reading is the point", async () => {
    const data = dataOf(await run(build(getArtifactTool), { artifactId: "a1" }));
    expect(data["content"]).toBe("# Plan\n\nFirst paragraph.");
    expect(data["version"]).toBe(1);
  });

  it("omits the reference rather than sending a broken one", async () => {
    /**
     * The app's formatter returns null for a non-uuid, and the reason is streaming: a half-written
     * `chorus-artifact:8f14e45` exists for a frame. A client rendering a card for it fetches nothing. So the
     * field is absent, which is a different instruction from an empty string.
     */
    const data = dataOf(await run(build(getArtifactTool, { reference: undefined }), { artifactId: "a1" }));
    expect("reference" in data).toBe(false);
  });
});

describe("the same inputs are refused", () => {
  it("refuses a kind the database would refuse, before the document is written", async () => {
    /**
     * `assistant_artifacts_kind_check` admits markdown, html and mermaid. A closed enum in the schema means
     * "md" is refused at the tool boundary rather than by the database *after* the model produced a whole
     * document — which is the same failure, an hour of tokens later.
     */
    const result = await run(build(createArtifactTool), { title: "t", kind: "md", content: "body" });
    expect(errorOf(result).code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("refuses an empty title and an empty document", async () => {
    for (const input of [
      { title: "   ", kind: "markdown", content: "body" },
      { title: "A title", kind: "markdown", content: "" },
    ]) {
      const result = await run(build(createArtifactTool), input);
      expect(errorOf(result).code, JSON.stringify(input)).toBe("invalid_input");
    }
    expect(calls).toEqual([]);
  });

  it("names the limit rather than letting the model spend the tokens first", async () => {
    // The schema's job, distinct from the adapter's: the adapter protects the row, this protects the turn.
    const long = await run(build(createArtifactTool), {
      title: "t".repeat(ARTIFACT_MAX_TITLE + 1),
      kind: "markdown",
      content: "body",
    });
    expect(errorOf(long).code).toBe("invalid_input");
    const big = await run(build(createArtifactTool), {
      title: "t",
      kind: "markdown",
      content: "c".repeat(ARTIFACT_MAX_CHARS + 1),
    });
    expect(errorOf(big).code).toBe("invalid_input");
  });

  it("gives a revision no way to change the kind", async () => {
    /**
     * The old lib validates a revision against the **stored** kind — `validate(title, row.kind, content)` —
     * so markdown cannot become html by revision. Expressed here as a strict schema with no `kind` field, so
     * a caller who tries is refused rather than silently ignored: ignored, the model would believe it had
     * converted a document and describe it that way.
     */
    const result = await run(build(updateArtifactTool), {
      artifactId: "a1",
      content: "new body",
      kind: "html",
    });
    expect(errorOf(result).code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("takes a title on a revision as optional, and omitting it changes nothing", async () => {
    await run(build(updateArtifactTool), { artifactId: "a1", content: "new body" });
    expect(calls[0]?.method).toBe("revise");
    expect("title" in (calls[0]?.args ?? {})).toBe(false);
  });
});

describe("the same approval requirement — the clause a migration loses quietly", () => {
  it("asks for no confirmation, exactly as the old tools did", () => {
    /**
     * All three old tools are `@tool(requires_confirmation=False)`. Asserted here as well as mechanically in
     * `approvalParity` because that check compares the old flag against the new policy, and this pins the new
     * policy itself: a later reclassification to `destructive` would start prompting, and one to a weaker
     * effect on a tool that *should* prompt is the direction that looks like an improvement.
     */
    const deps = { authorization: allowAll, idempotency };
    const built = ARTIFACT_TOOL_FACTORIES.map((factory) =>
      factory.build({ services: services(), deps }).descriptor,
    );
    for (const descriptor of built) expect(descriptor.approvalPolicy, descriptor.name).toBe("never");
    expect(built.map((d) => `${d.name}:${d.effect}`).sort()).toEqual([
      "create_artifact:internal-write",
      "get_artifact:read",
      "update_artifact:internal-write",
    ]);
  });

  it("writes inside the tenant only, which is why no approval is right", () => {
    // `internal-write` and not `external-write`: an artifact is a row a customer's own team reads. Nothing
    // reaches a platform, so there is no irreversible public effect for a person to authorise.
    const deps = { authorization: allowAll, idempotency };
    const writes = ARTIFACT_TOOL_FACTORIES.map((f) => f.build({ services: services(), deps }).descriptor).filter(
      (d) => d.effect !== "read",
    );
    expect(writes.every((d) => d.effect === "internal-write")).toBe(true);
    expect(writes.every((d) => d.requiresIdempotencyKey === false)).toBe(true);
  });
});

describe("the same behaviour on retry", () => {
  it("replays a create on the same idempotency key instead of writing twice", async () => {
    /**
     * The envelope's guarantee, asserted because a document is the kind of thing a retry duplicates
     * expensively: two identical plans, and a user who cannot tell which one their link points at.
     */
    const tool = build(createArtifactTool);
    const input = { title: "Q3 content plan", kind: "markdown", content: "# Plan\n\nFirst paragraph." };
    const first = await run(tool, input, "same-key");
    const second = await run(tool, input, "same-key");
    expect(dataOf(second)).toEqual(dataOf(first));
    expect(calls.filter((c) => c.method === "create")).toHaveLength(1);
  });
});

describe("the catalog", () => {
  it("is exactly the three the old runtime had", async () => {
    /**
     * No `list_artifacts` and no `delete_artifact`. The old runtime has neither, and a tool the old product
     * did not have is not parity — the gate would have nothing to compare it against, so it would be scope
     * wearing a parity label.
     */
    const provider = createShareFlowToolProvider({
      services: services(),
      deps: { authorization: allowAll, idempotency },
      factories: ARTIFACT_TOOL_FACTORIES,
    });
    const names = (await provider.listTools(CONTEXT)).map((t) => t.descriptor.name);
    expect([...names].sort()).toEqual([...ARTIFACT_TOOL_NAMES].sort());
    expect(names).toHaveLength(3);
  });

  it("classifies all three under one category, so a manifest can select them", () => {
    // `ToolDescriptor.category` is what an agent manifest selects on, and a typo yields an assistant with
    // fewer tools than configured — which reads as the model being unhelpful.
    const deps = { authorization: allowAll, idempotency };
    for (const factory of ARTIFACT_TOOL_FACTORIES) {
      expect(factory.build({ services: services(), deps }).descriptor.category).toBe("artifacts");
    }
  });
});
