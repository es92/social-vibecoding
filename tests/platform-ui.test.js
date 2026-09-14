// PlatformUI (public/js/platform-ui.js) — the platform frontend's single
// seam over the hosted usernode-native kit. These tests pin two contracts:
//
//  1. Degraded fallback: with NO kit loaded (window.unNative absent) the
//     wrapper must fall back to console + native dialogs and inert
//     handles — never throw. This is what keeps the platform usable if
//     the kit script fails to load.
//  2. Kit delegation: with a stubbed kit present, calls route through
//     unNative and confirm/prompt map the kit's { button, value } shape
//     onto boolean / string-or-null.
//
// Plus the include-regression tests: index.html must keep referencing
// /usernode-native/v1/ and the settings toggles must keep un-switch.
//
// Run with: node --test tests/platform-ui.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { shellMarkup } = require('./lib/shell-markup');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'platform-ui.js'), 'utf8'
);

function makeSandbox({ kit } = {}) {
  const calls = { alerts: [], confirms: [], prompts: [], logs: [] };
  const sandbox = {
    console: { ...console, log: (...a) => calls.logs.push(a.map(String).join(' ')) },
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: () => {},
      createComment: () => ({}),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class {},
    alert: (msg) => calls.alerts.push(msg),
    confirm: (msg) => { calls.confirms.push(msg); return true; },
    prompt: (msg, val) => { calls.prompts.push([msg, val]); return 'typed'; },
  };
  if (kit) sandbox.unNative = kit;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { PlatformUI: sandbox.PlatformUI, calls, sandbox };
}

// ── 1. Kit-absent fallback ─────────────────────────────────────────────

test('pull-to-refresh reads the active page offset after its scroller changes', () => {
  let options;
  const { kit } = stubKit();
  kit.attachPullToRefresh = (el, refresh, opts) => { options = opts; return { detach() {} }; };
  const { PlatformUI, sandbox } = makeSandbox({ kit });
  const screen = { scrollTop: 0 };
  PlatformUI.pullToRefresh(screen, async () => {});
  assert.equal(options.getScrollTop(), 0);
  const page = { scrollTop: 420 };
  sandbox.UsernodeBrowserScroll = { scrollElement: () => page };
  assert.equal(options.getScrollTop(), 420, 'a downward swipe mid-page must remain a scroll');
  page.scrollTop = 0;
  assert.equal(options.getScrollTop(), 0, 'refresh arms only once the page reaches the top');
});

test('kit absent: toast logs to console and returns null', () => {
  const { PlatformUI, calls } = makeSandbox();
  const handle = PlatformUI.toast('Saved');
  assert.equal(handle, null);
  assert.ok(calls.logs.some((l) => l.includes('Saved')));
});

test('kit absent: alert falls back to window.alert', async () => {
  const { PlatformUI, calls } = makeSandbox();
  await PlatformUI.alert({ title: 'Heads up', message: 'Something happened' });
  assert.equal(calls.alerts.length, 1);
  assert.ok(calls.alerts[0].includes('Heads up'));
  assert.ok(calls.alerts[0].includes('Something happened'));
});

test('kit absent: confirm falls back to window.confirm and resolves its boolean', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const ok = await PlatformUI.confirm({ title: 'Delete this app?', danger: true });
  assert.equal(ok, true);
  assert.equal(calls.confirms.length, 1);
});

test('kit absent: prompt falls back to window.prompt', async () => {
  const { PlatformUI, calls } = makeSandbox();
  const v = await PlatformUI.prompt({ title: 'Set KEY', value: 'x' });
  assert.equal(v, 'typed');
  assert.equal(calls.prompts.length, 1);
});

test('kit absent: sheets/panels/modals return null, actionSheet resolves null, gestures null', async () => {
  const { PlatformUI } = makeSandbox();
  assert.equal(PlatformUI.hasKit(), false);
  assert.equal(PlatformUI.isTouch(), false);
  assert.equal(PlatformUI.sheet({}), null);
  // Null is what makes App.HeaderMenu fall back to the legacy CSS
  // slide-over instead of opening nothing.
  assert.equal(PlatformUI.panel({}), null);
  assert.equal(PlatformUI.modal({}), null);
  assert.equal(await PlatformUI.actionSheet({ actions: [] }), null);
  assert.equal(PlatformUI.gestures(), null);
});

test('kit absent: transition still runs the mutation synchronously', () => {
  const { PlatformUI } = makeSandbox();
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'push' });
  assert.equal(ran, true);
});

test('kit absent: a zoom transition runs BOTH mutation halves (fn + after), never throws', () => {
  const { PlatformUI } = makeSandbox();
  const order = [];
  PlatformUI.transition(() => order.push('fn'), {
    type: 'zoom-in',
    el: {},
    fromEl: () => null,
    after: () => order.push('after'),
  });
  assert.deepEqual(order, ['fn', 'after']);
  // No `after` is fine too.
  let ran = false;
  assert.doesNotThrow(() => {
    PlatformUI.transition(() => { ran = true; }, { type: 'zoom-out', el: {} });
  });
  assert.equal(ran, true);
});

test('kit absent: swipeActions / pullToRefresh / attachScreenFx are inert, never throw', () => {
  const { PlatformUI } = makeSandbox();
  const s = PlatformUI.swipeActions({}, {});
  const p = PlatformUI.pullToRefresh({}, () => {});
  assert.doesNotThrow(() => { s.detach(); s.close(); p.detach(); });
  assert.doesNotThrow(() => {
    PlatformUI.attachScreenFx('k', {}, {});
    PlatformUI.detachScreenFx('k');
  });
});

// ── 2. Kit delegation ──────────────────────────────────────────────────

function stubKit() {
  const seen = {
    toasts: [], alerts: [], sheets: [], panels: [], modals: [],
    actionSheets: [], transitions: [],
  };
  const kit = {
    platform: 'ios',
    toast: (msg, opts) => { seen.toasts.push([msg, opts]); return { dismiss() {}, el: {} }; },
    alert: (opts) => {
      seen.alerts.push(opts);
      // Simulate the user tapping the LAST (non-cancel) button, typing 'v'.
      const b = (opts.buttons || [{ label: 'OK', style: 'default' }]).slice(-1)[0];
      return Promise.resolve({ button: b, value: opts.field ? 'v' : undefined });
    },
    actionSheet: (opts) => { seen.actionSheets.push(opts); return Promise.resolve(null); },
    presentSheet: (opts) => { seen.sheets.push(opts); return { dismiss() {}, el: {} }; },
    presentPanel: (opts) => { seen.panels.push(opts); return { dismiss() {}, el: {} }; },
    presentModal: (opts) => { seen.modals.push(opts); return { dismiss() {}, el: {} }; },
    transition: (fn, opts) => { seen.transitions.push(opts); fn(); },
    gestures: { claim: () => true, owner: () => null, release: () => {} },
  };
  return { kit, seen };
}

test('kit present: toast delegates to unNative.toast', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const h = PlatformUI.toast('Copied');
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.toasts.length, 1);
  assert.equal(seen.toasts[0][0], 'Copied');
});

test('kit present: isTouch reflects the kit platform', () => {
  const { kit } = stubKit();
  const touch = makeSandbox({ kit });
  assert.equal(touch.PlatformUI.isTouch(), true);
  kit.platform = 'desktop';
  const desk = makeSandbox({ kit });
  assert.equal(desk.PlatformUI.isTouch(), false);
});

test('kit present: panel delegates to unNative.presentPanel, options untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const contentEl = { adopted: true };
  const onDismiss = () => {};
  const h = PlatformUI.panel({ contentEl, side: 'right', onDismiss });
  assert.ok(h && typeof h.dismiss === 'function');
  assert.equal(seen.panels.length, 1);
  // The side is what the hamburger drawer's whole change hinges on, and
  // contentEl is the adoption seam — neither may be rewritten in transit.
  assert.equal(seen.panels[0].side, 'right');
  assert.equal(seen.panels[0].contentEl, contentEl);
  assert.equal(seen.panels[0].onDismiss, onDismiss);
  // A kit that predates presentPanel degrades to the legacy path.
  delete kit.presentPanel;
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(P2.panel({ contentEl }), null);
});

test('kit present: confirm maps the tapped button onto a boolean', async () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const ok = await PlatformUI.confirm({ title: 'Withdraw?', confirmLabel: 'Withdraw', danger: true });
  assert.equal(ok, true); // stub taps the last (destructive) button
  const buttons = seen.alerts[0].buttons;
  assert.equal(buttons[0].style, 'cancel');
  assert.equal(buttons[1].style, 'destructive');
  assert.equal(buttons[1].label, 'Withdraw');
});

test('kit present: confirm resolves false when the cancel button is tapped', async () => {
  const { kit } = stubKit();
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0] }); // cancel
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.confirm({ title: 'Sure?' }), false);
});

test('kit present: prompt returns the field value on OK, null on cancel', async () => {
  const { kit } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  assert.equal(await PlatformUI.prompt({ title: 'Set KEY' }), 'v');
  kit.alert = (opts) => Promise.resolve({ button: opts.buttons[0], value: 'v' });
  const { PlatformUI: P2 } = makeSandbox({ kit });
  assert.equal(await P2.prompt({ title: 'Set KEY' }), null);
});

test('kit present: transition forwards the type and runs the mutation', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  let ran = false;
  PlatformUI.transition(() => { ran = true; }, { type: 'pop' });
  assert.equal(ran, true);
  assert.deepEqual(seen.transitions[0], { type: 'pop' });
});

test('kit present: zoom opts (el, fromEl, fallback, after, outEl) forward to unNative untouched', () => {
  const { kit, seen } = stubKit();
  const { PlatformUI } = makeSandbox({ kit });
  const el = { screen: true };
  const fromEl = () => null;
  const after = () => {};
  const outEl = { outgoingScreen: true };
  const opts = { type: 'zoom-in', el, fromEl, fallback: 'push', after, outEl };
  PlatformUI.transition(() => {}, opts);
  assert.equal(seen.transitions[0], opts, 'the opts object passes through by reference');
  assert.equal(seen.transitions[0].el, el);
  assert.equal(seen.transitions[0].fromEl, fromEl);
  assert.equal(seen.transitions[0].after, after);
  assert.equal(seen.transitions[0].fallback, 'push');
  assert.equal(seen.transitions[0].outEl, outEl,
    'outEl (#764: destination measured with the outgoing screen hidden) forwards untouched');
});

// ── 3. Include regressions ─────────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('index.html loads the hosted kit (css + js) and platform-ui.js', () => {
  assert.ok(INDEX.includes('/usernode-native/v1/native.css'), 'kit stylesheet include dropped');
  assert.ok(INDEX.includes('/usernode-native/v1/native.js'), 'kit script include dropped');
  assert.ok(INDEX.includes('/js/platform-ui.js'), 'PlatformUI wrapper include dropped');
});

test('index.html viewport meta carries viewport-fit=cover (kit safe-area contract)', () => {
  const meta = INDEX.match(/<meta name="viewport"[^>]*>/)[0];
  assert.ok(meta.includes('viewport-fit=cover'), meta);
});

test('settings toggles are kit switches (un-switch)', () => {
  for (const id of ['view-as-non-admin', 'dev-console-always-show', 'devchat-alerts-toggle', 'ai-progress-estimate']) {
    const m = shellMarkup().match(new RegExp(`<input id="${id}"[^>]*>`));
    assert.ok(m, `missing settings checkbox #${id}`);
    assert.ok(m[0].includes('un-switch'), `#${id} lost its un-switch class`);
  }
});

test('header and app view carry safe-area classes', () => {
  assert.ok(/<header id="platform-header"[^>]*un-safe-top/.test(INDEX));
  // #970: the bottom inset is SURFACE-DEPENDENT now, so #app-view must NOT
  // carry a blanket `un-safe-bottom`. That class reserved the
  // home-indicator strip for every surface inside #app-content — the
  // running app's iframe included — which is what left apps cut off short
  // of a phone's rounded bottom edge. The `data-app-surface` attribute
  // (AppView._setSurface) plus the app.css rules replace it; the default
  // is `platform` so a first paint before any render is well-defined.
  //
  // The follow-up moved the inset off #app-view entirely: the surface
  // rules publish the `--platform-safe-bottom` TOKEN (real value on a
  // platform surface, 0px on an app one) and the padding itself lives on
  // each inner scroller / composer bar, so Dev mode paints edge to edge
  // like the app surface. tests/app-safe-area.test.js and
  // tests/platform-safe-bottom.test.js pin that contract; here we only
  // check the surface hook still exists for app.css to key on.
  assert.ok(!/<div id="app-view"[^>]*un-safe-bottom/.test(INDEX),
    '#app-view must not reserve the bottom inset for the app frame (#970)');
  assert.ok(/<div id="app-view"[^>]*data-app-surface="platform"/.test(INDEX),
    '#app-view needs the surface flag, defaulting to platform');
  assert.ok(
    read('public/css/app.css').includes('#app-view[data-app-surface="platform"]'),
    'app.css must carry the platform-surface rule'
  );
});

test('neither the bottom tab bar nor the header switch ships', () => {
  // Two retirements, one test. The full-width bottom #app-tabs bar went first
  // (replaced by the header's App/Dev switch); THE UI OVERHAUL then retired
  // the switch too. An app is just an app now — Dev is a destination the
  // Improve panel links to, not a mode the header toggles between.
  assert.ok(!INDEX.includes('id="app-tabs"'), 'the #app-tabs nav still ships');
  assert.ok(!INDEX.includes('class="app-tab'), 'an .app-tab button still ships');
  assert.ok(!INDEX.includes('id="app-mode-switch"'), 'the header switch still ships');
  assert.ok(!/class="[^"]*app-mode-seg/.test(INDEX), 'an orphan segment still ships');
});

test('#improve-btn lives inside the header, alone in the right group', () => {
  const header = INDEX.slice(
    INDEX.indexOf('id="platform-header"'),
    INDEX.indexOf('</header>')
  );
  // Same requirement the switch had, and for the same reason: the header
  // layout code measures the title's right side group through a ref on that
  // div, so a control moved out of it stops counting towards the clearance
  // the centering measurement needs.
  assert.ok(header.includes('id="improve-btn"'), 'Improve is outside the header');
  assert.ok(
    header.indexOf('id="improve-btn"') > header.indexOf('id="header-title"'),
    'Improve must sit after the title, in the right group'
  );
  // Streamlined Concept: the hamburger moved to the LEFT group, mirroring
  // the drawer it opens, so it now PRECEDES the title — and Improve (or the
  // eye that swaps in on the Dev screens) is the right group's one control.
  assert.ok(
    header.indexOf('id="header-menu-btn"') < header.indexOf('id="header-title"'),
    'the hamburger leads the bar, before the title'
  );
});

test('the Improve button ships hidden and opens the panel', () => {
  const m = INDEX.match(/<button id="improve-btn"[\s\S]*?<\/button>/);
  assert.ok(m, 'missing #improve-btn');
  const el = m[0];
  // Ships hidden for the same reason the switch did: there is nothing to
  // improve until a target is published. The one publisher is
  // App.DrawerStatus.setAppOpen — an open app, and nowhere else.
  assert.ok(el.includes('hidden'), 'ships hidden — a published target reveals it');
  assert.ok(el.includes('aria-haspopup="dialog"'), 'it opens a dialog surface');
  assert.ok(el.includes('aria-expanded="false"'), 'closed state reaches the a11y tree');
});

test('setAppOpen publishes the Improve target instead of toggling a switch', () => {
  // #1079 chunk B moved it into the React bundle; app.js keeps a forwarder.
  // It is ImproveStatus in the improve feature now — both of its publishers
  // are about the Improve button, not about any drawer. THE UI OVERHAUL kept
  // that lifecycle and changed only what it publishes — one call already
  // covers openApp, navigateHome, AppView.close() and every other-screen
  // navigation, which is why the header control still rides it.
  const src = read('frontend/src/features/improve/improve-status.js');
  const fn = src.slice(src.indexOf('setAppOpen(open) {'), src.indexOf('refreshDeployDot() {'));
  assert.ok(!fn.includes("getElementById('app-mode-switch')"),
    'the retired switch must not still be toggled here');
  assert.ok(fn.includes('Improve?.setTarget'), fn);
  assert.ok(fn.includes('setTarget(null)'),
    'closing an app must clear the target, or the button outlives its subject');
  // Unlike the switch it replaced, the self-hosted platform row is NOT
  // excluded: everything Improve offers works on it, opened like any other
  // app.
  assert.ok(fn.includes('self_hosted'), 'the platform row is still classified');
  assert.ok(!/self_hosted[\s\S]{0,120}classList\.toggle\('hidden'/.test(fn),
    'the platform row must no longer be hidden out of the header');
});

test('home publishes the PLATFORM Improve target, from render and not only on return', () => {
  // #1367 put an Improve button on the home screen, scoped to the platform's
  // own self-hosted row — "improve Homeroom itself".
  //
  // THE UI OVERHAUL shipped that once and reverted it, and this test pins the
  // shape of the fix rather than just the feature. The reverted version
  // re-targeted the platform row on the RETURN paths only (App._improveHome),
  // so a cold boot at `/` never published one: the button appeared after
  // backing out of an app and vanished on refresh, which read as a stale
  // leftover of the app just closed. What makes it consistent now is that the
  // publish lives in Home.render() — the call every path funnels through —
  // with navigateHome only RE-publishing so the swap is same-frame.
  const src = read('public/js/app.js');
  const home = read('frontend/src/features/home/home.js');

  // 1. The publisher is Home's, and it is called from render(). This is the
  //    property the first attempt lacked; without it the rest is cosmetic.
  assert.ok(home.includes('publishImproveTarget()'),
    'Home must own the platform target publisher');
  const renderStart = home.indexOf('  render() {');
  const render = home.slice(renderStart, home.indexOf('\n  },', renderStart));
  assert.ok(render.includes('Home.publishImproveTarget();'),
    'render() must publish the target — the one call a cold boot, a WS repaint '
    + 'and the return from an app all reach');

  // 2. It is the platform's own row, resolved from the list the viewer was
  //    actually served — never a hardcoded slug, which would both rot and
  //    leak the row's existence to non-admins the API hides it from.
  const pubStart = home.indexOf('  publishImproveTarget() {');
  const publish = home.slice(pubStart, home.indexOf('\n  },', pubStart));
  assert.ok(/self_hosted/.test(publish),
    'the target is found by the self_hosted flag on the served apps list');
  assert.ok(publish.includes("kind: 'platform'"),
    'and published as the platform kind, not as an ordinary app');
  assert.ok(!/slug:\s*['"]usernode/.test(publish),
    'never a hardcoded platform slug');

  // 3. Both gates, and what #1406 changed about the second one.
  //
  //    The first is unchanged: publishing while an app is open would overwrite
  //    that app's own target, so the header button would describe the wrong
  //    thing.
  //
  //    The second used to require HOME specifically, which is precisely why
  //    the improve button and the view selector vanished on settings, profile
  //    and messages. Those screens now call this too, so the gate asks the
  //    question that actually matters — is an app on screen — rather than
  //    naming the one screen that used to be allowed.
  assert.ok(publish.includes('currentApp'),
    'must not publish while an app is open');
  assert.ok(publish.includes("_isScreenVisible('app-view')"),
    'and not while the app view is on show — the other half of the same guard');
  assert.ok(!publish.includes("!App._isScreenVisible('home-screen')"),
    'but no longer refuses every screen that is not home');

  // 4. navigateHome still CLEARS the app's target first, then republishes
  //    home's — in that order, so nothing inherits the closed app's facts.
  const navStart = src.indexOf('navigateHome() {');
  const nav = src.slice(navStart, src.indexOf('after: () => {', navStart));
  assert.ok(/App\.ImproveStatus\.setAppOpen\(false\);[\s\S]{0,900}Home\.publishImproveTarget\(\)/.test(nav),
    'navigateHome must clear the app target before republishing home\'s');
  // The retired helper stays retired: the publish belongs to Home, and a
  // second copy in app.js is how the return-path-only bug got in.
  assert.ok(!src.includes('_improveHome'),
    'the old return-path-only helper must not come back');

  // The restoreFromHash unrecognised-hash fallback lands on home too, and a
  // lingering APP target there is the same bug in a different door. It clears
  // and then calls Home.load(), whose render() publishes home's own.
  const fallbackIdx = src.indexOf("App._showOnlyScreen('home-screen');");
  const fallback = src.slice(fallbackIdx, src.indexOf('Home.load();', fallbackIdx));
  assert.ok(fallback.includes('App.ImproveStatus.setAppOpen(false);'),
    'the hash-fallback home landing must clear the app target too');

  // 5. …AND IT DOES NOT WAIT FOR /api/apps.
  //
  // Everything above resolves the row out of that payload, which is the boot's
  // slowest request — so for as long as it took, the header's standing action
  // was simply MISSING, on home and on every other platform screen (they all
  // reach here through _enterScreenChrome). That is the "the Improve button
  // shows up a few seconds late" report: not a stale button, an absent one.
  //
  // The fix is a remembered copy, published while the payload is still on its
  // way and overwritten by the real one the moment it lands. Two properties
  // make it safe rather than merely fast, and both are asserted here: it is
  // written only from a SUCCESSFUL publish (so it can only exist in a profile
  // already served the row, and cannot leak its existence to a viewer the API
  // hides it from), and it is only READ while `_appsLoaded` is false (so once
  // the list is here, the list is the truth — including the truth that this
  // viewer gets no row).
  assert.ok(publish.includes('Home._cachedImproveTarget()'),
    'a cold boot publishes the remembered target rather than nothing');
  assert.ok(/if \(Home\._appsLoaded\) return;[\s\S]{0,200}_cachedImproveTarget/.test(publish),
    'and only while the apps payload has not arrived');
  assert.ok(publish.includes('Home._rememberImproveTarget(target)'),
    'the cache is written from the real publish, not from the cache read');
  const loadStart = home.indexOf('  async load() {');
  const load = home.slice(loadStart, home.indexOf('\n  },', loadStart));
  assert.ok(load.includes('Home.publishImproveTarget();'),
    'load() publishes before its own fetch — render() does not run until it lands');
  // Session residue, cleared with the rest of it: the next account may not be
  // served the self-hosted row at all.
  assert.ok(/_dropCachedSession\(\)[\s\S]{0,900}Home\.IMPROVE_TARGET_KEY/.test(src),
    'the remembered target is dropped with the session');
});

// ── #1367: the App/Feed/Kanban toggle, and what it replaced ──────────

test('the Improve panel leads with its two actions, shaped like the button that opens it', () => {
  const panel = read('frontend/src/features/improve/improve-panel.tsx');
  const button = read('frontend/src/features/improve/improve-button.tsx');

  // Feedback and New change, as TWO BUTTONS. They shipped as three equal
  // thirds of one recessed well with hairline dividers — Share was the third
  // — and two things undid that. Share left for the footer (it is a fact
  // ABOUT the app, so it belongs with "View on GitHub"), and a divided well
  // of two is not a group, it is a control with a seam down the middle. The
  // well also read as a SEGMENTED CONTROL, which is exactly what the view
  // strip immediately below it now is, so the panel opened with two identical
  // shapes meaning two different kinds of thing.
  assert.match(panel, /id="improve-quick-actions"/, 'the band exists');
  assert.ok(!/divide-x divide-zinc-950\/5/.test(panel),
    'and is no longer one divided well');
  // "Give feedback", not "Feedback": both segments are things you DO, and a
  // bare noun beside the verb phrase "New change" read as a category label
  // sitting next to an action.
  assert.match(panel, /id="improve-row-feedback"\n\s+label="Give feedback"/,
    'Feedback survives, verbized');
  assert.match(panel, /Improve\.giveFeedback\(\)/, 'with the same handler');
  assert.match(panel, /id="improve-row-new-session"/, 'New change survives');
  assert.match(panel, /Improve\.startSession\(\)/, 'with the same handler');

  // They are shaped like #improve-btn, the control that opens this panel: a
  // rounded-full pill.
  //
  // BOTH TAKE THE SAME FILL, and it is the SOLID one. That they match is the
  // settled part: describing a problem and starting a change are two ways
  // into the same work, so neither is the primary.
  //
  // Which shared state they match in moved. They spent a round at
  // `bg-violet-500/10` — a tenth opacity, chosen so a solid pill would not
  // sit under #improve-btn's own and compete with the button that opened the
  // panel. At that opacity they became the palest things in a panel of real
  // surfaces: the two controls the panel EXISTS for read closer to disabled
  // than to actionable. #improve-btn is in the header, outside the panel and
  // behind its backdrop once it is up, so the competition is rarely seen —
  // and these two are seen every time.
  assert.match(button, /rounded-full[\s\S]{0,80}bg-violet-600 hover:bg-violet-500/,
    'the header button is a filled violet pill');
  assert.match(panel, /rounded-full text-sm font-semibold/,
    'and the two actions are the same pill shape');
  assert.match(panel, /const ACTION_FILL =\n\s+'bg-violet-600 hover:bg-violet-500 text-white';/,
    'both wearing the platform\'s ordinary primary fill');
  assert.ok(!/ACTION_PRIMARY/.test(panel),
    'there is no primary-and-secondary pair here any more');
  assert.ok(!/\bprimary\b/.test(panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'and no call site marks one of them as the primary');

  // Share moved to the footer beside the repository link, keeping its id, its
  // canShare gate and its dialog.
  assert.match(panel, /id="improve-row-share"/, 'Share survives');
  assert.match(panel, /Improve\.share\(\)/, 'with the same handler');
  assert.ok(panel.indexOf('id="improve-row-github"') < panel.indexOf('id="improve-row-share"'),
    'and sits next to View on GitHub in the reference footer');
  assert.match(panel, /\{state\.canShare \? \(/, 'still gated on canShare');

  // Everything else left: the view toggle is the view STRIP now.
  assert.ok(!/id="improve-row-kanban"/.test(panel), 'the Kanban ROW is retired');
  assert.ok(!/id="improve-row-feed"/.test(panel), 'the Feed ROW is retired');
  assert.ok(!/ImproveViewToggle/.test(panel), 'no view-toggle copy survives');
});

test("the Board owns the view control; the header's label is the chip", () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  const frame = read('frontend/src/features/dev-board/board-frame.tsx');

  // #1443: navigation between the app's views is the chip's menu — the chip
  // is the header's label on EVERY screen, not only inside an app. Kanban vs
  // Feed is not navigation at all: it is one place drawn two ways, so it sits
  // under the Improve panel's Board row and the frame draws no view control.
  assert.ok(!/ImproveViewToggle/.test(header),
    'the header renders no view-toggle copy');
  assert.match(header, /<AppSwitcherChip titleRef=\{titleRef\} \/>/,
    "the header's label is the chip");
  assert.ok(!/id="dev-view-toggle"/.test(frame),
    'the Board draws no view tab strip above its cards');
  const frameCode = frame
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/matchMedia|innerWidth/.test(frameCode),
    'the frame must not measure the viewport');

  // The three views are a SEGMENTED CONTROL, in ../improve/view-tabs.tsx —
  // three rows with muted detail lines plus an indented Kanban|Feed pair under
  // the middle one became three equal segments, because Kanban and Feed WERE
  // Board and Activity: the same cards, one by column and one newest-first.
  //
  // THE IMPROVE PANEL IS THE ONLY SURFACE THAT DRAWS IT. The chip's menu
  // carried a second copy for two rounds of #1443 on the reasoning that
  // either surface is a fair place to ask "which part of this app". It is
  // not: that menu is the APP PICKER, so a strip about the app you are
  // already in sat between you and the list you opened it for. The way OUT
  // of a Board is the header's back arrow now, not a second copy of the way
  // in — which is why this asserts the menu renders no strip at all.
  const viewTabs = read('frontend/src/features/improve/view-tabs.tsx');
  const panel = read('frontend/src/features/improve/improve-panel.tsx');
  const menu = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(panel, /<AppViewTabs\n\s+ids=\{IMPROVE_VIEW_IDS\}/,
    'the panel renders the strip under the panel ids');
  assert.ok(!/<AppViewTabs/.test(menu),
    'the chip menu renders no view strip — it answers WHICH APP only');
  assert.ok(!/SWITCHER_VIEW_IDS/.test(viewTabs),
    'and the id map its copy needed is retired with it, so a second surface '
    + 'cannot reappear by importing a map that is still lying around');
  // The first segment still names where it GOES: the platform's reads "Home",
  // an app's reads "App". (It read the app's NAME as a row; a segment one
  // third of a 320pt panel wide cannot, and the name is already on the chip
  // directly above.)
  assert.match(viewTabs, /const appLabel = selfHosted \? 'Home' : 'App';/,
    "the platform's segment is labelled Home, an app's App");
  // The ATTRIBUTE names the segment's role, not its destination — the
  // selector contract dapp.json's checks are written against.
  assert.match(viewTabs, /data-context-row="app"/,
    'data-context-row stays "app" on both');
  const controller = read('frontend/src/features/improve/improve-controller.js');
  // #1406 widened where this segment is reachable from. It used to be true
  // that "no app open" meant "already home", because every other screen
  // cleared the target and unrendered the control — so a no-op was correct.
  // Those screens keep the control now, so the guard has to be the home screen
  // itself; left as it was, clicking Home from Settings would have done
  // nothing at all.
  assert.match(controller, /_isScreenVisible\('home-screen'\)/,
    'openApp() asks whether it is ALREADY home, not whether an app is open');
  assert.match(controller, /if \(!onHome\) window\.App\.navigateHome\(\);/,
    'and navigates home from anywhere that is not home');

  // Which HALF of the app is on screen is still published from the single
  // place App.currentTab is assigned. The header's right slot no longer reads
  // it — Improve is unconditional there now — but the session LIFECYCLE PILL
  // is gated on exactly this pair, so the publish stays load-bearing.
  const appJs = read('public/js/app.js');
  assert.match(appJs, /App\.currentTab = tab;[\s\S]{0,600}window\.Improve\?\.setTab\(tab, App\.currentSubTab\)/,
    'switchTab must publish the active tab AND sub-tab — the header status '
    + 'pill is gated on being on a session');

  // THE RIGHT SLOT IS NOT CONTEXTUAL. Improve used to swap into an eye on the
  // Dev screens and into an eye/pencil pair on a session with a preview,
  // which meant the action people reach for most both moved and, on a session
  // with no preview yet, disappeared. It renders from the target alone now.
  const improveBtn = read('frontend/src/features/improve/improve-button.tsx');
  assert.match(improveBtn, /const pill = !!target;/,
    'the word renders wherever there is something to improve');
  assert.doesNotMatch(improveBtn, /tab === 'dev'/, 'and not from the route');
  for (const gone of ['app-eye-btn', 'session-build-btn', 'EyeIcon', 'PencilSparklesIcon']) {
    assert.ok(!improveBtn.includes(gone), `the ${gone} half of the swap left the header`);
  }
  // It went to the session strip, beside the name of the change it acts on.
  const strip = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.match(strip, /id="dc-mode-switch"/, 'the strip draws the doing<->seeing switch');
  assert.match(strip, /swapToStagingForSession/,
    'and the eye there opens that preview, the one preview affordance');
  // #2069 narrowed the gate rather than removing it: a session with nothing
  // to preview still draws no switch, but "nothing to preview" no longer
  // means "no live URL" — ensure-staging can build one from the branch.
  assert.match(strip, /if \(!hasPreview\)/,
    'a session with nothing to preview draws no switch — the gate moved with it');
  assert.match(strip, /const hasPreview = !!previewUrl \|\| !!previewBuildable;/,
    'and "nothing to preview" counts a preview that could be built');
});

test('the Improve panel is navigation, work and reference — one scroller', () => {
  // Four bands: the quick actions, the app's three views, the work in flight,
  // and the reference footer that says what this app IS. The views spent one
  // round of #1443 in the chip's menu and came back; the footer came back from
  // three separate screens #1431 had scattered it across.
  const panel = read('frontend/src/features/improve/improve-panel.tsx');
  const html = read('public/index.html');

  // THE ONE SCROLLER. The quick actions and the view rows are `shrink-0`, so
  // they stay on screen at any height; the sessions list flexes and scrolls
  // inside itself. One rule, no measurement.
  const bodyAt = html.indexOf('id="improve-body"');
  const bodyTag = html.slice(bodyAt, html.indexOf('>', bodyAt));
  assert.match(bodyTag, /flex flex-col/, '#improve-body is the column flex');

  const scrollAt = html.indexOf('id="improve-sessions"');
  const scrollTag = html.slice(scrollAt, html.indexOf('>', scrollAt));
  assert.match(scrollTag, /overflow-y-auto/, 'the sessions list is the scroller');
  assert.match(scrollTag, /flex-1/, 'and takes the free space');
  assert.match(scrollTag, /min-h-0/, 'and may shrink below its content');

  // The bands above and below are held at their natural height. The
  // quick-action WELL is wrapped by the band that carries it, so look just
  // upstream of the id for the class.
  // The quick-action band IS the well now (the wrapper it used to sit inside
  // went with the divided-well treatment), so `shrink-0` is on the element
  // itself — which in the rendered markup comes after the id, not before it.
  const actionsAt = html.indexOf('id="improve-quick-actions"');
  assert.match(html.slice(actionsAt, html.indexOf('>', actionsAt)), /\bshrink-0\b/,
    'the quick-action band keeps its height');
  const viewsAt = html.indexOf('id="improve-views"');
  assert.match(html.slice(viewsAt, html.indexOf('>', viewsAt)), /\bshrink-0\b/,
    '#improve-views keeps its height');
  const footerAt = html.indexOf('id="improve-footer"');
  assert.match(html.slice(footerAt, html.indexOf('>', footerAt)), /\bshrink-0\b/,
    'the reference footer keeps its height');
  assert.ok(actionsAt < viewsAt && viewsAt < scrollAt && scrollAt < footerAt,
    'actions, views, the scroller, then the reference footer');

  // The footer came back (#1443). #1431 dissolved it and rehomed each fact
  // separately; every move was defensible alone and the sum meant leaving the
  // app to read facts about the app you were standing in.
  assert.match(panel, /id="improve-row-github"/, 'the GitHub link is back');
  // THE VERSION ROWS ARE NOT IN IT. They were, and the question they were
  // being read for was never "which SHA" — it was "is something happening,
  // and is there a new version yet". Three static rows answered that only by
  // implication, and you had to notice one of them had become a spinner.
  //
  // The footer states it instead: a note while a build is in flight, a reload
  // button once one is ready. The revisions themselves went back to Settings'
  // About pane, which is the screen you consult rather than act from
  // (tests/header-status-pane.test.js pins where they landed).
  assert.match(panel, /id="improve-update-note"/, 'the footer says when a build is in flight');
  assert.match(panel, /id="improve-update-ready"/, 'and offers the reload when one is ready');
  assert.ok(!panel.includes('id="improve-row-version"'),
    "the app's version row is Settings' now");
  assert.ok(!panel.includes('id="drawer-row-platform-version"'),
    'and so is the platform build');
  assert.ok(!panel.includes('<NativeAppVersionRow />'),
    'and the native app version');
  // The state behind all three is NAMED, not read back out of a rendered row,
  // which is what let them move at all — see improve-status.js.
  assert.match(panel, /versionState === 'downloading'/,
    'the note distinguishes the download from the build that preceded it');
  // Fork lineage did NOT come back: #browse-detail-fork on the app's own page
  // is the better home, because lineage is a fact about an app.
  assert.ok(!panel.includes('id="drawer-row-app-fork"'),
    'fork lineage stays on the app detail page');
  assert.match(panel, /id="improve-row-share"/,
    "Share app survived as the panel's third action");
});

test('app.css drops the tab-bar rules and draws the Improve panel', () => {
  const css = read('public/css/app.css');
  assert.ok(!/^\.app-tab\b/m.test(css), '.app-tab rules still present');
  // The .app-mode-seg rules went with the switch itself.
  assert.ok(!css.includes('.app-mode-seg'), 'orphan App/Dev segment rules survive');
  // Desktop side panel, mobile bottom sheet — one element, two idioms, and
  // the requirement holds in a mobile browser with no native kit loaded.
  assert.ok(css.includes('#improve-panel'), 'the Improve panel has no chrome');
  assert.ok(css.includes('#improve-panel[data-open]'), 'nothing slides the panel in');
  assert.ok(/@media \(max-width: 639px\)[\s\S]{0,900}#improve-panel[\s\S]{0,400}translateY/
    .test(css), 'below sm the panel must come up from the bottom, not in from the side');
  assert.ok(/#improve-panel \{[\s\S]{0,300}translateX/.test(css),
    'at sm and up the panel must slide in from the side');
});
