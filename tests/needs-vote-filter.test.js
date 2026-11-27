'use strict';

// #6199: the vote-type filter above Needs you, and the reopen that keeps a
// vote that decides in view.
//
// The server already marks each item that does not decide the outcome
// (withViewerDecides: `advisory`, `uncounted`) and puts the deciding ones
// first (decidingFirst). These helpers read those marks, narrow the feed and
// count each chip; the chips draw from the same primitive as the All
// communities filter. The executions below cover the helpers and the
// rendered chips; the feed hosts and the experimental run are pinned from
// source where they are held under effects that renderToStaticMarkup does
// not run.
//
// Run with: node --test tests/needs-vote-filter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const filter = loadTsx('frontend/src/features/workshop/vote-filter.tsx');
// The kind is the one model of a change's (voteTypeOf), read the same off a
// feed item, a review item and a Needs you row's Yes.
const { voteTypeOf } = loadTsx('frontend/src/features/dev-board/card/change.ts');
const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');

/** A feed item as GET /api/workshop/needs-feed serves it. */
const item = (over = {}) => ({
  kind: 'proposal', id: 1, title: 'Dark mode', summary: 'Adds a dark theme.',
  author: 'ada', number: 7, epoch: 3, at: null, yes: 1, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
  ...over,
});

// ── The kind ───────────────────────────────────────────────────────────

test('a vote is advisory when the feed marks it so, and decides otherwise', () => {
  assert.equal(voteTypeOf(item()), 'deciding', 'a plain change decides');
  assert.equal(voteTypeOf(item({ advisory: true })), 'advisory');
  assert.equal(voteTypeOf(item({ uncounted: true })), 'advisory', 'a test account\'s vote is grouped with advisory');
  assert.equal(voteTypeOf(item({ kind: 'governance' })), 'deciding', 'a group decision decides');
  assert.equal(voteTypeOf(item({ kind: 'ballot' })), 'deciding', 'a ballot decides');
  assert.equal(voteTypeOf(item({ kind: 'question' })), 'deciding', 'the bot\'s question decides');

  // A Needs you row gives the same answer from the flags on its Yes.
  assert.equal(voteTypeOf({ advisory: true }), 'advisory');
  assert.equal(voteTypeOf({ uncounted: true }), 'advisory');
  assert.equal(voteTypeOf({}), 'deciding');
  assert.equal(voteTypeOf(null), 'deciding', 'a group decision has no Yes and no advisory mark');
  const [row] = reel.reelRows([item({ advisory: true })]);
  assert.equal(voteTypeOf(row.yes), 'advisory', 'the row\'s Yes carries the feed\'s mark');
});

test('filterByVoteType keeps the feed\'s order and returns the same list on All', () => {
  const list = [
    item({ id: 1 }),
    item({ id: 2, advisory: true }),
    item({ id: 3, kind: 'governance' }),
    item({ id: 4, uncounted: true }),
  ];
  assert.equal(filter.filterByVoteType(list, 'all', voteTypeOf), list, 'All copies nothing');
  assert.deepEqual(filter.filterByVoteType(list, 'deciding', voteTypeOf).map((it) => it.id), [1, 3]);
  assert.deepEqual(filter.filterByVoteType(list, 'advisory', voteTypeOf).map((it) => it.id), [2, 4]);
  assert.deepEqual(filter.voteTallies(list, voteTypeOf), { all: 4, deciding: 2, advisory: 2 });
});

// ── The chips ──────────────────────────────────────────────────────────

const noop = () => {};

test('the chips are All, Votes that decide and Advisory, their counts beside them', () => {
  const html = renderToHtml(createElement(filter.VoteTypeChips, {
    tallies: { all: 7, deciding: 1, advisory: 6 }, pressed: 'all', onPress: noop,
  }));
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Show votes"/);
  for (const key of ['all', 'deciding', 'advisory']) {
    assert.match(html, new RegExp(`data-needs-vote-chip="${key}"`));
  }
  // The words are the catalog's, and the count is in its own dimmed span.
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.all')}</span><span class="tabular-nums opacity-60" aria-hidden="true">7</span>`));
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.deciding')}</span><span class="tabular-nums opacity-60" aria-hidden="true">1</span>`));
  assert.match(html, new RegExp(`>${message('communities:needsYou.filter.advisory')}</span><span class="tabular-nums opacity-60" aria-hidden="true">6</span>`));
  // All is picked when the feed opens, and the accessible names carry the counts.
  assert.match(html, /aria-pressed="true"[^>]*data-needs-vote-chip="all"/);
  assert.match(html, /aria-label="All, 7 votes"/);
  assert.match(html, /aria-label="Votes that decide, 1 vote"/);
  assert.match(html, /aria-label="Advisory, 6 votes"/);
});

// Request 7029 (and the phone audit, request 7164): on a narrow phone the
// three chips are wider than the screen. They keep their own width with a gap
// between them, the row scrolls sideways and fades at the end that has more,
// and a chip is pressed at 44px.
test('on a narrow phone the chips scroll in a rail that fades, and each is pressed at 44px', () => {
  const html = renderToHtml(createElement(filter.VoteTypeChips, {
    tallies: { all: 7, deciding: 1, advisory: 6 }, pressed: 'advisory', onPress: noop,
  }));
  const rail = /<div[^>]*data-needs-vote-chips=""[^>]*>/.exec(html)[0];
  assert.match(rail, /class="[^"]*\bflex\b[^"]*\boverflow-x-auto\b[^"]*"/, 'one row that scrolls sideways, never a pile');
  assert.match(rail, /\[scrollbar-width:none\]/, 'with no scrollbar drawn');
  assert.match(rail, /class="[^"]*\bgap-2\b[^"]*"/, 'a gap between chips');
  assert.match(rail, /class="[^"]* -mt-1 [^"]*\bpt-1\b[^"]*"/, 'room above the chips for their hit box, pulled back up');
  assert.doesNotMatch(rail, /mask-image|data-fade/, 'nothing fades until an effect has measured the row');
  const chips = html.match(/<button[^>]*data-needs-vote-chip="[^"]*"[^>]*>/g);
  assert.equal(chips.length, 3);
  for (const chip of chips) {
    assert.match(chip, /class="[^"]*\bshrink-0\b[^"]*"/, 'a chip keeps its own width');
    assert.match(chip, /class="[^"]*\bh-9\b[^"]*\bun-touch-target\b[^"]*"/, 'drawn 36px, pressed at 44');
  }
  // The rail is the shared one, whose hook fades the end with more and
  // brings the pressed chip into view.
  const CHIP = read('frontend/@/components/ui/chip.tsx');
  assert.match(CHIP, /export function ChipRail\([^)]*\) \{\s*const ref = useRef<HTMLDivElement \| null>\(null\);\s*const \{ edges, style: fade \} = useRailFade\(ref\);/);
  assert.match(CHIP, /export const FadeRail = ChipRail;/, 'one rail: every chip row fades');
  assert.match(CHIP, /const end = at \+ el\.clientWidth < el\.scrollWidth - 1;/, 'the fade goes at the end of the scroll');
  assert.match(CHIP, /const pressed = el\.querySelector<HTMLElement>\('\[aria-pressed="true"\]'\);/);
  assert.match(CHIP, /else if \(chip\.right > rail\.right\) el\.scrollLeft \+= chip\.right - \(rail\.right - FADE\);/, 'the row is scrolled, never the page');
  assert.match(read('public/usernode-native/v1/native.css'), /\.un-touch-target::after \{[^}]*height: max\(100%, 44px\);/);
});

test('the chips are not drawn when the feed holds only one kind of vote', () => {
  const draw = (tallies) => renderToHtml(createElement(filter.VoteTypeChips, { tallies, pressed: 'all', onPress: noop }));
  assert.equal(draw({ all: 3, deciding: 3, advisory: 0 }), '', 'no advisory votes: nothing to choose between');
  assert.equal(draw({ all: 3, deciding: 0, advisory: 3 }), '', 'no deciding votes either');
  assert.equal(draw({ all: 0, deciding: 0, advisory: 0 }), '', 'an empty feed');
});


// ── The take-part rule on every owed-vote query (#6664) ────────────────

test('each owed-vote query asks the project\'s take-part rule, and leaves questions out', () => {
  const SRC = read('src/routes/workshop-overview.js');
  const region = (startMarker) => {
    const start = SRC.indexOf(startMarker);
    assert.ok(start >= 0, `${startMarker} is in the source`);
    const end = SRC.indexOf('`;', start);
    assert.ok(end > start, `${startMarker} is a template literal`);
    return SRC.slice(start, end + 2);
  };
  // The rule is checkAppAccess's 'collab' level, the one that refuses a vote:
  // an admin, a project that lets everyone take part, or a collaborator. The
  // `me` join is the viewer's accepted app_collaborators row.
  const rule = region('const CAN_TAKE_PART_SQL = ');
  assert.match(rule, /\$3::boolean OR a\.collab_visibility = 'public' OR me\.user_id IS NOT NULL/);

  const counts = region('const COUNTS_SQL = ');
  const items = region('const ITEMS_SQL = ');
  const feed = region('const needsFeedSql = ');
  const owed = region('const OWED_BY_COMMUNITY_SQL = ');
  for (const [name, sql] of [
    ['COUNTS_SQL', counts], ['ITEMS_SQL', items],
    ['needsFeedSql', feed], ['OWED_BY_COMMUNITY_SQL', owed],
  ]) {
    assert.match(sql, /\$\{CAN_TAKE_PART_SQL\}/, `${name} reads the take-part rule`);
  }

  // The bot's questions are the viewer's wherever they are: only the votes
  // are gated, so the chips' counts never include a vote they cannot cast.
  const needsExpr = counts.slice(counts.indexOf('SELECT a.slug,'), counts.indexOf('FROM apps a'));
  assert.equal((needsExpr.match(/CASE WHEN \$\{CAN_TAKE_PART_SQL\}/g) || []).length, 4,
    'the two vote counts and their two key arrays are gated');
  assert.ok(needsExpr.includes('COALESCE(oq.n, 0)) AS needs'), 'the question count is not gated');
  assert.ok(needsExpr.includes("COALESCE(oq.keys, '{}'::text[])) AS owed"), 'nor its keys');
  assert.match(feed, /o\.kind = 'question' OR \$\{CAN_TAKE_PART_SQL\}/);
  assert.match(owed, /o\.kind = 'question' OR \$\{CAN_TAKE_PART_SQL\}/);
  assert.match(items, /it\.kind = 'question'/);
});


// ── The project's own Needs you, and the experimental run ──────────────


test('the experimental run filters its run and draws the chips under its bar', () => {
  const SRC = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(SRC, /const \[filter, setFilter\] = useState<VoteFilter>\('all'\);/);
  // Each item's kind is the one model of a change's (voteTypeOf).
  assert.match(SRC, /const run = list \? filterByVoteType\(list, filter, voteTypeOf\) : \[\];/);
  assert.match(SRC, /const tallies = useMemo\(\(\) => voteTallies\(list \|\| \[\], voteTypeOf\), \[list\]\);/);
  // The press restarts the run at the first change of that kind with no vote
  // or skip yet, so it lands where there is still something to decide.
  assert.match(SRC, /const first = nextRun\.findIndex\(\(it\) => it\.kind !== 'governance' && !passed\[it\.key\]\);/);
  // Inside the bar, so the folded bar's measurement includes the chips; and
  // on the end card, so the other kind is one press away.
  const bar = SRC.slice(SRC.indexOf('className="rf-bar"'), SRC.indexOf('className="rf-desc-wrap"'));
  assert.match(bar, /<VoteTypeChips tallies=\{tallies\} pressed=\{filter\} onPress=\{pickFilter\} \/>/);
  assert.match(SRC, /filter !== 'all' \? <VoteTypeChips tallies=\{tallies\} pressed=\{filter\} onPress=\{pickFilter\} \/> : null/);
  assert.match(read('public/css/app.css'), /\.rf-bar \{ position: relative; z-index: 9; flex: none; display: flex; flex-wrap: wrap;/,
    'the chips wrap to a row under the title');
  assert.match(read('public/css/app.css'), /\.rf-bar \.needs-vote-chips \{ flex-basis: 100%; \}/);
});
