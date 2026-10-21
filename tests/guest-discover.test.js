'use strict';
// The guest Discover and a public project's guest page (frontend/src/features/
// guest): what a visitor with no account sees on the landing
// (frontend/src/features/auth/landing.tsx).
//
//   - the pure sorting, filtering and featuring Discover does (guest-data.ts);
//   - Discover rendered: every card a link to the project's own page, no card
//     locked, "Try it" only where the app has a view for visitors;
//   - the project page rendered: Try it or Sign in to use it, Join, counts
//     and never a name;
//   - the story's short version over Discover, which keeps the landing's
//     declared checks' Continue and email line;
//   - the bar's one quiet Sign in, and the sheets titled for what a visitor
//     tried to do.
//
// Run with: node --test tests/guest-discover.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const DATA = 'frontend/src/features/guest/guest-data.ts';
const DISCOVER = 'frontend/src/features/guest/guest-discover.tsx';
const PROJECT = 'frontend/src/features/guest/guest-project.tsx';
const STORY = 'frontend/src/features/auth/story.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const APPS = [
  {
    slug: 'game-corner', name: 'Game Corner', description: 'Classic games, fresh every day.', category: 'games',
    featured: true, featured_order: 2, active_users: 43, open_votes: 7, created_at: '2026-06-19T00:00:00.000Z',
    contributors: [{}, {}, {}], guest_ready: true, requires_login: true, url: 'https://game-corner.example',
  },
  {
    slug: 'todo-list', name: 'Todo List', description: 'A shared todo app.', category: 'tools',
    featured: true, featured_order: 1, active_users: 12, open_votes: 0, created_at: '2026-06-10T00:00:00.000Z',
    contributors: [{}], guest_ready: false, requires_login: true, url: 'https://todo-list.example',
  },
  {
    slug: 'fresh-one', name: 'Fresh', description: null, category: null,
    featured: false, featured_order: null, active_users: 0, open_votes: 2, created_at: TWO_DAYS_AGO,
    contributors: [{}, {}, {}, {}, {}], guest_ready: true, requires_login: false, url: 'https://fresh-one.example',
  },
];

// ─── guest-data.ts ────────────────────────────────────────────────

test('the sorts: most active, newest, most built, ties in the directory\'s order', () => {
  const { sortApps } = loadTsx(DATA);
  const slugs = (sort) => sortApps(APPS, sort).map((a) => a.slug);
  assert.deepEqual(slugs('trending'), ['game-corner', 'todo-list', 'fresh-one']);
  assert.deepEqual(slugs('new'), ['fresh-one', 'game-corner', 'todo-list']);
  assert.deepEqual(slugs('built'), ['fresh-one', 'game-corner', 'todo-list']);
  const tie = [{ slug: 'a', active_users: 1 }, { slug: 'b', active_users: 1 }];
  assert.deepEqual(sortApps(tie, 'trending').map((a) => a.slug), ['a', 'b']);
});

test('search reads the name and the description; a kind narrows to its apps', () => {
  const { filterApps } = loadTsx(DATA);
  assert.deepEqual(filterApps(APPS, 'shared todo', null).map((a) => a.slug), ['todo-list']);
  // Case and spaces aside, a word in the name or the description finds it.
  assert.deepEqual(filterApps(APPS, '  FRESH ', null).map((a) => a.slug), ['game-corner', 'fresh-one']);
  assert.deepEqual(filterApps(APPS, '', 'games').map((a) => a.slug), ['game-corner']);
  assert.deepEqual(filterApps(APPS, 'todo', 'games'), []);
});

test('the kinds are the ones the directory has, in the manifest\'s order, and nothing for Other alone', () => {
  const { presentCategories, CATEGORIES } = loadTsx(DATA);
  assert.deepEqual([...CATEGORIES], ['games', 'social', 'tools', 'learning', 'creative', 'other']);
  assert.deepEqual(presentCategories(APPS), ['games', 'tools']);
  assert.deepEqual(presentCategories([{ category: 'other' }, { category: null }]), []);
  // The same list app-manifest.js accepts, which the server validates against.
  const { APP_CATEGORIES } = require('../src/services/app-manifest');
  assert.deepEqual([...CATEGORIES], [...APP_CATEGORIES]);
});

test('Featured is what an admin featured, in their order; a project page lives at its hub', () => {
  const { featuredApps, projectHash } = loadTsx(DATA);
  assert.deepEqual(featuredApps(APPS).map((a) => a.slug), ['todo-list', 'game-corner']);
  assert.equal(projectHash('game-corner'), '#app/game-corner/workshop');
});

// ─── guest-discover.tsx ───────────────────────────────────────────

const discoverProps = (over = {}) => ({
  apps: APPS, failed: false, hero: null, primaryClass: 'pill', waitlist: true,
  onContinue() {}, onOpenInside() {}, ...over,
});

test('every card opens its project\'s page, and no card is locked', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  const cards = [...html.matchAll(/<a href="([^"]+)" data-guest-card="([^"]+)"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(cards, [
    ['game-corner', '#app/game-corner/workshop'],
    ['todo-list', '#app/todo-list/workshop'],
    ['fresh-one', '#app/fresh-one/workshop'],
  ]);
  assert.doesNotMatch(html, /Account required|grayscale|data-icon="lock"/);
  // One phrase under a card: how many use it, else what is up for a vote. A
  // zero says nothing; a project made lately wears New.
  const words = text(html);
  assert.ok(words.includes(message('auth:guest.card.active_other', { count: 43 })));
  assert.ok(words.includes(message('auth:guest.card.votes_other', { count: 2 })));
  assert.ok(!words.some((w) => /^0 /.test(w)), 'no zero is printed');
  assert.ok(words.includes(message('auth:guest.card.new')));
});

test('Featured leads with the admin\'s order, and offers Try it only where the app has a view for visitors', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  const featured = [...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(featured, ['todo-list', 'game-corner']);
  assert.match(html, /<a href="https:\/\/game-corner\.example" data-guest-try="game-corner"/);
  assert.doesNotMatch(html, /data-guest-try="todo-list"/);
});

test('the kinds, the sort, and one card that says what an account adds', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.match(html, /data-guest-category="all"[^>]*>All</);
  assert.match(html, /data-guest-category="games"/);
  assert.match(html, /data-guest-category="tools"/);
  assert.doesNotMatch(html, /data-guest-category="learning"/, 'only kinds some app has');
  assert.match(html, /aria-pressed="true" data-guest-sort="trending"/);
  assert.match(html, /data-guest-join=""/);
  const words = text(html);
  for (const id of ['auth:guest.join.title', 'auth:guest.join.vote.title', 'auth:guest.join.ask.title', 'auth:guest.join.make.title', 'auth:guest.join.waitlist']) {
    assert.ok(words.includes(message(id)), id);
  }
  // The card's way in is the story's own Continue, the one form for new and
  // returning people (#5251).
  assert.match(html, /data-guest-join-continue=""[^>]*>Continue</);
  const without = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ waitlist: false }));
  assert.ok(!text(without).includes(message('auth:guest.join.waitlist')));
});

test('while the directory loads, placeholders; when it cannot be read, a line that says so', () => {
  const loading = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: null }));
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /data-guest-card=/);
  assert.doesNotMatch(loading, /data-guest-join=/, 'nothing to join in on yet');
  const failed = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: null, failed: true }));
  assert.ok(text(failed).includes(message('auth:guest.loadFailed')));
});

// ─── guest-project.tsx ────────────────────────────────────────────

const projectProps = (app) => ({ app, primaryClass: 'pill', onIntent() {}, onOpenInside() {}, onShare() {} });

test('a project page: its colour band, Try it where the app has a view for visitors, and Join', () => {
  const html = renderComponent(PROJECT, 'GuestProject', projectProps(APPS[0]));
  assert.match(html, /data-guest-project="game-corner"/);
  assert.match(html, /<h1[^>]*>Game Corner<\/h1>/);
  assert.match(html, /<a href="https:\/\/game-corner\.example" data-guest-try="game-corner"/);
  assert.doesNotMatch(html, /data-guest-use=/);
  assert.match(html, /data-guest-join-project=""/);
  const words = text(html);
  assert.ok(words.includes(message('auth:guest.project.audience')));
  assert.ok(words.includes(message('auth:guest.project.builders_other', { count: 3 })));
  assert.ok(words.includes(message('auth:guest.project.active_other', { count: 43 })));
  // The hub starts on what is happening, with the directory's own count of
  // changes up for a vote until the overview arrives.
  assert.ok(words.includes(message('auth:guest.project.votesOpen_other', { count: 7 })));
  // The chat is for members: never a line of it here.
  assert.match(html, /data-guest-members-only=""/);
  assert.ok(words.includes(message('auth:guest.project.chatMembers')));
});

test('an app with no view for visitors yet: Sign in to use it, in Try it\'s place', () => {
  const html = renderComponent(PROJECT, 'GuestProject', projectProps(APPS[1]));
  assert.doesNotMatch(html, /data-guest-try=/);
  assert.match(html, /data-guest-use=""[^>]*>Sign in to use it</);
});

test('the overview it reads carries no names, and the page draws none', () => {
  const src = read(PROJECT);
  assert.match(src, /fetchOverview\(app\.slug\)/);
  assert.doesNotMatch(src, /username|contributors\.map|\.names\b/);
  // The server side of the same promise is pinned in tests/public-api.test.js.
  assert.doesNotMatch(read('src/services/public-project.js'), /username/);
});

// ─── the story's short version ────────────────────────────────────

test('the short story heads Discover: welcome, headline, one line, Continue and the email line', () => {
  const html = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.deepEqual(text(html), [
    'Welcome to Homeroom',
    'On Homeroom, communities make apps together.',
    message('auth:guest.hero.line'),
    message('auth:story.continue'),
    'Sign in',
    'or join with your email.',
  ]);
  assert.match(html, /data-landing-story="" data-landing-story-compact=""/);
  // The declared checks' Continue, with the email line after it and nothing
  // after that (dapp.json, "Landing's one Continue button…").
  assert.match(html, /<a href="#signup" data-landing-story-start="" class="pill">Continue<\/a><p data-landing-story-how=""[^>]*>[\s\S]*<\/p><\/div><\/div><\/div>$/);
  // No examples: the real apps follow it. The picture only from md.
  assert.doesNotMatch(html, /For example/);
  assert.match(html, /class="hidden md:block h-auto w-\[240px\]/);
  // Nothing to fit, so no steps: the layout effect leaves it alone.
  assert.match(read(STORY), /if \(!story \|\| !foot \|\| !story\.offsetHeight\) return;\s+if \(compact\) return;/);
});

test('on iPhone Safari the short story keeps no toolbar room under it', () => {
  const css = read('public/css/app.css');
  assert.match(css, /html\.un-ios\[data-browser-scroller="auth-landing-scroll"\] \[data-landing-story-compact\] \{\s+padding-bottom: 0;\s+\}/);
  assert.ok(css.indexOf('[data-landing-story-compact]') > css.indexOf('html.un-ios[data-browser-scroller="auth-landing-scroll"] [data-landing-story] {'),
    'after the rule it undoes, so it wins');
});

// ─── the landing ──────────────────────────────────────────────────

test('the bar\'s one way in: a quiet Sign in, a button at the row\'s height, never for a signed-in visitor', () => {
  const src = read(LANDING);
  const header = src.slice(src.indexOf('id="landing-header"'), src.indexOf('</header>'));
  const button = header.slice(header.indexOf('data-landing-sign-in'));
  assert.match(button.slice(0, 400), /className=\{hiddenLast\(session \|\| !guestOn, 'absolute right-4 bottom-4 h-7 /);
  assert.match(button.slice(0, 600), /onClick=\{\(\) => setSheet\('signin'\)\}/);
  assert.doesNotMatch(header, /<a[\s>]/, 'still no anchor in the bar');
  // The mark stays on the bar's true centre: the button sits over the
  // trailing box, and the title keeps clear of it on both sides.
  assert.match(header, /id="landing-header-title"\s+className="flex-1 min-w-0 px-10 /);
});

test('a project page\'s sheets are titled for what the visitor tried, and come back to the page', () => {
  const { intentTitle } = loadTsx(LANDING);
  const t = (id, params) => message(id, params);
  const app = APPS[0];
  assert.equal(intentTitle({ kind: 'join', app }, t), 'Sign up to join Game Corner');
  assert.equal(intentTitle({ kind: 'vote', app, change: 'Practice mode' }, t), 'Sign up to vote on this change');
  assert.equal(intentTitle({ kind: 'ask', app }, t), 'Sign up to ask for something');
  assert.equal(intentTitle({ kind: 'chat', app }, t), 'Sign up to chat in Game Corner');
  assert.equal(intentTitle({ kind: 'use', app }, t), 'Sign in to use Game Corner');
  const src = read(LANDING);
  // Remembered for an email sign-in (AuthScreens.finishLogin), and the
  // provider's trip comes back to the same page.
  assert.match(src, /rememberDeepLink as undefined \| \(\(h: string\) => void\)\)\?\.\(projectHash\(i\.app\.slug\)\);/);
  assert.match(src, /returnTo=\{`\/\$\{projectHash\(intent\.app\.slug\)\}`\}/);
});

test('the landing\'s declared checks hold Discover and the bar\'s Sign in, folded into the story\'s own', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const story = manifest.tests.find((t) => t.name === 'Landing tells the story and asks people to get started (first session)');
  assert.ok(story, 'the check keeps its name, so it keeps gating');
  assert.equal(story.path, '/?shot=anon#landing');
  assert.match(story.expectSelector, /#landing-header \[data-landing-sign-in\]:not\(\.hidden\)/);
  assert.match(story.expectSelector, /\[data-guest-discover\] \[data-landing-story\] a\[data-landing-story-start\]\[href="#signup"\]/);
});
