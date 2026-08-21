/**
 * Re-export shim. The suite grew from one harness into `./conformance/` (see #91); this file keeps
 * the original import path working so existing adapter tests did not have to change in the same PR.
 *
 * Prefer importing from `../testing/conformance/index.js` in new code.
 */
export * from "./conformance/index.js";
