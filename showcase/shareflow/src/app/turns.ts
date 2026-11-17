/**
 * `startTurn` and `openEvents` — the shell's deps, implemented.
 *
 * ## Why this was missing, and why it matters
 *
 * `createShareFlowServer` declared these (and a shadow turn, removed in #712) and **nothing implemented them**: the shell appeared
 * only in its own tests. The deployed container ran `retinue serve`, which is the platform's GraphQL
 * host, so `POST /api/message` answered 404 — verified against the running backend before this existed.
 *
 * That is precisely the misconfiguration `agentkitClient.ts` was written to detect: *"A bare
 * `retinue serve` has no `/api/message`, so a 404 here…"*. The deployed backend **was** the bare host,
 * and every turn the web app sent would have been refused by the client with that message. The whole
 * repointing pointed at nothing.
 *
 * ## The order in `startTurn` is load-bearing
 *
 * The message row, then the run row, then the slot, then the dispatch. `claimOrEnqueue` coordinates the
 * conversation's *slot*; it does not create the run. Calling only that returns `started` and executes
 * nothing, because the worker claims a job whose row does not exist — a job enqueued before its row
 * exists is a job pointing at nothing. `server.ts`'s header records the reference application making
 * exactly this mistake.
 *
 * A run that is `queued` is deliberately **not** dispatched: the coordinator promotes it when the
 * active run finishes. Dispatching it now would put two runs on one conversation, which is the thing
 * the slot exists to prevent.
 */

import type { TurnSettings } from "./turn-settings.js";
import type {
  ConversationId,
  ExecutionContext,
  MessageId,
  RunId,
  TenantId,
} from "@retinue/agentkit";

/** A stand-in for the platform's own id shape; `crypto.randomUUID` is what every adapter expects. */
const newId = (): string => crypto.randomUUID();

export type TurnDeps = {
  readonly conversations: {
    create(input: { tenantId: TenantId; id: ConversationId; title: string }): Promise<unknown>;
    findById(input: { tenantId: TenantId; id: ConversationId }): Promise<unknown>;
  };
  readonly messages: {
    append(input: { tenantId: TenantId; message: unknown }): Promise<unknown>;
  };
  readonly runs: {
    create(input: Record<string, unknown>): Promise<unknown>;
  };
  readonly coordinator: {
    claimOrEnqueue(input: { tenantId: TenantId; conversationId: ConversationId; runId: RunId }): Promise<{
      status: "started" | "queued";
      position: number;
    }>;
  };
  readonly dispatcher: {
    /**
     * `enqueueRun`, which is the name the platform's dispatcher actually has.
     *
     * Written as `dispatch` first, which typechecked against a `Record<string, unknown>` dep and would
     * have thrown `dispatcher.dispatch is not a function` on the first admitted turn — the same shape
     * as the four contract violations the worker produced. Read from
     * `adapters/bullmq/dispatcher.js` rather than guessed.
     */
    enqueueRun(input: { tenantId: TenantId; runId: RunId; enqueuedAt?: Date }): Promise<unknown>;
  };
  readonly limits: Record<string, number>;
  readonly agentId: string;
  readonly agentVersion: number;
};

/**
 * Admit a turn: write it down, then ask for the slot, then dispatch if we got it.
 *
 * The conversation is created when it is not there, which is what lets a client hand us its own id for
 * a brand-new thread — the alternative is a round trip whose only purpose is to learn an id the client
 * already chose.
 */
export const createStartTurn =
  (deps: TurnDeps) =>
  async (input: { context: ExecutionContext; message: string; conversationId?: string; settings?: TurnSettings }) => {
    const tenantId = input.context.tenantId as TenantId;
    const conversationId = (input.conversationId ?? newId()) as ConversationId;

    const existing = await deps.conversations.findById({ tenantId, id: conversationId });
    if (existing === null) {
      /**
       * Titled from the message, trimmed.
       *
       * The old runtime's session list shows a title, and an untitled thread reads as broken in it. The
       * assistant renames it later; this is only so the row is never blank.
       */
      const title = input.message.trim().slice(0, 80) || "New conversation";
      await deps.conversations.create({ tenantId, id: conversationId, title });
    }

    const messageId = newId() as MessageId;
    await deps.messages.append({
      tenantId,
      message: {
        id: messageId,
        conversationId,
        role: "user",
        parts: [{ id: newId(), type: "text", schemaVersion: 1, createdAt: new Date(), text: input.message }],
        createdAt: new Date(),
      },
    });

    const runId = newId() as RunId;
    /**
     * The run row **before** the slot and the dispatch.
     *
     * `input` carries the message because the engine reads the turn from history, and a run whose input
     * is absent replays as an empty turn. `limits` and the agent version are recorded on the run so the
     * transcript can be explained later under the manifest it actually executed.
     */
    await deps.runs.create({
      tenantId,
      id: runId,
      conversationId,
      agentId: deps.agentId,
      agentVersion: deps.agentVersion,
      principalId: input.context.principalId,
      roleIds: [...input.context.roleIds],
      // #543: the turn's settings ride on the run, because the worker reads the run and never the request.
      input: { message: input.message, ...(input.settings === undefined ? {} : { settings: input.settings }) },
      limits: deps.limits,
    });

    const slot = await deps.coordinator.claimOrEnqueue({ tenantId, conversationId, runId });

    /**
     * Dispatched only when this run holds the slot.
     *
     * A `queued` run is promoted by the coordinator when the active one finishes. Dispatching it here as
     * well would put two runs on one conversation — the thing the slot exists to prevent — and the
     * second would interleave its parts into the same transcript.
     */
    if (slot.status === "started") {
      await deps.dispatcher.enqueueRun({ tenantId, runId });
    }

    return { conversationId: String(conversationId), runId: String(runId), messageId: String(messageId), started: slot.status };
  };
