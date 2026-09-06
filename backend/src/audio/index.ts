/**
 * Hearing and speaking — REQ-062 (#257), task #258, Part 2.
 *
 * Two ports, because the two acts are genuinely separate and a deployment will often want one and not the
 * other: transcription turns audio into text so a text-only model can read it, and speech turns text into
 * audio so an interface can play it.
 *
 * ## Why ports rather than tools that call an API
 *
 * The same reason `tools-search` supplies providers instead of tools. Whisper, Deepgram, AssemblyAI and a
 * self-hosted `whisper.cpp` are four *values*, not four sets of tools — and which one a deployment uses is a
 * decision about cost, residency and latency that a model should never spend a tool call discovering.
 *
 * It also keeps AC-2's real case honest: *"so a deployment can use a model that does not accept audio
 * natively"*. Most models do not. Transcribing first and sending text is how audio reaches them at all, and
 * that path has to exist independently of any one provider.
 *
 * ## Bounds are enforced before the upload, not after
 *
 * AC-4 says so and it is the part most easily got wrong: the natural implementation reads the file, stores it,
 * and then checks. A rejected 200MB recording must not be stored first — it costs the blob write, the
 * retention obligation and the deletion, all for something that was never going to be accepted.
 *
 * So the check takes a *declared* size and media type and answers before any bytes move. `assertWithinBounds`
 * is the function a caller runs at the boundary; nothing here reads a file to find out whether it may.
 *
 * ## Duration is bounded too, and it cannot be checked from the size
 *
 * A byte ceiling is not a duration ceiling: an hour of 8kbps speech is smaller than a minute of uncompressed
 * WAV. Both matter for different reasons — bytes bound the storage and the upload, seconds bound the *cost*,
 * because audio is billed per second. A deployment that bounded only bytes would have an unbounded bill.
 *
 * Duration is therefore checked where it becomes known: declared by the caller if it knows, and reported by
 * the provider afterwards. `assertWithinBounds` refuses a declared duration over the ceiling before the call;
 * `TranscriptionResult.durationSeconds` is what usage is charged on.
 */

import { AgentPlatformError, type PlatformError } from "../core/errors.js";

/**
 * The media types accepted, and it is a list rather than `audio/*` on purpose.
 *
 * A provider rejects an unknown container with a message about the request, not about the format, so the
 * useful refusal happens here. Every entry is one that the shipped adapters actually accept.
 */
export const AUDIO_MEDIA_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
  "audio/x-m4a",
] as const;
export type AudioMediaType = (typeof AUDIO_MEDIA_TYPES)[number];

export const isAudioMediaType = (mediaType: string): mediaType is AudioMediaType =>
  (AUDIO_MEDIA_TYPES as readonly string[]).includes(mediaType.split(";")[0]?.trim().toLowerCase() ?? "");

/**
 * 25MB, which is where every hosted transcription API this could target draws its own line.
 *
 * Matching the provider's limit rather than inventing a smaller one: a deployment that wants less sets its
 * own, and a ceiling *above* the provider's would just move the failure later and make it theirs to explain.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * One hour.
 *
 * The number is about cost rather than capability. At a typical per-second rate an hour is already a
 * noticeable charge for a single tool call, and a run that transcribes a six-hour recording by accident is the
 * kind of bill nobody notices until the invoice.
 */
export const MAX_AUDIO_SECONDS = 3_600;

/**
 * The transcript ceiling — AC-5.
 *
 * An hour of speech is roughly 9,000 words, which fits. This bounds the *pathological* case: a provider that
 * returns a repeated hallucination on silence, which is a known Whisper failure mode and produces megabytes of
 * one phrase. Truncation is reported, never silent — a shortened transcript that claimed to be complete would
 * make the model summarise a fragment as if it were the whole recording.
 */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/** What speech generation may be asked to say. Bounds the cost the same way the audio ceiling does. */
export const MAX_SPEECH_CHARS = 4_000;

export type AudioBounds = {
  readonly maxBytes?: number;
  readonly maxSeconds?: number;
};

export class AudioRejected extends Error {
  readonly code = "invalid_input" as const;
}

/**
 * Refuses before anything is stored or sent — AC-4.
 *
 * Takes what a caller knows *without reading the file*: the declared byte length and media type from the
 * upload, and a duration if the client measured one. Deliberately not given the bytes: a function that
 * received them would invite reading them, and the whole point is to answer before they move.
 */
export const assertWithinBounds = (
  input: { readonly byteSize: number; readonly mediaType: string; readonly durationSeconds?: number },
  bounds: AudioBounds = {},
): void => {
  const maxBytes = bounds.maxBytes ?? MAX_AUDIO_BYTES;
  const maxSeconds = bounds.maxSeconds ?? MAX_AUDIO_SECONDS;

  if (!isAudioMediaType(input.mediaType)) {
    throw new AudioRejected(
      `${input.mediaType} is not an audio format this deployment accepts. Accepted: ` +
        `${AUDIO_MEDIA_TYPES.join(", ")}.`,
    );
  }
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    throw new AudioRejected("An audio attachment needs a declared size, and it must be greater than zero.");
  }
  if (input.byteSize > maxBytes) {
    throw new AudioRejected(
      `That recording is ${Math.round(input.byteSize / 1024 / 1024)}MB and the limit is ` +
        `${Math.round(maxBytes / 1024 / 1024)}MB. Refused before upload — nothing was stored.`,
    );
  }
  /**
   * Duration only when the caller declared one.
   *
   * Absent is not an error: a browser knows the duration of a recording it just made and a server receiving a
   * file often does not, and demanding it would mean either refusing legitimate uploads or reading the file to
   * find out — which is the thing this function exists to avoid.
   */
  if (input.durationSeconds !== undefined && input.durationSeconds > maxSeconds) {
    throw new AudioRejected(
      `That recording is ${Math.round(input.durationSeconds / 60)} minutes and the limit is ` +
        `${Math.round(maxSeconds / 60)}. Refused before upload — nothing was stored.`,
    );
  }
};

/** A transcript, bounded, with the truncation reported rather than hidden. */
export type TranscriptionResult = {
  readonly text: string;
  /**
   * What usage is charged on — AC-8. Reported by the provider, because only it knows.
   *
   * A provider that does not report it leaves this absent rather than guessing, and the recorder then charges
   * nothing for the audio. That under-bills, which is why the shipped adapter asks for a response format that
   * includes it.
   */
  readonly durationSeconds?: number;
  readonly truncated: boolean;
  /** The provider's own language detection, when it offers one. Not a translation — see the REQ's scope. */
  readonly language?: string;
};

export type TranscriptionRequest = {
  readonly audio: Uint8Array;
  readonly mediaType: string;
  readonly filename?: string;
  /** A hint, not an instruction. A provider free to detect is usually better at it than a caller guessing. */
  readonly languageHint?: string;
  readonly maxTranscriptChars?: number;
};

export interface TranscriptionProvider {
  readonly id: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export type SpeechRequest = {
  readonly text: string;
  /** The provider's own voice identifier. Opaque here: naming a fixed set would date immediately. */
  readonly voice?: string;
  readonly format?: "mp3" | "wav" | "opus" | "flac";
};

export type SpeechResult = {
  readonly audio: Uint8Array;
  readonly mediaType: string;
  /** Absent when the provider does not report it. Charged on when present. */
  readonly durationSeconds?: number;
};

export interface SpeechProvider {
  readonly id: string;
  speak(request: SpeechRequest): Promise<SpeechResult>;
}

/** Bounds a transcript and says whether it had to. */
export const boundTranscript = (
  text: string,
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): { text: string; truncated: boolean } => {
  if (text.length <= maxChars) return { text, truncated: false };
  /**
   * Cut at a word boundary when there is one nearby.
   *
   * A transcript sliced mid-word reads as a transcription error rather than as a truncation, and a model
   * summarising it will occasionally treat the fragment as a real word. The 200-character window is small
   * enough that the ceiling still means what it says.
   */
  const hard = text.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(" ");
  /**
   * `lastSpace > 0` matters, and its absence was a bug the tests caught.
   *
   * `lastIndexOf` returns `-1` when there is no space at all — and `-1 > maxChars - 200` is *true* for any
   * ceiling under 200, so the original condition sliced to `-1` and silently dropped the final character of
   * every space-free transcript. A one-character loss that no assertion about truncation would notice.
   */
  const useBoundary = lastSpace > 0 && lastSpace > maxChars - 200;
  return { text: useBoundary ? hard.slice(0, lastSpace) : hard, truncated: true };
};

/**
 * A provider failure, in the platform's vocabulary — AC-5.
 *
 * Deliberately the same shape and the same distinctions as `describeFetchFailure`: 429 and 5xx retryable,
 * unreachable `provider_unavailable`, everything else terminal. A second vocabulary for audio would mean the
 * runtime's retry logic treated a transcription rate limit differently from a scrape rate limit for no reason
 * anybody chose.
 */
export const describeAudioFailure = (error: unknown, provider: string): PlatformError => {
  if (error instanceof AudioRejected) {
    return { code: "invalid_input", message: error.message, retryable: false };
  }
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return { code: "rate_limited", message: `${provider} is rate limiting: ${message}`, retryable: true };
  }
  if (status === 413) {
    // Not retryable, and worth its own arm: the file is too large and will be next time too.
    return {
      code: "invalid_input",
      message: `${provider} refused the recording as too large: ${message}`,
      retryable: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "unauthorized",
      message: `${provider} refused the credential: ${message}. Retrying will not help.`,
      retryable: false,
    };
  }
  if (status !== undefined && status >= 500) {
    return { code: "provider_unavailable", message: `${provider} returned ${status}: ${message}`, retryable: true };
  }
  if (/timed out|etimedout|abort|fetch failed|econnrefused|enotfound/i.test(message)) {
    return { code: "provider_unavailable", message: `${provider} could not be reached: ${message}`, retryable: true };
  }
  return { code: "provider_error", message: `${provider} could not process the audio: ${message}`, retryable: false };
};

/** Throws the classified failure, for a caller that would rather not branch. */
export const failAudio = (error: unknown, provider: string): never => {
  throw new AgentPlatformError(describeAudioFailure(error, provider));
};
