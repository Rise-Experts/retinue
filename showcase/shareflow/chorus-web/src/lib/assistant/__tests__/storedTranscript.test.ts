/**
 * Whose messages the transcript is showing.
 *
 * The package's `useConversation` refetches when the conversation changes and never clears what it
 * already had, so clicking a thread rendered the **new** thread's title over the **old** thread's
 * messages — and permanently if the fetch rejected, since the async body had no `.catch` and `error`
 * was hard-coded `undefined`.
 *
 * `transcriptState` is the whole substance of the replacement, which is why it is a pure function: a
 * fetched result is believed only while it belongs to the conversation being displayed.
 */
import { describe, expect, it } from 'vitest';

import { transcriptState } from '../storedTranscript';

const page = (id: string, data: readonly string[], error?: string) => ({
  conversationId: id,
  data,
  error,
});

describe('transcriptState', () => {
  it('is empty and loading before anything has been fetched', () => {
    expect(transcriptState(null, 'a')).toEqual({ data: [], loading: true, error: undefined });
  });

  it('shows a fetched page for the conversation it belongs to', () => {
    expect(transcriptState(page('a', ['m1', 'm2']), 'a')).toEqual({
      data: ['m1', 'm2'],
      loading: false,
      error: undefined,
    });
  });

  it('shows nothing for a different conversation, rather than the previous one’s messages', () => {
    /**
     * The defect, stated as an assertion. This is the moment after a click: the id has changed and the
     * fetch has not landed. Empty rather than stale, because for a transcript the wrong conversation's
     * words are worse than no words — a reader has no way to tell they are looking at the wrong thread.
     */
    expect(transcriptState(page('a', ['m1', 'm2']), 'b')).toEqual({
      data: [],
      loading: true,
      error: undefined,
    });
  });

  it('reports loading again on a switch, so a blank state cannot render over a loaded thread', () => {
    // The package's `loading` went false on the first load and never back to true, so "empty" and
    // "not yet arrived" were indistinguishable from the outside.
    expect(transcriptState(page('a', ['m1']), 'b').loading).toBe(true);
  });

  it('carries a failure for the conversation it happened in', () => {
    expect(transcriptState(page('a', [], 'network down'), 'a')).toEqual({
      data: [],
      loading: false,
      error: 'network down',
    });
  });

  it('does not carry a failure across a switch', () => {
    // Conversation B has not failed; it has not been tried yet.
    expect(transcriptState(page('a', [], 'network down'), 'b').error).toBeUndefined();
  });

  it('treats an empty conversation as loaded, not as loading forever', () => {
    // The other half of the loading distinction: a genuinely empty thread must settle so the blank
    // state can render.
    expect(transcriptState(page('a', []), 'a')).toEqual({ data: [], loading: false, error: undefined });
  });
});
