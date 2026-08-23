/**
 * Postgres `UsageRollupStore` (#139).
 *
 * Two properties are in the SQL rather than above it.
 *
 * **`rebuild` is one statement.** It aggregates the bucket's raw events and upserts the row, so the read and
 * the write cannot see different data — a read-then-write would let an event land between them and be lost from
 * the rollup while sitting in the ledger, which is the "no lost records" half of AC-4.
 *
 * **Idempotency is the primary key.** `ON CONFLICT (tenant_id, period, bucket_start) DO UPDATE` means a
 * re-run replaces rather than accumulates, and two workers racing one bucket write the same value. No applied-
 * event set, nothing to keep exactly right forever, and no way to double count.
 */

import type { Page } from "../../core/context.js";
import type {
  RollupPeriod,
  UsageRollup,
  UsageRollupStore,
  UsageTotals,
} from "../../persistence/index.js";
import type { SqlExecutor } from "./sql.js";

type Row = {
  period: string;
  bucket_start: string | Date;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_input_tokens: number | string;
  reasoning_tokens: number | string;
  cost_minor_units: number | string;
  event_count: number | string;
  currency: string;
  computed_at: string | Date;
};

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

/**
 * `bigint` comes back as a string from node-postgres — correct past 2^53 and wrong for arithmetic.
 *
 * Narrowed here because every one of these is well inside the safe range: a tenant would need 9×10^15 tokens
 * in one hour to overflow. Left as strings, a caller adding two rollups would concatenate them.
 */
const toRollup = (r: Row): UsageRollup => ({
  period: r.period as RollupPeriod,
  bucketStart: iso(r.bucket_start),
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cachedInputTokens: Number(r.cached_input_tokens),
  reasoningTokens: Number(r.reasoning_tokens),
  costMinorUnits: Number(r.cost_minor_units),
  eventCount: Number(r.event_count),
  currency: r.currency,
  computedAt: iso(r.computed_at),
});

const COLUMNS = `period, bucket_start, input_tokens, output_tokens, cached_input_tokens,
                 reasoning_tokens, cost_minor_units, event_count, currency, computed_at`;

/** The interval a period spans, as a SQL literal. Two values, both from a closed union — never user input. */
const intervalFor = (period: RollupPeriod): string => (period === "hour" ? "1 hour" : "1 day");

export const createPostgresUsageRollupStore = (sql: SqlExecutor): UsageRollupStore => ({
  async rebuild({ tenantId, period, bucketStart }) {
    const rows = await sql.query<Row>(
      `WITH agg AS (
         SELECT COALESCE(SUM(input_tokens), 0)        AS input_tokens,
                COALESCE(SUM(output_tokens), 0)       AS output_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                -- reasoning_tokens is nullable in usage_records (not every provider reports it), so the
                -- COALESCE is inside the SUM as well as outside: SUM ignores NULLs, but a bucket where *every*
                -- row is NULL sums to NULL rather than 0.
                COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens,
                COALESCE(SUM(cost_minor_units), 0)   AS cost_minor_units,
                COUNT(*)                             AS event_count,
                -- One currency per bucket. MIN rather than an arbitrary pick so the value is deterministic:
                -- two rebuilds of the same bucket must agree, and a mixed-currency bucket is a configuration
                -- problem the reconciliation report surfaces rather than something to paper over here.
                COALESCE(MIN(currency), '')          AS currency,
                -- The high-water mark this rollup covers. Recorded so staleness is an integer comparison
                -- rather than a clock comparison -- see 0019.
                COALESCE(MAX(record_seq), 0)         AS covers_seq
           FROM usage_records
          WHERE tenant_id = $1
            AND occurred_at >= $3::timestamptz
            AND occurred_at <  $3::timestamptz + INTERVAL '${intervalFor(period)}'
       )
       INSERT INTO usage_rollups (tenant_id, period, bucket_start, input_tokens, output_tokens,
                                  cached_input_tokens, reasoning_tokens, cost_minor_units, event_count,
                                  currency, computed_at, covers_seq)
       SELECT $1, $2, $3::timestamptz, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
              -- clock_timestamp(), not now(). now() is the *transaction* timestamp and therefore constant
              -- within one -- so a rebuild and an append in the same transaction would stamp the identical
              -- instant, the staleness comparison would always hold, and the bucket would be rebuilt forever.
              -- Found by the conformance suite, whose executor is transaction-scoped.
              cost_minor_units, event_count, currency, clock_timestamp(), covers_seq
         FROM agg
       -- The upsert *is* the idempotency: a re-run replaces rather than accumulates, and two workers racing
       -- this bucket write the same value. DO UPDATE rather than DO NOTHING because a rebuild after new events
       -- must actually change the row.
       ON CONFLICT (tenant_id, period, bucket_start) DO UPDATE SET
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         cached_input_tokens = EXCLUDED.cached_input_tokens,
         reasoning_tokens = EXCLUDED.reasoning_tokens,
         cost_minor_units = EXCLUDED.cost_minor_units,
         event_count = EXCLUDED.event_count,
         currency = EXCLUDED.currency,
         computed_at = EXCLUDED.computed_at,
         covers_seq = EXCLUDED.covers_seq
       RETURNING ${COLUMNS}`,
      [tenantId, period, bucketStart],
    );
    const row = rows[0];
    if (row === undefined)
      // Unreachable: the CTE always produces one row, even for an empty bucket. Returned rather than thrown so
      // a caller never has to handle an impossible null.
      return {
        period,
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costMinorUnits: 0,
        eventCount: 0,
        currency: "",
        computedAt: new Date().toISOString(),
      };
    return toRollup(row);
  },

  async get({ tenantId, period, bucketStart }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM usage_rollups
        WHERE tenant_id = $1 AND period = $2 AND bucket_start = $3::timestamptz`,
      [tenantId, period, bucketStart],
    );
    // A foreign tenant's bucket yields no row, so no aggregate can span tenants and the answer is null without
    // a comparison anyone could get wrong.
    return rows[0] === undefined ? null : toRollup(rows[0]);
  },

  async list({ tenantId, period, from, to, limit, cursor }) {
    const rows = await sql.query<Row>(
      `SELECT ${COLUMNS} FROM usage_rollups
        WHERE tenant_id = $1 AND period = $2
          AND bucket_start >= $3::timestamptz
          -- Exclusive upper bound, so adjacent ranges tile without a caller double-counting a boundary bucket.
          AND bucket_start <  $4::timestamptz
          AND ($5::text IS NULL OR bucket_start > $5::timestamptz)
        ORDER BY bucket_start
        LIMIT $6`,
      [tenantId, period, from, to, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(toRollup);
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: last.bucketStart }
      : ({ items } satisfies Page<UsageRollup>);
  },

  async sum({ tenantId, period, from, to }) {
    const rows = await sql.query<{
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      reasoning_tokens: number | string;
      cost_minor_units: number | string;
      event_count: number | string;
    }>(
      // Over the *rollups*, which is the point of AC-1: a spend query never scans raw records however much has
      // been recorded.
      `SELECT COALESCE(SUM(input_tokens), 0)        AS input_tokens,
              COALESCE(SUM(output_tokens), 0)       AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
              COALESCE(SUM(reasoning_tokens), 0)   AS reasoning_tokens,
              COALESCE(SUM(cost_minor_units), 0)   AS cost_minor_units,
              COALESCE(SUM(event_count), 0)        AS event_count
         FROM usage_rollups
        WHERE tenant_id = $1 AND period = $2
          AND bucket_start >= $3::timestamptz AND bucket_start < $4::timestamptz`,
      [tenantId, period, from, to],
    );
    const r = rows[0];
    return {
      inputTokens: Number(r?.input_tokens ?? 0),
      outputTokens: Number(r?.output_tokens ?? 0),
      cachedInputTokens: Number(r?.cached_input_tokens ?? 0),
      reasoningTokens: Number(r?.reasoning_tokens ?? 0),
      costMinorUnits: Number(r?.cost_minor_units ?? 0),
      eventCount: Number(r?.event_count ?? 0),
    } satisfies UsageTotals;
  },

  async listStaleBuckets({ tenantId, period, since, limit, cursor }) {
    const rows = await sql.query<{ bucket_start: string | Date }>(
      // Derived from the ledger: a bucket is stale when it holds an event at or after its last computation, or
      // has never been computed. So the job's work list needs no persisted cursor -- an interrupted run resumes
      // by asking again, and there is nothing to lose.
      `WITH buckets AS (
         SELECT date_trunc($2, occurred_at) AS bucket_start,
                -- The newest *sequence* in this bucket, not the newest time. An event recorded late with an
                -- occurred_at in the past still has a higher sequence, so its bucket is correctly stale.
                MAX(record_seq)             AS newest_seq
           FROM usage_records
          WHERE tenant_id = $1 AND occurred_at >= $3::timestamptz
          GROUP BY 1
       )
       SELECT b.bucket_start
         FROM buckets b
         LEFT JOIN usage_rollups r
           ON r.tenant_id = $1 AND r.period = $2 AND r.bucket_start = b.bucket_start
        -- Parenthesised deliberately: AND binds tighter than OR, so without these the cursor filter would
        -- apply only to the second branch and every never-computed bucket would come back on every page.
        -- Strictly greater: an integer comparison with no ties, so a drained bucket is *not* listed.
        WHERE (r.bucket_start IS NULL OR COALESCE(r.covers_seq, 0) < b.newest_seq)
          AND ($4::text IS NULL OR b.bucket_start > $4::timestamptz)
        ORDER BY b.bucket_start
        LIMIT $5`,
      [tenantId, period, since, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => ({ period, bucketStart: iso(r.bucket_start) }));
    const last = items[items.length - 1];
    return rows.length > limit && last !== undefined
      ? { items, nextCursor: last.bucketStart }
      : { items };
  },
});
