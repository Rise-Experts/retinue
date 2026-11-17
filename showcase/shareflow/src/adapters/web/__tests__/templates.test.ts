/**
 * #595 part 2 — templates for the code image, the diagram and the printed document. The HTML halves are
 * pure, so every frame, preset and template is checked here without a browser.
 */
import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../design/theme.js";
import { CODE_FRAMES, buildCodeSnippetHtml } from "../code-snippet.js";
import { DIAGRAM_PRESETS, MERMAID_CONFIG_JS, applyDiagramPreset, buildDiagramHtml, mermaidThemeConfig } from "../diagram.js";
import {
  DOCUMENT_TEMPLATES,
  TEMPLATE_MARKER,
  checklistItems,
  documentTemplateDirective,
  safeLogo,
  takeLeadingTitle,
} from "../document-templates.js";
import { FULL_BLEED_MARKER, buildDocumentHtml } from "../document.js";

const corporate = resolveTheme({ themeId: "corporate", palette: { primary: "#0a7f5a", accent: "#f59e0b" } });
const dark = resolveTheme({ themeId: "dark-tech" });
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

describe("code frames", () => {
  it("draws mac by default — the window it always drew", () => {
    const html = buildCodeSnippetHtml({ code: "const a = 1;", title: "a.ts" });
    expect(html).toContain('data-frame="mac"');
    expect(html).toContain("#ff5f57");
    expect(html).toContain('<span class="title">a.ts</span>');
    expect(buildCodeSnippetHtml({ code: "const a = 1;", title: "a.ts", frame: "mac" })).toBe(html);
  });

  it("minimal: no title bar or traffic lights, a soft border, the title as a caption", () => {
    const html = buildCodeSnippetHtml({ code: "x", title: "a.ts", frame: "minimal" });
    expect(html).not.toContain("#ff5f57");
    expect(html).not.toContain('<div class="bar"');
    expect(html).toContain('<div class="caption">a.ts</div>');
    expect(html).toContain("0 0 0 1px #7f849c33"); // the soft border, in the dark set's dim colour
  });

  it("terminal: a dark bar with a prompt glyph and the title as the command", () => {
    const html = buildCodeSnippetHtml({ code: "npm test", title: "run.sh", frame: "terminal", theme: "light" });
    expect(html).toContain('<div class="bar term"><span class="prompt">&#10095;</span><span class="cmd">run.sh</span></div>');
    expect(html).toContain(".term{gap:10px;background:#0d1117");
    expect(html).not.toContain("#ff5f57");
    // The prompt takes the string colour of the window's set — the light set here.
    expect(html).toContain("color:#15803d}");
  });

  it("none: just the code on a plain backdrop in the window's own colour", () => {
    const html = buildCodeSnippetHtml({ code: "x", frame: "none", theme: "brand", brand: dark });
    expect(html).toContain("#frame{background:#1e1e2e}");
    expect(html).toContain("#window{box-shadow:none;border-radius:0;min-width:0}");
    expect(html).not.toContain('class="bar');
    expect(html).not.toContain('class="caption"');
  });

  it("themes every frame: the brand backdrop and body font reach all four", () => {
    for (const frame of CODE_FRAMES) {
      const html = buildCodeSnippetHtml({ code: "x", title: "t", frame, theme: "brand", brand: corporate });
      expect(html, frame).toContain(`data-frame="${frame}"`);
      expect(html, frame).toContain("linear-gradient(135deg,#0a7f5a 0%,#f59e0b 100%)");
      expect(html, frame).toContain("background:#ffffff"); // the light window on a light theme
    }
    expect(buildCodeSnippetHtml({ code: "x", title: "t", frame: "minimal", theme: "brand", brand: corporate })).toContain('"Open Sans", sans-serif');
  });

  it("escapes the title in every frame, and treats an unknown frame as mac", () => {
    for (const frame of CODE_FRAMES) expect(buildCodeSnippetHtml({ code: "x", title: "<b>", frame })).not.toContain("<b>");
    expect(buildCodeSnippetHtml({ code: "x", frame: "fancy" as never })).toContain('data-frame="mac"');
  });
});

describe("diagram presets", () => {
  it("flow is the diagram as it was — no preset changes an unthemed flow", () => {
    const source = "flowchart\n  A --> B";
    const html = buildDiagramHtml(source, { width: 800, background: "#fff" });
    expect(html).toContain("data-preset='flow'");
    expect(html).toContain("flowchart\n  A --&gt; B</pre>");
    expect(html).not.toContain("t-mermaid");
    expect(buildDiagramHtml(source, { width: 800, background: "#fff", preset: "flow" })).toBe(html);
  });

  it("timeline: left to right, straight lines, milestone and done classes in the theme's colours", () => {
    const out = applyDiagramPreset("flowchart\n  A[Beta]:::done --> B[Launch]:::milestone", "timeline", corporate);
    expect(out.split("\n")[0]).toBe("flowchart LR");
    expect(out).toContain(`classDef milestone fill:${corporate.palette.accent}`);
    expect(out).toContain(`classDef done fill:#0a7f5a,stroke:#0a7f5a,stroke-width:2px,color:${corporate.onPrimary}`);
    expect(out).toContain(`classDef default fill:${corporate.palette.surface},stroke:#0a7f5a`);
    const config = mermaidThemeConfig(corporate, "timeline");
    expect(config.flowchart).toMatchObject({ curve: "linear" });
    // A native `timeline` diagram colours its sections from cScale — from the palette.
    expect(config.themeVariables).toMatchObject({ cScale0: "#0a7f5a", cScale1: "#f59e0b", cScaleLabel0: corporate.onPrimary });
  });

  it("org: top-down with right-angled lines, lead and team classes", () => {
    const out = applyDiagramPreset("graph\nCEO:::lead --> CTO", "org", corporate);
    expect(out.startsWith("graph TB\n")).toBe(true);
    expect(out).toContain("classDef lead fill:#0a7f5a");
    expect(out).toContain("classDef team ");
    expect(mermaidThemeConfig(corporate, "org").flowchart).toMatchObject({ curve: "step" });
  });

  it("comparison: top-down so the options sit side by side, option / pro / con classes, the con dashed", () => {
    const out = applyDiagramPreset("flowchart\nsubgraph A\n  a1[Plan A]:::option\nend", "comparison", corporate);
    expect(out.startsWith("flowchart TB\n")).toBe(true);
    expect(out).toContain("classDef option fill:#0a7f5a");
    expect(out).toContain("classDef pro ");
    expect(out).toMatch(/classDef con [^\n]*stroke-dasharray:5 4/);
  });

  it("keeps a direction and a class the source chose, and leaves other diagram kinds alone", () => {
    const own = applyDiagramPreset("%% note\nflowchart TD\n  A:::done --> B\n  classDef done fill:#000", "timeline", corporate);
    expect(own).toContain("flowchart TD");
    expect(own.match(/classDef done/g)).toHaveLength(1);
    expect(applyDiagramPreset("sequenceDiagram\n  A->>B: hi", "org", corporate)).toBe("sequenceDiagram\n  A->>B: hi");
    expect(applyDiagramPreset("timeline\n  2024 : Beta", "timeline", corporate)).toBe("timeline\n  2024 : Beta");
  });

  it("carries the preset into the page, themed, and outside a project in the Minimal theme", () => {
    for (const preset of DIAGRAM_PRESETS) {
      const html = buildDiagramHtml("flowchart\n  A --> B", { width: 800, background: "#fff", theme: dark, preset });
      expect(html, preset).toContain(`data-preset='${preset}'`);
      expect(html, preset).toContain('"primaryColor":"#22d3ee"');
    }
    const unthemed = buildDiagramHtml("flowchart\n  A --> B", { width: 800, background: "#fff", preset: "org" });
    expect(unthemed).toContain('"curve":"step"');
    expect(unthemed).toContain("classDef lead fill:#111827"); // Minimal's primary
  });

  it("reads only a preset's spacing and curve from the page — nothing else under flowchart", () => {
    expect(MERMAID_CONFIG_JS).toContain("['nodeSpacing', 'rankSpacing', 'padding']");
    expect(MERMAID_CONFIG_JS).toContain("/^(basis|linear|step|stepBefore|stepAfter|cardinal|monotoneX)$/");
    // The security settings still come last.
    expect(MERMAID_CONFIG_JS.indexOf("securityLevel: 'strict'")).toBeGreaterThan(MERMAID_CONFIG_JS.indexOf("picked.flowchart"));
  });
});

describe("document templates", () => {
  const md = "# Q4 plan\n\nThe summary.\n\n## Goals\n\n- [ ] Draft\n- [x] Approve\n\n| Week | Channel |\n|---|---|\n| 1 | LinkedIn |\n";

  it("prints as it always did without a template", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate });
    expect(html).not.toContain(TEMPLATE_MARKER);
    expect(html).toContain("<div class='t-rule'></div>");
  });

  it("every template: the themed page, a footer with page numbers, the title once in the header", async () => {
    for (const template of DOCUMENT_TEMPLATES) {
      const html = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template });
      expect(html, template).toContain(TEMPLATE_MARKER);
      expect(html, template).toContain(FULL_BLEED_MARKER);
      expect(html, template).toContain(`data-template='${template}'`);
      expect(html, template).toContain('@bottom-right { content: counter(page) " / " counter(pages);');
      expect(html, template).toContain('@bottom-left { content: "Q4 plan";');
      expect(html, template).toContain(`background: ${corporate.palette.background};`);
      expect(html, template).toContain('<h1 class="t-title">Q4 plan</h1>');
      expect(html.match(/Q4 plan<\/h1>/g), template).toHaveLength(1);
      expect(html, template).not.toContain("<div class='t-rule'></div>");
    }
  });

  it("report: a cover block with no footer on it, then numbered sections", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template: "report", logo: LOGO });
    expect(html).toContain('<section class="t-cover"><img class="t-logo" src="data:image/png;base64,iVBORw0KGgo=" alt="">');
    expect(html).toContain("@page :first { margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }");
    expect(html).toContain("counter(t-section, decimal-leading-zero)");
    expect(html).toContain("break-after: page");
  });

  it("the header band carries the logo when there is one, and nothing in its place when not", async () => {
    const withLogo = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template: "brief", logo: LOGO });
    expect(withLogo).toContain('<header class="t-head"><img class="t-logo" src="data:image/png;base64,iVBORw0KGgo=" alt=""><div class="t-titles"><div class="t-label">Brief</div>');
    const without = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template: "brief" });
    expect(without).toContain('<header class="t-head"><div class="t-titles">');
  });

  it("refuses a logo that is not an inlined image", () => {
    expect(safeLogo(LOGO)).toBe(LOGO);
    expect(safeLogo("https://example.com/logo.png")).toBeUndefined();
    expect(safeLogo('data:image/png;base64,AAAA" onerror="x')).toBeUndefined();
    expect(safeLogo("data:text/html;base64,AAAA")).toBeUndefined();
  });

  it("checklist: every item a box, [x] items ticked, the marker gone", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template: "checklist" });
    expect(html).toContain("<li>Draft</li>");
    expect(html).toContain('<li class="t-done">Approve</li>');
    expect(html).toContain(".t-body ul li::before");
    expect(checklistItems("<li>\n<p>[X] done</p></li>")).toBe('<li class="t-done">\n<p>done</p></li>');
  });

  it("campaign-plan: landscape, and tables with a filled header row and banded rows", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: md, theme: corporate, template: "campaign-plan" });
    expect(html).toContain("size: A4 landscape;");
    expect(html).toContain("th { background: var(--t-primary); color: var(--t-on-primary);");
    expect(html).toContain("tr:nth-child(even) td { background: var(--t-surface); }");
    expect(html).toContain("<table>");
  });

  it("one-pager and brief keep A4 portrait", async () => {
    for (const template of ["one-pager", "brief"] as const) {
      expect(await buildDocumentHtml({ kind: "markdown", source: md, template })).toContain("size: A4;\n");
    }
  });

  it("outside a project a template prints in the Minimal theme", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: md, template: "one-pager" });
    expect(html).toContain("--t-primary:#111827;");
  });

  it("a markdown document can name its template, and an explicit one wins", async () => {
    const source = "<!-- template: checklist -->\n# Launch\n\n- [ ] One";
    expect(documentTemplateDirective(source)).toBe("checklist");
    expect(documentTemplateDirective("<!-- template: poster -->")).toBeUndefined();
    expect(await buildDocumentHtml({ kind: "markdown", source, theme: corporate })).toContain("data-template='checklist'");
    expect(await buildDocumentHtml({ kind: "markdown", source, theme: corporate, template: "report" })).toContain("data-template='report'");
    // Only markdown reads the directive: a text document prints the comment as text.
    expect(await buildDocumentHtml({ kind: "text", source })).not.toContain(TEMPLATE_MARKER);
  });

  it("an explicit title wins over the document's own, and the document's heading stays when it differs", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: "# Inside\n\nBody", title: "Given", template: "brief" });
    expect(html).toContain('<h1 class="t-title">Given</h1>');
    expect(html).toContain("<h1>Inside</h1>");
    expect(takeLeadingTitle("<h1>A &amp; B</h1>\n<p>x</p>")).toEqual({ title: "A & B", body: "<p>x</p>" });
  });

  it("a footer title cannot break out of its CSS string", async () => {
    const html = await buildDocumentHtml({ kind: "markdown", source: "Body", title: 'a"; } body { x: "', template: "brief" });
    expect(html).toContain('@bottom-left { content: "a ; } body { x:  ";');
  });
});

// Production, 2026-09-29: a checklist whose markdown began with its template comment printed its title twice.
describe("the title prints once", () => {
  it("finds the leading title after a template comment", async () => {
    const { takeLeadingTitle, sameTitle } = await import("../document-templates.js");
    const taken = takeLeadingTitle("<!-- template: checklist -->\n<h1>Launch</h1>\n<ul></ul>");
    expect(taken.title).toBe("Launch");
    expect(taken.body.replace(/\s+/g, "")).toBe("<!--template:checklist--><ul></ul>");
    expect(sameTitle("Coffee Week Checklist", "coffee week checklist PDF")).toBe(true);
    expect(sameTitle("Launch", "Report")).toBe(false);
  });

  it("drops the duplicate heading from a templated document", async () => {
    const { buildDocumentHtml } = await import("../document.js");
    const html = await buildDocumentHtml({ kind: "markdown", source: "<!-- template: checklist -->\n# Coffee Week\n\n- [x] Goals\n- Assets", title: "Coffee Week" } as never);
    const body = html.slice(html.indexOf("<div class='t-body'>"));
    expect(body).not.toMatch(/<h1>\s*Coffee Week\s*<\/h1>/);
  });
});
