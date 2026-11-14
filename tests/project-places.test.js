'use strict';

// #4417: A PROJECT'S PLACES, AS ONE LIST.
//
// The four tabs (Hub · Discussion · Needs you · Workshop) became one list:
// Hub, Needs you and Workshop, a line, then Channels (#general) and Topics,
// each a group under its heading. On a phone it is the drawer's middle
// level, or a tray behind the merged header's button; from 768px it is nested
// under the community's row in the sidebar (tests/desktop-sidebar-nested.test.js),
// with the project's App row first (tests/desktop-sidebar-apps.test.js).
// These pin the list, the bar and the tray,
// the ladder that walks places, and the addresses that open one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const DIR = 'frontend/src/features/dev-board/workshop';
const LIST = `${DIR}/project-places.tsx`;
const BAR = `${DIR}/place-bar.tsx`;
const TRAY = `${DIR}/places-tray.tsx`;
const PLACES = `${DIR}/places.ts`;

const channel = (over) => ({
  id: null, kind: 'topic', key: null, handle: 'x', aliases: [], name: 'X', about: '', icon: '',
  state: 'live', merged_into: null, merged_at: null, requests: 0, unread: 0, ...over,
});
const PLACES_PAYLOAD = {
  owed: 29,
  channels: [
    channel({ kind: 'general', handle: 'general', name: '#general', unread: 0 }),
    channel({ id: 11, key: 'onboarding', handle: 'onboarding', name: 'Onboarding', icon: '🚪', unread: 3, requests: 9 }),
    channel({ id: 12, key: 'homeroom-bot', handle: 'homeroom-bot', name: 'Homeroom bot', aliases: ['bot'], unread: 0 }),
    channel({ id: 13, key: 'signup', handle: 'signup', name: 'Sign up', state: 'merged', merged_into: 'onboarding', merged_at: '2026-10-01T00:00:00Z' }),
    channel({ id: 14, key: 'infra', handle: 'infra', name: 'Infra', unread: 1 }),
  ],
};

function list(props) {
  const { ProjectPlaces } = loadTsx(LIST);
  return renderToHtml(createElement(ProjectPlaces, {
    slug: 'homeroom', name: 'Homeroom', place: 'status', owed: 0, places: PLACES_PAYLOAD, onPlace: () => {}, ...props,
  }));
}

test('the list: the pages, a line, then Channels over #general and Topics over the live topics, in order', () => {
  const html = list({});
  const order = [...html.matchAll(/data-place="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['status', 'needs', 'workshop', 'discussion', 'c:onboarding', 'c:homeroom-bot', 'c:infra'],
    'a merged topic is not listed; its channel stays readable by its links');
  assert.match(html, /^<div class="dev-ws-places" data-places="homeroom"><nav class="dev-ws-places-nav" aria-label="Homeroom&#x27;s places">/);
  // A line between the pages and the channels.
  assert.ok(html.indexOf('data-place="workshop"') < html.indexOf('role="separator"'));
  assert.ok(html.indexOf('role="separator"') < html.indexOf('data-place="discussion"'));
  // Each group is labelled by its heading.
  const groups = [...html.matchAll(/<div class="dev-ws-places-group" role="group" aria-labelledby="([^"]+)" data-places-group="([a-z]+)"><div id="([^"]+)" class="dev-ws-places-head">([A-Za-z]+)<\/div>/g)];
  assert.deepEqual(groups.map((g) => [g[2], g[4]]), [['channels', 'Channels'], ['topics', 'Topics']]);
  for (const g of groups) assert.equal(g[1], g[3], `${g[4]} is labelled by its own heading`);
  // #general by its handle, a channel's glyph the #.
  assert.match(html, /data-place="discussion"[^>]*><svg[^>]*dev-ws-place-hash[\s\S]*?<span class="dev-ws-place-label">general<\/span>/);
  // Every entry is a link with an address of its own.
  assert.match(html, /<a class="dev-ws-place" href="\/app\/homeroom\/dev\/hub" data-place="status"/);
  assert.match(html, /<a class="dev-ws-place" href="\/app\/homeroom\/dev\/discussion" data-place="discussion"/);
  assert.match(html, /<a class="dev-ws-place" href="\/app\/homeroom\/dev\/c\/onboarding" data-place="c:onboarding" title="Onboarding"/);
});

test('a project with no topics has no Topics heading: Hub, Needs you, Workshop and #general', () => {
  const html = list({ places: { owed: 0, channels: [channel({ kind: 'general', handle: 'general' })] } });
  assert.deepEqual([...html.matchAll(/data-place="([^"]+)"/g)].map((m) => m[1]), ['status', 'needs', 'workshop', 'discussion']);
  assert.doesNotMatch(html, />Topics</);
  // Before the record lands, the same: #general is always there.
  assert.deepEqual([...list({ places: null }).matchAll(/data-place="([^"]+)"/g)].map((m) => m[1]),
    ['status', 'needs', 'workshop', 'discussion']);
});

test('the open place is the current page, lit as the rail lights a row; a page under a place lights it', () => {
  const lit = (place) => [...list({ place }).matchAll(/data-place="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
  assert.deepEqual(lit('status'), ['status']);
  assert.deepEqual(lit('c:homeroom-bot'), ['c:homeroom-bot']);
  assert.deepEqual(lit('discussion'), ['discussion']);
  assert.deepEqual(lit('all'), ['workshop'], 'All items lights the Workshop');
  assert.deepEqual(lit('plan'), ['status'], 'the plan lights the Hub');
  assert.deepEqual(lit('c:signup'), [], 'a retired topic is not in the list to light');
  const CSS = read('public/css/app.css');
  assert.match(CSS, /\.dev-ws-place\[aria-current="page"\] \{ background: var\(--lit-tint\); color: var\(--lit-ink\); font-weight: 600; \}/);
});

test('counts say what they count aloud, and a zero says nothing', () => {
  const { countPhrase, countText } = loadTsx(LIST);
  assert.equal(countPhrase('needs', 29), '29 to vote');
  assert.equal(countPhrase('c:onboarding', 3), '3 unread');
  assert.equal(countPhrase('needs', 0), null);
  assert.equal(countText(120), '99+');
  // A channel's pill and its hover text say unread, the number capped; the
  // sr-only phrase keeps the real count.
  assert.equal(countPhrase('c:x', 150, countText(150)), '99+ unread');
  assert.equal(countPhrase('c:x', 150), '150 unread');
  const html = list({ owed: 29 });
  assert.match(html, /data-place="needs"[\s\S]*?<span class="dev-ws-place-count" data-place-count="" aria-hidden="true">29<\/span><span class="sr-only"> \(29 to vote\)<\/span><\/a>/);
  assert.match(html, /data-place="c:onboarding"[\s\S]*?title="3 unread">3 unread<\/span><span class="sr-only"> \(3 unread\)<\/span><\/a>/);
  assert.match(html, /data-place="c:infra"[\s\S]*?title="1 unread">1 unread<\/span><span class="sr-only"> \(1 unread\)<\/span><\/a>/);
  // #general has nothing unread here, and the Hub never counts: no number.
  const general = html.slice(html.indexOf('data-place="discussion"'), html.indexOf('</a>', html.indexOf('data-place="discussion"')));
  assert.doesNotMatch(general, /data-place-count/);
  assert.doesNotMatch(list({ owed: 0 }).slice(0, list({ owed: 0 }).indexOf('data-place="workshop"')), /data-place-count/);
});

// #5447: the channel on screen draws no count of its own — you are reading
// it — as the place bar already leaves it out of its unread. The count of
// Needs you stays while you are there: the rule is for channels.
test('the channel on screen draws no count; Needs you keeps its own while lit', () => {
  const reading = list({ place: 'c:onboarding' });
  const onboarding = reading.slice(reading.indexOf('data-place="c:onboarding"'), reading.indexOf('</a>', reading.indexOf('data-place="c:onboarding"')));
  assert.doesNotMatch(onboarding, /data-place-count/, 'no pill while you read there');
  assert.doesNotMatch(onboarding, /sr-only/, 'and no phrase for a screen reader');
  assert.match(reading, /data-place="c:infra"[\s\S]*?title="1 unread">1 unread<\/span>/, 'another channel keeps its pill');
  const needs = list({ place: 'needs', owed: 29 });
  assert.match(needs, /data-place="needs" aria-current="page"[\s\S]*?<span class="dev-ws-place-count" data-place-count="" aria-hidden="true">29<\/span><span class="sr-only"> \(29 to vote\)<\/span>/,
    'Needs you still counts while you are on it');
});

test('the tray\'s list ends with Switch community; the column\'s does not', () => {
  assert.match(list({ onSwitch: () => {} }), /<div class="dev-ws-places-foot"><button type="button" class="dev-ws-place" data-places-switch="">[\s\S]*?Switch community<\/span><\/button><\/div><\/div>$/);
  assert.doesNotMatch(list({}), /Switch community/);
});

test('the place bar names the place and nothing else: the header holds the places button', () => {
  const { PlaceBar, waitingPhrase } = loadTsx(BAR);
  const bar = (props) => renderToHtml(createElement(PlaceBar, { place: 'c:homeroom-bot', ...props }));
  const html = bar({});
  assert.match(html, /^<div class="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band="" data-place-bar="c:homeroom-bot"><div class="dev-ws-tabtrack">/,
    'the band\'s box, which pins and is measured');
  assert.match(html, /<h2 class="dev-ws-place-title" data-place-title=""><span class="dev-ws-place-title-hash">#<\/span>homeroom-bot<\/h2>/,
    'a channel by its handle, with a #');
  assert.doesNotMatch(html, /data-places-btn/, 'the places button is the header\'s alone (#6671)');
  assert.doesNotMatch(html, /data-places-waiting/, 'and the dot rides that button');
  assert.match(bar({ place: 'all' }), /data-place-title="">Workshop<\/h2>/, 'All items is the Workshop\'s page');
  assert.match(bar({ place: 'needs' }), /data-place-title="">Needs you<\/h2>/);
  assert.equal(waitingPhrase(0, 2), '2 unread');
  assert.equal(waitingPhrase(0, 0), null);
  // In the community's colour on a phone, the page's own title row on a wide window.
  const CSS = read('public/css/app.css');
  assert.match(CSS, /\.dev-ws-places-dot \{[^}]*box-shadow: 0 0 0 2px var\(--community-tint, #2a2e34\);/);
  assert.match(CSS, /@media \(min-width: 768px\) \{\n  \.dev-ws-placebar \.dev-ws-tabtrack \{ height: 52px; \}/);
});

test('the page draws the bar where the tabs were, and the tray only while it is open', () => {
  const WS = read(`${DIR}/workshop.tsx`);
  assert.match(WS, /const band = \(\s*<PlaceBar/);
  // #5386: the tray stays mounted while it slides out — `trayOpen` turns
  // false at once, `trayShown` holds it until the slide has run.
  assert.match(WS, /const tray = trayOpen \|\| trayShown \? \(\s*<PlacesTray/);
  assert.match(WS, /closing=\{!trayOpen\}/);
  assert.match(WS, /onClosed=\{\(\) => setTrayShown\(false\)\}/);
  assert.match(WS, /useEffect\(\(\) => \{ if \(trayOpen\) setTrayShown\(true\); \}, \[trayOpen\]\);/);
  // #4486: All items' way back is in its pinned head, so nothing sits
  // between the bar and the tray (which renders nothing in place).
  assert.match(WS, /\{band\}\s*\{tray\}/);
  assert.doesNotMatch(WS, /pageBar/);
  // A press on a place in the tray closes it as a navigating close, then
  // moves the page; the tray shuts when the place changes under it.
  assert.match(WS, /const choosePlace = \(key: TabKey\) => \{\s*trayNav\.current = true;\s*setTrayOpen\(false\);/);
  assert.match(WS, /useEffect\(\(\) => \{ setTrayOpen\(false\); \}, \[tab, v\.slug, placesInColumn\]\);/);
  // The page publishes where it is, and how to move it, for the column —
  // #4703: with the unread and the tray state the merged header's button
  // draws, and the toggle its press calls.
  assert.match(WS, /registerPlaceOpener\(mine, /);
  assert.match(WS, /registerTrayToggle\(mine, /);
  assert.match(WS, /publishPlace\(v\.slug, tab, owed, unreadElsewhere, trayOpen\)/);
});

test('the tray: rendered only while open, into the body; focus in and back; Escape, the scrim and a swipe close it', () => {
  const src = read(TRAY);
  // #5386: while it slides out the root wears `is-closing` (the CSS animates
  // the close) and takes no presses.
  assert.match(src, /return createPortal\(\s*<div\s*className=\{closing \? 'dev-ws-tray-root is-closing' : 'dev-ws-tray-root'\}\s*data-places-tray=""\s*inert=\{!!closing\}\s*aria-hidden=\{closing \|\| undefined\}\s*>/);
  assert.match(src, /document\.body,\s*\);/);
  assert.match(src, /<div className="dev-ws-tray-scrim" aria-hidden="true" onClick=\{\(\) => closeRef\.current\(\)\} \/>/);
  assert.match(src, /role="dialog"\s*aria-modal="true"\s*aria-label=\{label\}/);
  assert.match(src, /querySelector<HTMLElement>\('\[aria-current="page"\]'\)/, 'focus lands on the place you are on');
  assert.match(src, /back\.focus\(\{ preventScroll: true \}\)/, 'and goes back to the button');
  // The focus return and the Back release run in the close's own commit: the
  // effects depend on `closing`, so their cleanups fire when it starts.
  assert.match(src, /querySelector<HTMLElement>\('a\[href\], button'\);[\s\S]*?\}, \[closing\]\);/, 'the focus effect ends with the close\'s start');
  assert.match(src, /if \(e\.key === 'Escape'\) \{/);
  assert.match(src, /pushDismissible\(/, 'the device\'s Back closes it too');
  assert.match(src, /\{ navigating: true \} : undefined\);\s*\};\s*\}, \[closing\]\);/, 'a place press\'s navigating release, in the close\'s own commit');
  // The slide's end calls `onClosed`: the card's animationend, a 320ms
  // fallback if it is missed, and at once under reduced motion.
  assert.match(src, /onAnimationEnd=\{\(e\) => \{\s*if \(e\.target !== e\.currentTarget \|\| e\.animationName !== 'dev-ws-tray-out'\) return;\s*if \(!closingRef\.current\) return;/, 'the card\'s own out slide ends it');
  assert.match(src, /setTimeout\(\(\) => closedRef\.current\?\.\(\), 320\)/, 'a missed animationend never leaves it on screen');
  assert.match(src, /if \(reducedMotion\(\)\) \{\s*closedRef\.current\?\.\(\);/, 'reduced motion closes at once, as the open skips its slide');
  const { isEdgeSwipe, isCloseSwipe, edgeSwipeAllowed } = loadTsx(TRAY);
  assert.equal(isEdgeSwipe(4, 300, 120, 310), true, 'a swipe right from the edge');
  assert.equal(isEdgeSwipe(60, 300, 200, 300), false, 'not from the edge');
  assert.equal(isEdgeSwipe(4, 300, 40, 300), false, 'too short');
  assert.equal(isEdgeSwipe(4, 300, 80, 420), false, 'a scroll, not a swipe');
  assert.equal(isCloseSwipe(250, 300, 120, 310), true, 'a swipe left closes');
  assert.equal(isCloseSwipe(120, 300, 250, 300), false);
  // Safari on an iPhone takes the edge for Back: the button is the way in there.
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(edgeSwipeAllowed({ ua: iphone, maxTouchPoints: 5, standalone: false, native: false }), false);
  assert.equal(edgeSwipeAllowed({ ua: iphone, maxTouchPoints: 5, standalone: true, native: false }), true, 'an installed app has no browser Back');
  assert.equal(edgeSwipeAllowed({ ua: iphone, maxTouchPoints: 5, standalone: false, native: true }), true, 'nor the native shell');
  assert.equal(edgeSwipeAllowed({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile', maxTouchPoints: 5, standalone: false, native: false }), true);
  // #5386: the close's CSS — the open in reverse, presses passing through.
  const CSS = read('public/css/app.css');
  assert.match(CSS, /\.dev-ws-tray-root\.is-closing \{ pointer-events: none; \}/);
  assert.match(CSS, /\.dev-ws-tray-root\.is-closing \.dev-ws-tray \{ animation: dev-ws-tray-out 200ms cubic-bezier\(\.2, \.8, \.2, 1\) forwards; \}/);
  assert.match(CSS, /\.dev-ws-tray-root\.is-closing \.dev-ws-tray-scrim \{ animation: dev-ws-tray-fade-out 160ms ease-out forwards; \}/);
  assert.match(CSS, /@keyframes dev-ws-tray-out \{ from \{ transform: none; \} to \{ transform: translateX\(calc\(-100% \* var\(--rtl-sign\)\)\); \} \}/);
  assert.match(CSS, /@keyframes dev-ws-tray-fade-out \{ from \{ opacity: 1; \} to \{ opacity: 0; \} \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.dev-ws-tray-root\.is-closing \.dev-ws-tray, \.dev-ws-tray-root\.is-closing \.dev-ws-tray-scrim \{ animation: none; \}/);
  // #5384: it opens under the header, which stays undimmed and pressable,
  // and the list no longer pads for the status bar the header now covers.
  const root = CSS.slice(CSS.indexOf('.dev-ws-tray-root {'), CSS.indexOf('}', CSS.indexOf('.dev-ws-tray-root {')));
  assert.match(root, /top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\)\);/);
  assert.doesNotMatch(root, /inset: 0/, 'not over the header');
  const card = CSS.slice(CSS.indexOf('.dev-ws-tray {'), CSS.indexOf('}', CSS.indexOf('.dev-ws-tray {')));
  assert.match(card, /padding: 16px 12px calc\(16px \+ var\(--platform-safe-bottom, 0px\)\);/);
});

test('places: keys, handles, aliases and addresses', () => {
  const p = loadTsx(PLACES);
  assert.equal(p.channelPlace('general'), 'discussion');
  assert.equal(p.channelPlace('#Onboarding'), 'c:onboarding');
  assert.equal(p.placeHandle('discussion'), 'general');
  assert.equal(p.placeHandle('c:infra'), 'infra');
  assert.equal(p.placeHandle('workshop'), null);
  assert.equal(p.isPlaceKey('c:9bad'), false, 'a handle starts with a letter');
  assert.equal(p.findChannel(PLACES_PAYLOAD, 'bot').handle, 'homeroom-bot', 'a handle it had before a rename');
  assert.equal(p.findChannel(PLACES_PAYLOAD, 'signup').state, 'merged', 'a retired topic is still found');
  assert.equal(p.unreadTotal(PLACES_PAYLOAD), 4);
  assert.deepEqual({ ...p.topicHandleMap(PLACES_PAYLOAD) },
    { bot: 'homeroom-bot', onboarding: 'onboarding', 'homeroom-bot': 'homeroom-bot', signup: 'signup', infra: 'infra' });
  assert.equal(p.placeHref('notes', 'c:infra'), '/app/notes/dev/c/infra');
  assert.equal(p.placeHref('notes', 'needs'), '/app/notes/workshop?ws=needs');
  assert.equal(p.placeHref('notes', 'status'), '/app/notes/dev/hub', 'the Hub\'s own address');
});

test('the ladder walks places: a channel, Needs you or the Workshop goes up to the Hub, then to All communities', () => {
  const ladder = loadTsx('frontend/src/features/workshop/tab-ladder.ts');
  assert.equal(ladder.tabToReturnTo('c:onboarding'), 'c:onboarding', 'a channel is a place to come back to');
  assert.equal(ladder.tabToReturnTo('all'), 'workshop');
  assert.equal(ladder.tabToReturnTo('c:'), 'status');
  const WS = read(`${DIR}/workshop.tsx`);
  assert.match(WS, /below: \(\) => tabRef\.current !== 'status',\s*up: \(\) => climbRef\.current\(\),\s*host: \(\) => hostRef\.current,\s*depth: 1,/);
  // A reply thread beside a channel is deeper, and goes first.
  assert.match(read(`${DIR}/project-discussion.tsx`), /depth: 2,/);
  assert.match(read('frontend/src/features/workshop/tab-ladder.ts'), /\.sort\(\(a, b\) => \(b\.depth \|\| 0\) - \(a\.depth \|\| 0\)\)\[0\]/);
  const { pageParent } = loadTsx(`${DIR}/workshop.tsx`);
  assert.deepEqual(['c:onboarding', 'discussion', 'needs', 'workshop', 'all', 'plan'].map(pageParent),
    ['status', 'status', 'status', 'status', 'workshop', 'status']);
});

test('a channel\'s own address opens the page on it, and every old address keeps working', () => {
  const app = read('public/js/app.js');
  const at = app.indexOf('  _placeAddress(parts) {');
  assert.ok(at > 0);
  const body = app.slice(at, app.indexOf('\n  },\n', at) + 4).replace(/^ {2}_placeAddress/, 'function _placeAddress');
  const landed = [];
  const ctx = {
    AppView: {
      _isWorkshopPlace: (k) => k === 'discussion' || /^c:[a-z][a-z0-9-]{0,39}$/.test(k),
      _landOnTab: (slug, k) => landed.push([slug, k]),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${body.replace(/,\s*$/, '')}; this.fn = _placeAddress;`, ctx);
  const go = (hash) => {
    const parts = hash.split('/');
    const took = ctx.fn(parts);
    return { took, parts: parts.join('/') };
  };
  assert.deepEqual(go('app/notes/dev/c/onboarding'), { took: true, parts: 'app/notes/workshop' });
  assert.deepEqual(go('app/notes/dev/discussion'), { took: true, parts: 'app/notes/workshop' });
  assert.deepEqual(go('app/notes/dev/c/General'), { took: true, parts: 'app/notes/workshop' });
  assert.deepEqual(landed, [['notes', 'c:onboarding'], ['notes', 'discussion'], ['notes', 'discussion']]);
  for (const old of ['app/notes/dev/chat', 'app/notes/dev', 'app/notes/workshop', 'app/notes/dev/sessions/4', 'app/notes/dev/c']) {
    assert.deepEqual(go(old), { took: false, parts: old }, `${old} is left as it was`);
  }
  // Called before the app route parses its parts.
  assert.ok(app.indexOf('App._placeAddress(parts);') < app.indexOf("if (parts[0] === 'app' && parts[1]) {"));
  // A notification's address for a topic message opens that topic's channel.
  assert.match(app, /const topicRef = rest && rest\[0\] === 'c' \? App\._numericSegment\(rest\[1\]\) : null;/);
  // #4417 follow-up: with the place in the channel the address names (m/<id>, thread/<root>).
  assert.match(app, /void topics\(slug, topicRef, App\._messagesExtras\(rest\.slice\(2\)\)\);/);
  assert.match(read(`${DIR}/place-store.ts`), /export async function openTopicRef\(slug: string, ref: number, target: ChannelTarget \| null = null\)/);
});

// #4417 follow-up: a notification's address names a place IN the channel —
// `m/<id>`, a message to bring into view and mark, or `thread/<root>`, a reply
// thread to open beside it — and the door hands it to that topic's place the
// way #general's door hands #general hers (AppView._stashDiscussionTarget),
// named for the topic so only its place takes it.
test('a topic\'s door carries the place in the channel its address names, for that topic alone', async () => {
  let record = { places: PLACES_PAYLOAD };
  const reloads = [];
  const store = loadTsx(`${DIR}/place-store.ts`, {
    stubs: {
      './community-card': {
        cachedCommunity: () => record,
        communityInflight: () => false,
        reloadCommunity: async (slug) => { reloads.push(slug); },
      },
    },
  });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  const stashed = [];
  const landed = [];
  const replaced = [];
  globalThis.window = {
    location: { hash: '', replace: (to) => replaced.push(to) },
    AppView: {
      _stashDiscussionTarget: (slug, t) => stashed.push([slug, t]),
      _landOnTab: (slug, key) => landed.push([slug, key]),
    },
    App: { _hubHref: (slug) => `#app/${slug}/workshop` },
  };
  try {
    await store.openTopicRef('homeroom', 12, { focusMessageId: 5552 });
    assert.deepEqual(stashed, [['homeroom', { focusMessageId: 5552, threadRootId: null, topicRef: 12 }]]);
    assert.deepEqual(landed, [['homeroom', 'c:homeroom-bot']], 'the topic\'s place, by its handle now');
    assert.deepEqual(replaced, ['#app/homeroom/workshop'], 'replacing the address it came from');
    await store.openTopicRef('homeroom', 14, { threadRootId: 70 });
    assert.deepEqual(stashed.at(-1), ['homeroom', { focusMessageId: null, threadRootId: 70, topicRef: 14 }]);
    // An address naming no place in it opens the channel at its newest, as before.
    await store.openTopicRef('homeroom', 11, {});
    await store.openTopicRef('homeroom', 11);
    assert.equal(stashed.length, 2);
    // A row the record does not know is #general's place, with nothing for it to take.
    await store.openTopicRef('homeroom', 99, { focusMessageId: 1 });
    assert.equal(stashed.length, 2);
    assert.deepEqual(landed.at(-1), ['homeroom', 'discussion']);
    // A topic's read: its count in the list is the record's, read again only when it showed one.
    reloads.length = 0;
    store.channelRead('homeroom', 12);
    assert.deepEqual(reloads, [], '#homeroom-bot showed none');
    store.channelRead('homeroom', 11);
    store.channelRead('homeroom', 12, true);
    assert.deepEqual(reloads, ['homeroom', 'homeroom'], '#onboarding showed 3; a "Mark unread" always');
    // #4647: #general's read is the record's too — `ref` null names it.
    reloads.length = 0;
    store.channelRead('homeroom', null);
    assert.deepEqual(reloads, [], '#general showed none');
    store.channelRead('homeroom', null, true);
    assert.deepEqual(reloads, ['homeroom'], 'a "Mark unread" always, at 0 as well');
    record = { places: { ...PLACES_PAYLOAD, channels: PLACES_PAYLOAD.channels.map((c) => (c.kind === 'general' ? { ...c, unread: 4 } : c)) } };
    store.channelRead('homeroom', null);
    assert.deepEqual(reloads, ['homeroom', 'homeroom'], '#general showed 4');
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
  }
  // The bridge the group chat calls.
  assert.match(read(`${DIR}/place-store.ts`), /w\.UsernodeReact\.places = \{ topicHandles, openPlace, openTopicRef, channelRead \};/);
});

test('a topic\'s line: what it is for and its requests, nothing for none, and what became of a retired one', () => {
  const { topicLine } = loadTsx(`${DIR}/topic-head.tsx`);
  const t = { about: 'How it plans, builds and answers', state: 'live', requests: 14 };
  assert.deepEqual({ ...topicLine(t) }, { about: 'How it plans, builds and answers', link: '14 requests ›' });
  assert.deepEqual({ ...topicLine({ ...t, requests: 1 }) }, { about: t.about, link: '1 request ›' });
  assert.deepEqual({ ...topicLine({ ...t, requests: 0 }) }, { about: t.about, link: null }, 'a zero is not a door');
  assert.deepEqual({ ...topicLine({ ...t, state: 'merged' }, 'onboarding') }, { about: 'Merged into #onboarding. Read only.', link: null });
  assert.deepEqual({ ...topicLine({ ...t, state: 'archived' }) }, { about: 'Archived. Read only.', link: null });
  // A topic's empty room says so in its own words, not a reply thread's.
  assert.match(read('public/js/group-chat.js'), /a\.type === 'category' \? PlatformI18n\.t\('chat:group\.topicChannel\.empty'\) : PlatformI18n\.t\('chat:group\.thread\.empty'\)/);
  assert.equal(message('chat:group.topicChannel.empty'), 'Nothing said here yet.');
  assert.equal(message('chat:group.thread.empty'), 'No messages yet. Start the thread.');
});

// #5700: A PAGE LEFT BEHIND THE HIDDEN #app-view IS STILL MOUNTED, so its
// opener is still registered and moving it in place moves a page nobody can
// see. `door` says: route there anyway.
test('openPlace takes the door when it is asked to, even with the page\'s opener registered', () => {
  const store = loadTsx(`${DIR}/place-store.ts`, {
    stubs: {
      './community-card': {
        cachedCommunity: () => null,
        communityInflight: () => false,
        reloadCommunity: async () => {},
      },
    },
  });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  const opened = [];
  const landed = [];
  globalThis.window = {
    location: { hash: '' },
    AppView: { _landOnTab: (slug, key) => landed.push([slug, key]) },
    App: { _hubHref: (slug) => `#app/${slug}/workshop` },
  };
  const undo = store.registerPlaceOpener('garden', (key) => opened.push(key));
  try {
    store.publishPlace('garden', 'status', 0);
    assert.equal(store.openPlace('garden', 'needs', { door: true }), false, 'the door, not an in-place move');
    assert.deepEqual(opened, [], 'the mounted page was not moved');
    assert.deepEqual(landed, [['garden', 'needs']], 'the place it remembers');
    assert.equal(globalThis.window.location.hash, '#app/garden/workshop', 'and the page\'s address');
    // Without `door`, the in-place move is what it always was.
    assert.equal(store.openPlace('garden', 'needs'), true);
    assert.deepEqual(opened, ['needs']);
    assert.deepEqual(landed, [['garden', 'needs']], 'nothing else routed');
  } finally {
    undo();
    if (had) globalThis.window = was; else delete globalThis.window;
  }
});

// #3620: A PRESS WHILE THE PAGE STILL LOADS MOVES IT IN PLACE. The page
// registers its opener as it mounts and publishes its place only once
// loaded; a press in between taken as a door pushed no entry (the address
// is the page's already), so Back left the project instead of coming back
// to the hub. Slowed down, the declared #3620 check failed that way.
test('openPlace moves a mounted page in place while it still loads, so the press is a step Back undoes', () => {
  const store = loadTsx(`${DIR}/place-store.ts`, {
    stubs: {
      './community-card': {
        cachedCommunity: () => null,
        communityInflight: () => false,
        reloadCommunity: async () => {},
      },
    },
  });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  const opened = [];
  const landed = [];
  globalThis.window = {
    location: { hash: '#app/garden/workshop' },
    AppView: { _landOnTab: (slug, key) => landed.push([slug, key]) },
    App: { _hubHref: (slug) => `#app/${slug}/workshop` },
  };
  const undo = store.registerPlaceOpener('garden', (key) => opened.push(key));
  try {
    assert.equal(store.placeStore.get().slug, null, 'nothing published yet: the page is loading');
    assert.equal(store.openPlace('garden', 'workshop'), true, 'in place, not a door');
    assert.deepEqual(opened, ['workshop'], 'through the page\'s own press, which pushes the entry');
    assert.deepEqual(landed, [], 'no door');
    // Another project's place is still a door.
    assert.equal(store.openPlace('meadow', 'needs'), false);
    assert.deepEqual(landed, [['meadow', 'needs']]);
  } finally {
    undo();
    if (had) globalThis.window = was; else delete globalThis.window;
  }
});

// A SWITCH KEEPS YOUR PAGE (the header's ⌄ menu, a row of All communities):
// another community opens on the place you were on when it has it, else its
// hub. keepPlace is the phone drawer's rule; the place is the one the project
// page remembers (AppView._workshopTab).
test('a switch opens another community on the place you were on, else its hub', () => {
  const records = { homeroom: { places: PLACES_PAYLOAD } };
  const store = loadTsx(`${DIR}/place-store.ts`, {
    stubs: {
      './community-card': {
        cachedCommunity: (slug) => records[slug] || null,
        communityInflight: () => false,
        reloadCommunity: async () => {},
      },
    },
  });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  let remembered = 'workshop';
  const landed = [];
  globalThis.window = { AppView: { _workshopTab: () => remembered, _landOnTab: (slug, key) => landed.push([slug, key]) } };
  try {
    assert.equal(store.landKeepingPlace('homeroom'), 'workshop', 'the Workshop is in every community');
    remembered = 'c:infra';
    assert.equal(store.landKeepingPlace('homeroom'), 'c:infra', 'a topic it has');
    assert.equal(store.landKeepingPlace('garden'), 'status', 'a topic it is not known to have: its hub');
    remembered = 'all';
    assert.equal(store.landKeepingPlace('garden'), 'workshop', 'All items is under the Workshop');
    assert.deepEqual(landed, [['homeroom', 'workshop'], ['homeroom', 'c:infra'], ['garden', 'status'], ['garden', 'workshop']],
      'each is where the page then opens');
    globalThis.window = {};
    assert.equal(store.landKeepingPlace('garden'), 'status', 'nothing remembered: its hub');
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
  }
});
