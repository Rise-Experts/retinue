import { describe, expect, it } from "vitest";
import { freshPgliteSchema } from "../testing/pglite.js";
import { DEFAULT_HARNESS, DEFAULT_TRAFFIC, createHarness } from "../loadtest/index.js";
import { asId } from "../core/ids.js";
import type { ConversationId, RunId, TenantId } from "../core/ids.js";

/**
 * The harness against a real migrated schema — #144.
 *
 * `approvePending` and `settle` cannot be tested against fakes: they are SQL over the `runs` table, and the bugs
 * they had were both about *rows in a status nothing would pick up*. A fake store would have had whatever
 * behaviour I gave it, which is the behaviour I already believed.
 *
 * PGlite, not a real server. One embedded instance means a claim race between competing workers is unobservable
 * here — that is what the `--pg` harness runs are for. What *is* observable is the orphan bug, which needs no
 * concurrency at all: it is one run, in `queued`, that nothing enqueued.
 */

const T = asId<TenantId>("lt-t1");

const harnessOn = async (over: Partial<typeof DEFAULT_HARNESS> = {}) => {
  const { sql } = await freshPgliteSchema();
  const harness = await createHarness({
    sql,
    config: {
      ...DEFAULT_HARNESS,
      tenantId: T,
      workers: 2,
      concurrency: 2,
      // Every run pauses for a human, so the approval path is the whole test rather than a tenth of it.
      traffic: { ...DEFAULT_TRAFFIC, steps: 3, modelLatencyMs: 1, approvalRate: 1, externalActionRate: 1 },
      ...over,
    },
    sleep: async () => {},
  });
  return { harness, sql };
};

describe("the load harness against a real schema", () => {
  it("drives a run to completion through the durable path", async () => {
    const { harness } = await harnessOn({ traffic: { ...DEFAULT_TRAFFIC, steps: 2, modelLatencyMs: 1, approvalRate: 0 } });
    for (let i = 0; i < 6; i += 1)
      await harness.admit({ conversationId: asId<ConversationId>(`c${i}`), runId: asId<RunId>(`plain-r${i}`) });
    const settled = await harness.settle({ idPrefix: "plain-r", timeoutMs: 15_000 });
    await harness.stop();
    expect(settled.completed).toBe(6);
    expect(settled.stuck).toBe(0);
  });

  /**
   * The bug, reproduced.
   *
   * Every run suspends for approval, and the queue's bound is far smaller than the number of them. The first
   * version of `approvePending` transitioned *all* of them to `queued` and then had most of the enqueues refused,
   * leaving them in `queued` with no job — 1,293 orphans in one soak, and a settle loop that spun to its timeout
   * looking for `waiting-for-approval` rows that no longer existed.
   *
   * The same failure shape as the platform bug this harness found an hour earlier, reintroduced by copying the
   * fix's ordering without noticing that a bounded queue can refuse.
   */
  it("resumes every approval-paused run even when the queue is far smaller than the batch", async () => {
    const { harness } = await harnessOn({ maxQueueDepth: 4 });
    const total = 30;
    for (let i = 0; i < total; i += 1)
      await harness.admit({ conversationId: asId<ConversationId>(`c${i % 3}`), runId: asId<RunId>(`appr-r${i}`) })
        // A refused admission is expected here and is not what is under test; the paused runs are.
        .catch(() => undefined);

    const settled = await harness.settle({ idPrefix: "appr-r", timeoutMs: 30_000 });
    await harness.stop();

    // Nothing left in a non-terminal state. An orphan in `queued` is invisible — it looks exactly like a run
    // waiting its turn — so the assertion has to be on the count, not on a status anyone eyeballs.
    expect(settled.stuck, "runs orphaned in a status nothing will pick up").toBe(0);
    expect(settled.completed).toBeGreaterThan(0);
    expect(settled.failed).toBe(0);
  });

  it("performs each run's external effect exactly once across a suspend and resume", async () => {
    const { harness } = await harnessOn({ maxQueueDepth: 8 });
    const admitted: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const runId = `eff-r${i}`;
      await harness
        .admit({ conversationId: asId<ConversationId>(`c${i % 3}`), runId: asId<RunId>(runId) })
        .then(() => admitted.push(runId))
        .catch(() => undefined);
    }
    await harness.settle({ idPrefix: "eff-r", timeoutMs: 30_000 });
    await harness.stop();

    // The assertion that matters. Every run suspends mid-flight and resumes; the effect key is derived from run
    // and step, so a repeat would show as more effects than distinct keys.
    expect(harness.effects.performed.length).toBe(harness.effects.distinctKeys());
    expect(harness.effects.distinctKeys()).toBeGreaterThan(0);
  });

  it("cancels a run whose enqueue was refused, rather than leaving it queued", async () => {
    const { harness, sql } = await harnessOn({ maxQueueDepth: 2, workers: 1, concurrency: 1 });
    let refused = 0;
    for (let i = 0; i < 40; i += 1)
      await harness
        .admit({ conversationId: asId<ConversationId>("c0"), runId: asId<RunId>(`ref-r${i}`) })
        .catch(() => {
          refused += 1;
        });
    expect(refused, "the bound must actually be hit or this test proves nothing").toBeGreaterThan(0);

    const rows = await sql.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM runs WHERE tenant_id = $1 AND id LIKE 'ref-r%' AND status = 'cancelled'",
      [T],
    );
    await harness.stop();
    // A refused admission is not admitted work. Leaving the row `queued` made the overload step report the same
    // runs twice — once correctly as refusals and once as lost work.
    expect(Number(rows[0]?.n)).toBe(refused);
  });

  it("reports a run that never reaches a terminal state instead of waiting forever", async () => {
    const { harness } = await harnessOn({ maxQueueDepth: 4 });
    for (let i = 0; i < 8; i += 1)
      await harness.admit({ conversationId: asId<ConversationId>("c0"), runId: asId<RunId>(`stuck-r${i}`) }).catch(() => undefined);
    // Stop the workers first, so nothing can progress. `settle` must give up and *say so* — waiting forever would
    // hide a genuine hang, and not waiting at all reports one that is not there.
    await harness.stop();
    const settled = await harness.settle({ idPrefix: "stuck-r", timeoutMs: 1_500 });
    expect(settled.stuck).toBeGreaterThan(0);
    expect(settled.stuckByStatus).toBeDefined();
  });
});
