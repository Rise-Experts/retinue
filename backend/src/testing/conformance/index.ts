/**
 * Shared storage conformance suite — `docs/02` "Conformance suite", widened by #91.
 *
 * Every storage adapter must pass the same harnesses, so "swap the database" is a verified property
 * rather than a claim. Before #91 this suite covered one port of nineteen, which is how #20
 * ("PostgreSQL adapter") could satisfy its own acceptance criterion — *"passes the full conformance
 * suite"* — with a single table implemented.
 *
 * An adapter package supplies factories; it writes no test bodies. Not part of the published build
 * (`src/testing/**` is excluded in tsconfig); imported by tests only.
 *
 * `REGISTERED_PORTS` below is the coverage ledger the guard test in
 * `src/__tests__/conformance-coverage.test.ts` checks, so a port cannot gain methods without also
 * gaining a harness.
 */

export * from "./capability.js";
export * from "./conversation-store.js";
export * from "./run-store.js";
export * from "./run-event-log.js";
export * from "./checkpoint-store.js";
export * from "./run-coordinator.js";
export * from "./session-state.js";
export * from "./records.js";
export * from "./hitl.js";
export * from "./invariants.js";

/** A port with methods, and the harness that verifies it. */
export type PortCoverage = {
  readonly port: string;
  readonly harness: string;
};

/**
 * Ports that have methods and therefore must have a harness. Kept as data so the guard test can
 * compare it against the interfaces actually exported by the port modules.
 */
export const REGISTERED_PORTS: readonly PortCoverage[] = [
  { port: "ConversationStore", harness: "conversationStoreConformance" },
  { port: "SessionStateStore", harness: "sessionStateStoreConformance" },
  { port: "ConversationBindingStore", harness: "conversationBindingStoreConformance" },
  { port: "ConversationRunCoordinator", harness: "conversationRunCoordinatorConformance" },
  { port: "ThreadSummaryStore", harness: "threadSummaryStoreConformance" },
  { port: "RunStore", harness: "runStoreConformance" },
  { port: "MessageStore", harness: "messageStoreConformance" },
  { port: "AgentStore", harness: "agentStoreConformance" },
  { port: "SkillStore", harness: "skillStoreConformance" },
  { port: "InteractionStore", harness: "interactionStoreConformance" },
  { port: "ApprovalGrantStore", harness: "approvalGrantStoreConformance" },
  { port: "CheckpointStore", harness: "checkpointStoreConformance" },
  { port: "UsageStore", harness: "usageStoreConformance" },
  { port: "BlobStore", harness: "blobStoreConformance" },
  { port: "UnitOfWork", harness: "unitOfWorkConformance" },
  { port: "RunEventLog", harness: "runEventLogConformance" },
  { port: "IdempotencyStore", harness: "idempotencyStoreConformance" },
  { port: "PrincipalMemoryStore", harness: "principalMemoryStoreConformance" },
  { port: "McpConnectionStore", harness: "mcpConnectionStoreConformance" },
];

/**
 * Method-less placeholder interfaces, deliberately without a harness. An empty harness would pass
 * vacuously and read as coverage, so the guard test instead fails if one of these gains a method —
 * turning "we forgot to widen the suite" into a build failure. Each lands with its own SPEC:
 * `EvaluationStore` #141, `FileMetadataStore` #129, `KnowledgeStore`/`VectorIndex`/`KeywordIndex`
 * #135–#136, `ArtifactStore` #133.
 */
export const PLACEHOLDER_PORTS: readonly string[] = [
  "EvaluationStore",
  "FileMetadataStore",
  "KnowledgeStore",
  "ArtifactStore",
  "VectorIndex",
  "KeywordIndex",
];

/**
 * Infrastructure ports that are not storage. Their real adapters land with REQ-015 (#101 BullMQ
 * dispatcher, #102 Redis lock), at which point they join `REGISTERED_PORTS`. Listed so the omission
 * is recorded rather than silent.
 */
export const DEFERRED_INFRASTRUCTURE_PORTS: readonly string[] = ["JobDispatcher", "DistributedLockStore"];

/**
 * Exported interfaces in the scanned port modules that are not storage at all, so a storage
 * conformance harness would be meaningless for them. Classified explicitly rather than filtered by
 * a name pattern, so adding one is a decision someone made on purpose.
 */
export const NON_STORAGE_PORTS: readonly string[] = [
  "CapabilityAware", // adapter self-description, consumed *by* the suite
  "RealtimePublisher", // fan-out transport, not durable storage
  "McpClient", // outbound protocol client
];

/**
 * The port modules the coverage guard scans. Every exported interface in these files must appear in
 * exactly one of the four lists above; an unclassified one fails the guard, which is what forces a
 * new port to come with a harness or an explicit, reasoned exemption.
 */
export const SCANNED_PORT_MODULES: readonly string[] = [
  "src/persistence/index.ts",
  "src/core/events.ts",
  "src/idempotency/index.ts",
  "src/principal-memory/index.ts",
  "src/mcp/provider.ts",
  "src/runtime/index.ts",
];
