#!/bin/bash
# One-time local lab setup: Postgres role and database, and a generated env file.
# Usage: LAB=/path/to/lab-dir audit-handoff/tools/lab-setup.sh
set -e
: "${LAB:?set LAB to a scratch directory outside the repository}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$LAB/state" "$LAB/out" "$LAB/log"
command -v psql >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql; }
service postgresql start >/dev/null 2>&1 || true
for i in 1 2 3 4 5 6 7 8 9 10; do su postgres -c "psql -tAc 'select 1'" >/dev/null 2>&1 && break; sleep 1; done
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='usernode'\"" | grep -q 1 \
  || su postgres -c "psql -qc \"CREATE ROLE usernode LOGIN SUPERUSER PASSWORD 'localdev'\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='usernode'\"" | grep -q 1 \
  || su postgres -c "createdb -O usernode usernode"
[ -s "$LAB/env.json" ] || node "$here/lab-env.js" > "$LAB/env.json"
echo "lab ready: $LAB (database usernode on 127.0.0.1:5432)"
