/**
 * Campaign playbooks and daily rollups — #426.
 *
 * Two gaps, and they are different in kind.
 *
 * `campaign_templates` exists with a full shape and the assistant could not see it, so "run a
 * product-launch campaign" built from nothing when a playbook already existed.
 *
 * `analytics_daily` was *partially* reachable: the existing analytics tools read `post_metrics`, so
 * the assistant computed per-post numbers and had no cheap way to answer a trend question. The rollup
 * is impressions, engagements, link clicks, watch seconds and followers per day per platform — which
 * is exactly the shape a period comparison wants.
 */
import { z } from "zod";
import { type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import type { CampaignTemplate, MetricComparison, PeriodComparison } from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { shareFlowTool } from "./factory.js";

const templateView = (template: CampaignTemplate) => ({
  key: template.key,
  name: template.name,
  ...(template.description === undefined ? {} : { description: template.description }),
  ...(template.defaultGoal === undefined ? {} : { defaultGoal: template.defaultGoal }),
  ...(template.defaultCadence === undefined ? {} : { defaultCadence: template.defaultCadence }),
  recommendedChannels: template.recommendedChannels,
  plannedPosts: template.plannedPosts,
});

const comparisonView = (row: MetricComparison) => ({
  metric: row.metric,
  current: row.current,
  ...(row.previous === undefined ? {} : { previous: row.previous }),
  ...(row.change === undefined ? {} : { change: row.change }),
});

const periodView = (result: PeriodComparison) => ({
  current: result.current,
  ...(result.previous === undefined ? {} : { previous: result.previous }),
  ...(result.noPriorWindowReason === undefined ? {} : { noPriorWindowReason: result.noPriorWindowReason }),
  metrics: result.metrics.map(comparisonView),
});

export const listCampaignTemplatesTool = shareFlowTool(["insights"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "list_campaign_templates",
    label: "List campaign templates",
    description:
      "The campaign playbooks available — Product Launch, Seasonal Sale, Webinar Funnel and so on, each with the goal, cadence and channels it is shaped for. Offer one before building a campaign from scratch: a playbook is a shape someone already thought about. `plannedPosts` is how many posts the playbook describes, which is a guide to its size rather than a number this will create.",
    category: "insights",
    effect: "read",
    inputSchema: z.object({}).strict(),
    delegatesTo: "InsightService.listCampaignTemplates",
    delegate: async (_input: unknown, context) => ({
      templates: (await services.insights.listCampaignTemplates(context)).map(templateView),
    }),
  }));

const startSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    theme: z.string().trim().min(1).max(300),
    startsOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    endsOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    cadence: z.string().trim().min(1).max(40).optional(),
    channels: z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
  })
  .strict();

export const startCampaignFromTemplateTool = shareFlowTool(["insights"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "start_campaign_from_template",
    label: "Start a campaign from a template",
    description:
      "Create a campaign shaped by a playbook — it applies the template's goal, cadence and channels, and records which playbook it came from. **It creates the container and no posts**: fill it with `propose_post_angles` and `create_post_draft` afterwards, and say so rather than implying the posts exist. Pass `cadence` or `channels` only when the user asked for something other than the template's own. An unknown `templateKey` is refused with the real ones listed — use `list_campaign_templates` first.",
    category: "insights",
    /** Creates a row the workspace owns and publishes nothing — the same classification `create_campaign` has. */
    effect: "internal-write",
    inputSchema: startSchema,
    delegatesTo: "InsightService.startCampaignFromTemplate",
    delegate: async (input: z.infer<typeof startSchema>, context, { idempotencyKey }) => {
      const result = await services.insights.startCampaignFromTemplate(context, {
        idempotencyKey,
        templateKey: input.templateKey,
        name: input.name,
        theme: input.theme,
        startsOn: input.startsOn as never,
        endsOn: input.endsOn as never,
        ...(input.cadence === undefined ? {} : { cadence: input.cadence as never }),
        ...(input.channels === undefined ? {} : { channels: input.channels as never }),
      });
      return {
        campaignId: result.campaign.id,
        name: result.campaign.name,
        startsOn: result.campaign.startsOn,
        endsOn: result.campaign.endsOn,
        cadence: result.campaign.cadence,
        channels: result.campaign.channels,
        plannedPostCount: result.campaign.plannedPostCount,
        template: templateView(result.template),
        // Said in the result as well as the description: nothing has been written yet.
        postsCreated: 0,
      };
    },
  }));

const rollupSchema = z
  .object({
    since: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional(),
    platform: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const getDailyRollupTool = shareFlowTool(["insights"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "get_daily_rollup",
    label: "Daily performance rollup",
    description:
      "Performance by day and platform — impressions, engagements, link clicks, watch seconds and followers. Use this for a trend or a period question; use `get_post_metrics` when the question is about one post. A day with no row was not measured, which is not the same as a day that scored zero, so do not fill gaps in.",
    category: "insights",
    effect: "read",
    inputSchema: rollupSchema,
    delegatesTo: "InsightService.getDailyRollup",
    delegate: async (input: z.infer<typeof rollupSchema>, context) => ({
      days: await services.insights.getDailyRollup(context, {
        since: input.since,
        ...(input.until === undefined ? {} : { until: input.until }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
      }),
    }),
  }));

const compareSchema = z
  .object({
    since: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
    platform: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const comparePeriodsTool = shareFlowTool(["insights"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "compare_periods",
    label: "Compare two periods",
    description:
      "This period against the one immediately before it, per metric. **Read `noPriorWindowReason` before reporting any change.** When it is present there was no data before this period at all, so there is nothing to compare against — say that, and never report it as growth. A `change.percent` of null means the previous value was zero, where a percentage would be meaningless rather than large. The prior window is the same length as the one you ask for.",
    category: "insights",
    effect: "read",
    inputSchema: compareSchema,
    delegatesTo: "InsightService.comparePeriods",
    delegate: async (input: z.infer<typeof compareSchema>, context) =>
      periodView(
        await services.insights.comparePeriods(context, {
          since: input.since,
          until: input.until,
          ...(input.platform === undefined ? {} : { platform: input.platform }),
        }),
      ),
  }));

/** The complete Insights catalog, pinned by a test. */
export const INSIGHT_TOOL_NAMES = [
  "list_campaign_templates",
  "start_campaign_from_template",
  "get_daily_rollup",
  "compare_periods",
] as const;

export const INSIGHT_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listCampaignTemplatesTool,
  startCampaignFromTemplateTool,
  getDailyRollupTool,
  comparePeriodsTool,
];
