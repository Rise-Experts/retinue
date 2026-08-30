/**
 * HTML to markdown, against three pages of different shapes — REQ-055 (#237), task #238, AC-7.
 *
 * The AC asks for three real saved pages rather than one fixture, and the reason is visible in what each of
 * these breaks:
 *
 * - **`docs.html`** is a documentation page: a `<main>`, a sidebar that is most of the words on the page, code
 *   blocks carrying `language-js`, a definition list, and a compatibility table.
 * - **`article.html`** is a news article: an `<article>`, a `<figure>`, a multi-paragraph `<blockquote>`, an
 *   ad `<iframe>`, and a related-links `<aside>` that reads exactly like content to anything that keeps it.
 * - **`reference.html`** is a wiki page: **no** `<article>` and **no** `<main>`, a table with no `<thead>`,
 *   an ordered list with a nested unordered one, and an entity (`&mdash;`) inside a cell.
 *
 * They are authored here rather than downloaded — saving live pages into a repository is a licensing problem
 * and makes the suite depend on someone else's CMS — but each is modelled structurally on the real thing,
 * including the parts that are awkward. A single tidy fixture would pass with a converter that handles none of
 * the above.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeEntities, htmlToMarkdown, linksIn, parseHtml, textOf } from "../html.js";

const page = (name: string): string =>
  readFileSync(new URL(`./pages/${name}.html`, import.meta.url), "utf8");

describe("a documentation page", () => {
  const result = htmlToMarkdown(page("docs"), "https://docs.example/en-US/docs/Web/JavaScript/Reference/flatMap");

  it("keeps the content and drops the chrome", () => {
    expect(result.title).toBe("Array.prototype.flatMap() - JavaScript | Docs");
    expect(result.markdown).toContain("# Array.prototype.flatMap()");
    expect(result.markdown).toContain("returns a new array formed by applying");

    // The sidebar is most of the words on a page like this, it is identical on every page of the site, and a
    // forty-page crawl that keeps it has fetched one page of content and thirty-nine copies of a menu.
    expect(result.markdown).not.toContain("reduce()");
    expect(result.markdown).not.toContain("© 2026 Docs contributors");
    // Script and style contents are not text, however much they look like it to a substitution.
    expect(result.markdown).not.toContain("__DATA__");
    expect(result.markdown).not.toContain("display:none");
    expect(result.markdown).not.toContain("Search");
  });

  it("keeps code blocks with their language", () => {
    expect(result.markdown).toContain("```js\nflatMap(callbackFn)\nflatMap(callbackFn, thisArg)\n```");
    // Inline code survives too, and is not escaped into oblivion.
    expect(result.markdown).toContain("`flatMap()`");
  });

  it("renders the table with its header and its links", () => {
    expect(result.markdown).toContain("| Browser | Version | Notes |");
    expect(result.markdown).toContain("| --- | --- | --- |");
    expect(result.markdown).toContain("| Chrome | 69 | Full support |");
    // A link inside a cell keeps its target, resolved against the page.
    expect(result.markdown).toContain("[bug 1234](https://docs.example/bugs/1234)");
  });

  it("indents a nested list under its parent item", () => {
    expect(result.markdown).toContain("- [Array.prototype.flat()](https://docs.example/en-US/docs/Web/JavaScript/Reference/flat)");
    expect(result.markdown).toMatch(/\n {2}- \[The depth argument]/);
  });

  it("reads the canonical URL and description the page declares", () => {
    expect(result.canonicalUrl).toBe("https://docs.example/en-US/docs/Web/JavaScript/Reference/flatMap");
    expect(result.description).toContain("returns a new array");
  });
});

describe("a news article", () => {
  const result = htmlToMarkdown(page("article"), "https://wire.example/news/harbour");

  it("prefers the article subtree and discards everything around it", () => {
    expect(result.markdown).toContain("# Harbour project clears final review");
    expect(result.markdown).toContain("ending a review that had taken **three years**");
    // `<article>` was marked, so the masthead, the ad iframe, the related aside and the footer are all outside
    // the content and go wholesale — including the one that reads most like content.
    expect(result.markdown).not.toContain("Ferry timetable");
    expect(result.markdown).not.toContain("Subscribe for");
    expect(result.markdown).not.toContain("ads.example");
    expect(result.markdown).not.toContain("NewsArticle");
  });

  it("keeps a multi-paragraph blockquote as a quote", () => {
    expect(result.markdown).toContain("> We have listened, and we have changed the design twice.");
    expect(result.markdown).toContain("> What we have now is something the whole city can use.");
  });

  it("keeps the image, its alt text and the caption", () => {
    expect(result.markdown).toContain("![The eastern quay at dawn](https://wire.example/images/harbour.jpg)");
    expect(result.markdown).toContain("The eastern quay, where the new terminal will stand.");
  });

  it("keeps an absolute link and drops a mailto", () => {
    expect(result.markdown).toContain("[published on the council's site](https://council.example/decisions/2026-08-31)");
    // A `mailto:` is not somewhere an agent can navigate; the label survives, the scheme does not.
    expect(result.markdown).toContain("the desk");
    expect(result.markdown).not.toContain("mailto:");
  });
});

describe("a wiki-style reference page", () => {
  const result = htmlToMarkdown(page("reference"), "https://ref.example/wiki/List_of_HTTP_status_codes");

  it("works with no <article> and no <main>", () => {
    // The hardest of the three: nothing marks the content, so the chrome has to be removed element by element.
    expect(result.markdown).toContain("# List of HTTP status codes");
    expect(result.markdown).toContain("Status codes are issued by a server");
    expect(result.markdown).not.toContain("Main page");
    expect(result.markdown).not.toContain("mw.loader");
  });

  it("renders a table with no thead, padding a ragged row", () => {
    expect(result.markdown).toContain("| Code | Reason phrase | Retryable |");
    expect(result.markdown).toContain("| 404 | Not Found | No |");
    // The last row has two cells where the others have three. Padded, or the markdown is not a table.
    expect(result.markdown).toContain("| 451 | Unavailable For Legal Reasons |  |");
    // An entity inside a cell is decoded, and inline code inside one survives.
    expect(result.markdown).toContain("Yes — honour `Retry-After`");
  });

  it("numbers an ordered list and nests the unordered one inside it", () => {
    expect(result.markdown).toContain("1. The 4xx class is intended");
    expect(result.markdown).toContain("2. Codes in the 5xx range");
    expect(result.markdown).toMatch(/\n {2}- 500 is the generic case\./);
  });
});

describe("the parser survives what real pages do wrong", () => {
  it("does not treat a comparison inside a script as markup", () => {
    // `if (a < b)` parses as a tag named `b` under any substitution-based approach, and everything after it
    // lands inside an element that never closes.
    const result = htmlToMarkdown("<body><script>if (a < b) { x(); }</script><p>after</p></body>");
    expect(result.markdown).toBe("after");
  });

  it("closes an unclosed paragraph and ignores a stray close tag", () => {
    const result = htmlToMarkdown("<body><p>one<p>two</div></body>");
    expect(result.markdown).toBe("one\n\ntwo");
  });

  it("decodes entities, including numeric ones", () => {
    expect(decodeEntities("a &amp; b &mdash; c &#8212; d &#x2014; e &nbsp;f")).toBe("a & b — c — d — e  f");
    // An unknown entity is left alone rather than mangled.
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });

  it("escapes markdown structure that appears in page text", () => {
    // Otherwise a page containing `# not a heading` forges structure in the output a model then reads.
    const result = htmlToMarkdown("<body><p>a * b _ c [d](e) | f</p></body>");
    expect(result.markdown).toContain("\\*");
    expect(result.markdown).toContain("\\_");
    expect(result.markdown).toContain("\\|");
  });

  it("reads text out of a tree without the discarded parts", () => {
    const tree = parseHtml("<div>keep<script>drop</script><span> this</span></div>");
    expect(textOf(tree)).toBe("keep this");
  });
});

describe("link extraction, which is the crawl frontier", () => {
  it("returns absolute http(s) links only, deduplicated and without fragments", () => {
    const links = linksIn(page("docs"), "https://docs.example/en-US/docs/Web/JavaScript/Reference/flatMap");
    expect(links).toContain("https://docs.example/en-US/docs/Web/JavaScript/Reference/flat");
    expect(links).toContain("https://docs.example/en-US/docs/Web/JavaScript/Reference/map");
    // `./flat` and `./flat#depth` are one page, and a crawl that treats them as two fetches it twice.
    expect(links.filter((link) => link.endsWith("/flat"))).toHaveLength(1);
    expect(links.every((link) => !link.includes("#"))).toBe(true);
    expect(links.every((link) => link.startsWith("https://"))).toBe(true);
  });

  it("drops mailto, tel, javascript and data links", () => {
    const links = linksIn(
      '<a href="mailto:a@b.c">m</a><a href="tel:123">t</a><a href="javascript:x()">j</a><a href="/ok">o</a>',
      "https://example.com/",
    );
    expect(links).toEqual(["https://example.com/ok"]);
  });
});
