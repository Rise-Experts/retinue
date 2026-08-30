/**
 * HTML to markdown — REQ-055 (#237), task #238, AC-7.
 *
 * A real parser rather than a pile of regular expressions, because the AC asks for tables and nesting to
 * survive and neither does under substitution. `<table>` in particular is the case that settles it: turning
 * rows into markdown needs to know how many cells the widest row has *before* the first row is written, which
 * is not a thing a stream of replacements can know.
 *
 * ## What is dropped, and why that is the interesting half
 *
 * `script`, `style`, `noscript`, `svg`, `template`, `iframe`, `form` and comments go entirely. So do `nav`,
 * `header`, `footer` and `aside` — the chrome. Dropping chrome matters more than it sounds: on a typical
 * documentation page the navigation is *most of the words*, it is the same words on every page, and it is
 * where a model's attention goes if nobody removes it. A crawl of forty pages that keeps the nav has fetched
 * one page of content and thirty-nine copies of a sidebar.
 *
 * When the page marks its content — `<article>`, `<main>`, `role="main"` — that subtree is used and the rest
 * is discarded wholesale. Otherwise the body is used with the chrome elements removed individually.
 *
 * ## What is kept
 *
 * Headings, paragraphs, lists (nested, ordered and not), tables, code blocks with their language when the
 * usual `language-x` class says it, blockquotes, and **link targets** — a scrape whose links are stripped to
 * their text is a dead end for an agent that was going to follow one.
 */

/** A parsed node. Text or an element; nothing else survives parsing. */
export type Node =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "element"; readonly tag: string; readonly attrs: Readonly<Record<string, string>>; readonly children: Node[] };

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Dropped with their contents. `form` and `iframe` are here because their text is never the page's content. */
const DISCARD = new Set(["script", "style", "noscript", "svg", "template", "iframe", "form", "button", "select"]);

/** Page chrome. Dropped only when the page did not mark its main content explicitly. */
const CHROME = new Set(["nav", "header", "footer", "aside"]);

/** Tags that close an open one of the same kind — `<p>a<p>b` is two paragraphs, not a nest. */
const IMPLICIT_CLOSE: Readonly<Record<string, readonly string[]>> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
};

/**
 * How far back an implicit close may look — and getting this wrong un-nests every nested list.
 *
 * `<li>a<ul><li>b</li></ul></li>` is one item containing a list. Without a boundary, the inner `<li>` closes
 * the outer one, the sublist becomes a *sibling*, and the output is a flat list where the page had a tree.
 * That is not a cosmetic difference: the nesting is what says "these belong to that".
 *
 * So the search for the element to close stops at the container the element lives in — a new `<li>` may close
 * the previous `<li>` in *its own* list and nothing outside it, and the same for cells within a table.
 */
const CLOSE_BOUNDARY: Readonly<Record<string, readonly string[]>> = {
  li: ["ul", "ol", "menu"],
  dt: ["dl"],
  dd: ["dl"],
  tr: ["table", "thead", "tbody", "tfoot"],
  td: ["table", "thead", "tbody", "tfoot", "tr"],
  th: ["table", "thead", "tbody", "tfoot", "tr"],
  option: ["select", "datalist", "optgroup"],
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
};

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

const parseAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "") continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
};

/**
 * Parses HTML into a tree, tolerating everything real pages do wrong.
 *
 * Unclosed tags, mismatched nesting and stray `<` are all normal on the open web; a parser that throws on them
 * is a scraper that fails on a large fraction of its input. So a close tag with no matching open is ignored,
 * and an unclosed element is closed by its parent ending.
 */
export const parseHtml = (html: string): Node => {
  const root: Node = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: Extract<Node, { kind: "element" }>[] = [root as Extract<Node, { kind: "element" }>];
  const top = () => stack[stack.length - 1] as Extract<Node, { kind: "element" }>;

  // `<!-- -->`, `<!doctype>` and `<?...?>` carry nothing and complicate everything downstream.
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  const pattern = /<\/?([a-zA-Z][-a-zA-Z0-9:]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!\s*[^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushText = (text: string) => {
    if (text === "") return;
    top().children.push({ kind: "text", text: decodeEntities(text) });
  };

  while ((match = pattern.exec(source)) !== null) {
    pushText(source.slice(cursor, match.index));
    cursor = pattern.lastIndex;

    const tag = match[1]?.toLowerCase();
    if (tag === undefined) continue; // a doctype or processing instruction
    const closing = match[0].startsWith("</");
    const raw = match[2] ?? "";

    if (closing) {
      // Close the nearest matching ancestor. Nothing matching means a stray tag, which is ignored.
      const at = stack.map((node) => node.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }

    /**
     * A raw-text element's contents are not markup.
     *
     * `<script>if (a < b) …</script>` would otherwise be parsed as a tag named `b`, and everything after it
     * ends up inside an element that never closes. Skipping to the matching close tag is the only correct
     * handling, and it is also how the contents get discarded.
     */
    if (tag === "script" || tag === "style" || tag === "textarea" || tag === "title") {
      const end = source.toLowerCase().indexOf(`</${tag}`, cursor);
      const text = source.slice(cursor, end === -1 ? source.length : end);
      const element: Node = { kind: "element", tag, attrs: parseAttrs(raw), children: [{ kind: "text", text }] };
      top().children.push(element);
      cursor = end === -1 ? source.length : end;
      pattern.lastIndex = cursor;
      continue;
    }

    const implicit = IMPLICIT_CLOSE[tag] ?? [];
    if (implicit.length > 0) {
      const boundary = new Set(CLOSE_BOUNDARY[tag] ?? []);
      // Walk out from the top, stopping at the container this element belongs to.
      for (let at = stack.length - 1; at > 0; at -= 1) {
        const open = (stack[at] as Extract<Node, { kind: "element" }>).tag;
        if (boundary.has(open)) break;
        if (implicit.includes(open)) {
          stack.length = at;
          break;
        }
      }
    }

    const element = { kind: "element" as const, tag, attrs: parseAttrs(raw), children: [] as Node[] };
    top().children.push(element);
    if (!VOID.has(tag) && !raw.trimEnd().endsWith("/")) stack.push(element);
  }
  pushText(source.slice(cursor));
  return root;
};

const isElement = (node: Node): node is Extract<Node, { kind: "element" }> => node.kind === "element";

/** Depth-first search for the first element passing `matches`. */
export const findElement = (
  node: Node,
  matches: (element: Extract<Node, { kind: "element" }>) => boolean,
): Extract<Node, { kind: "element" }> | undefined => {
  if (isElement(node)) {
    if (node.tag !== "#root" && matches(node)) return node;
    for (const child of node.children) {
      const found = findElement(child, matches);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** All the text under a node, whitespace collapsed. Used for headings, cells and link labels. */
export const textOf = (node: Node): string => {
  if (node.kind === "text") return node.text;
  if (DISCARD.has(node.tag)) return "";
  return node.children.map(textOf).join("");
};

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Markdown's structural characters, escaped so page text cannot forge structure in the output. */
const escapeText = (text: string): string => text.replace(/([\\`*_[\]<>|])/g, "\\$1");

const languageOf = (element: Extract<Node, { kind: "element" }>): string => {
  const source = `${element.attrs.class ?? ""} ${element.attrs["data-language"] ?? ""}`;
  const match = /(?:language|lang|highlight)-([a-z0-9+#]+)/i.exec(source);
  return match?.[1]?.toLowerCase() ?? "";
};

type Context = { readonly baseUrl?: URL };

/** Renders inline content: emphasis, code, and links with their targets kept. */
const inline = (nodes: readonly Node[], context: Context): string =>
  nodes
    .map((node): string => {
      if (node.kind === "text") return escapeText(node.text);
      if (DISCARD.has(node.tag) || CHROME.has(node.tag)) return "";
      const inner = () => inline(node.children, context);
      switch (node.tag) {
        case "br":
          return "\n";
        case "strong":
        case "b": {
          const text = inner().trim();
          return text === "" ? "" : `**${text}**`;
        }
        case "em":
        case "i": {
          const text = inner().trim();
          return text === "" ? "" : `*${text}*`;
        }
        case "code": {
          // Backticks inside inline code need a longer fence, which is the one detail that makes code round-trip.
          const text = collapse(textOf(node));
          if (text === "") return "";
          const longest = (/`+/g.exec(text) ?? [""])[0]?.length ?? 0;
          const fence = "`".repeat(Math.max(1, longest + 1));
          return `${fence}${text}${fence}`;
        }
        case "img": {
          const alt = collapse(node.attrs.alt ?? "");
          const source = resolveUrl(node.attrs.src ?? "", context);
          return source === "" ? "" : `![${escapeText(alt)}](${source})`;
        }
        case "a": {
          const label = inner().trim();
          const href = resolveUrl(node.attrs.href ?? "", context);
          /**
           * The target is kept, which is the point.
           *
           * A scrape whose links are flattened to their text is a dead end for an agent that meant to follow
           * one — it can see there was a link and not where it went, which is worse than not showing it.
           */
          /**
           * Only somewhere an agent could actually navigate.
           *
           * `mailto:`, `tel:` and `javascript:` are not pages. Rendering them as links offers a model a
           * destination it cannot follow, and `linksIn` already refuses to put them in a crawl frontier — the
           * two had disagreed, which is how a scrape suggests a link the crawl would never take.
           */
          if (href === "" || !/^https?:\/\//i.test(href)) return label;
          return label === "" ? "" : `[${label}](${href})`;
        }
        default:
          return inner();
      }
    })
    .join("");

const resolveUrl = (href: string, context: Context): string => {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return "";
  if (context.baseUrl === undefined) return trimmed;
  try {
    return new URL(trimmed, context.baseUrl).toString();
  } catch {
    return trimmed;
  }
};

/** Renders a table, padded to the widest row so the markdown is valid even when the HTML is ragged. */
const renderTable = (table: Extract<Node, { kind: "element" }>, context: Context): string => {
  const rows: string[][] = [];
  let headerRow: string[] | undefined;
  const walk = (node: Node): void => {
    if (!isElement(node)) return;
    if (node.tag === "tr") {
      const cells = node.children.filter(isElement).filter((cell) => cell.tag === "td" || cell.tag === "th");
      if (cells.length === 0) return;
      const rendered = cells.map((cell) => collapse(inline(cell.children, context)).replace(/\|/g, "\\|"));
      if (headerRow === undefined && cells.every((cell) => cell.tag === "th")) headerRow = rendered;
      else rows.push(rendered);
      return;
    }
    node.children.forEach(walk);
  };
  walk(table);
  if (headerRow === undefined && rows.length === 0) return "";
  const width = Math.max(headerRow?.length ?? 0, ...rows.map((row) => row.length), 1);
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill("")];
  // A table with no `th` still needs a header row, or the markdown is not a table.
  const header = headerRow ?? Array<string>(width).fill("");
  const lines = [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...rows.map((row) => `| ${pad(row).join(" | ")} |`),
  ];
  return lines.join("\n");
};

const renderList = (list: Extract<Node, { kind: "element" }>, context: Context, depth: number): string => {
  const ordered = list.tag === "ol";
  const start = Number.parseInt(list.attrs.start ?? "1", 10);
  const items = list.children.filter(isElement).filter((child) => child.tag === "li");
  return items
    .map((item, index) => {
      const marker = ordered ? `${(Number.isFinite(start) ? start : 1) + index}.` : "-";
      const indent = "  ".repeat(depth);
      // A nested list is rendered as its own block and indented under its parent item, rather than inlined.
      const nested = item.children.filter(isElement).filter((child) => child.tag === "ul" || child.tag === "ol");
      const own = item.children.filter((child) => !(isElement(child) && (child.tag === "ul" || child.tag === "ol")));
      const text = collapse(inline(own, context));
      const sublists = nested.map((child) => renderList(child, context, depth + 1)).filter((block) => block !== "");
      return [`${indent}${marker} ${text}`.trimEnd(), ...sublists].join("\n");
    })
    .filter((line) => line.trim() !== "-" && line.trim() !== "")
    .join("\n");
};

/** Renders block-level content into markdown blocks. */
const blocks = (nodes: readonly Node[], context: Context): string[] => {
  const out: string[] = [];
  let paragraph: Node[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const text = collapse(inline(paragraph, context));
    paragraph = [];
    if (text !== "") out.push(text);
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      paragraph.push(node);
      continue;
    }
    if (DISCARD.has(node.tag) || CHROME.has(node.tag)) continue;

    switch (node.tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        flush();
        const text = collapse(inline(node.children, context));
        if (text !== "") out.push(`${"#".repeat(Number(node.tag[1]))} ${text}`);
        break;
      }
      case "p": case "div": case "section": case "main": case "article": case "figcaption": case "dd": case "dt": {
        flush();
        // A wrapper `div` is transparent: its children are laid out as blocks in its place. Treating one as a
        // paragraph is how a whole page collapses into a single line.
        out.push(...blocks(node.children, context));
        break;
      }
      case "ul": case "ol": {
        flush();
        const list = renderList(node, context, 0);
        if (list !== "") out.push(list);
        break;
      }
      case "table": {
        flush();
        const table = renderTable(node, context);
        if (table !== "") out.push(table);
        break;
      }
      case "pre": {
        flush();
        const code = node.children.find((child) => isElement(child) && child.tag === "code");
        const language = code !== undefined && isElement(code) ? languageOf(code) : languageOf(node);
        // `textOf`, not `inline`: the contents of a code block are literal, and escaping them would corrupt it.
        const text = textOf(node).replace(/^\n+|\s+$/g, "");
        if (text !== "") out.push(`\`\`\`${language}\n${text}\n\`\`\``);
        break;
      }
      case "blockquote": {
        flush();
        const inner = blocks(node.children, context).join("\n\n");
        if (inner !== "") out.push(inner.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"));
        break;
      }
      case "hr": {
        flush();
        out.push("---");
        break;
      }
      case "br": {
        break;
      }
      default:
        paragraph.push(node);
    }
  }
  flush();
  return out;
};

export type Extraction = {
  readonly title: string;
  readonly markdown: string;
  /** From `<link rel="canonical">`, when the page states one. */
  readonly canonicalUrl?: string;
  /** From `<meta name="description">` or the OpenGraph equivalent. */
  readonly description?: string;
};

/**
 * The content subtree.
 *
 * `<article>` and `<main>` are believed when present, because a page that marks its content has told you where
 * it is and no heuristic beats being told. Failing that, the body with chrome removed — done by `blocks`,
 * which skips `CHROME` tags wherever they appear rather than only at the top level, since a `<nav>` nested
 * three divs deep is still navigation.
 */
export const contentRoot = (root: Node): Node => {
  const marked =
    findElement(root, (element) => element.tag === "article") ??
    findElement(root, (element) => element.tag === "main") ??
    findElement(root, (element) => element.attrs.role === "main") ??
    findElement(root, (element) => element.tag === "body");
  return marked ?? root;
};

export const htmlToMarkdown = (html: string, baseUrl?: string): Extraction => {
  const root = parseHtml(html);
  const context: Context = baseUrl === undefined ? {} : (() => {
    try {
      return { baseUrl: new URL(baseUrl) };
    } catch {
      return {};
    }
  })();

  const titleElement = findElement(root, (element) => element.tag === "title");
  const h1 = findElement(root, (element) => element.tag === "h1");
  const title = collapse(titleElement === undefined ? "" : textOf(titleElement)) || collapse(h1 === undefined ? "" : textOf(h1));

  const canonical = findElement(root, (element) => element.tag === "link" && (element.attrs.rel ?? "").toLowerCase() === "canonical");
  const description = findElement(
    root,
    (element) =>
      element.tag === "meta" &&
      ((element.attrs.name ?? "").toLowerCase() === "description" || (element.attrs.property ?? "").toLowerCase() === "og:description"),
  );

  const markdown = blocks(contentRoot(root).kind === "element" ? (contentRoot(root) as Extract<Node, { kind: "element" }>).children : [], context)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const canonicalHref = canonical === undefined ? "" : resolveUrl(canonical.attrs.href ?? "", context);
  const descriptionText = description === undefined ? "" : collapse(description.attrs.content ?? "");
  return {
    title,
    markdown,
    ...(canonicalHref === "" ? {} : { canonicalUrl: canonicalHref }),
    ...(descriptionText === "" ? {} : { description: descriptionText }),
  };
};

/** Every absolute link in a document, deduplicated — the input to a crawl's frontier. */
export const linksIn = (html: string, baseUrl: string): readonly string[] => {
  const root = parseHtml(html);
  const found = new Set<string>();
  const walk = (node: Node): void => {
    if (!isElement(node)) return;
    if (DISCARD.has(node.tag)) return;
    if (node.tag === "a") {
      const href = (node.attrs.href ?? "").trim();
      if (href !== "" && !href.startsWith("#") && !/^(javascript|mailto|tel|data):/i.test(href)) {
        try {
          const url = new URL(href, baseUrl);
          url.hash = "";
          if (url.protocol === "http:" || url.protocol === "https:") found.add(url.toString());
        } catch {
          // A malformed href on a page is normal and is not the crawl's problem.
        }
      }
    }
    node.children.forEach(walk);
  };
  walk(root);
  return [...found];
};
