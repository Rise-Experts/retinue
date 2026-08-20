/**
 * `CheckpointStore` conformance — `docs/04` → durable execution. The port documents `save` as
 * **monotonic**: "a save with a lower sequence is ignored". That is what stops a slow in-flight
 * write from rewinding a recovered run, so every adapter must agree on it.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { RunId, TenantId } from "../../core/ids.js";
import type { CheckpointStore } from "../../persistence/index.js";
import { emptyCheckpoint, type RunCheckpoint } from "../../runtime/checkpoint.js";

const T1 = asId<TenantId>("conf-tenant-1");
const T2 = asId<TenantId>("conf-tenant-2");
const RUN = asId<RunId>("conf-run-1");

const at = (runId: RunId, sequence: number, step = 0): RunCheckpoint => ({
  ...emptyCheckpoint(runId, `2020-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`),
  sequence,
  step,
});

export function checkpointStoreConformance(makeStore: () => CheckpointStore): void {
  describe("CheckpointStore conformance", () => {
    it("returns null before anything is saved", async () => {
      const store = makeStore();
      expect(await store.latest({ tenantId: T1, runId: RUN })).toBeNull();
    });

    it("saves and returns the checkpoint", async () => {
      const store = makeStore();
      await store.save({ tenantId: T1, checkpoint: at(RUN, 5, 2) });
      expect(await store.latest({ tenantId: T1, runId: RUN })).toMatchObject({ sequence: 5, step: 2 });
    });

    it("advances on a higher sequence", async () => {
      const store = makeStore();
      await store.save({ tenantId: T1, checkpoint: at(RUN, 5) });
      await store.save({ tenantId: T1, checkpoint: at(RUN, 9) });
      expect((await store.latest({ tenantId: T1, runId: RUN }))?.sequence).toBe(9);
    });

    it("ignores a save with a lower sequence — monotonic, so recovery never rewinds", async () => {
      const store = makeStore();
      await store.save({ tenantId: T1, checkpoint: at(RUN, 9) });
      await store.save({ tenantId: T1, checkpoint: at(RUN, 4) });
      expect((await store.latest({ tenantId: T1, runId: RUN }))?.sequence).toBe(9);
    });

    it("treats an equal sequence as a no-op rather than an error", async () => {
      const store = makeStore();
      await store.save({ tenantId: T1, checkpoint: at(RUN, 7, 1) });
      await store.save({ tenantId: T1, checkpoint: at(RUN, 7, 1) });
      expect((await store.latest({ tenantId: T1, runId: RUN }))?.sequence).toBe(7);
    });

    it("round-trips pendingToolCalls, which recovery reconciles against", async () => {
      const store = makeStore();
      const checkpoint: RunCheckpoint = {
        ...at(RUN, 3),
        pendingToolCalls: [{ toolCallId: asId("tc1"), toolName: "search_web", startedAt: "2020-01-01T00:00:03.000Z" }],
      };
      await store.save({ tenantId: T1, checkpoint });
      const latest = await store.latest({ tenantId: T1, runId: RUN });
      expect(latest?.pendingToolCalls).toHaveLength(1);
      expect(latest?.pendingToolCalls[0]?.toolName).toBe("search_web");
    });

    it("enforces tenant isolation", async () => {
      const store = makeStore();
      await store.save({ tenantId: T1, checkpoint: at(RUN, 5) });
      expect(await store.latest({ tenantId: T2, runId: RUN })).toBeNull();
    });
  });
}
