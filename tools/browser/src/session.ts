/**
 * Sessions, and the two caps that end them — REQ-055 (#237), task #239, AC-5.
 *
 * A browser session holds a process tree, a chunk of memory and an open connection to somebody else's site.
 * Both of the things that end one are **hard**: a lifetime and a memory ceiling, each enforced by killing the
 * process group and reporting why.
 *
 * They are separate because they catch different failures. A page with a runaway script hits memory in
 * seconds and would sit inside any reasonable lifetime; a session an agent simply forgot to close hits the
 * lifetime and never approaches the memory cap. A design with only one of them has an unbounded failure mode
 * it cannot see.
 *
 * `browser_close` exists so a well-behaved caller frees the resource immediately, and is not what the safety
 * property rests on. A tool that must be called for the system to stay within its limits is a tool a model
 * will one day not call.
 */

import { supervise, type EndReason, type MeasureMemory, type Spawner, type Supervised } from "./supervisor.js";
import { createReferenceRegistry, type ReferenceRegistry } from "./refs.js";

export const DEFAULT_LIFETIME_MS = 5 * 60_000;
export const MAX_LIFETIME_MS = 15 * 60_000;
export const DEFAULT_MEMORY_KB = 1_500_000;
export const MAX_MEMORY_KB = 4_000_000;
export const DEFAULT_MAX_SESSIONS = 3;

export type SessionLimits = {
  readonly maxLifetimeMs?: number;
  readonly maxMemoryKb?: number;
  readonly maxSessions?: number;
};

export type Session = {
  readonly id: string;
  readonly references: ReferenceRegistry;
  readonly startedAt: number;
  readonly process?: Supervised;
  /** Set when a cap ended it, so a later call explains what happened rather than failing obscurely. */
  endedBy?: EndReason;
};

export type SessionManagerOptions = SessionLimits & {
  /** How a browser process is started. Absent for a hosted driver, which has no local process to supervise. */
  readonly launch?: { readonly command: string; readonly args: readonly string[] };
  /**
   * Told whenever a session ends, however it ended — closed, capped, or crashed.
   *
   * This exists because the first version did not have it, and the consequence was a leak the tests caught: a
   * session killed by a cap, or closed because a page redirected itself somewhere private, was removed from
   * this manager and **left open in the driver**. The manager owned the process and the toolkit owned the
   * page, and nothing owned both. A hosted driver has no local process at all, so for those the manager's
   * bookkeeping was the *only* thing that happened.
   */
  readonly onClose?: (id: string, reason: EndReason) => Promise<void>;
  readonly spawner?: Spawner;
  readonly measure?: MeasureMemory;
  readonly now?: () => number;
};

export class SessionEndedError extends Error {}

/**
 * What to tell a caller about a session that is gone.
 *
 * Four reasons, four messages. `exited` used to be reported as `lifetime`, which told an operator a browser
 * ran out of time when it had actually crashed — a wrong answer that sends someone to raise a limit that was
 * never reached.
 */
export const explainEnd = (id: string, reason: EndReason): string => {
  switch (reason) {
    case "closed":
      return `Session "${id}" was closed. Call browser_navigate to start a new one.`;
    case "lifetime":
      return (
        `Session "${id}" was ended because it exceeded its time limit, and its browser process group was ` +
        "killed. Anything it was doing did not finish. Start a new session with browser_navigate."
      );
    case "memory":
      return (
        `Session "${id}" was ended because it exceeded its memory limit, and its browser process group was ` +
        "killed. A page with a runaway script is the usual cause. Start a new session with browser_navigate."
      );
    case "exited":
      return (
        `The browser for session "${id}" ended on its own — it crashed, or was killed from outside. No limit ` +
        "was reached. Start a new session with browser_navigate."
      );
  }
};
export class TooManySessionsError extends Error {}

export type SessionManager = {
  readonly open: (id: string) => Session;
  /** The session, or a thrown explanation of how it ended. */
  readonly require: (id: string) => Session;
  readonly close: (id: string, reason?: EndReason) => Promise<void>;
  /** Enforces both caps for every open session. Called before each tool acts. */
  readonly sweep: () => Promise<readonly { id: string; reason: EndReason }[]>;
  readonly open_count: () => number;
};

const clamp = (value: number | undefined, fallback: number, ceiling: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), ceiling);

export const createSessionManager = (options: SessionManagerOptions = {}): SessionManager => {
  const now = options.now ?? (() => Date.now());
  const maxLifetimeMs = clamp(options.maxLifetimeMs, DEFAULT_LIFETIME_MS, MAX_LIFETIME_MS);
  const maxMemoryKb = clamp(options.maxMemoryKb, DEFAULT_MEMORY_KB, MAX_MEMORY_KB);
  const maxSessions = clamp(options.maxSessions, DEFAULT_MAX_SESSIONS, 20);
  const sessions = new Map<string, Session>();
  const ended = new Map<string, EndReason>();

  return {
    open_count: () => sessions.size,
    open(id) {
      const existing = sessions.get(id);
      if (existing !== undefined) return existing;
      if (sessions.size >= maxSessions) {
        // A cap on *concurrent* sessions as well as on each one: N sessions each inside the memory cap can
        // still exhaust a host, and "each one was within limits" is no comfort to the machine that fell over.
        throw new TooManySessionsError(
          `This deployment allows ${maxSessions} browser sessions at once and ${sessions.size} are open. ` +
            "Close one with browser_close before opening another.",
        );
      }
      const session: Session = {
        id,
        references: createReferenceRegistry(),
        startedAt: now(),
        ...(options.launch === undefined
          ? {}
          : {
              process: supervise(options.launch.command, options.launch.args, {
                maxLifetimeMs,
                maxMemoryKb,
                ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
                ...(options.measure === undefined ? {} : { measure: options.measure }),
                ...(options.now === undefined ? {} : { now: options.now }),
              }),
            }),
      };
      sessions.set(id, session);
      ended.delete(id);
      return session;
    },
    require(id) {
      const session = sessions.get(id);
      if (session !== undefined) return session;
      const why = ended.get(id);
      if (why !== undefined) {
        throw new SessionEndedError(explainEnd(id, why));
      }
      throw new SessionEndedError(`There is no browser session "${id}". Call browser_navigate to start one.`);
    },
    async close(id, reason = "closed") {
      const session = sessions.get(id);
      if (session === undefined) return;
      sessions.delete(id);
      ended.set(id, reason);
      session.endedBy = reason;
      // `exited` means the process ended on its own, so there is nothing left to signal — and asking the
      // supervisor to stop it would record the wrong reason over the true one.
      if (reason === "closed" || reason === "lifetime" || reason === "memory") {
        await session.process?.stop(reason);
      }
      // The driver is told too, or the page stays open in a browser this manager has stopped tracking.
      await options.onClose?.(id, reason).catch(() => {});
    },
    async sweep() {
      const ending: { id: string; reason: EndReason }[] = [];
      for (const [id, session] of [...sessions]) {
        if (session.process === undefined) {
          // A hosted driver has no local process, so the lifetime is enforced here rather than by the supervisor.
          if (now() - session.startedAt >= maxLifetimeMs) {
            await this.close(id, "lifetime");
            ending.push({ id, reason: "lifetime" });
          }
          continue;
        }
        // The reason comes back from the check that made the decision. Re-reading it afterwards is what
        // reported a crashed browser as a lifetime timeout — see `checkMemory`.
        const reason = await session.process.checkMemory();
        if (reason !== null) {
          await this.close(id, reason);
          ending.push({ id, reason });
        }
      }
      return ending;
    },
  };
};
