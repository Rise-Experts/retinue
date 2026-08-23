/**
 * The usage and cost panel (#140).
 *
 * The rollups exist; without this nobody can see their own consumption, so the transparency goal is unmet.
 *
 * Five decisions.
 *
 * **The chart is semantic HTML, not a library.** A bar per period, drawn as a proportional element inside a
 * table row. The package ships no charting dependency and adding one for a single component is the trade the
 * issue rules out — and a `<table>` of periods and costs is *more* accessible than a canvas, because a screen
 * reader reads the numbers rather than an alt text summarising them.
 *
 * **Mobile first.** The breakdown is a table that becomes stacked rows below 480px: a horizontally-scrolling
 * table on a phone is a table nobody scrolls. The shipped stylesheet does that with no JavaScript, so it holds
 * during load and with scripting off.
 *
 * **The empty state is a state.** A tenant with no usage sees a sentence, not a chart of zeroes — a zeroed
 * graph says "we measured and it was nothing", a different and misleading claim.
 *
 * **The quota bar is never a lie.** Its fraction is capped at 1, its status comes from the server's own
 * enforcement, and "no limit configured" renders as text rather than as an empty track that reads as "plenty
 * of room".
 *
 * **No hue carries meaning.** Warning and exceeded are distinguished by a border pattern and a text label, the
 * same rule #138 established for grounded citations, so the states survive greyscale and colour-blindness.
 */

import type { ReactNode } from "react";
import {
  formatCost,
  formatTokens,
  shapeUsagePanel,
  type UsagePanelData,
  type UsageReportView,
} from "../usage-panel.js";
import type { T } from "./components.js";

const identity: T = (id) => id;

/**
 * A bucket's label, formatted here rather than in the catalogue.
 *
 * Every figure in this panel is formatted by the component with the `locale` prop and passed in already
 * localised, so the catalogue only interpolates. The alternative — letting a catalogue entry call `intl.dateTime`
 * — formats with the *translator's* locale, which can differ from the prop: one panel would then show a German
 * date next to an English currency. One locale, one place.
 *
 * An hour bucket needs the time; a day bucket does not, and "00:00" on every row of a daily chart is noise that
 * makes the rows harder to tell apart.
 */
export const formatBucket = (bucketStart: string, period: string, locale?: string): string =>
  new Intl.DateTimeFormat(
    locale,
    period === "hour" ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "medium" },
  ).format(new Date(bucketStart));

/** Percentage string for a 0–1 fraction. One decimal, because a bar 0.05% wide is not a bar. */
const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * A row of the period chart.
 *
 * The bar is a `<span>` sized by `style.width` — the one place an inline style is right, because the width *is*
 * the datum and putting it in a stylesheet would mean generating a class per value.
 */
const BarRow = (props: {
  readonly label: string;
  readonly value: string;
  readonly fraction: number;
  readonly t: T;
}): ReactNode => (
  <tr data-usage-row>
    <th scope="row" data-usage-label>
      {props.label}
    </th>
    <td data-usage-bar-cell>
      {/* `aria-hidden`: the number is in the next cell, and a screen reader announcing a decorative bar as well
          would read every row twice. */}
      <span data-usage-bar style={{ width: percent(props.fraction) }} aria-hidden="true" />
    </td>
    <td data-usage-value>{props.value}</td>
  </tr>
);

export const UsageQuotaBar = (props: {
  readonly data: UsagePanelData;
  readonly t?: T;
  readonly locale?: string;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  const { quota, currency, totals } = props.data;
  if (quota.status === "none")
    // Text, not an empty track. An empty bar reads as "plenty of room", which is a claim about a limit that
    // does not exist.
    return (
      <p className={props.className} data-usage-quota="none">
        {t(USAGE_IDS.noLimit)}
      </p>
    );

  return (
    <div className={props.className} data-usage-quota={quota.status}>
      <p data-usage-quota-label>
        {t(USAGE_IDS.quotaUsed, {
          used: formatCost(totals.costMinorUnits, currency, props.locale),
          limit: formatCost(quota.costLimitMinorUnits ?? 0, currency, props.locale),
        })}
      </p>
      {/* A real progress element: it announces its value, responds to a forced-colours mode, and needs no ARIA
          of its own. A styled div would need all three reimplemented. */}
      <progress data-usage-quota-bar max={1} value={quota.costFraction ?? 0}>
        {percent(quota.costFraction ?? 0)}
      </progress>
      {quota.status !== "ok" ? (
        // The state in words as well as in the styling, because the styling is a border pattern and a border is
        // not announced.
        <p data-usage-quota-state role={quota.status === "exceeded" ? "alert" : "status"}>
          {t(quota.status === "exceeded" ? USAGE_IDS.quotaExceeded : USAGE_IDS.quotaWarning)}
        </p>
      ) : null}
    </div>
  );
};

export const UsageBreakdown = (props: {
  readonly title: string;
  readonly entries: UsagePanelData["byModel"];
  readonly currency: string;
  readonly t?: T;
  readonly locale?: string;
  readonly emptyLabel: string;
}): ReactNode => {
  const t = props.t ?? identity;
  const peak = Math.max(...props.entries.map((e) => e.totals.costMinorUnits), 0);
  return (
    <section data-usage-breakdown>
      <h3>{props.title}</h3>
      {props.entries.length === 0 ? (
        <p data-usage-breakdown-empty>{props.emptyLabel}</p>
      ) : (
        <table data-usage-table>
          <caption>{props.title}</caption>
          <thead>
            <tr>
              <th scope="col">{t(USAGE_IDS.columnName)}</th>
              <th scope="col">{t(USAGE_IDS.columnShare)}</th>
              <th scope="col">{t(USAGE_IDS.columnCost)}</th>
            </tr>
          </thead>
          <tbody>
            {props.entries.map((entry) => (
              <BarRow
                key={entry.key}
                // An empty key is a usage event with no conversation — a background extraction. Labelled rather
                // than shown blank, so the breakdown visibly adds up.
                label={entry.key === "" ? t(USAGE_IDS.noConversation) : entry.key}
                value={formatCost(entry.totals.costMinorUnits, props.currency, props.locale)}
                fraction={peak === 0 ? 0 : entry.totals.costMinorUnits / peak}
                t={t}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

export const UsagePanel = (props: {
  readonly report: UsageReportView | null;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly t?: T;
  readonly locale?: string;
  readonly className?: string;
}): ReactNode => {
  const t = props.t ?? identity;
  const data = shapeUsagePanel(props.report, {
    ...(props.loading === undefined ? {} : { loading: props.loading }),
    ...(props.error === undefined ? {} : { error: props.error }),
  });

  if (data.state === "error")
    // The same shape `PartView` uses for an error part: a labelled alert, not a silent blank.
    return (
      <div className={props.className} data-usage-state="error" role="alert">
        {t(USAGE_IDS.loadFailed)}
      </div>
    );

  if (data.state === "loading")
    return (
      <div className={props.className} data-usage-state="loading" role="status" aria-busy="true">
        {t(USAGE_IDS.loading)}
      </div>
    );

  if (data.state === "empty")
    // A sentence explaining *why* it is empty, not a chart of zeroes. Still shows the quota, because a new
    // tenant's limit is worth knowing before they spend anything.
    return (
      <div className={props.className} data-usage-state="empty">
        <p data-usage-empty>{t(USAGE_IDS.empty)}</p>
        <UsageQuotaBar data={data} t={props.t} {...(props.locale === undefined ? {} : { locale: props.locale })} />
      </div>
    );

  return (
    <div className={props.className} data-usage-state="loaded">
      <p data-usage-total>
        {t(USAGE_IDS.total, {
          cost: formatCost(data.totals.costMinorUnits, data.currency, props.locale),
          tokens: formatTokens(data.totals.inputTokens + data.totals.outputTokens, props.locale),
        })}
      </p>
      <UsageQuotaBar data={data} t={props.t} {...(props.locale === undefined ? {} : { locale: props.locale })} />

      <table data-usage-table data-usage-periods>
        <caption>{t(USAGE_IDS.byPeriod)}</caption>
        <thead>
          <tr>
            <th scope="col">{t(USAGE_IDS.columnPeriod)}</th>
            <th scope="col">{t(USAGE_IDS.columnShare)}</th>
            <th scope="col">{t(USAGE_IDS.columnCost)}</th>
          </tr>
        </thead>
        <tbody>
          {data.bars.map((bar) => (
            <BarRow
              key={bar.bucketStart}
              label={t(USAGE_IDS.bucketLabel, {
                label: formatBucket(bar.bucketStart, data.period, props.locale),
              })}
              value={formatCost(bar.costMinorUnits, data.currency, props.locale)}
              fraction={bar.fraction}
              t={t}
            />
          ))}
        </tbody>
      </table>

      <UsageBreakdown
        title={t(USAGE_IDS.byModel)}
        entries={data.byModel}
        currency={data.currency}
        t={props.t}
        {...(props.locale === undefined ? {} : { locale: props.locale })}
        emptyLabel={t(USAGE_IDS.noBreakdown)}
      />
      <UsageBreakdown
        title={t(USAGE_IDS.byConversation)}
        entries={data.byConversation}
        currency={data.currency}
        t={props.t}
        {...(props.locale === undefined ? {} : { locale: props.locale })}
        emptyLabel={t(USAGE_IDS.noBreakdown)}
      />
    </div>
  );
};

/**
 * String ids, as constants.
 *
 * Constants rather than literals at the call sites for the reason `CITATION_IDS` is: a mistyped id renders as
 * the id, which looks like a missing translation rather than a typo.
 */
export const USAGE_IDS = {
  loading: "usage.loading",
  loadFailed: "usage.loadFailed",
  empty: "usage.empty",
  total: "usage.total",
  byPeriod: "usage.byPeriod",
  byModel: "usage.byModel",
  byConversation: "usage.byConversation",
  noBreakdown: "usage.noBreakdown",
  noConversation: "usage.noConversation",
  noLimit: "usage.noLimit",
  quotaUsed: "usage.quotaUsed",
  quotaWarning: "usage.quotaWarning",
  quotaExceeded: "usage.quotaExceeded",
  columnPeriod: "usage.columnPeriod",
  columnName: "usage.columnName",
  columnShare: "usage.columnShare",
  columnCost: "usage.columnCost",
  bucketLabel: "usage.bucketLabel",
} as const;

/**
 * The stylesheet a host can include.
 *
 * **Mobile first**: the base rules stack the table into rows, and a `min-width` query restores columns on a
 * wider screen. That direction matters — a desktop-first sheet leaves a phone with the horizontally-scrolling
 * table the requirement rules out, and only fixes it if the query matches.
 *
 * **No hue carries meaning.** Warning and exceeded are a border pattern plus a text label. In greyscale, in
 * forced-colours mode, and to a colour-blind reader they all still read.
 */
export const USAGE_STYLES = `
[data-usage-table] { width: 100%; border-collapse: collapse; }
[data-usage-table] caption { text-align: left; font-weight: 600; padding: 0.35em 0; }

/* Mobile first: each row becomes a stacked block. A table that scrolls sideways on a phone is one nobody
   scrolls. */
[data-usage-table] thead { display: none; }
[data-usage-row] { display: grid; grid-template-columns: 1fr auto; gap: 0.15em 0.5em; padding: 0.4em 0; border-bottom: 1px solid currentColor; }
[data-usage-label] { text-align: left; font-weight: 500; }
[data-usage-value] { text-align: right; font-variant-numeric: tabular-nums; }
[data-usage-bar-cell] { grid-column: 1 / -1; }
[data-usage-bar] { display: block; height: 0.4em; background: currentColor; min-width: 1px; }

@media (min-width: 480px) {
  /* Restored to real table layout where there is room for it. */
  [data-usage-table] thead { display: table-header-group; }
  [data-usage-row] { display: table-row; }
  [data-usage-bar-cell] { width: 50%; }
}

[data-usage-quota-bar] { width: 100%; }
/* Warning and exceeded, without hue: a dashed then doubled border, plus the text label the component renders. */
[data-usage-quota="warning"] { border-left: 4px dashed currentColor; padding-left: 0.5em; }
[data-usage-quota="exceeded"] { border-left: 4px double currentColor; padding-left: 0.5em; font-weight: 600; }
[data-usage-state="error"] { border-top: 1px dashed currentColor; padding-top: 0.35em; font-weight: 600; }
[data-usage-total] { font-weight: 600; }
`;
