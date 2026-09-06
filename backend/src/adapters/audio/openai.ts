/**
 * OpenAI transcription and speech — REQ-062 (#257), task #258, AC-5 and AC-6.
 *
 * One adapter each, which is what the ACs ask for. Written against the HTTP API rather than through the AI SDK
 * because the SDK's audio surface is narrower than the endpoints are: `verbose_json` carries the **duration**,
 * and duration is what usage is charged on. An adapter that could not report it would under-bill silently,
 * which AC-8 names as the failure to avoid.
 *
 * ## Where this lives, and why it is exempt from two audits
 *
 * `adapters/audio/`, beside `adapters/embeddings/openai.ts`, which is the same shape: an **operator-configured**
 * provider endpoint that a model never names. Both audits that fire on this file — the raw `apiKey` field and
 * the direct `fetch` — are exempted for that adapter with that reason, and this is exempted alongside it rather
 * than by loosening either check.
 *
 * ## Credentials come in, never out of the environment
 *
 * The same rule every toolkit follows: a provider that read `process.env` could serve one tenant, whoever
 * booted the process. The key is a constructor argument, and a deployment resolves it however it resolves the
 * rest.
 */

import { AudioRejected, boundTranscript, failAudio, isAudioMediaType, MAX_SPEECH_CHARS } from "../../audio/index.js";
import type {
  SpeechProvider,
  SpeechRequest,
  SpeechResult,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from "../../audio/index.js";

export type OpenAiAudioConfig = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** `whisper-1` is the one every account has. A deployment on a newer model names it. */
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  /** A ceiling on the wait, because a long recording is a long request and the default is none. */
  readonly timeoutMs?: number;
};

const DEFAULT_BASE = "https://api.openai.com/v1";

/** A status carried on the error, so `describeAudioFailure` can classify it. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const extensionFor = (mediaType: string): string => {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    {
      "audio/mpeg": "mp3",
      "audio/mp4": "mp4",
      "audio/x-m4a": "m4a",
      "audio/wav": "wav",
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/flac": "flac",
    }[base] ?? "bin"
  );
};

const send = async (
  config: OpenAiAudioConfig,
  path: string,
  body: FormData | string,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  /**
   * A timeout, because the default is none.
   *
   * The eval harness lost 35 minutes of a paid run to a `fetch` with no timeout, and a transcription request
   * is longer-lived than most — so the omission would be less visible here and cost more.
   */
  const signal = AbortSignal.timeout(config.timeoutMs ?? 120_000);
  const response = await fetchImpl(`${(config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, ...headers },
    body,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new HttpError(response.status, detail.slice(0, 400) || response.statusText);
  }
  return response;
};

export const openAiTranscription = (config: OpenAiAudioConfig): TranscriptionProvider => ({
  id: "openai",
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    // Checked here as well as at the boundary: this provider can be called directly, and a media type the API
    // rejects produces a message about the request rather than about the format.
    if (!isAudioMediaType(request.mediaType)) {
      failAudio(new AudioRejected(`${request.mediaType} is not an audio format this adapter accepts.`), "openai");
    }

    const form = new FormData();
    form.set(
      "file",
      new Blob([request.audio as unknown as BlobPart], { type: request.mediaType }),
      request.filename ?? `audio.${extensionFor(request.mediaType)}`,
    );
    form.set("model", config.model ?? "whisper-1");
    /**
     * `verbose_json`, for the duration — AC-8.
     *
     * `json` returns the text alone. Audio is billed per second, so an adapter that asked for `json` would
     * make every transcription cost nothing in the ledger: the recorder charges on `durationSeconds`, and
     * absent means zero. That is the silent revenue hole the AC names, and this one field is the difference.
     */
    form.set("response_format", "verbose_json");
    if (request.languageHint !== undefined) form.set("language", request.languageHint);

    try {
      const response = await send(config, "/audio/transcriptions", form);
      const payload = (await response.json()) as {
        text?: unknown;
        duration?: unknown;
        language?: unknown;
      };
      const bounded = boundTranscript(
        typeof payload.text === "string" ? payload.text : "",
        request.maxTranscriptChars,
      );
      return {
        text: bounded.text,
        truncated: bounded.truncated,
        ...(typeof payload.duration === "number" ? { durationSeconds: payload.duration } : {}),
        ...(typeof payload.language === "string" ? { language: payload.language } : {}),
      };
    } catch (error) {
      return failAudio(error, "openai");
    }
  },
});

export const openAiSpeech = (config: OpenAiAudioConfig & { readonly voice?: string }): SpeechProvider => ({
  id: "openai",
  async speak(request: SpeechRequest): Promise<SpeechResult> {
    const text = request.text.trim();
    if (text === "") failAudio(new AudioRejected("There is nothing to say — the text is empty."), "openai");
    if (text.length > MAX_SPEECH_CHARS) {
      failAudio(
        new AudioRejected(
          `That is ${text.length} characters and the limit is ${MAX_SPEECH_CHARS}. Refused before the call, ` +
            "because speech is billed per character and a runaway prompt is a runaway bill.",
        ),
        "openai",
      );
    }

    const format = request.format ?? "mp3";
    try {
      const response = await send(
        config,
        "/audio/speech",
        JSON.stringify({
          model: config.model ?? "tts-1",
          input: text,
          voice: request.voice ?? config.voice ?? "alloy",
          response_format: format,
        }),
        { "content-type": "application/json" },
      );
      const audio = new Uint8Array(await response.arrayBuffer());
      return {
        audio,
        mediaType: { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac" }[format],
        /**
         * No duration. The endpoint does not report one, and computing it would mean decoding the audio —
         * so it is absent rather than guessed, and speech is charged per character instead. Stated because an
         * absent field that looked like an oversight would invite somebody to estimate it.
         */
      };
    } catch (error) {
      return failAudio(error, "openai");
    }
  },
});
