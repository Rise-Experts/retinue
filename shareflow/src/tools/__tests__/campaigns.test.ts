/**
 * The Campaigns capabilities (#116).
 *
 * Same discipline as `posts.test.ts`: drive the tool through `execute` against a recording stub, and
 * assert the call the service received — or that it received none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asId, type AuthorizationPolicy, type ExecutionContext, type IdempotencyStore, type PrincipalId, type TenantId, type Tool, type ToolResult } from "@retinue/agentkit";
import { createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  CAMPAIGN_TOOL_FACTORIES,
  CAMPAIGN_TOOL_NAMES,
  createCampaignTool,
  createShareFlowToolProvider,
  getCampaignCalendarTool,
  getCampaignTool,
  listCampaignsTool,
  serviceFailure,
  updateCampaignTool,
  type Campaign,
  type CampaignCalendarEntry,
  type CampaignId,
  type CampaignSummary,
  type ContentService,
  type PostDraftId,
  type ShareFlowServices,
  type ShareFlowToolFactory,
} from "../../index.js";

const T1 = asId<TenantId>("t1");
const CONTEXT = { tenantId: T1, principalId: asId<PrincipalId>("p1") } as unknown as ExecutionContext;
const C1 = asId<CampaignId>("c1");

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: C1,
  name: "Spring launch",
  theme: "pricing page relaunch",
  goal: "sign-ups",
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  cadence: "3x-week",
  channels: ["linkedin", "x"],
  status: "draft",
  mode: "assisted",
  mediaType: "none",
  plannedPostCount: 13,
  createdAt: "2026-08-23T10:00:00.000Z",
  ...over,
});

const campaignSummary = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: C1,
  name: "Spring launch",
  theme: "pricing page relaunch",
  status: "draft",
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  cadence: "3x-week",
  channels: ["linkedin", "x"],
  plannedPostCount: 13,
  ...over,
});

const calendarEntry = (over: Partial<CampaignCalendarEntry> = {}): CampaignCalendarEntry => ({
  postDraftId: asId<PostDraftId>("d1"),
  excerpt: "Shipping the new pricing page…",
  scheduledAt: "2026-09-01T09:00:00.000Z",
  platformId: "linkedin",
  state: "scheduled",
  ...over,
});

type Recorder = { readonly calls: { method: string; args: unknown }[] };

const stubContent = (recorder: Recorder, overrides: Partial<ContentService> = {}): ContentService => {
  const record =
    <T>(method: string, result: T) =>
    async (_c: ExecutionContext, args: unknown) => {
      recorder.calls.push({ method, args });
      return result;
    };
  return {
    getCampaign: record("getCampaign", campaign()),
    listCampaigns: record("listCampaigns", { items: [campaignSummary()], nextCursor: "cur1" }),
    getCampaignCalendar: record("getCampaignCalendar", { items: [calendarEntry()] }),
    createCampaign: record("createCampaign", campaign()),
    updateCampaign: record("updateCampaign", campaign({ name: "Spring launch v2" })),
    ...overrides,
  } as unknown as ContentService;
};

const allowAll = {
  async can() {
    return { allow: true };
  },
} as unknown as AuthorizationPolicy;

let recorder: Recorder;
let idempotency: IdempotencyStore;

const build = (factory: ShareFlowToolFactory, content?: Partial<ContentService>): Tool =>
  factory({
    services: { content: stubContent(recorder, content) } as unknown as ShareFlowServices,
    deps: { authorization: allowAll, idempotency },
  });

const run = (tool: Tool, input: unknown, key = "k1"): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key });

beforeEach(() => {
  recorder = { calls: [] };
  idempotency = createMemoryIdempotencyStore();
});

/** AC-1. */
describe("reading a campaign", () => {
  it("returns goal, dates, cadence and channels from the record", async () => {
    const result = await run(build(getCampaignTool), { campaignId: "c1" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        campaignId: "c1",
        goal: "sign-ups",
        theme: "pricing page relaunch",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30",
        cadence: "3x-week",
        channels: ["linkedin", "x"],
      },
    });
    expect(recorder.calls).toEqual([{ method: "getCampaign", args: { id: "c1" } }]);
  });

  it("reports the post count the schedule actually produces", async () => {
    // The cap is invisible otherwise: "daily for the next year" produces 31 posts, not 365, and the
    // assistant would report the dates. The number comes from the service, not from arithmetic here.
    const result = await run(build(getCampaignTool, { getCampaign: async () => campaign({ startsOn: "2026-09-01", endsOn: "2027-08-31", cadence: "daily", plannedPostCount: 31 }) }), {
      campaignId: "c1",
    });
    expect(result).toMatchObject({ ok: true, data: { plannedPostCount: 31 } });
  });

  it("lists campaigns as summaries without the brief", async () => {
    const result = await run(build(listCampaignsTool), { status: "draft" });
    const data = (result as { data: { campaigns: unknown[]; nextCursor?: string } }).data;
    expect(data.campaigns[0]).not.toHaveProperty("brief");
    expect(data.campaigns[0]).toMatchObject({ campaignId: "c1", plannedPostCount: 13 });
    expect(data.nextCursor).toBe("cur1");
    expect(recorder.calls[0]?.args).toEqual({ limit: 10, status: "draft" });
  });
});

/** AC-3. */
describe("the content calendar", () => {
  it("returns structured entries carrying ids and excerpts, never whole drafts", async () => {
    const result = await run(build(getCampaignCalendarTool), { campaignId: "c1" });
    const data = (result as { data: { entries: Record<string, unknown>[] } }).data;
    expect(data.entries).toEqual([
      {
        postDraftId: "d1",
        excerpt: "Shipping the new pricing page…",
        scheduledAt: "2026-09-01T09:00:00.000Z",
        platformId: "linkedin",
        state: "scheduled",
      },
    ]);
    // Structured, not prose: every value is comparable, sortable or countable, and no entry carries a
    // caption. A thirty-entry calendar must not be thirty post bodies.
    expect(data.entries[0]).not.toHaveProperty("caption");
    expect(typeof data.entries[0]?.["scheduledAt"]).toBe("string");
  });

  it("carries the instant, not a server-local calendar date", async () => {
    // ShareFlow's own `toCalendarPosts` derives YYYY-MM-DD from Date#getFullYear/getMonth/getDate,
    // which is the server's timezone — 00:30 UTC lands on the previous day west of Greenwich. The
    // frontend localizes instead.
    const result = await run(build(getCampaignCalendarTool), { campaignId: "c1" });
    const entry = (result as { data: { entries: { scheduledAt: string }[] } }).data.entries[0];
    expect(entry?.scheduledAt).toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  it("caps the page rather than returning a whole year", async () => {
    await run(build(getCampaignCalendarTool), {});
    expect(recorder.calls).toEqual([]); // campaignId is required
    await run(build(getCampaignCalendarTool), { campaignId: "c1", limit: 51 });
    expect(recorder.calls).toEqual([]); // above the ceiling
    await run(build(getCampaignCalendarTool), { campaignId: "c1" });
    expect(recorder.calls[0]?.args).toEqual({ id: "c1", limit: 25 });
  });
});

/** AC-2. */
describe("creating a campaign", () => {
  const valid = {
    name: "Spring launch",
    theme: "pricing page relaunch",
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
    cadence: "3x-week",
    channels: ["LinkedIn", "X"],
  };

  it("passes the required fields through and normalises the channels", async () => {
    const result = await run(build(createCampaignTool), valid);
    expect(result).toMatchObject({ ok: true, data: { campaignId: "c1" } });
    expect(recorder.calls[0]?.args).toEqual({
      idempotencyKey: "k1",
      name: "Spring launch",
      theme: "pricing page relaunch",
      startsOn: "2026-09-01",
      endsOn: "2026-09-30",
      cadence: "3x-week",
      channels: ["linkedin", "x"],
    });
  });

  it("rejects a campaign that ends before it starts", async () => {
    // The store has CHECK (ends_on >= starts_on). Caught here so the model gets a sentence rather than
    // a constraint-violation string, and so the round trip is not spent.
    const result = await run(build(createCampaignTool), {
      ...valid,
      startsOn: "2026-09-30",
      endsOn: "2026-09-01",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((result as { error: { message: string } }).error.message).toContain("endsOn");
    expect(recorder.calls).toEqual([]);
  });

  it("accepts a single-day campaign", async () => {
    // The constraint is `>=`, not `>`. A one-day campaign is legal and must not be rejected by an
    // off-by-one in the check that mirrors it.
    await run(build(createCampaignTool), { ...valid, startsOn: "2026-09-01", endsOn: "2026-09-01" });
    expect(recorder.calls[0]?.method).toBe("createCampaign");
  });

  it("rejects the fields the store requires but a model might omit", async () => {
    const tool = build(createCampaignTool);
    for (const missing of ["name", "theme", "startsOn", "endsOn", "cadence", "channels"] as const) {
      const input: Record<string, unknown> = { ...valid };
      delete input[missing];
      expect(await run(tool, input), missing).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("rejects a cadence or date shape the store would refuse", async () => {
    const tool = build(createCampaignTool);
    const cases: unknown[] = [
      { ...valid, cadence: "3x_week" }, // the store's spelling, not the contract's
      { ...valid, cadence: "hourly" },
      { ...valid, startsOn: "01/09/2026" },
      { ...valid, startsOn: "2026-13-01" },
      { ...valid, channels: [] },
      { ...valid, status: "scheduled" }, // lifecycle is not settable
    ];
    for (const input of cases) {
      expect(await run(tool, input), JSON.stringify(input).slice(0, 70)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });

  it("does not create the campaign twice when the call is retried", async () => {
    const tool = build(createCampaignTool);
    await run(tool, valid, "same");
    await run(tool, valid, "same");
    expect(recorder.calls.filter((c) => c.method === "createCampaign")).toHaveLength(1);
  });
});

/** AC-2, sparse patch. */
describe("updating a campaign", () => {
  it("touches only the fields supplied", async () => {
    await run(build(updateCampaignTool), { campaignId: "c1", goal: "demo requests" });
    expect(recorder.calls[0]?.args).toEqual({
      idempotencyKey: "k1",
      id: "c1",
      patch: { goal: "demo requests" },
    });
  });

  it("never lets the campaign id leak into the patch", async () => {
    // The patch is built by walking a known field list rather than spreading the input, so `campaignId`
    // cannot arrive as a column to write.
    await run(build(updateCampaignTool), { campaignId: "c1", name: "renamed" });
    const patch = (recorder.calls[0]?.args as { patch: Record<string, unknown> }).patch;
    expect(patch).toEqual({ name: "renamed" });
    expect(patch).not.toHaveProperty("campaignId");
  });

  it("rejects an empty patch rather than reporting a successful no-op", async () => {
    const result = await run(build(updateCampaignTool), { campaignId: "c1" });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(recorder.calls).toEqual([]);
  });

  it("rejects an out-of-order pair, and leaves the one-sided case to the service", async () => {
    const tool = build(updateCampaignTool);
    // Both present and inverted — catchable here.
    expect(await run(tool, { campaignId: "c1", startsOn: "2026-10-01", endsOn: "2026-09-01" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(recorder.calls).toEqual([]);
    // Only one present: the stored counterpart is unknown here, so this must reach the service rather
    // than be guessed at. Claiming to validate it would be worse than not validating it.
    await run(tool, { campaignId: "c1", endsOn: "2020-01-01" });
    expect(recorder.calls[0]?.args).toMatchObject({ patch: { endsOn: "2020-01-01" } });
  });

  it("cannot set the lifecycle status or the derived post count", async () => {
    const tool = build(updateCampaignTool);
    for (const bad of [{ status: "done" }, { plannedPostCount: 999 }]) {
      expect(await run(tool, { campaignId: "c1", name: "renamed", ...bad }), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-4. */
describe("paid operations", () => {
  it("has no paid capability, and the catalog is pinned so adding one is a decision", async () => {
    const provider = createShareFlowToolProvider({
      services: { content: stubContent(recorder) } as unknown as ShareFlowServices,
      deps: { authorization: allowAll, idempotency },
      factories: CAMPAIGN_TOOL_FACTORIES,
    });
    const names = (await provider.listTools(CONTEXT)).map((t) => t.descriptor.name);
    // Pinned exactly. An ad spend moves money out of the tenant's account, so exposing one is an
    // `external-write` behind the approval gate — a decision about money. This assertion is what makes
    // it a decision rather than one more entry in a list.
    expect(names).toEqual([...CAMPAIGN_TOOL_NAMES]);
    for (const name of names) {
      expect(name).not.toMatch(/boost|budget|spend|ads?_|promote/);
    }
  });
});

/** AC-5. */
describe("entitlement", () => {
  it("reports another tenant's campaign as not found", async () => {
    const result = await run(
      build(getCampaignTool, {
        getCampaign: async () => {
          throw serviceFailure("not_found", "Campaign not found");
        },
      }),
      { campaignId: "someone-elses" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses before the service is called when the policy says no", async () => {
    const tool = updateCampaignTool({
      services: { content: stubContent(recorder) } as unknown as ShareFlowServices,
      deps: {
        authorization: {
          async can() {
            return { allow: false, reason: "no" };
          },
        } as unknown as AuthorizationPolicy,
        idempotency,
      },
    });
    expect(await run(tool, { campaignId: "c1", name: "renamed" })).toMatchObject({ ok: false });
    expect(recorder.calls).toEqual([]);
  });
});

/** AC-6, and the effect classification. */
describe("delegation and effects", () => {
  it("names the service method every capability wraps", () => {
    expect(CAMPAIGN_TOOL_FACTORIES.map((f) => build(f).descriptor).map((d) => [d.name, d.delegatesTo])).toEqual([
      ["list_campaigns", "ContentService.listCampaigns"],
      ["get_campaign", "ContentService.getCampaign"],
      ["get_campaign_calendar", "ContentService.getCampaignCalendar"],
      ["create_campaign", "ContentService.createCampaign"],
      ["update_campaign", "ContentService.updateCampaign"],
    ]);
  });

  it("classifies reads as read and writes as internal-write with no approval", () => {
    for (const factory of CAMPAIGN_TOOL_FACTORIES) {
      const { descriptor } = build(factory);
      expect(descriptor.category).toBe("campaigns");
      expect(["read", "internal-write"]).toContain(descriptor.effect);
      expect(descriptor.approvalPolicy).toBe("never");
      expect(descriptor.delegatesTo).toMatch(/^ContentService\./);
    }
  });
});
