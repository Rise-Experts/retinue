/**
 * `migrate` must be safe to run twice — #182.
 *
 * There is no applied-migrations ledger: `migrate` walks the whole list and executes every statement, which
 * works only because every statement is written to be a no-op when its effect is already there. That invariant
 * was never asserted, and #181's `ALTER TABLE ... RENAME COLUMN` broke it — the migration succeeded once and
 * then failed on every subsequent run with `column "period" does not exist`. The example's `npm run migrate`
 * stopped working, and nothing in the suite noticed, because a fresh schema only ever migrates once.
 *
 * So: migrate, migrate again, and then check the schema is what it should be rather than just that nothing
 * threw. A statement that silently undid itself on the second pass would also be a bug.
 */

import { describe, expect, it } from "vitest";
import { migrate, rollback } from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

describe("migrations are re-runnable", () => {
  it("applies twice without error", async () => {
    const { sql } = await freshPgliteSchema();
    // The second pass is the point. `freshPgliteSchema` has already migrated once.
    await migrate(sql);
    await migrate(sql);
  });

  it("leaves the renamed and added columns in place after a second pass", async () => {
    const { sql } = await freshPgliteSchema();
    await migrate(sql);
    const columns = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'usage_limits'
        ORDER BY column_name`,
    );
    const names = columns.map((c) => c.column_name);
    // `window_key` is the rename (#181) and `model_id` the addition (#182). `period` must be gone: a second pass
    // that recreated it would leave two columns claiming to hold the window.
    expect(names).toContain("window_key");
    expect(names).toContain("model_id");
    expect(names).not.toContain("period");
  });

  it("keeps exactly one unique index on usage_limits after a second pass", async () => {
    const { sql } = await freshPgliteSchema();
    await migrate(sql);
    const indexes = await sql.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'usage_limits'
        ORDER BY indexname`,
    );
    const names = indexes.map((i) => i.indexname);
    // The two partial indexes were replaced by one expression index (#182). Both of the old ones surviving would
    // mean an upsert could match a different index than the one `put` names.
    expect(names).toContain("usage_limits_scope_idx");
    expect(names).not.toContain("usage_limits_tenant_idx");
    expect(names).not.toContain("usage_limits_principal_idx");
  });

  it("survives a full rollback and re-migration", async () => {
    const { sql } = await freshPgliteSchema();
    await rollback(sql);
    await migrate(sql);
    // The down path has the same non-idempotent statements in reverse, so this is the other half of the same
    // invariant — and it is what a developer resetting a local database actually does.
    await migrate(sql);
    await sql.query("SELECT 1 FROM usage_limits LIMIT 1");
  });
});
