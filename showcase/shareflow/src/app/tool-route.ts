/**
 * `POST /api/tools/:name` — one tool, called directly, for the product's non-chat features.
 *
 * ## Why this exists
 *
 * Three capabilities are `partial` in the inventory for the same reason, and it is not the tools:
 * *"the tool is exercised by generate.test.ts; the HTTP entry point has no replacement — the new shell
 * serves /api/message and /api/events only"*. `propose_post_angles`, `generate_content` and
 * `draft_comment_reply` are done and tested; what the old runtime also had was `POST /generate`,
 * `POST /api/ai/generate` and `POST /reply`, which the Next app calls from a form with no conversation
 * involved.
 *
 * So a user who types into the chat was covered and a user who presses a button in the composer was
 * not. Turning those buttons into chat turns would be a different product, so the entry point is what
 * has to exist.
 *
 * ## The effect gate is derived, and it is default-deny
 *
 * A tool's `effect` is what decides whether the platform requires approval, and the approval loop lives
 * in the **conversation**: a run pauses, a person decides, the run resumes. This route has no run to
 * pause and nobody to ask, so a gated tool called here would execute with the approval step simply
 * absent — a publish nobody confirmed, through an endpoint whose whole purpose is convenience.
 *
 * `read` and `internal-write` are callable. `external-write` and `destructive` are not.
 *
 * **Unknown effects are refused**, and that is the part worth stating. The set is written as the
 * *allowed* values rather than the denied ones, so a fifth effect added to the platform is refused here
 * until someone decides otherwise. A deny-list would have admitted it silently, which is exactly how a
 * new kind of dangerous tool becomes reachable without approval.
 */

import type { ExecutionContext, ToolRegistry } from "@retinue/agentkit";

/**
 * Effects this route will execute.
 *
 * `internal-write` is included deliberately, and `draft_comment_reply` is why: it writes a drafted
 * reply and puts the comment back into needs-review. Nothing leaves the tenant — which the inventory
 * gives as the reason it is not approval-gated in the first place — so refusing it here would refuse a
 * capability the platform considers ungated.
 */
export const RPC_ALLOWED_EFFECTS = ["read", "internal-write"] as const;

export type RpcOutcome =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 403 | 404 | 422; readonly body: { readonly error: string } };

/** The tool name from `/api/tools/<name>`, or null when the path is not one of ours. */
export const toolNameFrom = (pathname: string): string | null => {
  const match = /^\/api\/tools\/([A-Za-z0-9_]+)$/.exec(pathname);
  return match === null ? null : (match[1] ?? null);
};

export const executeToolCall = async (input: {
  readonly registry: ToolRegistry;
  readonly context: ExecutionContext;
  readonly name: string;
  readonly body: unknown;
  readonly idempotencyKey?: string;
}): Promise<RpcOutcome> => {
  /**
   * `learn` rather than the catalogue, because it answers for **this** principal.
   *
   * A tool the caller may not use must read as absent, not as forbidden: the registry's own `find`
   * comment makes the point that confirming a tool exists while hiding it from discovery is worse than
   * not hiding it, because it turns the endpoint into an enumeration oracle.
   */
  const [descriptor] = await input.registry.learn(input.context, [input.name]);
  if (descriptor === undefined) return { status: 404, body: { error: `no tool named ${input.name}` } };

  const effect = String((descriptor as { effect?: unknown }).effect ?? "");
  if (!(RPC_ALLOWED_EFFECTS as readonly string[]).includes(effect)) {
    return {
      status: 403,
      body: {
        error:
          `${input.name} is ${effect === "" ? "of an unstated effect" : effect} and cannot be called ` +
          `directly. Its approval step lives in a conversation, which this endpoint has none of — send a ` +
          `message to /api/message instead, where a person can be asked.`,
      },
    };
  }

  /**
   * The body is the tool's input, unwrapped.
   *
   * No envelope, because the old routes had none: the Next app posts the fields directly, and an
   * envelope here would mean every caller changing shape for nothing. The registry validates against
   * the tool's own schema, so a wrong field is a 422 with the schema's message rather than a crash.
   */
  let result: unknown;
  try {
    result = await input.registry.execute(input.context, {
      name: input.name,
      input: input.body,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
  } catch (thrown) {
    /**
     * A refusal carries its message; anything else does not.
     *
     * A tool that refuses says something the caller can act on — "that platform is not connected", "the
     * draft is already published". An unexpected throw may carry a connection string, so it is logged
     * and answered generically. The distinction is the `code` the platform's own errors carry.
     */
    const error = thrown as { code?: unknown; message?: unknown };
    const known = typeof error.code === "string" && error.code !== "internal";
    if (!known) console.error(`[tools] ${input.name} threw:`, thrown);
    else {
      /**
       * A refusal is **answered** to the caller and **said** here too — #469.
       *
       * This branch previously logged nothing, on the reasoning that a known error is one the caller
       * can act on. That holds for the caller and not for the operator, and the two are different
       * people: a workspace's provider rejecting every request is a refusal with a perfectly good
       * message, and nobody running the deployment ever sees it.
       *
       * Measured: `generate_content` returned 422 carrying *"'messages' must contain the word 'json'"*
       * for a workspace on an OpenAI-compatible endpoint — every generation it attempted, for hours,
       * with **zero lines** across all four containers. The bug took a reproduction to find because
       * the logs could not have told anyone it was happening.
       *
       * `warn`, not `error`: most refusals are ordinary and expected ("that platform is not
       * connected"). The message only, never `input.body` — a tool's arguments carry captions, briefs
       * and URLs, the same rule `turn-logging.ts` holds.
       */
      console.warn(
        `[tools] ${input.name} refused for workspace ${String(input.context.tenantId)}: ` +
          `${String(error.code)} — ${typeof error.message === "string" ? error.message : "(no message)"}`,
      );
    }
    return {
      status: known ? 422 : 400,
      body: { error: known && typeof error.message === "string" ? error.message : `${input.name} failed` },
    };
  }

  /**
   * A tool that returned `ok: false` is a 422, not a 200 with a failure inside it.
   *
   * The old routes answered with an HTTP status the caller branched on, and a form that reads `200` as
   * success would show a generated post that does not exist. `ToolResult` carries the flag; the status
   * has to agree with it.
   */
  const outcome = result as { ok?: unknown; error?: unknown; data?: unknown };
  if (outcome.ok === false) {
    const message =
      typeof outcome.error === "string"
        ? outcome.error
        : typeof (outcome.error as { message?: unknown } | undefined)?.message === "string"
          ? String((outcome.error as { message: string }).message)
          : `${input.name} declined`;
    // Same reasoning as the refusal above: the caller is told, and so is whoever runs the deployment.
    console.warn(`[tools] ${input.name} declined for workspace ${String(input.context.tenantId)}: ${message}`);
    return { status: 422, body: { error: message } };
  }

  return { status: 200, body: result };
};
