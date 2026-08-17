/**
 * Production `SqlExecutor` backed by node-postgres. `pg` is imported type-only here — the caller
 * supplies the `Pool` — so the package has no runtime coupling to a specific driver instance.
 */
import type { Pool } from "pg";
import type { SqlExecutor } from "./sql.js";

export const createPgExecutor = (pool: Pool): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return pool.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});
