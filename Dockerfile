# Multi-stage build for the API host and the worker (#110).
#
# One image serves both processes: they share every dependency, and two images would drift. The
# command chooses which process runs — see the README's Deployment section.
#
# Since #196 the host is a subpath of the runtime package rather than its own workspace, so there is
# no `server/` to copy. Three workspaces are built: `backend` (runtime + host),
# `frontend` (view models the reference app imports) and `examples` (the reference app the host
# loads through RETINUE_APP_MODULE). The app layer is not decoration — the
# runtime declares its heavy dependencies as *optional* peers, so something has to declare the ones
# a given wiring actually uses, and that something is the application. Deploying your own app means
# replacing the `examples` layer with yours, not editing the runtime's.
#
# Every workspace manifest is copied even though only two are built: `npm ci` refuses to install a
# workspace root whose lockfile names a manifest that is not on disk.

FROM node:20-slim AS build
WORKDIR /app
# Manifests first, so a dependency-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shareflow/package.json ./shareflow/
COPY examples/package.json ./examples/
RUN npm ci
COPY tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY examples ./examples
# Named projects, not a bare `tsc -b`: the root config also references shareflow, whose sources this
# image deliberately does not carry. `frontend` is here because the reference app imports its view
# models; the host itself does not.
RUN npx tsc -b backend examples

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production install only: the build output is copied, not rebuilt. This is also the check that the
# app layer declares what it imports — the runtime's dev dependencies are gone at this point, so an
# undeclared peer fails here rather than in production.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shareflow/package.json ./shareflow/
COPY examples/package.json ./examples/
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/examples/dist ./examples/dist
COPY examples/public ./examples/public
# Non-root: nothing here needs to write to the filesystem.
USER node
EXPOSE 4000
ENV RETINUE_APP_MODULE=file:///app/examples/dist/index.js
# Defaults to the API host. Override the command for the worker; see the README.
CMD ["node", "backend/dist/server/cli.js"]
