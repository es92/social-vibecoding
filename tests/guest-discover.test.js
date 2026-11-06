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

test('every card opens its project\'s page, no card is locked, and each project is one card: featured first, then the most active (One Home, #6361)', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  // The signed-out Home's Communities: one list, what an admin featured (in
  // its order) first, then the rest by people active. No Featured lane.
  assert.deepEqual([...html.matchAll(/data-guest-featured="([^"]+)"/g)].map((m) => m[1]), []);
  assert.deepEqual([...html.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]), ['todo-list', 'game-corner', 'fresh-one']);
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
  assert.deepEqual(text(quiet).slice(1), ['Quiet', message('home:join.pin'), message('home:join.button')],
    'the letter tile, then the name, then Home\'s Pin and Join (One Home, #6361)');
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

test('a card\'s only buttons are Pin and Join, under its words: Try it is the project page\'s, and a waitlisted account still sees every project (One Home, #6361)', () => {
  const html = renderComponent(DISCOVER, 'GuestDiscover', discoverProps());
  assert.doesNotMatch(html, /data-guest-try=/);
  assert.doesNotMatch(html, /<button[^>]*>Try it/);
  for (const slug of ['todo-list', 'game-corner', 'fresh-one']) {
    const card = cardOf(html, slug);
    const buttons = [...card.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.equal(buttons.length, 2, `${slug}: two buttons`);
    assert.match(buttons[0], new RegExp(`data-home-pin="${slug}"`));
    assert.match(buttons[0], /aria-pressed="false"/, 'nothing pinned on this device yet');
    assert.match(buttons[1], new RegExp(`data-home-join="${slug}"`));
    // Over the card's stretched link, so they take their own taps.
    assert.match(card, /<span class="relative z-\[2\] mt-2\.5 flex items-center gap-2" data-guest-card-footer="">/);
  }
  // Pin keeps it on this device; Join asks the landing to sign up for it.
  assert.match(read(DISCOVER), /onPin=\{\(app\) => \{ toggleDevicePin\('communities', app\.slug\); \}\}\s*onJoin=\{\(app\) => \{ onIntent\?\.\(\{ kind: 'join', app \}\); \}\}/);
  // A waitlisted account is signed in: every project is still there.
  const signedIn = renderComponent(DISCOVER, 'GuestDiscover', discoverProps({ signedIn: true }));
  assert.deepEqual([...signedIn.matchAll(/<article data-guest-card="([^"]+)"/g)].map((m) => m[1]), ['todo-list', 'game-corner', 'fresh-one']);
  assert.doesNotMatch(signedIn, /data-guest-join=/);
});

// Twenty projects, the even ones (a01, a03, …) open for a visitor.
const MANY = Array.from({ length: 20 }, (_, i) => ({
  slug: `a${String(i + 1).padStart(2, '0')}`, name: `App ${i + 1}`, active_users: 20 - i, member_count: 0,
  created_at: ago(200), requires_login: i % 2 !== 0, guest_ready: false, url: `https://a${i + 1}.example`, contributors: [],
}));

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
  // Discover and the landing's back both use it; the band's picture is its target.
  assert.match(read(PROJECT), /<GuestCover app=\{app\} hero className="aspect-\[16\/10\] min-w-0 flex-\[1_1_420px\] rounded-2xl" \/>/);
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

test('the short story heads Discover: welcome, headline, one line, what an account adds, and one button that says what it does', () => {
  const html = renderComponent(STORY, 'Story', { compact: true, waitlist: true, primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.deepEqual(text(html), [
    'Welcome to Homeroom',
    'On Homeroom, communities make apps together.',
    message('auth:guest.hero.line'),
    message('auth:guest.join.vote.title'),
    message('auth:guest.join.vote.body'),
    message('auth:guest.join.ask.title'),
    message('auth:guest.join.ask.body'),
    message('auth:guest.join.make.title'),
    message('auth:guest.join.make.body'),
    message('auth:guest.hero.joinWaitlist'),
  ]);
  // The three points, between the line and the button: each title, and its
  // line from md only, so a phone keeps the apps near the first screen.
  assert.ok(html.indexOf('data-landing-story-points') < html.indexOf('data-landing-story-join'));
  assert.equal([...html.matchAll(/<li /g)].length, 3);
  assert.equal([...html.matchAll(/class="hidden text-\[13px\] leading-\[18px\] text-zinc-500 md:block dark:text-zinc-400"/g)].length, 3);
  assert.match(html, /<ul data-landing-story-points="" class="mt-5 grid w-full grid-cols-3 gap-3 md:max-w-\[820px\] md:gap-6">/);
  assert.equal(message('auth:guest.hero.joinWaitlist'), 'Join the waitlist');
  // Once new accounts no longer wait, the same button says Sign up.
  const open = renderComponent(STORY, 'Story', { compact: true, primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.ok(text(open).includes(message('auth:guest.hero.signUp')));
  assert.ok(!text(open).includes(message('auth:guest.hero.joinWaitlist')));
  assert.match(html, /data-landing-story="" data-landing-story-compact=""/);
  // One Sign in on the page, the bar's: no Continue and no Sign in line of
  // its own under the short story.
  assert.doesNotMatch(html, /data-landing-story-start|data-landing-story-how|data-landing-story-signin/);
  // On the page itself, no card, and short: the words, then a small picture
  // beside them from md only.
  assert.doesNotMatch(html, /rounded-\[20px\]|bg-white/);
  assert.match(html, /class="hidden md:block h-auto w-\[200px\] shrink-0"/);
  assert.ok(html.indexOf('<h1') < html.lastIndexOf('/brand/people.png'), 'the words first, the picture after');
  // One thing to press in it, a filled button sized to its words, which
  // opens the story's sheet; still no Sign in of its own (the bar's).
  assert.deepEqual([...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]), ['<button type="button" data-landing-story-join="" class="pill mt-5 h-11 w-auto px-5 text-[15px]">']);
  assert.doesNotMatch(html, /<a\s/);
  assert.doesNotMatch(read(LANDING), /data-landing-story-sign-up/);
  // The landing says it from the one switch, and the button notes itself as
  // the way in (features/auth/sign-up-from.ts).
  assert.match(read(LANDING), /<Story\s+compact\s+primaryClass=\{PRIMARY_PILL\}\s+welcomeEmail=\{releaseEmail\}\s+waitlist=\{NEW_ACCOUNTS_WAIT\}/);
  assert.doesNotMatch(read(LANDING), /<GuestDiscover[^>]*\bwaitlist=/, 'the card that read it is gone');
  assert.match(read(STORY), /onClick=\{\(\) => \{ noteSignUpFrom\('hero'\); onStart\(\); \}\}/);
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
  assert.match(src, /const to = appDiscover && !guestProject \? '#landing' : '#apps';/);
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
  assert.match(src, /title=\{intentTitle\(intent, \(id, params\) => t\(id, params\)\)\}/);
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
  // The bar's Sign in and Sign up, and one button in the short story: its
  // join button, and nothing else to press there.
  const one = manifest.tests.find((t) => /^Landing has Sign in and Sign up in its bar, and one button to make an account under the story/.test(t.name));
  assert.ok(one);
  assert.match(one.expectSelector, /:has\(#landing-header button\[data-landing-sign-up\]\):has\(\[data-landing-story\] button\[data-landing-story-join\]\):not\(:has\(\[data-landing-story\] a\)\) #landing-header \[data-landing-sign-in\]:not\(\.hidden\)$/);
  // Its one other button is pinned by the story's own test above, under the
  // runner's 256-character cap on a selector.
  assert.ok(one.expectSelector.length <= 256);
});
