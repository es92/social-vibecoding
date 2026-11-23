#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run home-grid -1024 --profile laptop --route '/#home' --clip 244,60,780,640 --scale 1
run make-rail "" --profile desktop --route '/#create' --clip 0,0,760,360 --scale 2
run search-placeholder "" --profile phone --route '/#communities' --clip 0,116,393,74 --scale 3
