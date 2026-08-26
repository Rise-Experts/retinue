/**
 * `@retinue/agentkit`
 *
 * The root is the **semver boundary** (REQ-040): what is exported here is API, and what is not exported here
 * cannot be broken. That is why there are five values on it rather than three hundred and ninety-two.
 *
 * ## The rule
 *
 * **The root exports what a host uses on its first day; everything else is behind a documented subpath.**
 *
 * The root used to be every `create*` in the package, and nothing in the shape distinguished the four calls a
 * host makes from the three hundred an adapter author makes once. A surface that large is not a promise anyone
 * can keep: every name on it is something we cannot remove without a major version, including the ones nobody
 * outside this repository has ever called.
 *
 * ## Types stay, and cost nothing
 *
 * Every type in the package is still exported from here, by `export type *` — which emits no import at all, so
 * the root's runtime weight is unchanged (`ai` and `zod`, asserted by `root-import-weight.test.ts`). Types could
 * not be subpathed without making the package unusable: a consumer holding an `ExecutionContext` should not have
 * to know which layer defined it, and a type cannot be broken by being imported.
 *
 * So the split is: **types by subject, values by consumer**.
 *
 * ## Where everything went
 *
 * | Subpath | Who calls it |
 * |---|---|
 * | `./runtime` | A host composing its own engine rather than taking `createRuntime`'s defaults |
 * | `./tools` | Anyone writing or dispatching a tool, plus the first-party library |
 * | `./persistence` | A host wiring storage, and anything using the in-memory adapters |
 * | `./context` | Prompt assembly, skills, per-principal memory, citations |
 * | `./knowledge` | Retrieval, documents, files, artifacts, export |
 * | `./hitl` | Approvals, questions, authorization |
 * | `./usage` | Spend, quotas, rollups |
 * | `./mcp` | Importing another server's tools |
 * | `./observability` | Telemetry, retention, the security review, the harnesses |
 * | `./server` | The reference GraphQL host, the SSE route, the worker |
 * | `./providers` | The model providers |
 * | `./adapters/{postgres,redis,bullmq,otel}` | One driver each |
 */

export type * from "./core/index.js";
export type * from "./capabilities/index.js";
export type * from "./capabilities/runtime.js";
export type * from "./models/index.js";
export type * from "./agents/index.js";
export type * from "./runtime/index.js";
export type * from "./tools/index.js";
export type * from "./tools/library/index.js";
export type * from "./toolkit/index.js";
export type * from "./mcp/index.js";
export type * from "./authorization/index.js";
export type * from "./usage/index.js";
export type * from "./idempotency/index.js";
export type * from "./skills/index.js";
export type * from "./context/index.js";
export type * from "./hitl/index.js";
export type * from "./persistence/index.js";
export type * from "./adapters/memory/index.js";
export type * from "./worker/main.js";
export type * from "./worker/extraction.js";
export type * from "./worker/export.js";
export type * from "./principal-memory/index.js";
export type * from "./files/index.js";
export type * from "./files/context.js";
export type * from "./files/read-tool.js";
export type * from "./documents/index.js";
export type * from "./artifacts/index.js";
export type * from "./export/index.js";
export type * from "./export/pdf.js";
export type * from "./export/markdown.js";
export type * from "./knowledge/index.js";
export type * from "./citations/index.js";
export type * from "./evaluation/index.js";
export type * from "./telemetry/index.js";
export type * from "./security/index.js";
export type * from "./retention/index.js";
export type * from "./loadtest/index.js";
export type * from "./graphql/index.js";

/**
 * The five.
 *
 * - `createRuntime` composes one and gates access to what was actually wired.
 * - `resolveCapabilities` is how a host declares what it enables, and is cross-checked against the wiring in
 *   both directions — a capability declared and unwired is as much a bug as one wired and undeclared.
 * - `defineAgent` declares the agent. `defineTool` is deliberately *not* here: an agent is the thing you
 *   declare, a tool is a component of one, and everything about tools is at `./tools`.
 * - `asId` builds a branded id. Every other export takes one, so a consumer that could not build one would be
 *   reduced to casting — which is opting out of the guarantee for everybody downstream.
 * - `AgentPlatformError` and its guard are what a consumer catches. An error class reachable only by subpath
 *   means a `catch` block importing from somewhere the happy path never mentions.
 */
export { createRuntime } from "./capabilities/runtime.js";
export { resolveCapabilities } from "./capabilities/index.js";
export { defineAgent } from "./agents/define.js";
export { asId } from "./core/ids.js";
export { AgentPlatformError, isAgentPlatformError } from "./core/errors.js";
