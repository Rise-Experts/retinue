import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_EVENT_RETENTION_DAYS, PRUNABLE_RUN_STATUSES, RUN_STATUSES, cutoffFor, drain, type RunEventPruner } from "../index.js";
import { MIGRATIONS, createPostgresConversationStore, createPostgresRunEventLog, createPostgresRunEventPruner, createPostgresRunStore, migrate, rollback, type SqlExecutor } from "../adapters/postgres/index.js";
import { asId } from "../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../core/ids.js";

/**
 * Retention for `run_events` — #151.
 *
 * PGlite for the logic; a real server for the two ACs an embedded single-connection database cannot express —
 * `EXPLAIN` on a table with enough rows to make an index the cheaper plan (AC-6), and appends racing a sweep on
 * a second connection (AC-5). Both are named-skipped rather than silently absent when the URL is unset.
 */

const T1 = asId<TenantId>("ret-t1");
const T2 = asId<TenantId>("ret-t2");
const C1 = asId<ConversationId>("ret-c1");
const AGENT = asId("ret-agent");
const PG_URL = process.env["RETINUE_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

/** A migrated database with a conversation, ready for runs. */
const seeded = async () => {
  const sql = pglite(new PGlite());
  await migrate(sql);
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "t" });
  await createPostgresConversationStore(sql).create({ tenantId: T2, id: C1, title: "t" });
  return sql;
};

/**
 * A run in a given status holding `count` events dated `daysAgo`.
 *
 * `created_at` is written directly rather than through the log's own `append`, because the whole subject is rows
 * that are *old* and the append path stamps `now()`. Backdating is the only way to test an age predicate without
 * waiting.
 */
const seedRun = async (
  sql: SqlExecutor,
  input: { readonly tenantId?: TenantId; readonly runId: string; readonly status: string; readonly daysAgo: number; readonly count: number },
): Promise<RunId> => {
  const tenantId = input.tenantId ?? T1;
  const runId = asId<RunId>(input.runId);
  await createPostgresRunStore(sql).create({ tenantId, id: runId, conversationId: C1, agentId: AGENT, agentVersion: 1 });
  await sql.query(`UPDATE runs SET status = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, runId, input.status]);
  for (let i = 1; i <= input.count; i += 1)
    await sql.query(
      `INSERT INTO run_events (tenant_id, run_id, sequence, type, event, created_at)
       VALUES ($1, $2, $3, 'part.added', $4::jsonb, $5::timestamptz)`,
      [tenantId, runId, i, JSON.stringify({ type: "part.added", runId, sequence: i, occurredAt: at(input.daysAgo) }), at(input.daysAgo)],
    );
  return runId;
};

const countEvents = async (sql: SqlExecutor, runId: string): Promise<number> => {
  const rows = await sql.query<{ n: string }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = $1`, [runId]);
  return Number(rows[0]?.n ?? 0);
};

describe("migration 0021", () => {
  it("migrates up, rolls back and re-migrates", async () => {
    const sql = pglite(new PGlite());
    await migrate(sql);
    const present = async () =>
      (await sql.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'run_events_created_at_idx'`))[0];
    expect(Number((await present())?.n)).toBe(1);
    await rollback(sql);
    await migrate(sql);
    expect(Number((await present())?.n)).toBe(1);
  });

  it("indexes created_at first, since that is the predicate the sweep drives on", () => {
    const migration = MIGRATIONS.find((m) => m.id === "0021_run_events_retention");
    expect(migration).toBeDefined();
    const create = (migration?.up ?? []).join("\n");
    // Leading column matters: `(tenant_id, created_at)` would not serve an age scan across tenants, which is
    // what a maintenance sweep is.
    expect(create).toMatch(/ON run_events \(created_at, tenant_id, run_id\)/);
  });

  it("drops its index on the way down, leaving no orphan", async () => {
    const sql = pglite(new PGlite());
    await migrate(sql);
    const migration = MIGRATIONS.find((m) => m.id === "0021_run_events_retention");
    // **This migration's own down statements**, not a full `rollback`. Rolling everything back drops the
    // `run_events` table and takes the index with it, so the test passed with the down replaced by `SELECT 1` —
    // it was asserting that dropping a table removes its indexes, which Postgres guarantees and nobody doubted.
    // Sabotage found it.
    for (const statement of migration?.down ?? []) await sql.query(statement);

    const indexes = await sql.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'run_events_created_at_idx'`,
    );
    expect(Number(indexes[0]?.n)).toBe(0);
    // And the table survives, which is what makes this a *reversible index* rather than a destructive down.
    await sql.query(`SELECT 1 FROM run_events LIMIT 1`);
  });
});

describe("pruning — AC-1", () => {
  it("removes events past the window and keeps events inside it", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "old", status: "completed", daysAgo: 120, count: 5 });
    await seedRun(sql, { runId: "recent", status: "completed", daysAgo: 3, count: 4 });
    const pruner = createPostgresRunEventPruner(sql);

    const result = await pruner.prune({ olderThan: cutoffFor({ now: NOW, retentionDays: 90 }), limit: 100 });

    expect(result.deleted).toBe(5);
    expect(await countEvents(sql, "old")).toBe(0);
    // The recent run is untouched — a sweep that took everything would pass a "deleted something" assertion.
    expect(await countEvents(sql, "recent")).toBe(4);
  });

  it("uses a strict cutoff, so an event exactly on the boundary survives", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "edge", status: "completed", daysAgo: 90, count: 2 });
    const pruner = createPostgresRunEventPruner(sql);
    // `< cutoff`, not `<=`. Either is defensible; what is not defensible is nobody knowing which, since a
    // retention promise of "90 days" is a claim about the boundary.
    const cutoff = cutoffFor({ now: NOW, retentionDays: 90 });
    // The seeded timestamp is asked for in a form that parses everywhere, rather than reformatting PGlite's
    // text output — `MIN(created_at)::text` renders as `2026-05-25 12:00:00+00`, and patching that into an ISO
    // string by hand is how a test starts asserting on a driver's formatting.
    const rows = await sql.query<{ c: string }>(
      `SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c
         FROM run_events WHERE run_id = 'edge'`,
    );
    // The fixture must sit *exactly* on the cutoff, or this proves nothing about the boundary.
    expect(rows[0]?.c).toBe(cutoff);
    expect((await pruner.prune({ olderThan: cutoff, limit: 100 })).deleted).toBe(0);
  });

  it("prunes across tenants, because a maintenance sweep has no tenant", async () => {
    const sql = await seeded();
    await seedRun(sql, { tenantId: T1, runId: "t1-old", status: "completed", daysAgo: 200, count: 3 });
    await seedRun(sql, { tenantId: T2, runId: "t2-old", status: "completed", daysAgo: 200, count: 2 });
    const result = await createPostgresRunEventPruner(sql).prune({
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 100,
    });
    // Deliberate: a per-tenant sweep would need a tenant list nobody maintains, and the tables it protects are
    // the platform's storage rather than one tenant's quota.
    expect(result.deleted).toBe(5);
  });
});

describe("the safety predicate — AC-2", () => {
  /** The criterion's own test: a running run holding old events. */
  it("never prunes a running run's events, however old", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "live", status: "running", daysAgo: 400, count: 6 });
    const result = await createPostgresRunEventPruner(sql).prune({
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 100,
    });
    // Deleting these breaks crash recovery for a run that is still alive — the guarantee #93/#94 exist to give.
    expect(result.deleted).toBe(0);
    expect(await countEvents(sql, "live")).toBe(6);
  });

  it("never prunes any non-terminal status, one case per status", async () => {
    const sql = await seeded();
    const nonTerminal = RUN_STATUSES.filter((s) => !PRUNABLE_RUN_STATUSES.includes(s));
    // Enumerated from the status list rather than hand-written, so a *new* non-terminal status is covered the day
    // it is added — the failure mode being a status nobody remembered to exclude.
    expect(nonTerminal.length).toBeGreaterThan(2);
    for (const [i, status] of nonTerminal.entries())
      await seedRun(sql, { runId: `nt${i}`, status, daysAgo: 500, count: 2 });

    const result = await createPostgresRunEventPruner(sql).prune({
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 500,
    });
    expect(result.deleted, `pruned events for: ${nonTerminal.join(", ")}`).toBe(0);
  });

  it("prunes a terminal run in the same sweep that spares a live one", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "done", status: "completed", daysAgo: 300, count: 4 });
    await seedRun(sql, { runId: "waiting", status: "waiting-for-approval", daysAgo: 300, count: 4 });
    // Both old, one prunable. A sweep that spared both would pass the test above and still be broken.
    const result = await createPostgresRunEventPruner(sql).prune({
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 100,
    });
    expect(result.deleted).toBe(4);
    expect(await countEvents(sql, "done")).toBe(0);
    expect(await countEvents(sql, "waiting")).toBe(4);
  });

  it("keeps the spared run's log readable and gap-free", async () => {
    const sql = await seeded();
    const runId = await seedRun(sql, { runId: "intact", status: "retry-pending", daysAgo: 300, count: 5 });
    await createPostgresRunEventPruner(sql).prune({ olderThan: cutoffFor({ now: NOW, retentionDays: 1 }), limit: 100 });
    const events = await createPostgresRunEventLog(sql).listAfter({ tenantId: T1, runId, after: 0 });
    // Not just "five rows exist": the sequence must be contiguous, because a resume reads `after: n` and a hole
    // would silently truncate the replay at the gap.
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not prune events for a run row that does not exist", async () => {
    const sql = await seeded();
    // An orphan: events with no `runs` row. The join means they are never selected, so they survive rather than
    // being quietly collected. Stated because the *other* choice is defensible — but silently deleting rows
    // whose parent is missing would hide a referential bug the join is otherwise about to reveal.
    await sql.query(
      `INSERT INTO run_events (tenant_id, run_id, sequence, type, event, created_at)
       VALUES ($1, 'ghost', 1, 'part.added', '{}'::jsonb, $2::timestamptz)`,
      [T1, at(400)],
    );
    const result = await createPostgresRunEventPruner(sql).prune({
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 100,
    });
    expect(result.deleted).toBe(0);
    expect(await countEvents(sql, "ghost")).toBe(1);
  });
});

describe("bounded batches — AC-3", () => {
  it("removes at most `limit` rows and reports the count", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "big", status: "completed", daysAgo: 300, count: 25 });
    const pruner = createPostgresRunEventPruner(sql);
    const first = await pruner.prune({ olderThan: cutoffFor({ now: NOW, retentionDays: 90 }), limit: 10 });
    expect(first.deleted).toBe(10);
    expect(await countEvents(sql, "big")).toBe(15);
  });

  it("drains a backlog over repeated calls", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "big", status: "completed", daysAgo: 300, count: 25 });
    const result = await drain(createPostgresRunEventPruner(sql), {
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 10,
      maxBatches: 10,
    });
    expect(result.deleted).toBe(25);
    expect(result.drained).toBe(true);
    // 10 + 10 + 5: the short third batch is what tells `drain` to stop, rather than a fourth empty call.
    expect(result.batches).toBe(3);
    expect(await countEvents(sql, "big")).toBe(0);
  });

  it("reports drained: false when it hits its batch ceiling", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "huge", status: "completed", daysAgo: 300, count: 40 });
    const result = await drain(createPostgresRunEventPruner(sql), {
      olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
      limit: 5,
      maxBatches: 3,
    });
    // Silence here would look exactly like a finished sweep, and an operator would believe the table was clean.
    expect(result.drained).toBe(false);
    expect(result.deleted).toBe(15);
    expect(await countEvents(sql, "huge")).toBe(25);
  });

  it("deletes the oldest first, so a bounded sweep makes progress that never comes back", async () => {
    const sql = await seeded();
    // **Newer inserted first, deliberately.** Seeding the older run first made this test pass with `ORDER BY`
    // removed — PGlite's scan returned rows in insertion order, so "oldest first" held by accident and the
    // assertion was about the fixture rather than the query. Sabotage found it. With insertion order the
    // *opposite* of age order, an unordered scan reaches the newer rows first and the test fails as it should.
    await seedRun(sql, { runId: "newer", status: "completed", daysAgo: 100, count: 3 });
    await seedRun(sql, { runId: "older", status: "completed", daysAgo: 400, count: 3 });
    await createPostgresRunEventPruner(sql).prune({ olderThan: cutoffFor({ now: NOW, retentionDays: 90 }), limit: 3 });
    // Without ORDER BY the sweep nibbles wherever the scan reaches, and the genuinely ancient rows can survive
    // arbitrarily many bounded runs.
    expect(await countEvents(sql, "older")).toBe(0);
    expect(await countEvents(sql, "newer")).toBe(3);
  });

  it("answers a non-positive limit without touching the database", async () => {
    let queries = 0;
    const counting: SqlExecutor = {
      async query() {
        queries += 1;
        return [];
      },
    };
    const pruner: RunEventPruner = createPostgresRunEventPruner(counting);
    expect((await pruner.prune({ olderThan: at(400), limit: 0 })).deleted).toBe(0);
    expect((await pruner.prune({ olderThan: at(400), limit: -5 })).deleted).toBe(0);
    // A maintenance loop with a misconfigured batch size should not generate load.
    expect(queries).toBe(0);
  });
});

describe("idempotency — AC-4", () => {
  it("removes nothing on a second pass and does not error", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "twice", status: "completed", daysAgo: 300, count: 6 });
    const pruner = createPostgresRunEventPruner(sql);
    const cutoff = cutoffFor({ now: NOW, retentionDays: 90 });
    expect((await pruner.prune({ olderThan: cutoff, limit: 100 })).deleted).toBe(6);
    // Zero, and no throw. Idempotency here comes from the delete being a no-op on an absent row, which is why no
    // row locking is needed to make two overlapping sweeps safe.
    expect((await pruner.prune({ olderThan: cutoff, limit: 100 })).deleted).toBe(0);
  });

  it("two overlapping sweeps together remove each row exactly once", async () => {
    const sql = await seeded();
    await seedRun(sql, { runId: "race", status: "completed", daysAgo: 300, count: 20 });
    const pruner = createPostgresRunEventPruner(sql);
    const cutoff = cutoffFor({ now: NOW, retentionDays: 90 });
    // PGlite serialises these, so this is not a race — it is the accounting property: the *sum* of what two
    // sweeps report equals what existed, never more. The real concurrency case is below, against a server.
    const [a, b] = await Promise.all([
      pruner.prune({ olderThan: cutoff, limit: 20 }),
      pruner.prune({ olderThan: cutoff, limit: 20 }),
    ]);
    expect((a?.deleted ?? 0) + (b?.deleted ?? 0)).toBe(20);
    expect(await countEvents(sql, "race")).toBe(0);
  });
});

describe("configuration — AC-7", () => {
  it("computes a cutoff from a retention period and a clock", () => {
    expect(cutoffFor({ now: Date.parse("2026-08-23T00:00:00.000Z"), retentionDays: 30 })).toBe(
      "2026-07-24T00:00:00.000Z",
    );
  });

  it("has a documented default that is a finite number of days", () => {
    // A default exists so an unconfigured deployment prunes *something*: the failure direction should be "an old
    // log was removed" rather than "the disk filled".
    expect(Number.isInteger(DEFAULT_RUN_EVENT_RETENTION_DAYS)).toBe(true);
    expect(DEFAULT_RUN_EVENT_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it("treats retention as a parameter, not a constant, at the call site", () => {
    // The point of AC-7: two different periods must produce two different cutoffs, so a deployment can set one.
    const a = cutoffFor({ now: NOW, retentionDays: 30 });
    const b = cutoffFor({ now: NOW, retentionDays: 365 });
    expect(a).not.toEqual(b);
    expect(Date.parse(b)).toBeLessThan(Date.parse(a));
  });
});

describe("the append-only port is unchanged — AC-8", () => {
  it("declares no delete, remove, prune or truncate on RunEventLog", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../core/events.ts", import.meta.url).pathname, "utf8");
    const start = source.indexOf("export interface RunEventLog");
    // To the line that is *only* a closing brace. `indexOf("}")` stops at the first `}` inside `append`'s inline
    // object type, so the slice ended mid-signature and the "members it does have" assertion failed against a
    // declaration that had been cut in half.
    const end = source.indexOf("\n}", start);
    const declaration = source.slice(start, end);
    // Asserted on the *declaration*, because a TypeScript interface has no runtime shape to inspect. The port is
    // append-only on purpose: a delete here would put deletion within reach of ordinary run code, and pruning
    // lives on a separate maintenance surface precisely to make that impossible by construction.
    for (const forbidden of ["delete", "remove", "prune", "truncate", "purge"])
      expect(declaration.toLowerCase(), `RunEventLog declares ${forbidden}`).not.toContain(forbidden);
    // And the members it *does* have, so this cannot pass by the interface having been renamed away.
    for (const member of ["append", "listAfter", "latestSequence"]) expect(declaration).toContain(member);
  });
});

/* --------------------------------------------------------------- a real server: AC-5 and AC-6 */

if (!PG_URL) {
  describe("retention against a real server", () => {
    it("[skipped: RETINUE_TEST_PG_URL unset — EXPLAIN needs a planner with statistics, and the append race needs two connections]", () => {
      expect(PG_URL).toBeUndefined();
    });
  });
} else {
  describe("retention against a real server", () => {
    /** A pool bound to a fresh schema, so two of these are two genuinely separate connections. */
    const serverPool = (schema: string) => {
      const url = new URL(PG_URL);
      url.searchParams.set("options", `-c search_path=${schema},public`);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      const sql: SqlExecutor = {
        async query(text, params) {
          const result = await pool.query(text, params ? [...params] : undefined);
          return result.rows as never[];
        },
      };
      return { pool, sql };
    };

    const freshSchema = async () => {
      const schema = `ret_${Date.now().toString(36)}`;
      const bootstrap = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      await bootstrap.end();
      const { pool, sql } = serverPool(schema);
      await migrate(sql);
      await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "t" });
      return { schema, pool, sql };
    };

    /**
     * AC-6. An index scan, verified by the planner.
     *
     * Needs enough rows and an `ANALYZE`, because on a small table a sequential scan genuinely *is* cheaper and
     * the planner is right to choose it — asserting "not Seq Scan" on ten rows would assert the planner is wrong.
     */
    it("serves the age sweep from an index rather than a sequential scan", async () => {
      const { schema, pool, sql } = await freshSchema();
      try {
        await createPostgresRunStore(sql).create({
          tenantId: T1, id: asId<RunId>("explain"), conversationId: C1, agentId: AGENT, agentVersion: 1,
        });
        await sql.query(`UPDATE runs SET status = 'completed' WHERE tenant_id = $1`, [T1]);
        // Bulk-inserted in one statement: 20k rows one at a time would make this test minutes long.
        await sql.query(
          `INSERT INTO run_events (tenant_id, run_id, sequence, type, event, created_at)
           SELECT $1, 'explain', g, 'part.added', '{}'::jsonb,
                  $2::timestamptz - (g % 400) * INTERVAL '1 day'
             FROM generate_series(1, 20000) AS g`,
          [T1, new Date(NOW).toISOString()],
        );
        await sql.query(`ANALYZE run_events`);

        const plan = (
          await sql.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT e.ctid FROM run_events e
               JOIN runs r ON r.tenant_id = e.tenant_id AND r.id = e.run_id
              WHERE e.created_at < $1::timestamptz AND r.status IN ('completed','failed','cancelled')
              ORDER BY e.created_at LIMIT 100`,
            [cutoffFor({ now: NOW, retentionDays: 390 })],
          )
        )
          .map((r) => r["QUERY PLAN"])
          .join("\n");

        // The index by name, so this cannot pass on some *other* index the planner happened to pick.
        expect(plan, plan).toContain("run_events_created_at_idx");
        expect(plan, plan).not.toMatch(/Seq Scan on run_events/);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
      }
    });

    /**
     * AC-5. Appends must not block, and must not be lost.
     *
     * Two pools on the same schema, so these are real concurrent connections. The appended events are *recent*,
     * so the sweep would not select them anyway — which is the realistic shape: a maintenance job runs while the
     * platform is live.
     */
    it("does not block or lose a concurrent append", async () => {
      const { schema, pool, sql } = await freshSchema();
      const second = serverPool(schema);
      try {
        await createPostgresRunStore(sql).create({
          tenantId: T1, id: asId<RunId>("old"), conversationId: C1, agentId: AGENT, agentVersion: 1,
        });
        await createPostgresRunStore(sql).create({
          tenantId: T1, id: asId<RunId>("live"), conversationId: C1, agentId: AGENT, agentVersion: 1,
        });
        await sql.query(`UPDATE runs SET status = 'completed' WHERE tenant_id = $1 AND id = 'old'`, [T1]);
        await sql.query(
          `INSERT INTO run_events (tenant_id, run_id, sequence, type, event, created_at)
           SELECT $1, 'old', g, 'part.added', '{}'::jsonb, $2::timestamptz
             FROM generate_series(1, 2000) AS g`,
          [T1, at(300)],
        );

        const log = createPostgresRunEventLog(second.sql);
        const liveRun = asId<RunId>("live");
        const appends = Array.from({ length: 60 }, (_, i) =>
          log.append({
            tenantId: T1,
            event: { type: "part.added", runId: liveRun, sequence: i + 1, occurredAt: new Date(NOW).toISOString() } as never,
          }),
        );
        const sweep = drain(createPostgresRunEventPruner(sql), {
          olderThan: cutoffFor({ now: NOW, retentionDays: 90 }),
          limit: 200,
          maxBatches: 20,
        });

        const [sweepResult] = await Promise.all([sweep, Promise.all(appends)]);

        // Both completed: neither waited on the other's locks.
        expect(sweepResult.deleted).toBe(2000);
        // And not one appended event is missing. A sweep that took a table-level lock would have serialised
        // these, which is slower but not lossy — the assertion that matters is the count, because a bounded
        // `ctid` delete that mis-selected could take a row it never should have seen.
        expect(await countEvents(second.sql, "live")).toBe(60);
        const events = await log.listAfter({ tenantId: T1, runId: liveRun, after: 0 });
        expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      } finally {
        await second.pool.end();
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
      }
    });
  });
}
