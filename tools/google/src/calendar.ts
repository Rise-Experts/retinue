/**
 * Google Calendar — REQ-054 (#232), task #234.
 *
 * ## Why every write here says it notifies people
 *
 * A calendar write is not confined to the operator's own calendar. Creating an event **sends invitations**;
 * updating one sends an update to everyone already on it; deleting one sends a cancellation. Those emails go
 * to real people who did not ask this agent for anything, and they cannot be recalled.
 *
 * So each description says so in its first sentence — AC-5. A model choosing between "create the event" and
 * "find a time and tell me" has to be able to see that one of those is a message to eight people and the other
 * is not, and the only place it can see that is the description.
 *
 * `sendUpdates` is set explicitly on every write rather than left to Google's default, because the default
 * differs by endpoint and "whatever the API does" is not a decision anybody made.
 */

import { confirms, defineTool, destroys, type Tool } from "@retinue/agentkit/tools";
import { AgentPlatformError } from "@retinue/agentkit";

import type { GoogleTransport } from "./transport.js";

const CATEGORY = "productivity";
const MAX_RESULTS = 250;
const DEFAULT_RESULTS = 25;

export const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

type Json = Record<string, unknown>;

/** An event's start or end, which is either a timed instant or an all-day date. */
const when = (value: Json | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const dateTime = value.dateTime;
  if (typeof dateTime === "string") return dateTime;
  // An all-day event has `date` and no `dateTime`. Returning only `dateTime` silently drops every all-day
  // event's timing, which reads as a malformed calendar rather than a bug here.
  return typeof value.date === "string" ? value.date : undefined;
};

const summarise = (event: Json): Json => ({
  id: event.id,
  summary: event.summary,
  description: event.description,
  location: event.location,
  start: when(event.start as Json | undefined),
  end: when(event.end as Json | undefined),
  allDay: (event.start as Json | undefined)?.dateTime === undefined,
  status: event.status,
  organizer: ((event.organizer ?? {}) as Json)?.email,
  attendees: ((event.attendees as Json[] | undefined) ?? []).map((attendee) => ({
    email: attendee.email,
    // The response status is what somebody asking "who has accepted" actually wants.
    responseStatus: attendee.responseStatus,
    optional: attendee.optional === true,
  })),
  htmlLink: event.htmlLink,
  recurring: event.recurringEventId !== undefined,
});

export const calendarTools = (transport: GoogleTransport): readonly Tool[] => [
  defineTool({
    name: "calendar_list_events",
    label: "List events",
    description:
      "List events on a calendar between two times, soonest first. Times are RFC 3339, for example `2026-09-01T09:00:00Z`. Defaults to the primary calendar.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_READONLY],
    execute: async (
      input: { timeMin: string; timeMax: string; calendarId?: string; query?: string; limit?: number },
      context,
    ) => {
      const calendarId = encodeURIComponent(input.calendarId ?? "primary");
      const params = new URLSearchParams({
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        // Recurring events expanded into instances: a caller asking "what is on Tuesday" means the instance,
        // not the rule that generated it.
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS)),
      });
      if (input.query !== undefined) params.set("q", input.query);
      const result = (await transport.json(context, `/calendar/v3/calendars/${calendarId}/events?${params.toString()}`)) as Json;
      return {
        events: ((result.items as Json[] | undefined) ?? []).map(summarise),
        truncated: result.nextPageToken !== undefined,
      };
    },
  }),
  defineTool({
    name: "calendar_get_event",
    label: "Read an event",
    description: "Read one event: its time, location, description and who has accepted.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_READONLY],
    execute: async (input: { eventId: string; calendarId?: string }, context) => {
      const calendarId = encodeURIComponent(input.calendarId ?? "primary");
      const event = (await transport.json(
        context,
        `/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(input.eventId)}`,
      )) as Json;
      return summarise(event);
    },
  }),
  defineTool({
    name: "calendar_find_free_time",
    label: "Find a free slot",
    description:
      "Find times when everyone is free, across several people's calendars. **Use this before creating an event** — it costs nothing and nobody is notified, where creating an event emails everyone on it.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_READONLY],
    execute: async (
      input: { attendees: string[]; timeMin: string; timeMax: string; durationMinutes?: number },
      context,
    ) => {
      if (input.attendees === undefined || input.attendees.length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "calendar_find_free_time needs at least one calendar to check.",
          retryable: false,
        });
      }
      const result = (await transport.json(context, "/calendar/v3/freeBusy", {
        method: "POST",
        body: {
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          items: input.attendees.map((email) => ({ id: email })),
        },
      })) as Json;

      const calendars = (result.calendars ?? {}) as Json;
      const busy: { start: number; end: number }[] = [];
      const unreadable: string[] = [];
      for (const [email, entry] of Object.entries(calendars)) {
        const typed = (entry ?? {}) as Json;
        /**
         * A calendar this account cannot read reports an error rather than an empty schedule, and the two are
         * opposite answers. Treating "cannot see" as "free" is how an agent books over somebody's day.
         */
        if (Array.isArray(typed.errors) && typed.errors.length > 0) {
          unreadable.push(email);
          continue;
        }
        for (const period of (typed.busy as Json[] | undefined) ?? []) {
          const start = Date.parse(String(period.start));
          const end = Date.parse(String(period.end));
          if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end });
        }
      }

      // Merged, then inverted: overlapping busy blocks from different people would otherwise each carve the
      // window separately and produce slots that are not actually free.
      busy.sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const block of busy) {
        const last = merged[merged.length - 1];
        if (last !== undefined && block.start <= last.end) last.end = Math.max(last.end, block.end);
        else merged.push({ ...block });
      }

      const windowStart = Date.parse(input.timeMin);
      const windowEnd = Date.parse(input.timeMax);
      const minimumMs = Math.max(0, (input.durationMinutes ?? 30) * 60_000);
      const free: { start: string; end: string }[] = [];
      let cursor = windowStart;
      for (const block of merged) {
        if (block.start - cursor >= minimumMs) {
          free.push({ start: new Date(cursor).toISOString(), end: new Date(block.start).toISOString() });
        }
        cursor = Math.max(cursor, block.end);
      }
      if (windowEnd - cursor >= minimumMs) {
        free.push({ start: new Date(cursor).toISOString(), end: new Date(windowEnd).toISOString() });
      }

      return {
        free,
        // Named, not silently excluded: an answer computed without somebody's calendar is a different answer.
        unreadableCalendars: unreadable,
        ...(unreadable.length === 0
          ? {}
          : {
              warning:
                `Could not read ${unreadable.join(", ")}. Those calendars were not considered, so a slot here ` +
                "may still clash for them.",
            }),
      };
    },
  }),
  confirms({
    name: "calendar_create_event",
    label: "Create an event",
    description:
      "Create a calendar event. **Every attendee is emailed an invitation** — this is not confined to your own calendar, and the invitations cannot be recalled. Use calendar_find_free_time first to pick a time that works. Requires approval.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_EVENTS],
    execute: async (
      input: {
        summary: string;
        start: string;
        end: string;
        attendees?: string[];
        description?: string;
        location?: string;
        calendarId?: string;
      },
      context,
    ) => {
      const calendarId = encodeURIComponent(input.calendarId ?? "primary");
      const event = (await transport.json(
        // Explicit rather than Google's default, which differs by endpoint — see the file header.
        context,
        `/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`,
        {
          method: "POST",
          body: {
            summary: input.summary,
            start: { dateTime: input.start },
            end: { dateTime: input.end },
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.location === undefined ? {} : { location: input.location }),
            ...(input.attendees === undefined ? {} : { attendees: input.attendees.map((email) => ({ email })) }),
          },
        },
      )) as Json;
      return {
        id: event.id,
        htmlLink: event.htmlLink,
        // Reported, so a summary of what happened can say it rather than a person discovering it.
        invitationsSent: (input.attendees ?? []).length,
      };
    },
  }),
  confirms({
    name: "calendar_update_event",
    label: "Update an event",
    description:
      "Change an event's time, title, description, location or attendees. **Everyone on the event is emailed about the change**, including people who were already there. Only the fields supplied are changed. Requires approval.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_EVENTS],
    execute: async (
      input: {
        eventId: string;
        calendarId?: string;
        summary?: string;
        start?: string;
        end?: string;
        description?: string;
        location?: string;
        attendees?: string[];
      },
      context,
    ) => {
      const patch: Json = {};
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.start !== undefined) patch.start = { dateTime: input.start };
      if (input.end !== undefined) patch.end = { dateTime: input.end };
      if (input.description !== undefined) patch.description = input.description;
      if (input.location !== undefined) patch.location = input.location;
      if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));
      if (Object.keys(patch).length === 0) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: "calendar_update_event was called with nothing to change. Supply at least one field.",
          retryable: false,
        });
      }
      const calendarId = encodeURIComponent(input.calendarId ?? "primary");
      const event = (await transport.json(
        context,
        `/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(input.eventId)}?sendUpdates=all`,
        { method: "PATCH", body: patch },
      )) as Json;
      return { id: event.id, changed: Object.keys(patch), htmlLink: event.htmlLink };
    },
  }),
  destroys({
    name: "calendar_delete_event",
    label: "Cancel an event",
    description:
      "Cancel an event. **Every attendee is emailed a cancellation**, and this cannot be undone — the event is gone for everyone, not just for you. Requires approval.",
    category: CATEGORY,
    requiredScopes: [CALENDAR_EVENTS],
    execute: async (input: { eventId: string; calendarId?: string }, context) => {
      const calendarId = encodeURIComponent(input.calendarId ?? "primary");
      await transport.json(
        context,
        `/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(input.eventId)}?sendUpdates=all`,
        { method: "DELETE" },
      );
      // Google answers 204 with no body, so there is nothing to report but what was asked and what it did.
      return { eventId: input.eventId, cancelled: true, attendeesNotified: true };
    },
  }),
];
