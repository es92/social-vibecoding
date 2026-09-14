#!/usr/bin/env bash
#
# Host-side deployer for the Homeroom platform.
#
# Runs on the VPS as a systemd service (scripts/usernode-deployer.service,
# user `deploy`), polling github.com for a new head of main. When one
# appears it checks the commit out into a local clone, rsyncs the tree
# over /opt/usernode with the same exclude list the Deploy workflow
# uses, and runs scripts/deploy.sh.
#
# Two triggers, one code path:
#   - NUDGE (the fast path, seconds): after a self-app merge the
#     platform touches runtime/deploy-nudge/nudge through its one
#     writable runtime mount; the loop stats that file every
#     NUDGE_CHECK_SECONDS and polls immediately on a change.
#   - BASELINE (the safety net, ~2 min): a plain interval poll that
#     catches direct pushes to main, merges that raced a platform
#     crash, and hosts without the nudge mount.
#
# Why this exists: production deploys used to depend on a GitHub Actions
# runner picking up the push. During the 2026-08-06 GHA outage, merges
# landed on main and sat undeployed for hours with the workflow queued.
# This poller only needs github.com's *git* data plane (fetch/clone) —
# the same dependency rollback.sh already has — not Actions.
#
# Division of labor with the Deploy workflow (which stays as a fallback
# and as the only path that can rotate secrets):
#
#   - The poller never touches secrets: deploy.sh runs in patch mode
#     (no BASE_ENV_B64), keeping the .env from the last secret-bearing
#     deploy and updating GIT_SHA only. New/rotated secrets still go
#     through a workflow_dispatch of Deploy.
#   - Both paths converge on scripts/deploy.sh under one flock, and both
#     set SKIP_IF_CURRENT, so a push that both notice is deployed once.
#
# Failure handling: if a sha fails to deploy (deploy.sh health-gates and
# rolls back), the poller remembers it and retries at most every
# RETRY_FAILED_SECONDS instead of thrashing build → rollback in a tight
# loop. Any NEW head on main clears the backoff immediately.
#
# Self-update: deploy.sh installs the freshly deployed copy of this
# script over /opt/usernode-tools/usernode-deployer.sh (install(1)
# unlinks first, so the running process keeps its old inode). After each
# successful deploy the loop re-execs itself to pick the new code up.
#
# Install (one-time, as root — see SELF-HOSTING.md "Host-side deployer"):
#
#   install -d -o deploy -g deploy -m 755 /opt/usernode-tools
#   install -m 755 /opt/usernode/scripts/usernode-deployer.sh /opt/usernode-tools/
#   install -m 644 /opt/usernode/scripts/usernode-deployer.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now usernode-deployer

set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/Usernode-Labs/social-vibecoding.git}"
BRANCH="${BRANCH:-main}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/usernode}"
SRC_DIR="${SRC_DIR:-/opt/usernode-src}"
# Baseline git poll. Deliberately slow: on-platform merges (in practice,
# all of them) arrive via the nudge file within NUDGE_CHECK_SECONDS, so
# this only bounds the latency of direct pushes to main and covers the
# case where the nudge mount is missing or the platform died mid-merge.
POLL_SECONDS="${POLL_SECONDS:-120}"
# How often to stat the nudge file. A stat of a local path is
# effectively free, so this is the real reaction time to an on-platform
# self-app merge.
NUDGE_CHECK_SECONDS="${NUDGE_CHECK_SECONDS:-2}"
RETRY_FAILED_SECONDS="${RETRY_FAILED_SECONDS:-1800}"
STATE_FILE="$DEPLOY_DIR/runtime/deployer-state"
# Touched by the platform after a self-app merge (one narrow writable
# mount — see docker-compose.yml and src/services/deploy-nudge.js). The
# nudge is a hint to poll NOW; the deploy target still comes only from
# github.com, so a forged nudge buys an attacker one no-op git fetch.
NUDGE_FILE="$DEPLOY_DIR/runtime/deploy-nudge/nudge"

# File lists mirrored from the Deploy workflow's dorny/paths-filter step.
# NODE_FILTER decides whether deploy.sh refreshes the sidecar archive
# (and therefore recreates usernode-node + restarts child apps); the
# deploy logic itself now lives in scripts/deploy.sh, so that file takes
# deploy.yml's old place on the list. CADDY_FILTER gates the caddy image
# rebuild.
NODE_FILTER=(
  'docker-compose.yml'
  'scripts/deploy.sh'
  'scripts/fetch-archive-snapshot.sh'
  'scripts/package-archive-snapshot.sh'
)
CADDY_FILTER=(
  'caddy.Dockerfile'
)

log() {
  echo "[usernode-deployer] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

ensure_clone() {
  if [ ! -d "$SRC_DIR/.git" ]; then
    log "cloning $REPO_URL into $SRC_DIR"
    rm -rf "$SRC_DIR"
    git clone "$REPO_URL" "$SRC_DIR"
  fi
}

current_sha() {
  grep -m1 '^GIT_SHA=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2- || true
}

# 'true'/'false': does CURRENT..TARGET touch any path in the given list?
# Falls back to 'false' when the diff can't be computed (e.g. CURRENT
# predates the clone or history was rewritten) — the same default the
# workflow uses on workflow_dispatch, and the cheap direction: a missed
# refresh self-heals on the next node-touching deploy, while a spurious
# one restarts the sidecar + every child app for nothing.
files_changed() {
  local from="$1" to="$2"; shift 2
  local changed
  if ! changed=$(git -C "$SRC_DIR" diff --name-only "$from" "$to" -- "$@" 2>/dev/null); then
    echo false
    return
  fi
  if [ -n "$changed" ]; then echo true; else echo false; fi
}

read_state() {
  LAST_FAILED_SHA=""
  LAST_FAILED_AT=0
  if [ -f "$STATE_FILE" ]; then
    LAST_FAILED_SHA=$(sed -n '1p' "$STATE_FILE")
    LAST_FAILED_AT=$(sed -n '2p' "$STATE_FILE")
  fi
}

tick() {
  ensure_clone || return 0

  if ! git -C "$SRC_DIR" fetch -q origin "$BRANCH"; then
    log "git fetch failed; will retry"
    return 0
  fi
  local target current
  target=$(git -C "$SRC_DIR" rev-parse "origin/$BRANCH")
  current=$(current_sha)

  [ "$target" = "$current" ] && return 0

  read_state
  if [ "$target" = "$LAST_FAILED_SHA" ]; then
    local now; now=$(date +%s)
    if [ $((now - ${LAST_FAILED_AT:-0})) -lt "$RETRY_FAILED_SECONDS" ]; then
      return 0
    fi
    log "retrying previously failed sha $target after backoff"
  fi

  log "new head on $BRANCH: ${current:-'(none)'} -> $target"
  git -C "$SRC_DIR" checkout -q --detach "$target"

  local node_changed caddy_changed
  node_changed=false
  caddy_changed=false
  if [ -n "$current" ]; then
    node_changed=$(files_changed "$current" "$target" "${NODE_FILTER[@]}")
    caddy_changed=$(files_changed "$current" "$target" "${CADDY_FILTER[@]}")
  fi

  # Same exclude list as the workflow's rsync and rollback.sh: state and
  # host-side config survive; everything else mirrors the commit.
  rsync -a --delete \
    --exclude=.git \
    --exclude=.github \
    --exclude=node_modules \
    --exclude=data \
    --exclude=.env \
    --exclude=.platform-env\* \
    --exclude=runtime \
    --exclude=caddy/active \
    "$SRC_DIR/" "$DEPLOY_DIR/"

  log "running deploy.sh for $target (node_changed=$node_changed caddy_changed=$caddy_changed)"
  if DEPLOY_SHA="$target" \
     NODE_FILES_CHANGED="$node_changed" \
     CADDY_FILES_CHANGED="$caddy_changed" \
     FORCE_ARCHIVE_REFRESH=false \
     SKIP_IF_CURRENT=1 \
     bash "$DEPLOY_DIR/scripts/deploy.sh" 2>&1 | tee "$DEPLOY_DIR/runtime/deploy-last.log"; then
    log "deploy of $target succeeded"
    rm -f "$STATE_FILE"
    # Pick up any newly deployed version of this very script (deploy.sh
    # just installed it over $0).
    log "re-exec to adopt the deployed deployer version"
    exec "$0"
  else
    log "deploy of $target FAILED; backing off ${RETRY_FAILED_SECONDS}s (a new commit retries immediately)"
    printf '%s\n%s\n' "$target" "$(date +%s)" > "$STATE_FILE"
  fi
}

nudge_mtime() {
  stat -c %Y "$NUDGE_FILE" 2>/dev/null || echo 0
}

log "starting (repo=$REPO_URL branch=$BRANCH poll=${POLL_SECONDS}s nudge-check=${NUDGE_CHECK_SECONDS}s)"
LAST_SEEN_NUDGE=$(nudge_mtime)
LAST_FULL_POLL=0
while true; do
  now=$(date +%s)
  nudge=$(nudge_mtime)
  if [ "$nudge" != "$LAST_SEEN_NUDGE" ]; then
    # Consume the nudge BEFORE ticking: a second merge landing while
    # this deploy runs moves the mtime again and triggers another tick.
    LAST_SEEN_NUDGE="$nudge"
    log "nudged by the platform (self-app merge); polling now"
    LAST_FULL_POLL=$now
    tick || log "tick failed: $?"
  elif [ $((now - LAST_FULL_POLL)) -ge "$POLL_SECONDS" ]; then
    LAST_FULL_POLL=$now
    tick || log "tick failed: $?"
  fi
  sleep "$NUDGE_CHECK_SECONDS"
done
