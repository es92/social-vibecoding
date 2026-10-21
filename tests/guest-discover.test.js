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
    featured: false, featured_order: null, active_users: 1, open_votes: 2, created_at: TWO_DAYS_AGO,
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
  // What a visitor can try comes first under every sort, each group in the
  // sort's own order.
  const tryable = (a) => a.slug !== 'game-corner';
  assert.deepEqual(sortApps(APPS, 'trending', tryable).map((a) => a.slug), ['todo-list', 'fresh-one', 'game-corner']);
  assert.deepEqual(sortApps(APPS, 'new', tryable).map((a) => a.slug), ['fresh-one', 'todo-list', 'game-corner']);
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
  // Discover asks it for every card, with this page's answer (a signed-in
  // waitlisted account can open every project); the project page too.
  assert.match(read(DISCOVER), /const tryable = useCallback\(\(app: GuestApp\) => signedIn \|\| canTryHere\(app, inApp\), \[signedIn, inApp\]\);/);
  assert.match(read(PROJECT), /\{signedIn \|\| canTryHere\(app, inHomeroomApp\(\)\) \? \(\s+<TryLink\s+app=\{app\}\s+inside=\{signedIn\}/);
  const { inHomeroomApp } = loadTsx(DATA);
  assert.equal(inHomeroomApp(), false, 'a server render is never the app');
});

test('Featured is what an admin featured that a visitor can try, filled to three; a project page lives at its hub', () => {
  const { featuredApps, projectHash, projectVotesHash, linksToWorkshop, canTryHere, FEATURED_MIN } = loadTsx(DATA);
  const here = (a) => canTryHere(a, false);
  assert.equal(FEATURED_MIN, 3);
  // Todo List is featured first, but a visitor cannot open it: left out,
  // and the most active project they can try fills the row.
  assert.deepEqual(featuredApps(APPS, here).map((a) => a.slug), ['game-corner', 'fresh-one']);
  assert.deepEqual(featuredApps(APPS).map((a) => a.slug), ['todo-list', 'game-corner', 'fresh-one']);
  assert.deepEqual(featuredApps(APPS, () => false), [], 'nothing to try, no Featured');
  // Nobody active in it: never the fill.
  assert.deepEqual(featuredApps(APPS.map((a) => (a.slug === 'fresh-one' ? { ...a, active_users: 0 } : a)), here).map((a) => a.slug), ['game-corner']);
  assert.equal(projectHash('game-corner'), '#app/game-corner/workshop');
  // A card's votes line opens the page at its Workshop, a signed-in
  // person's own address for it too.
  assert.equal(projectVotesHash('game-corner'), '#app/game-corner/workshop?ws=workshop');
  assert.equal(linksToWorkshop('#app/game-corner/workshop?ws=workshop'), true);
  assert.equal(linksToWorkshop('/app/game-corner/workshop'), false);
});

// ─── guest-discover.tsx ───────────────────────────────────────────

const discoverProps = (over = {}) => ({
  apps: APPS, failed: false, hero: null, primaryClass: 'pill', waitlist: true,
  onContinue() {}, onOpenInside() {}, ...over,
});

test('every card opens its project\'s page, no card is locked, and Featured is not repeated below it', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.deepEqual([...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), ['game-corner', 'fresh-one']);
  assert.deepEqual([...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]), ['todo-list']);
  // The picture and the name each open the page; nothing is nested in a link.
  assert.match(html, /<article data-guest-card="todo-list"[^>]*><a href="#app\/todo-list\/workshop" tabindex="-1" aria-hidden="true"/);
  assert.match(html, /<a href="#app\/todo-list\/workshop" data-guest-card-link=""/);
  assert.doesNotMatch(html, /<a [^>]*>(?:(?!<\/a>).)*<a /, 'no link inside a link');
  assert.doesNotMatch(html, /Account required|grayscale|data-icon="lock"/);
  const words = text(html);
  assert.ok(words.includes('Classic games, fresh every day.'));
  assert.ok(words.includes(message('auth:guest.card.latest', { title: 'Add a dark theme' })));
  assert.ok(!words.some((w) => /^0 /.test(w)), 'no zero is printed');
});

// What a card says, by its numbers (the 21 Oct 2026 review: the median
// public app has one person active, and a small count reads as dead).
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const FACT_APPS = [
  { slug: 'busy', name: 'Busy', member_count: 87, active_users: 43, open_votes: 3, last_merged_at: ago(1), merged_week: 6 },
  { slug: 'week', name: 'Week', member_count: 11, active_users: 3, open_votes: 0, last_merged_at: ago(1), merged_week: 4 },
  { slug: 'month', name: 'Month', member_count: 15, active_users: 8, open_votes: 0, last_merged_at: ago(8), merged_week: 0 },
  { slug: 'quiet', name: 'Quiet', member_count: 3, active_users: 1, open_votes: 0, last_merged_at: ago(60), merged_week: 0 },
].map((a) => ({ ...a, created_at: ago(200), requires_login: true, guest_ready: false, url: `https://${a.slug}.example`, contributors: [{}] }));

function cardOf(html, slug) {
  const at = html.indexOf(`<article data-guest-card="${slug}"`);
  assert.ok(at >= 0, slug);
  return html.slice(at, html.indexOf('</article>', at));
}

test('a count shows only from 25 members or 10 people active; under that, a card says what changed lately', () => {
  const { MIN_MEMBERS, MIN_ACTIVE, MIN_BUILDERS } = loadTsx(DATA);
  assert.deepEqual([MIN_MEMBERS, MIN_ACTIVE, MIN_BUILDERS], [25, 10, 5]);
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: FACT_APPS }));
  const pair = (first, second) => message('auth:guest.card.pair', { first, second });
  // Big enough: the counts, and what is up for a vote, which opens the page at its votes.
  const busy = text(cardOf(html, 'busy'));
  assert.ok(busy.includes(pair(message('auth:guest.card.members_other', { count: 87 }), message('auth:guest.card.active_other', { count: 43 }))));
  assert.ok(busy.includes(message('auth:guest.card.votes_other', { count: 3 })));
  assert.match(cardOf(html, 'busy'), /<a href="#app\/busy\/workshop\?ws=workshop" data-guest-card-votes=""[^>]*text-violet-700/);
  // Too small: what changed this week, else when it last changed, else nothing.
  // (Each card's text starts with its letter tile and its name.)
  const week = text(cardOf(html, 'week'));
  assert.deepEqual(week.slice(1), ['Week', message('auth:guest.card.week_other', { count: 4 })]);
  const month = text(cardOf(html, 'month'));
  assert.equal(month.length, 3);
  assert.match(month[2], /^Updated /);
  assert.deepEqual(text(cardOf(html, 'quiet')).slice(1), ['Quiet']);
  for (const card of [week, month]) assert.ok(!card.some((w) => /member|people active/.test(w)), 'no small count');
  assert.match(cardOf(html, 'week'), /data-guest-card-activity=""/);
});

test('a card shows the figure its list is sorted by', () => {
  const src = read(DISCOVER);
  assert.match(src, /sort === 'new'\s+\? \(app\.created_at \? t\('auth:guest\.card\.made'/);
  assert.match(src, /sort === 'built'\s+\? \(builders >= MIN_BUILDERS \? t\('auth:guest\.card\.builders'/);
  assert.match(src, /<CardGrid apps=\{top\} sort=\{sort\} tryable=\{tryable\} inside=\{signedIn\} onOpenInside=\{onOpenInside\} \/>/);
});

test('Featured holds what a visitor can try, each with Try it, and so does every card that can', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.match(html, /<a href="https:\/\/game-corner\.example" data-guest-try="game-corner"/);
  assert.match(html, /<a href="https:\/\/fresh-one\.example" data-guest-try="fresh-one"/);
  assert.doesNotMatch(html, /data-guest-try="todo-list"/, 'nothing a visitor can open');
  // A waitlisted account is signed in: every project opens for it, nothing asks it to sign up.
  const signedIn = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ signedIn: true }));
  assert.deepEqual([...signedIn.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), ['todo-list', 'game-corner', 'fresh-one']);
  assert.doesNotMatch(signedIn, /data-guest-join=/);
});

// Twenty projects, the even ones (a01, a03, …) open for a visitor.
const MANY = Array.from({ length: 20 }, (_, i) => ({
  slug: `a${String(i + 1).padStart(2, '0')}`, name: `App ${i + 1}`, active_users: 20 - i, member_count: 0,
  created_at: ago(200), requires_login: i % 2 !== 0, guest_ready: false, url: `https://a${i + 1}.example`, contributors: [],
}));

test('the top is curated: four big cards on a phone, tryable first, then More projects twelve rows at a time', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: MANY }));
  assert.deepEqual([...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), ['a01', 'a03', 'a05']);
  assert.deepEqual([...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]), ['a07', 'a09', 'a11', 'a13']);
  const rows = [...html.matchAll(/data-guest-row="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.slice(0, 4), ['a15', 'a17', 'a19', 'a02'], 'the rest that can be tried, then the others');
  assert.match(html, /data-guest-show-more=""/);
  assert.ok(text(html).includes(message('auth:guest.more')));
  // A row Try it where the visitor can, else a way to its page.
  const row = (slug) => html.slice(html.indexOf(`data-guest-row="${slug}"`), html.indexOf('data-guest-row=', html.indexOf(`data-guest-row="${slug}"`) + 5));
  assert.match(row('a15'), /data-guest-try="a15"/);
  assert.doesNotMatch(row('a02'), /data-guest-try=/);
  const src = read(DISCOVER);
  assert.match(src, /const TOP_CARDS = 4;\nconst TOP_CARDS_WIDE = 8;/);
  assert.match(src, /const ROWS_STEP = 12;/);
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

test('a project page\'s band shows counts from the cards\' minimums, and a votes link opens it on the Workshop', () => {
  const small = FACT_APPS[1];
  const html = renderComponent(PROJECT, 'GuestProject', projectProps(small));
  const band = text(html.slice(html.indexOf('data-guest-project-band'), html.indexOf('role="tablist"')));
  assert.ok(band.includes(message('auth:guest.card.week_other', { count: 4 })), 'what changed this week');
  assert.ok(!band.includes(message('auth:guest.project.builders_one', { count: 1 })), 'not "Built by 1 person"');
  assert.ok(!band.some((w) => /used it lately/.test(w)), 'not 3 people active');
  // A card's votes line asks for the Workshop (?ws=workshop): the page opens there.
  const workshop = renderComponent(PROJECT, 'GuestProject', { ...projectProps(APPS[0]), startOnWorkshop: true });
  assert.match(workshop, /aria-selected="true" data-guest-tab="workshop"/);
  assert.match(read(LANDING), /startOnWorkshop=\{!!deepLink && linksToWorkshop\(deepLink\.target\)\}/);
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
  // Only somebody signed out gets the story; a waitlisted account starts on Discover.
  assert.match(src, /const storyFront = storyOn && inApp && !linkedSlug && !discoverLink && !gate;/);
  assert.match(src, /const guestPages = guestOn && !storyFront;/);
  assert.match(src, /\{storyFront \? \(\s+<Story [^>]*onStart=\{\(\) => setSheet\('start'\)\} onSignIn=\{\(\) => setSheet\('signin'\)\} lookAround \/>/);
  // Discover opened from it has a back, and the back returns to the story.
  assert.match(src, /const appDiscover = storyOn && inApp && discoverLink;/);
  assert.match(src, /const showBack = !!openApp \|\| !!guestProject \|\| appDiscover;/);
  assert.match(src, /location\.hash = appDiscover && !guestProject \? '#landing' : '#apps';/);
  // The full story keeps Continue and its email line, then the way to look
  // around: a link to #apps.
  const html = renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {}, lookAround: true });
  assert.match(html, /data-landing-story-start/);
  // A link on its own line in the Sign in line's blue, not a second button.
  const look = html.match(/<p class="text-\[15px\] leading-5"><a href="#apps" data-landing-story-look="" class="([^"]+)">([^<]+)<\/a><\/p>/);
  assert.ok(look, 'Look around first links to Discover');
  assert.equal(look[2], message('auth:story.lookAround'));
  const signIn = html.match(/data-landing-story-signin="" class="([^"]+)"/);
  assert.ok(signIn);
  assert.equal(look[1], signIn[1], 'the same look as Sign in');
  assert.ok(html.indexOf('data-landing-story-how') < html.indexOf('data-landing-story-look'), 'under the Sign in line');
  // Without the prop (the browsers' short story, the first session) it is absent.
  assert.doesNotMatch(renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} }), /data-landing-story-look/);
});

test('an account on the waitlist looks around: its card over Discover, every public app, and voting and joining later', () => {
  // Routed to the guest pages, not the waiting room, for Discover and a project's page.
  const app = read('public/js/app.js');
  assert.match(app, /if \(!authRoute && \/\^\(\?:apps\|discover\|app\\\/\[\^\/\]\+\)\(\?:\\\/\|\$\)\/\.test\(hash\)\) \{\s+AuthScreens\.showGuestPagesFor\(App\._deepLinkTarget\(\)\);/);
  assert.ok(app.indexOf('AuthScreens.showGuestPagesFor(') < app.indexOf("if (!authRoute && hash) AuthScreens.rememberDeepLink(App._deepLinkTarget());"),
    'before the waiting room takes the link');
  assert.match(read('public/js/auth-screens.js'), /showGuestPagesFor\(fullHash\) \{\s+AuthScreens\.rememberDeepLink\(fullHash\);\s+AuthScreens\._deepLinkSignIn = fullHash \|\| '';\s+AuthScreens\.show\('landing'\);/);
  const landing = read(LANDING);
  assert.match(landing, /hero=\{waitingGuest \? \(\s+<WaitlistCard email=\{sessionEmail\(\)\} \/>/);
  assert.match(landing, /signedIn=\{waitingGuest\}/);
  // The card: where it stands, and the way back to the waiting room.
  const card = renderComponent('frontend/src/features/guest/waitlist-card.tsx', 'WaitlistCard', { email: 'ada@example.com' });
  assert.deepEqual(text(card), [
    message('auth:waiting.title'),
    message('auth:guest.waitlist.leadEmail', { email: 'ada@example.com' }),
    message('auth:landing.backToWaiting'),
  ]);
  assert.match(card, /<a href="#waiting" data-guest-waitlist-room=""/);
  // A project's page: Try it opens any public app here, signed in; no Join,
  // no Ask, and a vote waits.
  const html = renderComponent(PROJECT, 'GuestProject', { ...projectProps(APPS[1]), signedIn: true });
  assert.match(html, /data-guest-try="todo-list"/, 'even an app that needs an account');
  assert.doesNotMatch(html, /data-guest-use=|data-guest-join-project=|data-guest-chat-join=/);
  assert.ok(text(html).includes(message('auth:guest.project.joinLater')));
  const vote = renderComponent(PROJECT, 'VoteCard', { vote: { id: 1, title: 'A', summary: null, yes: 1, no: 0 }, app: APPS[1], onIntent() {}, signedIn: true });
  assert.match(vote, /data-guest-vote-later=""/);
  assert.doesNotMatch(vote, /data-guest-vote-btn/);
  // The waiting room leads there.
  assert.match(read('frontend/src/features/auth/waiting.tsx'), /<a\s+href="#apps"\s+data-waiting-look-around=""/);
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
