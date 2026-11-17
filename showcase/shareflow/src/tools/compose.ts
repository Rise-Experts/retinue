import { z } from "zod";
import { AgentPlatformError, asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import type { PlatformId, PostDraftId } from "../services/index.js";
import { chargeWritten } from "./credits.js";
import { withProjectBrief } from "./project-brief.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, shareFlowTool } from "./factory.js";
import { DEFAULT_REPAIR_BOUND, issueView, platformList } from "./generate.js";
import { writeForChannels, type ChannelOutcome } from "./write-channels.js";

/**
 * Writing a post for several channels at once, and revising it by channel — #496.
 *
 * The Assistant's post agent. Compose (#479) wrote one version per channel in parallel and kept them
 * on one post; before this, the Assistant could only `generate_content` (saves nothing) and then
 * `create_post_draft` once **per destination** — N drafts for one post. These two tools keep one draft
 * with a caption per channel (`posts.platform_captions`, #495), written under exactly
 * `generate_content`'s rules through the shared `writeForChannels`.
 *
 * Both are `internal-write` and ungated: drafting saves nothing public. Scheduling and publishing stay
 * behind the approval card (`schedule_post`, `publish_post_now`).
 */

const written = (o: ChannelOutcome): o is Extract<ChannelOutcome, { ok: true }> => o.ok;
const refusedView = (outcomes: readonly ChannelOutcome[]) =>
  outcomes
    .filter((o): o is Extract<ChannelOutcome, { ok: false }> => !o.ok)
    .map((o) => ({ platformId: o.platformId, attempts: o.attempts, issues: o.issues.map(issueView) }));

/**
 * The prompt for a revision: the channel's current text and the change asked for.
 *
 * `ContentGenerator.generate` writes from a brief and has no "edit this" mode, so a revision is a
 * generation whose brief carries the current text — the rule compose's `revisionPrompt` used.
 */
export const revisionBrief = (instruction: string, current: string): string =>
  current.trim() === ""
    ? instruction.trim()
    : `Rewrite this social media post.\n\nCurrent post:\n"""\n${current.trim()}\n"""\n\nChange requested: ${instruction.trim()}\n\nKeep what the request does not mention.`;

/**
 * The shared caption and per-channel captions for a set of channel texts: the first channel's text is
 * shared, the rest are overrides where they differ. The store normalises again (#495).
 */
export const splitCaptions = (
  platforms: readonly PlatformId[],
  textFor: (platform: PlatformId) => string,
): { caption: string; platformCaptions: Partial<Record<PlatformId, string>> } => {
  const caption = textFor(platforms[0]!);
  const platformCaptions: Partial<Record<PlatformId, string>> = {};
  for (const p of platforms.slice(1)) {
    const text = textFor(p);
    if (text.trim() !== "" && text !== caption) platformCaptions[p] = text;
  }
  return { caption, platformCaptions };
};

const draftSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    platformIds: platformList,
    angle: z
      .object({ label: z.string().trim().min(1).max(200), rationale: z.string().trim().min(1).max(2_000) })
      .strict()
      .optional(),
    mediaAssetIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

export const draftPostForChannelsTool = shareFlowTool(["brand", "content", "generator", "credits", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "draft_post_for_channels",
    label: "Write a post for each channel",
    description:
      "Write one post for several channels at once — a version tailored to each channel, checked against the brand's rules and each channel's limits — and save it as ONE draft with a caption per channel. Use this whenever the user asks for a post (\"write a post about…\", \"announce…\", /post). Returns the draft id, which channels were written, and which could not be and why. Only written channels are saved on the draft. Publishing is a separate, confirmed step. Use it for a post you wrote yourself, for one channel or several. A line \"Channels selected in the composer (for any post you write): …\" is context, not a request: use those channels when you write a post, and answer a question once, not once per channel. Call one save tool per post, never two at once.",
    category: "posts",
    effect: "internal-write",
    inputSchema: draftSchema,
    delegatesTo: "ContentService.createDraft",
    delegate: async (input: z.infer<typeof draftSchema>, context, { idempotencyKey }) => {
      // #499: the channels are the price, so the check is for all of them before anything is written.
      await services.credits.reserve(context, { credits: input.platformIds.length, tool: "draft_post_for_channels" });
      // #522: the project's instructions reach the caption writer, which sees only its brief.
      const project = await services.projects.current(context);
      const outcomes = await writeForChannels(
        { brand: services.brand, content: services.content, generator: services.generator },
        context,
        {
          brief: withProjectBrief(input.brief, project),
          platformIds: input.platformIds,
          ...(input.angle === undefined ? {} : { angle: input.angle }),
          ...(input.mediaAssetIds === undefined ? {} : { mediaAssetIds: input.mediaAssetIds }),
          repairBound: DEFAULT_REPAIR_BOUND,
        },
        {
          parallel: true,
          // #497 AC-1: each channel reaches the post panel as it finishes, not all at the end.
          onChannel: (outcome) =>
            services.content.noteChannelWritten?.(context, {
              callKey: String(idempotencyKey),
              platformId: outcome.platformId,
              caption: outcome.ok ? outcome.caption : null,
            }),
        },
      );
      const ok = outcomes.filter(written);
      if (ok.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "no channel could be written that passes the brand's rules and the channels' limits",
          retryable: false,
          details: { failures: refusedView(outcomes) },
        });
      }
      /*
       * Only the written channels become targets. A channel that failed must not be saved on the draft:
       * it would publish the shared caption, which is the text that was *not* checked for it — an X
       * target with LinkedIn's 600-character caption.
       */
      const platforms = ok.map((o) => o.platformId);
      const byPlatform = new Map(ok.map((o) => [o.platformId, o.caption]));
      const { caption, platformCaptions } = splitCaptions(platforms, (p) => byPlatform.get(p) ?? "");
      const created = await services.content.createDraft(context, {
        idempotencyKey,
        caption,
        targetPlatforms: platforms,
        platformCaptions,
        ...(input.mediaAssetIds === undefined ? {} : { mediaAssetIds: input.mediaAssetIds as never }),
      });
      const creditsUsed = await chargeWritten(services.credits, context, ok.length, "draft_post_for_channels");
      return {
        postDraftId: created.id,
        creditsUsed,
        written: ok.map((o) => ({ platformId: o.platformId, caption: o.caption, attempts: o.attempts })),
        failed: refusedView(outcomes),
        captionStoredInFull: created.captionLength === caption.length,
        droppedMedia: created.droppedMedia,
      };
    },
  }));

const reviseSchema = z
  .object({
    postDraftId: idString,
    instruction: z.string().trim().min(1).max(2_000),
    /** Omitted = every channel on the draft. */
    platformIds: platformList.optional(),
  })
  .strict();

export const revisePostChannelsTool = shareFlowTool(["brand", "content", "generator", "credits", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "revise_post_channels",
    label: "Revise a post by channel",
    description:
      "Change a saved post's text on the channels named — \"make LinkedIn more professional\" revises only LinkedIn; \"shorter\" with no channel revises all of them. Starts from each channel's saved text (including the user's own edits), rewrites under the same checks as writing, and saves the draft. Channels that could not be revised keep their current text and are reported. Use it (or update_post_draft for exact new text) to change a saved post — never save a new draft for an edit.",
    category: "posts",
    effect: "internal-write",
    inputSchema: reviseSchema,
    delegatesTo: "ContentService.updateDraft",
    delegate: async (input: z.infer<typeof reviseSchema>, context, { idempotencyKey }) => {
      const id = asId<PostDraftId>(input.postDraftId);
      const draft = await services.content.getDraft(context, { id });
      const onDraft = draft.targetPlatforms as readonly PlatformId[];
      const targets = (input.platformIds ?? onDraft).filter((p) => onDraft.includes(p));
      if (targets.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: `none of those channels are on this post; it is for ${onDraft.join(", ")}`,
          retryable: false,
        });
      }
      const current = (p: PlatformId) => draft.platformCaptions[p] ?? draft.caption;
      await services.credits.reserve(context, { credits: targets.length, tool: "revise_post_channels" });
      const project = await services.projects.current(context);

      /*
       * One generation per channel, each from that channel's own current text — a single brief for all
       * of them would rewrite LinkedIn's version from Instagram's.
       */
      const outcomes = await Promise.all(
        targets.map(async (platformId) => {
          const [outcome] = await writeForChannels(
            { brand: services.brand, content: services.content, generator: services.generator },
            context,
            {
            brief: withProjectBrief(revisionBrief(input.instruction, current(platformId)), project),
            platformIds: [platformId],
            repairBound: DEFAULT_REPAIR_BOUND,
            },
          );
          return outcome!;
        }),
      );
      const revised = new Map(outcomes.filter(written).map((o) => [o.platformId, o.caption]));
      if (revised.size === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "no channel could be revised within the brand's rules and the channels' limits",
          retryable: false,
          details: { failures: refusedView(outcomes) },
        });
      }
      const { caption, platformCaptions } = splitCaptions(onDraft, (p) => revised.get(p) ?? current(p));
      const updated = await services.content.updateDraft(context, {
        idempotencyKey,
        id,
        patch: { caption, platformCaptions },
      });
      const creditsUsed = await chargeWritten(services.credits, context, revised.size, "revise_post_channels");
      return {
        postDraftId: updated.id,
        creditsUsed,
        revised: [...revised.entries()].map(([platformId, text]) => ({ platformId, caption: text })),
        failed: refusedView(outcomes),
      };
    },
  }));

export const COMPOSE_TOOL_NAMES = ["draft_post_for_channels", "revise_post_channels"] as const;

export const COMPOSE_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [draftPostForChannelsTool, revisePostChannelsTool];
