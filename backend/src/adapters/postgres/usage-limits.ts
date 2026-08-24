/**
 * PostgreSQL `UsageLimitStore` — admin-configured spend limits (#175).
 *
 * `principal_id IS NULL` is the tenant default; a non-null row overrides it for one person. One table rather than
 * two, because "the default" and "an override" are the same kind of fact — and resolution is then a single query
 * ordered by specificity rather than two queries and a merge in application code.
 *
 * Every limit column is nullable and NULL means **unbounded**, not zero. That direction matches `QuotaLimits` and
 * is the whole reason it is stated twice: a misconfigured quota that blocks everything is an outage, and one that
 * blocks nothing is a bill the rollups make visible. An outage is only visible to the customer it happens to.
 */

import type { PrincipalId, TenantId } from "../../core/ids.js";
import { parseWindowKey, windowKey } from "../../persistence/index.js";
import type { UsageLimitRecord, UsageLimitStore } from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  tenant_id: string;
  principal_id: string | null;
  window_key: string;
  cost_minor_units: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  warn_at: number | null;
  updated_at: string | Date;
  updated_by: string | null;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const num = (v: number | string | null): number | undefined => (v === null ? undefined : Number(v));

const toLimit = (r: Row): UsageLimitRecord => ({
  tenantId: r.tenant_id as TenantId,
  ...(r.principal_id === null ? {} : { principalId: r.principal_id as PrincipalId }),
  /**
    * A row whose key this version cannot parse is **not** silently treated as some default window — it throws,
    * naming the value. The alternative is enforcing an allowance over a span nobody configured, in whichever
    * direction the fallback happened to point.
    */
   window: (() => {
     const parsed = parseWindowKey(r.window_key);
     if (parsed === null)
       throw new Error(`usage_limits row has an unrecognised window key ${JSON.stringify(r.window_key)}`);
     return parsed;
   })(),
  // Spread conditionally rather than assigning `undefined`, so an absent limit is absent from the object and
  // `"costMinorUnits" in limit` answers "is this bounded" without a second convention.
  ...(num(r.cost_minor_units) === undefined ? {} : { costMinorUnits: num(r.cost_minor_units)! }),
  ...(num(r.input_tokens) === undefined ? {} : { inputTokens: num(r.input_tokens)! }),
  ...(num(r.output_tokens) === undefined ? {} : { outputTokens: num(r.output_tokens)! }),
  ...(r.warn_at === null ? {} : { warnAt: r.warn_at }),
  updatedAt: iso(r.updated_at),
  ...(r.updated_by === null ? {} : { updatedBy: r.updated_by }),
});

const COLUMNS = `tenant_id, principal_id, window_key, cost_minor_units, input_tokens, output_tokens,
                 warn_at, updated_at, updated_by`;

export const createPostgresUsageLimitStore = (sql: SqlExecutor): UsageLimitStore => ({
  async put({ tenantId, limit }) {
    /**
     * Two statements, chosen by grain, because the conflict target differs.
     *
     * The uniqueness is expressed as two *partial* unique indexes — one where `principal_id IS NULL` and one
     * where it is not — since a NULL cannot participate in a normal unique constraint. `ON CONFLICT` needs the
     * matching index, and naming the wrong one is an error rather than a silent insert, which is why this
     * branches rather than trying to be clever with COALESCE.
     */
    const isTenantDefault = limit.principalId === undefined;
    const conflict = isTenantDefault
      ? `(tenant_id, window_key) WHERE principal_id IS NULL`
      : `(tenant_id, principal_id, window_key) WHERE principal_id IS NOT NULL`;
    const rows = await sql.query<Row>(
      `INSERT INTO usage_limits
         (tenant_id, principal_id, window_key, cost_minor_units, input_tokens, output_tokens, warn_at,
          updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT ${conflict} DO UPDATE SET
         cost_minor_units = EXCLUDED.cost_minor_units,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         warn_at = EXCLUDED.warn_at,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        limit.principalId ?? null,
        windowKey(limit.window),
        // `?? null` and not `?? 0`: an omitted limit is unbounded. Writing 0 would refuse every run, which is
        // the outage direction.
        limit.costMinorUnits ?? null,
        limit.inputTokens ?? null,
        limit.outputTokens ?? null,
        limit.warnAt ?? null,
        limit.updatedBy ?? null,
      ],
    );
    return toLimit(rows[0]!);
  },

  async resolve({ tenantId, principalId, window }) {
    /**
     * Most specific wins, decided by the database rather than by the caller.
     *
     * `ORDER BY principal_id NULLS LAST` puts the principal's own row first when it exists and falls back to the
     * tenant default otherwise. One query, one round trip, and — the actual point — one implementation: "most
     * specific wins" is a rule, and a rule implemented at two call sites is a rule with two behaviours.
     */
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM usage_limits
        WHERE tenant_id = $1 AND window_key = $2
          AND (principal_id IS NULL OR principal_id = $3::text)
        ORDER BY principal_id NULLS LAST
        LIMIT 1`,
      [tenantId, windowKey(window), principalId ?? null],
    );
    return rows[0] === undefined ? null : toLimit(rows[0]);
  },

  async list({ tenantId }) {
    const rows = await sql.query<Row>(
      // The tenant default first, then principals alphabetically — a stable order, so an admin screen does not
      // reshuffle between refreshes.
      `SELECT ${COLUMNS} FROM usage_limits WHERE tenant_id = $1
        ORDER BY principal_id NULLS FIRST, window_key`,
      [tenantId],
    );
    return rows.map(toLimit);
  },

  async remove({ tenantId, principalId, window }) {
    // `IS NOT DISTINCT FROM`, so a NULL parameter removes the tenant default rather than matching nothing.
    await sql.query(
      `DELETE FROM usage_limits
        WHERE tenant_id = $1 AND window_key = $2 AND principal_id IS NOT DISTINCT FROM $3::text`,
      [tenantId, windowKey(window), principalId ?? null],
    );
  },
});
