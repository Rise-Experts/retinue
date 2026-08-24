/**
 * Redis adapters that are not the queue.
 *
 * `adapters/bullmq` owns the queue and its lock; this directory is for the other things Redis is the natural fit
 * for. Kept separate so a deployment reading the tree can see that "we use Redis for the queue" and "we use Redis
 * for realtime" are two decisions, not one.
 */
export * from "./realtime.js";
