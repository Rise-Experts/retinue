/**
 * #666 (AR-20, F17): the export renders a slide's markdown as the panel does. The expected HTML lives in
 * `slide-markdown-fixture.ts`, which the web suite renders through the panel's `SlideMarkdown` — so a case
 * passing here and there is the parity, not two tests that happen to agree.
 */
import { describe, expect, it } from "vitest";

import { markdownToHtml, slideMarkdownToHtml } from "../document.js";
import { buildSlidesHtml } from "../slides.js";
import { SLIDE_MARKDOWN_CASES, SLIDE_MARKDOWN_DECK, normaliseSlideHtml } from "./slide-markdown-fixture.js";

describe("slideMarkdownToHtml", () => {
  for (const c of SLIDE_MARKDOWN_CASES) {
    it(`renders ${c.name} as the panel does`, async () => {
      expect(normaliseSlideHtml(await slideMarkdownToHtml(c.markdown))).toBe(c.html);
    });
  }

  it("leaves the document renderer alone: a document still keeps its raw HTML", async () => {
    // Stripping is the slide decision; a report's `<sup>` or `<br>` is not a slide.
    expect(await markdownToHtml("H<sub>2</sub>O")).toContain("<sub>2</sub>");
  });

  it("still turns a mermaid fence into a render target", async () => {
    expect(await slideMarkdownToHtml("```mermaid\ngraph TD; A-->B\n```")).toContain('class="mermaid"');
  });
});

describe("the exported deck", () => {
  it("prints task lists and strikethrough, and no raw HTML", async () => {
    const { html } = await buildSlidesHtml({ source: SLIDE_MARKDOWN_DECK, renderMarkdown: slideMarkdownToHtml });
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('<input type="checkbox" disabled="" checked=""/>');
    expect(html).toContain("<del>$49</del>");
    expect(html).not.toContain('style="color:red"');
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).not.toContain("<!-- note -->");
  });
});
