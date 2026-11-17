/**
 * Grouping the thread rail by day.
 *
 * The interesting cases are all boundaries — a conversation from 23:59 last night, one exactly seven
 * days old, one whose timestamp is nonsense — which is why the function takes `now` instead of reading
 * the clock: a version that read it could only be tested by waiting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { filterThreads, groupFor, groupThreads, threadStamp } from '../threadGroups';

const now = new Date('2026-09-09T12:00:00');

const thread = (updatedAt: string, id = updatedAt) => ({ id, title: id, updatedAt });

describe('groupFor', () => {
  it('puts this morning in today', () => {
    expect(groupFor('2026-09-09T08:30:00', now)).toBe('today');
  });

  it('puts last night in yesterday, not today', () => {
    /**
     * Calendar days, not elapsed hours. At 00:30 a message from 23:00 is "yesterday" to the person who
     * sent it, and calling it "today" because it was ninety minutes ago is correctness nobody asked for.
     */
    expect(groupFor('2026-09-08T23:59:00', now)).toBe('yesterday');
    expect(groupFor('2026-09-08T00:01:00', now)).toBe('yesterday');
  });

  it('puts two to six days back in this week', () => {
    expect(groupFor('2026-09-07T12:00:00', now)).toBe('thisWeek');
    expect(groupFor('2026-09-03T12:00:00', now)).toBe('thisWeek');
  });

  it('puts exactly seven days back in earlier', () => {
    // The boundary, written down: six days is "this week" and seven is not.
    expect(groupFor('2026-09-02T12:00:00', now)).toBe('earlier');
    expect(groupFor('2025-01-01T12:00:00', now)).toBe('earlier');
  });

  it('puts an unparseable or future timestamp in today', () => {
    // A row still has to appear somewhere, and the newest bucket is where a clock-skewed row belongs.
    expect(groupFor('not a date', now)).toBe('today');
    expect(groupFor('2026-09-11T12:00:00', now)).toBe('today');
  });
});

describe('groupThreads', () => {
  it('returns the buckets in rail order and drops the empty ones', () => {
    const grouped = groupThreads(
      [thread('2026-09-09T09:00:00', 'a'), thread('2026-08-01T09:00:00', 'b'), thread('2026-09-09T11:00:00', 'c')],
      now,
    );
    // No `yesterday` or `thisWeek` heading: a heading over nothing is furniture.
    expect(grouped.map((g) => g.group)).toEqual(['today', 'earlier']);
  });

  it('keeps the list order inside a bucket, because the API returns newest first', () => {
    const grouped = groupThreads(
      [thread('2026-09-09T11:00:00', 'newest'), thread('2026-09-09T09:00:00', 'older')],
      now,
    );
    expect(grouped[0]?.threads.map((t) => t.id)).toEqual(['newest', 'older']);
  });

  it('is empty for an empty list rather than four empty headings', () => {
    expect(groupThreads([], now)).toEqual([]);
  });
});

describe('threadStamp', () => {
  it('is a time for today, a weekday for this week, a date beyond it', () => {
    expect(threadStamp('2026-09-09T14:22:00', now, 'en-GB')).toMatch(/14[:.]22/);
    expect(threadStamp('2026-09-07T14:22:00', now, 'en-GB')).toMatch(/^Mon/);
    expect(threadStamp('2026-08-01T14:22:00', now, 'en-GB')).toMatch(/Aug/);
  });

  it('follows the locale, since the app runs in two', () => {
    // German abbreviates the weekday differently and orders the date the other way round.
    expect(threadStamp('2026-09-07T14:22:00', now, 'de-DE')).toMatch(/^Mo/);
    expect(threadStamp('2026-08-01T14:22:00', now, 'de-DE')).toMatch(/Aug/);
  });

  it('is empty for an unreadable timestamp rather than "Invalid Date"', () => {
    expect(threadStamp('nonsense', now, 'en-GB')).toBe('');
  });
});

describe('filterThreads', () => {
  const threads = [
    { id: 'a', title: 'Which accounts do I have connected?', updatedAt: '2026-09-09T09:00:00' },
    { id: 'b', title: 'Draw me a mermaid flowchart', updatedAt: '2026-09-09T08:00:00' },
    { id: 'c', title: 'Café opening hours', updatedAt: '2026-09-09T07:00:00' },
  ];

  it('returns everything for a blank query', () => {
    // A filter that hides things while empty looks like a bug, not a filter.
    expect(filterThreads(threads, '')).toEqual(threads);
    expect(filterThreads(threads, '   ')).toEqual(threads);
  });

  it('ignores case, because nobody remembers their own capitalisation', () => {
    expect(filterThreads(threads, 'MERMAID').map((t) => t.id)).toEqual(['b']);
  });

  it('ignores accents, so "cafe" finds "Café"', () => {
    expect(filterThreads(threads, 'cafe').map((t) => t.id)).toEqual(['c']);
  });

  it('matches anywhere in the title, not just the start', () => {
    expect(filterThreads(threads, 'connected').map((t) => t.id)).toEqual(['a']);
  });

  it('is empty when nothing matches, so the rail can say so', () => {
    expect(filterThreads(threads, 'zzz')).toEqual([]);
  });
});

/**
 * Daylight saving, which the day arithmetic used to get wrong twice a year.
 *
 * `groupFor` built two local midnights and divided their difference by a hard-coded `86_400_000`. On a
 * spring-forward the local day is 23 hours, the division floored to 0, and a conversation from
 * yesterday afternoon was filed under **Today** — with `threadStamp` then showing a time rather than a
 * weekday, so the row read as "15:00 today" for something from the day before.
 *
 * The whole existing suite ran with no `TZ` and no transition in range, so every case sat inside a
 * 24-hour day and the bug was unreachable. These pin the zone, because a test for a time-zone bug that
 * does not set the zone is a test of whoever's laptop runs it.
 */
describe('across a daylight-saving transition', () => {
  /**
   * The zone is pinned here, and that is not optional.
   *
   * Measured: under `TZ=UTC` — which is what CI runs — the *old* implementation returns 1 for the
   * spring-forward case and every assertion below passes against the bug. A test for a time-zone
   * defect that does not set the zone is a test of whoever's machine ran it, and it is worse than no
   * test, because it reports coverage it does not have. Node re-reads `process.env.TZ` on assignment,
   * so this genuinely changes what `Date` and `Intl` do; restored afterwards so the rest of the file
   * keeps the runner's zone.
   */
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it('is really running in a zone that observes DST, or nothing below means anything', () => {
    // The guard on the guard. If a runtime ever stops honouring a mid-process TZ change, this says so
    // instead of letting five green assertions imply a fix that was never exercised.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin');
    const january = new Date('2026-01-15T12:00:00.000Z').getTimezoneOffset();
    const july = new Date('2026-07-15T12:00:00.000Z').getTimezoneOffset();
    expect(january).not.toBe(july);
  });

  const springForward = {
    // 2026-03-29 is the European spring-forward: a 23-hour local day.
    yesterdayAfternoon: '2026-03-29T13:00:00.000Z',
    thisMorning: new Date('2026-03-30T08:00:00.000Z'),
  };

  it('calls yesterday afternoon "yesterday" on a 23-hour day', () => {
    expect(groupFor(springForward.yesterdayAfternoon, springForward.thisMorning)).toBe('yesterday');
  });

  it('stamps it with a weekday, not a time, so the row does not read as today', () => {
    // The visible half of the same bug: `threadStamp` branches on `groupFor`.
    expect(threadStamp(springForward.yesterdayAfternoon, springForward.thisMorning, 'en-GB')).toMatch(/^Sun/);
  });

  it('still puts exactly seven days back in earlier when a transition is in between', () => {
    // The other boundary the lost hour moved: six days is "this week" and seven is not, transition or no.
    expect(groupFor('2026-03-25T11:00:00.000Z', new Date('2026-04-01T10:00:00.000Z'))).toBe('earlier');
    expect(groupFor('2026-03-26T11:00:00.000Z', new Date('2026-04-01T10:00:00.000Z'))).toBe('thisWeek');
  });

  it('is unaffected by a fall-back, which is the direction that used to work by luck', () => {
    // A 25-hour day floors to 1 and happened to be right. It must stay right for the new reason.
    expect(groupFor('2026-10-24T13:00:00.000Z', new Date('2026-10-25T08:00:00.000Z'))).toBe('yesterday');
  });

  it('counts calendar days, not elapsed hours, at every offset', () => {
    /**
     * The property the implementation now rests on: two consecutive local dates are one day apart in
     * the index whatever the zone did in between. Asserted over a run of dates that spans a
     * transition, so a future rewrite that reintroduces the division fails here rather than in March.
     */
    const noon = (day: number) => `2026-03-${String(day).padStart(2, '0')}T12:00:00.000Z`;
    for (let day = 24; day <= 30; day += 1) {
      const now = new Date(noon(31));
      const expected = 31 - day;
      const group = expected === 0 ? 'today' : expected === 1 ? 'yesterday' : expected < 7 ? 'thisWeek' : 'earlier';
      expect(groupFor(noon(day), now), `March ${day}`).toBe(group);
    }
  });
});
