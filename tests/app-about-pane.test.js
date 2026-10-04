'use strict';

// The mark menu's About pane, as the navigation prototype draws it
// (nav-prototype.html, `sheetHtml` case 'about'), and the cold-load bug that
// left the menu without a subject on every tab but Home.
//
// ── What is pinned ────────────────────────────────────────────────────
//
//   1. THE WORDING (./frontend/src/features/app-context/about-model.ts).
//      The design's build-by-vote line is one of three regimes the platform
//      runs per app, so the sentence is assembled from the app's own
//      approval rules and must stay true for each of them.
//   2. THE PANE, rendered: an app's (tile, name, tagline, pill, Open/Resume,
//      Add, note, Contributors, More), Homeroom's (the three figures instead
//      of the actions), and Homeroom's for a viewer not served its row (no
//      roster the API would refuse).
//   3. THE RESOLVER (./frontend/src/features/app-context/platform-target.js):
//      it finds the platform on its own, never probes a row the viewer would
//      be refused (a 404 is a console error), and hands its answer back to
//      Home's publisher rather than publishing past its gates.
//   4. THE SEAMS: the restricted rows hide through a layout effect so the
//      prerendered menu is untouched, `?shot=app-about` reaches the pane, and
//      the pane can scroll inside the touch kit sheet.
//
// Run with: node --test tests/app-about-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const model = loadTsx('frontend/src/features/app-context/about-model.ts');
const ui = loadTsx('tests/fixtures/about-pane-api.ts');

// ── 1. The wording ───────────────────────────────────────────────────

test('the note is true for each of the three approval regimes', () => {
  const lead = 'Built by the group, one approved change at a time. ';
  assert.equal(model.appNote({}),
    `${lead}Anyone can suggest a change; it goes live once the app’s active members back it in a vote and its checks pass.`,
    'the default: the time-and-majority gate among active members');
  assert.equal(model.appNote({ approver_policy: 'invited' }),
    `${lead}Anyone can suggest a change; it goes live once the app’s invited approvers back it in a vote and its checks pass.`,
    'invited approvers: the same gate, only their votes count');
  assert.equal(model.appNote({ approvals_required: 3 }),
    `${lead}Anyone can suggest a change; it goes live once it has 3 yes votes and its checks pass.`,
    'at least N, anyone voting');
  assert.equal(model.appNote({ approver_policy: 'invited', approvals_required: 1 }),
    `${lead}Anyone can suggest a change; it goes live once one of the app’s invited approvers votes yes and its checks pass.`);
  assert.equal(model.appNote({ approver_policy: 'invited', approvals_required: '2', locked: true, collab_visibility: 'private' }),
    `${lead}Its members can suggest a change; it goes live once 2 of the app’s invited approvers vote yes, an admin votes yes, and its checks pass.`,
    'an invite-only build takes proposals from its members; a locked app needs an admin\'s yes');
  assert.equal(model.appNote(null), model.appNote({}), 'no row reads as the default, as on the server');
});

test('the platform\'s note: its own rules, or how it is built for a viewer who cannot propose', () => {
  assert.equal(model.platformNote({ approver_policy: 'invited', approvals_required: 1 }, false),
    'The platform is built the same way as the apps on it: anyone can suggest a change to the tabs, '
    + 'the bell or the workshop, and it goes live once one of the platform’s invited approvers votes yes '
    + 'and its checks pass. This menu is the same one every app has.');
  const restricted = model.platformNote(null, true);
  assert.doesNotMatch(restricted, /anyone can suggest/, 'not an invitation the platform would refuse');
  assert.match(restricted, /open to admins only/);
  assert.match(restricted, /This menu is the same one every app has\.$/);
});

test('the pill, the cards, the rows and the Open button say what the design says', () => {
  assert.equal(model.versionPillText('a1b2c3d', '2h ago'), 'a1b2c3d · 2h ago');
  assert.equal(model.versionPillText(null, '2h ago'), 'Updated 2h ago');
  assert.equal(model.versionPillText(null, null), null, 'no pill rather than "version —"');
  assert.equal(model.shortVersionOf({ version: { shortSha: 'abc1234' } }), 'abc1234');
  assert.equal(model.shortVersionOf({ main_sha: 'abc1234def' }), 'abc1234');
  assert.deepEqual(model.statCards({ apps: 1, members: 2, merged: 0 }).map((c) => [c.key, c.value, c.label]),
    [['apps', '1', 'app'], ['members', '2', 'members'], ['merged', '0', 'live']]);
  assert.equal(model.taglineOf({ manifest_snapshot: { description: '  Sketch\n together. ' } }), 'Sketch together.');
  assert.equal(model.taglineOf({ manifest_snapshot: {} }), null);
  assert.deepEqual(model.contributorView({ username: 'dana', merged_count: '6' }), { who: 'dana', initial: 'D', merged: 6 });
  assert.deepEqual(model.openLabel('running', false), { label: 'Open', canOpen: true });
  assert.deepEqual(model.openLabel('running', true), { label: 'Resume', canOpen: true });
  assert.deepEqual(model.openLabel('creating', false), { label: 'Spinning up…', canOpen: false });
  assert.deepEqual(model.openLabel('error', true), { label: 'Not running', canOpen: false });
  assert.equal(model.joinClauses(['a', null, 'b', 'c']), 'a, b, and c');
});

// ── 2. The pane, rendered ─────────────────────────────────────────────

const ROW = {
  slug: 'notes-ab12', name: 'Notes', status: 'running', is_collaborator: false, is_favorited: false,
  manifest_snapshot: { description: 'Shared notes for the group.' },
  version: { shortSha: 'a1b2c3d' }, last_deploy_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  approver_policy: 'anyone', approvals_required: null, repo_url: 'https://github.com/example/notes',
};

function render(patch, { apps = [ROW], parked = null, items = null } = {}) {
  const savedWindow = globalThis.window;
  const before = { ...ui.improveStore.get() };
  const parkedBefore = { ...ui.parkedStore.get() };
  globalThis.window = {
    location: { search: '', origin: 'https://sv.test' },
    Home: {
      _apps: apps,
      _appsLoaded: true,
      isYours: (a) => !!((a.is_collaborator && !a.your_apps_hidden) || a.is_favorited),
      menuItemsFor: () => items || [
        { key: 'install', label: 'Add to Home Screen', run: () => {} },
        { key: 'fork', label: 'Fork this app', run: () => {} },
      ],
    },
  };
  ui.improveStore.set({ ...before, ...patch });
  ui.parkedStore.set({ app: parked });
  try {
    return renderToHtml(createElement(ui.AboutPane, { label: patch.name || 'Notes' }));
  } finally {
    ui.improveStore.set(before);
    ui.parkedStore.set(parkedBefore);
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
}

test('an app\'s About, in the design\'s order', () => {
  const html = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev', canShare: true,
    repoUrl: ROW.repo_url });
  const order = ['app-about-identity', 'app-about-tagline', 'app-about-version', 'app-about-actions',
    'app-about-open', 'app-about-add', 'app-about-note', 'app-about-contributors', 'app-about-more',
    'improve-row-share', 'app-about-a2hs', 'improve-row-github', 'app-about-fork'];
  let at = -1;
  for (const id of order) {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(i > at, `#${id} is present and follows the one before it`);
    at = i;
  }
  assert.match(html, /Shared notes for the group\./, 'the tagline is the manifest\'s description');
  assert.match(html, /id="app-about-version"[^>]*>a1b2c3d · 2h ago</);
  assert.match(html, /id="app-about-open"[^>]*href="\/app\/notes-ab12"[^>]*>Open</,
    'Open is an address, so a modified click still opens a tab');
  assert.match(html, /id="app-about-add"[^>]*data-added="false"[^>]*>(?:<[^>]+>)*Add to Shortcuts/);
  assert.match(html, /Loading contributors…/, 'the roster loads after the pane opens, never in a render');
  assert.match(html, /Anyone can suggest a change; it goes live once/);
});

test('Open says Resume for the parked app, and is gone for the app already running', () => {
  const parked = { slug: 'notes-ab12', name: 'Notes', iconUrl: null, iconEmoji: null };
  assert.match(render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' }, { parked }),
    /id="app-about-open"[^>]*>Resume</);
  const running = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'app' });
  assert.doesNotMatch(running, /id="app-about-open"/, 'hidden while this app is the one running');
  assert.match(running, /id="app-about-add"/, 'Add stays');
});

test('Added is a state, not a second toggle', () => {
  const html = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' },
    { apps: [{ ...ROW, is_favorited: true }] });
  assert.match(html, /id="app-about-add"[^>]*data-added="true"[^>]*disabled=""/);
  assert.match(html, />Added</);
});

test('Add to home screen and Fork are the app page\'s own items, and absent without them', () => {
  const none = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' }, { items: [] });
  assert.doesNotMatch(none, /app-about-a2hs|app-about-fork/,
    'a laptop has no home screen, and the platform row cannot be forked');
});

test('About Homeroom: the three figures instead of the actions, the platform\'s note, its roster', () => {
  const self = { ...ROW, slug: 'usernode-2d5619', name: 'Homeroom', self_hosted: true,
    approver_policy: 'invited', approvals_required: 1 };
  const html = render({ target: 'platform', slug: 'usernode-2d5619', name: 'Homeroom', selfHosted: true },
    { apps: [self] });
  assert.match(html, /src="\/brand\/homeroom-mark\.png"/, 'the tile is the mark that opened the menu');
  assert.doesNotMatch(html, /id="app-about-actions"/, 'no Open, no Add: you are standing in it');
  assert.match(html, /id="app-about-stats"/);
  for (const key of ['apps', 'members', 'merged']) {
    assert.match(html, new RegExp(`data-stat="${key}"`), `the ${key} card`);
  }
  assert.match(html, /The platform is built the same way as the apps on it: anyone can suggest/);
  assert.match(html, /id="app-about-contributors"/);
  assert.match(html, /id="improve-row-share"/, 'Homeroom always has an address to share');
  assert.doesNotMatch(html, /app-about-fork/);
});

test('About Homeroom for a viewer not served its row: no roster the API would refuse', () => {
  const html = render({ target: 'platform', slug: 'usernode-2d5619', name: 'Homeroom', restricted: true },
    { apps: [] });
  assert.match(html, /id="app-about-stats"/);
  assert.doesNotMatch(html, /app-about-contributors/);
  assert.match(html, /open to admins only/);
  assert.match(html, /id="improve-row-share"/);
});

// #2991: the roster's "Show all" said whether it was open only through its
// label. It now says so as aria-expanded, and names the rows wrapper it opens,
// as Discover's list's own "Show more" does (./apps/browse-list.tsx).
test('the contributors fold exposes its state and the list it controls (#2991)', () => {
  const people = Array.from({ length: 7 }, (_, i) => ({ who: `u${i}`, merged: 7 - i }));
  const fold = (showAll) => renderToHtml(createElement(ui.ContributorsFold,
    { people, total: 9, showAll, onToggle: () => {} }));
  const toggleOf = (html) => {
    const m = html.match(/<button[^>]*id="app-about-contributors-toggle"[^>]*>/);
    assert.ok(m, 'the toggle renders');
    return m[0];
  };

  const folded = fold(false);
  assert.match(toggleOf(folded), /aria-expanded="false"/);
  assert.match(folded, /Show all 9 contributors/);
  assert.equal((folded.match(/data-contributor=/g) || []).length, 5, 'folded at five');

  const open = fold(true);
  assert.match(toggleOf(open), /aria-expanded="true"/);
  assert.match(open, /Show fewer/);
  assert.equal((open.match(/data-contributor=/g) || []).length, 7);

  assert.match(toggleOf(open), /aria-controls="app-about-contributors-list"/);
  const list = open.slice(open.indexOf('id="app-about-contributors-list"'), open.indexOf('id="app-about-contributors-toggle"'));
  assert.ok(list.length > 0, 'the controlled wrapper exists and precedes the toggle');
  assert.equal((list.match(/data-contributor=/g) || []).length, 7, 'and it holds the rows');

  // Five or fewer: no fold, so no toggle to describe.
  const few = renderToHtml(createElement(ui.ContributorsFold,
    { people: people.slice(0, 5), total: 5, showAll: false, onToggle: () => {} }));
  assert.doesNotMatch(few, /app-about-contributors-toggle/);
});

// ── 3. The resolver ───────────────────────────────────────────────────

function resolverEnv(routes, { home = {} } = {}) {
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  const calls = [];
  const published = [];
  const H = {
    _platformTargetFrom: (row) => ({ kind: 'platform', slug: row.slug, name: row.name }),
    _restrictedPlatformTarget: (slug) => ({ kind: 'platform', slug, name: 'Homeroom', restricted: true }),
    publishImproveTarget: () => published.push(PT.known()),
    ...home,
  };
  globalThis.window = { location: { search: '' }, Home: H, App: {} };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const answer = routes[String(url).split('?')[0]];
    if (!answer) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  };
  const PT = ui.PlatformTarget;
  Object.assign(PT, { _slug: null, _known: null, _row: null, _pending: null, _failedAt: 0,
    _about: null, _aboutAt: 0, _aboutPending: null });
  const restore = () => {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    if (saved.window === undefined) delete globalThis.window;
  };
  return { PT, calls, published, restore };
}

const ABOUT = { name: 'Homeroom', stats: { apps: 1, members: 1, merged: 1 }, selfAppSlug: 'usernode-2d5619' };
const SELF = { slug: 'usernode-2d5619', name: 'Homeroom', self_hosted: true };

test('served: the platform row, from the route an app\'s page uses, handed to Home to publish', async () => {
  const env = resolverEnv({
    '/api/platform/about': { status: 200, body: { ...ABOUT, served: true } },
    '/api/apps/usernode-2d5619': { status: 200, body: { app: SELF } },
  });
  try {
    const t = await env.PT.resolve();
    assert.equal(t.slug, 'usernode-2d5619');
    assert.equal(t.restricted, undefined);
    assert.equal(env.PT.row().slug, 'usernode-2d5619', 'the row is kept for About');
    assert.deepEqual(env.calls, ['/api/platform/about', '/api/apps/usernode-2d5619?manifest=summary']);
    assert.equal(env.published.length, 1, 'Home publishes it, through its own gates');
  } finally { env.restore(); }
});

test('not served: the restricted target, and the row is never probed (a 404 is a console error)', async () => {
  const env = resolverEnv({
    '/api/platform/about': { status: 200, body: { ...ABOUT, served: false } },
    '/api/apps/usernode-2d5619': { status: 404, body: {} },
  });
  try {
    const t = await env.PT.resolve();
    assert.equal(t.restricted, true);
    assert.deepEqual(env.calls, ['/api/platform/about'], 'no request that would 404');
  } finally { env.restore(); }
});

test('Home\'s list already said "not served": only the slug is needed', async () => {
  const env = resolverEnv({
    '/api/platform/about': { status: 200, body: { ...ABOUT, served: true } },
  });
  try {
    const t = await env.PT.resolve({ served: false });
    assert.equal(t.restricted, true, 'the list is the first authority');
    assert.ok(!env.calls.some((u) => u.startsWith('/api/apps/')));
  } finally { env.restore(); }
});

test('without the about read, GET /api/version names the slug and the row answers', async () => {
  const env = resolverEnv({
    '/api/version': { status: 200, body: { selfAppSlug: 'usernode-2d5619' } },
    '/api/apps/usernode-2d5619': { status: 404, body: {} },
  });
  try {
    const t = await env.PT.resolve();
    assert.equal(t.restricted, true, 'a 404 from the row is "not served"');
    assert.deepEqual(env.calls, ['/api/platform/about', '/api/version', '/api/apps/usernode-2d5619?manifest=summary']);
  } finally { env.restore(); }
});

test('offline: nothing is published, and a burst of screen changes does not retry at once', async () => {
  const env = resolverEnv({});
  try {
    assert.equal(await env.PT.resolve(), null);
    assert.equal(env.published.length, 0);
    const before = env.calls.length;
    await env.PT.resolve();
    assert.equal(env.calls.length, before, 'within the retry window it is not asked again');
  } finally { env.restore(); }
});

// ── 4. The seams ──────────────────────────────────────────────────────

test('the restricted row hides through a layout effect, so the prerendered menu is untouched', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // The discussion and invite rows that hid with it left the menu (UI
  // overhaul, #3362); the workshop row is the one left to hide.
  assert.match(sheet, /useIsomorphicLayoutEffect\(\(\) => \{\s*for \(const el of \[workshopRowRef\.current\]\)/);
  assert.match(sheet, /el\.classList\.toggle\('hidden', !!restricted\);[\s\S]{0,40}\}, \[restricted, view\]\);/,
    'and re-runs when the menu pane comes back from About, whose rows mount again');
  assert.match(sheet, /id="app-menu-row-workshop"\s+dataContextRow="workshop"\s+elRef=\{workshopRowRef\}/);
  assert.doesNotMatch(sheet, /id="app-menu-row-(discussion|invite)"/);
  const html = read('public/index.html');
  assert.match(html, /<a id="app-menu-row-workshop" data-context-row="workshop" href="#" class="flex/,
    'the prerender ships the row unhidden, with the one class string React keeps');
  // The viewer's own rows (agent sessions) wait for mount.
  assert.match(sheet, /const \[mounted, setMounted\] = useState\(false\);\s*useEffect\(\(\) => \{ setMounted\(true\); \}, \[\]\);/);
});

test('About is the menu\'s pane, and the menu\'s two actions stay on the menu pane', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // Every pane but the menu's (About, and Invite since invite links).
  assert.match(sheet, /\{view !== 'menu' \? null : <UpdateStatus \/>\}/);
  assert.match(sheet, /\{view !== 'menu' \? null : <ImproveQuickActions \/>\}/);
});

test('?shot=app-about opens the pane once the route has published a subject', () => {
  const island = read('frontend/src/features/app-context/index.tsx');
  assert.match(island, /const ABOUT_SHOT = 'app-about';/);
  assert.match(island, /if \(improveStore\.get\(\)\.slug \|\| --tries <= 0\) \{\s*void AppContext\.open\(\);\s*AppContext\.showAbout\(\);/);
});

test('the pane scrolls inside the touch kit sheet; the menu pane keeps its drag-to-dismiss', () => {
  const css = read('public/css/app.css');
  const panX = css.indexOf('.un-sheet:has(#apps-switcher-sheet),');
  const about = css.indexOf('.un-sheet:has(#app-about-pane) {');
  assert.ok(panX > 0 && about > panX, 'after the pan-x rule it overrides, at the same specificity');
  assert.match(css.slice(about, about + 80), /touch-action: pan-y;/);
});

test('the resolver is published before App.init can ask it', () => {
  assert.match(read('frontend/src/features/app-context/mount.ts'), /import '\.\/platform-target\.js';/);
  assert.match(read('frontend/src/features/app-context/platform-target.js'),
    /if \(typeof window !== 'undefined'\) \{\s*window\.PlatformTarget = PlatformTarget;/);
});

test('the pane reads Discover\'s own sources, not copies of them', () => {
  // frontend/src/features/app-context/about-data.ts: the same contributors
  // endpoint and ?demo=1 passthrough Discover's app page uses
  // (../apps/browse.js _fetchContributors), the list rows Home and Browse
  // already hold, and Homeroom's figures through the resolver's one read.
  const data = read('frontend/src/features/app-context/about-data.ts');
  const browse = read('frontend/src/features/apps/browse.js');
  assert.match(data, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/contributors\$\{demoQS\(\)\}`\)/);
  assert.match(browse, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/contributors\$\{demoQS\}`\)/,
    'the endpoint Discover\'s page reads');
  assert.match(data, /for \(const list of \[g\(\)\.Home\?\._apps, g\(\)\.Browse\?\._apps\]\)/);
  assert.match(data, /void platform\.about\(\)\.then/, 'About Homeroom shares the resolver\'s read');
  assert.doesNotMatch(data, /fetch\(`\/api\/platform\/about/, 'and never makes a second one');
});
