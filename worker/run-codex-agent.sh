#!/bin/sh
# Per-exec Codex (codex_openrouter) runner for the long-lived worker
# container. Sibling of run-cc.sh — identical __USERNODE_* output contract
# so the host's journal consumer (worker.js parseLine) is unchanged:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ... agent_backend=codex_openrouter ...
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# The worker connects to OpenRouter using the user's key, injected per-turn
# on this specific
# `docker exec` as OPENROUTER_API_KEY. It is NOT persisted in the warm
# container's env/filesystem by the platform. Company-funded key material is
# stored internally and is never returned by the user-facing API. No platform
# relay. A worker-local request adapter supplies the output cap that the
# pinned Codex CLI omits; its listener exists only during this invocation.
#
# Required env: PROMPT_FILE, BRANCH, SESSION_ID, PLATFORM_URL,
#   OPENROUTER_API_KEY, AGENT_MODEL
# Optional: MODE (build|scout), AGENT_REASONING_EFFORT, AGENT_THREAD_ID,
#   AGENT_MODEL_NAME, AGENT_MODEL_CONTEXT_WINDOW,
#   AGENT_MODEL_SUPPORTS_REASONING, AGENT_MODEL_REASONING_EFFORTS,
#   COMMIT_MSG, TURN_UUID, OPENROUTER_API_BASE, WORKER_JWT (build-only)

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

: "${PROMPT_FILE:?PROMPT_FILE required}"
[ -s "$PROMPT_FILE" ] || die "prompt file missing or empty: $PROMPT_FILE"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY required}"
: "${AGENT_MODEL:?AGENT_MODEL required}"
: "${MODE:=build}"
: "${AGENT_REASONING_EFFORT:=}"
: "${AGENT_MODEL_NAME:=}"
: "${AGENT_MODEL_CONTEXT_WINDOW:=}"
: "${AGENT_MODEL_MAX_OUTPUT_TOKENS:=}"
: "${AGENT_MODEL_SUPPORTS_REASONING:=}"
: "${AGENT_MODEL_REASONING_EFFORTS:=}"
: "${AGENT_MODEL_SUPPORTS_TOOLS:=}"
: "${AGENT_THREAD_ID:=}"
: "${COMMIT_MSG:=Changes via Homeroom (Codex)}"
: "${TURN_UUID:=}"
: "${WORKER_JWT:=}"
: "${BRANCH:=}"
: "${EVIDENCE_JWT:=}"
: "${EVIDENCE_RUN_ID:=}"
: "${EVIDENCE_BASE_ORIGIN:=}"
: "${EVIDENCE_HEAD_ORIGIN:=}"
: "${EVIDENCE_MEMBER_TOKEN:=}"
: "${EVIDENCE_ADMIN_TOKEN:=}"
: "${EVIDENCE_FULL_ADMIN_TOKEN:=}"
: "${SYSTEM_PROMPT_FILE:=}"
# Scout must NEVER receive push authority (review #4): WORKER_JWT is
# required for build (to push) but must be empty for scout.
if [ "$MODE" = "build" ] && [ -z "$WORKER_JWT" ]; then
  die "WORKER_JWT required for build mode"
fi
if [ "$MODE" = "scout" ] || [ "$MODE" = "evidence" ]; then
  WORKER_JWT=""
fi
export WORKER_JWT
if [ "$MODE" = "evidence" ]; then
  [ -n "$EVIDENCE_JWT" ] || die "EVIDENCE_JWT required for evidence mode"
  [ -n "$EVIDENCE_RUN_ID" ] || die "EVIDENCE_RUN_ID required for evidence mode"
  [ -n "$SYSTEM_PROMPT_FILE" ] && [ -s "$SYSTEM_PROMPT_FILE" ] \
    || die "system prompt file required for evidence mode"
fi

if [ "$MODE" = "evidence" ]; then
  WORKSPACE_DIR=$(mktemp -d "/tmp/usernode-evidence-agent-${EVIDENCE_RUN_ID}.XXXXXX") \
    || die "could not create evidence workspace"
else
  WORKSPACE_DIR="${WORKSPACE_DIR:-/home/node/workspace}"
fi
cd "$WORKSPACE_DIR" || die "no workspace: $WORKSPACE_DIR"

# Pre-exec hygiene: start from a known-good tree (same as run-cc.sh).
echo "__USERNODE_PHASE__ refresh"
if [ "$MODE" != "evidence" ]; then
  if ! git fetch origin --quiet 2>&1; then
    echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
  fi
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    git reset --hard "origin/$BRANCH" --quiet 2>&1 || \
      echo "__USERNODE_WARN__ git reset failed"
  elif [ "$MODE" = "build" ]; then
    die "branch missing upstream: origin/$BRANCH"
  fi
fi

# The same throwaway Postgres preparation that Claude build turns receive.
# Without it the supplied INLOOP_DATABASE_URL points at no server, and the
# agent burns its turn trying to repair a test environment it did not break.
if [ "$MODE" = "build" ]; then
  sh "$(dirname "$0")/start-inloop-db.sh" \
    || echo "__USERNODE_WARN__ in-loop postgres setup failed"
fi

# Codex home lives INSIDE the persistent Claude volume so session/rollout
# state survives worker eviction. Export it so Codex reads the direct
# OpenRouter config and persistent rollout dir.
export CODEX_HOME="${CODEX_HOME:-/home/node/.claude/codex-home}"
mkdir -p "$CODEX_HOME"

EVIDENCE_PROXY_PID=""
EVIDENCE_TMP=""
EVIDENCE_DIAGNOSTIC_TAIL_PID=""
cleanup_evidence() {
  if [ -n "$EVIDENCE_PROXY_PID" ]; then kill "$EVIDENCE_PROXY_PID" 2>/dev/null || true; fi
  if [ -n "$EVIDENCE_DIAGNOSTIC_TAIL_PID" ]; then
    sleep 0.3
    kill "$EVIDENCE_DIAGNOSTIC_TAIL_PID" 2>/dev/null || true
  fi
  if [ -n "$EVIDENCE_TMP" ]; then rm -rf "$EVIDENCE_TMP" 2>/dev/null || true; fi
}
if [ "$MODE" = "evidence" ]; then
  command -v mcp-server-playwright >/dev/null 2>&1 \
    || die "the evidence browser MCP executable is missing"
  echo "__USERNODE_PHASE__ evidence_proxy"
  EVIDENCE_TMP=$(mktemp -d "/tmp/usernode-evidence-browser-${EVIDENCE_RUN_ID}.XXXXXX") \
    || die "could not create evidence browser state"
  chmod 700 "$EVIDENCE_TMP"
  export EVIDENCE_BROWSER_STATE_DIR="$EVIDENCE_TMP/state"
  export EVIDENCE_HOSTED_ORIGINS_FILE="$EVIDENCE_BROWSER_STATE_DIR/hosted-origins.json"
  export EVIDENCE_BROWSER_DIAGNOSTIC_FILE="$EVIDENCE_TMP/browser-diagnostics.log"
  : > "$EVIDENCE_BROWSER_DIAGNOSTIC_FILE"
  tail -n +1 -s 0.2 -f "$EVIDENCE_BROWSER_DIAGNOSTIC_FILE" &
  EVIDENCE_DIAGNOSTIC_TAIL_PID=$!
  export EVIDENCE_PROXY_PORT=17891
  export EVIDENCE_PROXY_SERVER="http://127.0.0.1:$EVIDENCE_PROXY_PORT"
  export EVIDENCE_PROXY_CONTROL_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  export EVIDENCE_PROXY_READY="$EVIDENCE_TMP/proxy.ready"
  export EVIDENCE_ALLOWED_ORIGINS="[\"$EVIDENCE_BASE_ORIGIN\",\"$EVIDENCE_HEAD_ORIGIN\"]"
  node /usr/local/bin/evidence-origin-proxy.js &
  EVIDENCE_PROXY_PID=$!
  trap cleanup_evidence EXIT INT TERM
  i=0
  while [ ! -f "$EVIDENCE_PROXY_READY" ] && [ "$i" -lt 100 ]; do i=$((i+1)); sleep 0.05; done
  [ -f "$EVIDENCE_PROXY_READY" ] || die "evidence origin proxy failed to start"
  echo "__USERNODE_PHASE__ evidence_browser_bootstrap"
  node /usr/local/bin/evidence-browser-bootstrap.js \
    || die "evidence browser authentication failed"
  unset EVIDENCE_MEMBER_TOKEN EVIDENCE_ADMIN_TOKEN EVIDENCE_FULL_ADMIN_TOKEN
fi

# TOML-safe escaping (quotes/backslashes/newlines) so attacker-controlled
# model strings cannot inject extra TOML/MCP sections into config.toml.
toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}
ESCAPED_MODEL=$(toml_escape "$AGENT_MODEL")
OPENROUTER_API_BASE="${OPENROUTER_API_BASE:-https://openrouter.ai/api/v1}"
ESCAPED_BASE=$(toml_escape "$OPENROUTER_API_BASE")
if [ -n "$AGENT_REASONING_EFFORT" ]; then
  ESCAPED_EFFORT=$(toml_escape "$AGENT_REASONING_EFFORT")
fi

# The worker container is the security boundary for repository commands.
# Running Codex's Linux bwrap sandbox inside it requires unprivileged user
# namespaces, which the production worker kernel deliberately does not grant.
# Disable only that nested layer; Docker confinement and the mode-specific
# narrow credentials remain in force around the whole turn.
SANDBOX_MODE=danger-full-access

# Install metadata for the exact OpenRouter slug selected by the user. Codex's
# bundled catalog contains only OpenAI-native slugs; without this catalog it
# emits a scary-but-nonfatal unknown-model diagnostic and uses degraded
# fallback context/tool metadata for every other OpenRouter model.
MODEL_CATALOG_PATH="$CODEX_HOME/openrouter-model-catalog.json"
MODEL_CATALOG_TMP=$(mktemp "$CODEX_HOME/openrouter-model-catalog.json.tmp.XXXXXX") \
  || die "could not create OpenRouter model metadata"
MODEL_CATALOG_BUILDER="$(dirname "$0")/build-codex-model-catalog.js"
if ! node "$MODEL_CATALOG_BUILDER" > "$MODEL_CATALOG_TMP"; then
  rm -f "$MODEL_CATALOG_TMP"
  die "could not generate OpenRouter model metadata"
fi
if grep -Fq -- "$OPENROUTER_API_KEY" "$MODEL_CATALOG_TMP"; then
  rm -f "$MODEL_CATALOG_TMP"
  die "refusing model metadata containing the OpenRouter key"
fi
chmod 600 "$MODEL_CATALOG_TMP" \
  || { rm -f "$MODEL_CATALOG_TMP"; die "could not secure OpenRouter model metadata"; }
mv -f "$MODEL_CATALOG_TMP" "$MODEL_CATALOG_PATH" \
  || { rm -f "$MODEL_CATALOG_TMP"; die "could not install OpenRouter model metadata"; }
ESCAPED_MODEL_CATALOG_PATH=$(toml_escape "$MODEL_CATALOG_PATH")

# Generate into a private temporary file and atomically replace the previous
# per-turn config. Keep every static TOML byte in quoted heredocs: an unquoted
# heredoc performs command substitution, even inside TOML comments. The old
# writer contained backtick-wrapped command names in a comment, which executed
# those commands and persisted the complete worker environment (including the
# OpenRouter key) into config.toml. Dynamic values are emitted separately after
# TOML escaping so there is no executable shell syntax in the template.
CONFIG_TMP=$(mktemp "$CODEX_HOME/config.toml.tmp.XXXXXX") \
  || die "could not create Codex config"
if ! {
  printf 'model_provider = "usernode_openrouter"\n'
  printf 'model = "%s"\n' "$ESCAPED_MODEL"
  printf 'model_catalog_json = "%s"\n' "$ESCAPED_MODEL_CATALOG_PATH"
  if [ -n "$AGENT_REASONING_EFFORT" ]; then
    printf 'model_reasoning_effort = "%s"\n' "$ESCAPED_EFFORT"
  fi
  printf '\n'
  printf 'sandbox_mode = "%s"\n' "$SANDBOX_MODE"
  if [ "$MODE" = "evidence" ]; then
    printf 'web_search = "disabled"\n'
    printf 'developer_instructions = "%s"\n' "$(toml_escape "$(cat "$SYSTEM_PROMPT_FILE")")"
  fi
  cat <<'TOML'
approval_policy = "never"
check_for_update_on_startup = false

[analytics]
enabled = false

[features]
apps = false
plugins = false
TOML
  if [ "$MODE" = "evidence" ]; then
    printf 'shell_tool = false\n'
    printf 'unified_exec = false\n'
    printf 'multi_agent = false\n'
    printf 'skill_mcp_dependency_install = false\n'
  fi
  cat <<'TOML'

[shell_environment_policy]
TOML
  # #2779: the read-only Homeroom grant stays out of commands the model
  # launches, like the provider key. Only its MCP bridge receives it.
  if [ -n "${HOMEROOM_MCP_TOKEN:-}" ]; then
    printf 'exclude = ["OPENROUTER_API_KEY", "HOMEROOM_MCP_TOKEN"]\n'
  else
    printf 'exclude = ["OPENROUTER_API_KEY"]\n'
  fi
  cat <<'TOML'

[agents]
enabled = false

[model_providers.usernode_openrouter]
name = "OpenRouter"
TOML
  printf 'base_url = "%s"\n' "$ESCAPED_BASE"
  # Codex retries a dropped stream five times by default. A provider that
  # is refusing the request (out of credit, a rejected key) refuses every
  # retry too, so the default budget turns one refusal into a minute of
  # identical "Reconnecting..." lines. Three rides out a genuine blip
  # without hiding a hard refusal (#2676).
  cat <<'TOML'
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
stream_max_retries = 3
request_max_retries = 3
TOML
  # #2380: browser parity with hosted Claude build turns. This is the
  # platform-seeded config, never a repository .mcp.toml. Scout remains
  # browser-free; the dedicated evidence mode receives a stricter run-scoped
  # server when that mode is dispatched by the evidence orchestrator.
  if [ "$MODE" = "build" ]; then
    ESCAPED_BROWSER_CONFIG=$(toml_escape "${BROWSER_PW_CONFIG:-/home/node/.usernode-playwright.json}")
    cat <<'TOML'

[mcp_servers.playwright]
command = "/usr/local/bin/mcp-server-playwright"
TOML
    printf 'args = ["--browser", "chromium", "--headless", "--isolated", "--no-sandbox", "--config", "%s"]\n' "$ESCAPED_BROWSER_CONFIG"
    cat <<'TOML'
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.visual_intent]
command = "node"
args = ["/usr/local/bin/build-evidence-mcp.js"]
env_vars = ["WORKER_JWT", "SESSION_ID", "PLATFORM_URL"]
enabled_tools = ["record_visual_evidence_intent"]
startup_timeout_sec = 15
tool_timeout_sec = 30
TOML
  elif [ "$MODE" = "evidence" ]; then
    BROWSER_ALLOWED_ORIGINS=$(node /usr/local/bin/evidence-hosted-origins.js \
      "$EVIDENCE_BASE_ORIGIN" "$EVIDENCE_HEAD_ORIGIN" "$EVIDENCE_HOSTED_ORIGINS_FILE") \
      || die "could not load evidence hosted-app catalog"
    ESCAPED_BROWSER_ALLOWED_ORIGINS=$(toml_escape "$BROWSER_ALLOWED_ORIGINS")
    ESCAPED_PROXY=$(toml_escape "$EVIDENCE_PROXY_SERVER")
    ESCAPED_MEMBER_STATE=$(toml_escape "$EVIDENCE_BROWSER_STATE_DIR/member.json")
    ESCAPED_ADMIN_STATE=$(toml_escape "$EVIDENCE_BROWSER_STATE_DIR/read_only_admin.json")
    ESCAPED_FULL_ADMIN_STATE=$(toml_escape "$EVIDENCE_BROWSER_STATE_DIR/full_admin.json")
    cat <<'TOML'

[mcp_servers.evidence]
command = "node"
args = ["/usr/local/bin/evidence-mcp.js"]
env_vars = ["EVIDENCE_JWT", "EVIDENCE_RUN_ID", "PLATFORM_URL", "EVIDENCE_PROXY_SERVER", "EVIDENCE_PROXY_CONTROL_TOKEN", "EVIDENCE_HOSTED_ORIGINS_FILE"]
enabled_tools = ["evidence_get_context", "evidence_reset_side", "evidence_set_request_failure", "evidence_run_plan"]
startup_timeout_sec = 15
tool_timeout_sec = 720

[mcp_servers.browser_member]
command = "node"
TOML
    printf 'args = ["/usr/local/bin/evidence-browser-observer.js", "member", "--browser", "chromium", "--headless", "--isolated", "--no-sandbox", "--caps", "vision", "--storage-state", "%s", "--allowed-origins", "%s", "--block-service-workers", "--image-responses", "allow", "--proxy-server", "%s", "--timeout-action", "10000", "--timeout-navigation", "30000"]\n' "$ESCAPED_MEMBER_STATE" "$ESCAPED_BROWSER_ALLOWED_ORIGINS" "$ESCAPED_PROXY"
    cat <<'TOML'
env_vars = ["EVIDENCE_ALLOWED_ORIGINS", "EVIDENCE_BROWSER_DIAGNOSTIC_FILE", "EVIDENCE_NAVIGATION_HINTS"]
enabled_tools = ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_mouse_move_xy", "browser_drag", "browser_resize", "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_tabs", "browser_close"]
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.browser_admin]
command = "node"
TOML
    printf 'args = ["/usr/local/bin/evidence-browser-observer.js", "admin", "--browser", "chromium", "--headless", "--isolated", "--no-sandbox", "--caps", "vision", "--storage-state", "%s", "--allowed-origins", "%s", "--block-service-workers", "--image-responses", "allow", "--proxy-server", "%s", "--timeout-action", "10000", "--timeout-navigation", "30000"]\n' "$ESCAPED_ADMIN_STATE" "$ESCAPED_BROWSER_ALLOWED_ORIGINS" "$ESCAPED_PROXY"
    cat <<'TOML'
env_vars = ["EVIDENCE_ALLOWED_ORIGINS", "EVIDENCE_BROWSER_DIAGNOSTIC_FILE", "EVIDENCE_NAVIGATION_HINTS"]
enabled_tools = ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_mouse_move_xy", "browser_drag", "browser_resize", "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_tabs", "browser_close"]
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.browser_full_admin]
command = "node"
TOML
    printf 'args = ["/usr/local/bin/evidence-browser-observer.js", "full_admin", "--browser", "chromium", "--headless", "--isolated", "--no-sandbox", "--caps", "vision", "--storage-state", "%s", "--allowed-origins", "%s", "--block-service-workers", "--image-responses", "allow", "--proxy-server", "%s", "--timeout-action", "10000", "--timeout-navigation", "30000"]\n' "$ESCAPED_FULL_ADMIN_STATE" "$ESCAPED_BROWSER_ALLOWED_ORIGINS" "$ESCAPED_PROXY"
    cat <<'TOML'
env_vars = ["EVIDENCE_ALLOWED_ORIGINS", "EVIDENCE_BROWSER_DIAGNOSTIC_FILE", "EVIDENCE_NAVIGATION_HINTS"]
enabled_tools = ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_mouse_move_xy", "browser_drag", "browser_resize", "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_tabs", "browser_close"]
startup_timeout_sec = 30
tool_timeout_sec = 60
TOML
  fi
  # #2779: the coding agent's read-only Homeroom tools, for a build or scout
  # turn the platform issued a grant to. The bridge receives the grant from
  # this process's environment through env_vars; the config names only the
  # variable, never its value.
  if [ -n "${HOMEROOM_MCP_TOKEN:-}" ] && { [ "$MODE" = "build" ] || [ "$MODE" = "scout" ]; }; then
    cat <<'TOML'

[mcp_servers.homeroom]
command = "node"
args = ["/usr/local/bin/homeroom-read-mcp.js"]
env_vars = ["HOMEROOM_MCP_TOKEN", "PLATFORM_URL"]
enabled_tools = ["get_platform_conventions", "get_app", "list_requests", "get_request", "get_proposal", "get_change"]
startup_timeout_sec = 15
tool_timeout_sec = 30
TOML
  fi
} > "$CONFIG_TMP"; then
  rm -f "$CONFIG_TMP"
  die "could not write Codex config"
fi

# Defense in depth: the provider credential belongs only in this process's
# environment. Refuse to launch Codex if a future config change ever persists
# the literal key again.
if grep -Fq -- "$OPENROUTER_API_KEY" "$CONFIG_TMP"; then
  rm -f "$CONFIG_TMP"
  die "refusing Codex config containing the OpenRouter key"
fi
if [ -n "${HOMEROOM_MCP_TOKEN:-}" ] && grep -Fq -- "$HOMEROOM_MCP_TOKEN" "$CONFIG_TMP"; then
  rm -f "$CONFIG_TMP"
  die "refusing Codex config containing the Homeroom grant"
fi
chmod 600 "$CONFIG_TMP" || { rm -f "$CONFIG_TMP"; die "could not secure Codex config"; }
mv -f "$CONFIG_TMP" "$CODEX_HOME/config.toml" \
  || { rm -f "$CONFIG_TMP"; die "could not install Codex config"; }
if [ "$MODE" = "evidence" ]; then
  echo "__USERNODE_PHASE__ evidence_mcp_ready"
fi

# Export the user's key for this process only.
export OPENROUTER_API_KEY

CODEX_EXIT=0
AGENT_THREAD_OUT="$AGENT_THREAD_ID"
TMP_JSONL=$(mktemp /home/node/.usernode/turn-codex-XXXX.jsonl 2>/dev/null || mktemp)

# The prompt is fed on stdin (a detached docker exec has no inherited
# stdin). Dash has no PIPESTATUS, so we capture codex's exit code via a
# subshell that writes it to a status file, and stream codex output LIVE
# to the turn journal through tee (review P4: long turns must show tool/
# edit progress in real time, not only after codex exits). The same tee
# writes a copy to TMP_JSONL for thread-id extraction and resume-failure
# classification.

CODEX_RUN_EXIT=0
TMP_STATUS=$(mktemp /home/node/.usernode/turn-codex-status-XXXX 2>/dev/null || mktemp)

# Codex JSONL includes command output. Scrub the exact per-turn credential
# before it reaches either tee's temporary copy or the host's durable turn
# journal. awk's index/substr path is literal (not regex based), so keys that
# contain replacement or regex metacharacters are handled safely.
#
# mawk (the image's awk) reads a pipe until its input buffer is full before
# it processes a line, and that buffer grows to the longest line it has read.
# Without -W interactive, one large command output holds the journal back by
# that many bytes for the rest of the turn, so live progress stops until
# enough later output arrives to fill it again.
if command -v mawk >/dev/null 2>&1; then REDACT_AWK="mawk -W interactive"; else REDACT_AWK=awk; fi
redact_codex_stream() {
  # shellcheck disable=SC2086
  $REDACT_AWK '
    BEGIN { secret = ENVIRON["OPENROUTER_API_KEY"]; grant = ENVIRON["HOMEROOM_MCP_TOKEN"] }
    {
      # Codex emits a structured JSON retry event immediately after this
      # internal Rust warning. Drop the duplicate implementation detail so
      # users see the provider-neutral retry message from the JSON adapter.
      if ($0 ~ / WARN codex_core::responses_retry:/) next
      if ($0 == "Reading additional input from stdin...") next
      if (secret != "") {
        while ((at = index($0, secret)) > 0) {
          $0 = substr($0, 1, at - 1) "****" substr($0, at + length(secret))
        }
      }
      # #2779: the read-only Homeroom grant, scrubbed the same literal way.
      if (grant != "") {
        while ((at = index($0, grant)) > 0) {
          $0 = substr($0, 1, at - 1) "****" substr($0, at + length(grant))
        }
      }
      print
      fflush()
    }
  '
}

start_codex() {
  # shellcheck disable=SC2086
  ( "$@" < "$PROMPT_FILE"; echo $? > "$TMP_STATUS" ) 2>&1 \
    | redact_codex_stream \
    | tee "$TMP_JSONL"
  CODEX_RUN_EXIT=$(cat "$TMP_STATUS")
}

CODEX_REQUEST_WRAPPER="$(dirname "$0")/codex-openrouter-request.js"

# A scout is read-only by contract: it reads the repository and writes the
# spec as its final message. run-cc.sh enforces that with
# --disallowed-tools; Codex runs danger-full-access inside this container
# (see SANDBOX_MODE above) and has no equivalent switch. Now that OpenRouter
# sessions scout through the Mayor (#2810), whatever a scout edits,
# creates or commits is put back before the next build's `git add -A` could
# publish it. Files that were already untracked before the scout are kept.
SCOUT_BASE_SHA=""
SCOUT_PRE_UNTRACKED=""
if [ "$MODE" = "scout" ] && git rev-parse --verify HEAD >/dev/null 2>&1; then
  SCOUT_BASE_SHA=$(git rev-parse HEAD)
  SCOUT_PRE_UNTRACKED=$(mktemp /home/node/.usernode/scout-untracked-XXXX 2>/dev/null || mktemp)
  git ls-files --others --exclude-standard > "$SCOUT_PRE_UNTRACKED" 2>/dev/null || true
fi
restore_scout_tree() {
  [ -n "$SCOUT_BASE_SHA" ] || return 0
  SCOUT_NEW_UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null \
    | grep -vxF -f "$SCOUT_PRE_UNTRACKED" || true)
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] \
    || [ -n "$SCOUT_NEW_UNTRACKED" ] \
    || [ "$(git rev-parse HEAD 2>/dev/null)" != "$SCOUT_BASE_SHA" ]; then
    echo "__USERNODE_WARN__ scout changed the repository; discarding its changes"
  fi
  # A mixed reset first, so a scout commit's files return to the working
  # tree rather than being deleted: one that swept an already-untracked file
  # into its commit must not cost the user that file. Tracked content then
  # goes back to the base, and only the files the scout added are removed.
  if git reset --quiet "$SCOUT_BASE_SHA" 2>/dev/null; then
    git checkout --quiet -- . 2>/dev/null || true
  else
    echo "__USERNODE_WARN__ could not restore the tree after the scout"
  fi
  SCOUT_NEW_UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null \
    | grep -vxF -f "$SCOUT_PRE_UNTRACKED" || true)
  if [ -n "$SCOUT_NEW_UNTRACKED" ]; then
    printf '%s\n' "$SCOUT_NEW_UNTRACKED" | while IFS= read -r scout_path; do
      [ -n "$scout_path" ] && rm -f -- "$scout_path"
    done
  fi
  rm -f "$SCOUT_PRE_UNTRACKED" 2>/dev/null
  SCOUT_BASE_SHA=""
}

if [ -n "$AGENT_THREAD_ID" ]; then
  echo "__USERNODE_PHASE__ codex (resume $AGENT_THREAD_ID, mode $MODE)"
  start_codex node "$CODEX_REQUEST_WRAPPER" exec resume --dangerously-bypass-approvals-and-sandbox "$AGENT_THREAD_ID" - --json
  if [ "$CODEX_RUN_EXIT" -ne 0 ]; then
    # Only retry fresh for a genuinely missing/stale thread (review P4):
    # auth/credit/rate-limit/unknown failures must NOT re-run (they'd
    # repeat billed work against a partially modified tree). The JSONL also
    # contains agent messages and command output, so classify only top-level
    # terminal errors and fail closed if any turn/item activity was observed.
    RESUME_CLASSIFIER="$(dirname "$0")/classify-codex-resume.js"
    if node "$RESUME_CLASSIFIER" "$TMP_JSONL"; then
      # Do not run a second physical Codex request inside this runner. The
      # host owns attempt accounting, so ask it to dispatch a fresh attempt
      # with a new agent_turns row and no resume id.
      echo "__USERNODE_WARN__ codex thread missing (exit $CODEX_RUN_EXIT); requesting fresh retry"
      rm -f "$TMP_STATUS" "$TMP_JSONL" 2>/dev/null
      restore_scout_tree
      echo "__USERNODE_RESULT__ cc_exit=$CODEX_RUN_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id= agent_exit=$CODEX_RUN_EXIT agent_retry_fresh=1"
      exit "$CODEX_RUN_EXIT"
    else
      echo "__USERNODE_WARN__ codex resume failed (exit $CODEX_RUN_EXIT); NOT retrying fresh"
      CODEX_EXIT=$CODEX_RUN_EXIT
      AGENT_THREAD_OUT=""
      restore_scout_tree
      # The failed resume's output was already streamed live; emit a
      # terminal result so the host doesn't wait forever, then bail.
      echo "__USERNODE_RESULT__ cc_exit=$CODEX_RUN_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id= agent_exit=$CODEX_RUN_EXIT"
      exit "$CODEX_RUN_EXIT"
    fi
  fi
else
  echo "__USERNODE_PHASE__ codex (mode $MODE)"
  start_codex node "$CODEX_REQUEST_WRAPPER" exec --dangerously-bypass-approvals-and-sandbox - --json
fi
CODEX_EXIT=$CODEX_RUN_EXIT
rm -f "$TMP_STATUS" 2>/dev/null

# Extract the thread id from thread.started for resume on the next turn.
if [ -z "$AGENT_THREAD_OUT" ]; then
  EXTRACTED=$(grep -o '"type":"thread.started","thread_id":"[^"]*"' "$TMP_JSONL" | head -1 | sed 's/.*"thread_id":"//;s/"$//')
  if [ -n "$EXTRACTED" ]; then
    AGENT_THREAD_OUT="$EXTRACTED"
  fi
fi
rm -f "$TMP_JSONL" 2>/dev/null

if [ "$MODE" = "scout" ] || [ "$MODE" = "evidence" ]; then
  restore_scout_tree
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
  exit "$CODEX_EXIT"
fi

# A failed (non-zero) codex turn must NOT be committed or pushed — doing so
# would publish partial/incomplete work. Emit a terminal result and bail.
if [ "$CODEX_EXIT" -ne 0 ]; then
  echo "__USERNODE_WARN__ codex exited non-zero ($CODEX_EXIT); skipping commit/push"
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=0 behind=0 sha= push_ok=0 mode=build agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
  exit "$CODEX_EXIT"
fi

echo "__USERNODE_PHASE__ commit"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "$COMMIT_MSG" || echo "__USERNODE_WARN__ commit failed"
fi

echo "__USERNODE_PHASE__ push"
PUSH_OK=0
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$HEAD_BRANCH" != "$BRANCH" ]; then
  echo "__USERNODE_WARN__ HEAD branch ($HEAD_BRANCH) != session branch ($BRANCH); skipping push"
elif /usr/local/bin/usernode-push; then
  PUSH_OK=1
else
  echo "__USERNODE_WARN__ push failed"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

if [ "$PUSH_OK" = "1" ]; then
  echo "__USERNODE_PHASE__ done"
else
  echo "__USERNODE_PHASE__ push_failed"
fi
echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=build agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
exit "$CODEX_EXIT"
