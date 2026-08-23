/**
 * Image description through a vision-capable model (#132).
 *
 * Lives in `models/` because boundary rule R3 keeps the Vercel AI SDK here: the layers above call
 * `describeImage` and never see the SDK, exactly as they call `streamModelTurn` and never see `streamText`.
 *
 * **The capability check is not in this file, and that is the design.** `ModelRegistry.resolve` already
 * refuses when no model satisfies `requiredModalities: ["image"]` — it throws `capability_unavailable`. So
 * AC-3 ("a model without vision capability is never used for an image request") holds because the caller
 * cannot *obtain* a model to pass here, not because this function checks one. A check here would be a second
 * gate to keep in step with the first, and the weaker of the two would be the one that mattered.
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { AgentPlatformError } from "../core/errors.js";
import type { NeutralUsage } from "./streaming.js";

/** The prompt a description is produced against. Injectable, because what matters differs by caller. */
export const DEFAULT_VISION_PROMPT =
  "Describe this image for someone who cannot see it. State what it shows, transcribe any text exactly as " +
  "it appears, and describe any chart's axes and values. Do not speculate about anything not visible.";

export type DescribeImageRequest = {
  readonly model: LanguageModel;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly prompt?: string;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
};

export type DescribeImageResult = {
  readonly text: string;
  readonly usage: NeutralUsage;
  readonly modelId: string;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One vision call, returning the description and its token usage.
 *
 * The usage comes back rather than being recorded here: this module has no `ExecutionContext` and no
 * `UsageRecorder`, and reaching for either would put a billing decision inside a provider call. The caller
 * records it, which is also what makes the record idempotent on the *extraction*, not on the HTTP request.
 */
export const describeImage = async (req: DescribeImageRequest): Promise<DescribeImageResult> => {
  const content: ModelMessage["content"] = [
    { type: "text", text: req.prompt ?? DEFAULT_VISION_PROMPT },
    // The SDK takes the bytes and the media type; it decides per provider whether that becomes a base64
    // data part or an upload. Passing a URL instead would mean a signed URL in a provider request, which is
    // the thing #129 clamps to fifteen minutes precisely to avoid.
    { type: "image", image: req.bytes, mediaType: req.mediaType },
  ] as ModelMessage["content"];

  try {
    const result = await generateText({
      model: req.model,
      messages: [{ role: "user", content } as ModelMessage],
      ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    });
    const usage = result.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
    return {
      text: result.text,
      usage: {
        inputTokens: num(usage?.inputTokens),
        outputTokens: num(usage?.outputTokens),
        cachedInputTokens: num(usage?.cachedInputTokens),
      },
      modelId: typeof req.model === "string" ? req.model : ((req.model as { modelId?: string }).modelId ?? "unknown"),
    };
  } catch (error) {
    // Wrapped so a provider's error shape does not reach the extraction pipeline, which would then have to
    // know about three SDKs to decide whether a failure is retryable.
    throw new AgentPlatformError(
      {
        code: "provider_unavailable",
        message: "The vision model could not describe that image.",
        retryable: true,
      },
      { cause: error },
    );
  }
};
