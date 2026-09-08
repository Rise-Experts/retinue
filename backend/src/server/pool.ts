/**
 * The one place a `pg.Pool` is built for this host — REQ-041 (#190).
 *
 * There were four: `bin.ts` for `migrate`/`doctor`, `cli.ts` for the API host, `cli-worker.ts` for the
 * worker, and the driver `doctor` is handed. Four copies of "how this deployment connects" is three
 * copies too many, and the one that drifts is the one nobody exercises — the worker, whose writes are
 * the ones that must land in the same schema as everything else.
 *
 * **What it adds over `new Pool`.** `RETINUE_DATABASE_SCHEMA` names the schema the platform's tables
 * live in, and honouring it takes two things that must agree:
 *
 *  - `pool.on("connect")` sets `search_path` on **every** connection, because `createPgExecutor` runs
 *    each query through `pool.query`, which takes a different connection per call. A pooled connection
 *    carries whatever `search_path` its last user left, so setting it once at startup means the first
 *    few statements land in the right schema and the rest land wherever. That failure is not loud: it
 *    is a table created in `public` by a migration that reported success.
 *  - `createPoolOpener(pool, …)` sets it again per checkout, which is what the transaction scope uses.
 *    Redundant on paper and deliberately kept: the opener is the path that holds `SELECT … FOR UPDATE`
 *    across statements, and it must not depend on a listener having fired.
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
  schema === undefined || schema === "" ? undefined : `${schema}, public`;

export const openPostgres = async (settings: PoolSettings): Promise<PostgresConnection> => {
  const { Pool } = await import("pg");
  const { createPgExecutor, createPoolOpener } = await import("../entries/adapters-postgres.js");

  const searchPath = searchPathFor(settings.databaseSchema);
  const pool = new Pool({
    connectionString: settings.databaseUrl,
    ...(settings.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: settings.connectionTimeoutMillis }),
  });

  if (searchPath !== undefined) {
    /**
     * Queued on the client, not awaited — which is what makes it correct rather than racy.
     *
     * node-postgres queues queries per client in order, so this `SET` is ahead of whatever the borrower
     * runs next on that same connection. An `await` here would have nothing to attach to: `connect` is
     * an event, and the pool hands the client out regardless of what a listener is still doing.
     *
     * A failure is surfaced rather than swallowed, and it is worth being precise about what it can and
     * cannot catch. It means the role may not *use* the schema. It does **not** mean the schema is
     * missing: `SET search_path TO retinue, public` succeeds when `retinue` does not exist, because a
     * missing entry is skipped rather than rejected, and every write then lands in `public` with no
     * error anywhere. Nothing at this layer can see that — which is why `retinue migrate` creates the
     * schema before anything connects, and why this listener is not the guard against it.
     */
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${searchPath}`).catch((error: unknown) => {
        (client as unknown as { end: () => void }).end();
        pool.emit(
          "error",
          error instanceof Error
            ? new Error(`could not SET search_path TO ${searchPath}: ${error.message}`, { cause: error })
            : new Error(`could not SET search_path TO ${searchPath}`),
          client,
        );
      });
    });
  }

  return {
    sql: createPgExecutor(pool as unknown as Pool),
    open: createPoolOpener(pool as unknown as Pool, searchPath),
    end: () => pool.end(),
  };
};
