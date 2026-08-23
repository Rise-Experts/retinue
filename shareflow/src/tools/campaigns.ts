/**
 * The Campaigns capabilities — `docs/07-shareflow-integration.md`, second tool category: *"read, create
 * and update campaigns"*, plus the content calendar (#116).
 *
 * Same construction as `posts.ts`: a `defineDelegatingTool` over a `ContentService` method, `.strict()`
 * schemas, sparse patches with no defaults, and lists that return summaries. What is specific here:
 *
 * - **Dates are calendar dates, validated as a pair.** `campaigns` has `CHECK (ends_on >= starts_on)`,
 *   and the model is perfectly capable of proposing a campaign that ends before it starts. Checked here
 *   when both are present so the message is a sentence rather than a constraint violation.
 * - **`plannedPostCount` is returned, not computed.** The store caps a fan-out at 31 posts, so "daily
 *   for the next year" is 31 — and the assistant has to be told, or it will report 365.
 * - **No paid operations.** See `PAID_CAMPAIGN_OPERATIONS` below.
 */
import { z } from "zod";
import { asId, type Tool } from "@agentkit/backend";
import { defineDelegatingTool } from "@agentkit/backend";
import {
  CAMPAIGN_CADENCES,
  CAMPAIGN_MEDIA_TYPES,
  CAMPAIGN_MODES,
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignCalendarEntry,
  type CampaignId,
  type CampaignSummary,
  type PlatformId,
} from "../services/index.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

/**
 * Why there is no `boost_campaign`, `set_campaign_budget` or anything like them.
 *
 * docs/07 says *"paid operations remain out of the initial workflow"*, and AC-4 of #116 asks for them to
 * be absent with the reason recorded. The accurate reason is not that they were considered and withheld:
 * **ShareFlow has no paid-campaign capability at all** — no ad account, no spend, no boost, in either the
 * web app or the AI backend. There is nothing here to expose.
 *
 * What is worth recording is what would have to be true before there were. An ad spend moves money out
 * of the tenant's account, which makes it an `external-write` behind the approval gate and an
 * idempotency key that survives a retry — not a campaign edit with a budget field. Adding one is a
 * decision about money, and `CAMPAIGN_TOOL_NAMES` below is pinned by a test so that decision has to be
 * made deliberately rather than inherited by whoever adds the next tool to this file.
 */
export const PAID_CAMPAIGN_OPERATIONS = "none — see the note in tools/campaigns.ts" as const;

/** `YYYY-MM-DD`. Rejected here rather than at the `date` column so the message names the field. */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "not a real date");

const channels = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(20)
  // Lower-cased and deduplicated for the same reason as a post's destinations: `channels` holds
  // platform ids, and a model routinely sends "LinkedIn".
  .transform((values) => [...new Set(values.map((v) => v.toLowerCase()))] as PlatformId[]);

const idString = z.string().min(1);
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().min(1).max(4_000);

/** Both dates present and out of order. Catchable here; the one-sided case is the service's. */
const orderedDates = (v: { startsOn?: string; endsOn?: string }) =>
  v.startsOn === undefined || v.endsOn === undefined || v.startsOn <= v.endsOn;
const ORDERED_DATES_MESSAGE = { message: "endsOn must not be before startsOn" };

const campaignView = (campaign: Campaign) => ({
  campaignId: campaign.id,
  name: campaign.name,
  theme: campaign.theme,
  ...(campaign.goal === undefined ? {} : { goal: campaign.goal }),
  ...(campaign.brief === undefined ? {} : { brief: campaign.brief }),
  ...(campaign.tone === undefined ? {} : { tone: campaign.tone }),
  startsOn: campaign.startsOn,
  endsOn: campaign.endsOn,
  cadence: campaign.cadence,
  channels: campaign.channels,
  status: campaign.status,
  mode: campaign.mode,
  mediaType: campaign.mediaType,
  plannedPostCount: campaign.plannedPostCount,
  createdAt: campaign.createdAt,
});

const campaignSummaryView = (summary: CampaignSummary) => ({
  campaignId: summary.id,
  name: summary.name,
  theme: summary.theme,
  status: summary.status,
  startsOn: summary.startsOn,
  endsOn: summary.endsOn,
  cadence: summary.cadence,
  channels: summary.channels,
  plannedPostCount: summary.plannedPostCount,
});

const calendarEntryView = (entry: CampaignCalendarEntry) => ({
  postDraftId: entry.postDraftId,
  excerpt: entry.excerpt,
  scheduledAt: entry.scheduledAt,
  platformId: entry.platformId,
  state: entry.state,
});

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

const listCampaignsSchema = z
  .object({
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const listCampaignsTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "list_campaigns",
    label: "List campaigns",
    description:
      "List the workspace's campaigns as short summaries — name, theme, dates, cadence, channels and how many posts the schedule produces. Use it to find the campaign the user means, then read that one.",
    category: "campaigns",
    effect: "read",
    inputSchema: listCampaignsSchema,
    delegatesTo: "ContentService.listCampaigns",
    delegate: async (input: z.infer<typeof listCampaignsSchema>, context) => {
      const page = await services.content.listCampaigns(context, {
        limit: input.limit,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        campaigns: page.items.map(campaignSummaryView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

const getCampaignSchema = z.object({ campaignId: idString }).strict();

export const getCampaignTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_campaign",
    label: "Read a campaign",
    description:
      "Read one campaign: its goal, brief, theme, tone, date range, cadence, destinations and how many posts that schedule actually produces. `plannedPostCount` is the real number — a long range at a high cadence is capped, so do not infer the count from the dates.",
    category: "campaigns",
    effect: "read",
    inputSchema: getCampaignSchema,
    delegatesTo: "ContentService.getCampaign",
    delegate: async (input: z.infer<typeof getCampaignSchema>, context) =>
      campaignView(await services.content.getCampaign(context, { id: asId<CampaignId>(input.campaignId) })),
  });

const getCampaignCalendarSchema = z
  .object({
    campaignId: idString,
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const getCampaignCalendarTool: ShareFlowToolFactory = ({
  services,
  deps,
}: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "get_campaign_calendar",
    label: "Read a campaign's calendar",
    description:
      "What the campaign is sending and when: one entry per post per destination, with the scheduled time, the destination and its state. Entries carry a short excerpt and the post's id — read the post itself for its full text.",
    category: "campaigns",
    effect: "read",
    inputSchema: getCampaignCalendarSchema,
    delegatesTo: "ContentService.getCampaignCalendar",
    delegate: async (input: z.infer<typeof getCampaignCalendarSchema>, context) => {
      const page = await services.content.getCampaignCalendar(context, {
        id: asId<CampaignId>(input.campaignId),
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        // Structured entries, not prose (AC-3). Every field is a value the model can compare, sort or
        // count — a rendered calendar would make it re-parse its own tool output.
        entries: page.items.map(calendarEntryView),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    },
  });

// ---------------------------------------------------------------------------------------------------
// Writes — `internal-write`. Creating a campaign schedules nothing; publishing stays in #119.
// ---------------------------------------------------------------------------------------------------

const createCampaignSchema = z
  .object({
    name: shortText,
    theme: shortText,
    startsOn: calendarDate,
    endsOn: calendarDate,
    cadence: z.enum(CAMPAIGN_CADENCES),
    channels,
    goal: shortText.optional(),
    brief: longText.optional(),
    tone: shortText.optional(),
    mode: z.enum(CAMPAIGN_MODES).optional(),
    mediaType: z.enum(CAMPAIGN_MEDIA_TYPES).optional(),
  })
  .strict()
  .refine(orderedDates, ORDERED_DATES_MESSAGE);

export const createCampaignTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "create_campaign",
    label: "Create a campaign",
    description:
      "Create a themed, date-ranged campaign. Nothing is scheduled or published by this — it creates the container its posts belong to. Check `plannedPostCount` in the result: a long range at a high cadence produces fewer posts than the dates suggest, and the user should be told the real number.",
    category: "campaigns",
    effect: "internal-write",
    inputSchema: createCampaignSchema,
    delegatesTo: "ContentService.createCampaign",
    delegate: async (input: z.infer<typeof createCampaignSchema>, context, { idempotencyKey }) =>
      campaignView(
        await services.content.createCampaign(context, {
          idempotencyKey,
          name: input.name,
          theme: input.theme,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          cadence: input.cadence,
          channels: input.channels,
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.brief === undefined ? {} : { brief: input.brief }),
          ...(input.tone === undefined ? {} : { tone: input.tone }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        }),
      ),
  });

const CAMPAIGN_PATCH_FIELDS = [
  "name",
  "theme",
  "goal",
  "brief",
  "tone",
  "startsOn",
  "endsOn",
  "cadence",
  "channels",
  "mode",
  "mediaType",
] as const;

const updateCampaignSchema = z
  .object({
    campaignId: idString,
    // Every field optional, no defaults — absent means "leave alone", as in `update_post_draft`.
    // `status` and `plannedPostCount` are absent entirely: the first is moved by scheduling, the second
    // is derived from the dates and cadence.
    name: shortText.optional(),
    theme: shortText.optional(),
    goal: shortText.optional(),
    brief: longText.optional(),
    tone: shortText.optional(),
    startsOn: calendarDate.optional(),
    endsOn: calendarDate.optional(),
    cadence: z.enum(CAMPAIGN_CADENCES).optional(),
    channels: channels.optional(),
    mode: z.enum(CAMPAIGN_MODES).optional(),
    mediaType: z.enum(CAMPAIGN_MEDIA_TYPES).optional(),
  })
  .strict()
  .refine((v) => CAMPAIGN_PATCH_FIELDS.some((f) => v[f] !== undefined), {
    message: `supply at least one of: ${CAMPAIGN_PATCH_FIELDS.join(", ")}`,
  })
  .refine(orderedDates, ORDERED_DATES_MESSAGE);

export const updateCampaignTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "update_campaign",
    label: "Edit a campaign",
    description:
      "Change a campaign. Only the fields you supply are touched — omit a field to leave it alone. Changing the dates or cadence changes how many posts the schedule produces, so check `plannedPostCount` in the result. The campaign's lifecycle status cannot be set here; it moves when posts are scheduled.",
    category: "campaigns",
    effect: "internal-write",
    inputSchema: updateCampaignSchema,
    delegatesTo: "ContentService.updateCampaign",
    delegate: async (input: z.infer<typeof updateCampaignSchema>, context, { idempotencyKey }) => {
      // Built by walking the known field list rather than spreading the input, so a future schema field
      // cannot reach the patch without a decision — and so `campaignId` cannot leak into it.
      const patch: Record<string, unknown> = {};
      for (const field of CAMPAIGN_PATCH_FIELDS) {
        const value = input[field];
        if (value !== undefined) patch[field] = value;
      }
      return campaignView(
        await services.content.updateCampaign(context, {
          idempotencyKey,
          id: asId<CampaignId>(input.campaignId),
          patch,
        }),
      );
    },
  });

/**
 * The complete Campaigns catalog.
 *
 * Pinned by a test. Adding a capability here — a paid one above all — has to be a deliberate change to
 * an assertion about what this category contains, rather than one more entry in a list.
 */
export const CAMPAIGN_TOOL_NAMES = [
  "list_campaigns",
  "get_campaign",
  "get_campaign_calendar",
  "create_campaign",
  "update_campaign",
] as const;

export const CAMPAIGN_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listCampaignsTool,
  getCampaignTool,
  getCampaignCalendarTool,
  createCampaignTool,
  updateCampaignTool,
];
