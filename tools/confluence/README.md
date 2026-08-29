# @retinue/tools-confluence

Confluence Cloud tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: CQL search, read pages as
markdown, and write them back — without overwriting an edit the agent never saw.

```bash
npm i @retinue/tools-confluence
```

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createConfluenceToolkit } from "@retinue/tools-confluence";

// Basic, not bearer: Atlassian takes an account email and an API token.
const resolver = createStaticCredentialResolver({
  atlassian: {
    scheme: "basic",
    username: process.env.ATLASSIAN_EMAIL ?? "",
    password: process.env.ATLASSIAN_API_TOKEN ?? "",
  },
});

const confluence = createConfluenceToolkit({
  credentialRef: "atlassian",
  resolver,
  // No `/wiki` — the toolkit adds it. Passing it twice is a 404 on every call.
  siteUrl: "https://acme.atlassian.net",
});
```

Pass `confluence` in an agent's `tools`. The credential is resolved **per call**, so a rotated token takes effect
without a restart, and nothing here reads the environment itself.

Confluence and Jira share one credential and one site host, so
[`@retinue/tools-jira`](https://www.npmjs.com/package/@retinue/tools-jira) wires up alongside this at no extra
cost.

## Tools

| Tool | Effect | Approval |
|---|---|---|
| `confluence_search` | `read` | never |
| `confluence_get_page` | `read` | never |
| `confluence_list_spaces` | `read` | never |
| `confluence_create_page` | `external-write` | always |
| `confluence_update_page` | `external-write` | always |
| `confluence_comment` | `external-write` | always |

Classified `knowledge`, not `project`, so a tenant that switches off `project` keeps its wiki.

## An update carries the version it read

The one thing worth knowing before you wire this up.

`confluence_update_page` **requires** the version number `confluence_get_page` returned. The obvious
alternative — having the tool look up the current version itself — always succeeds, and that is exactly the
bug: between an agent reading a page and writing it back, a person may have edited it, and a self-fetched
version turns their work into a silent overwrite. Nobody gets an error; the paragraph is simply gone.

So a stale version is refused:

```
Confluence refused the edit: the version supplied is not the page's current version, so somebody else
has changed it since it was read. Call confluence_get_page again and re-apply the change to the current
text and version. Retrying this call unchanged will fail the same way.
```

That is a `conflict` and is **not retryable** — a retry would replay the same stale version. One extra field
buys the guarantee that no edit can destroy an edit it never saw.

## Markdown, both ways

Confluence pages are XHTML with Confluence's own macro elements, not ADF. Paragraphs, headings, lists, code
blocks, links, bold, italic, strikethrough and inline code round-trip exactly. Everything else — Jira-issue
macros, tables of contents, layouts, attachments — **degrades to its text** rather than throwing, because a tool
that refused a page containing a macro would fail on approximately every real Confluence page.

Code blocks are held aside before any other conversion, so a sample containing `<div>` or `&amp;` survives
verbatim.

## Requirements

- Node 20+
- `@retinue/agentkit` as a peer dependency
- An Atlassian account email and an API token from
  [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). An API token has **no
  scopes** — it carries exactly the permissions of the account that created it, so use a dedicated account
  rather than a person's.

Full documentation, including space-permission notes and what is deliberately not built:
[docs.retinue.riseexperts.de](https://docs.retinue.riseexperts.de/integrations/confluence).

MIT
