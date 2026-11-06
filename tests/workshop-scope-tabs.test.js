'use strict';

// The Communities screen's scope chip and its Needs you row (#2718, #3051).
//
// The screen answers "which of my apps wants something from me": a chip that
// says what you are looking at and narrows it, a row that totals the votes
// owed, and one row per app carrying both of its numbers.
//
// ── What this suite used to pin, and why it does not ──────────────────
//
// A TAB STRIP (Current status / Needs you / All items) and a PLUS. Both are
// retired from this screen on the owner's review, and the reason is worth
// keeping because it is the argument that would bring them back: those three
// words are the APP Workshop's, about one app's items. Up here the list is of
// APPS, each row already showing both figures, so the tabs hid whole apps to
// say what their rows were saying anyway — and the plus asked "which app?"
// before two questions ("propose a change", "report a problem") that can only
// be asked inside an app.
//
// AND THE SCOPE CHIP (#2759). It read "All apps" here and its panel listed
// your apps — but this screen IS that list, every row the way into its app's
// Workshop, so the chip was the page repeating itself.
//
// ── #3051 brought two of those back, on the owner's request ──────────
//
// The chip, reading "All apps", and two of the tabs: Current status and
// Needs you. The UI overhaul took the tabs away again: your in-flight items
// moved to Profile's Your changes, which left Current status holding only
// the list, so the list is the page and Needs you is ONE ROW at its top
// ("3 votes waiting on you") that opens the cross-community feed as a page
// with a way back. Nothing filters the list of apps, which is the argument
// above. All items and the plus stay retired: every item of every app is not
// a page, and the plus's two questions can still only be asked inside an app.
//
// ── #852 made the tab a community, and the chip's panel a switcher ─────
//
// The fourth tab is the community you are on (or All communities), and
// "Your communities" is how you change which: a sheet on a phone, a menu on a
// wide window, opened from the lit tab, the header's name and ⌄, and the All
// chip here (features/workshop/community-switcher.tsx). The "Which project?"
// panel both ends of the chip shared is gone. Its audience sections and "Show
// N more" (#3363) went with it for a round and were back in the switcher
// (#3519) until #5290, which made it a search, then Recent, then the All
// communities row: the page itself is where every community is listed.
//
// What is pinned, each a way the screens can be quietly wrong:
//
//   1. PICKING A COMMUNITY GOES TO ITS HUB, and All communities to the list.
//   2. THE SWITCHER SAYS WHICH ONE YOU ARE ON, and what each waits on you for.
//   3. THE NEEDS YOU ROW SAYS NOTHING OVER A ZERO, and totals every
//      project, not a filtered few.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const SCREEN = read('frontend/src/features/workshop/index.tsx');

const SCOPE = read('frontend/src/features/workshop/community-scope.ts');
const SWITCHER = read('frontend/src/features/workshop/community-switcher.tsx');

test('picking a community keeps the page you were on, and All communities goes to Home\'s (One Home, #6361)', () => {
  const at = SCOPE.indexOf('export function goToCommunity(');
  const fn = SCOPE.slice(at, SCOPE.indexOf('\n}\n', at));
  assert.match(fn, /closeSwitcher\(\);/, 'the switcher closes either way');
  assert.match(fn, /setScope\(null\);[\s\S]*?_forgetWorkshopView[\s\S]*?home\.showCommunities\(\{ all: true \}\);/,
    'All communities is Home\'s Pinned communities, with its All communities open');
  assert.match(fn, /setScope\(slug\);[\s\S]*?if \(onPage\) return;\s*landKeepingPlace\(slug\);/,
    'a community opens on the place you were on, else its hub');
  assert.match(fn, /void app\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.ok(!fn.includes('startSession') && !fn.includes('giveFeedback'), 'nothing is started from the switcher');
  // Join a community is Discover; #3543: Start a community is the new-project dialog.
  // One Home (#6361): joining one is Home's Communities to join.
  assert.match(SWITCHER, /data-switcher-join=""\s*(?:\/\/[^\n]*\n\s*)?onClick=\{\(\) => \{ closeSwitcher\(\); \(window as any\)\.Home\?\.showCommunitiesToJoin\?\.\(\); \}\}/);
  assert.match(SWITCHER, /data-switcher-start=""\s*onClick=\{\(\) => \{ closeSwitcher\(\); \(window as any\)\.App\?\.showCreateModal\?\.\(\); \}\}/);
});

test('All communities is Home\'s at every width, with nothing opened behind it (One Home, #6361)', () => {
  const calls = [];
  const mod = loadTsx('frontend/src/features/workshop/community-scope.ts', {
    stubs: {
      '../dev-board/workshop/place-store': {
        landKeepingPlace: (slug) => { calls.push(['land', slug]); return 'status'; },
      },
    },
  });
  mod.communityScopeStore.set({ slug: null, list: ['garden', 'swap'] });
  const had = { window: global.window, document: global.document };
  let phone = true;
  const location = { hash: '#home' };
  const shown = [];
  global.window = {
    matchMedia: (q) => ({ matches: q.includes('768px') ? !phone : false }),
    location,
    Home: { showCommunities: (opts) => shown.push(opts) },
    App: {
      currentApp: null,
      navigateToApp: (slug, tab) => { calls.push(['nav', slug, tab]); return Promise.resolve(); },
    },
  };
  global.document = { querySelector: () => null };
  try {
    mod.goToCommunity(null);
    assert.deepEqual(shown, [{ all: true }], 'a phone: Home\'s All communities');
    assert.deepEqual(calls, [], 'nothing opened behind it');
    // The community the tab is on does not change that.
    mod.communityScopeStore.set({ slug: 'swap', list: ['garden', 'swap'] });
    mod.goToCommunity(null);
    // A wide window is the sidebar's own All row: the same.
    phone = false;
    mod.goToCommunity(null);
    assert.deepEqual(shown, [{ all: true }, { all: true }, { all: true }]);
    assert.deepEqual(calls, []);
    assert.equal(location.hash, '#home', 'no address of its own: Home is where it lands');
  } finally {
    global.window = had.window;
    global.document = had.document;
  }
});

test('the switcher says which community you are on, who each is for, and what it waits on you for', () => {
  const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
  const info = {
    garden: { slug: 'garden', name: 'Garden', iconUrl: null, iconEmoji: '🌱', iconColor: '#2e6660', audience: 'open', memberCount: 23, needs: 2 },
    club: { slug: 'club', name: 'Club', iconUrl: null, iconEmoji: null, iconColor: null, audience: 'invited', memberCount: 1, needs: 0 },
    notes: { slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', iconColor: null, audience: 'solo', memberCount: 1, needs: 0 },
  };
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const render = (slug) => {
    const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
      stubs: {
        './community-scope': {
          ...real,
          communityScopeStore: fixedStore({ slug, info, list: ['garden', 'club', 'notes'], totalNeeds: 2, switcher: 'header', anchor: null }),
        },
      },
    });
    return renderToHtml(createElement(mod.SwitcherBody, {}));
  };
  const all = render(null);
  assert.match(all, /<h2 class="community-switcher-title" id="community-switcher-title">Your communities<\/h2>/);
  // #5290: the search first, then Recent, then All communities.
  assert.match(all, /<input id="community-switcher-search" type="search" class="community-switcher-search-input"[^>]*placeholder="Search your communities" aria-label="Search your communities" aria-keyshortcuts="Meta\+K Control\+K"/);
  assert.ok(all.indexOf('community-switcher-search') < all.indexOf('data-switcher-section="recent"'), 'the search comes first');
  assert.match(all, /<h3 class="community-switcher-section" id="switcher-recent-label"><span>Recent<\/span><\/h3>/);
  const rows = [...all.matchAll(/data-switcher-community="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['garden', 'club', 'notes', 'all'], 'Recent in the list\'s order, then All communities');
  assert.match(all, /data-switcher-community="all" aria-current="true"/, 'with none chosen, All communities is the one you are on');
  assert.match(all, /All communities<\/span><span class="community-switcher-sub">3 communities<\/span>/);
  assert.match(all, /data-switcher-waiting="">2 to vote</, 'what they all wait on you for');
  assert.match(all, />Public · 23 members<\/span>/);
  assert.match(all, />Private · 1 member<\/span>/);
  assert.match(all, />Just you<\/span>/);
  assert.equal((all.match(/data-switcher-waiting/g) || []).length, 2, 'a zero says nothing');
  assert.ok(all.indexOf('data-switcher-join') > all.indexOf('data-switcher-community="all"'), 'Join, then Start, last');
  assert.ok(all.indexOf('data-switcher-start') > all.indexOf('data-switcher-join'));
  assert.match(all, />Join a community</);
  assert.match(all, />Start a community</);
  // It no longer repeats the All communities page's sections (#5290).
  assert.doesNotMatch(all, /data-switcher-section="(open|invited|solo)"/);
  assert.doesNotMatch(all, /data-switcher-more=/);
  const one = render('garden');
  assert.match(one, /data-switcher-community="garden" aria-current="true"/, 'the tab\'s community is ticked');
  assert.doesNotMatch(one, /data-switcher-community="all" aria-current/);
  assert.match(one, /color-mix\(in srgb, #2e6660 12%, transparent\)/, 'and tinted in its own colour');
});

test('#5290: Recent is your pins, then the sidebar\'s five; the search matches every community by name', () => {
  const sw = loadTsx('frontend/src/features/workshop/community-switcher.tsx');
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(sw.switcherRecent([], [], null), [], 'nothing before the list is read');
  assert.deepEqual(sw.switcherRecent([], [], list), ['a', 'b', 'c', 'd', 'e'], 'the most recently active five, to begin with');
  assert.deepEqual(sw.switcherRecent([], ['g', 'x', 'b'], list), ['g', 'b', 'a', 'c', 'd'], 'this device\'s order, as the sidebar keeps it');
  assert.deepEqual(sw.switcherRecent(['h', 'zz', 'h'], ['g'], list), ['h', 'g', 'a', 'b', 'c', 'd'],
    'pins first, only ones you are in, once, and never twice beside the five');
  assert.deepEqual(sw.switcherRecent(['a'], [], list), ['a', 'b', 'c', 'd', 'e', 'f']);
  // The search: the rule the screen and the drawer search by, over every community.
  assert.match(SWITCHER, /const found = q \? matchRows\(rowsOf\(st\.list \|\| \[\]\), q\) : \[\];/);
  assert.match(SWITCHER, /import \{ matchRows \} from '\.\/sections';/);
  assert.match(SWITCHER, /data-switcher-results=""/);
  assert.match(SWITCHER, /data-switcher-none="">\{t\('communities:switcher\.search\.none', \{ query: q \}\)\}/);
  // Down from the box into the rows; Enter opens the first match.
  assert.match(SWITCHER, /if \(e\.key === 'ArrowDown'\) \{[\s\S]{0,200}querySelector<HTMLButtonElement>\('\.community-switcher-list \.community-switcher-row'\)\?\.focus\(\);/);
  assert.match(SWITCHER, /else if \(e\.key === 'Enter' && found\[0\]\) \{[\s\S]{0,80}goToCommunity\(found\[0\]\.slug\);/);
  // The All communities row stays outside the search, so the page is always a press away.
  const at = SWITCHER.indexOf('data-switcher-community="all"');
  assert.ok(at > SWITCHER.indexOf('data-switcher-section="recent"') && at > SWITCHER.indexOf('data-switcher-results'));
  // ⌘K focuses the search; a press on the header lands on the row you are on.
  assert.match(SWITCHER, /if \(from === 'shortcut'\) \{\s*panel\.querySelector<HTMLInputElement>\('#community-switcher-search'\)\?\.focus\(\);/);
});

test('#852: every class the switcher draws with has a rule, and the menu floats at a fixed size', () => {
  // A REAL REGRESSION. Deleting the two-column hub's rules took the block
  // under them with it, and the switcher rendered unstyled: its rows as
  // inline text, each icon at its natural size across the page. Nothing
  // failed, because nothing read the stylesheet for it.
  const CSS = read('public/css/app.css');
  const used = [...new Set(SWITCHER.match(/community-switcher(?:-[a-z]+)*/g))];
  const unstyled = used.filter((c) => !new RegExp(`\\.${c}(?![-\\w])[^{}]*\\{`).test(CSS));
  assert.deepEqual(unstyled, [], 'each community-switcher-* class the component uses is styled in app.css');
  assert.match(CSS, /\.community-switcher-menu \{[^}]*position: fixed;[^}]*width: 364px;/,
    'the wide menu floats, at a fixed width');
  assert.match(CSS, /\.community-switcher-scrim \{[^}]*position: fixed;/, 'the phone sheet sits over a scrim');
  assert.match(CSS, /\.community-switcher-tile \{[^}]*width: 40px; height: 40px;/, 'and a community\'s tile has a size');
  assert.match(CSS, /\.community-switcher-tile > img \{ width: 100%; height: 100%;/, 'which its icon fills rather than overflowing');
  assert.match(CSS, /\.platform-tab-tile > img \{ width: 100%; height: 100%;/, 'as the tab\'s tile does');
});

test('All items, the plus and the tabs are gone, and so is the list (#3051; One Home, #6361)', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create', 'workshop-picker',
    'workshop-tab-status', 'workshop-tab-needs', 'workshop-total-working', 'workshop-total-needs']) {
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // One Home (#6361): the list went to Home, and the feed is the page.
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.doesNotMatch(store, /^\s*(?:tab|rows):/m, 'the store holds the feed alone');
  assert.doesNotMatch(store, /scopeOpen/, 'Your communities keeps its own open flag (#852)');
  assert.doesNotMatch(store, /itemsError|^\s*items:/m, 'the items read left with the pane it filled');
  // The chip's module went with the chip and its panel (#852).
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/workshop/workshop-chrome.tsx')));
});

test('#3051, #852: Needs you\'s bar says its name, with no switcher and no chip (One Home, #6361)', () => {
  // #852 put the Communities switcher in the bar at every width; One Home
  // left the screen as Needs you, whose bar names it.
  assert.doesNotMatch(SCREEN, /AllAppsScope|id="workshop-scope"/);
  assert.ok(!HTML.includes('id="workshop-scope"'), 'no chip in the cold document');
  assert.ok(!HTML.includes('id="community-switcher"'), 'and the switcher is behind a press');
  const html = renderHeader({ screen: 'workshop-screen' });
  assert.doesNotMatch(html, /id="header-scope-switch"/);
  // The page still steps down past the header's notch before its first row.
  assert.match(SCREEN, /<div className="pt-5" aria-hidden="true" \/>/);
});

// ── #3363's sections live on the Communities screen ───────────────────
//
// The panel drew the screen's three audience sections from one shared module.
// The switcher lists communities in the screen's own order (orderRows), and
// draws the screen's sections and fold from the same module (#3519).

const SECTIONS_SRC = read('frontend/src/features/workshop/sections.ts');

test('#3363: the order is one shared module\'s', () => {
  for (const name of ['groupRows', 'orderRows', 'sectionFold', 'SECTION_LIMIT', 'SECTION_STEP', 'SECTIONS']) {
    assert.match(SECTIONS_SRC, new RegExp(`export (?:function|const) ${name}\\b`), `${name} lives in sections.ts`);
    assert.doesNotMatch(SCREEN, new RegExp(`(?:function|const) ${name}\\b`), `and the page has no second ${name}`);
    assert.doesNotMatch(SCOPE, new RegExp(`(?:function|const) ${name}\\b`), 'nor the switcher\'s store');
  }
  assert.match(SCOPE, /import \{ orderRows \} from '\.\/sections';/);
  assert.match(SCOPE, /const ordered = orderRows\(joined as any\)/, 'newest first, as the screen orders them');
});

/** A store that holds one state and never changes, for a static render. */
const fixed = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

test('#852: a project page leads with its tabs, and All items with its way back under them; no panel of its own', () => {
  const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const real = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const page = (tab) => {
    const view = { ...real.EMPTY_WORKSHOP_VIEW, loading: false, slug: 'notes-ab12', tab };
    const mod = loadTsx(WORKSHOP_PATH, {
      stubs: { '../card/cards-store': { ...real, devWorkshopStore: fixed(view) } },
    });
    return renderToHtml(createElement(mod.DevWorkshop, {}));
  };
  // #3583: the page also says whose it is (`data-ws-slug`), which AppView
  // reads when it saves the list's offset on the way out.
  assert.match(page('workshop'), /^<div class="dev-ws" data-ws-tab="workshop" data-ws-slug="notes-ab12"><div class="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band="" data-place-bar="workshop">/);
  // #4486: All items' way back is the first thing in its pinned head, one
  // row with the search and the grouping, under the place bar (#4417).
  assert.match(page('all'), /^<div class="dev-ws" data-ws-tab="all" data-ws-slug="notes-ab12"><div class="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band="" data-place-bar="all">[\s\S]*?<\/h2><\/div><\/div><div class="dev-ws-tabbody"><section class="dev-ws-pane" data-ws-pane=""><div class="dev-ws-pane-head"><div class="dev-ws-allbar" data-ws-allbar=""><div class="dev-ws-pagehead" data-ws-pagehead=""><button type="button" class="dev-ws-page-back un-touch-target" data-ws-page-back=""/);
  const ws = read(WORKSHOP_PATH);
  assert.doesNotMatch(ws, /AppWorkshopScope|useScopeInline|scopeFitsInline|data-ws-scope-inline|SCOPE_INLINE_/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /data-ws-scope-inline|\.dev-ws-scope\b/, 'the panel\'s CSS went with it');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/workshop/app-scope-store.js')), 'and its store');
});

/** #header-title as rendered on an app route, with the stores it reads fixed. */
function renderHeader({
  viewMode = 'workshop', subTab = 'forum', screen = 'app-view', name = 'Recipe Box', selfHosted = false,
} = {}) {
  const mod = loadTsx('frontend/src/features/header/header-title.tsx', {
    stubs: {
      './header-title-store.js': { headerTitleStore: fixed({ text: name, subtitle: '' }) },
      '../nav/nav-store.js': { navStore: fixed({ screen }) },
      '../improve/improve-store.js': {
        improveStore: fixed({ tab: 'dev', subTab, name, iconUrl: null, iconEmoji: '🍲', selfHosted }),
      },
      '../dev-board/view-mode-store': { useDevViewMode: () => viewMode },
      '../workshop/community-scope': {
        communityScopeStore: fixed({ switcher: null }),
        toggleSwitcher: () => {},
      },
    },
  });
  return renderToHtml(createElement(mod.HeaderTitle, { titleRef: { current: null } }));
}

test('#2768, #3295, #852: on the app\'s Workshop the header\'s name opens Your communities, at every width', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  // Which screen: the Dev half's board route in its Workshop layout.
  assert.match(header,
    /const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';/);
  // NO WIDTH IN IT. Until #3295 this was `onWorkshop && phone`, and a desktop
  // kept the name alone in the bar beside a chip in the page.
  // #3602: a card opened from it switches community too.
  assert.match(header, /const onCard = inApp && tab === 'dev' && subTab === 'topic';/);
  // D (18 Oct 2026): from 1024px the sidebar lists the communities, so the
  // name is a name there (`communityName`); below it, the switcher.
  assert.match(header, /const communityPage = onWorkshop \|\| onCard;/);
  assert.match(header, /const appSwitch = communityPage && !sidebarRows;/);
  assert.match(header, /const communityName = communityPage && sidebarRows;/);
  assert.match(header, /const showTile = inApp;/);

  // A static render runs no effects, so the phone flag is still false: this
  // IS the desktop render. The tile and the app's name are one button that
  // opens Your communities.
  const html = renderHeader();
  assert.match(html,
    /<button id="header-app-switch" type="button" class="pointer-events-auto [^"]*" data-community-switch="" aria-haspopup="dialog" aria-expanded="false" aria-controls="community-switcher" aria-label="Recipe Box, switch community"><span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span><svg/);

  // The Kanban layout has no scope panel, so there the strip is a tile and a
  // name, not a control.
  const kanban = renderHeader({ viewMode: 'kanban' });
  assert.doesNotMatch(kanban, /header-app-switch/);
  assert.match(kanban, /<span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span class="min-w-0 flex items-baseline gap-1\.5"><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span>/);

  // #3602: a card (an issue, a proposal, a decision) opened from the
  // Workshop keeps the switcher, whichever layout it was opened from.
  for (const viewMode of ['workshop', 'kanban']) {
    const card = renderHeader({ subTab: 'topic', viewMode });
    assert.match(card, /<button id="header-app-switch" type="button"[^>]*aria-label="Recipe Box, switch community"><span id="header-app-tile"/);
  }
  // The general chat and an owner session still have no switcher.
  for (const subTab of ['chat', 'sessions']) {
    assert.doesNotMatch(renderHeader({ subTab }), /header-app-switch/);
  }

  // The Communities screen's title was the bar's switcher too (#852), until
  // One Home (#6361) gave its list to Home.
  assert.doesNotMatch(header, /allAppsSwitcher/);
  assert.match(header, /const sidebarRows = useSidebarRows\(\);/);
  assert.doesNotMatch(header, /PHONE_QUERY|usePhone/);
});

test('#3497: on Homeroom\'s own pages the switcher names it with the logotype, not the word', () => {
  // The Communities tab with Homeroom selected: the platform's own row, on
  // its hub. The bar names the platform with the logotype on Home, and the
  // switcher here used to be the one place it was plain type.
  const html = renderHeader({ name: 'Homeroom', selfHosted: true });
  const button = html.match(/<button id="header-app-switch"[\s\S]*?<\/button>/);
  assert.ok(button, 'the name is still the switcher');
  assert.match(button[0], /aria-label="Homeroom, switch community"/,
    'the button says the name in words, which is why the drawing can be decoration');
  const label = button[0].match(/<span id="header-title-name" class="min-w-0 truncate">([\s\S]*?)<\/span>/);
  assert.ok(label, 'the named slot and its truncation stay');
  assert.match(label[1], /^<svg class="h-5 w-\[77\.5px\]" fill="currentColor" viewBox="0 0 1236\.9 319\.2" aria-hidden="true">/,
    'the logotype, at the size Home draws it, in the bar\'s own ink');
  assert.doesNotMatch(label[1], /Homeroom/, 'drawn INSTEAD of the word, not beside it');
  assert.match(button[0], /<span id="header-app-tile"/, 'the community\'s tile still leads');
  assert.match(button[0], /<\/span><svg class="w-4 h-4 shrink-0"[^>]*aria-hidden="true">/, 'and the ⌄ still follows');

  // The platform is the self-hosted ROW, not a name: a project somebody
  // called Homeroom keeps its word.
  const namesake = renderHeader({ name: 'Homeroom', selfHosted: false });
  assert.match(namesake, /<span id="header-title-name" class="min-w-0 truncate">Homeroom<\/span>/);
  assert.doesNotMatch(namesake, /viewBox="0 0 1236\.9 319\.2"/);
});
