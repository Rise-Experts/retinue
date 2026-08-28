---
sidebar_position: 7
---

# Notion

Search, read pages as markdown, query databases, and write back — with property names checked before the call,
because Notion would otherwise accept a typo and report success.

```bash
npm i @retinue/tools-notion
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `notion_search` | `read` | never | Pages and databases **shared with this integration**, not the workspace |
| `notion_get_page` | `read` | never | Properties, plus the block tree flattened to markdown and bounded |
| `notion_query_database` | `read` | never | Filter and sort — a database is Notion's closest thing to an issue list |
| `notion_create_page` | `external-write` | **always** | In a page or a database; property names validated first |
| `notion_update_page` | `external-write` | **always** | Properties only. **Does not change the body** |
| `notion_append_blocks` | `external-write` | **always** | Markdown appended as blocks. Adds; never replaces |
| `notion_comment` | `external-write` | **always** | |

Classified `knowledge`, so a tenant switching off `project` keeps its notes.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createNotionToolkit } from "@retinue/tools-notion";

const resolver = createStaticCredentialResolver({ notion: process.env.NOTION_TOKEN ?? "" });

const agent = createAgent({
  manifest: {
    id: "librarian",
    name: "Librarian",
    instructions: "Keep the engineering notes tidy. Read a database before writing a row into it.",
    modelPolicy: { role: "smart" },
  },
  tools: [createNotionToolkit({ credentialRef: "notion", resolver })],
});
```

## Credentials and scopes

An **internal integration secret**, created at `notion.so/my-integrations`, presented as a bearer.

Notion's capabilities are chosen when the integration is created, not per token:

| What the agent should do | Capability to enable |
|---|---|
| Search, read pages and query databases | *Read content* |
| Create pages and append blocks | *Insert content* |
| Update page properties | *Update content* |
| Comment | *Read comments* and *Insert comments* |
| Resolve people in `people` properties | *Read user information* — otherwise those come back empty |

**The capability is only half of it.** Notion's permission model is *sharing*, not scopes: an integration sees
only the pages and databases somebody has explicitly connected it to, through the page's ••• menu →
Connections. Connecting a parent page shares its children; nothing else is visible at all.

This is the single most confusing thing about Notion integrations, and it is why an empty result from this
toolkit says so explicitly rather than reporting "no results".

Notion's public integrations use OAuth and produce a bearer too. That is a second mode and is not offered yet —
the wire format would be identical, which is exactly why `modes` and `schemes` are separate axes here.

## Behaviour worth knowing

**An empty result names both possibilities.** The API cannot distinguish "nothing matched" from "nothing is
shared with this integration", so the tool does not pretend it can:

```
Notion only returns pages an integration has been explicitly shared with, so an empty result here
means either nothing matched or nothing has been shared with this integration — the API cannot tell
them apart. If this is unexpected, open the page or database in Notion, use its ••• menu →
Connections, and add this integration.
```

A `404` carries the same warning, for the same reason.

**Notion silently ignores an unknown property.** `PATCH /pages/{id}` with `{"Staus": …}` returns `200`, changes
nothing, and reports success — so a typo would reach the model as a completed edit. Both write tools fetch the
database schema and validate names **before** the call:

```
This database has no property called "Staus". Its properties are: Name, Status, Estimate.
Notion would accept this write, change nothing, and report success — so it is refused here instead.
```

A create into a database also requires a value for the title property, since a page without one is untitled and
effectively unfindable. You can pass a plain `title` and the toolkit puts it in the right property — a
database's title property is never actually called "title", it is "Name" or whatever somebody renamed it to.

Validation is skipped for a page whose parent is another page, because such a page has one property and no
schema to check against.

**A page is a block tree, and reading it is bounded.** Each level of nesting is a separate paginated request, so
an unbounded walk can hang and can return more text than a context window holds. Reads stop at 4 levels deep,
400 blocks or 40,000 characters, and report `truncated` with `truncatedBy` naming the limit that stopped it. A
child page is *named*, not descended into — following it would make "read this page" unbounded in the one
direction the caller cannot see.

An unknown block type yields its text rather than being dropped, so a page using a newer Notion feature still
reads.

**`notion_update_page` does not change the body.** Notion has no way to edit a block in place through this
toolkit; `notion_append_blocks` adds to the end.

**Page content is untrusted.** It arrives fenced. A page instructing the model to edit another page is data, and
the edit would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Deleting or archiving pages | Archiving is Notion's delete and is reversible only through the UI's trash |
| Editing or deleting existing blocks | The API addresses blocks by id, which is exactly the opaque identifier this project refuses to put in a schema. Needs a design that addresses content by what it says |
| Creating or altering databases and their schemas | A schema change affects every row and every other integration reading it |
| File and image upload | Upload to a second host — the same deferral as Slack's `upload_file` |
| Users and permissions | Access-granting is the one act where a wrong call cannot be walked back by another call |
| Raw filter objects unvalidated | `notion_query_database` passes a filter through as given. Notion validates it and reports clearly, so a local re-implementation of its filter grammar would add a second thing to be wrong |
| Comment threads and replies | The API exposes discussion ids without a way to find them from a page's text, so a reply could land on the wrong thread |
