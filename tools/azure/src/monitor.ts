/**
 * Azure Monitor: logs, metrics and the activity log — REQ-054 (#232), task #236, AC-3.
 *
 * ## Why every one of these is bounded, and refuses rather than clamps
 *
 * `azure_query_logs` is the tool an agent investigating an incident actually reaches for, and it is also the
 * one that can spend an operator's money without anybody noticing. A KQL query with no time bound against a
 * busy workspace scans everything retained — minutes of wall clock, a bill, and a result far too large to put
 * in front of a model.
 *
 * The obvious safeguard is to *clamp* an over-wide request to the maximum. This does not do that, and the
 * distinction is the point of AC-3: clamping answers a different question from the one asked and reports
 * success, so "no errors in the last 30 days" comes back having looked at seven. A refusal that names the
 * limit is the only version a caller can act on.
 *
 * ## Why the Log Analytics query goes through ARM
 *
 * There is a dedicated host, `api.loganalytics.io`, and it needs a token issued for **its own audience** — a
 * different token from the one every other tool here uses. A toolkit that quietly required two credentials
 * under one `credentialRef` would work for whoever set it up and fail for everyone else, with a 401 that says
 * nothing about audiences. ARM proxies the same query API, so one credential, one host, one pinned auth
 * header. The cost is an older api-version, which is a fair trade for a configuration that cannot half-work.
 */

import { defineTool, type Tool } from "@retinue/agentkit/tools";
import { checkedGroup, checkedId, checkedSubscription, refuse } from "./guards.js";
import { LOG_ANALYTICS_READER, MONITORING_READER } from "./roles.js";
import type { AzureTransport } from "./transport.js";

const CATEGORY = "cloud";

export const QUERY_API = "2017-01-01-preview";
export const METRICS_API = "2018-01-01";
export const ACTIVITY_LOG_API = "2015-04-01";

/** Seven days. Longer than an incident investigation needs, short enough that a typo is not a bill. */
export const MAX_TIMESPAN_HOURS = 24 * 7;
/** Azure's own retention limit for the activity log. Refusing past it beats returning a silently short window. */
export const MAX_ACTIVITY_LOG_HOURS = 24 * 90;
export const MAX_ROWS = 1000;
export const DEFAULT_ROWS = 100;

type Json = Record<string, unknown>;

/**
 * The time bound, required and checked — AC-3.
 *
 * Absent is the case this exists for. A caller who omits a timespan has not asked for "all of it"; they have
 * failed to say, and the two are different requests with very different costs.
 */
export const checkedHours = (hours: number | undefined, max: number, what: string): number => {
  if (hours === undefined || typeof hours !== "number" || !Number.isFinite(hours)) {
    refuse(
      `${what} needs a time span in hours — an unbounded query scans everything the workspace retains, which ` +
        "is slow and expensive. Say how far back to look, for example 24.",
    );
  }
  if (hours <= 0) refuse(`A time span of ${hours} hours looks backwards. Give a positive number of hours.`);
  if (hours > max) {
    refuse(
      `${what} is limited to ${max} hours and ${hours} were asked for. This is refused rather than shortened, ` +
        "because a query silently narrowed answers a different question from the one asked.",
    );
  }
  return hours;
};

const bounded = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);

/** An ISO instant Azure will accept, built from a `Date` so nothing a caller wrote reaches the filter. */
const iso = (at: Date): string => at.toISOString();

/**
 * Rows from a Log Analytics table, as objects.
 *
 * The wire form is columnar — a `columns` array and an array of row arrays — which is compact and unreadable.
 * A model handed `[["2026-08-29T…", "Error", 3]]` has to count positions; handed
 * `{ TimeGenerated: …, Level: "Error", Count: 3 }` it does not.
 */
export const rowsToObjects = (table: Json | undefined): Json[] => {
  if (table === undefined) return [];
  const columns = ((table.columns as Json[] | undefined) ?? []).map((column) => String(column.name));
  return ((table.rows as unknown[][] | undefined) ?? []).map((row) => {
    const object: Json = {};
    columns.forEach((name, index) => {
      object[name] = row[index];
    });
    return object;
  });
};

/**
 * Appends the row bound to a KQL query.
 *
 * `\n| take N` on its own line, and the trailing semicolons trimmed first. Both details are load-bearing: a
 * query ending in a `//` comment would swallow anything appended to the same line, and a query ending in `;`
 * — legal, since `let` statements are semicolon-separated — becomes a syntax error with a pipe after it. Both
 * produce a failure that reads as "this tool is broken" rather than "that query was rejected".
 *
 * `N + 1` is requested so the extra row is the evidence of truncation. Asking for exactly N cannot distinguish
 * "there were N" from "there were thousands".
 */
export const boundQuery = (query: string, limit: number): string => {
  const trimmed = String(query ?? "").trim().replace(/;+$/, "").trimEnd();
  if (trimmed === "") refuse("azure_query_logs needs a KQL query.");
  return `${trimmed}\n| take ${limit + 1}`;
};

export const monitorTools = (transport: AzureTransport): readonly Tool[] => [
  defineTool({
    name: "azure_query_logs",
    label: "Query Log Analytics",
    description:
      "Run a KQL query against a Log Analytics workspace — the tool for investigating an incident. `timespanHours` is required and bounds the scan; a row limit is applied and `truncated` says whether it was hit. Pass the workspace's full resource id, which azure_list_resources can find with resourceType `Microsoft.OperationalInsights/workspaces`.",
    category: CATEGORY,
    execute: async (
      input: { workspaceId: string; query: string; timespanHours: number; limit?: number },
      context,
    ) => {
      const workspace = checkedId(input.workspaceId);
      const hours = checkedHours(input.timespanHours, MAX_TIMESPAN_HOURS, "azure_query_logs");
      const limit = bounded(input.limit, DEFAULT_ROWS, MAX_ROWS);
      const result = (await transport.json(context, `${workspace.id}/api/query?api-version=${QUERY_API}`, {
        role: LOG_ANALYTICS_READER,
        method: "POST",
        /**
         * `timespan` as well as the `take`, because they bound different things.
         *
         * `take` bounds what comes *back*; `timespan` bounds what is *scanned*. A query returning ten rows
         * after reading a month of logs is fast to transmit and expensive to run, and only the timespan
         * prevents it.
         */
        body: { query: boundQuery(input.query, limit), timespan: `PT${hours}H` },
      })) as Json;
      const tables = (result.tables as Json[] | undefined) ?? [];
      const rows = rowsToObjects(tables[0]);
      return {
        rows: rows.slice(0, limit),
        rowCount: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        timespanHours: hours,
        ...(rows.length > limit
          ? { note: `More than ${limit} rows matched. Narrow the query or the time span rather than raising the limit.` }
          : {}),
      };
    },
  }),
  defineTool({
    name: "azure_get_metrics",
    label: "Read metrics",
    description:
      "Read Azure Monitor metrics for one resource — CPU, memory, request counts. Metric names are the resource type's own, for example `Percentage CPU` on a virtual machine. Returns a series of timestamped points.",
    category: CATEGORY,
    execute: async (
      input: {
        resourceId: string;
        metricNames: string[];
        timespanHours?: number;
        intervalMinutes?: number;
        aggregation?: string;
      },
      context,
    ) => {
      const resource = checkedId(input.resourceId);
      const hours = checkedHours(input.timespanHours ?? 1, MAX_TIMESPAN_HOURS, "azure_get_metrics");
      const names = input.metricNames ?? [];
      if (names.length === 0) refuse("azure_get_metrics needs at least one metric name.");
      for (const name of names) {
        // A comma separates names on the wire and an `&` would start another query parameter, so both are
        // refused rather than encoded — a metric called `a,b` does not exist, and a caller sending one has a
        // different problem from the one silent encoding would hide.
        if (typeof name !== "string" || name.trim() === "" || /[,&?#]/.test(name)) {
          refuse(`"${name}" is not a metric name. Metric names contain no commas, ampersands, question marks or hashes.`);
        }
      }
      const aggregation = input.aggregation ?? "Average";
      const allowed = ["Average", "Minimum", "Maximum", "Total", "Count"];
      if (!allowed.includes(aggregation)) {
        refuse(`"${aggregation}" is not an aggregation. Use one of ${allowed.join(", ")}.`);
      }
      const interval = bounded(input.intervalMinutes, 5, 24 * 60);
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3_600_000);
      const params = new URLSearchParams({
        "api-version": METRICS_API,
        metricnames: names.join(","),
        timespan: `${iso(start)}/${iso(end)}`,
        interval: `PT${interval}M`,
        aggregation,
      });
      const result = (await transport.json(
        context,
        `${resource.id}/providers/Microsoft.Insights/metrics?${params.toString()}`,
        { role: MONITORING_READER },
      )) as Json;
      const key = aggregation.toLowerCase();
      return {
        resourceId: resource.id,
        timespanHours: hours,
        intervalMinutes: interval,
        aggregation,
        metrics: ((result.value as Json[] | undefined) ?? []).map((metric) => ({
          name: ((metric.name ?? {}) as Json).value,
          unit: metric.unit,
          // The first time series: a metric split by dimension has several, and this package does not expose
          // dimension filtering, so presenting more than one would be presenting an unlabelled ambiguity.
          points: (((metric.timeseries as Json[] | undefined) ?? [])[0]?.data as Json[] | undefined ?? []).map(
            (point) => ({ at: point.timeStamp, value: point[key] }),
          ),
        })),
      };
    },
  }),
  defineTool({
    name: "azure_list_activity_log",
    label: "List activity log entries",
    description:
      "Who changed what in a subscription, and when. The first thing to read when something started failing — it shows the writes Azure recorded, including ones made outside this agent. Bounded to 90 days, which is Azure's own retention.",
    category: CATEGORY,
    execute: async (
      input: { subscriptionId: string; hours?: number; resourceGroup?: string; limit?: number },
      context,
    ) => {
      const subscriptionId = checkedSubscription(input.subscriptionId);
      const hours = checkedHours(input.hours ?? 24, MAX_ACTIVITY_LOG_HOURS, "azure_list_activity_log");
      const limit = bounded(input.limit, 50, 200);
      const end = new Date();
      const start = new Date(end.getTime() - hours * 3_600_000);
      /**
       * The filter is built from re-serialised values, never from the caller's strings.
       *
       * `eventTimestamp ge '…'` is a quoted OData literal, and an apostrophe inside one ends it. The dates come
       * from `Date.prototype.toISOString`, which cannot produce a quote; the group name has been through
       * `assertResourceGroup`, whose charset excludes one. So there is no path from caller input to filter
       * syntax — which is a stronger statement than "the input is escaped".
       */
      const filter = [
        `eventTimestamp ge '${iso(start)}'`,
        `eventTimestamp le '${iso(end)}'`,
        ...(input.resourceGroup === undefined
          ? []
          : [`resourceGroupName eq '${checkedGroup(input.resourceGroup)}'`]),
      ].join(" and ");
      const params = new URLSearchParams({
        "api-version": ACTIVITY_LOG_API,
        $filter: filter,
        $select: "eventTimestamp,caller,operationName,status,resourceId,resourceGroupName,level,correlationId",
      });
      const result = (await transport.json(
        context,
        `/subscriptions/${subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values?${params.toString()}`,
        { role: MONITORING_READER },
      )) as Json;
      const events = ((result.value as Json[] | undefined) ?? []).slice(0, limit);
      return {
        events: events.map((event) => ({
          at: event.eventTimestamp,
          // Who: a user principal name, or a service principal's object id when the change was made by one.
          caller: event.caller,
          operation: ((event.operationName ?? {}) as Json).localizedValue ?? ((event.operationName ?? {}) as Json).value,
          status: ((event.status ?? {}) as Json).value,
          level: event.level,
          resourceId: event.resourceId,
          resourceGroup: event.resourceGroupName,
          correlationId: event.correlationId,
        })),
        hours,
        truncated: ((result.value as Json[] | undefined) ?? []).length > limit || result.nextLink !== undefined,
      };
    },
  }),
];
