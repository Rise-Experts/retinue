/**
 * Supabase adapter — Postgres stores + RLS + Realtime (#104).
 *
 * Supabase *is* Postgres, so every store here is an **alias** of the PostgreSQL implementation rather
 * than a second one. That is deliberate and it is the whole reason the Supabase column can be trusted:
 * one implementation cannot drift from itself. The conformance suite still runs the column, because
 * an alias can be repointed and because RLS changes the executor's effective privileges — "same code"
 * is a claim worth re-checking rather than assuming.
 *
 * What is genuinely Supabase-specific lives in `rls.ts` (policies, tenant binding) and `realtime.ts`
 * (the live event channel). Both carry no `@supabase/supabase-js` dependency: the host app adapts its
 * client to the small interfaces here, so this package stays deployable without one.
 */
import type { AdapterCapability } from "../../persistence/index.js";

// Conversation and session
export { createPostgresConversationStore as createSupabaseConversationStore } from "../postgres/conversation-store.js";
export {
  createPostgresSessionStateStore as createSupabaseSessionStateStore,
  createPostgresThreadSummaryStore as createSupabaseThreadSummaryStore,
} from "../postgres/session-state.js";
export {
  createPostgresConversationBindingStore as createSupabaseConversationBindingStore,
  createPostgresMessageStore as createSupabaseMessageStore,
  createPostgresAgentStore as createSupabaseAgentStore,
} from "../postgres/message-store.js";
export { createPostgresConversationRunCoordinator as createSupabaseConversationRunCoordinator } from "../postgres/run-coordinator.js";
export { createPostgresUnitOfWork as createSupabaseUnitOfWork } from "../postgres/unit-of-work.js";

// Run lifecycle
export { createPostgresRunStore as createSupabaseRunStore } from "../postgres/run-store.js";
export { createPostgresRunEventLog as createSupabaseRunEventLog } from "../postgres/run-event-log.js";
export { createPostgresCheckpointStore as createSupabaseCheckpointStore } from "../postgres/checkpoint-store.js";

// HITL, accounting and configuration
export {
  createPostgresInteractionStore as createSupabaseInteractionStore,
  createPostgresApprovalGrantStore as createSupabaseApprovalGrantStore,
} from "../postgres/hitl.js";
export {
  createPostgresUsageStore as createSupabaseUsageStore,
  createPostgresIdempotencyStore as createSupabaseIdempotencyStore,
} from "../postgres/usage.js";
export {
  createPostgresSkillStore as createSupabaseSkillStore,
  createPostgresMcpConnectionStore as createSupabaseMcpConnectionStore,
} from "../postgres/config.js";
export {
  createPostgresPrincipalMemoryStore as createSupabasePrincipalMemoryStore,
  createPostgresBlobStore as createSupabaseBlobStore,
} from "../postgres/memory.js";
/**
 * File *metadata* aliases to Postgres. File *bytes* do not, and this is the one port where Supabase is not
 * simply Postgres under another name.
 *
 * `0013_files` keeps metadata only, so `FileMetadataStore` is an alias like every other port. The bytes live
 * in Supabase Storage, which has its own adapter in `./storage.js` — a genuine second implementation, not an
 * alias, because there is no Postgres factory to alias to. `notApplicable` in the matrix therefore belongs to
 * **postgres alone**: file bytes in a relational column is the antipattern #102 rejected, whereas Supabase
 * has a real home for them.
 */
export { createPostgresFileMetadataStore as createSupabaseFileMetadataStore } from "../postgres/files.js";
export * from "./storage.js";
/**
 * Artifacts alias to Postgres like every other relational port (#133).
 *
 * Their *content* does not live here at all — it is a `BlobRef`, and where those bytes sit is `BlobStore`'s
 * business, which is itself an alias. So unlike `FileContentStore` there is nothing Supabase-specific to add:
 * the artifact row is a relational row.
 */
export { createPostgresArtifactStore as createSupabaseArtifactStore } from "../postgres/artifacts.js";
export { createPostgresArtifactExportStore as createSupabaseArtifactExportStore } from "../postgres/artifact-exports.js";
/**
 * Knowledge and vector search alias to Postgres too (#135).
 *
 * Supabase ships pgvector, so this is the same adapter and not a second implementation — unlike
 * `FileContentStore`, where Supabase Storage genuinely is a different service. The vector migrations are
 * separate from the main list (`migrateVector`) because `CREATE EXTENSION vector` fails where the extension is
 * absent, and a Supabase project has it while a bare Postgres may not.
 */
export {
  createPostgresKnowledgeStore as createSupabaseKnowledgeStore,
  createPostgresVectorIndex as createSupabaseVectorIndex,
} from "../postgres/knowledge.js";

export * from "./rls.js";
export * from "./realtime.js";

/**
 * What a Supabase deployment can honestly advertise.
 *
 * **`distributed-locking` is included, and the SPEC expected it not to be.** #104 asks to declare it
 * unsupported "if pooled connections make advisory locks unavailable" — but the premise no longer
 * holds. #98 deliberately avoided advisory locks: a lock whose lifetime is a transaction cannot hold
 * a run slot across a `waiting-for-approval` state that waits hours for a human, and the port
 * promises a FIFO queue a lock cannot express. The coordinator is a slot table with
 * `SELECT … FOR UPDATE` inside a short transaction, which is exactly what transaction pooling
 * supports. Declaring it unsupported would skip real coverage for a reason that stopped being true.
 *
 * **`full-text-search` is removed.** Nothing implements it in either adapter, so it was a claim with
 * nothing behind it — one of the two unproven capabilities flagged on #98. `POSTGRES_CAPABILITIES`
 * still lists it; that is tracked separately rather than changed here, since Postgres is not this
 * SPEC's subject.
 */
export const SUPABASE_CAPABILITIES: readonly AdapterCapability[] = [
  "transactions",
  "row-level-security",
  "distributed-locking",
  "realtime",
];
