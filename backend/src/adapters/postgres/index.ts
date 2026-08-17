/**
 * PostgreSQL adapters — the production reference storage. Implements the storage ports over a
 * `SqlExecutor`; verified by the shared conformance harness.
 */
import type { AdapterCapability } from "../../persistence/index.js";

export * from "./sql.js";
export * from "./migrations.js";
export * from "./schema.js";
export * from "./conversation-store.js";
export * from "./pg-executor.js";

/** Capabilities a PostgreSQL deployment can advertise (docs/02 capability declarations). */
export const POSTGRES_CAPABILITIES: readonly AdapterCapability[] = [
  "transactions",
  "row-level-security",
  "full-text-search",
  "distributed-locking",
];
