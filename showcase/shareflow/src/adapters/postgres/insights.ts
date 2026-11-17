/**
 * `InsightService` over `campaign_templates` and `analytics_daily` — #426.
 *
 * Two findings from reading the schema and the web app rather than the issue:
 *
 * 1. **`campaign_templates` has no `workspace_id`.** It is a global catalogue every workspace reads,
 *    so listing is unscoped by design. Starting a campaign from one is scoped, because the campaign
 *    is the workspace's.
 *
 * 2. **The template's `post_plan` is not used by anything.** `/api/ai/campaign` says so in its own
 *    comment: *"the template's goal is still read; its `post_plan` is not"* — the generator has no
 *    funnel-stage equivalent and refuses a request carrying one. So this returns the plan's *length*
 *    and not the plan: a count describes the playbook's shape honestly, where the plan itself would
 *    invite the model to promise stages the product cannot produce.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import { CADENCE_FROM_DB } from "./content.js";
import type {
  Campaign,
  CampaignTemplate,
  ContentService,
  DailyRollup,
  InsightService,
  MetricComparison,
  PeriodComparison,
} from "../../services/index.js";

export type InsightDeps = {
  readonly sql: SqlExecutor;
  /**
   * Campaign creation, borrowed from `ContentService` rather than reimplemented.
   *
   * The same reason `repost` borrows `duplicate`: creating a campaign correctly means knowing what a
   * campaign is — its cadence vocabulary, its date validation, its planned-post arithmetic — and a
   * second copy here would drift from the tool a user reaches directly.
   */
  readonly createCampaign: ContentService["createCampaign"];
};

type TemplateRow = {
  key: string;
  name: string;
  description: string | null;
  default_goal: string | null;
  default_cadence: string | null;
  recommended_channels: string[] | null;
  planned_posts: string | number | null;
};

const templateView = (row: TemplateRow): CampaignTemplate => ({
  key: row.key,
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  ...(row.default_goal === null ? {} : { defaultGoal: row.default_goal }),
  /*
   * Mapped to the port's vocabulary here, at the single point it enters the program, so no caller
   * can hand a store-shaped `3x_week` to `createCampaign` the way `startCampaignFromTemplate` did.
   */
  ...(row.default_cadence === null
    ? {}
    : { defaultCadence: CADENCE_FROM_DB[row.default_cadence] ?? "weekly" }),
  recommendedChannels: row.recommended_channels ?? [],
  plannedPosts: Number(row.planned_posts ?? 0),
});

const METRICS = ["impressions", "engagements", "linkClicks", "watchSeconds", "followers"] as const;
const COLUMN: Readonly<Record<(typeof METRICS)[number], string>> = {
  impressions: "impressions",
  engagements: "engagements",
  linkClicks: "link_clicks",
  watchSeconds: "watch_seconds",
  followers: "followers",
};

type Totals = Record<(typeof METRICS)[number], number> & { daysWithData: number };

const DAY_MS = 86_400_000;

/** A `date` column as the calendar day it is, with no timezone round-trip. See `getDailyRollup`. */
export const dayOf = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value as never);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const createPostgresInsightService = (deps: InsightDeps): InsightService => {
  const totalsFor = async (
    context: ExecutionContext,
    since: string,
    until: string,
    platform: string | undefined,
  ): Promise<Totals> => {
    const rows = await deps.sql.query<Record<string, string | number>>(
      `select coalesce(sum(impressions), 0)   as impressions,
              coalesce(sum(engagements), 0)   as engagements,
              coalesce(sum(link_clicks), 0)   as link_clicks,
              coalesce(sum(watch_seconds), 0) as watch_seconds,
              coalesce(sum(followers), 0)     as followers,
              count(distinct day)             as days
         from public.analytics_daily
        where workspace_id = $1::uuid
          and day >= $2::date
          and day <  $3::date
          and ($4::text is null or platform = $4::text)`,
      [String(context.tenantId), since, until, platform ?? null],
    );
    const row = rows[0] ?? {};
    return {
      impressions: Number(row["impressions"] ?? 0),
      engagements: Number(row["engagements"] ?? 0),
      linkClicks: Number(row["link_clicks"] ?? 0),
      watchSeconds: Number(row["watch_seconds"] ?? 0),
      followers: Number(row["followers"] ?? 0),
      daysWithData: Number(row["days"] ?? 0),
    };
  };

  return {
    async listCampaignTemplates(_context): Promise<readonly CampaignTemplate[]> {
      // No workspace filter, and that is not an omission: the catalogue is global.
      const rows = await deps.sql.query<TemplateRow>(
        `select key, name, description, default_goal, default_cadence, recommended_channels,
                jsonb_array_length(coalesce(post_plan, '[]'::jsonb)) as planned_posts
           from public.campaign_templates
          order by name`,
      );
      return rows.map(templateView);
    },

    async startCampaignFromTemplate(context, input) {
      const rows = await deps.sql.query<TemplateRow>(
        `select key, name, description, default_goal, default_cadence, recommended_channels,
                jsonb_array_length(coalesce(post_plan, '[]'::jsonb)) as planned_posts
           from public.campaign_templates
          where key = $1::text`,
        [input.templateKey],
      );
      const row = rows[0];
      if (row === undefined) {
        const known = await deps.sql.query<{ key: string }>(`select key from public.campaign_templates order by key`);
        throw new AgentPlatformError({
          code: "not_found",
          // Named, because a model that guessed a key can only recover if it is told the real ones.
          message:
            `There is no campaign template "${input.templateKey}". The ones that exist are: ` +
            `${known.map((k) => k.key).join(", ") || "none"}.`,
          retryable: false,
        });
      }
      const template = templateView(row);

      const campaign = await deps.createCampaign(context, {
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        theme: input.theme,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        // The caller's choice wins; the template's is the default, not the rule. Both are already in
        // the port's vocabulary — `listCampaignTemplates` maps the stored one on the way out.
        cadence: input.cadence ?? template.defaultCadence ?? "weekly",
        channels: (input.channels ?? template.recommendedChannels) as never,
        ...(template.defaultGoal === undefined ? {} : { goal: template.defaultGoal }),
      });

      /*
       * `template_key` and `primary_goal` recorded on the row, matching what `/api/ai/campaign` does
       * when a campaign is started from a template. Without them the campaign is indistinguishable
       * from a hand-made one, and the planner later has no idea which playbook it is filling.
       *
       * After creation rather than through the port: they are ShareFlow's own columns and
       * `ContentService.createCampaign` does not carry them, so adding them to that signature would
       * widen a shared port for one deployment's schema.
       */
      await deps.sql.query(
        `update public.campaigns
            set template_key = $2::text,
                primary_goal = coalesce(primary_goal, $3::text)
          where id = $1::uuid and workspace_id = $4::uuid`,
        [String(campaign.id), template.key, template.defaultGoal ?? null, String(context.tenantId)],
      );

      return { campaign, template };
    },

    async getDailyRollup(context, input): Promise<readonly DailyRollup[]> {
      const rows = await deps.sql.query<Record<string, string | number | Date>>(
        `select day, platform, impressions, engagements, link_clicks, watch_seconds, followers
           from public.analytics_daily
          where workspace_id = $1::uuid
            and day >= $2::date
            and ($3::date is null or day < $3::date)
            and ($4::text is null or platform = $4::text)
          order by day desc, platform`,
        [String(context.tenantId), input.since, input.until ?? null, input.platform ?? null],
      );
      return rows.map((row) => ({
        /*
         * Formatted from the local date parts, never through `toISOString`.
         *
         * A `date` column arrives as a Date at **local** midnight, so `toISOString()` converts it to
         * UTC and hands back the previous day for anyone east of Greenwich — a row stored as
         * 2026-09-10 was read back as 2026-09-09. The day is the fact; the midnight is an artefact of
         * the type.
         */
        day: dayOf(row["day"]),
        platform: String(row["platform"]),
        impressions: Number(row["impressions"] ?? 0),
        engagements: Number(row["engagements"] ?? 0),
        linkClicks: Number(row["link_clicks"] ?? 0),
        watchSeconds: Number(row["watch_seconds"] ?? 0),
        followers: Number(row["followers"] ?? 0),
      }));
    },

    async comparePeriods(context, input): Promise<PeriodComparison> {
      const start = Date.parse(input.since);
      const end = Date.parse(input.until);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `"${input.since}" to "${input.until}" is not a period — "until" must be after "since".`,
          retryable: false,
        });
      }

      const span = end - start;
      const priorSince = new Date(start - span).toISOString().slice(0, 10);
      const priorUntil = new Date(start).toISOString().slice(0, 10);

      const [current, previous] = await Promise.all([
        totalsFor(context, input.since, input.until, input.platform),
        totalsFor(context, priorSince, priorUntil, input.platform),
      ]);

      /*
       * #426's second acceptance, and the reason `change` is optional rather than zero.
       *
       * A prior window with no rows at all is "we were not measuring yet", not "we measured zero".
       * Comparing against a fabricated zero turns the first month of data into a 100% rise on every
       * metric — which is the dashboard's own rule, applied here where the assistant can see it.
       */
      const hasPrior = previous.daysWithData > 0;

      const metrics: MetricComparison[] = METRICS.map((metric) => {
        const now = current[metric];
        if (!hasPrior) return { metric, current: now };
        const before = previous[metric];
        return {
          metric,
          current: now,
          previous: before,
          change: {
            absolute: now - before,
            // Null, not Infinity and not 100: a rise from zero has no percentage, and saying so is
            // more use than a number that looks like a measurement.
            percent: before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10,
          },
        };
      });

      return {
        current: { since: input.since, until: input.until, daysWithData: current.daysWithData },
        ...(hasPrior
          ? { previous: { since: priorSince, until: priorUntil, daysWithData: previous.daysWithData } }
          : {
              noPriorWindowReason:
                `There is no data for the ${Math.round(span / DAY_MS)} days before ${input.since}, so ` +
                "there is nothing to compare this period against — not that nothing changed.",
            }),
        metrics,
      };
    },
  };
};
