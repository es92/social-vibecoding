#!/bin/bash
# Run a checkout's server with the lab env. Run it in the background; it stays in the foreground.
# Usage: LAB=/path/to/lab-dir audit-handoff/tools/lab-start.sh <repo-dir> <port>
# The checkout needs node_modules and a built shell first (npm ci; (cd frontend && npm ci); npm run ensure:shell).
: "${LAB:?set LAB}"
DIR="${1:?repo dir}"; export LAB_PORT="${2:-3000}"
cd "$DIR" || exit 1
eval "$(node -e "
const env=require(process.env.LAB + '/env.json');
for (const [k,v] of Object.entries(env)) console.log('export '+k+'='+JSON.stringify(v).replace(/\\\\n/g,'\n').replace(/\\$/g,'\\\\$'));
")"
export USERNODE_ENV=staging PORT="$LAB_PORT"
exec node server.js
