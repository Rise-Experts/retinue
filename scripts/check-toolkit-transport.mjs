/**
 * One transport, shared — REQ-053 (#227), task #231, AC-4.
 *
 * AC-4 asks for reuse that is *real, not claimed*, and for something that catches a copy which has drifted.
 * This is that something.
 *
 * The history it exists to prevent from repeating: `tools-github` grew a transport in #223 — credential
 * resolved per call, headers pinned to one validated host, JSON parsed, failures mapped onto the platform's
 * error union. `tools-slack` had written its own version of the same thing in #214. Two implementations, and
 * two of the bugs #223 found were in only one of them:
 *
 * - `JSON.parse("")` on a `204`, so a correct empty response was reported as a parse failure;
 * - a non-JSON body obtained by catching the parse error, which discarded the body entirely.
 *
 * `createVendorTransport` now holds all of it, with both fixed. A package that builds its own
 * `createHttpClient` gets neither fix and nobody notices until a vendor returns a `204`.
 *
 * **What this does not require.** Pagination and response envelopes stay per-package, because they are
 * genuinely not shared: Slack pages by cursor, Discord by snowflake, GitHub by page number, Telegram not at
 * all — and `ok: false` (Slack, Telegram), an `errors` array (GraphQL), `json.errors` (Reddit) and a plain
 * status (Discord) are four different shapes. Forcing those into one abstraction is the invention AC-4 warns
 * against, so the check is narrow on purpose.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = "tools";

/**
 * Packages allowed to build their own client, with the reason written down.
 *
 * A string, not a boolean — an exemption whose reason nobody wrote is an exemption nobody can review.
 */
export const EXEMPT = new Map([
  [
    "search",
    "Not a vendor toolkit: it is several search providers behind one contract, each with its own auth shape " +
      "and no credentialRef of its own. It predates the shared transport and has no host to pin.",
  ],
  [
    "scrape",
    "Fetches URLs a model chose, which the shared transport cannot serve: it must connect to an address it has " +
      "already validated (`node:https` accepts a `lookup`; `fetch` has no equivalent, and without pinning there " +
      "is a second DNS resolution between the check and the socket — the rebinding window), and it must follow " +
      "redirects re-checking every hop, where `createHttpClient` refuses them outright. It does not build its " +
      "own client: it uses `safeFetch` from @retinue/agentkit/tools, which is shared with tools-browser.",
  ],
  [
    "email",
    "Speaks SMTP over a socket, which is not HTTP at all, and its HTTP provider posts a composed MIME message " +
      "to a fixed endpoint with a platform credential rather than a per-tenant one. The shared transport " +
      "resolves a credentialRef per call against one pinned host — right for a vendor API, and not the shape " +
      "of either provider here. See tools/email/src/smtp.ts.",
  ],
  [
    "browser",
    "Makes no HTTP requests of its own: a driver the operator supplies talks to the browser, and the browser " +
      "talks to the network. Its URL validation is the shared `refuseUrl`/`resolvePublicly` from " +
      "@retinue/agentkit/tools — the same implementation tools-scrape uses, which is why it lives there.",
  ],
]);

const sourceFiles = (dir) => {
  const out = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(child);
    }
  };
  walk(dir);
  return out;
};

/** Comments stripped, so a *mention* of the helper is not read as a call to it. */
export const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

export const buildsOwnClient = (source) => /\bcreateHttpClient\s*\(/.test(withoutComments(source));
export const usesSharedTransport = (source) => /\bcreateVendorTransport\s*\(/.test(withoutComments(source));

export const toolkitPackages = () =>
  readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(`${ROOT}/${name}/src`).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

const main = () => {
  const packages = toolkitPackages();
  if (packages.length < 3) {
    console.error(`✗ found only ${packages.length} toolkit package(s) — the root is wrong, so a clean result means nothing`);
    return 2;
  }

  const problems = [];
  let sharing = 0;
  for (const name of packages) {
    if (EXEMPT.has(name)) continue;
    const sources = sourceFiles(`${ROOT}/${name}/src`).map((file) => readFileSync(file, "utf8"));
    const own = sources.some(buildsOwnClient);
    const shared = sources.some(usesSharedTransport);
    if (own) {
      problems.push(
        `tools/${name} builds its own HTTP client with createHttpClient. Use createVendorTransport from ` +
          "@retinue/agentkit/tools — it resolves the credential per call, pins the header to the validated " +
          "host, treats an empty body as a success, and offers text() for non-JSON responses.",
      );
    } else if (!shared) {
      problems.push(
        `tools/${name} uses neither createVendorTransport nor createHttpClient, so this check cannot tell ` +
          "whether it shares the transport. If it genuinely makes no requests, add it to EXEMPT with the reason.",
      );
    } else {
      sharing += 1;
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(
    `✓ ${sharing} toolkit package(s) share one transport, ${EXEMPT.size} exempt with a written reason`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
