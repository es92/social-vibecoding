// In-progress session cards: the UNIFIED single-row shell (the same
// DEV_CARD_CLS every other card on the board uses), the muted/draft
// treatment that marks a private session, the ⋯ menu that absorbed the five
// inline pills, and the section DIVIDERS that replaced the two grey
// sentences introducing the private / visible / others bands.
//
// Session cards used to be the board's only two-row card (title row + an
// indented actions row) because five inline pills would otherwise crush the
// flex-1 title. With the action budget capped at "icon Preview + ⋯" that
// pressure is gone, so this file now pins the single-row shell and asserts
// the old pills are reachable from the ⋯ registry instead — including that
// "Open chat" and "Read chat" are GONE as pills (a tap on the card is the
// one canonical route to each destination).
//
// The private/visible ordering around the archived toggle is UNCHANGED and
// its assertions are preserved verbatim except for the caption → divider
// wording.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the returned
// HTML strings — same harness as dev-kanban-buckets.test.js.
//
// Run with: node --test tests/session-card-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
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
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  return makeCtx().__AppView;
}

const mySess = (over) => ({
  id: 51, session_title: 'My session', status: 'active',
  created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T02:00:00Z',
  ...over,
});
const sharedSess = (over) => ({
  id: 71, session_title: 'Their session', status: 'active', username: 'them',
  user_id: 9, shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T00:00:00Z',
  chat_count: 2,
  ...over,
});

// Assert every marker is present and they appear in the given order.
function assertOrder(html, markers) {
  let prev = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    assert.ok(i >= 0, `expected marker in html: ${m}`);
    assert.ok(i > prev, `expected marker in order: ${m}`);
    prev = i;
  }
}

const CHEVRON = 'M9 5l7 7-7 7';
const SPINNER = 'dc-status-spinner-arc';
// The single-row shell every card on the board shares.
const SHELL = 'w-full flex items-center gap-3 rounded-xl';

// The ⋯ registry key a card emitted, or null.
function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}
function menuLabels(AppView, html) {
  const key = menuKeyOf(html);
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}
function menuHas(AppView, html, re) {
  return menuLabels(AppView, html).some((l) => re.test(l));
}

// ── The unified single-row shell ────────────────────────────────────────────

test('busy own card: single-row shell, wrapping title, ⋯ instead of five pills', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ busy: true }));
  assert.match(html, /dev-card-title/, 'title uses the shared title cell');
  assert.match(html, /dev-card-headline/, 'and its progressive-wrap rule');
  assert.ok(html.includes(SHELL), 'uses the standard single-row card shell');
  assert.ok(!html.includes('block w-full rounded-xl'), 'the two-row session shell is gone');
  assert.ok(!html.includes('pl-12'), 'no indented second actions row');
  // The busy tag is a badge beside the title now; the controls that used to
  // sit in the second row are ⋯ descriptors.
  assert.ok(html.includes(SPINNER), 'the working… spinner still renders');
  assert.ok(menuHas(AppView, html, /Make visible/), 'Make visible in ⋯');
  assert.ok(menuHas(AppView, html, /Archive/), 'Archive in ⋯');
  assert.doesNotMatch(html, /data-archive-chip/, 'Archive is no longer an inline pill');
});

test('a PRIVATE own session carries the muted shell; a visible one does not', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const priv = AppView._renderMySessionCard(mySess({}));
  assert.match(priv, /dev-card-muted/, 'the muted/draft treatment IS the "only you" signal');
  assert.match(priv, /Only you can see this/, 'and the subtitle says so');
  const vis = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.doesNotMatch(vis, /dev-card-muted/, 'a visible session is not muted');
});

test('shared card: single-row shell; noNav drops nav, chevron and the actions row', () => {
  const AppView = makeAppView();
  const s = sharedSess({ busy: true, staging_url: 'https://example.invalid' });
  const nav = AppView._renderSharedSessionCard(s);
  assert.match(nav, /data-shared-session-row="71"/);
  assert.ok(nav.includes(SHELL), 'uses the standard single-row card shell');
  assertOrder(nav, ['dev-card-title', SPINNER, 'dev-chat-badge', 'gc-vote-btn-preview', CHEVRON]);

  const noNav = AppView._renderSharedSessionCard(s, { noNav: true });
  assert.doesNotMatch(noNav, /data-shared-session-row/, 'noNav variant has no row hook');
  assert.ok(!noNav.includes(CHEVRON), 'noNav variant has no chevron');
  assert.doesNotMatch(noNav, /gc-card-actions/, 'noNav variant has no actions row');
});

// ── Preview pill gating (#689) ──────────────────────────────────────────────

test('shared card: can_preview without a live staging_url still gets the icon (empty fallback)', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.match(html, /gc-vote-btn-preview/);
  assert.match(html, /aria-label="Open preview"/, 'the icon carries a real accessible name');
  // Routed through ensure-staging with no last-known URL — the server
  // decides live-vs-rebuild.
  assert.match(html, /swapToStagingForSession\(71, ''\)/);
});

test('shared card: no pushed changes (can_preview false) → no Preview affordance', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: false, staging_url: null }));
  assert.doesNotMatch(html, /gc-vote-btn-preview/);
});

test('shared card, read-only viewer: the icon requires a live staging_url', () => {
  const AppView = makeAppView();
  // readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { can_collaborate: false };
  const rebuildOnly = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.doesNotMatch(rebuildOnly, /gc-vote-btn-preview/, 'read-only viewers cannot trigger a rebuild');
  const live = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: 'https://example.invalid' }));
  assert.match(live, /gc-vote-btn-preview/, 'a live URL still opens directly');
  assert.match(live, /swapToStagingForSession\(71, 'https:\/\/example\.invalid'\)/);
});

test('own card: Preview gated on pr_number (a PR exists once changes are pushed)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const withPr = AppView._renderMySessionCard(mySess({ pr_number: 123 }));
  assert.match(withPr, /gc-vote-btn-preview/);
  assert.match(withPr, /swapToStagingForSession\(51, ''\)/);
  const noPr = AppView._renderMySessionCard(mySess({ pr_number: null }));
  assert.doesNotMatch(noPr, /gc-vote-btn-preview/);
});

// ── The public discussion is a ⋯ row, not a competing pill ──────────────────

test('the "Open chat" PILL is gone; a visible session offers it from ⋯ with its count', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 4 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  // Tapping the card opens the owner's dev chat — its working surface and
  // the card's one canonical destination. The public discussion is one ⋯
  // row rather than a second affordance on the card face.
  assert.doesNotMatch(html, /data-session-discuss/, 'the delegated discuss pill is gone');
  assert.ok(menuHas(AppView, html, /Open public discussion \(4\)/),
    'the ⋯ row carries the shared-row count');
  assert.ok(menuHas(AppView, html, /^Hide$/), 'Hide stays available, from ⋯');
});

test('freshly-visible card (no _sharedById row yet) still offers the discussion at 0', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.ok(menuHas(AppView, html, /Open public discussion/),
    'offered even before the background refresh lands');
});

test('private own card offers no public discussion and keeps Make visible', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({}));
  assert.ok(!menuHas(AppView, html, /Open public discussion/),
    'nowhere for a reader to reach an invisible session from');
  assert.ok(menuHas(AppView, html, /Make visible/), 'Make visible renders, from ⋯');
});

// ── Transcript sharing: the second, narrower opt-in ─────────────────────────

test('private own card offers NO chat-sharing row (nowhere to read it from yet)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({}));
  assert.ok(!menuHas(AppView, html, /Share chat|Chat shared/));
  assert.doesNotMatch(html, /chat readable/);
  assert.match(html, /Only you can see this/, 'subtitle names the private state');
});

test('visible own card offers "Share chat"; the subtitle stays plain', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.ok(menuHas(AppView, html, /^Share chat$/), 'the second opt-in is offered');
  assert.ok(!menuHas(AppView, html, /Chat shared/));
  // Visible ≠ readable: the card must not claim the chat is shared.
  assert.match(html, /Visible to everyone</);
  assert.doesNotMatch(html, /chat readable/);
});

test('chat-shared own card flips to the revoke row and says so in the subtitle', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({
    shared_at: '2026-06-01T03:00:00Z',
    transcript_shared_at: '2026-06-01T03:05:00Z',
  }));
  assert.ok(menuHas(AppView, html, /Chat shared/), 'the revoke row');
  assert.ok(!menuHas(AppView, html, /^Share chat$/));
  assert.match(html, /Visible to everyone · chat readable/);
});

test('the ⋯ rows come in visibility → chat-sharing → discussion → Archive order', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 0 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  const labels = menuLabels(AppView, html).join('|');
  assert.match(labels, /Hide\|Share chat\|Open public discussion\|Archive/);
});

test('the "Read chat" PILL is gone — the transcript lives on the detail page', () => {
  const AppView = makeAppView();
  const on = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: true }));
  assert.doesNotMatch(on, /data-read-chat/, 'no Read chat pill');
  assert.doesNotMatch(on, /Read chat/);
  // The shared transcript is hosted by the session's own detail page, which
  // is exactly where a tap on this card already goes.
  assert.match(on, /data-shared-session-row="71"/);
  assert.match(AppView._transcriptSectionHtml(sharedSess({ transcript_shared: true })),
    /data-transcript-section="71"/, 'the detail page hosts it');
});

test('a shared card carries no ⋯ at all (nothing left to demote)', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: true }));
  assert.equal(menuKeyOf(html), null, 'no dead ⋯ button');
});

test('read-only viewers still reach a published transcript (via the detail page)', () => {
  // #621: read-only viewers may READ a shared transcript — it's the fork
  // action that needs collab access, and that lives in the transcript
  // section (see _transcriptActionsHtml), not on this card.
  const AppView = makeAppView();
  AppView.appData = { can_collaborate: false };
  const html = AppView._renderSharedSessionCard(sharedSess({ transcript_shared: true }));
  assert.match(html, /data-shared-session-row="71"/, 'the card still navigates');
  assert.match(AppView._transcriptSectionHtml(sharedSess({ transcript_shared: true })),
    /read-only/);
});

// ── The transcript section + fork button on the topic page ──────────────────

test('transcript section renders only when the item reports the chat shared', () => {
  const AppView = makeAppView();
  assert.strictEqual(AppView._transcriptSectionHtml({ id: 5 }), '');
  assert.strictEqual(AppView._transcriptSectionHtml({ id: 5, transcript_shared: false }), '');
  assert.strictEqual(AppView._transcriptSectionHtml(null), '');

  // Shared-session / proposal rows carry the boolean…
  const shared = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true, message_count: 9 });
  assert.match(shared, /data-transcript-section="5"/);
  assert.match(shared, /data-transcript-toggle="5"/);
  assert.match(shared, /data-transcript-body="5"/);
  assert.match(shared, /read-only/);
  // …the viewer's OWN rows carry the timestamp instead (the owner gets the
  // section too, as the "preview what everyone else sees" path).
  const mine = AppView._transcriptSectionHtml({ id: 5, transcript_shared_at: '2026-07-01T00:00:00Z' });
  assert.match(mine, /data-transcript-section="5"/);
});

test('transcript section starts collapsed unless the reader asked to read it', () => {
  const AppView = makeAppView();
  const collapsed = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /hidden/);

  AppView._transcriptOpen = 5;
  const open = AppView._transcriptSectionHtml({ id: 5, transcript_shared: true });
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /data-transcript-body="5" hidden/);
});

test('an expanded transcript SURVIVES a topic-head repaint', () => {
  // _renderTopicHead re-innerHTML's the head on every WS/poll refresh, so
  // an open flag held only in the DOM gets wiped seconds after the reader
  // expands the chat (observed in the browser before this was state-backed).
  // Re-rendering the section must therefore paint it open again.
  const AppView = makeAppView();
  const item = { id: 5, transcript_shared: true, message_count: 3 };
  AppView._transcriptOpen = 5;
  for (let repaint = 0; repaint < 3; repaint++) {
    assert.match(AppView._transcriptSectionHtml(item), /aria-expanded="true"/,
      'stays expanded across repaints');
  }
  // …and an explicit collapse likewise sticks across repaints.
  AppView._transcriptOpen = null;
  assert.match(AppView._transcriptSectionHtml(item), /aria-expanded="false"/);
  // The flag is per-session: another session's open state never leaks.
  AppView._transcriptOpen = 5;
  assert.match(
    AppView._transcriptSectionHtml({ id: 6, transcript_shared: true }),
    /aria-expanded="false"/
  );
});

test('"Fork this chat" follows the server can_fork flag, and never for read-only viewers', () => {
  const AppView = makeAppView();
  assert.match(AppView._transcriptActionsHtml({ id: 5, can_fork: true }), /data-fork-chat="5"/);
  // The owner's own chat: nothing to fork (that's "Start a new change").
  assert.strictEqual(AppView._transcriptActionsHtml({ id: 5, can_fork: false, is_owner: true }), '');
  assert.strictEqual(AppView._transcriptActionsHtml(null), '');

  // A dev chat spends the viewer's own AI budget and its API is
  // collab-gated, so a read-only viewer is never offered the button.
  // (readOnly is a getter over appData.can_collaborate — see #621.)
  AppView.appData = { can_collaborate: false };
  assert.strictEqual(AppView._transcriptActionsHtml({ id: 5, can_fork: true }), '');
});

// ── Private/visible split around the archived toggle ────────────────────────

const issueEntry = () => ({
  kind: 'issue',
  item: {
    number: 5, title: 'Issue five', headless: { status: 'generating' },
    priority: null, assignee: null,
  },
});

test('kanban In progress: private → archived toggle → visible → issues → shared', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 1, session_title: 'Private one' }) },
    { kind: 'my-session', item: mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }) },
    issueEntry(),
    { kind: 'shared-session', item: sharedSess({ id: 71 }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assertOrder(html, [
    'Yours · private',
    'data-session-chip="1"',
    'Show archived (1)',
    'Yours · visible',
    'data-session-chip="2"',
    'Issue five',
    'Others',
    'data-shared-session-row="71"',
  ]);
  // The long copy survives as the divider label's tooltip rather than as a
  // full grey sentence occupying its own line in the column.
  assert.match(html, /title="Only you can see your active sessions\."/);
  assert.match(html, /dev-col-divider/, 'rendered as a hairline divider');
});

test('kanban In progress: no private sessions → no private caption; block still renders', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Yours · private/);
  assertOrder(html, ['Yours · visible', 'data-session-chip="2"']);
});

test('kanban In progress: no visible sessions → nothing below the archived toggle', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, status: 'archived' })];
  const entries = [{ kind: 'my-session', item: mySess({ id: 1 }) }];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Yours · visible/);
  assertOrder(html, ['Yours · private', 'data-session-chip="1"', 'Show archived (1)']);
});

test('list view pinned block mirrors the split', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [
    mySess({ id: 1, session_title: 'Private one' }),
    mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }),
  ];
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const html = AppView._mySessionsBlockHtml();
  assertOrder(html, [
    'Yours · private',
    'data-session-chip="1"',
    'Show archived (1)',
    'Yours · visible',
    'data-session-chip="2"',
  ]);
});

test('list view pinned block: only a visible session still renders (no private caption)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' })];
  AppView._archivedSessions = [];
  const html = AppView._mySessionsBlockHtml();
  assert.notEqual(html, '');
  assert.doesNotMatch(html, /Only you can see your active sessions/);
  assertOrder(html, ['Visible to everyone —', 'data-session-chip="2"']);
});

test('list view pinned block: nothing to show → empty string', () => {
  const AppView = makeAppView();
  AppView._mySessions = [];
  AppView._archivedSessions = [];
  assert.equal(AppView._mySessionsBlockHtml(), '');
});

// ── #1038: the "working…" tag is driven by live state, not by the row ────
//
// The board used to re-pull three payloads every 15s just to notice this
// tag had flipped. It now renders through window.SessionState, so a pushed
// transition repaints it — in both directions.

const SESSION_STATE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'session-state.js'), 'utf8'
);

// app-view.js with the live store loaded alongside it, as index.html does.
function makeAppViewWithStore() {
  const sandbox = makeCtx();
  vm.runInContext(SESSION_STATE_SRC, sandbox);
  return { AppView: sandbox.__AppView, SessionState: sandbox.window.SessionState };
}

test('status tag: falls back to the fetched row when the store knows nothing', () => {
  const AppView = makeAppView();
  assert.match(AppView._sessionStatusTagHtml(mySess({ busy: true })), /working…/);
  assert.doesNotMatch(AppView._sessionStatusTagHtml(mySess({ busy: false })), /working…/);
});

test('status tag: a live busy event beats a fetched row that said idle', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  const s = mySess({ id: 51, busy: false });
  assert.doesNotMatch(AppView._sessionStatusTagHtml(s), /working…/);

  SessionState.applyEvent({ sessionId: 51, busy: true, status: 'active' });
  assert.match(AppView._sessionStatusTagHtml(s), /working…/,
    'the card spins on the pushed transition, not on the next fetch');
});

test('status tag: a live idle event clears a spinner the fetched row still asserts', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  // The stale-snapshot case — this is the phantom spinner users report.
  const s = mySess({ id: 51, busy: true });
  assert.match(AppView._sessionStatusTagHtml(s), /working…/);

  SessionState.applyEvent({ sessionId: 51, busy: false, status: 'paused' });
  const html = AppView._sessionStatusTagHtml(s);
  assert.doesNotMatch(html, /working…/);
});

test('status tag: a paused session with no live entry still shows "paused"', () => {
  const { AppView } = makeAppViewWithStore();
  const html = AppView._sessionStatusTagHtml(mySess({ busy: false, status: 'paused' }));
  assert.match(html, /paused/);
  assert.doesNotMatch(html, /working…/);
});

test('a shared session card picks up live busy state too', () => {
  const { AppView, SessionState } = makeAppViewWithStore();
  AppView._sharedById = {};
  const s = sharedSess({ id: 71, busy: false });
  assert.doesNotMatch(AppView._renderSharedSessionCard(s), /working…/);

  SessionState.applyEvent({ sessionId: 71, busy: true, status: 'active' });
  assert.match(AppView._renderSharedSessionCard(s), /working…/,
    "another user's shared card updates for every viewer");
});

test('the 15s _stripTimer and the 8s headless poller are gone', () => {
  const AppView = makeAppView();
  assert.equal(AppView._syncSessionPolling, undefined,
    'replaced by the SessionState subscription');
  assert.equal(AppView._syncHeadlessPolling, undefined,
    'replaced by _onSessionStateEvent patching the cached issue row');
  assert.equal(AppView._stripTimer, undefined);
  assert.equal(AppView._headlessPollTimer, undefined);
});

test('_onSessionStateEvent patches the cached issue row for an auto-run', () => {
  const { AppView } = makeAppViewWithStore();
  AppView.appData = { slug: 'demo-app' };
  AppView._ghIssues = [
    { number: 900003, headless: { sessionId: 5, status: 'generating' }, bounty: { local: 'edit' } },
    { number: 900004, headless: null },
  ];

  AppView._onSessionStateEvent({
    sessionId: 5, appSlug: 'demo-app',
    headless: { status: 'ready', outcome: 'spec', issueNumber: 900003 },
  });

  // Spread into this realm before comparing — app-view.js built the object
  // inside the vm context, so its prototype isn't ours and deepStrictEqual
  // would fail on two structurally identical objects.
  assert.deepEqual({ ...AppView._ghIssues[0].headless },
    { sessionId: 5, status: 'ready', outcome: 'spec' });
  // Field-scoped merge: optimistic local bounty edits must survive, exactly
  // as they did under the poller this replaced.
  assert.deepEqual({ ...AppView._ghIssues[0].bounty }, { local: 'edit' });
  assert.equal(AppView._ghIssues[1].headless, null);
});

test('_onSessionStateEvent ignores events for another app', () => {
  const { AppView } = makeAppViewWithStore();
  AppView.appData = { slug: 'demo-app' };
  AppView._ghIssues = [{ number: 900003, headless: { status: 'generating' } }];

  AppView._onSessionStateEvent({
    sessionId: 5, appSlug: 'other-app',
    headless: { status: 'ready', outcome: 'spec', issueNumber: 900003 },
  });
  assert.equal(AppView._ghIssues[0].headless.status, 'generating',
    'issue numbers are per-repo, so a cross-app event must not patch this row');
});

test('_onSessionStateChanged never repaints mid-drag', () => {
  const { AppView } = makeAppViewWithStore();
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  AppView.appData = { slug: 'demo-app' };
  AppView._dragState = { dragging: true };

  AppView._onSessionStateChanged();
  assert.equal(repaints, 0, 'an innerHTML swap mid-drag would strand the card');
});
