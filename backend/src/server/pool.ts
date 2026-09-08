/**
 * The one place a `pg.Pool` is built for this host — REQ-041 (#190).
 *
 * There were four: `bin.ts` for `migrate`/`doctor`, `cli.ts` for the API host, `cli-worker.ts` for the
 * worker, and the driver `doctor` is handed. Four copies of "how this deployment connects" is three
 * copies too many, and the one that drifts is the one nobody exercises — the worker, whose writes are
 * the ones that must land in the same schema as everything else.
 *
 * **What it adds over `new Pool`.** `RETINUE_DATABASE_SCHEMA` names the schema the platform's tables
 * live in, and honouring it takes three things:
 *
 *  - `options: "-c search_path=…"`, a **startup parameter**, so every connection has it before it runs
 *    a single statement. This matters because `createPgExecutor` runs each query through `pool.query`,
 *    which takes a different connection per call and hands back one carrying whatever `search_path` its
 *    last borrower left.
 *
 *    The first version of this did it with `pool.on("connect", (c) => c.query("SET search_path …"))`,
 *    node-postgres's documented idiom for session state. It worked, and pg deprecated it while this was
 *    being written: *"Calling client.query() when the client is already executing a query is deprecated
 *    and will be removed in pg@9.0"* — printed on every boot. A startup parameter needs no query at
 *    all, so the ordering question disappears rather than being answered.
 *
 *    Verified against a real pooler before relying on it: Supabase's Supavisor forwards `options`
 *    on the session port, both in the config and in the URL's query string. That was the open
 *    question, since PgBouncer historically rejects unknown startup parameters.
 *  - `assertSearchPath`, one query at startup, because the mechanism above is the kind that fails
 *    silently. A pooler that swallowed `options` would leave every connection on the default path and
 *    every write in the wrong schema, with nothing to see. One round-trip turns that into a refusal.
 *  - `createPoolOpener(pool, …)` sets it per checkout as well, which is what the transaction scope
 *    uses. Belt and braces, deliberately: the opener is the path that holds `SELECT … FOR UPDATE`
 *    across statements, and it is worth its own guarantee.
 *
 * **`public` stays on the path** after the named schema. Two things need it: the `vector` type is
 * pinned to `public` so it resolves from any schema (see the note in `migrations.ts`), and ShareFlow's
 * adapters qualify all 70 of their queries as `public.`, which is what lets one pool serve a platform
 * schema and a product schema at once.
 */

import type { Pool } from "pg";

import type { SqlExecutor } from "../adapters/postgres/sql.js";
import type { ConnectionOpener } from "../adapters/postgres/transaction.js";

export type PostgresConnection = {
  readonly sql: SqlExecutor;
  readonly open: ConnectionOpener;
  readonly end: () => Promise<void>;
};

export type PoolSettings = {
  readonly databaseUrl: string;
  readonly databaseSchema?: string;
  /** Left unset by the host and the worker, which is node-postgres's default of no timeout. */
  readonly connectionTimeoutMillis?: number;
};

/**
 * The `search_path` for a named schema, or `undefined` to leave the connection's own.
 *
 * Exported because it is the only string in this file that ends up in SQL, and a test that pins it is
 * cheaper than reading two call sites to find out what a deployment actually gets.
 */
export const searchPathFor = (schema: string | undefined): string | undefined =>
  // **No space after the comma**, and that is not a style choice. This string is passed as libpq's
  // `-c search_path=…`, where a space separates one option from the next: `-c search_path=retinue,
  // public` reaches Postgres as `search_path` = `retinue,` and a stray `public`, and the server
  // refuses it outright — `invalid value for parameter "search_path": "retinue,"`. Found by running
  // `migrate` against a real database, not by reading the code. `SET search_path TO retinue,public` is
  // equally valid, so one representation serves both uses.
  schema === undefined || schema === "" ? undefined : `${schema},public`;

/**
 * One query, to prove the startup parameter actually took effect.
 *
 * Without it the mechanism is silent when it fails. A pooler that dropped `options` — PgBouncer
 * rejects unknown startup parameters by default, and a managed pooler can change behaviour under you —
 * would leave every connection on the default `search_path`, and every table the platform creates
 * would land in whatever schema comes first there. No error, no log line, and the symptom is two
 * projects quietly sharing a namespace.
 *
 * Compared as a set rather than as a string: Postgres echoes what it was given, and `retinue, public`
 * is the same path as `retinue,public` while being a different string.
 */
export const assertSearchPath = async (pool: Pool, expected: string): Promise<void> => {
  const normalise = (value: string) =>
    value
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, ""))
      .filter((part) => part !== "");
  const rows = await pool.query<{ readonly search_path: string }>("show search_path");
  const actual = normalise(rows.rows[0]?.search_path ?? "");
  const wanted = normalise(expected);
  const matches = wanted.length === actual.length && wanted.every((part, index) => part === actual[index]);
  if (!matches) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `RETINUE_DATABASE_SCHEMA asked for search_path "${expected}" but this connection reports ` +
        `"${rows.rows[0]?.search_path ?? "(nothing)"}". The connection options were not applied — a ` +
        `pooler in front of Postgres may be dropping them. Refusing to start, because every table this ` +
        `process creates would otherwise land in the wrong schema with no error.`,
    );
  }
};

export const openPostgres = async (settings: PoolSettings): Promise<PostgresConnection> => {
  const { Pool } = await import("pg");
  const { createPgExecutor, createPoolOpener } = await import("../entries/adapters-postgres.js");

  const searchPath = searchPathFor(settings.databaseSchema);
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    // The startup parameter, applied by the server before the connection is usable. `-c key=value` is
    // libpq's form and node-postgres passes it straight through.
    ...(searchPath === undefined ? {} : { options: `-c search_path=${searchPath}` }),
    ...(settings.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: settings.connectionTimeoutMillis }),
  });

  if (searchPath !== undefined) await assertSearchPath(pool as unknown as Pool, searchPath);

  return {
    sql: createPgExecutor(pool as unknown as Pool),
    open: createPoolOpener(pool as unknown as Pool, searchPath),
    end: () => pool.end(),
  };
};
