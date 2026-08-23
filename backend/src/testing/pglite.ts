/**
 * A shared PGlite instance with a fresh schema per caller.
 *
 * **Why.** Every test used to boot its own embedded Postgres, and boot is essentially the entire cost:
 * measured on this machine, `new PGlite()` plus a first query is **432ms warm**, while running all
 * eleven migrations is **20ms** — and creating a second schema and migrating into it inside an
 * already-booted instance is also **20ms**. Boot dominates by more than twenty to one.
 *
 * The conformance entrypoints call their store factory once per test case, so between them they were
 * booting roughly 250 embedded databases per run. That is the largest single cost in CI, and it grew
 * with every port added — the `build` job roughly tripled over #98–#111.
 *
 * **Isolation is by schema, not by instance.** Each caller gets `CREATE SCHEMA` and an executor that
 * sets `search_path` on every query, because the connection is shared and another caller's schema may
 * be current by the time a query runs. Two in-process round trips instead of one is nothing next to a
 * 432ms boot.
 *
 * **What this does not isolate**, and the reason some test files deliberately keep their own instance:
 * connection-level state. Roles (`CREATE ROLE app_user`), `SET ROLE`, and session GUCs are properties
 * of the connection, not the schema — so a file that creates a role per test would collide on the
 * second one. The row-level-security tests are exactly that shape and are left alone on purpose.
 *
 * Also note: `information_schema` queries must filter on `table_schema = current_schema()` here. With
 * one schema per instance an unqualified `WHERE table_name = 'runs'` matched one row; with many schemas
 * in one instance it matches one per schema.
 */
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../adapters/postgres/migrations.js";
import type { SqlExecutor } from "../adapters/postgres/sql.js";

/**
 * One instance per module, which under vitest means one per test file — files run in separate workers,
 * so this is not shared across them.
 */
let shared: PGlite | null = null;
let schemas = 0;

const instance = (): PGlite => (shared ??= new PGlite());

/**
 * An executor pinned to `schema`.
 *
 * `search_path` is set per query rather than once, because the connection is shared: between two
 * queries from this executor, another caller's executor may have pointed the path at its own schema.
 * Setting it once at creation would make every test's isolation depend on execution order.
 *
 * `public` is deliberately **absent** from the path. With it present, `CREATE TABLE IF NOT EXISTS`
 * would see a table of the same name in `public` and skip creating it here — so a stray table in
 * `public` would silently make every later schema share it.
 */
export const schemaExecutor = (db: PGlite, schema: string): SqlExecutor => ({
  async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    await db.exec(`SET search_path TO ${schema}`);
    const result = await db.query(text, params ? [...params] : undefined);
    return result.rows as Row[];
  },
});

export type PgliteSchema = {
  readonly sql: SqlExecutor;
  readonly db: PGlite;
  readonly schema: string;
};

/** A migrated, isolated schema on the shared instance. Lazily boots the instance on first use. */
export const freshPgliteSchema = async (): Promise<PgliteSchema> => {
  const db = instance();
  const schema = `s${(schemas += 1)}`;
  await db.exec(`CREATE SCHEMA ${schema}`);
  const sql = schemaExecutor(db, schema);
  await migrate(sql);
  return { sql, db, schema };
};

/**
 * A migrated schema, created lazily on first query so a caller can build stores synchronously.
 *
 * The conformance harnesses call their factory inside each test and expect a usable executor back
 * immediately, so the work has to be deferred to the first query rather than done up front.
 */
export const lazyPgliteSchema = (): SqlExecutor => {
  let ready: Promise<SqlExecutor> | null = null;
  const init = () => (ready ??= freshPgliteSchema().then((created) => created.sql));
  return {
    async query(text, params) {
      return (await init()).query(text, params);
    },
  };
};
