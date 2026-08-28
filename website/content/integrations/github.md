---
sidebar_position: 2
---

# GitHub

Forty-four tools: issues and pull requests, code and branches, Projects v2 boards, releases, workflow runs,
labels and milestones. Every write stops and asks a human; three are classified `destructive` and say so.

```bash
npm i @retinue/tools-github
```

## Ship the ten you use, not all forty-four

Forty-four catalogue entries cost roughly 1,540 tokens on **every** turn, and dropping entries at run time is
not the answer — we measured a run-time catalogue budget costing 19–23 points of tool-selection accuracy,
because a plausible tool that is still resident beats searching for the right one.

So selection happens at wiring time:

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createGitHubToolkit } from "@retinue/tools-github";

const resolver = createStaticCredentialResolver({ github: process.env.GITHUB_TOKEN ?? "" });

createGitHubToolkit({
  credentialRef: "github",
  resolver,
  include: ["github_search_issues", "github_get_issue", "github_comment", "github_add_labels"],
});
```

`exclude` is the other direction, for "everything except the dangerous ones":

```ts
createGitHubToolkit({
  credentialRef: "github",
  resolver,
  exclude: ["github_delete_file", "github_merge_pull_request"],
});
```

**A name that does not exist is refused at construction**, with a suggestion. This matters most for `exclude`: a
typo silently ignored ships the tool you believed you had removed, and nothing anywhere would say so.

```
createGitHubToolkit was given exclude names this toolkit does not have: github_serch_issues.
Did you mean github_search_issues?
```

## Tools

### Issues and pull requests

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `github_search_issues` | `read` | never | GitHub's query syntax, across repositories |
| `github_get_issue` | `read` | never | Body, labels, assignees, milestone, comment count |
| `github_list_issues` | `read` | never | Paginated; reports `truncated` |
| `github_list_pull_requests` | `read` | never | Filterable by state and base branch |
| `github_get_pull_request` | `read` | never | Changed files with counts — not the diff, which is unbounded |
| `github_search_pull_requests` | `read` | never | |
| `github_create_issue` | `external-write` | **always** | |
| `github_update_issue` | `external-write` | **always** | Only the fields you pass; labels and assignees **replace** |
| `github_close_issue` | `external-write` | **always** | Carries `completed` or `not_planned` — closing without saying which loses the decision |
| `github_reopen_issue` | `external-write` | **always** | Clears `not_planned` too |
| `github_create_pull_request` | `external-write` | **always** | Head, base, title, body, draft |
| `github_update_pull_request` | `external-write` | **always** | Including draft-to-ready |
| `github_review_pull_request` | `external-write` | **always** | `APPROVE` / `REQUEST_CHANGES` / `COMMENT` |
| `github_comment` | `external-write` | **always** | Issues and pull requests |
| `github_close_pull_request` | `external-write` | **always** | Not a merge; nothing reaches the base |
| `github_merge_pull_request` | `destructive` | **always** | Cannot be undone by another call |

### Code and repository

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `github_search_code` | `read` | never | Across repositories you can see |
| `github_get_file` | `read` | never | Contents at a ref |
| `github_list_directory` | `read` | never | Says so if you named a file |
| `github_list_commits` | `read` | never | Filterable by path and author |
| `github_get_commit` | `read` | never | Message, author, changed files |
| `github_list_branches` | `read` | never | With protection status |
| `github_list_tags` | `read` | never | |
| `github_create_branch` | `external-write` | **always** | From a branch name, tag or sha — resolved for you |
| `github_write_file` | `external-write` | **always** | Create **or** update; fetches the current `sha` itself |
| `github_delete_file` | `destructive` | **always** | Recoverable through history, not to whoever asked |

There is deliberately no `github_create_file` beside `github_update_file`. That split is the contents API's — an
update needs a `sha`, a create refuses one — and it is not a distinction the caller has. A model asked to fix a
typo does not know whether the file exists, and guessing wrong earns a 422 it cannot interpret.

### Projects v2

Every one of these takes **human identifiers** and resolves node ids internally. Projects v2 addresses the
owner, the project, each item, each field and each option by base64 node id, and none of those is knowable to a
model that was asked to "move issue 42 to Done".

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `github_list_projects` | `read` | never | For a user or an organisation, without being told which |
| `github_get_project` | `read` | never | Fields **with their options** — read this before setting one |
| `github_create_project` | `external-write` | **always** | Resolves the owner id from the login |
| `github_add_project_item` | `external-write` | **always** | Takes `owner/repo#number` |
| `github_set_project_field` | `external-write` | **always** | `field: "Status"`, `value: "Done"` |
| `github_remove_project_item` | `destructive` | **always** | Removes from the board; **does not** delete the issue |

A field or value that does not match fails **naming the valid ones**:

```
"Dnoe" is not an option for the field "Status". Its options are: Todo, In Progress, Done.
```

That is the difference between a tool a model can use and one it can only attempt.

### Releases, workflows, labels, milestones

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `github_list_releases` | `read` | never | |
| `github_get_release` | `read` | never | By tag, or latest |
| `github_list_workflow_runs` | `read` | never | By workflow, branch, status |
| `github_get_workflow_run` | `read` | never | Per-job status, and **which step failed** |
| `github_get_workflow_run_logs` | `read` | never | The **last** 60 KB of one job's log, truncation reported |
| `github_list_labels` | `read` | never | Read before adding — an unknown label is *created* |
| `github_list_milestones` | `read` | never | Open and closed issue counts |
| `github_create_release` | `external-write` | **always** | Draft by request; the tag must exist unless you pass a target |
| `github_rerun_workflow` | `external-write` | **always** | All jobs, or only the failed ones |
| `github_dispatch_workflow` | `external-write` | **always** | The workflow must declare `workflow_dispatch` |
| `github_add_labels` | `external-write` | **always** | Adds; does not replace |
| `github_remove_label` | `external-write` | **always** | One at a time, so a wrong call costs one label |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";

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
      resolver,
      include: ["github_search_issues", "github_get_issue", "github_add_labels", "github_comment"],
    }),
  ],
});
```

For GitHub Enterprise Server, pass `baseUrl: "https://github.example.com/api/v3"`.

## Credentials and scopes

A personal access token is the quickest start; a GitHub App's installation token is the upgrade path and needs
no change here — the resolver returns a different credential.

**A token that can read code often cannot write a project.** Projects v2 is the trap: it is a separate scope on
a classic PAT and a separate permission on an App, and the failure arrives from GraphQL rather than as an HTTP
status. Scopes by group:

| Group | Classic PAT | Fine-grained PAT / GitHub App |
|---|---|---|
| Issues and pull requests — reads | `repo` (or none for public) | `Issues: read`, `Pull requests: read`, `Metadata: read` |
| Issues and pull requests — writes | `repo` | `Issues: write`, `Pull requests: write` |
| Code and repository — reads | `repo` (or none for public) | `Contents: read`, `Metadata: read` |
| Code and repository — writes | `repo` | `Contents: write` |
| Projects v2 — reads | `read:project` | `Projects: read` |
| Projects v2 — writes | `project` | `Projects: write` |
| Releases | `repo` | `Contents: write` |
| Workflow runs — reads and re-runs | `repo` | `Actions: read`, then `Actions: write` to re-run or dispatch |
| Labels and milestones | `repo` | `Issues: write` |

Two notes that cost an afternoon each if you find them the hard way:

- **`project` is an organisation-level scope.** A classic PAT with `repo` but not `project` reads issues
  perfectly and fails every Projects v2 call with `FORBIDDEN`.
- **`workflow` is not `actions`.** The classic `workflow` scope is for *committing workflow files*;
  re-running and dispatching need `repo` on a classic PAT, and `Actions: write` on a fine-grained one.

A missing scope comes back as an `unauthorized` failure — not retryable — naming GitHub's own message, so the
transcript says what is wrong rather than "something failed".

## Behaviour worth knowing

**Rate limits are retryable, and a scope problem is not.** GitHub's `403 rate limit exceeded` and `429` become
`rate_limited` with `retryable: true`, so the runtime backs off. A plain `401`/`403` becomes `unauthorized` with
`retryable: false` and a message that mentions scopes, because a model told "forbidden" retries with different
arguments — which is never the fix.

**A GraphQL `200` carrying `errors` is a failure.** Projects v2 is GraphQL, and GraphQL reports application
errors with an HTTP 200 and `data: null`. The transport reads the envelope and surfaces the first message, so
you get `Could not resolve to a ProjectV2 with the number 99` rather than an internal error about reading a
field off null. `FORBIDDEN` and `INSUFFICIENT_SCOPES` in that envelope map to `unauthorized`.

**Pagination stops at a ceiling and says so.** Reads follow up to five pages of up to 100 and return
`truncated: true` if there was more, rather than implying they saw everything. Search reports `truncated` when
GitHub's own `incomplete_results` is set, or when it counted more than it returned.

**A dispatch does not tell you what it started.** GitHub answers `workflow_dispatch` with a `204` and no run
id. The tool says so instead of inventing one, or reporting a run from a later list call that might have started
in between.

**Issue and file content is untrusted.** It arrives fenced. An issue body instructing the model to merge
something is data, and the merge would still stop for approval.

## Limits

Still declined, each for a reason rather than because the list stopped:

| Not offered | Why |
|---|---|
| Force push, and moving a branch to a different commit | Destroys commits that exist nowhere else. `github_create_branch` fails if the branch exists rather than moving it |
| Branch and tag deletion | A deleted branch takes unmerged commits with it, and nothing in the API distinguishes "merged" from "abandoned" |
| Repository deletion, transfer, visibility changes | Irreversible, and public-visibility changes are irreversible *in public*. Not an agent's decision |
| `deleteProjectV2` | Deletes a board and every field value on it. `github_remove_project_item` takes one item off, which is the reversible unit |
| Copilot review requests | Spends someone else's budget and posts a review attributed to the repository |
| Secret scanning alerts | Reading them means reading secrets. Out of scope while the credential path is app-side sealed |
| Organisation administration — members, teams, roles, settings | Access-granting is the one act where a wrong call cannot be walked back by another call |
| Releases: deleting, and asset upload | Deletion is irreversible; asset upload is multipart to a second host, which is the same deferral as Slack's `upload_file` |

Three of these were declined in earlier revisions and **are** now included, each for a stated reason:
`github_create_release` (it announces, it does not deploy, and a release can be deleted),
`github_dispatch_workflow` (unlike a shell, its blast radius is a workflow file somebody reviewed and merged),
and `github_get_workflow_run_logs` (bounded to the last 60 KB, and reading logs is the whole task after a red
build).
