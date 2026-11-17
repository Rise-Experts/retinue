/**
 * #663 (AR-17, F4): a deck's own style directives — palette, heading-font, body-font, mode and a slide's
 * bg-color — read, validated and laid over the resolved theme in the export. The panel's half is diffed against
 * this one in `web/src/lib/assistant/__tests__/artifactSlides.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { MODE_GROUNDS, contrastRatio, resolveTheme, withDeckStyle } from "../../../design/theme.js";
import { markdownToHtml } from "../document.js";
import { buildSlidesHtml, deckStyleOf, deckStyleProblems, nearestInstalledFont, parseSlides, readPalette } from "../slides.js";

describe("deckStyleOf", () => {
  it("reads a positional palette, both fonts in any case, and the mode", () => {
    expect(deckStyleOf("<!-- palette: #0B1020, #f5f5f5 #f53 -->\n<!-- heading-font: bebas neue -->\n<!-- body-font: \"Inter\" -->\n<!-- mode: Dark -->\n# A")).toEqual({
      background: "#0b1020",
      text: "#f5f5f5",
      accent: "#ff5533",
      headingFont: "Bebas Neue",
      bodyFont: "Inter",
      mode: "dark",
    });
  });

  it("reads a named palette in any order", () => {
    expect(readPalette("accent #ff5a36, bg:#0b1020").colours).toEqual({ accent: "#ff5a36", background: "#0b1020" });
    expect(readPalette("text: #fff").colours).toEqual({ text: "#ffffff" });
  });

  it("keeps only valid values, and nothing at all for a deck without directives", () => {
    expect(deckStyleOf("<!-- palette: navy #fff -->\n<!-- heading-font: Montserrat -->\n<!-- mode: dim -->\n# A")).toEqual({ text: "#ffffff" });
    expect(deckStyleOf("# A\n---\n## B")).toBeUndefined();
  });

  it("ignores a directive shown in a code block", () => {
    expect(deckStyleOf("## How\n```md\n<!-- mode: dark -->\n```")).toBeUndefined();
  });

  it("removes the directives from the slide, and keeps a slide's bg-color on that slide", () => {
    const deck = parseSlides("<!-- mode: dark -->\n# A\n---\n<!-- bg-color: #FFEEDD -->\n## B\n- b");
    expect(deck.style).toEqual({ mode: "dark" });
    expect(deck.slides[0]?.body).toBe("# A");
    expect(deck.slides[1]?.bgColor).toBe("#ffeedd");
    expect(deck.slides[1]?.body).toBe("## B\n- b");
    expect(deck.slides[0]?.bgColor).toBeUndefined();
  });
});

describe("nearestInstalledFont (AC-2)", () => {
  it.each([
    ["Montserrat", "League Spartan"],
    ["Poppins", "Manrope"],
    ["Playfair Display", "EB Garamond"],
    ["Fira Code", "JetBrains Mono"],
    ["Some Slab", "Roboto Slab"],
    ["Acme Serif", "EB Garamond"],
    ["Acme Sans Serif", "Inter"],
    ["Unheard Of", "Inter"],
  ])("%s → %s", (name, nearest) => {
    expect(nearestInstalledFont(name)).toBe(nearest);
  });

  it("is named in the problem, with the installed list", () => {
    const [problem] = deckStyleProblems("<!-- body-font: Montserrat -->\n# A");
    expect(problem).toContain("nearest installed font is League Spartan");
    expect(problem).toContain("Installed: Inter, Roboto");
  });
});

describe("withDeckStyle", () => {
  const minimal = resolveTheme(undefined);

  it("switches a light theme to dark, keeping text, muted and primary legible", () => {
    const dark = withDeckStyle(minimal, { mode: "dark" });
    expect(dark.palette.background).toBe(MODE_GROUNDS.dark);
    expect(contrastRatio(dark.palette.text, dark.palette.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.palette.primary, dark.palette.background)).toBeGreaterThanOrEqual(3);
    expect(dark.onPrimary).toBeDefined();
  });

  it("leaves a theme already in the asked mode alone", () => {
    expect(withDeckStyle(minimal, { mode: "light" }).palette).toEqual(minimal.palette);
  });

  it("lets a palette background win over the mode, and sets the fonts", () => {
    const styled = withDeckStyle(minimal, { background: "#fdf6e3", mode: "dark", headingFont: "Bebas Neue" });
    expect(styled.palette.background).toBe("#fdf6e3");
    expect(styled.fonts).toEqual({ heading: "Bebas Neue", body: minimal.fonts.body });
  });

  it("replaces text that would not read, as resolveTheme does", () => {
    expect(withDeckStyle(minimal, { background: "#000000", text: "#111111" }).palette.text).not.toBe("#111111");
  });
});

describe("the exported deck", () => {
  it("is drawn in the deck's style, and a slide's bg-color on that slide alone", async () => {
    const source = "<!-- palette: #0b1020 #f5f5f5 #ff5a36 -->\n<!-- heading-font: Bebas Neue -->\n# Launch\n---\n<!-- bg-color: #ffffff -->\n## Light one\n- a";
    const { html } = await buildSlidesHtml({ source, renderMarkdown: markdownToHtml });
    expect(html).toContain("--t-bg:#0b1020;");
    expect(html).toContain("--t-accent:#ff5a36;");
    expect(html).toContain('--t-font-heading:"Bebas Neue", sans-serif;');
    const sections = html.split("<section").slice(1);
    expect(sections[0]).toContain("tone-dark");
    expect(sections[0]).not.toContain("style=\"--t-bg");
    expect(sections[1]).toContain("tone-light");
    expect(sections[1]).toContain('style="--t-bg:#ffffff;');
    expect(html).not.toContain("palette:");
    expect(html).not.toContain("bg-color");
  });
});
