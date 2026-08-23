# Multi-stage build for the API host and the worker (#110).
#
# One image serves both processes: they share every dependency, and two images would drift. The
# command chooses which process runs — see the README's Deployment section.

FROM node:20-slim AS build
WORKDIR /app
# Manifests first, so a dependency-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY server/package.json ./server/
COPY frontend/package.json ./frontend/
RUN npm ci
COPY tsconfig.json ./
COPY backend ./backend
COPY server ./server
COPY frontend ./frontend
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production install only: the build output is copied, not rebuilt.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY server/package.json ./server/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/server/dist ./server/dist
# Non-root: nothing here needs to write to the filesystem.
USER node
EXPOSE 4000
# Defaults to the API host. Override the command for the worker; see the README.
CMD ["node", "server/dist/cli.js"]
