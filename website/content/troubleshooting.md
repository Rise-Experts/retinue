---
sidebar_position: 6
---

# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Tool never called` | Tool not in the agent's `toolPolicy`, or the caller isn't authorized | Add it to `toolPolicy` / grant the permission |
| Run stuck at `WaitingForApproval` | An external-write tool is awaiting a decision | Call `decideApproval` |
| Run stuck at `WaitingForQuestion` | The agent asked a clarifying question | Answer it via `answerQuestion` |
| Duplicate external action | Tool not marked `idempotent` | Set `idempotent: true` + a stable key |
| Context overflow / prompt too large | Too much injected context | Rely on the budget; move large data behind retrieval / references |
| Cross-tenant data appears | Missing tenant scope on a store/tool call | Every call takes `{ tenantId }`; never a bare `findById(id)` |
| Provider switch changed behavior | Different model capabilities | Pin capabilities in `modelPolicy`; check the registry resolution |
| Retries not happening | Non-transient error (4xx) | Only `429/408/409/5xx/529` retry; validation errors fail fast |
| Session doesn't persist | Using a per-process memory store | Use a Postgres/Supabase adapter for durability |

## Debugging a run

- Inspect the **assembled context** (per-section token estimates + provenance) via the context
  inspector — it shows exactly what the agent is working from.
- Subscribe to run events (`run.*`, `tool.*`, `run.retry-pending`) to see the timeline.
- Check the audit log for denials and external writes.

## Still stuck?

Open an issue on **[GitHub](https://github.com/Rise-Experts/agentkit)**.
