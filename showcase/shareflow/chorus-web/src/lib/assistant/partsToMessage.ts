/**
 * `MessagePart[]` → `AssistantChatMessage`, so the original chat UI renders the new runtime.
 *
 * The chat's presentation layer — `MessageList`, `AssistantMessage`, `Markdown`, `ToolChips`,
 * `ReasoningSteps`, `ReferenceCards`, the avatars, the thinking loader — was written against
 * `AssistantChatMessage`, which `messageReducer.ts` used to fold out of Agno's frames. That reducer is
 * gone with `ai_backend`; the parts now come from `@retinue/react`'s own reducer, already ordered and
 * deduplicated.
 *
 * So this is a **shape** adapter and nothing more. It replaces ~160 lines of stream folding with a
 * pure function over a settled array, which is the whole benefit of the package doing the folding: the
 * hard part (ordering, resumption, deduplication) is upstream, and what is left is naming fields.
 *
 * Writing a new renderer against `MessagePart` instead was the alternative, and it would have meant
 * reimplementing markdown, mermaid, tool chips, media galleries and post previews to get back to where
 * the product already was. The user's requirement was that it work as it did before; the shortest
 * honest route to that is to keep the components and translate the data.
 */

import type { MessagePart } from '@retinue/react';

import type { AssistantChatMessage, ReasoningStep, ToolCallView, ReferenceGroup } from './chatMessage';

/** #555: tools whose result the transcript draws as a card, so their output is kept on the chip. */
const CARD_TOOLS: ReadonlySet<string> = new Set(['propose_project_setup']);

/** Where a `tool-result` says the work actually happened, when that differs from the call. */
const ranName = (part: Extract<MessagePart, { type: 'tool-result' }>): string =>
  /**
   * `ranToolName` when present, because `execute_tool` names its target: the call the model made and
   * the action performed are two different things, and the second is the one a reader needs. Every
   * tool outside the preloaded few is now reached that way, so without this the transcript would
   * report `execute_tool` for almost everything the assistant does.
   */
  part.ranToolName ?? part.toolName;

const errorOf = (output: unknown): string | undefined => {
  if (output === null || typeof output !== 'object') return undefined;
  const envelope = output as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return undefined;
  const error = envelope.error;
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : 'that tool failed';
};

export type PartsToMessageInput = {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly MessagePart[];
  readonly createdAt?: number;
  /** Resolves a `fileId` to something an `<img>` can load. Absent means images are skipped. */
  readonly mediaUrl?: (fileId: string) => string | undefined;
};

/**
 * The id the platform gives the error part it writes when a tool call pauses for approval.
 *
 * A gated call is recorded, then interrupted, then re-executed once a person decides — so a *successful*
 * publish leaves this behind in the middle of the turn:
 *
 *   { id: "F5v6WGdKyq2Llm40:interrupted", type: "error",
 *     error: { code: "cancelled", message: "Tool call 'publish_post_now' was interrupted before it
 *     completed" } }
 *
 * Rendered as-is that is a red error under an answer that worked, which reads as a publish that half
 * happened. Seen in a real approved run against a local worker, not deduced.
 */
const INTERRUPTED_SUFFIX = ':interrupted';

/** The call id an `:interrupted` error part belongs to. */
const interruptedCallId = (part: MessagePart): string | undefined => {
  const id = String((part as { id?: unknown }).id ?? '');
  return part.type === 'error' && id.endsWith(INTERRUPTED_SUFFIX)
    ? id.slice(0, -INTERRUPTED_SUFFIX.length)
    : undefined;
};

export const partsToChatMessage = (input: PartsToMessageInput): AssistantChatMessage => {
  /**
   * Which interrupted calls were **settled** — by a result, or by the assistant explaining.
   *
   * An interruption followed by a result is the approval loop working: the call paused, a person said
   * yes, it ran. An interruption followed by prose is the same loop with the other answer: seen in a
   * real denied approval, where the model said "I was unable to send your reply — the tool reported
   * that the action was denied" and the transcript *also* carried a red "Tool call 'reply_to_comment'
   * was interrupted before it completed". Two messages for one outcome, and the alarming one is the
   * one that explains nothing.
   *
   * What stays visible is an interruption with nothing after it at all — a run cancelled or lost
   * mid-tool. There the notice is the only account of what happened.
   */
  const settled = new Set<string>();
  for (const [index, part] of input.parts.entries()) {
    if (part.type !== 'error') continue;
    const callId = interruptedCallId(part);
    if (callId === undefined) continue;
    /**
     * "Explained" has to be about *this* call, and prose is only about it while nothing else has run.
     *
     * Three arms, and the middle one is the fix.
     *
     *  - **A result under the same id.** Sound as it was: the call was interrupted, then it ran.
     *  - **Prose, but only immediately after.** The old rule accepted any later non-empty `text` part
     *    for any call id. Measured: a gated `publish_post_now` interrupted before it ran, then a
     *    successful `search_web`, then "I searched the web and found three articles…" — the publish
     *    notice was suppressed and its chip left reading *running*, so a tool that never executed was
     *    reported as in progress under prose about something else. A trailing `.` sufficed.
     *
     *    A model's sentence describes what it just did, so it is evidence about this call only while
     *    no *other* tool activity sits between the interruption and the sentence. That keeps the case
     *    the rule was written for — a **denied** approval, where there is no result and the model says
     *    so in prose — and rejects prose that has moved on to something else. The length floor is
     *    there because "." is not an account of anything; twenty characters is arbitrary, and picked
     *    to be shorter than any real sentence and longer than any punctuation.
     *  - **A retry.** A call reissued under a fresh id, which is what an approval round trip looks
     *    like, is explained by the tool running. Matched on the tool *name*, because the id changes.
     */
    const laterParts = input.parts.slice(index + 1);
    const interrupted = input.parts
      .slice(0, index)
      .find((earlier) => earlier.type === 'tool-call' && String(earlier.toolCallId) === callId);
    const retriedName = interrupted !== undefined && interrupted.type === 'tool-call' ? interrupted.toolName : undefined;

    const otherToolActivityAt = laterParts.findIndex(
      (later) =>
        (later.type === 'tool-call' || later.type === 'tool-result') && String(later.toolCallId) !== callId,
    );
    const proseWindow = otherToolActivityAt === -1 ? laterParts : laterParts.slice(0, otherToolActivityAt);
    const MIN_EXPLANATION_CHARS = 20;

    const explained =
      laterParts.some((later) => later.type === 'tool-result' && String(later.toolCallId) === callId) ||
      proseWindow.some((later) => later.type === 'text' && later.text.trim().length >= MIN_EXPLANATION_CHARS) ||
      (retriedName !== undefined &&
        laterParts.some(
          (later) =>
            (later.type === 'tool-call' || later.type === 'tool-result') && later.toolName === retriedName,
        ));
    if (explained) settled.add(callId);
  }
  const texts: string[] = [];
  const reasoningSteps: ReasoningStep[] = [];
  const toolCalls: ToolCallView[] = [];
  const references: ReferenceGroup[] = [];
  const images: { url: string; revisedPrompt?: string }[] = [];
  let streamingError: string | undefined;

  for (const part of input.parts) {
    switch (part.type) {
      case 'text':
        texts.push(part.text);
        break;

      case 'reasoning':
        /**
         * `redacted` reasoning is kept as a step with no body rather than dropped.
         *
         * A provider that redacts its thinking still tells you it thought; showing nothing would read
         * as a model that answered without considering anything.
         */
        reasoningSteps.push({
          title: 'Thinking',
          ...(part.redacted === true ? {} : { reasoning: part.text }),
        });
        break;

      case 'tool-call':
        toolCalls.push({
          toolCallId: String(part.toolCallId),
          toolName: part.toolName,
          ...(part.input !== null && typeof part.input === 'object'
            ? { toolArgs: part.input as Record<string, unknown> }
            : {}),
          status: 'running',
        });
        break;

      case 'tool-result': {
        const id = String(part.toolCallId);
        const failure = errorOf(part.output);
        const existing = toolCalls.find((call) => call.toolCallId === id);
        if (existing === undefined) {
          // A result with no call before it — possible after a resume, where the call was in an
          // earlier page. Recorded rather than dropped: the work happened.
          toolCalls.push({
            toolCallId: id,
            toolName: ranName(part),
            status: failure === undefined ? 'done' : 'error',
            ...(failure === undefined ? {} : { errorText: failure }),
            ...(failure === undefined && CARD_TOOLS.has(ranName(part)) ? { output: part.output } : {}),
          });
          break;
        }
        existing.status = failure === undefined ? 'done' : 'error';
        existing.toolName = ranName(part);
        if (failure !== undefined) existing.errorText = failure;
        if (failure === undefined && CARD_TOOLS.has(existing.toolName)) existing.output = part.output;
        break;
      }

      case 'citation':
        /**
         * Citations and sources both land in `references`, which is the one card the old UI had for
         * "where this came from". Grouped under the excerpt's origin so the card can name it.
         */
        references.push({
          query: part.origin.kind === 'retrieval' ? 'From your documents' : 'From the web',
          references: [{ name: part.origin.kind === 'retrieval' ? 'Document' : 'Web page', content: part.excerpt }],
        });
        break;

      case 'source':
        references.push({
          query: 'Sources',
          references: [{ name: part.title, content: part.url ?? part.title, ...(part.url === undefined ? {} : { metaData: { url: part.url } }) }],
        });
        break;

      case 'image': {
        const url = input.mediaUrl?.(String(part.fileId));
        if (url !== undefined) images.push({ url, ...(part.altText === undefined ? {} : { revisedPrompt: part.altText }) });
        break;
      }

      case 'error': {
        /**
         * The platform's own message, and the retry hint appended.
         *
         * `streamingError` is what the old UI rendered under a reply, so a run that failed mid-answer
         * shows the text it managed plus why it stopped — rather than the text alone, which reads as a
         * complete answer.
         *
         * The exception is an approval pause that was then approved: the interruption is bookkeeping,
         * the re-execution is the outcome, and its chip already says so.
         */
        const interrupted = interruptedCallId(part);
        if (interrupted !== undefined && settled.has(interrupted)) break;
        streamingError = part.error.retryable ? `${part.error.message} (retryable)` : part.error.message;
        break;
      }

      case 'status':
        // Progress narration. The thinking loader already covers "something is happening", and a
        // status line in the prose would read as part of the answer.
        break;

      case 'file':
      case 'question':
      case 'approval':
      case 'artifact':
      case 'structured':
        /**
         * Handled outside the message body.
         *
         * Approvals render as the permission card in the list's footer, artifacts open in the side
         * panel, and questions are answered by their own form — all of which need the run id and
         * therefore live in the chat rather than in a per-message shape. Files carry no URL of their
         * own here; `image` is the arm with something to show.
         */
        break;
    }
  }

  return {
    role: input.role,
    text: texts.join(''),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(streamingError === undefined ? {} : { streamingError }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(reasoningSteps.length === 0 ? {} : { reasoningSteps }),
    ...(references.length === 0 ? {} : { references }),
    ...(images.length === 0 ? {} : { images }),
  };
};

/**
 * The first `question` or `approval` still awaiting an answer, with the ids needed to answer it.
 *
 * Pulled out separately because answering needs the **run**, which a message shape has no field for.
 * `answeredAt`/`decidedAt` are what make a part historical, so a transcript scrolled back to an
 * answered question shows the record rather than a live form.
 */
export const pendingInteractionIn = (
  parts: readonly MessagePart[],
):
  | { readonly kind: 'question'; readonly part: Extract<MessagePart, { type: 'question' }> }
  | { readonly kind: 'approval'; readonly part: Extract<MessagePart, { type: 'approval' }> }
  | undefined => {
  for (const part of parts) {
    if (part.type === 'question' && part.answeredAt === undefined) return { kind: 'question', part };
    if (part.type === 'approval' && part.decidedAt === undefined) return { kind: 'approval', part };
  }
  return undefined;
};

/** Every artifact the turn produced, newest last — the side panel opens the one a person clicks. */
export const artifactsIn = (parts: readonly MessagePart[]): readonly { id: string; title: string }[] =>
  parts.flatMap((part) =>
    part.type === 'artifact' ? [{ id: String(part.artifactId ?? part.versionId), title: part.title }] : [],
  );

/** One turn started in this session: the message sent, and what the run has produced so far. */
export type LocalTurn = {
  readonly runId: string;
  readonly userText: string;
  readonly parts: readonly MessagePart[];
  /** True once the run can produce nothing further — completed, failed or cancelled. */
  readonly settled?: boolean;
  /**
   * The run's own failure, when it has one and the parts do not.
   *
   * A run can fail carrying **no parts at all**: three empty candidates in a row ends it with a message
   * naming exactly that, and the transcript would otherwise fall back to `EMPTY_TURN_NOTICE` — "the
   * assistant finished without producing an answer" — while the sentence a person could act on sat in
   * the worker's log. Observed while testing a reply end to end.
   */
  readonly error?: string;
};

/**
 * What a finished-but-empty turn says.
 *
 * A run can complete having produced **no parts at all**: no text, no tool call, no error. The
 * platform's `finish` handler reads `totalUsage` and never inspects `finishReason`, so a model call
 * that returns an empty candidate ends the turn as a success. From the app that is indistinguishable
 * from a broken assistant — the message is sent, nothing appears, and there is nothing to retry
 * because nothing looks wrong.
 *
 * This is not the root cause and does not pretend to be. It is the difference between a person seeing
 * "it did nothing" and seeing "it produced no answer — send it again", which is the difference between
 * a bug report and a retry.
 */
export const EMPTY_TURN_NOTICE = 'The assistant finished without producing an answer. Try sending that again.';

/** A message as the store returns it. Narrowed to what the transcript needs. */
export type StoredMessage = {
  readonly role: string;
  readonly parts: readonly MessagePart[];
  readonly createdAt?: string;
};

/**
 * The whole transcript: the stored history, then every turn this session started.
 *
 * A pure function because the bug it fixes was invisible in the component. The chat kept a **single**
 * live turn, so sending a second message replaced the first — and with no `refresh` on
 * `useConversation` the store could not supply the lost one either, so the transcript visibly emptied
 * above the newest message until a reload. One turn worked, two did not, and every test I had used
 * one.
 *
 * `turns` accumulates instead, and this function is where that is asserted. The component now only
 * holds the array; the assembly is here, where it can be tested without a DOM.
 */
export const transcriptFrom = (input: {
  readonly stored: readonly StoredMessage[];
  readonly turns: readonly LocalTurn[];
  readonly mediaUrl?: (fileId: string) => string | undefined;
}): AssistantChatMessage[] => [
  ...input.stored.map((message) =>
    partsToChatMessage({
      role: message.role === 'user' ? 'user' : 'assistant',
      parts: message.parts,
      ...(input.mediaUrl === undefined ? {} : { mediaUrl: input.mediaUrl }),
      ...(message.createdAt === undefined
        ? {}
        : { createdAt: Math.floor(new Date(message.createdAt).getTime() / 1000) }),
    }),
  ),
  ...input.turns.flatMap((turn): AssistantChatMessage[] => {
    const answer = partsToChatMessage({
      role: 'assistant',
      parts: turn.parts,
      ...(input.mediaUrl === undefined ? {} : { mediaUrl: input.mediaUrl }),
    });
    /**
     * A settled turn that produced nothing says so.
     *
     * Only once settled: an empty bubble mid-stream is the thinking loader's job, and labelling it
     * early would flash "no answer" at every turn before its first token.
     */
    const producedNothing =
      turn.settled === true &&
      answer.text.trim() === '' &&
      answer.toolCalls === undefined &&
      answer.streamingError === undefined;

    /**
     * A settled turn's own failure reason, whether or not it managed to say anything first.
     *
     * `producedNothing` was the *only* route by which `turn.error` reached the screen, and it requires
     * both no text and no tool calls. So the two most common ways a run dies both lost their reason
     * entirely:
     *
     *  - **died mid-tool.** Measured: a turn with one `tool-call` part and
     *    `error: 'run failed: worker lost the lease…'` produced `streamingError: undefined` and left
     *    that chip at `status: 'running'` — forever, since nothing leaves 'running' without a
     *    `tool-result`. That is the spinner that never stops, with no error anywhere on screen.
     *  - **partial prose.** A turn that streamed "Here is the draft: " and then failed rendered as a
     *    complete answer ending in a colon.
     *
     * `RetinueChat` says the transcript is the only place a finished run's reason exists, so losing it
     * here loses it altogether. Surfaced only once settled — mid-stream that is the loader's job — and
     * only when nothing more specific is already showing, so a per-part error still wins.
     */
    const settledError =
      turn.settled === true && turn.error !== undefined && turn.error !== '' ? turn.error : undefined;

    /**
     * And the chips stop spinning.
     *
     * A tool call with no result never leaves `running`, which is correct while a run is live and a
     * lie once it has settled: the call did not complete, and it is not going to. Marked `failed`
     * with the run's own reason so the row says what happened rather than implying work in progress.
     */
    const withStalledCallsFailed = (view: typeof answer): typeof answer =>
      settledError === undefined || view.toolCalls === undefined
        ? view
        : {
            ...view,
            toolCalls: view.toolCalls.map((call) =>
              // 'error' and `errorText`, matching what a real tool failure produces — so the chip renders
              // through the same path rather than a second shape the components do not know.
              call.status === 'running' ? { ...call, status: 'error' as const, errorText: settledError } : call,
            ),
          };
    /**
     * The run's own message first, and the generic notice only when there is none.
     *
     * A failed run often carries its reason nowhere else — an exhausted empty-candidate retry says
     * precisely what happened and produces no parts at all — and "finished without producing an
     * answer" is strictly less than that.
     */
    const nothingSaid = settledError ?? EMPTY_TURN_NOTICE;
    const rendered = producedNothing
      ? { ...answer, streamingError: nothingSaid }
      : withStalledCallsFailed(
          answer.streamingError === undefined && settledError !== undefined
            ? { ...answer, streamingError: settledError }
            : answer,
        );
    return [{ role: 'user', text: turn.userText }, rendered];
  }),
];
