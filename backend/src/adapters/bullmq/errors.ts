/**
 * One short, rate-limited line per Redis/BullMQ error — #288.
 *
 * A BullMQ `Queue`, `Worker` or ioredis client with no `error` listener does two things that are individually
 * reasonable and together fill a disk. Node's EventEmitter contract makes an unhandled `error` throw, so BullMQ
 * attaches its own and prints the whole error object; ioredis, meanwhile, hangs the refused command's arguments
 * off that object — **buffers included**, because a queued job's payload is an argument.
 *
 * In production (Rise-Experts/social_share#473) Redis hit `maxmemory` under `noeviction` and refused every
 * write. Each refusal printed a job payload, the retry loop ran at the speed of a local socket, and
 * `shareflow_worker` alone logged **55 GB** — 137 GB from the web app's worker, which had the same gap. The
 * disk filled; the outage was the logging, not the full Redis.
 *
 * So the rule here is deliberately not "log the error". It is:
 *
 * 1. **The message only.** Never the error object, so ioredis's `args` cannot be reached.
 * 2. **Capped**, because a message can itself carry a payload fragment.
 * 3. **Rate-limited to one line per window**, with the suppressed count on the next line that gets through. The
 *    first error is immediate — a rate limit that swallows the first occurrence is a rate limit that hides the
 *    incident.
 *
 * The count matters as much as the line. "Redis refused a write" once an hour and thirty thousand times a
 * minute are different incidents, and without the number they read identically.
 *
 * The host side of this is already deployed in social_share (`shareflow/src/app/queue-errors.ts` and
 * `web/src/lib/queueErrors.ts`); this is the half only the runtime can fix, because the worker is created in
 * `server/cli-worker.ts` and the queue's connection inside `createBullMqRunQueue`.
 */

/**
 * What this needs from a BullMQ `Queue`, a `Worker` or an ioredis client: somewhere to put a listener.
 *
 * Structural rather than a union of the three concrete types, because the three come from two packages that are
 * **optional peers** here. Naming them would make this module import them, and a consumer embedding the runtime
 * without BullMQ would start paying for a dependency they do not use.
 */
export type QueueErrorSource = {
  on(event: "error", listener: (error: unknown) => void): unknown;
};

export type QuietQueueErrorOptions = {
  /** How long one logged line covers. Default one minute. */
  readonly windowMs?: number;
  /** Injected so a test does not wait a minute of real time. */
  readonly now?: () => number;
  /** Injected so a test does not read stderr, and so a host can route these into its own logger. */
  readonly log?: (line: string) => void;
};

/** A message can carry a payload fragment, so it is truncated as well as rate-limited. */
const MAX_MESSAGE = 300;

/**
 * Attach a quiet `error` listener, and return the source so this can wrap a constructor call in place.
 *
 * Returning the source is what lets the call sites read `quietQueueErrors(new Worker(…), "worker")` rather than
 * constructing, then attaching on the next line. The second shape is the one where a later edit adds a
 * constructor and forgets the listener.
 */
export const quietQueueErrors = <T extends QueueErrorSource>(
  source: T,
  label: string,
  options: QuietQueueErrorOptions = {},
): T => {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));

  /**
   * `-Infinity`, so the first error is always outside the window.
   *
   * `0` would be wrong by the width of the epoch only in theory, but a fake clock starting at 0 in a test is not
   * theoretical: `at - 0 < windowMs` is true at `at = 0`, and the first error would be suppressed — the one
   * case this must never swallow.
   */
  let windowStart = -Infinity;
  let suppressed = 0;

  source.on("error", (error) => {
    const at = now();
    if (at - windowStart < windowMs) {
      suppressed += 1;
      return;
    }
    const raw = error instanceof Error ? error.message : String(error);
    // Whitespace collapsed first: a multi-line message would otherwise spend the cap on indentation.
    const message = raw.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
    const seconds = Math.round((at - windowStart) / 1000);
    log(
      suppressed > 0
        ? `[${label}] ${message} (${suppressed} more like this in the last ${seconds}s)`
        : `[${label}] ${message}`,
    );
    windowStart = at;
    suppressed = 0;
  });

  return source;
};
