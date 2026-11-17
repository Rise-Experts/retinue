import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaver } from "../debouncedSaver";

/** The post panel's save timing — #497. A fake `save` that records what the board held when it ran. */
describe("createSaver", () => {
  let board: string;
  let stored: string[];
  let fail: boolean;
  const save = vi.fn(async () => {
    const snapshot = board;
    await Promise.resolve();
    if (fail) return false;
    stored.push(snapshot);
    return true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    board = "";
    stored = [];
    fail = false;
    save.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("saves once, after the typing stops", async () => {
    const saver = createSaver(save, 800);
    for (const text of ["H", "He", "Hello"]) {
      board = text;
      saver.touch();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(stored).toEqual(["Hello"]);
  });

  it("flush stores the edit before it resolves — what a reload or Schedule reads next (AC-2)", async () => {
    const saver = createSaver(save, 800);
    board = "Hand-edited LinkedIn text";
    saver.touch();
    await saver.flush(); // no timer advanced: the edit is stored because flush was awaited
    expect(stored).toEqual(["Hand-edited LinkedIn text"]);
    expect(saver.pending).toBe(false);
  });

  it("never has two saves on the wire: a flush during a save waits, then stores what changed", async () => {
    // Two PATCHes in flight can land in either order, and the older text would win.
    const releases: Array<() => void> = [];
    const sent: string[] = [];
    const slowSave = vi.fn(() => {
      sent.push(board);
      return new Promise<boolean>((done) => releases.push(() => done(true)));
    });
    const saver = createSaver(slowSave, 800);
    board = "first";
    saver.touch();
    const early = saver.flush();
    board = "second"; // typed while the first save is on the wire
    saver.touch();
    const late = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["first"]); // the second waits
    releases[0]!();
    await early;
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["first", "second"]);
    releases[1]!();
    await late;
    expect(saver.pending).toBe(false);
  });

  it("keeps a failed edit pending, and the next flush tries it again", async () => {
    const saver = createSaver(save, 800);
    board = "draft";
    fail = true;
    saver.touch();
    await saver.flush();
    expect(stored).toEqual([]);
    expect(saver.pending).toBe(true);
    fail = false;
    await saver.flush();
    expect(stored).toEqual(["draft"]);
  });

  it("does nothing on flush when nothing changed", async () => {
    const saver = createSaver(save, 800);
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
