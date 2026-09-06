/**
 * Rendering audio — REQ-062 (#257), task #258, AC-10.
 *
 * The clause that matters is the one AC-10 states as a consequence: *"otherwise this is a backend capability no
 * interface can reach"*. An audio file previewed as `speech-hello.mp3 · 41 KB` is a download link, and a user
 * will not download an MP3 to hear a three-second answer. So the assertion is that audio gets its **own** render
 * kind, distinct from every other attachment.
 */
import { describe, expect, it } from "vitest";

import { audioAttachmentsIn, audioAttachmentView, isPlayableAudio } from "../audio.js";
import { partSummary } from "../ui/part-summary.js";
import type { MessagePart } from "../types/index.js";

const filePart = (over: Record<string, unknown> = {}): MessagePart =>
  ({
    id: "p1",
    type: "file",
    schemaVersion: 1,
    createdAt: "t",
    fileId: "file-1",
    filename: "note.mp3",
    mediaType: "audio/mpeg",
    byteSize: 41_000,
    ...over,
  }) as unknown as MessagePart;

describe("audio is its own render kind, not a generic attachment", () => {
  it("classifies a playable audio file as audio", () => {
    expect(partSummary(filePart()).kind).toBe("audio");
  });

  it("leaves every other file as an attachment", () => {
    /**
     * The other half of the assertion. A render kind that caught everything would put a player in front of a
     * PDF, which is worse than the download link it replaced.
     */
    for (const mediaType of ["application/pdf", "text/csv", "image/png", "video/mp4", "application/zip"]) {
      expect(partSummary(filePart({ mediaType, filename: "f" })).kind, mediaType).toBe("attachment");
    }
  });

  it("still previews the name and size, so a fallback renderer loses nothing", () => {
    // A caller that has not implemented a player yet renders the preview and gets what it had before.
    expect(partSummary(filePart()).preview).toBe("note.mp3 · 40 KB");
  });
});

describe("what a player is given", () => {
  it("returns the fields an audio element needs", () => {
    const view = audioAttachmentView(filePart());
    expect(view).toMatchObject({ fileId: "file-1", filename: "note.mp3", mediaType: "audio/mpeg", byteSize: 41_000 });
  });

  it("does not invent a src", () => {
    /**
     * Deliberate. A file's URL depends on the deployment's own file route and whatever signing it uses, and a
     * view model that guessed `/files/${fileId}` would be right for the reference app and wrong for everyone
     * else — a bug that only appears in somebody else's deployment.
     */
    expect(audioAttachmentView(filePart())).not.toHaveProperty("src");
    expect(audioAttachmentView(filePart())).not.toHaveProperty("url");
  });

  it("returns null for anything that is not playable audio", () => {
    /**
     * `null` rather than a view with a flag: a caller that must check a boolean before using the rest is one
     * that will forget once, and the failure is a player rendered for a PDF.
     */
    expect(audioAttachmentView(filePart({ mediaType: "application/pdf" }))).toBeNull();
    expect(audioAttachmentView({ id: "p", type: "text", schemaVersion: 1, createdAt: "t", text: "hi" } as never)).toBeNull();
  });

  it("labels by duration when one is known, and by name when it is not", () => {
    // Generated speech usually has no duration — the endpoint does not report one and computing it means
    // decoding the audio — so the label has to work without it.
    expect(audioAttachmentView(filePart())?.label).toBe("note.mp3");
    expect(audioAttachmentView(filePart(), { durationSeconds: 3 })?.label).toBe("3s");
    expect(audioAttachmentView(filePart(), { durationSeconds: 95 })?.label).toBe("1m 35s");
    expect(audioAttachmentView(filePart(), { durationSeconds: 120 })?.label).toBe("2m");
  });

  it("never produces an empty label", () => {
    // An unnamed file would otherwise render as a control with no text beside it.
    expect(audioAttachmentView(filePart({ filename: "" }))?.label).toBe("audio/mpeg");
  });

  it("marks generated speech as generated", () => {
    // A recording the user attached is theirs and familiar; generated speech is the assistant's output and
    // worth marking, which is a presentation difference rather than a schema one.
    expect(audioAttachmentView(filePart({ filename: "speech-hello.mp3" }))?.generated).toBe(true);
    expect(audioAttachmentView(filePart({ filename: "voice-memo.mp3" }))?.generated).toBe(false);
  });
});

describe("a turn can carry more than one", () => {
  it("returns every playable part, in order", () => {
    /**
     * A list rather than the first one: a turn can carry the recording a user attached *and* the spoken reply,
     * and an interface showing only one would silently drop the other.
     */
    const views = audioAttachmentsIn([
      filePart({ id: "a", filename: "question.wav", mediaType: "audio/wav" }),
      filePart({ id: "b", mediaType: "application/pdf", filename: "report.pdf" }),
      filePart({ id: "c", filename: "speech-answer.mp3" }),
    ]);
    expect(views.map((view) => view.filename)).toEqual(["question.wav", "speech-answer.mp3"]);
    expect(views.map((view) => view.generated)).toEqual([false, true]);
  });

  it("returns nothing for a turn with no audio", () => {
    expect(audioAttachmentsIn([filePart({ mediaType: "text/csv", filename: "a.csv" })])).toEqual([]);
  });
});

describe("the media type check", () => {
  it("accepts what the backend accepts, and tolerates parameters", () => {
    // `audio/webm;codecs=opus` is what a browser's MediaRecorder actually produces.
    for (const mediaType of ["audio/mpeg", "audio/wav", "audio/webm;codecs=opus", "AUDIO/MPEG"]) {
      expect(isPlayableAudio(mediaType), mediaType).toBe(true);
    }
  });

  it("refuses anything else, including an absent type", () => {
    for (const mediaType of ["audio", "text/plain", "video/mp4", "", undefined]) {
      expect(isPlayableAudio(mediaType), String(mediaType)).toBe(false);
    }
  });
});
