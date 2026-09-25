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
const { renderComponent } = require('./lib/render-tsx');
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
  directory: { tier: 'ready', state: 'working', label: 'Reviewed working' },
  is_collaborator: false,
  is_favorited: false,
  favorite_order: null,
  featured: false,
  featured_order: null,
  ...over,
});

// ── featuredApps selection ────────────────────────────────────────

// One reviewed app, two that cannot be offered at all, and four whose review
// is absent, expired or negative. The two lanes disagree about the last four.
const discoveryCandidates = () => [
  app({ slug: 'ready', active_users: 1 }),
  app({ slug: 'no-icon', icon_emoji: null, active_users: 100 }),
  app({ slug: 'not-running', status: 'creating', active_users: 100 }),
  ...['unreviewed', 'outdated', 'demo', 'broken'].map((state) => app({
    slug: state, active_users: 100, directory: { state, tier: state === 'outdated' || state === 'unreviewed' ? 'unreviewed' : 'more' },
  })),
];

test('popular requires a current review and a real icon, not just popularity', () => {
  const Home = makeHome();
  assert.deepEqual(Home.popularApps(discoveryCandidates()).map((a) => a.slug), ['ready']);
  assert.equal(Home.isDiscoveryReady(app({ demo: true })), true, 'staging inertness is not an editorial demo classification');
  assert.equal(Home.isDiscoveryReady(app({ directory: { state: 'outdated', tier: 'unreviewed' } })), false,
    'an expired review is not a current one');
});

test('featured requires a running app with an icon, not a current review (#2565)', () => {
  const Home = makeHome();
  const featured = discoveryCandidates().map((a, i) => ({ ...a, featured: true, featured_order: i }));
  assert.deepEqual(Home.featuredApps(featured).map((a) => a.slug),
    ['ready', 'unreviewed', 'outdated', 'demo', 'broken'],
    'featuring is the editorial decision: an absent or expired review no longer hides the app; no icon and not running still do');
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

test('featuredApps: a slug in _discoverKeep stays in the rail after it becomes yours', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'kept', featured: true, featured_order: 0, is_favorited: true }),
    app({ slug: 'other', featured: true, featured_order: 1, is_favorited: true }),
  ];
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), [],
    'both are yours, so neither is offered');
  Home._discoverKeep.add('kept');
  assert.deepEqual(Home.featuredApps(apps).map((a) => a.slug), ['kept'],
    'the one the finger is on holds its place, ticked, so the tap is reversible');
});

test('popularApps: _discoverKeep holds a card there too, and only that card', () => {
  const Home = makeHome();
  const apps = [
    app({ slug: 'kept', active_users: 9, is_favorited: true }),
    app({ slug: 'other', active_users: 8, is_favorited: true }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), []);
  Home._discoverKeep.add('kept');
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['kept']);
});

test('_discoverKeep is per-visit: a fresh Home offers the honest list again', () => {
  const kept = makeHome();
  kept._discoverKeep.add('kept');
  const apps = [app({ slug: 'kept', featured: true, featured_order: 0, is_favorited: true })];
  assert.equal(kept.featuredApps(apps).length, 1);
  assert.equal(makeHome().featuredApps(apps).length, 0,
    'the next load of the home screen starts from what the viewer actually has');
});

test('featuredApps: ?shot=discover-empty still wins over a kept slug', () => {
  const Home = makeHome({ search: '?shot=discover-empty' });
  Home._discoverKeep.add('kept');
  const apps = [app({ slug: 'kept', featured: true, featured_order: 0, is_favorited: true })];
  assert.equal(Home.featuredApps(apps).length, 0);
});

test('_wireDiscoveryCards binds each badge once, however often the lane re-runs it', () => {
  const Home = makeHome();
  let toggles = 0;
  Home.toggleAdded = () => { toggles += 1; };
  // BY TYPE, since #1763: the badge carries two listeners now — its click,
  // and the pointerdown guard that keeps a press on ⊕ from arming the lane's
  // drag recognizer. Both are bound through the same WeakSet, so both are the
  // claim this test makes.
  const mkBtn = (cls, slug) => {
    const handlers = {};
    return {
      className: cls,
      dataset: { slug, added: 'false' },
      addEventListener: (t, fn) => { (handlers[t] || (handlers[t] = [])).push(fn); },
      handlers,
    };
  };
  const badge = mkBtn('card-add-btn', 'fresh');
  const card = {
    dataset: { slug: 'fresh', status: 'running' },
    addEventListener: () => {},
  };
  const lane = {
    querySelectorAll: (sel) => {
      if (sel === '.app-card') return [card];
      if (sel === '.card-add-btn') return [badge];
      return [];
    },
  };
  // Twice, which is what really happens now: the badge flipping to "added"
  // changes the effect's key while React keeps the very same element.
  Home._wireDiscoveryCards(lane);
  Home._wireDiscoveryCards(lane);
  assert.equal(badge.handlers.click.length, 1, 'one listener, not two');
  assert.equal(badge.handlers.pointerdown.length, 1, 'and one guard, not two');
  badge.handlers.click[0]({ stopPropagation: () => {} });
  assert.equal(toggles, 1, 'so one tap is one toggle');

  // The guard's whole job: the kit's recognizer listens for pointerdown on the
  // LANE and takes the first card that contains the target, so a press on the
  // badge is a press on the card unless the event stops here (#1763). On
  // desktop it arms after 6px, which is inside the slop of an ordinary click.
  let stopped = 0;
  badge.handlers.pointerdown[0]({ stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1, 'a press on ⊕ never reaches the lane');
});

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

// The screenshot-state deep link for the compact "nothing to discover" state
// (#949). Without it that rendering — what a viewer sees once they have
// added everything on offer — is unreachable by URL, so the before/after
// screenshots and every declared check would show the populated widget.
//
// It empties BOTH halves of the lane. The block draws one continuous rail
// now, so its note is the whole category's empty state; emptying only the
// curated half would put "nothing to discover" above four popular cards.
test('?shot=discover-empty forces the empty state — BOTH halves of the lane', () => {
  const apps = [
    app({ slug: 'f', featured: true, featured_order: 0 }),
    app({ slug: 'p', active_users: 9 }),
  ];
  assert.equal(makeHome().featuredApps(apps).length, 1, 'normally populated');
  assert.equal(makeHome().popularApps(apps).length, 1, 'both halves are');
  const shot = makeHome({ search: '?shot=discover-empty' });
  assert.equal(shot.featuredApps(apps).length, 0, 'the deep link empties the curated half');
  assert.equal(shot.popularApps(apps).length, 0, 'and the popular one');
  // Paint-only: a DIFFERENT shot value must not touch either list.
  const other = makeHome({ search: '?shot=create-disabled' });
  assert.equal(other.featuredApps(apps).length, 1);
  assert.equal(other.popularApps(apps).length, 1);
});

test('the create-widget shot paths pin both quota treatments', () => {
  assert.equal(makeHome({ canCreateApps: false }).canCreate(), false,
    'the ordinary state follows the authenticated quota');
  assert.equal(makeHome({ search: '?shot=create-enabled', canCreateApps: false }).canCreate(), true,
    'the enabled review path does not depend on capture-admin privileges');
  assert.equal(makeHome({ search: '?shot=create-disabled', canCreateApps: true }).canCreate(), false,
    'the locked review path stays deterministic too');
});

// ── popularApps selection (#949) ──────────────────────────────────
//
// The desktop widget's second lane: what everyone else is using, from the
// `active_users` count GET /api/apps already serves. The ranking mirrors
// Browse.sortApps' non-featured tail so the widget and the directory can't
// disagree about what is popular.

const pop = (over) => app({ active_users: 3, ...over });

test('popularApps: ranks non-featured apps by active users, most first', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'few', active_users: 2 }),
    pop({ slug: 'most', active_users: 11 }),
    pop({ slug: 'some', active_users: 5 }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['most', 'some', 'few']);
});

test('popularApps: the count is coerced — the API sends it as a string', () => {
  const Home = makeHome();
  // Postgres COUNT(*) is a bigint, so the serializer hands the client "9",
  // not 9. A lexicographic sort would rank "9" above "10".
  const apps = [pop({ slug: 'nine', active_users: '9' }), pop({ slug: 'ten', active_users: '10' })];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['ten', 'nine']);
  assert.deepEqual(Home.popularApps([pop({ slug: 'n', active_users: 4 })]).map((a) => a.slug),
    ['n'], 'and a real number works too');
});

test('popularApps: ties keep the order the server returned', () => {
  const Home = makeHome();
  const apps = ['a', 'b', 'c'].map((slug) => pop({ slug, active_users: 4 }));
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['a', 'b', 'c']);
});

test('popularApps: excludes featured, yours, errored, self-hosted and unused apps', () => {
  const Home = makeHome();
  const apps = [
    pop({ slug: 'keep', active_users: 9 }),
    pop({ slug: 'featured', featured: true, active_users: 20 }),
    pop({ slug: 'mine', is_favorited: true, active_users: 20 }),
    pop({ slug: 'broken', status: 'error', active_users: 20 }),
    pop({ slug: 'platform', self_hosted: true, active_users: 20 }),
    pop({ slug: 'unused', active_users: 0 }),
    pop({ slug: 'never-counted', active_users: null }),
  ];
  assert.deepEqual(Home.popularApps(apps).map((a) => a.slug), ['keep']);
});

test('popularApps: capped at POPULAR_LIMIT; empty / missing input is safe', () => {
  const Home = makeHome();
  assert.equal(Home.POPULAR_LIMIT, 6);
  const many = Array.from({ length: 20 }, (_, i) => pop({
    slug: `p${i}`, active_users: 100 - i,
  }));
  assert.deepEqual(Home.popularApps(many).map((a) => a.slug),
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'the six most-used');
  assert.equal(Home.popularApps([]).length, 0);
  assert.equal(Home.popularApps(undefined).length, 0);
});

// ── The row hides itself when there is nothing to show ───────────

test('the Discover widget swaps its tile row for a note, never an empty box', () => {
  const src = PANEL_SRC.discover;
  assert.ok(src.length > 200, 'located the Discover renderer');
  // Cards OR a one-line note — never a bare bar over an empty lane. The
  // branch is on the MERGED list, so the note only appears when the whole
  // category is empty rather than when the curated half is.
  assert.match(src, /tiles\.length \?/);
  assert.doesNotMatch(src, /view\.featured\.length \?/);
  assert.match(src, /Nothing to discover right now/);
  // The browse control always renders: it is THE discovery path, so it must
  // not depend on curation existing. It lives in the SECTION HEADING now, not
  // in the card at all — see the block test below — so it does not even
  // depend on the block having rendered.
  assert.match(PANEL_SRC.ui, /home-browse-btn/);
  assert.match(PANEL_SRC.ui, /Browse all apps/);
  assert.match(PANEL_SRC.sections, /<BrowseLink \/>/);
  // ...and the widget derives its tiles from the SAME per-viewer flags the
  // old row did, rather than issuing a second query.
  assert.match(PANELS_SRC, /Home\.featuredApps\(/);
});

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

test('Discover cards keep the wiring the compact tiles had', () => {
  const src = PANEL_SRC.discover.slice(PANEL_SRC.discover.indexOf('function DiscoverCard('));
  // THE COMPACT TREATMENT IS GONE. It was a 40px widget-strip tile, sized to
  // fit six of them across a ~366px phone block — the icon filled its grid
  // track up to that cap, because the narrowest lane gave it ~32px and a fixed
  // box there overflowed. The lane is a rail of 152px cards now, so the track,
  // the cap and the fluid icon all went with the grid (see the retirement note
  // in app.css and the rail test in home-panels-render.test.js).
  assert.doesNotMatch(src, /app-icon-tile home-discover-icon/,
    'the 40px tile face is retired');
  assert.doesNotMatch(CSS, /^\.home-discover-icon-wrap[\s,{]/m,
    'and so is the wrapper that capped it');
  // What SURVIVES is the contract with Home's wiring: `.app-card` and
  // `data-slug` are what let the card reuse _wireDiscoveryCards wholesale
  // (tap opens, badge toggles), so a redesign cannot quietly drift from the
  // behaviour of the row this area has always had. dapp.json's own Discover
  // check chains `.app-card` too.
  assert.match(src, /className={`app-card home-discover-card /);
  assert.match(src, /card-add-btn/);
  // The binding runs from the LANE's effect — still Home's function, still
  // once per lane.
  assert.match(PANEL_SRC.discover, /_wireDiscoveryCards\?\.\(el\)/);
});

test('renderAppCard: an already-added app renders the ✓ state', () => {
  const Home = makeHome();
  const added = app({ slug: 'mine', is_favorited: true });
  const html = Home.renderAppCard(added, { mode: 'browse' });
  assert.match(html, /data-added="true"/);
  assert.match(html, /Remove mine from Your apps|Remove Some App from Your apps/);
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
  const grid = INDEX.indexOf('id="app-list"');
  const discover = INDEX.indexOf('id="home-discover-section"');
  const challenges = INDEX.indexOf('id="home-challenges-section"');
  assert.ok(grid > 0, 'the launcher grid is present');
  assert.ok(discover > grid, 'Discover comes after the apps grid');
  assert.ok(challenges > discover, 'Challenges after Discover');
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
    /`Show all \$\{moreCount\} apps`/
  );
  assert.equal(INDEX.indexOf('id="home-apps-more"') > 0, true,
    'the expander has a host outside #app-list');
});

test('Discover is one bordered block: one lane, and no chrome of its own', () => {
  // Same shell as every other widget, so the three read as one family — but
  // Discover passes NO footer (#949), and since the title moved out to become
  // the section's label there is no bar either: the card is one lane of
  // cards, and nothing else.
  const src = PANEL_SRC.discover;
  assert.match(src, /<PanelShell\b/, 'the same shell as every other block');
  assert.doesNotMatch(src, /footer=/, 'and Discover passes it no footer');
  assert.doesNotMatch(src, /home-panel-footer/, 'no footer of its own');
  assert.doesNotMatch(src, /home-panel-bar/, 'and no title bar');
  // The browse control rides in the SECTION HEADING instead, and it is still
  // the same #home-browse-btn the old footer carried.
  assert.match(PANEL_SRC.sections, /action=\{<BrowseLink \/>\}/, "the heading action is the browse link alone — the ⋮ is gone");
  assert.match(PANEL_SRC.ui, /home-panel-browse/);
  // AND NO SEAM INSIDE IT. There used to be a hairline row carrying a
  // "Popular" caption between the curated cards and the most-used ones.
  // Discover is one category, so the sub-group label and the rule that drew
  // its hairline are both retired — asserted on the markup and on the
  // stylesheet, since a class with no rule still renders an empty row.
  assert.doesNotMatch(src, /home-discover-divider/);
  assert.doesNotMatch(src, />Popular</);
  assert.doesNotMatch(read('public/css/app.css'), /^\.home-discover-divider[\s,{:]/m,
    'and no rule is left to draw one');
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
  for (const key of ['discover', 'challenges']) {
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
  assert.match(rule, /margin-left:\s*auto/);
  assert.match(rule, /margin-right:\s*auto/);
  // The old per-box bound is gone for good.
  assert.doesNotMatch(css, /\.home-section-block\b/);
  assert.doesNotMatch(HOME_SRC, /alignSections|--home-section-indent/,
    'the measured icon indent went away with the centred column');
});

test('the browse action routes through the hash for a real history entry', () => {
  // The OS/browser back gesture has to return to home, so this navigates by
  // hash rather than calling the router directly.
  assert.match(PANEL_SRC.ui, /home-panel-browse[\s\S]*?location\.hash = '#apps'/);
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
  assert.match(on, /Create an app/);
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
  // The only thing that withholds it is a collapsed grid it would add a row
  // to (#3047) — and there it is behind "Show all N apps", not gone.
  assert.match(HOME_SRC, /create = createHidden \? null : \{\n\s+enabled: canCreate,/,
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
  assert.match(HOME_SRC, /CREATE_DISABLED_HINT: 'View your app allowance or request more slots\.'/);
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
  assert.match(APPS_ROUTE, /staging-demo-featured/);
  assert.match(APPS_ROUTE, /featured: true/);
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
  test(`staging Discover has addable reviewed fixtures with an ${prepopulated ? 'existing' : 'empty'} featured list`, async () => {
    const curation = require('../src/services/discovery-curation');
    const real = app({ id: 1, slug: 'real-cloned-app', directory_review_status: 'unreviewed', active_users: 10 });
    const fixtures = ['puzzle-chain', 'word-garden', 'pixel-racer'].map((name, i) => app({
      id: i + 2, slug: `staging-demo-${name}`, directory_review_status: 'unreviewed', active_users: 0,
    }));
    const featured = new Map(prepopulated ? [[real.id, 7]] : []);
    const pool = { async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      // Model just the fixture persistence; the actual Home selection and
      // review classification below execute production code.
      if (sql.startsWith('UPDATE apps SET icon_emoji')) {
        assert.match(sql, /created_by = \(SELECT id FROM users WHERE username = 'staging-demo-user'\)/);
        assert.match(sql, /AND directory_review_status = 'unreviewed'/);
        for (const fixture of fixtures) {
          if (fixture.directory_review_status !== 'unreviewed') continue;
          Object.assign(fixture, {
            icon_emoji: '🧩', main_sha: '0000000000000000000000000000000000000001',
            directory_review_status: 'working', directory_reviewed_at: '2026-09-07T12:00:00Z',
            directory_reviewed_sha: '0000000000000000000000000000000000000001',
          });
        }
        return { rows: [] };
      }
      if (sql === 'SELECT 1 FROM featured_apps LIMIT 1') {
        return { rows: featured.size ? [{ exists: 1 }] : [] };
      }
      if (sql.startsWith('SELECT id FROM apps')) {
        assert.match(sql, /created_by = \(SELECT id FROM users WHERE username = 'staging-demo-user'\)/);
        assert.match(sql, /AND directory_review_status = 'working'/);
        return { rows: fixtures.filter((a) => a.directory_review_status === 'working') };
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
    assert.equal(real.directory_review_status, 'unreviewed', 'no real app is certified by the seed');
    const apps = [real, ...fixtures].map((a) => ({
      ...a, directory: curation.describe(a), featured: featured.has(a.id), featured_order: featured.get(a.id),
    }));
    const Home = makeHome();
    const offered = Home.featuredApps(apps);
    // Featuring, not the review, decides the lane (#2565): a production app
    // the clone brought over already featured is offered at its admin-set
    // position even though the seed leaves it unreviewed. The fixtures follow
    // in seed order.
    assert.deepEqual(offered.map((a) => a.slug),
      (prepopulated ? [real.slug] : []).concat(fixtures.map((a) => a.slug)));
    assert.ok(offered.every((a) => !a.demo && !Home.isYours(a)),
      'real DB-backed fixtures must remain available to the Discover add/remove check');
  });
}

test('staging discovery fixtures never write outside staging', async () => {
  for (const env of ['production', 'local', undefined]) {
    await stagingFeaturedSeed(env === undefined ? '' : env)({ query() { assert.fail(`seed ran in ${env}`); } });
  }
});
