#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run tablet-header -light --profile tablet --route '/app/usernode-2d5619/workshop?ws=workshop&demo=1' --js "window.scrollTo(0, 220)" --wait 3000 --clip 0,0,820,230 --scale 2
run rail-header -landscape --profile phone --w 852 --h 393 --route '/#home' --clip 0,0,520,220 --scale 2
run rail-header -tablet --profile tablet --route '/#home' --clip 0,0,520,260 --scale 2
