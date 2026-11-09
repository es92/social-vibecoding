'use strict';

// Comment mode (#4289 and its follow-ups): C, or "Suggest an improvement"
// when it was used last, turns on a layer where every click leaves a
// comment, each posted as its own request with a screenshot of the page and
// its pin beside it as data (#4482). frontend/src/features/comment-pin/; the
// key and the remembered way in are tests/suggest-shortcut.test.js.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE LAYOUT. The box and an open marker's card sit beside their pins by
//      one rule, inside the viewport.
//   2. POSTING. The dialog's requests: every picture, then the request naming
//      them, with the box's title, Kudos and the page's pin; a refusal with a
//      reason stays in the box; offline, a network failure or a server error
//      hands the comment to the dialog, words, title, pictures, pin, Kudos
//      and destination.
//   2b. THE PIN AS DATA. The server writes the pin onto its picture's link by
//      the same rule the request's page reads it back with.
//   3. THE APP'S PICTURE. The bridge draws the app only for the platform's
//      own origin (platform.json, https only), answers that origin alone,
//      draws what is on screen at its scroll position, and puts the app's
//      own `window.snapdom` back.
//   3b. THE PANEL'S PICTURE (#4975). The side panel's document draws itself,
//      and takeBase lays its picture in at the frame's rectangle, beside the
//      app's. Every leg of takeBase is bounded: the panel gets three seconds
//      and the shell fifteen, so a slow panel draws nothing instead of
//      holding the mode on "Taking a screenshot…" with clicks doing nothing.
//   4. THE SEAMS. The dialog takes a handed-over comment; the drawing
//      library is the pinned, recorded copy, byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const picture = loadTsx('frontend/src/features/comment-pin/picture.ts');
// The posting suites below exercise the Kudos as it works when kudos is not
// parked, so they load post.ts with the switch off; `parkedPost` is the real
// module, with kudos parked (#5249).
const post = loadTsx('frontend/src/features/comment-pin/post.ts', {
  stubs: { '../leaderboard/kudos-parked': { KUDOS_PARKED: false } },
});
const parkedPost = loadTsx('frontend/src/features/comment-pin/post.ts');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const SNAPSHOT = BRIDGE.split('/* __USERNODE_SNAPSHOT_BEGIN__ */')[1].split('/* __USERNODE_SNAPSHOT_END__ */')[0];

// ── 1. The layout ─────────────────────────────────────────────────────

test('the box sits right of the pin and below it, flipping at the edges and staying inside', () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 300, height: 160 };
  assert.deepEqual(picture.placeBeside({ x: 100, y: 100 }, size, vp), { x: 114, y: 114 });
  assert.deepEqual(picture.placeBeside({ x: 900, y: 100 }, size, vp), { x: 586, y: 114 }, 'flips left at the right edge');
  assert.deepEqual(picture.placeBeside({ x: 100, y: 650 }, size, vp), { x: 114, y: 476 }, 'flips up at the bottom');
  const tiny = picture.placeBeside({ x: 150, y: 80 }, size, { width: 320, height: 200 });
  assert.ok(tiny.x >= 8 && tiny.x + 300 <= 312 && tiny.y >= 8 && tiny.y + 160 <= 192, 'clamped when neither side fits');
});

test('the picture is the screen\'s own pixels, up to 2x, and never past 3000 on its long side', () => {
  assert.equal(picture.pictureScale(1, { width: 1280, height: 800 }), 1);
  assert.equal(picture.pictureScale(2, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(3, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(2, { width: 2560, height: 1440 }), 3000 / 2560);
  assert.equal(picture.pictureScale(undefined, { width: 800, height: 600 }), 1);
  assert.equal(picture.inRect({ x: 10, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), true);
  assert.equal(picture.inRect({ x: 20, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), false, 'the far edge is outside');
  assert.equal(picture.inRect({ x: 1, y: 1 }, null), false);
});

// ── 1b. The inset view (#4554) ─────────────────────────────────────────

test('the inset picture keeps its margin, keeps the screen\'s shape, and maps points both ways', () => {
  const desktop = picture.insetFrame({ width: 1280, height: 800 }, 24);
  assert.ok(Math.abs(desktop.scale - 0.94) < 1e-9, 'the height binds on a wide screen');
  assert.ok(Math.abs(desktop.x - 38.4) < 1e-9 && Math.abs(desktop.y - 24) < 1e-9, 'centred');
  const phone = picture.insetFrame({ width: 390, height: 844 }, 12);
  assert.ok(Math.abs(phone.scale - 366 / 390) < 1e-9, 'the narrow side binds on a phone');
  assert.ok(Math.abs(phone.x - 12) < 1e-9 && phone.y >= 12, 'at least the margin on every side');
  // Points round-trip, and the page's own corner sits at the frame's corner.
  const p = { x: 300, y: 200 };
  const back = picture.toPage(picture.toScreen(p, desktop), desktop);
  assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
  const corner = picture.toScreen({ x: 0, y: 0 }, desktop);
  assert.ok(Math.abs(corner.x - desktop.x) < 1e-9 && Math.abs(corner.y - desktop.y) < 1e-9);
  // A degenerate viewport still yields a frame, never a divide by zero.
  assert.equal(picture.insetFrame({ width: 0, height: 0 }, 24).scale, 0);
  // A zero scale reads as one on the way back, so a point survives it.
  assert.deepEqual(picture.toPage({ x: 5, y: 5 }, { x: 0, y: 0, scale: 0 }), { x: 5, y: 5 });
  // A band kept clear above (the view's header) insets the picture further,
  // and the bottom margin is still kept exactly.
  const headed = picture.insetFrame({ width: 1280, height: 800 }, 24, 60);
  assert.ok(Math.abs(headed.scale - (800 - 48 - 60) / 800) < 1e-9, 'the band is room the picture does not take');
  assert.ok(headed.y >= 60, 'the picture starts below the header band');
  assert.ok(Math.abs(headed.y + 800 * headed.scale - (800 - 24)) < 1e-9, 'the bottom margin is kept');
});

test('the close-up opens on the pin at zoom 2, and holds its zoom and pan to the picture', () => {
  const box = { width: 360, height: 150 };
  const shot = { width: 800, height: 600 };
  // The pin at the picture's middle opens centred on it.
  const centred = picture.closeUpView({ pin: { x: 400, y: 300 }, box, picture: shot, zoom: 2, pan: { x: 0, y: 0 } });
  assert.equal(centred.zoom, 2);
  assert.deepEqual(centred.size, { width: 720, height: 540 });
  assert.deepEqual(centred.offset, { x: -180, y: -195 });
  // Zoom is held to 1..4 whatever comes in.
  assert.equal(picture.closeUpView({ pin: { x: 0, y: 0 }, box, picture: shot, zoom: 9, pan: { x: 0, y: 0 } }).zoom, 4);
  assert.equal(picture.closeUpView({ pin: { x: 0, y: 0 }, box, picture: shot, zoom: 0, pan: { x: 0, y: 0 } }).zoom, 1);
  // A pin near an edge, or a pan past it, is held to the picture's edge, and
  // the pan that comes back is the one actually drawn, so the caller's state
  // never runs away from the picture.
  const edge = picture.closeUpView({ pin: { x: 10, y: 10 }, box, picture: shot, zoom: 2, pan: { x: 0, y: 0 } });
  assert.deepEqual(edge.offset, { x: 0, y: 0 });
  assert.deepEqual(edge.pan, { x: -171, y: -66 });
  const panned = picture.closeUpView({ pin: { x: 400, y: 300 }, box, picture: shot, zoom: 2, pan: { x: 500, y: 0 } });
  assert.deepEqual(panned.offset, { x: 0, y: -195 });
  assert.deepEqual(panned.pan, { x: -320, y: 0 });
});

test('the reworked mode: the bar as the view\'s header, the phone sheet, and the close-up', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The bar is the view's header, not a floating bar: the picture leaves a
  // band at the top for it and takes the picture's own width, so nothing
  // rides on the page. The old rest-on-the-picture's-bottom-edge default is
  // gone with it.
  assert.match(src, /const HEADER_BAND = 60;/);
  assert.match(src, /INSET_MARGIN, band\)/);
  assert.doesNotMatch(src, /inset\.y \+ window\.innerHeight \* inset\.scale - barSize\.height/);
  // The handle that drags the bar belongs to the live-page fallback alone.
  assert.equal(message('devchat:commentPin.bar.move'), 'Move the bar: drag it anywhere, double-click to put it back');
  assert.match(src, /\{!inset \? \(\s*<button\s+type="button"\s+aria-label=\{t\('devchat:commentPin\.bar\.move'\)\}/);
  // Taking a new picture says so in the bar, and taps wait while it draws.
  assert.match(src, /viewShot\?\.state === 'drawing' \? t\('devchat:commentPin\.hint\.taking'\)/);
  assert.equal(message('devchat:commentPin.hint.taking'), 'Taking a screenshot…');
  assert.match(src, /if \(viewShot\?\.state === 'drawing'\) return;/);
  // On a phone the box is a bottom sheet, riding the keyboard, and while the
  // wait for the next pin is on it holds just that row.
  assert.match(src, /comment-sheet-in platform-kb-sheet/);
  assert.match(src, /useKeyboardSurface\(boxRef, \{ ride: true \}\);/);
  assert.match(src, /phone && draft\.active == null \?/);
  assert.match(src, /nextPinRow\n          \) : \(/);
  // The close-up at the top of the sheet draws the pin's area of the picture
  // the pin is on: the comment's own once drawn — the full picture now, with
  // the crop framed on it (#5020) — the view picture while it still shows
  // the same view, and nothing (never a stretched thumbnail) otherwise.
  assert.match(src, /<CloseUp\s+view=\{closeUpSrc\}/);
  assert.match(src, /const closeUpSrc = activePicture\?\.url \|\| \(viewDiffers \? '' : viewShot\?\.url \|\| ''\);/);
  assert.match(src, /crop=\{activePicture\?\.cut\?\.rect \?\? null\}/,
    'the close-up frames the crop on the full picture');
  assert.doesNotMatch(src, /pin=\{\(boxComment \? pinInCrop/,
    'the pin is a full-picture fraction now, never mapped into the crop');
  const closeUp = read('frontend/src/features/comment-pin/close-up.tsx');
  assert.match(closeUp, /touchAction: 'none'/, 'the close-up box only, never the page under it');
  assert.match(closeUp, /\{t\('devchat:commentPin\.closeUp\.pinchHint'\)\}/);
  assert.equal(message('devchat:commentPin.closeUp.pinchHint'), 'Pinch to zoom');
  assert.match(closeUp, /Math\.min\(MAX_ZOOM, zPrev \* dist \/ g\.dist\)/, 'the pinch sets the zoom from the fingers');
  assert.match(closeUp, /mid\.x - c\.x - \(g\.mid\.x - c\.x - panRef\.current\.x\) \* \(z \/ zPrev\)/,
    'the point under the fingers stays under them as the zoom changes');
});

test('the pins can land in a change\'s staging preview, not only the running app', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The frame looked up first is the staging preview's: it sits over the app
  // when both are up, so a pin inside it is a pin in the preview.
  assert.match(src, /\['staging-iframe'[\s\S]{0,120}'app-iframe'/,
    'the staging frame is looked up before the app frame');
  assert.match(src, /_stagingPreview/, 'the previewed change comes from AppView._stagingPreview');
});

test('on a phone the bar sits under the status bar, where a finger can reach it', () => {
  // iPhone 17 simulator, the Homeroom app, 12 Oct 2026: the bar sat in the
  // status bar's strip, under the clock and the Dynamic Island, and a tap
  // there never reaches the page, so Done, Form and the confirm's Discard
  // could not be pressed. The band starts at the top safe area, read off a
  // probe sized by the shell's own --platform-safe-top.
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /style=\{\{ height: 'var\(--platform-safe-top, 0px\)' \}\}/);
  assert.match(src, /const band = safeTop \+ HEADER_BAND;/);
  assert.match(src, /insetFrame\(size, phone \? INSET_MARGIN_PHONE : INSET_MARGIN, band\)/);
  assert.match(src, /top: safeTop \+ Math\.max\(6, Math\.round\(\(HEADER_BAND - barSize\.height\) \/ 2\)\),/);
  assert.match(src, /style=\{inset \? \{ top: band \+ 8 \} : \{ bottom: 'calc\(76px \+ var\(--platform-safe-bottom, 0px\)\)' \}\}/, 'the first-use note too');
  assert.match(src, /return inset \? \{ x: at\.x, y: Math\.max\(at\.y, band \+ 8\) \} : at;/, 'and the box and the card');
  assert.match(src, /: \{ bottom: 'calc\(1rem \+ var\(--platform-safe-bottom, 0px\)\)' \}\}/, 'the live-page bar clears the home indicator');
  assert.doesNotMatch(src, /top-\[68px\]|'bottom-4 left-1\/2/);
});

test('on a phone the keyboard is not the page moving, and the sheet stays under the bar', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The page's size is the mode's own: the keys collapse innerHeight (874
  // to 539 on an iPhone 17), and nothing in the mode reads the window's.
  assert.match(src, /const \[size, setSize\] = useState<Size>\(windowSize\);/);
  assert.equal(src.split('window.innerHeight').length - 1, 1, 'read once, in windowSize');
  assert.match(src, /if \(next\.width === was\.width && keyboardAbout\(\)\) return;/, 'a height-only resize with the keys about is the keys');
  assert.match(src, /vv\?\.addEventListener\('resize', onResize\);/, 'and the keys leaving re-measures');
  // Scrolls that are not the page: the mode's own sheet and field, and a
  // document pan while the keys are about.
  assert.match(src, /if \(target instanceof Node && host\.contains\(target\)\) return;/);
  assert.match(src, /if \(isDocumentScroll\(target\) && keyboardAbout\(\)\) return;/);
  assert.match(src, /const keyboardAbout = \(\) => textFocused\(document\)\s*\|\| document\.documentElement\.classList\.contains\(KB_OPEN_CLASS\)\s*\|\| performance\.now\(\) < keyboardUntil\.current;/);
  // The page holds still while the mode is up (#5045): the wheel is stopped
  // at the layer by hand (React's onWheel is passive), and a drag never
  // scrolls.
  assert.doesNotMatch(src, /scrollBy\(/);
  assert.doesNotMatch(src, /scrollerAt/);
  assert.doesNotMatch(src, /onWheel=\{/);
  assert.match(src, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.match(src, /const onWheel = \(e: WheelEvent\) => \{ e\.preventDefault\(\); \};/);
  // Fields take the keyboard without iOS panning the page (and the bar) away.
  assert.match(src, /t\.focus\(\{ preventScroll: true \}\);\s*t\.setSelectionRange/);
  assert.doesNotMatch(src, /\.focus\(\)/, 'no focus that pans');
  assert.doesNotMatch(src, /^\s+autoFocus$/m, 'autoFocus pans too');
  assert.match(src, /ref=\{focusWithoutPan\}/);
  // The sheet: capped below the band, on the keys with them up, Post at its foot.
  assert.match(src, /'--comment-band' as string\]: `\$\{inset \? band : safeTop\}px`/);
  assert.match(src, /`comment-sheet comment-sheet-in platform-kb-sheet absolute inset-x-0 bottom-0 flex flex-col/);
  assert.match(src, /\$\{phone \? ' comment-sheet-actions' : ''\}/);
  const css = read('public/css/app.css');
  assert.match(css, /#comment-pin-box\.comment-sheet \{\s*--comment-sheet-pb: calc\(0\.75rem \+ var\(--platform-safe-bottom, 0px\)\);\s*max-height: min\(85%, calc\(100% - var\(--comment-band, 0px\) - 8px\)\);/);
  assert.match(css, /html\.platform-kb-open #comment-pin-box\.comment-sheet \{[^}]*max-height: calc\(100% - var\(--comment-band, 0px\) - 8px - var\(--platform-vv-top, 0px\) - var\(--platform-kb-cover, 0px\)\);/);
  assert.match(css, /#comment-pin-box\.comment-sheet \.comment-sheet-actions \{\s*position: sticky;\s*bottom: calc\(-1 \* var\(--comment-sheet-pb\)\);/);
});

test('the picture stays still while the comment box has the keyboard (#6448)', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // While the person is typing, a chat that scrolls a reply in must not
  // rewrite the picture under their words. The retake is skipped, and the
  // move is remembered.
  assert.match(src, /const shotPending = useRef\(false\);/);
  assert.match(src, /if \(textFocused\(document\)\) \{ shotPending\.current = true; return; \}\s*const timer = setTimeout\(\(\) => \{/,
    'the tick effect skips the retake while a text field has the keyboard');
  // And again when the timer fires: focusing the box during the 250ms wait
  // freezes the picture too.
  assert.match(src, /const timer = setTimeout\(\(\) => \{\s*if \(textFocused\(document\)\) \{ shotPending\.current = true; return; \}\s*takeViewShot\(\);\s*\}, 250\);/);
  // Leaving the box catches up, once, and only when the page moved while it
  // was frozen. `activeElement` has not moved when focusout fires, so the
  // check waits a frame.
  assert.match(src, /host\.addEventListener\('focusout', onFocusOut\);/);
  assert.match(src, /frame = requestAnimationFrame\(\(\) => \{\s*frame = 0;\s*if \(!shotPending\.current \|\| textFocused\(document\)\) return;\s*shotPending\.current = false;\s*takeViewShot\(\);\s*\}\);/);
  assert.match(src, /host\.removeEventListener\('focusout', onFocusOut\);\s*if \(frame\) cancelAnimationFrame\(frame\);/,
    'the listener and its frame go with the mode');
  // The first picture is still taken as it always was: only the redraws after it freeze.
  assert.match(src, /const ahead = takeAhead\(sizeRef\.current\);\s*void Promise\.all\(\[ahead, overlaysGone\(\)\]\)\.then\(\(\[got\]\) => \{\s*if \(!live\) return;\s*if \(!got\) \{ takeViewShot\(\); return; \}/);
});

test('on a phone a tap leaves a small comment, and only its field opens the sheet', () => {
  // Evan, 14 Oct 2026: a tap opened the whole sheet with the keyboard over
  // the page he was still looking at, the sheet's ✕ was hard to find and to
  // hit, and its arrows ("Open in the form") read as "make this bigger" and
  // left comment mode. Now a tap leaves the pin and a small box beside it,
  // with no field and so no keyboard; a tap on the box opens the sheet with
  // the keys, in the same gesture; the pin and the box drag; ✕ closes it.
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const small = phone && !expanded && !!draft && draft\.active != null;/);
  assert.match(src, /\{draft && target && smallComment \? \(/);
  assert.match(src, /id="comment-pin-small"/);
  // No keyboard until the sheet: on a phone the focus effect waits for it.
  assert.match(src, /const writing = !phone \|\| expanded;/);
  assert.match(src, /if \(!t \|\| !writing\) return;/);
  // The field opens the sheet inside the tap: drawn first (flushSync), then
  // focused, or iOS would not raise the keys.
  assert.match(src, /flushSync\(\(\) => setExpanded\(true\)\);\s*const field = textRef\.current;\s*if \(!field\) return;\s*field\.focus\(\{ preventScroll: true \}\);/);
  assert.match(src, /onClick=\{expand\}/);
  // A new comment, the request's first or its next, starts small.
  assert.equal((src.match(/setExpanded\(false\);\n\s+setDraft\(\{/g) || []).length, 2);
  // A drag on the box or on the open pin moves the pin; a lift without one is a tap.
  assert.match(src, /if \(Math\.hypot\(dx, dy\) <= 8\) return;/);
  assert.match(src, /place\(onPicture\(\{ x: d\.from\.x \+ e\.clientX - d\.start\.x, y: d\.from\.y \+ e\.clientY - d\.start\.y \}\)\);/);
  assert.match(src, /performance\.now\(\) - draggedAt\.current < 400/, 'the click a drag ends with is not a tap');
  assert.match(src, /const handle = on && small;/);
  assert.match(src, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}\s*onClick=\{closeSmall\}/, 'its ✕ never starts a drag');
  // With the sheet open, a press on the page above it folds it; the pin stays.
  assert.match(src, /if \(phone && expanded && draft && draft\.active != null\) \{\s*if \(!draft\.sending\) setExpanded\(false\);\s*return;\s*\}/);
  // The sheet's head: Minimize folds it, ✕ is a disc in a 44px target, and
  // on a phone nothing in it hands over to the form (the bar's Form does).
  assert.match(src, /const PHONE_TOOL = 'grid h-11 w-11 /);
  assert.match(src, /onClick=\{collapse\}\s*className=\{PHONE_TOOL\}/);
  assert.match(src, /onClick=\{requestDiscard\}\s*className=\{PHONE_TOOL\}/);
  const head = src.slice(src.indexOf('const head = draft && target ? ('), src.indexOf('const small = phone'));
  const phoneHead = head.slice(head.indexOf('{phone ? ('), head.indexOf(') : (\n        <>'));
  assert.ok(phoneHead.includes('ChevronDownIcon'), 'the phone head is found');
  assert.doesNotMatch(phoneHead, /toForm/);
  assert.match(src, /<div className="comment-sheet-head">\s*<div aria-hidden="true" className="comment-sheet-grabber" \/>/);
  const css = read('public/css/app.css');
  assert.match(css, /#comment-pin-box\.comment-sheet \.comment-sheet-head \{\s*position: sticky;\s*top: -0\.75rem;/,
    'the head stays at the top while the sheet scrolls under it');
  assert.match(css, /\.comment-small-in \{ animation: comment-small-in 160ms ease-out; \}/);
  assert.equal(message('devchat:commentPin.box.minimize'), 'Minimize');
  assert.equal(message('devchat:commentPin.box.write'), 'Write your comment');
  // The box keeps above the home indicator.
  assert.match(src, /style=\{\{ height: 'var\(--platform-safe-bottom, 0px\)' \}\}/);
  assert.match(src, /size\.height - \(inset \|\| barAt \? 0 : BAR_SPACE\) - safeBottom/);
});

test('the preview draws only the pins that fall inside it', () => {
  // Two pins far apart on a phone's tall picture do not both fit the
  // preview's 64x42 slice, and the one outside was drawn over the Title and
  // Kudos rows (iPhone 17 Pro simulator, 14 Oct 2026).
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /\.filter\(\(\{ left, top \}\) => left >= 0 && left <= 64 && top >= 0 && top <= 42\)/);
});

test('the close-up always zooms a full picture about its own pin', () => {
  const closeUp = read('frontend/src/features/comment-pin/close-up.tsx');
  // The stretched-thumbnail fallback, and its pin placed as a fraction of
  // the box, are gone.
  assert.doesNotMatch(closeUp, /\bown\?: |\{own \?/);
  assert.doesNotMatch(closeUp, /object-cover/);
  assert.match(closeUp, /export function CloseUp\(\{ view, pin, crop \}: \{ view: string; pin: Point; crop\?: Rect \| null \}\)/);
  // A cut picture is shown whole: the kept part is framed where the zoom
  // draws the picture, and the rest is dimmed (#5020).
  assert.match(closeUp, /view2\.offset\.x \+ crop\.x \* view2\.size\.width/);
  assert.match(closeUp, /view2\.offset\.y \+ crop\.y \* view2\.size\.height/);
  assert.match(closeUp, /boxShadow: CROP_SHADE/);
  // A picture already in memory can load before an effect runs: its size is
  // kept with its own source rather than reset by one.
  assert.match(closeUp, /const picture = loaded && loaded\.src === view \? loaded\.size : null;/);
  assert.match(closeUp, /key=\{view\}/);
  assert.doesNotMatch(closeUp, /setPicture\(null\)/);
  assert.match(closeUp, /\{view \? \(\s*<img/, 'never an empty src');
  // The comment's own picture is kept whole for it.
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /b\?\.canvas\.toBlob\(\(blob\) => \{[\s\S]*?land\(\{ url \}\);/);
  // CropFrame and the reopened views (#5020) dim with the one shared shade.
  assert.match(src, /height: rect\.height \* H, boxShadow: CROP_SHADE/,
    'CropFrame dims with the shared shade, not its own literal');
  assert.equal(picture.CROP_SHADE, '0 0 0 9999px rgba(0,0,0,0.45)');
});

test('the first picture animates out of the live page instead of a bare grey ground (#4665)', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The first picture, nothing drawn yet: the live page shows through (the
  // mode's layer above it already keeps every press off) and neither the
  // grey ground nor the word that names the picture is drawn.
  assert.match(src, /viewShot\?\.state === 'drawing' && !viewShot\.url/,
    'the first picture: still drawing, with nothing to show');
  assert.match(src, /shotIntro \? null : \(/);
  // Once the picture lands it mounts with its ground and its word for the first
  // time and shrinks from the full page into its frame; a degenerate scale
  // skips the move.
  assert.match(src, /inset\.scale > 0 \? 'comment-shot-in' : ''/);
  assert.match(src, /comment-shot-ground-in/);
  assert.match(src, /comment-shot-label-in/);
  assert.match(src, /--comment-shot-from/, 'the start of the move: the inverse of the inset frame');
  // The hover outline and the posted pins wait with it: both are placed
  // against the inset frame and would sit wrong over the full-size page.
  assert.match(src, /hover && !shotIntro \? \(/);
  assert.match(src, /!shotIntro && postedPins\.map/);
  // app.css carries the three mount animations and settles at once under
  // reduced motion.
  const css = read('public/css/app.css');
  assert.match(css, /\.comment-shot-in \{ animation: comment-shot-in 320ms ease-out; transform-origin: 0 0; \}/);
  assert.match(css, /\.comment-shot-ground-in \{ animation: comment-shot-ground-in 320ms ease-out; \}/);
  assert.match(css, /\.comment-shot-label-in \{ animation: comment-shot-label-in 160ms ease-out 200ms both; \}/);
  assert.match(css, /@keyframes comment-shot-in \{\s*from \{ transform: var\(--comment-shot-from, none\); border-radius: 0; \}\s*\}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.comment-shot-in,\s*\.comment-shot-ground-in,\s*\.comment-shot-label-in,\s*\.comment-bar-in \{ animation: none; \}\s*\}/);
});

test('opening and leaving are one motion each, never a frame-long jump (12 Oct 2026)', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  const css = read('public/css/app.css');
  // The first picture waits for the sheet the mode was opened from (the menu,
  // the form) to finish leaving, rather than landing on it mid-slide.
  assert.match(src, /void Promise\.all\(\[ahead, overlaysGone\(\)\]\)/, 'with or without a picture drawn ahead');
  // Nothing of the mode is drawn over the live page before the first picture:
  // the state starts as drawing, and the bar and the first-use note wait.
  assert.match(src, /useState<ViewShot \| null>\(\{ url: '', view: 0, state: 'drawing' \}\)/);
  assert.match(src, /shotIntro \? 'pointer-events-none opacity-0' : 'comment-bar-in',/);
  assert.match(src, /\{intro && !confirm && !shotIntro \? \(/);
  assert.match(css, /\.comment-bar-in \{ animation: comment-shot-ground-in 320ms ease-out; \}/);
  // The picture is decoded before it goes up, or its first frame is a white box.
  assert.match(src, /decoded\.src = url;[\s\S]*?decoded\.decode\(\) : Promise\.resolve\(\)\)\.then\(show, show\);/);
  // Leaving plays the entrance backwards, then closes and opens what follows.
  assert.match(src, /const LEAVE_MS = 200;/);
  assert.match(src, /if \(!inset \|\| shotIntro \|\| !viewShot\?\.url \|\| reducedMotion\(\)\) \{ finish\(\); return; \}/);
  assert.match(src, /setLeaving\(true\);\s*setTimeout\(finish, LEAVE_MS\);/);
  assert.match(src, /className=\{leaving \? 'comment-mode-leaving fixed inset-0' : 'fixed inset-0'\}/);
  assert.match(src, /leave\(\(\) => \{\s*if \(post\) \{\s*handOver\(post\);/, 'Form opens after the mode has left');
  assert.match(src, /leave\(\(\) => handOver\(post\)\);/, 'and a failed post hands over the same way');
  assert.match(src, /else leave\(\); \}\}/, 'the confirm\'s Discard on Done');
  assert.equal((src.match(/\bonClose\(\)/g) || []).length, 3, 'onClose only inside leave and on the cards\' links, which navigate (the sent card\'s link joins the marker card\'s, #5008)');
  assert.match(css, /\.comment-mode-leaving \.comment-shot-in \{ animation: comment-shot-out 200ms ease-in forwards; \}/);
  assert.match(css, /@keyframes comment-shot-out \{\s*to \{ transform: var\(--comment-shot-from, none\); border-radius: 0; \}\s*\}/);
  assert.match(css, /\.comment-mode-leaving > :not\(\.comment-shot-in\):not\(\.comment-shot-ground-in\) \{ animation: comment-fade-out 120ms ease-in forwards; \}/);
});

test('the picture is drawn ahead while the menu or the form is open, and opens at once (12 Oct 2026)', () => {
  // Tap to zoom used to wait for the code, the library and the whole drawing
  // after the menu had gone: 0.3s of a still screen, 1.3s on the first open
  // after launch. The menu and the form now ask for the picture as they open.
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  const shortcut = read('frontend/src/features/improve/suggest-shortcut.ts');
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const form = read('frontend/src/features/dialogs/feedback.tsx');
  // And never on a ?shot= / ?demo= page: those render one state for a check
  // or a still, and drawing the page there held the ?shot=app-context check
  // in network idle until it timed out.
  assert.match(shortcut, /export function prepareComment\(\): void \{\s*if \(!suggestOpensComment\(\) \|\| onCaptureRoute\(\)\) return;\s*import\('\.\.\/comment-pin\/comment-pin'\)\s*\.then\(\(m\) => m\.prepareCommentView\(\)\)/,
    'only where the switch is on and this is not a capture route, and the mode\'s code loads with it');
  assert.match(menu, /useEffect\(\(\) => \{\s*if \(open\) prepareComment\(\);\s*\}, \[open\]\);/);
  assert.match(form, /Feedback\._open\(opts \|\| \{\}\);[\s\S]*?prepareComment\(\);\s*\},/);
  // Drawn once the sheet has slid in, watched from the moment it starts, and
  // put up the moment the sheet has gone; otherwise drawn fresh, as before.
  assert.match(src, /const AHEAD_SETTLE_MS = 350;/);
  assert.match(src, /const AHEAD_TTL_MS = 20000;/);
  assert.match(src, /watching = true;\s*observer\.observe\(document\.body, \{ subtree: true, childList: true, characterData: true, characterDataOldValue: true \}\);/);
  assert.match(src, /const ahead = takeAhead\(sizeRef\.current\);\s*void Promise\.all\(\[ahead, overlaysGone\(\)\]\)\.then\(\(\[got\]\) => \{\s*if \(!live\) return;\s*if \(!got\) \{ takeViewShot\(\); return; \}/);
  assert.match(src, /if \(!stillFresh\(a\) \|\| a\.size\.width !== size\.width\) \{/);
  // A scroll of the page or a new width spoils it too.
  assert.match(src, /const onScroll = \(e: Event\) => \{ if \(!outOfPicture\(e\.target instanceof Node \? e\.target : null\)\) spoil\(\); \};/);
  assert.match(src, /const onResize = \(\) => \{ if \(window\.innerWidth !== size\.width\) spoil\(\); \};/);
  // The menu's dim is cut out of every picture, or one drawn under the menu would be dimmed.
  assert.ok(picture.PAGE_EXCLUDES.includes('.overlay-scrim'));
  // The hub's ⋯ menu has the same issue row, in a dropdown the picture draws
  // over, so it gets the picture ready while it is open too, and only when
  // that row is there (a read-only viewer has none).
  const plusMenu = read('public/js/app-view.js');
  assert.match(plusMenu, /const issueRow = menu\.querySelector\('\[data-plus="issue"\]'\);\s*btn\.addEventListener\('click', \(e\) => \{/,
    'the issue row is read before the menu\'s handlers');
  assert.match(plusMenu, /if \(PlatformUI\.isTouch\(\)\) \{\s*AppView\.refreshDevChatSecretsState\(\);[\s\S]{0,800}?if \(issueRow\) window\.UsernodeReact\?\.suggestShortcut\?\.prepare\?\.\(\);/,
    'the touch sheet gets the picture ready while it is open');
  assert.match(plusMenu, /if \(open\) AppView\.refreshDevChatSecretsState\(\);[\s\S]{0,400}?if \(open && issueRow\) window\.UsernodeReact\?\.suggestShortcut\?\.prepare\?\.\(\);/,
    'and so does the desktop dropdown');
  // And the dropdown, which is inside the drawn page, is cut out of it.
  assert.ok(picture.PAGE_EXCLUDES.includes('#dev-plus-menu'), 'the hub\'s ⋯ dropdown');
});

test('what counts as the page changing since the picture was drawn', () => {
  const realDoc = global.document;
  const el = ({ parent = null, overlay = false, internal = false, rects = 1, holdsOverlay = false, text = '' } = {}) => ({
    nodeType: 1, parentElement: parent, isConnected: true, textContent: text,
    closest: (sel) => ((overlay && /#apps-switcher-sheet/.test(sel)) || (internal && /data-snapdom-internal/.test(sel)) ? {} : null),
    matches: (sel) => (overlay && /#apps-switcher-sheet/.test(sel)) || (internal && /data-snapdom-internal/.test(sel)),
    querySelector: () => (holdsOverlay ? {} : null),
    getClientRects: () => ({ length: rects }),
  });
  const text = (parent, value) => ({ nodeType: 3, parentElement: parent, isConnected: true, textContent: value });
  const rec = (type, target, added = [], removed = []) => ({ type, target, addedNodes: added, removedNodes: removed });
  try {
    const page = el();
    const heading = el({ parent: page });
    // A visible change of nodes on the page counts.
    assert.equal(picture.changesPicture(rec('childList', heading, [text(heading, 'New')], [text(heading, 'Old')])), true);
    // Inside an overlay, inside the drawing library's own nodes, or on a
    // node that is not laid out: it does not.
    assert.equal(picture.changesPicture(rec('childList', el({ overlay: true }), [el()])), false);
    assert.equal(picture.changesPicture(rec('childList', el({ internal: true }), [el()])), false);
    assert.equal(picture.changesPicture(rec('childList', el({ rects: 0 }), [el()])), false);
    // The kit lifting the menu sheet out of the page and putting it back,
    // and the library adding its sandbox to the body: not a change.
    assert.equal(picture.changesPicture(rec('childList', page, [], [el({ overlay: true })])), false);
    assert.equal(picture.changesPicture(rec('childList', page, [el({ holdsOverlay: true }), { nodeType: 8 }, text(page, '  ')])), false);
    assert.equal(picture.changesPicture(rec('childList', page, [el({ internal: true })])), false);
    assert.equal(picture.changesPicture(rec('childList', page, [el({ overlay: true }), el()])), true, 'one real node among them counts');
    // Text: judged by the first value against what it says now.
    const a = text(heading, 'Plant Pal');
    const b = text(heading, 'Changed');
    assert.equal(picture.textsUnchanged(new Map([[a, 'Plant Pal']])), true, 'written away and back');
    assert.equal(picture.textsUnchanged(new Map([[b, 'Before']])), false);
    assert.equal(picture.textsUnchanged(new Map([[{ ...b, isConnected: false }, 'Before']])), true, 'a node that has gone is a childList change, judged there');
  } finally {
    global.document = realDoc;
  }
});

test('overlayOnScreen: a leaving sheet counts, the always-mounted dim and a hidden menu do not', () => {
  const el = (style, rects = 1) => ({ style, getClientRects: () => ({ length: rects }) });
  const doc = (els) => ({ querySelectorAll: (sel) => { assert.equal(sel, picture.PAGE_EXCLUDES.join(',')); return els; } });
  const styleOf = (e) => e.style;
  assert.equal(picture.overlayOnScreen(doc([]), styleOf), false);
  assert.equal(picture.overlayOnScreen(doc([el({ visibility: 'visible', opacity: '0' })]), styleOf), false, 'the menu\'s dim at rest');
  assert.equal(picture.overlayOnScreen(doc([el({ visibility: 'hidden', opacity: '1' })]), styleOf), false, 'a closed menu sheet');
  assert.equal(picture.overlayOnScreen(doc([el({ visibility: 'visible', opacity: '1' }, 0)]), styleOf), false, 'a hidden form');
  assert.equal(picture.overlayOnScreen(doc([el({ visibility: 'visible', opacity: '1' })]), styleOf), true, 'the form sliding away');
  assert.equal(picture.overlayOnScreen(doc([el({ visibility: 'visible', opacity: '0' }), el({ visibility: 'visible', opacity: '0.5' })]), styleOf), true, 'a fading dim');
});

test('"Screenshot" leads the bar above the picture, never over the picture (#4774)', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The word used to be a chip drawn at the picture's top-left corner, where
  // it covered the page's own header. It is now the bar's leading label, in
  // the band above the picture, shown exactly while the picture is.
  assert.doesNotMatch(src, /comment-shot-chip-in/);
  assert.doesNotMatch(src, /left: inset\.x \+ 10, top: inset\.y \+ 10/,
    'nothing is positioned over the picture\'s corner');
  assert.match(src, /const shotLabel = !!inset && !shotIntro;/);
  const bar = src.slice(src.indexOf('role="toolbar"'));
  const label = bar.indexOf("{t('devchat:commentPin.view.chip')}");
  assert.ok(label > 0, 'the word renders inside the toolbar');
  // It leads every state of the bar — the crop frame's (#4977) first, then
  // the question, then the usual one.
  assert.ok(label < bar.indexOf('{cropping && cropView ? ('), 'it leads the bar, before each of its states');
  assert.equal(src.split("t('devchat:commentPin.view.chip')").length - 1, 1, 'rendered once, in the bar');
  assert.match(bar, /\{shotLabel \? \(\s*<>\s*\{\/\*[\s\S]*?\*\/\}\s*<span\s+aria-hidden="true"\s+className=\{`comment-shot-label-in min-w-0 truncate ps-1\.5 text-\[13px\] font-semibold text-zinc-500 dark:text-zinc-400\$\{confirm \? ' hidden sm:inline' : ''\}`\}/,
    'a muted label that truncates first, and stays while the bar asks its question on a computer: the picture is still there');
  // On a phone the label takes the place of the mode's chat glyph, so the
  // bar still fits a 390px screen.
  assert.match(bar, /\$\{shotLabel \? 'hidden sm:inline-flex' : 'inline-flex'\} shrink-0 items-center gap-1\.5 text-sm font-bold text-violet-700/);
  // And the Form / Comment switch drops its two glyphs on a phone while the
  // word shows, so "Screenshot" is whole at 390px rather than "Screen…".
  assert.match(bar, /<DescriptionIcon className=\{`\$\{shotLabel \? 'hidden sm:block' : ''\} h-4 w-4`\} \/>/);
  assert.match(bar, /<ChatIcon className=\{`\$\{shotLabel \? 'hidden sm:block' : ''\} h-4 w-4`\} \/>\s*\{t\('devchat:commentPin\.bar\.comment'\)\}/);
});

test('the picture leaves the suggest flow\'s own overlays out, so the form never shows in it', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // The form's Comment switch closes the form and opens the mode in the same
  // breath, so the first view picture is drawn while the form is still
  // leaving the screen: the sheet's slide-down on a phone, the kit shell's
  // exit on a computer. Drawn, it reads as part of the page the comment is
  // on, and the view keeps the picture until the page next scrolls, so the
  // capture hides the overlay instead of waiting the exit out.
  assert.ok(picture.PAGE_EXCLUDES.includes('#feedback-modal'), 'the form, in its sheet presentation');
  assert.ok(picture.PAGE_EXCLUDES.includes('.un-modal'), 'the kit dialog\'s shell, the form on a computer');
  assert.ok(picture.PAGE_EXCLUDES.includes('.un-backdrop'), 'the kit\'s dim, which would grey the whole page');
  // #4730: the Homeroom menu on a computer is a CSS dropdown of its own ids,
  // not a kit shell, so nothing above names it — and the suggest row opens
  // comment mode, whose picture would carry the menu still on screen.
  assert.ok(picture.PAGE_EXCLUDES.includes('#apps-switcher-sheet'), 'the Homeroom menu on a computer');
  assert.ok(picture.PAGE_EXCLUDES.includes('#apps-switcher-overlay'), 'its dim, which would grey the whole page');
  for (const sel of picture.PAGE_EXCLUDES) {
    assert.match(sel, /^[.#][\w-]+$/, 'a selector SnapDOM can match, not a bare word');
  }
  // They are cut out of the picture, not hidden in it (#4773): SnapDOM's
  // `hide` stands an in-flow block of the element's size in its place,
  // dropping its `position`, so the menu's always-mounted `fixed inset-0`
  // dim became a screen-tall block that pushed the whole screen out of the
  // bounded shell's body. Only the layer's host and the frames keep `hide`.
  assert.match(src, /exclude: \[\(el: Element\) => el === host, 'iframe'\],\s*excludeMode: 'hide',\s*filter: \(el: Element\) => !isPageOverlay\(el\),\s*filterMode: 'remove',/);
  assert.doesNotMatch(src, /'iframe', \.\.\.PAGE_EXCLUDES\]/, 'no overlay goes through hide');
  const el = (matches) => ({ matches: (sel) => matches.includes(sel) });
  assert.equal(picture.isPageOverlay(el(['#apps-switcher-overlay'])), true);
  assert.equal(picture.isPageOverlay(el(['.un-sheet'])), true);
  assert.equal(picture.isPageOverlay(el(['#home-screen'])), false, 'the page itself stays');
  assert.equal(picture.isPageOverlay({ matches: () => { throw new Error('bad'); } }), false);
  assert.equal(picture.isPageOverlay(null), false);
});

test('scrollers are drawn as clipped boxes in the copy, so WebKit paints them the first time', () => {
  // Home's Discover rail (a horizontal scroller) was missing from the first
  // picture after the app launched: WebKit left the scrolling layer out of
  // its first rasterization of the SVG. The copy draws every scroller as a
  // plain clipped box instead; the page itself is never touched.
  const node = (connected, styleProps = null) => {
    const set = {};
    return { nodeType: 1, isConnected: connected, styleProps, style: { setProperty: (k, v, p) => { set[k] = `${v}${p ? ' !' + p : ''}`; } }, set };
  };
  const rail = node(true, { overflowX: 'auto', overflowY: 'hidden' });
  const railCopy = node(false);
  const card = node(true, { overflowX: 'visible', overflowY: 'visible' });
  const cardCopy = node(false);
  const feed = node(true, { overflowX: 'hidden', overflowY: 'scroll' });
  const feedCopy = node(false);
  const text = { nodeType: 3, isConnected: true };
  const styleOf = (el) => el.styleProps;
  // SnapDOM's map, either way round: original to copy, or copy to original.
  const map = new Map([[rail, railCopy], [cardCopy, card], [feed, feedCopy], [text, { nodeType: 3 }]]);
  assert.equal(picture.flattenScrollers({ nodeMap: map }, styleOf), 2);
  assert.deepEqual(railCopy.set, { overflow: 'hidden !important', '-webkit-overflow-scrolling': 'auto !important', 'clip-path': 'inset(0) !important' });
  assert.deepEqual(feedCopy.set, { overflow: 'hidden !important', '-webkit-overflow-scrolling': 'auto !important', 'clip-path': 'inset(0) !important' });
  assert.deepEqual(cardCopy.set, {}, 'a box that does not scroll is left as it is');
  assert.deepEqual(rail.set, {}, 'the page is never written to');
  assert.equal(picture.flattenScrollers({}, styleOf), 0, 'no map, nothing done');
  assert.equal(picture.FLAT_SCROLLERS.name, 'homeroom-flat-scrollers');
  const src = read('frontend/src/features/comment-pin/picture.ts');
  assert.match(src, /filterMode: 'remove',\s*plugins: \[FLAT_SCROLLERS\],/, 'every capture of the page uses it');
});

test('the picture is clipped to the page the mode keeps, and only a paged document scrolls it', () => {
  const realDoc = global.document;
  const realWin = global.window;
  const withPage = (paged, win, fn) => {
    global.document = { documentElement: { hasAttribute: (name) => paged && name === 'data-browser-scroller' } };
    global.window = win;
    try { return fn(); } finally { global.document = realDoc; global.window = realWin; }
  };
  const win = { scrollX: 0, scrollY: 335, innerWidth: 402, innerHeight: 539 };
  // The bounded shell (the app, a computer): the document never scrolls, so
  // an offset is iOS panning a field into view, and the keys' collapsed
  // innerHeight gives way to the size the mode keeps.
  assert.deepEqual(withPage(false, win, () => picture.pageClip({ width: 402, height: 874 })),
    { x: 0, y: 0, width: 402, height: 874 });
  // A phone browser's paged document is the page's own scroller.
  assert.deepEqual(withPage(true, { ...win, scrollY: 1200 }, () => picture.pageClip({ width: 402, height: 874 })),
    { x: 0, y: 1200, width: 402, height: 874 });
  // No kept size: the window's.
  assert.deepEqual(withPage(false, win, () => picture.pageClip(null)), { x: 0, y: 0, width: 402, height: 539 });
  const src = read('frontend/src/features/comment-pin/picture.ts');
  assert.match(src, /clip: pageClip\(viewport\),/);
  assert.match(src, /const actual = canvas\.width \/ width;/, 'the picture\'s scale is read against the kept width');
});

test('a preview crop slides to the pins and puts them where the crop drew them', () => {
  const box = { width: 64, height: 42 };
  const phone = { width: 804, height: 1748 };
  // A phone's tall picture in the wide chip: the width fills, a slice of the
  // height shows, centred on the pin where the edges allow.
  const mid = picture.coverCrop(box, phone, { x: 0.3, y: 0.4 });
  assert.equal(mid.width, 64);
  assert.ok(Math.abs(mid.height - 139.14) < 0.01);
  assert.ok(Math.abs(mid.y - (21 - 0.4 * mid.height)) < 1e-9, 'the pin sits at the box\'s middle');
  const pinY = mid.y + 0.4 * mid.height;
  assert.ok(pinY > 0 && pinY < 42, 'and inside the box');
  // Near an edge the crop stops at the picture's edge instead.
  assert.deepEqual(picture.coverCrop(box, phone, { x: 0.5, y: 0 }).y, 0);
  const foot = picture.coverCrop(box, phone, { x: 0.5, y: 1 });
  assert.ok(Math.abs(foot.y - (42 - foot.height)) < 1e-9);
  // A wide picture fills the height and slides sideways.
  const wide = picture.coverCrop(box, { width: 2880, height: 1800 }, { x: 0.9, y: 0.5 });
  assert.equal(wide.height, 42);
  assert.ok(Math.abs(wide.x - (64 - wide.width)) < 1e-9);
  // The chip draws the crop and its pins with it, never as fractions of the box.
  // A cropped picture is shown whole now, the part kept framed and the rest
  // dimmed (#5020), and only the pins the crop keeps are drawn.
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const shown = pic\.size \|\| size;/);
  assert.match(src, /const crop = coverCrop\(\{ width: 64, height: 42 \}, shown, focus\);/);
  assert.match(src, /\(\{ c, left: crop\.x \+ at\.x \* crop\.width, top: crop\.y \+ at\.y \* crop\.height \}\)/);
  assert.doesNotMatch(src, /left: `\$\{c\.pin\.x \* 100\}%`/);
  assert.match(src, /<img\s+src=\{pic\.thumb\}/,
    'the chip draws the full picture, never the crop\'s own thumb');
  assert.match(src, /left: crop\.x \+ pic\.cut\.rect\.x \* crop\.width/,
    'the frame sits over the kept part of the full picture');
  assert.match(src, /boxShadow: CROP_SHADE/, 'the kept part is framed, the rest dimmed');
  assert.match(src, /pinInCrop\(c\.pin, pic\.cut\.rect\) !== null/, 'a pin the crop cut away is not drawn');
});

// ── 1d. Cropping a screenshot by dragging its corners and edges (#4977) ─

test('dragCrop moves only the sides the handle names, inward only, and never below the minimum', () => {
  // Fractions of a picture add up to noise past the twelfth decimal; the
  // frame's geometry is what is pinned, not the last bits of the sum.
  const rounded = (r) => ({ x: +r.x.toFixed(10), y: +r.y.toFixed(10), width: +r.width.toFixed(10), height: +r.height.toFixed(10) });
  const is = (actual, expected, note) => assert.deepEqual(rounded(actual), expected, note);
  const full = { x: 0, y: 0, width: 1, height: 1 };
  // A corner moves exactly its two sides; the opposite ones stay put.
  is(picture.dragCrop(full, 'nw', { x: 0.25, y: 0.1 }, { width: 0.05, height: 0.05 }),
    { x: 0.25, y: 0.1, width: 0.75, height: 0.9 });
  is(picture.dragCrop(full, 'se', { x: -0.2, y: -0.3 }, { width: 0.05, height: 0.05 }),
    { x: 0, y: 0, width: 0.8, height: 0.7 });
  is(picture.dragCrop(full, 'ne', { x: -0.1, y: 0.2 }, { width: 0.05, height: 0.05 }),
    { x: 0, y: 0.2, width: 0.9, height: 0.8 });
  is(picture.dragCrop(full, 'sw', { x: 0.15, y: -0.25 }, { width: 0.05, height: 0.05 }),
    { x: 0.15, y: 0, width: 0.85, height: 0.75 });
  // An edge moves only its one side.
  const part = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  is(picture.dragCrop(part, 'e', { x: 0.1, y: 0.4 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0.2, width: 0.6, height: 0.5 }, 'east grows to the picture\'s edge, height untouched');
  is(picture.dragCrop(part, 'w', { x: 0.1, y: 0.4 }, { width: 0.05, height: 0.05 }),
    { x: 0.3, y: 0.2, width: 0.4, height: 0.5 }, 'west moves the left side only');
  is(picture.dragCrop(part, 'n', { x: 0.4, y: -0.15 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0.05, width: 0.5, height: 0.65 }, 'north moves the top side only');
  is(picture.dragCrop(part, 's', { x: 0.4, y: 0.15 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0.2, width: 0.5, height: 0.65 }, 'south grows the bottom only');
  // Inward only: a drag past the picture's edge clamps there.
  is(picture.dragCrop(part, 'e', { x: 1, y: 0 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0.2, width: 0.8, height: 0.5 });
  is(picture.dragCrop(part, 'w', { x: -1, y: 0 }, { width: 0.05, height: 0.05 }),
    { x: 0, y: 0.2, width: 0.7, height: 0.5 });
  is(picture.dragCrop(part, 'n', { x: 0, y: -1 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0, width: 0.5, height: 0.7 });
  is(picture.dragCrop(part, 's', { x: 0, y: 1 }, { width: 0.05, height: 0.05 }),
    { x: 0.2, y: 0.2, width: 0.5, height: 0.8 });
  // Crossing sides stops at the minimum, never inverting the frame: a west
  // or north handle dragged far inward stops a minimum short of its
  // opposite side.
  const thin = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
  is(picture.dragCrop(thin, 'w', { x: 0.5, y: 0 }, { width: 0.1, height: 0.1 }),
    { x: 0.3, y: 0.1, width: 0.1, height: 0.3 }, 'west stops a minimum short of the right side');
  is(picture.dragCrop(thin, 'n', { x: 0, y: 0.5 }, { width: 0.1, height: 0.1 }),
    { x: 0.1, y: 0.3, width: 0.3, height: 0.1 }, 'north stops a minimum short of the bottom');
  is(picture.dragCrop(thin, 'e', { x: 0.9, y: 0 }, { width: 0.1, height: 0.1 }),
    { x: 0.1, y: 0.1, width: 0.9, height: 0.3 }, 'east stops at the picture\'s right edge');
  is(picture.dragCrop(thin, 'se', { x: 0.9, y: 0.9 }, { width: 0.1, height: 0.1 }),
    { x: 0.1, y: 0.1, width: 0.9, height: 0.9 }, 'a corner clamps on both sides at once');
});

test('pinInCrop maps a pin into the crop, and nulls the ones the crop cuts away', () => {
  // No crop: every pin comes back unchanged.
  assert.deepEqual(picture.pinInCrop({ x: 0.3, y: 0.7 }, null), { x: 0.3, y: 0.7 });
  const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(picture.pinInCrop({ x: 0.5, y: 0.5 }, crop), { x: 0.5, y: 0.5 }, 'the crop\'s middle stays the middle');
  assert.deepEqual(picture.pinInCrop({ x: 0.25, y: 0.75 }, crop), { x: 0, y: 1 }, 'the crop\'s corner maps to the frame\'s');
  assert.equal(picture.pinInCrop({ x: 0.1, y: 0.5 }, crop), null, 'left of the frame is gone');
  assert.equal(picture.pinInCrop({ x: 0.5, y: 0.9 }, crop), null, 'below the frame is gone');
  assert.equal(picture.pinInCrop({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5, width: 0, height: 0.5 }), null, 'a flat frame keeps nothing');
  assert.deepEqual(picture.pinInCrop({ x: 0.8, y: 0.8 }, picture.FULL_CROP), { x: 0.8, y: 0.8 }, 'the full crop keeps everything, unchanged');
});

test('cropPixels rounds a crop to whole pixels inside the picture, and isFullCrop says when nothing was cut', () => {
  const size = { width: 1000, height: 500 };
  assert.deepEqual(picture.cropPixels(size, { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }),
    { x: 100, y: 100, width: 500, height: 200 });
  assert.deepEqual(picture.cropPixels(size, picture.FULL_CROP), { x: 0, y: 0, width: 1000, height: 500 });
  // Rounding never leaves the picture or collapses to nothing.
  assert.deepEqual(picture.cropPixels(size, { x: 0.9995, y: 0, width: 0.001, height: 1 }),
    { x: 999, y: 0, width: 1, height: 500 });
  assert.deepEqual(picture.cropPixels({ width: 10, height: 10 }, { x: 0.95, y: 0.95, width: 0.05, height: 0.05 }),
    { x: 9, y: 9, width: 1, height: 1 });
  assert.equal(picture.isFullCrop(picture.FULL_CROP), true);
  assert.equal(picture.isFullCrop({ x: 0, y: 0, width: 1, height: 1 }), true);
  assert.equal(picture.isFullCrop(null), true, 'no crop is the whole picture');
  assert.equal(picture.isFullCrop({ x: 0.0005, y: 0, width: 0.9998, height: 1 }), true, 'a hair off full is still full');
  assert.equal(picture.isFullCrop({ x: 0.01, y: 0, width: 0.99, height: 1 }), false);
});

test('a cropped picture posts cropped: the frame is cut off the canvas and its pins remapped', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // The posted pins go through pinInCrop, and a pin the crop cuts away does
  // not post — the part of the picture it was on is gone.
  assert.match(src, /const pins = live\.map\(\(c, i\) => \(\{ c, i, at: pinInCrop\(c\.pin, pic\.cut\?\.rect \?\? null\) \}\)\)/,
    'every comment\'s pin maps through pinInCrop');
  assert.match(src, /\.filter\(\(\{ c, at \}\) => c\.picture === pic\.key && at\)/,
    'a pin outside the crop does not post');
  assert.match(src, /const canvas = pic\.cut \? cropCanvas\(base\.canvas, pic\.cut\.rect\) : base\.canvas;/,
    'the posted picture is the crop cut off the full canvas');
  assert.match(src, /const blob = await encodeUnder\(canvas\);/,
    'the cropped canvas is what is encoded');
  // Applying the crop: comments outside go, with a toast saying how many.
  assert.match(src, /const dropped = onPic\.filter\(\(c\) => pinInCrop\(c\.pin, crop\.rect\) === null\);/);
  assert.match(src, /t\('devchat:commentPin\.crop\.removed', \{ count: dropped\.length \}\)/);
  // Crop opens at the saved rect, or the whole picture when there is none.
  assert.match(src, /setCropping\(\{ picture: pic\.key, rect: pic\.cut\?\.rect \?\? FULL_CROP \}\)/);
});

test('the crop frame reads its words from the catalog, and the thumbnail gains a Crop button', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /aria-label=\{t\('devchat:commentPin\.shot\.cropLabel'\)\}/,
    'the thumbnail\'s crop button is named for screen readers');
  assert.match(src, /t\('devchat:commentPin\.crop\.title'\)/, 'the bar names the drag');
  assert.match(src, /t\('devchat:commentPin\.crop\.keepOne'\)/, 'the bar says why Apply is off');
  assert.match(src, /t\('devchat:commentPin\.crop\.dropping', \{ count: cropView\.dropped \}\)/,
    'the bar counts what applying would remove');
  assert.equal(message('devchat:commentPin.shot.crop'), 'Crop');
  assert.equal(message('devchat:commentPin.shot.cropLabel'), 'Crop the screenshot');
  assert.equal(message('devchat:commentPin.crop.title'), 'Drag the corners or edges to crop');
  assert.equal(message('devchat:commentPin.crop.reset'), 'Reset');
  assert.equal(message('devchat:commentPin.crop.apply'), 'Apply');
  assert.equal(message('devchat:commentPin.crop.keepOne'), 'Keep at least one pin inside');
  assert.equal(message('devchat:commentPin.crop.dropping', { count: 1 }), '1 comment outside will be removed');
  assert.equal(message('devchat:commentPin.crop.dropping', { count: 3 }), '3 comments outside will be removed');
  assert.equal(message('devchat:commentPin.crop.removed', { count: 1 }), 'Removed 1 comment outside the crop.');
  assert.equal(message('devchat:commentPin.crop.removed', { count: 2 }), 'Removed 2 comments outside the crop.');
});

// ── 1c. The retake when the picture lost what the pin is on (#4773) ────

test('flatRegion: one colour, noise under the tolerance, one inked pixel', () => {
  const of = (...values) => new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255]));
  assert.equal(picture.flatRegion(of(18)), true, 'a single colour');
  assert.equal(picture.flatRegion(of(18, 22, 14, 24, 11)), true, 'noise within the tolerance is the same colour');
  const inked = of(18, 18, 18, 18);
  inked.set([18, 18, 18, 255, 200, 200, 200, 255], 4);
  assert.equal(picture.flatRegion(inked), false, 'one inked pixel is not flat');
  assert.equal(picture.flatRegion(new Uint8ClampedArray(2)), true, 'nothing to read counts as flat');
  assert.equal(picture.flatRegion(of(18), 0), true, 'the tolerance is on every channel, alpha included');
  const faded = new Uint8ClampedArray([18, 18, 18, 255, 18, 18, 18, 200]);
  assert.equal(picture.flatRegion(faded), false, 'a different alpha is not the same colour');
});

test('the retake captures with the cache off when fresh, and keeps the excludes either way', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  assert.match(src, /cache: fresh \? 'disabled' : 'soft',/, 'the flag is SnapDOM\'s cache switch');
  assert.match(src, /excludeMode: 'hide',/, 'the layer and frames keep their places');
  assert.match(src, /filterMode: 'remove',/, 'the overlays are cut out');
  assert.match(src, /drawShell\(scale, host, false, viewport\)/, 'the first picture is clipped to the kept page size');
});

test('pinTarget: the page element under the pin, never the layer, a frame or an overlay', () => {
  const rect = (x, y, w, h) => ({ left: x, top: y, width: w, height: h });
  const el = (name, r, text = '', attrs = {}) => ({
    tagName: name,
    getBoundingClientRect: () => r,
    innerText: text,
    textContent: text,
    closest: (sel) => (attrs.hits && attrs.hits.includes(sel) ? attrs.self : null),
    getAttribute: (a) => (attrs.attrs || {})[a] || null,
  });
  const body = { tagName: 'BODY', closest: () => null };
  const docElement = { tagName: 'HTML', closest: () => null };
  const host = { contains: (e) => e === host || e === hostChild };
  const hostChild = { tagName: 'DIV' };
  const frame = { tagName: 'IFRAME' };
  const overlay = el('DIV', rect(10, 10, 100, 20), 'Comment', { hits: ['.un-sheet'], self: {} });
  const good = el('H2', rect(50, 100, 300, 24), 'OVERVIEW');
  const tiny = el('SPAN', rect(50, 50, 3, 3), 'x');
  const silent = el('DIV', rect(50, 50, 300, 24), '   ');
  const previousDocument = globalThis.document;
  globalThis.document = {
    documentElement: docElement,
    body,
    elementsFromPoint: () => [hostChild, overlay, tiny, silent, good, body],
  };
  try {
    assert.deepEqual(picture.pinTarget({ x: 60, y: 110 }, host), { x: 50, y: 100, width: 300, height: 24 },
      'the first element with words and a real size, past the layer and the small and silent ones');
    globalThis.document.elementsFromPoint = () => [hostChild, frame];
    assert.equal(picture.pinTarget({ x: 60, y: 110 }, host), null, 'the running app\'s frame is another document: no check, no retake');
    globalThis.document.elementsFromPoint = () => [overlay];
    assert.equal(picture.pinTarget({ x: 60, y: 110 }, host), null, 'the flow\'s own overlay: no check');
    globalThis.document.elementsFromPoint = () => [tiny, silent];
    assert.equal(picture.pinTarget({ x: 60, y: 110 }, host), null, 'nothing with words to check: no retake');
    globalThis.document.elementsFromPoint = () => [docElement, body];
    assert.equal(picture.pinTarget({ x: 60, y: 110 }, host), null, 'the page itself is never a target');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('takeBase checks the pin\'s element and retakes at most once, with a clean cache, only on a flat region', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // The retake is one call, spelled through the fresh flag, and it sits
  // behind the flat-region check: no flat region, no retake; a second flat
  // picture is kept, never retaken again.
  assert.equal((src.match(/drawShell\(scale, host, true, viewport\)/g) || []).length, 1, 'one retake, not a loop');
  assert.match(src, /const checked = await missingUnderPin\(canvas, actual, target\);\s*if \(checked\) \{/);
  assert.match(src, /return flatRegion\(data\);/, 'the check is a flat region under the pin');
  // The retake waits two animation frames before it draws.
  assert.match(src, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => r\(\)\)\)/);
  // Without a target nothing extra happens, and the first canvas stands.
  assert.match(src, /if \(!target\) return false;/);
  // A canvas that cannot be read keeps the first picture.
  assert.match(src, /catch \{\s*return false;\s*\}/, 'the read is guarded');
  // The app's picture is laid into the retake too, so a pin beside the frame
  // keeps it.
  assert.match(src, /if \(frameRect\) await layInApp\(again, retaken, frameRect, picture\);/);
});

// ── 3b. The side panel's picture (#4975) ──────────────────────────────

test('takeBase asks the side panel for its picture with the others, and lays it in on the first picture and the retake', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // The panel's frame is found by id, measured and visibility-checked, like
  // any other frame the picture fills in.
  assert.match(src, /getElementById\('side-panel-frame'\)/);
  assert.match(src, /export function panelFrame\(\): \{ frame: HTMLIFrameElement; rect: Rect \} \| null \{/);
  // Asked once, in the same Promise.all as the shell, the app's picture and
  // the designs' (they were added beside it), so the slowest leg bounds the
  // wait.
  assert.match(src, /Promise\.all\(\[shell, app, panelPicture, designs\]\)/);
  // Laid in at the frame's rectangle times the picture's real scale, on the
  // first canvas and on the retake (the same blob, asked once).
  assert.match(src, /await layInPanel\(canvas, actual, panel\?\.rect, panelBlob\);/);
  assert.match(src, /await layInPanel\(again, retaken, panel\?\.rect, panelBlob\);/);
  // No plate when it did not answer: the frame's rectangle keeps whatever
  // the shell drew there, at worst the empty body the bug described.
  const lay = src.match(/async function layInPanel[\s\S]*?\n\}/);
  assert.ok(lay, 'layInPanel exists beside layInApp');
  assert.doesNotMatch(lay[0], /fillStyle|fillText/);
  // The flow's own overlays keep the treatment they had: the panel is not
  // one of them, and the kit's touch-header drawer (.un-panel) stays.
  assert.deepEqual(picture.PAGE_EXCLUDES, [
    '#feedback-modal',
    '#apps-switcher-sheet',
    '#apps-switcher-overlay',
    '#dev-plus-menu',
    '.overlay-scrim',
    '.un-modal',
    '.un-sheet',
    '.un-panel',
    '.un-action-sheet',
    '.un-backdrop',
  ]);
});

test('drawDocument is the panel drawing its own page, with the shell\'s exclusions and none laid in', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // Frames are hidden in place (no panel page runs an app the picture could
  // ask), the flow's overlays are cut out, scrollers are flattened for
  // WebKit's first paint.
  assert.match(src, /exclude: \['iframe'\],\s*\n\s*excludeMode: 'hide',\s*\n\s*filter: \(el: Element\) => !isPageOverlay\(el\),\s*\n\s*filterMode: 'remove',\s*\n\s*plugins: \[FLAT_SCROLLERS\],/,
    'the same exclusions as drawShell, over the panel document\'s own body');
  // It hands back a PNG blob, and null on any failure.
  assert.match(src, /return await toBlob\(canvas, 'image\/png'\);/);
  const draw = src.match(/export async function drawDocument[\s\S]*?\n\}\n\nexport interface Base/);
  assert.ok(draw, 'drawDocument is exported beside drawShell');
  assert.match(draw[0], /catch \{\s*\n\s*return null;/, 'any failure is null, never a rejection');
});

test('requestPanelPicture: no runtime, a throwing draw, a slow draw, a real answer', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const frame = (embed) => ({
    contentWindow: embed ? { UsernodeReact: { sidePanelEmbed: embed } } : {},
  });
  // The panel still booting or gone: no runtime, nothing to lay in.
  assert.equal(await picture.requestPanelPicture(frame(null), 1, 50), null);
  // A draw that throws resolves null, never a rejection.
  assert.equal(await picture.requestPanelPicture(
    frame({ picture: () => { throw new Error('gone'); } }), 1, 50), null);
  // One that never answers is cut off by the timeout.
  assert.equal(await picture.requestPanelPicture(
    frame({ picture: () => new Promise(() => {}) }), 1, 20), null);
  // One that answers is passed through as it said.
  assert.equal(await picture.requestPanelPicture(frame({ picture: async () => blob }), 1, 50), blob);
  // Something that is not a picture is not drawn.
  assert.equal(await picture.requestPanelPicture(frame({ picture: async () => 'png' }), 1, 50), null);
});

test('requestPanelPicture gives the panel three seconds and takes the frame realm\'s own Blob', async () => {
  // The panel's bound is its own constant, below the app's.
  assert.match(read('frontend/src/features/comment-pin/picture.ts'), /timeoutMs = PANEL_PICTURE_TIMEOUT_MS/);
  assert.ok(picture.PANEL_PICTURE_TIMEOUT_MS < picture.APP_PICTURE_TIMEOUT_MS);
  // The panel's `toBlob` makes the Blob in the PANEL window's realm, which
  // the top window's `instanceof Blob` never matched — the panel's picture
  // was thrown away whatever it drew. The frame window's own class vouches
  // for it instead.
  class PanelBlob {}
  const made = new PanelBlob();
  const frame = {
    contentWindow: {
      Blob: PanelBlob,
      UsernodeReact: { sidePanelEmbed: { picture: async () => made } },
    },
  };
  assert.equal(await picture.requestPanelPicture(frame, 1, 50), made);
  // Without a Blob class on the frame window nothing vouches for it, and it
  // is refused as before.
  const orphan = {
    contentWindow: { UsernodeReact: { sidePanelEmbed: { picture: async () => made } } },
  };
  assert.equal(await picture.requestPanelPicture(orphan, 1, 50), null);
});

test('within passes a settled value through, and falls back on a rejection or a wait past ms', async (t) => {
  assert.equal(await picture.within(Promise.resolve('v'), 20, 'fb'), 'v');
  assert.equal(await picture.within(Promise.reject(new Error('gone')), 20, 'fb'), 'fb');
  // A promise that never settles is cut off by the timer, not left pending.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const done = picture.within(new Promise(() => {}), 3000, 'fb').then((v) => { settled = true; return v; });
    assert.equal(settled, false, 'a promise that never settles does not settle on its own');
    t.mock.timers.tick(3000);
    await new Promise((r) => setImmediate(r));
    assert.equal(await done, 'fb');
    assert.equal(settled, true);
  } finally {
    t.mock.timers.reset();
  }
});

test('the panel picture promise cannot block takeBase', async (t) => {
  // The panel is open and laid out, its runtime answers, and its draw never
  // settles (a capture competing for the shared main thread). takeBase must
  // still resolve within the panel's bound, with the panel left undrawn.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const script = { onload: null, remove() {} };
  const panel = {
    src: 'https://homeroom.test/?panel=1#home',
    getBoundingClientRect: () => ({ left: 880, top: 0, width: 380, height: 680 }),
    checkVisibility: () => true,
    contentWindow: {
      UsernodeReact: { sidePanelEmbed: { picture: () => new Promise(() => {}) } },
    },
  };
  const canvas = { width: 1280, height: 800, getContext: () => null };
  globalThis.document = {
    body: {},
    documentElement: { hasAttribute: () => false },
    getElementById: (id) => (id === 'side-panel-frame' ? panel : null),
    createElement: () => script,
    head: { appendChild: (s) => { s.onload(); } },
    elementsFromPoint: () => [],
  };
  globalThis.window = { snapdom: () => Promise.resolve({ toCanvas: async () => canvas }) };
  globalThis.getComputedStyle = () => ({ backgroundColor: '#ffffff' });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  try {
    const base = picture.takeBase({
      host: {}, scale: 1, frame: null, frameRect: null,
      pin: { x: 10, y: 10 }, viewport: { width: 1280, height: 800 },
    });
    let settled = false;
    const done = base.then((v) => { settled = true; return v; });
    t.mock.timers.tick(picture.PANEL_PICTURE_TIMEOUT_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, true, 'takeBase did not wait on the panel past its bound');
    const out = await done;
    assert.ok(out, 'takeBase resolved with a picture, not null');
    assert.equal(out.canvas, canvas);
    assert.equal(out.scale, 1);
    assert.equal(out.app, null);
  } finally {
    t.mock.timers.reset();
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.getComputedStyle = prev.getComputedStyle;
    globalThis.requestAnimationFrame = prev.requestAnimationFrame;
  }
});

test('takeBase bounds the shell\'s own draw, and layInPanel bounds the panel blob\'s decode', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // Both shell reads go through within: a capture slowed or stalled by the
  // panel's competing draw gives way after fifteen seconds.
  assert.match(src, /const shell = within\(drawShell\(scale, host, false, viewport\), SHELL_PICTURE_TIMEOUT_MS, null\);/);
  assert.match(src, /const again = await within\(drawShell\(scale, host, true, viewport\), SHELL_PICTURE_TIMEOUT_MS, null\);/);
  // And the panel blob's decode: a blob that will not decode draws nothing.
  const lay = src.match(/async function layInPanel[\s\S]*?\n\}/);
  assert.ok(lay, 'layInPanel exists beside layInApp');
  assert.match(lay[0], /within\(createImageBitmap\(blob\), PANEL_PICTURE_TIMEOUT_MS, null\)/);
  assert.match(lay[0], /if \(!bitmap\) return;/);
});

// ── 3c. Designs draw their own picture (#6261) ────────────────────────

test('takeBase asks each design frame for its own picture and lays it in on the first picture and the retake', () => {
  const src = read('frontend/src/features/comment-pin/picture.ts');
  // Both design iframes carry the marker the shell finds them by.
  assert.match(read('frontend/src/features/messages/design-pane.tsx'), /data-design-frame=""/);
  assert.match(read('frontend/src/features/messages/design-card.tsx'), /data-design-frame=""/);
  assert.match(src, /iframe\[\$\{DESIGN_FRAME_ATTR\}\]/);
  // Asked beside the shell, the app and the panel, bounded like the panel: a
  // design that misses its bound draws nothing, holding no longer than it.
  assert.match(src, /const designs = within\(designPictures\(scale\), PANEL_PICTURE_TIMEOUT_MS, \[\]\);/);
  assert.match(src, /Promise\.all\(\[shell, app, panelPicture, designs\]\)/);
  // Its picture goes into the frame's own rectangle, clipped to its wrapper,
  // on the first canvas and on the retake (the blobs are asked once).
  assert.match(src, /for \(const design of designBlobs\) await layInDesign\(canvas, actual, design\.rect, design\.clip, design\.blob\);/);
  assert.match(src, /for \(const design of designBlobs\) await layInDesign\(again, retaken, design\.rect, design\.clip, design\.blob\);/);
  // drawDocument, the panel's own page, runs the same leg before encoding.
  const draw = src.match(/export async function drawDocument[\s\S]*?\n\}\n\nexport interface Base/);
  assert.ok(draw, 'drawDocument is exported beside drawShell');
  assert.match(draw[0], /within\(designPictures\(scale\), PANEL_PICTURE_TIMEOUT_MS, \[\]\)/);
  assert.match(draw[0], /layInDesign\(canvas, scale, design\.rect, design\.clip, design\.blob\)/);
  // No blob draws nothing: the shell's hidden frame keeps its place, which is
  // today's empty box, never a wrong claim about the design.
  const lay = src.match(/async function layInDesign[\s\S]*?\n\}/);
  assert.ok(lay, 'layInDesign exists beside layInPanel');
  assert.match(lay[0], /if \(!blob\) return;/);
  assert.match(lay[0], /ctx\.save\(\)/);
  assert.match(lay[0], /ctx\.clip\(\)/);
  assert.match(lay[0], /ctx\.restore\(\)/);
  // Every frame is still hidden by the shell's own draw, so none is drawn
  // twice and the ones that are not designs keep their blank place.
  assert.match(src, /exclude: \[\(el: Element\) => el === host, 'iframe'\],\s*excludeMode: 'hide'/);
});

test('designFrames finds the marked frames on screen and stops at eight', () => {
  const prev = { document: globalThis.document, window: globalThis.window };
  const frameAt = (r, extra = {}) => ({
    contentWindow: {},
    getBoundingClientRect: () => r,
    checkVisibility: () => true,
    parentElement: { getBoundingClientRect: () => r },
    ...extra,
  });
  const good = frameAt({ left: 10, top: 20, width: 100, height: 200, right: 110, bottom: 220 });
  const tiny = frameAt({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
  const hidden = frameAt({ left: 10, top: 10, width: 50, height: 50, right: 60, bottom: 60 }, { checkVisibility: () => false });
  const offscreen = frameAt({ left: 900, top: 0, width: 100, height: 100, right: 1000, bottom: 100 });
  const gone = frameAt({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }, { contentWindow: null });
  globalThis.document = {
    querySelectorAll: (sel) => (sel === 'iframe[data-design-frame]' ? [good, tiny, hidden, offscreen, gone] : []),
    documentElement: {},
  };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  try {
    const found = picture.designFrames();
    assert.equal(found.length, 1, 'only a frame that is really on screen');
    assert.equal(found[0].frame, good);
    assert.deepEqual(found[0].rect, { x: 10, y: 20, width: 100, height: 200 });
    assert.deepEqual(found[0].clip, { x: 10, y: 20, width: 100, height: 200 }, 'its wrapper, inside the viewport');
    // A frame partly out of the viewport is clipped to the part that shows.
    const partial = frameAt({ left: -50, top: -10, width: 100, height: 100, right: 50, bottom: 90 });
    globalThis.document = { querySelectorAll: () => [partial], documentElement: {} };
    assert.deepEqual(picture.designFrames()[0].clip, { x: 0, y: 0, width: 50, height: 90 });
    // More than a page normally shows: the first eight only.
    const many = Array.from({ length: 12 }, () => frameAt({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }));
    globalThis.document = { querySelectorAll: () => many, documentElement: {} };
    assert.equal(picture.designFrames().length, 8);
  } finally {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
  }
});

test('requestDesignPicture takes only this frame\'s answer with the id it sent, and gives up after its bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prev = globalThis.window;
  const listeners = [];
  const sent = [];
  const target = { postMessage: (message) => sent.push(message) };
  const other = {};
  const frame = { contentWindow: target };
  globalThis.window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  try {
    const asked = picture.requestDesignPicture(frame, 2, '/* snapdom */', 1000);
    assert.equal(sent.length, 1, 'one request is posted');
    assert.equal(sent[0].__design, 'picture');
    assert.equal(sent[0].scale, 2);
    assert.equal(sent[0].lib, '/* snapdom */');
    assert.equal(typeof sent[0].id, 'string');
    const id = sent[0].id;
    const blob = new Blob(['png'], { type: 'image/png' });
    // Another frame's answer, and this frame's answer with another id, are
    // both ignored: a design's script can supply only its own frame's image.
    for (const answer of [
      { source: other, data: { __design: 'picture', id, blob } },
      { source: target, data: { __design: 'picture', id: 'another', blob } },
      { source: target, data: { __design: 'pin', id, blob } },
    ]) listeners.slice().forEach((fn) => fn(answer));
    assert.equal(listeners.length, 1, 'still waiting after the wrong answers');
    listeners.slice().forEach((fn) => fn({ source: target, data: { __design: 'picture', id, blob } }));
    assert.equal(await asked, blob);
    assert.equal(listeners.length, 0, 'the listener is gone once answered');
    // Nothing said: the bound resolves null, and the listener is gone too.
    const slow = picture.requestDesignPicture(frame, 1, 'lib', 1000);
    assert.equal(listeners.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(await slow, null);
    assert.equal(listeners.length, 0);
  } finally {
    t.mock.timers.reset();
    globalThis.window = prev;
  }
});

// ── 2. Posting ────────────────────────────────────────────────────────

test('the request is the comment\'s words, plus a link to the change it was pinned in', () => {
  assert.equal(post.descriptionFor('  Make it bigger  ', ''), 'Make it bigger', 'nothing else is added');
  assert.equal(post.descriptionFor('Make it bigger', post.changeLine(4223, 'milkdrop')),
    'Make it bigger\n\nChange: #app/milkdrop/dev/sessions/4223');
  assert.equal(post.changeLine(4223, 'milkdrop'), 'Change: #app/milkdrop/dev/sessions/4223');
  assert.equal(post.changeLine(4223, null), '', 'no slug, no link');
  assert.equal(post.changeLine(null, 'milkdrop'), '', 'no preview, no link');
  assert.equal(post.descriptionFor('Make it bigger', post.changeLine(4223, null)), 'Make it bigger');
});

function withFetch(responses, fn) {
  const calls = [];
  const prev = globalThis.window;
  globalThis.window = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { ok: r.status < 400, status: r.status, json: async () => r.body || {} };
    },
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.window = prev; });
}

const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const base = { text: 'Make it bigger', target: 'app', appSlug: 'demo', shots: [{ blob, pins: [] }], change: '' };

test('a comment is the dialog\'s two requests: the picture, then the request naming it', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { url: 'u', homeroomBot: { botWillBuild: true } } },
], async (calls) => {
  const out = await post.postComment(base);
  assert.deepEqual(out, { ok: true, botWillBuild: true, url: 'u', title: '', bounty: null, droppedPictures: 0 });
  assert.equal(calls[0].url, '/api/feedback/screenshot');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].init.body, blob);
  assert.equal(calls[1].url, '/api/feedback');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    description: 'Make it bigger',
    target: 'app', appSlug: 'demo', screenshotIds: ['a'.repeat(32)],
  });
}));

test('Homeroom gets no app slug, and a comment without a picture makes one request', () => withFetch([
  { status: 200, body: {} },
], async (calls) => {
  await post.postComment({ ...base, target: 'platform', shots: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { description: 'Make it bigger', target: 'platform' });
}));

test('a picture the server will not take does not cost the words', () => withFetch([
  { status: 400, body: { error: 'Not a PNG or JPEG' } },
  { status: 200, body: {} },
], async (calls) => {
  assert.deepEqual(await post.postComment(base), { ok: true, botWillBuild: false, url: '', title: '', bounty: null, droppedPictures: 1 });
  assert.equal(JSON.parse(calls[1].init.body).screenshotIds, undefined);
}));

// #6121: "it looked attached, then vanished on save. no error, just gone."
test('#6121: a post counts the pictures that did not make it, a refused one or one past the limit', () => withFetch([
  { status: 413, body: { error: 'Screenshot too large' } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 429, body: { error: 'Too many' } },
  { status: 200, body: {} },
], async (calls) => {
  const out = await post.postComment({ ...base, shots: [], images: [imageA, imageB, imageA, imageB] });
  assert.equal(out.ok, true);
  assert.equal(out.droppedPictures, 3, 'two refused and the fourth, never sent');
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[3].init.body).screenshotIds, ['b'.repeat(32)]);
}));

test('#6121: the box refuses an image over the server\'s limit up front, and says so', () => {
  assert.equal(picture.MAX_UPLOAD_BYTES, feedbackRoute.MAX_SCREENSHOT_BYTES, 'the box stops where the server does');
  assert.equal(picture.fitsUpload({ size: picture.MAX_UPLOAD_BYTES }), true);
  assert.equal(picture.fitsUpload({ size: picture.MAX_UPLOAD_BYTES + 1 }), false);
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const usable = images\.filter\(fitsUpload\);/);
  assert.match(src, /if \(usable\.length < images\.length\) \{\s*update\(key, \{ error: t\('devchat:commentPin\.error\.imageTooLarge', \{ megabytes: MAX_UPLOAD_BYTES \/ \(1024 \* 1024\) \}\) \}\);/);
  assert.equal(message('devchat:commentPin.error.imageTooLarge'), "Images over {{megabytes}} MB can't be attached.");
});

test('#6121: the toast names the lost pictures and the posted row does not count them', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const postedLine = lost\s*\? \(outcome\.botWillBuild\s*\? t\('devchat:commentPin\.toast\.postedPicturesLostBuilding', \{ count: lost, place: name \}\)\s*: t\('devchat:commentPin\.toast\.postedPicturesLost', \{ count: lost, place: name \}\)\)/);
  assert.match(src, /pictures: Math\.max\(0, \(post\.shots\?\.length \|\| 0\) \+ \(post\.images\?\.length \|\| 0\) - outcome\.droppedPictures\),/);
  assert.equal(message('devchat:commentPin.toast.postedPicturesLost_one'), "Posted to {{place}}, but {{count}} picture couldn't attach.");
  assert.equal(message('devchat:commentPin.toast.postedPicturesLost_other'), "Posted to {{place}}, but {{count}} pictures couldn't attach.");
});

const imageA = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const imageB = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' });
const full = {
  ...base,
  shots: [{ blob, pins: [{ x: 0.25, y: 0.5, note: 'Make the Join   button\nbigger' }] }],
  images: [imageA, imageB],
  title: '  Bigger Join button  ',
  bounty: true,
  text: 'Make the Join   button\nbigger',
};

test('the box posts every picture first, then its title, Kudos and the page\'s pin beside its picture', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { id: 'c'.repeat(32) } },
  { status: 200, body: { url: 'https://github.com/o/r/issues/4490', title: 'Bigger Join button', bounty: { placed: true, remaining: 4 } } },
], async (calls) => {
  const out = await post.postComment(full);
  assert.deepEqual(out, {
    ok: true, botWillBuild: false, url: 'https://github.com/o/r/issues/4490', title: 'Bigger Join button',
    bounty: { placed: true, remaining: 4, error: undefined }, droppedPictures: 0,
  });
  assert.deepEqual(calls.slice(0, 3).map((c) => c.init.body), [blob, imageA, imageB], 'the page first, then the person\'s own');
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    description: 'Make the Join   button\nbigger',
    target: 'app', appSlug: 'demo', title: 'Bigger Join button', bounty: true,
    screenshotIds: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
    screenshotPins: [{ id: 'a'.repeat(32), x: 0.25, y: 0.5, note: 'Make the Join button bigger' }],
  });
  assert.equal(post.numberFromUrl(out.url), 4490);
  assert.equal(post.numberFromUrl(''), null);
}));

test('parked, the box sends no bounty, says nothing of one, and hands none over (#5249)', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { id: 'c'.repeat(32) } },
  { status: 200, body: { url: 'https://github.com/o/r/issues/4490', title: 'Bigger Join button', bounty: { placed: true, remaining: 4 } } },
], async (calls) => {
  const out = await parkedPost.postComment(full);
  assert.equal(out.bounty, null, 'an answer\'s bounty is not read');
  assert.equal(JSON.parse(calls[3].init.body).bounty, undefined, 'a restored draft\'s Kudos is not sent');
  assert.equal(parkedPost.handOverOptions(full).bounty, undefined, 'nor handed to the dialog');
  const pin = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(pin, /if \(outcome\.bounty && !KUDOS_PARKED\) \{/, 'and the toast says no kudos sentence');
}));

test('no more than three pictures, and a pin only on a picture the server took', () => withFetch([
  { status: 400, body: { error: 'Screenshot too large' } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { id: 'c'.repeat(32) } },
  { status: 200, body: {} },
], async (calls) => {
  await post.postComment({ ...full, images: [imageA, imageB, imageA] });
  assert.equal(calls.length, 4, 'the fourth image is never sent');
  const body = JSON.parse(calls[3].init.body);
  assert.deepEqual(body.screenshotIds, ['b'.repeat(32), 'c'.repeat(32)]);
  assert.equal(body.screenshotPins, undefined, 'the page was refused, so there is nothing to pin');
}));

test('a request of several comments numbers them, and each picture carries its own comments\' pins', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { url: 'https://github.com/o/r/issues/4491' } },
], async (calls) => {
  const texts = ['The Join button is too small', '  Pace should say min per km  ', 'And the list wraps'];
  assert.equal(post.numberedWords(texts), '1. The Join button is too small\n\n2. Pace should say min per km\n\n3. And the list wraps');
  assert.equal(post.numberedWords(['  Just one  ', '']), 'Just one', 'one comment reads as it always has');
  const shotB = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2])], { type: 'image/png' });
  await post.postComment({
    ...base,
    text: post.numberedWords(texts),
    shots: [
      { blob, pins: [{ x: 0.1, y: 0.2, n: 1, note: texts[0] }, { x: 0.3, y: 0.4, n: 2, note: texts[1] }] },
      { blob: shotB, pins: [{ x: 0.5, y: 0.6, n: 3, note: texts[2] }] },
    ],
  });
  assert.doesNotMatch(JSON.parse(calls[2].init.body).description, /Pinned with C/,
    'the words only: no sentence about where the pin was');
  assert.deepEqual(JSON.parse(calls[2].init.body).screenshotPins, [
    { id: 'a'.repeat(32), x: 0.1, y: 0.2, n: 1, note: 'The Join button is too small' },
    { id: 'a'.repeat(32), x: 0.3, y: 0.4, n: 2, note: 'Pace should say min per km' },
    { id: 'b'.repeat(32), x: 0.5, y: 0.6, n: 3, note: 'And the list wraps' },
  ]);
  assert.equal(post.MAX_COMMENTS, feedbackRoute.MAX_PINS_PER_ISSUE, 'the box stops where the server does');
}));

test('a refusal with a reason stays in the box; failures hand the comment to the dialog', async () => {
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 400, body: { error: 'Too long.' } }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: false, error: 'Too long.' });
  });
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 503 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([new TypeError('Failed to fetch')], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([{ status: 502 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true }, 'the picture upload failing too');
  });
});

test('handing over opens the dialog with the words, the pictures, the pin, the title, Kudos and the destination', () => {
  const prev = globalThis.window;
  let got = null;
  globalThis.window = { App: { openFeedbackModal: (opts) => { got = opts; } } };
  try {
    post.handOver({ ...base, target: 'platform' });
    assert.deepEqual(got, { target: 'platform', description: 'Make it bigger', screenshots: [{ blob }] });
    post.handOver(full);
  } finally {
    globalThis.window = prev;
  }
  assert.deepEqual(got, {
    target: 'app',
    description: 'Make the Join   button\nbigger',
    // #6485: the app the person picked travels with the words, so the form
    // files there even with no app tab open behind it.
    appSlug: 'demo',
    screenshots: [{ blob, pins: [{ x: 0.25, y: 0.5, n: null, note: 'Make the Join button bigger' }] }, { blob: imageA }, { blob: imageB }],
    title: 'Bigger Join button',
    bounty: true,
  });

  const fc = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.match(fc, /if \(opts\.target === 'platform'\) setFeedbackTarget\('platform'\);/);
  assert.match(fc, /feedbackText\.value = typed \? `\$\{typed\}\\n\\n\$\{opts\.description\}` : opts\.description;/,
    'added after anything already typed, never over it');
  assert.match(fc, /void attachScreenshotBlob\(handed\.blob, Array\.isArray\(handed\.pins\) \? handed\.pins : null\);/, 'each picture, its pins beside it');
  assert.match(fc, /feedbackTitle\.value = opts\.title\.trim\(\)\.slice\(0, 200\);\s*titleDirty = true;/,
    'the title the box showed is kept, not dropped as a stale suggestion');
  // #5249: honoured only while kudos is not parked.
  assert.match(fc, /if \(opts\.bounty === true && !KUDOS_PARKED && !bountyCheckbox\.disabled\) bountyCheckbox\.checked = true;/);
  // The form sends the pins beside the pictures it was handed with.
  assert.match(fc, /const pinned = screenshots\.filter\(\(shot\) => shot\.id && shot\.pins && shot\.pins\.length\)\s*\.flatMap\(/);
  assert.match(fc, /if \(pinned\.length\) body\.screenshotPins = pinned;/);
});

// #6485: the destination the person picked is the app the form files on, so
// the hand-over carries the app itself — its address and the name the box
// showed — and the form's own row names that app.
test('the hand-over carries the picked app, and only when the app is the destination', () => {
  assert.deepEqual(post.handOverOptions({ ...base, appName: 'Inbox' }), {
    target: 'app',
    description: 'Make it bigger',
    appSlug: 'demo',
    appName: 'Inbox',
    screenshots: [{ blob }],
  });
  assert.deepEqual(post.handOverOptions({ ...base, target: 'platform', appName: 'Inbox' }), {
    target: 'platform',
    description: 'Make it bigger',
    screenshots: [{ blob }],
  }, 'Homeroom takes no app with it');
  assert.equal(post.handOverOptions({ ...base, appSlug: null }).appSlug, undefined, 'nor an app with no address');
});

// ── 2b. The pin as data (#4482) ───────────────────────────────────────

const pinData = loadTsx('frontend/src/features/comment-pin/pin-data.ts');
const feedbackRoute = require('../src/routes/feedback.js');

test('the server writes the pin onto its picture\'s link by the rule the page reads it back with', () => {
  const notes = [
    'Make it bigger',
    'Join (the button) & the #list, 100% wider! *really*',
    'Préférences: “quotes” and 日本語 and 🏃‍♀️',
    '  spaced\n\n  out  ',
    'x'.repeat(400),
    '日本語'.repeat(120),
    '',
  ];
  for (const note of notes) {
    const pin = { x: 0.123456, y: 0.98765, note };
    assert.equal(feedbackRoute.pinFragment(pin), pinData.pinFragment(pin), `the same fragment for ${JSON.stringify(note.slice(0, 20))}`);
    const back = pinData.readPin(`https://app.onhomeroom.com/issue-images/${'a'.repeat(32)}${feedbackRoute.pinFragment(pin)}`);
    assert.deepEqual(back, { x: 0.1235, y: 0.9877, note: pinData.fitNote(note) });
    assert.ok(feedbackRoute.pinFragment(pin).length <= 40 + pinData.NOTE_ENCODED_MAX, 'inside the body\'s reserve');
    assert.doesNotMatch(feedbackRoute.pinFragment(pin), /[()\s]/, 'safe inside Markdown\'s parentheses');
  }
  assert.equal(pinData.readPin('https://x/issue-images/abc'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=1.2,0.5'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=-0.1,0.5'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=a,b'), null);
});

test('a post may pin its own screenshots, on the picture, with words and numbers', () => {
  const id = 'a'.repeat(32);
  const ok = feedbackRoute.parseScreenshotPins({ screenshotPins: [{ id, x: 0, y: 1, note: 'Here' }] }, [id]);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.pins], [[id, [{ x: 0, y: 1, n: null, note: 'Here' }]]]);
  assert.deepEqual(feedbackRoute.parseScreenshotPins({}, [id]), { ok: true, pins: new Map() });
  const refuse = (pins, ids = [id]) => feedbackRoute.parseScreenshotPins({ screenshotPins: pins }, ids).ok;
  assert.equal(refuse('nope'), false);
  assert.equal(refuse([{ id: 'b'.repeat(32), x: 0.5, y: 0.5 }]), false, 'not one of the attached screenshots');
  assert.equal(refuse([{ id, x: 1.5, y: 0.5 }]), false, 'off the picture');
  assert.equal(refuse([{ id, x: Number.NaN, y: 0.5 }]), false);
  assert.equal(refuse([{ id, x: '0.5', y: 0.5 }]), false);
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, note: 7 }]), false);
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, n: 0 }]), false, 'a number counts from 1');
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, n: 1.5 }]), false);
  assert.equal(feedbackRoute.MAX_PINS_PER_ISSUE, 8);
  assert.equal(refuse(Array.from({ length: 9 }, (_, i) => ({ id, x: 0.1, y: 0.1, n: i + 1 }))), false, 'eight pins at most');
  const several = feedbackRoute.parseScreenshotPins({ screenshotPins: [
    { id, x: 0.1, y: 0.2, n: 1, note: 'One' }, { id, x: 0.3, y: 0.4, n: 2, note: 'Two' },
  ] }, [id]);
  assert.equal(feedbackRoute.buildScreenshotsEmbed([id], 'd', several.pins),
    `\n\n**Screenshot:**\n![Screenshot](https://d/issue-images/${id}#pin=0.1,0.2&n=1&note=One&pin=0.3,0.4&n=2&note=Two)`);
  // Eight long notes share the reserve: the whole fragment stays inside it.
  const eight = feedbackRoute.parseScreenshotPins({ screenshotPins: Array.from({ length: 8 }, (_, i) => ({
    id, x: 0.123456, y: 0.654321, n: i + 1, note: '日本語'.repeat(100),
  })) }, [id]);
  const embed = feedbackRoute.buildScreenshotsEmbed([id, 'b'.repeat(32), 'c'.repeat(32)], 'app.onhomeroom.com', eight.pins);
  assert.ok(embed.length < 1536 - 400, `the embed (${embed.length}) leaves the reserve room for the route's other lines`);
  assert.deepEqual(pinData.readPins(embed.match(/\((https:[^)]+)\)/)[1]).map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8]);

  const one = feedbackRoute.buildScreenshotsEmbed([id], 'app.onhomeroom.com', ok.pins);
  assert.equal(one, `\n\n**Screenshot:**\n![Screenshot](https://app.onhomeroom.com/issue-images/${id}#pin=0,1&note=Here)`);
  const two = feedbackRoute.buildScreenshotsEmbed(['c'.repeat(32), id], 'app.onhomeroom.com', ok.pins);
  assert.match(two, new RegExp(`!\\[Screenshot 1\\]\\(https://app\\.onhomeroom\\.com/issue-images/${'c'.repeat(32)}\\)`), 'only the pinned one carries it');
  assert.match(two, new RegExp(`!\\[Screenshot 2\\]\\(https://app\\.onhomeroom\\.com/issue-images/${id}#pin=0,1&note=Here\\)`));
  assert.equal(feedbackRoute.buildScreenshotsEmbed([id], 'd'), feedbackRoute.buildScreenshotEmbed(id, 'd'), 'no pins, the lines as they were');
  const route = read('src/routes/feedback.js');
  assert.match(route, /const parsedPins = parseScreenshotPins\(req\.body, screenshotIds\);\s*if \(!parsedPins\.ok\) return res\.status\(400\)/,
    'checked before anything is filed');
  assert.match(route, /buildScreenshotsEmbed\(screenshotIds, require\('\.\.\/services\/caddy'\)\.USERNODE_DOMAIN, parsedPins\.pins\)/);
});

// ── 3. The app's picture ──────────────────────────────────────────────

const PLATFORM = 'https://app.onhomeroom.com';

function snapshotHarness({ config = { platform_origin: PLATFORM }, top = false, appSnapdom } = {}) {
  const posted = [];
  const injected = [];
  const captures = [];
  let onMessage = null;
  const canvas = { toBlob(cb, type) { cb({ fake: 'blob', type }); } };
  const window = {
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 700,
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; },
    fetch: async (url) => ({ ok: !!config, json: async () => config, url }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 251, 230)' }),
  };
  if (appSnapdom !== undefined) window.snapdom = appSnapdom;
  const parent = { postMessage(message, origin) { posted.push({ message, origin }); } };
  window.parent = top ? window : parent;
  const document = {
    head: { appendChild(s) { injected.push(s); s.parentNode = this; } },
    documentElement: {},
    body: { tag: 'body' },
    createElement: () => ({ remove() {} }),
    elementFromPoint: (x, y) => ({ tagName: 'DIV', id: 'row-19', textContent: `Row at ${x},${y}`, getAttribute: () => null }),
  };
  document.head.removeChild = () => {};
  const location = { pathname: '/lists/7', search: '?token=secret' };
  vm.runInNewContext(SNAPSHOT, { window, document, location, Promise, URL, String, Math, Number, Object, isFinite });
  const fakeLib = async (el, opts) => {
    captures.push({ el, opts });
    return { toCanvas: async () => canvas };
  };
  return {
    installed: () => !!onMessage,
    ask(data, origin = PLATFORM, source = parent) { onMessage({ source, origin, data }); },
    loadLibrary() {
      const s = injected.at(-1);
      window.snapdom = fakeLib;
      s.onload();
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
    posted, injected, captures, window,
  };
}

test('only the platform\'s own origin gets the app\'s picture, and the reply goes to it alone', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'p1', scale: 2, x: 40, y: 30 });
  await h.flush(); await h.flush();
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].src, '/usernode-bridge/v1/snapdom.js', 'the hosted copy, from this origin');
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].el.tag, 'body');
  assert.deepEqual({ ...h.captures[0].opts.clip }, { x: 0, y: 700, width: 800, height: 600 }, 'what is on screen, at its scroll');
  assert.equal(h.captures[0].opts.scale, 2);
  assert.equal(h.captures[0].opts.dpr, 1, 'the scale is not multiplied by the pixel ratio twice');
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM, 'posted to the platform, never "*"');
  const m = h.posted[0].message;
  assert.equal(m.__usernode_snapshot, 'picture');
  assert.equal(m.id, 'p1');
  assert.equal(m.blob.type, 'image/png');
  assert.equal(m.path, '/lists/7', 'the path, never the query that carries the token');
  assert.equal(m.at.id, 'row-19');
  assert.equal(m.at.text, 'Row at 40,30');
  assert.equal(h.window.snapdom, undefined, 'the library\'s global is gone again');
});

test('anyone else framing the app gets nothing back, not even a refusal', async () => {
  const other = snapshotHarness();
  other.ask({ __usernode_snapshot: 'render', id: 'e1' }, 'https://evil.example');
  for (let i = 0; i < 5; i++) await other.flush();
  assert.equal(other.injected.length, 0, 'nothing is even loaded');
  assert.equal(other.posted.length, 0);

  const notParent = snapshotHarness();
  notParent.ask({ __usernode_snapshot: 'render', id: 'e2' }, PLATFORM, { some: 'other window' });
  for (let i = 0; i < 5; i++) await notParent.flush();
  assert.equal(notParent.posted.length + notParent.injected.length, 0);

  for (const config of [{ platform_origin: 'http://app.onhomeroom.com' }, { platform_origin: 'https://u:p@app.onhomeroom.com' }, null, {}]) {
    const h = snapshotHarness({ config });
    h.ask({ __usernode_snapshot: 'render', id: 'c1' }, config && config.platform_origin ? new URL(config.platform_origin).origin : PLATFORM);
    for (let i = 0; i < 5; i++) await h.flush();
    assert.equal(h.posted.length + h.injected.length, 0, `refused: ${JSON.stringify(config)}`);
  }

  assert.equal(snapshotHarness({ top: true }).installed(), false, 'a top-level page installs nothing');
});

test('an app\'s own window.snapdom is put back as it was', async () => {
  const mine = function appOwn() {};
  const h = snapshotHarness({ appSnapdom: mine });
  h.ask({ __usernode_snapshot: 'render', id: 'k1', scale: 1 });
  for (let i = 0; i < 3; i++) await h.flush();
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1, 'the bridge drew with the library it loaded');
  assert.equal(h.window.snapdom, mine);
});

test('a library that will not load is answered with an error, to the platform', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'f1' });
  for (let i = 0; i < 3; i++) await h.flush();
  h.injected[0].onerror();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM);
  assert.match(h.posted[0].message.error, /did not load/);
});

// ── 4. The seams ──────────────────────────────────────────────────────

test('the drawing library is the pinned copy, recorded in the vendor README, served to apps', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'public/usernode-bridge/v1/snapdom.js'));
  const digest = crypto.createHash('sha384').update(bytes).digest('base64');
  assert.equal(digest, 'X1VJfUghgBqHQ1Y6iba5l0ab1AuLfNDhnTt/tiVjeokfy/D/UGmvEiAOQ6fcj1AS');
  assert.ok(read('scripts/vendor-assets.js').includes(digest), 'pinned in the vendoring script');
  assert.ok(read('public/vendor/README.md').includes(digest), 'recorded in the README');
  assert.match(bytes.toString('utf8', 0, 80), /SnapDOM\s*\n\* v3\.1\.1/);
  assert.equal(read('frontend/src/features/comment-pin/picture.ts').match(/LIB_SRC = '([^']+)'/)[1], '/usernode-bridge/v1/snapdom.js');
  assert.match(SNAPSHOT, /var LIB_SRC = "\/usernode-bridge\/v1\/snapdom\.js";/);
});

test('comment mode opens on demand into a host of its own, once, and C asks it to leave', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /mountLegacyPortal\(host, createElement\(CommentMode,/);
  assert.match(src, /if \(openHost \|\| typeof document === 'undefined'\) return;/, 'never a second layer');
  assert.match(src, /if \(openHost\) \{\s*if \(controller\) controller\.exit\(\);/, 'C again is Done');
  // Done keeps words nobody has posted: it asks first, and so do the box's ✕ and Esc.
  assert.match(src, /const unposted = draft \? !draft\.sending && hasWords\(draft\) : !!carry\?\.text\?\.trim\(\);\s*if \(unposted\) \{\s*setConfirm\('exit'\);/);
  assert.match(src, /if \(hasWords\(draft\)\) setConfirm\('discard'\);\s*else discard\(\);/);
  // The box is a dialog while it is up, so a C typed elsewhere stacks nothing on it.
  assert.match(src, /id="comment-pin-box"\s+role="dialog"/);
  // Each picture is drawn without the layer: no marker is ever in one.
  assert.match(src, /const promise = takeBase\(\{\s*host,/);
  // Posted clean, each picture's pins beside it, numbered when there are
  // several. A cropped picture's pins map into the crop first (#4977), and a
  // pin the crop cut away does not post.
  assert.match(src, /\.map\(\(\{ c, i, at \}\) => \(\{ x: at!\.x, y: at!\.y, n: many \? i \+ 1 : null, note: c\.text\.trim\(\) \}\)\);/);
  assert.match(src, /if \(blob\) shots\.push\(\{ blob, pins \}\);/);
  // A comment on the same view shares the earlier picture; another view is
  // another picture, while there is room. A cropped picture is shared only
  // when the new pin's spot survived the crop (#4977).
  assert.match(src, /const same = d\.pictures\.find\(\(pic\) => pic\.view === view\.current && pic\.screen === routeOf\(\)\s*&& pic\.base !== null && \(!pic\.cut \|\| pinInCrop\(pin, pic\.cut\.rect\) !== null\)\);/);
  assert.match(src, /if \(inUse \+ d\.images\.length >= MAX_PICTURES\) return \{ pictures: d\.pictures, picture: null \};/);
  // Kudos is one line that says who it is for.
  assert.match(src, />\{t\('devchat:commentPin\.kudos\.label'\)\}</);
  assert.equal(message('devchat:commentPin.kudos.label'), 'Kudos for whoever solves it');
  // #5249: and not drawn at all while kudos is parked; nothing the box sends
  // or restores carries a kudos then.
  assert.match(src, /import \{ KUDOS_PARKED \} from '\.\.\/leaderboard\/kudos-parked';/);
  assert.match(src, /\{KUDOS_PARKED \? null : <button\s+type="button"\s+id="comment-pin-kudos"/);
  assert.match(src, /bounty: !KUDOS_PARKED && d\.kudos && budget\.remaining !== 0,/);
  assert.match(src, /kudos: !KUDOS_PARKED && !!c\?\.bounty,/);
  // The bar: moved by its handle (four arrows, a move cursor); it starts at
  // the foot every time (#4541, the device no longer keeps where it was left)
  // and never hides on its own.
  assert.doesNotMatch(src, /usernode:comment-bar|savedBarAt|saveBarAt/, 'no saved bar position');
  assert.match(src, /const \[barAt, setBarAt\] = useState<Point \| null>\(null\);/);
  assert.match(src, /<ArrowsMoveIcon className="h-4 w-4" \/>/);
  assert.match(src, /cursor-move touch-none/);
  assert.match(src, /onDoubleClick=\{\(\) => \{ setBarAt\(null\); \}\}/);
  assert.doesNotMatch(src, /DUCK_AFTER_MS|ducked|onBarEnter/, 'resting the pointer on the bar never hides it');
  // One label that says what to do (#4541): not the mode's name plus a second hint.
  assert.match(src, /: t\('devchat:commentPin\.hint\.start'\);/);
  assert.equal(message('devchat:commentPin.hint.start'), 'Tap anywhere to suggest an improvement');
  assert.doesNotMatch(src, />Comment mode</);
  assert.doesNotMatch(src, />\{t\('devchat:commentPin\.bar\.label'\)\}</);
  assert.doesNotMatch(src, /Click anything to comment on it/);
  assert.doesNotMatch(read('frontend/locales/en/devchat.json'), /Click anything to comment on it/);
  assert.match(src, /aria-label=\{t\('devchat:commentPin\.bar\.label'\)\}/, 'the bar keeps its screen-reader name');
  assert.equal(message('devchat:commentPin.bar.label'), 'Comment mode');
  // A first-use note, once per device, that says how it works and that the
  // Form switch goes back to the form (#4541).
  assert.match(src, /const INTRO_KEY = 'usernode:comment-intro-seen';/);
  assert.match(src, />\{t\('devchat:commentPin\.intro\.title'\)\}</);
  assert.equal(message('devchat:commentPin.intro.title'), 'How comment mode works');
  assert.match(src, />\{t\('devchat:commentPin\.intro\.gotIt'\)\}</);
  assert.equal(message('devchat:commentPin.intro.gotIt'), 'Got it');
  assert.match(src, /<li>\{t\('devchat:commentPin\.intro\.form'\)\}<\/li>/);
  assert.equal(message('devchat:commentPin.intro.form'), 'Prefer the form? Tap Form to switch back at any time.');
  // A finger: a tap is a comment, a drag does nothing.
  assert.match(src, /if \(!t\.moved\) place\(\{ x: e\.clientX, y: e\.clientY \}\);/);
  // The form is called the form.
  assert.doesNotMatch(src, /Detailed/);
  assert.doesNotMatch(JSON.stringify(Object.entries(JSON.parse(read('frontend/locales/en/devchat.json')))
    .filter(([key]) => key.startsWith('commentPin.')).map(([, entry]) => entry.text)), /Detailed/);
  assert.doesNotMatch(read('frontend/src/features/dialogs/feedback.tsx'), />\s*Detailed\s*</);
  // The dialog's rule for when a request can go to the app, read the same way.
  // #5940: any repository address with an owner and a name, not only
  // github.com (app repositories are on Homeroom's own git host now). One
  // shared helper, run against the server's rule in
  // tests/repo-address-table.test.js (#6016).
  assert.ok(src.includes(`!isRepoAddress(data.repo_url) || data.self_hosted`));
  assert.ok(read('frontend/src/features/dialogs/feedback-controller.js').includes(`const hasRepo = isRepoAddress(appData?.repo_url);`));
  assert.doesNotMatch(src, /github\\\.com/);
});

test('posting a comment shows a sent card on the screen (#5008), not only the toast', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  // Send success marks the request sent; the toast stays as it was.
  assert.match(src, /setSent\(d\.key\);/);
  assert.match(src, /toast\(kudosLine \? t\('devchat:commentPin\.toast\.sentences'/);
  // Typing the next comment stands the card down, and stays down after.
  assert.match(src, /useEffect\(\(\) => \{\s*if \(hasWords\(draft\)\) setSent\(null\);\s*\}, \[draft\]\);/);
  // The card: where it went in the marker's own words, the request's title,
  // "View request" behind the post's link, and a close button. No hiding at
  // any width: phones show it too, unlike the bar's posted chip.
  assert.match(src, /aria-label=\{t\('devchat:commentPin\.sent\.label'\)\}/);
  assert.match(src, /\{placeOf\(sentRequest\)\}/);
  assert.match(src, /sentRequest\.title \? <p/);
  assert.match(src, /sentRequest\.href \? \(\s*<a\s+href=\{sentRequest\.href\}\s+onClick=\{\(\) => onClose\(\)\}/);
  assert.match(src, /devchat:commentPin\.card\.open/, 'the marker card\'s own words for the link');
  assert.match(src, /sentRequest && !shotIntro && !cropping && !hasWords\(draft\) \? \(/, 'up while the next draft has no words');
  const cardStart = src.indexOf('data-comment-pin-sent');
  const cardClass = src.slice(src.indexOf('className="', cardStart), src.indexOf('"', src.indexOf('className="', cardStart) + 12));
  assert.doesNotMatch(cardClass, /md:inline|hidden|sm:/, 'visible at every width');
  assert.match(cardClass, /bg-white p-3 .* ring-1 ring-black\/10/, 'the marker card\'s own card');
  assert.match(src.slice(cardStart, src.indexOf(') : null}', cardStart)), /\$\{PIN_SHAPE\} bg-violet-600/, 'the posted markers\' own disc');
  assert.equal(message('devchat:commentPin.sent.label'), 'Request posted');
  assert.match(src, /CheckIcon/, 'a check says it went through');
});
