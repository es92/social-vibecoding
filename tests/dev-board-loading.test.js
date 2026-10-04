// The Dev board's, the launcher's and the topic view's LOADING states.
//
// ── The bug these exist for ────────────────────────────────────────────
//
// `_repaintDevBody()` paints from AppView's caches, and several things call it
// before those caches hold anything — a `session-state` flush does, ~550ms
// into a cold open, through `_repaintCards`. With empty caches the board drew
// four columns of "Nothing here yet · 0". That is not a slow screen, it is a
// WRONG one: it looks finished, so there is nothing for a reader to wait for.
// The reported symptom was "content loads without you realising it's loading",
// and a falsely-empty board is its worst case.
//
// So both view models carry `loading`, sourced from `AppView._devDataReady`,
// and the components draw placeholders instead of asserting a count or an
// emptiness nobody has measured yet.
//
// Run with: node --test tests/dev-board-loading.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml, workshopHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const BOARD_FRAME_SRC = read('frontend/src/features/dev-board/board-frame.tsx');
// `#dev-actions` — the filter host and the "+" — is its own component since the
// Workshop gained a copy of the toolbar in its pane. The row's own assertions
// read it directly; everything else about the frame still reads the frame.
const ACTIONS_SRC = read('frontend/src/features/dev-board/actions-row.tsx');
const FILTERS_SRC = read('frontend/src/features/dev-board/kanban-filters.tsx');

function makeAppView(over) {
  const o = over || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    // `_demoQS()` reads it on every request URL, so a sandbox without one
    // throws before the first fetch is issued.
    location: o.location || { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

/** A board with a card in every column — i.e. one that HAS loaded. */
function seed(AppView) {
  AppView._ghIssues = [{
    number: 1, title: 'Issue 1', updatedAt: '2026-06-01T01:00:00Z',
    lastMessageAt: '2026-06-01T01:00:00Z', headless: null,
  }];
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
}

// ── the flag itself ────────────────────────────────────────────────────

test('_devDataReady starts false and is set only by a COMPLETED load', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devDataReady, false, 'nothing has been fetched at construction');

  const code = APP_VIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // `_fetchDevData` is the body of the load. `_loadDevData` is the de-duping
  // wrapper in front of it (it joins a run already in flight, so the preload
  // an app open starts and the board's own call share one round of requests),
  // and the wrapper touches no caches at all.
  const load = code.slice(code.indexOf('async _fetchDevData(slug'), code.indexOf('async _loadDevFeed('));
  const set = load.indexOf('AppView._devDataReady = true;');
  assert.notEqual(set, -1, '_loadDevData sets the flag');
  assert.ok(set < load.indexOf('return true;'), 'on the success path, before it returns true');
  // The catch arm must not claim readiness: a failed load leaves the
  // placeholders up and _loadDevFeed paints its own message.
  const failure = load.slice(load.indexOf('} catch {'));
  assert.ok(!failure.includes('_devDataReady = true'), 'a failed load does not mark the board ready');
});

// ── The preload, and the de-duplication that makes it pay ──────────────
//
// Opening an app now starts the Dev area's load immediately (AppView.open →
// prefetchDevData), so the board has its caches by the time the viewer asks
// for it. That is only a saving if the board's OWN call joins the run already
// in flight instead of issuing the same six requests beside it.

function countingFetch() {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = async (url) => {
    calls.push(String(url));
    await gate;
    return { ok: true, json: async () => ({}) };
  };
  return { fetch, calls, release: () => release() };
}

test('_loadDevData joins the run already in flight rather than doubling it', async () => {
  const { fetch, calls, release } = countingFetch();
  const AppView = makeAppView({ fetch });
  AppView.appData = { slug: 'demo-app' };

  const first = AppView._loadDevData();
  const roundOne = calls.length;
  assert.ok(roundOne > 0, 'the first call issues the requests');

  const second = AppView._loadDevData();
  assert.equal(calls.length, roundOne, 'the second call adds no requests of its own');
  assert.equal(second, first, '…because it is handed the same promise');

  release();
  assert.equal(await first, true);
  assert.equal(await second, true);

  // Once the run has settled the slot clears, so the NEXT caller gets a fresh
  // load: this is a de-duplicator, not a cache, and every existing caller
  // means "the current state" (a pull-to-refresh, a merge broadcast, a vote).
  assert.equal(AppView._devDataInflight, null, 'the in-flight slot clears when the run ends');
  const after = calls.length;
  void AppView._loadDevData();
  assert.ok(calls.length > after, 'a later call really does go to the network again');
});

test('prefetchDevData starts a load for the open app, and only for it', async () => {
  const { fetch, calls, release } = countingFetch();
  const AppView = makeAppView({ fetch });
  AppView.appData = { slug: 'demo-app' };

  AppView.prefetchDevData('another-app');
  assert.equal(calls.length, 0, 'never loads an app that is not the one on screen');

  AppView.prefetchDevData('demo-app');
  const started = calls.length;
  assert.ok(started > 0, 'the open app warms its caches');

  // Already warm: nothing is waiting on a second round.
  release();
  await AppView._devDataInflight;
  assert.equal(AppView._devDataReady, true);
  AppView.prefetchDevData('demo-app');
  assert.equal(calls.length, started, 'a loaded board is not re-fetched by the preload');
});

test('the flag is cleared when the board stops being this app\'s', () => {
  const code = APP_VIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // Switching apps: the caches still hold the PREVIOUS app's cards, and
  // painting those under the new app's name is worse than a placeholder.
  assert.match(
    code,
    /AppView\.appData\.slug !== appData\.slug\) \{[\s\S]{0,400}?AppView\._devDataReady = false;/,
    'open() clears it when the slug changes'
  );
  const close = code.slice(code.indexOf('close() {'), code.indexOf('close() {') + 2000);
  assert.match(close, /AppView\._devDataReady = false;/, 'close() clears it');
});

// ── what the surfaces do with it ───────────────────────────────────────

test('the empty filter host reserves the loaded search row height', () => {
  // The filter island deliberately draws nothing until its first publish.
  // The frame therefore has to reserve the space itself; relying on the "+"
  // masked the bug only until that button was hidden for a read-only viewer
  // of the self-hosted app.
  assert.match(FILTERS_SRC, /if \(!mounted\) return null;/,
    'the loading filter island has no child that could hold the row open');
  assert.match(
    ACTIONS_SRC,
    /readOnly && selfHosted \? 'hidden' : ''/,
    'the add button cannot be the loading spacer for every viewer'
  );

  const host = ACTIONS_SRC.match(
    /id="dev-kanban-filterbar" className="([^"]+)"/
  );
  assert.ok(host, 'the filter host keeps a literal, auditable class list');
  const hostClasses = host[1].split(/\s+/);
  assert.ok(!hostClasses.includes('empty:hidden'),
    'an empty host must remain in layout while the filters load');

  const reservedHeight = hostClasses.find((cls) => cls.startsWith('min-h-'));
  const searchStart = FILTERS_SRC.match(/const SEARCH_CLS = '([^']+)'/);
  assert.ok(searchStart, 'the search field starts with a literal height utility');
  const searchHeight = searchStart[1].split(/\s+/).find((cls) => cls.startsWith('h-'));
  assert.equal(reservedHeight?.slice('min-'.length), searchHeight,
    'the empty frame and loaded search occupy the same baseline row');
});

test('an unloaded board draws placeholders, not four empty columns', () => {
  const AppView = makeAppView();
  seed(AppView);            // data in the caches…
  AppView._devDataReady = false;  // …but the load has not landed.
  const html = kanbanHtml(AppView);

  assert.ok(!html.includes('Nothing here yet'),
    'the empty note is a claim about data nobody has seen yet');
  assert.ok(!/·\s*0/.test(html), 'and so is a zero count');
  assert.match(html, /animate-pulse/, 'placeholder rows are drawn instead');
  assert.match(html, /role="status"/, 'with one live-region label for a reader');
  // Every column says so, not just the one the mobile strip shows.
  // The first column is "Requests" since the UI overhaul (it was "Issues");
  // its key stays `issues`.
  for (const col of ['Requests', 'Underway', 'Waiting for approval', 'Done']) {
    assert.ok(html.includes(`Loading ${col}`), `${col} announces itself as loading`);
  }
});

test('a loaded board draws its counts and its empty notes again', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._devDataReady = true;
  const html = kanbanHtml(AppView);
  assert.ok(!html.includes('animate-pulse'), 'no placeholders once the data is real');
  assert.ok(html.includes('Nothing here yet'), 'the genuinely empty columns say so');
  assert.match(html, /Requests <span class="[^"]*font-mono">· 1<\/span>/,
    'the Requests count is the real one');
});

test('the Workshop shows placeholders before the load and its own rows after', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._devDataReady = false;
  const loading = workshopHtml(AppView);
  assert.match(loading, /animate-pulse/, 'placeholder rows');
  assert.ok(!loading.includes('Nothing on the board yet'),
    '"nothing on the board yet" is exactly the wrong thing to say mid-load');

  AppView._devDataReady = true;
  const done = workshopHtml(AppView);
  assert.ok(!done.includes('animate-pulse'), 'the placeholders go');
});

test('EVERY feed view model carries `loading`, because the store merges', () => {
  // lib/plain-store.js `set` merges a patch. A model that simply omitted the
  // key would inherit the previous publish's `true` — and the feed would sit
  // on its placeholders for the rest of the session.
  const code = APP_VIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.slice(code.indexOf('_workshopView() {'), code.indexOf('_mergedRowModel(row) {'));
  const returns = fn.match(/return \{[\s\S]*?\};/g) || [];
  assert.ok(returns.length >= 2, 'found the view models _workshopView can return');
  for (const r of returns) {
    assert.match(r, /loading:/, `this return path states loading: ${r.slice(0, 60)}…`);
  }
  const kanban = code.slice(code.indexOf('_kanbanView() {'));
  // The object grew (slug, canPost and the ?cards=open flag ride with it,
  // #1787) so it spans lines now; what matters is still that its ONE return
  // states `loading` from the flag.
  const kanbanFn = kanban.slice(0, kanban.indexOf('_onKanbanTabSelect'));
  assert.match(
    kanbanFn,
    /return \{\s*activeTab: AppView\._activeKanbanTab\(\), cols, loading: !AppView\._devDataReady,[\s\S]*?\};/,
    'the kanban model derives it from the flag, on its single return path'
  );
});

// ── "nothing to load YET" is not "the load failed" ─────────────────────

test('_loadDevData distinguishes not-ready from failed, and the feed respects it', async () => {
  const AppView = makeAppView();
  AppView.appData = null;
  assert.equal(await AppView._loadDevData(), null,
    'no app record yet → null, not false');

  const code = APP_VIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.slice(code.indexOf('async _loadDevFeed('),
    code.indexOf('_repaintDevBody() {', code.indexOf('async _loadDevFeed(')));
  const nullGuard = fn.indexOf('if (ok === null) return;');
  const failure = fn.indexOf('load the feed right now');
  assert.notEqual(nullGuard, -1, '_loadDevFeed returns early on null');
  assert.ok(nullGuard < failure,
    'the not-ready case is handled BEFORE the failure paint — claiming failure '
    + 'during a slow open is how the board came to show an error while loading');
});

// ── the launcher ───────────────────────────────────────────────────────

test('the home grid draws placeholders from the FIRST paint, prerender included', () => {
  const GRID = read('frontend/src/features/home/app-grid.tsx');
  // They used to wait one effect tick behind a `mounted` flag, so the first
  // client render matched the empty <div id="app-list"> the shell prerendered
  // — anything else is a hydration mismatch, which console.errors, which fails
  // proposal checks. The cost was written off as one frame.
  //
  // It is not one frame: public/sw.js serves that document to every navigation
  // it can win, and the bundle does not hydrate until it has parsed and run
  // (~2.2s on a 4x-throttled cold load). For all of it the launcher was blank,
  // which does not read as "loading", it reads as "you have no apps".
  //
  // So they render in NODE too. renderToStaticMarkup walks this same branch
  // with the same INITIAL store, the shipped document carries the
  // placeholders, and the first client render produces the identical tree —
  // the agreement is kept by making both sides draw them, not neither.
  // Comment-stripped: the block above the placeholders names the retired flag
  // twice while explaining why it went, which is the point of that comment.
  const gridCode = GRID.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bmounted\b/.test(gridCode),
    'the post-hydration gate is gone — nothing is left to delay them');
  assert.match(GRID, /!state\.ready && !state\.notice/,
    'placeholders while unready, unless there is a notice to show instead');
  assert.match(read('public/index.html'), /id="app-list"[\s\S]{0,400}?animate-pulse/,
    'and the shipped document proves it: the prerendered grid pulses');

  // A placeholder must not answer the queries a real tile answers. The tile
  // lives in the shared module now — the signed-out directory draws the same
  // one (features/auth/landing.tsx), so there is one copy to keep honest.
  const tile = read('frontend/src/features/apps/tile-skeleton.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!tile.includes('app-card'),
    'no .app-card on a placeholder — the kit placement recognizer and '
    + 'App._tileFor(slug) both select on it, and neither has an app to find');
  assert.ok(!tile.includes('data-slug'), 'and no slug to find it by');
});

// ── the topic view ─────────────────────────────────────────────────────

test('the topic thread host ships a placeholder from a stable constant', () => {
  const TOPIC = read('frontend/src/features/dev-board/topic-frame.tsx');
  assert.match(TOPIC, /^const THREAD_INITIAL = \{ __html: skeletonListHtml\(1\) \};$/m,
    'module-level, so React 19 does not rewrite the host on every re-render');
  assert.match(TOPIC, /id="dev-topic-thread"[\s\S]{0,120}dangerouslySetInnerHTML=\{THREAD_INITIAL\}/,
    'the host is filled from that constant');
});

// ── the shared builder ─────────────────────────────────────────────────

test('one skeleton module renders both the components and the HTML strings', () => {
  const SK = read('frontend/src/features/dev-board/card/skeleton.tsx');
  // The card geometry is stated once. Two copies drift the first time a card
  // changes shape, and the placeholder stops standing where the row lands.
  assert.match(SK, /export const SKELETON_CARD_CLS =/);
  assert.match(SK, /export function skeletonListHtml\(n: number\): string/);
  assert.match(SK, /rounded-2xl bg-white dark:bg-zinc-900/,
    'the placeholder sits on the same ground as a real card');
  // Tailwind's extractor is a regex over source text, so every width class
  // has to be a complete literal rather than a computed `w-${n}/4`.
  const widths = SK.match(/const (?:TITLE|SUB)_W = \[[^\]]*\]/g) || [];
  assert.equal(widths.length, 2, 'both width tables found');
  for (const w of widths) assert.ok(!w.includes('${'), 'no computed class names');
  const FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
  // Four rows, the Workshop's own loading count, so the hand-off is unseen (#2880).
  assert.match(FRAME, /skeletonListHtml\(4\)/, '#dev-body\'s initial content uses it too');
});
