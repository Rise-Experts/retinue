/**
 * Scoped memory and the per-run columns against Postgres — #285, #286.
 *
 * #285's AC-1 asks for "a test against Postgres, :55433-style": the reference adapter proves the rule, and only a
 * real database proves the statement that enforces it. This file runs on PGlite by default and on a real server
 * when `RETINUE_TEST_PG_URL` is set, each case in a schema of its own, so the same assertions cover both.
 *
 * Two things here are specific to the SQL and invisible to the reference adapter:
 *
 * - `retrieve` binds the scope list as an array and matches `= ANY`. An empty array must match nothing, and a
 *   query spelled `scope = ANY($2) OR $2 IS NULL` — the obvious "optional filter" idiom — would match everything.
 * - The column constraints (`scope` shape, `status`, `effort`) are what stand between a process that writes around
 *   the port and a row the port would later misread.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionContext } from "../core/context.js";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, PrincipalId, RunId, TenantId } from "../core/ids.js";
import {
  commitExtractedScopedMemories,
  createScopedMemoryProvider,
} from "../principal-memory/index.js";
import {
  createPostgresRunStore,
  createPostgresScopedMemoryStore,
  createPostgresUsageStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const PG_URL = process.env["RETINUE_TEST_PG_URL"];
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers) await close();
});

let serverSchemas = 0;
/** A migrated, isolated database: a fresh schema on the real server when one is configured, else on PGlite. */
const database = async (): Promise<SqlExecutor> => {
  if (PG_URL === undefined) return (await freshPgliteSchema()).sql;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  const schema = `scoped_mem_${process.pid}_${(serverSchemas += 1)}`;
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  closers.push(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  });
  const sql: SqlExecutor = {
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schema}`);
        return (await client.query(text, params ? [...params] : undefined)).rows as Row[];
      } finally {
        client.release();
      }
    },
  };
  await migrate(sql);
  return sql;
};

const T1 = asId<TenantId>("pg-scoped-t1");
const T2 = asId<TenantId>("pg-scoped-t2");
const PROJECT = "project:pg-1";

const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  tenantId: T1,
  principalId: asId<PrincipalId>("alice"),
  roleIds: [],
  locale: "en",
  timezone: "UTC",
  requestId: asId("req"),
  conversationId: asId<ConversationId>("chat-1"),
  runId: asId<RunId>("run-1"),
  memoryScopes: [PROJECT],
  ...over,
});

describe(`scoped memory on Postgres (${PG_URL === undefined ? "PGlite" : "real server"})`, () => {
  it("AC-1: taught in one chat of a project, known in the next — and nowhere else", async () => {
    const store = createPostgresScopedMemoryStore(await database());
    await commitExtractedScopedMemories(store, { context: ctx(), candidates: [{ text: "Never say revolutionary" }] });

    const provider = createScopedMemoryProvider({ store });
    const next = await provider.provide(
      ctx({ principalId: asId<PrincipalId>("bob"), conversationId: asId<ConversationId>("chat-2"), runId: asId<RunId>("run-2") }),
    );
    expect(next.map((s) => s.body)).toEqual(["- Never say revolutionary"]);

    expect(await provider.provide(ctx({ memoryScopes: ["project:pg-2"] }))).toEqual([]);
    expect(await provider.provide(ctx({ tenantId: T2 }))).toEqual([]);

    // The source survived the round trip through the table.
    const [row] = (await store.list({ tenantId: T1, scope: PROJECT, limit: 10 })).items;
    expect(row).toMatchObject({ sourceConversationId: "chat-1", sourceRunId: "run-1", createdBy: "alice", status: "active" });
  });

  it("AC-2: forget is a hard delete, gone from the next turn and from the table", async () => {
    const sql = await database();
    const store = createPostgresScopedMemoryStore(sql);
    const [entry] = await commitExtractedScopedMemories(store, { context: ctx(), candidates: [{ text: "Forget me" }] });
    const provider = createScopedMemoryProvider({ store });
    expect(await provider.provide(ctx())).toHaveLength(1);

    await store.delete({ tenantId: T1, scope: PROJECT, id: entry!.id });
    expect(await provider.provide(ctx())).toEqual([]);
    const left = await sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM scoped_memory WHERE text = 'Forget me'`);
    expect(Number(left[0]?.n)).toBe(0);
  });

  it("an empty scope list binds an empty array that matches nothing", async () => {
    const store = createPostgresScopedMemoryStore(await database());
    await store.put({ tenantId: T1, scope: PROJECT, text: "a rule", source: { conversationId: null } });
    expect(await store.retrieve({ tenantId: T1, scopes: [], limit: 10 })).toEqual([]);
  });

  it("a proposed entry is excluded by the statement, not only by the provider", async () => {
    const store = createPostgresScopedMemoryStore(await database());
    await store.put({ tenantId: T1, scope: PROJECT, text: "pending", status: "proposed", source: { conversationId: null } });
    expect(await store.retrieve({ tenantId: T1, scopes: [PROJECT], limit: 10 })).toEqual([]);
  });

  it("re-teaching a switched-off lesson does not switch it back on", async () => {
    const store = createPostgresScopedMemoryStore(await database());
    const entry = await store.put({ tenantId: T1, scope: PROJECT, id: "m1", text: "v1", source: { conversationId: null } });
    await store.update({ tenantId: T1, scope: PROJECT, id: "m1", expectedVersion: entry.version, patch: { disabled: true } });
    const again = await store.put({ tenantId: T1, scope: PROJECT, id: "m1", text: "v2", source: { conversationId: null } });
    expect(again.disabledAt).toBeDefined();
    expect(await store.retrieve({ tenantId: T1, scopes: [PROJECT], limit: 10 })).toEqual([]);
  });
});

describe("migrations 0036 and 0037", () => {
  it("the column constraints refuse what the port would misread", async () => {
    const sql = await database();
    const insert = (scope: string, status: string) =>
      sql.query(
        `INSERT INTO scoped_memory (tenant_id, scope, id, text, salience, status, version, created_at, updated_at)
         VALUES ('t', $1, 'x', 'text', 1, $2, 1, now(), now())`,
        [scope, status],
      );
    await expect(insert("no-colon", "active")).rejects.toThrow();
    await expect(insert("Project:1", "active")).rejects.toThrow();
    await expect(insert("project:1", "maybe")).rejects.toThrow();
    await insert("project:1", "proposed");

    await expect(
      sql.query(
        `INSERT INTO runs (tenant_id, id, agent_id, agent_version, status, created_at, effort)
         VALUES ('t', 'r', 'a', 1, 'queued', now(), 'max')`,
      ),
    ).rejects.toThrow();
  });

  it("round-trips a run's model, effort and scopes, and a usage row's effort", async () => {
    const sql = await database();
    const runs = createPostgresRunStore(sql);
    await runs.create({
      tenantId: T1,
      id: asId<RunId>("r-pg"),
      agentId: asId<AgentId>("a"),
      agentVersion: 1,
      model: "claude-opus-5",
      effort: "medium",
      memoryScopes: [PROJECT],
    });
    expect(await runs.findById({ tenantId: T1, id: asId<RunId>("r-pg") })).toMatchObject({
      model: "claude-opus-5",
      effort: "medium",
      memoryScopes: [PROJECT],
    });

    const usage = createPostgresUsageStore(sql);
    const base = {
      runId: asId<RunId>("r-pg"),
      modelId: "claude-opus-5",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costMinorUnits: 1,
      currency: "USD",
      occurredAt: new Date().toISOString(),
    };
    await usage.append({ tenantId: T1, event: { ...base, id: "u1", tenantId: T1, stepId: "1", effort: "medium" } });
    await usage.append({ tenantId: T1, event: { ...base, id: "u2", tenantId: T1, stepId: "2" } });
    const rows = (await usage.listByRun({ tenantId: T1, runId: asId<RunId>("r-pg"), limit: 10 })).items;
    expect(rows.map((r) => r.effort)).toEqual(["medium", undefined]);
  });

  it("roll back cleanly and re-apply", async () => {
    const sql = await database();
    await rollback(sql);
    await expect(sql.query(`SELECT 1 FROM scoped_memory LIMIT 1`)).rejects.toThrow();
    await migrate(sql);
    await sql.query(`SELECT model, effort, memory_scopes FROM runs LIMIT 1`);
    await sql.query(`SELECT effort FROM usage_records LIMIT 1`);
    await sql.query(`SELECT 1 FROM scoped_memory LIMIT 1`);
  });
});
