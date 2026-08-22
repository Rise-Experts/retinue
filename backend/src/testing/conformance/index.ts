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
export * from "./parents.js";
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
 * Registered ports whose harness is **not** required to assert cross-tenant isolation, with the
 * reason. Everything else must: governing principle 1 says every tenant-sensitive operation receives
 * an explicit tenant context, and the `AgentStore` leak #91 found proves the type system alone does
 * not enforce it — a store can accept `TenantScope` and quietly ignore it.
 *
 * Keep this list as short as the truth allows. An entry here is a claim that the port has nothing
 * tenant-scoped to leak, not that testing it would be inconvenient.
 */
export const ISOLATION_EXEMPT_PORTS: readonly { readonly port: string; readonly reason: string }[] = [
  {
    port: "UnitOfWork",
    reason:
      "run<T>(fn) takes no tenant parameter and holds no data of its own, so there is nothing " +
      "tenant-scoped to isolate. The stores it wraps are each covered by their own harness.",
  },
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
 * Infrastructure ports that are not storage. Their real adapters land with REQ-015 (#105 BullMQ
 * dispatcher, #106 Redis lock), at which point they join `REGISTERED_PORTS`. Listed so the omission
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

/** The adapters the conformance matrix reports on. */
export const MATRIX_ADAPTERS = ["memory", "postgres", "supabase"] as const;

export type MatrixAdapter = (typeof MATRIX_ADAPTERS)[number];

/**
 * Which ports each adapter implements today, and — for each it does not — the SPEC that will add
 * it. This is the data behind the matrix's `NOT-IMPLEMENTED` cell and behind AC-3 of #92.
 *
 * The distinction that matters: a **classified** absence (listed here with a tracking issue) is a
 * known gap and is allowed; an **unclassified** absence (a registered port missing from both lists)
 * is an omission and fails the build. Without that split, either the matrix is permanently red until
 * #100 lands, or a forgotten adapter silently reads as covered — and #20 closing green against
 * "passes the full conformance suite" is what the second failure mode looks like in practice.
 */
export type AdapterCoverage = {
  readonly adapter: MatrixAdapter;
  readonly implemented: readonly string[];
  readonly notImplemented: readonly { readonly port: string; readonly trackedBy: string }[];
};

/**
 * The ports `adapters/supabase/index.ts` actually alias from the Postgres adapter. Keep this in step
 * with the aliases there: a port Postgres implements is not automatically a Supabase claim, because
 * #104 verifies the Supabase column with row-level security applied, which Postgres alone does not.
 */
const SUPABASE_ALIASED: readonly string[] = ["ConversationStore"];

/** Ports with no Postgres store yet, each against the SPEC that adds it (REQ-010→013). */
const POSTGRES_PENDING: readonly { readonly port: string; readonly trackedBy: string }[] = [
  { port: "InteractionStore", trackedBy: "#99" },
  { port: "ApprovalGrantStore", trackedBy: "#99" },
  { port: "UsageStore", trackedBy: "#100" },
  { port: "IdempotencyStore", trackedBy: "#100" },
  { port: "SkillStore", trackedBy: "#101" },
  { port: "McpConnectionStore", trackedBy: "#101" },
  { port: "PrincipalMemoryStore", trackedBy: "#102" },
  { port: "BlobStore", trackedBy: "#102" },
];

export const ADAPTER_COVERAGE: readonly AdapterCoverage[] = [
  {
    adapter: "memory",
    // The reference implementation: it implements every port, which is what makes it the baseline
    // the other adapters are compared against.
    implemented: REGISTERED_PORTS.map((p) => p.port),
    notImplemented: [],
  },
  {
    adapter: "postgres",
    implemented: [
      "ConversationStore",
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
    ],
    notImplemented: POSTGRES_PENDING,
  },
  {
    adapter: "supabase",
    // `createSupabaseConversationStore` is an alias re-export of the Postgres store
    // (`adapters/supabase/index.ts`), so Supabase inherits Postgres's coverage rather than being a
    // second implementation. #104 brings the remaining stores across with RLS applied.
    //
    // Derived rather than listed: a Postgres store landing (#93 → #102) must not silently become a
    // Supabase claim, but it must not become an *unclassified* absence either. Deriving the gap from
    // what this adapter actually aliases keeps the column honest as Postgres fills in.
    implemented: SUPABASE_ALIASED,
    notImplemented: REGISTERED_PORTS.filter((p) => !SUPABASE_ALIASED.includes(p.port)).map((p) => ({
      port: p.port,
      trackedBy: "#104",
    })),
  },
];

/**
 * The harness sources the isolation guard reads. Listed explicitly rather than globbed so a harness
 * file that is added but never wired in shows up as a missing harness rather than being skipped.
 */
export const HARNESS_MODULES: readonly string[] = [
  "src/testing/conformance/conversation-store.ts",
  "src/testing/conformance/run-store.ts",
  "src/testing/conformance/run-event-log.ts",
  "src/testing/conformance/checkpoint-store.ts",
  "src/testing/conformance/run-coordinator.ts",
  "src/testing/conformance/session-state.ts",
  "src/testing/conformance/records.ts",
  "src/testing/conformance/hitl.ts",
];
