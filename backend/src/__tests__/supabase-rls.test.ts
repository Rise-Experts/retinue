/**
 * Row-level security across every table (#103).
 *
 * The point of this file is that it is **data-driven**. A hand-written list of policies drifts from
 * the schema — the SPEC's own list named `interactions` and `blob_refs`, neither of which exists, and
 * missed `schema_migrations`. So the coverage gate derives tables from `MIGRATIONS` and fails if any
 * is neither covered nor explicitly exempt, and the isolation test loops the same list rather than
 * naming tables.
 *
 * Two properties are easy to test vacuously, so both are checked against their own negation:
 *
 * - **`FORCE ROW LEVEL SECURITY` is load-bearing, but narrower than it looks.** Without it a table's
 *   owner bypasses its policies, and the owner is the role that runs migrations. It does **not** stop
 *   a superuser or any `BYPASSRLS` role, which skip row-level security entirely — found by writing a
 *   test that asserted the opposite and watching it fail. Both halves are pinned below, because the
 *   second means every policy here is worth exactly as much as the guarantee that the application
 *   does not connect as such a role.
 * - **An absent principal must match nothing.** `principal_id = current_setting(...)` against NULL is
 *   NULL, which the policy treats as false. If it matched instead, a background job with no principal
 *   bound would be able to read everyone's memory.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../adapters/postgres/migrations.js";
import { migrate, type SqlExecutor } from "../adapters/postgres/index.js";
import {
  RLS_EXEMPT_TABLES,
  RLS_STATEMENTS,
  setPrincipalContext,
  setTenantContext,
  TENANT_SCOPED_TABLES,
  VECTOR_RLS_STATEMENTS,
  VECTOR_TENANT_SCOPED_TABLES,
  tablesInMigrations,
} from "../adapters/supabase/rls.js";

const T1 = "rls-t1";
const T2 = "rls-t2";
const P1 = "rls-p1";
const P2 = "rls-p2";

const pgliteSql = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

/**
 * One minimal row per table for a tenant, in dependency order so the foreign keys hold.
 *
 * Keyed by table so the coverage gate can assert every table is seeded — a table with a policy but no
 * seed would make its isolation case pass on an empty table, which is the vacuous-pass failure mode
 * this whole file is built to avoid.
 */
const SEEDS: Readonly<Record<string, (tenant: string, principal: string) => string>> = {
  conversations: (t) =>
    `INSERT INTO conversations (tenant_id, id, title, created_at, updated_at)
     VALUES ('${t}', '${t}-c1', 'thread', now(), now())`,
  runs: (t) =>
    `INSERT INTO runs (tenant_id, id, conversation_id, agent_id, agent_version, status, created_at)
     VALUES ('${t}', '${t}-r1', '${t}-c1', 'a1', 1, 'queued', now())`,
  run_events: (t) =>
    `INSERT INTO run_events (tenant_id, run_id, sequence, type, event)
     VALUES ('${t}', '${t}-r1', 1, 'run.queued', '{}'::jsonb)`,
  checkpoints: (t) =>
    `INSERT INTO checkpoints (tenant_id, run_id, sequence, step, state, updated_at)
     VALUES ('${t}', '${t}-r1', 1, 1, '{}'::jsonb, now())`,
  messages: (t) =>
    `INSERT INTO messages (tenant_id, id, conversation_id, role, parts, created_at)
     VALUES ('${t}', '${t}-m1', '${t}-c1', 'user', '[]'::jsonb, now())`,
  agents: (t) =>
    `INSERT INTO agents (tenant_id, id, version, manifest, created_at, updated_at)
     VALUES ('${t}', 'a1', 1, '{}'::jsonb, now(), now())`,
  conversation_bindings: (t) =>
    `INSERT INTO conversation_bindings (tenant_id, conversation_id, agent_id, agent_version_policy, bound_at)
     VALUES ('${t}', '${t}-c1', 'a1', 'latest', now())`,
  session_state: (t) =>
    `INSERT INTO session_state (tenant_id, conversation_id, state, version, updated_at)
     VALUES ('${t}', '${t}-c1', '{}'::jsonb, 1, now())`,
  thread_summaries: (t) =>
    `INSERT INTO thread_summaries (tenant_id, conversation_id, version, summary, covers_up_to_message_id, created_at)
     VALUES ('${t}', '${t}-c1', 1, 's', '${t}-m1', now())`,
  conversation_run_slots: (t) =>
    `INSERT INTO conversation_run_slots (tenant_id, conversation_id, queued, updated_at)
     VALUES ('${t}', '${t}-c1', '[]'::jsonb, now())`,
  interaction_questions: (t) =>
    `INSERT INTO interaction_questions (tenant_id, id, run_id, questions, created_at)
     VALUES ('${t}', '${t}-q1', '${t}-r1', '[]'::jsonb, now())`,
  interaction_approvals: (t) =>
    `INSERT INTO interaction_approvals
       (tenant_id, id, run_id, tool_name, normalized_input, risk_category, summary, expires_at, idempotency_key)
     VALUES ('${t}', '${t}-a1', '${t}-r1', 'publish', '{}'::jsonb, 'external-write', 's', now(), '${t}-idem')`,
  approval_grants: (t) =>
    `INSERT INTO approval_grants (tenant_id, id, scope, tool_name_or_category, granted_at)
     VALUES ('${t}', '${t}-g1', 'tenant', 'publish', now())`,
  usage_records: (t) =>
    `INSERT INTO usage_records
       (tenant_id, id, dedupe_key, run_id, model_id, input_tokens, output_tokens,
        cached_input_tokens, cost_minor_units, currency, occurred_at)
     VALUES ('${t}', '${t}-u1', '${t}-dk1', '${t}-r1', 'm', 1, 1, 0, 10, 'EUR', now())`,
  usage_rollups: (t) =>
    `INSERT INTO usage_rollups
       (tenant_id, period, bucket_start, input_tokens, output_tokens, cached_input_tokens,
        reasoning_tokens, cost_minor_units, event_count, currency, computed_at)
     VALUES ('${t}', 'hour', date_trunc('hour', now()), 100, 20, 5, 0, 7, 1, 'EUR', now())`,
  // #175. A tenant default rather than a per-principal override, so the row exercises the common case — and the
  // tenant predicate is the whole policy here, unlike `principal_memory` next door.
  usage_limits: (t) =>
    // `window_key`, not `period` — #181 widened the column so a rolling window shares the same unique index.
    `INSERT INTO usage_limits (tenant_id, principal_id, window_key, cost_minor_units, updated_at)
     VALUES ('${t}', NULL, 'month', 5000, now())`,
  evaluation_runs: (t) =>
    `INSERT INTO evaluation_runs
       (tenant_id, id, release, started_at, total, passed, mean_score, by_dimension, cost_minor_units,
        grader_versions)
     VALUES ('${t}', '${t}-run1', 'v1', now(), 1, 1, 1, '[]'::jsonb, 0, '{}'::jsonb)`,
  evaluation_case_results: (t) =>
    `INSERT INTO evaluation_case_results
       (tenant_id, run_id, case_id, dimension, expect_kind, passed, score, reason, grader_id, grader_version,
        cost_minor_units)
     VALUES ('${t}', '${t}-run1', 'gr-001', 'groundedness', 'contains', true, 1, 'ok', 'contains', '1', 0)`,
  idempotency_keys: (t) =>
    `INSERT INTO idempotency_keys (tenant_id, key, result, created_at)
     VALUES ('${t}', '${t}-key', '{}'::jsonb, now())`,
  skills: (t) =>
    `INSERT INTO skills (tenant_id, id, name, description, source, version, instructions, status, created_at)
     VALUES ('${t}', '${t}-s1', 'post-composition', repeat('d', 40), 'tenant', 1, 'body', 'active', now())`,
  mcp_connections: (t) =>
    `INSERT INTO mcp_connections (tenant_id, id, label, transport, endpoint, auth_kind, enabled, created_at)
     VALUES ('${t}', '${t}-mc1', 'srv', 'streamable-http', 'https://x/y', 'none', true, now())`,
  principal_memory: (t, p) =>
    `INSERT INTO principal_memory
       (tenant_id, principal_id, id, text, tags, salience, version, created_at, updated_at)
     VALUES ('${t}', '${p}', '${t}-mem1', 'remembered', '[]'::jsonb, 1, 1, now(), now())`,
  blobs: (t) => `INSERT INTO blobs (tenant_id, ref, value) VALUES ('${t}', '${t}-blob1', '{}'::jsonb)`,
  artifacts: (t) =>
    `INSERT INTO artifacts (tenant_id, id, conversation_id, kind, name, latest_version, created_at, updated_at)
     VALUES ('${t}', '${t}-art1', '${t}-c1', 'markdown', 'Q3 summary', 1, now(), now())`,
  artifact_versions: (t, p) =>
    `INSERT INTO artifact_versions
       (tenant_id, id, artifact_id, version, content_ref, byte_size, provenance, created_by, created_at)
     VALUES ('${t}', '${t}-av1', '${t}-art1', 1, '${t}-blob1', 128, '{}'::jsonb, '${p}', now())`,
  artifact_exports: (t, p) =>
    `INSERT INTO artifact_exports
       (tenant_id, id, artifact_id, version, format, state, requested_by, created_at)
     VALUES ('${t}', '${t}-exp1', '${t}-art1', 1, 'pdf', 'pending', '${p}', now())`,
  files: (t, p) =>
    `INSERT INTO files
       (tenant_id, id, conversation_id, filename, media_type, byte_size, content_key, state, uploaded_by,
        created_at)
     VALUES ('${t}', '${t}-f1', '${t}-c1', 'report.pdf', 'application/pdf', 1024, '${t}/f1',
             'stored', '${p}', now())`,
  // #185. The bytes, which live in Postgres for a deployment with no object storage — so the isolation case has
  // to be exercised on the row that actually holds them, not only on the metadata beside it.
  flow_definitions: (t) =>
    `INSERT INTO flow_definitions (tenant_id, flow_id, version, name, kind, definition, created_at)
     VALUES ('${t}', '${t}-flow', 1, 'a flow', 'flow', '{"steps":[]}'::jsonb, now())`,
  flow_executions: (t) =>
    `INSERT INTO flow_executions (tenant_id, id, flow_id, flow_version, run_id, status, current_step, steps, execution, started_at)
     VALUES ('${t}', '${t}-exec', '${t}-flow', 1, '${t}-r1', 'running', 'a', 0, '{"state":{}}'::jsonb, now())`,
  file_objects: (t) =>
    `INSERT INTO file_objects (tenant_id, content_key, media_type, byte_size, checksum, bytes)
     VALUES ('${t}', '${t}/f1', 'image/png', 3, 'deadbeef', decode('414243', 'hex'))`,
};

/**
 * A migrated database with both tenants seeded, RLS applied, and a non-superuser role available.
 *
 * Seeding happens **before** `applyRls`, because `FORCE ROW LEVEL SECURITY` subjects the owner to
 * policy too — after forcing, the owner could not insert a row for a tenant it is not bound to.
 */
const prepared = async (options: { readonly force?: boolean } = {}) => {
  const db = new PGlite();
  const sql = pgliteSql(db);
  await migrate(sql);

  for (const [tenant, principal] of [
    [T1, P1],
    [T2, P2],
  ] as const) {
    for (const table of tablesInMigrations()) {
      const seed = SEEDS[table];
      if (seed) await sql.query(seed(tenant, principal));
    }
  }

  const statements =
    options.force === false
      ? RLS_STATEMENTS.filter((s) => !s.includes("FORCE ROW LEVEL SECURITY"))
      : RLS_STATEMENTS;
  for (const stmt of statements) await sql.query(stmt);

  // Supabase connects as a non-superuser; simulate that, since a superuser bypasses RLS entirely.
  await db.exec(`CREATE ROLE app_user NOSUPERUSER;`);
  for (const { table } of TENANT_SCOPED_TABLES) {
    await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_user;`);
  }
  return { db, sql };
};

/** Read a table with no app-level WHERE, as `app_user`, bound to a tenant (and maybe a principal). */
const readAs = async (
  ctx: { db: PGlite; sql: SqlExecutor },
  table: string,
  tenant: string,
  principal?: string,
): Promise<number> => {
  await ctx.db.exec(`RESET ROLE;`);
  await setTenantContext(ctx.sql, tenant);
  await setPrincipalContext(ctx.sql, principal ?? "");
  await ctx.db.exec(`SET ROLE app_user;`);
  const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
  await ctx.db.exec(`RESET ROLE;`);
  return Number(rows[0]?.n ?? 0);
};

// ---------------------------------------------------------------------------------- coverage gate

describe("policy coverage is derived from MIGRATIONS, not transcribed", () => {
  it("covers or explicitly exempts every table a migration creates", () => {
    /**
     * Both coverage lists, because `tablesInMigrations` now scans both migration lists (#145).
     *
     * The security audit found the gate reading only `MIGRATIONS`, so no table from `VECTOR_MIGRATIONS` was ever
     * checked. Fixing the scan made this test fail immediately on `knowledge_chunks` — which *was* covered, in
     * `VECTOR_TENANT_SCOPED_TABLES`, and the gate had simply never looked at the table to notice. Proof the hole
     * was real: the next vector table would have shipped with no policy and nothing would have said so.
     */
    const covered = new Set(
      [...TENANT_SCOPED_TABLES, ...VECTOR_TENANT_SCOPED_TABLES].map((t) => t.table),
    );
    const exempt = new Map(RLS_EXEMPT_TABLES.map((t) => [t.table, t.reason]));

    const uncovered = tablesInMigrations().filter((t) => !covered.has(t) && !exempt.has(t));
    // AC-4. This is the gate: a migration adding a table without a policy fails here, so an
    // uncovered table cannot ship. The failure message names it rather than saying "expected 0".
    expect(uncovered, `tables with no RLS policy and no exemption: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("names no table that does not exist", () => {
    const actual = new Set([...tablesInMigrations(), "schema_migrations"]);
    for (const { table } of VECTOR_TENANT_SCOPED_TABLES)
      expect(actual.has(table), `${table} is not a real table`).toBe(true);
    // The other direction, and the one the SPEC's list got wrong: `interactions` and `blob_refs` were
    // both named and neither exists. A stale entry generates a policy statement against a missing
    // table, which fails at apply time — far from the list that caused it.
    for (const { table } of TENANT_SCOPED_TABLES) expect(actual.has(table), `${table} is not a real table`).toBe(true);
    for (const { table } of RLS_EXEMPT_TABLES) expect(actual.has(table), `${table} is not a real table`).toBe(true);
  });

  it("gives every exemption a reason", () => {
    // An exemption without a stated reason is indistinguishable from a forgotten table.
    for (const { table, reason } of RLS_EXEMPT_TABLES) {
      expect(reason.length, `${table} needs a reason`).toBeGreaterThan(40);
    }
  });

  it("seeds every covered table, so no isolation case can pass on an empty table", () => {
    // The vacuous-pass guard for the test below: zero cross-tenant rows is not evidence if there are
    // zero rows at all.
    const unseeded = TENANT_SCOPED_TABLES.map((t) => t.table).filter((t) => !(t in SEEDS));
    expect(unseeded, `covered but unseeded: ${unseeded.join(", ")}`).toEqual([]);
  });

  it("enables and forces RLS on every covered table", () => {
    for (const { table } of TENANT_SCOPED_TABLES) {
      expect(RLS_STATEMENTS).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(RLS_STATEMENTS).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    // 30 tables as of #187 (`flow_definitions`, `flow_executions`); the count is asserted so a table silently
    // dropping out is visible.
    // Updating this number is meant to be a moment of thought: it is the one place that notices a policy list
    // shrinking, which no per-table test can see.
    expect(TENANT_SCOPED_TABLES).toHaveLength(30);

    // #135. `knowledge_chunks` lives behind the optional pgvector migration, so its policies are a separate
    // list applied by whoever ran that migration -- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on an absent
    // table fails. Listed and asserted rather than omitted, because a tenant-scoped table without RLS is the
    // one omission that matters, and "it is behind a flag" is how that omission survives review.
    for (const { table } of VECTOR_TENANT_SCOPED_TABLES) {
      expect(VECTOR_RLS_STATEMENTS).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(VECTOR_RLS_STATEMENTS).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(VECTOR_TENANT_SCOPED_TABLES).toHaveLength(1);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(11);
  });
});

// ------------------------------------------------------------------------------ cross-tenant reads

describe("cross-tenant isolation, every table", () => {
  it("returns zero rows from another tenant's context, with no app-level WHERE", async () => {
    const ctx = await prepared();

    for (const { table } of TENANT_SCOPED_TABLES) {
      // principal_memory needs its principal bound too, or the extra predicate hides its own rows —
      // which would make this case pass for the wrong reason.
      const own = await readAs(ctx, table, T1, P1);
      const other = await readAs(ctx, table, T2, P1);
      expect(own, `${table} should be visible to its own tenant`).toBeGreaterThan(0);
      // For principal_memory, T2's rows belong to P2, so P1-in-T2 legitimately sees none either way;
      // the cross-principal case below covers that dimension separately.
      expect(other, `${table} leaked across tenants`).toBe(table === "principal_memory" ? 0 : 1);
    }
  }, 60_000);

  it("sees nothing at all with no tenant bound", async () => {
    const ctx = await prepared();
    // An unset tenant must not be a wildcard. `tenant_id = NULL` is NULL, which the policy treats as
    // false — so a connection that forgot to bind a tenant reads nothing rather than everything.
    await ctx.db.exec(`RESET ROLE;`);
    await ctx.sql.query(`SELECT set_config('app.tenant_id', '', false)`);
    await ctx.db.exec(`SET ROLE app_user;`);
    for (const table of ["conversations", "runs", "usage_records"]) {
      const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
      expect(Number(rows[0]?.n), `${table} visible with no tenant bound`).toBe(0);
    }
    await ctx.db.exec(`RESET ROLE;`);
  });
});

// ------------------------------------------------------------------------- principal scoping (AC-3)

describe("principal_memory is scoped to the principal as well as the tenant", () => {
  it("refuses a cross-principal read inside one tenant", async () => {
    const ctx = await prepared();
    // Tenant-only scoping here would leak one user's memories to every other user of the same
    // customer, which is the opposite of what per-principal memory is for.
    expect(await readAs(ctx, "principal_memory", T1, P1)).toBe(1);
    expect(await readAs(ctx, "principal_memory", T1, P2)).toBe(0);
  });

  it("sees nothing when the principal setting was never set at all", async () => {
    const ctx = await prepared();
    // Deliberately *not* calling setPrincipalContext — a fresh connection has never touched
    // `app.principal_id`, so `current_setting(..., true)` returns NULL. That is the realistic state
    // for a background reaper, a migration or a rollup: a tenant, and no principal.
    //
    // An earlier version of this test set the value to the empty string instead, which is a different
    // thing entirely: `principal_id = ''` is *false*, while `principal_id = NULL` is *NULL*. Only the
    // second exercises the predicate's null handling, and only the second failed when the predicate
    // was wrapped in COALESCE(..., true) — the sabotage that revealed the gap.
    await ctx.db.exec(`RESET ROLE;`);
    await setTenantContext(ctx.sql, T1);
    await ctx.db.exec(`SET ROLE app_user;`);
    const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM principal_memory`);
    expect(Number(rows[0]?.n)).toBe(0);
    await ctx.db.exec(`RESET ROLE;`);
  });

  it("still refuses when the setting is present but empty", async () => {
    const ctx = await prepared();
    // The other shape of "no principal": bound, but to nothing. Both must deny, and they deny for
    // different reasons — false versus NULL — so both are worth asserting.
    await ctx.db.exec(`RESET ROLE;`);
    await setTenantContext(ctx.sql, T1);
    await setPrincipalContext(ctx.sql, "");
    await ctx.db.exec(`SET ROLE app_user;`);
    const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM principal_memory`);
    expect(Number(rows[0]?.n)).toBe(0);
    await ctx.db.exec(`RESET ROLE;`);
  });
});

// ------------------------------------------------------------------------------- FORCE is not decor

describe("FORCE ROW LEVEL SECURITY, and the hazard it does not cover", () => {
  it("makes a non-superuser table owner subject to policy", async () => {
    for (const [force, expected] of [
      [true, 1],
      [false, 2],
    ] as const) {
      const ctx = await prepared({ force });
      // Hand ownership to the non-superuser role, which is the situation FORCE exists for: without
      // it an owner bypasses its own table's policies, and the role that runs migrations is an owner.
      await ctx.db.exec(`ALTER TABLE conversations OWNER TO app_user;`);
      await setTenantContext(ctx.sql, T1);
      await ctx.db.exec(`SET ROLE app_user;`);
      const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM conversations`);
      // 2 without FORCE is the number that would have made every isolation assertion above
      // meaningless, had the app connected as the table's owner.
      expect(Number(rows[0]?.n), `force=${force}`).toBe(expected);
      await ctx.db.exec(`RESET ROLE;`);
    }
  }, 30_000);

  it("does NOT stop a superuser — which is why the connecting role matters more than the policy", async () => {
    const ctx = await prepared();
    await setTenantContext(ctx.sql, T1);
    // Discovered while writing the test above, which asserted the opposite and failed. FORCE subjects
    // the *owner* to policy; a superuser (and any BYPASSRLS role) skips row-level security entirely,
    // forced or not. So every policy in this file is worth exactly as much as the guarantee that the
    // application does not connect as such a role — and nothing currently checks that.
    //
    // Pinned as a test rather than a comment because it is the failure mode most likely to be
    // introduced later by a well-meaning connection-string change.
    const rows = await ctx.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM conversations`);
    expect(Number(rows[0]?.n)).toBe(2);
  });
});

// -------------------------------------------------------------------- writes, and behaviour parity

describe("policies apply to writes, not only reads", () => {
  it("refuses to insert a row for another tenant", async () => {
    const ctx = await prepared();
    await ctx.db.exec(`RESET ROLE;`);
    await setTenantContext(ctx.sql, T1);
    await ctx.db.exec(`SET ROLE app_user;`);
    // WITH CHECK, not just USING. Without it a tenant could write rows attributed to another tenant
    // that it then could not see — corruption that only surfaces for the victim.
    await expect(
      ctx.sql.query(
        `INSERT INTO conversations (tenant_id, id, title, created_at, updated_at)
         VALUES ('${T2}', 'smuggled', 'x', now(), now())`,
      ),
    ).rejects.toThrow();
    await ctx.db.exec(`RESET ROLE;`);
  });

  it("leaves in-tenant behaviour unchanged, so RLS is not a behaviour change", async () => {
    const ctx = await prepared();
    await ctx.db.exec(`RESET ROLE;`);
    await setTenantContext(ctx.sql, T1);
    await ctx.db.exec(`SET ROLE app_user;`);
    // Partial AC-5: the store's own tenant-scoped reads and writes behave identically with policies
    // applied. The matrix-wide Supabase claim is #104's, since that column is 1/19 until then.
    await ctx.sql.query(
      `INSERT INTO conversations (tenant_id, id, title, created_at, updated_at)
       VALUES ('${T1}', 'mine', 'x', now(), now())`,
    );
    const rows = await ctx.sql.query<{ id: string }>(`SELECT id FROM conversations ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(["mine", `${T1}-c1`]);
    await ctx.db.exec(`RESET ROLE;`);
  });
});
