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
# Named projects, not a bare `tsc -b`. The reason used to be shareflow, which the root config
# referenced and this image deliberately did not carry; that package now lives in the product's own
# repo. Naming them stays right regardless: it says what this image is for, and a workspace added to
# the root for something else does not silently become part of it. `frontend` is here because the
# reference app imports its view models; the host itself does not.
RUN npx tsc -b backend tools/azure tools/email tools/google tools/scrape tools/confluence tools/discord tools/github tools/jira tools/linear tools/meta tools/notion tools/reddit tools/x tools/search tools/slack tools/telegram examples
# The composer bundle, built **here** rather than committed — #267.
#
# `examples/public/composer.js` is produced by `build-composer.mjs` and is deliberately not in git: a
# checked-in bundle drifts from its source silently. The consequence for this image was that
# `examples/public` shipped without the script the page loads, so the page rendered and did nothing.
# `esbuild` is an examples devDependency and this stage still has devDependencies, which is why it can
# run here and not in the runtime stage.
RUN node examples/scripts/build-composer.mjs
# Derived from the built output, never a list typed into a file — see the script's header. Both entry
# points, because the image runs one and loads the other: `cli.js` is the CMD and `examples/dist` is
# what RETINUE_APP_MODULE hands the host.
COPY scripts/collect-runtime-imports.mjs ./scripts/
RUN node scripts/collect-runtime-imports.mjs examples/dist/index.js backend/dist/server/cli.js > runtime-imports.json

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production install only: the build output is copied, not rebuilt.
#
# This used to claim it was "the check that the app layer declares what it imports", on the reasoning
# that the runtime's dev dependencies are gone by here so an undeclared peer fails. **That was false.**
# Deleting `pg` from an app's manifest and rebuilding still produced an image where `import("pg")`
# resolved, because `bullmq` depends on `pg` and brought it along — the check passed on a package
# nobody had asked for.
#
# It is two guarantees, and each now lives where it can actually hold:
#
#   - **The image can load the code it runs** — a resolution question, answerable only in here. The
#     build stage walks the compiled graph from both entry points and the step below resolves every
#     specifier it found against this install.
#   - **Nothing is installed by luck** — a manifest question no amount of resolving answers. Checked
#     statically by `scripts/check-optional-peers.mjs` in `npm run ci:local`.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
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
# The check that makes the paragraph above true. It runs *here*, after the production install, because
# that is the only node_modules whose answer matters — and the script has no dependencies of its own,
# not even typescript, so it cannot be part of what it is checking.
COPY --from=build /app/runtime-imports.json ./
COPY scripts/check-runtime-imports.mjs ./scripts/
RUN node scripts/check-runtime-imports.mjs runtime-imports.json
# Non-root: nothing here needs to write to the filesystem.
USER node
EXPOSE 4000
ENV RETINUE_APP_MODULE=file:///app/examples/dist/index.js
# Defaults to the API host. Override the command for the worker; see the README.
CMD ["node", "backend/dist/server/cli.js"]
