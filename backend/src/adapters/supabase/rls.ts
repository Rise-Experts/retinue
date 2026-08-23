/**
 * Row-Level Security — `docs/02` + `docs/11`.
 *
 * Enforces tenant isolation *at the database*, independent of any app-level `WHERE`. The policy
 * predicate `tenant_id = current_setting('app.tenant_id')` is exactly the filter the authorization
 * `scope()` produces (see `tenantRlsFilter`), so the two agree by construction — and if the
 * application filter is ever forgotten, the database still refuses.
 *
 * Until #103 this covered exactly one table, because `conversations` was the only table when it was
 * written. There are now 19, and a table without a policy means a Supabase deployment relies on
 * application filtering alone — the single point of failure REQ-014 exists to remove.
 *
 * **Policies are generated from the registry below rather than written out**, so adding a table's
 * policy is a one-line entry and the statements cannot drift from the list. The coverage gate in
 * `supabase-rls.test.ts` derives the table list from `MIGRATIONS`, so a new table cannot ship
 * uncovered and a stale entry for a dropped table fails too.
 */
import { MIGRATIONS, VECTOR_MIGRATIONS } from "../postgres/migrations.js";
import type { SqlExecutor } from "../postgres/sql.js";
import type { TransactionRunner } from "../postgres/transaction.js";

/**
 * A table whose rows belong to a tenant, plus any predicate beyond the tenant match.
 *
 * `extraPredicate` exists for one case today. Tenant-only scoping on `principal_memory` would leak
 * one user's memories to every other user of the same customer, which is the opposite of what
 * per-principal memory is for.
 */
export type RlsTable = {
  readonly table: string;
  readonly extraPredicate?: string;
};

/**
 * The principal predicate is written so an **absent** setting matches nothing.
 *
 * `current_setting('app.principal_id', true)` returns NULL when unset, and `principal_id = NULL` is
 * NULL — which the policy treats as false. That is the behaviour we want: a connection with no
 * principal bound sees no memories at all, rather than seeing every row whose `principal_id` happens
 * to equal the empty string. Getting this backwards is how a background job ends up able to read
 * everyone's memory.
 */
const PRINCIPAL_PREDICATE = `principal_id = current_setting('app.principal_id', true)`;

/**
 * Tenant-scoped tables that live behind the optional pgvector migration (#135).
 *
 * Separate from `TENANT_SCOPED_TABLES` because `knowledge_chunks` does not exist until `migrateVector` runs, and
 * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on an absent table fails. A deployment that runs the vector
 * migration runs `applyVectorRls` with it; one that does not has no table to protect. Listed rather than
 * omitted so the requirement is recorded — a tenant-scoped table without RLS is the one omission that matters.
 */
export const VECTOR_TENANT_SCOPED_TABLES: readonly { readonly table: string }[] = [
  { table: "knowledge_chunks" },
];

export const TENANT_SCOPED_TABLES: readonly RlsTable[] = [
  { table: "conversations" },
  { table: "runs" },
  { table: "run_events" },
  { table: "checkpoints" },
  { table: "messages" },
  { table: "agents" },
  { table: "conversation_bindings" },
  { table: "session_state" },
  { table: "thread_summaries" },
  { table: "conversation_run_slots" },
  // Two tables, not one: #99 split questions from approvals because PendingQuestion and
  // PendingApproval share only three fields. The SPEC's list named a single `interactions`.
  { table: "interaction_questions" },
  { table: "interaction_approvals" },
  { table: "approval_grants" },
  { table: "usage_records" },
  { table: "usage_rollups" },
  { table: "evaluation_runs" },
  { table: "evaluation_case_results" },
  { table: "idempotency_keys" },
  { table: "skills" },
  { table: "mcp_connections" },
  { table: "principal_memory", extraPredicate: PRINCIPAL_PREDICATE },
  // `blobs`, not the SPEC's `blob_refs`: BlobStore stores the value, and the metadata-and-pointer
  // design belongs to FileMetadataStore (#129) / ArtifactStore (#133).
  { table: "blobs" },
  // #129. The bytes are not in Postgres at all, so this policy covers the metadata only — an object-storage
  // bucket needs its own access rules, and RLS here says nothing about them.
  { table: "files" },
  { table: "artifacts" },
  { table: "artifact_versions" },
  { table: "artifact_exports" },
];

/**
 * Tables that deliberately have no tenant policy, each with the reason.
 *
 * Classified rather than skipped. A silent omission is indistinguishable from a forgotten table,
 * which is exactly what the coverage gate exists to catch — so an exemption has to be a decision
 * someone wrote down.
 */
export const RLS_EXEMPT_TABLES: readonly { readonly table: string; readonly reason: string }[] = [
  {
    table: "schema_migrations",
    reason:
      "Records which migrations have been applied. Deployment state, not customer data, and it holds " +
      "no tenant_id to scope on. A migration runner must read it before any tenant context exists.",
  },
];

const policyFor = ({ table, extraPredicate }: RlsTable): readonly string[] => {
  const tenant = `tenant_id = current_setting('app.tenant_id', true)`;
  const predicate = extraPredicate === undefined ? tenant : `${tenant} AND ${extraPredicate}`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    // FORCE matters more than it looks. Without it the table owner bypasses every policy — and the
    // owner is the role that runs migrations, and in many deployments the role the app connects as.
    // An isolation test would then pass while proving nothing.
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${table}`,
    `CREATE POLICY tenant_isolation ON ${table}
       USING (${predicate})
       WITH CHECK (${predicate})`,
  ];
};

export const RLS_STATEMENTS: readonly string[] = TENANT_SCOPED_TABLES.flatMap(policyFor);

export const applyRls = async (sql: SqlExecutor): Promise<void> => {
  for (const stmt of RLS_STATEMENTS) await sql.query(stmt);
};

/** The same policies for the vector table, applied by whoever ran `migrateVector` (#135). */
export const VECTOR_RLS_STATEMENTS: readonly string[] = VECTOR_TENANT_SCOPED_TABLES.flatMap(policyFor);

export const applyVectorRls = async (sql: SqlExecutor): Promise<void> => {
  for (const stmt of VECTOR_RLS_STATEMENTS) await sql.query(stmt);
};

/**
 * Every table `MIGRATIONS` creates, in migration order.
 *
 * Derived rather than transcribed: the SPEC's hand-written list named `interactions` and `blob_refs`,
 * neither of which exists, and missed `schema_migrations`. A list that can disagree with the schema
 * will eventually disagree with the schema.
 */
/**
 * Every table any migration creates — **both** lists (#145).
 *
 * `VECTOR_MIGRATIONS` was missing, and that was a hole in the coverage gate rather than an oversight in a list:
 * a table added there was never scanned, so it could ship with no RLS policy and no exemption and nothing would
 * say so. `knowledge_chunks` happened to be covered because someone remembered; the *next* vector table would
 * not have been.
 *
 * Found by auditing the gate rather than the list, which is the difference between checking the answer and
 * checking the thing that produces it.
 */
export const tablesInMigrations = (): readonly string[] => {
  const names: string[] = [];
  for (const migration of [...MIGRATIONS, ...VECTOR_MIGRATIONS]) {
    for (const statement of migration.up) {
      const match = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/i.exec(statement);
      if (match?.[1] && !names.includes(match[1])) names.push(match[1]);
    }
  }
  return names;
};

/**
 * Bind the **session** to a tenant. Safe only on a direct connection.
 *
 * `is_local = false` makes the setting outlive the current transaction, which is right for a
 * connection this process owns exclusively — and **dangerous behind a transaction-mode pooler**, which
 * is how Supabase's pooler port works. There, a backend is handed to a different client after each
 * transaction while the session GUC stays set, so tenant A's binding is still in place when tenant B's
 * query lands on that backend, and B's queries are evaluated against A's tenant id.
 *
 * That is a cross-tenant read produced by the mechanism introduced to prevent cross-tenant reads, and
 * it is worse than having no policy at all, because the policy makes it look handled.
 *
 * Prefer `withTenantContext` unless you are certain the connection is not pooled. See the open
 * question on #104 about removing this entirely.
 */
export const setTenantContext = async (sql: SqlExecutor, tenantId: string): Promise<void> => {
  await sql.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
};

/**
 * Run `fn` with the tenant (and optionally the principal) bound **for the duration of one
 * transaction**, which is the only binding that is safe behind a pooler.
 *
 * `is_local = true` scopes the setting to the transaction, so it is discarded at commit or rollback
 * and cannot be observed by whoever gets the backend next. The transaction comes from #98's
 * `TransactionRunner`, and the executor handed to `fn` is the transaction's — so stores built over a
 * `scoped()` executor participate without knowing any of this exists.
 */
export const withTenantContext = async <T>(
  runner: TransactionRunner,
  scope: { readonly tenantId: string; readonly principalId?: string },
  fn: (sql: SqlExecutor) => Promise<T>,
): Promise<T> =>
  runner.transaction(async (sql) => {
    await sql.query(`SELECT set_config('app.tenant_id', $1, true)`, [scope.tenantId]);
    if (scope.principalId !== undefined) {
      await sql.query(`SELECT set_config('app.principal_id', $1, true)`, [scope.principalId]);
    }
    return fn(sql);
  });

/**
 * Bind the **session** to a principal. Same pooling caveat as `setTenantContext` — prefer passing
 * `principalId` to `withTenantContext`.
 *
 * Separate from `setTenantContext` because most work has a tenant and no principal — a background
 * reaper, a migration, a rollup. Those must not be able to read principal-scoped rows, and with this
 * unset they cannot: the predicate compares against NULL and matches nothing.
 */
export const setPrincipalContext = async (sql: SqlExecutor, principalId: string): Promise<void> => {
  await sql.query(`SELECT set_config('app.principal_id', $1, false)`, [principalId]);
};
