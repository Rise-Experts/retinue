/**
 * Analytics (#125).
 *
 * Two of these tests are about what is *absent* from the envelope — an interpretation, and an excluded
 * count. Both absences are the guarantee, and both are the kind of field someone adds later while trying
 * to be helpful, so they are asserted rather than left to the comment above them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  asId,
  createMemoryIdempotencyStore,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import {
  ANALYTICS_TOOL_FACTORIES,
  ANALYTICS_TOOL_NAMES,
  SHAREFLOW_SKILL_BODIES,
  attributionTool,
  campaignMetricsTool,
  createShareFlowToolProvider,
  postMetricsTool,
  serviceFailure,
  type Fact,
  type MetricsReport,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const WINDOW = { fromDay: "2026-08-01", toDay: "2026-08-23" } as const;

const fact = (over: Partial<Extract<Fact, { value: number }>> = {}): Fact => ({
  metric: "impressions",
  unit: "count",
  window: WINDOW,
  value: 18_402,
  derivedFrom: { recordType: "post_metrics", recordCount: 3, recordIds: ["m1", "m2", "m3"] },
  ...over,
});

const report = (over: Partial<MetricsReport> = {}): MetricsReport => ({
  facts: [fact()],
  freshness: { lastRefreshedAt: "2026-08-23T11:00:00.000Z", stale: false },
  scoped: false,
  ...over,
});

type Options = { report?: () => MetricsReport };

let calls: { method: string; args: unknown }[];

const services = (o: Options = {}): ShareFlowServices =>
  ({
    analytics: {
      async postMetrics(_c: ExecutionContext, args: unknown) {
        calls.push({ method: "postMetrics", args });
        return o.report?.() ?? report();
      },
      async campaignMetrics(_c: ExecutionContext, args: unknown) {
        calls.push({ method: "campaignMetrics", args });
        return o.report?.() ?? report();
      },
      async attribution(_c: ExecutionContext, args: unknown) {
        calls.push({ method: "attribution", args });
        return o.report?.() ?? report();
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let idempotency: IdempotencyStore;
let callCounter = 0;

const build = (factory: ShareFlowToolFactory, o: Options = {}): Tool =>
  factory({ services: services(o), deps: { authorization: allowAll, idempotency } });

/** A unique key per call by default — the #124 lesson. */
const run = (tool: Tool, input: unknown, key?: string): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key ?? `k${(callCounter += 1)}` });

const dataOf = (result: ToolResult): Record<string, unknown> =>
  (result as { data: Record<string, unknown> }).data;

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../analytics.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

beforeEach(() => {
  calls = [];
  callCounter = 0;
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("every number comes from the service", () => {
  it("passes values through exactly", async () => {
    const result = await run(build(postMetricsTool), { postDraftId: "d1" });
    expect(dataOf(result)["facts"]).toEqual([
      {
        metric: "impressions",
        unit: "count",
        window: WINDOW,
        value: 18_402,
        derivedFrom: { recordType: "post_metrics", recordCount: 3, recordIds: ["m1", "m2", "m3"] },
      },
    ]);
  });

  it("does no arithmetic of its own", () => {
    // Asserted against the shipped source. Every `compute*` function in ShareFlow is pure over rows, so
    // there is nothing here to compute — and a total assembled here would disagree with the service's.
    for (const arithmetic of ["reduce(", "Math.", ") / ", ") * ", "+ 1", "sum"]) {
      expect(source, arithmetic).not.toContain(arithmetic);
    }
  });

  it("tells the model not to aggregate for itself", async () => {
    const { descriptor } = build(campaignMetricsTool);
    expect(descriptor.description).toMatch(/do not add up post figures yourself/i);
  });
});

/** AC-2. */
describe("facts only, with nowhere for an interpretation", () => {
  it("returns an envelope with no interpretation field", async () => {
    for (const factory of ANALYTICS_TOOL_FACTORIES) {
      const tool = build(factory);
      const result = await run(tool, inputFor(tool.descriptor.name));
      // The separation in its strongest form: not "kept apart" but "one of them cannot be in here". Who
      // would fill an interpretation? The model, after reading the facts — so a tool emitting one would be
      // doing what AC-1 forbids.
      expect(Object.keys(dataOf(result)).sort(), tool.descriptor.name).toEqual([
        "facts",
        "freshness",
        "scoped",
      ]);
    }
  });

  it("has no field an explanation could occupy anywhere in the payload", async () => {
    const result = await run(build(postMetricsTool), { postDraftId: "d1" });
    const serialised = JSON.stringify(dataOf(result));
    for (const key of ["interpretation", "explanation", "insight", "summary", "recommendation", "why"]) {
      expect(serialised, key).not.toContain(`"${key}"`);
    }
  });
});

/** AC-3 and AC-6 — owned by the skill, because a tool result cannot carry them. */
describe("the reply's obligations live in the skill", () => {
  it("requires an explanation to be labelled a hypothesis", () => {
    const skill = SHAREFLOW_SKILL_BODIES["analytics-reporting"];
    expect(skill).toMatch(/hypothesis/i);
    expect(skill).toMatch(/Never present a causal claim as measured/i);
    // The test a reader can actually apply.
    expect(skill).toMatch(/which sentences are measurements and which are your reading of them/i);
  });

  it("requires an analysis to end with something measurable", () => {
    const skill = SHAREFLOW_SKILL_BODIES["analytics-reporting"];
    expect(skill).toMatch(/measurable next step/i);
    expect(skill).toMatch(/Three suggestions is a menu, not a recommendation/i);
    // The worked contrast, because "be measurable" is itself not measurable.
    expect(skill).toMatch(/"Post more on LinkedIn" is not measurable/);
  });

  it("says the facts carry their own window, so a period is not assumed", () => {
    expect(SHAREFLOW_SKILL_BODIES["analytics-reporting"]).toMatch(/use that one, not a period you assumed/i);
  });
});

/** AC-4. */
describe("traceability", () => {
  it("carries the record type and count with every number", async () => {
    const result = await run(build(campaignMetricsTool), { campaignId: "c1" });
    const facts = dataOf(result)["facts"] as { derivedFrom: { recordType: string; recordCount: number } }[];
    expect(facts[0]?.derivedFrom.recordType).toBe("post_metrics");
    expect(facts[0]?.derivedFrom.recordCount).toBe(3);
  });

  it("omits the ids for a large set rather than inlining hundreds", async () => {
    // "Traceable" means an auditor can find the rows, not that the rows are inlined. Five hundred ids is a
    // context bomb and five hundred ids the model will never read.
    const result = await run(
      build(postMetricsTool, {
        report: () =>
          report({
            facts: [fact({ derivedFrom: { recordType: "analytics_daily", recordCount: 512 } })],
          }),
      }),
      { postDraftId: "d1" },
    );
    const facts = dataOf(result)["facts"] as { derivedFrom: Record<string, unknown> }[];
    expect(facts[0]?.derivedFrom).toEqual({ recordType: "analytics_daily", recordCount: 512 });
    expect(facts[0]?.derivedFrom).not.toHaveProperty("recordIds");
  });
});

/** AC-5 — and the trap inside it. */
describe("a scoped aggregate", () => {
  it("says it is partial", async () => {
    // A permission-scoped aggregate that does not admit it is a wrong number presented as a right one.
    const result = await run(
      build(postMetricsTool, { report: () => report({ scoped: true }) }),
      { postDraftId: "d1" },
    );
    expect(dataOf(result)["scoped"]).toBe(true);
  });

  it("does not say how much was excluded", async () => {
    // The trap in the AC. The obvious way to admit a partial aggregate — an excluded count — *is itself
    // the leak: it reveals the existence and volume of data the caller may not see. That is the classic
    // aggregate attack, arrived at by trying to be helpful.
    const result = await run(
      build(postMetricsTool, {
        // A service that helpfully volunteers the count. It must not reach the caller.
        report: () => ({ ...report({ scoped: true }), recordsExcluded: 60 } as unknown as MetricsReport),
      }),
      { postDraftId: "d1" },
    );
    const serialised = JSON.stringify(dataOf(result));
    expect(serialised).not.toContain("recordsExcluded");
    expect(serialised).not.toContain("60");
    for (const key of ["excluded", "hidden", "denied", "total"]) {
      expect(serialised, key).not.toContain(key);
    }
  });

  it("tells the model what a scoped result means", async () => {
    const { descriptor } = build(postMetricsTool);
    expect(descriptor.description).toMatch(/cover only what you may see/i);
  });
});

/** The third instance of the same bug shape. */
describe("an unmeasured metric is not a zero", () => {
  it("returns the reason instead of a value", async () => {
    // `computeAnalyticsKpis` returns 0 for engagement rate when impressions are zero — right for a
    // dashboard tile, wrong as a fact. No impressions is undefined, and an assistant handed 0 will report
    // "engagement was 0%".
    const result = await run(
      build(postMetricsTool, {
        report: () =>
          report({
            facts: [
              { metric: "engagementRate", unit: "fraction", window: WINDOW, unavailable: "no-data" },
              { metric: "comments", unit: "count", window: WINDOW, unavailable: "not-collected" },
            ],
          }),
      }),
      { postDraftId: "d1" },
    );
    const facts = dataOf(result)["facts"] as Record<string, unknown>[];
    expect(facts[0]).toEqual({ metric: "engagementRate", unit: "fraction", window: WINDOW, unavailable: "no-data" });
    expect(facts[0]).not.toHaveProperty("value");
    // Two different reasons, kept apart: nothing collected yet, versus this platform is not covered at
    // all. `analytics-reporting` already insists those are different statements.
    expect(facts[1]).toMatchObject({ unavailable: "not-collected" });
  });

  it("never lets a value sit beside an unavailable reason", async () => {
    const result = await run(
      build(postMetricsTool, {
        report: () =>
          report({
            facts: [
              {
                metric: "engagementRate",
                unit: "fraction",
                window: WINDOW,
                unavailable: "no-data",
                value: 0,
              } as unknown as Fact,
            ],
          }),
      }),
      { postDraftId: "d1" },
    );
    // The view branches on the union rather than spreading, so a service returning both cannot let a
    // caller read the number and ignore the reason it is not one.
    const facts = dataOf(result)["facts"] as Record<string, unknown>[];
    expect(facts[0]).not.toHaveProperty("unavailable");
    expect(facts[0]).toMatchObject({ value: 0 });
  });

  it("says freshness plainly, because these are stored figures", async () => {
    const result = await run(
      build(postMetricsTool, { report: () => report({ freshness: { stale: true } }) }),
      { postDraftId: "d1" },
    );
    expect(dataOf(result)["freshness"]).toEqual({ stale: true });
    const { descriptor } = build(postMetricsTool);
    expect(descriptor.description).toMatch(/stored figures, not a live read/i);
  });
});

describe("arguments, delegation and the catalog", () => {
  it("requires exactly one subject for attribution", async () => {
    const tool = build(attributionTool);
    for (const input of [{}, { postDraftId: "d1", campaignId: "c1" }]) {
      expect(await run(tool, input), JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("rejects a window that ends before it starts", async () => {
    const result = await run(build(postMetricsTool), {
      postDraftId: "d1",
      window: { fromDay: "2026-08-23", toDay: "2026-08-01" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls).toEqual([]);
  });

  it("passes a valid window through", async () => {
    await run(build(postMetricsTool), { postDraftId: "d1", window: WINDOW });
    expect(calls[0]?.args).toEqual({ draftId: "d1", window: WINDOW });
  });

  it("names the service method each capability calls", () => {
    expect(ANALYTICS_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["get_post_metrics", "AnalyticsService.postMetrics"],
      ["get_campaign_metrics", "AnalyticsService.campaignMetrics"],
      ["get_attribution", "AnalyticsService.attribution"],
    ]);
  });

  it("classifies all three as reads under the analytics category", async () => {
    const provider = createShareFlowToolProvider({
      services: services(),
      deps: { authorization: allowAll, idempotency },
      factories: ANALYTICS_TOOL_FACTORIES,
    });
    const descriptors = (await provider.listTools(CONTEXT)).map((t) => t.descriptor);
    expect(descriptors.map((d) => d.name)).toEqual([...ANALYTICS_TOOL_NAMES]);
    for (const d of descriptors) {
      expect(d.category).toBe("analytics");
      expect(d.effect).toBe("read");
      expect(d.approvalPolicy).toBe("never");
    }
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = postMetricsTool({
      services: services(),
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    expect(await run(tool, { postDraftId: "d1" })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("surfaces a service failure rather than an empty report", async () => {
    const tool = postMetricsTool({
      services: {
        analytics: {
          async postMetrics() {
            throw serviceFailure("not_found", "Post not found");
          },
        },
      } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
    });
    // An empty facts list would read as "measured, and there was nothing" — the failure this whole SPEC
    // keeps guarding against.
    expect(await run(tool, { postDraftId: "someone-elses" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

function inputFor(name: string): unknown {
  switch (name) {
    case "get_post_metrics":
      return { postDraftId: "d1" };
    case "get_campaign_metrics":
      return { campaignId: "c1" };
    case "get_attribution":
      return { postDraftId: "d1" };
    default:
      throw new Error(`no input defined for ${name}`);
  }
}
