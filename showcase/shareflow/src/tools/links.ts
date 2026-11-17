/**
 * The link-tracking capabilities — #424.
 *
 * `short_links` and `link_clicks` were live, used by the web app, and invisible to the agent. The
 * consequence was narrower than "three missing tools": the assistant could answer **how far a post
 * reached** and not **whether it did anything**. Engagement is a proxy for interest; a click is
 * evidence, and without these the reach → clicks → leads funnel on the dashboard stays two-thirds
 * real.
 *
 * ## The window is required, and that is the interesting decision
 *
 * `get_link_performance` takes `since` rather than defaulting to all of history. "How many clicks did
 * this get" reads as a question about recent behaviour; answering it with a lifetime total is a
 * different answer to the same sentence, and the model has no way to tell which it got.
 *
 * ## Attribution is optional, and asymmetric
 *
 * A link may name a post, a campaign, both or neither — `short_links.post_id` and `campaign_id` are
 * nullable, because most links are just links. But `create_tracked_link` is the moment attribution is
 * cheap and every later moment is a guess, so the description pushes for it.
 */
import { z } from "zod";
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import type { CampaignId, LinkId, LinkPerformance, PostDraftId, TrackedLink } from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, shareFlowTool } from "./factory.js";

/** The full URL is what a person pastes; the slug is what the database stores. Both are returned. */
const linkView = (link: TrackedLink) => ({
  linkId: link.id,
  url: link.url,
  slug: link.slug,
  destinationUrl: link.destinationUrl,
  ...(link.title === undefined ? {} : { title: link.title }),
  clicks: link.clicks,
  createdAt: link.createdAt,
  ...(link.postId === undefined ? {} : { postId: link.postId }),
  ...(link.campaignId === undefined ? {} : { campaignId: link.campaignId }),
});

const performanceView = (row: LinkPerformance) => ({
  linkId: row.linkId,
  slug: row.slug,
  ...(row.title === undefined ? {} : { title: row.title }),
  destinationUrl: row.destinationUrl,
  ...(row.postId === undefined ? {} : { postId: row.postId }),
  ...(row.campaignId === undefined ? {} : { campaignId: row.campaignId }),
  clicks: row.clicks,
  referrers: row.referrers,
  countries: row.countries,
});

const listSchema = z
  .object({
    postId: idString.optional(),
    campaignId: idString.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const listTrackedLinksTool = shareFlowTool(["links"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "list_tracked_links",
    label: "List tracked links",
    description:
      "The workspace's short links with their lifetime click totals, newest first. Filter by `postId` or `campaignId` to see what a particular piece of work is tracking. Use this to find the link the user means before asking about its performance — and note the totals here are for all time, not a period.",
    category: "links",
    effect: "read",
    inputSchema: listSchema,
    delegatesTo: "LinkService.listTrackedLinks",
    delegate: async (input: z.infer<typeof listSchema>, context) => ({
      links: (
        await services.links.listTrackedLinks(context, {
          limit: input.limit,
          ...(input.postId === undefined ? {} : { postId: asId<PostDraftId>(input.postId) }),
          ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
        })
      ).map(linkView),
    }),
  }));

const performanceSchema = z
  .object({
    /**
     * Required, and the tool says why in its own description.
     *
     * An ISO timestamp rather than "last 7 days": the model already knows today's date from its
     * context, and a relative window parsed here would be a second calendar that disagrees with the
     * first one somewhere around a timezone boundary.
     */
    since: z.string().trim().min(4).max(40),
    until: z.string().trim().min(4).max(40).optional(),
    linkId: idString.optional(),
    postId: idString.optional(),
    campaignId: idString.optional(),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const getLinkPerformanceTool = shareFlowTool(["links"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "get_link_performance",
    label: "Link performance",
    description:
      "Clicks over a period for the workspace's tracked links, ordered by clicks, with where they came from and which country. `since` is required and is an ISO date or timestamp — a click total with no window is a lifetime figure being read as a recent one. Filter by `postId` to answer what a post drove, or `campaignId` for a whole campaign. A referrer of `direct` means someone typed or tapped the link rather than following it from somewhere.",
    category: "links",
    effect: "read",
    inputSchema: performanceSchema,
    delegatesTo: "LinkService.getLinkPerformance",
    delegate: async (input: z.infer<typeof performanceSchema>, context) => ({
      period: { since: input.since, ...(input.until === undefined ? {} : { until: input.until }) },
      links: (
        await services.links.getLinkPerformance(context, {
          since: input.since,
          limit: input.limit,
          ...(input.until === undefined ? {} : { until: input.until }),
          ...(input.linkId === undefined ? {} : { linkId: asId<LinkId>(input.linkId) }),
          ...(input.postId === undefined ? {} : { postId: asId<PostDraftId>(input.postId) }),
          ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
        })
      ).map(performanceView),
    }),
  }));

const createSchema = z
  .object({
    destinationUrl: z.string().trim().min(1).max(2000),
    title: z.string().trim().min(1).max(200).optional(),
    postId: idString.optional(),
    campaignId: idString.optional(),
  })
  .strict();

export const createTrackedLinkTool = shareFlowTool(["links"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "create_tracked_link",
    label: "Create a tracked link",
    description:
      "Mint a short link that counts its clicks, and attach it to the post or campaign it is for. Attribute it when you can — `postId` or `campaignId` is what later makes \"which post drove the most clicks\" answerable, and a link created without them can never be attributed afterwards. Put the returned `url` in the post rather than the destination. A bare domain is accepted; anything that is not a web address is refused.",
    category: "links",
    /**
     * `internal-write`, not `external-write`.
     *
     * It creates a row the workspace owns and publishes nothing — the link becomes public only when
     * someone puts it in a post, and that is a separate, gated action. Classified any higher and every
     * link would need an approval, which is the friction that stops people attributing anything.
     */
    effect: "internal-write",
    inputSchema: createSchema,
    delegatesTo: "LinkService.createTrackedLink",
    delegate: async (input: z.infer<typeof createSchema>, context, { idempotencyKey }) =>
      linkView(
        await services.links.createTrackedLink(context, {
          idempotencyKey,
          destinationUrl: input.destinationUrl,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.postId === undefined ? {} : { postId: asId<PostDraftId>(input.postId) }),
          ...(input.campaignId === undefined ? {} : { campaignId: asId<CampaignId>(input.campaignId) }),
        }),
      ),
  }));

/** The complete Links catalog, pinned by a test. */
export const LINK_TOOL_NAMES = ["list_tracked_links", "get_link_performance", "create_tracked_link"] as const;

export const LINK_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listTrackedLinksTool,
  getLinkPerformanceTool,
  createTrackedLinkTool,
];
