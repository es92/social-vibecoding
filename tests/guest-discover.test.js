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
    member_count: 87, merged_count: 40, latest_change: 'Weekly leaderboard',
    contributors: [{}, {}, {}], guest_ready: true, requires_login: true, url: 'https://game-corner.example',
  },
  {
    slug: 'todo-list', name: 'Todo List', description: 'A shared todo app.', category: 'tools',
    featured: true, featured_order: 1, active_users: 12, open_votes: 0, created_at: '2026-06-10T00:00:00.000Z',
    member_count: 1, merged_count: 3, latest_change: null, last_merged_at: TWO_DAYS_AGO,
    contributors: [{}], guest_ready: false, requires_login: true, url: 'https://todo-list.example',
  },
  {
    slug: 'fresh-one', name: 'Fresh', description: null, category: null,
    featured: false, featured_order: null, active_users: 0, open_votes: 2, created_at: TWO_DAYS_AGO,
    member_count: 0, merged_count: 1, latest_change: 'Add a dark theme',
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

test('Try it where it can open here: the viewer anywhere, the app\'s own address only outside the Homeroom app', () => {
  const { canTryHere } = loadTsx(DATA);
  const noLogin = { requires_login: false, guest_ready: true };
  const guestOnly = { requires_login: true, guest_ready: true };
  const neither = { requires_login: true, guest_ready: false };
  // In a browser: the viewer, or the app's own address (a back comes home).
  assert.equal(canTryHere(noLogin, false), true);
  assert.equal(canTryHere(guestOnly, false), true);
  assert.equal(canTryHere(neither, false), false);
  // Inside the app the web view has no back, so only the viewer.
  assert.equal(canTryHere(noLogin, true), true);
  assert.equal(canTryHere(guestOnly, true), false);
  assert.equal(canTryHere(neither, true), false);
  // Featured and the project page both ask it, with this page's answer.
  assert.match(read(DISCOVER), /\{canTryHere\(app, inHomeroomApp\(\)\) \? \(\s+<TryLink/);
  assert.match(read(PROJECT), /\{canTryHere\(app, inHomeroomApp\(\)\) \? \(\s+<TryLink/);
  const { inHomeroomApp } = loadTsx(DATA);
  assert.equal(inHomeroomApp(), false, 'a server render is never the app');
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
  // Under a card's name: what it is (its words, else its latest change), its
  // members beside the figure the list is sorted by, then what is up for a
  // vote or when it last changed. A zero says nothing; a project made lately
  // wears New.
  const words = text(html);
  const pair = (first, second) => message('auth:guest.card.pair', { first, second });
  assert.ok(words.includes('Classic games, fresh every day.'));
  assert.ok(words.includes(message('auth:guest.card.latest', { title: 'Add a dark theme' })));
  assert.ok(words.includes(pair(message('auth:guest.card.members_other', { count: 87 }), message('auth:guest.card.active_other', { count: 43 }))));
  assert.ok(words.includes(pair(message('auth:guest.card.members_one', { count: 1 }), message('auth:guest.card.active_other', { count: 12 }))));
  assert.ok(words.includes(message('auth:guest.card.votes_other', { count: 7 })));
  assert.ok(words.includes(message('auth:guest.card.votes_other', { count: 2 })));
  assert.match(html, /data-guest-card-votes=""[^>]*text-violet-700/, 'what is up for a vote is in the accent');
  assert.ok(words.some((w) => w.startsWith('Updated ')), 'no vote open: when it last changed');
  assert.ok(!words.some((w) => /^0 /.test(w)), 'no zero is printed');
  assert.ok(words.includes(message('auth:guest.card.new')));
});

test('a card shows the figure its list is sorted by', () => {
  const src = read(DISCOVER);
  assert.match(src, /sort === 'new'\s+\? \(app\.created_at \? t\('auth:guest\.card\.made'/);
  assert.match(src, /sort === 'built'\s+\? \(builders > 0 \? t\('auth:guest\.card\.builders'/);
  assert.match(src, /<CardGrid apps=\{first\} sort=\{sort\} eagerFirst \/>/);
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
  // The card's way in opens the story's sheet, the one form for new and
  // returning people (#5251), and says what it is for.
  assert.match(html, /data-guest-join-continue=""[^>]*>Sign up</);
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

test('the short story heads Discover: welcome, headline and one line, with nothing to press', () => {
  const html = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.deepEqual(text(html), [
    'Welcome to Homeroom',
    'On Homeroom, communities make apps together.',
    message('auth:guest.hero.line'),
  ]);
  assert.match(html, /data-landing-story="" data-landing-story-compact=""/);
  // One Sign in on the page, the bar's: no Continue and no Sign in line of
  // its own under the short story.
  assert.doesNotMatch(html, /data-landing-story-start|data-landing-story-how|data-landing-story-signin/);
  // On the page itself, no card, and short: the words, then a small picture
  // beside them from md only.
  assert.doesNotMatch(html, /rounded-\[20px\]|bg-white/);
  assert.match(html, /class="hidden md:block h-auto w-\[200px\] shrink-0"/);
  assert.ok(html.indexOf('<h1') < html.lastIndexOf('/brand/people.png'), 'the words first, the picture after');
  // Nothing to press in it: the bar's Sign in and Sign up are the ways in,
  // once each on the screen.
  assert.doesNotMatch(html, /<button|<a\s/);
  assert.doesNotMatch(read(LANDING), /data-landing-story-sign-up/);
  // The line invites a look; it does not promise that nothing needs an
  // account, since a lot of the apps do.
  assert.equal(message('auth:guest.hero.line'), "Look around and try what we're making.");
  // No examples: the real apps follow it.
  assert.doesNotMatch(html, /For example/);
  // Nothing to fit, so no steps: the layout effect leaves it alone.
  assert.match(read(STORY), /if \(!story \|\| !foot \|\| !story\.offsetHeight\) return;\s+if \(compact\) return;/);
});

test('inside the Homeroom app the full story stays the front door, with Look around first to Discover', () => {
  const src = read(LANDING);
  // Read after mount from the head's class, so the first render is the
  // prerender's (browsers: Discover).
  assert.match(src, /setInApp\(document\.documentElement\.classList\.contains\('in-native-webview'\)\);/);
  assert.match(src, /const storyFront = guestOn && inApp && !linkedSlug && !discoverLink && !gate;/);
  assert.match(src, /const guestPages = guestOn && !storyFront;/);
  assert.match(src, /\{storyFront \? \(\s+<Story [^>]*onStart=\{\(\) => setSheet\('start'\)\} onSignIn=\{\(\) => setSheet\('signin'\)\} lookAroundClass=\{SECONDARY_PILL\} \/>/);
  // Discover opened from it has a back, and the back returns to the story.
  assert.match(src, /const appDiscover = guestOn && inApp && discoverLink;/);
  assert.match(src, /const showBack = !!openApp \|\| !!guestProject \|\| appDiscover;/);
  assert.match(src, /location\.hash = appDiscover && !guestProject \? '#landing' : '#apps';/);
  // The full story keeps Continue and its email line, then the way to look
  // around: a link to #apps.
  const html = renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {}, lookAroundClass: 'white-pill' });
  assert.match(html, /data-landing-story-start/);
  const look = html.match(/<a href="#apps" data-landing-story-look="" class="white-pill">([^<]+)<\/a>/);
  assert.ok(look, 'Look around first links to Discover');
  assert.equal(look[1], message('auth:story.lookAround'));
  assert.ok(html.indexOf('data-landing-story-start') < html.indexOf('data-landing-story-look'), 'under Continue');
  // Without the prop (the browsers' short story, the first session) it is absent.
  assert.doesNotMatch(renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} }), /data-landing-story-look/);
});

const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';

test('the ways in are the sheet\'s: Apple, Google and email, and a phone number on the landing\'s sheets', () => {
  const sheet = read(SHEET);
  // A phone where it is offered but not first: the link under the email.
  assert.match(sheet, /\{phone \|\| phoneLink \? \(/);
  assert.match(sheet, /\{phone \? t\('auth:signInSheet\.toPhone'\) : t\('auth:signInSheet\.toPhoneLink'\)\}/);
  const landing = read(LANDING);
  // The story's sheet (Sign up, Sign in), a project page's and a shared
  // link's: each offers it, and asks for a username after the code.
  assert.equal((landing.match(/phoneLink=\{phoneSignIn\}\s+askName=\{false\}/g) || []).length, 3);
  // And the page no longer draws the four buttons itself.
  assert.doesNotMatch(landing, /SignUpButtons|signUpWith/);
});

test('on iPhone Safari the short story keeps no toolbar room under it', () => {
  const css = read('public/css/app.css');
  assert.match(css, /html\.un-ios\[data-browser-scroller="auth-landing-scroll"\] \[data-landing-story-compact\] \{\s+padding-bottom: 0;\s+\}/);
  assert.ok(css.indexOf('[data-landing-story-compact]') > css.indexOf('html.un-ios[data-browser-scroller="auth-landing-scroll"] [data-landing-story] {'),
    'after the rule it undoes, so it wins');
});

// ─── the landing ──────────────────────────────────────────────────

test('the guest bar: the wordmark at the column\'s left, Sign in and Sign up at its right, never for a signed-in visitor', () => {
  const src = read(LANDING);
  const header = src.slice(src.indexOf('id="landing-header"'), src.indexOf('</header>'));
  // Discover's own bar (guestTop), and a project's page or an open app keep
  // the centred title with the back.
  assert.match(src, /const guestTop = guestPages && !showBack && !gate;/);
  assert.match(header, /data-guest-top=\{guestTop \? '' : undefined\}/);
  // Its edges are the column's (max-w-6xl, px-4 blocks), with a hairline under it.
  assert.match(src, /const GUEST_BAR = 'md:px-\[max\(1rem,calc\(\(100%_-_72rem\)\/2_\+_1rem\)\)\] shadow-\[inset_0_-1px_0_var\(--app-sheet-line\)\] \[&\[data-guest-top\]>div:first-child\]:\[display:none\]';/);
  // The lead and trailing boxes give way on Discover, so the wordmark sits
  // on the left edge; the title reads from the left there.
  assert.match(header, /<div className="w-7 h-7 shrink-0 flex items-center justify-center">/);
  assert.match(header, /\[\[data-guest-top\]_&\]:px-0 \[\[data-guest-top\]_&\]:text-left/);
  assert.match(header, /<div className="w-7 shrink-0 \[\[data-guest-top\]_&\]:hidden" aria-hidden="true" \/>/);
  // Sign in and Sign up, both at the row's 28px with no padding of their own.
  const actions = header.slice(header.indexOf('data-landing-actions'));
  assert.match(actions.slice(0, 300), /hiddenLast\(session \|\| !guestPages, guestTop \? 'flex shrink-0 items-center gap-1\.5' : `absolute bottom-4 right-4 /);
  assert.match(actions, /data-landing-sign-in=""\s+className=\{hiddenLast\(session \|\| !guestPages, 'h-7 rounded-full px-2 /);
  assert.match(actions, /onClick=\{\(\) => setSheet\('signin'\)\}/);
  assert.match(actions, /<Button\s+type="button"\s+variant="pillAccent"\s+size="none"\s+ink="solid"\s+data-landing-sign-up=""/);
  assert.match(actions, /data-landing-sign-up=""\s+className=[^\n]+\s+onClick=\{\(\) => setSheet\('start'\)\}/);
  assert.doesNotMatch(header, /<a[\s>]/, 'still no anchor in the bar');
  // A project's page keeps its title centred and clear of the buttons.
  assert.match(header, /id="landing-header-title"\s+className="flex-1 min-w-0 px-10 /);
  // The project page uses the same column, so one alignment fits both.
  assert.doesNotMatch(read(PROJECT), /max-w-\[1040px\]/);
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
  assert.match(story.expectSelector, /\[data-guest-discover\] \[data-landing-story\] h1$/);
  // And one Sign in and one Sign up, both the bar's: nothing to press in the
  // short story.
  const one = manifest.tests.find((t) => /^Landing has one Sign in and one Sign up, both in its bar/.test(t.name));
  assert.ok(one);
  assert.match(one.expectSelector, /:has\(#landing-header button\[data-landing-sign-up\]\):not\(:has\(\[data-landing-story\] button, \[data-landing-story\] a\)\) #landing-header \[data-landing-sign-in\]:not\(\.hidden\)$/);
});
