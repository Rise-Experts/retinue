/**
 * `retinue migrate` provisions the schema it was told to use — REQ-041 (#190).
 *
 * Against a real Postgres (PGlite), because the whole point is what the database does: `CREATE SCHEMA
 * IF NOT EXISTS` twice, `pg_namespace` answering honestly, and an identifier reaching SQL by
 * concatenation rather than a placeholder.
 *
 * The failure without this is clear in the logs and baffling in practice. `pool.ts` sets `search_path`
 * on every connection and destroys any connection where that fails, so a missing schema shows up as
 * *every query failing* rather than as the one sentence that explains why.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";

import { ensureSchema, isReadOnly, READ_ONLY_FLAGS } from "../bin.js";
import { loadConfig } from "../config.js";

/**
 * A real Postgres behind an injected connection.
 *
 * `end` counts calls rather than closing PGlite. The first version closed it, which is what a real
 * `end` does to its pool — and then every assertion after the call under test failed with "PGlite is
 * closed". The distinction is the point: `end` releases the *connection*, and the database outlives it.
 * That the release happens is asserted, since a `migrate` leaking a connection per run is exactly the
 * kind of thing nothing else here would notice.
 */
const db = () => {
  const pg = new PGlite();
  const queries: string[] = [];
  let ended = 0;
  return {
    queries,
    ended: () => ended,
    close: () => pg.close(),
    connect: async () => ({
      sql: {
        async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
          queries.push(text);
          const result = await pg.query(text, params === undefined ? undefined : [...params]);
          return result.rows as Row[];
        },
      },
      end: async () => {
        ended += 1;
      },
    }),
    exists: async (name: string) =>
      ((await pg.query(`select 1 from pg_namespace where nspname = $1`, [name])).rows as unknown[]).length === 1,
  };
};

describe("ensureSchema", () => {
  it("creates the schema, releases the connection, and is safe to run again", async () => {
    const { connect, exists, ended, close } = db();
    // Twice: `migrate` runs on every deploy, so the second run is the normal case, not the edge one.
    expect(await ensureSchema({ databaseUrl: "x", databaseSchema: "retinue" }, { create: true, connect })).toBe(true);
    expect(await ensureSchema({ databaseUrl: "x", databaseSchema: "retinue" }, { create: true, connect })).toBe(true);
    expect(await exists("retinue")).toBe(true);
    expect(ended()).toBe(2);
    await close();
  });

  it("does nothing at all when no schema is configured", async () => {
    /**
     * The deployment that owns its whole database. It must not acquire a schema it did not ask for, and
     * must not even open a connection to find that out — `migrate` on a URL with no schema configured
     * behaved this way before this code existed and has to keep behaving that way.
     */
    const { connect, queries } = db();
    const spy = vi.fn(connect);
    expect(await ensureSchema({ databaseUrl: "x" }, { create: true, connect: spy })).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it("reports a missing schema on the read-only paths instead of creating one", async () => {
    /**
     * `--status` and `--dry-run` are documented as side-effect free: the note in `bin.ts` says `public`
     * has 0 tables after a dry run against a fresh database. A reader deciding whether to trust a dry
     * run is exactly the reader who must not discover it provisioned a schema — a small side effect and
     * a large broken promise. So this path answers the question and changes nothing.
     */
    const { connect, exists, queries, close } = db();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await ensureSchema({ databaseUrl: "x", databaseSchema: "retinue" }, { create: false, connect })).toBe(false);
    expect(await exists("retinue")).toBe(false);
    expect(queries.some((q) => /create schema/i.test(q))).toBe(false);
    expect(error.mock.calls[0]?.[0]).toMatch(/does not exist/);
    error.mockRestore();
    await close();
  });

  it("confirms an existing schema on the read-only paths", async () => {
    const { connect, exists, close } = db();
    await ensureSchema({ databaseUrl: "x", databaseSchema: "retinue" }, { create: true, connect });
    expect(await exists("retinue")).toBe(true);
    expect(await ensureSchema({ databaseUrl: "x", databaseSchema: "retinue" }, { create: false, connect })).toBe(true);
    await close();
  });
});

describe("the schema name, before it ever reaches SQL", () => {
  const base = { RETINUE_DATABASE_URL: "postgres://u:p@h:5432/d", RETINUE_REDIS_URL: "redis://h:6379" };

  it("refuses anything Postgres would need quoted", () => {
    /**
     * **The one config value where a lax check is a SQL injection.** `SET search_path` and
     * `CREATE SCHEMA` take no parameters — neither is a value position, so there is no placeholder to
     * bind and the name is concatenated. Validating it at boot is what makes that concatenation safe,
     * and it is why the pattern is what Postgres accepts unquoted and nothing else.
     */
    for (const bad of [
      "retinue; drop schema public cascade",
      "public, retinue",
      'retinue" ; --',
      "1retinue",
      "retinue-prod",
      "retinue schema",
      "réтinue",
    ]) {
      expect(() => loadConfig({ ...base, RETINUE_DATABASE_SCHEMA: bad }), bad).toThrow(
        /must be an unquoted Postgres identifier/,
      );
    }
  });

  it("accepts what a real deployment would use", () => {
    for (const good of ["retinue", "retinue_prod", "_r", "r$1", "Retinue"]) {
      expect(loadConfig({ ...base, RETINUE_DATABASE_SCHEMA: good }).databaseSchema, good).toBe(good);
    }
  });

  it("treats blank as unset, so an empty variable in a compose file is not an error", () => {
    // `SCHEMA=${RETINUE_DATABASE_SCHEMA:-}` in a compose file expands to an empty string, which means
    // "not configured" and must not fail boot or produce `SET search_path TO , public`.
    expect(loadConfig({ ...base, RETINUE_DATABASE_SCHEMA: "" }).databaseSchema).toBeUndefined();
    expect(loadConfig({ ...base, RETINUE_DATABASE_SCHEMA: "   " }).databaseSchema).toBeUndefined();
  });
});

describe("which invocations must change nothing", () => {
  it("treats exactly the reporting flags as read-only", () => {
    /**
     * The link between a flag and a side effect, which a test of either end cannot see. Forcing this to
     * `false` — so `migrate --dry-run` provisions a schema — left every other assertion in this file
     * green, and `--dry-run` is documented as leaving a fresh database with 0 tables.
     */
    for (const flag of READ_ONLY_FLAGS) expect(isReadOnly(new Set([flag])), flag).toBe(true);
    expect(isReadOnly(new Set(["--dry-run", "--verbose"]))).toBe(true);
    expect(isReadOnly(new Set())).toBe(false);
    expect(isReadOnly(new Set(["--verbose"]))).toBe(false);
    // Not a prefix match: `--dry-run-please` is not a flag this command has, and treating it as one
    // would silently turn a typo into "changed nothing" while reporting success.
    expect(isReadOnly(new Set(["--dry-run-please"]))).toBe(false);
  });
});

describe("the one call site in `migrate`", () => {
  /**
   * A source assertion, because nothing else can reach it. `migrate` loads its config and opens its own
   * pool, so exercising it needs a live Postgres — and hardcoding `create: true` there (which is what a
   * hurried "just make the schema" edit looks like) turns `--dry-run` into a command that provisions,
   * while every behavioural test in this file stays green.
   *
   * The rule is narrow: whatever `migrate` passes for `create` must be derived from `isReadOnly`, not
   * written as a literal.
   */
  it("derives `create` from the flags rather than hardcoding it", () => {
    const bin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin.ts"), "utf8");
    const calls = [...bin.matchAll(/ensureSchema\(([^)]*)\)/g)].map((match) => match[1] ?? "");
    // The guard on the guard: if `ensureSchema` were renamed, an empty list would pass every assertion.
    expect(calls).toHaveLength(1);
    expect(calls[0], "pass `create: !isReadOnly(flags)` so a reporting flag cannot provision").toMatch(
      /create:\s*!isReadOnly\(/,
    );
  });
});
