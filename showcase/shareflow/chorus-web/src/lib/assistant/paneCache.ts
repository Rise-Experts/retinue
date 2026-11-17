'use client';

/**
 * What the chat's side panes last showed — #628 parts 4 and 5.
 *
 * ## The defect
 *
 * Every pane (Posts in this chat, Media, Documents) read its data in a `useEffect` into component state,
 * so closing a pane threw its data away and reopening it showed "Loading…" and an empty grid every time.
 * And a pane only re-read when a turn *settled*, so a post, an image or a PDF the assistant made showed
 * nowhere until the whole turn was over — or, for a media job, until somebody reopened the pane minutes
 * later.
 *
 * ## What this is
 *
 * A module store behind `useSyncExternalStore`, the pattern `lib/sidebar/sidebarData.ts` uses (the panes
 * and the chat are siblings; nothing needs a context):
 *
 * - **stale-while-revalidate** — a pane that has data shows it at once and re-reads in the background;
 * - **in-flight de-duplication** — two readers of one key share one request;
 * - **invalidation by pane kind** — `invalidatePanes(['media'])` marks every media entry stale, and each
 *   mounted pane re-reads; an unmounted one re-reads when it next mounts (which it would anyway);
 * - **the active workspace** — `syncPaneWorkspace` (called beside `syncSidebarWorkspace` in the app store)
 *   drops everything on a switch, and a read that started before the switch never lands after it;
 * - **window focus** marks everything stale, since that is when another tab's work is likeliest new.
 *
 * Pure apart from `window` and React, so the store's rules are testable without a DOM.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

export const PANE_KINDS = ['post', 'posts', 'media', 'documents', 'calendar', 'project'] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

export type PaneEntry<T = unknown> = {
  readonly data: T | undefined;
  readonly hasData: boolean;
  /** When the shown data was read, ms. */
  readonly fetchedAt: number;
  /** Something changed since the read: a mounted reader re-reads. */
  readonly stale: boolean;
  readonly loading: boolean;
};

type Internal = PaneEntry & {
  readonly inFlight?: Promise<unknown>;
  /** When the in-flight read started, so an invalidation during it keeps the entry stale. */
  readonly startedAt?: number;
  readonly invalidatedAt: number;
};

const entries = new Map<string, Internal>();
/** Per kind: bumped on every invalidation, for panes whose data lives elsewhere (the post, the calendar). */
const epochs = new Map<PaneKind, number>();
const listeners = new Set<() => void>();
let workspaceId: string | null = null;
/** Bumped on a workspace switch, so a read that started before it cannot land after it. */
let generation = 0;
let watchingFocus = false;
/** A strictly increasing clock: two events in one millisecond must still order. */
let tick = 0;
const now = (): number => {
  tick = Math.max(tick + 1, Date.now());
  return tick;
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** One key per pane and scope (a conversation, a project). The workspace is the store's, not the key's. */
export const paneKey = (kind: PaneKind, scope: string): string => `${kind}|${scope}`;

const kindOf = (key: string): string => key.slice(0, key.indexOf('|'));

export const peekPane = <T>(key: string): PaneEntry<T> | undefined => entries.get(key) as PaneEntry<T> | undefined;

/**
 * Read `key` through `fetcher`, sharing a read already in flight.
 *
 * A failure keeps what was shown — a pane that blanks on a network blip is worse than one a moment stale —
 * and is not remembered as data, so the next read tries again.
 */
export const loadPane = <T>(key: string, fetcher: () => Promise<T>): Promise<void> => {
  const current = entries.get(key);
  if (current?.inFlight !== undefined) return current.inFlight.then(() => undefined);

  const readFor = generation;
  const startedAt = now();
  const settle = (next: { data?: T; ok: boolean }) => {
    if (readFor !== generation) return;
    const latest = entries.get(key);
    const invalidatedAt = latest?.invalidatedAt ?? 0;
    entries.set(key, {
      data: next.ok ? next.data : latest?.data,
      hasData: next.ok || latest?.hasData === true,
      fetchedAt: next.ok ? startedAt : (latest?.fetchedAt ?? 0),
      // Something changed while the read was out: what it brought back may predate it.
      stale: invalidatedAt > startedAt,
      loading: false,
      invalidatedAt,
    });
    notify();
  };
  const inFlight = fetcher().then(
    (data) => settle({ data, ok: true }),
    () => settle({ ok: false }),
  );
  entries.set(key, {
    data: current?.data,
    hasData: current?.hasData === true,
    fetchedAt: current?.fetchedAt ?? 0,
    stale: false,
    loading: true,
    invalidatedAt: current?.invalidatedAt ?? 0,
    inFlight,
    startedAt,
  });
  notify();
  return inFlight;
};

/** Mark every entry of these kinds stale (mounted panes re-read), and bump their epochs. */
export const invalidatePanes = (kinds: readonly PaneKind[]): void => {
  if (kinds.length === 0) return;
  const wanted = new Set<string>(kinds);
  const at = now();
  for (const [key, entry] of entries) {
    if (!wanted.has(kindOf(key))) continue;
    /*
     * A read in flight is not marked stale now but when it lands (`invalidatedAt > startedAt`): flagging it
     * here would be a true-to-true change at settle time, which no effect sees, and the change would be lost.
     */
    entries.set(key, { ...entry, stale: entry.inFlight === undefined, invalidatedAt: at });
  }
  for (const kind of kinds) epochs.set(kind, (epochs.get(kind) ?? 0) + 1);
  notify();
};

export const invalidateAllPanes = (): void => invalidatePanes(PANE_KINDS);

/** How many times `kind` was invalidated — a reload key for a pane whose data this store does not hold. */
export const paneEpoch = (kind: PaneKind): number => epochs.get(kind) ?? 0;

/**
 * Tell the store which workspace is active. The first id only records it; a switch drops every entry, so
 * no pane can show the previous workspace's posts or files, and a read already out is discarded.
 */
export const syncPaneWorkspace = (next: string | null | undefined): void => {
  const id = next ?? null;
  if (id === null || id === workspaceId) return;
  const previous = workspaceId;
  workspaceId = id;
  if (previous === null) return;
  generation += 1;
  entries.clear();
  for (const kind of PANE_KINDS) epochs.set(kind, (epochs.get(kind) ?? 0) + 1);
  notify();
};

export const subscribePanes = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  if (!watchingFocus && typeof window !== 'undefined') {
    watchingFocus = true;
    // Coming back to the tab: another tab, a teammate or a finished job may have changed anything.
    window.addEventListener('focus', () => invalidateAllPanes());
  }
  return () => {
    listeners.delete(onChange);
  };
};

/** For tests: forget everything, as a fresh page would. */
export const resetPaneCache = (): void => {
  entries.clear();
  epochs.clear();
  workspaceId = null;
  generation += 1;
  notify();
};

const NOTHING = undefined;

/**
 * A pane's data: the cached value at once, re-read in the background on mount and whenever the entry is
 * invalidated. `loading` is true only while there is nothing at all to show.
 *
 * `fetcher` may change identity freely — the latest one is used — and `key: null` reads nothing.
 */
export function usePaneData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): { readonly data: T | undefined; readonly loading: boolean; readonly refreshing: boolean } {
  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });

  const entry = useSyncExternalStore(
    subscribePanes,
    () => (key === null ? NOTHING : (entries.get(key) as PaneEntry<T> | undefined)),
    () => NOTHING,
  );

  // Revalidate on mount and on a key change: the cached value is shown meanwhile.
  useEffect(() => {
    if (key === null) return;
    void loadPane(key, () => latest.current());
  }, [key]);

  // And whenever something marked it stale — a tool result, a finished media job, the window's focus.
  const stale = entry?.stale === true;
  useEffect(() => {
    if (key === null || !stale) return;
    void loadPane(key, () => latest.current());
  }, [key, stale]);

  return {
    data: entry?.data,
    // Only while there is nothing to show and a read is still out: a failed first read shows the empty state.
    loading: key !== null && entry?.hasData !== true && (entry === undefined || entry.loading),
    refreshing: entry?.loading === true,
  };
}

/** The epoch of `kind`, as React state — a reload key for the post pane and the calendar. */
export function usePaneEpoch(kind: PaneKind): number {
  return useSyncExternalStore(subscribePanes, () => paneEpoch(kind), () => 0);
}
