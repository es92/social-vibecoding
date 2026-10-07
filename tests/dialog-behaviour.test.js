// What the nine dialogs DO, now that they own it (#1078 chunk I).
//
// tests/dialog-components.test.js pins the shape of the seam — who renders
// which root, what may and may not appear on it. This file pins the
// behaviour that moved off app.js / app-view.js / app-secrets.js and into the
// islands: each dialog's open, submit and dismiss path, and the two pieces of
// shared machinery they all run through (frontend/src/lib/static-modal.ts and
// features/dialogs/use-dialog.ts).
//
// #1120 slice 3 split the lift itself out of static-modal.ts into
// frontend/src/lib/kit-surface.ts, which the dev console, the hamburger drawer
// and the work drawer now share. The contracts below did not change; the ones
// about the MECHANICS of the lift (the adopted class, the placeholder, the
// rollback) are read from that module, and the ones about what is specific to
// the dialogs (which node is taken, what gate it runs on, the order the open
// branch does things in) stay read from static-modal.ts.
//
// These are source-level assertions on stable tokens, like every other UI test
// in this suite: `npm test` runs with no frontend/node_modules — the root
// install never touches that workspace — so there is no React here to render
// with and no DOM to render into. The runtime half of the verification is the
// dapp.json tests plus the browser pass this chunk's commit describes; what
// source assertions are actually good at is catching a behaviour that silently
// went missing in the move, which is the failure mode of a 3,000-line
// relocation.
//
// Run with: node --test tests/dialog-behaviour.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dialog = (f) => read(`frontend/src/features/dialogs/${f}`);

const STATIC_MODAL = read('frontend/src/lib/static-modal.ts');
const KIT_SURFACE = read('frontend/src/lib/kit-surface.ts');
const USE_DIALOG = dialog('use-dialog.ts');
const APP = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');

// ── the seam: static-modal.ts, over the lift in kit-surface.ts ───────────

test('the lift reproduces what adoptStaticModal did, in the same order', () => {
  // Open: stamp the gesture guard, reveal, THEN present. The stamp has to
  // precede the reveal because the guard window is measured from it, and the
  // reveal has to precede the present because the kit measures the card's
  // computed max-width to size its shell — a hidden card measures zero.
  const branch = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('if (open) {'),
    STATIC_MODAL.indexOf('} else {', STATIC_MODAL.indexOf('if (open) {')),
  );
  assert.ok(branch, 'the open branch of the layout effect should be findable');
  const stamp = branch.indexOf('dataset.openedAt');
  const reveal = branch.indexOf("classList.remove('hidden')");
  const lift = branch.indexOf('present(root');
  assert.ok(stamp >= 0 && reveal >= 0 && lift >= 0, `open branch is missing a step: ${branch}`);
  assert.ok(stamp < reveal, 'the opening gesture is stamped before the reveal — the guard window runs from it');
  assert.ok(reveal < lift, 'the root is revealed before the card is handed to the kit');
  // What the dialogs ask the shared lift for. `adoptedOn` is the whole reason
  // the dialogs are the odd one out: the kit takes the CARD, but the class
  // belongs on the ROOT, which is what app.css keys the legacy scrim off.
  const call = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('adoptKitSurface({'),
    STATIC_MODAL.indexOf('});', STATIC_MODAL.indexOf('adoptKitSurface({')),
  );
  assert.match(call, /kind: 'modal'/);
  assert.match(call, /contentEl: card/, 'the kit takes the card, not the whole root');
  assert.match(call, /adoptedOn: root/, 'platform-modal-adopted goes on the root');
  assert.match(call, /hugDesignWidth: true/,
    'the kit shell is still sized from the card’s computed max-width');
  // The three things the old adopter wrote, all still written — by the shared
  // lift now, which is where the other three surfaces get them from too.
  assert.match(KIT_SURFACE, /`platform-\$\{options\.kind\}-adopted`/);
  assert.match(KIT_SURFACE, /classList\.add\('platform-modal-card'\)/);
  assert.match(KIT_SURFACE, /maxWidth/, 'the kit shell is still sized from the card’s computed max-width');
  // …and the max-width has to be read BEFORE platform-modal-card lands, since
  // that class is what strips it.
  assert.ok(KIT_SURFACE.indexOf('const designWidth') < KIT_SURFACE.indexOf("classList.add('platform-modal-card')"),
    'the design width must be measured before the card is neutralized');
});

test('the lift is reversible: the card goes home before the root re-hides', () => {
  // adoptStaticModal left a comment placeholder where the card had been and
  // put it back on dismiss. React's reconciler assumes the children it
  // rendered are still where it left them, so a lift that did not restore
  // would break the NEXT render of the dialog, not this one.
  assert.match(STATIC_MODAL, /home: 'placeholder'/,
    "the card goes back to its own backdrop, not to <body> like the drawers' panels");
  // The lift/restore pair itself is createPlaceholderHome since #1191 slice 6
  // conversion 8, which gave #settings-footer's move the same seam. Same two
  // operations, one implementation — adoptKitSurface's `home: 'placeholder'`
  // branch is now a caller of it.
  assert.match(KIT_SURFACE, /createComment\(label\)/, 'a placeholder marks where the card belongs');
  assert.match(KIT_SURFACE, /replaceChild\(el, placeholder\)/,
    'restore puts the card back at its original position');
  assert.match(KIT_SURFACE, /home = createPlaceholderHome\(contentEl, `platform-\$\{options\.kind\}-home`\)/,
    'and the dialogs still get theirs from the kind, so the comment names the surface');
  assert.match(KIT_SURFACE, /flagEl\.classList\.remove\(adoptedClass\)/);
  // The restore has to be idempotent, because both the close path and the
  // kit's own onDismiss run it — and it must be reachable without telling the
  // kit anything, which is what separates it from dismiss().
  assert.match(KIT_SURFACE, /if \(undone\) return;/);
  assert.match(KIT_SURFACE, /restore: undo/);
  // On UNMOUNT the card comes home before the kit is told, because there is no
  // longer a component to animate an exit for and React is about to remove the
  // subtree the placeholder sits in. An ordinary close does the opposite now —
  // see 'the card rides the kit exit' below, which is the close flicker fix.
  const unmount = STATIC_MODAL.slice(STATIC_MODAL.indexOf('() => () => {'));
  assert.match(unmount, /adoption\.restore\(\);\n\s*adoption\.dismiss\(\);/,
    'an unmount re-homes the card synchronously, exit animation or not');
});

test('the guard window is the one app-view.js used, and is read by useDialog', () => {
  // AppView.revealModal stamped and AppView.modalDismissGuarded checked; both
  // still exist for the surfaces that are not dialogs (settings, the compare
  // overlay), so the constant must not drift between the two copies.
  assert.match(STATIC_MODAL, /MODAL_GESTURE_GUARD_MS = 450/);
  assert.match(APP_VIEW, /MODAL_GESTURE_GUARD_MS: 450/,
    'app-view.js still owns the guard for the non-dialog modals — keep the two in step');
  assert.match(USE_DIALOG, /if \(isDismissGuarded\(rootRef\.current\)\) return;/);
});

test('an external `hidden` write is reported to React, not acted on', () => {
  // "It reports, React decides": the observer exists because a public/js/**
  // straggler could still toggle the class. If the observer closed the dialog
  // itself, the hook's own writes would feed back into it.
  assert.match(STATIC_MODAL, /MutationObserver/);
  assert.match(STATIC_MODAL, /attributeFilter: \['class'\]/);
  assert.match(STATIC_MODAL, /nowOpen !== open/, 'only a DISAGREEMENT with React state is reported');
  assert.match(USE_DIALOG, /onExternalToggle: \(nowOpen\) => setIsOpen\(nowOpen\)/);
});

test('presentation is gated on kit presence, never on isTouch()', () => {
  // The retired adopter ran adoptAll() whenever a kit was present, desktop
  // included. Routing on isTouch() here would silently restyle every dialog on
  // desktop, which "zero visual change" forbids.
  assert.match(STATIC_MODAL, /gate: 'kit'/);
  // The header explains the decision at length, so check the CODE lines only.
  const code = STATIC_MODAL.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!code.some((l) => l.includes('isTouch')),
    'static-modal.ts must not branch on isTouch() — see the header');
  assert.ok(!code.some((l) => l.includes("gate: 'touch'")),
    "static-modal.ts must not take the drawers' touch gate — see the header");
  // And that is what `gate: 'kit'` means in the shared lift: kit presence,
  // desktop included. The touch gate is the OTHER branch.
  const gate = KIT_SURFACE.slice(
    KIT_SURFACE.indexOf("if (options.gate === 'kit')"),
    KIT_SURFACE.indexOf('const presentFn'),
  );
  assert.match(gate, /ui\.hasKit\(\)/);
  assert.match(gate, /ui\.isTouch\(\)/);
});

// ── the shared lifecycle: use-dialog.ts ──────────────────────────────────

test('open/close run the island’s populate and reset halves', () => {
  assert.match(USE_DIALOG, /if \(isOpen\) opts\.current\.onOpen\?\.\(payloadRef\.current\);/);
  // The reset half moved OUT of this effect and onto the exit.
  //
  // It used to be the `else` of the same layout effect, which was invisible
  // only because the card was yanked out of sight on that same tick. The card
  // rides the kit's exit animation now, so emptying it there would blank the
  // dialog's contents in front of the viewer mid-close — the same flicker,
  // moved. It runs from onExited instead: after the animation, once the
  // surface is actually gone.
  assert.doesNotMatch(USE_DIALOG, /else opts\.current\.onClose\?\.\(\);/,
    'the reset is no longer the close tick’s');
  assert.match(USE_DIALOG, /onExited: \(\) => \{[\s\S]*?opts\.current\.onClose\?\.\(\);/,
    'it runs once the exit animation has finished');
  // Two ways a pending exit's teardown must NOT run: the dialog is open again
  // (a reopen inside the exit window already repopulated it), or the close was
  // a suspend()'s bookkeeping and the draft is coming back.
  assert.match(USE_DIALOG, /if \(openRef\.current\) return;/);
  assert.match(USE_DIALOG, /if \(suspended\.current\) return;/);
  // Not on mount: the prerendered document is already hidden, so a mount-time
  // onClose would reset fields the user could not have filled yet — and, for
  // the controller-backed dialogs, would call into a module that has not run
  // its init() yet.
  assert.match(USE_DIALOG, /if \(!mounted\.current\)/);
  // Layout, so populate lands in the same frame as the reveal.
  assert.match(USE_DIALOG, /useIsomorphicLayoutEffect\(\(\) => \{\n\s*if \(!mounted\.current\)/);
});

test('the MOUNT pass is not an exit', () => {
  // This shipped broken to a staging preview and failed 435 of 459 checks with
  // "1 console error on load" on essentially every route, so it is pinned hard.
  //
  // `open` starts false, so the layout effect runs its CLOSE branch once on
  // mount, for a dialog that has never been on screen. Firing onExited there
  // ran the dialogs' teardown — Feedback._reset() and friends — against
  // controller modules whose init() had not run yet, and the resulting
  // TypeError came from the dialogs island, which every route mounts.
  //
  // The old arrangement was immune BY ACCIDENT: the teardown sat behind
  // use-dialog's own mount guard. Moving it onto the exit (so the card could
  // stay visible through the animation) moved it out from behind that guard,
  // and nothing in the local suite renders React, so only the declared checks
  // saw it.
  assert.match(STATIC_MODAL, /const everOpenRef = useRef\(false\)/,
    'the hook tracks whether it has ever presented');
  assert.match(STATIC_MODAL, /everOpenRef\.current = true;/,
    'set when it opens');
  // The no-kit exit lives in the `else if`, so the gate cannot be skipped by
  // rearranging the branch: read that branch and assert the call is inside it.
  const gated = STATIC_MODAL.slice(STATIC_MODAL.indexOf('} else if (everOpenRef.current) {'));
  assert.ok(gated.startsWith('} else if (everOpenRef.current) {'),
    'the no-kit exit branch is gated on having been open');
  assert.match(gated.slice(0, 500), /opts\.current\.onExited\?\.\(\);/,
    'and that is where onExited is called from on the no-kit path');
  // The kit path needs no gate: it only fires from the dismissal callback of
  // an adoption, and an adoption only exists once the surface was presented.
  const dismissFromKitAt = STATIC_MODAL.indexOf('const dismissFromKit');
  const dismissFromKit = STATIC_MODAL.slice(
    dismissFromKitAt,
    // Searched FROM the callback, not from the top: the first
    // `useIsomorphicLayoutEffect` in this file is its own import.
    STATIC_MODAL.indexOf('useIsomorphicLayoutEffect(', dismissFromKitAt),
  );
  assert.ok(dismissFromKit.length > 0, 'the kit dismissal callback is findable');
  assert.match(dismissFromKit, /opts\.current\.onExited\?\.\(\);/);
});

test('the card rides the kit exit rather than being pulled out before it', () => {
  // The close flicker: restore() before dismiss() put the card back in its
  // (immediately hidden) root and left the kit animating an empty shell —
  // which is not nothing on screen, it is the shell collapsed to its own
  // padding, a small blank rounded box fading out where the dialog was.
  const closeBranch = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('} else {'),
    STATIC_MODAL.indexOf('// Legacy-compatibility bridge'),
  );
  assert.match(closeBranch, /pendingExitRef\.current = adoption;\s*\n\s*adoption\.dismiss\(\);/,
    'the close asks the kit to animate and holds the adoption');
  assert.doesNotMatch(closeBranch, /adoption\.restore\(\);/,
    'and does not re-home the card before that animation runs');
  // The re-home happens in the kit's own callback, at the end of the exit.
  assert.match(STATIC_MODAL, /if \(adoption\) adoption\.restore\(\);\s*\n\s*opts\.current\.onExited\?\.\(\);/);
});

test('the exit lets go of the keyboard instead of waiting for the card to die', () => {
  // THE SECOND HALF OF THE CLOSE FLICKER, and the one the exit-riding fix
  // above could not reach. A dialog that focuses a field on open — create-app,
  // rename, fork, close-issue — raises the on-screen keyboard, and that field
  // KEPT FOCUS for the whole exit: the kit removes its shell only after the
  // animation finishes, so the blur that finally retracts the keyboard landed
  // when the node was destroyed, i.e. after the dialog had visually gone. The
  // viewer then watched the page behind it resize for the keyboard's own
  // duration — `--un-kb-inset` unwinding `.un-modal`'s `top`, `html.un-kb`
  // releasing `.un-kb-avoid`'s padding, the scroller re-clamping. Give
  // feedback, the one dialog that does NOT autofocus, never had it.
  //
  // Blurring at the START of the exit overlaps the two motions instead.
  assert.match(KIT_SURFACE,
    /dismiss: \(\) => \{[\s\S]{0,80}releaseFocus\(contentEl, handle\.el\);[\s\S]{0,80}handle\.dismiss\(\);/,
    'the adoption releases focus before it asks the kit to animate');
  const fn = KIT_SURFACE.slice(KIT_SURFACE.indexOf('function releaseFocus('));
  assert.match(fn, /contentEl\.contains\(active\) \|\| !!shellEl\?\.contains\(active\)/,
    'the card AND the kit shell — the kit focuses its own container on present');
  assert.match(fn, /active === document\.body/,
    'nothing focused is nothing to release');
  // In kit-surface, not the dialogs' hook: sheets and panels adopt through the
  // same seam and carry composers of their own.
  assert.doesNotMatch(STATIC_MODAL, /releaseFocus/);
});

test('suspend/resume move the dialog without running the lifecycle', () => {
  // The feedback screenshot capture's round trip. If this regressed to
  // close()/open(), taking a screenshot would wipe the draft it is being
  // attached to — the bug the flag exists to prevent.
  assert.match(USE_DIALOG, /const bookkeeping = useRef\(false\)/);
  assert.match(USE_DIALOG, /const suspend = useCallback\(\(\) => \{\n\s*bookkeeping\.current = true;\n\s*suspended\.current = true;\n\s*setIsOpen\(false\);/);
  assert.match(USE_DIALOG, /const resume = useCallback\(\(\) => \{\n\s*bookkeeping\.current = true;\n\s*suspended\.current = false;\n\s*setIsOpen\(true\);/);
  // A SECOND flag, and it has to be a second one.
  //
  // `bookkeeping` is consumed by the one layout-effect pass the setIsOpen
  // schedules, which was the whole of the story while the teardown ran on that
  // same tick. The teardown waits for the kit's exit animation now, and a
  // capture round trip outlasts it comfortably — so by the time the exit lands,
  // `bookkeeping` is long since spent and the close would look ordinary. This
  // one is held until resume() (or an ordinary open()) clears it.
  assert.match(USE_DIALOG, /const suspended = useRef\(false\)/);
  assert.match(USE_DIALOG, /if \(suspended\.current\) return;/,
    'a suspended close runs no teardown when its exit finally lands');
  // Consumed by exactly one effect pass, so an ordinary open or close on
  // either side of the round trip still runs its half.
  assert.match(USE_DIALOG, /if \(bookkeeping\.current\) \{\n\s*bookkeeping\.current = false;\n\s*return;\n\s*\}/);
  const feedback = dialog('feedback-controller.js');
  assert.match(feedback, /function suspendDialog\(\)/);
  assert.match(feedback, /function resumeDialog\(\)/);
  assert.ok(!/modal\.classList\.(add|remove)\('hidden'\)/.test(feedback),
    'the screenshot path must not write `hidden` on the root itself any more');
});

test('a late kit dismissal cannot tear down a newer presentation (#1284)', () => {
  // presentModal().dismiss() calls back when its exit animation ends —
  // transitionend, or a 300ms fallback timer. suspend()/resume() closes and
  // reopens inside that window on every mobile screenshot attempt, so the
  // OLD presentation's onDismiss arrives while the NEW one is on screen. It
  // used to run dismissFromKit, which restored the card out of the live kit
  // shell and called onKitDismiss -> close() -> Feedback._reset(): the
  // draft the screenshot was being attached to, gone.
  assert.match(STATIC_MODAL, /const generationRef = useRef\(0\)/);
  // Each presentation captures the generation it was created with...
  assert.match(STATIC_MODAL, /const generation = \(generationRef\.current \+= 1\);/);
  assert.match(STATIC_MODAL, /stillOwns,/, 'and hands the guard to the shared lift');
  assert.match(STATIC_MODAL, /const stillOwns = \(\) => generationRef\.current === generation;/);
  // ...and the REOPEN retires it, which is what makes the old callback a
  // no-op once a newer presentation is installed.
  //
  // This assertion used to look in the close branch, because the close branch
  // was where the card came out of the kit shell. It is not any more: the card
  // now rides the kit's exit animation and is re-homed by the callback at the
  // end of it (the close flicker fix), so retiring the generation at close
  // time would have made every ordinary close's callback a no-op and stranded
  // the card in a torn-down shell. The reopen is the event that actually means
  // "a newer presentation owns this node", so that is where the bump belongs —
  // and the scenario below is unchanged, because a reopen is exactly what
  // suspend()/resume() does inside the exit window.
  const openBranch = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('if (open) {'),
    STATIC_MODAL.indexOf('} else {'),
  );
  assert.match(openBranch, /const generation = \(generationRef\.current \+= 1\);/,
    'the generation is retired by the reopen that supersedes it');
  // And the superseded exit is completed rather than abandoned, so its
  // placeholder cannot be stranded in the root by the new lift.
  assert.match(openBranch, /pendingExitRef\.current = null;\s*\n\s*pending\.restore\(\);/,
    'a reopen finishes the outgoing presentation before presenting over it');
  // adoptKitSurface checks it after onDismissStart and before undo(), so a
  // stale teardown leaves the DOM completely alone — the hamburger drawer's
  // guard from #977, now the dialogs' too.
  assert.match(KIT_SURFACE, /if \(options\.stillOwns && !options\.stillOwns\(\)\) return;/);
});

test('canClose can veto a dismiss, and import-pr uses it', () => {
  assert.match(USE_DIALOG, /if \(opts\.current\.canClose && !opts\.current\.canClose\(\)\) return;/);
  assert.match(dialog('import-pr.tsx'), /canClose: \(\) => !busyRef\.current/);
});

test('the backdrop dismiss rule matches the handlers it replaced', () => {
  // Every bindEvents handler spelled out the same three conditions: the click
  // must be on the root or on [data-modal-backdrop], and must not land inside
  // the opening gesture's ghost-click window.
  assert.match(USE_DIALOG, /target === event\.currentTarget \|\|\s*target\.dataset\?\.modalBackdrop !== undefined/);
  assert.match(USE_DIALOG, /if \(!isBackdrop\) return;/);
});

test('the controller is published by name and withdrawn on unmount', () => {
  assert.match(USE_DIALOG, /dialogs\[name\] = controller/);
  assert.match(USE_DIALOG, /if \(dialogs\[name\] === controller\) delete dialogs\[name\]/);
  // isOpen() reads the DOM rather than the state, because its callers are
  // legacy modules that ask mid-gesture.
  assert.match(USE_DIALOG, /isOpen: \(\) => !!rootRef\.current && !rootRef\.current\.classList\.contains\('hidden'\)/);
});

// ── each dialog's own behaviour ──────────────────────────────────────────

test('create: mode, import check and POST /api/apps all moved', () => {
  const src = dialog('create-app.tsx');
  // Every answer starts empty since the rework; close puts the start
  // answer back to none, and a new answer there starts the check over.
  assert.match(src, /applyMode\(null\)/);
  assert.match(src, /\/api\/github\/verify-access\?url=/, 'the import URL check moved with it');
  // The POST itself is shared with the make screen since Create opens it
  // (post-create-app.ts); the dialog sends through it.
  assert.match(src, /await postCreateApp\(body\)/, 'the create POST moved with it');
  assert.match(dialog('post-create-app.ts'), /fetch\('\/api\/apps', \{/);
  // A successful create/import no longer closes the dialog. #1418 covered
  // the async build with a toast over a CLOSED dialog, because the tile's
  // small "Spinning up…" was easy to miss; the dialog now stays open and
  // reports the phases app-creator broadcasts (features/dialogs/
  // create-progress.tsx, tests/create-progress-view.test.js). The toast
  // survives only on the path that has nothing to report on — a 201 with
  // no slug to follow.
  assert.match(src, /watchCreation\(slug\)/, 'the success path starts following the build');
  assert.match(src, /setCreated\(\{ slug/, 'and swaps the card to the progress view');
  assert.match(src, /if \(!slug\) \{/, 'a 201 we cannot follow falls back to the old close+toast');
  assert.match(src, /window\.PlatformUI\?\.toast\?\.\(/, 'that fallback still raises the toast');
  assert.match(src, /being imported/, 'import mode gets the imported wording');
  assert.match(src, /being created/, 'new mode gets the created wording');
  // The progress subtree must never reach the prerendered document — its
  // ids are not in tests/baselines/shell-markup.json and its markup is
  // not in dapp.json's declared selectors. `created` starting null
  // is what guarantees that.
  assert.match(src, /useState<\{ slug: string; name: string \} \| null>\(null\)/,
    'the progress view is gated on state that starts null');
  // #3683: the progress card's button closes the dialog AND navigates, so the
  // close is a navigating one: a plain close queues a history.back() that
  // lands after the new address and undoes it (tests/dialog-suspend-exit.test.js
  // runs the hook). Both destinations, the bot's DM and the Workshop.
  assert.match(src, /dialog\.closeForNavigation\(\);\s*openMessages\(chat\);/,
    'opening the Homeroom bot DM does not spend the record under its own address');
  assert.match(src, /dialog\.closeForNavigation\(\);\s*\(window\.App\?\.navigateToApp/,
    'nor does opening the new project');
  assert.doesNotMatch(src, /dialog\.close\(\);\s*(?:openMessages|\(window\.App\?\.navigateToApp)/);
  // "Set secrets" too: the secrets dialog pushes its own back-button record
  // as it opens, and a plain close's queued back() would land on that record
  // and close it again. (tests/dialog-suspend-exit.test.js runs the fork
  // dialog's twin of this card.)
  const setSecrets = src.slice(src.indexOf('onSetSecrets={() => {'), src.indexOf('onRetry={() => {'));
  assert.match(setSecrets, /dialog\.closeForNavigation\(\);[\s\S]*window\.Secrets\?\.open/,
    'opening the secrets dialog does not spend the record under its own');
  assert.doesNotMatch(setSecrets, /dialog\.close\(\);/);
  // Close resets the form, so a half-finished import is never inherited.
  assert.match(src, /formRef\.current\?\.reset\(\)/);
  // The home screen's "+" still opens it by name.
  // Through App.showCreateOptions, the make screen's More options, with its draft.
  assert.match(APP, /window\.UsernodeReact\?\.dialogs\?\.create\?\.open\(draft\)/);
});

test('rename: prefills the current name and PUTs to /rename', () => {
  const src = dialog('rename-app.tsx');
  assert.match(src, /window\.AppView\?\.appData\?\.name/);
  assert.match(src, /\/rename`/);
  assert.match(src, /inputRef\.current\?\.select\(\)/, 'the prefilled name is selected, as promptRename did');
  // AppView.applyRename stays put: it is the websocket handler's, not the
  // dialog's.
  assert.match(APP_VIEW, /applyRename/);
});

test('fork: takes its source from the open payload, POSTs to /fork', () => {
  const src = dialog('fork-app.tsx');
  assert.match(src, /useDialog<ForkSource>\('fork'/);
  assert.match(src, /\(remix\)`/, 'the "<name> (remix)" default is suggested');
  assert.match(src, /\/fork`/);
  // #1549: the 201 only starts the asynchronous copy. Keep the dialog open
  // on the same progress report as create/import so a real failure reason is
  // visible and a successful fork can be opened directly.
  assert.match(src, /watchCreation\(slug\)/, 'the fork starts following its own slug');
  assert.match(src, /setForked\(\{ slug/, 'the form swaps to the progress view');
  assert.match(src, /mode="fork"/, 'the shared view uses fork-specific wording');
  assert.match(src, /fetchCreationProgress\(creatingSlug/, 'a dropped websocket is recovered by polling');
  assert.match(src, /if \(!slug\) \{/, 'only a malformed 201 falls back to close+toast');
  // _forkSource was a field on AppView; the payload replaces it. (The name
  // survives in app-view.js only in the comment that records the move.)
  assert.ok(!/^\s*_forkSource:/m.test(APP_VIEW),
    'AppView._forkSource should be gone — the open payload carries the source now');
  assert.ok(!/AppView\._forkSource\s*=/.test(APP_VIEW));
});

test('close-issue: takes the issue number as payload and POSTs a close', () => {
  const src = dialog('close-issue.tsx');
  assert.match(src, /useDialog<number \| string>\('closeIssue'/);
  assert.match(src, /\/issues`/);
  assert.match(src, /reasonRef\.current\.value = ''/, 'the reason field is cleared on both open and close');
});

test('import-pr: loads candidates on open, imports the selected one', () => {
  const src = dialog('import-pr.tsx');
  assert.match(src, /\/pr-import\/candidates`/);
  assert.match(src, /\/pr-import`/);
  assert.match(src, /void loadCandidates\(\)/, 'candidates load on open, not at mount');
  // The list only exists while open, which is what keeps a controlled radio
  // out of the prerendered document.
  assert.match(src, /!dialog\.isOpen \? null/);
});

test('share: fills the URL through resolveDevHost and flashes the copy button', () => {
  const src = dialog('share.tsx');
  assert.match(src, /window\.resolveDevHost/);
  assert.match(src, /navigator\.clipboard\?\.writeText/);
  assert.match(src, /document\.execCommand\('copy'\)/, 'the non-clipboard fallback moved too');
  assert.match(src, /setCopyLabel\('Copied!'\)|setCopyLabel\(ok \? 'Copied!'/);
});

test('members: the island owns the lifecycle, the controller owns the card', () => {
  const src = dialog('members.tsx');
  const ctl = dialog('members-controller.js');
  assert.match(src, /onOpen: \(\) => \{ void Members\._load\(\); \}/);
  assert.match(src, /onClose: \(\) => Members\._reset\(\)/);
  // The controller's open/close became forwards to the island, so every
  // AppView call site reaches the same lifecycle.
  assert.match(ctl, /function dialogController\(\)/);
  assert.match(ctl, /AppView\.openMembersModal = \(\) => \{[\s\S]*island\.open\(\)/);
  // The prerender pass evaluates this module in Node, so every window touch is
  // guarded and the publication happens from init(), not at import time.
  assert.match(ctl, /export function init\(\) \{\n\s*if \(typeof window === 'undefined'\) return;/);
});

test('feedback: the island owns the lifecycle, the controller keeps its logic', () => {
  const src = dialog('feedback.tsx');
  const ctl = dialog('feedback-controller.js');
  assert.match(src, /onOpen: \(opts\) => Feedback\._open\(opts \|\| \{\}\)/);
  assert.match(src, /onClose: \(\) => Feedback\._reset\(\)/);
  assert.match(src, /initFeedback\(\)/);
  // The pieces with issue numbers on them, still present after the move.
  assert.match(ctl, /App\.openFeedbackModal = /, 'the legacy entry point is re-published from the controller');
  assert.match(ctl, /import '\.\/screenshot-select'/);
  assert.ok(!/document\.addEventListener\('DOMContentLoaded'/.test(ctl),
    'the bootstrap became the island’s init() call');
  // app.js keeps only the forward; the 800-line block is gone from bindEvents.
  assert.ok(!/feedback-submit/.test(APP), 'the feedback block should be out of app.js');
});

test('app-secrets: open/close forward to the island, load/reset stay in the controller', () => {
  const src = dialog('app-secrets.tsx');
  const ctl = dialog('app-secrets-controller.js');
  assert.match(src, /onOpen: \(payload\) => \{[\s\S]*Secrets\._load\(payload\.slug/);
  assert.match(src, /onClose: \(\) => Secrets\._reset\(\)/);
  assert.match(src, /initSecrets\(\)/);
  assert.match(ctl, /async open\(slug, opts = \{\}\) \{[\s\S]*island\.open\(\{ slug, opts \}\)/);
  assert.match(ctl, /close\(\) \{[\s\S]*island\.close\(\)/);
  // Callers that arrive before hydration still get the data half — AppView
  // .close() calls Secrets.hide() on every app teardown.
  assert.match(ctl, /if \(!island\) return Secrets\._load\(slug, opts\)/);
  assert.match(ctl, /if \(!island\) return Secrets\._reset\(\)/);
  assert.match(ctl, /window\.Secrets = Secrets/);
});

test('the legacy entry points still exist, as forwards', () => {
  // The whole point of keeping these names: nothing else in public/js/** had
  // to change. If a forward disappears, the caller silently no-ops.
  for (const name of ['promptRename', 'promptFork', 'promptCloseIssue', 'openImportPrModal', 'openShareModal']) {
    assert.ok(APP_VIEW.includes(`${name}`), `AppView.${name} should survive as a forward`);
  }
  assert.match(APP, /showCreateModal/);
});
