# ShareFlow on agentkit — a complete product integration (showcase)

This folder is a **read-only snapshot** of a real product built on `@retinue/agentkit`: the assistant of
Chorus, a social media management app. It ran in production as its own agentkit application and was retired
from the product on 2026-11-17, when Chorus moved to "bring your own AI tool" over MCP. It is kept here so the
patterns can be read and reused.

It is **not** a workspace of this repository: it is not installed, built or tested by `npm ci` or CI, and it
pins the agentkit version it was written against (`package.json`). Treat it as reference code.

## What is in it

| Path | What it is |
|---|---|
| `src/` | The `@retinue/shareflow` package: about 95 tools (posts, schedules, publishing, analytics, inbox replies, campaigns, research, artifacts, memory, brand kit), skills, prompts, context builders, the app module and the run worker |
| `src/app/` | The agentkit **application** — the HTTP host and the worker that compose the package's manifests, tools, context and skills |
| `scripts/` | Tool exercise and agent evaluation scripts |
| `Dockerfile` | The image that ran both the API host and the run worker |
| `SHAREFLOW_README.md` | The package's own, detailed README (design notes, cutover log, parity gates) |
| `chorus-web/` | The Next.js side that talked to it: the chat page (`app/(dashboard)/assistant`), the proxy routes (`app/api/assistant/agentkit/*`) and the client library (`lib/assistant/*`) |

Product data, people's names and project identifiers in tests have been replaced with placeholders.

## Patterns worth reading

- `chorus-web/src/lib/assistant/agentkitClient.ts` — why a client must talk to an agentkit *application*, not a
  bare GraphQL host, and how it detects that misconfiguration on the first call.
- `src/tools/publishing.ts` and the approval flow — gated external writes, shadow runs that record what would
  have been published without publishing.
- `src/tools/research.ts` and `src/adapters/web/` — web content treated as untrusted (datamarking, injection
  check, SSRF rules).
- `src/eval/` and `scripts/agent-eval.mjs` — repeatable agent evaluation.

## Licence

MIT, as declared in `package.json`.
