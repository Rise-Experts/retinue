/**
 * The ShareFlow context providers (#121).
 *
 * AC-5 and AC-6 are about the *assembler*, not about these providers in isolation, so those tests run
 * the real `gatherSections` and `assemblePrompt`. A provider tested only on its own return value would
 * say nothing about whether an oversized brand profile crowds out the request.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type ContextBudget, type ExecutionContext, type PrincipalId, type TenantId } from "@retinue/agentkit";
import { assemblePrompt, gatherSections } from "@retinue/agentkit/context";
import {
  CONTEXT_PRIORITY,
  FORBIDDEN_CLAIM_CODE,
  SHAREFLOW_CONTEXT_PROVIDER_IDS,
  containsForbiddenClaim,
  createAccountsContextProvider,
  createAudienceContextProvider,
  createBrandContextProvider,
  createCampaignContextProvider,
  createClaimsContextProvider,
  createCurrentPostContextProvider,
  createExamplesContextProvider,
  createPerformanceContextProvider,
  findForbiddenClaims,
  shareFlowBaseContextProviders,
  type BrandProfile,
  type Campaign,
  type CampaignId,
  type ClaimPolicy,
  type ConnectedAccount,
  type PostDraft,
  type PostDraftId,
  type ShareFlowServices,
  type SocialAccountId,
  type VoiceExample,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const D1 = asId<PostDraftId>("d1");
const C1 = asId<CampaignId>("c1");

type Fixtures = {
  profile?: BrandProfile;
  claims?: ClaimPolicy;
  examples?: readonly VoiceExample[];
  performance?: string | null;
  accounts?: readonly ConnectedAccount[];
  campaign?: Campaign;
  draft?: PostDraft;
};

let fetched: string[];

const services = (f: Fixtures = {}): ShareFlowServices =>
  ({
    brand: {
      async getBrandProfile() {
        fetched.push("getBrandProfile");
        return f.profile ?? {};
      },
      async getClaimPolicy() {
        fetched.push("getClaimPolicy");
        return f.claims ?? { approved: [], forbidden: [] };
      },
      async listVoiceExamples() {
        fetched.push("listVoiceExamples");
        return f.examples ?? [];
      },
      async getPerformanceBrief() {
        fetched.push("getPerformanceBrief");
        return f.performance ?? null;
      },
    },
    connectors: {
      async listAccounts() {
        fetched.push("listAccounts");
        return f.accounts ?? [];
      },
    },
    content: {
      async getCampaign() {
        fetched.push("getCampaign");
        return (
          f.campaign ?? {
            id: C1,
            name: "Spring launch",
            theme: "pricing relaunch",
            startsOn: "2026-09-01",
            endsOn: "2026-09-30",
            cadence: "3x-week",
            channels: ["linkedin"],
            status: "draft",
            mode: "assisted",
            mediaType: "none",
            plannedPostCount: 13,
            createdAt: "2026-08-23T00:00:00.000Z",
          }
        );
      },
      async getDraft() {
        fetched.push("getDraft");
        return (
          f.draft ?? {
            id: D1,
            status: "approved",
            caption: "Shipping the new pricing page today.",
            targetPlatforms: ["linkedin"],
            mediaAssetIds: [],
            updatedAt: "2026-08-23T10:00:00.000Z",
          }
        );
      },
    },
  }) as unknown as ShareFlowServices;

const budget = (over: Partial<ContextBudget> = {}): ContextBudget => ({
  basePolicyTokens: 500,
  userContextTokens: 500,
  toolTokens: 500,
  skillTokens: 500,
  knowledgeTokens: 500,
  historyTokens: 500,
  ...over,
});

beforeEach(() => {
  fetched = [];
});

/** AC-1 and AC-3. */
describe("brand, audience and campaign context", () => {
  it("carries the configured voice without the user restating it", async () => {
    const sections = await createBrandContextProvider(
      services({ profile: { brandName: "Acme", voice: "Plain, direct, no hype.", customInstructions: "Never use emoji." } }),
    ).provide(CONTEXT);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toContain("Plain, direct, no hype.");
    expect(sections[0]?.body).toContain("Never use emoji.");
    expect(sections[0]?.provenance).toBe("shareflow:workspace_ai_profile");
  });

  it("renders only the fields that are set", async () => {
    // An empty `brand_voice` becoming the line "Voice and tone:" would spend budget saying nothing, and
    // read to the model as an instruction to have no voice.
    const sections = await createBrandContextProvider(services({ profile: { brandName: "Acme" } })).provide(CONTEXT);
    expect(sections[0]?.body).toBe("Brand: Acme");
    expect(sections[0]?.body).not.toContain("Voice");
  });

  it("produces nothing at all when the profile is empty", async () => {
    expect(await createBrandContextProvider(services()).provide(CONTEXT)).toEqual([]);
    expect(await createAudienceContextProvider(services()).provide(CONTEXT)).toEqual([]);
    expect(await createExamplesContextProvider({ services: services() }).provide(CONTEXT)).toEqual([]);
  });

  it("carries the audience as the one free-text field it is", async () => {
    const sections = await createAudienceContextProvider(
      services({ profile: { audience: "Heads of marketing at 50-500 person B2B SaaS." } }),
    ).provide(CONTEXT);
    expect(sections[0]?.body).toBe("Heads of marketing at 50-500 person B2B SaaS.");
  });

  it("carries the campaign's real post count, not the one the dates suggest", async () => {
    const sections = await createCampaignContextProvider({ services: services(), campaignId: C1 }).provide(CONTEXT);
    expect(sections[0]?.body).toContain("Posts planned: 13");
    expect(sections[0]?.body).toContain("Runs 2026-09-01 to 2026-09-30, 3x-week");
  });

  it("carries destination health and its remediation, from the same function the tools use", async () => {
    const sections = await createAccountsContextProvider(
      services({
        accounts: [
          { id: asId<SocialAccountId>("a1"), platformId: "linkedin", displayName: "Acme", health: "active" },
          { id: asId<SocialAccountId>("a2"), platformId: "x", displayName: "Acme X", health: "not-configured" },
        ],
      }),
    ).provide(CONTEXT);
    expect(sections[0]?.body).toContain("Acme (linkedin): active");
    // `remediationFor` reused, so the context and `list_accounts` cannot disagree about what a health
    // value means.
    expect(sections[0]?.body).toContain("Acme X (x): not-configured — configure-credentials");
  });

  it("states that nothing is connected rather than omitting the section", async () => {
    // An absent section reads as "unknown". This is a fact, and it is the reason every publish will fail
    // until it changes.
    const sections = await createAccountsContextProvider(services()).provide(CONTEXT);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toContain("No destinations are connected");
  });

  it("keeps the current post unprunable, since it is the subject of the request", async () => {
    const sections = await createCurrentPostContextProvider({ services: services(), postDraftId: D1 }).provide(CONTEXT);
    expect(sections[0]?.body).toContain("Shipping the new pricing page today.");
    // A section with no `pruneStage` is preserved by the assembler. A prompt that dropped the post under
    // discussion would be answering about nothing.
    expect(sections[0]?.pruneStage).toBeUndefined();
  });

  it("carries examples as excerpts with their ids", async () => {
    const sections = await createExamplesContextProvider({
      services: services({ examples: [{ postDraftId: D1, excerpt: "We shipped a thing." }] }),
    }).provide(CONTEXT);
    expect(sections[0]?.body).toBe("- [d1] We shipped a thing.");
  });
});

/** AC-2. */
describe("forbidden claims", () => {
  const forbidden = [
    { phrase: "clinically proven", reason: "not cleared by legal" },
    { phrase: "number one" },
    { phrase: "C++" },
  ];

  it("matches a literal phrase case-insensitively", () => {
    const issues = findForbiddenClaims("Our product is Clinically Proven to work.", forbidden);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: FORBIDDEN_CLAIM_CODE, repairable: false });
    expect(issues[0]?.message).toContain("not cleared by legal");
  });

  it("matches across a line break in a caption", () => {
    // A claim broken over two lines is the same claim. Runs of whitespace in the phrase match runs of any
    // whitespace in the text.
    expect(containsForbiddenClaim("It is clinically\n  proven.", forbidden)).toBe(true);
  });

  it("respects word boundaries, so a longer word is not a match", () => {
    expect(containsForbiddenClaim("We are number one hundred", forbidden)).toBe(true); // contains the phrase
    expect(containsForbiddenClaim("numbered ones", forbidden)).toBe(false);
  });

  it("matches a phrase that does not end in a word character", () => {
    // The bug this guards: `\bC++\b` never matches, because `+` is not a word character and there is no
    // boundary after it. A forbidden phrase that silently never fires is worse than no check.
    expect(containsForbiddenClaim("We write everything in C++ here.", forbidden)).toBe(true);
  });

  it("treats a phrase as a literal, not a pattern", () => {
    // `.` and `*` in a phrase must match themselves. Otherwise "5.0 rating" would match "500 rating".
    expect(containsForbiddenClaim("500 rating", [{ phrase: "5.0 rating" }])).toBe(false);
    expect(containsForbiddenClaim("5.0 rating", [{ phrase: "5.0 rating" }])).toBe(true);
  });

  it("reports every distinct claim a text contains", () => {
    expect(findForbiddenClaims("Clinically proven and number one.", forbidden)).toHaveLength(2);
  });

  it("finds nothing when the policy is empty, which is not the same as nothing being forbidden", () => {
    // There is no claims record in ShareFlow yet, so an adapter returning an empty policy produces no
    // findings on any text. A clean result means "nothing matched".
    expect(findForbiddenClaims("clinically proven", [])).toEqual([]);
  });

  it("ignores a blank phrase rather than matching everything", () => {
    // An empty pattern matches every string. A misconfigured row must not refuse all content.
    expect(findForbiddenClaims("anything at all", [{ phrase: "   " }])).toEqual([]);
  });

  it("puts the policy in base-policy, which the assembler never prunes", async () => {
    const sections = await createClaimsContextProvider(
      services({ claims: { approved: ["fastest onboarding"], forbidden } }),
    ).provide(CONTEXT);
    // The load-bearing choice: in `user-context` this would be prunable, so an oversized brand profile
    // could push the constraint out of the prompt — and the model would then produce the forbidden claim
    // with nothing having gone wrong anywhere.
    expect(sections[0]?.kind).toBe("base-policy");
    expect(sections[0]?.pruneStage).toBeUndefined();
    expect(sections[0]?.sensitivity).toBe("confidential");
    expect(sections[0]?.body).toContain("Never claim any of the following");
    expect(sections[0]?.body).toContain("fastest onboarding");
  });
});

/** AC-4. */
describe("performance insights are not fetched on a routine request", () => {
  it("is off by default", async () => {
    const sections = await createPerformanceContextProvider({
      services: services({ performance: "linkedin (4.2% avg engagement)" }),
    }).provide(CONTEXT);
    expect(sections).toEqual([]);
    // The observable effect: the expensive call was never made. ShareFlow's brief joins metrics across
    // sixty rows, so this is not a cheap default to leave on.
    expect(fetched).not.toContain("getPerformanceBrief");
  });

  it("is not fetched by the base provider set", async () => {
    await gatherSections(CONTEXT, shareFlowBaseContextProviders(services({ performance: "something" })));
    expect(fetched).not.toContain("getPerformanceBrief");
    // And the cheap ones were.
    expect(fetched).toContain("getClaimPolicy");
    expect(fetched).toContain("listAccounts");
  });

  it("is fetched when a deployment enables it", async () => {
    const sections = await createPerformanceContextProvider({
      services: services({ performance: "linkedin (4.2% avg engagement)" }),
      enabled: () => true,
    }).provide(CONTEXT);
    expect(sections).toHaveLength(1);
    expect(fetched).toContain("getPerformanceBrief");
  });

  it("produces nothing when there is nothing to say", async () => {
    expect(
      await createPerformanceContextProvider({ services: services({ performance: "" }), enabled: () => true }).provide(
        CONTEXT,
      ),
    ).toEqual([]);
  });
});

/** AC-5. */
describe("the context inspector shows exactly what was applied", () => {
  it("lists every section with its own size and whether it was included", async () => {
    const sections = await gatherSections(
      CONTEXT,
      shareFlowBaseContextProviders(
        services({
          profile: { brandName: "Acme", voice: "Plain.", audience: "B2B SaaS." },
          claims: { approved: [], forbidden: [{ phrase: "number one" }] },
          examples: [{ postDraftId: D1, excerpt: "We shipped." }],
          accounts: [{ id: asId<SocialAccountId>("a1"), platformId: "x", displayName: "Acme", health: "active" }],
        }),
      ),
    );
    const assembled = assemblePrompt({ sections, budget: budget(), modelContextTokens: 100_000 });
    const titles = assembled.preview.sections.map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining(["Claim policy", "Brand", "Connected destinations", "Audience", "Examples of this brand's own posts"]),
    );
    for (const section of assembled.preview.sections) {
      expect(section.estimatedTokens, section.title).toBeGreaterThan(0);
      expect(section.included, section.title).toBe(true);
    }
    expect(assembled.pruned).toEqual([]);
  });

  it("names the source of every section, so a claim can be traced back", async () => {
    const sections = await gatherSections(
      CONTEXT,
      shareFlowBaseContextProviders(services({ profile: { brandName: "Acme" } })),
    );
    for (const section of sections) {
      expect(section.provenance, section.title).toMatch(/^shareflow:/);
      expect(section.provenance.length, section.title).toBeGreaterThan("shareflow:".length);
    }
  });
});

/** AC-6. */
describe("a large brand configuration cannot crowd out the request", () => {
  it("prunes the brand profile rather than the claim policy", async () => {
    // The brand fields are capped at 4000 characters each in ShareFlow, which is ~2000 tokens — well over
    // a small user-context budget. What must survive is the policy, and it does because it is in a
    // different bucket that is never pruned.
    const sections = await gatherSections(
      CONTEXT,
      shareFlowBaseContextProviders(
        services({
          profile: { voice: "x".repeat(4_000), customInstructions: "y".repeat(4_000), audience: "z".repeat(2_000) },
          claims: { approved: [], forbidden: [{ phrase: "number one" }] },
          accounts: [{ id: asId<SocialAccountId>("a1"), platformId: "x", displayName: "Acme", health: "active" }],
        }),
      ),
    );
    const assembled = assemblePrompt({
      sections,
      budget: budget({ userContextTokens: 200 }),
      modelContextTokens: 100_000,
    });
    const includedTitles = assembled.sections.map((s) => s.title);
    expect(includedTitles).toContain("Claim policy");
    expect(assembled.pruned.map((p) => p.section.title)).toContain("Brand");
    expect(assembled.pruned.every((p) => p.reason === "bucket-overflow")).toBe(true);
  });

  it("keeps the higher-priority sections when the bucket overflows", async () => {
    const sections = await gatherSections(
      CONTEXT,
      shareFlowBaseContextProviders(
        services({
          profile: { voice: "x".repeat(600), audience: "z".repeat(600) },
          examples: [{ excerpt: "e".repeat(600) }],
          accounts: [{ id: asId<SocialAccountId>("a1"), platformId: "x", displayName: "Acme", health: "active" }],
        }),
      ),
    );
    const assembled = assemblePrompt({
      sections,
      budget: budget({ userContextTokens: 200 }),
      modelContextTokens: 100_000,
    });
    const included = assembled.sections.map((s) => s.title);
    // Brand outranks examples: the voice is what makes output sound like the customer, and the examples
    // merely illustrate it.
    expect(included).toContain("Brand");
    expect(included).not.toContain("Examples of this brand's own posts");
  });

  it("orders the priorities the way the comment claims", () => {
    expect(CONTEXT_PRIORITY.claims).toBeGreaterThan(CONTEXT_PRIORITY.brand);
    expect(CONTEXT_PRIORITY.brand).toBeGreaterThan(CONTEXT_PRIORITY.examples);
    expect(CONTEXT_PRIORITY.accounts).toBeGreaterThan(CONTEXT_PRIORITY.campaign);
    expect(CONTEXT_PRIORITY.examples).toBeGreaterThan(CONTEXT_PRIORITY.performance);
  });
});

describe("the provider id list", () => {
  it("has a provider for every id, so a manifest entry cannot match nothing", () => {
    // Closing the loop #114's own comment opened: `shareflow.products` was in this list with nothing
    // behind it, because ShareFlow stores no products. That is the silent gap the comment warned about.
    const s = services();
    const built = [
      ...shareFlowBaseContextProviders(s),
      createCampaignContextProvider({ services: s, campaignId: C1 }),
      createCurrentPostContextProvider({ services: s, postDraftId: D1 }),
      createPerformanceContextProvider({ services: s }),
    ];
    expect(built.map((p) => p.id).sort()).toEqual([...SHAREFLOW_CONTEXT_PROVIDER_IDS].sort());
  });

  it("no longer claims a products provider", () => {
    expect([...SHAREFLOW_CONTEXT_PROVIDER_IDS]).not.toContain("shareflow.products");
  });
});
