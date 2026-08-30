/**
 * The browser process, and killing it properly — REQ-055 (#237), task #239, AC-5.
 *
 * ## Why the process *group*, and why this is the defect most likely to recur
 *
 * #216 hit it once already: a sandboxed process was killed, the orphan survived, and CI hung. A browser makes
 * that outcome *more* likely, not less, because a browser is not a process — it is a tree. Chrome forks a
 * zygote, a GPU process, a network service and one renderer per tab, and `kill(pid)` on the parent leaves the
 * renderers running. They hold the memory, they hold the sockets, and nothing reaps them.
 *
 * So the child is spawned `detached`, which makes it a process-group leader, and teardown kills the **group**
 * with `kill(-pgid)`. That reaches every descendant regardless of how many times it forked.
 *
 * ## Why SIGTERM then SIGKILL, rather than SIGKILL alone
 *
 * A browser given `SIGTERM` closes its pages and flushes; given `SIGKILL` it leaves a lock file behind that
 * makes the *next* launch on the same profile fail. So: `SIGTERM` to the group, a grace period, then `SIGKILL`
 * to whatever is still there. The grace period is bounded, because a hung browser must not be able to delay
 * teardown indefinitely — which is the same failure the timeout exists to prevent.
 */

import { spawn, type ChildProcess } from "node:child_process";

export type SpawnedProcess = {
  readonly pid: number;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly killGroup: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<number | null>;
  readonly alive: () => boolean;
};

/** Injectable so the supervisor's logic can be tested without launching a browser. */
export type Spawner = (command: string, args: readonly string[]) => SpawnedProcess;

/** Resident memory of a process group, in kilobytes. Injectable for the same reason. */
export type MeasureMemory = (pid: number) => Promise<number>;

export const nodeSpawner: Spawner = (command, args) => {
  /**
   * `detached: true` is what creates the process group.
   *
   * Without it the child shares this process's group, and `kill(-pgid)` would signal the *runtime itself*.
   * That is not a hypothetical: it is what happens the first time somebody adds group-killing to a
   * non-detached spawn, and the symptom is the whole worker dying when one session times out.
   */
  const child: ChildProcess = spawn(command, [...args], { detached: true, stdio: "ignore" });
  let exitCode: number | null = null;
  let running = true;
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      running = false;
      exitCode = code;
      resolve(code);
    });
    child.on("error", () => {
      running = false;
      resolve(null);
    });
  });
  return {
    pid: child.pid ?? -1,
    alive: () => running,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone. Not an error — teardown is idempotent by design.
      }
    },
    killGroup: (signal) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // The negative pid is the group. This is the whole point of `detached` above.
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Gone.
        }
      }
    },
    get exited() {
      return exited;
    },
  } as SpawnedProcess;
};

/** Resident memory of a process group via `ps`, summed across its members. */
export const psMemory: MeasureMemory = async (pid) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    // `-g` selects the process group, which is what the cap is about — a browser's memory lives in its
    // renderers, not in the process that was launched.
    execFile("ps", ["-o", "rss=", "-g", String(pid)], (error, stdout) => {
      if (error) {
        resolve(0);
        return;
      }
      const total = stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
      resolve(total);
    });
  });
};

export type SupervisorOptions = {
  readonly maxLifetimeMs: number;
  readonly maxMemoryKb: number;
  /** How long a `SIGTERM` gets before `SIGKILL`. Bounded, so a hung browser cannot delay teardown. */
  readonly gracePeriodMs?: number;
  /** How often memory is checked. */
  readonly pollIntervalMs?: number;
  readonly spawner?: Spawner;
  readonly measure?: MeasureMemory;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
};

/** How a supervised process ended. `exited` means it went on its own — a crash, or a browser that quit. */
export type EndReason = "lifetime" | "memory" | "closed" | "exited";

export type Supervised = {
  readonly pid: number;
  /** Why it ended, once it has. `null` while running. */
  readonly reason: () => EndReason | null;
  readonly stop: (reason: "lifetime" | "memory" | "closed") => Promise<void>;
  /**
   * Enforces both caps once. Returns how the process ended, or `null` if it is still running.
   *
   * **Returns the reason rather than a boolean**, and that is a correction rather than a preference. The first
   * version answered `true`/`false` for "did I kill it", and the caller then re-read `reason()` to find out
   * why — across an `await`, during which the process could exit on its own and set the reason to `exited`.
   * The caller's mapping had no arm for that and reported `lifetime`, so a browser that *crashed* was reported
   * to the operator as one that ran out of time. Returning the decision from the function that made it removes
   * the second read entirely.
   */
  readonly checkMemory: () => Promise<EndReason | null>;
  readonly alive: () => boolean;
};

export const supervise = (command: string, args: readonly string[], options: SupervisorOptions): Supervised => {
  const spawner = options.spawner ?? nodeSpawner;
  const measure = options.measure ?? psMemory;
  const now = options.now ?? (() => Date.now());
  const grace = options.gracePeriodMs ?? 2_000;
  const started = now();
  const child = spawner(command, args);
  let reason: EndReason | null = null;

  void child.exited.then(() => {
    if (reason === null) reason = "exited";
  });

  const stop = async (why: "lifetime" | "memory" | "closed"): Promise<void> => {
    if (reason !== null) return;
    reason = why;
    child.killGroup("SIGTERM");
    // A bounded wait, then the group is killed outright. `Promise.race` rather than an unconditional sleep, so
    // a browser that shuts down cleanly does not cost the full grace period on every teardown.
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, grace))]);
    if (child.alive()) child.killGroup("SIGKILL");
  };

  return {
    pid: child.pid,
    reason: () => reason,
    alive: () => child.alive(),
    stop,
    async checkMemory() {
      if (reason !== null) return reason;
      if (!child.alive()) return reason ?? "exited";
      if (now() - started >= options.maxLifetimeMs) {
        await stop("lifetime");
        return "lifetime";
      }
      const kb = await measure(child.pid);
      /**
       * Re-checked after the measurement, because `measure` is an `await`.
       *
       * The process can exit while it is in flight. Without this, `stop("memory")` is called on something that
       * already ended, does nothing (correctly — it is dead), and the caller is told a memory cap was hit.
       */
      if (reason !== null) return reason;
      if (kb > options.maxMemoryKb) {
        await stop("memory");
        return "memory";
      }
      return null;
    },
  };
};
