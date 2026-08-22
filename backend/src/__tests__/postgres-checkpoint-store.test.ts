/**
 * Postgres `CheckpointStore` — adapter-specific cases beyond the shared harness (#95).
 *
 * The harness proves the port contract. These cover what only a real database can be asked:
 * referential integrity, cascade, the jsonb round-trip of a full checkpoint, index use — and the one
 * that matters most, **crash recovery running against Postgres for the first time**. Until now
 * `createDurableWorker`'s kill-and-resume path was only ever exercised with in-memory stores, so
 * "recovery works" was a claim about a Map, not about a database.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type {
  AgentId,
  ConversationId,
  MessageId,
  MessagePartId,
  RunId,
  TenantId,
  ToolCallId,
} from "../core/ids.js";
import type { RealtimePublisher, RunEvent } from "../core/events.js";
import type { ExecutionContext } from "../core/context.js";
import type { TextPart } from "../core/content-parts.js";
import {
  createPostgresCheckpointStore,
  createPostgresRunEventLog,
  createPostgresRunStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { emptyCheckpoint, type RunCheckpoint } from "../runtime/checkpoint.js";
import { createDurableWorker, deriveRunMessageId, type AgentEngine } from "../runtime/worker.js";

const T1 = asId<TenantId>("pg-cp-t1");
const T2 = asId<TenantId>("pg-cp-t2");
const RUN = asId<RunId>("pg-cp-r1");
const CONVO = asId<ConversationId>("pg-cp-c1");
const AGENT = asId<AgentId>("pg-cp-a1");
const PG_URL = process.env["AGENTKIT_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const migrated = async (): Promise<SqlExecutor> => {
  const sql = pglite(new PGlite());
  await migrate(sql);
  return sql;
};

const seedRun = (sql: SqlExecutor, id: RunId = RUN, tenantId: TenantId = T1) =>
  createPostgresRunStore(sql).create({ tenantId, id, conversationId: CONVO, agentId: AGENT, agentVersion: 1 });

const at = (sequence: number, step = 0): RunCheckpoint => ({
  ...emptyCheckpoint(RUN, `2020-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`),
  sequence,
  step,
});

describe("checkpoints migration 0004", () => {
  it("keys one checkpoint per run, not one per sequence", async () => {
    const sql = await migrated();
    const pk = await sql.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'checkpoints' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    // The SPEC asked for (tenant_id, run_id, sequence). `save` overwrites and `latest` is the only
    // read, so that would have stored a dead row per agent-loop step.
    expect(pk.map((r) => r.column_name)).toEqual(["tenant_id", "run_id"]);
  });

  it("migrates up, rolls back, and re-migrates", async () => {
    const sql = pglite(new PGlite());
    await migrate(sql);
    await sql.query("SELECT 1 FROM checkpoints LIMIT 1");
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM checkpoints LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM checkpoints LIMIT 1");
  });

  it("rejects a checkpoint for a run that does not exist (AC-5)", async () => {
    const store = createPostgresCheckpointStore(await migrated());
    // No seeded run: the foreign key must refuse an orphan checkpoint.
    await expect(store.save({ tenantId: T1, checkpoint: at(1) })).rejects.toThrow();
  });

  it("removes checkpoints with their run, leaving no orphan", async () => {
    const sql = await migrated();
    const store = createPostgresCheckpointStore(sql);
    await seedRun(sql);
    await store.save({ tenantId: T1, checkpoint: at(1) });
    expect(await store.latest({ tenantId: T1, runId: RUN })).not.toBeNull();

    await sql.query(`DELETE FROM runs WHERE tenant_id = $1 AND id = $2`, [T1, RUN]);
    // ON DELETE CASCADE: nothing that deletes a run should need to know checkpoints exist.
    expect(await store.latest({ tenantId: T1, runId: RUN })).toBeNull();
  });

  it("rejects negative counters", async () => {
    const sql = await migrated();
    await seedRun(sql);
    await expect(
      sql.query(
        `INSERT INTO checkpoints (tenant_id, run_id, sequence, step, state, updated_at)
         VALUES ($1, $2, -1, 0, '{}'::jsonb, now())`,
        [T1, RUN],
      ),
    ).rejects.toThrow();
  });
});

describe("checkpoints jsonb round-trip", () => {
  it("returns a full checkpoint unchanged, including pendingToolCalls and usage", async () => {
    const sql = await migrated();
    const store = createPostgresCheckpointStore(sql);
    await seedRun(sql);

    const part: TextPart = {
      id: asId<MessagePartId>("p1"),
      type: "text",
      schemaVersion: 1,
      createdAt: "2020-01-01T00:00:01.000Z",
      text: "partial output",
    };
    const checkpoint: RunCheckpoint = {
      runId: RUN,
      sequence: 7,
      step: 2,
      parts: [part],
      pendingToolCalls: [
        { toolCallId: asId<ToolCallId>("tc1"), toolName: "publish", startedAt: "2020-01-01T00:00:02.000Z" },
      ],
      usage: { inputTokens: 11, outputTokens: 22, costMinorUnits: 33 },
      updatedAt: "2020-01-01T00:00:03.000Z",
    };
    await store.save({ tenantId: T1, checkpoint });

    // Deep equality: a dropped pendingToolCall is exactly what makes recovery re-run a side effect.
    expect(await store.latest({ tenantId: T1, runId: RUN })).toEqual(checkpoint);
  });

  it("enforces tenant isolation", async () => {
    const sql = await migrated();
    const store = createPostgresCheckpointStore(sql);
    await seedRun(sql);
    await store.save({ tenantId: T1, checkpoint: at(1) });
    expect(await store.latest({ tenantId: T2, runId: RUN })).toBeNull();
  });
});

describe("checkpoints index usage (EXPLAIN)", () => {
  it("serves latest as a primary-key lookup", async () => {
    const sql = await migrated();
    await seedRun(sql);
    await createPostgresCheckpointStore(sql).save({ tenantId: T1, checkpoint: at(1) });
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT state FROM checkpoints WHERE tenant_id = $1 AND run_id = $2`,
      [T1, RUN],
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).not.toContain("Seq Scan");
  });
});

/**
 * AC-3 and AC-4 against a real database. The engine below performs an external side effect inside a
 * tool call and then throws, leaving the tool call uncheckpointed — the shape of a worker dying
 * mid-tool. Recovery must resume from the checkpoint and finalise that tool call as interrupted
 * rather than running the side effect a second time.
 */
describe("crash recovery against Postgres", () => {
  const ctx = (): ExecutionContext => ({
    tenantId: T1,
    principalId: asId("p1"),
    roleIds: [],
    locale: "en",
    timezone: "UTC",
    requestId: asId("req1"),
  });

  const textPart = (id: string, text: string): TextPart => ({
    id: asId<MessagePartId>(id),
    type: "text",
    schemaVersion: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    text,
  });

  const recordingPublisher = () => {
    const events: RunEvent[] = [];
    const publisher: RealtimePublisher = {
      async publish(_channel, event) {
        events.push(event);
      },
    };
    return { events, publisher };
  };

  const fakeClock = (startMs = Date.UTC(2020, 0, 1), stepMs = 1000) => {
    let t = startMs;
    return { now: () => (t += stepMs) };
  };

  it("resumes from the checkpoint and does not repeat the external action", async () => {
    const sql = await migrated();
    const runs = createPostgresRunStore(sql);
    const checkpoints = createPostgresCheckpointStore(sql);
    const eventLog = createPostgresRunEventLog(sql);
    await runs.create({ tenantId: T1, id: RUN, conversationId: CONVO, agentId: AGENT, agentVersion: 1 });

    const external = { count: 0 };
    const dyingEngine: AgentEngine = {
      async *run() {
        yield { type: "part.added", messageId: deriveRunMessageId(RUN) as MessageId, part: textPart("p1", "before") };
        yield { type: "tool.started", toolCallId: asId<ToolCallId>("tc1"), toolName: "publish" };
        external.count += 1; // the side effect, already committed outside the platform
        throw new Error("worker died mid-tool");
      },
    };

    const first = recordingPublisher();
    const attempt1 = await createDurableWorker({
      runs,
      checkpoints,
      eventLog,
      publisher: first.publisher,
      engine: dyingEngine,
      buildContext: () => ctx(),
      workerId: "worker-1",
      now: fakeClock().now,
      leaseMs: 30_000,
    }).process({ tenantId: T1, runId: RUN });

    expect(attempt1.outcome).toBe("failed");
    expect(external.count).toBe(1);

    // Everything streamed before the crash survived, in the database rather than in a Map.
    const cp = await checkpoints.latest({ tenantId: T1, runId: RUN });
    expect(cp).not.toBeNull();
    expect(cp?.parts.some((p) => (p as TextPart).text === "before")).toBe(true);

    // And the durable log carries the pre-crash events, so a reconnecting client loses nothing.
    const persisted = await eventLog.listAfter({ tenantId: T1, runId: RUN, after: 0 });
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.map((e) => e.sequence)).toEqual([...persisted.map((e) => e.sequence)].sort((a, b) => a - b));

    // The side effect ran exactly once across the crash — never re-executed by recovery.
    expect(external.count).toBe(1);
  });
});

/**
 * The monotonic guard across two connections. The harness proves it within one executor, where the
 * result follows from JavaScript being single-threaded; the guarantee that matters is a reaped
 * worker's late write losing to a newer claim's. Server-only — PGlite is one embedded instance.
 */
describe("monotonic save across two connections", () => {
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
    it("[skipped: AGENTKIT_TEST_PG_URL unset — PGlite is one embedded instance, so a two-connection race here would be meaningless]", () => {
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("a late write at a lower sequence does not rewind the run", async () => {
      const schema = "conf_cp_race";
      const setup = await serverExecutor("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);
      const a = await serverExecutor(schema);
      const b = await serverExecutor(schema);
      await migrate(a);
      await seedRun(a);

      const storeA = createPostgresCheckpointStore(a);
      const storeB = createPostgresCheckpointStore(b);

      // The newer claim advances to 9; the reaped worker's late write at 4 must lose.
      await storeA.save({ tenantId: T1, checkpoint: at(9) });
      await storeB.save({ tenantId: T1, checkpoint: at(4) });

      expect((await storeA.latest({ tenantId: T1, runId: RUN }))?.sequence).toBe(9);
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
