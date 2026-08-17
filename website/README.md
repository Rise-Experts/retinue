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

## Deployment (Cloudflare Workers Static Assets → docs.agentkit.riseexperts.de)

Deployed via **Cloudflare's Git build** (Workers Builds) using `wrangler.jsonc` — no API-token
secret needed, Cloudflare builds from the connected repo on each push. One-time setup — **these
steps need your Cloudflare/DNS access; the config is already in the repo:**

1. In the Cloudflare project (Workers & Pages → your `agentkit-docs` project) → **Settings →
   Build**, set:
   - **Root directory:** `website`  ← critical; without it Cloudflare builds the monorepo root.
   - **Build command:** `(cd .. && npm ci) && npm run build`
     — the workspace install makes backend/frontend **dependencies** (e.g. `zod`) resolvable for
     TypeDoc; `@agentkit/*` themselves resolve from source (`tsconfig.typedoc.json` paths), so no
     workspace *build* is needed.
   - **Deploy command:** `npx wrangler deploy` (default — it reads `website/wrangler.jsonc`).
2. **Custom domain**: project → **Custom domains** → add **`docs.agentkit.riseexperts.de`**.
   - If `riseexperts.de` DNS is **on Cloudflare**, the record is created automatically.
   - Otherwise add a DNS **CNAME**: `docs.agentkit` → `<worker>.workers.dev` (as shown in the
     Custom domains dialog).

`wrangler.jsonc` declares `assets.directory: ./build`, so `wrangler deploy` uploads the
Docusaurus output as static assets (no Worker script). After setup, pushing docs changes builds
and publishes automatically.

> Note: the earlier deploy failed because the build ran at the **repo root** (executing the
> monorepo `tsc -b` + `wrangler deploy` with no project). Setting **Root directory = `website`**
> plus this `wrangler.jsonc` fixes both.

## Known follow-up
- AI search widget (kapa/Inkeep/Algolia AskAI) — wire in `themeConfig`, keys via env at deploy.
- The `onBrokenMarkdownLinks` deprecation warning migrates to `markdown.hooks` in Docusaurus v4.
