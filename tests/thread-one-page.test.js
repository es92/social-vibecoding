'use strict';

// One page per thread (1 Nov 2026): a change built for a request has no page
// of its own; the request's page is the thread's page. Without a database
// (the server's half runs against PostgreSQL in thread-one-page-postgres.test.js
// and app-chat-postgres.test.js), this pins:
//
//   D1. The change's section carries what its page had: its status pill and
//       its own ⋯ (its view's `detail:` rows), its summary, a small before
//       and after whose Expand opens in the detail column beside the thread,
//       and the sheets its ⋯
//       and Testing card open. Its title is no door: this is its page.
//   D2. Its addresses land on the request's page at it, in place, with its
//       Votes card in view; a change with no request keeps its page.
//   D3. One discussion: a change's rows are in the request's stream, tagged
//       with the change, and of what happened only the lines worth keeping;
//       a live row of one of its changes reaches the open request page.
//   D4. A change for this request on another request's page is one line
//       that says where.
//   D5. Competing changes fold under their ballot, with no Vote of their own.
//
// Run with: node --test tests/thread-one-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOPIC = 'frontend/src/features/dev-board/topic';

const thread = (items, extra = {}) => ({
  thread: { id: 3, number: 10, kind: 'work', lead: 'request', title: null, state: 'open' },
  items,
  follow: null,
  ...extra,
});
const request = { type: 'request', id: 1, number: 10, title: 'Pin a message', status: 'open', replies: 2 };
const review = (id, number, closes = [10]) => ({
  type: 'change', id, number, title: `Change ${number}`, status: 'promoted', state: 'review', replies: 0, by: 'dewi', closes,
});

test('D3: a change\'s rows the request\'s page keeps: people, and only the events worth a line', () => {
  const { keptOnRequest } = loadTsx(`${TOPIC}/change-model.ts`);
  const row = (extra) => ({ id: 1, kind: 'system', systemText: '', specShare: null, ...extra });
  assert.equal(keptOnRequest(row({ kind: 'message' })), true, 'a reply');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'vote', actor: 'ana', vote: 'yes', reason: 'Small and right' } })), true, 'a vote with its reason');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'vote', actor: 'ana', vote: 'yes', reason: '' } })), false, 'a bare vote is the Votes card\'s');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'submitted', actor: 'dewi' } })), true, 'asked for approval');
  assert.equal(keptOnRequest(row({ stagingBuild: 'ready' })), true, 'the preview is ready');
  assert.equal(keptOnRequest(row({ stagingBuild: 'started' })), false, 'the build started is the Testing card\'s');
  assert.equal(keptOnRequest(row({ event: { type: 'merged', actor: '' }, systemText: 'Merged' })), true, 'it went live');
  assert.equal(keptOnRequest(row({ event: { type: 'notice', text: 'Checks passed.' } })), false, 'a notice is its cards\'');
  assert.equal(keptOnRequest(row({ kind: 'spec_share', specShare: { sharedBy: 'ana', version: 2, title: 'Pins' } })), true, 'a plan posted');
});

test('D3: the stream tags a change\'s rows with it, and keeps a reply on it apart from one on the request', () => {
  const src = read('frontend/src/features/group-chat/transcript.tsx');
  const rows = src.slice(src.indexOf('export function RequestRows('), src.indexOf('#4455: something that happened to a change'));
  // #7216: a vote's reason is the voter's own post, noted with the vote line.
  assert.match(rows, /requestStream\(requestVotePosts\(foldRepeats\(view\.messages\)\)\.filter\(\(m\) => !m\.changeOf \|\| keptOnRequest\(m\)\)\)/);
  assert.match(rows, /<ChangeEvent key=\{key\} msg=\{msg\} changeId=\{msg\.changeOf\.sessionId\} tag=\{tagOf\(msg\)\} \/>/);
  // #6236: a post about one of the request's changes also gets the See the
  // vote line (seeVote) instead of the vote card. #7221: the reason post right
  // under its vote's note takes no tag, because the note names the change.
  assert.match(rows, /<MessageRow key=\{key\} msg=\{msg\} grouped=\{grouped\} surface="thread" tag=\{afterVoteNote \? null : tagOf\(msg\)\} seeVote=\{seeVoteOf\(msg\)\} \/>/);
  assert.match(rows, /\(previous\.changeOf\?\.sessionId \?\? null\) === \(msg\.changeOf\?\.sessionId \?\? null\)/);
  assert.equal(message('project:topic.request.stream.onChange', { number: 6063 }), 'on Change #6063');
  assert.equal(message('project:topic.request.stream.onChangeUnnumbered'), 'on a change');
  const { publishRequestChanges, requestChangesStore } = loadTsx(`${TOPIC}/request-model.ts`);
  publishRequestChanges(10, [{ id: 91, number: 6063, title: 'Dark mode' }, { id: 92, number: null }]);
  // #6236: each change's title rides along, for the line under the bot's
  // "It's up for a vote" post that names the change (vote-card.tsx VoteLine).
  assert.deepEqual(JSON.parse(JSON.stringify(requestChangesStore.get())), { number: 10, numbers: { 91: 6063, 92: null }, titles: { 91: 'Dark mode', 92: null }, live: {} });
  // #116: a change that is live is marked, so its line says See the change.
  publishRequestChanges(10, [{ id: 91, number: 6063, title: 'Dark mode', state: 'merged' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(requestChangesStore.get().live)), { 91: true });
  publishRequestChanges(10, [{ id: 91, number: 6063, title: 'Dark mode' }, { id: 92, number: null }]);
  const head = read(`${TOPIC}/request-head.tsx`);
  assert.match(head, /publishRequestChanges\(r\.number, layout\.changes\);/);
  assert.match(head, /GroupChat\?\.setThreadMembers\?\.\('issue', r\.number, layout\.changes\.map\(\(c\) => c\.id\)\)/);
});

function groupChat() {
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    window: {}, URLSearchParams, location: { search: '' },
    setTimeout, clearTimeout, AbortController,
    document: {
      getElementById: () => null,
      // escapeHtml's text node, enough for a message's words.
      createElement: () => {
        const el = { set textContent(v) { el.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
        return el;
      },
    },
    App: { user: { id: 7, username: 'ana' } },
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'club';
  gc.render = gc.renderThread = gc.scrollToBottom = () => {};
  return gc;
}

test('D3: a row of one of its changes reads as that change\'s, and a live one reaches the request\'s page', () => {
  const gc = groupChat();
  const loaded = gc._messageView({ id: 5, user_id: 3, username: 'maya', content: 'Works.', msg_type: 'message', thread_type: 'session', thread_ref: 91 }, { language: 'request' });
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.changeOf)), { sessionId: 91 });
  const own = gc._messageView({ id: 6, user_id: 3, username: 'maya', content: 'Hi', msg_type: 'message', thread_type: 'issue', thread_ref: 10 }, { language: 'request' });
  assert.equal(own.changeOf, undefined, 'the request\'s own reply is untagged');
  const vote = gc._messageView({ id: 8, content: 'dewi voted yes: “Small and right.”', msg_type: 'vote', metadata: { vote: { sessionId: 91, prNumber: 6063 } }, thread_type: 'session', thread_ref: 91 }, { language: 'request' });
  assert.equal(vote.event.type, 'vote', 'its vote reads as an event of the change, with its reason');
  assert.equal(vote.event.reason, 'Small and right.');
  assert.equal(gc._messageView({ id: 9, content: 'x', msg_type: 'message', thread_type: 'session', thread_ref: 91 }, { language: 'change' }).changeOf, undefined,
    'on a change\'s own page nothing is tagged');

  gc.setThreadMembers('issue', 10, [91, 92]);
  gc._intoRequestThreads({ type: 'chat', id: 40, userId: 3, username: 'maya', content: 'Live', msgType: 'message', thread: { type: 'session', ref: 91 } });
  gc._intoRequestThreads({ type: 'chat', id: 41, userId: 3, username: 'maya', content: 'Elsewhere', msgType: 'message', thread: { type: 'session', ref: 99 } });
  gc._intoRequestThreads({ type: 'chat', id: 42, userId: 3, username: 'maya', content: 'On the request', msgType: 'message', thread: { type: 'issue', ref: 10 } });
  const held = gc._threadState('issue', 10).messages;
  assert.deepEqual(JSON.parse(JSON.stringify(held.map((m) => m.id))), [40], 'only its own changes\' rows, once');
  assert.equal(held[0].thread_type, 'session');
  assert.equal(held[0].thread_ref, 91, 'the copy says where it was written');
  assert.equal(gc._messageView(held[0], { language: 'request' }).changeOf.sessionId, 91);
  gc._intoRequestThreads({ type: 'chat', id: 40, content: 'Live', msgType: 'message', thread: { type: 'session', ref: 91 } });
  assert.equal(gc._threadState('issue', 10).messages.length, 1, 'a row already held is not added twice');
  gc.setThreadMembers('issue', 10, []);
  assert.equal(gc._threadMembers.size, 0);
});

test('D1: a change\'s line has its pill and its own ⋯, and its title is no door', () => {
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /const key = view\?\.card\.rail\?\.menuKey \|\| '';/, 'its view\'s own rows (AppView._topicCard registers them)');
  assert.match(src, /<button type="button" className="dev-thread-change-menu" data-card-menu=\{key\} aria-haspopup="true"/);
  assert.match(src, /data-thread-change-status=\{status\.key\}><ChangeTag s=\{pill\} \/>/);
  assert.match(src, /<h3 [^>]*data-thread-change-title=\{item\.id\}>/);
  assert.doesNotMatch(src, /openTopic\('proposal'/, 'nothing here opens a change page any more');
  assert.doesNotMatch(src, /data-thread-earlier/, 'the fold of its earlier replies is gone: they are in the discussion');
  // Its summary, its before and after, and its sheets.
  assert.match(src, /<RequestWords html=\{summary\} \/>/);
  // #6263: an out-of-date description says so here, as on a change's own
  // page, with that page's own words.
  assert.match(src, /\{view\?\.body\.summaryStale && summary\s*\?\s*<p className="dev-change-stale" role="note" data-thread-change-stale=\{item\.id\}>\{t\('project:topic\.change\.summaryStale'\)\}<\/p>/,
    'the stale note renders under the summary, in the catalog entry change-head.tsx uses');
  // #6230 (3 Nov 2026): Expand opens the change's before and after in the
  // detail column beside the thread, as a design's preview and a plan do,
  // instead of popping the viewer over the page; the request asked for it.
  // It is the one before & after viewer, the same one a change's own card
  // expands to (./shots-detail.ts).
  assert.match(src, /const open = \(\) => \{ if \(source\) openShotsDetail\(source\); \};/,
    'Expand opens the change\'s before and after in the detail column');
  assert.match(read(`${TOPIC}/shots-detail.ts`), /UsernodeReact\?\.detail\?\.open\(\{\s*kind: 'shots',\s*ref: \{ changeId: source\.sessionId \},/);
  assert.doesNotMatch(src, /showPopover/, 'the viewer no longer pops over the page');
  assert.match(src, /<ChangeSheets id=\{item\.id\} row=\{view\.row\} body=\{view\.body\} \/>/);
  const head = read(`${TOPIC}/topic-head.tsx`);
  const sheets = head.slice(head.indexOf('export function ChangeSheets('), head.indexOf('/** The same card on the owner session'));
  assert.match(sheets, /<DetailsSheet\s+id=\{id\}/, 'Details, Shot details and See what failed have their sheet here');
  assert.match(sheets, /<DescriptionEditor key=\{id\} id=\{id\} onSaved=\{\(data\) => av\._cacheDescription\(id, data\)\} \/>/);
  assert.match(sheets, /\{body\.canEditIssues \? \(\s+<IssueAssociations[\s\S]*?editorOnly/, 'and ⋯ Edit requests has its editor');
  assert.match(head, /if \(editorOnly\) \{\s+return editing \|\| notice \? \(/, 'nothing while it is shut');
  const view = read('public/js/app-view.js');
  assert.match(view, /return \{ state: 'verified', source: \{ shots, sessionId: Number\(item\.id\) \}, line: null, thumbs,/,
    'the thumbnails come with the shots their Expand opens');
  for (const id of ['more', 'moreNumbered', 'shotBefore', 'shotAfter', 'shotsOpen', 'shotsExpand']) {
    assert.ok(message(`project:topic.thread.page.${id}`, { number: 6063 }), id);
  }
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /\.dev-thread-shots-viewer/, 'no viewer is kept shut on the page');
});

test('D1: rendered, a change built for a request is a line with its title, and a ballot\'s folds start shut', () => {
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, review(91, 6063)]), number: 10, changes: [review(91, 6063)], close: null, onChanged: () => {},
  });
  assert.match(html, /data-thread-change="91"/);
  assert.match(html, /<h3 [^>]*data-thread-change-title="91"[^>]*>Change 6063<\/h3>/);
  assert.doesNotMatch(html, /data-thread-change-open/);

  const options = [review(93, 6067), review(94, 6068)];
  const ballot = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, ...options]), number: 10, changes: options, close: null, onChanged: () => {},
  });
  assert.match(ballot, /data-thread-ballot="2"/);
  assert.match(ballot, /data-thread-folds="2"/);
  assert.equal((ballot.match(/data-thread-fold="shut"/g) || []).length, 2, 'D5: each change folds under the ballot');
  assert.equal((ballot.match(/aria-expanded="false"/g) || []).length, 2);
  assert.ok(ballot.indexOf('data-change-gate="ballot"') < ballot.indexOf('data-thread-folds'), 'the ballot stays first');
  assert.equal((ballot.match(/data-change-row-open=/g) || []).length, 2, 'a row\'s title opens its fold');
});

test('#6139: the line under a change says whether it is still being built or finished', () => {
  const underway = { ...review(91, 6063), status: 'active', state: 'underway' };
  const draw = (item) => renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, item]), number: 10, changes: [item], close: null, onChanged: () => {},
  });
  const built = draw({ ...underway, ready: true });
  assert.ok(built.includes('data-thread-change-waiting="ready"'));
  assert.ok(built.includes(message('project:topic.thread.page.ready')));
  assert.ok(!built.includes(message('project:topic.thread.page.underway')), 'it does not say it is being built');
  const still = draw(underway);
  assert.ok(still.includes('data-thread-change-waiting="building"'));
  assert.ok(still.includes(message('project:topic.thread.page.underway')));
  assert.equal(message('project:topic.thread.page.ready'), 'Built, and its checks pass. Its votes open once it is put up for a vote.');
});

// #6599: a built draft of yours says its votes open once it is put up for a
// vote, and used to offer no way to do it: the only door was the old session
// view's Submit for review. Its card carries the call now (POST
// /api/sessions/:id/promote, the same one), and so does its ⋯.
test('#6599: a built draft of yours puts itself up for a vote from its card', () => {
  const underway = { ...review(91, 6581), status: 'active', state: 'underway' };
  const draw = (item) => renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, item]), number: 10, changes: [item], close: null, onChanged: () => {},
  });
  const signedIn = (readOnly = false, fn) => {
    globalThis.window = {
      App: { user: { id: 7, username: 'evan' } },
      AppView: { readOnly },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    try { return fn(); } finally { delete globalThis.window; }
  };
  const mine = signedIn(false, () => draw({ ...underway, ready: true, mine: true }));
  assert.match(mine, /data-thread-change-propose="91"/);
  assert.match(mine, /Put it up for a vote/);
  assert.ok(mine.includes(message('project:topic.thread.page.readyMine')), 'the shorter line under it');
  assert.equal(message('project:topic.thread.page.readyMine'), 'Built, and its checks pass.');
  assert.ok(!mine.includes(message('project:topic.thread.page.ready')), 'the waiting sentence is replaced, not repeated');
  assert.ok(!mine.includes('data-thread-change-propose-error'), 'nothing is said until it is pressed');

  const theirs = signedIn(false, () => draw({ ...underway, ready: true, mine: false }));
  assert.ok(!theirs.includes('data-thread-change-propose'), 'not theirs to propose: the sentence alone');
  assert.ok(theirs.includes(message('project:topic.thread.page.ready')));

  const readOnly = signedIn(true, () => draw({ ...underway, ready: true, mine: true }));
  assert.ok(!readOnly.includes('data-thread-change-propose'), 'a read-only view offers no action');

  const guest = draw({ ...underway, ready: true, mine: true });
  assert.ok(!guest.includes('data-thread-change-propose'), 'signed out, no action');

  const building = signedIn(false, () => draw({ ...underway, ready: false, mine: true }));
  assert.ok(!building.includes('data-thread-change-propose'), 'still being built: nothing to put up');
  assert.ok(building.includes(message('project:topic.thread.page.underway')));

  // Its checks ran and failed: it may still go up (the promote route takes
  // no verdict), and the line under the button says it merges only once
  // they pass.
  const failing = signedIn(false, () => draw({ ...underway, ready: false, promotable: true, mine: true }));
  assert.match(failing, /data-thread-change-propose="91"/, 'checks failed: it can still go up for a vote');
  assert.ok(failing.includes('data-thread-change-waiting="failing"'));
  assert.ok(failing.includes(message('project:topic.thread.page.failingMine').replace(/'/g, '&#x27;')), 'says it merges only once they pass');
  assert.ok(!failing.includes(message('project:topic.thread.page.readyMine')), 'not said to pass');
  const stillBuilding = signedIn(false, () => draw({ ...underway, ready: false, promotable: false, mine: true }));
  assert.ok(!stillBuilding.includes('data-thread-change-propose'), 'not promotable: nothing to put up');

  const promoted = signedIn(false, () => draw({ ...review(91, 6581), mine: true }));
  assert.ok(!promoted.includes('data-thread-change-propose'), 'up for a vote: its Vote card, not the button');

  // The ⋯ offers the same action, from the hook its line is drawn with; the
  // card's own button calls the same thing from its own instance.
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /useThreadMenu\(propose\.can \? key : null, 'propose', propose\.can/, 'the row goes on the change\'s own ⋯');
  assert.match(src, /\{ label: t\('project:topic\.thread\.page\.proposeAction'\), icon: 'default', act: propose\.propose \}/);
  assert.match(src, /const propose = useProposeChange\(item, onChanged\);\s*const thread = useContext\(ThreadCardContext\);\s*useInView/, 'the line and its ⋯ draw from one hook');
  assert.match(src, /<ChangeMenu item=\{item\} view=\{view\} propose=\{propose\} \/>/);
});

test('#6599: pressing it is the old Submit for review, and a refusal keeps Homeroom\'s own sentence', async () => {
  const { proposeChange } = loadTsx(`${TOPIC}/thread-changes.tsx`);
  const calls = [];
  const events = [];
  let answer = { ok: true, json: async () => ({ ok: true }) };
  const realFetch = globalThis.fetch;
  globalThis.window = { dispatchEvent: (e) => events.push(e) };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return answer; };
  try {
    assert.equal(await proposeChange(91), null);
    assert.equal(calls[0].url, '/api/sessions/91/promote');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.deepEqual(events.map((e) => [e.type, e.detail]), [['change-detail-refresh', 91]], 'its section reads again');

    answer = { ok: false, status: 409, json: async () => ({ error: 'proposal_not_ready', message: 'Nothing has been submitted to this change yet, so there is nothing to put up for review.' }) };
    assert.equal(await proposeChange(91), 'Nothing has been submitted to this change yet, so there is nothing to put up for review.');

    answer = { ok: false, status: 409, json: async () => ({ error: 'session_state_changed' }) };
    assert.equal(await proposeChange(91), message('project:topic.thread.page.proposeFailed'));
    assert.equal(message('project:topic.thread.page.proposeFailed'), 'Could not put this change up for the vote.');
    assert.equal(events.length, 1, 'a refusal asks nothing to be redrawn');

    answer = { ok: false, status: 404, json: async () => ({ error: 'Active session not found' }) };
    assert.equal(await proposeChange(91), 'Active session not found', 'a sentence the server wrote is shown as it is');

    answer = { ok: false, status: 500, json: async () => { throw new Error('not json'); } };
    assert.equal(await proposeChange(91), message('project:topic.thread.page.proposeFailed'), 'a body that is not JSON falls back');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
  }
});

test('#6139: an open request page reads its thread again when a change underway has news, once for a burst', async () => {
  const { rereadOnChangeNews } = loadTsx(`${TOPIC}/change-detail-refresh.ts`);
  const target = new EventTarget();
  let reads = 0;
  const tell = (detail) => target.dispatchEvent(new CustomEvent('change-detail-refresh', { detail }));
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });
  const subs = new Set();
  const sessionState = { onEvent: (cb) => { subs.add(cb); return () => subs.delete(cb); } };
  const stateEvent = (payload) => { for (const cb of subs) cb(payload); };
  const stop = rereadOnChangeNews(target, [{ id: 91, state: 'underway' }, { id: 92, state: 'review' }], () => { reads += 1; }, sessionState, 5);

  tell(92);
  tell(99);
  stateEvent({ sessionId: 92, busy: true });
  await settle();
  assert.equal(reads, 0, 'news of a change up for a vote, or of another change, moves nothing here');

  tell(91);
  tell({ id: 91, patch: { check_state: 'passing' } });
  tell({ id: 91, row: { id: 91 } });
  await settle();
  assert.equal(reads, 1, 'a bare id, a patch and a row all count, and a burst is one read');

  stateEvent({ sessionId: 91, busy: true, status: 'active' });
  await settle();
  assert.equal(reads, 2, 'a turn starting is a session_state event with the same status: heard');
  stateEvent({ sessionId: 91, busy: false, status: 'active' });
  await settle();
  assert.equal(reads, 3, 'and so is its end');

  tell(91);
  stateEvent({ sessionId: 91, busy: true });
  stop();
  assert.equal(subs.size, 0);
  await settle();
  assert.equal(reads, 3, 'a page that has gone reads nothing');

  assert.match(read(`${TOPIC}/request-head.tsx`), /useEffect\(\(\) => rereadOnChangeNews\(window, layout\.changes, threadRead\.reread, \(window as any\)\.SessionState\), \[underwayKey\]\);/);
  const payload = read(`${TOPIC}/thread-items.tsx`);
  assert.match(payload, /const unwatch = watch\(\(\) => \{\s*freshNext\.current = true;\s*setRevision\(\(n\) => n \+ 1\);\s*\}, \{ reads: threadReads\(pathname, slug, ids\) \}\);/, 'a gap reads it again, past a saved copy');
});

test('#6139: reading a thread again keeps it through a failed read and past a saved copy; another thread starts empty', async () => {
  // A React small enough to step through: the suite has no DOM.
  const slots = [];
  let cursor = 0;
  let dirty = false;
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return slots[i]; };
  const react = {
    ...require('../frontend/node_modules/react'),
    useRef: (current) => slot(() => ({ current })),
    useState: (initial) => {
      const s = slot(() => ({ value: initial }));
      return [s.value, (next) => { s.value = typeof next === 'function' ? next(s.value) : next; dirty = true; }];
    },
    useEffect: (effect, deps) => {
      const s = slot(() => ({ deps: null, cleanup: null }));
      if (s.deps && deps.every((v, i) => Object.is(v, s.deps[i]))) return;
      s.deps = deps;
      if (s.cleanup) s.cleanup();
      s.cleanup = effect();
    },
  };
  const watchers = new Set();
  const FRESH = { cache: 'no-cache' };
  const { useThreadPayload } = loadTsx(`${TOPIC}/thread-items.tsx`, {
    stubs: {
      react,
      '../../../lib/live-reads': { FRESH, watch: (reread) => { watchers.add(reread); return () => watchers.delete(reread); } },
    },
  });
  const calls = [];
  let answer = { ok: true, json: async () => ({ items: [{ id: 1 }] }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => { calls.push({ path, init }); return answer; };
  try {
    let out;
    const draw = async (number) => {
      do {
        dirty = false;
        cursor = 0;
        out = useThreadPayload('club', number);
        await new Promise((resolve) => { setImmediate(resolve); });
      } while (dirty);
    };
    await draw(10);
    assert.deepEqual(out.data.items, [{ id: 1 }]);
    assert.equal(calls.at(-1).path, '/api/apps/club/threads/10');
    assert.equal(calls.at(-1).init.cache, undefined);

    answer = { ok: false, json: async () => null };
    out.reread();
    await draw(10);
    assert.equal(calls.length, 2, 'read again');
    assert.deepEqual(out.data.items, [{ id: 1 }], 'a failed read again keeps what is shown');

    assert.equal(watchers.size, 1, 'one watcher, for as long as it shows');
    [...watchers][0]();
    await draw(10);
    assert.equal(calls.at(-1).init.cache, 'no-cache', 'a gap reads past the saved copy');

    await draw(11);
    assert.equal(calls.at(-1).path, '/api/apps/club/threads/11');
    assert.equal(out.data, null, 'another thread never shows the last one, even when its read fails');
    assert.equal(watchers.size, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('D5: a change folded under its ballot has no Vote of its own', () => {
  const head = read(`${TOPIC}/change-head.tsx`);
  assert.match(head, /<GateCard which="votes" g=\{v\.votes\} action=\{ballot \? null : voteAction\} id=\{id\} closes=\{closes\} \/>/);
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /<ChangeBody item=\{item\} view=\{view\} plan=\{plan\} ballot request=\{request\} \/>/);
  assert.match(src, /<ChangeGates id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} ballot=\{ballot\} closes=\{closesList\(item\)\} \/>/);
  assert.match(src, /querySelector<HTMLElement>\('\[data-change-gate="ballot"\]'\)/, 'a door to one of them lands on the ballot');
});

test('D4: a change for this request on another request\'s page is a card that names it', () => {
  const { elsewhereFor } = loadTsx(`${TOPIC}/thread-model.ts`);
  const elsewhere = [
    { id: 91, number: 12, title: 'Pin it', summary: 'Pin one message.', on: 10, request: 11, ask: true, mine: true, disputed: false },
    { id: 92, number: 13, title: 'x', on: 11, request: 11 },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(elsewhereFor(thread([], { elsewhere }), 11))), [elsewhere[0]], 'not one on this very page');
  assert.deepEqual(JSON.parse(JSON.stringify(elsewhereFor(thread([]), 11))), []);
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([{ ...request, number: 11 }], { elsewhere }), number: 11, changes: [], close: null, onChanged: () => {},
  });
  assert.match(html, /data-thread-elsewhere="1"/);
  assert.match(html, /<a [^>]*data-thread-elsewhere-on="10"[^>]*>Change #12<\/a> says it closes this/);
  assert.match(html, /Pin it/, 'the change\'s title');
  assert.match(html, /Pin one message\./, 'its one-line summary');
  assert.match(html, /data-thread-elsewhere-dispute="91"[^>]*>This doesn(?:'|&#x27;)t close it<\/button>/, 'the requester can answer it');
  assert.match(html, /data-thread-elsewhere-confirm="91"[^>]*>Confirm<\/button>/, '#6606: the filer can also confirm it');
  assert.match(read(`${TOPIC}/thread-changes.tsx`), /confirm-closing/, 'through the confirm route');
  const answered = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club',
    data: thread([{ ...request, number: 11 }], {
      elsewhere: [{ ...elsewhere[0], ask: false, disputed: true }],
    }),
    number: 11, changes: [], close: null, onChanged: () => {},
  });
  assert.doesNotMatch(answered, />This doesn(?:'|&#x27;)t close it<\/button>/, 'no button once answered');
  assert.match(answered, /You said this doesn(?:'|&#x27;)t close it/, 'the requester reads their answer back');
  const confirmed = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club',
    data: thread([{ ...request, number: 11 }], {
      elsewhere: [{ ...elsewhere[0], ask: false, confirmed: true }],
    }),
    number: 11, changes: [], close: null, onChanged: () => {},
  });
  assert.doesNotMatch(confirmed, /data-thread-elsewhere-confirm=/, 'no Confirm once answered');
  assert.match(confirmed, /You confirmed this closes it/, '#6606: the filer reads their answer back');
  assert.equal(message('project:topic.thread.page.claimConfirm'), 'Confirm');
  assert.equal(message('project:topic.thread.page.claimConfirmed'), 'You confirmed this closes it');
  assert.equal(message('project:topic.thread.page.claimsUnnumbered'), '<0>A change</0> says it closes this');
  assert.equal(message('project:topic.thread.page.claimNotConfirmed'), '(not confirmed)');
});

// #6605: a change that closes only requests that are already closed says so
// under its title, and a closed request's card says it is closed and offers
// nothing to answer. A change that belongs in this request's thread but
// stayed because of votes says why.
test('#6605: closed requests are named as closed, and a voted change says why it stayed', () => {
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /<AlreadyClosed item=\{item\} \/>/, 'the change\'s own card carries the line');
  assert.match(src, /data-thread-elsewhere-closed=\{e\.id\}/);
  assert.match(src, /data-thread-elsewhere-stays=\{e\.id\}/);

  assert.equal(message('project:topic.thread.page.alreadyClosed_one'), '<0>{{numbers}}</0> is already closed');
  assert.equal(message('project:topic.thread.page.alreadyClosed_other'), '<0>{{numbers}}</0> are already closed');
  assert.equal(message('project:topic.thread.page.claimClosed'), '#{{number}} is already closed');
  assert.equal(message('project:topic.thread.page.claimStays'), 'It stays on #{{on}} because people have voted on it.');

  const item = {
    ...review(93, 6581, [6581, 6582, 6583]),
    closesRequests: [
      { number: 6582, title: 'b', by: 'ana', confirmed: false, closed: true },
      { number: 6581, title: 'a', by: 'ana', confirmed: false, closed: true },
      { number: 6583, title: 'c', by: 'ana', confirmed: false, closed: true },
    ],
  };
  const elsewhere = [{ id: 91, number: 12, title: 'Pin it', on: 10, request: 11, ask: false, mine: true, disputed: false, closed: true, stays: false }];
  const wasWindow = globalThis.window;
  globalThis.window = { AppView: { appData: { slug: 'club' } }, addEventListener() {}, removeEventListener() {} };
  let html;
  let card;
  try {
    html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
      slug: 'club', data: thread([request, item]), number: 6581, changes: [item], close: null, onChanged: () => {},
    });
    card = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
      slug: 'club',
      data: thread([{ ...request, number: 11 }], {
        elsewhere: [{ ...elsewhere[0], closed: false, stays: true }],
      }),
      number: 11, changes: [], close: null, onChanged: () => {},
    });
  } finally {
    if (wasWindow === undefined) delete globalThis.window; else globalThis.window = wasWindow;
  }
  assert.match(html, /data-thread-change-closed="93"/);
  assert.match(html, /are already closed/, 'every request it closes is closed');
  assert.match(html, /data-thread-change-closed-on="6581"/, 'the first number links to its page');
  assert.match(html, /data-thread-change-closed-on="6582"/);
  assert.match(html, /data-thread-change-closed-on="6583"/);

  const closedCard = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club',
    data: thread([{ ...request, number: 11 }], { elsewhere }),
    number: 11, changes: [], close: null, onChanged: () => {},
  });
  assert.match(closedCard, /data-thread-elsewhere-closed="91"/);
  assert.match(closedCard, /#11 is already closed/);
  assert.doesNotMatch(closedCard, /data-thread-elsewhere-dispute="91"/, 'a closed request is not asked');
  assert.match(card, /data-thread-elsewhere-stays="91"/);
  assert.match(card, /It stays on #10 because people have voted on it\./);
});

// #6224: a change for several requests lives on its first one's page, so its
// section there must say which other requests it closes: the first three as
// links, then "N more" that unfolds the rest, from its linked_issues.
const TEN = [6159, 6207, 6210, 6212, 6214, 6215, 6218, 6219, 6220, 6221];

test('#6224: alsoCloses is the change\'s linked requests minus this page\'s, unique and ascending', () => {
  const { alsoCloses } = loadTsx(`${TOPIC}/thread-model.ts`);
  const closes = (numbers) => JSON.parse(JSON.stringify(alsoCloses(review(91, 6223, numbers), 6207)));
  assert.deepEqual(closes([6221, 6207, 6159, 6159]), [6159, 6221], 'ascending, without duplicates');
  assert.deepEqual(closes([6207]), [], 'only this request: nothing to say');
  assert.deepEqual(closes([6210]), [], 'it does not close this request at all');
  assert.deepEqual(closes([]), []);
});

test('#6224: a change that closes ten requests names the others, links three, and folds the rest', () => {
  const item = review(91, 6223, TEN);
  const wasWindow = globalThis.window;
  globalThis.window = { AppView: { appData: { slug: 'club' } }, addEventListener() {}, removeEventListener() {} };
  let html;
  try {
    html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
      slug: 'club', data: thread([request, item]), number: 6207, changes: [item], close: null, onChanged: () => {},
    });
  } finally {
    if (wasWindow === undefined) delete globalThis.window; else globalThis.window = wasWindow;
  }
  assert.match(html, /data-thread-change-also="91"/);
  assert.match(html, /data-thread-change-also-state="closes"/);
  assert.match(html, /Also closes <a /, 'the line starts with the words');
  const links = [...html.matchAll(/data-thread-change-also-on="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ['6159', '6210', '6212'], 'the first three others, ascending');
  assert.match(html, /href="#app\/club\/dev\/issues\/6159"/, 'each number opens that request\'s page');
  assert.match(html, /data-thread-change-also-more="6"[^>]*>6 more<\/button>/, 'the rest folded behind one tap');
  assert.equal(message('project:topic.thread.page.alsoMore', { count: 6 }), '6 more');
  assert.ok(html.indexOf('data-thread-change-title="91"') < html.indexOf('data-thread-change-also="91"'), 'under the title');
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.ok(src.indexOf('<AlsoCloses item={item} request={request} />') < src.indexOf('data-thread-change-summary'), 'above the summary');
});

test('#6224: once the change has merged the line says "Also closed"; three others need no fold', () => {
  const merged = { ...review(91, 6223, TEN), state: 'merged' };
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, merged]), number: 6207, changes: [merged], close: null, onChanged: () => {},
  });
  assert.match(html, /data-thread-change-also-state="closed"/);
  assert.match(html, /Also closed <a /);

  const three = review(92, 6064, [10, 11, 12, 13]);
  const short = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, three]), number: 10, changes: [three], close: null, onChanged: () => {},
  });
  assert.equal((short.match(/data-thread-change-also-on=/g) || []).length, 3);
  assert.doesNotMatch(short, /data-thread-change-also-more=/);
  assert.match(short, /Also closes /);
});

test('#6224: a change closing only this request shows no "Also closes" line', () => {
  const only = review(91, 6063, [10]);
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, only]), number: 10, changes: [only], close: null, onChanged: () => {},
  });
  assert.doesNotMatch(html, /data-thread-change-also=/);
  assert.doesNotMatch(html, /Also closes/);

  assert.equal(message('project:topic.thread.page.alsoMore', { count: 1 }), '1 more');
});

test('D2: a change built for a request lands on the request\'s page, at it; one with no request keeps its page', () => {
  const view = read('public/js/app-view.js');
  const sub = view.slice(view.indexOf('  async _renderTopicSubView(content, ref) {'), view.indexOf('    AppView._devTopic = ref.pr\n'));
  assert.match(sub, /if \(\(ref\.kind === 'proposal' \|\| ref\.kind === 'session'\) && ref\.id\) \{/, 'changes, proposals and shared addresses alike');
  assert.match(sub, /const home = await AppView\._requestHomeOf\(ref\.id\);\s+if \(AppView\._devTopic !== asked\) return;\s+if \(home\) \{[\s\S]{0,900}?AppView\._openChangeOnRequest\(home, ref\.id, \{ replaceRoute: true \}\);\s+return;/);
  assert.match(view, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/change\/\$\{n\}\$\{AppView\._demoQS\(\)\}`\)/);
  const open = view.slice(view.indexOf('  _openChangeOnRequest(number, sessionId, options = {}) {'));
  assert.match(open, /window\.UsernodeReact\?\.devBoard\?\.showVotes\?\.\(sessionId\);/, 'with its Votes card in view');
  assert.match(open, /return AppView\.openTopic\('issue', Number\(number\), options\.replaceRoute \? \{ replaceRoute: true \} : undefined\);/);
  assert.match(view, /if \(options && options\.replaceRoute\) return App\.switchTab\('dev', ref, 'topic', \{ replaceRoute: true \}\);/,
    'in place of the change\'s address, so Back does not bounce');
  // 24 Nov 2026: an unproposed live draft is no change. Its old address is
  // replaced in place with its thread, and read BEFORE the request home.
  assert.match(sub, /const draftHome = await AppView\._draftHomeOf\(ref\.id\);[\s\S]{0,200}?AppView\._openDraftThread\(draftHome\);/);
  assert.ok(sub.indexOf('_draftHomeOf') > -1 && sub.indexOf('_draftHomeOf') < sub.indexOf('_requestHomeOf'),
    'the draft home is read first');
  assert.match(view, /history\.replaceState\(null, '', `#homeroom-bot\/thread\/\$\{root\}`\)/);
  const panel = view.slice(view.indexOf('  async openTopicInPanel(kind, id) {'), view.indexOf('  async openTopicInPanel(kind, id) {') + 1400);
  // 24 Nov 2026: an unproposed live draft's address opens its thread instead.
  assert.match(panel, /const draftHome = await AppView\._draftHomeOf\(id\);/);
  assert.match(panel, /if \(draftHome\) \{[\s\S]{0,120}?AppView\._openDraftThread\(draftHome\);/);
  assert.match(panel, /if \(home\) return AppView\._openChangeOnRequest\(home, id, \{ panel: true \}\);/, 'the Workshop\'s side panel too');
  const changes = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(changes, /if \(!card \|\| !takeVotesInView\(id\)\) return;/, 'the change\'s section takes the ask');
});

test('#7140: a draft opened in the side panel\'s document hands its thread to the top window', () => {
  const view = read('public/js/app-view.js');
  const start = view.indexOf('  _openDraftThread(threadRootId) {');
  const fn = view.slice(start, view.indexOf('  // 6 Nov 2026 (#6439)', start));
  // The frame draws no bot page: its list belongs to the top window, so the
  // thread is handed up in place and nothing here moves or reveals a screen.
  assert.match(fn, /if \(typeof App !== 'undefined' && App\.embeddedPanel\) \{[\s\S]{0,320}?sidePanelEmbed\?\.handTop\?\.\('homeroom-bot\/thread\/' \+ root\);[\s\S]{0,80}?return true;/);
  assert.ok(fn.indexOf('handTop') < fn.indexOf('history.replaceState'),
    'handed up before this document\'s own address moves');
  assert.ok(fn.indexOf('handTop') < fn.indexOf('App.navigateToAi'),
    'and the frame never reveals the bot page beside its own list');
  // Outside the panel the draft keeps today's behaviour: its old address is
  // replaced in place and the thread opens in the tab's column.
  assert.match(fn, /history\.replaceState\(null, '', `#homeroom-bot\/thread\/\$\{root\}`\)/);
  assert.match(fn, /App\.navigateToAi\(\);[\s\S]{0,120}?ai\?\.openAt\?\.\(\{ threadRootId: root, focusMessageId: null \}\)/);
});

// #6225: a change's Votes card lists every request a yes would close, each
// with its title and filer, and marks a request its requester has not agreed
// to. The card is GateCard (change-head.tsx), which a change's section on the
// request's page draws, and a ballot's folded change with it.
const gate = () => ({
  name: 'Votes', figure: '1 of 2', tone: 'ask', done: false,
  segments: [{ weight: 1, pct: 50, state: 'moving' }], label: 'One of two',
  note: ['1 yes, 1 more needed'], facts: [{ key: 'tally', text: '1 yes, 1 more needed' }],
});

function drawGate(props = {}) {
  const wasWindow = globalThis.window;
  globalThis.window = { AppView: { appData: { slug: 'club' } }, addEventListener() {}, removeEventListener() {} };
  try {
    return renderComponent(`${TOPIC}/change-head.tsx`, 'GateCard', { which: 'votes', g: gate(), action: null, id: 91, ...props });
  } finally {
    if (wasWindow === undefined) delete globalThis.window; else globalThis.window = wasWindow;
  }
}

const closesOf = (list) => list.map(([number, title, by, confirmed, extra]) => ({ number, title, by, confirmed, ...(extra || {}) }));

test('#6225: the Votes card lists every request the change will close, marking the unconfirmed', () => {
  const html = drawGate({
    closes: closesOf([
      [10, 'Phone navigation opens the wrong tab', 'evan', true],
      [11, 'Back arrow skips a page', 'evan', true],
      [12, 'Sidebar rows too tight', 'mara', false, { waiting: true }],
    ]),
  });
  assert.match(html, /data-change-vote-closes="3"/);
  assert.match(html, /Closes 3 requests when it merges/, 'the heading names what a yes would do');
  assert.equal((html.match(/data-change-vote-closes-on=/g) || []).length, 3, 'one line each');
  assert.match(html, /data-change-vote-closes-on="10" data-confirmed="true"/);
  assert.match(html, /data-change-vote-closes-on="12" data-confirmed="false"/, 'a request nobody agreed to');
  assert.equal((html.match(/waiting for whoever filed it to agree this closes it/g) || []).length, 1, 'said only of the one waiting');
  assert.match(html, /href="#app\/club\/dev\/issues\/10"/, 'each number opens that request\'s page');
  assert.match(html, /Phone navigation opens the wrong tab · evan/, 'its title and who filed it');
  assert.ok(html.indexOf('data-change-vote-fact="tally"') < html.indexOf('data-change-vote-closes='), 'under the tally');
  assert.doesNotMatch(html, /data-change-vote-closes-more=/, 'three need no fold');
});

test('#6606: a closes line says where its filer stands, and asks only the one who can answer', () => {
  const waiting = drawGate({ closes: closesOf([[12, 'Sidebar rows too tight', 'mara', false, { waiting: true, canConfirm: true }]]) });
  assert.match(waiting, /waiting for whoever filed it to agree this closes it/);
  assert.match(waiting, /data-change-vote-closes-confirm="12"[^>]*>Confirm<\/button>/, 'the filer may press Confirm');

  const voter = drawGate({ closes: closesOf([[12, 'Sidebar rows too tight', 'mara', false, { waiting: true }]]) });
  assert.doesNotMatch(voter, /data-change-vote-closes-confirm=/, 'a voter reads it, and is not asked');

  const nobody = drawGate({ closes: closesOf([[12, 'Old import', 'mara', false]]) });
  assert.doesNotMatch(nobody, /waiting for whoever/, 'nobody could confirm it, so nothing is asked');

  const closed = drawGate({ closes: closesOf([[12, 'Fix the badge', 'kim', false, { closed: true }]]) });
  assert.match(closed, /already closed/, 'a closed request says so');

  const disputed = drawGate({ closes: closesOf([[12, 'Fix the badge', 'kim', false, { disputed: true }]]) });
  assert.match(disputed, /its filer says this doesn(?:'|&#x27;)t close it/);
  assert.equal(message('project:topic.change.gate.closesConfirm'), 'Confirm');
});

test('#6225: one request reads "Closes 1 request", and past five the rest fold behind a tap', () => {
  assert.match(drawGate({ closes: closesOf([[10, 'One', 'evan', false]]) }), /Closes 1 request when it merges/);
  const html = drawGate({
    closes: closesOf([10, 11, 12, 13, 14, 15, 16].map((n) => [n, `Request ${n}`, 'evan', true])),
  });
  assert.equal((html.match(/data-change-vote-closes-on=/g) || []).length, 5, 'the first five');
  assert.match(html, /data-change-vote-closes-more="2"[^>]*>2 more<\/button>/, 'the rest behind one tap');
  assert.equal(message('project:topic.change.gate.closesMore', { count: 2 }), '2 more');
});

test('#6225: only a change up for a vote draws the list', () => {
  const list = closesOf([[10, 'One', 'evan', true], [11, 'Two', 'mara', false]]);
  assert.doesNotMatch(drawGate({ which: 'testing', closes: list }), /data-change-vote-closes=/);
  assert.doesNotMatch(drawGate({ closes: [] }), /data-change-vote-closes=/);
});

test('#6225: closesList is the review change\'s list, sorted, and nothing for one confirmed request', () => {
  const { closesList } = loadTsx(`${TOPIC}/thread-model.ts`);
  const list = closesOf([[12, 'C', 'mara', false], [10, 'A', 'evan', true]]);
  assert.deepEqual(closesList({ ...review(91, 6223, [10, 12]), closesRequests: list }).map((r) => r.number), [10, 12], 'ascending');
  assert.deepEqual(closesList({ ...review(91, 6223, [10]), closesRequests: [list[1]] }), [], 'one it was built for has nothing to say');
  assert.deepEqual(closesList({ ...review(91, 6223, [10, 12]), closesRequests: list, state: 'merged' }), [], 'not after it merges');
  assert.deepEqual(closesList({ ...review(91, 6223, [10, 12]), closesRequests: list, state: 'underway' }), [], 'not before it is proposed');
  assert.deepEqual(closesList({ ...review(91, 6223, []), closesRequests: undefined }), [], 'and not without the list');
});
