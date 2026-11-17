import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #628 part 4: a pane shows its last data at once and re-reads in the background; two readers share one
 * request; an invalidation marks every entry of that pane kind stale; a workspace switch drops everything,
 * and a read started before the switch never lands after it.
 */

const focus: (() => void)[] = [];
vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => type === 'focus' && focus.push(fn) });

const {
  invalidatePanes,
  loadPane,
  paneEpoch,
  paneKey,
  peekPane,
  resetPaneCache,
  subscribePanes,
  syncPaneWorkspace,
} = await import('../paneCache');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  resetPaneCache();
  syncPaneWorkspace('ws-a');
});

describe('pane cache', () => {
  it('keeps what was read, so a reopened pane has it at once', async () => {
    const key = paneKey('media', 'chat-1');
    await loadPane(key, async () => ['a.png']);
    expect(peekPane(key)).toMatchObject({ data: ['a.png'], hasData: true, stale: false, loading: false });
  });

  it('shows the cached value while it re-reads (stale-while-revalidate)', async () => {
    const key = paneKey('posts', 'chat-1');
    await loadPane(key, async () => ['old']);
    const next = deferred<string[]>();
    const reading = loadPane(key, () => next.promise);
    expect(peekPane(key)).toMatchObject({ data: ['old'], loading: true });
    next.resolve(['new']);
    await reading;
    expect(peekPane(key)).toMatchObject({ data: ['new'], loading: false });
  });

  it('shares one request between two readers of a key', async () => {
    const key = paneKey('documents', 'chat-1');
    const fetcher = vi.fn(async () => [1]);
    await Promise.all([loadPane(key, fetcher), loadPane(key, fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the old data when a re-read fails, and a first failure shows no data rather than loading forever', async () => {
    const key = paneKey('media', 'chat-2');
    await loadPane(key, async () => ['kept']);
    await loadPane(key, async () => {
      throw new Error('offline');
    });
    expect(peekPane(key)).toMatchObject({ data: ['kept'], hasData: true, loading: false });

    const fresh = paneKey('media', 'chat-3');
    await loadPane(fresh, async () => {
      throw new Error('offline');
    });
    expect(peekPane(fresh)).toMatchObject({ hasData: false, loading: false });
  });

  it('invalidates by pane kind only', async () => {
    const media = paneKey('media', 'chat-1');
    const posts = paneKey('posts', 'chat-1');
    await loadPane(media, async () => 1);
    await loadPane(posts, async () => 2);
    const before = paneEpoch('media');
    invalidatePanes(['media']);
    expect(peekPane(media)?.stale).toBe(true);
    expect(peekPane(posts)?.stale).toBe(false);
    expect(paneEpoch('media')).toBe(before + 1);
  });

  it('an invalidation during a read leaves the entry stale when the read lands', async () => {
    const key = paneKey('documents', 'chat-1');
    const next = deferred<number>();
    const reading = loadPane(key, () => next.promise);
    invalidatePanes(['documents']);
    // Not flagged while the read is out — that would be a true-to-true change nobody notices.
    expect(peekPane(key)?.stale).toBe(false);
    next.resolve(1);
    await reading;
    expect(peekPane(key)?.stale).toBe(true);
  });

  it('a workspace switch drops every entry, and a read from before it never lands', async () => {
    const key = paneKey('posts', 'chat-1');
    await loadPane(key, async () => ['ws-a post']);
    const next = deferred<string[]>();
    const reading = loadPane(key, () => next.promise);
    syncPaneWorkspace('ws-b');
    expect(peekPane(key)).toBeUndefined();
    next.resolve(['ws-a late']);
    await reading;
    expect(peekPane(key)).toBeUndefined();
  });

  it('the same workspace again changes nothing', async () => {
    const key = paneKey('posts', 'chat-1');
    await loadPane(key, async () => ['x']);
    syncPaneWorkspace('ws-a');
    expect(peekPane(key)?.data).toEqual(['x']);
  });

  it('window focus marks everything stale', async () => {
    const unsubscribe = subscribePanes(() => undefined);
    const key = paneKey('calendar', 'ws');
    await loadPane(key, async () => 1);
    for (const fn of focus) fn();
    expect(peekPane(key)?.stale).toBe(true);
    unsubscribe();
  });

  it('notifies subscribers on every change', async () => {
    const calls = vi.fn();
    const unsubscribe = subscribePanes(calls);
    await loadPane(paneKey('media', 'n'), async () => 1);
    invalidatePanes(['media']);
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(3);
    unsubscribe();
  });
});
