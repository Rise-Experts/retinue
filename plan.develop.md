# develop-branch build plan — complete the whole package

Branch: `develop` (merge everything here; no PRs to main). Test every step, keep suite green.
Baseline (start): typecheck ✅, 64 backend + 4 frontend + boundaries + evals ✅.

## REQ-005 — Durable runtime, streaming & usage
- [x] #24 BullMQ durable runtime: claim, checkpoint, cancel, recover, retry (XL)
- [x] #25 Streaming typed parts + transport-neutral event layer (L)
- [x] #26 Per-conversation run serialization + atomic session-state write (M)
- [x] #27 Usage recording hook in completion transaction (M)

## REQ-006 — Tools, context & skills
- [x] #28 Tool registry: effects, permission-filtered catalog, meta-tools, lazy discovery (XL)
- [x] #29 Context providers + budgeting + previewable prompt assembly (L)
- [x] #30 Skills: versioned, lazy-loaded, recorded per run (M)
- [x] #31 Long-thread compaction into durable summaries (M)

## REQ-007 — HITL & outbound MCP
- [x] #32 Questions: durable WaitingForQuestion + continuation (M)
- [x] #33 Approvals: request_approval, decisions, idempotent resume (L)
- [x] #34 Outbound MCP: connections, egress policy, credential refs (L)
- [x] #35 MCP tool classification + namespacing + catalog-drift (M)

## REQ-008 — GraphQL, transports & frontend
- [x] #36 GraphQL schema + thin resolvers + subscriptions (XL)
- [x] #37 SSE transport adapter (M)
- [x] #38 Headless React hooks + typed part reducers + reconnect (FE, L)
- [x] #39 Context inspector (FE, M)
- [x] #40 Optional UI component library (FE, L)

## Cross-cutting
- [x] #44 Localization — locale-keyed message catalog (FE, M)
- [x] #47 User-level (principal) memory (BE, M)

## Approach
- Implement in dependency order; each issue: implement → unit test (vitest, PGlite for DB) → typecheck/build/boundaries green → commit to develop `Closes #N`.
- After each REQ group: spawn an adversarial review subagent to find bugs before moving on.
- Align with Twenty patterns (research agent running) + frozen ports.
