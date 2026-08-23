/**
 * BullMQ/Redis adapters — the durable job queue behind `JobDispatcher` (#105).
 *
 * `bullmq` and `ioredis` are imported only inside this directory, which is where the dependency
 * boundary checker expects an adapter's client coupling to live.
 */
export * from "./dispatcher.js";
export * from "./queue.js";
export * from "./lock.js";
