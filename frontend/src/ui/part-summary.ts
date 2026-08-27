/**
 * Pure helpers backing the UI part renderers — `docs/06` → Optional UI package. React-free so it is
 * testable and reusable for SSR / plain-text rendering. `partSummary` classifies a message part into
 * a stable render kind + a short plain-text preview; the `.tsx` renderers dispatch on it.
 */

import type { MessagePart } from "../types/index.js";

export type PartRenderKind =
  | "text"
  | "reasoning"
  | "tool"
  | "interaction"
  | "attachment"
  | "reference"
  | "artifact"
  | "status"
  | "error"
  | "structured";

const KIND: Record<MessagePart["type"], PartRenderKind> = {
  text: "text",
  reasoning: "reasoning",
  "tool-call": "tool",
  "tool-result": "tool",
  question: "interaction",
  approval: "interaction",
  file: "attachment",
  image: "attachment",
  citation: "reference",
  source: "reference",
  artifact: "artifact",
  status: "status",
  error: "error",
  structured: "structured",
};

/**
 * A file size in binary units, for an attachment preview (#130).
 *
 * The backend renders the same figure in `files/context.ts`, and R2 makes this a copy rather than an import:
 * the frontend may only `import type` from `@retinue/agentkit`. Two things keep the copy honest — the unit
 * convention is *binary*, matching the backend, so a user is never told 104.9 MB by the UI while the model
 * is told 100 MB; and the expected strings are pinned in `part-summary.test.ts`, so a divergence breaks a
 * test rather than surfacing as a support question.
 *
 * The one deliberate difference is the padding. The backend right-aligns to a fixed width so an attachment's
 * token cost is exactly constant; that is a budgeting device and has no business in a UI.
 */
export const formatByteSize = (byteSize: number, locale?: string): string => {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = Math.max(0, byteSize);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 && unit > 0 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[unit]}`;
};

/** Compact JSON, or a plain description when the value cannot be serialised. Never throws. */
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "(unserialisable value)";
  }
};

/** A stable render kind + short plain-text preview for a part. */
export const partSummary = (part: MessagePart): { kind: PartRenderKind; preview: string } => {
  const kind = KIND[part.type];
  switch (part.type) {
    case "text":
    case "reasoning":
      return { kind, preview: part.text.slice(0, 200) };
    case "tool-call":
      return { kind, preview: `${part.toolName}(…)` };
    case "tool-result":
      return { kind, preview: part.truncated ? `${part.toolName}: (truncated)` : `${part.toolName}: done` };
    case "question":
      return { kind, preview: part.questions.map((q) => q.prompt).join(" · ") };
    case "approval":
      return { kind, preview: `Approve ${part.toolName}: ${part.summary}` };
    case "file":
      // Name and size, because the size is what a user needs before deciding to open it — and because the
      // reference is all there is: the content was never loaded, so a preview of it does not exist to show.
      return { kind, preview: `${part.filename} · ${formatByteSize(part.byteSize)}` };
    case "image":
      return { kind, preview: part.altText ?? "image" };
    case "citation":
      // The label first, then the excerpt: a reader scanning citations wants to know *where from* before
      // *what*. One branch for both origins — the shape is shared (#137), and only the link differs.
      return { kind, preview: `${citationLabel(part)}: “${part.excerpt.slice(0, 80)}”` };
    case "source":
      return { kind, preview: part.title };
    case "artifact":
      return { kind, preview: part.title };
    case "structured":
      /**
       * The validated answer of a structured agent — task #243.
       *
       * Rendered as compact JSON, truncated like every other preview. A structured answer is data, and the
       * honest preview of data is the data — inventing a prose summary of it here would be this layer guessing
       * at meaning it has no way to know.
       *
       * `JSON.stringify` can return `undefined` (for a bare `undefined`) and can throw on a circular value.
       * Neither should reach here — the part is validated against a schema before it is emitted — but a preview
       * helper that throws takes the whole transcript down with it, so both are handled.
       */
      return { kind, preview: safeJson(part.value).slice(0, 200) };
    case "status":
      return { kind, preview: part.detail ?? part.status };
    case "error":
      return { kind, preview: part.error.message };
  }
};

/**
 * What a citation is labelled with (#137).
 *
 * Derived from the stored part alone, with no lookup, which is what lets a months-old answer render after its
 * source is gone. A heading path when the chunker found one, then a title, then the URL — in decreasing
 * specificity, and never a bare document name, because a document-level citation is an invitation to go and
 * find the passage yourself.
 */
export const citationLabel = (part: Extract<MessagePart, { type: "citation" }>): string =>
  part.origin.kind === "retrieval"
    ? (part.origin.locator ?? `${part.origin.sourceId} — passage ${part.origin.chunkIndex + 1}`)
    : (part.origin.title ?? part.origin.url);

/**
 * Where a citation links, or `null` when it links nowhere.
 *
 * `null` for a retrieval citation because a chunk id is not a URL: the host decides how to open one, and
 * inventing a link here would produce one that does not work. The excerpt is still shown either way — that is
 * the point of the snapshot.
 */
export const citationHref = (part: Extract<MessagePart, { type: "citation" }>): string | null =>
  part.origin.kind === "web" ? part.origin.url : null;

/**
 * The ids of text parts a message's citations ground — AC-3.
 *
 * Derived from the citation graph, so a renderer distinguishes a grounded claim from an ungrounded one without
 * inspecting the prose. A claim that *mentions* a source is not grounded; one a citation names is.
 *
 * A copy of the backend's `groundedPartIds`, because R2 restricts this package to type-only imports from it.
 * Kept identical in behaviour and pinned by a test on both sides.
 */
export const groundedPartIds = (parts: readonly MessagePart[]): ReadonlySet<string> => {
  const grounded = new Set<string>();
  for (const part of parts) {
    if (part.type !== "citation") continue;
    for (const supported of part.supports) grounded.add(supported);
  }
  return grounded;
};

/** Stable React key for a part. */
export const partKey = (part: MessagePart): string => part.id;
