'use strict';

// v3 (18 Oct 2026) — the desktop's sidebar of rows nests what the second
// column held. From 1024px the community whose page is up opens its places
// under its row, and the inbox opens its five latest conversations and All
// messages under Messages; the section column and Messages' list column step
// aside, All communities is one page, and Discover is a compass.
//
// What is pinned, each a way it could quietly go back:
//
//   1. WHICH ROWS: a visited community gets a row; which five conversations,
//      the open one kept; no topic is a row of the places list (#6709).
//   2. THE MARKUP: the conversations' element is always there, right after
//      Messages, empty in the prerender; the places are the column's own list.
//   3. THE MOTION: one clock and the content's own height, so the rows under
//      both parts move one way.
//   4. THE PAGES: the inbox draws one pane at a time from 1024px and no
//      crowding there; All communities is one page; the All row goes there.
//   5. THE LOOK: one indent a level, one unbroken line, the parent unfilled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const block1024 = () => {
  const css = read('public/css/app.css');
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  assert.ok(at > 0, 'the sidebar\'s block');
  return css.slice(at, css.indexOf('\n}\n', at));
};

test('which rows: a community you are visiting has one for as long as you are on its page', () => {
  const { railRows } = loadTsx('frontend/src/features/nav/rail-communities.tsx');
  assert.deepEqual(railRows(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(railRows(['a', 'b'], 'b'), ['a', 'b'], 'one of the five keeps its row');
  // #21 (19 Oct polish board): after the five, so a visit never moves them.
  assert.deepEqual(railRows(['a', 'b'], 'x'), ['a', 'b', 'x'], 'a visited one comes after the five');
  // Then any other whose app is still running and is not among the five.
  assert.deepEqual(railRows(['a', 'b'], 'x', ['x', 'b', 'y']), ['a', 'b', 'x', 'y'], 'once each, the five first');
});

test('the places: the column\'s own list, with no topic rows and no fold', () => {
  const places = {
    channels: [
      { kind: 'general', handle: 'general', state: 'live', unread: 0 },
      ...['onboarding', 'homeroom-bot', 'design', 'bugs'].map((handle, i) => ({ kind: 'topic', handle, name: handle, icon: '', state: 'live', unread: 0, id: i + 1 })),
    ],
  };
  const props = (place) => ({ slug: 'notes', name: 'Notes', place, owed: 2, places, onPlace: () => {} });
  // #6709: a project's topics are not rows of its places list, whatever the
  // place — there is no fold left to open them from.
  for (const place of ['status', 'c:bugs', null]) {
    const html = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', props(place));
    assert.doesNotMatch(html, /data-place="c:/, 'no topic channel row');
    assert.doesNotMatch(html, /data-places-group="topics"/, 'no Topics group');
    assert.doesNotMatch(html, /data-places-more/, 'and no "Show N more"');
    assert.match(html, /data-place="discussion"/, 'the list ends after #general');
  }
  // Before the page has said where it is, nothing is lit.
  const unknown = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', props(null));
  assert.doesNotMatch(unknown, /aria-current/);
  // The sidebar's part is that list, under the community's own row.
  const rail = read('frontend/src/features/nav/rail-communities.tsx');
  assert.match(rail, /<ProjectPlaces[\s\S]*?filtered=\{[^}]+\}\s*onPlace=\{\(key\) => \{ openPlace\(slug, key\); \}\}/);
  assert.match(rail, /const open = sidebarRows && \(onPage === slug \|\| \(onApp === slug && yours\)\);/, 'it opens with the page, or the app of one of yours');
  assert.match(rail, /<NestSlot open=\{open\} className="platform-rail-nest platform-rail-places" rows="\.dev-ws-place, \.dev-ws-places-head">\s*<RailPlaces slug=\{slug\} onPage=\{onPage === slug\} needs=\{needs\} \/>/);
  // Open, its votes are Needs you's count, in its app too (audit N04).
  assert.match(rail, /const needs = c && !c\.unchosen \? Number\(c\.needs\) \|\| 0 : 0;\s*const votes = open \? 0 : needs;/, 'open, its votes are Needs you\'s count');
  assert.match(rail, /owed=\{here \? place\.owed : needs\}/);
});

test('the markup: Messages has nothing nested under it, and Communities, then Recents, follow it (7 Nov 2026)', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html, /<span class="platform-tab-label">Messages<\/span><\/a><a id="platform-tab-workshop"/,
    'Messages, then the Communities row (#6019; One Home #6361 put AI above Messages)');
  assert.match(html, /<span class="platform-tab-label">Communities<\/span><\/a><div id="platform-rail-pinned"/,
    'and Recents under it');
  assert.ok(html.indexOf('id="platform-tab-ai"') < html.indexOf('id="platform-tab-messages"'), 'AI above Messages');
  assert.doesNotMatch(html, /platform-rail-nest|platform-rail-conversations/);
  // The sidebar nests under a community's row alone: the conversations it
  // held under Messages (v3) and the module that worked them out are gone.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/nav/rail-conversations.tsx')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/messages/rail-inbox.ts')));
  assert.doesNotMatch(read('frontend/src/features/nav/tab-bar.tsx'), /RailConversations/);
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /publishRailInbox|railOpenKey|railRow/);
});

test('the motion: one clock for both parts, on the content\'s own height', () => {
  const src = read('frontend/src/features/nav/rail-nest.tsx');
  const { NEST_MS, NEST_EASE } = loadTsx('frontend/src/features/nav/rail-nest.tsx');
  assert.equal(NEST_MS, 260);
  assert.equal(NEST_EASE, 'cubic-bezier(.3,.7,.2,1)');
  assert.match(src, /\[\{ gridTemplateRows: `minmax\(0px, \$\{from\}fr\)` \}, \{ gridTemplateRows: open \? 'minmax\(0px, 1fr\)' : 'minmax\(0px, 0fr\)' \}\]/);
  assert.match(src, /if \(start !== null\) motion\.startTime = start;/, 'a part that heard late joins the clock already running');
  assert.match(src, /reducedMotion\(\) \|\| typeof el\.animate !== 'function'/);
  const css = block1024();
  assert.match(css, /\.platform-rail-nest \{\n    flex: none;\n    display: grid;\n    grid-template-rows: minmax\(0, 1fr\);\n    grid-template-columns: minmax\(0, 1fr\);\n    overflow: hidden;\n  \}/);
  assert.match(css, /\.platform-rail-communities > \.platform-rail-nest \{\n    margin-top: -1px;\n  \}/, 'the section\'s gap does not arrive with it');
});

test('the pages: the inbox\'s list beside a conversation, the list as the page with none open, and the lit Communities row goes to its page', () => {
  const inbox = read('frontend/src/features/messages/index.tsx');
  // 7 Nov 2026: with the sidebar's nest under Messages gone, an open
  // conversation has the list beside it again; with none open the list is
  // the page (All messages).
  assert.match(inbox, /const railClass = sidebarRows && !drawer\.on && !chatOpen \? ' messages-list-page' : '';/);
  assert.doesNotMatch(inbox, /messages-list-in-rail/);
  const store = read('frontend/src/features/messages/store.ts');
  // One pane at a time is a phone's alone: from 768px the list sits beside
  // the conversation, so no desktop width is too narrow for both (#4229).
  assert.match(store, /function listAside\(\): boolean \{\n  return isMobile\(\);\n\}/);
  assert.doesNotMatch(store, /LIST_BESIDE_MIN_WIDTH|sidebarRowsUp|listCrowded/);
  const css = block1024();
  assert.doesNotMatch(read('public/css/app.css'), /messages-list-in-rail/);
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-thread-pane \{\n    display: none;\n  \}/);
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-list-pane \{\n    flex: 1 1 auto;\n    width: auto;\n    max-width: 720px;/);
  // No width has the strip's column of conversations any more (from 768px).
  const all = read('public/css/app.css');
  assert.doesNotMatch(all, /MESSAGES' COLUMN IS ITS OWN LIST/);
  assert.doesNotMatch(css, /data-workshop-panes/, 'no column and page on All communities');
  // #5296: a search's answer IS the one list, narrowed in place, so no CSS
  // hides the list for it. One Home (#6361): that list is Home's now.
  assert.doesNotMatch(all, /data-workshop-results/, 'no second list for a search');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /if \(key === 'workshop' && sidebarRows && lit === 'workshop'\) \{\s*event\.preventDefault\(\);\s*if \(screen === 'communities-screen'\) pressLitTab\(screen\);\s*else goToCommunity\(null\);/);
  // The bar draws no places button of its own (#6671), so there is none to
  // hide beside the docked sidebar.
  assert.doesNotMatch(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) \.dev-ws-places-btn \{\n    display: none;\n  \}/);
});

test('the look: one indent a level, one unbroken line, the parent unfilled; AI a sparkle', () => {
  const css = block1024();
  assert.match(css, /\.platform-rail-nest-in::before \{\n    content: "";\n    position: absolute;\n    top: 2px;\n    bottom: 6px;\n    inset-inline-start: 18px;\n    width: 1px;/, 'one line under the parent\'s tile, past the sub-headers, at the start edge');
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-place, \.platform-rail-sub\) \{[^}]*margin-inline-start: 24px;[^}]*\}/);
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-places-group \.dev-ws-place, \.platform-rail-group\[data-rail-headed\] \.platform-rail-sub\) \{\n    margin-inline-start: 36px;\n  \}/, 'a headed group is a step in');
  assert.match(css, /padding-block: 8px 3px; padding-inline: 30px 8px;[^}]*text-transform: none;/, 'sub-headers where the rows above start, in sentence case');
  assert.match(css, /\.platform-rail-community\[data-rail-open\]\[aria-current="page"\] \{\n    background: transparent;/);
  assert.doesNotMatch(css, /platform-rail-conversations/);
  assert.match(css, /--platform-rail-full: 212px;/, 'the deeper rows need 212px');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  // #6019: the Homeroom bot tab wears the bot's picture in line, not a
  // sparkle. One Home (#6361): Discover's compass is gone; its directory is
  // Home's Communities to join.
  assert.match(bar, /\{ key: 'ai' as const, label: 'core:tabs\.ai', href: '#homeroom-bot', Icon: HomeroomBotIcon \}/);
  assert.doesNotMatch(bar, /key: 'discover'|CompassIcon/);
});
