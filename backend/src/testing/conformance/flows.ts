/**
 * The flow stores' shared contract — #187, #186.
 *
 * Runs against every adapter, so "the Postgres one behaves like the reference" is a fact rather than a claim about
 * two hundred lines nobody compared. Two cases matter more than the rest and are the reason this file exists
 * rather than per-adapter tests:
 *
 * - **A version cannot be overwritten.** An execution pins the version it started with and reads it for its whole
 *   life, so a definition that could change under it would change an automation's shape halfway through.
 * - **`save` is monotonic.** Two workers holding the same execution must not let the slower one move it
 *   backwards, because a flow that goes backwards re-performs external writes.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { PrincipalId, RunId, TenantId } from "../../core/ids.js";
import type {
  FlowDefinitionStore,
  FlowExecutionStore,
  StoredFlowDefinition,
  StoredFlowExecution,
} from "../../persistence/index.js";

const T1 = asId<TenantId>("tenant-1");
const T2 = asId<TenantId>("tenant-2");

const definition = (over: Partial<StoredFlowDefinition> = {}): StoredFlowDefinition => ({
  flowId: "onboard",
  version: 1,
  name: "Onboarding",
  kind: "flow",
  definition: { steps: [{ name: "a", kind: "done" }], start: "a" },
  createdAt: "2026-08-26T10:00:00.000Z",
  createdBy: asId<PrincipalId>("p1"),
  ...over,
});

const execution = (over: Partial<StoredFlowExecution> = {}): StoredFlowExecution => ({
  id: "exec-1",
  flowId: "onboard",
  flowVersion: 1,
  runId: asId<RunId>("run-1"),
  status: "running",
  currentStep: "a",
  steps: 0,
  execution: { state: {} },
  startedAt: "2026-08-26T10:00:00.000Z",
  ...over,
});

export function flowDefinitionStoreConformance(make: () => FlowDefinitionStore): void {
  describe("FlowDefinitionStore conformance", () => {
    it("stores and reads a definition by version", async () => {
      const store = make();
      await store.put({ tenantId: T1, definition: definition() });
      const read = await store.get({ tenantId: T1, flowId: "onboard", version: 1 });
      expect(read?.name).toBe("Onboarding");
      expect(read?.definition).toEqual({ steps: [{ name: "a", kind: "done" }], start: "a" });
    });

    it("refuses to overwrite a version", async () => {
      // The property an execution's version pin depends on. Without it, "the definition at version 1" is not a
      // stable thing to have pinned.
      const store = make();
      await store.put({ tenantId: T1, definition: definition() });
      await expect(store.put({ tenantId: T1, definition: definition({ name: "changed" }) })).rejects.toThrow();
      expect((await store.get({ tenantId: T1, flowId: "onboard", version: 1 }))?.name).toBe("Onboarding");
    });

    it("keeps versions side by side and reports the latest", async () => {
      const store = make();
      await store.put({ tenantId: T1, definition: definition({ version: 1 }) });
      await store.put({ tenantId: T1, definition: definition({ version: 3, name: "v3" }) });
      await store.put({ tenantId: T1, definition: definition({ version: 2, name: "v2" }) });

      expect((await store.latest({ tenantId: T1, flowId: "onboard" }))?.version).toBe(3);
      // Every earlier version is still readable: an execution pinned to 1 must still find it.
      expect((await store.get({ tenantId: T1, flowId: "onboard", version: 1 }))?.name).toBe("Onboarding");
    });

    it("returns null for an unknown flow or version rather than throwing", async () => {
      const store = make();
      expect(await store.get({ tenantId: T1, flowId: "nope", version: 1 })).toBeNull();
      expect(await store.latest({ tenantId: T1, flowId: "nope" })).toBeNull();
    });

    it("does not resolve another tenant's definition", async () => {
      const store = make();
      await store.put({ tenantId: T1, definition: definition() });
      expect(await store.get({ tenantId: T2, flowId: "onboard", version: 1 })).toBeNull();
      expect(await store.latest({ tenantId: T2, flowId: "onboard" })).toBeNull();
    });

    it("lists the latest version of each flow, not every version", async () => {
      const store = make();
      await store.put({ tenantId: T1, definition: definition({ version: 1 }) });
      await store.put({ tenantId: T1, definition: definition({ version: 2 }) });
      await store.put({ tenantId: T1, definition: definition({ flowId: "other", version: 1 }) });

      const listed = await store.list({ tenantId: T1, limit: 50 });
      expect(listed.items.map((d) => [d.flowId, d.version]).sort()).toEqual([
        ["onboard", 2],
        ["other", 1],
      ]);
    });

    it("pages the list", async () => {
      const store = make();
      for (const flowId of ["a", "b", "c"]) await store.put({ tenantId: T1, definition: definition({ flowId }) });
      const first = await store.list({ tenantId: T1, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const second = await store.list({ tenantId: T1, limit: 2, cursor: first.nextCursor });
      expect(second.items.map((d) => d.flowId)).toEqual(["c"]);
    });
  });
}

export function flowExecutionStoreConformance(make: () => FlowExecutionStore): void {
  describe("FlowExecutionStore conformance", () => {
    it("creates and reads an execution", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution() });
      expect((await store.get({ tenantId: T1, executionId: "exec-1" }))?.currentStep).toBe("a");
    });

    it("refuses to create the same execution twice", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution() });
      await expect(store.create({ tenantId: T1, execution: execution() })).rejects.toThrow();
    });

    it("saves forward", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution() });
      await store.save({ tenantId: T1, execution: execution({ steps: 3, currentStep: "b" }) });
      expect((await store.get({ tenantId: T1, executionId: "exec-1" }))?.steps).toBe(3);
    });

    it("ignores a save that would move the execution backwards", async () => {
      /**
       * The monotonic guard. Two workers holding the same execution: the slower one's document is stale, and
       * writing it would rewind the flow — which re-performs whatever external writes the rewound steps did.
       */
      const store = make();
      await store.create({ tenantId: T1, execution: execution() });
      await store.save({ tenantId: T1, execution: execution({ steps: 5, currentStep: "e" }) });
      await store.save({ tenantId: T1, execution: execution({ steps: 2, currentStep: "b" }) });
      const read = await store.get({ tenantId: T1, executionId: "exec-1" });
      expect(read?.steps).toBe(5);
      expect(read?.currentStep).toBe("e");
    });

    it("accepts a save at the same step count, because a status can change without progress", async () => {
      // Parking on a question completes no step. Rejecting an equal count would make "waiting" unrecordable.
      const store = make();
      await store.create({ tenantId: T1, execution: execution({ steps: 2 }) });
      await store.save({ tenantId: T1, execution: execution({ steps: 2, status: "waiting", waitingSignal: "paid" }) });
      expect((await store.get({ tenantId: T1, executionId: "exec-1" }))?.status).toBe("waiting");
    });

    it("does not resolve another tenant's execution", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution() });
      expect(await store.get({ tenantId: T2, executionId: "exec-1" })).toBeNull();
    });

    it("finds executions parked on a signal, and only those", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution({ id: "waiting", status: "waiting", waitingSignal: "invoice.paid" }) });
      await store.create({ tenantId: T1, execution: execution({ id: "other-signal", status: "waiting", waitingSignal: "shipped" }) });
      // Running, not waiting: a signal must not resume something that never asked for it.
      await store.create({ tenantId: T1, execution: execution({ id: "running", status: "running", waitingSignal: "invoice.paid" }) });

      const found = await store.waitingOnSignal({ tenantId: T1, signal: "invoice.paid" });
      expect(found.map((e) => e.id)).toEqual(["waiting"]);
    });

    it("finds the execution parked on a child run, and only while it is waiting", async () => {
      // #202. A settled run has to find its parent, and a stale id on a *running* execution is not a parent
      // waiting for anything — resuming it would advance a flow that is already advancing.
      const store = make();
      await store.create({
        tenantId: T1,
        execution: execution({ id: "parked", status: "waiting", waitingRunId: asId<RunId>("child-1") }),
      });
      await store.create({
        tenantId: T1,
        execution: execution({ id: "running", status: "running", waitingRunId: asId<RunId>("child-2") }),
      });

      expect((await store.waitingOnRun({ tenantId: T1, runId: asId<RunId>("child-1") }))?.id).toBe("parked");
      expect(await store.waitingOnRun({ tenantId: T1, runId: asId<RunId>("child-2") })).toBeNull();
      expect(await store.waitingOnRun({ tenantId: T1, runId: asId<RunId>("nobody") })).toBeNull();
    });

    it("does not resolve another tenant's parked execution by child run", async () => {
      const store = make();
      await store.create({
        tenantId: T1,
        execution: execution({ status: "waiting", waitingRunId: asId<RunId>("child-1") }),
      });
      expect(await store.waitingOnRun({ tenantId: T2, runId: asId<RunId>("child-1") })).toBeNull();
    });

    it("lists a flow's executions, newest first", async () => {
      const store = make();
      await store.create({ tenantId: T1, execution: execution({ id: "old", startedAt: "2026-08-01T00:00:00.000Z" }) });
      await store.create({ tenantId: T1, execution: execution({ id: "new", startedAt: "2026-08-20T00:00:00.000Z" }) });
      await store.create({ tenantId: T1, execution: execution({ id: "elsewhere", flowId: "other" }) });

      const listed = await store.listByFlow({ tenantId: T1, flowId: "onboard", limit: 50 });
      expect(listed.items.map((e) => e.id)).toEqual(["new", "old"]);
    });

    it("keeps the whole execution document, so an inspector can read the state", async () => {
      // #187 AC-7. A stored execution nobody can read the state of is not inspectable.
      const store = make();
      const state = { order: { id: "o1", total: 42 }, approved: true };
      await store.create({ tenantId: T1, execution: execution({ execution: { state } }) });
      const read = await store.get({ tenantId: T1, executionId: "exec-1" });
      expect((read?.execution as { state: unknown }).state).toEqual(state);
    });
  });
}
