#!/bin/bash
# Runs this checkout's platform on a local Postgres in staging mode, for the
# thread screenshots (README.md). Every value here is a throwaway for a local
# database: none is a real secret. GIT_HOST_URL points nowhere on purpose: a
# staging copy reads real requests only when a git host is configured, and
# serves mock ones otherwise.
set -e
cd "$(dirname "$0")/../.."
export USERNODE_ENV=staging USERNODE_LOCAL_DEV=1 PORT="${PORT:-3999}" \
  DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/threads_demo}" \
  SESSION_SECRET=local-only-session-secret ADMIN_USERNAME=localadmin ADMIN_PASSWORD=local-only-admin-pass \
  RUN_MIGRATIONS_ON_STARTUP=1 USERNODE_DOMAIN=localhost LOG_LEVEL=warn GIT_HOST_URL=http://127.0.0.1:9
exec node server.js
