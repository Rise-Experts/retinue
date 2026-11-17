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
import { AgentPlatformError, asId, type ExecutionContext, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import { writeForChannels, type VariantOutcome } from "./write-channels.js";
import { chargeWritten, withCredit } from "./credits.js";
import { withProjectBrief } from "./project-brief.js";
// The planner's own ceiling, not a number chosen here: a post needs an angle, so a campaign cannot be
// longer than the angles the generator will offer.
import {
  MAX_ALTERNATIVES,
  MAX_ANGLES,
  MAX_HASHTAGS,
  MAX_CAMPAIGN_POSTS,
  MAX_REPURPOSE_PIECES,
  MAX_REPURPOSE_SOURCE_CHARS,
} from "../adapters/model/generator.js";
import {
  type CalendarDate,
  type CampaignId,
  type ContentAngle,
  type FunnelStage,
  type FunnelStep,
  type GeneratedVariant,
  type PlatformId,
  type ShareFlowServices,
  type ValidationIssue,
} from "../services/index.js";
// The fact renderer and the window schema, from the module that owns them — see `factView`'s note.
import { factView, windowSchema } from "./analytics.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, shareFlowTool } from "./factory.js";

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


export const platformList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(10)
  .transform((values) => [...new Set(values.map((v) => v.toLowerCase()))] as PlatformId[]);

export const issueView = (issue: ValidationIssue) => ({
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
export const proposePostAnglesTool = shareFlowTool(["generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "propose_post_angles",
    label: "Propose angles",
    description:
      "Propose distinct ways of approaching a brief, each with why it might land. Use this when the direction is not settled — then generate content for the one the user picks. Writes nothing.",
    category: "posts",
    effect: "read",
    inputSchema: proposeAnglesSchema,
    delegatesTo: "ContentGenerator.proposeAngles",
    delegate: withCredit(() => services.credits, "propose_post_angles", async (input: z.infer<typeof proposeAnglesSchema>, context) => ({
      angles: (await services.generator.proposeAngles(context, input)).map((a: ContentAngle) => ({
        label: a.label,
        rationale: a.rationale,
      })),
    })),
  }));

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


export const generateContentTool = shareFlowTool(["brand", "content", "generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_content",
    label: "Write content",
    description:
      "Write a post for each destination, checked against the brand's forbidden claims, the destination's own limits and recent posts before it comes back. Returns one version per destination and saves nothing — save what the user wants as ONE post with create_post_draft — one version as `caption`, the others as `platformCaptions` — never one draft per destination. A destination that could not be written is reported with the reason rather than returned with a version that would be rejected.",
    category: "posts",
    // `read`: this writes nothing. Cost is real and is the usage system's business — the approval gate is
    // for side effects, and requiring approval to draft would make the assistant unusable.
    effect: "read",
    inputSchema: generateSchema,
    delegatesTo: "ContentGenerator.generate",
    delegate: withCredit(() => services.credits, "generate_content", async (input: GenerateInput, context) => {
      const outcomes = await writeForChannels(
        { brand: services.brand, content: services.content, generator: services.generator },
        context,
        input,
      );

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
    }),
  }));

/** The generation capabilities. Both `read`: neither saves anything. */
/**
 * A campaign's worth of posts — REQ-041, replacing `route:POST /campaign`.
 *
 * The old runtime's sequence, transcribed: *"one planner call → N distinct briefs → each expanded
 * through the researcher→writer→tailor graph with an avoid-list of sibling hooks (anti-duplication)"*.
 * So `proposeAngles` once, then `generate` per angle with the other angles named as hooks not to reuse.
 *
 * **All or nothing, and that is the old runtime's decision rather than a shortcut.** Its comment is
 * explicit: *"a single brief's expansion failure fails the whole campaign (partial campaigns are more
 * confusing than a clean retry) — the caller surfaces the reason."* Note this is the *opposite* of
 * `generate_content`, which reports a destination it could not write and returns the rest — and both
 * are right: a post can partly succeed across platforms, and a five-post campaign that produced three
 * is not a campaign.
 *
 * Saves nothing, like every generator tool here. The caller keeps the ones it wants with
 * `create_post_draft`, one per post, and `create_campaign` is what makes the container.
 */
/**
 * The four stages `posts.funnel_stage` accepts — REQ-018 AC-2.
 *
 * Transcribed from the column's CHECK constraint rather than from the requirement, which names three.
 * A tool that refused `retention` would refuse a value the store already takes.
 */
const FUNNEL_STAGES = ["awareness", "consideration", "conversion", "retention"] as const;

/** One slot of `campaign_templates.post_plan`, as a caller hands it over. */
const funnelStepSchema = z
  .object({
    stage: z.enum(FUNNEL_STAGES),
    /** The playbook's wording for this slot. Guidance for the planner, never the final angle. */
    angle: z.string().trim().min(1).max(200).optional(),
    cta: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * The campaign's strategy — REQ-018 AC-1 and AC-3.
 *
 * Three inputs, and they do different jobs. `audience` and `primaryGoal` frame *every* post and so
 * travel in the planning brief; `funnelPlan` shapes the *sequence* and so travels per slot. Keeping
 * them in one object rather than three loose fields is what lets the tool say "no strategy was
 * supplied" in one check, which is the branch that has to keep working unchanged.
 */
const campaignStrategySchema = z
  .object({
    /** Who the campaign is for, in the user's own words. `campaigns.persona` rendered to prose. */
    audience: z.string().trim().min(1).max(600).optional(),
    /** The measurable outcome the campaign is for — `campaigns.primary_goal`. */
    primaryGoal: z.string().trim().min(1).max(200).optional(),
    /**
     * The playbook's sequence, in order.
     *
     * Its length is the *shape*, not the post count: a template plans six steps and a campaign's dates
     * and cadence decide how many posts there actually are. `expandFunnelPlan` reconciles the two.
     */
    funnelPlan: z.array(funnelStepSchema).min(1).max(MAX_CAMPAIGN_POSTS).optional(),
  })
  .strict();

/**
 * A funnel plan of any length, stretched or compressed to the number of posts the campaign has —
 * REQ-018 AC-3.
 *
 * This reconciliation is unavoidable and worth stating plainly, because the two numbers come from
 * unrelated places: `campaign_templates.post_plan` has six steps because that is how a product launch
 * goes, and `postCountFor(startsOn, endsOn, cadence)` has twelve because the user picked three weeks
 * of daily posting. Neither is wrong and they will rarely match.
 *
 * **The plan is treated as a shape, sampled evenly, with both ends pinned.** Slot `i` of `n` takes
 * plan step `round(i * (len - 1) / (n - 1))`. Two properties follow, and both are the point:
 *
 * - The **first** post is always the plan's first step and the **last** is always its last. A launch
 *   plan that ends in "Launch offer + urgency" produces a campaign that ends by asking for the sale,
 *   at every length. The obvious alternative — `floor(i * len / n)` — quietly drops the final step
 *   whenever `n < len`, so a three-post campaign from a plan whose only conversion post is last never
 *   asks for anything. That is the bug this formula exists to avoid.
 * - Steps in the middle repeat when there are more posts than steps and are skipped when there are
 *   fewer, in order. Repetition is fine — three consideration posts on different angles is a normal
 *   campaign — because the angle is what differs, and the angles are proposed to be distinct.
 *
 * The ends are sampled slightly less often than the middle when `n > len`, which is a known property
 * of pinning both endpoints rather than an oversight: `round` gives the first and last steps half the
 * catchment of the interior ones.
 *
 * `n <= 0` returns nothing and an empty plan returns nothing; both are a caller error the tool's
 * schema already refuses, and returning `[]` keeps this function total rather than making every
 * caller handle a throw.
 */
export const expandFunnelPlan = (plan: readonly FunnelStep[], n: number): readonly FunnelStep[] => {
  if (plan.length === 0 || n <= 0) return [];
  if (n === 1) {
    /*
     * The **last** step, not the first.
     *
     * A single-post campaign built from a launch playbook should be the one that asks for the sale,
     * not the teaser for a reveal that never comes. `postCount` is at least 2 in the schema, so this
     * is unreachable from the tool — it is here because the function is exported and a caller that
     * asks for one post deserves the defensible answer rather than an off-by-one.
     */
    return [plan[plan.length - 1] as FunnelStep];
  }
  return Array.from({ length: n }, (_unused, index) => {
    const at = Math.round((index * (plan.length - 1)) / (n - 1));
    return plan[at] as FunnelStep;
  });
};

const generateCampaignSchema = z
  .object({
    theme: z.string().trim().min(1).max(400),
    /**
     * Up to ShareFlow's own ceiling of 31, asked for in batches of `MAX_ANGLES`.
     *
     * This was capped at 6 — the planner's limit for one call — which made the tool unable to serve a
     * campaign the product can create: `postCountFor` produces up to 31, so "daily for a month" was
     * refused outright. Batching is what closes that without pretending a model can name 31 genuinely
     * distinct angles in one breath.
     */
    postCount: z.number().int().min(2).max(MAX_CAMPAIGN_POSTS),
    platformIds: platformList,
    /** The user's own description of what they want, when they have one. Sharpens the angles. */
    brief: z.string().trim().min(1).max(4_000).optional(),
    goal: z.string().trim().min(1).max(400).optional(),
    /**
     * Search the web first and plan from what it finds — the substance of `route:POST /campaign/agent`.
     *
     * Off by default. A campaign about an evergreen theme does not need the round trip, and the old
     * runtime kept the two as separate endpoints precisely because the grounded one costs more.
     */
    researchFirst: z.boolean().optional(),
    /** REQ-018's strategy layer. Absent means a campaign planned from its theme and brief alone. */
    strategy: campaignStrategySchema.optional(),
  })
  .strict();

export const generateCampaignTool = shareFlowTool(["generator", "research", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_campaign",
    label: "Write a campaign's posts",
    description:
      "Plan a campaign of several posts on one theme and write each of them, so no two reuse the same hook. Returns one set of per-destination versions per post and saves nothing — keep the ones the user wants with create_post_draft, and create_campaign makes the container they belong to. Either every post is written or none is: a campaign missing half its posts is more confusing than a clean retry. Set researchFirst to plan from a live search of the theme; when you do, check `trendGrounded` before telling the user the plan reflects current trends. If you want to research it yourself, search first and pass what you learned as the brief instead. Pass `strategy` to plan the campaign rather than just fill it: `audience` and `primaryGoal` frame every post, and `funnelPlan` shapes the sequence — each post is written for its own stage, and comes back with the `funnelStage` to store on it. The plan is a shape, not a length: it is sampled evenly across however many posts were asked for, always starting at its first step and ending at its last.",
    category: "campaigns",
    effect: "read",
    inputSchema: generateCampaignSchema,
    delegatesTo: "ContentGenerator.generate",
    delegate: withCredit(() => services.credits, "generate_campaign", async (input: z.infer<typeof generateCampaignSchema>, context) => {
      /**
       * The brief the planner sees. The theme is the spine; the user's own words and the goal sharpen
       * it, and are omitted rather than rendered as "Goal: unknown" — a model told a field is unknown
       * will sometimes write about not knowing it.
       */
      const planningBrief = [
        input.theme,
        /*
         * The strategy's campaign-wide half — REQ-018 AC-1.
         *
         * In the brief rather than on the generator port, and that is the same call `goal` already
         * makes one line up. Both are framing that applies to every post in the campaign, and the
         * port's job is the *per-post* shape: an audience passed as a parameter would have to be
         * threaded through `proposeAngles`, `generate` and every future caller to say what one string
         * in the brief already says.
         *
         * `primaryGoal` is rendered as the campaign's own goal even when `goal` is also present. They
         * are different things — `campaigns.goal` is free text and `primary_goal` is the funnel
         * outcome a template picked — and a model shown both writes to both, which is correct.
         */
        input.strategy?.audience === undefined ? "" : `Audience: ${input.strategy.audience}`,
        input.strategy?.primaryGoal === undefined ? "" : `Campaign goal: ${input.strategy.primaryGoal}`,
        input.goal === undefined ? "" : `Goal: ${input.goal}`,
        input.brief === undefined ? "" : input.brief,
      ]
        .filter((part) => part !== "")
        .join("\n\n");

      /**
       * The plan, reconciled to the post count before anything is written — REQ-018 AC-3.
       *
       * Done once, up front, because two different loops below index into it: the angle batches ask
       * for slots `[k, k+wanted)` and the writing loop reads slot `i` per post. Expanding it lazily in
       * either place would put the reconciliation in two spots and let them disagree.
       */
      const steps =
        input.strategy?.funnelPlan === undefined
          ? undefined
          : expandFunnelPlan(input.strategy.funnelPlan, input.postCount);

      /**
       * The optional research pass, replacing what `route:POST /campaign/agent` did with an agent.
       *
       * **Deterministic, and one search.** The old route ran an autonomous Agno agent with `web_search`
       * and `capture_website` under a 15-call limit. That is not reproduced as a tool, on purpose: this
       * runtime *is* an agent, so a sub-agent inside a tool would run a second tool budget the caller
       * cannot see, keep its searches out of the transcript the user is watching, and sit outside the
       * approval gate. The autonomy belongs to the conversation — an assistant asked to research a
       * campaign calls `search_web` itself, visibly — and what a form-shaped caller needs is grounding,
       * which is this.
       *
       * The query is the theme alone. The old per-post researcher's own comment gives the reason:
       * *"Compact query for the researcher's trend search — theme + this post's angle, not the long
       * structured expansion prompt."* A four-thousand-character brief makes a useless search query.
       */
      const outcome =
        input.researchFirst === true
          ? await services.research.search(context, { query: input.theme, maxResults: 5 })
          : undefined;
      const trends =
        outcome !== undefined && outcome.searched
          ? outcome.results.map((result) => ({ title: result.title, snippet: result.snippet }))
          : [];

      /**
       * The angles, in batches of `MAX_ANGLES`.
       *
       * One call per batch, each told the labels the earlier batches already used, so a 31-post campaign
       * gets 31 angles that differ from one another rather than six repeated five times. The old runtime
       * asked its planner for all N in one call; batching is stricter about what "distinct" means, since
       * a model naming 31 angles in one breath starts rewording at about the sixth.
       *
       * Sequential, because each batch's prompt has to carry what the previous ones produced.
       */
      const angles: { readonly label: string; readonly rationale: string }[] = [];
      while (angles.length < input.postCount) {
        const wanted = Math.min(MAX_ANGLES, input.postCount - angles.length);
        const batch = await services.generator.proposeAngles(context, {
          /**
           * The brief, plus what is already taken.
           *
           * `proposeAngles` has no `avoid` parameter — `avoidHooks` belongs to `generate` — so the
           * exclusion travels in the brief. Named as *angles already covered* rather than as a
           * rejection, the same distinction `avoidHooks` draws: nothing here was refused.
           */
          brief:
            angles.length === 0
              ? planningBrief
              : `${planningBrief}\n\nAngles already covered by earlier posts in this campaign — propose ` +
                `different ones:\n${angles.map((angle) => `- ${angle.label}`).join("\n")}`,
          count: wanted,
          ...(trends.length === 0 ? {} : { trends }),
          /*
           * This batch's slots, not the whole plan.
           *
           * The loop asks for `MAX_ANGLES` at a time, so batch two is proposing angles for posts 7-12
           * and must be shown *those* funnel slots — handed the full plan it would propose a second
           * awareness opener for a campaign already past it.
           */
          ...(steps === undefined ? {} : { steps: steps.slice(angles.length, angles.length + wanted) }),
        });

        /**
         * A batch that returns nothing new ends the attempt.
         *
         * Without this the loop asks forever for a theme that has run out of angles. Deduplicated on the
         * label, because a planner told to avoid an angle will sometimes return it anyway — and two posts
         * on one angle is the duplication the whole avoid-list exists to prevent.
         */
        const taken = new Set(angles.map((angle) => angle.label.trim().toLowerCase()));
        const fresh = batch.filter((angle) => !taken.has(angle.label.trim().toLowerCase()));
        if (fresh.length === 0) break;
        angles.push(...fresh.map((angle) => ({ label: angle.label, rationale: angle.rationale })));
      }

      if (angles.length < input.postCount) {
        /**
         * Fewer angles than posts asked for is a refusal, not a smaller campaign.
         *
         * Writing four posts for a five-post request would be the partial campaign the old runtime
         * decided against, arrived at one step earlier — and silently, since nothing downstream would
         * know a post was missing.
         */
        throw new AgentPlatformError({
          code: "provider_unavailable",
          message:
            `Only ${angles.length} distinct angle(s) could be found for ${input.postCount} posts on this ` +
            `theme. Narrow the theme, or ask for fewer posts.`,
          retryable: true,
        });
      }

      /**
       * Sequential, not parallel, and the reason is the anti-duplication.
       *
       * Each post is told the hooks its siblings used. Running them concurrently would mean every post
       * sees the same planned angles and none sees what the others actually wrote, which is the weaker
       * guarantee — the planner's labels are an intention and the caption is the thing that can repeat.
       */
      const posts: {
        readonly angle: string;
        readonly rationale: string;
        readonly funnelStage?: FunnelStage;
        readonly versions: readonly GeneratedVariant[];
      }[] = [];
      const usedHooks: string[] = [];

      for (const [position, angle] of angles.slice(0, input.postCount).entries()) {
        const siblings = angles
          .slice(0, input.postCount)
          .filter((other) => other.label !== angle.label)
          .map((other) => other.label);

        const versions = await services.generator.generate(context, {
          brief: planningBrief,
          angle,
          platformIds: input.platformIds,
          avoid: [],
          // The planned labels *and* what previous posts actually opened with.
          avoidHooks: [...siblings, ...usedHooks],
          // This post's funnel slot, so the caption ends the way its position in the sequence needs.
          ...(steps?.[position] === undefined ? {} : { step: steps[position] }),
        });

        if (versions.length === 0) {
          throw new AgentPlatformError({
            code: "provider_unavailable",
            message:
              `The post for "${angle.label}" could not be written, so the campaign was not written ` +
              `either — a campaign missing a post is more confusing than a clean retry.`,
            retryable: true,
          });
        }

        posts.push({
          angle: angle.label,
          rationale: angle.rationale,
          /*
           * Returned, because the caller is what writes `posts.funnel_stage`.
           *
           * Omitted rather than null when there was no plan. A `funnelStage: null` on every post of an
           * unplanned campaign is the shape that made this whole layer look finished while doing
           * nothing — a field that is always present and always empty reads as a feature that ran.
           */
          ...(steps?.[position] === undefined ? {} : { funnelStage: steps[position].stage }),
          versions,
        });
        // The first line of the first version, which is what a reader sees first and what can repeat.
        const opening = (versions[0]?.caption ?? "").split("\n")[0] ?? "";
        if (opening !== "") usedHooks.push(opening);
      }

      return {
        theme: input.theme,
        postCount: posts.length,
        posts,
        /**
         * Whether the plan is actually grounded, reported only when grounding was asked for.
         *
         * Absent when `researchFirst` was not set, because `false` there would read as a failed search
         * rather than as a search nobody requested. When it *was* asked for, a search that could not run
         * says so — the plan is still worth having and it is not grounded, and those are different
         * claims to make to a user.
         */
        ...(outcome === undefined
          ? {}
          : {
              trendGrounded: outcome.searched && trends.length > 0,
              ...(outcome.searched ? {} : { trendReason: outcome.reason }),
            }),
      };
    }),
  }));


/**
 * Advisory campaign ideas — REQ-041, replacing `route:POST /campaign/suggest`.
 *
 * *"The human writes the posts; this suggests distinct angles/hooks with a recommended format and
 * best-fit channels, grounded in a live trends search."* Nothing here is a caption and nothing is
 * saved — `generate_campaign` is the tool that writes, and this is the one that proposes.
 *
 * **Whether it was actually trend-grounded is reported, not implied.** The old runtime's trends block
 * was simply absent when its search returned nothing, so an ungrounded suggestion looked exactly like a
 * grounded one. `ResearchService.search` reports *whether it searched* — that is the whole point of the
 * port — so `trendGrounded` carries it through to the caller, along with the reason when it is false.
 */
const suggestIdeasSchema = z
  .object({
    theme: z.string().trim().min(1).max(400),
    count: z.number().int().min(1).max(MAX_ANGLES),
    goal: z.string().trim().min(1).max(400).optional(),
    /**
     * The workspace's own channels. Ideas are filtered to these — see the adapter's clamp.
     *
     * Optional, and an absent list means "no restriction" rather than "no channels": a caller that has
     * not resolved the workspace's accounts should get ideas, not an empty answer.
     */
    channels: platformList.optional(),
    mediaType: z.enum(["text", "image", "video"]).optional(),
  })
  .strict();

export const suggestCampaignIdeasTool = shareFlowTool(["generator", "research"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "suggest_campaign_ideas",
    label: "Suggest campaign ideas",
    description:
      "Propose several distinct campaign ideas — angle, hook, call to action, a suggested format and the channels each suits — for a person to write themselves. Saves nothing and writes no captions; use generate_campaign to have the posts written. Check `trendGrounded` in the result: when it is false the ideas come from the brand and the theme alone, and saying so is more useful than implying a search happened.",
    category: "campaigns",
    effect: "read",
    inputSchema: suggestIdeasSchema,
    delegatesTo: "ContentGenerator.suggestIdeas",
    delegate: async (input: z.infer<typeof suggestIdeasSchema>, context) => {
      /**
       * The old runtime's query, transcribed: `f"{theme} social media trends"`, five results.
       *
       * A failed search is not a failed tool. The ideas are worse without trends and still worth
       * having, which is why this reads the outcome instead of awaiting a list.
       */
      const outcome = await services.research.search(context, {
        query: `${input.theme} social media trends`,
        maxResults: 5,
      });

      const trends = outcome.searched
        ? outcome.results.map((result) => ({ title: result.title, snippet: result.snippet }))
        : [];

      const ideas = await services.generator.suggestIdeas(context, {
        theme: input.theme,
        count: input.count,
        channels: input.channels === undefined ? [] : [...input.channels],
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        trends,
      });

      return {
        ideas,
        /**
         * The grounding, stated. `false` with a reason is a different answer from `true`, and a caller
         * that cannot tell them apart will present a guess as a finding.
         */
        trendGrounded: outcome.searched && trends.length > 0,
        ...(outcome.searched ? {} : { trendReason: outcome.reason }),
      };
    },
  }));


/**
 * A campaign's results, evaluated — REQ-041, replacing `route:POST /campaign/evaluate`.
 *
 * ## The numbers are read here, never accepted
 *
 * The old route's function signature was `evaluate_campaign(theme, goal, stats: str, ...)` and its prompt
 * said *"use only the numbers provided — never invent metrics"*. Between a model that can call the tool and
 * a `stats` string it composes itself, that instruction is worth nothing: the model provides the numbers it
 * is then told to stick to. The old *web* route knew this and re-read everything server-side — *"RLS-scoped,
 * so the summary always reflects true data, never client-supplied numbers"* — which is the guarantee, and it
 * belongs in the tool now that the caller is the model rather than a form.
 *
 * So the only input is which campaign. Theme and goal come from the campaign row, the numbers from
 * `AnalyticsService.campaignBreakdown`, and the facts are returned alongside the prose so the evaluation is
 * checkable against what it was written from.
 *
 * ## The window defaults to the campaign, not to the refresh window
 *
 * `defaultWindow` is seven days ending today — right for "how is this post doing", wrong here: a campaign
 * that ran in June would come back with nothing measured and the refusal would say "publish it first". The
 * campaign's own `startsOn`/`endsOn` is the range its posts were published in.
 */
const evaluateCampaignSchema = z.object({ campaignId: idString, window: windowSchema.optional() }).strict();

export const evaluateCampaignTool = shareFlowTool(["generator", "analytics", "content"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "evaluate_campaign",
    label: "Evaluate a campaign",
    description:
      "Read a campaign's measured results and write a short what-worked / what-to-change evaluation. The numbers are read from the store, never taken from you. `evaluation` is an interpretation of `grounding` — the facts it was written from are returned with it, so check that it says nothing they do not support. In a conversation prefer get_campaign_metrics and explain the numbers yourself; this exists for callers that have no conversation to explain in.",
    category: "campaigns",
    effect: "read",
    inputSchema: evaluateCampaignSchema,
    delegatesTo: "ContentGenerator.evaluateCampaign",
    delegate: async (input: z.infer<typeof evaluateCampaignSchema>, context) => {
      const campaignId = asId<CampaignId>(input.campaignId);
      const campaign = await services.content.getCampaign(context, { id: campaignId });
      const window =
        input.window === undefined
          ? { fromDay: campaign.startsOn, toDay: campaign.endsOn }
          : (input.window as { fromDay: CalendarDate; toDay: CalendarDate });

      const breakdown = await services.analytics.campaignBreakdown(context, { campaignId, window });

      /**
       * The old route's refusal, transcribed: `publishedItems === 0 && impressions === 0` →
       * *"No results yet — publish the campaign first."*
       *
       * `conflict` rather than `invalid_input`: the request was well formed and the campaign is simply not
       * in a state that can be evaluated. Refusing beats writing an evaluation of nothing, which a model
       * asked for one will otherwise produce from the theme alone.
       */
      const published = breakdown.posts.reduce((total, post) => total + post.publishedDestinations, 0);
      const impressions = breakdown.totals.find((fact) => fact.metric === "impressions");
      const measured = impressions !== undefined && "value" in impressions && impressions.value > 0;
      if (published === 0 && !measured) {
        throw new AgentPlatformError({
          code: "conflict",
          message: "No results yet — publish the campaign first, and give the platforms time to report.",
          retryable: false,
        });
      }

      const evaluation = await services.generator.evaluateCampaign(context, {
        theme: campaign.theme,
        ...(campaign.goal === undefined ? {} : { goal: campaign.goal }),
        totals: breakdown.totals,
        posts: breakdown.posts,
      });

      return {
        evaluation,
        /**
         * What it was written from. Returned rather than dropped, because an interpretation whose inputs
         * are invisible cannot be checked — and this one is model-written prose about numbers.
         */
        grounding: {
          window,
          totals: breakdown.totals.map(factView),
          posts: breakdown.posts.map((post) => ({
            postDraftId: String(post.draftId),
            excerpt: post.excerpt,
            platforms: post.platforms,
            publishedDestinations: post.publishedDestinations,
            facts: post.facts.map(factView),
          })),
          freshness: {
            stale: breakdown.freshness.stale,
            ...(breakdown.freshness.lastRefreshedAt === undefined
              ? {}
              : { lastRefreshedAt: breakdown.freshness.lastRefreshedAt }),
          },
          scoped: breakdown.scoped,
        },
      };
    },
  }));


/**
 * One source into several posts — REQ-015, replacing `route:POST /repurpose`.
 *
 * *"Turns ONE source (long-form text, transcript, or a raw idea) into N distinct, platform-native
 * posts."* Saves nothing, like every generator tool here.
 *
 * ## The caller is the web app's MCP server, not a page
 *
 * `/repurpose` has no Next.js route: its one live caller is the `repurpose` tool in
 * `web/src/lib/mcp/server.ts`, which posts to the AI backend directly. That surface is `retained` — it
 * lives in `web/` and survives the cutover — so it has to be repointed at this tool rather than left
 * pointing at a backend that is going away.
 *
 * ## What is not carried over
 *
 * The old engine **degraded** on a parse failure: one `run_generation` pass, one piece, `angle:
 * "primary takeaway"`. That existed because its model call returned free text that might not be JSON —
 * `StructuredGenerate` has a schema and the platform retries, so the failure mode it was written for is
 * gone. Returning one post where five were asked for is also the worse answer: it looks like a result
 * rather than a failure, and the caller has no way to tell which it got.
 *
 * `hashtags` has no equivalent either. The old engine split them out of each caption with
 * `_split_hashtags`; this generator writes them into the caption because placement is a platform
 * convention — the same decision `generate_content` records, and the reason the web adapter's
 * `hashtags` comes back empty.
 */
const repurposeSchema = z
  .object({
    /**
     * The source text, supplied by the caller.
     *
     * This tool does not fetch. `read_source` is how a URL becomes text, and keeping the fetch out of
     * here means the egress policy lives in exactly one place — the same reason `suggest_campaign_ideas`
     * takes its trends rather than searching from the generator.
     */
    sourceText: z.string().trim().min(1).max(40_000),
    count: z.number().int().min(1).max(MAX_REPURPOSE_PIECES).default(3),
    platformIds: platformList,
  })
  .strict();

export const repurposeSourceTool = shareFlowTool(["generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "repurpose_source",
    label: "Repurpose a source into posts",
    description:
      "Turn one source — an article, a transcript, a raw idea — into several distinct posts, each a different takeaway written for one destination's style. Destinations cycle across the pieces. Saves nothing: keep the ones the user wants with create_post_draft. Give it text, not a link: use read_source first if the user gave you a URL. Check `truncatedSource` before saying the posts cover the whole document.",
    category: "posts",
    effect: "read",
    inputSchema: repurposeSchema,
    delegatesTo: "ContentGenerator.repurpose",
    delegate: withCredit(() => services.credits, "repurpose_source", async (input: z.infer<typeof repurposeSchema>, context) => {
      const pieces = await services.generator.repurpose(context, {
        source: input.sourceText,
        count: input.count,
        platformIds: input.platformIds,
      });

      if (pieces.length === 0) {
        /**
         * Nothing usable is a refusal, not an empty list.
         *
         * A caller handed `pieces: []` renders an empty panel; a refusal names what to do about it.
         * Fewer pieces than asked for is reported below rather than refused — unlike a campaign, these
         * are independent alternatives and four good ones are four good ones.
         */
        throw new AgentPlatformError({
          code: "provider_unavailable",
          message: "No posts could be drawn from that source. A longer or more specific source usually helps.",
          retryable: true,
        });
      }

      return {
        pieces: pieces.map((piece) => ({
          angle: piece.angle,
          platformId: piece.platformId,
          caption: piece.caption,
          // Empty by design — see the header. The caption carries them.
          hashtags: "",
        })),
        requested: input.count,
        /**
         * Whether the model saw the whole source.
         *
         * The old engine truncated at 6,000 characters silently, so a post drawn from the first fifth of
         * a transcript was indistinguishable from one drawn from all of it. Reported for the same reason
         * `read_pdf`'s `truncated` exists: *"do not describe it as complete."*
         */
        truncatedSource: input.sourceText.trim().length > MAX_REPURPOSE_SOURCE_CHARS,
      };
    }),
  }));

/**
 * N alternatives for one destination, scored and ranked — REQ-014.
 *
 * ## Why this is a separate tool and not a parameter on `generate_content`
 *
 * They mean opposite things, and the product already had a bug from the confusion.
 * `generate_content` returns one version per **destination**; this returns N versions for **one**.
 * `/api/ai/generate` accepted `variants: N` for a picker, and the adapter refused it with a message
 * explaining the mismatch — an honest refusal that made a shipped option in the composer fail every
 * time it was ticked.
 *
 * Folding a `variants` count into `generate_content` would return per-destination versions where a
 * picker expects per-destination alternatives, and fill it with captions for platforms the user did
 * not choose. #115 is why: the store holds one caption plus `target_platforms`, so per-destination
 * versions are the thing that gets *saved* and alternatives are the thing that gets *chosen between*.
 *
 * Saves nothing, like every generator tool here. The caller keeps the one the user picked.
 *
 * **Not validated.** `validate_content` is the authority on whether a caption is publishable, and a
 * rubric that also refused things would be a second, softer gate answering a different question. A
 * draft scoring 3/10 is a bad caption, not an invalid one, and the person choosing is entitled to
 * see it — and to see why it scored badly, which is what `critique` carries.
 */
const generateAlternativesSchema = z
  .object({
    brief: z.string().trim().min(1).max(4_000),
    /** **One** destination. Alternatives for several platforms at once is `generate_content`'s job. */
    platformId: z.string().trim().min(1).max(50),
    count: z.number().int().min(2).max(MAX_ALTERNATIVES),
    angle: z
      .object({ label: z.string().trim().min(1).max(200), rationale: z.string().trim().min(1).max(2_000) })
      .strict()
      .optional(),
  })
  .strict();

/*
 * `["generator"]` alone: the brand and the platform bounds reach the prompt through the *adapter's*
 * config, not through this tool. Declaring a service a factory does not read makes the deployment
 * refuse the tool on a service set that could serve it — which is what the layout scan enforces.
 */
export const generateAlternativesTool = shareFlowTool(["generator", "credits", "projects"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "generate_alternatives",
    label: "Write several versions to choose from",
    description:
      "Write several genuinely different captions for ONE destination, score each against a rubric (hook, on-brand, call to action, platform fit), refine the best one and return them ranked. Use this when a person wants to choose between options. Saves nothing: put the one they pick on the draft with update_post_draft, word for word. Each result carries a `critique` saying what held that version back, which is more useful to show than the score alone. The scores are editorial judgement, not a publishability check — saving is where a caption is checked against the channel's rules.",
    category: "posts",
    // `read`: writes nothing. Cost is the usage system's business; the approval gate is for side effects.
    effect: "read",
    inputSchema: generateAlternativesSchema,
    delegatesTo: "ContentGenerator.draftAlternatives",
    delegate: async (input: z.infer<typeof generateAlternativesSchema>, context) => {
      // #499: one credit, what compose's "3 options" cost — checked first, charged once they exist.
      await services.credits.reserve(context, { credits: 1, tool: "generate_alternatives" });
      const project = await services.projects.current(context);
      const drafts = await services.generator.draftAlternatives(context, {
        brief: withProjectBrief(input.brief, project),
        platformId: input.platformId as never,
        count: input.count,
        ...(input.angle === undefined ? {} : { angle: input.angle }),
      });
      const creditsUsed = await chargeWritten(services.credits, context, drafts.length > 0 ? 1 : 0, "generate_alternatives");
      return {
        creditsUsed,
        platformId: input.platformId,
        /*
         * `count` is what was asked for and `drafts.length` is what came back, and they can differ —
         * a candidate the rubric skipped is dropped rather than given an invented score. Reporting
         * both lets a caller say "three of the five were judged" instead of quietly showing three.
         */
        requested: input.count,
        drafts,
      };
    },
  }));

/**
 * Hashtags for a topic, researched and ranked — REQ-016 AC-2, #287.
 *
 * The tailoring half of REQ-016 shipped with #287; this is the clause that was left, and it is a
 * different kind of work: nothing in the runtime researched or ranked hashtags, and "relevance" had
 * to be given a meaning before it could be scored.
 *
 * **The meaning chosen: reach for people who care, not volume.** A tag with ten million posts buries
 * a small brand, so the ranking prefers specific over generic. That is a judgement and it is in the
 * prompt where it can be argued with, rather than implied by a score nobody can see.
 *
 * **`trendGrounded` is reported, not implied** — the same contract `generate_campaign` and
 * `suggest_campaign_ideas` use. REQ-016 AC-5 asks for a graceful fallback when research is
 * unavailable, and graceful means *saying so*: a list of hashtags that came from the model alone
 * looks exactly like one that came from a live search, and the difference is the whole feature.
 *
 * Saves nothing. The caller puts the tags in a caption, or shows them to a person to choose from.
 */
const researchHashtagsSchema = z
  .object({
    topic: z.string().trim().min(1).max(400),
    count: z.number().int().min(1).max(MAX_HASHTAGS).default(8),
    /** Narrows the ranking and states that platform's own hashtag bounds in the prompt. */
    platformId: z.string().trim().min(1).max(50).optional(),
    /**
     * Search first. **On by default**, unlike `generate_campaign`'s `researchFirst`.
     *
     * The default differs because the acceptance does: a campaign is worth planning without a live
     * search, and a hashtag list that was not researched is the thing REQ-016 AC-2 exists to replace.
     * Off is available for a caller that has already searched and passes what it learned as the topic.
     */
    research: z.boolean().default(true),
  })
  .strict();

export const researchHashtagsTool = shareFlowTool(["generator", "research"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "research_hashtags",
    label: "Find hashtags for a topic",
    description:
      "Find hashtags for a topic, ranked by how likely each is to reach people who care about it rather than by how many posts already use it. Each comes back with a one-line rationale. Check `trendGrounded` before telling anyone the tags are current or trending: when it is false the list came from the model alone, and saying so is more useful than implying a search happened. Saves nothing — put the tags in a caption yourself, or offer them for someone to choose from.",
    category: "posts",
    effect: "read",
    inputSchema: researchHashtagsSchema,
    delegatesTo: "ContentGenerator.deriveHashtags",
    delegate: async (input: z.infer<typeof researchHashtagsSchema>, context) => {
      /*
       * The topic alone as the query, for the reason `generate_campaign`'s research pass records: a
       * long structured prompt makes a useless search query.
       */
      const outcome = input.research
        ? await services.research.search(context, { query: input.topic, maxResults: 5 })
        : undefined;
      const findings =
        outcome !== undefined && outcome.searched
          ? outcome.results.map((result) => ({ title: result.title, snippet: result.snippet }))
          : [];

      const hashtags = await services.generator.deriveHashtags(context, {
        topic: input.topic,
        count: input.count,
        findings,
        ...(input.platformId === undefined ? {} : { platformId: input.platformId as never }),
      });

      return {
        topic: input.topic,
        ...(input.platformId === undefined ? {} : { platformId: input.platformId }),
        hashtags,
        /*
         * Absent when no search was asked for — `false` there would read as a failed search rather
         * than one nobody requested, the same distinction `generate_campaign` draws.
         */
        ...(outcome === undefined
          ? {}
          : {
              trendGrounded: outcome.searched && findings.length > 0,
              ...(outcome.searched ? {} : { trendReason: outcome.reason }),
            }),
      };
    },
  }));

/**
 * One source into a set of different kinds of thing — REQ-015 AC-2, #458.
 *
 * A separate tool from `repurpose_source` rather than a mode on it, for the reason
 * `generate_alternatives` is separate from `generate_content` (#266) and `create_thread_draft` from
 * `create_post_draft` (#456): the two return different shapes and a caller that confused them would
 * read `caption` off a script and publish an empty string. Two tools cannot be confused.
 *
 * Each item says where it goes, because the three arms have three destinations and only one of them
 * is not publishable. A script is a **document** — shot notes, timings and voiceover, none of which
 * any platform accepts as a caption — so it belongs in `create_artifact`, and filing it as a post
 * would put an unpublishable row in the publish queue's path.
 *
 * The script shape and every field's reason are in `docs/specs/458-script-shape.md`.
 */
const repurposeToFormatsSchema = z
  .object({
    sourceText: z.string().trim().min(1).max(40_000),
    platformIds: platformList,
    /** How many single posts to draw. Zero asks for none, which is how a set of one kind is requested. */
    posts: z.number().int().min(0).max(MAX_REPURPOSE_PIECES).default(1),
    threads: z.number().int().min(0).max(MAX_REPURPOSE_PIECES).default(1),
    scripts: z.number().int().min(0).max(MAX_REPURPOSE_PIECES).default(1),
  })
  .strict();

export const repurposeToFormatsTool = shareFlowTool(["generator", "credits"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "repurpose_to_formats",
    label: "Repurpose a source into several formats",
    description:
      "Turn one source into a SET of different kinds of thing — single posts, threads, and scripts for a reel or a carousel — drawn from it in one pass so no two make the same point. Use repurpose_source when you want several posts; use this when you want several formats. Saves nothing, and each item goes somewhere different: a post to create_post_draft, a thread to create_thread_draft, a script to create_artifact as markdown. A script is a document to work from, never a post — it has shot notes and timings no platform accepts. Give it text, not a link: use read_source first if the user gave you a URL. Check `truncatedSource` before saying the set covers the whole document, and `shortfall` before saying you produced what was asked for.",
    category: "posts",
    effect: "read",
    inputSchema: repurposeToFormatsSchema,
    delegatesTo: "ContentGenerator.repurposeToFormats",
    delegate: withCredit(() => services.credits, "repurpose_to_formats", async (input: z.infer<typeof repurposeToFormatsSchema>, context) => {
      const items = await services.generator.repurposeToFormats(context, {
        source: input.sourceText,
        platformIds: input.platformIds,
        posts: input.posts,
        threads: input.threads,
        scripts: input.scripts,
      });

      if (items.length === 0) {
        // Nothing usable is a refusal, not an empty list — the same call `repurpose_source` makes.
        throw new AgentPlatformError({
          code: "provider_unavailable",
          message: "Nothing could be drawn from that source. A longer or more specific source usually helps.",
          retryable: true,
        });
      }

      const produced = {
        posts: items.filter((item) => item.format === "post").length,
        threads: items.filter((item) => item.format === "thread").length,
        scripts: items.filter((item) => item.format === "script").length,
      };

      return {
        items,
        requested: { posts: input.posts, threads: input.threads, scripts: input.scripts },
        produced,
        /**
         * What was asked for and not produced, per format.
         *
         * Reported rather than refused: unlike a campaign, these are independent items and two good
         * ones are two good ones. But it has to be *reported*, because the alternative is an assistant
         * saying "here is your thread and your reel" over a set containing neither — the model drops
         * an item by answering a script with no beats, and the tool drops it rather than passing on a
         * title with nothing under it.
         */
        shortfall: {
          posts: Math.max(0, input.posts - produced.posts),
          threads: Math.max(0, input.threads - produced.threads),
          scripts: Math.max(0, input.scripts - produced.scripts),
        },
        // The same reporting `repurpose_source` makes: a set drawn from the first fifth of a
        // transcript is indistinguishable from one drawn from all of it unless it says so.
        truncatedSource: input.sourceText.trim().length > MAX_REPURPOSE_SOURCE_CHARS,
      };
    }),
  }));

export const GENERATE_TOOL_NAMES = [
  "propose_post_angles",
  "generate_content",
  "generate_alternatives",
  "research_hashtags",
  "generate_campaign",
  "suggest_campaign_ideas",
  "evaluate_campaign",
  "repurpose_source",
  "repurpose_to_formats",
] as const;

export const GENERATE_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  proposePostAnglesTool,
  generateContentTool,
  generateAlternativesTool,
  researchHashtagsTool,
  generateCampaignTool,
  suggestCampaignIdeasTool,
  evaluateCampaignTool,
  repurposeSourceTool,
  repurposeToFormatsTool,
];
