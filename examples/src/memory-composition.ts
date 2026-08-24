/**
 * The single-process composition — #155 AC-7.
 *
 * Short by design. `composeEngine` in `index.ts` builds the agent from ports, so this file supplies the ports and
 * nothing else: no second manifest, no second tool list, no second approval loop. If it were long, that length
 * would be the drift — and drift between two compositions is how #157 (an unwired message store) and #161 (a
 * no-op publisher) survived, both of which were "works in one shape, broken in the other".
 */

import { asId, createStoredLimitResolver, createQuotaGuard } from "@agentkit/backend";
import type { JobDispatcher, ResolverDeps, Run } from "@agentkit/backend";
import { closeExampleMcp, composeEngine, exampleRegistry } from "./index.js";
import { exampleProviders } from "./providers.js";
import type { ExampleBackend } from "./stores.js";
import type { MemoryBackend } from "./memory-app.js";
import { buildWorkerContext } from "./worker-context.js";
import { createDevAuthenticate } from "./auth.js";
import { createQuestionService, createApprovalService } from "@agentkit/backend";

/**
 * The memory backend, viewed as the ports the app expects.
 *
 * A mapping rather than a rename: `MemoryBackend` groups by *what created it* and `ExampleBackend` groups by
 * *what needs it*, and collapsing the two would make one of them wrong the first time a store is used somewhere
 * new.
 */
export const asExampleBackend = (memory: MemoryBackend): ExampleBackend => ({
  conversations: memory.conversations,
  messages: memory.messages,
  sessions: memory.sessions,
  grants: memory.grants,
  summaries: memory.summaries,
  rollups: memory.rollups,
  limits: memory.limits,
  runs: memory.runs,
  eventLog: memory.eventLog,
  interactions: memory.interactions,
  idempotency: memory.idempotency,
  principalMemory: memory.principalMemory,
  skills: memory.skills,
  usage: memory.usage,
  coordinator: memory.coordinator,
  live: memory.bus.live as never,
});

export const buildMemoryComposition = (memory: MemoryBackend) => {
  const backend = asExampleBackend(memory);

  return {
    authenticate: createDevAuthenticate(),
    stores: backend,
    providers: exampleProviders(backend),
    /** The very same function the Postgres path calls. That is the whole point of this file being short. */
    engine: composeEngine(backend),
    buildContext: (run: Run) => buildWorkerContext(run),

    /**
     * `ResolverDeps`, with the dispatcher passed in.
     *
     * The dispatcher comes from the worker rather than being built here, because in one process the queue and
     * the thing that drains it are the same object — and building a second dispatcher would enqueue into a queue
     * nothing drains, which presents as a message that is accepted and then never answered.
     */
    deps: (dispatcher: JobDispatcher): ResolverDeps => ({
      conversations: backend.conversations,
      runs: memory.runs,
      usage: memory.usage,
      rollups: memory.rollups,
      toolRegistry: exampleRegistry(backend),
      questions: createQuestionService({ interactions: backend.interactions, dispatcher, runs: backend.runs }),
      approvals: createApprovalService({
        interactions: memory.interactions,
        grants: memory.grants,
        dispatcher,
        runs: memory.runs,
      }),
      coordinator: memory.coordinator,
      dispatcher,
      eventLog: memory.eventLog,
      live: memory.bus.live as never,
      quota: createQuotaGuard({
        rollups: memory.rollups,
        resolveLimits: createStoredLimitResolver({ limits: backend.limits }),
        observer: {
          onWarning: (context, warning) =>
            console.error(`[quota] warning ${String(context.principalId)}: ${warning.message}`),
          onRefusal: (context, refusal) =>
            console.error(`[quota] refused ${String(context.principalId)}: ${refusal.message}`),
        },
      }),
    }),

    /** The MCP child process is closed here too — one process still spawns one (#173). */
    close: () => closeExampleMcp(),
  };
};

export { asId };
