/**
 * The agentkit client — Rise-Experts/retinue#128.
 *
 * ## It talks to an *application*, not to the platform's GraphQL host
 *
 * This is the constraint that shaped everything below, and it is worth stating first because the obvious
 * design does not work.
 *
 * `@retinue/agentkit`'s GraphQL host exposes `sendMessage(conversationId, runId)`. That mutation **takes no
 * message content** and **does not create the run row** — it coordinates the conversation's slot and enqueues
 * a job. A remote client calling it gets `started` back and nothing ever executes, because the worker claims a
 * job whose run row does not exist. The reference app's own server says so where it creates one:
 *
 * > "`startOrEnqueueRun` coordinates the conversation's slot; it does not create the run. My first version
 * > called only that, got `started` back, and nothing ever executed."
 *
 * So the platform host can be driven as far as *admission* and no further, and a client built against it would
 * appear to work while every turn silently did nothing. What this talks to is a ShareFlow **agentkit
 * application** — the same shape as `examples/`, composing `@retinue/shareflow`'s manifests, tools, context and
 * skills — which owns the store and can therefore write the message and the run.
 *
 * `ASSISTANT_AGENTKIT_URL` must point at that application. Pointing it at a bare `retinue serve` is a
 * misconfiguration this client detects and names, rather than one that shows up as turns that never answer.
 */

/** How long a live turn may take before the client gives up. Long, because a real turn can be. */
const DEFAULT_TIMEOUT_MS = 120_000;

export type AgentkitClientConfig = {
  /**
   * The **application's** base URL. See the header: a bare GraphQL host cannot complete a turn.
   */
  readonly baseUrl: string;
  /**
   * Called per request. A function rather than a value so a rotated token takes effect without a restart —
   * the same rule every toolkit's credential resolution follows.
   */
  readonly token: () => Promise<string> | string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

export type StartTurnInput = {
  readonly workspaceId: string;
  readonly userId: string;
  readonly message: string;
  readonly conversationId?: string;
};

export type StartedTurn = {
  readonly conversationId: string;
  readonly runId: string;
  readonly messageId: string;
  /** `started` or `queued` — the conversation's single-run slot, reported rather than hidden. */
  readonly started: string;
};

export class AgentkitUnavailable extends Error {
  readonly retryable = true;
}
export class AgentkitMisconfigured extends Error {
  readonly retryable = false;
}

/**
 * The header this client requires the application to answer with.
 *
 * A bare GraphQL host does not set it, which is how pointing `ASSISTANT_AGENTKIT_URL` at one is caught at the
 * first call with a message naming the mistake — rather than as turns that admit and never answer, which is
 * the failure that would otherwise take an afternoon to diagnose.
 */
export const APPLICATION_HEADER = 'x-retinue-application';

const withTimeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);

/**
 * The role these server-to-server calls declare — #406.
 *
 * `x-roles` is required by the backend now, and a request without it is refused rather than defaulted
 * to `editor`, which is the bug that issue fixes: the chat proxy forwarded no role, the backend
 * assumed the friendliest one, and a VIEWER's turn ran with edit rights.
 *
 * **These are not that path.** The four modules that use this client — auto-reply drafting, tool calls,
 * campaign planning, generation — are called from routes and workers that have already authorised the
 * action against the acting user. They are the system acting on a decision already made, and they
 * genuinely do write: drafting a reply and creating a post are the point of them.
 *
 * So the role is *declared* here rather than defaulted there, and the difference is that this is one
 * visible line somebody can argue with. A default is a decision nobody made.
 *
 * The narrower fix this leaves: these paths do not carry the *caller's* role, so a product feature
 * that a viewer can trigger acts with edit rights inside the runtime. That is the pre-existing
 * behaviour of those features, gated by their own routes and by RLS on their direct writes (#401).
 * Threading the real role through all four is follow-up work, recorded on #406.
 */
const SYSTEM_ROLE = 'editor';

export const createAgentkitClient = (config: AgentkitClientConfig) => {
  const base = config.baseUrl.replace(/\/$/, '');
  const send = config.fetchImpl ?? fetch;

  /**
   * The identity headers this deployment already uses, not a Bearer token.
   *
   * This sent `authorization: Bearer <secret>` with the workspace and user in the **body**, and the
   * backend reads `X-API-Secret` / `X-Workspace-Id` / `X-User-Id` — so every turn returned **401**.
   * Two contracts, each tested against its own assumptions and never against each other, until one
   * request was sent to a running backend.
   *
   * These are `serviceHeaders()`'s names, which the Python backend also reads: workspace scoping relies
   * on the trusted `X-Workspace-Id`, trusted *because* the shared secret proved the caller is us. The
   * ids go in headers rather than a body for that reason — a caller that can set the workspace in a
   * payload can set somebody else's.
   */
  const identity = async (workspaceId: string, userId: string): Promise<Record<string, string>> => ({
    'X-API-Secret': await config.token(),
    'X-Workspace-Id': workspaceId,
    'X-User-Id': userId,
    'x-roles': SYSTEM_ROLE,
    'content-type': 'application/json',
  });

  const post = async (
    path: string,
    body: unknown,
    signal: AbortSignal,
    who: { workspaceId: string; userId: string },
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method: 'POST',
        headers: await identity(who.workspaceId, who.userId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      /**
       * Unreachable, timed out, or aborted. Retryable, and named as such: the runtime's retry logic and the
       * rollout's fallback both branch on it, and reporting a network failure as a permanent one would
       * strand a workspace on the new runtime with no answers.
       */
      throw new AgentkitUnavailable(
        `the agentkit application at ${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 404) {
      /**
       * The misconfiguration this exists to catch. A bare `retinue serve` has no `/api/message`, so a 404 here
       * is almost always the wrong URL rather than a missing conversation.
       */
      throw new AgentkitMisconfigured(
        `${base}${path} returned 404. ASSISTANT_AGENTKIT_URL must point at a ShareFlow agentkit *application*, ` +
          'not at a bare `retinue serve` GraphQL host — that host can admit a run but cannot create one, so ' +
          'turns would be accepted and never answered.',
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      // 5xx is the application's problem and may pass; 4xx is this request's and will not.
      const Failure = response.status >= 500 ? AgentkitUnavailable : AgentkitMisconfigured;
      throw new Failure(`the agentkit application returned ${response.status}: ${detail || response.statusText}`);
    }
    return response;
  };

  return {
    /**
     * Start a turn and hand back the ids the caller needs to stream it.
     *
     * Deliberately **not** streaming: the ids have to exist before a stream can be opened, and a single call
     * that did both would give a caller no way to record the run id if the stream failed halfway.
     */
    async startTurn(input: StartTurnInput): Promise<StartedTurn> {
      const response = await post(
        '/api/message',
        // No ids in the body: they are headers, and the secret is what makes those trustworthy.
        { message: input.message, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }) },
        withTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        { workspaceId: input.workspaceId, userId: input.userId },
      );

      /**
       * The application identifies itself, and the absence of that is a misconfiguration rather than a quirk.
       *
       * Checked on the *success* path too: a proxy or a different service could answer 200 on this path and
       * the turn would still never run.
       */
      if (response.headers.get(APPLICATION_HEADER) === null) {
        throw new AgentkitMisconfigured(
          `${base}/api/message answered without the ${APPLICATION_HEADER} header, so it is not a ShareFlow ` +
            'agentkit application. A host that admits runs it cannot create would accept every turn and ' +
            'answer none.',
        );
      }

      const payload = (await response.json()) as Partial<StartedTurn>;
      if (typeof payload.runId !== 'string' || typeof payload.conversationId !== 'string') {
        throw new AgentkitMisconfigured(
          'the agentkit application did not return a runId and a conversationId, which are what a turn is ' +
            'streamed and recorded by.',
        );
      }
      return {
        conversationId: payload.conversationId,
        runId: payload.runId,
        messageId: payload.messageId ?? '',
        started: payload.started ?? 'started',
      };
    },

    /**
     * The run's events, as Server-Sent Events.
     *
     * Yielded as parsed frames rather than piped, for the reason the AgentOS relay is a parsing relay: the
     * caller has to see `run.completed` to know when to stop, and an interception point is needed for the
     * pause frames that carry a question or an approval.
     */
    async *streamEvents(input: {
      runId: string;
      conversationId: string;
      after?: number;
      workspaceId: string;
      userId: string;
    }): AsyncIterable<
      Record<string, unknown>
    > {
      const token = await config.token();
      const query = new URLSearchParams({ runId: input.runId, conversationId: input.conversationId });
      if (input.after !== undefined) query.set('after', String(input.after));

      let response: Response;
      try {
        response = await send(`${base}/api/events?${query.toString()}`, {
          // The same identity headers as a turn: the stream is as scoped as the run it reads.
          headers: {
            'X-API-Secret': token,
            'X-Workspace-Id': input.workspaceId,
            'X-User-Id': input.userId,
            'x-roles': SYSTEM_ROLE,
            accept: 'text/event-stream',
          },
          signal: withTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AgentkitUnavailable(
          `the agentkit event stream could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok || response.body === null) {
        throw new AgentkitUnavailable(`the agentkit event stream returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          /**
           * Split on the blank line, which is what terminates an SSE frame.
           *
           * A reader that split on every newline would emit half-frames for any event whose data spans lines,
           * and a run event carrying a message part routinely does.
           */
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n');
            // A comment frame — `: keep-alive` — has no data and is not an event.
            if (data !== '') {
              try {
                yield JSON.parse(data) as Record<string, unknown>;
              } catch {
                // A frame that is not JSON is the application's bug, not a reason to end a live turn.
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } finally {
        // Releasing matters: an abandoned reader holds the socket until the timeout fires.
        reader.releaseLock();
      }
    },

    /**
     * Call one tool directly — `POST /api/tools/:name`, the product's non-chat entry point.
     *
     * **Does not go through `post`**, and that is the whole design. `post` throws on any non-2xx,
     * which is right for a turn: a 404 means the wrong URL and a 500 means the application is
     * unwell. For a tool call a 4xx is a **result the caller must read** — a 422 carries the schema's
     * own field-level message, and a 403 says the tool is gated and names where the approval lives.
     * Throwing those away and reporting "the backend returned 422" would replace a useful message with
     * a useless one.
     *
     * A transport failure still throws, because that is not a result.
     */
    async callTool(input: {
      name: string;
      body: unknown;
      workspaceId: string;
      userId: string;
      idempotencyKey?: string;
    }): Promise<{ status: number; body: unknown }> {
      const headers = await identity(input.workspaceId, input.userId);
      let response: Response;
      try {
        response = await send(`${base}/api/tools/${encodeURIComponent(input.name)}`, {
          method: 'POST',
          headers: input.idempotencyKey === undefined ? headers : { ...headers, 'idempotency-key': input.idempotencyKey },
          body: JSON.stringify(input.body),
          signal: withTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new AgentkitUnavailable(
          `the agentkit application at ${base} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      /**
       * A 404 here is ambiguous in a way it is not on `/api/message`, and both readings matter: the
       * deployment may serve only the conversational surface, or the tool may not exist for this
       * principal. Returned rather than thrown, with the body, so the caller can say which.
       */
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
  };
};

export type AgentkitClient = ReturnType<typeof createAgentkitClient>;
