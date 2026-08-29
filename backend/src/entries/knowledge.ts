/**
 * `@retinue/agentkit/knowledge` — indexed material, documents, files and artifacts.
 *
 * Retrieval, chunking and embeddings; the extraction pipeline; attachments and their read tools; artifacts and
 * the export formats. One subpath because a deployment that has any of these has all of them: an attachment
 * becomes a document becomes chunks becomes a retrieval hit.
 */
export * from "../knowledge/index.js";
export * from "../documents/index.js";
export * from "../files/index.js";
export * from "../files/context.js";
export * from "../files/read-tool.js";
// #185: resolving a stored attachment into a turn part, through the mediated read path.
export * from "../files/turn-parts.js";
export * from "../artifacts/index.js";
export * from "../export/index.js";
export * from "../export/pdf.js";
export * from "../export/markdown.js";

/**
 * The one embedding adapter — REQ-050 (#209), task #219.
 *
 * Here rather than behind an `adapters/*` subpath because it carries no driver: it is a `fetch` to an
 * OpenAI-shaped endpoint, so it adds nothing to a consumer's install. The Postgres and Redis adapters have their
 * own subpaths because they each pull a client library in.
 */
export { DEFAULT_EMBEDDING_BATCH, DEFAULT_EMBEDDING_MODEL, createOpenAiEmbeddings } from "../adapters/embeddings/openai.js";
export type { OpenAiEmbeddingsConfig } from "../adapters/embeddings/openai.js";

/**
 * The extraction prompt, exported so a harness can use the same one the runtime does — task #275.
 *
 * `extractGraph` itself is not exported here: it takes a `LanguageModel` from the AI SDK, and a consumer that
 * wanted it would be pulling a provider package through the knowledge entrypoint. The prompt is the part worth
 * sharing — a measurement run against a *different* prompt is measuring a different system.
 */
export { DEFAULT_EXTRACTION_PROMPT } from "../models/extraction.js";
