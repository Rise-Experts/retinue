import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withWriting, withWritten } from "../postBoardModel";
import { writtenChannelsOf } from "../useWrittenChannels";

/** #497 AC-1 — "one card per channel, filled as each channel finishes". */
describe("writtenChannelsOf", () => {
  it("reads the channels map, keeping captions and the could-not-write nulls", () => {
    expect(writtenChannelsOf({ callKey: "k", channels: { instagram: "IG text", x: null, bad: 3 } })).toEqual({ instagram: "IG text", x: null });
  });

  it("is empty for anything else", () => {
    for (const value of [null, undefined, "x", {}, { channels: null }, { channels: "no" }]) expect(writtenChannelsOf(value)).toEqual({});
  });
});

describe("withWritten", () => {
  const writing = withWriting({}, ["instagram", "linkedin", "x"], ["instagram", "linkedin", "x"]);

  it("fills a finished card and stops its spinner, leaving the others writing", () => {
    const drafts = withWritten(writing, { linkedin: "LinkedIn text" });
    expect(drafts.linkedin).toMatchObject({ text: "LinkedIn text", generating: false });
    expect(drafts.instagram?.generating).toBe(true);
    expect(drafts.x?.generating).toBe(true);
  });

  it("stops the spinner for a channel that could not be written, without inventing text", () => {
    const drafts = withWritten(writing, { x: null });
    expect(drafts.x).toMatchObject({ generating: false, text: "" });
  });

  it("ignores a channel that has no card", () => {
    expect(withWritten(writing, { tiktok: "nope" }).tiktok).toBeUndefined();
  });
});

describe("the wiring", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  it("polls only while the pane shows a post still being written, and passes it to the panel", () => {
    const chat = readFileSync(join(dir, "RetinueChat.tsx"), "utf8");
    expect(chat).toContain("useWrittenChannels(liveRunId, openPost !== null && openPost.postId === null && openPost.writing.length > 0)");
    expect(chat).toContain("written={writtenChannels}");
    expect(readFileSync(join(dir, "PostPanel.tsx"), "utf8")).toContain("withWritten(withWriting({}, selectedIds, writing), written)");
  });
});

describe("publish checks restored from compose (#500 parity)", () => {
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "PostPanel.tsx"), "utf8");
  it("will not ask to publish while a file is still uploading", () => {
    expect(panel).toMatch(/board\.media\.some\(\(m\) => m\.uploading\)\) \{\s*setAskError\(t\("postPanel\.mediaUploading"\)\)/);
  });
});
