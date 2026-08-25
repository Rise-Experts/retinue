/**
 * `@agentkit/backend/server` — the reference GraphQL host, and the runnable API and worker commands.
 *
 * A subpath in the same package rather than a package of its own (#196). The runtime still takes **no** HTTP or
 * GraphQL dependency: `graphql`, `graphql-yoga` and `@whatwg-node/server` are optional peers, so a consumer who
 * embeds the runtime in their own server never installs them.
 *
 * What keeps this from quietly merging the two halves is that the boundary is enforced by **path**, not by
 * package. `check-boundaries.mjs` reads directories, and rule R12 refuses any import from the runtime into
 * `src/server/` — so the dependency runs one way, as it did when they were separate packages.
 *
 * The cost, stated because it is real: a server-only fix now bumps the runtime's version, and every consumer
 * sees a release that does not affect them. The changelog has to say which subpath changed.
 */

export * from "../server/index.js";
