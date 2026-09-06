/**
 * `@retinue/agentkit/runtime` — the engine, agents, models and the run loop.
 *
 * What a host reaches for once it has decided to compose something itself rather than take `createRuntime`'s
 * defaults: the default engine, the model catalogue, the retry policy, the run reducer.
 */
export * from "../runtime/index.js";
export * from "../agents/index.js";
export * from "../models/index.js";
export * from "../capabilities/index.js";
export * from "../capabilities/runtime.js";
export * from "../core/index.js";

/**
 * The audio ports and their OpenAI adapters — REQ-062 (#257).
 *
 * Here rather than in `tools`, because a `TranscriptionProvider` is a runtime capability a host wires once —
 * the same place a `SearchProvider` is chosen. The two tools that use them live in the tool library.
 */
export {
  assertWithinBounds,
  AUDIO_MEDIA_TYPES,
  AudioRejected,
  boundTranscript,
  describeAudioFailure,
  isAudioMediaType,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_SPEECH_CHARS,
  MAX_TRANSCRIPT_CHARS,
} from "../audio/index.js";
export type {
  AudioBounds,
  AudioMediaType,
  SpeechProvider,
  SpeechRequest,
  SpeechResult,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from "../audio/index.js";
export { openAiSpeech, openAiTranscription } from "../adapters/audio/openai.js";
export type { OpenAiAudioConfig } from "../adapters/audio/openai.js";
