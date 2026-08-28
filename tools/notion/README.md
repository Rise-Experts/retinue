# @retinue/tools-notion

Notion tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: search, read pages as markdown,
query databases, and write back.

```bash
npm i @retinue/tools-notion
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createNotionToolkit } from "@retinue/tools-notion";

const toolkit = createNotionToolkit({
  credentialRef: "notion",
  resolver: createStaticCredentialResolver({ notion: process.env.NOTION_TOKEN ?? "" }),
});
```

## Tools

Three reads — `notion_search`, `notion_get_page`, `notion_query_database` — and four writes:
`notion_create_page`, `notion_update_page`, `notion_append_blocks`, `notion_comment`. Every write requires
approval and carries an idempotency key.

## Three things worth knowing before you wire it

**Notion only sees what it has been shared with.** A workspace can hold ten thousand pages and a new
integration sees none of them, and the API cannot distinguish "no matches" from "nothing shared". An empty
result says so, rather than sending you off to rewrite a query.

**Notion silently ignores a property name it does not recognise** — it returns `200`, changes nothing, and
reports success. So `notion_create_page` and `notion_update_page` fetch the database schema and validate names
**before** the call, naming the properties that exist.

**A page is a block tree, not a document.** Reading one is bounded in depth, block count and size, and when it
stops early it says which limit it hit.

Full documentation: <https://docs.retinue.riseexperts.de/integrations/notion>

MIT.
