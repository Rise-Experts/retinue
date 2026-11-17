/**
 * Asking for a PDF, and refusing one — production, 2026-10-01: "Do not make a PDF." got the note "The person asked
 * for a PDF … call generate_pdf".
 */
import { describe, expect, it } from "vitest";

import { asksForPdf, refusesPdf, withPdfNote } from "../media-defaults.js";

describe("asksForPdf", () => {
  it("is true for a request", () => {
    for (const message of ["Make me a PDF price sheet", "Can I get this as a PDF?", "Erstelle ein PDF davon", "How do I not lose formatting in the PDF export?"]) expect(asksForPdf(message), message).toBe(true);
  });

  it("is false when the PDF is refused, in English or German", () => {
    for (const message of ["Make a deck. Do not make a PDF.", "don't make a pdf", "No PDF needed", "no need for a PDF", "without a PDF please", "Bitte kein PDF", "ohne PDF", "nicht als PDF"]) {
      expect(refusesPdf(message), message).toBe(true);
      expect(asksForPdf(message), message).toBe(false);
    }
  });

  it("is false for putting a document on a post", () => {
    expect(asksForPdf("attach it to the LinkedIn post as a PDF")).toBe(false);
  });
});

describe("withPdfNote", () => {
  it("adds no PDF note when the message refuses one", () => {
    const result = { ok: true, data: { artifactId: "a1" } };
    expect(withPdfNote(result, "Make a 4-slide deck. Do not make a PDF.")).toBe(result);
  });
});
