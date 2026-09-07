/**
 * `PublishingService` over `scheduled_items` and `social_accounts` — REQ-041 (#190), and what gives a shadow
 * run something to suppress.
 *
 * The fourth adapter, and the first whose methods are **`external-write`**. Everything the three before it
 * could serve was `read` or `internal-write`, so a `create-post` shadow run correctly recorded an empty write
 * list and the parity diff had no signal. This is where the signal comes from.
 *
 * It is also the first place a mistake reaches a customer's audience, so three findings about *this* schema
 * are load-bearing and each is written down where it applies:
 *
 * 1. **Nothing stops a double publish.** `scheduled_items` has no unique constraint on
 *    `(post_id, social_account_id)`; the only unique index covers recurring rules
 *    (`posting_schedule_id, social_account_id, occurrence_at`) and is partial on `posting_schedule_id IS NOT
 *    NULL`. A one-off schedule can insert the same destination twice and the database will allow it. See
 *    `schedule`.
 * 2. **This adapter does not enqueue, and that is a deliberate latency trade.** ShareFlow's own route inserts
 *    the row *and* adds a BullMQ job. Reaching Redis from this package would mean a queue dependency the
 *    boundary rules forbid and a second producer for a queue ShareFlow owns. The row is enough because
 *    ShareFlow's sweep exists — see `SWEEP_*` below — at a cost in minutes that is quantified there.
 * 3. **Two states the port describes are unreachable here.** `awaiting-platform` is not a value
 *    `scheduled_items.status` holds, and the port's "ShareFlow gives up after 24 hours" is not this
 *    deployment's rule — there is no 24-hour threshold and no `finish-pending-targets` sweep in it. What
 *    exists is the reconciliation sweep, and `stuck` is derived from its alert threshold.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";

import { findDuplicateContent } from "../../tools/duplication.js";
import type {
  ContentService,
  PublishTarget,
  PublishTargetState,
  PublishTargetStatus,
  PublishingService,
  ValidationIssue,
  ValidationReport,
} from "../../services/index.js";

/**
 * How overdue an item must be before ShareFlow's sweep re-enqueues it, and how late before it alerts.
 *
 * Replicated from `web/src/lib/schedule-sweep.ts:42` and `:48` (ShareFlow commit `d1b5e0a1` region), for the
 * same reason `plannedPostCount` replicates `postCountFor`: nothing in this package can call across the
 * repository boundary, and the numbers decide what this adapter reports. They are pinned in the tests.
 */
export const SWEEP_GRACE_MS = 5 * 60_000;
export const SWEEP_ALERT_MS = 60 * 60_000;

/**
 * The worst-case delay before a post this adapter scheduled actually goes out.
 *
 * **A real behavioural difference between the two runtimes, and one a parity report should carry.**
 * ShareFlow's route enqueues a BullMQ job with `delay: 0`, so an app-scheduled "publish now" goes out in
 * seconds. This adapter writes a `PENDING` row and lets the sweep find it, which takes the grace period plus
 * one cron tick.
 *
 * Why that is the right trade rather than a shortcut: reaching Redis from `packages/shareflow` would add a
 * queue dependency to a package whose boundary rules forbid I/O in tools and confine infrastructure to the
 * platform's adapters, and it would make this a **second producer** for a queue ShareFlow owns — two writers
 * with two notions of the job id, where the sweep's whole safety argument rests on `jobId` being the item id.
 *
 * A deployment that wants the seconds back supplies `enqueue`; see `PublishingDeps`.
 */
export const SWEEP_WORST_CASE_MS = SWEEP_GRACE_MS + 60_000;

/** ShareFlow's four values, from `web/src/lib/data/posts.ts:6`. There is no `PUBLISHED` and no `CANCELLED`. */
const STATE_FROM_DB: Readonly<Record<string, PublishTargetState>> = {
  PENDING: "scheduled",
  QUEUED: "publishing",
  SUCCESS: "published",
  FAILED: "failed",
};

/**
 * An unrecognised status reads as `publishing` — the port's unconfirmed state.
 *
 * The two alternatives each assert something that may be false: `published` claims an outcome and `failed`
 * claims a failure. `AUTH_FAILED` is a real example from ShareFlow's publisher that is not in its declared
 * union, so this arm is reached in practice rather than defensively.
 */
const stateFrom = (status: string | null): PublishTargetState =>
  (status === null ? undefined : STATE_FROM_DB[status.toUpperCase()]) ?? "publishing";

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id here arrives from a model. A raw cast failure surfaces as `internal`, which is not actionable. */
const asUuid = (field: string, value: string): string => {
  if (!UUID.test(value.trim())) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be a UUID — got ${JSON.stringify(value.slice(0, 60))}.`,
      retryable: false,
    });
  }
  return value.trim();
};

type ItemRow = {
  id: string;
  social_account_id: string;
  status: string | null;
  scheduled_at: string | Date;
  published_at: string | Date | null;
  external_post_url: string | null;
  retry_count: number | null;
  platform: string | null;
  failure_message: string | null;
};

const ITEM_COLUMNS = `select s.id, s.social_account_id, s.status, s.scheduled_at, s.published_at,
                             s.external_post_url, s.retry_count, a.platform,
                             /**
                              * The most recent failure log, when there is one.
                              *
                              * A lateral rather than a join, so an item with twenty log lines yields one row
                              * rather than twenty. \`error_payload\` is deliberately **not** selected: the port
                              * says "never the provider's raw body", and that column holds exactly that.
                              */
                             (select l.message from public.post_logs l
                               where l.scheduled_item_id = s.id and l.status = 'ERROR'
                               order by l.created_at desc limit 1) as failure_message
                        from public.scheduled_items s
                        join public.posts p on p.id = s.post_id
                        left join public.social_accounts a on a.id = s.social_account_id`;

export type PublishingDeps = {
  readonly sql: SqlExecutor;
  /**
   * **Required, not optional.** A publish-once guarantee cannot be "usually".
   *
   * `scheduled_items` has no unique constraint on `(post_id, social_account_id)`, so the only way to stop a
   * concurrent second insert is to serialise on a row that does exist — `SELECT … FOR UPDATE` on the draft —
   * and that needs `BEGIN`, the check and the insert on **one connection**. `SqlExecutor` wraps `pg.Pool`,
   * where every `query` call may take a different connection, so through the bare interface the transactional
   * promise is unreachable. `transaction.ts` says so at length.
   *
   * Fail-closed, like the registry refusing a shadow run with no recorder and the envelope refusing a gated
   * effect with no idempotency store: a deployment that cannot provide this should not be publishing.
   */
  readonly transaction: TransactionRunner;
  /**
   * The limits check, borrowed from `ContentService` rather than reimplemented.
   *
   * `platform_rules` is workspace-overridable, and two readings of it would be two answers to "is this
   * caption publishable" — the exact drift `validate` exists to prevent, since it runs *before* the approval
   * gate so that a human is never asked to approve something that cannot succeed.
   */
  readonly validateContent: ContentService["validateContent"];
  /**
   * Optional: hand the item to ShareFlow's queue immediately.
   *
   * Absent means the row waits for the sweep — up to `SWEEP_WORST_CASE_MS`. Supplying it is how a deployment
   * that *does* have Redis gets ShareFlow's own latency back, and it keeps the difference a wiring decision
   * rather than a limitation buried in an adapter.
   */
  readonly enqueue?: (input: { readonly scheduledItemId: string; readonly delayMs: number }) => Promise<void>;
  readonly now?: () => number;
};

/** How many recent posts the duplicate check compares against. A bound: this runs before every publish. */
export const DUPLICATE_SCAN_LIMIT = 25;

/**
 * The checks `validate` cannot perform in this deployment, reported rather than passed over.
 *
 * The port's `validate` covers "claims, duplication, platform limits and media". Two of the four have nothing
 * behind them here: no table holds approved or forbidden claims (`BRAND_SUPPORTED.getClaimPolicy` is `false`),
 * and there is no `MediaService` adapter. Silence would mean this deployment validated nothing for those and
 * the failure would surface as a rejected publish — long after the assistant said the post was fine, which is
 * precisely what running this before the approval gate is meant to avoid.
 */
export const UNCHECKED_CODES = ["claims-unchecked", "media-unchecked"] as const;

export const createPostgresPublishingService = (deps: PublishingDeps): PublishingService => {
  const now = deps.now ?? Date.now;
  const { sql } = deps;

  /** The draft, scoped to the workspace. `not_found` for another tenant's id, never `forbidden`. */
  const draftIn = async (context: ExecutionContext, draftId: string): Promise<{ id: string; caption: string }> => {
    const rows = await sql.query<{ id: string; raw_content: string }>(
      `select id, raw_content from public.posts where workspace_id = $1::uuid and id = $2::uuid`,
      [String(context.tenantId), asUuid("draftId", draftId)],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AgentPlatformError({ code: "not_found", message: `No post draft ${draftId}.`, retryable: false });
    }
    return { id: row.id, caption: row.raw_content };
  };

  /**
   * The accounts, scoped to the workspace, in the order asked for.
   *
   * Every id is checked against `workspace_id`, and that is not belt-and-braces: `social_accounts` holds
   * **credentials**, and `scheduled_items.social_account_id` has a foreign key to the table and not to the
   * workspace — the same shape as the `posts.campaign_id` hole. Publishing to another tenant's connected
   * account is the worst outcome in this file.
   */
  const accountsIn = async (
    context: ExecutionContext,
    accountIds: readonly string[],
  ): Promise<Map<string, { id: string; platform: string; status: string; expiresAt: string | Date | null }>> => {
    const ids = accountIds.map((id) => asUuid("accountId", String(id)));
    const rows = await sql.query<{ id: string; platform: string; status: string; token_expires_at: string | Date | null }>(
      `select id, platform, status, token_expires_at
         from public.social_accounts where workspace_id = $1::uuid and id = any($2::uuid[])`,
      [String(context.tenantId), ids],
    );
    return new Map(
      rows.map((row) => [row.id, { id: row.id, platform: row.platform, status: row.status, expiresAt: row.token_expires_at }]),
    );
  };

  const toStatus = (row: ItemRow): PublishTargetStatus => {
    const state = stateFrom(row.status);
    const scheduledAt = iso(row.scheduled_at);
    /**
     * `stuck` from the sweep's alert threshold, not from the port's 24 hours.
     *
     * The port says ShareFlow gives up after 24 hours because an Instagram container expires. **This
     * deployment has no such rule** — no 24-hour threshold, and no `finish-pending-targets` sweep. What it
     * has is the reconciliation sweep, which alerts at an hour late. Reporting the port's number would be
     * asserting a rule that is not running.
     */
    const late = state === "scheduled" || state === "publishing"
      ? now() - Date.parse(scheduledAt) >= SWEEP_ALERT_MS
      : false;
    return {
      id: row.id as never,
      accountId: row.social_account_id as never,
      state,
      scheduledAt,
      ...(row.published_at === null ? {} : { publishedAt: iso(row.published_at) }),
      ...(row.external_post_url === null ? {} : { externalUrl: row.external_post_url }),
      ...(row.retry_count === null ? {} : { attemptCount: row.retry_count }),
      ...(state === "failed" && row.failure_message !== null
        ? { failure: { code: "publish-failed", message: row.failure_message } }
        : {}),
      ...(late ? { stuck: true } : {}),
    };
  };

  /**
   * Read every target for a draft.
   *
   * A local function rather than `this.getStatus`, which `schedule` first called. `this` is bound only while
   * the method is reached through the object — `const { schedule } = services.publishing` would break it, and
   * nothing in the type says so.
   */
  const statusFor = async (context: ExecutionContext, draftId: string): Promise<readonly PublishTargetStatus[]> => {
    const rows = await sql.query<ItemRow>(
      `${ITEM_COLUMNS} where p.workspace_id = $1::uuid and s.post_id = $2::uuid order by s.scheduled_at asc`,
      [String(context.tenantId), asUuid("draftId", draftId)],
    );
    return rows.map(toStatus);
  };

  return {
    async validate(context, input): Promise<ValidationReport> {
      const draft = await draftIn(context, String(input.draftId));
      const issues: ValidationIssue[] = [];

      if (input.accountIds.length === 0) {
        // Not repairable: no rewrite supplies a destination, so the assistant must ask.
        issues.push({
          code: "no-destination",
          message: "No destination was given, so there is nothing to publish to.",
          repairable: false,
        });
      }

      const accounts = await accountsIn(context, input.accountIds as readonly string[]);
      for (const accountId of input.accountIds) {
        const account = accounts.get(String(accountId));
        if (account === undefined) {
          /**
           * Absent **or another tenant's** — the two are deliberately one answer.
           *
           * Distinguishing them would confirm the existence of other workspaces' account ids, the same
           * reasoning `getDraft` answers `not_found` rather than `forbidden`.
           */
          issues.push({
            code: "account-unknown",
            accountId: accountId as never,
            message: `No connected account ${String(accountId)} in this workspace.`,
            repairable: false,
          });
          continue;
        }
        if (account.status.toUpperCase() !== "ACTIVE") {
          issues.push({
            code: "account-inactive",
            accountId: accountId as never,
            platformId: account.platform as never,
            message: `The ${account.platform} account is ${account.status.toLowerCase()}; reconnect it before publishing.`,
            repairable: false,
          });
        }
        if (account.expiresAt !== null && Date.parse(iso(account.expiresAt)) <= now()) {
          // A publish would fail at the provider. Saying so here is the difference between a refusal the
          // assistant can explain and one it reports after asking a human to approve it.
          issues.push({
            code: "credential-expired",
            accountId: accountId as never,
            platformId: account.platform as never,
            message: `The ${account.platform} connection has expired; reconnect it before publishing.`,
            repairable: false,
          });
        }
      }

      /**
       * The platform limits, through `ContentService` rather than a second read of `platform_rules`.
       *
       * One notion of "is this caption publishable", for the reason the port gives about the table being
       * workspace-overridable: two readings would be two answers, and the one that mattered would be
       * whichever ran last.
       */
      const platforms = [...new Set([...accounts.values()].map((account) => account.platform))];
      if (platforms.length > 0) {
        const limits = await deps.validateContent(context, {
          caption: draft.caption,
          platformIds: platforms as never,
        });
        issues.push(...limits.issues);
      }

      /**
       * Duplication, against this workspace's recent posts.
       *
       * `findDuplicateContent` is ShareFlow's heuristic and already exists — a second similarity rule here
       * would be a second notion of "this is the same post again", and the two would disagree on exactly the
       * cases that matter.
       */
      const recent = await sql.query<{ id: string; raw_content: string }>(
        `select id, raw_content from public.posts
          where workspace_id = $1::uuid and id <> $2::uuid and status = 'PUBLISHED'
          order by updated_at desc limit $3`,
        [String(context.tenantId), draft.id, DUPLICATE_SCAN_LIMIT],
      );
      issues.push(
        ...findDuplicateContent(
          draft.caption,
          recent.map((row) => ({ postDraftId: row.id, caption: row.raw_content })),
        ),
      );

      /**
       * What could not be checked, said out loud.
       *
       * Both are `repairable: false` because rewriting changes nothing: the check is absent, not failed. They
       * do not make the report `ok: false` either — a deployment without a claims table cannot publish
       * anything if a missing check is a blocking finding, and that would be this adapter deciding a
       * customer's review policy.
       */
      const unchecked: ValidationIssue[] = [
        {
          code: "claims-unchecked",
          message:
            "No approved or forbidden claims are recorded in this deployment, so claim compliance was not checked.",
          repairable: false,
        },
        {
          code: "media-unchecked",
          message: "Media compatibility was not checked: this deployment has no media service.",
          repairable: false,
        },
      ];

      return { ok: issues.length === 0, issues: [...issues, ...unchecked] };
    },

    async schedule(context, input): Promise<readonly PublishTargetStatus[]> {
      const draftId = asUuid("draftId", String(input.draftId));
      const accounts = await accountsIn(
        context,
        input.targets.map((target) => String(target.accountId)),
      );
      for (const target of input.targets) {
        if (!accounts.has(String(target.accountId))) {
          throw new AgentPlatformError({
            code: "not_found",
            message: `No connected account ${String(target.accountId)} in this workspace.`,
            retryable: false,
          });
        }
      }

      /**
       * **One transaction, and a row lock on the draft, because nothing else stops a double publish.**
       *
       * `scheduled_items` has no unique constraint on `(post_id, social_account_id)` — the only unique index
       * is `(posting_schedule_id, social_account_id, occurrence_at)` and it is partial on
       * `posting_schedule_id IS NOT NULL`, so it covers recurring rules and not one-off scheduling. Checked
       * against the live schema rather than assumed.
       *
       * So `INSERT … WHERE NOT EXISTS` is not enough: under READ COMMITTED two concurrent calls both take a
       * snapshot in which the row is absent and both insert. `SELECT … FOR UPDATE` on the draft serialises
       * them — the second blocks until the first commits, and because each statement in READ COMMITTED takes
       * a fresh snapshot, its subsequent check sees the committed row.
       *
       * The port asks for exactly this: a *second, distinct* publish call for the same draft and account is
       * deduplicated, not just a retry of the same call. Derived from the call it would republish, "which is
       * the failure the zero-tolerance criterion is about".
       *
       * The remaining hole, stated rather than hidden: this serialises **this adapter's** callers. ShareFlow's
       * own route does not take the lock, so an app publish concurrent with an agent publish can still
       * produce two rows. Closing that needs a partial unique index on
       * `(post_id, social_account_id) WHERE posting_schedule_id IS NULL` — a migration in ShareFlow's
       * repository, and a decision about whether the app ever legitimately schedules one draft to one account
       * twice.
       */
      const rows = await deps.transaction.transaction(async (tx) => {
        const locked = await tx.query<{ id: string }>(
          `select id from public.posts where workspace_id = $1::uuid and id = $2::uuid for update`,
          [String(context.tenantId), draftId],
        );
        if (locked[0] === undefined) {
          throw new AgentPlatformError({ code: "not_found", message: `No post draft ${draftId}.`, retryable: false });
        }

        const ids: string[] = [];
        for (const target of input.targets) {
          const accountId = String(target.accountId);
          const when = target.scheduledAt ?? new Date(now()).toISOString();
          /**
           * `WHERE NOT EXISTS` as well as the lock, and not instead of it.
           *
           * The lock makes it correct under concurrency; this clause is what makes a *sequential* second
           * call a no-op rather than a second row. Both are needed, and neither is redundant.
           *
           * `posting_schedule_id is null` scopes the check to one-off items: a recurring rule legitimately
           * produces many items for one post and account, one per occurrence, and its own unique index
           * already governs those.
           */
          const inserted = await tx.query<{ id: string }>(
            `insert into public.scheduled_items (post_id, social_account_id, scheduled_at, status)
             select $1::uuid, $2::uuid, $3::timestamptz, 'PENDING'
              where not exists (
                select 1 from public.scheduled_items
                 where post_id = $1::uuid and social_account_id = $2::uuid and posting_schedule_id is null
              )
             returning id`,
            [draftId, accountId, when],
          );
          if (inserted[0] !== undefined) ids.push(inserted[0].id);
        }
        return ids;
      });

      /**
       * The queue, when a deployment supplied one — best effort, after the commit.
       *
       * After, deliberately: a queue failure must not roll back the row, because the row is what the sweep
       * finds. Enqueueing inside the transaction would make Redis able to lose a scheduled post.
       */
      if (deps.enqueue !== undefined) {
        for (const id of rows) {
          try {
            await deps.enqueue({ scheduledItemId: id, delayMs: 0 });
          } catch {
            // The sweep will find it. A post is late, not lost — which is the whole reason the row comes first.
          }
        }
      }

      // Read back every target for the draft, not only the rows just inserted: a caller re-issuing a call
      // needs the state of the destinations that were already done, which is the point of the dedupe.
      return statusFor(context, draftId);
    },

    async getStatus(context, input): Promise<readonly PublishTargetStatus[]> {
      return statusFor(context, String(input.draftId));
    },

    async retry(context, input): Promise<PublishTargetStatus> {
      const targetId = asUuid("targetId", String(input.targetId));
      /**
       * Only a `FAILED` target, and the guard is inside the statement.
       *
       * ShareFlow's own retry route refuses anything else with a 409, and the reason is the one the port
       * gives for retrying per target rather than per draft: a draft that published to three of four
       * destinations must not be re-sent to the three that succeeded. Checked in the `UPDATE`'s `WHERE`
       * rather than read-then-write, so two concurrent retries cannot both pass the check.
       *
       * `retry_count` is deliberately not touched — ShareFlow's worker owns that bookkeeping, and a second
       * writer would make the number mean nothing.
       */
      const updated = await deps.transaction.transaction(async (tx) => {
        const rows = await tx.query<{ id: string; status: string }>(
          `update public.scheduled_items s
              set status = 'PENDING', updated_at = now()
            where s.id = $2::uuid
              and s.status = 'FAILED'
              and exists (select 1 from public.posts p where p.id = s.post_id and p.workspace_id = $1::uuid)
            returning s.id, s.status`,
          [String(context.tenantId), targetId],
        );
        return rows[0];
      });

      if (updated === undefined) {
        /**
         * One read to say *which* refusal it was, and it runs only on the failure path.
         *
         * "Not found" and "not failed" are different answers and lead to different next steps — and a caller
         * told only "could not retry" will try again.
         */
        const existing = await sql.query<ItemRow>(
          `${ITEM_COLUMNS} where p.workspace_id = $1::uuid and s.id = $2::uuid`,
          [String(context.tenantId), targetId],
        );
        if (existing[0] === undefined) {
          throw new AgentPlatformError({
            code: "not_found",
            message: `No publish target ${targetId}.`,
            retryable: false,
          });
        }
        throw new AgentPlatformError({
          code: "conflict",
          message:
            `That destination is ${stateFrom(existing[0].status)}, not failed, so there is nothing to retry. ` +
            "Only a failed destination can be retried; a published one would post twice.",
          retryable: false,
        });
      }

      if (deps.enqueue !== undefined) {
        try {
          await deps.enqueue({ scheduledItemId: updated.id, delayMs: 0 });
        } catch {
          // As in `schedule`: the row is authoritative and the sweep finds it.
        }
      }

      const rows = await sql.query<ItemRow>(
        `${ITEM_COLUMNS} where p.workspace_id = $1::uuid and s.id = $2::uuid`,
        [String(context.tenantId), targetId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The retry was not recorded.", retryable: true });
      }
      return toStatus(row);
    },
  };
};

export { STATE_FROM_DB as PUBLISH_STATE_FROM_DB, stateFrom as publishStateFrom };
export type { PublishTarget };
