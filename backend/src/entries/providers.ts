/**
 * `@retinue/agentkit/providers` — the model-provider factory, and the embedded facade that uses it.
 *
 * Its own entry because it statically imports six `@ai-sdk/*` packages, and those are **optional peers**: a
 * consumer who uses OpenAI should not have to install Anthropic, Azure, Google and Mistral to import the
 * runtime. Reaching them from the package root would have made that impossible.
 *
 * `createAgent` lives here rather than in the root for the same reason. It is the quickstart — "give me an API
 * key and go" — and that convenience is exactly what needs a provider SDK. Someone composing the runtime
 * themselves never calls it and never installs one.
 */

export * from "../models/provider-factory.js";
export * from "../agents/agent.js";
