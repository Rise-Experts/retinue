/**
 * `generate_content` — docs/07 Workflow 1, and the only capability in this package with nothing to wrap
 * (#123).
 *
 * ## What is actually built here
 *
 * Not the inference. R3 confines the AI SDK to `models/` and R7 keeps I/O out of `tools/`, so the model
 * call is a port (`ContentGenerator`) that the host wires. What #123 builds is the **harness**: the
 * validation pass, the repair loop, the bound on it, and the per-channel structure.
 *
 * That is the honest reading of "built, not delegated" — the judgement is here, the inference is not.
 *
 * ## Per-channel variants are per-channel *drafts*
 *
 * #115 found the store holds one caption plus `target_platforms`, with nowhere to put an authored variant,
 * and left the question to this SPEC. The answer needs no schema change: this returns one variant per
 * channel and **saves nothing**, and the assistant calls `create_post_draft` once per channel.
 *
 * That is better than the schema change rather than merely cheaper. Each channel's post then has its own
 * status, approval, publish target and failure — which is what `socialPostTargets` already models. One
 * draft with N variants would need per-variant state bolted on to say the same things.
 *
 * ## AC-4 asks for something a model cannot promise
 *
 * *"A forbidden claim is never produced."* Nothing can guarantee what a model produces. What is
 * guaranteeable is that one is never **returned**: generate, check, repair, and if it survives the bound,
 * refuse and name the phrase. The prompt-side policy (#121, `base-policy`) reduces how often repair is
 * needed; the checker decides what leaves.
 */
import { z } from "zod";
import { AgentPlatformError, asId, defineDelegatingTool, type Tool } from "@agentkit/backend";
import { findForbiddenClaims } from "../context/claims.js";
import {
  type ContentAngle,
  type GeneratedVariant,
  type PlatformId,
  type ValidationIssue,
} from "../services/index.js";
import { DEFAULT_SIMILARITY_THRESHOLD, findDuplicateContent } from "./duplication.js";
import type { ShareFlowToolContext, ShareFlowToolFactory } from "./index.js";

/**
 * How many times a failed variant is regenerated before giving up.
 *
 * **Two, and the reason is the failure mode rather than a measurement.** A repairable failure is usually a
 * length or a phrase, and a model told exactly what to change fixes it on the first nudge; the second
 * attempt catches a repair that broke something else. Past that the marginal success rate falls while cost
 * and latency rise linearly, and the *shape* of what remains changes — a model that has failed twice with
 * specific feedback is usually being asked for something it cannot produce.
 *
 * The dangerous case argues for a **low** bound, not a high one. On a forbidden claim a model asked to try
 * again tends to produce near-variants of the same claim, and repairing that repeatedly is not persistence
 * — it is a search for a phrasing that slips past the checker.
 */
export const DEFAULT_REPAIR_BOUND = 2;

/** How many recent posts a new variant is compared against. Bounded: each one is a caption in memory. */
const RECENT_POSTS_TO_COMPARE = 25;

const platformList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(10)
  .transform((values) => [...new Set(values.map((v) => v.toLowerCase()))] as PlatformId[]);

const issueView = (issue: ValidationIssue) => ({
  code: issue.code,
  message: issue.message,
  repairable: issue.repairable,
  ...(issue.platformId === undefined ? {} : { platformId: issue.platformId }),
  ...(issue.accountId === undefined ? {} : { accountId: issue.accountId }),
});

const proposeAnglesSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    count: z.number().int().min(2).max(5).default(3),
  })
  .strict();

/**
 * Angles, as proposals.
 *
 * `min(2)` because a single "angle" is not a choice, and docs/07 step 5 is *"select or present an angle"* —
 * which needs something to select between. `max(5)` because past that the assistant is presenting a list
 * rather than a decision.
 */
export const proposePostAnglesTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "propose_post_angles",
    label: "Propose angles",
    description:
      "Propose distinct ways of approaching a brief, each with why it might land. Use this when the direction is not settled — then generate content for the one the user picks. Writes nothing.",
    category: "posts",
    effect: "read",
    inputSchema: proposeAnglesSchema,
    delegatesTo: "ContentGenerator.proposeAngles",
    delegate: async (input: z.infer<typeof proposeAnglesSchema>, context) => ({
      angles: (await services.generator.proposeAngles(context, input)).map((a: ContentAngle) => ({
        label: a.label,
        rationale: a.rationale,
      })),
    }),
  });

const generateSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    platformIds: platformList,
    angle: z
      .object({ label: z.string().trim().min(1).max(200), rationale: z.string().trim().min(1).max(2_000) })
      .strict()
      .optional(),
    mediaAssetIds: z.array(z.string().min(1)).max(20).optional(),
    /**
     * Overridable, capped at 3.
     *
     * Capped rather than unbounded for the reason in `DEFAULT_REPAIR_BOUND`: a caller who wants ten
     * attempts on a forbidden claim wants something that should not be available.
     */
    repairBound: z.number().int().min(0).max(3).default(DEFAULT_REPAIR_BOUND),
  })
  .strict();

type GenerateInput = z.infer<typeof generateSchema>;

/** One channel's outcome. Reported per channel, never collapsed. */
type VariantOutcome =
  | { readonly platformId: PlatformId; readonly ok: true; readonly caption: string; readonly attempts: number }
  | {
      readonly platformId: PlatformId;
      readonly ok: false;
      readonly attempts: number;
      readonly issues: readonly ValidationIssue[];
    };

export const generateContentTool: ShareFlowToolFactory = ({ services, deps }: ShareFlowToolContext): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_content",
    label: "Write content",
    description:
      "Write a post for each destination, checked against the brand's forbidden claims, the destination's own limits and recent posts before it comes back. Returns one version per destination and saves nothing — save the ones the user wants with create_post_draft, one per destination. A destination that could not be written is reported with the reason rather than returned with a version that would be rejected.",
    category: "posts",
    // `read`: this writes nothing. Cost is real and is the usage system's business — the approval gate is
    // for side effects, and requiring approval to draft would make the assistant unusable.
    effect: "read",
    inputSchema: generateSchema,
    delegatesTo: "ContentGenerator.generate",
    delegate: async (input: GenerateInput, context) => {
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
      const outcomes: VariantOutcome[] = [];
      for (const platformId of input.platformIds) outcomes.push(await attempt(platformId));

      const written = outcomes.filter((o): o is Extract<VariantOutcome, { ok: true }> => o.ok);
      if (written.length === 0) {
        // Nothing usable. Refused rather than returned, so the assistant cannot present a failed
        // generation as a draft — and the reasons travel structured so it can say which phrase or limit.
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "no version could be written that passes the brand's rules and the destinations' limits",
          retryable: false,
          details: {
            failures: outcomes
              .filter((o): o is Extract<VariantOutcome, { ok: false }> => !o.ok)
              .map((o) => ({ platformId: o.platformId, attempts: o.attempts, issues: o.issues.map(issueView) })),
          },
        });
      }

      return {
        // Nothing is saved. `create_post_draft`, one per destination — see the note at the top.
        saved: false,
        variants: written.map((o) => ({
          platformId: o.platformId,
          caption: o.caption,
          attempts: o.attempts,
        })),
        // Partial, and named as such: some destinations were written and some were not.
        failed: outcomes
          .filter((o): o is Extract<VariantOutcome, { ok: false }> => !o.ok)
          .map((o) => ({ platformId: o.platformId, attempts: o.attempts, issues: o.issues.map(issueView) })),
      };
    },
  });

/** The generation capabilities. Both `read`: neither saves anything. */
export const GENERATE_TOOL_NAMES = ["propose_post_angles", "generate_content"] as const;

export const GENERATE_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  proposePostAnglesTool,
  generateContentTool,
];
