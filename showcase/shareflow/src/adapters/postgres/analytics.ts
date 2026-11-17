/**
 * `AnalyticsService` over `post_metrics`, `analytics_daily` and `leads` — REQ-041 (#190).
 *
 * Measured facts and nothing that interprets them. The port has no `interpretation` field on purpose — *"not
 * 'facts and interpretations are kept apart' but 'an interpretation cannot be in here'"* — so this adapter
 * reads numbers, states their window and their provenance, and stops.
 *
 * ## The defect the port names, with the line it lives on
 *
 * `web/src/lib/campaign-stats.ts:92` guards divide-by-zero like this:
 *
 * ```ts
 * engagementRate: impressions === 0 ? 0 : engagements / impressions,
 * ```
 *
 * Correct for a dashboard tile and **wrong as a fact**: no impressions makes engagement rate *undefined*, not
 * zero, and an assistant handed `0` will report "engagement was 0%" when the truth is "nothing was measured".
 * So zero impressions produces `unavailable: "no-data"` here, which is the whole reason `Fact` is a
 * discriminated union.
 *
 * The same rule covers the difference the `analytics-reporting` skill already states: *"if a platform is not
 * covered, say we cannot see its comments — not that the post has none."* A destination with no metrics row is
 * `not-collected`; a row of zeroes is `no-data`. Those are different sentences to a user.
 *
 * ## Freshness, and what ShareFlow actually refreshes
 *
 * `analytics-ingest.ts` refreshes metrics only for items published within the last **seven days**, so a post
 * older than that stops being updated: its numbers are final rather than merely late. ShareFlow has no
 * explicit staleness threshold, so `ANALYTICS_REFRESH_WINDOW_MS` below is this adapter's, named after the
 * window it is derived from — and `stale` means "has not been refreshed inside that window", which is true in
 * both cases even though the reason differs.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import type {
  AnalyticsService,
  CalendarDate,
  CampaignBreakdown,
  CampaignPostFacts,
  Fact,
  MetricFreshness,
  MetricWindow,
  MetricsReport,
} from "../../services/index.js";
/**
 * The recognition excerpt, from the content adapter rather than a second constant.
 *
 * A breakdown's excerpt and a draft list's excerpt are the same thing to a reader, and two constants would
 * eventually disagree about how much of a caption is enough to tell two posts apart.
 */
import { EXCERPT_CHARS } from "./content.js";

/**
 * How long ShareFlow keeps refreshing a post's metrics — `analytics-ingest.ts:170`'s seven days.
 *
 * Replicated because nothing in this package can call across the repository boundary, the same as
 * `postCountFor` and the sweep constants. It decides what `stale` means, so it is pinned in the tests.
 */
export const ANALYTICS_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** How many record ids a fact will carry inline. Beyond this, `recordType` plus the window is the trace. */
export const MAX_TRACED_IDS = 20;

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

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const asDay = (value: string | Date): CalendarDate => iso(value).slice(0, 10);

/**
 * The default window: the refresh window, ending today.
 *
 * A window is not optional in a `Fact` — *"a number without one is not a fact, it is a rumour"* — so a caller
 * that supplies none still gets one, and it is the range over which the numbers are actually maintained
 * rather than an open-ended "all time" that implies coverage nobody has.
 */
export const defaultWindow = (now: number): MetricWindow => ({
  fromDay: asDay(new Date(now - ANALYTICS_REFRESH_WINDOW_MS)),
  toDay: asDay(new Date(now)),
});

type MetricRow = {
  scheduled_item_id: string;
  likes: string | number | null;
  comments: string | number | null;
  shares: string | number | null;
  impressions: string | number | null;
  updated_at: string | Date | null;
};

/** `bigint` arrives as a string from node-postgres, so every count is normalised before it is summed. */
const count = (value: string | number | null): number => {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type AnalyticsDeps = {
  readonly sql: SqlExecutor;
  readonly now?: () => number;
};

export const createPostgresAnalyticsService = (deps: AnalyticsDeps): AnalyticsService => {
  const now = deps.now ?? Date.now;
  const { sql } = deps;

  /**
   * Every fact in one report shares one freshness, taken from the **oldest** row.
   *
   * The oldest rather than the newest: an aggregate is as fresh as its least fresh input, and reporting the
   * newest would let one recently refreshed destination present a month-old campaign total as current.
   */
  const freshnessOf = (rows: readonly { updated_at: string | Date | null }[]): MetricFreshness => {
    const stamps = rows
      .map((row) => (row.updated_at === null ? undefined : Date.parse(iso(row.updated_at))))
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (stamps.length === 0) return { stale: true };
    const oldest = Math.min(...stamps);
    return {
      lastRefreshedAt: new Date(oldest).toISOString(),
      stale: now() - oldest > ANALYTICS_REFRESH_WINDOW_MS,
    };
  };

  /**
   * Counts, and the engagement rate as a fact **or** an explicit absence.
   *
   * `recordIds` only for a small set: an aggregate over 500 rows carrying 500 ids is a context bomb and 500
   * ids the model will never read. `recordType` plus the window is the trace — "traceable" means an auditor
   * can find the rows, not that they are inlined.
   */
  const factsFrom = (rows: readonly MetricRow[], window: MetricWindow): readonly Fact[] => {
    const derivedFrom = {
      recordType: "post_metrics" as const,
      recordCount: rows.length,
      ...(rows.length > 0 && rows.length <= MAX_TRACED_IDS
        ? { recordIds: rows.map((row) => row.scheduled_item_id) }
        : {}),
    };

    if (rows.length === 0) {
      /**
       * No row at all is `not-collected`, not `no-data`.
       *
       * The distinction is the skill's: a destination with no metrics row is one this deployment cannot see,
       * and saying "0 likes" about it would assert a measurement nobody took.
       */
      return (["likes", "comments", "shares", "impressions", "engagement_rate"] as const).map((metric) => ({
        metric,
        unit: metric === "engagement_rate" ? ("fraction" as const) : ("count" as const),
        window,
        unavailable: "not-collected" as const,
      }));
    }

    const likes = rows.reduce((total, row) => total + count(row.likes), 0);
    const comments = rows.reduce((total, row) => total + count(row.comments), 0);
    const shares = rows.reduce((total, row) => total + count(row.shares), 0);
    const impressions = rows.reduce((total, row) => total + count(row.impressions), 0);

    return [
      { metric: "likes", unit: "count", window, value: likes, derivedFrom },
      { metric: "comments", unit: "count", window, value: comments, derivedFrom },
      { metric: "shares", unit: "count", window, value: shares, derivedFrom },
      { metric: "impressions", unit: "count", window, value: impressions, derivedFrom },
      /**
       * **The defect the port names.** `campaign-stats.ts:92` returns `0` here; no impressions makes the rate
       * undefined, and `0` reads to an assistant as "engagement was 0%".
       *
       * Recomputed from the summed counts rather than averaging the stored per-row `engagement_rate`, because
       * a mean of rates is not the rate of the totals — a post with one impression and one like would weigh
       * as much as one with ten thousand.
       */
      impressions === 0
        ? { metric: "engagement_rate", unit: "fraction", window, unavailable: "no-data" }
        : {
            metric: "engagement_rate",
            unit: "fraction",
            window,
            value: (likes + comments + shares) / impressions,
            derivedFrom,
          },
    ];
  };

  /**
   * Metrics rows for a set of drafts, inside the window.
   *
   * Scoped through `posts.workspace_id` on every call — `post_metrics` is keyed by `scheduled_item_id` and
   * carries **no workspace column**, so its only tenant scope is the join. A query that read it directly
   * would read every tenant's numbers.
   */
  const metricsFor = async (
    context: ExecutionContext,
    where: string,
    params: readonly unknown[],
    window: MetricWindow,
  ): Promise<MetricRow[]> =>
    sql.query<MetricRow>(
      `select m.scheduled_item_id, m.likes, m.comments, m.shares, m.impressions, m.updated_at
         from public.post_metrics m
         join public.scheduled_items s on s.id = m.scheduled_item_id
         join public.posts p on p.id = s.post_id
        where p.workspace_id = $1::uuid
          and ${where}
          and s.scheduled_at >= $2::date
          and s.scheduled_at < ($3::date + interval '1 day')`,
      [String(context.tenantId), window.fromDay, window.toDay, ...params],
    );

  return {
    async postMetrics(context, input): Promise<MetricsReport> {
      const window = input.window ?? defaultWindow(now());
      const draftId = asUuid("draftId", String(input.draftId));
      /**
       * The draft is checked to exist, so "no metrics" and "no such post" are different answers.
       *
       * Without it, another tenant's id would come back as a report full of `not-collected` — which reads as
       * "we have no numbers for your post" rather than "that is not your post".
       */
      const exists = await sql.query<{ id: string }>(
        "select id from public.posts where workspace_id = $1::uuid and id = $2::uuid",
        [String(context.tenantId), draftId],
      );
      if (exists[0] === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No post draft ${draftId}.`, retryable: false });
      }

      const rows = await metricsFor(context, "s.post_id = $4::uuid", [draftId], window);
      return {
        facts: factsFrom(rows, window),
        freshness: freshnessOf(rows),
        /**
         * `scoped` is false because these adapters do not filter by principal.
         *
         * Stated rather than left blank: the port requires a partial aggregate to admit it, and the honest
         * report here is that nothing was excluded — every destination of a post the caller can see is
         * counted. It becomes true the day a deployment scopes rows per principal.
         */
        scoped: false,
      };
    },

    async campaignMetrics(context, input): Promise<MetricsReport> {
      const window = input.window ?? defaultWindow(now());
      const campaignId = asUuid("campaignId", String(input.campaignId));
      const exists = await sql.query<{ id: string }>(
        "select id from public.campaigns where workspace_id = $1::uuid and id = $2::uuid",
        [String(context.tenantId), campaignId],
      );
      if (exists[0] === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No campaign ${campaignId}.`, retryable: false });
      }

      // Aggregated by the service, never by the caller — the port is explicit, and a caller summing rows
      // would be a second aggregation to keep in step.
      const rows = await metricsFor(context, "p.campaign_id = $4::uuid", [campaignId], window);
      return { facts: factsFrom(rows, window), freshness: freshnessOf(rows), scoped: false };
    },

    async campaignBreakdown(context, input): Promise<CampaignBreakdown> {
      const window = input.window ?? defaultWindow(now());
      const campaignId = asUuid("campaignId", String(input.campaignId));
      const exists = await sql.query<{ id: string }>(
        "select id from public.campaigns where workspace_id = $1::uuid and id = $2::uuid",
        [String(context.tenantId), campaignId],
      );
      if (exists[0] === undefined) {
        throw new AgentPlatformError({ code: "not_found", message: `No campaign ${campaignId}.`, retryable: false });
      }

      /**
       * One query, left-joined **outwards from posts**.
       *
       * `campaignMetrics` reads inwards from `post_metrics`, which is right for an aggregate and wrong
       * here: a post with no destinations, or with destinations nobody has collected, would simply not
       * appear — and "the post we have no numbers for" is exactly what an evaluation needs to see. It is
       * also why `metric_item_id` is selected: a left join produces a row whose metric columns are all
       * null, and treating that as a row of zeroes would report `no-data` for a post that is really
       * `not-collected`.
       *
       * Scoped through `posts.workspace_id`, the same as every other query here — `post_metrics` carries
       * no workspace column, so the join is its only tenant scope.
       */
      const rows = await sql.query<
        MetricRow & {
          post_id: string;
          raw_content: string | null;
          target_platforms: string[] | null;
          item_id: string | null;
          item_status: string | null;
          metric_item_id: string | null;
        }
      >(
        `select p.id as post_id, p.raw_content, p.target_platforms,
                s.id as item_id, s.status as item_status,
                m.scheduled_item_id as metric_item_id, m.scheduled_item_id,
                m.likes, m.comments, m.shares, m.impressions, m.updated_at
           from public.posts p
           left join public.scheduled_items s
                  on s.post_id = p.id
                 and s.scheduled_at >= $2::date
                 and s.scheduled_at < ($3::date + interval '1 day')
           left join public.post_metrics m on m.scheduled_item_id = s.id
          where p.workspace_id = $1::uuid
            and p.campaign_id = $4::uuid
          order by p.created_at asc, s.id asc`,
        [String(context.tenantId), window.fromDay, window.toDay, campaignId],
      );

      /** Grouped in insertion order, which the `order by` made the campaign's own order. */
      const byPost = new Map<string, typeof rows>();
      for (const row of rows) {
        const bucket = byPost.get(row.post_id);
        if (bucket === undefined) byPost.set(row.post_id, [row]);
        else bucket.push(row);
      }

      const measured = rows.filter((row) => row.metric_item_id !== null);
      const posts: CampaignPostFacts[] = [...byPost.entries()].map(([postId, postRows]) => {
        const caption = postRows[0]?.raw_content ?? "";
        /**
         * Destinations counted once each, keyed on the **item** id.
         *
         * Keyed on the metric id instead, a published destination nobody has collected has a null key —
         * so three uncollected-but-published destinations collapse into one, and the count is wrong in
         * exactly the case the field exists to describe.
         */
        const published = new Set(
          postRows.filter((row) => row.item_status === "SUCCESS" && row.item_id !== null).map((row) => String(row.item_id)),
        );
        return {
          draftId: postId as never,
          excerpt: caption.split("\n")[0]?.slice(0, EXCERPT_CHARS) ?? "",
          platforms: (postRows[0]?.target_platforms ?? []) as never,
          publishedDestinations: published.size,
          facts: factsFrom(
            postRows.filter((row) => row.metric_item_id !== null),
            window,
          ),
        };
      });

      return {
        posts,
        // From the same rows as `campaignMetrics` sees, so the two cannot disagree about the same window.
        totals: factsFrom(measured, window),
        freshness: freshnessOf(measured),
        scoped: false,
      };
    },

    async attribution(context, input): Promise<MetricsReport> {
      const window = input.window ?? defaultWindow(now());
      if ((input.draftId === undefined) === (input.campaignId === undefined)) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "Ask for a draft or a campaign, and not both.",
          retryable: false,
        });
      }

      /**
       * Matched on the encoded attribution `LeadService` writes, not on a hopeful join.
       *
       * The port: *"the attribution was recorded when the lead was created, so a number here resolves to lead
       * records rather than to a join someone hopes is right."* `captured_from` holds `post=<id>` /
       * `campaign=<id>` segments, so this looks for the exact segment rather than a substring of the id —
       * `like '%<id>%'` would match a lead attributed to a *different* record whose id contained this one as a
       * substring, which for uuids is unlikely and for the encoding is unnecessary.
       */
      const key = input.draftId === undefined ? "campaign" : "post";
      const id = asUuid(key === "post" ? "draftId" : "campaignId", String(input.draftId ?? input.campaignId));
      const segment = `${key}=${id}`;

      const rows = await sql.query<{ id: string; value_cents: number | null; updated_at: string | Date | null }>(
        `select id, value_cents, updated_at
           from public.leads
          where workspace_id = $1::uuid
            and ($2 = any(string_to_array(coalesce(captured_from, ''), ';')))
            and created_at >= $3::date
            and created_at < ($4::date + interval '1 day')`,
        [String(context.tenantId), segment, window.fromDay, window.toDay],
      );

      const derivedFrom = {
        recordType: "leads" as const,
        recordCount: rows.length,
        ...(rows.length > 0 && rows.length <= MAX_TRACED_IDS ? { recordIds: rows.map((row) => row.id) } : {}),
      };

      /**
       * Zero leads is a **measured zero**, unlike zero impressions.
       *
       * The difference is whether the absence of rows means "not measured" or "measured none". Every lead this
       * workspace captured is in this table, so no matching row genuinely means none were attributed — where
       * a missing `post_metrics` row means nobody collected the numbers. Reporting `no-data` here would refuse
       * to answer a question that has an answer.
       */
      return {
        facts: [
          { metric: "attributed_leads", unit: "count", window, value: rows.length, derivedFrom },
          {
            metric: "attributed_pipeline_value",
            unit: "minor-units",
            window,
            value: rows.reduce((total, row) => total + count(row.value_cents), 0),
            derivedFrom,
          },
        ],
        // Leads are written as they arrive rather than refreshed, so there is no refresh to be stale.
        freshness: { stale: false },
        scoped: false,
      };
    },
  };
};
