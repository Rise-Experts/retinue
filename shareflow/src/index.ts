/**
 * `@retinue/shareflow` — the ShareFlow integration.
 *
 * ShareFlow is the platform's first consumer and stays outside the generic packages (docs/01:
 * *"product-specific names … live only in that application's integration package"*). This package
 * depends on `@retinue/agentkit`; nothing generic depends on it, and R8 in
 * `scripts/check-boundaries.mjs` fails the build if that ever reverses.
 *
 * It contains four things and no application code:
 *
 * - `services/` — the interfaces ShareFlow's publishing, connector, media and database services must
 *   satisfy. Declared here, implemented by ShareFlow, so this package has no import edge to the app.
 * - `tools/` — the provider that serves ShareFlow's capabilities, each one an envelope (#113) over a
 *   service method.
 * - `context/` — the shared section builder for docs/07's context providers.
 *
 * ## "docs/07" in this package
 *
 * Shorthand, used ~50 times below, for the **Retinue integration spec** — the document that names the tool
 * categories, the context providers and the numbered workflows this package implements. It was
 * `docs/07-shareflow-integration.md` in the retinue repository and now lives in `social_integgration` as
 * `docs/retinue-integration-spec.md`.
 *
 * It moved because retinue's `docs/` tree is auto-published as that site's specifications section, and the
 * repository is public so npm can generate release provenance — so this product's tool categories and
 * workflow design were being served from `docs.retinue.riseexperts.de`. Nothing in it was a credential; all
 * of it was Chorus's design. The shorthand is left as `docs/07` rather than rewritten in fifty places
 * because the numbering is how every one of those references reads, and this note is what resolves it.
 * - `skills/` — built-in skills, validated at import time.
 * - `manifests/` — the Social Assistant.
 */
export * from "./services/index.js";
export * from "./tools/index.js";
export * from "./context/index.js";
export * from "./skills/index.js";
export * from "./manifests/index.js";
export * from "./shadow/index.js";
export * from "./rollout/index.js";
export * from "./parity/index.js";

/**
 * The application shell — Rise-Experts/retinue#128.
 *
 * What turns this app module into something a client can talk to. `ShareFlowServices` stays a parameter:
 * implementing the ten of them over the ShareFlow database is REQ-041's parity work, and keeping them separate
 * is what lets shadow capture start on the first workflow rather than waiting for all ten.
 */
export * from "./app/index.js";
export * from "./app/server.js";

/**
 * Three of the ten services, over ShareFlow's own tables — REQ-041 (#190).
 *
 * `content`, `brand` and `generator` are what `create-post` needs, which makes them the smallest set that
 * lets shadow capture produce real parity data. The other seven are still ports without adapters.
 */
export * from "./adapters/index.js";
