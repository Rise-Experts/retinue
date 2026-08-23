/**
 * In-memory `EvaluationStore` — the reference implementation (#141).
 *
 * The interesting behaviour is `completeRun`: aggregates are computed from the recorded cases at completion,
 * not accumulated as they arrive. A run whose totals were accumulated could disagree with its own case rows
 * after a re-record, and the number that gates a release must be derivable from the evidence behind it.
 */

import type { Page } from "../../core/context.js";
import { AgentPlatformError } from "../../core/errors.js";
import type {
  EvalCaseResult,
  EvalDimensionSummary,
  EvalRun,
  EvaluationStore,
} from "../../persistence/index.js";

type Stored = { run: EvalRun; cases: Map<string, EvalCaseResult> };

const tenantMap = <V>(outer: Map<string, Map<string, V>>, tenantId: string): Map<string, V> => {
  let inner = outer.get(tenantId);
  if (!inner) outer.set(tenantId, (inner = new Map<string, V>()));
  return inner;
};

/** Aggregates from the case rows. One function, so the two adapters cannot disagree about what a mean is. */
export const summarise = (
  cases: readonly EvalCaseResult[],
): {
  total: number;
  passed: number;
  meanScore: number;
  byDimension: readonly EvalDimensionSummary[];
  costMinorUnits: number;
} => {
  const byDimension = new Map<string, { total: number; passed: number; score: number }>();
  let passed = 0;
  let score = 0;
  let cost = 0;
  for (const result of cases) {
    if (result.verdict.pass) passed += 1;
    score += result.verdict.score;
    cost += result.costMinorUnits;
    const entry = byDimension.get(result.dimension) ?? { total: 0, passed: 0, score: 0 };
    entry.total += 1;
    if (result.verdict.pass) entry.passed += 1;
    entry.score += result.verdict.score;
    byDimension.set(result.dimension, entry);
  }
  return {
    total: cases.length,
    passed,
    // Zero for an empty run rather than NaN: a run that scored nothing has a mean of zero, and NaN would
    // propagate into every comparison that touched it.
    meanScore: cases.length === 0 ? 0 : score / cases.length,
    byDimension: [...byDimension.entries()]
      // Sorted by name so two runs' breakdowns line up in a diff.
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dimension, e]) => ({
        dimension,
        total: e.total,
        passed: e.passed,
        meanScore: e.total === 0 ? 0 : e.score / e.total,
      })),
    costMinorUnits: cost,
  };
};

export const createMemoryEvaluationStore = (): EvaluationStore => {
  const byTenant = new Map<string, Map<string, Stored>>();

  return {
    async startRun({ tenantId, id, release, startedAt }) {
      const runs = tenantMap(byTenant, tenantId);
      if (runs.has(id))
        throw new AgentPlatformError({
          code: "conflict",
          message: `evaluation run ${id} already exists`,
          retryable: false,
        });
      const run: EvalRun = {
        id,
        release,
        startedAt,
        total: 0,
        passed: 0,
        meanScore: 0,
        byDimension: [],
        costMinorUnits: 0,
        graderVersions: {},
      };
      runs.set(id, { run, cases: new Map() });
      return run;
    },

    async recordCase({ tenantId, runId, result }) {
      const stored = tenantMap(byTenant, tenantId).get(runId);
      // Absent means the run is gone — reported rather than thrown, because a resumed harness losing a race is
      // ordinary and a thrown error would abandon the whole run.
      if (stored === undefined) return { recorded: false };
      // Idempotent on the case id: a resumed run must not double-count a case it already scored.
      stored.cases.set(result.caseId, result);
      return { recorded: true };
    },

    async completeRun({ tenantId, runId, finishedAt, graderVersions }) {
      const stored = tenantMap(byTenant, tenantId).get(runId);
      if (stored === undefined)
        throw new AgentPlatformError({
          code: "not_found",
          message: `no such evaluation run ${runId}`,
          retryable: false,
        });
      const summary = summarise([...stored.cases.values()]);
      stored.run = { ...stored.run, finishedAt, graderVersions, ...summary };
      return stored.run;
    },

    async get({ tenantId, runId }) {
      // Absent from *this tenant's* map, so a foreign run id is null without a comparison anyone could get
      // wrong — one tenant's quality gate is not another's business.
      return tenantMap(byTenant, tenantId).get(runId)?.run ?? null;
    },

    async latest({ tenantId, release }) {
      const runs = [...tenantMap(byTenant, tenantId).values()]
        .map((s) => s.run)
        // Completed only: an in-flight run has partial totals, and comparing against one would report every
        // case it has not reached yet as a regression.
        .filter((r) => r.finishedAt !== undefined && (release === undefined || r.release === release))
        // Tie-broken by start then id, because two runs can finish in the same instant — a fixed clock in a
        // test, or simply a fast pair — and "the latest run" must not depend on insertion order. An unstable
        // answer here is a gate comparing against an arbitrary one of two runs.
        .sort((a, b) => {
          const byFinish = (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "");
          if (byFinish !== 0) return byFinish;
          const byStart = b.startedAt.localeCompare(a.startedAt);
          return byStart !== 0 ? byStart : b.id.localeCompare(a.id);
        });
      return runs[0] ?? null;
    },

    async list({ tenantId, limit, cursor }) {
      const runs = [...tenantMap(byTenant, tenantId).values()]
        .map((s) => s.run)
        // Newest first, which is the order a release history is read in.
        .sort((a, b) => (b.startedAt !== a.startedAt ? b.startedAt.localeCompare(a.startedAt) : a.id.localeCompare(b.id)));
      const start = cursor === undefined ? 0 : runs.findIndex((r) => r.id === cursor) + 1;
      const items = runs.slice(start, start + limit);
      const last = items[items.length - 1];
      return start + limit < runs.length && last !== undefined
        ? { items, nextCursor: last.id }
        : ({ items } satisfies Page<EvalRun>);
    },

    async listCaseResults({ tenantId, runId, limit, cursor }) {
      const stored = tenantMap(byTenant, tenantId).get(runId);
      if (stored === undefined) return { items: [] };
      const cases = [...stored.cases.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
      const start = cursor === undefined ? 0 : cases.findIndex((c) => c.caseId > cursor);
      const at = start < 0 ? cases.length : start;
      const items = cases.slice(at, at + limit);
      const last = items[items.length - 1];
      return at + limit < cases.length && last !== undefined
        ? { items, nextCursor: last.caseId }
        : { items };
    },
  };
};
