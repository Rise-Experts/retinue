/**
 * `@agentkit/backend/adapters/otel` — the OpenTelemetry exporter for the telemetry port.
 *
 * Its own entry for the reason boundary rule R11 exists: "vendor-neutral instrumentation" is only true if the
 * vendor's SDK is confined to one place.
 *
 * It takes **no peer dependency**, which surprised me while packaging this: the adapter defines the structural
 * types it needs and the caller passes a real provider, so `@opentelemetry/api` appears only in the tests. It
 * was briefly declared as an optional peer here — an install requirement for something never imported — and
 * removed once checked.
 */
export * from "../adapters/otel/index.js";
