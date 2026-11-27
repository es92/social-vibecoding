'use strict';

// A PHONE GETS AROUND A COMMUNITY FROM ITS HUB (Evan, 3 Nov 2026: "lose one
// layer of sidebar").
//
// Under 768px a community's places were a drawer beside its page. The drawer
// is gone (tests/nav-drawer.test.js pins the header that is left): the Hub is
// how a phone reaches the places, and All communities, a grid of tiles, is
// where it switches community. These pin the two halves of that:
//
//   - the Hub's rows: For you's Workshop row, always there for a signed-in
//     viewer and named for the place it opens, and a Topics card, a row a
//     live topic, each opening its channel (frontend/src/features/dev-board/
//     workshop/hub-cards.tsx TopicsCard, drawn by ./workshop.tsx on a phone
//     only);
//   - All communities as a grid on a phone (frontend/src/features/workshop/
//     index.tsx CommunityTile), whose tile is a door to the Hub.
//
// Run with: node --test tests/phone-nav-hub-and-grid.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('on a phone the Hub lists every live topic, each a door to its channel', () => {
  const cards = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const topics = cards.slice(cards.indexOf('export function TopicsCard('), cards.indexOf('/* ── The hub while it loads'));
  assert.match(topics, /const topics = liveTopics\(data\?\.places\);\s*if \(!topics\.length\) return null;/, 'a project with no topics draws no card');
  assert.match(topics, /onClick=\{\(\) => onOpen\(channelPlace\(topic\.handle\)\)\}/, 'a row opens the topic\'s channel');
  assert.match(topics, /data-ws-hub-topic=\{topic\.handle\}/);
  assert.match(topics, /<span className="dev-ws-foryou-handle">#\{topic\.handle\}<\/span>/, 'its #handle, as the Discussion row has #general');
  // One pill a row, and a zero says nothing.
  assert.match(topics, /titleClassName=\{TITLE_WITH_PILL\}/, "its new count on the title line (phone review #91)");
  // One look (25 Nov 2026): what is new is the shared grey tag.
  assert.match(topics, /\), unread \? \(\n\s*<StateTag data-ws-hub-topic-unread/);
  assert.match(topics, /t\('project:hub\.channel\.unread', \{ count: unread, shown: capCount\(unread\) \}\)/);
  // The first few, then the rest behind "Show N more", as the sidebar folds them.
  assert.match(cards, /export const HUB_TOPICS_SHOWN = 6;/);
  assert.match(topics, /t\('project:places\.list\.showMore', \{ count: more \}\)/);
  assert.equal(message('project:hub.topics.title'), 'Topics');

  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  // At every width.
  // 26 Nov 2026: in the hub's thin column (.dev-ws-hub-side), which is drawn only with a project.
  assert.match(ws, /<div className="dev-ws-hub-side">[\s\S]*?<TopicsCard data=\{community\} onOpen=\{\(key\) => openTab\(key\)\} \/>/,
    'at every width, not the phone alone');
  const css = read('public/css/app.css');
  // A wide window's hub is one centred column of at most 1132px, a request page's width (asked 24 Nov 2026):
  // the one rule that says so, from 1281px. The older two-column block (1080px, request 6654) lost to the look's
  // own rules and was removed with it.
  assert.match(css, /@media \(min-width: 1281px\) \{\s*html:root body #dev-workshop:has\(> \.dev-ws\[data-ws-tab="status"\]\) \{ max-width: 1132px; \}/, 'the hub stops at 1132px on a wide window');
  assert.doesNotMatch(css, /max-width: 1080px/, 'no second width for the hub');
  assert.doesNotMatch(css, /\[data-ws-hub-for-you\] \+ \[data-ws-hub-topics\] \{ grid-column: 2; \}/, 'the dead two-column block is gone');
  // The Invite card (InviteHeroCard) was the brand look's hub alone, removed
  // 26 Nov 2026: Invite is the hero row's own button.
});

test('For you\'s Workshop row is there at every width, opening the Workshop, and named for the place', () => {
  const cards = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  // 3 Nov 2026: a row of its own on a phone, beside Your work, which opened
  // the Homeroom bot tab. 6 Nov 2026: it takes Your work's place, at every
  // width, as For you's door to the project's Workshop.
  assert.match(cards, /\{work \? <WorkshopRow onOpen=\{onWork\} \/> : null\}/);
  // 26 Nov 2026: `room` is the #general row, there unless the hub draws the Discussion card itself.
  assert.match(cards, /if \(!needs && !work && !room\) return null;/, 'there for a signed-in viewer, with no phone-only flag');
  assert.doesNotMatch(cards, /places=\{drawerOn\}|data-ws-mine-card/, 'no Your work row on the Hub any more');
  assert.match(cards, /title=\{placeName\('workshop'\)\}\s+subtitle=\{t\('project:hub\.workshop\.sub'\)\}/);
});
