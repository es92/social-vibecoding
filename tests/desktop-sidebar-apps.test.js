'use strict';

// Apps in their communities, in the desktop's sidebar of rows (18 Oct 2026).
//
// Each community's app is the first row under it (App), with the green
// "still open" dot while its frame is kept; a community whose app is still
// running keeps that row alone under its own while you are in another one,
// and is never pushed out of the sidebar. The strip's Pinned and Recent apps
// went with it: a pin is a community's, in a Pinned section above your
// communities and outside the five.
//
//   frontend/src/features/nav/rail-communities.tsx  the rows
//   frontend/src/features/nav/rail-pinned.tsx       the pinned section
//   frontend/src/features/nav/rail-nest.tsx         a part inside a part
//
// tests/desktop-sidebar-rows.test.js has which five; tests/nav-tab-bar.test.js
// the pin gestures; tests/resume-collapse.test.js the App row as the target a
// closing app shrinks into.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const RAIL = 'frontend/src/features/nav/rail-communities.tsx';
const PINNED = 'frontend/src/features/nav/rail-pinned.tsx';

// A row, drawn on its own against a list of yours.
function drawRow(here, { info, list, slug = 'chess', record = null } = {}) {
  const state = { slug: null, info: info || {}, list: list === undefined ? Object.keys(info || {}) : list };
  const { RailCommunityRow } = loadTsx(RAIL, {
    stubs: {
      '../workshop/community-scope': {
        communityScopeStore: { get: () => state, subscribe: () => () => {} },
        goToCommunity: () => {},
      },
    },
  });
  return renderToHtml(createElement(RailCommunityRow, {
    slug,
    record,
    here: { sidebarRows: true, screen: 'app-view', onPage: null, onApp: null, live: [], ...here },
  }));
}

const CHESS = { chess: { slug: 'chess', name: 'Chess', iconUrl: null, iconEmoji: null, iconColor: null, selfHosted: false } };

test('which communities lead with App: not Homeroom\'s own, and not before it is known', () => {
  const { hasAppRow } = loadTsx(RAIL);
  assert.equal(hasAppRow('chess', CHESS, ['chess']), true);
  assert.equal(hasAppRow('home', { home: { selfHosted: true } }, ['home']), false, 'the platform is its app');
  assert.equal(hasAppRow('chess', {}, null), false, 'not before the list of yours is read');
  assert.equal(hasAppRow('chess', { chess: { name: 'Chess' } }, ['chess']), false, 'one of yours, not yet known');
  assert.equal(hasAppRow('stranger', {}, ['chess']), true, 'one that is not yours is never Homeroom, which every account is in');
});

test('in its app: the community open, App first and lit without the dot, no place lit', () => {
  const html = drawRow({ onApp: 'chess', live: ['chess'] }, { info: CHESS });
  assert.match(html, /<a class="platform-rail-community" href="#app\/chess\/workshop" data-rail-community="chess" data-rail-open="" title="Chess" aria-current="page">/);
  const app = html.indexOf('data-rail-app="chess"');
  const places = html.indexOf('data-places="chess"');
  assert.ok(app > 0 && places > app, 'App, then its places');
  assert.match(html, /<div class="platform-rail-nest" data-nest="open"><div class="platform-rail-nest-in"><div class="platform-rail-app-row"><a class="platform-rail-sub platform-rail-app" href="\/app\/chess" data-rail-app="chess" data-live="true" title="Chess app" aria-label="Chess app" aria-current="page">/);
  assert.match(html, /class="platform-rail-sub-glyph"/);
  // No "still open" dot on the app you are in (audit N04): it is for an app
  // kept loaded behind another page, where its close X sits.
  assert.match(html, new RegExp(`<span class="platform-rail-sub-name">${message('core:rail.app')}</span></a>`));
  assert.doesNotMatch(html, /app-live-dot/);
  assert.match(html, /<div class="platform-rail-nest platform-rail-places" data-nest="open">/, 'the places in a part inside it');
  assert.doesNotMatch(html.slice(places), /aria-current/, 'in the app, App is lit and no place is');
});

test('in another community: a running app keeps its App row alone; a stopped one keeps nothing', () => {
  const kept = drawRow({ screen: 'app-view', onPage: 'other', live: ['chess'] }, { info: CHESS });
  assert.match(kept, /data-rail-app="chess" data-live="true"/);
  assert.doesNotMatch(kept, /aria-current/, 'nothing of it is lit');
  assert.doesNotMatch(kept, /data-rail-open/);
  assert.doesNotMatch(kept, /data-places=/, 'its places folded away');
  const gone = drawRow({ screen: 'app-view', onPage: 'other', live: [] }, { info: CHESS });
  assert.doesNotMatch(gone, /platform-rail-nest/, 'no part at all');
  // On its page, App is there without the dot until the app has run.
  const page = drawRow({ onPage: 'chess' }, { info: CHESS });
  assert.match(page, /<a class="platform-rail-sub platform-rail-app" href="\/app\/chess" data-rail-app="chess" title="Chess app" aria-label="Chess app">/);
  // Homeroom's own community: its places, and no App row.
  const home = drawRow({ onPage: 'home' }, { slug: 'home', info: { home: { slug: 'home', name: 'Homeroom', selfHosted: true } } });
  assert.match(home, /data-places="home"/);
  assert.doesNotMatch(home, /data-rail-app/);
});

test('in the app of a community you have not joined: its App row alone, lit, and no record read', () => {
  const html = drawRow({ onApp: 'stranger', live: ['stranger'] }, { slug: 'stranger', info: {}, list: ['chess'] });
  assert.match(html, /data-rail-community="stranger" title="stranger" aria-current="page"/, 'lit, named by what is known');
  assert.match(html, /data-rail-app="stranger" data-live="true"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /data-places=|data-rail-open/, 'no places, so nothing reads its community record');
  // Only a page you are visiting is read for its name.
  assert.match(read(RAIL), /const visit = useCommunity\(c \|\| record \|\| recent \|\| onPage !== slug \? '' : slug\);/);
});

test('a pin is drawn as any community is, named by its own record when the list does not have it', () => {
  const html = drawRow({ onPage: 'x' }, { slug: 'gym', info: {}, list: ['chess'], record: { name: 'Gym', iconUrl: null, iconEmoji: '🏋️' } });
  assert.match(html, /data-rail-community="gym" title="Gym"/);
  assert.match(html, /<span class="platform-rail-name">Gym<\/span>/);
});

test('a still-open app off screen offers its close X; the one on screen does not', () => {
  // The app is running but the viewer is elsewhere: the dot has the X beside
  // it, named for the app, and the dot itself stays in the anchor where the
  // kept-apps declared check finds it.
  const html = drawRow({ live: ['chess'] }, { info: CHESS });
  assert.match(html, new RegExp([
    '<button type="button" class="platform-rail-live-stop"',
    `title="${message('core:liveApp.closeTitle')}"`,
    'aria-label="Close Chess app">',
  ].join(' ')));
  assert.ok(html.indexOf('platform-rail-live-stop') > html.indexOf('data-rail-app="chess"'), 'after the App row');
  assert.match(html, /<span class="app-live-dot platform-rail-live"/);
  assert.ok(html.indexOf('app-live-dot') < html.indexOf('platform-rail-live-stop'), 'dot still in the anchor');
  // The app on screen: no X, nothing to close it away from.
  const onScreen = drawRow({ onApp: 'chess', live: ['chess'] }, { info: CHESS });
  assert.doesNotMatch(onScreen, /platform-rail-live-stop/);
  // A row whose app is not running has nothing to close.
  assert.doesNotMatch(drawRow({ onPage: 'chess' }, { info: CHESS }), /platform-rail-live-stop/);
  // Pressing the X closes the app, not the row's own open, and the focus it
  // would drop lands on the App row.
  const src = read(RAIL);
  assert.match(src, /event\.preventDefault\(\);\n {18}event\.stopPropagation\(\);/);
  assert.match(src, /appRef\.current\?\.focus\(\);\n {18}closeLiveApp\(slug\);/);
  // The reveal: hover and keyboard focus show the X, and the dot is hidden
  // while it is up.
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-nest \.platform-rail-live-stop:hover,\n {2}\.platform-rail-nest \.platform-rail-live-stop:focus-visible \{\n {4}opacity: 1;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-app-row:has\(\.platform-rail-live-stop:is\(:hover, :focus-visible\)\) \.platform-rail-live \{\n {4}visibility: hidden;\n {2}\}/);
});

test('the source: the part holds App, then the places; the five leave the pins out and keep a running app', () => {
  const src = read(RAIL);
  assert.match(src, /const part = open \|\| \(sidebarRows && app && \(running \|\| onApp === slug\)\);/);
  assert.match(src, /<NestSlot open=\{part\} className="platform-rail-nest" rows="\.platform-rail-app, \.dev-ws-place, \.dev-ws-places-head">\s*\{app \? \(/);
  assert.match(src, /\(window as unknown as \{ App\?: \{ openAppTab\?: \(slug: string, tab: string\) => void \} \}\)\.App\?\.openAppTab\?\.\(slug, 'app'\);/,
    'App opens through the router, which switches to a kept app');
  // The five are the most recent of yours that are not pinned, and opening
  // one keeps a running app's community in.
  assert.match(src, /const listKey = yours \? yours\.filter\(\(s\) => !pinned\.includes\(s\)\)\.join\(\) : null;/);
  assert.match(src, /const next = noteOpened\(saved, slug, list, RAIL_COMMUNITIES, live\);/);
  // #21: the visit draws the five it read first; what you open is kept for
  // the next load.
  assert.match(src, /if \(ready && list && visit\.viewer !== viewer\) setVisit\(\{ viewer, slugs: saved \}\);/);
  assert.match(src, /const shown = visit\.viewer === viewer \? railCommunities\(visit\.slugs, list\) : saved;/);
  // The section: the five, then a visit and a running app not among them,
  // less the pinned ones.
  assert.match(src, /railRows\(shown, here\.onPage \|\| here\.onApp, here\.live\)/);
  assert.match(src, /\.filter\(\(slug\) => !pinned\.includes\(slug\)\);/);
  // #18 (19 Oct polish board): the All row states every vote waiting on
  // you, the tab's own figure, not the remainder after the rows above it.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /const allVotes = Number\(scope\.badgeNeeds\) \|\| 0;/);
  assert.match(bar, /key === 'workshop' && allVotes > 0 \? \(\s*<span className="platform-tab-all-votes" aria-label=\{t\('core:tabs\.votesWaiting', \{ count: allVotes \}\)\}>/);
  assert.doesNotMatch(bar, /votesElsewhere/);
});

test('the pinned section: its own heading, the pins drawn as rows, the slot while a tile is in the air', () => {
  const src = read(PINNED);
  assert.match(src, /<RailCommunityRow key=\{app\.slug\} slug=\{app\.slug\} here=\{here\} record=\{app\} pin=\{handlers\(app\)\} \/>/);
  assert.match(src, /readPinnedApps\(who\)/, 'the stored pins, read after mount');
  const store = read('frontend/src/features/nav/pinned-apps-store.js');
  assert.match(store, /const KEY = 'usernode_community_pins_v1';/, 'the account\'s list as this device last read it');
  assert.match(store, /const DEVICE_KEY = 'usernode_pinned_apps_v2';/,
    'the key an app was pinned under before: sent up once, so it is its community\'s pin now');
  assert.equal(message('core:rail.pin.here'), 'Pin here');
  assert.equal(message('core:rail.pin.unpin'), 'Unpin');
});

test('a part inside a part: the inner one opens with the outer, not after it', () => {
  const src = read('frontend/src/features/nav/rail-nest.tsx');
  assert.match(src, /const Appearing = createContext\(false\);/);
  assert.match(src, /const appearing = open && !present\.current;/);
  assert.match(src, /const still = reducedMotion\(\) \|\| typeof el\.animate !== 'function' \|\| \(fresh && withParent\);/);
  assert.match(src, /<Appearing\.Provider value=\{appearing\}>\{open \? children : kept\.current\}<\/Appearing\.Provider>/);
  // The outer part draws the one line and the padding round both.
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-nest \.platform-rail-places > \.platform-rail-nest-in \{\n {4}padding: 0;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-app-row \+ \.platform-rail-places > \.platform-rail-nest-in \{\n {4}padding-top: 1px;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-places > \.platform-rail-nest-in::before \{\n {4}display: none;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-live \{\n {4}width: 8px;\n {4}height: 8px;/, 'the dot at a row\'s size');
});

test('in its app, the row\'s votes move to Needs you under it instead of vanishing (audit N04)', () => {
  const info = { chess: { ...CHESS.chess, needs: 2 } };
  // Folded (another page): the row carries the figure, after its pin (One
  // Home, #6361), and says it in words inside its link.
  const folded = drawRow({ onPage: 'other' }, { info });
  assert.match(folded, /<button type="button" class="platform-rail-pin"[^>]*>[\s\S]*?<\/button><span class="platform-rail-votes" aria-hidden="true">2<\/span><\/div>/);
  assert.match(folded, new RegExp(`<span class="sr-only">${message('core:tabs.votesWaiting', { count: 2 })}</span></a>`));
  // In its app the part opens: the row gives its figure to Needs you.
  const inApp = drawRow({ onApp: 'chess', live: ['chess'] }, { info });
  assert.doesNotMatch(inApp, /platform-rail-votes/);
  const needs = inApp.slice(inApp.indexOf('data-place="needs"'));
  assert.ok(inApp.includes('data-place="needs"'), 'Needs you is listed');
  assert.match(needs.slice(0, 1200), /class="dev-ws-place-count"[^>]*>2<\/span>/, 'and counts the same 2');
  // An unchosen community's votes stay off both.
  const unchosen = drawRow({ onApp: 'chess', live: ['chess'] }, { info: { chess: { ...info.chess, unchosen: true } } });
  assert.doesNotMatch(unchosen, /dev-ws-place-count/);
});
