# Stage 1 — build the React shell from the exact frontend dependency tree in
# this commit. Both outputs are deliberately untracked: every production
# deploy, staging preview, local image, and rollback rebuilds them.
FROM node:22.23.4-alpine AS shell
# Pin npm and replace its affected Undici bundle until npm ships the patch.
RUN npm install --global npm@11.21.1 undici@6.29.1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /usr/local/lib/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && npm cache clean --force
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
WORKDIR /build
COPY frontend ./frontend
COPY scripts/shell-stamp.js ./scripts/shell-stamp.js
# Builds the bundled English catalog and the language packs from
# frontend/locales, before the bundle that imports the catalog.
COPY scripts/language-packs.js ./scripts/language-packs.js
# The ONE server-tree file the shell bundle imports:
# frontend/src/features/admin/topochain/countries.ts reads the same ISO table
# the server does rather than mirroring 249 names into a second copy that
# would drift. Everything else this stage needs lives under frontend/, which
# is why nothing but the stamp above was copied before — and why this stage
# is where a `../../../src/...` import goes wrong. It resolves in every local
# run (the whole repo is on disk) and in no image build, so the first sign is
# a staging preview that never boots. tests/shell-build.test.js pins this
# list against the imports themselves.
COPY src/services/countries.json ./src/services/countries.json
# The commit this image is being built from, so the generated document can
# carry its OWN build identity (a <meta name="platform-build">) instead of the
# running tab having to infer one from the first /api/version answer it sees —
# which a tab booting off the service worker's shell cache gets wrong, in
# exactly the case the reload offer exists for. docker-compose.yml already
# passes this arg on the platform service anchor, so all three build paths
# (deploy.sh, platform-rollout.sh, rollback.sh) already supply it and each
# patches .env's GIT_SHA BEFORE building. It was simply never declared here,
# so it was dropped. Declared LAST in this stage so a new commit does not
# invalidate the npm ci layer above.
# `dev` is for local development only. Hosted builds, including previews,
# supply their exact revision and validate it against the generated release.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN node frontend/scripts/build-shell.mjs

# Stage 2 — compile Tailwind after the shell prerender. public/index.html is a
# Tailwind content source, so copy the freshly rendered document over the
# committed test fixture before compiling. Build dependencies stay in these
# disposable stages.
FROM node:22.23.4-alpine AS css
# Pin npm and replace its affected Undici bundle until npm ships the patch.
RUN npm install --global npm@11.21.1 undici@6.29.1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /usr/local/lib/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && npm cache clean --force
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tailwind.config.js ./
COPY styles ./styles
COPY scripts/build-tailwind.js ./scripts/build-tailwind.js
COPY public ./public
COPY --from=shell /build/public/index.html ./public/index.html
COPY frontend ./frontend
RUN npm run build:css

# Docker CLI from the upstream Go security rebuild.
FROM docker:29.9.2-cli AS docker-tools
# Stable Buildx still embeds vulnerable x/net; this official RC carries v0.62.0.
FROM docker/buildx-bin:0.39.0-rc1@sha256:a765b549a3ac9bc905152f4387c2f03763930a9b08020b9c3eae1c9d3290f559 AS buildx-tools

# Stage 3 — production runtime.
FROM node:22.23.4-alpine
# Pin npm and replace its affected Undici bundle until npm ships the patch.
RUN npm install --global npm@11.21.1 undici@6.29.1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /usr/local/lib/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && npm cache clean --force
# The platform spawns child apps by shelling out to the host's Docker
# daemon (see src/services/docker.js — `execFile('docker', [...])`).
# That needs the docker CLI inside the container; the daemon itself
# is reached via a bind-mounted /var/run/docker.sock from the host.
# buildx is the BuildKit half of that CLI, copied separately below: `docker-cli` alone gives a CLI that answers every
# DOCKER_BUILDKIT=1 build with "BuildKit is enabled but the buildx
# component is missing or broken", which is what #1746 taught the builder
# to fall back from. Installing it is what makes #1736's BuildKit path the
# one that actually runs; the fallback stays as the net under it.
# git is for the import-existing flow's `git clone` of foreign repos.
# postgresql-client lets DB administration work over the normal Postgres
# Service/network connection in both Docker and Kubernetes modes.
RUN apk add --no-cache git postgresql-client
COPY --from=docker-tools /usr/local/bin/docker /usr/local/bin/docker
COPY --from=buildx-tools /buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
RUN node scripts/build-schema.js
# COPY generated assets after the source tree so a developer's ignored local
# builds can never replace the artifacts generated from this image's sources.
COPY --from=shell /build/public/index.html ./public/index.html
# The whole directory, not shell.js alone: the React build emits lazy route
# chunks beside the entry now (frontend/vite.config.ts — today
# assets/shell-sections.js, the admin console). Naming one file meant a new
# chunk 404'd in the image while every test passed locally, where the build
# output is simply on disk.
COPY --from=shell /build/public/shell/assets/ ./public/shell/assets/
# The language packs, before the release below records them. The directory is
# empty while only English ships.
COPY --from=shell /build/public/locales/ ./public/locales/
COPY --from=css /build/public/css/tailwind.css ./public/css/tailwind.css
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN node scripts/build-shell-release.js
RUN node scripts/precompress-static-assets.js
# docker-compose.dev.yml bind-mounts ./public for live source editing, which
# hides the three generated files above on a clean checkout. Keep a protected
# image copy that its startup helper can restore into that mount when missing.
COPY --from=shell /build/public/index.html /opt/usernode-shell-assets/index.html
COPY --from=shell /build/public/shell/assets/ /opt/usernode-shell-assets/shell/assets/
COPY --from=shell /build/public/locales/ /opt/usernode-shell-assets/locales/
COPY --from=css /build/public/css/tailwind.css /opt/usernode-shell-assets/css/tailwind.css
RUN cp public/shell/release.json /opt/usernode-shell-assets/shell/release.json \
    && cp public/shell/worker.js /opt/usernode-shell-assets/shell/worker.js
# #2508: this image ran with NODE_ENV UNSET, and a great deal keys off it.
# Two consequences were live in production:
#
#   - express's default error handler writes `err.stack` into the response
#     body unless NODE_ENV is exactly 'production'. With no error-handling
#     middleware anywhere (now added, src/middleware/error-handler.js), a
#     stack trace was one unhandled throw away from any client.
#   - `SECURE_COOKIE` in src/middleware/auth.js is
#     `process.env.NODE_ENV === 'production'`, so session cookies were issued
#     WITHOUT the Secure attribute on a platform served only over HTTPS.
#
# Set on the runtime stage only. The build stages above must keep their dev
# dependencies — `npm ci` treats NODE_ENV=production as `--omit=dev`, which
# would break the shell and Tailwind builds.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
