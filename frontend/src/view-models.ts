/**
 * `@retinue/react/view-models` — the pure parts, importable from a server — #267.
 *
 * ## Why this subpath exists
 *
 * The root barrel says, of the components: *"`./ui` stays opt-in (it needs React)"*. That claim was already
 * only half true — it re-exports `./hooks/hooks.js`, which imports React as well — and the consequence was
 * found by building the Docker image and running the reference app in it:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'react'
 *         imported from /app/frontend/dist/hooks/hooks.js
 *
 * `examples/src/server.ts` imports four functions from this package — `citationViewModel`, `formatCost`,
 * `formatTokens`, `shapeUsagePanel` — to render server-side HTML. None of them touches React. Importing them
 * through the barrel pulled in the hooks, and therefore React, into a server image installed with
 * `--omit=dev`, where React is not present and has no business being.
 *
 * So: a subpath with nothing in it that imports React. A server renders through this; a browser keeps using
 * the root.
 *
 * ## Why not fix the barrel instead
 *
 * Moving hooks out of the root export is the more correct change and it is a **breaking** one for every
 * consumer importing `useRun` and friends from `@retinue/react`. That belongs in a major, argued on its own,
 * not folded into a compose fix. This is additive: nothing that works today stops working.
 *
 * The barrel's comment has been corrected to say what is actually true.
 */

// Every export here must be free of React, transitively. The test beside this file asserts that by importing
// this module in isolation and failing if the graph reaches `react`.
export * from "./citations.js";
export * from "./usage-panel.js";
export * from "./context-inspector.js";
export * from "./localization.js";
export * from "./types/index.js";
export * from "./event-buffer.js";
export * from "./reducers.js";
