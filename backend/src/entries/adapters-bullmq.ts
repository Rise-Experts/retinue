/**
 * `@agentkit/backend/adapters/bullmq` — the durable queue and its dispatchers.
 *
 * `bullmq` and `ioredis` are optional peers. Importing this constructs no connection; only
 * `createBullMqRunQueue` does.
 */
export * from "../adapters/bullmq/index.js";
