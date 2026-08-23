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
  | "error";

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
};

/**
 * A file size in binary units, for an attachment preview (#130).
 *
 * The backend renders the same figure in `files/context.ts`, and R2 makes this a copy rather than an import:
 * the frontend may only `import type` from `@agentkit/backend`. Two things keep the copy honest — the unit
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
      return { kind, preview: `“${part.quote.slice(0, 80)}”` };
    case "source":
      return { kind, preview: part.title };
    case "artifact":
      return { kind, preview: part.title };
    case "status":
      return { kind, preview: part.detail ?? part.status };
    case "error":
      return { kind, preview: part.error.message };
  }
};

/** Stable React key for a part. */
export const partKey = (part: MessagePart): string => part.id;
