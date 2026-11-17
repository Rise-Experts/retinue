/**
 * `generate_content` (#123).
 *
 * The generator stub is scripted per attempt, because every interesting property here is about *what
 * happens across attempts* — how many there are, what the model was told to avoid, and what comes back
 * when it never succeeds. A stub returning one fixed value could not show any of it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  DEFAULT_REPAIR_BOUND,
  DUPLICATE_CONTENT_CODE,
  MAX_ANGLES,
  FORBIDDEN_CLAIM_CODE,
  GENERATE_TOOL_FACTORIES,
  expandFunnelPlan,
  generateCampaignTool,
  researchHashtagsTool,
  GENERATE_TOOL_NAMES,
  captionSimilarity,
  createShareFlowToolProvider,
  findDuplicateContent,
  generateContentTool,
  normaliseCaption,
  evaluateCampaignTool,
  MAX_CAMPAIGN_POSTS,
  MAX_REPURPOSE_PIECES,
  MAX_REPURPOSE_SOURCE_CHARS,
  proposePostAnglesTool,
  repurposeSourceTool,
  suggestCampaignIdeasTool,
  type PlatformId,
  type SearchOutcome,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type ValidationIssue,
  type ValidationReport,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

type Call = {
  readonly platformId: PlatformId;
  readonly avoid: readonly ValidationIssue[];
  /** Sibling hooks, recorded so the campaign tool's anti-duplication can be asserted. */
  readonly avoidHooks?: readonly string[];
  readonly angle?: string;
  /** The funnel slot this post was written for — REQ-018, recorded so the wiring is assertable. */
  readonly step?: { readonly stage: string; readonly angle?: string; readonly cta?: string };
};

type Options = {
  /** Caption per attempt, cycling on the last entry. */
  captions?: readonly string[];
  /** Report from `validateContent`, cycling on the last entry. */
  reports?: readonly ValidationReport[];
  /** Make `generate` return nothing for this angle only. */
  failAngle?: string;
  /** How many angles `proposeAngles` will offer, when fewer than asked for. */
  anglesOffered?: number;
  forbidden?: readonly { phrase: string; reason?: string }[];
  recentExcerpts?: readonly string[];
  emptyGeneration?: boolean;
  /** What the trend search answers with. `undefined` means one ordinary hit. */
  searchOutcome?: SearchOutcome;
  /** What the model proposes as ideas, before the tool's clamping. */
  ideas?: readonly Record<string, unknown>[];
  /** What `deriveHashtags` answers with, before the tool's own reporting. */
  hashtags?: readonly { tag: string; rationale: string }[];
  /** The campaign `evaluate_campaign` reads its theme, goal and dates from. */
  campaign?: Record<string, unknown>;
  /** What `campaignBreakdown` answers with. */
  breakdown?: Record<string, unknown>;
  /** What `repurpose` answers with. */
  pieces?: readonly Record<string, unknown>[];
};

let calls: Call[];
let savedCalls: string[];
/** What `suggestIdeas` was asked for, so the trend hand-off can be asserted rather than assumed. */
let ideaCalls: Record<string, unknown>[];
let searchQueries: string[];
/** What the evaluator was handed, so "the numbers are read, not accepted" is assertable. */
let evaluationCalls: Record<string, unknown>[];
/** What the planner was asked for — the trends block in particular. */
let angleCalls: Record<string, unknown>[];
/** What `repurpose` was handed. */
let repurposeCalls: Record<string, unknown>[];
/** What `deriveHashtags` was handed — the findings in particular. */
let hashtagCalls: Record<string, unknown>[];
/** What `campaignBreakdown` was asked for — the window in particular. */
let breakdownCalls: Record<string, unknown>[];

const services = (o: Options = {}): ShareFlowServices => {
  const captions = o.captions ?? ["A perfectly ordinary post about the new pricing page."];
  const reports = o.reports ?? [{ ok: true, issues: [] }];
  let generateCount = 0;
  let validateCount = 0;
  const at = <T>(list: readonly T[], i: number): T => list[Math.min(i, list.length - 1)] as T;

  return {
    // #499: metered, but unmetered here — these tests are about generation, `compose.test.ts` covers the credits.
    credits: { async reserve() { return { byo: false, metered: false }; }, async charge() { return { charged: 0 }; } },
    projects: { async current() { return null; } },
    generator: {
      async proposeAngles(
        _c: ExecutionContext,
        input: { count: number; brief: string; steps?: readonly { stage: string }[] },
      ) {
        angleCalls.push(input as unknown as Record<string, unknown>);
        /**
         * Labels are unique **across batches**, because the real planner is told what is already
         * covered and this stub stands in for one that listens. A stub returning `angle 1..N` every time
         * would be deduplicated to nothing on the second batch, and the batching loop would look broken
         * when it was working.
         */
        const offset = angleCalls.length - 1;
        return Array.from({ length: o.anglesOffered ?? input.count }, (_, i) => ({
          label: `angle ${offset * 100 + i + 1}`,
          rationale: `because ${i + 1}`,
        }));
      },
      async deriveHashtags(_c: ExecutionContext, input: Record<string, unknown>) {
        hashtagCalls.push(input);
        // Stands in for the adapter, so the normalisation and the ranking are *its* job — asserted
        // against the real adapter in services.test.ts rather than re-implemented here.
        return o.hashtags ?? [{ tag: "#coffee", rationale: "the category" }];
      },
      async repurpose(_c: ExecutionContext, input: Record<string, unknown>) {
        repurposeCalls.push(input);
        // Stands in for the adapter, so the round-robin and the clamp are *its* job — asserted against
        // the real adapter in services.test.ts rather than re-implemented here.
        return (
          o.pieces ?? [
            { angle: "the cost of doing nothing", platformId: "linkedin", caption: "A first piece." },
            { angle: "what changed this year", platformId: "x", caption: "A second piece." },
          ]
        );
      },
      async evaluateCampaign(_c: ExecutionContext, input: Record<string, unknown>) {
        evaluationCalls.push(input);
        // Already trimmed: trimming is the adapter's, and this stub stands in for the adapter.
        return "Post 1 did best. - Try video next time.";
      },
      async suggestIdeas(_c: ExecutionContext, input: Record<string, unknown>) {
        ideaCalls.push(input);
        /**
         * The **adapter's** clamping is not re-implemented here — this stub stands in for the adapter,
         * so it returns what the adapter would return. The clamp itself is tested against the real
         * adapter in `src/adapters/model/__tests__/generator.test.ts`; asserting it twice, once against
         * a stub that performs it, would be a test of the stub.
         */
        return (
          o.ideas ?? [
            { angle: "the price objection", hook: "You are not paying for seats.", cta: "Read the note", format: "text", channels: ["linkedin"] },
          ]
        );
      },
      async generate(
        _c: ExecutionContext,
        input: {
          platformIds: readonly PlatformId[];
          avoid: readonly ValidationIssue[];
          avoidHooks?: readonly string[];
          angle?: { label: string };
          step?: { stage: string; angle?: string; cta?: string };
        },
      ) {
        calls.push({
          platformId: input.platformIds[0] as PlatformId,
          avoid: input.avoid,
          ...(input.avoidHooks === undefined ? {} : { avoidHooks: input.avoidHooks }),
          ...(input.angle === undefined ? {} : { angle: input.angle.label }),
          ...(input.step === undefined ? {} : { step: input.step }),
        });
        if (o.emptyGeneration === true) return [];
        // A named angle that must fail, so the campaign tool's all-or-nothing rule is testable.
        if (o.failAngle !== undefined && input.angle?.label === o.failAngle) return [];
        const caption = at(captions, generateCount);
        generateCount += 1;
        return [{ platformId: input.platformIds[0] as PlatformId, caption }];
      },
    },
    analytics: {
      async campaignBreakdown(_c: ExecutionContext, input: Record<string, unknown>) {
        breakdownCalls.push(input);
        return (
          o.breakdown ?? {
            posts: [
              {
                draftId: asId("d1"),
                excerpt: "the measured post",
                platforms: ["linkedin"],
                publishedDestinations: 2,
                facts: [value("impressions", 1_500), value("likes", 15)],
              },
            ],
            totals: [value("impressions", 1_500), value("likes", 15)],
            freshness: { stale: false, lastRefreshedAt: "2026-09-01T00:00:00.000Z" },
            scoped: false,
          }
        );
      },
    },
    research: {
      async search(_c: ExecutionContext, input: { query: string; maxResults: number }) {
        searchQueries.push(input.query);
        return (
          o.searchOutcome ?? {
            searched: true,
            results: [{ resultId: "r1", title: "Short video wins 2026", snippet: "Vertical video keeps growing.", url: "https://example.com/a" }],
          }
        );
      },
    },
    brand: {
      async getClaimPolicy() {
        return { approved: [], forbidden: o.forbidden ?? [] };
      },
    },
    content: {
      async getCampaign() {
        return (
          o.campaign ?? {
            id: asId("c1"),
            name: "Autumn",
            theme: "sustainable packaging",
            goal: "grow signups",
            startsOn: "2026-08-01",
            endsOn: "2026-08-31",
            channels: ["linkedin"],
          }
        );
      },
      async listDrafts() {
        return {
          items: (o.recentExcerpts ?? []).map((excerpt, i) => ({
            id: asId(`d${i + 1}`),
            excerpt,
            status: "approved",
            captionLength: excerpt.length,
            targetPlatforms: [],
            mediaCount: 0,
            updatedAt: "2026-08-23T00:00:00.000Z",
          })),
        };
      },
      async validateContent() {
        const report = at(reports, validateCount);
        validateCount += 1;
        return report;
      },
      async createDraft() {
        savedCalls.push("createDraft");
        return {};
      },
      async updateDraft() {
        savedCalls.push("updateDraft");
        return {};
      },
    },
  } as unknown as ShareFlowServices;
};

/** A measured fact, in the port's shape. */
const value = (metric: string, v: number, unit: "count" | "fraction" = "count") => ({
  metric,
  unit,
  window: { fromDay: "2026-08-01", toDay: "2026-08-31" },
  value: v,
  derivedFrom: { recordType: "post_metrics", recordCount: 1 },
});

/** The same metric, never measured. Rendering this as `0` is the defect the union exists to prevent. */
const absent = (metric: string, unit: "count" | "fraction" = "count") => ({
  metric,
  unit,
  window: { fromDay: "2026-08-01", toDay: "2026-08-31" },
  unavailable: "not-collected" as const,
});

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, o: Options = {}): Tool =>
  factory.build({ services: services(o), deps: { authorization: allowAll, idempotency } });

const run = (tool: Tool, input: unknown, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

const issue = (over: Partial<ValidationIssue> = {}): ValidationIssue => ({
  code: "too-long",
  message: "too long for this destination",
  repairable: true,
  ...over,
});

beforeEach(() => {
  calls = [];
  savedCalls = [];
  ideaCalls = [];
  searchQueries = [];
  evaluationCalls = [];
  angleCalls = [];
  repurposeCalls = [];
  hashtagCalls = [];
  breakdownCalls = [];
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("per-channel variants", () => {
  it("produces one variant per destination, generated per channel rather than split", async () => {
    const result = await run(build(generateContentTool, {
      captions: ["for linkedin", "for x", "for threads"],
    }), { brief: "the new pricing page", platformIds: ["LinkedIn", "X", "Threads"] });
    expect(result).toMatchObject({
      ok: true,
      data: {
        saved: false,
        variants: [
          { platformId: "linkedin", caption: "for linkedin" },
          { platformId: "x", caption: "for x" },
          { platformId: "threads", caption: "for threads" },
        ],
      },
    });
    // Generated per channel — one call each, each naming its own destination. A blob split afterwards
    // is what AC-1's "by construction" rules out, and it would show here as a single call.
    expect(calls.map((c) => c.platformId)).toEqual(["linkedin", "x", "threads"]);
  });

  it("validates each variant against its own destination only", async () => {
    // A caption legal for LinkedIn and too long for X must be judged separately, or the shorter
    // destination drags down the longer one.
    await run(build(generateContentTool), { brief: "b", platformIds: ["linkedin", "x"] });
    expect(calls).toHaveLength(2);
  });

  it("does not ask for more channels than a single request should carry", async () => {
    const tool = build(generateContentTool);
    expect(await run(tool, { brief: "b", platformIds: Array(11).fill("x") })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(calls).toEqual([]);
  });
});

/** AC-2. */
describe("bounded repair", () => {
  it("repairs a repairable failure and returns the fixed version", async () => {
    const result = await run(
      build(generateContentTool, {
        captions: ["too long", "just right"],
        reports: [{ ok: false, issues: [issue()] }, { ok: true, issues: [] }],
      }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { variants: [{ caption: "just right", attempts: 2 }] },
    });
  });

  it("tells the model what to change rather than asking it to try again", async () => {
    await run(
      build(generateContentTool, {
        captions: ["too long", "just right"],
        reports: [{ ok: false, issues: [issue({ message: "over the limit for linkedin" })] }, { ok: true, issues: [] }],
      }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(calls[0]?.avoid).toEqual([]);
    // The findings from the previous attempt. "Try again" wastes the attempt.
    expect(calls[1]?.avoid).toEqual([expect.objectContaining({ message: "over the limit for linkedin" })]);
  });

  it("stops at exactly the bound, and the bound cannot be exceeded", async () => {
    // An always-failing validator. The counter is local to the call and nothing resets it, so the bound
    // holds by construction rather than by every caller remembering.
    const result = await run(
      build(generateContentTool, { reports: [{ ok: false, issues: [issue()] }] }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(result.ok).toBe(false);
    // bound + 1: the first attempt is not a repair.
    expect(calls).toHaveLength(DEFAULT_REPAIR_BOUND + 1);
  });

  it("honours a lower bound, including zero", async () => {
    await run(build(generateContentTool, { reports: [{ ok: false, issues: [issue()] }] }), {
      brief: "b",
      platformIds: ["linkedin"],
      repairBound: 0,
    });
    // No repair at all: one attempt, then report.
    expect(calls).toHaveLength(1);
  });

  it("refuses a bound high enough to be a search for a phrasing that slips past", async () => {
    // Capped rather than unbounded, for the reason on `DEFAULT_REPAIR_BOUND`: on a forbidden claim a model
    // asked repeatedly produces near-variants of the same claim.
    expect(await run(build(generateContentTool), { brief: "b", platformIds: ["x"], repairBound: 10 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(calls).toEqual([]);
  });

  it("does not spend attempts on a finding the model cannot fix", async () => {
    await run(
      build(generateContentTool, { reports: [{ ok: false, issues: [issue({ repairable: false })] }] }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    // One attempt. Regenerating on an unrepairable finding arrives at the same answer more expensively.
    expect(calls).toHaveLength(1);
  });
});

/** AC-3 and AC-6. */
describe("nothing is saved", () => {
  it("saves nothing on success", async () => {
    const result = await run(build(generateContentTool), { brief: "b", platformIds: ["linkedin"] });
    expect(result).toMatchObject({ ok: true, data: { saved: false } });
    expect(savedCalls).toEqual([]);
  });

  it("saves nothing on failure either, and reports the specific reason", async () => {
    const result = await run(
      build(generateContentTool, {
        reports: [{ ok: false, issues: [issue({ code: "media-kind-unsupported", repairable: false, message: "LinkedIn does not accept video" })] }],
      }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        details: {
          failures: [
            { platformId: "linkedin", attempts: 1, issues: [{ code: "media-kind-unsupported", repairable: false }] },
          ],
        },
      },
    });
    expect(savedCalls).toEqual([]);
  });

  it("reports a generator that returned nothing rather than an empty draft", async () => {
    const result = await run(build(generateContentTool, { emptyGeneration: true }), {
      brief: "b",
      platformIds: ["linkedin"],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { details: { failures: [{ issues: [{ code: "generation-empty" }] }] } },
    });
  });

  it("references no write method anywhere in the module", () => {
    // Structural half of AC-6. The factory receives the whole service object, so "never saves" is a
    // discipline rather than a type constraint — this is what makes it checkable.
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../generate.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const writer of ["createDraft", "updateDraft", "duplicateDraft", "schedule", "attachToDraft"]) {
      expect(source, writer).not.toContain(writer);
    }
  });

  it("classifies both capabilities as reads", () => {
    for (const factory of GENERATE_TOOL_FACTORIES) {
      const { descriptor } = build(factory);
      expect(descriptor.effect, descriptor.name).toBe("read");
      expect(descriptor.approvalPolicy, descriptor.name).toBe("never");
    }
  });

  it("reports a partial result as partial", async () => {
    // Two destinations, one writable. One channel failing must not lose the other, and the failure must
    // still be visible rather than dropped to make the result look clean.
    const result = await run(
      build(generateContentTool, {
        captions: ["fine for linkedin", "bad for x", "bad for x", "bad for x"],
        reports: [{ ok: true, issues: [] }, { ok: false, issues: [issue({ repairable: false })] }],
      }),
      { brief: "b", platformIds: ["linkedin", "x"] },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        variants: [{ platformId: "linkedin" }],
        failed: [{ platformId: "x" }],
      },
    });
  });
});

/** AC-4. */
describe("forbidden claims", () => {
  const forbidden = [{ phrase: "clinically proven", reason: "not cleared by legal" }];

  it("never returns one, even when the generator keeps producing it", async () => {
    const result = await run(
      build(generateContentTool, { captions: ["It is clinically proven."], forbidden }),
      { brief: "say it is clinically proven", platformIds: ["linkedin"] },
    );
    expect(result.ok).toBe(false);
    // The phrase must not survive into the refusal payload either — the reason travels, the claim does
    // not need to be repeated back as content.
    const failures = (result as unknown as { error: { details: { failures: { issues: { code: string }[] }[] } } }).error.details
      .failures;
    expect(failures[0]?.issues.some((i) => i.code === FORBIDDEN_CLAIM_CODE)).toBe(true);
  });

  it("treats a forbidden claim as unrepairable, so it is not retried into a near-variant", async () => {
    await run(build(generateContentTool, { captions: ["It is clinically proven."], forbidden }), {
      brief: "b",
      platformIds: ["linkedin"],
    });
    // One attempt. Asking again is a search for a phrasing that slips past the checker.
    expect(calls).toHaveLength(1);
  });

  it("returns content that avoids the claim", async () => {
    const result = await run(
      build(generateContentTool, { captions: ["Independently tested and published."], forbidden }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(result).toMatchObject({ ok: true, data: { variants: [{ caption: "Independently tested and published." }] } });
  });
});

/** AC-5. */
describe("duplication against recent posts", () => {
  it("normalises away the differences a duplicate post has", () => {
    expect(normaliseCaption("Shipping the NEW pricing page! 🚀")).toBe("shipping the new pricing page");
    expect(captionSimilarity("Shipping the new pricing page.", "shipping the NEW pricing page!")).toBe(1);
  });

  it("catches a rewrite that keeps the body", () => {
    const a = "We rebuilt the pricing page from scratch and it is now three times faster to load";
    const b = "Big news today: we rebuilt the pricing page from scratch and it is now three times faster to load";
    expect(captionSimilarity(a, b)).toBeGreaterThan(0.6);
  });

  it("does not flag two posts merely about the same thing", () => {
    const a = "Our new pricing page is live today.";
    const b = "Pricing has changed; read why we simplified the tiers and what it means for you.";
    expect(captionSimilarity(a, b)).toBeLessThan(0.6);
  });

  it("still catches an identical short caption, via the exact-match check", () => {
    // Shorter than the shingle window, so shingling contributes nothing — the exact-match check is what
    // decides these. The first version of this had a special case in `shingles` for short captions and
    // this test claimed to cover it; sabotage showed the branch was unreachable, because every case it
    // handled was already decided here or produced the same zero. The branch is gone and this test now
    // says which check is doing the work.
    expect(captionSimilarity("we shipped", "We shipped!")).toBe(1);
    expect(captionSimilarity("we shipped", "we hired")).toBe(0);
  });

  it("names the post it duplicates, and treats it as repairable", () => {
    const issues = findDuplicateContent("we shipped the pricing page", [
      { postDraftId: "d7", caption: "We shipped the pricing page!" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(DUPLICATE_CONTENT_CODE);
    expect(issues[0]?.message).toContain("d7");
    // Repairable, unlike a forbidden claim: a duplicate is a writing problem, and rewriting it is what a
    // repair attempt is for. Refusing outright sends the user back to ask for the same thing differently.
    expect(issues[0]?.repairable).toBe(true);
  });

  it("does not report a similarity number that implies precision it lacks", () => {
    const issues = findDuplicateContent("we shipped the pricing page", [
      { postDraftId: "d7", caption: "We shipped the pricing page!" },
    ]);
    expect(issues[0]?.message).not.toMatch(/0\.\d/);
  });

  it("repairs a duplicate rather than refusing it", async () => {
    const result = await run(
      build(generateContentTool, {
        captions: ["We shipped the pricing page", "A different take on the pricing work"],
        recentExcerpts: ["We shipped the pricing page!"],
      }),
      { brief: "b", platformIds: ["linkedin"] },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { variants: [{ caption: "A different take on the pricing work", attempts: 2 }] },
    });
  });

  it("fetches recent posts once, not once per attempt", async () => {
    // Through the port that already exists, and outside the loop: three attempts must not be three
    // queries for the same list.
    let listCalls = 0;
    const s = services({ reports: [{ ok: false, issues: [issue()] }] });
    const patched = {
      ...s,
      content: {
        ...s.content,
        async listDrafts(...args: never[]) {
          listCalls += 1;
          return (s.content.listDrafts as (...a: never[]) => Promise<never>)(...args);
        },
      },
    } as unknown as ShareFlowServices;
    const tool = generateContentTool.build({ services: patched, deps: { authorization: allowAll, idempotency } });
    await run(tool, { brief: "b", platformIds: ["linkedin"] });
    expect(calls).toHaveLength(DEFAULT_REPAIR_BOUND + 1);
    expect(listCalls).toBe(1);
  });
});

describe("angles", () => {
  it("proposes several, because one is not a choice", async () => {
    const result = await run(build(proposePostAnglesTool), { brief: "the new pricing page" });
    expect(result).toMatchObject({ ok: true, data: { angles: [{ label: "angle 1" }, { label: "angle 2" }, { label: "angle 3" }] } });
  });

  it("refuses a single angle", async () => {
    // docs/07 step 5 is "select or present an angle", which needs something to select between.
    expect(await run(build(proposePostAnglesTool), { brief: "b", count: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("passes a chosen angle into generation", async () => {
    await run(build(generateContentTool), {
      brief: "b",
      platformIds: ["linkedin"],
      angle: { label: "cost", rationale: "price is the objection" },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("catalog and delegation", () => {
  it("names the port method each capability calls", () => {
    expect(GENERATE_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["propose_post_angles", "ContentGenerator.proposeAngles"],
      ["generate_content", "ContentGenerator.generate"],
      // A separate port method, because alternatives-for-one-destination and one-version-per-destination
      // are opposite things — the confusion is what made `/api/ai/generate`'s `variants: N` a refusal.
      ["generate_alternatives", "ContentGenerator.draftAlternatives"],
      // The search is `ResearchService`'s; the ranking is the generator's, which is what it delegates.
      ["research_hashtags", "ContentGenerator.deriveHashtags"],
      // The campaign tool calls `generate` once per post, so it delegates to the same port method —
      // the composition is this tool's, not the generator's.
      ["generate_campaign", "ContentGenerator.generate"],
      ["suggest_campaign_ideas", "ContentGenerator.suggestIdeas"],
      // The numbers come from `AnalyticsService`; the prose is the generator's, which is what it delegates.
      ["evaluate_campaign", "ContentGenerator.evaluateCampaign"],
      ["repurpose_source", "ContentGenerator.repurpose"],
      // Its own port method: N captions and a set of different KINDS are different asks, and a caller
      // that confused them would read `caption` off a script — #458.
      ["repurpose_to_formats", "ContentGenerator.repurposeToFormats"],
    ]);
  });

  it("registers each capability under what it is about, not where it lives", async () => {
    /**
     * This asserted `posts` for everything in this module, on the reasoning that "a generated variant
     * is a post". `generate_campaign` broke that generalisation rather than the rule: it lives here
     * because it composes the generator's ports, and it is *about* a campaign — which is what a
     * category is for, since `AgentManifest.categories` is how a deployment narrows its tool surface.
     * A deployment that wanted campaigns would otherwise have to take `posts` to get this one.
     *
     * So the expectation is now per tool. Both facts, rather than one that covers most of them.
     */
    const provider = createShareFlowToolProvider({
      services: services(),
      deps: { authorization: allowAll, idempotency },
      factories: GENERATE_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...GENERATE_TOOL_NAMES]);
    expect(descriptors.map((d) => [d.name, d.category])).toEqual([
      ["propose_post_angles", "posts"],
      ["generate_content", "posts"],
      // Also `posts`: a person choosing between three captions is composing a post, not running a campaign.
      ["generate_alternatives", "posts"],
      // `posts`: hashtags belong to whatever is being written, campaign or not.
      ["research_hashtags", "posts"],
      ["generate_campaign", "campaigns"],
      // Advisory, and about a campaign — the same reasoning as `generate_campaign`.
      ["suggest_campaign_ideas", "campaigns"],
      ["evaluate_campaign", "campaigns"],
      /**
       * `posts`, not a category of its own. Repurposing is a way of authoring posts — there is no
       * `repurposes` table and no repurpose object in the product, which is what earned `campaigns` its
       * own category.
       */
      ["repurpose_source", "posts"],
      // `posts`: the set is mostly posts, and a script is what you make one from.
      ["repurpose_to_formats", "posts"],
    ]);
  });

  it("refuses before the generator is called when the policy says no", async () => {
    const tool = generateContentTool.build({
      services: services(),
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    expect(await run(tool, { brief: "b", platformIds: ["linkedin"] })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("suggest_campaign_ideas", () => {
  /**
   * The advisory half of the campaign cluster — `route:POST /campaign/suggest`. It writes nothing, and
   * the one property worth guarding is **honesty about grounding**: the old runtime simply omitted the
   * trends block when its search came back empty, so an idea invented from nothing looked exactly like
   * one grounded in a live search.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = suggestCampaignIdeasTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { theme: "sustainable packaging", count: 3, ...input },
      idempotencyKey: "k1",
    });
  };

  it("searches for trends with the old runtime's query and hands the findings to the generator", async () => {
    const result = await run();
    // Transcribed from `ai_backend/app/campaign.py`: `search_web(f"{theme} social media trends", 5)`.
    expect(searchQueries).toEqual(["sustainable packaging social media trends"]);
    expect(ideaCalls[0]?.["trends"]).toEqual([
      { title: "Short video wins 2026", snippet: "Vertical video keeps growing." },
    ]);
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: true } });
  });

  it("says so when it could not search, and still suggests", async () => {
    /**
     * Both halves matter. Refusing would make an unconfigured search look like a broken feature, and
     * reporting `trendGrounded: true` would present the model's own priors as findings about the world.
     */
    const result = await run({ searchOutcome: { searched: false, reason: "not-configured" } });
    expect(result).toMatchObject({
      ok: true,
      data: { trendGrounded: false, trendReason: "not-configured" },
    });
    expect((result as { data: { ideas: readonly unknown[] } }).data.ideas).toHaveLength(1);
    // Nothing to ground on was passed as nothing, not as a fabricated placeholder.
    expect(ideaCalls[0]?.["trends"]).toEqual([]);
  });

  it("does not claim grounding for a search that ran and found nothing", async () => {
    /**
     * `searched: true, results: []` is a real answer and it grounds nothing. This is the case the flag
     * would get wrong if it merely echoed `outcome.searched`, and there is no reason to report — the
     * search worked.
     */
    const result = await run({ searchOutcome: { searched: true, results: [] } });
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: false } });
    expect((result as { data: Record<string, unknown> }).data["trendReason"]).toBeUndefined();
  });

  it("passes the workspace's channels through for the adapter to filter against", async () => {
    await run({}, { channels: ["LinkedIn", "X"] });
    // Normalised by `platformList`, which is what the adapter's filter compares against.
    expect(ideaCalls[0]?.["channels"]).toEqual(["linkedin", "x"]);
  });

  it("treats an absent channel list as no restriction rather than no channels", async () => {
    /**
     * A caller that has not resolved the workspace's accounts should get ideas. `[]` reaching the
     * adapter means "unrestricted" there — see its filter — so an empty answer would be the wrong
     * reading of a missing argument.
     */
    const result = await run();
    expect(ideaCalls[0]?.["channels"]).toEqual([]);
    expect(result).toMatchObject({ ok: true });
  });

  it("saves nothing", async () => {
    // Advisory: `effect: "read"`. A tool that drafted while suggesting would fill the library with
    // posts nobody chose.
    await run();
    expect(savedCalls).toEqual([]);
  });

  it("refuses more ideas than the planner will offer, and an unknown field", async () => {
    expect(await run({}, { count: MAX_ANGLES + 1 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await run({}, { tone: "breezy" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // Refused before either service was touched.
    expect(searchQueries).toEqual([]);
    expect(ideaCalls).toEqual([]);
  });
});



describe("generate_campaign, longer than one planner call", () => {
  /**
   * `postCountFor` produces up to 31 posts — *"so a runaway date range can't fan out an absurd
   * sequence"* — and `proposeAngles` offers at most 6 in one call. The tool was capped at 6, which made
   * it refuse a campaign the product can create; it asks in batches now.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = generateCampaignTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { theme: "sustainable packaging", platformIds: ["linkedin"], postCount: 2, ...input },
      idempotencyKey: "k1",
    });
  };

  it("plans a 31-post campaign in batches of six", async () => {
    const result = await run({}, { postCount: 31 });
    expect(result).toMatchObject({ ok: true, data: { postCount: 31 } });
    // 6 + 6 + 6 + 6 + 6 + 1 — the last batch asks only for what is left.
    expect(angleCalls.map((call) => call["count"])).toEqual([6, 6, 6, 6, 6, 1]);
    expect(calls).toHaveLength(31);
  });

  it("tells each batch which angles are already covered", async () => {
    /**
     * `proposeAngles` has no `avoid` parameter, so the exclusion travels in the brief — named as angles
     * *already covered* rather than as a rejection, the same distinction `avoidHooks` draws.
     */
    await run({}, { postCount: 8 });
    expect(String(angleCalls[0]?.["brief"])).not.toContain("already covered");
    const second = String(angleCalls[1]?.["brief"]);
    expect(second).toContain("Angles already covered by earlier posts");
    expect(second).toContain("- angle 1");
  });

  it("stops asking when a theme has run out of angles, and refuses rather than shrinking", async () => {
    /**
     * Two guarantees in one: the loop cannot spin forever on a theme with nothing left, and a campaign
     * short of what was asked for is a refusal — *"writing four posts for a five-post request would be
     * the partial campaign the old runtime decided against."*
     */
    const result = await run({ anglesOffered: 0 }, { postCount: 10 });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
    expect(angleCalls).toHaveLength(1);
  });

  it("refuses more posts than the product can create", async () => {
    // 31 is ShareFlow's own ceiling, not a number chosen here.
    expect(await run({}, { postCount: MAX_CAMPAIGN_POSTS + 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("research_hashtags — REQ-016 AC-2", () => {
  /**
   * The clause #287 left. *"Research + relevance-rank hashtags (search-backed)"*, with REQ-016 AC-5's
   * graceful fallback when research is unavailable — and graceful means **saying so**, because a list
   * that came from the model alone looks exactly like one that came from a live search.
   */
  /*
   * A fresh idempotency key per call. The two-call test below would otherwise get the *cached* result
   * of the first — and pass or fail on the cache rather than on the tool.
   */
  let key = 0;
  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = researchHashtagsTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    key += 1;
    return tool.execute({
      context: CONTEXT,
      input: { topic: "single-origin filter coffee", ...input },
      idempotencyKey: `hashtags-${key}`,
    });
  };

  it("searches by default, unlike the campaign planner", async () => {
    /*
     * The defaults differ because the acceptances do: a campaign is worth planning without a live
     * search, and a hashtag list that was not researched is the thing AC-2 exists to replace.
     */
    const result = await run();
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: true } });
    expect(searchQueries).toEqual(["single-origin filter coffee"]);
  });

  it("hands the findings to the generator rather than letting it search", async () => {
    // Searching is `ResearchService`'s job; a generator that reached for the web would be a second
    // place the egress policy lived.
    await run();
    expect((hashtagCalls[0]?.["findings"] as readonly unknown[])?.length).toBeGreaterThan(0);
  });

  it("reports an ungrounded run as ungrounded, and says why", async () => {
    /**
     * AC-5's graceful fallback. `ResearchService.search` reports *whether it searched* — that is the
     * whole point of the port — and the tool carries it through, along with the reason, so an
     * assistant can say "these are not search-backed" rather than implying they are.
     */
    const result = (await run({ searchOutcome: { searched: false, reason: "not-configured" } })) as {
      data: { trendGrounded: boolean; trendReason?: string; hashtags: readonly unknown[] };
    };
    expect(result.data.trendGrounded).toBe(false);
    expect(result.data.trendReason).toBe("not-configured");
    // And it still answers: a list from the model alone is worth having, as long as it says so.
    expect(result.data.hashtags.length).toBeGreaterThan(0);
    expect((hashtagCalls[0]?.["findings"] as readonly unknown[])).toEqual([]);
  });

  it("says nothing about grounding when no search was asked for", async () => {
    /*
     * `false` there would read as a failed search rather than one nobody requested — the same
     * distinction `generate_campaign` draws with `researchFirst`.
     */
    const result = (await run({}, { research: false })) as { data: Record<string, unknown> };
    expect(result.data).not.toHaveProperty("trendGrounded");
    expect(searchQueries).toEqual([]);
  });

  it("reports grounding as false when the search ran and found nothing", async () => {
    // Searched-and-empty is not the same as never-searched, and neither is grounded.
    const result = (await run({ searchOutcome: { searched: true, results: [] } })) as {
      data: { trendGrounded: boolean };
    };
    expect(result.data.trendGrounded).toBe(false);
  });

  it("passes the platform through when one was named, and omits it otherwise", async () => {
    await run({}, { platformId: "instagram" });
    expect(hashtagCalls[0]?.["platformId"]).toBe("instagram");
    hashtagCalls.length = 0;
    await run();
    expect(hashtagCalls[0]).not.toHaveProperty("platformId");
  });

  it("searches the topic alone, not a long structured prompt", async () => {
    // The campaign planner's research pass records the reason: a 4,000-character brief makes a
    // useless search query.
    await run({}, { topic: "  the spring lot  " });
    expect(searchQueries).toEqual(["the spring lot"]);
  });

  it("refuses more than any platform accepts, and an unknown field", async () => {
    expect(await run({}, { count: 31 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await run({}, { tone: "breezy" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(searchQueries).toEqual([]);
    expect(hashtagCalls).toEqual([]);
  });

  it("saves nothing", async () => {
    await run();
    expect(savedCalls).toEqual([]);
  });
});

describe("generate_campaign, shaped by a funnel plan — REQ-018", () => {
  /**
   * The thing that made a campaign a *plan* rather than a batch.
   *
   * Every part of this existed and none of it was connected: `campaigns.persona`, `primary_goal` and
   * `template_key` were written by the create form, `campaign_templates.post_plan` held three real
   * playbooks with a stage per slot, and `posts.funnel_stage` had a CHECK constraint waiting for a
   * value. The planner had no parameter for any of it, so both callers **refused** a request carrying
   * a strategy rather than returning a plan with every stage null — an honest refusal, and a feature
   * that could not be used.
   */
  const PLAN = [
    { stage: "awareness" as const, angle: "Tease the problem you solve", cta: "Follow for the reveal" },
    { stage: "consideration" as const, angle: "Key benefit deep-dive" },
    { stage: "conversion" as const, cta: "Claim it now" },
  ];

  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = generateCampaignTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { theme: "sustainable packaging", platformIds: ["linkedin"], postCount: 3, ...input },
      idempotencyKey: "k1",
    });
  };

  it("writes each post for its own stage, in the plan's order", async () => {
    const result = await run({}, { strategy: { funnelPlan: PLAN } });
    expect(result).toMatchObject({ ok: true });
    expect(calls.map((call) => call.step?.stage)).toEqual(["awareness", "consideration", "conversion"]);
  });

  it("returns the stage per post, which is what the caller stores", async () => {
    /**
     * The whole chain's payload. `posts.funnel_stage` has three write sites in the app and all three
     * read this field; before REQ-018 they read a property nothing ever set.
     */
    const result = (await run({}, { strategy: { funnelPlan: PLAN } })) as {
      data: { posts: readonly { funnelStage?: string }[] };
    };
    expect(result.data.posts.map((post) => post.funnelStage)).toEqual(["awareness", "consideration", "conversion"]);
  });

  it("omits the stage entirely when no plan was given, rather than reporting null", async () => {
    /*
     * A `funnelStage: null` present on every post of an unplanned campaign is the shape that let this
     * layer look finished while doing nothing. Absent says "not planned"; null says "planned, no stage".
     */
    const result = (await run()) as { data: { posts: readonly Record<string, unknown>[] } };
    for (const post of result.data.posts) expect(post).not.toHaveProperty("funnelStage");
    expect(calls.every((call) => call.step === undefined)).toBe(true);
  });

  it("carries the playbook's angle and CTA to the post they belong to, and only there", async () => {
    // A template is chosen *for* its wording. Handing slot 1's CTA to slot 3 would be worse than none.
    await run({}, { strategy: { funnelPlan: PLAN } });
    expect(calls[0]?.step).toMatchObject({ angle: "Tease the problem you solve", cta: "Follow for the reveal" });
    expect(calls[1]?.step).toMatchObject({ angle: "Key benefit deep-dive" });
    expect(calls[1]?.step).not.toHaveProperty("cta");
    expect(calls[2]?.step).toMatchObject({ cta: "Claim it now" });
    expect(calls[2]?.step).not.toHaveProperty("angle");
  });

  it("shows the planner the sequence, so the angles differ by job and not only by wording", async () => {
    /**
     * AC-3 is about the *sequence*, and the sequence is decided when the angles are proposed. Passing
     * the stage only to `generate` would write three conversion captions for three angles that were
     * all planned as openers.
     */
    await run({}, { strategy: { funnelPlan: PLAN } });
    expect(angleCalls[0]?.["steps"]).toEqual(PLAN);
  });

  it("gives each batch its own slice of the plan", async () => {
    /**
     * The loop asks for six angles at a time. Batch two plans posts 7-12 and must see *those* slots —
     * handed the whole plan it would propose a second awareness opener for a campaign already past it.
     *
     * Nine posts over a three-step plan: batch one is slots 1-6, batch two slots 7-9.
     */
    await run({}, { postCount: 9, strategy: { funnelPlan: PLAN } });
    const first = angleCalls[0]?.["steps"] as readonly { stage: string }[];
    const second = angleCalls[1]?.["steps"] as readonly { stage: string }[];
    expect(first).toHaveLength(6);
    expect(second).toHaveLength(3);
    // Contiguous and in order: the second batch continues where the first stopped.
    expect([...first, ...second].map((step) => step.stage)).toEqual(
      calls.map((call) => call.step?.stage),
    );
  });

  it("frames every post with the audience and the campaign goal", async () => {
    /*
     * Campaign-wide, so they travel in the brief rather than per slot — the same call `goal` makes.
     * Asserted on the *planner's* brief because that is where the sequence is decided.
     */
    await run({}, { strategy: { audience: "operations leads at mid-size 3PLs", primaryGoal: "conversion" } });
    const brief = String(angleCalls[0]?.["brief"]);
    expect(brief).toContain("Audience: operations leads at mid-size 3PLs");
    expect(brief).toContain("Campaign goal: conversion");
  });

  it("keeps the campaign's own goal alongside the funnel goal", async () => {
    // `campaigns.goal` is free text and `primary_goal` is the funnel outcome. They are not synonyms,
    // and a model shown both writes to both.
    await run({}, { goal: "book 40 demos", strategy: { primaryGoal: "conversion" } });
    const brief = String(angleCalls[0]?.["brief"]);
    expect(brief).toContain("Campaign goal: conversion");
    expect(brief).toContain("Goal: book 40 demos");
  });

  it("refuses a stage the posts table would reject", async () => {
    /*
     * The column's CHECK constraint is the vocabulary. A stage that passes here and fails on insert
     * would lose a whole generated campaign at the last step, after the model calls were paid for.
     */
    expect(await run({}, { strategy: { funnelPlan: [{ stage: "loyalty" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(angleCalls).toEqual([]);
  });

  it("accepts retention, because the column does", async () => {
    // REQ-018 names three stages; `posts_funnel_stage_check` admits four. The store is the authority.
    const result = await run({}, { postCount: 2, strategy: { funnelPlan: [{ stage: "consideration" }, { stage: "retention" }] } });
    expect(result).toMatchObject({ ok: true });
    expect(calls.map((call) => call.step?.stage)).toEqual(["consideration", "retention"]);
  });

  it("refuses an unknown strategy field rather than ignoring it", async () => {
    // `.strict()`, so a caller that misspells `funnelPlan` is told instead of silently getting no plan.
    expect(await run({}, { strategy: { funnel_plan: PLAN } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("expandFunnelPlan — a plan is a shape, not a length", () => {
  /**
   * The reconciliation nothing else can do. `campaign_templates.post_plan` has six steps because that
   * is how a product launch goes; `postCountFor(startsOn, endsOn, cadence)` has twelve because the
   * user picked three weeks of daily. Neither number is wrong and they will rarely match.
   */
  const stages = (plan: readonly { stage: string }[], n: number) =>
    expandFunnelPlan(plan as never, n).map((step) => step.stage);

  const LAUNCH = [
    { stage: "awareness" as const },
    { stage: "awareness" as const },
    { stage: "consideration" as const },
    { stage: "consideration" as const },
    { stage: "conversion" as const },
    { stage: "conversion" as const },
  ];

  it("is the identity when the plan and the campaign are the same length", () => {
    expect(expandFunnelPlan(LAUNCH, 6)).toEqual(LAUNCH);
  });

  it("always ends on the plan's last step, however few posts there are", () => {
    /**
     * The bug this formula exists to avoid. `floor(i * len / n)` — the obvious mapping — samples
     * 0, 2, 4 from a six-step plan for three posts, which is fine here and silently drops the ending
     * whenever the last step is the only one of its stage. A launch campaign that never asks for the
     * sale looks exactly like one that does.
     */
    const ONE_CLOSER = [
      { stage: "awareness" as const },
      { stage: "awareness" as const },
      { stage: "consideration" as const },
      { stage: "conversion" as const },
    ];
    for (let n = 2; n <= 8; n += 1) {
      expect(stages(ONE_CLOSER, n).at(-1)).toBe("conversion");
      expect(stages(ONE_CLOSER, n)[0]).toBe("awareness");
    }
  });

  it("never moves backwards through the funnel", () => {
    // A campaign that asks for the sale and then goes back to teasing is not a sequence.
    const order = ["awareness", "consideration", "conversion", "retention"];
    for (let n = 2; n <= 31; n += 1) {
      const seen = stages(LAUNCH, n).map((stage) => order.indexOf(stage));
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    }
  });

  it("returns exactly the number of posts asked for, at every length", () => {
    for (let n = 1; n <= 31; n += 1) expect(expandFunnelPlan(LAUNCH, n)).toHaveLength(n);
  });

  it("repeats interior steps when a campaign is longer than its playbook", () => {
    // Three consideration posts on different angles is a normal campaign; the angles are what differ.
    const long = stages(LAUNCH, 12);
    expect(long).toHaveLength(12);
    expect(new Set(long)).toEqual(new Set(["awareness", "consideration", "conversion"]));
  });

  it("gives a one-post campaign the closer, not the teaser", () => {
    // Unreachable from the tool (postCount >= 2) — the answer a caller deserves if it ever is.
    expect(stages(LAUNCH, 1)).toEqual(["conversion"]);
  });

  it("is total: an empty plan or a non-positive count returns nothing", () => {
    expect(expandFunnelPlan([], 5)).toEqual([]);
    expect(expandFunnelPlan(LAUNCH, 0)).toEqual([]);
    expect(expandFunnelPlan(LAUNCH, -1)).toEqual([]);
  });
});

describe("generate_campaign, planned from a live search", () => {
  /**
   * The substance of `route:POST /campaign/agent`, without the sub-agent.
   *
   * The old route ran an autonomous Agno agent with `web_search` and `capture_website` under a 15-call
   * limit. What is reproduced is the **grounding**; the autonomy belongs to the conversation, because a
   * sub-agent inside a tool runs a tool budget the caller cannot see, keeps its searches out of the
   * transcript, and sits outside the approval gate.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = generateCampaignTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { theme: "sustainable packaging", postCount: 2, platformIds: ["linkedin"], ...input },
      idempotencyKey: "k1",
    });
  };

  it("does not search unless asked", async () => {
    // The round trip costs time and a search quota, and an evergreen theme does not need it. The old
    // runtime kept the grounded path on its own endpoint for the same reason.
    const result = await run();
    expect(searchQueries).toEqual([]);
    expect(result).toMatchObject({ ok: true });
    // And it says nothing about grounding, because nobody asked — `false` would read as a failed search.
    expect((result as { data: Record<string, unknown> }).data["trendGrounded"]).toBeUndefined();
  });

  it("searches the theme alone, not the whole brief", async () => {
    /**
     * The old per-post researcher's own comment: *"Compact query for the researcher's trend search —
     * theme + this post's angle, not the long structured expansion prompt."* A four-thousand-character
     * brief makes a useless query.
     */
    await run({}, { researchFirst: true, brief: "a".repeat(500) });
    expect(searchQueries).toEqual(["sustainable packaging"]);
  });

  it("plans from what it found, and says the plan is grounded", async () => {
    const result = await run({}, { researchFirst: true });
    expect(angleCalls[0]?.["trends"]).toEqual([
      { title: "Short video wins 2026", snippet: "Vertical video keeps growing." },
    ]);
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: true } });
  });

  it("still plans when the search could not run, and does not claim grounding", async () => {
    const result = await run({ searchOutcome: { searched: false, reason: "timed-out" } }, { researchFirst: true });
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: false, trendReason: "timed-out" } });
    // Nothing to ground on reaches the planner as nothing, not as an empty findings heading.
    expect("trends" in (angleCalls[0] ?? {})).toBe(false);
    // The campaign was still written — a failed search is not a failed campaign.
    expect((result as { data: { posts: readonly unknown[] } }).data.posts).toHaveLength(2);
  });

  it("does not claim grounding for a search that found nothing", async () => {
    const result = await run({ searchOutcome: { searched: true, results: [] } }, { researchFirst: true });
    expect(result).toMatchObject({ ok: true, data: { trendGrounded: false } });
    expect((result as { data: Record<string, unknown> }).data["trendReason"]).toBeUndefined();
  });
});


describe("repurpose_source", () => {
  /**
   * One source, several posts — and the properties worth guarding are what the old engine did *not*
   * report: whether the model saw the whole source, and whether it produced as many pieces as asked.
   */
  /**
   * `key` is a parameter, and it has to be.
   *
   * The envelope caches a *successful* result under its idempotency key, so two calls in one test with
   * the same key return the first answer — which is correct behaviour and cost an hour to see: the
   * truncation test below asserted two different sources and got the first one's verdict twice.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}, key = "k1") => {
    const tool = repurposeSourceTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { sourceText: "A long article about refill schemes.", platformIds: ["linkedin", "x"], count: 2, ...input },
      idempotencyKey: key,
    });
  };

  it("hands the source and the destinations to the generator in one call", async () => {
    const result = await run();
    expect(repurposeCalls).toHaveLength(1);
    expect(repurposeCalls[0]).toMatchObject({ count: 2, platformIds: ["linkedin", "x"] });
    expect(result).toMatchObject({ ok: true, data: { requested: 2 } });
  });

  it("defaults to three pieces, which is what the old engine did", async () => {
    await run({}, { count: undefined });
    expect(repurposeCalls[0]?.["count"]).toBe(3);
  });

  it("says when the model did not see the whole source", async () => {
    /**
     * The old engine truncated at 6,000 characters silently, so a set of posts drawn from the first
     * fifth of a transcript was indistinguishable from one drawn from all of it. Same reason `read_pdf`
     * reports `truncated`: *"do not describe it as complete."*
     */
    const long = await run({}, { sourceText: "x".repeat(MAX_REPURPOSE_SOURCE_CHARS + 1) }, "long");
    expect(long).toMatchObject({ ok: true, data: { truncatedSource: true } });

    // Exactly at the cap is not truncated — an off-by-one here reads as "incomplete" on a source the
    // model saw in full. Under its own key, or the envelope answers with the result above.
    const short = await run({}, { sourceText: "x".repeat(MAX_REPURPOSE_SOURCE_CHARS) }, "short");
    expect(short).toMatchObject({ ok: true, data: { truncatedSource: false } });
  });

  it("reports fewer pieces than asked for rather than hiding it", async () => {
    /**
     * Unlike a campaign, these are independent alternatives — four good posts are four good posts. So
     * this reports rather than refuses, and `requested` is what makes the shortfall visible; a caller
     * comparing it with `pieces.length` can say "three of the five you asked for".
     */
    const result = await run(
      { pieces: [{ angle: "a", platformId: "linkedin", caption: "One piece." }] },
      { count: 3 },
    );
    expect(result).toMatchObject({ ok: true, data: { requested: 3 } });
    expect((result as { data: { pieces: readonly unknown[] } }).data.pieces).toHaveLength(1);
  });

  it("refuses when nothing usable came back", async () => {
    // An empty list renders as an empty panel with no explanation; a refusal names what to try.
    const result = await run({ pieces: [] });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
  });

  it("leaves hashtags empty rather than splitting them back out", async () => {
    /**
     * The old engine ran `_split_hashtags` over each caption. This generator writes them into the
     * caption because placement is a platform convention — the same decision `generate_content`
     * records, and the reason the web adapter's `hashtags` is empty too.
     */
    const result = await run();
    const pieces = (result as { data: { pieces: readonly { hashtags: string; caption: string }[] } }).data.pieces;
    expect(pieces.every((piece) => piece.hashtags === "")).toBe(true);
    expect(pieces[0]?.caption).toBe("A first piece.");
  });

  it("saves nothing", async () => {
    await run();
    expect(savedCalls).toEqual([]);
  });

  it("refuses more pieces than the cap, an empty source and a link with no text", async () => {
    for (const bad of [{ count: MAX_REPURPOSE_PIECES + 1 }, { sourceText: "   " }, { url: "https://example.com" }]) {
      expect(await run({}, bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(repurposeCalls).toEqual([]);
  });
});

describe("evaluate_campaign", () => {
  /**
   * The interesting property is **where the numbers come from**. The old route took a `stats` string and
   * told the model *"use only the numbers provided — never invent metrics"*, which is worth nothing when
   * the model is what provides them. So the tool takes only a campaign id, and these tests are mostly
   * about that: what the schema refuses, what the store supplies, and what happens when there is nothing
   * to evaluate.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}) => {
    const tool = evaluateCampaignTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({ context: CONTEXT, input: { campaignId: "c1", ...input }, idempotencyKey: "k1" });
  };

  it("takes only a campaign id — the theme, goal and numbers all come from the store", async () => {
    const result = await run();
    // Read from the campaign row, not from the caller.
    expect(evaluationCalls[0]).toMatchObject({ theme: "sustainable packaging", goal: "grow signups" });
    // And the facts are the ones the analytics service returned, passed through unchanged.
    expect(evaluationCalls[0]?.["totals"]).toEqual([
      expect.objectContaining({ metric: "impressions", value: 1_500 }),
      expect.objectContaining({ metric: "likes", value: 15 }),
    ]);
    expect(result).toMatchObject({ ok: true, data: { evaluation: "Post 1 did best. - Try video next time." } });
  });

  it("refuses a stats string, and any other way of supplying the numbers", async () => {
    /**
     * `.strict()` is what makes the guarantee more than a convention. Without it a model could pass
     * `stats` alongside the id, the field would be ignored silently, and the prompt's "use only the
     * numbers provided" would be back to meaning nothing.
     */
    for (const extra of [{ stats: "impressions 4000000" }, { theme: "something else" }, { totals: [] }]) {
      expect(await run({}, extra), JSON.stringify(extra)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(evaluationCalls).toEqual([]);
  });

  it("reads the campaign's own date range, not the seven-day refresh window", async () => {
    /**
     * `defaultWindow` is seven days ending today. A campaign that ran in August would come back with
     * nothing measured, and the refusal below would tell the user to publish a campaign they already
     * published.
     */
    await run();
    expect(breakdownCalls[0]?.["window"]).toEqual({ fromDay: "2026-08-01", toDay: "2026-08-31" });
  });

  it("uses an explicit window when given one", async () => {
    await run({}, { window: { fromDay: "2026-08-10", toDay: "2026-08-20" } });
    expect(breakdownCalls[0]?.["window"]).toEqual({ fromDay: "2026-08-10", toDay: "2026-08-20" });
  });

  it("refuses a campaign with nothing published and nothing measured", async () => {
    /**
     * The old route's own refusal, transcribed — `publishedItems === 0 && impressions === 0` →
     * *"No results yet — publish the campaign first."* Asked for an evaluation anyway, a model writes one
     * from the theme alone, and it reads exactly like an evaluation of real results.
     */
    const result = await run({
      breakdown: {
        posts: [
          {
            draftId: asId("d1"),
            excerpt: "never sent",
            platforms: ["linkedin"],
            publishedDestinations: 0,
            facts: [absent("impressions"), absent("likes")],
          },
        ],
        totals: [absent("impressions"), absent("likes")],
        freshness: { stale: true },
        scoped: false,
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(String((result as { error: { message: string } }).error.message)).toContain("publish the campaign first");
    // And the model was never asked, so no credit was spent writing about nothing.
    expect(evaluationCalls).toEqual([]);
  });

  it("evaluates a campaign that published but has no numbers yet", async () => {
    /**
     * The refusal is `published === 0 && !measured`, both halves. A campaign that went out and whose
     * platforms have not reported is a real campaign with a real thing to say about it — "it published to
     * three destinations and nothing is measured yet" — and refusing would hide that.
     */
    const result = await run({
      breakdown: {
        posts: [
          {
            draftId: asId("d1"),
            excerpt: "sent, unmeasured",
            platforms: ["linkedin"],
            publishedDestinations: 3,
            facts: [absent("impressions")],
          },
        ],
        totals: [absent("impressions")],
        freshness: { stale: true },
        scoped: false,
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(evaluationCalls).toHaveLength(1);
  });

  it("returns the facts it was written from, with an unmeasured metric still unmeasured", async () => {
    /**
     * The prose is model-written and about numbers, so it has to be checkable. A `0` here would be the
     * exact defect `analytics.ts` exists to avoid — an assistant reading it says "engagement was 0%" when
     * the truth is that nothing was collected.
     */
    const result = await run({
      breakdown: {
        posts: [
          {
            draftId: asId("d1"),
            excerpt: "one post",
            platforms: ["linkedin"],
            publishedDestinations: 1,
            facts: [value("impressions", 10), absent("engagement_rate", "fraction")],
          },
        ],
        totals: [value("impressions", 10), absent("engagement_rate", "fraction")],
        freshness: { stale: true },
        scoped: false,
      },
    });
    const grounding = (result as { data: { grounding: Record<string, unknown> } }).data.grounding;
    expect(grounding["totals"]).toEqual([
      expect.objectContaining({ metric: "impressions", value: 10 }),
      expect.objectContaining({ metric: "engagement_rate", unavailable: "not-collected" }),
    ]);
    expect(grounding["window"]).toEqual({ fromDay: "2026-08-01", toDay: "2026-08-31" });
    expect(grounding["freshness"]).toEqual({ stale: true });
    // No value masquerading as a measurement.
    const rate = (grounding["totals"] as readonly Record<string, unknown>[])[1];
    expect(rate?.["value"]).toBeUndefined();
  });

  it("evaluates a campaign with no goal set", async () => {
    // `goal` is optional in the store, and an omitted field must not become the string "undefined".
    await run({ campaign: { id: asId("c1"), name: "n", theme: "t", startsOn: "2026-08-01", endsOn: "2026-08-31" } });
    expect(evaluationCalls[0]?.["goal"]).toBeUndefined();
    expect("goal" in (evaluationCalls[0] ?? {})).toBe(false);
  });

  it("saves nothing", async () => {
    await run();
    expect(savedCalls).toEqual([]);
  });
});

describe("generate_campaign", () => {
  /**
   * The old runtime's sequence, transcribed: one planner call, N briefs, each expanded with an
   * avoid-list of sibling hooks. Two of its decisions are the interesting ones, and both are the
   * *opposite* of what `generate_content` does — which is why they are asserted rather than assumed.
   */
  /**
   * `key` is a parameter, and it has to be — for the **third** time in this file.
   *
   * The envelope answers a repeat call from its idempotency cache, and two calls with identical input
   * are a repeat whatever the *services* behind them do. So a test that varied only the stub got the
   * first run's answer back: `{ anglesOffered: 0 }` returned a successful three-post campaign built by
   * the previous call. Distinct keys, or distinct inputs, or the test is measuring the cache.
   */
  const run = async (o: Options = {}, input: Record<string, unknown> = {}, key?: string) => {
    const tool = generateCampaignTool.build({
      services: services(o),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool;
    return tool.execute({
      context: CONTEXT,
      input: { theme: "our new pricing page", postCount: 3, platformIds: ["instagram"], ...input },
      ...(key === undefined ? {} : { idempotencyKey: key }),
    });
  };

  it("writes one post per planned angle", async () => {
    const result = (await run()) as { ok: true; data: { postCount: number; posts: readonly { angle: string }[] } };
    expect(result.ok).toBe(true);
    expect(result.data.postCount).toBe(3);
    expect(result.data.posts.map((post) => post.angle)).toEqual(["angle 1", "angle 2", "angle 3"]);
  });

  it("tells each post the hooks its siblings are using", async () => {
    /**
     * The anti-duplication, and the reason `avoidHooks` exists separately from `avoid`: `avoid` renders
     * as "the previous attempt was rejected", which would be false here — nothing of this post's had
     * been written yet.
     */
    calls.length = 0;
    await run();
    expect(calls).toHaveLength(3);
    // Each call names the *other* angles, never its own.
    for (const call of calls) {
      expect(call.avoidHooks, `${call.angle} must be told about its siblings`).toBeDefined();
      expect(call.avoidHooks).not.toContain(call.angle);
    }
    expect(calls[0]?.avoidHooks).toEqual(expect.arrayContaining(["angle 2", "angle 3"]));
    // And `avoid` stays empty: no attempt was rejected.
    for (const call of calls) expect(call.avoid).toEqual([]);
  });

  it("grows the avoid-list with what earlier posts actually wrote", async () => {
    /**
     * The planner's labels are an intention; the caption is the thing that can repeat. So each post is
     * told the openings of the posts already written, not only the planned angles — which is also why
     * the posts are generated in sequence rather than concurrently.
     */
    calls.length = 0;
    await run({ captions: ["First opening line.", "Second opening line.", "Third."] });
    expect(calls[0]?.avoidHooks).not.toContain("First opening line.");
    expect(calls[1]?.avoidHooks).toContain("First opening line.");
    expect(calls[2]?.avoidHooks).toEqual(expect.arrayContaining(["First opening line.", "Second opening line."]));
  });

  it("fails the whole campaign when one post cannot be written", async () => {
    /**
     * **The old runtime's decision, and the opposite of `generate_content`'s.** Its comment is explicit:
     * "a single brief's expansion failure fails the whole campaign (partial campaigns are more confusing
     * than a clean retry)". A post can partly succeed across platforms; a five-post campaign that
     * produced three is not a campaign.
     */
    const result = (await run({ failAngle: "angle 2" })) as { ok: false; error: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("angle 2");
    expect(result.error.message).toMatch(/campaign/i);
  });

  it("tops up a short batch rather than refusing, and still refuses when the theme is exhausted", async () => {
    /**
     * **This test asserted a refusal, and the change is deliberate.**
     *
     * A planner that offers two angles when asked for three used to fail the whole campaign, because
     * there was one call and its answer was final. Batching means it can be asked again — so a short
     * batch is topped up, and the request succeeds with the count that was asked for.
     *
     * The refusal moved rather than disappeared: it fires when a batch returns nothing *new*, which is
     * the real "this theme has run out of angles" signal. Writing two posts for a three-post request is
     * still the partial campaign the old runtime decided against; what changed is how hard the tool
     * tries before saying so.
     */
    const short = await run({ anglesOffered: 2 }, {}, "short");
    expect(short, "a planner that can be asked again should be topped up").toMatchObject({ ok: true });

    const exhausted = (await run({ anglesOffered: 0 }, {}, "exhausted")) as { ok: false; error: { message: string } };
    expect(exhausted.ok).toBe(false);
    expect(exhausted.error.message).toContain("distinct angle");
  });

  it("saves nothing", async () => {
    // Like every generator tool here: the caller keeps what it wants with create_post_draft, and
    // create_campaign makes the container. A `read` effect that wrote would be a mislabelled tool.
    const descriptor = (generateCampaignTool.build({
      services: services(),
      deps: { authorization: allowAll, idempotency },
    } as never) as Tool).descriptor;
    expect(descriptor.effect).toBe("read");
  });
});

