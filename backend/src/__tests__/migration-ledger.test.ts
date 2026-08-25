/**
 * The two provisioning paths must agree on what has been applied.
 *
 * `SchemaManager.apply()` wrote an applied-migrations ledger and `/readyz`'s schema probe read it.
 * `migrate()` -- the exported function the example's `npm run migrate` and every consumer's own
 * migration step call -- executed the same statements and recorded nothing. So a database provisioned
 * with `migrate()` had every table and an empty ledger, `currentVersion()` returned 0 against a target
 * of 25, and `/readyz` answered 503 forever: a fully migrated deployment that never accepted traffic.
 *
 * Found by running the built image against a real database, which is the only place the two paths meet.
 * The suite could not have caught it: every test either migrates and never asks the probe, or drives the
 * manager and never calls `migrate()`.
 */

import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, rollback } from "../adapters/postgres/index.js";
import { createSchemaManager } from "../adapters/postgres/schema.js";
import { freshPgliteSchema } from "../testing/pglite.js";
import type { SqlExecutor } from "../adapters/postgres/sql.js";

const ledger = (sql: SqlExecutor) => sql.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);

describe("the migration ledger", () => {
  it("records every migration that migrate() applies", async () => {
    const { sql } = await freshPgliteSchema(); // already migrated once
    const rows = await ledger(sql);
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("leaves the readiness probe reporting the target version -- the actual regression", async () => {
    const { sql } = await freshPgliteSchema();
    const manager = createSchemaManager(sql);
    expect(await manager.currentVersion()).toBe(manager.targetVersion());
    expect(await manager.plan()).toEqual([]);
  });

  it("heals a schema migrated before the ledger existed", async () => {
    const { sql } = await freshPgliteSchema();
    // Exactly the state of a deployment provisioned by the old migrate(): every table, no ledger.
    await sql.query(`DROP TABLE schema_migrations`);
    const manager = createSchemaManager(sql);
    expect(await manager.currentVersion()).toBe(0);

    await migrate(sql);

    expect(await manager.currentVersion()).toBe(manager.targetVersion());
  });

  it("does not re-execute a migration already in the ledger", async () => {
    const { sql } = await freshPgliteSchema();
    const executed: string[] = [];
    const counting: SqlExecutor = {
      query: async (text, params) => {
        executed.push(text);
        return sql.query(text, params);
      },
    };

    await migrate(counting);

    // The ledger DDL and the read, plus nothing else. A migration statement here means the skip is
    // not working and re-runnability is load-bearing again rather than a safety net.
    const migrationStatements = new Set(MIGRATIONS.flatMap((m) => m.up));
    expect(executed.filter((t) => migrationStatements.has(t))).toEqual([]);
  });

  it("counts only its own migrations, so a shared ledger cannot report a version above target", async () => {
    const { sql } = await freshPgliteSchema();
    // The vector migrations live in the same table and are not this manager's to count. Without the
    // intersection this reads as version 26 of 25 -- "ahead", which no operator can act on.
    await sql.query(`INSERT INTO schema_migrations (id) VALUES ('0017_knowledge_chunks')`);
    const manager = createSchemaManager(sql);
    expect(await manager.currentVersion()).toBe(manager.targetVersion());
  });

  it("forgets each migration as its down step runs", async () => {
    const { sql } = await freshPgliteSchema();
    // Asserted before as well as after: an empty-to-empty comparison passes whether or not rollback
    // touches the ledger, and did -- this test survived a sabotage of migrate() that left it empty.
    expect((await ledger(sql)).length).toBe(MIGRATIONS.length);

    await rollback(sql);

    expect(await ledger(sql)).toEqual([]);
  });
});
