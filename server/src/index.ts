/**
 * `@agentkit/server` — the reference GraphQL host for `@agentkit/backend` (#108).
 *
 * A separate workspace on purpose: the library ships SDL plus a thin resolver map and takes no
 * GraphQL-server dependency, so a host can mount it on Yoga, Apollo or Mercurius. This is one host.
 */
export * from "./host.js";
export * from "./main.js";
export * from "./sse-route.js";
