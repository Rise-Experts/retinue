/**
 * #666 (AR-20, F17): the panel renders a slide's markdown as the export does. The fixture is shareflow's —
 * `slide-markdown.test.ts` runs the same cases through the export's `slideMarkdownToHtml` — so each case
 * passing on both sides is the panel and the PDF producing the same HTML.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlideMarkdown } from '../slideMarkdown';
import {
  SLIDE_MARKDOWN_CASES,
  normaliseSlideHtml,
} from '../../../../../shareflow/src/adapters/web/__tests__/slide-markdown-fixture.ts';

describe('SlideMarkdown matches the export', () => {
  for (const c of SLIDE_MARKDOWN_CASES) {
    it(`renders ${c.name} as the export does`, () => {
      expect(normaliseSlideHtml(renderToStaticMarkup(<SlideMarkdown>{c.markdown}</SlideMarkdown>))).toBe(c.html);
    });
  }

  it('opens a link outside the app', () => {
    expect(renderToStaticMarkup(<SlideMarkdown>{'[site](https://example.com)'}</SlideMarkdown>)).toContain('target="_blank"');
  });
});
