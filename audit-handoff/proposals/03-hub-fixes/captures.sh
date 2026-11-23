#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
HUB='/?demo=1#app/usernode-2d5619/dev/hub'
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run hero-art -1024 --profile laptop --route "$HUB" --wait 3000 --clip 244,100,780,270 --scale 2
run hub-doors -1024 --profile laptop --route "$HUB" --wait 3000 --clip 244,480,780,288 --scale 2
run hero-title -phone --profile phone --route '/#app/staging-demo-app/dev/hub' --wait 3000 --clip 0,104,393,130 --scale 3
run pause-banner -1440 --profile desktop --route "$HUB" --wait 3000 --clip 244,50,1196,80 --scale 2
