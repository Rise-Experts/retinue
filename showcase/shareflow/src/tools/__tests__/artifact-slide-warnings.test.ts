/**
 * #653 — create_artifact / update_artifact say which directives a deck used that no slide understands, so the agent
 * does not tell the person a theme or a font was applied (production, 2026-09-30: "a 'dark-tech' theme gives a
 * near-black background" — no such theme exists, and the deck rendered light).
 */
import { describe, expect, it } from "vitest";

import { slideWarnings } from "../artifacts.js";

describe("slideWarnings", () => {
  it("names unknown directives in a deck, with a note not to claim them", () => {
    const warning = slideWarnings("slides", "<!-- theme: dark-tech -->\n# Title");
    expect(warning.unknownDirectives).toEqual(["theme"]);
    expect(warning.directiveNote).toContain("Do not say any of this was applied");
  });

  it("says nothing for a clean deck or another kind", () => {
    expect(slideWarnings("slides", "<!-- format: 16:9 -->\n# Title")).toEqual({});
    expect(slideWarnings("slides", "<!-- palette: #0b1020 #f5f5f5 #ff5a36 -->\n<!-- heading-font: Bebas Neue -->\n<!-- mode: dark -->\n# Title")).toEqual({});
    expect(slideWarnings("html", "<!-- theme: x --><p>hi</p>")).toEqual({});
  });

  it("#663 AC-2: a font that is not installed is named with the nearest installed one", () => {
    const warning = slideWarnings("slides", "<!-- heading-font: Montserrat -->\n# Title");
    expect(warning.unknownDirectives).toBeUndefined();
    expect(warning.styleProblems).toHaveLength(1);
    expect(warning.styleProblems?.[0]).toContain('"Montserrat" is not installed');
    expect(warning.styleProblems?.[0]).toContain("the nearest installed font is League Spartan");
    expect(warning.directiveNote).toContain("Do not say any of this was applied");
    expect(warning.directiveNote).toContain("never rebuild the deck as an HTML page");
  });

  it("#663: reports a colour, a mode and a slide background that were not applied", () => {
    const warning = slideWarnings("slides", "<!-- palette: #0b1020 navy -->\n<!-- mode: dim -->\n# A\n---\n<!-- bg-color: red -->\n## B");
    expect(warning.styleProblems).toEqual([
      expect.stringContaining('palette: "navy"'),
      expect.stringContaining('mode: "dim"'),
      expect.stringContaining('bg-color on slide 2: "red"'),
    ]);
  });
});
