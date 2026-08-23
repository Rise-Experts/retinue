/**
 * Postgres `InteractionStore` / `ApprovalGrantStore` — adapter-specific cases (#99).
 *
 * The one that matters most is **AC-2**: a replayed approval must not be able to authorise the same
 * side effect twice. That guarantee is a unique index, and an index can only be trusted if something
 * proves it rejects. The SPEC placed it on `approval_grants`, where `idempotency_key` does not exist,
 * which would have left the property unenforced while looking implemented — so this file asserts it
 * on the table that actually has the column.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { AgentId, ApprovalGrantId, ConversationId, InteractionId, RunId, TenantId } from "../core/ids.js";
import type { PendingApproval, PendingQuestion } from "../hitl/index.js";
import {
  createPostgresApprovalGrantStore,
  createPostgresInteractionStore,
  createPostgresRunStore,
  createPostgresConversationStore,
  createPoolOpener,
  createTransactionScope,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-hitl-t1");
const C1 = asId<ConversationId>("pg-hitl-c1");
const RUN = asId<RunId>("pg-hitl-run1");
const AGENT = asId<AgentId>("pg-hitl-agent");
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PG_URL = process.env["AGENTKIT_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const question = (id: string): PendingQuestion => ({
  id: asId<InteractionId>(id),
  tenantId: T1,
  runId: RUN,
  questions: [{ key: "channel", prompt: "Which channel?", options: ["linkedin", "meta"] }],
  createdAt: NOW,
});

const approval = (id: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: asId<InteractionId>(id),
  tenantId: T1,
  runId: RUN,
  toolName: "publish_post",
  normalizedInput: { draftId: "d1" },
  riskCategory: "external-write",
  summary: "Publish draft d1 to LinkedIn",
  expiresAt: LATER,
  idempotencyKey: "idem-1",
  ...over,
});

/** A migrated PGlite database with the run the interaction foreign keys require. */
const seeded = async (): Promise<{ db: PGlite; sql: SqlExecutor }> => {
  const { db, sql } = await freshPgliteSchema();
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "thread" });
  await createPostgresRunStore(sql).create({
    tenantId: T1,
    id: RUN,
    conversationId: C1,
    agentId: AGENT,
    agentVersion: 1,
  });
  return { db, sql };
};

describe("migration 0008", () => {
  it("migrates up, rolls back, and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    for (const t of ["interaction_questions", "interaction_approvals", "approval_grants"]) {
      await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    }
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM approval_grants LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM approval_grants LIMIT 1");
  });

  it("carries no conversation_id or status column on either interaction table", async () => {
    const { sql } = await seeded();
    const cols = await sql.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('interaction_questions', 'interaction_approvals') AND table_schema = current_schema()`,
    );
    const names = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    // The SPEC proposed both. Neither PendingQuestion nor PendingApproval carries a conversation id,
    // and "pending" is `answered_at IS NULL` / `decided_at IS NULL` — a stored status would be a
    // second source of truth for one fact, and it would fail silently.
    for (const t of ["interaction_questions", "interaction_approvals"]) {
      expect(names.has(`${t}.conversation_id`)).toBe(false);
      expect(names.has(`${t}.status`)).toBe(false);
      expect(names.has(`${t}.run_id`)).toBe(true);
    }
  });

  it("keeps the idempotency key on approvals, where the field actually lives", async () => {
    const { sql } = await seeded();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'approval_grants' AND table_schema = current_schema()`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    // ApprovalGrant has none of these. The SPEC listed them all; a grant is a standing permission,
    // not a decision record — the decision lives on the approval.
    for (const absent of ["idempotency_key", "run_id", "effect", "request", "decision", "decided_by"]) {
      expect(names.has(absent), `approval_grants should not have ${absent}`).toBe(false);
    }
    expect(names.has("scope")).toBe(true);
    expect(names.has("tool_name_or_category")).toBe(true);
  });

  it("rejects a half-written resolution on both tables", async () => {
    const { sql } = await seeded();
    // answered_at without answers would read as answered while carrying no answer, and the resuming
    // run would execute on nothing.
    await expect(
      sql.query(
        `INSERT INTO interaction_questions (tenant_id, id, run_id, questions, created_at, answered_at)
         VALUES ($1, 'q-bad', $2, '[]'::jsonb, now(), now())`,
        [T1, RUN],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `INSERT INTO interaction_approvals
           (tenant_id, id, run_id, tool_name, normalized_input, risk_category, summary,
            expires_at, idempotency_key, decided_at)
         VALUES ($1, 'a-bad', $2, 't', '{}'::jsonb, 'r', 's', now(), 'k-bad', now())`,
        [T1, RUN],
      ),
    ).rejects.toThrow();
  });

  it("rejects a decision outside APPROVAL_DECISIONS and a scope outside ApprovalScope", async () => {
    const { sql } = await seeded();
    await expect(
      sql.query(
        `INSERT INTO interaction_approvals
           (tenant_id, id, run_id, tool_name, normalized_input, risk_category, summary,
            expires_at, idempotency_key, decided_at, decision)
         VALUES ($1, 'a-enum', $2, 't', '{}'::jsonb, 'r', 's', now(), 'k-enum', now(), 'maybe')`,
        [T1, RUN],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `INSERT INTO approval_grants (tenant_id, id, scope, tool_name_or_category, granted_at)
         VALUES ($1, 'g-enum', 'galaxy', 't', now())`,
        [T1],
      ),
    ).rejects.toThrow();
  });

  it("refuses a conversation-scoped grant with no conversation", async () => {
    const { sql } = await seeded();
    // Such a row could match nothing at best; at worst a query that forgot the scope check would
    // treat it as tenant-wide, turning a one-conversation approval into a standing one.
    await expect(
      sql.query(
        `INSERT INTO approval_grants (tenant_id, id, scope, tool_name_or_category, granted_at)
         VALUES ($1, 'g-noconv', 'conversation', 't', now())`,
        [T1],
      ),
    ).rejects.toThrow();
  });

  it("removes interactions with their run, and serves both pending lookups from an index", async () => {
    const { sql } = await seeded();
    const store = createPostgresInteractionStore(sql);
    await store.createQuestion({ tenantId: T1, question: question("q1") });
    await store.createApproval({ tenantId: T1, approval: approval("a1") });

    for (const [table, column] of [
      ["interaction_questions", "answered_at"],
      ["interaction_approvals", "decided_at"],
    ] as const) {
      const plan = await sql.query<Record<string, string>>(
        `EXPLAIN SELECT 1 FROM ${table} WHERE tenant_id = $1 AND run_id = $2 AND ${column} IS NULL`,
        [T1, RUN],
      );
      expect(plan.map((row) => Object.values(row)[0]).join("\n")).not.toContain("Seq Scan");
    }

    await sql.query(`DELETE FROM runs WHERE tenant_id = $1 AND id = $2`, [T1, RUN]);
    expect(await store.findPendingQuestion({ tenantId: T1, runId: RUN })).toBeNull();
    expect(await store.findPendingApproval({ tenantId: T1, runId: RUN })).toBeNull();
  });
});

/**
 * AC-1 and AC-3. "Survives a restart" means the row is in the database, not in the object — so the
 * assertion has to come from a *different store instance* over the same data. A test that reused the
 * same store would pass even for a pure in-memory implementation.
 */
describe("durability across a new store instance", () => {
  it("a pending approval is still pending and still decidable", async () => {
    const { sql } = await seeded();
    await createPostgresInteractionStore(sql).createApproval({ tenantId: T1, approval: approval("a1") });

    const reopened = createPostgresInteractionStore(sql);
    expect(await reopened.findPendingApproval({ tenantId: T1, runId: RUN })).toMatchObject({
      id: "a1",
      // The stored input must survive verbatim: resumption executes this, never a model-regenerated
      // version, so a lossy round-trip here would publish something nobody approved.
      normalizedInput: { draftId: "d1" },
    });
    const decided = await reopened.decideApproval({
      tenantId: T1,
      interactionId: asId<InteractionId>("a1"),
      decision: "allow-once",
      at: LATER,
    });
    expect(decided.alreadyResolved).toBe(false);
    expect(decided.approval.decision).toBe("allow-once");
  });

  it("a pending question is still pending, and answering it clears the pending lookup", async () => {
    const { sql } = await seeded();
    await createPostgresInteractionStore(sql).createQuestion({ tenantId: T1, question: question("q1") });

    const reopened = createPostgresInteractionStore(sql);
    expect(await reopened.findPendingQuestion({ tenantId: T1, runId: RUN })).toMatchObject({ id: "q1" });
    await reopened.answerQuestion({
      tenantId: T1,
      interactionId: asId<InteractionId>("q1"),
      answers: { channel: "linkedin" },
      at: LATER,
    });
    // The store's half of AC-3. Actually resuming the run is `src/hitl/service.ts`, which this SPEC
    // does not touch — so that is not claimed here.
    expect(await reopened.findPendingQuestion({ tenantId: T1, runId: RUN })).toBeNull();
    const answered = await reopened.answerQuestion({
      tenantId: T1,
      interactionId: asId<InteractionId>("q1"),
      answers: { channel: "meta" },
      at: LATER,
    });
    expect(answered.alreadyResolved).toBe(true);
    expect(answered.question.answers).toEqual({ channel: "linkedin" });
  });

  it("records when a decision was made — but cannot record who", async () => {
    const { sql } = await seeded();
    const store = createPostgresInteractionStore(sql);
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    const decided = await store.decideApproval({
      tenantId: T1,
      interactionId: asId<InteractionId>("a1"),
      decision: "deny",
      at: LATER,
    });
    expect(decided.approval.decidedAt).toBe(LATER);

    // Half of AC-4, and the half that is missing is recorded here rather than papered over.
    // `PendingApproval` has no `decidedBy` and `decideApproval` takes no actor, so the "who" of the
    // audit trail cannot be stored. A nullable decided_by column would always be NULL — an audit
    // column that reads as an audit trail while holding nothing. See the open question on #99.
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'interaction_approvals' AND table_schema = current_schema()`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain("decided_by");
  });
});

/** AC-2 — the replay guarantee, and the reason it is a database constraint rather than a check. */
describe("idempotency key uniqueness", () => {
  it("rejects a second approval reusing the same key", async () => {
    const { sql } = await seeded();
    const store = createPostgresInteractionStore(sql);
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    // Same key, different id: a replayed request that got a fresh interaction id. Without the unique
    // index this would create a second authorisation for one side effect — the duplicate publish.
    await expect(
      store.createApproval({ tenantId: T1, approval: approval("a2", { idempotencyKey: "idem-1" }) }),
    ).rejects.toThrow();
    const rows = await sql.query(`SELECT 1 FROM interaction_approvals WHERE tenant_id = $1`, [T1]);
    expect(rows).toHaveLength(1);
  });

  it("scopes the key per tenant, so two tenants may use the same key", async () => {
    const { sql } = await seeded();
    const T2 = asId<TenantId>("pg-hitl-t2");
    await createPostgresConversationStore(sql).create({ tenantId: T2, id: C1, title: "t2" });
    await createPostgresRunStore(sql).create({
      tenantId: T2,
      id: RUN,
      conversationId: C1,
      agentId: AGENT,
      agentVersion: 1,
    });
    const store = createPostgresInteractionStore(sql);
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    // The index is (tenant_id, idempotency_key). A global unique index would make one tenant's key
    // collide with another's — cross-tenant interference through an implementation detail.
    await store.createApproval({ tenantId: T2, approval: { ...approval("a1"), tenantId: T2 } });
    expect(await sql.query(`SELECT 1 FROM interaction_approvals`)).toHaveLength(2);
  });

  it("re-creating the same interaction id is a no-op, not a duplicate", async () => {
    const { sql } = await seeded();
    const store = createPostgresInteractionStore(sql);
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    // A retried create must not fail the caller: the row it wanted is already there.
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    expect(await sql.query(`SELECT 1 FROM interaction_approvals`)).toHaveLength(1);
  });
});

/** AC-5 — a denial is final. The failure this prevents is an approval that was denied being replayed
 * into a grant, which would authorise the exact action a human refused. */
describe("a denial is final", () => {
  it("refuses to become granted, and keeps the original decision", async () => {
    const { sql } = await seeded();
    const store = createPostgresInteractionStore(sql);
    await store.createApproval({ tenantId: T1, approval: approval("a1") });
    await store.decideApproval({
      tenantId: T1,
      interactionId: asId<InteractionId>("a1"),
      decision: "deny",
      at: LATER,
    });

    for (const attempt of ["allow-once", "allow-always", "allow-conversation"] as const) {
      const result = await store.decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("a1"),
        decision: attempt,
        at: "2020-01-03T00:00:00.000Z",
      });
      expect(result.alreadyResolved).toBe(true);
      expect(result.approval.decision).toBe("deny");
    }
    // And the timestamp is the original decision's, not the last attempt's.
    const rows = await sql.query<{ decided_at: string | Date }>(
      `SELECT decided_at FROM interaction_approvals WHERE tenant_id = $1 AND id = 'a1'`,
      [T1],
    );
    expect(new Date(rows[0]!.decided_at).toISOString()).toBe(LATER);
  });

  it("throws not_found for an interaction that does not exist", async () => {
    const { sql } = await seeded();
    await expect(
      createPostgresInteractionStore(sql).decideApproval({
        tenantId: T1,
        interactionId: asId<InteractionId>("nope"),
        decision: "deny",
        at: LATER,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("grant scoping in SQL", () => {
  it("prefers the newest grant when several are active", async () => {
    const { sql } = await seeded();
    const store = createPostgresApprovalGrantStore(sql);
    await store.grant({
      tenantId: T1,
      grant: {
        id: asId<ApprovalGrantId>("g-old"),
        tenantId: T1,
        scope: "tenant",
        toolNameOrCategory: "publish_post",
        grantedAt: NOW,
      },
    });
    await store.grant({
      tenantId: T1,
      grant: {
        id: asId<ApprovalGrantId>("g-new"),
        tenantId: T1,
        scope: "tenant",
        toolNameOrCategory: "publish_post",
        grantedAt: LATER,
      },
    });
    // Deterministic rather than "whichever the scan reached first", which is what the reference
    // adapter's Map iteration gives.
    expect(
      await store.findActive({ tenantId: T1, toolNameOrCategory: "publish_post", now: LATER }),
    ).toMatchObject({ id: "g-new" });
  });

  it("revoking twice is harmless and keeps the first revocation time", async () => {
    const { sql } = await seeded();
    const store = createPostgresApprovalGrantStore(sql);
    await store.grant({
      tenantId: T1,
      grant: {
        id: asId<ApprovalGrantId>("g1"),
        tenantId: T1,
        scope: "tenant",
        toolNameOrCategory: "publish_post",
        grantedAt: NOW,
      },
    });
    await store.revoke({ tenantId: T1, grantId: asId<ApprovalGrantId>("g1"), at: LATER });
    await store.revoke({ tenantId: T1, grantId: asId<ApprovalGrantId>("g1"), at: "2020-01-03T00:00:00.000Z" });
    const rows = await sql.query<{ revoked_at: string | Date }>(
      `SELECT revoked_at FROM approval_grants WHERE tenant_id = $1 AND id = 'g1'`,
      [T1],
    );
    expect(new Date(rows[0]!.revoked_at).toISOString()).toBe(LATER);
  });

  it("revoking a grant that does not exist is silent", async () => {
    const { sql } = await seeded();
    // Matching the reference adapter: revoking something absent has already achieved its purpose, and
    // throwing would make idempotent revocation impossible.
    await expect(
      createPostgresApprovalGrantStore(sql).revoke({
        tenantId: T1,
        grantId: asId<ApprovalGrantId>("ghost"),
        at: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Two connections deciding one approval at once. The harness proves idempotent resolution against a
 * single-threaded caller, where "exactly one wins" follows from JavaScript rather than from the
 * database — and a second `alreadyResolved: false` means the continuation is queued twice, which for
 * an approval means the guarded side effect runs twice.
 */
describe("concurrent decide across two connections", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  const serverSql = async (schema: string): Promise<SqlExecutor> => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    closers.push(async () => {
      await pool.end().catch(() => undefined);
    });
    const base: SqlExecutor = {
      async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
        const c = await pool.connect();
        try {
          await c.query(`SET search_path TO ${schema}`);
          const res = await c.query(text, params ? [...params] : undefined);
          return res.rows as Row[];
        } finally {
          c.release();
        }
      },
    };
    return createTransactionScope(createPoolOpener(pool, schema)).scoped(base);
  };

  if (!PG_URL) {
    it("[skipped: AGENTKIT_TEST_PG_URL unset — one embedded connection cannot express this race]", () => {
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("admits exactly one decider", async () => {
      const schema = "conf_hitl_race";
      const setup = await serverSql("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);
      const a = await serverSql(schema);
      const b = await serverSql(schema);
      await migrate(a);
      await createPostgresConversationStore(a).create({ tenantId: T1, id: C1, title: "race" });
      await createPostgresRunStore(a).create({
        tenantId: T1,
        id: RUN,
        conversationId: C1,
        agentId: AGENT,
        agentVersion: 1,
      });
      const storeA = createPostgresInteractionStore(a);
      const storeB = createPostgresInteractionStore(b);
      await storeA.createApproval({ tenantId: T1, approval: approval("a1") });

      // Warm B's pool. Without this it is still doing TCP setup and authentication while A's
      // sub-millisecond update commits, so the two never overlap and the test passes vacuously —
      // the exact trap #98's AC-1 test fell into.
      await b.query("SELECT 1");

      const [ra, rb] = await Promise.all([
        storeA.decideApproval({
          tenantId: T1,
          interactionId: asId<InteractionId>("a1"),
          decision: "allow-once",
          at: LATER,
        }),
        storeB.decideApproval({
          tenantId: T1,
          interactionId: asId<InteractionId>("a1"),
          decision: "deny",
          at: LATER,
        }),
      ]);

      expect([ra.alreadyResolved, rb.alreadyResolved].filter((x) => x === false)).toHaveLength(1);
      expect([ra.alreadyResolved, rb.alreadyResolved].filter((x) => x === true)).toHaveLength(1);
      // Both callers must be told the same outcome, or one of them acts on a decision that is not
      // the one of record.
      expect(ra.approval.decision).toBe(rb.approval.decision);

      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
