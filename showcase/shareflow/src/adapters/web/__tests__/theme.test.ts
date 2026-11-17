/**
 * #595 — each renderer's page carries the project theme, and an unthemed render is what it always was.
 * The HTML halves are pure, so this needs no browser; `render.ts` is driven with a recording page.
 */
import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../design/theme.js";
import { buildCodeSnippetHtml } from "../code-snippet.js";
import { MERMAID_RUN, buildDiagramHtml, mermaidThemeConfig } from "../diagram.js";
import { RENDER_DIAGRAMS_JS, buildDocumentHtml } from "../document.js";
import type { PageLike } from "../browser.js";
import { createBrowserRenderService } from "../render.js";

const light = resolveTheme({ themeId: "corporate", palette: { primary: "#0a7f5a", accent: "#f59e0b" } });
const dark = resolveTheme({ themeId: "dark-tech" });

describe("the code snippet", () => {
  it("draws the brand window: primary into accent behind it, the light code set on a light theme", () => {
    const html = buildCodeSnippetHtml({ code: "const a = 1;", theme: "brand", brand: light, title: "a.ts" });
    expect(html).toContain("linear-gradient(135deg,#0a7f5a 0%,#f59e0b 100%)");
    expect(html).toContain("background:#ffffff"); // the light window
    expect(html).toContain('"Open Sans", sans-serif'); // the title in the body font
    expect(html).toContain(`border-radius:${light.radius}px`);
  });

  it("uses the dark code set on a dark theme", () => {
    const html = buildCodeSnippetHtml({ code: "const a = 1;", theme: "brand", brand: dark });
    expect(html).toContain("background:#1e1e2e");
    expect(html).toContain("linear-gradient(135deg,#22d3ee 0%,#a855f7 100%)");
  });

  it("is unchanged without a brand", () => {
    const before = buildCodeSnippetHtml({ code: "const a = 1;" });
    expect(before).toContain("#1FC8DB 0%,#7c3aed 55%,#F5A623 100%");
    expect(buildCodeSnippetHtml({ code: "const a = 1;", theme: "brand" })).toBe(before);
    expect(buildCodeSnippetHtml({ code: "const a = 1;", theme: "dark", brand: light })).toBe(before);
  });
});

describe("the diagram", () => {
  it("carries mermaid themeVariables from the theme, and the run script reads them", () => {
    const html = buildDiagramHtml("flowchart LR\n A --> B", { width: 800, background: light.palette.background, theme: light });
    const block = html.match(/<script type="application\/json" id="t-mermaid">(.*?)<\/script>/)?.[1];
    expect(block).toBeDefined();
    const config = JSON.parse(block!);
    expect(config).toEqual(mermaidThemeConfig(light));
    expect(config).toMatchObject({
      theme: "base",
      themeVariables: { primaryColor: "#0a7f5a", primaryTextColor: light.onPrimary, lineColor: light.palette.muted, fontFamily: '"Open Sans", sans-serif' },
    });
    expect(MERMAID_RUN).toContain("getElementById('t-mermaid')");
    // The page's config can never loosen the security settings: they are applied after it.
    expect(MERMAID_RUN).toMatch(/picked, \{ startOnLoad: false, securityLevel: 'strict'/);
  });

  it("escapes the block so it cannot close its own script element", () => {
    const html = buildDiagramHtml("flowchart LR\n A --> B", { width: 800, background: "#fff", theme: light });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("is unchanged without a theme", () => {
    expect(buildDiagramHtml("flowchart LR\n A --> B", { width: 800, background: "#ffffff" })).not.toContain("t-mermaid");
  });
});

describe("the document", () => {
  it("gives headings a colour that reads on the background", async () => {
    // Production, 2026-09-28: dark-tech's #7B2FF7 headings on #170922 are 3.3:1 and read as dim.
    const { headingColor } = await import("../document.js");
    const { resolveTheme } = await import("../../../design/theme.js");
    const dark = resolveTheme({ themeId: "dark-tech", palette: { background: "#170922", primary: "#7b2ff7", accent: "#0099ff", text: "#ffffff" } });
    expect(headingColor(dark).toLowerCase()).toBe("#0099ff");
    expect(headingColor(resolveTheme({ palette: { background: "#170922", primary: "#2a044a", accent: "#3a0a5a", text: "#ffffff" } })).toLowerCase()).toBe("#ffffff");
  });

  it("injects the theme's fonts, colours, heading style and a themed rule", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: "# Plan\n\nBody.", theme: light });
    expect(html).toContain("--t-primary:#0a7f5a;");
    expect(html).toContain('--t-font-heading:"Roboto", sans-serif;');
    expect(html).toContain('--t-font-body:"Open Sans", sans-serif;');
    // #0a7f5a reads on this light background, so headings take the primary colour.
    expect(html).toContain("h1, h2, h3 { font-family: var(--t-font-heading); color: #0a7f5a; }");
    expect(html).toContain("<body><div class='t-rule'></div>");
    // After the print styling, so the theme wins over it.
    expect(html.indexOf("--t-primary")).toBeGreaterThan(html.indexOf("@page { size: A4;"));
    expect(RENDER_DIAGRAMS_JS).toContain("getElementById('t-mermaid')");
  });

  it("themes a media document too", async () => {
    const html = await buildDocumentHtml({ kind: "media", images: ["data:image/png;base64,AA=="], theme: dark });
    expect(html).toContain("--t-bg:#0b1020;");
  });

  it("is unchanged without a theme", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: "# Plan" });
    expect(html).not.toContain("--t-");
    expect(html).not.toContain("t-rule");
    expect(html).not.toContain("t-mermaid");
  });
});

describe("the render service applies the theme", () => {
  const recording = () => {
    const pages: string[] = [];
    const page = {
      url: () => "",
      async route() {},
      async setContent(html: string) {
        pages.push(html);
      },
      async addScriptTag() {},
      async evaluate<T>(expression: string) {
        return (expression.includes("scrollHeight") ? 300 : { ok: true }) as unknown as T;
      },
      async waitForSelector() {},
      locator: () => ({ count: async () => 1, boundingBox: async () => ({ width: 800, height: 300 }), screenshot: async () => new Uint8Array([1]) }),
      async screenshot() {
        return new Uint8Array([1]);
      },
      async setViewportSize() {},
    } as unknown as PageLike;
    const service = createBrowserRenderService({
      chromium: { async launch() { return { newPage: async () => page, close: async () => {} }; } } as never,
      settleMs: 0,
      mermaidBundlePath: "/app/vendor/mermaid.min.js",
    });
    return { service, pages };
  };

  it("draws a themed diagram on the theme's background", async () => {
    const { service, pages } = recording();
    await service.renderDiagram({} as never, { source: "flowchart LR\n A --> B", theme: dark });
    expect(pages[0]).toContain("background:#0b1020;");
    expect(pages[0]).toContain('"primaryColor":"#22d3ee"');
  });

  it("keeps white for an unthemed diagram, and transparency over a theme", async () => {
    const { service, pages } = recording();
    await service.renderDiagram({} as never, { source: "flowchart LR\n A --> B" });
    await service.renderDiagram({} as never, { source: "flowchart LR\n A --> B", transparent: true, theme: dark });
    expect(pages[0]).toContain("background:#ffffff;");
    expect(pages[1]).toContain("background:transparent;");
  });

  it("paints a document image on the theme's background rather than white", async () => {
    const { service, pages } = recording();
    await service.renderHtmlImage!({} as never, { html: "<html><head></head><body>x</body></html>", theme: dark });
    await service.renderHtmlImage!({} as never, { html: "<html><head></head><body>x</body></html>" });
    expect(pages[0]).toContain("html,body{background:#0b1020}");
    expect(pages[1]).toContain("html,body{background:#fff}");
  });

  it("draws the brand code window", async () => {
    const { service, pages } = recording();
    await service.renderCodeSnippet!({} as never, { code: "const a = 1;", theme: "brand", brand: light });
    expect(pages[0]).toContain("linear-gradient(135deg,#0a7f5a 0%,#f59e0b 100%)");
  });
});
