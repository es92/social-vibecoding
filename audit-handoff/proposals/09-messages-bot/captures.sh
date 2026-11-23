#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
J="[...document.querySelectorAll('#ai-screen [data-ai-line]')].find(e=>/style directions/.test(e.textContent))?.click()"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
for w in 1024 1440; do run invite-card -$w --profile laptop --w $w --h 800 --route '/#messages/22' --wait 2500 --clip 620,50,$((w-630)),520 --scale 1; done
node "$T/flow.js" confirm-edge   # click-through on both copies; output in $LAB/out/confirm-edge/
run bot-list-docked "" --profile desktop --route '/#ai' --js "$J" --wait 2500 --clip 244,50,460,640 --scale 2
