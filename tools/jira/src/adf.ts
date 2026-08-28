/**
 * Atlassian Document Format ↔ markdown — REQ-052 (#224), task #225, AC-5.
 *
 * Jira Cloud's REST v3 takes and returns descriptions and comments as **ADF**: a JSON document tree, not text.
 * A model writes markdown. So something has to convert, and the only question is what it does with the parts of
 * ADF that markdown has no word for — panels, media, mentions, status lozenges, tables, expands.
 *
 * **It degrades to text; it never throws.** An unknown node yields whatever text it contains, and an unknown
 * mark yields its content unmarked. The alternative — refusing a document that contains a panel — means a tool
 * that fails on the real issues in any real Jira project, which is worse than an imperfect rendering: the
 * information a model needs is in the text, and losing the box around it costs nothing it can act on.
 *
 * The round trip is therefore **lossy by design and total by contract**. What round-trips exactly is the subset
 * the AC names: paragraphs, headings, bullet and ordered lists, code blocks, links, bold, italic, inline code.
 */

/** A node in an ADF document. Deliberately loose — the point is to survive shapes this does not know. */
export type AdfNode = {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly { readonly type?: string; readonly attrs?: Readonly<Record<string, unknown>> }[];
  readonly content?: readonly AdfNode[];
};

export type AdfDocument = { readonly type: "doc"; readonly version: 1; readonly content: readonly AdfNode[] };

/** The empty document Jira wants when a field is being cleared — `null` is rejected on some field types. */
export const EMPTY_ADF: AdfDocument = { type: "doc", version: 1, content: [] };

const escapeMarkdown = (text: string): string =>
  // Only the characters that would change the *structure* if re-parsed. Escaping more (parentheses, dots,
  // hyphens) makes ordinary prose unreadable, which is the opposite of the point.
  text.replace(/([\\`*_[\]])/g, "\\$1");

/** Text with its marks applied, innermost first so `**_x_**` nests rather than interleaving. */
const inlineToMarkdown = (node: AdfNode): string => {
  if (node.type === "hardBreak") return "\n";
  // An inline node this does not know may still carry text — a mention's `attrs.text`, for one. Preferring the
  // text over silence is the degradation rule.
  const raw = node.text ?? (typeof node.attrs?.text === "string" ? node.attrs.text : "");
  if (raw === "") return (node.content ?? []).map(inlineToMarkdown).join("");

  const marks = node.marks ?? [];
  // `code` first and alone: markdown has no way to bold the inside of a code span, and Jira happily sets both.
  if (marks.some((mark) => mark.type === "code")) return `\`${raw}\``;

  let text = escapeMarkdown(raw);
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        text = `**${text}**`;
        break;
      case "em":
        text = `_${text}_`;
        break;
      case "strike":
        text = `~~${text}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        text = href === "" ? text : `[${text}](${href})`;
        break;
      }
      default:
        // An unknown mark yields its content unmarked, which is the degradation rule for marks.
        break;
    }
  }
  return text;
};

const inlinesToMarkdown = (nodes: readonly AdfNode[] | undefined): string =>
  (nodes ?? []).map(inlineToMarkdown).join("");

/** A list, flattened with two-space indents per level so nesting survives the round trip. */
const listToMarkdown = (node: AdfNode, ordered: boolean, depth: number): string => {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let index = 0;
  for (const item of node.content ?? []) {
    index += 1;
    const marker = ordered ? `${index}.` : "-";
    const parts: string[] = [];
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        parts.push(listToMarkdown(child, child.type === "orderedList", depth + 1));
      } else {
        parts.push(`${indent}${marker} ${blockToMarkdown(child, depth).trimStart()}`);
      }
    }
    // A list item with no recognised block still contributes its text rather than an empty bullet.
    lines.push(parts.length === 0 ? `${indent}${marker} ${inlinesToMarkdown(item.content)}` : parts.join("\n"));
  }
  return lines.join("\n");
};

const blockToMarkdown = (node: AdfNode, depth = 0): string => {
  switch (node.type) {
    case "paragraph":
      return inlinesToMarkdown(node.content);
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? Math.min(Math.max(node.attrs.level, 1), 6) : 1;
      return `${"#".repeat(level)} ${inlinesToMarkdown(node.content)}`;
    }
    case "bulletList":
      return listToMarkdown(node, false, depth);
    case "orderedList":
      return listToMarkdown(node, true, depth);
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      // Raw, not escaped: a code block's content is not markdown and escaping it would corrupt the code.
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case "rule":
      return "---";
    case "blockquote":
      return (node.content ?? [])
        .map((child) => blockToMarkdown(child, depth))
        .flatMap((text) => text.split("\n"))
        .map((line) => `> ${line}`)
        .join("\n");
    default:
      /**
       * Everything else: a panel, an expand, a table, a media group, or a node that did not exist when this was
       * written. Its text comes out, and its box does not.
       *
       * Recursing rather than reading `.text` directly matters — a panel's text is two levels down, inside a
       * paragraph inside the panel, and a shallow read would return nothing at all for the most common case.
       */
      if (node.content !== undefined) {
        return node.content.map((child) => blockToMarkdown(child, depth)).filter((text) => text !== "").join("\n\n");
      }
      return node.text ?? "";
  }
};

/**
 * An ADF document as markdown. Total: any input produces a string.
 */
export const adfToMarkdown = (doc: unknown): string => {
  if (typeof doc === "string") return doc; // Some older fields answer in plain text or wiki markup.
  if (doc === null || typeof doc !== "object") return "";
  const node = doc as AdfNode;
  const blocks = (node.content ?? []).map((child) => blockToMarkdown(child)).filter((text) => text !== "");
  return blocks.join("\n\n");
};

const textNode = (text: string, marks?: readonly { type: string; attrs?: Record<string, unknown> }[]): AdfNode =>
  marks === undefined || marks.length === 0 ? { type: "text", text } : { type: "text", text, marks };

/**
 * One line of inline markdown as ADF inline nodes.
 *
 * One pass with a single alternation rather than a chain of replacements, because the chain gets `**bold**`
 * wrong the moment a `_` appears inside it — the second pass sees markup the first pass already consumed.
 */
const parseInline = (line: string): AdfNode[] => {
  const nodes: AdfNode[] = [];
  const pattern = /(`[^`]+`)|(\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(_[^_]+_)|(\\.)/g;
  let last = 0;
  const pushText = (text: string) => {
    if (text !== "") nodes.push(textNode(text));
  };
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    pushText(line.slice(last, at).replace(/\\([\\`*_[\]])/g, "$1"));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(textNode(token.slice(1, -1), [{ type: "code" }]));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? "";
      nodes.push(href === "" ? textNode(label) : textNode(label, [{ type: "link", attrs: { href } }]));
    } else if (token.startsWith("**")) {
      nodes.push(textNode(token.slice(2, -2), [{ type: "strong" }]));
    } else if (token.startsWith("~~")) {
      nodes.push(textNode(token.slice(2, -2), [{ type: "strike" }]));
    } else if (token.startsWith("_")) {
      nodes.push(textNode(token.slice(1, -1), [{ type: "em" }]));
    } else {
      // An escape: the escaped character, literally.
      pushText(token.slice(1));
    }
    last = at + token.length;
  }
  pushText(line.slice(last).replace(/\\([\\`*_[\]])/g, "$1"));
  return nodes.length === 0 ? [] : nodes;
};

/**
 * Markdown as an ADF document — the direction a model's input travels.
 *
 * A line-based parser, not a full markdown implementation. It handles what the AC names and treats anything
 * else as a paragraph, which is the same degradation rule in the other direction: a table written in markdown
 * arrives in Jira as the text of a table rather than as an error.
 */
export const markdownToAdf = (markdown: string): AdfDocument => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const content: AdfNode[] = [];
  let index = 0;

  const listItemOf = (line: string): { ordered: boolean; depth: number; text: string } | null => {
    const match = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (match === null) return null;
    return {
      ordered: match[3] !== undefined,
      depth: Math.floor((match[1] ?? "").length / 2),
      text: match[4] ?? "",
    };
  };

  /** One list, and its nested sublists, consumed from `index`. */
  const takeList = (ordered: boolean, depth: number): AdfNode => {
    const items: AdfNode[] = [];
    while (index < lines.length) {
      const item = listItemOf(lines[index] as string);
      if (item === null || item.depth < depth || item.ordered !== ordered) break;
      if (item.depth > depth) {
        const nested = takeList(item.ordered, item.depth);
        const previous = items[items.length - 1];
        if (previous === undefined) items.push({ type: "listItem", content: [nested] });
        else items[items.length - 1] = { type: "listItem", content: [...(previous.content ?? []), nested] };
        continue;
      }
      index += 1;
      items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(item.text) }] });
    }
    return { type: ordered ? "orderedList" : "bulletList", content: items };
  };

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
      index += 1; // the closing fence, or the end of input if it was never closed
      const language = fence[1] ?? "";
      content.push({
        type: "codeBlock",
        ...(language === "" ? {} : { attrs: { language } }),
        content: [{ type: "text", text: code.join("\n") }],
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      index += 1;
      content.push({
        type: "heading",
        attrs: { level: (heading[1] as string).length },
        content: parseInline(heading[2] as string),
      });
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      index += 1;
      content.push({ type: "rule" });
      continue;
    }
    const item = listItemOf(line);
    if (item !== null) {
      content.push(takeList(item.ordered, item.depth));
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] as string)) {
        quoted.push((lines[index] as string).replace(/^>\s?/, ""));
        index += 1;
      }
      content.push({ type: "blockquote", content: markdownToAdf(quoted.join("\n")).content });
      continue;
    }
    // A paragraph: consecutive non-blank lines that start nothing else, joined with hard breaks so a
    // deliberately wrapped paragraph does not become one long line.
    const paragraph: AdfNode[] = [];
    while (index < lines.length) {
      const current = lines[index] as string;
      if (
        current.trim() === "" ||
        /^```/.test(current) ||
        /^#{1,6}\s/.test(current) ||
        /^>\s?/.test(current) ||
        listItemOf(current) !== null
      ) {
        break;
      }
      if (paragraph.length > 0) paragraph.push({ type: "hardBreak" });
      paragraph.push(...parseInline(current));
      index += 1;
    }
    content.push({ type: "paragraph", content: paragraph });
  }

  return { type: "doc", version: 1, content };
};
