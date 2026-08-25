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
import {
  asId,
  createMemoryIdempotencyStore,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import {
  DEFAULT_REPAIR_BOUND,
  DUPLICATE_CONTENT_CODE,
  FORBIDDEN_CLAIM_CODE,
  GENERATE_TOOL_FACTORIES,
  GENERATE_TOOL_NAMES,
  captionSimilarity,
  createShareFlowToolProvider,
  findDuplicateContent,
  generateContentTool,
  normaliseCaption,
  proposePostAnglesTool,
  type PlatformId,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type ValidationIssue,
  type ValidationReport,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

type Call = { readonly platformId: PlatformId; readonly avoid: readonly ValidationIssue[] };

type Options = {
  /** Caption per attempt, cycling on the last entry. */
  captions?: readonly string[];
  /** Report from `validateContent`, cycling on the last entry. */
  reports?: readonly ValidationReport[];
  forbidden?: readonly { phrase: string; reason?: string }[];
  recentExcerpts?: readonly string[];
  emptyGeneration?: boolean;
};

let calls: Call[];
let savedCalls: string[];

const services = (o: Options = {}): ShareFlowServices => {
  const captions = o.captions ?? ["A perfectly ordinary post about the new pricing page."];
  const reports = o.reports ?? [{ ok: true, issues: [] }];
  let generateCount = 0;
  let validateCount = 0;
  const at = <T>(list: readonly T[], i: number): T => list[Math.min(i, list.length - 1)] as T;

  return {
    generator: {
      async proposeAngles(_c: ExecutionContext, input: { count: number }) {
        return Array.from({ length: input.count }, (_, i) => ({
          label: `angle ${i + 1}`,
          rationale: `because ${i + 1}`,
        }));
      },
      async generate(_c: ExecutionContext, input: { platformIds: readonly PlatformId[]; avoid: readonly ValidationIssue[] }) {
        calls.push({ platformId: input.platformIds[0] as PlatformId, avoid: input.avoid });
        if (o.emptyGeneration === true) return [];
        const caption = at(captions, generateCount);
        generateCount += 1;
        return [{ platformId: input.platformIds[0] as PlatformId, caption }];
      },
    },
    brand: {
      async getClaimPolicy() {
        return { approved: [], forbidden: o.forbidden ?? [] };
      },
    },
    content: {
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

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, o: Options = {}): Tool =>
  factory({ services: services(o), deps: { authorization: allowAll, idempotency } });

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
    const failures = (result as { error: { details: { failures: { issues: { code: string }[] }[] } } }).error.details
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
    const tool = generateContentTool({ services: patched, deps: { authorization: allowAll, idempotency } });
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
    ]);
  });

  it("registers under posts, since a generated variant is a post", async () => {
    const provider = createShareFlowToolProvider({
      services: services(),
      deps: { authorization: allowAll, idempotency },
      factories: GENERATE_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...GENERATE_TOOL_NAMES]);
    for (const d of descriptors) expect(d.category).toBe("posts");
  });

  it("refuses before the generator is called when the policy says no", async () => {
    const tool = generateContentTool({
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
