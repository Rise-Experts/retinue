/**
 * Storage and infrastructure ports — `docs/02-core-and-persistence.md`.
 *
 * Small interfaces rather than one database adapter. Every read and write receives
 * `tenantId` explicitly: `findById(id)` is forbidden, `findById({ tenantId, id })` is
 * the shape. Ports never import adapters.
 *
 * Method bodies are intentionally sparse at this stage — each port is filled in as its
 * phase in `docs/08-migration-plan.md` lands, against the shared conformance suite.
 */

import type { Page, PageRequest, TenantScope } from "../core/context.js";
import type { Message, QuestionAnswer } from "../core/content-parts.js";
import type { AgentManifest } from "../agents/index.js";
import type { PlatformError } from "../core/errors.js";
import type {
  AgentId,
  ApprovalGrantId,
  ArtifactId,
  ArtifactVersionId,
  BlobRef,
  ConversationId,
  FileId,
  InteractionId,
  MessageId,
  PrincipalId,
  RunId,
  TenantId,
} from "../core/ids.js";
import type { ApprovalDecision, ApprovalGrant, PendingApproval, PendingQuestion } from "../hitl/index.js";
import type { Run, RunCheckpoint, RunStatus } from "../runtime/index.js";
import type { UsageEvent } from "../usage/index.js";
import type { SkillCatalogEntry, SkillVersion } from "../skills/index.js";

export type Conversation = {
  readonly id: ConversationId;
  readonly tenantId: TenantId;
  readonly title: string;
  /** Optimistic-concurrency version; incremented on every write. */
  readonly version: number;
  readonly archivedAt?: string;
  /** Set by soft-delete; `findById`/`list` hide soft-deleted rows. */
  readonly deletedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationPatch = {
  readonly title?: string;
  /** `null` un-archives; a timestamp archives. */
  readonly archivedAt?: string | null;
};

/**
 * The exemplar store. **Every store follows this shape** (docs/02 mandatory method behavior):
 * an explicit `{ tenantId }` on every call (bare `findById(id)` is a type error), cursor
 * pagination on lists, `expectedVersion` optimistic concurrency on updates, and soft-delete
 * semantics. Adapters are verified by the shared conformance harness.
 */
export interface ConversationStore {
  create(input: TenantScope & { id: ConversationId; title: string }): Promise<Conversation>;
  findById(input: TenantScope & { id: ConversationId }): Promise<Conversation | null>;
  list(input: TenantScope & PageRequest): Promise<Page<Conversation>>;
  update(
    input: TenantScope & { id: ConversationId; expectedVersion: number; patch: ConversationPatch },
  ): Promise<Conversation>;
  softDelete(input: TenantScope & { id: ConversationId }): Promise<void>;
}

/**
 * Cross-run working memory for a thread (`docs/13-sessions-and-threads.md`). Bounded, versioned,
 * written by the runtime/tools — never raw model output. **Frozen v1.**
 */
export type SessionState = {
  readonly conversationId: ConversationId;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
};

/**
 * The ceiling on session state, defined here rather than in an adapter (#97). It is a domain limit —
 * session state is bounded working memory, not a document store — and every adapter must enforce the
 * same one. It previously lived in `adapters/memory/sessions.ts`, which made two adapters agreeing on
 * it a coincidence rather than a property.
 */
export const DEFAULT_SESSION_STATE_MAX_BYTES = 64 * 1024;

export interface SessionStateStore {
  get(input: TenantScope & { conversationId: ConversationId }): Promise<SessionState | null>;
  /** Optimistic concurrency: rejects when `expectedVersion` is stale. */
  put(
    input: TenantScope & {
      conversationId: ConversationId;
      expectedVersion: number;
      data: Readonly<Record<string, unknown>>;
    },
  ): Promise<SessionState>;
}

export type AgentVersionPolicy = "pinned" | "latest";

/**
 * Binds a thread to the agent that owns it (`docs/13`). A resumed thread runs the same agent — and,
 * when pinned, the same version — that produced its earlier turns, so continuation is deterministic.
 * Kept as its own record rather than bloating the frozen `Conversation`.
 */
export type ConversationBinding = {
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  readonly agentVersionPolicy: AgentVersionPolicy;
  /** Recorded when the policy is `pinned`. */
  readonly agentVersion?: number;
};

export interface ConversationBindingStore {
  bind(input: TenantScope & ConversationBinding): Promise<void>;
  get(input: TenantScope & { conversationId: ConversationId }): Promise<ConversationBinding | null>;
}

/**
 * Per-conversation run serialization (`docs/13` → Run ordering). At most one `Running` run per
 * conversation; further runs queue FIFO by enqueue time so session-state and message order are
 * deterministic. Backed by `DistributedLockStore` semantics in production; in-memory for tests.
 */
export interface ConversationRunCoordinator {
  /**
   * Atomically claim the conversation for `runId`, or enqueue it FIFO if one is already active. This
   * MUST be atomic (no claim→enqueue gap) so a run can never slip past into an idle-but-unclaimed
   * slot and strand itself. The primary entry point for starting a run.
   */
  claimOrEnqueue(
    input: TenantScope & { conversationId: ConversationId; runId: RunId },
  ): Promise<{ status: "started" | "queued"; position: number }>;
  /**
   * Atomically release `runId` (if it holds the slot) and promote the next queued run. MUST be atomic
   * (no release→dequeue→claim gap) so two runs can never both become active. Returns the promoted run
   * to dispatch, or null when the backlog is empty. The primary entry point on run terminal.
   */
  releaseAndPromote(
    input: TenantScope & { conversationId: ConversationId; runId: RunId },
  ): Promise<RunId | null>;
  active(input: TenantScope & { conversationId: ConversationId }): Promise<RunId | null>;
  depth(input: TenantScope & { conversationId: ConversationId }): Promise<number>;
}

/** Compacted older history (`docs/13`). Recent turns stay verbatim; this is versioned. */
export type ThreadSummary = {
  readonly conversationId: ConversationId;
  readonly version: number;
  readonly summary: string;
  readonly coversUpToMessageId: MessageId;
  readonly createdAt: string;
};

export interface ThreadSummaryStore {
  latest(input: TenantScope & { conversationId: ConversationId }): Promise<ThreadSummary | null>;
  append(
    input: TenantScope & { conversationId: ConversationId; summary: string; coversUpToMessageId: MessageId },
  ): Promise<ThreadSummary>;
}

export type NewRun = {
  readonly id: RunId;
  /**
   * The conversation this run belongs to, or **absent for a run that belongs to none** — #198.
   *
   * Required until now, which meant a triggered automation — a webhook, a schedule, a flow step — had to invent
   * a conversation id to exist at all. That is #164 exactly: `Run` carried no principal, so every host
   * fabricated one, the shipped example used `"example-worker"`, and every per-person figure silently became a
   * machine's. Nothing failed. A fabricated conversation id would do the same to every conversation-scoped
   * query, and it would look like data.
   *
   * Absent is a *fact about the run*, not a missing field: the conversation-scoped capabilities — history,
   * compaction, thread summaries — are then **unavailable** rather than operating on nothing. Asking for them is
   * a programming error and says so.
   */
  readonly conversationId?: ConversationId;
  readonly agentId: AgentId;
  readonly agentVersion: number;
  /**
   * Who this run is for, and with what roles — #164.
   *
   * Optional on the *type* only so existing callers keep compiling; supplying it is what lets a durable worker
   * rebuild the caller's identity instead of inventing one. A run carried a tenant and nothing else, so
   * `buildContext(run)` had no principal to return and every host fabricated one — the shipped example used
   * `"example-worker"` with `roleIds: ["editor"]`, which attributed every person's memory to one identity and
   * ran a `viewer`'s admitted run with editor rights.
   *
   * Recorded at admission, from the authenticated caller. Never from anything the model produced.
   */
  readonly principalId?: PrincipalId;
  readonly roleIds?: readonly string[];
  /**
   * What this run was asked to do — #202.
   *
   * Added because a **conversation-less** run had nowhere to carry its request. #198 made a run able to exist
   * without a conversation, and a triggered automation or a flow's agent step is exactly that — but the only
   * place a prompt could live was a `Message`, and `Message.conversationId` is required. So the shape said a run
   * needs no conversation while the storage said its input does.
   *
   * A property of the run rather than a message, which is also the more honest model: a webhook's payload and a
   * flow step's brief are *the run's input*, not something somebody said in a thread. A run inside a conversation
   * still reads its history; this is for the runs that have none.
   */
  readonly input?: unknown;
  /**
   * Per-run ceilings, overriding the agent manifest's — #202 AC-3.
   *
   * A flow derives these from what it has left to spend, re-derived per step, so a member cannot outspend the
   * team. Without them the child would take the manifest's limits, which are a property of the *agent* and
   * therefore the same for every member of every team — and a team's budget would bound nothing.
   *
   * Partial on purpose: a caller narrowing one dimension should not have to restate the rest.
   */
  readonly limits?: {
    readonly maxSteps?: number;
    readonly costCeilingMinorUnits?: number;
    readonly wallClockTimeoutMs?: number;
  };
};

/**
 * The run's durable lifecycle store. Beyond read/claim it owns lease keepalive, guarded status
 * transitions, durable cancellation and stale-lease reaping — the primitives the durable worker
 * (`createDurableWorker`) needs for crash recovery without duplicate work. Verified by the shared
 * `runStoreConformance` harness so every adapter agrees on claim/lease/transition semantics.
 */
export interface RunStore {
  create(input: TenantScope & NewRun): Promise<Run>;
  findById(input: TenantScope & { id: RunId }): Promise<Run | null>;
  /**
   * Atomic lease-based claim. Succeeds for a `queued` run, or for a `running` run whose lease has
   * expired (crash recovery). Returns null when another worker holds a live lease or the run is
   * terminal — so two workers never process one run.
   */
  claim(
    input: TenantScope & { id: RunId; workerId: string; leaseMs: number; now: string },
  ): Promise<Run | null>;
  /** Extend the lease. Returns false when the claim was lost (reaped/stolen) so the worker aborts. */
  keepalive(
    input: TenantScope & { id: RunId; workerId: string; leaseMs: number; now: string },
  ): Promise<boolean>;
  /** Guarded transition by the claiming worker; rejects moves absent from `RUN_TRANSITIONS`. */
  transition(
    input: TenantScope & {
      id: RunId;
      workerId: string;
      to: RunStatus;
      now: string;
      error?: PlatformError;
    },
  ): Promise<Run>;
  /** Persist a cancellation request. The owning worker observes it and stops cooperatively. */
  requestCancel(input: TenantScope & { id: RunId; now: string }): Promise<Run | null>;
  /**
   * Maintenance sweep for runs whose lease expired — recovery candidates. Cross-tenant by design
   * (a background reaper has no tenant); each returned run carries its own `tenantId` for re-claim.
   */
  reapExpired(input: { now: string; limit: number }): Promise<readonly Run[]>;
}

export interface MessageStore {
  findById(input: TenantScope & { id: MessageId }): Promise<Message | null>;
  /**
   * A page of a conversation's messages.
   *
   * `newestFirst` exists because the port could only answer "the oldest N" — #167. That is the wrong question for
   * a chat application, whose two real queries are "show me the start" (oldest) and "what does the model need to
   * see" (newest). Without it, a host asking for 100 messages of a 2000-message conversation gets turns 1–100
   * and none of the recent ones: the assistant forgets everything that just happened, and the longer the
   * conversation the worse it gets. Reaching the tail by paging is O(n) round trips for the query made on every
   * single turn.
   *
   * Items come back in the requested order, so a caller rendering oldest-first reverses a newest-first page. The
   * keyset cursor flips with it, so paging is still stable under concurrent inserts in both directions.
   */
  listByConversation(
    input: TenantScope & PageRequest & { conversationId: ConversationId; newestFirst?: boolean },
  ): Promise<Page<Message>>;
  /**
   * Record a message — #157.
   *
   * The port was read-only, and both Postgres and memory adapters carried an `append` documented as a "test-only
   * affordance". So there was no *supported* way for an application to record what the user said, and every host
   * had to reach past the port with a cast or write raw SQL. The engine reads history from here, so something has
   * to write to it.
   *
   * **Insert-only, and idempotent on the id.** A message is immutable once written: editing one would rewrite
   * history a client has already streamed and a model has already been shown. So there is deliberately no update
   * and no delete, and a repeat of the same id is a no-op rather than an error — a retried request must not fail
   * and must not duplicate.
   */
  append(input: TenantScope & { message: Message }): Promise<void>;
}

export interface AgentStore {
  findByVersion(
    input: TenantScope & { agentId: string; version: number },
  ): Promise<AgentManifest | null>;
}

export interface SkillStore {
  listCatalog(input: TenantScope): Promise<readonly SkillCatalogEntry[]>;
  findVersion(
    input: TenantScope & { name: string; version: number },
  ): Promise<SkillVersion | null>;
}

/**
 * Durable human-in-the-loop interactions (`docs/04` → Questions & Approvals). Pending questions and
 * approvals survive restart/deploy. `answer`/`decide` are idempotent — the first call resolves the
 * interaction and reports `alreadyResolved: false`; a duplicate reports `true` and changes nothing,
 * so a continuation is queued exactly once.
 */
export interface InteractionStore {
  createQuestion(input: TenantScope & { question: PendingQuestion }): Promise<void>;
  findPendingQuestion(input: TenantScope & { runId: RunId }): Promise<PendingQuestion | null>;
  /**
   * Record answers.
   *
   * A value may be a **string or an array of strings** (#155): a multi-select question has several answers, and
   * `QuestionSpec.multiple` exists to say so. Widened rather than encoded — comma-joining would make an answer
   * containing a comma indistinguishable from two answers.
   */
  answerQuestion(
    input: TenantScope & {
      interactionId: InteractionId;
      answers: Readonly<Record<string, QuestionAnswer>>;
      at: string;
    },
  ): Promise<{ question: PendingQuestion; alreadyResolved: boolean }>;
  /**
   * The run's answered question — what a resumed run must tell the model — #163.
   *
   * The approval side has had `findDecidedApproval` from the start; questions had nothing, so a resumed run
   * could not learn that its question had been answered. The observable result was a loop: the person picked
   * an option, the run resumed, the model had no idea and asked the same question again.
   *
   * **No claim, unlike an approval.** A claim exists to make an external write happen exactly once; this
   * produces a line of history, which is idempotent — and scoping to the run already bounds it, since the next
   * turn is a different run. Adding a claim would mean a recovered run rebuilt its history *without* the answer,
   * which is the bug again.
   */
  findAnsweredQuestion(input: TenantScope & { runId: RunId }): Promise<PendingQuestion | null>;

  createApproval(input: TenantScope & { approval: PendingApproval }): Promise<void>;
  findPendingApproval(input: TenantScope & { runId: RunId }): Promise<PendingApproval | null>;
  decideApproval(
    input: TenantScope & { interactionId: InteractionId; decision: ApprovalDecision; at: string },
  ): Promise<{ approval: PendingApproval; alreadyResolved: boolean }>;

  /** One approval by id — how a one-time authorization is verified against what was stored. */
  findApproval(input: TenantScope & { interactionId: InteractionId }): Promise<PendingApproval | null>;
  /**
   * The run's decided-but-unclaimed approval: what a resumed run must execute. Decided and claimed
   * are separate states because the decision is the human's and the claim is the runtime's — without
   * the second, nothing distinguishes "approved, waiting to run" from "approved, already run".
   */
  findDecidedApproval(input: TenantScope & { runId: RunId }): Promise<PendingApproval | null>;
  /**
   * Claim the single execution a decided approval authorizes — the mechanism behind `allow-once`.
   *
   * A compare-and-set, not a read-then-write: two workers racing a resumed run must see exactly one
   * `claimed: true`, because the loser executing anyway is a duplicate publish. `claimed` is false
   * for an approval that is already claimed *and* for one nobody has decided, so an undecided
   * interaction can never be turned into permission.
   */
  claimApproval(
    input: TenantScope & { interactionId: InteractionId; at: string },
  ): Promise<{ approval: PendingApproval; claimed: boolean }>;
}

/** Standing approval grants from `allow-conversation` / `allow-always` (`docs/04` → Approvals). */
export interface ApprovalGrantStore {
  grant(input: TenantScope & { grant: ApprovalGrant }): Promise<void>;
  /**
   * An active (unrevoked, unexpired) grant matching the tool name or category, or null. A
   * conversation-scoped grant matches only when `conversationId` is supplied and equal — so an
   * `allow-conversation` grant never leaks to another conversation or tenant-wide.
   */
  findActive(
    input: TenantScope & { toolNameOrCategory: string; now: string; conversationId?: string },
  ): Promise<ApprovalGrant | null>;
  revoke(input: TenantScope & { grantId: ApprovalGrantId; at: string }): Promise<void>;
}

export interface CheckpointStore {
  latest(input: TenantScope & { runId: RunId }): Promise<RunCheckpoint | null>;
  /** Overwrite the run's checkpoint. Monotonic: a save with a lower sequence is ignored. */
  save(input: TenantScope & { checkpoint: RunCheckpoint }): Promise<void>;
}

/** Aggregated usage across a set of events — the basis of ceiling checks and rollups. */
export type UsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly costMinorUnits: number;
  readonly eventCount: number;
};

/**
 * Rollup granularities (#139).
 *
 * Hour, day, week and month, and nothing finer than an hour. A minute bucket multiplies the row count
 * sixty-fold to answer a question nobody asks.
 *
 * Week and month were added by #175, because they are the periods a *person's* allowance is actually expressed
 * in — "500k tokens a month" is a plan, "500k tokens a day" is not. They cannot be derived by summing days
 * either: a month is 28 to 31 days and a week crosses month boundaries, so a caller summing day buckets has to
 * reimplement calendar arithmetic, and two callers doing it differently is two answers to what a month cost.
 *
 * A week starts **Monday**, in UTC, following ISO 8601 — chosen rather than defaulted, because a Sunday start
 * would split a working week across two buckets and every weekly figure would describe half of one week and half
 * of another.
 */
export const ROLLUP_PERIODS = ["hour", "day", "week", "month"] as const;
export type RollupPeriod = (typeof ROLLUP_PERIODS)[number];

/**
 * The span a limit is measured over — #181.
 *
 * A union, not an optional field beside `period`, because the two kinds are read differently and confusing them
 * produces a wrong number rather than an error. A calendar window is a bucket the rollups already hold; a
 * rolling window has no bucket and has to be summed from the ledger. An optional `minutes` next to a required
 * `period` would let a caller set both, and something would have to decide which one meant it.
 *
 * **A rolling window slides; it does not reset.** "No more than X in any five hours" — the window is always the
 * last `minutes` up to now. That is a deliberate choice over the other reading, an *anchored session* that
 * starts on first use and hard-resets after five hours, and the reason is that an anchored window's boundary is
 * state: to know which session a spend belongs to you must know when the current one began, which cannot be
 * derived from the records without walking history forward from the first one ever. Storing the anchor would
 * make the boundary a row that can be wrong, stale or missing, and the refusal message quotes it to people.
 *
 * The sliding reading needs no state, cannot drift, and is strictly harder to game — you cannot wait out a
 * boundary and spend twice the allowance across it. What it gives up is a single clean "resets at": headroom
 * returns gradually as records age out, so the honest statement is *when the oldest one leaves*, which is what
 * `earliestAt` is for.
 */
export type QuotaWindow =
  | { readonly kind: "calendar"; readonly period: RollupPeriod }
  /** `minutes` so an admin can express 5 hours, 90 minutes or 2 days without a new type. */
  | { readonly kind: "rolling"; readonly minutes: number };


/**
 * One tenant's consumption in one bucket.
 *
 * `bucketStart` is the ISO instant the bucket opens, truncated to the period — so a bucket is identified by
 * its start rather than by a range, and two writers computing "the hour containing T" agree by construction.
 */
export type UsageRollup = UsageTotals & {
  readonly period: RollupPeriod;
  readonly bucketStart: string;
  readonly currency: string;
  /**
   * Whose bucket this is — absent for the tenant's own total (#175).
   *
   * On the row rather than only in the query, because a caller holding a mixed list otherwise cannot tell a
   * tenant total from one person's, and adding them together double-counts everything.
   */
  readonly principalId?: PrincipalId;
  /** When this bucket was last recomputed. For spotting a rollup job that has stopped running. */
  readonly computedAt: string;
};

/**
 * Aggregated consumption, derived from the ledger — never a second source of truth.
 *
 * **Rollups are recomputed, not accumulated.** `rebuild` reads a bucket's raw events and *replaces* the row.
 * That makes idempotency structural rather than bookkept: re-running a bucket produces the same numbers, and
 * two workers racing the same bucket write the same value. The alternative — accumulating deltas with a set of
 * applied event keys — needs that set to be durable, unbounded and exactly right forever, and any gap in it is
 * silent double counting or silent loss.
 *
 * The cost is one scan per bucket in the *job*, not in the query. That is what a rollup job is for; AC-1 is
 * about the read path.
 */
export interface UsageRollupStore {
  /**
   * Recompute one bucket from the ledger and replace the row.
   *
   * Returns the row it wrote, so a caller can act on the figures without a second read.
   */
  /**
   * The store stamps `computedAt` itself, from its own clock.
   *
   * Not the caller's, and this is not a convenience: staleness is *defined* by comparing a bucket's
   * `computedAt` against when its newest event was recorded, and both of those are the store's timestamps. A
   * caller-supplied value is a caller-supplied answer to "is this rollup current" — and a caller whose clock
   * runs slow, or which passes a fixed value, would mark a bucket permanently stale or permanently fresh.
   * Found by a conformance fixture passing a constant and every bucket coming back stale.
   */
  rebuild(
    input: TenantScope & { period: RollupPeriod; bucketStart: string; principalId?: PrincipalId },
  ): Promise<UsageRollup>;

  /**
   * One bucket, or null when nothing has been recorded in it.
   *
   * `principalId` omitted reads the **tenant** row; supplied reads that person's — #175. They are the same
   * measurement at two grains, stored as a nullable dimension on one table rather than in two tables, because
   * two rebuild paths is two chances to disagree and the day they disagree is the day an invoice is wrong.
   *
   * A per-principal quota needs this: without it, a limit on one person is checked against everybody's usage.
   */
  get(
    input: TenantScope & { period: RollupPeriod; bucketStart: string; principalId?: PrincipalId },
  ): Promise<UsageRollup | null>;

  /**
   * A range of buckets, for a chart — the read path AC-1 is about.
   *
   * `from` inclusive, `to` exclusive, so adjacent ranges tile without overlapping and a caller cannot
   * double-count a boundary bucket by asking for two ranges.
   */
  list(
    input: TenantScope & PageRequest & {
      period: RollupPeriod;
      from: string;
      to: string;
      principalId?: PrincipalId;
    },
  ): Promise<Page<UsageRollup>>;

  /**
   * The sum across a range, without returning the buckets.
   *
   * Separate from `list` because a quota check needs one number and a chart needs many, and making the quota
   * check page through buckets would put the read path's cost on the admission path.
   */
  sum(
    input: TenantScope & { period: RollupPeriod; from: string; to: string; principalId?: PrincipalId },
  ): Promise<UsageTotals>;

  /**
   * Buckets that have never been computed, or were computed before the newest event in them.
   *
   * The rollup job's work list, derived from the ledger so an interrupted job resumes by asking again — the
   * same shape `listStaleSources` uses for re-indexing, and for the same reason.
   */
  listStaleBuckets(
    input: TenantScope & PageRequest & { period: RollupPeriod; since: string },
  ): Promise<
    Page<{
      readonly period: RollupPeriod;
      readonly bucketStart: string;
      /**
       * The principal whose bucket is stale, or undefined for the tenant's own — #175.
       *
       * Returned rather than left for the job to enumerate, because the job cannot know which principals were
       * active in a bucket without reading the ledger, which is the scan a rollup exists to avoid. The store
       * already has to look at the ledger to decide staleness, so it is the only place that knows cheaply.
       */
      readonly principalId?: PrincipalId;
    }>
  >;
}

/**
 * Admin-configured spend limits — #175.
 *
 * `principalId` absent is the **tenant default**; present overrides it for one person. One store rather than
 * two, because "the default" and "an override" are the same kind of fact and resolution is then a single query
 * ordered by specificity rather than two queries and a merge.
 *
 * Every limit is optional and an omitted one is **unbounded**, not zero — matching `QuotaLimits`, and for the
 * reason stated there: a misconfigured quota that blocks everything is an outage, and one that blocks nothing is
 * a bill that the rollups make visible.
 */
/**
 * A window as one storable string, and back — #181.
 *
 * `usage_limits` keys its unique indexes on this single column, so the two kinds of window have to share one
 * value space. A calendar window is its own period; a rolling one is `rolling:<minutes>`. Both spellings are
 * pinned by the table's CHECK constraint, so a value that would not round-trip cannot be stored in the first
 * place.
 *
 * The codec lives here, beside the type, rather than in each adapter: two adapters spelling a key differently is
 * two stores that cannot read each other's rows, and conformance would pass because each is self-consistent.
 */
export const windowKey = (window: QuotaWindow): string =>
  window.kind === "calendar" ? window.period : `rolling:${window.minutes}`;

/**
 * `null` for anything this does not recognise — a row written by a newer version, or by hand.
 *
 * Null rather than a thrown error or a calendar fallback. A fallback would silently enforce the wrong window,
 * which for a spend limit means either refusing people wrongly or charging them wrongly; null makes the caller
 * decide, and every caller here treats it as "no limit I can honour", which fails towards *not* pretending.
 */
export const parseWindowKey = (key: string): QuotaWindow | null => {
  if ((ROLLUP_PERIODS as readonly string[]).includes(key)) return { kind: "calendar", period: key as RollupPeriod };
  const match = /^rolling:([1-9][0-9]{0,5})$/.exec(key);
  if (match === null) return null;
  return { kind: "rolling", minutes: Number(match[1]) };
};

export type UsageLimitRecord = {
  readonly tenantId: TenantId;
  readonly principalId?: PrincipalId;
  /**
   * The span this allowance covers — widened from `period: RollupPeriod` by #181, so an admin can set a rolling
   * window as easily as a calendar one.
   */
  readonly window: QuotaWindow;
  /**
   * The model this allowance covers, or absent for **any** model — #182.
   *
   * A separate limit rather than a component of one: "500 of Opus in any five hours" and "10,000 a month
   * overall" are two allowances that both bind, not one allowance with two fields.
   */
  readonly modelId?: string;
  readonly costMinorUnits?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly warnAt?: number;
  readonly updatedAt: string;
  /** Who set it. A spend limit is the kind of setting somebody eventually has to explain. */
  readonly updatedBy?: string;
};

export interface UsageLimitStore {
  /**
   * Set or replace one limit. Keyed on `(tenant, principal, window)`, so an admin editing a limit updates it
   * rather than accumulating rows that a resolver would then have to disambiguate.
   */
  put(input: TenantScope & { limit: UsageLimitRecord }): Promise<UsageLimitRecord>;

  /**
   * The limit that applies to this principal in this period — **most specific wins**.
   *
   * A principal's own row if there is one, else the tenant default, else null for unbounded. Resolved in the
   * store rather than by the caller because "most specific wins" is a rule, and a rule implemented at two call
   * sites is a rule with two behaviours.
   */
  resolve(
    input: TenantScope & { principalId?: PrincipalId; modelId?: string; window: QuotaWindow },
  ): Promise<UsageLimitRecord | null>;

  /**
   * **Every** limit that applies to this principal on this model — #182.
   *
   * Not one limit. A person can be subject to a five-hour cap, a monthly cap and a per-model cap at once, and
   * all three bind: that is what "limits" means everywhere they are used in practice. Returning the single
   * most-specific one, as `resolve` does, meant a workspace-wide Opus cap was silently ignored for anybody who
   * also had a personal overall limit.
   *
   * The rule is **override within a scope, coexist across scopes**. One row per `(window, model)`, preferring
   * the principal's own row over the tenant default for that same scope — so a personal limit replaces the
   * workspace's for the same window and model, and does not replace one for a *different* window or model.
   *
   * A model-scoped row applies only when `modelId` matches. With no `modelId` given, model-scoped rows do not
   * apply at all: an unknown model cannot be checked against a per-model allowance, and guessing would either
   * refuse the wrong work or let it through.
   *
   * Implemented in the store, like `resolve`, because it is a rule — and a rule implemented at two call sites is
   * a rule with two behaviours. Conformance holds the adapters to the same one.
   */
  applicable(
    input: TenantScope & { principalId?: PrincipalId; modelId?: string },
  ): Promise<readonly UsageLimitRecord[]>;

  /** Every configured limit for a tenant, for an admin screen. */
  list(input: TenantScope): Promise<readonly UsageLimitRecord[]>;

  /** Remove one. Absent afterwards means "inherit the tenant default", not "zero". */
  remove(
    input: TenantScope & { principalId?: PrincipalId; modelId?: string; window: QuotaWindow },
  ): Promise<void>;
}

/**
 * Append-only usage ledger (`docs/12`). Events are never edited or deleted; corrections are new
 * compensating events. Rollups are derived from events, never a second source of truth. Appends are
 * idempotent on `(runId, stepId)` (or `id`) so a recovered run never double-counts.
 */
export interface UsageStore {
  append(input: TenantScope & { event: UsageEvent }): Promise<void>;
  listByRun(input: TenantScope & PageRequest & { runId: RunId }): Promise<Page<UsageEvent>>;
  /**
   * Consumption grouped by model or by conversation, over a bounded range (#140).
   *
   * From the **ledger**, not the rollups, and that is a deliberate trade rather than an oversight. Rollups are
   * keyed on `(tenant, period, bucket)`; adding a model and a conversation dimension would multiply the row
   * count by the product of both cardinalities to serve a panel nobody opens per second. A breakdown over one
   * period is a bounded scan served by the `(tenant_id, occurred_at)` index — where the *headline* total, which
   * is read on every page load and every quota check, comes from a rollup.
   *
   * `limit` because a tenant can have thousands of conversations and a breakdown of all of them is not a
   * breakdown. Returned largest-first so the truncation drops what matters least.
   */
  breakdown(
    input: TenantScope & {
      from: string;
      to: string;
      /**
       * `principal` added by #175 — "who spent this" was unanswerable because the dimension did not exist.
       *
       * Its cardinality is bounded by the people in a tenant rather than by their activity, which is what makes
       * it a cheaper breakdown than `conversation` rather than a more expensive one.
       */
      by: "model" | "conversation" | "principal";
      limit: number;
    },
  ): Promise<readonly { readonly key: string; readonly totals: UsageTotals }[]>;

  /**
   * Totals over an exact half-open interval `[from, to)`, and the earliest record inside it — #181.
   *
   * The rollups cannot answer this. They are keyed on `(tenant, period, bucket)`, and a rolling window has no
   * bucket: a five-hour allowance that began at 09:37 spans parts of six hourly buckets, and summing those
   * over-counts at both edges by whatever fell outside the window. An approximate spend limit is worse than
   * none, because the number is used to refuse people.
   *
   * So this reads the **ledger**, over the same `(tenant_id, occurred_at)` index `breakdown` uses, and the scan
   * is bounded by the window rather than by history. `breakdown` was not reused because its `limit` truncates —
   * fine for a panel, wrong for a total that decides admission.
   *
   * `earliestAt` is `null` when nothing was spent in the window, and otherwise the `occurredAt` of the oldest
   * record in it. A sliding window never "resets", so this is what makes a *true* statement possible about when
   * headroom returns: at `earliestAt + length` that record leaves the window. Deriving it here rather than in
   * the caller keeps it consistent with the totals it came from — computed from two queries, they could disagree
   * about a record that arrived between them.
   *
   * `modelId` scopes it to one model (#182). `principalId` scopes it to one person; **absent means the whole
   * tenant**, not "unknown principal" — a rolling tenant limit has to see everyone's spend.
   */
  totalsBetween(
    input: TenantScope & {
      readonly from: string;
      readonly to: string;
      readonly principalId?: PrincipalId;
      readonly modelId?: string;
    },
  ): Promise<{ readonly totals: UsageTotals; readonly earliestAt: string | null }>;

  /** Running totals, optionally scoped to a run or conversation — used by `reserve()` and rollups. */
  totals(
    input: TenantScope & { runId?: RunId; conversationId?: ConversationId },
  ): Promise<UsageTotals>;
}

/**
 * Evaluation results, per release — REQ-032 (#141).
 *
 * Durable because the point is *comparison*: a score with nothing to compare it against cannot gate a release,
 * and "quality went down" is only a statement if last release's number still exists. Aggregates are stored
 * alongside per-case results rather than derived on read, because a per-dimension breakdown of a thousand cases
 * is a read every release does and an aggregate nobody can recompute once a case is retired from the dataset.
 */
export type EvalVerdict = {
  readonly pass: boolean;
  /** 0–1. Binary graders report 0 or 1; a partial-credit grader may report between. */
  readonly score: number;
  /** Why. Shown in the report, so a regression names its cause rather than only its case id. */
  readonly reason: string;
  /**
   * What producing this verdict cost, in integer minor units.
   *
   * On the verdict because the cost is a property of *this grading* — a cache hit and a fresh model call produce
   * the same verdict at different prices, and a harness that could not tell them apart could not report the
   * gate's expense. Absent means free, which is every deterministic grader.
   */
  readonly costMinorUnits?: number;
};

/**
 * One case's result, with everything needed to reproduce it.
 *
 * The grader id and version, and for a judged case the model and prompt version, are stored **on the result**.
 * A run that recorded only scores could not answer "why did this change" — a prompt edit and a model upgrade
 * look identical in the numbers, and both look like a quality change.
 */
export type EvalCaseResult = {
  readonly caseId: string;
  readonly dimension: string;
  readonly expectKind: string;
  readonly verdict: EvalVerdict;
  readonly graderId: string;
  readonly graderVersion: string;
  /** Present only for a judged case. Absent means graded by code, which is also the cheap path. */
  readonly modelId?: string;
  readonly promptVersion?: string;
  /** Integer minor units. Zero for a deterministic grader, which is asserted rather than assumed. */
  readonly costMinorUnits: number;
};

export type EvalDimensionSummary = {
  readonly dimension: string;
  readonly total: number;
  readonly passed: number;
  readonly meanScore: number;
};

export type EvalRun = {
  readonly id: string;
  /** The release this scored. The axis every comparison is along. */
  readonly release: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly total: number;
  readonly passed: number;
  readonly meanScore: number;
  readonly byDimension: readonly EvalDimensionSummary[];
  /** What the whole gate cost. Recorded so the gate's own expense is known rather than assumed cheap. */
  readonly costMinorUnits: number;
  /** Every grader version in the run, so two runs can be compared *knowingly*. */
  readonly graderVersions: Readonly<Record<string, string>>;
};

export interface EvaluationStore {
  /** Opens a run. Separate from completing it so an interrupted run is visibly unfinished rather than absent. */
  startRun(input: TenantScope & { id: string; release: string; startedAt: string }): Promise<EvalRun>;

  /**
   * Records one case's result.
   *
   * Idempotent on `(runId, caseId)`: a resumed run must not double-count a case it already scored, and a case
   * cannot be scored twice in one run because a run scores each case once by construction.
   */
  recordCase(
    input: TenantScope & { runId: string; result: EvalCaseResult },
  ): Promise<{ readonly recorded: boolean }>;

  /** Closes a run, computing and storing its aggregates from the recorded cases. */
  completeRun(
    input: TenantScope & { runId: string; finishedAt: string; graderVersions: Readonly<Record<string, string>> },
  ): Promise<EvalRun>;

  get(input: TenantScope & { runId: string }): Promise<EvalRun | null>;

  /** The most recent *completed* run for a release, or across releases when none is named. */
  latest(input: TenantScope & { release?: string }): Promise<EvalRun | null>;

  /** Runs newest first, for a release history. */
  list(input: TenantScope & PageRequest): Promise<Page<EvalRun>>;

  /** A run's per-case results, which is what a comparison between two runs reads. */
  listCaseResults(input: TenantScope & PageRequest & { runId: string }): Promise<Page<EvalCaseResult>>;
}

// ---------------------------------------------------------------------------
// Artifacts (#133) — REQ-028. Substantial assistant output as a named, versioned thing rather than
// text buried in a thread.
// ---------------------------------------------------------------------------

/**
 * What an artifact is.
 *
 * Markdown and structured content first, per `docs/05` → Document writing. Rendered formats — PDF, DOCX — are
 * *exports* of an artifact rather than kinds of one, which is why they are absent here: an artifact exported
 * twice is one artifact, and making PDF a kind would make it two things that drift.
 */
export const ARTIFACT_KINDS = ["markdown", "html", "json", "csv", "code", "diagram"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Where a version came from — AC-3.
 *
 * Required on every version, not optional. A reader asking "where did this number come from" is the whole
 * reason artifacts exist as first-class objects, and provenance that *can* be absent is provenance that will
 * be, on the version someone eventually asks about.
 */
export type ArtifactProvenance = {
  /** The run that produced it. Absent for an artifact a person created directly. */
  readonly runId?: RunId;
  /** The tool or agent that produced it, by name. */
  readonly producedBy: string;
  /**
   * The inputs it was produced from.
   *
   * Stored as JSON, and deliberately the *normalised* input rather than the model's prose request: a
   * regeneration that produced a different result should be explicable by comparing these, and free text
   * does not compare.
   */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Attachments the content was derived from, so a document's figures trace back to their source. */
  readonly sourceFileIds?: readonly FileId[];
};

/**
 * One version's content, by reference — AC-5.
 *
 * `contentRef` points into `BlobStore`, which stores JSON, which is what markdown-and-structured-content is
 * once it is a value. The row holds no content: an artifact is the thing a user exports, so it grows without
 * limit, and a table row is the wrong place for something unbounded — the same reasoning that kept file bytes
 * out of `files` in #129.
 */
export type ArtifactVersion = {
  readonly id: ArtifactVersionId;
  readonly artifactId: ArtifactId;
  /** 1-based and contiguous. A gap would make "the previous version" ambiguous. */
  readonly version: number;
  readonly contentRef: BlobRef;
  readonly byteSize: number;
  readonly checksum?: string;
  readonly provenance: ArtifactProvenance;
  readonly createdBy: PrincipalId;
  readonly createdAt: string;
};

export type Artifact = {
  readonly id: ArtifactId;
  /**
   * The conversation that owns it.
   *
   * Ownership, not association: AC-4 follows from it. Entitlement to an artifact *is* entitlement to its
   * conversation, exactly as #129 established for files, so there is no second permission model to keep in
   * step with the first.
   */
  readonly conversationId: ConversationId;
  readonly kind: ArtifactKind;
  /** As the user or agent named it. Display only. */
  readonly name: string;
  /** The highest version that exists. The default a reader gets when they do not ask for one. */
  readonly latestVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Soft delete, so a shared link resolves to "deleted" rather than to nothing. */
  readonly deletedAt?: string;
};

/**
 * A rendered export of one artifact version (#134).
 *
 * **Not an artifact version.** #133's versions are versions of the *content*; a PDF is a rendering of one.
 * Making a render a new version would bump `latestVersion` for a reason unrelated to the content, and
 * "the newest version" would stop meaning "the newest thing the assistant wrote". The issue's wording said
 * artifact version; this is the deviation, and the reason.
 *
 * Keyed on `(artifactId, version, format)`, which is what makes "re-downloaded without re-rendering" a
 * constraint rather than a cache someone remembers to check.
 */
export const EXPORT_FORMATS = ["pdf", "markdown"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATES = ["pending", "rendering", "rendered", "failed"] as const;
export type ExportState = (typeof EXPORT_STATES)[number];

export type ArtifactExport = {
  readonly id: string;
  readonly artifactId: ArtifactId;
  /** The content version this rendered. An export is of a *version*, never of "the artifact". */
  readonly version: number;
  readonly format: ExportFormat;
  readonly state: ExportState;
  /**
   * The rendered bytes, as a file.
   *
   * A `FileId` rather than a `BlobRef`: `BlobStore` holds JSON and a PDF is bytes, and going through the file
   * ports means the export inherits #129's entitlement check and short-lived signed URLs rather than needing
   * a second mediated-download path.
   */
  readonly fileId?: FileId;
  readonly byteSize?: number;
  readonly checksum?: string;
  readonly failureReason?: string;
  readonly failureMessage?: string;
  readonly requestedBy: PrincipalId;
  readonly createdAt: string;
  readonly renderedAt?: string;
};

export interface ArtifactExportStore {
  /**
   * Claims the export slot for `(artifactId, version, format)`.
   *
   * Returns the existing row when there is one, so a second request for the same export is a *read* rather
   * than a second render. `claimed: false` means someone else has it — which is the answer that stops two
   * workers rendering the same PDF.
   */
  claim(
    input: TenantScope & {
      export: Omit<ArtifactExport, "state" | "fileId" | "byteSize" | "checksum" | "failureReason" | "failureMessage" | "renderedAt">;
    },
  ): Promise<{ readonly claimed: boolean; readonly export: ArtifactExport }>;

  /** Records the outcome. Idempotent, because a worker retrying after a crash cannot know what it wrote. */
  complete(
    input: TenantScope & {
      id: string;
      state: Extract<ExportState, "rendered" | "failed">;
      fileId?: FileId;
      byteSize?: number;
      checksum?: string;
      failureReason?: string;
      failureMessage?: string;
      at: string;
    },
  ): Promise<{ readonly recorded: boolean }>;

  get(input: TenantScope & { id: string }): Promise<ArtifactExport | null>;

  /** The export for a specific version and format, which is the cache lookup. */
  find(
    input: TenantScope & { artifactId: ArtifactId; version: number; format: ExportFormat },
  ): Promise<ArtifactExport | null>;

  listByArtifact(
    input: TenantScope & PageRequest & { artifactId: ArtifactId },
  ): Promise<Page<ArtifactExport>>;
}

export interface ArtifactStore {
  /** Creates the artifact and its version 1 together: an artifact with no version is not a thing. */
  create(
    input: TenantScope & {
      artifact: Omit<Artifact, "latestVersion" | "updatedAt" | "deletedAt">;
      version: Omit<ArtifactVersion, "artifactId" | "version">;
    },
  ): Promise<Artifact>;

  /**
   * Adds the next version — AC-2.
   *
   * `expectedLatestVersion` makes this a compare-and-set. Without it two concurrent regenerations both become
   * version 2: one silently replaces the other, and "earlier versions remain resolvable" stops being true for
   * the one that lost. Reported rather than thrown, because losing that race is an ordinary outcome.
   */
  addVersion(
    input: TenantScope & {
      id: ArtifactId;
      expectedLatestVersion: number;
      version: Omit<ArtifactVersion, "artifactId" | "version">;
    },
  ): Promise<{ readonly added: boolean; readonly version?: number }>;

  /** `null` for another tenant's artifact as well as an absent one — the two must be indistinguishable. */
  get(input: TenantScope & { id: ArtifactId }): Promise<Artifact | null>;

  /** A specific version, or the latest when `version` is omitted. */
  getVersion(
    input: TenantScope & { id: ArtifactId; version?: number },
  ): Promise<ArtifactVersion | null>;

  /** Live artifacts of a conversation, newest cursor last. */
  listByConversation(
    input: TenantScope & PageRequest & { conversationId: ConversationId },
  ): Promise<Page<Artifact>>;

  /** Every version, oldest first — the history a restore reads. */
  listVersions(input: TenantScope & PageRequest & { id: ArtifactId }): Promise<Page<ArtifactVersion>>;

  /** Soft delete. Versions are kept: the row is what makes a shared link resolve to "deleted". */
  softDelete(input: TenantScope & { id: ArtifactId; at: string }): Promise<{ readonly deleted: boolean }>;
}

// ---------------------------------------------------------------------------
// Files (`docs/05-knowledge-and-documents.md`, REQ-026). Two ports, not one.
//
// `BlobStore` below is `put(value) -> ref` / `get(ref) -> value` — JSON, for spilled tool output. It has
// no content type, no size and no stream, so it cannot hold a file: bytes through a `jsonb` column means
// base64, which is the "inject rather than reference" failure the platform forbids everywhere else. #102
// recorded this in the `0011` migration when it declined to make `blobs` a pointer table.
//
// So metadata and bytes are separate ports. They also have genuinely different lifecycles: metadata is
// transactional and soft-deleted, bytes are eventually deleted by a sweep, and the gap between the two is
// where orphans live.
// ---------------------------------------------------------------------------

/**
 * Where a file is in its lifecycle.
 *
 * `pending` exists because an upload is two writes — metadata, then bytes — and the window between them is
 * real. A file stuck in `pending` is metadata with no bytes, which is one of the two orphan directions
 * reconciliation looks for.
 *
 * `deleting` is the same window in reverse: the metadata is gone from the user's view and the bytes are
 * not yet gone from storage. Deleting them in one transaction is not available — object storage does not
 * join a database transaction — so the intermediate state is named rather than pretended away.
 */
export const FILE_STATES = ["pending", "stored", "deleting", "deleted"] as const;
export type FileState = (typeof FILE_STATES)[number];

export type FileMetadata = {
  readonly id: FileId;
  /**
   * The conversation that owns it.
   *
   * Ownership rather than association: AC-3 and AC-4 of #129 both follow from it — entitlement to the file
   * *is* entitlement to the conversation, and deleting the conversation is what schedules the bytes. A file
   * with no owner would need its own permission model, which is a second one to keep in step.
   */
  readonly conversationId: ConversationId;
  /** As the user named it. Display only — never used to address the bytes. */
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  /**
   * How the content store addresses the bytes. Opaque here.
   *
   * Deliberately not derived from the filename or the id: a key a caller can *construct* is a key a caller
   * can guess, and `sanitizeMediaRefs`' comment in ShareFlow is the cautionary tale — its workspace-prefix
   * check was "the ONLY thing standing between a forged path and a signed URL to another tenant's private
   * object".
   */
  readonly contentKey: string;
  /** Of the bytes as stored, so a read-back can be checked rather than assumed. */
  readonly checksum?: string;
  readonly state: FileState;
  /** Extraction outcome (#131). Absent for a file nothing has tried to extract yet. */
  readonly extraction?: FileExtraction;
  readonly uploadedBy: PrincipalId;
  readonly createdAt: string;
  /** Soft delete. A row is kept so a reference to it resolves to "deleted" rather than to nothing. */
  readonly deletedAt?: string;
};

/**
 * What a file records about its derived text (#131).
 *
 * Declared here rather than imported from `documents/`: a store port that depended on the extraction pipeline
 * would make the pipeline a prerequisite for storing a file, and `persistence` is the layer nothing above it
 * gets to reach into.
 *
 * Separate from the file's own `state` on purpose. A file is perfectly `stored` while its extraction has
 * `failed`, and conflating the two would make an unreadable document look like a lost upload.
 */
/**
 * Below this, a recognised extraction is flagged rather than presented as certain (#132).
 *
 * Here rather than in `documents/` because two layers interpret the same field and neither may import the
 * other: `documents/vision.ts` sets the flag, and `files/context.ts` marks the reference line so a model
 * choosing between attachments knows before it reads any of them. A copy in each is a copy that drifts, and
 * the port that declares `confidence` is the right place for the number that gives it meaning.
 *
 * 0.7 because that is roughly where OCR stops being "a few wrong characters" and becomes "wrong words" — and
 * a wrong word is worse than a gap, because the sentence still reads.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export type FileExtraction = {
  readonly state: "pending" | "running" | "extracted" | "failed" | "skipped";
  /** Where the extracted document lives. `BlobStore` holds JSON, which is exactly what it is. */
  readonly ref?: BlobRef;
  readonly failureReason?: string;
  readonly failureMessage?: string;
  readonly pageCount?: number;
  readonly blockCount?: number;
  readonly truncated?: boolean;
  /**
   * OCR/vision confidence, 0–1 (#132).
   *
   * On the record as well as inside the extracted document, so a listing can flag a low-confidence extraction
   * without fetching the blob to find out. Absent means the extraction was not probabilistic — a PDF's text
   * layer is read, not recognised — which is a different fact from "confidence unknown".
   */
  readonly confidence?: number;
  readonly at?: string;
};

export interface FileMetadataStore {
  create(input: TenantScope & { file: FileMetadata }): Promise<void>;

  /** `null` for another tenant's file as well as an absent one — the two must be indistinguishable. */
  get(input: TenantScope & { id: FileId }): Promise<FileMetadata | null>;

  /** Live files only: soft-deleted rows are excluded, since this is what a user sees. */
  listByConversation(
    input: TenantScope & PageRequest & { conversationId: ConversationId },
  ): Promise<Page<FileMetadata>>;

  /**
   * Advance the lifecycle, with the state it must currently be in.
   *
   * Compare-and-set rather than a blind write: two workers finishing the same upload, or a delete racing a
   * completion, must not leave a file `stored` after its bytes were scheduled for removal. Returns whether
   * this call was the one that moved it.
   */
  transition(
    input: TenantScope & {
      id: FileId;
      from: FileState;
      to: FileState;
      at: string;
      checksum?: string;
    },
  ): Promise<{ readonly moved: boolean }>;

  /**
   * Record the outcome of extraction (#131).
   *
   * Idempotent and deliberately **not** a compare-and-set, unlike `transition`. A retried extraction writing
   * the same outcome twice is harmless, and requiring the caller to state the previous extraction state would
   * make a retry after a crash impossible — the crash is exactly why it does not know what that state was.
   *
   * `recorded: false` means the file is gone, which a retry after a conversation delete will legitimately
   * hit; reported rather than thrown, because it is an ordinary race and not a fault.
   */
  recordExtraction(
    input: TenantScope & { id: FileId; extraction: FileExtraction },
  ): Promise<{ readonly recorded: boolean }>;

  /**
   * Files in a given extraction state, oldest first.
   *
   * The reconciliation of *extraction*, distinct from `listByState`'s reconciliation of bytes: a file stuck in
   * `running` is a worker that died mid-parse, and nothing else would ever notice.
   */
  listByExtractionState(
    input: TenantScope & PageRequest & { state: FileExtraction["state"]; olderThan: string },
  ): Promise<Page<FileMetadata>>;

  /**
   * Mark every live file of a conversation for byte deletion.
   *
   * One call rather than a list-then-loop, because a file uploaded between the list and the loop would be
   * missed — and it would be missed silently, leaving bytes for a conversation that no longer exists.
   */
  scheduleConversationDeletion(
    input: TenantScope & { conversationId: ConversationId; at: string },
  ): Promise<{ readonly scheduled: number }>;

  /**
   * Files in a state longer than they should be — reconciliation's input.
   *
   * `olderThan` rather than "all in this state", because a file that entered `pending` a second ago is an
   * upload in progress and a file that entered it yesterday is an orphan. Without the threshold the job
   * would report every upload happening while it ran.
   */
  listByState(
    input: TenantScope & PageRequest & { state: FileState; olderThan: string },
  ): Promise<Page<FileMetadata>>;
}

/** What the content store recorded about the bytes it accepted. */
export type StoredContent = {
  readonly contentKey: string;
  /** As actually written, which may differ from what the caller declared — see `putFile`. */
  readonly byteSize: number;
  readonly checksum: string;
};

/** One object as the content store sees it. Used only by reconciliation. */
export type StoredObject = {
  readonly contentKey: string;
  readonly byteSize: number;
};

/**
 * The bytes.
 *
 * Separate from `FileMetadataStore` because object storage cannot join a database transaction, and
 * pretending otherwise is what produces orphans. Every method is tenant-scoped: a `contentKey` from one
 * tenant must never resolve another's object, and the key alone must not be sufficient.
 */
export interface FileContentStore {
  /**
   * Write bytes and report what was written.
   *
   * **`maxBytes` is enforced while reading, not checked beforehand.** A declared size is a claim; the cap is
   * the defence. An adapter must stop consuming and discard the partial object when the cap is passed —
   * reading to the end and then refusing is a denial of service that happens to return an error.
   */
  putFile(
    input: TenantScope & {
      contentKey: string;
      mediaType: string;
      bytes: AsyncIterable<Uint8Array>;
      maxBytes: number;
    },
  ): Promise<StoredContent>;

  /** `null` when absent, or when the key belongs to another tenant. */
  readFile(input: TenantScope & { contentKey: string }): Promise<AsyncIterable<Uint8Array> | null>;

  /**
   * A short-lived authorised URL, or `null` when this adapter proxies reads instead.
   *
   * `expiresInSeconds` is **required**, and there is deliberately no method that returns a durable URL —
   * that is AC-6 of #129 made structural rather than left as a rule an adapter has to remember. An adapter
   * with no signing mechanism returns `null` and the caller streams through `readFile`.
   */
  signedUrl(
    input: TenantScope & { contentKey: string; expiresInSeconds: number },
  ): Promise<string | null>;

  /** Idempotent: deleting an absent object is a no-op, because a retried sweep must not fail. */
  deleteFile(input: TenantScope & { contentKey: string }): Promise<void>;

  /**
   * Objects this tenant has stored.
   *
   * For reconciliation's second direction — bytes with no metadata — which is the one that costs money
   * silently and which the metadata store cannot see at all.
   */
  listObjects(input: TenantScope & PageRequest & { prefix?: string }): Promise<Page<StoredObject>>;
}

/**
 * Knowledge chunks and the vector index — REQ-029 (#135).
 *
 * Two ports rather than one, because they answer different questions and can be backed by different systems:
 * `KnowledgeStore` owns the *rows* (content, provenance, which embedding produced them) and `VectorIndex` owns
 * the *similarity search*. A deployment on pgvector satisfies both with one table; a deployment on a dedicated
 * vector database satisfies them with two systems, and nothing above this layer changes.
 *
 * **The authorisation subject is on the chunk row.** That is the single most important decision here. The SPEC
 * says filtering happens *inside* the query, and the reason is precise: filtering after retrieval leaks through
 * result counts. Ask for ten chunks, get three back, and you have learned that seven exist that you may not
 * see — and with a few queries, roughly what they are about. So `authSubject` travels with the chunk and every
 * search takes it as a required filter.
 */
/**
 * The embedding width every adapter stores.
 *
 * On the port, not in an adapter, for the reason `DEFAULT_SESSION_STATE_MAX_BYTES` is (#97): a vector column has
 * one width and a vector index cannot span widths, so "every adapter agrees on the size" must be a property
 * rather than a coincidence. The reference adapter accepted 768 while pgvector refused it, which is exactly the
 * laxness that turns a production write failure into a passing test.
 *
 * 1536 is OpenAI's `text-embedding-3-small` and `-large` at its default reduction, and Cohere's v3 — the sizes
 * a deployment is most likely to have. Changing it is a **migration**, not a re-index, which is why
 * `EmbeddingModelRef` carries `dimensions` and a mismatch is refused rather than queued for re-embedding.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const KNOWLEDGE_SOURCE_TYPES = ["file", "artifact", "message", "external"] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/**
 * Which embedding produced a vector.
 *
 * Recorded per chunk, not per deployment. A model change must be *detectable* — and it is detectable only if
 * an old chunk still says what produced it. A single global "current model" setting cannot tell you which rows
 * are stale, which makes incremental re-indexing impossible.
 */
export type EmbeddingModelRef = {
  readonly modelId: string;
  /** Bumped when the same model id starts producing different vectors. Providers do this silently. */
  readonly version: string;
  readonly dimensions: number;
};

export type KnowledgeChunk = {
  readonly id: string;
  readonly sourceType: KnowledgeSourceType;
  /** The file, artifact or message this came from. */
  readonly sourceId: string;
  /** Position within the source, so neighbouring chunks can be fetched to widen context. */
  readonly chunkIndex: number;
  readonly content: string;
  readonly tokenCount: number;
  /**
   * Who may see this chunk, as an opaque subject the authorization engine understands.
   *
   * A conversation id for an attachment, a workspace id for shared knowledge. Opaque here on purpose: this
   * port must not know the permission model, only that a search is scoped to a set of subjects.
   */
  readonly authSubject: string;
  readonly embeddingModel: EmbeddingModelRef;
  /** Where in the source this came from, for a citation that resolves. */
  readonly locator?: string;
  readonly createdAt: string;
};

/** A chunk plus its vector, for writing. Read paths never return the vector — nobody above needs it. */
export type KnowledgeChunkWithEmbedding = KnowledgeChunk & { readonly embedding: readonly number[] };

export interface KnowledgeStore {
  /**
   * Replaces a source's chunks with a new set, atomically from a reader's point of view.
   *
   * Replace rather than append, because re-indexing a changed document must not leave its old chunks
   * searchable — a stale chunk is a citation pointing at text that is no longer there. The whole source at
   * once, because a partial replacement is a document that is half old and half new, and no reader can tell.
   */
  replaceSource(
    input: TenantScope & {
      sourceType: KnowledgeSourceType;
      sourceId: string;
      chunks: readonly KnowledgeChunkWithEmbedding[];
    },
  ): Promise<{ readonly written: number; readonly removed: number }>;

  /** A source's chunks in order, for reading around a hit or for re-indexing. */
  listBySource(
    input: TenantScope & PageRequest & { sourceType: KnowledgeSourceType; sourceId: string },
  ): Promise<Page<KnowledgeChunk>>;

  get(input: TenantScope & { id: string }): Promise<KnowledgeChunk | null>;

  /** Removes a source's chunks. For a deleted document: its content must stop being searchable. */
  deleteSource(
    input: TenantScope & { sourceType: KnowledgeSourceType; sourceId: string },
  ): Promise<{ readonly removed: number }>;

  /**
   * Sources whose chunks were embedded by anything other than `current` — AC-5.
   *
   * The whole basis of incremental re-indexing: the work list is derived from what is *stored*, so an
   * interrupted re-index resumes by asking again rather than by remembering where it was.
   */
  listStaleSources(
    input: TenantScope & PageRequest & { current: EmbeddingModelRef },
  ): Promise<Page<{ readonly sourceType: KnowledgeSourceType; readonly sourceId: string; readonly chunkCount: number }>>;
}

export type VectorSearchHit = {
  readonly chunk: KnowledgeChunk;
  /**
   * 0–1, higher is closer. Normalised so a caller never has to know the metric.
   *
   * **0.5 means unrelated**, not "no match". The mapping is `(cosine + 1) / 2`, so orthogonal vectors — two
   * texts with nothing in common — score exactly 0.5, and only actively *opposite* vectors score below it.
   * That is why a vector index with no `minScore` returns every chunk it is asked for: there is no such thing
   * as a non-match, only a distant one. Any caller that needs "found nothing" must supply a floor above 0.5,
   * which is what `SEMANTIC_RELEVANCE_FLOOR` is for.
   */
  readonly score: number;
};

/**
 * The floor above which a vector hit is worth having (#136).
 *
 * 0.5 is orthogonal — see `VectorSearchHit.score` — so anything at or below it shares nothing with the query.
 * 0.55 is comfortably above that and still admits a weak-but-real match. Without a floor, retrieval always
 * returns *something*, and a model handed the least-bad chunk cites it: this constant is what makes an honest
 * empty result possible at all.
 *
 * Deliberately absolute, unlike the fusion floor which is relative to the best hit. They answer different
 * questions — "is this hit any good" and "is this hit much worse than the best" — and one instrument cannot do
 * both: a relative floor can never reject a result set that is uniformly poor, because something is always the
 * best of it.
 */
export const SEMANTIC_RELEVANCE_FLOOR = 0.55;

export interface VectorIndex {
  /**
   * Nearest neighbours, filtered by permission **inside** the query.
   *
   * `authSubjects` is required and not optional. An optional filter is a filter someone omits, and the day it
   * is omitted every tenant member can retrieve every chunk. An empty array means "no subjects", which
   * correctly returns nothing rather than everything.
   */
  search(
    input: TenantScope & {
      embedding: readonly number[];
      authSubjects: readonly string[];
      limit: number;
      /** Below this, a hit is not worth returning. Prevents a query with no good answer returning noise. */
      minScore?: number;
      sourceTypes?: readonly KnowledgeSourceType[];
    },
  ): Promise<readonly VectorSearchHit[]>;
}

/**
 * Words a keyword query drops (#136).
 *
 * On the port, like `EMBEDDING_DIMENSIONS`, because both adapters need the same list and a copy in each is a
 * copy that drifts.
 *
 * **Why the query and not the index.** Postgres's `simple` text configuration is chosen deliberately over
 * `english`: `english` stems, and stemming is exactly what destroys `ERR-4021` and `Q3-2026` — the terms
 * keyword retrieval exists to find. But `simple` also keeps stopwords, so `was the site down` matches whichever
 * document says `the` most often. Found by measuring hybrid against semantic-only, where a decoy sharing only
 * `was` and `the` outranked the document that actually answered the question.
 *
 * Stripping them from the *query* keeps identifiers intact in the index while removing the terms that carry no
 * retrieval signal. Small and English-only, which is honest: a deployment in another language needs its own
 * list, and pretending otherwise would be worse than the list being visibly incomplete.
 */
export const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
  "did", "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it",
  "its", "just", "me", "my", "no", "not", "of", "on", "or", "our", "out", "over", "so", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

/**
 * A keyword query with its stopwords removed.
 *
 * Returns the empty string when nothing survives, which callers treat as "no query" — a search for `the` is a
 * search for nothing, and returning every document would be the worst possible answer.
 */
export const stripStopwords = (query: string): string =>
  (query.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .filter((term) => !KEYWORD_STOPWORDS.has(term))
    .join(" ");

export type KeywordSearchHit = {
  readonly chunk: KnowledgeChunk;
  /**
   * 0–1, higher is a better lexical match.
   *
   * Normalised so a caller fusing this with a vector score does not have to know that one is a cosine
   * similarity and the other a `ts_rank_cd` — two unbounded, incomparable scales fused directly would let
   * whichever happened to be larger dominate.
   */
  readonly score: number;
};

/**
 * Exact-term retrieval over the same chunks the vector index searches (#136).
 *
 * The same rows on purpose: semantic and keyword retrieval share **one permission-filtered source of truth**,
 * so a chunk cannot be visible to one signal and invisible to the other. Two indexes over two copies would
 * eventually disagree about what exists, and the disagreement would be a permission gap.
 *
 * It exists because semantic search misses what it was never trained on — a product code, an error number, a
 * campaign identifier. An embedding of `ERR-4021` is an embedding of a string that looks like other strings.
 */
export interface KeywordIndex {
  /**
   * Lexical search, filtered by permission **inside** the query.
   *
   * `authSubjects` is required for the same reason it is on `VectorIndex`: an optional filter is one someone
   * omits, and an excluded chunk must not merely be absent from the results — it must never have been a
   * candidate, or its presence still shows in a count.
   */
  search(
    input: TenantScope & {
      /** The user's terms, as typed. Parsed by the adapter, never interpolated into SQL. */
      query: string;
      authSubjects: readonly string[];
      limit: number;
      minScore?: number;
      sourceTypes?: readonly KnowledgeSourceType[];
    },
  ): Promise<readonly KeywordSearchHit[]>;
}


// ---------------------------------------------------------------------------------------------------
// The knowledge graph — REQ-064 (#270), task #271
// ---------------------------------------------------------------------------------------------------

/**
 * Entities and relationships extracted from chunks, so retrieval can answer what no chunk says.
 *
 * A fourth port beside `KnowledgeStore`, `VectorIndex` and `KeywordIndex`, for the same reason those are three
 * rather than one: it answers a different question and can be backed by a different system. A deployment on
 * Postgres satisfies all four with one database; one that later wants a graph database swaps this alone.
 *
 * **Provenance is structural, not decorative.** Every entity and every edge records the chunk ids it was
 * extracted from, and a row without provenance cannot be written. The retriever surfaces graph-derived material
 * as *citable* hits, so a claim with no traceable chunk is one the model would present as though a document
 * said it. `SEMANTIC_RELEVANCE_FLOOR` exists so retrieval can say "nothing"; this exists so the graph cannot say
 * "something" without saying where from.
 *
 * **A source's contribution is what gets replaced, not the entity.** An entity like "retry budget" is mentioned
 * by many sources, so re-indexing one document must not delete it — it must withdraw *that document's* claims
 * and leave the rest. Hence the split: contributions are per source and per chunk, and an entity exists exactly
 * as long as some contribution still names it. Deleting a source therefore prunes the entities only that source
 * knew about, automatically, with no reference counting for anybody to get wrong.
 */

/** An entity's type as the extractor named it — free text, lowercased. Not a union: a corpus decides its own. */
export type KnowledgeEntity = {
  /** Deterministic and readable: `type:normalised-name`. See `entityId` in `knowledge/graph.ts`. */
  readonly id: string;
  /** The canonical surface form — the one chosen deterministically from everything merged into it. */
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  /**
   * Every distinct spelling merged into this entity, sorted — AC-6.
   *
   * Resolution merges things that are not the same, and the mistake is invisible unless the merges are
   * recorded. Storing the surface forms turns "why is this entity called that" from an archaeology problem
   * into a lookup.
   */
  readonly surfaceForms: readonly string[];
  /** Chunk ids this entity was extracted from, sorted. Never empty. */
  readonly provenance: readonly string[];
};

export type KnowledgeRelationship = {
  /** Deterministic: `fromId|type|toId`. */
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly description?: string;
  /** How many chunks asserted this edge. The obvious traversal ordering, and it needs no calibration. */
  readonly weight: number;
  /** Chunk ids this edge was extracted from, sorted. Never empty. */
  readonly provenance: readonly string[];
};

/** What one source contributed, as written. The store merges these into entities and edges. */
export type GraphContribution = {
  readonly entities: readonly KnowledgeEntity[];
  readonly relationships: readonly KnowledgeRelationship[];
};

/**
 * Whether this tenant uses the graph at all, and which of its sources do.
 *
 * Two levels, because the cost is per chunk and paid at index time. A tenant switch alone would mean enabling
 * the feature silently multiplies every tenant's indexing bill — including for the ad-hoc PDF somebody attached
 * to one conversation. A per-source flag alone would leave no single place to say "this deployment does not use
 * GraphRAG", which is the guarantee AC-1 rests on.
 *
 * A source flag is stored and honoured **independently** of the tenant switch, so a deployment can mark its
 * handbook today and enable the tenant next week without re-marking anything.
 */
export type GraphSettings = {
  readonly enabled: boolean;
  /** When it was last changed, for an operator wondering why a bill moved. */
  readonly updatedAt: string;
};

export interface GraphStore {
  getSettings(input: TenantScope): Promise<GraphSettings>;
  setEnabled(input: TenantScope & { enabled: boolean; at: string }): Promise<GraphSettings>;

  /** Marks one source. Independent of the tenant switch — see `GraphSettings`. */
  setSourceEnabled(
    input: TenantScope & { sourceType: KnowledgeSourceType; sourceId: string; enabled: boolean },
  ): Promise<void>;
  isSourceEnabled(input: TenantScope & { sourceType: KnowledgeSourceType; sourceId: string }): Promise<boolean>;
  listEnabledSources(
    input: TenantScope & PageRequest,
  ): Promise<Page<{ readonly sourceType: KnowledgeSourceType; readonly sourceId: string }>>;

  /**
   * Replaces one source's contribution to the graph.
   *
   * Replace rather than append, for the reason `replaceSource` is: re-indexing a changed document must not
   * leave its old claims in the graph. Entities and edges no source names any more are pruned by this call.
   *
   * Refuses a row with empty provenance rather than storing an untraceable claim.
   */
  replaceSourceGraph(
    input: TenantScope & {
      sourceType: KnowledgeSourceType;
      sourceId: string;
      contribution: GraphContribution;
    },
  ): Promise<{ readonly entities: number; readonly relationships: number; readonly pruned: number }>;

  deleteSourceGraph(
    input: TenantScope & { sourceType: KnowledgeSourceType; sourceId: string },
  ): Promise<{ readonly pruned: number }>;

  getEntity(input: TenantScope & { id: string }): Promise<KnowledgeEntity | null>;

  /** Entities by exact id, for a query-side resolver that has already normalised. */
  getEntities(input: TenantScope & { ids: readonly string[] }): Promise<readonly KnowledgeEntity[]>;

  /**
   * Entities whose **normalised name** matches, across every type — REQ-064 (#270), task #273.
   *
   * A query says "the retry budget" and the graph holds `concept:retry budget`; the type is not in the
   * question and cannot be. So resolution is by name, and the caller supplies names already normalised by
   * `normaliseName`.
   *
   * That the id *is* `type:normalisedName` is what makes this a suffix match rather than a second stored
   * column, and it is why query-side and index-side resolution agree by construction: the id was built by the
   * same function the caller just called. A separate `normalised_name` column would be a second copy to drift.
   */
  resolveEntities(input: TenantScope & { normalisedNames: readonly string[] }): Promise<readonly KnowledgeEntity[]>;

  listEntities(input: TenantScope & PageRequest & { type?: string }): Promise<Page<KnowledgeEntity>>;

  /** Every edge touching any of `entityIds`, in either direction. The traversal primitive. */
  neighbours(
    input: TenantScope & { entityIds: readonly string[]; limit: number },
  ): Promise<readonly KnowledgeRelationship[]>;

  /**
   * A stable serialisation of the whole graph, for the determinism assertion — AC-6.
   *
   * On the port rather than built by the test, so *every* adapter is held to it. A test that serialised the
   * graph itself would prove the reference adapter deterministic and say nothing about Postgres, where row
   * order is the thing most likely to differ.
   */
  fingerprint(input: TenantScope): Promise<string>;
}

/**
 * Content-addressable blob storage for spilled tool output (`docs/03` → Tool results). A large
 * result is offloaded here and referenced by an authorized `BlobRef`, read back via
 * `read_tool_output`. Tenant-scoped so a ref from one tenant can never resolve another's bytes.
 */
export interface BlobStore {
  put(input: TenantScope & { value: unknown }): Promise<BlobRef>;
  get(input: TenantScope & { ref: BlobRef }): Promise<unknown | null>;
}

/**
 * Neutral unit of work, so a transaction-dependent workflow does not hardcode a
 * database. Adapters that cannot provide transactions must not advertise the
 * capability — startup validation fails loudly instead of degrading silently.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export const ADAPTER_CAPABILITIES = [
  "transactions",
  "row-level-security",
  "full-text-search",
  "vector-search",
  "realtime",
  "distributed-locking",
  "durable-jobs",
] as const;

export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

export interface CapabilityAware {
  capabilities(): readonly AdapterCapability[];
}

// ---------------------------------------------------------------------------------------------------
// Flows and teams — REQ-038 (#187), REQ-037 (#186)
// ---------------------------------------------------------------------------------------------------

/**
 * Stored flow and team definitions, **immutable per version**.
 *
 * `put` writes a new version rather than overwriting one, and `get` takes a version. That is not
 * over-engineering: an execution pins the version it started with and reads it for its whole life, so a
 * definition that could change under a running execution would change the shape of an automation halfway
 * through — and the person who edited step 4 has no idea an execution is sitting at step 3.
 *
 * `latest` exists for *starting* something new, which is the only moment "the current version" is the right
 * question.
 */
export interface FlowDefinitionStore {
  /** Refuses to overwrite an existing (id, version) — a version that changed is not a version. */
  put(input: TenantScope & { definition: StoredFlowDefinition }): Promise<void>;
  get(input: TenantScope & { flowId: string; version: number }): Promise<StoredFlowDefinition | null>;
  latest(input: TenantScope & { flowId: string }): Promise<StoredFlowDefinition | null>;
  list(input: TenantScope & PageRequest): Promise<Page<StoredFlowDefinition>>;
}

/**
 * The definition as stored: the shape is the flows layer's, kept opaque here.
 *
 * `unknown` rather than an import, deliberately — `persistence` is a ports layer and importing `flows` would make
 * the storage contract depend on the interpreter's types. An adapter stores and returns JSON; the flows layer
 * parses it. The same reasoning as `SessionState.data`.
 */
export type StoredFlowDefinition = {
  readonly flowId: string;
  readonly version: number;
  readonly name: string;
  readonly kind: "flow" | "team";
  readonly definition: unknown;
  readonly createdAt: string;
  readonly createdBy?: PrincipalId;
};

/**
 * A running or finished flow execution.
 *
 * `save` is a full write of the execution document rather than a patch, because the interpreter produces a whole
 * next state and a patch would need the two to agree about which fields it touched — a second contract, kept in
 * agreement by hand.
 */
export interface FlowExecutionStore {
  create(input: TenantScope & { execution: StoredFlowExecution }): Promise<void>;
  /**
   * Overwrite the execution.
   *
   * **Monotonic on `steps`**, like `CheckpointStore.save`: a save carrying fewer completed steps than the stored
   * one is ignored. Two workers that both picked up the same execution would otherwise let the slower one move it
   * backwards, and a flow that goes backwards re-performs external writes.
   */
  save(input: TenantScope & { execution: StoredFlowExecution }): Promise<void>;
  get(input: TenantScope & { executionId: string }): Promise<StoredFlowExecution | null>;
  /** Executions parked on a signal, so a delivered signal can find what was waiting for it. */
  waitingOnSignal(input: TenantScope & { signal: string; limit?: number }): Promise<readonly StoredFlowExecution[]>;
  /**
   * The execution parked on a child run — #202.
   *
   * One at most: a run belongs to a single flow step. Returning `null` rather than a list says so, and a caller
   * that got a list would have to decide what two parents for one child means.
   */
  waitingOnRun(input: TenantScope & { runId: RunId }): Promise<StoredFlowExecution | null>;
  /** For the inspector: what has this flow been doing? #187 AC-7. */
  listByFlow(input: TenantScope & PageRequest & { flowId: string }): Promise<Page<StoredFlowExecution>>;
}

export type StoredFlowExecution = {
  readonly id: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly runId: RunId;
  readonly status: string;
  readonly currentStep: string | null;
  /** How many steps have completed. The monotonic guard reads this. */
  readonly steps: number;
  /** The whole execution document, as the flows layer wrote it. */
  readonly execution: unknown;
  readonly waitingSignal?: string;
  /** The child run this execution is parked on — #202. Indexed, because a settled run has to find its parent. */
  readonly waitingRunId?: RunId;
  readonly startedAt: string;
  readonly finishedAt?: string;
};
