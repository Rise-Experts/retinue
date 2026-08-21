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
  });
}
