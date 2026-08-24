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
  /**
   * The model this allowance covers, or absent for any model — #182.
   *
   * Load-bearing in the same way `principalId` is: it decides **which records the usage is read from**. A limit
   * on an expensive model checked against all traffic is not a per-model limit — a busy hour on a cheap model
   * exhausts it, and the person refused has not touched the model they are being refused for.
   */
  readonly modelId?: string;
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
      /** Present when the limit that refused is scoped to one model — #182. */
      readonly modelId?: string;
      readonly message: string;
      readonly retryAfter: string;
    };

/**
 * One limit, with what it allows, what has been used, and when that changes — #183.
 *
 * Shaped for rendering: the window as words rather than a union to switch on, the scope as a word rather than an
 * optional id to test for presence, and the fraction computed once here rather than in every client.
 */
export type QuotaExplanation = {
  readonly window: string;
  readonly modelId?: string;
  readonly scope: "workspace" | "personal";
  readonly resetsAt: string;
  /** The sentence a refusal would use — "It resets at T", or the sliding-window wording. Empty when neither. */
  readonly resetNote: string;
  readonly dimensions: readonly {
    readonly dimension: QuotaDimension;
    readonly limit: number;
    readonly used: number;
    readonly fraction: number;
  }[];
};

export type QuotaWarning = {
  readonly dimension: QuotaDimension;
  readonly limit: number;
  readonly used: number;
  readonly fraction: number;
  /** Present when the limit is scoped to one model — #182. */
  readonly modelId?: string;
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

/**
 * What is being admitted, beyond who is asking — #182.
 *
 * The model belongs here rather than on `ExecutionContext`: the context is who and where, and a per-model limit
 * is about *what this run will use*. Two runs by the same person in the same workspace can be subject to
 * different limits, which is not something an identity can express.
 *
 * Absent `modelId` means model-scoped limits do not apply. That is the safe direction for a *check* — it cannot
 * refuse the wrong work — and the caller that knows the model is the one that must say so.
 */
export type QuotaSubject = {
  readonly at?: string;
  readonly modelId?: string;
};

export type QuotaGuardDeps = {
  readonly rollups: UsageRollupStore;
  /**
   * The limits for this tenant, or undefined for unlimited.
   *
   * A function rather than a value: limits are per tenant and change without a redeploy, and a value captured
   * at construction would be the limits of whoever booted the process.
   */
  /**
   * **Every** limit that applies, shortest span first — widened from a single limit by #182.
   *
   * A list rather than one, because a person is subject to several at once and all of them bind: a five-hour
   * cap, a monthly cap, a per-model cap. Returning the most specific one meant the others were configured,
   * visible and unenforced. An empty list is unbounded.
   */
  readonly resolveLimits: (
    context: ExecutionContext,
    about: QuotaSubject,
  ) => Promise<readonly QuotaLimits[]> | readonly QuotaLimits[];
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
   * " on claude-opus-5", or nothing at all — #182.
   *
   * Part of the sentence rather than appended after it, so the limit reads as being *for that model* instead of
   * as a general limit with a note. Somebody whose Opus allowance is spent can still work on a cheaper model,
   * and a message that does not say which model turns a narrow limit into an apparent outage.
   */
  const scopeOf = (limits: QuotaLimits): string =>
    limits.modelId === undefined ? "" : ` on ${limits.modelId}`;

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
    /**
     * A **model-scoped** limit always reads the ledger, whichever kind of window it has — #182.
     *
     * The rollups have no model dimension, and adding one would multiply their row count by the number of models
     * a tenant uses to serve a check that a bounded index scan already answers — the same trade `breakdown`
     * documents. For a calendar window the interval is exactly `[bucketStart, nextBucket)`, so the number is
     * exact either way; only the source differs.
     */
    if (limits.window.kind === "calendar" && limits.modelId === undefined) {
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

    // Everything else needs the ledger, which the rollup store cannot give — hence this dependency, and hence
    // it being required only once such a limit is actually configured.
    if (deps.usage === undefined)
      throw new Error(
        "this quota window needs a UsageStore: rollups are keyed on calendar buckets with no model dimension, " +
          "so a rolling window or a per-model limit cannot be answered from them. Pass `usage` to " +
          "createQuotaGuard, or configure an unscoped calendar limit.",
      );

    // A calendar window scoped to a model still has calendar bounds; only a rolling one is measured back from
    // now. Computing the bounds here keeps the two cases one code path with one set of filters.
    const bounds =
      limits.window.kind === "calendar"
        ? (() => {
            const bucketStart = bucketStartFor(limits.window.period, at);
            const resetsAt = nextBucket(limits.window.period, bucketStart);
            return { from: bucketStart, to: at, calendarResetsAt: resetsAt };
          })()
        : {
            from: new Date(new Date(at).getTime() - limits.window.minutes * 60_000).toISOString(),
            to: at,
            calendarResetsAt: undefined,
          };

    const { totals, earliestAt } = await deps.usage.totalsBetween({
      tenantId: context.tenantId,
      from: bounds.from,
      to: bounds.to,
      ...(limits.principalId === undefined ? {} : { principalId: limits.principalId }),
      ...(limits.modelId === undefined ? {} : { modelId: limits.modelId }),
    });

    // A calendar window does reset, even when its usage came from the ledger — so it says so, and says the true
    // boundary rather than the sliding-window sentence.
    if (bounds.calendarResetsAt !== undefined)
      return {
        usage: totals,
        relief: { sentence: `It resets at ${bounds.calendarResetsAt}.`, at: bounds.calendarResetsAt },
      };
    if (earliestAt === null)
      // No relief time to give, and none invented. `at` as the retry target is the honest answer: there is
      // nothing to wait for, so anything that changes must be the limit itself.
      return { usage: totals, relief: { sentence: "", at } };

    const relievesAt = new Date(
      new Date(earliestAt).getTime() + (limits.window.kind === "rolling" ? limits.window.minutes : 0) * 60_000,
    ).toISOString();
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
    // `about`, not `subject` — `subject()` below is the helper that decides "You" versus "This workspace",
    // and shadowing it here made every refusal message try to call a plain object.
    async admit(context: ExecutionContext, about: QuotaSubject = {}): Promise<QuotaDecision> {
      const at = about.at ?? clock();
      const applicable = await deps.resolveLimits(context, about);
      // Nothing configured is unbounded, not zero. A misconfigured quota that blocks everything is an outage;
      // one that blocks nothing is a bill, and the bill is visible in these very rollups.
      if (applicable.length === 0) return { admitted: true, usage: NO_USAGE, warnings: [] };

      /**
       * **Every** applicable limit is checked, not the most specific one — #182.
       *
       * This resolved a single limit, which meant a workspace-wide cap on an expensive model was silently
       * ignored for anybody who also had a personal overall limit: the personal one was "more specific", so the
       * model cap was never read. But they are not competing answers to one question — they are two allowances,
       * and both bind. That is what a limit means everywhere it is used in practice.
       *
       * Ordered shortest-span first by the resolver, so the limit a person is refused by is the one that stops
       * them soonest, which is also the one whose reset time is nearest and therefore most useful to hear.
       */
      const evaluated = [] as {
        limits: QuotaLimits;
        usage: UsageTotals;
        relief: { sentence: string; at: string };
        checks: readonly { dimension: QuotaDimension; limit?: number; used: number }[];
      }[];
      for (const limits of applicable) {
        const { usage, relief } = await read(context, limits, at);
        evaluated.push({
          limits,
          usage,
          relief,
          checks: [
            { dimension: "cost", ...(limits.costMinorUnits === undefined ? {} : { limit: limits.costMinorUnits }), used: usage.costMinorUnits },
            { dimension: "input-tokens", ...(limits.inputTokens === undefined ? {} : { limit: limits.inputTokens }), used: usage.inputTokens },
            { dimension: "output-tokens", ...(limits.outputTokens === undefined ? {} : { limit: limits.outputTokens }), used: usage.outputTokens },
          ],
        });
      }

      // Refusals first, across every limit and every dimension, before any warning is emitted. Warning and then
      // refusing would tell somebody they are approaching a limit they have already passed.
      for (const { limits, relief, checks } of evaluated) {
        for (const check of checks) {
          if (check.limit === undefined) continue;
          if (check.used >= check.limit) {
            const refusal = {
              admitted: false as const,
              dimension: check.dimension,
              limit: check.limit,
              used: check.used,
              // The model, when the limit has one. "You have run out" reads as an account-wide stop, and
              // somebody whose Opus allowance is spent can still work on a cheaper model — so not saying which
              // model turns a small limit into an apparent outage.
              ...(limits.modelId === undefined ? {} : { modelId: limits.modelId }),
              // Actionable: names the dimension, the figure, the limit and when there will be room again.
              // "Quota exceeded" leaves a user with nothing to do.
              message:
                `${subject(limits)} ${verb(limits)} used ${check.used} of ${possessive(limits)} ${check.limit} ` +
                `${DIMENSION_LABEL[check.dimension]} limit${scopeOf(limits)} for ${describeWindow(limits.window)}. ` +
                `${relief.sentence}`,
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
      }

      const warnings: QuotaWarning[] = [];
      for (const { limits, checks } of evaluated) {
        const warnAt = limits.warnAt ?? DEFAULT_WARN_AT;
        for (const check of checks) {
          if (check.limit === undefined || check.limit === 0) continue;
          const fraction = check.used / check.limit;
          if (fraction < warnAt) continue;
          warnings.push({
            dimension: check.dimension,
            limit: check.limit,
            used: check.used,
            fraction,
            ...(limits.modelId === undefined ? {} : { modelId: limits.modelId }),
            message:
              `${subject(limits)} ${verb(limits)} used ${Math.round(fraction * 100)}% of ${possessive(limits)} ` +
              `${DIMENSION_LABEL[check.dimension]} limit${scopeOf(limits)} for ${describeWindow(limits.window)}.`,
          });
        }
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
      /**
       * The usage reported alongside an admission is the **first** limit's, which is the shortest span.
       *
       * There is no single "usage" once several limits apply, and inventing a sum across windows would be a
       * number that means nothing. The shortest span is the one a caller rendering a single figure wants, and
       * `explain` gives all of them to a caller that wants more.
       */
      return { admitted: true, usage: evaluated[0]?.usage ?? NO_USAGE, warnings };
    },

    /**
     * The limits in force for this context — an empty list for unlimited.
     *
     * Exposed so a UI can render "you have used X of Y" without a second source for Y — a panel that took its
     * limit from configuration while enforcement took it from here would eventually disagree, and the version a
     * user sees would be the wrong one.
     */
    async limits(context: ExecutionContext, about: QuotaSubject = {}): Promise<readonly QuotaLimits[]> {
      return deps.resolveLimits(context, about);
    },

    /**
     * Every limit with its usage and its reset — #183.
     *
     * A limit nobody can see is a limit that surprises people, and once several apply at once "how much have I
     * got left" stops being answerable by reading one number. This is the same `read` the refusal path uses, so
     * a panel cannot disagree with enforcement about either the figure or the reset time — the failure that a
     * second implementation of "how full is it" always eventually produces.
     *
     * Ordered as the resolver ordered them, shortest span first, which puts the limit most likely to stop you at
     * the top without the caller having to sort by anything.
     */
    async explain(context: ExecutionContext, about: QuotaSubject = {}): Promise<readonly QuotaExplanation[]> {
      const at = about.at ?? clock();
      const applicable = await deps.resolveLimits(context, about);
      const explained: QuotaExplanation[] = [];
      for (const limits of applicable) {
        const { usage, relief } = await read(context, limits, at);
        explained.push({
          window: describeWindow(limits.window),
          ...(limits.modelId === undefined ? {} : { modelId: limits.modelId }),
          // Whose allowance it is, so a personal limit is distinguishable from the workspace's without the
          // caller re-deriving it from the presence of a field.
          scope: limits.principalId === undefined ? "workspace" : "personal",
          resetsAt: relief.at,
          resetNote: relief.sentence,
          dimensions: (
            [
              ["cost", limits.costMinorUnits, usage.costMinorUnits],
              ["input-tokens", limits.inputTokens, usage.inputTokens],
              ["output-tokens", limits.outputTokens, usage.outputTokens],
            ] as const
          )
            // Only the bounded dimensions. An unbounded one has nothing to report, and rendering it as
            // "0 of null" is how a panel starts looking broken.
            .filter(([, limit]) => limit !== undefined)
            .map(([dimension, limit, used]) => ({
              dimension,
              limit: limit!,
              used,
              // Computed here, not by the caller: two implementations of a fraction eventually round differently
              // and the bar disagrees with the number beside it.
              fraction: limit! === 0 ? 1 : used / limit!,
            })),
        });
      }
      return explained;
    },

    /** Throws the refusal, for a caller that would rather not branch. Same decision, different ergonomics. */
    async assertAdmitted(context: ExecutionContext, about: QuotaSubject = {}): Promise<QuotaDecision> {
      const decision = await this.admit(context, about);
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
}) => {
  return async (context: ExecutionContext, about: QuotaSubject = {}): Promise<readonly QuotaLimits[]> => {
    /**
     * Every applicable limit, from the store, shortest span first — #181, #182.
     *
     * Two things this deliberately does not do. It does not walk a hardcoded list of periods: that was how a
     * stored `rolling:300` could be read back from the API and never enforced, because the resolver never asked
     * for it. And it does not pick one: a person subject to a five-hour cap, a monthly cap and an Opus cap is
     * subject to all three, and choosing the "most specific" left the others configured and unenforced.
     *
     * `applicable` does the override-within-a-scope selection in the store, where the rule has one
     * implementation per adapter and conformance holds them to the same behaviour.
     */
    const records = await deps.limits.applicable({
      tenantId: context.tenantId,
      ...(context.principalId === undefined ? {} : { principalId: context.principalId }),
      // The model of the run being admitted. Absent means model-scoped limits cannot apply — see `applicable`.
      ...(about.modelId === undefined ? {} : { modelId: about.modelId }),
    });

    return records
      .map((record) => ({
        window: record.window,
        ...(record.principalId === undefined ? {} : { principalId: record.principalId }),
        ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
        ...(record.costMinorUnits === undefined ? {} : { costMinorUnits: record.costMinorUnits }),
        ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
        ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
        ...(record.warnAt === undefined ? {} : { warnAt: record.warnAt }),
      }))
      // Shortest span first, so the limit that stops someone soonest is the one they are told about, and its
      // reset — the nearest one — is the one they can act on.
      .sort((a, b) => spanMinutes(a.window) - spanMinutes(b.window));
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
