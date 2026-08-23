/**
 * In-memory HITL adapters — `docs/04` → Questions & Approvals. Durable pending questions/approvals
 * and standing approval grants for tests/dev. `answerQuestion`/`decideApproval` are idempotent so a
 * continuation is queued exactly once; grants respect revocation and expiry.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { ApprovalGrant, PendingApproval, PendingQuestion } from "../../hitl/index.js";
import type { ApprovalGrantStore, InteractionStore } from "../../persistence/index.js";

const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Interaction ${id} not found`, retryable: false });

export const createMemoryInteractionStore = (): InteractionStore => {
  const questions = new Map<string, Map<string, PendingQuestion>>(); // tenant -> id -> q
  const approvals = new Map<string, Map<string, PendingApproval>>();
  const qMap = (t: string) => {
    let m = questions.get(t);
    if (!m) questions.set(t, (m = new Map()));
    return m;
  };
  const aMap = (t: string) => {
    let m = approvals.get(t);
    if (!m) approvals.set(t, (m = new Map()));
    return m;
  };

  return {
    async createQuestion({ tenantId, question }) {
      qMap(tenantId).set(question.id, question);
    },
    async findPendingQuestion({ tenantId, runId }) {
      for (const q of qMap(tenantId).values()) if (q.runId === runId && q.answeredAt === undefined) return q;
      return null;
    },
    async answerQuestion({ tenantId, interactionId, answers, at }) {
      const q = qMap(tenantId).get(interactionId);
      if (!q) throw notFound(interactionId);
      if (q.answeredAt !== undefined) return { question: q, alreadyResolved: true };
      const answered: PendingQuestion = { ...q, answeredAt: at, answers };
      qMap(tenantId).set(interactionId, answered);
      return { question: answered, alreadyResolved: false };
    },

    async createApproval({ tenantId, approval }) {
      aMap(tenantId).set(approval.id, approval);
    },
    async findPendingApproval({ tenantId, runId }) {
      for (const a of aMap(tenantId).values()) if (a.runId === runId && a.decidedAt === undefined) return a;
      return null;
    },
    async decideApproval({ tenantId, interactionId, decision, at }) {
      const a = aMap(tenantId).get(interactionId);
      if (!a) throw notFound(interactionId);
      if (a.decidedAt !== undefined) return { approval: a, alreadyResolved: true };
      const decided: PendingApproval = { ...a, decidedAt: at, decision };
      aMap(tenantId).set(interactionId, decided);
      return { approval: decided, alreadyResolved: false };
    },

    async findApproval({ tenantId, interactionId }) {
      return aMap(tenantId).get(interactionId) ?? null;
    },
    async findDecidedApproval({ tenantId, runId }) {
      for (const a of aMap(tenantId).values())
        if (a.runId === runId && a.decidedAt !== undefined && a.consumedAt === undefined) return a;
      return null;
    },
    async claimApproval({ tenantId, interactionId, at }) {
      const a = aMap(tenantId).get(interactionId);
      if (!a) throw notFound(interactionId);
      // Undecided is refused, not deferred: an interaction nobody has decided must never become
      // permission just because something asked for it.
      if (a.decidedAt === undefined || a.consumedAt !== undefined) return { approval: a, claimed: false };
      const claimed: PendingApproval = { ...a, consumedAt: at };
      aMap(tenantId).set(interactionId, claimed);
      return { approval: claimed, claimed: true };
    },
  };
};

export const createMemoryApprovalGrantStore = (): ApprovalGrantStore => {
  const byTenant = new Map<string, Map<string, ApprovalGrant>>();
  const grants = (t: string) => {
    let m = byTenant.get(t);
    if (!m) byTenant.set(t, (m = new Map()));
    return m;
  };
  const active = (g: ApprovalGrant, now: string) =>
    g.revokedAt === undefined && (g.expiresAt === undefined || g.expiresAt > now);

  return {
    async grant({ tenantId, grant }) {
      grants(tenantId).set(grant.id, grant);
    },
    async findActive({ tenantId, toolNameOrCategory, now, conversationId }) {
      for (const g of grants(tenantId).values()) {
        if (!active(g, now) || g.toolNameOrCategory !== toolNameOrCategory) continue;
        // A conversation-scoped grant only applies within its own conversation.
        if (g.scope === "conversation" && g.conversationId !== conversationId) continue;
        return g;
      }
      return null;
    },
    async revoke({ tenantId, grantId, at }) {
      const g = grants(tenantId).get(grantId);
      if (g) grants(tenantId).set(g.id, { ...g, revokedAt: at });
    },
  };
};
