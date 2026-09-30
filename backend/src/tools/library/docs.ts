/**
 * Reading the documentation — REQ #291.
 *
 * Envelopes over `toolkit/docs.ts`, which is itself an envelope over `toolkit/files.ts`. Nothing here touches
 * the disk: R7 forbids it, and the path scoping, the symlink refusal and the byte ceiling live one layer down
 * in the reader every other file tool already uses.
 *
 * ## Three tools, and why not the four that exist
 *
 * `fs_read`, `fs_list` and `fs_search` can already serve a directory of markdown, and for a while that looked
 * like the whole answer. It is not, and the gap is the same each time — a model spends a document to learn
 * something a listing could have told it:
 *
 * - `fs_list` returns names, kinds and sizes. `21-platform.md, 14KB` does not say what is in it, so choosing
 *   between thirty-two files means opening thirty-two files.
 * - `fs_search` returns the matching line, which is honest but hard to judge without knowing **which section**
 *   it came from.
 * - a read is the whole file, and the largest document here is about 10k tokens.
 *
 * So `docs_list` carries titles, `docs_search` carries the enclosing heading, and `docs_read` can name a
 * section. That is the entire difference, and it is why these are not aliases.
 *
 * ## Why no vectors
 *
 * `docs/26-retrieval-quality.md` measured the no-index arm best on P@1 and MRR of five, and the two costs it
 * recorded — a model call to choose documents, and a three-document recall cap — are both properties of doing
 * the choosing *inside* the runtime. Over MCP the client chooses. `toolkit/docs.ts` has the full argument.
 *
 * ## Not gated, and read-only by construction
 *
 * Same reasoning as `fs_read` and the web reads: an approval on every documentation read is one people click
 * through, and that habit is what makes the approval on a write worthless. The control is the root, which
 * cannot be clicked through. There is no `docs_write`, and the reader is built with no writable root at all —
 * a corpus a model can edit is a corpus a model can cite itself into.
 */

import { z } from "zod";
import { defineDelegatingTool } from "../delegating.js";
import type { DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";
import type { DocsReader } from "../../toolkit/docs.js";

const listSchema = z.object({}).strict();

export const createDocsListTool = (deps: DelegatingToolDeps, docs: DocsReader): Tool =>
  defineDelegatingTool(deps, {
    name: "docs_list",
    label: "List documentation",
    description:
      "The table of contents for the documentation: every document with its path, title, a one-line summary " +
      "and its section headings. Start here — it is one call, and it is what lets you pick a document and a " +
      "section instead of reading several whole files to find out what they cover.",
    category: "knowledge",
    effect: "read",
    inputSchema: listSchema,
    delegatesTo: "toolkit/docs.list",
    delegate: () => docs.list(),
  });

const searchSchema = z
  .object({
    query: z.string().min(1).max(200).describe("A literal string to find. Matching is case-insensitive, not fuzzy."),
    path: z
      .string()
      .max(1_024)
      .optional()
      .describe("Restrict the search to this file or directory, relative to the docs root. Omit to search all of it."),
  })
  .strict();

export const createDocsSearchTool = (deps: DelegatingToolDeps, docs: DocsReader): Tool =>
  defineDelegatingTool(deps, {
    name: "docs_search",
    label: "Search documentation",
    description:
      "Find a literal string in the documentation. Each match carries the document's title and the heading it " +
      "sits under, so a hit can be judged without opening the file, plus the path and line to read next. " +
      "Bounded: it says when a ceiling stopped it early, so a partial result is never mistaken for a complete one.",
    category: "knowledge",
    effect: "read",
    inputSchema: searchSchema,
    delegatesTo: "toolkit/docs.search",
    delegate: (input: z.infer<typeof searchSchema>) =>
      docs.search({ query: input.query, ...(input.path === undefined ? {} : { path: input.path }) }),
  });

const readSchema = z
  .object({
    path: z.string().min(1).max(1_024).describe("A document path relative to the docs root. Absolute paths are refused."),
    section: z
      .string()
      .max(200)
      .optional()
      .describe(
        "A heading to return instead of the whole document, matched case-insensitively and by containment. " +
          "Returns that heading and everything under it, subsections included. Omit for the whole document.",
      ),
  })
  .strict();

export const createDocsReadTool = (deps: DelegatingToolDeps, docs: DocsReader): Tool =>
  defineDelegatingTool(deps, {
    name: "docs_read",
    label: "Read documentation",
    description:
      "Read a document, or one named section of it. Prefer a section when you know which one you want: the " +
      "largest document here is several thousand words, and a section is usually the whole answer. An unknown " +
      "section is refused with the document's real headings listed, so the next call can be right.",
    category: "knowledge",
    effect: "read",
    inputSchema: readSchema,
    delegatesTo: "toolkit/docs.read",
    delegate: (input: z.infer<typeof readSchema>) =>
      docs.read({ path: input.path, ...(input.section === undefined ? {} : { section: input.section }) }),
  });
