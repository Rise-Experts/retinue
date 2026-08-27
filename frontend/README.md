<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# @retinue/react

[![npm](https://img.shields.io/npm/v/@retinue/react)](https://www.npmjs.com/package/@retinue/react)
[![licence](https://img.shields.io/npm/l/@retinue/react)](https://github.com/Rise-Experts/retinue/blob/main/LICENSE)

**Headless React hooks for a [Retinue](https://github.com/Rise-Experts/retinue) agent runtime.** Streaming
runs, pending questions, approval prompts and usage — as state, with no styling and no transport assumed.

You bring the transport and the markup. This package brings the ordering guarantees: run events folded into
renderable parts, de-duplicated across a reconnect, resumable from a cursor.

## Install

```bash
npm i @retinue/react
```

React 18+ as a peer. Nothing else.

## Use

```tsx
import { RetinueProvider, useRunSubscription, useSendMessage } from "@retinue/react";
import type { RetinueClient } from "@retinue/react";

// `client` implements one interface — GraphQL, SSE, WebSocket, or a test double.
export const App = ({ client }: { client: RetinueClient }) => (
  <RetinueProvider client={client}>
    <Thread conversationId="conv-1" runId="run-1" />
  </RetinueProvider>
);

const Thread = ({ conversationId, runId }: { conversationId: string; runId: string }) => {
  const { parts, status, connected } = useRunSubscription({ runId, conversationId });
  const { send, sending } = useSendMessage({ conversationId });

  return (
    <div>
      {parts.map((part, index) => <pre key={index}>{JSON.stringify(part)}</pre>)}
      <button onClick={() => void send("Hello")} disabled={sending || status === "running"}>
        {connected ? "Send" : "Reconnecting…"}
      </button>
    </div>
  );
};
```

## What you get

| | |
|---|---|
| **Ten hooks** | Conversations, runs, sending, questions, approvals, cancellation, session context |
| **Event ordering** | Out-of-order and duplicate run events reconciled, so a reconnect does not double-render |
| **Resumable streams** | Subscribe after a cursor; the durable log fills the gap |
| **Pure reducers** | Run events → renderable parts, testable without a DOM |
| **Localisation** | Stable codes from the server, rendered per user locale |
| **No transport** | One interface. GraphQL, SSE, WebSocket or a stub — the hooks do not know |

## Documentation

- [Frontend concepts](https://docs.agentkit.riseexperts.de/docs/concepts/frontend)
- [Client package surface](https://docs.agentkit.riseexperts.de/docs/reference/client-surface) — every module and hook
- [GraphQL and frontend specification](https://github.com/Rise-Experts/retinue/blob/main/docs/06-graphql-and-frontend.md)

## Licence

MIT — see [LICENSE](https://github.com/Rise-Experts/retinue/blob/main/LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts).
