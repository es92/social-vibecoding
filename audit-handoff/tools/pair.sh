#!/bin/bash
# pair.sh <name> <suffix> <shot.js args...>
# The same capture from the before copy (:3000, the base commit) and the after copy (:3001, your branch).
# Output: $LAB/out/<name>/before<suffix>.png and after<suffix>.png
id="$1"; suf="$2"; shift 2
root="${BUGS_DIR:-${LAB:-/tmp/lab}/out}"
mkdir -p "$root/$id"
here="$(cd "$(dirname "$0")" && pwd)"
node "$here/shot.js" --origin "${BEFORE_ORIGIN:-http://127.0.0.1:3000}" --out "$root/$id/before$suf.png" "$@" &
node "$here/shot.js" --origin "${AFTER_ORIGIN:-http://127.0.0.1:3001}" --out "$root/$id/after$suf.png" "$@" &
wait
