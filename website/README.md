# @agentkit documentation site

Docusaurus site that renders **everything we build**:
- the narrative specs (`../docs/01–15` + `../docs/extraction`) — auto sidebar, mermaid, versioning-ready;
- the **API reference** auto-generated from the `@agentkit/*` TypeScript types (TypeDoc → `/api`);
- `llms.txt` + `llms-full.txt` for AI editors and a docs MCP server.

Standalone app — **not** an npm workspace member, so it never affects package typecheck/boundaries.

## Develop
```bash
cd website
npm install
npm run docs:api     # generate the TypeDoc API reference into ./api
npm start            # dev server (also runs specs)
npm run build        # prebuild regenerates api + llms.txt, then docusaurus build
```

## AI search
The theme is ready for an AI answer/search widget. Add one at deploy via env — supported options:
- **kapa.ai** or **Inkeep** (AI answers over the docs), or **Algolia DocSearch/AskAI** (index + AI).
Wire the widget in `docusaurus.config.ts` `themeConfig` and pass keys via environment variables;
no keys are committed.

## MCP for code editors
`npm run docs:llms` writes `static/llms.txt` (index) and `static/llms-full.txt` (whole corpus),
served at `/llms.txt` and `/llms-full.txt`. Editors that read `llms.txt` (Cursor, Claude Code)
can consume these directly. A docs **MCP server** can serve the same corpus:
- **Hosted:** Inkeep/kapa expose an MCP endpoint from the indexed docs.
- **Self-hosted:** a small MCP server that returns sections of `llms-full.txt` by query.

## Known follow-up
TypeDoc emits a few broken `_media` links from source doc-comments that reference `../docs/*`
(rendered as warnings; the build still passes). Tidy these by stripping doc-relative links from
the API doc-comments or configuring the plugin's media handling.
