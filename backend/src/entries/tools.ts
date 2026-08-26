/**
 * `@retinue/agentkit/tools` — everything about tools.
 *
 * Three things that used to be in three places:
 *
 * - **Authoring** — `defineTool` and `defineDelegatingTool`, the envelopes that add authorisation, the approval
 *   gate and the idempotency key around a deterministic function.
 * - **Dispatch** — the registry, the catalogue, the meta-tools.
 * - **The library** (#188) — fifteen first-party tools, and the `toolkit/` functions they delegate to.
 *
 * One subpath because they are one subject, and because the alternative — authoring at the root, dispatch behind
 * a subpath — would mean a tool author importing from two places to write one tool. The root keeps `defineAgent`
 * and not `defineTool` for the same reason it keeps `createRuntime`: an agent is the thing you declare, and a
 * tool is a component of one.
 *
 * No optional peer: the tools reach the network through the global `fetch` and the platform's own egress policy.
 */
export * from "../tools/index.js";
export * from "../tools/library/index.js";
export * from "../toolkit/index.js";
