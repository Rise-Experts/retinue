/**
 * #650 — a tool record the model writes itself is cut before it is shown or saved.
 *
 * Production, 2026-09-30: the model wrote "[Your tool calls in this reply …]" with a fake update_artifact and a
 * PDF link to a file that did not exist, and the chat showed it.
 */
import { describe, expect, it } from "vitest";

import { stripToolRecordEcho, withoutToolRecordEcho, withoutToolRecordEchoInContent } from "../tool-record-echo.js";

type Part = { type: string; id?: string; delta?: string };

const run = async (parts: readonly Part[]): Promise<Part[]> => {
  const source = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  const out: Part[] = [];
  const reader = (withoutToolRecordEcho(source) as ReadableStream<Part>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(value);
  }
};

const textOf = (parts: readonly Part[]) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");

describe("stripToolRecordEcho", () => {
  it("cuts from every record header this service has used", () => {
    for (const header of ["[Your tool calls in this reply", "[What your tools did in this reply", "[What your tools returned in this reply", "[System note, not from the person"]) {
      expect(stripToolRecordEcho(`Done.\n${header} — …]\n- update_artifact`)).toEqual({ text: "Done.", stripped: true });
    }
  });

  it("leaves ordinary brackets alone", () => {
    expect(stripToolRecordEcho("See [the deck](chorus-artifact:1) [draft]")).toEqual({ text: "See [the deck](chorus-artifact:1) [draft]", stripped: false });
  });
});

describe("withoutToolRecordEcho", () => {
  it("cuts a header split across deltas, and everything after it in that block", async () => {
    const out = await run([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "I've updated the deck.\n[Your tool" },
      { type: "text-delta", id: "t", delta: " calls in this reply, with what you sent" },
      { type: "text-delta", id: "t", delta: "]\n- update_artifact: version 3" },
      { type: "text-end", id: "t" },
    ]);
    // A newline streamed before the header was recognisable stays; the chat trims it.
    expect(textOf(out).trimEnd()).toBe("I've updated the deck.");
    expect(out.at(-1)?.type).toBe("text-end");
  });

  it("releases a held bracket that never becomes a header", async () => {
    const out = await run([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Open [" },
      { type: "text-delta", id: "t", delta: "the deck](chorus-artifact:1)." },
      { type: "text-end", id: "t" },
    ]);
    expect(textOf(out)).toBe("Open [the deck](chorus-artifact:1).");
  });

  it("releases a trailing partial bracket at the end of the block", async () => {
    const out = await run([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Note: [Your" }, { type: "text-end", id: "t" }]);
    expect(textOf(out)).toBe("Note: [Your");
  });

  it("passes tool calls and other parts through untouched", async () => {
    const call = { type: "tool-call", id: "c1" } as Part;
    const out = await run([call, { type: "finish" }]);
    expect(out).toEqual([call, { type: "finish" }]);
  });
});

describe("withoutToolRecordEchoInContent", () => {
  it("cuts the record from a generated text part", () => {
    const content = [{ type: "text", text: "Done.\n[What your tools did in this reply]\n- x" }, { type: "tool-call", toolName: "y" }];
    expect(withoutToolRecordEchoInContent(content)).toEqual([{ type: "text", text: "Done." }, { type: "tool-call", toolName: "y" }]);
  });
});
