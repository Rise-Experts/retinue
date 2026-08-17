/**
 * Headless React hooks — `docs/06` → Headless React package. Thin wrappers over the framework-free
 * reducers (`../reducers`) and the injected `AgentkitClient`. No product styling, no transport
 * assumptions. `useRunSubscription` drives the ordering buffer + run reducer, so a reconnect (via
 * `resumeFrom`) misses or duplicates no part, and exposes the live `retry` indicator derived from
 * `run.retry-pending`.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentkitClient, ApprovalDecision } from "../client.js";
import { createRunProjector, type RunView } from "../reducers.js";
import type { ConversationSummary, Message, MessagePart, PlatformError } from "../types/index.js";

const ClientContext = createContext<AgentkitClient | null>(null);

/** Provides the transport client to the hooks. */
export const AgentkitProvider = (props: { client: AgentkitClient; children: ReactNode }): ReactNode =>
  createElement(ClientContext.Provider, { value: props.client }, props.children);

export const useAgentkitClient = (): AgentkitClient => {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useAgentkitClient must be used within an <AgentkitProvider>");
  return client;
};

const toPlatformError = (e: unknown): PlatformError =>
  typeof e === "object" && e !== null && "code" in e
    ? (e as PlatformError)
    : { code: "internal", message: e instanceof Error ? e.message : String(e), retryable: false };

export const useConversations = (input?: { includeArchived?: boolean }) => {
  const client = useAgentkitClient();
  const [items, setItems] = useState<readonly ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PlatformError | undefined>(undefined);

  const load = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      try {
        const page = await client.listConversations({ includeArchived: input?.includeArchived, cursor: nextCursor });
        setItems((prev) => (nextCursor ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== undefined);
        setError(undefined);
      } catch (e) {
        setError(toPlatformError(e));
      } finally {
        setLoading(false);
      }
    },
    [client, input?.includeArchived],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { data: items, loading, error, hasMore, fetchMore: () => void load(cursor) };
};

export const useRunSubscription = (input: { runId: string; conversationId: string; resumeFrom?: { lastSequence: number } }) => {
  const client = useAgentkitClient();
  const [view, setView] = useState<RunView>(() => createRunProjector(input.resumeFrom?.lastSequence ?? 0).view());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const projector = createRunProjector(input.resumeFrom?.lastSequence ?? 0);
    (async () => {
      try {
        setConnected(true);
        for await (const event of client.subscribeRun({ runId: input.runId, conversationId: input.conversationId, after: projector.cursor() })) {
          if (cancelled) break;
          setView(projector.push(event));
        }
      } finally {
        if (!cancelled) setConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, input.runId, input.conversationId, input.resumeFrom?.lastSequence]);

  return { status: view.status, parts: view.parts, retry: view.retry, error: view.error, lastEvent: undefined, connected };
};

export const usePendingInteraction = (input: { runId: string; parts: readonly MessagePart[] }) => {
  const question = input.parts.find((p): p is Extract<MessagePart, { type: "question" }> => p.type === "question" && p.answeredAt === undefined);
  const approval = input.parts.find((p): p is Extract<MessagePart, { type: "approval" }> => p.type === "approval" && p.decidedAt === undefined);
  return { question, approval };
};

export const useSendMessage = (input: { conversationId: string }) => {
  const client = useAgentkitClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<PlatformError | undefined>(undefined);
  const send = useCallback(
    async (text: string) => {
      setSending(true);
      try {
        await client.sendMessage({ conversationId: input.conversationId, text });
        setError(undefined);
      } catch (e) {
        setError(toPlatformError(e));
        throw e;
      } finally {
        setSending(false);
      }
    },
    [client, input.conversationId],
  );
  return { send, sending, error };
};

const useMutation = <A extends unknown[]>(fn: (client: AgentkitClient, ...args: A) => Promise<void>) => {
  const client = useAgentkitClient();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      try {
        await fn(client, ...args);
      } finally {
        setBusy(false);
      }
    },
    [client, fn],
  );
  return { run, busy };
};

export const useAnswerQuestion = () => {
  const { run, busy } = useMutation((client, input: { interactionId: string; runId: string; answers: Record<string, string> }) => client.answerQuestion(input));
  return { answer: run, submitting: busy };
};

export const useDecideApproval = () => {
  const { run, busy } = useMutation((client, input: { interactionId: string; runId: string; decision: ApprovalDecision }) => client.decideApproval(input));
  return { decide: run, submitting: busy };
};

export const useCancelRun = () => {
  const { run, busy } = useMutation((client, input: { runId: string }) => client.cancelRun(input));
  return { cancel: run, cancelling: busy };
};

export const useConversation = (input: { conversationId: string }) => {
  const client = useAgentkitClient();
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [loading, setLoading] = useState(true);
  const cursorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await client.listMessages({ conversationId: input.conversationId });
      if (!cancelled) {
        setMessages(page.items);
        cursorRef.current = page.nextCursor;
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, input.conversationId]);
  return { data: messages, loading, error: undefined as PlatformError | undefined };
};
