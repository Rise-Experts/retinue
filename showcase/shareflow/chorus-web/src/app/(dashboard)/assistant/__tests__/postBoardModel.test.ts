import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { draftsFromPost, mediaFromPost, patchBodyFor, scheduleRequest, withWriting, type LoadedPost } from "../postBoardModel";
import { emptyDraft } from "../../compose/sessionModel";

/** The post panel's board — #497. */
const here = dirname(fileURLToPath(import.meta.url));
const POST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const loaded: LoadedPost = {
  postId: POST_ID,
  caption: "Instagram text",
  platformCaptions: { linkedin: "LinkedIn text" },
  platforms: ["instagram", "linkedin", "myspace"],
  status: "DRAFT",
  media: [{ path: "ws/a.png", url: "https://signed/a.png", kind: "image" }],
  editable: true,
  textFormatPresetId: null,
};

describe("a saved post on the board", () => {
  it("gives each channel its own caption, or the shared one, and drops a channel it does not know", () => {
    const drafts = draftsFromPost(loaded);
    expect(Object.keys(drafts)).toEqual(["instagram", "linkedin"]);
    expect(drafts.instagram?.text).toBe("Instagram text");
    expect(drafts.linkedin?.text).toBe("LinkedIn text");
    expect(mediaFromPost(loaded)).toEqual([{ path: "ws/a.png", previewUrl: "https://signed/a.png", uploading: false, isVideo: false, ext: "png" }]);
  });
});

describe("what the board saves", () => {
  it("stores a hand edit as that channel's own caption — the text the next revision starts from (AC-2)", () => {
    const drafts = { ...draftsFromPost(loaded), linkedin: { ...emptyDraft(), text: "My own LinkedIn words" } };
    expect(patchBodyFor({ drafts, selected: ["instagram", "linkedin"], media: [], presetId: null })).toEqual({
      caption: "Instagram text",
      platforms: ["instagram", "linkedin"],
      platformCaptions: { linkedin: "My own LinkedIn words" },
      mediaPaths: [],
      textFormatPresetId: null,
    });
  });

  it("saves nothing while there is no caption or no channel, which the route would refuse", () => {
    expect(patchBodyFor({ drafts: { instagram: emptyDraft() }, selected: ["instagram"], media: [], presetId: null })).toBeNull();
    expect(patchBodyFor({ drafts: draftsFromPost(loaded), selected: [], media: [], presetId: null })).toBeNull();
  });

  it("drops the Facebook background once there is media, and skips a file still uploading", () => {
    const body = patchBodyFor({
      drafts: draftsFromPost(loaded),
      selected: ["instagram"],
      media: [
        { path: "ws/a.png", previewUrl: "", uploading: false, isVideo: false, ext: "png" },
        { path: "ws/b.png", previewUrl: "", uploading: true, isVideo: false, ext: "png" },
      ],
      presetId: "fb-sunset",
    });
    expect(body).toMatchObject({ mediaPaths: ["ws/a.png"], textFormatPresetId: null });
  });
});

describe("Schedule from the panel asks the agent (AC-3)", () => {
  it("names the post, the channels and an absolute time, so no timezone is guessed", () => {
    const message = scheduleRequest({ postId: POST_ID, channels: ["Instagram", "LinkedIn"], when: "schedule", date: "2026-10-01", time: "18:30", format: "post", timeZone: "Europe/Berlin" });
    expect(message).toContain(`chorus:post/${POST_ID}`);
    expect(message).toContain("Instagram, LinkedIn");
    expect(message).toContain("2026-10-01 18:30 Europe/Berlin");
    expect(message).toMatch(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z\)/);
    expect(scheduleRequest({ postId: POST_ID, channels: ["X"], when: "now", date: "", time: "", format: "story", timeZone: "UTC" })).toBe(
      `Post chorus:post/${POST_ID} now as a story on X.`,
    );
  });

  it("never calls the schedule route itself — only the agent's gated tools can send, after approval", () => {
    const panel = readFileSync(resolve(here, "../PostPanel.tsx"), "utf8");
    expect(panel).not.toContain("/api/schedule");
    expect(panel).not.toContain("useComposePublish");
    expect(panel).toContain("onSend(");
  });
});

describe("cards being written", () => {
  it("marks the named channels, or all of them, as writing", () => {
    const drafts = draftsFromPost(loaded);
    expect(withWriting(drafts, ["instagram", "linkedin"], ["linkedin"]).linkedin?.generating).toBe(true);
    expect(withWriting(drafts, ["instagram", "linkedin"], ["linkedin"]).instagram?.generating).toBeFalsy();
    expect(Object.values(withWriting(drafts, ["instagram", "linkedin"], "all")).every((d) => d?.generating)).toBe(true);
    expect(withWriting(drafts, ["instagram"], [])).toBe(drafts);
  });
});
