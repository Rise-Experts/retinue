import { describe, expect, it } from "vitest";

import { draftPlaceholderWarnings } from "../posts.js";

/** #689 (AC-4) — a post saved with placeholders says so in its result. */
describe("placeholders in a post", () => {
  it("are flagged, from the caption and every channel's own caption, once each", () => {
    // Production, 2026-10-04: a LinkedIn draft saved as finished with "[Cafe Name]" in it.
    const warnings = draftPlaceholderWarnings(["Visit [Cafe Name] this weekend!", undefined, "At [Cafe Name] on [Street Address]."]);
    expect(warnings.placeholders).toEqual(["[Cafe Name]", "[Street Address]"]);
    expect(warnings.placeholderNote).toContain("never invent them");
    expect(warnings.placeholderNote).toContain("Do not call it ready");
  });

  it("leave a finished post alone, including links, task boxes and footnotes", () => {
    expect(draftPlaceholderWarnings(["Read [our guide](https://example.com) [1] [x] #coffee"])).toEqual({});
  });
});
