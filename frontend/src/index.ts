/**
 * @retinue/react
 *
 * Headless client state for the reusable AI platform. No product styling, no transport
 * assumptions — see `../docs/06-graphql-and-frontend.md`.
 */

export * from "./types/index.js";
export * from "./event-buffer.js";
export * from "./reducers.js";
export * from "./client.js";
export type * from "./hooks/index.js";
/**
 * The hooks, and they import React — so this barrel is **not** React-free, despite the note below.
 *
 * Corrected in #267 rather than left misleading: a server importing anything from this entry gets React in its
 * module graph, which is how the reference app failed to start in the Docker image. `@retinue/react/view-models`
 * is the entry for a server; this one is for a browser.
 *
 * Moving these out of the root would be the more correct fix and a breaking change for every consumer of
 * `useRun`, so it belongs in a major rather than folded into a compose fix.
 */
export * from "./hooks/hooks.js";

export * from "./context-inspector.js";
export * from "./usage-panel.js";
// The citation view model, but not the components — `./ui` stays opt-in. (So does React itself, for a
// browser; see the note on the hooks above for why that is not the same as this entry being React-free.)
export * from "./citations.js";

export * from "./localization.js";
