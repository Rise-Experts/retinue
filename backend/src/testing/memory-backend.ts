/**
 * Every in-memory store, assembled — task #253 AC-5.
 *
 * Fifteen `createMemory*` calls is the current price of a test that needs a working backend, and the reference
 * host pays it in `examples/src/memory-app.ts`. Every consumer testing an agent would rebuild the same list,
 * and the sixteenth store to land would be missing from all of them — silently, because a missing store is a
 * missing dependency and a caller that does not use it never notices.
 *
 * ## Called, not shared
 *
 * A factory per assembly, because here the factory **is** the state. `examples/src/memory-app.ts` records what
 * calling it twice does: two empty worlds, and a message that vanishes between being written and being read.
 * The Postgres adapters take an executor and hold nothing, which is why they are safe to construct per call and
 * these are not.
 */

import {
  createMemoryApprovalGrantStore,
  createMemoryCheckpointStore,
  createMemoryConversationRunCoordinator,
  createMemoryConversationStore,
  createMemoryIdempotencyStore,
  createMemoryInteractionStore,
  createMemoryMessageStore,
  createMemoryPrincipalMemoryStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
  createMemorySessionStateStore,
  createMemorySkillStore,
  createMemoryThreadSummaryStore,
  createMemoryUsageBackend,
  createMemoryUsageLimitStore,
} from "../adapters/memory/index.js";
import { createMemoryRateLimitStore } from "../adapters/memory/rate-limit.js";

export const createMemoryStores = () => {
  const usage = createMemoryUsageBackend();
  return {
    conversations: createMemoryConversationStore(),
    messages: createMemoryMessageStore(),
    runs: createMemoryRunStore(),
    checkpoints: createMemoryCheckpointStore(),
    eventLog: createMemoryRunEventLog(),
    interactions: createMemoryInteractionStore(),
    grants: createMemoryApprovalGrantStore(),
    sessions: createMemorySessionStateStore(),
    summaries: createMemoryThreadSummaryStore(),
    idempotency: createMemoryIdempotencyStore(),
    principalMemory: createMemoryPrincipalMemoryStore(),
    skills: createMemorySkillStore(),
    usage: usage.usage,
    rollups: usage.rollups,
    limits: createMemoryUsageLimitStore(),
    coordinator: createMemoryConversationRunCoordinator(),
    /** #248. Single-process by construction — see the adapter's own header before using it anywhere real. */
    rateLimit: createMemoryRateLimitStore(),
  };
};

export type MemoryStores = ReturnType<typeof createMemoryStores>;
