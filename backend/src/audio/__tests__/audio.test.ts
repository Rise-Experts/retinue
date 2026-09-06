/**
 * The audio ports — REQ-062 (#257), task #258, Part 2.
 *
 * The clause earning the most here is AC-4: **bounds before upload.** A rejected 200MB recording must not be
 * stored first, and the natural implementation stores it and then checks — so the test asserts that the
 * refusal happens without any bytes being read, by giving the bounds function no bytes to read.
 *
 * The second is duration. Audio is billed per second, so a provider that omits `durationSeconds` bills every
 * transcription as free. That is a revenue shortfall rather than a visible bug, which is why it is asserted
 * here and again in the conformance harness.
 */
import { describe, expect, it, vi } from "vitest";

import {
  assertWithinBounds,
  AUDIO_MEDIA_TYPES,
  AudioRejected,
  boundTranscript,
  describeAudioFailure,
  isAudioMediaType,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_SPEECH_CHARS,
} from "../index.js";
import type { SpeechProvider, TranscriptionProvider } from "../index.js";
import { openAiSpeech, openAiTranscription } from "../../adapters/audio/openai.js";
import {
  speechProviderConformance,
  transcriptBoundingConformance,
  transcriptionProviderConformance,
} from "../../testing/conformance/audio.js";

const SILENCE = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);

/** A stubbed OpenAI, so the contract runs without a key or a network. */
const stubFetch = (
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch => ((url: string | URL, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch;

const transcriptionStub = (over: Record<string, unknown> = {}) =>
  openAiTranscription({
    apiKey: "sk-test",
    fetchImpl: stubFetch(() =>
      Response.json({ text: "the quick brown fox", duration: 2.66, language: "english", ...over }),
    ),
  });

const speechStub = () =>
  openAiSpeech({
    apiKey: "sk-test",
    fetchImpl: stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { response_format?: string };
      const type = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac" }[
        body.response_format ?? "mp3"
      ];
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": type ?? "audio/mpeg" } });
    }),
  });

describe("bounds are enforced before the upload — AC-4", () => {
  it("refuses an oversized recording without being given the bytes", () => {
    /**
     * The shape is the assertion. `assertWithinBounds` takes a *declared* size and never receives the audio, so
     * it cannot store or read it — which is what makes "before upload" structural rather than a promise about
     * call order.
     */
    expect(() => assertWithinBounds({ byteSize: MAX_AUDIO_BYTES + 1, mediaType: "audio/mpeg" })).toThrow(
      /Refused before upload — nothing was stored/,
    );
  });

  it("refuses a recording longer than the ceiling", () => {
    expect(() =>
      assertWithinBounds({ byteSize: 1_000, mediaType: "audio/mpeg", durationSeconds: MAX_AUDIO_SECONDS + 1 }),
    ).toThrow(/Refused before upload/);
  });

  it("accepts an upload that declares no duration", () => {
    /**
     * Absent is not an error. A browser knows the duration of a recording it just made; a server receiving a
     * file usually does not, and demanding it would mean either refusing legitimate uploads or reading the file
     * to find out — the thing this function exists to avoid.
     */
    expect(() => assertWithinBounds({ byteSize: 1_000, mediaType: "audio/mpeg" })).not.toThrow();
  });

  it("refuses a media type it does not accept, and names what it does", () => {
    expect(() => assertWithinBounds({ byteSize: 1_000, mediaType: "application/zip" })).toThrow(/Accepted:/);
    // Every declared type is genuinely accepted, so the list in the message is not aspirational.
    for (const mediaType of AUDIO_MEDIA_TYPES) {
      expect(() => assertWithinBounds({ byteSize: 1_000, mediaType }), mediaType).not.toThrow();
    }
  });

  it("tolerates a media type with parameters", () => {
    // `audio/webm;codecs=opus` is what a browser's MediaRecorder actually sends.
    expect(isAudioMediaType("audio/webm;codecs=opus")).toBe(true);
    expect(() => assertWithinBounds({ byteSize: 1_000, mediaType: "audio/webm;codecs=opus" })).not.toThrow();
  });

  it("refuses a zero or nonsense size rather than passing it on", () => {
    for (const byteSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertWithinBounds({ byteSize, mediaType: "audio/mpeg" }), String(byteSize)).toThrow();
    }
  });

  it("honours a deployment's tighter bounds", () => {
    expect(() => assertWithinBounds({ byteSize: 2_000, mediaType: "audio/mpeg" }, { maxBytes: 1_000 })).toThrow();
    expect(() =>
      assertWithinBounds({ byteSize: 100, mediaType: "audio/mpeg", durationSeconds: 60 }, { maxSeconds: 30 }),
    ).toThrow();
  });
});

describe("the transcription adapter", () => {
  it("asks for verbose_json, because that is what carries the duration", async () => {
    /**
     * Asserted on the *request*, not only on the parsed result — AC-8.
     *
     * `response_format: json` returns the text alone, and an adapter that asked for it would make every
     * transcription cost nothing in the ledger. The field is the difference between billing and not, so the
     * test checks the wire rather than trusting the stub to have been asked correctly.
     */
    const sent: FormData[] = [];
    const provider = openAiTranscription({
      apiKey: "sk-test",
      fetchImpl: stubFetch((_url, init) => {
        sent.push(init.body as FormData);
        return Response.json({ text: "hi", duration: 1.5 });
      }),
    });
    await provider.transcribe({ audio: SILENCE, mediaType: "audio/mpeg" });
    expect(sent[0]?.get("response_format")).toBe("verbose_json");
  });

  it("returns the duration and the detected language", async () => {
    const result = await transcriptionStub().transcribe({ audio: SILENCE, mediaType: "audio/mpeg" });
    expect(result.durationSeconds).toBe(2.66);
    expect(result.language).toBe("english");
    expect(result.truncated).toBe(false);
  });

  it("omits duration rather than inventing one when the provider does not report it", async () => {
    const result = await transcriptionStub({ duration: undefined }).transcribe({
      audio: SILENCE,
      mediaType: "audio/mpeg",
    });
    // Absent, not zero and not a guess. A guessed duration is a wrong bill presented as a real one.
    expect(result.durationSeconds).toBeUndefined();
  });

  it("bounds a runaway transcript and reports it", async () => {
    /**
     * The pathological case this ceiling exists for: Whisper repeating a hallucinated phrase on silence, which
     * produces megabytes of one sentence.
     */
    const provider = transcriptionStub({ text: "la ".repeat(100_000) });
    const result = await provider.transcribe({ audio: SILENCE, mediaType: "audio/mpeg", maxTranscriptChars: 100 });
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it("passes a language hint through, and works without one", async () => {
    const sent: FormData[] = [];
    const provider = openAiTranscription({
      apiKey: "sk-test",
      fetchImpl: stubFetch((_url, init) => {
        sent.push(init.body as FormData);
        return Response.json({ text: "hallo", duration: 1 });
      }),
    });
    await provider.transcribe({ audio: SILENCE, mediaType: "audio/mpeg", languageHint: "de" });
    expect(sent[0]?.get("language")).toBe("de");
    await provider.transcribe({ audio: SILENCE, mediaType: "audio/mpeg" });
    // Absent rather than empty: a provider free to detect is usually better at it than a caller guessing.
    expect(sent[1]?.get("language")).toBeNull();
  });
});

describe("the speech adapter", () => {
  it("returns bytes and the media type for the requested format", async () => {
    const result = await speechStub().speak({ text: "hello", format: "wav" });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.mediaType).toBe("audio/wav");
  });

  it("refuses empty text and text over the ceiling, before the call", async () => {
    const calls = vi.fn();
    const provider = openAiSpeech({
      apiKey: "sk-test",
      fetchImpl: stubFetch(() => {
        calls();
        return new Response(new Uint8Array([1]));
      }),
    });
    await expect(provider.speak({ text: "  " })).rejects.toThrow(/nothing to say/);
    await expect(provider.speak({ text: "a".repeat(MAX_SPEECH_CHARS + 1) })).rejects.toThrow(/runaway bill/);
    // Neither reached the provider: refusing after the call costs the round trip and the charge.
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("failures are classified like every other provider's — AC-5", () => {
  const cases: readonly [number | undefined, string, boolean][] = [
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [413, "invalid_input", false],
    [400, "provider_error", false],
  ];

  it.each(cases)("status %s → %s (retryable: %s)", (status, code, retryable) => {
    const error = Object.assign(new Error("boom"), status === undefined ? {} : { status });
    const described = describeAudioFailure(error, "openai");
    expect(described.code).toBe(code);
    expect(described.retryable).toBe(retryable);
  });

  it("treats an unreachable provider as retryable", () => {
    for (const message of ["fetch failed", "The operation timed out", "ECONNREFUSED", "getaddrinfo ENOTFOUND"]) {
      const described = describeAudioFailure(new Error(message), "openai");
      expect(described.code, message).toBe("provider_unavailable");
      expect(described.retryable, message).toBe(true);
    }
  });

  it("keeps a local refusal terminal", () => {
    // A file this deployment will not accept is not going to become acceptable on a retry.
    const described = describeAudioFailure(new AudioRejected("too big"), "openai");
    expect(described.code).toBe("invalid_input");
    expect(described.retryable).toBe(false);
  });

  it("classifies a real 429 from the adapter, not just a synthetic error", async () => {
    // End to end through the adapter, so the status actually survives the fetch wrapper.
    const provider = openAiTranscription({
      apiKey: "sk-test",
      fetchImpl: stubFetch(() => new Response("slow down", { status: 429 })),
    });
    await expect(provider.transcribe({ audio: SILENCE, mediaType: "audio/mpeg" })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });
});

// The shared contract, run against the stubbed adapters — AC-7.
transcriptionProviderConformance(() => transcriptionStub() as TranscriptionProvider);
speechProviderConformance(() => speechStub() as SpeechProvider);
transcriptBoundingConformance();

describe("boundTranscript on its own", () => {
  it("is exported so a provider that does its own bounding uses the same rule", () => {
    // One implementation, so two adapters cannot disagree about where a transcript ends.
    expect(boundTranscript("abc", 2).text).toBe("ab");
  });
});
