#!/usr/bin/env node
/**
 * The brand holds where it is applied — REQ-049 (#208), task #218, AC-2 and AC-7.
 *
 * Three assertions, each of which was a claim somebody would otherwise have to take on trust:
 *
 * 1. **Contrast is measured, not assumed.** Every pair in `brand/tokens.json` is computed against WCAG's own
 *    formula and held to the ratio the token file names. The dark palette is *designed*, not inverted — the navy
 *    is 2.2:1 on a dark ground, which is unreadable — and a check is the only thing that keeps that true as
 *    somebody adjusts a colour.
 * 2. **The site's CSS uses the tokens.** A token file nothing reads is a document, and the CSS drifts from it in
 *    the first hurry.
 * 3. **The built site fetches no asset from a host we do not control.** A Google Fonts stylesheet, a CDN script
 *    or a remote image is a third party learning every reader's IP address and a page that breaks when they do.
 *
 * Exit codes: 0 clean, 1 a violated guarantee, 2 the check could not run.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOKENS = "brand/tokens.json";
const CSS = "website/src/css/custom.css";
const BUILD = "website/build";

/** Hosts a built page may reference. Empty on purpose: everything is served from the site's own origin. */
export const ALLOWED_HOSTS = [];

/** sRGB → relative luminance, per WCAG 2.1. */
export const luminance = (hex) => {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
};

/** The WCAG contrast ratio between two hex colours, 1–21. */
export const contrastRatio = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

export const round = (value) => Math.round(value * 100) / 100;

/** Colours the CSS must mention, so the stylesheet cannot drift from the token file. */
export const cssUsesTokens = (css, colours) => {
  const missing = [];
  for (const [name, token] of Object.entries(colours)) {
    if (!css.toLowerCase().includes(token.value.toLowerCase())) missing.push(`${name} (${token.value})`);
  }
  return missing;
};

/** Every absolute URL in the built HTML and CSS, as hostnames. */
export const externalHosts = (dir) => {
  const hosts = new Map();
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(html|css)$/.test(name)) continue;
      const text = readFileSync(full, "utf8");
      /**
       * Only where a *browser fetches something*: `src`, `href` on a stylesheet or icon, and `url()` in CSS.
       *
       * A plain `<a href="https://github.com/…">` is a link somebody clicks, not an asset the page loads, and
       * flagging those would make this check fire on every citation in the documentation — the false-positive
       * shape that gets a check deleted.
       */
      const patterns = [
        /<(?:script|img|source|video|audio|iframe)[^>]+src="(https?:\/\/[^"]+)"/g,
        /<link[^>]+rel="(?:stylesheet|preload|icon|apple-touch-icon)"[^>]*href="(https?:\/\/[^"]+)"/g,
        /<link[^>]+href="(https?:\/\/[^"]+)"[^>]*rel="(?:stylesheet|preload|icon|apple-touch-icon)"/g,
        /url\((?:"|')?(https?:\/\/[^)"']+)/g,
      ];
      for (const pattern of patterns) {
        for (const [, url] of text.matchAll(pattern)) {
          const host = new URL(url).hostname;
          if (ALLOWED_HOSTS.includes(host)) continue;
          hosts.set(host, [...(hosts.get(host) ?? []), full].slice(0, 3));
        }
      }
    }
  };
  walk(dir);
  return hosts;
};

const main = () => {
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
  } catch (error) {
    console.error(`✗ cannot read ${TOKENS}: ${error.message}`);
    console.error("  the tokens are the brand; without them there is nothing to check against");
    return 2;
  }

  const colours = tokens.colour ?? {};
  const pairs = tokens.contrast ?? [];
  if (pairs.length === 0) {
    console.error(`✗ ${TOKENS} declares no contrast pairs, so nothing was measured`);
    return 2;
  }

  const failures = [];
  const measured = [];
  for (const { pair, use, min } of pairs) {
    const [a, b] = pair;
    const first = colours[a]?.value;
    const second = colours[b]?.value;
    if (first === undefined || second === undefined) {
      failures.push(`${a}/${b} names a colour that is not in the token file`);
      continue;
    }
    const ratio = round(contrastRatio(first, second));
    measured.push(`${a} on ${b}: ${ratio}:1 (${use}, needs ${min})`);
    if (ratio < min) failures.push(`${a} on ${b} is ${ratio}:1 — ${use} needs ${min}:1`);
  }

  let css;
  try {
    css = readFileSync(CSS, "utf8");
  } catch (error) {
    failures.push(`cannot read ${CSS}: ${error.message}`);
    css = "";
  }
  const unused = cssUsesTokens(css, colours);
  if (unused.length > 0) failures.push(`${CSS} does not use ${unused.join(", ")} — the palette and the site disagree`);

  if (existsSync(BUILD)) {
    const hosts = externalHosts(BUILD);
    for (const [host, files] of hosts) {
      failures.push(`the built site fetches an asset from ${host} (e.g. ${files[0]})`);
    }
    if (hosts.size === 0) measured.push(`${BUILD}: no external asset host`);
  } else {
    // Not a silent pass: a missing build means the third assertion did not happen, and the run should say so.
    failures.push(`${BUILD} does not exist, so no external-asset check ran — build the site first`);
  }

  for (const asset of ["website/static/img/favicon.svg", "website/static/img/og-retinue.png"]) {
    if (!existsSync(asset)) failures.push(`${asset} is missing — a shared link renders as a grey rectangle without it`);
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} brand problem(s):`);
    for (const failure of failures) console.error(`  · ${failure}`);
    return 1;
  }

  console.log(`✓ the brand holds: ${pairs.length} contrast pair(s) measured, tokens applied, no external assets`);
  for (const line of measured) console.log(`  · ${line}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
