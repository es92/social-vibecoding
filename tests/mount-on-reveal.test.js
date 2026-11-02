// A screen's interior mounts on its FIRST REVEAL, not in the prerender.
//
// public/index.html carried 1,485 elements, and 681 of them — #settings-
// screen's sixteen panes (437) and the six anonymous-shell screens (244) —
// sat hidden behind roots a signed-in visitor on the board never reveals.
// Every load parsed, styled and hydrated them anyway. frontend/src/lib/
// mount-on-reveal.ts is the seam that stops that: the root stays in the
// document exactly as it was, and the children render once the root is
// revealed or a legacy caller asks for them.
//
// Three things are pinned here, because each is a way the change could
// quietly undo itself:
//
//   1. THE STORE. `mounted` is one-way, notifies synchronously, and the
//      server snapshot honours an explicit mark — which is what lets a test
//      render an interior (tests/lib/lazy-interiors.js) while the SSG pass,
//      which marks nothing, keeps emitting the empty root.
//   2. THE CALLERS. Settings.open()/route() and AuthScreens.show() were
//      written against markup that was always there and read its ids on
//      their next line, so each asks for the interior FIRST. Lose that line
//      and the screen opens empty with a null dereference behind it.
//   3. THE DOCUMENT. Each root ships as an empty element, and each screen
//      renders its interior only when marked — the win, and the hydration
//      contract (first client render == prerender) in one assertion.
//
// Run with: node --test tests/mount-on-reveal.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { MOUNT_ON_REVEAL, childrenOf } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 1. The store ───────────────────────────────────────────────────────

test('a mark is one-way, idempotent and notifies subscribers once', () => {
  const store = loadTsx('frontend/src/lib/mount-on-reveal.ts');
  const id = 'test-screen-' + process.pid;
  assert.equal(store.isMarkedMounted(id), false, 'nothing has asked for it yet');
  let notified = 0;
  const off = (() => {
    const s = store.getMountedStore();
    const fn = () => { notified += 1; };
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  })();
  store.markMounted(id);
  store.markMounted(id);
  assert.equal(store.isMarkedMounted(id), true);
  assert.equal(notified, 1, 'the second mark changes nothing and says nothing');
  off();
});

test('ensureMounted reports whether the interior was already there', () => {
  const store = loadTsx('frontend/src/lib/mount-on-reveal.ts');
  const id = 'test-ensure-' + process.pid;
  // No document in Node: the mark is the whole effect, and there is no
  // flushSync to call — the function must still answer.
  assert.equal(store.ensureMounted(id), false, 'a first ask mounts it');
  assert.equal(store.ensureMounted(id), true, 'a second ask finds it mounted');
});

test('the store is shared across bundles through globalThis', () => {
  // tests/lib/lazy-interiors.js marks through ITS copy and renders a screen
  // whose bundle holds ANOTHER copy; this is the property that makes that
  // work, and the visibility store's reason for living on window.
  const a = loadTsx('frontend/src/lib/mount-on-reveal.ts');
  const src = read('frontend/src/lib/mount-on-reveal.ts');
  assert.match(src, /MOUNTED_STORE_KEY = '__usernodeMounted'/);
  assert.match(src, /host\[MOUNTED_STORE_KEY\] = store;/, 'created on globalThis on first touch');
  assert.equal(globalThis.__usernodeMounted, a.getMountedStore());
});

test('the server snapshot reads the mark, and the bridge is published at module scope', () => {
  const src = read('frontend/src/lib/mount-on-reveal.ts');
  assert.match(src, /useSyncExternalStore\(subscribe, snapshot, \(\) => isMarkedMounted\(id\)\)/,
    'the prerender marks nothing, so it emits the empty root; a test that marks gets the interior');
  assert.match(src, /bridge\.mount = \{ ensure: ensureMounted, isMounted: isMarkedMounted \};/,
    'the classic scripts reach ensure() by name, so it has to exist before their init');
  assert.match(src, /flushSync\(\(\) => \{\s*markMounted\(id\);\s*\}\);/,
    'a legacy caller gets the nodes synchronously — that is the contract they were written against');
});

// ── 2. The callers ─────────────────────────────────────────────────────

test('Settings.open() and route() ask for the interior before touching a pane', () => {
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /_ensureMounted\(\) \{[\s\S]*?window\.UsernodeReact\?\.mount\?\.ensure\?\.\('settings-screen'\)/,
    'reached by name — a dozen tests run this file as a script in a vm');
  assert.match(js, /open\(section, opts\) \{\n\s*Settings\._ensureMounted\(\);\n\s*Settings\._open = true;/,
    'open() renders every pane into the still-hidden screen and _renderBody dereferences their ids');
  assert.match(js, /route\(section\) \{\n\s*Settings\._ensureMounted\(\);/,
    'route() is the re-entry path and reads the same ids');
});

test('AuthScreens.show() asks for the screen before wiring or revealing it', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /show\(route, seg\) \{\n\s*const id = SCREEN_IDS\[route\];\n\s*if \(!id\) return;[\s\S]{0,700}?AuthScreens\._ensureMounted\(id\);\n\s*AuthScreens\._wireScreen\(route\);/,
    '_wireScreen runs the on-show hook the React screen patches onto this object at mount, so mount first');
  assert.match(js, /_ensureMounted\(id\) \{[\s\S]*?window\.UsernodeReact\?\.mount\?\.ensure\?\.\(id\)/);
  // showWaiting() funnels through show(), so one ensure covers every entry.
  assert.match(js, /showWaiting\(\) \{[\s\S]*?AuthScreens\.show\('waiting'\);/);
});

test('the settings chassis mounts its panes on reveal and keeps refresh() at boot', () => {
  const tsx = read('frontend/src/features/settings/index.tsx');
  assert.match(tsx, /const mounted = useMountedOnReveal\('settings-screen'\);/);
  // The panes are gated on the reveal AND on their chunk having arrived
  // (tests/settings-lazy.test.js covers the chunk half).
  assert.match(tsx, /\{mounted && Sections \? <Sections \/> : null\}/,
    '#settings-section-content ships empty, like #admin-section-content');
  // refresh() populates Settings.state.hasApiKey, which dev-chat and app-view
  // read before the screen is ever opened — so it cannot wait for the mount.
  assert.match(tsx, /useIsomorphicLayoutEffect\(\(\) => \{\n\s*window\.Settings\?\.refresh\?\.\(\);\n\s*prefetchSettings\(\);\n\s*\}, \[\]\);/);
  // init() binds controls by id ONCE, so it waits for them and never re-runs:
  // it is a layout effect of the panes component itself now.
  const sections = read('frontend/src/features/settings/sections/index.tsx');
  assert.match(sections, /export function SettingsSections\(\) \{\n[\s\S]{0,900}?useIsomorphicLayoutEffect\(\(\) => \{\n\s*window\.Settings\?\.init\?\.\(\);\n\s*\}, \[\]\);/);
  assert.doesNotMatch(tsx, /window\.Settings\?\.init/,
    'init() must not run from the chassis — the ids it binds are not there until the panes are');
});

test('every auth screen gates its interior on the same hook', () => {
  for (const spec of MOUNT_ON_REVEAL) {
    if (spec.id === 'settings-screen') continue;
    const tsx = read(spec.entry);
    const key = spec.id.replace(/^auth-/, '').replace(/-screen$/, '');
    assert.match(tsx, new RegExp(`const mounted = useMountedOnReveal\\(AUTH_SCREEN_IDS\\.${key}\\);`),
      `${spec.entry} subscribes to its own root`);
    assert.match(tsx, /\n    >\n      \{mounted \? \(\n        <>\n/,
      `${spec.entry} renders its children only once mounted`);
    assert.match(tsx, /\n        <\/>\n      \) : null\}\n    <\/main>\n/,
      `${spec.entry} closes the gate before </main>`);
  }
  // The one effect that bound interior DOM at hydration is keyed on the mount.
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /if \(!mounted\) return;\n\s*const handle = ui\.pullToRefresh\(byId\('auth-landing-scroll'\)/);
  assert.match(landing, /handle\?\.detach\(\);[\s\S]{0,80}\}, \[mounted\]\);/);
});

// ── 3. The document ────────────────────────────────────────────────────

test('each mount-on-reveal root ships EMPTY in the prerendered document', () => {
  const html = read('public/index.html');
  for (const { id, host } of MOUNT_ON_REVEAL) {
    const inner = childrenOf(html, host);
    assert.equal(inner.trim(), '',
      `#${host} has children in public/index.html — its interior is supposed to mount on reveal`);
    assert.ok(html.includes(`id="${id}"`), `#${id} — the root — is still in the document`);
  }
});

test('a screen renders its interior only when its root is marked mounted', () => {
  // Rendered without a mark: the empty root the document ships — which is
  // also what the first client render produces, so hydration matches.
  const bare = renderComponent('frontend/src/features/auth/register.tsx', 'RegisterScreen', {});
  assert.equal(childrenOf(bare, 'auth-register-screen').trim(), '');
  // And with one: the interior, as the reveal mounts it.
  loadTsx('frontend/src/lib/mount-on-reveal.ts').markMounted('auth-register-screen');
  const mounted = renderComponent('frontend/src/features/auth/register.tsx', 'RegisterScreen', {});
  assert.match(childrenOf(mounted, 'auth-register-screen'), /data-auth-back/);
});

test('the prerendered document is a fraction of what it was', () => {
  // The number this change exists for. 1,485 elements shipped before; the
  // bound is generous so an ordinary chassis edit does not trip it, and
  // tight enough that a screen quietly going back to prerendering does.
  //
  // 1000 → 1075 with communities, stage 3: the create dialog asks who a
  // project is for and, for a group or a community, who approves, and that
  // dialog has always prerendered every step (its ids are the declared
  // checks' anchors). About 55 elements. Still far under the 681 the two
  // mount-on-reveal interiors alone were, which is what this guards.
  //
  // 1075 → 1100 with the create dialog's rework: "What are you making?"
  // became three rows, a group's invites a step of their own, and "How do
  // you want to start?" moved last with a third row. About 25 elements.
  //
  // 1100 → 1125 with the overnight audit's L06 (2 Nov 2026): the Homeroom
  // bot tab's Needs you card draws a loading placeholder (a status line and
  // two bars, four elements) until its first read, where it used to claim
  // "Nothing needs you" before anything had loaded. Main stood at 1097, so
  // those four tipped it to 1101; the rest of the headroom is for ordinary
  // edits.
  const html = read('public/index.html');
  const elements = (html.match(/<[a-zA-Z]/g) || []).length;
  assert.ok(elements < 1125,
    `public/index.html carries ${elements} elements; the two mount-on-reveal interiors alone were 681`);
});
