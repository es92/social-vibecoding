#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
node "$T/flow.js" feedback-tile   # click-through on both copies; output in $LAB/out/feedback-tile/
node "$T/flow.js" sheet-labels   # click-through on both copies; output in $LAB/out/sheet-labels/
node "$T/flow.js" rename-spaces   # click-through on both copies; output in $LAB/out/rename-spaces/
