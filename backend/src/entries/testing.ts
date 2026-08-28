/**
 * `@retinue/agentkit/testing` — the conformance suite and the fakes — task #253.
 *
 * The README's headline claim is *"Replaceable everything — 31 ports, three adapter families, one conformance
 * suite held over all of them."* A consumer who took that invitation and wrote a fourth adapter family could not
 * run the suite: it lived in `src/testing/`, which the build excluded and no export reached. The most valuable
 * thing in the repository for anyone doing that was the one thing they could not have.
 *
 * ## Two audiences, one entry
 *
 * - **Implementing a port.** `<port>Conformance` runs the same contract tests the built-in families are held to.
 *   That is what makes "replaceable" checkable rather than an invitation.
 * - **Implementing an agent or a tool.** `createStubModel` and `createMemoryStores` are for a test that must not
 *   call a provider or stand up a database.
 *
 * ## Why the test runner is an optional peer
 *
 * The harnesses call `describe`/`it`/`expect` at module scope, so importing this pulls `vitest`. It is an
 * **optional peer dependency**, not a dependency: a consumer who never imports this subpath never installs it,
 * and nothing in a production bundle can reach it — the only paths to these modules are through this entry.
 * `@electric-sql/pglite` is optional for the same reason, and only `pgliteExecutor` needs it.
 */

export * from "../testing/conformance/index.js";
export * from "../testing/stub-model.js";
export * from "../testing/memory-backend.js";
export * from "../testing/pglite.js";
