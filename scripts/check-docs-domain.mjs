#!/usr/bin/env node
/**
 * The documentation site is on the hostname it says it is — REQ-035 (#184), SPEC #203.
 *
 * Every artefact carries the product name except this one: the site is served from
 * `docs.agentkit.riseexperts.de`. Moving it is a cutover with a live site on the other end — a DNS record, a
 * custom domain, a 301, and only then a rebuild — and the parts that need the Cloudflare account cannot be done
 * from this repository at all. So what this repository can own is the *verification*: the difference between a
 * promise and a gate is that one of them can be answered with "I thought it worked".
 *
 * ## Why the config is the single source of truth
 *
 * `website/docusaurus.config.ts`'s `url` is baked into every built page's canonical link, its `og:url` and every
 * entry of `sitemap.xml`. So the check does not take the target hostname as an argument — it reads what the site
 * *claims to be*, and holds reality to it. That means this file needs no edit during the cutover: change the
 * config, and the same check flips from "not cut over yet" to enforcing the redirect.
 *
 * A hostname passed on the command line would be a second place the answer lives, which is the shape this
 * repository keeps finding defects in.
 *
 * ## Before the cutover this is not a failure
 *
 * While the config still names the legacy host there is nothing to redirect, and reporting red would make a
 * check that can only ever be red — which is a check people learn to ignore, and then it is not there on the day
 * it matters. So it reports the pending state, verifies the live site still answers, and exits 0.
 *
 * ## What it asserts once the config has moved
 *
 * 1. The intended host serves the site.
 * 2. The legacy host answers **301** — not 302 — to the *same path* on the intended host. A redirect to the root
 *    is the failure that loses every deep link that exists today, and it passes any test that only checks "a
 *    redirect happens".
 * 3. `sitemap.xml` and the canonical/`og:url` tags name the intended host and not the legacy one. A site whose
 *    canonical URL points at a host that redirects is a site telling search engines two different things.
 * 4. The *built output on disk* agrees with the config, which is the offline half: it catches "the config moved
 *    and nothing was redeployed", where every network check above would pass against the old build.
 *
 * Usage: node scripts/check-docs-domain.mjs [--offline]
 * Exit codes: 0 holds (or not cut over yet), 1 a violation, 2 the check could not tell.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = "website/docusaurus.config.ts";
const BUILD = "website/build";

/**
 * The host the site is served from today.
 *
 * A constant rather than derived, and it stays here **after** the cutover: the thing being checked from then on
 * is that this host still answers and still redirects. Deleting it once the move is done would remove the only
 * assertion that the old links kept working.
 */
export const LEGACY_URL = "https://docs.agentkit.riseexperts.de";

/** The `url` the site claims. Parsed rather than imported, because the config is TypeScript with plugins. */
export const configuredUrl = (source) => {
  const match = /^\s*url:\s*"([^"]+)"/m.exec(source);
  return match ? match[1].replace(/\/$/, "") : null;
};

/** The first non-root path in a sitemap, so the deep-link check uses a page that actually exists. */
export const deepPathFrom = (xml, origin) => {
  for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    if (!loc.startsWith(origin)) continue;
    const path = loc.slice(origin.length);
    if (path.length > 1) return path;
  }
  return null;
};

/**
 * Whether the legacy host's answer is the redirect the cutover promised.
 *
 * Three separate ways this goes wrong, and only one of them looks wrong: a 302 (which tells caches and search
 * engines the move is temporary), a redirect to the *root* (which loses every deep link in existence, and passes
 * any check that asks only "did it redirect"), and a redirect to the wrong host.
 */
export const redirectVerdict = ({ status, location }, { intended, path }) => {
  if (status !== 301) {
    return status >= 300 && status < 400
      ? `answered ${status} rather than 301 — a temporary redirect tells caches and search engines the move is not real`
      : `answered ${status}, not a redirect`;
  }
  if (!location) return "answered 301 with no location header";
  const expected = `${intended}${path}`;
  if (location.replace(/\/$/, "") === intended) {
    return `redirects to the root, losing the path ${path} — every deep link that exists today points at a path`;
  }
  if (location !== expected) return `redirects to ${location}, expected ${expected}`;
  return null;
};

/**
 * The path a host actually serves, after one hop of its own normalisation.
 *
 * The normalising redirect's `location` is **relative** (`/search/`) — found by checking, after a first version
 * that only handled an absolute one and silently kept the unnormalised path. Both forms are accepted; anything
 * pointing off-origin is not a normalisation and is left alone.
 */
export const settledPath = (path, { status, location }, origin) => {
  if (status < 300 || status >= 400 || !location) return path;
  if (location.startsWith("/")) return location;
  if (location.startsWith(origin)) return location.slice(origin.length);
  return path;
};

/** Absolute origins on our own domain that a document mentions, so a stale canonical is visible. */
export const originsIn = (text) =>
  new Set([...text.matchAll(/https:\/\/[a-z0-9.-]*riseexperts\.de/g)].map((match) => match[0]));

const die = (message, detail) => {
  console.error(`✗ ${message}`);
  if (detail) console.error(detail.replace(/^/gm, "  "));
  process.exit(2);
};

const main = async () => {
  if (!existsSync(CONFIG)) die(`cannot read ${CONFIG}`);
  const intended = configuredUrl(readFileSync(CONFIG, "utf8"));
  if (!intended) {
    die(
      `no \`url:\` in ${CONFIG}`,
      "the config is this check's only source of truth for the hostname; without it there is nothing to hold\n" +
        "reality to, and passing would mean reporting success having checked nothing",
    );
  }

  const problems = [];
  const cutOver = intended !== LEGACY_URL;

  // ── the offline half: the build on disk agrees with the config ─────────────────────────────────────────────
  const sitemapPath = join(BUILD, "sitemap.xml");
  let sitemap = null;
  if (existsSync(sitemapPath)) {
    sitemap = readFileSync(sitemapPath, "utf8");
    const origins = originsIn(sitemap);
    if (!origins.has(intended)) problems.push(`the built sitemap does not use ${intended} — rebuild the site`);
    if (cutOver && origins.has(LEGACY_URL)) {
      problems.push(`the built sitemap still contains ${LEGACY_URL}, so the build predates the config change`);
    }
    const indexPath = join(BUILD, "index.html");
    if (existsSync(indexPath)) {
      const origins = originsIn(readFileSync(indexPath, "utf8"));
      if (cutOver && origins.has(LEGACY_URL)) {
        problems.push(
          `the built home page's canonical/og:url still name ${LEGACY_URL} — a canonical pointing at a host` +
            ` that redirects tells search engines two different things`,
        );
      }
    }
  } else {
    console.log(`  · no ${sitemapPath}; run \`npm run docs:build\` to include the offline half`);
  }

  if (process.argv.includes("--offline")) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) return 1;
    console.log(`✓ the built output agrees with ${CONFIG} (${intended})`);
    return 0;
  }

  // ── the network half ──────────────────────────────────────────────────────────────────────────────────────
  const get = async (url) => {
    try {
      const response = await fetch(url, { redirect: "manual" });
      return { status: response.status, location: response.headers.get("location"), response };
    } catch (error) {
      die(
        `cannot reach ${url}: ${error.message}`,
        "this check needs the network. It is not in `npm test` for that reason — a gate that fails when DNS is\n" +
          "slow is a gate people learn to skip. Use --offline for the half that does not.",
      );
    }
  };

  const live = await get(`${intended}/`);
  if (live.status !== 200) problems.push(`${intended}/ answered ${live.status}`);

  if (!cutOver) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length > 0) return 1;
    console.log(
      `· not cut over yet: ${CONFIG} still says ${LEGACY_URL}, which answers 200. #203 is the cutover;\n` +
        `  this check starts enforcing the 301 the moment that \`url\` changes, with no edit here.`,
    );
    return 0;
  }

  /**
   * A deep path in the form the site actually serves it.
   *
   * Found by sabotage: the sitemap lists `/search`, and the live host answers **307** to `/search/` because the
   * asset server normalises trailing slashes. Asserting the legacy host's redirect against the unnormalised path
   * would then report a redirect that "is not a 301" when the 301 is there and something else answered first. So
   * the path is resolved on the intended host once, and the deep-link assertion uses the settled form.
   */
  let path = (sitemap && deepPathFrom(sitemap, intended)) || "/search";
  const settled = await get(`${intended}${path}`);
  path = settledPath(path, settled, intended);

  const legacy = await get(`${LEGACY_URL}${path}`);
  const verdict = redirectVerdict(legacy, { intended, path });
  if (verdict) problems.push(`${LEGACY_URL}${path} ${verdict}`);

  const map = await get(`${intended}/sitemap.xml`);
  if (map.status !== 200) {
    problems.push(`${intended}/sitemap.xml answered ${map.status}`);
  } else {
    const origins = originsIn(await map.response.text());
    if (!origins.has(intended)) problems.push(`the served sitemap does not use ${intended}`);
    if (origins.has(LEGACY_URL)) problems.push(`the served sitemap still contains ${LEGACY_URL}`);
  }

  const home = await get(`${intended}/`);
  if (home.status === 200) {
    const origins = originsIn(await home.response.text());
    if (origins.has(LEGACY_URL)) {
      problems.push(`the served home page still names ${LEGACY_URL} in its canonical or og:url`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\n  ${problems.length} problem(s). See #203 for the order these steps have to happen in.`);
    return 1;
  }

  console.log(
    `✓ ${intended} serves the site, ${LEGACY_URL}${path} redirects 301 to the same path, and the sitemap and` +
      ` canonical tags name only the new host`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
