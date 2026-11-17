/**
 * The `svg` artifact kind's sanitizer — #607 part 3.
 *
 * An SVG artifact is model-written markup. The panel draws it through an `<img src="data:image/svg+xml,…">`,
 * where a browser runs no script and loads no external resource — but the same text is also inlined into a
 * page Chromium renders to a PNG, downloaded and opened by a person, and read back by the model. So it is
 * made inert once, here, before it is stored, rather than trusted to every place it goes.
 *
 * **Rebuilt, not filtered.** The input is tokenised into elements, attributes and text, checked for
 * well-formedness, and written out again from what survived — a regex that deletes `<script>` from a string
 * is defeated by `<scr<script>ipt>`; a serializer that only ever writes names it parsed is not.
 *
 * What is removed:
 * - `<script>`, `<foreignObject>` (it hosts arbitrary HTML), `<iframe>`, `<object>`, `<embed>`, `<audio>`,
 *   `<video>`, `<set>`, and an `<animate>` that targets an `href` — with everything inside them
 * - every `on*` event attribute
 * - `href` / `xlink:href` / `src` unless it is a fragment (`#id`, for `<use>` and gradients) or a `data:image/`
 *   URL; every other `url(…)` in a `style` attribute or a `<style>` element, and `@import`
 * - comments, processing instructions and the DOCTYPE; one with an internal subset (entity declarations —
 *   the billion-laughs shape) is refused rather than stripped
 *
 * What is refused: anything that does not parse as exactly one `<svg>` root element.
 *
 * Pure and dependency-free, so the rules are testable (`__tests__/svg.test.ts`).
 */

export type SanitizedSvg = {
  /** The rebuilt SVG, with `xmlns` added when the model left it out (an `<img>` will not draw one without it). */
  readonly svg: string;
  /** What was taken out, for a note back to the model: `"<script>"`, `"onclick"`, `"href=https://…"`. */
  readonly removed: readonly string[];
};

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgError";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Dropped with their whole subtree. Lower-cased; SVG names are case-sensitive but `foreignObject` is not safer capitalised differently. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video", "set", "handler", "listener"]);

const LINK_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "xlink:href", "src"]);

const NAME = /^[A-Za-z_][\w.:-]*$/;

type Attr = { readonly name: string; readonly value: string };
type Node =
  | { readonly type: "element"; readonly name: string; readonly attrs: Attr[]; readonly children: Node[] }
  | { readonly type: "text"; readonly text: string };

/** The five XML entities plus numeric references — enough to see through `&#106;avascript:`. */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const escapeAttr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A link that stays inside the image: a fragment, or an inlined raster/vector image. */
const safeLink = (raw: string): boolean => {
  // Control characters and whitespace are stripped the way a URL parser would, so `java\tscript:` is seen whole.
  const value = decodeEntities(raw).replace(/[\u0000- \u007f]/g, "").toLowerCase();
  return value.startsWith("#") || value.startsWith("data:image/");
};

/** CSS with every external `url(…)` and `@import` neutralised. Fragment and `data:image/` urls are kept. */
const safeCss = (css: string, removed: string[]): string =>
  css
    .replace(/@import[^;]*;?/gi, () => {
      removed.push("@import");
      return "";
    })
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _q: string, target: string) => {
      if (safeLink(target)) return whole;
      removed.push(`url(${target.slice(0, 60)})`);
      return "none";
    })
    // An `expression(` or a `javascript:` anywhere in CSS is never needed by a drawing.
    .replace(/expression\s*\(|javascript\s*:/gi, (m) => {
      removed.push(m.trim());
      return "";
    });

const parseAttrs = (source: string, tag: string): Attr[] => {
  const attrs: Attr[] = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1] ?? "";
    if (!NAME.test(name)) throw new SvgError(`<${tag}> has an attribute that is not well-formed: ${JSON.stringify(name.slice(0, 40))}.`);
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    // A bare `<` in a value is not XML; the serializer would escape it, but it means the markup is broken.
    if (value.includes("<")) throw new SvgError(`<${tag} ${name}> contains a "<", which is not allowed in an attribute value.`);
    attrs.push({ name, value });
  }
  return attrs;
};

/** Tokenise and build the tree. Throws `SvgError` for anything that is not well-formed markup. */
const parse = (input: string): Node[] => {
  const root: Node[] = [];
  const stack: { name: string; children: Node[] }[] = [];
  const children = (): Node[] => stack[stack.length - 1]?.children ?? root;
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      children().push({ type: "text", text: input.slice(i) });
      break;
    }
    if (lt > i) children().push({ type: "text", text: input.slice(i, lt) });
    const rest = input.slice(lt, lt + 9);
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw new SvgError("A comment is never closed.");
      i = end + 3;
      continue;
    }
    if (rest.startsWith("<![CDATA[")) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw new SvgError("A CDATA section is never closed.");
      // Kept as text; the serializer escapes it, so it can never close a tag.
      children().push({ type: "text", text: escapeText(input.slice(lt + 9, end)) });
      i = end + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end === -1) throw new SvgError("A processing instruction is never closed.");
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt + 2);
      if (end === -1) throw new SvgError("A declaration is never closed.");
      const decl = input.slice(lt, end + 1);
      if (/^<!doctype/i.test(decl) && !decl.includes("[")) {
        i = end + 1;
        continue;
      }
      throw new SvgError("Entity and DOCTYPE declarations with an internal subset are not allowed in an SVG artifact.");
    }
    // A tag. Find its end outside quoted attribute values.
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < input.length; j++) {
      const c = input[j];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      else if (c === "<") throw new SvgError(`A tag starting at character ${lt} is not closed before the next "<".`);
    }
    if (j >= input.length) throw new SvgError("A tag is never closed.");
    const body = input.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new SvgError(open === undefined ? `</${name}> closes nothing.` : `</${name}> closes <${open.name}> — the markup is not well-formed.`);
      }
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    const name = nameMatch?.[1] ?? "";
    if (!NAME.test(name)) throw new SvgError(`<${name.slice(0, 40)}> is not a well-formed element name.`);
    const node: Node = { type: "element", name, attrs: parseAttrs(inner.slice(name.length), name), children: [] };
    children().push(node);
    if (!selfClosing) stack.push({ name, children: node.children });
  }
  if (stack.length > 0) throw new SvgError(`<${stack[stack.length - 1]?.name}> is never closed.`);
  return root;
};

const serialize = (node: Node, removed: string[], inStyle: boolean): string => {
  if (node.type === "text") {
    // Raw text is re-escaped, except entity references it already carried (`&amp;` stays `&amp;`).
    const text = node.text.replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/>/g, "&gt;");
    return inStyle ? safeCss(text, removed) : text;
  }
  const lower = node.name.toLowerCase();
  const local = lower.includes(":") ? lower.slice(lower.indexOf(":") + 1) : lower;
  if (DROPPED_ELEMENTS.has(local)) {
    removed.push(`<${node.name}>`);
    return "";
  }
  if ((local === "animate" || local === "animatetransform" || local === "animatemotion") && node.attrs.some((a) => a.name.toLowerCase() === "attributename" && /href/i.test(a.value))) {
    removed.push(`<${node.name} attributeName=href>`);
    return "";
  }
  const attrs: string[] = [];
  for (const attr of node.attrs) {
    const attrName = attr.name.toLowerCase();
    if (attrName.startsWith("on")) {
      removed.push(attr.name);
      continue;
    }
    if (LINK_ATTRIBUTES.has(attrName) && !safeLink(attr.value)) {
      removed.push(`${attr.name}=${attr.value.slice(0, 60)}`);
      continue;
    }
    const decoded = decodeEntities(attr.value);
    const value = attrName === "style" ? safeCss(decoded, removed) : decoded;
    // Any attribute that could carry a URL gets the same check a style does — `fill="url(https://…)"`.
    const checked = attrName !== "style" && /url\(/i.test(value) ? safeCss(value, removed) : value;
    attrs.push(` ${attr.name}="${escapeAttr(checked)}"`);
  }
  const open = `<${node.name}${attrs.join("")}`;
  const inner = node.children.map((child) => serialize(child, removed, local === "style")).join("");
  return inner === "" ? `${open}/>` : `${open}>${inner}</${node.name}>`;
};

/**
 * Parse, check and rebuild an SVG. Throws `SvgError` with a sentence a model can act on when the input is not
 * exactly one well-formed `<svg>` element.
 */
export const sanitizeSvg = (input: string): SanitizedSvg => {
  const nodes = parse(input.replace(/^﻿/, ""));
  const elements = nodes.filter((n): n is Extract<Node, { type: "element" }> => n.type === "element");
  const strayText = nodes.some((n) => n.type === "text" && n.text.trim() !== "");
  if (elements.length !== 1 || strayText) {
    throw new SvgError(
      elements.length === 0
        ? "An SVG artifact must be one <svg>…</svg> element; none was found."
        : strayText
          ? "An SVG artifact must be only one <svg>…</svg> element, with nothing around it."
          : `An SVG artifact must have exactly one root element; this has ${elements.length}.`,
    );
  }
  const root = elements[0] as Extract<Node, { type: "element" }>;
  if (root.name !== "svg") throw new SvgError(`The root element must be <svg>, not <${root.name}>.`);

  const removed: string[] = [];
  const attrs = [...root.attrs];
  if (!attrs.some((a) => a.name === "xmlns")) attrs.unshift({ name: "xmlns", value: SVG_NS });
  const usesXlink = (n: Node): boolean => n.type === "element" && (n.attrs.some((a) => a.name.startsWith("xlink:")) || n.children.some(usesXlink));
  if (usesXlink(root) && !attrs.some((a) => a.name === "xmlns:xlink")) attrs.push({ name: "xmlns:xlink", value: XLINK_NS });
  const svg = serialize({ ...root, attrs }, removed, false);
  return { svg, removed };
};

