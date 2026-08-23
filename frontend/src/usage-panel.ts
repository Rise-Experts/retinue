/**
 * Shaping a usage report for the spend panel (#140).
 *
 * React-free, for the reason `context-inspector.ts` and `part-summary.ts` are: what can be got wrong here is
 * *arithmetic and state classification*, and both are provable about a value and merely observable about a
 * rendered tree.
 *
 * Three decisions.
 *
 * **Empty is a state, not a zero.** A tenant with no usage must not see a chart of zeroes: a zeroed graph says
 * "we measured and it was nothing", which is a different and misleading claim from "there is nothing to
 * measure". So `state` is a union and a renderer switches on it rather than checking whether an array is
 * empty — a check it would eventually forget.
 *
 * **The quota state comes from the server.** `warning` and `exceeded` are computed by the same guard that
 * refuses admission. A panel recomputing a threshold would eventually show "you are fine" while runs are being
 * refused, which is worse than showing nothing.
 *
 * **Bars are fractions, not pixels.** The shape carries a 0–1 `fraction` per bucket and the renderer decides
 * how to draw it. That keeps this file free of layout and lets the same numbers drive a bar, a sparkline or a
 * screen-reader summary.
 */

/** Mirrors the `UsageTotals` the GraphQL query returns. Structural, so no import from the backend is needed. */
export type UsageTotalsView = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costMinorUnits: number;
  readonly eventCount: number;
};

export type UsageBucketView = {
  readonly bucketStart: string;
  readonly totals: UsageTotalsView;
  readonly currency: string;
};

export type UsageBreakdownEntryView = {
  readonly key: string;
  readonly totals: UsageTotalsView;
};

export type UsageQuotaView = {
  readonly period: string;
  readonly costLimitMinorUnits: number | null;
  readonly inputTokenLimit: number | null;
  readonly outputTokenLimit: number | null;
  readonly warnAt: number;
  readonly warning: boolean;
  readonly exceeded: boolean;
};

export type UsageReportView = {
  readonly period: string;
  readonly from: string;
  readonly to: string;
  readonly totals: UsageTotalsView;
  readonly buckets: readonly UsageBucketView[];
  readonly byModel: readonly UsageBreakdownEntryView[];
  readonly byConversation: readonly UsageBreakdownEntryView[];
  readonly quota: UsageQuotaView | null;
  readonly currency: string;
};

/**
 * What the panel is showing.
 *
 * A union so an empty report and a loaded one are different shapes: a renderer cannot show a zeroed chart by
 * forgetting to check an array's length, because in the empty case there is no array to read.
 */
export type UsagePanelState = "loading" | "empty" | "loaded" | "error";

export type UsageBar = {
  readonly bucketStart: string;
  readonly costMinorUnits: number;
  /** 0–1 against the largest bucket in range. Layout is the renderer's business. */
  readonly fraction: number;
};

/** How a quota should read. `none` is distinct from `ok`: no limit is not the same as plenty of room. */
export type QuotaStatus = "none" | "ok" | "warning" | "exceeded";

export type UsagePanelData = {
  readonly state: UsagePanelState;
  readonly period: string;
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly totals: UsageTotalsView;
  readonly bars: readonly UsageBar[];
  readonly byModel: readonly UsageBreakdownEntryView[];
  readonly byConversation: readonly UsageBreakdownEntryView[];
  readonly quota: {
    readonly status: QuotaStatus;
    readonly costLimitMinorUnits: number | null;
    /** 0–1 of the cost limit consumed, or null when there is no cost limit to be a fraction of. */
    readonly costFraction: number | null;
    readonly warnAt: number;
  };
};

export const ZERO_TOTALS_VIEW: UsageTotalsView = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costMinorUnits: 0,
  eventCount: 0,
};

/**
 * Classify the quota.
 *
 * `exceeded` before `warning`, because past the limit a user is not "approaching" anything — and both come from
 * the server rather than being derived from the numbers here, so the panel and the enforcement cannot disagree.
 */
export const quotaStatusOf = (quota: UsageQuotaView | null): QuotaStatus => {
  if (quota === null) return "none";
  if (quota.exceeded) return "exceeded";
  if (quota.warning) return "warning";
  return "ok";
};

/**
 * Shape a report into panel data.
 *
 * `state` is decided from `eventCount`, not from the bucket array. A range can legitimately contain buckets
 * whose totals are all zero — a rollup job that ran over a quiet hour writes one — and treating that as
 * "loaded" would draw the zeroed chart the empty state exists to avoid.
 */
export const shapeUsagePanel = (
  report: UsageReportView | null,
  options: { readonly loading?: boolean; readonly error?: boolean } = {},
): UsagePanelData => {
  const base = {
    period: report?.period ?? "day",
    from: report?.from ?? "",
    to: report?.to ?? "",
    currency: report?.currency ?? "",
    totals: report?.totals ?? ZERO_TOTALS_VIEW,
    bars: [] as readonly UsageBar[],
    byModel: [] as readonly UsageBreakdownEntryView[],
    byConversation: [] as readonly UsageBreakdownEntryView[],
    quota: {
      status: quotaStatusOf(report?.quota ?? null),
      costLimitMinorUnits: report?.quota?.costLimitMinorUnits ?? null,
      costFraction: null as number | null,
      warnAt: report?.quota?.warnAt ?? 0.8,
    },
  };

  // Error before loading: a failed refresh of an already-loaded panel is an error, and showing a spinner for it
  // would hide the failure behind an animation that never ends.
  if (options.error === true) return { ...base, state: "error" };
  if (options.loading === true || report === null) return { ...base, state: "loading" };
  if (report.totals.eventCount === 0) return { ...base, state: "empty" };

  const peak = Math.max(...report.buckets.map((b) => b.totals.costMinorUnits), 0);
  const limit = report.quota?.costLimitMinorUnits ?? null;
  return {
    ...base,
    state: "loaded",
    bars: report.buckets.map((b) => ({
      bucketStart: b.bucketStart,
      costMinorUnits: b.totals.costMinorUnits,
      // Against the peak, so a quiet period is visibly quiet rather than rescaled to look busy. Zero when the
      // whole range is zero, which avoids a division that would produce NaN and a bar of width "NaN%".
      fraction: peak === 0 ? 0 : b.totals.costMinorUnits / peak,
    })),
    byModel: report.byModel,
    byConversation: report.byConversation,
    quota: {
      ...base.quota,
      costFraction:
        limit === null || limit === 0
          ? null
          : // Capped at 1: a bar wider than its track is a rendering bug, and past the limit the useful
            // information is "full", not "112%" — which the exceeded state says in words.
            Math.min(1, report.totals.costMinorUnits / limit),
    },
  };
};

/**
 * A cost in minor units, formatted for the reader's locale.
 *
 * `Intl.NumberFormat` with the report's currency, so €1,234.56 and $1,234.56 render the way each locale writes
 * them — including which side the symbol goes on and which separator is which. Dividing by 100 here is the one
 * place minor units become major ones; doing it at a call site is how a figure ends up a hundred times wrong.
 *
 * Falls back to a plain number when the currency is unknown — a period with no usage has no currency, and
 * `Intl` throws on an empty currency code rather than degrading.
 */
export const formatCost = (minorUnits: number, currency: string, locale?: string): string => {
  if (currency === "")
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      minorUnits / 100,
    );
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minorUnits / 100);
};

/** A token count, grouped for the locale. Compact above ten thousand, because exact digits stop being read. */
export const formatTokens = (tokens: number, locale?: string): string =>
  new Intl.NumberFormat(locale, tokens >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(
    tokens,
  );
