# @retinue/tools-confluence

Confluence Cloud tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent: CQL search, read pages as
markdown, and write them back without overwriting an edit the agent never saw.

```bash
npm i @retinue/tools-confluence
```

Requires `@retinue/agentkit` as a peer.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createConfluenceToolkit } from "@retinue/tools-confluence";

const toolkit = createConfluenceToolkit({
  credentialRef: "atlassian",
  // Basic, not bearer: Atlassian takes an account email and an API token.
  resolver: createStaticCredentialResolver({
    atlassian: {
      scheme: "basic",
      username: process.env.ATLASSIAN_EMAIL ?? "",
      password: process.env.ATLASSIAN_API_TOKEN ?? "",
    },
  }),
  // No `/wiki` — the toolkit adds it. Passing it twice is a 404 on every call.
  siteUrl: "https://acme.atlassian.net",
});
```

Pass it to an agent's `tools`. Confluence and Jira share one credential and one site host, so
[`@retinue/tools-jira`](https://www.npmjs.com/package/@retinue/tools-jira) wires from the same resolver.

## Tools

Three reads — `confluence_search`, `confluence_get_page`, `confluence_list_spaces` — and three writes:
`confluence_create_page`, `confluence_update_page`, `confluence_comment`. Every write requires approval and
carries an idempotency key. All six are classified `knowledge`, so a tenant switching off `project` keeps its
wiki.

## The one thing worth knowing before you wire it

**An update carries the version it believes it is editing.** `confluence_update_page` requires the version
number `confluence_get_page` returned, and a stale one is refused as a `conflict`.

The shortcut — having the tool read the current version itself — always succeeds, and that is the bug: between
reading a page and writing it back, a person may have edited it, and a self-fetched version turns their work
into a silent overwrite. One extra field buys the guarantee that no edit can destroy an edit it never saw.

Page bodies are markdown in both directions. Paragraphs, headings, lists, code, links and inline emphasis
round-trip exactly; macros, layouts and attachments degrade to their text rather than throwing. Code blocks are
held aside during conversion so samples survive verbatim.

Full documentation, including permissions and what is deliberately not built:
<https://docs.retinue.riseexperts.de/integrations/confluence>

MIT.
