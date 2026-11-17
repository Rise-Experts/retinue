/**
 * Save after the typing stops, and save *now* when something needs the stored text — #497.
 *
 * The post panel's edits go to `posts` so the agent's next turn reads them. Two things depend on the
 * ordering this guarantees, and both are tested against it rather than against a component:
 *
 * - `flush()` resolves only after every edit made before it is stored (or has failed), so a reload
 *   after a chat revision, or a "Schedule" request, never reads text older than the screen.
 * - A failed save leaves the edit pending, so the next edit or flush tries again instead of the text
 *   silently staying unsaved.
 */
export type Saver = {
  /** An edit happened: save once `delayMs` passes with no further edit. */
  touch(): void;
  /** Save now if anything is pending, after any save already running. */
  flush(): Promise<void>;
  /** Stop the timer without saving — for a saver whose post is gone. */
  dispose(): void;
  readonly pending: boolean;
};

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `save` resolves true when the edit is stored, false when it must be tried again. */
export function createSaver(save: () => Promise<boolean>, delayMs: number, timers: Timers = realTimers): Saver {
  let dirty = false;
  let timer: unknown = null;
  let running: Promise<void> | null = null;

  const stopTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const flush = async (): Promise<void> => {
    stopTimer();
    // Whatever is running saved an older board; wait for it, then save what changed since.
    while (running !== null) await running;
    if (!dirty) return;
    dirty = false;
    running = save()
      .then((stored) => {
        if (!stored) dirty = true;
      })
      .catch(() => {
        dirty = true;
      })
      .finally(() => {
        running = null;
      });
    await running;
  };

  return {
    touch() {
      dirty = true;
      stopTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    },
    flush,
    dispose: stopTimer,
    get pending() {
      return dirty;
    },
  };
}
