/**
 * Postgres `EvaluationStore` (#141).
 *
 * Two properties are in the SQL.
 *
 * **`recordCase` upserts on the primary key**, so a resumed run re-recording a case it already scored replaces
 * rather than double-counts it in the aggregate. The key is the idempotency; there is no applied-case set to
 * keep right.
 *
 * **`completeRun` computes the aggregate from the case rows in one statement.** Accumulating as cases arrive
 * would let a run's totals disagree with its own evidence after a re-record — and the number that gates a
 * release must be derivable from what it was derived from.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type {
  EvalCaseResult,
  EvalDimensionSummary,
  EvalRun,
  EvaluationStore,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type RunRow = {
  id: string;
  release: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  total: number | string;
  passed: number | string;
  mean_score: number | string;
  by_dimension: unknown;
  cost_minor_units: number | string;
  grader_versions: unknown;
};

type CaseRow = {
  case_id: string;
  dimension: string;
  expect_kind: string;
  passed: boolean;
  score: number | string;
  reason: string;
  grader_id: string;
  grader_version: string;
  model_id: string | null;
  prompt_version: string | null;
  cost_minor_units: number | string;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

/** `jsonb` arrives parsed from node-postgres and as a string from some drivers. Both, or it works only in tests. */
const json = <T>(value: unknown, fallback: T): T =>
  value === null || value === undefined ? fallback : typeof value === "string" ? (JSON.parse(value) as T) : (value as T);

const toRun = (r: RunRow): EvalRun => ({
  id: r.id,
  release: r.release,
  startedAt: iso(r.started_at),
  ...(r.finished_at === null ? {} : { finishedAt: iso(r.finished_at) }),
  total: Number(r.total),
  passed: Number(r.passed),
  meanScore: Number(r.mean_score),
  byDimension: json<readonly EvalDimensionSummary[]>(r.by_dimension, []),
  costMinorUnits: Number(r.cost_minor_units),
  graderVersions: json<Readonly<Record<string, string>>>(r.grader_versions, {}),
});

const toCase = (r: CaseRow): EvalCaseResult => ({
  caseId: r.case_id,
  dimension: r.dimension,
  expectKind: r.expect_kind,
  verdict: { pass: r.passed, score: Number(r.score), reason: r.reason },
  graderId: r.grader_id,
  graderVersion: r.grader_version,
  ...(r.model_id === null ? {} : { modelId: r.model_id }),
  ...(r.prompt_version === null ? {} : { promptVersion: r.prompt_version }),
  costMinorUnits: Number(r.cost_minor_units),
});

const RUN_COLUMNS = `id, release, started_at, finished_at, total, passed, mean_score, by_dimension,
                     cost_minor_units, grader_versions`;
const CASE_COLUMNS = `case_id, dimension, expect_kind, passed, score, reason, grader_id, grader_version,
                       model_id, prompt_version, cost_minor_units`;

export const createPostgresEvaluationStore = (sql: SqlExecutor): EvaluationStore => ({
  async startRun({ tenantId, id, release, startedAt }) {
    const rows = await sql.query<RunRow>(
      `INSERT INTO evaluation_runs (tenant_id, id, release, started_at, total, passed, mean_score,
                                    by_dimension, cost_minor_units, grader_versions)
       VALUES ($1,$2,$3,$4,0,0,0,'[]'::jsonb,0,'{}'::jsonb)
       -- Nothing updated: a duplicate run id is a caller bug, and silently reopening a completed run would
       -- discard the numbers a release was gated on.
       ON CONFLICT (tenant_id, id) DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [tenantId, id, release, startedAt],
    );
    const created = rows[0];
    if (created === undefined)
      throw new AgentPlatformError({
        code: "conflict",
        message: `evaluation run ${id} already exists`,
        retryable: false,
      });
    return toRun(created);
  },

  async recordCase({ tenantId, runId, result }) {
    const rows = await sql.query<{ case_id: string }>(
      `INSERT INTO evaluation_case_results (tenant_id, run_id, case_id, dimension, expect_kind, passed, score,
                                            reason, grader_id, grader_version, model_id, prompt_version,
                                            cost_minor_units)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
       -- Only when the run exists. Without this the foreign key would raise on a deleted run, and a harness
       -- losing that race would abandon a whole scoring pass over an ordinary outcome.
       WHERE EXISTS (SELECT 1 FROM evaluation_runs WHERE tenant_id = $1 AND id = $2)
       -- The key is the idempotency: a resumed run re-recording a case replaces rather than double-counts it.
       ON CONFLICT (tenant_id, run_id, case_id) DO UPDATE SET
         dimension = EXCLUDED.dimension,
         expect_kind = EXCLUDED.expect_kind,
         passed = EXCLUDED.passed,
         score = EXCLUDED.score,
         reason = EXCLUDED.reason,
         grader_id = EXCLUDED.grader_id,
         grader_version = EXCLUDED.grader_version,
         model_id = EXCLUDED.model_id,
         prompt_version = EXCLUDED.prompt_version,
         cost_minor_units = EXCLUDED.cost_minor_units
       RETURNING case_id`,
      [
        tenantId,
        runId,
        result.caseId,
        result.dimension,
        result.expectKind,
        result.verdict.pass,
        result.verdict.score,
        result.verdict.reason,
        result.graderId,
        result.graderVersion,
        result.modelId ?? null,
        result.promptVersion ?? null,
        result.costMinorUnits,
      ],
    );
    return { recorded: rows.length > 0 };
  },

  async completeRun({ tenantId, runId, finishedAt, graderVersions }) {
    const rows = await sql.query<RunRow>(
      `WITH agg AS (
         SELECT COUNT(*)                                    AS agg_total,
                COUNT(*) FILTER (WHERE passed)              AS agg_passed,
                COALESCE(AVG(score), 0)                     AS agg_mean_score,
                COALESCE(SUM(cost_minor_units), 0)          AS agg_cost
           FROM evaluation_case_results
          WHERE tenant_id = $1 AND run_id = $2
       ),
       dims AS (
         SELECT COALESCE(
                  jsonb_agg(d ORDER BY d->>'dimension'),
                  '[]'::jsonb
                ) AS dim_json
           FROM (
             SELECT jsonb_build_object(
                      'dimension', dimension,
                      'total', COUNT(*),
                      'passed', COUNT(*) FILTER (WHERE passed),
                      'meanScore', COALESCE(AVG(score), 0)
                    ) AS d
               FROM evaluation_case_results
              WHERE tenant_id = $1 AND run_id = $2
              GROUP BY dimension
           ) grouped
       )
       UPDATE evaluation_runs SET
         finished_at = $3::timestamptz,
         -- Every CTE column aliased: total, passed and cost_minor_units all exist on the target table
         -- too, and an unqualified reference is ambiguous rather than defaulting to either.
         total = agg.agg_total,
         passed = agg.agg_passed,
         mean_score = agg.agg_mean_score,
         by_dimension = dims.dim_json,
         cost_minor_units = agg.agg_cost,
         grader_versions = $4::jsonb
       FROM agg, dims
       WHERE evaluation_runs.tenant_id = $1 AND evaluation_runs.id = $2
       RETURNING ${RUN_COLUMNS}`,
      [tenantId, runId, finishedAt, JSON.stringify(graderVersions)],
    );
    const run = rows[0];
    if (run === undefined)
      throw new AgentPlatformError({
        code: "not_found",
        message: `no such evaluation run ${runId}`,
        retryable: false,
      });
    return toRun(run);
  },

  async get({ tenantId, runId }) {
    const rows = await sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM evaluation_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    // A foreign tenant's run yields no row: one tenant's quality gate is not another's business.
    return rows[0] === undefined ? null : toRun(rows[0]);
  },

  async latest({ tenantId, release }) {
    const rows = await sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM evaluation_runs
        WHERE tenant_id = $1
          -- Completed only: an in-flight run's totals are partial, and comparing against one reports every case
          -- it has not reached yet as a regression.
          AND finished_at IS NOT NULL
          AND ($2::text IS NULL OR release = $2::text)
        -- Tie-broken by start then id: two runs can finish in the same instant, and "the latest run" must not
        -- depend on physical row order. An unstable answer is a gate comparing against an arbitrary one of two.
        ORDER BY finished_at DESC, started_at DESC, id DESC
        LIMIT 1`,
      [tenantId, release ?? null],
    );
    return rows[0] === undefined ? null : toRun(rows[0]);
  },

  async list({ tenantId, limit, cursor }) {
    const rows = await sql.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM evaluation_runs
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR id > $2::text)
        -- Newest first, the order a release history is read in.
        ORDER BY started_at DESC, id
        LIMIT $3`,
      [tenantId, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toRun);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: last.id }
      : ({ items } satisfies Page<EvalRun>);
  },

  async listCaseResults({ tenantId, runId, limit, cursor }) {
    const rows = await sql.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM evaluation_case_results
        WHERE tenant_id = $1 AND run_id = $2
          AND ($3::text IS NULL OR case_id > $3::text)
        -- By case id, so two runs' results zip together for a comparison without either side sorting.
        ORDER BY case_id
        LIMIT $4`,
      [tenantId, runId, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toCase);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: last.caseId }
      : { items };
  },
});
