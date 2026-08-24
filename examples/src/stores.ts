/**
 * The stores the app's own routes use, as a bundle — #155 AC-7.
 *
 * `server.ts` used to build them from a `SqlExecutor`, which meant the HTTP layer knew it was talking to
 * Postgres. That is the coupling AC-7 exposed: a single-process, no-database path cannot supply an executor, and
 * the only alternative was a second copy of every route — two servers that drift, which is the exact failure
 * this codebase keeps finding elsewhere.
 *
 * So the routes take stores. Which adapter built them is the composition's business, and there are now two
 * compositions: `postgresStores(sql)` and the memory backend's. The routes cannot tell, which is the claim
 * ports-and-adapters makes and this is where it is finally load-bearing rather than asserted.
 *
 * Note what is **not** here: `usage` and `runs` live on `ResolverDeps` already, so duplicating them would create
 * a second handle on the same data — the kind of thing that reads fine until one path writes through one and one
 * reads through the other.
 */

import {
  createPostgresApprovalGrantStore,
  createPostgresConversationRunCoordinator,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
  createPostgresPrincipalMemoryStore,
  createPostgresRunEventLog,
  createPostgresRunStore,
  createPostgresSkillStore,
  createPostgresUsageStore,
  createPostgresConversationStore,
  createPostgresMessageStore,
  createPostgresSessionStateStore,
  createPostgresThreadSummaryStore,
  createPostgresUsageLimitStore,
  createPostgresUsageRollupStore,
} from "@agentkit/backend";
import type {
  ApprovalGrantStore,
  ConversationRunCoordinator,
  IdempotencyStore,
  InteractionStore,
  LiveEventSource,
  PrincipalMemoryStore,
  RunEventLog,
  RunStore,
  SkillStore,
  TransactionRunner,
  UsageStore,
  ConversationStore,
  MessageStore,
  SessionStateStore,
  SqlExecutor,
  ThreadSummaryStore,
  UsageLimitStore,
  UsageRollupStore,
} from "@agentkit/backend";

export type ExampleStores = {
  readonly conversations: ConversationStore;
  readonly messages: MessageStore;
  readonly sessions: SessionStateStore;
  readonly grants: ApprovalGrantStore;
  readonly summaries: ThreadSummaryStore;
  readonly rollups: UsageRollupStore;
  readonly limits: UsageLimitStore;
};

/**
 * Every port the *agent* composition needs, beyond the routes' `ExampleStores`.
 *
 * Split in two rather than one big bundle because the two have different readers: the HTTP routes need seven
 * stores, and the engine wiring needs these on top. A single bundle would make every route's dependencies look
 * like the whole platform, and "what does this actually touch" stops being answerable.
 *
 * The point of both is the same: **one wiring, two adapters.** Duplicating the engine composition for a
 * single-process mode is how a difference creeps in, and the differences that crept in elsewhere in this
 * codebase — a no-op publisher (#161), an unwired message store (#157) — were all of exactly that shape.
 */
export type ExampleBackend = ExampleStores & {
  readonly runs: RunStore;
  readonly eventLog: RunEventLog;
  readonly interactions: InteractionStore;
  readonly idempotency: IdempotencyStore;
  readonly principalMemory: PrincipalMemoryStore;
  readonly skills: SkillStore;
  readonly usage: UsageStore;
  readonly coordinator: ConversationRunCoordinator;
  /** The realtime pair. Redis across processes, a function call within one — the same shape either way. */
  readonly live: LiveEventSource;
};

export const postgresBackend = (
  sql: SqlExecutor,
  live: LiveEventSource,
  /**
   * A transaction runner, for the coordinator alone.
   *
   * The conversation slot is claimed with `FOR UPDATE` inside a short transaction, which needs a *different*
   * connection from the one that ran the last query — so the coordinator takes a runner rather than an executor.
   * Optional because the worker never touches the coordinator, and forcing it to construct one would be forcing
   * it to open a pool it does not use. Absent, the coordinator throws when used, which is the honest failure.
   */
  runner?: TransactionRunner,
): ExampleBackend => ({
  ...postgresStores(sql),
  runs: createPostgresRunStore(sql),
  eventLog: createPostgresRunEventLog(sql),
  interactions: createPostgresInteractionStore(sql),
  idempotency: createPostgresIdempotencyStore(sql),
  principalMemory: createPostgresPrincipalMemoryStore(sql),
  skills: createPostgresSkillStore(sql),
  usage: createPostgresUsageStore(sql),
  coordinator: createPostgresConversationRunCoordinator(sql, runner as TransactionRunner),
  live,
});

/**
 * Built once per composition, not once per call.
 *
 * The Postgres factories are cheap and stateless — they close over the executor — so calling them repeatedly was
 * harmless. The memory factories *are* the state, so calling one twice gives two empty worlds, and the symptom is
 * a message that vanishes between being written and being read. One bundle removes the difference.
 */
export const postgresStores = (sql: SqlExecutor): ExampleStores => ({
  conversations: createPostgresConversationStore(sql),
  messages: createPostgresMessageStore(sql),
  sessions: createPostgresSessionStateStore(sql),
  grants: createPostgresApprovalGrantStore(sql),
  summaries: createPostgresThreadSummaryStore(sql),
  rollups: createPostgresUsageRollupStore(sql),
  limits: createPostgresUsageLimitStore(sql),
});
