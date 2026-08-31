/**
 * Automatic schema provisioning — `docs/02-core-and-persistence.md`.
 *
 * A `SchemaManager` over the reversible migrations: it provisions a fresh database on startup
 * (`auto`), logs the diff and refuses (`plan`), or leaves the schema to managed migrations
 * (`off`, the default for Postgres). Forward-only and idempotent — running it twice is a no-op.
 *
 * **Concurrent callers do not double-provision, and one of them may still fail.** Measured for #252: two
 * simultaneous `apply()` runs against one database leave the ledger correct (every migration recorded once,
 * `ON CONFLICT DO NOTHING` doing its job) and crash the loser with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` — Postgres's own type catalogue,
 * racing on DDL. The data is safe; the process is not, and the error names nothing an operator can act on.
 *
 * Both callers therefore take a **session advisory lock** on a single checked-out connection before applying:
 * `retinue migrate` since #252, and `auto` mode at startup since #266. The callers serialise instead of racing.
 *
 * ## How the lock reaches a manager written against `SqlExecutor` — #266, AC-2
 *
 * It does not. `SqlExecutor` has only `query`, and a `pg_advisory_lock` taken through a pool-backed executor
 * would be held by a connection nobody gets back — `pool.query` picks a different one per call, so the unlock
 * would land on a different session and the lock would leak until the process exited.
 *
 * So `provisionSchema` takes an **optional `ConnectionOpener`** and builds the manager over the locked
 * connection when it has one. Three options were weighed and this is why:
 *
 * - *Widen `SqlExecutor`* — rejected. Every adapter that will never need a session lock would have to answer
 *   for one, and PGlite genuinely cannot.
 * - *Lock in the host's boot path* — rejected as the primary mechanism, though `boot.ts` is where the opener
 *   comes from. It puts the correctness of provisioning in the caller, so every future host has to remember,
 *   and the one that forgets fails only under concurrency.
 * - *An optional opener here* — chosen. The knowledge stays with the thing being protected, a caller that has
 *   an opener is protected without asking, and a caller that has none behaves exactly as before.
 *
 * **A caller with no opener still works** (AC-3): PGlite and the in-memory paths are single-process, so there
 * is nothing to serialise, and requiring a lock they cannot provide would be a new dependency for the one case
 * that never needed it. The result reports which happened, so "unlocked" is visible rather than assumed.
 */
import { MIGRATION_LEDGER, MIGRATIONS, appliedMigrationIds, type Migration } from "./migrations.js";
import type { SqlExecutor } from "./sql.js";
import type { ConnectionOpener } from "./transaction.js";

export type SchemaMode = "auto" | "plan" | "off";

/**
 * The advisory-lock key migrations serialise on — #252, and #266's AC-4.
 *
 * **Exported and shared, rather than agreed.** The CLI defined this itself, which meant AC-4 — "the key matches
 * the CLI's, or the two do not serialise against each other" — was a property of two constants happening to be
 * equal. Two constants that must be equal are one constant; a copy that drifts produces two locks and no
 * serialisation, and the symptom is the original crash returning with the fix apparently in place.
 *
 * Arbitrary, and it has to be: Postgres advisory locks are a flat 64-bit namespace with no registry, so the
 * only protection against collision is picking something nobody else would. Derived from the ASCII of
 * "retinue" so it is reproducible rather than a magic number somebody will tidy up.
 */
export const MIGRATION_LOCK = 0x72_65_74_69_6e_75; // "retinu"

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
  /**
   * Whether the apply was serialised by an advisory lock — #266.
   *
   * Reported so "unlocked" is a visible fact rather than an assumption. `false` is correct and expected for a
   * single-process caller; on a pool-backed deployment it means the opener was not passed, which is the
   * configuration mistake this field exists to make findable.
   */
  readonly locked: boolean;
};

/**
 * Startup provisioning per mode. `off` (Postgres default) leaves the schema to managed
 * migrations; `plan` logs the pending diff and applies nothing; `auto` provisions.
 */
export const provisionSchema = async (
  sql: SqlExecutor,
  options: {
    readonly mode?: SchemaMode;
    readonly log?: (message: string) => void;
    readonly migrations?: readonly Migration[];
    /**
     * Opens one connection and holds it — the primitive an advisory lock needs, and the one `SqlExecutor`
     * deliberately does not have. See the header for why this is a parameter rather than a widened port.
     *
     * Optional: a single-process caller has nothing to serialise. Supplying it is what turns concurrent
     * `auto`-mode provisioning from "one worker crashes" into "one applies, the rest find nothing to do".
     */
    readonly open?: ConnectionOpener;
  } = {},
): Promise<ProvisionResult> => {
  const mode: SchemaMode = options.mode ?? "off";
  const log = options.log ?? (() => {});

  if (mode === "off") {
    return { mode, applied: [], planned: [], locked: false };
  }

  if (mode === "plan") {
    /**
     * Read-only, and takes **no lock** — the same decision `retinue migrate --dry-run` makes.
     *
     * `plan()` and `currentVersion()` are documented as side-effect free; only `apply()` creates the ledger.
     * Taking a lock here would serialise every booting worker behind a read that changes nothing, and a dry
     * run that waited on a migration lock would be a dry run with a production dependency.
     */
    const planned = await createSchemaManager(sql, options.migrations).plan();
    if (planned.length === 0) log("schema is up to date; no changes to apply");
    else log(`schema plan — ${planned.length} pending migration(s): ${planned.map((c) => c.id).join(", ")}`);
    return { mode, applied: [], planned, locked: false };
  }

  // auto
  if (options.open === undefined) {
    /**
     * No opener: apply directly, exactly as before.
     *
     * Correct for PGlite and the in-memory paths, which are single-process. On a pool-backed deployment with
     * several workers this is the path that produces the original crash, which is why `locked: false` is
     * reported rather than left to be inferred.
     */
    const manager = createSchemaManager(sql, options.migrations);
    const planned = await manager.plan();
    await manager.apply();
    if (planned.length) log(`provisioned schema: applied ${planned.map((c) => c.id).join(", ")}`);
    return { mode, applied: planned.map((c) => c.id), planned, locked: false };
  }

  return await options.open(async (locked) => {
    /**
     * The lock, the plan and the apply all on **one** connection.
     *
     * The plan has to be read inside the lock, not outside it: a plan computed before waiting on the lock is
     * a plan the winner has already invalidated, so the loser would apply migrations that are now recorded
     * and race on the DDL anyway. Reading it here is what makes the loser report "nothing to apply".
     */
    await locked.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      const manager = createSchemaManager(locked, options.migrations);
      const planned = await manager.plan();
      if (planned.length === 0) {
        log(`schema already at ${manager.targetVersion()}; nothing to apply`);
        return { mode, applied: [], planned, locked: true };
      }
      await manager.apply();
      log(`provisioned schema: applied ${planned.map((c) => c.id).join(", ")}`);
      return { mode, applied: planned.map((c) => c.id), planned, locked: true };
    } finally {
      // Released explicitly, and by the session ending if the process dies mid-migration — which is the
      // property that makes a crash during provisioning recoverable without an operator clearing a lock.
      await locked.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  });
};
