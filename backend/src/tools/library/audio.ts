/**
 * `transcribe` and `speech_generate` — REQ-062 (#257), task #258, AC-9.
 *
 * ## These are library tools, not a `tools-media` package — a deviation from `docs/23`
 *
 * The catalogue assigns both to a `tools-media` sibling package. That assignment predates the provider-port
 * pattern being settled, and following it now would put these in the wrong place for a reason worth recording.
 *
 * A sibling package exists for a **vendor**: `tools-github` wraps GitHub's API, and a change to that API is a
 * patch to one small package rather than a platform release. Neither of these tools wraps a vendor. They take a
 * `TranscriptionProvider` and a `SpeechProvider` — ports — exactly as `web_search` takes a `SearchProvider`
 * and lives right here in the library for that reason.
 *
 * Putting them in a package would mean the package had no vendor in it: Whisper, Deepgram and a self-hosted
 * `whisper.cpp` are values of a parameter, and a `tools-media` that shipped no vendor code would be a folder
 * whose only content is two thin wrappers over runtime ports. `docs/23`'s row is updated rather than obeyed.
 *
 * The other two tools that row names — `image_generate` and `video_generate` — are out of REQ-062's scope and
 * unaffected by this. If they arrive as vendor integrations, a `tools-media` package is the right home for
 * *them*.
 *
 * ## The effects, and why `speech_generate` is not an external write
 *
 * `transcribe` is a `read`: it looks at a recording and returns text, changes nothing, and notifies nobody.
 *
 * `speech_generate` is an `internal-write` because it **creates a file the tenant owns**. Nothing leaves the
 * deployment and nobody else sees it, which is what separates `internal-write` from `external-write` — the
 * distinction #228 settled. It costs money, which is why it is not a `read`, and the cost is bounded by the
 * character ceiling rather than by an approval.
 */

import { z } from "zod";

import { AgentPlatformError } from "../../core/errors.js";
import { assertWithinBounds, MAX_SPEECH_CHARS, type AudioBounds } from "../../audio/index.js";
import type { SpeechProvider, TranscriptionProvider } from "../../audio/index.js";
import { defineDelegatingTool, type DelegatingToolDeps } from "../delegating.js";
import type { Tool } from "../index.js";

const transcribeSchema = z.object({
  /**
   * A file id, never bytes and never a URL.
   *
   * Bytes in a tool argument would mean a base64 recording inside the model's context — expensive, and it would
   * arrive having bypassed the upload bounds entirely. A URL would make this a fetch tool with an SSRF surface.
   * An id goes through the mediated read path, so authorization applies and the bounds were checked at upload.
   */
  fileId: z.string().min(1).describe("The id of an uploaded audio file."),
  languageHint: z
    .string()
    .min(2)
    .max(8)
    .optional()
    .describe("A BCP-47 language tag, if you already know it. Leave it out to let the provider detect."),
});

const speechSchema = z.object({
  text: z.string().min(1).max(MAX_SPEECH_CHARS).describe("What to say. Plain text."),
  voice: z.string().min(1).max(64).optional().describe("The provider's voice name, if the deployment offers a choice."),
  format: z.enum(["mp3", "wav", "opus", "flac"]).optional(),
});

/** What the tool needs in order to read an uploaded file and write a generated one. */
export type AudioToolDeps = {
  /**
   * Reads an uploaded file's bytes **through the authorized path**.
   *
   * A function rather than a store, because the tool must not be able to reach a file the principal cannot:
   * the host supplies a reader already scoped to the execution context, which is the same arrangement the
   * attachment bridge uses.
   */
  readonly readFile: (fileId: string) => Promise<{
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly filename?: string;
    readonly byteSize: number;
  }>;
  /** Stores generated audio and returns what a client needs to play it. */
  readonly writeAudio: (input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly filename: string;
  }) => Promise<{ readonly fileId: string; readonly url?: string }>;
  readonly bounds?: AudioBounds;
};

export const createTranscribeTool = (
  deps: DelegatingToolDeps,
  provider: TranscriptionProvider,
  audio: AudioToolDeps,
): Tool =>
  defineDelegatingTool(deps, {
    name: "transcribe",
    label: "Transcribe a recording",
    description:
      "Turn an uploaded audio file into text. Give it the file's id. Returns the transcript, the detected " +
      "language and the duration. If `truncated` is true the recording was longer than the transcript limit " +
      "and you are reading only the beginning — say so rather than summarising it as the whole thing.",
    category: "media",
    effect: "read",
    inputSchema: transcribeSchema,
    delegatesTo: "audio.TranscriptionProvider",
    delegate: async (input: z.infer<typeof transcribeSchema>) => {
      const file = await audio.readFile(input.fileId);
      /**
       * Bounds checked again here, and that is not redundant.
       *
       * The upload path checks what a client *declared*; this checks what was actually stored. A file that grew
       * past the ceiling, or one uploaded before a deployment tightened its bounds, would otherwise reach the
       * provider — and the provider's refusal costs the round trip and names the request rather than the size.
       */
      try {
        assertWithinBounds({ byteSize: file.byteSize, mediaType: file.mediaType }, audio.bounds);
      } catch (error) {
        throw new AgentPlatformError({
          code: "invalid_input",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }

      const result = await provider.transcribe({
        audio: file.bytes,
        mediaType: file.mediaType,
        ...(file.filename === undefined ? {} : { filename: file.filename }),
        ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      });
      return {
        text: result.text,
        truncated: result.truncated,
        ...(result.durationSeconds === undefined ? {} : { durationSeconds: result.durationSeconds }),
        ...(result.language === undefined ? {} : { language: result.language }),
        // Reported so a summary of what happened can name the provider rather than implying the platform did it.
        provider: provider.id,
      };
    },
  });

export const createSpeechGenerateTool = (
  deps: DelegatingToolDeps,
  provider: SpeechProvider,
  audio: AudioToolDeps,
): Tool =>
  defineDelegatingTool(deps, {
    name: "speech_generate",
    label: "Say something aloud",
    description:
      "Turn text into an audio file the user can play. Returns a file id. This costs money per character, so " +
      "say what needs saying rather than reading a whole document aloud. Requires approval by policy.",
    category: "media",
    // Creates a file the tenant owns; nothing leaves the deployment. See the header on why not external-write.
    effect: "internal-write",
    /**
     * `policy`, set explicitly — and the explicitness is the point.
     *
     * `internal-write` *derives* `never`, which is right for the writes that motivated that default: a note
     * saved to the tenant's own store costs nothing and asking about it would be noise. This one costs money
     * per character, so a deployment should be able to decide whether an agent may spend it unattended.
     *
     * `policy` rather than `always` because the amount is small and bounded by the character ceiling — a
     * mandatory click on every sentence would make the tool unusable, and `docs/23` specifies `policy` for
     * exactly this reason.
     */
    approvalPolicy: "policy",
    inputSchema: speechSchema,
    delegatesTo: "audio.SpeechProvider",
    delegate: async (input: z.infer<typeof speechSchema>) => {
      const spoken = await provider.speak({
        text: input.text,
        ...(input.voice === undefined ? {} : { voice: input.voice }),
        ...(input.format === undefined ? {} : { format: input.format }),
      });
      const extension = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "opus", "audio/flac": "flac" }[
        spoken.mediaType
      ];
      const stored = await audio.writeAudio({
        bytes: spoken.audio,
        mediaType: spoken.mediaType,
        // Named from the text so a list of generated files is readable, and bounded so a long prompt does not
        // become a 4,000-character filename.
        filename: `speech-${input.text.slice(0, 40).replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || "audio"}.${extension ?? "bin"}`,
      });
      return {
        fileId: stored.fileId,
        ...(stored.url === undefined ? {} : { url: stored.url }),
        mediaType: spoken.mediaType,
        byteSize: spoken.audio.byteLength,
        ...(spoken.durationSeconds === undefined ? {} : { durationSeconds: spoken.durationSeconds }),
        characters: input.text.length,
        provider: provider.id,
      };
    },
  });
