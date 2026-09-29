/**
 * The quiet queue-error listener — #288.
 *
 * Every assertion here is about what does **not** reach the log. The defect this replaces was not a missing
 * message; it was 55 GB of messages, each carrying a job payload. So the interesting cases are the second error
 * inside a window, the error object that is never stringified, and the long message that gets cut.
 */

import { describe, expect, it, vi } from "vitest";

import { quietQueueErrors } from "../errors.js";

/** A stand-in for a BullMQ `Queue`/`Worker` or an ioredis client: something with `on("error", …)`. */
const source = () => {
  const listeners: ((error: unknown) => void)[] = [];
  return {
    on(event: "error", listener: (error: unknown) => void) {
      expect(event).toBe("error");
      listeners.push(listener);
      return this;
    },
    emit(error: unknown) {
      for (const listener of listeners) listener(error);
    },
  };
};

describe("quietQueueErrors", () => {
  it("logs the first error immediately", () => {
    // A rate limit that swallows the first occurrence hides the incident it exists to report.
    const log = vi.fn();
    const s = quietQueueErrors(source(), "run-queue", { log, now: () => 0 });
    s.emit(new Error("OOM command not allowed when used memory > 'maxmemory'"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("[run-queue] OOM command not allowed when used memory > 'maxmemory'");
  });

  it("suppresses the rest of the window and reports how many", () => {
    const log = vi.fn();
    let clock = 0;
    const s = quietQueueErrors(source(), "worker", { log, now: () => clock, windowMs: 60_000 });

    s.emit(new Error("first"));
    for (let i = 0; i < 30_000; i += 1) {
      clock += 1;
      s.emit(new Error("refused"));
    }
    // 30 000 errors inside the window, one line.
    expect(log).toHaveBeenCalledTimes(1);

    clock = 60_000;
    s.emit(new Error("refused"));
    expect(log).toHaveBeenCalledTimes(2);
    // The count is the whole point: once a minute and 30 000 times a minute read identically without it.
    expect(log.mock.calls[1]?.[0]).toBe("[worker] refused (30000 more like this in the last 60s)");
  });

  it("starts a fresh window after each line, so a slow trickle is not batched for ever", () => {
    const log = vi.fn();
    let clock = 0;
    const s = quietQueueErrors(source(), "q", { log, now: () => clock, windowMs: 1_000 });
    for (let i = 0; i < 5; i += 1) {
      s.emit(new Error(`e${i}`));
      clock += 1_000;
    }
    expect(log).toHaveBeenCalledTimes(5);
    // Each one was outside the previous window, so none carries a suppressed count.
    for (const [line] of log.mock.calls) expect(String(line)).not.toContain("more like this");
  });

  it("never stringifies the error object, which is where the payload lives", () => {
    /**
     * The actual 55 GB mechanism: ioredis hangs the refused command's arguments off the error, and a queued
     * job's payload is an argument. Logging `error` or `String(error)` on an object with a `toJSON` reaches it.
     */
    const log = vi.fn();
    const s = quietQueueErrors(source(), "q", { log, now: () => 0 });
    const payload = "x".repeat(10_000);
    const error = Object.assign(new Error("OOM command not allowed"), {
      command: { name: "lpush", args: ["bull:runs:wait", payload] },
    });
    s.emit(error);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toBe("[q] OOM command not allowed");
    expect(line).not.toContain(payload);
    expect(line).not.toContain("lpush");
  });

  it("caps a long message, because the message itself can carry a payload", () => {
    const log = vi.fn();
    const s = quietQueueErrors(source(), "q", { log, now: () => 0 });
    s.emit(new Error("y".repeat(5_000)));
    const line = String(log.mock.calls[0]?.[0]);
    // `[q] ` plus 300 characters, and not one more.
    expect(line.length).toBe("[q] ".length + 300);
  });

  it("collapses whitespace, so a multi-line message does not spend the cap on indentation", () => {
    const log = vi.fn();
    const s = quietQueueErrors(source(), "q", { log, now: () => 0 });
    s.emit(new Error("  connection\n\n   refused   \n  by the server "));
    expect(log.mock.calls[0]?.[0]).toBe("[q] connection refused by the server");
  });

  it("handles a thrown non-Error without crashing the listener", () => {
    // ioredis emits strings in some paths, and a listener that throws is worse than the logging it replaced.
    const log = vi.fn();
    const s = quietQueueErrors(source(), "q", { log, now: () => 0 });
    expect(() => s.emit("plain string failure")).not.toThrow();
    expect(log.mock.calls[0]?.[0]).toBe("[q] plain string failure");
  });

  it("returns the source, so it can wrap a constructor in place", () => {
    // The call sites read `quietQueueErrors(new Worker(…), "worker")`. Constructing and attaching on the next
    // line is the shape where a later edit adds a constructor and forgets the listener.
    const s = source();
    expect(quietQueueErrors(s, "q")).toBe(s);
  });

  it("attaches exactly one listener", () => {
    const on = vi.fn();
    quietQueueErrors({ on }, "q");
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("error");
  });
});
