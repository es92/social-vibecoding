'use strict';
// test:changed: when public/js/app-view.js (the client's "waits on your vote" predicate, loaded through lib/app-view-vm.js)

// A project's "Needs you" count and its Needs you page agree: the count
// appears when the vote does.
//
// A tester saw "1" beside Needs you in a project's menu and "Needs you · 1 to
// vote" on its Hub while the Needs you page said nothing was waiting, for two
// to three minutes, and had to leave and come back before the vote showed.
// The count was worked out on the client from the board's /promoted rows the
// moment a change was promoted; the page (GET /api/workshop/needs-feed) lists
// a change only once its vote is open (work_states.vote_open), and read once.
//
// What this pins:
//   1. THE ROW. /promoted carries `vote_open`, by the feed's own fragment.
//   2. THE COUNT. The client's "this waits on your vote" predicate, which the
//      Needs-you queue, the place's badge, the Hub's For you card and the
//      Communities tab's number are all built from, requires it. The board
//      still lists the change, and a row without the field reads as open.
//   3. THE PAGE. A project's Needs you reads its feed again on a work_state
//      push about that project, quietly, and its run takes in what arrived
//      without dealing a card again.
//   4. THE EMPTY LINE names the project on a project's own page.
//
// tests/needs-count-vote-open-postgres.test.js runs the row, the predicate
// and the feed together against a real database.
//
// Run with: node --test tests/needs-count-vote-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { APP_VIEW_SRC, loadAppView, plain } = require('./lib/app-view-vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

const VOTES_JS = read('src/routes/votes.js');
const FLOW_SRC = read('frontend/src/features/review-flow/review-flow.tsx');
const WORKSHOP_TSX = read('frontend/src/features/dev-board/workshop/workshop.tsx');

// ── 1. The row ──────────────────────────────────────────────────────────

test('/promoted carries vote_open by the Needs you feed\'s own fragment', () => {
  const overview = require('../src/routes/workshop-overview');
  const route = VOTES_JS.slice(
    VOTES_JS.indexOf("router.get('/api/apps/:slug/promoted'"),
    VOTES_JS.indexOf("router.get('/api/apps/:slug/merged'"));
  assert.match(route, /const voteOpenSql = require\('\.\/workshop-overview'\)\.VOTE_OPEN_SQL;/,
    'the fragment is the feed\'s, spelled once');
  assert.match(route, /\$\{voteOpenSql\('cs'\)\} AS vote_open,/, 'selected on every row');
  assert.match(overview.VOTE_OPEN_SQL('cs'), /FROM work_states wso[\s\S]*wso\.item_kind = 'change' AND wso\.item_ref = cs\.id AND wso\.vote_open/,
    'the stored work state\'s answer');
  assert.ok(overview.OWED_PROPOSALS_WHERE.includes(overview.VOTE_OPEN_SQL('cs')),
    'and the feed and the counts list a change by the same fragment');
  // The board is not narrowed by it: a change still being checked is listed.
  assert.match(route, /WHERE cs\.app_id = \$1 AND cs\.status IN \('promoted', 'merging'\)\s+ORDER BY cs\.created_at DESC/);
});

// ── 2. The count ────────────────────────────────────────────────────────

const change = (over = {}) => ({
  id: 34, pr_number: 41, pr_title: 'Persist the theme', status: 'promoted', username: 'carol',
  created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
  votes_for: 0, votes_against: 0, yes_count: 0, no_count: 0, ...over,
});

function seed(AppView, proposals) {
  AppView._ghIssues = [];
  AppView._proposals = proposals;
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._devDataReady = true;
}

test('a promoted, unvoted change waits on your vote only once its vote is open', () => {
  const AppView = loadAppView();
  const owed = (row) => AppView._devCardMatches('proposal', row, { needsVote: true });
  assert.equal(owed(change({ vote_open: false })), false, 'still being checked: not owed yet');
  assert.equal(owed(change({ vote_open: true })), true, 'its vote is open: owed');
  assert.equal(owed(change()), true, 'a row without the field (an older saved copy, a demo row) reads as open');
  assert.equal(owed(change({ vote_open: true, my_vote: 'yes' })), false, 'voted on: not owed');
  assert.equal(owed(change({ vote_open: true, votes_in: true })), false, '#6594: its votes are in');
  assert.equal(owed(change({ vote_open: true, first_version: true })), false, 'D1: a first version has no vote');
});

test('the Needs-you queue and its count leave out a change still being checked; the board still lists it', () => {
  const AppView = loadAppView();
  seed(AppView, [
    change({ id: 34, pr_number: 41, vote_open: true }),
    change({ id: 35, pr_number: 42, pr_title: 'Still being checked', vote_open: false, check_state: 'pending' }),
  ]);
  const view = AppView._workshopView();
  // What the place's badge, the Hub's For you card and the Communities tab
  // count: the queue's vote rows (workshop.tsx owedRows).
  assert.deepEqual(plain(view.queue).filter((r) => r.kind === 'vote').map((r) => r.card.key), ['proposal:34']);
  // The board keeps both, each with its own status.
  const buckets = AppView._bucketDevItems({
    issues: [], proposals: AppView._proposals, gov: [], merged: [], mySessions: [], sharedSessions: [],
  });
  assert.deepEqual(plain(buckets.inReview).map((x) => x.item.id).sort(), [34, 35]);

  // Its vote opens (the work_state push re-reads the board): now it is owed.
  AppView._proposals[1].vote_open = true;
  assert.deepEqual(
    plain(AppView._workshopView().queue).filter((r) => r.kind === 'vote').map((r) => r.card.key).sort(),
    ['proposal:34', 'proposal:35']);
});

test('the badge, the Hub card and the Communities tab are all the queue\'s vote rows', () => {
  assert.match(APP_VIEW_SRC, /for \(const x of buckets\.inReview\) \{\s+if \(AppView\._devCardMatches\(x\.kind, x\.item, \{ needsVote: true \}\)\) owed\.push\(x\);/,
    'the queue is the board\'s rows that pass the predicate');
  assert.match(APP_VIEW_SRC, /&& it\.vote_open !== false\)\) return false;/, 'which reads vote_open, open when absent');
  assert.match(WORKSHOP_TSX, /const owedRows = \(v\.queue \|\| \[\]\)\.filter\(\(row\) => row\.kind === 'vote'\);/);
  assert.match(WORKSHOP_TSX, /owedCount: owedRows\.length,/, 'what the Communities tab learns');
  assert.match(WORKSHOP_TSX, /publishPlace\(v\.slug, tab, owed, unreadElsewhere, trayOpen\)/, 'the place\'s badge');
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(hub, /const votes = queue\.filter\(\(row\) => row\.kind === 'vote'\);/, 'the Hub\'s For you row');
});

// ── 3. The page ─────────────────────────────────────────────────────────

const push = (over = {}) => ({
  type: 'work_state', appId: 7, appSlug: 'garden',
  item: { kind: 'change', ref: 41, issueNumber: null, sessionId: 41 },
  state: { stage: 'up_for_vote', change: { id: 41, voteOpen: true } },
  ...over,
});

test('a work_state push is about a project by its slug; one that names none could be about any', () => {
  const { pushIsFor } = loadTsx('frontend/src/lib/work-state.ts');
  assert.equal(pushIsFor(push(), 'garden'), true);
  assert.equal(pushIsFor(push({ appSlug: 'other' }), 'garden'), false);
  assert.equal(pushIsFor(push({ appSlug: null }), 'garden'), true);
  assert.equal(pushIsFor({ type: 'homeroom_bot_work_changed', appSlug: 'garden' }, 'garden'), false, 'only a work_state push');
  assert.equal(pushIsFor(undefined, 'garden'), false, 'the bare window event carries none');
});

test('the run grows at its end, and never deals a card it already holds', () => {
  const { growRun } = loadTsx('frontend/src/features/review-flow/model.ts');
  const run = [{ key: 'proposal:1', kind: 'proposal' }, { key: 'governance:9', kind: 'governance' }];
  const same = growRun(run, [{ key: 'proposal:1', kind: 'proposal', title: 'read again' }]);
  assert.equal(same, run, 'nothing new: the same run, so nothing re-renders');
  const grown = growRun(run, [{ key: 'proposal:2', kind: 'proposal' }, { key: 'proposal:1', kind: 'proposal', title: 'read again' }]);
  assert.deepEqual(grown.map((it) => it.key), ['proposal:1', 'governance:9', 'proposal:2']);
  assert.equal(grown[0], run[0], 'what it held keeps its own copy: the card on show does not move');
  // A card voted on (it left the feed) or skipped (still in it) stays in the
  // run by its key, so a later read cannot add it a second time.
  assert.equal(growRun(grown, []), grown);
  assert.equal(growRun(grown, [{ key: 'proposal:2', kind: 'proposal' }]), grown);
});

test('a project\'s Needs you reads again on a push about it, quietly, and stops when it goes', async (t) => {
  const flow = loadTsx('frontend/src/features/review-flow/review-flow.tsx');
  const { GAP_MS } = loadTsx('frontend/src/features/ai/live.ts');
  const { WORK_CHANGED_EVENT } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const kept = { window: globalThis.window, document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const asked = [];
  let answer = { ok: true, items: [] };
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = { search: '' };
  globalThis.fetch = async (url, init) => {
    asked.push({ url, init });
    const now = answer;
    return { ok: now.ok, status: now.ok ? 200 : 503, json: async () => ({ items: now.items }) };
  };
  t.after(() => {
    for (const [key, value] of Object.entries(kept)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const say = (detail) => win.dispatchEvent(new CustomEvent(WORK_CHANGED_EVENT, { detail }));

  const got = [];
  let failures = 0;
  const stop = flow.watchProjectFeed('garden', { items: (list) => got.push(list.map((it) => it.id)), failed: () => { failures += 1; } });
  await settle();
  assert.equal(asked.length, 1, 'read as it opens');
  assert.equal(asked[0].url, '/api/workshop/needs-feed');
  assert.deepEqual(asked[0].init, { cache: 'no-cache', credentials: 'same-origin' }, 'the current answer, not a saved copy');
  assert.deepEqual(got, [[]], 'nothing is waiting yet');

  // Another project's change moved, and the bot's own "work changed" (no
  // push): neither asks for this project's feed.
  say(push({ appSlug: 'other' }));
  say(undefined);
  t.mock.timers.tick(GAP_MS * 2);
  await settle();
  assert.equal(asked.length, 1);

  // This project's change is open for votes now: a burst of pushes is one read.
  answer = { ok: true, items: [
    { kind: 'proposal', id: 41, app: { slug: 'garden' } },
    { kind: 'proposal', id: 77, app: { slug: 'other' } },
  ] };
  say(push());
  say(push({ item: { kind: 'request', ref: 12, issueNumber: 12, sessionId: 41 } }));
  t.mock.timers.tick(GAP_MS);
  await settle();
  assert.equal(asked.length, 2, 'one read for the burst');
  assert.deepEqual(got, [[], [41]], 'the vote is listed without leaving the page, this project\'s alone');

  // A later read that fails says nothing: the page keeps what it has.
  answer = { ok: false, items: [] };
  t.mock.timers.tick(GAP_MS * 2);
  say(push());
  t.mock.timers.tick(GAP_MS);
  await settle();
  assert.equal(asked.length, 3);
  assert.equal(failures, 0, 'no error over a page that has its feed');
  assert.deepEqual(got, [[], [41]]);

  stop();
  t.mock.timers.tick(GAP_MS * 2);
  say(push());
  t.mock.timers.tick(GAP_MS * 2);
  await settle();
  assert.equal(asked.length, 3, 'gone with the page');
});

test('the first read failing is the page\'s error; a later one landing clears it', () => {
  assert.match(FLOW_SRC, /\.catch\(\(\) => \{ if \(live && mine === asked && !landed\) sink\.failed\(\); \}\);/);
  assert.match(FLOW_SRC, /items: \(list\) => \{ setFeed\(\{ slug, items: list \}\); setFailed\(null\); \},/);
  assert.match(FLOW_SRC, /if \(!live \|\| mine !== asked\) return;/, 'an answer a newer read overtook is dropped');
  // Nothing is cleared before a later read lands, so the page never goes
  // back to its loading frame.
  const watcher = FLOW_SRC.slice(FLOW_SRC.indexOf('export function watchProjectFeed('), FLOW_SRC.indexOf('export function ProjectReviewFlow('));
  assert.doesNotMatch(watcher, /sink\.items\(null\)|setFeed\(null\)/);
  // The gaps a push can fall into are the live reads' (lib/live-reads.ts).
  assert.match(watcher, /const unwatch = watch\(reads\.ask, \{ reads: isNeedsFeedRead \}\);/);
  const { isNeedsFeedRead } = loadTsx('frontend/src/features/review-flow/review-flow.tsx');
  assert.equal(isNeedsFeedRead(new URL('http://x/api/workshop/needs-feed')), true);
  assert.equal(isNeedsFeedRead(new URL('http://x/api/workshop/needs-feed?in=threads')), false, 'the Homeroom bot tab\'s read is its own');
});

test('a later read: the change on show stays; with nothing on show the page opens on what arrived', () => {
  const { takeRead } = loadTsx('frontend/src/features/review-flow/model.ts');
  const p = (n) => ({ key: `proposal:${n}`, kind: 'proposal' });
  const gov = { key: 'governance:9', kind: 'governance' };
  const standing = (over = {}) => ({ list: [], index: 0, done: false, votes: {}, skipped: {}, ...over });

  // Nothing new: the very same run back, so the page does not re-render.
  const held = [p(1)];
  assert.deepEqual(takeRead(standing({ list: held }), [p(1)]), { list: held, open: null });
  assert.equal(takeRead(standing({ list: held }), []).list, held, 'a card that left the feed (you voted) stays in the run');

  // The tester's case: the page said nothing was waiting, then the vote opened.
  assert.deepEqual(plain(takeRead(standing(), [p(41)])), { list: [p(41)], open: 0 });
  // Only pages decided elsewhere were listed (#6344): the change opens.
  assert.deepEqual(plain(takeRead(standing({ list: [gov] }), [p(41), gov])), { list: [gov, p(41)], open: 1 });

  // A change is on show: it does not move, and Next reaches the arrival.
  const reading = takeRead(standing({ list: [p(1), p(2)], index: 1, votes: { 'proposal:1': 'yes' } }), [p(2), p(3)]);
  assert.deepEqual(plain(reading), { list: [p(1), p(2), p(3)], open: null });

  // The end, everything voted on: the page opens on the one that arrived,
  // never on one already voted on, though the read no longer lists those.
  const finished = standing({ list: [p(1), p(2)], index: 1, done: true, votes: { 'proposal:1': 'yes', 'proposal:2': 'no' } });
  assert.deepEqual(plain(takeRead(finished, [p(3)])), { list: [p(1), p(2), p(3)], open: 2 });

  // The end, with a skipped change waiting: the skipped one is still in the
  // feed and is not dealt a second time; the page opens on the arrival.
  const skippedEnd = standing({ list: [p(1), p(2)], index: 1, done: true, votes: { 'proposal:1': 'yes' }, skipped: { 'proposal:2': true } });
  assert.equal(takeRead(skippedEnd, [p(2)]).list, skippedEnd.list, 'the skipped change read again adds nothing');
  assert.deepEqual(plain(takeRead(skippedEnd, [p(2), p(3)])), { list: [p(1), p(2), p(3)], open: 2 });

  // Under a vote-type chip, places count in the run the chip leaves; an
  // arrival the chip hides opens nothing.
  const onlyOdd = (list) => list.filter((it) => it.kind === 'governance' || Number(it.key.split(':')[1]) % 2 === 1);
  const chip = standing({ list: [p(1)], index: 0, done: true, votes: { 'proposal:1': 'yes' } });
  assert.deepEqual(plain(takeRead(chip, [p(2)], onlyOdd)), { list: [p(1), p(2)], open: null });
  assert.deepEqual(plain(takeRead(chip, [p(2), p(3)], onlyOdd)), { list: [p(1), p(2), p(3)], open: 1 });
});

test('only a project\'s own run grows', () => {
  const project = FLOW_SRC.slice(FLOW_SRC.indexOf('export function ProjectReviewFlow('));
  assert.match(project, /useEffect\(\(\) => watchProjectFeed\(slug, \{/);
  assert.match(project, /\s+grows\n/, 'the project\'s flow takes in later reads');
  assert.match(FLOW_SRC, /header = 'communities', project, grows = false \}/, 'Needs you\'s own run stays what its first read held');
  assert.match(FLOW_SRC, /if \(!grows\) return;\s+const took = takeRead\(\{ list, index, done, votes, skipped \}, shaped, \(all\) => filterByVoteType\(all, filter, voteTypeOf\)\);\s+if \(took\.list === list\) return;\s+setList\(took\.list\);/);
  assert.match(FLOW_SRC, /if \(took\.open == null\) return;\s+setSheet\('ask'\);\s+setIndex\(took\.open\);\s+setDone\(false\);/);
});

// ── 4. The empty line ───────────────────────────────────────────────────

test('a project\'s own page says nothing waits in that project; Needs you speaks for every project', () => {
  const flow = loadTsx('frontend/src/features/review-flow/review-flow.tsx');
  const html = (props) => renderToHtml(createElement(flow.ReviewFlow, {
    items: [], error: false, capped: false, onDone: () => {}, ...props,
  }));
  assert.equal(message('communities:reel.emptyProject', { project: 'Garden Club' }), 'Nothing is waiting on your vote in Garden Club.');
  const own = html({ header: 'project', project: 'Garden Club', grows: true });
  assert.match(own, /data-needs-empty=""[^>]*>Nothing is waiting on your vote in Garden Club\.<\/p>/);
  assert.doesNotMatch(own, /in any of your projects/);
  assert.match(html({}), /data-needs-empty=""[^>]*>Nothing is waiting on your vote in any of your projects\.<\/p>/);
  assert.match(WORKSHOP_TSX, /<ProjectReviewFlow slug=\{slug\} onDone=\{\(\) => upTab\('status'\)\} project=\{projectName\} \/>/);
  assert.match(FLOW_SRC, /project=\{project\}\s+grows/);
});
