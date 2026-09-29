/**
 * `createBullMqRunQueue` actually attaches the listener — #288.
 *
 * `errors.test.ts` proves the listener behaves. It cannot prove anything calls it, and a helper nothing reaches
 * is the shape of defect this repository keeps finding: tested, correct, and wired to nothing. The 55 GB log
 * file was not caused by a broken listener, it was caused by an absent one, so the assertion that matters is
 * "something called `on('error')` on the objects this function builds".
 *
 * BullMQ and ioredis are mocked rather than run, so this needs no Redis and stays in the default suite. What is
 * being checked is a wiring fact, and a wiring fact does not need a real socket to be true.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queueListeners: string[] = [];
const redisListeners: string[] = [];

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(
      readonly name: string,
      readonly options: unknown,
    ) {}
    on(event: string) {
      queueListeners.push(event);
      return this;
    }
    add = vi.fn();
    getJobCounts = vi.fn();
    getJob = vi.fn();
    close = vi.fn(async () => undefined);
  },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {}
    on(event: string) {
      redisListeners.push(event);
      return this;
    }
    quit = vi.fn(async () => undefined);
  },
}));

const { createBullMqRunQueue } = await import("../queue.js");

describe("createBullMqRunQueue wiring", () => {
  beforeEach(() => {
    queueListeners.length = 0;
    redisListeners.length = 0;
  });

  it("attaches an error listener to the queue and to its connection", () => {
    createBullMqRunQueue({ url: "redis://127.0.0.1:6379" });
    // Both, because they emit separately: a refused command surfaces on the connection, a queue-level failure
    // on the queue. Covering one and not the other still fills a disk, just from the other half.
    expect(redisListeners).toContain("error");
    expect(queueListeners).toContain("error");
  });

  it("attaches exactly one listener to each, so a repeated call does not multiply the log line", () => {
    createBullMqRunQueue({ url: "redis://127.0.0.1:6379" });
    expect(redisListeners.filter((e) => e === "error")).toHaveLength(1);
    expect(queueListeners.filter((e) => e === "error")).toHaveLength(1);
  });
});
