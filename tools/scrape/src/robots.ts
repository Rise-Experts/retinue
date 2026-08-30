/**
 * `robots.txt`, parsed and honoured — REQ-055 (#237), task #238, AC-5.
 *
 * Respecting it is the default, and the opt-out is an explicit argument documented as the operator's legal
 * responsibility rather than a convenience. The reasoning is not only etiquette: in several jurisdictions
 * ignoring an access-control signal is the difference between reading a public page and unauthorised access,
 * and that is not a decision a toolkit gets to make silently on an operator's behalf.
 *
 * ## The matching rules are not obvious, and getting them wrong fails open
 *
 * - **Longest match wins**, not first match. `Disallow: /` with `Allow: /public/` permits `/public/x` because
 *   the `Allow` is longer. A first-match parser refuses the whole site, which at least fails safe. The reverse
 *   ordering — `Allow: /` then `Disallow: /private/` — is the one where first-match *permits* what the file
 *   forbids, and that fails open.
 * - **Ties go to `Allow`.** This is the rule the major crawlers follow and what site owners write against.
 * - **`*` and `$`** are the two wildcards the de-facto standard has: `*` matches any run of characters and `$`
 *   anchors to the end of the path.
 * - **The most specific user-agent group wins**, and only that group applies. A crawler matching a named group
 *   must ignore `*` entirely, rather than merging the two.
 *
 * A missing or unreachable `robots.txt` means **allowed** — that is what the standard says, and treating a
 * fetch failure as a prohibition would make every site with a flaky origin uncrawlable.
 */

export type RobotsGroup = {
  readonly agents: readonly string[];
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
  readonly crawlDelaySeconds?: number;
};

export type Robots = {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
};

export const EMPTY_ROBOTS: Robots = { groups: [], sitemaps: [] };

/**
 * Parses a `robots.txt`.
 *
 * Consecutive `User-agent` lines share one group — `User-agent: a` then `User-agent: b` then `Disallow: /x`
 * forbids `/x` for both, and splitting them into two groups would drop the rule for the first.
 */
export const parseRobots = (text: string): Robots => {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let agents: string[] = [];
  let allow: string[] = [];
  let disallow: string[] = [];
  let crawlDelay: number | undefined;
  let collectingAgents = false;

  const flush = () => {
    if (agents.length > 0) {
      groups.push({
        agents,
        allow,
        disallow,
        ...(crawlDelay === undefined ? {} : { crawlDelaySeconds: crawlDelay }),
      });
    }
    agents = [];
    allow = [];
    disallow = [];
    crawlDelay = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // A `User-agent` after rules starts a new group; one after another `User-agent` joins it.
      if (!collectingAgents) flush();
      agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    collectingAgents = false;
    if (field === "allow") allow.push(value);
    else if (field === "disallow") disallow.push(value);
    else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelay = seconds;
    } else if (field === "sitemap") sitemaps.push(value);
  }
  flush();
  return { groups, sitemaps };
};

/** Whether a rule pattern matches a path, honouring `*` and a trailing `$`. */
export const matchesRule = (pattern: string, path: string): boolean => {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  // Everything except `*` is literal, so it is escaped before `*` becomes `.*`.
  const expression = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
};

/**
 * The group that applies to a user-agent.
 *
 * The longest matching agent token wins, which is how `RetinueBot` beats `Retinue` beats `*`. Only one group
 * applies: a crawler named explicitly must not also obey `*`, because a site that wrote a specific group meant
 * it to replace the general one.
 */
export const groupFor = (robots: Robots, userAgent: string): RobotsGroup | undefined => {
  const agent = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | undefined;
  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      const applies = candidate === "*" || agent.includes(candidate);
      if (!applies) continue;
      const length = candidate === "*" ? 0 : candidate.length;
      if (best === undefined || length > best.length) best = { group, length };
    }
  }
  return best?.group;
};

/** Whether a URL may be fetched. Longest match wins; a tie goes to `Allow`. */
export const isAllowed = (robots: Robots, userAgent: string, url: string): boolean => {
  const group = groupFor(robots, userAgent);
  if (group === undefined) return true;
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return true;
  }
  const longest = (rules: readonly string[]): number =>
    rules.reduce((best, rule) => (matchesRule(rule, path) ? Math.max(best, rule.length) : best), -1);
  const allowed = longest(group.allow);
  const disallowed = longest(group.disallow);
  if (disallowed === -1) return true;
  // `>=`, so an equally specific Allow wins — the rule the major crawlers follow and what site owners write
  // against.
  return allowed >= disallowed;
};

export const crawlDelayOf = (robots: Robots, userAgent: string): number | undefined =>
  groupFor(robots, userAgent)?.crawlDelaySeconds;
