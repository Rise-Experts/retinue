/**
 * The usage and cost panel (#140).
 *
 * The shaping is tested as a pure function and the markup with `react-dom/server`, the split #138 established:
 * arithmetic and state classification are provable about a value, and the element chosen and the ARIA wiring
 * are in the markup. Interaction is not exercised — there is none to exercise here.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOGS, createTranslator } from "../localization.js";
import {
  ZERO_TOTALS_VIEW,
  formatCost,
  formatTokens,
  quotaStatusOf,
  shapeUsagePanel,
  type UsageReportView,
} from "../usage-panel.js";
import { USAGE_IDS, USAGE_STYLES, UsagePanel, UsageQuotaBar, formatBucket } from "../ui/usage.js";

const t = createTranslator({ catalogs: DEFAULT_CATALOGS, locale: "en" }).t;

const totals = (cost: number, events = 1) => ({
  inputTokens: cost * 10,
  outputTokens: cost * 2,
  cachedInputTokens: 0,
  costMinorUnits: cost,
  eventCount: events,
});

const report = (overrides: Partial<UsageReportView> = {}): UsageReportView => ({
  period: "day",
  from: "2026-08-20T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  totals: totals(3000, 12),
  buckets: [
    { bucketStart: "2026-08-21T00:00:00.000Z", totals: totals(1000), currency: "EUR" },
    { bucketStart: "2026-08-22T00:00:00.000Z", totals: totals(2000), currency: "EUR" },
  ],
  byModel: [
    { key: "gpt-4o", totals: totals(2500) },
    { key: "gpt-4o-mini", totals: totals(500) },
  ],
  byConversation: [
    { key: "convo-1", totals: totals(1800) },
    { key: "", totals: totals(1200) },
  ],
  quota: null,
  currency: "EUR",
  ...overrides,
});

const withQuota = (over: Partial<NonNullable<UsageReportView["quota"]>>) =>
  report({
    quota: {
      period: "day",
      costLimitMinorUnits: 10_000,
      inputTokenLimit: null,
      outputTokenLimit: null,
      warnAt: 0.8,
      warning: false,
      exceeded: false,
      ...over,
    },
  });

describe("AC-1: consumption and cost by period with a breakdown", () => {
  it("totals match the report exactly", async () => {
    // The test step. A panel that recomputed a total from its buckets could disagree with the backend's rollup
    // sum — and the figure a customer reads would be the wrong one.
    const data = shapeUsagePanel(report());
    expect(data.state).toBe("loaded");
    expect(data.totals.costMinorUnits).toBe(3000);
    expect(data.bars.map((b) => b.costMinorUnits)).toEqual([1000, 2000]);
  });

  it("scales bars against the peak, not against the total", async () => {
    // Against the peak so a quiet period is visibly quiet. Against the total, every bar in a long range would
    // be a sliver and the chart would say nothing.
    const data = shapeUsagePanel(report());
    expect(data.bars.map((b) => b.fraction)).toEqual([0.5, 1]);
  });

  it("does not divide by zero when a range is entirely zero", async () => {
    // A rollup job that ran over a quiet hour writes a zero bucket; a bar of width "NaN%" is what a naive
    // division produces.
    const data = shapeUsagePanel(
      report({
        totals: totals(0, 4),
        buckets: [{ bucketStart: "2026-08-21T00:00:00.000Z", totals: totals(0), currency: "EUR" }],
      }),
    );
    expect(data.bars[0]?.fraction).toBe(0);
  });

  it("renders both breakdowns as tables", async () => {
    const html = renderToStaticMarkup(<UsagePanel report={report()} t={t} locale="en" />);
    expect(html).toContain("By model");
    expect(html).toContain("By conversation");
    expect(html).toContain("gpt-4o");
    expect(html).toContain("convo-1");
    // A real table with a caption and column headers, which a screen reader can navigate — a canvas chart
    // could not be read at all.
    expect(html).toMatch(/<table[^>]*data-usage-table/);
    expect(html).toContain("<caption>");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
  });

  it("labels a usage event with no conversation rather than showing a blank row", async () => {
    // Background work — an extraction or an export — has no conversation. A blank label would make the
    // breakdown look like it does not add up.
    const html = renderToStaticMarkup(<UsagePanel report={report()} t={t} locale="en" />);
    expect(html).toContain("Background work");
  });

  it("hides the decorative bar from assistive technology", async () => {
    // The number is in the next cell; announcing the bar too would read every row twice.
    const html = renderToStaticMarkup(<UsagePanel report={report()} t={t} locale="en" />);
    expect(html).toMatch(/data-usage-bar[^>]*aria-hidden="true"/);
  });
});

describe("AC-2: usage against the limit, with a distinct warning state", () => {
  it("classifies the four states apart", () => {
    // `none` is distinct from `ok`: no limit is not the same as plenty of room, and a UI that conflated them
    // would draw an empty bar for a workspace that has no limit at all.
    expect(quotaStatusOf(null)).toBe("none");
    expect(shapeUsagePanel(withQuota({})).quota.status).toBe("ok");
    expect(shapeUsagePanel(withQuota({ warning: true })).quota.status).toBe("warning");
    expect(shapeUsagePanel(withQuota({ warning: true, exceeded: true })).quota.status).toBe("exceeded");
  });

  it("takes the state from the server rather than recomputing it", () => {
    // The panel and the admission decision must be the same computation. A panel that derived the threshold
    // itself would eventually show "you are fine" while runs are being refused.
    const optimistic = shapeUsagePanel(
      withQuota({ costLimitMinorUnits: 10_000, warning: false, exceeded: false }),
    );
    // 3000 of 10,000 is 30% — well under any threshold — and the server says fine, so the panel says fine.
    expect(optimistic.quota.status).toBe("ok");

    // Same numbers, server says exceeded. The panel believes the server.
    const pessimistic = shapeUsagePanel(withQuota({ costLimitMinorUnits: 10_000, exceeded: true }));
    expect(pessimistic.quota.status).toBe("exceeded");
  });

  it("caps the bar at full rather than showing more than 100%", () => {
    // A bar wider than its track is a rendering bug, and past the limit the useful information is "full" — the
    // exceeded label says the rest in words.
    const data = shapeUsagePanel(withQuota({ costLimitMinorUnits: 1000, exceeded: true }));
    expect(data.quota.costFraction).toBe(1);
  });

  it("has no fraction when there is no cost limit to be a fraction of", () => {
    const data = shapeUsagePanel(withQuota({ costLimitMinorUnits: null }));
    expect(data.quota.costFraction).toBeNull();
  });

  it("says there is no limit rather than drawing an empty track", () => {
    // An empty bar reads as "plenty of room", which is a claim about a limit that does not exist.
    const html = renderToStaticMarkup(<UsagePanel report={report()} t={t} locale="en" />);
    expect(html).toContain("No spending limit is set");
    expect(html).toContain('data-usage-quota="none"');
    expect(html).not.toContain("<progress");
  });

  it("uses a real progress element, which announces its own value", () => {
    const html = renderToStaticMarkup(
      <UsageQuotaBar data={shapeUsagePanel(withQuota({}))} t={t} locale="en" />,
    );
    expect(html).toMatch(/<progress[^>]*max="1"/);
    // Already currency-formatted by the component: the catalogue interpolates, it does not format.
    expect(html).toContain("€30.00 of €100.00");
  });

  it("states the warning and the refusal in words, not only in styling", () => {
    // The styling is a border pattern, and a border is not announced.
    const warning = renderToStaticMarkup(
      <UsageQuotaBar data={shapeUsagePanel(withQuota({ warning: true }))} t={t} locale="en" />,
    );
    expect(warning).toContain("Approaching the spending limit");
    expect(warning).toContain('role="status"');

    const exceeded = renderToStaticMarkup(
      <UsageQuotaBar data={shapeUsagePanel(withQuota({ exceeded: true }))} t={t} locale="en" />,
    );
    // An alert rather than a status: work is being refused now, which is worth interrupting for.
    expect(exceeded).toContain('role="alert"');
    expect(exceeded).toContain("New runs are refused");
  });

  it("marks the state on the container so a host can style it", () => {
    for (const [over, expected] of [
      [{ warning: true }, "warning"],
      [{ exceeded: true }, "exceeded"],
    ] as const) {
      const html = renderToStaticMarkup(
        <UsageQuotaBar data={shapeUsagePanel(withQuota(over))} t={t} locale="en" />,
      );
      expect(html).toContain(`data-usage-quota="${expected}"`);
    }
  });
});

describe("AC-3: an explanatory empty state", () => {
  it("shows a sentence, not a zeroed chart", async () => {
    // The test step. A zeroed graph says "we measured and it was nothing", a different and misleading claim
    // from "there is nothing to measure".
    const html = renderToStaticMarkup(<UsagePanel report={report({ totals: ZERO_TOTALS_VIEW, buckets: [] })} t={t} />);
    expect(html).toContain('data-usage-state="empty"');
    expect(html).toContain("No usage recorded yet");
    expect(html).not.toContain("data-usage-periods");
    expect(html).not.toContain("data-usage-bar");
  });

  it("is empty when the range has zero-valued buckets, not merely no buckets", () => {
    // A rollup job that ran over a quiet period writes buckets whose totals are zero. Deciding "loaded" from
    // the bucket array's length would draw exactly the chart the empty state exists to avoid.
    const data = shapeUsagePanel(
      report({
        totals: { ...ZERO_TOTALS_VIEW, eventCount: 0 },
        buckets: [
          { bucketStart: "2026-08-21T00:00:00.000Z", totals: ZERO_TOTALS_VIEW, currency: "EUR" },
          { bucketStart: "2026-08-22T00:00:00.000Z", totals: ZERO_TOTALS_VIEW, currency: "EUR" },
        ],
      }),
    );
    expect(data.state).toBe("empty");
  });

  it("still shows the quota, because a new tenant's limit is worth knowing", async () => {
    const html = renderToStaticMarkup(
      <UsagePanel
        report={{ ...withQuota({}), totals: ZERO_TOTALS_VIEW, buckets: [] }}
        t={t}
        locale="en"
      />,
    );
    expect(html).toContain('data-usage-state="empty"');
    expect(html).toContain("<progress");
  });

  it("distinguishes loading from empty", async () => {
    // A spinner and "nothing here" are different claims, and showing the second while still fetching is the
    // one that makes a user close the page.
    const loading = renderToStaticMarkup(<UsagePanel report={null} t={t} />);
    expect(loading).toContain('data-usage-state="loading"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("No usage recorded yet");
  });
});

describe("AC-4: locale formatting and catalogue strings", () => {
  it("formats a cost as currency for the locale", () => {
    // The division by 100 happens here and nowhere else: doing it at a call site is how a figure ends up a
    // hundred times wrong.
    expect(formatCost(123_456, "EUR", "en-GB")).toBe("€1,234.56");
    expect(formatCost(123_456, "USD", "en-US")).toBe("$1,234.56");
    // German puts the symbol last and swaps the separators — which is exactly why this goes through Intl.
    expect(formatCost(123_456, "EUR", "de-DE").replace(/ /g, " ")).toBe("1.234,56 €");
  });

  it("falls back to a plain number when there is no currency", () => {
    // A period with no usage has no currency, and `Intl` throws on an empty currency code rather than
    // degrading.
    expect(formatCost(123_456, "", "en-GB")).toBe("1,234.56");
  });

  it("groups token counts, and compacts large ones", () => {
    expect(formatTokens(1234, "en-GB")).toBe("1,234");
    // Above ten thousand, exact digits stop being read.
    // Intl's own compact notation for the locale — lowercase in en-GB, which is exactly why this is not
    // hand-built.
    expect(formatTokens(1_234_567, "en-GB")).toBe("1.2m");
  });

  it("renders ids when no catalogue is wired", () => {
    // The sharpest test of "nothing hardcoded": with the identity translator every user-visible string *is* an
    // id, so a literal in the component shows up as prose among them.
    const html = renderToStaticMarkup(<UsagePanel report={report()} />);
    // *Every* id this state renders, not a sample. Found by sabotage: hardcoding one column header passed a
    // version of this test that checked four ids, and a hardcoded string is invisible in a panel full of them.
    const rendered = [
      USAGE_IDS.total,
      USAGE_IDS.byPeriod,
      USAGE_IDS.byModel,
      USAGE_IDS.byConversation,
      USAGE_IDS.columnPeriod,
      USAGE_IDS.columnName,
      USAGE_IDS.columnShare,
      USAGE_IDS.columnCost,
      USAGE_IDS.bucketLabel,
      USAGE_IDS.noConversation,
      USAGE_IDS.noLimit,
    ] as const;
    for (const id of rendered) expect(html, `missing ${id}`).toContain(id);

    // And the ids belonging to *other* states are absent, so this also asserts the panel is not rendering an
    // error or an empty state alongside the loaded one.
    for (const id of [USAGE_IDS.loading, USAGE_IDS.loadFailed, USAGE_IDS.empty] as const) {
      expect(html, `unexpected ${id}`).not.toContain(id);
    }
  });

  it("changes every string with the locale", () => {
    const de = createTranslator({
      catalogs: {
        ...DEFAULT_CATALOGS,
        de: {
          "usage.bucketLabel": (params) => String(params.label),
          "usage.total": (params) => `${params.cost} bei ${params.tokens} Tokens`,
          "usage.byPeriod": "Nach Zeitraum",
          "usage.byModel": "Nach Modell",
          "usage.byConversation": "Nach Unterhaltung",
          "usage.noLimit": "Für diesen Arbeitsbereich ist kein Limit gesetzt.",
          "usage.columnPeriod": "Zeitraum",
          "usage.columnName": "Name",
          "usage.columnShare": "Anteil",
          "usage.columnCost": "Kosten",
          "usage.noConversation": "Hintergrundarbeit",
          "usage.noBreakdown": "Nichts aufzuschlüsseln.",
        },
      },
      locale: "de",
    }).t;
    const html = renderToStaticMarkup(<UsagePanel report={report()} t={de} locale="de-DE" />);
    expect(html).toContain("Nach Modell");
    expect(html).toContain("kein Limit gesetzt");
    // And the English is gone, which is what catches a string the component built itself.
    expect(html).not.toContain("By model");
    expect(html).not.toContain("No spending limit");
  });

  it("labels an hour bucket with the time and a day bucket without", () => {
    // "00:00" on every row of a daily chart is noise that makes the rows harder to tell apart.
    const day = renderToStaticMarkup(<UsagePanel report={report()} t={t} locale="en-GB" />);
    expect(day).toContain("21 Aug 2026");
    const hour = renderToStaticMarkup(
      <UsagePanel
        report={report({
          period: "hour",
          buckets: [{ bucketStart: "2026-08-21T13:00:00.000Z", totals: totals(100), currency: "EUR" }],
        })}
        t={t}
        locale="en-GB"
      />,
    );
    // A time, not a *specific* time: `Intl` renders in the host's timezone, so asserting "13:00" would make
    // this test pass only on a UTC machine.
    expect(hour).toMatch(/\d{1,2}[:.]\d{2}/);
    // The day label carries no clock time. Asserted on the label itself rather than the whole document, because
    // a cost like "€10.00" matches a naive time pattern — which is how the previous version of this assertion
    // failed on its own currency formatting.
    expect(formatBucket("2026-08-21T13:00:00.000Z", "day", "en-GB")).not.toMatch(/\d{1,2}[:.]\d{2}/);
    expect(formatBucket("2026-08-21T13:00:00.000Z", "hour", "en-GB")).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});

describe("AC-5: readable on a mobile viewport", () => {
  it("is mobile first: the base rules stack, a min-width query restores columns", () => {
    // The direction matters. A desktop-first sheet leaves a phone with the horizontally-scrolling table the
    // requirement rules out, and only fixes it if the query matches.
    expect(USAGE_STYLES).toContain("@media (min-width: 480px)");
    expect(USAGE_STYLES).not.toContain("max-width:");
    // Base: the header is hidden and each row is a grid — that is the stacked layout.
    const base = USAGE_STYLES.slice(0, USAGE_STYLES.indexOf("@media"));
    expect(base).toContain("thead { display: none; }");
    expect(base).toContain("[data-usage-row] { display: grid;");
    // Inside the query: the real table layout comes back.
    const wide = USAGE_STYLES.slice(USAGE_STYLES.indexOf("@media"));
    expect(wide).toContain("display: table-header-group");
    expect(wide).toContain("display: table-row");
  });

  it("does not scroll the table sideways", () => {
    // The failure mode the stacking avoids: a table wider than the viewport inside a scrolling container.
    // Asserted on the *table*, not on the whole sheet — the bar has a legitimate `min-width: 1px` so a tiny
    // value is still visible, and a blanket ban would have forbidden that.
    expect(USAGE_STYLES).not.toContain("overflow-x");
    const tableRules = USAGE_STYLES.split("\n").filter((l) => l.includes("data-usage-table"));
    for (const rule of tableRules) expect(rule).not.toMatch(/min-width:/);
  });

  it("keeps figures aligned with tabular numerals, so columns of costs compare", () => {
    expect(USAGE_STYLES).toContain("font-variant-numeric: tabular-nums");
  });

  it("uses no hue to carry meaning", () => {
    // The same rule as #138's citations: warning and exceeded are a border pattern plus a label, so they
    // survive greyscale, colour-blindness and forced-colours mode.
    expect(USAGE_STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(USAGE_STYLES).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(USAGE_STYLES).toContain("dashed currentColor");
    expect(USAGE_STYLES).toContain("double currentColor");
  });
});

describe("AC-6: a loading failure in the consistent error format", () => {
  it("renders an alert, not a blank panel", async () => {
    const html = renderToStaticMarkup(<UsagePanel report={null} error={true} t={t} />);
    expect(html).toContain('data-usage-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("could not be loaded");
  });

  it("shows the error rather than a spinner when a refresh fails", () => {
    // A failed refresh of an already-loaded panel is an error. Showing a spinner for it hides the failure
    // behind an animation that never ends.
    const data = shapeUsagePanel(report(), { loading: true, error: true });
    expect(data.state).toBe("error");
  });

  it("does not claim numbers it could not load", () => {
    const html = renderToStaticMarkup(<UsagePanel report={report()} error={true} t={t} locale="en" />);
    expect(html).not.toContain("€30.00");
    expect(html).not.toContain("data-usage-periods");
  });
});
