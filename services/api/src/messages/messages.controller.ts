/**
 * Starting a turn — REQ-044 (#201).
 *
 * The platform deliberately does **not** own message ingestion: `sendMessage(conversationId, runId)` takes ids
 * and no text, because what a message is — who may send one, what it may contain, what else happens when one
 * arrives — is the application's decision. So this controller is not a gap being filled; it is the part a
 * service is supposed to write.
 *
 * The order below is the whole of it, and every step is in its position for a reason that was learned the hard
 * way in the reference app:
 *
 * 1. **Quota first, before anything exists.** A refused turn must leave no message row, no run row, no slot held
 *    and no job queued. A limit enforced after any of that leaves a half-started turn and a person guessing
 *    whether to retry.
 * 2. **Conversation, idempotently.** Re-sending the same first message must not create a second conversation.
 * 3. **The message, through the port.** `MessageStore.append` — not a cast past it. The port was read-only until
 *    #157, and writing an application is what surfaced that no host could record what the user said.
 * 4. **The run row, then the slot, then the job.** A job enqueued before its row exists points at nothing: the
 *    worker claims it, `claim` matches no run, and the job is silently skipped. That is the abandoned-run shape
 *    #144 found, and calling only `startOrEnqueueRun` reproduces it exactly.
 */

import { BadRequestException, Body, Controller, HttpException, Inject, Post, Req } from "@nestjs/common";
import { asId, startOrEnqueueRun } from "@retinue/agentkit";
import { randomUUID } from "node:crypto";
import { RETINUE_AGENT, RETINUE_AUTHENTICATE, RETINUE_MESSAGES, RETINUE_RESOLVER_DEPS } from "../retinue/tokens.js";
import type { Request as ExpressRequest } from "express";
import type { Authenticate } from "@retinue/agentkit/server";
import type {
  ConversationId,
  ExecutionContext,
  MessageId,
  MessagePartId,
  ResolverDeps,
  RunId,
} from "@retinue/agentkit";

type MessageStore = { append(input: { tenantId: unknown; message: unknown }): Promise<unknown> };

export type StartTurnBody = { readonly conversationId?: string; readonly text?: string };

@Controller("api")
export class MessagesController {
  constructor(
    @Inject(RETINUE_RESOLVER_DEPS) private readonly deps: ResolverDeps,
    @Inject(RETINUE_MESSAGES) private readonly messages: MessageStore,
    @Inject(RETINUE_AUTHENTICATE) private readonly authenticate: Authenticate,
    @Inject(RETINUE_AGENT) private readonly agentId: string,
  ) {}

  @Post("message")
  async startTurn(@Req() request: ExpressRequest, @Body() body: StartTurnBody) {
    const context = await this.toExecutionContext(request);
    const text = String(body.text ?? "").trim();
    if (text === "") throw new BadRequestException("text is required");

    // 1. Quota, before anything is created.
    if (this.deps.quota !== undefined) {
      try {
        await this.deps.quota.assertAdmitted(context);
      } catch (thrown) {
        const error = thrown as { code?: string; message?: string; details?: { retryAfter?: string } };
        if (error.code !== "budget_exceeded") throw thrown;
        /**
         * 429 with a reset time, not a 500.
         *
         * Distinguished by the platform's error code rather than by matching a message: "you are over your
         * limit" and "something broke" are the difference between a person waiting and a person filing a bug.
         * Seconds are computed from the reset *instant*, because a `retryAfter: 0` tells a client to retry
         * immediately into the same refusal.
         */
        const resetAt = error.details?.retryAfter;
        const seconds = resetAt === undefined ? 60 : Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
        throw new HttpException(
          { error: error.message ?? "Usage limit reached", code: error.code, resetAt },
          429,
          { cause: thrown },
        );
      }
    }

    // 2. The conversation, idempotently.
    const conversationId = asId<ConversationId>(body.conversationId ?? `conv-${randomUUID()}`);
    const existing = await this.deps.conversations.findById({ tenantId: context.tenantId, id: conversationId });
    if (existing === null) {
      await this.deps.conversations.create({
        tenantId: context.tenantId,
        id: conversationId,
        title: text.slice(0, 60),
      });
    }

    // 3. The user's turn, through the port.
    const messageId = asId<MessageId>(`msg-${randomUUID()}`);
    const runId = asId<RunId>(`run-${String(messageId)}`);
    const now = new Date().toISOString();
    await this.messages.append({
      tenantId: context.tenantId,
      message: {
        id: messageId,
        conversationId,
        runId,
        role: "user",
        parts: [
          { id: asId<MessagePartId>(`${String(messageId)}-p0`), type: "text", schemaVersion: 1, createdAt: now, text },
        ],
        createdAt: now,
      },
    });

    // 4. The run row, then the slot, then the job — in that order.
    await this.deps.runs.create({
      tenantId: context.tenantId,
      id: runId,
      conversationId,
      agentId: asId(this.agentId),
      agentVersion: 1,
      // From the authenticated caller, which is the only place it can honestly come from: without it the worker
      // has nothing to rebuild an identity from, and every person's work lands under one invented principal.
      principalId: context.principalId,
      roleIds: context.roleIds,
    });
    const started = await startOrEnqueueRun(this.deps.coordinator, {
      tenantId: context.tenantId,
      conversationId,
      runId,
    });
    if (started === "started") await this.deps.dispatcher.enqueueRun({ tenantId: context.tenantId, runId });

    return { conversationId: String(conversationId), runId: String(runId), messageId: String(messageId), started };
  }

  /**
   * The same authenticator the GraphQL surface uses.
   *
   * A controller that authenticated more loosely than the platform's own surface would be the service teaching
   * the wrong thing — and would be the way in.
   */
  private async toExecutionContext(request: ExpressRequest): Promise<ExecutionContext> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(","));
    }
    const context = await this.authenticate(new Request(`http://localhost${request.url}`, { headers }));
    if (context === null || context === undefined) throw new HttpException({ error: "Unauthenticated" }, 401);
    return context;
  }
}
