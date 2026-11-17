/**
 * `ScheduleService` over `posting_schedules`, `time_slots` and `analytics_daily` — #425.
 *
 * **Reads go to Postgres; writes go through the app.** That split is not an accident of what was easy:
 *
 * - Listing a rule, its slots and its engagement history is a query, and this package already holds a
 *   pooled connection.
 * - *Creating* one is not. #425's first acceptance is that an assistant-made schedule materialises
 *   into `scheduled_items` **exactly as** a UI-made one, and the materialiser — `expandSchedule` —
 *   needs BullMQ, which this package's boundary rules keep out. Writing the rule row here and letting
 *   the hourly tick find it would satisfy that eventually while reproducing #403's bug: an assistant
 *   action that quietly takes an hour when the same action in the app is instant.
 *
 * So the writes ask `/api/internal/schedules`, and the materialiser is literally the same call the UI
 * makes. Absent that hop the write tools refuse by name rather than writing a rule nothing expands.
 */

import { AgentPlatformError, type ExecutionContext } from "@retinue/agentkit";
import type { SqlExecutor } from "@retinue/agentkit/adapters/postgres";

import type {
  PostDraftId,
  PublishTimeSuggestion,
  RecurringSchedule,
  ScheduleId,
  ScheduleService,
  TimeSlot,
} from "../../services/index.js";

export type ScheduleDeps = {
  readonly sql: SqlExecutor;
  /**
   * The app's recurring-schedule endpoint. Absent, the two write methods refuse by name.
   *
   * The same shape as `MediaDeps.storeMedia`: a deployment that cannot reach the app has a narrower
   * assistant, not a broken one — it can still read every schedule and every slot.
   */
  readonly write?: {
    create(input: {
      readonly context: ExecutionContext;
      readonly body: Record<string, unknown>;
    }): Promise<{ schedule: Record<string, unknown>; materialised: number }>;
    cancel(input: {
      readonly context: ExecutionContext;
      readonly scheduleId: string;
    }): Promise<{ cancelled: number | true }>;
  };
};

type RuleRow = {
  id: string;
  name: string;
  post_id: string | null;
  frequency: string;
  interval: number;
  weekdays: number[] | null;
  day_of_month: number | null;
  time_of_day: string;
  timezone: string;
  status: string;
  social_account_ids: string[];
  next_at: Date | string | null;
};

const ruleView = (row: RuleRow): RecurringSchedule => ({
  id: row.id as ScheduleId,
  name: row.name,
  ...(row.post_id === null ? {} : { postId: row.post_id as PostDraftId }),
  frequency: row.frequency as RecurringSchedule["frequency"],
  interval: Number(row.interval),
  ...(row.weekdays === null ? {} : { weekdays: row.weekdays }),
  ...(row.day_of_month === null ? {} : { dayOfMonth: Number(row.day_of_month) }),
  // `time without time zone` comes back as `09:41:00`; the seconds are noise to a reader.
  timeOfDay: String(row.time_of_day).slice(0, 5),
  timezone: row.timezone,
  status: row.status as RecurringSchedule["status"],
  ...(row.next_at === null ? {} : { nextOccurrenceAt: new Date(row.next_at).toISOString() }),
  accountIds: row.social_account_ids ?? [],
});

const noWriteHop = (): never => {
  throw new AgentPlatformError({
    code: "capability_unavailable",
    message:
      "This deployment cannot create or cancel recurring schedules: it has no route to the app, and a " +
      "rule written without the app's expansion step would never produce a post. Reading schedules and " +
      "time slots still works.",
    retryable: false,
  });
};

export const createPostgresScheduleService = (deps: ScheduleDeps): ScheduleService => ({
  async listSchedules(context, input): Promise<readonly RecurringSchedule[]> {
    /*
     * `next_at` is the rule's next **already-materialised** occurrence, not a computed one.
     *
     * Computing the next fire time here would be a second recurrence implementation next to
     * `lib/recurrence.ts`, and the two would disagree the first time a DST boundary landed between
     * them. What is materialised is a fact; what is predicted is a guess with a bug in it.
     */
    const rows = await deps.sql.query<RuleRow>(
      `select s.id, s.name, s.post_id, s.frequency, s.interval, s.weekdays, s.day_of_month,
              s.time_of_day, s.timezone, s.status, s.social_account_ids,
              (select min(i.scheduled_at) from public.scheduled_items i
                where i.posting_schedule_id = s.id
                  and i.scheduled_at > now()
                  and i.status in ('PENDING', 'QUEUED')) as next_at
         from public.posting_schedules s
        where s.workspace_id = $1::uuid
          and ($2::uuid is null or s.post_id = $2::uuid)
        order by s.created_at desc
        limit $3::int`,
      [String(context.tenantId), input.postId ?? null, input.limit],
    );
    return rows.map(ruleView);
  },

  async listTimeSlots(context): Promise<readonly TimeSlot[]> {
    const rows = await deps.sql.query<{
      id: string; label: string; weekday: number; time_of_day: string; timezone: string;
    }>(
      `select id, label, weekday, time_of_day, timezone
         from public.time_slots
        where workspace_id = $1::uuid
        order by sort_order, weekday, time_of_day`,
      [String(context.tenantId)],
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      weekday: Number(row.weekday),
      timeOfDay: String(row.time_of_day).slice(0, 5),
      timezone: row.timezone,
    }));
  },

  async suggestPublishTime(context, input): Promise<PublishTimeSuggestion> {
    /*
     * `analytics_daily` is a **daily** rollup: it says which weekday performs, and nothing about the
     * hour. So the weekday is measured and the hour comes from the workspace's own configured slots.
     * Inventing an hour from daily data is precisely the "never invents a time" this must not do.
     */
    const byWeekday = await deps.sql.query<{ weekday: number; engagements: string; days: string }>(
      `select extract(dow from d.day)::int as weekday,
              sum(d.engagements)::bigint    as engagements,
              count(distinct d.day)::bigint as days
         from public.analytics_daily d
        where d.workspace_id = $1::uuid
          and d.day >= (current_date - ($2::int || ' days')::interval)
          and ($3::text is null or d.platform = $3::text)
        group by 1
        having sum(d.engagements) > 0
        order by sum(d.engagements) desc
        limit 1`,
      [String(context.tenantId), input.sinceDays, input.platform ?? null],
    );

    const slots = await this.listTimeSlots(context);
    const best = byWeekday[0];

    if (best !== undefined) {
      // The hour comes from a slot on that weekday when the workspace configured one, and otherwise
      // from any slot — a configured hour is still the workspace's own decision, unlike a made-up one.
      const onDay = slots.find((slot) => slot.weekday === Number(best.weekday)) ?? slots[0];
      if (onDay !== undefined) {
        return {
          basis: "measured",
          weekday: Number(best.weekday),
          timeOfDay: onDay.timeOfDay,
          timezone: onDay.timezone,
          engagements: Number(best.engagements),
          daysObserved: Number(best.days),
        };
      }
    }

    if (slots.length > 0) {
      const slot = slots[0]!;
      return {
        basis: "configured-slot",
        slotLabel: slot.label,
        weekday: slot.weekday,
        timeOfDay: slot.timeOfDay,
        timezone: slot.timezone,
      };
    }

    return {
      basis: "none",
      reason:
        best === undefined
          ? "There is no engagement data for this workspace yet and no time slots are configured, so " +
            "there is nothing to base a suggestion on."
          : "Engagement data exists but no time slots are configured, so there is no hour to suggest — " +
            "only which weekday performed best.",
    };
  },

  async createRecurringSchedule(context, input) {
    if (deps.write === undefined) noWriteHop();
    const result = await deps.write!.create({
      context,
      body: {
        postId: input.postId,
        socialAccountIds: [...input.accountIds],
        frequency: input.frequency,
        interval: input.interval ?? 1,
        timeOfDay: input.timeOfDay,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.weekdays === undefined ? {} : { weekdays: [...input.weekdays] }),
        ...(input.dayOfMonth === undefined ? {} : { dayOfMonth: input.dayOfMonth }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.until === undefined ? {} : { until: input.until }),
        ...(input.count === undefined ? {} : { count: input.count }),
      },
    });

    const row = result.schedule as unknown as RuleRow;
    return { schedule: ruleView({ ...row, next_at: null }), materialised: result.materialised };
  },

  async cancelRecurringSchedule(context, input) {
    if (deps.write === undefined) noWriteHop();
    return deps.write!.cancel({ context, scheduleId: String(input.scheduleId) });
  },
});
