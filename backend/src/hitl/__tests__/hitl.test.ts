import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "../../core/context.js";
import { asId } from "../../core/ids.js";
import type { InteractionId, RunId, TenantId } from "../../core/ids.js";
import {
  createMemoryApprovalGrantStore,
  createMemoryInteractionStore,
} from "../../adapters/memory/index.js";
import type { JobDispatcher } from "../../runtime/index.js";
import { createApprovalGate, createApprovalService, createQuestionService } from "../index.js";

const T = asId<TenantId>("t1");
const RUN = asId<RunId>("run1");
const TOOL = { name: "publish", category: "publishing", approvalPolicy: "always" as const };

const ctx = (): ExecutionContext => ({
  tenantId: T,
  principalId: asId("p1"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req1"),
  runId: RUN,
});

const recordingDispatcher = () => {
  const enqueued: RunId[] = [];
  const dispatcher: JobDispatcher = { async enqueueRun({ runId }) { enqueued.push(runId); } };
  return { enqueued, dispatcher };
};

describe("questions — durable, resume once", () => {
  it("persists a pending question that survives a store handoff (restart)", async () => {
    const interactions = createMemoryInteractionStore();
    const { dispatcher } = recordingDispatcher();
    const svc = createQuestionService({ interactions, dispatcher, clock: () => "t", idFactory: () => "q1" });
    await svc.ask(ctx(), RUN, [{ key: "color", prompt: "Which color?", options: ["red", "blue"] }]);
    // A different service instance over the same store still finds the pending question.
    const found = await interactions.findPendingQuestion({ tenantId: T, runId: RUN });
    expect(found?.id).toBe("q1");
    expect(found?.answeredAt).toBeUndefined();
  });

  it("answering resumes exactly once — a duplicate answer does not re-enqueue", async () => {
    const interactions = createMemoryInteractionStore();
    const { enqueued, dispatcher } = recordingDispatcher();
    const svc = createQuestionService({ interactions, dispatcher, clock: () => "t", idFactory: () => "q1" });
    const q = await svc.ask(ctx(), RUN, [{ key: "color", prompt: "?" }]);
    const first = await svc.answer({ tenantId: T, interactionId: q.id, runId: RUN, answers: { color: "red" } });
    const second = await svc.answer({ tenantId: T, interactionId: q.id, runId: RUN, answers: { color: "blue" } });
    expect(first.resumed).toBe(true);
    expect(second.resumed).toBe(false); // idempotent — no duplicate continuation
    expect(enqueued).toEqual([RUN]); // enqueued exactly once
    const answered = await interactions.findPendingQuestion({ tenantId: T, runId: RUN });
    expect(answered).toBeNull(); // no longer pending
  });
});

describe("approvals — stored input, decisions, idempotent resume, unbypassable", () => {
  const req = {
    toolName: "publish",
    normalizedInput: { postId: "abc", channel: "twitter" },
    riskCategory: "external-share",
    summary: "Publish post abc to twitter",
    expiresAt: "2999-01-01T00:00:00.000Z",
    idempotencyKey: "idem-1",
  };

  it("stores the exact normalized tool + input for the resumed call to execute", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => "a1" });
    await svc.request(ctx(), RUN, req);
    const pending = await interactions.findPendingApproval({ tenantId: T, runId: RUN });
    // Resumption must use this stored input, not a regenerated one.
    expect(pending?.normalizedInput).toEqual({ postId: "abc", channel: "twitter" });
    expect(pending?.idempotencyKey).toBe("idem-1");
  });

  it("decides once and resumes once; a duplicate decision is a no-op", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { enqueued, dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const approval = await svc.request(ctx(), RUN, req);
    const first = await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });
    const second = await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "deny" });
    expect(first.resumed).toBe(true);
    expect(second.resumed).toBe(false);
    expect(enqueued).toEqual([RUN]);
  });

  it("allow-always issues a standing grant that the gate then honors", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const gate = createApprovalGate({ grants, clock: () => "t" });
    const tool = { name: "publish", category: "publishing", approvalPolicy: "always" as const };

    // Before any grant, the tool is gated (unbypassable).
    expect(await gate.isAllowed(ctx(), tool)).toBe(false);
    const approval = await svc.request(ctx(), RUN, req);
    await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-always" });
    // After allow-always, the gate honors the standing grant.
    expect(await gate.isAllowed(ctx(), tool)).toBe(true);
  });

  it("allow-conversation grants only within that conversation, not tenant-wide", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const gate = createApprovalGate({ grants, clock: () => "t" });
    const tool = { name: "publish", category: "publishing", approvalPolicy: "always" as const };
    const inConversation: ExecutionContext = { ...ctx(), conversationId: asId("conv-1") };
    const otherConversation: ExecutionContext = { ...ctx(), conversationId: asId("conv-2") };

    const approval = await svc.request(inConversation, RUN, req);
    await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, conversationId: asId("conv-1"), decision: "allow-conversation" });

    expect(await gate.isAllowed(inConversation, tool)).toBe(true); // same conversation → honored
    expect(await gate.isAllowed(otherConversation, tool)).toBe(false); // different conversation → still gated
  });

  it("the gate never gates a tool whose policy is 'never'", async () => {
    const gate = createApprovalGate({ grants: createMemoryApprovalGrantStore() });
    expect(await gate.isAllowed(ctx(), { name: "search", category: "read", approvalPolicy: "never" })).toBe(true);
  });

  it("allow-once issues no standing grant — the gate is no more open than before", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    const approval = await svc.request(ctx(), RUN, req);
    const decided = await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });

    expect(decided.grant).toBeUndefined();
    // A grant is standing by definition; a one-time decision must not become one.
    expect(await grants.findActive({ tenantId: T, toolNameOrCategory: "publish", now: "t" })).toBeNull();
    expect(await gate.isAllowed(ctx(), TOOL)).toBe(false);
  });
});

/**
 * The one-time authorization — how an `allow-once` decision reaches the gate without becoming
 * a grant. The ticket is the interaction id; the gate verifies it against what was stored rather than
 * trusting it, so a ticket is only ever worth the decision behind it.
 */
describe("approvals — one-time authorization", () => {
  const req = {
    toolName: "publish",
    normalizedInput: { postId: "abc", channel: "twitter" },
    riskCategory: "external-share",
    summary: "Publish post abc to twitter",
    expiresAt: "2999-01-01T00:00:00.000Z",
    idempotencyKey: "idem-1",
  };

  const wired = async (decision: "allow-once" | "deny" | null) => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const approval = await svc.request(ctx(), RUN, req);
    if (decision) {
      await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision });
      await interactions.claimApproval({ tenantId: T, interactionId: approval.id, at: "t" });
    }
    return { interactions, grants, approval };
  };

  it("satisfies the gate for the exact tool the human approved", async () => {
    const { interactions, grants, approval } = await wired("allow-once");
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: approval.id })).toBe(true);
  });

  it("refuses a ticket for an approval nobody decided", async () => {
    const { interactions, grants, approval } = await wired(null);
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: approval.id })).toBe(false);
  });

  it("refuses a ticket for a denied approval", async () => {
    const { interactions, grants, approval } = await wired("deny");
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: approval.id })).toBe(false);
  });

  it("refuses a ticket presented for a different tool than the one approved", async () => {
    const { interactions, grants, approval } = await wired("allow-once");
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    const otherTool = { name: "delete_everything", category: "publishing", approvalPolicy: "always" as const };
    expect(await gate.isAllowed(ctx(), otherTool, { interactionId: approval.id })).toBe(false);
  });

  it("refuses a ticket from another run", async () => {
    const { interactions, grants, approval } = await wired("allow-once");
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    const otherRun: ExecutionContext = { ...ctx(), runId: asId<RunId>("run2") };
    expect(await gate.isAllowed(otherRun, TOOL, { interactionId: approval.id })).toBe(false);
  });

  it("refuses a ticket the runtime never claimed", async () => {
    const interactions = createMemoryInteractionStore();
    const grants = createMemoryApprovalGrantStore();
    const { dispatcher } = recordingDispatcher();
    let n = 0;
    const svc = createApprovalService({ interactions, grants, dispatcher, clock: () => "t", idFactory: () => `id${(n += 1)}` });
    const approval = await svc.request(ctx(), RUN, req);
    await svc.decide({ tenantId: T, interactionId: approval.id, runId: RUN, decision: "allow-once" });
    // Decided but never claimed: the claim is the at-most-once counter, so without it there is no
    // execution to authorize.
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: approval.id })).toBe(false);
  });

  it("refuses every ticket when no interaction store is wired — an unwired dependency is not permission", async () => {
    const { approval, grants } = await wired("allow-once");
    const gate = createApprovalGate({ grants, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: approval.id })).toBe(false);
  });

  it("refuses a ticket naming an interaction that does not exist", async () => {
    const { interactions, grants } = await wired("allow-once");
    const gate = createApprovalGate({ grants, interactions, clock: () => "t" });
    expect(await gate.isAllowed(ctx(), TOOL, { interactionId: asId<InteractionId>("forged") })).toBe(false);
  });
});
