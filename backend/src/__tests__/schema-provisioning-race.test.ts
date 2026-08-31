/**
 * Concurrent `auto`-mode provisioning — #266.
 *
 * ## The failure being fixed, reproduced first
 *
 * AC-1 asks for the crash to be reproduced before the fix, so the fix is measured against a failure somebody
 * saw rather than against a hypothesis. That is what the first test does: N provisioners against one fresh
 * schema, **no opener**, and at least one of them fails with
 *
 *     duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *
 * That is Postgres's own type catalogue. Two sessions running the same `CREATE TYPE` race *inside the server*,
 * below anything the migration ledger can protect — the ledger stays perfectly correct while a process dies.
 * Several workers booting against a fresh database is the ordinary Kubernetes init-container pattern, so the
 * result is one crash loop with an error naming nothing an operator can act on.
 *
 * ## Why this needs a real server
 *
 * PGlite is single-process and cannot produce the race at all, so a test that ran only there would pass
 * against the broken code. The suite skips without `RETINUE_TEST_PG_URL` rather than pretending, and says so.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createPoolOpener, MIGRATION_LOCK, provisionSchema } from "../entries/adapters-postgres.js";
import type { ConnectionOpener, SqlExecutor } from "../entries/adapters-postgres.js";

const PG_URL = process.env["RETINUE_TEST_PG_URL"];

/** How many boot together. Four is enough to lose reliably and small enough to stay fast. */
const WORKERS = 4;

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
});

/**
 * A fresh schema, and a pool per *worker* — which is the point.
 *
 * One pool shared between the four would let `pg` hand out the same connection twice and quietly serialise
 * them, which would make the reproduction pass for the wrong reason. Separate pools are what separate
 * processes look like from the database's side.
 */
const freshSchema = async (
  name: string,
): Promise<{ workers: { sql: SqlExecutor; open: ConnectionOpener }[]; inspect: SqlExecutor }> => {
  const { Pool } = await import("pg");
  const setup = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  closers.push(() => setup.end());
  await setup.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await setup.query(`CREATE SCHEMA ${name}`);

  const workers = await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
      closers.push(() => pool.end());
      await pool.query(`SET search_path TO ${name}, public`);
      const sql: SqlExecutor = {
        async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
          const client = await pool.connect();
          try {
            await client.query(`SET search_path TO ${name}, public`);
            const result = await client.query(text, params ? [...params] : undefined);
            return result.rows as Row[];
          } finally {
            client.release();
          }
        },
      };
      return { sql, open: createPoolOpener(pool, name) };
    }),
  );

  const inspect: SqlExecutor = {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      const result = await setup.query(text, params ? [...params] : undefined);
      return result.rows as Row[];
    },
  };
  return { workers, inspect };
};

const ledgerCount = async (inspect: SqlExecutor, schema: string): Promise<number> => {
  const rows = await inspect.query<{ n: string }>(
    `select count(*) as n from ${schema}.schema_migrations`,
  );
  return Number(rows[0]?.n ?? 0);
};

describe.skipIf(PG_URL === undefined)("concurrent auto-mode provisioning — #266", () => {
  it("without a lock, at least one worker crashes — the reproduction, AC-1", async () => {
    const schema = "race_unlocked";
    const { workers, inspect } = await freshSchema(schema);

    /**
     * No `open`, which is the code path as it was before this issue. `allSettled` rather than `all`, because
     * the whole point is to observe the rejection rather than to be stopped by it.
     */
    const outcomes = await Promise.allSettled(
      workers.map((worker) => provisionSchema(worker.sql, { mode: "auto" })),
    );

    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    /**
     * **The assertion this test exists for.** If it ever stops failing, the reproduction has stopped
     * reproducing and the test below is no longer evidence of anything.
     *
     * Not asserted on the exact message: the catalogue index that trips depends on which DDL the two sessions
     * collide inside, and pinning `pg_type_typname_nsp_index` specifically would make this brittle against a
     * migration reordering. What matters is that a caller was handed an error at all.
     */
    expect(failures.length).toBeGreaterThan(0);
    /**
     * And it failed for the **right reason** — a catalogue collision inside the server, not an incidental
     * error like a missing schema or a bad search path. Without this the reproduction could pass while
     * reproducing something else entirely, which would make the fix below evidence for nothing.
     */
    const reasons = failures.map((outcome) =>
      String((outcome as PromiseRejectedResult).reason?.message ?? (outcome as PromiseRejectedResult).reason),
    );
    expect(
      reasons.some((reason) => /duplicate key value|already exists|tuple concurrently updated/i.test(reason)),
      `expected a catalogue collision, got: ${reasons.join(" | ")}`,
    ).toBe(true);

    // And the data was fine the whole time, which is what makes this an operator-experience bug rather than a
    // correctness one — and why it is easy to miss.
    const applied = await ledgerCount(inspect, schema);
    expect(applied).toBeGreaterThan(0);
    const distinct = await inspect.query<{ n: string }>(
      `select count(distinct id) as n from ${schema}.schema_migrations`,
    );
    expect(Number(distinct[0]?.n)).toBe(applied);
  }, 120_000);

  it("with the opener, every worker exits cleanly — AC-1", async () => {
    const schema = "race_locked";
    const { workers, inspect } = await freshSchema(schema);

    const results = await Promise.all(
      workers.map((worker) => provisionSchema(worker.sql, { mode: "auto", open: worker.open })),
    );

    // Nobody failed. That is the fix.
    expect(results).toHaveLength(WORKERS);
    for (const result of results) expect(result.locked).toBe(true);

    /**
     * Exactly one applied; the rest found nothing to do.
     *
     * The "nothing to do" is what proves the plan is read *inside* the lock. A plan computed before waiting
     * would have been invalidated by the winner, and the loser would have tried to apply migrations that were
     * already recorded — racing on the DDL anyway, with the lock held and no benefit.
     */
    const appliers = results.filter((result) => result.applied.length > 0);
    expect(appliers).toHaveLength(1);
    expect(results.filter((result) => result.applied.length === 0)).toHaveLength(WORKERS - 1);

    const applied = await ledgerCount(inspect, schema);
    expect(applied).toBe(appliers[0]?.applied.length);
  }, 120_000);

  it("releases the lock, so a later boot is not blocked — AC-1", async () => {
    const schema = "race_release";
    const { workers } = await freshSchema(schema);
    const worker = workers[0]!;

    await provisionSchema(worker.sql, { mode: "auto", open: worker.open });
    // A leaked lock would make this hang rather than fail, which is the worst shape of bug to diagnose — so
    // it is asserted rather than assumed. The test timeout is the backstop.
    const second = await provisionSchema(worker.sql, { mode: "auto", open: worker.open });
    expect(second.applied).toEqual([]);
    expect(second.locked).toBe(true);

    // And the lock is genuinely not held: taking it non-blockingly from another connection succeeds.
    const free = await workers[1]!.open(async (locked) => {
      const rows = await locked.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [MIGRATION_LOCK]);
      const ok = rows[0]?.ok === true;
      if (ok) await locked.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      return ok;
    });
    expect(free).toBe(true);
  }, 120_000);

  it("plan mode takes no lock, so booting workers do not queue behind a read — AC-2", async () => {
    const schema = "race_plan";
    const { workers } = await freshSchema(schema);

    /**
     * Asserted by holding the lock and then planning: if `plan` waited on it, this would time out.
     *
     * `plan()` and `currentVersion()` are documented side-effect free, so serialising every booting worker
     * behind them would be a cost with nothing bought — and a dry run that waited on a migration lock would
     * be a dry run with a production dependency.
     */
    const planned = await workers[0]!.open(async (holder) => {
      await holder.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      try {
        const result = await provisionSchema(workers[1]!.sql, { mode: "plan", open: workers[1]!.open });
        expect(result.locked).toBe(false);
        return result.planned.length;
      } finally {
        await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      }
    });
    expect(planned).toBeGreaterThan(0);
  }, 60_000);
});

describe("a caller with no opener still works — AC-3", () => {
  it("reports locked: false rather than requiring a lock it cannot take", async () => {
    /**
     * PGlite and the in-memory paths are single-process, so there is nothing to serialise. Requiring an opener
     * would be a new dependency for the one case that never needed it — and `locked: false` makes the
     * unprotected path visible rather than assumed, which is what turns "we forgot to pass it" from an
     * invisible configuration mistake into a readable one.
     */
    const statements: string[] = [];
    const sql: SqlExecutor = {
      async query<Row>(text: string): Promise<Row[]> {
        statements.push(text);
        return [] as Row[];
      },
    };
    const result = await provisionSchema(sql, { mode: "auto", migrations: [{ id: "m1", up: ["select 1"], down: [] }] });
    expect(result.locked).toBe(false);
    expect(result.applied).toEqual(["m1"]);
    // No advisory lock was attempted against an executor that cannot hold one.
    expect(statements.some((text) => text.includes("pg_advisory_lock"))).toBe(false);
  });

  it("off mode does nothing at all, with or without an opener", async () => {
    const statements: string[] = [];
    const sql: SqlExecutor = {
      async query<Row>(text: string): Promise<Row[]> {
        statements.push(text);
        return [] as Row[];
      },
    };
    const result = await provisionSchema(sql, { mode: "off" });
    expect(result).toMatchObject({ mode: "off", applied: [], planned: [], locked: false });
    expect(statements).toEqual([]);
  });
});
