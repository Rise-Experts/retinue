/**
 * Rendering audio — REQ-062 (#257), task #258, AC-10.
 *
 * ## Why a generic attachment was not enough
 *
 * `partSummary` already classified an audio `file` part as `"attachment"` and previewed it as
 * `speech-hello.mp3 · 41 KB`. That renders, and it is not what AC-10 asks for: *"otherwise this is a backend
 * capability no interface can reach"*. A filename and a size is a **download link**. You cannot listen to it.
 *
 * The difference matters because audio is the one attachment kind where the useful interaction is playing
 * rather than opening: a user who has to download an MP3 to hear a three-second answer will not.
 *
 * So audio gets its own render kind and a view model carrying what a `<audio>` element needs. This package
 * stays headless — it returns the props, it does not render a player, and it certainly does not choose a
 * waveform library.
 *
 * ## Duration is optional and the UI must survive without it
 *
 * The speech endpoint does not report a duration, and computing one means decoding the audio. So a generated
 * artifact usually has none, and a player has to render a control with an unknown length — which is exactly
 * what a browser does natively once it loads the file. A view model that required a duration would force the
 * caller to invent one.
 */

import type { MessagePart } from "./types/index.js";

/** Media types this treats as playable. Deliberately the same list the backend accepts. */
const PLAYABLE = ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/flac", "audio/x-m4a"];

export const isPlayableAudio = (mediaType: string | undefined): boolean =>
  mediaType !== undefined && PLAYABLE.includes(mediaType.split(";")[0]?.trim().toLowerCase() ?? "");

/**
 * What a player needs, and nothing more.
 *
 * `src` is deliberately **not** built here. A file's URL depends on the deployment's own file route and on
 * whatever signing it uses, and a view model that guessed `/files/${fileId}` would be right for the reference
 * app and wrong for everyone else. The caller supplies a resolver; this decides *whether* to show a player and
 * *what to label it*.
 */
export type AudioAttachmentView = {
  readonly fileId: string;
  readonly filename?: string;
  readonly mediaType: string;
  readonly byteSize?: number;
  /** Absent when unknown, which is the common case for generated speech. */
  readonly durationSeconds?: number;
  /** A short label: the filename, or the duration, or the format. Never empty. */
  readonly label: string;
  /**
   * Whether this arrived as a generated artifact rather than as something a person uploaded.
   *
   * Surfaced because the two deserve different treatment in an interface: a recording the user attached is
   * theirs and already familiar, while generated speech is the assistant's output and worth marking as such.
   */
  readonly generated: boolean;
};

const seconds = (value: number): string => {
  const whole = Math.round(value);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
};

/**
 * An audio view for a part, or `null` when the part is not playable audio.
 *
 * `null` rather than a view with a flag: a caller that has to check a boolean before using the rest is a caller
 * that will forget once, and the failure is a player rendered for a PDF.
 */
export const audioAttachmentView = (
  part: MessagePart,
  options: { readonly durationSeconds?: number } = {},
): AudioAttachmentView | null => {
  if (part.type === "file") {
    if (!isPlayableAudio(part.mediaType)) return null;
    const label =
      options.durationSeconds !== undefined ? seconds(options.durationSeconds) : (part.filename || part.mediaType);
    return {
      fileId: String(part.fileId),
      filename: part.filename,
      mediaType: part.mediaType,
      byteSize: part.byteSize,
      ...(options.durationSeconds === undefined ? {} : { durationSeconds: options.durationSeconds }),
      label,
      /**
       * A generated file arrives as a `file` part too, so "generated" is inferred from the name the tool gives
       * it. Not from the media type, which cannot tell the two apart, and not from a field that does not exist
       * — inventing one on `FilePart` for this would be a schema change for a presentation detail.
       */
      generated: part.filename.startsWith("speech-"),
    };
  }
  return null;
};

/**
 * Every playable audio part in a message, in order.
 *
 * A list rather than the first one: a turn can carry a recording the user attached *and* a spoken reply, and an
 * interface that showed only one would silently drop the other.
 */
export const audioAttachmentsIn = (parts: readonly MessagePart[]): readonly AudioAttachmentView[] =>
  parts.map((part) => audioAttachmentView(part)).filter((view): view is AudioAttachmentView => view !== null);
