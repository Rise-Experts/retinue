/**
 * Path scoping, and the three ways a model-supplied path tries to leave the root — REQ-047 (#206), task #215,
 * AC-1.
 *
 * Each escape gets an attempt rather than a comment, because the string-comparison version of this check passes
 * two of the three: `..` normalises away, an absolute path is obvious, and a **symlink** is inside the root right
 * up until the filesystem resolves it. That third one is the whole reason the check is against the real path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contains, createFileReader, MAX_FILE_BYTES } from "../files.js";

let root = "";
let writable = "";
let outside = "";

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "retinue-files-"));
  root = join(base, "root");
  writable = join(base, "scratch");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(writable);
  mkdirSync(outside);
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "readme.md"), "# Readme\nthe answer is 42\n");
  writeFileSync(join(root, "notes", "one.md"), "a note mentioning widgets\n");
  writeFileSync(join(root, "notes", "two.txt"), "another note, no widgets here\n");
  writeFileSync(join(root, "big.log"), "x".repeat(MAX_FILE_BYTES + 500));
  writeFileSync(join(outside, "secret.txt"), "the private key\n");
  // The escape that string comparison misses: a link inside the root, pointing out of it.
  symlinkSync(join(outside, "secret.txt"), join(root, "link-to-secret.txt"));
  symlinkSync(outside, join(root, "escape-dir"));
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

const files = () => createFileReader({ root, writableRoot: writable });

describe("what is inside the root", () => {
  it("reads a file", () => {
    const result = files().read("readme.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("the answer is 42");
  });

  it("lists a directory, with kinds and sizes", () => {
    const result = files().list("notes");
    if (!result.ok) throw new Error("expected a listing");
    expect(result.entries.map((e) => e.name)).toEqual(["one.md", "two.txt"]);
    expect(result.entries[0]?.kind).toBe("file");
    expect(result.entries[0]?.bytes).toBeGreaterThan(0);
  });

  it("searches contents and reports where each match was", () => {
    const result = files().search({ query: "widgets" });
    if (!result.ok) throw new Error("expected a search result");
    expect(result.matches.map((m) => m.path).sort()).toEqual([join("notes", "one.md"), join("notes", "two.txt")]);
    expect(result.matches[0]?.line).toBe(1);
  });

  it("filters by name pattern", () => {
    const result = files().search({ query: "note", namePattern: "*.txt" });
    if (!result.ok) throw new Error("expected a search result");
    expect(result.matches.map((m) => m.path)).toEqual([join("notes", "two.txt")]);
  });
});

describe("the three escapes", () => {
  it("refuses `..`", () => {
    const result = files().read(join("..", "outside", "secret.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("forbidden");
  });

  it("says `forbidden` for an escape whether or not the target exists", () => {
    /**
     * The first version checked containment *after* `realpath`, so an escaping path that pointed at nothing came
     * back as `not-found` — a different fact, and an invitation to try another path. It also made the refusal
     * depend on the target's existence, which is not a property a boundary should have.
     */
    const result = files().read(join("..", "..", "nothing-here-at-all", "x.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("forbidden");
  });

  it("refuses an absolute path rather than silently re-rooting it", () => {
    // Re-rooting would answer a different question than the one asked, and the model would not know.
    const result = files().read(join(outside, "secret.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("relative");
  });

  it("refuses a symlink out of the root — the one a string comparison lets through", () => {
    const result = files().read("link-to-secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("forbidden");
  });

  it("does not walk out of the root through a symlinked directory during a search", () => {
    const result = files().search({ query: "private key" });
    if (!result.ok) throw new Error("expected a search result");
    expect(result.matches).toEqual([]);
  });

  it("does not accept a sibling directory whose name merely starts with the root's", () => {
    // `/srv/data-secrets` starts with `/srv/data`; a prefix comparison accepts it and `relative` does not.
    expect(contains("/srv/data", "/srv/data-secrets/file")).toBe(false);
    expect(contains("/srv/data", "/srv/data/file")).toBe(true);
    expect(contains("/srv/data", "/srv/data")).toBe(true);
  });
});

describe("bounds", () => {
  it("truncates a long file and says so", () => {
    const result = files().read("big.log");
    if (!result.ok) throw new Error("expected a read");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(MAX_FILE_BYTES);
  });

  it("caps a listing and says so", () => {
    const crowded = mkdtempSync(join(tmpdir(), "retinue-files-many-"));
    for (let index = 0; index < 12; index += 1) writeFileSync(join(crowded, `f${index}.txt`), "x");
    const result = createFileReader({ root: crowded, maxEntries: 5 }).list(".");
    if (!result.ok) throw new Error("expected a listing");
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(true);
    rmSync(crowded, { recursive: true, force: true });
  });

  it("caps matches and says so", () => {
    const result = createFileReader({ root, maxMatches: 1 }).search({ query: "note" });
    if (!result.ok) throw new Error("expected a search result");
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("says a directory is not a file, rather than failing obscurely", () => {
    const result = files().read("notes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("not-a-file");
  });
});

describe("writing", () => {
  it("writes into the writable root and says whether it created the file", () => {
    const first = files().write({ path: join("out", "draft.md"), content: "hello" });
    if (!first.ok) throw new Error(`expected a write: ${first.reason}`);
    expect(first.created).toBe(true);
    const second = files().write({ path: join("out", "draft.md"), content: "hello again" });
    if (!second.ok) throw new Error("expected a write");
    expect(second.created).toBe(false);
  });

  it("cannot write into the read root, which is the point of two roots", () => {
    // A model that could write where it reads is a model that can edit the material it later cites.
    const result = files().write({ path: "readme.md", content: "rewritten" });
    if (!result.ok) throw new Error("expected a write into the scratch root");
    // It landed in the *writable* root, not next to the source it shares a name with.
    expect(files().read("readme.md").ok && (files().read("readme.md") as { content: string }).content).toContain("42");
  });

  it("refuses when no writable root is configured — a wiring decision, not a permission one", () => {
    const result = createFileReader({ root }).write({ path: "x.md", content: "no" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("writable root");
  });

  it("refuses an escape from the writable root too", () => {
    const result = files().write({ path: join("..", "root", "readme.md"), content: "no" });
    expect(result.ok).toBe(false);
  });
});
