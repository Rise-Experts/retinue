/**
 * Reading an environment variable through the rename — #192.
 *
 * Every variable this platform reads was `AGENTKIT_*` and is now `RETINUE_*`. A straight rename breaks every
 * existing deployment and every developer's `.env` at the moment they pull, with an error that says nothing about
 * why — a missing database URL looks like a missing database URL, not like a rename.
 *
 * So both are read, new name first, and the old one **warns**. That gives one release where a deployment keeps
 * working while it is corrected, and the warning is what makes the deprecation finite rather than permanent:
 * silence would mean the fallback is still load-bearing in a year and nobody knows.
 *
 * The library itself reads no environment — `deployment.test.ts` enforces that. This is used by the host and the
 * scripts, which are entry points, and reading configuration is what an entry point is for.
 */

const LEGACY_PREFIX = "AGENTKIT_";
const PREFIX = "RETINUE_";

/** Reported once per variable, so a busy worker does not print the same line on every request. */
const warned = new Set<string>();

export type EnvReader = (name: string) => string | undefined;

/**
 * `RETINUE_X`, falling back to `AGENTKIT_X`.
 *
 * `name` is given **without** the prefix — `read(env, "DATABASE_URL")` — so a caller cannot accidentally ask for
 * the legacy name directly and skip the warning.
 */
export const readEnv = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  warn: (message: string) => void = (m) => console.warn(m),
): string | undefined => {
  const current = env[`${PREFIX}${name}`];
  if (current !== undefined && current !== "") return current;

  const legacy = env[`${LEGACY_PREFIX}${name}`];
  if (legacy === undefined || legacy === "") return undefined;

  if (!warned.has(name)) {
    warned.add(name);
    warn(
      `${LEGACY_PREFIX}${name} is deprecated and will stop being read in the next minor release. ` +
        `Rename it to ${PREFIX}${name}.`,
    );
  }
  return legacy;
};

/** For tests, which need each case to see a fresh warning rather than one suppressed by an earlier case. */
export const resetEnvWarnings = (): void => warned.clear();
