/**
 * `@retinue/agentkit/tools` — the first-party tool library, and the deterministic functions behind it.
 *
 * A subpath rather than the package root for the reason every subpath here exists: the root is the semver
 * boundary and should stay small (#199). It needs no optional peer — the tools reach the network through the
 * platform's own egress policy and the global `fetch`, so installing this costs nothing beyond what the runtime
 * already installs.
 *
 * Both halves are exported. The envelopes are what a host registers; the `toolkit/` functions are what an
 * application calls directly when it wants the behaviour without the tool — reading a URL under the same egress
 * policy from its own code, say, rather than through a model.
 */
export * from "../tools/library/index.js";
export * from "../toolkit/index.js";
