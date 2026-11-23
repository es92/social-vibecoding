#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
Z="const s=document.createElement('style'); s.textContent='html, body, * { -webkit-text-size-adjust: 130% !important; text-size-adjust: 130% !important; }'; document.head.appendChild(s);"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run tab-labels -320 --profile narrow --route '/#communities' --clip 0,498,320,70 --scale 3
run tab-labels -360 --profile small --route '/#communities' --clip 0,570,360,70 --scale 3
run tab-labels -393 --profile phone --route '/#communities' --clip 0,782,393,70 --scale 3
run tab-labels -zoom432 --profile phone --w 432 --h 960 --theme dark --route '/#communities' --js "$Z" --clip 0,890,432,70 --scale 3
run tab-labels -zoom393 --profile phone --route '/#ai' --js "$Z" --clip 0,782,393,70 --scale 3
run nav-badge -rail --profile desktop --route '/#ai' --clip 0,60,244,420 --scale 2
run nav-badge -tabs --profile phone --route '/#messages' --clip 0,780,393,72 --scale 3
run rail-tiles "" --profile desktop --route '/#home' --clip 0,236,244,240 --scale 2
