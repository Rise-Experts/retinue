/**
 * Rollup buckets and quota enforcement (#139).
 *
 * Phase 5 gave usage a recording hook and #100 made it durable. Nothing aggregated it and nothing enforced a
 * limit, so one customer's consumption was unbounded.
 *
 * Four decisions carry this module.
 *
 * **Buckets are identified by their start, truncated to the period.** Two writers asking "which bucket does T
 * belong to" must agree, and they do because truncation is a pure function of T rather than a range someone
 * chooses.
 *
 * **The quota check happens at admission, before any provider call.** AC-2's wording is "before work starts",
 * and the reason is what the alternative costs: a limit enforced mid-run leaves a half-written answer, a
 * partial charge, and a user who has to guess whether to retry. Refusing admission is a complete outcome.
 *
 * **The warning fires below the limit, not at it.** A customer told at 100% is told when work is already
 * failing. The threshold is a fraction so it scales with the limit rather than being a constant that is
 * meaningless at one plan size and useless at another.
 *
 * **Enforcement reads a rollup, not the ledger.** Admission is on the hot path of every message; a check that
 * scanned raw events would make the platform slower in exact proportion to how much it had been used.
 */

import { AgentPlatformError } from "../core/errors.js";
import type { ExecutionContext } from "../core/context.js";
import { windowKey } from "../persistence/index.js";
import type {
  QuotaWindow,
  RollupPeriod,
  UsageLimitStore,
  UsageRollupStore,
  UsageStore,
  UsageTotals,
} from "../persistence/index.js";
import type { PrincipalId } from "../core/ids.js";

/** Zero, as a total. Named because "no usage" appears in several places and an object literal invites drift. */
export const NO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costMinorUnits: 0,
  eventCount: 0,
};

/**
 * The instant a period's bucket opens, for a given moment.
 *
 * Truncation in UTC, deliberately. A tenant-local day would make a bucket's identity depend on a timezone
 * setting that can change, and a rollup already written under the old offset would silently belong to a
 * different day than one written after — so "yesterday" would double-count an hour or lose one. Presenting
 * totals in local time is a display concern; *storing* them in one is a correctness bug.
 */
export const bucketStartFor = (period: RollupPeriod, at: string): string => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime()))
    throw new AgentPlatformError({
      code: "invalid_input",
      message: `not a timestamp: ${JSON.stringify(at)}`,
      retryable: false,
    });
  /**
   * Week and month are calendar truncations, not fixed spans — #175.
   *
   * A month is 28 to 31 days and a week crosses month boundaries, so neither can be expressed as a multiple of
   * milliseconds from an epoch. Getting that wrong drifts: buckets that start mid-day, and a "month" that slowly
   * detaches from the calendar.
   *
   * The week starts **Monday**, per ISO 8601. `getUTCDay()` returns 0 for Sunday, so the offset is
   * `(day + 6) % 7` — the arithmetic that turns a Sunday-based index into a Monday-based one, and the reason this
   * is written out rather than inlined.
   */
  if (period === "month") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  }
  if (period === "week") {
    const mondayOffset = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset)).toISOString();
  }
  const truncated = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      period === "hour" ? d.getUTCHours() : 0,
    ),
  );
  return truncated.toISOString();
};

/** The bucket after this one. For tiling a range without arithmetic at the call site. */
export const nextBucket = (period: RollupPeriod, bucketStart: string): string => {
  const d = new Date(bucketStart);
  /**
   * A month advances by **calendar** month, not by 30 days — #175.
   *
   * `Date.UTC(y, m + 1, 1)` handles the December rollover and the varying length without a special case, where
   * adding a fixed span would put February's next bucket on the 2nd or 3rd of March and every subsequent bucket
   * further adrift.
   */
  if (period === "month") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  }
  // A week *is* exactly seven days, and unlike a month it has no calendar irregularity to respect — DST does not
  // exist in UTC, which is why the buckets are stored in UTC in the first place.
  const ms = period === "hour" ? 3_600_000 : period === "week" ? 7 * 86_400_000 : 86_400_000;
  return new Date(d.getTime() + ms).toISOString();
};

/** Every bucket start covering `[from, to)`, in order. */
export const bucketsBetween = (period: RollupPeriod, from: string, to: string): readonly string[] => {
  const out: string[] = [];
  let cursor = bucketStartFor(period, from);
  const end = new Date(to).getTime();
  // Bounded so a bad range cannot loop forever: a year of hours is the most anyone charts at that resolution,
  // and a caller wanting more is asking the wrong question of the wrong period.
  for (let guard = 0; guard < 9000 && new Date(cursor).getTime() < end; guard += 1) {
    out.push(cursor);
    cursor = nextBucket(period, cursor);
  }
  return out;
};

/**
 * What a tenant may consume in a period.
 *
 * Every field optional, and an omitted field is *unbounded* rather than zero. That direction is deliberate: a
 * misconfigured quota that blocks everything is an outage, and a misconfigured quota that blocks nothing is a
 * bill — and the bill is visible in the rollups this module also provides, whereas the outage is only visible
 * to the customer it is happening to.
 */
/** How the window reads in a sentence: "your 5,000 spend limit for **the day** / **any 5 hours**". */
export const describeWindow = (window: QuotaWindow): string =>
  window.kind === "calendar"
    ? `the ${window.period}`
    : window.minutes % 60 === 0
      ? `any ${window.minutes / 60} hour${window.minutes === 60 ? "" : "s"}`
      : `any ${window.minutes} minutes`;

export type QuotaLimits = {
  /**
   * The span this allowance covers.
   *
   * Was `period: RollupPeriod` until #181. Widened rather than supplemented, so there is exactly one place a
   * window is described and no combination of fields that means two things at once.
   */
  readonly window: QuotaWindow;
  /**
   * Whose allowance this is — absent means the whole tenant's (#175).
   *
   * Load-bearing, not informational: it decides **which rollup the usage is read from**. A per-person limit
   * checked against the tenant's total is not a per-person limit — the first busy colleague exhausts everyone's
   * allowance, and the person refused has spent nothing. That was the shape of the bug before this existed: the
   * guard already accepted per-principal *limits* through `resolveLimits`, and always compared them against
   * tenant-wide usage.
   */
  readonly principalId?: PrincipalId;
  readonly costMinorUnits?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Fraction of a limit at which a warning fires. Defaults to 0.8.
   *
   * A fraction rather than an absolute, so it scales with the limit instead of being meaningless on a large
   * plan and constantly tripping on a small one.
   */
  readonly warnAt?: number;
};

export const DEFAULT_WARN_AT = 0.8;

/** Which limit was hit. Separate values because the sentence a user reads differs. */
export const QUOTA_DIMENSIONS = ["cost", "input-tokens", "output-tokens"] as const;
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

/**
 * The admission answer.
 *
 * A union, so "refused" has no `allowed` shape to hide in: a caller cannot read a refusal as a permissive
 * default, which for a spend limit is the failure that costs money.
 */
export type QuotaDecision =
  | { readonly admitted: true; readonly usage: UsageTotals; readonly warnings: readonly QuotaWarning[] }
  | {
      readonly admitted: false;
      readonly dimension: QuotaDimension;
      readonly limit: number;
      readonly used: number;
      readonly message: string;
      readonly retryAfter: string;
    };

export type QuotaWarning = {
  readonly dimension: QuotaDimension;
  readonly limit: number;
  readonly used: number;
  readonly fraction: number;
  readonly message: string;
};

/**
 * Told when a tenant crosses a warning threshold.
 *
 * A sink of its own rather than a `RunEvent`, because a `RunEvent` carries a `runId` and a quota warning fires
 * *before* a run exists — which is the whole point of warning at admission. Squeezing it into the run stream
 * would mean inventing a run id for an event about not starting one.
 */
export interface QuotaObserver {
  onWarning(context: ExecutionContext, warning: QuotaWarning): Promise<void> | void;
  onRefusal?(
    context: ExecutionContext,
    refusal: Extract<QuotaDecision, { admitted: false }>,
  ): Promise<void> | void;
}

export type QuotaGuardDeps = {
  readonly rollups: UsageRollupStore;
  /**
   * The limits for this tenant, or undefined for unlimited.
   *
   * A function rather than a value: limits are per tenant and change without a redeploy, and a value captured
   * at construction would be the limits of whoever booted the process.
   */
  readonly resolveLimits: (context: ExecutionContext) => Promise<QuotaLimits | undefined> | QuotaLimits | undefined;
  /**
   * The ledger, needed **only** for a rolling window (#181) — rollups are calendar buckets and cannot answer an
   * arbitrary interval.
   *
   * Optional, so a deployment with only calendar limits wires nothing new. A rolling limit configured without it
   * throws at admission with a message naming the missing piece, rather than admitting the run: a spend guard
   * that cannot read spend must not be the thing that says yes.
   */
  readonly usage?: Pick<UsageStore, "totalsBetween">;
  readonly observer?: QuotaObserver;
  readonly clock?: () => string;
  readonly log?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
};

const DIMENSION_LABEL: Readonly<Record<QuotaDimension, string>> = {
  cost: "spend",
  "input-tokens": "input tokens",
  "output-tokens": "output tokens",
};

export const createQuotaGuard = (deps: QuotaGuardDeps) => {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});

  /**
   * Who the message is about — #175.
   *
   * Every message said "This workspace", which was true while every limit was a tenant's and became a lie the
   * moment one could belong to a person: someone refused for their own overspend was told the workspace was out,
   * so the obvious next step is asking a colleague to stop working. The sentence a person reads has to name the
   * thing that actually ran out.
   */
  const subject = (limits: QuotaLimits): string => (limits.principalId === undefined ? "This workspace" : "You");
  const verb = (limits: QuotaLimits): string => (limits.principalId === undefined ? "has" : "have");
  const possessive = (limits: QuotaLimits): string => (limits.principalId === undefined ? "its" : "your");

  /**
   * Usage for the window, and when there will be room again — #181.
   *
   * One function for both kinds, because everything downstream (the checks, the refusal, the warnings) must not
   * care which it got. The two arms differ in exactly the way the two windows differ:
   *
   * - **Calendar** reads the rollup. Admission is on the hot path of every message, and a check that scanned raw
   *   events would make the platform slower in proportion to how much it had been used. The reset is arithmetic:
   *   the next bucket boundary.
   * - **Rolling** reads the ledger over `[at - minutes, at)`, because there is no bucket to read. The scan is
   *   bounded by the window, not by history. Nothing "resets", so the sentence says when the oldest record in
   *   the window ages out — the soonest anything changes — and never promises a clean slate.
   *
   * A rolling window with nothing in it still has to answer: `earliestAt` is null then, and the sentence is
   * omitted rather than invented. That case is reachable — a limit of zero refuses on an empty window.
   */
  const read = async (
    context: ExecutionContext,
    limits: QuotaLimits,
    at: string,
  ): Promise<{ usage: UsageTotals; relief: { sentence: string; at: string } }> => {
    if (limits.window.kind === "calendar") {
      const bucketStart = bucketStartFor(limits.window.period, at);
      const rollup = await deps.rollups.get({
        tenantId: context.tenantId,
        period: limits.window.period,
        bucketStart,
        // The grain the limit is expressed at — #175. A per-person limit must read that person's bucket, or the
        // first busy colleague exhausts an allowance the refused person has not touched.
        ...(limits.principalId === undefined ? {} : { principalId: limits.principalId }),
      });
      const resetsAt = nextBucket(limits.window.period, bucketStart);
      return { usage: rollup ?? NO_USAGE, relief: { sentence: `It resets at ${resetsAt}.`, at: resetsAt } };
    }

    // A rolling window needs the ledger, which the rollup store cannot give — hence this dependency, and hence
    // it being required only once a rolling limit is actually configured.
    if (deps.usage === undefined)
      throw new Error(
        "a rolling quota window needs a UsageStore: rollups are keyed on calendar buckets and cannot answer " +
          "an arbitrary interval. Pass `usage` to createQuotaGuard, or configure a calendar window.",
      );

    const from = new Date(new Date(at).getTime() - limits.window.minutes * 60_000).toISOString();
    const { totals, earliestAt } = await deps.usage.totalsBetween({
      tenantId: context.tenantId,
      from,
      to: at,
      ...(limits.principalId === undefined ? {} : { principalId: limits.principalId }),
    });
    if (earliestAt === null)
      // No relief time to give, and none invented. `at` as the retry target is the honest answer: there is
      // nothing to wait for, so anything that changes must be the limit itself.
      return { usage: totals, relief: { sentence: "", at } };

    const relievesAt = new Date(new Date(earliestAt).getTime() + limits.window.minutes * 60_000).toISOString();
    return {
      usage: totals,
      relief: {
        // Deliberately not "it resets": a sliding window frees up gradually, and the oldest record leaving is
        // the first moment any of it does. Saying "resets" would promise the whole allowance back.
        sentence: `The oldest of it falls outside the window at ${relievesAt}.`,
        at: relievesAt,
      },
    };
  };

  return {
    /**
     * Decide whether a run may start — AC-2.
     *
     * Reads the current period's rollup, not the ledger: admission is on the hot path of every message, and a
     * check that scanned raw events would make the platform slower in proportion to how much it had been used.
     */
    async admit(context: ExecutionContext, at: string = clock()): Promise<QuotaDecision> {
      const limits = await deps.resolveLimits(context);
      // No limits configured is unbounded, not zero. A misconfigured quota that blocks everything is an
      // outage; one that blocks nothing is a bill, and the bill is visible in these very rollups.
      if (limits === undefined) return { admitted: true, usage: NO_USAGE, warnings: [] };

      const { usage, relief } = await read(context, limits, at);
      const warnAt = limits.warnAt ?? DEFAULT_WARN_AT;

      const checks: readonly { dimension: QuotaDimension; limit?: number; used: number }[] = [
        { dimension: "cost", ...(limits.costMinorUnits === undefined ? {} : { limit: limits.costMinorUnits }), used: usage.costMinorUnits },
        { dimension: "input-tokens", ...(limits.inputTokens === undefined ? {} : { limit: limits.inputTokens }), used: usage.inputTokens },
        { dimension: "output-tokens", ...(limits.outputTokens === undefined ? {} : { limit: limits.outputTokens }), used: usage.outputTokens },
      ];

      // Refusals first, across every dimension, before any warning is emitted. Emitting a warning and then
      // refusing would tell a customer they are approaching a limit they have already passed.
      for (const check of checks) {
        if (check.limit === undefined) continue;
        if (check.used >= check.limit) {
          const refusal = {
            admitted: false as const,
            dimension: check.dimension,
            limit: check.limit,
            used: check.used,
            // Actionable: names the dimension, the figure, the limit and when there will be room again.
            // "Quota exceeded" leaves a user with nothing to do.
            message:
              `${subject(limits)} ${verb(limits)} used ${check.used} of ${possessive(limits)} ${check.limit} ` +
              `${DIMENSION_LABEL[check.dimension]} limit for ${describeWindow(limits.window)}. ${relief.sentence}`,
            retryAfter: relief.at,
          };
          try {
            await deps.observer?.onRefusal?.(context, refusal);
          } catch (error) {
            // A refusal must not depend on an observer succeeding: the point is to stop work, and a broken
            // notification is not a reason to let it through.
            log("quota refusal observer failed", { error });
          }
          return refusal;
        }
      }

      const warnings: QuotaWarning[] = [];
      for (const check of checks) {
        if (check.limit === undefined || check.limit === 0) continue;
        const fraction = check.used / check.limit;
        if (fraction < warnAt) continue;
        warnings.push({
          dimension: check.dimension,
          limit: check.limit,
          used: check.used,
          fraction,
          message:
            `${subject(limits)} ${verb(limits)} used ${Math.round(fraction * 100)}% of ${possessive(limits)} ` +
            `${DIMENSION_LABEL[check.dimension]} limit for ${describeWindow(limits.window)}.`,
        });
      }
      for (const warning of warnings) {
        try {
          await deps.observer?.onWarning(context, warning);
        } catch (error) {
          // Logged, not thrown. A failed warning must not refuse a run that is inside its limit — that would
          // turn a notification outage into a service outage.
          log("quota warning observer failed", { error });
        }
      }
      return { admitted: true, usage, warnings };
    },

    /**
     * The limits in force for this context, or undefined for unlimited.
     *
     * Exposed so a UI can render "you have used X of Y" without a second source for Y — a panel that took its
     * limit from configuration while enforcement took it from here would eventually disagree, and the version
     * a user sees would be the wrong one.
     */
    async limits(context: ExecutionContext): Promise<QuotaLimits | undefined> {
      return deps.resolveLimits(context);
    },

    /** Throws the refusal, for a caller that would rather not branch. Same decision, different ergonomics. */
    async assertAdmitted(context: ExecutionContext, at?: string): Promise<QuotaDecision> {
      const decision = await this.admit(context, at);
      if (!decision.admitted)
        throw new AgentPlatformError({
          code: "budget_exceeded",
          message: decision.message,
          // Retryable: the limit resets. A caller that treats this as permanent would give up on a workspace
          // that is fine again in an hour.
          retryable: true,
          /**
           * **When** it resets — #175.
           *
           * "Retryable" without a time is not actionable: a caller can only guess, and an HTTP surface has no
           * `retry-after` to send. A client reading zero, or defaulting to immediately, retries straight back
           * into the same refusal.
           *
           * In `details` because that field is the redacted, user-safe context — and a bucket boundary is not a
           * secret. The dimension and figures are here too, so a client can say *which* limit without parsing
           * the sentence.
           */
          details: {
            retryAfter: decision.retryAfter,
            dimension: decision.dimension,
            limit: decision.limit,
            used: decision.used,
          },
        });
      return decision;
    },
  };
};

export type QuotaGuard = ReturnType<typeof createQuotaGuard>;

/**
 * `resolveLimits` backed by the admin-configured store — #175.
 *
 * The guard already took `resolveLimits` as a function so limits could change without a redeploy. What was
 * missing was anything to resolve them *from*: every deployment had to hardcode them, which is not a
 * configuration.
 *
 * **Per-person first, tenant default second, unbounded last.** The store decides which row applies; this decides
 * what to do when a person has no override — and it deliberately does *not* fall back to checking the tenant
 * default against the person's own usage. That would compare a tenant-sized allowance to one person's spend, so
 * nobody would ever hit it and the limit would silently do nothing.
 *
 * So the resolved limit carries the grain it was configured at, and the guard reads the matching rollup. A limit
 * and the usage it is compared against have to be the same shape, and this is the one place that can guarantee
 * it.
 */
export const createStoredLimitResolver = (deps: {
  readonly limits: UsageLimitStore;
  /**
   * Which windows to consider, and in what order.
   *
   * Default: every window the tenant has actually configured, shortest span first. Supply this to pin the order
   * or to restrict it.
   */
  readonly windows?: readonly QuotaWindow[];
}) => {
  return async (context: ExecutionContext): Promise<QuotaLimits | undefined> => {
    /**
     * The windows come from the store, not from a hardcoded list — #181.
     *
     * This walked `PERIOD_PRECEDENCE` and asked `resolve` for each calendar period. A rolling window has no
     * period, so an admin could store `rolling:300` through `/api/limits`, see it come back from `GET`, and never
     * have it enforced: the resolver never asked for it. Built, stored, visible and unreachable — which is the
     * failure this codebase keeps finding, so it does not get to happen to the feature that exists to stop
     * people spending money.
     *
     * `list` is one query where the old loop was up to four, and it cannot miss a window it has never heard of.
     */
    const configured =
      deps.windows ??
      (await deps.limits.list({ tenantId: context.tenantId }))
        .map((record) => record.window)
        // Deduplicated by key, because a tenant row and a principal row for the same window are one window to
        // consider, not two — `resolve` then picks between them.
        .filter((window, index, all) => all.findIndex((w) => windowKey(w) === windowKey(window)) === index)
        .sort((a, b) => spanMinutes(a) - spanMinutes(b));

    for (const window of configured) {
      const record = await deps.limits.resolve({
        tenantId: context.tenantId,
        principalId: context.principalId,
        window,
      });
      if (record === null) continue;
      return {
        // The window as stored, so a rolling row configured by an admin is enforced as rolling.
        window: record.window,
        // The grain the limit was configured at, so the guard reads the matching rollup rather than the tenant's.
        ...(record.principalId === undefined ? {} : { principalId: record.principalId }),
        ...(record.costMinorUnits === undefined ? {} : { costMinorUnits: record.costMinorUnits }),
        ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
        ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
        ...(record.warnAt === undefined ? {} : { warnAt: record.warnAt }),
      };
    }
    // Nothing configured at any window: unbounded, which is the direction that fails towards a bill rather than
    // towards an outage.
    return undefined;
  };
};

/**
 * A window's length in minutes, for **ordering only**.
 *
 * A month is 28 to 31 days, so this is approximate by construction — and that is fine for deciding which of two
 * limits to check first, and would not be fine for deciding whether someone is over one. Nothing computes usage
 * from this; `bucketStartFor` and `nextBucket` do the real calendar arithmetic.
 */
const spanMinutes = (window: QuotaWindow): number =>
  window.kind === "rolling"
    ? window.minutes
    : window.period === "hour"
      ? 60
      : window.period === "day"
        ? 1_440
        : window.period === "week"
          ? 10_080
          : 43_200;

/**
 * The order periods are considered in, shortest first.
 *
 * Shortest first because a shorter window is the tighter constraint in practice: someone with a monthly
 * allowance who has burned it in a day is stopped by the daily limit a day earlier, and being stopped early is
 * recoverable where a surprise at month end is not. It is a default, and a deployment that disagrees passes its
 * own order.
 */
export const PERIOD_PRECEDENCE: readonly RollupPeriod[] = ["hour", "day", "week", "month"];
