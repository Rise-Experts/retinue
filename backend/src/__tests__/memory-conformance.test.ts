/**
 * The in-memory reference adapter runs the **full** conformance suite (#91).
 *
 * It is the reference implementation, so a harness failing here is a real defect rather than a
 * harness to soften — see the `it.fails` marker below for the one such divergence this PR found.
 */

import { asId } from "../core/ids.js";
import { createMemoryRateLimitStore } from "../adapters/memory/rate-limit.js";
import { rateLimitStoreConformance } from "../testing/conformance/rate-limit.js";
import { connectionStoreConformance } from "../testing/conformance/connections.js";
import { graphStoreConformance } from "../testing/conformance/graph.js";
import { createMemoryConnectionStore } from "../adapters/memory/connections.js";
import type {
  AgentId,
  ConversationId,
  MessageId,
  RunId,
  TenantId,
} from "../core/ids.js";
import type { Message } from "../core/content-parts.js";
import type { AgentManifest } from "../agents/index.js";
import type { SkillVersion } from "../skills/index.js";
import type { McpServerConnection } from "../mcp/index.js";
import {
  createMemoryAgentStore,
  createMemoryApprovalGrantStore,
  createMemoryArtifactExportStore,
  createMemoryArtifactStore,
  createMemoryBlobStore,
  createMemoryEvaluationStore,
  createMemoryFileContentStore,
  createMemoryFlowDefinitionStore,
  createMemoryFlowExecutionStore,
  createMemoryKnowledgeBackend,
  createMemoryUsageBackend,
  createMemoryFileMetadataStore,
  createMemoryCheckpointStore,
  createMemoryConversationStore,
  createMemoryIdempotencyStore,
  createMemoryInteractionStore,
  createMemoryMcpConnectionStore,
  createMemoryMessageStore,
  createMemoryPrincipalMemoryStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
  createMemorySkillStore,
  createMemoryThreadSummaryStore,
  createMemoryUsageLimitStore,
  createMemoryUsageStore,
  createMemoryGraphStore,
} from "../adapters/memory/index.js";
import {
  createMemoryConversationBindingStore,
  createMemoryConversationRunCoordinator,
  createMemorySessionStateStore,
  createMemoryUnitOfWork,
} from "../adapters/memory/sessions.js";
// The ceiling moved to the port in #97, so both adapters enforce one value rather than each owning a
// copy that could drift.
import { DEFAULT_SESSION_STATE_MAX_BYTES } from "../persistence/index.js";
import {
  agentStoreConformance,
  artifactExportStoreConformance,
  artifactStoreConformance,
  approvalGrantStoreConformance,
  blobStoreConformance,
  checkpointStoreConformance,
  conversationBindingStoreConformance,
  conversationRunCoordinatorConformance,
  conversationStoreConformance,
  evaluationStoreConformance,
  crossPortInvariants,
  fileContentStoreConformance,
  flowDefinitionStoreConformance,
  flowExecutionStoreConformance,
  fileMetadataStoreConformance,
  idempotencyStoreConformance,
  interactionStoreConformance,
  keywordIndexConformance,
  knowledgeStoreConformance,
  mcpConnectionStoreConformance,
  messageStoreConformance,
  principalMemoryStoreConformance,
  runEventLogConformance,
  runStoreConformance,
  sessionStateStoreConformance,
  skillStoreConformance,
  threadSummaryStoreConformance,
  unitOfWorkConformance,
  usageLimitStoreConformance,
  usageRollupStoreConformance,
  usageStoreConformance,
  vectorIndexConformance,
} from "../testing/conformance/index.js";

/**
 * The in-memory adapter declares no capabilities: it is not transactional (its `UnitOfWork` offers
 * caller-registered compensations via `runTx`, which the bare port cannot express), has no RLS and
 * no real distributed locking. Declaring honestly is what makes the suite's gated blocks skip with a
 * printed reason instead of passing vacuously.
 */
const MEMORY_DECLARATION = { capabilities: [] as const };

// ---------------------------------------------------------------- conversation & session

conversationStoreConformance(() => createMemoryConversationStore());
sessionStateStoreConformance(() => createMemorySessionStateStore(), {
  maxBytes: DEFAULT_SESSION_STATE_MAX_BYTES,
});
conversationBindingStoreConformance(() => createMemoryConversationBindingStore());
threadSummaryStoreConformance(() => createMemoryThreadSummaryStore());
// No declaration passed: the in-memory coordinator's state is a Map in the object, so it cannot
// satisfy `distributed-locking` and must not claim it. The gated sibling case stands down by name.
conversationRunCoordinatorConformance(() => createMemoryConversationRunCoordinator());
unitOfWorkConformance(
  () => ({ unitOfWork: createMemoryUnitOfWork(), sessions: createMemorySessionStateStore() }),
  MEMORY_DECLARATION,
);

// ---------------------------------------------------------------- run lifecycle

runStoreConformance(() => createMemoryRunStore());
runEventLogConformance(() => createMemoryRunEventLog());
checkpointStoreConformance(() => createMemoryCheckpointStore());

// ---------------------------------------------------------------- records

messageStoreConformance(() => createMemoryMessageStore());

const manifest = (id: string, version: number): AgentManifest => ({
  id,
  version,
  name: `agent ${id} v${version}`,
  description: "conformance fixture",
  instructions: "be useful",
  modelPolicy: { preferred: "claude-opus-5" },
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: [], categories: [], excluded: [] },
  skillPolicy: { assigned: [], allowTenantSkills: false },
  authorizationPolicyId: "default",
  contextProviderIds: [],
  limits: { maxSteps: 4, maxToolCalls: 8, maxWallClockMs: 60_000 },
});

agentStoreConformance(
  () => createMemoryAgentStore(),
  async (store, { tenantId, agentId, version }) => {
    (store as ReturnType<typeof createMemoryAgentStore>).put(tenantId, manifest(agentId, version));
  },
);

const skill = (name: string, version: number, tenantId: TenantId): SkillVersion => ({
  id: asId(`${name}-${version}`),
  name,
  // SKILL_LIMITS.descriptionMinLength is 20 — the fixture must satisfy validateSkillInput.
  description: "A conformance-suite fixture skill used to verify store behaviour.",
  source: "tenant",
  version,
  instructions: "text only, no executable content",
  status: "active",
  tenantId,
  createdAt: "2020-01-01T00:00:00.000Z",
});

skillStoreConformance(
  () => createMemorySkillStore(),
  async (store, { tenantId, name, version }) => {
    (store as ReturnType<typeof createMemorySkillStore>).add(tenantId, skill(name, version, tenantId));
  },
);

blobStoreConformance(() => createMemoryBlobStore());

// #129. The metadata store needs its conversation parent, so it takes the fixture shape; the content store
// has no relational parent at all.
fileMetadataStoreConformance(() => createMemoryFileMetadataStore());
// #133. No relational parent to seed here; the fixture shape matters only for Postgres.
artifactStoreConformance(() => createMemoryArtifactStore());
artifactExportStoreConformance(() => createMemoryArtifactExportStore());
// #135. Both ports over one backend, which is how pgvector provides them -- so a search sees what a write
// just wrote rather than reading a separate, possibly stale, copy.
// The reference adapter does hold vectors -- an exact brute-force scan -- so it declares the capability and
// every case runs.
const VECTOR_CAPABLE = { capabilities: ["vector-search"] } as const;
knowledgeStoreConformance(() => createMemoryKnowledgeBackend(), VECTOR_CAPABLE);
vectorIndexConformance(() => createMemoryKnowledgeBackend(), VECTOR_CAPABLE);
keywordIndexConformance(() => createMemoryKnowledgeBackend(), VECTOR_CAPABLE);
// #139. Rollups over the same ledger they derive from, which is how a real deployment provides them: a rollup
// computed from a different set of events than the ledger holds is the bug the port exists to prevent.
usageRollupStoreConformance(() => createMemoryUsageBackend());
usageLimitStoreConformance(() => createMemoryUsageLimitStore());
evaluationStoreConformance(() => createMemoryEvaluationStore());
fileContentStoreConformance(() => createMemoryFileContentStore());

// #187, #186. The reference implementations for flow definitions and executions.
flowDefinitionStoreConformance(() => createMemoryFlowDefinitionStore());
flowExecutionStoreConformance(() => createMemoryFlowExecutionStore());
idempotencyStoreConformance(() => createMemoryIdempotencyStore());
principalMemoryStoreConformance(() => createMemoryPrincipalMemoryStore());

mcpConnectionStoreConformance(
  () => createMemoryMcpConnectionStore({ allowedSchemes: ["https"] }),
  async (store, { tenantId, id }) => {
    const connection: McpServerConnection = {
      id,
      tenantId,
      label: `server ${id}`,
      transport: "streamable-http",
      endpoint: "https://mcp.example.com/rpc",
      auth: { kind: "bearer", credentialRef: "secret://tenant/mcp-token" },
      enabled: true,
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    await store.register({ tenantId, connection });
  },
);

// ---------------------------------------------------------------- HITL & ledger

interactionStoreConformance(() => createMemoryInteractionStore());
approvalGrantStoreConformance(() => createMemoryApprovalGrantStore());
usageStoreConformance(() => createMemoryUsageStore());

// ---------------------------------------------------------------- cross-port

crossPortInvariants(() => ({
  runs: createMemoryRunStore(),
  events: createMemoryRunEventLog(),
  checkpoints: createMemoryCheckpointStore(),
  usage: createMemoryUsageStore(),
}));

// Convince the type checker the ids above are used even when a harness only needs some of them.
void asId<AgentId>("conf-agent-1");
void asId<ConversationId>("conf-convo-1");

/**
 * `RateLimitStore` — #248.
 *
 * Here rather than beside the guard's own tests because the matrix reads the adapter from the file name. The
 * same harness runs against a real Redis in `redis-rate-limit.test.ts`, which is where the cross-process
 * clauses can actually be demonstrated; the in-memory store satisfies the contract and is single-process by
 * construction, which is exactly why it must not be used in a deployment.
 */
rateLimitStoreConformance("memory", () => createMemoryRateLimitStore(), () => "mem");

/** `ConnectionStore` — #261. */
connectionStoreConformance(() => createMemoryConnectionStore());

/** `GraphStore` — #271. No seeders: entities reference chunks by id and nothing enforces that they exist. */
graphStoreConformance(() => createMemoryGraphStore());
