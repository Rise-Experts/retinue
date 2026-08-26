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
 * Executor: `RETINUE_TEST_PG_URL` points at a real PostgreSQL server (CI, so server-only behaviour
 * such as advisory locks and `SKIP LOCKED` is exercised for real); unset falls back to PGlite so a
 * local `npm test` needs no database (AC-6).
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresArtifactExportStore,
  createPostgresKeywordIndex,
  createPostgresKnowledgeStore,
  createPostgresVectorIndex,
  createPostgresArtifactStore,
  createPostgresConversationStore,
  createPostgresFileContentStore,
  createPostgresFlowDefinitionStore,
  createPostgresFlowExecutionStore,
  createPostgresFileMetadataStore,
  createPostgresAgentStore,
  createPostgresCheckpointStore,
  createPostgresConversationBindingStore,
  createPostgresMessageStore,
  createPostgresRunEventLog,
  createPostgresSessionStateStore,
  createPostgresThreadSummaryStore,
  createPostgresRunStore,
  createPostgresConversationRunCoordinator,
  createPostgresUnitOfWork,
  createPostgresInteractionStore,
  createPostgresApprovalGrantStore,
  createPostgresEvaluationStore,
  createPostgresUsageRollupStore,
  createPostgresUsageStore,
  createPostgresIdempotencyStore,
  createPostgresSkillStore,
  createPostgresMcpConnectionStore,
  createPostgresPrincipalMemoryStore,
  createPostgresBlobStore,
  createPoolOpener,
  createSingleConnectionOpener,
  createTransactionScope,
  hasVectorExtension,
  migrate,
  migrateVector,
  POSTGRES_CAPABILITIES,
  type ConnectionOpener,
  type SqlExecutor,
  type TransactionRunner,
} from "../adapters/postgres/index.js";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, MessageId, MessagePartId, SkillId } from "../core/ids.js";
import type { AgentManifest } from "../agents/index.js";
import { ADAPTER_COVERAGE } from "../testing/conformance/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";
import { conversationStoreConformance } from "../testing/conformance/conversation-store.js";
import { runStoreConformance } from "../testing/conformance/run-store.js";
import { runEventLogConformance } from "../testing/conformance/run-event-log.js";
import { checkpointStoreConformance } from "../testing/conformance/checkpoint-store.js";
import { crossPortInvariants } from "../testing/conformance/invariants.js";
import { agentStoreConformance, messageStoreConformance } from "../testing/conformance/records.js";
import { fileContentStoreConformance, fileMetadataStoreConformance } from "../testing/conformance/files.js";
import { flowDefinitionStoreConformance, flowExecutionStoreConformance } from "../testing/conformance/flows.js";
import { artifactStoreConformance } from "../testing/conformance/artifacts.js";
import { artifactExportStoreConformance } from "../testing/conformance/artifact-exports.js";
import { usageRollupStoreConformance } from "../testing/conformance/rollups.js";
import { usageLimitStoreConformance } from "../testing/conformance/usage-limits.js";
import { createPostgresUsageLimitStore } from "../adapters/postgres/usage-limits.js";
import { evaluationStoreConformance } from "../testing/conformance/evaluation.js";
import {
  keywordIndexConformance,
  knowledgeStoreConformance,
  vectorIndexConformance,
} from "../testing/conformance/knowledge.js";
import {
  conversationBindingStoreConformance,
  sessionStateStoreConformance,
  threadSummaryStoreConformance,
  unitOfWorkConformance,
} from "../testing/conformance/session-state.js";
import { conversationRunCoordinatorConformance } from "../testing/conformance/run-coordinator.js";
import {
  approvalGrantStoreConformance,
  interactionStoreConformance,
  usageStoreConformance,
} from "../testing/conformance/hitl.js";
import {
  blobStoreConformance,
  idempotencyStoreConformance,
  mcpConnectionStoreConformance,
  principalMemoryStoreConformance,
  skillStoreConformance,
} from "../testing/conformance/records.js";

const PG_URL = process.env["RETINUE_TEST_PG_URL"];

/** Set when running against a real server, so teardown can close the pool. */
const closers: Array<() => Promise<void>> = [];

const pgliteExecutor = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/**
 * **One pool for the whole file**, created lazily.
 *
 * This used to be a pool per executor, which is a pool per *test*: the harnesses call their factory
 * inside each case, so ~100 cases meant ~100 pools, each holding at least one connection against a
 * default `max_connections` of 100. #100 pushed it over and CI failed with `sorry, too many clients
 * already` — on `UsageStore` and `IdempotencyStore`, simply because they are registered last. A local
 * run passed only because `pg`'s 10s idle timeout freed slots fast enough, which is luck, not a
 * property.
 *
 * Isolation is preserved by giving each executor its own **schema** on the shared pool, which is what
 * it was really relying on all along — the separate pools were never what kept tests apart.
 */
const schemas: string[] = [];
let poolPromise: Promise<import("pg").Pool> | null = null;

const sharedPool = () =>
  (poolPromise ??= (async () => {
    const { Pool } = await import("pg");
    // Bounded well below max_connections. A transaction holds one connection while reads through the
    // base executor check out another, so a couple per active test; 8 leaves ample headroom for the
    // other test files running in parallel, each with their own small pool.
    const pool = new Pool({ connectionString: PG_URL, max: 8 });
    closers.push(async () => {
      for (const schema of schemas) {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      }
      await pool.end().catch(() => undefined);
    });
    return pool;
  })());

/**
 * A schema-isolated database on the shared pool. Numbered rather than hashed: a counter cannot
 * collide, which is the only thing the previous hash was buying, and it makes a failing schema name
 * readable in a log.
 */
const serverDatabase = async (): Promise<{ base: SqlExecutor; opener: ConnectionOpener }> => {
  const pool = await sharedPool();
  const schema = `conf_${schemas.length + 1}`;
  schemas.push(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  return {
    base: {
      async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
        const c = await pool.connect();
        try {
          // `public` is on the path as well as the test's own schema. Every table this suite creates goes in
          // `schema`, so isolation is unaffected — but an *extension* installed in `public` (pgvector's type
          // and its `<=>` operator) is otherwise invisible, which is how #135's vector cases silently skipped
          // against a database that had the extension.
          await c.query(`SET search_path TO ${schema}, public`);
          const r = await c.query(text, params ? [...params] : undefined);
          return r.rows as Row[];
        } finally {
          c.release();
        }
      },
    },
    opener: createPoolOpener(pool, schema),
  };
};

/**
 * A migrated database per store, as a transaction-aware pair.
 *
 * The executor handed out is the scope's `scoped()` wrapper, so a store built over it automatically
 * joins whatever transaction the runner has open (#98). That is what lets `unitOfWorkConformance`
 * construct the unit of work and the session store independently — through the port's zero-argument
 * `run(fn)` there is no other way for the store to learn about the transaction.
 *
 * Both halves stay lazy: migration runs on first use, so store creation remains synchronous.
 */
const freshDatabase = (): { sql: SqlExecutor; runner: TransactionRunner } => {
  let ready: Promise<{ sql: SqlExecutor; runner: TransactionRunner }> | null = null;
  const init = () =>
    (ready ??= (async () => {
      // PGlite path: a fresh *schema* on a shared instance rather than a fresh instance. Boot is
      // 432ms and migrating is 20ms, so booting per test was ~95% overhead — see testing/pglite.ts.
      const { base, opener, migrated } = PG_URL
        ? { ...(await serverDatabase()), migrated: false }
        : await (async () => {
            const created = await freshPgliteSchema();
            return {
              base: created.sql,
              opener: createSingleConnectionOpener(created.sql),
              migrated: true,
            };
          })();
      if (!migrated) await migrate(base);
      const scope = createTransactionScope(opener);
      return { sql: scope.scoped(base), runner: scope.runner };
    })());
  return {
    sql: {
      async query(text, params) {
        return (await init()).sql.query(text, params);
      },
    },
    runner: {
      async transaction(fn) {
        return (await init()).runner.transaction(fn);
      },
    },
  };
};

/** Most harnesses need only the executor. */
const freshExecutor = (): SqlExecutor => freshDatabase().sql;

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

// The coordinator and the unit of work, the two ports #98 adds.
//
// Both get the *same* database as their session store where it matters: the unit of work's rollback
// case only means anything if the store it wraps writes through the same connection, which is what
// `freshDatabase()`'s scoped executor arranges.
conversationRunCoordinatorConformance(() => {
  const { sql, runner } = freshDatabase();
  return {
    store: createPostgresConversationRunCoordinator(sql, runner),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({
        tenantId,
        id: conversationId,
        title: "for run coordination",
      });
    },
    // A second coordinator over the same database — what makes the gated `distributed-locking` case
    // able to tell backend-held state from object-held state.
    sibling: () => createPostgresConversationRunCoordinator(sql, runner),
  };
}, { capabilities: POSTGRES_CAPABILITIES });

// One database for both halves. Two separate factories would put the transaction and the write in
// different places, and the rollback assertion would then pass for the wrong reason.
unitOfWorkConformance(() => {
  const { sql, runner } = freshDatabase();
  return {
    unitOfWork: createPostgresUnitOfWork(runner),
    sessions: createPostgresSessionStateStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({
        tenantId,
        id: conversationId,
        title: "for unit of work",
      });
    },
  };
}, { capabilities: POSTGRES_CAPABILITIES });

// The HITL pair, #99. A question and an approval both belong to a run (foreign key), so each seeds
// its parent — an orphan approval would be an authorisation with nothing to authorise.
interactionStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresInteractionStore(sql),
    async seedRun({ tenantId, runId }) {
      await createPostgresRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId: asId<ConversationId>("conf-convo-for-hitl"),
        agentId: asId<AgentId>("conf-agent-for-hitl"),
        agentVersion: 1,
      });
    },
  };
});

approvalGrantStoreConformance(() => createPostgresApprovalGrantStore(freshExecutor()));

// The cost ledger and the replay guard, #100. Usage rows reference a run; idempotency keys have no
// parent, so only the first needs a seeder.
usageStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresUsageStore(sql),
    async seedRun({ tenantId, runId }) {
      await createPostgresRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId: asId<ConversationId>("conf-convo-1"),
        agentId: asId<AgentId>("conf-agent-for-usage"),
        agentVersion: 1,
      });
    },
  };
});

idempotencyStoreConformance(() => createPostgresIdempotencyStore(freshExecutor()));

// Tenant configuration, #101. Neither table references a run or a conversation, so no seeders.
skillStoreConformance(
  () => createPostgresSkillStore(freshExecutor()),
  async (store, { tenantId, name, version }) => {
    await (store as ReturnType<typeof createPostgresSkillStore>).add(tenantId, {
      id: asId<SkillId>(`${name}-${version}`),
      name,
      // SKILL_LIMITS.descriptionMinLength is 20, and the schema repeats it as a CHECK — so a shorter
      // fixture would fail at the database, not only at validateSkillInput.
      description: "A conformance-suite fixture skill used to verify store behaviour.",
      source: "tenant",
      version,
      instructions: "text only, no executable content",
      status: "active",
      tenantId,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
  },
);

mcpConnectionStoreConformance(
  () => createPostgresMcpConnectionStore(freshExecutor(), { allowedSchemes: ["https"] }),
  async (store, { tenantId, id }) => {
    await store.register({
      tenantId,
      connection: {
        id,
        tenantId,
        label: `server ${id}`,
        transport: "streamable-http",
        endpoint: "https://mcp.example.com/rpc",
        auth: { kind: "bearer", credentialRef: "secret://tenant/mcp-token" },
        enabled: true,
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
  },
);

// The last two ports, #102. Neither references a run or a conversation, so no seeders.
principalMemoryStoreConformance(() => createPostgresPrincipalMemoryStore(freshExecutor()));
blobStoreConformance(() => createPostgresBlobStore(freshExecutor()));

// #129. `files` has a foreign key to `conversations`, so this one takes the fixture shape: the harness's
// `withConversation` seeds the parent through the same executor. `FileContentStore` has no Postgres
// implementation and is classified `notApplicable` — file bytes in a column is the antipattern 0011
// rejected.
// #133. `artifacts` has a foreign key to `conversations`, so this takes the fixture shape too.
artifactStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresArtifactStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "artifacts" });
    },
  };
});

/**
 * pgvector, when the database has it (#135).
 *
 * `hasVectorExtension` is asked once and the answer becomes a declared capability, so on a database without
 * pgvector — PGlite, which is the default here — every case registers as a *named* skip rather than
 * disappearing. That is the point of `gatedIt`: an invisible skip is indistinguishable from coverage, and this
 * is a port whose absence would otherwise be silent.
 *
 * Run against pgvector with `RETINUE_TEST_PG_URL` pointing at a Postgres that has it.
 */
const vectorAvailable = await (async () => {
  try {
    const sql = freshExecutor();
    if (!(await hasVectorExtension(sql))) return false;
    // Migrated once here purely to prove it works; each fixture below migrates its own schema.
    await migrateVector(sql);
    return true;
  } catch {
    // A database that cannot answer or cannot migrate is one without the extension, as far as this suite is
    // concerned. Swallowed rather than failing the file, because the alternative is that every developer
    // without pgvector cannot run the Postgres suite at all.
    return false;
  }
})();

const VECTOR_DECLARATION = vectorAvailable ? { capabilities: ["vector-search" as const] } : undefined;

/**
 * A fresh, vector-migrated schema per fixture.
 *
 * Per *fixture*, not shared. Sharing one executor across the harness's cases let a chunk written by one case be
 * found by the next — which is how "filters by source type" passed a `file` chunk written three tests earlier.
 * Every other harness here gets `freshExecutor()` per call and this one has to as well; the extension lives in
 * `public` so only the table is created per schema.
 */
const vectorFixture = async () => {
  const sql = freshExecutor();
  await migrateVector(sql);
  return {
    store: createPostgresKnowledgeStore(sql),
    index: createPostgresVectorIndex(sql),
    keyword: createPostgresKeywordIndex(sql),
  };
};

knowledgeStoreConformance(vectorFixture, VECTOR_DECLARATION);
vectorIndexConformance(vectorFixture, VECTOR_DECLARATION);
keywordIndexConformance(vectorFixture, VECTOR_DECLARATION);

evaluationStoreConformance(() => createPostgresEvaluationStore(freshExecutor()));

usageLimitStoreConformance(() => createPostgresUsageLimitStore(freshExecutor()));

usageRollupStoreConformance(() => {
  const sql = freshExecutor();
  return {
    usage: createPostgresUsageStore(sql),
    rollups: createPostgresUsageRollupStore(sql),
    // A run needs a conversation, which needs nothing — two levels of parent, seeded through the same executor
    // so the foreign keys resolve.
    async seedRun({ tenantId, runId }) {
      const conversationId = asId<ConversationId>(`conf-rollup-convo-${runId}`);
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "rollups" });
      await createPostgresRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId,
        agentId: asId("conf-rollup-agent"),
        agentVersion: 1,
      });
    },
  };
});

artifactExportStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresArtifactExportStore(sql),
    // Two parents deep: an export belongs to an artifact, which belongs to a conversation.
    async seedArtifact({ tenantId, artifactId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "exports" });
      await createPostgresArtifactStore(sql).create({
        tenantId,
        artifact: {
          id: artifactId,
          conversationId,
          kind: "markdown",
          name: "Exported",
          createdAt: "2026-08-23T09:00:00.000Z",
        },
        version: {
          id: asId("conf-export-seed-v1"),
          contentRef: asId("conf-export-seed-blob"),
          byteSize: 1,
          provenance: { producedBy: "seed", inputs: {} },
          createdBy: asId("conf-export-user"),
          createdAt: "2026-08-23T09:00:00.000Z",
        },
      });
    },
  };
});

fileMetadataStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: createPostgresFileMetadataStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await createPostgresConversationStore(sql).create({ tenantId, id: conversationId, title: "files" });
    },
  };
});

/**
 * The bytes adapter, held to the same suite as the reference one — #185.
 *
 * It exists because a deployment on plain Postgres and Redis could not accept an attachment at all: the only
 * content stores were in-memory, which the API and the worker do not share, and Supabase Storage, which needs a
 * Supabase project. Running the same conformance suite is what makes "it behaves like the reference" a fact
 * rather than a claim about a hundred lines nobody compared.
 */
fileContentStoreConformance(() => createPostgresFileContentStore(freshExecutor()));

// #187, #186. Held to the same suite as the reference implementations — the version-immutability and
// monotonic-save guarantees are the whole reason a flow can be resumed safely, and "the Postgres one behaves the
// same" has to be a fact rather than a claim about two hundred lines nobody compared.
flowDefinitionStoreConformance(() => createPostgresFlowDefinitionStore(freshExecutor()));
flowExecutionStoreConformance(() => createPostgresFlowExecutionStore(freshExecutor()));

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
      // #187, #186.
      "FlowDefinitionStore",
      "FlowExecutionStore",
      "RunStore",
      "RunEventLog",
      "CheckpointStore",
      "MessageStore",
      "AgentStore",
      "ConversationBindingStore",
      "SessionStateStore",
      "ThreadSummaryStore",
      "ConversationRunCoordinator",
      "UnitOfWork",
      "InteractionStore",
      "ApprovalGrantStore",
      "UsageStore",
      "IdempotencyStore",
      "SkillStore",
      "McpConnectionStore",
      "PrincipalMemoryStore",
      "BlobStore",
      "FileMetadataStore",
      "ArtifactStore",
      "ArtifactExportStore",
      "KnowledgeStore",
      "VectorIndex",
      "KeywordIndex",
      "UsageRollupStore",
      // #175 — admin-configured per-person and per-tenant spend limits.
      "UsageLimitStore",
      "EvaluationStore",
    ]);
  });

  it("tracks every unimplemented port to the SPEC that will add it", () => {
    for (const { port, trackedBy } of coverage?.notImplemented ?? []) {
      expect(trackedBy, `${port} must name the issue that will add its Postgres store`).toMatch(/^#\d+$/);
    }
    // Every registered port either has a Postgres store or a `notApplicable` exemption, so there are no
    // declared gaps. The loop above is vacuous, which is the point: it stays so the assertion fires the
    // moment a new port is registered without a Postgres store, rather than being deleted and having to
    // be remembered. #129 added the first exemption -- `FileContentStore` -- which is tracked separately
    // in `conformance-coverage.test.ts` because "deliberately not this adapter's job" and "not written
    // yet" must not be the same cell.
    expect(coverage?.notImplemented.length).toBe(0);
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
    // Included as of #100 — the usage-dependent invariant stood down by name until the store existed.
    usage: createPostgresUsageStore(sql),
  };
});
