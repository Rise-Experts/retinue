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
      return { kind, preview: part.filename };
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
