#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
SC="(()=>{const s=document.querySelector('#dev-forum-scroll'); const el=(s&&s.scrollHeight>s.clientHeight+50)?s:document.scrollingElement; el.scrollTop=620;})()"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run change-pill -phone --profile phone --route '/?demo=1#app/usernode-2d5619/dev/proposals/9000026' --wait 3000 --clip 0,120,393,150 --scale 3
run change-pill -360 --profile small --route '/?demo=1#app/usernode-2d5619/dev/issues/9116' --wait 3000 --clip 0,110,360,170 --scale 3
run allitems-head -desktop --profile desktop --route '/app/usernode-2d5619/workshop?ws=all&demo=1' --js "$SC" --wait 3500 --clip 244,50,1000,260 --scale 2
run allitems-head -phone --profile phone --route '/app/usernode-2d5619/workshop?ws=all&demo=1' --js "window.scrollTo(0,620); $SC" --wait 3500 --clip 0,96,393,240 --scale 3
