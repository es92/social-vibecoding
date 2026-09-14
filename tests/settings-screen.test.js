// Settings as its own screen (settings-modal-to-screen conversion) — the
// #settings hash route that replaced the #settings-modal overlay, laid out
// like the Admin & moderation console: a grouped sidebar on md+, a
// two-level menu -> section hierarchy below it.
//
// Contract pinned here:
//  - the screen host ships hidden in the shell with its four render slots,
//    and the modal (#settings-modal / #settings-close) is gone for good;
//  - the section registry and the [data-settings-section] wrappers agree
//    BOTH ways — a section that loses its wrapper (or a wrapper that loses
//    its registry entry) becomes unreachable, silently, without this;
//  - MOVE, DON'T REWRITE: every pre-existing control id still exists in
//    index.html, and settings.js never innerHTML-writes anything but the
//    two nav hosts. This is the rule the whole conversion rests on —
//    settings.js binds by id once at DOMContentLoaded, so a rebuilt
//    section is a section whose controls silently stop working;
//  - the router / navigate / exit wiring in app.js, including the
//    sibling-exit discipline and the back-button hand-off;
//  - ONE breakpoint constant, read through matchMedia, in step with the
//    md: classes the static shell emits;
//  - a bare #settings means the MENU on mobile and the default section on
//    desktop, and handleBack() only calls history.back() for an entry we
//    pushed ourselves;
//  - no environment gating anywhere (the admin-console rule);
//  - the dapp.json rendered checks keep the screen actually rendering.
//
// Run with: node --test tests/settings-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');
const { shellMarkup } = require('./lib/shell-markup');

// The markup the shell renders — document plus the settings panes, which
// mount on first reveal (tests/lib/shell-markup.js).
const html = shellMarkup();
const appJs = read('public/js/app.js');
const settingsJs = read('frontend/src/features/settings/settings.js');
// #1079: #settings-usernode-section's markup moved to a component; its tests
// read both halves — the DECISIONS here, the SHAPES there.
const usernodeTsx = read('frontend/src/features/settings/sections/usernode.tsx');
const usernodeUiTsx = read('frontend/src/features/settings/sections/usernode-ui.tsx');
const usernodeStoreTs = read('frontend/src/features/settings/sections/usernode-store.ts');

/** One method's source, by brace matching — stable across reordering. */
function sliceMethod(src, name) {
  const re = new RegExp(`\\n    (async )?${name}\\(`);
  const m = src.match(re);
  assert.ok(m, `${name} exists`);
  // Depth starts at ZERO: the match ends inside the PARAMETER list, before
  // the body's opening brace. Seeding it at 1 makes the scan need two closers
  // and run on into the next method — which reads as a passing slice right up
  // until an assertion counts something.
  let i = m.index + m[0].length;
  let depth = 0;
  let started = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; }
    if (started && depth === 0) { i++; break; }
  }
  return src.slice(m.index, i);
}
// The halves the two nav hosts were split into by #1191 slice 6, conversion 8.
const navTsx = read('frontend/src/features/settings/settings-nav.tsx');
const navStoreJs = read('frontend/src/features/settings/settings-nav-store.js');

// The section a bare #settings resolves to, read from the module rather than
// repeated here — THE UI OVERHAUL moved Theme in from the hamburger and made
// it the default, and a hard-coded copy would have silently kept asserting
// the old one.
const DEFAULT_SECTION = settingsJs.match(/DEFAULT_SECTION: '([a-z-]+)'/)[1];
const mountTs = read('frontend/src/features/settings/mount.ts');
const kitSurfaceTs = read('frontend/src/lib/kit-surface.ts');

/**
 * Source with its comments removed. Several assertions below are absence
 * proofs — "this module no longer writes innerHTML", "the listener sweep is
 * gone" — and prose that NAMES the retired thing must not read as the thing
 * still being there.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const settingsCode = code(settingsJs);
const devChatJs = read('frontend/src/features/dev-chat/dev-chat.js');
const platformUiJs = read('public/js/platform-ui.js');
const cliAuthJs = read('src/routes/cli-auth.js');
const manifest = JSON.parse(read('dapp.json'));

// The registry, parsed out of the shipped source so the tests can't drift
// from it. Matches `{ key: 'x', label: 'Y', group: 'Z'[, gate: 'id'] }`.
function registrySections() {
  const block = settingsJs.slice(
    settingsJs.indexOf('    SECTIONS: ['),
    settingsJs.indexOf('    DEFAULT_SECTION:'),
  );
  assert.ok(block, 'SECTIONS registry found in settings.js');
  const out = [];
  const re = /\{ key: '([a-z-]+)', label: '([^']+)', group: '([^']+)'(?:, gate: '([a-z-]+)')? \}/g;
  let m;
  while ((m = re.exec(block))) {
    out.push({ key: m[1], label: m[2], group: m[3], gate: m[4] || null });
  }
  return out;
}

// ── The screen host ────────────────────────────────────────────────────

test('the settings screen ships hidden with its four render slots', () => {
  // Matched per-class rather than as one closed string so an added
  // utility (e.g. `platform-safe-scroll`, which reserves the
  // home-indicator strip for the last row) doesn't fail this on a
  // substring.
  const openTag = /<main id="settings-screen"[^>]*>/.exec(html);
  assert.ok(openTag, '#settings-screen is missing from the shell');
  for (const cls of ['hidden', 'flex-1', 'overflow-y-auto']) {
    assert.match(openTag[0], new RegExp(`(?:class="|\\s)${cls}(?:\\s|")`),
      `screen container must keep ${cls} like its sibling screens`);
  }
  for (const id of [
    'settings-root', 'settings-sidebar-col', 'settings-content-col',
    'settings-nav-desktop', 'settings-mobile-menu-host',
    'settings-section-content', 'settings-footer',
  ]) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `#${id} exists exactly once in the shell`);
  }
  assert.match(html, /<div id="settings-root" class="max-w-5xl/,
    'the shell is max-w-5xl — a form column, not the admin console 7xl');
});

test('the modal is gone — markup, close button and modal registration', () => {
  assert.doesNotMatch(html, /id="settings-modal"/,
    '#settings-modal is deleted from the shell');
  assert.doesNotMatch(html, /id="settings-close"/,
    'the modal close button is deleted');
  assert.doesNotMatch(platformUiJs, /'settings-modal'/,
    'settings is not a modal any more — nothing in platform-ui.js names it');
  // It used to be a member of platform-ui's STATIC_MODAL_IDS, and this test
  // checked that the list still held the other nine. #1078 chunk I moved that
  // whole seam into frontend/src/lib/static-modal.ts, driven by the dialog
  // islands' own state, so the equivalent check is that settings is not one of
  // them — the dialogs directory renders no settings root.
  const dialogsDir = path.join(root, 'frontend', 'src', 'features', 'dialogs');
  for (const file of fs.readdirSync(dialogsDir)) {
    if (!file.endsWith('.tsx')) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(dialogsDir, file), 'utf8'), /id="settings-modal"/,
      `${file} should not render a settings modal`);
  }
  assert.doesNotMatch(settingsJs, /AppView\.revealModal\(/,
    'settings.js no longer reveals itself as a modal');
  assert.doesNotMatch(settingsJs, /modalDismissGuarded\(/,
    'settings.js no longer guards a backdrop it does not have');
  assert.doesNotMatch(settingsJs, /getElementById\('settings-close'\)/,
    'the close-button wiring is gone');
});

// ── Registry <-> markup, both directions ───────────────────────────────

test('every registry section has exactly one wrapper, and vice versa', () => {
  const sections = registrySections();
  assert.ok(sections.length >= 12, `registry parsed (${sections.length} sections)`);

  const wrappers = [...html.matchAll(/data-settings-section="([a-z-]+)"/g)].map((m) => m[1]);
  const registryKeys = sections.map((s) => s.key);

  for (const key of registryKeys) {
    const hits = wrappers.filter((w) => w === key);
    assert.equal(hits.length, 1, `[data-settings-section="${key}"] appears exactly once`);
  }
  for (const w of wrappers) {
    assert.ok(registryKeys.includes(w),
      `wrapper "${w}" has a registry entry (otherwise it is unreachable)`);
  }
  // Wrappers ship hidden — the router unhides exactly one.
  for (const key of registryKeys) {
    assert.match(html, new RegExp(`data-settings-section="${key}" class="hidden"`),
      `the ${key} wrapper ships hidden`);
  }
});

test('every gated section names a real inner node that owns its own hidden', () => {
  for (const s of registrySections().filter((x) => x.gate)) {
    assert.match(html, new RegExp(`id="${s.gate}" class="hidden`),
      `#${s.gate} ships hidden — its render fn is the gate`);
  }
  const vis = settingsJs.slice(settingsJs.indexOf('    _visibleSections() {'));
  assert.match(vis.slice(0, 500), /classList\.contains\('hidden'\)/,
    'menu membership is READ off the gate node, never re-derived');
});

test('the default section is an ungated key', () => {
  const m = settingsJs.match(/DEFAULT_SECTION: '([a-z-]+)'/);
  assert.ok(m, 'DEFAULT_SECTION is declared');
  const hit = registrySections().find((s) => s.key === m[1]);
  assert.ok(hit, `${m[1]} is a registered section`);
  assert.equal(hit.gate, null, 'the default section is never behind a gate');
});

// ── Grouping and the Advanced disclosure (#1554) ────────────────────────

test('the registry groups into four sections, Advanced last', () => {
  const sections = registrySections();
  // First-appearance order, exactly what _groupedSections() derives.
  const order = [];
  for (const s of sections) if (!order.includes(s.group)) order.push(s.group);
  assert.deepEqual(order, ['Preferences', 'Account', 'AI & agents', 'Advanced'],
    'four groups, in menu order');
  // dapp.json asserts this heading by TEXT, so the spelling is a contract.
  assert.ok(manifest.tests.some((t) => t.expectText === 'AI & agents'),
    'the AI & agents heading is a declared check');

  // Theme leads the registry: DEFAULT_SECTION, the visible[0] fallbacks in
  // open()/route()/setSection and the "Theme is the first setting" check all
  // resolve through position, so the regrouping must not have moved it.
  assert.equal(sections[0].key, 'theme', 'Theme is still the first entry');
  assert.equal(sections[0].group, 'Preferences');
  assert.equal(sections[0].gate, null);

  // Nothing was dropped on the way: every section is still registered, and
  // the rarely-used ones are the ones that moved.
  const byKey = Object.fromEntries(sections.map((s) => [s.key, s.group]));
  for (const key of [
    'theme', 'language', 'alerts', 'username', 'password', 'wallet',
    'openrouter', 'api-key', 'connectors', 'app-ai', 'agent-files', 'cli',
    'dev-console', 'experimental', 'usernode', 'admin-preview', 'about',
  ]) assert.ok(byKey[key], `${key} is still reachable from the menu`);
  for (const key of [
    'app-ai', 'agent-files', 'cli', 'dev-console', 'experimental',
    'usernode', 'admin-preview', 'about',
  ]) assert.equal(byKey[key], 'Advanced', `${key} sits under Advanced`);
});

test('Advanced is the ONE collapsible group, and it starts closed', () => {
  assert.match(settingsJs, /ADVANCED_GROUP: 'Advanced'/,
    'the collapsible group is named once, not spelled at every reader');
  const isCollapsible = sliceMethod(settingsJs, '_isCollapsibleGroup');
  assert.match(isCollapsible, /=== Settings\.ADVANCED_GROUP/,
    '_isCollapsibleGroup is the single reader of that name');

  // The set stores the EXPANDED names, the inverse of the admin console's
  // NAV_COLLAPSED_KEY: an empty, cleared or foreign store must resolve to
  // "Advanced is shut", which is what the declared check asserts.
  assert.match(settingsJs, /const NAV_EXPANDED_KEY = 'settings_nav_expanded_groups_v1';/);
  const isExpanded = sliceMethod(settingsJs, '_isGroupExpanded');
  assert.match(isExpanded, /_isCollapsibleGroup\(name\)/,
    'a group that does not collapse is always expanded');
  assert.match(isExpanded, /_expanded\(\)\.has\(/,
    'presence in the set is what opens it');
  assert.match(isExpanded, /_revealedGroup === key/,
    'or the group the active section lives in, for this visit only');

  // Closing the group you are standing in has to drop that reveal too, or
  // the heading is a button that visibly does nothing.
  assert.match(sliceMethod(settingsJs, '_toggleGroup'),
    /if \(!open\) Settings\._revealedGroup = null;/);

  // Runs inside a render path, and the prerender pass / vm harnesses have no
  // localStorage, so the load must neither throw nor touch storage there.
  const load = sliceMethod(settingsJs, '_loadExpandedGroups');
  assert.match(load, /if \(typeof window === 'undefined'\) return;/,
    'the storage read is guarded for Node');
  assert.match(load, /catch \{/, 'corrupt or unavailable storage is non-fatal');
  assert.match(load, /_isCollapsibleGroup\(key\)/,
    'names that are no longer a collapsible group are pruned');
  assert.match(sliceMethod(settingsJs, '_saveExpandedGroups'), /catch \{/);
});

test('a disclosure press repaints the menu and nothing else', () => {
  const fn = sliceMethod(settingsJs, '_toggleGroup');
  assert.match(fn, /_setGroupExpanded\(/, 'it flips the persisted state');
  assert.match(fn, /Settings\._renderNav\(\);/, 'and repaints the nav');
  // The admin console's rule, for the same three reasons: the section on
  // screen keeps rendering, a phone repaint would tear the menu down
  // mid-gesture, and focus stays on the heading you just pressed.
  for (const forbidden of [
    /setSection\(/, /location\.hash/, /_writeHash\(/, /_renderContent\(/,
  ]) assert.doesNotMatch(fn, forbidden, `_toggleGroup must not call ${forbidden}`);
});

test('arriving at a section reveals the group it lives in, transiently', () => {
  const fn = sliceMethod(settingsJs, '_ensureActiveGroupExpanded');
  assert.match(fn, /Settings\._revealedGroup =/,
    'the reveal is derived from the active section');
  // Persisting it would make one deep link into About or CLI the last time
  // that viewer ever sees Advanced shut. It would also make "ships
  // collapsed" depend on route order: the capture container walks the
  // declared #settings routes as hash cohorts of ONE document, in
  // declaration order, and #settings/about lands before #settings.
  for (const forbidden of [/_setGroupExpanded\(/, /_saveExpandedGroups\(/]) {
    assert.doesNotMatch(fn, forbidden, 'the arrival reveal never persists');
  }
  assert.match(fn, /: null/, 'and it clears when the section leaves the group');

  // On ARRIVAL only — the three paths that resolve a section. A deep link
  // into Advanced (the out-of-credits card's #settings/cli, the consent
  // modal's #settings/api-key, a bookmark) must not leave the highlighted
  // row inside a shut group.
  const open = sliceMethod(settingsJs, 'open');
  assert.equal((open.match(/_ensureActiveGroupExpanded\(\)/g) || []).length, 2,
    'open() reveals on both the menu and the section branch');
  const route = sliceMethod(settingsJs, 'route');
  assert.equal((route.match(/_ensureActiveGroupExpanded\(\)/g) || []).length, 2,
    'route() reveals on both the desktop and the mobile branch');
  assert.match(sliceMethod(settingsJs, '_renderNavIfOpen'), /_ensureActiveGroupExpanded\(\)/,
    'a late-arriving gate re-resolves through the same reveal');
});

test('both nav descriptors carry the disclosure, with per-surface ids', () => {
  const disclosure = sliceMethod(settingsJs, '_groupDisclosure');
  for (const field of ['collapsible', 'expanded', 'domId']) {
    assert.match(disclosure, new RegExp(`${field}[,:]`), `_groupDisclosure emits ${field}`);
  }
  // aria-controls targets have to be unique, and at phone width BOTH hosts
  // are in the document — hence one id prefix per surface.
  const nav = settingsJs.slice(settingsJs.indexOf('    _navView() {'));
  assert.match(nav.slice(0, 1600), /_groupDisclosure\('settings-nav-group'/);
  const menu = settingsJs.slice(settingsJs.indexOf('    _menuView() {'));
  assert.match(menu.slice(0, 1600), /_groupDisclosure\('settings-menu-group'/);

  // The component renders the button, the pair and the wrapper the declared
  // checks select on, and leaves every other group's markup alone.
  assert.match(navTsx, /data-settings-group-toggle=\{group\.name\}/);
  assert.match(navTsx, /aria-expanded=\{group\.expanded \? 'true' : 'false'\}/);
  assert.match(navTsx, /aria-controls=\{group\.domId \|\| undefined\}/);
  assert.match(navTsx, /if \(!group\.collapsible\) \{/,
    'a non-collapsible group keeps the bare heading it always had');
  // The only user-facing copy this adds. No em dash, no punctuation: it is
  // read out by screen readers and shown as the hover title.
  assert.match(navTsx, /`\$\{group\.expanded \? 'Collapse' : 'Expand'\} \$\{group\.name\}`/,
    'the toggle labels itself Expand / Collapse <group>');

  // The two checks that hold the behaviour in staging.
  const paths = (t) => manifest.tests.filter((x) => x.path === t);
  assert.ok(paths('/#settings').some((t) => /group-toggle="Advanced"\]\[aria-expanded="false"/.test(t.expectSelector || '')),
    'a declared check pins Advanced shipping collapsed');
  assert.ok(paths('/?demo=cli-empty#settings/cli').some((t) => /#settings-nav-group-advanced:not\(\.hidden\)/.test(t.expectSelector || '')),
    'a declared check pins the deep-link reveal');
});

// ── #1556: Language is gated on an already-saved locale ────────────────

test('the Language section is offered only to a user who already saved a locale', () => {
  const hit = registrySections().find((s) => s.key === 'language');
  assert.ok(hit, 'language is still a registered section');
  assert.equal(hit.gate, 'settings-language-section',
    'the shell is English-only, so the picker is behind a capability gate');
  // It ships hidden (the generic gate test above covers the markup), and the
  // render fn is what reveals it — for a saved value, and only then.
  const fn = sliceMethod(settingsJs, '_renderLanguageSection');
  assert.match(fn, /const value = this\.state\.locale \|\| ''/,
    'the gate is decided by the stored locale, nothing else');
  assert.match(fn, /if \(!value\) \{[^}]*section\.classList\.add\('hidden'\);[^}]*return;/,
    'no saved locale -> the section stays hidden and nothing else renders');
  assert.match(fn, /section\.classList\.remove\('hidden'\)/,
    'a saved locale -> the section is revealed, so the preference stays changeable');
  // state.locale lands with /api/auth/me, which can resolve AFTER a cold-boot
  // deep link has already painted the menu — so the gate re-renders there too.
  const refresh = sliceMethod(settingsJs, 'refresh');
  assert.match(refresh, /this\._renderLanguageSection\(\)/,
    'refresh() re-runs the gate once the account payload arrives');
});

// ── MOVE, DON'T REWRITE ────────────────────────────────────────────────

test('every pre-existing settings control id survived the move', () => {
  const ids = [
    'settings-api-key', 'settings-save', 'settings-remove', 'settings-status',
    'settings-key-display', 'settings-spend',
    'cp-current', 'cp-new', 'cp-confirm', 'cp-save', 'cp-wallet-save',
    'llm-grants-list', 'llm-grants-status',
    'cli-tokens-list', 'cli-tokens-more', 'cli-tokens-status',
    'agent-files-input', 'agent-files-save', 'agent-files-cancel',
    'agent-files-instructions-list', 'agent-files-skills-list',
    'wallet-link-btn', 'wallet-link-cancel', 'wallet-qr-canvas',
    'view-as-non-admin', 'dev-console-always-show',
    'devchat-alerts-toggle', 'devchat-alerts-test',
    'settings-locale', 'settings-locale-status',
    'ai-progress-estimate', 'settings-usernode-section', 'settings-logout',
  ];
  for (const id of ids) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(hits.length, 1, `#${id} still exists exactly once`);
  }
});

test('the four formerly-anonymous section roots got stable ids', () => {
  for (const id of [
    'settings-language-section', 'settings-alerts-section',
    'settings-devconsole-section', 'settings-experimental-section',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  }
});

test('no section container is ever innerHTML-written', () => {
  // Section BODIES may still repaint their own dynamic list hosts
  // (#cli-tokens-list) exactly as they did in the modal — those are built by
  // settings.js and carry no init()-bound listeners. #llm-grants-list and the
  // two #agent-files-*-list hosts are NOT among them any more: all three are
  // React-owned end to end (frontend/src/features/settings/grants-list.tsx,
  // agent-files-list.tsx) and settings.js publishes a view model to each,
  // which the assertions below pin.
  //
  // What must never happen is a write that replaces a WRAPPER or the container
  // holding them, which would detach every id-bound control at once.
  for (const forbidden of ['settings-section-content', 'settings-screen', 'settings-root']) {
    assert.doesNotMatch(
      settingsJs,
      new RegExp(`getElementById\\('${forbidden}'\\)[^\\n]*\\.innerHTML`),
      `#${forbidden} is never innerHTML-written`,
    );
  }
  assert.doesNotMatch(settingsJs, /data-settings-section[^\n]*innerHTML/,
    'no wrapper is ever rebuilt');

  // #llm-grants-list is React's. settings.js must not reach into it at all:
  // not innerHTML, not appendChild, not even getElementById. It fetches and
  // publishes; grants-list.tsx renders. Two writers over one subtree is the
  // failure the migration's ownership rule exists to prevent, and the row
  // handlers here are exactly the kind of code that would reach for the node.
  assert.doesNotMatch(settingsJs, /llm-grants-list/,
    '#llm-grants-list is React-owned — settings.js publishes to grants-store instead');
  assert.match(settingsJs, /UsernodeReact\.settingsGrants/,
    'settings.js reaches the grants store through the published bridge');
  for (const host of ['agent-files-instructions-list', 'agent-files-skills-list']) {
    assert.doesNotMatch(settingsJs, new RegExp(host),
      `#${host} is React-owned — settings.js publishes to agent-files-store instead`);
  }
  assert.match(settingsJs, /UsernodeReact\.settingsAgentFiles/,
    'settings.js reaches the agent-files store through the published bridge');

  // #1191 slice 6, conversion 8: the two nav hosts are React now
  // (frontend/src/features/settings/settings-nav.tsx), so _renderNav pushes
  // descriptors instead of writing markup. The property it must keep is the
  // one this test always cared about — that settings.js writes NO html on
  // this screen — and it is now true of the whole module.
  const renderNav = settingsJs.slice(settingsJs.indexOf('    _renderNav() {'));
  const renderNavBody = renderNav.slice(0, renderNav.indexOf('\n    },\n'));
  assert.match(renderNavBody, /_store\?\.set\(\{/,
    '_renderNav publishes to the nav store');
  assert.match(renderNavBody, /desktop: Settings\._navView\(\)/,
    '_renderNav paints the desktop sidebar');
  assert.match(renderNavBody, /mobile: showMenu \? Settings\._menuView\(\) : null/,
    '_renderNav paints the mobile menu host, and clears it at level 2');
  assert.doesNotMatch(code(renderNavBody), /innerHTML|getElementById/,
    '_renderNav no longer touches the DOM at all');
  assert.doesNotMatch(settingsJs, /innerHTML\s*=\s*[^;]*_navView|innerHTML\s*=\s*[^;]*_menuView/,
    'neither view builder is ever fed back into an innerHTML write');
  // The section container is only ever class-toggled.
  const renderContent = settingsJs.slice(settingsJs.indexOf('    _renderContent() {'));
  assert.match(renderContent.slice(0, 900), /classList\.toggle\('hidden'/,
    '_renderContent toggles hidden on the wrappers');
  assert.doesNotMatch(renderContent.slice(0, 900), /innerHTML/,
    '_renderContent never rebuilds a section');
});

test('the log-out footer is MOVED between columns, never rebuilt', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    _syncFooter() {'));
  const body = fn.slice(0, fn.indexOf('\n    },\n'));
  assert.match(body, /appendChild\(footer\)/,
    'the real footer node is re-parented');
  assert.doesNotMatch(code(body), /innerHTML|createElement\(/,
    'no rebuild — #settings-logout keeps the handler bound in init()');
  assert.match(html, /id="settings-footer"[\s\S]{0,400}?id="settings-logout"/,
    'Log out lives in the footer, outside the section list');
});

test('the footer move leaves its React slot open — no portal', () => {
  // #1191 slice 6, conversion 8. The footer is rendered by the island but
  // moved out of it by _syncFooter, so the position it came from has to stay
  // open or React's picture of #settings-sidebar-col stops describing the
  // document. That seam is the dialogs' seam, reused: a comment placeholder.
  const fn = settingsJs.slice(settingsJs.indexOf('    _syncFooter() {'));
  const body = fn.slice(0, fn.indexOf('\n    },\n'));
  assert.match(body, /Settings\._footerHome\?\.lift\(\)/,
    'moving to the content column lifts the node out of its slot');
  assert.match(body, /Settings\._footerHome\.restore\(\)/,
    'moving back restores it where the comment sits');
  assert.match(body, /getElementById\('settings-sidebar-col'\)/,
    'and there is still a plain fallback for the vm harnesses, which have no seam');

  assert.match(mountTs, /createPlaceholderHome\(el, 'settings-footer-home'\)/,
    'the seam is planted by mount.ts, not imported by the classic script');
  assert.match(kitSurfaceTs, /export function createPlaceholderHome/,
    'and it is the same helper adoptKitSurface uses for home: placeholder');
  assert.doesNotMatch(kitSurfaceTs, /createPortal/);
  assert.doesNotMatch(navTsx, /createPortal/);
});

// ── app.js wiring ──────────────────────────────────────────────────────

test('the hash router handles #settings[/section]', () => {
  assert.match(appJs, /parts\[0\] === 'settings'/,
    'restoreFromHash has a settings branch');
  assert.match(appJs, /App\.navigateToSettings\(parts\[1\] \|\| null\)/,
    'the optional section segment deep-links one section');
});

test('navigateToSettings mounts the screen and routes when already mounted', () => {
  const fn = appJs.slice(appJs.indexOf('  navigateToSettings(section) {'));
  assert.ok(fn.length > 0, 'navigateToSettings exists in app.js');
  const head = fn.slice(0, 2600);
  assert.match(head, /if \(App\._inSettings && window\.Settings\?\.isOpen\?\.\(\)\) \{\s*Settings\.route\(section\);/,
    'an in-screen navigation is handed to the module, not re-mounted');
  assert.match(head, /App\._showOnlyScreen\('settings-screen'\)/,
    'reveals #settings-screen (and hides every sibling root) through the shared primitive');
  assert.match(head, /App\.setHeaderTitle\('Settings'\)/, 'sets the header title');
  assert.match(head, /App\._inSettings = true;/, 'records that we are on the screen');
  assert.match(head, /Settings\.open\(section, \{ chrome: false \}\)/,
    'hands the section to the module, holding its header write for the transition');
  assert.match(head, /Settings\.syncChrome\(\)/,
    'and applies that header write inside the transition callback');
  // #979: the reveal, the header title and the module's own chrome sync
  // all belong INSIDE the transition callback — a View Transition captures
  // the outgoing page a frame later, so anything mutated before the call
  // shows up in the snapshot of the page the user is leaving.
  const beforeTransition = head.slice(0, head.indexOf('PlatformUI.transition('));
  assert.ok(beforeTransition.length > 0, 'navigateToSettings runs a transition');
  for (const forbidden of ['setHeaderTitle', 'setBackIcon', 'classList', 'syncChrome']) {
    assert.ok(!beforeTransition.includes(forbidden),
      `no ${forbidden} before the transition — it would land in the outgoing snapshot`);
  }
  // Every sibling screen is torn down on entry. (_exitChallenges and
  // _exitTopochainSeasons dropped off this list in the leaderboard merge:
  // both screens became tabs of the Leaderboard screen, so _exitLeaderboard
  // is what tears them down now.)
  for (const sib of ['_exitLeaderboard', '_exitProfile', '_exitAdminConsole']) {
    assert.ok(head.includes(sib), `entry exits the ${sib} screen`);
  }
});

test('_exitSettings is state-only and closes the module', () => {
  const fn = appJs.slice(appJs.indexOf('  _exitSettings() {'), appJs.indexOf('  _exitSettings() {') + 600);
  assert.match(fn, /App\._inSettings = false;/);
  assert.match(fn, /Settings\.close\(\)/);
  // #979: hiding the screen here would delete the outgoing page before the
  // View Transition captured it — the incoming navigation's
  // _showOnlyScreen does it inside the transition callback instead. Same
  // for the back chevron the mobile section view borrowed.
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.ok(!body.includes('classList'),
    'no classList work — the screen is hidden by the next _showOnlyScreen');
  assert.ok(!body.includes('setBackIcon'),
    'no setBackIcon — _showOnlyScreen hands the chevron back');
});

test('every sibling-exit site tears the settings screen down too', () => {
  // The two screens are exact mirrors: everywhere the admin console is
  // torn down, the settings screen is too (and vice versa — each
  // navigate* exits the other but never itself). That pairing is what
  // stops a stale hidden screen from being left mounted.
  const adminExits = (appJs.match(/if \(App\._inAdmin\) App\._exitAdminConsole\(\);/g) || []).length;
  const settingsExits = (appJs.match(/if \(App\._inSettings\) App\._exitSettings\(\);/g) || []).length;
  // Floor lowered from 9 to 7 by the leaderboard merge: navigateToChallenges
  // and navigateToTopochainSeasons were two of the sibling sites, and both
  // screens became tabs of the Leaderboard screen. The equality below is the
  // real invariant — the floor only catches the list collapsing entirely.
  assert.ok(adminExits >= 7, `admin exit sites found (${adminExits})`);
  assert.equal(settingsExits, adminExits,
    'the settings exit is paired with the admin exit at every navigation');

  const navSettings = appJs.slice(appJs.indexOf('  navigateToSettings(section) {'));
  assert.doesNotMatch(navSettings.slice(0, 2600), /App\._exitSettings\(\)/,
    'navigateToSettings never exits itself');
  const navAdmin = appJs.slice(appJs.indexOf('  navigateToAdminConsole(section) {'));
  assert.match(navAdmin.slice(0, 2600), /if \(App\._inSettings\) App\._exitSettings\(\);/,
    'entering the admin console leaves the settings screen');

  assert.match(appJs, /else if \(App\._inSettings\) App\.navigateHome\(\);/,
    'the empty-hash branch leaves the settings screen too');
});

test('the header back button consults Settings.handleBack behind _inSettings', () => {
  const idx = appJs.indexOf("document.getElementById('back-btn').addEventListener");
  // Wide enough for every screen hook the handler chains (admin, settings,
  // browse, the dev session), the follow-the-href step and the navigateHome
  // fallthrough below them.
  const fn = appJs.slice(idx, idx + 1800);
  assert.match(fn, /if \(App\._inSettings && window\.Settings\?\.handleBack\?\.\(\)\) return;/,
    'the mobile section arrow is consumed by the module');
  assert.match(fn, /window\.location\.hash = href/,
    'a screen that named a parent goes THERE');
  assert.match(fn, /App\.navigateHome\(\);/,
    'and home is the fallback for one that named none');
});

test("Settings is reached from the chip's menu, by a real anchor", () => {
  // It was a hamburger row; #1431 retired the hamburger and parked it in the
  // Profile screen's account group; #1443 gave the shell a menu again and
  // Settings went back into it, because it has its own page and the menu's
  // rule is that everything in it does. One entrance, one hop, from anywhere.
  const panel = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(panel, /id="switcher-row-settings"[\s\S]{0,80}href="#settings"/,
    'navigation rides the anchor hash, like Challenges / Profile');
  assert.match(panel, /id="switcher-byok-dot"/, 'the BYOK indicator dot survives');
  // The row does not call Settings.open — the hash does the navigating and
  // always did. It DOES dismiss the menu it sits in, which is the one thing
  // the Profile-screen version of this row had nothing to do: a menu that
  // stays open over the screen it just sent you to is the bug.
  assert.match(panel, /AppContext\.dismissForNav\(\)/,
    'activating a row closes the menu before the hash lands');
});

// ── Two-level layout ───────────────────────────────────────────────────

test('one breakpoint constant, read through matchMedia, in step with md:', () => {
  assert.match(settingsJs, /DESKTOP_MEDIA: '\(min-width: 768px\)'/,
    'the sidebar breakpoint is declared once, as 768px (Tailwind md)');
  const isMobile = settingsJs.slice(settingsJs.indexOf('    _isMobile() {'));
  assert.match(isMobile.slice(0, 300), /matchMedia\(Settings\.DESKTOP_MEDIA\)/,
    '_isMobile reads the constant, never a hardcoded width');
  assert.match(isMobile.slice(0, 300), /catch \{ return false; \}/,
    'no matchMedia degrades to the desktop layout, not a phone layout');
  assert.match(html, /id="settings-sidebar-col" class="hidden md:block md:w-56/,
    'the sidebar still switches at md — the constant must match it');
  assert.match(html, /<div class="md:flex md:items-start md:gap-6">[\s\S]{0,400}settings-sidebar-col/,
    'the shell row still switches at md');
});

test('level state and the viewport listener exist', () => {
  assert.match(settingsJs, /_level: 1,/, 'the module tracks which level is showing');
  assert.match(settingsJs, /_pushedFromMenu: false,/,
    'and whether the current level-2 entry was pushed by a menu tap');
  assert.match(settingsJs, /_ensureMediaListener\(\)\s*\{/,
    'a viewport listener re-resolves the layout on a breakpoint crossing');
  const openFn = settingsJs.slice(settingsJs.indexOf('    open(section, opts) {'));
  assert.match(openFn.slice(0, 900), /_ensureMediaListener\(\)/,
    'the listener is bound lazily on the first open');
  assert.match(openFn.slice(0, 900), /_pushedFromMenu = false/,
    'per-mount push state resets on entry');
});

test('a bare #settings means the MENU on mobile, the default on desktop', () => {
  const openFn = settingsJs.slice(settingsJs.indexOf('    open(section, opts) {'));
  const head = openFn.slice(0, 1800);
  assert.match(head, /if \(Settings\._isMobile\(\) && !valid\)/,
    'mobile + no section segment lands on level 1');
  assert.match(head, /Settings\._level = 1;/,
    'that branch sets level 1 (never resurrects a last-visited section)');
  const writeHash = settingsJs.slice(settingsJs.indexOf('    _writeHash(key) {'));
  assert.match(writeHash.slice(0, 600),
    /key === Settings\.DEFAULT_SECTION && !Settings\._isMobile\(\)/,
    'only desktop collapses the default onto bare #settings');
  assert.match(writeHash.slice(0, 600), /history\.replaceState/,
    'section switches never push history');
  assert.match(writeHash.slice(0, 600), /location\.hash\.startsWith\('#settings'\)/,
    'and never rewrite the address while we are on another route');
});

test('handleBack pops whenever this document put something below', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    handleBack() {'));
  const head = fn.slice(0, 2000);
  assert.match(head, /if \(!Settings\._open\) return false;/,
    'a press outside the screen is never consumed');
  assert.match(head, /if \(!Settings\._isMobile\(\) \|\| Settings\._level !== 2\) return false;/,
    'desktop and the menu level fall through to navigateHome');
  // #1565: our own pushed menu entry is not the only thing that can be down
  // there. An in-app link into a section — the profile editor's
  // "Settings -> Username" — pushes one too, and back belongs on the screen
  // the viewer came from, not on a menu they never saw.
  assert.match(head,
    /if \(Settings\._pushedFromMenu \|\| Settings\._entryBelow\(\)\) \{[\s\S]{0,900}history\.back\(\)/,
    'history.back whenever there is an entry of ours below');
  assert.match(head, /history\.replaceState\(null, '', '#settings'\)/,
    'a COLD deep link REPLACES instead, so back cannot bounce forever');
});

test('"is there an entry below" is the router\'s answer, not a guess (#1565)', () => {
  // Nothing else can tell a cold deep link from an in-app one: history.length
  // counts other documents and document.referrer says nothing about a
  // fragment change. So app.js records it, in the ONE funnel both events run
  // through, and Settings reads it.
  const route = appJs.slice(appJs.indexOf('  _routeFromHash() {'));
  const body = route.slice(0, 700);
  assert.match(body, /App\._previousRoute = App\._currentRoute;/);
  assert.match(body, /if \(arriving !== App\._currentRoute\)/,
    'a traversal fires popstate AND hashchange, so the duplicate must be a no-op');
  assert.match(appJs, /App\._currentRoute = location\.hash \|\| '';/,
    'seeded with the address the document loaded at');
  assert.match(appJs, /previousRoute\(\) \{\s*return App\._previousRoute;/,
    'and published for the screens that claim the back chevron');

  const below = sliceMethod(settingsJs, '_entryBelow');
  assert.match(below, /window\.App\?\.previousRoute\?\.\(\) != null/);
  assert.match(below, /catch/,
    'a shell that cannot answer is treated as a cold deep link');
});

test('the level-2 chevron points where handleBack actually goes (#1565)', () => {
  // The href is not decorative: app.js's back-btn handler follows it when no
  // screen claims the press, and a native or middle click uses it directly.
  const up = sliceMethod(settingsJs, '_upHref');
  assert.match(up, /Settings\._pushedFromMenu \|\| !Settings\._entryBelow\(\)[\s\S]{0,80}'#settings'/,
    'the menu is the target when the menu is what is below');
  assert.match(up, /window\.App\.previousRoute\(\) \|\| undefined/,
    'otherwise the address the viewer came from; home falls back to the home href');
  const chrome = sliceMethod(settingsJs, '_syncChrome');
  assert.match(chrome, /setBackIcon\(inSection \? 'arrow' : 'home', inSection \? Settings\._upHref\(\) : undefined\)/);
});

test('a menu tap is a real hash navigation', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    _openSection(key) {'));
  assert.match(fn.slice(0, 600), /Settings\._pushedFromMenu = true;/);
  assert.match(fn.slice(0, 600), /location\.hash = target;/,
    'so the device / WebView back gesture works for free');
  assert.match(fn.slice(0, 600), /Settings\.route\(key\);/,
    'a same-value hash fires no hashchange — routed by hand');
});

test('the sidebar and the mobile menu share one grouping', () => {
  const nav = settingsJs.slice(settingsJs.indexOf('    _navView() {'));
  assert.match(nav.slice(0, 1200), /_groupedSections\(\)/);
  const menu = settingsJs.slice(settingsJs.indexOf('    _menuView() {'));
  assert.match(menu.slice(0, 1600), /_groupedSections\(\)/);
  // The row classes moved to the component with the markup; the 44px target
  // moved with them.
  assert.match(navTsx, /min-h-\[44px\]/, 'menu rows keep the 44px target');
});

test('the nav components render what the module shapes, and nothing else', () => {
  // The active row's class string is the one thing on this screen that varies
  // with state, so it stays in the module — which is also what keeps
  // settings.js loadable by the vm harnesses (see settings-mobile-push).
  const nav = settingsJs.slice(settingsJs.indexOf('    _navView() {'));
  assert.match(nav.slice(0, 1200), /bg-violet-600\/10 text-violet-700 dark:text-violet-400/,
    'the active sidebar row keeps its tint, character for character');
  assert.match(navTsx, /className=\{item\.className\}/,
    'the component renders that string rather than recomputing it');

  // A tab set on desktop, a LIST on mobile. dapp.json line 1660 selects on
  // [data-settings-nav="cli"][aria-selected="true"], so the first half is a
  // declared check, and the second half is what makes the two differ.
  assert.match(navTsx, /role="tab"/, 'the sidebar is a tab set');
  assert.match(navTsx, /aria-selected=\{item\.active \? 'true' : 'false'\}/);
  const menuFn = navTsx.slice(navTsx.indexOf('export function SettingsMobileMenu'));
  assert.doesNotMatch(menuFn, /role="tab"|aria-selected/,
    'the level-1 menu is a list of rows, not a second tab set');

  // Both hosts route through one handler; neither re-binds listeners.
  assert.equal((navTsx.match(/onClick=\{\(\) => navClick\(item\.key\)\}/g) || []).length, 2);
  assert.doesNotMatch(settingsCode, /_wireNavButtons/,
    'the per-repaint listener sweep is gone — React binds onClick');
  assert.match(settingsJs, /_navClick\(key\) \{/, 'the handler survived as a method');
});

test('the nav hosts still ship EMPTY, so the prerender is unchanged', () => {
  // The island rule's second corollary: an island's initial render must emit
  // exactly the empty markup the hand-written shell shipped, or hydration
  // console.errors and the proposal checks fail.
  assert.match(html, /id="settings-nav-desktop" aria-label="Settings sections" class="space-y-1"><\/nav>/,
    '#settings-nav-desktop prerenders empty');
  assert.match(html, /id="settings-mobile-menu-host" class="md:hidden"><\/div>/,
    '#settings-mobile-menu-host prerenders empty');
  assert.match(navStoreJs, /desktop: null/, 'both descriptors start null');
  assert.match(navStoreJs, /mobile: null/);
});

test('_syncChrome drives the header through App, not the DOM', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    _syncChrome() {'));
  const head = fn.slice(0, 1400);
  // #1036: the second argument is the anchor's href — inside a section the
  // chevron pops to whatever is below it, which _upHref resolves (#1565).
  // LEVEL 2 ONLY: the mobile drill-in's chevron is the only way up a level
  // inside this screen, while the root's arrow is gone with the other two
  // account screens' (Profile and Admin — see App.navigateToProfile).
  // `'home'` is hidden.
  assert.match(head, /App\.setBackIcon\(inSection \? 'arrow' : 'home', inSection \? Settings\._upHref\(\) : undefined\)/);
  assert.match(head, /App\.setHeaderTitle\(/,
    'setHeaderTitle mirrors document.title for the native AppBar');
  assert.doesNotMatch(head, /getElementById\('header-title'\)/,
    'never writes the header element directly');
});

// ── Late-arriving state ────────────────────────────────────────────────

test('the menu re-resolves when gate state lands after first paint', () => {
  assert.match(settingsJs, /_renderNavIfOpen\(\)\s*\{/, 'the re-resolve helper exists');
  // Bounded at the method's own closing brace rather than a character count:
  // the call sits in the last statement of refresh(), so any comment added
  // above it walked a fixed window off the end and failed for no reason.
  const refresh = settingsJs.slice(settingsJs.indexOf('    async refresh() {'));
  assert.match(refresh.slice(0, refresh.indexOf('\n    },\n')), /_renderNavIfOpen\(\)/,
    'walletLinkEnabled arrives with /api/auth/me — re-render the menu');
  const usernode = settingsJs.slice(settingsJs.indexOf('    async _renderUsernodeSection() {'));
  assert.match(usernode.slice(0, 1200), /_renderNavIfOpen\(\)/,
    'the bridge capability probe is async — re-render the menu either way');
});

test('a successful key save no longer closes the surface', () => {
  const save = settingsJs.slice(settingsJs.indexOf('    async save() {'));
  assert.doesNotMatch(save.slice(0, 2500), /setTimeout\(\(\) => this\.close\(\), 900\)/,
    'Settings is a screen — a save leaves the status visible in place');
});

test('close() tears down the two lifecycle timers', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    close() {'));
  const head = fn.slice(0, 600);
  assert.match(head, /_stopWalletPolling\(\)/);
  assert.match(head, /_clearAlertsTestCountdown\(\)/);
  assert.match(head, /Settings\._open = false;/);
  assert.doesNotMatch(head, /this\.modal/, 'there is no modal to hide');
});

// ── Other callers ──────────────────────────────────────────────────────

test('the credits banner deep-links all three ways to keep building', () => {
  // The banner used to offer BYOK alone and navigate itself. It now
  // delegates to CreditOptions, which owns the same three routes the
  // in-chat card and the Generate-proposal modal render — so the wiring
  // assertion moved with it.
  // The banner is a component since the four strips converted, so the wiring
  // moved from `_wireCreditsBanner` in dev-chat.js to a ref in
  // features/dev-chat/banners.tsx — one delegated click per mounted element,
  // which is what `CreditOptions.wire` has always bound.
  const bannersTsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'banners.tsx'), 'utf8'
  );
  const fn = bannersTsx.slice(bannersTsx.indexOf('const wireRef'));
  // #1049 added a second argument: the two hand-off routes are handled in
  // place (they start the walkthrough in this chat) rather than navigated.
  // #1348 added a third: "Change session type" opens the venue sheet here
  // too, in blocked mode — the bar is two buttons now, and that is the one
  // standing in for every venue the bar used to list.
  assert.match(fn.slice(0, 800), /CO\?\.wire\?\.\(el, \{\s*\n?\s*onFlow:/,
    'the shared module wires the banner');
  assert.match(fn.slice(0, 800), /openVenueSheet\?\.\(button, \{ blocked: true \}\)/,
    'and the venue door opens the sheet blocked, on the refusal banner');
  assert.doesNotMatch(fn.slice(0, 800), /Settings\.open\(/,
    'no direct module call any more');

  const creditOptions = read('public/js/credit-options.js');
  assert.match(creditOptions, /window\.location\.hash = hash/,
    'a real navigation, so back returns to the chat');
  for (const hash of ['#settings/api-key', '#settings/cli', '#settings/connectors']) {
    assert.ok(creditOptions.includes(`'${hash}'`), `offers ${hash}`);
  }
});

test('the "Settings → Change password" prose is a real link', () => {
  assert.match(html, /href="#settings\/password"/,
    'the account-recovery help text links to the Password section');
  // The dialog's markup is React-owned chassis since #1082 chunk E; the copy
  // and the link inside it are unchanged.
  assert.match(read('frontend/src/features/admin/index.tsx'), /href="#settings\/password"/,
    'so does the temporary-password dialog');
});

// ── Staging mock data ──────────────────────────────────────────────────

test('the CLI credentials list has staging row and empty-state fixtures', () => {
  assert.match(cliAuthJs, /function demoCliTokens\(\)/, 'demo rows are defined');
  assert.match(cliAuthJs,
    /req\.query\.demo === '1' && process\.env\.USERNODE_ENV === 'staging'/,
    'gated on staging + the explicit opt-in, exactly like llm-grants');
  assert.match(cliAuthJs, /new Set\(\['limit', 'cursor', 'demo'\]\)/,
    "the strict query allowlist admits 'demo'");
  assert.match(cliAuthJs, /staging-demo-cli-1/, 'rows are obviously fake');
  assert.match(cliAuthJs, /demo: true/, 'rows are flagged so Revoke is suppressed');
  assert.match(cliAuthJs, /\['1', 'cli-empty'\]\.includes\(req\.query\?\.demo\)/,
    'the early staging gate admits both exact read-only fixtures');
  assert.match(cliAuthJs,
    /req\.query\.demo === 'cli-empty'[\s\S]{0,180}tokens: \[\], next_cursor: null, demo: true/,
    'the empty-state fixture returns no credential rows');
  // Strictly read-only — the demo branch must not touch the DB.
  const fnStart = cliAuthJs.indexOf('function demoCliTokens()');
  const fn = cliAuthJs.slice(fnStart, fnStart + 1600);
  assert.doesNotMatch(fn, /pool\.query|INSERT|UPDATE/,
    'fabricated in memory, never written');
});

test('settings.js passes the selected CLI fixture through to the credentials list', () => {
  assert.match(settingsJs, /_cliTokensDemoValue\(\)\s*\{/,
    'the selected fixture value has one parser');
  assert.match(settingsJs, /flag === '1' \|\| flag === 'cli-empty'/,
    'only the two declared fixture values are accepted');
  assert.match(settingsJs, /_cliTokensDemo\(\)\s*\{/, 'the passthrough helper exists');
  // Scoped to _loadCliTokens, not the whole module — the point is that the
  // passthrough is on the request this function builds. The window grew
  // when the capability gate (_cliAuthAvailable — skip the fetch entirely
  // where the CLI surface is 404'd) landed above the query construction.
  const load = settingsJs.slice(settingsJs.indexOf('    async _loadCliTokens(reset) {'));
  assert.match(load.slice(0, 3000), /const demo = this\._cliTokensDemoValue\(\)/,
    'the credential fetch reads the exact selected fixture');
  assert.match(load.slice(0, 3000), /`&demo=\$\{encodeURIComponent\(demo\)\}`/,
    'the page-level fixture reaches the endpoint without string concatenation hazards');
  assert.match(settingsJs, /!token\.demo/, 'Revoke is suppressed on demo rows');
});

// ── Environment parity ─────────────────────────────────────────────────

test('the screen itself is never gated on USERNODE_ENV', () => {
  // The whole shell/routing surface must be identical in staging and prod;
  // only DATA (the read-only fixtures in cli-auth.js) may differ.
  assert.doesNotMatch(settingsJs, /USERNODE_ENV/,
    'no environment gating in the client module');
  for (const marker of ["parts[0] === 'settings'", '  navigateToSettings(section) {', '  _exitSettings() {']) {
    const i = appJs.indexOf(marker);
    assert.ok(i > -1, `${marker} exists`);
    assert.doesNotMatch(appJs.slice(i, i + 2600), /USERNODE_ENV/,
      `no environment gating around ${marker.trim()}`);
  }
});

// ── dapp.json rendered checks ──────────────────────────────────────────

test('dapp.json covers the settings screen and its deep links', () => {
  const tests = manifest.tests || [];
  const paths = tests.map((t) => t.path);
  assert.ok(paths.includes('/#settings'),
    'the screen itself is checked at its bare route');
  // #1556: 'language' is deliberately absent — it is no longer a routable
  // section for a default user, and its check asserts the FALLBACK instead.
  for (const key of ['password', 'app-ai', 'agent-files', 'cli', 'admin-preview']) {
    assert.ok(
      paths.some((p) => p.includes(`#settings/${key}`)),
      `a rendered check deep-links #settings/${key}`,
    );
  }
  const bare = tests.filter((t) => t.path === '/#settings');
  assert.ok(
    bare.some((t) => (t.expectSelector || '').includes('settings-screen')),
    'the bare-route check asserts the screen is actually visible',
  );
  // Data-dependent sections must go through their staging demo injection.
  for (const t of tests) {
    if (/#settings\/(app-ai|agent-files)/.test(t.path)) {
      assert.match(t.path, /demo=1/,
        `${t.path} needs ?demo=1 — its table is staging:private / not cloned`);
    }
    if (/#settings\/cli/.test(t.path)) {
      assert.match(t.path, /demo=(?:1|cli-empty)/,
        `${t.path} needs an explicit CLI review fixture`);
    }
  }
  // #1556: the Language deep link still has a check, but it asserts that the
  // route falls back to the default section rather than rendering a pane.
  const lang = tests.filter((t) => (t.path || '').includes('#settings/language'));
  assert.equal(lang.length, 1, 'exactly one declared check drives #settings/language');
  assert.match(lang[0].expectSelector || '',
    /data-settings-section="theme"\]:not\(\.hidden\)/,
    'the Language deep link lands on the default section, not on a Language pane');

  // #1102: and one check drives a real history traversal, which is the only
  // way to produce the duplicate popstate + hashchange pair that used to
  // repaint inside the transition's uncaptured snapshot window.
  const back = tests.filter((t) => (t.path || '').includes('shot=settings-back'));
  assert.equal(back.length, 1,
    'exactly one declared check drives the ?shot=settings-back traversal');
  assert.match(back[0].expectSelector || '', /data-settings-route="skipped"/,
    'it asserts the SECOND dispatch was skipped — the marker is the only way to observe an '
    + 'ordering that is otherwise visible for one animation frame only');
  // The DEFAULT section, whatever it is — THE UI OVERHAUL made that Theme,
  // moving it out of the hamburger where it was the drawer's first row. Read
  // from the registry rather than hard-coded, so the two cannot drift.
  assert.match(back[0].expectSelector || '',
    new RegExp(`data-settings-section="${DEFAULT_SECTION}"`),
    'and that the traversal landed back on the default section rather than the drilled-in one');
});

// ── #1102: route() is idempotent, so a duplicate dispatch cannot repaint
// inside the first dispatch's uncaptured snapshot window ─────────────────
//
// A same-document history traversal fires BOTH popstate and hashchange, so
// App.restoreFromHash() ran twice in one tick and both calls reached
// Settings.route(). The first started the push/pop transition; the second
// resolved the identical target, asked for type 'none' — which the kit runs
// SYNCHRONOUSLY — and re-rendered the level before the browser had captured
// the outgoing page. The animation then played the incoming level against a
// copy of itself: two copies on screen.

test('route() returns early when the resolved target is already showing', () => {
  const at = settingsJs.indexOf('    route(section) {');
  assert.ok(at > -1, 'settings.js still defines route(section)');
  const body = settingsJs.slice(at, settingsJs.indexOf('\n    },', at));

  // The target is resolved BEFORE anything mutates.
  assert.match(body, /const targetLevel = /, 'route() resolves the level it would end on');
  assert.match(body, /const targetSection = /, 'route() resolves the section it would end on');
  assert.match(
    body, /if \(targetLevel === Settings\._level && targetSection === Settings\._section\) \{/,
    'route() compares the resolved target against current state',
  );
  const guardAt = body.search(/if \(targetLevel === Settings\._level/);
  for (const mutation of ['Settings.setSection(', 'Settings._transition(', 'Settings._level =']) {
    const mAt = body.indexOf(mutation);
    assert.ok(mAt > -1, `route() still performs ${mutation}`);
    assert.ok(guardAt < mAt,
      `the early-out must precede ${mutation} — below it the duplicate has already repainted`);
  }
  assert.match(body.slice(guardAt, body.indexOf('Settings._markRoute(\'applied\')')), /return;/,
    'the early-out returns rather than falling through');
});

test('route() stamps what it did, so the ordering is assertable after the fact', () => {
  // A runtime-only marker, exactly like App._entryTransition's data-entered
  // (#977): the skip is invisible once the animation is over, so the check
  // needs something durable to read. Runtime-written, hence deliberately
  // absent from tests/baselines/shell-markup.json.
  assert.match(settingsJs, /_markRoute\(state\)\s*\{/, 'the stamp goes through one helper');
  assert.match(settingsJs, /setAttribute\('data-settings-route', state\)/,
    'it writes data-settings-route on the screen root');
  assert.match(settingsJs, /Settings\._markRoute\('skipped'\)/,
    'the early-out records that it skipped');
  assert.match(settingsJs, /Settings\._markRoute\('applied'\)/,
    'and the path that repaints records that it applied');
  const baseline = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'baselines', 'shell-markup.json'), 'utf8'));
  assert.ok(
    !JSON.stringify(baseline).includes('data-settings-route'),
    'data-settings-route is written at runtime and must stay out of the static markup baseline',
  );
});

test('the ?shot=settings-back driver runs a real traversal from init()', () => {
  assert.match(appJs, /_applySettingsBackShot\(\)\s*\{/, 'app.js defines the driver');
  const at = appJs.indexOf('_applySettingsBackShot() {');
  const body = appJs.slice(at, at + 1200);
  assert.match(body, /shot !== 'settings-back'/, 'it is gated on its own shot value');
  assert.match(body, /location\.hash = '#settings\/password'/,
    'it drills in through a real hash write, so the app routes exactly as a tap would');
  assert.match(body, /history\.back\(\)/,
    'and backs out through a history traversal — the dispatch pair a hash write alone cannot produce');
  assert.doesNotMatch(body, /USERNODE_ENV/,
    'pure UI state, so the driver is ungated like ?shot=menu');
  // Wired in the same run of shot drivers, after restoreFromHash() has put
  // the screen up — the traversal only means anything once #settings is open.
  const bootAt = appJs.indexOf('App.restoreFromHash();\n    // The fragment-scoped');
  assert.ok(bootAt > -1, 'app.js still runs its shot drivers after restoreFromHash()');
  const drivers = appJs.slice(bootAt, bootAt + 900);
  assert.match(drivers, /App\._applySettingsBackShot\(\);/,
    'init() wires the driver alongside the other shot drivers');
  // …and ONLY from there. #1146 made the state-PAINTING shots re-apply on
  // every fragment change; this one drives a navigation, so re-running it
  // from the handler for the hashchange it just caused would loop.
  const routed = appJs.slice(appJs.indexOf('  _routeFromHash() {'), appJs.indexOf('  restoreFromHash() {'));
  assert.doesNotMatch(routed, /_applySettingsBackShot/,
    'the per-fragment re-apply deliberately leaves the traversal driver out');
});

// ── Homeroom-app section: a failed native read is diagnosable ───────────
//
// The bridge's chrome reads resolve null on a timeout, on a native
// rejection AND on a refused privileged handshake alike, so the section
// used to collapse all of them into one dead-end line with no reason and
// no way back (issue #978). What is pinned here:
//   - the failure REASON is rendered from the bridge's out-of-band record,
//     mapped per `kind`, with the app's own message beside it;
//   - "Try again" retries in place;
//   - the blocks that DON'T need the snapshot still render, so a failed
//     read is not a dead end;
//   - the auth-status re-attempt is removed as well as added, and bounded.
// This section is the sanctioned exception to MOVE, DON'T REWRITE: the
// #settings-usernode-section node ships EMPTY in index.html and is built
// entirely by settings.js, so its controls are bound per render.

test('the usernode section renders a reason, not just "could not load"', () => {
  assert.match(settingsJs, /USERNODE_READ_ERROR_REASONS: \{/,
    'the kind -> sentence map exists');
  for (const kind of [
    'timeout', 'rejected', 'probe-inconclusive', 'no-transport', 'not-native',
  ]) {
    assert.match(settingsJs, new RegExp(`'${kind}':`),
      `${kind} has a plain-language sentence`);
  }
  assert.match(settingsJs, /USERNODE_READ_ERROR_FALLBACK: '[^']+'/,
    'an unknown/absent kind still says something concrete');
  assert.match(settingsJs, /_usernodeReadError\(\)\s*\{/,
    'the reason is read through one helper');
  assert.match(settingsJs, /NativeChrome\.lastReadError\('getSettingsState'\)/,
    'it comes from the shared bridge record, not a settings-local guess');
  assert.match(usernodeTsx, /Could not load Homeroom app settings\./,
    'the headline is unchanged so existing reports stay recognisable');
  // #1079: the box is sections/usernode.tsx now. The MODEL carries the
  // app's own message and the component renders it verbatim in a mono run.
  assert.match(settingsJs, /message: \(readError && readError\.message\) \|\| null/,
    "the app's own message reaches the view model verbatim");
  assert.match(usernodeTsx, /font-mono[^"]*">\{b\.message\}/,
    'and is rendered as a mono line, not reworded');
});

test('the failed read is recoverable in place', () => {
  // #1079: the box is sections/usernode.tsx and the retry is a named module
  // action. The PROPERTIES are unchanged: stable ids, a retry on screen, and
  // a retry that swaps in a progress line rather than blanking the section.
  assert.match(usernodeTsx, /id="settings-usernode-error"/,
    'the error box has a stable id');
  assert.match(usernodeTsx, /id: 'settings-usernode-retry', label: 'Try again'/,
    'the retry button has a stable id and is offered on the screen');
  const retry = sliceMethod(settingsJs, '_retryUsernodeRead');
  assert.match(retry, /this\._usernodeLoading = true;/,
    'a retry swaps the box for a progress line instead of blanking the section');
  assert.match(retry, /await this\._renderUsernodeSection\(\)/,
    'the retry re-runs the read');
  // The JS-built ids must NOT be in the static shell — that is what makes
  // this section the exception to the id-binding rule.
  for (const id of ['settings-usernode-error', 'settings-usernode-retry']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`),
      `#${id} is built by settings.js, never shipped in the markup`);
  }
});

test('a failed read still leaves the snapshot-independent blocks up', () => {
  // #1079: the body is a view MODEL now. The property is unchanged and easier
  // to state: the error replaces only the snapshot-dependent slice, and the
  // slices that need no snapshot are separate fields rather than being
  // sequenced after it.
  const view = sliceMethod(settingsJs, '_usernodeView');
  const body = sliceMethod(settingsJs, '_usernodeBodyView');
  assert.match(body, /if \(!s\) \{[\s\S]{0,400}kind: 'error'/,
    'the error box replaces ONLY the snapshot-dependent permissions block');

  // These need no snapshot, so they must not sit behind an `if (s)`.
  for (const field of [
    'socialPush: this._socialPushView()',
    'blockProduction: this._bpView()',
    'widgetIcons: this._widgetIconsView()',
  ]) {
    assert.ok(view.includes(field), `${field} is computed with or without a snapshot`);
  }
  assert.match(view, /actions: \[\s*\n?\s*\{ label: 'Device benchmark'/,
    'the two native screens are reachable whether or not the snapshot loaded');
  assert.match(usernodeTsx, /<Faq s=\{s\} \/>/, 'the FAQ needs no snapshot');

  // These read the snapshot, so every one of them must be guarded.
  for (const guarded of [
    's.nodeSleepEnabled', 's.facematchStrict', 's.debugMode', 's.authStatus',
  ]) {
    const at = view.indexOf(guarded);
    assert.ok(at > -1, `${guarded} still drives its control`);
    assert.match(view.slice(0, at), /s \? \{|\(s &&/,
      `${guarded} is only read behind a snapshot guard`);
  }
  assert.match(view, /const perms = \(s && s\.permissions\) \|\| \{\}/,
    'no snapshot means no permission rows, not a TypeError');
  assert.match(sliceMethod(settingsJs, '_usernodeBuildNotes'),
    /const bi = \(this\._usernodeState && this\._usernodeState\.buildInfo\) \|\| \{\}/,
    'the build line simply goes missing without a snapshot');
});

test('the native ZK identity entry is capability-gated and dispatchable', () => {
  const view = sliceMethod(settingsJs, '_usernodeView');
  assert.match(view,
    /const canOpenZkIdentity = this\._hasNativeCapability\('zkIdentityFlow'\)/,
    'the button follows the additive feature capability, not bridge version');
  assert.match(view,
    /open: canOpenZkIdentity \? \{[\s\S]*label: 'Open ZK identity'[\s\S]*action: '_openZkIdentityScreen'/,
    'supported builds publish a visible settings action');
  assert.match(usernodeTsx,
    /s\.privacy\.open \? <UnBtn btn=\{s\.privacy\.open\} \/> : null/,
    'unsupported builds render no dead control');
  assert.match(sliceMethod(settingsJs, '_openZkIdentityScreen'),
    /_openNativeScreen\('zkIdentity', 'Could not open ZK identity'\)/,
    'the action uses the allowlisted native target');
});


test('the usernode read is retried once on readiness and never leaks a listener', () => {
  assert.match(settingsJs, /_armUsernodeAuthStatusRetry\(\)\s*\{/);
  assert.match(settingsJs, /_clearUsernodeAuthStatusRetry\(\)\s*\{/);
  const arm = settingsJs.slice(
    settingsJs.indexOf('    _armUsernodeAuthStatusRetry() {'),
    settingsJs.indexOf('    _clearUsernodeAuthStatusRetry() {'),
  );
  assert.match(arm, /if \(this\._usernodeAuthStatusListener\) return;/,
    'never double-registers');
  assert.match(arm, /if \(this\._usernodeAuthRetryUsed\) return;/,
    'bounded: one re-attempt per mount, not a retry loop');
  assert.match(arm, /d\.phase !== 'ready'/,
    'it waits for a ready identity, the same signal native-chrome.js uses');
  assert.match(arm,
    /window\.addEventListener\('usernode:auth-status', listener\)/);
  const clear = settingsJs.slice(
    settingsJs.indexOf('    _clearUsernodeAuthStatusRetry() {'),
    settingsJs.indexOf('    _publishUsernode() {'),
  );
  assert.match(clear,
    /window\.removeEventListener\(\n?\s*'usernode:auth-status'/,
    'the listener is removed, following the social-push discipline');
  // Removed on a successful read, on close, and reset per mount.
  const section = settingsJs.slice(
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
    settingsJs.indexOf('    _usernodeReadError() {'),
  );
  assert.match(section, /this\._clearUsernodeAuthStatusRetry\(\);\n\s+this\._usernodeLoading = false;/,
    'a successful read stops listening');
  const close = settingsJs.slice(settingsJs.indexOf('    close() {'));
  assert.match(close.slice(0, 500), /_clearUsernodeAuthStatusRetry\(\)/,
    'leaving Settings stops listening');
  const openIdx = settingsJs.indexOf('    open(section, opts) {');
  assert.ok(openIdx >= 0, 'Settings.open(section, opts) exists');
  const open = settingsJs.slice(openIdx);
  assert.match(open.slice(0, 900), /_usernodeAuthRetryUsed = false/,
    'the one re-attempt is offered again on the next visit');
});

test('activity notifications wait for native admission and surface failures', () => {
  // #1079: the wording and the gate are the view builder's; the retry is a
  // named action. Every property below is unchanged.
  const view = sliceMethod(settingsJs, '_socialPushView');
  assert.match(view, /NativeChrome\.isSessionAdmitted\(\)/,
    'a closed handoff renders recovery instead of a stale toggle');
  assert.match(view, /NativeChrome\.recoverSessionAdmission/,
    'the notification section offers an explicit handoff retry');
  assert.match(view, /Finishing secure app sign-in/);
  assert.match(sliceMethod(settingsJs, '_retrySocialPush'),
    /NativeChrome\.recoverSessionAdmission\(\)/,
    'and the retry actually re-runs the handoff');
  assert.match(usernodeTsx, /includeErrorDetail: true/,
    'native storage and admission errors remain visible to the user');
  assert.match(usernodeUiTsx, /Could not save the setting/,
    'a failed setter says so rather than silently reverting');
});

test('only the newest usernode read attempt paints', () => {
  const section = settingsJs.slice(
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
    settingsJs.indexOf('    _usernodeReadError() {'),
  );
  assert.match(section, /const token = \+\+this\._usernodeRenderToken;/,
    'each attempt is tagged');
  assert.match(section, /if \(token !== this\._usernodeRenderToken\) return;/,
    'a stale 12s read cannot overwrite a fresher result');
});

// ── #907: the "Local coding agent" block ───────────────────────────────────

test('the local-agent block lives in Experimental and ships hidden', () => {
  // Experimental, not the CLI section: this is a preview of the same feature
  // the dev chat's "Run on" selector exposes, and a lease is not a credential
  // — revoking a token is a security action, detaching a machine is a
  // routing one, and putting them side by side would blur that.
  const experimental = html.slice(
    html.indexOf('data-settings-section="experimental"'),
    html.indexOf('data-settings-section="experimental"') + 12000
  );
  assert.match(experimental, /id="settings-local-agents-section"/);
  assert.match(experimental, /id="settings-local-agents-list"/);
  assert.match(experimental, /id="settings-local-agents-status"/);
  // Hidden by default and only revealed when the user actually has one,
  // so it costs nothing for the overwhelming majority who never run the CLI.
  assert.match(experimental, /id="settings-local-agents-section" class="hidden/);
  assert.match(experimental, /Local coding agent/);
  // The copy has to answer "what still happens on Homeroom?", because
  // "runs on your machine" otherwise reads as "Homeroom stops working".
  assert.match(experimental, /Homeroom still opens the pull request/);
});

// The label is free text typed on someone's own laptop and arrives here
// verbatim, so it must never reach an HTML string. It was hand-built with
// `document.createElement` + `textContent` for that reason; #1191 made the
// list React's, which gives the same guarantee by construction — a text child
// is escaped, and there is no template to interpolate into.
test('a machine label can never escape into markup', () => {
  const hostile = '<img src=x onerror=alert(1)> "quoted" & \'apostrophe\'';
  const html2 = renderComponent(
    'frontend/src/features/settings/local-agents-list.tsx', 'LocalAgentsListView',
    {
      phase: 'ready',
      agents: [{
        leaseId: 'lease_1',
        title: hostile,
        where: hostile,
        runtime: 'claude-code',
        lastSeenAt: '2026-03-04T10:00:00Z',
        detachable: true,
      }],
    },
  );
  assert.ok(!html2.includes('<img'), 'the tag never lands as markup');
  assert.match(html2, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html2, /&quot;quoted&quot;/);
  assert.match(html2, /&#x27;apostrophe&#x27;/);
  // …and the module has nothing left that builds DOM for this host.
  const render = settingsJs.slice(
    settingsJs.indexOf('_renderLocalAgentsSection()'),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  // Comments first — the note beside the publish names the builder it replaced.
  assert.ok(!/innerHTML/.test(code(render)), 'no innerHTML');
  assert.ok(!/createElement\(/.test(code(render)), 'and no createElement either');
  assert.match(render, /settingsLocalAgents/, 'it publishes instead');
});

test('the machine list hides itself when there is nothing to list', () => {
  const render = settingsJs.slice(
    settingsJs.indexOf('_renderLocalAgentsSection()'),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  assert.match(render, /section\.classList\.toggle\('hidden', agents\.length === 0\)/);
  // The status line starts hidden on every pass, so a stale error from a
  // previous attempt cannot survive a successful one.
  assert.match(render, /status\.classList\.add\('hidden'\);/);
  assert.match(render, /status\.classList\.remove\('hidden'/);
  // A read failure leaves `agents` empty, which hides the block rather than
  // leaving a half-painted list up.
  assert.match(render, /\} catch \{\}/);
});

test('the machine list reads the account route, not the CLI surface', () => {
  assert.match(settingsJs, /\/api\/me\/local-agents/);
  // Staging demo rows come from the same request-time ?demo=1 convention the
  // token list uses, so a staging clone can review this block at all.
  const render = settingsJs.slice(
    settingsJs.indexOf('_renderLocalAgentsSection()'),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  assert.match(render, /_cliTokensDemo\(\) \? '\?demo=1' : ''/);
  assert.match(render, /Demo data/);
});

test('detaching is confirmed, and an already-gone lease is not an error', () => {
  const detach = settingsJs.slice(
    settingsJs.indexOf('_detachLocalAgent('),
    settingsJs.indexOf('_detachLocalAgent(') + 1800
  );
  assert.match(detach, /method: 'DELETE'/);
  assert.match(detach, /204|404/);
  assert.match(detach, /confirm/i);
  // Demo rows have no Detach button at all — there is nothing to detach.
  // The rule is one field on the view model now, and the component draws the
  // button only for a row that carries it.
  const view = settingsJs.slice(
    settingsJs.indexOf('_localAgentView(agent) {'),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  assert.match(view, /detachable: !agent\.demo && !!agent\.leaseId/);
  const list = read('frontend/src/features/settings/local-agents-list.tsx');
  assert.match(list, /agent\.detachable \? \(/);
  const withoutLease = renderComponent(
    'frontend/src/features/settings/local-agents-list.tsx', 'LocalAgentsListView',
    {
      phase: 'ready',
      agents: [{
        leaseId: null, title: 'staging demo', where: 'an app',
        runtime: 'claude-code', lastSeenAt: '2026-03-04T10:00:00Z', detachable: false,
      }],
    },
  );
  assert.ok(!withoutLease.includes('Detach'), 'and a demo row draws none');
});

test('the Experimental toggle still gates the whole section', () => {
  // The block is painted from _renderExperimentalSection, so it inherits the
  // existing preview gate rather than inventing a second one.
  assert.match(settingsJs, /_renderExperimentalSection\(\)[\s\S]{0,4000}_renderLocalAgentsSection\(\)/);
});

// ── "Homeroom app: connection" (the diagnostics panel) ─────────────────

test('the usernode section is gated on being in the app, not on a capability', () => {
  const section = settingsJs.slice(
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
    settingsJs.indexOf('    _usernodeReadError() {'),
  );
  assert.ok(section, '_renderUsernodeSection exists');
  assert.match(section, /bridge\.isNative === true/,
    'the gate reads the unprivileged isNative flag');
  assert.doesNotMatch(section, /NativeChrome\.has\('getSettingsState'\)/,
    'a capability probe cannot gate the screen that diagnoses failed probes');
});

test('the connection panel renders above the failures it explains', () => {
  // #1079: the ordering is the component's now, and it is easier to read
  // there — <Connection /> is the first child of the section body.
  const panelAt = usernodeTsx.indexOf('<Connection s={s} />');
  const errorAt = usernodeTsx.indexOf('<Body s={s} />');
  assert.ok(panelAt > -1, 'the panel is rendered from the section body');
  assert.ok(errorAt > panelAt,
    'the explanation comes before the "could not load" box, not after it');
});

test('the panel has stable ids and both actions', () => {
  assert.match(usernodeTsx, /id="settings-usernode-connection"/);
  assert.match(usernodeTsx, /id: 'settings-usernode-connection-retry'/);
  assert.match(usernodeTsx, /id: 'settings-usernode-connection-copy'/);
  assert.match(usernodeTsx, /'Try again'/);
  assert.match(usernodeTsx, /'Copy diagnostics'/);
  // PlatformUI.copyText is the real API (async → boolean, never throws).
  const copy = sliceMethod(settingsJs, '_copyUsernodeDiagnostics');
  assert.match(copy, /PlatformUI\.copyText\(/);
  assert.doesNotMatch(copy, /PlatformUI\.copy\(/);
  // JS-built, so they must not appear in the static shell.
  for (const id of [
    'settings-usernode-connection',
    'settings-usernode-connection-retry',
    'settings-usernode-connection-copy',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`),
      `#${id} is built by settings.js, never shipped in the markup`);
  }
});

// ── Settings → "Homeroom app: widget icons" ────────────────────────
//
// The homescreen widget's icon path is invisible from both ends: the
// user sees "the tile is the wrong colour", and SV's side of the story
// (what the capability list said, what the registry reports, what SV
// last sent per entry) is spread across three pieces of state that no
// log line reports. This box is that state, in one place.
test('the widget-icon box reports every step of the icon decision', () => {
  // #1079: the DECISIONS are _widgetIconsView's; the heading is the
  // component's. Every property below is unchanged.
  const widget = sliceMethod(settingsJs, '_widgetIconsView');
  assert.match(usernodeTsx, /Homeroom app: widget icons/);
  for (const id of [
    'settings-widget-mechanism-row',
    'settings-widget-registry-row',
    'settings-widget-capability-row',
    'settings-widget-verdict-row',
    'settings-widget-sending-row',
  ]) {
    assert.match(widget, new RegExp(`id: '${id}'`), `${id} is rendered`);
    assert.doesNotMatch(html, new RegExp(`id="${id}"`),
      `#${id} is built by settings.js, never shipped in the markup`);
  }
  // The capability row is the one that must not lie by omission: "the
  // app couldn't say" and "the app said no" are different diagnoses with
  // different fixes, and collapsing them is the bug being diagnosed.
  assert.match(widget, /diag\.capability === true/);
  assert.match(widget, /diag\.capability === false \? 'Not advertised' : 'The app couldn’t say'/);
  // Same for the behavioural verdict and what SV is actually sending.
  assert.match(widget, /diag\.verdict === 'supported'/);
  assert.match(widget, /diag\.verdict === 'unsupported' \? 'Single face only' : 'Not confirmed yet'/);
  assert.match(widget, /diag\.resolved === true/);
  assert.match(widget, /Verdict bound to app version/);
  assert.match(widget, /Last icon check/);
  // A failed probe explains itself in the same plain language the rest
  // of this screen uses, rather than leaving a silent "couldn't say".
  assert.match(widget, /USERNODE_READ_ERROR_REASONS\[diag\.readError\.kind\]/);
  assert.match(widget, /USERNODE_READ_ERROR_FALLBACK/);
});

test('the widget-icon box is gated on being in the app, never on a capability', () => {
  const widget = sliceMethod(settingsJs, '_widgetIconsView');
  // The ONLY early return is "no snapshot at all" (not in the app, and
  // not the demo link). Hiding the box when the mechanism or the
  // capability says no would hide it in exactly the cases it exists for.
  const returns = widget.match(/^\s+(?:if \(.*\) )?return( null)?;/gm) || [];
  assert.equal(returns.length, 1, 'one early return, and it is the snapshot');
  assert.match(widget, /if \(!diag\) return null;/);
  assert.doesNotMatch(widget, /diag\.mechanism !== 'widget'\) return/);
});

test('per-entry rows separate "never sent" from "sent and not kept"', () => {
  const entries = sliceMethod(settingsJs, '_widgetIconEntryViews');
  assert.match(usernodeTsx, /id="settings-widget-icon-entries"/);
  assert.doesNotMatch(html, /id="settings-widget-icon-entries"/);
  // has_icon / has_icon_dark come from the widget; `matches` is SV's own
  // record of what it last sent. The pair is what tells a platform bug
  // apart from a shell bug — they live in different repositories.
  assert.match(entries, /entry\.hasIcon/);
  assert.match(entries, /entry\.hasIconDark/);
  assert.match(entries, /entry\.matches \? 'current' : 'stale'/);
  // Tri-state all the way down: a shell that reports neither key says
  // "—", not "no".
  assert.match(entries, /v === true \? 'yes' : \(v === false \? 'no' : '—'\)/);
  assert.match(entries, /pinned by another app/,
    'a foreign shortcut is named as such rather than shown as broken');
});

// Same reasoning as ?usernodedemo=ios and ?bridgediag=demo: everything
// this box reports comes from the iOS widget registry, so without a deep
// link the row cannot be reviewed or screenshotted from a browser.
test('?widgeticons=demo opens the box on a plain browser', () => {
  assert.match(settingsJs, /_widgetIconsDemo\(\) \{\n\s+return this\._demoParam\('widgeticons'\) === 'demo';/);
  const section = settingsJs.slice(
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
    settingsJs.indexOf('    // The row’s truth, read BEFORE it can mislead.'),
  );
  assert.match(section, /this\._widgetIconsDemo\(\) \|\|/,
    'the demo link opens the Homeroom section it lives in');
  // A fixed snapshot: no bridge call, no writes — and deliberately the
  // interesting state rather than the healthy one.
  const demo = settingsJs.slice(
    settingsJs.indexOf('    DEMO_WIDGET_ICON_DIAGNOSTICS: {'),
    settingsJs.indexOf('    _widgetIconDiagnostics() {'),
  );
  assert.match(demo, /capability: null/, 'the probe could not say');
  assert.match(demo, /verdict: 'supported'/, 'but the widget proved it stores pairs');
  assert.match(demo, /hasIconDark: false/, 'one entry is still missing its dark face');
  assert.match(demo, /matches: false/, 'and one is stale against what SV sent');
  // The re-check button performs bridge I/O, so it must not render on a
  // browser pretending to be a device.
  // #1079: the GATE is the model's, the button and the label are the
  // component's. The property — no bridge I/O from a browser pretending to be
  // a device — is unchanged.
  const widget = sliceMethod(settingsJs, '_widgetIconsView');
  assert.match(widget, /recheck: !this\._widgetIconsDemo\(\)/);
  assert.match(usernodeTsx, /w\.recheck \? <UnBtn btn=\{\{ label: 'Re-check icons'/);
  assert.match(usernodeTsx, /Staging demo: sample data/);
});

test('Try again re-probes, re-admits and re-arms readiness in one press', () => {
  const retry = settingsJs.slice(
    settingsJs.indexOf('    async _retryUsernodeConnection() {'),
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
  );
  assert.ok(retry, '_retryUsernodeConnection exists');
  assert.match(retry, /NativeChrome\._infoPromise = null/,
    'the cached probe is discarded so the retry actually re-probes');
  assert.match(retry, /NativeChrome\.getInfo\(\)/);
  assert.match(retry, /NativeChrome\.recoverSessionAdmission\(\)/);
  assert.match(retry, /SocialPush\.retryBridgeReadiness\(\)/);
  assert.match(retry, /await this\._renderUsernodeSection\(\)/);
});

test('every privileged state has a plain-language reason, remedy-ordered', () => {
  const table = settingsJs.slice(
    settingsJs.indexOf('    PRIVILEGED_STATE_REASONS: {'),
    settingsJs.indexOf('    DEMO_BRIDGE_DIAGNOSTICS: {'),
  );
  assert.ok(table, 'PRIVILEGED_STATE_REASONS exists');
  for (const state of [
    'ready', 'blocked-frame', 'unsupported', 'inconclusive', 'unattached',
    'unknown',
  ]) {
    assert.match(table, new RegExp(`'${state}':`),
      `${state} has copy, so no state renders as a blank panel`);
  }
  // The remedy order the report asked for: force-close and reopen FIRST,
  // reinstall only if that does not clear it.
  for (const key of ['blocked-frame', 'unattached']) {
    const at = table.indexOf(`'${key}':`);
    const next = table.indexOf("':", table.indexOf('\n', at) + 1);
    const copy = table.slice(at, next > at ? next + 200 : table.length);
    const closeAt = copy.search(/[Ff]orce-close/);
    const reinstallAt = copy.search(/reinstall/i);
    assert.ok(closeAt > -1, `${key} tells the user to force-close and reopen`);
    assert.ok(reinstallAt > closeAt,
      `${key} offers reinstalling only after the cheaper remedy`);
  }
});

test('the read error vocabulary covers a refused privileged bridge', () => {
  const reasons = settingsJs.slice(
    settingsJs.indexOf('    USERNODE_READ_ERROR_REASONS: {'),
    settingsJs.indexOf('    USERNODE_READ_ERROR_FALLBACK:'),
  );
  assert.match(reasons, /'privileged-unavailable':/,
    'the bridge kind added this turn has copy on the consumer side');
});

test('a refused bridge changes what the dependent messages say', () => {
  assert.match(settingsJs, /_nativeActionMessage\(err, fallback\) \{/);
  const helper = settingsJs.slice(
    settingsJs.indexOf('    _nativeActionMessage(err, fallback) {'),
  ).slice(0, 500);
  assert.match(helper, /err\.usernodePrivileged === true/,
    'it keys off the bridge tag, not English pattern-matching');
  // Every user-facing failure path that can be caused by a refused bridge.
  // #1079: the row/button/toggle trio hand-copied this wrapper three times;
  // sections/usernode-ui.tsx's `useAction` is the single copy, and it routes
  // through the SAME helper by name across the seam.
  assert.match(usernodeUiTsx, /settings\(\)\?\._nativeActionMessage\?\.\(err, fallback\)/,
    'the shared control wrapper routes through the helper');
  for (const fallback of ['Could not save the setting', 'Action failed']) {
    assert.ok(usernodeUiTsx.includes(fallback), `${fallback} is a fallback message`);
  }
  assert.ok(settingsJs.includes('this._nativeActionMessage(err, failMsg)'),
    'the native-screen opener still routes through the helper');
});

test('the diagnostics text carries no token and no user data', () => {
  const text = settingsJs.slice(
    settingsJs.indexOf('    _bridgeDiagnosticsText(diag) {'),
    settingsJs.indexOf('    async _retryUsernodeConnection() {'),
  );
  assert.ok(text, '_bridgeDiagnosticsText exists');
  for (const banned of [
    'privilegedCapability', 'App.user', 'token', 'cookie', 'localStorage',
  ]) {
    assert.ok(!text.includes(banned),
      `the copyable report must never include ${banned}`);
  }
  assert.match(text, /SocialPush\.readinessState\(\)/,
    'the readiness budget is part of the report');
  assert.match(text, /NativeChrome\.lastSessionFailure\(\)/,
    'the last admission failure is part of the report');
});

// Read-only staging/screenshot hook. It must be incapable of touching a real
// bridge, a real session, or any state at all.
test('the bridgediag demo hook is read-only and reads the HASH query', () => {
  const flag = settingsJs.slice(
    settingsJs.indexOf('    _bridgeDiagDemo() {'),
    settingsJs.indexOf('    _bridgeDiagnostics() {'),
  );
  assert.ok(flag, '_bridgeDiagDemo exists');
  // The self-app is hash-routed: #settings?bridgediag=demo puts the query
  // inside the fragment, not in location.search.
  assert.match(flag, /window\.location\.hash/,
    'the fragment query is where a hash-routed deep link puts it');
  assert.match(flag, /window\.location\.search/,
    'the ordinary query string is accepted too');
  assert.match(flag, /'bridgediag'\) === 'demo'/);

  // #1079: the panel's `demo` bit is the model's and the label is the
  // component's — a demo snapshot still says so on screen.
  assert.match(sliceMethod(settingsJs, '_usernodeConnectionView'),
    /demo: !!this\._bridgeDiagDemo\(\)/);
  assert.match(usernodeTsx, /c\.demo \? <UnP note=\{\{ text: 'Staging demo: sample data'/,
    'the demo snapshot is labelled as fake on screen');
  // Read-only hook: the buttons render so the screenshot shows the real
  // panel, but they must not touch a bridge or a session.
  assert.match(sliceMethod(settingsJs, '_usernodeConnectionView'),
    /retryDisabled: !!this\._bridgeDiagDemo\(\)/,
    'the demo may not drive the real bridge');

  const snapshot = settingsJs.slice(
    settingsJs.indexOf('    DEMO_BRIDGE_DIAGNOSTICS: {'),
    settingsJs.indexOf('    _bridgeDiagDemo() {'),
  );
  assert.match(snapshot, /Staging demo/,
    'the synthetic values say so in the data itself');
  assert.match(snapshot, /invalid/,
    'the demo origin is a reserved non-resolvable name');
});

test('the demo deep link is a declared test path', () => {
  const paths = JSON.stringify(manifest.tests || []);
  assert.ok(paths.includes('bridgediag=demo'),
    'the screenshot state added this turn is exercised by dapp.json');
});

// ── Wallet recovery: a Settings button, not a pop-up ──────────────────
//
// The "Connect your existing wallet" dialog (features/dialogs/
// wallet-recovery.tsx) used to open ITSELF: native-chrome.js dispatched
// `usernode:wallet-recovery-required` whenever admission failed with
// `native_session_wallet_pool_exhausted`, and the dialog also re-opened on
// mount off lastSessionFailure(). Admission is retried on every online /
// pageshow / visibilitychange, so the modal kept coming back over what is a
// minor feature. It is offered from the connection panel now, and only there.

const walletRecoveryTsx = read('frontend/src/features/dialogs/wallet-recovery.tsx');
const nativeChromeJs = read('public/js/native-chrome.js');

test('the connection panel offers wallet recovery off the recorded failure', () => {
  const view = sliceMethod(settingsJs, '_usernodeConnectionView');
  assert.match(view, /walletRecovery: this\._walletRecoveryAvailable\(\) \?/,
    'the button is a slice of the connection model');
  assert.match(view, /id: 'settings-usernode-connect-wallet'/);
  assert.match(view, /label: 'Connect existing wallet'/);
  assert.match(view, /action: '_openWalletRecovery'/);

  const available = sliceMethod(settingsJs, '_walletRecoveryAvailable');
  assert.match(available, /nc\.isSessionAdmitted\(\)/,
    'an admitted session has nothing to recover');
  assert.match(available, /nc\.lastSessionFailure\(\)/,
    'the recorded failure is the source of truth');
  assert.match(available, /failure\.code !== this\.WALLET_POOL_EXHAUSTED/);
  assert.ok(settingsJs.includes(
    "WALLET_POOL_EXHAUSTED: 'native_session_wallet_pool_exhausted'"));
  assert.match(available, /dialogs\.walletRecovery/,
    'no button without a dialog to open');

  const open = sliceMethod(settingsJs, '_openWalletRecovery');
  assert.match(open, /dialog\.open\(\{ userId \}\)/,
    'the press opens the React dialog by its published controller');
  assert.match(open, /_walletRecoveryDemo\(\)/,
    'the demo snapshot must never open a real recovery');

  // Admission flipping (the dialog succeeding, a sign-out) repaints the
  // panel without a navigation.
  assert.match(sliceMethod(settingsJs, 'init'),
    /addEventListener\('usernode:native-session-admission',\s*\(\) => this\._publishUsernode\(\)\)/);

  assert.match(usernodeStoreTs, /walletRecovery: UnAction \| null/);
  assert.match(usernodeTsx, /id="settings-usernode-wallet-recovery"/);
  assert.match(usernodeTsx, /<UnBtn btn=\{c\.walletRecovery\} \/>/);
  // JS-built, so it must not appear in the static shell.
  for (const id of ['settings-usernode-wallet-recovery', 'settings-usernode-connect-wallet']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`),
      `#${id} is built from the model, never shipped in the markup`);
  }
});

test('nothing opens the wallet recovery dialog on its own', () => {
  assert.ok(!nativeChromeJs.includes('offerWalletRecovery'),
    'native-chrome.js no longer announces pool exhaustion');
  assert.ok(!nativeChromeJs.includes("'usernode:wallet-recovery-required'"),
    'the auto-open event is gone from the dispatcher');
  assert.ok(!walletRecoveryTsx.includes("addEventListener('usernode:wallet-recovery-required'"),
    'the dialog no longer listens for it');
  assert.ok(!walletRecoveryTsx.includes('lastSessionFailure?.()'),
    'the dialog no longer re-opens itself on mount off the recorded failure');
  assert.doesNotMatch(walletRecoveryTsx, /dialog\.open\(/,
    'the dialog never calls its own open(); only the Settings button does');
  // The one listener left is the CLOSE: a realm close mid-form.
  assert.ok(walletRecoveryTsx.includes("addEventListener('sv:native-realm-close'"));
});

test('the wallet-recovery demo deep link is read-only and declared', () => {
  const flag = sliceMethod(settingsJs, '_walletRecoveryDemo');
  assert.match(flag, /'bridgediag'\) === 'wallet'/);
  assert.match(sliceMethod(settingsJs, '_bridgeDiagnostics'),
    /_walletRecoveryDemo\(\)\) return this\.DEMO_BRIDGE_DIAGNOSTICS_WALLET/);
  const section = sliceMethod(settingsJs, '_renderUsernodeSection');
  assert.match(section, /this\._walletRecoveryDemo\(\)/,
    'the demo link gates the section open in a browser, like bridgediag=demo');
  const view = sliceMethod(settingsJs, '_usernodeConnectionView');
  assert.match(view, /retryDisabled: !!this\._bridgeDiagDemo\(\) \|\| !!this\._walletRecoveryDemo\(\)/,
    'the demo may not drive the real bridge');
  assert.match(view, /disabled: demo,/,
    'nor open a real recovery');
  const snapshot = settingsJs.slice(
    settingsJs.indexOf('    DEMO_BRIDGE_DIAGNOSTICS_WALLET: {'),
    settingsJs.indexOf('    _bridgeDiagnostics() {'),
  );
  assert.match(snapshot, /Staging demo/, 'the synthetic values say so in the data itself');
  assert.match(snapshot, /invalid/, 'the demo origin is a reserved non-resolvable name');
  const paths = JSON.stringify(manifest.tests || []);
  assert.ok(paths.includes('bridgediag=wallet'),
    'the screenshot state is exercised by dapp.json');
});

// ── Protocol-2 sign-out boundary ────────────────────────────────────────

test('sign-out closes once, then uses terminal protocol 2 or web navigation',
  () => {
  const logout = settingsJs.slice(
    settingsJs.indexOf('    async logout() {'),
    settingsJs.indexOf('    _clearSwApiCache() {'),
  );
  const closeAt = logout.indexOf('NativeChrome.prepareWebLogout()');
  const firstAwait = logout.indexOf('await ');
  const fetchAt = logout.indexOf("'/api/auth/logout'");
  assert.ok(closeAt > -1 && closeAt < firstAwait,
    'the native realm closes synchronously before the first await');
  assert.ok(fetchAt > firstAwait,
    'web-session deletion follows the closed native boundary');
  assert.match(logout, /if \(preflight\.nativeTerminal\)/);
  assert.match(logout, /return NativeChrome\.commitNativeLogout\(\)/);
  // #1524 turned the web path's `location.href = '/'` into a REPLACE onto the
  // landing page, on both branches: an entry pushed by an assignment lets Back
  // restore the signed-in document straight out of the BFCache. Assert the
  // constant too, so the destination cannot drift off the landing page while
  // the navigation still reads correct.
  assert.match(settingsJs, /const LANDING_URL = '\/';/);
  assert.match(logout, /window\.location\.replace\(LANDING_URL\)/);
  assert.doesNotMatch(logout, /window\.location\.(href|assign)\b/,
    'a pushed entry would let Back restore the signed-in document (#1524)');
  assert.doesNotMatch(settingsJs,
    /_confirmDegradedSignOut|_bestEffortNativeLogout|NATIVE_SIGNOUT_NOTICE_KEY/,
    'legacy split/fallback logout machinery is removed, not maintained');
});


// ── The CLI credential rows (#1191) ───────────────────────────────────
//
// `#cli-tokens-list` was built by `document.createElement` in
// `Settings._renderCliTokens`; it is features/settings/cli-tokens-list.tsx's
// now, driven by what the module publishes. The rules that were only visible
// in that builder get executed coverage here rather than a source grep,
// because every one of them is a branch that renders differently.


const CLI_LIST = 'frontend/src/features/settings/cli-tokens-list.tsx';
const CLI_GUIDE = 'frontend/src/features/settings/cli-setup-guide.tsx';
const cliRows = (state) => renderComponent(CLI_LIST, 'CliTokensListView', state);

test('the credential list renders its three host states', () => {
  // `idle` is the PRERENDER state and has to draw nothing at all: the shipped
  // `<div id="cli-tokens-list">` is empty, and a first render that drew the
  // empty line would mismatch on hydration — a console error on #settings, and
  // a console error on any route fails proposal checks.
  assert.equal(cliRows({ phase: 'idle', tokens: [] }), '');
  assert.equal(shellMarkup().includes('<div id="cli-tokens-list" class="space-y-2"></div>'),
    true, 'and the prerendered document agrees');
  // Loading is the bare text node the module used to write with textContent.
  assert.match(cliRows({ phase: 'loading', tokens: [] }), /Loading credentials…/);
  // The completed empty state remains credential-specific; #1609's setup
  // guide is always-visible section markup instead of a list phase.
  const empty = cliRows({ phase: 'ready', tokens: [] });
  assert.match(empty, /No CLI credentials\./);
});

test('the local-agent setup guide is always-visible section markup', () => {
  const guide = renderComponent(CLI_GUIDE, 'CliSetupGuide');
  assert.match(guide, /Set up a local coding agent/);
  assert.match(guide, /git clone https:\/\/github\.com\/Usernode-Labs\/social-vibecoding\.git/);
  assert.match(guide, /cd social-vibecoding/);
  assert.match(guide, /<code>codex<\/code>/);
  assert.match(guide, /<code>claude<\/code>/);
  assert.match(guide,
    /Create a proposal for &lt;app name&gt; that &lt;describe the change you want&gt;\./);
  assert.match(guide, /authorize access on a Homeroom web page/);
  assert.equal((guide.match(/>Copy<\/button>/g) || []).length, 4,
    'repository setup, each alternative agent, and the prompt copy separately');
  const copyLabels = guide.match(/aria-label="Copy [^"]+"/g) || [];
  assert.equal(copyLabels.length, 4);
  assert.equal(new Set(copyLabels).size, 4, 'every Copy control has a distinct accessible name');
  assert.equal((guide.match(/items-stretch overflow-hidden rounded-md border/g) || []).length, 4,
    'each command and its Copy control share one clipped, bordered field');
  assert.equal((guide.match(/border-l border-zinc-200/g) || []).length, 4,
    'each integrated Copy control is separated from its code by one divider');
  const source = read(CLI_GUIDE);
  assert.match(source, /PlatformUI/);
  assert.match(source, /copyText\?\.\(value\)/,
    'the shared helper keeps the clipboard fallback used elsewhere in the shell');
  assert.match(source, /ok \? 'Copied' : 'Copy failed'/,
    'a rejected copy never claims success');
  const shell = shellMarkup();
  assert.match(shell, /id="cli-setup-guide"/,
    'the SSG output contains the guide before capability detection or credential loading');
  const load = sliceMethod(settingsJs, '_loadCliTokens');
  assert.doesNotMatch(load, /section\.classList\.add\('hidden'\)/,
    'an unavailable credential API never hides the setup guide with its parent section');
});

test('only a live, non-demo credential offers Revoke', () => {
  const rows = [
    { id: 'tok_1', hint: 'sv_live_…abcd', detail: 'valid · created Jan 1', revocable: true },
    // Staging ?demo=1 rows are fabricated server-side and have nothing to
    // revoke — the server flags them and the view model turns that into
    // `revocable: false`, so a button is never drawn for one.
    { id: null, hint: 'staging-demo-cli-1', detail: 'valid · created Jan 1', revocable: false },
    // An expired or already-revoked credential is the same: nothing to undo.
    { id: 'tok_3', hint: 'sv_live_…efgh', detail: 'revoked · created Jan 1', revocable: false },
  ];
  const html2 = cliRows({ phase: 'ready', tokens: rows });
  assert.equal((html2.match(/>Revoke</g) || []).length, 1, 'exactly one button');
  assert.match(html2, /sv_live_…abcd/);
  assert.match(html2, /staging-demo-cli-1/);
  // The hint is a monospace line and the metadata a muted one, as the two
  // `document.createElement` nodes were.
  assert.match(html2, /class="text-sm font-mono[^"]*">sv_live_…abcd</);
  assert.match(html2, /class="text-xs text-zinc-500[^"]*">valid · created Jan 1</);
});

test('settings.js publishes the rows rather than building them', () => {
  const render = settingsJs.slice(
    settingsJs.indexOf('    _renderCliTokens() {'),
    settingsJs.indexOf('    async _revokeCliToken(id, button) {'),
  );
  assert.ok(render.length > 200, 'located the renderer');
  // Comments first — this one names the builder it replaced.
  assert.doesNotMatch(code(render), /createElement|appendChild/,
    'no DOM building is left in the module');
  assert.match(render, /revocable: token\.status === 'valid'\s*\n?\s*&& typeof token\.id === 'string' && !token\.demo/,
    'and the demo/expired rule is decided where the payload is');
  // The two SIBLINGS of the host stay the module's: the Load-more button
  // follows the keyset cursor and the status line has three writers.
  assert.match(render, /more\.classList\.toggle\('hidden', !this\._cliTokenCursor\)/);
  assert.match(render, /status\.textContent = 'Demo data/);
});

// ── App AI permissions rows (#1957) ───────────────────────────────────
//
// `#llm-grants-list` is features/settings/grants-list.tsx's, driven by what
// `Settings._renderLlmGrants` publishes. A revoked row used to be the badge
// and nothing else: the only way back was the app's own consent dialog, which
// an app that never asks again never opens. Re-enable is that way back, and
// the branch renders differently, so it gets executed coverage like the CLI
// rows above rather than a source grep.

const GRANTS_LIST = 'frontend/src/features/settings/grants-list.tsx';
const grantRows = (state) => renderComponent(GRANTS_LIST, 'GrantsListView', state);
const grantView = (over) => ({
  appId: 11, appName: 'Demo App', appSlug: 'demo-app', revoked: false,
  spent: '0.37', cap: '1.00', capValue: '1.00', capCents: 100,
  showByok: false, allowByok: false, ...over,
});

test('the permissions list renders its host states, and idle draws nothing', () => {
  // `idle` is the PRERENDER state: the shipped host is an empty div, and a
  // first render that drew a line would mismatch on hydration.
  assert.equal(grantRows({ phase: 'idle', grants: [] }), '');
  assert.equal(shellMarkup().includes('<div id="llm-grants-list" class="space-y-2"></div>'),
    true, 'and the prerendered document agrees');
  assert.match(grantRows({ phase: 'loading', grants: [] }), /Loading…/);
  assert.match(grantRows({ phase: 'error', grants: [] }), /Failed to load app permissions\./);
  assert.match(grantRows({ phase: 'ready', grants: [] }), /No apps have asked to use AI yet\./);
});

test('a revoked app permission offers Re-enable; an active one offers Revoke (#1957)', () => {
  const html2 = grantRows({
    phase: 'ready',
    grants: [
      grantView(),
      grantView({
        appId: 12, appName: 'Quiet App', appSlug: 'quiet-app', revoked: true,
        cap: '2.50', capValue: '2.50', capCents: 250, allowByok: true,
      }),
    ],
  });
  assert.equal((html2.match(/>Revoke</g) || []).length, 1, 'exactly one Revoke, on the active row');
  assert.equal((html2.match(/>Re-enable</g) || []).length, 1, 'exactly one Re-enable, on the revoked row');
  assert.match(html2, /data-role="re-enable"/,
    'the control is addressable, which is what the declared #settings/app-ai check selects on');
  // The copy beside it names what comes back, so the click is an informed one.
  assert.match(html2, /Re-enabling restores its \$2\.50 daily cap\./);
  // The revoked row keeps its muted badge — Re-enable sits beside it, not in
  // place of it — and grows no cap editor or BYOK toggle: those are the
  // ACTIVE row's controls and take over once the grant is back.
  assert.match(html2, />Revoked</);
  assert.equal((html2.match(/data-role="cap"/g) || []).length, 1, 'one cap editor, on the active row');
  assert.equal((html2.match(/data-role="byok"/g) || []).length, 0, 'no BYOK toggle without a key on file');
  // The language's compact accent action, not a bespoke box.
  assert.match(html2, /data-role="re-enable" class="shrink-0 rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 font-medium text-white transition-colors"/);
});

test('Re-enable re-grants by slug with the cap and BYOK choice the row carries (#1957)', () => {
  const view = sliceMethod(settingsJs, '_grantView');
  assert.match(view, /appSlug: String\(g\.appSlug \?\? ''\)/,
    'the view carries the slug the re-grant endpoint is keyed on');
  assert.match(view, /capCents: Number\(g\.dailyCapCents\) \|\| 0/,
    'and the previous cap, in the cents the endpoint takes');
  const handler = code(sliceMethod(settingsJs, '_onGrantReenable'));
  assert.match(handler, /fetch\('\/api\/me\/llm-grants', \{\s*method: 'POST'/,
    "the consent dialog's own upsert — a PATCH on the revoked id would not re-activate it");
  assert.match(handler, /appSlug: grant\.appSlug, allowByok: !!grant\.allowByok/,
    'the BYOK consent the user gave before is restored, never widened');
  assert.match(handler, /dailyCapCents: grant\.capCents/, 'the previous cap is what comes back');
  assert.match(handler, /r\.status === 400 && !j\.code/,
    'a cap the allowance no longer covers falls back to the default cap instead of stranding the row');
  assert.match(handler, /this\._isDemoGrant\(grant\.appId\)/, 'staging demo rows never reach the API');
  assert.match(handler, /this\._renderLlmGrants\(\)/, 'success re-renders, so the row comes back active');
  assert.doesNotMatch(handler, /ConfirmModal/, 're-enabling is not destructive and asks nothing twice');
});


// ── The connector cards (#1191) ───────────────────────────────────────

const CONNECTORS_LIST = 'frontend/src/features/settings/connectors-list.tsx';
const connectorRows = (state) => renderComponent(CONNECTORS_LIST, 'ConnectorsListView', state);

test('the connections list renders its three host states', () => {
  assert.equal(connectorRows({ phase: 'idle', connectors: [] }), '');
  assert.equal(
    shellMarkup().includes('<div id="connectors-list" class="space-y-2"></div>'),
    true, 'and the prerendered document agrees');
  assert.match(connectorRows({ phase: 'loading', connectors: [] }), /Loading connections…/);
  assert.match(connectorRows({ phase: 'ready', connectors: [] }),
    /No chat products connected yet\./);
});

test('every connection is disconnectable, and names itself', () => {
  const html2 = connectorRows({
    phase: 'ready',
    connectors: [
      { id: '1', title: 'Claude', detail: 'connected 1 Jan · last used 2 Jan' },
      { id: '2', title: 'Connected client', detail: 'connected 1 Jan · never used' },
    ],
  });
  assert.equal((html2.match(/>Disconnect</g) || []).length, 2,
    'unlike a credential, a connection is always revocable');
  assert.match(html2, />Claude</);
  // The fallback title, for a client that registered without a name.
  assert.match(html2, />Connected client</);
  assert.match(html2, /never used/);
});

test('settings.js publishes the connector cards rather than building them', () => {
  const render = settingsJs.slice(
    settingsJs.indexOf('    _renderConnectors() {'),
    settingsJs.indexOf('    async _disconnectConnector(id, button) {'),
  );
  assert.ok(render.length > 200, 'located the renderer');
  assert.doesNotMatch(code(render), /createElement|appendChild/,
    'no DOM building is left in the module');
  // The two siblings it still owns, and must keep calling: the "stop the
  // prompts" prose blocks and the read-only tip status both key off which
  // client FAMILIES are connected, which is not a property of any one card.
  assert.match(render, /this\._renderConnectorCases\(connectors\)/);
  assert.match(render, /this\._renderConnectorHint\(connectors\)/);
});


// ── The social-account block (#1191) ──────────────────────────────────
//
// `#github-link-body` was ~330 lines of `document.createElement` in
// settings.js — a tier card, a row per provider with five mutually-exclusive
// states and two actions, an audit note, a stranded-attempt note and an
// admin diagnostics panel. The module decides all of it; the markup is
// features/settings/social-identity.tsx's.
//
// These render the component against each shape, because every one of them is
// a different sentence to a user about how much they may spend and why.

const SOCIAL = 'frontend/src/features/settings/social-identity.tsx';
const socialHtml = (state) => renderComponent(SOCIAL, 'SocialIdentityView', state);
const socialBase = { phase: 'ready', message: null, tier: null, providers: [] };

test('the social block renders its four host states', () => {
  assert.equal(socialHtml({ ...socialBase, phase: 'idle' }), '');
  assert.equal(
    shellMarkup().includes('<div id="github-link-body" class="space-y-2"></div>'),
    true, 'and the prerendered document agrees');
  assert.match(socialHtml({ ...socialBase, phase: 'loading', message: 'Loading…' }), /Loading…/);
  assert.match(
    socialHtml({ ...socialBase, phase: 'error', message: 'Could not load social accounts. Try again shortly.' }),
    /Could not load social accounts/);
});

test('the tier card carries its tone as well as its wording', () => {
  const locked = socialHtml({ ...socialBase, tier: { tone: 'warn', title: 'Layer 1 locked · $0/day', detail: 'Connect either.' } });
  assert.match(locked, /border-amber-300/, 'a locked tier is amber');
  assert.match(locked, /Layer 1 locked · \$0\/day/);
  const open = socialHtml({ ...socialBase, tier: { tone: 'ok', title: 'Layer 1 unlocked · $10.00/day', detail: 'Verified.' } });
  assert.match(open, /border-emerald-300/, 'an unlocked one is emerald');
  // The three neutral states (unavailable, legacy policy, admin override)
  // share the plain card — they are statements of fact, not outcomes.
  const plain = socialHtml({ ...socialBase, tier: { tone: 'plain', title: 'Administrator-set allowance: $25.00/day', detail: 'Override.' } });
  assert.doesNotMatch(plain, /border-amber-300|border-emerald-300/);
});

test('a demo Connect control is inert but present, and matches the live one', () => {
  const row = {
    provider: 'github',
    name: 'GitHub',
    heading: 'GitHub',
    state: { tone: 'muted', text: 'Not connected.' },
    linkedAt: null,
    noToken: null,
    connect: { label: 'Connect GitHub', href: '/api/me/social-identities/github/connect' },
    unlink: null,
    strandedNote: null,
    diagnostics: null,
  };
  const live = socialHtml({ ...socialBase, providers: [row] });
  assert.match(live, /<a href="\/api\/me\/social-identities\/github\/connect"/,
    'the real control is an ANCHOR — the OAuth flow is a top-level navigation');
  // The ?demo= twin must not navigate out of the fixture, so it is a disabled
  // button — and it has to LOOK the same, which one shared constant is what
  // guarantees (see the file's header and the primitive allow-list entry).
  const demo = socialHtml({
    ...socialBase,
    providers: [{ ...row, connect: { label: 'Connect GitHub', href: null } }],
  });
  assert.match(demo, /<button type="button" disabled/);
  const surface = 'rounded-md bg-violet-600 px-2 py-1 text-xs font-medium text-white';
  assert.ok(live.includes(surface) && demo.includes(surface), 'one surface, both spellings');
});

test('unfinished social connections describe the symptom without diagnosing the callback (#1543)', () => {
  const view = new Function(`return ({${sliceMethod(settingsJs, '_socialIdentityRowView')}})`)();
  for (const provider of ['github', 'x']) {
    const row = view._socialIdentityRowView(provider, {
      available: true, linked: false, pendingAttemptAt: '2026-09-07T10:00:00Z',
    }, {}, false);
    assert.match(row.strandedNote, /connection attempt didn't complete/);
    assert.match(row.strandedNote, /Try Connect again/);
    assert.match(row.strandedNote, /browser did not reach the sign-in page/);
    assert.doesNotMatch(row.strandedNote, /callback address isn't registered/);
    assert.equal(view._socialIdentityRowView(provider, { available: true }, {}, false).strandedNote, null);
  }
});

test('the reviewable claims travel with the row that makes them', () => {
  const html2 = socialHtml({
    ...socialBase,
    providers: [{
      provider: 'github',
      name: 'GitHub',
      heading: 'GitHub · @octo',
      state: { tone: 'emerald', text: 'Ownership verified · counts toward the single $10/day social tier.' },
      linkedAt: 'linked 1 Jan',
      noToken: 'Homeroom holds no GitHub access token for your account.',
      connect: null,
      unlink: { disabled: false },
      strandedNote: 'Your last GitHub connection attempt didn’t complete.',
      diagnostics: null,
    }],
  });
  assert.match(html2, /id="github-link-no-token"/, 'the no-token claim keeps its id');
  assert.match(html2, /id="github-link-audit-note"[\s\S]*?github\.com\/settings\/applications/,
    'and the audit link beside it makes the claim checkable');
  assert.match(html2, /target="_blank" rel="noopener noreferrer"/,
    'top-level, because the shell is framed and github.com is not frameable');
  assert.match(html2, /id="github-link-pending-note"/, 'the stranded-attempt note keeps its id');
  assert.match(html2, />Disconnect</);
});
