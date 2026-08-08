// Tests for the header-cog "your work" drawer (public/js/work-drawer.js)
// and the notification-kind split it introduces:
//
//   1. Kind routing — the four session-related kinds (session_done,
//      auto_solve_done, stale_pr, check_failed) render in the cog
//      drawer, everything else stays in the bell; the canonical set in
//      notifications.js and work-drawer.js's standalone fallback literal
//      must agree.
//   2. Spin predicate — WorkDrawer.isWorking() is true exactly while an
//      AI turn is in flight (busy totals / busy session rows) or a
//      proposal sits in a spinner-carrying MergeStatus lifecycle state
//      (merging / resolving / checks running); idle sessions and settled
//      proposals do NOT spin.
//   3. Badge math — Notifications._sessionUnread / _bellUnread split the
//      account-wide unread count between the cog's green badge and the
//      bell's red badge without double-counting.
//
// Real shipped sources are loaded into a vm sandbox (so the tests can't
// drift from what runs) with minimal DOM stubs.
//
// Run with: node --test tests/work-drawer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const WORK_DRAWER_SRC = read('work-drawer.js');
const NOTIFICATIONS_SRC = read('notifications.js');
// #1038: the live working-state store the cog now reads through.
const SESSION_STATE_SRC = read('session-state.js');

// Minimal escapeHtml-compatible element for notifications.js's div-based
// escaper (set textContent, read innerHTML).
function makeEscaperElement() {
  const el = { _v: '' };
  Object.defineProperty(el, 'textContent', { set(v) { el._v = String(v); } });
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return el;
}

function makeSandbox() {
  const elements = new Map();
  const sandbox = {
    console,
    title: '',
    document: {
      title: '',
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: makeEscaperElement,
      body: { appendChild: () => {} },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: false }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    // The drawer reads the query string for ?demo=1 and the #971
    // ?shot=work-drawer capture deep link; a vm context gets neither for
    // free. Default to a bare URL so existing tests see no params.
    location: { search: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__elements = elements;
  vm.createContext(sandbox);
  return sandbox;
}

// The full page stack, in real load order: notifications.js →
// merge-status.js → session-state.js → work-drawer.js.
function loadAll() {
  const sandbox = makeSandbox();
  vm.runInContext(
    `${NOTIFICATIONS_SRC}\n${MERGE_STATUS_SRC}\n${SESSION_STATE_SRC}\n${WORK_DRAWER_SRC}`,
    sandbox
  );
  return sandbox;
}

const SESSION_KINDS = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];

// ── 1. kind routing ─────────────────────────────────────────────────────

test('the canonical session-kind set holds exactly the four session-related kinds', () => {
  const sb = loadAll();
  const set = sb.window.SESSION_NOTIF_KINDS;
  assert.ok(set && set.size === 4, 'set exposed on window');
  assert.deepEqual(Array.from(set).sort(), [...SESSION_KINDS].sort());
});

test("work-drawer's standalone fallback literal matches the canonical set", () => {
  const sb = loadAll();
  const canonical = [...sb.window.SESSION_NOTIF_KINDS].sort();
  // Drop the canonical set to expose the fallback path.
  delete sb.window.SESSION_NOTIF_KINDS;
  const fallback = [...sb.WorkDrawer._kinds()].sort();
  assert.deepEqual(fallback, canonical);
});

test('bell rendering excludes session kinds; the cog pinned section holds exactly the unread ones', () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  N.items = [
    { id: 1, kind: 'mention', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 2, kind: 'session_done', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 3, kind: 'check_failed', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 4, kind: 'stale_pr', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: '2026-01-02' },
    { id: 5, kind: 'kudos', appId: 6, appName: 'B', createdAt: '2026-01-01', readAt: null },
    { id: 6, kind: 'auto_solve_done', appId: 6, appName: 'B', createdAt: '2026-01-01', readAt: null },
  ];
  // Array.from: results are VM-realm arrays, which deepStrictEqual
  // rejects on prototype identity — copy into host-realm arrays first.
  const bellIds = Array.from(N._bellItems(), (n) => n.id);
  assert.deepEqual(bellIds, [1, 5], 'bell keeps only the social kinds');
  const grouped = [];
  for (const g of Array.from(N._groupByApp())) {
    for (const n of Array.from(g.items)) grouped.push(n.id);
  }
  assert.deepEqual(grouped.sort(), [1, 5], 'grouping never sees session kinds');

  const pendingIds = Array.from(sb.WorkDrawer._pendingNotifs(), (n) => n.id);
  assert.deepEqual(pendingIds, [2, 3, 6], 'cog pins unread session kinds only (read stale_pr dropped)');
});

test('renderPendingSection renders the shared per-kind rows under a "Needs attention" header', () => {
  const sb = loadAll();
  sb.window.Notifications.items = [
    { id: 2, kind: 'session_done', appId: 5, appName: 'Demo App', prTitle: 'Fix the header', createdAt: new Date().toISOString(), readAt: null },
  ];
  const html = sb.WorkDrawer.renderPendingSection();
  assert.match(html, /Needs attention/);
  assert.match(html, /data-notif-id="2"/, 'reuses the bell row markup (clickable, markable)');
  assert.match(html, /Your dev session in/);
  assert.match(html, /Fix the header/);
});

// #971: the label ladder for the pinned "needs attention" session rows —
// sessionTitle beats the dev name AND the PR title, and the dev name still
// backstops a session that finished before it was ever titled.
test('#971 session_done rows prefer the session title over the dev name', () => {
  const sb = loadAll();
  const now = new Date().toISOString();
  sb.window.Notifications.items = [
    // The issue's case: titled, not yet promoted.
    {
      id: 2, kind: 'session_done', appId: 5, appName: 'Demo App',
      sessionTitle: 'Web UI app proposals implementation',
      prTitle: null, branchName: 'dev/evan-1785951671234',
      createdAt: now, readAt: null,
    },
    // Promoted: session title mirrors the PR title, so nothing regresses.
    {
      id: 3, kind: 'session_done', appId: 5, appName: 'Demo App',
      sessionTitle: 'Make Topochain standings primary',
      prTitle: 'Make Topochain standings primary',
      branchName: 'dev/evan-1785946387499',
      createdAt: now, readAt: null,
    },
    // Untitled: the branch name is still the last-resort label.
    {
      id: 4, kind: 'session_done', appId: 5, appName: 'Demo App',
      sessionTitle: null, prTitle: null,
      branchName: 'dev/evan-1785999999999',
      createdAt: now, readAt: null,
    },
  ];
  const html = sb.WorkDrawer.renderPendingSection();

  assert.match(html, /Web UI app proposals implementation/, 'titled row shows its title');
  assert.doesNotMatch(
    html, /dev\/evan-1785951671234/,
    'the titled row must NOT fall back to its branch name'
  );
  assert.match(html, /Make Topochain standings primary/, 'promoted row unchanged');
  assert.doesNotMatch(html, /dev\/evan-1785946387499/, 'promoted row shows no dev name');
  assert.match(
    html, /dev\/evan-1785999999999/,
    'a genuinely untitled session still falls back to the dev name'
  );
});

// #971: the PR-scoped kinds keep leading with the PR title; the session title
// only fills in ahead of the bare "PR #N".
test('#971 stale_pr / check_failed keep the PR title first, session title as fallback', () => {
  const sb = loadAll();
  const now = new Date().toISOString();
  sb.window.Notifications.items = [
    {
      id: 5, kind: 'stale_pr', appId: 5, appName: 'Demo App',
      prTitle: 'The PR title', sessionTitle: 'The session title',
      prNumber: 41, createdAt: now, readAt: null,
    },
    {
      id: 6, kind: 'check_failed', appId: 5, appName: 'Demo App',
      prTitle: null, sessionTitle: 'Session title fallback',
      prNumber: 42, createdAt: now, readAt: null,
    },
  ];
  const html = sb.WorkDrawer.renderPendingSection();
  assert.match(html, /The PR title/, 'PR title still leads on proposal rows');
  assert.doesNotMatch(html, /The session title/, 'session title not preferred there');
  assert.match(html, /Session title fallback/, 'but it beats a bare "PR #N"');
  assert.doesNotMatch(html, /PR #42/, 'so the number placeholder is not reached');
});

// #971: the OS-notification body (DevAlerts.onCompletion payload) reads from
// the same ladder as the drawer row.
test('#971 completionAlertInfo prefers the session title in its body copy', () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  const captured = [];
  sb.window.DevAlerts = { onCompletion: (info) => captured.push(info) };
  sb.window.DevChat = { _userIsAway: () => false };
  N.items = [];
  N.unread = 0;
  N.handleIncoming({
    id: 9, kind: 'session_done', appId: 5, appName: 'Usernode',
    appSlug: 'usernode', sessionId: 77,
    sessionTitle: 'Web UI app proposals implementation',
    prTitle: null, branchName: 'dev/evan-1785951671234',
    createdAt: new Date().toISOString(), readAt: null,
  });
  assert.equal(captured.length, 1, 'the completion alert fired');
  assert.match(captured[0].body, /Web UI app proposals implementation/);
  assert.doesNotMatch(captured[0].body, /dev\/evan-/, 'no dev name in the OS notification');
});

// #971: the drawer only exists behind a click on the header cog, so the
// capture pipeline needs ?shot=work-drawer to reach it at all.
test('#971 ?shot=work-drawer opens the drawer once, and nothing else does', () => {
  const sb = loadAll();
  const W = sb.WorkDrawer;

  // No shot param → the drawer stays shut.
  sb.window.location.search = '?demo=1';
  W._shotOpened = false;
  W.open = false;
  let shown = 0;
  W.show = () => { shown += 1; W.open = true; };
  W._maybeShotOpen();
  assert.equal(shown, 0, 'a plain page load never auto-opens the drawer');

  // With it → opens exactly once, even across repeated refresh ticks.
  sb.window.location.search = '?shot=work-drawer&demo=1';
  W._shotOpened = false;
  W.open = false;
  W._maybeShotOpen();
  assert.equal(shown, 1, 'the deep link opens the drawer');
  W.open = false; // simulate the user dismissing it
  W._maybeShotOpen();
  assert.equal(shown, 1, 'the 15s refresh poll does not reopen it');
});

// #971: the check must be declared AND survive the manifest reader. It used
// to also have to sit near the top of the array (the reader kept only the
// first MAX_TESTS entries); #1019 runs every declared check, so what is left
// to pin is that the reader keeps this one and refuses nothing for ceiling
// reasons.
test('#971 the work-drawer check is declared and the reader keeps it', () => {
  const root = path.join(__dirname, '..');
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  // #1038 added a second check on this same route (the live working
  // spinner), so a bare path match is ambiguous — key on the expectText,
  // which is what makes this the #971 title check.
  const check = meta.tests.find((t) => t.path === '/?shot=work-drawer&demo=1'
    && t.expectText);
  assert.ok(check,
    'the check must survive the manifest reader — a dropped check gates nothing');
  assert.match(check.expectSelector, /#work-drawer-panel:not\(\.hidden\)/,
    'asserts the drawer is actually revealed, not merely present');
  assert.match(check.expectText, /^\[Mock\]/,
    'and asserts a seeded session TITLE renders (the #971 fix)');
  // The staging fixture the check reads must actually declare that title.
  const { stagingMockNotifications } = require('../src/routes/notifications');
  assert.ok(
    stagingMockNotifications().some((r) => r.sessionTitle === check.expectText),
    'the ?demo=1 fixtures must seed the exact title the check asserts on'
  );
});

// ── 2. spin predicate ───────────────────────────────────────────────────

function drawerWith(sb, { totals, sessions, proposals } = {}) {
  const W = sb.WorkDrawer;
  W.totals = totals || { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 };
  W.sessions = sessions || [];
  W.proposals = proposals || [];
  W.governance = [];
  return W;
}

test('isWorking: false when idle (open sessions waiting on the user do not spin)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 2, promoted: 1, paused: 1, busy: 0, total: 4 },
    sessions: [{ id: 1, status: 'active', busy: false }],
    proposals: [{ id: 9, status: 'promoted', yes_count: 0, majority: 3, check_state: 'passing' }],
  });
  assert.equal(W.isWorking(), false);
});

test('isWorking: true while an AI turn is in flight', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 1, promoted: 0, paused: 0, busy: 1, total: 1 },
    sessions: [{ id: 1, status: 'active', busy: true }],
  });
  assert.equal(W.isWorking(), true);
});

// ── 1038: the cog spins from PUSHED state, with no refetch ──────────────
//
// This is the reported bug's core. The old `_syncPolling` timer was armed
// only while isWorking() was ALREADY true (or the drawer was open), so a
// turn beginning on an otherwise-idle account had nothing watching for it
// and the cog simply never started spinning.

test('a session_state event starts the cog spinning with no refetch', () => {
  const sb = loadAll();
  let fetches = 0;
  sb.fetch = async () => { fetches += 1; return { ok: false }; };

  const W = drawerWith(sb, {
    totals: { active: 1, promoted: 0, paused: 0, busy: 0, total: 1 },
    sessions: [{ id: 1, status: 'active', busy: false }],
  });
  assert.equal(W.isWorking(), false);

  sb.window.SessionState.applyEvent({ sessionId: 1, busy: true, status: 'active' });

  assert.equal(W.isWorking(), true, 'the cog spins the moment the turn starts');
  assert.equal(fetches, 0, 'and does so without re-pulling any payload');
});

test('a session_state idle event stops the cog even though the fetched row still says busy', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 1, promoted: 0, paused: 0, busy: 1, total: 1 },
    // Exactly the stale snapshot that used to leave the cog spinning for a
    // turn that had already finished.
    sessions: [{ id: 1, status: 'active', busy: true }],
  });
  assert.equal(W.isWorking(), true);

  sb.window.SessionState.applyEvent({ sessionId: 1, busy: false, status: 'active' });
  assert.equal(W.isWorking(), false);
});

test('a busy PROMOTED session still spins the cog from live state', () => {
  // #747: promoted sessions render under "Your proposals", but in-flight
  // work on one must never become invisible.
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [{ id: 5, status: 'promoted', busy: false }],
    proposals: [{ id: 5, status: 'promoted', yes_count: 1, majority: 3, check_state: 'passing' }],
  });
  assert.equal(W.isWorking(), false);

  sb.window.SessionState.applyEvent({ sessionId: 5, busy: true, status: 'promoted' });
  assert.equal(W.isWorking(), true);
});

test('the 15s _syncPolling timer is gone', () => {
  const sb = loadAll();
  const W = sb.window.WorkDrawer;
  assert.equal(W._syncPolling, undefined,
    'replaced by SessionState pushes + its own adaptive reconcile tick');
  assert.equal(W._pollTimer, undefined);
});

test('refresh seeds fetched busy flags into the live store', async () => {
  const sb = loadAll();
  sb.fetch = async (url) => {
    if (String(url).startsWith('/api/me/active-sessions')) {
      return {
        ok: true,
        json: async () => ({
          sessions: [{ id: 3, status: 'active', busy: true }],
          totals: { active: 1, promoted: 0, paused: 0, busy: 1, total: 1 },
        }),
      };
    }
    return { ok: true, json: async () => ({ proposals: [], governance: [] }) };
  };

  await sb.window.WorkDrawer.refresh();
  assert.equal(sb.window.SessionState.isBusy(3, false), true,
    'so every other surface sees it too, not just the drawer');
});

test('a refresh in flight when the turn ends does NOT put the spinner back', async () => {
  // The precedence bug this guards: seed() must stamp rows with when the
  // REQUEST went out. Stamped with the response's arrival instead, this
  // stale payload would outrank the idle event that overtook it and the cog
  // would start spinning again for a turn that had already finished.
  const sb = loadAll();
  let releaseResponse;
  const held = new Promise((r) => { releaseResponse = r; });

  sb.fetch = async (url) => {
    if (String(url).startsWith('/api/me/active-sessions')) {
      await held; // the slow response
      return {
        ok: true,
        json: async () => ({
          sessions: [{ id: 4, status: 'active', busy: true }],
          totals: { active: 1, promoted: 0, paused: 0, busy: 1, total: 1 },
        }),
      };
    }
    return { ok: true, json: async () => ({ proposals: [], governance: [] }) };
  };

  const pending = sb.window.WorkDrawer.refresh();
  // The turn finishes while that request is still open.
  await new Promise((r) => setTimeout(r, 5));
  sb.window.SessionState.applyEvent({ sessionId: 4, busy: false, status: 'active' });
  releaseResponse();
  await pending;

  assert.equal(sb.window.SessionState.isBusy(4, true), false,
    'the newer idle event wins over the older in-flight payload');
  assert.equal(sb.window.WorkDrawer.isWorking(), false);
});

test('isWorking: true for each spinner-carrying merge-lifecycle state', () => {
  const sb = loadAll();
  const spinnerStates = [
    { status: 'merging' },                              // merging
    { status: 'promoted', merge_conflict_state: 'resolving' }, // resolving
    { status: 'promoted', check_state: 'pending' },     // checks running
  ];
  for (const p of spinnerStates) {
    const W = drawerWith(sb, { proposals: [{ id: 1, yes_count: 0, majority: 3, ...p }] });
    assert.equal(W.isWorking(), true, `spins for ${JSON.stringify(p)}`);
  }
});

test('isWorking: false for settled / blocked proposal states', () => {
  const sb = loadAll();
  const stillStates = [
    { status: 'promoted', check_state: 'failing' },
    { status: 'promoted', merge_conflict_state: 'failed', check_state: 'passing' },
    { status: 'merged' },
  ];
  for (const p of stillStates) {
    const W = drawerWith(sb, { proposals: [{ id: 1, yes_count: 0, majority: 3, ...p }] });
    assert.equal(W.isWorking(), false, `no spin for ${JSON.stringify(p)}`);
  }
});

// ── 3. badge math ───────────────────────────────────────────────────────

function badgeEl() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
  };
}

test('_renderBadge splits unread between the cog (green) and the bell (red)', () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  const red = badgeEl();
  const green = badgeEl();
  const markAll = { disabled: false };
  sb.__elements.set('notifications-badge', red);
  sb.__elements.set('notifications-badge-ai', green);
  sb.__elements.set('notifications-mark-all', markAll);

  // 5 unread account-wide: 3 session-related (loaded), 2 bell, +1 invite.
  N.unread = 5;
  N.invites = [{ appId: 1 }];
  N.items = [
    { id: 1, kind: 'session_done', readAt: null },
    { id: 2, kind: 'check_failed', readAt: null },
    { id: 3, kind: 'stale_pr', readAt: null },
    { id: 4, kind: 'stale_pr', readAt: '2026-01-01' }, // read: counts nowhere
    { id: 5, kind: 'mention', readAt: null },
    { id: 6, kind: 'kudos', readAt: null },
  ];
  N._renderBadge();

  assert.equal(green.textContent, '3', 'cog badge = unread session-related items');
  assert.ok(!green.classList.contains('hidden'));
  assert.equal(red.textContent, '3', 'bell badge = (unread - session) + invites = 2 + 1');
  assert.ok(!red.classList.contains('hidden'));
  assert.equal(markAll.disabled, false, 'bell has its own unread → mark-all enabled');

  // Only session-related unread left → bell red hides (no invites), green stays.
  N.unread = 1;
  N.invites = [];
  N.items = [{ id: 1, kind: 'auto_solve_done', readAt: null }];
  N._renderBadge();
  assert.ok(red.classList.contains('hidden'), 'red hides when the bell itself has nothing');
  assert.equal(green.textContent, '1');
  assert.equal(markAll.disabled, true, 'bell mark-all disabled when only cog items remain');
});

// ── 4. de-dup: promoted sessions render under "Your proposals" only (#747) ──

const mkSession = (over = {}) => ({
  id: 1, status: 'active', busy: false, app_slug: 'demo', app_name: 'Demo App',
  session_title: 'A session', last_activity_at: new Date().toISOString(),
  created_at: new Date().toISOString(), ...over,
});

const mkProposal = (over = {}) => ({
  id: 1, status: 'promoted', pr_number: 101, pr_title: 'A proposal',
  pr_title_fallback: false, app_slug: 'demo', app_name: 'Demo App',
  yes_count: 1, no_count: 0, majority: 3, check_state: 'passing', ...over,
});

test('renderSessionsSection drops a session whose id appears in the proposals list', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [
      mkSession({ id: 7, status: 'promoted', session_title: 'Promoted dup' }),
      mkSession({ id: 8, status: 'active', session_title: 'Plain active' }),
    ],
    proposals: [mkProposal({ id: 7, pr_title: 'Promoted dup' })],
  });
  const html = W.renderSessionsSection();
  assert.match(html, /Your sessions/);
  assert.match(html, /Plain active/, 'non-promoted session still renders');
  assert.doesNotMatch(html, /dev\/sessions\/7/, 'duplicated promoted session is dropped');
  assert.match(html, /dev\/sessions\/8/);
});

test('renderSessionsSection returns "" when every session is filtered out (no orphan header)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [mkSession({ id: 7, status: 'promoted' })],
    proposals: [mkProposal({ id: 7 })],
  });
  assert.equal(W.renderSessionsSection(), '');
});

test('a session matching a governance row id is NOT filtered (PR proposals only)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [mkSession({ id: 42, session_title: 'Session colliding with an issue id' })],
    proposals: [],
  });
  // Governance ids come from the issues table — same numeric space as
  // nothing session-related; a collision must not hide the session.
  W.governance = [{ id: 42, title: 'Secret change', app_slug: 'demo', app_name: 'Demo App', up_count: 0 }];
  const html = W.renderSessionsSection();
  assert.match(html, /dev\/sessions\/42/, 'session survives a governance id collision');
});

test('renderProposalsSection carries the "working…" tag from a busy matching session', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [
      mkSession({ id: 7, status: 'promoted', busy: true }),
      mkSession({ id: 9, status: 'promoted', busy: false }),
    ],
    proposals: [
      mkProposal({ id: 7, pr_title: 'Busy proposal' }),
      mkProposal({ id: 9, pr_title: 'Idle proposal' }),
    ],
  });
  const html = W.renderProposalsSection();
  const rows = html.split('<a ');
  const busyRow = rows.find((r) => r.includes('dev/proposals/7'));
  const idleRow = rows.find((r) => r.includes('dev/proposals/9'));
  assert.ok(busyRow && busyRow.includes('working…'), 'busy session\'s proposal row shows the spinner tag');
  assert.ok(idleRow && !idleRow.includes('working…'), 'idle proposal row has no spinner tag');
});

test('isWorking stays true for a busy promoted session filtered from the rendered list', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 0, promoted: 1, paused: 0, busy: 0, total: 1 },
    sessions: [mkSession({ id: 7, status: 'promoted', busy: true })],
    proposals: [mkProposal({ id: 7, check_state: 'passing' })],
  });
  assert.equal(W.renderSessionsSection(), '', 'row hidden from Your sessions');
  assert.equal(W.isWorking(), true, 'cog spin still driven by the unfiltered data array');
});
