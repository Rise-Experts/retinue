/**
 * `MessagePart[]` → the chat's own message shape, and the transcript built from it.
 *
 * The test that matters most here is the second-turn one. The chat held a **single** live turn, so
 * sending a second message replaced the first — and because `useConversation` exposes no `refresh`,
 * the store could not supply the lost turn either. The transcript visibly emptied above the newest
 * message until a reload. It was reported from the running app, not by anything here, because every
 * test I had used one turn and one turn worked.
 *
 * That is why the assembly is a pure function now: the component holds the array and this file
 * asserts what comes out of it, without needing a DOM the suite does not have.
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_TURN_NOTICE,
  artifactsIn,
  partsToChatMessage,
  pendingInteractionIn,
  transcriptFrom,
} from '../partsToMessage';
import type { MessagePart } from '@retinue/react';

const part = (over: Record<string, unknown>): MessagePart =>
  ({ id: `p${Math.random()}`, schemaVersion: 1, createdAt: '2026-09-09T00:00:00Z', ...over }) as MessagePart;

const text = (value: string) => part({ type: 'text', text: value });

describe('transcriptFrom — turns accumulate', () => {
  it('keeps every earlier turn when a new one starts', () => {
    /**
     * The regression. Two turns in, the transcript must hold four messages — user, assistant, user,
     * assistant — and the first answer must still be there. With the old single-slot state the first
     * pair disappeared entirely.
     */
    const transcript = transcriptFrom({
      stored: [],
      turns: [
        { runId: 'r1', userText: 'first question', parts: [text('first answer')] },
        { runId: 'r2', userText: 'second question', parts: [text('second answer')] },
      ],
    });

    expect(transcript.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ]);
  });

  it('puts the stored history before the turns from this session', () => {
    const transcript = transcriptFrom({
      stored: [
        { role: 'user', parts: [text('yesterday')], createdAt: '2026-09-08T10:00:00Z' },
        { role: 'assistant', parts: [text('yesterday answered')] },
      ],
      turns: [{ runId: 'r1', userText: 'today', parts: [text('today answered')] }],
    });

    expect(transcript.map((m) => m.text)).toEqual(['yesterday', 'yesterday answered', 'today', 'today answered']);
    // Seconds, because `DateSeparator` takes seconds — milliseconds would render 1970.
    expect(transcript[0]!.createdAt).toBe(Math.floor(new Date('2026-09-08T10:00:00Z').getTime() / 1000));
  });

  it('shows a turn that has produced nothing yet as an empty assistant bubble', () => {
    // What the thinking loader hangs off: the bubble exists before the first token arrives.
    const transcript = transcriptFrom({ stored: [], turns: [{ runId: 'r1', userText: 'hello', parts: [] }] });
    expect(transcript).toHaveLength(2);
    expect(transcript[1]).toEqual({ role: 'assistant', text: '' });
  });

  it('is just the history when this session has started no turns', () => {
    const transcript = transcriptFrom({ stored: [{ role: 'user', parts: [text('only stored')] }], turns: [] });
    expect(transcript.map((m) => m.text)).toEqual(['only stored']);
  });
});

describe('partsToChatMessage', () => {
  it('joins streamed text in order', () => {
    expect(partsToChatMessage({ role: 'assistant', parts: [text('Hello '), text('world')] }).text).toBe('Hello world');
  });

  it('marks a tool call running, then done when its result arrives', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'list_accounts', input: { limit: 5 } }),
        part({ type: 'tool-result', toolCallId: 'c1', toolName: 'list_accounts', output: { ok: true }, truncated: false }),
      ],
    });
    expect(message.toolCalls).toEqual([
      { toolCallId: 'c1', toolName: 'list_accounts', toolArgs: { limit: 5 }, status: 'done' },
    ]);
  });

  it('prefers ranToolName, so the chip names the work and not execute_tool', () => {
    /**
     * Every tool outside the preloaded two is reached through `execute_tool`, so without this the
     * transcript would report "execute_tool" for almost everything the assistant does.
     */
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'execute_tool', input: { name: 'render_diagram' } }),
        part({
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'execute_tool',
          ranToolName: 'render_diagram',
          output: { ok: true },
          truncated: false,
        }),
      ],
    });
    expect(message.toolCalls?.[0]?.toolName).toBe('render_diagram');
  });

  it('surfaces a failed tool as an error on the chip rather than dropping it', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'publish_post_now', input: {} }),
        part({
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'publish_post_now',
          output: { ok: false, error: { message: 'that account is disconnected' } },
          truncated: false,
        }),
      ],
    });
    expect(message.toolCalls?.[0]?.status).toBe('error');
    expect(message.toolCalls?.[0]?.errorText).toBe('that account is disconnected');
  });

  it('records a result whose call was never seen, since the work still happened', () => {
    // Possible after a resume, where the call arrived in an earlier page of events.
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [part({ type: 'tool-result', toolCallId: 'c9', toolName: 'list_leads', output: { ok: true }, truncated: false })],
    });
    expect(message.toolCalls).toEqual([{ toolCallId: 'c9', toolName: 'list_leads', status: 'done' }]);
  });

  it('keeps redacted reasoning as a step with no body', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [part({ type: 'reasoning', text: 'hidden', redacted: true })],
    });
    // A provider that redacts still tells you it thought; showing nothing reads as no thought at all.
    expect(message.reasoningSteps).toEqual([{ title: 'Thinking' }]);
  });

  it('appends the retry hint to an error, so "try again" is distinguishable from "this will not work"', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [text('partial'), part({ type: 'error', error: { code: 'x', message: 'the model timed out', retryable: true } })],
    });
    expect(message.text).toBe('partial');
    expect(message.streamingError).toBe('the model timed out (retryable)');
  });

  it('skips an image when nothing can resolve its file id', () => {
    // Better no image than a broken one: `<img src="undefined">` renders as a broken-image icon.
    const parts = [part({ type: 'image', fileId: 'f1', mediaType: 'image/png' })];
    expect(partsToChatMessage({ role: 'assistant', parts }).images).toBeUndefined();
    expect(partsToChatMessage({ role: 'assistant', parts, mediaUrl: () => 'https://x/y.png' }).images).toEqual([
      { url: 'https://x/y.png' },
    ]);
  });
});

/**
 * An approved tool call, which leaves an interruption behind it.
 *
 * The approval loop records the gated call, writes an `<id>:interrupted` error part when the run pauses,
 * and re-executes the call once a person decides. So a publish that *worked* carries an error part in
 * the middle of the turn saying the call "was interrupted before it completed" — and rendering that
 * under the answer tells the user their post half-published. Taken from a real approved run.
 */
describe('an approval pause', () => {
  it('is not shown as an error once the call came back', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'publish_post_now', input: {} }),
        part({
          id: 'c1:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'publish_post_now' was interrupted before it completed", retryable: false },
        }),
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'publish_post_now', input: {} }),
        part({ type: 'tool-result', toolCallId: 'c1', toolName: 'publish_post_now', output: { ok: true }, truncated: false }),
        text('Published to Instagram.'),
      ],
    });

    expect(message.streamingError).toBeUndefined();
    expect(message.text).toBe('Published to Instagram.');
  });

  it('is not shown when the assistant explained the outcome instead', () => {
    /**
     * A **denied** approval, from a real run: no tool result, and the model saying so in prose. The
     * transcript used to carry both that sentence and a red "was interrupted before it completed" —
     * two messages for one outcome, and the alarming one explained nothing.
     */
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'reply_to_comment', input: {} }),
        part({
          id: 'c1:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'reply_to_comment' was interrupted before it completed", retryable: false },
        }),
        text('I was unable to send your reply. The tool reported that the action was denied.'),
      ],
    });

    expect(message.streamingError).toBeUndefined();
    expect(message.text).toContain('denied');
  });

  it('is still shown when the call never came back', () => {
    // A run cancelled while a tool was in flight. That interruption is the outcome, and hiding it
    // would leave an answer that stops mid-sentence with nothing saying why.
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'publish_post_now', input: {} }),
        part({
          id: 'c1:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'publish_post_now' was interrupted before it completed", retryable: false },
        }),
      ],
    });

    expect(message.streamingError).toContain('interrupted');
  });

  it('does not hide an unrelated failure just because some other call succeeded', () => {
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-result', toolCallId: 'c1', toolName: 'list_accounts', output: { ok: true }, truncated: false }),
        part({ type: 'error', error: { code: 'internal', message: 'the model timed out', retryable: true } }),
      ],
    });

    expect(message.streamingError).toBe('the model timed out (retryable)');
  });
});

describe('pendingInteractionIn', () => {
  it('finds an unanswered question and ignores an answered one', () => {
    const answered = part({ type: 'question', interactionId: 'i1', questions: [], answeredAt: '2026-09-09T00:00:00Z' });
    const open = part({ type: 'question', interactionId: 'i2', questions: [{ key: 'k', prompt: 'which?' }] });
    expect(pendingInteractionIn([answered])).toBeUndefined();
    expect(pendingInteractionIn([answered, open])?.kind).toBe('question');
  });

  it('finds an undecided approval and ignores a decided one', () => {
    const decided = part({ type: 'approval', interactionId: 'a1', toolName: 't', summary: 's', riskCategory: 'publish', decidedAt: 'x' });
    const open = part({ type: 'approval', interactionId: 'a2', toolName: 'publish_post_now', summary: 's', riskCategory: 'publish' });
    expect(pendingInteractionIn([decided])).toBeUndefined();
    expect(pendingInteractionIn([decided, open])?.kind).toBe('approval');
  });
});

describe('artifactsIn', () => {
  it('lists artifacts in order, so the newest can be opened', () => {
    const parts = [
      part({ type: 'artifact', artifactId: 'a1', versionId: 'v1', title: 'First' }),
      part({ type: 'artifact', artifactId: 'a2', versionId: 'v2', title: 'Second' }),
    ];
    expect(artifactsIn(parts).map((a) => a.title)).toEqual(['First', 'Second']);
  });
});

/**
 * A finished turn that produced nothing must say so.
 *
 * A run can complete with no parts at all — no text, no tool call, no error — because the platform's
 * `finish` handler reads `totalUsage` and never inspects `finishReason`, so an empty model candidate
 * ends the turn as a success. From the app that looks exactly like a broken assistant: the message is
 * sent, nothing appears, and there is nothing to retry because nothing looks wrong.
 *
 * This does not fix the cause. It makes the failure legible, which is the difference between a person
 * filing a bug and a person pressing send again.
 */
describe('a settled turn that produced nothing', () => {
  it('is labelled once the run has settled', () => {
    const transcript = transcriptFrom({
      stored: [],
      turns: [{ runId: 'r1', userText: 'show me my drafts', parts: [], settled: true }],
    });
    expect(transcript[1]?.streamingError).toBe(EMPTY_TURN_NOTICE);
  });

  it("shows the run's own reason when it has one", () => {
    /**
     * A failed run often carries its reason nowhere else. An exhausted empty-candidate retry ends the
     * run with a sentence naming exactly what happened and produces **no parts at all** — and the
     * transcript showed "finished without producing an answer" instead, while the useful message sat
     * in the worker's log. Seen while testing a comment reply end to end.
     */
    const transcript = transcriptFrom({
      stored: [],
      turns: [
        {
          runId: 'r1',
          userText: 'reply to that comment',
          parts: [],
          settled: true,
          error: 'The model returned no content three times in a row.',
        },
      ],
    });
    expect(transcript[1]?.streamingError).toBe('The model returned no content three times in a row.');
  });

  it('falls back to the generic notice when the run said nothing either', () => {
    const transcript = transcriptFrom({
      stored: [],
      turns: [{ runId: 'r1', userText: 'hello', parts: [], settled: true, error: '' }],
    });
    expect(transcript[1]?.streamingError).toBe(EMPTY_TURN_NOTICE);
  });

  it('prefers an error part over the run error, since the part is closer to the work', () => {
    // A part names the step that failed; a run error names the run. The narrower one is more use.
    const transcript = transcriptFrom({
      stored: [],
      turns: [
        {
          runId: 'r1',
          userText: 'go',
          settled: true,
          error: 'the run failed',
          parts: [part({ type: 'error', error: { code: 'x', message: 'that tool is not configured', retryable: false } })],
        },
      ],
    });
    expect(transcript[1]?.streamingError).toBe('that tool is not configured');
  });

  it('is NOT labelled while the run is still going', () => {
    // Mid-stream an empty bubble is the thinking loader's job; labelling early would flash on every turn.
    const transcript = transcriptFrom({ stored: [], turns: [{ runId: 'r1', userText: 'hi', parts: [] }] });
    expect(transcript[1]?.streamingError).toBeUndefined();
  });

  it('is not labelled when the turn produced a tool call but no prose', () => {
    // A tool ran: something happened, and the chip says what. That is not an empty turn.
    const transcript = transcriptFrom({
      stored: [],
      turns: [
        {
          runId: 'r1',
          userText: 'list them',
          settled: true,
          parts: [part({ type: 'tool-call', toolCallId: 'c1', toolName: 'list_accounts', input: {} })],
        },
      ],
    });
    expect(transcript[1]?.streamingError).toBeUndefined();
  });

  it('leaves a real error in place rather than replacing it', () => {
    const transcript = transcriptFrom({
      stored: [],
      turns: [
        {
          runId: 'r1',
          userText: 'go',
          settled: true,
          parts: [part({ type: 'error', error: { code: 'x', message: 'the model refused', retryable: false } })],
        },
      ],
    });
    expect(transcript[1]?.streamingError).toBe('the model refused');
  });
});

/**
 * A settled run's failure reason must reach the screen, and its chips must stop spinning.
 *
 * `turn.error` had exactly one route out of here: the `producedNothing` branch, which requires **no
 * text and no tool calls**. So the two commonest ways a run dies both lost their reason entirely, and
 * `RetinueChat` notes that the transcript is the only place a finished run's reason exists — losing it
 * here loses it altogether.
 */
describe("a run that failed after it had already said something", () => {
  const answerOf = (turn: Record<string, unknown>) =>
    transcriptFrom({ stored: [], turns: [{ runId: 'r1', userText: 'go', ...turn } as never] })[1];

  it('shows the reason when the run died mid-tool', () => {
    /**
     * The spinner that never stops. Nothing in the tool-chip logic leaves `running` without a
     * `tool-result`, so before this a lease loss rendered as a tool in progress, indefinitely, with no
     * error anywhere on screen — which is exactly what "reply to comment gets stuck" looks like.
     */
    const answer = answerOf({
      settled: true,
      error: 'run failed: worker lost the lease',
      parts: [part({ type: 'tool-call', toolCallId: 'c1', toolName: 'reply_to_comment', input: {} })],
    });

    expect(answer?.streamingError).toBe('run failed: worker lost the lease');
    expect(answer?.toolCalls?.[0]?.status).toBe('error');
    expect(answer?.toolCalls?.[0]?.errorText).toBe('run failed: worker lost the lease');
  });

  it('shows the reason when the run died after partial prose', () => {
    // Otherwise a turn that streamed "Here is the draft: " and then failed reads as a finished answer.
    const answer = answerOf({ settled: true, error: 'run failed: model overloaded', parts: [text('Here is the draft: ')] });

    expect(answer?.text).toContain('Here is the draft');
    expect(answer?.streamingError).toBe('run failed: model overloaded');
  });

  it('leaves a completed tool call alone', () => {
    // Only the calls that never came back are settled as failed; one that finished did finish.
    const answer = answerOf({
      settled: true,
      error: 'run failed: worker lost the lease',
      parts: [
        part({ type: 'tool-call', toolCallId: 'c1', toolName: 'search_web', input: {} }),
        part({ type: 'tool-result', toolCallId: 'c1', toolName: 'search_web', output: { ok: true } }),
        part({ type: 'tool-call', toolCallId: 'c2', toolName: 'read_source', input: {} }),
      ],
    });

    expect(answer?.toolCalls?.find((c) => c.toolCallId === 'c1')?.status).toBe('done');
    expect(answer?.toolCalls?.find((c) => c.toolCallId === 'c2')?.status).toBe('error');
  });

  it('says nothing extra while the run is still live', () => {
    // Mid-stream an unsettled turn belongs to the loader; labelling it early flashes a failure that
    // has not happened.
    const answer = answerOf({ error: 'run failed: worker lost the lease', parts: [text('working on it')] });

    expect(answer?.streamingError).toBeUndefined();
  });

  it('prefers a more specific per-part error to the run-level one', () => {
    const answer = answerOf({
      settled: true,
      error: 'run failed: generic',
      parts: [part({ type: 'error', error: { code: 'rate_limited', message: 'slow down', retryable: true } })],
    });

    // The per-part error wins, decorated as it always was; the run-level reason does not replace it.
    expect(answer?.streamingError).toContain('slow down');
    expect(answer?.streamingError).not.toContain('generic');
  });
});

describe("an interruption is only explained by prose that is actually about it", () => {
  it('stays visible when the prose has moved on to another tool', () => {
    /**
     * The measured attack. `publish_post_now` is gated; it was interrupted before it ran. Then
     * `search_web` succeeded and the model wrote about the search. The old rule accepted any later
     * non-empty text for any call id, so the publish notice was suppressed and its chip left reading
     * *running* — a gated action that never happened, presented as in progress, under prose about
     * something unrelated.
     */
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'A', toolName: 'publish_post_now', input: {} }),
        part({ type: 'tool-call', toolCallId: 'B', toolName: 'search_web', input: {} }),
        part({
          id: 'A:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'publish_post_now' was interrupted before it completed", retryable: false },
        }),
        part({ type: 'tool-result', toolCallId: 'B', toolName: 'search_web', output: { ok: true } }),
        text('I searched the web and found three articles about the topic.'),
      ],
    });

    expect(message.streamingError).toContain('interrupted');
  });

  it('is not suppressed by a single full stop', () => {
    // The cheapest version of the same attack, and the one a model produces by accident.
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'A', toolName: 'delete_post', input: {} }),
        part({
          id: 'A:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'delete_post' was interrupted before it completed", retryable: false },
        }),
        text('.'),
      ],
    });

    expect(message.streamingError).toContain('interrupted');
  });

  it('is suppressed when the same tool was reissued under a new id', () => {
    // What an approval round trip looks like: interrupted, approved, run again with a fresh call id.
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'A', toolName: 'reply_to_comment', input: {} }),
        part({
          id: 'A:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'reply_to_comment' was interrupted before it completed", retryable: false },
        }),
        part({ type: 'tool-call', toolCallId: 'A2', toolName: 'reply_to_comment', input: {} }),
        part({ type: 'tool-result', toolCallId: 'A2', toolName: 'reply_to_comment', output: { ok: true } }),
      ],
    });

    expect(message.streamingError).toBeUndefined();
  });

  it('does not let one call’s result explain a different call', () => {
    // The id-matched arm, asserted from the other side.
    const message = partsToChatMessage({
      role: 'assistant',
      parts: [
        part({ type: 'tool-call', toolCallId: 'A', toolName: 'publish_post_now', input: {} }),
        part({ type: 'tool-call', toolCallId: 'B', toolName: 'search_web', input: {} }),
        part({
          id: 'A:interrupted',
          type: 'error',
          error: { code: 'cancelled', message: "Tool call 'publish_post_now' was interrupted before it completed", retryable: false },
        }),
        part({ type: 'tool-result', toolCallId: 'B', toolName: 'search_web', output: { ok: true } }),
      ],
    });

    expect(message.streamingError).toContain('interrupted');
  });
});
