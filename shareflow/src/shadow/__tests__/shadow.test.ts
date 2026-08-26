/**
 * Shadow mode (#126).
 *
 * AC-2 is the one that matters most and is easiest to fake: *"a newly added external-write capability is
 * suppressed with no code change of its own."* So that test builds a capability this file invented, which
 * has never heard of shadow mode, and asserts it is suppressed anyway. A test that used an existing tool
 * would prove only that the existing tool was wired.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type RunId, type SuppressedWrite, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createApprovalGate } from "@retinue/agentkit/hitl";
import { createMemoryApprovalGrantStore, createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import {
  createShadowRecorder,
  diffShadowRuns,
  publishPostNowTool,
  wouldPublishMoreThanBefore,
  type ShadowRun,
  type ShareFlowServices,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const RUN = asId<RunId>("r1");

const context = (over: Partial<ExecutionContext> = {}): ExecutionContext =>
  ({
    tenantId: T1,
    principalId: asId<PrincipalId>("p1"),
    conversationId: asId("c1"),
    runId: RUN,
    ...over,
  }) as unknown as ExecutionContext;

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

const grantedGate = async () => {
  const grants = createMemoryApprovalGrantStore();
  await grants.grant({
    tenantId: T1,
    grant: {
      id: asId("g1"),
      tenantId: T1,
      scope: "tenant",
      toolNameOrCategory: "publishing",
      grantedAt: "2026-08-23T00:00:00.000Z",
    },
  });
  return createApprovalGate({ grants });
};

let published: unknown[];
let idempotency: IdempotencyStore;
let recorder: ReturnType<typeof createShadowRecorder>;

const publishingServices = (): ShareFlowServices =>
  ({
    publishing: {
      async validate() {
        return { ok: true, issues: [] };
      },
      async schedule(_c: ExecutionContext, args: unknown) {
        published.push(args);
        return [{ id: asId("t-a1"), accountId: asId("a1"), state: "published" }];
      },
    },
  }) as unknown as ShareFlowServices;

const run = (tool: Tool, ctx: ExecutionContext, input: unknown, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: ctx, input, idempotencyKey: key });

const write = (over: Partial<SuppressedWrite> = {}): SuppressedWrite => ({
  runId: "r1",
  toolName: "publish_post_now",
  delegatesTo: "PublishingService.schedule",
  effect: "external-write",
  input: { postDraftId: "d1", accountIds: ["a1"] },
  idempotencyKey: "k1" as never,
  wouldRequireApproval: true,
  ...over,
});

beforeEach(() => {
  published = [];
  idempotency = createMemoryIdempotencyStore();
  recorder = createShadowRecorder();
});

/** AC-1. */
describe("a shadow run performs no external write", () => {
  it("does not reach the service, and records what it would have done", async () => {
    const tool = publishPostNowTool({
      services: publishingServices(),
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate(), shadow: recorder },
    });
    const result = await run(tool, context({ shadow: true }), { postDraftId: "d1", accountIds: ["a1"] });

    expect(result).toMatchObject({ ok: true, data: { suppressed: true, reason: "shadow-mode" } });
    // The observable effect: nothing reached the publishing service.
    expect(published).toEqual([]);
    const written = recorder.written("r1");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      toolName: "publish_post_now",
      delegatesTo: "PublishingService.schedule",
      effect: "external-write",
      input: { postDraftId: "d1", accountIds: ["a1"] },
      // Captured because suppression happens *before* the gate — a shadow run must not ask a human to
      // approve something that will not happen.
      wouldRequireApproval: true,
    });
  });

  it("does not report a success the assistant could relay as a publish", async () => {
    const tool = publishPostNowTool({
      services: publishingServices(),
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate(), shadow: recorder },
    });
    const result = await run(tool, context({ shadow: true }), { postDraftId: "d1", accountIds: ["a1"] });
    const data = (result as { data: Record<string, unknown> }).data;
    // A fake success would teach the agent to report a publish that never happened. There is no `outcome`
    // here, so nothing can be mistaken for one.
    expect(data).not.toHaveProperty("outcome");
    expect(data).not.toHaveProperty("targets");
    expect(data["suppressed"]).toBe(true);
  });

  it("refuses when the run says shadow and nothing can record it", async () => {
    // Fail closed, in the direction that matters. Announcing a shadow run and having nowhere to record it
    // is not a licence to publish.
    const tool = publishPostNowTool({
      services: publishingServices(),
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate() },
    });
    expect(await run(tool, context({ shadow: true }), { postDraftId: "d1", accountIds: ["a1"] })).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" },
    });
    expect(published).toEqual([]);
  });

  it("suppresses without asking for approval, even when no approval exists", async () => {
    // The discriminating case for the *ordering*, and the one my first pass missed: every other shadow test
    // used a granted gate, so moving suppression after the gate broke nothing. With no grant, the order is
    // the whole answer — before the gate this is suppressed, after it the run stops at `approval_required`
    // and a human is asked to authorise something that was never going to happen.
    const ungranted = createApprovalGate({ grants: createMemoryApprovalGrantStore() });
    const tool = publishPostNowTool({
      services: publishingServices(),
      deps: { authorization: allowAll, idempotency, approvals: ungranted, shadow: recorder },
    });
    const result = await run(tool, context({ shadow: true }), { postDraftId: "d1", accountIds: ["a1"] });
    expect(result).toMatchObject({ ok: true, data: { suppressed: true } });
    expect(published).toEqual([]);
    expect(recorder.written("r1")).toHaveLength(1);
    // And the fact the report wants is kept rather than lost by not asking.
    expect(recorder.written("r1")[0]?.wouldRequireApproval).toBe(true);
  });

  it("does not suppress a real run", async () => {
    const tool = publishPostNowTool({
      services: publishingServices(),
      deps: { authorization: allowAll, idempotency, approvals: await grantedGate(), shadow: recorder },
    });
    for (const ctx of [context(), context({ shadow: false })]) {
      published = [];
      const result = await run(tool, ctx, { postDraftId: "d1", accountIds: ["a1"] }, `k-${String(ctx.shadow)}`);
      expect(result).toMatchObject({ ok: true, data: { outcome: "published" } });
      expect(published).toHaveLength(1);
    }
    expect(recorder.written("r1")).toEqual([]);
  });

  it("does not cache the suppression as the answer for a later real call", async () => {
    // A suppressed call must not become the stored result under that key, or the first real run after a
    // shadow batch would replay "suppressed" and publish nothing while reporting fine.
    const deps = { authorization: allowAll, idempotency, approvals: await grantedGate(), shadow: recorder };
    const tool = publishPostNowTool({ services: publishingServices(), deps });
    await run(tool, context({ shadow: true }), { postDraftId: "d1", accountIds: ["a1"] }, "same");
    const real = await run(tool, context(), { postDraftId: "d1", accountIds: ["a1"] }, "same");
    expect(real).toMatchObject({ ok: true, data: { outcome: "published" } });
    expect(published).toHaveLength(1);
  });
});

/** AC-2 — the one that is easiest to fake. */
describe("a capability that has never heard of shadow mode", () => {
  /** Invented here. Nothing in it mentions shadow, and it is not in any catalog. */
  const brandNewCapability = (deps: Parameters<typeof defineDelegatingTool>[0]) => {
    let calls = 0;
    const tool = defineDelegatingTool(deps, {
      name: "send_carrier_pigeon",
      description: "dispatches a pigeon, irreversibly",
      category: "publishing",
      effect: "external-write",
      delegatesTo: "PigeonService.dispatch",
      delegate: () => {
        calls += 1;
        return { dispatched: true };
      },
    });
    return { tool, calls: () => calls };
  };

  it("is suppressed with no change of its own", async () => {
    const { tool, calls } = brandNewCapability({
      authorization: allowAll,
      idempotency,
      approvals: await grantedGate(),
      shadow: recorder,
    });
    const result = await run(tool, context({ shadow: true }), { message: "fly" });
    expect(result).toMatchObject({ ok: true, data: { suppressed: true } });
    // Inherited from the envelope. There is no per-tool opt-in that could have been forgotten — which is
    // the entire point of AC-1's "enforced in the envelope, not per tool".
    expect(calls()).toBe(0);
    expect(recorder.written("r1")[0]).toMatchObject({
      toolName: "send_carrier_pigeon",
      delegatesTo: "PigeonService.dispatch",
    });
  });

  it("is suppressed when destructive too, not only external-write", async () => {
    const deps = { authorization: allowAll, idempotency, approvals: await grantedGate(), shadow: recorder };
    let calls = 0;
    const tool = defineDelegatingTool(deps, {
      name: "delete_everything",
      description: "removes it all",
      category: "publishing",
      effect: "destructive",
      delegatesTo: "PigeonService.cull",
      delegate: () => {
        calls += 1;
        return { done: true };
      },
    });
    expect(await run(tool, context({ shadow: true }), {})).toMatchObject({ ok: true, data: { suppressed: true } });
    expect(calls).toBe(0);
  });

  it("leaves an internal write alone, which is worth knowing", async () => {
    // docs/07 says "shadow execution performs no external *writes*". So a shadow run still creates real
    // drafts — visible in the workspace's post list. That is a real consequence of the specified scope, not
    // an oversight here, and it is raised on #126 rather than silently widened.
    const deps = { authorization: allowAll, idempotency, shadow: recorder };
    let calls = 0;
    const tool = defineDelegatingTool(deps, {
      name: "save_thing",
      description: "saves a thing internally",
      category: "posts",
      effect: "internal-write",
      delegatesTo: "ContentService.createDraft",
      delegate: () => {
        calls += 1;
        return { saved: true };
      },
    });
    expect(await run(tool, context({ shadow: true }), {})).toMatchObject({ ok: true, data: { saved: true } });
    expect(calls).toBe(1);
    expect(recorder.written("r1")).toEqual([]);
  });
});

/** AC-3 and AC-4. */
describe("the parity report", () => {
  const runOf = (runtime: string, writes: readonly SuppressedWrite[]): ShadowRun => ({
    workflow: "create-post",
    runtime,
    writes,
  });

  it("reports identical runs as identical", () => {
    const report = diffShadowRuns(runOf("agno", [write()]), runOf("agentkit", [write()]));
    expect(report.identical).toBe(true);
    expect(report.diffs).toEqual([
      { kind: "same", toolName: "publish_post_now", delegatesTo: "PublishingService.schedule" },
    ]);
  });

  it("names the fields whose arguments differ, not just that they do", () => {
    const report = diffShadowRuns(
      runOf("agno", [write({ input: { postDraftId: "d1", accountIds: ["a1"] } })]),
      runOf("agentkit", [write({ input: { postDraftId: "d1", accountIds: ["a1", "a2"] } })]),
    );
    expect(report.identical).toBe(false);
    expect(report.diffs[0]).toMatchObject({ kind: "arguments-differ", changedFields: ["accountIds"] });
  });

  it("ignores key order, so two equivalent argument objects are the same", () => {
    const report = diffShadowRuns(
      runOf("agno", [write({ input: { a: 1, b: 2 } })]),
      runOf("agentkit", [write({ input: { b: 2, a: 1 } })]),
    );
    expect(report.identical).toBe(true);
  });

  it("reports a call only one runtime would have made", () => {
    const extra = write({ toolName: "reply_to_comment", delegatesTo: "EngagementService.reply" });
    const withExtra = diffShadowRuns(runOf("agno", [write()]), runOf("agentkit", [write(), extra]));
    expect(withExtra.diffs).toContainEqual({
      kind: "extra",
      toolName: "reply_to_comment",
      delegatesTo: "EngagementService.reply",
      onlyIn: "new",
    });
    const withMissing = diffShadowRuns(runOf("agno", [write(), extra]), runOf("agentkit", [write()]));
    expect(withMissing.diffs).toContainEqual({
      kind: "missing",
      toolName: "reply_to_comment",
      delegatesTo: "EngagementService.reply",
      onlyIn: "old",
    });
  });

  it("reports a reordering once, not as a cascade of mismatches", () => {
    // Matched positionally *within each tool name*. A global index match would report two argument
    // mismatches for a simple swap, burying the real finding under noise.
    const a = write({ toolName: "publish_post_now", delegatesTo: "PublishingService.schedule" });
    const b = write({ toolName: "reply_to_comment", delegatesTo: "EngagementService.reply" });
    const report = diffShadowRuns(runOf("agno", [a, b]), runOf("agentkit", [b, a]));
    expect(report.diffs.filter((d) => d.kind === "arguments-differ")).toEqual([]);
    expect(report.diffs).toContainEqual({ kind: "order-differs", toolName: "*", delegatesTo: "*" });
    expect(report.identical).toBe(false);
  });

  it("refuses to compare two different workflows", () => {
    // A diff between different workflows is meaningless, and producing one anyway is how a parity report
    // gets trusted while comparing nothing.
    expect(() =>
      diffShadowRuns({ workflow: "create-post", runtime: "agno", writes: [] }, { workflow: "publish", runtime: "agentkit", writes: [] }),
    ).toThrowError(/different workflows/);
  });

  it("does not decide whether a difference is a regression", () => {
    const report = diffShadowRuns(
      runOf("agno", [write()]),
      runOf("agentkit", [write({ input: { postDraftId: "d1", accountIds: ["a1", "a2"] } })]),
    );
    // "Some differences are improvements" — the SPEC says so, which is why this produces a report for a
    // person rather than a verdict. No score, no pass/fail beyond "identical or not".
    const keys = Object.keys(report).sort();
    expect(keys).toEqual(["approvalBearingWrites", "diffs", "identical", "newRuntime", "oldRuntime", "workflow"]);
    for (const forbidden of ["score", "passed", "regression", "severity"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("surfaces the one number a reviewer must not have to derive", () => {
    // REQ-021's criterion is "zero unauthorized or duplicate actions". The migration's version is that the
    // new runtime must not want to publish more than the old one did — and counting that out of forty
    // diffs is exactly the step someone skips.
    const same = diffShadowRuns(runOf("agno", [write()]), runOf("agentkit", [write()]));
    expect(same.approvalBearingWrites).toEqual({ old: 1, new: 1 });
    expect(wouldPublishMoreThanBefore(same)).toBe(false);

    const more = diffShadowRuns(
      runOf("agno", [write()]),
      runOf("agentkit", [write(), write({ toolName: "schedule_post" })]),
    );
    expect(more.approvalBearingWrites).toEqual({ old: 1, new: 2 });
    expect(wouldPublishMoreThanBefore(more)).toBe(true);
  });

  it("does not count a write that needs no approval as one that does", () => {
    const report = diffShadowRuns(
      runOf("agno", [write({ wouldRequireApproval: false })]),
      runOf("agentkit", [write({ wouldRequireApproval: false })]),
    );
    expect(report.approvalBearingWrites).toEqual({ old: 0, new: 0 });
  });
});

describe("the recorder", () => {
  it("keeps runs apart", () => {
    recorder.record(null, write({ runId: "r1" }));
    recorder.record(null, write({ runId: "r2", toolName: "schedule_post" }));
    expect(recorder.written("r1").map((w) => w.toolName)).toEqual(["publish_post_now"]);
    expect(recorder.written("r2").map((w) => w.toolName)).toEqual(["schedule_post"]);
    expect(recorder.runIds().sort()).toEqual(["r1", "r2"]);
  });

  it("keeps order within a run, since order is a difference the report reports", () => {
    recorder.record(null, write({ toolName: "first" }));
    recorder.record(null, write({ toolName: "second" }));
    expect(recorder.written("r1").map((w) => w.toolName)).toEqual(["first", "second"]);
  });

  it("returns a copy, so a caller cannot mutate the record", () => {
    recorder.record(null, write());
    const first = recorder.written("r1") as SuppressedWrite[];
    first.push(write({ toolName: "injected" }));
    expect(recorder.written("r1")).toHaveLength(1);
  });

  it("handles a run with no id rather than dropping the write", () => {
    // A tool executed outside a run still suppresses, and losing the record would make the suppression
    // invisible — worse than recording it under a placeholder.
    recorder.record(null, write({ runId: undefined }));
    expect(recorder.written(undefined)).toHaveLength(1);
  });
});
