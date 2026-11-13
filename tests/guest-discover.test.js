'use strict';
// The guest Discover and a public project's guest page (frontend/src/features/
// guest): what a visitor with no account sees on the landing
// (frontend/src/features/auth/landing.tsx).
//
//   - the pure sorting, filtering and featuring Discover does (guest-data.ts);
//   - Discover rendered: one card for every project, each one link to the
//     project's own page, no card locked and no button on a card; Featured
//     and All apps the same grid; the card's picture growing into the page
//     as it opens (card-morph.ts);
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
const JOIN = 'frontend/src/features/home/communities-to-join.tsx';
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
  // Popular is people active and nothing else: a project a visitor can try
  // does not jump a busier one it cannot (Evan, 21 Oct 2026).
  assert.equal(sortApps.length, 2, 'no tryable-first argument');
  const tryableTest = { slug: 'echo-diagnostic', active_users: 0, requires_login: false, guest_ready: true };
  assert.deepEqual(sortApps([tryableTest, ...APPS], 'trending').map((a) => a.slug), ['game-corner', 'todo-list', 'fresh-one', 'echo-diagnostic']);
});

test('search reads the name and the description; a kind narrows to its apps', () => {
  const { filterApps } = loadTsx(DATA);
  assert.deepEqual(filterApps(APPS, 'shared todo', null).map((a) => a.slug), ['todo-list']);
  // Case and spaces aside, a word in the name or the description finds it,
  // and the project NAMED what was typed leads (#5891).
  assert.deepEqual(filterApps(APPS, '  FRESH ', null).map((a) => a.slug), ['fresh-one', 'game-corner']);
  assert.deepEqual(filterApps(APPS, 'fres', null).map((a) => a.slug), ['game-corner', 'fresh-one'],
    'no exact name: the directory order');
  assert.deepEqual(filterApps(APPS, '', 'games').map((a) => a.slug), ['game-corner']);
  assert.deepEqual(filterApps(APPS, 'todo', 'games'), []);
});

test('the kinds are the ones the directory has, in the manifest\'s order, and nothing for Other alone', () => {
  const { presentCategories, CATEGORIES } = loadTsx(DATA);
  assert.deepEqual([...CATEGORIES], [
    'games', 'social', 'tools', 'learning', 'creative', 'money', 'health', 'food', 'other',
  ]);
  assert.deepEqual(presentCategories(APPS), ['games', 'tools']);
  assert.deepEqual(
    presentCategories([
      { category: 'food' }, { category: 'games' }, { category: 'money' }, { category: 'other' },
    ]),
    ['games', 'money', 'food', 'other'],
    'a chip for every kind with a project, in the platform\'s order'
  );
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
  // A signed-in waitlisted account can open every project here, inside the
  // viewer (the pinned-app tiles); the project page asks the same question.
  assert.match(read(DISCOVER), /<TryLink app=\{app\} className="flex min-w-0 flex-col items-center gap-1\.5 no-underline" onOpenInside=\{open\} inside=\{signedIn\}>/);
  assert.match(read(PROJECT), /const canTry = signedIn \|\| canTryHere\(app, inHomeroomApp\(\)\);/);
  assert.match(read(PROJECT), /\{canTry \? \(\s+<TryLink app=\{app\} inside=\{signedIn \|\| preview\} onOpenInside=\{onOpenInside\} className=\{CARD_OPEN_BTN\}>/);
  const { inHomeroomApp } = loadTsx(DATA);
  assert.equal(inHomeroomApp(), false, 'a server render is never the app');
});

test('Featured is what an admin featured that a visitor can try, and nothing else; a project page lives at its hub', () => {
  const data = loadTsx(DATA);
  const { featuredApps, projectHash, projectVotesHash, linksToWorkshop, canTryHere } = data;
  const here = (a) => canTryHere(a, false);
  // Todo List is featured first, but a visitor cannot open it: left out.
  // Fresh can be tried but nobody featured it: never filled in (on
  // production the fill was a test app and a one-player demo).
  assert.deepEqual(featuredApps(APPS, here).map((a) => a.slug), ['game-corner']);
  assert.deepEqual(featuredApps(APPS).map((a) => a.slug), ['todo-list', 'game-corner']);
  assert.deepEqual(featuredApps(APPS, () => false), [], 'nothing to try, no Featured');
  assert.deepEqual(featuredApps(APPS.map((a) => ({ ...a, featured: false })), here), [], 'nothing featured, no Featured');
  assert.equal(data.FEATURED_MIN, undefined, 'no minimum to fill to');
  assert.equal(projectHash('game-corner'), '#app/game-corner/dev/hub', 'the Hub\'s own address: a bare /workshop opens the Workshop');
  assert.equal(data.projectPath('game-corner'), '/app/game-corner');
  // A card's votes line opens the page at its Workshop, a signed-in
  // person's own address for it too.
  assert.equal(projectVotesHash('game-corner'), '#app/game-corner/workshop?ws=workshop');
  assert.equal(linksToWorkshop('#app/game-corner/workshop?ws=workshop'), true);
  assert.equal(linksToWorkshop('/app/game-corner/workshop'), false);
});

// ─── guest-discover.tsx ───────────────────────────────────────────

const discoverProps = (over = {}) => ({
  apps: APPS, failed: false, hero: null, primaryClass: 'pill', onOpenInside() {}, ...over,
});

test('every card opens its project\'s page, no card is locked, and each project is one card in its grid: featured first, then the most active (One Home, #6361)', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  // The signed-out Home's Communities: Featured first, what an admin
  // featured in its order, in the same wrapping grid as the rest (#6434);
  // then the rest by people active, under its own heading, with the
  // featured ones left out so each community shows once (#6584, #6597).
  assert.deepEqual([...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), ['todo-list', 'game-corner']);
  assert.deepEqual([...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]), ['fresh-one']);
  assert.ok(html.indexOf('data-home-join-featured=""') < html.indexOf('<article data-guest-card="'), 'the strip leads');
  // ONE link per card, its name, at the page's clean address a search
  // engine can follow; it stretches over the whole card, so the picture and
  // the gaps open it too, and nothing is nested in a link.
  for (const slug of ['todo-list', 'fresh-one', 'game-corner']) {
    const card = cardOf(html, slug);
    assert.equal((card.match(/<a /g) || []).length, 1, `${slug}: one link`);
    assert.match(card, new RegExp(`<a href="/app/${slug}" data-guest-card-link=""`));
    assert.match(card, /after:absolute after:inset-0 after:z-\[1\] after:rounded-\[20px\] after:content-\[(?:''|&#x27;&#x27;)\]/);
  }
  assert.doesNotMatch(html, /href="#app\//, 'no card links by fragment');
  // A plain click on Discover stays in the page, at the fragment signing in
  // returns to, the card's picture growing into the page; a new tab, or an
  // address that is already a path, is the browser's.
  const src = read(DISCOVER);
  assert.match(src, /if \(e\.defaultPrevented \|\| e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;\s+if \(location\.pathname !== '\/'\) return;\s+e\.preventDefault\(\);\s+(?:\/\/[^\n]*\n\s+)*morph\(cardCover\(slug\), \(\) => \{ location\.hash = projectHash\(slug\); \}, \(\) => projectHero\(slug\)\);/);
  assert.match(src, /return <a href=\{projectPath\(slug\)\} onClick=\{onClick\} \{\.\.\.rest\}>\{children\}<\/a>;/);
  assert.doesNotMatch(html, /<a [^>]*>(?:(?!<\/a>).)*<a /, 'no link inside a link');
  assert.doesNotMatch(html, /Account required|grayscale|data-icon="lock"/);
  const words = text(html);
  assert.ok(words.includes('Classic games, fresh every day.'));
  assert.ok(!words.some((w) => /^Latest change/.test(w)), 'what changed lately is the project page\'s');
  assert.ok(!words.some((w) => /^0 /.test(w)), 'no zero is printed');
  // What a card says about itself stops at two lines: a display utility
  // beside line-clamp-2 undoes the clamp (#5851).
  const about = html.match(/data-guest-card-about="" class="([^"]+)"/);
  assert.ok(about, 'a card shows what it is');
  assert.ok(about[1].split(' ').includes('line-clamp-2'));
  assert.ok(!about[1].split(' ').some((c) => /^(block|inline|inline-block|flex|grid)$/.test(c)), about[1]);
});

// What a card says, by its numbers (the 21 Oct 2026 review: the median
// public app has one person active, and a small count reads as dead).
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const FACT_APPS = [
  { slug: 'busy', name: 'Busy', member_count: 87, active_users: 43, open_votes: 3, last_merged_at: ago(1), merged_week: 6, latest_change: 'A leaderboard' },
  { slug: 'some', name: 'Some', member_count: 11, active_users: 5, open_votes: 0, last_merged_at: ago(1), merged_week: 4 },
  { slug: 'quiet', name: 'Quiet', member_count: 3, active_users: 4, open_votes: 0, last_merged_at: ago(60), merged_week: 0 },
].map((a) => ({ ...a, created_at: ago(200), requires_login: true, guest_ready: false, url: `https://${a.slug}.example`, contributors: [{}] }));

function cardOf(html, slug) {
  const at = html.search(new RegExp(`<article data-guest-(?:card|featured)="${slug}"`));
  assert.ok(at >= 0, slug);
  return html.slice(at, html.indexOf('</article>', at));
}

test('a card is its picture, its name and its own sentence; how many used it lately is a pill from five, in words for a screen reader', () => {
  const { MIN_MEMBERS, MIN_ACTIVE, MIN_BUILDERS, MIN_PEOPLE } = loadTsx(DATA);
  assert.deepEqual([MIN_MEMBERS, MIN_ACTIVE, MIN_BUILDERS, MIN_PEOPLE], [25, 10, 5, 5]);
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: FACT_APPS }));
  // From five: a profile glyph and the number on the picture, hidden from a
  // screen reader, which hears it in words with the name.
  const busy = cardOf(html, 'busy');
  assert.match(busy, /<span data-guest-card-people="" aria-hidden="true"[^>]*><svg[^>]*>.*?<\/svg>43<\/span>/);
  assert.match(busy, new RegExp(`data-guest-card-link="" aria-label="${message('auth:guest.card.peopleLabel', { name: 'Busy', count: 43 })}"`));
  assert.match(cardOf(html, 'some'), /data-guest-card-people=""[^>]*>.*?5<\/span>/);
  // Under it, nothing: no pill and the link is the name alone.
  const quiet = cardOf(html, 'quiet');
  assert.doesNotMatch(quiet, /data-guest-card-people/);
  assert.doesNotMatch(quiet, /data-guest-card-link="" aria-label=/, 'the link is the name alone');
  // Members, votes and what changed lately are the project page's, not a card's.
  for (const slug of ['busy', 'some', 'quiet']) {
    const words = text(cardOf(html, slug));
    assert.ok(!words.some((w) => /member|people active|up for a vote|voted in|Updated|Latest change/.test(w)), `${slug}: ${words}`);
    assert.doesNotMatch(cardOf(html, slug), /data-guest-card-(?:fact|activity|votes)=/);
  }
  assert.deepEqual(text(quiet).slice(1), ['Quiet'],
    'the letter tile, then the name: a visitor\'s card carries no Pin or Join (#6433)');
});

test('the cards are one grid that reflows, two columns at least, and the cards look worth tapping', () => {
  const src = read(DISCOVER);
  assert.match(src, /export const CARD_GRID = 'grid grid-cols-\[repeat\(auto-fill,minmax\(min\(190px,calc\(50%_-_6px\)\),1fr\)\)\] gap-3';/);
  // One Home (#6361): Home's Communities to join draws them, signed in or out.
  assert.match(read(JOIN), /<div className=\{`\$\{CARD_GRID\} px-1`\}>\s*\{list\.slice\(0, shown\)\.map\(\(app, i\) => \(\s*<Card/);
  assert.doesNotMatch(src, /snap-x|overflow-x-auto/, 'nothing scrolls sideways');
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  const card = cardOf(html, 'todo-list');
  const cls = card.match(/^<article[^>]* class="([^"]+)"/)[1].split(' ');
  // Raised at rest, rising under a pointer (hoverOnlyWhenSupported: not on a
  // touch screen), giving under a press, ringed for the keyboard, still for
  // anyone who asks for less motion.
  for (const c of ['group', 'rounded-[20px]', 'hover:-translate-y-1', 'active:scale-[0.97]', 'has-[a:focus-visible]:outline', 'motion-reduce:hover:translate-y-0', 'motion-reduce:active:scale-100']) {
    assert.ok(cls.includes(c), c);
  }
  assert.ok(cls.some((c) => c.startsWith('shadow-[inset_0_0_0_1px_var(--app-sheet-line),')), 'a shadow under the hairline');
  // An icon cover: lit from the top left, the icon glowing behind itself,
  // and an arrow that only shows under a pointer or keyboard focus.
  const fresh = cardOf(html, 'fresh-one');
  assert.match(fresh, /bg-\[radial-gradient\(120%_90%_at_22%_12%,rgba\(255,255,255,0\.28\),rgba\(255,255,255,0\)_58%\)\]/);
  assert.match(card, /<span aria-hidden="true" class="absolute bottom-2 end-2 [^"]*opacity-0[^"]*group-hover:opacity-100[^"]*group-has-\[a:focus-visible\]:opacity-100/);
});

test('a visitor\'s card has no buttons at all: Try it, Join and Pin are the project page\'s (#6433), and a waitlisted account still sees every project', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.doesNotMatch(html, /data-guest-try=/);
  assert.doesNotMatch(html, /<button[^>]*>Try it/);
  for (const slug of ['todo-list', 'game-corner', 'fresh-one']) {
    const card = cardOf(html, slug);
    assert.deepEqual(card.match(/<button/g) || [], [], `${slug}: no button`);
    assert.doesNotMatch(card, /data-home-pin=|data-home-join=|data-guest-card-footer/);
  }
  // The page behind the card is where a visitor joins; the card has no way
  // to join of its own (#6433, #6609).
  assert.doesNotMatch(read(DISCOVER), /onJoin=|onIntent\?\.\(\{ kind: 'join'/);
  // A waitlisted account is signed in: every project is still there,
  // Featured's and the rest's, each once (#6584, #6597).
  const signedIn = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ signedIn: true }));
  assert.deepEqual([...signedIn.matchAll(/<article data-guest-(?:featured|card)="([^"]+)"/g)].map((m) => m[1]),
    ['todo-list', 'game-corner', 'fresh-one']);
  assert.doesNotMatch(signedIn, /data-guest-join=/);
});

test('signed out with nothing pinned: no suggested apps and no hint line; Pinned apps is not drawn (#6433)', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const pins = loadTsx('frontend/src/features/guest/device-pins.ts');
  pins.devicePinsStore.set({ apps: [], communities: [], ready: true });
  const wired = loadTsx(DISCOVER, { stubs: { './device-pins': pins } });
  const html = renderToHtml(createElement(wired.GuestDiscover, discoverProps()));
  assert.doesNotMatch(html, /data-guest-pinned-apps/);
  assert.doesNotMatch(html, /data-guest-suggested-app/);
  assert.doesNotMatch(html, /Tap \+ to pin an app/);
  // The row and its line are gone from the code, not merely unrendered.
  const src = read(DISCOVER);
  assert.doesNotMatch(src, /home:guest\.appsHint|data-guest-suggested-app|home:guest\.pinApp/);
  const catalog = JSON.parse(read('frontend/locales/en/home.json'));
  assert.equal(catalog['guest.appsHint'], undefined, 'the hint went with the row');
  assert.equal(catalog['guest.pinApp'], undefined, 'the + label went with it');
});

test('signed out with an app pinned on this device: Pinned apps draws its tile and remove badge (#6433)', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const pins = loadTsx('frontend/src/features/guest/device-pins.ts');
  pins.devicePinsStore.set({ apps: ['todo-list'], communities: [], ready: true });
  const wired = loadTsx(DISCOVER, { stubs: { './device-pins': pins } });
  const html = renderToHtml(createElement(wired.GuestDiscover, discoverProps()));
  assert.match(html, /<section data-guest-pinned-apps="">/);
  const at = html.indexOf('data-guest-pinned-app="todo-list"');
  assert.ok(at >= 0, 'the pinned app is Home');
  // The − badge names it, over the tile's own link.
  assert.ok(html.includes(`aria-label="${message('home:guest.unpinApp', { app: 'Todo List' })}"`), 'the − badge names it');
  assert.match(html.slice(at), /<svg/, 'with its remove glyph');
  assert.doesNotMatch(html, /data-guest-suggested-app|Tap \+ to pin/);
});

test('a card is the same signed in or out: no Pin, no Join, no footer, one count (#6433, #6609)', () => {
  const { CommunitiesToJoin } = loadTsx(JOIN);
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const draw = (over = {}) => renderToHtml(createElement(CommunitiesToJoin, {
    apps: APPS, exclude: new Set(), signedIn: true, query: '', ...over,
  }));
  const guest = draw({ signedIn: false });
  const signedIn = draw();
  for (const html of [guest, signedIn]) {
    assert.doesNotMatch(html, /data-home-pin=|data-home-join=|data-guest-card-footer/);
    assert.doesNotMatch(html, /up for a vote/, 'no votes line on a card');
  }
  // One code path: the same community's card is drawn identically on the
  // signed-out page and on the signed-in Home (#6609).
  for (const slug of ['game-corner', 'todo-list', 'fresh-one']) {
    assert.equal(cardOf(signedIn, slug), cardOf(guest, slug), slug);
  }
  // The card has no footer prop at all, so a later change cannot branch it.
  assert.doesNotMatch(read(DISCOVER), /footer=\{footerFor|data-guest-card-footer/);
  assert.doesNotMatch(read(JOIN), /footerFor|home:join\.votes|home:join\.button/);
});

test('an app open for a visitor is pinned from the landing\'s bar, to this device, and Home shows it (#6433)', () => {
  const src = read(LANDING);
  const actions = src.slice(src.indexOf('data-landing-actions'));
  // Only while an app is open and there is no session, beside Sign in.
  assert.match(actions, /\{openApp && !session \? \(\s+<button\s+type="button"\s+data-landing-pin-app=\{openApp\.slug\}\s+aria-pressed=\{devicePins\.apps\.includes\(openApp\.slug\)\}/);
  assert.match(actions, /onClick=\{\(\) => \{ toggleDevicePin\('apps', openApp\.slug\); \}\}/);
  assert.match(src, /const devicePins = useStoreState\(devicePinsStore\);/);
  // The bar's own quiet button, so the bar keeps its height.
  assert.match(actions, /className="un-touch-target -my-2 min-h-11 rounded-full px-2 text-\[15px\] font-semibold /);
  assert.equal(message('auth:landing.pinApp'), 'Pin');
  assert.equal(message('auth:landing.pinnedApp'), 'Pinned');
  assert.equal(message('auth:landing.pinAppNamed', { app: 'Game Corner' }), 'Pin Game Corner to Home');
  // Pressing it writes this device's list, which Home's Pinned apps reads.
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const pins = loadTsx('frontend/src/features/guest/device-pins.ts');
  assert.equal(pins.toggleDevicePin('apps', 'todo-list'), true);
  assert.deepEqual(pins.devicePinsStore.get().apps, ['todo-list']);
  const wired = loadTsx(DISCOVER, { stubs: { './device-pins': pins } });
  assert.match(renderToHtml(createElement(wired.GuestDiscover, discoverProps())), /data-guest-pinned-app="todo-list"/);
});

// Twenty projects, the even ones (a01, a03, …) open for a visitor.
const MANY = Array.from({ length: 20 }, (_, i) => ({
  slug: `a${String(i + 1).padStart(2, '0')}`, name: `App ${i + 1}`, active_users: 20 - i, member_count: 0,
  created_at: ago(200), requires_login: i % 2 !== 0, guest_ready: false, url: `https://a${i + 1}.example`, contributors: [],
}));

test('Featured is the first strip of Communities to join, signed in or out: the chosen kind of it, none while searching, and the rest under a More communities heading', () => {
  const { CommunitiesToJoin } = loadTsx(JOIN);
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const draw = (over = {}) => renderToHtml(createElement(CommunitiesToJoin, {
    apps: APPS, exclude: new Set(), signedIn: true, query: '', ...over,
  }));
  const featuredOf = (html) => [...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]);
  const cardsOf = (html) => [...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]);
  const html = draw();
  assert.deepEqual(featuredOf(html), ['todo-list', 'game-corner'], 'in the order an admin set');
  // #6584, #6597: the rest is every community of the kind, most used first,
  // the featured ones left out: a Featured row, then what it does not show.
  assert.deepEqual(cardsOf(html), ['fresh-one']);
  // #6434: Featured wraps in the same grid as the rest, at the same size,
  // and the rest get their own heading.
  assert.match(html, /<div data-home-join-featured=""[^>]*><h3 id="home-join-featured-label" class="text-xs font-bold uppercase tracking-\[0\.06em\][^"]*">Featured<\/h3><div role="list" aria-labelledby="home-join-featured-label" class="grid grid-cols-\[repeat\(auto-fill,[^"]*\] gap-3 px-1"><div role="listitem" class="flex \[&amp;&gt;article\]:flex-1">/);
  assert.doesNotMatch(read(JOIN), /snap-x|overflow-x-auto|w-\[min\(17rem/, 'nothing in the section scrolls sideways');
  assert.equal(message('home:join.featured'), 'Featured');
  assert.equal(message('home:join.more'), 'More communities');
  assert.equal(JSON.parse(read('frontend/locales/en/home.json'))['join.all'], undefined, 'the old heading went with it');
  // #6584: All is chosen by default, and the rest under it gets its heading,
  // so the cards after Featured do not read as featured too. #6597: it says
  // More communities, since the featured ones are no longer repeated.
  const headingAt = html.indexOf('data-home-join-rest=""');
  assert.ok(headingAt >= 0, 'the rest has its heading under All too');
  assert.ok(html.slice(headingAt).startsWith(`data-home-join-rest="">${message('home:join.more')}</h3>`), 'and it says More communities');
  assert.ok(headingAt > html.indexOf('data-guest-featured="game-corner"'), 'after Featured');
  assert.ok(headingAt < html.indexOf('<article data-guest-card="'), 'before the rest');
  // A chosen kind cannot be reached through the static renderer (its chip is
  // internal state), so pin the source: the heading stays inside the
  // list.length branch, and the non-search list leaves the featured slugs
  // out (they follow the kind, like Featured does).
  assert.match(read(JOIN), /\{featured\.length \? <h3 className=\{`\$\{SMALL_CAPS_LABEL\} px-1 pb-2`\} data-home-join-rest="">\{t\('home:join\.more'\)\}<\/h3> : null\}/, 'the heading is not limited to a chosen kind');
  const src = read(JOIN);
  assert.match(src, /const lead = new Set\(featured\.map\(\(a\) => a\.slug\)\);\s+return \(query \? joinOrder\(pool\) : sortApps\(pool, 'trending'\)\.filter\(\(a\) => !lead\.has\(a\.slug\)\)\)/, 'the non-search list leaves out what Featured shows');
  // Each featured card is the visitor's card, with no Join and no footer (#6609).
  assert.doesNotMatch(cardOf(html, 'game-corner'), /data-home-join=|data-guest-card-footer/);
  // A community already on this Home is in neither.
  const mine = draw({ exclude: new Set(['todo-list']) });
  assert.deepEqual(featuredOf(mine), ['game-corner']);
  // Searching: no strip; the matches are the grid, featured first, and no
  // heading over them.
  const found = draw({ query: 'o' });
  assert.deepEqual(featuredOf(found), []);
  assert.deepEqual(cardsOf(found), ['todo-list', 'game-corner', 'fresh-one']);
  assert.doesNotMatch(found, /data-home-join-featured/);
  assert.doesNotMatch(found, /data-home-join-rest/, 'one grid while searching, no heading');
  // Signed out the same strip, with its own label id (the landing and Home
  // share a document); a visitor's cards have no buttons at all (#6433).
  const guest = draw({ signedIn: false });
  assert.deepEqual(featuredOf(guest), ['todo-list', 'game-corner']);
  assert.match(guest, /id="guest-join-featured-label"/);
  assert.match(guest, /data-home-join-rest="">More communities<\/h3>/);
  assert.doesNotMatch(guest, /data-home-pin=|data-home-join=|data-guest-card-footer/);
  // Nothing featured: no strip, and the grid is everything, with no heading.
  const none = draw({ apps: APPS.map((a) => ({ ...a, featured: false })) });
  assert.doesNotMatch(none, /data-home-join-featured/);
  assert.doesNotMatch(none, /data-home-join-rest/, 'nothing featured: one grid, no heading');
  assert.deepEqual(cardsOf(none), ['game-corner', 'todo-list', 'fresh-one']);
  // Every community of the kind is featured (a kind like Food & drink today
  // cannot be chosen through the static renderer, so this draws the same
  // state): Featured alone, with no heading, no cards and no empty line.
  const onlyFeatured = draw({ apps: APPS.filter((a) => a.featured) });
  assert.match(onlyFeatured, /data-home-join-featured/);
  assert.doesNotMatch(onlyFeatured, /data-home-join-rest/, 'nothing left to head');
  assert.deepEqual(cardsOf(onlyFeatured), [], 'Featured is the only group');
  assert.doesNotMatch(onlyFeatured, /data-home-join-end/);
  assert.doesNotMatch(onlyFeatured, new RegExp(message('home:join.allJoined').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(onlyFeatured, new RegExp(message('home:join.empty').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the list is the same cards, most active first, eight at a time, more as you scroll near its end (One Home, #6361)', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: MANY }));
  assert.deepEqual([...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), [], 'nothing featured by an admin');
  assert.deepEqual([...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]),
    ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08'], 'in order of people active, tryable or not');
  // No Show more: a sentinel under the cards, which the scroller's own
  // IntersectionObserver reads: the nearest ancestor that scrolls, Home's
  // #home-screen signed in and the landing's #auth-landing-scroll signed out.
  // Rooted on #home-screen alone, a visitor never got past the first page.
  assert.match(html, /data-home-join-more=""/);
  assert.doesNotMatch(html, /data-guest-show-more=|data-guest-(?:more|row)=/);
  const src = read(JOIN);
  assert.match(src, /export const JOIN_PAGE = 8;/);
  assert.match(src, /const root = scrollParent\(el\);/);
  assert.doesNotMatch(src, /getElementById\('home-screen'\)/);
  const { scrollParent } = loadTsx(JOIN);
  const node = (overflowY, parent = null) => ({ overflowY, parentElement: parent });
  const landing = node('auto');
  const card = node('visible', node('visible', landing));
  const saved = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (el) => ({ overflowY: el.overflowY });
  try {
    assert.equal(scrollParent(card), landing, 'the box that scrolls the cards');
    assert.equal(scrollParent(node('visible', node('visible'))), null, 'else the viewport');
  } finally {
    if (saved) globalThis.getComputedStyle = saved; else delete globalThis.getComputedStyle;
  }
  assert.match(src, /setShown\(\(n\) => n \+ JOIN_PAGE\)/);
  assert.doesNotMatch(read(DISCOVER), /CARDS_STEP|setShown\(cards\.length/);
  const catalog = JSON.parse(read('frontend/locales/en/auth.json'));
  assert.equal(catalog['guest.more'], undefined, 'its heading went with it');
});

test('the card grows into its project\'s page and back: a view transition with one name, skipped without support or with less motion', async () => {
  const { morph, HERO_NAME } = loadTsx('frontend/src/features/guest/card-morph.ts');
  assert.equal(HERO_NAME, 'guest-hero');
  const el = (top = 100) => ({ style: { viewTransitionName: '' }, getBoundingClientRect: () => ({ width: 200, top, bottom: top + 120 }) });
  const saved = { document: globalThis.document, window: globalThis.window };
  const setup = ({ vt = true, reduce = false } = {}) => {
    const log = [];
    globalThis.window = { innerHeight: 900, matchMedia: () => ({ matches: reduce }) };
    globalThis.document = vt ? {
      startViewTransition(update) {
        log.push('start');
        const done = Promise.resolve().then(update);
        return { ready: done, finished: done };
      },
    } : {};
    return log;
  };
  try {
    // Without support: the page simply changes.
    let navigated = 0;
    let from = el();
    setup({ vt: false });
    morph(from, () => { navigated++; }, () => el());
    assert.equal(navigated, 1);
    assert.equal(from.style.viewTransitionName, '');
    // Asked for less motion: the same.
    let log = setup({ reduce: true });
    morph(el(), () => { navigated++; }, () => el());
    assert.equal(navigated, 2);
    assert.deepEqual(log, []);
    // With it: the card's picture is named, then the name moves to the page's
    // band once the new view is drawn, and comes off when it finishes.
    log = setup();
    from = el();
    const to = el();
    let named = '';
    morph(from, () => { navigated++; }, () => { named = from.style.viewTransitionName; return to; });
    assert.equal(from.style.viewTransitionName, 'guest-hero', 'named before the old view is taken');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(log, ['start']);
    assert.equal(navigated, 3);
    assert.equal(named, '', 'one element carries the name at a time');
    assert.equal(to.style.viewTransitionName, '', 'cleared once it finished');
    // A target at rest off screen is left unnamed, so nothing flies away.
    setup();
    const far = el(5000);
    const seen = [];
    far.style = new Proxy({ viewTransitionName: '' }, { set(o, k, v) { seen.push(v); o[k] = v; return true; } });
    morph(el(), () => {}, () => far);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, [], 'never named');
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
  // Discover and the page's All communities chip both use it; the project
  // card's picture is its target (./project-card.tsx, on the guest page).
  const card = read('frontend/src/features/guest/project-card.tsx');
  assert.match(card, /data-project-preview="" data-guest-hero=\{hero \? '' : undefined\}/);
  assert.match(card, /<ProjectPreview app=\{app\} cover=\{cover\} hero=\{place === 'guest'\} \/>/);
  assert.match(read(PROJECT), /<ProjectCard\s+place="guest"[\s\S]*?data-guest-project-band=""/);
  assert.match(read(LANDING), /morph\(projectHero\(slug\), \(\) => \{ location\.hash = to; \}, \(\) => cardCover\(slug\)\);/);
  assert.match(read('public/css/app.css'), /::view-transition-group\(guest-hero\) \{\s+animation-duration: 0\.4s;/);
});

test('the kinds, and no sort; what an account adds is the hero\'s, not a card in the grid', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.match(html, /aria-pressed="true"[^>]*data-home-join-kind="all"[^>]*>All</);
  assert.match(html, /data-home-join-kind="games"/);
  assert.match(html, /data-home-join-kind="tools"/);
  assert.doesNotMatch(html, /data-home-join-kind="learning"/, 'only kinds some app has');
  // One Home (#6361): one order, featured then most active; no sort control.
  assert.doesNotMatch(html, /data-guest-sort=/);
  // The "Want to join in?" card is gone (Evan, 22 Oct 2026): it said what
  // the hero says, with a second way in, partway down the grid.
  assert.doesNotMatch(html, /data-guest-join=|data-guest-join-continue=/);
  const src = read(DISCOVER);
  assert.doesNotMatch(src, /function JoinIn|joinDismissed|auth:guest\.join\.(title|waitlist|signUp|notNow)/);
  const catalog = JSON.parse(read('frontend/locales/en/auth.json'));
  for (const id of ['guest.join.title', 'guest.join.waitlist', 'guest.join.signUp', 'guest.join.notNow']) {
    assert.equal(catalog[id], undefined, `${id} went with the card`);
  }
});

test('while the directory loads, placeholders; when it cannot be read, a line and Try again', () => {
  const loading = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: null }));
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /data-guest-card=/);
  const failed = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: null, failed: true }));
  assert.ok(text(failed).includes(message('auth:guest.loadFailed')));
  // Without a way to read again, only the sentence.
  assert.doesNotMatch(failed, /data-guest-retry=/);
  // With one, the button under it says so (#6007).
  const retried = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ apps: null, failed: true, onRetry() {} }));
  assert.ok(text(retried).includes(message('auth:guest.loadFailed')));
  const button = retried.match(/<button[^>]*data-guest-retry=""[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(button, 'a Try again button under the failure line');
  assert.equal(text(button[1]).join(' '), message('auth:guest.retry'));
  // And nothing to press when it did not fail.
  assert.doesNotMatch(renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ onRetry() {} })), /data-guest-retry=/);
});

// ─── guest-project.tsx ────────────────────────────────────────────

const projectProps = (app) => ({ app, primaryClass: 'pill', onIntent() {}, onOpenInside() {}, onShare() {} });

test('a project page: All communities, the project card in its colour with Open <name>, Join and Share, and no Pin or tabs', () => {
  const html = renderComponent(PROJECT, 'GuestProject', projectProps(APPS[0]));
  assert.match(html, /data-guest-project="game-corner"/);
  assert.match(html, /<button type="button" data-guest-all-communities=""[^>]*><svg[^>]*>[\s\S]*?<\/svg>All communities<\/button>/);
  assert.match(html, /<section data-project-card="guest" data-guest-project-band=""/);
  assert.match(html, /<h1 data-project-card-name=""[^>]*>Game Corner<\/h1>/);
  assert.match(html, /<p data-project-card-description=""[^>]*>Classic games, fresh every day\.<\/p>/);
  // Open, by name, where the app has a view for somebody with no account.
  assert.match(html, /<a href="https:\/\/game-corner\.example" data-guest-try="game-corner"[^>]*><span class="truncate">Open Game Corner<\/span><\/a>/);
  assert.equal(message('auth:guest.project.openNamed', { project: 'Game Corner' }), 'Open Game Corner');
  assert.doesNotMatch(html, /data-guest-use=|data-guest-needs-account=/);
  assert.match(html, /data-guest-join-project=""/);
  assert.match(html, new RegExp(`data-guest-share="" aria-label="${message('auth:guest.project.share')}"`));
  // #6433 asked for Pin to go from the signed-out page; the tabs went with
  // the rebuild (the hand-off of 11 Nov 2026).
  assert.doesNotMatch(html, /data-guest-pin-project|role="tablist"|data-guest-tab=|data-guest-members-only/);
  // Who is around: numbers only, from the minimums. Its members now; the
  // week's count comes with the overview.
  const words = text(html);
  assert.ok(words.includes(message('auth:guest.project.audience')));
  assert.ok(words.includes('· 87 members'));
  assert.doesNotMatch(html, /data-guest-people-active/);
  // Made together: a game is played, and the sentence without a count
  // before the month's is known.
  assert.ok(words.includes(message('auth:guest.project.madeByPlayers')));
  assert.ok(words.includes(message('auth:guest.project.madeHow')));
  assert.match(html, /data-guest-made-join=""[^>]*>Join to vote and suggest</);
});

test('a project page reads its overview: counts from the minimums, What it\'s like from three pictures, two changes then the rest, what went live this month', () => {
  const pic = (id) => `/api/public/apps/game-corner/changes/${id}/stills/a${id}`;
  const lately = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const overview = (over = {}) => ({
    app: { ...APPS[0], builders: 3, open_votes: 13 },
    activity: { active_week: 34, merged_month: 39 },
    votes: [1, 2, 3].map((id) => ({
      id, pr_number: id, title: `Change ${id}`, summary: `What change ${id} does.`, yes: 10 + id, no: 0,
      pictures: id === 1 ? { before: pic(100), after: pic(101) } : null,
    })),
    merged: [11, 12, 13, 14].map((id) => ({ id, title: `Live ${id}`, summary: null, merged_at: lately, picture: pic(id) })),
    requests: null,
    ...over,
  });
  const page = (o) => renderComponent(PROJECT, 'GuestProject', { ...projectProps(o.app), initialOverview: o });
  const html = page(overview());
  const words = text(html);
  assert.ok(words.includes(message('auth:guest.project.activeWeek_other', { count: 34 })));
  // What it's like: the after pictures of what went live, with their titles.
  assert.equal([...html.matchAll(/data-guest-like-item="/g)].length, 4);
  assert.ok(words.includes(message('auth:guest.project.whatItsLike')));
  assert.ok(words.includes(message('auth:guest.project.madeHowMonth_other', { count: 39 })));
  // Up for a vote · 13: two rows, then the rest, which See all opens in place.
  assert.ok(words.includes(message('auth:guest.project.upForVoteCount_other', { count: 13 })));
  assert.equal([...html.matchAll(/<div data-guest-vote="/g)].length, 2);
  assert.match(html, /data-guest-votes-all=""[^>]*>See all 13</);
  assert.match(html, /<button type="button" data-guest-votes-more=""[^>]*>[\s\S]*?11 more up for a vote/);
  // A row: its small picture with Before · After when it has both, its
  // title and line, its tally and Vote; the row opens the change.
  assert.match(html, /<div data-guest-vote="1"[^>]*><button type="button" data-guest-vote-open=""/);
  assert.match(html, new RegExp(`src="${pic(101)}"[\\s\\S]*?${message('auth:guest.project.beforeAfter')}`));
  assert.ok(words.includes(message('auth:guest.project.yes_other', { count: 11 })));
  assert.match(html, /data-guest-vote-btn=""[^>]*>Vote</);
  // Recently live: three rows and how many more went live this month.
  assert.equal([...html.matchAll(/data-guest-merged="/g)].length, 3);
  assert.match(html, /data-guest-live-more=""[\s\S]*?36 more live this month/);
  assert.doesNotMatch(html, /username|Homeroom bot/, 'no names');
  // Under the minimums a count says nothing; under three pictures, no strip;
  // with nothing this month, no count sentence and no more row.
  const quiet = page(overview({
    activity: { active_week: 4, merged_month: 0 },
    merged: overview().merged.slice(0, 2),
    app: { ...APPS[0], member_count: 12, builders: 1, open_votes: 3 },
  }));
  assert.doesNotMatch(quiet, /data-guest-people|data-guest-like=|data-guest-live-more/);
  assert.ok(text(quiet).includes(message('auth:guest.project.madeHow')));
});

test('an app with no view for visitors yet: Sign up to open, with a line saying it needs a free account', () => {
  const html = renderComponent(PROJECT, 'GuestProject', projectProps(APPS[1]));
  assert.doesNotMatch(html, /data-guest-try=/);
  assert.match(html, /data-guest-use=""[^>]*><span class="truncate">Sign up to open<\/span>/);
  assert.match(html, /data-guest-needs-account=""[^>]*>Todo List needs a free account to use\.</);
  // A game says "to play".
  const game = renderComponent(PROJECT, 'GuestProject', projectProps({ ...APPS[1], category: 'games' }));
  assert.match(game, /needs a free account to play\.</);
});

test('a change opened from Up for a vote: its title, its before and after with a slider, the tally and Join to vote', () => {
  const vote = { id: 7, pr_number: 1, title: 'Smooth tiles', summary: 'Tiles glide.', yes: 8, no: 0, pictures: { before: '/b', after: '/a' } };
  const html = renderComponent(PROJECT, 'GuestChange', { vote, app: APPS[0], onBack() {}, onIntent() {} });
  assert.match(html, /data-guest-change-back="" aria-label="Back to Game Corner"/);
  assert.match(html, /<h2[^>]*>Smooth tiles<\/h2>/);
  assert.match(html, /<img src="\/a" alt="After"/);
  assert.match(html, /<img src="\/b" alt="Before"[^>]*style="clip-path:inset\(0 50% 0 0\)"/);
  assert.match(html, /<input type="range"[^>]*data-guest-change-slider=""/);
  assert.ok(text(html).includes(message('auth:guest.project.change.tally', { yes: 8, no: 0 })));
  assert.match(html, /data-guest-change-join=""[^>]*>Join to vote</);
  // Without pictures, the words alone.
  const bare = renderComponent(PROJECT, 'GuestChange', { vote: { ...vote, pictures: null }, app: APPS[0], onBack() {}, onIntent() {} });
  assert.doesNotMatch(bare, /data-guest-change-compare|data-guest-change-slider/);
});

test('the overview it reads carries no names, and the page draws none', () => {
  const src = read(PROJECT);
  assert.match(src, /fetchOverview\(app\.slug\)/);
  assert.doesNotMatch(src, /username|contributors\.map|\.names\b/);
  // The server side of the same promise is pinned in tests/public-api.test.js.
  assert.doesNotMatch(read('src/services/public-project.js'), /username/);
});

// ─── the story's short version ────────────────────────────────────

test('the short story heads Discover: the headline, the Wikipedia line, three numbered points and a closing line, with no button of its own', () => {
  const html = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.deepEqual(text(html), [
    'Welcome to Homeroom',
    'The app library anyone can edit.',
    'Community apps you build together. Like Wikipedia, but for software.',
    '1', message('auth:guest.hero.change.title'), message('auth:guest.hero.change.body'),
    '2', message('auth:guest.hero.vote.title'), message('auth:guest.hero.vote.body'),
    '3', message('auth:guest.hero.owned.title'), message('auth:guest.hero.owned.body'),
    message('auth:guest.hero.start'),
    // The phone's closing line, whose second half is the door to the page
    // about private communities.
    'Try any app below, or', 'start a private community for your own group', '.',
    message('auth:guest.hero.private.title'),
    message('auth:guest.hero.private.body'),
  ]);
  assert.equal(message('auth:guest.hero.headline'), 'The app library anyone can edit.');
  assert.equal(message('auth:guest.hero.change.title'), 'Anyone can make a change');
  assert.equal(message('auth:guest.hero.vote.title'), 'Community votes on it');
  assert.equal(message('auth:guest.hero.owned.title'), 'Software owned by its communities');
  assert.equal(message('auth:guest.hero.start'), 'Want to get started? Try any of the apps below, or make an account to make your own app.');
  // The three points, numbered because they are a sequence: each title, and
  // its line from md only, so a phone keeps the apps near the first screen.
  assert.match(html, /<ol data-landing-story-points="" class="mt-4 flex flex-col gap-2\.5 md:mt-6 md:gap-3\.5">/);
  assert.equal([...html.matchAll(/<li /g)].length, 3);
  assert.equal([...html.matchAll(/class="hidden text-\[15px\] leading-\[21px\] text-\[color:var\(--site-muted\)\] md:block"/g)].length, 3);
  // The numerals are for the eye; the list says the order to a screen reader.
  assert.equal([...html.matchAll(/aria-hidden="true">[123]<\/span>/g)].length, 3);
  assert.match(html, /data-landing-story="" data-landing-story-compact=""/);
  // DRAWN IN THE WEBSITE'S LOOK (13 Nov 2026): a sky band edge to edge, a
  // white window in it opened by a strip of three dots, the headline and the
  // points' titles in the site's serif, sun discs for the numerals. Every
  // colour is one of the look's variables (public/css/app.css), so the short
  // story names no colour of the app's palette and no dark class.
  assert.match(html, /<div data-landing-story="" data-landing-story-compact="" class="site-band \[--band:var\(--site-sky\)\] [^"]*"><div data-landing-story-window="" class="border border-\[color:var\(--site-line\)\] bg-\[var\(--site-panel\)\]"><div class="[^"]*" aria-hidden="true">(?:<span class="[^"]*"><\/span>){3}<\/div>/);
  assert.match(html, /<h1 class="font-\[family-name:var\(--site-serif\)\] font-normal [^"]*">The app library anyone can edit\.<\/h1>/);
  assert.equal([...html.matchAll(/<span class="flex h-7 w-7 [^"]*bg-\[var\(--site-sun\)\][^"]*text-\[color:var\(--site-on-sun\)\]" aria-hidden="true">/g)].length, 3);
  {
    const src = read(STORY);
    const compact = src.slice(src.indexOf('if (compact) {'), src.indexOf('const s = fitStyle(fit);'));
    assert.doesNotMatch(compact, /\b(?:text|bg|border|shadow)-(?:zinc|violet|white|black)\b/);
    assert.doesNotMatch(compact, /\bdark:/);
    const css = read('public/css/app.css');
    for (const name of new Set([...compact.matchAll(/var\((--site-[a-z-]+)\)/g)].map((m) => m[1]))) {
      assert.match(css, new RegExp(`#auth-landing-screen \\{[^}]*${name}:`), `${name} is declared`);
    }
  }
  // "Welcome to Homeroom" is a wide screen's: on a phone the wordmark is
  // directly above the headline.
  assert.match(html, /<div class="[^"]* hidden md:block">Welcome to Homeroom<\/div><h1 /);
  // The closing line is two: a wide screen's points at the apps below, a
  // phone's carries the door the wide screen has as a card.
  assert.match(html, /<p data-landing-story-next="" class="[^"]*\bhidden\b[^"]*\bmd:block\b[^"]*">Want to get started\?/);
  assert.match(html, /<p data-landing-story-next="" class="[^"]*\bmd:hidden\b[^"]*">Try any app below, or <a href="\/communities" data-landing-story-private="" class="[^"]*">start a private community for your own group<\/a>\.<\/p>/);
  // NOTHING TO PRESS BUT THE DOOR (13 Nov 2026): no button of its own, no
  // Continue, no Sign in line. Making an account is the bar's one button.
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /data-landing-story-join|data-landing-story-start|data-landing-story-how|data-landing-story-signin/);
  assert.doesNotMatch(read(STORY), /data-landing-story-join|noteSignUpFrom\('hero'\)/);
  assert.doesNotMatch(read(LANDING), /data-landing-story-sign-up/);
  assert.deepEqual([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/communities', '/communities'], 'both links are the door, a phone\'s and a wide screen\'s');
  assert.equal(loadTsx(STORY).COMMUNITIES_PATH, '/communities');
  // Beside the words from md: the picture, then the door as a card. No
  // figures until the directory's read has brought them.
  assert.match(html, /<div class="hidden w-\[320px\] shrink-0 flex-col items-center gap-3\.5 md:flex"><img src="\/brand\/people\.png"/);
  assert.ok(html.indexOf('<h1') < html.lastIndexOf('/brand/people.png'), 'the words first, the picture after');
  assert.match(html, /<a href="\/communities" data-landing-story-private="" class="flex w-full items-center [^"]* no-underline [^"]*">/);
  assert.doesNotMatch(html, /data-landing-story-month/);
  assert.doesNotMatch(html, new RegExp(message('auth:guest.hero.month.title')));

  // THIS MONTH: the changes that went live across the public apps and the
  // people who made them, once the read has them. A card beside the words
  // from md; on a phone one line under the Wikipedia line.
  const lived = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, month: { changes: 1409, contributors: 87 } });
  assert.equal([...lived.matchAll(/data-landing-story-month=""/g)].length, 2);
  assert.match(lived, /<p data-landing-story-month="" class="[^"]*\bmd:hidden\b[^"]*"><span>This month<\/span><span><strong class="font-semibold [^"]*">1,409<\/strong> changes<\/span><span><strong class="font-semibold [^"]*">87<\/strong> contributors<\/span><\/p>/);
  // …drawn as one of the site's little windows: a sun strip with its three
  // dots and the title, the two figures in the serif under it.
  assert.match(lived, /<div data-landing-story-month="" class="w-full border [^"]*"><div class="[^"]*bg-\[var\(--site-sun\)\][^"]*"><span class="flex gap-1" aria-hidden="true">(?:<span class="[^"]*"><\/span>){3}<\/span>This month<\/div><div class="grid grid-cols-2"><p class="[^"]*"><strong class="block font-\[family-name:var\(--site-serif\)\] [^"]*">1,409<\/strong> changes<\/p><p class="[^"]*\bborder-s\b[^"]*"><strong class="block font-\[family-name:var\(--site-serif\)\] [^"]*">87<\/strong> contributors<\/p><\/div><\/div>/);
  // One of each is said in the singular.
  const one = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, month: { changes: 1, contributors: 1 } });
  assert.match(one, />1<\/strong> change<\/span>/);
  assert.match(one, />1<\/strong> contributor<\/span>/);

  // The landing hands it the figures that ride beside the directory, and
  // reads them off the payload in one place: nothing for a month with no
  // change in it, a missing object, or figures that are not numbers.
  assert.match(read(LANDING), /<Story\s+compact\s+primaryClass=\{PRIMARY_PILL\}\s+welcomeEmail=\{releaseEmail\}\s+month=\{month\}/);
  assert.match(read(LANDING), /show\.month\?\.\(monthActivityOf\(data\)\);/);
  const { monthActivityOf } = loadTsx(LANDING);
  assert.deepEqual(monthActivityOf({ apps: [], month: { changes: 1409, contributors: 87 } }), { changes: 1409, contributors: 87 });
  assert.equal(monthActivityOf({ apps: [], month: null }), null);
  assert.equal(monthActivityOf({ apps: [] }), null, 'an older server');
  assert.equal(monthActivityOf({ month: { changes: 0, contributors: 0 } }), null, 'a zero says nothing');
  assert.equal(monthActivityOf({ month: { changes: 'many', contributors: 3 } }), null);
  assert.equal(monthActivityOf(null), null);

  // THE BAR'S BUTTON IS THE ONE WAY TO MAKE AN ACCOUNT, and says what
  // pressing it does from the one switch, Admin › Waitlist's (#6633): the
  // public options' `waitlist_enabled`, and the waitlist's words until they
  // arrive, so the first paint is what the prerendered document says.
  assert.match(read(LANDING), /\{accountsWait \? t\('auth:guest\.hero\.joinWaitlist'\) : t\('auth:guest\.header\.signUp'\)\}/);
  assert.equal(message('auth:guest.hero.joinWaitlist'), 'Join the waitlist');
  assert.equal(message('auth:guest.header.signUp'), 'Sign up');
  assert.match(read(LANDING), /const accountsWait = newAccountsWait\(waitlistPayload\);/);
  assert.doesNotMatch(read(LANDING), /waitlist=\{NEW_ACCOUNTS_WAIT\}/);
  const { NEW_ACCOUNTS_WAIT, newAccountsWait } = loadTsx(DATA);
  assert.equal(NEW_ACCOUNTS_WAIT, true);
  assert.equal(newAccountsWait(null), true, 'until the options arrive');
  assert.equal(newAccountsWait({}), true, 'an older server');
  assert.equal(newAccountsWait({ waitlist_enabled: true }), true);
  assert.equal(newAccountsWait({ waitlist_enabled: false }), false, 'only an explicit off');
  // The frame, the page about private communities and the email step read
  // the same switch (two `waitlist` readers here: the landing's frame and
  // that page; the gated frame is gone with looks v2).
  assert.equal([...read(LANDING).matchAll(/waitlist=\{accountsWait\}/g)].length, 2);
  assert.match(read(LANDING), /<GuestCommunities waitlist=\{accountsWait\} onStart=\{\(\) => setSheet\('start'\)\} \/>/);
  assert.match(read('frontend/src/features/auth/login.tsx'), /const accountsWait = newAccountsWait\(useWaitlistOptions\(\)\);/);
  assert.match(read('frontend/src/features/auth/login.tsx'), /\{accountsWait \? t\('auth:login\.otp\.lead'\) : t\('auth:login\.otp\.leadOpen'\)\}/);
  assert.doesNotMatch(message('auth:login.otp.leadOpen'), /waitlist/i);
  assert.doesNotMatch(read(LANDING), /<GuestDiscover[^>]*\bwaitlist=/, 'the card that read it is gone');
  // The looks' frame keeps the page it held when it was drawn (its own
  // headline, line and button; tests/landing-frame.test.js).
  assert.equal(message('auth:guest.hero.line'), "Look around and try what we're making.");
  assert.equal(message('auth:guest.hero.signUp'), 'Create account');
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
  assert.match(src, /const showBack = !!openApp \|\| appDiscover;/);
  assert.match(src, /const to = appDiscover && !guestProject \? '#landing' : '#apps';/);
  // A project's page keeps the guest bar; its chip runs the same way back.
  assert.match(src, /onAllCommunities=\{onBack\}/);
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
  const vote = renderComponent(PROJECT, 'GuestChange', { vote: { id: 1, title: 'A', summary: null, yes: 1, no: 0 }, app: APPS[1], onBack() {}, onIntent() {}, signedIn: true });
  assert.match(vote, /data-guest-vote-later=""/);
  assert.doesNotMatch(vote, /data-guest-change-join|data-guest-vote-btn/);
  // The waiting room leads there.
  assert.match(read('frontend/src/features/auth/waiting.tsx'), /<a\s+href="#apps"\s+data-waiting-look-around=""/);
});

const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';

test('the ways in are the sheet\'s: Apple, Google and email, and a phone number on the landing\'s sheets', () => {
  const sheet = read(SHEET);
  // A phone where it is offered but not first: the link under the email.
  // An invite's Join draws its own (`inviteWays`, tests/invite-join-sheet.test.js).
  assert.match(sheet, /\{phoneLink && !phone \? \(/);
  assert.match(sheet, /className=\{QUIET\} onClick=\{\(\) => \{ setError\(null\); setStep\('phone'\); \}\}>\{t\('auth:signInSheet\.toPhoneLink'\)\}<\/button>/);
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
  // on the start edge; the title reads from there.
  assert.match(header, /<div className="w-7 h-7 shrink-0 flex items-center justify-center">/);
  assert.match(header, /\[\[data-guest-top\]_&\]:px-0 \[\[data-guest-top\]_&\]:text-start/);
  assert.match(header, /<div className="w-7 shrink-0 \[\[data-guest-top\]_&\]:hidden" aria-hidden="true" \/>/);
  // Sign in and Sign up, both DRAWN at the row's 28px with no padding of
  // their own: the landing bar is a 28px content row on every screen
  // (tests/header-height-parity.test.js), so a taller control would grow the
  // whole bar. `un-touch-target` grows only the hit box to 44px, which is
  // what the review of #5743's build asked for (both were 28px to the
  // finger).
  const actions = header.slice(header.indexOf('data-landing-actions'));
  assert.match(actions.slice(0, 300), /hiddenLast\(session \|\| !guestPages, guestTop \? 'flex shrink-0 items-center gap-1\.5' : `absolute bottom-4 end-4 /);
  assert.match(actions, /data-landing-sign-in=""\s+className=\{hiddenLast\(session \|\| !guestPages, 'un-touch-target -my-2 min-h-11 rounded-full px-2 /);
  assert.match(actions, /onClick=\{\(\) => \{ noteSignUpFrom\('header_sign_in'\); setSheet\('signin'\); \}\}/);
  assert.match(actions, /<Button\s+type="button"\s+variant="pillAccent"\s+size="none"\s+ink="solid"\s+data-landing-sign-up=""/);
  // Both branches centre the label in the 44px pill. On a project's page the
  // button is `md:inline-flex`, and a flex box without `items-center`
  // stretches its anonymous text item, so the label sat at the top of the
  // pill while the inline-block Discover one looked centred (#6309).
  assert.match(actions, /data-landing-sign-up=""\s+className=\{guestTop \? 'un-touch-target items-center justify-center -my-2 min-h-11 /);
  assert.match(actions, /: 'un-touch-target items-center justify-center hidden md:inline-flex -my-2 min-h-11 /);
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
  // Once nobody waits, the plain Sign up titles.
  assert.equal(intentTitle({ kind: 'join', app }, t, false), 'Sign up to join Game Corner');
  assert.equal(intentTitle({ kind: 'vote', app, change: 'Practice mode' }, t, false), 'Sign up to vote on this change');
  assert.equal(intentTitle({ kind: 'ask', app }, t, false), 'Sign up to ask for something');
  assert.equal(intentTitle({ kind: 'chat', app }, t, false), 'Sign up to chat in Game Corner');
  assert.equal(intentTitle({ kind: 'use', app }, t, false), 'Sign in to use Game Corner');
  // While new accounts wait, taking part asks for an account in the title,
  // not in a line under it (#4037); Try it does not, since a waiting account
  // can use an app (#5848).
  assert.equal(intentTitle({ kind: 'join', app }, t, true), 'Create your account to be part of Game Corner');
  assert.equal(intentTitle({ kind: 'vote', app, change: 'Practice mode' }, t, true), 'Create your account to vote on changes');
  assert.equal(intentTitle({ kind: 'ask', app }, t, true), 'Create your account to ask for something');
  assert.equal(intentTitle({ kind: 'chat', app }, t, true), 'Create your account to chat in Game Corner');
  assert.equal(intentTitle({ kind: 'use', app }, t, true), 'Sign in to use Game Corner');
  const src = read(LANDING);
  assert.match(src, /export function intentTitle\(intent: GuestIntent, t: Translate, waitlist: boolean = NEW_ACCOUNTS_WAIT\): string \{/);
  assert.match(src, /title=\{intentTitle\(intent, \(id, params\) => t\(id, params\), accountsWait\)\}/);
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
  assert.equal(story.expectText, 'The app library anyone can edit.');
  // The bar's Sign in and its one filled button, and under the short story
  // no button at all: the one thing to press there is the door to the page
  // about private communities.
  const one = manifest.tests.find((t) => /^Landing has Sign in and one filled button in its bar, and under the story no button, only the door to private communities/.test(t.name));
  assert.ok(one);
  assert.match(one.expectSelector, /:has\(#landing-header button\[data-landing-sign-up\]\):has\(\[data-landing-story\] a\[data-landing-story-private\]\[href="\/communities"\]\):not\(:has\(\[data-landing-story\] button\)\) #landing-header \[data-landing-sign-in\]:not\(\.hidden\)$/);
  // Under the runner's selector cap (`MAX_TEST_SELECTOR_LEN`).
  assert.ok(one.expectSelector.length <= 256);
  // And the page behind that door, at its own address, in Discover's place.
  const groups = manifest.tests.find((t) => t.path === '/communities?shot=anon');
  assert.ok(groups, 'the page about private communities has a declared check');
  assert.match(groups.expectSelector, /^#auth-landing-screen:not\(\.hidden\):not\(:has\(\[data-guest-discover\]\)\) \[data-guest-groups\]:has\(button\[data-guest-groups-start\]\)/);
  assert.equal(groups.expectText, 'You or the group');
});

// ─── the search, behind a button ──────────────────────────────────

test('the search is put away until its button is pressed, and stays in the document for the check that asks for it', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  // At rest: the field is in the document and hidden, with the whole stack
  // it heads (this device has pinned nothing), and the round button rides
  // the Communities heading.
  assert.match(html, /<div class="hidden"><label class="flex h-11 items-center gap-2 rounded-\[14px\] bg-white ps-3\.5 [^"]* hidden">/);
  assert.match(html, /<input type="search" data-guest-search="" /);
  assert.match(html, /<h2 class="home-area-label [^"]*"><span [^>]*>Communities<\/span><button type="button" data-guest-search-open="" aria-expanded="false" aria-label="Search apps and communities" title="Search apps and communities" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white /);
  // The field's own × puts it away again.
  assert.match(html, /<button type="button" data-guest-search-close="" aria-label="Close search" title="Close search" class="flex h-11 w-11 shrink-0 /);
  const src = read(DISCOVER);
  assert.match(src, /const searchShown = searchOpen \|\| !!query;/, 'a search kept on the history entry shows the field with it');
  assert.match(src, /const openSearch = \(\) => \{ focusSearch\.current = true; setSearchOpen\(true\); \};/);
  assert.match(src, /const closeSearch = \(\) => \{ changeQuery\(''\); setSearchOpen\(false\); \};/);
  assert.match(src, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape'\) closeSearch\(\); \}\}/);
  assert.match(src, /headingAction=\{searchShown \? null : \(/, 'one control at a time: the button, or the field with its ×');
  // The signed-in Home draws the same section with no button: its own search
  // leads the page.
  assert.match(read(JOIN), /<SectionHeading action=\{headingAction\}>\{heading\}<\/SectionHeading>/);
  assert.doesNotMatch(read('frontend/src/features/home/home-join.tsx'), /headingAction/);
  // The declared check that asks whether this Home can be searched still
  // finds the field.
  const manifest = JSON.parse(read('dapp.json'));
  assert.ok(manifest.tests.some((t) => /\[data-guest-discover\]:has\(\[data-guest-search\]\)/.test(t.expectSelector || '')));
});


test('guest directory searches belong to their history entry and preserve other navigation state (#6507)', () => {
  const { guestSearchFrom, withGuestSearch } = loadTsx('frontend/src/features/guest/search-history.ts');
  const state = withGuestSearch({ navigation: { place: 'home' } }, 'garden');
  assert.equal(guestSearchFrom(state), 'garden');
  assert.deepEqual(state.navigation, { place: 'home' });
  assert.equal(guestSearchFrom(withGuestSearch(state, '')), '');
  assert.equal(guestSearchFrom(withGuestSearch(null, 'x'.repeat(1001))), '');
  for (const invalid of [null, 7, 'garden', { homeroomGuestSearch: 7 }]) assert.equal(guestSearchFrom(invalid), '');
  const src = read(DISCOVER);
  assert.match(src, /useState\(''\)/, 'first render remains the empty prerender');
  assert.match(src, /addEventListener\('popstate', restore\)/);
  assert.match(src, /replaceState\(withGuestSearch\(window.history.state, value\), ''\)/);
});

// ─── project-card.tsx and visitor-view.tsx ───────────────────────

test('the project card\'s picture: the still first, a loop only after mount and only where previews may play, with a pause and its label', () => {
  const CARD_TSX = 'frontend/src/features/guest/project-card.tsx';
  const still = renderComponent(CARD_TSX, 'ProjectPreview', { app: APPS[0], cover: { illustration_url: '/still', preview_url: '/loop' } });
  assert.match(still, /<img src="\/still"/);
  assert.doesNotMatch(still, /<video|data-project-preview-pause/, 'no video in the first render (no hydration mismatch, nothing fetched)');
  // Without a picture, the icon on the project's colour.
  const bare = renderComponent(CARD_TSX, 'ProjectPreview', { app: APPS[0], cover: null });
  assert.match(bare, /class="app-icon-tile[^"]*w-20 h-20/);
  const src = read(CARD_TSX);
  // Reduced motion, Data Saver and "Play previews" off all leave the still
  // (lib/card-previews.ts previewsAllowed), and a loop that fails is never
  // asked for again.
  assert.match(src, /setCanPlay\(!!src && previewsAllowed\(\) && !previewFailed\(src\)\)/);
  assert.match(src, /onError=\{\(\) => \{ markPreviewFailed\(src\); setCanPlay\(false\); \}\}/);
  assert.match(src, /aria-label=\{paused \? t\('auth:guest\.project\.card\.play'\) : t\('auth:guest\.project\.card\.pause'\)\}/);
  assert.equal(message('auth:guest.project.card.previewLabel'), 'Preview of the real app');
  // Buttons on a phone are 50px; 52px from 768px.
  assert.match(src, /export const CARD_OPEN_BTN = 'flex h-\[50px\][^']* md:h-\[52px\]/);
});

test('See what visitors see: the visitor\'s own page under a bar with the way back, read only', () => {
  const VIEW = 'frontend/src/features/guest/visitor-view.tsx';
  const html = renderComponent(VIEW, 'VisitorView', { slug: 'game-corner', onClose() {} });
  assert.match(html, /^<div data-visitor-view="game-corner" role="dialog" aria-modal="true" aria-label="What visitors see"/);
  assert.match(html, /data-visitor-view-back=""[^>]*>Back to hub</);
  // The signed-out site's bar: the wordmark, Sign in and Sign up.
  assert.ok(text(html).includes(message('auth:guest.header.signIn')));
  assert.ok(text(html).includes(message('auth:guest.header.signUp')));
  assert.match(html, /data-visitor-view-state="loading"/);
  const src = read(VIEW);
  // The same public overview a visitor's browser reads, drawn by the same page.
  assert.match(src, /fetchOverview\(slug\)/);
  assert.match(src, /<GuestProject\s+app=\{overview\.app\}\s+initialOverview=\{overview\}\s+preview\s+onIntent=\{inert\}\s+onOpenInside=\{open\}\s+onShare=\{inert\}\s+onAllCommunities=\{inert\}/);
  assert.match(src, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.equal(message('project:visitorView.inert'), 'Visitors are asked to sign in here');
});

test('the list wears the website\'s look signed out only: repainted by its own hooks under the landing, its classes left alone', () => {
  const css = read('public/css/app.css');
  const a = css.indexOf("/* ── THE WEBSITE'S LOOK ON THE SIGNED-OUT PAGES");
  // With the landing's own rules, between its two marks: well before the
  // looks' hand-written blocks and generated section, which have to stay
  // together and directly before the new look's block, itself appended last
  // (tests/frame-app.test.js, tests/looks-css.test.js).
  const b = css.indexOf("/* the website's look on the signed-out pages: end */");
  assert.ok(a > 0 && b > a && b < css.indexOf("THE BELL'S SHEET") && b < css.indexOf('/* looks:begin'), 'the block sits before the looks and the new look');
  const block = css.slice(a, b);
  // A band's colour runs edge to edge as a border image let out to the
  // sides, never as a viewport-sized shadow; its reach is the usable box's
  // width, the one width the sheet reads (tests/usable-box.test.js).
  assert.match(block, /#auth-landing-screen \.site-band \{\s+background-color: var\(--band\);\s+border-image: conic-gradient\(var\(--band\) 0 0\) fill 0 \/ 0 \/ 0 var\(--platform-usable-w\);\s+\}/);
  assert.doesNotMatch(block, /100v(?:w|max)/);
  // Every rule of the block is under the landing's root (or names it), so
  // the same chips and cards on the signed-in Home are untouched.
  const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter(Boolean);
  assert.ok(selectors.length > 15);
  for (const selector of selectors) {
    // Split a selector list on its own commas, not on those inside :is().
    let depth = 0;
    let part = '';
    const parts = [];
    for (const ch of selector) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { parts.push(part); part = ''; } else part += ch;
    }
    parts.push(part);
    for (const one of parts) assert.match(one, /#auth-landing-screen/, one.trim());
  }
  // The heading is a title in the serif; the search and the chips are
  // outlined and the chosen chip is ink; a card is a white face on an ink
  // outline with its name in the serif.
  assert.match(block, /\[data-home-join-section\] > \.home-area-label > span:first-child \{\s+font-family: var\(--site-serif\);/);
  assert.match(block, /:is\(\[data-guest-search-open\], \[data-home-join-kind\]\) \{\s+background-color: var\(--site-panel\);\s+color: var\(--site-ink\);\s+box-shadow: inset 0 0 0 1px var\(--site-line\);/);
  assert.match(block, /\[data-home-join-kind\]\[aria-pressed="true"\] \{\s+background-color: var\(--site-chosen\);\s+color: var\(--site-chosen-ink\);/);
  assert.match(block, /:is\(\[data-guest-card\], \[data-guest-featured\]\) \{\s+border: 1px solid var\(--site-line\);\s+border-radius: 14px;/);
  assert.match(block, /\[data-guest-card-link\] \{\s+font-family: var\(--site-serif\);/);
  // The bar's button is a sun pill with ink words on every signed-out page.
  assert.match(block, /#auth-landing-screen #landing-header \[data-landing-sign-up\],\s+#auth-landing-screen \[data-guest-groups\] \.bg-violet-600 \{\s+background-color: var\(--site-sun\);\s+color: var\(--site-on-sun\);/);
  // The hooks it paints by are the components' own, and the shared
  // components carry no class of the look.
  const discover = read(DISCOVER);
  for (const hook of ['data-guest-search-open', 'data-guest-search=', 'data-guest-card=', 'data-guest-featured=', 'data-guest-card-link', 'data-guest-card-about']) assert.ok(discover.includes(hook), hook);
  const join = read('frontend/src/features/home/communities-to-join.tsx');
  for (const hook of ['data-home-join-section', 'data-home-join-kind', 'guest-join-featured-label', 'data-home-join-rest']) assert.ok(join.includes(hook), hook);
  assert.doesNotMatch(join, /--site-/);
  // The faces it names are the ones the stylesheet already declares.
  assert.match(css, /@font-face \{\s+font-family: 'Young Serif';/);
  assert.match(css, /@font-face \{\s+font-family: 'Geist';/);
});
