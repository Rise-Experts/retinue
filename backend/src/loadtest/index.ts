/**
 * Load, soak and failure injection — REQ-033 (#144).
 *
 * Shipped rather than kept in `src/testing`, because an operator sizing a deployment needs to be able to run the
 * same harness that produced the published envelope. Numbers measured on someone else's hardware are a starting
 * point, not an answer.
 */
export * from "./metrics.js";
export * from "./injection.js";
export * from "./scenario.js";
export * from "./harness.js";
export * from "./runbooks.js";
