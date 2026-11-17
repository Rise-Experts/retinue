/**
 * The stored transcript for one conversation, without the previous one's messages in it.
 *
 * ## Why this exists rather than `useConversation`
 *
 * The package's hook is
 *
 * ```js
 * const [messages, setMessages] = useState([]);
 * const [loading, setLoading] = useState(true);
 * useEffect(() => { … setMessages(page.items); setLoading(false); }, [client, input.conversationId]);
 * return { data: messages, loading, error: undefined };
 * ```
 *
 * On a conversation change it refetches and **never clears `messages`**, never puts `loading` back to
 * true, has no `.catch` on the async body, and reports `error: undefined` unconditionally. Three
 * consequences, all of them visible:
 *
 *  - Clicking a thread on a slow connection shows the **new** thread's title over the **old** thread's
 *    messages, because the header updates synchronously and the transcript does not.
 *  - If `listMessages` rejects, the old messages stay under the new title permanently, with an
 *    unhandled promise rejection in the console and nothing on screen to say anything went wrong.
 *  - Nothing can distinguish "this conversation is empty" from "this conversation has not loaded",
 *    so a blank state can render over a conversation that has messages.
 *
 * ## The shape of the fix
 *
 * State is stored **with the conversation id it belongs to**, and read back only when that id still
 * matches — the same idiom `RetinueChat` already uses for the pending interaction, and for the same
 * reason: clearing on change would mean a synchronous `setState` inside an effect, which is a
 * cascading render and which the React Compiler's `set-state-in-effect` rule rejects. Deriving
 * staleness from a key needs no write at all, so switching threads renders an empty, loading
 * transcript immediately, on the same commit that changes the title.
 *
 * `data` is empty while loading rather than stale — for a transcript, showing the wrong conversation's
 * words is worse than showing none.
 */
import { useEffect, useState } from 'react';

/** Just enough of the client to fetch a page of messages. */
type MessageLister = {
  listMessages(input: { readonly conversationId: string }): Promise<{ readonly items: readonly unknown[] }>;
};

export type StoredTranscript<T> = {
  readonly data: readonly T[];
  readonly loading: boolean;
  /** The failure, when the fetch rejected. `undefined` is "no failure", not "unknown". */
  readonly error: string | undefined;
};

type Fetched<T> = {
  readonly conversationId: string;
  readonly data: readonly T[];
  readonly error: string | undefined;
};

/**
 * Which of a fetched result and the current conversation id to believe.
 *
 * Split out as a pure function because it is the whole substance of this hook and the part that was
 * wrong in the package's version: everything else is a fetch. Exported so it can be tested without a
 * renderer.
 */
export const transcriptState = <T>(
  fetched: Fetched<T> | null,
  conversationId: string,
): StoredTranscript<T> =>
  fetched === null || fetched.conversationId !== conversationId
    ? { data: [], loading: true, error: undefined }
    : { data: fetched.data, loading: false, error: fetched.error };

export const useStoredTranscript = <T>(
  client: MessageLister,
  conversationId: string,
): StoredTranscript<T> => {
  const [fetched, setFetched] = useState<Fetched<T> | null>(null);

  useEffect(() => {
    let current = true;
    void client
      .listMessages({ conversationId })
      .then((page) => {
        if (current) setFetched({ conversationId, data: page.items as readonly T[], error: undefined });
      })
      .catch((error: unknown) => {
        /**
         * Recorded rather than thrown. An unhandled rejection here left the previous conversation's
         * messages on screen under the new title, which is the worst of the three outcomes: it looks
         * like data rather than like an error.
         */
        if (current) {
          setFetched({
            conversationId,
            data: [],
            error: error instanceof Error ? error.message : 'the transcript could not be loaded',
          });
        }
      });
    return () => {
      current = false;
    };
  }, [client, conversationId]);

  return transcriptState(fetched, conversationId);
};
