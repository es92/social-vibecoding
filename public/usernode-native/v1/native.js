/**
 * usernode-native v1 — native.js
 *
 * The behavior half of the Usernode native-feel UI kit. Centrally hosted
 * (like usernode-bridge.js) at:
 *
 *   https://<USERNODE_DOMAIN>/usernode-native/v1/native.js
 *
 * Canonical source: social-vibecoding/public/usernode-native/v1/native.js.
 * Never vendor per app; load the hosted URL. /v1/ is a frozen API surface —
 * additive changes ship in place, breaking changes bump to /v2/.
 *
 * Load together with native.css. Exposes `window.unNative`:
 *
 *   unNative.platform                 — 'ios' | 'android' | 'desktop'
 *   unNative.presets                  — named spring presets (tunable)
 *   unNative.spring(target, opts)     — rAF spring integrator
 *   unNative.attachSwipeActions(row, {actions}) — swipe-to-act list rows
 *   unNative.attachPullToRefresh(scrollEl, onRefresh, opts?) — pull-to-refresh
 *                                        (element container OR the window
 *                                        scroller; the puck hangs BELOW the
 *                                        app header — opts.topEl / opts.top
 *                                        anchor it under a fixed one —
 *                                        resting FULLY below that anchor
 *                                        line with equal space above and
 *                                        below, and lingers briefly once
 *                                        onRefresh settles. Opt-in
 *                                        opts.pullProperty publishes the
 *                                        pull as a CSS custom property
 *                                        instead of moving the scroller,
 *                                        for chrome inside it that holds
 *                                        still. Returns
 *                                        { detach(), refresh() }; never
 *                                        throws on bad input)
 *   unNative.attachGridPlacement(listEl, opts) — free-form placement on a
 *     fixed grid (drop anywhere, holes allowed — the homescreen model;
 *     cellFromPoint(x, y, info) gets the dragged tile's live rect/centre in
 *     `info`, so the target can be resolved from the TILE, not the finger)
 *   unNative.attachReorder(listEl, opts) — drag-to-reorder lists (long-press
 *                                        lift on touch, handle/pointer drag on
 *                                        desktop, overlay drop indicator,
 *                                        edge auto-scroll, spring settle)
 *   unNative.transition(fn, {type})   — screen transitions. 'push' | 'pop'
 *                                        | 'none' wrap fn in a View
 *                                        Transition; 'zoom-in' | 'zoom-out'
 *                                        play the iOS-homescreen expand /
 *                                        collapse out of a tile ({ el,
 *                                        fromEl | fromRect, after?,
 *                                        fallback?, duration? } — fn
 *                                        reveals the
 *                                        incoming screen, `after` conceals
 *                                        the outgoing one; the LIVE el is
 *                                        transform-animated, no snapshot)
 *   unNative.presentSheet(opts)       — bottom sheet (drag-to-dismiss;
 *                                        content rendered AFTER present is
 *                                        re-measured and the entrance
 *                                        spring retargeted — no pop-in)
 *   unNative.presentModal(opts)       — centered modal card, arbitrary content
 *   unNative.presentPanel(opts)       — side drawer / panel sliding in from
 *                                        the right (or left) edge
 *                                        ({ side?, content | contentEl,
 *                                        width?, onDismiss? }): full-height
 *                                        surface, spring in/out, backdrop
 *                                        tap / Escape dismiss. NOT
 *                                        draggable by design — a nav
 *                                        drawer is not a bottom sheet
 *   unNative.actionSheet(opts)        — iOS action sheet, Promise-based
 *   unNative.alert(opts)              — iOS alert dialog, Promise-based
 *   unNative.popover(opts)            — anchored popover / dropdown menu
 *                                        ({ anchorEl | anchorRect, items |
 *                                        contentEl, placement? }): flip/
 *                                        clamp positioning, outside-click/
 *                                        Escape/scroll dismissal, menu
 *                                        focus handling. Items mode
 *                                        resolves a Promise (with a
 *                                        .dismiss() attached); content
 *                                        mode returns { dismiss(), el }
 *   unNative.menu(opts)               — adaptive menu: action sheet on
 *                                        touch, anchored popover on
 *                                        desktop — one actionSheet-shaped
 *                                        call site serves both idioms
 *   unNative.toast(message, opts?)    — transient status toast / snackbar
 *                                        ({ duration?, action?, priority?,
 *                                        error?, dismissible?,
 *                                        onClose?(reason) }; a priority
 *                                        toast holds the slot for undo
 *                                        flows; a long message stays
 *                                        longer and taps away)
 *   unNative.attachNavBar(bar, opts)  — blurred nav bar + large-title collapse
 *   unNative.attachKeyboardAvoidance(scrollEl, opts) — keyboard avoidance
 *                                        for a fixed-shell app's content
 *                                        scroller ({ topEl?, margin?,
 *                                        fields? }): instant clearance
 *                                        padding, single-motion focus
 *                                        reveal, settled pin
 *   unNative.gestures                 — the shared gesture arbiter
 *                                        { claim, owner, release }
 *   unNative.physics                  — the pure math (also the node export)
 *
 * On mobile the kit also maintains `--un-kb-inset` on <html> (the
 * on-screen-keyboard occlusion, tracked via visualViewport while a text
 * field is focused) plus class
 * `un-kb` while it is non-zero, so sheets / action sheets / modals /
 * alerts ride above the keyboard out of the box. Apps may consume the
 * var for their own fixed bottom bars. No-op on desktop.
 *
 * On mobile a tap outside a focused text field also closes the keyboard
 * (blurs the field), as Chrome on Android already does and iOS does not.
 * Taps on fields, controls (buttons, links, labels, ARIA widget roles,
 * `.un-pressable`) and anything inside `[data-keep-keyboard]` keep it;
 * `data-un-keyboard-dismiss="off"` on <html> or <body> turns it off.
 * With a frame focused (the platform shell around an app), the same tap
 * on the page around it posts `{ __usernode_keyboard: 'dismiss' }` to the
 * frame, and the kit in a frame blurs its own field when that message
 * comes from its parent window (its own opt-out still holds). A frame its
 * parent marks `data-un-keyboard-relay` (the shell's side panel, a page of
 * the same origin) runs it the other way: a dismissing tap in there with
 * no field of its own posts `{ __usernode_keyboard: 'tap' }` up, and the
 * parent applies its own rule as if the tap had landed on it.
 *
 * A presented sheet or side panel also carries `--un-presence` on its own
 * element: 1 at rest, 0 off-screen, and 1:1 with the finger in between,
 * the same number the backdrop's opacity is driven from. Nothing in
 * native.css reads it; it exists so a host stylesheet can tie a treatment
 * of its own to the slide (the platform shell casts the modal dim from the
 * surface rather than the backdrop, so its frosted panes never sample a
 * dimmed page). Apps that ignore it render exactly as before.
 *
 * Fidelity requirements this file implements (binding; see the kit section
 * of app-conventions.md): 1:1 finger tracking after intent lock, gestures
 * interruptible mid-spring at current position+velocity, commit-vs-cancel
 * by projected momentum (not just distance), spring physics for every
 * gesture release (no duration+bezier), destructive actions fire only on
 * gesture end, high-frequency UI gets no animation.
 *
 * In Node (unit tests) requiring this file exports { physics } and touches
 * no DOM.
 */
(function (global) {
  'use strict';

  /* ────────────────────────────────────────────────────────────────────
   * Physics — pure functions, no DOM. Unit-tested in
   * tests/native-kit.test.js via `require(...).physics`.
   * ──────────────────────────────────────────────────────────────────── */

  // Named spring presets (mass / tension / friction, per Comeau's damped
  // harmonic oscillator model). Tuned on-device via the demo page's
  // ?un-tune=1 overlay; the CSS linear() curves in native.css are
  // pre-computed from default/stiff/gentle so JS and CSS motion match.
  // `sheet` drives bottom/action sheet presentation only (issue #769:
  // snappier tray open/close) — it is JS-driven end to end, so no CSS
  // linear() curve is derived from it.
  var PRESETS = {
    default: { mass: 1, tension: 170, friction: 26 },
    stiff: { mass: 1, tension: 250, friction: 30 },
    gentle: { mass: 1, tension: 120, friction: 24 },
    sheet: { mass: 1, tension: 380, friction: 34 },
  };

  // iOS-style deceleration rate, per millisecond.
  var DECEL_RATE = 0.998;

  // Rest thresholds: a spring is settled when both are under these.
  var REST_VELOCITY = 0.004; // px per ms (= 4 px/s)
  var REST_DELTA = 0.4; // px

  var STEP_MS = 1; // fixed integration timestep

  // One fixed-timestep integration step of a damped harmonic oscillator.
  // state: { x, v } with x in px and v in px/ms. Mutates and returns state.
  function springStep(state, target, params, dtMs) {
    var dt = (dtMs == null ? STEP_MS : dtMs) / 1000; // seconds
    var vSec = state.v * 1000; // px/s for the classic tension/friction units
    var a = (-params.tension * (state.x - target) - params.friction * vSec) / params.mass;
    vSec += a * dt;
    state.x += vSec * dt;
    state.v = vSec / 1000;
    return state;
  }

  function isAtRest(state, target) {
    return Math.abs(state.v) < REST_VELOCITY && Math.abs(state.x - target) < REST_DELTA;
  }

  // A DISMISSAL IS DONE WHEN THE SURFACE IS OFF-SCREEN, not when its spring
  // is at rest. The rest thresholds above are for a surface you can see: an
  // entrance has to land on its pixel. An exit's target is the position
  // where the surface has just left the screen, and the underdamped `sheet`
  // preset spent another ~200ms there settling an overshoot nobody could
  // see, holding back teardown, onDismiss and an action sheet's handler
  // (Messages' "+" → New message started ~0.5s after the tap). So an exit
  // finishes once the surface is within EXIT_DELTA of its target along the
  // way it is travelling, or past it, while moving toward it (or already
  // there); `from` fixes that direction. Entrances keep isAtRest.
  var EXIT_DELTA = 1; // px

  function isExitDone(state, from, target) {
    var dir = target > from ? 1 : (target < from ? -1 : 0);
    return (target - state.x) * dir < EXIT_DELTA && state.v * dir >= 0;
  }

  // How much time a runtime spring integrates on an animation frame. The
  // clock starts on the FIRST frame, not when the spring is created: a tap
  // handler that does real work after presenting a sheet used to hand the
  // first frame up to 64ms of integration, so the sheet's first painted
  // position was already part-way up. The first frame advances one nominal
  // frame; later ones the real gap, clamped so a background tab or a long
  // task cannot make the spring jump.
  var FRAME_MS = 1000 / 60;
  var MAX_FRAME_GAP_MS = 64;

  function springFrameDelta(now, last) {
    if (last == null) return FRAME_MS;
    return Math.min(now - last, MAX_FRAME_GAP_MS);
  }

  // Run a spring to rest synchronously (tests, curve pre-computation).
  // Returns { x, v, durationMs, samples: [{t, x}] }. Hard cap keeps a
  // mis-tuned preset from hanging. `exit` ends it where a dismissal would
  // (isExitDone) instead of at rest.
  function simulateSpring(from, to, velocity, params, maxMs, exit) {
    var state = { x: from, v: velocity || 0 };
    var samples = [{ t: 0, x: from }];
    var t = 0;
    var cap = maxMs || 5000;
    while (t < cap) {
      springStep(state, to, params, STEP_MS);
      t += STEP_MS;
      samples.push({ t: t, x: state.x });
      if (isAtRest(state, to) || (exit && isExitDone(state, from, to))) break;
    }
    return { x: state.x, v: state.v, durationMs: t, samples: samples };
  }

  // Momentum projection: where a gesture released at `position` with
  // velocity `velocity` (px/ms) would coast to under standard deceleration.
  // projected = position + velocity * decelRate / (1 - decelRate)
  // Kept exported for compatibility; release decisions now use the bounded
  // projectDisplacement below (the full coast ≈ v·499ms over-weights tiny
  // flicks — issue #690).
  function projectMomentum(position, velocity, decelRate) {
    var d = decelRate == null ? DECEL_RATE : decelRate;
    return position + (velocity * d) / (1 - d);
  }

  // Bounded momentum projection for commit decisions: where the gesture
  // lands within a short horizon (default COMMIT_HORIZON_MS, tunable via
  // the ?un-tune=1 overlay). Matches the reference rebuild's x + v·0.12s.
  function projectDisplacement(position, velocity, horizonMs) {
    var h = horizonMs == null ? physics.COMMIT_HORIZON_MS : horizonMs;
    return position + velocity * h;
  }

  // Release velocity from a short pointer-sample history. samples is an
  // array of { t (ms), x (px) } in time order; only the trailing
  // `windowMs` (default 100) participates. Returns px/ms (0 if unknowable).
  function estimateVelocity(samples, windowMs) {
    if (!samples || samples.length < 2) return 0;
    var win = windowMs == null ? 100 : windowMs;
    var last = samples[samples.length - 1];
    var first = null;
    for (var i = 0; i < samples.length; i++) {
      if (last.t - samples[i].t <= win) { first = samples[i]; break; }
    }
    if (!first || first === last || last.t === first.t) return 0;
    return (last.x - first.x) / (last.t - first.t);
  }

  // iOS-style rubber-band resistance: asymptotically approaches `limit`,
  // with initial slope `coeff`. Sign-preserving.
  function rubberband(distance, limit, coeff) {
    var c = coeff == null ? 0.55 : coeff;
    var d = Math.abs(distance);
    var out = (1 - 1 / ((d * c) / limit + 1)) * limit;
    return distance < 0 ? -out : out;
  }

  // Inverse of rubberband (same limit/coeff): recovers the raw drag
  // distance that produced a displayed offset. Used to re-enter a drag
  // mid-settle without a position jump.
  function rubberbandInvert(display, limit, coeff) {
    var c = coeff == null ? 0.55 : coeff;
    var y = Math.min(Math.abs(display), limit * 0.999);
    var d = (y * limit) / (c * (limit - y));
    return display < 0 ? -d : d;
  }

  // Axis intent lock: null until movement exceeds `threshold` px on some
  // axis, then 'x' or 'y' — decided once, at lock time.
  function lockIntent(dx, dy, threshold) {
    var t = threshold == null ? 10 : threshold;
    if (Math.abs(dx) < t && Math.abs(dy) < t) return null;
    return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  }

  // Swipe-row release decision. x is the row's current offset (<= 0 when
  // revealing right-side actions), v the release velocity in px/ms.
  // Returns 'commit' | 'open' | 'close'. Commit only when the row has a
  // destructive full-swipe action (canCommit).
  function decideSwipeRelease(input) {
    var projected = projectDisplacement(input.x, input.v, input.horizonMs);
    if (input.canCommit && projected <= -0.6 * input.rowWidth) return 'commit';
    if (projected <= -0.5 * input.trayWidth) return 'open';
    return 'close';
  }

  // Pull-to-refresh release decision: commit on displayed distance OR on
  // projected momentum crossing the threshold (a fast short yank counts).
  function decidePtrRelease(input) {
    if (input.pull >= input.threshold) return true;
    return projectDisplacement(input.pull, input.v, input.horizonMs) >= input.threshold;
  }

  /* ── Pull-to-refresh geometry ─────────────────────────────────────────
   * Above the Node cut on purpose: the puck's resting pose is arithmetic,
   * and issue #1526 (a quarter of the spinner sliced off by the header's
   * edge for two releases) went unnoticed precisely because these numbers
   * lived down in the DOM half where no unit test could reach them.
   *
   * Tuning note (v1 in-place fix): the original COEFF 0.4 / THRESHOLD 70
   * pair required ~330px of raw finger travel to arm — more than half a
   * phone screen, so short lists were nearly impossible to refresh. The
   * pair below arms at ~125px of travel (UIRefreshControl territory)
   * while keeping the same asymptote, so a deep pull still saturates at
   * the familiar rubber-band feel.
   */
  var PTR_THRESHOLD = 60; // px of displayed pull that arms a refresh
  var PTR_LIMIT = 150; // rubber-band asymptote
  var PTR_COEFF = 0.8; // initial resistance slope (~dy/1.25)
  var PTR_MIN_HOLD_MS = 500; // spinner floor so instant refreshes still read
  var PTR_SETTLE_HOLD_MS = 500; // linger AFTER onRefresh settles, then retract
  var PTR_LAYER_H = 240; // clip window the puck travels inside

  // The puck's box, mirroring .un-ptr-puck's width/height in native.css
  // (cross-checked by a test — the pose math below is meaningless if the
  // painted box drifts from the constant it is derived from).
  var PTR_PUCK = 34;
  // Breathing room above AND below the puck at rest. Everything else is
  // derived from these two numbers, so the resting state stays balanced
  // by construction rather than by a hand-tuned coefficient.
  var PTR_PUCK_GAP = 14;
  // Where the content holds while refreshing: gap, puck, gap. 62px, just
  // past PTR_THRESHOLD, so the puck rests at full scale and full opacity
  // and the content never springs BACKWARDS on commit.
  var PTR_HOLD = PTR_PUCK + 2 * PTR_PUCK_GAP;
  // Retracted pose: the whole puck sits above the anchor line, where the
  // layer's overflow clip hides it.
  var PTR_PUCK_PARKED = -(PTR_PUCK + 6);
  // Travel per px of pull, solved so ptrPuckOffset(PTR_HOLD) === the gap.
  var PTR_PUCK_TRAVEL = (PTR_PUCK_GAP - PTR_PUCK_PARKED) / PTR_HOLD;

  // The puck's top edge, in px relative to the clip layer's top (= the
  // anchor line). Negative means clipped behind the header — which is the
  // emerge-from-under-the-bar idiom during the drag (the top crosses the
  // line at ~43px of pull) and, at rest, the bug this helper fixed.
  function ptrPuckOffset(pull) {
    return PTR_PUCK_PARKED + pull * PTR_PUCK_TRAVEL;
  }

  // Bottom-sheet release decision. y is the sheet's downward displacement
  // from rest (>= 0), v the release velocity in px/ms (positive = down).
  // Dismiss when the projected landing crosses half the sheet height.
  function decideSheetRelease(input) {
    return projectDisplacement(input.y, input.v, input.horizonMs) >= 0.5 * input.sheetHeight;
  }

  // A vertical drag on a sheet that holds a list: whose is it? The sheet's,
  // unless it began in the list, and then only while the list is at its top
  // and the drag pulls down (an iOS sheet's rule). dy is the drag so far
  // (positive = down); scrollTop is that list's offset, or null when the
  // drag began outside any list.
  function decideSheetDrag(input) {
    if (input.scrollTop == null) return true;
    return input.dy > 0 && input.scrollTop <= 0;
  }

  // Whether a touchmove before the axis lock should be held back from the
  // browser, so a list at its top does not bounce under a pull that is about
  // to become the sheet's. Past a tap's jitter, and mostly downward.
  var SHEET_PULL_SLOP = 3;
  function holdsSheetPull(input) {
    return input.atTop && input.dy > SHEET_PULL_SLOP && input.dy >= Math.abs(input.dx);
  }

  // ── Backdrop dismissal vs. the opening gesture's ghost click ─────────
  //
  // On touch, the tap that PRESENTS an overlay also emits a trailing
  // synthesized `click` roughly 300ms after touchend. It is hit-tested at
  // dispatch time against whatever is under the finger by then — which is
  // the full-screen backdrop this present() just appended. Every backdrop
  // below dismisses on the first click it sees, so a single tap opened
  // and closed the surface again: "it pops up from the bottom for a
  // fraction of a second, then goes away, and I can't click anything".
  //
  // The platform's React dialog layer already documents and guards this
  // exact failure (MODAL_GESTURE_GUARD_MS in
  // frontend/src/lib/static-modal.ts). The kit never got the guard —
  // GHOST_CLICK_MS is deliberately the same 450ms window so the two
  // layers agree about how long a ghost can arrive late.
  var GHOST_CLICK_MS = 450;

  // How far outside a surface's edge a press or click still counts as ON it
  // (#6475). A tap on the card's padding near its edge can be retargeted to
  // the backdrop behind it, and a finger is wider than the point a mouse
  // reports. The platform's React layer keeps the same number in
  // frontend/src/lib/dismiss-edge.ts, which this file cannot import;
  // tests/native-kit.test.js keeps the two equal.
  var DISMISS_EDGE_PX = 8;

  // Whether a backdrop `click` is a real dismissal.
  // input: { pressed, elapsedMs, pointerClick, nearSurface } — `pressed` is
  // true when a pointerdown/touchstart landed on the backdrop itself first
  // (see onBackdropDismiss: the ghost sequence is compatibility MOUSE events
  // synthesized from a touch that landed elsewhere, so it never brings
  // one), `elapsedMs` is the age of the presentation, `nearSurface` is true
  // when the press or click point fell on the surface or within
  // DISMISS_EDGE_PX of its edge, and `pointerClick` is true for a click a
  // pointer produced (`detail > 0`) rather than a programmatic one.
  //
  // A near-surface point is never a dismissal, however it reached the
  // backdrop. Then only the un-pressed click inside the window is a ghost.
  // That keeps a deliberate early backdrop tap instant, keeps a
  // programmatic backdrop.click() working once the window has passed, and
  // refuses a real pointer click that started inside the surface.
  function decideBackdropDismiss(input) {
    if (!input) return true;
    if (input.nearSurface) return false;
    if (input.pressed) return true;
    if (input.pointerClick) return false;
    return input.elapsedMs >= GHOST_CLICK_MS;
  }

  // Top-edge-preserving offset after a presenting/presented bottom-anchored
  // sheet is re-measured (issue #742). A height change of
  // Δ = newHeight - oldHeight instantly moves the sheet's top edge by Δ;
  // shifting the translateY offset by the same Δ keeps the edge visually
  // continuous, so the retargeted spring animates the added (or removed)
  // distance instead of the content popping in.
  function remeasuredSheetY(input) {
    return input.y + (input.newHeight - input.oldHeight);
  }

  // Reorder hit-testing: map a pointer y to a gap index (0..n) over an
  // ordered list of item rects ({ top, bottom }, same coordinate space as
  // pointerY). Inside an item, above the midpoint inserts before it and
  // below inserts after. Outside every item — a section header, deadspace
  // between groups, or past either end — snap to the NEAREST gap, so a
  // header hover means "insert at the top of that section" and deadspace
  // never falls through to "append at the end".
  function reorderDropIndex(pointerY, itemRects) {
    if (!itemRects || !itemRects.length) return 0;
    for (var i = 0; i < itemRects.length; i++) {
      var r = itemRects[i];
      if (pointerY >= r.top && pointerY <= r.bottom) {
        return pointerY < (r.top + r.bottom) / 2 ? i : i + 1;
      }
    }
    var bestIdx = 0;
    var bestDist = Infinity;
    for (var g = 0; g <= itemRects.length; g++) {
      var gy = g === 0
        ? itemRects[0].top
        : g === itemRects.length
          ? itemRects[itemRects.length - 1].bottom
          : (itemRects[g - 1].bottom + itemRects[g].top) / 2;
      var dist = Math.abs(pointerY - gy);
      if (dist < bestDist) { bestDist = dist; bestIdx = g; }
    }
    return bestIdx;
  }

  // Grid-reorder drop side: does a pointer at (x, y) over the hovered
  // tile `rect` ({ left, top, width, height }) mean "insert BEFORE it"
  // or "insert AFTER it" in reading order? Tiles sharing a row with
  // others (width < ~90% of the list) split at the horizontal midpoint;
  // a full-width tile (single-column layout) splits at the vertical
  // midpoint instead. Pure — unit-tested in tests/native-kit.test.js.
  function gridDropSide(rect, listWidth, x, y) {
    var multiCol = rect.width < listWidth * 0.9;
    var before = multiCol
      ? x < rect.left + rect.width / 2
      : y < rect.top + rect.height / 2;
    return before ? 'before' : 'after';
  }

  // Minimum occlusion (px) treated as a real on-screen keyboard. Filters
  // URL-bar collapse transients and rotation jitter — no real keyboard is
  // shorter than this.
  var KB_MIN_INSET = 50;

  // On-screen keyboard occlusion: height of the LAYOUT-viewport strip
  // hidden behind the keyboard.
  // input: { layoutHeight, vvHeight, vvScale?, minInset? }.
  // Returns integer px (0 when no keyboard). Forced to 0 while pinch-zoomed
  // — a zoomed visual viewport is not a keyboard.
  //
  // ── WHY layoutHeight, AND WHY NO vvOffsetTop (#1938) ─────────────────
  //
  // This used to read `innerHeight - vvHeight - vvOffsetTop`, on the stated
  // reasoning that iOS OVERLAYS the layout viewport and so leaves
  // `window.innerHeight` at full height. It does not. Measured on an
  // iPhone 17 Pro with the keyboard up, in Safari AND in an installed PWA:
  //
  //             innerHeight  vvHeight  vvOffsetTop  documentElement.clientHeight
  //   standalone    409        409        403            812
  //   Safari        377        377        337            714
  //   Android       810        498          0            810
  //
  // On iOS `innerHeight` collapses to the visual viewport AND the page is
  // panned, so the old expression came out NEGATIVE (409-409-403 = -403),
  // fell through the `occluded > 0` guard, and returned 0. The `un-kb` class
  // was therefore never set and `--un-kb-inset` never left 0: every piece of
  // keyboard avoidance the kit publishes — its own sheets and modals, and
  // `.platform-kb-column` in the shell (#1937, #1491) — was inert on iOS,
  // while working correctly on Android. It read as a fix that worked, because
  // iOS pans the document on focus and that happens to reveal a composer at
  // the foot of a SHORT column; a taller one inside an `overflow: hidden`
  // shell (the dev session's) stayed behind the keys, which is #1938.
  //
  // The layout viewport is the frame of reference that holds still on all
  // three, so the occlusion is simply what the keyboard took from it. The
  // pan term goes with it: at scale 1 a non-zero `vvOffsetTop` IS the
  // keyboard pan, so subtracting it cancelled the very thing being measured.
  // Callers pass the layout height; `layoutViewportHeight()` below is how the
  // kit obtains one that iOS cannot move. `innerHeight` is still accepted as
  // the old name so an app calling this directly keeps working.
  function keyboardInset(input) {
    if (!input) return 0;
    var scale = input.vvScale == null ? 1 : input.vvScale;
    if (Math.abs(scale - 1) > 0.01) return 0;
    var min = input.minInset == null ? KB_MIN_INSET : input.minInset;
    var layout = input.layoutHeight == null ? input.innerHeight : input.layoutHeight;
    var occluded = layout - input.vvHeight;
    if (!(occluded > 0) || occluded < min) return 0;
    return Math.round(occluded);
  }

  // The layout viewport's height — the one the on-screen keyboard does not
  // move. `documentElement.clientHeight` is that viewport in standards mode
  // (CSS on <html> does not change it), and it stayed at full height on every
  // platform measured above while `innerHeight` collapsed on iOS. The max of
  // the two covers the reverse case: a browser in `interactive-widget:
  // resizes-content` mode genuinely shrinks the layout viewport, and there
  // both agree, so no keyboard is reported and nothing is compensated twice.
  function layoutViewportHeight() {
    var docEl = document.documentElement;
    var client = docEl && docEl.clientHeight ? docEl.clientHeight : 0;
    return Math.max(window.innerHeight || 0, client);
  }

  // Text-entry classifier for keyboard-avoidance tap interception. Only
  // fields that summon a text keyboard are intercepted; everything else
  // (switches, buttons, selects, native pickers, file inputs) keeps fully
  // native taps. input: { tag, type?, readOnly?, disabled?,
  // contentEditable? }. Unknown/missing input types behave as text (the
  // HTML default); types that open native pickers (date/time family) are
  // excluded on purpose — intercepting their taps risks breaking picker
  // presentation.
  var KB_TEXT_INPUT_TYPES = {
    text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1,
  };
  var KB_NON_TEXT_INPUT_TYPES = {
    checkbox: 1, radio: 1, range: 1, color: 1, file: 1, button: 1,
    submit: 1, reset: 1, image: 1, hidden: 1,
    date: 1, time: 1, month: 1, week: 1, 'datetime-local': 1,
  };
  function isTextEntryField(input) {
    if (!input) return false;
    if (input.disabled || input.readOnly) return false;
    if (input.contentEditable) return true;
    var tag = String(input.tag || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var type = input.type ? String(input.type).toLowerCase() : 'text';
    if (KB_TEXT_INPUT_TYPES[type]) return true;
    return !KB_NON_TEXT_INPUT_TYPES[type]; // unknown types default to text
  }

  // Whether the focused element can be holding the on-screen keyboard up.
  // Only a text-entry field raises it, and blurring that field is what
  // retracts it, so with nothing editable focused there is no keyboard —
  // whatever the visual viewport still reports. iOS reports the retraction
  // only once its animation has finished, 250–400ms after the keys are
  // gone, and everything keyed off the inset (the tab bar, a dialog's
  // height, a column's padding) used to wait that long and then snap.
  // A focused IFRAME may hold a field the page cannot see into, so it
  // keeps the measurement. input: isTextEntryField's descriptor, or null.
  function keyboardCanBeUp(input) {
    if (!input) return false;
    if (String(input.tag || '').toLowerCase() === 'iframe') return true;
    return isTextEntryField(input);
  }

  // A tap outside the field closes the keyboard (request #4032). The
  // Homeroom iOS app dropped WKWebView's accessory bar, and its check mark
  // was the only way to put the keys away: WebKit does not blur a focused
  // field when a finger taps content that cannot take focus (Chrome on
  // Android does). These decide whether a touch was that tap and whether
  // what it landed on wants the keyboard kept, for the listener below.
  //
  // A tap, not a scroll or a press: under KB_DISMISS_SLOP px from where it
  // started at its furthest, no scroll in between, one finger, and shorter
  // than a long press (iOS starts text selection and context menus at
  // 500ms). input: { moved (the furthest the finger got, px), ms,
  // scrolled?, multi? }.
  var KB_DISMISS_SLOP = 10;
  var KB_DISMISS_MAX_MS = 500;
  function isKeyboardDismissTap(input) {
    if (!input || input.scrolled || input.multi) return false;
    var moved = Number(input.moved) || 0;
    if (moved >= KB_DISMISS_SLOP) return false;
    var ms = Number(input.ms);
    return !(isFinite(ms) && ms > KB_DISMISS_MAX_MS);
  }

  // What keeps the keyboard: a tap on another field (focus moves there), on
  // a control (it does its own thing with the field still up, as a native
  // button does; the composers' Send buttons hold the field by preventing
  // mousedown's default, and still get to), and on anything marked
  // `data-keep-keyboard`. Matched by tag, role and attribute rather than a
  // selector, so the rule can be tested without a DOM.
  var KB_KEEP_TAGS = {
    input: 1, textarea: 1, select: 1, button: 1, label: 1, summary: 1, iframe: 1,
  };
  var KB_KEEP_ROLES = {
    button: 1, link: 1, option: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    combobox: 1, listbox: 1, textbox: 1, searchbox: 1, spinbutton: 1, slider: 1,
    'switch': 1, checkbox: 1, radio: 1, tab: 1,
  };
  // On <html> or <body>, `data-un-keyboard-dismiss="off"` turns the kit's
  // listener off for an app that closes the keyboard its own way.
  var KB_DISMISS_OFF_ATTR = 'data-un-keyboard-dismiss';
  function kbAttr(el, name) {
    try {
      return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
    } catch (e) { return null; }
  }
  function kbTokens(value) {
    return value == null ? [] : String(value).split(/\s+/).filter(Boolean);
  }
  // One element (anything with getAttribute; the document, the window and
  // shadow roots in an event path have none, and keep nothing).
  function keepsKeyboard(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (KB_KEEP_TAGS[tag]) return true;
    if ((tag === 'a' || tag === 'area') && kbAttr(el, 'href') != null) return true;
    var editable = kbAttr(el, 'contenteditable');
    if (editable != null && String(editable).toLowerCase() !== 'false') return true;
    if (kbAttr(el, 'data-keep-keyboard') != null) return true;
    var roles = kbTokens(kbAttr(el, 'role'));
    for (var i = 0; i < roles.length; i++) {
      if (Object.prototype.hasOwnProperty.call(KB_KEEP_ROLES, roles[i].toLowerCase())) return true;
    }
    // The kit's own mark for a tappable row or tile that is not a button.
    return kbTokens(kbAttr(el, 'class')).indexOf('un-pressable') !== -1;
  }
  // The whole tap: `path` is the event's path, the tapped element first (a
  // composedPath(), or the parent chain); `field` is the focused field. An
  // open suggestion list the field names in aria-controls / aria-owns keeps
  // it too, whatever its rows are made of.
  function tapKeepsKeyboard(path, field) {
    if (!path || typeof path.length !== 'number') return false;
    var owned = kbTokens(kbAttr(field, 'aria-controls')).concat(kbTokens(kbAttr(field, 'aria-owns')));
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (keepsKeyboard(node)) return true;
      if (owned.length && node && node.id && owned.indexOf(String(node.id)) !== -1) return true;
    }
    return false;
  }

  // A focused frame holds a field this page cannot see into (an app in the
  // platform shell; keyboardCanBeUp above), and a tap on the page around
  // the frame (the shell's header, say) reaches only this page, never the
  // frame (request #4273). So the listener below tells the
  // frame, and the kit inside it puts its own field away. The message is
  // one of the `__usernode_*` family the bridge already passes between the
  // shell and an app (`__usernode_theme`, `__usernode_visibility`, ...),
  // and like those a frame takes it from its parent window only.
  function keyboardDismissMessage() {
    return { __usernode_keyboard: 'dismiss' };
  }
  function isKeyboardDismissMessage(data) {
    return !!data && typeof data === 'object' && data.__usernode_keyboard === 'dismiss';
  }
  // And up (request #4314): the shell's side panel on iPad Safari is a
  // document of its own beside the app, so a tap in it reaches neither the
  // shell nor the app. A frame whose parent marks it with this attribute
  // reports such a tap, made with no field of its own focused, to that
  // parent, which takes it from that frame of its own origin only and
  // closes the keyboard by its own rule (blur its field, or tell the
  // focused frame).
  var KB_RELAY_ATTR = 'data-un-keyboard-relay';
  function keyboardTapMessage() {
    return { __usernode_keyboard: 'tap' };
  }
  function isKeyboardTapMessage(data) {
    return !!data && typeof data === 'object' && data.__usernode_keyboard === 'tap';
  }

  // Keyboard-aware reveal math for a focused field inside a content
  // scroller. scrollIntoView({block:'nearest'}) is blind here: keyboard
  // clearance is CONTENT PADDING on the scroller, not a smaller
  // scrollport, so a field hidden under the keyboard still counts as
  // "visible" to it. Computes the minimal scrollTop delta instead.
  // input (all viewport-space px): { fieldTop, fieldBottom, innerHeight,
  // inset, margin, topLimit } — topLimit is the final limit (caller adds
  // its own margin, e.g. navbar bottom + margin). Positive delta scrolls
  // down, negative up, 0 leaves an already-visible field alone.
  function revealScrollDelta(input) {
    if (!input) return 0;
    var margin = input.margin == null ? 8 : input.margin;
    var inset = input.inset || 0;
    var topLimit = input.topLimit == null ? margin : input.topLimit;
    var bottomLimit = input.innerHeight - inset - margin;
    if (input.fieldBottom > bottomLimit) {
      var delta = input.fieldBottom - bottomLimit;
      // A field taller than the visible strip: keeping its top visible
      // wins — never scroll its top past the top limit.
      var maxDelta = input.fieldTop - topLimit;
      return delta > maxDelta ? Math.max(0, maxDelta) : delta;
    }
    if (input.fieldTop < topLimit) return input.fieldTop - topLimit;
    return 0;
  }

  // Edge auto-scroll ramp for drag-to-reorder: px-per-frame scroll velocity
  // for a pointer near the top/bottom of the visible area. Zero outside the
  // edge band; ramps linearly to ±maxSpeed at (or past) the edge itself.
  function autoScrollVelocity(pointerY, viewTop, viewBottom, edgeSize, maxSpeed) {
    var edge = edgeSize == null ? 48 : edgeSize;
    var max = maxSpeed == null ? 14 : maxSpeed;
    if (edge <= 0) return 0;
    if (pointerY < viewTop + edge) {
      return -Math.min(1, (viewTop + edge - pointerY) / edge) * max;
    }
    if (pointerY > viewBottom - edge) {
      return Math.min(1, (pointerY - (viewBottom - edge)) / edge) * max;
    }
    return 0;
  }

  // Anchored-popover placement: position a panel of `size` against an
  // anchor rect, flipped to the opposite vertical side when the preferred
  // side would overflow the viewport and clamped horizontally to stay
  // inside it (the openCardMenu math, kit-owned — issue #741).
  // input: { anchor: { left, top, right, bottom }, size: { w, h },
  // viewport: { w, h }, placement?, gutter?, margin? }. placement is
  // 'bottom-start' (default) | 'bottom-end' | 'top-start' | 'top-end';
  // gutter (default 4) is the gap from the anchor, margin (default 8) the
  // minimum distance from the viewport edges. Returns { left, top,
  // placement } — placement reports the side actually used after
  // flipping. Pure — unit-tested in tests/native-kit.test.js.
  function placePopover(input) {
    var a = input.anchor;
    var s = input.size;
    var vp = input.viewport;
    var gutter = input.gutter == null ? 4 : input.gutter;
    var margin = input.margin == null ? 8 : input.margin;
    var parts = String(input.placement || 'bottom-start').split('-');
    var side = parts[0] === 'top' ? 'top' : 'bottom';
    var align = parts[1] === 'end' ? 'end' : 'start';

    var left = align === 'end' ? a.right - s.w : a.left;
    left = Math.max(margin, Math.min(left, vp.w - s.w - margin));

    var top = side === 'bottom' ? a.bottom + gutter : a.top - s.h - gutter;
    if (side === 'bottom' && top + s.h > vp.h - margin) {
      side = 'top';
      top = a.top - s.h - gutter;
    } else if (side === 'top' && top < margin) {
      side = 'bottom';
      top = a.bottom + gutter;
    }
    top = Math.max(margin, Math.min(top, vp.h - s.h - margin));

    return { left: left, top: top, placement: side + '-' + align };
  }

  // Gesture arbiter core: one owner per gesture sequence, decided once —
  // the first recognizer to claim a sequence wins it, everyone else backs
  // off. Pure (no DOM); the kit wires one instance to real pointer/touch
  // sequences and exposes it as unNative.gestures.
  function createArbiter() {
    var owners = Object.create(null);
    return {
      // First claim wins; re-claiming with the same token is idempotent.
      claim: function (seq, token) {
        if (seq == null || token == null) return false;
        var key = String(seq);
        if (key in owners) return owners[key] === token;
        owners[key] = token;
        return true;
      },
      owner: function (seq) {
        var key = String(seq);
        return key in owners ? owners[key] : null;
      },
      release: function (seq) {
        delete owners[String(seq)];
      },
    };
  }

  // Toast slot state machine: one visible slot plus a one-deep pending
  // slot. A visible PRIORITY toast is not displaced by ordinary toasts —
  // those queue behind it (latest wins, depth stays 1); a priority toast
  // always takes the visible slot (last-writer-wins among equals; an
  // already-pending ordinary toast survives the takeover). Records are
  // opaque beyond their `priority` flag; the DOM layer owns presentation
  // and onClose delivery. Pure (no DOM); unit-tested in
  // tests/native-kit.test.js.
  function createToastSlot() {
    var current = null; // the record occupying the visible slot
    var pending = null; // an ordinary record waiting behind a priority one
    return {
      current: function () { return current; },
      pending: function () { return pending; },
      // A new record arrives. Returns { display: 'replace' | 'queue',
      // closed: [records displaced by this arrival] }.
      show: function (record) {
        if (current && current.priority && !record.priority) {
          var dropped = pending;
          pending = record;
          return { display: 'queue', closed: dropped ? [dropped] : [] };
        }
        var displaced = current;
        current = record;
        return { display: 'replace', closed: displaced ? [displaced] : [] };
      },
      // The visible record's lifetime ended (timeout / action / dismiss).
      // Promotes the pending record into the visible slot and returns it
      // (null when nothing was waiting, or when record wasn't current).
      resolve: function (record) {
        if (record == null || record !== current) return null;
        current = pending;
        pending = null;
        return current;
      },
      // Cancel a record still waiting in the pending slot. True if removed.
      cancelPending: function (record) {
        if (record == null || record !== pending) return false;
        pending = null;
        return true;
      },
    };
  }

  // How long a toast stays when the caller names no duration. A short
  // status ("Copied") keeps the 2.2s it always had; a longer message gets
  // reading time — about 60ms a character over a one-second glance — up to
  // 8s, because an error that wraps to three lines was gone before it could
  // be read. `error: true` holds at least 5s whatever its length. An action
  // toast keeps its 4s: its clock is the undo window, not reading time. An
  // explicit `duration` always wins. Pure; unit-tested in
  // tests/native-kit.test.js.
  var TOAST_MIN_MS = 2200;
  var TOAST_MAX_MS = 8000;
  var TOAST_ERROR_MIN_MS = 5000;
  var TOAST_ACTION_MS = 4000;
  function toastDuration(message, opts) {
    var o = opts || {};
    if (o.duration != null) return o.duration;
    if (o.action && o.action.label != null) return TOAST_ACTION_MS;
    var len = message == null ? 0 : String(message).length;
    var ms = Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, 1000 + 60 * len));
    return o.error ? Math.max(TOAST_ERROR_MIN_MS, ms) : ms;
  }

  // Whether tapping the toast dismisses it. Only a toast that outstays the
  // short default (or asks to, or is an error) takes taps: a 2.2s "Copied"
  // stays pass-through, as the kit has always promised, while a long one
  // that now lingers for up to 8s can be tapped away. Never an action
  // toast: its only tappable part is its button. `dismissible: false`
  // opts out.
  function toastTapDismisses(opts, duration) {
    var o = opts || {};
    if (o.action && o.action.label != null) return false;
    if (o.dismissible != null) return !!o.dismissible;
    return !!o.error || duration > TOAST_MIN_MS;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Zoom-from-element math — pure functions for the 'zoom-in'/'zoom-out'
   * transition types. Unit-tested via the physics export.
   * ──────────────────────────────────────────────────────────────────── */

  // Whether a source rect can seed a zoom: non-degenerate and at least
  // partially inside the viewport's vertical band. Off-screen tiles
  // (deep links, filtered-away cards, scrolled-away grids) return false
  // so the transition falls back to push/pop instead of animating
  // from a rect the user can't see.
  function zoomRectUsable(rect, viewportHeight) {
    if (!rect) return false;
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    var bottom = rect.bottom != null ? rect.bottom : rect.top + rect.height;
    if (bottom < 0) return false;
    if (viewportHeight != null && rect.top > viewportHeight) return false;
    return true;
  }

  // The transform pose that maps targetRect (the screen's resting rect)
  // onto fromRect (the tile): apply as translate(tx,ty) scale(sx,sy)
  // with transform-origin 0 0. null on degenerate input.
  function zoomPose(fromRect, targetRect) {
    if (!fromRect || !targetRect) return null;
    if (!(fromRect.width > 0) || !(fromRect.height > 0)) return null;
    if (!(targetRect.width > 0) || !(targetRect.height > 0)) return null;
    return {
      tx: fromRect.left - targetRect.left,
      ty: fromRect.top - targetRect.top,
      sx: fromRect.width / targetRect.width,
      sy: fromRect.height / targetRect.height,
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Menu-row icons (additive, /v1).
   *
   * Rows in menu() / popover() / actionSheet() may carry `icon: '<name>'`
   * naming one of these, or `iconEl: <Element>` for artwork the kit does
   * not ship. A row with NEITHER renders exactly as it did before this
   * existed — one text node, same class, same DOM — so every caller and
   * every selector written against one is untouched.
   *
   * Stroke geometry on a 24 grid, drawn in `currentColor`: the row's own
   * colour carries the icon, so a destructive row tints its icon red and
   * a disabled row dims it without a single per-icon rule.
   *
   * Deliberately a SMALL set. A name that ships here is one every app on
   * the platform can rely on and none of them can restyle, so the set
   * grows by being needed, not by being anticipated — /v1 takes additive
   * names in place.
   * ──────────────────────────────────────────────────────────────────── */
  var ICONS = {
    home: [
      'M3 10.4 12 3.2l9 7.2',
      'M5.4 9.3V20.8h13.2V9.3',
      'M9.6 20.8v-6.2h4.8v6.2',
    ],
    globe: [
      'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
      'M3 12h18',
      'M12 3c2.4 2.7 3.6 5.7 3.6 9s-1.2 6.3-3.6 9c-2.4-2.7-3.6-5.7-3.6-9S9.6 5.7 12 3z',
    ],
    terminal: [
      'M4 5.5h16A1.5 1.5 0 0 1 21.5 7v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V7A1.5 1.5 0 0 1 4 5.5z',
      'M6.6 9.6 9.6 12l-3 2.4',
      'M12.6 14.8h4.8',
    ],
    link: [
      'M10.2 13.6a4 4 0 0 0 5.7 0l2.9-2.9a4 4 0 1 0-5.7-5.7l-1.6 1.7',
      'M13.8 10.4a4 4 0 0 0-5.7 0l-2.9 2.9a4 4 0 1 0 5.7 5.7l1.6-1.7',
    ],
    laptop: [
      'M5.2 6.4h13.6v9.2H5.2z',
      'M2.6 18.6h18.8',
    ],
    cloud: [
      'M7.2 18.4h9.4a4.1 4.1 0 0 0 .6-8.1 6.1 6.1 0 0 0-11.6-.6 3.8 3.8 0 0 0 1.6 8.7z',
    ],
    // The one icon here that is not about WHERE something runs: a
    // destructive row is the most-iconed row in any app's menus, and it is
    // what proves the glyph takes the row's colour rather than its own.
    trash: [
      'M4 6.8h16',
      'M9.2 6.8V4.6h5.6v2.2',
      'M6.4 6.8 7.3 20a1.2 1.2 0 0 0 1.2 1.1h7a1.2 1.2 0 0 0 1.2-1.1l.9-13.2',
      'M10.3 10.6v6.6',
      'M13.7 10.6v6.6',
    ],
  };

  // hasOwnProperty, not a bare lookup: `name` is caller data, and a bare
  // one answers `toString` / `constructor` with a prototype member that is
  // not an icon.
  function iconPaths(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null;
  }

  // Does this row want the kit to draw something to the left of its label?
  // One answer, so the sheet and the popover can never disagree about it.
  function rowHasIcon(item) {
    if (!item) return false;
    if (item.iconEl && item.iconEl.nodeType === 1) return true;
    return !!iconPaths(item.icon);
  }

  var physics = {
    PRESETS: PRESETS,
    DECEL_RATE: DECEL_RATE,
    REST_VELOCITY: REST_VELOCITY,
    REST_DELTA: REST_DELTA,
    EXIT_DELTA: EXIT_DELTA,
    STEP_MS: STEP_MS,
    FRAME_MS: FRAME_MS,
    MAX_FRAME_GAP_MS: MAX_FRAME_GAP_MS,
    isAtRest: isAtRest,
    isExitDone: isExitDone,
    springFrameDelta: springFrameDelta,
    // Default horizon (ms) for release-decision projection. Mutable via the
    // ?un-tune=1 overlay; projectDisplacement reads it at call time.
    COMMIT_HORIZON_MS: 120,
    springStep: springStep,
    simulateSpring: simulateSpring,
    projectMomentum: projectMomentum,
    projectDisplacement: projectDisplacement,
    estimateVelocity: estimateVelocity,
    rubberband: rubberband,
    rubberbandInvert: rubberbandInvert,
    lockIntent: lockIntent,
    decideSwipeRelease: decideSwipeRelease,
    decidePtrRelease: decidePtrRelease,
    PTR_PUCK: PTR_PUCK,
    PTR_PUCK_GAP: PTR_PUCK_GAP,
    PTR_HOLD: PTR_HOLD,
    PTR_THRESHOLD: PTR_THRESHOLD,
    PTR_LIMIT: PTR_LIMIT,
    PTR_LAYER_H: PTR_LAYER_H,
    ptrPuckOffset: ptrPuckOffset,
    decideSheetRelease: decideSheetRelease,
    decideSheetDrag: decideSheetDrag,
    SHEET_PULL_SLOP: SHEET_PULL_SLOP,
    holdsSheetPull: holdsSheetPull,
    GHOST_CLICK_MS: GHOST_CLICK_MS,
    DISMISS_EDGE_PX: DISMISS_EDGE_PX,
    decideBackdropDismiss: decideBackdropDismiss,
    remeasuredSheetY: remeasuredSheetY,
    KB_MIN_INSET: KB_MIN_INSET,
    keyboardInset: keyboardInset,
    layoutViewportHeight: layoutViewportHeight,
    isTextEntryField: isTextEntryField,
    keyboardCanBeUp: keyboardCanBeUp,
    KB_DISMISS_SLOP: KB_DISMISS_SLOP,
    KB_DISMISS_MAX_MS: KB_DISMISS_MAX_MS,
    KB_DISMISS_OFF_ATTR: KB_DISMISS_OFF_ATTR,
    isKeyboardDismissTap: isKeyboardDismissTap,
    keepsKeyboard: keepsKeyboard,
    tapKeepsKeyboard: tapKeepsKeyboard,
    keyboardDismissMessage: keyboardDismissMessage,
    isKeyboardDismissMessage: isKeyboardDismissMessage,
    KB_RELAY_ATTR: KB_RELAY_ATTR,
    keyboardTapMessage: keyboardTapMessage,
    isKeyboardTapMessage: isKeyboardTapMessage,
    revealScrollDelta: revealScrollDelta,
    reorderDropIndex: reorderDropIndex,
    gridDropSide: gridDropSide,
    autoScrollVelocity: autoScrollVelocity,
    placePopover: placePopover,
    createArbiter: createArbiter,
    createToastSlot: createToastSlot,
    toastDuration: toastDuration,
    toastTapDismisses: toastTapDismisses,
    zoomPose: zoomPose,
    zoomRectUsable: zoomRectUsable,
    ICON_NAMES: Object.keys(ICONS),
    iconPaths: iconPaths,
    rowHasIcon: rowHasIcon,
  };

  // Node (unit tests): export the math and stop — no DOM below this line.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { physics: physics };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ────────────────────────────────────────────────────────────────────
   * Platform detection
   * ──────────────────────────────────────────────────────────────────── */

  function detectPlatform() {
    try {
      var qp = new URLSearchParams(window.location.search).get('un-platform');
      if (qp === 'ios' || qp === 'android' || qp === 'desktop') return qp;
    } catch (e) { /* no URL API / opaque origin — fall through */ }
    var ua = navigator.userAgent || '';
    // iPadOS 13+ reports MacIntel; maxTouchPoints disambiguates.
    var isIOS = /iPhone|iPad|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) return 'ios';
    if (/Android/.test(ua)) return 'android';
    // Other touch-mobile UAs get the Material skin; everything else desktop.
    if (navigator.maxTouchPoints > 0 && /Mobi/.test(ua)) return 'android';
    return 'desktop';
  }

  var platform = detectPlatform();
  document.documentElement.classList.add('un-' + platform);

  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* ignore */ }

  // Haptic tick for threshold crossings (arm/disarm cues). navigator.vibrate
  // exists on Android; iOS Safari has no vibration API — silently no-ops.
  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms == null ? 10 : ms);
    } catch (e) { /* ignore */ }
  }

  /* ────────────────────────────────────────────────────────────────────
   * Keyboard avoidance — one global visualViewport tracker (issue #719).
   * Maintains `--un-kb-inset` (the height of the layout-viewport strip
   * hidden behind the on-screen keyboard) and class `un-kb` on <html>.
   * Kit surfaces consume the var through their CSS box position
   * (`bottom` / `top`) so sheets, action sheets, modals and alerts ride
   * above the keyboard — the JS-owned translateY is never touched, so
   * spring/drag semantics are unchanged. Apps may consume the var for
   * their own fixed bottom bars. Structural no-op on desktop or where
   * visualViewport is absent: no listeners, no var, CSS falls back to 0px.
   *
   * The inset drops to 0 the moment focus leaves a text field
   * (keyboardCanBeUp), not when iOS finally reports the smaller keyboard:
   * that report lands after the keys have gone, so the surfaces riding the
   * inset moved late and all at once. Cleared on blur, they move WITH the
   * retracting keyboard instead.
   * ──────────────────────────────────────────────────────────────────── */

  // Current keyboard inset (px), shared with attachKeyboardAvoidance so
  // instances read it directly instead of parsing the CSS custom property.
  var kbInset = 0;
  // Called with the new inset after the var and the class are written: a
  // presented modal waits on it to reveal the field it just focused.
  var kbWatchers = [];

  (function () {
    var vv = window.visualViewport;
    if (!vv || platform === 'desktop') return;
    var rafPending = false;
    function describe(el) {
      // Focus inside a shadow root is reported as its host.
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      return {
        tag: el.tagName,
        type: el.type,
        readOnly: !!el.readOnly,
        disabled: !!el.disabled,
        contentEditable: !!el.isContentEditable,
      };
    }
    function publish(inset) {
      if (inset === kbInset) return;
      kbInset = inset;
      document.documentElement.style.setProperty('--un-kb-inset', inset + 'px');
      document.documentElement.classList.toggle('un-kb', inset > 0);
      kbWatchers.slice().forEach(function (fn) {
        try { fn(inset); } catch (e) { /* one surface must not stop the rest */ }
      });
    }
    function apply() {
      rafPending = false;
      publish(!keyboardCanBeUp(describe(document.activeElement)) ? 0 : keyboardInset({
        layoutHeight: layoutViewportHeight(),
        vvHeight: vv.height,
        vvScale: vv.scale,
      }));
    }
    // A blur that takes focus nowhere a keyboard can live clears the inset
    // IN the event, not a frame later: iOS starts scrolling the page back
    // down the moment the field blurs, and the first frame after a blur has
    // measured ~100ms late on iOS — long enough for the page to slide down
    // before a dialog riding the inset began to follow. `relatedTarget` is
    // where focus is going; a hop to another field keeps the keyboard.
    function onFocusOut(e) {
      if (!keyboardCanBeUp(describe(e.relatedTarget))) publish(0);
      schedule();
    }
    function schedule() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(apply);
    }
    // The keyboard's own report is read IN the event. iOS pans the page
    // to a focused field in the same frame it reports the smaller visual
    // viewport, and anything answering that pan (the shell moves a modal
    // by it, keyed on `un-kb`) has to land in that frame too: the next
    // animation frame measured ~45ms later there, long enough to see the
    // page move and the dialog follow. Scrolls, which fire every frame of
    // a pinch or pan, stay coalesced to one read per frame.
    vv.addEventListener('resize', apply, { passive: true });
    vv.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    // Re-read a frame later as well, once focus has landed.
    document.addEventListener('focusin', schedule, true);
    document.addEventListener('focusout', onFocusOut, true);
  })();

  /* ────────────────────────────────────────────────────────────────────
   * A tap outside the field closes the keyboard (request #4032). With a
   * text field focused, one finger that lands and lifts without travelling
   * (isKeyboardDismissTap) on something that keeps no keyboard
   * (tapKeepsKeyboard) blurs the field, as the accessory bar's check mark
   * did. The tap itself is untouched: nothing is prevented, so it still
   * does whatever it did.
   *
   * Cheap on any page: passive listeners that return at once unless a text
   * field was focused when the finger landed, and nothing written but the
   * blur. Off on desktop (no on-screen keyboard), and for a page whose
   * <html> or <body> says data-un-keyboard-dismiss="off" as the finger
   * lands. One listener per document, every app's in its own frame: the
   * platform shell loads this file too (frontend/src/head.html), so its
   * own screens get exactly this, and lib/keyboard-open.ts reads the blur
   * as one during a press, keeping the tab bar back for the tap's click.
   *
   * With a FRAME focused instead (the shell around an app whose field is
   * up), the same tap posts `{ __usernode_keyboard: 'dismiss' }` to that
   * frame (request #4273): the frame never hears a tap on the page around
   * it. In a frame, the kit takes that message from its parent window only
   * and, unless its own page opted out, blurs its focused text field, or
   * passes the message on to a frame focused inside it. Posted, never
   * waited on, so the tap's own click is no later for it.
   *
   * The other way (request #4314): in a frame its parent marked
   * `data-un-keyboard-relay` (the shell's side panel, beside the app on an
   * iPad), the same tap with no field or frame of its own focused posts
   * `{ __usernode_keyboard: 'tap' }` to the parent. `window.frameElement`
   * is null under a parent of another origin, so only a same-origin parent
   * can ask for it. The parent takes it only from such a frame of its own,
   * of its own origin, and does what a tap on its own page would: blur
   * its field, or tell the frame that has focus. Each side's opt-out
   * holds, and the tap's exceptions are checked where it landed.
   *
   * Touch events where the page has them (every phone), else pointer
   * events from a finger; never a mouse or a pen. The start is heard in
   * capture, before anything can stop it; the end in the window's bubble
   * phase, after the page's own handlers, so a tap a handler took for
   * itself (it cancelled or stopped the touchend) is left to it.
   * ──────────────────────────────────────────────────────────────────── */

  (function keyboardDismiss() {
    if (platform === 'desktop') return;
    var tap = null; // { x, y, at, moved, scrolled, multi }: the finger down now

    function now() {
      return window.performance && typeof window.performance.now === 'function'
        ? window.performance.now() : Date.now();
    }
    // What has focus, through any shadow roots, or null.
    function focused() {
      var el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return !el || el === document.body || el === document.documentElement ? null : el;
    }
    // The focused text field, or null.
    function focusedField() {
      var el = focused();
      return el && isTextEntryField({
        tag: el.tagName,
        type: el.type,
        readOnly: !!el.readOnly,
        disabled: !!el.disabled,
        contentEditable: !!el.isContentEditable,
      }) ? el : null;
    }
    // The focused frame, or null: whatever field it holds is in there.
    function focusedFrame() {
      var el = focused();
      return el && String(el.tagName || '').toLowerCase() === 'iframe' && el.contentWindow ? el : null;
    }
    function putAway(field) {
      try { field.blur(); } catch (err) { /* nothing to put away */ }
    }
    // To any origin, as the shell's other messages to an app go: the frame
    // is the app's origin (or none yet), and the message carries nothing.
    function tell(frame) {
      try {
        frame.contentWindow.postMessage(keyboardDismissMessage(), '*');
      } catch (err) { /* a frame mid-teardown has no keyboard */ }
    }
    function off() {
      return kbAttr(document.documentElement, KB_DISMISS_OFF_ATTR) === 'off'
        || kbAttr(document.body, KB_DISMISS_OFF_ATTR) === 'off';
    }
    var framed = false;
    try { framed = !!window.parent && window.parent !== window; } catch (err) { /* no parent */ }
    function origin() {
      try { return window.location.origin; } catch (err) { return null; }
    }
    // In a frame: whether the parent asked to hear this page's taps.
    function relays() {
      if (!framed) return false;
      try { return kbAttr(window.frameElement, KB_RELAY_ATTR) != null; } catch (err) { return false; }
    }
    // To the parent, at this page's own origin: relays() saw the parent's
    // element, so the parent is of this origin too.
    function report() {
      try {
        window.parent.postMessage(keyboardTapMessage(), origin());
      } catch (err) { /* a parent mid-teardown has no keyboard */ }
    }
    // The frame of this page's that a relayed tap came from, or null: one
    // marked to relay, in this document, of this origin.
    function relayFrame(e) {
      var o = origin();
      if (!e.source || !o || e.origin !== o) return null;
      try {
        var el = e.source.frameElement;
        return el && el.ownerDocument === document && kbAttr(el, KB_RELAY_ATTR) != null ? el : null;
      } catch (err) { return null; }
    }
    function pathOf(e) {
      try {
        var path = typeof e.composedPath === 'function' ? e.composedPath() : null;
        if (path && path.length) return path;
      } catch (err) { /* fall back to the parent chain */ }
      var chain = [];
      for (var n = e.target; n; n = n.parentNode) chain.push(n);
      return chain;
    }

    function down(x, y) {
      tap = !off() && (focusedField() || focusedFrame() || relays())
        ? { x: x, y: y, at: now(), moved: 0, scrolled: false, multi: false }
        : null;
    }
    function move(x, y) {
      if (!tap) return;
      var d = Math.sqrt((x - tap.x) * (x - tap.x) + (y - tap.y) * (y - tap.y));
      if (d > tap.moved) tap.moved = d;
    }
    function up(e) {
      var t = tap;
      tap = null;
      if (!t || e.defaultPrevented) return;
      if (!isKeyboardDismissTap({ moved: t.moved, ms: now() - t.at, scrolled: t.scrolled, multi: t.multi })) return;
      var field = focusedField();
      var frame = field ? null : focusedFrame();
      var relay = !(field || frame) && relays();
      if (!(field || frame || relay) || tapKeepsKeyboard(pathOf(e), field || frame)) return;
      if (field) putAway(field); else if (frame) tell(frame); else report();
    }

    // In a frame: the page around it heard a tap that closes the keyboard.
    // From the parent window only, as the bridge takes the shell's other
    // messages; a top-level page has no parent to hear it from. Around a
    // relaying frame: a tap in it that closes the keyboard, which this
    // page treats as its own (never telling the frame it came from).
    function onMessage(e) {
      if (!e || off()) return;
      var from = null;
      if (isKeyboardDismissMessage(e.data)) {
        if (!framed || e.source !== window.parent) return;
      } else if (isKeyboardTapMessage(e.data)) {
        from = relayFrame(e);
        if (!from) return;
      } else {
        return;
      }
      var field = focusedField();
      var frame = field ? null : focusedFrame();
      if (field) putAway(field); else if (frame && frame !== from) tell(frame);
    }

    function first(list) { return list && list.length ? list[0] : null; }
    function onTouchStart(e) {
      if (e.touches && e.touches.length > 1) { if (tap) tap.multi = true; return; }
      var p = first(e.touches) || first(e.changedTouches);
      if (p) down(p.clientX, p.clientY); else tap = null;
    }
    function onTouchMove(e) {
      if (!tap) return;
      if (e.touches && e.touches.length > 1) { tap.multi = true; return; }
      var p = first(e.touches);
      if (p) move(p.clientX, p.clientY);
    }
    function onTouchEnd(e) {
      if (!tap || (e.touches && e.touches.length)) return; // a finger is still down
      var p = first(e.changedTouches);
      if (p) move(p.clientX, p.clientY);
      up(e);
    }
    function onPointerDown(e) {
      if (e.pointerType !== 'touch') { tap = null; return; }
      if (e.isPrimary === false) { if (tap) tap.multi = true; return; }
      down(e.clientX, e.clientY);
    }
    function onPointerMove(e) {
      if (tap && e.pointerType === 'touch' && e.isPrimary !== false) move(e.clientX, e.clientY);
    }
    function onPointerUp(e) {
      if (!tap || e.pointerType !== 'touch' || e.isPrimary === false) return;
      move(e.clientX, e.clientY);
      up(e);
    }
    function onScroll() { if (tap) tap.scrolled = true; }
    function onCancel() { tap = null; }

    var quiet = { capture: true, passive: true };
    if ('ontouchstart' in window) {
      window.addEventListener('touchstart', onTouchStart, quiet);
      window.addEventListener('touchmove', onTouchMove, quiet);
      window.addEventListener('touchcancel', onCancel, quiet);
      window.addEventListener('touchend', onTouchEnd, { passive: true });
    } else {
      window.addEventListener('pointerdown', onPointerDown, quiet);
      window.addEventListener('pointermove', onPointerMove, quiet);
      window.addEventListener('pointercancel', onCancel, quiet);
      window.addEventListener('pointerup', onPointerUp, { passive: true });
    }
    // Element scrolls do not bubble, but they pass the window in capture.
    window.addEventListener('scroll', onScroll, quiet);
    // Every page: a frame hears its parent, and any page may hold a frame
    // that relays.
    window.addEventListener('message', onMessage, { passive: true });
  })();

  /* ────────────────────────────────────────────────────────────────────
   * Gesture arbiter — one intent lock across kit AND app gestures.
   * Sequences: the primary touch (pointer or touch events) is 'touch' so
   * pointer-driven swipe rows and touch-driven PTR contend for the same
   * finger; non-touch pointers key by pointerId. Claims auto-clear when
   * the sequence ends. App gestures join via unNative.gestures: claim at
   * your own intent-lock moment (never before movement passes the lock
   * threshold) and back off when claim() returns false.
   * ──────────────────────────────────────────────────────────────────── */

  var gestures = createArbiter();

  function gestureSeq(e) {
    if (typeof e.pointerId === 'number') {
      return e.pointerType === 'touch' && e.isPrimary !== false ? 'touch' : e.pointerId;
    }
    return 'touch';
  }

  window.addEventListener('pointerup', function (e) { gestures.release(gestureSeq(e)); }, true);
  window.addEventListener('pointercancel', function (e) { gestures.release(gestureSeq(e)); }, true);
  window.addEventListener('touchend', function (e) {
    if (!e.touches || e.touches.length === 0) gestures.release('touch');
  }, true);
  window.addEventListener('touchcancel', function (e) {
    if (!e.touches || e.touches.length === 0) gestures.release('touch');
  }, true);

  /* ────────────────────────────────────────────────────────────────────
   * Runtime spring — rAF loop over the same integrator, fixed-timestep
   * accumulator so feel is frame-rate independent.
   * ──────────────────────────────────────────────────────────────────── */

  function resolvePreset(opts) {
    var base = PRESETS[(opts && opts.preset) || 'default'] || PRESETS.default;
    return {
      mass: (opts && opts.mass) != null ? opts.mass : base.mass,
      tension: (opts && opts.tension) != null ? opts.tension : base.tension,
      friction: (opts && opts.friction) != null ? opts.friction : base.friction,
    };
  }

  // spring(target, opts) — target is an Element (transform written per
  // frame; opts.axis 'x'|'y' picks translateX/translateY) or a callback
  // called with the current value. opts: { from, to, velocity (px/ms),
  // preset | mass/tension/friction, exit, onUpdate, onRest }. `exit: true`
  // marks a dismissal: it rests as soon as isExitDone says the surface has
  // left the screen, and onRest runs then.
  // Returns { current(): {x, v}, stop(), done }.
  function spring(target, opts) {
    var params = resolvePreset(opts);
    var from = opts.from;
    var to = opts.to;
    var exit = opts.exit === true;
    var state = { x: from, v: opts.velocity || 0 };
    var axis = opts.axis === 'y' ? 'Y' : 'X';
    var apply = typeof target === 'function'
      ? target
      : function (val) { target.style.transform = 'translate' + axis + '(' + val + 'px)'; };
    var handle = {
      done: false,
      current: function () { return { x: state.x, v: state.v }; },
      stop: function () {
        if (handle.done) return;
        handle.done = true;
        if (raf) cancelAnimationFrame(raf);
      },
    };
    // The clock starts on the first frame (springFrameDelta): the time a
    // handler spends between creating the spring and yielding to the frame
    // is not motion anyone saw.
    var last = null;
    var acc = 0;
    var raf = null;
    function frame(now) {
      if (handle.done) return;
      acc += springFrameDelta(now, last);
      last = now;
      var rested = false;
      while (acc >= STEP_MS) {
        springStep(state, to, params, STEP_MS);
        acc -= STEP_MS;
        if (isAtRest(state, to) || (exit && isExitDone(state, from, to))) {
          state.x = to;
          state.v = 0;
          rested = true;
          break;
        }
      }
      apply(state.x);
      if (opts.onUpdate) opts.onUpdate(state.x, state.v);
      if (rested) {
        handle.done = true;
        if (opts.onRest) opts.onRest();
      } else {
        raf = requestAnimationFrame(frame);
      }
    }
    apply(state.x);
    raf = requestAnimationFrame(frame);
    return handle;
  }

  // Fly a lifted drag ghost from its current translate offset (gx, gy) to
  // (tx, ty) — the release glide shared by the reorder and placement drops.
  // Returns the spring handle so the caller can stop() it.
  //
  // The spring runs on the REMAINING DISTANCE IN PIXELS, counting down to 0,
  // rather than on a 0→1 progress value. isAtRest's thresholds are absolute
  // — REST_DELTA 0.4 px, REST_VELOCITY 0.004 px/ms — so a normalized spring
  // is declared "at rest" as soon as the progress value is within 0.4 of 1,
  // i.e. at 66% of the travel, and the ghost teleports the last third of the
  // way. In the pixel domain 0.4 means 0.4 of a pixel and the glide actually
  // arrives, which is the difference between a drop that lands and a drop
  // that visibly snaps.
  function glideGhost(ghost, gx, gy, tx, ty, onRest) {
    var dx = tx - gx;
    var dy = ty - gy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    return spring(function (remaining) {
      var p = dist > 0 ? 1 - remaining / dist : 1;
      ghost.style.transform = 'translate(' +
        (gx + dx * p) + 'px, ' + (gy + dy * p) + 'px)';
    }, {
      from: dist, to: 0, velocity: 0, preset: 'stiff', onRest: onRest,
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Swipe-to-act rows
   * ──────────────────────────────────────────────────────────────────── */

  var openSwipeRow = null; // at most one revealed row at a time

  document.addEventListener('pointerdown', function (e) {
    if (openSwipeRow && !openSwipeRow.wrap.contains(e.target)) {
      openSwipeRow.close();
    }
  }, true);

  // Closing a committed row's place. It used to be a CSS `height`
  // transition on the wrap, which WebKit runs on the main thread: in an
  // iPhone web view it once never advanced (no frame, no transitionend), so
  // the row sat under its tray until the safety timer took it away. Now the
  // row's place goes in ONE step (the wrap is 0 tall, its end state then as
  // before) and everything that moved is played back from where it was with
  // transform-only animations, which run in Core Animation whatever the
  // main thread is doing:
  //   - the tray stands in for the row, clipped by its own box, and that box
  //     rises off the row's place while the buttons in it stay put, so the
  //     tray closes from the bottom with what follows;
  //   - every element around the row up to its scroller is measured before
  //     and after (FLIP), so what follows slides up, and if the scroller has
  //     to pull back because the list got shorter, what comes before slides
  //     down instead of jumping;
  //   - a box around the row that shows its own edge (a background, border,
  //     shadow or clip, e.g. an .un-group card) cannot be resized by a
  //     transform: it keeps its height through the step and then eases it
  //     down, as before, and what is outside it follows it in the layout. If
  //     that stalls, the rows in it still close up, and its edge is late.
  // `done` runs once the motion has finished, on a timer too, since a
  // stalled main thread never reports the end of an animation.
  var SWIPE_GAP_MS = 300;
  var SWIPE_GAP_EASE = 'cubic-bezier(0.3, 1, 0.4, 1)'; // --un-ease-spring-stiff

  function scrollParentOf(el) {
    for (var p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      var oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isClear(color) {
    return !color || color === 'transparent' || /[,/]\s*0(\.0*)?\)$/.test(color);
  }

  // Whether a box shows where its edge is.
  function showsEdge(el) {
    var cs = getComputedStyle(el);
    return cs.overflowY !== 'visible' || !isClear(cs.backgroundColor) ||
      cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' ||
      parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0;
  }

  function closeSwipeGap(wrap, tray, rowEl, done) {
    var h = wrap.offsetHeight;
    if (prefersReducedMotion || !h || typeof wrap.animate !== 'function') { done(); return; }
    var scroller = scrollParentOf(wrap);
    var movers = [];
    var edge = null;
    for (var n = wrap; n && n !== scroller && n !== document.body; n = n.parentElement) {
      var p = n.parentElement;
      if (!p) break;
      for (var s = p.firstElementChild; s; s = s.nextElementSibling) {
        if (s !== n) movers.push(s);
      }
      if (p !== scroller && p !== document.body && showsEdge(p)) { edge = p; break; }
    }
    var i;
    var before = [];
    for (i = 0; i < movers.length; i++) before.push(movers[i].getBoundingClientRect().top);
    var wrapTop = wrap.getBoundingClientRect().top;
    var trayBase = tray.style.transform || '';
    var corners = getComputedStyle(wrap);
    var edgePin = edge ? edge.style.height : '';
    var edgeFrom = edge ? getComputedStyle(edge).height : '';
    var edgeTo = (parseFloat(edgeFrom) - h - parseFloat(corners.marginTop) - parseFloat(corners.marginBottom)) + 'px';

    // One step: the row's place is gone; the tray keeps the row's size and
    // corners and clips its own buttons, since the wrap no longer does. Its
    // box rises, so the top corners are the end buttons' own.
    tray.style.bottom = 'auto';
    tray.style.height = h + 'px';
    tray.style.overflow = 'hidden';
    tray.style.borderRadius = corners.borderRadius;
    if (tray.firstElementChild) tray.firstElementChild.style.borderTopLeftRadius = corners.borderTopLeftRadius;
    if (tray.lastElementChild) tray.lastElementChild.style.borderTopRightRadius = corners.borderTopRightRadius;
    rowEl.style.visibility = 'hidden';
    wrap.style.overflow = 'visible';
    wrap.style.height = '0px';
    if (edge) edge.style.height = edgeFrom;

    var opts = { duration: SWIPE_GAP_MS, easing: SWIPE_GAP_EASE };
    var held = { duration: SWIPE_GAP_MS, easing: SWIPE_GAP_EASE, fill: 'forwards' };
    var runs = [];
    // Each one holds its first frame until the next frame (go, below).
    function play(el, frames, timing) {
      try {
        var run = el.animate(frames, timing);
        run.pause();
        runs.push(run);
      } catch (e) { /* the end state is already laid out */ }
    }
    var view = scroller === (document.scrollingElement || document.documentElement)
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    for (i = 0; i < movers.length; i++) {
      var r = movers[i].getBoundingClientRect();
      var dy = before[i] - r.top;
      if (Math.abs(dy) < 0.5) continue;
      // Off screen at both ends: nothing to see, and no layer to make.
      if (r.bottom + Math.max(dy, 0) < view.top || r.top + Math.min(dy, 0) > view.bottom) continue;
      var base = getComputedStyle(movers[i]).transform;
      base = base && base !== 'none' ? ' ' + base : '';
      play(movers[i], [
        { transform: 'translateY(' + dy + 'px)' + base },
        { transform: 'translateY(0px)' + base },
      ], opts);
    }
    // The wrap itself moved only if the scroller pulled back (pull >= 0).
    var pull = wrap.getBoundingClientRect().top - wrapTop;
    play(tray, [
      { transform: trayBase + ' translateY(' + -pull + 'px)' },
      { transform: trayBase + ' translateY(' + -h + 'px)' },
    ], held);
    for (var b = tray.firstElementChild; b; b = b.nextElementSibling) {
      play(b, [{ transform: 'translateY(0px)' }, { transform: 'translateY(' + h + 'px)' }], held);
    }
    if (edge) play(edge, [{ height: edgeFrom }, { height: edgeTo }], held);

    var ended = false;
    // Played from the next frame: this one lays out the closed place and
    // makes a layer of each moving part, and in Mobile Safari a motion
    // started in it was first painted 42-70% of the way; started a frame
    // later, 18-29%. A timer starts it if no frame comes.
    var going = false;
    function go() {
      if (going || ended) return;
      going = true;
      for (var k = 0; k < runs.length; k++) runs[k].play();
    }
    requestAnimationFrame(go);
    setTimeout(go, 50);
    function end() {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      done();
      for (var k = 0; k < runs.length; k++) {
        try { runs[k].cancel(); } catch (e) { /* ignore */ }
      }
      if (edge) edge.style.height = edgePin;
    }
    var timer = setTimeout(end, SWIPE_GAP_MS + 150);
    if (typeof Promise === 'function') {
      Promise.all(runs.map(function (run) { return run.finished; })).then(end, function () {});
    }
  }

  // attachSwipeActions(rowEl, { actions: [{ label, color, destructive,
  // handler }] }). The LAST action is the full-swipe action when it is
  // destructive. The kit wraps rowEl in a .un-swipe container and renders
  // the action tray behind it; rowEl's own markup is untouched.
  // Destructive commit: the row collapses and is removed from the DOM,
  // THEN handler() runs (do the API call / re-render there).
  // Returns { close(), detach() }.
  function attachSwipeActions(rowEl, options) {
    var actions = (options && options.actions) || [];
    if (!actions.length) return { close: function () {}, detach: function () {} };

    var wrap = document.createElement('div');
    wrap.className = 'un-swipe';
    rowEl.parentNode.insertBefore(wrap, rowEl);

    var tray = document.createElement('div');
    tray.className = 'un-swipe-tray';
    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'un-swipe-action' + (action.destructive ? ' un-destructive' : '');
      btn.textContent = action.label;
      if (action.color) btn.style.background = action.color;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (action.destructive) commit(action);
        else { close(); action.handler && action.handler(); }
      });
      tray.appendChild(btn);
    });
    wrap.appendChild(tray);
    wrap.appendChild(rowEl);
    rowEl.classList.add('un-swipe-row');

    var lastAction = actions[actions.length - 1];
    var canCommit = !!lastAction.destructive;

    var offset = 0; // current translateX of the row (<= 0 when revealed)
    var activeSpring = null;
    var drag = null; // { pointerId, startX, startY, base, locked, samples }
    var committing = false;
    var commitArmed = false;
    var trayNaturalW = 0; // measured shrink-wrap width; re-measured per drag

    function measureTray() {
      tray.style.width = '';
      trayNaturalW = tray.offsetWidth || 1;
      return trayNaturalW;
    }

    function trayWidth() { return trayNaturalW || measureTray(); }
    function rowWidth() { return wrap.offsetWidth || 1; }

    // Ride-along tray: the tray is anchored off the row's right edge and
    // translates in lockstep with it, so nothing is ever painted BEHIND
    // the row (rounded corners / margins / translucent rows stay clean).
    // Past the tray's natural width it is stretched to keep its right
    // edge flush while the destructive button grows to fill.
    function setOffset(x) {
      offset = x;
      var t = 'translateX(' + x + 'px)';
      rowEl.style.transform = t;
      tray.style.transform = t;
      var tw = trayWidth();
      tray.style.width = -x > tw ? -x + 'px' : '';
      var armed = canCommit && x <= -0.6 * rowWidth();
      if (armed !== commitArmed) {
        commitArmed = armed;
        wrap.classList.toggle('un-commit-armed', armed);
        haptic();
      }
    }

    function springTo(to, velocity, preset, onRest, exit) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (x) { setOffset(x); }, {
        from: offset, to: to, velocity: velocity, preset: preset || 'default', exit: !!exit,
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function close(velocity) {
      if (openSwipeRow && openSwipeRow.wrap === wrap) openSwipeRow = null;
      springTo(0, velocity || 0, 'stiff');
    }

    function open(velocity) {
      if (openSwipeRow && openSwipeRow.wrap !== wrap) openSwipeRow.close();
      openSwipeRow = api;
      springTo(-trayWidth(), velocity || 0, 'default');
    }

    // Destructive commit: fires only from a release/click (never while a
    // finger is down — the drag handler only previews). Slide fully out,
    // close the row's place (closeSwipeGap), remove it from the DOM, then
    // run the handler. The slide ends the way a dismissal does, once the row
    // is within a pixel of gone: settling the last pixels out of sight held
    // the tray still for ~0.4 s before its place began to close.
    function commit(action, velocity) {
      if (committing) return;
      committing = true;
      if (openSwipeRow && openSwipeRow.wrap === wrap) openSwipeRow = null;
      wrap.classList.add('un-committing');
      springTo(-rowWidth(), velocity || 0, 'stiff', function () {
        closeSwipeGap(wrap, tray, rowEl, function () {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          action.handler && action.handler();
        });
      }, true);
    }

    function onPointerDown(e) {
      if (committing || e.button > 0) return;
      // An already-open or mid-spring row re-drags immediately — which
      // means claiming the gesture sequence up front.
      var immediate = offset !== 0 || !!activeSpring;
      if (immediate && !gestures.claim(gestureSeq(e), wrap)) return;
      if (!activeSpring) measureTray();
      var base = offset;
      var seedV = 0;
      if (activeSpring) {
        // Interrupt: grab the row at its rendered position + velocity.
        var cur = activeSpring.current();
        activeSpring.stop();
        activeSpring = null;
        base = cur.x;
        seedV = cur.v;
        setOffset(base);
      }
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        base: base,
        locked: immediate ? 'x' : null,
        samples: [{ t: e.timeStamp - 16, x: base - seedV * 16 }, { t: e.timeStamp, x: base }],
      };
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.locked) {
        var axis = lockIntent(dx, dy);
        if (axis === 'x' && !gestures.claim(gestureSeq(e), wrap)) {
          // Another recognizer owns this finger — back off for good.
          drag = null;
          return;
        }
        drag.locked = axis;
        if (axis === 'x') {
          try { rowEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          wrap.classList.add('un-dragging');
        }
      }
      if (drag.locked !== 'x') return;
      var raw = drag.base + dx;
      var display;
      var tw = trayWidth();
      if (raw > 0) {
        // No leading actions in v1: small elastic give to the right.
        display = rubberband(raw, 48);
      } else if (canCommit || raw >= -tw) {
        // 1:1 while revealing; with a destructive full-swipe the drag stays
        // 1:1 past the tray toward the commit point (finger owns the row).
        display = raw;
      } else {
        // No full-swipe action: rubber-band past the tray's rest width.
        display = -tw + rubberband(raw + tw, 64);
      }
      setOffset(display);
      drag.samples.push({ t: e.timeStamp, x: display });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var wasLocked = drag.locked === 'x';
      var samples = drag.samples;
      drag = null;
      wrap.classList.remove('un-dragging');
      if (!wasLocked) return;
      // Anchor the velocity window at the RELEASE moment: dwelling with the
      // finger held still must decay momentum to zero (pointermove stops
      // firing while stationary, so without this the last movement's speed
      // would wrongly survive the pause).
      samples.push({ t: e.timeStamp, x: offset });
      // pointercancel = the browser claimed the gesture (vertical scroll
      // won) — retreat without momentum.
      var v = e.type === 'pointercancel' ? 0 : estimateVelocity(samples);
      var decision = decideSwipeRelease({
        x: offset, v: v, trayWidth: trayWidth(), rowWidth: rowWidth(), canCommit: canCommit,
      });
      if (decision === 'commit') commit(lastAction, v);
      else if (decision === 'open') open(v);
      else close(v);
    }

    // Suppress the click that follows a completed horizontal drag so a
    // swipe never also activates the row's own tap behavior.
    function onClickCapture(e) {
      if (wrap.classList.contains('un-dragging')) { e.stopPropagation(); e.preventDefault(); }
    }

    rowEl.addEventListener('pointerdown', onPointerDown);
    rowEl.addEventListener('pointermove', onPointerMove);
    rowEl.addEventListener('pointerup', onPointerEnd);
    rowEl.addEventListener('pointercancel', onPointerEnd);
    rowEl.addEventListener('click', onClickCapture, true);

    var api = {
      wrap: wrap,
      close: function () { close(0); },
      detach: function () {
        rowEl.removeEventListener('pointerdown', onPointerDown);
        rowEl.removeEventListener('pointermove', onPointerMove);
        rowEl.removeEventListener('pointerup', onPointerEnd);
        rowEl.removeEventListener('pointercancel', onPointerEnd);
        rowEl.removeEventListener('click', onClickCapture, true);
        if (openSwipeRow === api) openSwipeRow = null;
        if (wrap.parentNode) {
          wrap.parentNode.insertBefore(rowEl, wrap);
          wrap.parentNode.removeChild(wrap);
        }
        rowEl.classList.remove('un-swipe-row');
        rowEl.style.transform = '';
      },
    };
    return api;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Pull-to-refresh — the wiring. The travel geometry (PTR_PUCK,
   * PTR_PUCK_GAP, PTR_HOLD, ptrPuckOffset, …) lives above the Node cut
   * so it can be unit-tested; see the "Pull-to-refresh geometry" block.
   * ──────────────────────────────────────────────────────────────────── */

  // First element child that is the app's own, skipping kit chrome.
  function firstContentChild(parent) {
    var el = parent.firstElementChild;
    while (el && el.classList && el.classList.contains('un-ptr-layer')) {
      el = el.nextElementSibling;
    }
    return el;
  }

  // attachPullToRefresh(scrollEl, onRefresh, opts?) — scrollEl is either a
  // scrollable list container (needs `overscroll-behavior-y: contain`; the
  // kit sets it as a belt-and-braces default) OR the window scroller
  // (window / document / document.scrollingElement / <html> / <body>). In
  // window mode the rubberband translate is applied to opts.content
  // (default: document.body.firstElementChild — the #app-style root — or
  // document.body) and the puck's clip layer is fixed-positioned.
  // onRefresh() returns a Promise; the spinner holds until it settles, then
  // lingers PTR_SETTLE_HOLD_MS before retracting so a fast refresh still
  // reads as one. No-op on desktop. Invalid input NEVER throws: it warns
  // once and returns a no-op { detach() }.
  //
  // Returns { detach(), refresh() }. refresh() starts a refresh without a
  // gesture (the UIRefreshControl.beginRefreshing() equivalent) and is a
  // no-op while one is already running.
  //
  // The puck NEVER paints over the app's header. It lives in a clip layer
  // whose top edge is the anchor, and it is stacked BENEATH the header. At
  // rest it sits ENTIRELY below that anchor line, with PTR_PUCK_GAP of
  // space above and below it; during the drag it emerges from under the
  // bar as the content slides away.
  //
  //   opts.topEl  — an Element (typically the fixed/sticky app header)
  //                 whose bottom edge the puck hangs from. Re-measured on
  //                 resize and at the start of every pull, so a collapsing
  //                 or conditionally-rendered header stays correct. May
  //                 also be a FUNCTION returning that Element (or null for
  //                 the default anchor), asked again at every measure: for
  //                 chrome a re-render replaces, which a node captured at
  //                 attach time would outlive.
  //   opts.top    — a fixed anchor offset in px, when there is no element
  //                 to measure.
  //   opts.getScrollTop — optional offset reader when the content's scroll
  //                 owner can change without replacing its gesture target.
  //   opts.pullProperty — element mode, opt-in: a CSS custom property name
  //                 ('--…'). The pull no longer translates the scroller.
  //                 The displayed pull is written to that property on the
  //                 scroller instead (a px length while a pull is out,
  //                 removed at rest), and the page's own CSS slides whatever
  //                 it chooses by it: for chrome that lives INSIDE the
  //                 scroller (a sticky tab strip) and must hold still while
  //                 only what is under it moves. Anchor the puck at that
  //                 chrome's bottom edge with opts.topEl. The layer keeps
  //                 its stacking (level 0, first in tree order), so the puck
  //                 is still revealed by the content sliding away, which
  //                 asks the page that the scroller and the sliding
  //                 content's ancestors paint nothing over the gap.
  //   (default)   — element mode: the scroller's own top edge within its
  //                 parent (i.e. below whatever chrome sits above it);
  //                 window mode: the safe-area top inset.
  function attachPullToRefresh(scrollEl, onRefresh, opts) {
    var noop = { detach: function () {}, refresh: function () {} };
    if (platform === 'desktop') return noop;

    var windowMode = scrollEl === window || scrollEl === document ||
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement || scrollEl === document.body;

    var content; // the element the rubberband translate is written to
    var listenEl; // where the touch listeners live
    var puckHome; // where the puck is inserted

    if (windowMode) {
      // The default content root is the first REAL top-level element:
      // an element-mode PTR on a body-level scroller parks its clip layer
      // at body.firstChild, and translating that instead of the app root
      // would move the puck with the pull.
      content = (opts && opts.content) || firstContentChild(document.body) || document.body;
      if (!content || content.nodeType !== 1) {
        console.warn('[unNative] attachPullToRefresh: opts.content must be an Element — pull-to-refresh disabled.');
        return noop;
      }
      listenEl = window;
      puckHome = document.body;
      // Suppress the browser's own overscroll / native PTR on the page.
      document.documentElement.style.overscrollBehaviorY = 'contain';
      document.body.style.overscrollBehaviorY = 'contain';
    } else {
      if (!scrollEl || scrollEl.nodeType !== 1 ||
          !scrollEl.parentNode || scrollEl.parentNode.nodeType !== 1) {
        console.warn('[unNative] attachPullToRefresh: pass a scrollable Element with an Element parent, or the window/document scroller — pull-to-refresh disabled.');
        return noop;
      }
      content = scrollEl;
      listenEl = scrollEl;
      puckHome = scrollEl.parentNode;
      if (getComputedStyle(puckHome).position === 'static') puckHome.style.position = 'relative';
      scrollEl.style.overscrollBehaviorY = 'contain';
    }

    var anchorEl = opts && opts.topEl && opts.topEl.nodeType === 1 ? opts.topEl : null;
    var anchorFn = opts && typeof opts.topEl === 'function' ? opts.topEl : null;
    var anchorPx = opts && typeof opts.top === 'number' && isFinite(opts.top)
      ? opts.top : null;
    // opts.pullProperty: where the pull goes instead of the scroller's
    // transform. Element mode only (window mode slides opts.content), and
    // only a well-formed custom property name; anything else is the default
    // pull, exactly as before.
    var pullProp = !windowMode && opts && typeof opts.pullProperty === 'string' &&
      /^--[A-Za-z0-9_-]+$/.test(opts.pullProperty) ? opts.pullProperty : null;

    // The anchor Element, asking opts.topEl again when it is a function: a
    // throw or a non-element is no anchor (the default), never an error.
    function anchorElement() {
      if (!anchorFn) return anchorEl;
      var got = null;
      try { got = anchorFn(); } catch (_) { got = null; }
      return got && got.nodeType === 1 ? got : null;
    }

    // The clip layer: an inert box hanging off the anchor. Its overflow
    // clip is what keeps the retracted puck (which sits at -40px) from
    // showing above the anchor line at all — belt to the stacking-order
    // braces below, and the part that holds even when the header above is
    // translucent or has no background of its own.
    var layer = document.createElement('div');
    layer.className = 'un-ptr-layer' + (windowMode ? ' un-ptr-layer-fixed' : '');
    layer.style.height = PTR_LAYER_H + 'px';

    var puck = document.createElement('div');
    puck.className = 'un-ptr-puck';
    puck.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';
    layer.appendChild(puck);
    // FIRST child in element mode: with the layer on stack level 0, tree
    // order puts every later positioned sibling — the header, the
    // scroller — above it. The puck is revealed by the content sliding
    // away, exactly as it is on iOS, and can never overlap the header.
    if (windowMode) puckHome.appendChild(layer);
    else puckHome.insertBefore(layer, puckHome.firstChild);

    // Anchor the layer's top edge. Cheap enough to redo per pull, so a
    // header that collapses / appears mid-session never strands the puck.
    function measureAnchor() {
      var top = null;
      // A header INSIDE the translated content rides down with the pull,
      // so the strip it uncovers is at the very top of the viewport, not
      // below the header's resting line — anchoring under it would park
      // the puck on top of the descending bar. Only a header outside the
      // content (a truly fixed one) is a real anchor.
      // (With opts.pullProperty the chrome inside the scroller is exactly
      // what does NOT ride down, so in element mode it anchors as given.)
      var anchor = anchorElement();
      var el = anchor && !(windowMode && content.contains(anchor)) ? anchor : null;
      if (anchorPx != null) {
        top = anchorPx;
      } else if (el) {
        var r = el.getBoundingClientRect();
        top = windowMode ? r.bottom : r.bottom - puckHome.getBoundingClientRect().top;
      } else if (!windowMode) {
        var sr = scrollEl.getBoundingClientRect();
        // A hidden scroller measures 0 — keep the last good anchor rather
        // than snapping the puck to the top of the shell. Re-measured when
        // a pull locks, so the first pull after a screen shows is correct.
        if (sr.height || sr.width) top = sr.top - puckHome.getBoundingClientRect().top;
      }
      // Window mode with no anchor keeps the stylesheet's safe-area top;
      // the layer's z-index (90) already tucks the puck under .un-navbar.
      if (top != null) layer.style.top = Math.max(0, Math.round(top)) + 'px';
    }
    measureAnchor();
    window.addEventListener('resize', measureAnchor);
    window.addEventListener('orientationchange', measureAnchor);

    var ptrToken = { ptr: true }; // arbiter owner token for this instance
    var display = 0; // current displayed pull (px)
    var refreshing = false;
    var activeSpring = null;
    var settleTimer = null; // post-refresh linger before the puck retracts
    var drag = null; // { startY, startX, baseRaw, locked, samples }
    var armed = false;

    function scrollTop() {
      // A shell page may grow into the document in a browser while this
      // recognizer stays attached to its content (and disappears with it).
      if (opts && typeof opts.getScrollTop === 'function') return opts.getScrollTop();
      return windowMode ? (window.scrollY || 0) : scrollEl.scrollTop;
    }

    // The pull itself: the scroller's transform, or with opts.pullProperty
    // the property the page's CSS slides its content by. Removed, not set to
    // 0, at rest, so the page can tell a pull from none.
    function slide(y) {
      if (!pullProp) content.style.transform = y ? 'translateY(' + y + 'px)' : '';
      else if (y) content.style.setProperty(pullProp, y + 'px');
      else content.style.removeProperty(pullProp);
    }

    function render(y) {
      display = y;
      slide(y);
      var progress = Math.min(1, y / PTR_THRESHOLD);
      puck.style.opacity = String(progress);
      puck.style.transform =
        'translate(-50%, ' + ptrPuckOffset(y) + 'px) scale(' + (0.5 + 0.5 * progress) + ') ' +
        'rotate(' + y * 2.2 + 'deg)';
      var nowArmed = !refreshing && y >= PTR_THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        puck.classList.toggle('un-armed', armed);
        if (armed) haptic();
      }
    }

    function springTo(to, velocity, onRest) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (y) { render(Math.max(0, y)); }, {
        from: display, to: to, velocity: velocity, preset: 'gentle',
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function startRefresh(velocity) {
      refreshing = true;
      puck.classList.add('un-refreshing');
      puck.classList.remove('un-armed');
      springTo(PTR_HOLD, velocity);
      // Hold the spinner for a minimum beat even when onRefresh
      // resolves instantly (cached data, fast network) — a refresh the
      // eye can't see reads as "nothing happened" (UIRefreshControl
      // does the same).
      var minHold = new Promise(function (resolve) { setTimeout(resolve, PTR_MIN_HOLD_MS); });
      var work = Promise.resolve()
        .then(function () { return onRefresh(); })
        .catch(function () { /* refresh failures still settle the UI */ });
      Promise.all([work, minHold]).then(function () {
        // Linger at the hold position after the work settles before
        // retracting. Without it the puck vanishes on the same frame the
        // list repaints, which reads as a glitch rather than a finished
        // refresh — the spinner needs a beat at rest to be seen as one.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () {
          settleTimer = null;
          refreshing = false;
          puck.classList.remove('un-refreshing');
          springTo(0, 0);
        }, PTR_SETTLE_HOLD_MS);
      });
    }

    // THE BLOCKING LISTENER IS ONLY THERE WHILE A PULL CAN START. A
    // non-passive `touchmove` makes the browser wait for this script before
    // it scrolls, on every gesture that starts over the scroller: WebKit
    // and Chromium both decide at touchstart, from the listeners present
    // then, whether a touch's moves must be sent to the page synchronously.
    // Attached for the life of the recognizer it held every scroll of Home,
    // Discover, the leaderboard and the Workshop back on the main thread,
    // mid-list, where no pull can begin. So it is attached only while the
    // content is at its top (or a pull or its settle is in flight), and a
    // passive `scroll` listener moves it on and off as the offset crosses
    // 0; touchstart re-checks for an offset that changed with no scroll
    // event. At the top nothing changes: the listener is there before the
    // finger lands, as it always was.
    var moveBound = false;
    function bindMove(on) {
      if (on === moveBound) return;
      moveBound = on;
      if (on) listenEl.addEventListener('touchmove', onTouchMove, { passive: false });
      else listenEl.removeEventListener('touchmove', onTouchMove, { passive: false });
    }
    function syncMove(top) {
      bindMove(!!drag || !!activeSpring || refreshing || display > 0 ||
        (top == null ? scrollTop() : top) <= 0);
    }
    // Per scroll event this reads only the offset of the element that
    // scrolled, and asks scrollTop() (which may resolve the scroll owner)
    // only when that says the answer may have changed.
    function onScroll(e) {
      var t = e && e.target;
      var own = t && t.nodeType === 1 ? t.scrollTop : (window.scrollY || 0);
      if ((own <= 0) === moveBound) return;
      syncMove();
    }
    // Element mode scrolls the element; a getScrollTop reader means the
    // document may be the scroller instead (the platform's browser pages).
    var scrollTargets = windowMode ? [window]
      : (opts && typeof opts.getScrollTop === 'function' ? [scrollEl, window] : [scrollEl]);

    function onTouchStart(e) {
      if (refreshing || e.touches.length !== 1) return;
      var top = scrollTop();
      syncMove(top);
      if (top > 0 && !activeSpring && display === 0) return;
      var baseRaw = 0;
      if (activeSpring) {
        // Catch the list mid-settle — which means claiming the sequence
        // up front; re-enter the drag at the equivalent raw pull so
        // rubberband(raw) === the current displayed offset.
        if (!gestures.claim('touch', ptrToken)) return;
        activeSpring.stop();
        activeSpring = null;
        baseRaw = rubberbandInvert(display, PTR_LIMIT, PTR_COEFF);
      }
      drag = {
        startY: e.touches[0].clientY,
        startX: e.touches[0].clientX,
        baseRaw: baseRaw,
        locked: baseRaw > 0 ? 'y' : null,
        samples: [{ t: e.timeStamp, x: display }],
      };
    }

    function onTouchMove(e) {
      if (!drag || refreshing) return;
      var dy = e.touches[0].clientY - drag.startY;
      var dx = e.touches[0].clientX - drag.startX;
      if (!drag.locked) {
        if (scrollTop() > 0) { drag = null; return; }
        var axis = lockIntent(dx, dy);
        if (axis === 'x') { drag = null; return; }
        if (axis === 'y' && dy > 0) {
          if (!gestures.claim('touch', ptrToken)) {
            // Another recognizer (a swipe row, an app gesture) owns this
            // finger — back off for good.
            drag = null;
            return;
          }
          drag.locked = 'y';
          // Measured here, where a pull has actually begun, rather than on
          // every touchstart: the anchor is two rect reads, and a touch that
          // becomes a scroll or a tap never needs them.
          measureAnchor();
        } else if (axis === 'y') { drag = null; return; }
      }
      if (drag.locked !== 'y') return;
      var raw = drag.baseRaw + dy;
      if (raw <= 0) { render(0); drag.samples.push({ t: e.timeStamp, x: 0 }); return; }
      // We own the gesture: stop the browser from scrolling / native PTR.
      // (Registered non-passive for exactly this call.)
      e.preventDefault();
      render(rubberband(raw, PTR_LIMIT, PTR_COEFF));
      drag.samples.push({ t: e.timeStamp, x: display });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onTouchEnd(e) {
      if (!drag) return;
      var samples = drag.samples;
      var locked = drag.locked === 'y';
      drag = null;
      // A touch that scrolled away with no momentum left no scroll event
      // behind to take the blocking listener off; do it here.
      if (!locked || display === 0) { syncMove(); return; }
      // Anchor the velocity window at release (see the swipe handler) so a
      // held-still pause decays momentum before the commit decision.
      samples.push({ t: e.timeStamp, x: display });
      var v = estimateVelocity(samples);
      if (decidePtrRelease({ pull: display, v: v, threshold: PTR_THRESHOLD })) startRefresh(v);
      else springTo(0, v);
    }

    listenEl.addEventListener('touchstart', onTouchStart, { passive: true });
    listenEl.addEventListener('touchend', onTouchEnd, { passive: true });
    listenEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
    scrollTargets.forEach(function (el) { el.addEventListener('scroll', onScroll, { passive: true }); });
    syncMove();

    return {
      // Programmatic refresh — the kit's beginRefreshing(). Used by the
      // demo page's ?un-demo=ptr-hold screenshot state; a no-op while a
      // refresh is already running.
      refresh: function () {
        if (refreshing) return;
        startRefresh(0);
      },
      detach: function () {
        listenEl.removeEventListener('touchstart', onTouchStart);
        bindMove(false);
        listenEl.removeEventListener('touchend', onTouchEnd);
        listenEl.removeEventListener('touchcancel', onTouchEnd);
        scrollTargets.forEach(function (el) { el.removeEventListener('scroll', onScroll, { passive: true }); });
        window.removeEventListener('resize', measureAnchor);
        window.removeEventListener('orientationchange', measureAnchor);
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        if (activeSpring) activeSpring.stop();
        if (layer.parentNode) layer.parentNode.removeChild(layer);
        slide(0);
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Drag-to-reorder — long-press lift on touch (handles lift immediately),
   * pointer drag on desktop. 1:1 finger tracking, overlay drop indicator
   * (a fixed body-level bar — never a row box-shadow, which clips against
   * a group card's overflow:hidden at the first/last row), edge
   * auto-scroll with per-frame re-hit-testing, spring settle on drop.
   * No HTML5 drag-and-drop on any platform.
   * ──────────────────────────────────────────────────────────────────── */

  var REORDER_LONG_PRESS_MS = 400;
  var REORDER_SLOP = 8; // px of pre-lift movement that cancels the long press
  var REORDER_EDGE = 48; // auto-scroll edge band
  var REORDER_MAX_SCROLL = 14; // px per frame at the edge

  // attachReorder(listEl, { handle?, itemSelector?, longPressMs?, grid?,
  // canDrop?, onLift?, onReorder?, onSettle? }) — items default to listEl's
  // element children minus .un-group-header / kit chrome; pass itemSelector
  // for grouped markup (it may match across nested section containers —
  // cross-section moves work because indices span the whole matched list).
  // onLift(itemEl) fires when a drag lifts (defer re-renders there);
  // onReorder(from, to, itemEl) runs AFTER the kit has moved the element in
  // the DOM (persist the order there); onSettle(moved) fires once the
  // settle spring finishes — for drops, cancels, and a mid-lift detach —
  // with moved=true iff onReorder ran for the gesture. Returns
  // { detach() }; never throws on bad input.
  //
  // grid: true (opt-in) switches from the LIST model (item translates on
  // Y only, siblings hold still, an accent line marks the drop gap) to the
  // homescreen DISPLACEMENT model for multi-column tile grids: a fixed-
  // position ghost clone tracks the pointer on BOTH axes, the real item
  // stays in flow restyled as a dashed drop slot (.un-reorder-slot), and
  // as the pointer crosses tiles the slot moves live through the DOM
  // while siblings FLIP-animate aside. Drop indexing is cell-accurate
  // (gridDropSide: x-half within a row, y-half for full-width tiles).
  // Desktop lift needs no axis lock — movement past the slop in any
  // direction lifts. The from/to indices, canDrop veto, and callback
  // order are identical to list mode.
  function attachReorder(listEl, options) {
    var noop = { detach: function () {} };
    if (!listEl || listEl.nodeType !== 1) {
      console.warn('[unNative] attachReorder: listEl must be an Element — reorder disabled.');
      return noop;
    }
    var opts = options || {};
    var handleSel = typeof opts.handle === 'string' ? opts.handle : null;
    var itemSel = typeof opts.itemSelector === 'string' ? opts.itemSelector : null;
    var longPressMs = opts.longPressMs != null ? opts.longPressMs : REORDER_LONG_PRESS_MS;
    var gridMode = opts.grid === true;
    var token = { reorder: listEl };

    var drag = null; // see states below
    var activeSpring = null;
    var indicator = null;
    var raf = null;
    var suppressClick = false;
    // Grid mode: completes an in-flight ghost settle if detach() stops
    // the spring before onRest — the ghost must never outlive the handle
    // and onSettle must still fire.
    var pendingFinish = null;

    function matchedItems() {
      var els = itemSel
        ? Array.prototype.slice.call(listEl.querySelectorAll(itemSel))
        : Array.prototype.slice.call(listEl.children);
      return els.filter(function (el) {
        return el.nodeType === 1 && !el.classList.contains('un-group-header') &&
          !el.classList.contains('un-reorder-indicator');
      });
    }

    if (handleSel) {
      // touch-action: none on handles so the browser never contests a drag
      // that starts on one (matching iOS reorder grabbers). Late-rendered
      // handles that carry the class themselves get it from the stylesheet.
      matchedItems().forEach(function (item) {
        var h = item.querySelector(handleSel);
        if (h) h.classList.add('un-reorder-handle');
      });
    }

    function findScroller() {
      var node = listEl.parentNode;
      while (node && node.nodeType === 1 && node !== document.body) {
        var s = getComputedStyle(node);
        if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight) return node;
        node = node.parentNode;
      }
      return null; // window scroller
    }

    function scrollPos(scroller) {
      return scroller ? scroller.scrollTop : (window.scrollY || 0);
    }

    // Cached lift-time rects adjusted for scroll since lift: siblings never
    // move during the drag (indicator model), so cache + scroll delta stays
    // exact and avoids re-measuring the transformed item (gBCR includes
    // transforms, which would poison the hit-test).
    function currentRects() {
      var d = scrollPos(drag.scroller) - drag.scrollBase;
      return drag.rects.map(function (r) {
        return { top: r.top - d, bottom: r.bottom - d, left: r.left, width: r.width };
      });
    }

    function setLiftTransform(ty) {
      drag.ty = ty;
      drag.item.style.transform = 'translateY(' + ty + 'px)';
    }

    function ensureIndicator() {
      if (indicator) return indicator;
      indicator = document.createElement('div');
      indicator.className = 'un-reorder-indicator';
      // Body-mounted (so overflow:hidden group cards can't clip it), which
      // means it would resolve --un-accent from :root — copy the LIST's
      // resolved accent so wrapper-level re-theming still applies.
      try {
        var accent = getComputedStyle(listEl).getPropertyValue('--un-accent');
        if (accent) indicator.style.setProperty('--un-accent', accent.trim());
      } catch (e) { /* ignore */ }
      document.body.appendChild(indicator);
      return indicator;
    }

    function updateIndicator(rects, gap) {
      if (gap == null || gap === drag.fromIndex || gap === drag.fromIndex + 1) {
        if (indicator) indicator.style.display = 'none';
        return;
      }
      var el = ensureIndicator();
      var n = rects.length;
      var y = gap < n ? rects[gap].top : rects[n - 1].bottom;
      var anchor = rects[Math.min(gap, n - 1)];
      el.style.display = '';
      el.style.top = y + 'px';
      el.style.left = (anchor.left + 8) + 'px';
      el.style.width = Math.max(0, anchor.width - 16) + 'px';
    }

    function update() {
      if (!drag || !drag.lifted) return;
      // Grid mode: the ghost is fixed-position and pinned to the pointer
      // (no scroll compensation needed); the slot hit-test IS live, so
      // the auto-scroll loop's re-update keeps it tracking.
      if (gridMode) return gridUpdate();
      // The item tracks the finger in VIEWPORT space: compensate for any
      // content scrolled under a stationary pointer.
      var scrollDelta = scrollPos(drag.scroller) - drag.scrollBase;
      setLiftTransform(drag.lastY - drag.liftY + scrollDelta);
      var rects = currentRects();
      var gap = reorderDropIndex(drag.lastY, rects);
      var to = gap > drag.fromIndex ? gap - 1 : gap;
      if (to !== drag.fromIndex && opts.canDrop && opts.canDrop(drag.item, to) === false) {
        gap = null; // vetoed slot: no indicator, release springs home
      }
      if (gap !== drag.gap) {
        if (drag.gap != null && gap != null) haptic(5); // slot-change tick
        drag.gap = gap;
      }
      updateIndicator(rects, gap);
    }

    function autoScrollFrame() {
      if (!drag || !drag.lifted) { raf = null; return; }
      var viewTop = 0;
      var viewBottom = window.innerHeight;
      if (drag.scroller) {
        var sr = drag.scroller.getBoundingClientRect();
        viewTop = Math.max(0, sr.top);
        viewBottom = Math.min(window.innerHeight, sr.bottom);
      }
      var v = autoScrollVelocity(drag.lastY, viewTop, viewBottom, REORDER_EDGE, REORDER_MAX_SCROLL);
      if (v) {
        if (drag.scroller) drag.scroller.scrollTop += v;
        else window.scrollBy(0, v);
        update(); // content slid under the pointer: re-hit-test
      }
      raf = requestAnimationFrame(autoScrollFrame);
    }

    /* ── Grid (displacement) mode ─────────────────────────────────────
     * The real item stays in flow as the dashed drop slot and moves LIVE
     * through the DOM as the pointer crosses tiles; a body-mounted ghost
     * clone tracks the pointer on both axes. Cached rects are useless
     * here (siblings move), so hit-testing is live elementFromPoint —
     * the ghost is pointer-events: none so it never occludes it. */

    // Matched item under the viewport point, or null. Hits on headers,
    // deadspace, and the dragged item itself fall through (the slot
    // simply stays put).
    function gridHitItem(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el || el.nodeType !== 1 || !listEl.contains(el)) return null;
      var m;
      if (itemSel) {
        m = el.closest ? el.closest(itemSel) : null;
      } else {
        m = el;
        while (m && m.parentNode !== listEl) m = m.parentNode;
      }
      if (!m || m === drag.item || !listEl.contains(m)) return null;
      if (m.classList.contains('un-group-header') ||
          m.classList.contains('un-reorder-indicator')) return null;
      return m;
    }

    // FLIP-animate every matched sibling across the DOM move: measure
    // where each one is RIGHT NOW (mid-animation positions included, so
    // rapid slot changes retarget smoothly), apply the move, then play
    // each from its old spot to its new grid position.
    function gridFlip(applyMove) {
      if (prefersReducedMotion) { applyMove(); return; }
      var sibs = matchedItems().filter(function (el) { return el !== drag.item; });
      var first = sibs.map(function (el) { return el.getBoundingClientRect(); });
      applyMove();
      var i;
      // Clear in-flight transforms so the post-move measurement is the
      // true layout position, not a mid-transition one.
      for (i = 0; i < sibs.length; i++) {
        sibs[i].style.transition = 'none';
        sibs[i].style.transform = '';
      }
      for (i = 0; i < sibs.length; i++) {
        var last = sibs[i].getBoundingClientRect();
        var dx = first[i].left - last.left;
        var dy = first[i].top - last.top;
        if (dx || dy) sibs[i].style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      }
      // Flush the inverted transforms before enabling transitions, so the
      // jump back to the old position isn't itself animated.
      void listEl.offsetHeight;
      requestAnimationFrame(function () {
        for (var j = 0; j < sibs.length; j++) {
          sibs[j].style.transition = 'transform 200ms ease';
          sibs[j].style.transform = '';
        }
      });
    }

    // Clear every FLIP style this gesture may have left on matched items.
    function gridClearSibs() {
      var items = matchedItems();
      for (var i = 0; i < items.length; i++) {
        items[i].style.transition = '';
        items[i].style.transform = '';
      }
    }

    function gridLift(e) {
      var items = matchedItems();
      var fromIndex = items.indexOf(drag.item);
      if (fromIndex < 0) { drag = null; return; }
      drag.lifted = true;
      drag.fromIndex = fromIndex;
      drag.scroller = findScroller();
      drag.liftX = drag.lastX;
      drag.liftY = drag.lastY;
      drag.gx = 0;
      drag.gy = 0;
      // Where the item lifted from, for pointercancel / detach restores.
      drag.origParent = drag.item.parentNode;
      drag.origNext = drag.item.nextElementSibling;
      haptic();
      // Capture on the LIST, not the item: the live displacement below
      // removes + reinserts the item, and Chromium releases pointer
      // capture the moment the captured element leaves the DOM — capture
      // on the item would die on the first slot move.
      if (e && typeof e.pointerId === 'number') {
        try { listEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      // "Pick up": a fixed-position clone floats above the page and
      // tracks the pointer; pointer-events: none keeps it invisible to
      // gridHitItem's elementFromPoint.
      var rect = drag.item.getBoundingClientRect();
      drag.ghostLeft = rect.left;
      drag.ghostTop = rect.top;
      var ghost = drag.item.cloneNode(true);
      ghost.classList.add('un-reorder-ghost');
      // Layout-critical styles go INLINE: the clone keeps the host's own
      // classes, and a utility like Tailwind's `relative` would tie the
      // ghost class on specificity and win on stylesheet order — the
      // ghost must be viewport-fixed no matter what it cloned.
      ghost.style.position = 'fixed';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      ghost.style.margin = '0';
      ghost.style.zIndex = '9985';
      ghost.style.pointerEvents = 'none';
      // Transparent tiles get a surface of their own (same rationale as
      // the list mode's lifted-row background), resolved from the LIST so
      // wrapper-level re-theming still applies to the body-mounted ghost.
      var bg = getComputedStyle(drag.item).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
        try {
          var surface = getComputedStyle(listEl).getPropertyValue('--un-group-bg');
          ghost.style.background = surface ? surface.trim() : '';
        } catch (err) { /* ignore */ }
      }
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      // The real item stays in the grid as the drop slot (dashed box,
      // contents hidden — see .un-reorder-slot in native.css).
      drag.item.classList.add('un-reorder-slot');
      listEl.classList.add('un-reordering');
      if (opts.onLift) {
        try { opts.onLift(drag.item); } catch (err) { /* ignore */ }
      }
      update();
      raf = requestAnimationFrame(autoScrollFrame);
    }

    function gridUpdate() {
      drag.gx = drag.lastX - drag.liftX;
      drag.gy = drag.lastY - drag.liftY;
      drag.ghost.style.transform = 'translate(' + drag.gx + 'px, ' + drag.gy + 'px)';
      var target = gridHitItem(drag.lastX, drag.lastY);
      if (!target) return; // deadspace / header / own slot: slot stays put
      var r = target.getBoundingClientRect();
      var side = gridDropSide(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        listEl.getBoundingClientRect().width,
        drag.lastX, drag.lastY
      );
      var items = matchedItems();
      var cur = items.indexOf(drag.item);
      var overIdx = items.indexOf(target);
      if (cur < 0 || overIdx < 0) return;
      // Prospective post-removal insertion index — the same semantics as
      // list mode's `to`, so canDrop contracts carry over unchanged.
      var without = overIdx - (cur < overIdx ? 1 : 0);
      var to = side === 'before' ? without : without + 1;
      if (to === cur) return; // already in that slot (covers DOM no-ops)
      if (to !== drag.fromIndex && opts.canDrop && opts.canDrop(drag.item, to) === false) {
        return; // vetoed slot: the placeholder visibly refuses to move
      }
      haptic(5); // slot-change tick
      gridFlip(function () {
        if (side === 'before') target.parentNode.insertBefore(drag.item, target);
        else target.parentNode.insertBefore(drag.item, target.nextSibling);
      });
    }

    // Grid release/cancel: glide the ghost onto the slot, swap the real
    // item back in, then fire onReorder (the DOM move already happened
    // live — the callback still runs after it, honoring the contract)
    // and onSettle.
    function gridRelease(cancelled) {
      var item = drag.item;
      var ghost = drag.ghost;
      var from = drag.fromIndex;
      if (cancelled && drag.origParent) {
        // Browser took the gesture mid-drag: dropping at the current
        // position would commit a move the user may not have meant —
        // put the item back where it lifted from.
        try { drag.origParent.insertBefore(item, drag.origNext); } catch (err) { /* ignore */ }
      }
      var to = matchedItems().indexOf(item);
      var moved = !cancelled && to >= 0 && to !== from;
      if (moved) haptic();
      var slotRect = item.getBoundingClientRect();
      var gx = drag.gx;
      var gy = drag.gy;
      var tx = slotRect.left - drag.ghostLeft;
      var ty = slotRect.top - drag.ghostTop;
      function finish() {
        pendingFinish = null;
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        item.classList.remove('un-reorder-slot');
        gridClearSibs();
        if (moved && opts.onReorder) opts.onReorder(from, to, item);
        if (opts.onSettle) {
          try { opts.onSettle(moved); } catch (err) { /* ignore */ }
        }
      }
      clearLiftVisuals();
      drag = null;
      if (prefersReducedMotion || (Math.abs(tx - gx) < 1 && Math.abs(ty - gy) < 1)) {
        finish();
        return;
      }
      if (activeSpring) activeSpring.stop();
      pendingFinish = finish;
      ghost.classList.add('un-reorder-ghost-drop'); // scale eases back to 1
      activeSpring = glideGhost(ghost, gx, gy, tx, ty, function () {
        activeSpring = null;
        finish();
      });
    }

    function lift(e) {
      if (gridMode) return gridLift(e);
      var items = matchedItems();
      var fromIndex = items.indexOf(drag.item);
      if (fromIndex < 0) { drag = null; return; }
      var scroller = findScroller();
      drag.lifted = true;
      drag.fromIndex = fromIndex;
      drag.items = items;
      drag.scroller = scroller;
      drag.scrollBase = scrollPos(scroller);
      drag.rects = items.map(function (el) {
        var r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
      });
      drag.liftY = drag.lastY;
      drag.gap = null;
      drag.ty = 0;
      haptic();
      // Un-clip overflow:hidden ancestors (group cards, swipe wraps) for
      // the duration of the drag, or the lifted row vanishes the moment it
      // translates outside its own card. Scroll containers (auto/scroll)
      // are left alone. Restored when the settle finishes.
      drag.unclipped = [];
      var node = drag.item.parentNode;
      while (node && node.nodeType === 1) {
        var ov = getComputedStyle(node).overflowY;
        if (ov === 'hidden' || ov === 'clip') {
          drag.unclipped.push({ node: node, prev: node.style.overflow });
          node.style.overflow = 'visible';
        }
        if (node === listEl) break;
        node = node.parentNode;
      }
      // Grouped rows are usually transparent (the card paints the surface):
      // give the lifted row a surface of its own so it stays legible while
      // floating over other content.
      var bg = getComputedStyle(drag.item).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
        drag.item.style.background = 'var(--un-group-bg)';
        drag.bgSet = true;
      }
      drag.item.classList.add('un-reorder-lifting');
      listEl.classList.add('un-reordering');
      if (e && typeof e.pointerId === 'number') {
        try { drag.item.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      if (opts.onLift) {
        try { opts.onLift(drag.item); } catch (err) { /* ignore */ }
      }
      update();
      raf = requestAnimationFrame(autoScrollFrame);
    }

    // Drop the indicator / auto-scroll loop / list cursor state. The
    // lifted item's own class stays until the settle finishes so it keeps
    // its elevation while springing into place.
    function clearLiftVisuals() {
      listEl.classList.remove('un-reordering');
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }

    // Settle the lifted item to targetTy with a spring, run done, clean up.
    // Reduced motion settles instantly. `moved` is passed through to
    // onSettle so the host knows whether onReorder ran for this gesture.
    function settle(targetTy, done, moved) {
      var item = drag.item;
      var fromTy = drag.ty;
      var unclipped = drag.unclipped || [];
      var bgSet = drag.bgSet;
      function finish() {
        item.style.transform = '';
        item.classList.remove('un-reorder-lifting');
        if (bgSet) item.style.background = '';
        unclipped.forEach(function (u) { u.node.style.overflow = u.prev; });
        if (done) done();
        if (opts.onSettle) {
          try { opts.onSettle(!!moved); } catch (err) { /* ignore */ }
        }
      }
      clearLiftVisuals();
      drag = null;
      if (prefersReducedMotion || Math.abs(fromTy - targetTy) < 1) { finish(); return; }
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (v) {
        item.style.transform = 'translateY(' + v + 'px)';
      }, {
        from: fromTy, to: targetTy, velocity: 0, preset: 'stiff',
        onRest: function () { activeSpring = null; finish(); },
      });
    }

    function release(cancelled) {
      if (!drag) return;
      if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
      if (!drag.lifted) { drag = null; return; }
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      if (gridMode) return gridRelease(cancelled);
      var gap = cancelled ? null : drag.gap;
      var from = drag.fromIndex;
      var item = drag.item;
      var items = drag.items;
      var rects = currentRects();
      var n = rects.length;
      var to = gap == null ? from : (gap > from ? gap - 1 : gap);
      if (gap == null || to === from || gap === from + 1) {
        settle(0, null, false); // home: no move, no onReorder
        return;
      }
      haptic();
      // Where the item's top lands after the DOM move (siblings between the
      // origin and the gap shift by the item's height; the gap-side
      // neighbour holds still).
      var itemH = rects[from].bottom - rects[from].top;
      var gapTop = gap < n ? rects[gap].top : rects[n - 1].bottom;
      var targetTy = gapTop - (to > from ? itemH : 0) - rects[from].top;
      settle(targetTy, function () {
        var ref = gap < n ? items[gap] : null;
        if (ref) ref.parentNode.insertBefore(item, ref);
        else items[n - 1].parentNode.appendChild(item);
        if (opts.onReorder) opts.onReorder(from, to, item);
      }, true);
    }

    function onPointerDown(e) {
      if (drag || e.button > 0) return;
      var items = matchedItems();
      var item = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].contains(e.target)) { item = items[i]; break; }
      }
      if (!item) return;
      var onHandle = !!(handleSel && e.target.nodeType === 1 &&
        e.target.closest && e.target.closest(handleSel) && item.contains(e.target.closest(handleSel)));
      var isTouch = e.pointerType === 'touch';
      // Desktop with a declared handle: only the handle arms a drag.
      if (!isTouch && handleSel && !onHandle) return;
      drag = {
        pointerId: e.pointerId,
        seq: gestureSeq(e),
        item: item,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        lifted: false,
        armed: false,
        pressTimer: null,
      };
      if (onHandle) {
        // A handle is a dedicated grabber: claim and lift immediately.
        if (!gestures.claim(drag.seq, token)) { drag = null; return; }
        lift(e);
      } else if (isTouch) {
        // Long-press lift; any pre-lift movement past the slop cancels so
        // scroll / swipe / PTR keep working on the same rows.
        drag.pressTimer = setTimeout(function () {
          if (!drag || drag.lifted) return;
          drag.pressTimer = null;
          if (!gestures.claim(drag.seq, token)) { drag = null; return; }
          lift(e);
        }, longPressMs);
      } else {
        drag.armed = true; // desktop, no handle: lift once the y-axis locks
      }
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!drag.lifted) {
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        if (drag.pressTimer) {
          if (Math.abs(dx) > REORDER_SLOP || Math.abs(dy) > REORDER_SLOP) {
            clearTimeout(drag.pressTimer);
            drag = null;
          }
          return;
        }
        if (drag.armed) {
          if (gridMode) {
            // Grid drags are 2D — any-direction movement past the slop
            // lifts (a y-axis lock would swallow horizontal pulls).
            if (dx * dx + dy * dy > REORDER_SLOP * REORDER_SLOP) {
              if (!gestures.claim(drag.seq, token)) { drag = null; return; }
              lift(e);
            }
            return;
          }
          var axis = lockIntent(dx, dy);
          if (axis === 'x') { drag = null; return; }
          if (axis === 'y') {
            if (!gestures.claim(drag.seq, token)) { drag = null; return; }
            lift(e);
          }
        }
        return;
      }
      update();
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      release(false);
    }

    function onPointerCancel(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      release(true);
    }

    // We own the finger after a lift: stop the browser from scrolling.
    // Registered non-passive for exactly this call; while the long press is
    // still pending the page scrolls normally.
    function onTouchMove(e) {
      if (drag && drag.lifted) e.preventDefault();
    }

    // A completed drag must not also activate the row's own tap behavior.
    function onClickCapture(e) {
      if (suppressClick || (drag && drag.lifted)) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    listEl.addEventListener('pointerdown', onPointerDown);
    listEl.addEventListener('pointermove', onPointerMove);
    listEl.addEventListener('pointerup', onPointerUp);
    listEl.addEventListener('pointercancel', onPointerCancel);
    listEl.addEventListener('touchmove', onTouchMove, { passive: false });
    listEl.addEventListener('click', onClickCapture, true);

    return {
      detach: function () {
        listEl.removeEventListener('pointerdown', onPointerDown);
        listEl.removeEventListener('pointermove', onPointerMove);
        listEl.removeEventListener('pointerup', onPointerUp);
        listEl.removeEventListener('pointercancel', onPointerCancel);
        listEl.removeEventListener('touchmove', onTouchMove);
        listEl.removeEventListener('click', onClickCapture, true);
        if (drag) {
          if (drag.pressTimer) clearTimeout(drag.pressTimer);
          var wasLifted = drag.lifted;
          if (gridMode && wasLifted) {
            // Grid teardown: drop the ghost, un-slot the item, and put it
            // back where it lifted from (the host is about to re-render
            // anyway, but a detach with no re-render must not leave the
            // grid half-shuffled).
            if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
            if (drag.item) {
              drag.item.classList.remove('un-reorder-slot');
              if (drag.origParent) {
                try { drag.origParent.insertBefore(drag.item, drag.origNext); } catch (err) { /* ignore */ }
              }
            }
            gridClearSibs();
          } else if (drag.item) {
            drag.item.style.transform = '';
            drag.item.classList.remove('un-reorder-lifting');
            if (drag.bgSet) drag.item.style.background = '';
          }
          (drag.unclipped || []).forEach(function (u) { u.node.style.overflow = u.prev; });
          drag = null;
          // A mid-lift teardown never reaches settle(); fire onSettle here
          // so a host deferral flag set in onLift can't get stuck.
          if (wasLifted && opts.onSettle) {
            try { opts.onSettle(false); } catch (err) { /* ignore */ }
          }
        }
        if (activeSpring) { activeSpring.stop(); activeSpring = null; }
        // A grid ghost settle stopped mid-spring still owes its cleanup
        // and callbacks — run it now so the ghost can't outlive the handle.
        if (pendingFinish) {
          var f = pendingFinish;
          pendingFinish = null;
          f();
        }
        clearLiftVisuals();
        listEl.classList.remove('un-reordering');
      },
    };
  }

  // attachGridPlacement(listEl, { itemSelector?, handle?, longPressMs?,
  // cellFromPoint, canPlace?, onLift?, onHover?, onPlace?, onSettle? }) —
  // FREE-FORM placement on a fixed grid, the iOS-homescreen model: a lifted
  // tile can be dropped in ANY cell, including one with nothing around it,
  // and nothing re-packs behind it.
  //
  // This is a sibling of attachReorder's grid mode, not a flag on it, because
  // the two have incompatible contracts. attachReorder speaks in a DENSE
  // INDEX SPACE — onReorder(from, to, item) over a list where every position
  // is occupied — and it enforces that model by moving the real item through
  // the DOM live while siblings FLIP aside. Free placement has no such index
  // (a layout with holes isn't an ordering) and must leave every other item
  // exactly where it is. Overloading `to` with a cell would have made both
  // callers lie.
  //
  // What IS shared, deliberately, is all the physics: the same fixed-position
  // ghost clone tracking the pointer on both axes, the same
  // .un-reorder-slot / .un-reorder-ghost treatment, the same long-press-on-
  // touch / slop-on-desktop arming, pointer capture on the LIST (not the
  // item), edge auto-scroll, haptics, the settle spring, and the same
  // gesture-arbiter claim. A tile dragged here feels identical to a row
  // dragged there.
  //
  // DIVISION OF LABOUR: the kit owns the GESTURE, the host owns the GEOMETRY.
  // The kit never computes a cell — it asks `cellFromPoint(x, y, info)`, which
  // for a host that renders a real grid overlay is a one-line elementFromPoint
  // + closest('[data-cell]'). That keeps the kit free of any assumption about
  // row heights, gaps or `grid-template-columns`, and it means the highlight
  // the user sees and the cell the drop commits to are resolved by the same
  // code path. `info` is the dragged tile's own live geometry, so the host can
  // answer from the TILE (its centroid) rather than from the finger — see
  // below.
  //
  //   cellFromPoint(x, y, info) → any host cell token, or null over deadspace.
  //                              Compared with `sameCell` below, so it may be
  //                              an object ({ col, row }) or a string.
  //                              x/y are the POINTER. `info` describes the
  //                              dragged TILE — { item, rect: {left, top,
  //                              width, height}, centerX, centerY, pointerX,
  //                              pointerY }, the ghost's live viewport
  //                              geometry — and RESOLVING FROM THE TILE IS
  //                              THE RECOMMENDED ANSWER. The ghost tracks the
  //                              finger from wherever it was grabbed, so the
  //                              pointer sits a grab-offset away from the
  //                              tile's own box: a host that answers from x/y
  //                              puts the highlight that same offset away
  //                              from the tile the user is looking at, which
  //                              for a multi-cell item can be a whole tile's
  //                              worth. Answer from `centerX`/`centerY` minus
  //                              half the item's own footprint instead — the
  //                              CENTROID rule — and the highlight sits under
  //                              the tile whatever corner it was picked up by.
  //                              (The centre is also the one point the ghost's
  //                              1.04 lift scale leaves untouched.) x/y keep
  //                              their meaning, so a host that ignores `info`
  //                              behaves exactly as it did before.
  //   canPlace(item, cell)     → false vetoes: no highlight, release springs
  //                              home. Called on every cell CHANGE, not per
  //                              frame.
  //   onHover(item, cell, ok)  → paint/clear whatever the host wants to show
  //                              for this target. A highlight is the minimum;
  //                              a host whose drop DISPLACES occupants should
  //                              also preview that here (move the items that
  //                              would be pushed to where they'd land), since
  //                              this is the only place it knows the target
  //                              before the release. Fires on every cell
  //                              CHANGE, not per frame, so it is cheap enough
  //                              to re-derive a plan in. cell is
  //                              null when the pointer leaves the grid, and
  //                              once more at the END of a committed drop —
  //                              after the ghost has finished flying, so a
  //                              displacement preview holds still through
  //                              the release instead of snapping back under
  //                              the travelling tile.
  //   rectForCell(item, cell)  → where a COMMITTED drop lands, in viewport
  //                              coords ({ left, top } — a DOMRect from the
  //                              host's own overlay cell is the natural
  //                              answer). The ghost's release spring settles
  //                              here, so the tile flies from the finger to
  //                              the cell it is landing in. Omit it and the
  //                              ghost settles on the item's own rect, which
  //                              in this mode is still the ORIGIN cell — the
  //                              tile flies back to where it was picked up
  //                              and then jumps to the drop cell. Any host
  //                              that moves items on drop should implement
  //                              it. Return null to fall back.
  //   onPlace(item, cell)      → committed drop. Fires before onSettle, and
  //                              only for a legal, changed cell.
  //   onLift(item) / onSettle(placed) → same deferral contract as
  //                              attachReorder: hold a re-render flag in
  //                              onLift, flush it in onSettle, which fires on
  //                              every path including cancel and detach.
  //
  // Returns { detach() }; never throws on bad input.
  function attachGridPlacement(listEl, options) {
    var noop = { detach: function () {} };
    if (!listEl || listEl.nodeType !== 1) {
      console.warn('[unNative] attachGridPlacement: listEl must be an Element — placement disabled.');
      return noop;
    }
    var opts = options || {};
    if (typeof opts.cellFromPoint !== 'function') {
      console.warn('[unNative] attachGridPlacement: opts.cellFromPoint must be a function — placement disabled.');
      return noop;
    }
    var itemSel = typeof opts.itemSelector === 'string' ? opts.itemSelector : null;
    var handleSel = typeof opts.handle === 'string' ? opts.handle : null;
    var longPressMs = opts.longPressMs != null ? opts.longPressMs : REORDER_LONG_PRESS_MS;
    var token = { placement: listEl };

    var drag = null;
    var activeSpring = null;
    var raf = null;
    var suppressClick = false;
    var pendingFinish = null;

    function matched() {
      var els = itemSel
        ? Array.prototype.slice.call(listEl.querySelectorAll(itemSel))
        : Array.prototype.slice.call(listEl.children);
      return els.filter(function (el) {
        return el.nodeType === 1 && !el.classList.contains('un-group-header');
      });
    }

    // Cells are host-defined tokens, so identity can't be assumed. Objects
    // compare on col/row (the shape every host actually uses); anything else
    // compares by value.
    function sameCell(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      if (typeof a === 'object' && typeof b === 'object') {
        return a.col === b.col && a.row === b.row;
      }
      return false;
    }

    function findScroller() {
      var node = listEl.parentNode;
      while (node && node.nodeType === 1 && node !== document.body) {
        var s = getComputedStyle(node);
        if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight) return node;
        node = node.parentNode;
      }
      return null;
    }

    function hover(cell, ok) {
      if (!opts.onHover) return;
      try { opts.onHover(drag.item, cell, ok); } catch (err) { /* ignore */ }
    }

    // The dragged TILE's live geometry, for a host that resolves its target
    // from the tile rather than from the finger (see cellFromPoint's third
    // argument in the doc block above). Pure arithmetic: the ghost is
    // position:fixed, so its viewport rect is the lift rect plus the current
    // translate — no getBoundingClientRect() on a per-move path.
    function ghostInfo() {
      var left = drag.ghostLeft + drag.gx;
      var top = drag.ghostTop + drag.gy;
      return {
        item: drag.item,
        rect: { left: left, top: top, width: drag.ghostW, height: drag.ghostH },
        centerX: left + drag.ghostW / 2,
        centerY: top + drag.ghostH / 2,
        pointerX: drag.lastX,
        pointerY: drag.lastY,
      };
    }

    function update() {
      if (!drag || !drag.lifted) return;
      drag.gx = drag.lastX - drag.liftX;
      drag.gy = drag.lastY - drag.liftY;
      drag.ghost.style.transform = 'translate(' + drag.gx + 'px, ' + drag.gy + 'px)';
      var cell = null;
      try { cell = opts.cellFromPoint(drag.lastX, drag.lastY, ghostInfo()); } catch (err) { cell = null; }
      if (sameCell(cell, drag.cell)) return;
      drag.cell = cell;
      if (!cell) { drag.ok = false; hover(null, false); return; }
      var ok = true;
      if (opts.canPlace) {
        try { ok = opts.canPlace(drag.item, cell) !== false; } catch (err) { ok = false; }
      }
      drag.ok = ok;
      if (ok) haptic(5); // cell-change tick, only where the drop would take
      hover(cell, ok);
    }

    function autoScrollFrame() {
      if (!drag || !drag.lifted) { raf = null; return; }
      var viewTop = 0;
      var viewBottom = window.innerHeight;
      if (drag.scroller) {
        var sr = drag.scroller.getBoundingClientRect();
        viewTop = Math.max(0, sr.top);
        viewBottom = Math.min(window.innerHeight, sr.bottom);
      }
      var v = autoScrollVelocity(drag.lastY, viewTop, viewBottom, REORDER_EDGE, REORDER_MAX_SCROLL);
      if (v) {
        if (drag.scroller) drag.scroller.scrollTop += v;
        else window.scrollBy(0, v);
        update(); // content slid under a stationary pointer: re-hit-test
      }
      raf = requestAnimationFrame(autoScrollFrame);
    }

    function lift(e) {
      drag.lifted = true;
      drag.scroller = findScroller();
      drag.liftX = drag.lastX;
      drag.liftY = drag.lastY;
      drag.gx = 0;
      drag.gy = 0;
      drag.cell = null;
      drag.ok = false;
      haptic();
      // Capture on the LIST, matching attachReorder: a host re-render during
      // the gesture would kill capture held on the item itself.
      if (e && typeof e.pointerId === 'number') {
        try { listEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      var rect = drag.item.getBoundingClientRect();
      drag.ghostLeft = rect.left;
      drag.ghostTop = rect.top;
      // Size is captured here too, so ghostInfo() can report the tile's live
      // rect on every move without measuring anything mid-gesture.
      drag.ghostW = rect.width;
      drag.ghostH = rect.height;
      var ghost = drag.item.cloneNode(true);
      ghost.classList.add('un-reorder-ghost');
      ghost.style.position = 'fixed';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      ghost.style.margin = '0';
      ghost.style.zIndex = '9985';
      // pointer-events off so the host's own cellFromPoint hit-test (which
      // runs elementFromPoint under the finger) never hits the ghost.
      ghost.style.pointerEvents = 'none';
      var bg = getComputedStyle(drag.item).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
        try {
          var surface = getComputedStyle(listEl).getPropertyValue('--un-group-bg');
          ghost.style.background = surface ? surface.trim() : '';
        } catch (err) { /* ignore */ }
      }
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      // The real item holds its cell as the dashed drop slot. It does NOT
      // move — that is the whole difference from displacement mode.
      drag.item.classList.add('un-reorder-slot');
      listEl.classList.add('un-reordering');
      if (opts.onLift) {
        try { opts.onLift(drag.item); } catch (err) { /* ignore */ }
      }
      update();
      raf = requestAnimationFrame(autoScrollFrame);
    }

    function release(cancelled) {
      if (!drag) return;
      if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
      if (!drag.lifted) { drag = null; return; }
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);

      var item = drag.item;
      var ghost = drag.ghost;
      var cell = cancelled ? null : drag.cell;
      var placed = !cancelled && !!cell && drag.ok;
      if (placed) haptic();

      // WHERE THE GHOST SETTLES. On a REFUSED or CANCELLED drop it glides
      // back to the item's own rect — that is the "springs back" feedback,
      // and the item is still sitting there wearing the dashed slot.
      //
      // On a COMMITTED drop it must glide to the cell the item is LANDING
      // in, which is why rectForCell exists. The real item does not move
      // during a placement drag (that is the whole difference from
      // displacement mode), so its rect is still the ORIGIN cell — settling
      // there would fly the tile away from the finger, back to where it was
      // picked up, and only then let the re-render pop it into the drop
      // cell. One release, two contradictory motions. Asking the host for
      // the landing rect makes it one continuous motion from finger to cell.
      var target = null;
      if (placed && typeof opts.rectForCell === 'function') {
        try { target = opts.rectForCell(item, cell); } catch (err) { target = null; }
      }
      if (!target || typeof target.left !== 'number' || typeof target.top !== 'number') {
        target = item.getBoundingClientRect();
      }
      var gx = drag.gx;
      var gy = drag.gy;
      var tx = target.left - drag.ghostLeft;
      var ty = target.top - drag.ghostTop;

      // The hover state — highlight, and any displacement preview the host
      // painted — stays up for the FLIGHT of a committed drop, and is torn
      // down in finish() together with the ghost. Clearing it here would
      // snap the displaced occupants back to their old cells while the tile
      // is still travelling, then move them a second time on the re-render.
      // A refused drop clears immediately: nothing is landing.
      if (!placed) hover(null, false);

      function finish() {
        pendingFinish = null;
        // Same task as the host's re-render below, so the preview transforms
        // come off and the items paint in their real cells in one frame.
        if (placed && opts.onHover) {
          try { opts.onHover(item, null, false); } catch (err) { /* ignore */ }
        }
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        item.classList.remove('un-reorder-slot');
        if (placed && opts.onPlace) {
          try { opts.onPlace(item, cell); } catch (err) { /* ignore */ }
        }
        if (opts.onSettle) {
          try { opts.onSettle(placed); } catch (err) { /* ignore */ }
        }
      }

      listEl.classList.remove('un-reordering');
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      drag = null;
      if (prefersReducedMotion || (Math.abs(tx - gx) < 1 && Math.abs(ty - gy) < 1)) {
        finish();
        return;
      }
      if (activeSpring) activeSpring.stop();
      pendingFinish = finish;
      ghost.classList.add('un-reorder-ghost-drop');
      activeSpring = glideGhost(ghost, gx, gy, tx, ty, function () {
        activeSpring = null;
        finish();
      });
    }

    function onPointerDown(e) {
      if (drag || e.button > 0) return;
      var items = matched();
      var item = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].contains(e.target)) { item = items[i]; break; }
      }
      if (!item) return;
      var onHandle = !!(handleSel && e.target.nodeType === 1 &&
        e.target.closest && e.target.closest(handleSel) && item.contains(e.target.closest(handleSel)));
      var isTouch = e.pointerType === 'touch';
      if (!isTouch && handleSel && !onHandle) return;
      drag = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        seq: gestureSeq(e),
        item: item,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        lifted: false,
        armed: false,
        pressTimer: null,
      };
      if (onHandle) {
        if (!gestures.claim(drag.seq, token)) { drag = null; return; }
        lift(e);
      } else if (isTouch) {
        drag.pressTimer = setTimeout(function () {
          if (!drag || drag.lifted) return;
          drag.pressTimer = null;
          if (!gestures.claim(drag.seq, token)) { drag = null; return; }
          lift(e);
        }, longPressMs);
      } else {
        drag.armed = true;
      }
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!drag.lifted) {
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        if (drag.pressTimer) {
          if (Math.abs(dx) > REORDER_SLOP || Math.abs(dy) > REORDER_SLOP) {
            clearTimeout(drag.pressTimer);
            drag = null;
          }
          return;
        }
        if (drag.armed) {
          // 2D from the start — a placement drag is as likely to be
          // horizontal as vertical, so no axis lock.
          if (dx * dx + dy * dy > REORDER_SLOP * REORDER_SLOP) {
            if (!gestures.claim(drag.seq, token)) { drag = null; return; }
            lift(e);
          }
        }
        return;
      }
      update();
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      release(false);
    }

    function onPointerCancel(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      release(true);
    }

    // A gesture whose end never reached the list (#5870). On an iPhone a
    // touch hold that lifted a tile AND opened the host's menu over the
    // finger could lose its pointerup: the drag then stayed lifted for good.
    // Every later tap carries a new pointerId, which onPointerUp ignores and
    // onPointerDown refuses (`if (drag) return`), so the ghost floated over
    // every screen and the host's onLift deferral held its re-renders until
    // a reload. The window watches the same gesture as a safety net:
    //   - this pointer ending anywhere (capture lost, or the target gone);
    //   - the touch sequence ending (touchend with no touches left), deferred
    //     a task so a pointerup that is merely late still decides the drop;
    //   - the next PRIMARY press of the same pointer type, which a live
    //     gesture cannot be followed by. A second finger during a real drag
    //     is not primary and leaves it alone.
    function onWindowPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      release(e.type === 'pointercancel');
    }

    function onWindowTouchEnd(e) {
      if (!drag || drag.pointerType !== 'touch') return;
      if (e.touches && e.touches.length > 0) return;
      var ended = drag;
      setTimeout(function () {
        if (drag === ended) release(e.type === 'touchcancel');
      }, 0);
    }

    function onWindowPointerDown(e) {
      if (!drag || e.isPrimary === false || e.pointerType !== drag.pointerType) return;
      if (gestures.owner(drag.seq) === token) gestures.release(drag.seq);
      release(true);
    }

    function onTouchMove(e) {
      if (drag && drag.lifted) e.preventDefault();
    }

    function onClickCapture(e) {
      if (suppressClick || (drag && drag.lifted)) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    listEl.addEventListener('pointerdown', onPointerDown);
    listEl.addEventListener('pointermove', onPointerMove);
    listEl.addEventListener('pointerup', onPointerUp);
    listEl.addEventListener('pointercancel', onPointerCancel);
    listEl.addEventListener('touchmove', onTouchMove, { passive: false });
    listEl.addEventListener('click', onClickCapture, true);
    window.addEventListener('pointerdown', onWindowPointerDown, true);
    window.addEventListener('pointerup', onWindowPointerEnd, true);
    window.addEventListener('pointercancel', onWindowPointerEnd, true);
    window.addEventListener('touchend', onWindowTouchEnd, true);
    window.addEventListener('touchcancel', onWindowTouchEnd, true);

    return {
      detach: function () {
        listEl.removeEventListener('pointerdown', onPointerDown);
        listEl.removeEventListener('pointermove', onPointerMove);
        listEl.removeEventListener('pointerup', onPointerUp);
        listEl.removeEventListener('pointercancel', onPointerCancel);
        listEl.removeEventListener('touchmove', onTouchMove);
        listEl.removeEventListener('click', onClickCapture, true);
        window.removeEventListener('pointerdown', onWindowPointerDown, true);
        window.removeEventListener('pointerup', onWindowPointerEnd, true);
        window.removeEventListener('pointercancel', onWindowPointerEnd, true);
        window.removeEventListener('touchend', onWindowTouchEnd, true);
        window.removeEventListener('touchcancel', onWindowTouchEnd, true);
        if (drag) {
          if (drag.pressTimer) clearTimeout(drag.pressTimer);
          var wasLifted = drag.lifted;
          if (wasLifted) {
            if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
            if (drag.item) drag.item.classList.remove('un-reorder-slot');
            hover(null, false);
          }
          drag = null;
          // A mid-lift teardown never reaches release(); fire onSettle here
          // so a host deferral flag set in onLift can't get stuck.
          if (wasLifted && opts.onSettle) {
            try { opts.onSettle(false); } catch (err) { /* ignore */ }
          }
        }
        if (activeSpring) { activeSpring.stop(); activeSpring = null; }
        if (pendingFinish) {
          var f = pendingFinish;
          pendingFinish = null;
          f();
        }
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        listEl.classList.remove('un-reordering');
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Page transitions. type 'none' (the default, and the REQUIRED choice
   * for high-frequency UI like tab switches, menus and panels) runs the
   * mutation with no animation; 'push'/'pop' wrap it in a View
   * Transition. Re-entrant: a navigation during an active transition
   * skips animation, never queues.
   *
   * PUT THE WHOLE MUTATION IN `fn`. A View Transition captures the OLD
   * state at the next rendering opportunity, not at the
   * startViewTransition() call, so DOM changes a caller makes
   * synchronously AFTER calling transition() — but before `fn` runs —
   * land in the ::view-transition-old(root) snapshot: the animation then
   * slides out a "previous page" that already carries the incoming
   * screen's chrome (or none of the outgoing screen's content at all).
   *
   * A DUPLICATE DISPATCH THAT RE-APPLIES THE SAME NAVIGATION MUST BE
   * SKIPPED BY THE CALLER, NOT ABSORBED BY THE KIT (#1102): the caller is
   * the only party that can tell "already showing this" from "show this
   * next". What the kit guarantees is narrower — it will not ANIMATE a
   * corrupted snapshot. So while a transition is pending but not yet
   * captured, an immediately-run mutation (type 'none', reduced motion, a
   * re-entrant navigation) first skips that transition, degrading the
   * worst case to no animation instead of a two-copies animation.
   *
   * 'zoom-in'/'zoom-out' play the iOS-homescreen expand/collapse out of
   * a tile ({ el, fromEl | fromRect, after?, fallback?, outEl? }). No
   * View Transition is involved: the LIVE screen element (opts.el) is
   * pinned as a fixed overlay and transform-animated from/to the tile's
   * rect — no snapshot, so it is iframe-safe and content keeps loading
   * mid-zoom. The caller splits its mutation in two: `fn` reveals the
   * incoming screen (leaving the outgoing one visible beneath the
   * moving card) and `opts.after` conceals the outgoing one — `after`
   * runs exactly once on every path (animated settle, instant settle,
   * fallback). When the incoming screen shares layout flow with the
   * outgoing one (flex siblings that split the space while both are
   * visible), pass `outEl` — the outgoing screen element, or a function
   * returning it: zoom-in hides it (inline display) for the synchronous
   * pre-paint destination measurement so `el` measures its SETTLED
   * rect, then restores it and the document's scroll offset before pinning;
   * without it the zoom would
   * animate to the shared-layout rect and snap at the end. zoom-out
   * ignores `outEl`. `duration` (ms, or a function returning ms or null,
   * asked once the source is resolved) shortens or lengthens the move; the
   * fade scales with it, and leaving it out keeps the homescreen timing.
   * Either zoom holds its start pose for one painted frame before it moves
   * (afterStartPose), so the frame that reveals the screen is not spent.
   * When the zoom can't run (no usable source rect,
   * reduced motion, missing el) it falls back to opts.fallback ('push'
   * for zoom-in, 'pop' for zoom-out, or 'none') with the combined
   * mutation.
   * ──────────────────────────────────────────────────────────────────── */

  var vtActive = false;
  // The transition whose update callback has NOT run yet — i.e. whose old
  // snapshot has not been captured. Any visible mutation that lands in this
  // window is baked into that snapshot, which is why the immediate-run path
  // below skips it first (#1102). Cleared from inside the wrapped callback,
  // which the browser only calls once the old state is captured.
  var vtPending = null;
  var zoomCleanup = null; // instant-finish handle for the active zoom

  var ZOOM_EASE = 'var(--un-ease-spring-stiff, cubic-bezier(0.3, 1, 0.4, 1))';
  var ZOOM_RADIUS = '16px';

  // Pin el as a fixed overlay over `rect` and return a restore function
  // that puts its inline style back exactly (screens often carry
  // load-bearing inline styles). The opaque background is the
  // bleed-through guard: a transparent screen over the still-visible
  // grid would let the grid show through the moving card. z-index 9960
  // sits above app content but below every kit overlay (sheets 9990+).
  function zoomPin(el, rect) {
    var saved = el.style.cssText;
    el.style.position = 'fixed';
    el.style.top = rect.top + 'px';
    el.style.left = rect.left + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    el.style.margin = '0';
    el.style.zIndex = '9960';
    el.style.transformOrigin = '0 0';
    el.style.overflow = 'hidden';
    el.style.transition = 'none';
    el.style.background = 'var(--un-zoom-bg)';
    return function () { el.style.cssText = saved; };
  }

  // Resolve the tile rect. A caller-supplied fromRect is trusted except
  // for zero size; anything derived from fromEl (element, or a function
  // returning an element/rect) gets the full usability check, including
  // the on-screen test — a hidden source screen yields a 0×0 rect and
  // falls through to the fallback.
  function resolveZoomSource(opts) {
    if (opts.fromRect) {
      var r = opts.fromRect;
      return r.width > 0 && r.height > 0 ? r : null;
    }
    var src = null;
    try {
      src = typeof opts.fromEl === 'function' ? opts.fromEl() : opts.fromEl;
    } catch (e) { return null; }
    if (!src) return null;
    var rect = typeof src.getBoundingClientRect === 'function'
      ? src.getBoundingClientRect()
      : src;
    return zoomRectUsable(rect, window.innerHeight) ? rect : null;
  }

  // The move's length for this zoom: the caller's `duration` when it names a
  // positive number of ms (or a function that returns one), else `fallbackMs`.
  function zoomDuration(opts, fallbackMs) {
    var d = opts.duration;
    try { if (typeof d === 'function') d = d(); } catch (e) { d = null; }
    d = Number(d);
    return isFinite(d) && d > 0 ? Math.round(d) : fallbackMs;
  }

  // THE FIRST FRAME OF A ZOOM IS ITS START POSE (1 Nov 2026). `fn` has just
  // revealed a screen, so the frame that paints it is a long one: on the
  // iPhone Duo simulator (iOS 27.1) 60 to 77ms passed before the next frame.
  // A transition set in the same task runs its clock through that frame, so
  // the first frame anyone saw had the card 60 to 77% of the way there: an
  // app grew out of the middle of the screen, not out of its tile, and
  // shrank from half its size. So the move starts once the start pose has
  // been painted: on the second animation frame from here, because the first
  // one runs before the long frame paints. The cap starts it anyway where
  // frames are not coming (a hidden tab); a timer cannot run inside a frame,
  // so it never starts before that paint either. With no animation frames at
  // all (no window), the move starts at once, as it always did.
  var ZOOM_START_CAP_MS = 120;
  function afterStartPose(go) {
    if (typeof requestAnimationFrame !== 'function') { go(); return; }
    var started = false;
    var once = function () {
      if (started) return;
      started = true;
      go();
    };
    requestAnimationFrame(function () { requestAnimationFrame(once); });
    setTimeout(once, ZOOM_START_CAP_MS);
  }

  function zoomTransition(fn, type, opts) {
    var el = opts.el;
    var after = typeof opts.after === 'function' ? opts.after : null;
    var fallbackType = opts.fallback || (type === 'zoom-in' ? 'push' : 'pop');
    // Fallback: the combined mutation through the normal machinery —
    // byte-for-byte what a non-zoom push/pop navigation does. An active
    // View Transition makes this an instant cut (the re-entrancy rule).
    var fallback = function () {
      return transition(after ? function () { fn(); after(); } : fn, { type: fallbackType });
    };
    if (!el || prefersReducedMotion || vtActive) return fallback();
    if (zoomCleanup) zoomCleanup(); // finish any active zoom instantly

    var resolveP;
    var promise = new Promise(function (res) { resolveP = res; });
    var done = false;
    var unpin = null;
    var onEnd = null;
    var finish = function () {
      if (done) return;
      done = true;
      if (zoomCleanup === finish) zoomCleanup = null;
      if (onEnd) el.removeEventListener('transitionend', onEnd);
      if (unpin) unpin();
      if (after) after();
      resolveP();
    };
    onEnd = function (e) {
      if (e.target === el && e.propertyName === 'transform') finish();
    };

    if (type === 'zoom-in') {
      // Tile resolved BEFORE fn (it lives on the outgoing screen).
      var fromRect = resolveZoomSource(opts);
      if (!fromRect) return fallback();
      fn();
      // Measured synchronously after fn, pre-paint: no full-screen flash.
      // When the caller names the outgoing screen (opts.outEl), hide it
      // for the measurement so a flow-sharing `el` (e.g. flex siblings
      // splitting the column while both are visible) measures its
      // SETTLED rect — the one it will occupy after `after()` conceals
      // the outgoing screen — instead of the transient shared-layout
      // rect. Hide → measure → restore is all synchronous pre-paint, so
      // the outgoing screen never visibly blinks.
      var outEl = null;
      try {
        outEl = typeof opts.outEl === 'function' ? opts.outEl() : opts.outEl;
      } catch (e) { outEl = null; }
      var target;
      if (outEl && outEl !== el && outEl.style) {
        var savedOutDisplay = outEl.style.display;
        // Hiding a document-scrolling page can temporarily shrink the root
        // and clamp its offset to zero. Restore it before paint, too: this
        // measurement must not move the outgoing page or erase its position.
        var page = document.scrollingElement || document.documentElement;
        var pageTop = page.scrollTop;
        var pageLeft = page.scrollLeft;
        try {
          outEl.style.display = 'none';
          target = el.getBoundingClientRect();
        } finally {
          outEl.style.display = savedOutDisplay;
          page.scrollTop = pageTop;
          page.scrollLeft = pageLeft;
        }
      } else {
        target = el.getBoundingClientRect();
      }
      var pose = zoomPose(fromRect, target);
      if (!pose) {
        // el didn't land anywhere measurable — settle instantly.
        if (after) after();
        return Promise.resolve();
      }
      unpin = zoomPin(el, target);
      el.style.transform = 'translate(' + pose.tx + 'px, ' + pose.ty + 'px) '
        + 'scale(' + pose.sx + ', ' + pose.sy + ')';
      el.style.opacity = '0.3';
      el.style.borderRadius = ZOOM_RADIUS;
      void el.offsetHeight; // flush the start pose before enabling the transition
      var inMs = zoomDuration(opts, 380);
      zoomCleanup = finish;
      afterStartPose(function () {
        if (done) return; // finished before it moved
        el.style.transition = 'transform ' + inMs + 'ms ' + ZOOM_EASE
          + ', opacity ' + Math.min(220, inMs) + 'ms ease, border-radius ' + inMs + 'ms ease';
        el.style.transform = 'none';
        el.style.opacity = '1';
        el.style.borderRadius = '0px';
        el.addEventListener('transitionend', onEnd);
        setTimeout(finish, inMs + 120); // safety if transitionend never fires
      });
      return promise;
    }

    // zoom-out: pin the outgoing screen over its current rect FIRST,
    // then reveal the screen beneath it.
    var from = el.getBoundingClientRect();
    if (!(from.width > 0) || !(from.height > 0)) return fallback();
    unpin = zoomPin(el, from);
    fn();
    // Tile resolved AFTER fn (it lives on the just-revealed screen).
    var outPose = zoomPose(resolveZoomSource(opts), from);
    if (!outPose) {
      // No tile on screen to land on — settle instantly.
      finish();
      return promise;
    }
    void el.offsetHeight;
    var outMs = zoomDuration(opts, 340);
    zoomCleanup = finish;
    afterStartPose(function () {
      if (done) return; // finished before it moved
      el.style.transition = 'transform ' + outMs + 'ms ' + ZOOM_EASE
        + ', opacity ' + Math.round(outMs * 200 / 340) + 'ms ease '
        + Math.round(outMs * 60 / 340) + 'ms, border-radius ' + outMs + 'ms ease';
      el.style.transform = 'translate(' + outPose.tx + 'px, ' + outPose.ty + 'px) '
        + 'scale(' + outPose.sx + ', ' + outPose.sy + ')';
      el.style.opacity = '0';
      el.style.borderRadius = ZOOM_RADIUS;
      el.addEventListener('transitionend', onEnd);
      setTimeout(finish, outMs + 140); // safety if transitionend never fires
    });
    return promise;
  }

  // Has the document painted at least one frame yet?
  //
  // A View Transition animates BETWEEN two rendered states, so it needs an
  // "old" state to snapshot. Start one before the first frame and there is
  // nothing to capture: the browser aborts it with
  // `InvalidStateError: Transition was aborted because of invalid state`.
  //
  // The shell hits that window on a DEEP-LINK BOOT. Landing directly on
  // `#profile` / `#leaderboard` / `#settings` means App.init() routes on
  // DOMContentLoaded and immediately asks for a 'push' — while the very
  // first paint may still be pending. Whether it lands is a race against
  // however long the page took to get there, which is why it showed up as
  // a flaky-looking spray of route failures rather than one reproducible
  // bug, and why it got measurably worse when the shell started hydrating
  // React before DOMContentLoaded (more main-thread work inside the same
  // window, so the paint lands after the transition more often).
  //
  // Skipping the animation here is not a behaviour change: an aborted
  // transition already produced no animation. It just makes the outcome
  // deterministic instead of timing-dependent — and a boot deep link has
  // no previous screen to animate away from in the first place.
  var framePainted = false;
  function markFramePainted() { framePainted = true; }
  if (typeof requestAnimationFrame === 'function') {
    // Two nested rAFs: the callback of the first runs BEFORE that frame is
    // painted, the second is the earliest point a frame is known to have
    // reached the screen.
    requestAnimationFrame(function () { requestAnimationFrame(markFramePainted); });
  } else {
    framePainted = true;
  }
  function hasRenderedAFrame() {
    // `visibilityState === 'hidden'` is the other documented abort: a
    // background tab is not being rendered, so there is no frame to
    // capture however long the page has been open.
    if (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') {
      return false;
    }
    return framePainted;
  }

  function transition(fn, opts) {
    var o = opts || {};
    var type = o.type || 'none';
    if (type === 'zoom-in' || type === 'zoom-out') {
      return zoomTransition(fn, type, o);
    }
    // Non-zoom types accept `after` too (the zoom fallback path relies
    // on it): the two halves run together as one mutation.
    var run = typeof o.after === 'function'
      ? function () { fn(); o.after(); }
      : fn;
    if (
      type === 'none' || vtActive || prefersReducedMotion || !hasRenderedAFrame() ||
      typeof document.startViewTransition !== 'function'
    ) {
      // This mutation runs NOW, synchronously — callers of 'none' read the
      // DOM straight after, so that timing is part of the contract. If a
      // transition is still waiting to capture its old state, running into
      // it would put this mutation in the outgoing snapshot and animate the
      // incoming page against a copy of itself (#1102). skipTransition()
      // invokes the pending update callback synchronously if it has not run,
      // so the other navigation's mutation is NOT lost — only its animation
      // is. Silent by design: the promise rejections it causes are already
      // absorbed below, and logging here would fail the platform's
      // console-error baseline on every route.
      if (vtPending) {
        var skipping = vtPending;
        vtPending = null;
        try { skipping.skipTransition(); } catch (e) { /* already finished */ }
      }
      run();
      return Promise.resolve();
    }
    vtActive = true;
    document.documentElement.setAttribute('data-un-vt', type);
    var vt;
    // Clear the pending handle from INSIDE the callback: the browser calls
    // it only after the old state is captured, which is exactly the end of
    // the window the guard above protects.
    var capture = function () { vtPending = null; run(); };
    try {
      vt = document.startViewTransition(capture);
    } catch (e) {
      vtActive = false;
      vtPending = null;
      document.documentElement.removeAttribute('data-un-vt');
      run();
      return Promise.resolve();
    }
    vtPending = vt;
    // A ViewTransition hands back THREE promises, and an aborted transition
    // rejects two of them. `finished` is handled below, but `ready` and
    // `updateCallbackDone` were observed by nobody — so when the browser
    // aborted a transition (`InvalidStateError: Transition was aborted
    // because of invalid state`), that rejection surfaced as an UNHANDLED
    // PROMISE REJECTION. Playwright reports one as a `pageerror`, and a
    // page error on any route fails the platform's proposal checks — so a
    // transition the browser silently declined to animate became a merge
    // blocker on dozens of routes.
    //
    // Attaching no-op handlers is the whole fix: an aborted transition
    // already ran its mutation callback (the DOM is correct, it just does
    // not animate), so there is nothing to recover from and nothing to
    // report. Do NOT "improve" this by logging — console.error fails the
    // same checks.
    if (vt.ready && typeof vt.ready.catch === 'function') vt.ready.catch(function () {});
    if (vt.updateCallbackDone && typeof vt.updateCallbackDone.catch === 'function') {
      vt.updateCallbackDone.catch(function () {});
    }
    return vt.finished.catch(function () {}).then(function () {
      vtActive = false;
      // Belt and braces: a transition the browser aborted BEFORE calling the
      // update callback never clears the handle above, and a stale handle
      // would make the next 'none' mutation skip a transition that is
      // already over (harmless, but it should never get that far).
      if (vtPending === vt) vtPending = null;
      document.documentElement.removeAttribute('data-un-vt');
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Bottom sheet — spring presentation, grabber, 1:1 drag-to-dismiss with
   * momentum commit. A touch mid-spring inherits position + velocity.
   *
   * y is allowed to go NEGATIVE (above the rest position): the drag's
   * elastic give, the entrance spring's overshoot, and a post-present
   * content shrink all render a lifted sheet. That is safe to paint
   * because `.un-sheet::after` in native.css extends the sheet surface
   * below its bottom edge (issue #789) — without it, a lifted sheet
   * exposes the dimmed backdrop over the page underneath. Keep the two
   * halves together: don't clamp y here, and don't drop that rule.
   * ──────────────────────────────────────────────────────────────────── */

  // Watch one border-box dimension of an overlay while it is presented
  // (issue #742): content rendered AFTER present (fill from state, async
  // fetch) changes the height the entrance spring and backdrop math were
  // seeded with, and a rotation changes a side panel's width. `prop` is
  // 'offsetHeight' (bottom sheet) or 'offsetWidth' (side panel). Calls
  // onChange(newValue, oldValue) on material (≥1px) changes.
  // ResizeObserver fires after layout and BEFORE paint, so the common
  // present-then-render-synchronously pattern retargets before a frame at
  // the wrong offset is ever painted; transforms don't affect layout, so
  // the per-frame translate writes can't re-trigger it. Where RO is
  // missing, a single first-rAF re-measure covers the same pattern.
  // Returns a disconnect function.
  function watchSize(el, prop, onChange) {
    var last = el[prop] || 1;
    function check() {
      var h = el[prop] || 1;
      if (Math.abs(h - last) < 1) return;
      var prev = last;
      last = h;
      onChange(h, prev);
    }
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(check);
        ro.observe(el);
        return function () { ro.disconnect(); };
      } catch (e) { /* fall through to the rAF fallback */ }
    }
    var raf = requestAnimationFrame(check);
    return function () { cancelAnimationFrame(raf); };
  }

  // A surface on its way out stops taking input the moment it is dismissed,
  // as a modal already does (animateDialog). The exit spring runs to rest
  // well after the surface has left the screen, and until teardown the
  // backdrop, faded to nothing by then, still covered the page: the first
  // tap after closing a sheet (a tab, a row) landed on it and did nothing.
  // Measured on a phone-sized viewport, taps 270-390ms after tapping a
  // sheet's backdrop were swallowed. The surfaces themselves are released
  // too; a dismissed surface has no more gestures to take.
  function releaseInput() {
    for (var i = 0; i < arguments.length; i++) {
      var el = arguments[i];
      if (el && el.style) el.style.pointerEvents = 'none';
    }
  }

  // Wire "click the backdrop to dismiss" WITHOUT eating the opening
  // gesture's ghost click — see decideBackdropDismiss above for why that
  // click exists and why it lands here. Every presented surface with a
  // dismissible backdrop goes through this; none of them binds 'click'
  // directly (tests/native-kit.test.js pins that).
  //
  // A real press is only ever signalled by pointerdown / touchstart: the
  // ghost is a compatibility MOUSE sequence (mousedown → mouseup → click)
  // synthesized from a touch that landed on the opener, so it arrives
  // with neither. `mousedown` therefore does NOT count as a press —
  // except on the one class of browser that has no pointer events and no
  // touch at all, where it is the only signal there is and cannot be a
  // ghost.
  //
  // `surface` is the presented card, sheet, panel or action sheet. A press
  // or click on it, or within DISMISS_EDGE_PX of its edge, never dismisses:
  // the browser can retarget a near-edge tap to the backdrop, and the press
  // must not be lost with what was typed (#6475).
  function onBackdropDismiss(backdrop, dismiss, surface) {
    var openedAt = Date.now();
    var pressed = false;
    var pressX = 0;
    var pressY = 0;
    function pointOf(e) {
      if (!e) return null;
      if (typeof e.clientX === 'number' && (e.clientX !== 0 || e.clientY !== 0)) {
        return { x: e.clientX, y: e.clientY };
      }
      var touch = e.touches && e.touches[0];
      if (touch) return { x: touch.clientX, y: touch.clientY };
      return null;
    }
    function press(e) {
      pressed = true;
      var p = pointOf(e);
      pressX = p ? p.x : 0;
      pressY = p ? p.y : 0;
    }
    function clearPress() {
      pressed = false;
      pressX = 0;
      pressY = 0;
    }
    // A point at (0, 0) is a synthetic click's "no point", not a position in
    // the page's corner: it skips the geometry test rather than counting.
    function nearSurface(p) {
      if (!p || (p.x === 0 && p.y === 0)) return false;
      if (!surface || typeof surface.getBoundingClientRect !== 'function') return false;
      var r = surface.getBoundingClientRect();
      return p.x >= r.left - DISMISS_EDGE_PX && p.x <= r.right + DISMISS_EDGE_PX &&
        p.y >= r.top - DISMISS_EDGE_PX && p.y <= r.bottom + DISMISS_EDGE_PX;
    }
    // A press anywhere other than the backdrop since the last click means the
    // press did not begin on it. Without this, one earlier backdrop press
    // made every later backdrop click count. The listener removes itself once
    // its backdrop has left the document.
    function onDocPointerDown(e) {
      if (!backdrop.isConnected) {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        return;
      }
      if (e.target !== backdrop) clearPress();
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    backdrop.addEventListener('pointerdown', press);
    backdrop.addEventListener('touchstart', press, { passive: true });
    if (typeof window.PointerEvent === 'undefined' &&
        !('ontouchstart' in window)) {
      backdrop.addEventListener('mousedown', press);
    }
    backdrop.addEventListener('click', function (e) {
      var click = pointOf(e);
      var near = nearSurface(click) ||
        nearSurface(pressed ? { x: pressX, y: pressY } : null);
      var pointerClick = typeof e.detail === 'number' && e.detail > 0;
      var answer = decideBackdropDismiss({
        pressed: pressed,
        elapsedMs: Date.now() - openedAt,
        pointerClick: pointerClick,
        nearSurface: near,
      });
      // Each click consumes the press that led to it.
      clearPress();
      if (answer) {
        dismiss();
        return;
      }
      // Swallow it whole: letting the ghost bubble on would re-fire
      // whatever opened this surface, under a backdrop that is still up.
      e.stopPropagation();
      e.preventDefault();
    });
  }

  // presentSheet({ content | contentEl, onDismiss }) — content is an HTML
  // string, contentEl an Element to adopt. Returns { dismiss(), el }.
  function presentSheet(options) {
    var opts = options || {};
    var backdrop = document.createElement('div');
    backdrop.className = 'un-backdrop';
    var sheet = document.createElement('div');
    sheet.className = 'un-sheet';
    var grabber = document.createElement('div');
    grabber.className = 'un-sheet-grabber';
    sheet.appendChild(grabber);
    var body = document.createElement('div');
    body.className = 'un-sheet-body';
    if (opts.contentEl) body.appendChild(opts.contentEl);
    else if (opts.content != null) body.innerHTML = opts.content;
    sheet.appendChild(body);
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);

    var height = sheet.offsetHeight || 1;
    var y = height; // translateY: 0 = presented, height = offscreen
    var activeSpring = null;
    var drag = null;
    var closed = false;
    var token = { sheet: true };

    function render(val) {
      y = val;
      sheet.style.transform = 'translateY(' + val + 'px)';
      var presence = String(Math.max(0, Math.min(1, 1 - val / height)));
      backdrop.style.opacity = presence;
      // The same number, on the surface itself, as `--un-presence`: 1 at
      // rest, 0 off-screen, 1:1 with the drag between. A host stylesheet
      // that wants the dim to ride the slide from the SHEET's side (the
      // platform shell casts its own scrim from the sheet, so its glass
      // never frosts a dimmed page) reads this; the kit's own styles do
      // not, so an app that ignores it renders exactly as before.
      sheet.style.setProperty('--un-presence', presence);
    }

    // Once closed, every spring is the exit (dismiss, or the retarget
    // below when the height changes mid-exit): it ends off-screen, not at
    // rest, so teardown and onDismiss are not held by an invisible settle.
    function springTo(to, velocity, onRest) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (v) { render(v); }, {
        from: y, to: to, velocity: velocity || 0, preset: 'sheet', exit: closed,
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function teardown() {
      if (unwatch) unwatch();
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      if (opts.onDismiss) opts.onDismiss();
    }

    function dismiss(velocity) {
      if (closed) return;
      closed = true;
      releaseInput(backdrop, sheet);
      springTo(height, velocity || 0, teardown);
    }

    onBackdropDismiss(backdrop, function () { dismiss(0); }, sheet);

    // A LIST INSIDE THE SHEET. A host that lets its sheet pan (the
    // platform's `touch-action: pan-y` sheets, so a list in one scrolls)
    // gave a drag on that list two owners: this handler locked the axis and
    // moved the sheet 1:1, then the browser claimed the pan for the list and
    // cancelled the pointer, and the sheet sprang back from wherever the
    // finger had taken it. On a phone the whole sheet lurched under a pull
    // on its list. So a drag that starts in a scroller is the scroller's,
    // unless the scroller is at its top and the drag pulls down: that one is
    // the sheet's, as on an iOS sheet, and a blocking touchmove keeps the
    // browser from rubber-banding the list under it meanwhile.
    function scrollerAt(target) {
      for (var el = target; el && el !== sheet && el.nodeType === 1; el = el.parentElement) {
        if (el.scrollHeight - el.clientHeight > 1) {
          var oy = window.getComputedStyle(el).overflowY;
          if (oy === 'auto' || oy === 'scroll') return el;
        }
      }
      return null;
    }
    // The blocking listener is there only while a pull can start (the
    // reason attachPullToRefresh gives for its own): a list scrolled away
    // from its top scrolls on passive moves, off the main thread.
    var touch = null;
    var moveBound = false;
    function bindMove(on) {
      if (on === moveBound) return;
      moveBound = on;
      if (on) sheet.addEventListener('touchmove', onTouchMove, { passive: false });
      else sheet.removeEventListener('touchmove', onTouchMove, { passive: false });
    }
    function onInnerScroll(e) {
      var t = e.target;
      if (!t || t === sheet || t.nodeType !== 1 || t.scrollHeight - t.clientHeight <= 1) return;
      bindMove(t.scrollTop <= 0 || !!(drag && drag.locked));
    }
    function onTouchStart(e) {
      touch = null;
      if (closed || !e.touches || e.touches.length !== 1) return;
      var scroller = scrollerAt(e.target);
      if (!scroller) return;
      bindMove(scroller.scrollTop <= 0);
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, top: scroller.scrollTop <= 0 };
    }
    function onTouchMove(e) {
      if (!touch || !e.cancelable) return;
      if (drag && drag.locked === 'y') { e.preventDefault(); return; }
      var dx = e.touches[0].clientX - touch.x;
      var dy = e.touches[0].clientY - touch.y;
      if (holdsSheetPull({ atTop: touch.top, dx: dx, dy: dy })) e.preventDefault();
    }
    function onTouchEnd(e) {
      if (!e.touches || e.touches.length === 0) touch = null;
    }

    function onPointerDown(e) {
      if (closed || e.button > 0) return;
      var immediate = !!activeSpring;
      if (immediate && !gestures.claim(gestureSeq(e), token)) return;
      var base = y;
      var seedV = 0;
      if (activeSpring) {
        var cur = activeSpring.current();
        activeSpring.stop();
        activeSpring = null;
        base = cur.x;
        seedV = cur.v;
        render(base);
      }
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        base: base,
        locked: immediate ? 'y' : null,
        // Caught mid-spring, the sheet already has the finger.
        scroller: immediate ? null : scrollerAt(e.target),
        samples: [{ t: e.timeStamp - 16, x: base - seedV * 16 }, { t: e.timeStamp, x: base }],
      };
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.locked) {
        var axis = lockIntent(dx, dy);
        if (axis === 'x') { drag = null; return; }
        if (axis === 'y') {
          if (!decideSheetDrag({ dy: dy, scrollTop: drag.scroller ? drag.scroller.scrollTop : null })) { drag = null; return; }
          if (!gestures.claim(gestureSeq(e), token)) { drag = null; return; }
          drag.locked = 'y';
          try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
      }
      if (drag.locked !== 'y') return;
      var raw = drag.base + dy;
      // 1:1 downward; small elastic give above the rest position. A pull
      // that began on a list stops at rest: pushed back up, it is the list's.
      if (drag.scroller && raw < 0) raw = 0;
      render(raw >= 0 ? raw : rubberband(raw, 32));
      drag.samples.push({ t: e.timeStamp, x: y });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var wasLocked = drag.locked === 'y';
      var samples = drag.samples;
      drag = null;
      if (!wasLocked || closed) return;
      // Release-time sample so a held-still dwell decays momentum.
      samples.push({ t: e.timeStamp, x: y });
      var v = e.type === 'pointercancel' ? 0 : estimateVelocity(samples);
      if (decideSheetRelease({ y: y, v: v, sheetHeight: height })) dismiss(v);
      else springTo(0, v);
    }

    sheet.addEventListener('pointerdown', onPointerDown);
    sheet.addEventListener('pointermove', onPointerMove);
    sheet.addEventListener('pointerup', onPointerEnd);
    sheet.addEventListener('pointercancel', onPointerEnd);
    sheet.addEventListener('touchstart', onTouchStart, { passive: true });
    sheet.addEventListener('touchend', onTouchEnd, { passive: true });
    sheet.addEventListener('touchcancel', onTouchEnd, { passive: true });
    // Element scrolls do not bubble; they pass the sheet in capture.
    sheet.addEventListener('scroll', onInnerScroll, { capture: true, passive: true });
    bindMove(true);

    // Late-rendered content (issue #742): the height variable feeds the
    // backdrop denominator, the dismissal travel and the release decision,
    // so refreshing it keeps them all consistent; the offset shift keeps
    // the top edge visually continuous so growth springs up (a full
    // slide-up on the first-open repro) instead of popping in.
    var unwatch = watchSize(sheet, 'offsetHeight', function (newHeight, oldHeight) {
      height = newHeight;
      if (drag && drag.locked) return; // the finger owns the position 1:1
      var v = activeSpring ? activeSpring.current().v : 0;
      if (closed) {
        // The exit spring was aiming at the old height — retarget so the
        // sheet fully leaves the screen before teardown.
        springTo(height, v, teardown);
        return;
      }
      render(remeasuredSheetY({ y: y, oldHeight: oldHeight, newHeight: newHeight }));
      springTo(0, v);
    });

    render(height);
    springTo(0, 0);

    return {
      el: sheet,
      dismiss: function () { dismiss(0); },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Centered modal — arbitrary content in a centered card over the shared
   * backdrop. Fade + subtle scale-settle (the alert's motion family);
   * teardown is deferred until the fade completes with pointer-events
   * disabled for the whole fade-out window (the two details hand-rolled
   * versions get subtly wrong).
   * ──────────────────────────────────────────────────────────────────── */

  var modalStack = []; // Escape dismisses the TOPMOST dismissible modal only,
                       // unless a [data-owns-escape] overlay is open above it
  var alertSeq = 0;     // unique ids for each alert's title/message (aria)

  // Modal/alert cards and the dim over the page are one fade (#1566).
  // Explicitly commit BOTH starting opacities, including the separately
  // composited backdrop, before a microtask-origin open can reach its rAF.
  // Keep the two writes in one frame, and retire the pair only when both
  // opacity transitions end — never on a child's transition or keyboard top.
  function animateDialog(card, backdrop, onEntered) {
    var layers = [card, backdrop];
    layers.forEach(function (el) { void getComputedStyle(el).opacity; });
    var closed = false;
    var frame = requestAnimationFrame(function () {
      frame = null;
      if (closed) return;
      backdrop.style.opacity = '1';
      card.classList.add('un-in');
      if (onEntered) onEntered();
    });

    return {
      dismiss: function (onExited) {
        if (closed) return;
        closed = true;
        if (frame !== null) cancelAnimationFrame(frame);
        // A close before the entrance paints has nothing to fade. Reading
        // both current styles also commits an interrupted entrance before
        // reversing it, so the browser can shorten both exits consistently.
        var ended = layers.map(function (el) { return getComputedStyle(el).opacity === '0'; });
        var fired = false;
        var timer = null;
        var handlers = layers.map(function (el, index) {
          return function (event) {
            if (event.target !== el || event.propertyName !== 'opacity') return;
            // An entrance transitionend can already be queued at close.
            if (getComputedStyle(el).opacity !== '0') return;
            ended[index] = true;
            if (ended.every(Boolean)) finish();
          };
        });
        function finish() {
          if (fired) return;
          fired = true;
          if (timer !== null) clearTimeout(timer);
          layers.forEach(function (el, index) {
            el.removeEventListener('transitionend', handlers[index]);
            if (el.parentNode) el.parentNode.removeChild(el);
          });
          if (onExited) onExited();
        }
        layers.forEach(function (el, index) {
          el.style.pointerEvents = 'none';
          el.addEventListener('transitionend', handlers[index]);
        });
        card.classList.remove('un-in');
        backdrop.style.opacity = '0';
        if (ended.every(Boolean)) finish();
        // Safety for a hidden document, removed CSS, or a cancelled
        // transition: longer than the shared 180ms fade, never its clock.
        else timer = setTimeout(finish, 300);
      },
    };
  }

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !modalStack.length) return;
    // A popover open above a modal owns Escape (its own handler
    // dismisses it) — this capture listener registered first, so it
    // must stand aside or Escape would take both surfaces down.
    if (activePopover) return;
    // So does any overlay the page opens above a modal and marks
    // `data-owns-escape` (a full-size picture over a form): it closes
    // itself, and the modal under it stays. Opt-in, so a page that marks
    // nothing keeps the old behaviour; asked of the document rather than
    // of the focused element, so it holds wherever focus is.
    if (document.querySelector('[data-owns-escape]')) return;
    var top = modalStack[modalStack.length - 1];
    if (top.dismissible) {
      e.preventDefault();
      top.dismiss();
    }
  }, true);

  // Tab stays inside the topmost modal or alert card. The card is appended
  // to <body> after the page, over a backdrop that takes the pointer, but
  // the page behind it was still one Tab away: from the card's last control
  // focus walked out onto whatever was under the dim. So the entries a
  // modal/alert pushes carry `trap` (their card), and Tab from the last
  // focusable wraps to the first, Shift+Tab from the first to the last, and
  // a Tab while focus is outside the card (a click on the backdrop drops it
  // on <body>) brings it back in. Sheets and panels push no `trap` and keep
  // their behaviour.
  //
  // BUBBLE phase, and it stands aside for a Tab something inside the card
  // already handled (`defaultPrevented`: an autocomplete that picks on Tab)
  // and for a popover presented over the modal (its own handler owns Tab).
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
    '[contenteditable="true"]';

  function focusablesIn(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      if (el.closest && el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      return el.getClientRects().length > 0;
    });
  }

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || e.defaultPrevented || !modalStack.length) return;
    if (activePopover) return;
    var card = modalStack[modalStack.length - 1].trap;
    if (!card || !card.parentNode) return;
    var stops = focusablesIn(card);
    var active = document.activeElement;
    var inside = active && card.contains(active);
    if (!stops.length) {
      e.preventDefault();
      try { card.focus(); } catch (err) { /* ignore */ }
      return;
    }
    var first = stops[0];
    var last = stops[stops.length - 1];
    var next = null;
    if (!inside) next = e.shiftKey ? last : first;
    else if (e.shiftKey && (active === first || active === card)) next = last;
    else if (!e.shiftKey && active === last) next = first;
    if (next) {
      e.preventDefault();
      try { next.focus(); } catch (err) { /* ignore */ }
    }
  });

  // ── A modal's fields take focus without moving the page ─────────────
  // Tapping a field in a centred modal let iOS reveal it natively: it
  // scrolled the whole page up under the dialog as the keyboard rose, and
  // back down as it fell, and reported neither until the animation was
  // over. The dialog is `position: fixed`, so it rode that scroll off the
  // top of the screen, and anything compensating for the pan could only
  // move once the report came: a dip on the way up, a throw on the way
  // down. The modal needs no pan. It already moves into the band above the
  // keyboard itself (`--un-kb-inset` in its `top` and height), so the pan
  // is eliminated at its source, as attachKeyboardAvoidance does for a
  // content scroller: the tap on a text field is taken (preventDefault
  // kills the click, the native focus and the native reveal) and the field
  // is focused with preventScroll. What the native reveal did for a field
  // below the fold is done inside the card once it has settled at its new
  // height. Scoped exactly as there: text-entry fields only, a field whose
  // keyboard is up keeps its native caret and selection, a drag past the
  // slop is not a tap, and a finger a recognizer owns is left alone. One
  // addition: a field the dialog focused from code has no keyboard yet, and
  // its first tap is taken too (see onTouchEnd). Returns detach.
  var MODAL_SETTLE_MS = 280; // the modal's 250ms top/height ease, and a frame
  var MODAL_REVEAL_FALLBACK_MS = 700; // no inset reported: resize mode, hardware keys
  function attachModalFieldFocus(card) {
    if (!window.visualViewport || platform === 'desktop') return function () {};
    var touch = null;
    var timers = [];
    var watcher = null;
    var offered = null; // a field focused from code whose keyboard a tap raised

    function fieldAt(target) {
      if (!target || target.nodeType !== 1 || !target.closest) return null;
      var field = target.closest('input, textarea, [contenteditable]');
      if (!field || !card.contains(field)) return null;
      return isTextEntryField({
        tag: field.tagName.toLowerCase(),
        type: field.type,
        readOnly: !!field.readOnly,
        disabled: !!field.disabled,
        contentEditable: !!field.isContentEditable,
      }) ? field : null;
    }

    function reveal(field) {
      if (document.activeElement !== field || !card.contains(field)) return;
      var c = card.getBoundingClientRect();
      var f = field.getBoundingClientRect();
      var delta = revealScrollDelta({
        fieldTop: f.top,
        fieldBottom: f.bottom,
        innerHeight: c.bottom,
        inset: 0,
        margin: 12,
        topLimit: c.top + 12,
      });
      if (!delta) return;
      var max = Math.max(0, card.scrollHeight - card.clientHeight);
      var top = Math.max(0, Math.min(max, card.scrollTop + delta));
      if (top === card.scrollTop) return;
      try {
        card.scrollTo({ top: top, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      } catch (e) {
        card.scrollTop = top;
      }
    }

    function clear() {
      timers.forEach(clearTimeout);
      timers = [];
      if (watcher) {
        var i = kbWatchers.indexOf(watcher);
        if (i >= 0) kbWatchers.splice(i, 1);
        watcher = null;
      }
    }

    // Reveal once the card has its keyboard-up height: straight away on a
    // hop between fields with the keys already up, else when the inset
    // lands and the card has eased to it.
    function settle(field) {
      clear();
      if (kbInset > 0) {
        requestAnimationFrame(function () { reveal(field); });
        return;
      }
      watcher = function (inset) {
        if (!(inset > 0)) return;
        clear();
        timers.push(setTimeout(function () { reveal(field); }, MODAL_SETTLE_MS));
      };
      kbWatchers.push(watcher);
      timers.push(setTimeout(function () { reveal(field); }, MODAL_REVEAL_FALLBACK_MS));
    }

    function onTouchStart(e) {
      touch = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false }
        : null;
    }
    function onTouchMove(e) {
      if (!touch || touch.moved) return;
      if (e.touches.length !== 1) { touch.moved = true; return; }
      if (Math.abs(e.touches[0].clientX - touch.x) > KB_TAP_SLOP
        || Math.abs(e.touches[0].clientY - touch.y) > KB_TAP_SLOP) touch.moved = true;
    }
    function onTouchCancel() { touch = null; }
    function onTouchEnd(e) {
      var t = touch;
      touch = null;
      if (!t || t.moved || !e.cancelable) return;
      if (e.touches && e.touches.length) return;
      if (gestures.owner('touch') != null) return;
      var field = fieldAt(e.target);
      if (!field) return;
      if (document.activeElement === field) {
        // Focused, with its keyboard up (or raised here once already): the
        // tap places the caret, natively.
        if (kbInset > 0 || offered === field) return;
        // Focused from code (a dialog focusing its first field). iOS raises
        // no keyboard for that, and raises it on this tap instead, panning
        // the page as it does. Refocused inside the tap, it comes up with
        // no pan. Once per field: a hardware keyboard never reports an
        // inset, and every later tap there must still place the caret.
        offered = field;
        try { field.blur(); } catch (err) { /* ignore */ }
      }
      e.preventDefault();
      try { field.focus({ preventScroll: true }); } catch (err) {
        try { field.focus(); } catch (err2) { /* ignore */ }
      }
      settle(field);
    }

    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchmove', onTouchMove, { passive: true });
    card.addEventListener('touchend', onTouchEnd, { passive: false });
    card.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return function detach() {
      clear();
      card.removeEventListener('touchstart', onTouchStart);
      card.removeEventListener('touchmove', onTouchMove);
      card.removeEventListener('touchend', onTouchEnd);
      card.removeEventListener('touchcancel', onTouchCancel);
    };
  }

  // presentModal({ content | contentEl, onDismiss?, dismissible? }) —
  // content is an HTML string, contentEl an Element to adopt. dismissible
  // (default true) gates backdrop-tap and Escape. Escape stands aside while
  // an element marked [data-owns-escape] is open (see the keydown listener
  // above). Returns { dismiss(), el }.
  function presentModal(options) {
    var opts = options || {};
    var dismissible = opts.dismissible !== false;
    var backdrop = document.createElement('div');
    backdrop.className = 'un-backdrop un-backdrop-fade';
    var card = document.createElement('div');
    card.className = 'un-modal';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.tabIndex = -1;
    if (opts.contentEl) card.appendChild(opts.contentEl);
    else if (opts.content != null) card.innerHTML = opts.content;
    document.body.appendChild(backdrop);
    document.body.appendChild(card);

    var prevFocus = document.activeElement;
    var closed = false;
    // `trap`: Tab cycles inside this card while it is the topmost entry.
    var entry = { dismissible: dismissible, dismiss: dismiss, trap: card };
    modalStack.push(entry);
    var detachFieldFocus = attachModalFieldFocus(card);
    var fade = animateDialog(card, backdrop, function () {
      var auto = card.querySelector('[autofocus]');
      try { (auto || card).focus(); } catch (e) { /* ignore */ }
    });

    function dismiss() {
      if (closed) return;
      closed = true;
      detachFieldFocus();
      var i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      fade.dismiss(function () {
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (e) { /* ignore */ }
        }
        if (opts.onDismiss) opts.onDismiss();
      });
    }

    if (dismissible) onBackdropDismiss(backdrop, function () { dismiss(); }, card);

    return { el: card, dismiss: dismiss };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Side panel / drawer — a full-height surface that springs in from the
   * right (default) or left edge, over the shared dimmed backdrop.
   *
   * DELIBERATELY NOT DRAGGABLE. The platform navigation drawers this
   * mirrors are not swipe-dismissed surfaces with a grabber affordance —
   * that idiom belongs to the bottom sheet, where the tray is a transient
   * thing you flick away. A drawer is opened by a control and closed by
   * the backdrop, the ✕, Escape, or picking a row. So there is no pointer
   * handling here at all, which also means: no gesture-arbiter claim to
   * contend with, no click-swallow to get wrong, and vertical scrolling
   * inside the panel is plain native scrolling (no `touch-action`
   * narrowing in native.css). An earlier revision of this component did
   * ship drag-to-dismiss plus a grabber pill; both were removed as
   * un-native. Don't reintroduce them without the idiom actually changing.
   *
   * What remains is the sheet's PRESENTATION contract rotated 90°: JS owns
   * translateX (spring in, spring out — no CSS transition on transform)
   * and the backdrop opacity rides the position, so the dim and the slide
   * are one motion.
   *
   * x is signed by side: `dir` is +1 for a right panel (leaving = moving
   * right, positive translateX) and -1 for a left one, so everything below
   * is written once in "displacement toward my own edge" terms and only
   * render() touches the sign. x still goes slightly NEGATIVE (past the
   * rest position, into the page) because the `sheet` preset is
   * underdamped and its entrance overshoots — which lifts the panel off
   * its screen edge, and is what `.un-panel::after` covers by continuing
   * the surface outward. Keep those two halves together.
   * ──────────────────────────────────────────────────────────────────── */

  // presentPanel({ side?, content | contentEl, width?, onDismiss? })
  // — side is 'right' (default) or 'left'; content is an HTML string,
  // contentEl an Element to adopt; width is any CSS length (sets
  // --un-panel-width for this instance). Returns { dismiss(), el }.
  function presentPanel(options) {
    var opts = options || {};
    var side = opts.side === 'left' ? 'left' : 'right';
    var dir = side === 'right' ? 1 : -1;

    var backdrop = document.createElement('div');
    backdrop.className = 'un-backdrop';
    var panel = document.createElement('div');
    panel.className = 'un-panel';
    panel.setAttribute('data-un-side', side);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    if (opts.width) panel.style.setProperty('--un-panel-width', String(opts.width));
    var body = document.createElement('div');
    body.className = 'un-panel-body';
    if (opts.contentEl) body.appendChild(opts.contentEl);
    else if (opts.content != null) body.innerHTML = opts.content;
    panel.appendChild(body);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    var width = panel.offsetWidth || 1;
    var x = width; // displacement toward the panel's edge: 0 = presented
    var activeSpring = null;
    var closed = false;
    var prevFocus = document.activeElement;
    var entry = { dismissible: true, dismiss: function () { dismiss(); } };
    modalStack.push(entry);

    function render(val) {
      x = val;
      panel.style.transform = 'translateX(' + (val * dir) + 'px)';
      var presence = String(Math.max(0, Math.min(1, 1 - val / width)));
      backdrop.style.opacity = presence;
      // `--un-presence` on the panel, as on the sheet: see presentSheet.
      panel.style.setProperty('--un-presence', presence);
    }

    function springTo(to, onRest) {
      if (activeSpring) activeSpring.stop();
      if (prefersReducedMotion) {
        render(to);
        if (onRest) onRest();
        return;
      }
      // Once closed the spring is the exit: it ends off-screen (see the
      // sheet's springTo).
      activeSpring = spring(function (v) { render(v); }, {
        from: x, to: to, preset: 'sheet', exit: closed,
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function teardown() {
      if (unwatch) unwatch();
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) { /* ignore */ }
      }
      if (opts.onDismiss) opts.onDismiss();
    }

    function dismiss() {
      if (closed) return;
      closed = true;
      var i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      releaseInput(backdrop, panel);
      springTo(width, teardown);
    }

    onBackdropDismiss(backdrop, function () { dismiss(); }, panel);

    // Rotation / viewport resize changes --un-panel-width, which feeds the
    // backdrop denominator and the exit travel.
    var unwatch = watchSize(panel, 'offsetWidth', function (newWidth) {
      width = newWidth;
      // An exit spring was aiming at the old width — retarget so the panel
      // fully leaves the screen before teardown.
      if (closed) springTo(width, teardown);
      else springTo(0);
    });

    render(width);
    springTo(0);
    var auto = body.querySelector('[autofocus]');
    try { (auto || panel).focus({ preventScroll: true }); } catch (e) { /* ignore */ }

    return {
      el: panel,
      dismiss: dismiss,
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Menu-row content — the one place a row's label (and its optional
   * icon) is put into a button, shared by the action sheet and the
   * popover so the two idioms cannot drift.
   * ──────────────────────────────────────────────────────────────────── */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // A row's icon element, or null when it has none. `iconEl` wins over a
  // named icon: a caller that supplied artwork meant it. The node is used
  // as given, not cloned, so supply a fresh one per row — a menu is built
  // from scratch on every open, which is where callers naturally do.
  function buildRowIcon(item) {
    if (item.iconEl && item.iconEl.nodeType === 1) {
      item.iconEl.classList.add('un-item-icon');
      return item.iconEl;
    }
    var paths = iconPaths(item.icon);
    if (!paths) return null;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'un-item-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    // Decorative: the label beside it already names the row, so a screen
    // reader that announced the icon too would say everything twice.
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  // Fill a row button. `aligned` is the menu-level answer to "does ANY row
  // here carry an icon" — when one does, the rows that don't get an empty
  // spacer so every label in the menu starts at the same x. Without it a
  // mixed menu reads as a mistake.
  //
  // The no-icon, no-alignment path is a bare textContent assignment: the
  // DOM a row had before icons existed, to the node.
  function fillRowButton(btn, item, aligned) {
    var icon = buildRowIcon(item);
    if (!icon && !aligned) {
      btn.textContent = item.label;
      return;
    }
    btn.classList.add('un-has-icon');
    if (icon) {
      btn.appendChild(icon);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'un-item-icon un-item-icon-empty';
      spacer.setAttribute('aria-hidden', 'true');
      btn.appendChild(spacer);
    }
    // A span, not a text node beside the icon: the label is the part that
    // truncates, and `btn.textContent` still answers the label alone
    // because an SVG contributes no text — so a caller asserting on a
    // row's text keeps working.
    var text = document.createElement('span');
    text.className = 'un-item-label';
    text.textContent = item.label;
    btn.appendChild(text);
  }

  // Does this menu need its labels aligned to a common left edge?
  function menuHasIcons(items) {
    for (var i = 0; i < items.length; i += 1) {
      if (rowHasIcon(items[i])) return true;
    }
    return false;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Action sheet — iOS stack of actions + separate Cancel card. Resolves
   * with the chosen action object, or null on cancel/backdrop.
   * ──────────────────────────────────────────────────────────────────── */

  // The page's address, for a surface that closes when it moves.
  function currentHref() {
    try { return window.location.href; } catch (_) { return null; }
  }

  // actionSheet({ title?, actions: [{ label, icon?, iconEl?, destructive?,
  // highlighted?, handler? }], cancelLabel? }) — returns a Promise.
  // `highlighted` lights one row (a tint behind it, its label bold): the
  // action the menu leads with. Meant for one row, not a style for many.
  function actionSheet(options) {
    var opts = options || {};
    var actions = opts.actions || [];
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'un-backdrop';
      var wrap = document.createElement('div');
      wrap.className = 'un-action-sheet';

      var card = document.createElement('div');
      card.className = 'un-action-card';
      if (opts.title) {
        var title = document.createElement('div');
        title.className = 'un-action-title';
        title.textContent = opts.title;
        card.appendChild(title);
      }
      var sheetAligned = menuHasIcons(actions);
      actions.forEach(function (action) {
        // A SECTION HEADING, not an action. Callers whose menu is grouped —
        // the dev board's "+" is the first — used to have nowhere to put a
        // group label, so they passed it as an ordinary action with a no-op
        // handler and dashes around the text to signal it was not tappable.
        // It still looked and behaved like a row: same weight, same ink, and
        // it took taps. This renders it as what it is, so the sheet can carry
        // structure without every caller inventing its own punctuation.
        if (action.heading) {
          var head = document.createElement('div');
          head.className = 'un-action-title un-action-section';
          head.textContent = action.label || '';
          card.appendChild(head);
          return;
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-action-btn' + (action.destructive ? ' un-destructive' : '')
          + (action.highlighted ? ' un-highlighted' : '');
        fillRowButton(btn, action, sheetAligned);
        btn.addEventListener('click', function () { settle(action); });
        card.appendChild(btn);
      });
      wrap.appendChild(card);

      var cancelCard = document.createElement('div');
      cancelCard.className = 'un-action-card';
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'un-action-btn un-action-cancel';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      cancelBtn.addEventListener('click', function () { settle(null); });
      cancelCard.appendChild(cancelBtn);
      wrap.appendChild(cancelCard);

      document.body.appendChild(backdrop);
      document.body.appendChild(wrap);

      var height = wrap.offsetHeight || 1;
      var y = height;
      var activeSpring = null;
      var settled = false;

      function render(val) {
        y = val;
        wrap.style.transform = 'translateY(' + val + 'px)';
        backdrop.style.opacity = String(Math.max(0, Math.min(1, 1 - val / height)));
      }

      // Once settled the spring is the exit, and it ends off-screen, so the
      // chosen action's handler runs as the sheet leaves rather than ~200ms
      // after (see the sheet's springTo).
      function springTo(to, velocity, onRest) {
        if (activeSpring) activeSpring.stop();
        activeSpring = spring(function (v) { render(v); }, {
          from: y, to: to, velocity: velocity || 0, preset: 'sheet', exit: settled,
          onRest: function () { activeSpring = null; if (onRest) onRest(); },
        });
      }

      var settleAction = null; // the chosen action while the exit spring runs
      function finishSettle() {
        if (unwatch) unwatch();
        stopNavWatch();
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (settleAction && settleAction.handler) settleAction.handler();
        resolve(settleAction || null);
      }

      function settle(action) {
        if (settled) return;
        settled = true;
        settleAction = action || null;
        releaseInput(backdrop, wrap);
        springTo(height, 0, finishSettle);
      }

      onBackdropDismiss(backdrop, function () { settle(null); }, wrap);

      // A MOVE TO ANOTHER ADDRESS CLOSES IT, as a Cancel would (audit D01,
      // 2 Nov 2026). Back, a swipe back or a link written under it left the
      // sheet floating over the next screen, and the next tap only closed
      // it. Only a move away from where it opened counts.
      var openedAt = currentHref();
      function onNav() { if (currentHref() !== openedAt) settle(null); }
      function stopNavWatch() {
        window.removeEventListener('popstate', onNav);
        window.removeEventListener('hashchange', onNav);
      }
      window.addEventListener('popstate', onNav);
      window.addEventListener('hashchange', onNav);

      // Same present-time height assumption as the bottom sheet (issue
      // #742). The API can't receive late content, but a re-measure (e.g.
      // a web-font reflow of labels) still retargets cleanly.
      // watchSize's `prop` argument is not optional — see the scope test
      // in tests/native-kit.test.js, which exists because this call site
      // was left on the pre-#915 `watchHeight(el, cb)` signature and
      // threw here, wedging every touch action sheet (issue #929).
      var unwatch = watchSize(wrap, 'offsetHeight', function (newHeight, oldHeight) {
        height = newHeight;
        var v = activeSpring ? activeSpring.current().v : 0;
        if (settled) { springTo(height, v, finishSettle); return; }
        render(remeasuredSheetY({ y: y, oldHeight: oldHeight, newHeight: newHeight }));
        springTo(0, v);
      });

      render(height);
      springTo(0, 0);
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Anchored popover / dropdown menu — the desktop menu idiom (#741):
   * a panel attached to the control that invoked it, flipped/clamped to
   * stay in the viewport, dismissed by outside-click / Escape / scroll /
   * resize. No backdrop and no entrance animation (menus are
   * high-frequency UI — see the fidelity rules). Singleton: opening one
   * dismisses any open popover.
   * ──────────────────────────────────────────────────────────────────── */

  // The one open popover (also consulted by the modal Escape handler
  // above). { dismiss } while a popover is up, null otherwise.
  var activePopover = null;

  // popover({ anchorEl | anchorRect, items | contentEl | content,
  // title?, headerEl?, placement?, onDismiss? }).
  //
  // Items share the actionSheet shape plus popover extensions:
  // { label, icon?, iconEl?, destructive?, disabled?, keepOpen?, title?,
  //   handler? } —
  // disabled renders an inert row, keepOpen runs handler without
  // dismissing (in-place feedback flows), and handler receives the row's
  // <button> element. headerEl is adopted verbatim (it brings its own
  // padding/hairline); title renders in the kit's own header slot.
  //
  // Items mode returns a Promise resolving the chosen item or null on
  // dismissal, with a .dismiss() method attached for programmatic close;
  // content mode returns { el, dismiss() }.
  function popover(options) {
    var opts = options || {};
    if (Array.isArray(opts.items)) {
      var handle;
      var promise = new Promise(function (resolve) {
        handle = presentPopover(opts, resolve);
      });
      promise.dismiss = handle.dismiss;
      return promise;
    }
    return presentPopover(opts, null);
  }

  function presentPopover(opts, resolve) {
    if (activePopover) activePopover.dismiss();

    var anchorEl = opts.anchorEl && opts.anchorEl.nodeType === 1 ? opts.anchorEl : null;
    var anchor = opts.anchorRect
      || (anchorEl && anchorEl.getBoundingClientRect())
      || { left: 8, top: 8, right: 8, bottom: 8 };
    var itemsMode = Array.isArray(opts.items);

    var el = document.createElement('div');
    el.className = 'un-popover';
    el.tabIndex = -1;

    if (opts.headerEl) {
      el.appendChild(opts.headerEl);
    } else if (opts.title) {
      var header = document.createElement('div');
      header.className = 'un-popover-header';
      var title = document.createElement('div');
      title.className = 'un-popover-title';
      title.textContent = opts.title;
      header.appendChild(title);
      el.appendChild(header);
    }

    var itemBtns = [];
    var closed = false;

    if (itemsMode) {
      el.setAttribute('role', 'menu');
      var popoverAligned = menuHasIcons(opts.items);
      opts.items.forEach(function (item) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-popover-item' + (item.destructive ? ' un-destructive' : '');
        btn.setAttribute('role', 'menuitem');
        fillRowButton(btn, item, popoverAligned);
        if (item.title) btn.title = item.title;
        if (item.disabled) {
          btn.disabled = true;
        } else {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (item.keepOpen) {
              if (item.handler) item.handler(btn);
              return;
            }
            settle(item, btn);
          });
        }
        el.appendChild(btn);
        itemBtns.push(btn);
      });
    } else if (opts.contentEl) {
      el.appendChild(opts.contentEl);
    } else if (opts.content != null) {
      el.innerHTML = opts.content;
    }

    // Measure hidden, place via the pure math, reveal — instant, no
    // entrance animation.
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    var pos = placePopover({
      anchor: anchor,
      size: { w: el.offsetWidth, h: el.offsetHeight },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      placement: opts.placement,
    });
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.visibility = '';

    var prevFocus = document.activeElement;
    var entry = { dismiss: function () { settle(null, null); } };
    activePopover = entry;
    if (anchorEl) anchorEl.setAttribute('aria-expanded', 'true');

    // One-shot suppressor for the click that follows an anchor
    // pointerdown-dismiss: without it the anchor's own open handler
    // fires and the menu instantly reopens instead of toggling closed.
    function swallowAnchorClick(e) {
      document.removeEventListener('click', swallowAnchorClick, true);
      if (anchorEl && anchorEl.contains(e.target)) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    function onDocPointerDown(e) {
      if (el.contains(e.target)) return;
      if (anchorEl && anchorEl.contains(e.target)) {
        document.addEventListener('click', swallowAnchorClick, true);
      }
      settle(null, null);
    }

    function enabledBtns() {
      return itemBtns.filter(function (b) { return !b.disabled; });
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(null, null);
        return;
      }
      if (e.key === 'Tab') {
        // Native menu convention: Tab closes a MENU; focus restore +
        // default Tab then move focus onward from the anchor. Content
        // popovers keep Tab for their own focusables.
        if (itemsMode) settle(null, null);
        return;
      }
      var enabled = enabledBtns();
      if (!enabled.length) return;
      var idx = enabled.indexOf(document.activeElement);
      var next = null;
      if (e.key === 'ArrowDown') next = enabled[idx < 0 ? 0 : (idx + 1) % enabled.length];
      else if (e.key === 'ArrowUp') next = enabled[idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length];
      else if (e.key === 'Home') next = enabled[0];
      else if (e.key === 'End') next = enabled[enabled.length - 1];
      if (next) {
        e.preventDefault();
        try { next.focus(); } catch (err) { /* ignore */ }
      }
    }

    // Scroll/resize dismissal arms after the first painted frame: layout
    // work around the opening click (scroll anchoring, text reflow) can
    // emit an async scroll event that would otherwise kill the popover
    // the instant it opens. A real user scroll is a stream of events —
    // losing the pre-paint ones is imperceptible. pointerdown/keydown
    // stay armed immediately (the intent there is unambiguous).
    var scrollArmed = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { scrollArmed = true; });
    });

    function onScroll(e) {
      if (!scrollArmed) return;
      // A long menu scrolling internally must not dismiss itself.
      if (e.target && e.target.nodeType === 1 && el.contains(e.target)) return;
      settle(null, null);
    }

    function onResize() {
      if (!scrollArmed) return;
      settle(null, null);
    }

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    // settle(item, btn): tear down, run the chosen item's handler (none
    // on plain dismissal), resolve. Exactly-once.
    function settle(item, btn) {
      if (closed) return;
      closed = true;
      if (activePopover === entry) activePopover = null;
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
      if (el.parentNode) el.parentNode.removeChild(el);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) { /* ignore */ }
      }
      if (item && item.handler) item.handler(btn || null);
      if (opts.onDismiss) opts.onDismiss();
      if (resolve) resolve(item || null);
    }

    // Focus moves into the menu (first enabled item) or the container.
    var focusTarget = enabledBtns()[0] || el;
    try { focusTarget.focus(); } catch (e) { /* ignore */ }

    return { el: el, dismiss: entry.dismiss };
  }

  // menu({ anchorEl | anchorRect, title?, headerEl?, items, cancelLabel?,
  // placement? }) — the adaptive menu: a bottom action sheet on touch
  // platforms, an anchored popover on desktop, from one actionSheet-shaped
  // call site. Always returns a Promise resolving the chosen item or null,
  // with a .dismiss() attached (a no-op on the sheet path — action sheets
  // have no programmatic dismissal).
  function menu(options) {
    var opts = options || {};
    var items = opts.items || [];
    if (platform !== 'desktop') {
      // Action sheets have no inert-row concept — disabled rows are
      // omitted; keepOpen degrades to a normal dismiss-and-run.
      var p = actionSheet({
        title: opts.title,
        cancelLabel: opts.cancelLabel,
        actions: items.filter(function (i) { return !i.disabled; }),
      });
      p.dismiss = function () {};
      return p;
    }
    return popover({
      anchorEl: opts.anchorEl,
      anchorRect: opts.anchorRect,
      title: opts.title,
      headerEl: opts.headerEl,
      placement: opts.placement,
      items: items,
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Alert dialog — the compact centered iOS alert. Fade + scale-down
   * entrance (alerts don't spring from an edge). Resolves with
   * { button, value } — value is the field text when a field was shown.
   * ──────────────────────────────────────────────────────────────────── */

  // alert({ title, message?, field?: { placeholder?, value?, maxLength?,
  // submitOnEnter? }, buttons?: [{ label, style?: 'cancel'|'default'|
  // 'destructive', handler? }] }) — returns a Promise. Named alertDialog
  // internally so it can't be confused with window.alert; exposed as
  // unNative.alert. `maxLength` caps the field; `submitOnEnter` makes Enter
  // in it press the last button that is not a cancel, the way a one-field
  // form submits. Both are opt-in: a caller that passes neither gets the
  // field it always got.
  function alertDialog(options) {
    var opts = options || {};
    var buttons = opts.buttons && opts.buttons.length
      ? opts.buttons
      : [{ label: 'OK', style: 'default' }];
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'un-backdrop un-backdrop-fade';
      var card = document.createElement('div');
      card.className = 'un-alert';
      // Announced as a modal alert dialog, named by its title and described
      // by its message, and focusable as a last resort for the Tab trap.
      var uid = 'un-alert-' + (++alertSeq);
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', uid + '-title');
      card.tabIndex = -1;

      var title = document.createElement('div');
      title.className = 'un-alert-title';
      title.id = uid + '-title';
      title.textContent = opts.title || '';
      card.appendChild(title);
      if (opts.message) {
        var msg = document.createElement('div');
        msg.className = 'un-alert-message';
        msg.id = uid + '-message';
        msg.textContent = opts.message;
        card.appendChild(msg);
        card.setAttribute('aria-describedby', uid + '-message');
      }
      var field = null;
      if (opts.field) {
        field = document.createElement('input');
        field.type = 'text';
        field.className = 'un-alert-field';
        if (opts.field.placeholder) field.placeholder = opts.field.placeholder;
        if (opts.field.value != null) field.value = opts.field.value;
        if (opts.field.maxLength > 0) field.maxLength = opts.field.maxLength;
        card.appendChild(field);
      }

      var row = document.createElement('div');
      row.className = 'un-alert-buttons' + (buttons.length > 2 ? ' un-stacked' : '');
      var settled = false;
      var btnEls = [];
      var prevFocus = document.activeElement;
      // The alert is a modal-stack entry too, so Escape answers IT rather
      // than dismissing a modal underneath (Remove member is asked from
      // inside the members dialog), and Tab stays on its buttons. Escape
      // means the cancel-style button, or the only button there is; an
      // alert with two answers and no cancel has no Escape.
      var escapeIdx = -1;
      buttons.forEach(function (button, i) { if (escapeIdx < 0 && button.style === 'cancel') escapeIdx = i; });
      if (escapeIdx < 0 && buttons.length === 1) escapeIdx = 0;
      var entry = {
        dismissible: escapeIdx >= 0,
        dismiss: function () { if (escapeIdx >= 0) btnEls[escapeIdx].click(); },
        trap: card,
      };
      modalStack.push(entry);
      var submitBtn = null;
      buttons.forEach(function (button) {
        var btn = document.createElement('button');
        if (button.style !== 'cancel') submitBtn = btn;
        btn.type = 'button';
        btn.className = 'un-alert-btn' +
          (button.style === 'cancel' ? ' un-cancel' : '') +
          (button.style === 'destructive' ? ' un-destructive' : '');
        btn.textContent = button.label;
        btn.addEventListener('click', function () {
          if (settled) return;
          settled = true;
          var at = modalStack.indexOf(entry);
          if (at >= 0) modalStack.splice(at, 1);
          var value = field ? field.value : undefined;
          fade.dismiss(function () {
            // Focus goes back where it was before the alert, BEFORE the
            // answer is delivered, so a caller that moves focus on the
            // answer has the last word.
            if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected !== false) {
              try { prevFocus.focus(); } catch (e) { /* ignore */ }
            }
            if (button.handler) button.handler(value);
            resolve({ button: button, value: value });
          });
        });
        btnEls.push(btn);
        row.appendChild(btn);
      });
      card.appendChild(row);
      if (field && opts.field.submitOnEnter && submitBtn) {
        field.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          submitBtn.click();
        });
      }

      // Which control starts with focus: the text field when there is one;
      // otherwise Cancel when another answer is destructive (the safe
      // default for "Block", "Delete", "Leave"), else the last button, the
      // primary answer.
      var hasDestructive = buttons.some(function (b) { return b.style === 'destructive'; });
      var initial = field
        || (hasDestructive && escapeIdx >= 0 && buttons[escapeIdx].style === 'cancel' ? btnEls[escapeIdx] : null)
        || btnEls[btnEls.length - 1];

      document.body.appendChild(backdrop);
      document.body.appendChild(card);
      var fade = animateDialog(card, backdrop, function () {
        try { (initial || card).focus(); } catch (e) { /* ignore */ }
      });
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Toast — transient status notice. iOS/desktop: bottom capsule HUD;
   * Android: Material snackbar. Singleton, last-writer-wins among
   * ordinary toasts: a call while a toast is visible swaps its content
   * in place and resets the timer (no re-entrance animation, no
   * stacking). An opt-in PRIORITY toast (undo flows) is NOT displaced by
   * ordinary toasts — those wait in a one-deep pending slot (latest
   * wins) and present after the priority toast resolves. Every toast may
   * pass onClose(reason), fired exactly once per call — 'timeout' |
   * 'action' | 'dismiss' | 'replaced' — so a pending undo can never
   * vanish silently. pointer-events: none unless an action is present,
   * so it never steals taps from content underneath.
   * ──────────────────────────────────────────────────────────────────── */

  var toastEl = null;
  var toastHideTimer = null;
  var toastRemoveTimer = null;
  var toastSlot = createToastSlot();

  // Exactly-once onClose delivery; an app callback that throws must not
  // break the kit.
  function closeToastRecord(record, reason) {
    if (!record || record.closed) return;
    record.closed = true;
    if (record.onClose) {
      try { record.onClose(reason); } catch (e) { /* ignore */ }
    }
  }

  function removeToast() {
    if (toastRemoveTimer) { clearTimeout(toastRemoveTimer); toastRemoveTimer = null; }
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
  }

  // Fade out and tear down the element; onGone runs once it's removed
  // (immediately when there's nothing to fade). A replacement re-entering
  // the element mid-fade aborts both the teardown and the onGone.
  function hideToast(onGone) {
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    if (!toastEl || !toastEl.classList.contains('un-in')) {
      if (onGone) onGone();
      return;
    }
    toastEl.classList.remove('un-in');
    var el = toastEl;
    function teardown() {
      // Only tear down if this is still the fading-out element (a new
      // toast may have re-entered it in the meantime).
      if (toastEl !== el || el.classList.contains('un-in')) return;
      removeToast();
      if (onGone) onGone();
    }
    el.addEventListener('transitionend', teardown, { once: true });
    toastRemoveTimer = setTimeout(teardown, 300);
  }

  // Write a record into the singleton element and start its hide timer.
  function presentToast(record) {
    if (record.closed || toastSlot.current() !== record) return;
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null; }
    if (toastRemoveTimer) { clearTimeout(toastRemoveTimer); toastRemoveTimer = null; }

    var fresh = !toastEl;
    if (fresh) {
      toastEl = document.createElement('div');
      toastEl.className = 'un-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      // Tap to dismiss, for the records that allow it (toastTapDismisses);
      // the CSS gives only those `pointer-events`, so every other toast
      // still lets a tap through to the content under it.
      toastEl.addEventListener('click', function () {
        var shown = toastSlot.current();
        if (shown && shown.tapDismiss && !shown.closed) resolveToast(shown, 'dismiss');
      });
      document.body.appendChild(toastEl);
    }
    toastEl.classList.toggle('un-has-action', !!record.action);
    toastEl.classList.toggle('un-dismissible', !!record.tapDismiss);
    while (toastEl.firstChild) toastEl.removeChild(toastEl.firstChild);
    var msg = document.createElement('div');
    msg.className = 'un-toast-msg';
    msg.textContent = record.message == null ? '' : String(record.message);
    toastEl.appendChild(msg);
    if (record.action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'un-toast-action';
      btn.textContent = record.action.label;
      btn.addEventListener('click', function () {
        if (record.closed || toastSlot.current() !== record) return;
        if (record.action.handler) record.action.handler();
        resolveToast(record, 'action');
      });
      toastEl.appendChild(btn);
    }

    if (fresh && !prefersReducedMotion) {
      // Next frame: engage the CSS entrance. A replacement while visible
      // (or mid-fade-out) re-asserts un-in immediately — content swaps in
      // place with no re-entrance.
      requestAnimationFrame(function () {
        if (toastEl && !record.closed && toastSlot.current() === record) {
          toastEl.classList.add('un-in');
        }
      });
    } else {
      toastEl.classList.add('un-in');
    }

    toastHideTimer = setTimeout(function () {
      resolveToast(record, 'timeout');
    }, record.duration);
  }

  // End the VISIBLE record's lifetime: fire its onClose, fade out, then
  // present whatever was waiting in the pending slot (fresh entrance,
  // full duration starting now).
  function resolveToast(record, reason) {
    if (record.closed || toastSlot.current() !== record) return;
    closeToastRecord(record, reason);
    var next = toastSlot.resolve(record);
    hideToast(function () {
      if (next && !next.closed && toastSlot.current() === next) presentToast(next);
    });
  }

  // toast(message, { duration?, action?: { label, handler }, priority?,
  // error?, dismissible?, onClose?(reason) }) — returns { dismiss(), el }.
  // With no `duration`, a longer message stays longer (toastDuration) and
  // one that outstays the short default can be tapped away
  // (toastTapDismisses); a tap closes it with reason 'dismiss'. A priority toast is
  // not displaced by ordinary toasts (those queue, one deep, latest
  // wins); onClose fires exactly once with 'timeout' | 'action' |
  // 'dismiss' | 'replaced'. `el` is the live toast element while this
  // call is the one displayed (null while pending or after close);
  // dismiss() also cancels a still-pending toast and is a no-op once a
  // later toast has closed this one.
  function toast(message, options) {
    var opts = options || {};
    var action = opts.action && opts.action.label != null ? opts.action : null;
    var duration = toastDuration(message, opts);
    var record = {
      message: message,
      action: action,
      duration: duration,
      tapDismiss: toastTapDismisses(opts, duration),
      priority: !!opts.priority,
      onClose: typeof opts.onClose === 'function' ? opts.onClose : null,
      closed: false,
    };

    // Close whatever this arrival displaces BEFORE presenting, so an app
    // re-toasting from onClose sees consistent state.
    var placement = toastSlot.show(record);
    for (var i = 0; i < placement.closed.length; i++) {
      closeToastRecord(placement.closed[i], 'replaced');
    }
    if (placement.display === 'replace') presentToast(record);

    return {
      get el() {
        return !record.closed && toastSlot.current() === record ? toastEl : null;
      },
      dismiss: function () {
        if (record.closed) return;
        if (toastSlot.current() === record) resolveToast(record, 'dismiss');
        else if (toastSlot.cancelPending(record)) closeToastRecord(record, 'dismiss');
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Nav bars — blurred compact bar with hairline-on-scroll, optional
   * collapsing large title.
   * ──────────────────────────────────────────────────────────────────── */

  var NAVBAR_COLLAPSE_PX = 44; // scroll distance over which the large title fades

  // attachNavBar(barEl, { scrollEl?, largeTitleEl? }) — barEl is a
  // .un-navbar element; scrollEl defaults to the window scroller (same
  // detection as attachPullToRefresh). Toggles .un-scrolled (hairline) and,
  // when largeTitleEl is given, fades/scales it out and toggles
  // .un-collapsed on the bar (revealing the compact .un-navbar-title).
  // Returns { detach() }; never throws.
  function attachNavBar(barEl, options) {
    var noop = { detach: function () {} };
    if (!barEl || barEl.nodeType !== 1) {
      console.warn('[unNative] attachNavBar: barEl must be an Element — nav bar helper disabled.');
      return noop;
    }
    var opts = options || {};
    var scrollEl = opts.scrollEl;
    var windowMode = !scrollEl || scrollEl === window || scrollEl === document ||
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement || scrollEl === document.body;
    var listenEl = windowMode ? window : scrollEl;
    var large = opts.largeTitleEl && opts.largeTitleEl.nodeType === 1 ? opts.largeTitleEl : null;
    if (large) barEl.classList.add('un-has-large');

    function update() {
      var top = windowMode ? (window.scrollY || 0) : scrollEl.scrollTop;
      barEl.classList.toggle('un-scrolled', top > 1);
      if (large) {
        var p = Math.max(0, Math.min(1, top / NAVBAR_COLLAPSE_PX));
        large.style.opacity = String(1 - p);
        large.style.transform = 'scale(' + (1 - 0.1 * p) + ')';
        barEl.classList.toggle('un-collapsed', p >= 1);
      }
    }

    listenEl.addEventListener('scroll', update, { passive: true });
    update();

    return {
      detach: function () {
        listenEl.removeEventListener('scroll', update);
        barEl.classList.remove('un-scrolled', 'un-collapsed', 'un-has-large');
        if (large) { large.style.opacity = ''; large.style.transform = ''; }
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Keyboard avoidance for fixed-shell content scrollers (issue #730).
   * The global tracker above covers the kit's own overlays; this attacher
   * gives the APP's main content scroller the same physics. Fixed-shell
   * recipe: `html, body { height:100%; overflow:hidden }` plus one
   * `position:fixed; inset:0; overflow-y:auto` scroller — the keyboard
   * can never scroll/reflow the page frame, only content slides.
   *
   * What it owns (each was a hand-tuned Gym Tracker workaround):
   *  - Keyboard clearance as CONTENT PADDING on the scroller (class
   *    un-kb-avoid; CSS makes it instant on open, ~150ms eased on close
   *    so the browser's scrollTop clamp rides the ease instead of
   *    snapping).
   *  - The browser's native reveal-on-focus can't be coordinated with —
   *    only eliminated: intercept touchend on text-entry fields
   *    (passive:false), preventDefault (kills click + native focus +
   *    native reveal), focus with preventScroll:true, then ONE
   *    keyboard-aware scroll. Tightly scoped: text-entry allowlist only,
   *    the already-focused field is skipped (native caret/selection), an
   *    ~8px touchmove slop keeps scroll-drags ending on a field from
   *    being hijacked, and a finger claimed through the gesture arbiter
   *    is never touched.
   *  - Field-to-field hops fire NO visualViewport events — a focusin
   *    path gated on html.un-kb reveals synchronously.
   *  - Keyboard open/close fires a BURST of viewport events — reveals
   *    coalesce to one settled pin ~120ms after the last event (with a
   *    ~250ms fallback for resize-mode Android / hardware keyboards,
   *    where no events arrive at all).
   *  - Reveal math is computed manually (scrollIntoView counts fields
   *    under the padding as visible): bottomLimit = innerHeight - inset
   *    - margin, topLimit = topEl bottom + margin, minimal scrollTop
   *    delta.
   *  - iOS can pan the visual viewport before the inset publishes — the
   *    settled pin resets window.scrollTo(0,0), but only when the page
   *    frame is actually a fixed shell.
   *  - A chat's composer sits OUTSIDE its scroller, under it in a column
   *    that reserves the inset itself. Its field's tap is the one that
   *    panned and then snapped back (Homeroom app and iOS Safari, 5 Oct
   *    2026: the composer overshot into the top half of the screen, then
   *    the pin dropped it onto the keys a quarter second later).
   *    opts.column names that column: its fields outside scrollEl take the
   *    same interception, with no reveal (the column's padding is what
   *    places them) and the caret at the end of any draft.
   *  - And the column RIDES the keys (fixed shell, keys covering the page:
   *    the Homeroom app once its web view stops resizing, an installed
   *    app). The keyboard's height arrives about 50ms into its ~300ms
   *    rise, all at once, so the column's padding snapped the composer and
   *    the transcript to the top of where the keys would end while they
   *    were 40% of the way up; on the way down the tab bar's band came back
   *    in the blur while the padding eased out in 150ms, so the composer
   *    hopped up 16pt and then outran the keys. A step of the scroller's
   *    foot that big, this soon after a focus or a blur, is taken back and
   *    played out on the column's padding along the keys' own curve (an
   *    ease-out cubic over 300ms, measured), from where the keys already
   *    are. Padding, not a transform: the transcript keeps following its
   *    newest line on every frame of it (its own resize observer), so the
   *    composer and the messages move as one.
   * ──────────────────────────────────────────────────────────────────── */

  var KB_TAP_SLOP = 8; // px of touchmove that turns a tap into a drag
  var KB_SETTLE_MS = 120; // quiet period after the last visualViewport event
  var KB_FOCUS_FALLBACK_MS = 250; // reveal anyway if no vv event follows a focus
  var KB_RIDE_MS = 300; // the keys' rise and fall (iPhone simulator, iOS 26: ~300ms)
  var KB_RIDE_MIN = 100; // px: only a keyboard-sized step of the column rides
  var KB_RIDE_WINDOW_MS = 1000; // a step this soon after a focus or a blur is the keys'
  // How far up the keys already are when a rise is reported, at most. In
  // the Homeroom app's web view the visual viewport learns the keyboard's
  // height ~90ms into its rise, with the keys ~84% of the way up (iPhone
  // simulator, 5 Oct 2026); time since the focus overstates that, since the
  // keys only start ~100ms after it. Safari reports near the start.
  var KB_RIDE_OPEN_HEAD = 0.45;
  var KB_RIDE_STEPS = 12; // keyframes sampled along the curve

  // The keys' curve, measured frame by frame: 12% of the way at 28ms, 58%
  // at 75ms, 90% at 158ms, 98% at 225ms of a 300ms move.
  function kbEase(x) {
    var t = Math.max(0, Math.min(1, x));
    return 1 - Math.pow(1 - t, 3);
  }

  // The column's padding-bottom keyframes for a ride: the scroller's foot
  // moved by `delta` px (down is positive) to land on `finalPad`; the keys
  // are `x0` of the way through their move. Pure, for the tests.
  function kbRideFrames(finalPad, delta, x0, steps) {
    var n = steps || KB_RIDE_STEPS;
    var frames = [];
    for (var i = 0; i <= n; i++) {
      var x = x0 + (1 - x0) * (i / n);
      var pad = Math.max(0, finalPad + delta * (1 - kbEase(x)));
      frames.push({ paddingBottom: Math.round(pad * 10) / 10 + 'px', offset: i / n });
    }
    return frames;
  }

  // attachKeyboardAvoidance(scrollEl, { topEl?, margin? = 8, fields?, column? }) —
  // scrollEl is the app's content scroller (the fixed-shell inner pane);
  // topEl an optional fixed bar overlaying its top (typically the
  // un-navbar also wired via attachNavBar); margin the breathing room
  // above the keyboard / below topEl; fields an optional CSS selector
  // that REPLACES the default text-entry allowlist. Composes with
  // attachNavBar and element-mode attachPullToRefresh. Sheet/modal/alert
  // fields are body-mounted, outside scrollEl, and keep the kit's
  // existing avoidance. column is the element holding scrollEl and its
  // composer: a field in it but outside scrollEl is focused without the
  // native pan and is not revealed. Structural no-op on desktop or without
  // visualViewport. Returns { detach() }; never throws on bad input.
  function attachKeyboardAvoidance(scrollEl, options) {
    var noop = { detach: function () {} };
    if (!scrollEl || scrollEl.nodeType !== 1) {
      console.warn('[unNative] attachKeyboardAvoidance: scrollEl must be an Element — keyboard avoidance disabled.');
      return noop;
    }
    var vv = window.visualViewport;
    if (platform === 'desktop' || !vv) return noop;
    if (scrollEl.classList.contains('un-kb-avoid')) {
      console.warn('[unNative] attachKeyboardAvoidance: already attached to this element — ignoring.');
      return noop;
    }

    var opts = options || {};
    var topEl = opts.topEl && opts.topEl.nodeType === 1 ? opts.topEl : null;
    var margin = opts.margin != null ? opts.margin : 8;
    var fieldsSel = typeof opts.fields === 'string' ? opts.fields : null;
    var column = opts.column && opts.column.nodeType === 1 && opts.column !== scrollEl
      && opts.column.contains(scrollEl) ? opts.column : null;

    scrollEl.classList.add('un-kb-avoid');

    var touch = null; // { x, y, moved } — the current tap candidate
    var pendingReveal = null; // field awaiting the settled pin / fallback
    var fallbackTimer = null;
    var settleTimer = null;
    var suppressFocusin = null; // field being focused by the interception path

    // The ride (see the header): the scroller's layout foot last seen, when
    // a field last took or let go of the keys, and the running animation.
    var rideAnim = null;
    var lastFoot = null;
    var keysMovedAt = -Infinity;
    var RideObserver = typeof window.ResizeObserver === 'function' ? window.ResizeObserver : null;
    var rides = !!column && !!RideObserver && typeof column.animate === 'function';
    var priorTransition = rides ? column.style.transition : '';

    function clock() {
      return window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
    }
    function footOf() { return scrollEl.offsetTop + scrollEl.offsetHeight; }
    function inFixedShell() {
      try {
        return getComputedStyle(document.documentElement).overflowY === 'hidden'
          || getComputedStyle(document.body).overflowY === 'hidden';
      } catch (e) { return false; }
    }
    // A focus or a blur in the column: the keys are about to move. A ride
    // in flight stops where it is, so the next step starts from what is on
    // screen rather than from where it was headed.
    function onKeysMove() {
      keysMovedAt = clock();
      if (!rideAnim) return;
      lastFoot = footOf();
      var anim = rideAnim;
      rideAnim = null;
      anim.onfinish = anim.oncancel = null;
      try { anim.cancel(); } catch (e) { /* ignore */ }
    }
    function onColumnResize() {
      if (rideAnim) return; // our own padding, frame by frame
      var foot = footOf();
      var before = lastFoot;
      lastFoot = foot;
      if (before == null) return;
      var delta = foot - before;
      if (Math.abs(delta) < KB_RIDE_MIN || prefersReducedMotion || !inFixedShell()) return;
      var since = clock() - keysMovedAt;
      if (!(since >= 0 && since < KB_RIDE_WINDOW_MS)) return;
      // Down (the keys going): they started with the blur. Up: see
      // KB_RIDE_OPEN_HEAD.
      var x0 = Math.min(delta > 0 ? 0.9 : KB_RIDE_OPEN_HEAD, since / KB_RIDE_MS);
      var finalPad = 0;
      try { finalPad = parseFloat(getComputedStyle(column).paddingBottom) || 0; } catch (e) { /* 0 */ }
      try {
        rideAnim = column.animate(kbRideFrames(finalPad, delta, x0), {
          duration: Math.round(KB_RIDE_MS * (1 - x0)),
          easing: 'linear',
        });
      } catch (e) { rideAnim = null; return; }
      rideAnim.onfinish = rideAnim.oncancel = function () {
        rideAnim = null;
        lastFoot = footOf();
      };
    }
    var rideObserver = null;
    if (rides) {
      // The kit's padding transition would outrank the animation (a running
      // transition sits above animations in the cascade); the ride is it.
      column.style.transition = 'none';
      lastFoot = footOf();
      rideObserver = new RideObserver(onColumnResize);
      rideObserver.observe(scrollEl);
      column.addEventListener('focusin', onKeysMove);
      column.addEventListener('focusout', onKeysMove);
    }

    function kbUp() {
      return document.documentElement.classList.contains('un-kb');
    }

    // Where a field may be: the scroller, or the composer column around it.
    function inReach(node) {
      return scrollEl.contains(node) || (!!column && column.contains(node));
    }

    // Resolve a tap/focus target to an interceptable field, or null.
    function matchField(target) {
      if (!target || target.nodeType !== 1 || !target.closest) return null;
      if (!inReach(target)) return null;
      if (fieldsSel) {
        var custom = target.closest(fieldsSel);
        return custom && inReach(custom) ? custom : null;
      }
      var field = target.closest('input, textarea, [contenteditable]');
      if (!field || !inReach(field)) return null;
      var tag = field.tagName.toLowerCase();
      return isTextEntryField({
        tag: tag,
        type: field.type,
        readOnly: !!field.readOnly,
        disabled: !!field.disabled,
        contentEditable: !!field.isContentEditable,
      }) ? field : null;
    }

    // The ONE keyboard-aware scroll: minimal scrollTop delta placing the
    // field above the keyboard and below topEl. Content padding (the
    // un-kb-avoid rule) has already made the room exist.
    function reveal(field) {
      if (!field || !scrollEl.contains(field)) return;
      var rect = field.getBoundingClientRect();
      var topLimit;
      if (topEl) {
        topLimit = topEl.getBoundingClientRect().bottom + margin;
      } else {
        topLimit = Math.max(scrollEl.getBoundingClientRect().top, 0) + margin;
      }
      var delta = revealScrollDelta({
        fieldTop: rect.top,
        fieldBottom: rect.bottom,
        innerHeight: window.innerHeight,
        inset: kbInset,
        margin: margin,
        topLimit: topLimit,
      });
      if (!delta) return;
      var max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      var top = Math.max(0, Math.min(max, scrollEl.scrollTop + delta));
      if (top === scrollEl.scrollTop) return;
      try {
        scrollEl.scrollTo({ top: top, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      } catch (e) {
        scrollEl.scrollTop = top;
      }
    }

    function clearPending() {
      pendingReveal = null;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    }

    // Schedule the single reveal for a just-focused field: synchronous
    // when the keyboard is already up (field-to-field hop), otherwise
    // deferred to the settled pin, with a fallback timer for platforms
    // that fire no visualViewport events (resize-mode Android hops,
    // hardware keyboards).
    function scheduleReveal(field) {
      clearPending();
      if (kbUp()) { reveal(field); return; }
      pendingReveal = field;
      fallbackTimer = setTimeout(function () {
        fallbackTimer = null;
        var f = pendingReveal;
        pendingReveal = null;
        if (f && document.activeElement === f) reveal(f);
      }, KB_FOCUS_FALLBACK_MS);
    }

    // Coalesced settled pin: runs once, ~120ms after the last viewport
    // event of the open/close burst — never per event.
    function settledPin() {
      settleTimer = null;
      // iOS can pan the visual viewport before the inset publishes —
      // reset the page frame, but only in an actual fixed shell (never
      // yank a normally-scrolling page that attached an inner pane).
      if ((window.scrollY || window.pageYOffset || 0) > 0) {
        var fixedShell = false;
        try {
          fixedShell =
            getComputedStyle(document.documentElement).overflowY === 'hidden' ||
            getComputedStyle(document.body).overflowY === 'hidden';
        } catch (e) { /* ignore */ }
        if (fixedShell) window.scrollTo(0, 0);
      }
      var f = pendingReveal;
      clearPending();
      if (f && document.activeElement === f) { reveal(f); return; }
      // Re-pin the focused field on any settle: late inset growth (e.g.
      // the iOS QuickType bar appearing) re-adjusts without a new focus.
      var active = matchField(document.activeElement);
      if (active && document.activeElement === active && scrollEl.contains(active)) reveal(active);
    }

    function onVvEvent() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settledPin, KB_SETTLE_MS);
    }

    function onTouchStart(e) {
      touch = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false }
        : null;
    }

    function onTouchMove(e) {
      if (!touch || touch.moved) return;
      if (e.touches.length !== 1) { touch.moved = true; return; }
      var dx = e.touches[0].clientX - touch.x;
      var dy = e.touches[0].clientY - touch.y;
      if (Math.abs(dx) > KB_TAP_SLOP || Math.abs(dy) > KB_TAP_SLOP) touch.moved = true;
    }

    function onTouchCancel() {
      touch = null;
    }

    // The clean single-motion fix: the browser's reveal-on-focus can't be
    // coordinated with, only eliminated. Registered non-passive for
    // exactly this preventDefault.
    function onTouchEnd(e) {
      var t = touch;
      touch = null;
      if (!t || t.moved || !e.cancelable) return;
      if (e.touches && e.touches.length) return; // fingers still down
      if (gestures.owner('touch') != null) return; // a recognizer owns this finger
      var field = matchField(e.target);
      if (!field) return; // non-field taps stay fully native
      if (document.activeElement === field) return; // native caret/selection
      e.preventDefault(); // kills click + native focus + native reveal
      suppressFocusin = field;
      try { field.focus({ preventScroll: true }); } catch (err) {
        try { field.focus(); } catch (err2) { /* ignore */ }
      }
      suppressFocusin = null;
      if (scrollEl.contains(field)) { scheduleReveal(field); return; }
      // The composer: its column already places it on the keys. The tap's
      // own caret placement went with the default, so a draft is picked up
      // where it ends.
      try {
        if (typeof field.setSelectionRange === 'function' && typeof field.value === 'string') {
          field.setSelectionRange(field.value.length, field.value.length);
        }
      } catch (err3) { /* an input type without a selection */ }
    }

    // Non-tap focuses (programmatic .focus(), Tab / next-button hops):
    // field-to-field hops fire NO visualViewport events, so with the
    // keyboard already up this is the only reveal signal. Apps should
    // focus with { preventScroll: true } so this stays the single motion.
    function onFocusIn(e) {
      if (e.target === suppressFocusin) return; // interception path owns it
      if (!kbUp()) return; // cold focuses wait for the settled pin
      var field = matchField(e.target);
      if (field && scrollEl.contains(field)) reveal(field);
    }

    // One set of touch listeners: on the column when there is one (a tap
    // in the scroller bubbles to it), else on the scroller.
    var host = column || scrollEl;
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: true });
    host.addEventListener('touchend', onTouchEnd, { passive: false });
    host.addEventListener('touchcancel', onTouchCancel, { passive: true });
    scrollEl.addEventListener('focusin', onFocusIn);
    vv.addEventListener('resize', onVvEvent, { passive: true });
    vv.addEventListener('scroll', onVvEvent, { passive: true });

    return {
      detach: function () {
        host.removeEventListener('touchstart', onTouchStart);
        host.removeEventListener('touchmove', onTouchMove);
        host.removeEventListener('touchend', onTouchEnd);
        host.removeEventListener('touchcancel', onTouchCancel);
        scrollEl.removeEventListener('focusin', onFocusIn);
        vv.removeEventListener('resize', onVvEvent);
        vv.removeEventListener('scroll', onVvEvent);
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        clearPending();
        touch = null;
        scrollEl.classList.remove('un-kb-avoid');
        if (rides) {
          if (rideObserver) rideObserver.disconnect();
          column.removeEventListener('focusin', onKeysMove);
          column.removeEventListener('focusout', onKeysMove);
          if (rideAnim) { var anim = rideAnim; rideAnim = null; anim.onfinish = anim.oncancel = null; try { anim.cancel(); } catch (e) { /* ignore */ } }
          column.style.transition = priorTransition;
        }
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Spring tuner (?un-tune=1) — device-tuning aid for the demo page.
   * Mutates unNative.presets live; springs read presets at start time.
   * ──────────────────────────────────────────────────────────────────── */

  function maybeMountTuner() {
    var enabled = false;
    try {
      enabled = new URLSearchParams(window.location.search).get('un-tune') === '1';
    } catch (e) { /* ignore */ }
    if (!enabled) return;
    var panel = document.createElement('div');
    panel.className = 'un-tuner';
    Object.keys(PRESETS).forEach(function (name) {
      ['tension', 'friction'].forEach(function (key) {
        var row = document.createElement('label');
        var span = document.createElement('span');
        var input = document.createElement('input');
        input.type = 'range';
        input.min = key === 'tension' ? 40 : 5;
        input.max = key === 'tension' ? 500 : 60;
        input.value = PRESETS[name][key];
        function label() { span.textContent = name + '.' + key + ' = ' + PRESETS[name][key]; }
        input.addEventListener('input', function () {
          PRESETS[name][key] = Number(input.value);
          label();
        });
        label();
        row.appendChild(span);
        row.appendChild(input);
        panel.appendChild(row);
      });
    });
    // Commit-decision projection horizon (ms) — read at release time.
    (function () {
      var row = document.createElement('label');
      var span = document.createElement('span');
      var input = document.createElement('input');
      input.type = 'range';
      input.min = 40;
      input.max = 400;
      input.value = physics.COMMIT_HORIZON_MS;
      function label() { span.textContent = 'commit.horizonMs = ' + physics.COMMIT_HORIZON_MS; }
      input.addEventListener('input', function () {
        physics.COMMIT_HORIZON_MS = Number(input.value);
        label();
      });
      label();
      row.appendChild(span);
      row.appendChild(input);
      panel.appendChild(row);
    })();
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeMountTuner);
  } else {
    maybeMountTuner();
  }

  /* ──────────────────────────────────────────────────────────────────── */

  global.unNative = {
    version: 1,
    platform: platform,
    presets: PRESETS,
    physics: physics,
    spring: spring,
    attachSwipeActions: attachSwipeActions,
    attachPullToRefresh: attachPullToRefresh,
    attachReorder: attachReorder,
    attachGridPlacement: attachGridPlacement,
    transition: transition,
    presentSheet: presentSheet,
    presentModal: presentModal,
    presentPanel: presentPanel,
    actionSheet: actionSheet,
    popover: popover,
    menu: menu,
    alert: alertDialog,
    toast: toast,
    attachNavBar: attachNavBar,
    attachKeyboardAvoidance: attachKeyboardAvoidance,
    gestures: gestures,
  };
})(typeof window !== 'undefined' ? window : globalThis);
