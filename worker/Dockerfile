FROM node:22-bookworm-slim

# unzip backs `usernode-attachments <id> --unzip <dir>` — extracting
# user-attached reference zips inside this disposable container.
# python3/make/g++ are node-gyp's toolchain: native npm deps (bcrypt et al)
# normally install a prebuilt binding, but node-pre-gyp falls back to
# building from source whenever the prebuilt download misses (new node ABI,
# transient GitHub-releases failure) — and on the slim base that fallback
# died with a raw gyp stack, failing the unit-suite check's `npm ci` for
# any repo with a native dep. The toolchain makes the fallback actually
# work, for the unit-suite one-shot and for agent build turns alike.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget ca-certificates unzip python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# ── Local Postgres for in-loop builds and repository SQL checks ────────
# INLOOP_DATABASE_URL (src/services/in-loop-browser.js) points at
# postgres://postgres:postgres@127.0.0.1:5432/inloop — a server that must
# actually exist INSIDE this container, or every backend app crashes with
# ECONNREFUSED the moment the agent boots it for the in-loop visual
# check. The same server backs repository SQL validation during proposal runs,
# so it deliberately matches production's PostgreSQL 17 rather than using
# bookworm's frozen PostgreSQL 15. The PostgreSQL project's apt repository
# supplies 17 (+contrib, for common app extensions like pgcrypto/uuid-ossp).
# We pre-initialize a node-owned
# data dir at image-build time; run-cc.sh starts the server lazily on
# build turns and recreates the `inloop` database fresh each turn, so
# scout/sync-only sessions pay zero runtime cost.
#
# create_main_cluster=false stops the Debian postinst from initializing
# an unused, root-owned "main" cluster — we run our own data dir instead.
# This layer sits BEFORE the CLAUDE_CODE_CACHE_BUST ARG below on purpose,
# so the apt install and initdb stay layer-cached across the daily
# Claude-Code rebuild.
RUN mkdir -p /etc/postgresql-common/createcluster.conf.d \
  && echo 'create_main_cluster = false' \
       > /etc/postgresql-common/createcluster.conf.d/no-main-cluster.conf \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
       --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    postgresql-17 postgresql-contrib-17 \
  && rm -rf /var/lib/apt/lists/*

# Debian keeps the server binaries (pg_ctl/initdb/postgres) off PATH —
# only client tools get pg_wrapper shims. Surface them for run-cc.sh and
# for the agent itself (`pg_ctl status`, direct `psql`).
ENV PATH=/usr/lib/postgresql/17/bin:$PATH

# Pre-initialize the throwaway data dir as node (initdb refuses root; the
# permanent USER node switch only happens further down). Trust auth on
# loopback makes the URL's postgres:postgres credentials work verbatim —
# the password is simply never checked, which is fine for a container-
# local, disposable verification DB. Unix sockets go to /tmp (node can't
# write /var/run/postgresql); shared_buffers stays small under the
# worker's 2g --memory limit. The data dir lives on the container fs, NOT
# the ~/.claude volume: it must be throwaway and die with the container.
USER node
RUN initdb -U postgres --auth=trust -D /home/node/pgdata \
  && { \
       echo "listen_addresses = '127.0.0.1'"; \
       echo "port = 5432"; \
       echo "unix_socket_directories = '/tmp'"; \
       echo "shared_buffers = 32MB"; \
     } >> /home/node/pgdata/postgresql.conf
USER root

# Cache-bust the Claude Code install so the worker tracks the latest CLI
# instead of freezing at whatever version was current when this layer was
# first built. ensureWorkerImage() passes today's date as
# CLAUDE_CODE_CACHE_BUST, so the layer is reused within a calendar day and
# re-pulls `latest` on the first build of each new day. Stale CLIs are the
# cause of "thinking.type.enabled is not supported for this model" 400s on
# newer models (Sonnet 5 / Opus 4.8), which require thinking.type.adaptive.
ARG CLAUDE_CODE_CACHE_BUST=unset
RUN echo "claude-code cache bust: ${CLAUDE_CODE_CACHE_BUST}" \
  && npm install -g @anthropic-ai/claude-code

# ── Codex CLI (codex_openrouter backend; plan.md PR5) ─────────────────
# PINNED (not day-bumped) — bump deliberately. Codex runs non-interactively
# (codex exec --json), DIRECTLY against the user's OpenRouter key, which is
# injected per-turn as OPENROUTER_API_KEY into the specific
# that needs it. The key is NOT placed in the warm-container bootstrap
# environment (see worker.js buildTurnSecretEnv). There is NO OpenRouter
# platform relay. Codex holds only narrow worker capabilities. Keep the pin
# aligned with the JSONL event shapes src/agents/codex-openrouter.js parses.
ARG CODEX_VERSION=0.146.0
RUN npm install -g @openai/codex@${CODEX_VERSION}
# Preserve the pinned CLI's full coding-agent/tool instructions as the base for
# custom OpenRouter model entries. The per-turn builder replaces only the
# misleading OpenAI-model identity sentence before copying that text into its
# one-model catalog; it does not inherit OpenAI-only tool modes or capabilities
# from the bundled models. Codex requires an explicitly selected
# CODEX_HOME to exist before startup; otherwise `codex debug models` exits 1.
# (This layer sits after the day-bumped claude-code layer, so it re-runs on
# every cache-bust rollover — the 2026-08-11 rollover broke every worker
# image build until the dir was pre-created; see #1096/#1097.)
# Keep it outside /tmp because Codex deliberately refuses to create its PATH
# helper aliases beneath temporary directories.
RUN install -d -m 700 /var/lib/usernode-codex-bootstrap \
  && CODEX_HOME=/var/lib/usernode-codex-bootstrap \
       codex debug models --bundled > /usr/local/share/usernode-codex-bundled-models.json \
  && node -e "const c=require('/usr/local/share/usernode-codex-bundled-models.json');if(!Array.isArray(c.models)||!c.models.some(m=>typeof m.base_instructions==='string'&&m.base_instructions.trim()))throw new Error('Codex model catalog has no base instructions')" \
  && chmod 444 /usr/local/share/usernode-codex-bundled-models.json \
  && rm -rf /var/lib/usernode-codex-bootstrap

# ── Optional in-loop browser (build-mode turns only) ───────────────────
# The Playwright MCP server + a matching Chromium give the build-mode
# agent first-class browser_navigate / browser_console / screenshot
# tools, so it can load the app it just edited and catch render/JS
# errors before committing (see app-conventions.md "In-loop browser",
# worker/run-cc.sh, src/services/in-loop-browser.js).
#
# Unlike the Claude Code layer above, the MCP version is PINNED (not
# day-bumped) — bump deliberately. The MCP package bundles its OWN
# `playwright` dependency, and the Chromium revision it launches is tied
# to THAT version — not to any separately-pinned playwright. Installing
# browsers with a standalone playwright pin is exactly what broke #688:
# the image carried chromium-1148 (playwright 1.49.1) while the MCP's
# bundled 1.56-alpha wanted chromium-1194, so every launch failed and
# agents skipped the visual check. So the install step below `cd`s into
# the MCP package directory and runs its package-local playwright CLI:
# the downloaded Chromium revision can never drift from the server that
# launches it, even across MCP pin bumps. `install --with-deps chromium`
# also pulls Chromium's apt runtime deps (runs as root, before the USER
# node switch below). The browser launches LAZILY — only when the agent
# actually calls a browser tool — so turns that never reach for it pay
# no runtime cost; scout/sync never wire the MCP server at all.
ARG PLAYWRIGHT_MCP_VERSION=0.0.41
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && cd /usr/local/lib/node_modules/@playwright/mcp \
  && npx playwright install --with-deps chromium

COPY worker-run.sh   /usr/local/bin/worker-run.sh
COPY run-cc.sh       /usr/local/bin/run-cc.sh
COPY run-codex-agent.sh /usr/local/bin/run-codex-agent.sh
COPY classify-codex-resume.js /usr/local/bin/classify-codex-resume.js
COPY build-codex-model-catalog.js /usr/local/bin/build-codex-model-catalog.js
# usernode-push is the worker's only path to writing anything back to
# GitHub: it POSTs to the platform's internal push proxy, which runs
# the actual `git push` from the host side with the bot token injected
# for that one call. See worker.execPushFromWorker + src/routes/internal.js.
# The worker container itself carries zero GitHub credentials.
COPY usernode-push   /usr/local/bin/usernode-push
# usernode-issues is read-only: it GETs the platform's internal issues
# endpoints (anonymous public-repo fetch happens platform-side) so Claude
# Code can list the repo's open GitHub issues — or fetch one issue's full
# untruncated body via `usernode-issues <number>` — in both build and
# scout modes. Authenticates with the read-only ISSUES_JWT, never WORKER_JWT.
COPY usernode-issues /usr/local/bin/usernode-issues
# usernode-attachments is read-only like usernode-issues (same ISSUES_JWT
# auth, works in scout + build): it lists the session's user-attached
# dev-chat files, downloads one into the container so Claude Code can
# Read it (images/binaries — text files are already inlined in the
# prompt), or downloads + extracts a zip attachment via --unzip so the
# agent can browse a whole reference project. See src/routes/internal.js
# attachments routes (#450).
COPY usernode-attachments /usr/local/bin/usernode-attachments
# usernode-report-platform-issue is the worker's escalation valve: a
# build-turn write path (WORKER_JWT, like usernode-push) that DRAFTS a
# platform-repo issue when the agent hits a blocker it can't fix in this
# app's repo (shared bridge, native WebView, staging pipeline, checks
# gate). Human-gated: the draft renders as a confirm/dismiss card in the
# dev chat and nothing reaches GitHub until a user taps confirm.
# Platform-side dedup + rate limit bound the spam. See
# src/routes/internal.js + src/routes/sessions.js (confirm route).
COPY usernode-report-platform-issue /usr/local/bin/usernode-report-platform-issue
# usernode-run-checks runs the app's declared dapp.json checks against the
# in-loop app (build turns boot it on $INLOOP_PORT) with the SAME
# semantics as the capture container — navigate, console errors,
# wait-based selector/text assertions — so the agent sees its proposal
# checks fail BEFORE committing instead of after the turn ends. Purely
# local: drives the image's pinned Playwright chromium against loopback,
# needs no JWT, writes nothing back.
COPY usernode-run-checks /usr/local/bin/usernode-run-checks
# usernode-debug (#616) is read-only production debugging for ADMIN
# sessions on the self-edit app. It calls the platform's prod-debug
# internal API (deny-listed read-only SQL role, allowlisted container
# logs/status) with PROD_DEBUG_JWT — an env var the platform injects
# ONLY into eligible turns, and whose claims are re-verified against the
# DB on every call. In every other session the script is present but
# inert (no JWT). No DB credential or docker access ever enters this
# container.
COPY usernode-debug /usr/local/bin/usernode-debug
# `.claude` must exist (owned by node) in the image so that when we mount a
# named volume at that path for persistent CC sessions, Docker initialises the
# volume with node ownership instead of defaulting to root.
RUN chmod +x /usr/local/bin/worker-run.sh \
              /usr/local/bin/run-cc.sh \
              /usr/local/bin/run-codex-agent.sh \
              /usr/local/bin/usernode-push \
              /usr/local/bin/usernode-issues \
              /usr/local/bin/usernode-attachments \
              /usr/local/bin/usernode-report-platform-issue \
              /usr/local/bin/usernode-run-checks \
              /usr/local/bin/usernode-debug \
  && mkdir -p /home/node/workspace /home/node/.claude \
  && chown -R node:node /home/node

USER node
WORKDIR /home/node/workspace

# Build-time smoke test: launch the MCP's bundled Chromium headless (as
# node, same channel + SwiftShader flags worker-run.sh seeds) and close
# it. A future MCP pin bump that reintroduces a channel/revision mismatch
# — the failure mode behind #688 — fails the image build loudly here,
# instead of silently degrading every build turn to "skipped the
# screenshot check".
RUN cd /usr/local/lib/node_modules/@playwright/mcp \
  && node -e "require('playwright').chromium.launch({channel:'chromium',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}).then(b=>b.close()).catch(e=>{console.error(e);process.exit(1);})"

# The worker is "warm-by-default": MODE=warm clones the repo + restores
# CC config + sleeps forever, and the host drives per-turn work via
# `docker exec /usr/local/bin/run-cc.sh`. Each per-exec invocation runs
# `claude --print` (build or scout), commits, pushes, and emits the
# usual __USERNODE_RESULT__ marker on its own stdout (read directly by
# the host's docker-exec child, not via `docker logs`).
#
# Setting MODE=build|scout on `docker run` keeps the legacy single-shot
# path alive (clone → CC → commit → push → exit) for rollback safety.
#
# Bootstrap env via -e on `docker run`:
#   CLONE_URL          plain HTTPS, no embedded token (public repos only)
#   BRANCH             session's canonical dev branch
#   SESSION_ID         used in the platform API URL
#   PLATFORM_URL       internal endpoint of the platform server
# Per-exec env via -e on `docker exec`:
#   PROMPT_FILE, MODE, MODEL, COMMIT_MSG, CLAUDE_RESUME_SESSION_ID,
#   SESSION_ID, PLATFORM_URL, plus only the turn's required secrets:
#   ANTHROPIC_API_KEY, ISSUES_JWT, optional PROD_DEBUG_JWT, and
#   WORKER_JWT for mutation-capable modes. Scout receives no general
#   worker:session token under any alias.
# (The dispatch prompt itself is materialized into the CC volume at
# PROMPT_FILE before the exec — it must never ride argv/env, which Linux
# caps at 128 KiB per string. See run-cc.sh / worker.js writeTurnPrompt.)
CMD ["/usr/local/bin/worker-run.sh"]
