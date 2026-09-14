#!/bin/sh
# Homeroom worker entrypoint — long-lived "warm" wrapper.
#
# The container is brought up once per chat session (via `docker run`)
# with MODE=warm (the default). This script does one-time bootstrap —
# clone the repo, check out the session's branch, restore CC's
# ~/.claude.json from the persistent volume backup — and then sits in
# `sleep infinity` waiting for the host to drive per-turn work via
# `docker exec /usr/local/bin/run-cc.sh`.
#
# The legacy single-shot pipeline (MODE=build|scout invoked directly,
# without a separate exec) is kept as a fallback so old code paths and
# rollback flows still work. In that mode we run the same per-exec
# script (run-cc.sh) inline after bootstrap and then exit, matching the
# pre-refactor behaviour.
#
# Required env (set via -e on `docker run`, MODE=warm):
#   CLONE_URL            plain HTTPS git clone URL (no embedded creds —
#                        public repos only, see app-conventions.md /
#                        src/services/github.js::getCloneUrl)
#   BRANCH               branch name to check out
#   SESSION_ID           session id, used in platform API URLs
#   PLATFORM_URL         base URL of the platform's internal API
#
# NOTE (Commit 1): the warm bootstrap environment deliberately contains NO
# provider keys and NO worker capability tokens. Every credential / narrow
# capability is injected on the individual per-turn `docker exec` (see
# worker.js buildTurnSecretEnv), never at docker run. The warm wrapper only
# clones, checks out, restores ~/.claude.json, and sleeps; the legacy
# single-shot build|scout path below is the only one that consumed
# ANTHROPIC_API_KEY / WORKER_JWT directly, and even it no longer receives
# them at bootstrap.
# Optional env:
#   MODE                 warm (default) | build | scout
#   PAT                  legacy — kept for back-compat only; not set by
#                        the platform anymore. If present we still wire
#                        the credential helper, but the platform-side
#                        push proxy is the only legitimate write path.
#   MODEL, COMMIT_MSG,   only required for legacy single-shot MODE=build|scout;
#   CLAUDE_RESUME_SESSION_ID  ignored in MODE=warm. (The per-turn dispatch
#                        prompt never travels as env — run-cc.sh reads it
#                        from PROMPT_FILE in the CC volume.)
#
# All output goes to stdout. The host tails it via `docker logs -f`
# during bootstrap to surface phase markers, then drives per-turn work
# through `docker exec` (whose stdout is read directly by the host).

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

# Fold captured command output into something that survives a
# single-line marker: drop CRs (git writes progress with them) and blank
# lines, keep the LAST 10 lines, join them with " | ", hard-cap at 1000
# chars.
#
# Why this exists: every `die` site below used to throw the failing
# command's stderr away (`2>&1` into the void, then a fixed string), so a
# clone that failed for ANY reason surfaced to the host — and from there
# verbatim to the user — as the bare words "clone failed". Three
# production sessions burned real money chasing a GitHub auth problem
# that the discarded git stderr would have ruled out in one line. The
# marker prefix ("clone failed:", "checkout failed:") stays stable and
# machine-matchable; the detail rides after the colon.
clip() {
  printf '%s\n' "$1" \
    | tr -d '\r' \
    | grep -v '^[[:space:]]*$' \
    | tail -n 10 \
    | awk '{ printf "%s%s", (NR > 1 ? " | " : ""), $0 } END { printf "\n" }' \
    | cut -c1-1000
}

: "${CLONE_URL:?CLONE_URL required}"
: "${BRANCH:?BRANCH required}"
: "${PAT:=}"
: "${MODE:=warm}"

# This marker belongs to this container's completed bootstrap, never its PVC.
rm -f /tmp/usernode-worker-ready || die "cannot reset worker readiness"

cd /home/node/workspace || die "no /home/node/workspace"

# Restore CC's main config file from the persistent volume if needed.
#
# CC stores conversation history under ~/.claude/ (mounted as a named
# volume so it survives container churn) but its primary settings file
# lives at ~/.claude.json — a SIBLING of that directory. That file is
# on the container filesystem, so a fresh container starts without it
# and CC prints "Claude configuration file not found" warnings on every
# subsequent turn. CC backs the file up to
# ~/.claude/backups/.claude.json.backup.<ts> (which IS in the volume),
# so we restore the most recent backup at startup.
if [ ! -f /home/node/.claude.json ]; then
  LATEST_BACKUP="$(ls -1t /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | head -n1 || true)"
  if [ -n "$LATEST_BACKUP" ] && [ -f "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" /home/node/.claude.json \
      && echo "__USERNODE_PHASE__ restored .claude.json from backup" \
      || echo "__USERNODE_WARN__ failed to restore .claude.json"
  fi
fi

# Runtime-contract v6 cleanup: v4's Codex config writer accidentally expanded
# shell commands from an unquoted heredoc and could persist the per-turn worker
# environment in this platform-owned file; v5 also had no custom OpenRouter
# model catalog. Codex regenerates both files on every turn, so remove obsolete
# copies as soon as a fixed worker boots while preserving rollout history.
rm -f /home/node/.claude/codex-home/config.toml \
      /home/node/.claude/codex-home/openrouter-model-catalog.json 2>/dev/null \
  || echo "__USERNODE_WARN__ failed to remove stale Codex config"

# Seed the Playwright browser config for the in-loop browser. The MCP
# server has no CLI flag for raw Chromium args, but `--config <file>`
# accepts a JSON whose browser.launchOptions.args are forwarded to
# Chromium (see @playwright/mcp config.d.ts: launchOptions is a Playwright
# LaunchOptions, which includes `args`). We use it to enable software
# WebGL via SwiftShader so Three.js / <canvas> WebGL apps can create a
# context while the agent visually checks them — the same flag set the
# capture image uses (see capture/capture.js CHROMIUM_LAUNCH_ARGS).
# --use-gl=angle --use-angle=swiftshader route WebGL to the CPU
# rasterizer; --enable-unsafe-swiftshader opts modern Chromium into
# unaccelerated SwiftShader (else getContext() returns null on the
# worker's GPU-less Chromium).
BROWSER_PW_CONFIG=/home/node/.usernode-playwright.json
cat > "$BROWSER_PW_CONFIG" <<'JSON'
{
  "browser": {
    "launchOptions": {
      "args": [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader"
      ]
    }
  }
}
JSON

# Seed the Playwright MCP config used by the OPTIONAL in-loop browser
# (build-mode turns only — see run-cc.sh). Written on every bootstrap so a
# warm container always has a config matching the image's pinned MCP
# server. It lives on the container filesystem (re-created each bootstrap),
# NOT the ~/.claude volume, so it can't go stale against an image rebuild.
# Harmless for warm/scout/sync, which never reference it.
#   --browser chromium : REQUIRED in this container (#688). The MCP
#                server's default launch channel is BRANDED Google Chrome
#                (its defaultConfig sets launchOptions.channel "chrome"),
#                which the worker image deliberately does not ship — so
#                without this flag every launch fails with "Chromium
#                distribution 'chrome' is not found" and the agent skips
#                the visual check. The flag maps to channel "chromium",
#                the Playwright-bundled Chromium the image installs
#                (worker/Dockerfile); CLI options merge LAST, so it beats
#                the default channel while --config below still
#                contributes the SwiftShader launch args.
#   --headless : no display in the worker; Chromium runs headless.
#   --isolated : ephemeral profile per session, no on-disk profile state.
#   --config   : the software-WebGL launch args seeded just above.
# `npx @playwright/mcp` resolves the globally-installed pinned package, so
# there's no network fetch at launch, and Chromium itself launches lazily
# on the first browser tool call.
BROWSER_MCP_CONFIG=/home/node/.usernode-mcp.json
cat > "$BROWSER_MCP_CONFIG" <<JSON
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["--yes", "@playwright/mcp", "--browser", "chromium", "--headless", "--isolated", "--config", "$BROWSER_PW_CONFIG"]
    }
  }
}
JSON
echo "__USERNODE_PHASE__ seeded playwright mcp config"

# Bootstrap: clone the repo if the workspace is empty. Re-warming
# (after eviction) skips this because the volume isn't reused for the
# workspace — the workspace lives on container fs, so a destroyed
# container always re-clones. CC's session memory survives via the
# /home/node/.claude volume.
if [ ! -d /home/node/workspace/.git ]; then
  echo "__USERNODE_PHASE__ clone"
  # `--recurse-submodules --shallow-submodules` matches the convention
  # used elsewhere in the SV ecosystem (app-creator.js, dapp deploy
  # workflows). Without this, repos that pin native code as a submodule
  # (e.g. falling-sands → sandspiel) clone with empty submodule
  # placeholders and CC's read-only scout mode can't read the source —
  # it tries `git submodule update --init` (denied by plan-mode
  # permissions) and then `gh api` (binary not installed in this
  # image), leaving the spec stage unable to inspect the actual code.
  if ! CLONE_OUT="$(git clone --recurse-submodules --shallow-submodules "$CLONE_URL" . 2>&1)"; then
    die "clone failed: $(clip "$CLONE_OUT")"
  fi

  echo "__USERNODE_PHASE__ checkout"
  # The first checkout failing is EXPECTED (the branch usually doesn't
  # exist on the remote yet), so only the second one's output is worth
  # reporting.
  if ! git checkout "$BRANCH" >/dev/null 2>&1; then
    if ! CHECKOUT_OUT="$(git checkout -b "$BRANCH" 2>&1)"; then
      die "checkout failed: $(clip "$CHECKOUT_OUT")"
    fi
  fi
else
  # Defensive: another wrapper invocation against an existing checkout.
  # Should be rare — only happens if MODE=warm is invoked twice without
  # tearing down the container, which the host doesn't do.
  echo "__USERNODE_PHASE__ checkout (existing)"
  if ! FETCH_OUT="$(git fetch origin --quiet 2>&1)"; then
    echo "__USERNODE_WARN__ fetch failed: $(clip "$FETCH_OUT")"
  fi
  if ! git checkout "$BRANCH" >/dev/null 2>&1; then
    if ! CHECKOUT_OUT="$(git checkout -b "$BRANCH" 2>&1)"; then
      die "checkout failed: $(clip "$CHECKOUT_OUT")"
    fi
  fi
fi

# Idempotent submodule sync — runs on every bootstrap (cold clone OR
# pre-existing checkout) so a long-warm container that was cloned
# before this change self-heals on next exec, and a branch switch that
# changes submodule pointers picks up the new revs. `--recursive`
# covers nested submodules; `--depth=1` keeps it cheap (~one commit
# per submodule).
if [ -f .gitmodules ]; then
  echo "__USERNODE_PHASE__ submodules"
  if ! SUBMODULE_OUT="$(git submodule update --init --recursive --depth=1 2>&1)"; then
    echo "__USERNODE_WARN__ submodule update failed: $(clip "$SUBMODULE_OUT")"
  fi
fi

if [ -n "$PAT" ]; then
  # Credential helper for the eventual `git push`. The PAT is already
  # present as an env var; this wires it into git's auth flow.
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

if [ "$MODE" = "warm" ]; then
  # Long-lived path. Wait for `docker exec /usr/local/bin/run-cc.sh`
  # invocations from the host. The phase marker tells the bootstrap
  # log-tailer the container is ready to receive work.
  touch /tmp/usernode-worker-ready || die "cannot publish worker readiness"
  echo "__USERNODE_PHASE__ warm-ready"
  exec sleep infinity
fi

# Legacy single-shot path. Hand off to the per-exec script which carries
# the actual CC + commit + push body. Identical contract to before the
# refactor; the host reads logs via `docker logs -f` until exit.
exec /usr/local/bin/run-cc.sh
