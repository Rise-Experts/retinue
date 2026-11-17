/**
 * A `RetinueClient` for `@retinue/react`, over this app's own proxy routes.
 *
 * The package is *headless state*: hooks plus a transport interface, and *"no product styling, no
 * transport assumptions."* This is the transport. It replaces roughly 480 lines of hand-rolled state —
 * `parseEvent`, `messageReducer` and `sse` — with the package's event buffer and reducers, which is the
 * point of adopting it: those three exist to fold a stream into messages, and the package does that
 * with an ordering buffer and a resumable cursor that the hand-rolled version never had.
 *
 * ## Why it goes through this app rather than straight to the backend
 *
 * The browser must not hold `SHARED_API_SECRET`. So every call here is to `/api/assistant/agentkit/*`,
 * which authenticates the *session*, resolves the workspace, and forwards with the secret server-side —
 * the same posture as every other route in this app.
 *
 * ## What the events are
 *
 * The platform's own `RunEvent`s, **untranslated**. `agentkitTurn.ts` translates them into the frame
 * shape the old Agno chat reads, and that layer exists only because the old UI was written against
 * Agno's stream. A client that speaks the platform's own vocabulary needs no translation, and the
 * translation is what the package's reducers replace.
 */

import type { ApprovalDecision, ConversationSummary, Message, RetinueClient, RunEvent } from '@retinue/react';

/** Where the proxy routes live. Relative, so it works in the browser without knowing the origin. */
const BASE = '/api/assistant/agentkit';

type Paged<T> = { readonly items: readonly T[]; readonly nextCursor?: string };

const asJson = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    /**
     * The server's own message when it sent one.
     *
     * These reach a person through the package's `error` state, so "that conversation is not yours"
     * beats "request failed" — and a generic message would send somebody looking at the network tab
     * for something the response already said.
     */
    const named = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof named === 'string' ? named : `the assistant service answered ${response.status}`);
  }
  return body;
};

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    /**
     * `0` is a value. `after=0` means "from the start", and treating it as absent is how a resumable
     * stream quietly becomes one that replays the turn on every reconnect.
     */
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
};

/**
 * One SSE stream, as an async iterable of platform events.
 *
 * Written here rather than reused from `sse.ts` because that module parses the *Agno* frame shape —
 * `event:` names the old runtime invented. This reads `data:` lines and hands the parsed object
 * straight to the package, which owns the ordering and the reducer.
 *
 * A frame that does not parse is **skipped, not thrown**: one malformed line must not end a run that is
 * still streaming, and the package's buffer will notice a missing sequence on its own.
 */
const streamEvents = async function* (
  url: string,
  /**
   * The **injected** fetch, not the global one.
   *
   * This read `fetch(url)` directly at first, which made the one method the whole chat depends on the
   * one method no test could drive. It surfaced as `Invalid URL`, because a relative path is fine for a
   * browser and not for Node's global fetch — a lucky failure: had the test used an absolute URL it
   * would have passed while testing nothing.
   */
  call: typeof fetch,
  signal?: AbortSignal,
): AsyncIterable<RunEvent> {
  const response = await call(url, { headers: { accept: 'text/event-stream' }, ...(signal ? { signal } : {}) });
  if (!response.ok || response.body === null) {
    await asJson(response);
    throw new Error('the event stream could not be opened');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; anything after the last one is a partial frame.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as RunEvent;
          } catch {
            // A malformed frame is skipped rather than fatal — see the note above.
          }
        }
      }
    }
  } finally {
    // Without this the connection stays open when a component unmounts mid-run.
    await reader.cancel().catch(() => undefined);
  }
};

/**
 * Answer a question, including a **multi-select** one.
 *
 * Separate from the client's own `answerQuestion` because the package's `RetinueClient` interface
 * declares `answers: Record<string, string>`, and the platform's `QuestionAnswer` is
 * `string | readonly string[]`. So the interface is *narrower than the runtime it fronts*: a question
 * marked `multiple` cannot be answered through it at all.
 *
 * Joining the choices into one string was the tempting alternative and it is wrong — the backend would
 * record `"instagram, linkedin"` as a single literal answer, and the model would be told the person
 * picked one option with a comma in its name. Refusing multi-select in the UI was the other, and it
 * would have hidden a capability the backend has.
 *
 * This posts to the same route the client's method posts to, so there is one endpoint and one
 * validator — the superset lives here, not in a second transport.
 */
export const answerQuestionWithLists = async (
  input: {
    readonly interactionId: string;
    readonly runId: string;
    readonly answers: Readonly<Record<string, string | readonly string[]>>;
  },
  call: typeof fetch = fetch,
): Promise<void> => {
  await asJson(
    await call(`${BASE}/interactions/${encodeURIComponent(input.interactionId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: input.runId, answers: input.answers }),
    }),
  );
};

/** What a paused run is waiting for, as the host reports it. */
export type PendingInteraction = {
  readonly approval?: {
    readonly interactionId: string;
    readonly toolName: string;
    readonly toolArgs: unknown;
    readonly riskCategory: string;
    readonly summary: string;
    readonly expiresAt: string;
    readonly estimatedCostMinorUnits?: number;
  };
  readonly question?: {
    readonly interactionId: string;
    readonly questions: readonly unknown[];
  };
};

/**
 * Read what a paused run is waiting for.
 *
 * Outside `RetinueClient` because the platform's client interface has no such method — and that is the
 * gap this closes. A run parks on a gated tool and the engine announces it as an *event*
 * (`approval.requested`, carrying an interaction id and nothing else), never as a message part, so a
 * card derived from `parts` finds nothing and the pause has no UI at all. The details live in the
 * interaction record; this is the read that gets them.
 *
 * Returns `{}` rather than throwing when the run turns out not to be waiting for anything: it is asked
 * on a status change, and a run that has already resumed is an ordinary race, not a failure.
 */
export const readPendingInteraction = async (
  input: { readonly runId: string },
  call: typeof fetch = fetch,
): Promise<PendingInteraction> => {
  const response = await call(`${BASE}/interactions/pending?runId=${encodeURIComponent(input.runId)}`);
  if (!response.ok) return {};
  return (await response.json().catch(() => ({}))) as PendingInteraction;
};

/** What the workspace has spent on the assistant, as the host reports it. */
export type AssistantUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMinorUnits: number;
  readonly currency: string;
  readonly turns: number;
  readonly days: number;
};

/**
 * Read the assistant's own usage.
 *
 * Separate from the credit meter in the app sidebar, which reads `workspaces.ai_credits_used` — a
 * counter only the web app's own AI routes increment. Assistant turns run in the new runtime and never
 * touch it, so the meter has not moved for any of them since the cutover; this reads what the platform
 * actually recorded.
 *
 * `null` rather than a throw when it cannot be read: a usage line that fails to load should disappear,
 * not take the chat with it.
 */
export const readAssistantUsage = async (
  input: { readonly days?: number } = {},
  call: typeof fetch = fetch,
): Promise<AssistantUsage | null> => {
  const days = input.days ?? 30;
  const response = await call(`${BASE}/usage?days=${encodeURIComponent(String(days))}`).catch(() => null);
  if (response === null || !response.ok) return null;
  const body = (await response.json().catch(() => null)) as AssistantUsage | null;
  return body === null || typeof body.turns !== "number" ? null : body;
};

/** How full the model's context window was on one turn. */
export type RunContextUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
  /** #630: the answering model's working window — `min(its window, 200k)`. What the bar is drawn against. */
  readonly contextLimit: number;
  /** #630: the answering model's full window and id, where older turns are condensed, and whether they are. */
  readonly contextWindow?: number;
  readonly modelId?: string;
  readonly compactAt?: number;
  readonly historyCondensed?: boolean;
  /** #499: Chorus credits the same turn (`?runId`) or chat (`?conversationId`) spent — 0 when none. */
  readonly credits?: number;
  readonly creditsScope?: "turn" | "conversation";
  /** #518: `inputTokens` is the last model call's input (the real context) only when this is true. */
  readonly contextMeasured?: boolean;
  /** #518: the turn's input across every model call — what it cost, not how big the context is. */
  readonly turnInputTokens?: number;
  readonly cachedInputTokens?: number;
  /** #552: what the prompt was made of, by source — recorded by the agent service per turn. */
  readonly contextSections?: { readonly instructionsTokens: number; readonly sections: readonly { readonly providerId: string; readonly tokens: number }[] };
};

/**
 * Read one run's token usage — the session-context meter.
 *
 * The **last step's** input tokens, which is the context size: each step re-sends the whole
 * conversation, so the host deliberately reports the last rather than the sum. `contextLimit` is the
 * answering model's working window (#630), the number the agent condenses and clears against.
 *
 * `null` rather than a throw: a meter that cannot load should disappear, not take the composer with it.
 */
export const readRunContext = async (
  input: { readonly runId: string } | { readonly conversationId: string },
  call: typeof fetch = fetch,
): Promise<RunContextUsage | null> => {
  /**
   * By run for a turn that just finished, by conversation for one just opened — whose stored messages
   * carry no run id. Without the second, the meter only ever appeared after you sent something.
   */
  const query =
    'runId' in input
      ? `runId=${encodeURIComponent(input.runId)}`
      : `conversationId=${encodeURIComponent(input.conversationId)}`;
  const response = await call(`${BASE}/usage?${query}`).catch(() => null);
  if (response === null || !response.ok) return null;
  const body = (await response.json().catch(() => null)) as RunContextUsage | null;
  return body === null || typeof body.inputTokens !== "number" || typeof body.contextLimit !== "number"
    ? null
    : body;
};

export type CreateRetinueClientInput = {
  /** Overridable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Aborts every stream this client opens. The chat passes its unmount signal. */
  readonly signal?: AbortSignal;
};

/** #543: a turn with what the chat box carries. The package's `sendMessage` knows only the first two. */
export type SendMessageInput = {
  conversationId: string;
  text: string;
  attachments?: readonly string[];
  references?: readonly { kind: 'post' | 'project_asset'; id: string; label: string }[];
  settings?: { mode: string; effort: string; model?: string };
};

/** The app's client: the package's contract, with the extras above on `sendMessage` and `decideApproval`. */
export type AppRetinueClient = RetinueClient & {
  sendMessage(input: SendMessageInput): Promise<{ runId: string }>;
  decideApproval(input: { interactionId: string; runId: string; decision: ApprovalDecision; conversationId?: string }): Promise<void>;
};

/* ---- #551 and #547: the model catalogue, and a chat's posts ---- */

export type ChatModel = { readonly id: string; readonly label: string; readonly source: 'chorus' | 'workspace'; readonly provider: string; readonly modelId: string };

export const readChatModels = async (): Promise<{ models: ChatModel[]; defaultId: string | null }> => {
  const response = await fetch(`${BASE}/models`, { cache: 'no-store' }).catch(() => null);
  if (response === null || !response.ok) return { models: [], defaultId: null };
  const body = (await response.json().catch(() => null)) as { models?: ChatModel[]; defaultId?: string } | null;
  return { models: Array.isArray(body?.models) ? body!.models : [], defaultId: typeof body?.defaultId === 'string' ? body.defaultId : null };
};

export type ChatPost = {
  readonly id: string;
  readonly caption: string;
  readonly status: string;
  readonly platforms: readonly string[];
  readonly mediaCount: number;
  readonly updatedAt: string;
  readonly scheduledAt: string | null;
  readonly projectId: string | null;
};

export const readChatPosts = async (
  conversationId: string | 'recent',
  options: { readonly throwOnError?: boolean } = {},
): Promise<ChatPost[]> => {
  const query = conversationId === 'recent' ? 'recent=1' : `conversationId=${encodeURIComponent(conversationId)}`;
  const response = await fetch(`/api/assistant/conversation-posts?${query}`, { cache: 'no-store' }).catch(() => null);
  // #628: the cached Posts pane asks to hear about a failure, so a network blip keeps the last list instead of emptying it.
  if (response === null || !response.ok) {
    if (options.throwOnError === true) throw new Error('posts_unavailable');
    return [];
  }
  const body = (await response.json().catch(() => null)) as { posts?: ChatPost[] } | null;
  return Array.isArray(body?.posts) ? body!.posts : [];
};

export const createRetinueClient = (input: CreateRetinueClientInput = {}): AppRetinueClient => {
  const call = input.fetchImpl ?? fetch;

  return {
    async listConversations({ includeArchived, cursor }) {
      const body = (await asJson(
        await call(`${BASE}/conversations${query({ cursor, includeArchived: includeArchived ? 1 : undefined })}`),
      )) as Paged<ConversationSummary>;
      return { items: body.items ?? [], ...(body.nextCursor === undefined ? {} : { nextCursor: body.nextCursor }) };
    },

    async listMessages({ conversationId, cursor }) {
      const body = (await asJson(
        await call(`${BASE}/conversations/${encodeURIComponent(conversationId)}/messages${query({ cursor })}`),
      )) as Paged<Message>;
      return { items: body.items ?? [], ...(body.nextCursor === undefined ? {} : { nextCursor: body.nextCursor }) };
    },

    async sendMessage(input: SendMessageInput) {
      const { conversationId, text } = input;
      const body = (await asJson(
        await call(`${BASE}/turns`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /*
           * #543: what the chat box carries besides the text — files (#549), `@` references (#548), and
           * the chat's mode, model and effort (#550, #551). The route checks each against the workspace.
           */
          body: JSON.stringify({
            conversationId,
            message: text,
            ...(input.attachments === undefined || input.attachments.length === 0 ? {} : { attachments: input.attachments }),
            ...(input.references === undefined || input.references.length === 0 ? {} : { references: input.references }),
            ...(input.settings === undefined ? {} : { settings: input.settings }),
          }),
        }),
      )) as { runId?: unknown };
      const runId = typeof body.runId === 'string' ? body.runId : '';
      if (runId === '') {
        /**
         * A turn with no run id cannot be subscribed to, so it would render as a message that never
         * answers. Failing here says so while the send button is still the thing the person touched.
         */
        throw new Error('the turn started but did not say which run to follow');
      }
      return { runId };
    },

    async cancelRun({ runId }) {
      await asJson(
        await call(`${BASE}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
      );
    },

    async answerQuestion({ interactionId, runId, answers }) {
      await asJson(
        await call(`${BASE}/interactions/${encodeURIComponent(interactionId)}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId, answers }),
        }),
      );
    },

    async decideApproval(input: { interactionId: string; runId: string; decision: ApprovalDecision; conversationId?: string }) {
      const { interactionId, runId, decision } = input;
      await asJson(
        await call(`${BASE}/interactions/${encodeURIComponent(interactionId)}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /*
           * The conversation goes with the decision: "allow for this chat" is a grant scoped to it, and the
           * agent service refuses that decision without one. It was never sent, so the button always failed.
           */
          body: JSON.stringify({
            runId,
            decision: decision satisfies ApprovalDecision,
            ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          }),
        }),
      );
    },

    subscribeRun({ runId, conversationId, after }) {
      /**
       * `after` is the resumable cursor, and passing it through is the whole reason the package's buffer
       * can promise that *"a reconnect misses or duplicates no part"*. The hand-rolled version
       * reconnected from zero and re-rendered the turn.
       */
      return streamEvents(`${BASE}/events${query({ runId, conversationId, after })}`, call, input.signal);
    },
  };
};
