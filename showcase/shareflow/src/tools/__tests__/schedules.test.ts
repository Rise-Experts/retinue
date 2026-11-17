/**
 * Recurring schedules and time slots (#425).
 *
 * The assertions that matter are about **refusing**: `suggest_publish_time` must never produce a time
 * it did not measure or find configured, and the two writes must be gated, because each occurrence
 * they create publishes to a platform.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  asId,
  type ApprovalGate,
  type AuthorizationPolicy,
  type ExecutionContext,
  type IdempotencyStore,
  type PrincipalId,
  type TenantId,
  type Tool,
  type ToolResult,
} from "@retinue/agentkit";
import { createApprovalGate } from "@retinue/agentkit/hitl";
import { createMemoryApprovalGrantStore, createMemoryIdempotencyStore } from "@retinue/agentkit/persistence";
import {
  SCHEDULE_TOOL_FACTORIES,
  SCHEDULE_TOOL_NAMES,
  cancelRecurringScheduleTool,
  createRecurringScheduleTool,
  listSchedulesTool,
  listTimeSlotsTool,
  suggestPublishTimeTool,
  type PublishTimeSuggestion,
  type RecurringSchedule,
  type ShareFlowServices,
  type ShareFlowToolFactory,
  type TimeSlot,
} from "../../index.js";

const CONTEXT = {
  tenantId: asId<TenantId>("t1"),
  principalId: asId<PrincipalId>("p1"),
} as unknown as ExecutionContext;

const rule = (over: Partial<RecurringSchedule> = {}): RecurringSchedule =>
  ({
    id: "s1",
    name: "Weekly product highlight",
    postId: "d1",
    frequency: "WEEKLY",
    interval: 1,
    weekdays: [2],
    timeOfDay: "09:41",
    timezone: "Europe/Berlin",
    status: "ACTIVE",
    nextOccurrenceAt: "2026-09-15T07:41:00.000Z",
    accountIds: ["a1"],
    ...over,
  }) as RecurringSchedule;

const slot = (over: Partial<TimeSlot> = {}): TimeSlot =>
  ({ id: "t1", label: "Morning", weekday: 2, timeOfDay: "09:41", timezone: "Europe/Berlin", ...over }) as TimeSlot;

type Options = {
  rules?: () => readonly RecurringSchedule[];
  slots?: () => readonly TimeSlot[];
  suggestion?: () => PublishTimeSuggestion;
};

let calls: { method: string; args: Record<string, unknown> }[];

const services = (o: Options = {}): ShareFlowServices =>
  ({
    schedules: {
      async listSchedules(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "listSchedules", args });
        return o.rules?.() ?? [rule()];
      },
      async listTimeSlots(_c: ExecutionContext) {
        calls.push({ method: "listTimeSlots", args: {} });
        return o.slots?.() ?? [slot()];
      },
      async suggestPublishTime(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "suggestPublishTime", args });
        return (
          o.suggestion?.() ?? {
            basis: "none" as const,
            reason:
              "There is no engagement data for this workspace yet and no time slots are configured, " +
              "so there is nothing to base a suggestion on.",
          }
        );
      },
      async createRecurringSchedule(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "createRecurringSchedule", args });
        return { schedule: rule(), materialised: 4 };
      },
      async cancelRecurringSchedule(_c: ExecutionContext, args: Record<string, unknown>) {
        calls.push({ method: "cancelRecurringSchedule", args });
        return { cancelled: 3 };
      },
    },
  }) as unknown as ShareFlowServices;

const allowAll = { async can() { return { allow: true }; } } as unknown as AuthorizationPolicy;

/**
 * A real gate over a real grant store, with a standing grant for the category.
 *
 * The real `createApprovalGate` rather than a stub that always allows: a stub would pass these tests
 * against an envelope with no gate at all, which is the thing the gate exists to prevent. The first
 * version of this file had no gate and the two write tests failed with the service never called —
 * which was the gate working, correctly, on a test that had not accounted for it.
 */
const grantedGate = async (): Promise<ApprovalGate> => {
  const grants = createMemoryApprovalGrantStore();
  await grants.grant({
    tenantId: asId<TenantId>("t1"),
    grant: {
      id: asId("g1"),
      tenantId: asId<TenantId>("t1"),
      scope: "tenant",
      toolNameOrCategory: "schedules",
      grantedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  return createApprovalGate({ grants });
};

let idempotency: IdempotencyStore;
let counter = 0;

const build = (factory: ShareFlowToolFactory, o: Options = {}, approvals?: ApprovalGate): Tool =>
  factory.build({
    services: services(o),
    deps: { authorization: allowAll, idempotency, ...(approvals === undefined ? {} : { approvals }) },
  });

const run = (tool: Tool, input: unknown, key?: string): Promise<ToolResult> =>
  tool.execute({ context: CONTEXT, input, idempotencyKey: key ?? `k${(counter += 1)}` });

const dataOf = (r: ToolResult): Record<string, unknown> => (r as { data: Record<string, unknown> }).data;

beforeEach(() => {
  calls = [];
  counter = 0;
  idempotency = createMemoryIdempotencyStore();
});

describe("the catalogue", () => {
  it("is exactly the five tools this SPEC adds", () => {
    expect([...SCHEDULE_TOOL_NAMES]).toEqual([
      "list_schedules",
      "list_time_slots",
      "suggest_publish_time",
      "create_recurring_schedule",
      "cancel_recurring_schedule",
    ]);
    expect(SCHEDULE_TOOL_FACTORIES).toHaveLength(SCHEDULE_TOOL_NAMES.length);
  });

  /**
   * Both writes are `external-write`, which is what puts them behind an approval.
   *
   * A recurring rule publishes on every occurrence, and creating it is the only moment anyone is
   * asked about the series. Classified `internal-write` it would schedule months of public posts with
   * no confirmation — the friction is the feature here, unlike a tracked link.
   */
  it("gates both writes and leaves the reads ungated", () => {
    expect(
      SCHEDULE_TOOL_FACTORIES.map((f) => {
        const tool = build(f);
        return [tool.descriptor.name, tool.descriptor.effect];
      }),
    ).toEqual([
      ["list_schedules", "read"],
      ["list_time_slots", "read"],
      ["suggest_publish_time", "read"],
      ["create_recurring_schedule", "external-write"],
      ["cancel_recurring_schedule", "external-write"],
    ]);
  });
});

describe("list_schedules", () => {
  it("names the weekdays as well as numbering them", async () => {
    const data = dataOf(await run(build(listSchedulesTool), {}));
    const first = (data["schedules"] as Record<string, unknown>[])[0]!;
    // `weekdays: [2]` is a fact the model would otherwise have to translate, and may translate wrong.
    expect(first["weekdays"]).toEqual([2]);
    expect(first["weekdayNames"]).toEqual(["Tuesday"]);
  });

  it("carries the next occurrence when there is one", async () => {
    const data = dataOf(await run(build(listSchedulesTool), {}));
    expect((data["schedules"] as Record<string, unknown>[])[0]!["nextOccurrenceAt"]).toBe("2026-09-15T07:41:00.000Z");
  });

  it("omits the next occurrence rather than inventing one", async () => {
    const data = dataOf(
      await run(build(listSchedulesTool, { rules: () => [rule({ nextOccurrenceAt: undefined })] }), {}),
    );
    expect((data["schedules"] as Record<string, unknown>[])[0]).not.toHaveProperty("nextOccurrenceAt");
  });
});

/** #425's second acceptance, and the only one with judgement in it. */
describe("suggest_publish_time never invents a time", () => {
  it("reports `none` with a reason when there is nothing to go on", async () => {
    const data = dataOf(await run(build(suggestPublishTimeTool), {}));
    expect(data["basis"]).toBe("none");
    expect(String(data["reason"]).length).toBeGreaterThan(20);
    // Nothing that could be read as a time.
    expect(data).not.toHaveProperty("timeOfDay");
    expect(data).not.toHaveProperty("weekday");
  });

  it("carries the evidence when the weekday was measured", async () => {
    const data = dataOf(
      await run(
        build(suggestPublishTimeTool, {
          suggestion: () => ({
            basis: "measured",
            weekday: 2,
            timeOfDay: "09:41",
            timezone: "Europe/Berlin",
            engagements: 1840,
            daysObserved: 12,
          }),
        }),
        {},
      ),
    );
    expect(data["basis"]).toBe("measured");
    expect(data["weekdayName"]).toBe("Tuesday");
    // Quotable, so the model can say what it was measured from rather than asserting it.
    expect(data["engagements"]).toBe(1840);
    expect(data["daysObserved"]).toBe(12);
  });

  it("says when a time came from a configured slot rather than from data", async () => {
    const data = dataOf(
      await run(
        build(suggestPublishTimeTool, {
          suggestion: () => ({
            basis: "configured-slot",
            slotLabel: "Morning",
            weekday: 2,
            timeOfDay: "09:41",
            timezone: "Europe/Berlin",
          }),
        }),
        {},
      ),
    );
    expect(data["basis"]).toBe("configured-slot");
    expect(data["slotLabel"]).toBe("Morning");
    // The distinction the union exists for: this must not be reportable as measured.
    expect(data).not.toHaveProperty("engagements");
  });
});

describe("create_recurring_schedule", () => {
  it("passes the recurrence through and reports how many occurrences it produced", async () => {
    const data = dataOf(
      await run(build(createRecurringScheduleTool, {}, await grantedGate()), {
        postId: "d1",
        accountIds: ["a1"],
        frequency: "WEEKLY",
        weekdays: [2],
        timeOfDay: "09:41",
        timezone: "Europe/Berlin",
      }),
    );
    expect(calls[0]!.args).toMatchObject({ postId: "d1", frequency: "WEEKLY", weekdays: [2], timeOfDay: "09:41" });
    // "Created a schedule" and "created a schedule that produced nothing" are different things to say.
    expect(data["materialised"]).toBe(4);
  });

  it("refuses a time that is not a time", async () => {
    for (const timeOfDay of ["9am", "25:00", "morning", ""]) {
      const result = await run(build(createRecurringScheduleTool), {
        postId: "d1", accountIds: ["a1"], frequency: "DAILY", timeOfDay,
      });
      expect((result as { ok?: boolean }).ok, timeOfDay).not.toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a weekday outside 0-6", async () => {
    const result = await run(build(createRecurringScheduleTool), {
      postId: "d1", accountIds: ["a1"], frequency: "WEEKLY", weekdays: [7], timeOfDay: "09:41",
    });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
  });

  it("requires at least one account, since a rule with none publishes nowhere", async () => {
    const result = await run(build(createRecurringScheduleTool), {
      postId: "d1", accountIds: [], frequency: "DAILY", timeOfDay: "09:41",
    });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
  });
});

describe("cancel_recurring_schedule", () => {
  it("passes the id and reports what it cancelled", async () => {
    const data = dataOf(await run(build(cancelRecurringScheduleTool, {}, await grantedGate()), { scheduleId: "s1" }));
    expect(calls[0]!.args).toMatchObject({ scheduleId: "s1" });
    expect(data["cancelled"]).toBe(3);
  });

  /**
   * The gate, asserted from the other side: with no grant, nothing reaches the service.
   *
   * This is the direction that matters — a rule publishes on every occurrence, and the approval is
   * for the whole series.
   */
  it("does not cancel anything without an approval", async () => {
    const result = await run(build(cancelRecurringScheduleTool), { scheduleId: "s1" });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("takes nothing but the id", async () => {
    const result = await run(build(cancelRecurringScheduleTool), { scheduleId: "s1", force: true });
    expect((result as { ok?: boolean }).ok).not.toBe(true);
  });
});
