/**
 * Row-Level Security for Supabase — `docs/02` + `docs/11`.
 *
 * Enforces tenant isolation *at the database*, independent of any app-level `WHERE`. The policy
 * predicate `tenant_id = current_setting('app.tenant_id')` is exactly the filter the
 * authorization `scope()` produces (see `tenantRlsFilter`), so the two agree by construction.
 * Supabase connects as a non-superuser role, so the policy applies (superusers bypass RLS).
 */
import type { SqlExecutor } from "../postgres/sql.js";

export const RLS_STATEMENTS: readonly string[] = [
  `ALTER TABLE conversations ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE conversations FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation ON conversations`,
  `CREATE POLICY tenant_isolation ON conversations
     USING (tenant_id = current_setting('app.tenant_id', true))
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`,
];

export const applyRls = async (sql: SqlExecutor): Promise<void> => {
  for (const stmt of RLS_STATEMENTS) await sql.query(stmt);
};

/** Bind the current session to a tenant so RLS scopes every subsequent query. */
export const setTenantContext = async (sql: SqlExecutor, tenantId: string): Promise<void> => {
  await sql.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
};
