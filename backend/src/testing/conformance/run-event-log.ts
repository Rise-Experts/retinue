/**
 * `RunEventLog` conformance — `docs/04` → reconnect. This log is the catch-up half of streaming and
 * the input worker recovery reconciles against, so ordering must be exact and gap-free on every
 * adapter. A missing or reordered event here becomes a client that renders duplicated or lost
 * output after a refresh.
 */

import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventLog } from "../../core/events.js";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const RUN = asId<RunId>("conf-run-1");
const OTHER = asId<RunId>("conf-run-2");

const lifecycle = (runId: RunId, sequence: number): RunEvent => ({
  type: "run.checkpointed",
  runId,
  sequence,
  occurredAt: `2020-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
});

export function runEventLogConformance(makeLog: () => RunEventLog): void {
  describe("RunEventLog conformance", () => {
    it("appends and replays the whole run with after: 0", async () => {
      const log = makeLog();
      for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([1, 2, 3]);
    });

    it("returns events strictly after the cursor, ascending — no overlap, no gap", async () => {
      const log = makeLog();
      for (const s of [1, 2, 3, 4, 5]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const after2 = await log.listAfter({ tenantId: T1, runId: RUN, after: 2 });
      expect(after2.map((e) => e.sequence)).toEqual([3, 4, 5]);
    });

    it("orders by sequence even when appended out of order", async () => {
      const log = makeLog();
      for (const s of [3, 1, 5, 2, 4]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    });

    it("honors limit while preserving order, so paged catch-up loses nothing", async () => {
      const log = makeLog();
      for (const s of [1, 2, 3, 4, 5]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const first = await log.listAfter({ tenantId: T1, runId: RUN, after: 0, limit: 2 });
      expect(first.map((e) => e.sequence)).toEqual([1, 2]);
      const last = first[first.length - 1];
      const second = await log.listAfter({ tenantId: T1, runId: RUN, after: last!.sequence, limit: 2 });
      expect(second.map((e) => e.sequence)).toEqual([3, 4]);
    });

    it("latestSequence reports the head, and 0 for a run with no events", async () => {
      const log = makeLog();
      expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(0);
      for (const s of [1, 2, 3]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(3);
    });

    it("scopes events per run", async () => {
      const log = makeLog();
      await log.append({ tenantId: T1, event: lifecycle(RUN, 1) });
      await log.append({ tenantId: T1, event: lifecycle(OTHER, 1) });
      const forRun = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(forRun).toHaveLength(1);
      expect(forRun[0]?.runId).toBe(RUN);
    });

    it("enforces tenant isolation", async () => {
      const log = makeLog();
      await log.append({ tenantId: T1, event: lifecycle(RUN, 1) });
      expect(await log.listAfter({ tenantId: T2, runId: RUN, after: 0 })).toHaveLength(0);
      expect(await log.latestSequence({ tenantId: T2, runId: RUN })).toBe(0);
    });

    /**
     * Duplicate append — added in #94 to close a gap in this harness.
     *
     * The reference adapter documents the behaviour ("Idempotent: never store a sequence twice — a
     * retried append is a no-op") but nothing here asserted it, so an adapter that *threw* on a
     * retried append would have passed this whole suite while diverging from memory. A recovered
     * worker retries appends, so it is a live path: `emit()` writes the event before the checkpoint,
     * and recovery re-runs that emit.
     */
    it("re-appending an existing sequence is a silent no-op, not an error", async () => {
      const log = makeLog();
      await log.append({ tenantId: T1, event: lifecycle(RUN, 1) });
      // Must not throw — a retried append is normal, not exceptional.
      await log.append({ tenantId: T1, event: lifecycle(RUN, 1) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([1]);
    });

    it("re-appending a sequence does not overwrite the stored event", async () => {
      const log = makeLog();
      const original: RunEvent = { ...lifecycle(RUN, 1), type: "run.started" };
      await log.append({ tenantId: T1, event: original });
      // A retry carrying different content must not silently mutate history: the first write wins,
      // so a replayed client sees the same stream it saw before the retry.
      await log.append({ tenantId: T1, event: { ...lifecycle(RUN, 1), type: "run.completed" } });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all).toHaveLength(1);
      expect(all[0]?.type).toBe("run.started");
    });

    it("keeps the sequence the caller supplied, rather than assigning its own", async () => {
      const log = makeLog();
      // The sequence is the worker's checkpoint cursor and the client's reconnect cursor. An adapter
      // that renumbered on insert (e.g. MAX(sequence)+1) would break both, so pin it explicitly.
      await log.append({ tenantId: T1, event: lifecycle(RUN, 42) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([42]);
      expect(await log.latestSequence({ tenantId: T1, runId: RUN })).toBe(42);
    });

    /**
     * The out-of-order duplicate. Found by writing the case above and reasoning about the reference
     * adapter's guard, which only tested for a duplicate when the log's *tail* sequence was >= the
     * incoming one — so an earlier out-of-order append lowered the tail and the next duplicate slipped
     * through, storing sequence 3 twice. A replaying client would then receive the same event twice,
     * breaking the "no missing or duplicated parts" guarantee `openRunEventStream` rests on.
     *
     * Postgres cannot exhibit this (the primary key forbids it), which is exactly why it belongs in
     * the shared harness: without it the two adapters diverge and only one of them is correct.
     */
    it("rejects a duplicate sequence even when appends arrive out of order", async () => {
      const log = makeLog();
      for (const s of [3, 1, 3]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      expect(all.map((e) => e.sequence)).toEqual([1, 3]);
    });

    it("appending after a gap leaves the gap — numbering is the emitter's contract", async () => {
      const log = makeLog();
      for (const s of [1, 5]) await log.append({ tenantId: T1, event: lifecycle(RUN, s) });
      const all = await log.listAfter({ tenantId: T1, runId: RUN, after: 0 });
      // The store must not invent 2..4 or renumber 5 to 2. A schema cannot enforce gaplessness; only
      // the emitter can, and the store's job is to be faithful.
      expect(all.map((e) => e.sequence)).toEqual([1, 5]);
    });
  });
}
