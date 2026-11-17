/**
 * Recurring schedules and time slots — #425.
 *
 * The assistant could schedule a one-off and nothing else, so "post this every Tuesday at 9" was a
 * sentence it could not act on — while the calendar has a panel dedicated to exactly that. And it
 * could not answer "when should this go out" for a workspace that had already configured its slots.
 *
 * `suggest_publish_time` is the one with judgement in it, and the judgement is mostly refusal:
 * `analytics_daily` is a **daily** rollup, so it knows which weekday performs and nothing about the
 * hour. The hour comes from the workspace's own configured slots, and when there are none the answer
 * is that there is no answer. A suggested time nobody measured is worse than no suggestion, because
 * it is indistinguishable from one that was.
 */
import { z } from "zod";
import { asId, type Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";
import type {
  PostDraftId,
  PublishTimeSuggestion,
  RecurringSchedule,
  ScheduleId,
  TimeSlot,
} from "../services/index.js";
import type { ShareFlowToolFactory } from "./factory.js";
import { idString, shareFlowTool } from "./factory.js";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Named as well as numbered: `weekday: 2` is a fact the model has to translate, and may get wrong. */
const weekdayView = (weekday: number) => ({ weekday, weekdayName: WEEKDAY_NAMES[weekday] ?? "unknown" });

const scheduleView = (rule: RecurringSchedule) => ({
  scheduleId: rule.id,
  name: rule.name,
  ...(rule.postId === undefined ? {} : { postId: rule.postId }),
  frequency: rule.frequency,
  interval: rule.interval,
  ...(rule.weekdays === undefined
    ? {}
    : { weekdays: rule.weekdays, weekdayNames: rule.weekdays.map((d) => WEEKDAY_NAMES[d] ?? "unknown") }),
  ...(rule.dayOfMonth === undefined ? {} : { dayOfMonth: rule.dayOfMonth }),
  timeOfDay: rule.timeOfDay,
  timezone: rule.timezone,
  status: rule.status,
  ...(rule.nextOccurrenceAt === undefined ? {} : { nextOccurrenceAt: rule.nextOccurrenceAt }),
  accountIds: rule.accountIds,
});

const slotView = (slot: TimeSlot) => ({
  slotId: slot.id,
  label: slot.label,
  ...weekdayView(slot.weekday),
  timeOfDay: slot.timeOfDay,
  timezone: slot.timezone,
});

const suggestionView = (suggestion: PublishTimeSuggestion) =>
  suggestion.basis === "none"
    ? { basis: suggestion.basis, reason: suggestion.reason }
    : suggestion.basis === "measured"
      ? {
          basis: suggestion.basis,
          ...weekdayView(suggestion.weekday),
          timeOfDay: suggestion.timeOfDay,
          timezone: suggestion.timezone,
          engagements: suggestion.engagements,
          daysObserved: suggestion.daysObserved,
        }
      : {
          basis: suggestion.basis,
          slotLabel: suggestion.slotLabel,
          ...weekdayView(suggestion.weekday),
          timeOfDay: suggestion.timeOfDay,
          timezone: suggestion.timezone,
        };

const listSchedulesSchema = z
  .object({ postId: idString.optional(), limit: z.number().int().min(1).max(50).default(20) })
  .strict();

export const listSchedulesTool = shareFlowTool(["schedules"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "list_schedules",
    label: "List recurring schedules",
    description:
      "The workspace's recurring rules — what recurs, how often, and when each next fires. `nextOccurrenceAt` is the next occurrence that has actually been scheduled, not a predicted one, so a rule with none has nothing queued ahead of it. Use this to find the schedule the user means before cancelling one.",
    category: "schedules",
    effect: "read",
    inputSchema: listSchedulesSchema,
    delegatesTo: "ScheduleService.listSchedules",
    delegate: async (input: z.infer<typeof listSchedulesSchema>, context) => ({
      schedules: (
        await services.schedules.listSchedules(context, {
          limit: input.limit,
          ...(input.postId === undefined ? {} : { postId: asId<PostDraftId>(input.postId) }),
        })
      ).map(scheduleView),
    }),
  }));

export const listTimeSlotsTool = shareFlowTool(["schedules"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "list_time_slots",
    label: "List time slots",
    description:
      "The posting slots this workspace configured for itself — the times it has already decided it wants to publish at. Prefer one of these over a time you chose: they are the workspace's own decision, and a slot they set is a slot they will recognise.",
    category: "schedules",
    effect: "read",
    inputSchema: z.object({}).strict(),
    delegatesTo: "ScheduleService.listTimeSlots",
    delegate: async (_input: unknown, context) => ({
      slots: (await services.schedules.listTimeSlots(context)).map(slotView),
    }),
  }));

const suggestSchema = z
  .object({
    platform: z.string().trim().min(1).max(40).optional(),
    sinceDays: z.number().int().min(7).max(365).default(90),
  })
  .strict();

export const suggestPublishTimeTool = shareFlowTool(["schedules"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "suggest_publish_time",
    label: "Suggest a publish time",
    description:
      "When to publish, measured from this workspace's own engagement history. **Read `basis` and say which it was.** `measured` means the weekday came from real engagement data — quote `engagements` and `daysObserved` rather than asserting it. `configured-slot` means there was not enough data and this is a slot the workspace set itself. `none` means there is nothing to base a suggestion on, and the honest answer is to say so and ask — never fill it in. The weekday is measured; the hour always comes from a configured slot, because the data is daily and says nothing about hours.",
    category: "schedules",
    effect: "read",
    inputSchema: suggestSchema,
    delegatesTo: "ScheduleService.suggestPublishTime",
    delegate: async (input: z.infer<typeof suggestSchema>, context) =>
      suggestionView(
        await services.schedules.suggestPublishTime(context, {
          sinceDays: input.sinceDays,
          ...(input.platform === undefined ? {} : { platform: input.platform }),
        }),
      ),
  }));

const createSchema = z
  .object({
    postId: idString,
    accountIds: z.array(idString).min(1).max(20),
    name: z.string().trim().min(1).max(120).optional(),
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
    interval: z.number().int().min(1).max(52).optional(),
    /** 0-6, Sunday first — the column's own convention, and the one `list_time_slots` reports. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    timeOfDay: z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/, "use HH:MM"),
    timezone: z.string().trim().min(1).max(60).optional(),
    until: z.string().trim().min(4).max(40).optional(),
    count: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const createRecurringScheduleTool = shareFlowTool(["schedules"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "create_recurring_schedule",
    label: "Create a recurring schedule",
    description:
      "Publish an existing post on a repeating schedule — every Tuesday at 9, the 1st of each month, and so on. The post must already be approved; this will not approve it for you. `weekdays` is 0-6 with Sunday first and only applies to WEEKLY. Give `until` or `count` when the user said how long it should run — a rule with neither runs forever. Check `materialised` in the result: it is how many occurrences were actually scheduled, and zero means the rule exists but produced nothing yet.",
    category: "schedules",
    /**
     * `external-write`: every occurrence this creates publishes to a platform. That the first one may
     * be days away does not make it internal — the approval is for the whole series, which is the
     * only moment anyone is asked about it.
     */
    effect: "external-write",
    inputSchema: createSchema,
    delegatesTo: "ScheduleService.createRecurringSchedule",
    delegate: async (input: z.infer<typeof createSchema>, context, { idempotencyKey }) => {
      const result = await services.schedules.createRecurringSchedule(context, {
        idempotencyKey,
        postId: asId<PostDraftId>(input.postId),
        accountIds: input.accountIds,
        frequency: input.frequency,
        timeOfDay: input.timeOfDay,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }),
        ...(input.dayOfMonth === undefined ? {} : { dayOfMonth: input.dayOfMonth }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.until === undefined ? {} : { until: input.until }),
        ...(input.count === undefined ? {} : { count: input.count }),
      });
      return { ...scheduleView(result.schedule), materialised: result.materialised };
    },
  }));

const cancelSchema = z.object({ scheduleId: idString }).strict();

export const cancelRecurringScheduleTool = shareFlowTool(["schedules"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "cancel_recurring_schedule",
    label: "Cancel a recurring schedule",
    description:
      "Stop a recurring schedule. Occurrences that have not gone out yet are cancelled and the rule is removed; anything already published stays published and stays in the history. Use `list_schedules` first to be sure which rule the user means — cancelling is not undoable and the rule cannot be put back as it was.",
    category: "schedules",
    effect: "external-write",
    inputSchema: cancelSchema,
    delegatesTo: "ScheduleService.cancelRecurringSchedule",
    delegate: async (input: z.infer<typeof cancelSchema>, context, { idempotencyKey }) =>
      services.schedules.cancelRecurringSchedule(context, {
        idempotencyKey,
        scheduleId: asId<ScheduleId>(input.scheduleId),
      }),
  }));

/** The complete Schedules catalog, pinned by a test. */
export const SCHEDULE_TOOL_NAMES = [
  "list_schedules",
  "list_time_slots",
  "suggest_publish_time",
  "create_recurring_schedule",
  "cancel_recurring_schedule",
] as const;

export const SCHEDULE_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [
  listSchedulesTool,
  listTimeSlotsTool,
  suggestPublishTimeTool,
  createRecurringScheduleTool,
  cancelRecurringScheduleTool,
];
