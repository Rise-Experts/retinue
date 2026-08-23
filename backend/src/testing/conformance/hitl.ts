/**
 * `InteractionStore`, `ApprovalGrantStore` and `UsageStore` conformance.
 *
 * The two properties here are the ones that would cost real money or cause a real duplicate
 * publish if an adapter got them wrong, so they are asserted rather than trusted:
 *
 *  - **Idempotent resolution** (`docs/04`): "the first call resolves the interaction and reports
 *    `alreadyResolved: false`; a duplicate reports `true` and changes nothing, so a continuation is
 *    queued exactly once." A store that reports `false` twice queues the continuation twice.
 *  - **Grant scoping** (`docs/04`): a `conversation`-scoped grant "never leaks to another
 *    conversation or tenant-wide". A store that ignores `conversationId` silently converts a
 *    one-conversation approval into a standing one.
 *  - **Append-only usage** (`docs/12`): events are never edited; appends are idempotent on
 *    `(runId, stepId)` so a recovered run never double-counts.
 *  - **The approval claim** (`docs/04` → How the loop closes): an approval's single execution is
 *    claimed exactly once, and only after a decision. This is where `allow-once` gets its "once" —
 *    it issues no grant, so an adapter that lost the claim would let one decision publish twice, and
 *    one that let an undecided interaction be claimed would create permission out of nothing.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type {
  ApprovalGrantId,
  ConversationId,
  InteractionId,
  RunId,
  TenantId,
} from "../../core/ids.js";
import type { ApprovalGrant, PendingApproval, PendingQuestion } from "../../hitl/index.js";
import type { ApprovalGrantStore, InteractionStore, UsageStore } from "../../persistence/index.js";
import type { UsageEvent } from "../../usage/index.js";
import { withRun, type FixtureOrStore } from "./parents.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const RUN = asId<RunId>("conf-run-1");
const C1 = "conf-convo-1";
const C2 = "conf-convo-2";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";

const question = (id: string): PendingQuestion => ({
  id: asId<InteractionId>(id),
  tenantId: T1,
  runId: RUN,
  questions: [{ key: "channel", prompt: "Which channel?", options: ["linkedin", "meta"] }],
  createdAt: NOW,
});

const approval = (id: string): PendingApproval => ({
  id: asId<InteractionId>(id),
  tenantId: T1,
  runId: RUN,
  toolName: "publish_post",
  normalizedInput: { draftId: "d1" },
  riskCategory: "external-write",
  summary: "Publish draft d1 to LinkedIn",
  expiresAt: LATER,
  idempotencyKey: "idem-1",
});

export function interactionStoreConformance(
  makeFixture: () => FixtureOrStore<InteractionStore>,
): void {
  // A question and an approval both belong to a run, and the Postgres schema enforces it with a
  // foreign key (#99) — an orphan approval would be an authorisation with nothing to authorise. The
  // in-memory adapter has no such constraint and passes no seeder; see ./parents.ts.
  const open = () => withRun(makeFixture(), [{ tenantId: T1, runId: RUN }]);

  describe("InteractionStore conformance", () => {
    it("finds a pending question by run", async () => {
      const store = await open();
      await store.createQuestion({ tenantId: T1, question: question("q1") });
      expect(await store.findPendingQuestion({ tenantId: T1, runId: RUN })).toMatchObject({ id: "q1" });
    });

    it("answering reports alreadyResolved false the first time", async () => {
      const store = await open();
      await store.createQuestion({ tenantId: T1, question: question("q1") });
      const first = await store.answerQuestion({
        tenantId: T1,
        interactionId: asId<InteractionId>("q1"),
        answers: { channel: "linkedin" },
        at: LATER,
      });
      expect(first.alreadyResolved).toBe(false);
    });

    it("a duplicate answer reports alreadyResolved true and changes nothing", async () => {
      const store = await open();
      await store.createQuestion({ tenantId: T1, question: question("q1") });
      await store.answerQuestion({
        tenantId: T1,
        interactionId: asId<InteractionId>("q1"),
        answers: { channel: "linkedin" },
        at: LATER,
      });
      const second = await store.answerQuestion({
        tenantId: T1,
        interactionId: asId<InteractionId>("q1"),
        answers: { channel: "meta" },
        at: LATER,
      });
      expect(second.alreadyResolved).toBe(true);
      // The stored answer must be the first one — a duplicate must not overwrite the decision.
      expect(second.question.answers).toEqual({ channel: "linkedin" });
    });

    it("an answered question is no longer pending", async () => {
      const store = await open();
      await store.createQuestion({ tenantId: T1, question: question("q1") });
      await store.answerQuestion({
        tenantId: T1,
        interactionId: asId<InteractionId>("q1"),
        answers: { channel: "linkedin" },
        at: LATER,
      });
      expect(await store.findPendingQuestion({ tenantId: T1, runId: RUN })).toBeNull();
    });

    it("finds a pending approval by run", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      expect(await store.findPendingApproval({ tenantId: T1, runId: RUN })).toMatchObject({
        id: "a1",
        toolName: "publish_post",
      });
    });

    it("deciding is idempotent — a duplicate decision cannot flip the outcome", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      const first = await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "deny",
        at: LATER,
      });
      expect(first.alreadyResolved).toBe(false);
      const second = await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "allow-once",
        at: LATER,
      });
      expect(second.alreadyResolved).toBe(true);
      expect(second.approval.decision).toBe("deny");
    });

    it("preserves the stored normalized input, so resumption never runs regenerated arguments", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      const pending = await store.findPendingApproval({ tenantId: T1, runId: RUN });
      expect(pending?.normalizedInput).toEqual({ draftId: "d1" });
    });

    /**
     * The resumption half of the loop. A decision that is recorded but that nothing can look
     * up again is a decision the run cannot act on — which is the state the platform was in: the
     * decision was stored, the run was re-enqueued, and the resumed run had no way to find the
     * approval whose stored input it was supposed to execute.
     */
    it("finds the decided approval a resumption must execute", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "allow-once",
        at: LATER,
      });
      expect(await store.findDecidedApproval({ tenantId: T1, runId: RUN })).toMatchObject({
        id: "a1",
        decision: "allow-once",
        normalizedInput: { draftId: "d1" },
      });
    });

    it("an undecided approval is not resumable", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      expect(await store.findDecidedApproval({ tenantId: T1, runId: RUN })).toBeNull();
    });

    /**
     * Where `allow-once` gets its "once" from. It is deliberately *not* a grant — a grant is standing
     * by definition — so the single execution has to be claimed from the interaction itself, and the
     * store is the only place that holds across processes. Two workers racing a resumed run must see
     * exactly one `claimed: true`.
     */
    it("claims the single execution an approval authorizes exactly once", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "allow-once",
        at: LATER,
      });
      const first = await store.claimApproval({ tenantId: T1, interactionId: asId<InteractionId>("a1"), at: LATER });
      const second = await store.claimApproval({ tenantId: T1, interactionId: asId<InteractionId>("a1"), at: LATER });
      expect(first.claimed).toBe(true);
      expect(second.claimed).toBe(false);
      expect(second.approval.consumedAt).toBe(first.approval.consumedAt);
    });

    it("refuses to claim an approval nobody has decided", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      const claim = await store.claimApproval({ tenantId: T1, interactionId: asId<InteractionId>("a1"), at: LATER });
      expect(claim.claimed).toBe(false);
      expect(claim.approval.consumedAt).toBeUndefined();
    });

    it("a claimed approval is no longer the run's resumable one", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "allow-once",
        at: LATER,
      });
      await store.claimApproval({ tenantId: T1, interactionId: asId<InteractionId>("a1"), at: LATER });
      expect(await store.findDecidedApproval({ tenantId: T1, runId: RUN })).toBeNull();
    });

    it("reads one approval back by id, so a one-time authorization can be verified", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      expect(await store.findApproval({ tenantId: T1, interactionId: asId<InteractionId>("a1") })).toMatchObject({
        id: "a1",
        toolName: "publish_post",
      });
      expect(await store.findApproval({ tenantId: T1, interactionId: asId<InteractionId>("nope") })).toBeNull();
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await store.createQuestion({ tenantId: T1, question: question("q1") });
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      expect(await store.findPendingQuestion({ tenantId: T2, runId: RUN })).toBeNull();
      expect(await store.findPendingApproval({ tenantId: T2, runId: RUN })).toBeNull();
    });

    it("isolates the resumption lookups by tenant too", async () => {
      const store = await open();
      await store.createApproval({ tenantId: T1, approval: approval("a1") });
      await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: "allow-once",
        at: LATER,
      });
      expect(await store.findDecidedApproval({ tenantId: T2, runId: RUN })).toBeNull();
      expect(await store.findApproval({ tenantId: T2, interactionId: asId<InteractionId>("a1") })).toBeNull();
    });
  });
}

export function approvalGrantStoreConformance(
  makeFixture: () => FixtureOrStore<ApprovalGrantStore>,
): void {
  // Grants are standing tenant-level permissions with no run and no required conversation row, so
  // there is no parent to seed — the fixture form is accepted only for symmetry with its sibling.
  const open = () => withRun(makeFixture(), []);
  const grant = (id: string, over: Partial<ApprovalGrant> = {}): ApprovalGrant => ({
    id: asId<ApprovalGrantId>(id),
    tenantId: T1,
    scope: "tenant",
    toolNameOrCategory: "publish_post",
    grantedAt: NOW,
    ...over,
  });

  describe("ApprovalGrantStore conformance", () => {
    it("returns null when no grant exists", async () => {
      expect(
        await (await open()).findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: NOW }),
      ).toBeNull();
    });

    it("finds an active tenant-wide grant", async () => {
      const store = await open();
      await store.grant({ tenantId: T1, grant: grant("g1") });
      expect(
        await store.findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: NOW }),
      ).toMatchObject({ id: "g1" });
    });

    it("a conversation-scoped grant matches only its own conversation", async () => {
      const store = await open();
      await store.grant({
        tenantId: T1,
        grant: grant("g1", { scope: "conversation", conversationId: C1 }),
      });
      expect(
        await store.findActive({
          tenantId: T1,
          toolNameOrCategory: "publish_post",
          now: NOW,
          conversationId: C1,
        }),
      ).toMatchObject({ id: "g1" });
      expect(
        await store.findActive({
          tenantId: T1,
          toolNameOrCategory: "publish_post",
          now: NOW,
          conversationId: C2,
        }),
      ).toBeNull();
    });

    it("a conversation-scoped grant never leaks tenant-wide when no conversation is supplied", async () => {
      const store = await open();
      await store.grant({
        tenantId: T1,
        grant: grant("g1", { scope: "conversation", conversationId: C1 }),
      });
      expect(
        await store.findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: NOW }),
      ).toBeNull();
    });

    it("an expired grant is not active", async () => {
      const store = await open();
      await store.grant({ tenantId: T1, grant: grant("g1", { expiresAt: NOW }) });
      expect(
        await store.findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: LATER }),
      ).toBeNull();
    });

    it("a revoked grant is not active", async () => {
      const store = await open();
      await store.grant({ tenantId: T1, grant: grant("g1") });
      await store.revoke({ tenantId: T1, grantId: asId<ApprovalGrantId>("g1"), at: NOW });
      expect(
        await store.findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: LATER }),
      ).toBeNull();
    });

    it("does not match a different tool", async () => {
      const store = await open();
      await store.grant({ tenantId: T1, grant: grant("g1") });
      expect(
        await store.findActive({ tenantId: T1, toolNameOrCategory: "delete_everything", now: NOW }),
      ).toBeNull();
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await store.grant({ tenantId: T1, grant: grant("g1") });
      expect(
        await store.findActive({ tenantId: T2, toolNameOrCategory: "publish_post", now: NOW }),
      ).toBeNull();
    });
  });
}

export function usageStoreConformance(
  makeFixture: () => FixtureOrStore<UsageStore>,
): void {
  // A usage record belongs to a run, and the Postgres schema enforces it (#100) — an orphan cost
  // record is a charge attributable to nothing. The harness uses two runs, so both are seeded.
  const open = () =>
    withRun(makeFixture(), [
      { tenantId: T1, runId: RUN },
      { tenantId: T1, runId: asId<RunId>("conf-run-2") },
    ]);
  const event = (id: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
    id,
    tenantId: T1,
    runId: RUN,
    conversationId: asId<ConversationId>(C1),
    stepId: "step-1",
    modelId: "claude-opus-5",
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 10,
    reasoningTokens: 5,
    costMinorUnits: 250,
    currency: "EUR",
    occurredAt: NOW,
    ...over,
  });

  describe("UsageStore conformance", () => {
    it("appends an event and lists it by run", async () => {
      const store = await open();
      await store.append({ tenantId: T1, event: event("u1") });
      const page = await store.listByRun({ tenantId: T1, runId: RUN, limit: 10 });
      expect(page.items).toHaveLength(1);
    });

    it("totals sum exactly, with integer minor units", async () => {
      const store = await open();
      await store.append({ tenantId: T1, event: event("u1") });
      await store.append({ tenantId: T1, event: event("u2", { stepId: "step-2" }) });
      const totals = await store.totals({ tenantId: T1, runId: RUN });
      expect(totals.inputTokens).toBe(200);
      expect(totals.outputTokens).toBe(100);
      expect(totals.costMinorUnits).toBe(500);
      expect(totals.eventCount).toBe(2);
      expect(Number.isInteger(totals.costMinorUnits)).toBe(true);
    });

    it("is idempotent on a repeated append, so a recovered run never double-counts", async () => {
      const store = await open();
      await store.append({ tenantId: T1, event: event("u1") });
      await store.append({ tenantId: T1, event: event("u1") });
      const totals = await store.totals({ tenantId: T1, runId: RUN });
      expect(totals.eventCount).toBe(1);
      expect(totals.costMinorUnits).toBe(250);
    });

    it("scopes totals to a run", async () => {
      const store = await open();
      const otherRun = asId<RunId>("conf-run-2");
      await store.append({ tenantId: T1, event: event("u1") });
      await store.append({ tenantId: T1, event: event("u2", { runId: otherRun }) });
      expect((await store.totals({ tenantId: T1, runId: RUN })).eventCount).toBe(1);
      expect((await store.totals({ tenantId: T1, runId: otherRun })).eventCount).toBe(1);
    });

    it("pages listByRun by stable cursor", async () => {
      const store = await open();
      for (const n of [1, 2, 3, 4, 5]) {
        await store.append({ tenantId: T1, event: event(`u${n}`, { stepId: `step-${n}` }) });
      }
      const first = await store.listByRun({ tenantId: T1, runId: RUN, limit: 2 });
      expect(first.items).toHaveLength(2);
      const second = await store.listByRun({
        tenantId: T1,
        runId: RUN,
        limit: 2,
        cursor: first.nextCursor,
      });
      const ids = new Set(first.items.map((e) => e.id));
      expect(second.items.some((e) => ids.has(e.id))).toBe(false);
    });

    it("enforces tenant isolation", async () => {
      const store = await open();
      await store.append({ tenantId: T1, event: event("u1") });
      expect((await store.listByRun({ tenantId: T2, runId: RUN, limit: 10 })).items).toHaveLength(0);
      expect((await store.totals({ tenantId: T2, runId: RUN })).eventCount).toBe(0);
    });
  });
}
