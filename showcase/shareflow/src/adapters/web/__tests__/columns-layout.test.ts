/**
 * #664 (AR-17, F5): a `columns` layout — each `###` a column, two to four of them — for pricing tiers, plans and
 * options, so a third option no longer turns a comparison into bullets. `comparison` stays strictly two-sided. The
 * panel's half is diffed against this one in `web/src/lib/assistant/__tests__/artifactSlides.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { markdownToHtml } from "../document.js";
import { SLIDE_DESIGN_CSS } from "../slide-design.js";
import { buildSlidesHtml, inferLayout, parseSlides, slideParts } from "../slides.js";

const PRICING = "## Pricing\n### Basic\n- $9 / month\n- 1 seat\n### Team\n- $29 / month\n- 10 seats\n### Premium\n- $99 / month\n- Unlimited seats";

describe("inferring columns", () => {
  it.each([
    [PRICING, "columns"],
    ["### Basic\n- $9\n### Team\n- $29\n### Premium\n- $99\n### Enterprise\n- Talk to us", "columns"],
    ["## Plans\nPick one.\n### A\n- a\n### B\n- b\n### C\n- c", "columns"],
    // Two sides are still a two-column slide or a comparison, as before.
    ["## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats", "two-column"],
    ["### Before\n- slow\n### After\n- fast", "comparison"],
    // Five is too many to read; a heading with nothing under it, or headings at mixed levels, are not columns.
    ["### A\n- a\n### B\n- b\n### C\n- c\n### D\n- d\n### E\n- e", "bullets"],
    ["### A\n- a\n### B\n### C\n- c", "bullets"],
    ["### A\n- a\n#### B\n- b\n### C\n- c", "bullets"],
  ])("%j is %s", (chunk, layout) => {
    expect(inferLayout(chunk)).toEqual({ layout, forced: false });
  });

  it("can be forced, and with no sub-headings the list is dealt into three", () => {
    expect(inferLayout("<!-- layout: columns -->\n## H\n- a")).toEqual({ layout: "columns", forced: true });
    const deck = parseSlides("<!-- layout: columns -->\n## Steps\n- a\n- b\n- c\n- d\n- e");
    expect(slideParts(deck.slides[0]!).grid).toEqual([
      { heading: "", body: "- a\n- b" },
      { heading: "", body: "- c\n- d" },
      { heading: "", body: "- e" },
    ]);
  });

  it("forced onto two sub-headings draws two even columns", () => {
    const deck = parseSlides("<!-- layout: columns -->\n## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats");
    expect(slideParts(deck.slides[0]!).grid?.map((col) => col.heading)).toEqual(["### Starter", "### Team"]);
  });
});

describe("the columns slide (AC)", () => {
  it("splits Basic / Team / Premium into three columns under the heading", () => {
    const parts = slideParts(parseSlides(PRICING).slides[0]!);
    expect(parts.before).toBe("## Pricing");
    expect(parts.grid).toEqual([
      { heading: "### Basic", body: "- $9 / month\n- 1 seat" },
      { heading: "### Team", body: "- $29 / month\n- 10 seats" },
      { heading: "### Premium", body: "- $99 / month\n- Unlimited seats" },
    ]);
    expect(parts.columns).toBeUndefined();
  });

  it("exports as three even columns, without a comparison's vs", async () => {
    const { html } = await buildSlidesHtml({ source: PRICING, renderMarkdown: markdownToHtml });
    expect(html).toContain("l-columns");
    expect(html).toContain('<div class="s-cols" style="--count:3">');
    expect(html.match(/<div class="s-col" style="--i:\d">/g)).toHaveLength(3);
    expect(html).not.toContain('class="s-vs"');
    for (const tier of ["Basic", "Team", "Premium"]) expect(html).toContain(`<h3>${tier}</h3>`);
  });

  it("keeps the columns side by side and even in every format", () => {
    expect(SLIDE_DESIGN_CSS).toContain(".slide.l-columns .s-cols, .slide.f-portrait.l-columns .s-cols { grid-template-columns: repeat(var(--count, 3), minmax(0, 1fr));");
  });
});
