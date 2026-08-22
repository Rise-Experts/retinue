/**
 * The in-memory reference adapter runs the **full** conformance suite (#91).
 *
 * It is the reference implementation, so a harness failing here is a real defect rather than a
 * harness to soften — see the `it.fails` marker below for the one such divergence this PR found.
 */

import { asId } from "../core/ids.js";
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
  createMemoryBlobStore,
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
  createMemoryUsageStore,
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
  approvalGrantStoreConformance,
  blobStoreConformance,
  checkpointStoreConformance,
  conversationBindingStoreConformance,
  conversationRunCoordinatorConformance,
  conversationStoreConformance,
  crossPortInvariants,
  idempotencyStoreConformance,
  interactionStoreConformance,
  mcpConnectionStoreConformance,
  messageStoreConformance,
  principalMemoryStoreConformance,
  runEventLogConformance,
  runStoreConformance,
  sessionStateStoreConformance,
  skillStoreConformance,
  threadSummaryStoreConformance,
  unitOfWorkConformance,
  usageStoreConformance,
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
conversationRunCoordinatorConformance(() => createMemoryConversationRunCoordinator());
unitOfWorkConformance(
  () => createMemoryUnitOfWork(),
  () => createMemorySessionStateStore(),
  MEMORY_DECLARATION,
);

// ---------------------------------------------------------------- run lifecycle

runStoreConformance(() => createMemoryRunStore());
runEventLogConformance(() => createMemoryRunEventLog());
checkpointStoreConformance(() => createMemoryCheckpointStore());

// ---------------------------------------------------------------- records

messageStoreConformance(
  () => createMemoryMessageStore(),
  async (store, { tenantId, conversationId, count }) => {
    const appendable = store as ReturnType<typeof createMemoryMessageStore>;
    for (let n = 1; n <= count; n += 1) {
      const message: Message = {
        id: asId<MessageId>(`m${n}`),
        conversationId,
        runId: asId<RunId>("conf-run-1"),
        role: "assistant",
        parts: [],
        createdAt: `2020-01-01T00:00:0${n}.000Z`,
      };
      appendable.append(tenantId, message);
    }
  },
);

const manifest = (id: string, version: number): AgentManifest => ({
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
