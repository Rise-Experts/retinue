/**
 * Postgres `RunEventLog` — adapter-specific cases beyond the shared harness (#94).
 *
 * The harness proves the port contract. These are the things only a real database can be asked: does
 * the migration reverse, do the queries use the primary key, does every `RunEvent` variant survive
 * the jsonb round-trip, does an append inside a transaction disappear on rollback, and can two
 * connections race an append without producing a duplicate.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { MessageId, MessagePartId, RunId, TenantId, ToolCallId } from "../core/ids.js";
import type { RunEvent } from "../core/events.js";
import { createPostgresRunEventLog, migrate, rollback, type SqlExecutor } from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-log-t1");
const RUN = asId<RunId>("pg-log-r1");
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

const at = (sequence: number): RunEvent => ({
  type: "run.checkpointed",
  runId: RUN,
  sequence,
  occurredAt: "2020-01-01T00:00:00.000Z",
});

describe("run_events migration 0003", () => {
  it("creates the table keyed on (tenant_id, run_id, sequence)", async () => {
    const sql = await migrated();
    const pk = await sql.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'run_events' AND tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    expect(pk.map((r) => r.column_name)).toEqual(["tenant_id", "run_id", "sequence"]);
  });

  it("migrates up, rolls back, and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    await sql.query("SELECT 1 FROM run_events LIMIT 1");
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM run_events LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM run_events LIMIT 1");
  });

  it("rejects a non-positive sequence at the database", async () => {
    const sql = await migrated();
    // Sequences are 1-based; 0 is the cursor a fresh client sends, never a stored event.
    await expect(
      sql.query(
        `INSERT INTO run_events (tenant_id, run_id, sequence, type, event)
         VALUES ($1, $2, 0, 'run.started', '{}'::jsonb)`,
        [T1, RUN],
      ),
    ).rejects.toThrow();
  });
});

describe("run_events jsonb round-trip", () => {
  /**
   * Every variant that carries fields beyond `EventBase`. A jsonb column will happily store a
   * partially-mapped event and only fail much later, in a client's stream — so each shape is asserted
   * here rather than assumed from the one lifecycle event the harness uses.
   */
  const variants: readonly RunEvent[] = [
    { type: "run.started", runId: RUN, sequence: 1, occurredAt: "2020-01-01T00:00:01.000Z" },
    {
      type: "run.failed",
      runId: RUN,
      sequence: 2,
      occurredAt: "2020-01-01T00:00:02.000Z",
      error: { code: "internal", message: "boom", retryable: false },
    },
    {
      type: "run.retry-pending",
      runId: RUN,
      sequence: 3,
      occurredAt: "2020-01-01T00:00:03.000Z",
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: "2020-01-01T00:00:06.000Z",
      error: { code: "rate_limited", message: "slow down", retryable: true },
    },
    {
      type: "part.added",
      runId: RUN,
      sequence: 4,
      occurredAt: "2020-01-01T00:00:04.000Z",
      messageId: asId<MessageId>("m1"),
      part: {
        id: asId<MessagePartId>("p1"),
        type: "text",
        schemaVersion: 1,
        createdAt: "2020-01-01T00:00:04.000Z",
        text: "hello",
      },
    },
    {
      type: "tool.started",
      runId: RUN,
      sequence: 5,
      occurredAt: "2020-01-01T00:00:05.000Z",
      toolCallId: asId<ToolCallId>("tc1"),
      toolName: "search_web",
    },
  ];

  it("stores and returns every variant unchanged", async () => {
    const log = createPostgresRunEventLog(await migrated());
    for (const event of variants) await log.append({ tenantId: T1, event });
    const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
    expect(all).toHaveLength(variants.length);
    // Deep equality: a dropped nested field (an error's `retryable`, a part's `schemaVersion`) is
    // exactly the kind of loss that survives a shallower assertion.
    expect(all).toEqual(variants);
  });

  it("surfaces a corrupt row as a typed validation error, not a malformed event", async () => {
    const sql = await migrated();
    const log = createPostgresRunEventLog(sql);
    await sql.query(
      `INSERT INTO run_events (tenant_id, run_id, sequence, type, event)
       VALUES ($1, $2, 1, 'run.started', '{"nonsense": true}'::jsonb)`,
      [T1, RUN],
    );
    await expect(log.listAfter({ tenantId: T1, runId: RUN, after: 0 })).rejects.toThrow();
  });
});

describe("run_events index usage (EXPLAIN)", () => {
  it("serves catch-up as a primary-key range scan", async () => {
    const sql = await migrated();
    const log = createPostgresRunEventLog(sql);
    for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: at(s) });
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT event FROM run_events
        WHERE tenant_id = $1 AND run_id = $2 AND sequence > $3 ORDER BY sequence`,
      [T1, RUN, 1],
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    // A sequential scan here would make every reconnect O(events in the table).
    expect(text).toMatch(/Index (Only )?Scan/);
    expect(text).not.toContain("Seq Scan");
  });

  it("serves latestSequence from the index rather than a full scan", async () => {
    const sql = await migrated();
    const log = createPostgresRunEventLog(sql);
    for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: at(s) });
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT COALESCE(MAX(sequence), 0) FROM run_events WHERE tenant_id = $1 AND run_id = $2`,
      [T1, RUN],
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).not.toContain("Seq Scan");
  });
});

/**
 * AC-3. `append` needs no transaction machinery of its own: it uses whatever executor it is handed,
 * so a transaction-scoped executor puts the write in that transaction. That is what lets `emit()`
 * write the event *before* the checkpoint and have both commit together — the ordering the C1
 * recovery fix depends on. Proven rather than asserted.
 */
describe("append inside the caller's transaction", () => {
  it("leaves no event behind when the transaction rolls back", async () => {
    const { db, sql } = await freshPgliteSchema();
    const log = createPostgresRunEventLog(sql);

    await db.query("BEGIN");
    await log.append({ tenantId: T1, event: at(1) });
    // Visible inside the transaction…
    expect(await log.listAfter({ tenantId: T1, runId: RUN, after: 0 })).toHaveLength(1);
    await db.query("ROLLBACK");

    // …and gone after it aborts. A store that opened its own connection would have committed here.
    expect(await log.listAfter({ tenantId: T1, runId: RUN, after: 0 })).toHaveLength(0);
    expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(0);
  });

  it("commits the event when the transaction commits", async () => {
    const { db, sql } = await freshPgliteSchema();
    const log = createPostgresRunEventLog(sql);

    await db.query("BEGIN");
    await log.append({ tenantId: T1, event: at(1) });
    await db.query("COMMIT");

    expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(1);
  });
});

/**
 * AC-5, the recovery contract. `emit()` writes the event before the checkpoint, so after a crash the
 * log head is ahead of the checkpoint — and the difference is exactly what reconciliation must
 * replay. The store's job is for that head to be exact.
 */
describe("recovery contract", () => {
  it("reports a head ahead of the last checkpoint after an append-then-crash", async () => {
    const sql = await migrated();
    const log = createPostgresRunEventLog(sql);
    for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: at(s) });
    // Simulate: checkpoint recorded sequence 2, then the worker died after emitting 3.
    const checkpointedAt = 2;
    expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(3);
    const unreconciled = await log.listAfter({ tenantId: T1, runId: RUN, after: checkpointedAt });
    expect(unreconciled.map((e) => e.sequence)).toEqual([3]);
  });

  it("re-emitting during recovery does not duplicate history", async () => {
    const sql = await migrated();
    const log = createPostgresRunEventLog(sql);
    for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: at(s) });
    // A recovered worker replays from its checkpoint, re-emitting 3. Must be a no-op.
    await log.append({ tenantId: T1, event: at(3) });
    const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
    expect(all.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});

/**
 * The property the harness cannot prove: it appends through one executor, so its ordering results
 * follow from JavaScript being single-threaded. Server-only — PGlite is a single embedded instance.
 */
describe("concurrent append across two connections", () => {
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
    it("[skipped: RETINUE_TEST_PG_URL unset — PGlite is one embedded instance, so a two-connection race here would be meaningless]", () => {
      // A named passing test rather than it.skip: a silent skip reads as coverage.
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("appending the same sequence from two connections yields exactly one row, no error", async () => {
      const schema = "conf_log_race";
      const setup = await serverExecutor("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);
      const a = await serverExecutor(schema);
      const b = await serverExecutor(schema);
      await migrate(a);

      const logA = createPostgresRunEventLog(a);
      const logB = createPostgresRunEventLog(b);
      // Both must resolve: ON CONFLICT DO NOTHING means the loser is a no-op, not a failure.
      await Promise.all([
        logA.append({ tenantId: T1, event: at(7) }),
        logB.append({ tenantId: T1, event: at(7) }),
      ]);

      const all = await logA.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([7]);
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });

    it("appending different sequences from two connections lands both", async () => {
      const schema = "conf_log_race2";
      const setup = await serverExecutor("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);
      const a = await serverExecutor(schema);
      const b = await serverExecutor(schema);
      await migrate(a);

      const logA = createPostgresRunEventLog(a);
      const logB = createPostgresRunEventLog(b);
      await Promise.all([
        logA.append({ tenantId: T1, event: at(1) }),
        logB.append({ tenantId: T1, event: at(2) }),
      ]);

      const all = await logA.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([1, 2]);
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
