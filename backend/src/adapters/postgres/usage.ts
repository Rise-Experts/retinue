/**
 * PostgreSQL `UsageStore` and `IdempotencyStore` (#100) — the cost ledger and the replay guard.
 *
 * Both are about not repeating things. Usage must not be double-counted, because the duplicate lands
 * in an invoice; an external tool call must not be re-executed, because the duplicate lands in the
 * outside world. In both cases the guarantee is a unique key plus `ON CONFLICT`, not application
 * logic — an in-process check cannot hold across the workers that make retries happen.
 *
 * Costs are integers throughout. `SUM` over `integer` widens to `bigint` in Postgres, so a large
 * rollup cannot overflow, and nothing anywhere is floating point — a float column would sum with
 * drift and the drift would end up on a bill.
 */
import type { Page } from "../../core/context.js";
import type { ConversationId, RunId } from "../../core/ids.js";
import type { IdempotencyKey, IdempotencyStore, IdempotentResult } from "../../idempotency/index.js";
import type { UsageStore, UsageTotals } from "../../persistence/index.js";
import { usageDedupeKey } from "../../usage/index.js";
import type { UsageEvent } from "../../usage/index.js";
import type { SqlExecutor } from "./sql.js";

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** `bigint` and `numeric` come back as strings from node-postgres; `integer` as a number. */
const int = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const json = <T>(value: unknown): T => (typeof value === "string" ? (JSON.parse(value) as T) : (value as T));

type UsageRow = {
  id: string;
  tenant_id: string;
  run_id: string;
  conversation_id: string | null;
  step_id: string | null;
  tool_call_id: string | null;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number | null;
  cost_minor_units: number;
  currency: string;
  occurred_at: string | Date;
};

const toEvent = (r: UsageRow): UsageEvent => ({
  id: r.id,
  tenantId: r.tenant_id,
  runId: r.run_id as RunId,
  ...(r.conversation_id === null ? {} : { conversationId: r.conversation_id as ConversationId }),
  ...(r.step_id === null ? {} : { stepId: r.step_id }),
  ...(r.tool_call_id === null ? {} : { toolCallId: r.tool_call_id }),
  modelId: r.model_id,
  inputTokens: int(r.input_tokens),
  outputTokens: int(r.output_tokens),
  cachedInputTokens: int(r.cached_input_tokens),
  ...(r.reasoning_tokens === null ? {} : { reasoningTokens: int(r.reasoning_tokens) }),
  costMinorUnits: int(r.cost_minor_units),
  currency: r.currency,
  occurredAt: iso(r.occurred_at),
});

const USAGE_COLUMNS = `id, tenant_id, run_id, conversation_id, step_id, tool_call_id, model_id,
         input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
         cost_minor_units, currency, occurred_at`;

export const createPostgresUsageStore = (sql: SqlExecutor): UsageStore => ({
  async append({ tenantId, event }) {
    // The conflict target is the dedupe key, not the id: a recovered run may re-record the same step
    // under a fresh event id, and that must still be a no-op. Keying only on id would let it through.
    await sql.query(
      `INSERT INTO usage_records
         (tenant_id, id, dedupe_key, run_id, conversation_id, step_id, tool_call_id, model_id,
          input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
          cost_minor_units, currency, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [
        tenantId,
        event.id,
        usageDedupeKey(event),
        event.runId,
        event.conversationId ?? null,
        event.stepId ?? null,
        event.toolCallId ?? null,
        event.modelId,
        event.inputTokens,
        event.outputTokens,
        event.cachedInputTokens,
        event.reasoningTokens ?? null,
        event.costMinorUnits,
        event.currency,
        event.occurredAt,
      ],
    );
  },

  async listByRun({ tenantId, runId, limit, cursor }) {
    // Keyset paging on (occurred_at, id) — the same shape as messages (#96) and for the same reason:
    // an OFFSET would skip or repeat rows when a concurrent append lands mid-page, and usage appends
    // continuously while a run is executing.
    const rows = await sql.query<UsageRow & { cursor_occurred_at: string | Date }>(
      `WITH anchor AS (
         SELECT occurred_at, id FROM usage_records WHERE tenant_id = $1 AND id = $3
       )
       SELECT ${USAGE_COLUMNS}, occurred_at AS cursor_occurred_at
         FROM usage_records
        WHERE tenant_id = $1
          AND run_id = $2
          AND ($3::text IS NULL
               OR (occurred_at, id) > ((SELECT occurred_at FROM anchor), (SELECT id FROM anchor)))
        ORDER BY occurred_at, id
        LIMIT $4`,
      [tenantId, runId, cursor ?? null, limit + 1],
    );

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toEvent);
    const last = items[items.length - 1];
    const page: Page<UsageEvent> =
      hasMore && last ? { items, nextCursor: last.id } : { items };
    return page;
  },

  async breakdown({ tenantId, from, to, by, limit }) {
    // The grouping column is chosen from a closed union, never interpolated from user input — `by` has two
    // possible values and both are literals here.
    const column = by === "model" ? "model_id" : "COALESCE(conversation_id, '')";
    const rows = await sql.query<{
      key: string;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      reasoning_tokens: number | string;
      cost_minor_units: number | string;
      event_count: number | string;
    }>(
      `SELECT ${column} AS key,
              COALESCE(SUM(input_tokens), 0)                  AS input_tokens,
              COALESCE(SUM(output_tokens), 0)                 AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0)           AS cached_input_tokens,
              COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens,
              COALESCE(SUM(cost_minor_units), 0)             AS cost_minor_units,
              COUNT(*)                                       AS event_count
         FROM usage_records
        WHERE tenant_id = $1
          -- Half-open, like every other range here, so adjacent periods tile without a boundary event
          -- appearing in both.
          AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
        GROUP BY 1
        -- Largest cost first so a LIMIT drops what matters least; key breaks the tie so the order is stable
        -- and a rendered breakdown does not reshuffle between refreshes.
        ORDER BY cost_minor_units DESC, key
        LIMIT $4`,
      [tenantId, from, to, limit],
    );
    return rows.map((r) => ({
      key: r.key,
      totals: {
        inputTokens: int(r.input_tokens),
        outputTokens: int(r.output_tokens),
        cachedInputTokens: int(r.cached_input_tokens),
        reasoningTokens: int(r.reasoning_tokens),
        costMinorUnits: int(r.cost_minor_units),
        eventCount: int(r.event_count),
      },
    }));
  },

  async totals({ tenantId, runId, conversationId }) {
    // Aggregated in the database rather than by fetching every row: totals feed `reserve()`, which
    // runs before each provider call, and a run can accumulate thousands of usage records.
    const rows = await sql.query<{
      input_tokens: unknown;
      output_tokens: unknown;
      cached_input_tokens: unknown;
      reasoning_tokens: unknown;
      cost_minor_units: unknown;
      event_count: unknown;
    }>(
      `SELECT COALESCE(SUM(input_tokens), 0)        AS input_tokens,
              COALESCE(SUM(output_tokens), 0)       AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
              COALESCE(SUM(reasoning_tokens), 0)    AS reasoning_tokens,
              COALESCE(SUM(cost_minor_units), 0)    AS cost_minor_units,
              COUNT(*)                              AS event_count
         FROM usage_records
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR run_id = $2::text)
          AND ($3::text IS NULL OR conversation_id = $3::text)`,
      [tenantId, runId ?? null, conversationId ?? null],
    );
    const row = rows[0];
    const totals: UsageTotals = {
      inputTokens: int(row?.input_tokens),
      outputTokens: int(row?.output_tokens),
      cachedInputTokens: int(row?.cached_input_tokens),
      reasoningTokens: int(row?.reasoning_tokens),
      costMinorUnits: int(row?.cost_minor_units),
      eventCount: int(row?.event_count),
    };
    return totals;
  },
});

/**
 * The replay guard. `firstSeen` is `false` on a hit, matching the reference adapter and the type's own
 * docstring — *"True on the first execution; false when the stored result is returned"* — because a
 * stored value means the call already ran.
 *
 * No expiry column: `put` takes no TTL and the port has no prune method, so nothing could populate
 * one, and an always-NULL `expires_at` would read as a retention policy that does not exist. Pruning
 * is an operational query over `created_at`; see the open question on #100 for the policy.
 */
export const createPostgresIdempotencyStore = (sql: SqlExecutor): IdempotencyStore => ({
  async get<T>({ tenantId, key }: { tenantId: string; key: IdempotencyKey }): Promise<IdempotentResult<T> | null> {
    const rows = await sql.query<{ result: unknown }>(
      `SELECT result FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    const row = rows[0];
    if (!row) return null;
    return { key, firstSeen: false, result: json<T>(row.result) };
  },

  async put<T>({ tenantId, key, result }: { tenantId: string; key: IdempotencyKey; result: T }): Promise<void> {
    // Last write wins on a repeat, matching the reference adapter's `Map.set`. The first result is
    // what callers read back, because a caller that already got a stored result does not call `put`.
    await sql.query(
      `INSERT INTO idempotency_keys (tenant_id, key, result, created_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET result = excluded.result`,
      [tenantId, key, JSON.stringify(result ?? null)],
    );
  },
});
