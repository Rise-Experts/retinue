/**
 * The `mermaid` diagram block.
 *
 * THE CONTRACT: the agent emits an ordinary fenced block, exactly as it would
 * anywhere else in the markdown ecosystem —
 *
 *     ```mermaid
 *     flowchart LR
 *       A[Draft] --> B{Approved?}
 *       B -->|yes| C[Publish]
 *     ```
 *
 * WHY CLIENT-SIDE RENDERING: this is how Claude and GitHub do it, and here it also
 * avoids a failure we have already lived through. Rendering a diagram to an image
 * server-side needs a headless browser, and a headless Chromium is exactly what
 * OOM-killed this product's API process mid-stream. Rendering in the browser costs
 * the server nothing.
 *
 * Text also degrades well: if mermaid cannot parse a diagram the source is still
 * readable, still copyable, and still diffable in a way an image never is.
 *
 * This module holds only the rules — detection, and the sanity checks that decide
 * whether a block is worth handing to mermaid at all. Component behaviour cannot
 * be unit-tested here (no jsdom), so nothing that could be wrong lives in the
 * renderer.
 */

/** Fence info string that marks a diagram. */
export const MERMAID_LANG = 'mermaid';

/**
 * Diagram types mermaid understands. A block whose first meaningful line is not
 * one of these will fail to parse, and catching it here means showing the source
 * instead of mermaid's own error graphic — which is far less useful to a reader.
 *
 * Kept as a prefix list rather than a strict grammar: mermaid adds diagram types
 * regularly, and being slightly permissive costs nothing (mermaid still validates)
 * while being strict would reject valid new syntax.
 */
const DIAGRAM_KEYWORDS = [
  'flowchart',
  'graph',
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantchart',
  'requirementdiagram',
  'gitgraph',
  'mindmap',
  'timeline',
  'sankey',
  'xychart',
  'block',
  'packet',
  'architecture',
  'kanban',
  'radar',
  'treemap',
];

/** True when a react-markdown code node's className marks it as a diagram. */
export function isMermaidLang(className: string | undefined): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(`language-${MERMAID_LANG}`);
}

/**
 * Decides whether `source` is a diagram worth rendering.
 *
 * Returns the trimmed source, or null when it should be shown as plain code.
 * Null covers the streaming case as much as the invalid one: a diagram arrives
 * token by token, so for a moment the block holds `flow` or half a node, and
 * handing that to mermaid produces a flash of error graphic that then resolves —
 * visually much worse than the source appearing and then becoming a diagram.
 */
export function parseMermaid(source: string): string | null {
  if (typeof source !== 'string') return null;

  const trimmed = source.trim();
  if (trimmed.length === 0) return null;

  // Comments and directives may legitimately precede the diagram declaration.
  const firstMeaningful = trimmed
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'));

  if (!firstMeaningful) return null;

  const head = firstMeaningful.toLowerCase();
  const known = DIAGRAM_KEYWORDS.some((keyword) => head.startsWith(keyword));
  if (!known) return null;

  // A declaration alone is not yet a diagram — it is the first token of one. Two
  // lines, or a declaration with content on it, is the cheapest reliable signal
  // that the block has finished arriving.
  const hasBody = trimmed.includes('\n') || head.length > firstMeaningful.split(/\s+/)[0].length;
  if (!hasBody) return null;

  // Repaired on the way out so every caller — the chat renderer and the
  // image renderer — gets the same fixed source, and a diagram that only failed
  // for unquoted parentheses renders instead of showing as code.
  return repairMermaidLabels(trimmed);
}

/**
 * Repairs the one mermaid mistake models make constantly: unquoted parentheses
 * inside a node label.
 *
 *     A[Mobile App (Client)]      -> parse error
 *     A["Mobile App (Client)"]    -> fine
 *
 * Mermaid's grammar treats `(` and `)` as shape delimiters, so they cannot appear
 * bare inside `[...]`, `{...}` or `((...))`. Quoting the label makes it literal
 * text. Models reach for parentheses naturally ("Mobile App (Client)", "Cache
 * (Redis)") and this single class of error accounts for most diagrams that arrive
 * unrenderable.
 *
 * WHY REPAIR RATHER THAN JUST INSTRUCT: the agent instructions do say to quote
 * these, but an instruction is a probability and a diagram either renders or it
 * does not. This transform is narrow and reversible in meaning — it changes only
 * how a label is delimited, never the graph — so applying it is much cheaper than
 * showing the user a wall of source.
 *
 * Deliberately conservative:
 *  - only labels that CONTAIN a parenthesis are touched; everything else is
 *    already valid and is left byte-identical;
 *  - an already-quoted label is skipped, so this never double-quotes;
 *  - a label containing a double quote is skipped, because quoting it would need
 *    escaping rules mermaid does not have — better to leave it and let the
 *    fallback show the source than to produce different broken output.
 */
export function repairMermaidLabels(source: string): string {
  // `id[...]` and `id{...}`. Round nodes `id(...)` are excluded: their delimiter IS
  // the parenthesis, so the naive rule would corrupt every one of them.
  return source.replace(
    /(^|[^\w"'`])([A-Za-z_][\w-]*)(\[|\{)([^\]\}\n]*)(\]|\})/g,
    (match, before, id, open, label: string, close) => {
      // Bracket and brace must pair; a mismatch means the regex straddled
      // something it should not rewrite.
      const pairs: Record<string, string> = { '[': ']', '{': '}' };
      if (pairs[open] !== close) return match;

      if (!label.includes('(') && !label.includes(')')) return match;
      const trimmed = label.trim();
      if (trimmed.startsWith('"') || trimmed.includes('"')) return match;

      return `${before}${id}${open}"${trimmed}"${close}`;
    },
  );
}

/**
 * mermaid's init config.
 *
 * Exported and pure so the two settings that matter can be asserted in a test. Both
 * have been the cause of a real bug:
 *
 * - `securityLevel: 'strict'` — diagram source is model-generated text, and mermaid
 *   can otherwise emit clickable callbacks and raw HTML from a definition.
 * - `suppressErrorRendering: true` — without it, `render()` appends mermaid's own
 *   "Syntax error in text / mermaid version …" block to document.body and then
 *   throws. The caller caught the throw and showed a proper fallback, but the
 *   injected node stayed, so every unparseable diagram left a banner stacked at the
 *   bottom of the site, outside the React tree and impossible to clear.
 */
export function mermaidInitConfig(prefersDark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: prefersDark ? "dark" : "default",
    fontFamily: "inherit",
  } as const;
}

/**
 * The human-readable reason a diagram would not render.
 *
 * mermaid throws an Error for a parse failure, but a thrown non-Error has been seen
 * from its internals, and `String(someObject)` yields "[object Object]" — which is
 * what the user ends up reading. This keeps that out of the UI.
 */
export function mermaidErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message.trim()) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  // Some mermaid internals throw a plain object carrying `str`.
  if (e && typeof e === "object" && "str" in e) {
    const str = (e as { str?: unknown }).str;
    if (typeof str === "string" && str.trim()) return str;
  }
  return "Unknown mermaid error";
}
