/**
 * Proves the docs-domain checker's judgements, because the check itself cannot be exercised until the cutover
 * happens and the failures it exists to catch are the ones that look like success.
 *
 * `redirectVerdict` is the reason this file exists. "Did the old host redirect?" is the question everybody asks
 * and it is the wrong one: a 302 tells caches the move is temporary, and a redirect to the *root* loses every
 * deep link in existence while passing any check that only asks whether a redirect happened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  configuredUrl,
  deepPathFrom,
  LEGACY_URL,
  originsIn,
  redirectVerdict,
  settledPath,
  wranglerName,
  customDomains,
} from "./check-docs-domain.mjs";

const INTENDED = "https://docs.retinue.riseexperts.de";

test("importing this module does not run the check", () => {
  // The same guard the consumer-boundary checker needed: without it, importing here ran the whole check and
  // exited the test process before an assertion had been evaluated.
  assert.ok(true);
});

test("the hostname comes from the config, trailing slash removed", () => {
  assert.equal(configuredUrl('const config = {\n  title: "Retinue",\n  url: "https://x.example/",\n};'), "https://x.example");
  assert.equal(configuredUrl('  url: "https://y.example",'), "https://y.example");
  // No url: the caller must exit 2 rather than pass, since there is then nothing to hold reality to.
  assert.equal(configuredUrl('const config = { title: "Retinue" };'), null);
  // Not fooled by a `url:` belonging to something else further down the file.
  assert.equal(configuredUrl('  url: "https://real.example",\n  footer: { url: "https://other.example" },'), "https://real.example");
});

test("a 301 to the same path is the only pass", () => {
  assert.equal(redirectVerdict({ status: 301, location: `${INTENDED}/concepts/flows/` }, { intended: INTENDED, path: "/concepts/flows/" }), null);
});

test("a 302 is refused, because it tells caches the move is not real", () => {
  const verdict = redirectVerdict({ status: 302, location: `${INTENDED}/x/` }, { intended: INTENDED, path: "/x/" });
  assert.match(verdict, /rather than 301/);
});

test("a redirect to the root is refused, which is the failure that looks like success", () => {
  // Every deep link that exists today points at a path. This passes "did it redirect" and loses all of them.
  const verdict = redirectVerdict({ status: 301, location: INTENDED }, { intended: INTENDED, path: "/concepts/flows/" });
  assert.match(verdict, /redirects to the root, losing the path/);
});

test("a redirect to the wrong host, and one with no location, are refused", () => {
  assert.match(
    redirectVerdict({ status: 301, location: "https://elsewhere.example/x/" }, { intended: INTENDED, path: "/x/" }),
    /expected https:\/\/docs\.retinue\.riseexperts\.de\/x\//,
  );
  assert.match(redirectVerdict({ status: 301, location: null }, { intended: INTENDED, path: "/x/" }), /no location header/);
  assert.match(redirectVerdict({ status: 200, location: null }, { intended: INTENDED, path: "/x/" }), /not a redirect/);
});

test("a normalising redirect settles the path, relative or absolute", () => {
  // The live site answers 307 with a **relative** location (`/search/`). A first version handled only the
  // absolute form and silently kept the unnormalised path, which would have reported a missing 301 that was
  // there.
  assert.equal(settledPath("/search", { status: 307, location: "/search/" }, INTENDED), "/search/");
  assert.equal(settledPath("/search", { status: 307, location: `${INTENDED}/search/` }, INTENDED), "/search/");
  assert.equal(settledPath("/search", { status: 307, location: "https://elsewhere.example/x" }, INTENDED), "/search");
  assert.equal(settledPath("/search", { status: 200, location: null }, INTENDED), "/search");
});

test("the deep path comes from the sitemap, and the root is not a deep path", () => {
  const xml = `<urlset><url><loc>${INTENDED}/</loc></url><url><loc>${INTENDED}/api/</loc></url></urlset>`;
  assert.equal(deepPathFrom(xml, INTENDED), "/api/");
  assert.equal(deepPathFrom(`<urlset><url><loc>${INTENDED}/</loc></url></urlset>`, INTENDED), null);
});

test("origins on our own domain are found, so a stale canonical is visible", () => {
  const html = `<link rel="canonical" href="${LEGACY_URL}/"><meta property="og:url" content="${INTENDED}/">`;
  assert.deepEqual([...originsIn(html)].sort(), [LEGACY_URL, INTENDED].sort());
  // A third-party absolute URL is not ours and must not be reported as a hostname problem.
  assert.deepEqual([...originsIn('<a href="https://github.com/Rise-Experts/retinue">')], []);
});

test("the Worker name is read from a wrangler config, comments and all", () => {
  // JSONC: the real files open with a dozen lines of comment before any key, and one of those comments
  // contains the word "name" in prose.
  const config = '{\n  // `name` is the Worker that actually serves the site.\n  "$schema": "x",\n  "name": "agentkit",\n}';
  assert.equal(wranglerName(config), "agentkit");
  assert.equal(wranglerName('{ "assets": { "directory": "./build" } }'), null);
});

test("the legacy host stays named after the cutover", () => {
  // Deleting it once the move is done would remove the only assertion that the old links kept working.
  assert.equal(LEGACY_URL, "https://docs.agentkit.riseexperts.de");
});

test("only a custom domain counts as attaching the hostname", () => {
  /**
   * The distinction that cost an afternoon. A route matches traffic for a hostname that must already resolve and
   * already have a certificate; a custom domain *creates* the record and provisions an Advanced Certificate for
   * the exact hostname. `docs.retinue.riseexperts.de` is a second-level subdomain, which the universal
   * certificate does not cover, so a route leaves the site answering over HTTP and failing TLS.
   */
  const withDomain = '{ "routes": [ { "pattern": "docs.example.com", "custom_domain": true } ] }';
  const withRoute = '{ "routes": [ { "pattern": "docs.example.com/*" } ] }';
  assert.deepEqual(customDomains(withDomain), ["docs.example.com"]);
  assert.deepEqual(customDomains(withRoute), []);
});

test("key order and formatting do not change the answer", () => {
  // A jsonc file is hand-edited, and a stricter parse that found nothing would report no problem — which is the
  // failure mode that matters, because this check exists to catch an absent attachment.
  const reordered = `{
    "routes": [
      {
        "custom_domain": true,
        "pattern": "docs.example.com"
      }
    ]
  }`;
  assert.deepEqual(customDomains(reordered), ["docs.example.com"]);
});

test("the shipped configs attach exactly the hostname the site claims", () => {
  const url = configuredUrl(readFileSync("website/docusaurus.config.ts", "utf8"));
  const host = new URL(url).hostname;
  for (const path of ["wrangler.jsonc", "website/wrangler.jsonc"]) {
    assert.deepEqual(customDomains(readFileSync(path, "utf8")), [host], path);
  }
});
