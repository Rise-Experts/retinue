# GraphQL and Frontend Packages

## GraphQL boundary

GraphQL is the primary authenticated product API for conversations, configuration, interactions, usage and live updates. REST remains appropriate for OAuth callbacks, third-party webhooks, health endpoints and specialized file transfer.

Resolvers are thin: authenticate, validate, construct execution context and call platform services.

## Queries

- Conversations, messages and runs.
- Agents and versions.
- Skills and versions.
- Models and availability.
- Permission-filtered tool catalog.
- Usage and evaluations.
- Knowledge collections and sources.
- Files and processing state.
- Artifacts and versions.

## Mutations

- Create/rename/archive/delete conversation.
- Send/retry/cancel run.
- Answer question.
- Decide approval.
- Create/update/version agent.
- Create/update/activate skill.
- Begin/complete attachment upload.
- Create collection and ingest/remove source.
- Create/update/export artifact.

## Subscriptions

- Conversation/run events.
- File-processing events.
- Knowledge-ingestion events.

Subscriptions carry stable platform events and support resuming after a cursor. The client reconciles subscription data with authoritative query state.

## Headless React package

Required hooks:

- `useConversations`
- `useConversation`
- `useSendMessage`
- `useRunSubscription`
- `usePendingInteraction`
- `useAnswerQuestion`
- `useDecideApproval`
- `useCancelRun`
- `useAttachmentUpload`
- `useArtifact`

The package provides typed part reducers, optimistic sends, cursor catch-up, retry and cancellation. It contains no product styling. `useRunSubscription` exposes a `retry` state (attempt, max attempts, next-attempt time, reason) derived from the `run.retry-pending` event, which the "Error, retry and processing states" component renders as a live indicator.

## Optional UI package

Components:

- Chat shell, thread list and composer.
- Message and typed-part renderers.
- Tool execution and reasoning displays.
- Question and approval cards.
- Attachment upload/preview.
- Image gallery and PDF viewer.
- Source/citation display.
- Artifact panel and version history.
- Error, retry and processing states.

Components support theming, internationalization, accessibility and custom part renderers.
Internationalization is a locale-keyed message catalog that resolves stable backend codes (tool
names, statuses, retry indicators, error codes) to display strings with ICU interpolation and a
default-locale/raw-id fallback; a consuming app can register its own catalog. See docs/14.

## Mobile

The headless protocol is client-neutral. React Native may use the same GraphQL operations and event reducer while supplying native renderers. The DOM UI package is not a mobile dependency.

## Acceptance criteria

- A second frontend can consume the API without internal runtime knowledge.
- Subscription reconnect produces no missing or duplicated rendered parts.
- Question/approval actions are accessible and idempotent.
- Custom applications can replace every UI component while retaining headless state.

## SSE wire format

The SSE streaming path (SPEC #37, framing corrected in #111) speaks the **`graphql-sse`** wire format,
so a `twenty-client-sdk` client consumes it unmodified — twenty-sdk already streams GraphQL over
graphql-sse, and matching it was recorded as a decision in
[`extraction/twenty-sdk-comparison.md`](extraction/twenty-sdk-comparison.md).

```
id: 3
event: next
data: {"data":{"runEvents":{"type":"part.added","runId":"…","sequence":3,…}}}

event: complete
data:
```

| Line | Carries | Why |
|---|---|---|
| `id:` | `RunEvent.sequence` | A browser resends it as `Last-Event-ID`; `cursorFromLastEventId` maps it straight back to a resume cursor |
| `event: next` | An `ExecutionResult` | The protocol's data frame. The field name matches the SDL's `runEvents` subscription |
| `event: complete` | — | Says the response is finished. A stream that merely stops is indistinguishable from a truncated one |

A **failed run** arrives as a `next` frame carrying both `data` and `errors`, not as a protocol error
frame: `run.failed` is a durable event with a sequence, and an error frame has no `id:`, so delivering
it that way would make a failed run unresumable. A **stream-level** failure — the event log being
unreadable — does use the protocol's error shape, because there is no sequence to preserve.

### Reaching the endpoint

Two request shapes, because two kinds of consumer exist and neither can use the other's:

| Consumer | Request | Resume mechanism |
|---|---|---|
| `graphql-sse` client (what `twenty-client-sdk` ships) | `POST` with `{query, variables}` and `accept: text/event-stream` | **`after` in `variables`** — see below |
| Browser `EventSource` | `GET` with `?runId=&conversationId=` | `Last-Event-ID` header, sent automatically |

`Last-Event-ID` takes precedence when both are present: it is the transport's own mechanism and
reflects what the client actually received, whereas an `after` baked into a retried operation may be
stale and would replay events already delivered.

### The one accommodation beyond the raw protocol (#112)

**The `graphql-sse` client never sends `Last-Event-ID`.** It is absent from the library's source: on a
broken connection the client retries with exponential backoff and **re-subscribes from the beginning**.
Cursor resume exists only in its single-connection mode, via a reservation token.

So for that client, an interrupted stream replays. Nothing is lost and everything already seen arrives
again — which is safe, since run events carry a monotonic `sequence` a consumer can dedupe on, but it
is not resume.

A consumer that wants genuine resume passes the cursor itself, as `after` in the operation variables:

```ts
client.subscribe(
  { query: RUN_EVENTS, variables: { runId, conversationId, after: lastSequenceSeen } },
  sink,
);
```

That is supported deliberately rather than incidentally, and it is the only place this endpoint asks a
client to do something the protocol does not already do for it.
