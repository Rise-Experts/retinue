#!/usr/bin/env node
/**
 * The documentation site is on the hostname it says it is — REQ-035 (#184), SPEC #203.
 *
 * The site now claims `docs.retinue.riseexperts.de`; it was `docs.agentkit.riseexperts.de` until #203. Moving it
 * is a cutover with a live site on the other end — a DNS record, a custom domain, a 301, and only then a rebuild
 * — and the parts that need the Cloudflare account cannot be done from this repository at all. So what this
 * repository owns is the *verification*: the difference between a promise and a gate is that one of them can be
 * answered with "I thought it worked".
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
 * ## Before the cutover this was not a failure
 *
 * While the config still named the legacy host there was nothing to redirect, and reporting red would have made
 * a check that could only ever be red — one people learn to ignore, and then it is not there on the day it
 * matters. That branch is still here and still correct; it simply no longer applies, because the config moved in
 * #203 and the assertions below are live.
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
 * Two copies of one Worker name, which is the pair that drifts.
 *
 * Checked because it *had* drifted from reality: both said `agentkit-docs` and no Worker by that name existed —
 * the site is served by `agentkit`, redeployed by Cloudflare's Git integration on every push. The documented
 * `npx wrangler deploy` would therefore have created a third Worker and published the site to it: the deploy
 * succeeds, and what is deployed is not what is served. Nothing local could have noticed, because the name is
 * only wrong in comparison with an account this check cannot see. What it *can* see is the two files agreeing,
 * which is the half that catches the next drift.
 */
const WRANGLER = ["wrangler.jsonc", "website/wrangler.jsonc"];

/**
 * The host the site *was* served from, kept on purpose.
 *
 * A constant rather than derived, and it stays here **after** the cutover: the thing being checked from now on is
 * that this host still answers and still redirects, path preserved. Deleting it once the move was done would have
 * removed the only assertion that the old links kept working — and those links are in issue comments, commit
 * messages, and whatever is already indexed.
 */
export const LEGACY_URL = "https://docs.agentkit.riseexperts.de";

/** The Worker name a wrangler config declares. */
export const wranglerName = (source) => {
  const match = /^\s*"name":\s*"([^"]+)"/m.exec(source);
  return match ? match[1] : null;
};

/**
 * The hostnames a wrangler config attaches as **custom domains**.
 *
 * Only `custom_domain: true` entries count, and the distinction is the whole point. A plain route matches
 * traffic for a hostname that must already resolve and already have a certificate; a custom domain *creates*
 * the DNS record and provisions an Advanced Certificate for the exact hostname. For a second-level subdomain
 * like `docs.retinue.riseexperts.de` — which Cloudflare's universal certificate does not cover — a route leaves
 * the site answering over plain HTTP and failing the TLS handshake. That is not a hypothetical: it is what the
 * hostname did for several hours on 27 Aug 2026.
 */
export const customDomains = (source) => {
  const out = [];
  // Tolerant of key order and of formatting, because a jsonc file is hand-edited and a stricter parse would
  // silently find nothing — which here means silently reporting no problem.
  for (const [, block] of source.matchAll(/\{([^{}]*)\}/g)) {
    if (!/"custom_domain"\s*:\s*true/.test(block)) continue;
    const pattern = /"pattern"\s*:\s*"([^"]+)"/.exec(block);
    if (pattern) out.push(pattern[1]);
  }
  return out;
};

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

  // ── the deploy target: one name, in two files ─────────────────────────────────────────────────────────────
  const names = WRANGLER.map((path) => (existsSync(path) ? wranglerName(readFileSync(path, "utf8")) : null));
  if (names.some((name) => name === null)) {
    problems.push(`a wrangler config is missing or declares no \`name\`: ${WRANGLER.join(", ")}`);
  } else if (names[0] !== names[1]) {
    problems.push(
      `${WRANGLER[0]} deploys to "${names[0]}" and ${WRANGLER[1]} to "${names[1]}" — one of them publishes the` +
        ` site to a Worker nobody serves from, and the deploy succeeds either way`,
    );
  }

  /**
   * ── the hostname is actually attached ──────────────────────────────────────────────────────────────────────
   *
   * The site's `url` is a claim about where it is served. Nothing made the *deploy* agree with that claim, and
   * on 27 Aug 2026 they disagreed for hours: the config named a hostname that no Worker attached, so the host
   * served a 530 and then stopped resolving. A canonical link pointing at a hostname nothing serves is worse
   * than a wrong one — it looks deliberate.
   */
  const intendedHost = new URL(intended).hostname;
  WRANGLER.forEach((path, at) => {
    if (!existsSync(path)) return;
    const attached = customDomains(readFileSync(path, "utf8"));
    if (attached.length === 0) {
      problems.push(
        `${path} attaches no custom domain, so a deploy from it serves the site nowhere — ` +
          `add { "pattern": "${intendedHost}", "custom_domain": true } to \`routes\``,
      );
    } else if (!attached.includes(intendedHost)) {
      problems.push(
        `${path} attaches ${attached.join(", ")} but the site claims ${intendedHost} — the canonical links point` +
          ` at a hostname this deploy does not serve`,
      );
    }
    void at;
  });

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
