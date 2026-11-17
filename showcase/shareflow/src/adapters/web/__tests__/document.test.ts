/**
 * The document pipeline: what HTML we build, which is *"the part most likely to be wrong"*.
 *
 * WHY SEPARATE FROM THE RENDER: the old file says it — the conversion rules are testable without a
 * browser, and whether Chromium can print HTML is not in doubt. What is in doubt is whether a mermaid
 * fence becomes a diagram or a code block, whether a model's `<html>` wrapper silently drops the page
 * setup, and whether an image ends up on its own page.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_IMAGES,
  RENDER_DIAGRAMS_JS,
  buildDocumentHtml,
  documentHasDiagrams,
  layoutWidthOf,
  markdownToHtml,
  pageBoxOf,
  pageCountOf,
  pageSetupCss,
} from "../document.js";

describe("page setup (#661)", () => {
  it("turns each page for its orientation; 16:9 is landscape and 4:5 portrait by shape", () => {
    expect(pageBoxOf({})).toBeUndefined();
    expect(pageBoxOf({ page: "A4" })).toEqual({ width: 794, height: 1123 });
    expect(pageBoxOf({ orientation: "landscape" })).toEqual({ width: 1123, height: 794 });
    expect(pageBoxOf({ page: "16:9" })).toEqual({ width: 1920, height: 1080 });
    expect(pageBoxOf({ page: "16:9", orientation: "portrait" })).toEqual({ width: 1080, height: 1920 });
    expect(pageBoxOf({ page: "4:5", orientation: "landscape" })).toEqual({ width: 1350, height: 1080 });
  });

  it("names paper by name and a screen format by its pixels", () => {
    expect(pageSetupCss({ page: "Letter", orientation: "landscape" }).tail).toBe("@page { size: letter landscape; }");
    expect(pageSetupCss({ page: "A4" }).tail).toBe("@page { size: A4 portrait; }");
    expect(pageSetupCss({ page: "4:5" })).toEqual({ head: "@page { margin: 0; }", tail: "@page { size: 1080px 1350px; }" });
  });

  it("keeps room at the foot for page numbers, and leaves a wide enough margin alone", () => {
    expect(pageSetupCss({ margin: 0, pageNumbers: true }).tail).toContain("margin: 0mm; margin-bottom: 12mm;");
    expect(pageSetupCss({ margin: 20, pageNumbers: true }).tail).not.toContain("margin-bottom");
    expect(pageSetupCss({ pageNumbers: true }).tail).toContain('@bottom-center { content: counter(page) " / " counter(pages);');
  });

  it("measures the layout at the page less its side margins", () => {
    expect(layoutWidthOf({})).toBeUndefined();
    expect(layoutWidthOf({ page: "16:9" })).toBe(1920);
    expect(layoutWidthOf({ margin: 0 })).toBe(794);
    // A4 less 16 mm a side — the printable width the renderer has always measured against.
    expect(layoutWidthOf({ page: "A4" })).toBe(673);
  });

  it("puts what was asked after a model's html body, so it wins over the page's own @page", async () => {
    const html = await buildDocumentHtml({ kind: "html", source: "<style>@page{margin:20mm}</style><p>x</p>", pageSetup: { margin: 0 } });
    expect(html.indexOf("@page { margin: 0mm; }")).toBeGreaterThan(html.indexOf("@page{margin:20mm}"));
    expect(html.endsWith("<style>@page { margin: 0mm; }</style></body></html>")).toBe(true);
  });
});

describe("markdownToHtml", () => {
  it("turns a mermaid fence into a render target, not a code block", async () => {
    /**
     * *"By default a ```mermaid fence renders as `<pre><code class="language-mermaid">`, and Chromium
     * prints that as the diagram's SOURCE TEXT — which is exactly what it did."*
     */
    const html = await markdownToHtml("```mermaid\nflowchart LR\n  A --> B\n```\n");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain("language-mermaid");
  });

  it("repairs the diagram source on the way in", async () => {
    // So the string mermaid parses is the string that was embedded — one source, one place.
    const html = await markdownToHtml("```mermaid\nflowchart LR\n  A[Draft (v2)] --> B\n```\n");
    expect(html).toContain("&quot;Draft (v2)&quot;");
  });

  it("leaves an empty fence as ordinary content", async () => {
    /**
     * *"An empty fence would make `mermaid.parse()` fail and take the entire document down with it."* So
     * it falls through to the default renderer and prints as a code block.
     */
    const html = await markdownToHtml("```mermaid\n\n```\n");
    expect(html).not.toContain('<pre class="mermaid">');
  });

  it("leaves other fences alone", async () => {
    const html = await markdownToHtml("```js\nconst x = 1;\n```\n");
    expect(html).toContain("language-js");
    expect(html).not.toContain('class="mermaid"');
  });

  it("renders the things a report is made of", async () => {
    // Headings, lists and tables — `table` is enabled explicitly, since commonmark has none.
    const html = await markdownToHtml("# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<table>");
  });
});

describe("buildDocumentHtml", () => {
  it("wraps plain text verbatim, escaped", async () => {
    const html = await buildDocumentHtml({ kind: "text", source: "<b>not bold</b>", title: "Notes" });
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain("<h1>Notes</h1>");
  });

  it("uses html as the body so the print setup always applies", async () => {
    /**
     * *"A model-supplied `<html>` wrapper would otherwise silently drop the page setup."* The A4 size,
     * the margins and the diagram CSS are all in the wrapper this builds.
     */
    const html = await buildDocumentHtml({ kind: "html", source: "<html><body><p>Body</p></body></html>" });
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html).toContain("@page { size: A4;");
    expect(html).toContain("<p>Body</p>");
  });

  it("does not add a heading to an html body", async () => {
    // A model writing a body has usually written its own, and two headings is worse than none.
    const html = await buildDocumentHtml({ kind: "html", source: "<h1>Mine</h1>", title: "Theirs" });
    expect(html).not.toContain("<h1>Theirs</h1>");
    // The title still reaches `<title>`, which is what a PDF viewer shows.
    expect(html).toContain("<title>Theirs</title>");
  });

  it("gives every media image its own page", async () => {
    const html = await buildDocumentHtml({
      kind: "media",
      images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
    });
    expect(html.match(/class='media-page'/g)).toHaveLength(2);
    expect(html).toContain("page-break-after: always");
  });

  it("refuses a media document with no images, and one with too many", async () => {
    await expect(buildDocumentHtml({ kind: "media", images: [] })).rejects.toThrow(/No images/);
    await expect(
      buildDocumentHtml({ kind: "media", images: Array(MAX_DOCUMENT_IMAGES + 1).fill("data:image/png;base64,AAA") }),
    ).rejects.toThrow(/at most/);
  });

  it("refuses an empty source, a source too long, and an unknown kind", async () => {
    await expect(buildDocumentHtml({ kind: "text", source: "   " })).rejects.toThrow(/no content/);
    await expect(buildDocumentHtml({ kind: "text", source: "x".repeat(MAX_DOCUMENT_CHARS + 1) })).rejects.toThrow(
      /too long/,
    );
    await expect(buildDocumentHtml({ kind: "pptx" as never, source: "x" })).rejects.toThrow(/Unsupported kind/);
  });

  it("styles a diagram as a figure rather than a code block", async () => {
    /**
     * The `pre` rules would otherwise give it a grey card and monospace padding, which is wrong for a
     * figure — and `break-inside: avoid` is there for *"two real print failures: a diagram sliced in
     * half by a page break, and an SVG wider than the text column being clipped at the margin."*
     */
    const html = await buildDocumentHtml({ kind: "markdown", source: "```mermaid\nflowchart LR\n A --> B\n```\n" });
    expect(html).toContain("pre.mermaid {");
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("pre.mermaid svg { max-width: 100%");
  });

  it("uses no webfont, so the output does not depend on a network fetch", async () => {
    /**
     * *"No webfonts, because a font fetch from inside the container would either hang or silently fall
     * back, and either way the output must be deterministic."* The page also refuses off-host requests,
     * so one would simply not arrive.
     */
    const html = await buildDocumentHtml({ kind: "text", source: "x" });
    expect(html).not.toContain("@import");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).toContain("-apple-system");
  });
});

describe("documentHasDiagrams", () => {
  it("finds a diagram from the fence rule and one written by hand", async () => {
    /**
     * The detector is what lets a plain report *"pay nothing for the capability"* — and matching on the
     * marker class also covers a diagram a model supplied directly as `kind: "html"`, which never went
     * through the fence rule.
     */
    expect(documentHasDiagrams(await buildDocumentHtml({ kind: "markdown", source: "```mermaid\nflowchart LR\n A-->B\n```" }))).toBe(true);
    expect(documentHasDiagrams(await buildDocumentHtml({ kind: "html", source: '<pre class="mermaid">flowchart LR\n A-->B</pre>' }))).toBe(true);
    expect(documentHasDiagrams(await buildDocumentHtml({ kind: "text", source: "just words" }))).toBe(false);
  });
});

describe("the multi-diagram script", () => {
  it("reports which diagram failed, not that one did", () => {
    /**
     * The 1-based index *"matters here in a way it does not for a standalone diagram, because a report
     * can hold several and 'the second diagram' is the difference between a fixable error and a guess."*
     */
    expect(RENDER_DIAGRAMS_JS).toContain("index: i + 1");
    expect(RENDER_DIAGRAMS_JS).toContain("return { ok: true, count: nodes.length }");
  });

  it("keeps mermaid's error banner out of the printed page", () => {
    /**
     * *"Without it mermaid appends its own 'Syntax error in text' block to `document.body` — which in a
     * PRINTED document means that banner lands in the PDF."*
     */
    expect(RENDER_DIAGRAMS_JS).toContain("suppressErrorRendering: true");
    expect(RENDER_DIAGRAMS_JS).toContain("securityLevel: 'strict'");
  });

  it("parses every diagram before running any of them", () => {
    // One bad diagram in a five-diagram report should be named, not discovered halfway through a render.
    expect(RENDER_DIAGRAMS_JS.indexOf("mermaid.parse")).toBeLessThan(RENDER_DIAGRAMS_JS.indexOf("mermaid.run"));
  });
});

describe("pageCountOf", () => {
  it("counts the leaves and not the tree", () => {
    // `/Type /Pages` is the tree node and `/Type /Page` is a leaf, so the difference is the leaves.
    const pdf = new TextEncoder().encode("%PDF-1.4 /Type /Pages /Type /Page /Type /Page /Type /Page");
    expect(pageCountOf(pdf)).toBe(3);
  });

  it("never reports zero pages for a real PDF", () => {
    // Best-effort: *"a nicety for the reply text, never something to fail a successful render over."*
    expect(pageCountOf(new TextEncoder().encode("%PDF-1.4 nothing recognisable"))).toBe(1);
  });
});

describe("pictures and the logo in a document — #615", () => {
  it("prints a markdown document's chorus-media images from the inlined bytes, and the rest as alt text", async () => {
    const { buildDocumentHtml, markdownImageSources } = await import("../document.js");
    const source = "# Brief\n\n![Latte art](chorus-media:ws/generated/a.jpg)\n\n*Photo by Ana on Pexels*\n\n![Gone](chorus-media:ws/generated/b.jpg)";
    expect(markdownImageSources(source)).toEqual(["chorus-media:ws/generated/a.jpg", "chorus-media:ws/generated/b.jpg"]);
    const html = await buildDocumentHtml({
      kind: "markdown",
      source,
      inlineImages: { "chorus-media:ws/generated/a.jpg": "data:image/jpeg;base64,QUFB" },
    });
    expect(html).toContain(`<img src="data:image/jpeg;base64,QUFB" alt="Latte art" />`);
    expect(html).toContain("<em>Gone</em>");
    expect(html).not.toContain("chorus-media:");
  });

  it("puts the project's logo in the header, on the side of the theme's corner", async () => {
    const { buildDocumentHtml } = await import("../document.js");
    const { resolveTheme } = await import("../../../design/theme.js");
    const right = await buildDocumentHtml({ kind: "markdown", source: "Hi", theme: resolveTheme({ themeId: "corporate" }), logo: "data:image/png;base64,TE9HTw==" });
    expect(right).toContain(`<div class='t-head right'><img class='t-logo' src="data:image/png;base64,TE9HTw==" alt=''></div><div class='t-rule'></div>`);
    const left = await buildDocumentHtml({ kind: "markdown", source: "Hi", theme: resolveTheme({ themeId: "editorial" }), logo: "data:image/png;base64,TE9HTw==" });
    expect(left).toContain("<div class='t-head'><img class='t-logo'");
    const none = await buildDocumentHtml({ kind: "markdown", source: "Hi", theme: resolveTheme({ logoPlacement: "none" }), logo: "data:image/png;base64,TE9HTw==" });
    expect(none).not.toContain("t-logo'");
    const plain = await buildDocumentHtml({ kind: "markdown", source: "Hi" });
    expect(plain).not.toContain("t-head");
  });
});
