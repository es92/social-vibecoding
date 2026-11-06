// "Featured apps" + "Create an app" — the two sections below the home
// screen's "Your apps" grid.
//
// All three sections share one shape: a .home-section-header, then the
// content. The width bound is on the FEED, not the boxes — #home-body is
// a 1024px-max, viewport-centred .home-column — so each section's card
// spans that column's full width and lines up with the "Your apps" grid
// above it.
//
// Featured apps' content is ONE contained card: the admin-curated tiles
// (the `featured` / `featured_order` flags GET /api/apps serializes from
// the featured_apps table) plus, as an attached footer row inside the same
// card, the way into the #apps browse screen. Create an app was the former
// in-grid "Build your own app" tile, then the page's last section; it is the
// launcher grid's trailing tile again now (the prototype's scrHome), derived
// per paint rather than placed (tests/home-create-tile.test.js).
//
// Run with: node --test tests/home-find-more.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { HOME_SRC, PANELS_SRC } = require('./helpers/home-modules');
const { installPanelsStore } = require('./helpers/home-grid-store');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
// The panel RENDERERS moved to frontend/src/features/home/panels/*.tsx when
// the three sections became React (#1191); home-panels.js keeps the data and
// the view models. Assertions about markup read the components, assertions
// about what decides the markup read the module.
const PANEL_SRC = Object.fromEntries(
  ['ui', 'challenges', 'discover', 'sections'].map(
    (n) => [n, read(`frontend/src/features/home/panels/${n}.tsx`)]
  )
);
// Create is no longer one of the panels: the launcher grid's trailing tile.
const TILE_SRC = read('frontend/src/features/home/create-tile.tsx');
const LAYOUT_SRC = read('frontend/src/features/home/home-layout.js');
const INDEX = read('public/index.html');
const CSS = read('public/css/app.css');
const ROUTE = read('src/routes/home-panels.js');

// A HomePanels in a vm sandbox, with the Home surface its renderers call
// into stubbed — the create widget asks Home.canCreate(), the discover
// widget asks Home.featuredApps().
function makePanels({ canCreate = true, featured = [] } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    Home: {
      canCreate: () => canCreate,
      featuredApps: () => featured,
      isYours: () => false,
      CREATE_DISABLED_HINT: 'Ask an admin to enable app creation for your account.',
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout, URLSearchParams, Date,
    location: { search: '', hash: '' },
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  // home-panels.js imports its view-model store; ./helpers/home-modules strips
  // the line so the source runs as classic script text, and this supplies the
  // binding it would have made.
  installPanelsStore(sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, sandbox };
}
const SCHEMA = read('src/db/schema.sql');
const APPS_ROUTE = read('src/routes/apps.js');

// `search` drives the screenshot-state deep links the module reads off
// location (?shot=create-enabled, ?shot=create-disabled,
// ?shot=discover-empty).
function makeHome({ search = '', canCreateApps = true } = {}) {
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      // escapeHtml() round-trips through textContent → innerHTML.
      createElement: () => {
        let t = '';
        return {
          classList: { add() {} },
          dataset: {},
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    location: { search },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  // home.js delegates iconTileFor / renderAppPillsHtml to window.AppCard
  // (frontend/src/features/apps/app-card.js) since #1083 chunk F.
  installAppCard(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return sandbox.__Home;
}

const app = (over) => ({
  slug: 'some-app',
  name: 'Some App',
  status: 'running',
  icon_emoji: '🧩',
  directory: { tier: 'listed', state: 'listed', label: null, flagged: false, flaggedAt: null },
  is_collaborator: false,
  is_favorited: false,
  is_member: false,
  audience: 'open',
  member_count: 0,
  favorite_order: null,
  featured: false,
  featured_order: null,
  ...over,
});

// ── featuredApps selection ────────────────────────────────────────

// Two apps that can be offered, two that cannot at all, and one an admin
// flagged, which neither lane offers whatever its numbers.
const flaggedDirectory = { state: 'flagged', tier: 'hidden', label: 'Hidden from Discover', flagged: true, flaggedAt: null };
const discoveryCandidates = () => [
  app({ slug: 'ready', active_users: 1 }),
  app({ slug: 'no-icon', icon_emoji: null, active_users: 100 }),
  app({ slug: 'not-running', status: 'creating', active_users: 100 }),
  app({ slug: 'flagged', active_users: 1000, member_count: 1000, directory: flaggedDirectory }),
  app({ slug: 'busy', active_users: 100 }),
];

// No review ranks or gates the lane: it is the busiest communities, less the
// ones an admin flagged, the way no icon and not running leave one out.
test('popular is the busiest runnable communities, and never a flagged one', () => {
  const Home = makeHome();
  assert.deepEqual(Home.popularApps(discoveryCandidates()).map((a) => a.slug), ['busy', 'ready']);
  assert.equal(Home.isDiscoverable(app({ demo: true })), true, 'staging inertness is not a flag');
  assert.equal(Home.isDiscoverable(app({ directory: flaggedDirectory })), false);
  assert.equal(Home.isFlagged(app({ directory: flaggedDirectory })), true);
  assert.equal(Home.isFlagged(app({ directory: undefined })), false);
  assert.equal('isDiscoveryReady' in Home, false, 'no review to be ready by');
});

test('featured requires a running app with an icon and no flag (#2565)', () => {
  const Home = makeHome();
  const featured = discoveryCandidates().map((a, i) => ({ ...a, featured: true, featured_order: i }));
  assert.deepEqual(Home.featuredApps(featured).map((a) => a.slug), ['ready', 'busy'],
    'featuring is the editorial decision; no icon, not running and a flag still leave an app out');
  assert.equal(Home.isDiscoverable(app({ self_hosted: true })), false, 'the platform itself is never offered');
  assert.equal(Home.isDiscoverable(app({ icon_emoji: null, icon_url: null })), false, 'nothing to draw');
  assert.equal(Home.isDiscoverable(app({ status: 'creating' })), false, 'cannot be opened yet');
});

test('featuredApps: only featured rows, ordered by featured_order', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'plain' }),
    app({ slug: 'third', featured: true, featured_order: 2 }),
    app({ slug: 'first', featured: true, featured_order: 0 }),
    app({ slug: 'second', featured: true, featured_order: 1 }),
  ];
  assert.deepEqual(
    Home.featuredApps(apps).map((a) => a.slug),
    ['first', 'second', 'third']
  );
});

test('featuredApps: apps already in "Your apps" are left out', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'member', featured: true, featured_order: 0, is_collaborator: true }),
    app({ slug: 'added', featured: true, featured_order: 1, is_favorited: true }),
    app({ slug: 'fresh', featured: true, featured_order: 2 }),
  ];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['fresh'],
    'no point re-offering what the user already keeps');
});

// ── #1567: the rail holds still while the tap is happening ─────────

test('featuredApps: a hidden member app IS offered again (#618)', () => {
  const Home = makeHome();
  // your_apps_hidden means they took it OFF their home screen, so it is
  // no longer "theirs" for this purpose — isYours() is the single source.
  const apps = [app({
    slug: 'hidden', featured: true, featured_order: 0,
    is_collaborator: true, your_apps_hidden: true,
  })];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['hidden']);
});

test('featuredApps: NULL featured_order sorts after explicit ones', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'null-order', featured: true, featured_order: null }),
    app({ slug: 'zero', featured: true, featured_order: 0 }),
  ];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['zero', 'null-order']);
});

test('featuredApps: capped at FEATURED_LIMIT', () => {
  const Home = makeHome();
  const apps = Array.from({ length: 20 }, (_, i) => app({
    slug: `f${i}`, featured: true, featured_order: i,
  }));
  assert.equal(Home.FEATURED_LIMIT, 6);
  assert.equal(Home.featuredApps(apps).length, 6);
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug),
    ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'], 'takes the top of the admin order');
});

test('featuredApps: empty / missing input is safe', () => {
  const Home = makeHome();
  assert.equal(Home.featuredApps([]).length, 0);
  assert.equal(Home.featuredApps(undefined).length, 0);
  assert.equal(Home.featuredApps([app()]).length, 0, 'nothing featured');
});

test('the create-widget shot paths pin both quota treatments', () => {
  assert.equal(makeHome({ canCreateApps: false }).canCreate(), false,
    'the ordinary state follows the authenticated quota');
  assert.equal(makeHome({ search: '?shot=create-enabled', canCreateApps: false }).canCreate(), true,
    'the enabled review path does not depend on capture-admin privileges');
  assert.equal(makeHome({ search: '?shot=create-disabled', canCreateApps: true }).canCreate(), false,
    'the locked review path stays deterministic too');
});

// ── popularApps selection ─────────────────────────────────────────
//
// The popular half of the Discover lane: the public communities the viewer
// has NOT joined, from the `member_count`, `audience` and `is_member` fields
// GET /api/apps already serves. Popularity is members first, `active_users`
// as the tie-break.

const pop = (over) => app({ active_users: 3, ...over });

test('popularApps: ranks public unjoined communities by members, active users breaking ties', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'few', member_count: 4 }),
    pop({ slug: 'most', member_count: 40 }),
    pop({ slug: 'some', member_count: 12 }),
    pop({ slug: 'tie-hi', member_count: 12, active_users: 9 }),
    pop({ slug: 'tie-lo', member_count: 12, active_users: 2 }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug),
    ['most', 'tie-hi', 'some', 'tie-lo', 'few']);
});

test('popularApps: the counts are coerced — the API sends bigints as strings', () => {
  const Home = makeHome();
  // Postgres COUNT(*) is a bigint, so a serializer that skips the coercion
  // hands the client "9", not 9. A lexicographic sort would rank "9" above "10".
  const apps = [
    pop({ slug: 'nine', member_count: '9', active_users: '9' }),
    pop({ slug: 'ten', member_count: '10', active_users: '10' }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['ten', 'nine']);
  assert.deepEqual(Home.popularApps([pop({ slug: 'n', member_count: 4, active_users: 4 })]).map((a) => a.slug),
    ['n'], 'and real numbers work too');
  // A missing member_count is zero members, and the active-user tie-break
  // still orders it.
  assert.deepEqual(Home.popularApps([
    pop({ slug: 'no-count', member_count: undefined }),
    pop({ slug: 'has-count', member_count: 1 }),
  ]).map((a) => a.slug), ['has-count', 'no-count']);
});

test('popularApps: ties keep the order the server returned', () => {
  const Home = makeHome();
  const apps = ['a', 'b', 'c'].map((slug) => pop({ slug, member_count: 4, active_users: 4 }));
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['a', 'b', 'c']);
});

test('popularApps: excludes featured, joined, yours, private and errored apps', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'keep', member_count: 9 }),
    pop({ slug: 'featured', featured: true, member_count: 20 }),
    pop({ slug: 'joined', is_member: true, member_count: 20 }),
    pop({ slug: 'joined-hidden', is_member: true, is_collaborator: true, your_apps_hidden: true, member_count: 20 }),
    pop({ slug: 'favorited', is_favorited: true, member_count: 20 }),
    pop({ slug: 'private', audience: 'invited', member_count: 20 }),
    pop({ slug: 'solo', audience: 'solo', member_count: 20 }),
    pop({ slug: 'no-audience', audience: null, member_count: 20 }),
    pop({ slug: 'broken', status: 'error', member_count: 20 }),
    pop({ slug: 'platform', self_hosted: true, member_count: 20 }),
    // A public community with members but nobody active this week is now
    // eligible: popularity is members, so the old one-active-user floor is
    // gone.
    pop({ slug: 'quiet', active_users: 0, member_count: 5 }),
    // A null count coerces to zero members, which the floor used to hide
    // and the lane now takes at the tail.
    pop({ slug: 'never-counted', member_count: null }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['keep', 'quiet', 'never-counted']);
});

test('popularApps: capped at POPULAR_LIMIT; empty / missing input is safe', () => {
  const Home = makeHome();
  assert.equal(Home.POPULAR_LIMIT, 6);
  const many = Array.from({ length: 20 }, (_, i) => pop({
    slug: `p${i}`, member_count: 100 - i, active_users: 100 - i,
  }));
  assert.deepEqual(Home.popularApps(many).map((a) => a.slug),
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'the six most-joined');
  assert.equal(Home.popularApps([]).length, 0);
  assert.equal(Home.popularApps(undefined).length, 0);
});

// ── The row hides itself when there is nothing to show ───────────

// ── Card mode: discovery tiles carry an add badge, not a "…" menu ──

test('renderAppCard: discovery mode leads with the add badge', () => {
  const Home = makeHome();
  const fresh = app({ slug: 'fresh', name: 'Fresh App' });
  const html = Home.renderAppCard(fresh, { mode: 'featured' });
  assert.match(html, /card-add-btn/);
  assert.match(html, /data-added="false"/);
  // The "…" menu is opt-in per grid (`opts.menu`). The browse screen sets
  // it; the home featured row currently doesn't, so a featured tile keeps
  // the single-badge look.
  assert.doesNotMatch(html, /card-menu-btn/, 'featured row is badge-only');
  const withMenu = Home.renderAppCard(fresh, { mode: 'browse', menu: true });
  assert.match(withMenu, /card-menu-btn/, 'browse opts in');
});

test('renderAppCard: an already-added app renders the ✓ state', () => {
  const Home = makeHome();
  const added = app({ slug: 'mine', is_favorited: true });
  const html = Home.renderAppCard(added, { mode: 'browse' });
  assert.match(html, /data-added="true"/);
  assert.match(html, /Remove mine from Pinned apps|Remove Some App from Pinned apps/);
});

test('renderAppCard: home mode leaves the icon free of menu badges (#1616)', () => {
  const Home = makeHome();
  const html = Home.renderAppCard(app({ slug: 'mine', is_collaborator: true }));
  assert.doesNotMatch(html, /card-menu-btn/);
  assert.doesNotMatch(html, /card-add-btn/);
});

// ── index.html section shells ────────────────────────────────────

test('index.html stacks the three home areas in order', () => {
  // This assertion has now inverted three times. Discover and Create app began
  // as fixed trailing sections below the grid; #911 made them WIDGETS,
  // placeable anywhere on the launcher canvas, and the section shells went;
  // THE UI OVERHAUL made them fixed sections again — deliberately, and with
  // the reasoning that settles it: a home screen with a reading order is a
  // page, and the same things at wherever-you-dropped-them was a canvas that
  // made every one of them feel optional. Then Create moved INTO Your apps as
  // the grid's trailing tile (the prototype's scrHome): not a widget with a
  // stored cell, but a tile whose cell is derived from the grid it ends.
  // One Home (#6361): Pinned apps, Pinned communities, Challenges as a
  // sideways row, then Communities to join; Discover's lane went with it.
  const grid = INDEX.indexOf('id="home-apps-section"');
  const communities = INDEX.indexOf('id="home-communities-section"');
  const challenges = INDEX.indexOf('id="home-challenges-section"');
  const join = INDEX.indexOf('id="home-join-section"');
  assert.ok(grid > 0, 'the launcher grid is present');
  assert.ok(communities > grid, 'Pinned communities comes after Pinned apps');
  assert.ok(challenges > communities, 'Challenges after Pinned communities');
  assert.ok(join > challenges, 'Communities to join last');
  assert.equal(INDEX.indexOf('id="home-discover-section"'), -1, 'no Discover lane on Home');
  assert.equal(INDEX.indexOf('id="home-create-section"'), -1,
    'Create app is no longer a section of its own');
  // The widgets' fallback host is gone with the placement it existed for: it
  // caught the moment before the first grid paint and the active-search view,
  // because a widget INSIDE #app-list vanished whenever #app-list did.
  assert.equal(INDEX.indexOf('id="home-panels"'), -1,
    'the fallback stack is retired');
  // The iOS widget-editing strip stays ABOVE the grid, where explicit cell
  // placement forced it and where it still belongs.
  const strip = INDEX.indexOf('id="home-widget-strip-section"');
  assert.ok(strip > 0 && strip < grid);
});

test('the apps grid is four columns at every width, two rows by default', () => {
  const tag = INDEX.match(/<div id="app-list"[^>]*>/)[0];
  assert.match(tag, /\bgrid-cols-4\b/, 'four columns');
  assert.doesNotMatch(tag, /sm:grid-cols-\d/,
    'and no second breakpoint — one column count is the point');
  // The two-row default is a cap on what is SHOWN, with a way out. The
  // wording moved with the button: #1191 made `#home-apps-more` React's, so
  // home.js pushes the COUNT (Home._renderAppsMore) and apps-more.tsx spells
  // the label. Both halves are pinned so neither can drift alone.
  assert.match(LAYOUT_SRC, /DEFAULT_ROWS: 2,/);
  assert.match(HOME_SRC, /chromeStore\.set\(\{\s*moreCount: count \|\| 0,/);
  assert.match(
    read('frontend/src/features/home/apps-more.tsx'),
    /\{t\('home:grid\.showAll', \{ count: moreCount \}\)\}/
  );
  assert.equal(message('home:grid.showAll', { count: 9 }), 'Show all 9 apps');
  assert.equal(INDEX.indexOf('id="home-apps-more"') > 0, true,
    'the expander has a host outside #app-list');
});

// The width bound is on the FEED, not on each box: #home-body is a
// 1024px-max, viewport-centred column, so both trailing cards span it
// edge to edge (inside the section's own px-3 gutter) and share their
// left edge with the "Your apps" grid above. The heading stays a plain
// sibling above the card.
test('every block is one bordered box, sized by its own content', () => {
  // A block's box used to fill whatever rectangle the layout gave it — a
  // `.home-panel-slot` grid host with `display: flex` and a 100%-width child,
  // so a short block stretched rather than sitting in the top-left of a 2x2
  // cell — and the rectangle itself came from a per-column-count footprint
  // table in the server registry (`sizes`, asymmetric for two of the three).
  // THE UI OVERHAUL made all three fixed <section>s, so both went: nothing is
  // placed, and a section is as tall as it draws.
  assert.doesNotMatch(CSS, /^\.home-panel-slot[\s,{]/m);
  assert.doesNotMatch(ROUTE, /sizes:/);
  // What each host DOES still carry is the key of the block it is for — the
  // hook the dapp.json checks and the screenshot assertions select on.
  for (const key of ['challenges']) {
    assert.match(INDEX, new RegExp(`<section id="home-${key}-section" data-panel-slot="${key}"`),
      `${key}: its section names it`);
  }
  // Create carries the same key on the grid tile that replaced its section
  // (it renders on the first grid paint, so it is not in the prerender).
  assert.match(TILE_SRC, /data-panel-slot="create"/);
  assert.doesNotMatch(INDEX, /data-panel-slot="create"/);
});

// Short feed on a tall screen: the trailing sections sit at the BOTTOM of
// the visible page instead of hugging the "Your apps" grid. Pure CSS —
// #home-body is a min-height:100% flex column and the first trailing
// section carries margin-top:auto, which also means a feed taller than the
// viewport has no free space to absorb and the sections flow normally right
// below the grid (no gap, no clipping, no measurement, no media query).
test('the feed column survives the sections it used to bottom-anchor', () => {
  // .home-body-fill still guarantees the scroller can be pulled by at least
  // the hidden search bar's height — that is why it outlives the two
  // anchored sections it was introduced alongside.
  assert.match(CSS, /\.home-body-fill \{[^}]*min-height: 100%/);
  assert.match(INDEX, /id="home-body" class="home-column home-body-fill"/);
  // Nothing is bottom-anchored any more: the grid is the whole feed. Matched
  // as a class ATTRIBUTE, so the comment explaining why it went doesn't
  // count as a use.
  assert.doesNotMatch(INDEX, /class="[^"]*home-bottom-anchor/);
  assert.doesNotMatch(CSS, /^\.home-bottom-anchor \{/m);
});

// The column itself: 1024px max, centred, and applied BOTH to the content
// body and to the search bar's inner content — the bar's own background
// stays full-bleed, so only its content is capped.
test('the home feed is a 1024px centred column', () => {
  const body = INDEX.match(/<div id="home-body"[^>]*>/)[0];
  assert.match(body, /class="[^"]*\bhome-column\b/, '#home-body is the column');

  const main = INDEX.slice(
    INDEX.indexOf('<main id="home-screen"'),
    INDEX.indexOf('<main id="browse-screen"')
  );
  const bar = main.slice(main.indexOf('id="home-search-bar"'), main.indexOf('id="home-body"'));
  assert.match(bar, /home-column/, "the search bar's content sits in the same column");
  // The gutter moved onto that inner column so its content edges match
  // #home-body's; the bar element itself must stay full-bleed for its bg.
  assert.match(bar, /home-column[^"]*px-3/, 'the gutter is on the inner column');
  assert.doesNotMatch(INDEX.match(/<div id="home-search-bar"[^>]*>/)[0], /px-3/);

  const css = read('public/css/app.css');
  const rule = css.match(/\.home-column \{[^}]*\}/)[0];
  assert.match(rule, /max-width:\s*64rem/, '64rem = 1024px');
  assert.match(rule, /margin-inline-start:\s*auto/);
  assert.match(rule, /margin-inline-end:\s*auto/);
  // The old per-box bound is gone for good.
  assert.doesNotMatch(css, /\.home-section-block\b/);
  assert.doesNotMatch(HOME_SRC, /alignSections|--home-section-indent/,
    'the measured icon indent went away with the centred column');
});

test('the Create tile renders in both states and keeps quota details reachable', () => {
  const createHtml = (enabled) => renderComponent(
    'frontend/src/features/home/create-tile.tsx', 'CreateTile',
    {
      view: {
        enabled,
        hint: 'Ask an admin to enable app creation for your account.',
        placement: { col: 3, row: 0, w: 1, h: 1 },
      },
    },
  );

  const on = createHtml(true);
  assert.match(on, /data-create-enabled="true"/);
  assert.match(on, /home-create-btn/, 'the hook the dapp.json create checks select on');
  assert.match(on, /New project/);
  assert.doesNotMatch(on, /aria-disabled/);

  const off = createHtml(false);
  // Still a real tile in a real cell — quieter, not absent.
  assert.ok(off.length > 100, 'the tile renders for a viewer with no quota');
  assert.match(off, /data-create-enabled="false"/);
  assert.doesNotMatch(off, /aria-disabled/,
    'the available open-quota-details action is not disabled to assistive technology');
  assert.match(off, /View app quota\. Ask an admin to enable app creation/,
    'the available action and the lock reason are both announced');
  // NOT the disabled ATTRIBUTE: that swallows pointer events, which would
  // prevent the viewer from opening the dialog to read their quota.
  assert.doesNotMatch(off, /<button[^>]*\sdisabled/);
});

test('Create an app is the launcher grid\'s trailing tile, for every account', () => {
  // This assertion has inverted three times with the surface: banished from
  // the grid into a trailing section, then a first-class grid item (#911),
  // then a fixed section again, and now the grid's LAST tile (the prototype's
  // scrHome). What never changed is the part that matters: it exists for
  // EVERY account, and app quota decides its treatment, never whether it is
  // there.
  assert.doesNotMatch(PANELS_SRC, /createView\(panel\) \{/, 'the panels no longer build it');
  assert.doesNotMatch(PANELS_SRC, /create: 'home-create-section'/, 'and it has no section host');
  // The only thing that withholds the tile is a collapsed grid it would add
  // a row to (#3047) — and there it is not gone: the view is still built, and
  // the Show-all line draws the compact New project entry for it (#4757).
  assert.match(HOME_SRC, /create = \{\n\s+enabled: canCreate,\n\s+hint: message\(Home\.CREATE_DISABLED_HINT\),\n\s+heldBack: createHidden,/,
    'Home.render() builds it on the grid paint, from the same canCreate');
  assert.doesNotMatch(HOME_SRC, /data-panel-slot="/,
    'and the grid still plants no widget slots: the tile is a component, not a slot');
  // The server's registry still lists it (a cached older shell renders its
  // section from it) and still builds it unconditionally: no viewer argument
  // reaches the registry, so app quota can never decide whether it exists.
  const registry = ROUTE.match(/const PANEL_REGISTRY = \[[\s\S]*?\n\];/)[0];
  assert.match(registry, /key: 'create'/);
  assert.doesNotMatch(registry, /canCreateApps|quota/i);
});

test('a viewer with no quota can open the dialog to inspect it', () => {
  // The compact locked state carries the shared hint in its tooltip;
  // tapping opens the detailed used-of-limit row.
  assert.match(HOME_SRC, /CREATE_DISABLED_HINT: 'home:create\.disabledHint'/);
  assert.equal(message('home:create.disabledHint'), 'View your app allowance or request more slots.');
  const btn = TILE_SRC.slice(TILE_SRC.indexOf('onClick={'));
  assert.match(btn, /App\?\.showCreateModal\?\.\(\)/,
    'both enabled and locked tiles open the create modal');
  assert.doesNotMatch(btn, /PlatformUI\?\.toast\?\.\(/,
    'a generic toast cannot replace the exact quota display');
});

// ── Server side: the featured flags this row is built from ────────

test('schema declares featured_apps with a cascading app FK', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS featured_apps/);
  const block = SCHEMA.slice(
    SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS featured_apps'),
    SCHEMA.indexOf('CREATE INDEX IF NOT EXISTS idx_featured_apps_order')
  );
  assert.match(block, /app_id\s+INTEGER PRIMARY KEY REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(block, /sort_order\s+INTEGER NOT NULL/);
  assert.match(block, /created_by\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  // Curation is public information — it is on every user's home screen.
  assert.doesNotMatch(block, /staging:private/);
});

test('GET /api/apps joins featured_apps and serializes both flags', () => {
  assert.match(APPS_ROUTE, /LEFT JOIN featured_apps fa ON fa\.app_id = a\.id/);
  assert.match(APPS_ROUTE, /\(fa\.app_id IS NOT NULL\) AS featured/);
  assert.match(APPS_ROUTE, /fa\.sort_order AS featured_order/);
  assert.match(APPS_ROUTE, /featured: !!a\.featured/);
  assert.match(APPS_ROUTE, /featured_order: a\.featured_order \?\? null/);
});

test('staging seeds featured rows both ways (boot seed + ?demo=1 tiles)', () => {
  // Boot fixtures must work with a cloned featured list as well as an
  // empty one; request-time demo tiles cannot exercise real add/remove.
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /async function seedStagingFeaturedApps\(pool\)/);
  assert.match(migrate, /await seedStagingFeaturedApps\(pool\)/);
  const seed = migrate.slice(
    migrate.indexOf('async function seedStagingFeaturedApps(pool)'),
    migrate.indexOf('// Per-user app-quota fixtures')
  );
  assert.match(seed, /USERNODE_ENV !== 'staging'/, 'no-op outside staging');
  assert.match(seed, /INSERT INTO featured_apps/);
  assert.match(seed, /ON CONFLICT \(app_id\) DO NOTHING/, 'idempotent across rebuilds');
  assert.match(seed, /NULL/, 'created_by never references a real user');
  // Request-time demo tiles for the ?demo=1 path.
  const fixtures = read('src/services/staging-apps.js');
  assert.match(fixtures, /staging-demo-featured/);
  assert.match(fixtures, /INSERT INTO featured_apps/);
  assert.match(APPS_ROUTE, /stagingApps.isCatalogSlug/);
});

function stagingFeaturedSeed(env = 'staging') {
  const migrate = read('src/db/migrate.js');
  const source = migrate.slice(
    migrate.indexOf('async function seedStagingFeaturedApps(pool)'),
    migrate.indexOf('// Per-user app-quota fixtures')
  );
  return vm.runInNewContext(`${source}\nseedStagingFeaturedApps;`, {
    process: { env: { USERNODE_ENV: env } },
    log: { info() {}, warn(_area, _message, error) { assert.fail(error.message); } },
  });
}

for (const prepopulated of [false, true]) {
  test(`staging Discover has addable fixtures with an ${prepopulated ? 'existing' : 'empty'} featured list`, async () => {
    const curation = require('../src/services/discovery-curation');
    const real = app({ id: 1, slug: 'real-cloned-app', directory_review_status: 'unreviewed', active_users: 10 });
    // A fixture someone flagged in this preview is never featured by the seed.
    const fixtures = ['puzzle-chain', 'word-garden', 'pixel-racer'].map((name, i) => app({
      id: i + 2, slug: `staging-demo-${name}`, icon_emoji: null, active_users: 0,
      directory_review_status: name === 'pixel-racer' ? 'broken' : 'unreviewed',
    }));
    const featured = new Map(prepopulated ? [[real.id, 7]] : []);
    const pool = { async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      // Model just the fixture persistence; the actual Home selection and
      // Discover classification below execute production code.
      if (sql.startsWith('UPDATE apps SET icon_emoji')) {
        assert.match(sql, /created_by = \(SELECT id FROM users WHERE username = 'staging-demo-user'\)/);
        assert.match(sql, /AND icon_emoji IS NULL AND icon_image_id IS NULL/);
        assert.doesNotMatch(sql, /directory_review/, 'the seed certifies nothing');
        for (const fixture of fixtures) if (!fixture.icon_emoji) fixture.icon_emoji = '🧩';
        return { rows: [] };
      }
      if (sql === 'SELECT 1 FROM featured_apps LIMIT 1') {
        return { rows: featured.size ? [{ exists: 1 }] : [] };
      }
      if (sql.startsWith('SELECT id FROM apps')) {
        assert.match(sql, /created_by = \(SELECT id FROM users WHERE username = 'staging-demo-user'\)/);
        assert.match(sql, /AND directory_review_status NOT IN \('demo', 'broken'\)/);
        return { rows: fixtures.filter((a) => !curation.isFlagged(a)) };
      }
      if (sql.startsWith('INSERT INTO featured_apps')) {
        assert.match(sql, /COALESCE\(MAX\(sort_order\), -1\) \+ 1/);
        assert.match(sql, /ON CONFLICT \(app_id\) DO NOTHING/);
        if (!featured.has(params[0])) featured.set(params[0], Math.max(-1, ...featured.values()) + 1);
        return { rows: [] };
      }
      assert.fail(`Unexpected seed query: ${sql}`);
    } };
    const seed = stagingFeaturedSeed();
    await seed(pool);
    const first = [...featured];
    await seed(pool);
    assert.deepEqual([...featured], first, 'reboot preserves existing positions without duplicates');
    if (prepopulated) assert.equal(featured.get(real.id), 7, 'cloned ordering is preserved');
    assert.equal(real.icon_emoji, '🧩', 'no real app is touched by the seed');
    assert.equal(real.directory_review_status, 'unreviewed');
    const apps = [real, ...fixtures].map((a) => ({
      ...a, directory: curation.describe(a), featured: featured.has(a.id), featured_order: featured.get(a.id),
    }));
    const Home = makeHome();
    const offered = Home.featuredApps(apps);
    // Featuring decides the lane (#2565): a production app the clone
    // brought over already featured is offered at its admin-set position.
    // The fixtures follow in seed order, less the flagged one.
    assert.deepEqual(offered.map((a) => a.slug),
      (prepopulated ? [real.slug] : []).concat(['staging-demo-puzzle-chain', 'staging-demo-word-garden']));
    assert.ok(offered.every((a) => !a.demo && !Home.isYours(a)),
      'real DB-backed fixtures must remain available to the Discover add/remove check');
  });
}

test('staging discovery fixtures never write outside staging', async () => {
  for (const env of ['production', 'local', undefined]) {
    await stagingFeaturedSeed(env === undefined ? '' : env)({ query() { assert.fail(`seed ran in ${env}`); } });
  }
});

// ── the Add apps sheet's lists (#4669) ───────────────────────────────
//
// Edit mode's trailing tile opens a sheet with two lists, and the decision
// of what goes in them lives in addSheetLists — pure, so it is read here as
// data against a real Home from the harness above rather than through sheet
// markup. The sheet module reads `window.Home` at call time, the way every
// consumer outside home.js does.

const SHEET_SRC = 'frontend/src/features/home/add-apps-sheet.tsx';
const { addSheetLists } = loadTsx(SHEET_SRC, {});

// The module resolves `window` against the Node global at call time; the
// sandboxed Home is a vm object, and property reads cross realms fine.
function withHome(Home, fn) {
  const saved = globalThis.window;
  globalThis.window = { Home };
  try {
    return fn();
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

test('the sheet lists joined-but-untiled apps first, popular second, never twice', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'tile', is_favorited: true, is_member: true }),
    app({ slug: 'joined', is_member: true }),
    // A collaborator who hid their tile: not "yours" as isYours reads it,
    // not "joined" as popularApps reads it — so it reaches BOTH lists, and
    // the sheet may show it once.
    app({ slug: 'collab-hidden', is_collaborator: true, your_apps_hidden: true }),
    app({ slug: 'open', active_users: 5 }),
    app({ slug: 'demo', demo: true, active_users: 50 }),
  ];
  const lists = withHome(Home, () => addSheetLists(apps));
  assert.deepEqual(lists.yours.map((a) => a.slug), ['joined', 'collab-hidden'],
    '"Your other apps": the viewer belongs to them and keeps no tile');
  assert.deepEqual(lists.popular.map((a) => a.slug), ['open'],
    '"Popular" is popularApps\' answer minus the first list, and minus demo tiles');
});

test('a demo tile is offered by neither list, and no Home means no lists', () => {
  // popularApps itself does not screen demo tiles out — the Discover rails
  // want them — but the sheet's Add button on one would be a silent no-op:
  // toggleAdded returns early for staging ?demo=1 tiles with no DB row.
  const Home = makeHome();
  const lists = withHome(Home, () => addSheetLists([app({ slug: 'demo', demo: true })]));
  assert.deepEqual(lists, { yours: [], popular: [] });
  // No window.Home (a sheet opened where the module never loaded): empty
  // lists, never a throw — the empty sheet is a real state ("Nothing to add
  // right now" and the browse link).
  assert.deepEqual(withHome(null, () => addSheetLists([app({})])), { yours: [], popular: [] });
  assert.deepEqual(withHome(null, () => addSheetLists('not-a-list')), { yours: [], popular: [] });
});

test('the sheet\'s Add press is the same toggleAdded(true) the rails run', () => {
  assert.match(read(SHEET_SRC), /home\(\)\?\.toggleAdded\?\.\(slug, true\)/,
    'one write path: flip the flag, repaint the grid, POST /favorite');
});
