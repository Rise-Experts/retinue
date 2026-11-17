/**
 * Slides — #607. The splitting and layout rules are the part most likely to be wrong, and they are pure, so
 * they are pinned here over a matrix; the web panel's copy is diffed against this module over the same kind
 * of matrix in `web/src/lib/assistant/__tests__/slides.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../design/theme.js";
import { markdownToHtml } from "../document.js";
import {
  CAROUSEL_MAX_SLIDES,
  MAX_SLIDES,
  SLIDE_FORMATS,
  buildSlidesHtml,
  inferLayout,
  parseSlides,
  slideImageSources,
  splitSlides,
  countUpText,
} from "../slides.js";

const DECK = [
  "<!-- format: 4:5 -->",
  "# Why we ship weekly",
  "A field report",
  "---",
  "## What changed",
  "- Smaller releases",
  "- Faster feedback",
  "- Fewer rollbacks",
  "---",
  "## Rollbacks",
  "87%",
  "fewer than last year",
  "---",
  "> Shipping weekly made us braver, not riskier.",
  "— Dana, CTO",
  "---",
  "<!-- layout: cta -->",
  "## Try it next sprint",
  "**Start with one team**",
].join("\n");

describe("splitting a deck", () => {
  it("splits at lines of --- and drops a chunk that is only directives", () => {
    expect(splitSlides("<!-- format: 16:9 -->\n---\n# A\n---\nB\n\n---\n\n")).toEqual(["# A", "B"]);
  });

  it("does not split at a --- inside a fenced code block", () => {
    const chunks = splitSlides("## Config\n```yaml\na: 1\n---\nb: 2\n```\n---\n# Next");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("b: 2");
  });

  it("accepts CRLF line endings and indented separators", () => {
    expect(splitSlides("# A\r\n  ---  \r\n# B")).toEqual(["# A", "# B"]);
  });
});

describe("inferring a layout", () => {
  it.each([
    ["# Title only", "title"],
    ["# Title\nWith a subtitle", "title"],
    ["# Title\n- a bullet", "bullets"],
    ["# Title\nline one\nline two", "bullets"],
    ["## Heading\n- one\n- two", "bullets"],
    ["87%", "stat"],
    ["## Growth\n87%\nyear on year", "stat"],
    ["# 3.5x", "stat"],
    ["**$1.2m** ", "stat"],
    ["10,000+\nsign-ups", "stat"],
    // #620: two to four figures are a stat grid.
    ["## Two figures\n87%\n12%", "stat-grid"],
    ["- 87% of teams\n- 12% of teams", "stat-grid"],
    ["> A quote", "quote"],
    ["> A quote\n— Someone", "quote"],
    ["## Said\n> line one\n> line two\n-- Someone", "quote"],
    ["> A quote\nand a paragraph\nand another", "bullets"],
    ["![The team](chorus-media:ws/abc.png)", "image"],
    ["## Our office\n![Office](chorus-media:ws/office.jpg)\nBerlin, 2026", "image"],
    ["![Chart](https://example.test/chart.png)", "image"],
    ["![Local](./chart.png)", "bullets"],
    // #620: several pictures without captions are a logo wall.
    ["![a](chorus-media:ws/a.png)\n![b](chorus-media:ws/b.png)", "logos"],
    ["Just a paragraph", "bullets"],
  ])("%j is %s", (chunk, layout) => {
    expect(inferLayout(chunk)).toEqual({ layout, forced: false });
  });

  it("takes a layout directive over the content, and ignores one it does not know", () => {
    expect(inferLayout("<!-- layout: stat -->\n## Heading\n- a\n- b")).toEqual({ layout: "stat", forced: true });
    expect(inferLayout("<!--layout:CTA-->\n## Go")).toEqual({ layout: "cta", forced: true });
    expect(inferLayout("<!-- layout: hero -->\n# Title")).toEqual({ layout: "title", forced: false });
  });

  it("parses a whole deck, with the directives stripped from the bodies", () => {
    const deck = parseSlides(DECK);
    expect(deck.format).toBe("4:5");
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "bullets", "stat", "quote", "cta"]);
    expect(deck.slides.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(deck.slides[4]?.forced).toBe(true);
    expect(deck.slides.every((s) => !s.body.includes("<!--"))).toBe(true);
    expect(parseSlides("# A").format).toBeUndefined();
  });

  it("lists each image source once, in order", () => {
    const deck = parseSlides("![a](chorus-media:ws/a.png)\n---\n![b](https://x.test/b.png)\n---\n![a again](chorus-media:ws/a.png)");
    expect(slideImageSources(deck)).toEqual(["chorus-media:ws/a.png", "https://x.test/b.png"]);
  });
});

describe("the slide page", () => {
  it("is one section per slide at the format's exact size, one per printed page", async () => {
    const built = await buildSlidesHtml({ source: DECK, renderMarkdown: markdownToHtml });
    expect(built).toMatchObject({ format: "4:5", width: 1080, height: 1350, count: 5 });
    expect(built.html.match(/<section class="slide /g)).toHaveLength(5);
    expect(built.html).toContain("@page { size: 1080px 1350px; margin: 0; }");
    expect(built.html).toContain('data-layout="stat"');
    expect(built.html).toContain('<div class="s-stat" style="--n:3" data-figure="87%">87%</div>');
    expect(built.html).toContain('<div class="s-attr">— Dana, CTO</div>');
    expect(built.html).toContain('<div class="s-num">02<span> / 05</span></div>');
    expect(built.html.match(/<!doctype html>/gi)).toHaveLength(1);
  });

  it("takes 16:9 from the deck's directive, and a caller's format over it", async () => {
    const landscape = await buildSlidesHtml({ source: "<!-- format: 16:9 -->\n# A", renderMarkdown: markdownToHtml });
    expect(landscape).toMatchObject({ format: "16:9", width: 1920, height: 1080 });
    expect(landscape.html).toContain("@page { size: 1920px 1080px; margin: 0; }");
    // Sizes scale with the shorter side, so both formats share a unit of 10.8px.
    expect(landscape.html).toContain("--u: 10.8px;");
    const forced = await buildSlidesHtml({ source: "<!-- format: 16:9 -->\n# A", format: "4:5", renderMarkdown: markdownToHtml });
    expect(forced.format).toBe("4:5");
    expect(SLIDE_FORMATS["4:5"]).toEqual({ width: 1080, height: 1350 });
  });

  it("wears the project's theme, and the default preset without one", async () => {
    const themed = await buildSlidesHtml({ source: DECK, theme: resolveTheme({ themeId: "editorial", palette: { primary: "#123456" } }), renderMarkdown: markdownToHtml });
    expect(themed.html).toContain("--t-primary:#123456;");
    expect(themed.html).toContain('--t-font-heading:"EB Garamond", serif;');
    const plain = await buildSlidesHtml({ source: DECK, renderMarkdown: markdownToHtml });
    expect(plain.html).toContain(`--t-primary:${resolveTheme(undefined).palette.primary};`);
  });

  it("inlines the images it was given and draws the rest as their alt text — the page fetches nothing", async () => {
    const built = await buildSlidesHtml({
      // Two pictures on a slide forced to bullets are inline — and, not inlined, their alt text.
      source: "![Team photo](chorus-media:ws/a.png)\n---\n![Missing one](chorus-media:ws/b.png)\n---\n<!-- layout: bullets -->\n## Mixed\n![inline](chorus-media:ws/c.png)\n![other](chorus-media:ws/d.png)",
      images: { "chorus-media:ws/a.png": "data:image/png;base64,AAAA" },
      renderMarkdown: markdownToHtml,
    });
    expect(built.html).toContain('<img src="data:image/png;base64,AAAA" alt="Team photo">');
    expect(built.html).toContain('<div class="s-missing">Missing one</div>');
    expect(built.html).toContain("<em>inline</em>");
    expect(built.html).not.toContain("chorus-media:");
  });

  it("refuses an empty deck and one past the slide limit, by count", async () => {
    await expect(buildSlidesHtml({ source: "  \n---\n", renderMarkdown: markdownToHtml })).rejects.toThrow(/no slides/);
    const long = Array.from({ length: MAX_SLIDES + 1 }, (_, i) => `# ${i}`).join("\n---\n");
    await expect(buildSlidesHtml({ source: long, renderMarkdown: markdownToHtml })).rejects.toThrow(`at most ${MAX_SLIDES} slides`);
    expect(CAROUSEL_MAX_SLIDES).toBe(10);
  });

  it("escapes the stat and the attribution, which it writes itself rather than through markdown", async () => {
    const built = await buildSlidesHtml({ source: "> q\n— <script>x</script>", renderMarkdown: markdownToHtml });
    expect(built.html).not.toContain("<script>x");
    expect(built.html).toContain("&lt;script&gt;");
  });
});

describe("a figure leading its label", () => {
  // Production, 2026-09-28: the model wrote the stat slide as "3x More Engagement" and it drew as a plain line.
  it("is a stat slide, the figure big and the label under it", async () => {
    const { inferLayout, statParts } = await import("../slides.js");
    expect(inferLayout("3x More Engagement").layout).toBe("stat");
    expect(inferLayout("## Why it works\n\n45% of buyers read the comments").layout).toBe("stat");
    expect(statParts("3x More Engagement")).toEqual({ figure: "3x", label: "More Engagement" });
    expect(statParts("$2M raised in Q3")).toEqual({ figure: "$2M", label: "raised in Q3" });
  });

  it("leaves a bare count and a sentence as text", async () => {
    const { inferLayout } = await import("../slides.js");
    expect(inferLayout("3 tips for better posts").layout).toBe("bullets");
    expect(inferLayout("3x More Engagement\n\nand then a longer paragraph explaining it").layout).toBe("bullets");
  });
});

describe("visual slides — #615", () => {
  it("reads a background, a credit, and the two image-beside-text layouts", async () => {
    const { parseSlides, inferLayout, slideImageSources } = await import("../slides.js");
    const deck = parseSlides(
      [
        "<!-- background: chorus-media:ws/bg.jpg -->\n<!-- credit: Photo by Ana on Pexels -->\n# Coffee culture",
        "<!-- background: chorus-media:ws/only.jpg -->",
        "## Beans\n![Beans](chorus-media:ws/beans.jpg)\n- Arabica\n- Robusta",
        "<!-- layout: image-left -->\n## Roast\n![Roast](chorus-media:ws/roast.jpg)\nDark and light",
      ].join("\n---\n"),
    );
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "bullets", "image-right", "image-left"]);
    expect(deck.slides[0]).toMatchObject({ background: "chorus-media:ws/bg.jpg", credit: "Photo by Ana on Pexels", body: "# Coffee culture" });
    // A slide that is only a background picture is kept, not dropped as empty.
    expect(deck.slides[1]).toMatchObject({ background: "chorus-media:ws/only.jpg", body: "" });
    expect(slideImageSources(deck)).toEqual([
      "chorus-media:ws/bg.jpg",
      "chorus-media:ws/only.jpg",
      "chorus-media:ws/beans.jpg",
      "chorus-media:ws/roast.jpg",
    ]);
    // An image with a heading and a caption is still the image layout.
    expect(inferLayout("## Office\n![Office](chorus-media:ws/o.jpg)\nBerlin").layout).toBe("image");
    // A background must be a workspace reference or https — anything else is ignored.
    expect(parseSlides("<!-- background: javascript:alert(1) -->\n# T").slides[0]?.background).toBeUndefined();
  });

  it("draws the background under a tinted shade, the logo in the theme's corner, and the credit", async () => {
    const built = await buildSlidesHtml({
      source: "<!-- background: chorus-media:ws/bg.jpg -->\n<!-- credit: Photo by Ana on Pexels -->\n# Coffee\n---\n## Point\n- one",
      images: { "chorus-media:ws/bg.jpg": "data:image/jpeg;base64,BBBB" },
      logo: "data:image/png;base64,LOGO",
      theme: resolveTheme({ themeId: "corporate" }),
      renderMarkdown: markdownToHtml,
    });
    expect(built.html).toContain('class="slide l-title f-portrait tone-light v0 has-bg logo-top-right"');
    // #620: the photo is a variable the duotone layers compose over, not the element's own background.
    expect(built.html).toContain(`<div class="s-bg" style='--bg:url(&quot;data:image/jpeg;base64,BBBB&quot;)'></div><div class="s-shade"></div>`);
    expect(built.html).toContain('<div class="s-credit">Photo by Ana on Pexels</div>');
    // Every slide carries the logo.
    expect(built.html.match(/<img class="s-logo top-right" src="data:image\/png;base64,LOGO" alt="">/g)).toHaveLength(2);
    // A slide with its own picture gets no decorative shapes.
    expect(built.html).not.toMatch(/has-bg[^>]*>(?:(?!<\/section>).)*s-deco/);
    expect(built.html).not.toContain("chorus-media:");
  });

  it("leaves the logo off when the theme's corner is none", async () => {
    const built = await buildSlidesHtml({
      source: "# A",
      logo: "data:image/png;base64,LOGO",
      theme: resolveTheme({ logoPlacement: "none" }),
      renderMarkdown: markdownToHtml,
    });
    expect(built.html).not.toContain(`<img class="s-logo`);
  });

  it("gives a text-only deck graphics: shapes on title and cta, a ring for a percentage, a bar otherwise", async () => {
    const { statRing } = await import("../slides.js");
    const built = await buildSlidesHtml({
      source: "# Title\n---\n## Growth\n87%\nyear on year\n---\n$1.2m\nraised\n---\n<!-- layout: cta -->\n## Go",
      renderMarkdown: markdownToHtml,
    });
    expect(built.html.match(/<div class="s-deco">/g)).toHaveLength(2);
    expect(built.html).toContain('<div class="s-ring" style="--p:87"><div class="s-stat" style="--n:3" data-figure="87%">87%</div></div>');
    expect(built.html).toContain('<div class="s-stat" style="--n:5" data-figure="$1.2m">$1.2m</div><div class="s-bar"></div>');
    expect(statRing("87%")).toBe(87);
    expect(statRing("12.5%")).toBe(12.5);
    expect(statRing("140%")).toBeNull();
    expect(statRing("3x")).toBeNull();
  });

  it("puts the picture beside the text, on the side the layout names", async () => {
    const built = await buildSlidesHtml({
      source: "<!-- layout: image-left -->\n## Roast\n![Roast](chorus-media:ws/r.jpg)\n- Dark",
      images: { "chorus-media:ws/r.jpg": "data:image/jpeg;base64,RRRR" },
      renderMarkdown: markdownToHtml,
    });
    expect(built.html).toContain('class="slide l-image-left f-portrait tone-light v0"');
    expect(built.html).toMatch(/<div class="s-split"><figure class="s-figure"><img src="data:image\/jpeg;base64,RRRR" alt="Roast"><\/figure><div class="s-text"><h2>Roast<\/h2>/);
  });
});

describe("modern layouts — #620", () => {
  it.each([
    ["## Section two", "section"],
    ["## 02 Results\nWhat we measured", "section"],
    ["# Part 2: Growth", "section"],
    ["# 3 tips for better posts", "title"],
    ["## Agenda\n- Intro\n- Results\n- Next", "agenda"],
    ["## Today\n1. Where we started\n2. What changed", "agenda"],
    ["## Today we launched\n- a new plan\n- a new price", "bullets"],
    ["## Roadmap\n- **Q1** — Pilot\n- **Q2** — Roll out\n- **Q3** — Automate", "timeline"],
    ["- 2024: Founded\n- 2025: Series A\n- 2026: 100 staff", "timeline"],
    ["## How\n- Step 1 Plan\n- Step 2 Build\n- Step 3 Ship", "timeline"],
    ["- Market research\n- Decide quickly\n- September plan", "bullets"],
    ["## The numbers\n- 3x faster\n- 45% fewer incidents\n- $1.2m saved", "stat-grid"],
    ["87%\nretention\n3x\nfaster", "stat-grid"],
    ["- 3x faster\n- 50% cheaper\n- Round the clock", "bullets"],
    ["## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats", "two-column"],
    ["### Before\n- slow\n### After\n- fast", "comparison"],
    ["## Us vs them\n### Chorus\n- one tool\n### Others\n- five tools", "comparison"],
    ["## Pros and cons\n### Pros\n- fast\n### Cons\n- new", "comparison"],
    ["## Team\n![A](chorus-media:ws/a.jpg)\nAna — CEO\n![B](chorus-media:ws/b.jpg)\nBo — CTO", "team"],
    ["![A](chorus-media:ws/a.jpg)\nAna\n![B](chorus-media:ws/b.jpg)\nBo", "team"],
    ["## Trusted by\n![A](chorus-media:ws/a.svg)\n![B](chorus-media:ws/b.svg)\n![C](chorus-media:ws/c.svg)", "logos"],
    ["> It works.\n— Dana, CTO\n![Dana](chorus-media:ws/d.jpg)", "quote"],
    ["## Ready?\nStart today\n[Book a demo](https://example.com/demo)", "cta"],
    ["## Follow along\n@chorus.app", "cta"],
    ["## Try it next sprint\n**Start with one team**", "cta"],
    ["## Heading\nOne sentence of context.", "bullets"],
  ])("%j is %s", (chunk, layout) => {
    expect(inferLayout(chunk)).toEqual({ layout, forced: false });
  });

  it("forces every layout by name", () => {
    for (const layout of ["section", "agenda", "timeline", "stat-grid", "two-column", "comparison", "team", "logos"]) {
      expect(inferLayout(`<!-- layout: ${layout} -->\n## H\n- a`)).toEqual({ layout, forced: true });
    }
  });

  it("reads an eyebrow from a directive or from a short line above the heading, and leaves the line out of the body", async () => {
    const { parseSlides } = await import("../slides.js");
    const deck = parseSlides(
      [
        "Field report · 2026\n# Why we ship",
        "<!-- eyebrow: Quick wins -->\n## What changed\n- a",
        "A whole sentence that ends here.\n## Heading\n- a",
        "87%\n## of teams",
        "Q3\n## Results\n- 3x faster\n- 45% fewer incidents",
      ].join("\n---\n"),
    );
    expect(deck.slides.map((s) => s.eyebrow)).toEqual(["Field report · 2026", "Quick wins", undefined, undefined, "Q3"]);
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "bullets", "bullets", "stat", "stat-grid"]);
    expect(deck.slides[0]?.body).toBe("# Why we ship");
    expect(deck.slides[1]?.body).toBe("## What changed\n- a");
  });

  it("takes the deck's transition from before the first ---, and a slide's own from the slide", async () => {
    const { parseSlides, slideTransition } = await import("../slides.js");
    const deck = parseSlides("<!-- transition: zoom -->\n---\n# A\n---\n<!-- transition: slide -->\n## B\n- b\n---\n<!-- transition: warp -->\n## C\n- c");
    expect(deck.transition).toBe("zoom");
    expect(deck.slides.map((s) => s.transition)).toEqual([undefined, "slide", undefined]);
    expect(deck.slides.map((s) => slideTransition(deck, s))).toEqual(["zoom", "slide", "zoom"]);
    expect(parseSlides("# A\n---\n## B").transition).toBeUndefined();
    // On the first slide it is the deck's too.
    expect(parseSlides("<!-- transition: none -->\n# A\n---\n## B").transition).toBe("none");
    expect(deck.slides.every((s) => !s.body.includes("<!--"))).toBe(true);
  });

  it("splits each layout into the parts both renderers draw", async () => {
    const { parseSlides, slideParts } = await import("../slides.js");
    const parts = parseSlides(
      [
        "## 02 Results\nWhat we measured",
        "## Agenda\n- **Intro**\n- Results",
        "## Roadmap\n- **Q1** — Pilot\n- Q2: Roll out\n- Step 3 Ship",
        "## Numbers\n87%\nretention\n- 3x faster",
        "## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats",
        "## Team\n![Ana](chorus-media:ws/a.jpg)\nAna Ruiz — CEO\n![Bo](chorus-media:ws/b.jpg)",
        "> It works.\n— Dana\n![Dana](chorus-media:ws/d.jpg)",
        "## Ready?\nStart today\n[Book a demo](https://example.com/demo)",
        "## Follow along\n@chorus.app",
        "## Growth\n87%\nyear on year",
        "## What changed\nIntro line\n- one\n- two",
      ].join("\n---\n"),
    ).slides.map(slideParts);
    expect(parts).toEqual([
      { before: "## Results\nWhat we measured", figure: "02", after: "" },
      { before: "## Agenda", items: [{ text: "Intro" }, { text: "Results" }], after: "" },
      { before: "## Roadmap", items: [{ label: "Q1", text: "Pilot" }, { label: "Q2", text: "Roll out" }, { label: "Step 3", text: "Ship" }], after: "" },
      { before: "## Numbers", items: [{ figure: "87%", text: "retention" }, { figure: "3x", text: "faster" }], after: "" },
      { before: "## Plans", columns: [{ heading: "### Starter", body: "- 3 seats" }, { heading: "### Team", body: "- 20 seats" }], after: "" },
      { before: "## Team", items: [{ image: { alt: "Ana", src: "chorus-media:ws/a.jpg" }, text: "Ana Ruiz", label: "CEO" }, { image: { alt: "Bo", src: "chorus-media:ws/b.jpg" }, text: "Bo" }], after: "" },
      { before: "> It works.", image: { alt: "Dana", src: "chorus-media:ws/d.jpg" }, attribution: "— Dana", after: "" },
      { before: "## Ready?", button: "Start today", link: "example.com/demo", after: "" },
      { before: "## Follow along", button: "@chorus.app", after: "" },
      { before: "## Growth", figure: "87%", after: "year on year" },
      { before: "## What changed\nIntro line", after: "- one\n- two" },
    ]);
  });

  it.each([
    ["87%", 0, "0%"],
    ["87%", 0.5, "76%"],
    ["87%", 1, "87%"],
    ["$1.2m", 0.5, "$1.1m"],
    ["10,000+", 0.5, "8,750+"],
    ["3.5x", 0, "0.0x"],
    ["€2,5", 0.5, "€2,2"],
    ["no figure", 0.5, "no figure"],
  ])("counts %j at %d as %j", (figure, progress, text) => {
    expect(countUpText(figure, progress)).toBe(text);
  });

  it("draws the new layouts in their own markup, escaped", async () => {
    const built = await buildSlidesHtml({
      source: [
        "## Agenda\n- <b>Intro</b>\n- Results",
        "## Roadmap\n- **Q1** — Pilot\n- **Q2** — Roll out\n- **Q3** — Automate",
        "## Numbers\n- 3x faster\n- 45% fewer incidents",
        "### Before\n- slow\n### After\n- fast",
        "## Team\n![Ana](chorus-media:ws/a.jpg)\nAna — CEO\n![Bo](chorus-media:ws/b.jpg)\nBo — CTO",
        "## Ready?\nStart today\n[Book a demo](https://example.com/demo)",
        "## 02 Results",
      ].join("\n---\n"),
      images: { "chorus-media:ws/a.jpg": "data:image/jpeg;base64,AAAA" },
      renderMarkdown: markdownToHtml,
    });
    expect(built.html).toContain('<li class="s-item" style="--i:0"><span class="s-k">01</span><span class="s-t">&lt;b&gt;Intro&lt;/b&gt;</span></li>');
    expect(built.html).toContain('<li class="s-step" style="--i:1"><span class="s-dot"></span><span class="s-when">Q2</span><span class="s-what">Roll out</span></li>');
    // A grid never draws a ring: the figures read as one row.
    expect(built.html).toContain('<div class="s-grid" style="--count:2"><div class="s-cell" style="--i:0"><div class="s-stat" style="--n:2" data-figure="3x">3x</div><div class="s-label">faster</div></div>');
    expect(built.html.slice(built.html.indexOf("<body"))).not.toMatch(/class="s-(?:ring|bar)"/);
    expect(built.html).toMatch(/<div class="s-cols"><div class="s-col" style="--i:0"><h3>Before<\/h3>[^]*?<\/div><div class="s-vs">vs<\/div><div class="s-col" style="--i:1">/);
    expect(built.html).toContain('<figure class="s-person" style="--i:0"><div class="s-photo"><img src="data:image/jpeg;base64,AAAA" alt="Ana"></div><figcaption><strong>Ana</strong><span>CEO</span></figcaption></figure>');
    // A portrait that could not be read is its name, not a broken image.
    expect(built.html).toContain('<div class="s-photo"><div class="s-missing">Bo</div></div>');
    expect(built.html).toContain('<div class="s-action"><span class="s-button">Start today<i class="s-arrow"></i></span><span class="s-link">example.com/demo</span></div>');
    // A section's own number is its big index.
    expect(built.html).toMatch(/l-section[^>]*>(?:(?!<\/section>).)*<div class="s-index" aria-hidden="true">02<\/div><div class="s-body"><h2>Results<\/h2>/);
    expect(built.transitions).toEqual(["fade", "fade", "fade", "fade", "fade", "fade", "fade"]);
    expect(built.html).not.toContain("<script>");
  });

  it("marks dark themes and landscape decks on every slide, as the panel does", async () => {
    const built = await buildSlidesHtml({ source: "# A\n---\n## B\n- b", theme: resolveTheme({ themeId: "dark-tech" }), format: "16:9", renderMarkdown: markdownToHtml });
    expect(built.html).toContain('class="slide l-title f-landscape tone-dark v0"');
    expect(built.html).toContain('class="slide l-bullets f-landscape tone-dark v1"');
    expect(built.html).toContain('<div class="s-index" aria-hidden="true">02</div>');
  });

  it("builds the video's page with the slides stacked and the player, and prints without them", async () => {
    const play = await buildSlidesHtml({ source: "<!-- transition: slide -->\n# A\n---\n## B\n- b", mode: "play", renderMarkdown: markdownToHtml });
    expect(play.html).toContain('<body class="s-deck-play">');
    expect(play.html).toContain("window.__slides");
    expect(play.transitions).toEqual(["slide", "slide"]);
    const print = await buildSlidesHtml({ source: "# A", renderMarkdown: markdownToHtml });
    expect(print.html).not.toContain("s-deck-play");
    expect(print.html).not.toContain("window.__slides");
  });
});

// Production, 2026-09-29: asked for a section divider and a Q1–Q4 timeline, the model's markdown drew both as bullets.
describe("section and timeline as the model writes them", () => {
  it("a ## heading with one short line is a section", async () => {
    const { inferLayout } = await import("../slides.js");
    expect(inferLayout("## Trends to Watch\nSection 01: Trend Overview").layout).toBe("section");
    expect(inferLayout("## Why it works\n- One\n- Two").layout).not.toBe("section");
  });

  it("list items like **Q1:** text are a timeline", async () => {
    const { inferLayout } = await import("../slides.js");
    const chunk = "## 2026 Timeline\n- **Q1:** Functional coffee\n- **Q2:** Portable formats\n- **Q3:** Fermentation\n- **Q4:** Adoption";
    expect(inferLayout(chunk).layout).toBe("timeline");
    expect(inferLayout("## Plan\n- **Q1** — Pilot\n- **Q2** — Roll out\n- **Q3** — Scale").layout).toBe("timeline");
  });
});

// Production, 2026-09-29: "- **Q1:** Rise of…" drew the step label as "Q1:".
describe("timeline labels", () => {
  it("drop the separator the model put inside the bold", async () => {
    const { parseSlides, slideParts } = await import("../slides.js");
    const deck = parseSlides("## 2026 Timeline\n- **Q1:** Functional coffee\n- **Q2** — Portable formats\n- **Q3:** Fermentation");
    const parts = slideParts(deck.slides[0]!) as { items?: { label?: string }[] };
    expect(parts.items?.map((i) => i.label)).toEqual(["Q1", "Q2", "Q3"]);
  });
});

// Production, 2026-09-29: 4:5 logo walls and two-column slides left an empty band above content pinned to the bottom.
describe("portrait layouts", () => {
  it("centre their content in the room under the head, as landscape does", async () => {
    const { SLIDE_DESIGN_CSS: SLIDE_CSS } = await import("../slide-design.js");
    expect(SLIDE_CSS).toContain(".slide.f-portrait:is(.l-two-column, .l-comparison, .l-columns, .l-stat-grid, .l-team, .l-logos) .s-body > :last-child { margin-block: auto; }");
    expect(SLIDE_CSS).toContain(".slide.f-portrait .s-cols { grid-template-columns: minmax(0, 1fr);");
  });
});

/**
 * #653 — a comment the renderer does not know is removed, and named for the tool to report.
 *
 * Production, 2026-09-30: `<!-- theme: dark-tech -->` above `# Kaffee Nord Catering` drew as the eyebrow
 * "<!-- THEME: DARK-TECH -->" on slide 1.
 */
describe("unknown directives (#653)", () => {
  it("never reaches a slide as text, eyebrow or otherwise", async () => {
    const { parseSlides, slideParts } = await import("../slides.js");
    const deck = parseSlides("<!-- format: 16:9 -->\n<!-- theme: dark-tech -->\n\n# Kaffee Nord Catering\n## Elevate your office coffee");
    const [first] = deck.slides;
    expect(first?.eyebrow).toBeUndefined();
    expect(first?.body).not.toContain("theme");
    expect(JSON.stringify(slideParts(first!))).not.toContain("theme");
    expect(deck.format).toBe("16:9");
  });

  it("keeps known directives and comments inside code blocks", async () => {
    const { splitSlides, unknownDirectives } = await import("../slides.js");
    const source = "# Title\n<!-- eyebrow: Q3 -->\n---\n## Code\n```html\n<!-- keep: me -->\n```";
    expect(splitSlides(source).join("\n")).toContain("<!-- eyebrow: Q3 -->");
    expect(splitSlides(source).join("\n")).toContain("<!-- keep: me -->");
    expect(unknownDirectives(source)).toEqual([]);
  });

  it("names each unknown directive once, and ignores plain comments", async () => {
    const { unknownDirectives } = await import("../slides.js");
    expect(unknownDirectives("<!-- theme: dark -->\n# A\n---\n<!-- font: Montserrat -->\n<!-- theme: x -->\n<!-- just a note -->\n# B")).toEqual(["theme", "font"]);
  });
});
