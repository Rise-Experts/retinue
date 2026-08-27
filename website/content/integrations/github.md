---
sidebar_position: 2
---

# GitHub

Search code, read files, list and open issues, comment, and merge pull requests. Writes stop and ask a human;
the merge is classified `destructive` and always does.

```bash
npm i @retinue/tools-github
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `github_search_code` | `read` | never | Code search across repositories you can see |
| `github_get_file` | `read` | never | File contents at a ref |
| `github_list_issues` | `read` | never | Paginated; reports `truncated` |
| `github_create_issue` | `external-write` | **always** | Idempotency key required |
| `github_comment` | `external-write` | **always** | Issues and pull requests |
| `github_merge_pull_request` | `destructive` | **always** | Cannot be undone by another call |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createGitHubToolkit } from "@retinue/tools-github";

const agent = createAgent({
  manifest: {
    id: "maintainer",
    name: "Maintainer",
    instructions: "Help triage issues. Say what you are about to change before you change it.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createGitHubToolkit({
      credentialRef: "github",
      resolver: createStaticCredentialResolver({ github: process.env.GITHUB_TOKEN ?? "" }),
    }),
  ],
});
```

For GitHub Enterprise Server, pass `baseUrl: "https://github.example.com/api/v3"`.

## Credentials and scopes

A personal access token is the quickest start; a GitHub App's installation token is the upgrade path and needs no
change here — the resolver returns a different string.

| What the agent should do | Token needs |
|---|---|
| Read public repositories | no scope (or `public_repo`) |
| Read private repositories | `repo` |
| Open issues and comment | `repo` (or `issues: write` on an App) |
| Merge pull requests | `repo` (or `contents: write` + `pull_requests: write`) |

A missing scope comes back as an `unauthorized` failure naming GitHub's own message, so the transcript says what
is wrong rather than "something failed".

## Behaviour worth knowing

**Rate limits are retryable, and everything else is not.** GitHub's `403 rate limit exceeded` and `429` become
`rate_limited` with `retryable: true`, so the runtime backs off. A `404` on a private repository is
`unauthorized`, not "not found" — because from the model's side those are the same observation, and telling it
the repository does not exist would send it looking for a different name.

**Pagination stops at a ceiling and says so.** `github_list_issues` follows `Link` headers and returns
`truncated: true` if there was more, rather than implying it saw everything.

**Issue and file content is untrusted.** It arrives fenced. An issue body instructing the model to merge
something is data, and the merge would still stop for approval.

## Limits

No `github_delete_*` of any kind, no branch or tag deletion, no force push, no release publishing, no workflow
dispatch. Each is easy to add and none is safe to add by default — a destructive tool nobody asked for is a
liability, and the six here cover triage, which is what agents are actually asked to do.
