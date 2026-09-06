/**
 * Audio, wired into the reference app — REQ-062 (#257), task #258, AC-11.
 *
 * The AC is blunt about why this file exists: *"given the eight-instance history of built-and-unreachable
 * features here, a backend-only landing does not count as done."* The ports, the adapters and the two tools all
 * pass their own tests and would reach nothing without this.
 *
 * ## The whole path, in one place
 *
 * - **Attachment in.** A recording uploaded through the app's file service, read back through the *authorized*
 *   read path — not the content store directly, so a principal cannot transcribe a file they cannot open.
 * - **Transcript out.** `transcribe` over a `TranscriptionProvider`.
 * - **Speech artifact back.** `speech_generate` writes through the same file service, so a generated recording
 *   is an ordinary file: same retention, same authorization, same deletion. `docs/18` applies unchanged, which
 *   is AC-3's requirement of "no new blob path".
 *
 * ## Wiring is the toggle, again
 *
 * No key, no tools — the rule `toolkits.ts` follows. A `transcribe` that always answered "not configured" would
 * cost the model a turn to discover and read like a broken integration.
 */

import { openAiSpeech, openAiTranscription } from "@retinue/agentkit/runtime";
import type { SpeechProvider, TranscriptionProvider } from "@retinue/agentkit/runtime";
import type { ConversationId, ExecutionContext, FileId } from "@retinue/agentkit";
import type { AudioToolDeps } from "@retinue/agentkit/tools";

/** The environment, narrowed to what this file reads. */
export type AudioEnv = Readonly<Record<string, string | undefined>>;

/**
 * The providers, when a key is configured.
 *
 * The transcription model and the speech model are named separately: a deployment may want `whisper-1` for one
 * and `tts-1-hd` for the other, and a single `model` would make that impossible to express.
 */
export const audioProvidersFrom = (
  env: AudioEnv,
  fetchImpl?: typeof fetch,
): { transcription?: TranscriptionProvider; speech?: SpeechProvider } => {
  const apiKey = env.RETINUE_AUDIO_API_KEY ?? env.RETINUE_MODEL_API_KEY;
  if (apiKey === undefined || apiKey === "") return {};
  const wiring = fetchImpl === undefined ? {} : { fetchImpl };
  return {
    transcription: openAiTranscription({
      apiKey,
      ...(env.RETINUE_TRANSCRIPTION_MODEL === undefined ? {} : { model: env.RETINUE_TRANSCRIPTION_MODEL }),
      ...(env.RETINUE_AUDIO_BASE_URL === undefined ? {} : { baseUrl: env.RETINUE_AUDIO_BASE_URL }),
      ...wiring,
    }),
    speech: openAiSpeech({
      apiKey,
      ...(env.RETINUE_SPEECH_MODEL === undefined ? {} : { model: env.RETINUE_SPEECH_MODEL }),
      ...(env.RETINUE_SPEECH_VOICE === undefined ? {} : { voice: env.RETINUE_SPEECH_VOICE }),
      ...(env.RETINUE_AUDIO_BASE_URL === undefined ? {} : { baseUrl: env.RETINUE_AUDIO_BASE_URL }),
      ...wiring,
    }),
  };
};

/** Collects an async iterable of chunks into one buffer. The file service reads as a stream. */
const collect = async (chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/**
 * `readFile` and `writeAudio`, over the app's own file service.
 *
 * Bound to one execution context, because that is what makes the authorization real: `files.get` and
 * `files.read` both consult the policy, so a tool cannot reach a recording its caller could not open. A version
 * of this taking the content store directly would work and would be a hole.
 */
export const audioToolDeps = (
  files: {
    get(context: ExecutionContext, id: FileId): Promise<{ mediaType: string; byteSize: number; filename: string }>;
    read(context: ExecutionContext, id: FileId): Promise<AsyncIterable<Uint8Array>>;
    upload(
      context: ExecutionContext,
      input: {
        conversationId: ConversationId;
        filename: string;
        mediaType: string;
        declaredBytes: number;
        bytes: AsyncIterable<Uint8Array>;
      },
    ): Promise<{ id: FileId }>;
  },
  context: ExecutionContext,
): AudioToolDeps => ({
  async readFile(fileId) {
    const id = fileId as unknown as FileId;
    const metadata = await files.get(context, id);
    return {
      bytes: await collect(await files.read(context, id)),
      mediaType: metadata.mediaType,
      filename: metadata.filename,
      byteSize: metadata.byteSize,
    };
  },
  async writeAudio(input) {
    /**
     * Stored through `upload`, so generated speech is an ordinary file.
     *
     * That is AC-3's "no new blob path" and it is not a convenience: retention, authorization and deletion all
     * hang off the file record, and a generated recording written straight to the content store would be
     * invisible to every one of them — a file nobody can find and nobody deletes.
     */
    if (context.conversationId === undefined) {
      throw new Error("speech_generate needs a conversation to attach the recording to.");
    }
    const stored = await files.upload(context, {
      conversationId: context.conversationId,
      filename: input.filename,
      mediaType: input.mediaType,
      declaredBytes: input.bytes.byteLength,
      // eslint-disable-next-line require-yield
      bytes: (async function* () {
        yield input.bytes;
      })(),
    });
    return { fileId: String(stored.id) };
  },
});
