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
export * from "./files.js";
export * from "./artifacts.js";
export * from "./artifact-exports.js";
export * from "./knowledge.js";
export * from "./rollups.js";
export * from "./usage-limits.js";
export * from "./rate-limit.js";
export * from "./connections.js";
export * from "./evaluation.js";
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
  // #187, #186. Both have harnesses, and both are tenant-scoped — a flow's definition and its execution are as
  // much a tenant's data as a conversation is.
  { port: "FlowDefinitionStore", harness: "flowDefinitionStoreConformance" },
  { port: "FlowExecutionStore", harness: "flowExecutionStoreConformance" },
  { port: "SessionStateStore", harness: "sessionStateStoreConformance" },
  { port: "ConversationBindingStore", harness: "conversationBindingStoreConformance" },
  { port: "ConversationRunCoordinator", harness: "conversationRunCoordinatorConformance" },
  { port: "ThreadSummaryStore", harness: "threadSummaryStoreConformance" },
  { port: "RunStore", harness: "runStoreConformance" },
  { port: "MessageStore", harness: "messageStoreConformance" },
  { port: "AgentStore", harness: "agentStoreConformance" },
  { port: "SkillStore", harness: "skillStoreConformance" },
  /**
   * #248. Not storage in the matrix sense — it is a counter, and its real adapter is Redis, so it has no
   * Postgres or Supabase implementation and never will. Registered anyway because it *has* methods and a
   * contract worth holding: the harness runs against the in-memory store and against a real Redis.
   */
  { port: "RateLimitStore", harness: "rateLimitStoreConformance" },
  /** #261. Tenant-scoped storage like any other, holding a sealed blob it cannot read. */
  { port: "ConnectionStore", harness: "connectionStoreConformance" },
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
  { port: "FileMetadataStore", harness: "fileMetadataStoreConformance" },
  { port: "FileContentStore", harness: "fileContentStoreConformance" },
  { port: "ArtifactStore", harness: "artifactStoreConformance" },
  { port: "ArtifactExportStore", harness: "artifactExportStoreConformance" },
  { port: "KnowledgeStore", harness: "knowledgeStoreConformance" },
  { port: "VectorIndex", harness: "vectorIndexConformance" },
  { port: "KeywordIndex", harness: "keywordIndexConformance" },
  { port: "UsageRollupStore", harness: "usageRollupStoreConformance" },
  { port: "UsageLimitStore", harness: "usageLimitStoreConformance" },
  { port: "EvaluationStore", harness: "evaluationStoreConformance" },
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
 * `EvaluationStore` #141, `KnowledgeStore`/`VectorIndex`/`KeywordIndex` #135–#136, `ArtifactStore` #133.
 *
 * `FileMetadataStore` left this list in #129, which is the mechanism working as intended: it gained methods
 * and the guard would have failed had a harness not come with them.
 */
/**
 * Ports declared with no methods yet.
 *
 * Empty as of #141, and the list stays: the guard that fails when a placeholder gains methods without a harness
 * is what stopped `KnowledgeStore` and `EvaluationStore` from quietly shipping untested, and deleting it once
 * the list is empty would remove the check that catches the next one.
 */
export const PLACEHOLDER_PORTS: readonly string[] = [];

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
  "RateLimitObserver", // a refusal sink, like QuotaObserver — nothing durable to verify
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
  // Added by #248. A port declared in a module nobody scans escapes this ledger entirely, which is how
  // `RateLimitStore` would have shipped with no coverage record at all — the omission being invisible rather
  // than listed is exactly what `PLACEHOLDER_PORTS` and `DEFERRED_INFRASTRUCTURE_PORTS` exist to prevent.
  "src/usage/rate-limit.ts",
  // #261.
  "src/connections/index.ts",
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
  /**
   * Ports this adapter should **never** implement, with the reason.
   *
   * Distinct from `notImplemented`, which means "not yet, tracked by an issue". #129 forced the
   * distinction: `FileContentStore` holds file bytes, and a relational adapter storing them would be the
   * base64-in-`jsonb` antipattern #102 rejected when it declined to make `blobs` a pointer table.
   *
   * Listing it as pending would be a lie the matrix repeats forever, and leaving it out would be an
   * unclassified absence the guard rejects. So it is a third answer, with a reason — the same shape as
   * `ISOLATION_EXEMPT_PORTS`, and kept as short as the truth allows.
   */
  readonly notApplicable?: readonly { readonly port: string; readonly reason: string }[];
};

/**
 * Why the **relational** adapter does not implement `FileContentStore`.
 *
 * Postgres alone. Supabase has a real home for file bytes — Supabase Storage, `adapters/supabase/storage.ts`
 * — so claiming an exemption there would be claiming a gap that does not exist. The exemption is about the
 * relational column, not about the deployment.
 */
const RELATIONAL_CONTENT_EXEMPTION = {
  port: "FileContentStore",
  reason:
    "File bytes belong in object storage. A relational adapter holding them means base64 in a column — the " +
    "antipattern #102 rejected when it declined to make `blobs` a pointer table, and the reason #129 split " +
    "metadata from content in the first place. Object-storage adapters implement this port instead.",
} as const;

/**
 * Ports Supabase implements itself rather than inheriting from Postgres (#129).
 *
 * The first entry in this list is a real change to what "Supabase" means here: for nineteen ports it was
 * Postgres under another name, asserted by object identity. File bytes break that, and they break it for a
 * good reason rather than by drift — object storage is a different service. Named here so the alias test can
 * assert identity for everything *except* these, instead of being relaxed to let any port off.
 */
export const SUPABASE_NATIVE: readonly string[] = ["FileContentStore"];

/**
 * The ports `adapters/supabase/index.ts` aliases from the Postgres adapter — all of them as of #104.
 *
 * Derived from `REGISTERED_PORTS` rather than listed, now that the answer is "all", so a newly
 * registered port cannot quietly become an unclassified Supabase gap. The alias identity itself is
 * asserted per port in `supabase-conformance.test.ts`, which is what keeps this honest: if an alias
 * were repointed to a second implementation, that test fails rather than this list going stale.
 */
/**
 * Ports Supabase will never implement — #248.
 *
 * Read by all three columns (`implemented` via the alias derivation, `notImplemented`, `notApplicable`) so they
 * cannot disagree. The alias derivation below defaults a new port to "aliased", and its own comment says a
 * future exemption "has to be stated" — this is where.
 */
export const SUPABASE_NOT_APPLICABLE: readonly string[] = ["RateLimitStore"];

const SUPABASE_ALIASED: readonly string[] = REGISTERED_PORTS.map((p) => p.port).filter(
  // `FileContentStore` is the one registered port the Postgres adapter does not implement, so there is
  // nothing for Supabase to alias. Filtered from the derivation rather than removed from it, so a future
  // port still defaults to "aliased" and a future exemption has to be stated.
  (port) => !SUPABASE_NATIVE.includes(port) && !SUPABASE_NOT_APPLICABLE.includes(port),
);

/** Ports with no Postgres store yet, each against the SPEC that adds it (REQ-010→013). */
const POSTGRES_PENDING: readonly { readonly port: string; readonly trackedBy: string }[] = [
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
      // #261 — the store holds a sealed blob it cannot read.
      "ConnectionStore",
      // #187, #186 — both harnesses run against the Postgres adapter in `postgres-conformance.test.ts`.
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
      "UsageLimitStore",
      "EvaluationStore",
    ],
    notImplemented: POSTGRES_PENDING,
    notApplicable: [
      {
        port: "RateLimitStore",
        reason:
          "A rate limiter is a counter on the hot path of every admission, and its correctness rests on an " +
          "atomic increment-with-expiry. A relational adapter would mean a write and a row-lock per admitted " +
          "run, plus a sweep for expired windows — slower than the thing it protects. Redis has the primitive; " +
          "this port has a Redis adapter and an in-memory one for tests, and needs no third (#248).",
      },RELATIONAL_CONTENT_EXEMPTION],
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
    //
    // `FileContentStore` joins as of #129 — implemented, not aliased and not exempt. Supabase Storage is a
    // real second implementation, which is why the alias assertion exempts it by name rather than the
    // coverage column claiming a gap Supabase does not have.
    implemented: [...SUPABASE_ALIASED, ...SUPABASE_NATIVE],
    /**
     * Derived, and the derivation has to know about `notApplicable` too — #248.
     *
     * Filtering only on aliased/native put every never-applicable port into the gap column *as well as* the
     * not-applicable one, and the guard rightly refused to let a port be claimed both ways. The subtraction is
     * the point of deriving: a port that will never exist here is not a gap tracked by #104.
     */
    notImplemented: REGISTERED_PORTS.filter(
      (p) =>
        !SUPABASE_ALIASED.includes(p.port) &&
        !SUPABASE_NATIVE.includes(p.port) &&
        !SUPABASE_NOT_APPLICABLE.includes(p.port),
    ).map((p) => ({ port: p.port, trackedBy: "#104" })),
    notApplicable: [
      {
        port: "RateLimitStore",
        reason:
          "A rate limiter is a counter on the hot path of every admission, and its correctness rests on an " +
          "atomic increment-with-expiry. A relational adapter would mean a write and a row-lock per admitted " +
          "run, plus a sweep for expired windows — slower than the thing it protects. Redis has the primitive; " +
          "this port has a Redis adapter and an in-memory one for tests, and needs no third (#248).",
      },
    ],
  },
];

/**
 * The harness sources the isolation guard reads. Listed explicitly rather than globbed so a harness
 * file that is added but never wired in shows up as a missing harness rather than being skipped.
 */
export const HARNESS_MODULES: readonly string[] = [
  "src/testing/conformance/rate-limit.ts",
  "src/testing/conformance/connections.ts",
  "src/testing/conformance/conversation-store.ts",
  "src/testing/conformance/flows.ts",
  "src/testing/conformance/run-store.ts",
  "src/testing/conformance/run-event-log.ts",
  "src/testing/conformance/checkpoint-store.ts",
  "src/testing/conformance/run-coordinator.ts",
  "src/testing/conformance/session-state.ts",
  "src/testing/conformance/records.ts",
  "src/testing/conformance/hitl.ts",
  "src/testing/conformance/files.ts",
  "src/testing/conformance/artifacts.ts",
  "src/testing/conformance/artifact-exports.ts",
  "src/testing/conformance/knowledge.ts",
  "src/testing/conformance/rollups.ts",
  "src/testing/conformance/usage-limits.ts",
  "src/testing/conformance/evaluation.ts",
];
export * from "./flows.js";
