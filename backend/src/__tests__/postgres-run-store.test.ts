/**
 * Postgres `RunStore` — adapter-specific cases beyond the shared harness (#93).
 *
 * `postgres-conformance.test.ts` proves the store satisfies the port contract. These are the things
 * only a real database can be asked: does the migration reverse cleanly, do the queries actually use
 * their indexes, does the status constraint hold, and — the one that matters most — can two separate
 * connections both claim the same run?
 *
 * That last one is server-only. PGlite is a single embedded instance, so "two connections" against it
 * are not concurrent in any meaningful sense; a passing PGlite test would be theatre. It runs for
 * real against `RETINUE_TEST_PG_URL` in CI and reports why it was skipped otherwise.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../core/ids.js";
import { createPostgresRunStore, migrate, rollback, type SqlExecutor } from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-run-t1");
const CONVO = asId<ConversationId>("pg-run-c1");
const AGENT = asId<AgentId>("pg-run-a1");
const PG_URL = process.env["RETINUE_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const migrated = async (): Promise<SqlExecutor> => {
  const { sql } = await freshPgliteSchema();
  return sql;
};

const seed = (sql: SqlExecutor, id: string) =>
  createPostgresRunStore(sql).create({
    tenantId: T1,
    id: asId<RunId>(id),
    conversationId: CONVO,
    agentId: AGENT,
    agentVersion: 1,
  });

describe("runs migration 0002", () => {
  it("creates the table with the columns the Run type needs", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'runs' AND table_schema = current_schema()`,
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(
      [
        "agent_id",
        "agent_version",
        "cancel_requested_at",
        "claimed_by",
        "conversation_id",
        "created_at",
        "error",
        "finished_at",
        "id",
        "keepalive_at",
        "lease_expires_at",
        // Who the run is for — #164. Until these existed, a durable worker had nothing to rebuild the caller's
        // identity from and every host invented one.
        "principal_id",
        "role_ids",
        "started_at",
        "status",
        "tenant_id",
      ].sort(),
    );
    // agent_version is required by NewRun; the SPEC's original column list omitted it entirely.
    expect(cols.find((c) => c.column_name === "agent_version")?.is_nullable).toBe("NO");
    /**
     * Nullable, deliberately — #164.
     *
     * Rows written before the column existed have no answer, and a `NOT NULL DEFAULT 'something'` would put the
     * invented identity in the schema, which is the same bug one layer down and much harder to see. A run with
     * no principal is refused at `buildContext` instead.
     */
    expect(cols.find((c) => c.column_name === "principal_id")?.is_nullable).toBe("YES");
    expect(cols.find((c) => c.column_name === "role_ids")?.is_nullable).toBe("YES");
  });

  it("migrates up, rolls back (table and indexes gone), and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    await sql.query("SELECT 1 FROM runs LIMIT 1");
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM runs LIMIT 1")).rejects.toThrow();
    const idx = await sql.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'runs' AND schemaname = current_schema()`,
    );
    expect(idx).toHaveLength(0);
    await migrate(sql); // reversible: up again works
    await sql.query("SELECT 1 FROM runs LIMIT 1");
  });

  it("rejects a status outside RUN_STATUSES", async () => {
    const sql = await migrated();
    await seed(sql, "r1");
    // The GraphQL enum spells these with underscores; the constraint uses the hyphenated domain
    // values the store persists, so the underscored form must be rejected.
    await expect(
      sql.query(`UPDATE runs SET status = 'waiting_for_question' WHERE tenant_id = $1 AND id = 'r1'`, [T1]),
    ).rejects.toThrow();
  });

  it("accepts every value in RUN_STATUSES", async () => {
    const sql = await migrated();
    await seed(sql, "r1");
    for (const status of [
      "queued",
      "running",
      "waiting-for-question",
      "waiting-for-approval",
      "retry-pending",
      "completed",
      "failed",
      "cancelled",
    ]) {
      await sql.query(`UPDATE runs SET status = $2 WHERE tenant_id = $1 AND id = 'r1'`, [T1, status]);
    }
  });
});

describe("runs index usage (EXPLAIN)", () => {
  it("serves the conversation-history query from its index", async () => {
    const sql = await migrated();
    await seed(sql, "r1");
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT * FROM runs WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at, id`,
      [T1, CONVO],
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    // A sequential scan here would mean the history query degrades as runs accumulate.
    expect(text).toContain("runs_tenant_conversation_created_idx");
  });

  it("serves the reaper sweep from the partial lease index", async () => {
    const sql = await migrated();
    await seed(sql, "r1");
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT * FROM runs
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
        ORDER BY lease_expires_at LIMIT 10`,
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).toContain("runs_running_lease_idx");
  });
});

/**
 * The property that actually matters, and the one the shared harness cannot prove: the harness fires
 * both claims through a single executor, so its "exactly one winner" result follows from JavaScript
 * being single-threaded rather than from the database adjudicating.
 */
describe("concurrent claim across two connections", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  const serverExecutor = async (schema: string): Promise<SqlExecutor> => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    closers.push(async () => {
      await pool.end().catch(() => undefined);
    });
    return {
      async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
        const c = await pool.connect();
        try {
          await c.query(`SET search_path TO ${schema}`);
          const r = await c.query(text, params ? [...params] : undefined);
          return r.rows as Row[];
        } finally {
          c.release();
        }
      },
    };
  };

  if (!PG_URL) {
    it("[skipped: RETINUE_TEST_PG_URL unset — PGlite is one embedded instance, so a two-connection test here would be meaningless]", () => {
      // Deliberately a passing, named test rather than it.skip: a silent skip reads as coverage.
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("admits exactly one winner when two connections claim the same queued run", async () => {
      const schema = "conf_claim_race";
      const setup = await serverExecutor("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);

      const a = await serverExecutor(schema);
      const b = await serverExecutor(schema);
      await migrate(a);
      await seed(a, "race");

      const now = new Date().toISOString();
      const storeA = createPostgresRunStore(a);
      const storeB = createPostgresRunStore(b);
      const [ra, rb] = await Promise.all([
        storeA.claim({ tenantId: T1, id: asId<RunId>("race"), workerId: "wA", leaseMs: 60_000, now }),
        storeB.claim({ tenantId: T1, id: asId<RunId>("race"), workerId: "wB", leaseMs: 60_000, now }),
      ]);

      const winners = [ra, rb].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      // And the row agrees with whoever won — no torn state.
      const persisted = await storeA.findById({ tenantId: T1, id: asId<RunId>("race") });
      expect(persisted?.claimedBy).toBe(winners[0]?.claimedBy);
      expect(persisted?.status).toBe("running");

      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
