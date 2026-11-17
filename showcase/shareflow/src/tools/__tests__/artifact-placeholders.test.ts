/**
 * #655 — placeholders left in a document are listed in the tool result.
 * Production, 2026-09-30: "— [Customer Name], [Company]" shipped in two decks the reply called finished.
 */
import { describe, expect, it } from "vitest";

import { placeholderWarnings, placeholdersIn } from "../artifacts.js";

describe("placeholdersIn", () => {
  it("finds the evaluation's placeholders, once each", () => {
    expect(placeholdersIn("> Great coffee.\n— [Customer Name], [Company]\n\nLaunch on [date]. Ask [Customer Name].")).toEqual(["[Customer Name]", "[Company]", "[date]"]);
  });

  it("leaves links, images, task boxes, footnotes and code alone", () => {
    const doc = [
      "[the deck](chorus-artifact:1) and ![Team photo](chorus-media:x.png)",
      "- [x] done",
      "- [ ] open",
      "See source [1].",
      "`[Not This]`",
      "```ts\nconst a = [Placeholder Here];\n```",
    ].join("\n");
    expect(placeholdersIn(doc)).toEqual([]);
  });
});

describe("placeholderWarnings", () => {
  it("names them with a note not to call the document finished", () => {
    const warning = placeholderWarnings("— [Customer Name]");
    expect(warning.placeholders).toEqual(["[Customer Name]"]);
    expect(warning.placeholderNote).toContain("Do not call the document finished");
  });

  it("says nothing for a clean document", () => {
    expect(placeholderWarnings("# Plan\n\nAll real.")).toEqual({});
  });
});
