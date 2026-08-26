/**
 * Flow definitions and executions in Postgres — #187, #186.
 *
 * Two things are enforced by the schema rather than by this file, because a rule in code is a rule one code path
 * can miss:
 *
 * - **A version cannot be overwritten.** `(tenant_id, flow_id, version)` is the primary key and the insert has no
 *   `ON CONFLICT`, so a second write of the same version is a constraint violation. An execution pins a version
 *   and reads it for its whole life; a definition that could change under it would change an automation's shape
 *   halfway through.
 * - **A save cannot move an execution backwards.** The update carries `WHERE steps <= $n`, so a stale document
 *   from a slower worker updates nothing. A flow that goes backwards re-performs external writes, which is the
 *   failure the whole module exists to prevent — and doing it in the `WHERE` means two concurrent saves are
 *   ordered by the database rather than by whichever read happened first.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type { PrincipalId, RunId } from "../../core/ids.js";
import type {
  FlowDefinitionStore,
  FlowExecutionStore,
  StoredFlowDefinition,
  StoredFlowExecution,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

const int = (value: number | string): number => (typeof value === "number" ? value : Number.parseInt(value, 10));
const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

type DefinitionRow = {
  flow_id: string;
  version: number | string;
  name: string;
  kind: string;
  definition: unknown;
  created_at: string | Date;
  created_by: string | null;
};

const toDefinition = (row: DefinitionRow): StoredFlowDefinition => ({
  flowId: row.flow_id,
  version: int(row.version),
  name: row.name,
  kind: row.kind === "team" ? "team" : "flow",
  // `jsonb` comes back parsed from `pg`, and as a string from some executors. Handling both means the adapter
  // works under PGlite and a pool without a second code path for "which driver is this".
  definition: typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition,
  createdAt: iso(row.created_at),
  ...(row.created_by === null ? {} : { createdBy: row.created_by as PrincipalId }),
});

const take = (limit?: number): number => Math.max(1, Math.min(limit ?? 50, 500));

export const createPostgresFlowDefinitionStore = (sql: SqlExecutor): FlowDefinitionStore => ({
  async put({ tenantId, definition }) {
    try {
      await sql.query(
        `INSERT INTO flow_definitions (tenant_id, flow_id, version, name, kind, definition, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8)`,
        [
          tenantId,
          definition.flowId,
          definition.version,
          definition.name,
          definition.kind,
          JSON.stringify(definition.definition),
          definition.createdAt,
          definition.createdBy ?? null,
        ],
      );
    } catch (error) {
      /**
       * Translated, not passed through.
       *
       * The port's contract is that overwriting a version is refused; a caller should not have to recognise a
       * Postgres unique-violation code to know that happened. Anything else is rethrown, because swallowing an
       * unrelated failure here would report a conflict for a disk that is full.
       */
      const code = (error as { code?: string }).code;
      if (code === "23505" || /duplicate key|unique/i.test(String((error as Error).message))) {
        throw new AgentPlatformError({
          code: "conflict",
          message: `${definition.flowId} version ${definition.version} already exists — publish a new version instead`,
          retryable: false,
        });
      }
      throw error;
    }
  },

  async get({ tenantId, flowId, version }) {
    const rows = await sql.query<DefinitionRow>(
      `SELECT flow_id, version, name, kind, definition, created_at, created_by
         FROM flow_definitions WHERE tenant_id = $1 AND flow_id = $2 AND version = $3`,
      [tenantId, flowId, version],
    );
    return rows[0] === undefined ? null : toDefinition(rows[0]);
  },

  async latest({ tenantId, flowId }) {
    const rows = await sql.query<DefinitionRow>(
      `SELECT flow_id, version, name, kind, definition, created_at, created_by
         FROM flow_definitions WHERE tenant_id = $1 AND flow_id = $2
         ORDER BY version DESC LIMIT 1`,
      [tenantId, flowId],
    );
    return rows[0] === undefined ? null : toDefinition(rows[0]);
  },

  async list({ tenantId, limit, cursor }): Promise<Page<StoredFlowDefinition>> {
    const size = take(limit);
    /**
     * The latest version per flow, in one query.
     *
     * `DISTINCT ON` rather than a window function or a join against a grouped subquery: it is the shortest
     * statement that says "one row per flow_id, the highest version", and a caller asking what flows exist means
     * distinct flows rather than every version of every one.
     */
    const rows = await sql.query<DefinitionRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (flow_id) flow_id, version, name, kind, definition, created_at, created_by
           FROM flow_definitions WHERE tenant_id = $1
           ORDER BY flow_id, version DESC
       ) latest
       WHERE ($2::text IS NULL OR flow_id > $2)
       ORDER BY flow_id
       LIMIT $3`,
      [tenantId, cursor ?? null, size + 1],
    );
    const page = rows.slice(0, size).map(toDefinition);
    return {
      items: page,
      ...(rows.length > size && page.length > 0 ? { nextCursor: page[page.length - 1]!.flowId } : {}),
    };
  },
});

type ExecutionRow = {
  id: string;
  flow_id: string;
  flow_version: number | string;
  run_id: string;
  status: string;
  current_step: string | null;
  steps: number | string;
  execution: unknown;
  waiting_signal: string | null;
  waiting_run_id: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
};

const toExecution = (row: ExecutionRow): StoredFlowExecution => ({
  id: row.id,
  flowId: row.flow_id,
  flowVersion: int(row.flow_version),
  runId: row.run_id as RunId,
  status: row.status,
  currentStep: row.current_step,
  steps: int(row.steps),
  execution: typeof row.execution === "string" ? JSON.parse(row.execution) : row.execution,
  ...(row.waiting_signal === null ? {} : { waitingSignal: row.waiting_signal }),
  ...(row.waiting_run_id === null ? {} : { waitingRunId: row.waiting_run_id as RunId }),
  startedAt: iso(row.started_at),
  ...(row.finished_at === null ? {} : { finishedAt: iso(row.finished_at) }),
});

const EXECUTION_COLUMNS = `id, flow_id, flow_version, run_id, status, current_step, steps, execution,
         waiting_signal, waiting_run_id, started_at, finished_at`;

export const createPostgresFlowExecutionStore = (sql: SqlExecutor): FlowExecutionStore => ({
  async create({ tenantId, execution }) {
    try {
      await sql.query(
        `INSERT INTO flow_executions
           (tenant_id, id, flow_id, flow_version, run_id, status, current_step, steps, execution,
            waiting_signal, waiting_run_id, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::timestamptz, $13::timestamptz)`,
        [
          tenantId,
          execution.id,
          execution.flowId,
          execution.flowVersion,
          execution.runId,
          execution.status,
          execution.currentStep,
          execution.steps,
          JSON.stringify(execution.execution),
          execution.waitingSignal ?? null,
          execution.waitingRunId ?? null,
          execution.startedAt,
          execution.finishedAt ?? null,
        ],
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || /duplicate key|unique/i.test(String((error as Error).message))) {
        throw new AgentPlatformError({
          code: "conflict",
          message: `flow execution ${execution.id} already exists`,
          retryable: false,
        });
      }
      throw error;
    }
  },

  async save({ tenantId, execution }) {
    /**
     * `steps <= $8` in the predicate, so the database orders two concurrent saves.
     *
     * `<=` and not `<`: parking on a question completes no step, so an equal count is a legitimate status change.
     * Rejecting it would make "waiting" unrecordable, which is a whole class of state that could never be stored.
     */
    await sql.query(
      `UPDATE flow_executions
          SET status = $3, current_step = $4, steps = $5, execution = $6::jsonb,
              waiting_signal = $7, waiting_run_id = $10, finished_at = $9::timestamptz
        WHERE tenant_id = $1 AND id = $2 AND steps <= $8`,
      [
        tenantId,
        execution.id,
        execution.status,
        execution.currentStep,
        execution.steps,
        JSON.stringify(execution.execution),
        execution.waitingSignal ?? null,
        execution.steps,
        execution.finishedAt ?? null,
        execution.waitingRunId ?? null,
      ],
    );
  },

  async get({ tenantId, executionId }) {
    const rows = await sql.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM flow_executions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, executionId],
    );
    return rows[0] === undefined ? null : toExecution(rows[0]);
  },

  async waitingOnSignal({ tenantId, signal, limit }) {
    // `status = 'waiting'` in the predicate, not only the signal: a signal must not resume an execution that
    // never asked for it, and a stale `waiting_signal` on a running row is exactly that.
    const rows = await sql.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM flow_executions
        WHERE tenant_id = $1 AND status = 'waiting' AND waiting_signal = $2
        ORDER BY started_at LIMIT $3`,
      [tenantId, signal, take(limit)],
    );
    return rows.map(toExecution);
  },

  async waitingOnRun({ tenantId, runId }) {
    // `status = 'waiting'` as well as the id: a stale `waiting_run_id` on a running execution is not something a
    // settled run should resume, because it is not waiting for one.
    const rows = await sql.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM flow_executions
        WHERE tenant_id = $1 AND status = 'waiting' AND waiting_run_id = $2
        LIMIT 1`,
      [tenantId, runId],
    );
    return rows[0] === undefined ? null : toExecution(rows[0]);
  },

  async listByFlow({ tenantId, flowId, limit, cursor }): Promise<Page<StoredFlowExecution>> {
    const size = take(limit);
    const rows = await sql.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM flow_executions
        WHERE tenant_id = $1 AND flow_id = $2 AND ($3::text IS NULL OR id > $3)
        ORDER BY started_at DESC, id
        LIMIT $4`,
      [tenantId, flowId, cursor ?? null, size + 1],
    );
    const page = rows.slice(0, size).map(toExecution);
    return {
      items: page,
      ...(rows.length > size && page.length > 0 ? { nextCursor: page[page.length - 1]!.id } : {}),
    };
  },
});
