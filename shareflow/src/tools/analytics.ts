/**
 * Analytics — docs/07 Workflow 5 (#125).
 *
 * *"Metrics are retrieved and calculated deterministically, the model explains patterns and labels
 * hypotheses, and it may not invent causal explanations."*
 *
 * ## Facts only, and the envelope has no room for anything else
 *
 * AC-2 asks for facts and interpretations to be structurally separated. The tempting shape is
 * `{ facts, interpretation }` — but who fills `interpretation`? The model does, *after* reading the facts.
 * A tool that emitted one would be doing exactly what AC-1 forbids.
 *
 * So there is no such field. That is the separation in its strongest form: not "kept apart" but "one of
 * them cannot be in here". A test asserts the absence, because it is the guarantee.
 *
 * ## Nothing here computes a number
 *
 * Every `compute*` function in ShareFlow is pure over rows, so this file passes values through and does no
 * arithmetic. Asserted two ways: the stubbed values appear verbatim, and the module is scanned for
 * arithmetic.
 *
 * ## What this provider does *not* satisfy
 *
 * AC-3 (an explanation labelled a hypothesis, visually distinct) and AC-6 (ending with a measurable next
 * experiment) are properties of the assistant's **reply**, not of a tool result — and the SPEC says so
 * itself: *"the skill supplies the presentation guidance; this provider supplies only computed facts."*
 * #125 extends `analytics-reporting` with both rather than leaving them unowned. "Visually distinct"
 * additionally needs a rendering affordance that does not exist — there is no hypothesis content part —
 * and that is raised rather than claimed.
 */
import { z } from "zod";
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import type {
  CampaignId,
  Fact,
  MetricsReport,
  MetricWindow,
  PostDraftId,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

const idString = z.string().min(1);

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "not a real date");

const windowSchema = z
  .object({ fromDay: calendarDate, toDay: calendarDate })
  .strict()
  .refine((v) => v.fromDay <= v.toDay, { message: "toDay must not be before fromDay" });

/**
 * One fact, passed through.
 *
 * Built field by field and branching on the union rather than spreading, so a `value` cannot appear
 * alongside an `unavailable` — which would let a caller read the number and ignore the reason it is not
 * one.
 */
const factView = (fact: Fact) =>
  "value" in fact
    ? {
        metric: fact.metric,
        unit: fact.unit,
        window: fact.window,
        value: fact.value,
        derivedFrom: fact.derivedFrom,
      }
    : {
        metric: fact.metric,
        unit: fact.unit,
        window: fact.window,
        // Not a zero. `computeAnalyticsKpis` returns 0 for engagement rate when impressions are zero,
        // which is right for a dashboard tile and wrong as a fact: no impressions is *undefined*, and an
        // assistant handed 0 will report "engagement was 0%".
        unavailable: fact.unavailable,
      };

const reportView = (report: MetricsReport) => ({
  facts: report.facts.map(factView),
  freshness: {
    stale: report.freshness.stale,
    ...(report.freshness.lastRefreshedAt === undefined
      ? {}
      : { lastRefreshedAt: report.freshness.lastRefreshedAt }),
  },
  // A boolean, and only a boolean — an excluded count would itself reveal the volume of data the caller
  // may not see. See the note on `MetricsReport.scoped`.
  scoped: report.scoped,
});

const postMetricsSchema = z.object({ postDraftId: idString, window: windowSchema.optional() }).strict();

export const postMetricsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_post_metrics",
    label: "Post performance",
    description:
      "Measured performance for one post. Every number carries the window it covers and the records it came from. A metric marked `unavailable` was NOT measured — say so rather than reporting it as zero, and check `freshness`: these are stored figures, not a live read. If `scoped` is true the figures cover only what you may see.",
    category: "analytics",
    effect: "read",
    inputSchema: postMetricsSchema,
    delegatesTo: "AnalyticsService.postMetrics",
    delegate: async (input: z.infer<typeof postMetricsSchema>, context) =>
      reportView(
        await services.analytics.postMetrics(context, {
          draftId: asId<PostDraftId>(input.postDraftId),
          ...(input.window === undefined ? {} : { window: input.window as MetricWindow }),
        }),
      ),
  });

const campaignMetricsSchema = z.object({ campaignId: idString, window: windowSchema.optional() }).strict();

export const campaignMetricsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_campaign_metrics",
    label: "Campaign performance",
    description:
      "Measured performance across a campaign's posts, aggregated by the service. Do not add up post figures yourself — an aggregate you compute is not a measurement, and it will disagree with this one.",
    category: "analytics",
    effect: "read",
    inputSchema: campaignMetricsSchema,
    delegatesTo: "AnalyticsService.campaignMetrics",
    delegate: async (input: z.infer<typeof campaignMetricsSchema>, context) =>
      reportView(
        await services.analytics.campaignMetrics(context, {
          campaignId: asId<CampaignId>(input.campaignId),
          ...(input.window === undefined ? {} : { window: input.window as MetricWindow }),
        }),
      ),
  });

const attributionSchema = z
  .object({
    postDraftId: idString.optional(),
    campaignId: idString.optional(),
    window: windowSchema.optional(),
  })
  .strict()
  .refine((v) => (v.postDraftId === undefined) !== (v.campaignId === undefined), {
    // Exactly one. Both would be ambiguous about what the number is attributed to, and an attribution
    // figure whose subject is unclear is worse than none.
    message: "supply either postDraftId or campaignId, not both",
  });

export const attributionTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_attribution",
    label: "Attributed leads",
    description:
      "Leads attributed to a post or a campaign, from the linkage recorded when each lead was captured. This is what a lead was actually attributed to — not an inference from timing, and not something to reconstruct by comparing dates.",
    category: "analytics",
    effect: "read",
    inputSchema: attributionSchema,
    delegatesTo: "AnalyticsService.attribution",
    delegate: async (input: z.infer<typeof attributionSchema>, context) =>
      reportView(
        await services.analytics.attribution(context, {
          ...(input.postDraftId === undefined ? {} : { draftId: asId<PostDraftId>(input.postDraftId) }),
          ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
          ...(input.window === undefined ? {} : { window: input.window as MetricWindow }),
        }),
      ),
  });

/** The complete Analytics catalog. All reads; none of them computes anything. */
export const ANALYTICS_TOOL_NAMES = [
  "get_post_metrics",
  "get_campaign_metrics",
  "get_attribution",
] as const;

export const ANALYTICS_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  postMetricsTool,
  campaignMetricsTool,
  attributionTool,
];
