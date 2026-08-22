/**
 * Production `SqlExecutor` backed by node-postgres. `pg` is imported type-only here — the caller
 * supplies the `Pool` — so the package has no runtime coupling to a specific driver instance.
 */
import type { Pool } from "pg";
import type { SqlExecutor } from "./sql.js";
import type { ConnectionOpener } from "./transaction.js";

export const createPgExecutor = (pool: Pool): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return pool.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/**
 * Checks out one connection for the duration of `fn` — the primitive `createPgExecutor` cannot
 * provide, because `pool.query` picks a different connection per call, so `BEGIN` / work / `COMMIT`
 * through it would land on three connections and guarantee nothing (#98).
 *
 * `searchPath` exists for the conformance suite, which isolates each executor in its own schema. A
 * pooled connection carries whatever `search_path` its last user left, so it has to be set per
 * checkout rather than once at pool creation.
 */
export const createPoolOpener = (pool: Pool, searchPath?: string): ConnectionOpener => {
  return async <T>(fn: (sql: SqlExecutor) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      if (searchPath) await client.query(`SET search_path TO ${searchPath}`);
      return await fn({
        query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
          return client.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
        },
      });
    } finally {
      client.release();
    }
  };
};
