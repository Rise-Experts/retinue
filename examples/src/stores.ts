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

import { createPostgresApprovalGrantStore, createPostgresConversationRunCoordinator, createPostgresIdempotencyStore, createPostgresInteractionStore, createPostgresPrincipalMemoryStore, createPostgresRunEventLog, createPostgresRunStore, createPostgresSkillStore, createPostgresUsageStore, createPostgresConversationStore, createPostgresMessageStore, createPostgresSessionStateStore, createPostgresThreadSummaryStore, createPostgresUsageLimitStore, createPostgresUsageRollupStore, createPostgresFileContentStore, createPostgresFileMetadataStore } from "@retinue/agentkit/adapters/postgres";
import type { ApprovalGrantStore, ConversationRunCoordinator, IdempotencyStore, InteractionStore, LiveEventSource, PrincipalMemoryStore, RunEventLog, RunStore, SkillStore, UsageStore, ConversationStore, MessageStore, SessionStateStore, ThreadSummaryStore, UsageLimitStore, UsageRollupStore } from "@retinue/agentkit";
import type { TransactionRunner, SqlExecutor } from "@retinue/agentkit/adapters/postgres";
import { createFileService } from "@retinue/agentkit/knowledge";
import type { AuthorizationPolicy, FileService } from "@retinue/agentkit";

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
  /**
   * Attachments — #185.
   *
   * Optional, and the optionality is the honest part: the single-process memory mode has no content store the
   * API and the worker can share, so it has no attachments. A `FileService` constructed over an in-memory
   * content store would upload in one process and be unreadable in the other, which looks like corruption.
   */
  readonly files?: FileService;
};

/**
 * The coordinator, built only if something asks for it.
 *
 * Two facts collide. `claimOrEnqueue` takes the conversation's run slot `FOR UPDATE`, so it needs a real
 * `TransactionRunner`. And the platform's `runWorker` calls `app.deps({ config, sql })` with no runner — because
 * **the worker never uses the coordinator**: it reads `deps.runs` and `deps.eventLog` and nothing else. Admission
 * is the API's job.
 *
 * So `deps()` cannot require a runner, and must not silently accept `undefined` either: the first version passed
 * `undefined as never` and the first real request died on `Cannot read properties of undefined (reading
 * 'transaction')`. Build lazily, and let the *use* fail with a message naming the missing piece. The API supplies
 * one and works; the worker does not and never notices.
 */
export const lazyCoordinator = (
  sql: SqlExecutor,
  runner: TransactionRunner | undefined,
): ConversationRunCoordinator => {
  const build = (): ConversationRunCoordinator => {
    if (runner === undefined)
      throw new Error(
        "this process has no TransactionRunner, so the conversation run coordinator cannot be used. The API " +
          "host supplies one; the worker does not, and does not need it.",
      );
    return createPostgresConversationRunCoordinator(sql, runner);
  };
  // A proxy rather than an object of getters, so every method — present and future — is covered by one decision.
  // Enumerating them would mean a method added later silently returning undefined.
  return new Proxy({} as ConversationRunCoordinator, {
    get: (_target, property) => {
      const built = build() as unknown as Record<string | symbol, unknown>;
      const value = built[property];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(built) : value;
    },
  });
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
  /**
   * The app's authorization policy, for the file service — #185.
   *
   * Passed in rather than defaulted, and there is no permissive fallback: entitlement to a file is entitlement
   * to its conversation, and a file service constructed without a policy makes every attachment in a tenant
   * readable by every member of it. Absent means **no attachments**, which is a smaller feature than a broken
   * one — the worker, which has no reason to serve uploads, is the caller that leaves it out.
   */
  authorization?: AuthorizationPolicy,
): ExampleBackend => ({
  ...postgresStores(sql),
  runs: createPostgresRunStore(sql),
  eventLog: createPostgresRunEventLog(sql),
  interactions: createPostgresInteractionStore(sql),
  idempotency: createPostgresIdempotencyStore(sql),
  principalMemory: createPostgresPrincipalMemoryStore(sql),
  skills: createPostgresSkillStore(sql),
  usage: createPostgresUsageStore(sql),
  /**
   * The **lazy** coordinator, not an eager one — #178.
   *
   * This built it eagerly with `runner as TransactionRunner`, which meant the worker — which is handed no runner
   * and never uses the coordinator — held one constructed over `undefined`. Inert only for as long as nothing in
   * the worker touched it, and the failure would have been
   * `Cannot read properties of undefined (reading 'transaction')` from somewhere that looks unrelated.
   *
   * It also left two coordinators in the API process: this one and the lazy one `deps()` built separately. Two
   * handles on one slot table is the kind of thing that reads fine until one path claims through one and another
   * releases through the other.
   */
  coordinator: lazyCoordinator(sql, runner),
  live,
  /**
   * The file service, over Postgres for both halves — #185.
   *
   * `createPostgresFileContentStore` exists because this is the shape a deployment on plain Postgres and Redis
   * actually has: the alternatives were in-memory bytes, which two processes cannot share, and Supabase Storage,
   * which needs a Supabase project. Without one of them the multimodal path was unreachable in practice however
   * correct it was in principle.
   *
   * `authorization` is the app's real policy, not a permissive one: entitlement to a file is entitlement to its
   * conversation, and the resolver that turns an attachment into an image part reads through this service
   * precisely so that check cannot be bypassed.
   */
  ...(authorization === undefined
    ? {}
    : {
        files: createFileService({
          metadata: createPostgresFileMetadataStore(sql),
          content: createPostgresFileContentStore(sql),
          authorization,
          limits: {
            maxBytes: 8 * 1024 * 1024,
            allowedMediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"],
            signedUrlSeconds: 300,
          },
        }),
      }),
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
