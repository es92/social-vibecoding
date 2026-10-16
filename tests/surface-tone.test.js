'use strict';
// #2803: when the app on screen reports a dark page, the sheets, dialogs and
// menus opened over it use the shell's dark palette instead of the viewer's
// light mode. This reverses #1945/#2704's "dialogs keep the viewer's own
// mode". frontend/src/lib/surface-tone.ts puts `.dark` on the floating
// surfaces (never on <html>), marked so it only removes the class it added.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tone = loadTsx('frontend/src/lib/surface-tone.ts');

function classList(initial = []) {
  const set = new Set(initial);
  return {
    set,
    contains: (c) => set.has(c),
    add: (c) => { set.add(c); },
    remove: (c) => { set.delete(c); },
  };
}
const el = (classes = [], id = '') => ({ id, classList: classList(classes) });

function fakeDoc({ tone: t = null, dark = false, kids = [], byId = {} } = {}) {
  const attrs = new Map(t ? [['data-app-tone', t]] : []);
  const root = el(dark ? ['dark'] : []);
  root.getAttribute = (n) => (attrs.has(n) ? attrs.get(n) : null);
  return {
    attrs,
    documentElement: root,
    body: { children: kids },
    getElementById: (id) => byId[id] || null,
  };
}

test('only a dark app under the LIGHT shell tones the surfaces', () => {
  assert.equal(tone.appToneDark(fakeDoc({ tone: 'dark' }).documentElement), true);
  assert.equal(tone.appToneDark(fakeDoc({ tone: 'dark', dark: true }).documentElement), false,
    'the dark shell is already dark');
  assert.equal(tone.appToneDark(fakeDoc({ tone: 'light' }).documentElement), false);
  assert.equal(tone.appToneDark(fakeDoc({ tone: 'light', dark: true }).documentElement), false,
    'a light app under the dark shell is out of scope');
  assert.equal(tone.appToneDark(fakeDoc().documentElement), false);
});

test('every kit shell, the two in-tree sheets and the desktop rail are tone surfaces; nothing else is', () => {
  for (const c of ['un-modal', 'un-sheet', 'un-panel', 'un-action-sheet', 'un-popover', 'un-alert']) {
    assert.ok(tone.isToneSurface(el([c])), c);
  }
  assert.ok(tone.isToneSurface(el(['fixed'], 'apps-switcher-sheet')), 'the Homeroom menu');
  assert.ok(tone.isToneSurface(el(['fixed'], 'notifications-sheet')));
  // The rail stays docked beside a running app on a desktop, so it is part of
  // the strip around a dark app, and its parked foot with it.
  assert.ok(tone.isToneSurface(el(['platform-tabs'], 'platform-tabs')), 'the rail');
  assert.ok(tone.isToneSurface(el(['platform-parked'], 'platform-parked')), 'its parked foot');
  for (const c of ['un-backdrop', 'overlay-scrim', 'un-toast', 'app-shell']) {
    assert.equal(tone.isToneSurface(el([c])), false, c);
  }
});

test('the tone adds .dark with a mark, and only removes a .dark it marked', () => {
  const modal = el(['un-modal']);
  tone.toneSurface(modal, true);
  assert.deepEqual([...modal.classList.set].sort(), ['dark', tone.MARK, 'un-modal'].sort());
  tone.toneSurface(modal, true);
  assert.equal(modal.classList.set.size, 3, 'idempotent');
  tone.toneSurface(modal, false);
  assert.deepEqual([...modal.classList.set], ['un-modal']);

  const ownDark = el(['un-modal', 'dark']);
  tone.toneSurface(ownDark, true);
  assert.equal(ownDark.classList.contains(tone.MARK), false, 'a surface dark on its own account is left alone');
  tone.toneSurface(ownDark, false);
  assert.ok(ownDark.classList.contains('dark'), '…and keeps its own .dark when the tone goes');
});

test('sync tones every open surface and never touches <html>', () => {
  const modal = el(['un-modal']);
  const backdrop = el(['un-backdrop']);
  const menu = el(['fixed', 'dc-lift-panel'], 'apps-switcher-sheet');
  const doc = fakeDoc({ tone: 'dark', kids: [backdrop, modal], byId: { 'apps-switcher-sheet': menu } });
  assert.equal(tone.syncSurfaceTone(doc), true);
  assert.ok(modal.classList.contains('dark'));
  assert.ok(menu.classList.contains('dark'));
  assert.equal(backdrop.classList.contains('dark'), false);
  assert.equal(doc.documentElement.classList.contains('dark'), false, '<html> stays the theme module\'s');
  doc.attrs.delete('data-app-tone');
  assert.equal(tone.syncSurfaceTone(doc), false);
  assert.equal(modal.classList.contains('dark'), false);
  assert.equal(menu.classList.contains('dark'), false);
});

test('a surface presented while the tone holds is dark before it paints, and follows a tone change', () => {
  const observers = [];
  class Observer {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe(target, opts) { this.target = target; this.opts = opts; }
    disconnect() { this.disconnected = true; }
  }
  const doc = fakeDoc({ tone: 'dark' });
  const stop = tone.initSurfaceTone(doc, Observer);
  const [rootObs, bodyObs] = observers;
  assert.equal(rootObs.target, doc.documentElement);
  assert.deepEqual(rootObs.opts.attributeFilter, ['data-app-tone', 'class']);
  assert.equal(bodyObs.target, doc.body);
  assert.deepEqual(bodyObs.opts, { childList: true }, 'direct children only: the kit appends to <body>');

  const sheet = el(['un-sheet']);
  doc.body.children = [sheet];
  bodyObs.cb([{ addedNodes: [sheet] }]);
  assert.ok(sheet.classList.contains('dark'), 'presented dark');

  doc.documentElement.classList.add('dark'); // the viewer switches the shell to dark
  rootObs.cb([]);
  assert.equal(sheet.classList.contains(tone.MARK), false, 'the shell is dark now; the tone steps back');

  stop();
  assert.ok(rootObs.disconnected && bodyObs.disconnected);
});

test('the bundle loads it, and app.css inks a toned surface with the dark body ink', () => {
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/surface-tone';/);
  const css = read('public/css/app.css');
  const at = css.indexOf(`:where(.${tone.MARK}) {`);
  assert.ok(at > 0, 'a zero-specificity rule so a kit rule that inks from a token still wins');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /color: #eaeaea;/, 'the same literal the bar\'s dark tone uses');
  assert.match(block, /color-scheme: dark;/);
  // The palette itself is plain `.dark { … }` blocks, which is what makes a
  // class on the surface enough. If these ever become `html.dark`, the tone
  // silently stops reaching the dialogs.
  assert.match(css, /\n\.dark \{\n  --bg-primary:/);
  assert.match(css, /\n\.dark \{\n  --un-accent:/);
  assert.match(read('tailwind.config.js'), /darkMode: 'class'/);
});

test('app-tone.js no longer promises that dialogs keep the viewer\'s mode', () => {
  const src = read('frontend/src/features/app-frame/app-tone.js');
  assert.doesNotMatch(src, /every sheet or dialog opened from the bar\s+\* keeps the shell's theme/);
  assert.match(src, /lib\/surface-tone\.ts/);
});
