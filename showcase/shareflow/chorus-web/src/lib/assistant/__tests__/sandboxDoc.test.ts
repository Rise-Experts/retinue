/** The sandboxed preview document for html and react artifacts — #607 part 3. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REACT_RUNTIME, SANDBOX, SANDBOX_CSP, TAILWIND_RUNTIME, buildSandboxDoc, svgDataUrl, themeRootCss } from '../sandboxDoc';
import { themeVarsFor } from '../artifactTheme';

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;

describe('the sandbox', () => {
  it('allows scripts and never the same origin', () => {
    expect(SANDBOX).toBe('allow-scripts');
    expect(SANDBOX).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  });

  it('is what every artifact iframe uses — no sandbox attribute anywhere adds allow-same-origin', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['ArtifactPanel.tsx']) {
      const source = readFileSync(join(here, '../../../app/(dashboard)/assistant', file), 'utf8');
      expect(source, file).not.toMatch(/allow-same-origin"|allow-same-origin'|sandbox="[^"]*allow-same-origin/);
      expect(source, file).toContain('sandbox={SANDBOX}');
    }
  });

  it('carries the strict policy', () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net",
      "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
      'font-src https://fonts.gstatic.com',
      'img-src data: blob: https:',
      "connect-src 'none'",
      "frame-src 'none'",
    ]) {
      expect(SANDBOX_CSP).toContain(directive);
    }
    expect(SANDBOX_CSP).not.toMatch(/unsafe-eval/);
  });
});

describe('buildSandboxDoc — html', () => {
  it('puts the policy before any of the content, whatever shape the content has', () => {
    for (const content of ['<p>hi</p>', '<!doctype html><html><head><script>x()</script></head><body></body></html>', '<script>first()</script><html>']) {
      const doc = buildSandboxDoc({ kind: 'html', content });
      expect(doc.startsWith('<!doctype html>' + CSP_META)).toBe(true);
      expect(doc.indexOf(CSP_META)).toBeLessThan(doc.indexOf(content));
      expect(doc.endsWith(content)).toBe(true);
    }
  });

  it('declares the project theme as --t-* variables, and nothing outside a theme', () => {
    const themed = buildSandboxDoc({ kind: 'html', content: '<p/>', theme: themeVarsFor({ themeId: 'bold' }) });
    expect(themed).toMatch(/<style>:root\{--t-bg:#ffffff;.*--t-primary:#dc2626/);
    expect(buildSandboxDoc({ kind: 'html', content: '<p/>' })).not.toContain('<style>');
  });

  it('drops a theme value that could break out of the rule', () => {
    expect(themeRootCss({ '--t-bg': 'red}</style><script>x()</script>', '--t-text': '#111111' })).toBe(':root{--t-text:#111111}');
  });
});

describe('buildSandboxDoc — react', () => {
  const COMPONENT = "import { useState } from 'react';\nexport default function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }";

  it('loads pinned React, ReactDOM and Babel from cdnjs with integrity, after the policy', () => {
    const doc = buildSandboxDoc({ kind: 'react', content: COMPONENT });
    expect(doc.startsWith('<!doctype html>' + CSP_META)).toBe(true);
    for (const s of REACT_RUNTIME) {
      expect(s.src).toMatch(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[a-z-]+\/\d+\.\d+\.\d+\//);
      expect(doc).toContain(`<script src="${s.src}" integrity="${s.integrity}" crossorigin="anonymous"></script>`);
      expect(doc.indexOf(s.src)).toBeGreaterThan(doc.indexOf(CSP_META));
    }
    expect(REACT_RUNTIME.map((s) => s.src).join(' ')).toMatch(/react\/18\..*react-dom\/18\..*babel-standalone/);
  });

  it('adds Tailwind only when the component uses className', () => {
    expect(buildSandboxDoc({ kind: 'react', content: COMPONENT })).not.toContain(TAILWIND_RUNTIME.src);
    expect(buildSandboxDoc({ kind: 'react', content: 'export default () => <div className="p-4">x</div>' })).toContain(TAILWIND_RUNTIME.src);
  });

  it('embeds the source so it can never close the script element', () => {
    const hostile = 'export default () => <p>{"</script><script>alert(1)</script><!--"}</p>';
    const doc = buildSandboxDoc({ kind: 'react', content: hostile });
    const bootstrap = doc.slice(doc.lastIndexOf('<script>'));
    expect(bootstrap.match(/<\/script>/g)).toHaveLength(1);
    expect(bootstrap).not.toContain('<!--');
    // The source still round-trips exactly.
    const json = /var SOURCE=("[^\n]*");\n/.exec(bootstrap)?.[1] ?? '';
    expect(JSON.parse(json)).toBe(hostile);
  });

  it('transpiles, mounts the default export and shows errors inside the frame', () => {
    const doc = buildSandboxDoc({ kind: 'react', content: COMPONENT });
    expect(doc).toContain('Babel.transform(SOURCE');
    expect(doc).toContain('ReactDOM.createRoot');
    expect(doc).toContain('This component could not run');
    expect(doc).toContain('Only react and react-dom can be imported here');
    expect(doc).toContain('The file has no default export');
    expect(doc).not.toMatch(/\beval\(|new Function/);
  });
});

describe('svgDataUrl', () => {
  it('is an image data URL, fully encoded', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>a & "b" #1</text></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(url).not.toMatch(/[<>"#& ]/);
  });
});
