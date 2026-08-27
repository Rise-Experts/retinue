<img src="https://raw.githubusercontent.com/Rise-Experts/retinue/main/brand/retinue-mark.svg" alt="Retinue" width="72" />

# @retinue/tools-github

[![npm](https://img.shields.io/npm/v/@retinue/tools-github)](https://www.npmjs.com/package/@retinue/tools-github)
[![licence](https://img.shields.io/npm/l/@retinue/tools-github)](https://github.com/Rise-Experts/retinue/blob/main/LICENSE)

**GitHub tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent.** Search code, read files, manage
issues and pull requests — with every write classified, gated behind human approval, and carrying an idempotency
key.

## Install

```bash
npm i @retinue/tools-github
```

`@retinue/agentkit` is a peer dependency. This package brings no other dependency.

## Use

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createGitHubToolkit } from "@retinue/tools-github";

const agent = createAgent({
  manifest: { id: "dev", name: "Dev", instructions: "Help with the repository.", modelPolicy: { role: "smart" } },
  tools: [
    createGitHubToolkit({
      credentialRef: "github",
      // Your resolver. This one is for a single-tenant deployment; a multi-tenant host resolves per tenant.
      resolver: createStaticCredentialResolver({ github: process.env.GITHUB_TOKEN ?? "" }),
    }),
  ],
});

const result = await agent.run({
  conversationId: "conv-1",
  message: "Find where we validate egress and open an issue if it lacks a test.",
});
```

The token is **resolved per call**, not at construction, so rotating it takes effect without a restart. Nothing
in this package reads the environment — that line above is your host doing it, visibly.

## Tools

| Tool | Effect | Approval |
|---|---|---|
| `github_search_code` | `read` | never |
| `github_get_file` | `read` | never |
| `github_list_issues` | `read` | never |
| `github_create_issue` | `external-write` | **always** |
| `github_comment` | `external-write` | **always** |
| `github_merge_pull_request` | `destructive` | **always** |

Approval is driven by the **classification**, not by the name — so a gate cannot be lost by renaming a tool, and
a retried write returns the first result rather than firing twice.

## Configuration

| Option | Required | Notes |
|---|---|---|
| `credentialRef` | yes | An opaque handle your resolver understands. A personal access token or a GitHub App installation token both work |
| `resolver` | yes | `CredentialResolver` from `@retinue/agentkit/tools` |
| `baseUrl` | no | Defaults to `https://api.github.com`. Set for GitHub Enterprise |
| `fetchImpl` | no | Injected for tests |

## Behaviour worth knowing

**Pagination reports truncation.** `github_list_issues` walks up to five pages and returns `truncated: true` when
it stopped early. A tool that returns page one silently teaches the model there were only thirty issues.

**Rate limits are their own outcome.** A 429 comes back as a retryable `rate_limited` error rather than a generic
failure, so the model waits instead of retrying with different arguments.

**Egress is the platform's.** Every request goes through the runtime's egress policy, which refuses private
address space — the control that matters when a URL is influenced by a model.

## Licence

MIT — see [LICENSE](https://github.com/Rise-Experts/retinue/blob/main/LICENSE).

Copyright (c) 2026 [Azeem Sarwar](https://github.com/azeem-sarwar) and
[Rise Experts](https://github.com/Rise-Experts).
