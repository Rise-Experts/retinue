/**
 * Conversations grouped by when they were last touched.
 *
 * `ConversationSummary.updatedAt` was on every row and nothing rendered it, so the thread rail was a
 * flat wall of questions in no evident order — and since the titles are the user's own sentences,
 * truncated to about twenty characters, "find the thread from this morning" meant clicking through
 * them. Four buckets is enough structure to make the list scannable and few enough that the headings
 * do not become the content.
 *
 * A pure function taking `now`, because the whole thing is a set of boundary decisions — a conversation
 * from 23:59 yesterday, one from the first day of this week, one exactly seven days old — and a
 * function that read the clock itself could only be tested by waiting.
 */

/** Which bucket a conversation falls in. The order here is the order in the rail. */
export const THREAD_GROUPS = ['today', 'yesterday', 'thisWeek', 'earlier'] as const;

export type ThreadGroup = (typeof THREAD_GROUPS)[number];

/**
 * A calendar-day index for the local day containing `at` — days since the epoch, in the viewer's zone.
 *
 * `Date.UTC` over the **local** year/month/date, which looks like a mistake and is the point: UTC has
 * no daylight saving, so consecutive local dates are always exactly 86,400,000 ms apart in this index
 * and subtracting two of them counts calendar days exactly.
 *
 * The previous version built two local midnights and divided their difference by a hard-coded
 * `86_400_000`. That is only right when every day is 24 hours. On a spring-forward the local day is 23
 * hours, so the division floored to 0 and yesterday afternoon was filed under **Today** with a time
 * instead of a weekday — measured in `Europe/Berlin`: `groupFor('2026-03-29T13:00Z',
 * '2026-03-30T08:00Z')` returned `'today'`, and a thread exactly seven days back across the transition
 * returned `'thisWeek'` instead of `'earlier'`. Any half-hour-offset zone that observes DST (Lord Howe)
 * breaks the same way; a fall-back's 25-hour day happens to survive, which is why this only misfires
 * twice a year and in one direction.
 */
const dayIndex = (at: Date): number =>
  Math.floor(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000);

/**
 * The bucket for one timestamp.
 *
 * Calendar days rather than elapsed hours: at 00:30 a message from 23:00 is "yesterday" to the person
 * who sent it, and calling it "today" because it was ninety minutes ago is the kind of correctness
 * nobody asked for. An unparseable or future timestamp falls to `today` — a row still has to appear
 * somewhere, and the newest bucket is where a clock-skewed row belongs.
 */
export const groupFor = (updatedAt: string, now: Date): ThreadGroup => {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return 'today';

  const days = dayIndex(now) - dayIndex(at);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'thisWeek';
  return 'earlier';
};

export type GroupedThreads<T> = readonly { readonly group: ThreadGroup; readonly threads: readonly T[] }[];

/**
 * Group in the list's own order, keeping only the buckets that have something in them.
 *
 * The input order is preserved inside each bucket: the API returns conversations most recently used
 * first and that is the order to show them in. Empty buckets are dropped rather than rendered as a
 * heading over nothing.
 *
 * That claim was false when this was written, and it is worth saying so because the same sentence
 * appeared in three places while nothing implemented it. The platform's store orders
 * `created_at, id` **ascending** with no way to change it, so this function was faithfully preserving
 * the order of the thirty *oldest* threads — and `updatedAt` was the creation time for almost every
 * row, because nothing bumps that column when a message arrives. So the day buckets were grouping by
 * when a thread was **created**: one started last month and used this morning appeared under
 * "Earlier". Fixed server-side in `shareflow/src/app/conversation-list.ts` (#397); `updatedAt` now
 * carries real last activity, which is what this groups on.
 *
 * That first claim was false when it was written, and is now true because it was made true.
 * `createPostgresConversationStore.list` is `ORDER BY created_at, id` — *ascending* — so this function
 * was being handed the thirty oldest conversations, oldest first, and grouping them impeccably. The
 * ordering is fixed at the source in `shareflow/src/app/newest-first-conversations.ts`; a comment
 * asserting the order of someone else's query is exactly the kind of thing that is worth checking
 * rather than writing down.
 */
export const groupThreads = <T extends { readonly updatedAt: string }>(
  threads: readonly T[],
  now: Date,
): GroupedThreads<T> => {
  const buckets = new Map<ThreadGroup, T[]>();
  for (const thread of threads) {
    const group = groupFor(thread.updatedAt, now);
    const existing = buckets.get(group);
    if (existing === undefined) buckets.set(group, [thread]);
    else existing.push(thread);
  }

  return THREAD_GROUPS.flatMap((group) => {
    const found = buckets.get(group);
    return found === undefined || found.length === 0 ? [] : [{ group, threads: found as readonly T[] }];
  });
};

/**
 * A short, locale-aware stamp for one thread row.
 *
 * The rail is 248px wide and the title takes two lines of it, so this gets one column of about five
 * characters: the time for today, a weekday for this week, a day and month beyond that. A full date on
 * every row would be the same eleven characters repeated down the list, which is noise rather than
 * information.
 *
 * `locale` is passed in because the app runs in English and German and the two abbreviate weekdays and
 * order day/month differently; `Intl` knows, and a hand-rolled format would only know one of them.
 */
export const threadStamp = (updatedAt: string, now: Date, locale: string): string => {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return '';

  const group = groupFor(updatedAt, now);
  if (group === 'today') {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  }
  if (group === 'yesterday' || group === 'thisWeek') {
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at);
  }
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
};

/**
 * Filter threads by what someone typed.
 *
 * Case- and accent-insensitive over the title, because the titles are the user's own sentences and
 * nobody remembers their own capitalisation. Every thread when the query is blank — a filter that hides
 * things while empty is a filter that looks like a bug.
 */
export const filterThreads = <T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): readonly T[] => {
  const needle = fold(query);
  if (needle === '') return threads;
  return threads.filter((thread) => fold(thread.title).includes(needle));
};

/** Lowercase, accent-stripped, whitespace-collapsed — so "Café" matches "cafe". */
const fold = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
