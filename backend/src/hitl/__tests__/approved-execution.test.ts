/**
 * The approval loop, end to end.
 *
 * These tests assemble the real pieces — the real `ToolRegistry`, the real delegating envelope, the
 * real `ApprovalGate`, the real `InteractionStore` — because every stub here would be a stub of the
 * thing under test. The loop's whole failure mode was that each piece worked and nothing joined them:
 * the gate refused, the decision was recorded, and no path existed from one to the other.
 *
 * Three guarantees are asserted directly, and each has a matching sabotage:
 *
 *  1. **No execution without a decision.** A refused call raises an approval and stops there.
 *  2. **One execution per `allow-once`.** The claim is the counter; a second resumption finds nothing.
 *  3. **The stored input runs.** Not the model's regenerated arguments — what the human saw.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { InteractionId, PrincipalId, RunId, TenantId } from "../../core/ids.js";
import {
  createMemoryApprovalGrantStore,
  createMemoryIdempotencyStore,
  createMemoryInteractionStore,
} from "../../adapters/memory/index.js";
import type { JobDispatcher } from "../../runtime/index.js";
import { createToolRegistry, defineDelegatingTool } from "../../tools/index.js";
import type { Tool, ToolProvider } from "../../tools/index.js";
import type { AuthorizationPolicy } from "../../authorization/index.js";
import { createApprovalGate, createApprovalService, createRunApprovals } from "../index.js";

/** Permissive on purpose: authorisation is a different guarantee, tested where it lives. */
const allowAllAuthorization = (): AuthorizationPolicy => ({
  async can() {
    return { allow: true };
  },
  async filterTools(_ctx, tools) {
    return tools;
  },
  async scope(context) {
    return { tenantId: context.tenantId, roleIds: context.roleIds };
  },
});

const T = asId<TenantId>("t1");
const RUN = asId<RunId>("run1");

const ctx = (): ExecutionContext =>
  ({
    tenantId: T,
    principalId: asId<PrincipalId>("p1"),
    conversationId: asId("c1"),
    roleIds: [],
    locale: "en",
    timezone: "UTC",
    requestId: asId("req1"),
    runId: RUN,
  }) as ExecutionContext;

const PUBLISH_INPUT = z.object({ draftId: z.string(), channel: z.string().default("linkedin") });

/**
 * One publishing capability over the real envelope, plus the whole run path above it.
 *
 * `published` is the ledger the assertions read: it records every side effect that actually happened,
 * which is the only honest way to test "exactly once".
 */
const harness = (options: { readonly clock?: () => string } = {}) => {
  const published: { draftId: string; channel: string }[] = [];
  const interactions = createMemoryInteractionStore();
  const grants = createMemoryApprovalGrantStore();
  const idempotency = createMemoryIdempotencyStore();
  const authorization = allowAllAuthorization();
  const enqueued: RunId[] = [];
  const dispatcher: JobDispatcher = { async enqueueRun({ runId }) { enqueued.push(runId); } };
  const clock = options.clock ?? (() => "2026-08-23T12:00:00.000Z");

  const approvals = createApprovalGate({ grants, interactions, clock });
  const publish: Tool = defineDelegatingTool<{ draftId: string; channel: string }, { url: string }>(
    { authorization, approvals, idempotency },
    {
      name: "publish_post",
      description: "Publish a draft",
      category: "publishing",
      effect: "external-write",
      inputSchema: PUBLISH_INPUT,
      delegatesTo: "shareflow:publishPost",
      delegate: (input) => {
        published.push(input);
        return { url: `https://example.test/${input.draftId}` };
      },
    },
  );
  const provider: ToolProvider = { id: "test", async listTools() { return [publish]; } };
  const registry = createToolRegistry({ providers: [provider], authorization, idempotency, approval: approvals });
  const service = createApprovalService({ interactions, grants, dispatcher, clock, idFactory: idFactory() });

  const runApprovals = createRunApprovals({ interactions, approvals: service, tools: registry, clock });

  return { published, interactions, grants, service, registry, runApprovals, enqueued, clock };
};

let n = 0;
const idFactory = () => () => `int-${(n += 1)}`;

/** Everything a first attempt does: the model calls the tool, the gate refuses, an approval is raised. */
const requestApproval = async (h: ReturnType<typeof harness>, input: unknown = { draftId: "d1" }) => {
  const outcome = await h.runApprovals.runTool(ctx(), RUN, { name: "publish_post", input });
  if (outcome.outcome !== "approval-requested") throw new Error(`expected an approval, got ${outcome.outcome}`);
  return outcome.approval;
};

describe("the run path raises an approval when a gated tool is refused", () => {
  it("raises a pending approval instead of returning a dead refusal, and publishes nothing", async () => {
    const h = harness();
    const approval = await requestApproval(h);

    expect(approval.toolName).toBe("publish_post");
    expect(h.published).toEqual([]);
    // Durable: a different reader over the same store finds it, so a restart does not lose the ask.
    expect(await h.interactions.findPendingApproval({ tenantId: T, runId: RUN })).toMatchObject({ id: approval.id });
  });

  it("stores the schema-normalized input, not the model's raw arguments", async () => {
    const h = harness();
    const approval = await requestApproval(h, { draftId: "d1" });
    // `channel` was defaulted by the schema. The human approves what will run, so what is stored has
    // to be what will run — normalizing at execution instead would show them a different call.
    expect(approval.normalizedInput).toEqual({ draftId: "d1", channel: "linkedin" });
  });

  it("carries an idempotency key derived from the run, so the approved call cannot double-fire", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    expect(approval.idempotencyKey).toContain(RUN);
  });

  it("refuses invalid input before asking a human to approve it", async () => {
    const h = harness();
    const outcome = await h.runApprovals.runTool(ctx(), RUN, { name: "publish_post", input: { draftId: 7 } });

    expect(outcome.outcome).toBe("result");
    if (outcome.outcome === "result") expect(outcome.result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // Nothing pending: approving a call that cannot succeed teaches a human their approval is theatre.
    expect(await h.interactions.findPendingApproval({ tenantId: T, runId: RUN })).toBeNull();
  });

  it("re-requesting the same call reuses the pending approval rather than stacking a second one", async () => {
    const h = harness();
    const first = await requestApproval(h);
    const second = await requestApproval(h);
    expect(second.id).toBe(first.id);
  });

  it("passes an ungated call straight through", async () => {
    const h = harness();
    await h.grants.grant({
      tenantId: T,
      grant: { id: asId("g1"), tenantId: T, scope: "tenant", toolNameOrCategory: "publishing", grantedAt: "t" },
    });
    const outcome = await h.runApprovals.runTool(ctx(), RUN, { name: "publish_post", input: { draftId: "d1" } });

    expect(outcome.outcome).toBe("result");
    expect(h.published).toEqual([{ draftId: "d1", channel: "linkedin" }]);
  });
});

describe("resumption executes the stored input", () => {
  it("runs the approved call after allow-once, with the tool and input that were stored", async () => {
    const h = harness();
    const approval = await requestApproval(h, { draftId: "d1" });
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });

    const resumed = await h.runApprovals.resume(ctx(), RUN);

    expect(resumed.outcome).toBe("executed");
    if (resumed.outcome === "executed") expect(resumed.result).toMatchObject({ ok: true });
    expect(h.published).toEqual([{ draftId: "d1", channel: "linkedin" }]);
  });

  it("executes the stored input even when the pending arguments have since changed underneath it", async () => {
    const h = harness();
    const approval = await requestApproval(h, { draftId: "d1" });
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });

    // The model gets another turn before the resumption and asks for something else entirely. The
    // resumed call must be the one the human read and approved — a regenerated one means the approval
    // was for content that is not what runs.
    await h.runApprovals.runTool(ctx(), RUN, { name: "publish_post", input: { draftId: "SOMETHING-ELSE" } });
    await h.runApprovals.resume(ctx(), RUN);

    expect(h.published).toEqual([{ draftId: "d1", channel: "linkedin" }]);
  });

  it("does nothing when there is no decision yet", async () => {
    const h = harness();
    await requestApproval(h);
    const resumed = await h.runApprovals.resume(ctx(), RUN);

    expect(resumed.outcome).toBe("none");
    expect(h.published).toEqual([]);
  });

  it("does nothing for a run with no approval at all", async () => {
    const h = harness();
    expect(await h.runApprovals.resume(ctx(), RUN)).toEqual({ outcome: "none" });
  });

  it("does not execute a denied approval, and does not leave it pending forever", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "deny" });

    const resumed = await h.runApprovals.resume(ctx(), RUN);
    expect(resumed.outcome).toBe("denied");
    expect(h.published).toEqual([]);
    // Claimed even though nothing ran, so the next resumption does not re-read the same denial and
    // loop on it.
    expect(await h.runApprovals.resume(ctx(), RUN)).toEqual({ outcome: "none" });
  });

  it("does not execute an approval that expired before anyone resumed it", async () => {
    let now = "2026-08-23T12:00:00.000Z";
    const h = harness({ clock: () => now });
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });
    now = "2099-01-01T00:00:00.000Z";

    const resumed = await h.runApprovals.resume(ctx(), RUN);
    expect(resumed.outcome).toBe("expired");
    expect(h.published).toEqual([]);
  });
});

describe("allow-once permits exactly one execution", () => {
  it("executes once and refuses every later resumption", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });

    const first = await h.runApprovals.resume(ctx(), RUN);
    const second = await h.runApprovals.resume(ctx(), RUN);
    const third = await h.runApprovals.resume(ctx(), RUN);

    expect(first.outcome).toBe("executed");
    expect(second.outcome).toBe("none");
    expect(third.outcome).toBe("none");
    expect(h.published).toEqual([{ draftId: "d1", channel: "linkedin" }]);
  });

  it("survives two workers racing the same resumption — one publish, not two", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });

    const outcomes = await Promise.all([h.runApprovals.resume(ctx(), RUN), h.runApprovals.resume(ctx(), RUN)]);

    expect(outcomes.filter((o) => o.outcome === "executed")).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  it("leaves the gate exactly as closed as before — the next call needs its own approval", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });
    await h.runApprovals.resume(ctx(), RUN);

    // The whole reason `allow-once` is not a grant: a second, different publish must ask again.
    const next = await h.runApprovals.runTool(ctx(), RUN, { name: "publish_post", input: { draftId: "d2" } });
    expect(next.outcome).toBe("approval-requested");
    expect(h.published).toEqual([{ draftId: "d1", channel: "linkedin" }]);
  });

  it("a spent ticket cannot be replayed by a caller that kept hold of it", async () => {
    const h = harness();
    const approval = await requestApproval(h);
    await h.service.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });
    await h.runApprovals.resume(ctx(), RUN);

    // Going around the coordinator entirely, straight at the registry with the interaction id. The
    // second execution is refused by idempotency, not by the ticket having been invalidated — which is
    // the honest statement of the guarantee: the claim bounds the coordinator, the key bounds the call.
    const replay = await h.registry.execute(ctx(), {
      name: "publish_post",
      input: approval.normalizedInput,
      idempotencyKey: approval.idempotencyKey,
      approval: { interactionId: approval.id },
    });
    expect(replay).toMatchObject({ ok: true });
    expect(h.published).toHaveLength(1);
  });
});

/**
 * Where this meets shadow mode (#126).
 *
 * The envelope suppresses a gated write *before* the gate, on the reasoning that a shadow run must not
 * ask a human to approve something that will not happen. That reasoning only holds if the run path
 * agrees: the loop is the thing that would create the request, so if suppression ever moved below the
 * gate, this is the test that would notice.
 */
describe("a shadow run asks for nothing", () => {
  it("suppresses the write without raising an approval", async () => {
    const published: unknown[] = [];
    const recorded: { toolName: string; wouldRequireApproval: boolean }[] = [];
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const idempotency = createMemoryIdempotencyStore();
    const authorization = allowAllAuthorization();
    const approvals = createApprovalGate({ grants, interactions, clock: () => "t" });
    const tool = defineDelegatingTool<{ draftId: string }, { url: string }>(
      {
        authorization,
        approvals,
        idempotency,
        shadow: {
          record(_c, write) {
            recorded.push({ toolName: write.toolName, wouldRequireApproval: write.wouldRequireApproval });
          },
        },
      },
      {
        name: "publish_post",
        description: "Publish a draft",
        category: "publishing",
        effect: "external-write",
        inputSchema: PUBLISH_INPUT,
        delegatesTo: "shareflow:publishPost",
        delegate: (input) => {
          published.push(input);
          return { url: "x" };
        },
      },
    );
    const registry = createToolRegistry({
      providers: [{ id: "t", async listTools() { return [tool as Tool]; } }],
      authorization,
      idempotency,
      approval: approvals,
      // The registry suppresses now, and it is the layer that matters: the envelope covers delegating
      // tools only, so an MCP-imported external write reached its own execute in a shadow run.
      shadow: {
        record(_c, write) {
          recorded.push({ toolName: write.toolName, wouldRequireApproval: write.wouldRequireApproval });
        },
      },
    });
    let n = 0;
    const service = createApprovalService({
      interactions,
      grants,
      dispatcher: { async enqueueRun() {} },
      clock: () => "t",
      idFactory: () => `shadow-int-${(n += 1)}`,
    });
    const runApprovals = createRunApprovals({ interactions, approvals: service, tools: registry, clock: () => "t" });

    const shadowContext = { ...ctx(), shadow: true } as ExecutionContext;
    const outcome = await runApprovals.runTool(shadowContext, RUN, { name: "publish_post", input: { draftId: "d1" } });

    // Nothing ran, and — the point of this test — nobody was asked.
    expect(outcome.outcome).toBe("result");
    expect(published).toEqual([]);
    expect(await interactions.findPendingApproval({ tenantId: T, runId: RUN })).toBeNull();

    // The gap this test used to pin is closed. Suppression moved to the registry, *before* its gate, for a
    // reason bigger than the missing parity record: the envelope covers delegating tools only, so a gated
    // tool that is not one — every MCP-imported external write — reached its own execute and performed a
    // real write in a shadow run.
    //
    // So the call is now recorded rather than refused, and it appears in the parity report where it
    // belongs.
    expect(recorded).toEqual([{ toolName: "publish_post", wouldRequireApproval: true }]);
    if (outcome.outcome === "result")
      expect(outcome.result).toMatchObject({ ok: true, data: { suppressed: true, reason: "shadow-mode" } });
  });
});

describe("failing closed", () => {
  it("refuses when the interaction named by a decision does not exist", async () => {
    const h = harness();
    await expect(
      h.interactions.claimApproval({ tenantId: T, interactionId: asId<InteractionId>("nope"), at: "t" }),
    ).rejects.toThrow();
  });

  /**
   * The tool is not reached — that has not changed and must not. What #162 changed is what happens *instead*.
   *
   * This used to raise a durable approval, on the reasoning that an unwired dependency is not permission. It
   * isn't, but an approval is the wrong refusal: a human would decide it, the run would resume, present the
   * one-time reference — and the registry would refuse again, because there is still no check to satisfy. That
   * is the loop #158 was filed for, and asking someone to authorize something that can never be authorized
   * teaches them their approval is theatre.
   *
   * So it is now a terminal error that names the missing wiring, and no approval is raised.
   */
  it("never reaches the tool when no approval gate is configured at all", async () => {
    const published: unknown[] = [];
    const authorization = allowAllAuthorization();
    const interactions = createMemoryInteractionStore();
    const idempotency = createMemoryIdempotencyStore();
    const tool = defineDelegatingTool<{ draftId: string }, { ok: true }>(
      { authorization, idempotency },
      {
        name: "publish_post",
        category: "publishing",
        effect: "external-write",
        description: "Publish a draft",
        delegatesTo: "shareflow:publishPost",
        delegate: (input) => {
          published.push(input);
          return { ok: true };
        },
      },
    );
    const registry = createToolRegistry({
      providers: [{ id: "t", async listTools() { return [tool as Tool]; } }],
      authorization,
      idempotency,
    });
    const service = createApprovalService({
      interactions,
      grants: createMemoryApprovalGrantStore(),
      dispatcher: { async enqueueRun() {} },
      clock: () => "t",
      idFactory: idFactory(),
    });
    const runApprovals = createRunApprovals({ interactions, approvals: service, tools: registry });

    const outcome = await runApprovals.runTool(ctx(), RUN, { name: "publish_post", input: { draftId: "d1" } });
    // The guarantee that matters, unchanged: an unwired dependency is not permission.
    expect(published).toEqual([]);
    // And nobody is asked to approve what cannot be approved.
    expect(outcome.outcome).toBe("result");
    if (outcome.outcome !== "result") throw new Error("expected a result");
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("expected a refusal");
    expect(outcome.result.error.code).toBe("capability_unavailable");
    expect(outcome.result.error.message).toContain("ToolRegistryConfig.approval");
    expect(await interactions.findPendingApproval({ tenantId: T, runId: RUN })).toBeNull();
  });
});
