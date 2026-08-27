/**
 * `retinue doctor` — task #252 AC-4.
 *
 * The one command here that is new rather than a wrapper, and the one that pays for itself: every failure it
 * names is otherwise a support conversation. A deployment that will not start currently produces one error, from
 * whichever check happened to run first, and the operator fixes it and runs again to find the next.
 *
 * ## Every failure, not the first
 *
 * The whole value is in the plural. A doctor that stops at the first problem sends the user round the loop once
 * per problem — which is exactly what starting the server already does, so it would add nothing. Each check is
 * therefore independent and its own failure is caught, so a Postgres that will not connect does not prevent the
 * Redis check from running.
 *
 * ## Nothing here prints a secret
 *
 * A diagnostic tool is exactly where a URL with a password in it gets pasted into a support ticket. So a
 * connection string is reported by its *shape* — host and database, never userinfo — and a failure message is
 * the driver's, scrubbed. `mcp/egress.ts` already refuses credentials in a URL for the same reason.
 */

import { ConfigurationError, loadConfig } from "./config.js";

export type CheckResult = {
  readonly name: string;
  readonly ok: boolean;
  /** What was found. Never a secret. */
  readonly detail: string;
  /** Present when `ok` is false: what to do about it. */
  readonly remedy?: string;
  /**
   * A check that could not run rather than one that failed.
   *
   * Distinct because the two need different responses: a failed check is a broken deployment, and a skipped one
   * is a deployment this tool cannot see into. Reporting a skip as a pass would be the "passes having checked
   * nothing" failure; reporting it as a failure would tell an operator to fix something that is not wrong.
   */
  readonly skipped?: boolean;
};

/**
 * A connection string reduced to what is safe to print.
 *
 * Deliberately not a regex over the whole string: `URL` parsing means a password containing a `@` or a `/`
 * cannot smuggle itself into the output. An unparseable value is reported as unparseable rather than echoed,
 * because echoing it is how a secret reaches a log.
 */
/**
 * A connection string reduced to what is safe to print, by **whitelist**.
 *
 * Two earlier versions of this leaked, and both leaked the same way — by trying to *remove* the secret from a
 * string whose structure was not what they assumed:
 *
 * 1. Parsing with `URL` and printing `hostname`/`port`/`pathname`. For
 *    `postgres://user:p@ss/word@db.internal:5432/app`, `URL` reads `user:p` as the userinfo and `ss` as the
 *    hostname, so the "safe" output was `postgres://ss/word@db.internal:5432/app` — half the password, spread
 *    across the host and path.
 * 2. Refusing when the *authority* contained two `@`. The authority ends at the first `/`, and in that example
 *    the second `@` is after it. So the check passed and the leak stood.
 *
 * A redaction function must therefore not try to find the secret. It matches a strict, unambiguous shape and
 * prints only the groups it captured; anything else is refused unprinted. An unescaped `@` or `/` in a password
 * is common, and it is exactly what makes a connection string ambiguous — so ambiguity is the thing to refuse,
 * not to parse harder.
 */
const SAFE_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(?::(\d+))?(?:\/([A-Za-z0-9._-]*))?$/;

export const describeUrl = (value: string): string => {
  const match = SAFE_URL.exec(value);
  if (match === null) return "(not printed — the value does not match an unambiguous connection-string shape)";
  const [, scheme, host, port, database] = match;
  return `${scheme}://${host}${port === undefined ? "" : `:${port}`}${database ? `/${database}` : ""}`;
};

/** The driver's message, with anything URL-shaped reduced. Errors quote the connection string routinely. */
export const scrub = (message: string): string =>
  message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (m) => describeUrl(m));

export type DoctorDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so the checks are testable without a database or a Redis. */
  readonly connectPostgres?: (url: string) => Promise<{
    query(text: string, params?: readonly unknown[]): Promise<unknown>;
    end(): Promise<void>;
  }>;
  readonly connectRedis?: (url: string) => Promise<{ ping(): Promise<string>; quit(): Promise<unknown> }>;
  readonly schemaVersions?: (sql: {
    query(text: string, params?: readonly unknown[]): Promise<unknown>;
  }) => Promise<{ current: number; target: number }>;
};

const message = (error: unknown): string => scrub(error instanceof Error ? error.message : String(error));

/** True when `describeUrl` refused to print a value, so nothing derived from it can be trusted either. */
const unsafe = (described: string): boolean => described.startsWith("(");

/**
 * What to say about a connection failure — the URL and the driver's message, or neither.
 *
 * A driver interpolates whatever *it* parsed, so `postgres://u:p@ss/word@host/db` fails with
 * `getaddrinfo ENOTFOUND ss` — a fragment of the password, in a message no scrubber can recognise as one
 * because `ss` is not URL-shaped. The rule that follows is simple and the only safe one: if the value could not
 * be printed, the error derived from it is not printed either. The remedy still names the variable, which is
 * what the operator needs.
 */
const failureDetail = (url: string, error: unknown): string => {
  const described = describeUrl(url);
  return unsafe(described)
    ? `${described} The driver's message is withheld for the same reason — it can quote the value it parsed.`
    : `${described}: ${message(error)}`;
};

/** How long any one check may take before it is reported as a timeout. */
export const CHECK_TIMEOUT_MS = 5_000;

/**
 * A backstop, because **a diagnostic that hangs is worse than one that fails.**
 *
 * Found by running `doctor` against a refused port: `pg.Pool` has no default connect timeout and `ioredis`
 * retries a refused connection for ever, so the command sat there silently instead of reporting the two
 * failures it existed to report. Both drivers are now configured to fail fast, and this is the belt to that
 * braces — a driver whose timeout option is wrong or renamed must not be able to hang the tool.
 *
 * The timer is unref'd so a completed check never holds the process open past its work.
 */
export const withTimeout = async <T>(what: string, work: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not respond within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runChecks = async (deps: DoctorDeps = {}): Promise<readonly CheckResult[]> => {
  const env = deps.env ?? process.env;
  const results: CheckResult[] = [];

  // 1. Configuration. Everything else needs it, so a failure here skips the rest rather than reporting
  //    cascading failures that are all the same problem.
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(env);
    results.push({ name: "configuration", ok: true, detail: `schema mode ${config.schemaMode}, port ${config.port}` });
  } catch (error) {
    results.push({
      name: "configuration",
      ok: false,
      detail: message(error),
      remedy:
        error instanceof ConfigurationError
          ? `Set or correct: ${error.variables.join(", ")}. See .env.example.`
          : "See .env.example for the variables this deployment needs.",
    });
    for (const name of ["postgres", "schema", "redis"]) {
      results.push({
        name,
        ok: true,
        skipped: true,
        detail: "not checked — configuration is unusable, so this would fail for the same reason",
      });
    }
    return results;
  }

  // 2. The app module, which `serve` and `worker` need and `migrate` does not.
  const appModule = env["RETINUE_APP_MODULE"];
  if (appModule === undefined || appModule.trim() === "") {
    results.push({
      name: "app module",
      ok: true,
      skipped: true,
      detail: "RETINUE_APP_MODULE is unset — `migrate` and `doctor` work without it; `serve` and `worker` do not",
      remedy: "Point RETINUE_APP_MODULE at a module default-exporting { authenticate, deps } before serving.",
    });
  } else {
    try {
      const loaded = (await import(appModule)) as { default?: { authenticate?: unknown; deps?: unknown } };
      const app = loaded.default;
      const ok = typeof app?.authenticate === "function" && typeof app?.deps === "function";
      results.push({
        name: "app module",
        ok,
        detail: ok ? `${appModule} exports { authenticate, deps }` : `${appModule} loaded but is missing exports`,
        ...(ok ? {} : { remedy: "It must default-export { authenticate, deps }. `authenticate` has no default." }),
      });
    } catch (error) {
      results.push({
        name: "app module",
        ok: false,
        detail: `${appModule} could not be loaded: ${message(error)}`,
        remedy: "Check the path is resolvable from the working directory, and that the module builds.",
      });
    }
  }

  // 3. Postgres, and 4. the schema — one connection, two findings.
  const connectPostgres = deps.connectPostgres;
  if (connectPostgres === undefined) {
    results.push({ name: "postgres", ok: true, skipped: true, detail: "no driver supplied" });
    results.push({ name: "schema", ok: true, skipped: true, detail: "no driver supplied" });
  } else {
    let sql: Awaited<ReturnType<typeof connectPostgres>> | undefined;
    /**
     * Whether Postgres *answered*, which is not the same as whether a pool object exists.
     *
     * `new Pool()` does not connect, so `sql` is defined even when the database is unreachable — and keying the
     * schema check on `sql !== undefined` reported "0 of 30 migrations applied → Run `retinue migrate`" against
     * a database nobody could reach. That is a diagnostic sending an operator to fix the wrong thing, which is
     * worse than reporting nothing.
     */
    let reachable = false;
    try {
      sql = await withTimeout("postgres", connectPostgres(config.databaseUrl));
      await withTimeout("postgres", sql.query("select 1"));
      reachable = true;
      results.push({ name: "postgres", ok: true, detail: `reachable at ${describeUrl(config.databaseUrl)}` });
    } catch (error) {
      results.push({
        name: "postgres",
        ok: false,
        detail: failureDetail(config.databaseUrl, error),
        remedy: "Check the database is running and RETINUE_DATABASE_URL points at it.",
      });
    }
    if (reachable && sql !== undefined && deps.schemaVersions !== undefined) {
      try {
        const { current, target } = await withTimeout("schema", deps.schemaVersions(sql));
        // Ahead is reported as a failure, not a pass: a database migrated by a newer build than this one is a
        // deployment about to behave unpredictably, and "current >= target" would call it healthy.
        const ok = current === target;
        results.push({
          name: "schema",
          ok,
          detail: `${current} of ${target} migrations applied`,
          ...(ok
            ? {}
            : {
                remedy:
                  current < target
                    ? "Run `retinue migrate`."
                    : "This database is ahead of this build. Deploy the matching version rather than migrating down.",
              }),
        });
      } catch (error) {
        results.push({
          name: "schema",
          ok: false,
          detail: message(error),
          remedy: "Run `retinue migrate --status` for detail.",
        });
      }
    } else if (reachable) {
      results.push({ name: "schema", ok: true, skipped: true, detail: "no schema reader supplied" });
    } else {
      results.push({
        name: "schema",
        ok: true,
        skipped: true,
        detail: "not checked — Postgres is unreachable, so this would fail for the same reason",
      });
    }
    if (sql !== undefined) await sql.end().catch(() => undefined);
  }

  // 5. Redis.
  if (deps.connectRedis === undefined) {
    results.push({ name: "redis", ok: true, skipped: true, detail: "no client supplied" });
  } else {
    let redis: Awaited<ReturnType<NonNullable<DoctorDeps["connectRedis"]>>> | undefined;
    try {
      redis = await withTimeout("redis", deps.connectRedis(config.redisUrl));
      const pong = await withTimeout("redis", redis.ping());
      results.push({ name: "redis", ok: true, detail: `reachable at ${describeUrl(config.redisUrl)} (${pong})` });
    } catch (error) {
      results.push({
        name: "redis",
        ok: false,
        detail: failureDetail(config.redisUrl, error),
        remedy: "Check Redis is running and RETINUE_REDIS_URL points at it.",
      });
    } finally {
      // Always, including after a failure. Leaving a client open kept the socket handle alive and the command
      // never exited — a diagnostic that reports correctly and then hangs is still a diagnostic that hangs.
      if (redis !== undefined) await redis.quit().catch(() => undefined);
    }
  }

  return results;
};

/** Human output. Returns the exit code, so the caller does not decide what a failure means. */
export const report = (results: readonly CheckResult[], write: (line: string) => void = console.log): number => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const mark = !r.ok ? "✗" : r.skipped === true ? "–" : "✓";
    write(`${mark} ${r.name}: ${r.detail}`);
    if (r.remedy !== undefined) write(`    → ${r.remedy}`);
  }
  write("");
  write(
    failed.length === 0
      ? `✓ ${results.filter((r) => r.skipped !== true).length} check(s) passed`
      : `✗ ${failed.length} of ${results.length} check(s) failed`,
  );
  return failed.length === 0 ? 0 : 1;
};
