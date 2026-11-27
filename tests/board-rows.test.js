// All items' board draws the Workshop's row (#4486).
//
// The four columns drew the folded card (card/fold.tsx), which unfolded in
// place under a ⇕. They draw the Workshop tab's row now
// (frontend/src/features/dev-board/workshop/work-row.tsx, variant `board`),
// each column one card of rows under the pipeline's steps. This file pins:
//
//   * a column draws the board variant: no tile, the line in the board's
//     words, the category chip and the 💬 count leading the tags, the card's
//     status bar and Vote across the row, and ☰ carrying the card's own menu
//     key; Done leads its tags with the short "✓ Live" bar instead;
//   * the row keeps the item's hooks, and opens the item's page;
//   * `?cards=open` still draws every card unfolded;
//   * a private session on a request folds into that request's row, and one
//     on no request is its own row at the top of Underway, tagged "Only you";
//   * the column heads are one stage strip: steps with icon, count and arrow,
//     the phone's tabs;
//   * Waiting for approval keeps its order toggle, at the top of its card,
//     and Done's pager says "Show N more".
//
// Run with: node --test tests/board-rows.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml, workshopHtml } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const KANBAN = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const ROW = read('frontend/src/features/dev-board/workshop/work-row.tsx');
const CSS = read('public/css/app.css');

const at = (d) => new Date(Date.now() - d * 86400000).toISOString();
const count = (html, re) => (html.match(re) || []).length;

function makeAppView({ search = '', mySessions = [] } = {}) {
  const store = {};
  const sandbox = {
    console, relTime: () => '2h ago',
    // app-view.js words its cards through the English runtime.
    PlatformI18n: englishPlatformI18n(),
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
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search, hash: '', href: `http://localhost/${search}` }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._ghIssues = [
    {
      number: 1575, title: 'Replace the oversized Game Corner header with bottom tabs', createdAt: at(4), updatedAt: at(2),
      lastMessageAt: at(2), user: 'sam', created_by_username: 'sam', htmlUrl: 'x', chatCount: 3,
      category: { top: 'bug', count: 1, myValue: null },
      in_progress: {
        count: 0, users: [], peopleTotal: 1, mine: false, sessions: [],
        claims: [{ username: 'zura', userId: 9, mine: false, claimedAt: at(1), expiresAt: at(-6) }], target: null,
      },
    },
    { number: 1574, title: 'Cut the Game Corner header’s self-explanation', createdAt: at(4), updatedAt: at(3), lastMessageAt: null, user: 'sam', created_by_username: 'sam', htmlUrl: 'x' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 1540, pr_title: 'Rewrite the email-confirmation email around one clear CTA',
    pr_url: 'https://github.com/acme/app/pull/1540', category: { top: 'feature', count: 1, myValue: null },
    status: 'promoted', username: 'evan', user_id: 7, created_at: at(1), promoted_at: at(1), last_message_at: at(1),
    linked_issues: [1574], my_vote: null, votes_for: 0, votes_against: 0, yes_count: 0, no_count: 0,
    check_state: 'passing', message_count: 5,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 1572, pr_title: 'Add screen transitions to Game Corner', status: 'merged',
    username: 'alice', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr', linked_issues: [1500],
    yes_count: 3, no_count: 1, votes_required: 3,
  }];
  AppView._mergedCtx = { majority: 1, activeUsers: 2 };
  AppView._mergedTotal = 2750; AppView._mergedHasMore = true;
  AppView._mySessions = mySessions; AppView._sharedSessions = []; AppView._devDataReady = true;
  return AppView;
}

/** One column's own markup, from its id to the next column's. */
function column(html, key) {
  const from = html.indexOf(`id="dev-kanban-col-${key}"`);
  assert.ok(from > 0, `the ${key} column is drawn`);
  const next = html.indexOf('id="dev-kanban-col-', from + 10);
  return html.slice(from, next > 0 ? next : html.length);
}

test('a board column draws the board variant: no tile, the line in words, the card parts on the row', () => {
  const AppView = makeAppView();
  const view = AppView._kanbanView();
  const cards = view.cols.reduce((n, c) => n + c.rows.filter((r) => r.t === 'card').length, 0);
  for (const col of view.cols) {
    for (const r of col.rows.filter((x) => x.t === 'card')) assert.ok(r.brief, `${r.key} carries its brief`);
  }
  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-wrow dev-ws-brow"/g), cards, 'one board row per card');
  assert.ok(!html.includes('dev-ws-rowwrap'), 'nothing folds');
  assert.ok(!html.includes('dev-fold-mark'), 'and nothing wears the fold mark');
  assert.ok(!html.includes('dev-ws-wrow-tile'), 'no tile: the column says what each row is');
  assert.ok(!/data-edge=/.test(html), 'no coloured edge');
  assert.ok(!html.includes('dev-card-icon'), 'no coloured glyph');

  // A request Underway: its author and age, then its number, in words; the category
  // chip and the 💬 count lead the tags; who is on it in words; ☰.
  const under = column(html, 'inprogress');
  assert.match(under, /<div class="dev-ws-wrow dev-ws-brow" data-ws-row="issue:1575" data-ws-kind="request" data-ws-open="issue:1575" data-issue-row="1575" data-ws-noun="request" data-ws-num="1575">/,
    'the item’s hook rides on the row, as on the folded card it replaces');
  assert.match(under, /<a class="dev-ws-wrow-link" href="#app\/demo-app\/dev\/issues\/1575"[^>]*>Replace the oversized Game Corner header with bottom tabs<\/a><span class="dev-ws-wrow-sub">sam · 4d ago · R#1575<\/span>/);
  assert.match(under, /<span class="dev-ws-wrow-status"><button type="button" class="attr-chip dev-badge [^"]*" data-attr-chip="" data-attr-field="category"[^>]*>[\s\S]*?Bug[\s\S]*?<\/button><span class="dev-chat-badge dev-badge [^"]*" data-count="3"[^>]*>💬 3<\/span><span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-tag">Picked up · zura<\/span><\/span>/,
    'category chip, then 💬, then who is on it');
  // (The tags are the one tag now, @/components/ui/state-tag: plain, or
  // working with its turning mark. `dev-ws-tag` stays for the declared checks.)
  assert.ok(!/data-attr-field="assignee"/.test(under), 'no @ chip: the tag says who');
  assert.match(under, /<span class="dev-ws-wrow-menu"><button type="button" class="gc-vote-btn gc-vote-btn-icon dev-card-menu-btn" data-card-menu="issue:1575"/,
    '☰ is the card’s own trigger with the card’s own key');

  // A change waiting for approval: "for #1574", "Checks passed", and the
  // card's bar with Vote across the row.
  const wait = column(html, 'inreview');
  assert.match(wait, /<span class="dev-ws-wrow-sub">evan · 1d ago · PR#1540 · for #1574<\/span>/);
  assert.match(wait, /<span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-tag"><svg[^>]*>[\s\S]*?<\/svg>Checks passed<\/span>/);
  // The change's state is the one tag (dev-card.tsx ChangeTag): a vote that
  // waits on the viewer is its needs-you state, in the server's words.
  assert.match(wait, /<span class="dev-ws-row-band"><span data-state-tag="needs" class="one-tag one-tag-strong" data-pill-key="needs_vote"[^>]*><span class="one-tag-words">Vote · 0\/1<\/span><\/span><span class="dev-ws-row-trailing"><button type="button" class="dev-vote-btn"/,
    'the state with its own words, then Vote, and none of the band’s chips');
  assert.ok(!/imported from|built with/.test(wait), 'no provenance on the row');

  // Done: every row is live, so the bar leads the tags at its words' width,
  // and there is no band.
  const done = column(html, 'done');
  assert.match(done, /<span class="dev-ws-wrow-sub">alice · 2d ago · PR#1572 · closed #1500<\/span><span class="dev-ws-wrow-status"><span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-wrow-live"[^>]*><span class="one-tag-words">✓ Live<\/span><\/span><span class="dev-ws-wrow-tally" title="3 yes and 1 no\. It needed 3 yes to pass\.">3 yes · 1 no<\/span>/,
    '#6075: the final counted vote sits beside the live pill');
  assert.ok(!done.includes('dev-ws-row-band'), 'no bar across a live row');
  assert.ok(!/dev-ws-tag"[^>]*>(?:<svg[^>]*>[\s\S]*?<\/svg>)?Live</.test(done), 'and no second, small Live tag');

  // #4718: the board's rows carry no votes line — the bar and Vote stay on
  // the band under the row, and live rows keep their one tags line.
  assert.ok(!html.includes('dev-ws-wrow-votes'), 'no votes line on the board');
});

test('#6075: a live row with no counted votes shows no tally', () => {
  const AppView = makeAppView();
  // An imported PR: no counted votes, so its live row carries no tally and
  // never reads "0/1".
  AppView._merged = [{
    id: 79, pr_number: 1571, pr_title: 'Bump the image library', status: 'merged',
    username: 'dependabot', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  const done = column(kanbanHtml(AppView), 'done');
  assert.match(done, /dev-ws-wrow-live"[^>]*><span class="one-tag-words">✓ Live<\/span><\/span><\/span>/,
    'the live pill is the tags line’s only state');
  assert.ok(!done.includes('dev-ws-wrow-tally'), 'no counted votes, no tally');
});

test('#6835: a deploying row in Done says "Going live" once', () => {
  const AppView = makeAppView();
  // Merged, and production not yet known to run it: the pill is the deploying
  // one, and the brief's settled tag said the same words a second time.
  AppView._merged = [{
    id: 80, pr_number: 1573, pr_title: 'Draw the board as Home and the hub are drawn', status: 'merged',
    username: 'alice', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
    linked_issues: [6834], deployment_state: 'deploying', live_at: null,
  }];
  const done = column(kanbanHtml(AppView), 'done');
  const from = done.indexOf('data-ws-kind="live"');
  assert.ok(from > 0, 'the live row is drawn');
  const next = done.indexOf('class="dev-ws-wrow dev-ws-brow"', from);
  const row = done.slice(from, next > 0 ? next : done.length);
  const goingLive = message('changes:badge.pill.goingLive');
  assert.match(row, /<span data-state-tag="working" class="one-tag one-tag-plain one-tag-working dev-ws-wrow-live" data-pill-key="deploying" title="[^"]+"><span class="dc-status-spinner-arc" aria-hidden="true"><\/span>/,
    'the deploying pill leads the row, turning, with its release sentence as its hover text');
  assert.equal(row.split(goingLive).length - 1, 1, 'it is said once on the row');
  assert.ok(!/one-tag-working dev-ws-tag"/.test(row), 'and no second, spinning Going live tag');
});

test('the row’s parts: its source', () => {
  assert.match(ROW, /\{board \? null : <span className="dev-ws-wrow-tile"/, 'the tile is the Workshop tab’s alone');
  assert.match(ROW, /\{\.\.\.\(board \? itemHooks\(card\) : \{\}\)\}/, 'the hooks, on the board only');
  assert.match(ROW, /<RowBand card=\{card\} chips=\{false\} trailing=\{specs \? <VoteButton yes=\{specs\.yes\} no=\{specs\.no\} \/> : null\} \/>/);
  assert.match(ROW, /\{menuKey \? <span className="dev-ws-wrow-menu"><MenuTrigger menuKey=\{menuKey\} \/><\/span> : null\}/);
  // The delegated card-open handler stands aside for a click in a row: the
  // row's own link opens the page, beside the board on a wide window.
  assert.match(APP_VIEW_SRC, /n\.classList\.contains\('dev-ws-rowwrap'\) \|\| n\.classList\.contains\('dev-ws-wrow'\)/);
  const AppView = makeAppView();
  const row = { classList: { contains: (c) => c === 'dev-ws-wrow' } };
  const leaf = { closest: () => null };
  assert.equal(AppView._inFoldWrapper({ target: leaf, composedPath: () => [leaf, row] }), true);
});

test('?cards=open still draws every card unfolded, the board as it was', () => {
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  const view = AppView._kanbanView();
  assert.equal(view.unfolded, true);
  const cards = view.cols.reduce((n, c) => n + c.rows.filter((r) => r.t === 'card').length, 0);
  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"/g), cards, 'every card open');
  assert.equal(count(html, /class="gc-vote-item [^"]*dev-card-dense"/g), cards);
  assert.ok(!html.includes('dev-ws-brow'), 'and no row drawn beside them');
  assert.match(html, /<div id="dev-kanban" data-kanban-active="issues" data-cards-open="">/);
  assert.match(KANBAN, /\} else if \(unfolded\) \{\s*cards = \(\s*<div className="space-y-2">/);
});

test('a private session on a request folds into that request’s row; one on no request leads Underway, tagged Only you', () => {
  const sessions = [
    { id: 51, session_title: 'Spec for #1575', status: 'paused', pr_number: null, linked_issues: [1575], shared_at: null, created_at: at(1), last_activity_at: at(0) },
    { id: 52, session_title: 'A loose idea', status: 'paused', pr_number: null, linked_issues: [], shared_at: null, created_at: at(1), last_activity_at: at(0) },
  ];
  const AppView = makeAppView({ mySessions: sessions });
  const view = AppView._kanbanView();
  const under = view.cols.find((c) => c.key === 'inprogress');
  const keys = under.rows.map((r) => r.key);
  assert.ok(!keys.includes('my-session:51'), 'the session on #1575 is not a row of its own');
  assert.ok(!keys.some((k) => /^div:private/.test(k)), 'no "Yours · not shared" divider');
  assert.equal(keys[0], 'my-session:52', 'the session on no request leads the column');
  assert.equal(under.count, under.rows.filter((r) => r.t === 'card').length, 'and the count is the rows drawn');
  const req = under.rows.find((r) => r.key === 'issue:1575');
  assert.deepEqual(JSON.parse(JSON.stringify(req.brief.tags.map((t) => t.label))), ['Picked up · zura', 'Spec draft · only you']);
  const loose = under.rows.find((r) => r.key === 'my-session:52');
  assert.equal(loose.brief.tags[0].label, 'Only you');
  assert.equal(loose.brief.tags[0].glyph, 'lock');

  const html = kanbanHtml(AppView);
  assert.match(html, /<span data-state-tag="plain" class="one-tag one-tag-plain dev-ws-tag" title="[^"]*"><svg[^>]*>[\s\S]*?<\/svg>Spec draft · only you<\/span>/,
    'drawn with its lock');
  assert.ok(!html.includes('Yours · not shared'));
});

test('By category folds a private session into its request the same way', () => {
  const sessions = [
    { id: 51, session_title: 'Spec for #1575', status: 'paused', pr_number: null, linked_issues: [1575], shared_at: null, created_at: at(1), last_activity_at: at(0) },
  ];
  const AppView = makeAppView({ mySessions: sessions });
  const v = AppView._workshopView();
  const rows = v.themes.flatMap((t) => t.lanes.flatMap((l) => l.rows));
  assert.ok(!rows.some((r) => r.key === 'my-session:51'), 'not a second item underway');
  const req = rows.find((r) => r.key === 'issue:1575');
  assert.ok(req.brief.tags.some((t) => t.label === 'Spec draft · only you'));
});

test('the column heads are one stage strip: steps with icon, count and arrow, and the phone’s tabs', () => {
  const AppView = makeAppView();
  const html = kanbanHtml(AppView);
  assert.match(html, /^<div id="dev-kanban-tabs" role="tablist" aria-label="Board columns" class="dev-kanban-stages">/);
  const steps = html.slice(0, html.indexOf('<div id="dev-kanban"'));
  assert.equal(count(steps, /role="tab"/g), 4);
  for (const [key, title] of [['issues', 'Requests'], ['inprogress', 'Underway'], ['inreview', 'Waiting for approval'], ['done', 'Done']]) {
    assert.match(steps, new RegExp(`<button type="button" role="tab" id="dev-kanban-tab-${key}" data-kanban-tab="${key}" aria-selected="(true|false)" aria-controls="dev-kanban-col-${key}" class="dev-kanban-step"[^>]*><span class="dev-kanban-step-tile" data-kind="${key}" aria-hidden="true"><svg`));
    assert.match(steps, new RegExp(`<span class="dev-kanban-step-name">${title}</span>`));
  }
  assert.match(steps, /<span class="dev-kanban-step-n">2,750<\/span>/, 'Done’s count, in words');
  assert.equal(count(steps, /class="dev-kanban-step-arrow[^"]*"/g), 3, 'an arrow between each step and the next');
  assert.ok(!html.includes('dev-kanban-col-head'), 'no head of its own over a column');
  // Each column names itself by its step.
  assert.match(html, /<div id="dev-kanban-col-done" data-kanban-col="done" class="dev-kanban-col" role="tabpanel" aria-labelledby="dev-kanban-tab-done">/);
  // The strip follows the board's sideways scroll; on a phone it is the tabs.
  assert.match(KANBAN, /onScroll=\{\(e\) => syncStrip\(e\.currentTarget\)\}/);
  assert.match(CSS, /\.dev-kanban-stages \{\s*display: grid; grid-template-columns: repeat\(4, minmax\(220px, 1fr\)\); column-gap: 20px;/);
  assert.match(CSS, /#dev-kanban \{\s*display: grid;\s*grid-template-columns: repeat\(4, minmax\(220px, 1fr\)\);\s*column-gap: 20px;/,
    'the strip and the board are one grid');
  assert.match(CSS, /\.dev-kanban-step\[aria-selected="true"\] \{ background: var\(--lit-tint\);/, 'the lit tab on a phone');
});

test('a column is one card: Waiting keeps its order toggle at its top, Done says what is live and how many more', () => {
  const AppView = makeAppView();
  AppView._mergedCtx.deployment = { kind: 'child', state: 'deployed', runningSha: 'abcdef0123', livePrNumber: 1572, pendingCount: 0 };
  // Not the child kind for this one: the parent's own boundary.
  AppView._mergedCtx.deployment = { state: 'deployed', runningSha: 'abcdef0123', livePrNumber: 1572, pendingCount: 0 };
  const html = kanbanHtml(AppView);
  const wait = column(html, 'inreview');
  assert.match(wait, /^id="dev-kanban-col-inreview"[^>]*><div class="dev-kanban-card"><div class="dev-kanban-lead"><button type="button" class="dev-ws-chip dev-kanban-sort" aria-label="Sort Waiting for approval: Newest\. Switch to Vote priority\."/);
  const done = column(html, 'done');
  assert.match(done, /<div class="dev-kanban-card"><p data-kanban-col-status="done" class="dev-kanban-lead dev-kanban-status [^"]*"[^>]*>Live in production through PR 1572 · abcdef0<\/p>/);
  assert.match(done, /<div class="dev-kanban-foot"><button type="button" class="dev-ws-reveal dev-kanban-more">Show 2,749 more<\/button><\/div><\/div><\/div>/,
    'Load more (N) is Show N more, at the foot of the card');
  assert.match(CSS, /\.dev-kanban-card \{\s*border-radius: 20px; padding: 2px 14px 8px;\s*background: var\(--dc-sheet-solid, var\(--bg-primary\)\);\s*box-shadow: inset 0 0 0 1px var\(--app-sheet-line\);/,
    'drawn like the shell’s other lists: the plane, 20px, one hairline');
});

test('All items in the Workshop: the head is one row, the strip pins with it, and rows open beside the board', () => {
  const AppView = makeAppView();
  const html = workshopHtml(AppView, 'all');
  assert.match(html, /<section class="dev-ws-pane" data-ws-pane=""><div class="dev-ws-pane-head"><div class="dev-ws-allbar" data-ws-allbar=""><div class="dev-ws-pagehead" data-ws-pagehead=""><button type="button" class="dev-ws-page-back un-touch-target" data-ws-page-back="" aria-label="Back to Workshop"/);
  assert.match(html, /<div class="dev-ws-pagehead-text"><h2 class="dev-ws-pagehead-title">All items<\/h2><\/div><\/div><div id="dev-actions"/,
    'no "Workshop" eyebrow and no grouping switch (request 6708), then the tools');
  assert.match(html, /<\/div><div id="dev-kanban-tabs" role="tablist" aria-label="Board columns" class="dev-kanban-stages">[\s\S]*?<\/div><\/div><div class="dev-ws-pane-body"><div class="dev-ws-board" data-ws-stage=""><div id="dev-kanban"/,
    'the strip is in the pinned head, the board in the body');
  assert.ok(!html.includes('data-ws-pagebar'), 'no back bar of its own above the pane');
});

test('#7101: a vote with no cached row still repaints once the server saves it', async () => {
  const AppView = makeAppView();
  // The board read this row from a list `_findItem` does not consult (or its
  // lists were not current), so no optimistic target existed and nothing
  // repainted when the vote was cast.
  AppView._proposals = [];
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._merged = [];
  AppView._topicProposal = null;
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  AppView._publishVoteSaved = () => {};
  AppView.refreshDevData = () => {};
  AppView._sendVote = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const ok = await AppView.castVote(7, 'yes');
  assert.equal(ok, true);
  assert.equal(repaints, 1, 'the board is repainted once, after the vote is saved');
});

test('a row is square at rest, so the hairline between rows runs straight', () => {
  // The hairline is the row's top border: a corner on the row bent both ends
  // of it down, and every row read as the top of a card of its own.
  assert.match(CSS, /\.dev-ws-wrow \{\s*position: relative; display: flex; align-items: flex-start; gap: 12px;\s*padding: 12px 2px; min-width: 0; border-radius: 0;\s*\}/);
  assert.match(CSS, /\.dev-ws-wrow \+ \.dev-ws-wrow,\s*\.dev-ws-week \+ \.dev-ws-week \{ border-top: 1px solid var\(--app-sheet-line\); \}/);
  // Lit (hovered, open beside the board, focused) it takes its corners, and
  // its own line goes clear as the next row's does.
  assert.match(CSS, /\.dev-ws-wrow:is\(:hover, \[data-on\], :has\(> \.dev-ws-wrow-main > \.dev-ws-wrow-link:focus-visible\)\) \{ border-radius: 12px; border-top-color: transparent; \}/);
  // A board row's title wraps without leaving one word ("ago", "now") on a
  // line of its own; its line in words keeps to one line (phone review #77:
  // wrapped in a narrow column, every line of it began with a stray "·").
  assert.match(CSS, /\.dev-ws-brow \.dev-ws-wrow-link \{ -webkit-line-clamp: 3; text-wrap: pretty; \}/);
  assert.match(CSS, /\.dev-ws-brow \.dev-ws-wrow-sub \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
});
