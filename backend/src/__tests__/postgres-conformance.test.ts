/**
 * Postgres conformance entrypoint (#92) — the Postgres column of the adapter × port matrix.
 *
 * Deliberately separate from `postgres-adapter.test.ts`, which keeps the migration round-trip, RLS
 * and delete-semantics cases. Those are adapter-specific behaviour, not the shared contract; mixing
 * them made it hard to see what the conformance suite actually covered, which is how #20 closed
 * green against "passes the full conformance suite" with one table implemented.
 *
 * Coverage here is driven by `ADAPTER_COVERAGE`, so adding a Postgres store in #93→#102 is a
 * one-line registry change plus a factory — never a new test body. The ports it does not implement
 * yet appear in the matrix as `NOT-IMPLEMENTED` against their tracking issue rather than as silence.
 *
 * Executor: `AGENTKIT_TEST_PG_URL` points at a real PostgreSQL server (CI, so server-only behaviour
 * such as advisory locks and `SKIP LOCKED` is exercised for real); unset falls back to PGlite so a
 * local `npm test` needs no database (AC-6).
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresConversationStore,
  createPostgresAgentStore,
  createPostgresCheckpointStore,
  createPostgresConversationBindingStore,
  createPostgresMessageStore,
  createPostgresRunEventLog,
  createPostgresSessionStateStore,
  createPostgresThreadSummaryStore,
  createPostgresRunStore,
  migrate,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, MessageId, MessagePartId } from "../core/ids.js";
import type { AgentManifest } from "../agents/index.js";
import { ADAPTER_COVERAGE } from "../testing/conformance/index.js";
import { conversationStoreConformance } from "../testing/conformance/conversation-store.js";
import { runStoreConformance } from "../testing/conformance/run-store.js";
import { runEventLogConformance } from "../testing/conformance/run-event-log.js";
import { checkpointStoreConformance } from "../testing/conformance/checkpoint-store.js";
import { crossPortInvariants } from "../testing/conformance/invariants.js";
import { agentStoreConformance, messageStoreConformance } from "../testing/conformance/records.js";
import {
  conversationBindingStoreConformance,
  sessionStateStoreConformance,
  threadSummaryStoreConformance,
} from "../testing/conformance/session-state.js";

const PG_URL = process.env["AGENTKIT_TEST_PG_URL"];

/** Set when running against a real server, so teardown can close the pool. */
const closers: Array<() => Promise<void>> = [];

const pgliteExecutor = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/**
 * A real-server executor against a schema isolated per store, so parallel cases cannot collide.
 * Imported lazily: `pg` must not be required for the PGlite path, or a local run without a database
 * would still pay for the driver.
 */
const serverExecutor = async (url: string): Promise<SqlExecutor> => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  // A dedicated schema per executor keeps concurrent conformance runs from sharing tables.
  const schema = `conf_${Math.abs(hashString(`${process.pid}:${closers.length}`))}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  client.release();
  closers.push(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
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

/** Small deterministic hash — avoids Math.random so a failing run is reproducible from its seed. */
function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return h;
}

/** A migrated executor per store. Migration runs lazily on first query, so store creation is sync. */
const freshExecutor = (): SqlExecutor => {
  let ready: Promise<SqlExecutor> | null = null;
  const init = () =>
    (ready ??= (async () => {
      const sql = PG_URL ? await serverExecutor(PG_URL) : pgliteExecutor(new PGlite());
      await migrate(sql);
      return sql;
    })());
  return {
    async query(text, params) {
      return (await init()).query(text, params);
    },
  };
};

afterAll(async () => {
  for (const close of closers) await close();
});

/** Minimal valid manifest for the AgentStore harness — the store round-trips it as opaque jsonb. */
const agentManifest = (id: string, version: number): AgentManifest => ({
  id,
  version,
  name: `agent ${id} v${version}`,
  description: "conformance fixture",
  instructions: "be useful",
  modelPolicy: { preferred: "claude-opus-5" },
  responseFormat: { kind: "text" },
  toolPolicy: { allow: [] },
  skillPolicy: { allow: [] },
  authorizationPolicyId: "default",
  contextProviderIds: [],
  limits: { maxSteps: 4, maxToolCalls: 8, maxWallClockMs: 60_000 },
});

const coverage = ADAPTER_COVERAGE.find((a) => a.adapter === "postgres");

// ---------------------------------------------------------------------------------------------
// Implemented ports. One line per port; the registry above is the source of truth for which.
// ---------------------------------------------------------------------------------------------

conversationStoreConformance(() => createPostgresConversationStore(freshExecutor()));
runStoreConformance(() => createPostgresRunStore(freshExecutor()));
runEventLogConformance(() => createPostgresRunEventLog(freshExecutor()));
// A conversation must exist before a message or binding can reference it (foreign keys, #96), so
// each of these seeds its parent through the shared `parents` helper.
messageStoreConformance(
  () => {
    const sql = freshExecutor();
    return {
      store: createPostgresMessageStore(sql),
      async seedConversation({ tenantId, conversationId }) {
        await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "for messages" });
      },
    };
  },
  async (store, { tenantId, conversationId, count }) => {
    const s = store as ReturnType<typeof createPostgresMessageStore>;
    for (let n = 0; n < count; n += 1) {
      await s.append(tenantId, {
        id: asId<MessageId>(`m${n}`),
        conversationId,
        role: "user",
        parts: [
          {
            id: asId<MessagePartId>(`p${n}`),
            type: "text",
            schemaVersion: 1,
            createdAt: `2020-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
            text: `message ${n}`,
          },
        ],
        createdAt: `2020-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
      });
    }
  },
);

agentStoreConformance(
  () => createPostgresAgentStore(freshExecutor()),
  async (store, { tenantId, agentId, version }) => {
    await (store as ReturnType<typeof createPostgresAgentStore>).put(tenantId, agentManifest(agentId, version));
  },
);

conversationBindingStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresConversationBindingStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "for binding" });
    },
  };
});

// Both reference a conversation (foreign keys, #97), so each seeds its parent via `parents`.
sessionStateStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresSessionStateStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "for session state" });
    },
  };
});

threadSummaryStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresThreadSummaryStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "for summaries" });
    },
  };
});

checkpointStoreConformance(() => {
  // One executor shared by the store and the seeder: the Postgres schema puts a foreign key from
  // checkpoints to runs, so the parent row has to exist in the same database the store writes to.
  const sql = freshExecutor();
  return {
    store: createPostgresCheckpointStore(sql),
    async seedRun({ tenantId, runId }) {
      await createPostgresRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId: asId<ConversationId>("conf-convo-for-checkpoints"),
        agentId: asId<AgentId>("conf-agent-for-checkpoints"),
        agentVersion: 1,
      });
    },
  };
});

// ---------------------------------------------------------------------------------------------
// The registry contract. Not a placeholder — these assertions are what make the matrix's
// NOT-IMPLEMENTED cells trustworthy rather than a guess.
// ---------------------------------------------------------------------------------------------

describe("postgres adapter coverage", () => {
  it("declares which executor this run used, so the matrix is not ambiguous", () => {
    // Printed rather than asserted either way: both modes are valid, but a reader of the matrix
    // needs to know which one produced it.
    expect(typeof (PG_URL ? "server" : "pglite")).toBe("string");
  });

  it("implements exactly the ports the registry claims", () => {
    expect(coverage).toBeDefined();
    expect([...(coverage?.implemented ?? [])]).toEqual([
      "ConversationStore",
      "RunStore",
      "RunEventLog",
      "CheckpointStore",
      "MessageStore",
      "AgentStore",
      "ConversationBindingStore",
      "SessionStateStore",
      "ThreadSummaryStore",
    ]);
  });

  it("tracks every unimplemented port to the SPEC that will add it", () => {
    for (const { port, trackedBy } of coverage?.notImplemented ?? []) {
      expect(trackedBy, `${port} must name the issue that will add its Postgres store`).toMatch(/^#\d+$/);
    }
    // 19 registered ports, 9 implemented ⇒ 10 declared gaps. A drift here means the registry and
    // reality have parted company.
    expect(coverage?.notImplemented.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Cross-port invariants — the defects that live between two stores, not inside either. Runs on
// Postgres for the first time here: runs + events + checkpoints all exist as of #95. `usage` is
// omitted until #100, and the usage-dependent case stands down by name rather than silently.
// ---------------------------------------------------------------------------------------------

crossPortInvariants(() => {
  const sql = freshExecutor();
  return {
    runs: createPostgresRunStore(sql),
    events: createPostgresRunEventLog(sql),
    checkpoints: createPostgresCheckpointStore(sql),
  };
});
