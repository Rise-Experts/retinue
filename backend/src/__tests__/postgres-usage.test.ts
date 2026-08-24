/**
 * Postgres `UsageStore` / `IdempotencyStore` — adapter-specific cases (#100).
 *
 * The load-bearing one is **AC-3**, and it is worth being precise about where the guarantee comes
 * from. Summing ten thousand rows does *not* by itself rule out a float column: every integer below
 * 2^53 is exactly representable in float64, so an exactness check on integer costs passes either way
 * (confirmed by making the column `double precision` — the sum test still passed). Exactness therefore
 * rests on the column being an integer type, asserted directly against `information_schema`, plus
 * `SUM` widening to bigint instead of overflowing int4, asserted by a total that exceeds 2^31.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { asId } from "../core/ids.js";
import type { AgentId, ConversationId, RunId, TenantId } from "../core/ids.js";
import type { IdempotencyKey } from "../idempotency/index.js";
import type { UsageEvent } from "../usage/index.js";
import { usageDedupeKey } from "../usage/index.js";
import {
  createPostgresConversationStore,
  createPostgresIdempotencyStore,
  createPostgresRunStore,
  createPostgresSessionStateStore,
  createPostgresUnitOfWork,
  createPostgresUsageStore,
  createSingleConnectionOpener,
  createTransactionScope,
  migrate,
  rollback,
  type SqlExecutor,
} from "../adapters/postgres/index.js";
import { freshPgliteSchema } from "../testing/pglite.js";

const T1 = asId<TenantId>("pg-u-t1");
const T2 = asId<TenantId>("pg-u-t2");
const C1 = asId<ConversationId>("pg-u-c1");
const RUN = asId<RunId>("pg-u-run1");
const AGENT = asId<AgentId>("pg-u-agent");
const NOW = "2020-01-01T00:00:00.000Z";

const pglite = (db: PGlite): SqlExecutor => ({
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
    return db.query(text, params ? [...params] : undefined).then((r) => r.rows as Row[]);
  },
});

const event = (id: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
  id,
  tenantId: T1,
  runId: RUN,
  conversationId: C1,
  stepId: `step-${id}`,
  modelId: "claude-opus-5",
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 10,
  reasoningTokens: 5,
  costMinorUnits: 250,
  currency: "EUR",
  occurredAt: NOW,
  ...over,
});

/** A migrated database with the run usage records reference, plus a transaction scope for AC-2. */
const seeded = async () => {
  const { sql: base } = await freshPgliteSchema();
  const scope = createTransactionScope(createSingleConnectionOpener(base));
  const sql = scope.scoped(base);
  await createPostgresConversationStore(sql).create({ tenantId: T1, id: C1, title: "thread" });
  await createPostgresRunStore(sql).create({
    tenantId: T1,
    id: RUN,
    conversationId: C1,
    agentId: AGENT,
    agentVersion: 1,
  });
  return { sql, runner: scope.runner };
};

describe("migration 0009", () => {
  it("migrates up, rolls back, and re-migrates", async () => {
    const { sql } = await freshPgliteSchema();
    for (const t of ["usage_records", "idempotency_keys"]) await sql.query(`SELECT 1 FROM ${t} LIMIT 1`);
    await rollback(sql);
    await expect(sql.query("SELECT 1 FROM usage_records LIMIT 1")).rejects.toThrow();
    await migrate(sql);
    await sql.query("SELECT 1 FROM usage_records LIMIT 1");
  });

  it("names the cost column in minor units, not micros, and carries the currency", async () => {
    const { sql } = await seeded();
    const cols = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'usage_records' AND table_schema = current_schema()`,
    );
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));

    // The SPEC said `cost_micros bigint`. The field is `costMinorUnits` — minor units are 10^-2,
    // micros are 10^-6, so that name sets up a 10000x error in exactly the rollups it was meant to
    // make exact.
    expect(byName.has("cost_micros")).toBe(false);
    expect(byName.get("cost_minor_units")).toBe("integer");
    // And the SPEC omitted currency entirely, without which a minor-unit integer means nothing:
    // 250 is EUR 2.50 or JPY 250.
    expect(byName.get("currency")).toBe("text");
    // step_id is load-bearing for append idempotency.
    expect(byName.has("step_id")).toBe(true);
    /**
     * `principal_id` **is** required now — #175.
     *
     * This asserted its *absence*, on the reasoning that nothing could populate it. That was true and is the
     * right instinct: a column no code writes is a column that reads as data and holds nothing. The recorder
     * stamps it from the execution context now, so the reasoning has expired rather than been wrong.
     *
     * Kept as an assertion rather than deleted, because "who spent this" being unanswerable was the bug, and a
     * dropped column would make it unanswerable again with nothing to notice.
     */
    expect(byName.has("principal_id")).toBe(true);
  });

  it("carries no scope or expires_at on idempotency_keys, because nothing could fill them", async () => {
    const { sql } = await seeded();
    const cols = await sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'idempotency_keys' AND table_schema = current_schema()`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    // `put({tenantId, key, result})` takes no TTL and the port has no prune method. An always-NULL
    // expires_at would read as a retention policy that does not exist. See the open question on #100.
    expect(names.has("scope")).toBe(false);
    expect(names.has("expires_at")).toBe(false);
    // created_at is the mechanism a prune needs, which is what AC-5 actually asks for.
    expect(names.has("created_at")).toBe(true);
  });

  it("rejects negative tokens and negative cost", async () => {
    const { sql } = await seeded();
    for (const column of ["input_tokens", "cost_minor_units"]) {
      await expect(
        sql.query(
          `INSERT INTO usage_records
             (tenant_id, id, dedupe_key, run_id, model_id, input_tokens, output_tokens,
              cached_input_tokens, cost_minor_units, currency, occurred_at)
           VALUES ($1, 'bad-${column}', 'dk-${column}', $2, 'm', ${column === "input_tokens" ? "-1" : "0"},
                   0, 0, ${column === "cost_minor_units" ? "-1" : "0"}, 'EUR', now())`,
          [T1, RUN],
        ),
      ).rejects.toThrow();
    }
  });

  it("removes usage records with their run", async () => {
    const { sql } = await seeded();
    const store = createPostgresUsageStore(sql);
    await store.append({ tenantId: T1, event: event("u1") });
    await sql.query(`DELETE FROM runs WHERE tenant_id = $1 AND id = $2`, [T1, RUN]);
    expect((await store.totals({ tenantId: T1, runId: RUN })).eventCount).toBe(0);
  });

  it("serves the run listing and the rollup scan from indexes", async () => {
    const { sql } = await seeded();
    for (const q of [
      [`EXPLAIN SELECT 1 FROM usage_records WHERE tenant_id = $1 AND run_id = $2 ORDER BY occurred_at, id`, [T1, RUN]],
      [`EXPLAIN SELECT 1 FROM usage_records WHERE tenant_id = $1 ORDER BY occurred_at, id`, [T1]],
    ] as const) {
      const plan = await sql.query<Record<string, string>>(q[0], q[1] as readonly unknown[]);
      expect(plan.map((r) => Object.values(r)[0]).join("\n")).not.toContain("Seq Scan");
    }
  });
});

/**
 * AC-3. The failure mode is silent — a rollup that disagrees with a provider invoice by fractions,
 * noticed at reconciliation time if at all. See the module docstring for which assertion actually
 * closes which half of it.
 */
describe("exact integer cost aggregation", () => {
  it("sums ten thousand records past the 32-bit ceiling without losing precision", async () => {
    const { sql } = await seeded();
    // Generated in SQL rather than through 10,000 round-trips: what is under test is the database's
    // aggregation over the column type, not the store's insert path (covered above).
    //
    // The per-row cost is chosen so the *sum* exceeds int4's ceiling while each *row* stays under it.
    // That is what makes this test discriminate. Note what it does NOT prove: a `double precision`
    // column would also pass an exactness check on integer inputs, because every integer below 2^53
    // is exactly representable in float64 — verified by making the column a float, at which point
    // this test still passed and only the schema assertion above caught it. So "costs are exact"
    // rests on two things: the column being an integer type (asserted above) and `SUM` widening to
    // bigint rather than overflowing (asserted here), plus the JS side reading that bigint back
    // without truncation.
    await sql.query(
      `INSERT INTO usage_records
         (tenant_id, id, dedupe_key, run_id, model_id, input_tokens, output_tokens,
          cached_input_tokens, cost_minor_units, currency, occurred_at)
       SELECT $1, 'gen-' || n, 'gen-dk-' || n, $2, 'm', 1, 1, 0, n * 200000, 'EUR',
              timestamptz '2020-01-01 00:00:00Z' + (n * interval '1 second')
         FROM generate_series(1, 10000) AS n`,
      [T1, RUN],
    );

    const totals = await createPostgresUsageStore(sql).totals({ tenantId: T1, runId: RUN });
    // 200000 * sum(1..10000) = 200000 * 50005000
    const expected = 200_000 * ((10_000 * 10_001) / 2);
    expect(expected).toBe(10_001_000_000_000);
    // Comfortably past int4's 2,147,483,647 ceiling, and comfortably inside JS's exact-integer range.
    expect(expected).toBeGreaterThan(2 ** 31);
    expect(expected).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(totals.costMinorUnits).toBe(expected);
    expect(Number.isInteger(totals.costMinorUnits)).toBe(true);
    expect(totals.eventCount).toBe(10_000);
    expect(totals.inputTokens).toBe(10_000);
  }, 60_000);

  it("stores a fractional cost as an integer rather than silently keeping the fraction", async () => {
    const { sql } = await seeded();
    // costMinorUnits is documented as an integer. An integer column makes a fractional value
    // impossible to store as-is, which is the property that keeps fractions out of a rollup.
    await sql.query(
      `INSERT INTO usage_records
         (tenant_id, id, dedupe_key, run_id, model_id, input_tokens, output_tokens,
          cached_input_tokens, cost_minor_units, currency, occurred_at)
       VALUES ($1, 'frac', 'frac-dk', $2, 'm', 0, 0, 0, 2.5, 'EUR', now())`,
      [T1, RUN],
    );
    const rows = await sql.query<{ cost_minor_units: number }>(
      `SELECT cost_minor_units FROM usage_records WHERE id = 'frac'`,
    );
    expect(Number.isInteger(Number(rows[0]!.cost_minor_units))).toBe(true);
  });

  it("scopes totals to a conversation as well as a run", async () => {
    const { sql } = await seeded();
    const other = asId<ConversationId>("pg-u-c2");
    await createPostgresConversationStore(sql).create({ tenantId: T1, id: other, title: "other" });
    const store = createPostgresUsageStore(sql);
    await store.append({ tenantId: T1, event: event("u1") });
    await store.append({ tenantId: T1, event: event("u2", { conversationId: other }) });
    expect((await store.totals({ tenantId: T1, conversationId: C1 })).eventCount).toBe(1);
    expect((await store.totals({ tenantId: T1 })).eventCount).toBe(2);
  });
});

/** AC-1, the duplicate half. "No gaps" is one failure; double-counting is the other, and it costs money. */
describe("append idempotency on the shared dedupe key", () => {
  it("treats a re-recorded step as a no-op even under a fresh event id", async () => {
    const { sql } = await seeded();
    const store = createPostgresUsageStore(sql);
    await store.append({ tenantId: T1, event: event("u1", { stepId: "step-7" }) });
    // A recovered run re-records the step it already logged, and generates a new event id doing so.
    // Keying only on `id` would let this through and double-bill the step.
    await store.append({ tenantId: T1, event: event("u2", { stepId: "step-7" }) });
    const totals = await store.totals({ tenantId: T1, runId: RUN });
    expect(totals.eventCount).toBe(1);
    expect(totals.costMinorUnits).toBe(250);
  });

  it("falls back to the event id when there is no step, matching the reference adapter", async () => {
    const { sql } = await seeded();
    const store = createPostgresUsageStore(sql);
    const stepless = { ...event("u1"), stepId: undefined };
    expect(usageDedupeKey(stepless)).toBe("u1");
    await store.append({ tenantId: T1, event: stepless });
    await store.append({ tenantId: T1, event: stepless });
    expect((await store.totals({ tenantId: T1, runId: RUN })).eventCount).toBe(1);
  });

  it("pages by a stable cursor without repeating or dropping a row", async () => {
    const { sql } = await seeded();
    const store = createPostgresUsageStore(sql);
    for (let n = 1; n <= 5; n += 1) {
      await store.append({
        tenantId: T1,
        event: event(`u${n}`, { occurredAt: `2020-01-01T00:00:0${n}.000Z` }),
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listByRun({
        tenantId: T1,
        runId: RUN,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    // Every row exactly once, in order — the property an OFFSET loses under concurrent appends.
    expect(seen).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("enforces tenant isolation on totals", async () => {
    const { sql } = await seeded();
    const store = createPostgresUsageStore(sql);
    await store.append({ tenantId: T1, event: event("u1") });
    expect((await store.totals({ tenantId: T2, runId: RUN })).eventCount).toBe(0);
  });
});

/** AC-2 — usage is written in the completion transaction, so it rolls back with it. */
describe("usage inside the completion transaction", () => {
  it("leaves no record when the completion fails after the usage write", async () => {
    const { sql, runner } = await seeded();
    const usage = createPostgresUsageStore(sql);
    const sessions = createPostgresSessionStateStore(sql);
    const uow = createPostgresUnitOfWork(runner);

    await expect(
      uow.run(async () => {
        await usage.append({ tenantId: T1, event: event("u1") });
        await sessions.put({ tenantId: T1, conversationId: C1, expectedVersion: 0, data: { done: true } });
        throw new Error("completion failed");
      }),
    ).rejects.toThrow("completion failed");

    // A partial commit here would bill for work the conversation has no memory of doing.
    expect((await usage.totals({ tenantId: T1, runId: RUN })).eventCount).toBe(0);
    expect(await sessions.get({ tenantId: T1, conversationId: C1 })).toBeNull();
  });

  it("commits the record when the completion succeeds", async () => {
    const { sql, runner } = await seeded();
    const usage = createPostgresUsageStore(sql);
    await createPostgresUnitOfWork(runner).run(async () => {
      await usage.append({ tenantId: T1, event: event("u1") });
    });
    expect((await usage.totals({ tenantId: T1, runId: RUN })).eventCount).toBe(1);
  });
});

/** AC-4 and AC-5. */
describe("idempotency keys", () => {
  const KEY = "pg-u-t1:pg-u-run1:call-1" as IdempotencyKey;

  it("returns the stored result with firstSeen false, so the operation is not repeated", async () => {
    const { sql } = await seeded();
    const store = createPostgresIdempotencyStore(sql);
    expect(await store.get({ tenantId: T1, key: KEY })).toBeNull();

    let executions = 0;
    const runGuarded = async (): Promise<{ postId: string }> => {
      const existing = await store.get<{ postId: string }>({ tenantId: T1, key: KEY });
      if (existing) return existing.result;
      executions += 1;
      const result = { postId: "post-123" };
      await store.put({ tenantId: T1, key: KEY, result });
      return result;
    };

    const first = await runGuarded();
    const second = await runGuarded();
    // One execution, identical results — the pairing that makes a retried publish safe.
    expect(executions).toBe(1);
    expect(second).toEqual(first);
    expect((await store.get<{ postId: string }>({ tenantId: T1, key: KEY }))?.firstSeen).toBe(false);
  });

  it("round-trips a nested result under deep equality", async () => {
    const { sql } = await seeded();
    const store = createPostgresIdempotencyStore(sql);
    const result = { ids: [1, 2, 3], nested: { ok: true, note: null } };
    await store.put({ tenantId: T1, key: KEY, result });
    expect((await store.get({ tenantId: T1, key: KEY }))?.result).toEqual(result);
  });

  it("scopes keys per tenant", async () => {
    const { sql } = await seeded();
    const store = createPostgresIdempotencyStore(sql);
    await store.put({ tenantId: T1, key: KEY, result: { a: 1 } });
    // A shared key space would let one tenant's retry return another tenant's result.
    expect(await store.get({ tenantId: T2, key: KEY })).toBeNull();
  });

  it("allows a bounded age-based prune to run alongside a live insert", async () => {
    const { sql } = await seeded();
    const store = createPostgresIdempotencyStore(sql);
    for (let n = 0; n < 50; n += 1) {
      await store.put({ tenantId: T1, key: `old-${n}` as IdempotencyKey, result: { n } });
    }
    await sql.query(`UPDATE idempotency_keys SET created_at = now() - interval '30 days'`);

    // AC-5's mechanism. Bounded by a subselect so a prune never turns into an unbounded delete that
    // holds locks across the whole table — the "without blocking live writes" half. Which rows are
    // *eligible* is a retention policy this SPEC cannot decide; see the open question on #100.
    const [pruned, inserted] = await Promise.all([
      sql.query(
        `DELETE FROM idempotency_keys
          WHERE (tenant_id, key) IN (
            SELECT tenant_id, key FROM idempotency_keys
             WHERE created_at < now() - interval '7 days'
             ORDER BY created_at
             LIMIT 20
          )
          RETURNING key`,
      ),
      store.put({ tenantId: T1, key: "fresh" as IdempotencyKey, result: { live: true } }),
    ]);

    expect(pruned).toHaveLength(20);
    void inserted;
    // The live write survived the prune, and the still-recent key is untouched.
    expect(await store.get({ tenantId: T1, key: "fresh" as IdempotencyKey })).not.toBeNull();
    const left = await sql.query(`SELECT 1 FROM idempotency_keys`);
    expect(left).toHaveLength(31);
  });
});
