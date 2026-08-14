# @agentkit/frontend

Headless client half of the reusable AI platform. Implements
[`../docs/06-graphql-and-frontend.md`](../docs/06-graphql-and-frontend.md).

No product styling, no transport assumptions. `web/` supplies DOM renderers and
`mobile/` supplies native ones; both consume the same state and the same reducers.

## Status

Scaffold, with one piece implemented:

| Module | Contains |
|---|---|
| `types` | Re-exports the wire contract from `@agentkit/backend`, plus client-only view state. Type-only, erased at build time. |
| `event-buffer` | **Implemented.** Orders and de-duplicates run events across a reconnect. |
| `hooks` | Signature types for the ten required hooks. Implementations land with the GraphQL surface. |

`event-buffer` exists first because it backs a specification acceptance criterion —
*"subscription reconnect produces no missing or duplicated rendered parts"* — and that
behaviour is testable before any transport exists.

## Why the backend dependency is type-only

Every import from `@agentkit/backend` is an `import type`, so nothing survives
compilation. The client owns no copy of the wire contract, and the two halves cannot
drift. TypeScript project references build the backend's declarations first.

## Scripts

```bash
npm test -w @agentkit/frontend
npm run build -w @agentkit/frontend   # builds @agentkit/backend first
```

## Not yet here

The optional UI component package from specification 06 — chat shell, part renderers,
question and approval cards, artifact panel. It depends on this package, never the
reverse, and is deliberately not a mobile dependency.
