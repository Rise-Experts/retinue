# Multi-stage build for the API host and the worker (#110).
#
# One image serves both processes: they share every dependency, and two images would drift. The
# command chooses which process runs — see the README's Deployment section.
#
# Since #196 the host is a subpath of the runtime package rather than its own workspace, so there is
# no `server/` to copy. Four things are built: `backend` (runtime + host),
# `frontend` (view models the reference app imports), `tools/*` (the integration toolkits the
# reference app registers) and `examples` (the reference app the host loads through
# RETINUE_APP_MODULE).
#
# `tools/` arrived with #214 and this file did not learn about it until CI failed: the example app
# imports `@retinue/tools-github` and friends, so without them `tsc -b examples` cannot resolve its
# project references and the runtime stage cannot resolve the imports. `scripts/check-image.mjs`
# now fails locally on a workspace this file does not carry, because the image job is one of the
# three workflow steps `ci:local` deliberately does not run. The app layer is not decoration — the
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
COPY tools/azure/package.json ./tools/azure/
COPY tools/browser/package.json ./tools/browser/
COPY tools/confluence/package.json ./tools/confluence/
COPY tools/email/package.json ./tools/email/
COPY tools/discord/package.json ./tools/discord/
COPY tools/github/package.json ./tools/github/
COPY tools/jira/package.json ./tools/jira/
COPY tools/linear/package.json ./tools/linear/
COPY tools/meta/package.json ./tools/meta/
COPY tools/notion/package.json ./tools/notion/
COPY tools/reddit/package.json ./tools/reddit/
COPY tools/x/package.json ./tools/x/
COPY tools/search/package.json ./tools/search/
COPY tools/slack/package.json ./tools/slack/
COPY tools/google/package.json ./tools/google/
COPY tools/scrape/package.json ./tools/scrape/
COPY tools/telegram/package.json ./tools/telegram/
RUN npm ci
COPY tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY tools ./tools
COPY examples ./examples
# Named projects, not a bare `tsc -b`: the root config also references shareflow, whose sources this
# image deliberately does not carry. `frontend` is here because the reference app imports its view
# models; the host itself does not.
RUN npx tsc -b backend tools/azure tools/email tools/google tools/scrape tools/confluence tools/discord tools/github tools/jira tools/linear tools/meta tools/notion tools/reddit tools/x tools/search tools/slack tools/telegram examples
# The composer bundle, built **here** rather than committed — #267.
#
# `examples/public/composer.js` is produced by `build-composer.mjs` and is deliberately not in git: a
# checked-in bundle drifts from its source silently. The consequence for this image was that
# `examples/public` shipped without the script the page loads, so the page rendered and did nothing.
# `esbuild` is an examples devDependency and this stage still has devDependencies, which is why it can
# run here and not in the runtime stage.
RUN node examples/scripts/build-composer.mjs

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
COPY tools/azure/package.json ./tools/azure/
COPY tools/browser/package.json ./tools/browser/
COPY tools/confluence/package.json ./tools/confluence/
COPY tools/email/package.json ./tools/email/
COPY tools/discord/package.json ./tools/discord/
COPY tools/github/package.json ./tools/github/
COPY tools/jira/package.json ./tools/jira/
COPY tools/linear/package.json ./tools/linear/
COPY tools/meta/package.json ./tools/meta/
COPY tools/notion/package.json ./tools/notion/
COPY tools/reddit/package.json ./tools/reddit/
COPY tools/x/package.json ./tools/x/
COPY tools/search/package.json ./tools/search/
COPY tools/slack/package.json ./tools/slack/
COPY tools/google/package.json ./tools/google/
COPY tools/scrape/package.json ./tools/scrape/
COPY tools/telegram/package.json ./tools/telegram/
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/tools/azure/dist ./tools/azure/dist
COPY --from=build /app/tools/confluence/dist ./tools/confluence/dist
COPY --from=build /app/tools/email/dist ./tools/email/dist
COPY --from=build /app/tools/discord/dist ./tools/discord/dist
COPY --from=build /app/tools/github/dist ./tools/github/dist
COPY --from=build /app/tools/jira/dist ./tools/jira/dist
COPY --from=build /app/tools/linear/dist ./tools/linear/dist
COPY --from=build /app/tools/meta/dist ./tools/meta/dist
COPY --from=build /app/tools/notion/dist ./tools/notion/dist
COPY --from=build /app/tools/reddit/dist ./tools/reddit/dist
COPY --from=build /app/tools/x/dist ./tools/x/dist
COPY --from=build /app/tools/search/dist ./tools/search/dist
COPY --from=build /app/tools/slack/dist ./tools/slack/dist
COPY --from=build /app/tools/google/dist ./tools/google/dist
COPY --from=build /app/tools/scrape/dist ./tools/scrape/dist
COPY --from=build /app/tools/telegram/dist ./tools/telegram/dist
COPY --from=build /app/examples/dist ./examples/dist
# From the **build** stage, not the context: the context's `public/` has no `composer.js` in it, because
# the bundle is built rather than committed. Copying from the context is what shipped a page with no script.
COPY --from=build /app/examples/public ./examples/public
# The reference app is started by `run-app.mjs`, which was in neither `dist` nor `public` — so the image
# could serve the platform host and not the application. See the note at the top of compose.yaml.
COPY --from=build /app/examples/scripts ./examples/scripts
# Non-root: nothing here needs to write to the filesystem.
USER node
EXPOSE 4000
ENV RETINUE_APP_MODULE=file:///app/examples/dist/index.js
# Defaults to the API host. Override the command for the worker; see the README.
CMD ["node", "backend/dist/server/cli.js"]
