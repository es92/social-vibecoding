'use strict';

// A PHONE GETS AROUND A COMMUNITY FROM ITS HUB (Evan, 3 Nov 2026: "lose one
// layer of sidebar").
//
// Under 768px a community's places were a drawer beside its page. The drawer
// is gone (tests/nav-drawer.test.js pins the header that is left): the Hub is
// how a phone reaches the places, and All communities, a grid of tiles, is
// where it switches community. These pin the two halves of that:
//
//   - the Hub's rows: For you's Workshop row, always there on a phone and
//     named for the place it opens, and a Topics card, a row a live topic,
//     each opening its channel (frontend/src/features/dev-board/workshop/
//     hub-cards.tsx TopicsCard, drawn by ./workshop.tsx on a phone only);
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
  assert.match(topics, /trailing=\{unread \? \(/);
  assert.match(topics, /t\('project:hub\.channel\.unread', \{ count: unread, shown: unread > 99 \? '99\+' : String\(unread\) \}\)/);
  // The first few, then the rest behind "Show N more", as the sidebar folds them.
  assert.match(cards, /export const HUB_TOPICS_SHOWN = 6;/);
  assert.match(topics, /t\('project:places\.list\.showMore', \{ count: more \}\)/);
  assert.equal(message('project:hub.topics.title'), 'Topics');

  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /\{slug && drawerOn \? <TopicsCard data=\{community\} onOpen=\{\(key\) => openTab\(key\)\} \/> : null\}/,
    'on a phone only: a wide window lists the topics in its sidebar');
  assert.match(ws, /places=\{drawerOn\}\s*\/>/);
});

test('on a phone For you\'s Workshop row is always there, and named for the place it opens', () => {
  const cards = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(cards, /const work = cards \|\| !!mine\?\.viewer \|\| places;/);
  assert.match(cards, /<WorkRow mine=\{mine\} onOpen=\{onWork\} place=\{places\} \/>/);
  assert.match(cards, /title=\{place \? placeName\('workshop'\) : t\('project:hub\.work\.title'\)\}/);
});
