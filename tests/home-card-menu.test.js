// Homepage restructure: compact app cards + the "…" actions menu in
// frontend/src/features/home/home.js.
//
// Contract pinned here:
//   - launcher cards emit no `.card-menu-btn` badge and none
//     of the old corner buttons (star / lock / delete / check-updates);
//   - the inline Retry button appears ONLY on errored cards, for the
//     creator or a full admin (canAdminWrite — view-only admins are
//     excluded, issue #311);
//   - menuItemsFor gates each item exactly like the old corner buttons
//     did: favorite-toggle on every app (everyone gets ≥1 item),
//     check-updates/lock behind canAdminWrite, delete behind can_delete
//     (with a full-admin compatibility fallback), retry behind
//     errored + creator-or-admin. #618: member apps get a working
//     Remove/Add pair driven by the per-user your_apps_hidden flag
//     (display-only opt-out; membership/access untouched).
//
// home.js declares `const Home = {…}` at top level; we load it into a vm
// context, stub the globals it reaches, and assert on the returned HTML /
// item lists — same harness as proposal-conflict-affordance.test.js. Its
// source comes from ./helpers/home-modules, which resolves the module's
// post-#1083 location and strips the one `import` line a vm context cannot
// parse.
//
// Run with: node --test tests/home-card-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');

const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore } = require('./helpers/home-grid-store');

function makeHome(user) {
  return makeHomeEnv(user).Home;
}

// Fake 2D context for _widgetIconDataUrl — the vm sandbox has no real
// DOM. It draws a rounded-rect tile (face + hairline) before the glyph,
// so the stub has to answer the path/stroke calls too, not just
// fillRect/fillText.
//
// `paints` records the colour assigned at each fill()/stroke() call, so
// tests can assert WHICH palette was used without a real canvas: the
// tile face is the first fill, the hairline the first stroke, the glyph
// a later fill (emoji leave fillStyle at the face colour — they carry
// their own colour glyphs and are never recoloured).
function fakeCtx(paints) {
  const rec = (kind) => () => {
    if (paints) {
      paints.push({
        op: kind,
        color: kind === 'stroke' ? ctx.strokeStyle : ctx.fillStyle,
      });
    }
  };
  const ctx = {
    fillStyle: null,
    strokeStyle: null,
    beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, roundRect() {},
    fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fill'), fillText: rec('fill'),
  };
  return ctx;
}

// Like makeHome, but also hands back the vm sandbox (=== window inside
// the script) so tests can stub `window.usernode` for bridge-call flows.
function makeHomeEnv(user) {
  const sandbox = {
    console,
    App: { user },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => {
        let t = '';
        return {
          set textContent(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    alert: () => {},
    confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL,
    location: { search: '', origin: 'https://sv.test' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // home.js's iconTileFor / renderAppPillsHtml delegate to the shared card
  // builders (frontend/src/features/apps/app-card.js) since #1083 chunk F.
  // It imports them; this declares what the stripped import would have bound.
  installAppCard(sandbox);
  // #1191: Home.render() no longer bails when #app-list is absent — it
  // publishes a view model instead of assigning innerHTML, so it now runs
  // for real here and needs both the geometry module it lays out against
  // and the store binding ./helpers/home-modules strips the import for.
  installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, sandbox };
}

const ME = 42;
const OTHER = 999;

const baseApp = (over) => ({
  id: 1,
  slug: 'demo-app',
  name: 'Demo App',
  status: 'running',
  created_by: OTHER,
  created_at: '2026-06-01T00:00:00Z',
  last_deploy_at: null,
  repo_url: 'https://github.com/o/r',
  self_hosted: false,
  locked: false,
  is_collaborator: false,
  is_favorited: false,
  active_users: '0',
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  ...over,
});

test('card-menu shot retries after the initial empty home paint', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const frames = [];
  const opened = [];
  sandbox.location.search = '?demo=1&shot=card-menu';
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.requestAnimationFrame = (fn) => { frames.push(fn); };
  Home.openCardMenu = (slug) => { opened.push(slug); };

  const empty = { offsetParent: {}, querySelector: () => null };
  Home._maybeOpenShotMenu(empty);
  assert.equal(Home._shotMenuPending, true);
  frames.shift()();
  assert.equal(Home._shotMenuPending, false);
  assert.equal(Home._shotMenuDone, false,
    'an empty pre-fetch paint must not consume the one-shot');

  const button = { dataset: { slug: 'demo-app' } };
  const populated = {
    offsetParent: {},
    querySelector: (selector) => (selector === '.app-card[data-slug]' ? button : null),
  };
  Home._apps = [baseApp()];
  Home._maybeOpenShotMenu(populated);
  frames.shift()();
  assert.equal(Home._shotMenuDone, true);
  assert.deepEqual(opened, ['demo-app']);
});

// ── Compact card markup ───────────────────────────────────────────

test('card: no hamburger or old corner buttons on launcher tiles', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const html = Home.renderAppCard(baseApp());
  assert.doesNotMatch(html, /card-menu-btn|M4 6h16M4 12h16M4 18h16/);
  assert.doesNotMatch(html, /⋯/, 'no ⋯ glyph anywhere on the card');
  assert.doesNotMatch(html, /star-btn/, 'no inline star');
  assert.doesNotMatch(html, /lock-btn/, 'no inline lock');
  assert.doesNotMatch(html, /delete-btn/, 'no inline delete');
  assert.doesNotMatch(html, /check-updates-btn/, 'no inline check-updates');
});

// ── Pills: menu-header-only builder ───────────────────────────────

test('renderAppPillsHtml: always display-only spans, ordered, self-trimming', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ open_prs: 2, active_sessions: 1, open_issues: 3, missingSecrets: ['K'], view_visibility: 'private' });
  const html = Home.renderAppPillsHtml(app);
  assert.doesNotMatch(html, /<button/, 'no buttons — pills are informational');
  assert.match(html, /Missing secrets/);
  assert.match(html, /2 to vote/);
  assert.match(html, /1 in dev/);
  assert.match(html, /3 issues/);
  assert.match(html, /Private</, 'privacy chip last');
  const order = ['Missing secrets', '2 to vote', '1 in dev', '3 issues', 'Private']
    .map((s) => html.indexOf(s));
  assert.ok(order.every((idx, i) => idx !== -1 && (i === 0 || idx > order[i - 1])),
    'urgency-first ordering preserved');
  // Nothing to flag → empty string, so callers can self-trim.
  assert.equal(Home.renderAppPillsHtml(baseApp()), '');
});

test('menu header: always carries the app’s FULL pill set, inert', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({
    open_prs: 2, open_issues: 1, missingSecrets: ['K'], view_visibility: 'private',
  }));
  assert.match(html, /card-menu-pills/, 'pills block present');
  assert.match(html, /Missing secrets/);
  assert.match(html, /2 to vote/);
  assert.match(html, /1 issue/);
  assert.match(html, /Private</);
  assert.doesNotMatch(html, /<button/, 'header pills are display-only');
  // No flags → block omitted entirely.
  assert.doesNotMatch(Home.renderMenuHeaderHtml(baseApp()), /card-menu-pills/);
});

test('card layout: unobstructed icon first, title below', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.match(html, /w-14 h-14/, 'large icon');
  assert.ok(html.indexOf('app-icon-tile') < html.indexOf('Demo App'));
  assert.doesNotMatch(html, /card-menu-btn/);
  // The old measured-slot machinery is gone from the markup.
  assert.doesNotMatch(html, /card-actions/, 'no floating actions block');
  assert.doesNotMatch(html, /card-footer/, 'no footer row');
  assert.doesNotMatch(html, /card-title-row/, 'no fit-pass title hooks');
});

test('card layout: centered launcher tile, no visible border, capped title width', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp());
  // Icon + title block center horizontally in the tile.
  assert.match(html, /app-card[^"]*flex flex-col items-center text-center/, 'centered column');
  // Long names wrap to two iOS-sized lines and ellipsise there (#951):
  // .app-card-title in app.css owns the size, the clamp and the fixed
  // two-line lane that keeps every tile the same height.
  assert.match(html, /<div class="app-card-title" title="[^"]*">/, 'clamped title lane');
  // The card element itself draws no border — hover tint (app.css) is
  // the affordance. (The hamburger badge keeps its own tiny border.)
  const cardCls = html.match(/class="(app-card [^"]*)"/)[1];
  assert.ok(!/\bborder\b|border-zinc|hover:border/.test(cardCls),
    `no border classes on the card element (got: ${cardCls})`);
});

test('card: Retry remains available on errored cards', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ status: 'error', created_by: ME }));
  assert.match(html, /retry-btn[^"]*absolute top-2 right-2/, 'Retry corner-pinned');
  assert.doesNotMatch(html, /card-menu-btn/, 'launcher badge removed');
  // No Retry on a running card.
  assert.doesNotMatch(Home.renderAppCard(baseApp({ created_by: ME })), /retry-btn/);
});

// A launcher tile is an icon and a label. The active-users badge and the
// status dot that used to flank the name are both gone from the tile face:
// the count still shows in the Browse-all DIRECTORY (a ranked list, where
// popularity is the point), and every non-running status still says so in
// words right below the name.
test('card: the tile carries no users badge and no status dot', () => {
  const Home = makeHome({ id: ME });
  for (const users of ['12', '0']) {
    const html = Home.renderAppCard(baseApp({ active_users: users }));
    assert.doesNotMatch(html, /users-badge/, `users=${users}`);
    assert.doesNotMatch(html, /status-dot/, `users=${users}`);
    assert.doesNotMatch(html, /active user/, `users=${users}`);
  }
  // The word-form status signal survives — that is what makes dropping the
  // dot safe for every state except an in-flight redeploy of a RUNNING app,
  // which now shows only in the "…" menu's version pill.
  assert.match(Home.renderAppCard(baseApp({ status: 'creating' })), /Spinning up/);
  assert.match(Home.renderAppCard(baseApp({ status: 'awaiting_secrets' })), /Awaiting secrets/);
  assert.match(Home.renderAppCard(baseApp({ status: 'error' })), /Error/);
});

test('card: no pills/chips of any kind on the card face', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({
    open_prs: 2, active_sessions: 1, open_issues: 3,
    missingSecrets: ['STRIPE_SECRET_KEY'], view_visibility: 'private',
  }));
  assert.doesNotMatch(html, /activity-chip/, 'no activity chips');
  assert.doesNotMatch(html, /card-pills/, 'no pills row');
  assert.doesNotMatch(html, /to vote|in dev|issue/, 'no activity labels');
  assert.doesNotMatch(html, /Missing secrets/, 'no missing-secrets chip');
  assert.doesNotMatch(html, /Private</, 'no privacy badge');
  assert.doesNotMatch(html, /pill-overflow/, 'no overflow marker');
  // …but the SAME app's menu header carries the full set.
  const header = Home.renderMenuHeaderHtml(baseApp({
    open_prs: 2, active_sessions: 1, open_issues: 3,
    missingSecrets: ['STRIPE_SECRET_KEY'], view_visibility: 'private',
  }));
  assert.match(header, /Missing secrets/);
  assert.match(header, /2 to vote/);
  assert.match(header, /1 in dev/);
  assert.match(header, /3 issues/);
  assert.match(header, /Private</);
});

test('card: no Created/updated rows and no version pill on the card face', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({ active_users: '3' }));
  assert.doesNotMatch(html, /Created /, 'the Created row is gone');
  // "updated Xh ago" lives in the hamburger menu header with the rest
  // of the build info.
  assert.doesNotMatch(html, /updated /, 'no updated segment on the card');
  assert.doesNotMatch(html, /app-version-pill-slot/, 'no pill slot on the card');
});

// ── Missing secrets ───────────────────────────────────────────────

test('missing secrets: key names never render; the chip lives in the menu header only', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ missingSecrets: ['STRIPE_SECRET_KEY', 'SENDGRID_API_KEY'] });
  const card = Home.renderAppCard(app);
  assert.doesNotMatch(card, /Missing secrets/, 'no chip on the card face');
  assert.doesNotMatch(card, /STRIPE_SECRET_KEY|SENDGRID_API_KEY/, 'key names stay off the card');
  const header = Home.renderMenuHeaderHtml(app);
  // The chip's INK moved a step darker for the light theme (a -500 on a 10%
  // tint of itself measured 2.3:1 there); the tint behind it is unchanged, and
  // the assertion is still that this chip is the RED one.
  assert.match(header, /bg-red-500\/10 text-red-700[^>]*>Missing secrets</, 'red chip in the header');
  assert.doesNotMatch(header, /STRIPE_SECRET_KEY|SENDGRID_API_KEY/, 'key names stay out of the header too');
});

test('card: awaiting-secrets keeps its status line, without the key list', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderAppCard(baseApp({
    status: 'awaiting_secrets',
    missingSecrets: ['STRIPE_SECRET_KEY'],
  }));
  assert.match(html, />Awaiting secrets</, 'status label stays');
  assert.doesNotMatch(html, /Awaiting secrets:/, 'no key suffix on the label');
  assert.doesNotMatch(html, /STRIPE_SECRET_KEY/, 'key names stay off the card');
});

test('menu header: no missing-secrets chip when nothing is missing', () => {
  const Home = makeHome({ id: ME });
  assert.doesNotMatch(Home.renderMenuHeaderHtml(baseApp({ missingSecrets: null })), /Missing secrets/);
});

// ── Menu build-info header ────────────────────────────────────────

test('menu header: full untruncated name, slug and deployed commit', () => {
  const Home = makeHome({ id: ME });
  const longName = 'A Very Long Application Name That The Card Face Truncates';
  const html = Home.renderMenuHeaderHtml(baseApp({
    name: longName,
    version: { sha: 'abc1234def', shortSha: 'abc1234' },
  }));
  assert.match(html, /card-menu-title/, 'title block present');
  assert.ok(html.includes(longName), 'full name, untruncated');
  assert.match(html, /card-menu-slug/, 'slug line present');
  assert.ok(html.includes('demo-app'), 'slug shown');
  assert.match(html, /card-menu-version/, 'version block present');
  // AppView is absent in this sandbox, so the fallback commit text
  // renders — it must carry the deployed shortSha.
  assert.ok(html.includes('abc1234'), 'deployed commit shown');
  // "Updated Xh ago" lives here now, not on the card face.
  assert.match(html, /card-menu-updated[^>]*>Updated /, 'updated line present');
});

test('menu header: no SHA yet falls back to the dev placeholder', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({ version: null }));
  assert.match(html, /·\s*dev/, 'placeholder when nothing is deployed');
});

test('menu header: app name is HTML-escaped', () => {
  const Home = makeHome({ id: ME });
  const html = Home.renderMenuHeaderHtml(baseApp({ name: 'Evil <img> & Co' }));
  assert.doesNotMatch(html, /<img>/, 'raw tag never lands in the markup');
  assert.ok(html.includes('Evil &lt;img&gt; &amp; Co'), 'escaped name present');
});

test('updateAppCardPill: refreshes the cached app so the menu header stays fresh', () => {
  const Home = makeHome({ id: ME });
  const app = baseApp({ version: { sha: 'abc1234def', shortSha: 'abc1234' } });
  Home._apps = [app];
  // Deploy-start event: deployProgress lands in the cache, the cached
  // SHA is preserved (the event deliberately carries version: null).
  Home.updateAppCardPill('demo-app', { deployProgress: { deploying: true }, version: null });
  assert.equal(app.deployProgress.deploying, true);
  assert.equal(app.version.shortSha, 'abc1234', 'cached SHA survives deploy start');
  // A version-carrying event replaces it.
  Home.updateAppCardPill('demo-app', { deployProgress: null, version: { shortSha: 'def5678' } });
  assert.equal(app.deployProgress, null);
  assert.equal(app.version.shortSha, 'def5678');
});

test('card: Retry renders inline only on errored cards, creator or full admin', () => {
  // Creator of an errored app → inline Retry.
  let Home = makeHome({ id: ME });
  assert.match(Home.renderAppCard(baseApp({ status: 'error', created_by: ME })), /retry-btn/);
  // Full admin, not creator → inline Retry.
  Home = makeHome({ id: ME, canAdminWrite: true });
  assert.match(Home.renderAppCard(baseApp({ status: 'error' })), /retry-btn/);
  // Bystander on an errored app → no Retry.
  Home = makeHome({ id: ME });
  assert.doesNotMatch(Home.renderAppCard(baseApp({ status: 'error' })), /retry-btn/);
  // Creator of a RUNNING app → no Retry.
  assert.doesNotMatch(Home.renderAppCard(baseApp({ created_by: ME })), /retry-btn/);
});

// ── Menu item gating ──────────────────────────────────────────────

// Copy into a host-realm array — vm-realm Arrays have a foreign
// Array.prototype, which deepStrictEqual rejects.
const keys = (items) => Array.from(items, (i) => i.key);

test('menu: plain user on a non-member app gets App details + the favorite toggle', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items), ['app-details', 'github', 'favorite'],
    'nothing admin-gated leaks');
  assert.equal(items[2].label, 'Add to Your apps');
});

// "View on GitHub" was a row in the hamburger drawer's reference footer,
// revealed by hand while an app was OPEN. As a menu item it reaches both
// surfaces that render this list — the card's "…" menu and the app's own page
// — and gates on the one fact that decides whether it can work at all.
test('menu: View on GitHub appears only for an app with a repository', () => {
  const Home = makeHome({ id: ME });
  const withRepo = Home.menuItemsFor(baseApp());
  const gh = withRepo.find((i) => i.key === 'github');
  assert.ok(gh, 'an app with a repo_url offers it');
  assert.equal(gh.label, 'View on GitHub');

  const without = Home.menuItemsFor(baseApp({ repo_url: null }));
  assert.ok(!keys(without).includes('github'),
    'an app with no repository does not');
});

test('menu: favorited app flips the label to Remove', () => {
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'favorite');
  assert.equal(fav.label, 'Remove from Your apps');
});

test('menu: member apps get a WORKING Remove from Your apps item (#618)', () => {
  // The entry renders for every app so the affordance is always
  // discoverable. #618: membership no longer hard-pins the app —
  // members (creators included) get an active Remove that persists a
  // per-user hidden opt-out row, display-only, access untouched.
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_collaborator: true }))
    .find((i) => i.key === 'favorite');
  assert.ok(fav, 'favorite entry present on member apps');
  assert.equal(fav.disabled, undefined, 'active, not the old inert row');
  assert.equal(fav.label, 'Remove from Your apps');
  assert.equal(typeof fav.run, 'function', 'action wired');
});

test('menu: hidden member apps flip to Add to Your apps (#618)', () => {
  const Home = makeHome({ id: ME });
  const fav = Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true }))
    .find((i) => i.key === 'favorite');
  assert.equal(fav.label, 'Add to Your apps');
  assert.equal(typeof fav.run, 'function');
});

test('menu: member toggle sends the explicit desired value, not !is_favorited (#618)', () => {
  // A pinned member app usually has is_favorited=false, so deriving
  // the target from !is_favorited would send favorited=true (a no-op
  // add) instead of the hide. Pin the wiring by capturing the fetch.
  const Home = makeHome({ id: ME });
  const calls = [];
  Home._menuToggleFavorite = (app, desired) => { calls.push(desired); };
  Home.menuItemsFor(baseApp({ is_collaborator: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'favorite').run();
  Home.menuItemsFor(baseApp())
    .find((i) => i.key === 'favorite').run();
  assert.deepEqual(
    calls,
    [false, true, false, true],
    'visible member → hide, hidden member → re-add, favorite → remove, plain → add'
  );
});

test('menu: the favorite entry IS toggleAdded now, so the menu paints like the rails (#1567)', () => {
  // Two implementations of one write is how the menu and the Discover rails
  // came to disagree about how fast "Your apps" updates. This one delegates,
  // so the optimistic flip, the immediate repaint and the revert-on-failure
  // are the same code from every entry point.
  const Home = makeHome({ id: ME });
  const calls = [];
  Home.toggleAdded = (slug, desired) => { calls.push([slug, desired]); };
  Home._menuToggleFavorite(baseApp({ slug: 'plain' }), true);
  Home._menuToggleFavorite(baseApp({ slug: 'mine', is_collaborator: true }), false);
  // The !is_favorited fallback for a legacy caller that passes no value.
  Home._menuToggleFavorite(baseApp({ slug: 'starred', is_favorited: true }));
  assert.deepEqual(calls, [['plain', true], ['mine', false], ['starred', false]]);
});

// ── App details ───────────────────────────────────────────────────
//
// The menu's way to the app's own page — the SAME destination a row in
// the browse-all-apps list opens (#apps/<slug>), so the two entry points
// share one screen. Browse.DETAIL_EXCLUDED_KEYS drops it again on that
// page (pinned in tests/browse-screen.test.js) so it can't link to
// itself.

test('menu: App details leads the list, on every app and for every viewer', () => {
  for (const user of [
    { id: ME },
    { id: ME, isAdmin: true, canAdminWrite: false },
    { id: ME, canAdminWrite: true },
  ]) {
    const Home = makeHome(user);
    for (const over of [
      {},
      { is_collaborator: true },
      { is_favorited: true },
      { status: 'error', created_by: ME },
      { self_hosted: true },
      { locked: true },
    ]) {
      const items = Home.menuItemsFor(baseApp(over));
      assert.equal(items[0].key, 'app-details',
        `first for ${JSON.stringify(over)} / ${JSON.stringify(user)}`);
      assert.equal(items[0].label, 'App details');
    }
  }
});

test('menu: App details routes through the hash, like a browse row tap', () => {
  // Assigning location.hash (rather than calling a navigate helper) is
  // what keeps the browser/OS back gesture working.
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  Home.menuItemsFor(baseApp({ slug: 'chess-arena' }))
    .find((i) => i.key === 'app-details').run();
  assert.equal(sandbox.location.hash, '#apps/chess-arena');
});

test('menu: App details escapes the slug into the hash', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  Home.menuItemsFor(baseApp({ slug: 'a b&c' }))
    .find((i) => i.key === 'app-details').run();
  assert.equal(sandbox.location.hash, `#apps/${encodeURIComponent('a b&c')}`);
});

test('menu: the inert ?demo=1 tiles get no App details row', () => {
  // Their slugs 404 on GET /api/apps/:slug, so the page would open on an
  // inline "not available" state — same reason a demo row doesn't drill in.
  const Home = makeHome({ id: ME });
  assert.ok(!keys(Home.menuItemsFor(baseApp({ demo: true }))).includes('app-details'));
  // …and a slugless row can't be addressed at all.
  assert.ok(!keys(Home.menuItemsFor(baseApp({ slug: null }))).includes('app-details'));
});

test('menu: every app carries a favorite entry — no card menu omits it', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  for (const over of [
    {},
    { is_collaborator: true },
    { is_favorited: true },
    { status: 'error', created_by: ME },
    { self_hosted: true },
  ]) {
    const items = Home.menuItemsFor(baseApp(over));
    assert.ok(keys(items).includes('favorite'),
      `favorite entry present for ${JSON.stringify(over)}`);
  }
});

test('menu: full admin on a running repo app gets check-updates, lock and delete', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const items = Home.menuItemsFor(baseApp());
  assert.deepEqual(keys(items),
    ['app-details', 'github', 'favorite', 'check-updates', 'lock', 'delete']);
  assert.equal(items.find((i) => i.key === 'lock').label, 'Lock app');
  assert.equal(items.find((i) => i.key === 'delete').danger, true);
});

test('menu: a sole contributor gets Delete app without admin-only controls (#1897)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({
    created_by: ME,
    contributor_count: 1,
    can_delete: true,
  }));
  assert.ok(keys(items).includes('delete'));
  assert.ok(!keys(items).includes('lock'), 'sole contributor is not made an admin');
  assert.equal(items.find((i) => i.key === 'delete').danger, true);
});

test('menu: an ineligible creator or app admin gets no Delete app action (#1897)', () => {
  const Home = makeHome({ id: ME });
  assert.ok(!keys(Home.menuItemsFor(baseApp({
    created_by: ME,
    contributor_count: 2,
    can_delete: false,
  }))).includes('delete'));
  assert.ok(!keys(Home.menuItemsFor(baseApp({
    created_by: OTHER,
    can_manage: true,
    can_delete: false,
  }))).includes('delete'), 'general app management does not grant deletion');
});

test('menu: locked app offers Unlock', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const items = Home.menuItemsFor(baseApp({ locked: true }));
  assert.equal(items.find((i) => i.key === 'lock').label, 'Unlock app');
});

test('menu: check-updates hidden without repo / when not running / when self-hosted', () => {
  const Home = makeHome({ id: ME, canAdminWrite: true });
  const has = (over) =>
    keys(Home.menuItemsFor(baseApp(over))).includes('check-updates');
  assert.equal(has({}), true, 'baseline: admin + repo + running');
  assert.equal(has({ repo_url: null }), false, 'no repo');
  assert.equal(has({ status: 'error' }), false, 'not running');
  assert.equal(has({ self_hosted: true }), false, 'self-hosted');
});

test('menu: view-only admins (no canAdminWrite) get no mutating items (#311)', () => {
  const Home = makeHome({ id: ME, isAdmin: true, canAdminWrite: false });
  const items = Home.menuItemsFor(baseApp({ status: 'error' }));
  // App details is navigation, not a mutation, so it survives the gate.
  assert.deepEqual(keys(items), ['app-details', 'github', 'favorite'],
    'no retry/check/lock/delete');
});

test('menu: errored app adds Retry + View build log for the creator (#416)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ status: 'error', created_by: ME }));
  assert.deepEqual(keys(items),
    ['app-details', 'github', 'favorite', 'retry', 'build-log']);
});

// ── "View build log" gating (#416) ────────────────────────────────
//
// Errored apps: item for involved users (creator / collaborator /
// full admin). Running apps: only when the last recorded failure
// post-dates the last successful deploy (a failed rebuild) — and the
// last_failure_* fields only reach the client when the server-side
// involved-user gate passed, so outsiders never have the timestamps.

test('menu: build-log hidden from outsiders and view-only admins on errored apps (#416)', () => {
  const outsider = makeHome({ id: ME });
  assert.ok(!keys(outsider.menuItemsFor(baseApp({ status: 'error' }))).includes('build-log'));
  const viewOnlyAdmin = makeHome({ id: ME, isAdmin: true, canAdminWrite: false });
  assert.ok(!keys(viewOnlyAdmin.menuItemsFor(baseApp({ status: 'error' }))).includes('build-log'));
});

test('menu: build-log shows for collaborators on errored apps (#416)', () => {
  const Home = makeHome({ id: ME });
  const items = Home.menuItemsFor(baseApp({ status: 'error', is_collaborator: true }));
  assert.ok(keys(items).includes('build-log'));
});

test('menu: build-log on a RUNNING app only when the failure post-dates the deploy (#416)', () => {
  const Home = makeHome({ id: ME });
  const failedRebuild = baseApp({
    created_by: ME,
    last_deploy_at: '2026-07-01T00:00:00Z',
    last_failure_at: '2026-07-02T00:00:00Z',
    last_failure_reason: 'Build failed: failed to read dockerfile',
  });
  assert.ok(keys(Home.menuItemsFor(failedRebuild)).includes('build-log'));

  const staleFailure = baseApp({
    created_by: ME,
    last_deploy_at: '2026-07-03T00:00:00Z',
    last_failure_at: '2026-07-02T00:00:00Z',
  });
  assert.ok(!keys(Home.menuItemsFor(staleFailure)).includes('build-log'));

  const noFailure = baseApp({ created_by: ME });
  assert.ok(!keys(Home.menuItemsFor(noFailure)).includes('build-log'));
});

// ── Native homescreen-shortcut item ───────────────────────────────
//
// The item is gated on Home._shortcutSupport, populated by the bridge
// probe (_probeShortcutSupport). Null (plain browser, probe not run,
// old app build → bridge resolves unsupported) must hide it — pinned
// by every exact-key assertion above running with the default null.

test('menu: shortcut item hidden by default (no support probed)', () => {
  const Home = makeHome({ id: ME });
  assert.equal(Home._shortcutSupport, null, 'probe cache starts null');
  assert.doesNotMatch(
    JSON.stringify(keys(Home.menuItemsFor(baseApp()))),
    /add-to-homescreen/
  );
});

test('menu: shortcut item renders when the bridge reports support', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  // "Your apps" only — favorited (or collaborator) apps get the item.
  const items = Home.menuItemsFor(baseApp({ is_favorited: true }));
  assert.deepEqual(keys(items),
    ['app-details', 'github', 'favorite', 'add-to-homescreen']);
  assert.equal(
    items.find((i) => i.key === 'add-to-homescreen').label,
    'Add to phone home screen'
  );
  // iOS widget mechanism counts as supported too, and names the widget
  // as the destination.
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: false };
  const widgetItems = Home.menuItemsFor(baseApp({ is_collaborator: true }));
  const shortcutItem = widgetItems.find((i) => i.key === 'add-to-homescreen');
  assert.ok(shortcutItem, 'item present for widget mechanism');
  assert.equal(shortcutItem.label, 'Add to Homeroom widget');
  assert.ok(!shortcutItem.disabled, 'actionable when not yet in the widget');
});

test('menu: shortcut item only offered on "Your apps"', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: true };
  // Not favorited, not a collaborator → no item even with support.
  assert.equal(
    keys(Home.menuItemsFor(baseApp())).includes('add-to-homescreen'), false,
    'directory apps do not get the widget item'
  );
  assert.ok(
    keys(Home.menuItemsFor(baseApp({ is_favorited: true }))).includes('add-to-homescreen')
  );
  assert.ok(
    keys(Home.menuItemsFor(baseApp({ is_collaborator: true }))).includes('add-to-homescreen')
  );
  // #618: a member app hidden from "Your apps" is no longer "yours",
  // so the widget item disappears until it's added back.
  assert.equal(
    keys(Home.menuItemsFor(baseApp({ is_collaborator: true, your_apps_hidden: true })))
      .includes('add-to-homescreen'),
    false,
    'hidden member apps lose the widget item'
  );
});

test('menu: shortcut item becomes "Edit in Homeroom widget" once added', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget', widgetInstalled: true };
  Home._widgetItems = [
    { id: 'abc', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
  ];
  // The flip is data-based: it must apply even while the widget section
  // itself is still hidden (_widgetSectionVisible false).
  assert.equal(Home._widgetSectionVisible, false);
  const item = Home.menuItemsFor(baseApp({ is_favorited: true }))
    .find((i) => i.key === 'add-to-homescreen');
  assert.ok(item, 'item still renders');
  assert.equal(item.label, 'Edit in Homeroom widget');
  assert.ok(!item.disabled, 'stays actionable — it opens the section');
  // Running it reveals the management section.
  item.run();
  assert.equal(Home._widgetSectionVisible, true, 'edit opens the widget section');
  // An app not yet in the widget keeps the add label.
  const other = Home.menuItemsFor(baseApp({ slug: 'other-app', is_favorited: true }))
    .find((i) => i.key === 'add-to-homescreen');
  assert.equal(other.label, 'Add to Homeroom widget');
});

// ── Homeroom widget section ───────────────────────────────────────
//
// The iOS-only strip above "Your apps". It must render nothing unless BOTH
// the bridge reported mechanism 'widget' AND the registry fetch succeeded
// (_widgetItems is an array) — old app builds time out to null and plain
// browsers never probe, so the section (and its management calls) can't
// appear where they'd fail.
//
// #1191 split the one `renderWidgetSection()` these were written against into
// the two halves the React conversion makes: `Home.widgetSectionView()`
// decides (it is where all three gates above still live) and
// features/home/widget-strip.tsx's `WidgetStripBody` draws. `sectionHtml`
// runs both, so every assertion below still executes the rendering rather
// than grepping for it — and `''` still means "nothing", because the body
// returns null for an inactive strip.
const { renderComponent } = require('./lib/render-tsx');

const WIDGET_STRIP = 'frontend/src/features/home/widget-strip.tsx';

function sectionHtml(Home) {
  return renderComponent(WIDGET_STRIP, 'WidgetStripBody', { strip: Home.widgetSectionView() });
}

test('widget section: hidden unless revealed + widget mechanism + registry', () => {
  const Home = makeHome({ id: ME });
  assert.equal(sectionHtml(Home), '', 'no probe → nothing');
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
  ];
  // Everything supported and fetched, but the user hasn't clicked
  // "Add to Homeroom widget" yet → still hidden by default.
  assert.equal(sectionHtml(Home), '', 'hidden until revealed');
  Home._widgetSectionVisible = true;
  assert.match(sectionHtml(Home), /id="widget-strip"/, 'revealed');
  Home._widgetItems = null;
  assert.equal(sectionHtml(Home), '', 'no registry fetched → nothing');
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  Home._widgetItems = [];
  assert.equal(sectionHtml(Home), '', 'Android pins → no section');
});

test('menu click: reveals the section and auto-adds when there is room', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [];
  assert.equal(Home._widgetSectionVisible, false, 'hidden before the click');
  await Home._menuAddShortcut(baseApp({ is_favorited: true }));
  assert.equal(Home._widgetSectionVisible, true, 'click reveals the section');
  assert.equal(added.length, 1, 'app auto-added when the widget has room');
  assert.equal(added[0].url, 'https://sv.test/app/demo-app');
});

test('menu click: full widget shakes instead of adding', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = Array.from({ length: Home.WIDGET_CAPACITY }, (_, i) => (
    { id: `w${i}`, name: `Dapp ${i}`, url: `https://elsewhere.test/${i}` }
  ));
  let shook = false;
  Home._shakeWidgetStrip = () => { shook = true; };
  await Home._menuAddShortcut(baseApp({ is_favorited: true }));
  assert.equal(Home._widgetSectionVisible, true, 'section still revealed');
  assert.equal(added.length, 0, 'nothing added past capacity');
  assert.equal(shook, true, 'the widget strip shakes');
});

test('widget section: tiles in registry order, each with a remove button', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._apps = [baseApp()];
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app' },
    { id: 'w2', name: 'Other Dapp', url: 'https://elsewhere.test/thing' },
  ];
  const html = sectionHtml(Home);
  assert.match(html, /Homeroom widget/, 'section header');
  assert.match(html, /id="widget-section-close"/, 'header has a Done/close button');
  assert.match(html, /id="widget-strip"/);
  assert.equal((html.match(/class="widget-tile /g) || []).length, 2);
  assert.equal((html.match(/widget-remove-btn/g) || []).length, 2);
  assert.ok(
    html.indexOf('data-wid="w1"') < html.indexOf('data-wid="w2"'),
    'tiles follow registry order'
  );
  // The SV-app tile resolves its slug; the foreign-dapp tile doesn't.
  assert.match(html, /data-wslug="demo-app"/);
  assert.doesNotMatch(html, /data-wslug="other/i);
  // Empty registry still renders the strip as a drop target.
  Home._widgetItems = [];
  const empty = sectionHtml(Home);
  assert.match(empty, /id="widget-strip"/);
  assert.doesNotMatch(empty, /widget-tile /);
  // The hint names "Your apps" as the drag source now: the home grid holds
  // that one section (every other app moved to the #apps browse screen).
  assert.match(empty, /Drag a card from Your apps here/);
});

test('widget section: help icon toggles the add-widget instructions', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._widgetItems = [];
  let html = sectionHtml(Home);
  assert.match(html, /id="widget-section-help"/, 'header has the info button');
  assert.doesNotMatch(html, /widget-help-panel/, 'panel hidden by default');
  Home._widgetHelpVisible = true;
  html = sectionHtml(Home);
  assert.match(html, /id="widget-help-panel"/, 'panel shown after toggle');
  assert.match(html, /Add Widget/, 'panel explains the iOS add-widget flow');
});

test('shortcut icons: emoji/letter apps get a canvas data URI, image apps a URL', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // Fake 2D canvas — the vm sandbox has no real DOM.
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  await Home._addShortcutForApp(baseApp({ icon_emoji: '\u{1F3AF}' }));
  assert.equal(added[0].icon_url, 'data:image/png;base64,FAKE', 'emoji tile rendered to data URI');
  await Home._addShortcutForApp(baseApp({ icon_url: '/icons/x.png' }));
  assert.equal(added[1].icon_url, 'https://sv.test/icons/x.png', 'real icons pass through as absolute URLs');
});

test('icon heal: has_icon:false entries are silently re-added once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
        { id: 'w3', name: 'Foreign', url: 'https://elsewhere.test/x', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  // 'Iconed' has a real image icon whose recorded source is current, so
  // with has_icon:true nothing re-sends it.
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ w2: 'https://sv.test/icons/x.png' })
  );
  await Home._refreshWidgetItems();
  // Only the SV app missing its icon is re-added; the healthy entry and
  // the foreign shortcut are left alone. The re-add is marked silent so
  // the app skips the add-the-widget walkthrough.
  assert.equal(added.length, 1);
  assert.equal(added[0].url, 'https://sv.test/app/demo-app');
  assert.equal(added[0].silent, true);
  // Second refresh: already tried — no repeat even though the mock
  // still reports has_icon:false.
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'one heal attempt per id per page load');
});

test('icon heal: retries entries skipped while apps were still loading', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = []; // probe ran before /api/apps resolved
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing healable without app objects');
  Home._apps = [baseApp()];
  await Home._healWidgetIcons();
  assert.equal(added.length, 1, 'healed once the apps list landed');
});

test('icon heal: unknown last-sent source re-sends once, then settles', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Fresh env: no recorded sources → both re-sent once (the recorded
  // source is unknown, so the stored PNG can't be trusted).
  await Home._refreshWidgetItems();
  assert.equal(added.length, 2, 'both entries refreshed when sources are unknown');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(
    srcMap.w1,
    `tile:${Home.WIDGET_ICON_GEN}:${Home._widgetScheme()}:`,
    'canvas tile source recorded, keyed by generation + colour scheme'
  );
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image icon source recorded');
  // Sources now recorded → later refreshes send nothing.
  Home._iconHealTried = null; // even across a fresh page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 2, 'no repeat once sources are recorded');
});

test('icon heal: app gaining an icon after pinning re-sends the new icon', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  // Pinned as a canvas letter tile — recorded source matches, so the
  // first pass sends nothing.
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ w1: `tile:${Home.WIDGET_ICON_GEN}:${Home._widgetScheme()}:` })
  );
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'up-to-date tile is left alone');
  // An icon proposal passes: the app now has an icon_url. The widget
  // PNG (still the letter tile) is stale even though has_icon:true.
  Home._apps = [baseApp({ icon_url: '/icons/new.png' })];
  Home._iconHealTried = null; // fresh page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'stale tile re-sent after the app gained an icon');
  assert.equal(added[0].icon_url, 'https://sv.test/icons/new.png');
  assert.equal(added[0].silent, true);
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, 'https://sv.test/icons/new.png', 'new source recorded');
});

// ── Widget tile palette follows the system appearance ────────────────
//
// The widget PNG is baked once and can't restyle itself on the
// homescreen, so the palette is picked at render time from
// prefers-color-scheme and the scheme rides in the source marker. A
// light↔dark flip therefore has to (a) paint the other palette and
// (b) actually re-send every pinned canvas tile.

// Installs a settable prefers-color-scheme query on the sandbox and
// returns a setter that fires the registered change listeners, so a
// test can flip the system appearance the way the OS would.
function stubScheme(sandbox, initialDark) {
  let dark = !!initialDark;
  const listeners = [];
  sandbox.matchMedia = (media) => ({
    media,
    get matches() { return dark; },
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: () => {},
  });
  return (next) => {
    dark = !!next;
    listeners.forEach((fn) => fn({ matches: dark }));
  };
}

test('widget tile PNG paints the light palette in light appearance', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubScheme(sandbox, false);
  const paints = [];
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(paints),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  Home._widgetIconDataUrl(baseApp());
  const face = paints.find((p) => p.op === 'fill');
  const hairline = paints.find((p) => p.op === 'stroke');
  const glyph = paints.filter((p) => p.op === 'fill').pop();
  assert.equal(face.color, '#ffffff', 'white face');
  assert.equal(hairline.color, '#e4e4e7', 'faint light-grey hairline');
  assert.equal(glyph.color, '#a1a1aa', 'faint grey letter (--text-faint)');
});

test('widget tile PNG paints the dark palette in dark appearance', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubScheme(sandbox, true);
  const paints = [];
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(paints),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  Home._widgetIconDataUrl(baseApp());
  const face = paints.find((p) => p.op === 'fill');
  const hairline = paints.find((p) => p.op === 'stroke');
  const glyph = paints.filter((p) => p.op === 'fill').pop();
  assert.equal(face.color, '#1a1a30', 'dark face (--bg-secondary)');
  assert.equal(hairline.color, '#2e2e50', 'hairline kept, stepped to --border');
  assert.equal(glyph.color, '#9898b0', 'faint letter (--text-faint, dark)');
  // The hairline is what keeps the tile legible against iOS's own dark
  // widget material — a dark face with no ring would vanish.
  assert.notEqual(hairline.color, face.color);
});

test('widget tile PNG never recolours an emoji glyph', () => {
  for (const dark of [false, true]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubScheme(sandbox, dark);
    const paints = [];
    sandbox.document.createElement = () => ({
      getContext: () => fakeCtx(paints),
      toDataURL: () => 'data:image/png;base64,FAKE',
    });
    Home._widgetIconDataUrl(baseApp({ icon_emoji: '\u{1F3AF}' }));
    const palette = Home.WIDGET_TILE_PALETTE[dark ? 'dark' : 'light'];
    const glyph = paints.filter((p) => p.op === 'fill').pop();
    assert.notEqual(glyph.color, palette.letter, 'emoji keep their own colours');
  }
});

test('icon heal: a system light→dark flip re-sends every canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  const setDark = stubScheme(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Both already pinned with current sources → the first pass is quiet.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
    w2: 'https://sv.test/icons/x.png',
  }));
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing to do while the scheme is unchanged');

  // The phone switches to dark appearance.
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 1, 'exactly the canvas tile re-sends');
  assert.equal(added[0].url, 'https://sv.test/app/demo-app');
  assert.equal(added[0].silent, true, 're-send stays silent — no walkthrough');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dark:`, 'dark source recorded');
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image tile untouched');

  // A second event at the SAME scheme must not re-send anything: the
  // equality guard is what stops a spurious media event from replaying
  // the whole grid.
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 1, 'no re-send when the scheme did not move');

  // …and flipping back re-sends once more, in the light palette.
  setDark(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 2, 'flipping back re-sends once');
  const back = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(back.w1, `tile:${Home.WIDGET_ICON_GEN}:light:`);
});

// _iconHealTried caps sends to one attempt per shortcut id per page
// load. A scheme flip marks every canvas tile stale, so without
// clearing that Set the flip would find the work and then skip it —
// the re-send would silently never happen.
test('icon heal: a scheme flip clears the per-load heal-tried set', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // A shell that genuinely cannot hold a pair: conclusive `false` plus
  // the behavioural verdict on file, so the gen-5 single-face path below
  // is exercised without the confirmation send.
  stubCapability(sandbox, false);
  const setDark = stubScheme(sandbox, false);
  sandbox.document.createElement = () => ({
    getContext: () => fakeCtx(),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'healed once on load');
  assert.ok(Home._iconHealTried && Home._iconHealTried.has('w1'), 'id marked tried');

  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 2, 'the flip re-sends despite the earlier attempt');
});

test('scheme watching is inert without the widget mechanism', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const setDark = stubScheme(sandbox, false);
  const added = [];
  sandbox.usernode = {
    isNative: false,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
  };
  // Plain browser / Android: the probe never reports the widget grid.
  Home._shortcutSupport = null;
  Home._apps = [baseApp()];
  Home._watchWidgetScheme();
  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 0, 'no bridge traffic off the widget path');
});

// ── Dual-icon sender half (#948) ─────────────────────────────────────
//
// Where the shell advertises homeScreenShortcutDarkIcon, SV sends BOTH
// faces and the widget picks per system appearance — natively, with SV
// closed, which is the only way a pinned tile can follow a flip. Where
// it doesn't, every assertion above still holds: the gen-5 single-face
// path is untouched.

// Installs a NativeChrome answering the capability probe. `capable`
// false still installs one, so the "shell exists but lacks the flag"
// case is covered as well as the plain-browser no-NativeChrome case.
//
// `supports`, not `has`: the probe is tri-state now, and `null` means
// "could not say" (see Home._probeDarkIconCapability). Pass `null` for
// that case explicitly.
//
// A conclusive `false` no longer settles the question on its own — SV
// confirms it behaviourally, because a shell can store the dark asset in
// a build earlier than the one that advertises it. So `capable === false`
// also files the matching verdict against this stub's version pair,
// which is what "this shell genuinely can't" means to the code under
// test. Tests that want the confirmation itself pass `null` or seed
// their own verdict.
const STUB_BUILD = { appVersion: '1.4.0', buildNumber: '1223' };

function stubCapability(sandbox, capable, opts = {}) {
  const build = opts.build || STUB_BUILD;
  sandbox.NativeChrome = {
    supports: async (cap) => (cap === 'homeScreenShortcutDarkIcon'
      ? (capable === true ? true : (capable === false ? false : null))
      : null),
    getInfo: async () => ({
      version: 4,
      capabilities: capable === true ? ['homeScreenShortcutDarkIcon'] : [],
      appVersion: build.appVersion,
      buildNumber: build.buildNumber,
    }),
  };
  if (capable === false && opts.verdict !== false) {
    stubVerdict(sandbox, 'unsupported', build);
  }
}

// Pre-files a behavioural verdict, as a previous page load would have.
function stubVerdict(sandbox, verdict, build = STUB_BUILD) {
  sandbox.localStorage.setItem('sv:widget_dark_icons', JSON.stringify({
    appVersion: build.appVersion,
    buildNumber: build.buildNumber,
    verdict,
  }));
}

function stubCanvas(sandbox, paints) {
  let n = 0;
  sandbox.document.createElement = () => {
    const mine = ++n;
    return {
      getContext: () => fakeCtx(paints),
      // Distinct bytes per render, so a test can prove the payload
      // carries two DIFFERENT images rather than the same one twice.
      toDataURL: () => `data:image/png;base64,FAKE${mine}`,
    };
  };
}

test('payload: capable shell gets both faces, light first', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, true); // system dark — must not shift the pair
  const paints = [];
  stubCanvas(sandbox, paints);
  await Home._ensureDarkIconCapability();

  const payload = Home._shortcutPayloadFor(baseApp());
  assert.ok(payload.icon_url, 'light asset present');
  assert.ok(payload.icon_url_dark, 'dark asset present');
  assert.notEqual(payload.icon_url, payload.icon_url_dark, 'two distinct images');
  // Face fills, in render order: light tile first, then the dark one.
  const faces = paints.filter((p) => p.op === 'fill').map((p) => p.color);
  assert.ok(faces.includes('#ffffff'), 'light face painted');
  assert.ok(faces.includes('#1a1a30'), 'dark face painted');
  assert.ok(faces.indexOf('#ffffff') < faces.indexOf('#1a1a30'),
    'icon_url is the LIGHT asset — a shell that renders only it stays sane');
});

test('payload: the pair does not move with the system appearance', async () => {
  const shots = [];
  for (const dark of [false, true]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubCapability(sandbox, true);
    stubScheme(sandbox, dark);
    const paints = [];
    stubCanvas(sandbox, paints);
    await Home._ensureDarkIconCapability();
    Home._shortcutPayloadFor(baseApp());
    shots.push(paints.filter((p) => p.op === 'fill' || p.op === 'stroke')
      .map((p) => p.color).join(','));
  }
  assert.equal(shots[0], shots[1],
    'identical paints in light and dark — nothing to re-send on a flip');
});

test('payload: non-capable shell keeps the single per-appearance face', async () => {
  for (const [dark, face] of [[false, '#ffffff'], [true, '#1a1a30']]) {
    const { Home, sandbox } = makeHomeEnv({ id: ME });
    stubCapability(sandbox, false);
    stubScheme(sandbox, dark);
    const paints = [];
    stubCanvas(sandbox, paints);
    await Home._ensureDarkIconCapability();

    const payload = Home._shortcutPayloadFor(baseApp());
    assert.ok(payload.icon_url, 'the one asset is sent');
    assert.ok(!('icon_url_dark' in payload),
      'the key is OMITTED, not null — byte-identical to the pre-change payload');
    assert.equal(paints.find((p) => p.op === 'fill').color, face,
      'the face matches the current system appearance');
  }
});

test('payload: no NativeChrome at all behaves exactly like not-capable', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  assert.equal(sandbox.NativeChrome, undefined);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  await Home._ensureDarkIconCapability();
  const payload = Home._shortcutPayloadFor(baseApp());
  assert.ok(!('icon_url_dark' in payload));
});

test('payload: image icons never get a dark twin', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  await Home._ensureDarkIconCapability();

  const payload = Home._shortcutPayloadFor(baseApp({ icon_url: '/icons/x.png' }));
  assert.equal(payload.icon_url, 'https://sv.test/icons/x.png');
  assert.ok(!('icon_url_dark' in payload),
    "the author's artwork is appearance-independent — a second copy is pure waste");
});

// The capable path's whole point: a flip is a non-event, because both
// faces are already on the device and the widget picks between them.
test('icon heal: on a capable shell a light↔dark flip re-sends nothing', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  const setDark = stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  Home._watchWidgetScheme();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing stale to begin with');

  setDark(true);
  await new Promise((r) => setTimeout(r, 0));
  setDark(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(added.length, 0, 'the appearance is not an input on this path');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dual:`, 'marker unmoved');
});

// Installing a capable shell is the one transition that costs a
// re-send: the stored single face has to become a pair.
test('icon heal: gaining the capability re-sends each canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: true },
        { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  // Pinned by a pre-capability build: single light face, image URL.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
    w2: 'https://sv.test/icons/x.png',
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'exactly the canvas tile upgrades');
  assert.ok(added[0].icon_url_dark, 'and it now carries both faces');
  assert.equal(added[0].silent, true, 'silently — no walkthrough, order kept');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dual:`);
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image tile untouched');

  Home._iconHealTried = null; // a later page load
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'and then settles');
});

// The guarantee for everyone on a shell without the flag: this whole
// change is a no-op for them. Same marker, same payload, no churn.
test('icon heal: a non-capable shell sends nothing for a gen-5 entry', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'zero churn for the shells people actually have');
});

// has_icon_dark is what catches an entry whose marker already matches
// but whose second asset never landed.
test('icon heal: has_icon_dark:false re-sends a canvas tile once', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  // Marker already current — only the flag betrays the missing asset.
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'the missing dark asset is re-sent');
  assert.ok(added[0].icon_url_dark);
});

test('icon heal: an absent has_icon_dark key never triggers a send', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    // An older shell reports neither key.
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:dual:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'undefined is not false — no send');
});

// ── Behavioural confirmation ─────────────────────────────────────────
//
// The capability list is not the last word, because it can be silent for
// reasons that say nothing about storage: a degraded getBridgeInfo
// reports no capabilities at all, and a shell can ship the storage in a
// build earlier than the one that advertises the string. Both looked
// identical to "this build can't", which is how a released shell fix
// stayed invisible. When the list can't give a conclusive yes, SV sends
// one pair and reads the registry back.

test('unknown capability: one pair is sent and has_icon_dark settles it', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, null); // degraded probe — "couldn't say"
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  let storedDark = false;
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => {
      added.push(opts);
      // A shell that really does hold the second face.
      storedDark = !!opts.icon_url_dark;
      return { added: true };
    },
    getHomeScreenShortcuts: async () => ({
      items: [{
        id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app',
        has_icon: true, has_icon_dark: storedDark,
      }],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'exactly one send — the probe itself heals the tile');
  assert.ok(added[0].icon_url_dark, 'and it carries both faces');
  assert.equal(Home._widgetDarkIcons, true, 'the read-back overrides the silent list');
  const rec = JSON.parse(sandbox.localStorage.getItem('sv:widget_dark_icons'));
  assert.deepEqual(rec, { appVersion: '1.4.0', buildNumber: '1223', verdict: 'supported' });
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dual:`,
    'the probe records its own marker, so the pass does not re-send it');
});

test('unknown capability: a refused pair is repainted for the current scheme', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, null);
  stubScheme(sandbox, true); // dark homescreen — the case that looks wrong
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    // Accepts the field and throws it away, which is what the flag says.
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [{
        id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app',
        has_icon: true, has_icon_dark: false,
      }],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._refreshWidgetItems();
  assert.equal(Home._widgetDarkIcons, false, 'the read-back is believed');
  assert.equal(
    JSON.parse(sandbox.localStorage.getItem('sv:widget_dark_icons')).verdict,
    'unsupported'
  );
  // The probe pair's PRIMARY face is the light one, so a shell that keeps
  // only icon_url has just been handed a white tile for a dark
  // homescreen. Asking the question must not leave the tile worse than
  // never asking it.
  assert.equal(added.length, 2, 'the probe is followed by a corrective send');
  assert.equal('icon_url_dark' in added[1], false, 'the repaint is a single face');
  assert.notEqual(added[1].icon_url, added[0].icon_url, 'and it is the dark face');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:dark:`);
});

test('a stored verdict short-circuits the confirmation entirely', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, null, { verdict: false });
  stubVerdict(sandbox, 'unsupported');
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [{
        id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app',
        has_icon: true, has_icon_dark: false,
      }],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'a settled question is not re-asked every load');
  assert.equal(Home._widgetDarkIcons, false);
});

test('an app update discards the verdict and re-confirms', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  // Measured on the build BEFORE the one that is running now.
  stubCapability(sandbox, null, { verdict: false });
  stubVerdict(sandbox, 'unsupported', { appVersion: '1.3.0', buildNumber: '1100' });
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  let storedDark = false;
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => {
      added.push(opts);
      storedDark = !!opts.icon_url_dark;
      return { added: true };
    },
    getHomeScreenShortcuts: async () => ({
      items: [{
        id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app',
        has_icon: true, has_icon_dark: storedDark,
      }],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'the new build is asked again');
  assert.ok(added[0].icon_url_dark);
  assert.equal(Home._widgetDarkIcons, true, 'and the update is picked up');
  assert.equal(
    JSON.parse(sandbox.localStorage.getItem('sv:widget_dark_icons')).appVersion,
    '1.4.0', 'the verdict is re-bound to the build it was measured on'
  );
});

test('a refused confirmation records no verdict at all', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, null);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async () => { throw new Error('denied'); },
    getHomeScreenShortcuts: async () => ({
      items: [{
        id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app',
        has_icon: true, has_icon_dark: false,
      }],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  await Home._refreshWidgetItems();
  // A send that never landed proves nothing about what the shell stores;
  // recording "unsupported" here would be the latched negative again,
  // just reached by a different route.
  assert.equal(sandbox.localStorage.getItem('sv:widget_dark_icons'), null);
  assert.equal(Home._widgetDarkIcons, null, 'the question stays open');
});

// Image-icon entries are dark-assetless forever by design, so without
// the !app.icon_url clause they would look stale on every single pass.
test('icon heal: an image-icon entry with has_icon_dark:false is left alone', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, true);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: true, has_icon_dark: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' })];
  await Home._ensureDarkIconCapability();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: 'https://sv.test/icons/x.png',
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'no per-pass re-send loop for image icons');
});

// ── Foreground re-heal + pass serialisation ──────────────────────────
//
// The shell can restore the webview without a page load, so neither
// Home.load() nor the probe necessarily re-runs on reopen. This is also
// how a freshly installed capable shell gets picked up.

// Settable document.visibilityState plus a real listener registry, so a
// test can background and foreground the app the way the shell would.
function stubForeground(sandbox) {
  const listeners = [];
  sandbox.document.visibilityState = 'visible';
  sandbox.document.addEventListener = (type, fn) => {
    if (type === 'visibilitychange') listeners.push(fn);
  };
  return async (state) => {
    sandbox.document.visibilityState = state;
    listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
  };
}

test('icon heal: a foreground re-runs the pass despite an earlier attempt', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const foreground = stubForeground(sandbox);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({
      items: [
        { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
      ],
    }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  Home._watchWidgetForeground();
  await Home._refreshWidgetItems();
  assert.equal(added.length, 1, 'healed once on load');
  assert.ok(Home._iconHealTried?.has('w1'), 'id marked tried');

  // The registry still reports has_icon:false — the send didn't stick.
  Home._widgetForegroundHealedAt = 0; // an app switch later than the throttle
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 2, 'the foreground retries despite the earlier attempt');
  assert.equal(added[1].silent, true, 'and stays silent');

  // …but an immediate second foreground is throttled, so rapid app
  // switching can't hammer the bridge with a persistently failing icon.
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 2, 'throttled — no send on a rapid re-foreground');
});

test('foreground healing is inert without the widget mechanism', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const foreground = stubForeground(sandbox);
  const added = [];
  sandbox.usernode = {
    isNative: false,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = null; // plain browser / Android
  Home._apps = [baseApp()];
  Home._watchWidgetForeground();
  await foreground('hidden');
  await foreground('visible');
  assert.equal(added.length, 0, 'no bridge traffic off the widget path');
  assert.equal(Home._widgetForegroundHealedAt, 0, 'the throttle never even armed');
});

// The foreground handler used to re-run the heal pass against the
// snapshot already in memory. That is precisely the data that goes stale
// while SV is suspended: entries are pinned and unpinned from the widget
// gallery, and has_icon / has_icon_dark are rewritten by whatever the
// shell managed to store from the last pass. Re-deciding from the old
// numbers reaches the old conclusion, which is how a tile that failed to
// gain its dark face stayed wrong across every reopen.
test('a foreground re-fetches the registry, not just the snapshot', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const foreground = stubForeground(sandbox);
  const added = [];
  let items = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: true },
  ];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp(), baseApp({ slug: 'second', name: 'Second' })];
  Home._watchWidgetForeground();
  sandbox.localStorage.setItem('sv:widget_icon_src', JSON.stringify({
    w1: `tile:${Home.WIDGET_ICON_GEN}:light:`,
  }));
  await Home._refreshWidgetItems();
  assert.equal(added.length, 0, 'nothing to do on the first pass');

  // Pinned from the widget gallery while SV was suspended: the shell
  // only reports it on a fresh read.
  items = items.concat([
    { id: 'w2', name: 'Second', url: 'https://sv.test/#app/second', has_icon: false },
  ]);
  Home._widgetForegroundHealedAt = 0;
  await foreground('hidden');
  await foreground('visible');
  await flushAsync();
  assert.equal(Home._widgetItems.length, 2, 'the registry was re-read');
  assert.equal(added.length, 1, 'and the new entry gets its icon');
  assert.equal(added[0].url, 'https://sv.test/app/second');
});

// A foreground whose registry read failed learned nothing, so it must
// not spend the 30s throttle window on that failure.
test('a foreground that cannot read the registry does not spend the throttle', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  const foreground = stubForeground(sandbox);
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async () => ({ added: true }),
    getHomeScreenShortcuts: async () => { throw new Error('no answer'); },
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  Home._watchWidgetForeground();
  await foreground('hidden');
  await foreground('visible');
  await flushAsync();
  assert.equal(Home._widgetItems, null, 'the read failed');
  assert.equal(Home._widgetForegroundHealedAt, 0, 'so the next foreground retries');
});

// The refresh chain is several awaits deep (registry read → capability →
// heal pass → send → write-back), and stubForeground only yields once.
async function flushAsync() {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
}

// Two overlapping passes would each write a srcMap snapshot taken
// before the other's sends, so the last writer drops the other's
// records and those tiles re-send on the next load.
test('icon heal: concurrent passes send once per id and keep both records', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  stubCapability(sandbox, false);
  stubScheme(sandbox, false);
  stubCanvas(sandbox, []);
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => {
      // Yield, so a second pass would interleave if it were allowed to.
      await new Promise((r) => setTimeout(r, 0));
      added.push(opts);
      return { added: true };
    },
    getHomeScreenShortcuts: async () => ({ items: Home._widgetItems }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = [
    { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo-app', has_icon: false },
    { id: 'w2', name: 'Iconed', url: 'https://sv.test/#app/iconed', has_icon: false },
  ];
  Home._apps = [
    baseApp(),
    baseApp({ slug: 'iconed', name: 'Iconed', icon_url: '/icons/x.png' }),
  ];
  await Promise.all([Home._healWidgetIcons(), Home._healWidgetIcons()]);
  assert.equal(added.length, 2, 'exactly one send per stale id');
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.equal(srcMap.w1, `tile:${Home.WIDGET_ICON_GEN}:light:`, 'canvas record survives');
  assert.equal(srcMap.w2, 'https://sv.test/icons/x.png', 'image record survives');
  assert.equal(Home._healInFlight, null, 'the guard clears when the pass settles');
});


test('icon heal: unpinned shortcut records are pruned from the source map', async () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const added = [];
  sandbox.usernode = {
    isNative: true,
    addHomeScreenShortcut: async (opts) => { added.push(opts); return { added: true }; },
    getHomeScreenShortcuts: async () => ({ items: [] }),
  };
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._apps = [baseApp()];
  sandbox.localStorage.setItem(
    'sv:widget_icon_src',
    JSON.stringify({ gone: 'https://sv.test/icons/old.png' })
  );
  await Home._refreshWidgetItems();
  const srcMap = JSON.parse(sandbox.localStorage.getItem('sv:widget_icon_src'));
  assert.deepEqual(srcMap, {}, 'record for the unpinned shortcut dropped');
  assert.equal(added.length, 0);
});

test('menu: shortcut item hidden when unsupported or app not running', () => {
  const Home = makeHome({ id: ME });
  Home._shortcutSupport = { mechanism: 'unsupported' };
  assert.equal(
    keys(Home.menuItemsFor(baseApp())).includes('add-to-homescreen'), false,
    'explicit unsupported hides it'
  );
  Home._shortcutSupport = { mechanism: 'pinned-shortcut' };
  for (const status of ['error', 'creating', 'awaiting_secrets']) {
    assert.equal(
      keys(Home.menuItemsFor(baseApp({ status }))).includes('add-to-homescreen'),
      false,
      `hidden on ${status} apps`
    );
  }
});

function holdHarness({ yours = false, demo = false, placement = false } = {}) {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  const timers = new Map();
  const listeners = new Map();
  const cardListeners = new Map();
  const opened = [];
  let seq = 0;
  sandbox.setTimeout = (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; };
  sandbox.clearTimeout = (id) => timers.delete(id);
  sandbox.addEventListener = (name, fn) => listeners.set(name, fn);
  sandbox.removeEventListener = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); };
  sandbox.PlatformUI = { gestures: () => ({ claim: () => true }) };
  Home._placementHandle = placement ? {} : null;
  Home.openCardMenu = (slug, anchor) => { opened.push({ slug, anchor }); };
  Home.closeCardMenu = () => { opened.push('closed'); };
  const card = {
    dataset: { slug: 'demo-app' },
    hasAttribute: (key) => key === 'data-yours' ? yours : key === 'data-demo' && demo,
    addEventListener: (name, fn) => cardListeners.set(name, fn),
    removeEventListener: (name) => cardListeners.delete(name),
  };
  const dispose = Home._wireCardLongPressMenu(card);
  const event = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20, target: { closest: () => null } };
  const fire = (name, extra = {}) => (cardListeners.get(name) || listeners.get(name))?.({ ...event, type: name, ...extra });
  const tick = (ms) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms <= ms) { timers.delete(id); timer.fn(); }
    }
  };
  return { Home, card, opened, fire, tick, dispose, timers, listeners };
}

test('long hold anchors to its tile and suppresses launch until release', () => {
  const h = holdHarness();
  h.fire('pointerdown');
  h.tick(400);
  assert.equal(h.opened[0].anchor, h.card);
  h.tick(5000);
  assert.equal(h.Home._suppressClick, true, 'a prolonged hold cannot expire the click guard');
  h.fire('pointerup');
  assert.equal(h.Home._suppressClick, true, 'the release click is still guarded');
  h.tick(0);
  assert.equal(h.Home._suppressClick, false, 'later taps are available');
  assert.equal(h.listeners.size, 0);
});

test('short tap, scrolling, cancellation and unmount never open a held menu', () => {
  for (const action of ['pointerup', 'pointermove', 'pointercancel', 'unmount']) {
    const h = holdHarness();
    h.fire('pointerdown');
    if (action === 'unmount') h.dispose();
    else h.fire(action, { clientY: 45 });
    h.tick(400);
    assert.deepEqual(h.opened, [], action);
    assert.equal(h.listeners.size, 0, action);
  }
});

test('another pointer cannot cancel a hold; cancelled open menus dismiss', () => {
  const h = holdHarness();
  h.fire('pointerdown');
  h.fire('pointerup', { pointerId: 2 });
  h.tick(400);
  assert.equal(h.opened.length, 1);
  h.fire('pointercancel');
  assert.equal(h.opened[1], 'closed');
});

test('placed touch tiles leave long press to the placement recognizer', () => {
  const h = holdHarness({ yours: true, placement: true });
  h.fire('pointerdown');
  h.tick(400);
  assert.deepEqual(h.opened, []);
  const pen = holdHarness({ yours: true, placement: true });
  pen.fire('pointerdown', { pointerType: 'pen' });
  pen.tick(400);
  assert.equal(pen.opened.length, 1, 'pens still get the context menu');
  pen.dispose();
});

test('app menus use an anchored popover even on touch', () => {
  const { Home, sandbox } = makeHomeEnv({ id: ME });
  Home._apps = [baseApp()];
  Home.renderMenuHeaderHtml = () => 'Demo App';
  sandbox.document.createElement = () => ({});
  let options;
  sandbox.PlatformUI = { popover: (opts) => { options = opts; return Promise.resolve(null); } };
  const anchor = { getBoundingClientRect: () => ({ left: 20, top: 20, right: 76, bottom: 76 }) };
  Home.openCardMenu('demo-app', anchor);
  assert.equal(options.anchorEl, anchor);
  assert.equal(options.headerEl.className, 'card-menu-header');
  assert.ok(options.items.length > 0);
});

test('movement dismissing an open search menu still suppresses the release click', () => {
  const h = holdHarness();
  h.fire('pointerdown');
  h.tick(400);
  h.fire('pointermove', { clientY: 50 });
  h.tick(5000);
  assert.equal(h.opened[1], 'closed');
  assert.equal(h.Home._suppressClick, true);
  h.fire('pointerup', { clientY: 50 });
  h.tick(0);
  assert.equal(h.Home._suppressClick, false);
});

// ── #1838: the two MOUSE entry points ─────────────────────────────
//
// A stationary mouse hold on a tile used to be a total no-op:
// _wireCardLongPressMenu discarded `pointerType === 'mouse'` on its first
// line, and the kit's own mouse path only ever arms a DRAG (it lifts after
// REORDER_SLOP of movement and has no hold timer). So nothing anywhere
// recognised a held mouse button, which is the "can no longer hold press"
// evan reported on desktop.
//
// The recognizer needs a controllable clock and real window listeners, so
// these patch the makeHomeEnv sandbox rather than adding a second harness.

function gestureEnv(user = { id: ME, canAdminWrite: true }) {
  const env = makeHomeEnv(user);
  const { sandbox } = env;
  const timers = [];
  const winListeners = Object.create(null);
  const docListeners = Object.create(null);

  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  sandbox.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; };
  sandbox.addEventListener = (type, fn) => {
    (winListeners[type] || (winListeners[type] = [])).push(fn);
  };
  sandbox.removeEventListener = (type, fn) => {
    const a = winListeners[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  sandbox.document.addEventListener = (type, fn) => {
    (docListeners[type] || (docListeners[type] = [])).push(fn);
  };
  sandbox.PlatformUI = { gestures: () => ({ claim: () => true, release: () => {} }) };
  // The shared stub's `innerHTML` is getter-only (it exists to assert
  // escaping); openCardMenu builds its header by writing one.
  sandbox.document.createElement = () => ({ className: '', innerHTML: '' });

  return {
    ...env,
    timers,
    // Run every live timer armed for exactly `ms`, in order.
    run: (ms) => {
      timers.filter((t) => !t.cancelled && !t.done && t.ms === ms)
        .forEach((t) => { t.done = true; t.fn(); });
    },
    pending: (ms) => timers.filter((t) => !t.cancelled && !t.done && t.ms === ms).length,
    win: (type, ev) => (winListeners[type] || []).slice().forEach((fn) => fn({ type, ...ev })),
    doc: (type, ev) => (docListeners[type] || []).slice().forEach((fn) => fn({ type, ...ev })),
  };
}

function makeCard(over = {}) {
  const attrs = over.attrs || {};
  const listeners = Object.create(null);
  return {
    nodeType: 1,
    dataset: { slug: over.slug || 'demo-app' },
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
    getBoundingClientRect: () => ({
      left: 10, top: 20, width: 60, height: 60, right: 70, bottom: 80,
    }),
    addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
    removeEventListener(t, fn) {
      const a = listeners[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn({ type, ...ev })); },
  };
}

const press = (over = {}) => ({
  pointerType: 'mouse',
  button: 0,
  isPrimary: true,
  pointerId: 3,
  clientX: 40,
  clientY: 50,
  target: { closest: () => null },
  ...over,
});

test('mouse: a stationary press-and-hold opens the tile menu (#1838)', () => {
  const env = gestureEnv();
  const opened = [];
  env.Home.openCardMenu = (slug, anchor) => { opened.push([slug, anchor]); };
  const card = makeCard();
  env.Home._wireCardLongPressMenu(card);

  card.fire('pointerdown', press());
  assert.deepEqual(opened, [], 'nothing opens on the press itself');
  env.run(400);
  assert.deepEqual(opened, [['demo-app', card]],
    'a held left mouse button opens the menu anchored to the tile');
  assert.equal(env.Home._suppressClick, true,
    'the click that follows the release must be eaten');
});

test('mouse: a press that MOVES becomes a drag, never a menu (#1838)', () => {
  const env = gestureEnv();
  const opened = [];
  env.Home.openCardMenu = (slug) => { opened.push(slug); };
  const card = makeCard();
  env.Home._wireCardLongPressMenu(card);

  card.fire('pointerdown', press());
  // The kit arms a mouse drag at REORDER_SLOP (6px), so movement must give
  // the drag precedence — the movement bail is what does that.
  env.win('pointermove', { pointerId: 3, clientX: 40, clientY: 90 });
  env.run(400);
  assert.deepEqual(opened, [], 'a moved press is a rearrange, not a menu');
});

test('mouse: the release leaves the click guard armed for onClick (#1838)', () => {
  const env = gestureEnv();
  env.Home.openCardMenu = () => {};
  const card = makeCard();
  env.Home._wireCardLongPressMenu(card);

  card.fire('pointerdown', press());
  env.run(400);
  env.win('pointerup', { pointerId: 3 });

  assert.equal(env.Home._suppressClick, true,
    'a mouse `click` follows its pointerup in the SAME task — clearing the'
    + ' guard at release means the released hold also opens the app');
  assert.equal(env.pending(0), 0, 'no 0ms reset on the mouse path');
  assert.equal(env.pending(700), 1, 'a single ~700ms safety net instead');
  env.run(700);
  assert.equal(env.Home._suppressClick, false,
    'a hold released off the tile fires no click, so the guard must expire');
});

test('touch: release timing and the kit hand-off are unchanged (#1838)', () => {
  const env = gestureEnv();
  const opened = [];
  env.Home.openCardMenu = (slug) => { opened.push(slug); };

  // A plain (search / demo) tile: this recognizer still does the hold, and
  // still clears the click guard on the next task.
  const plain = makeCard();
  env.Home._wireCardLongPressMenu(plain);
  plain.fire('pointerdown', press({ pointerType: 'touch' }));
  env.run(400);
  assert.deepEqual(opened, ['demo-app']);
  env.win('pointerup', { pointerId: 3 });
  assert.equal(env.pending(0), 1, 'touch keeps its 0ms release reset');
  assert.equal(env.pending(700), 0, 'and gains no mouse safety timer');

  // A PLACED tile: the kit's own lift callback owns the touch, so only one
  // recognizer may claim it.
  opened.length = 0;
  env.Home._placementHandle = { detach: () => {} };
  const placed = makeCard({ attrs: { 'data-yours': true } });
  env.Home._wireCardLongPressMenu(placed);
  placed.fire('pointerdown', press({ pointerType: 'touch' }));
  env.run(400);
  assert.deepEqual(opened, [], 'a placed touch tile still defers to the kit');

  // ...but the MOUSE always comes through here, because the kit's mouse
  // path has no hold. This is the whole of #1838.
  placed.fire('pointerdown', press());
  env.run(400);
  assert.deepEqual(opened, ['demo-app'],
    'a mouse hold on a placed tile must NOT defer to the kit');
});

test('openCardMenu records the tile it anchored to; closeCardMenu clears it (#1838)', () => {
  const env = gestureEnv();
  const { Home, sandbox } = env;
  Home._apps = [baseApp()];
  let dismissed = 0;
  let settle;
  sandbox.PlatformUI.popover = () => {
    const p = new Promise((r) => { settle = r; });
    p.dismiss = () => { dismissed += 1; settle(null); };
    return p;
  };

  const card = makeCard();
  Home.openCardMenu('demo-app', card);
  assert.equal(Home._menuAnchor, card,
    'the right-click toggle can only tell "close this" from "move to that"'
    + ' by comparing anchors');

  Home.closeCardMenu();
  assert.equal(dismissed, 1);
  assert.equal(Home._menu, null);
  assert.equal(Home._menuAnchor, null);
});

test('the anchor snapshot survives the kit dismissing on pointerdown (#1838)', async () => {
  const env = gestureEnv();
  const { Home, sandbox } = env;
  Home._apps = [baseApp()];
  let settle;
  sandbox.PlatformUI.popover = () => {
    const p = new Promise((r) => { settle = r; });
    p.dismiss = () => settle(null);
    return p;
  };
  // Installed once, by the tile wiring, so it runs BEFORE the popover's own
  // document listener and sees the anchor while it is still true.
  Home._wireCardLongPressMenu(makeCard());

  const card = makeCard();
  Home.openCardMenu('demo-app', card);
  env.doc('pointerdown');
  assert.equal(Home._menuAnchorAtPress, card,
    'a right-click on the open tile must still be recognisable as a toggle'
    + ' after the kit has dismissed the menu');

  // The snapshot is re-taken on EVERY press, so a menu closed some other way
  // (Escape) leaves a null snapshot and the next right-click opens.
  settle(null);
  await Promise.resolve();
  assert.equal(Home._menuAnchor, null);
  env.doc('pointerdown');
  assert.equal(Home._menuAnchorAtPress, null);
});
