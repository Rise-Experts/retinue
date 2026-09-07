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

import type {
  BrandProfile,
  ContentAngle,
  ContentGenerator,
  GeneratedVariant,
  ValidationIssue,
} from "../../services/index.js";

/** How many angles may be asked for. Beyond a handful they stop being distinct, which is the point of them. */
export const MAX_ANGLES = 6;
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
}) => Promise<T>;

export type GeneratorConfig = {
  readonly generate: StructuredGenerate;
  /** Read once per turn by the caller and passed in — see the header. */
  readonly brand: (context: ExecutionContext) => Promise<BrandProfile>;
};

/** The brand, as prompt text. Absent fields are omitted rather than rendered as "unknown". */
const brandBrief = (profile: BrandProfile): string => {
  const lines = [
    profile.brandName === undefined ? undefined : `Brand: ${profile.brandName}`,
    profile.company === undefined ? undefined : `Company: ${profile.company}`,
    profile.website === undefined ? undefined : `Website: ${profile.website}`,
    profile.audience === undefined ? undefined : `Audience: ${profile.audience}`,
    profile.voice === undefined ? undefined : `Voice: ${profile.voice}`,
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
      prompt: `Brief: ${input.brief}\n\nPropose ${count} distinct angles.`,
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

    const result = await config.generate({
      context,
      system:
        "You write social post captions. Produce one caption per platform named, written for that platform's " +
        "conventions. Do not include the platform name in the caption." +
        (brand === "" ? "" : `\n\n${brand}`),
      prompt:
        `Brief: ${input.brief}` +
        (input.angle === undefined ? "" : `\n\nAngle: ${input.angle.label} — ${input.angle.rationale}`) +
        `\n\nPlatforms: ${platforms.join(", ")}` +
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
});
