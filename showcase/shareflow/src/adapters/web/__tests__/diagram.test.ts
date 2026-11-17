/**
 * The mermaid page, the label repair and the background.
 *
 * WHY THIS FILE EXISTS: these are the pure parts of diagram rendering — the parts that can be wrong
 * without a browser noticing. The render itself is exercised against a real Chromium and real mermaid;
 * what is here is the source transform that fixed a production bug and the CSS interpolation that could
 * become an injection.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DIAGRAM_SOURCE_CHARS,
  MERMAID_RUN,
  buildDiagramHtml,
  escapeHtml,
  repairMermaidLabels,
  safeBackground,
} from "../diagram.js";

describe("repairMermaidLabels", () => {
  /**
   * *"Models write 'Mobile App (Client)' constantly"*, and `(` is a shape delimiter in mermaid's
   * grammar — so a bare one inside `[...]` is a parse error that kills the **whole** diagram. Verified
   * end to end against real mermaid: the repaired source renders, the raw source does not.
   */
  it("quotes a label containing parentheses", () => {
    expect(repairMermaidLabels("flowchart LR\n  A[Mobile App (Client)] --> B[API]")).toBe(
      'flowchart LR\n  A["Mobile App (Client)"] --> B[API]',
    );
  });

  it("leaves a label without parentheses byte-identical", () => {
    // Everything else is already valid, and touching it would be a transform nobody asked for.
    const source = "flowchart LR\n  A[Draft] --> B{Approved?}\n  B -->|yes| C[Publish]";
    expect(repairMermaidLabels(source)).toBe(source);
  });

  it("never double-quotes an already-quoted label", () => {
    const source = 'flowchart LR\n  A["Mobile App (Client)"] --> B[API]';
    expect(repairMermaidLabels(source)).toBe(source);
  });

  it("leaves a label containing a double quote alone", () => {
    /**
     * *"Quoting it would need escaping rules mermaid does not have — better to leave it and let the
     * fallback show the source than to produce differently broken output."*
     */
    const source = 'flowchart LR\n  A[He said "hi" (loudly)] --> B[API]';
    expect(repairMermaidLabels(source)).toBe(source);
  });

  it("does not touch a round node, whose delimiter IS the parenthesis", () => {
    // The naive rule would corrupt every one of them.
    const source = "flowchart LR\n  A(Start) --> B[API]";
    expect(repairMermaidLabels(source)).toBe(source);
  });

  it("repairs a brace label too, and only when the brackets pair", () => {
    expect(repairMermaidLabels("flowchart LR\n  B{Approved? (yes/no)} --> C[Go]")).toBe(
      'flowchart LR\n  B{"Approved? (yes/no)"} --> C[Go]',
    );
    // A mismatched pair means the regex straddled something it should not rewrite.
    const straddled = "flowchart LR\n  A[label (x)} --> B";
    expect(repairMermaidLabels(straddled)).toBe(straddled);
  });

  it("matches the copy the chat renderer uses", () => {
    /**
     * The third copy of this function — `web/src/lib/assistant/mermaid.ts` and
     * `ai_backend/app/core/makepdf.py` are the others — and the Python one exists because the first two
     * disagreed: *"a diagram that displayed fine in the conversation failed to export as an image, which
     * is exactly what happened in production."* This asserts the case that broke it.
     */
    expect(repairMermaidLabels("graph TD\n  Cache(Redis) --> Store[Postgres (primary)]")).toBe(
      'graph TD\n  Cache(Redis) --> Store["Postgres (primary)"]',
    );
  });
});

describe("safeBackground", () => {
  it("allows the shapes a colour actually takes", () => {
    expect(safeBackground("transparent")).toBe("transparent");
    expect(safeBackground("#FFF")).toBe("#fff");
    expect(safeBackground("#1a2b3c")).toBe("#1a2b3c");
    expect(safeBackground("white")).toBe("white");
  });

  it("refuses anything that could close the declaration it lands in", () => {
    /**
     * The value is interpolated into a stylesheet, so this is CSS injection into a page this package
     * built. An allow-list rather than an escape: a colour is a small closed vocabulary.
     */
    for (const attack of [
      "red; } body { background: url(http://169.254.169.254/)",
      "url(http://evil.test/x.png)",
      "#fff'/*",
      "var(--x)",
      "",
    ]) {
      expect(safeBackground(attack), attack).toBe("#ffffff");
    }
  });
});

describe("buildDiagramHtml", () => {
  it("escapes the source, because it is model-generated text inside a page", () => {
    const html = buildDiagramHtml("flowchart LR\n  A[<script>alert(1)</script>] --> B", {
      width: 900,
      background: "#ffffff",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("clamps the width rather than trusting it", () => {
    // A viewport of 99,999 pixels is a memory question, and the browser is the thing that pays.
    expect(buildDiagramHtml("flowchart LR\n A --> B", { width: 99_999, background: "#fff" })).toContain("width:2400px");
    expect(buildDiagramHtml("flowchart LR\n A --> B", { width: 1, background: "#fff" })).toContain("width:320px");
  });

  it("makes the wrapper an inline-block, which is what lets the screenshot be clipped", () => {
    // *"So the image has no dead whitespace below a short diagram."* A block element's box is the
    // viewport's width and the clip would be meaningless.
    expect(buildDiagramHtml("flowchart LR\n A --> B", { width: 900, background: "#fff" })).toContain(
      "display:inline-block",
    );
  });

  it("puts the *sanitised* background in the stylesheet, not the caller's string", () => {
    /**
     * Sabotage found this gap: `safeBackground` had its own tests and the page builder's use of it had
     * none, so bypassing it there broke nothing. The value lands inside a CSS declaration, which makes
     * this an injection into a page this package built.
     */
    const html = buildDiagramHtml("flowchart LR\n A --> B", {
      width: 900,
      background: "red; } body { background: url(http://169.254.169.254/)",
    });
    expect(html).not.toContain("169.254.169.254");
    expect(html).toContain("background:#ffffff;");
  });

  it("refuses an empty diagram and one too long to be a request", () => {
    expect(() => buildDiagramHtml("   ", { width: 900, background: "#fff" })).toThrow(/no diagram/);
    expect(() =>
      buildDiagramHtml("x".repeat(MAX_DIAGRAM_SOURCE_CHARS + 1), { width: 900, background: "#fff" }),
    ).toThrow(/too long/);
  });
});

describe("the mermaid script", () => {
  /**
   * A script in a template string is prose until something reads it. Sabotage proved it: changing
   * `securityLevel` from `strict` to `loose` broke no test at all, and that setting is the one standing
   * between a model-authored diagram and raw HTML in the page.
   */
  it("runs mermaid in strict mode, because the source is model-generated", () => {
    // *"Diagram source is model-generated text, and mermaid can otherwise emit raw HTML and clickable
    // callbacks from a definition."* The same setting the chat renderer uses.
    expect(MERMAID_RUN).toContain("securityLevel: 'strict'");
    expect(MERMAID_RUN).not.toContain("'loose'");
    expect(MERMAID_RUN).not.toContain("'antiscript'");
  });

  it("parses before it runs, and returns the error rather than throwing it", () => {
    /**
     * *"Playwright surfaced a bare `Page.evaluate: Object` for a parse failure, which told the agent
     * nothing — it apologised and re-sent the same broken syntax."* Verified end to end against real
     * mermaid, which answers "Parse error on line 2: …".
     */
    expect(MERMAID_RUN.indexOf("mermaid.parse")).toBeLessThan(MERMAID_RUN.indexOf("mermaid.run"));
    expect(MERMAID_RUN).toContain("return { ok: false, message:");
    expect(MERMAID_RUN).toContain("suppressErrorRendering: true");
  });

  it("reads the source out of the page rather than taking it as an argument", () => {
    /**
     * One string, one place. The old renderer's trap: *"repaired once here, so the source embedded in
     * the page and the source handed to `mermaid.parse()` are the same string. Validating the raw text
     * while rendering the repaired one would report errors that no longer exist."*
     */
    expect(MERMAID_RUN).toContain("document.querySelector('#wrap pre.mermaid').textContent");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes the ampersand first, so an escape is not double-escaped", () => {
    // `&lt;` must not become `&amp;lt;` — which is what happens when `<` is replaced before `&`.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });
});
