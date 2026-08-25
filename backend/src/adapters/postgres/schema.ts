/**
 * Automatic schema provisioning — `docs/02-core-and-persistence.md`.
 *
 * A `SchemaManager` over the reversible migrations: it provisions a fresh database on startup
 * (`auto`), logs the diff and refuses (`plan`), or leaves the schema to managed migrations
 * (`off`, the default for Postgres). Forward-only and idempotent — running it twice is a no-op,
 * so concurrent workers never double-provision.
 */
import { MIGRATION_LEDGER, MIGRATIONS, appliedMigrationIds, type Migration } from "./migrations.js";
import type { SqlExecutor } from "./sql.js";

export type SchemaMode = "auto" | "plan" | "off";

export type SchemaChange = {
  readonly id: string;
  readonly statements: readonly string[];
};

export interface SchemaManager {
  currentVersion(): Promise<number>;
  targetVersion(): number;
  /** Pending changes — no side effects. */
  plan(): Promise<readonly SchemaChange[]>;
  /** Create/upgrade to the target version. Idempotent. */
  apply(): Promise<void>;
}

export const createSchemaManager = (
  sql: SqlExecutor,
  migrations: readonly Migration[] = MIGRATIONS,
): SchemaManager => {
  // Read-only: if the tracking table doesn't exist yet, nothing has been applied. `plan()` and
  // `currentVersion()` therefore have no side effects; only `apply()` creates the table.
  // Intersected with this manager's own list, not counted raw: the ledger is shared with migrations
  // this manager does not own -- the vector ones -- and a raw count would report a version *above*
  // the target on a database that has them, which reads as "schema ahead" rather than "ready".
  const appliedIds = async (): Promise<Set<string>> => {
    const known = new Set(migrations.map((m) => m.id));
    return new Set([...(await appliedMigrationIds(sql))].filter((id) => known.has(id)));
  };
  const pending = async (): Promise<Migration[]> => {
    const done = await appliedIds();
    return migrations.filter((m) => !done.has(m.id));
  };

  return {
    async currentVersion() {
      return (await appliedIds()).size;
    },
    targetVersion() {
      return migrations.length;
    },
    async plan() {
      return (await pending()).map((m) => ({ id: m.id, statements: m.up }));
    },
    async apply() {
      await sql.query(MIGRATION_LEDGER);
      for (const m of await pending()) {
        for (const stmt of m.up) await sql.query(stmt);
        // ON CONFLICT DO NOTHING: two workers applying the same migration can't both record it.
        await sql.query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [m.id]);
      }
    },
  };
};

export type ProvisionResult = {
  readonly mode: SchemaMode;
  readonly applied: readonly string[];
  readonly planned: readonly SchemaChange[];
};

/**
 * Startup provisioning per mode. `off` (Postgres default) leaves the schema to managed
 * migrations; `plan` logs the pending diff and applies nothing; `auto` provisions.
 */
export const provisionSchema = async (
  sql: SqlExecutor,
  options: { readonly mode?: SchemaMode; readonly log?: (message: string) => void; readonly migrations?: readonly Migration[] } = {},
): Promise<ProvisionResult> => {
  const mode: SchemaMode = options.mode ?? "off";
  const manager = createSchemaManager(sql, options.migrations);
  const log = options.log ?? (() => {});

  if (mode === "off") {
    return { mode, applied: [], planned: [] };
  }

  const planned = await manager.plan();

  if (mode === "plan") {
    if (planned.length === 0) log("schema is up to date; no changes to apply");
    else log(`schema plan — ${planned.length} pending migration(s): ${planned.map((c) => c.id).join(", ")}`);
    return { mode, applied: [], planned };
  }

  // auto
  await manager.apply();
  if (planned.length) log(`provisioned schema: applied ${planned.map((c) => c.id).join(", ")}`);
  return { mode, applied: planned.map((c) => c.id), planned };
};
