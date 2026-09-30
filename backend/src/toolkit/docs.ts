/**
 * Documentation over MCP, without an index — REQ #291.
 *
 * ## Why there are no vectors here
 *
 * This is not an opinion; `docs/26-retrieval-quality.md` measured it on this corpus. The arm called `navigate`
 * — read a table of contents, choose documents, then look inside them — scored the **best P@1 (44.4%) and the
 * best MRR** of five arms, beating semantic, hybrid and hybrid-plus-reranker. It recorded two costs: roughly
 * 7× the latency and 4,000× the marginal cost of an embedding query, and the worst-but-one recall "because it
 * reads at most three documents".
 *
 * Neither cost survives the move to MCP, and that is the whole argument for this file:
 *
 * - The **cost was a model call** made inside the runtime to pick documents. Over MCP the client's model does
 *   the choosing, as part of the reasoning it is already doing. The expense leaves this side of the boundary.
 * - The **recall cap was three documents**, a limit of that implementation. A client reads as many as it likes.
 *
 * What is left is the part that was always attractive and was never a score: **no index**. Nothing to rebuild
 * when a document changes, no re-embedding, and no window where the prose says one thing and the index still
 * serves the previous version. For a corpus of 32 files and 66k words whose vocabulary is *enforced* by
 * `check:terminology` against `docs/22-glossary.md`, a literal search is close to exact — controlled nouns are
 * the condition under which keyword search stops losing to embeddings.
 *
 * ## Why this is not `fs_read` / `fs_list` / `fs_search`
 *
 * Those three exist and they are correct; this file deliberately builds on their reader rather than beside it.
 * Three things they do not do, each of which costs a model a whole document:
 *
 * 1. `FileEntry` is `name`, `path`, `kind`, `bytes`. A listing of `21-platform.md, 14KB` tells a model nothing
 *    about what is in it, so choosing means opening all 32.
 * 2. `FileMatch` carries the matching line, but not **which section it is in**. A line without its heading is
 *    hard to judge, so a hit means reading the file to find out.
 * 3. A read is a whole file. The largest document here is ~7,200 words, which is about 10k tokens to answer one
 *    question about one section.
 *
 * So: titles in the listing, the enclosing heading on every match, and reads that can name a section.
 *
 * ## Path safety is inherited, never re-implemented
 *
 * Everything reaches disk through `createFileReader`, which resolves the root through `realpath` at
 * construction and refuses absolute paths, `..` escapes and symlinks that leave the root. Re-deriving those
 * checks here would mean a second place for the traversal bug to live, and the second place is always the one
 * that is missed.
 */
import { createFileReader, type FileScope } from "./files.js";

export type DocsScope = FileScope;

/** One document in the table of contents. */
export type DocEntry = {
  readonly path: string;
  /** The first `# H1`, or the filename when a document has none. */
  readonly title: string;
  /** The first line of prose that is not metadata — enough to choose a document without opening it. */
  readonly summary?: string;
  /** The `##`/`###` headings, in order, so a reader can ask for one by name. */
  readonly sections: readonly string[];
};

export type DocsIndex = {
  readonly ok: true;
  readonly docs: readonly DocEntry[];
  readonly truncated: boolean;
};

export type DocMatch = {
  readonly path: string;
  readonly title: string;
  /** The heading the match sits under, which is what makes a line judgeable without opening the file. */
  readonly heading?: string;
  readonly line: number;
  readonly text: string;
};

export type DocsSearch = {
  readonly ok: true;
  readonly query: string;
  readonly matches: readonly DocMatch[];
  readonly filesSearched: number;
  readonly truncated: boolean;
};

export type DocsRead = {
  readonly ok: true;
  readonly path: string;
  readonly title: string;
  /** Present when a section was asked for and found; absent when the whole document was returned. */
  readonly heading?: string;
  readonly content: string;
  readonly truncated: boolean;
};

export type DocsFailure = {
  readonly ok: false;
  readonly path: string;
  readonly kind: "forbidden" | "not-found" | "not-a-file" | "not-a-directory" | "unreadable" | "too-many" | "no-such-section";
  readonly reason: string;
};

export type DocsReader = {
  list(): Promise<DocsIndex | DocsFailure>;
  search(input: { readonly query: string; readonly path?: string }): Promise<DocsSearch | DocsFailure>;
  read(input: { readonly path: string; readonly section?: string }): Promise<DocsRead | DocsFailure>;
};

/** Markdown files only. A docs root holding a stray binary should not put it in a table of contents. */
const isDoc = (name: string) => /\.mdx?$/i.test(name);

/**
 * YAML front matter, removed before anything else reads the text.
 *
 * #220 is the precedent: front matter reached the block stream as content, and the corpus grew chunks whose
 * entire text was `sidebar_position: 4`. A title taken from front matter's `---` would be wrong in the same way.
 */
const stripFrontMatter = (text: string): { body: string; offset: number } => {
  if (!text.startsWith("---")) return { body: text, offset: 0 };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { body: text, offset: 0 };
  const after = text.indexOf("\n", end + 1);
  if (after === -1) return { body: "", offset: 0 };
  const consumed = text.slice(0, after + 1);
  return { body: text.slice(after + 1), offset: consumed.split("\n").length - 1 };
};

/** A heading line, captured with the line number the *original* file uses so matches line up. */
type Heading = { readonly text: string; readonly level: number; readonly line: number };

export type ParsedDoc = {
  readonly title: string;
  readonly summary?: string;
  readonly headings: readonly Heading[];
};

/**
 * Structure from a markdown document, without a markdown parser.
 *
 * A parser would be a dependency and a decision about which flavour, for one thing this needs: lines that start
 * with `#`. Fenced code is skipped, because a `# comment` inside a shell block is not a heading — the mistake
 * that turns a code sample into a section.
 */
export const parseDoc = (raw: string, fallbackTitle: string): ParsedDoc => {
  const { body, offset } = stripFrontMatter(raw);
  const lines = body.split("\n");
  const headings: Heading[] = [];
  let title: string | undefined;
  let summary: string | undefined;
  let fenced = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      if (level === 1 && title === undefined) title = text;
      else headings.push({ text, level, line: i + 1 + offset });
      continue;
    }

    /**
     * The summary skips the status block these documents open with.
     *
     * Every document here begins `Status: decided` or `Status: measured, …` followed by REQ and issue links.
     * That is provenance, not a description, and a table of contents made of thirty identical `Status:` lines
     * would be worse than no summary at all.
     */
    if (summary === undefined && title !== undefined) {
      const trimmed = line.trim();
      if (trimmed !== "" && !/^(status|req reference|spec)\b/i.test(trimmed) && !trimmed.startsWith("[")) {
        summary = trimmed.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").slice(0, 240);
      }
    }
  }
  return { title: title ?? fallbackTitle, ...(summary === undefined ? {} : { summary }), headings };
};

/** The heading a line sits under: the last one at or above it. */
export const headingFor = (headings: readonly Heading[], line: number): string | undefined => {
  let found: string | undefined;
  for (const heading of headings) {
    if (heading.line > line) break;
    found = heading.text;
  }
  return found;
};

/**
 * One section's text: from its heading to the next heading of the same level or higher.
 *
 * "Or higher" is what makes `##` return its `###` subsections rather than stopping at the first one — asking
 * for a section and getting its first paragraph would be a worse answer than the whole file.
 */
export const sectionOf = (raw: string, wanted: string): { heading: string; content: string } | undefined => {
  const { body } = stripFrontMatter(raw);
  const lines = body.split("\n");
  const want = wanted.trim().toLowerCase();

  /** Every heading first, then choose — a single pass cannot prefer a later exact match to an earlier partial one. */
  const found: { index: number; text: string; level: number }[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) found.push({ index: i, text: (heading[2] ?? "").trim(), level: heading[1]?.length ?? 1 });
  }

  /**
   * Exact before contained, in two passes.
   *
   * One pass taking "exact or contained" returns whichever comes **first in the document**, so asking for
   * "Result" in a file that opens with "Results In Practice" returns the wrong section — and returns it
   * confidently, with a plausible heading. Found by the test, which is why it is spelled out here.
   */
  const chosen =
    found.find((h) => h.text.toLowerCase() === want) ?? found.find((h) => h.text.toLowerCase().includes(want));
  if (chosen === undefined) return undefined;

  /** To the next heading at the same level or higher, so a `##` keeps its `###` subsections. */
  const after = found.find((h) => h.index > chosen.index && h.level <= chosen.level);
  const body_ = lines.slice(chosen.index, after?.index ?? lines.length).join("\n").trim();
  return { heading: chosen.text, content: body_ };
};

/**
 * A reader over a documentation root.
 *
 * Reads only. There is no write half and no `writableRoot`, unlike `FileScope`: a corpus a model can edit is a
 * corpus a model can cite itself into, and documentation is the last place that should be possible.
 */
export const createDocsReader = (scope: DocsScope): DocsReader => {
  const files = createFileReader({ ...scope, writableRoot: undefined });

  /** Every markdown file under the root, one directory deep plus its subdirectories. */
  const walk = async (path?: string): Promise<{ paths: string[]; truncated: boolean } | DocsFailure> => {
    const listing = await files.list(path);
    if (!listing.ok) return listing as DocsFailure;
    const paths: string[] = [];
    let truncated = listing.truncated;
    for (const entry of listing.entries) {
      if (entry.kind === "file" && isDoc(entry.name)) paths.push(entry.path);
      else if (entry.kind === "directory") {
        const nested = await walk(entry.path);
        if (!("paths" in nested)) return nested;
        paths.push(...nested.paths);
        truncated = truncated || nested.truncated;
      }
    }
    return { paths, truncated };
  };

  return {
    async list() {
      const found = await walk();
      if (!("paths" in found)) return found;
      const docs: DocEntry[] = [];
      for (const path of found.paths.sort()) {
        const read = await files.read(path);
        if (!read.ok) continue;
        const parsed = parseDoc(read.content, path);
        docs.push({
          path,
          title: parsed.title,
          ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
          sections: parsed.headings.filter((h) => h.level === 2).map((h) => h.text),
        });
      }
      return { ok: true as const, docs, truncated: found.truncated };
    },

    async search(input) {
      const result = await files.search({
        query: input.query,
        ...(input.path === undefined ? {} : { path: input.path }),
        namePattern: "*.md",
      });
      if (!result.ok) return result as DocsFailure;
      // One read per distinct file, not per match: a query hitting one document forty times must not read it forty times.
      const parsed = new Map<string, ParsedDoc>();
      const matches: DocMatch[] = [];
      for (const match of result.matches) {
        if (!parsed.has(match.path)) {
          const read = await files.read(match.path);
          parsed.set(match.path, read.ok ? parseDoc(read.content, match.path) : { title: match.path, headings: [] });
        }
        const doc = parsed.get(match.path) as ParsedDoc;
        const heading = headingFor(doc.headings, match.line);
        matches.push({
          path: match.path,
          title: doc.title,
          ...(heading === undefined ? {} : { heading }),
          line: match.line,
          text: match.text,
        });
      }
      return { ok: true as const, query: result.query, matches, filesSearched: result.filesSearched, truncated: result.truncated };
    },

    async read(input) {
      const read = await files.read(input.path);
      if (!read.ok) return read as DocsFailure;
      const parsed = parseDoc(read.content, input.path);
      if (input.section === undefined) {
        return { ok: true as const, path: input.path, title: parsed.title, content: read.content, truncated: read.truncated };
      }
      const section = sectionOf(read.content, input.section);
      if (section === undefined) {
        return {
          ok: false as const,
          path: input.path,
          kind: "no-such-section" as const,
          // The headings are listed, because a model that guessed a name can then pick a real one without another call.
          reason: `no section matching "${input.section}". Headings: ${parsed.headings.map((h) => h.text).join(", ") || "(none)"}`,
        };
      }
      return { ok: true as const, path: input.path, title: parsed.title, heading: section.heading, content: section.content, truncated: read.truncated };
    },
  };
};
