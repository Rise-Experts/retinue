/**
 * The rollup job and the reconciliation report (#139).
 *
 * `UsageRollupStore.rebuild` does the arithmetic. What lives here is *which buckets to rebuild and when*, and
 * the comparison against what the provider says we spent.
 *
 * **The work list is derived from the ledger.** `listStaleBuckets` asks which buckets have events newer than
 * their last computation, so an interrupted job resumes by asking again rather than by remembering where it
 * was. The same shape #135's re-indexing uses, and for the same reason: a cursor that has to be persisted is a
 * cursor that can be lost, and a lost rollup cursor is silently wrong totals.
 *
 * **Reconciliation reports, it does not correct.** A discrepancy between our ledger and a provider's invoice
 * has several causes — a rounding difference, an event we never recorded, a charge for a call we did not make,
 * a provider restatement — and they want different responses. A job that "corrected" the ledger would erase
 * the evidence needed to tell them apart, and the ledger is append-only precisely so that evidence survives.
 */

import type { ExecutionContext } from "../core/context.js";
import type { TenantId } from "../core/ids.js";
import type {
  RollupPeriod,
  UsageRollup,
  UsageRollupStore,
  UsageTotals,
} from "../persistence/index.js";
import { bucketStartFor, bucketsBetween, nextBucket } from "./quota.js";

export type RollupJobDeps = {
  readonly rollups: UsageRollupStore;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

export const createRollupJob = (deps: RollupJobDeps) => {
  const log = deps.log ?? (() => {});

  return {
    /**
     * Rebuild one page of stale buckets — AC-4.
     *
     * A page at a time, so an interruption loses at most a page and no bookkeeping. Rebuilding is a
     * *recomputation*, so re-running a bucket cannot double count and two workers racing one bucket write the
     * same value — which is what makes "safe under concurrency" a property of the design rather than a lock.
     */
    async run(
      context: { readonly tenantId: TenantId },
      input: { readonly period: RollupPeriod; readonly since: string; readonly limit: number },
    ): Promise<{ readonly rebuilt: number; readonly remaining: number }> {
      const stale = await deps.rollups.listStaleBuckets({
        tenantId: context.tenantId,
        period: input.period,
        since: input.since,
        limit: input.limit,
      });
      for (const bucket of stale.items) {
        // No `computedAt`: the store stamps it from its own clock, because staleness compares that stamp
        // against when events were recorded and both must come from one source.
        await deps.rollups.rebuild({
          tenantId: context.tenantId,
          period: bucket.period,
          bucketStart: bucket.bucketStart,
          /**
           * The grain the store reported — #175.
           *
           * Dropping it would rebuild the tenant row twice and never build a principal's at all, so every
           * per-person figure would read zero and every per-person quota would be unenforceable. The store
           * reports both grains from one ledger pass precisely so the job does not have to know which
           * principals were active.
           */
          ...(bucket.principalId === undefined ? {} : { principalId: bucket.principalId }),
        });
      }
      // Asked again rather than computed, because events may have landed while this page ran — and a stale
      // "remaining" is how a loop stops early or never stops.
      const after = await deps.rollups.listStaleBuckets({
        tenantId: context.tenantId,
        period: input.period,
        since: input.since,
        limit: 1,
      });
      if (stale.items.length > 0)
        log("rebuilt usage buckets", { period: input.period, count: stale.items.length });
      return { rebuilt: stale.items.length, remaining: after.items.length };
    },

    /** Rebuild a specific range, for a backfill or after a correcting event. */
    async rebuildRange(
      context: { readonly tenantId: TenantId },
      input: { readonly period: RollupPeriod; readonly from: string; readonly to: string },
    ): Promise<readonly UsageRollup[]> {
      const written: UsageRollup[] = [];
      for (const bucketStart of bucketsBetween(input.period, input.from, input.to)) {
        written.push(
          await deps.rollups.rebuild({
            tenantId: context.tenantId,
            period: input.period,
            bucketStart,
          }),
        );
      }
      return written;
    },
  };
};

export type RollupJob = ReturnType<typeof createRollupJob>;

/**
 * What the provider says a period cost.
 *
 * `costMinorUnits` in the same integer minor units the ledger uses, so a comparison is exact arithmetic rather
 * than a float difference that is always slightly nonzero.
 */
export type ProviderStatement = {
  readonly provider: string;
  readonly from: string;
  readonly to: string;
  readonly costMinorUnits: number;
  readonly currency: string;
};

/**
 * The tolerance a discrepancy has to clear to be reported — AC-5.
 *
 * **Both a fraction and a floor**, and both are needed. A fraction alone reports every tiny period as broken:
 * on a €0.02 hour a one-cent rounding difference is 50%. A floor alone stops scaling: on a €10,000 month a
 * €5 absolute tolerance is noise nobody can act on. A discrepancy must exceed *both* to be worth someone's
 * attention.
 */
export const DEFAULT_RECONCILIATION_TOLERANCE = { fraction: 0.02, floorMinorUnits: 100 } as const;

export type ReconciliationTolerance = {
  readonly fraction: number;
  readonly floorMinorUnits: number;
};

/** Why a period did not reconcile. Separate values because each points at a different investigation. */
export const DISCREPANCY_KINDS = ["under-recorded", "over-recorded", "currency-mismatch"] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

/**
 * Named for usage specifically, because `files/index.ts` has a `ReconciliationReport` of its own — for orphaned
 * objects, which is a different problem with a different report. The package barrel refused both, which is how
 * the collision surfaced.
 */
export type UsageReconciliationReport = {
  readonly provider: string;
  readonly from: string;
  readonly to: string;
  readonly ledgerMinorUnits: number;
  readonly providerMinorUnits: number;
  readonly deltaMinorUnits: number;
  readonly withinTolerance: boolean;
  readonly kind?: DiscrepancyKind;
  readonly message?: string;
};

/**
 * Compare the ledger's rollups against a provider statement.
 *
 * Reads the *rollups*, not the ledger, so reconciliation costs the same whether a tenant has spent a euro or a
 * million — and so a discrepancy in the rollups themselves is visible rather than hidden by recomputing the
 * thing being checked.
 */
export const reconcileUsage = async (
  context: ExecutionContext,
  deps: { readonly rollups: UsageRollupStore },
  input: {
    readonly statement: ProviderStatement;
    /**
     * The currency the ledger records in.
     *
     * Passed rather than read from a rollup, because a range with no usage has no rollup to read it from — and
     * "no usage" is exactly when a statement showing a charge matters most.
     */
    readonly ledgerCurrency: string;
    readonly period?: RollupPeriod;
    readonly tolerance?: ReconciliationTolerance;
  },
): Promise<UsageReconciliationReport> => {
  const period = input.period ?? "day";
  const tolerance = input.tolerance ?? DEFAULT_RECONCILIATION_TOLERANCE;
  const ledger: UsageTotals = await deps.rollups.sum({
    tenantId: context.tenantId,
    period,
    from: bucketStartFor(period, input.statement.from),
    // Exclusive upper bound, extended to the end of the bucket containing `to` — a statement ending mid-day
    // still covers that day's spend, and truncating would report every statement as under-recorded.
    to: nextBucket(period, bucketStartFor(period, input.statement.to)),
  });

  // Currency first, because comparing two numbers in different currencies is not a discrepancy — it is a
  // meaningless subtraction that would report a plausible figure. Checked before the arithmetic rather than
  // after, so no number is ever computed across currencies.
  if (input.ledgerCurrency !== input.statement.currency)
    return {
      provider: input.statement.provider,
      from: input.statement.from,
      to: input.statement.to,
      ledgerMinorUnits: ledger.costMinorUnits,
      providerMinorUnits: input.statement.costMinorUnits,
      // Deliberately zero rather than a difference: there is no difference between amounts in different
      // currencies, and a number here would be quoted as one.
      deltaMinorUnits: 0,
      withinTolerance: false,
      kind: "currency-mismatch",
      message: `The ledger records ${input.ledgerCurrency} and ${input.statement.provider} billed in ${input.statement.currency}; the totals cannot be compared.`,
    };

  const delta = ledger.costMinorUnits - input.statement.costMinorUnits;
  const magnitude = Math.abs(delta);
  const base = Math.max(input.statement.costMinorUnits, 1);
  // Both thresholds, not either: a fraction alone flags every tiny period, a floor alone stops scaling.
  const withinTolerance =
    magnitude <= tolerance.floorMinorUnits || magnitude / base <= tolerance.fraction;

  if (withinTolerance)
    return {
      provider: input.statement.provider,
      from: input.statement.from,
      to: input.statement.to,
      ledgerMinorUnits: ledger.costMinorUnits,
      providerMinorUnits: input.statement.costMinorUnits,
      deltaMinorUnits: delta,
      withinTolerance: true,
    };

  const kind: DiscrepancyKind = delta < 0 ? "under-recorded" : "over-recorded";
  return {
    provider: input.statement.provider,
    from: input.statement.from,
    to: input.statement.to,
    ledgerMinorUnits: ledger.costMinorUnits,
    providerMinorUnits: input.statement.costMinorUnits,
    deltaMinorUnits: delta,
    withinTolerance: false,
    kind,
    // Both figures and the direction, because "under-recorded" and "over-recorded" point at different
    // investigations: the first is usage we are not billing for, the second is a charge we cannot account for.
    message:
      kind === "under-recorded"
        ? `${input.statement.provider} billed ${input.statement.costMinorUnits} but the ledger records ${ledger.costMinorUnits} — ${magnitude} minor units of usage were not recorded.`
        : `The ledger records ${ledger.costMinorUnits} but ${input.statement.provider} billed ${input.statement.costMinorUnits} — ${magnitude} minor units were recorded that the provider did not bill.`,
  };
};
