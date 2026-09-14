const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function context(user = { id: 42, username: 'Builder' }) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams };
  c.window = c;
  vm.createContext(c);
  for (const path of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path, 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._ghIssues = [{ number: 1993, title: 'Wait for authentication before opening previews' }];
  return c.av;
}

const failing = { id: 4073, user_id: 42, username: 'Builder', status: 'active',
  source: 'cli_handoff', proposal_state: 'failed', linked_issues: [1993],
  session_title: 'Authenticate previews', pr_title: 'Authenticate previews',
  staging_url: 'https://preview.example', check_state: 'failing',
  checks_commit_sha: 'a'.repeat(40), checks_base_sha: 'b'.repeat(40),
  test_results: [{ name: 'Preview login', path: '/preview', status: 'fail', failureReason: 'Expected app, received login' }],
  created_at: '2026-09-11T12:00:00Z' };
const row = (v, key) => v.body.details.ledger.find((r) => r.key === key);

test('underway and review share context, sections and check explanations', () => {
  const av = context();
  for (const status of ['active', 'promoted']) {
    const v = av._topicViewFor(status === 'active' ? 'session' : 'proposal', { ...failing, status });
    assert.equal(v.body.issues[0].title, av._ghIssues[0].title);
    assert.match(v.body.issues[0].href, /dev\/issues\/1993$/);
    assert.equal(row(v, 'checks').fails[0].reason, 'Expected app, received login');
    assert.ok(row(v, 'checks').actions.some((a) => /re-run/i.test(a.label)));
    assert.ok(v.body.testing);
    assert.equal(v.body.workspace, failing.id);
    assert.ok(v.body.activity.length);
  }
});

test('promotion is blocked by a VERDICT, not by an answer that has not arrived (#2074)', () => {
  const av = context();
  const disabled = (patch) => av._topicViewFor('session', { ...failing, ...patch })
    .card.actions.find((a) => a.key === 'propose-change').disabled;

  // `failing` is a cli_handoff whose proposal_state is 'failed', so the first
  // three are the managed-handoff contract: it must have a tested, uploaded
  // revision before it can be promoted. That contract is deliberate and
  // untouched.
  for (const patch of [{}, { check_state: 'pending' }, { check_state: 'passing' }]) {
    assert.equal(disabled(patch), true, `handoff without a ready revision: ${JSON.stringify(patch)}`);
  }
  assert.equal(disabled({ status: 'paused' }), true, 'a paused change has to be resumed first');

  // And these two used to block, which is what #2074 is about. A build in
  // flight and a checks-ran-on-older-main caveat are not verdicts: the first
  // is an answer that has not arrived, and the second is one #2038 declares
  // SOFT — "a caveat on a green result, not a failure, so it never blocks the
  // vote". Waiting on either spent a build to start a vote that takes days,
  // while the connector's submit_work put the identical state in front of the
  // group with no wait at all.
  assert.equal(disabled({ check_state: 'passing', proposal_state: 'ready', busy: true }), false,
    'a build in flight no longer blocks submission');
  assert.equal(disabled({ check_state: 'passing', proposal_state: 'ready', checks_base_verdict: 'superseded' }), false,
    'nor does a soft stale-base caveat');

  const ready = av._topicViewFor('session', { ...failing, check_state: 'passing', proposal_state: 'ready' });
  assert.equal(ready.card.actions.find((a) => a.key === 'propose-change').disabled, false);
  const review = av._topicViewFor('proposal', { ...failing, status: 'promoted' });
  assert.equal(row(review, 'review'), undefined);
  assert.ok(review.card.actions.some((a) => a.key === 'yes'));
});

test('every blocked reason names its own condition (#2074)', () => {
  // Five conditions shared one sentence — "Finish the build and pass checks
  // for the current revision" — which is what turned a temporary state into a
  // bug report: it named checks that were not running, and gave no way to tell
  // whether waiting would help.
  const av = context();
  const reason = (patch) => av.changeSubmissionState({ ...failing, ...patch }).reason;

  assert.match(reason({ status: 'paused' }), /Resume this change/);
  assert.match(reason({ proposal_state: 'checking' }), /tested commit uploaded/,
    'the managed-handoff contract says what it wants');
  // `failing` is a cli_handoff, whose contract is checked first — so the
  // generic verdicts need an ordinary session to be reachable at all.
  const plain = { source: null, proposal_state: undefined };
  assert.match(reason({ ...plain, check_state: 'failing' }), /checks on this revision are failing/);
  assert.match(reason({ ...plain, check_state: 'error' }), /checks could not run/);

  // No two of them are the same sentence — the whole point.
  const reasons = [
    reason({ status: 'paused' }),
    reason({ proposal_state: 'checking' }),
    reason({ ...plain, check_state: 'failing' }),
    reason({ ...plain, check_state: 'error' }),
  ];
  assert.equal(new Set(reasons).size, reasons.length, 'four conditions, four reasons');

  // And none of them promises a control that does not exist.
  for (const r of reasons) assert.doesNotMatch(r, /submit anyway/i);
});

test('an ordinary session submits while its checks are still running (#2074)', () => {
  // The case this change exists for. Checks gate MERGE — "Merge is blocked
  // until checks pass" — and the connector's submit_work already puts exactly
  // this state to the group with no wait, so the browser refusing it guarded
  // one doorway while the other stood open.
  const av = context();
  const ordinary = { ...failing, source: null, proposal_state: undefined };
  for (const check_state of ['pending', null, undefined]) {
    assert.equal(av.changeSubmissionState({ ...ordinary, check_state }).kind, 'ready',
      `check_state ${String(check_state)} is an answer that has not arrived, not a verdict`);
  }
  assert.equal(av.changeSubmissionState({ ...ordinary, check_state: 'passing', busy: true }).kind,
    'ready', 'and a build in flight is the same kind of not-yet');

  // A real verdict still blocks: putting a known-broken change in front of the
  // group is the thing worth refusing.
  assert.equal(av.changeSubmissionState({ ...ordinary, check_state: 'failing' }).kind, 'blocked');
  assert.equal(av.changeSubmissionState({ ...ordinary, check_state: 'error' }).kind, 'blocked');
});

test('readers cannot promote, sync, or open the private workspace', () => {
  const av = context({ id: 99 });
  const v = av._topicViewFor('session', { ...failing, shared_at: '2026-09-11' });
  assert.equal(v.body.workspace, null);
  assert.ok(!v.card.actions.some((a) => a.key === 'propose-change'));
  assert.ok(!v.body.details.ledger.some((r) => r.actions?.some((a) => a.key === 'sync-main')));
  assert.equal(v.body.transcript, null);
});

test('owner can sync before review, with busy and fork capabilities respected', () => {
  const av = context();
  const sync = (v) => v.body.details.ledger.flatMap((r) => r.actions || []).find((a) => a.key === 'sync-main');
  assert.ok(sync(av._topicViewFor('session', failing)));
  av._changeActions.set(failing.id, 'sync-main');
  assert.equal(sync(av._topicViewFor('session', failing)).disabled, true);
  assert.equal(sync(av._topicViewFor('session', { ...failing, source: 'imported', imported_pr_head_repo: 'someone/fork', repo_url: 'https://github.com/org/app' })), undefined);
});

test('underway freshness does not claim an automatic sync or scheduled merge is running', () => {
  const av = context();
  const v = av._topicViewFor('session', { ...failing, freshness_behind_by: 2, freshness_checked_at: failing.created_at });
  assert.equal(row(v, 'checks').label, 'Checks');
  assert.ok(v.body.details.ledger.some((r) => r.text.includes('2 commits behind main.')));
  assert.doesNotMatch(JSON.stringify(v.body.details.ledger), /automatic, now|automatic, after|retries the merge/);
});

// #2038 measures drift into the integration_* record and retired the sweep
// that kept freshness_* current, so a proposal up for vote usually has the
// first and not the second. The card used to read only the second — and
// said "not verified yet" under a merge gate that had just measured the
// proposal 3 commits behind (#2100). The Main row and the pill go through
// one reader, and that reader takes whichever measurement is newer.
test('the Main row reads the integration record when that is the measurement the gate has', () => {
  const av = context();
  const promoted = { ...failing, status: 'promoted', check_state: 'passing', proposal_state: 'ready' };
  const mainRow = (patch) => av._topicViewFor('proposal', { ...promoted, ...patch })
    .body.details.ledger.find((r) => ['main', 'behind', 'sync', 'conflict', 'mergeability'].includes(r.key));

  // Measured by the gate only: the count is reported, with the platform's
  // sync named as the next step — the same row a legacy measurement gets.
  const behind = mainRow({ integration_behind_by: 3, integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: true });
  assert.equal(behind.key, 'behind');
  assert.match(behind.text.join(' '), /3 commits ahead/);
  assert.doesNotMatch(behind.text.join(' '), /not been verified/);
  const legacy = mainRow({ freshness_behind_by: 3, freshness_checked_at: '2026-09-14T12:42:29Z' });
  assert.deepEqual(behind.text, legacy.text, 'one measurement, one row, whichever column carried it');

  // Level with main by the same record: says so, rather than "unverified".
  const level = mainRow({ integration_behind_by: 0, integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: true });
  assert.match(level.text.join(' '), /Up to date with main/);

  // Nothing measured either way still reads as unknown, never as fine.
  const unknown = mainRow({});
  assert.match(unknown.text.join(' '), /not been verified yet/);

  // A row with both: the newer measurement wins in either direction, so a
  // live freshness patch that arrived after the record still shows through.
  const f = av._freshnessOf({
    integration_behind_by: 3, integration_measured_at: '2026-09-14T12:42:29Z',
    freshness_behind_by: 0, freshness_checked_at: '2026-09-14T12:00:00Z',
  });
  assert.equal(f.behindBy, 3, 'the gate measured after the sweep did');
  assert.equal(f.checkedAt, '2026-09-14T12:42:29Z');
  const g = av._freshnessOf({
    integration_behind_by: 3, integration_measured_at: '2026-09-14T12:00:00Z',
    freshness_behind_by: 0, freshness_checked_at: '2026-09-14T12:42:29Z',
  });
  assert.equal(g.behindBy, 0, 'a later freshness patch outranks an older record');

  // A real conflict measured by the gate carries its paths, and they are the
  // complete list — git named them, nobody estimated them.
  const c = av._freshnessOf({
    integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: false,
    integration_conflict_paths: ['src/a.js', 'src/b.js'],
  });
  assert.equal(c.mergeability, 'conflict');
  assert.deepEqual(c.files, ['src/a.js', 'src/b.js']);
  assert.equal(c.filesComplete, true);
});

test('private changes retain sharing controls and do not pretend to have a public discussion', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  assert.ok(av._cardMenuItems(v.card.rail.menuKey).some((a) => a.label === 'Make visible'));
  assert.match(v.body.discussion, /workspace stays private/);
});

test('actual shared component renders the entire card and escapes the issue title', () => {
  const av = context();
  av._ghIssues[0].title = '<script>issue</script>';
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const v = av._topicViewFor('session', failing);
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: failing, conversation: true }));
  for (const label of ['Where it stands', 'Addresses', 'Testing instructions', 'Screenshots', 'Activity', 'Discussion', 'Expected app, received login']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('&lt;script&gt;issue&lt;/script&gt;'));
  assert.ok(!html.includes('<script>issue</script>'));
  assert.match(html, />Edit issues</, 'the owner can manage associations after creation');
  assert.match(html, /role="tablist" aria-label="Conversation"/);
  assert.match(html, /role="tab"[^>]+aria-selected="true"[^>]*>Build/);
  assert.ok(html.includes('Build'));
  assert.ok(!html.includes('Open discussion'));
  assert.equal((html.match(/>Activity</g) || []).length, 1, 'Activity is a tab, not a duplicate disclosure');
});

test('issue and governance topic bodies are not rebuilt as proposals without a session', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  const previousWindow = global.window;
  global.window = { AppView: { _topicViewFor() { throw new Error('Non-session topic rebuilt as proposal'); } } };
  try {
    const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
    const html = renderToHtml(createElement(ChangeDetail, { card: v.card, body: { ...v.body, comments: true }, item: null }));
    assert.match(html, /id="dev-issue-comments"/);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('detail refresh uses the lifecycle endpoint and preserves demo context', async () => {
  const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const requests = [];
  let roster = 0;
  global.window = { AppView: { appData: { slug: 'example' }, _demoQS: () => '?demo=1',
    _invalidateVoteRoster() {}, _loadVoteRoster() { roster++; } } };
  const signal = new AbortController().signal;
  try {
    for (const status of ['active', 'paused', 'promoted', 'merging', 'merged']) {
      const session = { id: 123, status };
      const review = ['promoted', 'merging', 'merged'].includes(status);
      global.fetch = async (url, options) => {
        requests.push(url);
        assert.equal(options.signal, signal);
        return { ok: true, json: async () => review ? { proposal: session } : { session } };
      };
      assert.deepEqual(await readChangeDetail(session, true, signal), session);
      assert.equal(requests.at(-1), review ? '/api/apps/example/proposals/123?demo=1' : '/api/sessions/123/details?demo=1');
    }
    assert.equal(requests.length, 5, 'one authoritative detail request per refresh');
    assert.equal(roster, 3);
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'Unavailable' }) });
    await assert.rejects(readChangeDetail({ id: 123, status: 'active' }, true, signal), /Unavailable/);
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('Open card links use one detail route regardless of ownership or origin', () => {
  const { openHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  for (const hook of ['data-session-chip', 'data-shared-session-row', 'data-proposal-row']) {
    assert.equal(openHref('example', { attrs: { [hook]: '4073' } }), '#app/example/dev/proposals/4073');
  }
});

test('the same detail URL resolves native/imported underway work and changes lifecycle after promotion', () => {
  const av = context();
  av._mySessions = [{ ...failing }];
  av._sharedSessions = [{ ...failing, id: 4074, user_id: 99, source: 'imported', shared_at: '2026-09-11' }];
  for (const id of [4073, 4074]) {
    const item = av._findItem('proposal', id);
    assert.equal(item.id, id);
    assert.ok(row(av._topicViewFor('proposal', item), 'review'), 'underway readiness, not review voting');
  }
  av._proposals = [{ ...failing, status: 'promoted' }];
  assert.equal(av._findItem('proposal', 4073).status, 'promoted');
  assert.equal(row(av._topicViewFor('proposal', av._findItem('proposal', 4073)), 'review'), undefined);
  av._mySessions = [];
  assert.equal(av._findItem('session', 4073).status, 'promoted', 'legacy shared link still resolves');
});

test('all change routes mount the full card, leaving discussion loading to its privacy-aware tab', () => {
  const av = context();
  av._devTopic = { kind: 'proposal', id: failing.id };
  av._mySessions = [{ ...failing }];
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const calls = [];
  const c = { AppView: av, document: { getElementById: () => ({}) },
    GroupChat: { mountThread: () => calls.push('public'), unmountThread: () => calls.push('detach') } };
  av._reactDevBoard = () => ({ publishTopicHead() {}, mountChangePage: () => calls.push('change') });
  const method = source.slice(source.indexOf('  _mountTopicThread() {'), source.indexOf('\n  // Open a topic full-screen.', source.indexOf('  _mountTopicThread() {'))).trim().replace(/,$/, '');
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
  av._mySessions[0].shared_at = '2026-09-11';
  calls.length = 0;
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
});

test('workspace capabilities distinguish owners, published transcripts, private chats and imports', () => {
  const { workspaceKind, ChangeConversation } = loadTsx('frontend/src/features/dev-board/topic/conversation.tsx');
  const av = context();
  const own = av._topicViewFor('session', failing).body;
  assert.equal(workspaceKind(failing, own), 'owner');
  assert.equal(workspaceKind({ ...failing, source: 'imported' }, own), 'imported');
  const other = context({ id: 99 })._topicViewFor('session', { ...failing, shared_at: '2026-09-11' }).body;
  assert.equal(workspaceKind(failing, other), 'private');
  assert.equal(workspaceKind(failing, { ...other, transcript: { id: failing.id } }), 'published');
  const privateHtml = renderToHtml(createElement(ChangeConversation, { item: failing, body: own }));
  assert.match(privateHtml, /data-conversation-tab="workspace"/);
  assert.match(privateHtml, /id="dc-view"/, 'the author opens directly into Build');
  const readerHtml = renderToHtml(createElement(ChangeConversation, { item: failing, body: other }));
  assert.doesNotMatch(readerHtml, /id="dc-view"/, 'a reader never mounts the private workspace');
});

test('Continue building selects the embedded workspace without navigating away from the card', () => {
  const av = context();
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const method = source.slice(source.indexOf('  openChangeWorkspace(id) {'), source.indexOf('\n  _showExplorePill', source.indexOf('  openChangeWorkspace(id) {'))).trim().replace(/,$/, '');
  let present = true;
  const events = [], routes = [];
  av.openProposalSession = (id) => routes.push(id);
  const c = { AppView: av, document: { querySelector: () => present ? {} : null },
    window: { dispatchEvent: (event) => events.push(event) }, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } } };
  const open = vm.runInNewContext(`({ ${method} }).openChangeWorkspace`, c);
  open(4073);
  assert.equal(events[0].type, 'change-workspace-open');
  assert.equal(events[0].detail, 4073);
  assert.deepEqual(routes, []);
  present = false;
  open(4073);
  assert.deepEqual(routes, [4073], 'callers outside the card retain the session route');
});

test('Workshop native underway inline details resolve the owner card key', () => {
  const av = context(); av._mySessions = [failing];
  assert.equal(av._workshopCardBody('my-session:4073').changeId, 4073);
});


test('full card has one submission, one preview, contextual recovery and an independent More menu', () => {
  const av = context();
  const item = { ...failing, pr_url: 'https://github.com/example/app/pull/12', check_state: 'passing', proposal_state: 'ready' };
  const compact = av._mySessionCardModel(item);
  const compactMenu = av._cardMenuItems(compact.rail.menuKey);
  const v = av._topicViewFor('session', item);
  assert.equal(v.card.actions.filter((a) => a.key === 'propose-change').length, 1);
  assert.equal(v.card.actions.filter((a) => a.preview).length, 1);
  assert.equal(v.card.rail.preview, null);
  assert.equal(row(v, 'review').actions, undefined);
  const menu = av._cardMenuItems(v.card.rail.menuKey);
  assert.equal(menu.filter((a) => /GitHub/.test(a.label)).length, 1);
  assert.ok(menu.some((a) => a.label === 'Make visible'));
  assert.ok(!menu.some((a) => ['View checks', 'Re-run checks', 'Open session'].includes(a.label)));
  assert.ok(compactMenu.some((a) => a.label === 'View checks'));
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item, conversation: true }));
  assert.equal((html.match(/>Submit for review</g) || []).length, 1);
  assert.doesNotMatch(html, /Continue building|dev-topic-gh/);
});

test('merged card opens the live app instead of an expired preview', () => {
  const av = context();
  const v = av._topicViewFor('proposal', { ...failing, status: 'merged' });
  assert.ok(v.card.actions.some((a) => a.label === 'Open app'));
  assert.ok(!v.card.actions.some((a) => a.preview || a.key === 'propose-change'));
});


test('Build defaults only for underway authors and explicit tab links win', () => {
  const { initialConversationTab } = loadTsx('frontend/src/features/dev-board/topic/conversation.tsx');
  const own = context()._topicViewFor('session', failing).body;
  for (const status of ['active', 'paused']) assert.equal(initialConversationTab({ ...failing, status }, own, null), 'workspace');
  for (const status of ['promoted', 'merging', 'merged', 'archived']) assert.equal(initialConversationTab({ ...failing, status }, own, null), 'discussion');
  assert.equal(initialConversationTab({ ...failing, source: 'imported' }, own, null), 'discussion');
  assert.equal(initialConversationTab(failing, { ...own, workspace: null }, null), 'discussion');
  for (const tab of ['discussion', 'activity', 'workspace']) assert.equal(initialConversationTab(failing, own, tab), tab);
  assert.equal(initialConversationTab(failing, { ...own, workspace: null, transcript: { id: failing.id } }, null, true), 'workspace');
});

test('the issue editor parses compact lists strictly and deterministically', () => {
  const { parseLinkedIssueInput } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.deepEqual(parseLinkedIssueInput('#27, 12 27'), { issues: [12, 27], error: '' });
  assert.match(parseLinkedIssueInput('12 nope').error, /not an issue number/);
  assert.match(parseLinkedIssueInput('2147483648').error, /too large/);
  assert.match(parseLinkedIssueInput(Array.from({ length: 51 }, (_, i) => i + 1).join(',')).error,
    /at most 50/);
});

test('an unlinked owner gets the empty editor affordance while a reader sees no empty aside', () => {
  const av = context();
  const item = { ...failing, linked_issues: [] };
  const v = av._topicViewFor('session', item);
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item, conversation: true }));
  assert.match(html, /No issues linked yet/);
  assert.match(html, />Edit issues</);

  const reader = context({ id: 99 });
  const readView = reader._topicViewFor('session', item);
  const readHtml = renderToHtml(createElement(ChangeDetail, {
    ...readView, item, conversation: true,
  }));
  assert.doesNotMatch(readHtml, /No issues linked yet|Issues this change addresses|Edit issues/);
});

test('imported underway PR archive is owner-only and works from compact and full cards', async () => {
  const item = { ...failing, source: 'imported', pr_number: 17, pr_title: 'Imported work' };
  const av = context();
  const calls = [];
  av._archiveSession = async (...args) => { calls.push(args); return true; };
  av._loadDevFeed = async () => calls.push('refresh');
  av._renderTopicHead = () => calls.push('head');
  for (const status of ['active', 'paused']) {
    const current = { ...item, status };
    for (const card of [av._mySessionCardModel(current), av._topicViewFor('session', current).card]) {
      const actions = av._cardMenuItems(card.rail.menuKey).filter((a) => a.icon === 'archive');
      assert.equal(actions.length, 1);
      assert.equal(actions[0].label, 'Archive PR');
      await actions[0].act();
    }
  }
  assert.deepEqual(calls[0], [item.id, 'Imported work', true]);
  assert.equal(calls.filter((x) => x === 'refresh').length, 4);
  const other = context({ id: 99 });
  const readOnly = context(); readOnly.appData.can_collaborate = false;
  for (const viewer of [other, readOnly]) {
    const v = viewer._topicViewFor('session', item);
    assert.ok(!viewer._cardMenuItems(v.card.rail.menuKey).some((a) => a.icon === 'archive'));
  }
});
