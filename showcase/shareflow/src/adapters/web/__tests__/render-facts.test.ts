/**
 * #660 — a printed document's facts, so the reply can be held to them. Production, 2026-09-30: a "16:9 deck" printed as
 * portrait A4 with every slide cropped, and the reply said it "follows all your styling requirements".
 */
import { describe, expect, it } from "vitest";

import { layoutFactsOf, pageSizeOf, renderFactsView } from "../render-facts.js";

const pdf = (box: string) => new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Page /MediaBox ${box} >> endobj`);

describe("pageSizeOf", () => {
  it("reads portrait A4, a 16:9 page and a square page", () => {
    expect(pageSizeOf(pdf("[0 0 595.92 842.88]"))).toEqual({ width: 596, height: 843, orientation: "portrait" });
    expect(pageSizeOf(pdf("[0 0 1440 810]"))).toEqual({ width: 1440, height: 810, orientation: "landscape" });
    expect(pageSizeOf(pdf("[0 0 1080 1080]"))?.orientation).toBe("square");
  });

  it("is undefined without a MediaBox", () => {
    expect(pageSizeOf(new TextEncoder().encode("%PDF-1.4"))).toBeUndefined();
  });
});

describe("layoutFactsOf", () => {
  it("reports overflow, overflowing slides, fonts that are not installed, and blocked font links", () => {
    const facts = layoutFactsOf({ overflowCount: 6, examples: ['div.slide "Kaffee Nord"'], slides: [2, 5], families: ["Montserrat", "Inter", "sans-serif", "Playfair Display"], externalFonts: true });
    expect(facts).toEqual({
      overflow: { count: 6, examples: ['div.slide "Kaffee Nord"'] },
      overflowingSlides: [2, 5],
      missingFonts: ["Montserrat", "Playfair Display"],
      externalFontLinks: true,
    });
  });

  it("is empty for a clean document", () => {
    expect(layoutFactsOf({ overflowCount: 0, examples: [], slides: [], families: ["Inter", "serif"], externalFonts: false })).toEqual({});
  });
});

describe("renderFactsView", () => {
  it("names the evaluation's cropped deck: portrait, overflowing, with a note not to call it matching", () => {
    const view = renderFactsView({ page: { width: 596, height: 843, orientation: "portrait" }, overflow: { count: 6, examples: ['section "120+"'] } });
    expect(view).toMatchObject({ orientation: "portrait", pageSize: { width: 596, height: 843, unit: "pt" }, overflow: { count: 6 } });
    expect(String(view["renderNote"])).toContain("run past the page's printable width");
    expect(String(view["renderNote"])).toContain("do not describe the PDF as matching");
  });

  it("adds no note when nothing is wrong, and nothing at all without facts", () => {
    expect(renderFactsView({ page: { width: 1440, height: 810, orientation: "landscape" } })).toEqual({ pageSize: { width: 1440, height: 810, unit: "pt" }, orientation: "landscape" });
    expect(renderFactsView(undefined)).toEqual({});
  });
});
