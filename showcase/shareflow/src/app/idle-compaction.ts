/**
 * A long chat condensed while nobody is waiting — #657.
 *
 * Every turn re-sends the conversation. Within a few minutes of the last one the provider's prompt cache makes that
 * cheap; after a break the cache has expired, and the first message back pays for the whole history again — about
 * €0.28 per million tokens on Gemini 2.5 Flash, and on Anthropic a one-hour cache *write* at twice the input price
 * (≈ €5.50 for a million tokens on Sonnet). A 1M chat returned to five times a day cost ~€1.40 on Flash and ~€27.50
 * on Sonnet for those first messages alone.
 *
 * By the time a chat has been quiet for `IDLE_COMPACT_AFTER_MS` its cache is cold anyway, so that is the cheapest
 * moment to condense it: the older part becomes a summary (written on a small model), and the message the person comes
 * back with sends summary + the recent part — `IDLE_KEEP_TOKENS` — instead of everything.
 *
 * In-process timers, per conversation, reset by every turn. The worker is one process; a restart loses the timers,
 * and then the ordinary compaction at the next turn still bounds the prompt — slower for that one turn, never wrong.
 */

/** How long a chat must be quiet before it is condensed. Past every provider's short cache. */
export const IDLE_COMPACT_AFTER_MS = 15 * 60_000;
/** Condense only a chat whose verbatim history is over this many tokens; a short chat is cheap to resend. */
export const IDLE_COMPACT_AT_TOKENS = 120_000;
/** What stays verbatim after an idle condense — the part a returning person is most likely to refer to. */
export const IDLE_KEEP_TOKENS = 60_000;

export type IdleCompactor = {
  /** (Re)start the quiet timer for a conversation; `job` runs if no other turn touches it first. */
  touch(key: string, job: () => Promise<void>): void;
  /** How many conversations have a timer running — for tests and logs. */
  readonly pending: () => number;
};

export const createIdleCompactor = (options: {
  readonly afterMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly log?: (line: string) => void;
} = {}): IdleCompactor => {
  const afterMs = options.afterMs ?? IDLE_COMPACT_AFTER_MS;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      // A pending condense must never keep the worker alive on shutdown.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = options.log ?? ((line: string) => console.warn(line));
  const timers = new Map<string, unknown>();

  return {
    touch(key, job) {
      const existing = timers.get(key);
      if (existing !== undefined) clearTimer(existing);
      timers.set(
        key,
        setTimer(() => {
          timers.delete(key);
          job().catch((error: unknown) => {
            log(`[shareflow] idle compaction of conversation ${key} failed: ${error instanceof Error ? error.message : String(error)}. The next turn condenses it instead.`);
          });
        }, afterMs),
      );
    },
    pending: () => timers.size,
  };
};
