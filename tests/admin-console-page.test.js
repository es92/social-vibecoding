// Full-page admin & moderation console (#818) — the second slice behind
// the #588 header icon: the "Coming soon" placeholder is replaced by a
// hash-routed #admin screen rendered by frontend/src/features/admin/admin-console.js.
//
// Contract pinned here:
//  - the icon's click handler navigates to #admin (and still re-checks
//    the isAdmin gate — see admin-console-header-button.test.js for the
//    icon itself);
//  - the hash router has an `admin` branch, and navigateToAdminConsole
//    re-checks isAdmin so a hand-typed #admin from a non-admin bails home;
//  - the screen container ships hidden in the shell, like its siblings;
//  - PAGE VISIBILITY gates on isAdmin (view-only admins included) while
//    WRITE CONTROLS gate on canAdminWrite — the view-only-admin split
//    (issue #311) that is easy to break by using the wrong flag on either
//    side;
//  - no environment gating anywhere: staging and production get the
//    identical console;
//  - the dapp.json rendered check keeps the page actually rendering at
//    /#admin for the capture identity.
//
// Run with: node --test tests/admin-console-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
// The chassis (#admin-root and the two hosts inside it) is React-owned markup
// since #1082 chunk E; the module renders only what hangs off it.
// The section imports moved out of index.tsx into ./sections.ts, which the
// console dynamic-imports on its first open (421KB of the shell bundle a
// non-admin never downloads). Both files are the island's own source, so
// the invariant these assertions protect — every section module is imported
// somewhere in the island's graph, admin-console.js first — is unchanged;
// only which file the import sits in moved.
const islandTsx = fs.readFileSync(path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8')
  + fs.readFileSync(path.join(root, 'frontend/src/features/admin/sections.ts'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

test('the icon action navigates to the #admin hash route, gate first', () => {
  const fn = appJs.slice(appJs.indexOf('  openAdminConsole()'));
  assert.match(fn.slice(0, 300), /if \(!App\.user\?\.isAdmin\) return;/,
    'openAdminConsole re-checks the gate before navigating');
  assert.match(fn.slice(0, 400), /location\.hash = '#admin'/,
    'openAdminConsole routes through the hash — the console is a real page, not a modal');
  assert.ok(!/Coming soon/.test(fn.slice(0, 400)),
    'the placeholder alert is gone');
});

test('the hash router handles #admin[/section]', () => {
  assert.match(appJs, /parts\[0\] === 'admin'/,
    'restoreFromHash has an admin branch');
  // The segment goes through `_adminSection` rather than straight into the
  // call because the branch also rewrites the legacy two-level
  // #admin/seasons/<screen> and #admin/topochain/<screen> addresses to the
  // promoted #admin/<screen> sections (#1179, tails and all) before
  // navigating.
  assert.match(appJs, /let _adminSection = parts\[1\] \|\| null;/,
    'the optional section segment deep-links a menu section');
  assert.match(appJs, /App\.navigateToAdminConsole\(_adminSection\)/,
    'that section is what navigateToAdminConsole receives');
});

test('navigateToAdminConsole re-checks isAdmin and bails home for non-admins', () => {
  const fn = appJs.slice(appJs.indexOf('  navigateToAdminConsole('));
  assert.ok(fn.length > 0, 'navigateToAdminConsole exists in app.js');
  // #860 restated the gate as `const isAdmin = !!App.user?.isAdmin` plus a
  // narrow public-section exception, so match on the flag rather than the
  // old single-line `if`. Still isAdmin (full AND view-only), never
  // canAdminWrite.
  assert.match(fn.slice(0, 400), /const isAdmin = !!App\.user\?\.isAdmin;/,
    'gate on isAdmin — full AND view-only admins, never canAdminWrite');
  assert.match(fn.slice(0, 400), /App\.navigateHome\(\)/,
    'a hand-typed #admin from a non-admin lands on home');
  assert.ok(!/canAdminWrite/.test(fn.slice(0, fn.indexOf('_exitAdminConsole'))),
    'page visibility must not gate on canAdminWrite — that excludes view-only admins');
});

test('the admin screen ships hidden in the shell like its siblings', () => {
  const main = html.match(/<main id="admin-screen"[^>]*>/);
  assert.ok(main, 'index.html carries #admin-screen');
  assert.match(main[0], /class="hidden /, 'ships hidden — revealed only by navigation');
  assert.ok(html.includes('id="admin-root"'), 'the module renders into #admin-root');
  // #1082 chunk E: the console's ten modules arrive with the React bundle now,
  // not as a <script src="/js/admin-console.js"> tag. The chassis they used to
  // build at mount is prerendered instead — so assert the CHASSIS is in the
  // document, which is a stronger claim than the tag ever was.
  assert.ok(!html.includes('/js/admin-console.js'),
    'the console module is bundled, not loaded as a classic script');
  for (const id of ['admin-nav-desktop', 'admin-view-only-banner', 'admin-section-content']) {
    assert.ok(html.includes(`id="${id}"`), `the chassis ships #${id}`);
  }
  const banner = html.match(/<div id="admin-view-only-banner"[^>]*>/);
  assert.ok(banner && /class="hidden /.test(banner[0]),
    'the view-only banner ships hidden — AdminConsole._renderShell reveals it');
  assert.match(html, /<div id="admin-section-content" class="pb-8"><\/div>/,
    'the section host ships EMPTY: sections render into it from the module');
});

test('the console island imports every admin module, console first', () => {
  // The load-order cluster the retired <script> tags used to express. The
  // section modules read the AdminUI registry admin-console.js exports, and
  // admin-topochain.js reads it while its module body evaluates — so if the
  // console import ever stops coming first, the prerender pass throws.
  //
  // The list GROWS as #1120 moves the console's own sections out of the
  // chassis one at a time — `admin-overview` in slice 16, `admin-codes` in
  // slice 17. Six of the eight self-rendered sections are still inline in
  // admin-console.js; each will add a line here.
  const island = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8')
    + fs.readFileSync(path.join(root, 'frontend/src/features/admin/sections.ts'), 'utf8');
  // `.tsx` as well as `.js`: sections are converting to React one at a time
  // (#1120), and the import order this pins is about module EVALUATION order,
  // which the file extension has nothing to do with.
  // `[a-z0-9-]` rather than `[a-z]`: the character class used to miss
  // `admin-e2e` (a digit) silently, and would now also miss
  // `admin-featured-apps` (a second hyphen). A section this test cannot see is
  // a section whose import order it does not actually pin.
  const order = [...island.matchAll(/(?:from|import) '\.\/(admin-[a-z0-9-]+)\.(?:js|tsx)'/g)]
    .map((m) => m[1]);
  assert.equal(order[0], 'admin-console', 'admin-console.js is imported first');
  assert.deepEqual(order.slice(1).sort(), [
    'admin-analytics', 'admin-campaigns', 'admin-codes', 'admin-db-export',
    'admin-e2e', 'admin-estimator', 'admin-featured-apps', 'admin-features',
    'admin-gallery',
    // #2684: the Homeroom bot's shadow-mode verdicts and their ratings.
    'admin-homeroom-bot',
    'admin-limits', 'admin-mail', 'admin-merges',
    // #2570: Model costs, where the picker's per-model notes and cost
    // estimates are kept honest against what changes actually cost.
    'admin-model-costs',
    'admin-node',
    'admin-overview', 'admin-push', 'admin-reports', 'admin-rollover', 'admin-staging-reap',
    // #2253: App storage, the per-app database cap's console section.
    'admin-status', 'admin-storage',
    // Support: one user's account, points, events, kudos and history.
    'admin-support',
    'admin-topochain', 'admin-users',
  ], 'every section module is imported by the island');
});

test('every full-screen exit path also exits the admin screen', () => {
  // The same _inX/_exitX discipline the leaderboard/challenges/profile
  // screens follow: missing one exit call leaves two screens stacked.
  const exits = appJs.match(/if \(App\._inAdmin\) App\._exitAdminConsole\(\);/g) || [];
  assert.ok(exits.length >= 6,
    `_exitAdminConsole is called from the sibling navigate/exit sites (found ${exits.length}, expect >= 6)`);
  assert.match(appJs, /else if \(App\._inAdmin\) App\.navigateHome\(\);/,
    'the empty-hash branch sends an open admin screen home');
});

test('write controls gate on canAdminWrite, in the module only', () => {
  assert.match(consoleJs, /canWrite\(\) \{ return !!\(window\.App && App\.user && App\.user\.canAdminWrite\); \}/,
    'the single write gate reads App.user.canAdminWrite');
  assert.ok(consoleJs.includes('admin-view-only-banner'),
    'view-only admins get the amber read-only banner');
  // The header-button test pins that app.js's admin-console functions
  // never mention canAdminWrite; keep the flag's only consumer here.
  const fns = appJs.slice(
    appJs.indexOf('  renderAdminButton()'),
    appJs.indexOf('  loadedPlatformSha:')
  );
  assert.ok(fns.length > 0, 'admin-console functions located in app.js');
  assert.ok(!/canAdminWrite/.test(fns),
    'app.js admin-console functions stay canAdminWrite-free');
});

test('the console is not gated on the environment', () => {
  // Comments legitimately *mention* USERNODE_ENV (to say the console is
  // not gated on it) — assert against comment-stripped code only.
  const code = consoleJs.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/USERNODE_ENV|IS_STAGING|isStaging/.test(code),
    'feature availability must be identical in staging and production');
});

test('the menu carries every section, grouped, with no external tools left', () => {
  const KEYS = [
    'overview', 'status', 'node', 'push', 'merges', 'rollover', 'staging-reap',
    'seasons', 'season-events', 'challenge-templates',
    'users', 'codes', 'limits', 'waitlist', 'onchain-accounts', 'user-activities',
    'analytics', 'estimator', 'gallery', 'features',
    'campaigns', 'db-export', 'mail',
    'settings', 'app-version', 'sql-console', 'api-tester',
  ];
  for (const key of KEYS) {
    assert.ok(new RegExp(`key: '${key}'`).test(consoleJs), `section '${key}' registered`);
  }
  // #860: nothing in the console opens a new browser tab any more — the
  // TOOLS external-link block and its target="_blank" anchors are gone.
  assert.ok(!/TOOLS\s*:/.test(consoleJs), 'the TOOLS external-link array is gone');
  assert.ok(!/More tools/.test(consoleJs), 'the "More tools" menu block is gone');
  for (const href of ['/dashboard', '/debug', '/gallery', '/status']) {
    assert.ok(!consoleJs.includes(`href: '${href}'`),
      `${href} must be a section, not an external link`);
  }
  // Every section declares a group — load-bearing for BOTH navs now: the
  // desktop sidebar's headings and the phone menu's grouped rows.
  const sectionBlock = consoleJs.slice(
    consoleJs.indexOf('SECTIONS: ['),
    consoleJs.indexOf('isOpen()')
  );
  const keyCount = (sectionBlock.match(/key: '/g) || []).length;
  const groupCount = (sectionBlock.match(/group: '/g) || []).length;
  assert.equal(keyCount, groupCount, 'every SECTIONS entry carries a group');
  // Responsive split: sidebar on md+, two-level hierarchy below md. The
  // sidebar's HOST is React-owned chassis now (#1082 chunk E) while the module
  // still fills it — hence the two different files.
  assert.ok(islandTsx.includes('id="admin-nav-desktop"'), 'the island renders the desktop sidebar host');
  assert.match(consoleJs, /getElementById\('admin-nav-desktop'\)/, 'the module fills that sidebar');
  assert.ok(consoleJs.includes('id="admin-mobile-menu"'), 'the mobile level-1 menu renders');
  // The horizontally scrolling tab strip it replaced is GONE, not merely
  // hidden — its id and its sideways scroll are what made fifteen
  // ungrouped sections a thumb-swipe scavenger hunt on a phone.
  assert.ok(!consoleJs.includes('admin-nav-mobile'),
    'the mobile tab strip is gone, replaced by the two-level menu');
  assert.ok(!/overflow-x-auto/.test(consoleJs),
    'nothing in the console scrolls sideways any more');
  // Both navs read their grouping from one helper so they cannot drift.
  assert.match(consoleJs, /_groupedSections\(\)\s*\{/,
    'one shared grouping helper feeds the sidebar and the mobile menu');
  const menuHtml = consoleJs.slice(consoleJs.indexOf('_mobileMenuHtml()'));
  assert.match(menuHtml.slice(0, 1600), /_groupedSections\(\)/,
    'the mobile menu groups via the shared helper');
  const sideHtml = consoleJs.slice(consoleJs.indexOf('  _navItemsHtml()'));
  assert.match(sideHtml.slice(0, 1200), /_groupedSections\(\)/,
    'the sidebar groups via the shared helper');
  // #1152 made each heading a collapse toggle. Both builders must key that
  // state off the group NAME the shared helper emits — keying off the map
  // index would silently mis-pair the moment _visibleSections() narrows the
  // menu and a group drops out, collapsing the wrong heading's rows.
  for (const [label, html] of [['sidebar', sideHtml], ['mobile menu', menuHtml]]) {
    assert.match(html.slice(0, 2400), /_isGroupCollapsed\(g\.name\)/,
      `the ${label}'s collapse state is keyed by group name, not by index`);
  }
});

// #860: the six folded-in sections each live in their own module. They were
// loaded by the shell and precached by the service worker individually until
// #1082 chunk E moved them into the React bundle — so what has to hold now is
// that each one exists at its new path and the island imports it. Losing
// either shows "module failed to load" instead of the section.
test('every folded-in section has a module, an island import and no stale wiring', () => {
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  const island = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8')
    + fs.readFileSync(
      path.join(root, 'frontend/src/features/admin/sections.ts'), 'utf8');
  const MODULES = {
    status: 'admin-status',
    node: 'admin-node',
    analytics: 'admin-analytics',
    // #898: platform analytics split out of the Analytics section.
    estimator: 'admin-estimator',
    merges: 'admin-merges',
    gallery: 'admin-gallery',
    campaigns: 'admin-campaigns',
    push: 'admin-push',
    topochain: 'admin-topochain',
    // Platform outbound mail: configuration, a test send, and the ledger.
    mail: 'admin-mail',
  };
  for (const [key, file] of Object.entries(MODULES)) {
    assert.match(consoleJs, new RegExp(`${key}: '`),
      `SECTION_MODULES maps '${key}' to a module global`);
    // Either renderer — a converted section is a `.tsx` (#1120). What has to
    // hold is that the module exists at its new path and the island imports
    // it; losing either shows "module failed to load" instead of the section.
    const ext = ['js', 'tsx'].find((e) => fs.existsSync(
      path.join(root, 'frontend/src/features/admin', `${file}.${e}`)));
    assert.ok(ext, `frontend/src/features/admin/${file}.{js,tsx} exists`);
    assert.ok(island.includes(`'./${file}.${ext}'`),
      `${file}.${ext} is imported by the console island`);
    assert.ok(!html.includes(`/js/${file}.js`),
      `${file}.js is bundled, so the shell must not still load it as a script`);
    assert.ok(!sw.includes(`'/js/${file}.js'`),
      `${file}.js is bundled, so its SHELL_ASSETS entry must be gone (the install would 404)`);
    assert.ok(!fs.existsSync(path.join(root, 'public/js', `${file}.js`)),
      `public/js/${file}.js is removed, not merely unreferenced`);
  }
  // The retired page scripts are gone, not merely unreferenced.
  for (const gone of ['dashboard.js', 'debug.js', 'gallery.js', 'admin-features.js']) {
    assert.ok(!fs.existsSync(path.join(root, 'public/js', gone)),
      `public/js/${gone} is removed`);
    assert.ok(!sw.includes(`'/js/${gone}'`), `${gone} dropped from the SW precache`);
  }
});

// The lifecycle that keeps a 5s /api/status poll (which shells out to
// `docker stats` server-side) and a 2s /api/node-status poll from outliving
// the section that started them.
test('every section module exposes destroy(), and switches call it first', () => {
  for (const file of ['admin-status', 'admin-node', 'admin-analytics',
    'admin-estimator', 'admin-merges', 'admin-gallery', 'admin-campaigns',
    'admin-topochain', 'admin-mail']) {
    // `.js` or `.tsx` — the render/destroy contract is what the console
    // dispatches through, and converting a section to React (#1120) keeps it.
    const ext = ['js', 'tsx'].find((e) => fs.existsSync(
      path.join(root, 'frontend/src/features/admin', `${file}.${e}`)));
    const src = fs.readFileSync(
      path.join(root, 'frontend/src/features/admin', `${file}.${ext}`), 'utf8');
    assert.match(src, /destroy\(\)\s*\{/, `${file}.${ext} implements destroy()`);
    assert.match(src, /render\(\s*\w+\s*(?:: [\w.<>[\] |]+)?\)\s*\{/,
      `${file}.${ext} implements render(host)`);
  }
  assert.match(consoleJs, /_teardownActiveSection\(\)\s*\{/,
    'the console has a single teardown choke point');
  const renderSection = consoleJs.slice(consoleJs.indexOf('  _renderSection() {'));
  const head = renderSection.slice(0, 1200);
  const teardownAt = head.indexOf('_teardownActiveSection()');
  // The dispatch body is `_renderModule` since #1120 slice 16 — `overview`
  // became a module, so the switch's `default:` arm needed the same path.
  const renderAt = head.indexOf('_renderModule(host, modName, key)');
  assert.ok(teardownAt > -1, '_renderSection tears the previous section down');
  assert.ok(renderAt > -1, '_renderSection delegates to the section module');
  assert.ok(teardownAt < renderAt, 'teardown happens BEFORE the next section renders');
  // Leaving the console entirely must stop the polls too.
  const close = consoleJs.slice(consoleJs.indexOf('  close() {'));
  assert.match(close.slice(0, 400), /_teardownActiveSection\(\)/,
    'close() also tears the active section down');
});

// Public mode: /status and /node-status were public pages before the fold,
// so a signed-in non-admin following those old links still reaches them —
// and sees ONLY them. Everything else, including bare #admin, still bounces.
test('the two formerly-public sections stay reachable for non-admins', () => {
  for (const key of ['status', 'node']) {
    assert.match(consoleJs, new RegExp(`key: '${key}'[^}]*public: true`),
      `section '${key}' is flagged public`);
  }
  // Only those two — counted inside the SECTIONS literal, so the
  // file-header comment explaining the flag doesn't inflate the tally.
  const sectionBlock = consoleJs.slice(
    consoleJs.indexOf('SECTIONS: ['),
    consoleJs.indexOf('isOpen()')
  );
  assert.equal((sectionBlock.match(/public: true/g) || []).length, 2,
    'exactly two sections are public');
  assert.match(consoleJs, /_visibleSections\(\)\s*\{/, 'the menu filters by visibility');
  assert.match(consoleJs, /filter\(\(s\) => s\.public\)/,
    'public mode narrows the menu to the public sections');

  const fn = appJs.slice(appJs.indexOf('  navigateToAdminConsole('));
  const head = fn.slice(0, 900);
  assert.match(appJs, /ADMIN_PUBLIC_SECTIONS: \['status', 'node'\]/,
    'app.js pins the public section list');
  assert.match(head, /if \(!isAdmin && !publicMode\)/,
    'a non-admin on any non-public section still bails');
  assert.match(head, /App\.navigateHome\(\)/, 'and lands on home');
  assert.match(fn.slice(0, 4000), /publicMode \? 'Platform status' : 'Admin & moderation'/,
    'public mode retitles the header');
});

test('section switches replace, never push, history', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _writeHash(key) {'));
  assert.ok(fn.length > 0, '_writeHash located');
  assert.match(fn.slice(0, 400), /location\.hash\.startsWith\('#admin'\)/,
    'hash write-back only while actually on the #admin route');
  assert.match(fn.slice(0, 400), /history\.replaceState/,
    'replaceState so section hops do not pollute the back stack');
  assert.ok(!/history\.pushState/.test(consoleJs),
    'the module never pushes history entries itself');
});

test('dapp.json locks the rendered page in with checks', () => {
  const tests = manifest.tests || [];
  const page = tests.find((t) => t.path === '/#admin');
  assert.ok(page, 'a dapp.json test renders /#admin');
  assert.match(page.expectSelector, /#admin-screen:not\(\.hidden\)/,
    'asserts the screen is actually revealed, not just present');
  const section = tests.find((t) => t.path === '/#admin/codes');
  assert.ok(section, 'a dapp.json test renders a deep-linked section');
  const dbExport = tests.find((t) => t.path === '/#admin/db-export');
  assert.ok(dbExport, 'a dapp.json test renders the database-export section');
  const estimator = tests.find((t) => t.path === '/?demo=1#admin/estimator');
  assert.ok(estimator, 'a dapp.json test renders the estimator-accuracy section (#898)');
  assert.match(dbExport.expectSelector, /#admin-db-export-panel/,
    'asserts the export panel actually rendered, not just the shell');
});

// ─── Database export section ──────────────────────────────────────
//
// The console's most dangerous control. The client-side contract:
// availability comes from the server's capability probe (never an env
// check of its own — see the "not gated on the environment" test above),
// the download is a NAVIGATION rather than a Blob, and every string that
// reaches the DOM from the history API is escaped.

// ── Database export ─────────────────────────────────────────────────────
//
// The section moved out of the chassis into its own module in #1120 slice 19,
// so these read admin-db-export.tsx rather than slicing admin-console.js. What
// each one pins is unchanged; only the two that were ABOUT the old renderer
// are restated, and both got stronger for it.

const dbExportTsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/admin-db-export.tsx'), 'utf8');

test('the export section warns before it offers, and never uses a native prompt', () => {
  assert.match(dbExportTsx, /password hash/, 'spells out what the file contains');
  assert.match(dbExportTsx, /admin-db-export-phrase/, 'the typed EXPORT confirmation is an in-page field');
  assert.match(dbExportTsx, /admin-db-export-password/, 'password re-entry is an in-page field');
  assert.ok(!/\bprompt\(/.test(dbExportTsx), 'no native prompt() — the platform renders its own dialogs');
  assert.ok(!/\bprompt\(/.test(consoleJs), 'and none left behind in the chassis either');
});

test('the restore instructions match the file the server actually sends', () => {
  // The download is a gzip-compressed plain-SQL dump, so the panel must
  // document gunzip + psql. A stale `pg_restore … .dump` line here is worse
  // than no line at all: an admin follows it during an incident and the
  // restore fails on a file pg_restore cannot read.
  assert.match(dbExportTsx, /\.sql\.gz/, 'names the extension the browser will save');
  assert.match(dbExportTsx, /gunzip -c/, 'the restore starts by decompressing');
  assert.match(dbExportTsx, /\|\s*psql/, 'and replays the SQL with psql, not pg_restore');
  assert.ok(!/pg_restore/.test(dbExportTsx), 'no leftover custom-format restore command');
  assert.ok(!/<file>\.dump/.test(dbExportTsx), 'no leftover .dump filename');
});

test('the export button is enabled by the server, not by the client', () => {
  // The disabled expression is the whole assertion now: it may consult the
  // server's `available` flag and whether the confirm panel is open, and
  // nothing else. An environment check of the client's own would show up here
  // as a third term.
  assert.match(dbExportTsx, /disabled=\{!status\?\.available \|\| confirming\}/,
    'the probe decides; the client only renders the decision');
  assert.match(dbExportTsx, /DB_EXPORT_REASONS\[status\.reason\]/,
    'the refusal copy is keyed off the server reason code');
  for (const reason of ['staging', 'unavailable', 'in_progress', 'rate_limited']) {
    assert.ok(new RegExp(`${reason}:`).test(dbExportTsx), `reason '${reason}' has copy`);
  }
  // And the client must not be deciding availability from the environment.
  assert.ok(!/IS_STAGING|USERNODE_ENV|location\.hostname/.test(dbExportTsx),
    'availability is the server’s call, so the client reads no environment signal');
});

test('the download is navigated, not fetched into memory', () => {
  const at = dbExportTsx.indexOf('  const start = async () => {');
  const fn = dbExportTsx.slice(at, dbExportTsx.indexOf('  return (', at));
  assert.ok(fn.length > 400, 'located the ticket flow');
  assert.match(fn, /\/api\/admin\/db-export\/ticket/, 'step 1 posts the confirmation');
  assert.match(fn, /window\.location\.href = data\.url/, 'step 2 navigates to the ticket URL');
  assert.ok(!/createObjectURL/.test(dbExportTsx),
    'a multi-hundred-MB dump must never be held in page memory as a Blob');
  assert.match(fn, /setPassword\(''\)/, 'the password field is cleared as soon as it is spent');
});

test('history rows cannot render admin-controlled strings as markup', () => {
  // These fields carry admin-supplied text — a username, a database name, a
  // pg_dump error. They used to be interpolated into an innerHTML template,
  // so each needed its own esc(); the row is JSX now, which escapes text
  // children by construction. The assertion is that the class is unreachable
  // AND that the four fields still reach the output.
  assert.ok(!/dangerouslySetInnerHTML|\.innerHTML/.test(dbExportTsx),
    'the history row renders no raw HTML at all');
  for (const field of ['r.username', 'r.db_name', 'r.ip', 'r.error']) {
    assert.ok(dbExportTsx.includes(`{${field}}`) || dbExportTsx.includes(field),
      `${field} still reaches the rendered row`);
  }
});

test('the section spells out post-export rotation guidance', () => {
  assert.match(dbExportTsx, /rotate/i, 'the section tells the admin what to rotate if the file leaks');
  assert.match(dbExportTsx, /JWT secret/i, 'naming the one rotation that invalidates every session');
});


// ── The lazy section chunk, and what must not pull it in ──────────────────

test('the section modules are a lazy chunk, loaded on the first open', () => {
  const consoleJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
  // The import edge itself. Vite emits assets/shell-sections.js from this;
  // frontend/vite.config.ts must keep inlineDynamicImports off for it to be
  // a chunk at all (tests/shell-build.test.js pins that end).
  assert.match(consoleJs, /import\('\.\/sections\.ts'\)/,
    'the sections barrel is dynamic-imported, not statically bundled');
  // _renderModule has to tell "not here YET" from "genuinely missing": the
  // first is the ordinary first open and gets a Loading… line, the second
  // keeps the failure copy it has always had.
  const dispatch = consoleJs.slice(consoleJs.indexOf('  _renderModule(host, modName, key) {'));
  assert.match(dispatch.slice(0, 1600), /_ensureSections\(\)/);
  assert.match(dispatch.slice(0, 1600), /console module failed to load/);
});

test('the prefetch stays off ?shot= and ?demo= routes', () => {
  // A screenshot route and a declared check exist to render ONE state
  // deterministically. A 421KB chunk arriving mid-assertion is exactly the
  // nondeterminism they are meant to be free of — and the checks runner
  // signs in as an admin (src/services/visuals.js CAPTURE_ADMIN_USERNAME),
  // so without this guard the prefetch would fire on every check route in
  // the suite. Same guard, same reason, as TermsFirstRun.maybePrompt.
  const consoleJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
  const fn = consoleJs.slice(consoleJs.indexOf('  prefetchSections() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /q\.get\('shot'\) \|\| q\.get\('demo'\)/,
    'a deterministic-state route must not pull the chunk in');
  assert.ok(body.indexOf("q.get('shot')") < body.indexOf('requestIdleCallback'),
    'the guard has to run BEFORE anything is scheduled');
  // And it is genuinely idle work: the first version forced it through
  // within 4s of boot, which on a phone is 421KB parsed against whatever
  // the page is still doing.
  const timeout = /timeout:\s*(\d+)/.exec(body);
  assert.ok(timeout && Number(timeout[1]) >= 10000,
    `the idle deadline must stay patient (found ${timeout && timeout[1]})`);

  // The gate that decides an admin ever asks for it.
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const btn = appJs.slice(appJs.indexOf('  renderAdminButton() {'));
  assert.match(btn.slice(0, 1800), /if \(isAdmin\) \{[\s\S]{0,300}?prefetchSections\?\.\(\)/,
    'only a viewer who IS an admin warms the chunk');
});
