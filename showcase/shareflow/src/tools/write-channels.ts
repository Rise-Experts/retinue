import { asId, type ExecutionContext } from "@retinue/agentkit";
import { findForbiddenClaims } from "../context/claims.js";
import type { GeneratedVariant, PlatformId, ShareFlowServices, ValidationIssue } from "../services/index.js";
import { DEFAULT_SIMILARITY_THRESHOLD, findDuplicateContent } from "./duplication.js";

/*
 * Its own module so the layout test's service scanner (which reads `services.X` inside each tool
 * factory) attributes these reads to the tools that pass the services in, not to whichever factory
 * sits above this function in a file.
 */

/** How many recent posts a candidate is compared against for duplication. */
const RECENT_POSTS_TO_COMPARE = 25;

/** One channel's outcome. Reported per channel, never collapsed. */
export type VariantOutcome =
  | { readonly platformId: PlatformId; readonly ok: true; readonly caption: string; readonly attempts: number }
  | {
      readonly platformId: PlatformId;
      readonly ok: false;
      readonly attempts: number;
      readonly issues: readonly ValidationIssue[];
    };

/**
 * Write one checked version per channel — the core of `generate_content`, shared (#496).
 *
 * Extracted verbatim so `draft_post_for_channels` and `revise_post_channels` write under exactly the
 * same rules: brand claims, duplicates against recent posts, each channel's own limits, and the bounded
 * repair loop. `parallel` runs the channels at once (compose's first turn does); `generate_content`
 * keeps its sequential order.
 */
export type ChannelOutcome = VariantOutcome;

export const writeForChannels = async (
  services: Pick<ShareFlowServices, "brand" | "content" | "generator">,
  context: ExecutionContext,
  input: {
    readonly brief: string;
    readonly platformIds: readonly PlatformId[];
    readonly angle?: { readonly label: string; readonly rationale: string };
    readonly mediaAssetIds?: readonly string[];
    readonly repairBound: number;
  },
  options: {
    readonly parallel?: boolean;
    /** #497 AC-1: told as each channel finishes, so the panel can fill that card first. Never awaited into a failure. */
    readonly onChannel?: (outcome: VariantOutcome) => Promise<void> | void;
  } = {},
): Promise<VariantOutcome[]> => {
  const policy = await services.brand.getClaimPolicy(context);

  // Fetched once, before the loop, and through the port that already exists rather than a second
  // query. Summaries carry an excerpt rather than the caption, so the comparison is against what the
  // list gives — which is the honest limit of this check and is documented on `findDuplicateContent`.
  const recentPage = await services.content.listDrafts(context, { limit: RECENT_POSTS_TO_COMPARE });
  const recent = recentPage.items.map((item) => ({ postDraftId: item.id, caption: item.excerpt }));

  /**
   * Everything wrong with one candidate.
   *
   * Three sources, and all three run every time: claims, duplication, and the service's own
   * validation. Short-circuiting after the first would mean a repair attempt that fixes the length
   * and then discovers the forbidden claim on the next pass, spending a whole attempt to learn
   * something already knowable.
   */
  const check = async (variant: GeneratedVariant): Promise<readonly ValidationIssue[]> => {
    const report = await services.content.validateContent(context, {
      caption: variant.caption,
      platformIds: [variant.platformId],
      ...(input.mediaAssetIds === undefined
        ? {}
        : { mediaAssetIds: input.mediaAssetIds.map((id) => asId<never>(id)) }),
    });
    return [
      ...findForbiddenClaims(variant.caption, policy.forbidden),
      ...findDuplicateContent(variant.caption, recent, DEFAULT_SIMILARITY_THRESHOLD),
      ...report.issues,
    ];
  };

  /**
   * Generate, check, and repair up to the bound.
   *
   * The counter is local to this call and nothing resets it, so the bound holds by construction rather
   * than by every caller remembering. An unrepairable finding stops immediately: regenerating on a
   * finding the model cannot fix spends attempts to arrive at the same answer.
   */
  const attempt = async (platformId: PlatformId): Promise<VariantOutcome> => {
    let avoid: readonly ValidationIssue[] = [];
    for (let attempts = 1; attempts <= input.repairBound + 1; attempts += 1) {
      const produced = await services.generator.generate(context, {
        brief: input.brief,
        platformIds: [platformId],
        avoid,
        ...(input.angle === undefined ? {} : { angle: input.angle }),
      });
      const variant = produced.find((v) => v.platformId === platformId) ?? produced[0];
      if (variant === undefined) {
        return {
          platformId,
          ok: false,
          attempts,
          issues: [
            { code: "generation-empty", message: "the generator returned nothing", repairable: false },
          ],
        };
      }
      const issues = await check(variant);
      if (issues.length === 0) return { platformId, ok: true, caption: variant.caption, attempts };
      if (issues.some((i) => !i.repairable)) return { platformId, ok: false, attempts, issues };
      avoid = issues;
    }
    return {
      platformId,
      ok: false,
      attempts: input.repairBound + 1,
      issues: avoid.length > 0 ? avoid : [
        { code: "repair-exhausted", message: "could not be written within the repair bound", repairable: false },
      ],
    };
  };

  // Per channel, independently. One channel failing must not lose the others — and generating a blob
  // and splitting it afterwards is what AC-1's "by construction" rules out.
  const reported = async (platformId: PlatformId): Promise<VariantOutcome> => {
    const outcome = await attempt(platformId);
    if (options.onChannel !== undefined) {
      try {
        await options.onChannel(outcome);
      } catch {
        // A preview that cannot be recorded changes nothing about the post being written.
      }
    }
    return outcome;
  };
  if (options.parallel === true) return Promise.all(input.platformIds.map((platformId) => reported(platformId)));
  const outcomes: VariantOutcome[] = [];
  for (const platformId of input.platformIds) outcomes.push(await reported(platformId));
  return outcomes;
};

