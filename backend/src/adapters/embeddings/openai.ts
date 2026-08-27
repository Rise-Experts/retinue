/**
 * An OpenAI-compatible embedding adapter — REQ-050 (#209), task #219.
 *
 * The `EmbeddingProvider` port has existed since #136 with **no adapter of any kind**, which means the semantic
 * half of hybrid retrieval has never run against a real model in this repository: every test supplies a stub, and
 * a stub measures the stub. That is why this exists before the eval does — a retrieval score computed over
 * hash-based pseudo-vectors is a number about nothing.
 *
 * OpenAI's shape rather than OpenAI specifically: the same request works against Azure OpenAI, Together, a local
 * `llama.cpp` server and anything else that copied the endpoint, so `baseUrl` is the whole configuration story.
 *
 * ## Two properties worth stating
 *
 * **Order is checked, not assumed.** The API returns objects carrying an `index`, and the port's contract is one
 * vector per input *in order*. A provider that returned them out of order — or dropped one — would silently pair
 * every chunk with its neighbour's vector, and retrieval would still work well enough to look fine. So the
 * response is sorted by `index` and the count is verified.
 *
 * **The model reference records a version.** Providers change what a model id returns without renaming it, and a
 * corpus embedded across such a change has two incomparable halves. The port carries the ref per chunk precisely
 * so that is detectable; this passes the caller's version through rather than inventing one.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { EmbeddingProvider } from "../../knowledge/index.js";
import type { EmbeddingModelRef } from "../../persistence/index.js";

/** What the vendor's endpoint returns, narrowed to what is read. */
type EmbeddingResponse = {
  readonly data?: readonly { readonly index?: number; readonly embedding?: readonly number[] }[];
  readonly error?: { readonly message?: string };
};

export type OpenAiEmbeddingsConfig = {
  readonly apiKey: string;
  /** Defaults to `text-embedding-3-small`, which is 1536 dimensions — the platform's `EMBEDDING_DIMENSIONS`. */
  readonly modelId?: string;
  /**
   * The version this deployment is recording for these vectors.
   *
   * Not derivable from the API: OpenAI publishes no version for an embedding model, which is exactly the problem
   * the field exists for. A deployment that re-embeds after noticing a change bumps this itself.
   */
  readonly version?: string;
  readonly dimensions?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Inputs per request. The endpoint accepts many; the ceiling is the request body's size, not a count. */
  readonly batchSize?: number;
  readonly timeoutMs?: number;
};

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_BATCH = 96;

export const createOpenAiEmbeddings = (config: OpenAiEmbeddingsConfig): EmbeddingProvider => {
  const modelId = config.modelId ?? DEFAULT_EMBEDDING_MODEL;
  const model: EmbeddingModelRef = {
    modelId,
    version: config.version ?? "1",
    dimensions: config.dimensions ?? 1536,
  };
  const doFetch = config.fetchImpl ?? fetch;
  const base = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const batchSize = config.batchSize ?? DEFAULT_EMBEDDING_BATCH;

  const embedBatch = async (texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await doFetch(`${base}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          input: texts,
          // Asked for explicitly, because the 3-series models support shortening and a deployment that pinned
          // 1536 in its column must get 1536 rather than whatever the default becomes.
          ...(model.dimensions === 1536 ? {} : { dimensions: model.dimensions }),
        }),
      });
    } catch (error) {
      throw new AgentPlatformError({
        code: (error as Error).name === "AbortError" ? "timeout" : "provider_unavailable",
        message: `The embedding endpoint did not respond: ${(error as Error).message}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as EmbeddingResponse;
    if (!response.ok) {
      const rateLimited = response.status === 429;
      throw new AgentPlatformError({
        code: rateLimited ? "rate_limited" : response.status >= 500 ? "provider_unavailable" : "provider_error",
        message: `The embedding endpoint returned ${response.status}: ${payload.error?.message ?? "no message"}`,
        // A 5xx and a rate limit are worth retrying; a 400 means the request is wrong and will stay wrong.
        retryable: rateLimited || response.status >= 500,
      });
    }

    const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) {
      throw new AgentPlatformError({
        code: "provider_error",
        message: `Asked for ${texts.length} embeddings and received ${data.length}. Pairing them would attach every chunk to the wrong vector.`,
        retryable: false,
      });
    }
    return data.map((entry, at) => {
      const vector = entry.embedding;
      if (vector === undefined || vector.length !== model.dimensions) {
        throw new AgentPlatformError({
          code: "provider_error",
          message: `Embedding ${at} has ${vector?.length ?? 0} dimensions; this deployment records ${model.dimensions}.`,
          retryable: false,
        });
      }
      return vector;
    });
  };

  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out: (readonly number[])[] = [];
      // Sequential batches, deliberately: parallel ones hit the rate limit on a first index of a real corpus,
      // and the failure arrives as a 429 in the middle of a job rather than as a slower job.
      for (let at = 0; at < texts.length; at += batchSize) {
        out.push(...(await embedBatch(texts.slice(at, at + batchSize))));
      }
      return out;
    },
  };
};
