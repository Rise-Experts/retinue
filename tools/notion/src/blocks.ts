/**
 * Notion's block tree ↔ markdown — REQ-052 (#224), task #226, AC-6.
 *
 * A Notion page is not a document. It is a **tree of blocks**, each fetched by a separate paginated request
 * against its parent's id, and a page with nested toggles and columns can be dozens of requests deep. So
 * flattening it is not a formatting problem, it is a *budget* problem: an unbounded walk can hang, cost a
 * fortune in requests, and return more text than a context window holds.
 *
 * Hence three bounds, and **the result says which one it hit**:
 *
 * - `MAX_DEPTH` — how far into nested children to descend.
 * - `MAX_BLOCKS` — how many blocks to render in total.
 * - `MAX_CHARS` — how much text to return.
 *
 * A truncated page that says it is truncated is useful. One that stops silently is a lie about a document, and
 * a model summarising half a page while believing it read all of it is worse than one told to narrow its
 * request.
 */

/** Deep enough for a real page's toggles and lists; shallow enough that a pathological tree terminates. */
export const MAX_DEPTH = 4;
export const MAX_BLOCKS = 400;
export const MAX_CHARS = 40_000;

export type RichText = { readonly plain_text?: string; readonly href?: string | null; readonly annotations?: Record<string, unknown> };

export type Block = {
  readonly id?: string;
  readonly type?: string;
  readonly has_children?: boolean;
  readonly [key: string]: unknown;
};

/**
 * Notion's rich text as markdown.
 *
 * `plain_text` carries the characters and `annotations` carries the marks, so both are needed — reading only
 * `plain_text` loses every link and every emphasis in the page.
 */
export const richTextToMarkdown = (rich: readonly RichText[] | undefined): string =>
  (rich ?? [])
    .map((span) => {
      let text = span.plain_text ?? "";
      if (text === "") return "";
      const marks = (span.annotations ?? {}) as Record<string, boolean>;
      // `code` first and alone: markdown cannot bold the inside of a code span, and Notion sets both happily.
      if (marks.code === true) return `\`${text}\``;
      if (marks.bold === true) text = `**${text}**`;
      if (marks.italic === true) text = `_${text}_`;
      if (marks.strikethrough === true) text = `~~${text}~~`;
      const href = span.href;
      return href === null || href === undefined || href === "" ? text : `[${text}](${href})`;
    })
    .join("");

const richOf = (block: Block, key: string): readonly RichText[] | undefined => {
  const payload = block[key] as { rich_text?: readonly RichText[] } | undefined;
  return payload?.rich_text;
};

/**
 * One block as a markdown line, or `null` for a block that has no textual form of its own.
 *
 * `null` rather than `""` so a container — a column, a synced block — is distinguishable from an empty
 * paragraph: the container still has children worth descending into.
 */
export const blockToMarkdown = (block: Block, depth: number): string | null => {
  const indent = "  ".repeat(depth);
  switch (block.type) {
    case "paragraph":
      return `${indent}${richTextToMarkdown(richOf(block, "paragraph"))}`;
    case "heading_1":
      return `${indent}# ${richTextToMarkdown(richOf(block, "heading_1"))}`;
    case "heading_2":
      return `${indent}## ${richTextToMarkdown(richOf(block, "heading_2"))}`;
    case "heading_3":
      return `${indent}### ${richTextToMarkdown(richOf(block, "heading_3"))}`;
    case "bulleted_list_item":
      return `${indent}- ${richTextToMarkdown(richOf(block, "bulleted_list_item"))}`;
    case "numbered_list_item":
      // Notion does not number them; markdown renumbers `1.` correctly, and guessing an index across a
      // paginated fetch would be wrong more often than not.
      return `${indent}1. ${richTextToMarkdown(richOf(block, "numbered_list_item"))}`;
    case "to_do": {
      const done = (block.to_do as { checked?: boolean } | undefined)?.checked === true;
      return `${indent}- [${done ? "x" : " "}] ${richTextToMarkdown(richOf(block, "to_do"))}`;
    }
    case "toggle":
      return `${indent}- ${richTextToMarkdown(richOf(block, "toggle"))}`;
    case "quote":
      return `${indent}> ${richTextToMarkdown(richOf(block, "quote"))}`;
    case "callout":
      return `${indent}> ${richTextToMarkdown(richOf(block, "callout"))}`;
    case "code": {
      const payload = block.code as { language?: string } | undefined;
      const text = richTextToMarkdown(richOf(block, "code"));
      return `${indent}\`\`\`${payload?.language ?? ""}\n${text}\n${indent}\`\`\``;
    }
    case "divider":
      return `${indent}---`;
    case "child_page":
      // Named rather than descended into: a child page is a separate page with its own id, and following it
      // would make "read this page" unbounded in the one direction the caller cannot see.
      return `${indent}- [child page] ${(block.child_page as { title?: string } | undefined)?.title ?? ""}`;
    case "child_database":
      return `${indent}- [database] ${(block.child_database as { title?: string } | undefined)?.title ?? ""}`;
    case "image":
    case "file":
    case "pdf":
    case "video": {
      const payload = block[block.type] as { caption?: readonly RichText[]; external?: { url?: string }; file?: { url?: string } } | undefined;
      const caption = richTextToMarkdown(payload?.caption);
      const url = payload?.external?.url ?? payload?.file?.url ?? "";
      return `${indent}[${block.type}${caption === "" ? "" : `: ${caption}`}](${url})`;
    }
    case "table":
    case "column_list":
    case "column":
    case "synced_block":
      // Containers: no text of their own, and their children are the content.
      return null;
    case "table_row": {
      const cells = ((block.table_row as { cells?: readonly (readonly RichText[])[] } | undefined)?.cells ?? []).map(
        (cell) => richTextToMarkdown(cell),
      );
      return `${indent}| ${cells.join(" | ")} |`;
    }
    default: {
      /**
       * An unknown block type — Notion adds them — yields whatever rich text it carries.
       *
       * The degradation rule: a page containing a block type this does not know renders its text and loses its
       * shape, rather than the tool refusing the page.
       */
      const payload = block[block.type ?? ""] as { rich_text?: readonly RichText[] } | undefined;
      const text = richTextToMarkdown(payload?.rich_text);
      return text === "" ? null : `${indent}${text}`;
    }
  }
};

export type FlattenResult = {
  readonly markdown: string;
  readonly truncated: boolean;
  /** Which bound stopped it, so the caller can say something more useful than "there was more". */
  readonly stoppedBy: "depth" | "blocks" | "characters" | null;
  readonly blocksRead: number;
};

/**
 * Walk the tree breadth-first within each level, bounded, fetching children through `childrenOf`.
 *
 * The fetch is injected rather than done here so this is testable without a network and so the transport stays
 * in one place.
 */
export const flattenBlocks = async (
  roots: readonly Block[],
  childrenOf: (id: string) => Promise<readonly Block[]>,
  bounds: { depth?: number; blocks?: number; chars?: number } = {},
): Promise<FlattenResult> => {
  const maxDepth = bounds.depth ?? MAX_DEPTH;
  const maxBlocks = bounds.blocks ?? MAX_BLOCKS;
  const maxChars = bounds.chars ?? MAX_CHARS;

  const lines: string[] = [];
  let blocksRead = 0;
  let characters = 0;
  let stoppedBy: FlattenResult["stoppedBy"] = null;

  const walk = async (blocks: readonly Block[], depth: number): Promise<void> => {
    for (const block of blocks) {
      if (stoppedBy !== null) return;
      if (blocksRead >= maxBlocks) {
        stoppedBy = "blocks";
        return;
      }
      blocksRead += 1;
      const line = blockToMarkdown(block, depth);
      if (line !== null) {
        if (characters + line.length > maxChars) {
          stoppedBy = "characters";
          return;
        }
        lines.push(line);
        characters += line.length + 1;
      }
      if (block.has_children === true && typeof block.id === "string") {
        if (depth + 1 > maxDepth) {
          // Noted rather than silently dropped: the page *has* more here, and a summary that does not know
          // that is a summary of a different document.
          stoppedBy = stoppedBy ?? "depth";
          continue;
        }
        await walk(await childrenOf(block.id), depth + 1);
      }
    }
  };

  await walk(roots, 0);
  return { markdown: lines.join("\n"), truncated: stoppedBy !== null, stoppedBy, blocksRead };
};

/** Markdown as Notion blocks, for `notion_append_blocks`. The subset Notion's API accepts directly. */
export const markdownToBlocks = (markdown: string): readonly Record<string, unknown>[] => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: Record<string, unknown>[] = [];
  const text = (value: string) => [{ type: "text", text: { content: value } }];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence !== null) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      blocks.push({
        object: "block",
        type: "code",
        // Notion rejects an unknown language outright, and `plain text` is always accepted.
        code: { rich_text: text(code.join("\n")), language: (fence[1] ?? "").trim() === "" ? "plain text" : (fence[1] as string).trim() },
      });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      index += 1;
      const level = (heading[1] as string).length;
      const type = `heading_${level}`;
      blocks.push({ object: "block", type, [type]: { rich_text: text(heading[2] as string) } });
      continue;
    }
    const todo = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo !== null) {
      index += 1;
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: { rich_text: text(todo[2] as string), checked: (todo[1] ?? " ").toLowerCase() === "x" },
      });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      index += 1;
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: text(bullet[1] as string) } });
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered !== null) {
      index += 1;
      blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: text(numbered[1] as string) } });
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      index += 1;
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      index += 1;
      blocks.push({ object: "block", type: "quote", quote: { rich_text: text(quote[1] as string) } });
      continue;
    }
    index += 1;
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: text(line) } });
  }
  return blocks;
};
