/**
 * Per-host politeness — REQ-055 (#237), task #238, AC-6.
 *
 * A crawl seeded on a page with two hundred links is, without this, two hundred simultaneous requests to one
 * server. That is a small denial of service, it is indistinguishable from an attack at the receiving end, and
 * the fact that nobody meant it does not help the site that fell over.
 *
 * Two limits, because they answer different questions:
 *
 * - **Concurrency** — how many requests are open at once. Bounds the instantaneous load.
 * - **Spacing** — the minimum gap between two request *starts*. Bounds the sustained rate, which concurrency
 *   alone does not: two-at-a-time against a server answering in 5ms is four hundred requests a second.
 *
 * Both are per host, not global. A crawl across forty hosts should not be slowed to the rate of one, and forty
 * requests to one host must not be allowed because they were spread across forty different pages.
 *
 * `Crawl-delay` from `robots.txt` raises the spacing when a site asks for more — and only ever raises it, since
 * a site asking for ten seconds and getting the default half-second is the request being ignored.
 */

export type PolitenessOptions = {
  /** Open requests per host. Two is the convention, and enough to keep a crawl moving. */
  readonly perHostConcurrency?: number;
  /** Minimum gap between starts, per host. */
  readonly minIntervalMs?: number;
  /** Injectable so a test can prove the spacing without spending it. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type Gate = {
  /** Runs `work` when this host has capacity, respecting concurrency and spacing. */
  readonly run: <T>(host: string, work: () => Promise<T>) => Promise<T>;
  /** Raises this host's spacing — never lowers it. From `Crawl-delay`. */
  readonly requireInterval: (host: string, ms: number) => void;
  /** For tests and reporting: how long this gate has spent waiting, per host. */
  readonly waited: () => Readonly<Record<string, number>>;
};

type HostState = {
  active: number;
  nextAllowedAt: number;
  intervalMs: number;
  queue: (() => void)[];
  waitedMs: number;
};

export const createGate = (options: PolitenessOptions = {}): Gate => {
  const concurrency = Math.max(1, options.perHostConcurrency ?? 2);
  const defaultInterval = Math.max(0, options.minIntervalMs ?? 500);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const hosts = new Map<string, HostState>();

  const stateFor = (host: string): HostState => {
    const existing = hosts.get(host);
    if (existing !== undefined) return existing;
    const fresh: HostState = { active: 0, nextAllowedAt: 0, intervalMs: defaultInterval, queue: [], waitedMs: 0 };
    hosts.set(host, fresh);
    return fresh;
  };

  const release = (state: HostState) => {
    state.active -= 1;
    const next = state.queue.shift();
    if (next !== undefined) next();
  };

  return {
    requireInterval(host, ms) {
      const state = stateFor(host);
      // Only ever raises. A site asking for ten seconds and getting the default is the request ignored.
      state.intervalMs = Math.max(state.intervalMs, Math.max(0, ms));
    },
    waited() {
      return Object.fromEntries([...hosts].map(([host, state]) => [host, state.waitedMs]));
    },
    async run(host, work) {
      const state = stateFor(host);
      if (state.active >= concurrency) {
        // Queued rather than rejected: a crawl that dropped work at the limit would silently return less than
        // it found, which is the same failure as an unreported truncation.
        await new Promise<void>((resolve) => state.queue.push(resolve));
      }
      state.active += 1;
      try {
        const wait = state.nextAllowedAt - now();
        if (wait > 0) {
          state.waitedMs += wait;
          await sleep(wait);
        }
        // Stamped before the work, so spacing measures start-to-start rather than end-to-start. A server that
        // answers slowly should not earn extra requests.
        state.nextAllowedAt = now() + state.intervalMs;
        return await work();
      } finally {
        release(state);
      }
    },
  };
};
