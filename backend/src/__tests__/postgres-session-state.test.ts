/**
 * Postgres `SessionStateStore` / `ThreadSummaryStore` — adapter-specific cases (#97).
 *
 * Two of these carry the weight. **AC-2** across two connections: the harness runs both writers
 * through one executor, so its "one wins" result follows from JavaScript being single-threaded rather
 * than from the database adjudicating — and a lost update on session state means an assistant
 * silently forgetting what it was told. **AC-5** as reworded: the port has no read-by-version, so
 * "older versions are retained" can only be asserted against the table.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { ConversationId, MessageId, TenantId } from "../core/ids.js";
import {
  createPostgresConversationStore,
  createPostgresSessionStateStore,
  createPostgresThreadSummaryStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";
import { DEFAULT_SESSION_STATE_MAX_BYTES } from "../persistence/index.js";

const T1 = asId<TenantId>("pg-ss-t1");
const T2 = asId<TenantId>("pg-ss-t2");
const C1 = asId<ConversationId>("pg-ss-c1");
const MSG = asId<MessageId>("pg-ss-m1");
const PG_URL = process.env["RETINUE_TEST_PG_URL"];

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const seeded = async (): Promise<SqlExecutor> => {
  const { sql } = await freshPgliteSchema();
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "thread" });
  return sql;
};

describe("migration 0006", () => {
  it("stores the summary boundary as a message id, not a timestamp", async () => {
    const sql = await seeded();
    const cols = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'thread_summaries' AND table_schema = current_schema()`,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    // The SPEC had `covers_up_to timestamptz`. A summary covers history up to a specific *message*;
    // a timestamp could not identify the boundary the assembler keeps everything after.
    expect(byName.get("covers_up_to_message_id")).toBe("text");
    expect(byName.has("covers_up_to")).toBe(false);
    // And `summary` is a string, not jsonb; `token_estimate` had nothing to populate it.
    expect(byName.get("summary")).toBe("text");
    expect(byName.has("token_estimate")).toBe(false);
  });

  it("migrates up, rolls back, and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    for (const t of ["session_state", "thread_summaries"]) await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM session_state LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM session_state LIMIT 1");
  });

  it("removes both tables' rows with their conversation", async () => {
    const sql = await seeded();
    const state = createPostgresSessionStateStore(sql);
    const summaries = createPostgresThreadSummaryStore(sql);
    await state.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { a: 1 } });
    await summaries.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });

    await sql.query(`DELETE FROM conversations WHERE tenant_id = $1 AND id = $2`, [T1, C1]);

    expect(await state.get({ tenantId: T1, conversationId: C1 })).toBeNull();
    expect(await summaries.latest({ tenantId: T1, conversationId: C1 })).toBeNull();
  });

  it("refuses state for a conversation that does not exist", async () => {
    const { sql } = await freshPgliteSchema();
    await expect(
      createPostgresSessionStateStore(sql).put({
        tenantId: T1,
        conversationId: C1,
        expectedVersion: 0,
        data: {},
      }),
    ).rejects.toThrow();
  });
});

describe("session state round-trip and bounds", () => {
  it("round-trips nested data under deep equality", async () => {
    const sql = await seeded();
    const store = createPostgresSessionStateStore(sql);
    const data = {
      brandVoice: "concise",
      approvedClaims: ["fast", "secure"],
      nested: { counts: { drafts: 3 }, flags: [true, false] },
    };
    const put = await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data });
    expect(put.data).toEqual(data);
    expect((await store.get({ tenantId: T1, conversationId: C1 }))?.data).toEqual(data);
  });

  it("rejects a write past the shared ceiling", async () => {
    const sql = await seeded();
    const store = createPostgresSessionStateStore(sql);
    // The ceiling now lives with the port, so this is the same constant the memory adapter enforces —
    // the two cannot drift into disagreeing about what is storable.
    const oversized = { blob: "x".repeat(DEFAULT_SESSION_STATE_MAX_BYTES + 1_000) };
    await expect(
      store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: oversized }),
    ).rejects.toThrow(/ceiling/);
    // And nothing was written — a rejected write must not leave a partial row.
    expect(await store.get({ tenantId: T1, conversationId: C1 })).toBeNull();
  });

  it("reports the current version when rejecting a stale write", async () => {
    const sql = await seeded();
    const store = createPostgresSessionStateStore(sql);
    await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { n: 1 } });
    await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { n: 2 } });
    // The message has to name the current version, or a caller cannot recover without another read.
    await expect(
      store.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { n: 99 } }),
    ).rejects.toThrow(/current 2/);
  });

  it("serves the lookup from the primary key", async () => {
    const sql = await seeded();
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT state FROM session_state WHERE tenant_id = $1 AND conversation_id = $2`,
      [T1, C1],
    );
    expect(plan.map((r) => Object.values(r)[0]).join("\n")).not.toContain("Seq Scan");
  });
});

/**
 * AC-3. The store uses whatever executor it is handed, so a transaction-scoped one puts the write in
 * that transaction — which is what lets session state commit atomically with the run result (SPEC
 * #26) without this store knowing transactions exist.
 */
describe("session state inside the caller's transaction", () => {
  it("leaves nothing behind when the transaction rolls back", async () => {
    const { db, sql } = await freshPgliteSchema();
    await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "t" });
    const store = createPostgresSessionStateStore(sql);

    await db.query("BEGIN");
    await store.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { staged: true } });
    expect(await store.get({ tenantId: T1, conversationId: C1 })).not.toBeNull();
    await db.query("ROLLBACK");

    expect(await store.get({ tenantId: T1, conversationId: C1 })).toBeNull();
  });
});

/**
 * AC-5 as reworded. `ThreadSummaryStore` has no read-by-version, so "older versions remain
 * retrievable" could not be asserted through the port — this asserts what is actually true: they are
 * retained rather than overwritten.
 */
describe("thread summary versioning", () => {
  it("keeps older versions in storage while latest returns the newest", async () => {
    const sql = await seeded();
    const store = createPostgresThreadSummaryStore(sql);
    const v1 = await store.append({ tenantId: T1, conversationId: C1, summary: "first", coversUpToMessageId: MSG });
    const v2 = await store.append({ tenantId: T1, conversationId: C1, summary: "second", coversUpToMessageId: MSG });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await store.latest({ tenantId: T1, conversationId: C1 }))?.summary).toBe("second");

    // Queried directly, because the port cannot read an older version. If it gains that method, this
    // becomes a port-level assertion instead.
    const rows = await sql.query<{ version: number; summary: string }>(
      `SELECT version, summary FROM thread_summaries
        WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY version`,
      [T1, C1],
    );
    expect(rows).toEqual([
      { version: 1, summary: "first" },
      { version: 2, summary: "second" },
    ]);
  });

  it("keeps the boundary message id per version", async () => {
    const sql = await seeded();
    const store = createPostgresThreadSummaryStore(sql);
    const other = asId<MessageId>("pg-ss-m2");
    await store.append({ tenantId: T1, conversationId: C1, summary: "a", coversUpToMessageId: MSG });
    const second = await store.append({ tenantId: T1, conversationId: C1, summary: "b", coversUpToMessageId: other });
    expect(second.coversUpToMessageId).toBe(other);
  });

  it("enforces tenant isolation", async () => {
    const sql = await seeded();
    const store = createPostgresThreadSummaryStore(sql);
    await store.append({ tenantId: T1, conversationId: C1, summary: "s", coversUpToMessageId: MSG });
    expect(await store.latest({ tenantId: T2, conversationId: C1 })).toBeNull();
  });
});

/**
 * AC-2 across two connections — the case the harness structurally cannot demonstrate. A lost update
 * here means an assistant forgetting a fact it was just told, silently.
 */
describe("stale-version rejection across two connections", () => {
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
      expect(PG_URL).toBeUndefined();
    });
  } else {
    it("admits exactly one writer when both hold the same expected version", async () => {
      const schema = "conf_ss_race";
      const setup = await serverExecutor("public");
      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await setup.query(`CREATE SCHEMA ${schema}`);
      const a = await serverExecutor(schema);
      const b = await serverExecutor(schema);
      await migrate(a);
      await createPostgresConversationStore(a).create({ tenantId: T1, id: C1, title: "race" });

      const storeA = createPostgresSessionStateStore(a);
      const storeB = createPostgresSessionStateStore(b);
      await storeA.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { turn: 1 } });

      // Both readers saw version 1 and both write against it. One must lose.
      const results = await Promise.allSettled([
        storeA.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { turn: "a" } }),
        storeB.put({ tenantId: T1, conversationId: C1, expectedVersion: 1, data: { turn: "b" } }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

      // And the surviving state is one writer's, not a blend of both.
      const persisted = await storeA.get({ tenantId: T1, conversationId: C1 });
      expect(persisted?.version).toBe(2);
      expect(["a", "b"]).toContain((persisted?.data as { turn?: string }).turn);

      await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
});
