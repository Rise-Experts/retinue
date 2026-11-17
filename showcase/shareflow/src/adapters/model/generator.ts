/**
 * `ContentGenerator` over the platform's model layer — REQ-041 (#190), the third of the three `create-post` needs.
 *
 * The port calls this *"the one capability with nothing to wrap"* (#123), and that is exactly right: the other
 * nine services front a ShareFlow table, and this one fronts a model. So it takes a `LanguageModel` rather than
 * a `SqlExecutor` and lives under `adapters/model/` rather than `adapters/postgres/`.
 *
 * ## The brand profile is an argument, not a lookup
 *
 * This does **not** call `BrandService`. It receives the profile from the caller, and the reason is worth
 * stating because the other arrangement is tempting: a generator that fetched the brand itself would read it
 * once per variant, and a workflow generating five variants across three platforms would make fifteen
 * identical queries for text that cannot change during a turn.
 *
 * It also keeps the dependency graph honest — the generator has no business knowing there is a database.
 *
 * ## Structured output, not prose parsing
 *
 * Both methods ask for a schema-validated object. The alternative — asking for prose and parsing it — fails on
 * the day a model writes "Here are three angles:" before the list, and that failure looks like the model being
 * bad at the task rather than the adapter being bad at reading.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import { z } from "zod";

import { brandKitLines } from "../../brand/kit.js";
import { finishReply, planReply } from "../../reply/auto-reply.js";

import type { BrandProfile, ContentAngle, ContentGenerator, DraftScores, Fact, FunnelStep, GeneratedVariant, PlatformRule, RepurposedItem, ResearchedHashtag, ScoredDraft, ScriptBeat, ValidationIssue, VoiceExample } from "../../services/index.js";

/**
 * How many angles may be asked for **in one call**. Beyond a handful they stop being distinct, which is
 * the point of them.
 *
 * A longer campaign is not blocked by this — `generate_campaign` asks in batches and tells each batch
 * the hooks the earlier ones used. See `MAX_CAMPAIGN_POSTS`.
 */
export const MAX_ANGLES = 6;

/**
 * How many posts one campaign may hold, from ShareFlow's own ceiling.
 *
 * `postCountFor` caps at 31 — *"so a runaway date range can't fan out an absurd sequence"* — so "daily
 * for the next year" is 31 posts, not 365. The old runtime asked its planner for all 31 distinct angles
 * in a single call; this asks in batches of `MAX_ANGLES`, which is stricter about what "distinct" means
 * and keeps the anti-duplication list growing across the whole campaign rather than within one call.
 */
export const MAX_CAMPAIGN_POSTS = 31;
/** How many platforms one generate call may cover. A bound on the output, not a product limit. */
export const MAX_PLATFORMS = 8;

const angleSchema = z.object({
  angles: z
    .array(
      z.object({
        label: z.string().min(1).max(60).describe("A short label, for choosing between them."),
        rationale: z.string().min(1).max(400).describe("What this angle argues and why it might land."),
      }),
    )
    .min(1),
});

/**
 * The idea list, as the model must return it.
 *
 * `format` and `channels` are asked for as free strings and clamped afterwards rather than constrained
 * here, deliberately: a model that returns "reel" for a format should produce a *usable idea with a
 * clamped format*, not a schema violation that loses the whole batch. The clamping is where the
 * guarantee lives — see `IDEA_FORMATS` and the channel filter.
 */
const ideaSchema = z.object({
  ideas: z
    .array(
      z.object({
        angle: z.string().min(1).max(200).describe("The idea in a few words."),
        hook: z.string().min(1).max(300).describe("The opening line, which is what makes two ideas distinct."),
        cta: z.string().min(1).max(200).describe("What the reader should do."),
        format: z.string().min(1).max(20).describe("One of: text, image, video."),
        channels: z.array(z.string().min(1)).max(8).describe("Platform ids this idea suits."),
        tip: z.string().max(300).optional().describe("One practical note, or omit it."),
      }),
    )
    .min(1),
});

/**
 * The evaluation, as one field.
 *
 * The old route asked for plain text and `StructuredGenerate` always takes a schema, so the prose comes back
 * wrapped rather than through a second, unschematised generation path. Bounded because it goes to a person:
 * the prompt asks for 2-4 sentences and 2-3 recommendations, and a model that writes an essay instead has
 * not done what was asked.
 */
const evaluationSchema = z.object({ evaluation: z.string().min(1).max(4_000) });

/**
 * The derived posts, as the model must return them.
 *
 * `platform` is asked for as a free string and clamped afterwards, the same reasoning as `ideaSchema`'s
 * `format`: a model naming a platform slightly differently should produce a *usable piece on the
 * assigned destination*, not a schema violation that loses the whole batch.
 */
const repurposeSchema = z.object({
  pieces: z
    .array(
      z.object({
        angle: z.string().min(1).max(200).describe("The takeaway this piece is built on."),
        platform: z.string().min(1).max(64).describe("The platform id this piece was assigned."),
        caption: z.string().min(1).max(4_000).describe("The post, in that platform's native style."),
      }),
    )
    .min(1),
});

/**
 * The rewritten media prompt, as one field.
 *
 * Bounded at 2,000 characters: the instruction asks for 80-140 words, and a model that writes an essay
 * has not done what was asked — but the bound is generous enough that a long, legitimately detailed
 * brief is not truncated into nonsense mid-sentence.
 */
const mediaPromptSchema = z.object({ prompt: z.string().min(1).max(2_000) });

/** N scene prompts. Each one is self-contained by construction — see the system prompt. */
const scenesSchema = z.object({ scenes: z.array(z.string().min(1).max(2_000)).min(1) });

/**
 * The bounds on the quality loop — REQ-014 AC-5.
 *
 * `MAX_ALTERNATIVES` is five because that is what `/api/ai/generate` already clamped `variants` to,
 * and a picker offering more than five captions is a worse choice rather than a richer one.
 *
 * `QUALITY_FLOOR` is what triggers one re-draft (AC-4). Six out of ten: the point where a caption is
 * not wrong but nobody would publish it. Set it higher and every run costs a second round on drafts
 * that were fine; set it lower and the floor never fires. It is a judgement, not a measurement, and
 * it is here as a named constant so it can be argued with.
 *
 * **Exactly one extra round.** A loop that retried until it cleared the floor would spend a
 * workspace's credits on a brief the model simply cannot do well.
 */
export const MAX_ALTERNATIVES = 5;

/**
 * The ceiling on researched hashtags — REQ-016 AC-2.
 *
 * Thirty, which is Instagram's hard limit and the highest any platform allows. The *useful* number is
 * far lower and comes from `platform_rules`, which the prompt states when the caller names a platform
 * — this is only the point past which a request is not a hashtag set but a keyword dump.
 */
export const MAX_HASHTAGS = 30;
export const QUALITY_FLOOR = 6;

/** The candidates, as the model must return them. */
const alternativesSchema = z.object({
  drafts: z.array(z.object({ caption: z.string().min(1) })).min(1),
});

/**
 * The rubric's answer — REQ-014 AC-1.
 *
 * Scores are bounded 0-10 by the schema, so a model that answers 95 out of 100 fails validation and
 * retries rather than producing a ranking where one candidate is fifteen times the others.
 *
 * `index` rather than the caption echoed back: asking a model to repeat a 2,000-character caption to
 * identify it wastes the budget and invites it to "improve" the text while copying it, which would
 * silently change what the score belongs to.
 */
const rubricSchema = z.object({
  scores: z
    .array(
      z.object({
        index: z.number().int().min(0),
        hook: z.number().min(0).max(10),
        onBrand: z.number().min(0).max(10),
        cta: z.number().min(0).max(10),
        platformFit: z.number().min(0).max(10),
        critique: z.string().min(1).max(300),
      }),
    )
    .min(1),
});

/**
 * The researched hashtags, as the model must return them — REQ-016 AC-2.
 *
 * `tag` is asked for as a free string and normalised afterwards rather than pattern-matched by the
 * schema: a model writing `spring lot` or `# coffee` has done the useful part, and failing the whole
 * batch on a missing `#` would lose the research over punctuation. Same reasoning as `ideaSchema`'s
 * `format`.
 */
const hashtagSchema = z.object({
  hashtags: z
    .array(
      z.object({
        tag: z.string().min(1).max(80),
        rationale: z.string().min(1).max(200).describe("What this tag is for, and where it came from."),
      }),
    )
    .min(1),
});

/**
 * A multi-format set, as the model must return it — #458.
 *
 * One array with a `format` discriminator rather than three arrays, because that is how the model is
 * asked to see the set: one source, several different things drawn from it, none of them the same
 * argument twice. Three arrays invite three independent answers.
 *
 * `platform` is a free string on every arm and is clamped afterwards, the same reasoning `repurposeSchema`
 * records: a model naming a platform slightly differently should produce a *usable piece on the
 * assigned destination*, not a schema violation that loses the whole batch.
 */
const formatSetSchema = z.object({
  items: z
    .array(
      z.object({
        format: z.enum(["post", "thread", "script"]),
        angle: z.string().min(1).max(200).describe("The takeaway this item is built on."),
        platform: z.string().max(50).optional(),
        caption: z.string().optional().describe("post only — the whole post text."),
        parts: z.array(z.string().min(1)).optional().describe("thread only — each part in order."),
        kind: z.enum(["reel", "carousel"]).optional().describe("script only."),
        title: z.string().max(200).optional().describe("script only."),
        hook: z.string().max(400).optional().describe("script only — the first line, which decides the rest."),
        cta: z.string().max(300).optional().describe("script only — the ask at the end."),
        beats: z
          .array(
            z.object({
              onScreen: z.string().min(1).max(400).describe("The text the viewer reads. Always required."),
              voiceover: z.string().max(600).optional().describe("Reel only — a carousel has no audio."),
              visual: z.string().max(300).optional().describe("Shot direction, not prose."),
              seconds: z.number().min(0).max(120).optional().describe("Reel only — a carousel has no time axis."),
            }),
          )
          .optional()
          .describe("script only — the shots or slides, in order."),
      }),
    )
    .min(1),
});

/** The refinement pass's answer — one caption, no commentary. */
const refinementSchema = z.object({ caption: z.string().min(1) });

const variantSchema = z.object({
  variants: z
    .array(
      z.object({
        platformId: z.string().min(1),
        caption: z.string().min(1),
      }),
    )
    .min(1),
});

/**
 * What a caller supplies. A `generate` function rather than a model object, so this file imports no SDK.
 *
 * The host already resolves a model through `ModelPolicy` — role, capabilities, residency, cost ceiling — and a
 * generator that took a model id would bypass every one of those decisions.
 */
export type StructuredGenerate = <T>(input: {
  readonly context: ExecutionContext;
  readonly system: string;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  /**
   * An image for the model to look at. **Vision-capable models only.**
   *
   * One generate function rather than two, so the model, its credentials and its pricing are resolved in
   * exactly one place — the reason `structuredGenerateFrom` exists at all: *"two readings of the same
   * variables agree by coincidence until one gains a default the other does not."*
   *
   * A model without vision handed one of these fails inside the provider call, and that is the honest
   * outcome: the alternative is a capability check this package would have to keep in step with five
   * vendors' model lists.
   */
  readonly image?: { readonly bytes: Uint8Array; readonly mime: string };
  /**
   * #657: another model on the **deployment's** key for this call — a small one for thread summaries. Ignored when
   * the workspace's own key serves the call: what models that key may reach is not ours to guess.
   */
  readonly modelId?: string;
}) => Promise<T>;

export type GeneratorConfig = {
  readonly generate: StructuredGenerate;
  /** Read once per turn by the caller and passed in — see the header. */
  readonly brand: (context: ExecutionContext) => Promise<BrandProfile>;
  /**
   * The limits each platform will be judged by — #287. Supplied by the composition from the content
   * service, which is the same source `validateContent` reads.
   *
   * Optional so a deployment without it degrades to the old behaviour — a caption written blind and
   * corrected by the repair loop — rather than failing. Wired here rather than held as data because
   * `platform_rules` is workspace-overridable, and #118 and #122 both settled that a limit known to
   * the caller is a limit that can be wrong for the workspace.
   */
  readonly platformRules?: (
    context: ExecutionContext,
    platformIds: readonly string[],
  ) => Promise<readonly PlatformRule[]>;
  /**
   * The workspace's own posts, shown to the model as few-shot voice examples — REQ-013 AC-2, #265.
   *
   * **This was the half of REQ-013 that never reached generation.** `listVoiceExamples`, the corpus,
   * the exemplar toggle and the coverage selector all existed, and a context provider put the
   * examples in front of the *conversational assistant* on every turn. But `generate_content` and
   * `generate_campaign` are tools: they are invoked directly by the compose screen and the campaign
   * route, with no prompt assembly and therefore no context providers. Which is to say the captions
   * the product actually writes were the ones that never saw the voice corpus.
   *
   * Asked for per call, like `brand` and unlike a held copy, because the corpus changes the moment
   * somebody ticks the box on a post — and for the same reason `brand` is wired at the composition
   * root rather than looked up here: the caller reads it once per turn, not once per variant.
   *
   * Optional, so a deployment without a corpus reader degrades to the brand profile alone, which is
   * REQ-013 AC-5's cold start arriving by a different route.
   */
  readonly voiceExamples?: (context: ExecutionContext) => Promise<readonly VoiceExample[]>;
};

/** The brand, as prompt text. Absent fields are omitted rather than rendered as "unknown". */
const brandBrief = (profile: BrandProfile): string => {
  const lines = [
    profile.brandName === undefined ? undefined : `Brand: ${profile.brandName}`,
    profile.company === undefined ? undefined : `Company: ${profile.company}`,
    profile.website === undefined ? undefined : `Website: ${profile.website}`,
    profile.audience === undefined ? undefined : `Audience: ${profile.audience}`,
    ...brandKitLines(profile),
    profile.voice === undefined ? undefined : `Voice: ${profile.voice}`,
    profile.avoid === undefined ? undefined : `Avoid: ${profile.avoid}`,
  ].filter((line): line is string => line !== undefined);
  /**
   * An empty profile produces an empty brief, not a placeholder.
   *
   * "Brand: unknown" in a prompt is worse than silence: a model told a field is unknown will sometimes write
   * about not knowing it.
   */
  return lines.join("\n");
};

/**
 * The previous attempt's findings, as instructions.
 *
 * `avoid` is what makes the repair loop in docs/07 step 8 work. Rendered as a list of things not to do again
 * rather than as raw validation output, because a model handed `{"code":"caption-too-long"}` has to guess what
 * to change.
 */
const avoidance = (issues: readonly ValidationIssue[]): string =>
  issues.length === 0
    ? ""
    : `\n\nThe previous attempt was rejected. Do not repeat these:\n${issues
        .map((issue) => `- ${issue.message}`)
        .join("\n")}`;

/**
 * Hooks a sibling post in the same campaign already used.
 *
 * Deliberately worded as a *constraint*, not a rejection — the old runtime's block reads "Do NOT reuse
 * these hooks from sibling posts", and folding these into `avoidance` above would tell the model its
 * work was rejected when nothing of its had been written yet.
 */
const siblingHooks = (hooks: readonly string[] | undefined): string => {
  const used = (hooks ?? []).map((hook) => hook.trim()).filter((hook) => hook !== "");
  return used.length === 0
    ? ""
    : `\n\nDo NOT reuse these hooks from sibling posts in the same campaign: ${used.join("; ")}`;
};

/**
 * Live findings, with the instruction the old runtime attached to them.
 *
 * *"Current findings from a live web search — ground the ideas in what is timely, but do not fabricate
 * specifics beyond these"*. The second clause is the one that matters: a model handed real findings will
 * otherwise produce a fourth statistic in the same register as the three it was given.
 *
 * One function rather than two copies, because `suggestIdeas` and `proposeAngles` both render it and a
 * second copy is a second wording to keep in step.
 */
const trendBlock = (trends: readonly { readonly title: string; readonly snippet: string }[]): string =>
  trends.length === 0
    ? ""
    : `\n\nCurrent findings from a live web search — ground the ideas in what is timely, but do not ` +
      `fabricate specifics beyond these:\n${trends.map((finding) => `- ${finding.title}: ${finding.snippet}`).join("\n")}`;

/**
 * The three vision modes, transcribed with their prompts — REQ-019 (#295).
 *
 * `alt_text` is the one with a hard rule rather than a style: *"describe only what is visibly present —
 * no interpretation, no marketing language"*, and a 125-character ceiling. Alt text that markets is
 * worse than none, because a screen-reader user cannot see what it left out.
 */
export const VISION_MODES = ["alt_text", "caption", "competitor"] as const;
export type VisionMode = (typeof VISION_MODES)[number];

export const VISION_PROMPTS: Readonly<Record<VisionMode, string>> = {
  alt_text:
    "Write ONE concise, factual alt-text description of this image for accessibility (max 125 " +
    "characters). Describe only what is visibly present — no interpretation, no marketing language. " +
    "Output the description only.",
  caption:
    "You are a social copywriter. Look at this image and write ONE scroll-stopping caption that could " +
    "accompany it as a post. Honor any brand context. Output the caption only — no hashtags, no preamble.",
  competitor:
    "You are a competitive social-media analyst. This is a screenshot of a competitor's page/post. " +
    "Analyze it: their positioning and hook, the format and tone, and 2-3 concrete things WE should do " +
    "differently or better. Be specific and brief.",
};

/** How long an answer may be, per mode. Alt text has a real ceiling; the others just need a bound. */
export const MAX_ALT_TEXT_CHARS = 125;

/** Whether any metric in a set is an actual number, rather than all of them being absences. */
const hasNumbers = (facts: readonly Fact[]): boolean => facts.some((fact) => "value" in fact);

/**
 * One line of metrics, with absences named.
 *
 * `not measured` rather than `0` for an `unavailable` fact — the whole reason `Fact` is a union. Rates are
 * rendered as a percentage to one decimal, matching the block this is transcribed from.
 */
const factLine = (facts: readonly Fact[]): string =>
  facts
    .map((fact) => {
      const label = fact.metric.replace(/_/g, " ");
      if (!("value" in fact)) return `${label} not measured`;
      return fact.unit === "fraction" ? `${label} ${(fact.value * 100).toFixed(1)}%` : `${label} ${fact.value}`;
    })
    .join(", ");

/**
 * How many pieces one source may be turned into, and how much of the source the model sees.
 *
 * Both transcribed: `min(int(count or 3), 10)` and `source_text.strip()[:6000]`. The piece cap is 10
 * rather than `MAX_ANGLES`' 6 because nothing here plans angles — there is no planner offering them, so
 * the reason for the tighter bound does not apply.
 */
export const MAX_REPURPOSE_PIECES = 10;
/** `scene_count: Field(..., ge=2, le=4)`, transcribed. One scene is not a planned video. */
export const MIN_VIDEO_SCENES = 2;
export const MAX_VIDEO_SCENES = 4;
export const MAX_REPURPOSE_SOURCE_CHARS = 6_000;

/** What the product can render. Anything else is clamped to `text`. */
export const IDEA_FORMATS = ["text", "image", "video"] as const;

/**
 * The bounds, written into the prompt — #287.
 *
 * Stated per platform and only where a rule exists: naming a platform with no known limit invites the
 * model to invent one, and an unseeded platform genuinely has none. `hashtagMin` matters as much as
 * the maximum — ShareFlow's shipped instagram rule requires **five**, and a model told nothing writes
 * two and fails validation for a reason it was never given.
 *
 * Advisory in tone on purpose. The validator is the authority and will still refuse an over-long
 * caption; this only stops the first draft being one the product already knows is wrong.
 */
const platformBounds = (
  platforms: readonly string[],
  rules: readonly { platformId: string; charLimit: number | null; hashtagMin: number | null; hashtagMax: number | null }[],
): string => {
  const byId = new Map(rules.map((rule) => [rule.platformId.toLowerCase(), rule]));
  const lines = platforms.flatMap((platform) => {
    const rule = byId.get(String(platform).toLowerCase());
    if (rule === undefined) return [];
    const parts: string[] = [];
    if (rule.charLimit !== null) parts.push(`at most ${rule.charLimit} characters`);
    if (rule.hashtagMin !== null && rule.hashtagMax !== null) {
      parts.push(`${rule.hashtagMin}-${rule.hashtagMax} hashtags`);
    } else if (rule.hashtagMin !== null) {
      parts.push(`at least ${rule.hashtagMin} hashtags`);
    } else if (rule.hashtagMax !== null) {
      parts.push(`at most ${rule.hashtagMax} hashtags`);
    }
    return parts.length === 0 ? [] : [`- ${platform}: ${parts.join(", ")}`];
  });
  return lines.length === 0 ? "" : `\n\nWrite each caption within its platform's limits:\n${lines.join("\n")}`;
};

/**
 * What each funnel stage actually asks a reader to do — REQ-018 AC-3.
 *
 * Spelled out rather than passed as a bare word. "Conversion" is a word a model will happily nod at
 * and then write the same mid-funnel explainer it was going to write anyway; *"ask for the decision
 * now"* is an instruction it can follow. The wording is one clause per stage because a stage that
 * takes a paragraph to explain is a stage the writer will average out with the others.
 */
const STAGE_INTENT: Record<string, string> = {
  awareness: "earn attention from people who do not yet know this exists — lead with the problem or the hook, not the product, and do not ask for a purchase",
  consideration: "help someone already interested decide — be concrete about how it works, what it does and who it is for",
  conversion: "ask for the decision now — one clear action, and a reason to take it today rather than later",
  retention: "speak to people who already bought — depth, follow-through and getting more out of it, not a first-time pitch",
};

/**
 * One funnel slot, rendered for a prompt.
 *
 * The playbook's own angle and CTA travel with the stage because they are the part a template was
 * chosen for, and they are labelled as *suggestions* — a model handed "Tease the problem you solve"
 * as a command writes that sentence rather than a post about this campaign's actual subject.
 *
 * An unknown stage renders its name alone rather than nothing. `posts.funnel_stage` accepts four
 * values today and could accept a fifth before this map does; naming it is weaker guidance than a
 * sentence and much better than silently dropping the only strategy the caller supplied.
 */
const funnelBlock = (step: FunnelStep | undefined): string => {
  if (step === undefined) return "";
  const intent = STAGE_INTENT[step.stage];
  const lines = [`Funnel stage: ${step.stage}${intent === undefined ? "" : ` — ${intent}`}`];
  if (step.angle !== undefined && step.angle.trim() !== "") {
    lines.push(`The playbook's suggested approach for this slot (adapt it to the subject, do not quote it): ${step.angle.trim()}`);
  }
  if (step.cta !== undefined && step.cta.trim() !== "") {
    lines.push(`Suggested call to action: ${step.cta.trim()}`);
  }
  return `\n\n${lines.join("\n")}`;
};

/**
 * The whole sequence's shape, for the planner that proposes the angles.
 *
 * `proposeAngles` is asked for N angles at once, so it needs the N slots together rather than one at
 * a time: an angle proposed for position 3 should not repeat the argument position 2 is making, and
 * that is only visible when the planner can see both. Numbered from 1 because the numbers appear in
 * the answer's ordering, and a model given a zero-indexed list returns a first angle labelled 0.
 */
const funnelPlanBlock = (steps: readonly FunnelStep[] | undefined): string => {
  if (steps === undefined || steps.length === 0) return "";
  const lines = steps.map((step, index) => {
    const intent = STAGE_INTENT[step.stage];
    const suffix = [
      step.angle === undefined || step.angle.trim() === "" ? "" : ` Suggested approach: ${step.angle.trim()}.`,
      step.cta === undefined || step.cta.trim() === "" ? "" : ` Call to action: ${step.cta.trim()}.`,
    ].join("");
    return `${index + 1}. ${step.stage}${intent === undefined ? "" : ` — ${intent}`}.${suffix}`;
  });
  return (
    `\n\nThis campaign is a sequence, and each angle has a job. Propose them IN THIS ORDER, one per ` +
    `line below:\n${lines.join("\n")}`
  );
};

/**
 * The workspace's own posts, as prompt text — REQ-013 AC-2.
 *
 * **Labelled by source, because they are different claims.** A post somebody ticked is "this is how
 * we want to sound"; a post the metrics ranked is "this is what worked". Presented identically, the
 * model is asked to imitate a viral post as though the workspace had endorsed its voice — an
 * inference nobody made, about a post that may have gone viral for a reason nobody wants repeated.
 *
 * **The instruction says voice, not content.** Without it a model shown three posts about coffee
 * writes a fourth post about coffee, whatever the brief said — the examples are the strongest signal
 * in the prompt and nothing else tells it what they are for.
 *
 * Empty in, empty out: no header, no "no examples available". A model told a section is empty
 * sometimes writes about the emptiness, and the brand profile above it is the cold-start answer.
 */
const voiceBlock = (examples: readonly VoiceExample[]): string => {
  if (examples.length === 0) return "";
  const lines = examples.map((example) => {
    const label =
      example.source === "manual"
        ? " (chosen as an example of this brand's voice)"
        : example.source === "auto_top"
          ? " (one of this workspace's best-performing posts)"
          : "";
    // Collapsed to one line each: a multi-line excerpt in a bulleted list reads as several examples.
    return `- ${example.excerpt.replace(/\s+/g, " ").trim()}${label}`;
  });
  return (
    `\n\nPosts this workspace has written. Match their VOICE — sentence length, register, punctuation, ` +
    `how they open and close — and not their subject matter:\n${lines.join("\n")}`
  );
};

/** Counts are per format and bounded here rather than by the caller — #458. */
const clampCount = (value: number): number => Math.min(Math.max(Math.trunc(value) || 0, 0), MAX_REPURPOSE_PIECES);

/**
 * A script as the markdown `create_artifact` stores — #458.
 *
 * Rendered from the structured fields rather than asked of the model, so the document a person reads
 * and the structure a caller inspects cannot disagree. `docs/specs/458-script-shape.md` has the shape
 * and the reason for every field.
 *
 * A table for the beats, because a script is read by scanning down one column — "what am I filming
 * next" — and prose makes that the one thing it is bad at. Columns are dropped when the kind has no
 * use for them: a carousel with an empty `voiceover` column invites somebody to fill it in.
 */
const scriptMarkdown = (script: {
  readonly kind: "reel" | "carousel";
  readonly title: string;
  readonly hook: string;
  readonly cta: string;
  readonly beats: readonly ScriptBeat[];
}): string => {
  const isReel = script.kind === "reel";
  const unit = isReel ? "Shot" : "Slide";
  const columns = [unit, "On screen", ...(isReel ? ["Voiceover"] : []), "Visual", ...(isReel ? ["Seconds"] : [])];
  const cell = (value: string | number | undefined): string =>
    // Pipes would break the row; a beat is one line by construction, so newlines become spaces.
    value === undefined ? "—" : String(value).replace(/\s+/g, " ").replace(/\|/g, "\\|");

  const rows = script.beats.map((beat, index) =>
    `| ${index + 1} | ${cell(beat.onScreen)} |` +
    (isReel ? ` ${cell(beat.voiceover)} |` : "") +
    ` ${cell(beat.visual)} |` +
    (isReel ? ` ${cell(beat.seconds)} |` : ""),
  );

  const total = script.beats.reduce((sum, beat) => sum + (beat.seconds ?? 0), 0);

  return [
    `# ${script.title}`,
    "",
    `**${isReel ? "Reel" : "Carousel"} script**`,
    "",
    `**Hook:** ${script.hook === "" ? "—" : script.hook}`,
    "",
    `| ${columns.join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows,
    "",
    `**Call to action:** ${script.cta === "" ? "—" : script.cta}`,
    // Only when the model actually gave timings — a runtime of 0s reads as a measurement.
    ...(isReel && total > 0 ? ["", `**Runtime:** about ${Math.round(total)}s`] : []),
    "",
  ].join("\n");
};

export const createModelContentGenerator = (config: GeneratorConfig): ContentGenerator => ({
  async proposeAngles(context, input) {
    const count = Math.min(Math.max(Math.trunc(input.count), 1), MAX_ANGLES);
    if (input.brief.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no brief to propose angles for.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));
    const result = await config.generate({
      context,
      system:
        "You propose distinct strategic angles for a social post. Each angle is one way of approaching the " +
        "brief — a different argument, not a different wording. Two angles that would produce similar posts " +
        "are one angle." + (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Brief: ${input.brief}${trendBlock(input.trends ?? [])}` +
        funnelPlanBlock(input.steps) +
        `\n\nPropose ${count} distinct angles.`,
      schema: angleSchema,
    });
    /**
     * Trimmed to what was asked for.
     *
     * A model that returns seven when asked for three is not an error worth failing a turn over, but handing
     * all seven back would make `count` advisory — and a caller that asked for three and rendered seven has a
     * broken UI rather than a generous one.
     */
    return result.angles.slice(0, count) as readonly ContentAngle[];
  },

  async suggestIdeas(context, input) {
    const count = Math.min(Math.max(Math.trunc(input.count), 1), MAX_ANGLES);
    if (input.theme.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no theme to suggest ideas for.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));

    const trends = trendBlock(input.trends);

    const result = await config.generate({
      context,
      /**
       * Transcribed, because these clauses are the part that took judgement.
       *
       * *"The HUMAN will write every post themselves — you only advise what content to create"* is
       * the one that keeps the answer advisory; a model left to infer it writes captions, and the
       * caller has no field to put them in. *"Angles must be clearly distinct"* is what makes N ideas
       * worth more than one, and the `tip` clause is what stops it being a restatement of the hook.
       *
       * The channel instruction is asked for **as well as** enforced. The clamp is the guarantee, but
       * a model that was never told to pick from the list produces channels that all get filtered
       * away, and an idea with an empty channel list is a worse answer than a wrong one.
       */
      system:
        "You are a social media content strategist. The HUMAN will write every post themselves — you " +
        "only advise what content to create; do not write the posts. Angles must be clearly distinct " +
        "from each other, not the same thought reworded. Pick `channels` ONLY from the allowed " +
        "platform ids given, best fit per idea, 1-3 each. `tip` is one concrete, practical writing or " +
        "production tip for that idea — structure, length, visual." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Campaign theme: ${input.theme}` +
        `\nCampaign goal: ${input.goal ?? "grow awareness and engagement"}` +
        `\nAllowed platform ids: ${input.channels.length === 0 ? "any" : input.channels.join(", ")}` +
        (input.mediaType === undefined ? "" : `\nCampaign media type: ${input.mediaType}`) +
        `\nN = ${count}` +
        trends,
      schema: ideaSchema,
    });

    /**
     * Clamped, not trusted — the old runtime's reason, kept verbatim: *"`format` is clamped to
     * text/image/video and `channels` to the allowed id list, so a drifting model can't suggest
     * platforms the workspace doesn't have."*
     *
     * The channel filter is the safety-relevant half. An idea recommending a platform nobody is
     * connected to sends a person off to set one up on the strength of a model's guess.
     */
    /**
     * Case-insensitive, and mapped back to the caller's own id.
     *
     * The allowed ids arrive lower-cased (`platformList` normalises them); a model handed "linkedin"
     * may well answer "LinkedIn". An exact-match filter would drop a *correct* channel — the filter
     * failing closed on a right answer is worse than the drift it exists to catch, because it looks
     * like the workspace has no channel for the idea.
     */
    const allowed = new Map(input.channels.map((channel) => [channel.toLowerCase(), channel]));
    return result.ideas.slice(0, count).map((idea) => ({
      angle: idea.angle,
      hook: idea.hook,
      cta: idea.cta,
      format: (IDEA_FORMATS as readonly string[]).includes(idea.format) ? (idea.format as "text" | "image" | "video") : "text",
      channels:
        allowed.size === 0
          ? idea.channels
          : idea.channels.flatMap((channel) => {
              const match = allowed.get(channel.toLowerCase());
              return match === undefined ? [] : [match];
            }),
      ...(idea.tip === undefined || idea.tip.trim() === "" ? {} : { tip: idea.tip }),
    }));
  },

  async describeImage(context, input) {
    const brand = brandBrief(await config.brand(context));
    /**
     * The brand reaches `caption` and `competitor` but **not** `alt_text`.
     *
     * Alt text is an accessibility description, not copy: handing it the brand voice is how "a tabby cat
     * on a windowsill" becomes "the cosy moment your morning deserves", which is exactly what its own
     * instruction forbids. The old runtime passed brand context to all three; this is a deliberate
     * departure and the reason is the instruction it already carried.
     */
    const withBrand = input.mode !== "alt_text" && brand !== "";

    const result = await config.generate({
      context,
      system: VISION_PROMPTS[input.mode] + (withBrand ? `\n\n${brand}` : ""),
      prompt: "Analyze the attached image.",
      image: input.image,
      schema: z.object({ text: z.string().min(1).max(4_000) }),
    });

    const text = result.text.trim();
    /**
     * The alt-text ceiling is enforced, not merely asked for.
     *
     * A `<img alt>` that runs to a paragraph is read out in full by a screen reader before the page can
     * continue. Cut on a word boundary so the result is still a sentence fragment rather than a word
     * sliced in half.
     */
    if (input.mode === "alt_text" && text.length > MAX_ALT_TEXT_CHARS) {
      const cut = text.slice(0, MAX_ALT_TEXT_CHARS);
      const lastSpace = cut.lastIndexOf(" ");
      return (lastSpace > MAX_ALT_TEXT_CHARS - 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
    }
    return text;
  },

  async draftAutoReply(context, input) {
    if (input.comment.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no comment to reply to.",
        retryable: false,
      });
    }

    /**
     * The plan is computed first and the model is asked only for prose.
     *
     * `planReply` decides the matched rule, the escalation flag and both prompts, all from keyword
     * heuristics transcribed from `ai_backend/app/agents/reply.py` and checked against it by a
     * differential test over 638 values. None of that is delegated to the model, because
     * `web/src/lib/ingest.ts` auto-sends on `confidence >= threshold` and a model asked to score its
     * own reply would be deciding whether a person needs to read it.
     */
    const plan = planReply(input);

    /**
     * **No brand brief here, deliberately.**
     *
     * Every other method in this file opens with `brandBrief(await config.brand(context))`, and this
     * one does not: the persona instruction already carries the identity the reply must adopt, and it
     * is scoped to the *connected account* rather than to the workspace. Adding the workspace brand
     * would let a reply from a personal account speak in a brand's voice, which is the specific thing
     * `_PERSONA_SAFETY_INSTRUCTIONS` and `allow_brand_mentions` exist to prevent.
     */
    const result = await config.generate({
      context,
      system: plan.system,
      prompt: plan.prompt,
      /**
       * A one-field schema, which is how every text-returning method here asks for text — the port's
       * `config.generate` has no schema-less mode. `describe_image` does exactly the same.
       *
       * `.min(1)` and the reply's own blank check are not redundant: a model returning nothing fails
       * the schema and the platform retries it, and a model returning whitespace passes the schema and
       * is caught by `finishReply`, which scores it 0 so it can never be auto-sent.
       */
      schema: z.object({ text: z.string().min(1).max(4_000) }),
    });

    return finishReply(input, plan, result.text);
  },

  async enhanceMediaPrompt(context, input) {
    if (input.brief.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no brief to expand.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));

    /**
     * Transcribed, including the per-kind branch — the two are genuinely different instructions and a
     * single one produces still-image language for video.
     */
    const result = await config.generate({
      context,
      system:
        "You are a visual prompt director for AI media generation. Rewrite the user's brief into ONE " +
        "rich, concrete generation prompt (80-140 words): subject, action, setting, visual style, " +
        "camera framing/motion, lighting and ambiance." +
        (input.kind === "video"
          ? " Because this is VIDEO, also weave in motion over time and audio cues (ambient sound, " +
            "sound effects, short dialogue in quotes if fitting)."
          : " Because this is a STILL IMAGE, focus on composition, detail and mood.") +
        " Stay faithful to the user's intent and any brand context. Output ONLY the rewritten prompt " +
        "— no preamble, no quotes, no options." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt: `User brief: ${input.brief.trim()}`,
      schema: mediaPromptSchema,
    });
    return result.prompt.trim();
  },

  async planVideoScenes(context, input) {
    const sceneCount = Math.trunc(input.sceneCount);
    if (input.concept.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no concept to plan scenes for.",
        retryable: false,
      });
    }
    if (sceneCount < MIN_VIDEO_SCENES || sceneCount > MAX_VIDEO_SCENES) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: `A planned video is between ${MIN_VIDEO_SCENES} and ${MAX_VIDEO_SCENES} scenes.`,
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));

    const result = await config.generate({
      context,
      /**
       * Transcribed. The clause that does the work is the parenthesis: *"restate them explicitly in
       * every scene prompt — the video model has no memory between scenes"*. Without it the scenes
       * describe one world and the model renders three unrelated clips, which is the whole failure this
       * planner exists to prevent.
       */
      system:
        "You are a film director planning an AI-generated multi-scene video. Split the user's concept " +
        "into exactly N sequential scene prompts that cut together as ONE coherent film: keep the SAME " +
        "subject, visual style, color palette and world across all scenes (restate them explicitly in " +
        "every scene prompt — the video model has no memory between scenes); give each scene its own " +
        "action beat, camera framing/motion, lighting and audio cues; scene 1 establishes, the last " +
        "scene resolves." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt: `Concept: ${input.concept.trim()}\nN = ${sceneCount}`,
      schema: scenesSchema,
    });

    const scenes = result.scenes.map((scene) => scene.trim()).filter((scene) => scene !== "");
    if (scenes.length < sceneCount) {
      /**
       * The old planner's own refusal: *"planner produced N scenes, expected M"*.
       *
       * All or nothing. A three-scene film delivered as two is not a shorter film — the caller queues
       * one generation job per scene, and a missing middle is a video that does not make sense.
       */
      throw new AgentPlatformError({
        code: "provider_unavailable",
        message: `The planner produced ${scenes.length} scene(s) for a ${sceneCount}-scene video.`,
        retryable: true,
      });
    }
    return scenes.slice(0, sceneCount);
  },

  async repurpose(context, input) {
    const count = Math.min(Math.max(Math.trunc(input.count), 1), MAX_REPURPOSE_PIECES);
    if (input.source.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no source to repurpose.",
        retryable: false,
      });
    }
    if (input.platformIds.length === 0) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "Name at least one destination — a repurposed post is written for a platform's own style.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));

    /**
     * Round-robin, transcribed: `assigned = [targets[i % len(targets)] for i in range(count)]`.
     *
     * Three pieces across two platforms is LinkedIn, X, LinkedIn — not two pieces. The count is what
     * the caller asked for and the platforms are what it is spread across.
     */
    const assigned = Array.from({ length: count }, (_, index) => input.platformIds[index % input.platformIds.length]!);

    /**
     * The source, bounded. `source_text.strip()[:6000]` in the old engine, with its own reason: *"keep
     * the prompt bounded"*.
     *
     * Truncated rather than refused, and the caller is told: a 40-page transcript is a perfectly
     * reasonable thing to paste, and refusing it would make the feature unusable for its main input.
     */
    const source = input.source.trim().slice(0, MAX_REPURPOSE_SOURCE_CHARS);

    /*
     * The same bounds `generate` is given — #287's fix, applied to the path that needed it more.
     *
     * `generate` writes blind and the repair loop corrects it: over-long, regenerate, try again. A
     * repurposed piece has **no such loop** — `repurpose_source` returns the pieces and saves
     * nothing, so an X piece written at 2,000 characters reaches the user looking finished and fails
     * only when they try to publish it, by which point they have chosen it.
     *
     * Asked for, never held, for the reason the port records: `platform_rules` is workspace-overridable.
     */
    const rules =
      config.platformRules === undefined ? [] : await config.platformRules(context, input.platformIds);

    const result = await config.generate({
      context,
      /**
       * Transcribed from `REPURPOSE_SYSTEM_PROMPT`. The clause that carries the whole feature is
       * *"each a different angle, takeaway or hook drawn from the source (never a reword of another)"*
       * — without it a model returns the same post in five registers.
       */
      system:
        "You are a content repurposing strategist. Given ONE source — an article, a transcript or an " +
        "idea — extract N DISTINCT, self-contained social posts: each a different angle, takeaway or " +
        "hook drawn from the source, never a reword of another. Tailor each to its assigned platform's " +
        "native style. Draw only on the source; do not add facts it does not contain." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Platform assignment per piece, in order: ${assigned.join(", ")}` +
        `\nN = ${count}` +
        platformBounds(input.platformIds, rules) +
        `\n\nSOURCE:\n${source}`,
      schema: repurposeSchema,
    });

    /**
     * Clamped to the assignment.
     *
     * The old engine took the model's own platform when it sent one — `str(item.get("platform") or
     * assigned[i])` — so a model answering "instagram" for a piece assigned to LinkedIn retargeted it,
     * and the caller got a post for a destination it never named. Matched case-insensitively against
     * what *was* asked for, and otherwise the assignment for that position stands.
     */
    const allowed = new Map(input.platformIds.map((id) => [String(id).toLowerCase(), id]));
    return result.pieces.slice(0, count).map((piece, index) => ({
      angle: piece.angle,
      platformId: allowed.get(piece.platform.trim().toLowerCase()) ?? assigned[index]!,
      caption: piece.caption,
    }));
  },

  /**
   * One source into a set of different kinds of thing — REQ-015 AC-2, #458.
   *
   * `repurpose` returns N captions, which is "several posts" rather than a multi-format set. This asks
   * for posts, threads and scripts **in one call**, for a sharper version of `repurpose`'s own reason:
   * a per-format call could not tell that the thread and the reel script are the same argument twice.
   *
   * ## Where the judgement is
   *
   * **The counts go in the prompt as an explicit manifest**, not as "produce a mixed set". A model told
   * to write "a few of each" writes posts, because posts are what it has seen most of.
   *
   * **Each arm is narrowed from a loose schema afterwards.** The model answers one array with a
   * `format` tag and optional fields; a union schema would be stricter but loses the whole batch when
   * one item is malformed, which is the trade `repurposeSchema` already made for `platform`. An item
   * that does not carry what its own format needs is **dropped**, because a thread with no parts and a
   * script with no beats are not shorter versions of themselves.
   *
   * **The markdown is rendered here, not asked for.** A model asked for a document *and* a structure
   * will eventually return a document that does not match its own structure, and the document is the
   * half a person reads.
   */
  async repurposeToFormats(context, input) {
    const posts = clampCount(input.posts);
    const threads = clampCount(input.threads);
    const scripts = clampCount(input.scripts);
    if (posts + threads + scripts === 0) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "Ask for at least one post, thread or script.",
        retryable: false,
      });
    }
    if (input.source.trim() === "") {
      throw new AgentPlatformError({ code: "invalid_input", message: "There is no source to repurpose.", retryable: false });
    }
    if (input.platformIds.length === 0) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "Name at least one destination — a repurposed post is written for a platform's own style.",
        retryable: false,
      });
    }

    const brand = brandBrief(await config.brand(context));
    const rules = config.platformRules === undefined ? [] : await config.platformRules(context, input.platformIds);
    const source = input.source.trim().slice(0, MAX_REPURPOSE_SOURCE_CHARS);
    /* Round-robin across the destinations, the same rule `repurpose` transcribes from the old engine. */
    const publishable = posts + threads;
    const assigned = Array.from(
      { length: publishable },
      (_unused, index) => input.platformIds[index % input.platformIds.length]!,
    );

    const manifest = [
      posts === 0 ? "" : `${posts} single post(s)`,
      threads === 0 ? "" : `${threads} thread(s), each 3-6 parts`,
      scripts === 0 ? "" : `${scripts} script(s)`,
    ]
      .filter((line) => line !== "")
      .join(", ");

    const result = await config.generate({
      context,
      system:
        "You are a content repurposing strategist. Given ONE source, produce a SET of different KINDS " +
        "of thing drawn from it — not the same argument in different shapes. Each item must be a " +
        "different angle or takeaway; two items making the same point is the failure this exists to " +
        "avoid. Draw only on the source; do not add facts it does not contain.\n\n" +
        "`post` is one complete post for its platform. `thread` is a sequence where each part is its " +
        "own post and each earns the next — never one post split at the character limit. `script` is a " +
        "plan somebody shoots: `hook` is the first line and decides whether the rest is seen, `beats` " +
        "are the shots or slides in order, `onScreen` is the text the viewer reads and is always " +
        "required because these feeds autoplay silently, `visual` is shot direction rather than prose " +
        '("close on the grinder burrs", not "we show craftsmanship"). Use kind `reel` for video — give ' +
        "those beats `voiceover` and `seconds` — and `carousel` for slides, which have neither." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Produce exactly: ${manifest}.` +
        (publishable === 0
          ? ""
          : `\n\nPlatform for each post and thread, in the order you write them: ${assigned.join(", ")}`) +
        platformBounds(input.platformIds, rules) +
        `\n\nSOURCE:\n${source}`,
      schema: formatSetSchema,
    });

    const allowed = new Map(input.platformIds.map((id) => [String(id).toLowerCase(), id]));
    const wanted: Record<"post" | "thread" | "script", number> = { post: posts, thread: threads, script: scripts };
    const items: RepurposedItem[] = [];
    let publishableSeen = 0;

    for (const raw of result.items) {
      if (wanted[raw.format] <= 0) continue;
      const platform = allowed.get((raw.platform ?? "").trim().toLowerCase()) ?? assigned[publishableSeen];

      if (raw.format === "post") {
        const caption = (raw.caption ?? "").trim();
        // A post with no caption is not a short post.
        if (caption === "" || platform === undefined) continue;
        items.push({ format: "post", angle: raw.angle, platformId: platform, caption });
        publishableSeen += 1;
      } else if (raw.format === "thread") {
        const parts = (raw.parts ?? []).map((part) => part.trim()).filter((part) => part !== "");
        /*
         * Two parts minimum, matching `createThreadDraft`'s refusal. A one-part "thread" would be
         * rejected by the thing this item exists to be handed to, one step later and less clearly.
         */
        if (parts.length < 2 || platform === undefined) continue;
        items.push({ format: "thread", angle: raw.angle, platformId: platform, parts });
        publishableSeen += 1;
      } else {
        const beats = (raw.beats ?? []).filter((beat) => beat.onScreen.trim() !== "");
        // A script with no beats is a title.
        if (beats.length === 0) continue;
        const kind = raw.kind ?? "reel";
        const script = {
          format: "script" as const,
          angle: raw.angle,
          kind,
          title: (raw.title ?? raw.angle).trim(),
          hook: (raw.hook ?? "").trim(),
          cta: (raw.cta ?? "").trim(),
          /*
           * A carousel has no audio and no time axis, so those fields are stripped rather than passed
           * through — a model that answers them anyway would otherwise put a voiceover on a slide.
           */
          beats: beats.map((beat) => ({
            onScreen: beat.onScreen.trim(),
            ...(kind === "carousel" || beat.voiceover === undefined ? {} : { voiceover: beat.voiceover.trim() }),
            ...(beat.visual === undefined ? {} : { visual: beat.visual.trim() }),
            ...(kind === "carousel" || beat.seconds === undefined ? {} : { seconds: beat.seconds }),
          })),
        };
        items.push({ ...script, markdown: scriptMarkdown(script) });
      }
      wanted[raw.format] -= 1;
    }

    return items;
  },

  async evaluateCampaign(context, input) {
    const brand = brandBrief(await config.brand(context));
    /**
     * Only posts with something to report get a line, which is the old block's own filter:
     * `filter((p) => p.publishedItems > 0 || p.impressions > 0)`.
     */
    const reported = input.posts.filter((post) => post.publishedDestinations > 0 || hasNumbers(post.facts));
    const unpublished = input.posts.length - reported.length;

    /**
     * The results block, transcribed from `web/src/lib/campaign-stats.ts`'s `formatStatsForEvaluation` —
     * per post, with the caption clipped so the prompt stays small, then a TOTAL line.
     *
     * Two departures. A metric nobody collected prints as `not measured`, never as `0`: the old block
     * could only print numbers, and *"engagement rate 0.0%"* for an uncollected post is a measurement
     * nobody took.
     *
     * And the posts that never went out are **counted**, which the old block dropped silently. Dropping
     * them makes the totals look like the whole campaign: an evaluation of three published posts out of
     * eight reads as an evaluation of the campaign, and "what to change next time" misses the largest
     * thing that went wrong. Counted rather than listed per post, because there is nothing to say about
     * each one — and a per-post line with no numbers invites "this one underperformed" about a post that
     * was never sent.
     */
    const stats = [
      ...reported.map((post, index) => {
        const caption = post.excerpt.replace(/\s+/g, " ").slice(0, 90);
        const where = post.platforms.length === 0 ? "n/a" : post.platforms.join(", ");
        return `Post ${index + 1} [${where}] "${caption}" — ${factLine(post.facts)}`;
      }),
      ...(unpublished === 0
        ? []
        : [`NOT PUBLISHED — ${unpublished} of ${input.posts.length} posts in this campaign never went out.`]),
      `TOTAL — ${factLine(input.totals)}`,
    ].join("\n");

    const result = await config.generate({
      context,
      /**
       * Transcribed from `EVALUATOR_SYSTEM_PROMPT`. *"Use only the numbers provided — never invent
       * metrics"* is the clause that matters, and it is only enforceable because the numbers were read
       * from the store rather than supplied by the model — see the port.
       */
      system:
        "You are a social media performance analyst. Given a campaign's theme, goal and per-post results, " +
        "write a short evaluation for the campaign owner: 2-4 sentences on what performed best and the " +
        "likely reason, then 2-3 concrete, actionable recommendations for the next campaign. Use only the " +
        "numbers provided — never invent metrics. Where a metric reads `not measured`, say that it was not " +
        "measured rather than treating it as zero. Label a cause you cannot see in the numbers as a " +
        "hypothesis. Plain text, no markdown headings, no bullet symbols other than '-'." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Campaign theme: ${input.theme}` +
        `\nCampaign goal: ${input.goal ?? "grow awareness and engagement"}` +
        `\n\nResults:\n${stats}` +
        `\n\nWrite the evaluation now.`,
      schema: evaluationSchema,
    });
    return result.evaluation.trim();
  },

  async generate(context, input) {
    if (input.platformIds.length === 0) {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "Generating a post needs at least one destination platform.",
        retryable: false,
      });
    }
    const platforms = input.platformIds.slice(0, MAX_PLATFORMS);
    const brand = brandBrief(await config.brand(context));
    /*
     * What each platform will actually be judged by — #287.
     *
     * Asked for, not held: `platform_rules` is workspace-overridable, so a generator carrying its own
     * copy would write to a limit the validator does not enforce. A deployment that supplies no
     * reader gets the old behaviour, which is a caption written blind rather than a crash.
     */
    const rules = config.platformRules === undefined ? [] : await config.platformRules(context, platforms);
    /*
     * The voice corpus — REQ-013 AC-2, #265.
     *
     * Read here rather than held, for the same reason as the rules above: somebody ticking the box on
     * a post should change the next caption, not the next deployment.
     */
    const examples = config.voiceExamples === undefined ? [] : await config.voiceExamples(context);

    const result = await config.generate({
      context,
      system:
        "You write social post captions. Produce one caption per platform named, written for that platform's " +
        "conventions. Do not include the platform name in the caption." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Brief: ${input.brief}` +
        (input.angle === undefined ? "" : `\n\nAngle: ${input.angle.label} — ${input.angle.rationale}`) +
        funnelBlock(input.step) +
        voiceBlock(examples) +
        `\n\nPlatforms: ${platforms.join(", ")}` +
        platformBounds(platforms, rules) +
        siblingHooks(input.avoidHooks) +
        avoidance(input.avoid),
      schema: variantSchema,
    });

    /**
     * Only the platforms that were asked for, and each at most once.
     *
     * A model that invents a platform or returns two captions for one would otherwise reach the caller, and
     * the second is the dangerous shape: a workflow taking "the caption for instagram" would silently get
     * whichever came first.
     */
    const wanted = new Set(platforms as readonly string[]);
    const seen = new Set<string>();
    const variants: GeneratedVariant[] = [];
    for (const variant of result.variants) {
      if (!wanted.has(variant.platformId) || seen.has(variant.platformId)) continue;
      seen.add(variant.platformId);
      variants.push(variant as GeneratedVariant);
    }

    /**
     * A platform the model skipped is reported by absence, not by an empty caption.
     *
     * An empty string would flow into a draft and publish as a blank post. Absence makes the caller decide,
     * and `validateContent` refuses an empty caption anyway — two independent places, which is right for the
     * one failure that reaches an audience.
     */
    if (variants.length === 0) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: `The model returned no caption for any of: ${platforms.join(", ")}.`,
        retryable: true,
      });
    }
    return variants;
  },

  /**
   * N alternatives for one destination, scored, ranked, and the winner refined once — REQ-014.
   *
   * ## The shape, and what each call is for
   *
   * 1. **Write** up to `count` candidates in one call, told to differ in approach rather than in
   *    wording. One call rather than N: a model writing five captions in one breath can see that two
   *    of them are the same idea, and five independent calls cannot.
   * 2. **Score** all of them in one call against the rubric (AC-1). Also one call, and for the same
   *    reason — a rubric applied to one caption at a time has no comparison to make, and the scores
   *    drift apart across calls in a way that makes the ranking meaningless.
   * 3. **Refine** the best one once, *told its own weakest dimension and the rubric's critique of
   *    it* (AC-2). A refinement pass given only "make this better" rewrites; given "the ask is vague"
   *    it fixes the ask.
   * 4. **Re-score** the refinement and keep it only if it actually scored higher. A model asked to
   *    improve something will always return something different, and returning a worse caption as
   *    "the refined one" is the failure this step exists to prevent.
   * 5. **One re-draft round** if the best still sits below `QUALITY_FLOOR` (AC-4), told what the
   *    rubric disliked. Exactly one: a loop that retried until it cleared the floor would spend a
   *    workspace's credits on a brief the model cannot do well.
   *
   * At most six model calls, and the count is bounded by the implementation rather than the caller
   * (AC-5) — an unbounded quality loop is how one click becomes a bill.
   *
   * ## What it does not do
   *
   * It does not validate. `validateContent` is the authority on whether a caption is publishable, and
   * a rubric that also refused things would be a second, softer gate with a different answer. A draft
   * scoring 3/10 is a bad caption, not an invalid one, and the person choosing is entitled to see it.
   */
  /**
   * Hashtags for a topic, ranked — REQ-016 AC-2.
   *
   * ## "Not invented" is a property of the prompt, and it has two halves
   *
   * When findings exist the instruction is that every tag must be **traceable to one of them**, and
   * the rationale is what carries the trace. When they do not, the instruction changes rather than the
   * findings block simply being absent: a model handed no findings and told to stay grounded in them
   * produces a confident list and a rationale that invents a source. So an ungrounded run is *told* it
   * is ungrounded, and says what the tag is for instead of where it came from.
   *
   * The caller reports which happened. `trendGrounded` exists on the tool for the same reason it
   * exists on `generate_campaign`: ungrounded output that looks grounded is worse than either.
   *
   * ## Normalisation is here, not in the schema
   *
   * A model writing `spring lot` has done the useful part and failed the punctuation. Refusing the
   * batch over a missing `#` would lose the research; normalising costs a regex. Deduplication is on
   * the normalised, case-folded tag, because `#Coffee` and `#coffee` are the same hashtag to every
   * platform and two of them in a list of eight is a wasted slot.
   */
  async deriveHashtags(context, input) {
    const count = Math.min(Math.max(Math.trunc(input.count), 1), MAX_HASHTAGS);
    if (input.topic.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no topic to research hashtags for.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));
    const rules =
      input.platformId === undefined || config.platformRules === undefined
        ? []
        : await config.platformRules(context, [input.platformId]);
    const grounded = input.findings.length > 0;

    const result = await config.generate({
      context,
      system:
        "You choose hashtags for social posts. Rank them by how likely each is to put this post in " +
        "front of people who care about the topic — not by how many posts already use it; a tag with " +
        "ten million posts buries a small brand. Prefer specific over generic. " +
        (grounded
          ? "Every tag must be traceable to the findings you are given, and its rationale must say which " +
            "one and why. Do not add tags the findings do not support."
          : "You have NO live search results, so do not claim any tag is trending, popular or current — " +
            "say what the tag is for instead of where it came from.") +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Topic: ${input.topic}` +
        (input.platformId === undefined ? "" : `\n\nPlatform: ${input.platformId}`) +
        platformBounds(input.platformId === undefined ? [] : [input.platformId], rules) +
        trendBlock(input.findings) +
        `\n\nPropose ${count} hashtags, best first.`,
      schema: hashtagSchema,
    });

    const seen = new Set<string>();
    const tags: ResearchedHashtag[] = [];
    for (const row of result.hashtags) {
      /*
       * One `#`, no whitespace, nothing a platform would reject. A tag that normalises to nothing —
       * the model answered with punctuation — is dropped rather than returned as a bare `#`.
       */
      const cleaned = row.tag.replace(/[^\p{L}\p{N}_]/gu, "");
      if (cleaned === "") continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push({ tag: `#${cleaned}`, rationale: row.rationale.trim() });
      if (tags.length === count) break;
    }
    return tags;
  },

  async draftAlternatives(context, input) {
    const count = Math.min(Math.max(Math.trunc(input.count), 1), MAX_ALTERNATIVES);
    if (input.brief.trim() === "") {
      throw new AgentPlatformError({
        code: "invalid_input",
        message: "There is no brief to write alternatives for.",
        retryable: false,
      });
    }
    const brand = brandBrief(await config.brand(context));
    const rules = config.platformRules === undefined ? [] : await config.platformRules(context, [input.platformId]);
    const examples = config.voiceExamples === undefined ? [] : await config.voiceExamples(context);
    const framing =
      `Brief: ${input.brief}` +
      (input.angle === undefined ? "" : `\n\nAngle: ${input.angle.label} — ${input.angle.rationale}`) +
      `\n\nPlatform: ${input.platformId}` +
      platformBounds([input.platformId], rules) +
      voiceBlock(examples);

    const write = async (avoiding: string): Promise<readonly string[]> => {
      const result = await config.generate({
        context,
        system:
          "You write social post captions. Produce genuinely different approaches to the same brief — a " +
          "different argument, a different opening, a different ask — not one caption reworded. Do not " +
          "include the platform name in the caption." + (brand === "" ? "" : `\n\n${brand}`),
        prompt: `${framing}${avoiding}\n\nWrite ${count} alternative captions.`,
        schema: alternativesSchema,
      });
      // Trimmed to what was asked for, the same rule `proposeAngles` applies: `count` is a ceiling.
      return result.drafts.slice(0, count).map((draft) => draft.caption);
    };

    const score = async (captions: readonly string[]): Promise<readonly ScoredDraft[]> => {
      if (captions.length === 0) return [];
      const result = await config.generate({
        context,
        system:
          "You judge social post captions against a fixed rubric, harshly and consistently. Score each " +
          "0-10 on four dimensions: `hook` — does the first line earn the second; `onBrand` — does it " +
          "sound like this brand rather than like generic marketing; `cta` — does it ask for something, " +
          "and is the ask the right size for where the reader is; `platformFit` — is it written for this " +
          "platform's conventions rather than translated into them. `critique` is one line naming the " +
          "single biggest thing holding that caption back. Ten is reserved for a caption you would " +
          "publish unchanged." + (brand === "" ? "" : `\n\n${brand}`),
        prompt:
          `${framing}\n\nScore each caption by its index.\n` +
          captions.map((caption, index) => `[${index}] ${caption}`).join("\n\n"),
        schema: rubricSchema,
      });

      /*
       * Keyed by the index the model returned, and a caption it skipped is **dropped** rather than
       * given a default score.
       *
       * A zero would rank an unjudged caption last and a five would rank it in the middle; both are
       * inventions, and the picker would present the number as the rubric's opinion. Losing a
       * candidate is the honest outcome, and `count` was a ceiling anyway.
       */
      const byIndex = new Map<number, (typeof result.scores)[number]>();
      for (const row of result.scores) {
        /*
         * First row wins for a repeated index.
         *
         * A model that scores the same caption twice has two opinions about it and no way to say which
         * it meant; taking the later one would mean the ranking depends on the order the model happened
         * to emit. An index outside the range needs no guard — the lookup below is keyed by each
         * caption's own position, so a row for index 9 of three captions is simply never read.
         */
        if (!byIndex.has(row.index)) byIndex.set(row.index, row);
      }
      return captions.flatMap((caption, index) => {
        const row = byIndex.get(index);
        if (row === undefined) return [];
        const scores = { hook: row.hook, onBrand: row.onBrand, cta: row.cta, platformFit: row.platformFit };
        const overall = (scores.hook + scores.onBrand + scores.cta + scores.platformFit) / 4;
        return [{ caption, scores, overall, refined: false, critique: row.critique }];
      });
    };

    const ranked = (drafts: readonly ScoredDraft[]): readonly ScoredDraft[] =>
      [...drafts].sort((a, b) => b.overall - a.overall);

    let drafts = ranked(await score(await write("")));
    if (drafts.length === 0) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: "The model returned no usable alternatives for this brief.",
        retryable: true,
      });
    }

    /*
     * One re-draft when the best is below the floor — AC-4.
     *
     * The second round is told what the first one's critiques were, so it is a re-draft rather than a
     * re-roll. Both rounds' candidates survive into the ranking: the point of the floor is that the
     * user gets a better choice, not a different one, and a second round can easily be worse.
     */
    if ((drafts[0] as ScoredDraft).overall < QUALITY_FLOOR) {
      const avoiding =
        `\n\nA first attempt scored below the bar. What a reviewer said about those drafts — fix these ` +
        `rather than rewording them:\n${drafts.map((draft) => `- ${draft.critique}`).join("\n")}`;
      const second = await score(await write(avoiding));
      drafts = ranked([...drafts, ...second]);
    }

    /*
     * Refine the winner, then keep it only if it actually scored better — AC-2.
     *
     * A model asked to improve something always returns something different. Returning that as "the
     * refined one" without re-scoring is how a quality loop makes captions worse while reporting that
     * it improved them.
     */
    const best = drafts[0] as ScoredDraft;
    const weakest = (Object.entries(best.scores) as [keyof DraftScores, number][]).reduce((low, entry) =>
      entry[1] < low[1] ? entry : low,
    );
    const refinement = await config.generate({
      context,
      system:
        "You improve one social post caption. Change what the critique names and leave everything else " +
        "alone — a rewrite is not a refinement." + (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `${framing}\n\nThe caption:\n${best.caption}\n\nA reviewer scored it ${best.overall.toFixed(1)}/10, ` +
        `weakest on ${weakest[0]} (${weakest[1]}/10): ${best.critique}\n\nRewrite only what that names.`,
      schema: refinementSchema,
    });

    const [rescored] = await score([refinement.caption]);
    if (rescored !== undefined && rescored.overall > best.overall) {
      return ranked([{ ...rescored, refined: true }, ...drafts.slice(1)]);
    }
    // The refinement did not help, so it is discarded rather than shown as an improvement.
    return drafts;
  },
});
