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

The package provides typed part reducers, optimistic sends, cursor catch-up, retry and cancellation. It contains no product styling.

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

