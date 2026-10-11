'use strict';

// A vote swiped past in Needs you is SEEN, and the badges stop counting it
// (#3526).
//
// Every number that says how many votes wait on you (a project's Needs you
// tab and hub card, the Communities tab and its switcher, the Communities
// list and its Needs you row, the app menu's Workshop row) used to count
// every vote owed, so a feed swiped all the way through still said 12. Now a
// vote moved on from unanswered is remembered on the device
// (frontend/src/features/workshop/needs-seen.ts) and left out of all of them,
// while it stays in the feed, votable. A new vote, or a change rewritten
// since (a new approval epoch), counts again.
//
// The record and the arithmetic are EXECUTED (tests/lib/render-tsx.js
// `loadTsx`); the surfaces that read it are rendered against the same
// instance through `stubs`; the server's half, which names the votes behind
// each count, is pinned from source and against the demo feed's own keys
// (its query is run against Postgres in tests/communities-postgres.test.js).
//
// Run with: node --test tests/needs-seen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SEEN_SRC = 'frontend/src/features/workshop/needs-seen.ts';

/** A browser's worth of window for the record: an account and a storage. */
function fakeWindow(userId) {
  const store = new Map();
  const win = {
    App: { user: { id: userId } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    location: { search: '' },
  };
  globalThis.window = win;
  return { win, store };
}

/** A Needs you row, as either feed builds one (app-view.js / needs-reel.tsx). */
const voteRow = (id, title, epoch = 0, kind = 'proposal') => ({
  t: 'card',
  key: `vote:${kind}:${id}`,
  card: { title: { text: title } },
  who: 'ada',
  kind: 'vote',
  askAbout: { kind: kind === 'proposal' ? 'proposal' : 'gov', ref: id },
  yes: kind === 'proposal' ? { label: 'Yes', act: { fn: 'castVote', args: [id, 'yes', epoch] } } : null,
  no: null,
});

test.afterEach(() => { delete globalThis.window; });

// ── The record ─────────────────────────────────────────────────────────

test('a vote is remembered by its kind, id and, for a change, its approval epoch', () => {
  const seen = loadTsx(SEEN_SRC);
  assert.equal(seen.needsKey('proposal', 12, 3), 'proposal:12@3');
  assert.equal(seen.needsKey('proposal', 12, null), 'proposal:12');
  assert.equal(seen.needsKey('gov', 4), 'governance:4', 'the ask box\'s `gov` is a governance vote');
  assert.equal(seen.needsKey('governance', 4, 2), 'governance:4', 'a group decision has no epoch');
  // The row's own address and the epoch its Yes carries (castVote's third
  // argument), which both feeds build the same way.
  assert.equal(seen.needsRowKey(voteRow(12, 'Dark mode', 3)), 'proposal:12@3');
  assert.equal(seen.needsRowKey(voteRow(4, 'Rename', 0, 'governance')), 'governance:4');
  assert.equal(seen.needsRowKey({ ...voteRow(1, 'x'), kind: 'claim' }), null, 'an open issue is no vote, and no badge counts it');
  assert.equal(seen.needsRowKey({ ...voteRow(1, 'x'), askAbout: null }), null);
});

test('passed over is seen, per project, until the change moves', () => {
  const { store } = fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  assert.equal(seen.isNeedsSeen('garden', 'proposal:12@3'), false);
  seen.markNeedsSeen('garden', 'proposal:12@3');
  assert.equal(seen.isNeedsSeen('garden', 'proposal:12@3'), true);
  assert.equal(seen.isNeedsSeen('swap', 'proposal:12@3'), false, 'a record per project');
  assert.equal(seen.isNeedsSeen('garden', 'proposal:12@4'), false,
    'rewritten since (a new approval epoch), it counts again, as a vote cast before stops counting');
  assert.equal(seen.isNeedsSeen('garden', 'proposal:12'), true, 'a side with no epoch is decided by the id');
  assert.equal(seen.isNeedsSeen('garden', 'governance:12'), false);
  assert.ok(store.get('needsSeen:v1:7').includes('"proposal:12"'), 'kept on the device, under the account');

  // The counts: every vote owed, less the seen ones among those it names.
  const owed = ['proposal:12@3', 'proposal:13@0', 'governance:4'];
  assert.equal(seen.unseenNeeds('garden', 3, owed), 2);
  assert.equal(seen.unseenNeeds('garden', 3, ['proposal:12@4', 'proposal:13@0', 'governance:4']), 3,
    'the rewritten change is news again');
  assert.equal(seen.unseenNeeds('garden', 3, null), 3, 'a number with no list is never lowered on a guess');
  assert.equal(seen.unseenNeeds('garden', 3, []), 3);
  assert.equal(seen.unseenNeeds('garden', 0, owed), 0, 'and never below zero');
});

test('the record is the account\'s, survives a reload, and forgets what is old', () => {
  const { win, store } = fakeWindow(7);
  let seen = loadTsx(SEEN_SRC);
  seen.markNeedsSeen('garden', 'proposal:1@0');
  // Somebody else on the same device.
  win.App.user.id = 8;
  seen.hydrateNeedsSeen();
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), false, 'their badge is theirs');
  win.App.user.id = 7;
  seen.hydrateNeedsSeen();
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), true);
  // A cold load reads it back after the first paint.
  seen = loadTsx(SEEN_SRC);
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), false, 'nothing is read before hydration (the island rule)');
  seen.hydrateNeedsSeen();
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), true);
  // An entry past its age is dropped when the record is read.
  const old = Date.now() - seen.NEEDS_SEEN_TTL_MS - 1000;
  store.set('needsSeen:v1:7', JSON.stringify({ garden: { 'proposal:1': { e: 0, t: old }, 'proposal:2': { e: 0, t: Date.now() } } }));
  seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), false);
  assert.equal(seen.isNeedsSeen('garden', 'proposal:2@0'), true);
});

test('a storage that refuses is a count that is not lowered for long, never an error', () => {
  const { win } = fakeWindow(7);
  win.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };
  const seen = loadTsx(SEEN_SRC);
  assert.doesNotThrow(() => seen.hydrateNeedsSeen());
  assert.doesNotThrow(() => seen.markNeedsSeen('garden', 'proposal:1@0'));
  assert.equal(seen.isNeedsSeen('garden', 'proposal:1@0'), true, 'seen for this page, at least');
  // Signed out: nothing to key a record by, so nothing is kept.
  delete win.App.user;
  const anon = loadTsx(SEEN_SRC);
  anon.markNeedsSeen('garden', 'proposal:1@0');
  assert.equal(anon.isNeedsSeen('garden', 'proposal:1@0'), false);
});

// ── The feed marks, the page counts ────────────────────────────────────

test('the feed marks the vote you move on from, forward and unanswered only', () => {
  const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const land = /const landOn = \(idx: number\) => \{([\s\S]*?)\n {2}\};/.exec(WORKSHOP);
  assert.ok(land, 'landOn, where a swipe, a key and an arrow all arrive');
  assert.match(land[1], /if \(c > i && row && !answered\[row\.key\] && !sendingRef\.current\.has\(row\.key\)\) \{\s*markNeedsSeen\(rowSlug\(row, slug\), needsRowKey\(row\)\);\s*\}/,
    'the row you were on, going forward, not answered here and no vote of yours on its way');
  // The band's count and the one the Communities tab works out are the
  // unseen votes, from the same keys.
  assert.match(WORKSHOP, /const owed = unseenNeeds\(v\.slug \|\| '', owedRows\.length, owedKeys\);/);
  assert.match(WORKSHOP, /describeCommunity\(v\.slug, \{\s*owedCount: owedRows\.length,\s*owed: owedKeys,/);
  assert.match(WORKSHOP, /<ForYouCard\s+slug=\{slug\}[\s\S]{0,80}queue=\{v\.queue\}/);
  // Nothing else in the feed moves: the order stays the one published.
  assert.match(WORKSHOP, /const live = rows\.filter\(\(r\): r is QueueRow => r\.t === 'card'\);/);
});

test('the hub\'s Needs you counts what you have not seen, and stays a door to the rest', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  const { ForYouCard } = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx', {
    stubs: { '../../workshop/needs-seen': seen },
  });
  const queue = [voteRow(1, 'Dark mode'), voteRow(2, 'Tags'), voteRow(3, 'Export')];
  const html = () => renderToHtml(createElement(ForYouCard, {
    queue, slug: 'garden', name: 'Garden', mine: null, workEmpty: null, alone: false, data: null, canPost: true,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {},
  }));
  assert.match(html(), /data-ws-hub-needs-votes="3"[\s\S]*3 to vote/);
  seen.markNeedsSeen('garden', 'proposal:1@0');
  const one = html();
  assert.match(one, /data-ws-hub-needs-votes="2"/);
  assert.match(one, /<span class="dev-ws-foryou-pill">2 to vote<\/span>/);
  assert.match(one, /<span data-ws-hub-needs-first="">Tags, and 1 more<\/span>/, 'the first vote you have not seen leads');
  seen.markNeedsSeen('garden', 'proposal:2@0');
  seen.markNeedsSeen('garden', 'proposal:3@0');
  const all = html();
  assert.doesNotMatch(all, /to vote/, 'nothing new: no number to act on');
  assert.match(all, /data-ws-hub-needs-open=""/, 'but still the way to the votes you skipped');
  assert.match(all, /data-ws-hub-needs-skipped="">3 votes you skipped are still open</);
});

// ── The feed opens where you left off (#4753) ──────────────────────────

test('firstUnseenIndex: the first vote you have not already passed over', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  const rows = [voteRow(1, 'Dark mode'), voteRow(2, 'Tags'), voteRow(3, 'Export')];
  const slugOf = () => 'garden';
  assert.equal(seen.firstUnseenIndex([], slugOf), 0, 'an empty feed opens on the first item, as it does today');
  assert.equal(seen.firstUnseenIndex(rows, slugOf), 0, 'nothing seen yet: the first item, as it does today');
  seen.markNeedsSeen('garden', 'proposal:1@0');
  assert.equal(seen.firstUnseenIndex(rows, slugOf), 1, 'the vote you swiped past is not where it opens');
  seen.markNeedsSeen('garden', 'proposal:2@0');
  assert.equal(seen.firstUnseenIndex(rows, slugOf), 2);
  seen.markNeedsSeen('garden', 'proposal:3@0');
  assert.equal(seen.firstUnseenIndex(rows, slugOf), 0, 'every item passed over: the first item, not the end card');
});

test('a change rewritten since it was passed over is not where the feed opens', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  seen.markNeedsSeen('garden', 'proposal:1@3');
  assert.equal(seen.firstUnseenIndex([voteRow(1, 'Old words', 3)], () => 'garden'), 0,
    'seen at this very epoch, there is nothing earlier to stop at: index 0 is the first item either way');
  const rows = [voteRow(1, 'New words', 4), voteRow(2, 'Fresh', 0)];
  assert.equal(seen.firstUnseenIndex(rows, () => 'garden'), 0, 'the rewritten change counts as unseen, so the feed can open on it');
});

test('a row that is not a vote is never recorded as passed over, so the scan stops at it', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  const rows = [
    voteRow(1, 'Dark mode'),
    { ...voteRow(2, 'An open issue'), kind: 'claim', yes: null, askAbout: { kind: 'issue', ref: 5 } },
    voteRow(3, 'Export'),
  ];
  seen.markNeedsSeen('garden', 'proposal:1@0');
  assert.equal(seen.firstUnseenIndex(rows, () => 'garden'), 1, 'the non-vote row counts as not seen');
});

test('the Communities reel: each row is checked against its own project', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  seen.hydrateNeedsSeen();
  const app = (slug) => ({ slug, name: slug, icon_url: null, icon_emoji: null });
  const rows = [
    { ...voteRow(1, 'Garden vote'), app: app('garden') },
    { ...voteRow(1, 'Swap vote, same id, another project'), app: app('swap') },
  ];
  seen.markNeedsSeen('garden', 'proposal:1@0');
  assert.equal(seen.firstUnseenIndex(rows, (r) => (r.app && r.app.slug) || ''), 1,
    'the garden vote is seen, the swap one is not, though they share an id');
});

test('NeedsFeed opens on the first unseen item, and only when no other open is owed (#4753)', () => {
  const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  // The record is read in an effect, not the render (the island rule): the
  // seed stays the end card's count or 0.
  assert.match(WORKSHOP, /const \[at, setAt\] = useState\(\(\) => \(endOnOpen \? rows\.filter\(\(r\) => r\.t === 'card'\)\.length : 0\)\);/,
    'the seed never reads the record');
  assert.match(WORKSHOP, /const resumeRef = useRef<boolean>\(!endOnOpen && !approveOpenRef\.current && !openOn\);/,
    'resume only when no other open is owed: no end card, no shot target, no New for you row');
  const resume = /useLayoutEffect\(\(\) => \{\s*const el = scrollRef\.current;\s*if \(!resumeRef\.current \|\| !el \|\| !el\.clientHeight \|\| !items\.length\) return;\s*resumeRef\.current = false;\s*const idx = firstUnseenIndex\(items, \(r\) => rowSlug\(r, slug\)\);([\s\S]*?)\n {2}\}, \[items\]\);/.exec(WORKSHOP);
  assert.ok(resume, 'the resume open: once, on the first publish that has rows and a laid-out scroller');
  assert.match(resume[1], /if \(idx <= 0\) return;/, 'the first unseen item is the first item: nothing to move for');
  assert.match(resume[1], /curKeyRef\.current = items\[idx\]\.key;\s*setAt\(idx\);\s*el\.style\.scrollBehavior = 'auto';\s*el\.scrollTop = idx \* el\.clientHeight;\s*el\.style\.scrollBehavior = '';/,
    'instantly, the way the opens above land, and the re-sync then follows the row by key');
  assert.doesNotMatch(resume[1], /landOn|markNeedsSeen/, 'the jump passes nothing new over: the rows were already seen');
  assert.match(WORKSHOP, /import \{ firstUnseenIndex, markNeedsSeen, needsRowKey, unseenNeeds, useNeedsSeen \} from '\.\.\/\.\.\/workshop\/needs-seen';/);
});

// ── The Communities tab, its switcher and its list ─────────────────────

test('the Communities tab\'s count drops as votes are swiped past anywhere', () => {
  fakeWindow(7);
  const seen = loadTsx(SEEN_SRC);
  const scope = loadTsx('frontend/src/features/workshop/community-scope.ts', {
    stubs: { './needs-seen': seen },
  });
  seen.hydrateNeedsSeen();
  scope.communityScopeStore.set({ list: ['garden', 'swap'], totalNeeds: 0 });
  scope.describe('garden', { owedCount: 2, owed: ['proposal:1@0', 'proposal:2@0'] });
  scope.describe('swap', { owedCount: 1, owed: ['governance:9'] });
  const st = () => scope.communityScopeStore.get();
  assert.equal(st().info.garden.needs, 2);
  assert.equal(st().totalNeeds, 3);
  // A swipe in either Needs you feed: the badge follows at once.
  seen.markNeedsSeen('garden', 'proposal:1@0');
  assert.equal(st().info.garden.needs, 1);
  assert.equal(st().totalNeeds, 2);
  seen.markNeedsSeen('swap', 'governance:9');
  assert.equal(st().info.swap.needs, 0);
  assert.equal(st().totalNeeds, 1);
  // A new vote on a project counts, whatever was seen there before.
  scope.describe('swap', { owedCount: 2, owed: ['governance:9', 'governance:10'] });
  assert.equal(st().info.swap.needs, 1);
  // The server's counts carry the list; the scope keeps it beside the number.
  const SRC = read('frontend/src/features/workshop/community-scope.ts');
  assert.match(SRC, /owedCount: Number\(counts\[r\.slug\]\?\.needs\) \|\| 0,\s*owed: Array\.isArray\(owed\) \? owed\.map\(String\) : undefined,/);
});

test('the Communities list and its Needs you row leave out what you skipped, and keep the door', () => {
  const seen = loadTsx(SEEN_SRC);
  // Loaded before the window exists, as the screen's own tests load it: its
  // imports bind browser listeners when there is one.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx', { stubs: { './needs-seen': seen } });
  fakeWindow(7);
  seen.hydrateNeedsSeen();
  const rows = mod.joinCounts([{ slug: 'garden', name: 'Garden' }, { slug: 'swap', name: 'Swap' }], {
    garden: { working: 0, needs: 2, owed: ['proposal:1@0', 'proposal:2@0'] },
    swap: { working: 0, needs: 1, owed: ['governance:9'] },
  });
  assert.deepEqual(rows[0].owed, ['proposal:1@0', 'proposal:2@0'], 'the counts say which votes, and the row keeps them');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));
  mod.workshopStore.set({ open: true, error: false, tab: 'status', rows, feed: null, feedError: false, feedCapped: false });
  assert.match(html(), /3 votes waiting on you/);
  seen.markNeedsSeen('garden', 'proposal:1@0');
  seen.markNeedsSeen('garden', 'proposal:2@0');
  let out = html();
  assert.match(out, /1 vote waiting on you/);
  assert.match(out, /data-workshop-needs-door=""[\s\S]*?>Swap</, 'naming only the projects with something new');
  seen.markNeedsSeen('swap', 'governance:9');
  out = html();
  assert.match(out, /data-workshop-needs-door=""/, 'the only door to the feed on this screen stays');
  assert.match(out, /3 votes you skipped/);
  assert.match(out, /Garden, Swap/);
  assert.equal(mod.unseenRow({ slug: 'garden', name: 'Garden', working: 0, needs: 2, owed: ['proposal:1@0', 'proposal:2@0'] }).needs, 0);
  mod.workshopStore.set({ open: false, rows: null });
});

test('the app menu\'s "to vote" is the same number', () => {
  const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(SHEET, /unseenNeeds\(slug, c\.needs, Array\.isArray\(c\.owed\) \? c\.owed : null\)/);
});

// ── The server names the votes behind each count ───────────────────────

test('GET /api/workshop/counts says which votes `needs` counts, in the record\'s keys', () => {
  const route = require('../src/routes/workshop-overview');
  const cte = (name) => new RegExp(`${name} AS \\(([\\s\\S]*?)\\n  \\)`).exec(route.COUNTS_SQL)[1];
  assert.match(cte('owed_proposals'), /array_agg\('proposal:' \|\| cs\.id \|\| '@' \|\| cs\.approval_epoch\) AS keys/);
  assert.match(cte('owed_governance'), /array_agg\('governance:' \|\| i\.id\) AS keys/);
  assert.match(route.COUNTS_SQL, /\(COALESCE\(op\.keys, '\{\}'::text\[\]\) \|\| COALESCE\(og\.keys, '\{\}'::text\[\]\)\) AS owed/);
  assert.match(read('src/routes/workshop-overview.js'), /owed: Array\.isArray\(row\.owed\) \? row\.owed\.map\(String\) : \[\],/);

  // The demo's counts name the demo feed's cards, by the keys the client
  // builds from those cards, so a swipe in the preview lowers the preview's
  // numbers as a real one does.
  const seen = loadTsx(SEEN_SRC);
  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const keysOf = (slug) => reel.reelRows(route.DEMO_NEEDS_FEED.filter((it) => it.app.slug === slug)).map(seen.needsRowKey);
  for (const slug of new Set(route.DEMO_NEEDS_FEED.map((it) => it.app.slug))) {
    assert.deepEqual(route.DEMO_COUNTS[slug].owed, keysOf(slug), slug);
  }
  const slug = 'staging-demo-your-app';
  assert.equal(route.DEMO_COUNTS[slug].needs, keysOf(slug).length);
});
