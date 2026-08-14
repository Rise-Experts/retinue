# Reusable AI Platform Packages

TypeScript implementation of the specifications in [`docs/`](docs/README.md).

| Folder | Package | Runs where |
|---|---|---|
| [`backend/`](backend) | `@agentkit/backend` | Server: runtime, tools, MCP, skills, context, HITL, persistence ports |
| [`frontend/`](frontend) | `@agentkit/frontend` | Client: headless React state, subscriptions and typed part reducers |
| [`docs/`](docs) | — | The specifications these packages implement |

## Status

Scaffold. The packages currently contain the **contracts** the specifications define
verbatim — types, ports and envelopes — and no execution logic. The runtime is built
out over the phases in [`docs/08-migration-plan.md`](docs/08-migration-plan.md).

Anything not stated in the specifications is marked `@proposed` in the source and is
not settled. Outbound MCP-server consumption (`backend/src/mcp`) is now specified in
[`docs/10-mcp-integration.md`](docs/10-mcp-integration.md); its contracts can move out of
`@proposed` as they are reconciled against that section.

## Workspace

These two packages are npm workspaces of the repository root. `web/` and `mobile/`
are deliberately **not** members — they keep their own lockfiles, and CI installs
`web/` independently.

```bash
npm install          # from the repository root
npm run typecheck
npm test
npm run build
```

## Boundaries

Per [`docs/01-architecture.md`](docs/01-architecture.md), these packages must build and
test with neither ShareFlow/Chorus nor Twenty installed:

- `backend` imports no ShareFlow domain code and no UI.
- `frontend` is headless and carries no product styling.
- Adapters implement ports; ports never import adapters.
- No public API contains Twenty names or types.

ShareFlow-specific tools, context providers, skills and agents are registered through
the public interfaces from an integration package, never added here.
