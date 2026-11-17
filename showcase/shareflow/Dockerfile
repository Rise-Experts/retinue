# The ShareFlow backend — the retinue platform host loading this package (retinue #190).
#
# Built from source in this repo, which is what moving the package out of the retinue monorepo bought:
# `deploy-backend.yml` already SSHes into the VPS and runs `up -d --build`, so the image is built on
# the box from the checkout the deploy just pulled. Before the move the source lived in a private
# monorepo that is not on that server, and the image had to be shipped with
# `docker save | ssh docker load`.
#
# One image, two processes — the API host and the run worker — chosen by the command. They share every
# dependency, and two images would drift. `docker-compose.oracle.yml` builds it once as the
# `shareflow` service and the worker names the same tag.
#
# **The platform is an installed dependency here, not a workspace.** `@retinue/agentkit` comes from the
# registry, so the host and the worker are at `node_modules/@retinue/agentkit/dist/server/bin.js`
# rather than the monorepo's `backend/dist/...`. That is also why `package-lock.json` is committed and
# why `ai` is pinned to an exact version rather than a range — see src/__tests__/dependencies.test.ts.
# `npm ci` and not `npm install`: an install resolves ranges afresh, and resolving `ai` afresh is
# precisely what broke the shadow runner.

FROM node:20-slim AS build
WORKDIR /app
# Manifests first, so a dependency-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -b
# Derived from the built output, never a list typed into a file — see the script's header. Both entry
# points, because the image runs one and loads the other: the platform host is the CMD and this
# package's module is what RETINUE_APP_MODULE hands it.
RUN node scripts/collect-runtime-imports.mjs dist/app/module.js node_modules/@retinue/agentkit/dist/server/bin.js > runtime-imports.json

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Production install only: the build output is copied, not rebuilt.
RUN npm ci --omit=dev
# Chromium, for the three capabilities that render: `capture_website`, `render_diagram` and
# `generate_pdf`. All three go through `adapters/web/browser.ts`, which holds one browser at a time
# process-wide — the old runtime learned that the hard way (`chrome-headless invoked oom-killer /
# Killed process (python)`), and `mem_limit` in compose is raised to match.
#
# `--with-deps` installs the system libraries Chromium needs; `--only-shell` installs the headless shell
# rather than full Chrome, which is all a one-shot render uses and roughly half the size. Playwright is a
# **dependency** and not a devDependency precisely so it survives `--omit=dev` above.
#
# `PLAYWRIGHT_BROWSERS_PATH` is set so the browser lands somewhere the `node` user can read: the default
# is `$HOME/.cache/ms-playwright`, and this stage installs as root while the process runs as `node`.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps --only-shell chromium \
    && chmod -R a+rX /ms-playwright
# The fonts a project theme may name — #595. The renderers refuse every off-host request, so a webfont
# never arrives: a theme's fonts must be on disk. Exactly `CURATED_FONTS` in src/design/theme.ts (a test
# holds the two lists together), every package confirmed with `apt-cache policy` in node:20-slim
# (bookworm) and every family name read back with `fc-list`. Roughly 50 MB installed.
#
# And ffmpeg — #620: a slide deck exported as a video. Playwright records the page as a VP8 WebM (with its own
# bundled ffmpeg, which can only write that), and this one re-encodes it as the H.264 MP4 that Instagram, TikTok
# and LinkedIn take — the storage route stores `video/mp4`, not WebM. Measured with `apt-get install
# --assume-no` on node:20-slim after Playwright's Chromium dependencies: 122 more packages, +169 MB installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       fonts-inter fonts-roboto fonts-open-sans fonts-lato fonts-manrope fonts-league-spartan \
       fonts-quicksand fonts-bebas-neue fonts-comic-neue fonts-dejavu-core fonts-roboto-slab \
       fonts-vollkorn fonts-ebgaramond fonts-jetbrains-mono fontconfig ffmpeg \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
# The mermaid bundle, and **only** the bundle.
#
# `mermaid` is a devDependency — see `adapters/web/diagram.ts`: the file is injected into a page and
# never imported by Node, and the installed package is 83 MB against a 3.4 MB bundle. Declared in
# package.json so the version is tracked, copied here so the runtime image carries one file.
COPY --from=build /app/node_modules/mermaid/dist/mermaid.min.js ./vendor/mermaid.min.js
# The check that the image can load the code it is about to run. It runs *here*, after the production
# install, because that is the only node_modules whose answer matters — and the script has no
# dependencies of its own, not even typescript, so it cannot be part of what it is checking.
#
# What it catches: a package nothing installs, a dropped dependency, a subpath the exports map does not
# answer. What it cannot catch is a package installed by luck — that one is a manifest question, and it
# is checked by `npm run check:peers`.
COPY --from=build /app/runtime-imports.json ./
COPY scripts/check-runtime-imports.mjs ./scripts/
RUN node scripts/check-runtime-imports.mjs runtime-imports.json
# The agent evaluation (#669) runs inside this container, against this service — see README → "Evaluating the agent".
COPY scripts/agent-eval.mjs ./scripts/
# Non-root: nothing here writes to the filesystem but the slide video (#620), which records into and removes a
# directory of its own under the OS temp directory.
USER node
EXPOSE 4000
# The application. `module.js` default-exports `{ authenticate, deps, engine, buildContext }` — the
# contract the platform's worker loads. See src/app/module.ts.
ENV RETINUE_APP_MODULE=file:///app/dist/app/module.js
# Where the diagram renderer looks for the bundle. Absent, `render_diagram` refuses by name.
ENV RETINUE_MERMAID_BUNDLE=/app/vendor/mermaid.min.js
# **The product's own HTTP surface**, not the platform's GraphQL host.
#
# This was `bin.js serve`, which is the platform host — and it answers 404 for `/api/message`. Verified
# against the running container, not assumed. That is exactly the misconfiguration `agentkitClient.ts`
# detects ("a bare `retinue serve` has no /api/message"), so every turn the web app sent would have been
# refused by its own client while the backend looked healthy.
#
# GraphQL is not used by this product: the web app speaks /api/message, /api/events and
# /api/tools/:name, which `dist/app/main.js` serves — along with /healthz and /readyz, which the
# compose healthcheck needs and which the platform host also served.
#
# The worker service overrides the command with the platform's own binary; see compose.
CMD ["node", "dist/app/main.js"]
