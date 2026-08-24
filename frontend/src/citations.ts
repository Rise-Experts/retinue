/**
 * The React-free citation view model (#138), extracted so it can be used without React (#155 AC-5).
 *
 * It lived in `ui/citations.tsx` alongside the components it feeds, which was reasonable until something
 * without React needed it. The example app renders its own markup and derives the view model server-side; with
 * the helpers behind a `.tsx` import its only options were pulling React into a plain HTML page or writing a
 * second implementation of the ordering — and the ordering is precisely where AC-4 lives, so a second
 * implementation is a second answer to "which citation is number 3".
 *
 * `ui/citations.tsx` re-exports these, so nothing that imported them from there had to change.
 */

import type { Message, MessagePart } from "./types/index.js";
import { citationHref, citationLabel, groundedPartIds } from "./ui/part-summary.js";

type CitationPart = Extract<MessagePart, { type: "citation" }>;

/**
 * Whether a citation can be opened elsewhere, and why not when it cannot.
 *
 * Two different absences: a retrieval citation is *inside* the workspace and has no external URL, and a source
 * marked unresolvable had one that no longer works. A reader needs different sentences, and collapsing them
 * would tell someone a document was deleted when it never left.
 */
export type CitationResolution = "linkable" | "not-linkable" | "unresolvable";

export const citationResolution = (part: CitationPart, unresolvable = false): CitationResolution =>
  unresolvable ? "unresolvable" : citationHref(part) === null ? "not-linkable" : "linkable";

/**
 * The React-free view model behind the components.
 *
 * Extracted for the same reason `part-summary.ts` is: the *ordering* is where AC-4 lives, and ordering is a
 * pure function. A property like "adding a citation appends and never inserts" is provable about a list and
 * merely observable about a DOM tree.
 */
export type CitationViewModel = {
  /** Blocks in document order. Text blocks carry their markers; a citation contributes no block of its own. */
  readonly blocks: readonly {
    readonly partId: string;
    readonly kind: "text" | "other";
    readonly text: string;
    readonly grounded: boolean;
    /** Marker numbers on this block, in arrival order. */
    readonly markers: readonly { readonly citationId: string; readonly index: number }[];
  }[];
  /** Panels after the message, in arrival order — never reordered, never renumbered. */
  readonly panels: readonly {
    readonly citationId: string;
    readonly index: number;
    readonly label: string;
    readonly excerpt: string;
    readonly retrievedAt: string;
    readonly resolution: CitationResolution;
    readonly href: string | null;
  }[];
};

/**
 * Build the view model.
 *
 * Numbers are assigned once in **arrival order** and never recomputed from position, because renumbering as
 * citations stream in would change text the reader is already looking at — the layout jump AC-4 forbids, in its
 * most disorienting form.
 */
export const citationViewModel = (
  message: Message,
  unresolvableIds: readonly string[] = [],
): CitationViewModel => {
  const unresolvable = new Set(unresolvableIds);
  const citations = message.parts.filter((p): p is CitationPart => p.type === "citation");
  const grounded = groundedPartIds(message.parts);
  const numberOf = new Map(citations.map((c, i) => [c.id, i + 1]));

  return {
    blocks: message.parts
      .filter((part) => part.type !== "citation")
      .map((part) => ({
        partId: part.id,
        kind: part.type === "text" ? ("text" as const) : ("other" as const),
        text: part.type === "text" ? part.text : "",
        grounded: grounded.has(part.id),
        markers: citations
          .filter((c) => c.supports.includes(part.id))
          .map((c) => ({ citationId: c.id, index: numberOf.get(c.id) ?? 1 })),
      })),
    panels: citations.map((citation) => ({
      citationId: citation.id,
      index: numberOf.get(citation.id) ?? 1,
      label: citationLabel(citation),
      excerpt: citation.excerpt,
      retrievedAt: citation.retrievedAt,
      resolution: citationResolution(citation, unresolvable.has(citation.id)),
      href: citationHref(citation),
    })),
  };
};
