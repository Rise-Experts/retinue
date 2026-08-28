---
sidebar_position: 5
---

# Confluence

Search with CQL, read pages as markdown, and write them back — without ever overwriting an edit the agent did
not see.

```bash
npm i @retinue/tools-confluence
```

Confluence and Jira share one credential and one site host, so a deployment that wires this also wires
[Jira](./jira.md) at no extra cost.

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `confluence_search` | `read` | never | CQL. Reports `truncated` against the count CQL matched, not the page returned |
| `confluence_get_page` | `read` | never | Body as markdown, **and the current version number** the update requires |
| `confluence_list_spaces` | `read` | never | Keys and ids that search and create take |
| `confluence_create_page` | `external-write` | **always** | Markdown body, converted for you; optional parent |
| `confluence_update_page` | `external-write` | **always** | **Requires the current version.** A stale one is a `conflict`, not an overwrite |
| `confluence_comment` | `external-write` | **always** | Footer comment, markdown in |

These are classified `knowledge`, not `project` — so a tenant switching off `project` keeps its wiki.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createConfluenceToolkit } from "@retinue/tools-confluence";

// The same credential Jira uses: an account email and an API token, as HTTP Basic.
const resolver = createStaticCredentialResolver({
  atlassian: {
    scheme: "basic",
    username: process.env.ATLASSIAN_EMAIL ?? "",
    password: process.env.ATLASSIAN_API_TOKEN ?? "",
  },
});

const agent = createAgent({
  manifest: {
    id: "librarian",
    name: "Librarian",
    instructions:
      "Keep the ENG space tidy. Always read a page before editing it, and pass back the version you read.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createConfluenceToolkit({
      credentialRef: "atlassian",
      resolver,
      siteUrl: "https://acme.atlassian.net",
    }),
  ],
});
```

## Credentials and scopes

An **account email plus an API token**, presented as HTTP Basic — the same token as Jira. Create it at
`id.atlassian.com/manage-profile/security/api-tokens`. There are no scopes on an API token: it carries
**exactly the permissions of the account that created it**.

| What the agent should do | What the account needs |
|---|---|
| Search and read pages | *Can view* on the spaces in scope |
| List spaces | *Can view* — spaces the account cannot see are simply absent |
| Create pages | *Add page* in that space |
| Update pages | *Add page*, plus *Edit* if the space restricts it |
| Comment | *Add comment* |

Three things that cost an afternoon each if you find them the hard way:

- **Space permissions and page restrictions are different.** An account with *Can view* on a space may still be
  blocked from one page by a page-level restriction, and Confluence reports that as a `404`.
- **The site URL has no `/wiki`.** Pass `https://acme.atlassian.net`; the toolkit adds the `/wiki` prefix
  itself. Passing it twice produces a `404` on every call.
- **Use a dedicated Atlassian account**, not a person's. A token from an admin's account gives an agent
  admin's reach over every space.

A missing permission comes back as `unauthorized` and is **not retryable**.

## Behaviour worth knowing

**An update carries the version it believes it is editing, and that is the whole design.** Confluence pages are
versioned, and `confluence_update_page` requires the number `confluence_get_page` returned.

The tempting shortcut is for the tool to read the current version itself and send that. It **always succeeds**,
and that is exactly the bug: between an agent reading a page and writing it back, a person may have edited it,
and a self-fetched version turns their work into a silent overwrite. Nobody gets an error; the paragraph is
simply gone.

So a stale version is refused:

```
Confluence refused the edit: the version supplied is not the page's current version, so somebody else
has changed it since it was read. Call confluence_get_page again and re-apply the change to the current
text and version. Retrying this call unchanged will fail the same way.
```

That is a `conflict` and is **not retryable** — the runtime's retry would replay the same stale version. One
extra field buys the guarantee that no edit can destroy an edit it never saw.

`confluence_get_page` returns `version` at the top level, next to `title` and `body`, because it is an *input*
to the next call rather than metadata.

**The body replaces the whole page.** There is no partial edit. Read it, change the markdown, write it back.

**A `404` may mean permission, not absence** — see the page-restriction note above. The failure says both.

**Storage format conversion is lossy on purpose.** Confluence pages are XHTML with Confluence's own macro
elements, not ADF — a different format from Jira's, and a different converter. Paragraphs, headings, bullet and
ordered lists, code blocks, links, bold, italic, strikethrough and inline code round-trip exactly. Everything
else — Jira-issue macros, tables of contents, layouts, attachments, expands — **degrades to its text** rather
than throwing, because a tool that refused a page containing a macro would fail on approximately every real
Confluence page.

Two details that matter more than they look:

- **Code blocks are held aside before anything else is converted**, so a sample containing `<div>` or `&amp;`
  survives verbatim. Code is the one content nobody can tolerate being altered.
- **A mention becomes `@mention`.** Confluence stores only an account id and resolves the name at render time,
  so there is no name to recover — but emitting nothing would silently drop the fact that somebody was named,
  which changes what a page says.

**Page content is untrusted.** It arrives fenced. A page instructing the model to edit another page is data, and
the edit would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Deleting pages, comments or spaces | Irreversible from an agent's side. Confluence's trash is an admin surface |
| Attachments | Multipart upload to a second host — the same deferral as Slack's `upload_file` |
| Partial edits | Storage format has no addressable regions, so "insert after the third heading" cannot be expressed reliably. Read, change, write |
| Page restrictions and space permissions | Access-granting is the one act where a wrong call cannot be walked back by another call |
| Templates and blueprints | An instance-wide surface whose effect is on pages nobody has written yet |
| Inline comments | They anchor to a text range that this converter deliberately does not preserve, so an anchor could land in the wrong place. Footer comments have no anchor and cannot be wrong |
| Labels | A small gap, and honest to name: no reason beyond not having been asked for |
| Atlassian 3LO OAuth | A resolver change rather than a toolkit change, so it waits for a registered app |
