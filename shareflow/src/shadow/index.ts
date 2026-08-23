/**
 * Shadow-run recording and the parity diff (#126).
 *
 * Suppression itself is in the envelope, not here — that is AC-1's whole point: *"enforced in the
 * envelope, not per tool"*, so every current and future external write inherits it with no opt-in to
 * forget. What lives here is what a shadow run is *for*: keeping what would have happened, and comparing
 * two runs of the same request.
 *
 * ## What a diff can and cannot tell you
 *
 * *"Some differences are improvements"* — the SPEC says so, and it is the reason this produces a report
 * for a person rather than a verdict. Nothing here decides whether a difference is a regression. It
 * classifies *kinds* of difference, because those are what a reviewer needs to triage a hundred workflows,
 * and it deliberately does not score them.
 */
import type { SuppressedWrite } from "@agentkit/backend";

/**
 * Everything one run would have written.
 *
 * Keyed by `workflow` so two runs of the same request are comparable — AC-3's *"keyed so the two are
 * comparable per workflow"*. The label is the caller's: the platform has no notion of a docs/07 workflow,
 * and inventing one here would be a second vocabulary to keep in step.
 */
export type ShadowRun = {
  /** Which docs/07 workflow this run exercised, e.g. `create-post`. The comparison key. */
  readonly workflow: string;
  /** Which runtime produced it. Free text so "agno" and a version can both be said. */
  readonly runtime: string;
  readonly writes: readonly SuppressedWrite[];
};

/**
 * An in-memory recorder.
 *
 * Deliberately not durable: a parity harness runs a batch and reports, and a durable recorder is the
 * migration's own concern with its own retention question. This is the shape a durable one implements.
 */
export const createShadowRecorder = () => {
  const byRun = new Map<string, SuppressedWrite[]>();
  const key = (runId: string | undefined) => runId ?? "no-run";
  return {
    record(_context: unknown, write: SuppressedWrite): void {
      const list = byRun.get(key(write.runId)) ?? [];
      list.push(write);
      byRun.set(key(write.runId), list);
    },
    /** What one run would have written, in order. */
    written(runId?: string): readonly SuppressedWrite[] {
      return [...(byRun.get(key(runId)) ?? [])];
    },
    /** Every run seen. For a harness reporting over a batch. */
    runIds(): readonly string[] {
      return [...byRun.keys()];
    },
  };
};

/** How two runs differ on one write. Kinds, not judgements — see the note at the top. */
export const DIFF_KINDS = [
  /** Only the new runtime would have made this call. */
  "extra",
  /** Only the old runtime would have made it. */
  "missing",
  /** Both would, to the same function, with different arguments. */
  "arguments-differ",
  /** Both would, in a different order. */
  "order-differs",
  /** Both would, identically. */
  "same",
] as const;

export type DiffKind = (typeof DIFF_KINDS)[number];

export type WriteDiff = {
  readonly kind: DiffKind;
  readonly toolName: string;
  readonly delegatesTo: string;
  /** Present for `arguments-differ`: the field names whose values are not equal. */
  readonly changedFields?: readonly string[];
  /** Present when only one side has it. */
  readonly onlyIn?: "old" | "new";
};

export type ParityReport = {
  readonly workflow: string;
  readonly oldRuntime: string;
  readonly newRuntime: string;
  /**
   * True when the two runs would have made the same calls, to the same functions, with the same
   * arguments, in the same order.
   *
   * **Not a pass/fail.** A report that is not identical may still be an improvement, which is exactly why
   * nothing here scores it. The field says what it says: identical, or not.
   */
  readonly identical: boolean;
  readonly diffs: readonly WriteDiff[];
  /**
   * Writes both runs would have made that require a human's approval.
   *
   * Surfaced separately because it is the number a reviewer looks at first: a shadow run that would have
   * published more times than the old one is the failure this whole exercise exists to catch, and it
   * should not have to be counted out of a list of forty diffs.
   */
  readonly approvalBearingWrites: { readonly old: number; readonly new: number };
};

/** Stable string for a value, so two argument objects compare by content rather than by key order. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

/** Field names whose values differ between two argument objects. */
const changedFields = (a: unknown, b: unknown): readonly string[] => {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].filter((n) => canonical(left[n]) !== canonical(right[n])).sort();
};

const countApprovalBearing = (writes: readonly SuppressedWrite[]): number =>
  writes.filter((w) => w.wouldRequireApproval).length;

/**
 * Compare two runs of the same workflow.
 *
 * Matched **positionally within each tool name**, not globally by index. Two runs that call the same three
 * functions in a different order are an order difference, not three unrelated mismatches — and a global
 * index match would report exactly that, burying the real finding under noise.
 */
export const diffShadowRuns = (oldRun: ShadowRun, newRun: ShadowRun): ParityReport => {
  if (oldRun.workflow !== newRun.workflow) {
    // Refused rather than compared. A diff between two different workflows is meaningless, and producing
    // one anyway is how a parity report gets trusted while comparing nothing.
    throw new Error(
      `cannot compare different workflows: "${oldRun.workflow}" and "${newRun.workflow}"`,
    );
  }

  const diffs: WriteDiff[] = [];
  const group = (writes: readonly SuppressedWrite[]) => {
    const map = new Map<string, SuppressedWrite[]>();
    for (const w of writes) map.set(w.toolName, [...(map.get(w.toolName) ?? []), w]);
    return map;
  };
  const oldByTool = group(oldRun.writes);
  const newByTool = group(newRun.writes);

  for (const toolName of new Set([...oldByTool.keys(), ...newByTool.keys()])) {
    const olds = oldByTool.get(toolName) ?? [];
    const news = newByTool.get(toolName) ?? [];
    for (let i = 0; i < Math.max(olds.length, news.length); i += 1) {
      const o = olds[i];
      const n = news[i];
      if (o === undefined && n !== undefined) {
        diffs.push({ kind: "extra", toolName, delegatesTo: n.delegatesTo, onlyIn: "new" });
        continue;
      }
      if (n === undefined && o !== undefined) {
        diffs.push({ kind: "missing", toolName, delegatesTo: o.delegatesTo, onlyIn: "old" });
        continue;
      }
      if (o === undefined || n === undefined) continue;
      const changed = changedFields(o.input, n.input);
      diffs.push(
        changed.length === 0
          ? { kind: "same", toolName, delegatesTo: n.delegatesTo }
          : { kind: "arguments-differ", toolName, delegatesTo: n.delegatesTo, changedFields: changed },
      );
    }
  }

  // Order is compared on the sequence of tool names, separately from the per-call comparison above — so a
  // reordering shows up once as an order difference rather than as a cascade of argument mismatches.
  const orderOf = (writes: readonly SuppressedWrite[]) => writes.map((w) => w.toolName).join(">");
  if (
    orderOf(oldRun.writes) !== orderOf(newRun.writes) &&
    oldRun.writes.length === newRun.writes.length &&
    diffs.every((d) => d.kind === "same")
  ) {
    diffs.push({ kind: "order-differs", toolName: "*", delegatesTo: "*" });
  }

  return {
    workflow: newRun.workflow,
    oldRuntime: oldRun.runtime,
    newRuntime: newRun.runtime,
    identical: diffs.every((d) => d.kind === "same"),
    diffs,
    approvalBearingWrites: {
      old: countApprovalBearing(oldRun.writes),
      new: countApprovalBearing(newRun.writes),
    },
  };
};

/**
 * The one question a reviewer must not have to derive.
 *
 * *"Zero unauthorized or duplicate actions"* is REQ-021's criterion, and the migration's version of it is
 * that the new runtime must not want to publish more than the old one did. Surfaced as its own predicate
 * because counting it out of a diff list is exactly the step someone skips.
 */
export const wouldPublishMoreThanBefore = (report: ParityReport): boolean =>
  report.approvalBearingWrites.new > report.approvalBearingWrites.old;
