/**
 * `EvaluationStore` conformance (#141).
 *
 * The cases are mostly about *aggregates agreeing with their evidence* and about *idempotency*, because those
 * are what a release gate depends on: a mean that disagrees with its case rows is a number nobody can defend,
 * and a double-counted case makes the gate pass or fail for the wrong reason.
 */

import { describe, expect, it } from "vitest";
import { asId } from "../../core/ids.js";
import type { TenantId } from "../../core/ids.js";
import type { EvalCaseResult, EvaluationStore } from "../../persistence/index.js";

const T1 = asId<TenantId>("conf-eval-tenant-1");
const T2 = asId<TenantId>("conf-eval-tenant-2");
const STARTED = "2026-08-23T10:00:00.000Z";
const FINISHED = "2026-08-23T10:05:00.000Z";

const result = (overrides: Partial<EvalCaseResult> & { readonly id: string }): EvalCaseResult => ({
  caseId: overrides.id,
  dimension: overrides.dimension ?? "task-completion",
  expectKind: overrides.expectKind ?? "contains",
  verdict: overrides.verdict ?? { pass: true, score: 1, reason: "ok" },
  graderId: overrides.graderId ?? "contains",
  graderVersion: overrides.graderVersion ?? "1",
  ...(overrides.modelId === undefined ? {} : { modelId: overrides.modelId }),
  ...(overrides.promptVersion === undefined ? {} : { promptVersion: overrides.promptVersion }),
  costMinorUnits: overrides.costMinorUnits ?? 0,
});

export function evaluationStoreConformance(
  make: () => EvaluationStore | Promise<EvaluationStore>,
): void {
  describe("EvaluationStore conformance", () => {
    const started = async (id = "run-1", release = "v1") => {
      const store = await make();
      await store.startRun({ tenantId: T1, id, release, startedAt: STARTED });
      return store;
    };

    it("opens a run with zeroed totals", async () => {
      const store = await make();
      const run = await store.startRun({ tenantId: T1, id: "run-1", release: "v1", startedAt: STARTED });
      expect(run).toMatchObject({ id: "run-1", release: "v1", total: 0, passed: 0, meanScore: 0 });
      // Unfinished, and visibly so: an interrupted run must be distinguishable from an absent one.
      expect(run.finishedAt).toBeUndefined();
    });

    it("refuses to open the same run twice", async () => {
      // Silently reopening a completed run would discard the numbers a release was gated on.
      const store = await started();
      await expect(
        store.startRun({ tenantId: T1, id: "run-1", release: "v1", startedAt: STARTED }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("computes aggregates from the recorded cases", async () => {
      const store = await started();
      for (const r of [
        result({ id: "a", verdict: { pass: true, score: 1, reason: "ok" } }),
        result({ id: "b", verdict: { pass: false, score: 0, reason: "no" } }),
        result({ id: "c", verdict: { pass: true, score: 0.5, reason: "partial" } }),
      ]) {
        await store.recordCase({ tenantId: T1, runId: "run-1", result: r });
      }
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: { contains: "1" },
      });
      expect(run).toMatchObject({ total: 3, passed: 2, finishedAt: FINISHED });
      expect(run.meanScore).toBeCloseTo(0.5, 5);
    });

    it("breaks the run down by dimension", async () => {
      // AC-4. An aggregate without a breakdown cannot tell "authorization got worse" from "everything got
      // slightly worse", and those need different responses.
      const store = await started();
      for (const r of [
        result({ id: "a", dimension: "authorization", verdict: { pass: true, score: 1, reason: "ok" } }),
        result({ id: "b", dimension: "authorization", verdict: { pass: false, score: 0, reason: "no" } }),
        result({ id: "c", dimension: "groundedness", verdict: { pass: true, score: 1, reason: "ok" } }),
      ]) {
        await store.recordCase({ tenantId: T1, runId: "run-1", result: r });
      }
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: {},
      });
      expect(run.byDimension).toEqual([
        { dimension: "authorization", total: 2, passed: 1, meanScore: 0.5 },
        { dimension: "groundedness", total: 1, passed: 1, meanScore: 1 },
      ]);
    });

    it("totals the run's cost", async () => {
      // AC-6: the gate's own expense. A gate whose cost is unknown is one nobody can decide to run less often.
      const store = await started();
      for (const r of [
        result({ id: "a", costMinorUnits: 0 }),
        result({ id: "b", costMinorUnits: 7, modelId: "judge-1", promptVersion: "1" }),
        result({ id: "c", costMinorUnits: 11, modelId: "judge-1", promptVersion: "1" }),
      ]) {
        await store.recordCase({ tenantId: T1, runId: "run-1", result: r });
      }
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: {},
      });
      expect(run.costMinorUnits).toBe(18);
    });

    it("does not double count a case recorded twice", async () => {
      // A resumed run re-recording a case must replace it. Double-counting makes the gate pass or fail for the
      // wrong reason, and the aggregate looks plausible either way.
      const store = await started();
      await store.recordCase({ tenantId: T1, runId: "run-1", result: result({ id: "a", costMinorUnits: 5 }) });
      await store.recordCase({ tenantId: T1, runId: "run-1", result: result({ id: "a", costMinorUnits: 5 }) });
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: {},
      });
      expect(run.total).toBe(1);
      expect(run.costMinorUnits).toBe(5);
    });

    it("lets a re-record correct a verdict", async () => {
      // The other half of idempotency: replacing, not ignoring. A re-scored case must take its new verdict, or
      // a fixed grader could never update a run.
      const store = await started();
      await store.recordCase({
        tenantId: T1,
        runId: "run-1",
        result: result({ id: "a", verdict: { pass: false, score: 0, reason: "first" } }),
      });
      await store.recordCase({
        tenantId: T1,
        runId: "run-1",
        result: result({ id: "a", verdict: { pass: true, score: 1, reason: "second" } }),
      });
      const page = await store.listCaseResults({ tenantId: T1, runId: "run-1", limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.verdict).toMatchObject({ pass: true, reason: "second" });
    });

    it("reports rather than throws when the run is gone", async () => {
      // A harness losing that race is ordinary; a thrown error would abandon a whole scoring pass.
      const store = await make();
      expect(
        await store.recordCase({ tenantId: T1, runId: "missing", result: result({ id: "a" }) }),
      ).toEqual({ recorded: false });
    });

    it("stores the grader and prompt versions on a judged result", async () => {
      // AC-2 and AC-3 both depend on it: a score that moved after a prompt edit is not a quality change, and
      // without the version on the result the two are indistinguishable.
      const store = await started();
      await store.recordCase({
        tenantId: T1,
        runId: "run-1",
        result: result({ id: "a", graderId: "refuses-judged", graderVersion: "1+p2", modelId: "judge-1", promptVersion: "2" }),
      });
      const page = await store.listCaseResults({ tenantId: T1, runId: "run-1", limit: 10 });
      expect(page.items[0]).toMatchObject({
        graderId: "refuses-judged",
        graderVersion: "1+p2",
        modelId: "judge-1",
        promptVersion: "2",
      });
    });

    it("records the grader versions on the run", async () => {
      const store = await started();
      await store.recordCase({ tenantId: T1, runId: "run-1", result: result({ id: "a" }) });
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: { contains: "1", "refuses-judged": "1+p2" },
      });
      expect(run.graderVersions).toEqual({ contains: "1", "refuses-judged": "1+p2" });
    });

    it("breaks a tie by start then id, so the latest run is never arbitrary", async () => {
      // Two runs *can* finish in the same instant — a fixed clock, or simply a fast pair. An unstable answer
      // here is a gate comparing against an arbitrary one of two runs, and it would be intermittent.
      const store = await make();
      for (const [id, startedAt] of [
        ["a", "2026-08-23T09:00:00.000Z"],
        ["b", "2026-08-23T09:30:00.000Z"],
      ] as const) {
        await store.startRun({ tenantId: T1, id, release: "v1", startedAt });
        await store.completeRun({ tenantId: T1, runId: id, finishedAt: FINISHED, graderVersions: {} });
      }
      // Same `finishedAt`; the later start wins.
      expect((await store.latest({ tenantId: T1 }))?.id).toBe("b");
    });

    it("returns the latest completed run, never an in-flight one", async () => {
      // An unfinished run's totals are partial, and comparing against one reports every case it has not reached
      // yet as a regression.
      const store = await started("done", "v1");
      await store.recordCase({ tenantId: T1, runId: "done", result: result({ id: "a" }) });
      await store.completeRun({ tenantId: T1, runId: "done", finishedAt: FINISHED, graderVersions: {} });
      await store.startRun({ tenantId: T1, id: "running", release: "v2", startedAt: "2026-08-23T11:00:00.000Z" });

      expect((await store.latest({ tenantId: T1 }))?.id).toBe("done");
    });

    it("returns null when the only run is still in flight", async () => {
      // The discriminating case. With a completed run also present, an unfiltered `latest` can still return the
      // right answer by accident — an undefined `finishedAt` sorts last — so the filter is only really tested
      // when there is nothing else to fall back to. Found by sabotage.
      const store = await started("running", "v1");
      expect(await store.latest({ tenantId: T1 })).toBeNull();
      expect(await store.latest({ tenantId: T1, release: "v1" })).toBeNull();
    });

    it("finds the latest run for one release", async () => {
      const store = await started("v1-run", "v1");
      await store.completeRun({ tenantId: T1, runId: "v1-run", finishedAt: FINISHED, graderVersions: {} });
      await store.startRun({ tenantId: T1, id: "v2-run", release: "v2", startedAt: "2026-08-23T11:00:00.000Z" });
      await store.completeRun({
        tenantId: T1,
        runId: "v2-run",
        finishedAt: "2026-08-23T11:05:00.000Z",
        graderVersions: {},
      });
      expect((await store.latest({ tenantId: T1, release: "v1" }))?.id).toBe("v1-run");
      expect((await store.latest({ tenantId: T1 }))?.id).toBe("v2-run");
    });

    it("returns null when a release has never been scored", async () => {
      const store = await started();
      expect(await store.latest({ tenantId: T1, release: "never" })).toBeNull();
    });

    it("does not resolve another tenant's run", async () => {
      // One tenant's quality gate is not another's business.
      const store = await started();
      expect(await store.get({ tenantId: T2, runId: "run-1" })).toBeNull();
      expect(await store.latest({ tenantId: T2 })).toBeNull();
      expect((await store.listCaseResults({ tenantId: T2, runId: "run-1", limit: 10 })).items).toEqual([]);
    });

    it("does not record into another tenant's run", async () => {
      const store = await started();
      expect(
        await store.recordCase({ tenantId: T2, runId: "run-1", result: result({ id: "a" }) }),
      ).toEqual({ recorded: false });
      expect((await store.listCaseResults({ tenantId: T1, runId: "run-1", limit: 10 })).items).toEqual([]);
    });

    it("lists runs newest first", async () => {
      const store = await make();
      for (const [id, at] of [
        ["old", "2026-08-21T10:00:00.000Z"],
        ["new", "2026-08-23T10:00:00.000Z"],
        ["mid", "2026-08-22T10:00:00.000Z"],
      ] as const) {
        await store.startRun({ tenantId: T1, id, release: id, startedAt: at });
      }
      const page = await store.list({ tenantId: T1, limit: 10 });
      expect(page.items.map((r) => r.id)).toEqual(["new", "mid", "old"]);
    });

    it("pages case results without repeating or skipping one", async () => {
      const store = await started();
      for (const n of [1, 2, 3, 4, 5]) {
        await store.recordCase({ tenantId: T1, runId: "run-1", result: result({ id: `case-${n}` }) });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listCaseResults({
          tenantId: T1,
          runId: "run-1",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((c) => c.caseId));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toEqual(["case-1", "case-2", "case-3", "case-4", "case-5"]);
    });

    it("completes an empty run as zero rather than refusing", async () => {
      // A run that scored nothing has a mean of zero. NaN would propagate into every comparison that touched it.
      const store = await started();
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: FINISHED,
        graderVersions: {},
      });
      expect(run).toMatchObject({ total: 0, passed: 0, meanScore: 0, byDimension: [] });
    });

    it("recomputes aggregates when completed again", async () => {
      // A re-completion after a corrected case must reflect it. Accumulated totals would keep the old number,
      // and the number that gates a release must be derivable from its evidence.
      const store = await started();
      await store.recordCase({
        tenantId: T1,
        runId: "run-1",
        result: result({ id: "a", verdict: { pass: false, score: 0, reason: "first" } }),
      });
      await store.completeRun({ tenantId: T1, runId: "run-1", finishedAt: FINISHED, graderVersions: {} });
      await store.recordCase({
        tenantId: T1,
        runId: "run-1",
        result: result({ id: "a", verdict: { pass: true, score: 1, reason: "fixed" } }),
      });
      const run = await store.completeRun({
        tenantId: T1,
        runId: "run-1",
        finishedAt: "2026-08-23T10:10:00.000Z",
        graderVersions: {},
      });
      expect(run).toMatchObject({ total: 1, passed: 1, meanScore: 1 });
    });
  });
}
