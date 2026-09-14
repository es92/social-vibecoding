// The composite status pill (app-view.js statusPillState / statusPillHtml /
// blockReasons).
//
// A proposal card used to be able to show SEVEN separate elements all
// answering "where is this in its life": the proportional tally pill, a
// pulsing "Vote" badge, a merge-state badge, a checks badge, a console-errors
// badge, an advisory chip and an explicit-approval chip. They collapse into
// ONE pill chosen by a strict precedence, and this file is that precedence's
// contract:
//
//   0 settled → 1 in flight → 2 blocked → 3 contested → 4 counting down
//   → 5 needs your vote → 6 plain tally
//
// The load-bearing rule: a proposal whose checks FAIL must never degrade to
// reading as a neutral tally, because the pill's whole job is that a glance
// says whether the thing can land.
//
// Run with: node --test tests/dev-status-pill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { api } = require('./lib/dev-card-html');
const { renderToHtml, createElement } = require('./lib/render-tsx');

// ── Rendering the pill ──────────────────────────────────────────────────
//
// `statusPillHtml` built the markup as a string; #1367's card chunk moved it
// to frontend/src/features/dev-board/card/dev-card.tsx (`StatusPill`), which
// renders `statusPillState`'s output — the half this file mostly tests, and
// the half worth unit-testing. This composes the two exactly as a card does.
// A state with no label draws nothing, which is what the '' cases below mean.
function pillHtml(AppView, item, opts) {
  const s = AppView.statusPillState(item, opts);
  if (!s || !s.label) return '';
  return renderToHtml(createElement(api().StatusPill, { s, inline: !!(opts && opts.inline) }));
}


const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const ME = 42;

function makeAppView(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: o.userId != null ? o.userId : ME, canAdminWrite: !!o.admin } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>',
      attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => !!o.touch, actionSheet: (spec) => { sandbox.__sheet = spec; },
      toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: o.majority != null ? o.majority : 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  if (o.readOnly) AppView.appData = { slug: 'x', can_collaborate: false };
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});

function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}
function menuItems(AppView, html) {
  const k = menuKeyOf(html);
  return k ? (AppView._cardMenus[k] || []) : [];
}
function menuLabels(AppView, html) {
  return menuItems(AppView, html).map((it) => it.label);
}

const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// ── Precedence, tier by tier ────────────────────────────────────────────

test('tier 0 — a merged row is settled and reads ✓ Merged', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({ status: 'merged', yes_count: 5 }));
  assert.equal(s.tier, 0);
  assert.equal(s.label, '✓ Merged');
  assert.equal(s.tone, 'ok');
});

test('tier 1 — merging stays in the bar; resolving became a tag', () => {
  const AppView = makeAppView();
  // Merging, even with failing checks and a conflict recorded: the merge is
  // happening, which is the highest-signal thing the BAR can say — and it is
  // still about the vote, because merging is what a won vote turns into.
  const merging = AppView.statusPillState(PR({
    status: 'merging', check_state: 'failing', merge_conflict_state: 'failed',
  }));
  assert.equal(merging.tier, 1);
  assert.equal(merging.label, 'Merging…');
  assert.equal(merging.tone, 'progress');
  assert.ok(merging.spinner, 'in-flight stages carry the spinner');

  // Resolving conflicts is mechanical plumbing, not a stage of the vote, so
  // it left the bar. The bar falls through to the vote; the fact is a tag.
  const row = PR({ resolving: true, check_state: 'failing' });
  const resolving = AppView.statusPillState(row);
  assert.ok(resolving.key !== 'resolving', 'the bar no longer says it');
  assert.ok(['needs_vote', 'tally'].includes(resolving.key), 'the bar is the vote');
  const tag = AppView.statusTagSpecs(row, {}).find((t) => t.key === 'tag-resolving');
  assert.ok(tag, 'and the fact is a tag');
  assert.equal(tag.label, 'Resolving conflicts automatically…');
  assert.ok(tag.spinner, 'in flight, so it spins');
});

test('a hard block no longer takes the bar: the vote shows, the block is a tag', () => {
  const AppView = makeAppView();
  // The vote is won and a merge window is running. The bar used to drop the
  // tally and say "Checks failing · 2" instead, on the reasoning that a count
  // does not matter when it cannot land. The bar is the VOTE now, so it keeps
  // counting, and the block is said beside it.
  const row = PR({
    check_state: 'failing',
    test_results: [
      { name: 'Home', status: 'pass' },
      { name: 'Feed', status: 'fail' },
      { name: 'Board', status: 'fail' },
    ],
    yes_count: 5, votes_required: 3, merge_window_ends_at: hoursAhead(4),
  });
  const s = AppView.statusPillState(row);
  assert.ok(s.tier !== 2, 'the bar is not a block tier any more');
  assert.ok(!/Checks failing/.test(s.label), 'and says nothing about checks');
  assert.ok(s.fill, 'the tally rides again — that is the point of the move');

  const tags = AppView.statusTagSpecs(row, {});
  const failing = tags.find((t) => t.key === 'tag-checks_failing');
  assert.ok(failing, 'the block is a tag');
  assert.equal(failing.label, 'Checks failing · 2', 'counting the failures, as the bar did');
  assert.match(failing.cls, /red/, 'blocking tags are red');
});

test('every hard blocking state is a red tag, in severity order', () => {
  const AppView = makeAppView();
  const cases = [
    [{ merge_conflict_state: 'failed' }, 'Needs manual resolution'],
    [{ merge_conflict_state: 'conflict' }, 'GitHub refused the merge'],
    [{ check_state: 'error' }, 'Preview won’t boot'],
    [{ check_state: 'failing', test_results: [] }, 'Checks failing'],
  ];
  for (const [row, label] of cases) {
    const tags = AppView.statusTagSpecs(PR(row), {});
    const tag = tags.find((t) => t.label === label);
    assert.ok(tag, label);
    assert.match(tag.cls, /red/, `${label} blocks, so it is red`);
    // ...and the bar is untouched by any of them.
    assert.ok(!/Conflict|conflict|Checks|boot/.test(AppView.statusPillState(PR(row)).label),
      `the bar says nothing about ${label}`);
  }
  // BOTH are drawn now. The bar could only ever admit one, which is why a
  // conflict used to HIDE a checks failure; severity still decides the order.
  const both = PR({ merge_conflict_state: 'failed', check_state: 'failing', test_results: [] });
  // Joined rather than deep-compared: arrays built inside the vm realm carry
  // that realm's prototypes, which trips deepStrictEqual on identity alone.
  const labels = AppView.statusTagSpecs(both, {}).map((t) => t.label).join(' | ');
  assert.equal(labels, 'Needs manual resolution | Checks failing',
    'every reason, worst first');
});

test('soft reasons are amber tags, and the bar just counts the vote', () => {
  const AppView = makeAppView();
  // Behind main resolves itself, so it never stopped the thing landing. It
  // used to ride the bar as "Behind main · 3 · 1/3" — the fact and the tally
  // sharing one label. They are two things now, said in two places.
  const row = PR({ behind_main: 3, yes_count: 1, votes_required: 3 });
  const s = AppView.statusPillState(row);
  assert.ok(!/Behind main/.test(s.label), 'the bar is the vote alone');
  assert.match(s.label, /1\s*\/\s*3|1\/3/, 'and still carries the count');

  const tag = AppView.statusTagSpecs(row, {}).find((t) => t.key === 'tag-behind');
  assert.ok(tag, 'behind main is a tag');
  assert.equal(tag.label, 'Behind main · 3');
  assert.match(tag.cls, /amber/, 'soft, so amber rather than red');
});

test('checks in flight are a neutral, spinning tag — they outrank nothing now', () => {
  const AppView = makeAppView();
  const pending = PR({ check_state: 'pending' });
  const running = AppView.statusTagSpecs(pending, {}).find((t) => t.key === 'tag-checks-running');
  assert.ok(running);
  assert.equal(running.label, 'Checks running…');
  assert.match(running.cls, /zinc/, 'nobody has to act, so neutral');
  assert.ok(running.spinner, 'in flight, so it spins');
  assert.ok(!/Checks/.test(AppView.statusPillState(pending).label), 'the bar is the vote');

  // #607: nothing recorded at all — the first run hasn't stamped 'pending'.
  const fresh = PR({});
  const starting = AppView.statusTagSpecs(fresh, {}).find((t) => t.key === 'tag-checks-running');
  assert.ok(starting);
  assert.equal(starting.label, 'Checks starting…');
  assert.ok(starting.spinner);
});

test('tier 3 — contested turns the timed path off and says so', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({
    check_state: 'passing', contested: true, yes_count: 4, no_count: 3, votes_required: 6,
  }));
  assert.equal(s.tier, 3);
  assert.equal(s.label, 'Needs a conversation · 4/6');
  assert.equal(s.tone, 'attention');
  assert.ok(s.fill);
});

test('tier 4 — merge countdown, with the tally riding along below threshold', () => {
  const AppView = makeAppView();
  const reached = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 3, votes_required: 3, merge_window_ends_at: hoursAhead(48),
  }));
  assert.equal(reached.tier, 4);
  assert.match(reached.label, /^Goes live in /);
  assert.equal(reached.suffix, '', 'at threshold the tally is redundant');
  assert.equal(reached.tone, 'ok');

  // Lazy consensus: below threshold but unopposed, so the count matters.
  const lazy = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 1, no_count: 0, votes_required: 2,
    merge_window_ends_at: hoursAhead(60),
  }));
  assert.equal(lazy.tier, 4);
  assert.match(lazy.label, /Goes live in .* · 1\/2$/);
});

test('tier 4 — a rejection countdown reads BLOCKED', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 0, no_count: 2, votes_required: 3,
    rejection_armed: true, reject_window_ends_at: hoursAhead(6),
  }));
  assert.equal(s.tier, 4);
  assert.match(s.label, /^Set aside in /);
  assert.equal(s.tone, 'blocked');
  assert.ok(s.reject);
});

test('an admins-changing proposal NEVER promises a merge countdown', () => {
  const AppView = makeAppView();
  // The server sends no window for one of these; this is the belt-and-braces
  // guard so a stale cached row can't promise a merge that will never happen.
  const s = AppView.statusPillState(PR({
    check_state: 'passing', requires_explicit_approval: true,
    yes_count: 3, votes_required: 3, merge_window_ends_at: hoursAhead(4), my_vote: 'yes',
  }));
  assert.notEqual(s.tier, 4);
  assert.doesNotMatch(s.label, /Goes live in/);
  assert.ok(s.lock, 'the lock modifier explains why');
});

test('tier 5 — needs your vote absorbs the pulsing "Vote" badge', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState(PR({ check_state: 'passing', yes_count: 2, votes_required: 5 }));
  assert.equal(s.tier, 5);
  assert.equal(s.label, 'Vote · 2/5');
  assert.equal(s.tone, 'progress');
  assert.ok(s.dot, 'the pulsing dot moved INSIDE the pill');
  assert.ok(s.fill);
});

test('tier 5 is skipped for a read-only viewer (they cannot vote)', () => {
  const AppView = makeAppView({ readOnly: true });
  const s = AppView.statusPillState(PR({ check_state: 'passing', yes_count: 2, votes_required: 5 }));
  assert.equal(s.tier, 6);
  assert.equal(s.label, '2 / 5');
  assert.ok(!s.dot);
});

test('tier 6 — the plain tally, and the at-least-N approvals variant', () => {
  const AppView = makeAppView();
  const voted = AppView.statusPillState(PR({
    check_state: 'passing', yes_count: 2, no_count: 0, votes_required: 5, my_vote: 'yes',
  }));
  assert.equal(voted.tier, 6);
  assert.equal(voted.label, '2 / 5');
  assert.equal(voted.tone, 'progress');

  const won = AppView.statusPillState(PR({
    status: 'merged', yes_count: 5, votes_required: 5,
  }));
  assert.equal(won.tone, 'ok');

  const approvals = AppView.statusPillState(PR({
    check_state: 'passing', approvals_required: 3, yes_count: 2,
  }));
  assert.equal(approvals.label, '2 of 3 approvals');
  assert.ok(approvals.fill, 'clock-free, but still a progress pill');
});

// ── Modifiers folded into the pill ──────────────────────────────────────

test('the advisory surplus rides inside the label, not beside the pill', () => {
  const AppView = makeAppView();
  const html = pillHtml(AppView, PR({
    check_state: 'passing', approval_policy: 'invited',
    yes_count: 3, qualified_yes_count: 1, votes_required: 2, my_vote: 'yes',
  }));
  assert.match(html, /gc-vote-count-suffix[^>]*>\+2</);
  assert.doesNotMatch(html, /gc-vote-advisory/, 'no separate chip any more');
});

test('explicit approval is a lock glyph inside the pill, not a chip', () => {
  const AppView = makeAppView();
  const html = pillHtml(AppView, PR({
    check_state: 'passing', requires_explicit_approval: true,
    yes_count: 1, votes_required: 3, my_vote: 'yes',
  }));
  assert.match(html, /gc-vote-count-lock/);
  assert.match(html, /won’t merge on a timer/, 'the tooltip carries the explanation');
  assert.doesNotMatch(html, /gc-vote-explicit/, 'no separate chip any more');
});

test('multiple reasons: every one is its own tag, and none of them is the bar', () => {
  const AppView = makeAppView();
  const pr = PR({
    check_state: 'failing', test_results: [{ name: 'a', status: 'fail' }],
    behind_main: 2, console_check_state: 'errors', console_errors: [{ message: 'x' }],
  });
  // The bar used to name the worst and count the rest in a tooltip — "and 2
  // more reasons, open for details" — because it had one slot. Every reason
  // is its own tag.
  const tags = AppView.statusTagSpecs(pr, {});
  assert.equal(tags.map((t) => t.label).join(' | '),
    'Checks failing · 1 | Behind main · 2');
  assert.match(tags[0].cls, /red/);
  assert.match(tags[1].cls, /amber/);
  // #2038: the console errors on this row are NOT a third tag. They already
  // block through check_state when they land on a declared check — which is
  // the red tag above — and a second amber tag over the capture routes said
  // the same kind of thing in a different voice. The data stays, and the
  // detail view still enumerates it.
  assert.equal(tags.length, 2, 'no console tag');
  assert.equal(AppView.blockReasons(pr).length, 2, 'and no console reason');
  assert.equal(AppView.statusPillState(pr).reasons.length, 2);
});

// ── Markup contract ─────────────────────────────────────────────────────

test('the proportional fill markup is preserved on the tally tiers', () => {
  const AppView = makeAppView();
  const partial = pillHtml(AppView, PR({
    check_state: 'passing', yes_count: 1, no_count: 1, votes_required: 4, my_vote: 'yes',
  }));
  assert.match(partial, /gc-vote-fill gc-vote-fill-yes" style="width:25%/);
  assert.match(partial, /gc-vote-fill gc-vote-fill-no" style="width:25%/);

  // A side crossing the threshold still fills the pill solid.
  const wonYes = pillHtml(AppView, PR({
    check_state: 'passing', yes_count: 4, votes_required: 4, my_vote: 'yes',
  }));
  assert.match(wonYes, /gc-vote-fill-full gc-vote-fill-full-yes/);
  const wonNo = pillHtml(AppView, PR({
    check_state: 'passing', yes_count: 0, no_count: 4, votes_required: 4, my_vote: 'no',
  }));
  assert.match(wonNo, /gc-vote-fill-full gc-vote-fill-full-no/);
});

test('a countdown carries the ticker contract the 30s timer reads', () => {
  const AppView = makeAppView();
  const html = pillHtml(AppView, PR({
    check_state: 'passing', yes_count: 1, no_count: 0, votes_required: 2,
    merge_window_ends_at: hoursAhead(30),
  }));
  assert.match(html, /gc-merge-countdown/);
  assert.match(html, /data-window-ends="\d+"/);
  assert.match(html, /data-label-suffix=" · 1\/2"/, 'the ticker preserves the tally suffix');
});

test('the pill is FULL WIDTH on a card, and a capsule in the detail head', () => {
  const AppView = makeAppView();
  const pr = PR({ my_vote: 'yes', check_state: 'passing', yes_count: 1, votes_required: 4 });
  // Default (the board): a block that spans the card's content width, so the
  // proportional fill reads as a progress bar rather than a thumbnail-sized
  // capsule wedged between chips.
  const block = pillHtml(AppView, pr);
  assert.match(block, /dev-status-pill-block/);
  // opts.inline keeps the capsule for the detail head, which already has the
  // full page width — a second full-width bar there is just a rule.
  const inline = pillHtml(AppView, pr, { inline: true });
  assert.doesNotMatch(inline, /dev-status-pill-block/);
  assert.match(inline, /gc-vote-count /);
  // Both forms keep the same fill markup, so the bar scales with the tally.
  for (const html of [block, inline]) {
    assert.match(html, /gc-vote-fill gc-vote-fill-yes" style="width:25%/);
  }
});

test('the fill still stretches the whole pill at every level', () => {
  const AppView = makeAppView();
  // Empty, partial and full — the widths are a pure function of the tally,
  // and full width is what makes them legible.
  const at = (yes) => pillHtml(AppView, PR({
    check_state: 'passing', my_vote: 'yes', yes_count: yes, votes_required: 4,
  }));
  assert.match(at(0), /gc-vote-fill-yes" style="width:0%/);
  assert.match(at(2), /gc-vote-fill-yes" style="width:50%/);
  assert.match(at(4), /gc-vote-fill-full gc-vote-fill-full-yes/, 'solid once past threshold');
});

test('every tone maps to a declared class, and the pill is one element', () => {
  const AppView = makeAppView();
  for (const tone of AppView.STATUS_PILL_TONES) {
    assert.ok(typeof tone === 'string' && tone.length);
  }
  const html = pillHtml(AppView, PR({ check_state: 'passing', yes_count: 1, votes_required: 2, my_vote: 'yes' }));
  assert.equal((html.match(/class="gc-vote-count /g) || []).length, 1, 'exactly one pill');
  assert.match(html, /dev-status-pill/);
  // A row with nothing to say draws no pill at all.
  assert.equal(pillHtml(AppView, null), '');
  // And the card carries the very state this file tests — the model's `pill`
  // is statusPillState's output, handed straight to the component above.
  const pr = PR({ check_state: 'passing', yes_count: 1, votes_required: 2, my_vote: 'yes' });
  assert.equal(AppView._proposalCardModel(pr).pill.state.label,
    AppView.statusPillState(pr, { majority: 1 }).label);
});

// ── A governance proposal has no checks ─────────────────────────────────

test('kind "gov" skips every checks/conflict state', () => {
  const AppView = makeAppView();
  // A gov row has no check_state, which the #607 branch would otherwise read
  // as "the first run hasn't stamped pending yet" and label Checks starting….
  const s = AppView.statusPillState(
    { status: 'promoted', yes_count: 0, no_count: 0, approvals_required: 1 },
    { kind: 'gov', majority: 1 }
  );
  assert.equal(s.label, '0 of 1 approval');
  assert.doesNotMatch(s.label, /Checks/);
  assert.equal(AppView.blockReasons({}).length, 0);
});

// ── blockReasons is the shared source of truth ──────────────────────────

test('blockReasons: severity order, labels, and the detail sentences', () => {
  const AppView = makeAppView();
  assert.equal(AppView.blockReasons(null).length, 0);
  assert.equal(AppView.blockReasons({ check_state: 'passing' }).length, 0);

  const r = AppView.blockReasons({
    merge_conflict_state: 'conflict',
    check_state: 'failing',
    test_results: [{ name: 'Feed renders', status: 'fail' }],
    behind_main: 4,
    console_check_state: 'errors',
    console_errors: [{ message: 'x' }],
  });
  assert.equal(r.map((x) => x.key).join(','), 'merge_conflict,checks_failing,behind');
  assert.match(r[1].detail, /Feed renders/, 'the detail names WHICH test failed');
  assert.ok(r[2].soft, 'behind main is soft — it resolves itself');
  assert.match(r[2].detail, /4 commits behind main/);
  assert.ok(!r[0].soft && !r[1].soft, 'a refused merge and a failing check do block');
});

// ── The invariant the whole change rests on ─────────────────────────────

test('the bar can only ever be a vote state, whatever is wrong with the row', () => {
  const AppView = makeAppView();
  // Every non-vote thing a proposal can be, at once. The bar used to pick the
  // worst of these; now none of them can reach it.
  const worst = PR({
    merge_conflict_state: 'failed', resolving: true,
    check_state: 'failing', test_results: [{ name: 'a', status: 'fail' }],
    behind_main: 4, console_check_state: 'errors', console_errors: [{ message: 'x' }],
    yes_count: 1, votes_required: 3,
  });
  const s = AppView.statusPillState(worst);
  const VOTE_KEYS = ['merged', 'merging', 'contested', 'approvals',
    'merge_countdown', 'reject_countdown', 'needs_vote', 'tally'];
  assert.ok(VOTE_KEYS.includes(s.key), `the bar is a vote state, got ${s.key}`);
  // And the five facts are five tags, not one label and a tooltip count.
  const labels = AppView.statusTagSpecs(worst, {}).map((t) => t.label).join(' | ');
  for (const expected of ['Resolving conflicts automatically…', 'Needs manual resolution',
    'Checks failing · 1', 'Behind main · 4']) {
    assert.ok(labels.includes(expected), `${expected} is drawn — got: ${labels}`);
  }
});

test('a governance proposal has no branch, so it has no tags', () => {
  const AppView = makeAppView();
  // The same guard statusPillState carries: gov rows have no staging build
  // and no checks, so every one of these states is inapplicable rather than
  // merely absent.
  const gov = PR({ check_state: 'failing', behind_main: 2 });
  assert.equal(AppView.statusTagSpecs(gov, { kind: 'gov' }).length, 0);
  assert.ok(AppView.statusTagSpecs(gov, {}).length > 0, 'but a code proposal does');
});

test('the declared checks still describe the row the tags are actually on', () => {
  // A declared selector is a STRING in dapp.json: nothing local resolves it,
  // so only the staging gate notices when the markup moves out from under
  // one. That has already cost a red gate once this week. The tags moved from
  // the facts row to the meta line; these assert the checks moved with them.
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const dapp = JSON.parse(fs2.readFileSync(path2.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const mine = dapp.tests.filter((t) => /9000050/.test(t.expectSelector || ''));
  assert.equal(mine.length, 2, 'the blocked-proposal pair');
  const bar = mine.find((t) => /dev-status-pill-block/.test(t.expectSelector));
  const tags = mine.find((t) => /data-status-tag/.test(t.expectSelector));
  assert.ok(bar && tags);
  assert.match(bar.expectSelector, /\.dev-card-status > \.dev-status-pill-block/,
    'the bar check reads the status row');
  assert.match(tags.expectSelector, /\.dev-card-meta > \[data-status-tag="[a-z_-]+"\]/,
    'the tags check reads the META line, and names the tag it wants');
  assert.ok(!/dev-card-facts/.test(tags.expectSelector),
    'and not the facts row they used to be on');
  // NAMED, not positional. `.dev-card-meta > .dev-badge` matched — but its
  // first hit on the detail head is an unset attr placeholder ("Set
  // priority"), which renders before the status tags there and would have
  // failed the expectText. Every status tag carries data-status-tag so a
  // check can ask for the one it means.
  for (const t of dapp.tests.filter((x) => /data-status-tag/.test(x.expectSelector || ''))) {
    assert.match(t.expectSelector, /\[data-status-tag="[a-z_-]+"\]/, t.name);
  }
});

test('every status tag is addressable by name', () => {
  const AppView = makeAppView();
  const row = PR({
    merge_conflict_state: 'failed', resolving: true, check_state: 'failing',
    test_results: [{ name: 'a', status: 'fail' }], behind_main: 4,
    console_check_state: 'errors', console_errors: [{ message: 'x' }],
  });
  for (const tag of AppView.statusTagSpecs(row, {})) {
    assert.ok(tag.data && tag.data['data-status-tag'],
      `${tag.label} carries a data-status-tag`);
  }
});

// ── Declared checks are pinned against the REAL staging fixtures ────────
//
// Every declared selector this change owns is asserted here against the rows
// `stagingMockProposals` actually serves, not against a hand-made row. Three
// gate failures came from guessing those values: a fixture with a merge
// window reaches `merge_countdown` once the soft block stops intercepting it,
// so the bar is `ok` and counts down — not the `progress` tally I predicted.

function stagingRows() {
  const fs2 = require('node:fs');
  const vm2 = require('node:vm');
  const src = fs2.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '' };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  // What /promoted actually serves: every row passes through readIntegration
  // on the way out (routes/votes.js), which is what turns the flat
  // integration_* columns into the nested block the card reads. A fixture
  // asserted WITHOUT that step is not the row the browser sees — #2038's
  // `integrating` tag renders only from the nested shape, so leaving this out
  // would have let a declared check pass here and fail on staging.
  const readIntegration = require('../src/services/integration').readIntegration;
  return ctx.__rows('me').map((r) => ({ ...r, integration: readIntegration(r) }));
}

test('the declared checks match what the real staging fixtures render', () => {
  const AppView = makeAppView();
  const rows = stagingRows();
  const row = (id) => JSON.parse(JSON.stringify(rows.find((r) => r.id === id)));

  // 9000033 — behind main, clean, inside its merge window.
  const clean = row(9000033);
  const cleanPill = AppView.statusPillState(clean);
  assert.equal(cleanPill.key, 'merge_countdown',
    'the soft block no longer intercepts, so the countdown is reached');
  assert.equal(cleanPill.tone, 'ok');
  assert.equal(AppView.statusTagSpecs(clean, {}).map((t) => t.data['data-status-tag']).join(), 'behind');

  // 9000034 — behind AND predicted to conflict.
  const conflict = row(9000034);
  assert.equal(AppView.statusPillState(conflict).key, 'needs_vote');
  assert.equal(AppView.statusTagSpecs(conflict, {}).map((t) => t.data['data-status-tag']).join(),
    'mergeability_conflict,behind');

  // 9000050 — the multi-reason card the board checks read.
  const multi = row(9000050);
  assert.equal(AppView.statusTagSpecs(multi, {}).map((t) => t.data['data-status-tag']).join(),
    'checks_failing');

  // 9000082 — approved and being brought up to date. The tag the SERVER
  // names: it comes from integration.blockReasons, not from any column the
  // browser can read, which is the whole point of #2038's served reason.
  // Note what is NOT here: the row is six commits behind, and no `behind`
  // tag renders. "Behind main" describes a proposal sitting still; this one
  // is being worked on, and saying both would be two tags for one fact.
  const integrating = row(9000082);
  assert.equal(AppView.statusTagSpecs(integrating, {}).map((t) => t.data['data-status-tag']).join(),
    'integrating');
  assert.equal(AppView.statusTagSpecs(integrating, {})[0].label, 'Bringing up to date…');

  // 9000083 — the platform asked GitHub to merge and GitHub said no. Named
  // for what happened rather than as a prediction about conflicting files,
  // which is a different tag (`mergeability_conflict`, on 9000034 above).
  const refused = row(9000083);
  assert.equal(AppView.statusTagSpecs(refused, {}).map((t) => t.data['data-status-tag']).join(),
    'merge_conflict');
  assert.equal(AppView.statusTagSpecs(refused, {})[0].label, 'GitHub refused the merge');

  // 9000003 — automatic resolution in flight. Toned `running`, because
  // nobody has to act; the wording says so rather than reporting our state.
  const resolving = row(9000003);
  assert.equal(AppView.statusTagSpecs(resolving, {}).map((t) => t.data['data-status-tag']).join(),
    'resolving');
  assert.equal(AppView.statusTagSpecs(resolving, {})[0].label, 'Resolving conflicts automatically…');

  // ...and every declared selector naming one of these rows asks for a tag
  // those rows actually produce.
  const dapp = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const produced = new Set([...AppView.statusTagSpecs(clean, {}), ...AppView.statusTagSpecs(conflict, {}),
    ...AppView.statusTagSpecs(multi, {}), ...AppView.statusTagSpecs(integrating, {}),
    ...AppView.statusTagSpecs(refused, {}), ...AppView.statusTagSpecs(resolving, {})]
    .map((t) => t.data['data-status-tag']));
  for (const t of dapp.tests) {
    const m = /\[data-status-tag="([a-z_-]+)"\]/.exec(t.expectSelector || '');
    if (m) assert.ok(produced.has(m[1]), `${t.name} asks for a tag the fixtures produce: ${m[1]}`);
  }
});

// The ledger's one control. A red main pauses every merge on the app until a
// fix lands or an admin resumes them; the admin reading the ledger is the one
// person who can, so the gate carries the verb for them and for nobody else.
test('the main_healthy gate carries "Resume merges" for an admin, and for nobody else', () => {
  const gate = { key: 'main_healthy', label: 'Main is healthy', actor: 'admin', state: 'blocked',
    detail: { note: "main's unit suite is failing since abc1234" } };
  const admin = makeAppView({ admin: true });
  admin.appData = { slug: 'demo-app' };
  const act = admin._requirementAction(gate, { isAdmin: true, isAuthor: false, hasVoted: false });
  assert.equal(act.label, 'Resume merges');
  assert.equal(JSON.stringify(act.act), JSON.stringify({ fn: 'resumeMainMerges', args: ['demo-app'] }));
  assert.match(act.title, /unit suite is failing/);
  // Wired through requirementsSpec, so the React row sees it on the gate.
  const spec = admin.requirementsSpec({ id: 1, status: 'promoted', mergeRequirements: { gates: [gate] } });
  assert.equal(spec.gates[0].action.label, 'Resume merges');
  assert.equal(spec.headline, 'Waiting on you', 'the admin is who the ledger is waiting on');

  // Not for a non-admin: a control they cannot use is a chore, not a hint.
  const viewer = makeAppView();
  viewer.appData = { slug: 'demo-app' };
  assert.equal(viewer._requirementAction(gate, { isAdmin: false }), null);
  assert.equal(viewer.requirementsSpec({ id: 1, status: 'promoted', mergeRequirements: { gates: [gate] } }).gates[0].action, null);
  // Not once main is green again, or while the post-merge run is going.
  for (const state of ['done', 'active', 'pending']) {
    assert.equal(admin._requirementAction({ ...gate, state }, { isAdmin: true }), null, state);
  }
  // Never on any other gate, whatever its state.
  assert.equal(admin._requirementAction({ key: 'checks', state: 'blocked', actor: 'author' }, { isAdmin: true }), null);
});
