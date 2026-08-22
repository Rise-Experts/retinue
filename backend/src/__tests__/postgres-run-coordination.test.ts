/**
 * Postgres `ConversationRunCoordinator` / `UnitOfWork` — adapter-specific cases (#98).
 *
 * Three of these carry weight the shared harness structurally cannot:
 *
 * - **AC-1 across two connections.** The harness's "single-flight" case fires four concurrent claims
 *   through one executor, and on PGlite the opener serialises them — so it proves ordering, not that
 *   the database adjudicated a race. Only two real connections can show that.
 * - **AC-2, slot recovery.** A worker that claims a conversation and dies must not block it forever.
 * - **AC-3/AC-4, four-table atomicity.** The completion transaction is the reason `UnitOfWork` exists.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../core/ids.js";
import {
  createPostgresConversationRunCoordinator,
  createPostgresConversationStore,
  createPostgresRunEventLog,
  createPostgresRunStore,
  createPostgresSessionStateStore,
  createPostgresUnitOfWork,
  createPoolOpener,
  createSingleConnectionOpener,
  createTransactionScope,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";

const T1 = asId<TenantId>("pg-rc-t1");
const C1 = asId<ConversationId>("pg-rc-c1");
const AGENT = asId<AgentId>("pg-rc-agent");
const r = (s: string) => asId<RunId>(s);
const PG_URL = process.env["AGENTKIT_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/** A migrated PGlite database with a conversation, plus the transaction scope over it. */
const seeded = async () => {
  const base = pglite(new PGlite());
  await migrate(base);
  const scope = createTransactionScope(createSingleConnectionOpener(base));
  const sql = scope.scoped(base);
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "thread" });
  return { sql, runner: scope.runner, base };
};

describe("migration 0007", () => {
  it("migrates up, rolls back, and re-migrates", async () => {
    const sql = pglite(new PGlite());
    await migrate(sql);
    await sql.query("SELECT 1 FROM conversation_run_slots LIMIT 1");
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM conversation_run_slots LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM conversation_run_slots LIMIT 1");
  });

  it("rejects a queue that is not an array", async () => {
    const { sql } = await seeded();
    // Without this constraint a malformed write would make every position and depth answer silently
    // wrong rather than loudly broken.
    await expect(
      sql.query(
        `INSERT INTO conversation_run_slots (tenant_id, conversation_id, queued, updated_at)
         VALUES ($1, $2, '{"not":"an array"}'::jsonb, now())`,
        [T1, C1],
      ),
    ).rejects.toThrow();
  });

  it("removes the slot with its conversation", async () => {
    const { sql, runner } = await seeded();
    const co = createPostgresConversationRunCoordinator(sql, runner);
    await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") });
    await sql.query(`DELETE FROM conversations WHERE tenant_id = $1 AND id = $2`, [T1, C1]);
    expect(await co.active({ tenantId: T1, conversationId: C1 })).toBeNull();
  });

  it("serves the slot lookup from the primary key", async () => {
    const { sql } = await seeded();
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT active_run_id FROM conversation_run_slots
        WHERE tenant_id = $1 AND conversation_id = $2`,
      [T1, C1],
    );
    expect(plan.map((row) => Object.values(row)[0]).join("\n")).not.toContain("Seq Scan");
  });
});

/**
 * AC-2. The slot outlives the process that claimed it, so a crashed worker must not block the
 * conversation forever — and liveness comes from the run's own lease (#93) rather than a second clock
 * on the slot, because two clocks for one fact drift and there is no principled tiebreak.
 */
describe("slot recovery after a worker dies", () => {
  const claimed = async () => {
    const ctx = await seeded();
    const runs = createPostgresRunStore(ctx.sql);
    await runs.create({
      tenantId: T1,
      id: r("dead"),
      conversationId: C1,
      agentId: AGENT,
      agentVersion: 1,
    });
    const co = createPostgresConversationRunCoordinator(ctx.sql, ctx.runner);
    await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("dead") });
    return { ...ctx, co, runs };
  };

  it("hands the slot to a new run once the holder's lease has expired", async () => {
    const { co, sql } = await claimed();
    // What a crashed worker looks like from the database's side: still 'running', lease long past.
    await sql.query(
      `UPDATE runs SET status = 'running', lease_expires_at = now() - interval '1 hour'
        WHERE tenant_id = $1 AND id = $2`,
      [T1, r("dead")],
    );
    expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("fresh") })).toMatchObject({
      status: "started",
    });
    expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("fresh");
  });

  it("hands the slot on when the holder finished without releasing", async () => {
    const { co, sql } = await claimed();
    await sql.query(`UPDATE runs SET status = 'completed' WHERE tenant_id = $1 AND id = $2`, [
      T1,
      r("dead"),
    ]);
    expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("fresh") })).toMatchObject({
      status: "started",
    });
  });

  it("does NOT take the slot from a holder whose lease is still live", async () => {
    const { co, sql } = await claimed();
    await sql.query(
      `UPDATE runs SET status = 'running', lease_expires_at = now() + interval '1 hour'
        WHERE tenant_id = $1 AND id = $2`,
      [T1, r("dead")],
    );
    expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("fresh") })).toMatchObject({
      status: "queued",
    });
  });

  it("does NOT take the slot from a holder with no run row — unknown is not dead", async () => {
    // The load-bearing half of the takeover rule. `claimOrEnqueue` is legitimately called before the
    // run row is committed, so reading a missing row as "dead" would let a fresh claim evict a live
    // run — far worse than recovering a crashed worker's slot slowly. The conformance harness relies
    // on this too: it never creates run rows at all.
    const { sql, runner } = await seeded();
    const co = createPostgresConversationRunCoordinator(sql, runner);
    await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("ghost") });
    expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("other") })).toMatchObject({
      status: "queued",
    });
    expect(await co.active({ tenantId: T1, conversationId: C1 })).toBe("ghost");
  });

  it("waiting-for-approval keeps the slot — a human pause is not a crash", async () => {
    const { co, sql } = await claimed();
    // The case that rules out an advisory lock: this state can last hours, and the slot must survive
    // it. A lock scoped to a transaction could not.
    await sql.query(
      `UPDATE runs SET status = 'waiting-for-approval', lease_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [T1, r("dead")],
    );
    expect(await co.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("fresh") })).toMatchObject({
      status: "queued",
    });
  });
});

/**
 * AC-3 and AC-4. The completion transaction is the whole reason this port exists: a run that finishes
 * writes its status, its events, its session state and its usage, and a partial commit there means a
 * conversation whose accounting and whose memory disagree with its own history.
 */
describe("four-table atomic completion", () => {
  const usageShapedTable = `CREATE TABLE IF NOT EXISTS usage_probe (
      tenant_id text NOT NULL, run_id text NOT NULL, total_tokens integer NOT NULL,
      PRIMARY KEY (tenant_id, run_id))`;

  it("commits run status, an event, session state and usage together", async () => {
    const { sql, runner } = await seeded();
    await sql.query(usageShapedTable);
    const runs = createPostgresRunStore(sql);
    const events = createPostgresRunEventLog(sql);
    const sessions = createPostgresSessionStateStore(sql);
    const uow = createPostgresUnitOfWork(runner);
    await runs.create({ tenantId: T1, id: r("x"), conversationId: C1, agentId: AGENT, agentVersion: 1 });

    await uow.run(async () => {
      await events.append({
        tenantId: T1,
        event: {
            type: "run.completed",
            runId: r("x"),
            sequence: 1,
            occurredAt: "2020-01-01T00:00:00.000Z",
          },
      });
      await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { done: true } });
      await sql.query(`INSERT INTO usage_probe (tenant_id, run_id, total_tokens) VALUES ($1, $2, 10)`, [
        T1,
        r("x"),
      ]);
    });

    expect(await events.listAfter({ tenantId: T1, runId: r("x"), after: 0 })).toHaveLength(1);
    expect(await sessions.get({ tenantId: T1, conversationId: C1 })).not.toBeNull();
    expect(await sql.query(`SELECT 1 FROM usage_probe`)).toHaveLength(1);
  });

  it("rolls all four back when the completion fails partway", async () => {
    const { sql, runner } = await seeded();
    await sql.query(usageShapedTable);
    const runs = createPostgresRunStore(sql);
    const events = createPostgresRunEventLog(sql);
    const sessions = createPostgresSessionStateStore(sql);
    const uow = createPostgresUnitOfWork(runner);
    await runs.create({ tenantId: T1, id: r("x"), conversationId: C1, agentId: AGENT, agentVersion: 1 });

    await expect(
      uow.run(async () => {
        await events.append({
          tenantId: T1,
          event: {
            type: "run.completed",
            runId: r("x"),
            sequence: 1,
            occurredAt: "2020-01-01T00:00:00.000Z",
          },
        });
        await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { done: true } });
        await sql.query(`INSERT INTO usage_probe (tenant_id, run_id, total_tokens) VALUES ($1, $2, 10)`, [
          T1,
          r("x"),
        ]);
        throw new Error("completion failed after the usage write");
      }),
    ).rejects.toThrow("completion failed");

    // AC-4 precisely: no partial usage record, and session state not advanced.
    expect(await sql.query(`SELECT 1 FROM usage_probe`)).toHaveLength(0);
    expect(await sessions.get({ tenantId: T1, conversationId: C1 })).toBeNull();
    expect(await events.listAfter({ tenantId: T1, runId: r("x"), after: 0 })).toHaveLength(0);
  });

  it("nests: an inner failure rolls back to its savepoint without losing the outer work", async () => {
    const { sql, runner } = await seeded();
    const sessions = createPostgresSessionStateStore(sql);
    const uow = createPostgresUnitOfWork(runner);

    await uow.run(async () => {
      await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { outer: true } });
      // A nested unit is a savepoint, so its failure must not discard the outer write — otherwise a
      // caller could never recover from an optional sub-step.
      await expect(
        uow.run(async () => {
          await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { inner: true } });
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
    });

    expect((await sessions.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual({ outer: true });
  });
});

/**
 * AC-1 across two connections — the case the harness structurally cannot demonstrate, because on a
 * single connection the opener serialises claims and "one wins" then follows from queueing rather
 * than from the database adjudicating.
 */
describe("two-connection claim", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  const serverScope = async (schema: string) => {
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
    const scope = createTransactionScope(createPoolOpener(pool, schema));
    return { sql: scope.scoped(base), runner: scope.runner };
  };

  if (!PG_URL) {
    it("[skipped: AGENTKIT_TEST_PG_URL unset — one embedded connection cannot express this race]", () => {
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("admits exactly one starter when two connections claim at once", async () => {
      const schema = "conf_rc_race";
      const setup = await serverScope("public");
      await setup.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.sql.query(`CREATE SCHEMA ${schema}`);

      const a = await serverScope(schema);
      const b = await serverScope(schema);
      await migrate(a.sql);
      await createPostgresConversationStore(a.sql).create({ tenantId: T1, id: C1, title: "race" });

      const coA = createPostgresConversationRunCoordinator(a.sql, a.runner);
      const coB = createPostgresConversationRunCoordinator(b.sql, b.runner);

      // The slot row must already exist and be *free* before the race, and this is the whole point.
      // Racing on a brand-new conversation proves nothing: the opening
      // `INSERT … ON CONFLICT DO NOTHING` blocks the second writer on the unique index, so one wins
      // even with no row lock at all. Verified by removing `FOR UPDATE` — the naive version of this
      // test still passed. An existing, unheld row is the case where two readers really can both see
      // `active_run_id IS NULL`, and it is the case a real deployment is in for every turn after the
      // first.
      await coA.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("warm") });
      expect(await coA.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: r("warm") })).toBeNull();

      // Warm B's pool, and this line is load-bearing. An unused pool pays TCP setup plus
      // authentication on its first connect — orders of magnitude longer than the whole transaction —
      // so without this, B is still connecting while A commits and the two claims never overlap. The
      // test passed with `FOR UPDATE` deleted until this was added; with it, the unlocked version
      // returns "started" *twice* and loses A's claim entirely.
      await b.sql.query("SELECT 1");

      const [ra, rb] = await Promise.all([
        coA.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("a") }),
        coB.claimOrEnqueue({ tenantId: T1, conversationId: C1, runId: r("b") }),
      ]);

      // Exactly one started; the other is queued behind it, with the backlog to match. Two starters
      // would mean two workers executing one conversation — the failure this port exists to prevent.
      expect([ra.status, rb.status].filter((s) => s === "started")).toHaveLength(1);
      expect([ra.status, rb.status].filter((s) => s === "queued")).toHaveLength(1);
      expect(await coA.depth({ tenantId: T1, conversationId: C1 })).toBe(1);

      // And the loser is promoted by the winner's release, from the other connection.
      const winner = ra.status === "started" ? r("a") : r("b");
      const loser = ra.status === "started" ? r("b") : r("a");
      expect(await coB.releaseAndPromote({ tenantId: T1, conversationId: C1, runId: winner })).toBe(loser);

      await setup.sql.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
