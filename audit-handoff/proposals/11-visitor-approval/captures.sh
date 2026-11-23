#!/bin/bash
# The captures used for the report: the same shot from the before copy (:3000) and the after copy (:3001).
# Needs LAB set, both servers up and lab-signin.js run. Output: $LAB/out/<item>/. Ids in routes (a conversation,
# a request, a change) come from the lab database this was written against; check they exist in yours.
T="$(cd "$(dirname "$0")/../../tools" && pwd)"; P="$T/pair.sh"
S="(async()=>{document.querySelector('[data-guest-search-open]')?.click(); await new Promise(r=>setTimeout(r,500)); const i=document.querySelector('[data-guest-discover] input[type=search], [data-guest-discover] input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'zzzzqqq'); i.dispatchEvent(new Event('input',{bubbles:true})); i.scrollIntoView({block:'start'});})()"
OPEN="[...document.querySelectorAll('button, a')].find(b=>/^Open /.test((b.textContent||'').trim()))?.click()"
run() { echo "== $1$2"; "$P" "$@" 2>&1 | grep -v "^$" | head -3; }
run guest-logo "" --persona guest --profile small --route '/' --clip 0,0,360,110 --scale 3
run visitor-pin "" --persona guest --profile phone --route '/app/staging-demo-card-image' --js "$OPEN" --wait 2500 --clip 0,0,393,110 --scale 3
run guest-search "" --persona guest --profile phone --route '/' --js "$S" --wait 2500 --scale 2
run authorize-card "" --profile phone --route '/cli-authorize.html' --clip 0,230,393,400 --scale 2
