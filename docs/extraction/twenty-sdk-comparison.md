# twenty-sdk vs @agentkit — comparison & tool/function reconciliation

Companion to the [extraction inventory](inventory.md). Settles how `@agentkit` relates to
`twenty-sdk` so we build a **bridge, not a duplicate**.

## They solve different problems

| | **twenty-sdk** | **@agentkit** |
|---|---|---|
| Purpose | Build & deploy **CRM extension apps** into Twenty | A reusable **AI agent runtime** |
| Unit of work | An "app": metadata + **logic-functions** + UI components | An agent: model + tools + durable runs + sessions |
| Shipped as | A `twenty` CLI (`scaffold`/`dev`/`plan`/`apply`), manifest-driven | Composable packages (`createAgentPlatform` / `createAgent`) |
| Execution | Deterministic serverless **logic-functions** synced to Twenty | Durable queued runs, checkpoints, HITL, cancellation |
| UI | `front-component-renderer` (Preact/React) | headless `react` + optional `ui` |
| Transport | GraphQL over **`graphql-sse`** + `twenty-client-sdk` | GraphQL subscriptions (SSE adapter, SPEC #27) |
| AI / models / RAG / approvals | ❌ none | ✅ the whole point |

**Conclusion:** they coexist. An app is built with twenty-sdk and *consumes* @agentkit for its
AI. `@agentkit` replaces **Agno** (the current runtime, see inventory), **not** twenty-sdk.

## Evidence from the running app

`twenty-apps/twenty-social` uses twenty-sdk `logic-functions/` for deterministic platform ops:
`connect-test-account`, `on-linkedin-connected`, `on-meta-connected`, `check-media-storage`,
`finish-pending-targets`, `show-connection-setup`. These are CRM/connector operations triggered
by events/UI — **not** AI agent tools.

## The decision: tools wrap logic-functions

- **@agentkit tools wrap existing twenty-sdk logic-functions / platform services** — they do not
  reimplement connectors, publishing, media handling or storage. This matches the ShareFlow
  integration spec (docs/07): "existing publishing, connector and database services are reused
  behind tools."
- **A tool is a thin, agent-facing envelope over a deterministic function**: it adds the
  permission filter (docs/11), the approval gate for external writes (docs/04), and the
  idempotency key — then delegates the actual side effect to the logic-function/service, which
  stays the source of truth.
- **No duplication rule:** if a capability already exists as a logic-function, the tool calls
  it; only genuinely new AI-facing capabilities (e.g. `generate_content`, `search_web`) become
  net-new tools.
- **Effect boundary:** logic-functions own the external write; the tool layer owns
  agent-facing authorization/approval/idempotency and result-envelope shaping.

```
Agent run ──▶ @agentkit tool (authz + approval + idempotency)
                   └──▶ twenty-sdk logic-function / platform service (the actual side effect)
```

## SSE precedent (for SPEC #27)

twenty-sdk already ships GraphQL streaming over **`graphql-sse`** (a dependency of the SDK). That
is direct precedent that Server-Sent Events is a proven transport in this stack — it de-risks the
**SSE transport adapter (SPEC #27)** as the lightweight streaming path for the embedded profile,
alongside GraphQL subscriptions for the server profile. Match the `graphql-sse` framing rather
than inventing a bespoke SSE protocol.

## Outcome

- Comparison recorded (this doc).
- Tool↔logic-function bridge decision recorded (above) — carried into REQ-006 (tools) and the
  ShareFlow integration.
- SSE precedent recorded for SPEC #27.
