/**
 * The markdown inside a slide, as the panel draws it — #666 (F17). The export renders the same text with
 * `slideMarkdownToHtml` (`shareflow/src/adapters/web/document.ts`), and the two must agree:
 *
 * - **Task lists and strikethrough** come from remark-gfm, and the export now prints both in the same markup.
 *   `singleTilde` is off: markdown-it strikes only `~~text~~`, so a lone `~` stays a tilde on both sides.
 * - **Raw HTML is stripped** (`skipHtml`), the issue's default decision — the export drops it too. Before, the
 *   panel showed a tag as escaped text and the PDF rendered it, so one slide had two looks.
 *
 * Held to the export by `__tests__/slideMarkdownParity.test.tsx`, which renders this component and compares it
 * with the shareflow renderer's expected HTML for one shared fixture.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Images outside an image slide print as their alt text; links open outside the app. */
const components: Components = {
  img: ({ alt }) => (alt ? <em>{alt}</em> : null),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function SlideMarkdown({ children }: { children: string }) {
  if (children.trim() === "") return null;
  return (
    <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={components} skipHtml>
      {children}
    </ReactMarkdown>
  );
}
