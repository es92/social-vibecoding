#!/bin/sh
# Per-exec Claude Code runner for the long-lived worker container.
#
# The worker container is bootstrapped once per session by `worker-run.sh`
# (clone + checkout + restore .claude.json + sleep infinity). Each turn
# the host invokes this script via `docker exec -e PROMPT_FILE=...
# -e MODE=build|scout <container> /usr/local/bin/run-cc.sh`. We do NOT
# re-clone — the workspace is reused across turns. Pre-exec hygiene
# (git fetch + reset --hard) gets us back to a known-good tree even
# if a prior turn left things dirty.
#
# Output contract is identical to the legacy single-shot worker-run.sh
# so the host's stream-json + USERNODE_* parser doesn't change:
#   __USERNODE_PHASE__  <phase>
#   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N mode=… [sync_result=…]
#   __USERNODE_WARN__   <msg>
#   __USERNODE_ERROR__  <msg>
#
# Required env (passed via -e on `docker exec`):
#   PROMPT_FILE, BRANCH, SESSION_ID, PLATFORM_URL
#   SYSTEM_PROMPT_FILE         required for build; authoritative platform
#                              handbook appended to Claude's system prompt
#   RESUME_FALLBACK_PROMPT_FILE optional for a resumed build; complete task
#                              prompt used only if --resume fails and this
#                              runner retries Claude without history
#
#   PROMPT_FILE points at the dispatch prompt the host materialized into
#   the CC volume before this exec (see worker.js writeTurnPrompt). The
#   prompt deliberately does NOT travel as an env value: Linux caps a
#   single argv/env string at 128 KiB, and build prompts (conventions +
#   spec doc) legitimately exceed it — passing them inline killed the
#   dispatch with E2BIG. It is piped to `claude` on stdin below for the
#   same reason.
# Optional env:
#   MODE                       build (default) | scout | sync
#   WORKER_JWT                 required for build/sync; absent for scout
#   MODEL                      default: claude-sonnet-5
#   COMMIT_MSG                 default: "Changes via Homeroom"
#   CLAUDE_RESUME_SESSION_ID   if set, passes `--resume <id>` to claude
#   PAT                        legacy back-compat — not set by the
#                              current platform. The push step uses
#                              `usernode-push` (which calls back into
#                              the platform's internal proxy), not
#                              direct `git push` with embedded creds.
#
# MODE=sync (#8): merge origin/main into the current branch and push.
#   1. git fetch origin
#   2. git reset --hard origin/$BRANCH (same hygiene as build)
#   3. git merge origin/main --no-edit
#      - clean → commit (already done by merge), push, sync_result=clean,
#        no CC invocation, no LLM spend
#      - conflict → leave conflict markers in working tree, invoke CC
#        with a resolution-only prompt, then sanity-check no markers
#        remain; commit + push if clean, abort if not
#         - resolved   = CC fixed it, push succeeded
#         - conflict   = CC failed; merge aborted, branch unchanged
#   Sync turns intentionally don't refresh CC's --resume session id —
#   they're a side-effect operation and shouldn't blow CC's main
#   conversation context.

set -u

die() {
  echo "__USERNODE_ERROR__ $*"
  exit 1
}

# A container can restart after the platform's readiness read. Refuse to
# inspect or reset its Git checkout until this incarnation finishes bootstrap.
if [ "${USERNODE_WORKER_REQUIRE_READY:-0}" = "1" ] && [ ! -f /tmp/usernode-worker-ready ]; then
  die "worker bootstrap is not ready; retry after the worker finishes starting"
fi

: "${PROMPT_FILE:?PROMPT_FILE required}"
[ -s "$PROMPT_FILE" ] || die "prompt file missing or empty: $PROMPT_FILE"
: "${SESSION_ID:?SESSION_ID required}"
: "${PLATFORM_URL:?PLATFORM_URL required}"
: "${MODE:=build}"
: "${BRANCH:=}"
: "${WORKER_JWT:=}"
: "${MODEL:=claude-sonnet-5}"
: "${COMMIT_MSG:=Changes via Homeroom}"
: "${PAT:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"
: "${SYSTEM_PROMPT_FILE:=}"
: "${RESUME_FALLBACK_PROMPT_FILE:=}"
: "${BROWSER_MCP_CONFIG:=/home/node/.usernode-mcp.json}"
: "${EVIDENCE_JWT:=}"
: "${EVIDENCE_RUN_ID:=}"
: "${EVIDENCE_BASE_ORIGIN:=}"
: "${EVIDENCE_HEAD_ORIGIN:=}"
: "${EVIDENCE_MEMBER_TOKEN:=}"
: "${EVIDENCE_ADMIN_TOKEN:=}"
: "${EVIDENCE_FULL_ADMIN_TOKEN:=}"

SYSTEM_PROMPT_FLAGS=""

# Scout is deliberately read-only and receives no general worker token.
# Build/sync still require the token for their platform push callbacks.
if { [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; } && [ -z "$WORKER_JWT" ]; then
  die "WORKER_JWT required for $MODE mode"
fi
if [ "$MODE" = "scout" ] || [ "$MODE" = "evidence" ]; then
  WORKER_JWT=""
fi
export WORKER_JWT
if [ "$MODE" = "evidence" ]; then
  [ -n "$EVIDENCE_JWT" ] || die "EVIDENCE_JWT required for evidence mode"
  [ -n "$EVIDENCE_RUN_ID" ] || die "EVIDENCE_RUN_ID required for evidence mode"
fi

# Every hosted build has a shortened task prompt and therefore requires the
# separate authoritative system context. Fail before invoking Claude if the
# host omitted it or failed to materialize it; there is no reduced-context
# fallback that could silently drop platform rules.
if { [ "$MODE" = "build" ] || [ "$MODE" = "evidence" ]; } && [ -z "$SYSTEM_PROMPT_FILE" ]; then
  die "SYSTEM_PROMPT_FILE required for $MODE mode"
fi
if [ -n "$SYSTEM_PROMPT_FILE" ]; then
  [ -s "$SYSTEM_PROMPT_FILE" ] \
    || die "system prompt file missing or empty: $SYSTEM_PROMPT_FILE"
  SYSTEM_PROMPT_FLAGS="--append-system-prompt-file $SYSTEM_PROMPT_FILE"
fi
if [ -n "$RESUME_FALLBACK_PROMPT_FILE" ]; then
  [ "$MODE" = "build" ] \
    || die "RESUME_FALLBACK_PROMPT_FILE is only valid for build mode"
  [ -n "$CLAUDE_RESUME_SESSION_ID" ] \
    || die "RESUME_FALLBACK_PROMPT_FILE requires CLAUDE_RESUME_SESSION_ID"
  [ -s "$RESUME_FALLBACK_PROMPT_FILE" ] \
    || die "resume fallback prompt file missing or empty: $RESUME_FALLBACK_PROMPT_FILE"
fi

if [ "$MODE" = "evidence" ]; then
  WORKSPACE_DIR=$(mktemp -d "/tmp/usernode-evidence-agent-${EVIDENCE_RUN_ID}.XXXXXX") \
    || die "could not create evidence workspace"
else
  WORKSPACE_DIR="${WORKSPACE_DIR:-/home/node/workspace}"
fi
cd "$WORKSPACE_DIR" || die "no workspace: $WORKSPACE_DIR"

# Re-assert the credential helper. The warm wrapper sets it up at
# bootstrap; this is defensive in case the .git/config was perturbed.
if [ -n "$PAT" ] && ! git config --get credential.helper >/dev/null 2>&1; then
  git config credential.helper \
    "!f() { echo username=x-access-token; echo password=$PAT; }; f"
fi

# Pre-exec hygiene: every turn starts from a known-good tree. Pulls in
# anything pushed by a parallel turn / merge bot since we last ran, and
# discards any uncommitted state from a prior turn that didn't get
# committed (rare, but worth defending against).
echo "__USERNODE_PHASE__ refresh"
if [ "$MODE" != "evidence" ]; then
  if ! git fetch origin --quiet 2>&1; then
    echo "__USERNODE_WARN__ git fetch failed; continuing with local state"
  fi
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    git reset --hard "origin/$BRANCH" --quiet 2>&1 || \
      echo "__USERNODE_WARN__ git reset failed"
  elif [ "$MODE" = "build" ] || [ "$MODE" = "sync" ]; then
    # Branch missing upstream after PR merge → unrecoverable for build/sync.
    # Scout mode can still run against the local checkout, so we don't bail.
    die "branch missing upstream: origin/$BRANCH"
  fi
fi

# ── MODE=sync ─────────────────────────────────────────────────────────
# Merge origin/main into the current branch. Try clean merge first; if
# it conflicts, hand the conflicted tree to CC with a tight prompt.
# We deliberately do NOT pass --resume here — sync is bookkeeping, not
# part of the conversation history.
if [ "$MODE" = "sync" ]; then
  echo "__USERNODE_PHASE__ sync_fetch_main"
  git fetch origin main --quiet 2>&1 || \
    echo "__USERNODE_WARN__ fetch origin main failed"

  # Quick precheck — if we're already up to date, there's nothing to do
  # and we want to skip CC entirely. push_ok=0 because NOTHING was pushed
  # here — a hard-coded 1 masked "did an earlier push actually reach
  # GitHub?" during incident debugging (the local branch containing
  # origin/main says nothing about the remote's state).
  BEHIND_NOW=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  if [ "$BEHIND_NOW" = "0" ]; then
    AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
    SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
    echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=0 sha=$SHA push_ok=0 mode=sync sync_result=already_synced"
    exit 0
  fi

  # #361: comma-delimited list of files that conflicted on this sync.
  # Captured at conflict-detection time (below) and surfaced on every
  # __USERNODE_RESULT__ line so the platform can persist which files
  # conflicted — even on the resolved path, where the index is clean by
  # the time we emit. Empty for a clean merge.
  CONFLICT_FILES_CSV=""

  echo "__USERNODE_PHASE__ sync_merge"
  # `git merge origin/main` produces a merge commit on clean success
  # and leaves the tree dirty on conflict. We let it fail-non-zero
  # without `set -e` here on purpose.
  if git merge origin/main --no-edit -m "Merge origin/main via Homeroom sync" 2>&1; then
    # Clean merge → already committed by `git merge`.
    SYNC_RESULT="clean"
  else
    # Conflict path. Hand off to CC.
    echo "__USERNODE_PHASE__ sync_conflict_cc"
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    # Comma-delimited (no spaces) so it rides cleanly on the
    # space-delimited __USERNODE_RESULT__ key/value line.
    CONFLICT_FILES_CSV=$(git diff --name-only --diff-filter=U 2>/dev/null | paste -sd, - | sed 's/,$//')
    SYNC_PROMPT="A merge of origin/main into branch '$BRANCH' produced conflicts. The conflict markers (<<<<<<<, =======, >>>>>>>) are in the working tree.

Conflicted files: $CONFLICT_FILES

Resolve every conflict marker. Preserve the intent of both sides — keep the changes from main AND keep the work-in-progress on this branch. Do NOT add features or change behavior beyond what's needed to integrate cleanly. When done, every conflict marker must be gone from every file.

Do not run git commands. I will commit and push for you after you finish editing files."

    claude --print --dangerously-skip-permissions --verbose \
      --model "$MODEL" --output-format stream-json -p "$SYNC_PROMPT"
    CC_EXIT=$?

    # Sanity check: any conflict markers left? If yes, the merge is
    # not resolvable — abort cleanly so the next attempt starts from
    # a sane state. We deliberately only check for `<<<<<<<` and
    # `>>>>>>>` (not `=======`); `=======` on its own line is a
    # legitimate markdown setext h2 underline and would false-positive
    # any spec/README that uses that style.
    if grep -rlE --exclude-dir='.git' '^(<<<<<<<|>>>>>>>)( |$)' . 2>/dev/null | grep -q .; then
      echo "__USERNODE_WARN__ CC left conflict markers; aborting merge"
      git merge --abort 2>&1 || echo "__USERNODE_WARN__ merge --abort failed"
      AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
      SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi

    # CC resolved cleanly — stage everything (CC may have edited files
    # outside the conflict set as a side effect; we want them all in
    # the merge commit) and commit.
    git add -A
    if ! git commit -m "Merge origin/main via Homeroom sync (Claude-resolved)" 2>&1; then
      echo "__USERNODE_WARN__ commit failed after conflict resolution"
      git merge --abort 2>&1 || true
      echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=$BEHIND_NOW sha= push_ok=0 mode=sync sync_result=conflict conflict_files=$CONFLICT_FILES_CSV"
      exit 0
    fi
    SYNC_RESULT="resolved"
  fi

  # Push the merge commit (clean or resolved).
  echo "__USERNODE_PHASE__ sync_push"
  PUSH_OK=0
  if /usr/local/bin/usernode-push; then
    PUSH_OK=1
  else
    echo "__USERNODE_WARN__ push failed"
  fi

  # Re-fetch so origin/main is fresh for the behind count below.
  git fetch origin main --quiet 2>/dev/null || true
  AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
  SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
  echo "__USERNODE_RESULT__ cc_exit=0 ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=sync sync_result=$SYNC_RESULT conflict_files=$CONFLICT_FILES_CSV"
  exit 0
fi
# ── end MODE=sync ─────────────────────────────────────────────────────

# Scout permissions: previously `--permission-mode plan`, but plan mode
# blocks all write-flavoured Bash with a generic "Bash: error" — so the
# agent kept grinding through `git submodule update`, `gh api`, etc.,
# burning tokens on tools it didn't realise were denied. We now run
# scout with the same `--dangerously-skip-permissions` as build, but
# strip Edit/Write/NotebookEdit at the tool layer so file mutations are
# impossible regardless of what CC tries. The remaining safety nets:
#   - `git reset --hard origin/$BRANCH` at the top of every turn (above)
#     wipes any uncommitted/local commits the next turn would otherwise
#     inherit
#   - this script's MODE=scout branch (below) skips the commit/push
#     block entirely
#   - usernode-push refuses if MODE=scout (worker/usernode-push)
#   - every scout callback credential is purpose-bound: ISSUES_JWT can only
#     read issues/attachments, ANTHROPIC_API_KEY can only reach the model
#     proxy, and PROD_DEBUG_JWT can only reach read-only diagnostics;
#     no worker:session token is minted under any alias
# Net effect: scout has full read-only Bash + WebFetch (so it can run
# `git submodule update --init`, `gh api`, etc.) but cannot escape the
# worker container even if CC misbehaves.
if [ "$MODE" = "scout" ]; then
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools Edit Write NotebookEdit"
elif [ "$MODE" = "evidence" ]; then
  # Evidence turns operate only through platform-seeded MCP servers. Removing
  # every filesystem, shell, web and delegation tool prevents the model from
  # reading browser storage state or inherited process credentials.
  PERMISSION_FLAGS="--dangerously-skip-permissions --disallowed-tools Bash Edit Write NotebookEdit Read Glob Grep WebFetch WebSearch Task Agent Skill TodoWrite mcp__browser_member__browser_evaluate mcp__browser_member__browser_run_code mcp__browser_member__browser_file_upload mcp__browser_member__browser_install mcp__browser_admin__browser_evaluate mcp__browser_admin__browser_run_code mcp__browser_admin__browser_file_upload mcp__browser_admin__browser_install mcp__browser_full_admin__browser_evaluate mcp__browser_full_admin__browser_run_code mcp__browser_full_admin__browser_file_upload mcp__browser_full_admin__browser_install"
else
  PERMISSION_FLAGS="--dangerously-skip-permissions"
fi

# Optional in-loop browser: expose the pinned Playwright MCP server so a
# BUILD turn CAN open the app it just edited in a headless browser to catch
# render/JS errors before committing (see app-conventions.md, worker-run.sh).
# `--strict-mcp-config` makes claude load ONLY this config — never a
# `.mcp.json` an untrusted repo might carry, which under
# --dangerously-skip-permissions would otherwise auto-start arbitrary
# servers. Scout (read-only) and sync (bookkeeping) get NO browser tooling:
# the flags stay empty, so their `claude` invocations are byte-for-byte as
# before. The MCP server only spawns on claude startup; Chromium launches
# lazily on the first browser tool call, so a build turn that never reaches
# for it pays nothing.
BROWSER_MCP_FLAGS=""
if [ "$MODE" = "build" ] && [ -f "$BROWSER_MCP_CONFIG" ]; then
  BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG --strict-mcp-config"
fi

# #2779: the coding agent's read-only Homeroom tools, for a build or scout
# turn the platform issued a grant to (HOMEROOM_MCP_TOKEN). The config names
# only the stdio bridge; the grant reaches it through this process's
# environment and is never written to a file. A build loads it beside the
# browser config; a scout loads it alone, so it stays browser-free. Still
# --strict-mcp-config either way.
HOMEROOM_MCP_CONFIG="${HOMEROOM_MCP_CONFIG:-/usr/local/share/usernode/homeroom-mcp.json}"
if [ -n "${HOMEROOM_MCP_TOKEN:-}" ] && [ -f "$HOMEROOM_MCP_CONFIG" ]; then
  if [ "$MODE" = "build" ] && [ -n "$BROWSER_MCP_FLAGS" ]; then
    BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG $HOMEROOM_MCP_CONFIG --strict-mcp-config"
  elif [ "$MODE" = "build" ] || [ "$MODE" = "scout" ]; then
    BROWSER_MCP_FLAGS="--mcp-config $HOMEROOM_MCP_CONFIG --strict-mcp-config"
  fi
fi

EVIDENCE_PROXY_PID=""
EVIDENCE_DIAGNOSTIC_TAIL_PID=""
EVIDENCE_TMP=""
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
  BROWSER_MCP_CONFIG="$EVIDENCE_TMP/mcp.json"
  node /usr/local/bin/write-evidence-mcp-config.js "$BROWSER_MCP_CONFIG" \
    || die "could not create evidence MCP config"
  echo "__USERNODE_PHASE__ evidence_mcp_ready"
  BROWSER_MCP_FLAGS="--mcp-config $BROWSER_MCP_CONFIG --strict-mcp-config"
fi

# ── In-loop local Postgres (build turns only) ────────────────────────
# Keep this identical to Codex/OpenRouter build turns. The helper emits
# warnings and lets the turn continue if the optional local DB is unavailable.
if [ "$MODE" = "build" ]; then
  sh "$(dirname "$0")/start-inloop-db.sh" \
    || echo "__USERNODE_WARN__ in-loop postgres setup failed"
fi

# stream-json emits one JSON object per line. The host parses this via
# the docker-exec child's stdout (long-lived path) or `docker logs -f`
# (legacy single-shot path) — same pipeline, different transport.
# The prompt is piped on stdin (`--print` reads it there) instead of an
# inline `-p` argument: a single argv string is capped at 128 KiB in this
# container too, so passing the file's contents as an argument would just
# move the host-side E2BIG failure here.
if [ -n "$CLAUDE_RESUME_SESSION_ID" ]; then
  echo "__USERNODE_PHASE__ claude (resume $CLAUDE_RESUME_SESSION_ID, mode $MODE)"
  claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose \
    --resume "$CLAUDE_RESUME_SESSION_ID" \
    --model "$MODEL" --include-partial-messages --output-format stream-json < "$PROMPT_FILE"
  CC_EXIT=$?
  if [ "$CC_EXIT" -ne 0 ]; then
    echo "__USERNODE_WARN__ resume failed (exit $CC_EXIT); retrying fresh"
    RETRY_PROMPT_FILE="$PROMPT_FILE"
    if [ -n "$RESUME_FALLBACK_PROMPT_FILE" ]; then
      RETRY_PROMPT_FILE="$RESUME_FALLBACK_PROMPT_FILE"
    fi
    claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose \
      --model "$MODEL" --include-partial-messages --output-format stream-json < "$RETRY_PROMPT_FILE"
    CC_EXIT=$?
  fi
else
  echo "__USERNODE_PHASE__ claude (mode $MODE)"
  claude --print $PERMISSION_FLAGS $BROWSER_MCP_FLAGS $SYSTEM_PROMPT_FLAGS --verbose \
    --model "$MODEL" --include-partial-messages --output-format stream-json < "$PROMPT_FILE"
  CC_EXIT=$?
fi

if [ "$MODE" = "scout" ] || [ "$MODE" = "evidence" ]; then
  # Read-only run: no commit, no push. The host pulls scout output out
  # of stream-json's `result` event and writes it into spec_md.
  # behind=0 because scout never modifies the tree; the real number
  # gets refreshed by the next build/sync turn.
  # Terminal phase marker so the progress card ends on "Finished"
  # instead of freezing on the last action line.
  echo "__USERNODE_PHASE__ done"
  echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=0 behind=0 sha= push_ok=0 mode=$MODE"
  exit "$CC_EXIT"
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
  # Belt-and-suspenders: the platform-side push proxy ignores the
  # worker's local HEAD and pushes the session's canonical branch
  # from its own DB lookup, but if HEAD has drifted we likely
  # committed onto the wrong branch, so the push would push stale
  # content. Skip and surface clearly.
  echo "__USERNODE_WARN__ HEAD branch ($HEAD_BRANCH) != session branch ($BRANCH); skipping push"
elif /usr/local/bin/usernode-push; then
  PUSH_OK=1
else
  echo "__USERNODE_WARN__ push failed"
fi

git fetch origin main --quiet 2>/dev/null || true
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
# #8: how many commits this branch is behind origin/main. Drives the
# dev-chat "Sync with main" banner and the merge-time block.
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

# Terminal phase marker: the dev-chat progress card's collapsed label is
# the LAST line of the log, so without this every build turn ends frozen
# on "[push]" ("Pushing"). The UI maps done → "Finished" and
# push_failed → "Push failed"; the platform side can append a healing
# [done] if it re-pushes the branch itself.
if [ "$PUSH_OK" = "1" ]; then
  echo "__USERNODE_PHASE__ done"
else
  echo "__USERNODE_PHASE__ push_failed"
fi
echo "__USERNODE_RESULT__ cc_exit=$CC_EXIT ahead=$AHEAD behind=$BEHIND sha=$SHA push_ok=$PUSH_OK mode=build"
exit "$CC_EXIT"
