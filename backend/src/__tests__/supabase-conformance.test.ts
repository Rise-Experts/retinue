/**
 * Supabase conformance entrypoint (#92, widened to all 19 ports by #104).
 *
 * This column needs no hosted Supabase project and no CI secrets. Every Supabase store is an **alias**
 * of the PostgreSQL implementation, so the column's real job is to prove two things the alias approach
 * depends on: that each alias still resolves to the Postgres function, and that the stores behave
 * identically when reached through the Supabase surface.
 *
 * **Why this column does not run under RLS**, since "run the whole harness with policies on" sounds
 * strictly better: the harnesses touch two tenants inside a single test — that is how they assert
 * isolation. Under `FORCE`d row-level security a session is bound to one tenant, so those writes would
 * be refused for reasons unrelated to the property under test, and the suite would be measuring the
 * harness rather than the store. RLS is verified exhaustively and per-table by `supabase-rls.test.ts`,
 * and the cases at the bottom of this file cover store behaviour *under* a bound tenant.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as supabase from "../adapters/supabase/index.js";
import * as postgres from "../adapters/postgres/index.js";
import {
  createSingleConnectionOpener,
  createTransactionScope,
  migrate,
  type SqlExecutor,
  type TransactionRunner,
} from "../adapters/postgres/index.js";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, MessageId, MessagePartId, SkillId } from "../core/ids.js";
import type { AgentManifest } from "../agents/index.js";
import { ADAPTER_COVERAGE, REGISTERED_PORTS, SUPABASE_NATIVE } from "../testing/conformance/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";
import { conversationStoreConformance } from "../testing/conformance/conversation-store.js";
import { runStoreConformance } from "../testing/conformance/run-store.js";
import { runEventLogConformance } from "../testing/conformance/run-event-log.js";
import { checkpointStoreConformance } from "../testing/conformance/checkpoint-store.js";
import { agentStoreConformance, messageStoreConformance } from "../testing/conformance/records.js";
import {
  fileContentStoreConformance,
  fileMetadataStoreConformance,
} from "../testing/conformance/files.js";
import { artifactStoreConformance } from "../testing/conformance/artifacts.js";
import { artifactExportStoreConformance } from "../testing/conformance/artifact-exports.js";
import { usageRollupStoreConformance } from "../testing/conformance/rollups.js";
import { evaluationStoreConformance } from "../testing/conformance/evaluation.js";
import {
  keywordIndexConformance,
  knowledgeStoreConformance,
  vectorIndexConformance,
} from "../testing/conformance/knowledge.js";
import { hasVectorExtension, migrateVector } from "../adapters/postgres/migrations.js";
import { supabaseStorageDouble } from "../testing/supabase-storage-double.js";
import {
  blobStoreConformance,
  idempotencyStoreConformance,
  mcpConnectionStoreConformance,
  principalMemoryStoreConformance,
  skillStoreConformance,
} from "../testing/conformance/records.js";
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

const pgliteSql = (db: PGlite): SqlExecutor => ({
  query: (text, params) => db.query(text, params ? [...params] : undefined).then((r) => r.rows as never),
});

/**
 * A migrated database plus its transaction runner, lazily so store creation stays synchronous.
 *
 * A fresh *schema* on a shared PGlite instance rather than a fresh instance: boot is 432ms and
 * migrating is 20ms, so a per-test instance was almost entirely overhead. See testing/pglite.ts.
 */
const freshDatabase = (): { sql: SqlExecutor; runner: TransactionRunner } => {
  let ready: Promise<{ sql: SqlExecutor; runner: TransactionRunner }> | null = null;
  const init = () =>
    (ready ??= (async () => {
      const { sql: base } = await freshPgliteSchema();
      const scope = createTransactionScope(createSingleConnectionOpener(base));
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

const freshExecutor = (): SqlExecutor => freshDatabase().sql;

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

const coverage = ADAPTER_COVERAGE.find((a) => a.adapter === "supabase");

// ---------------------------------------------------------------------------------------------
// All 19 ports, through the Supabase surface.
// ---------------------------------------------------------------------------------------------

conversationStoreConformance(() => supabase.createSupabaseConversationStore(freshExecutor()));
runStoreConformance(() => supabase.createSupabaseRunStore(freshExecutor()));
runEventLogConformance(() => supabase.createSupabaseRunEventLog(freshExecutor()));

messageStoreConformance(
  () => {
    const sql = freshExecutor();
    return {
      store: supabase.createSupabaseMessageStore(sql),
      async seedConversation({ tenantId, conversationId }) {
        await supabase
          .createSupabaseConversationStore(sql)
          .create({ tenantId, id: conversationId, title: "for messages" });
      },
    };
  },
);

agentStoreConformance(
  () => supabase.createSupabaseAgentStore(freshExecutor()),
  async (store, { tenantId, agentId, version }) => {
    await (store as ReturnType<typeof supabase.createSupabaseAgentStore>).put(
      tenantId,
      agentManifest(agentId, version),
    );
  },
);

const withConversationSeeder = <T>(make: (sql: SqlExecutor) => T, title: string) => () => {
  const sql = freshExecutor();
  return {
    store: make(sql),
    async seedConversation({ tenantId, conversationId }: { tenantId: never; conversationId: never }) {
      await supabase.createSupabaseConversationStore(sql).create({ tenantId, id: conversationId, title });
    },
  };
};

conversationBindingStoreConformance(
  withConversationSeeder((sql) => supabase.createSupabaseConversationBindingStore(sql), "for binding"),
);
sessionStateStoreConformance(
  withConversationSeeder((sql) => supabase.createSupabaseSessionStateStore(sql), "for session state"),
);
threadSummaryStoreConformance(
  withConversationSeeder((sql) => supabase.createSupabaseThreadSummaryStore(sql), "for summaries"),
);

checkpointStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: supabase.createSupabaseCheckpointStore(sql),
    async seedRun({ tenantId, runId }) {
      await supabase.createSupabaseRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId: asId<ConversationId>("conf-convo-for-checkpoints"),
        agentId: asId<AgentId>("conf-agent-for-checkpoints"),
        agentVersion: 1,
      });
    },
  };
});

conversationRunCoordinatorConformance(
  () => {
    const { sql, runner } = freshDatabase();
    return {
      store: supabase.createSupabaseConversationRunCoordinator(sql, runner),
      async seedConversation({ tenantId, conversationId }) {
        await supabase
          .createSupabaseConversationStore(sql)
          .create({ tenantId, id: conversationId, title: "for run coordination" });
      },
      sibling: () => supabase.createSupabaseConversationRunCoordinator(sql, runner),
    };
  },
  { capabilities: supabase.SUPABASE_CAPABILITIES },
);

unitOfWorkConformance(() => {
  const { sql, runner } = freshDatabase();
  return {
    unitOfWork: supabase.createSupabaseUnitOfWork(runner),
    sessions: supabase.createSupabaseSessionStateStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await supabase
        .createSupabaseConversationStore(sql)
        .create({ tenantId, id: conversationId, title: "for unit of work" });
    },
  };
}, { capabilities: supabase.SUPABASE_CAPABILITIES });

const withRunSeeder = <T>(make: (sql: SqlExecutor) => T) => () => {
  const sql = freshExecutor();
  return {
    store: make(sql),
    async seedRun({ tenantId, runId }: { tenantId: never; runId: never }) {
      await supabase.createSupabaseRunStore(sql).create({
        tenantId,
        id: runId,
        conversationId: asId<ConversationId>("conf-convo-1"),
        agentId: asId<AgentId>("conf-agent-for-hitl"),
        agentVersion: 1,
      });
    },
  };
};

interactionStoreConformance(withRunSeeder((sql) => supabase.createSupabaseInteractionStore(sql)));
approvalGrantStoreConformance(() => supabase.createSupabaseApprovalGrantStore(freshExecutor()));
usageStoreConformance(withRunSeeder((sql) => supabase.createSupabaseUsageStore(sql)));
idempotencyStoreConformance(() => supabase.createSupabaseIdempotencyStore(freshExecutor()));

skillStoreConformance(
  () => supabase.createSupabaseSkillStore(freshExecutor()),
  async (store, { tenantId, name, version }) => {
    await (store as ReturnType<typeof supabase.createSupabaseSkillStore>).add(tenantId, {
      id: asId<SkillId>(`${name}-${version}`),
      name,
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
  () => supabase.createSupabaseMcpConnectionStore(freshExecutor(), { allowedSchemes: ["https"] }),
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

principalMemoryStoreConformance(() => supabase.createSupabasePrincipalMemoryStore(freshExecutor()));
blobStoreConformance(() => supabase.createSupabaseBlobStore(freshExecutor()));

// #129. Runs the harness through the Supabase entrypoint even though the alias assertion below proves it
// is the same function: identity is the strong claim, but it is asserted in one test, and a suite that
// only asserted identity would go green if the alias were repointed at a stub that satisfied `toBe`.
// #129. The one port where Supabase is not Postgres: bytes live in Supabase Storage, so this runs the
// adapter over an in-process double of the Storage REST API. It belongs in *this* file because the matrix
// generator reads one conformance entrypoint per adapter — a harness run elsewhere passes while the matrix
// reports the port as uncovered, which is the failure mode the generator exists to prevent.
fileContentStoreConformance(() => supabaseStorageDouble().store);

artifactStoreConformance(() => {
  const sql = freshExecutor();
  return {
    store: supabase.createSupabaseArtifactStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await supabase
        .createSupabaseConversationStore(sql)
        .create({ tenantId, id: conversationId, title: "artifacts" });
    },
  };
});

// #135. Gated on the extension, exactly as the Postgres suite is: Supabase ships pgvector, but the executor
// this suite runs against may not, and a silent skip would read as coverage.
const vectorAvailable = await (async () => {
  try {
    const sql = freshExecutor();
    if (!(await hasVectorExtension(sql))) return false;
    await migrateVector(sql);
    return true;
  } catch {
    return false;
  }
})();
const VECTOR_DECLARATION = vectorAvailable ? { capabilities: ["vector-search" as const] } : undefined;
const vectorFixture = async () => {
  // A fresh schema per fixture: sharing one let a chunk written by one case be found by the next.
  const sql = freshExecutor();
  await migrateVector(sql);
  await supabase.applyVectorRls(sql).catch(() => undefined);
  return {
    store: supabase.createSupabaseKnowledgeStore(sql),
    index: supabase.createSupabaseVectorIndex(sql),
    keyword: supabase.createSupabaseKeywordIndex(sql),
  };
};
knowledgeStoreConformance(vectorFixture, VECTOR_DECLARATION);
vectorIndexConformance(vectorFixture, VECTOR_DECLARATION);
keywordIndexConformance(vectorFixture, VECTOR_DECLARATION);

evaluationStoreConformance(() => supabase.createSupabaseEvaluationStore(freshExecutor()));

usageRollupStoreConformance(() => {
  const sql = freshExecutor();
  return {
    usage: supabase.createSupabaseUsageStore(sql),
    rollups: supabase.createSupabaseUsageRollupStore(sql),
    // A run needs a conversation, which needs nothing — two levels of parent, seeded through the same executor
    // so the foreign keys resolve.
    async seedRun({ tenantId, runId }) {
      const conversationId = asId<ConversationId>(`conf-rollup-convo-${runId}`);
      await supabase.createSupabaseConversationStore(sql).create({ tenantId, id: conversationId, title: "rollups" });
      await supabase.createSupabaseRunStore(sql).create({
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
    store: supabase.createSupabaseArtifactExportStore(sql),
    async seedArtifact({ tenantId, artifactId, conversationId }) {
      await supabase.createSupabaseConversationStore(sql).create({ tenantId, id: conversationId, title: "exports" });
      await supabase.createSupabaseArtifactStore(sql).create({
        tenantId,
        artifact: { id: artifactId, conversationId, kind: "markdown", name: "Exported", createdAt: "2026-08-23T09:00:00.000Z" },
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
    store: supabase.createSupabaseFileMetadataStore(sql),
    async seedConversation({ tenantId, conversationId }) {
      await supabase
        .createSupabaseConversationStore(sql)
        .create({ tenantId, id: conversationId, title: "files" });
    },
  };
});

// ---------------------------------------------------------------------------------------------
// The alias contract and the registry contract.
// ---------------------------------------------------------------------------------------------

/** Every Supabase factory and the Postgres factory it must be. */
const ALIASES: readonly (readonly [keyof typeof supabase, keyof typeof postgres])[] = [
  ["createSupabaseConversationStore", "createPostgresConversationStore"],
  ["createSupabaseRunStore", "createPostgresRunStore"],
  ["createSupabaseRunEventLog", "createPostgresRunEventLog"],
  ["createSupabaseCheckpointStore", "createPostgresCheckpointStore"],
  ["createSupabaseMessageStore", "createPostgresMessageStore"],
  ["createSupabaseAgentStore", "createPostgresAgentStore"],
  ["createSupabaseConversationBindingStore", "createPostgresConversationBindingStore"],
  ["createSupabaseSessionStateStore", "createPostgresSessionStateStore"],
  ["createSupabaseThreadSummaryStore", "createPostgresThreadSummaryStore"],
  ["createSupabaseConversationRunCoordinator", "createPostgresConversationRunCoordinator"],
  ["createSupabaseUnitOfWork", "createPostgresUnitOfWork"],
  ["createSupabaseInteractionStore", "createPostgresInteractionStore"],
  ["createSupabaseApprovalGrantStore", "createPostgresApprovalGrantStore"],
  ["createSupabaseUsageStore", "createPostgresUsageStore"],
  ["createSupabaseIdempotencyStore", "createPostgresIdempotencyStore"],
  ["createSupabaseSkillStore", "createPostgresSkillStore"],
  ["createSupabaseMcpConnectionStore", "createPostgresMcpConnectionStore"],
  ["createSupabasePrincipalMemoryStore", "createPostgresPrincipalMemoryStore"],
  ["createSupabaseBlobStore", "createPostgresBlobStore"],
  ["createSupabaseFileMetadataStore", "createPostgresFileMetadataStore"],
  ["createSupabaseArtifactStore", "createPostgresArtifactStore"],
  ["createSupabaseArtifactExportStore", "createPostgresArtifactExportStore"],
  ["createSupabaseKnowledgeStore", "createPostgresKnowledgeStore"],
  ["createSupabaseVectorIndex", "createPostgresVectorIndex"],
  ["createSupabaseKeywordIndex", "createPostgresKeywordIndex"],
  ["createSupabaseUsageRollupStore", "createPostgresUsageRollupStore"],
  ["createSupabaseEvaluationStore", "createPostgresEvaluationStore"],
];

/**
 * Ports Supabase implements itself instead of aliasing, and why (#129).
 *
 * Taken from the registry rather than restated here, so a port can only be let off the identity assertion
 * if the matrix says so. That matters: without it the two length assertions below would have to be relaxed
 * to `>=`, and a genuinely missing alias would then read as an intentional divergence.
 */
const NATIVE = new Set(SUPABASE_NATIVE);
const ALIASED_PORTS = REGISTERED_PORTS.filter((p) => !NATIVE.has(p.port));

describe("supabase adapter coverage", () => {
  it("is the Postgres implementation for every port, not a second one", () => {
    // AC-5 in its strongest available form. If any of these stops holding, Supabase becomes a real
    // second adapter and "identical results" would need proving per port rather than by identity.
    for (const [alias, target] of ALIASES) {
      expect(supabase[alias], `${alias} must be ${target}`).toBe(postgres[target]);
    }
    // One alias per registered port that Supabase does not implement itself, so a new port cannot be added
    // without either an alias or a declared reason it has none. `FileContentStore` is the first and only
    // divergence: its bytes live in Supabase Storage, so there is no Postgres factory to alias to.
    expect([...NATIVE]).toEqual(["FileContentStore"]);
    expect(ALIASES).toHaveLength(ALIASED_PORTS.length);
  });

  it("implements exactly the ports the registry claims", () => {
    expect(coverage).toBeDefined();
    // Aliased *and* native: the column claims full coverage, because Supabase has every port. What differs
    // per port is how — asserted above.
    expect([...(coverage?.implemented ?? [])].sort()).toEqual(
      REGISTERED_PORTS.map((p) => p.port).sort(),
    );
  });

  it("has no remaining declared gaps", () => {
    // AC-6: the column is verified rather than tracked. The assertion stays so a newly registered
    // port without an alias shows up as a gap instead of silently reading as covered.
    expect(coverage?.notImplemented).toEqual([]);
  });

  it("declares only capabilities something actually backs", () => {
    // AC-2. `full-text-search` came off: nothing implements it in either adapter, so it was a claim
    // with nothing behind it. `distributed-locking` stayed on, against the SPEC's expectation --
    // #98's coordinator is a slot table with FOR UPDATE in a short transaction, not an advisory lock,
    // which is exactly what transaction pooling supports.
    expect(supabase.SUPABASE_CAPABILITIES).toEqual([
      "transactions",
      "row-level-security",
      "distributed-locking",
      "realtime",
    ]);
    expect(supabase.SUPABASE_CAPABILITIES).not.toContain("full-text-search");
  });
});
