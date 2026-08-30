/**
 * Postgres `MessageStore` / `AgentStore` / `ConversationBindingStore` — adapter-specific cases
 * beyond the shared harnesses (#96).
 *
 * The headline one is paging under concurrent inserts. The harness pages a static conversation, which
 * a naive `OFFSET` pager passes just as happily as a keyset one — so it cannot distinguish them. AC-2
 * is about a conversation still being written to while a client reads it, and that needs live inserts
 * between pages.
 */

import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_EXECUTION_LIMITS } from "../agents/define.js";
import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type {
  AgentId,
  ConversationId,
  MessageId,
  MessagePartId,
  TenantId,
} from "../core/ids.js";
import type { Message } from "../core/content-parts.js";
import type { AgentManifest } from "../agents/index.js";
import {
  createPostgresAgentStore,
  createPostgresConversationBindingStore,
  createPostgresConversationStore,
  createPostgresMessageStore,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-msg-t1");
const T2 = asId<TenantId>("pg-msg-t2");
const C1 = asId<ConversationId>("pg-msg-c1");
const AGENT = asId<AgentId>("pg-msg-a1");

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const migrated = async (): Promise<SqlExecutor> => {
  const { sql } = await freshPgliteSchema();
  return sql;
};

const withConversation = async (): Promise<SqlExecutor> => {
  const sql = await migrated();
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "thread" });
  return sql;
};

/** `n` zero-padded so lexical and numeric order agree — the ordering under test is the store's. */
const msg = (n: number, overrides: Partial<Message> = {}): Message => ({
  id: asId<MessageId>(`m${String(n).padStart(4, "0")}`),
  conversationId: C1,
  role: "user",
  parts: [
    {
      id: asId<MessagePartId>(`p${String(n).padStart(4, "0")}`),
      type: "text",
      schemaVersion: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      text: `body ${n}`,
    },
  ],
  // All rows share one timestamp on purpose: it forces the `id` tiebreak to carry the ordering,
  // which is precisely the case a timestamp-only cursor gets wrong.
  createdAt: "2020-01-01T00:00:00.000Z",
  ...overrides,
});

describe("migration 0005", () => {
  it("keys agents per version, so an old version stays resolvable", async () => {
    const sql = await migrated();
    const pk = await sql.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'agents' AND tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    // The SPEC gave no primary key at all; findByVersion({agentId, version}) implies this one.
    expect(pk.map((r) => r.column_name)).toEqual(["tenant_id", "id", "version"]);
  });

  it("stores the binding policy the SPEC omitted", async () => {
    const sql = await migrated();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_bindings' AND table_schema = current_schema()`,
    );
    expect(cols.map((c) => c.column_name)).toContain("agent_version_policy");
  });

  it("refuses a pinned binding with no version", async () => {
    const sql = await withConversation();
    // The pair must agree: 'pinned' without a version is a binding that cannot be honoured.
    await expect(
      sql.query(
        `INSERT INTO conversation_bindings
           (tenant_id, conversation_id, agent_id, agent_version_policy, agent_version, bound_at)
         VALUES ($1, $2, $3, 'pinned', NULL, now())`,
        [T1, C1, AGENT],
      ),
    ).rejects.toThrow();
  });

  it("refuses an unknown version policy", async () => {
    const sql = await withConversation();
    await expect(
      sql.query(
        `INSERT INTO conversation_bindings
           (tenant_id, conversation_id, agent_id, agent_version_policy, agent_version, bound_at)
         VALUES ($1, $2, $3, 'whenever', NULL, now())`,
        [T1, C1, AGENT],
      ),
    ).rejects.toThrow();
  });

  it("migrates up, rolls back, and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    for (const t of ["messages", "agents", "conversation_bindings"]) {
      await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    }
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM messages LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM messages LIMIT 1");
  });

  it("removes messages and bindings with their conversation", async () => {
    const sql = await withConversation();
    const messages = createPostgresMessageStore(sql);
    const bindings = createPostgresConversationBindingStore(sql);
    await messages.append({ tenantId: T1, message: msg(1) });
    await bindings.bind({ tenantId: T1, conversationId: C1, agentId: AGENT, agentVersionPolicy: "latest" });

    await sql.query(`DELETE FROM conversations WHERE tenant_id = $1 AND id = $2`, [T1, C1]);

    expect((await messages.listByConversation({ tenantId: T1, conversationId: C1, limit: 10 })).items).toHaveLength(0);
    expect(await bindings.get({ tenantId: T1, conversationId: C1 })).toBeNull();
  });

  it("refuses a message for a conversation that does not exist", async () => {
    const sql = await migrated();
    await expect(createPostgresMessageStore(sql).append({ tenantId: T1, message: msg(1) })).rejects.toThrow();
  });
});

describe("message round-trip and validation", () => {
  it("preserves a mixed-part message under deep equality", async () => {
    const sql = await withConversation();
    const store = createPostgresMessageStore(sql);
    const mixed = msg(1, {
      role: "assistant",
      parts: [
        {
          id: asId<MessagePartId>("p-text"),
          type: "text",
          schemaVersion: 1,
          createdAt: "2020-01-01T00:00:01.000Z",
          text: "here is the result",
        },
        {
          id: asId<MessagePartId>("p-tool"),
          type: "tool-result",
          schemaVersion: 1,
          createdAt: "2020-01-01T00:00:02.000Z",
          toolCallId: asId("tc1"),
          toolName: "search_web",
          // The field is `output`, not `result`, and `truncated` is required — the spill flag that
          // says whether the payload is inline or referenced. Getting this wrong first time is what
          // the read-side validation is for.
          output: { ok: true, hits: 3 },
          truncated: false,
        },
      ] as Message["parts"],
    });
    await store.append({ tenantId: T1, message: mixed });
    // Deep equality: a dropped nested field inside a tool result is exactly the loss a shallower
    // assertion misses.
    expect(await store.findById({ tenantId: T1, id: mixed.id })).toEqual(mixed);
  });

  it("raises a typed error naming the message when parts are corrupt (AC-5)", async () => {
    const sql = await withConversation();
    const store = createPostgresMessageStore(sql);
    await sql.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, role, parts, created_at)
       VALUES ($1, 'bad-msg', $2, 'user', '[{"nonsense": true}]'::jsonb, now())`,
      [T1, C1],
    );
    // The id has to appear in the message, or a bad row means grepping a table to find it.
    await expect(store.findById({ tenantId: T1, id: asId<MessageId>("bad-msg") })).rejects.toThrow(/bad-msg/);
  });

  it("raises rather than returning a half-built message when parts is not an array", async () => {
    const sql = await withConversation();
    const store = createPostgresMessageStore(sql);
    await sql.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, role, parts, created_at)
       VALUES ($1, 'obj-msg', $2, 'user', '{"not": "an array"}'::jsonb, now())`,
      [T1, C1],
    );
    await expect(store.findById({ tenantId: T1, id: asId<MessageId>("obj-msg") })).rejects.toThrow(/obj-msg/);
  });
});

/**
 * AC-2, properly. The harness pages a conversation nobody is writing to, which an `OFFSET` pager
 * survives — so this inserts between pages, which is what a live conversation actually does.
 */
describe("paging under concurrent inserts (AC-2)", () => {
  it("pages a 500-message conversation with no duplicate and no skip while more arrive", async () => {
    const sql = await withConversation();
    const store = createPostgresMessageStore(sql);
    for (let n = 0; n < 500; n += 1) await store.append({ tenantId: T1, message: msg(n) });

    const seen: string[] = [];
    let cursor: string | undefined;
    let inserted = 500;
    for (let page = 0; page < 12; page += 1) {
      const result = await store.listByConversation({
        tenantId: T1,
        conversationId: C1,
        limit: 40,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map((m) => m.id));
      // A new message lands mid-pagination, exactly as it would in a live thread.
      await store.append({ tenantId: T1, message: msg(inserted) });
      inserted += 1;
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }

    // No id appears twice: an OFFSET pager would repeat rows as earlier inserts shift the window.
    expect(new Set(seen).size).toBe(seen.length);
    // And the run we walked is contiguous in the store's order — nothing was stepped over.
    const sorted = [...seen].sort();
    expect(seen).toEqual(sorted);
  });

  it("serves the paging query from its index", async () => {
    const sql = await withConversation();
    await createPostgresMessageStore(sql).append({ tenantId: T1, message: msg(1) });
    const plan = await sql.query<Record<string, string>>(
      `EXPLAIN SELECT * FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND (created_at, id) > ($3::timestamptz, $4)
        ORDER BY created_at, id LIMIT 10`,
      [T1, C1, "2020-01-01T00:00:00.000Z", "m0000"],
    );
    const text = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(text).not.toContain("Seq Scan");
  });
});

describe("agent and binding specifics", () => {
  const manifest = (id: string, version: number): AgentManifest => ({
    id,
    version,
    name: `agent ${id} v${version}`,
    description: "fixture",
    instructions: "be useful",
    modelPolicy: { role: "smart" },
    responseFormat: { kind: "text" },
    toolPolicy: { preloaded: [], categories: [], excluded: [] },
    skillPolicy: { assigned: [], allowTenantSkills: false },
    authorizationPolicyId: "default",
    contextProviderIds: [],
    limits: { ...DEFAULT_EXECUTION_LIMITS, maxSteps: 4, maxToolCalls: 8, wallClockTimeoutMs: 60_000 },
  });

  it("keeps v1 resolvable after v2 is registered", async () => {
    const sql = await migrated();
    const store = createPostgresAgentStore(sql);
    await store.put(T1, manifest("a", 1));
    await store.put(T1, manifest("a", 2));
    // A thread pinned to v1 must still resolve v1 — that is what per-version keying buys.
    expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 1 })).toMatchObject({ version: 1 });
    expect(await store.findByVersion({ tenantId: T1, agentId: "a", version: 2 })).toMatchObject({ version: 2 });
  });

  it("does not leak a manifest across tenants", async () => {
    const sql = await migrated();
    const store = createPostgresAgentStore(sql);
    await store.put(T1, manifest("a", 1));
    // The regression #91 found in the in-memory adapter, asserted for Postgres too.
    expect(await store.findByVersion({ tenantId: T2, agentId: "a", version: 1 })).toBeNull();
  });

  it("round-trips a pinned binding and then a re-bind to latest", async () => {
    const sql = await withConversation();
    const store = createPostgresConversationBindingStore(sql);
    await store.bind({
      tenantId: T1,
      conversationId: C1,
      agentId: AGENT,
      agentVersionPolicy: "pinned",
      agentVersion: 3,
    });
    expect(await store.get({ tenantId: T1, conversationId: C1 })).toEqual({
      conversationId: C1,
      agentId: AGENT,
      agentVersionPolicy: "pinned",
      agentVersion: 3,
    });

    await store.bind({ tenantId: T1, conversationId: C1, agentId: AGENT, agentVersionPolicy: "latest" });
    const rebound = await store.get({ tenantId: T1, conversationId: C1 });
    expect(rebound?.agentVersionPolicy).toBe("latest");
    // Absent, not null: a `latest` binding has no version, and a null would round-trip as
    // present-but-empty.
    expect(rebound && "agentVersion" in rebound).toBe(false);
  });
});
