/**
 * Audio provider conformance — REQ-062 (#257), task #258, AC-7.
 *
 * ## Why this is not in the storage suite
 *
 * AC-7 asks for these ports to be "covered by the conformance suite, consistent with the other 31". The other
 * 31 are the **storage** conformance suite — `conformance/index.ts` says so in its first line, and every
 * harness there is handed a store and asserts persistence semantics: a claim, a lease, a version check, a
 * tenant boundary.
 *
 * A transcription provider is not a store. Adding it to that suite would put a non-storage port in a list whose
 * name and coverage report both say storage, and the next reader would reasonably conclude the audio ports have
 * a durable backing they do not have.
 *
 * So: the same *mechanism* — one shared harness, any adapter must pass it — in its own file, following the
 * precedent `tools-scrape` already set with `CONTRACT_KEYS`. The intent of the AC is that no adapter gets to
 * define its own contract, and that is what this enforces.
 *
 * ## What it can and cannot assert
 *
 * It runs against a **fake** provider by default and against a real one when a caller passes one. That split
 * is deliberate: the contract is about shape and bounds, which a fake can exercise exhaustively and cheaply,
 * while "does Whisper actually transcribe" is a live-call question answered once in `audio-live` rather than on
 * every test run. `#268` is the precedent in the other direction — a *crypto* implementation must be run for
 * real before shipping, because an untested one is worse than none. A transcription adapter that returns the
 * wrong text is visibly wrong; one that silently reports no duration is not, which is why duration is the thing
 * asserted hardest here.
 */

import { describe, expect, it } from "vitest";

import { boundTranscript, MAX_SPEECH_CHARS, MAX_TRANSCRIPT_CHARS } from "../../audio/index.js";
import type { SpeechProvider, TranscriptionProvider } from "../../audio/index.js";

/** Every key a transcription result must carry. A provider cannot quietly return less. */
export const TRANSCRIPTION_CONTRACT_KEYS = ["text", "truncated"] as const;
/** And a speech result. `durationSeconds` is optional on both — absent is a legitimate answer. */
export const SPEECH_CONTRACT_KEYS = ["audio", "mediaType"] as const;

/** A tiny valid-looking payload. No provider here decodes it; the fakes do not, and the real one is not run. */
const SILENCE = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);

export function transcriptionProviderConformance(make: () => TranscriptionProvider): void {
  describe("TranscriptionProvider conformance", () => {
    it("names itself, so a usage record can say which provider ran", () => {
      expect(make().id).toBeTruthy();
    });

    it("returns every contract key", async () => {
      const result = await make().transcribe({ audio: SILENCE, mediaType: "audio/mpeg" });
      for (const key of TRANSCRIPTION_CONTRACT_KEYS) {
        expect(result, `missing ${key}`).toHaveProperty(key);
      }
      expect(typeof result.text).toBe("string");
      expect(typeof result.truncated).toBe("boolean");
    });

    it("reports a duration, because usage is charged on it", async () => {
      /**
       * The assertion that matters most, and the one a provider is most likely to fail quietly.
       *
       * Audio is billed per second. A provider that omits `durationSeconds` makes every transcription cost
       * **nothing** in the ledger — under-billing that scales with usage and shows up as a revenue shortfall
       * rather than as a bug. The OpenAI adapter asks for `verbose_json` specifically to get this field.
       *
       * `undefined` is permitted by the type, because some providers genuinely do not report it — but a
       * provider claiming conformance has to state which it is rather than leaving a caller to find out from an
       * invoice.
       */
      const result = await make().transcribe({ audio: SILENCE, mediaType: "audio/mpeg" });
      if (result.durationSeconds === undefined) {
        // Made loud on purpose: this is a costing decision, not a detail.
        throw new Error(
          "this provider reports no durationSeconds, so its transcriptions will be billed as free. If that is " +
            "correct for it, exclude this case explicitly and say why.",
        );
      }
      expect(result.durationSeconds).toBeGreaterThan(0);
    });

    it("refuses a media type it does not accept, rather than sending it", async () => {
      // The useful refusal happens locally: a provider answers an unknown container with a message about the
      // request, not about the format.
      await expect(
        make().transcribe({ audio: SILENCE, mediaType: "application/zip" }),
      ).rejects.toThrow();
    });

    it("bounds the transcript and reports the truncation", async () => {
      const provider = make();
      const result = await provider.transcribe({
        audio: SILENCE,
        mediaType: "audio/mpeg",
        maxTranscriptChars: 20,
      });
      expect(result.text.length).toBeLessThanOrEqual(20);
      // If it was cut, it must say so. A shortened transcript claiming to be whole would have a model
      // summarise a fragment as if it were the entire recording.
      if (result.text.length === 20) expect(result.truncated).toBe(true);
    });
  });
}

export function speechProviderConformance(make: () => SpeechProvider): void {
  describe("SpeechProvider conformance", () => {
    it("names itself", () => {
      expect(make().id).toBeTruthy();
    });

    it("returns every contract key, with audio as bytes", async () => {
      const result = await make().speak({ text: "hello" });
      for (const key of SPEECH_CONTRACT_KEYS) {
        expect(result, `missing ${key}`).toHaveProperty(key);
      }
      expect(result.audio).toBeInstanceOf(Uint8Array);
      expect(result.audio.byteLength).toBeGreaterThan(0);
      expect(result.mediaType).toMatch(/^audio\//);
    });

    it("refuses empty text rather than producing silence", async () => {
      // A zero-length recording is a bill and a file for nothing, and it reads to a user as a broken player.
      await expect(make().speak({ text: "   " })).rejects.toThrow();
    });

    it("refuses text over the ceiling before the call", async () => {
      // Speech is billed per character, so a runaway prompt is a runaway bill. Refused locally, not by the
      // provider, because the provider's refusal costs the round trip.
      await expect(make().speak({ text: "a".repeat(MAX_SPEECH_CHARS + 1) })).rejects.toThrow();
    });

    it("honours the requested format in the media type it reports", async () => {
      const result = await make().speak({ text: "hello", format: "wav" });
      // Reported, not assumed: a caller storing this as an artifact writes the media type into the file record,
      // and a wrong one makes the browser refuse to play a file that is perfectly good.
      expect(result.mediaType).toBe("audio/wav");
    });
  });
}

/** The transcript bounding, on its own — shared by both suites and worth asserting once. */
export function transcriptBoundingConformance(): void {
  describe("transcript bounding", () => {
    it("leaves a short transcript alone", () => {
      expect(boundTranscript("short")).toEqual({ text: "short", truncated: false });
    });

    it("cuts at a word boundary when one is near the ceiling", () => {
      const text = `${"word ".repeat(20)}finalword`;
      const bounded = boundTranscript(text, 50);
      expect(bounded.truncated).toBe(true);
      // Not mid-word: a sliced word reads as a transcription error rather than as a truncation.
      expect(bounded.text.endsWith(" ")).toBe(false);
      expect(text.startsWith(bounded.text)).toBe(true);
    });

    it("still cuts when there is no word boundary to use", () => {
      const bounded = boundTranscript("a".repeat(200), 50);
      expect(bounded.text).toHaveLength(50);
      expect(bounded.truncated).toBe(true);
    });

    it("defaults to the documented ceiling", () => {
      expect(boundTranscript("x".repeat(MAX_TRANSCRIPT_CHARS + 10)).text).toHaveLength(MAX_TRANSCRIPT_CHARS);
    });
  });
}
