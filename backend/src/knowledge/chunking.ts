/**
 * Chunking extracted documents for retrieval (#135).
 *
 * The input is #131's `DocumentBlock[]`, which is the whole payoff of extracting to structure rather than a
 * flat string: a chunker that only sees text has to guess where a section ends, and a chunker that sees blocks
 * knows.
 *
 * Three decisions, each with a failure it avoids:
 *
 * - **Chunks respect block boundaries.** A chunk never starts mid-sentence or mid-table, because a retrieved
 *   fragment is quoted to a user and a half-sentence quoted as a citation is worse than no citation.
 * - **A table is one chunk, whole.** Splitting a table separates a number from its column header, and a number
 *   without its header is the specific failure this platform's extraction design exists to avoid — see #131.
 *   A table too large for one chunk is split *by rows with its header repeated*, so every piece still says what
 *   its columns mean.
 * - **The nearest preceding heading is prepended** to every chunk. "Revenue rose 9%" is unretrievable on its
 *   own and retrievable as "By region / EMEA / Revenue rose 9%" — and it is what makes a hit explicable.
 *
 * Overlap is by *block*, not by character: overlapping mid-sentence produces two chunks that both contain half
 * a thought and neither contains the whole one.
 */

import type { DocumentBlock } from "../documents/index.js";
import { estimateTokens } from "../core/tokens.js";
import { renderBlock } from "../documents/render.js";

export type ChunkingLimits = {
  /** Target size in tokens. Chunks land near this, never far above it. */
  readonly targetTokens: number;
  /**
   * Hard ceiling. A single block larger than this is split; nothing else is.
   *
   * Separate from the target because a block is indivisible in the good case, so "aim for 400" and "never
   * exceed 800" are different statements and collapsing them would either split freely or overflow freely.
   */
  readonly maxTokens: number;
  /** Blocks repeated at the start of the next chunk, so a thought spanning a boundary is retrievable. */
  readonly overlapBlocks: number;
};

export const DEFAULT_CHUNKING_LIMITS: ChunkingLimits = {
  // ~400 tokens is roughly two paragraphs: large enough to carry an argument, small enough that a hit is
  // mostly relevant rather than mostly padding.
  targetTokens: 400,
  maxTokens: 800,
  overlapBlocks: 1,
};

/**
 * A token estimate — one definition, in `core/tokens.ts`.
 *
 * Shared with the context assembler on purpose: a chunk sized against one estimate and budgeted against a
 * different one is a chunk that does not fit the budget it was measured for.
 */
// `estimateTokens` belongs to core and is reachable at `./runtime`. Re-exporting it here gave one name
// two subpaths, which #199 makes a rule against rather than a preference.

export type Chunk = {
  readonly index: number;
  readonly content: string;
  readonly tokenCount: number;
  /** The heading path this chunk sits under, for a citation that resolves. */
  readonly locator?: string;
};

/** The heading trail at a point in the document, e.g. `Quarterly Review > By region`. */
const headingPath = (trail: readonly { level: number; text: string }[]): string =>
  trail.map((h) => h.text).join(" > ");

/**
 * Split one oversized block.
 *
 * A table splits by rows with its header repeated; anything else splits by sentence. Sentences rather than
 * characters because a chunk boundary mid-word is a retrieved fragment that reads as corrupt.
 */
const splitBlock = (block: DocumentBlock, maxTokens: number): readonly string[] => {
  if (block.kind === "table") {
    const header = block.hasHeader ? block.rows[0] : undefined;
    const body = block.hasHeader ? block.rows.slice(1) : block.rows;
    const pieces: string[] = [];
    let current: (readonly string[])[] = [];
    const flush = () => {
      if (current.length === 0) return;
      pieces.push(
        renderBlock({
          kind: "table",
          rows: header === undefined ? current : [header, ...current],
          hasHeader: header !== undefined,
        }),
      );
      current = [];
    };
    for (const row of body) {
      current.push(row);
      // The header counts against every piece's budget, which is the price of every piece being readable.
      const rendered = renderBlock({
        kind: "table",
        rows: header === undefined ? current : [header, ...current],
        hasHeader: header !== undefined,
      });
      if (estimateTokens(rendered) >= maxTokens) flush();
    }
    flush();
    return pieces.length === 0 ? [renderBlock(block)] : pieces;
  }

  const text = renderBlock(block);
  // Split after sentence-ending punctuation followed by whitespace. Keeps the punctuation with its sentence.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current === "" ? sentence : `${current} ${sentence}`;
    if (estimateTokens(candidate) > maxTokens && current !== "") {
      pieces.push(current);
      current = sentence;
    } else current = candidate;
  }
  if (current !== "") pieces.push(current);
  return pieces.length === 0 ? [text] : pieces;
};

/**
 * Chunk a document.
 *
 * Headings are not chunks of their own — a heading alone retrieves nothing useful. They become the locator and
 * the prefix of the chunks beneath them, which is what makes an isolated sentence findable.
 */
export const chunkDocument = (
  blocks: readonly DocumentBlock[],
  limits: ChunkingLimits = DEFAULT_CHUNKING_LIMITS,
): readonly Chunk[] => {
  const chunks: Chunk[] = [];
  const trail: { level: number; text: string }[] = [];
  let pending: { rendered: string; block: DocumentBlock }[] = [];
  let pendingTokens = 0;

  const emit = () => {
    if (pending.length === 0) return;
    const path = headingPath(trail);
    // The heading path is prepended, not merely recorded: "Revenue rose 9%" is unretrievable alone and
    // retrievable as "By region / EMEA / Revenue rose 9%".
    const body = pending.map((p) => p.rendered).join("\n\n");
    const content = path === "" ? body : `${path}\n\n${body}`;
    chunks.push({
      index: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      ...(path === "" ? {} : { locator: path }),
    });
    // Overlap by block, so a thought spanning the boundary appears whole in one of the two chunks. Overlapping
    // mid-sentence would give two chunks that each contain half a thought and neither the whole one.
    const overlap = limits.overlapBlocks > 0 ? pending.slice(-limits.overlapBlocks) : [];
    pending = [...overlap];
    pendingTokens = overlap.reduce((n, p) => n + estimateTokens(p.rendered), 0);
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      // A heading ends the section above it: a chunk spanning two sections would carry the wrong locator for
      // half its content.
      emit();
      pending = [];
      pendingTokens = 0;
      while (trail.length > 0 && (trail[trail.length - 1]?.level ?? 0) >= block.level) trail.pop();
      trail.push({ level: block.level, text: block.text });
      continue;
    }

    const rendered = renderBlock(block);
    const tokens = estimateTokens(rendered);

    if (tokens > limits.maxTokens) {
      // Oversized: flush what is pending, then split this block into pieces that each stand alone.
      emit();
      pending = [];
      pendingTokens = 0;
      const path = headingPath(trail);
      for (const piece of splitBlock(block, limits.maxTokens)) {
        const content = path === "" ? piece : `${path}\n\n${piece}`;
        chunks.push({
          index: chunks.length,
          content,
          tokenCount: estimateTokens(content),
          ...(path === "" ? {} : { locator: path }),
        });
      }
      continue;
    }

    if (pendingTokens + tokens > limits.targetTokens && pending.length > 0) emit();
    pending.push({ rendered, block });
    pendingTokens += tokens;
  }
  emit();

  // Re-index, because `emit` numbers as it goes and the overlap means the count is not the block count.
  return chunks.map((c, i) => ({ ...c, index: i }));
};
