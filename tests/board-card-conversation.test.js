// One card, one set of controls, on every view (#1884).
//
// The Workshop's rows carried the item's conversation — the recent GitHub
// comments above, the app's own thread with the reply box below — and the
// Board's rows carried neither. So the SAME card read as two different
// objects: opened from the Workshop it had somewhere to reply, opened from
// the Board it had nothing under it at all. Nothing about the CARD differed;
// what differed was the ROW the two surfaces built around it, which is the
// kind of drift a shared component cannot prevent on its own.
//
// Both surfaces route through `_attachRowConversation` now. This file pins:
//
//   * every board column's rows carry what the Workshop's carry, per kind —
//     an issue its GitHub comments AND its thread, a proposal or governance
//     item its thread, a merged row neither (its conversation lives on the
//     proposal it came from);
//   * the Underway column's sessions carry theirs, private ones included;
//   * an unfolded board card actually renders both regions;
//   * the legacy filler is wired from the board and paints wherever the slot
//     lives, not only under `#dev-workshop`;
//   * the comment and thread CSS is scoped to both hosts, at the weight it
//     had when the one id stood alone;
//   * a declared check reads the reply box off a board card.
//
// Run with: node --test tests/board-card-conversation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml, listRowHtml } = require('./lib/dev-card-html');

// The rows are built inside a vm context, so their prototypes come from
// another realm and `deepStrictEqual` rejects them on identity alone. The
// reference is two fields; read them.
const threadIs = (row, type, ref) => {
  assert.ok(row.thread, `${row && row.key} carries a thread`);
  assert.equal(row.thread.type, type);
  assert.equal(row.thread.ref, ref);
};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const KANBAN = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));

const at = (d) => new Date(Date.now() - d * 86400000).toISOString();

// Same sandbox shape as tests/dev-board-fold.test.js — app-view.js in a vm,
// with a `location` the board's URL states are read from.
function makeAppView({ search = '' } = {}) {
  const sandbox = {
    console, relTime: () => '2h ago',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum', _appUrl: () => '#x', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search, hash: '', href: `http://localhost/${search}` }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._ghIssues = [
    { number: 1575, title: 'Replace the oversized Game Corner header with bottom tabs', createdAt: at(4), updatedAt: at(2), lastMessageAt: at(2), user: 'sam', htmlUrl: 'x' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 1540, pr_title: 'Rewrite the email-confirmation email around one clear CTA',
    pr_url: 'https://github.com/acme/app/pull/1540',
    status: 'promoted', username: 'evan', created_at: at(1), promoted_at: at(1), last_message_at: at(1),
    linked_issues: [], my_vote: null, votes_for: 3, votes_against: 1, yes_count: 3, no_count: 1,
    checks_state: 'success', checks_total: 412, checks_passed: 412, message_count: 5,
  }];
  AppView._govProposals = [{
    id: 55, title: 'Raise the merge threshold to two thirds', status: 'open',
    username: 'priya', created_at: at(1), last_message_at: at(1), kind: 'governance',
  }];
  AppView._merged = [{
    id: 78, pr_number: 1572, pr_title: 'Add screen transitions to Game Corner', status: 'merged',
    username: 'alice', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 2, activeUsers: 7 };
  AppView._mergedTotal = 1; AppView._mergedHasMore = false;
  AppView._mySessions = []; AppView._sharedSessions = []; AppView._archivedSessions = [];
  AppView._sharedById = {}; AppView._devDataReady = true;
  return AppView;
}

/** Every card row of one board column, by column key. */
const rowsOf = (view, key) => (view.cols.find((c) => c.key === key) || { rows: [] })
  .rows.filter((r) => r.t === 'card');

const mySess = (over) => ({
  id: 7, session_title: 'Tidy the header', status: 'running', user_id: 1, username: 'me',
  created_at: at(1), last_activity_at: at(1), linked_issues: [], ...over,
});

test('every board column carries the conversation the Workshop’s rows carry, by kind', () => {
  const AppView = makeAppView();
  const view = AppView._kanbanView();

  // An issue has BOTH: the repository's thread above (read-only, by number)
  // and the app's own below (the one a reply can land in).
  const issue = rowsOf(view, 'issues').find((r) => r.key === 'issue:1575');
  assert.ok(issue, 'the fixture puts an issue on the board');
  threadIs(issue, 'issue', 1575);
  assert.equal(issue.commentsFor, 1575);

  // A proposal and a governance item have the app's own thread and no GitHub
  // preview — there is no issue number to preview.
  const inReview = rowsOf(view, 'inreview');
  const proposal = inReview.find((r) => r.key === 'proposal:34');
  assert.ok(proposal, 'the promoted proposal buckets into In review');
  threadIs(proposal, 'session', 34);
  assert.equal(proposal.commentsFor, undefined);
  const gov = inReview.find((r) => /^gov/.test(r.key));
  assert.ok(gov, 'the governance item buckets into In review too');
  threadIs(gov, 'governance', 55);

  // A merged row keeps neither, deliberately: _feedThreadRef declines it
  // because the conversation lives on the proposal it came from.
  for (const done of rowsOf(view, 'done')) {
    assert.equal(done.thread, undefined, `${done.key} has no thread of its own`);
    assert.equal(done.commentsFor, undefined, `${done.key} previews no comments`);
  }
});

test('the Underway column’s sessions carry theirs too, private ones included', () => {
  const AppView = makeAppView();
  const rows = AppView._inProgressRows([
    { kind: 'my-session', item: mySess({ id: 1, session_title: 'Private one' }) },
    { kind: 'my-session', item: mySess({ id: 2, session_title: 'Visible one', shared_at: at(1) }) },
    { kind: 'shared-session', item: mySess({ id: 3, session_title: 'Someone else’s', user_id: 9, username: 'sam', shared_at: at(1) }) },
    { kind: 'issue', item: AppView._ghIssues[0] },
  ]).filter((r) => r.t === 'card');
  assert.equal(rows.length, 4, 'four cards, whatever dividers sit between them');

  // A session's thread is addressed by session id whether or not it has been
  // shared yet — `my-session` resolves as `shared-session`, exactly as the
  // Workshop has always addressed it.
  const byRef = new Map(rows.filter((r) => r.thread).map((r) => [r.thread.ref, r.thread.type]));
  assert.equal(byRef.get(1), 'session', 'the private session');
  assert.equal(byRef.get(2), 'session', 'the visible one');
  assert.equal(byRef.get(3), 'session', 'somebody else’s');
  assert.equal(byRef.get(1575), 'issue', 'and the issue card in the same column');
  const issue = rows.find((r) => r.commentsFor === 1575);
  assert.ok(issue, 'the issue previews its GitHub comments here as well');
});

test('one helper hangs it on, so the two surfaces cannot drift again', () => {
  assert.match(APP_VIEW_SRC, /_attachRowConversation\(row, kind, item\) \{/);
  // The Workshop's own builder routes through it rather than repeating it.
  assert.match(APP_VIEW_SRC,
    /const row = AppView\._attachRowConversation\(\{\s*t: 'card', key: card\.key, card, brief: AppView\._workshopBrief\(kind, item, card\),\s*\}, kind, item\);/,
    'the Workshop’s rows are built by the shared helper');
  // Nothing hangs a thread on a row by hand any more.
  const strays = APP_VIEW_SRC.split('\n').filter((l) => /^\s*if \(th\) row\.thread = th;/.test(l));
  assert.equal(strays.length, 1, 'only the helper assigns row.thread');
  assert.match(APP_VIEW_SRC, /_attachRowConversation\(row, kind, item\) \{[\s\S]*?if \(th\) row\.thread = th;/,
    'and that one line is inside the helper');
});

test('an unfolded board card draws the comment tail and the reply box', () => {
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  const html = kanbanHtml(AppView);

  // The GitHub tail ships EMPTY — it is filled lazily by the legacy observer,
  // and an initial render that differed from the shipped markup would be a
  // hydration mismatch.
  assert.match(html, /<div class="dev-feed-comments" data-comments-for="1575"><\/div>/);
  // The app's own thread, with the composer under it, on the same card.
  assert.match(html, /data-comments-for="1575"><\/div><div class="dev-feed-thread">/,
    'the thread sits directly under the GitHub tail, as it does on the Workshop');
  assert.match(html, /<div class="dev-feed-thread">[\s\S]*?<textarea [^>]*aria-label="Reply to this item"/);
  // One message box (27 Nov 2026): the reply box is Messages' own.
  assert.match(html, /<div class="dev-feed-thread">[\s\S]*?<button type="button"[^>]*class="messages-send"/);
  // The proposal's card gets the thread without a GitHub tail above it.
  assert.match(html, /data-proposal-row="34"[\s\S]*?<div class="dev-feed-thread">/);

  // A merged card gets neither — the one kind that deliberately has none.
  const doneRow = AppView._kanbanView().cols.find((c) => c.key === 'done').rows
    .filter((r) => r.t === 'card')[0];
  const done = listRowHtml(doneRow);
  assert.ok(!done.includes('dev-feed-thread'), 'no reply box under a merged row');
  assert.ok(!done.includes('dev-feed-comments'), 'and no comment tail');
});

test('the legacy comment filler is wired from the board and paints wherever the slot is', () => {
  // The board's repaint wires it on its next line, exactly as the Workshop's
  // does — the store flushes synchronously, so the slots it walks are the
  // ones just rendered.
  assert.match(APP_VIEW_SRC,
    /AppView\._fillKudosHosts\(board\);[\s\S]{0,400}?AppView\._wireFeedComments\(board\);/,
    'the board repaint wires the filler');
  // A fold happens BETWEEN publishes, so the column re-wires on its own —
  // from `#dev-kanban`, not from the column. `_wireFeedComments` keeps one
  // observer and replaces it on every call, so a per-column call would leave
  // three of the four columns unwatched. Four columns asking in one paint is
  // still one wiring pass: the filler collects its callers and runs once.
  assert.match(APP_VIEW_SRC, /if \(!AppView\._feedWireRoots\) \{\s*AppView\._feedWireRoots = new Set\(\);\s*Promise\.resolve\(\)\.then\(\(\) => AppView\._wireFeedCommentsNow\(\)\);\s*\}\s*AppView\._feedWireRoots\.add\(root\);/);
  assert.match(KANBAN, /callAppView\('_wireFeedComments', host\.closest\('#dev-kanban'\) \|\| host\);/);
  assert.match(KANBAN, /\}, \[unfolded\]\);/, 'keyed on ?cards=open, as the kudos filler is: nothing unfolds in place (#4486)');

  // And the paint is document-wide: the same issue can hold a slot in more
  // than one place at once, and none of them is guaranteed to be under
  // `#dev-workshop` any more.
  const fill = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('async _fillFeedComments(slot)'));
  const body = fill.slice(0, fill.indexOf('\n  },'));
  assert.ok(!/getElementById\('dev-workshop'\)/.test(body), 'the paint is not scoped to the Workshop host');
  assert.match(body, /document\.querySelectorAll\(\s*`\.dev-feed-comments\[data-comments-for="\$\{number\}"\]`\s*\)/);
  // ...unless it is already showing that answer: the board is repainted many
  // times over while it loads, and writing the same HTML again re-applied the
  // stylesheet to the whole board each time (tests/dev-comment-clamp.test.js
  // holds the behaviour; this holds the order).
  assert.match(
    body,
    /for \(const node of live\) \{[\s\S]*?if \(AppView\._feedSlotShows\(node, html\)\) continue;\s*node\.innerHTML = html;\s*AppView\._feedCommentsPainted\.set\(node, html\);\s*AppView\._clampFeedComments\(node\);\s*\}/,
    'every live slot gets the answer, and its own clamp measurement (#2556)',
  );
});

test('the comment and thread CSS is scoped to both card hosts, at the weight it had', () => {
  // `:is()` takes the specificity of its most specific argument, so `:is(#a,
  // #b) .x` weighs exactly what `#a .x` weighed. app.css was written against
  // a cascade where these rules sit at that weight; widening the scope must
  // not also move them in it.
  const scoped = CSS.split('\n').filter((l) => /^\s*(\.dark\s+)?:is\(#dev-workshop, #dev-kanban\) \.dev-feed-/.test(l));
  assert.ok(scoped.length >= 15, `the whole comment/thread block moved, not part of it (${scoped.length})`);
  for (const l of ['.dev-feed-comments:empty', '.dev-feed-comment-author', '.dev-feed-thread {', '.dev-feed-thread:empty', '.dev-feed-earlier']) {
    assert.ok(scoped.some((s) => s.includes(l)), `${l} is scoped to both hosts`);
  }
  // Nothing in that block is still Workshop-only.
  const left = CSS.split('\n').filter((l) => /^\s*(\.dark\s+)?#dev-workshop \.dev-feed-(comment|thread|earlier)/.test(l));
  assert.deepEqual(left, [], 'no comment or thread rule is left scoped to the Workshop alone');
  // The SHEET moved with them. A reply box hanging on a column's background
  // with no container is not the control the Workshop offers, it is a third
  // presentation of it — and the `:only-child` rule (asserted value for value
  // in tests/workshop-sheet-flush-card.test.js) is what keeps a board card
  // with nothing under it covering every edge of that sheet, so a quiet
  // column looks as it did.
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-entry \{/);
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-entry > div:is\(\.dev-card-dense, \.dev-card-topic\):only-child \{/);
  assert.deepEqual(
    CSS.split('\n').filter((l) => /^\s*#dev-workshop \.dev-feed-entry/.test(l)), [],
    'no sheet rule is left scoped to the Workshop alone');
});

test('the three controls #1884 names are the same three on every surface', () => {
  // The request lists them: a Reply input, open on its own page, recent
  // comments. Two were missing from the Board and are added by the rows
  // above. The third was on both — but "Open card" LED somewhere different
  // depending on the surface, which is the same complaint one control
  // further down, so it is settled here too.
  //
  // What this pins is that none of the three is decided per-surface any
  // more: one component, one set of props, and nothing in it branching on
  // which screen drew the card.
  assert.ok(!/OpenMode|expand[?:]|'inline'/.test(FOLD),
    'no open mode: "Open card" is the item\u2019s page, whichever surface drew it');
  assert.match(FOLD, /const openBtn = placement && href\s*\? <a className="gc-vote-btn dev-ws-open-btn" href=\{href\} data-ws-open-card=\{row\.key\}>\{t\('project:card\.fold\.openCard'\)\}<\/a>/);
  assert.equal(message('project:card.fold.openCard'), 'Open card');
  // The reply box and the comment tail are the ROW's to carry, and both
  // surfaces build rows through the one helper (asserted above).
  assert.match(FOLD, /\{row\.commentsFor != null \? \(/);
  assert.match(FOLD, /\{row\.thread && slug \? \(/);
  // Nothing is keyed on the surface: the open row takes the row, the slug,
  // whether the viewer may post, where the pill sits, and how to fold.
  const sig = FOLD.slice(FOLD.indexOf('export function UnfoldedRow'));
  assert.match(sig.slice(0, sig.indexOf('): ReactNode {')),
    /row, slug, canPost, detail: placement = 'actions', onFold,/,
    'nothing in the signature decides behaviour per surface');
});

test('a declared check reads the reply box off a board card', () => {
  const checks = DAPP.tests.filter((t) => /dev-kanban[\s\S]*dev-feed-thread/.test(t.expectSelector || ''));
  assert.equal(checks.length, 1, 'exactly one check makes this claim');
  const c = checks[0];
  // `cards=open` because the board folds its cards and the thread only exists
  // inside an unfolded one. The ROUTE is the one every other `#dev-kanban`
  // check already runs on, and that is not incidental: the first attempt at
  // this check used `#app/<slug>/board` with a `col=` narrowing, a pairing
  // nothing else in the manifest uses, and it was the only one of 662 to
  // fail on staging. A declared check is not the place to try a new route.
  assert.match(c.path, /[?&]cards=open(&|#|$)/, 'the state the thread exists in');
  const proven = new Set(DAPP.tests
    .filter((t) => t !== c && /#dev-kanban[ .[]/.test(t.expectSelector || ''))
    .map((t) => t.path));
  assert.ok(proven.size >= 2, 'there are established #dev-kanban checks to follow');
  assert.ok(proven.has(c.path),
    `the route is one other #dev-kanban checks already run on (have: ${[...proven].join(', ')})`);
  assert.match(c.expectSelector, /textarea\[aria-label="Reply to this item"\]/);

  // And the chain it walks, resolved against the markup the real components
  // render. A declared check GATES MERGE, and finding out it does not match
  // costs a staging build and a capture run; this costs milliseconds.
  const html = kanbanHtml(makeAppView({ search: '?cards=open&demo=1' }));
  assert.match(html, new RegExp([
    '<div class="dev-ws-rowwrap dev-ws-rowwrap-open">',
    '<div class="dev-feed-entry dev-ws-sheet"[^>]*>',
    '<div class="gc-vote-item[^"]*\\bdev-card-dense\\b[^"]*"[^>]*\\bdata-issue-row="\\d+"',
    '(?:(?!<div class="dev-feed-entry)[\\s\\S])*?',
    '<div class="dev-feed-comments" data-comments-for="\\d+"></div>',
    '<div class="dev-feed-thread"><div class="dev-feed-reply"><div class="messages-composer ">',
    '<div class="messages-composer-card">(?:(?!<textarea)[\\s\\S])*?',
    '<textarea[^>]*aria-label="Reply to this item"',
    '(?:(?!messages-send)[\\s\\S])*?',
    '<button type="button"[^>]*class="messages-send"',
  ].join('')), 'the selector\u2019s chain exists in the rendered board');
});
