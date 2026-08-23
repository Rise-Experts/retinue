/**
 * PostgreSQL `InteractionStore` and `ApprovalGrantStore` (#99) — durable questions, approvals and
 * standing grants.
 *
 * Approvals gate every external write, so the two failure modes are asymmetric but both bad: a lost
 * approval blocks the work forever, and a *replayed* one authorises the same side effect twice — a
 * duplicate publish, a duplicate charge. The second is why `idempotency_key` carries a unique index
 * and why resolution is a compare-and-set rather than a read-then-write.
 *
 * **Resolution is guarded in the statement.** `UPDATE … WHERE answered_at IS NULL RETURNING *`: zero
 * rows means someone already resolved it, so the store reads back to distinguish "already resolved"
 * from "no such interaction". A read-then-write would let two concurrent answers both report
 * `alreadyResolved: false`, and the harness is explicit about what that costs — the continuation gets
 * queued twice.
 */
import { AgentPlatformError } from "../../core/errors.js";
import type { ApprovalGrantId, InteractionId, RunId, TenantId } from "../../core/ids.js";
import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalScope,
  PendingApproval,
  PendingQuestion,
} from "../../hitl/index.js";
import type { ApprovalGrantStore, InteractionStore } from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

const notFound = (id: string) =>
  new AgentPlatformError({ code: "not_found", message: `Interaction ${id} not found`, retryable: false });

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrUndefined = (v: string | Date | null): string | undefined => (v === null ? undefined : iso(v));

/** jsonb arrives parsed from PGlite and as text from some drivers; normalise both. */
const json = <T>(value: unknown): T => (typeof value === "string" ? (JSON.parse(value) as T) : (value as T));

// ---------------------------------------------------------------------------------- interactions

type QuestionRow = {
  tenant_id: string;
  id: string;
  run_id: string;
  questions: unknown;
  created_at: string | Date;
  answered_at: string | Date | null;
  answers: unknown;
};

const toQuestion = (r: QuestionRow): PendingQuestion => ({
  id: r.id as InteractionId,
  tenantId: r.tenant_id as TenantId,
  runId: r.run_id as RunId,
  questions: json<PendingQuestion["questions"]>(r.questions),
  createdAt: iso(r.created_at),
  // Spread-in rather than assigned: the type marks both optional, and writing `answeredAt: undefined`
  // would put the key in the object with an undefined value, which `toEqual` treats differently.
  ...(r.answered_at === null ? {} : { answeredAt: iso(r.answered_at) }),
  ...(r.answers === null || r.answers === undefined
    ? {}
    : { answers: json<Readonly<Record<string, string>>>(r.answers) }),
});

const QUESTION_COLUMNS = `tenant_id, id, run_id, questions, created_at, answered_at, answers`;

type ApprovalRow = {
  tenant_id: string;
  id: string;
  run_id: string;
  tool_name: string;
  normalized_input: unknown;
  risk_category: string;
  summary: string;
  estimated_cost_minor_units: number | null;
  expires_at: string | Date;
  idempotency_key: string;
  decided_at: string | Date | null;
  decision: string | null;
  consumed_at: string | Date | null;
};

const toApproval = (r: ApprovalRow): PendingApproval => ({
  id: r.id as InteractionId,
  tenantId: r.tenant_id as TenantId,
  runId: r.run_id as RunId,
  toolName: r.tool_name,
  normalizedInput: json<unknown>(r.normalized_input),
  riskCategory: r.risk_category,
  summary: r.summary,
  ...(r.estimated_cost_minor_units === null
    ? {}
    : { estimatedCostMinorUnits: r.estimated_cost_minor_units }),
  expiresAt: iso(r.expires_at),
  idempotencyKey: r.idempotency_key,
  ...(r.decided_at === null ? {} : { decidedAt: iso(r.decided_at) }),
  ...(r.decision === null ? {} : { decision: r.decision as ApprovalDecision }),
  ...(r.consumed_at === null ? {} : { consumedAt: iso(r.consumed_at) }),
});

const APPROVAL_COLUMNS = `tenant_id, id, run_id, tool_name, normalized_input, risk_category, summary,
         estimated_cost_minor_units, expires_at, idempotency_key, decided_at, decision, consumed_at`;

export const createPostgresInteractionStore = (sql: SqlExecutor): InteractionStore => {
  const readQuestion = async (tenantId: string, id: string): Promise<PendingQuestion | null> => {
    const rows = await sql.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM interaction_questions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toQuestion(row) : null;
  };

  const readApproval = async (tenantId: string, id: string): Promise<PendingApproval | null> => {
    const rows = await sql.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM interaction_approvals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toApproval(row) : null;
  };

  return {
    async createQuestion({ tenantId, question }) {
      await sql.query(
        `INSERT INTO interaction_questions (tenant_id, id, run_id, questions, created_at, answered_at, answers)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $7::jsonb)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          tenantId,
          question.id,
          question.runId,
          JSON.stringify(question.questions),
          question.createdAt,
          question.answeredAt ?? null,
          question.answers === undefined ? null : JSON.stringify(question.answers),
        ],
      );
    },

    async findPendingQuestion({ tenantId, runId }) {
      const rows = await sql.query<QuestionRow>(
        `SELECT ${QUESTION_COLUMNS} FROM interaction_questions
          WHERE tenant_id = $1 AND run_id = $2 AND answered_at IS NULL
          ORDER BY created_at, id
          LIMIT 1`,
        [tenantId, runId],
      );
      const row = rows[0];
      return row ? toQuestion(row) : null;
    },

    async answerQuestion({ tenantId, interactionId, answers, at }) {
      // The guard is `answered_at IS NULL`, so exactly one of two concurrent answers can win. The
      // loser gets zero rows and reports alreadyResolved, which is what keeps the continuation from
      // being queued twice.
      const rows = await sql.query<QuestionRow>(
        `UPDATE interaction_questions
            SET answered_at = $3::timestamptz, answers = $4::jsonb
          WHERE tenant_id = $1 AND id = $2 AND answered_at IS NULL
          RETURNING ${QUESTION_COLUMNS}`,
        [tenantId, interactionId, at, JSON.stringify(answers)],
      );
      const row = rows[0];
      if (row) return { question: toQuestion(row), alreadyResolved: false };

      const existing = await readQuestion(tenantId, interactionId);
      if (!existing) throw notFound(interactionId);
      return { question: existing, alreadyResolved: true };
    },

    async createApproval({ tenantId, approval }) {
      await sql.query(
        `INSERT INTO interaction_approvals
           (tenant_id, id, run_id, tool_name, normalized_input, risk_category, summary,
            estimated_cost_minor_units, expires_at, idempotency_key, decided_at, decision, consumed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz, $10, $11::timestamptz, $12,
                 $13::timestamptz)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          tenantId,
          approval.id,
          approval.runId,
          approval.toolName,
          JSON.stringify(approval.normalizedInput ?? null),
          approval.riskCategory,
          approval.summary,
          approval.estimatedCostMinorUnits ?? null,
          approval.expiresAt,
          approval.idempotencyKey,
          approval.decidedAt ?? null,
          approval.decision ?? null,
          approval.consumedAt ?? null,
        ],
      );
    },

    async findPendingApproval({ tenantId, runId }) {
      const rows = await sql.query<ApprovalRow>(
        `SELECT ${APPROVAL_COLUMNS} FROM interaction_approvals
          WHERE tenant_id = $1 AND run_id = $2 AND decided_at IS NULL
          ORDER BY expires_at, id
          LIMIT 1`,
        [tenantId, runId],
      );
      const row = rows[0];
      return row ? toApproval(row) : null;
    },

    async decideApproval({ tenantId, interactionId, decision, at }) {
      // AC-5 lives here: a denied approval can never become granted, because the second decision
      // matches no row and the store returns the stored one unchanged.
      const rows = await sql.query<ApprovalRow>(
        `UPDATE interaction_approvals
            SET decided_at = $3::timestamptz, decision = $4
          WHERE tenant_id = $1 AND id = $2 AND decided_at IS NULL
          RETURNING ${APPROVAL_COLUMNS}`,
        [tenantId, interactionId, at, decision],
      );
      const row = rows[0];
      if (row) return { approval: toApproval(row), alreadyResolved: false };

      const existing = await readApproval(tenantId, interactionId);
      if (!existing) throw notFound(interactionId);
      return { approval: existing, alreadyResolved: true };
    },

    async findApproval({ tenantId, interactionId }) {
      return readApproval(tenantId, interactionId);
    },

    async findDecidedApproval({ tenantId, runId }) {
      const rows = await sql.query<ApprovalRow>(
        `SELECT ${APPROVAL_COLUMNS} FROM interaction_approvals
          WHERE tenant_id = $1 AND run_id = $2 AND decided_at IS NOT NULL AND consumed_at IS NULL
          ORDER BY decided_at, id
          LIMIT 1`,
        [tenantId, runId],
      );
      const row = rows[0];
      return row ? toApproval(row) : null;
    },

    async claimApproval({ tenantId, interactionId, at }) {
      // The whole of `allow-once` is this WHERE clause. `consumed_at IS NULL` is what makes the claim
      // exclusive under concurrency, and `decided_at IS NOT NULL` is what stops an undecided
      // interaction from being claimable at all — an unwired dependency must never become permission.
      const rows = await sql.query<ApprovalRow>(
        `UPDATE interaction_approvals
            SET consumed_at = $3::timestamptz
          WHERE tenant_id = $1 AND id = $2 AND decided_at IS NOT NULL AND consumed_at IS NULL
          RETURNING ${APPROVAL_COLUMNS}`,
        [tenantId, interactionId, at],
      );
      const row = rows[0];
      if (row) return { approval: toApproval(row), claimed: true };

      const existing = await readApproval(tenantId, interactionId);
      if (!existing) throw notFound(interactionId);
      return { approval: existing, claimed: false };
    },
  };
};

// --------------------------------------------------------------------------------------- grants

type GrantRow = {
  tenant_id: string;
  id: string;
  scope: string;
  tool_name_or_category: string;
  conversation_id: string | null;
  granted_at: string | Date;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
};

const toGrant = (r: GrantRow): ApprovalGrant => ({
  id: r.id as ApprovalGrantId,
  tenantId: r.tenant_id as TenantId,
  scope: r.scope as ApprovalScope,
  toolNameOrCategory: r.tool_name_or_category,
  ...(r.conversation_id === null ? {} : { conversationId: r.conversation_id }),
  grantedAt: iso(r.granted_at),
  ...(isoOrUndefined(r.expires_at) === undefined ? {} : { expiresAt: iso(r.expires_at as string | Date) }),
  ...(isoOrUndefined(r.revoked_at) === undefined ? {} : { revokedAt: iso(r.revoked_at as string | Date) }),
});

const GRANT_COLUMNS = `tenant_id, id, scope, tool_name_or_category, conversation_id,
         granted_at, expires_at, revoked_at`;

export const createPostgresApprovalGrantStore = (sql: SqlExecutor): ApprovalGrantStore => ({
  async grant({ tenantId, grant }) {
    await sql.query(
      `INSERT INTO approval_grants
         (tenant_id, id, scope, tool_name_or_category, conversation_id, granted_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (tenant_id, id) DO UPDATE
          SET scope = excluded.scope,
              tool_name_or_category = excluded.tool_name_or_category,
              conversation_id = excluded.conversation_id,
              granted_at = excluded.granted_at,
              expires_at = excluded.expires_at,
              revoked_at = excluded.revoked_at`,
      [
        tenantId,
        grant.id,
        grant.scope,
        grant.toolNameOrCategory,
        grant.conversationId ?? null,
        grant.grantedAt,
        grant.expiresAt ?? null,
        grant.revokedAt ?? null,
      ],
    );
  },

  async findActive({ tenantId, toolNameOrCategory, now, conversationId }) {
    // The scope predicate is the safety-critical part. A conversation-scoped grant must match only
    // its own conversation and must not match at all when no conversation is supplied — otherwise a
    // one-conversation approval silently becomes a standing one. Expressed as SQL rather than
    // filtered afterwards so the index can serve it and no code path can skip it.
    const rows = await sql.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM approval_grants
        WHERE tenant_id = $1
          AND tool_name_or_category = $2
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $3::timestamptz)
          AND (scope <> 'conversation' OR ($4::text IS NOT NULL AND conversation_id = $4::text))
        ORDER BY granted_at DESC, id
        LIMIT 1`,
      [tenantId, toolNameOrCategory, now, conversationId ?? null],
    );
    const row = rows[0];
    return row ? toGrant(row) : null;
  },

  async revoke({ tenantId, grantId, at }) {
    // Silent on a missing grant, matching the reference adapter: revoking something that is not there
    // has already achieved its purpose, and throwing would make idempotent revocation impossible.
    await sql.query(
      `UPDATE approval_grants SET revoked_at = $3::timestamptz
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
      [tenantId, grantId, at],
    );
  },
});
