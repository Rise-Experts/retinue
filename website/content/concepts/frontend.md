---
sidebar_position: 9
---

# Frontend

## What is it?

`@agentkit/frontend` is **headless** client state — no product styling, no transport assumptions. It
turns the backend's stable events into render-ready state, and localizes everything. React is a peer
dependency; the same framework-free reducers back React Native.

## Hooks

Wrap your app in `AgentkitProvider` with a client that implements the transport-agnostic
`AgentkitClient` (GraphQL, SSE, or a test double), then use the hooks:

```tsx
import { AgentkitProvider, useRunSubscription, useSendMessage } from "@agentkit/frontend";

function Chat({ conversationId, runId }: { conversationId: string; runId: string }) {
  const { parts, status, retry, connected } = useRunSubscription({ runId, conversationId });
  const { send, sending } = useSendMessage({ conversationId });
  // render parts; show `retry` as "attempt 2 of 5" when present
}
```

Also: `useConversations`, `useConversation`, `usePendingInteraction`, `useAnswerQuestion`,
`useDecideApproval`, `useCancelRun`, and `useSessionContext` (the context inspector).

## Reducers & reconnect

The core is framework-free and tested: `createRunProjector` pairs an ordering **event buffer** with a
run reducer, so out-of-order or replayed events are ordered and de-duplicated by sequence — a
reconnect from a cursor misses or duplicates no part. The `retry` indicator is derived from the
`run.retry-pending` event and cleared on the next progress event.

## Localization

The backend emits stable ids + structured params; the frontend owns all display strings.
`createTranslator` resolves an id to a string for the active locale, interpolates params (with
`Intl` plurals / number / date), and falls back requested → default → the raw id (never blank). Add a
language by shipping a catalog — no rebuild.

## Optional UI

An unopinionated component set (`ChatShell`, `MessageList`, `Composer`, `RetryIndicator`,
`QuestionCard`, `ApprovalCard`, typed-part renderers) over the hooks — every element takes a
`className` so your app owns the look, and all text goes through an injected translator.

See **[GraphQL & transports](../getting-started/configuration)** for wiring a client.
