# @retinue/react

Headless client half of the reusable AI platform. Implements
[`../docs/06-graphql-and-frontend.md`](../docs/06-graphql-and-frontend.md).

No product styling, no transport assumptions. `web/` supplies DOM renderers and
`mobile/` supplies native ones; both consume the same state and the same reducers.

## Status

Implemented. 16 source files, ~2,100 lines, 49 tests.

This said *"Scaffold, with one piece implemented"* and described `hooks` as signature types
awaiting the GraphQL surface. Both were stale: all ten hooks are implemented, and six
modules were missing from the table entirely. A README that undersells a package sends the
reader to write again what is already here.

| Module | Contains |
|---|---|
| `types` | Re-exports the wire contract from `@retinue/agentkit`, plus client-only view state. Type-only, erased at build time. |
| `event-buffer` | **Implemented.** Orders and de-duplicates run events across a reconnect. |
| `hooks` | **Implemented** — all ten: `useRetinueClient`, `useConversations`, `useConversation`, `useRunSubscription`, `usePendingInteraction`, `useSendMessage`, `useAnswerQuestion`, `useDecideApproval`, `useCancelRun`, `useSessionContext`. |
| `client` | The transport port the hooks take. An interface, so the host supplies fetch, SSE or WebSocket and this package assumes none of them. |
| `reducers` | Run events folded into renderable parts. Pure functions, so the ordering guarantees are testable without a DOM. |
| `context-inspector` | What the window holds and what is left of it — the view behind the composer's context meter. |
| `localization` | Locale and timezone resolution for rendered output. |
| `usage-panel` | The spend panel's shaping, separate from its rendering. |
| `citations` | Citation view-model and resolution, React-free, so the same rules serve a DOM renderer and a native one. |
| `ui/citations` | **Implemented.** Citation markers and expandable source panels: append-only ordering so a mid-stream citation never moves what is on screen, a grounded/ungrounded treatment that uses no colour, and a shipped hue-free stylesheet. |
| `ui/usage` | **Implemented.** The spend panel: rollup-backed periods with breakdowns, a quota bar whose state comes from the server's own guard, an explanatory empty state rather than a zeroed chart, and a mobile-first hue-free stylesheet. |

`event-buffer` came first because it backs a specification acceptance criterion —
*"subscription reconnect produces no missing or duplicated rendered parts"* — and that
behaviour is testable before any transport exists.

The split between shaping and rendering is deliberate throughout: `citations`,
`usage-panel` and `context-inspector` are React-free, so the rules that decide what a
citation marker means or when a quota bar turns amber are held in one place and tested
without a DOM. `ui/` renders them.

## Why the backend dependency is type-only

Every import from `@retinue/agentkit` is an `import type`, so nothing survives
compilation. The client owns no copy of the wire contract, and the two halves cannot
drift. TypeScript project references build the backend's declarations first.

## Scripts

```bash
npm test -w @retinue/react
npm run build -w @retinue/react   # builds @retinue/agentkit first
```

## Not yet here

The optional UI component package from specification 06 — chat shell, part renderers,
question and approval cards, artifact panel. It depends on this package, never the
reverse, and is deliberately not a mobile dependency.

## Licence

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 Azeem Sarwar and Rise Experts.
