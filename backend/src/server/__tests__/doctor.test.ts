/**
 * `retinue doctor` — REQ-060 (#251), task #252 AC-4 and AC-5.
 *
 * The value is entirely in reporting *every* failure. A doctor that stops at the first problem sends the
 * operator round the loop once per problem, which is what starting the server already does — so it would add
 * nothing. These tests hold that property, and the two that matter most are the ones about *not* misleading:
 * a check that could not run must not report as a pass, and a check downstream of a failure must not send
 * someone to fix the wrong thing.
 */
import { describe, expect, it } from "vitest";
import { CHECK_TIMEOUT_MS, describeUrl, report, runChecks, scrub, withTimeout } from "../doctor.js";

const ENV = {
  RETINUE_DATABASE_URL: "postgres://user:pw@db.internal:5432/app",
  RETINUE_REDIS_URL: "redis://:secret@cache.internal:6379/0",
};

const workingPostgres = () => async () => ({
  async query() {
    return [];
  },
  async end() {},
});
const workingRedis = () => async () => ({ async ping() { return "PONG"; }, async quit() { return null; } });

describe("no check prints a credential", () => {
  it("reduces a connection string to host and database", () => {
    expect(describeUrl("postgres://user:pw@db.internal:5432/app")).toBe("postgres://db.internal:5432/app");
    expect(describeUrl("redis://:secret@cache.internal:6379/0")).toBe("redis://cache.internal:6379/0");
  });

  it("does not echo a value it cannot parse", () => {
    // Echoing an unparseable value is how a secret reaches a log — the failure mode is that the *malformed*
    // string is the one most likely to contain something unexpected.
    expect(describeUrl("not a url at all")).toMatch(/not printed/);
  });

  it("refuses an ambiguous authority rather than leaking half the password", () => {
    // Found by this test, and it was a real leak. `new URL("postgres://user:p@ss/word@db.internal:5432/app")`
    // parses `user:p` as userinfo and `ss` as the *hostname*, so the "safe" output was
    // `postgres://ss/word@db.internal:5432/app` — half the password, in the host and path. An unescaped `@` in a
    // password is common, so the only safe answer is not to print it.
    const described = describeUrl("postgres://user:p@ss/word@db.internal:5432/app");
    expect(described).not.toContain("ss/word");
    expect(described).toMatch(/not printed/);
  });

  it("scrubs a URL out of a driver's own error message", () => {
    // Drivers quote the connection string routinely, so scrubbing only the values we print is not enough.
    const scrubbed = scrub("connect ECONNREFUSED for postgres://user:pw@db.internal:5432/app");
    expect(scrubbed).not.toContain("pw");
    expect(scrubbed).toContain("db.internal:5432/app");
  });

  it("refuses to print a URL embedded in prose that it cannot match cleanly", () => {
    // The scrubber hands each URL-shaped run to `describeUrl`, so a trailing quote or bracket that would make
    // the shape ambiguous produces a refusal rather than a partial print.
    expect(scrub("failed: postgres://u:p@ss@host/db please check")).not.toContain("p@ss");
  });

  it("keeps the secret out of a full failing report", async () => {
    const results = await runChecks({
      env: ENV,
      connectPostgres: async () => {
        throw new Error("connect ECONNREFUSED postgres://user:pw@db.internal:5432/app");
      },
      connectRedis: async () => {
        throw new Error("auth failed for redis://:secret@cache.internal:6379/0");
      },
    });
    const lines: string[] = [];
    report(results, (l) => lines.push(l));
    const output = lines.join("\n");
    expect(output).not.toContain("pw@");
    expect(output).not.toContain("secret@");
  });
});

describe("every failure, not the first", () => {
  it("reports both a broken database and a broken cache", async () => {
    const results = await runChecks({
      env: ENV,
      connectPostgres: async () => {
        throw new Error("no route to host");
      },
      connectRedis: async () => {
        throw new Error("connection refused");
      },
    });
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    expect(failed).toContain("postgres");
    expect(failed).toContain("redis");
  });

  it("gives every failure a remedy", async () => {
    const results = await runChecks({
      env: ENV,
      connectPostgres: async () => {
        throw new Error("nope");
      },
      connectRedis: async () => {
        throw new Error("nope");
      },
    });
    for (const failure of results.filter((r) => !r.ok)) {
      expect(failure.remedy, `${failure.name} has no remedy`).toBeTruthy();
    }
  });

  it("exits non-zero on any failure and zero on none", async () => {
    const bad = await runChecks({ env: ENV, connectPostgres: async () => { throw new Error("x"); } });
    expect(report(bad, () => {})).toBe(1);
    const good = await runChecks({
      env: ENV,
      connectPostgres: workingPostgres(),
      connectRedis: workingRedis(),
      schemaVersions: async () => ({ current: 30, target: 30 }),
    });
    expect(report(good, () => {})).toBe(0);
  });
});

describe("a check that could not run is not a pass", () => {
  it("skips the schema check when Postgres is unreachable, rather than blaming migrations", async () => {
    // The bug this caught: `new Pool()` does not connect, so the pool object exists even when the database is
    // unreachable. Keying the schema check on that reported "0 of 30 applied → Run `retinue migrate`" against a
    // database nobody could reach — sending an operator to fix the wrong thing.
    const results = await runChecks({
      env: ENV,
      connectPostgres: async () => {
        throw new Error("ECONNREFUSED");
      },
      schemaVersions: async () => ({ current: 0, target: 30 }),
    });
    const schema = results.find((r) => r.name === "schema");
    expect(schema?.skipped).toBe(true);
    expect(schema?.detail).toMatch(/unreachable/);
  });

  it("skips everything downstream when configuration is unusable", async () => {
    const results = await runChecks({ env: {} });
    expect(results.find((r) => r.name === "configuration")?.ok).toBe(false);
    for (const name of ["postgres", "schema", "redis"]) {
      expect(results.find((r) => r.name === name)?.skipped, name).toBe(true);
    }
  });

  it("marks a skip distinctly in the output and does not count it as a pass", async () => {
    const results = await runChecks({ env: ENV });
    const lines: string[] = [];
    report(results, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/^– /m);
  });
});

describe("the schema check", () => {
  it("passes only when current equals target", async () => {
    const at = async (current: number) =>
      (
        await runChecks({
          env: ENV,
          connectPostgres: workingPostgres(),
          schemaVersions: async () => ({ current, target: 30 }),
        })
      ).find((r) => r.name === "schema");
    expect((await at(30))?.ok).toBe(true);
    expect((await at(29))?.ok).toBe(false);
    // Ahead is a failure too: a database migrated by a newer build is about to behave unpredictably, and
    // `current >= target` would call that healthy.
    const ahead = await at(31);
    expect(ahead?.ok).toBe(false);
    expect(ahead?.remedy).toMatch(/ahead of this build/);
  });
});

describe("no check can hang the tool", () => {
  it("times out rather than waiting for ever", async () => {
    // Found by running `doctor` against a refused port: `pg.Pool` has no default connect timeout and `ioredis`
    // retries a refused connection for ever, so the command sat silently instead of reporting the two failures
    // it existed to report. A diagnostic that hangs is worse than one that fails.
    await expect(withTimeout("thing", new Promise(() => {}), 20)).rejects.toThrow(/did not respond within 20ms/);
  });

  it("returns the value when the work finishes in time", async () => {
    expect(await withTimeout("thing", Promise.resolve(7), CHECK_TIMEOUT_MS)).toBe(7);
  });

  it("turns a hanging driver into a reported failure", async () => {
    const results = await runChecks({
      env: ENV,
      connectPostgres: () => new Promise(() => {}) as never,
      connectRedis: () => new Promise(() => {}) as never,
    });
    // Not a hang, and not a pass: two named failures.
    expect(results.filter((r) => !r.ok).map((r) => r.name).sort()).toEqual(["postgres", "redis"]);
  }, 30_000);
});

describe("an error derived from an unprintable value is also withheld", () => {
  it("does not pass the driver's message through when the URL could not be printed", async () => {
    // A driver interpolates whatever *it* parsed: `postgres://u:p@ss/word@host/db` fails with
    // `getaddrinfo ENOTFOUND ss` — a fragment of the password, in a message no scrubber can recognise as one
    // because `ss` is not URL-shaped. So if the value cannot be printed, nothing derived from it can be.
    const results = await runChecks({
      env: { RETINUE_DATABASE_URL: "postgres://u:p@ss/word@host:5432/db", RETINUE_REDIS_URL: "redis://c:6379/0" },
      connectPostgres: async () => {
        throw new Error("getaddrinfo ENOTFOUND ss");
      },
    });
    const postgres = results.find((r) => r.name === "postgres");
    expect(postgres?.ok).toBe(false);
    // Asserting on the driver's text, not the substring "ss" — which appears innocently inside "message".
    expect(postgres?.detail).not.toContain("ENOTFOUND");
    expect(postgres?.detail).toMatch(/withheld/);
    // The remedy still names the variable, which is what the operator actually needs.
    expect(postgres?.remedy).toContain("RETINUE_DATABASE_URL");
  });

  it("still passes the driver's message through when the URL is safe", async () => {
    const results = await runChecks({
      env: { RETINUE_DATABASE_URL: "postgres://user:pw@db:5432/app", RETINUE_REDIS_URL: "redis://c:6379/0" },
      connectPostgres: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(results.find((r) => r.name === "postgres")?.detail).toContain("ECONNREFUSED");
  });
});
