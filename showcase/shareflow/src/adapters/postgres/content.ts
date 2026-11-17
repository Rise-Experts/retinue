/**
 * `ContentService` over ShareFlow's own tables — REQ-041 (#190), and the second of the three `create-post` needs.
 *
 * ## Where the port and the schema disagree, and which one wins
 *
 * The ports were written from `docs/07`; the tables were written by ShareFlow. The port already anticipates the
 * biggest gap and resolves it the right way — `PostDraft.caption` is *one* caption rather than per-platform
 * variants, because "the store holds one caption plus `target_platforms`, and per-platform text is derived at
 * render time — there is nowhere to put an authored variant, so promising one here would make the adapter
 * unwritable."
 *
 * Two more, resolved the same way — the schema wins and the mapping is written down:
 *
 * - **`post_drafts` is `posts`.** One table holds drafts and published posts, distinguished by `status`.
 * - **Statuses are upper-case and a different vocabulary.** The live values seen in this deployment are
 *   `PUBLISHED` and `APPROVED`; the port's are lower-case and include `in-review` and `changes-requested`.
 *   `STATUS_FROM_DB` is the whole mapping, in one place, with an explicit fallback rather than a cast.
 * - **`mediaAssetIds` is `media_urls`.** The schema stores URLs, not asset ids. They are returned as-is and the
 *   type is honest about what a caller receives; inventing an id table would be a schema this deployment does
 *   not have.
 *
 * ## Validation reads `platform_rules`, and that is not an accident
 *
 * `char_limit`, `hashtag_min` and `hashtag_max` are **per workspace** in that table. The port says why the
 * limits stay in the service: *"`platform_rules` is workspace-overridable, so a limit known to the caller is a
 * limit that can be wrong for the workspace."* A constant here would be right for most tenants and silently
 * wrong for the ones who changed it — which is the shape of bug nobody reports because the post just fails.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import {
  CAMPAIGN_CADENCES,
  CAMPAIGN_MEDIA_TYPES,
  CAMPAIGN_MODES,
  POST_DRAFT_STATUSES,
  type Campaign,
  type CampaignCadence,
  type ContentService,
  type CreatedPostDraft,
  type Page,
  type PlatformRule,
  type PostDraft,
  type PostDraftStatus,
  type PostDraftSummary,
  type PublishTargetState,
  type ValidationIssue,
  type ValidationReport,
} from "../../services/index.js";

/**
 * The status mapping, in one place and total.
 *
 * Written out rather than lower-cased, because the two vocabularies are not the same set: the port has
 * `in-review` and `changes-requested`, and a `toLowerCase()` would silently produce statuses the type does not
 * have and callers do not branch on.
 *
 * **Exactly ShareFlow's five**, from `web/src/lib/data/posts.ts:5` (`PostStatus`) and confirmed by the
 * `enforce_post_status_transition` trigger, which is the authority on the vocabulary because it names every
 * legal transition. An earlier version of this map also had `REVIEW`, `REJECTED` and `SCHEDULED → approved`;
 * none of the three is a status this schema can hold, and the last was the worst — it would have reported a
 * post as approved on the strength of a value that does not exist.
 */
export const STATUS_FROM_DB: Readonly<Record<string, PostDraftStatus>> = {
  DRAFT: "draft",
  IN_REVIEW: "in-review",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  PUBLISHED: "published",
};

export const STATUS_TO_DB: Readonly<Record<PostDraftStatus, string>> = {
  draft: "DRAFT",
  "in-review": "IN_REVIEW",
  approved: "APPROVED",
  "changes-requested": "CHANGES_REQUESTED",
  published: "PUBLISHED",
};

/**
 * An unmapped status becomes `draft`, and the choice is deliberate.
 *
 * The alternatives are worse in both directions: throwing would make one unrecognised row break a whole list,
 * and `published` would tell an assistant a post is live when nobody knows. `draft` is the reading that leads
 * to the most cautious behaviour — it invites review rather than action.
 */
export const statusFrom = (value: string | null): PostDraftStatus =>
  (value === null ? undefined : STATUS_FROM_DB[value.toUpperCase()]) ?? "draft";

/** How many drafts a list returns at most. A tool result enters the context window. */
export const MAX_LIST_LIMIT = 50;
/** The recognition excerpt. Enough to tell two drafts apart, never the body. */
export const EXCERPT_CHARS = 160;

type PostRow = {
  id: string;
  campaign_id: string | null;
  status: string | null;
  raw_content: string | null;
  title: string | null;
  target_platforms: string[] | null;
  media_urls: string[] | null;
  /** `timestamptz`, which node-postgres parses into a `Date`. See `iso` below. */
  updated_at: string | Date;
  /** #495: `jsonb`, parsed by node-postgres into an object. Absent on rows read before the migration. */
  platform_captions?: Record<string, unknown> | null;
};

type RuleRow = { platform: string; char_limit: number | null; hashtag_min: number | null; hashtag_max: number | null };


type CampaignRow = {
  id: string;
  name: string;
  theme: string;
  goal: string | null;
  brief: string | null;
  tone: string | null;
  /** Selected as `::text`, so these really are `YYYY-MM-DD`. See `CAMPAIGN_COLUMNS`. */
  starts_on: string;
  ends_on: string;
  cadence: string;
  channels: string[] | null;
  status: string | null;
  mode: string | null;
  media_type: string | null;
  created_at: string | Date;
};

type CalendarRow = {
  id: string;
  post_id: string;
  scheduled_at: string | Date;
  status: string | null;
  platform: string | null;
  raw_content: string | null;
};

/**
 * The two campaign columns that are `NOT NULL` **with a default**, spelled out.
 *
 * They have to be, and the reason is a bug this replaced: `mode` and `media_type` were inserted as an explicit
 * `null` when the caller omitted them, which does not fall back to the column default — it violates the
 * not-null constraint. Every `createCampaign` call failed with `23502`, and nothing noticed because no test
 * created a campaign.
 *
 * Duplicating the schema's defaults is the cost of a single-statement insert. It is not left to trust: a test
 * reads `information_schema.columns.column_default` from the live database and fails if either drifts. They
 * also match ShareFlow's own route, which defaults the same two values at `web/src/app/api/ai/campaign/route.ts:71`.
 */
export const DEFAULT_CAMPAIGN_MODE = "assisted";
export const DEFAULT_CAMPAIGN_MEDIA_TYPE = "none";

/**
 * The status a campaign is created with — **lower-case**, because `campaigns_status_check` only admits
 * `draft`, `scheduled` and `done`.
 *
 * A post's statuses are upper-case in the same database and a campaign's are not, which is the kind of
 * inconsistency that survives review and fails at runtime: this insert said `'DRAFT'`.
 */
const CAMPAIGN_INITIAL_STATUS = "draft";

const CAMPAIGN_COLUMNS = `select id, name, theme, goal, brief, tone,
                                 starts_on::text as starts_on, ends_on::text as ends_on,
                                 cadence, channels, status, mode, media_type, created_at
                            from public.campaigns`;

/**
 * The cadence mapping, which the port asked for by name.
 *
 * *"Kebab-case per docs/01's union rule; the store's value is `3x_week`. **The adapter maps between them** —
 * noted here because it is exactly the kind of one-line translation that can go wrong silently, producing a
 * campaign whose cadence fails a CHECK constraint at insert time."*
 *
 * It did go wrong: an earlier version passed the port's value straight through, and `campaigns_cadence_check`
 * rejects `3x-week`. The insert failed for that one cadence and no test covered a campaign at all.
 */
export const CADENCE_TO_DB: Readonly<Record<CampaignCadence, string>> = {
  daily: "daily",
  "3x-week": "3x_week",
  weekly: "weekly",
};

/**
 * Exported so nothing writes a third copy of this mapping — #426.
 *
 * `campaign_templates.default_cadence` holds the **store's** vocabulary (`3x_week`), and seeding a
 * campaign from a template means handing that to `createCampaign`, which takes the **port's**
 * (`3x-week`). Passing it straight through fails the column's own CHECK, which is the bug the comment
 * above already records happening once.
 */
export const CADENCE_FROM_DB: Readonly<Record<string, CampaignCadence>> = {
  daily: "daily",
  "3x_week": "3x-week",
  weekly: "weekly",
};

/**
 * An unrecognised stored cadence reads as `weekly`, which is what ShareFlow's own function does with one —
 * its last line is an unguarded `// weekly` fallthrough. Agreeing with it matters more than being clever.
 */
export const cadenceFrom = (value: string | null): CampaignCadence =>
  (value === null ? undefined : CADENCE_FROM_DB[value]) ?? "weekly";

/** The cap, and the reason the port insists this number is ShareFlow's. */
export const CAMPAIGN_POST_CAP = 31;

/**
 * How many posts a range and cadence actually produce, **capped at 31**.
 *
 * The port is emphatic that this is ShareFlow's number: the cap means "daily for the next year" is 31 posts,
 * not 365, and *"without this field the assistant would report a year of daily posts and have planned a month
 * of them"*.
 *
 * ## This is a line-for-line replication, and it has to stay one
 *
 * The original is `postCountFor` in `web/src/lib/campaigns.ts:34` (ShareFlow commit `5e7fc0bd`). Nothing in
 * this package can call it — it is another repository, and the parity work is precisely about not depending on
 * that one at runtime. So it is copied, and the copy is pinned to the original's numbers in the tests.
 *
 * The first version here was *not* a replication. It computed `ceil(days / every)` from a table of intervals
 * that included `BIWEEKLY` and `MONTHLY` — neither of which this schema's CHECK constraint permits — and had
 * no arm for `3x-week` at all, so three-a-week fell through to weekly and reported **a third** of the posts
 * ShareFlow plans. That is the exact failure the port describes: the assistant states a number, ShareFlow
 * creates a different one, and nothing anywhere disagrees out loud.
 */
export const plannedPostCount = (startsOn: string, endsOn: string, cadence: CampaignCadence): number => {
  const days = Math.floor((Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days <= 0) return 0;
  if (cadence === "daily") return Math.min(days, CAMPAIGN_POST_CAP);
  if (cadence === "3x-week") return Math.min(Math.ceil((days / 7) * 3), CAMPAIGN_POST_CAP);
  return Math.min(Math.ceil(days / 7), CAMPAIGN_POST_CAP);
};

/**
 * An ISO instant, whatever the driver handed over.
 *
 * node-postgres parses `timestamptz` into a **`Date`**, and the port declares every one of these fields a
 * `string`. Without this, `updatedAt` is a `Date` that happens to serialise to the right thing through
 * `JSON.stringify` and fails every `typeof`, `slice` and `startsWith` a caller might do — and `nextCursor`,
 * which is one of these values, is documented as an opaque string.
 *
 * Same shape as `backend/src/adapters/postgres/run-store.ts:42`, which is the established convention here.
 */
const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * A calendar date. Trivial, because the **SQL** does the work: `CAMPAIGN_COLUMNS` selects `starts_on::text`.
 *
 * Deliberately not `new Date(...).toISOString().slice(0, 10)`. node-postgres parses a `date` column into a
 * `Date` at **local** midnight, so an ISO round-trip moves the day backwards for every negative UTC offset —
 * a campaign starting on the 1st would report the 30th for a user in Los Angeles. Asking Postgres for the text
 * removes the timezone from the question entirely.
 */
const asDate = (value: string): string => String(value).slice(0, 10);

const toCampaign = (row: CampaignRow): Campaign => ({
  id: row.id as never,
  name: row.name,
  theme: row.theme,
  ...(row.goal === null ? {} : { goal: row.goal }),
  ...(row.brief === null ? {} : { brief: row.brief }),
  ...(row.tone === null ? {} : { tone: row.tone }),
  startsOn: asDate(row.starts_on) as never,
  endsOn: asDate(row.ends_on) as never,
  cadence: cadenceFrom(row.cadence),
  channels: (row.channels ?? []) as never,
  /**
   * The three enum columns are read as stored, not lower-cased.
   *
   * `status`, `mode` and `media_type` are already the port's own vocabularies — `draft|scheduled|done`,
   * `autopilot|assisted|manual`, `none|image|video` — each held to that set by a CHECK constraint, so a
   * `toLowerCase()` here would only hide a value that cannot occur. The fallbacks are the schema's own
   * defaults; the previous `media_type ?? "image"` was neither the schema's default nor ShareFlow's, so an
   * absent value would have claimed the campaign generates images.
   */
  status: (row.status ?? "draft") as never,
  mode: (row.mode ?? DEFAULT_CAMPAIGN_MODE) as never,
  mediaType: (row.media_type ?? DEFAULT_CAMPAIGN_MEDIA_TYPE) as never,
  plannedPostCount: plannedPostCount(row.starts_on, row.ends_on, cadenceFrom(row.cadence)),
  createdAt: iso(row.created_at),
});

/**
 * `scheduled_items.status` to the port's `PublishTargetState` — **the mapping that was most wrong**.
 *
 * ShareFlow's vocabulary is four values, from `web/src/lib/data/posts.ts:6`: `PENDING | QUEUED | SUCCESS |
 * FAILED`. The previous version of this function mapped `PUBLISHED` and `CANCELLED`, neither of which the
 * column ever holds, had **no arm for `SUCCESS`**, and defaulted to `pending` — a value that is not in
 * `PUBLISH_TARGET_STATES` either. The result: every destination that had actually gone out was reported as
 * waiting to go out. An assistant asked "did the campaign publish?" would have said no.
 *
 * It typechecked because the return was cast `as never`. That cast is gone; the return type is the union, so
 * a value outside it is now a compile error rather than a confident wrong answer.
 *
 * `awaiting-platform` is unreachable from this table in this deployment — ShareFlow has no such status, the
 * transcode wait is tracked elsewhere — so it is deliberately absent rather than guessed at.
 */
const PUBLISH_STATE_FROM_DB: Readonly<Record<string, PublishTargetState>> = {
  PENDING: "scheduled",
  QUEUED: "publishing",
  SUCCESS: "published",
  FAILED: "failed",
};

/**
 * An unrecognised status reads as `publishing`, which the port defines as the unconfirmed state — *"an attempt
 * in flight, or one whose process died mid-attempt"*.
 *
 * The two obvious alternatives both assert something: `published` would claim an outcome, and `failed` would
 * claim a failure. "We do not have a confirmed result" is the only true reading of a value this code does not
 * know.
 */
const calendarState = (status: string | null): PublishTargetState =>
  (status === null ? undefined : PUBLISH_STATE_FROM_DB[status.toUpperCase()]) ?? "publishing";

/**
 * A UUID, or `invalid_input` naming the field.
 *
 * Every id here arrives from a **model**, through a tool schema that types it as a string. A malformed one
 * reaches `$1::uuid` and Postgres answers `invalid input syntax for type uuid: "1"`, which this adapter then
 * reported as `internal` — a code that reads as a platform fault, is treated as retryable in places, and tells
 * the model nothing it can act on. Found by running a real turn: the model passed `"1"` as an id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * A cursor, which is an instant, or `invalid_input`.
 *
 * The case that motivated it is worth recording exactly. A real gpt-4o turn called `list_campaigns` with
 *
 *     cursor: "}.kwargs_0_0} 0_SKIP_TO_PARAMS_MULTI_0_GP.next_0_multi_tool_use.parallel…"
 *
 * — parallel-tool-call junk the model emitted. It reached `$3::timestamptz` and came back as
 * `date/time field value out of range: "0"` under code `internal`. One malformed argument took out a turn
 * that was otherwise complete, and the message named a Postgres type rather than the field.
 *
 * A cursor is opaque to the caller, so the only honest check is that it is the kind of value this adapter
 * hands out: an instant.
 */
const asCursor = (value: string): string => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message:
        `cursor must be one this endpoint returned — got ${JSON.stringify(value.slice(0, 60))}. ` +
        "Pass `nextCursor` from a previous page, or omit it to start from the beginning.",
      retryable: false,
    });
  }
  return value;
};

/**
 * The three enum columns, checked here rather than by the constraint.
 *
 * The types already say `CampaignCadence`, so why check at runtime? Because these values arrive from a **model**
 * through a tool's Zod schema, and a schema one shade looser than the union — `z.string()` where the union was
 * meant — puts an arbitrary string here with nothing complaining. This session found three cases of a wrong
 * value typechecking and doing nothing; a cast at a tool boundary is exactly how that happens.
 *
 * The port's own argument for validating the date pair in the service applies word for word: left to the
 * constraint, this *"would reach the model as a raw violation string"* — `campaigns_cadence_check` names a
 * constraint, not the three values a caller may use.
 */
const assertOneOf = <T extends string>(field: string, value: string, allowed: readonly T[]): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `${field} must be one of ${allowed.join(", ")} — got ${JSON.stringify(value)}.`,
      retryable: false,
    });
  }
  return value as T;
};

/**
 * The date-order check, in one place.
 *
 * Both the create and the sparse update need it, and the update needs it against the *stored* value — see the
 * note there. A raw constraint violation reaching a model is a string it cannot act on.
 */
const assertDateOrder = (startsOn: string, endsOn: string): void => {
  if (asDate(endsOn) < asDate(startsOn)) {
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `A campaign cannot end (${asDate(endsOn)}) before it starts (${asDate(startsOn)}).`,
      retryable: false,
    });
  }
};

const notFound = (id: string): never => {
  /**
   * `not_found`, never `forbidden`, for a draft in another tenant.
   *
   * ShareFlow's own reason, and the port repeats it: the two must be indistinguishable, or the endpoint
   * confirms the existence of other tenants' ids. Every query here is scoped by `workspace_id`, so a
   * cross-tenant read returns no row and lands on this line by construction rather than by a check somebody
   * could forget.
   */
  throw new AgentPlatformError({ code: "not_found", message: `No post draft ${id}.`, retryable: false });
};

/**
 * The per-channel captions worth storing — #495.
 *
 * Only channels the post targets, trimmed, not blank, and not identical to the shared caption: an
 * entry equal to `caption` says nothing, and keeping it would make "this channel differs" untrue.
 * Order-independent and idempotent, so a caller sending the whole board every save is harmless.
 */
export const normalisePlatformCaptions = (
  raw: Readonly<Record<string, unknown>> | null | undefined,
  platforms: readonly string[],
  caption: string,
): Record<string, string> => {
  const allowed = new Set(platforms);
  const out: Record<string, string> = {};
  for (const [platform, value] of Object.entries(raw ?? {})) {
    if (!allowed.has(platform) || typeof value !== "string") continue;
    const text = value.trim();
    if (text !== "" && text !== caption.trim()) out[platform] = text;
  }
  return out;
};

const toDraft = (row: PostRow): PostDraft => ({
  id: row.id as never,
  ...(row.campaign_id === null ? {} : { campaignId: row.campaign_id as never }),
  status: statusFrom(row.status),
  caption: row.raw_content ?? "",
  platformCaptions: normalisePlatformCaptions(row.platform_captions, row.target_platforms ?? [], row.raw_content ?? "") as never,
  targetPlatforms: (row.target_platforms ?? []) as never,
  // URLs, not ids — see the header. Returned as stored rather than mapped through a table that does not exist.
  mediaAssetIds: (row.media_urls ?? []) as never,
  updatedAt: iso(row.updated_at),
});

/**
 * The Assistant conversation a write happened in — #500, so Edit can reopen it. Null outside one
 * (a direct `POST /api/tools/:name`, a campaign run with no conversation).
 */
const conversationOf = (context: ExecutionContext): string | null =>
  context.conversationId === undefined ? null : String(context.conversationId);

export const createPostgresContentService = (sql: SqlExecutor): ContentService => {
  /**
   * A campaign id, checked to be **this workspace's**.
   *
   * `posts_campaign_id_fkey` is `FOREIGN KEY (campaign_id) REFERENCES campaigns(id)` and nothing more, so the
   * database will happily attach workspace B's draft to workspace A's campaign. Verified against the live
   * schema rather than assumed:
   *
   * ```
   *  post_in_b | points_at_a_campaign
   * -----------+----------------------
   *  t         | t
   * ```
   *
   * The id comes from a model argument, so this is reachable — and it is the same lesson as the status
   * trigger, which skips validation entirely when `auth.uid()` is null: **the database does not guard this for
   * a service-role caller, so the service must.**
   *
   * `not_found` rather than `forbidden`, for the reason `getDraft` gives: the two must be indistinguishable or
   * the endpoint confirms the existence of other tenants' ids.
   *
   * It also fixes a worse-looking symptom that was the same bug. A well-formed id for a campaign that does not
   * exist reached the insert and came back as
   * `insert or update on table "posts" violates foreign key constraint` under code `internal` — a platform
   * fault, as far as any caller could tell.
   */
  const campaignInWorkspace = async (context: ExecutionContext, id: string): Promise<string> => {
    const found = await sql.query<{ id: string }>(
      `select id from public.campaigns where workspace_id = $1::uuid and id = $2::uuid`,
      [String(context.tenantId), asUuid("campaignId", id)],
    );
    if (found[0] === undefined) {
      throw new AgentPlatformError({
        code: "not_found",
        message: `No campaign ${id}. Pass an id from \`list_campaigns\`, or omit it to leave the draft unattached.`,
        retryable: false,
      });
    }
    return found[0].id;
  };

  const rulesFor = async (context: ExecutionContext, platforms: readonly string[]): Promise<RuleRow[]> => {
    if (platforms.length === 0) return [];
    /**
     * The workspace's own rows first, then the defaults.
     *
     * `platform_rules.workspace_id` is nullable — a null row is the shipped default and a non-null one is that
     * workspace's override. Reading only the workspace's would lose the default for platforms it has not
     * customised; reading only the defaults would ignore the override entirely, which is the failure the port
     * warns about.
     */
    return sql.query<RuleRow>(
      `select distinct on (platform) platform, char_limit, hashtag_min, hashtag_max
         from public.platform_rules
        where platform = any($2::text[])
          and (workspace_id = $1::uuid or workspace_id is null)
        order by platform, workspace_id nulls last`,
      [String(context.tenantId), [...platforms]],
    );
  };

  /**
   * The rules, for a caller that wants to *write within* them rather than be corrected by them — #287.
   *
   * Deliberately the same `rulesFor` the validator uses, not a second query: two readings of a
   * workspace-overridable table are two answers to "what is publishable", and generation being told
   * one thing while validation enforces another is worse than generation being told nothing.
   */
  const platformRules = async (
    context: ExecutionContext,
    platformIds: readonly string[],
  ): Promise<readonly PlatformRule[]> => {
    if (platformIds.length === 0) return [];
    const rows = await rulesFor(context, platformIds);
    return rows.map((row) => ({
      platformId: row.platform,
      charLimit: row.char_limit,
      hashtagMin: row.hashtag_min,
      hashtagMax: row.hashtag_max,
    }));
  };

  const validate = async (
    context: ExecutionContext,
    input: { caption: string; platformIds: readonly string[]; mediaAssetIds?: readonly string[] },
  ): Promise<ValidationReport> => {
    const issues: ValidationIssue[] = [];
    /**
     * **`repairable` is required, and omitting it silently killed the repair loop.**
     *
     * Every issue here was built with `as unknown as ValidationIssue` and no `repairable` field. The consumer
     * is `generate_content`'s loop, which reads `issues.some((i) => !i.repairable)` and stops immediately on
     * an unrepairable finding — and `!undefined` is `true`, so **every** finding read as unrepairable and
     * generation never made a second attempt.
     *
     * The effect on a real workflow, found by running one: ShareFlow's shipped instagram rule requires five
     * hashtags, gpt-4o writes two or three, and the repair loop recovers on the very next attempt when told.
     * With this field missing it never got one, and `generate_content` refused with "no version could be
     * written that passes the brand's rules and the destinations' limits" — which reads as the model being
     * incapable rather than as a dropped field.
     *
     * The casts are gone with it. They are what allowed a required field to go missing, and the type is the
     * only thing that would have said so.
     */
    if (input.caption.trim() === "") {
      // Repairable: an empty caption is exactly what regenerating fixes.
      issues.push({ code: "caption-empty", message: "The post has no text.", repairable: true });
    }
    if (input.platformIds.length === 0) {
      /**
       * **Not** repairable, and the distinction is the point of the field.
       *
       * No amount of regenerating supplies a destination. The assistant must ask, and a repair attempt here
       * would spend the bound to arrive at the same answer.
       */
      issues.push({
        code: "no-destination",
        message: "The post names no platform to publish to.",
        repairable: false,
      });
    }

    const rules = await rulesFor(context, input.platformIds);
    const hashtags = (input.caption.match(/(^|\s)#[\wÀ-￿-]+/g) ?? []).length;

    for (const platform of input.platformIds) {
      const rule = rules.find((candidate) => candidate.platform === platform);
      /**
       * A platform with no rule row is reported, not skipped.
       *
       * Silently accepting it would mean this deployment validated nothing for that destination — and the
       * failure would surface as a rejected publish, long after the assistant said the post was fine.
       */
      if (rule === undefined) {
        // A configuration gap, not a text problem: rewriting the caption will not create a rules row.
        issues.push({
          code: "platform-unknown",
          platformId: platform as never,
          message: `No rules are configured for ${platform}, so its limits could not be checked.`,
          repairable: false,
        });
        continue;
      }
      if (rule.char_limit !== null && input.caption.length > rule.char_limit) {
        issues.push({
          code: "caption-too-long",
          platformId: platform as never,
          message: `${input.caption.length} characters; ${platform} allows ${rule.char_limit}.`,
          repairable: true,
        });
      }
      if (rule.hashtag_max !== null && hashtags > rule.hashtag_max) {
        issues.push({
          code: "hashtags-too-many",
          platformId: platform as never,
          message: `${hashtags} hashtags; ${platform} allows at most ${rule.hashtag_max}.`,
          repairable: true,
        });
      }
      if (rule.hashtag_min !== null && hashtags < rule.hashtag_min) {
        issues.push({
          code: "hashtags-too-few",
          platformId: platform as never,
          message: `${hashtags} hashtags; ${platform} expects at least ${rule.hashtag_min}.`,
          repairable: true,
        });
      }
    }
    return { ok: issues.length === 0, issues };
  };

  /**
   * Each channel's own caption checked against **its own** platform — #495.
   *
   * The shared caption is validated for every target; an override replaces it on one channel only, so
   * it is checked for that channel alone. An X caption over 280 characters is refused here, with the
   * channel named, rather than accepted and then refused at publish time.
   */
  /**
   * Every channel checked against **the text it will publish** — #495, corrected in #497.
   *
   * The shared caption is checked against the channels that use it, and each channel with its own
   * caption against that caption. Checking the shared one against every target was the bug the post
   * panel found in production: `draft_post_for_channels` wrote Instagram (7 hashtags, within its 5–30)
   * and LinkedIn (its own text, within its 5), and the save refused with "7 hashtags; linkedin allows
   * at most 5" — Instagram's caption held to LinkedIn's rule, for a channel that never publishes it.
   * Media is checked on every channel, since every channel publishes it.
   */
  const assertPostValid = async (
    context: ExecutionContext,
    post: {
      readonly caption: string;
      readonly platforms: readonly string[];
      readonly platformCaptions: Readonly<Record<string, string>>;
      readonly mediaAssetIds?: readonly string[];
    },
    prefix: string,
  ): Promise<void> => {
    const media = post.mediaAssetIds === undefined ? {} : { mediaAssetIds: post.mediaAssetIds };
    const shared = post.platforms.filter((platform) => !Object.hasOwn(post.platformCaptions, platform));
    const issues: ValidationIssue[] = [];
    // No channels at all still goes through, for the validator's "no destination" answer.
    if (shared.length > 0 || post.platforms.length === 0) {
      issues.push(...(await validate(context, { caption: post.caption, platformIds: shared, ...media })).issues);
    }
    const sharedIssues = issues.length;
    for (const [platform, caption] of Object.entries(post.platformCaptions)) {
      const report = await validate(context, { caption, platformIds: [platform], ...media });
      issues.push(...report.issues.map((issue) => ({ ...issue, message: `${platform}: ${issue.message}` })));
    }
    if (issues.length > 0) {
      /**
       * The way out, said — production, 2026-09-28. One caption for facebook (at most 3 hashtags),
       * linkedin (at most 5) and instagram (at least 5) cannot pass, and the model spent five calls
       * adding and removing hashtags before it found `platformCaptions`, when it found it at all.
       */
      const hint =
        shared.length > 1 && sharedIssues > 0
          ? ` One caption cannot fit every channel here: keep \`caption\` and give the channels named above their own text in \`platformCaptions\`, e.g. {"${shared[0]}": "…"}.`
          : "";
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `${prefix}: ${issues.map((issue) => issue.message).join(" ")}${hint}`,
        retryable: false,
        details: { issues },
      });
    }
  };

  const service: ContentService = {
    async getDraft(context, input) {
      const rows = await sql.query<PostRow>(
        `select id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
           from public.posts where workspace_id = $1::uuid and id = $2::uuid`,
        [String(context.tenantId), asUuid("id", String(input.id))],
      );
      const row = rows[0];
      return row === undefined ? notFound(String(input.id)) : toDraft(row);
    },

    async listDrafts(context, input): Promise<Page<PostDraftSummary>> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIST_LIMIT);
      /**
       * One row over the limit, which is how the cursor is honest.
       *
       * Asking for `limit` and returning a cursor whenever the page is full would promise a next page that is
       * often empty — a caller then makes a second call to learn there was nothing. Fetching one extra answers
       * "is there more" for the cost of a row.
       */
      const rows = await sql.query<PostRow>(
        `select id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
           from public.posts
          where workspace_id = $1::uuid
            and ($2::uuid is null or campaign_id = $2::uuid)
            and ($3::text is null or status = $3::text)
            and ($4::timestamptz is null or updated_at < $4::timestamptz)
          order by updated_at desc
          limit $5`,
        [
          String(context.tenantId),
          input.campaignId === undefined ? null : asUuid("campaignId", String(input.campaignId)),
          input.status === undefined ? null : STATUS_TO_DB[input.status],
          input.cursor === undefined ? null : asCursor(input.cursor),
          limit + 1,
        ],
      );

      const page = rows.slice(0, limit);
      const items: PostDraftSummary[] = page.map((row) => {
        const caption = row.raw_content ?? "";
        return {
          id: row.id as never,
          status: statusFrom(row.status),
          // First line or so, for recognition — never the body. A list of twenty captions is the context budget.
          excerpt: caption.split("\n")[0]?.slice(0, EXCERPT_CHARS) ?? "",
          captionLength: caption.length,
          targetPlatforms: (row.target_platforms ?? []) as never,
          mediaCount: (row.media_urls ?? []).length,
          updatedAt: iso(row.updated_at),
        };
      });
      /**
       * The cursor is the last row's `updated_at`, matching the `order by`.
       *
       * A row offset would skip or repeat rows whenever a draft is edited between pages, which on a busy
       * workspace is most of the time.
       */
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.updated_at) }
        : { items };
    },

    /*
     * #497 AC-1: the channels written so far, on the turn's row. One key per tool call (`callKey`): a second
     * post in the same turn starts a fresh map rather than showing the first post's captions. Members can
     * read the table (its RLS), which is how the panel polls it while the run is still going.
     */
    async noteChannelWritten(context, input): Promise<void> {
      if (context.runId === undefined) return;
      await sql.query(
        `insert into public.assistant_turn_steps (run_id, workspace_id, conversation_id, steps, writing, updated_at)
         values ($1, $2::uuid, $3, 0, jsonb_build_object('callKey', $4::text, 'channels', jsonb_build_object($5::text, $6::text)), now())
         on conflict (run_id) do update set
           writing = case
             when public.assistant_turn_steps.writing ->> 'callKey' = $4::text
               then jsonb_set(public.assistant_turn_steps.writing, array['channels', $5::text], to_jsonb($6::text))
             else excluded.writing
           end`,
        [
          String(context.runId),
          String(context.tenantId),
          context.conversationId === undefined ? null : String(context.conversationId),
          input.callKey,
          input.platformId,
          input.caption,
        ],
      );
    },

    async createDraft(context, input): Promise<CreatedPostDraft> {
      const platformCaptions = normalisePlatformCaptions(
        input.platformCaptions as Record<string, unknown> | undefined,
        input.targetPlatforms as readonly string[],
        input.caption,
      );
      /**
       * Validation before the insert, and nothing is saved when it fails.
       *
       * #123's AC-3 asks for exactly this, and the reason it needed asking for is that the obvious order is the
       * other one: insert, validate, and leave a bad draft behind when the caller retries.
       */
      await assertPostValid(
        context,
        {
          caption: input.caption,
          platforms: input.targetPlatforms as readonly string[],
          platformCaptions,
          ...(input.mediaAssetIds === undefined ? {} : { mediaAssetIds: input.mediaAssetIds as readonly string[] }),
        },
        "That post cannot be saved",
      );

      /**
       * The campaign is resolved **before** the insert, not left to the foreign key.
       *
       * Two reasons and they are both about the answer the caller gets: the key cannot tell "no such campaign"
       * from "another tenant's campaign", and it would allow the second.
       */
      const campaignId =
        input.campaignId === undefined ? null : await campaignInWorkspace(context, String(input.campaignId));

      const rows = await sql.query<PostRow>(
        `insert into public.posts
           (workspace_id, author_id, title, raw_content, media_urls, status, target_platforms, campaign_id, platform_captions, conversation_id, project_id, text_format_preset_id)
         values ($1::uuid, $2::uuid, $3, $4, $5::text[], 'DRAFT', $6::text[], $7::uuid, $8::jsonb, $9,
                 -- #522: a draft written in a project chat belongs to that project.
                 (select pc.project_id from public.project_conversations pc where pc.workspace_id = $1::uuid and pc.conversation_id = $9),
                 -- #525: a text-only Facebook draft takes the project's background; media rules one out.
                 case when cardinality($5::text[]) = 0 and 'facebook' = any($6::text[]) then
                   (select nullif(p.design->>'facebookBackground', '')
                      from public.project_conversations pc
                      join public.projects p on p.id = pc.project_id and p.workspace_id = pc.workspace_id
                     where pc.workspace_id = $1::uuid and pc.conversation_id = $9)
                 end)
         returning id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions`,
        [
          String(context.tenantId),
          String(context.principalId),
          input.caption.split("\n")[0]?.slice(0, 120) ?? "",
          input.caption,
          [...(input.mediaAssetIds ?? [])],
          [...input.targetPlatforms],
          campaignId,
          JSON.stringify(platformCaptions),
          // #500: the conversation that wrote it, so Edit can reopen that conversation.
          conversationOf(context),
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The draft was not written.", retryable: true });
      }
      return {
        ...toDraft(row),
        /**
         * The stored length, which is the point of the field.
         *
         * ShareFlow's reason, verbatim: *"a model asked to repeat a long caption into a tool argument may
         * abbreviate it, and the result is a post that publishes a fragment of what the user was shown."*
         * Returning what was stored turns that from invisible into checkable.
         */
        captionLength: (row.raw_content ?? "").length,
        // No refusals: `media_urls` is a text array with no entitlement check to fail. Reported as empty
        // rather than omitted, because a caller reading "no refusals" should not have to distinguish that from
        // a field this adapter forgot.
        refusedMediaAssetIds: [],
      } as unknown as CreatedPostDraft;
    },

    /**
     * A thread, written in one statement — #456.
     *
     * ## Two decisions worth the words
     *
     * **Every part is validated before anything is written.** Each part becomes its own post on the
     * platform, so each has to fit that platform's limits alone — a thread whose fourth part is 400
     * characters over is not a long thread, it is one that stops at three, half in public. The issue
     * messages are prefixed with the ordinal because "part 4 is too long for x" is actionable and
     * "the post is too long" is not when there are five of them.
     *
     * **One statement, not a transaction.** A data-modifying CTE in Postgres runs exactly once and to
     * completion whether or not the outer query reads it, so the post and its parts commit together
     * with no transaction runner threaded through this service. The alternative — insert the post,
     * then the parts, and delete the post if that fails — is a compensating delete that can fail too.
     *
     * `raw_content` still holds the first part. Nothing publishes it for a thread, but a great deal
     * reads it: list excerpts, duplicate detection, the posts screen. Leaving it empty would make a
     * thread look like a blank post everywhere it is not being published.
     */
    async createThreadDraft(context, input): Promise<CreatedPostDraft> {
      if (input.parts.length < 2) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "A thread needs at least two parts — save a single post with create_post_draft instead.",
          retryable: false,
        });
      }

      /**
       * Two validations, because the rules are about two different things — and the real
       * `platform_rules` rows are what made that obvious rather than theoretical.
       *
       * **Length is per part.** Each part becomes its own post, so each has to fit alone; a thread
       * whose fourth part is 400 characters over is not a long thread, it is one that stops at three
       * with half of it already public.
       *
       * **Hashtags are per thread.** ShareFlow's shipped `x` rule requires at least one hashtag and
       * its `instagram` rule requires five. Applied per part, a five-part X thread would need five
       * hashtags and an Instagram one twenty-five — nobody writes that, and it would make threads
       * unusable on both. A hashtag rule is about the post a reader receives, and a reader receives a
       * thread as one thing: hashtags on the opening part count for all of it.
       *
       * The split is by issue code rather than by re-implementing either check, so both stay the
       * validator's answer. `HASHTAG_CODES` is the seam, and it is small on purpose.
       */
      const HASHTAG_CODES = new Set(["hashtags-too-few", "hashtags-too-many"]);
      const issues: ValidationIssue[] = [];
      for (const [index, part] of input.parts.entries()) {
        const report = await validate(context, {
          caption: part.body,
          platformIds: input.targetPlatforms as readonly string[],
          ...(part.mediaAssetIds === undefined ? {} : { mediaAssetIds: part.mediaAssetIds as readonly string[] }),
        });
        for (const issue of report.issues) {
          if (HASHTAG_CODES.has(issue.code)) continue;
          issues.push({ ...issue, message: `Part ${index + 1}: ${issue.message}` });
        }
      }

      /*
       * The whole thread, for the hashtag rules only. Its length is irrelevant here — the joined text
       * is longer than any platform allows by construction — so every other issue is discarded.
       */
      const whole = await validate(context, {
        caption: input.parts.map((part) => part.body).join("\n\n"),
        platformIds: input.targetPlatforms as readonly string[],
      });
      for (const issue of whole.issues) {
        if (HASHTAG_CODES.has(issue.code)) issues.push({ ...issue, message: `Across the thread: ${issue.message}` });
      }
      if (issues.length > 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `That thread cannot be saved: ${issues.map((issue) => issue.message).join(" ")}`,
          retryable: false,
          details: { issues },
        });
      }

      const campaignId =
        input.campaignId === undefined ? null : await campaignInWorkspace(context, String(input.campaignId));

      const first = input.parts[0] as { body: string; mediaAssetIds?: readonly string[] };
      const rows = await sql.query<PostRow>(
        `with new_post as (
           insert into public.posts
             (workspace_id, author_id, title, raw_content, media_urls, status, target_platforms, campaign_id, format, conversation_id, project_id)
           values ($1::uuid, $2::uuid, $3, $4, $5::text[], 'DRAFT', $6::text[], $7::uuid, 'thread', $10,
                   (select pc.project_id from public.project_conversations pc where pc.workspace_id = $1::uuid and pc.conversation_id = $10))
           returning id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
         ), new_parts as (
           insert into public.post_parts (post_id, ordinal, body)
           select new_post.id, part.ordinal, part.body
             from new_post, unnest($8::int[], $9::text[]) as part(ordinal, body)
           returning 1
         )
         select id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
           from new_post`,
        [
          String(context.tenantId),
          String(context.principalId),
          first.body.split("\n")[0]?.slice(0, 120) ?? "",
          first.body,
          [...(first.mediaAssetIds ?? [])],
          [...input.targetPlatforms],
          campaignId,
          input.parts.map((_part, index) => index + 1),
          input.parts.map((part) => part.body),
          conversationOf(context),
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The thread was not written.", retryable: true });
      }
      /*
       * `droppedMedia: []` rather than omitted: media on a thread part is not attached yet (only
       * part one's reaches `posts.media_urls`), and reporting an empty refusal list is what stops a
       * caller reading the absence as "nothing was dropped" when nothing was offered either.
       */
      return { ...toDraft(row), captionLength: (row.raw_content ?? "").length, droppedMedia: [] };
    },

    async updateDraft(context, input) {
      const id = asUuid("id", String(input.id));
      const current = await sql.query<PostRow>(
        `select id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
           from public.posts where workspace_id = $1::uuid and id = $2::uuid`,
        [String(context.tenantId), id],
      );
      const row = current[0];
      if (row === undefined) return notFound(String(input.id));

      /**
       * A published post is not editable, and the remedy is named.
       *
       * The port requires `conflict` with `details.remedy === EDIT_REMEDY_DUPLICATE` when duplicating would let
       * the caller proceed — which it would here, since `duplicateDraft` leaves the original untouched. Saying
       * so is what turns a refusal into something the assistant can act on rather than apologise for.
       */
      if (statusFrom(row.status) === "published") {
        throw new AgentPlatformError({
          code: "conflict",
          message: "That post is already published, so its text cannot be changed. Duplicate it to make an edited copy.",
          retryable: false,
          details: { remedy: "duplicate" },
        });
      }

      const caption = input.patch.caption ?? row.raw_content ?? "";
      const platforms = input.patch.targetPlatforms ?? ((row.target_platforms ?? []) as readonly string[]);
      /*
       * Per-channel captions (#495): a patch that sends them replaces them; one that does not keeps the
       * stored ones — renormalised, because a changed shared caption or channel list can make an entry
       * redundant or orphaned.
       */
      const platformCaptions = normalisePlatformCaptions(
        (input.patch.platformCaptions as Record<string, unknown> | undefined) ?? row.platform_captions,
        platforms as readonly string[],
        caption,
      );
      await assertPostValid(context, { caption, platforms: platforms as readonly string[], platformCaptions }, "That edit cannot be saved");

      const updated = await sql.query<PostRow>(
        `update public.posts
            set raw_content = $3,
                target_platforms = $4::text[],
                media_urls = coalesce($5::text[], media_urls),
                platform_captions = $6::jsonb,
                updated_at = now()
          where workspace_id = $1::uuid and id = $2::uuid
          returning id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions`,
        [
          String(context.tenantId),
          id,
          caption,
          [...platforms],
          input.patch.mediaAssetIds === undefined ? null : [...input.patch.mediaAssetIds],
          JSON.stringify(platformCaptions),
        ],
      );
      const next = updated[0];
      return next === undefined ? notFound(String(input.id)) : toDraft(next);
    },

    platformRules,

    async validateContent(context, input) {
      return validate(context, {
        caption: input.caption,
        platformIds: input.platformIds as readonly string[],
        ...(input.mediaAssetIds === undefined ? {} : { mediaAssetIds: input.mediaAssetIds as readonly string[] }),
      });
    },

    async duplicateDraft(context, input) {
      const id = asUuid("id", String(input.id));
      const rows = await sql.query<PostRow>(
        `select id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions
           from public.posts where workspace_id = $1::uuid and id = $2::uuid`,
        [String(context.tenantId), id],
      );
      const row = rows[0];
      if (row === undefined) return notFound(String(input.id));

      /**
       * The copy is a `DRAFT`, and nothing is scheduled.
       *
       * The port is explicit that the original is never touched — "its status, history, scheduled items and
       * metrics all stay intact. That is the whole point — a duplicate is safe in a way that mutating a
       * published post would not be." `campaign_id` is carried over; `is_voice_exemplar` deliberately is not,
       * because a copy has not earned that flag.
       */
      const copied = await sql.query<PostRow>(
        `insert into public.posts
           (workspace_id, author_id, title, raw_content, media_urls, status, target_platforms, campaign_id, platform_captions, conversation_id, project_id)
         select workspace_id, $3::uuid, title, raw_content, media_urls, 'DRAFT', $4::text[], campaign_id, platform_captions, $5,
                -- A copy made in a project chat joins that project; otherwise it keeps the original's.
                coalesce((select pc.project_id from public.project_conversations pc where pc.workspace_id = $1::uuid and pc.conversation_id = $5), project_id)
           from public.posts where workspace_id = $1::uuid and id = $2::uuid
         returning id, campaign_id, status, raw_content, title, target_platforms, media_urls, updated_at, platform_captions`,
        [
          String(context.tenantId),
          id,
          String(context.principalId),
          [...((input.targetPlatforms ?? (row.target_platforms ?? [])) as readonly string[])],
          // #500: a copy made in a conversation opens in that conversation, not the original's.
          conversationOf(context),
        ],
      );
      const next = copied[0];
      if (next === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The duplicate was not written.", retryable: true });
      }
      return toDraft(next);
    },

    /**
     * Campaigns — the five methods the compiler surfaced.
     *
     * They were missing, and an `as unknown as ContentService` cast was hiding it: the object satisfied nothing
     * and TypeScript checked nothing. Typing the const is what turned "looks complete" into five named gaps —
     * the same defect family as a declared provider that throws.
     *
     * `create-post` does not use them, but `ContentService` is one interface: a partial implementation would be
     * a service that throws for half its surface, which is precisely what #255 spent its time removing.
     */
    async getCampaign(context, input) {
      const rows = await sql.query<CampaignRow>(`${CAMPAIGN_COLUMNS} where workspace_id = $1::uuid and id = $2::uuid`, [
        String(context.tenantId),
        asUuid("id", String(input.id)),
      ]);
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No campaign ${String(input.id)}.`, retryable: false });
      }
      return toCampaign(row);
    },

    async listCampaigns(context, input) {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIST_LIMIT);
      const rows = await sql.query<CampaignRow>(
        `${CAMPAIGN_COLUMNS}
          where workspace_id = $1::uuid
            and ($2::text is null or status = $2::text)
            and ($3::timestamptz is null or created_at < $3::timestamptz)
          order by created_at desc
          limit $4`,
        [
          String(context.tenantId),
          input.status ?? null,
          input.cursor === undefined ? null : asCursor(input.cursor),
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const items = page.map((row) => {
        const full = toCampaign(row);
        return {
          id: full.id,
          name: full.name,
          theme: full.theme,
          status: full.status,
          startsOn: full.startsOn,
          endsOn: full.endsOn,
          cadence: full.cadence,
          channels: full.channels,
          plannedPostCount: full.plannedPostCount,
        };
      });
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.created_at) }
        : { items };
    },

    async getCampaignCalendar(context, input) {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIST_LIMIT);
      /**
       * Per **destination**, not per post — the port's reason: "a post to three channels is three rows with
       * three states". `scheduled_items` is already that shape, one row per post per account, which is why the
       * calendar joins it rather than reading `posts` and fanning out.
       */
      const rows = await sql.query<CalendarRow>(
        `select s.id, s.post_id, s.scheduled_at, s.status, a.platform, p.raw_content
           from public.scheduled_items s
           join public.posts p on p.id = s.post_id
           left join public.social_accounts a on a.id = s.social_account_id
          where p.workspace_id = $1::uuid
            and p.campaign_id = $2::uuid
            and ($3::timestamptz is null or s.scheduled_at > $3::timestamptz)
          order by s.scheduled_at asc
          limit $4`,
        [
          String(context.tenantId),
          asUuid("id", String(input.id)),
          input.cursor === undefined ? null : asCursor(input.cursor),
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const items = page.map((row) => ({
        postDraftId: row.post_id as never,
        excerpt: (row.raw_content ?? "").split("\n")[0]?.slice(0, EXCERPT_CHARS) ?? "",
        scheduledAt: iso(row.scheduled_at),
        platformId: (row.platform ?? "unknown") as never,
        state: calendarState(row.status),
      }));
      return rows.length > limit && page.length > 0
        ? { items, nextCursor: iso(page[page.length - 1]!.scheduled_at) }
        : { items };
    },

    async createCampaign(context, input) {
      assertDateOrder(input.startsOn, input.endsOn);
      const cadence = assertOneOf("cadence", input.cadence, CAMPAIGN_CADENCES);
      const mode = input.mode === undefined ? undefined : assertOneOf("mode", input.mode, CAMPAIGN_MODES);
      const mediaType =
        input.mediaType === undefined ? undefined : assertOneOf("mediaType", input.mediaType, CAMPAIGN_MEDIA_TYPES);
      const rows = await sql.query<CampaignRow>(
        `insert into public.campaigns
           (workspace_id, created_by, name, theme, goal, brief, tone, starts_on, ends_on, cadence, channels,
            status, mode, media_type)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11::text[],
                 $12, coalesce($13, $14), coalesce($15, $16))
         returning id, name, theme, goal, brief, tone, starts_on::text as starts_on, ends_on::text as ends_on,
                   cadence, channels, status, mode, media_type, created_at`,
        [
          String(context.tenantId),
          String(context.principalId),
          input.name,
          input.theme,
          input.goal ?? null,
          input.brief ?? null,
          input.tone ?? null,
          input.startsOn,
          input.endsOn,
          // Mapped, not passed through: `3x-week` is `3x_week` in the store and the CHECK constraint says so.
          CADENCE_TO_DB[cadence],
          [...input.channels],
          CAMPAIGN_INITIAL_STATUS,
          /**
           * `coalesce($13, $14)` rather than a bare parameter.
           *
           * `mode` and `media_type` are not-null with defaults, and an explicit `null` parameter does not fall
           * back to a column default — it violates the constraint. This is the whole of the bug that made
           * every campaign insert fail.
           */
          mode ?? null,
          DEFAULT_CAMPAIGN_MODE,
          mediaType ?? null,
          DEFAULT_CAMPAIGN_MEDIA_TYPE,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The campaign was not written.", retryable: true });
      }
      return toCampaign(row);
    },

    async updateCampaign(context, input) {
      const campaignId = asUuid("id", String(input.id));
      const existing = await sql.query<CampaignRow>(
        `${CAMPAIGN_COLUMNS} where workspace_id = $1::uuid and id = $2::uuid`,
        [String(context.tenantId), campaignId],
      );
      const row = existing[0];
      if (row === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No campaign ${String(input.id)}.`, retryable: false });
      }
      /**
       * The date pair is validated **here**, against the stored value — the port is explicit about why.
       *
       * The store has `CHECK (ends_on >= starts_on)`, and a caller changing only one of the two has no access
       * to the other. Left to the constraint, a one-sided edit reaches the model as a raw violation string it
       * cannot act on.
       */
      assertDateOrder(input.patch.startsOn ?? row.starts_on, input.patch.endsOn ?? row.ends_on);
      const patchCadence =
        input.patch.cadence === undefined ? undefined : assertOneOf("cadence", input.patch.cadence, CAMPAIGN_CADENCES);
      if (input.patch.mode !== undefined) assertOneOf("mode", input.patch.mode, CAMPAIGN_MODES);
      if (input.patch.mediaType !== undefined) {
        assertOneOf("mediaType", input.patch.mediaType, CAMPAIGN_MEDIA_TYPES);
      }

      const updated = await sql.query<CampaignRow>(
        `update public.campaigns set
            name = coalesce($3, name),
            theme = coalesce($4, theme),
            goal = coalesce($5, goal),
            brief = coalesce($6, brief),
            tone = coalesce($7, tone),
            starts_on = coalesce($8::date, starts_on),
            ends_on = coalesce($9::date, ends_on),
            cadence = coalesce($10, cadence),
            channels = coalesce($11::text[], channels),
            mode = coalesce($12, mode),
            media_type = coalesce($13, media_type)
          where workspace_id = $1::uuid and id = $2::uuid
          returning id, name, theme, goal, brief, tone, starts_on::text as starts_on, ends_on::text as ends_on,
                    cadence, channels, status, mode, media_type, created_at`,
        [
          String(context.tenantId),
          campaignId,
          input.patch.name ?? null,
          input.patch.theme ?? null,
          input.patch.goal ?? null,
          input.patch.brief ?? null,
          input.patch.tone ?? null,
          input.patch.startsOn ?? null,
          input.patch.endsOn ?? null,
          patchCadence === undefined ? null : CADENCE_TO_DB[patchCadence],
          input.patch.channels === undefined ? null : [...input.patch.channels],
          input.patch.mode ?? null,
          input.patch.mediaType ?? null,
        ],
      );
      const next = updated[0];
      if (next === undefined) {
        throw new AgentPlatformError({ code: "internal", message: "The campaign was not updated.", retryable: true });
      }
      return toCampaign(next);
    },
  };
  return service;
};

/** Every status the mapping knows, asserted in the tests against the port's own list. */
export const MAPPED_STATUSES = POST_DRAFT_STATUSES;
