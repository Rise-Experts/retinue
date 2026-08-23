/**
 * Rollout and rollback (#127).
 *
 * The staleness test uses **real time with a short window**, not a fake clock. #107 is the reason: a
 * fakeClock that advanced on every read made two throttle assertions vacuous, and a cache TTL is exactly
 * the kind of property a fake clock can be made to satisfy without the code working.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type PrincipalId, type TenantId } from "@agentkit/backend";
import {
  DEFAULT_RUNTIME,
  MAX_FLAG_STALENESS_MS,
  ROLLBACK_PROCEDURE,
  RunAbandonedError,
  createMemoryRuntimeFlagStore,
  createRolloutController,
  type RuntimeFlagStore,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const T2 = asId<TenantId>("t2");
const OPERATOR = asId<PrincipalId>("op1");
const WORKFLOW = "create-post";

let store: RuntimeFlagStore;

const controller = (over: Parameters<typeof createRolloutController>[0] extends infer C ? Partial<C> : never = {}) =>
  createRolloutController({ store, ...over });

beforeEach(() => {
  store = createMemoryRuntimeFlagStore();
});

/** AC-1. */
describe("switching one workspace", () => {
  it("defaults to the old runtime when no flag is set", async () => {
    const decision = await controller().resolve(T1, WORKFLOW);
    // An unknown workspace is simply not migrated. #126 had to accept an unsafe default; here the safe one
    // is free.
    expect(decision).toMatchObject({ runtime: "agno", source: "default", cached: false });
    expect(DEFAULT_RUNTIME).toBe("agno");
  });

  it("switches a workspace without touching any other", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    expect(await c.resolve(T1, WORKFLOW)).toMatchObject({ runtime: "agentkit", source: "flag" });
    expect(await c.resolve(T2, WORKFLOW)).toMatchObject({ runtime: "agno", source: "default" });
  });

  it("switches one workflow without touching another", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: "create-post", runtime: "agentkit", changedBy: OPERATOR });
    expect(await c.resolve(T1, "create-post")).toMatchObject({ runtime: "agentkit" });
    // Per workflow, so rollout is not all-or-nothing — a workspace can be migrated for drafting and not
    // for publishing.
    expect(await c.resolve(T1, "publish")).toMatchObject({ runtime: "agno" });
  });

  it("falls back to the old runtime when the store cannot be reached", async () => {
    // Failing open to the *new* runtime would migrate a customer during an outage — the worst moment to
    // change which code path runs.
    const broken: RuntimeFlagStore = {
      async get() {
        throw new Error("connection refused");
      },
      async set() {},
      async history() {
        return [];
      },
    };
    const decision = await createRolloutController({ store: broken }).resolve(T1, WORKFLOW);
    expect(decision).toMatchObject({ runtime: "agno", source: "store-unavailable" });
  });
});

/** AC-2, with real time. */
describe("staleness", () => {
  it("serves from cache within the window, and says so", async () => {
    const c = controller({ maxStalenessMs: 200 });
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    const first = await c.resolve(T1, WORKFLOW);
    const second = await c.resolve(T1, WORKFLOW);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // The age, not just the fact. "It was still using the old value" is the most likely explanation for a
    // surprising run, and deducing it from timestamps is how an investigation stalls.
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(second.cacheAgeMs).toBeLessThan(200);
  });

  it("re-reads after the window, measured against real time", async () => {
    // A short real window rather than a fake clock. #107's fakeClock advanced on every read, which made
    // two throttle assertions pass against code that never throttled.
    const c = controller({ maxStalenessMs: 20 });
    await c.resolve(T1, WORKFLOW);
    // Change the flag *behind* the cache, so only expiry can reveal it.
    await store.set({
      tenantId: T1,
      workflow: WORKFLOW,
      runtime: "agentkit",
      changedBy: OPERATOR,
      changedAt: new Date().toISOString(),
    });
    expect(await c.resolve(T1, WORKFLOW)).toMatchObject({ runtime: "agno", cached: true });

    const started = Date.now();
    let seen = await c.resolve(T1, WORKFLOW);
    while (seen.runtime !== "agentkit" && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 5));
      seen = await c.resolve(T1, WORKFLOW);
    }
    const elapsed = Date.now() - started;
    expect(seen.runtime).toBe("agentkit");
    // AC-5's measured half: the mechanism's time-to-effect, against the documented window.
    expect(elapsed).toBeLessThanOrEqual(20 + 200);
  });

  it("takes effect immediately when the change goes through the controller", async () => {
    // The staleness bound is a *ceiling* on how stale a resolution can be, not a delay imposed on purpose.
    // A change made through `set` drops the cache for that workspace, so the next run is fresh.
    const c = controller({ maxStalenessMs: 60_000 });
    await c.resolve(T1, WORKFLOW);
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    expect(await c.resolve(T1, WORKFLOW)).toMatchObject({ runtime: "agentkit", cached: false });
  });

  it("documents a window short enough that nobody counts it", () => {
    expect(MAX_FLAG_STALENESS_MS).toBeLessThanOrEqual(10_000);
    expect(controller().stalenessMs).toBe(MAX_FLAG_STALENESS_MS);
  });
});

/** AC-3 — the substantive one. */
describe("a run keeps the runtime it started with", () => {
  it("pins the decision for the whole run", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    const first = await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });
    expect(first.runtime).toBe("agentkit");

    // Rolled back underneath it.
    await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR });

    const again = await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });
    // The same decision. Re-reading per step would switch runtimes halfway through an answer, which *is*
    // the "silently dropped mid-answer" AC-3 forbids.
    expect(again).toEqual(first);
    // And a new run gets the rolled-back value.
    expect(await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r2" })).toMatchObject({
      runtime: "agno",
    });
  });

  it("completes in-flight work by default, and reports how much there is", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r2" });

    const report = await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR });
    expect(report.mode).toBe("complete-in-flight");
    expect(report.inFlight.sort()).toEqual(["r1", "r2"]);
    expect(report.abandoned).toEqual([]);
    // The number an operator needs, and it is not the cache bound: nothing is fully settled until these
    // finish.
    expect(report.inFlightRuns).toBe(2);
    expect(report.stalenessMs).toBe(MAX_FLAG_STALENESS_MS);
    // Still pinned, so they finish on the runtime they started with.
    expect(c.pinnedFor("r1")).toMatchObject({ runtime: "agentkit" });
  });

  it("abandons in-flight work only when asked, and names every run", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });

    const report = await c.rollback({
      tenantId: T1,
      workflow: WORKFLOW,
      changedBy: OPERATOR,
      mode: "abandon-in-flight",
      reason: "duplicate publishes observed",
    });
    expect(report.abandoned).toEqual(["r1"]);
    expect(report.inFlightRuns).toBe(0);
    expect(c.pinnedFor("r1")).toBeUndefined();
  });

  it("tells an abandoned run's user what happened, and that nothing was published", async () => {
    // "Never silently dropped" is AC-3's wording, and a dropped run that looks like a slow one is the worst
    // version: the user waits, asks again, and the retry is what duplicates.
    const error = new RunAbandonedError(WORKFLOW);
    expect(error.code).toBe("run-abandoned");
    expect(error.message).toMatch(/stopped part-way/i);
    expect(error.message).toMatch(/nothing was published/i);
    expect(error.message).toMatch(/safe to ask again/i);
    expect(error.workflow).toBe(WORKFLOW);
  });

  it("stops counting a finished run as in flight", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });
    c.finishRun("r1");
    const report = await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR });
    expect(report.inFlight).toEqual([]);
    expect(report.inFlightRuns).toBe(0);
  });

  it("does not count runs on the old runtime as in flight for a rollback to it", async () => {
    const c = controller();
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" }); // agno by default
    const report = await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR });
    // Nothing to drain — r1 is already where the rollback is going.
    expect(report.inFlight).toEqual([]);
  });
});

/** AC-4. */
describe("every change is recorded", () => {
  it("keeps who and when, and why when given", async () => {
    const c = controller();
    await c.set({
      tenantId: T1,
      workflow: WORKFLOW,
      runtime: "agentkit",
      changedBy: OPERATOR,
      reason: "5% rollout",
    });
    const [latest] = await store.history(T1, WORKFLOW);
    expect(latest).toMatchObject({ runtime: "agentkit", changedBy: "op1", reason: "5% rollout" });
    expect(latest?.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the history, not just the current value", async () => {
    // The question during an incident is "what changed just before this started", and a single current
    // value cannot answer it.
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR, reason: "on" });
    await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR, reason: "regression" });
    const history = await store.history(T1, WORKFLOW);
    expect(history).toHaveLength(2);
    // Newest first.
    expect(history[0]).toMatchObject({ runtime: "agno", reason: "regression" });
    expect(history[1]).toMatchObject({ runtime: "agentkit", reason: "on" });
  });

  it("records a rollback as a change like any other", async () => {
    const c = controller();
    await c.rollback({ tenantId: T1, workflow: WORKFLOW, changedBy: OPERATOR });
    const [latest] = await store.history(T1, WORKFLOW);
    expect(latest).toMatchObject({ runtime: "agno", changedBy: "op1" });
  });
});

/** AC-5. */
describe("the procedure", () => {
  it("lives with the code it describes", () => {
    // A runbook in a wiki goes stale silently, and the one moment it is read is the one moment nobody
    // checks whether it is current.
    expect(ROLLBACK_PROCEDURE).toMatch(/Routine rollback/);
    expect(ROLLBACK_PROCEDURE).toMatch(/Urgent rollback/);
  });

  it("says the thing people get wrong about the timing", () => {
    expect(ROLLBACK_PROCEDURE).toMatch(/plus\s+the\s+longest\s+in-flight\s+run/i);
    expect(ROLLBACK_PROCEDURE).toMatch(/wrong\s+whenever\s+a\s+run\s+is\s+open/i);
  });

  it("says what to tell an abandoned run's user", () => {
    // Whitespace-tolerant, because the prose wraps and a phrase can straddle a line break. The first
    // version of this asserted the phrase literally and failed on the wrap — the same thing
    // `findForbiddenClaims` handles by matching runs of whitespace rather than a single space.
    expect(ROLLBACK_PROCEDURE).toMatch(/nothing\s+was\s+published/i);
    expect(ROLLBACK_PROCEDURE).toMatch(/the\s+retry\s+is\s+what\s+duplicates/i);
  });

  it("names the command for each mode", () => {
    expect(ROLLBACK_PROCEDURE).toContain("controller.rollback({ tenantId, workflow, changedBy })");
    expect(ROLLBACK_PROCEDURE).toContain('mode: "abandon-in-flight"');
  });
});

/** AC-6. */
describe("a request's flag state is inspectable", () => {
  it("says which runtime, why, and whether it was cached", async () => {
    const c = controller({ maxStalenessMs: 500 });
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    await c.resolve(T1, WORKFLOW);
    const second = await c.resolve(T1, WORKFLOW);
    expect(Object.keys(second).sort()).toEqual([
      "cacheAgeMs",
      "cached",
      "resolvedAt",
      "runtime",
      "source",
      "workflow",
    ]);
    expect(second.source).toBe("flag");
  });

  it("keeps a run's decision retrievable after the fact", async () => {
    const c = controller();
    await c.set({ tenantId: T1, workflow: WORKFLOW, runtime: "agentkit", changedBy: OPERATOR });
    await c.resolveForRun({ tenantId: T1, workflow: WORKFLOW, runId: "r1" });
    // Explaining a surprising run means knowing what it was pinned to, not what the flag says now.
    expect(c.pinnedFor("r1")).toMatchObject({ runtime: "agentkit", source: "flag" });
    expect(c.pinnedFor("nope")).toBeUndefined();
  });

  it("distinguishes a default from an unavailable store", async () => {
    // Both answer "agno", and they are very different situations — one is a workspace not yet migrated, the
    // other is an outage. Collapsing them would make an incident unreadable.
    expect((await controller().resolve(T1, WORKFLOW)).source).toBe("default");
    const broken: RuntimeFlagStore = {
      async get() {
        throw new Error("down");
      },
      async set() {},
      async history() {
        return [];
      },
    };
    expect((await createRolloutController({ store: broken }).resolve(T1, WORKFLOW)).source).toBe(
      "store-unavailable",
    );
  });
});
