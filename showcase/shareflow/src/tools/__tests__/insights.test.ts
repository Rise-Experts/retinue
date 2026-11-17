/**
 * Campaign playbooks and daily rollups (#426).
 *
 * The assertion that carries this SPEC is `compare_periods` telling **"no prior window"** apart from
 * **"no change"**. Comparing against a fabricated zero turns the first month of data into a 100% rise
 * on every metric, and a model reading that has no way to know.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  INSIGHT_TOOL_FACTORIES,
  INSIGHT_TOOL_NAMES,
  comparePeriodsTool,
  getDailyRollupTool,
  listCampaignTemplatesTool,
  startCampaignFromTemplateTool,
  type CampaignTemplate,
  type PeriodComparison,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const template = (over: Partial<CampaignTemplate> = {}): CampaignTemplate =>
  ({
    key: "product_launch",
    name: "Product Launch",
    description: "Tease, launch, follow up.",
    defaultGoal: "conversion",
    defaultCadence: "3x_week",
    recommendedChannels: ["instagram", "linkedin", "x"],
    plannedPosts: 6,
    ...over,
  }) as CampaignTemplate;

const withPrior: PeriodComparison = {
  current: { since: "2026-09-01", until: "2026-10-01", daysWithData: 30 },
  previous: { since: "2026-08-02", until: "2026-09-01", daysWithData: 30 },
  metrics: [
    { metric: "impressions", current: 1200, previous: 1000, change: { absolute: 200, percent: 20 } },
    { metric: "engagements", current: 0, previous: 0, change: { absolute: 0, percent: null } },
  ],
};

const noPrior: PeriodComparison = {
  current: { since: "2026-09-01", until: "2026-10-01", daysWithData: 30 },
  noPriorWindowReason:
    "There is no data for the 30 days before 2026-09-01, so there is nothing to compare this period " +
    "against — not that nothing changed.",
  metrics: [{ metric: "impressions", current: 1200 }],
};

type Options = { templates?: () => readonly CampaignTemplate[]; comparison?: () => PeriodComparison };

let calls: { method: string; args: Record<string, unknown> }[];

const services = (o: Options = {}): ShareFlowServices =>
  ({
    insights: {
      async listCampaignTemplates(_c: ExecutionContext) {
        calls.push({ method: "listCampaignTemplates", args: {} });
        return o.templates?.() ?? [template()];
      },
      async startCampaignFromTemplate(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "startCampaignFromTemplate", args });
        return {
          campaign: {
            id: "c1", name: "Spring launch", startsOn: "2026-09-01", endsOn: "2026-09-30",
            cadence: "3x_week", channels: ["instagram"], plannedPostCount: 12,
          } as never,
          template: template(),
        };
      },
      async getDailyRollup(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "getDailyRollup", args });
        return [{ day: "2026-09-12", platform: "linkedin", impressions: 900, engagements: 40, linkClicks: 9, watchSeconds: 0, followers: 3 }];
      },
      async comparePeriods(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "comparePeriods", args });
        return o.comparison?.() ?? withPrior;
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;
let idempotency: IdempotencyStore;
let counter = 0;

const build = (factory: ShareFlowToolFactory, o: Options = {}): Tool =>
  factory.build({ services: services(o), deps: { authorization: allowAll, idempotency } });

const run = (tool: Tool, input: unknown): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: `k${(counter += 1)}` });

const dataOf = (r: ToolResult): Record<string, unknown> => (r as { data: Record<string, unknown> }).data;

beforeEach(() => {
  calls = [];
  counter = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("the catalogue", () => {
  it("is exactly the four tools this SPEC adds", () => {
    expect([...INSIGHT_TOOL_NAMES]).toEqual([
      "list_campaign_templates",
      "start_campaign_from_template",
      "get_daily_rollup",
      "compare_periods",
    ]);
    expect(INSIGHT_TOOL_FACTORIES).toHaveLength(INSIGHT_TOOL_NAMES.length);
  });

  it("classifies the one write as internal-write and the rest as reads", () => {
    expect(
      INSIGHT_TOOL_FACTORIES.map((f) => {
        const tool = build(f);
        return [tool.descriptor.name, tool.descriptor.effect];
      }),
    ).toEqual([
      ["list_campaign_templates", "read"],
      // Creates a container and publishes nothing — the classification `create_campaign` already has.
      ["start_campaign_from_template", "internal-write"],
      ["get_daily_rollup", "read"],
      ["compare_periods", "read"],
    ]);
  });
});

describe("list_campaign_templates", () => {
  it("returns the playbook with what it is shaped for", async () => {
    const data = dataOf(await run(build(listCampaignTemplatesTool), {}));
    expect((data["templates"] as Record<string, unknown>[])[0]).toEqual({
      key: "product_launch",
      name: "Product Launch",
      description: "Tease, launch, follow up.",
      defaultGoal: "conversion",
      defaultCadence: "3x_week",
      recommendedChannels: ["instagram", "linkedin", "x"],
      plannedPosts: 6,
    });
  });
});

describe("start_campaign_from_template", () => {
  it("says plainly that it created no posts", async () => {
    const data = dataOf(
      await run(build(startCampaignFromTemplateTool), {
        templateKey: "product_launch", name: "Spring launch", theme: "The spring collection",
        startsOn: "2026-09-01", endsOn: "2026-09-30",
      }),
    );
    // The container, and nothing in it — said in the result as well as the description, because a
    // model that assumed otherwise would tell someone their campaign was ready.
    expect(data["postsCreated"]).toBe(0);
    expect(data["campaignId"]).toBe("c1");
    expect((data["template"] as Record<string, unknown>)["key"]).toBe("product_launch");
  });

  it("omits cadence and channels when the user did not override them", async () => {
    await run(build(startCampaignFromTemplateTool), {
      templateKey: "product_launch", name: "N", theme: "T", startsOn: "2026-09-01", endsOn: "2026-09-30",
    });
    // The template's own are the default; sending undefined explicitly would override them with nothing.
    expect(calls[0]!.args).not.toHaveProperty("cadence");
    expect(calls[0]!.args).not.toHaveProperty("channels");
  });

  it("refuses a date that is not a date", async () => {
    for (const startsOn of ["1 September", "2026-9-1", "next week"]) {
      const result = await run(build(startCampaignFromTemplateTool), {
        templateKey: "k", name: "N", theme: "T", startsOn, endsOn: "2026-09-30",
      });
      expect((result as { ok?: boolean }).ok, startsOn).not.toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

/** #426's second acceptance. */
describe("compare_periods tells no prior window from no change", () => {
  it("carries the reason and omits every comparison when there is no prior window", async () => {
    const data = dataOf(
      await run(build(comparePeriodsTool, { comparison: () => noPrior }), { since: "2026-09-01", until: "2026-10-01" }),
    );
    expect(String(data["noPriorWindowReason"])).toMatch(/nothing to compare/);
    expect(data).not.toHaveProperty("previous");
    const metrics = data["metrics"] as Record<string, unknown>[];
    // No `change` and no `previous` anywhere — a zero in either would read as a measurement.
    for (const metric of metrics) {
      expect(metric).not.toHaveProperty("change");
      expect(metric).not.toHaveProperty("previous");
    }
  });

  it("reports a real change when there is a prior window", async () => {
    const data = dataOf(await run(build(comparePeriodsTool), { since: "2026-09-01", until: "2026-10-01" }));
    expect(data).not.toHaveProperty("noPriorWindowReason");
    const impressions = (data["metrics"] as Record<string, unknown>[])[0]!;
    expect(impressions["previous"]).toBe(1000);
    expect(impressions["change"]).toEqual({ absolute: 200, percent: 20 });
  });

  /**
   * The third case, distinct from both: measured, unchanged, and previously zero.
   *
   * `percent: null` rather than a number — a rise from zero has no percentage, and any figure there
   * would look like a measurement. `change` is present, because this *was* compared.
   */
  it("distinguishes a measured zero from an absent one", async () => {
    const data = dataOf(await run(build(comparePeriodsTool), { since: "2026-09-01", until: "2026-10-01" }));
    const engagements = (data["metrics"] as Record<string, unknown>[])[1]!;
    expect(engagements["previous"]).toBe(0);
    expect(engagements["change"]).toEqual({ absolute: 0, percent: null });
  });
});

describe("get_daily_rollup", () => {
  it("passes the window through and returns the day as a date", async () => {
    const data = dataOf(await run(build(getDailyRollupTool), { since: "2026-09-01", platform: "linkedin" }));
    expect(calls[0]!.args).toMatchObject({ since: "2026-09-01", platform: "linkedin" });
    expect((data["days"] as Record<string, unknown>[])[0]!["day"]).toBe("2026-09-12");
  });
});
