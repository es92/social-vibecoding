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

const html = read('public/index.html');
const appJs = read('public/js/app.js');
const settingsJs = read('public/js/settings.js');
const devChatJs = read('public/js/dev-chat.js');
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
    "'settings-modal' is out of platform-ui's STATIC_MODAL_IDS");
  assert.match(platformUiJs, /'app-secrets-modal'/,
    'the other static modals still register');
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
  // (#llm-grants-list, #cli-tokens-list, #agent-files-*-list) exactly as
  // they did in the modal — those are built by settings.js and carry no
  // init()-bound listeners. What must never happen is a write that
  // replaces a WRAPPER or the container holding them, which would detach
  // every id-bound control at once.
  for (const forbidden of ['settings-section-content', 'settings-screen', 'settings-root']) {
    assert.doesNotMatch(
      settingsJs,
      new RegExp(`getElementById\\('${forbidden}'\\)[^\\n]*\\.innerHTML`),
      `#${forbidden} is never innerHTML-written`,
    );
  }
  assert.doesNotMatch(settingsJs, /data-settings-section[^\n]*innerHTML/,
    'no wrapper is ever rebuilt');

  const renderNav = settingsJs.slice(settingsJs.indexOf('    _renderNav() {'));
  assert.match(renderNav.slice(0, 900), /getElementById\('settings-nav-desktop'\)/,
    '_renderNav paints the desktop sidebar');
  assert.match(renderNav.slice(0, 900), /getElementById\('settings-mobile-menu-host'\)/,
    '_renderNav paints the mobile menu host');
  // The section container is only ever class-toggled.
  const renderContent = settingsJs.slice(settingsJs.indexOf('    _renderContent() {'));
  assert.match(renderContent.slice(0, 900), /classList\.toggle\('hidden'/,
    '_renderContent toggles hidden on the wrappers');
  assert.doesNotMatch(renderContent.slice(0, 900), /innerHTML/,
    '_renderContent never rebuilds a section');
});

test('the log-out footer is MOVED between columns, never rebuilt', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    _syncFooter() {'));
  assert.match(fn.slice(0, 700), /appendChild\(footer\)/,
    'the real footer node is re-parented');
  assert.doesNotMatch(fn.slice(0, 700), /innerHTML|createElement/,
    'no rebuild — #settings-logout keeps the handler bound in init()');
  assert.match(html, /id="settings-footer"[\s\S]{0,400}?id="settings-logout"/,
    'Log out lives in the footer, outside the section list');
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
  // browse) plus the navigateHome fallthrough below them.
  const fn = appJs.slice(idx, idx + 800);
  assert.match(fn, /if \(App\._inSettings && window\.Settings\?\.handleBack\?\.\(\)\) return;/,
    'the mobile section arrow is consumed by the module');
  assert.match(fn, /App\.navigateHome\(\);/, 'and everything else still goes home');
});

test('the drawer row is a real anchor to #settings', () => {
  assert.match(html, /<a id="drawer-row-settings" href="#settings"/,
    'navigation rides the anchor hash, like Challenges / Profile');
  assert.match(html, /id="drawer-byok-dot"/, 'the BYOK indicator dot survives');
  const init = appJs.slice(appJs.indexOf("getElementById('drawer-row-settings')"));
  assert.match(init.slice(0, 250), /App\.HeaderMenu\.close\(\)/,
    'the click handler just closes the drawer');
  assert.doesNotMatch(init.slice(0, 250), /Settings\.open\(/,
    'it does NOT call Settings.open — the hash does the navigating');
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

test('handleBack only pops an entry we pushed ourselves', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    handleBack() {'));
  const head = fn.slice(0, 1400);
  assert.match(head, /if \(!Settings\._open\) return false;/,
    'a press outside the screen is never consumed');
  assert.match(head, /if \(!Settings\._isMobile\(\) \|\| Settings\._level !== 2\) return false;/,
    'desktop and the menu level fall through to navigateHome');
  assert.match(head, /if \(Settings\._pushedFromMenu\) \{[\s\S]{0,400}history\.back\(\)/,
    'history.back only for our own pushed entry');
  assert.match(head, /history\.replaceState\(null, '', '#settings'\)/,
    'a deep link REPLACES instead, so back cannot bounce forever');
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
  const nav = settingsJs.slice(settingsJs.indexOf('    _navItemsHtml() {'));
  assert.match(nav.slice(0, 1200), /_groupedSections\(\)/);
  const menu = settingsJs.slice(settingsJs.indexOf('    _mobileMenuHtml() {'));
  assert.match(menu.slice(0, 1600), /_groupedSections\(\)/);
  assert.match(menu.slice(0, 1600), /min-h-\[44px\]/, 'menu rows keep the 44px target');
});

test('_syncChrome drives the header through App, not the DOM', () => {
  const fn = settingsJs.slice(settingsJs.indexOf('    _syncChrome() {'));
  const head = fn.slice(0, 800);
  // #1036: the second argument is the anchor's href — inside a section
  // the chevron pops to the settings menu, so that is where it points.
  assert.match(head, /App\.setBackIcon\(inSection \? 'arrow' : 'home', inSection \? '#settings' : undefined\)/);
  assert.match(head, /App\.setHeaderTitle\(/,
    'setHeaderTitle mirrors document.title for the native AppBar');
  assert.doesNotMatch(head, /getElementById\('header-title'\)/,
    'never writes the header element directly');
});

// ── Late-arriving state ────────────────────────────────────────────────

test('the menu re-resolves when gate state lands after first paint', () => {
  assert.match(settingsJs, /_renderNavIfOpen\(\)\s*\{/, 'the re-resolve helper exists');
  const refresh = settingsJs.slice(settingsJs.indexOf('    async refresh() {'));
  assert.match(refresh.slice(0, 1800), /_renderNavIfOpen\(\)/,
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
  const fn = devChatJs.slice(devChatJs.indexOf('  _wireCreditsBanner() {'));
  // #1049 added a second argument: the two hand-off routes are handled in
  // place (they start the walkthrough in this chat) rather than navigated.
  assert.match(fn.slice(0, 800), /CreditOptions\.wire\(banner, \{ onFlow:/,
    'the shared module wires the banner');
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
  assert.match(read('public/js/admin-console.js'), /href="#settings\/password"/,
    'so does the temporary-password dialog');
});

// ── Staging mock data ──────────────────────────────────────────────────

test('the CLI credentials list has a staging ?demo=1 injection', () => {
  assert.match(cliAuthJs, /function demoCliTokens\(\)/, 'demo rows are defined');
  assert.match(cliAuthJs,
    /req\.query\.demo === '1' && process\.env\.USERNODE_ENV === 'staging'/,
    'gated on staging + the explicit opt-in, exactly like llm-grants');
  assert.match(cliAuthJs, /new Set\(\['limit', 'cursor', 'demo'\]\)/,
    "the strict query allowlist admits 'demo'");
  assert.match(cliAuthJs, /staging-demo-cli-1/, 'rows are obviously fake');
  assert.match(cliAuthJs, /demo: true/, 'rows are flagged so Revoke is suppressed');
  // Strictly read-only — the demo branch must not touch the DB.
  const fnStart = cliAuthJs.indexOf('function demoCliTokens()');
  const fn = cliAuthJs.slice(fnStart, fnStart + 1600);
  assert.doesNotMatch(fn, /pool\.query|INSERT|UPDATE/,
    'fabricated in memory, never written');
});

test('settings.js passes ?demo=1 through to the credentials list', () => {
  assert.match(settingsJs, /_cliTokensDemo\(\)\s*\{/, 'the passthrough helper exists');
  // Scoped to _loadCliTokens, not the whole module — the point is that the
  // passthrough is on the request this function builds. The window grew
  // when the capability gate (_cliAuthAvailable — skip the fetch entirely
  // where the CLI surface is 404'd) landed above the query construction.
  const load = settingsJs.slice(settingsJs.indexOf('    async _loadCliTokens(reset) {'));
  assert.match(load.slice(0, 2600), /_cliTokensDemo\(\) \? '&demo=1' : ''/,
    'the page-level ?demo=1 reaches the endpoint');
  assert.match(settingsJs, /!token\.demo/, 'Revoke is suppressed on demo rows');
});

// ── Environment parity ─────────────────────────────────────────────────

test('the screen itself is never gated on USERNODE_ENV', () => {
  // The whole shell/routing surface must be identical in staging and prod;
  // only DATA (the ?demo=1 rows in cli-auth.js) may differ.
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
  for (const key of ['password', 'app-ai', 'agent-files', 'language', 'cli', 'admin-preview']) {
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
  // Data-dependent sections must go through the staging demo injection.
  for (const t of tests) {
    if (/#settings\/(app-ai|agent-files|cli)/.test(t.path)) {
      assert.match(t.path, /demo=1/,
        `${t.path} needs ?demo=1 — its table is staging:private / not cloned`);
    }
  }
});

// ── Usernode-app section: a failed native read is diagnosable ───────────
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
  assert.match(settingsJs, /'Could not load Usernode app settings\.'/,
    'the headline is unchanged so existing reports stay recognisable');
  assert.match(settingsJs, /font-mono[^']*', *\n? *readError\.message/,
    "the app's own message is rendered verbatim");
});

test('the failed read is recoverable in place', () => {
  const box = settingsJs.slice(
    settingsJs.indexOf('    _renderUsernodeError(parent, readError, loading) {'),
    settingsJs.indexOf('    _renderSocialPushSection(section) {'),
  );
  assert.ok(box, '_renderUsernodeError exists');
  assert.match(box, /box\.id = 'settings-usernode-error'/,
    'the error box has a stable id');
  assert.match(box, /retry\.id = 'settings-usernode-retry'/,
    'the retry button has a stable id');
  assert.match(box, /'Try again'/, 'the retry is offered on the screen');
  assert.match(box, /_renderUsernodeBody\(readError, true\)/,
    'a retry swaps the box for a progress line instead of blanking the section');
  assert.match(box, /await this\._renderUsernodeSection\(\)/,
    'the retry re-runs the read');
  // The JS-built ids must NOT be in the static shell — that is what makes
  // this section the exception to the id-binding rule.
  for (const id of ['settings-usernode-error', 'settings-usernode-retry']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`),
      `#${id} is built by settings.js, never shipped in the markup`);
  }
});

test('a failed read still leaves the snapshot-independent blocks up', () => {
  const body = settingsJs.slice(
    settingsJs.indexOf('    _renderUsernodeBody(readError, loading) {'),
    settingsJs.indexOf('    _renderUsernodeError(parent, readError, loading) {'),
  );
  assert.ok(body, '_renderUsernodeBody takes the failure record');
  assert.match(body, /if \(!s\) \{\n\s+this\._renderUsernodeError\(/,
    'the error box replaces ONLY the snapshot-dependent permissions block');
  // These need no snapshot, so they must not sit behind an `if (s)`.
  for (const call of [
    'this._renderSocialPushSection(section);',
    'this._renderBpSection(section);',
    'this._renderUsernodeFaq(aboutBox,',
    "this._openNativeScreen('benchmark',",
    "this._openNativeScreen('httpLogs',",
  ]) {
    assert.ok(body.includes(call), `${call} runs with or without a snapshot`);
  }
  // These read the snapshot, so every one of them must be guarded.
  for (const guarded of [
    's.nodeSleepEnabled', 's.facematchStrict', 's.debugMode', 's.authStatus',
  ]) {
    const at = body.indexOf(guarded);
    assert.ok(at > -1, `${guarded} still drives its control`);
    assert.match(body.slice(0, at), /if \(s\) \{|if \(s && /,
      `${guarded} is only read behind a snapshot guard`);
  }
  assert.match(body, /const perms = \(s && s\.permissions\) \|\| \{\}/,
    'no snapshot means no permission rows, not a TypeError');
  assert.match(body, /const bi = \(s && s\.buildInfo\) \|\| \{\}/,
    'the build line simply goes missing without a snapshot');
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
    settingsJs.indexOf('    _renderUsernodeBody(readError, loading) {'),
  );
  assert.match(clear,
    /window\.removeEventListener\(\n?\s*'usernode:auth-status'/,
    'the listener is removed, following the social-push discipline');
  // Removed on a successful read, on close, and reset per mount.
  const section = settingsJs.slice(
    settingsJs.indexOf('    async _renderUsernodeSection() {'),
    settingsJs.indexOf('    _usernodeReadError() {'),
  );
  assert.match(section, /this\._clearUsernodeAuthStatusRetry\(\);\n\s+this\._renderUsernodeBody\(\);/,
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
  // The copy has to answer "what still happens on Usernode?", because
  // "runs on your machine" otherwise reads as "Usernode stops working".
  assert.match(experimental, /Usernode still opens the pull request/);
});

test('the machine list is built as DOM nodes, never innerHTML', () => {
  const render = settingsJs.slice(
    settingsJs.indexOf('_renderLocalAgentsSection()'),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  // The label is free text typed on someone's own laptop and arrives here
  // verbatim. This section follows the screen's MOVE-DON'T-REWRITE rule too:
  // it only ever writes into its own list host.
  assert.ok(!/innerHTML\s*=\s*`/.test(render), 'no template-literal innerHTML');
  assert.match(render, /createElement\(/);
  assert.match(render, /\.textContent = /);
  assert.match(render, /list\.textContent = '';/, 'the list host is emptied, not rewritten');
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
  const card = settingsJs.slice(
    settingsJs.indexOf('_localAgentCard('),
    settingsJs.indexOf('_detachLocalAgent(')
  );
  assert.match(card, /!agent\.demo/);
});

test('the Experimental toggle still gates the whole section', () => {
  // The block is painted from _renderExperimentalSection, so it inherits the
  // existing preview gate rather than inventing a second one.
  assert.match(settingsJs, /_renderExperimentalSection\(\)[\s\S]{0,4000}_renderLocalAgentsSection\(\)/);
});
