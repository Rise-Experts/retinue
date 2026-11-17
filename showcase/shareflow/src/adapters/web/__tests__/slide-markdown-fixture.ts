/**
 * #666 (AR-20, F17): one fixture for the markdown inside a slide, rendered by both sides — the export's
 * `slideMarkdownToHtml` (`slide-markdown.test.ts`) and the panel's `SlideMarkdown`
 * (`web/src/lib/assistant/__tests__/slideMarkdownParity.test.tsx`, which imports this file by path).
 *
 * Each case holds the HTML both must produce once `normaliseSlideHtml` has removed what differs only in
 * serialisation: line breaks and whitespace around tags, `<br />` against `<br/>`, the panel's `target`/`rel` on a link.
 * Pure TypeScript with no imports, so the web suite can load it without shareflow's node_modules.
 */

export interface SlideMarkdownCase {
  readonly name: string;
  readonly markdown: string;
  readonly html: string;
}

const CHECKED = '<input type="checkbox" disabled="" checked="">';
const UNCHECKED = '<input type="checkbox" disabled="">';

export const SLIDE_MARKDOWN_CASES: readonly SlideMarkdownCase[] = [
  {
    name: "a task list",
    markdown: "- [x] Brief signed off\n- [ ] Assets delivered",
    html: `<ul class="contains-task-list"><li class="task-list-item">${CHECKED} Brief signed off</li><li class="task-list-item">${UNCHECKED} Assets delivered</li></ul>`,
  },
  {
    name: "a loose task list",
    markdown: "- [x] One\n\n- [ ] Two",
    html: `<ul class="contains-task-list"><li class="task-list-item"><p>${CHECKED} One</p></li><li class="task-list-item"><p>${UNCHECKED} Two</p></li></ul>`,
  },
  {
    name: "an ordered list mixing a task and a plain item",
    markdown: "1. [X] Shipped\n2. Next",
    html: `<ol class="contains-task-list"><li class="task-list-item">${CHECKED} Shipped</li><li>Next</li></ol>`,
  },
  {
    name: "a nested task list",
    markdown: "- Launch\n  - [x] Press kit",
    html: `<ul><li>Launch<ul class="contains-task-list"><li class="task-list-item">${CHECKED} Press kit</li></ul></li></ul>`,
  },
  { name: "a bare marker is not a task", markdown: "- [x]", html: "<ul><li>[x]</li></ul>" },
  { name: "strikethrough", markdown: "~~$49~~ now $29", html: "<p><del>$49</del> now $29</p>" },
  { name: "a single tilde is not strikethrough", markdown: "~approx~ 40%", html: "<p>~approx~ 40%</p>" },
  { name: "inline HTML is stripped, its text kept", markdown: "<b>Bold</b> claim", html: "<p>Bold claim</p>" },
  {
    name: "an HTML block is stripped",
    markdown: '<div style="color:red">Styled</div>\n\nAfter',
    html: "<p>After</p>",
  },
  { name: "an HTML comment is stripped", markdown: "<!-- note -->", html: "" },
  {
    name: "a bare www link",
    markdown: "See www.example.com",
    html: '<p>See <a href="http://www.example.com">www.example.com</a></p>',
  },
  { name: "a hard break", markdown: "Line one  \nLine two", html: "<p>Line one<br>Line two</p>" },
  {
    name: "a table",
    markdown: "| Plan | Price |\n|---|---|\n| Team | $29 |",
    html: "<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Team</td><td>$29</td></tr></tbody></table>",
  },
];

/** A deck with every feature on a slide, for the export's end-to-end check. */
export const SLIDE_MARKDOWN_DECK = [
  "# Launch checklist",
  "",
  ...SLIDE_MARKDOWN_CASES.flatMap((c) => ["---", "", `## ${c.name}`, "", c.markdown, ""]),
].join("\n");

/** Serialisation only — never content: what is left must be the same HTML on both sides. */
export const normaliseSlideHtml = (html: string): string =>
  html
    .replace(/\s+target="_blank"/g, "")
    .replace(/\s+rel="[^"]*"/g, "")
    .replace(/\s*\/>/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/>\s+</g, "><")
    .replace(/\s*\n\s*(?=<)/g, "")
    .replace(/>\s*\n\s*/g, ">")
    .trim();
