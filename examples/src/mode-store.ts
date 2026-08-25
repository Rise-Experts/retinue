/**
 * Where a conversation's mode lives — #155.
 *
 * `SessionStateStore`, which the platform already has: per-conversation, tenant-scoped, with optimistic
 * concurrency. No new table, and the mode is durable rather than living in a `Map` that a worker restart loses.
 *
 * Switching to `auto` also issues a **conversation-scoped standing grant**, and switching away **revokes it**.
 * That is the mechanically important part: `auto` is not a flag the gate consults, it is a real grant the gate
 * finds. So the audit trail answers "why was this allowed?" with a grant that has an id, a scope and a
 * timestamp — where a boolean would leave nothing at all.
 */

import { asId } from "@retinue/agentkit";
import type {
  ApprovalGrant,
  ApprovalGrantStore,
  ConversationId,
  SessionStateStore,
  TenantId,
} from "@retinue/agentkit";
import { AUTO_GRANT_CATEGORY, DEFAULT_MODE, isConversationMode, type ConversationMode } from "./modes.js";

const MODE_KEY = "exampleMode";

export type ModeStore = {
  get(input: { tenantId: string; conversationId: string }): Promise<ConversationMode>;
  set(input: { tenantId: string; conversationId: string; mode: ConversationMode }): Promise<void>;
};

export const createModeStore = (deps: {
  readonly sessions: SessionStateStore;
  readonly grants: ApprovalGrantStore;
  readonly now?: () => string;
}): ModeStore => {
  const now = deps.now ?? (() => new Date().toISOString());

  const read = async (tenantId: string, conversationId: string) =>
    deps.sessions.get({ tenantId: tenantId as TenantId, conversationId: conversationId as ConversationId });

  return {
    async get({ tenantId, conversationId }) {
      const state = await read(tenantId, conversationId);
      const stored = (state?.data as Record<string, unknown> | undefined)?.[MODE_KEY];
      // An unrecognised stored value falls back to the default rather than throwing. A conversation should not
      // become unusable because a mode was renamed in a later version.
      return isConversationMode(stored) ? stored : DEFAULT_MODE;
    },

    async set({ tenantId, conversationId, mode }) {
      const state = await read(tenantId, conversationId);
      await deps.sessions.put({
        tenantId: tenantId as TenantId,
        conversationId: conversationId as ConversationId,
        expectedVersion: state?.version ?? 0,
        data: { ...(state?.data ?? {}), [MODE_KEY]: mode },
      });

      const existing = await deps.grants.findActive({
        tenantId: tenantId as TenantId,
        toolNameOrCategory: AUTO_GRANT_CATEGORY,
        now: now(),
        conversationId,
      });

      if (mode === "auto") {
        // Idempotent: switching to `auto` twice must not accumulate grants, or revoking one would leave the
        // other and the mode switch would appear not to work.
        if (existing !== null) return;
        const grant: ApprovalGrant = {
          id: asId("grant-" + conversationId),
          tenantId: tenantId as TenantId,
          scope: "conversation",
          toolNameOrCategory: AUTO_GRANT_CATEGORY,
          conversationId: conversationId as ConversationId,
          grantedAt: now(),
        };
        await deps.grants.grant({ tenantId: tenantId as TenantId, grant });
        return;
      }

      // Leaving `auto` revokes the grant. Without this, "switch back to ask" would leave the standing approval
      // in place and the assistant would keep acting without pausing — a mode switch that silently does nothing
      // is worse than no modes at all.
      if (existing !== null)
        await deps.grants.revoke({ tenantId: tenantId as TenantId, grantId: existing.id, at: now() });
    },
  };
};
