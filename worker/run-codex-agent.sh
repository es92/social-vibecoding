#!/bin/sh
# Per-exec Codex (codex_openrouter) runner for the long-lived worker
# container. Sibling of run-cc.sh — identical __USERNODE_* output contract
# so the host's journal consumer (worker.js parseLine) is unchanged:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ... agent_backend=codex_openrouter ...
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Direct-transport (review P0): Codex points DIRECTLY at OpenRouter and
# authenticates with the user's own key, injected per-turn on this specific
# `docker exec` as OPENROUTER_API_KEY. It is NOT persisted in the warm
# container's env/filesystem by the platform. Company-funded key material is
# stored internally and is never returned by the user-facing API. No platform
# relay.
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
: "${BRANCH:?BRANCH required}"
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
# Scout must NEVER receive push authority (review #4): WORKER_JWT is
# required for build (to push) but must be empty for scout.
if [ "$MODE" = "build" ] && [ -z "$WORKER_JWT" ]; then
  die "WORKER_JWT required for build mode"
fi
if [ "$MODE" = "scout" ]; then
  WORKER_JWT=""
fi
export WORKER_JWT

WORKSPACE_DIR="${WORKSPACE_DIR:-/home/node/workspace}"
cd "$WORKSPACE_DIR" || die "no workspace: $WORKSPACE_DIR"

# Pre-exec hygiene: start from a known-good tree (same as run-cc.sh).
echo "__USERNODE_PHASE__ refresh"
if ! git fetch origin --quiet 2>&1; then
  echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
fi
if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git reset --hard "origin/$BRANCH" --quiet 2>&1 || \
    echo "__USERNODE_WARN__ git reset failed"
elif [ "$MODE" = "build" ]; then
  die "branch missing upstream: origin/$BRANCH"
fi

# Codex home lives INSIDE the persistent Claude volume so session/rollout
# state survives worker eviction. Export it so Codex reads the direct
# OpenRouter config and persistent rollout dir.
export CODEX_HOME="${CODEX_HOME:-/home/node/.claude/codex-home}"
mkdir -p "$CODEX_HOME"

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
  cat <<'TOML'
approval_policy = "never"
check_for_update_on_startup = false

[analytics]
enabled = false

[features]
apps = false
plugins = false

[shell_environment_policy]
exclude = ["OPENROUTER_API_KEY"]

[agents]
enabled = false

[model_providers.usernode_openrouter]
name = "OpenRouter"
TOML
  printf 'base_url = "%s"\n' "$ESCAPED_BASE"
  cat <<'TOML'
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
TOML
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
chmod 600 "$CONFIG_TMP" || { rm -f "$CONFIG_TMP"; die "could not secure Codex config"; }
mv -f "$CONFIG_TMP" "$CODEX_HOME/config.toml" \
  || { rm -f "$CONFIG_TMP"; die "could not install Codex config"; }

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
redact_codex_stream() {
  awk '
    BEGIN { secret = ENVIRON["OPENROUTER_API_KEY"] }
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

if [ -n "$AGENT_THREAD_ID" ]; then
  echo "__USERNODE_PHASE__ codex (resume $AGENT_THREAD_ID, mode $MODE)"
  start_codex codex exec resume --dangerously-bypass-approvals-and-sandbox "$AGENT_THREAD_ID" - --json
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
      echo "__USERNODE_RESULT__ cc_exit=$CODEX_RUN_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id= agent_exit=$CODEX_RUN_EXIT agent_retry_fresh=1"
      exit "$CODEX_RUN_EXIT"
    else
      echo "__USERNODE_WARN__ codex resume failed (exit $CODEX_RUN_EXIT); NOT retrying fresh"
      CODEX_EXIT=$CODEX_RUN_EXIT
      AGENT_THREAD_OUT=""
      # The failed resume's output was already streamed live; emit a
      # terminal result so the host doesn't wait forever, then bail.
      echo "__USERNODE_RESULT__ cc_exit=$CODEX_RUN_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id= agent_exit=$CODEX_RUN_EXIT"
      exit "$CODEX_RUN_EXIT"
    fi
  fi
else
  echo "__USERNODE_PHASE__ codex (mode $MODE)"
  start_codex codex exec --dangerously-bypass-approvals-and-sandbox - --json
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

if [ "$MODE" = "scout" ]; then
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CODEX_EXIT ahead=0 behind=0 sha= push_ok=0 mode=scout agent_backend=codex_openrouter agent_model=$AGENT_MODEL agent_thread_id=$AGENT_THREAD_OUT agent_exit=$CODEX_EXIT"
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
