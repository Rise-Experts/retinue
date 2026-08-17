/**
 * Provider factory — `docs/03-intelligence-runtime.md`.
 *
 * Turns a resolved `ModelDefinition` into a concrete Vercel AI SDK language model. The AI SDK
 * imports are confined to this `models` layer (enforced by the dependency-boundary check); the
 * rest of the platform speaks the neutral `ModelDefinition`/`ModelPolicy` contracts.
 *
 * Credentials are supplied per provider (supporting a tenant's BYO keys) and never inlined into
 * a model definition.
 */

import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AgentPlatformError } from "../core/errors.js";
import type { ModelDefinition, ModelProvider } from "./index.js";

/** Per-provider credentials. `apiKey`/`baseURL` fall back to the SDK's env defaults when unset. */
export type ProviderCredentials = {
  readonly apiKey?: string;
  readonly baseURL?: string;
  /** Azure only. */
  readonly resourceName?: string;
  readonly apiVersion?: string;
  /** A display name for OpenAI-compatible endpoints. */
  readonly name?: string;
};

export type ProviderFactoryConfig = {
  readonly credentials?: Partial<Record<ModelProvider, ProviderCredentials>>;
};

export interface ProviderFactory {
  /** The AI SDK language model for a resolved definition, ready for generate/stream. */
  languageModel(model: ModelDefinition): LanguageModel;
}

export const createProviderFactory = (config: ProviderFactoryConfig = {}): ProviderFactory => {
  const cred = (p: ModelProvider): ProviderCredentials => config.credentials?.[p] ?? {};

  return {
    languageModel(model) {
      const c = cred(model.provider);
      switch (model.provider) {
        case "openai":
          return createOpenAI({ apiKey: c.apiKey, baseURL: c.baseURL })(model.modelId);
        case "anthropic":
          return createAnthropic({ apiKey: c.apiKey, baseURL: c.baseURL })(model.modelId);
        case "google":
          return createGoogleGenerativeAI({ apiKey: c.apiKey, baseURL: c.baseURL })(model.modelId);
        case "mistral":
          return createMistral({ apiKey: c.apiKey, baseURL: c.baseURL })(model.modelId);
        case "azure-openai":
          return createAzure({
            apiKey: c.apiKey,
            resourceName: c.resourceName,
            baseURL: c.baseURL,
            apiVersion: c.apiVersion,
          })(model.modelId);
        case "openai-compatible":
          if (!c.baseURL) {
            throw new AgentPlatformError({
              code: "capability_unavailable",
              message: "openai-compatible provider requires a baseURL credential",
              retryable: false,
            });
          }
          return createOpenAICompatible({ name: c.name ?? "openai-compatible", baseURL: c.baseURL, apiKey: c.apiKey })(
            model.modelId,
          );
        case "bedrock":
          // Bedrock wiring (@ai-sdk/amazon-bedrock + AWS credentials) is a follow-up.
          throw new AgentPlatformError({
            code: "capability_unavailable",
            message: "Amazon Bedrock provider is not wired yet",
            retryable: false,
          });
        default: {
          const exhaustive: never = model.provider;
          throw new AgentPlatformError({
            code: "capability_unavailable",
            message: `Unknown provider ${String(exhaustive)}`,
            retryable: false,
          });
        }
      }
    },
  };
};
