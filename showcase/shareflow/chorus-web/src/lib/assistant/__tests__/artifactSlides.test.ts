/**
 * #607: the panel's copies of the agent service's slide parsing and theme resolution, diffed against the
 * originals over one matrix. Ported code whose tests were written by the porter passes by construction;
 * running both implementations on the same inputs is the check that can fail.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as agentSlides from '../../../../../shareflow/src/adapters/web/slides.ts';
import * as agentDesign from '../../../../../shareflow/src/adapters/web/slide-design.ts';
import { isDark, resolveTheme, slideGroundVars as agentGroundVars, themeCss, projectTheme, withDeckStyle } from '../../../../../shareflow/src/design/theme.ts';
import * as panelSlides from '../slides';
import { inferLayout, parseSlides, slideParts, splitSlides, statRing, SLIDE_FORMATS, SLIDE_LAYOUTS } from '../slides';
import { SLIDE_DESIGN_CSS, SLIDE_TRANSITION_EASING, SLIDE_TRANSITION_KEYFRAMES, SLIDE_TRANSITION_MS, transitionFrames } from '../slideDesign';
import { DEFAULT_THEME_VARS, isDarkThemeVars, logoPlacementFor, projectThemeVars, slideGroundVars, themeVarsFor, withDeckStyleVars, type ThemeOverlay } from '../artifactTheme';
import { ARTIFACT_KINDS, artifactFilename, isArtifactKind } from '../artifactRef';

const CHUNKS = [
  '# Title only',
  '# Title\nWith a subtitle',
  '# Title\n- a bullet',
  '# 87%',
  '## Growth\n87%\nyear on year',
  '**$1.2m**',
  '10,000+\nsign-ups',
  '## Two\n87%\n12%',
  '- 87% of teams\n- 12%',
  '> A quote',
  '> A quote\n— Someone',
  '## Said\n> one\n> two\n-- Someone',
  '> A quote\nand a paragraph\nand another',
  '![Team](chorus-media:ws/a.png)',
  '## Office\n![Office](chorus-media:ws/o.jpg)\nBerlin',
  '![Chart](https://example.test/c.png)',
  '![Local](./c.png)',
  '<!-- layout: stat -->\n## H\n- a',
  '<!--layout:CTA-->\n## Go',
  '<!-- layout: hero -->\n# T',
  '```js\nconst a = 1;\n```',
  // #615: pictures beside text, backgrounds and credits.
  '## Beans\n![Beans](chorus-media:ws/b.jpg)\n- Arabica\n- Robusta',
  '## Beans\n- Arabica\n![Beans](chorus-media:ws/b.jpg)',
  '<!-- layout: image-left -->\n## Roast\n![Roast](chorus-media:ws/r.jpg)\nDark',
  '<!-- layout: image-right -->\n## No picture',
  '## Two\n![a](chorus-media:ws/a.jpg)\n![b](chorus-media:ws/b.jpg)',
  '> Quote\n![a](chorus-media:ws/a.jpg)',
  '<!-- background: chorus-media:ws/bg.jpg -->\n# Coffee',
  '<!-- background: chorus-media:ws/bg.jpg -->',
  '<!-- credit: Photo by Ana on Pexels -->\n![a](chorus-media:ws/a.jpg)',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  'Just a paragraph',
  '',
  // #620: the new layouts, the eyebrow, and the near misses each rule has to leave alone.
  '## Section two',
  '## 02 Results\nWhat we measured',
  '# Part 2: Growth',
  '# 3 tips for better posts',
  '## Agenda\n- Intro\n- Results\n- Next',
  '## Today\n1. Where we started\n2. What changed',
  '## Today we launched\n- a new plan\n- a new price',
  '## Roadmap\n- **Q1** — Pilot\n- **Q2** — Roll out\n- **Q3** — Automate',
  '- 2024: Founded\n- 2025: Series A\n- 2026: 100 staff',
  '## How\n- Step 1 Plan\n- Step 2 Build\n- Step 3 Ship',
  '- Market research\n- Decide quickly\n- September plan',
  '## The numbers\n- 3x faster\n- 45% fewer incidents\n- $1.2m saved',
  '87%\nretention\n3x\nfaster',
  '- 3x faster\n- 50% cheaper\n- Round the clock',
  '## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats',
  '### Before\n- slow\n### After\n- fast',
  '## Us vs them\n### Chorus\n- one tool\n### Others\n- five tools',
  '## Pricing\n### Basic\n- $9 / month\n### Team\n- $29 / month\n### Premium\n- $99 / month',
  '### A\n- a\n### B\n- b\n### C\n- c\n### D\n- d',
  '### A\n- a\n### B\n- b\n### C\n- c\n### D\n- d\n### E\n- e',
  '<!-- layout: columns -->\n## Steps\n- a\n- b\n- c\n- d',
  '<!-- layout: columns -->\n## Plans\n### Starter\n- 3 seats\n### Team\n- 20 seats',
  '## Team\n![A](chorus-media:ws/a.jpg)\nAna — CEO\n![B](chorus-media:ws/b.jpg)\nBo — CTO',
  '## Trusted by\n![A](chorus-media:ws/a.svg)\n![B](chorus-media:ws/b.svg)\n![C](chorus-media:ws/c.svg)',
  '> It works.\n— Dana, CTO\n![Dana](chorus-media:ws/d.jpg)',
  '## Ready?\nStart today\n[Book a demo](https://example.com/demo)',
  '## Follow along\n@chorus.app',
  '## Try it next sprint\n**Start with one team**',
  '## Heading\nOne sentence of context.',
  'Field report · 2026\n# Why we ship',
  '<!-- eyebrow: Quick wins -->\n## What changed\n- a',
  'A whole sentence that ends here.\n## Heading\n- a',
  '87%\n## of teams',
  '<!-- layout: timeline -->\n## Plan\n- a\n- b',
  '<!-- layout: two-column -->\n## Plan\n- a\n- b\n- c',
  '<!-- layout: stat-grid -->\n## Plan\n- a\n- b',
  '<!-- layout: cta -->\n## Go\nhttps://example.com',
  '<!-- layout: section -->\n## 3. Next\nsoon',
];

const DECKS = [
  '<!-- format: 16:9 -->\n---\n# A\n---\nB',
  '## Config\n```yaml\na: 1\n---\nb: 2\n```\n---\n# Next',
  '# A\r\n  ---  \r\n# B',
  CHUNKS.join('\n---\n'),
  '<!-- format: 4:5 -->\n# Deck\n---\n## Point\n- one\n- two\n---\n42%\n---\n> Q\n— A\n---\n![x](chorus-media:ws/x.png)\ncaption',
  '<!-- background: chorus-media:ws/bg.jpg -->\n<!-- credit: Photo by Ana on Pexels -->\n# Coffee\n---\n<!-- background: https://images.pexels.com/p.jpg -->\n---\n<!-- background: javascript:alert(1) -->\n## Bad\n---\n<!-- layout: image-left -->\n## Roast\n![Roast](chorus-media:ws/r.jpg)\n- Dark',
  // #620: deck and slide transitions.
  '<!-- transition: zoom -->\n---\n# A\n---\n<!-- transition: slide -->\n## B\n- b\n---\n<!-- transition: warp -->\n## C',
  '<!-- transition: none -->\n# A\n---\n## B',
  // #663: deck style directives, valid and not, and a directive shown in a code block.
  '<!-- palette: #0B1020, #f5f5f5 #f53 -->\n<!-- heading-font: bebas neue -->\n<!-- body-font: Montserrat -->\n<!-- mode: Dark -->\n# A\n---\n<!-- bg-color: #FFEEDD -->\n## B\n- b\n---\n<!-- bg-color: red -->\n## C',
  '## How\n```md\n<!-- mode: dark -->\n```\n---\n<!-- palette: accent #ff5a36, bg:#0b1020 -->\n# A',
  '<!-- mode: light -->\n<!-- palette: navy -->\n<!-- heading-font: "JetBrains Mono" -->\n# A',
];

describe('slide parsing matches the agent service', () => {
  it.each(CHUNKS)('infers the same layout for %j', (chunk) => {
    expect(inferLayout(chunk)).toEqual(agentSlides.inferLayout(chunk));
  });

  it.each(DECKS)('splits and parses %j the same way', (deck) => {
    expect(splitSlides(deck)).toEqual(agentSlides.splitSlides(deck));
    expect(parseSlides(deck)).toEqual(agentSlides.parseSlides(deck));
  });

  it('has the same layouts and formats', () => {
    expect([...SLIDE_LAYOUTS]).toEqual([...agentSlides.SLIDE_LAYOUTS]);
    expect(SLIDE_FORMATS).toEqual(agentSlides.SLIDE_FORMATS);
  });

  it.each(['87%', '12.5%', '100%', '140%', '$1.2m', '3x', '0%', '~50%', ''])('draws the same stat graphic for %j', (figure) => {
    expect(statRing(figure)).toEqual(agentSlides.statRing(figure));
  });

  it.each([...CHUNKS, ...DECKS])('splits every slide of %j into the parts the print page draws', (source) => {
    const panel = parseSlides(source).slides;
    const agent = agentSlides.parseSlides(source).slides;
    expect(panel.map(slideParts)).toEqual(agent.map(agentSlides.slideParts));
    // The same big number and the same classes on the slide's root, in both themes and both formats.
    for (const [i, slide] of panel.entries()) {
      const parts = slideParts(slide);
      expect(panelSlides.slideIndexText(slide, parts)).toBe(agentSlides.slideIndexText(agent[i]!, parts));
      expect(panelSlides.hidesIndex(slide.layout)).toBe(agentSlides.hidesIndex(slide.layout));
      expect(panelSlides.hasDeco(slide.layout)).toBe(agentSlides.hasDeco(slide.layout));
      for (const look of [{ format: '16:9' as const, dark: true, background: true, logo: 'top-right' }, { format: '4:5' as const, dark: false, background: false }]) {
        expect(panelSlides.slideClasses(slide, look)).toEqual(agentSlides.slideClasses(agent[i]!, look));
      }
    }
  });

  it.each(DECKS)('gives every slide of %j the same transition', (source) => {
    const panel = parseSlides(source);
    const agent = agentSlides.parseSlides(source);
    expect(panel.slides.map((s) => panelSlides.slideTransition(panel, s))).toEqual(agent.slides.map((s) => agentSlides.slideTransition(agent, s)));
  });

  it.each(['87%', '$1.2m', '10,000+', '3.5x', '€2,5', '1.234.567', '~50%', '', 'none'])('counts %j up the same way', (figure) => {
    for (const progress of [0, 0.25, 0.5, 0.9, 1]) expect(panelSlides.countUpText(figure, progress)).toBe(agentSlides.countUpText(figure, progress));
  });
});

describe('the slide design matches the export', () => {
  it('is the same stylesheet, character for character', () => {
    expect(SLIDE_DESIGN_CSS).toBe(agentDesign.SLIDE_DESIGN_CSS);
  });

  it('plays the same transitions', () => {
    expect(SLIDE_TRANSITION_KEYFRAMES).toEqual(agentDesign.SLIDE_TRANSITION_KEYFRAMES);
    expect(SLIDE_TRANSITION_MS).toBe(agentDesign.SLIDE_TRANSITION_MS);
    expect(SLIDE_TRANSITION_EASING).toBe(agentDesign.SLIDE_TRANSITION_EASING);
  });

  it('mirrors a slide going back, and leaves the rest as they are', () => {
    expect(transitionFrames('slide', -1).in).toEqual([{ transform: 'translateX(-100%)' }, { transform: 'translateX(-0%)' }]);
    expect(transitionFrames('slide', -1).out[1]).toEqual({ transform: 'translateX(28%)', opacity: 0.3 });
    expect(transitionFrames('fade', -1)).toEqual(SLIDE_TRANSITION_KEYFRAMES.fade);
    expect(transitionFrames('zoom', 1)).toBe(SLIDE_TRANSITION_KEYFRAMES.zoom);
  });

  it('splits a picture-beside-text slide the way the print page does', () => {
    const deck = parseSlides('<!-- layout: image-left -->\n## Roast\n![Roast](chorus-media:ws/r.jpg)\n- Dark');
    expect(slideParts(deck.slides[0]!)).toEqual({ before: '## Roast', image: { alt: 'Roast', src: 'chorus-media:ws/r.jpg' }, after: '- Dark' });
  });

  it('splits a slide into the parts the print page draws', () => {
    const deck = parseSlides('## Growth\n87%\nyear on year\n---\n> Q\n— Dana\n---\n## Office\n![Office](chorus-media:ws/o.jpg)\nBerlin');
    expect(deck.slides.map(slideParts)).toEqual([
      { before: '## Growth', figure: '87%', after: 'year on year' },
      { before: '> Q', attribution: '— Dana', after: '' },
      { before: '## Office', image: { alt: 'Office', src: 'chorus-media:ws/o.jpg' }, after: 'Berlin' },
    ]);
  });
});

/** themeCss's `:root{…}` as the style object the panel sets. */
const varsOf = (css: string) =>
  Object.fromEntries(
    css
      .replace(/^:root\{|\}$/g, '')
      .split(';')
      .filter(Boolean)
      .map((decl) => [decl.slice(0, decl.indexOf(':')), decl.slice(decl.indexOf(':') + 1)]),
  );

const DESIGNS: unknown[] = [
  undefined,
  null,
  {},
  { themeId: 'editorial' },
  { themeId: 'dark-tech', palette: { primary: '#FFF', text: '#0b1020' } },
  { themeId: 'neon', colors: ['#234B7E', '#ffba00'] },
  { colors: ['#112233'], fonts: 'Headings in Roboto Slab, body in Roboto' },
  { headingFont: 'eb garamond', bodyFont: 'Comic Sans', radius: 12.4 },
  { radius: 49, palette: { background: '#000000' } },
  { imageStyle: 'warm light only' },
  { picture: { style: 'photo' } },
  { colors: [] },
  { logoPlacement: 'none' },
  { themeId: 'bold', logoPlacement: 'bottom-left' },
  { logoPlacement: 'middle' },
  'garbage',
];

describe('the panel theme matches the PDF theme', () => {
  it.each(DESIGNS)('resolves %j to the same variables', (design) => {
    expect(themeVarsFor(design)).toEqual(varsOf(themeCss(resolveTheme(design as never))));
  });

  it.each(DESIGNS)('themes %j exactly when the PDF would', (design) => {
    const agent = projectTheme((typeof design === 'object' ? design : undefined) as never);
    const panel = projectThemeVars(design);
    expect(panel).toEqual(agent === undefined ? null : varsOf(themeCss(agent)));
  });

  it.each(DESIGNS)('reads %j as dark exactly when the export does', (design) => {
    expect(isDarkThemeVars(themeVarsFor(design))).toBe(isDark(resolveTheme(design as never).palette.background));
  });

  it.each(DESIGNS)('puts the logo in the same corner for %j', (design) => {
    expect(logoPlacementFor(design)).toBe(resolveTheme(design as never).logoPlacement);
  });

  // #663: a deck's own style over every design — the panel's overlay against the export's.
  const OVERLAYS: ThemeOverlay[] = [
    { mode: 'dark' },
    { mode: 'light' },
    { background: '#fdf6e3', mode: 'dark' },
    { background: '#0b1020', text: '#f5f5f5', accent: '#ff5a36' },
    { background: '#000000', text: '#111111' },
    { text: '#336699' },
    { accent: '#00ff00', headingFont: 'Bebas Neue', bodyFont: 'EB Garamond' },
  ];

  it.each(DESIGNS)('lays every deck style over %j as the export does', (design) => {
    for (const overlay of OVERLAYS) {
      expect(withDeckStyleVars(themeVarsFor(design), overlay)).toEqual(varsOf(themeCss(withDeckStyle(resolveTheme(design as never), overlay))));
    }
    expect(withDeckStyleVars(themeVarsFor(design), undefined)).toEqual(themeVarsFor(design));
  });

  it.each(DESIGNS)('colours a slide with its own bg-color over %j as the export does', (design) => {
    for (const background of ['#ffffff', '#0b1020', '#ff5a36', '#777777']) {
      expect(slideGroundVars(themeVarsFor(design), background)).toEqual(agentGroundVars(resolveTheme(design as never), background));
    }
  });

  it('dresses an unthemed deck in the default preset, as the export does', () => {
    expect(DEFAULT_THEME_VARS).toEqual(varsOf(themeCss(resolveTheme(undefined))));
  });
});

describe('the slides kind', () => {
  it('is an artifact kind the app accepts, downloaded as markdown', () => {
    expect(ARTIFACT_KINDS).toContain('slides');
    expect(isArtifactKind('slides')).toBe(true);
    expect(artifactFilename('Q3 deck', 'slides')).toBe('Q3-deck.md');
  });

  it('matches the agent service and the database constraint', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const port = readFileSync(join(here, '../../../../../shareflow/src/services/index.ts'), 'utf8');
    const kinds = /export const ARTIFACT_KINDS = \[([^\]]*)\]/.exec(port)?.[1] ?? '';
    expect([...kinds.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...ARTIFACT_KINDS]);

    // The newest migration that sets the constraint is the one in force; it must admit every kind, additively.
    const dir = join(here, '../../../../../supabase/migrations');
    const setting = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .filter((name) => /assistant_artifacts_kind_check|kind text not null check \(kind in/.test(readFileSync(join(dir, name), 'utf8')));
    const latest = readFileSync(join(dir, setting[setting.length - 1] ?? ''), 'utf8');
    expect(setting[setting.length - 1]).toBe('20260929090000_artifact_react_svg_kinds.sql');
    expect(latest).toContain("check (kind in ('markdown', 'html', 'mermaid', 'slides', 'react', 'svg'))");
    expect(latest).toMatch(/drop constraint if exists assistant_artifacts_kind_check/);
    // No row is touched — this project has no backups.
    expect(latest).not.toMatch(/^\s*(update|delete|truncate|insert)\b/im);
  });
});
