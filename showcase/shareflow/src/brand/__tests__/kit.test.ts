import { describe, expect, it } from "vitest";

import { brandProfileFromRow, createPostgresBrandService } from "../../adapters/postgres/brand.js";
import { createModelContentGenerator } from "../../adapters/model/generator.js";
import { createBrandContextProvider } from "../../context/providers.js";
import type { BrandProfile } from "../../services/index.js";
import { brandKitFromRow, brandKitLines } from "../kit.js";

/**
 * The brand kit — #634 §4. The new columns may not exist when this deploys, so the row → profile mapping has
 * to read an old six-column row exactly as before, and the prompt must stay silent about anything unset.
 */

const OLD_ROW = {
  workspace_id: "00000000-0000-0000-0000-000000000001",
  brand_name: "Acme",
  company: "Acme GmbH",
  website: "https://acme.test",
  audience: "operators",
  brand_voice: "Plain, direct.",
  custom_instructions: null,
  updated_at: "2026-09-29T00:00:00Z",
};

const FULL_ROW = {
  ...OLD_ROW,
  logo_path: "ws/brand/logo-1.png",
  brand_colors: [
    { hex: "#1A2B3C", name: "Navy" },
    { hex: "#ffcc00", name: "" },
    { hex: "not-a-colour", name: "Broken" },
  ],
  industry: "Software / SaaS",
  tone: ["Friendly", "Witty", ""],
  emoji_use: "light",
  hashtag_style: "few",
  language: "de",
  avoid: "cheap, guaranteed results",
};

const CONTEXT = {} as never;

const providerFor = (profile: BrandProfile) =>
  createBrandContextProvider({
    brand: {
      getBrandProfile: async () => profile,
      getClaimPolicy: async () => ({ approved: [], forbidden: [] }),
      listVoiceExamples: async () => [],
      getPerformanceBrief: async () => null,
    },
  });

describe("brandProfileFromRow", () => {
  it("reads an old-only row (migration not applied) exactly as before, with no kit fields", () => {
    expect(brandProfileFromRow(OLD_ROW)).toEqual({
      brandName: "Acme",
      company: "Acme GmbH",
      website: "https://acme.test",
      audience: "operators",
      voice: "Plain, direct.",
    });
  });

  it("reads a full row, dropping malformed colours and blank tones", () => {
    expect(brandProfileFromRow(FULL_ROW)).toEqual({
      brandName: "Acme",
      company: "Acme GmbH",
      website: "https://acme.test",
      audience: "operators",
      voice: "Plain, direct.",
      logoPath: "ws/brand/logo-1.png",
      colors: [{ hex: "#1a2b3c", name: "Navy" }, { hex: "#ffcc00" }],
      industry: "Software / SaaS",
      tone: ["Friendly", "Witty"],
      emojiUse: "light",
      hashtagStyle: "few",
      language: "de",
      avoid: "cheap, guaranteed results",
    });
  });

  it("treats null and out-of-range enum values as absent", () => {
    expect(
      brandKitFromRow({ logo_path: null, brand_colors: null, tone: [], emoji_use: "some", hashtag_style: null, language: "  " }),
    ).toEqual({});
  });
});

describe("the adapter reads the row as jsonb", () => {
  it("selects to_jsonb so a missing column cannot fail the query", async () => {
    const seen: string[] = [];
    const sql = {
      query: async (text: string) => {
        seen.push(text);
        return [{ profile: OLD_ROW }];
      },
    };
    const profile = await createPostgresBrandService(sql as never).getBrandProfile({ tenantId: OLD_ROW.workspace_id } as never);
    expect(seen[0]).toContain("to_jsonb(p)");
    expect(profile.brandName).toBe("Acme");
    expect(profile.tone).toBeUndefined();
  });

  it("parses a jsonb value an executor hands back as text", async () => {
    const sql = { query: async () => [{ profile: JSON.stringify(FULL_ROW) }] };
    const profile = await createPostgresBrandService(sql as never).getBrandProfile({ tenantId: "x" } as never);
    expect(profile.emojiUse).toBe("light");
  });
});

describe("brandKitLines", () => {
  it("renders nothing for a profile without kit fields", () => {
    expect(brandKitLines({ brandName: "Acme", voice: "wry" })).toEqual([]);
  });

  it("renders each set field as one terse line", () => {
    expect(brandKitLines(brandProfileFromRow(FULL_ROW))).toEqual([
      "Industry: Software / SaaS",
      "Tone: friendly, witty",
      "Emoji: sparingly (0-2)",
      "Hashtags: a few (1-3)",
      "Language: German",
      "Brand colours: #1a2b3c (Navy), #ffcc00",
      "Logo: on file",
    ]);
  });

  it("says nothing for auto language, and passes an unknown code through", () => {
    expect(brandKitLines({ language: "auto" })).toEqual([]);
    expect(brandKitLines({ language: "fr" })).toEqual(["Language: fr"]);
  });
});

describe("the brand context section", () => {
  it("is unchanged for a profile without the new fields", async () => {
    const sections = await providerFor(brandProfileFromRow(OLD_ROW)).provide(CONTEXT);
    expect(sections[0]?.body).toBe(
      "Brand: Acme\n\nCompany: Acme GmbH\n\nWebsite: https://acme.test\n\nVoice and tone:\nPlain, direct.",
    );
  });

  it("carries the kit and the words to avoid when they are set", async () => {
    const sections = await providerFor(brandProfileFromRow(FULL_ROW)).provide(CONTEXT);
    expect(sections[0]?.body).toBe(
      [
        "Brand: Acme",
        "Company: Acme GmbH",
        "Website: https://acme.test",
        [
          "Industry: Software / SaaS",
          "Tone: friendly, witty",
          "Emoji: sparingly (0-2)",
          "Hashtags: a few (1-3)",
          "Language: German",
          "Brand colours: #1a2b3c (Navy), #ffcc00",
          "Logo: on file",
        ].join("\n"),
        "Voice and tone:\nPlain, direct.",
        "Avoid these words and claims:\ncheap, guaranteed results",
      ].join("\n\n"),
    );
    // The path is storage detail, not brand context.
    expect(sections[0]?.body).not.toContain("ws/brand");
  });

  it("renders a section from kit fields alone", async () => {
    const sections = await providerFor({ emojiUse: "none" }).provide(CONTEXT);
    expect(sections[0]?.body).toBe("Emoji: none");
  });
});

describe("the generator's brand brief", () => {
  it("carries the kit into generate_content's system text", async () => {
    const sent: string[] = [];
    const generator = createModelContentGenerator({
      generate: (async (input: { system: string }) => {
        sent.push(input.system);
        return { angles: [] };
      }) as never,
      brand: async () => brandProfileFromRow(FULL_ROW),
    });
    await generator.proposeAngles(CONTEXT, { brief: "launch", count: 1 } as never);
    expect(sent[0]).toContain("Tone: friendly, witty");
    expect(sent[0]).toContain("Hashtags: a few (1-3)");
    expect(sent[0]).toContain("Avoid: cheap, guaranteed results");
    expect(sent[0]).not.toContain("ws/brand");
  });
});
