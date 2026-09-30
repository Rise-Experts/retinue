/**
 * The documentation reader — REQ #291.
 *
 * Two halves. The parsing tests use fixtures, because a fixture can hold the shapes a real corpus happens not
 * to contain this week. The reader tests run against **`docs/` itself**, which is the point: this exists to
 * serve that directory, and a test that only ever sees a fixture would not notice the day the corpus stops
 * looking like the fixture.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { existsSync, readFileSync } from "node:fs";

import { agentkitDocsRoot, createDocsReader, headingFor, parseDoc, sectionOf } from "../docs.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs");

describe("parseDoc", () => {
  it("takes the title from the first H1 and the summary from the first real prose", () => {
    const parsed = parseDoc("# Retrieval Quality, Measured\n\nStatus: measured, 27 Aug 2026\n\nFive arms, one corpus.\n", "fallback");
    expect(parsed.title).toBe("Retrieval Quality, Measured");
    // Not `Status: …`: every document here opens with one, and thirty identical summaries are worse than none.
    expect(parsed.summary).toBe("Five arms, one corpus.");
  });

  it("falls back to the given name when a document has no H1", () => {
    expect(parseDoc("no heading at all\n", "09-quality.md").title).toBe("09-quality.md");
  });

  it("ignores headings inside fenced code", () => {
    // A `# comment` in a shell block is not a section, and treating it as one puts samples in the contents.
    const parsed = parseDoc("# Title\n\n```bash\n# not a heading\n```\n\n## Real\n", "x");
    expect(parsed.headings.map((h) => h.text)).toEqual(["Real"]);
  });

  it("strips YAML front matter rather than reading it as content", () => {
    // #220's precedent: front matter reached the block stream and produced a chunk whose text was a key.
    const parsed = parseDoc("---\nsidebar_position: 4\n---\n\n# After The Matter\n\nProse.\n", "x");
    expect(parsed.title).toBe("After The Matter");
    expect(parsed.summary).toBe("Prose.");
  });

  it("reports heading lines against the original file, so matches line up", () => {
    const parsed = parseDoc("---\na: 1\n---\n\n# T\n\n## Second\n", "x");
    const second = parsed.headings.find((h) => h.text === "Second");
    // Line 7 in the file as written, not line 4 of the body after front matter was removed.
    expect(second?.line).toBe(7);
  });
});

describe("headingFor", () => {
  const headings = [
    { text: "One", level: 2, line: 10 },
    { text: "Two", level: 2, line: 20 },
  ];
  it("returns the last heading at or above the line", () => {
    expect(headingFor(headings, 15)).toBe("One");
    expect(headingFor(headings, 20)).toBe("Two");
    expect(headingFor(headings, 99)).toBe("Two");
  });
  it("returns nothing for a line before any heading", () => {
    expect(headingFor(headings, 3)).toBeUndefined();
  });
});

describe("sectionOf", () => {
  const doc = "# T\n\n## Result\n\nnumbers\n\n### Detail\n\nmore\n\n## Next\n\nother\n";

  it("returns a section including its subsections", () => {
    const section = sectionOf(doc, "Result");
    expect(section?.heading).toBe("Result");
    // `### Detail` belongs to `## Result`; stopping at the first subsection would return a fragment.
    expect(section?.content).toContain("Detail");
    expect(section?.content).not.toContain("other");
  });

  it("prefers an exact heading to one that merely contains the name", () => {
    const ambiguous = "# T\n\n## Results In Practice\n\na\n\n## Result\n\nb\n";
    expect(sectionOf(ambiguous, "Result")?.content).toContain("b");
  });

  it("is case-insensitive", () => {
    expect(sectionOf(doc, "result")?.heading).toBe("Result");
  });

  it("returns nothing for a heading that is not there", () => {
    expect(sectionOf(doc, "Conclusion")).toBeUndefined();
  });
});

describe("createDocsReader, against the real docs/", () => {
  const docs = createDocsReader({ root: DOCS });

  it("lists every document with a title, and finds the corpus this was built for", async () => {
    const listing = await docs.list();
    if (!listing.ok) throw new Error(listing.reason);
    expect(listing.docs.length).toBeGreaterThan(20);
    // The gap over `fs_list`, asserted: a listing whose entries have no titles is the thing this replaces.
    for (const doc of listing.docs) {
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.title).not.toMatch(/^#/);
    }
    const retrieval = listing.docs.find((d) => d.path.includes("26-retrieval-quality"));
    expect(retrieval?.title).toBe("Retrieval Quality, Measured");
    expect(retrieval?.sections).toContain("Result");
  });

  it("carries the enclosing heading on a match, which is the gap over fs_search", async () => {
    const found = await docs.search({ query: "navigate (no vectors)" });
    if (!found.ok) throw new Error(found.reason);
    expect(found.matches.length).toBeGreaterThan(0);
    const hit = found.matches[0];
    expect(hit?.path).toContain("26-retrieval-quality");
    expect(hit?.title).toBe("Retrieval Quality, Measured");
    // Without this a model has a line number and must open the file to judge it.
    expect(hit?.heading).toBeTruthy();
  });

  it("reads one section instead of a whole document", async () => {
    const whole = await docs.read({ path: "26-retrieval-quality.md" });
    const part = await docs.read({ path: "26-retrieval-quality.md", section: "Result" });
    if (!whole.ok || !part.ok) throw new Error("expected both reads to succeed");
    expect(part.heading).toBe("Result");
    // The entire reason the parameter exists.
    expect(part.content.length).toBeLessThan(whole.content.length);
    expect(part.content).toContain("navigate");
  });

  it("refuses an unknown section by listing the real ones", async () => {
    const missed = await docs.read({ path: "26-retrieval-quality.md", section: "Epilogue" });
    expect(missed.ok).toBe(false);
    if (missed.ok) return;
    expect(missed.kind).toBe("no-such-section");
    // So the next call can be right without a second round trip.
    expect(missed.reason).toContain("Result");
  });

  it("refuses a path outside the root", async () => {
    // Inherited from `createFileReader` rather than re-implemented — asserted here because inheriting it is
    // the design decision, and a later refactor that stopped delegating would pass every other test.
    const escaped = await docs.read({ path: "../backend/package.json" });
    expect(escaped.ok).toBe(false);
    const absolute = await docs.read({ path: "/etc/passwd" });
    expect(absolute.ok).toBe(false);
  });
});

describe("the documentation ships with the package — #291", () => {
  it("agentkitDocsRoot finds a real directory with documents in it", async () => {
    const root = agentkitDocsRoot();
    expect(root).toBeTruthy();
    // Existence-tested rather than assumed: a path that is not there turns "the tools found nothing" into the
    // symptom, three layers from the cause.
    expect(existsSync(root as string)).toBe(true);
    const listing = await createDocsReader({ root: root as string }).list();
    if (!listing.ok) throw new Error(listing.reason);
    expect(listing.docs.length).toBeGreaterThan(20);
  });

  it("the manifest ships them and copies them at pack time", () => {
    /**
     * Both halves, because either alone ships nothing and says so only at runtime: `files` without `prepack`
     * publishes an empty `dist/docs`, and `prepack` without `files` copies into a tarball that excludes it.
     * The pair is the feature.
     */
    const manifest = JSON.parse(readFileSync(join(DOCS, "..", "backend", "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(manifest.files).toContain("dist/docs/**/*.md");
    expect(manifest.scripts.prepack).toMatch(/copy-docs\.mjs/);
  });
});
