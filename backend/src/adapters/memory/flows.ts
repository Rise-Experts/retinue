/**
 * In-memory flow definitions and executions — the reference implementations (#187, #186).
 *
 * Two properties this takes seriously despite being in-memory, because both are the kind that an in-memory
 * adapter is where the bug would be invisible:
 *
 * - **Tenant partitioning is by outer map, not a filter.** An execution id from one tenant cannot resolve
 *   another's document because it is not in that tenant's map at all.
 * - **`save` is monotonic on `steps`.** A save carrying fewer completed steps than the stored one is ignored. Two
 *   workers holding the same execution would otherwise let the slower one move it backwards, and a flow that goes
 *   backwards re-performs external writes — the failure this whole module exists to prevent.
 */

import { AgentPlatformError } from "../../core/errors.js";
import type { Page } from "../../core/context.js";
import type {
  FlowDefinitionStore,
  FlowExecutionStore,
  StoredFlowDefinition,
  StoredFlowExecution,
} from "../../persistence/index.js";

const tenantMap = <T>(byTenant: Map<string, Map<string, T>>, tenantId: string): Map<string, T> => {
  const existing = byTenant.get(tenantId);
  if (existing !== undefined) return existing;
  const created = new Map<string, T>();
  byTenant.set(tenantId, created);
  return created;
};

const page = <T>(items: readonly T[], request: { limit?: number; cursor?: string }, key: (item: T) => string): Page<T> => {
  const take = Math.max(1, Math.min(request.limit ?? 50, 500));
  const after = request.cursor;
  const eligible = after === undefined ? items : items.filter((item) => key(item) > after);
  const slice = eligible.slice(0, take);
  return {
    items: slice,
    ...(eligible.length > take && slice.length > 0 ? { nextCursor: key(slice[slice.length - 1]!) } : {}),
  };
};

export const createMemoryFlowDefinitionStore = (): FlowDefinitionStore => {
  // Keyed `flowId@version`, because a version is part of a definition's identity rather than a column on it.
  const byTenant = new Map<string, Map<string, StoredFlowDefinition>>();

  return {
    async put({ tenantId, definition }) {
      const store = tenantMap(byTenant, String(tenantId));
      const key = `${definition.flowId}@${definition.version}`;
      if (store.has(key)) {
        // A version that changed is not a version. Refusing here is what lets an execution pin one and trust it.
        throw new AgentPlatformError({
          code: "conflict",
          message: `${definition.flowId} version ${definition.version} already exists — publish a new version instead`,
          retryable: false,
        });
      }
      store.set(key, definition);
    },

    async get({ tenantId, flowId, version }) {
      return tenantMap(byTenant, String(tenantId)).get(`${flowId}@${version}`) ?? null;
    },

    async latest({ tenantId, flowId }) {
      const versions = [...tenantMap(byTenant, String(tenantId)).values()]
        .filter((definition) => definition.flowId === flowId)
        .sort((a, b) => b.version - a.version);
      return versions[0] ?? null;
    },

    async list({ tenantId, ...request }) {
      // Latest version per flow: a list of every version of every flow is a list nobody wants, and the caller
      // asking "what flows are there" means distinct flows.
      const latest = new Map<string, StoredFlowDefinition>();
      for (const definition of tenantMap(byTenant, String(tenantId)).values()) {
        const current = latest.get(definition.flowId);
        if (current === undefined || definition.version > current.version) latest.set(definition.flowId, definition);
      }
      const sorted = [...latest.values()].sort((a, b) => a.flowId.localeCompare(b.flowId));
      return page(sorted, request, (definition) => definition.flowId);
    },
  };
};

export const createMemoryFlowExecutionStore = (): FlowExecutionStore => {
  const byTenant = new Map<string, Map<string, StoredFlowExecution>>();

  return {
    async create({ tenantId, execution }) {
      const store = tenantMap(byTenant, String(tenantId));
      if (store.has(execution.id)) {
        throw new AgentPlatformError({
          code: "conflict",
          message: `flow execution ${execution.id} already exists`,
          retryable: false,
        });
      }
      store.set(execution.id, execution);
    },

    async save({ tenantId, execution }) {
      const store = tenantMap(byTenant, String(tenantId));
      const stored = store.get(execution.id);
      // Monotonic. A slower worker's stale document must not move the execution backwards.
      if (stored !== undefined && execution.steps < stored.steps) return;
      store.set(execution.id, execution);
    },

    async get({ tenantId, executionId }) {
      return tenantMap(byTenant, String(tenantId)).get(executionId) ?? null;
    },

    async waitingOnSignal({ tenantId, signal, limit }) {
      return [...tenantMap(byTenant, String(tenantId)).values()]
        .filter((execution) => execution.status === "waiting" && execution.waitingSignal === signal)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(0, Math.max(1, Math.min(limit ?? 50, 500)));
    },

    async waitingOnRun({ tenantId, runId }) {
      // `status === "waiting"` as well as the id: a stale `waitingRunId` on a running execution must not be
      // resumed by a run finishing, because it is not waiting for one.
      return (
        [...tenantMap(byTenant, String(tenantId)).values()].find(
          (execution) => execution.status === "waiting" && execution.waitingRunId === runId,
        ) ?? null
      );
    },

    async listByFlow({ tenantId, flowId, ...request }) {
      const matching = [...tenantMap(byTenant, String(tenantId)).values()]
        .filter((execution) => execution.flowId === flowId)
        // Newest first: the inspector's question is "what happened just now".
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
      return page(matching, request, (execution) => execution.id);
    },
  };
};
