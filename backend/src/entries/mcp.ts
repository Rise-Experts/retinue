/**
 * `@retinue/agentkit/mcp` — importing another server's tools.
 *
 * The client, the provider, the effect classifier and the egress policy. Its own subpath rather than part of
 * `./tools` because the trust story is different: a first-party tool is code in your repository, and an imported
 * one is a contract with a process you do not control — which is why an unclassified remote tool becomes
 * `external-write` rather than `read`.
 */
export * from "../mcp/index.js";
