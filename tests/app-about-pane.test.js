'use strict';

// The mark menu's About pane, as the navigation prototype draws it
// (nav-prototype.html, `sheetHtml` case 'about'), and the cold-load bug that
// left the menu without a subject on every tab but Home.
//
// ── What is pinned ────────────────────────────────────────────────────
//
//   1. THE WORDING (./frontend/src/features/app-context/about-model.ts):
//      the pill, the cards, the rows, the Open button and what a
//      contributor's row says at its end ("Creator", "3 live", or nothing).
//   2. THE PANE, rendered: an app's (tile, name, tagline, pill, Open/Resume,
//      Add, Invite, Contributors, More), Homeroom's (the three figures
//      instead of the actions), and Homeroom's for a viewer not served its
//      row (no roster the API would refuse). Neither has a line about how it
//      is built, or a Share row.
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

// A maker with nothing merged yet read "0 live" beside their own name. The
// creator is said as such, a count only when there is one, and a zero says
// nothing.
test('a contributor\'s row says Creator, how many of theirs are live, both, or nothing', () => {
  const note = (row) => model.contributorNote(model.contributorView(row));
  assert.equal(note({ username: 'ada', merged_count: 0, is_creator: true }), 'Creator');
  assert.equal(note({ username: 'ada', merged_count: 3, is_creator: true }), 'Creator · 3 live');
  assert.equal(note({ username: 'ada', merged_count: 1, is_creator: true }), 'Creator · 1 live');
  assert.equal(note({ username: 'cy', merged_count: 6 }), '6 live');
  assert.equal(note({ username: 'cy', merged_count: 0 }), null, 'a zero says nothing');
  assert.equal(model.appNote, undefined, 'no line about how it is built');
  assert.equal(model.platformNote, undefined);
});

test('the pill, the cards, the rows and the Open button say what the design says', () => {
  assert.equal(model.membersPillText(1), '1 member');
  assert.equal(model.membersPillText('12'), '12 members');
  assert.equal(model.membersPillText(0), null, 'a zero says nothing');
  assert.equal(model.membersPillText(undefined), null);
  assert.equal(model.versionRowText('a1b2c3d', false, false), 'App version: a1b2c3d');
  assert.equal(model.versionRowText('a1b2c3d', false, true), 'Version: a1b2c3d');
  assert.equal(model.versionRowText(null, true, false), 'App version: deploying…');
  assert.equal(model.versionRowText(null, false, false), null, 'no row rather than "version —"');
  assert.equal(model.shortVersionOf({ version: { shortSha: 'abc1234' } }), 'abc1234');
  assert.equal(model.shortVersionOf({ main_sha: 'abc1234def' }), 'abc1234');
  assert.deepEqual(model.statCards({ apps: 1, members: 2, merged: 0 }).map((c) => [c.key, c.value, c.label]),
    [['apps', '1', 'app'], ['members', '2', 'members'], ['merged', '0', 'live']]);
  assert.equal(model.taglineOf({ manifest_snapshot: { description: '  Sketch\n together. ' } }), 'Sketch together.');
  assert.equal(model.taglineOf({ manifest_snapshot: {} }), null);
  assert.deepEqual(model.contributorView({ username: 'dana', merged_count: '6' }), { who: 'dana', initial: 'D', merged: 6, creator: false });
  assert.equal(model.contributorView({ username: 'dana', merged_count: 0, is_creator: true }).creator, true);
  assert.deepEqual(model.openLabel('running', false), { label: 'Open', canOpen: true });
  assert.deepEqual(model.openLabel('running', true), { label: 'Resume', canOpen: true });
  assert.deepEqual(model.openLabel('creating', false), { label: 'Spinning up…', canOpen: false });
  assert.deepEqual(model.openLabel('error', true), { label: 'Not running', canOpen: false });
});

// ── 2. The pane, rendered ─────────────────────────────────────────────

const ROW = {
  slug: 'notes-ab12', name: 'Notes', status: 'running', is_collaborator: false, is_favorited: false,
  manifest_snapshot: { description: 'Shared notes for the group.' },
  version: { shortSha: 'a1b2c3d' }, last_deploy_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  approver_policy: 'anyone', approvals_required: null, repo_url: 'https://github.com/example/notes', member_count: 3,
  is_member: true,
};

function render(patch, { apps = [ROW], parked = null, items = null, privateMember = false, homeVisited = false } = {}) {
  const savedWindow = globalThis.window;
  const before = { ...ui.improveStore.get() };
  const parkedBefore = { ...ui.parkedStore.get() };
  const navBefore = { ...ui.navStore.get() };
  globalThis.window = {
    location: { search: '', origin: 'https://sv.test' },
    App: { _privateHomeVisited: () => homeVisited },
    Home: {
      _apps: apps,
      _appsLoaded: true,
      isYours: (a) => !!((a.is_collaborator && !a.your_apps_hidden) || a.is_favorited),
      menuItemsFor: () => items || [
        { key: 'install', label: 'Add to Home Screen', run: () => {} },
        { key: 'fork', label: 'Make your own', run: () => {} },
      ],
    },
  };
  ui.improveStore.set({ ...before, ...patch });
  ui.parkedStore.set({ app: parked });
  ui.navStore.set({ privateMember });
  try {
    return renderToHtml(createElement(ui.AboutPane, { label: patch.name || 'Notes' }));
  } finally {
    ui.improveStore.set(before);
    ui.parkedStore.set(parkedBefore);
    ui.navStore.set(navBefore);
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
}

test('an app\'s About, in the design\'s order', () => {
  const html = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev', canShare: true,
    repoUrl: ROW.repo_url });
  const order = ['app-about-identity', 'app-about-tagline', 'app-about-members', 'app-about-actions',
    'app-about-open', 'app-about-add', 'app-about-invite', 'app-about-contributors', 'app-about-more',
    'app-about-a2hs', 'app-about-fork', 'improve-row-github', 'app-about-version'];
  let at = -1;
  for (const id of order) {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(i > at, `#${id} is present and follows the one before it`);
    at = i;
  }
  assert.match(html, /Shared notes for the group\./, 'the tagline is the manifest\'s description');
  assert.match(html, /id="app-about-members"[^>]*>3 members</, 'how many are in its community, not the version');
  assert.match(html, /id="app-about-version"[^>]*>App version: a1b2c3d</, 'the version is a plain row under More');
  assert.doesNotMatch(html, /app-about-note|app-about-how|builds it together/, 'no line about how it is built');
  assert.doesNotMatch(html, /improve-row-share/, 'no Share: Invite brings people in');
  assert.doesNotMatch(html, /\/app\/notes-ab12</, 'no address under the name');
  assert.match(html, /id="app-about-open"[^>]*href="\/app\/notes-ab12"[^>]*>Open</,
    'Open is an address, so a modified click still opens a tab');
  assert.match(html, /id="app-about-add"[^>]*data-added="false"[^>]*>(?:<[^>]+>)*Pin to Home/);
  assert.match(html, /Loading contributors…/, 'the roster loads after the pane opens, never in a render');
});

// Invite is the hub's (community-card.tsx openInviteLinks), for a member as
// there. Beside Open it is Add's white pill; with Open gone (the app is the
// one running) it is the filled accent pill, taking the rest of the row.
test('Invite is a member\'s: a pill beside Open, the filled button inside the app', () => {
  const beside = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' });
  const invite = (html) => (html.match(/<button[^>]*id="app-about-invite"[^>]*>/) || [null])[0];
  assert.ok(invite(beside), 'a member is offered Invite');
  assert.match(invite(beside), /shrink-0/);
  assert.doesNotMatch(invite(beside), /bg-violet-600/, 'Open is the row\'s one filled button');
  assert.match(beside, /id="app-about-invite"[^>]*>(?:<[^>]+>)*Invite</);

  const inside = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'app' });
  assert.doesNotMatch(inside, /id="app-about-open"/);
  assert.match(invite(inside), /rounded-full bg-violet-600/, 'the accent pill, through <Button>');
  assert.match(invite(inside), /flex-1 basis-0/, 'taking what Add leaves');

  const outsider = render({ target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' },
    { apps: [{ ...ROW, is_member: false }] });
  assert.doesNotMatch(outsider, /app-about-invite/, 'not a member, no Invite');

  // A newcomer still offered "Go to Homeroom" has it too. #4216 hid Share
  // from them; an invite link is the hub's for every member, and the server
  // lets any member make one, so About does not hold it back alone.
  const patch = { target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' };
  assert.match(render(patch, { privateMember: true }), /id="app-about-invite"/,
    'a private member who has not gone to Homeroom yet');

  // It turns the sheet to the invite pane, and Back from there returns here.
  const src = read('frontend/src/features/app-context/about-pane.tsx');
  assert.equal((src.match(/AppContext\.openInvite\(\{ back: 'about' \}\)/g) || []).length, 2, 'both forms of the button');
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

// People see a fork as "Make your own" (their own version,
// docs/plans/versions.md). The row says what it does under its label, and a
// version says what it was made from, under its description, the way
// Discover's page does.
test('Make your own says "Your own version to change", and a version says what it was made from', () => {
  const patch = { target: 'app', slug: 'notes-ab12', name: 'Notes', tab: 'dev' };
  const plain = render(patch);
  assert.match(plain, /id="app-about-fork"[^>]*>[\s\S]*?>Make your own<[\s\S]*?>Your own version to change</);
  assert.doesNotMatch(plain, />Remix</, 'people never see "Remix"');
  assert.doesNotMatch(plain, /Fork this app/);
  assert.doesNotMatch(plain, /app-about-lineage/, 'an app that is not a copy has no lineage line');

  const copy = { ...ROW, forked_from: { appId: 3, slug: 'book-club', name: 'Book Club', linkable: true } };
  const html = render(patch, { apps: [copy] });
  assert.match(html, /id="app-about-lineage"[^>]*>(?:<[^>]+>)*Made from Book Club</);
  assert.doesNotMatch(html, /\u2442/, 'the fork sign is gone with the word');
  assert.match(html, /id="app-about-lineage"[^>]*><a href="#app\/book-club"/, 'it opens the original');
  assert.ok(html.indexOf('id="app-about-tagline"') < html.indexOf('id="app-about-lineage"'),
    'under the description');

  const orphan = { ...ROW, forked_from: { appId: 3, slug: 'book-club', name: '<deleted>', linkable: false } };
  const gone = render(patch, { apps: [orphan] });
  assert.match(gone, /Made from &lt;deleted&gt;/);
  assert.doesNotMatch(gone, /id="app-about-lineage"[^>]*><a /, 'a deleted original is text, not a link');

  // A ready-made made from its platform original has no `forked_from`: its
  // link is the one-app read's `upstream_link`, read the same way.
  const readyMade = { ...ROW, forked_from: null, upstream_link: { slug: 'tier-list', name: 'Tier list', following: true, linkable: true } };
  const linked = render(patch, { apps: [readyMade] });
  assert.match(linked, /id="app-about-lineage"[^>]*><a href="#app\/tier-list"[^>]*>Made from Tier list</);
});

test('About Homeroom: the three figures instead of the actions, then its roster', () => {
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
  assert.doesNotMatch(html, /app-about-note|app-about-how|builds it together/, 'no line about how it is built');
  assert.doesNotMatch(html, /id="app-about-members"/, 'its members are a figure card');
  assert.match(html, /id="app-about-contributors"/);
  assert.doesNotMatch(html, /improve-row-share/, 'no Share here either');
  assert.doesNotMatch(html, /app-about-fork/);
});

test('About Homeroom for a viewer not served its row: no roster the API would refuse', () => {
  const html = render({ target: 'platform', slug: 'usernode-2d5619', name: 'Homeroom', restricted: true },
    { apps: [] });
  assert.match(html, /id="app-about-stats"/);
  assert.doesNotMatch(html, /app-about-contributors/);
  assert.doesNotMatch(html, /app-about-how/, 'no link to a workshop the platform would refuse');
  assert.doesNotMatch(html, /improve-row-share/);
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
  // #4216: a newcomer still offered "Go to Homeroom" has it hidden the same way.
  // Sign-up test, 19 Oct 2026: and any newcomer the walk on Home is still
  // owed to (./about-data.ts owedHomeWalk), who gets "Go to Homeroom" instead.
  assert.match(sheet, /useIsomorphicLayoutEffect\(\(\) => \{\s*const hide = !!restricted \|\| newcomer \|\| walkOwed;\s*for \(const el of \[workshopRowRef\.current\]\)/);
  assert.match(sheet, /el\.classList\.toggle\('hidden', hide\);[\s\S]{0,40}\}, \[restricted, newcomer, walkOwed, view, open\]\);/,
    'and re-runs when the menu pane comes back from About, whose rows mount again');
  assert.match(sheet, /const newcomer = mounted && offeringGoToHomeroom\(!!privateMember\);/,
    'after mount only: the visit is remembered in storage the prerender cannot see');
  assert.match(sheet, /const walkOwed = mounted && owedHomeWalk\(\);/, 'the walk too');
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

test('the pane reads the platform\'s own sources, not copies of them', () => {
  // frontend/src/features/app-context/about-data.ts: the app's contributors
  // endpoint with the ?demo=1 passthrough, the list rows Home already holds
  // (One Home, #6361: Discover's own list went with its screen), and
  // Homeroom's figures through the resolver's one read.
  const data = read('frontend/src/features/app-context/about-data.ts');
  assert.match(data, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/contributors\$\{demoQS\(\)\}`\)/);
  assert.match(data, /for \(const list of \[g\(\)\.Home\?\._apps\]\)/);
  assert.doesNotMatch(data, /Browse\?\._apps/, 'no second list to read');
  assert.match(data, /void platform\.about\(\)\.then/, 'About Homeroom shares the resolver\'s read');
  assert.doesNotMatch(data, /fetch\(`\/api\/platform\/about/, 'and never makes a second one');
});
