/**
 * #653 — the panel preview drops a comment no slide understands, as the export does.
 * Production, 2026-09-30: `<!-- theme: dark-tech -->` showed on slide 1 as its eyebrow.
 */
import { describe, expect, it } from 'vitest';

import { parseSlides, splitSlides, unknownDirectives } from '../slides';

describe('unknown slide directives (#653)', () => {
  it('never reaches the slide', () => {
    const [first] = parseSlides('<!-- theme: dark-tech -->\n\n# Kaffee Nord Catering\n## Elevate your office coffee').slides;
    expect(first?.eyebrow).toBeUndefined();
    expect(first?.body).not.toContain('theme');
  });

  it('keeps known directives and code blocks', () => {
    const joined = splitSlides('# T\n<!-- eyebrow: Q3 -->\n---\n```html\n<!-- keep: me -->\n```').join('\n');
    expect(joined).toContain('<!-- eyebrow: Q3 -->');
    expect(joined).toContain('<!-- keep: me -->');
  });

  it('names what it dropped', () => {
    expect(unknownDirectives('<!-- theme: a -->\n# A\n<!-- font: b -->')).toEqual(['theme', 'font']);
  });
});
