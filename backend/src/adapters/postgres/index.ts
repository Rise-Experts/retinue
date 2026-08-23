/**
 * PostgreSQL adapters — the production reference storage. Implements the storage ports over a
 * `SqlExecutor`; verified by the shared conformance harness.
 */
import type { AdapterCapability } from "../../persistence/index.js";

export * from "./sql.js";
export * from "./migrations.js";
export * from "./schema.js";
export * from "./conversation-store.js";
export * from "./run-store.js";
export * from "./run-event-log.js";
export * from "./checkpoint-store.js";
export * from "./message-store.js";
export * from "./session-state.js";
export * from "./transaction.js";
export * from "./run-coordinator.js";
export * from "./unit-of-work.js";
export * from "./hitl.js";
export * from "./usage.js";
export * from "./config.js";
export * from "./memory.js";
export * from "./pg-executor.js";

/** Capabilities a PostgreSQL deployment can advertise (docs/02 capability declarations). */
export const POSTGRES_CAPABILITIES: readonly AdapterCapability[] = [
  "transactions",
  "row-level-security",
  "full-text-search",
  "distributed-locking",
];
export * from "./files.js";
export * from "./artifacts.js";
export * from "./artifact-exports.js";
export * from "./knowledge.js";
export * from "./rollups.js";
export * from "./evaluation.js";
export * from "./retention.js";
