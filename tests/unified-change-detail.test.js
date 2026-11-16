const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// `extra.App` adds to the App stub (a recording switchTab, say) and
// `extra.location` is the one a navigation writes, for a test to read back.
function context(user = { id: 42, username: 'Builder' }, extra = {}) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}`, ...extra.App },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: extra.location || { search: '', hash: '' }, URLSearchParams };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  // The change's ⋯ row to its pull request decides by the address
  // (frontend/src/lib/repo-link.js, published as window.RepoLink).
  require('./lib/repo-link').installRepoLink(c);
  vm.createContext(c);
  for (const path of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path, 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  // #4524: the board lists answer only for the app they were loaded for.
  c.av._devDataSlug = 'example';
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

test('a change page offers no other app\'s requests (#6123)', () => {
  // The board lists hold whichever app's board was loaded last. A change page
  // painted before this app's own board load (a fast open from a link, or the
  // first paint after a project switch) must not offer the previous project's
  // open requests in "Search by number or title".
  const av = context();
  av._devDataSlug = 'other';
  const foreign = av._topicViewFor('proposal', failing);
  assert.equal(foreign.body.issueOptions.length, 0);
  assert.equal(foreign.body.issues[0].title, 'Issue #1993',
    'the linked request falls back rather than naming another app\'s row');

  // Once this app's board load lands, the same page offers its requests.
  av._devDataSlug = 'example';
  const own = av._topicViewFor('proposal', failing);
  assert.equal(own.body.issueOptions[0].title, av._ghIssues[0].title);
});

test('underway and review share context, sections and check explanations', () => {
  const av = context();
  for (const status of ['active', 'promoted']) {
    const v = av._topicViewFor(status === 'active' ? 'session' : 'proposal', { ...failing, status });
    assert.equal(v.body.issues[0].title, av._ghIssues[0].title);
    assert.equal(v.body.issueOptions[0].title, av._ghIssues[0].title);
    assert.match(v.body.issues[0].href, /dev\/issues\/1993$/);
    assert.equal(row(v, 'checks').fails[0].reason, 'Expected app, received login');
    assert.ok(row(v, 'checks').actions.some((a) => /re-run/i.test(a.label)));
    assert.ok(v.body.testing);
  }
});

test('an underway change can always be submitted for review (#3173, #3043)', () => {
  // Submitting opens the vote; the merge gate requires passing checks on the
  // exact reviewed commit however the vote goes. So no check state, preview
  // state or managed-handoff state disables the button any more. The
  // managed-handoff wait was what stranded #3161 and #3163: checked, green,
  // then paused and their previews reclaimed, with "needs staging and checks
  // to finish" and nothing left running that could finish.
  const av = context();
  const action = (patch) => av._topicViewFor('session', { ...failing, ...patch })
    .card.actions.find((a) => a.key === 'propose-change');

  for (const patch of [
    {}, // failing checks, managed handoff
    { check_state: 'error' },
    { check_state: 'pending', proposal_state: 'checking' },
    { check_state: 'passing', proposal_state: 'ready' },
    { check_state: 'passing', proposal_state: 'deploying', status: 'paused', staging_url: null },
    { status: 'paused' },
    { check_state: 'passing', proposal_state: 'ready', busy: true },
    { check_state: 'passing', proposal_state: 'ready', checks_base_verdict: 'superseded' },
    { source: null, proposal_state: undefined, check_state: 'failing' },
  ]) {
    assert.equal(action(patch).disabled, false, `enabled: ${JSON.stringify(patch)}`);
    assert.equal(action(patch).label, 'Submit for review');
  }

  // Only a submission already in flight holds it, so a double click cannot
  // submit twice.
  av._changeActions.set(failing.id, 'promote');
  assert.equal(action({}).disabled, true);
  assert.equal(action({}).label, 'Submitting…');
  av._changeActions.delete(failing.id);

  const review = av._topicViewFor('proposal', { ...failing, status: 'promoted' });
  assert.equal(row(review, 'review'), undefined);
  assert.ok(review.card.actions.some((a) => a.key === 'yes'));
});

test('the Review row says what submitting now means, one sentence per condition (#3173)', () => {
  // The five blocked reasons became notes. Each still names its OWN
  // condition, because that is what lets a reader tell whether waiting
  // would change anything, and none promises a merge the gate would refuse.
  const av = context();
  const state = (patch) => av.changeSubmissionState({ ...failing, ...patch });
  const reviewRow = (patch) => row(av._topicViewFor('session', { ...failing, ...patch }), 'review');

  const cases = {
    failing: [{}, /checks are failing\. You can submit it now; it can merge only after a fix passes them/, 'warn'],
    error: [{ check_state: 'error' }, /checks could not run\. You can submit it now; it can merge only once they run and pass/, 'warn'],
    uploaded: [{ proposal_state: 'uploaded', check_state: null }, /uploaded but has not been submitted for checks yet/, 'mute'],
    draft: [{ proposal_state: 'draft', check_state: null }, /no committed changes to submit yet/, 'mute', 'empty'],
    running: [{ proposal_state: 'checking', check_state: 'pending' }, /Its checks keep running, and it can merge only once they pass/, 'ok'],
    idle: [{ proposal_state: 'deploying', check_state: 'passing', staging_url: null }, /preview was closed while idle; submitting rebuilds it and runs the checks again/, 'ok'],
    ready: [{ proposal_state: 'ready', check_state: 'passing' }, /^Ready to submit for review\.$/, 'ok'],
  };
  const notes = [];
  for (const [name, [patch, note, tone, kind = 'ready']] of Object.entries(cases)) {
    const st = state(patch);
    assert.equal(st.kind, kind, name);
    assert.match(st.note, note, name);
    assert.equal(st.tone, tone, name);
    assert.equal(reviewRow(patch).text.join(''), st.note, `${name}: the Review row carries it`);
    assert.equal(reviewRow(patch).tone, tone, `${name}: in its tone`);
    notes.push(st.note);
  }
  assert.equal(new Set(notes).size, notes.length, 'one sentence per condition');
  for (const n of notes) assert.doesNotMatch(n, /submit anyway|will merge/i);
});

test('an ordinary session submits whatever its checks say (#2074, #3173)', () => {
  const av = context();
  const ordinary = { ...failing, source: null, proposal_state: undefined };
  for (const check_state of ['pending', null, undefined, 'passing', 'failing', 'error']) {
    assert.equal(av.changeSubmissionState({ ...ordinary, check_state, pr_number: 12 }).kind, 'ready',
      `check_state ${String(check_state)}`);
  }
  assert.equal(av.changeSubmissionState({ ...ordinary, check_state: 'passing', busy: true }).kind,
    'ready', 'and a build in flight is the same kind of not-yet');
});

test('a change with nothing committed says so, and cannot be submitted (#2379, #3173, #3776)', async () => {
  const av = context();
  const blank = { ...failing, source: null, proposal_state: undefined,
    pr_number: null, staging_url: null, check_state: null, test_results: [] };
  const state = (patch) => av.changeSubmissionState({ ...blank, ...patch });
  const noChanges = /no committed changes to submit yet/;

  // A brand-new session: no pull request, no preview, no check ever started.
  // There is nothing to review, so the button is disabled (#3776) beside the
  // step that says "Nothing committed yet"; its tooltip and the Review row
  // carry the same sentence the server's 409 would.
  assert.equal(state({}).kind, 'empty');
  assert.equal(state({}).short, 'Nothing committed yet');
  assert.match(state({}).note, noChanges);
  const view = av._topicViewFor('session', blank);
  const button = view.card.actions.find((a) => a.key === 'propose-change');
  assert.equal(button.disabled, true, 'the button is disabled');
  assert.equal(button.label, 'Submit for review');
  assert.match(button.title, noChanges);
  assert.match(row(view, 'review').text.join(''), noChanges);
  assert.equal(row(view, 'review').tone, 'mute');
  // runChangeAction refuses it too, so no stale render can submit it.
  await av.runChangeAction(blank.id, 'promote', blank);
  assert.equal(av._changeActions.has(Number(blank.id)), false);
  // The checks ran and found the branch level with main.
  assert.match(state({ check_state: 'skipped', check_error_detail: 'branch has no commits beyond main, so there is nothing to test' }).note, noChanges);

  // Any sign that something reached the branch is not that case.
  for (const patch of [{ check_state: 'pending' }, { pr_number: 12 }, { staging_url: 'https://preview.example' },
    { check_state: 'skipped', check_error_detail: 'GitHub is not configured' }]) {
    assert.doesNotMatch(state(patch).note, noChanges, JSON.stringify(patch));
    assert.equal(state(patch).kind, 'ready', JSON.stringify(patch));
  }
  // Managed handoffs read the server's revision state; imported PRs have
  // their own contract.
  assert.match(state({ source: 'cli_handoff', proposal_state: 'draft' }).note, noChanges);
  assert.equal(state({ source: 'cli_handoff', proposal_state: 'draft' }).kind, 'empty');
  assert.match(state({ source: 'cli_handoff', proposal_state: 'uploaded' }).note, /uploaded but has not been submitted/);
  assert.equal(state({ source: 'cli_handoff', proposal_state: 'uploaded' }).kind, 'ready');
  // A managed change with commits but no pull request yet is submittable.
  assert.equal(state({ source: 'cli_handoff', proposal_state: 'ready', check_state: 'passing', staging_url: 'https://p' }).kind, 'ready');
  assert.doesNotMatch(state({ source: 'imported' }).note, noChanges);
  assert.equal(state({ source: 'imported' }).kind, 'ready');
});

test('before review the author reads the spec under About this change (#2371)', () => {
  const av = context();
  const draft = { ...failing, source: null, proposal_state: undefined, pr_body: null, pr_summary_md: null,
    spec_md: '# Authenticate previews\n\nWait for the session before opening a preview.' };
  const own = av._topicViewFor('session', draft);
  assert.ok(own.body.proposalBody, 'the spec stands in for the technical details');
  assert.match(own.body.proposalBody.html, /Authenticate previews/);
  // #4479: and the plan is on the page itself, as a request's plan card,
  // so the summary points at the card rather than at a hidden sheet.
  assert.match(own.body.summaryHtml, /plan this change is built from is below/);
  assert.doesNotMatch(own.body.summaryHtml, /under Details/);
  assert.equal(own.body.plan.read.kind, 'text');
  assert.match(own.body.plan.read.markdown, /Authenticate previews/);
  assert.equal(own.body.plan.version, null);

  // A real PR body wins, and a summary is never replaced.
  const withBody = av._topicViewFor('session', { ...draft, pr_body: 'The PR body', pr_summary_md: 'Previews wait for sign-in.' });
  assert.match(withBody.body.proposalBody.html, /The PR body/);
  assert.doesNotMatch(withBody.body.summaryHtml, /spec this change/);

  // Nobody else's change, and nothing once it is up for review.
  const readerView = context({ id: 99 })._topicViewFor('session', { ...draft, shared_at: '2026-09-11' });
  assert.equal(readerView.body.proposalBody, null);
  assert.doesNotMatch(readerView.body.summaryHtml, /spec this change/);
  const promoted = av._topicViewFor('proposal', { ...draft, status: 'promoted' });
  assert.doesNotMatch(promoted.body.summaryHtml || '', /spec this change/);
  assert.equal(readerView.body.plan, null, 'no readable plan, no card');
});

test('a change built from a plan shows the plan card with its Read (#4479)', () => {
  const draft = { ...failing, source: null, proposal_state: undefined, pr_body: null, pr_summary_md: null,
    pr_title: 'Spec for topics', plan: { version: 3, at: '2026-10-08T21:58:00Z' } };
  // A reader with a shared version: the card opens that version.
  const reader = context({ id: 99 })._topicViewFor('session', { ...draft, shared_at: '2026-10-08' });
  assert.deepEqual({ ...reader.body.plan.read }, { kind: 'shared', sessionId: draft.id, version: 3, previewTitle: 'Spec for topics' });
  assert.equal(reader.body.plan.version, 3);
  assert.equal(reader.body.plan.title, 'Spec for topics');
  assert.match(reader.body.summaryHtml, /plan this change is built from is below/);
  // Up for review with a summary: the card stays, the summary is its own.
  const promoted = context()._topicViewFor('proposal', { ...draft, status: 'promoted', pr_summary_md: 'Topics hold discussions.' });
  assert.equal(promoted.body.plan.version, 3);
  assert.doesNotMatch(promoted.body.summaryHtml, /built from/);
});

test('readers cannot promote or sync', () => {
  const av = context({ id: 99 });
  const v = av._topicViewFor('session', { ...failing, shared_at: '2026-09-11' });
  assert.ok(!v.card.actions.some((a) => a.key === 'propose-change'));
  assert.ok(!v.body.details.ledger.some((r) => r.actions?.some((a) => a.key === 'sync-main')));
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
  assert.deepEqual(JSON.parse(JSON.stringify(behind.text)),
    [{ b: 'Syncing.', tone: 'warn' }, ' Main has moved 3 commits ahead; Homeroom is bringing this proposal up to date automatically.'],
    'what the reader needs: the platform is on it, and how far main has moved; the change page draws no chip to carry the count');
  assert.equal(behind.sub, null, 'and nobody is named under the label');
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

test('unshared changes retain sharing controls and do not pretend to have a discussion', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  assert.ok(av._cardMenuItems(v.card.rail.menuKey).some((a) => a.label === 'Make visible'));
  // Not shared hides the workspace here, never the code: every repository
  // is public on GitHub, so the line says so rather than "stays private".
  assert.equal(v.body.discussion, 'Make this change visible to the group to start a discussion. '
    + 'Only you can see the agent workspace here unless you share it. Its code is public.');
  assert.doesNotMatch(v.body.discussion, /private/);
  assert.ok(v.card.meta.some((m) => m.t === 'text' && m.s === 'Not shared yet'), 'the card says Not shared yet');
});

test('actual shared component renders the entire card and escapes the issue title', () => {
  const av = context();
  av._ghIssues[0].title = '<script>issue</script>';
  const { ChangeDetail, DetailsBody } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const v = av._topicViewFor('session', failing);
  // B10b: the steps are in Details, a body-mounted sheet the page keeps; it
  // is drawn here after the page, as the document holds it.
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: failing }))
    + renderToHtml(createElement(DetailsBody, { prRef: v.body.hero.ref, steps: v.body.steps, help: false, html: '' }));
  // #4455: the change as a thread's root post: the summary, the requests it
  // addresses, the Votes and Testing cards; the steps sheet (with the failing
  // check's reason behind its door) in Details. Its discussion is the
  // thread's own stream.
  for (const label of ['Built for', 'Waiting on you', 'Submitted for review', 'Expected app, received login', 'Checks']) assert.ok(html.includes(label), `${label} is on the page`);
  assert.ok(!html.includes('Where it stands'), 'a draft draws the same short steps as a proposal');
  assert.ok(html.includes('&lt;script&gt;issue&lt;/script&gt;'));
  assert.ok(!html.includes('<script>issue</script>'));
  assert.ok(av._cardMenuItems(v.card.rail.menuKey).some((a) => a.label === 'Edit requests'), 'the owner can manage associations after creation, from the ⋯');
  // The issue is a chip on the "Built for" line, in the Needs-you chip's
  // accent tint: the number bold, the title after it, the issue's own page
  // behind it.
  assert.match(html, /<a href="[^"]*\/dev\/issues\/1993" class="dev-ws-chip dev-ws-chip-info dev-topic-issue" data-issue-ref="1993"[^>]*><b>#1993<\/b><span>&lt;script&gt;issue&lt;\/script&gt;<\/span><\/a>/);
  assert.match(html, /class="dev-change-chips-lead">Built for</);
  assert.doesNotMatch(html, /dev-issue-ref/, 'the event-box row is the ISSUE page\u2019s (AddressedBy), not the change page\u2019s');
  // #2193: a long title truncates instead of scrolling the page sideways.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const chipRule = css.match(/\.dev-topic-issue > span \{[^}]*\}/);
  assert.ok(chipRule, 'the issue chip\u2019s title rule exists');
  assert.match(chipRule[0], /text-overflow: ellipsis/);
  assert.match(chipRule[0], /white-space: nowrap/);
  // No tabs, no Build sheet and no Discussion sheet: the page IS the thread
  // (#4455). The dev chat it once opened is retired, so there is no Build
  // door anywhere: not on the page and not in its ⋯.
  assert.doesNotMatch(html, /role="tablist"/);
  assert.match(html, /data-change-root="4073"/);
  assert.doesNotMatch(html, /data-change-conversation/);
  assert.doesNotMatch(html, /data-change-build/, 'no Build sheet under the Discussion');
  assert.doesNotMatch(html, /aria-label="Build"/);
  assert.doesNotMatch(html, /id="dc-view"/, 'the dev session is not embedded in the card page');
  assert.equal((html.match(/>Continue building</g) || []).length, 0, 'the Build door is not on the page');
  assert.equal(av._cardMenuItems(v.card.rail.menuKey).filter((a) => a.label === 'Continue building').length, 0, 'nor a ⋯ row');
  assert.ok(!html.includes('Open discussion'));
  assert.doesNotMatch(html, />Activity</, 'Activity is gone: the meta line carries its stamp');
});

test('issue and governance topic bodies are not rebuilt as proposals without a session', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  const previousWindow = global.window;
  global.window = { addEventListener() {},
    AppView: { _topicViewFor() { throw new Error('Non-session topic rebuilt as proposal'); } } };
  try {
    const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
    const html = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item: null }));
    assert.match(html, /^<div class="dev-change-head">/);
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
      // `results=failing`: the page counts its passing checks and their fold
      // reads the names when opened (tests/item-page-reads.test.js).
      assert.equal(requests.at(-1), review
        ? '/api/apps/example/proposals/123?results=failing&demo=1'
        : '/api/sessions/123/details?results=failing&demo=1');
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

test('server-side change link producers use the same detail route', () => {
  for (const file of [
    'src/services/mcp-tools.js',
    'src/services/external-agent-tasks.js',
    'src/routes/proposal-handoff.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\/dev\/sessions\/\$\{/,
      `${file} must not turn a proposal or underway-card link into a workspace link`);
  }
});

test('an Improve session row opens the full change route, never the workspace link', () => {
  // #5289 checked the mixed work-order/session fixture on the Messages
  // screen's Agents list. That list left Messages (16 Nov 2026) and no shell
  // screen draws the row now, so no declared check can open it; the address
  // a row carries is pinned where the controller builds it.
  const manifest = JSON.parse(fs.readFileSync('dapp.json', 'utf8'));
  assert.deepEqual(manifest.tests.filter((item) => /data-improve-row/.test(item.expectSelector || '')).map((item) => item.name), [],
    'no check selects a row nothing draws');
  assert.deepEqual(manifest.tests.filter((item) => /\/dev\/sessions\//.test(item.expectSelector || '')).map((item) => item.name), [],
    'and none expects the workspace link');
  const controller = fs.readFileSync('frontend/src/features/improve/improve-controller.js', 'utf8');
  assert.match(controller, /href: `#app\/\$\{session\.app_slug\}\/dev\/proposals\/\$\{session\.id\}`,/, 'a session row opens the change\'s page');
  assert.doesNotMatch(controller, /\/dev\/sessions\//, 'never the workspace');
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

test('every change route mounts its thread, and an unshared change reads no discussion (#4455)', () => {
  const av = context();
  av._devTopic = { kind: 'proposal', id: failing.id };
  av._mySessions = [{ ...failing }];
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const calls = [];
  const c = { AppView: av, document: { getElementById: () => ({}) },
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    GroupChat: { mountThread: (opts) => calls.push(opts), unmountThread: () => calls.push('detach') } };
  const method = source.slice(source.indexOf('  _mountTopicThread() {'), source.indexOf('\n  // Open a topic full-screen.', source.indexOf('  _mountTopicThread() {'))).trim().replace(/,$/, '');
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].language, 'change');
  assert.equal(calls[0].type, 'session');
  assert.equal(calls[0].withHeader, true);
  assert.equal(calls[0].readOnly, true, 'nobody else can see it yet, so there is nobody to reply to');
  assert.match(calls[0].closed, /^Only you can see this change\./);
  av._mySessions[0].shared_at = '2026-09-11';
  calls.length = 0;
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.equal(calls[0].closed, undefined);
  assert.equal(calls[0].readOnly, false);
});

test('a change page draws no build surface, for a reader as for its author (#2605, #4455)', () => {
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const av = context();
  const reader = context({ id: 99 });
  const ownItem = failing;
  const otherItem = { ...failing, shared_at: '2026-09-11', transcript_shared: true };
  for (const [view, item] of [[av, ownItem], [reader, otherItem]]) {
    const v = view._topicViewFor('session', item);
    const html = renderToHtml(createElement(ChangeDetail, { ...v, item }));
    assert.match(html, /data-change-root="4073"/);
    assert.doesNotMatch(html, /data-change-build/, 'the Build sheet is gone');
    assert.doesNotMatch(html, /id="dc-view"/, 'no workspace is embedded under the discussion');
    assert.doesNotMatch(html, /data-transcript-body/, 'no published chat is embedded either');
  }
});

test('the owner\u2019s underway session resolves to a body carrying its change id', () => {
  // This went through `_workshopCardBody`, the card-key adapter the Workshop's
  // in-place open used. #1884 round two sends "Open card" to the item's page
  // on both surfaces, so that adapter is gone and the claim is made where it
  // always actually lived — `_topicViewFor`, which the page itself builds
  // from.
  const av = context(); av._mySessions = [failing];
  assert.equal(av._topicViewFor('session', av._findItem('session', 4073)).body.changeId, 4073);
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
  // #4455: the page has no PR link of its own any more, so GitHub is one ⋯ row.
  assert.equal(menu.filter((a) => /GitHub/.test(a.label)).length, 1);
  assert.ok(menu.some((a) => a.label === 'Details'));
  assert.ok(menu.some((a) => a.label === 'Make visible'));
  assert.ok(!menu.some((a) => ['View checks', 'Re-run checks', 'Open session'].includes(a.label)));
  assert.ok(compactMenu.some((a) => a.label === 'View checks'));
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item }));
  assert.equal((html.match(/>Submit for review</g) || []).length, 1);
  assert.equal(menu.filter((a) => a.label === 'Continue building').length, 0, 'no Build door: the dev chat it opened is retired');
  assert.doesNotMatch(html, /dev-topic-gh/);
});

test('merged card opens the live app instead of an expired preview', () => {
  const av = context();
  const v = av._topicViewFor('proposal', { ...failing, status: 'merged' });
  assert.ok(v.card.actions.some((a) => a.label === 'Open app'));
  assert.ok(!v.card.actions.some((a) => a.preview || a.key === 'propose-change'));
});


test('the change page has no panel to auto-open: the conversation module is gone (#2605, #4455)', () => {
  // The Build sheet's auto-open rules went with the sheet in #2605, and the
  // Discussion sheet that was left went with #4455: the page is the thread.
  assert.ok(!fs.existsSync('frontend/src/features/dev-board/topic/conversation.tsx'));
  const src = fs.readFileSync('frontend/src/features/dev-board/topic/change-head.tsx', 'utf8');
  for (const gone of ['initialBuildOpen', 'initialConversationTab', 'workspaceKind',
    'data-change-build', 'dc-view', 'data-transcript-body']) {
    assert.ok(!src.includes(gone), `${gone} is not on the change page`);
  }
});

test('the issue picker normalizes, searches and ranks the local issue catalog', () => {
  const { normalizeLinkedIssues, parseExactIssueNumber, filterIssueOptions } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.deepEqual(normalizeLinkedIssues([27, 12, 27, 0, Number.NaN]), [12, 27]);
  assert.deepEqual(parseExactIssueNumber('#27'), { issue: 27, error: '' });
  assert.deepEqual(parseExactIssueNumber('authentication'), { issue: null, error: '' });
  assert.match(parseExactIssueNumber('2147483648').error, /too large/);

  const options = [
    { n: 91, title: 'Preview authentication', href: '#91' },
    { n: 19, title: 'Authentication status', href: '#19' },
    { n: 1993, title: 'Wait for authentication before opening previews', href: '#1993' },
    { n: 199, title: 'Unrelated', href: '#199' },
  ];
  assert.deepEqual(filterIssueOptions('auth', options, []).map((issue) => issue.n), [19, 91, 1993],
    'title prefix sorts ahead of a title-body match');
  assert.deepEqual(filterIssueOptions('#19', options, [19]).map((issue) => issue.n), [199, 1993],
    'selected issues are excluded and number-prefix matches remain ranked');
  assert.deepEqual(filterIssueOptions('', options, []), [], 'an empty search never opens a giant list');
});

test('the issue picker computes bounded add/remove deltas for the existing PATCH route', () => {
  const { linkedIssueDelta } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.deepEqual(linkedIssueDelta([12, 27, 44], [27, 50, 50]), {
    addIssues: [50], removeIssues: [12, 44],
  });

  const src = fs.readFileSync('frontend/src/features/dev-board/topic/topic-head.tsx', 'utf8');
  assert.match(src, /placeholder=\{t\('project:topic\.requests\.searchPlaceholder'\)\}/);
  assert.equal(message('project:topic.requests.searchPlaceholder'), 'Search by number or title');
  assert.match(src, /aria-label=\{t\('project:topic\.requests\.remove', \{ number: issue\.n, title: issue\.title \}\)\}/);
  assert.equal(message('project:topic.requests.remove', { number: 27, title: 'Fix sign-in' }), 'Remove #27: Fix sign-in');
  assert.match(src, /event\.key === 'Escape'/);
  assert.match(src, /if \(suggestions\[0\]\) addIssue/);
  assert.match(src, /disabled=\{saving \|\| !changed\}/);
  assert.match(src, /JSON\.stringify\(\{ addIssues, removeIssues \}\)/);
});

test('an unlinked owner adds a request from the ⋯, and a reader sees no empty row', () => {
  const av = context();
  const item = { ...failing, linked_issues: [] };
  const v = av._topicViewFor('session', item);
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item }));
  assert.doesNotMatch(html, /No requests linked yet|dev-change-chips/);
  assert.ok(av._cardMenuItems(v.card.rail.menuKey).some((a) => a.label === 'Add a request'));

  const reader = context({ id: 99 });
  const readView = reader._topicViewFor('session', item);
  const readHtml = renderToHtml(createElement(ChangeDetail, { ...readView, item }));
  assert.doesNotMatch(readHtml, /No requests linked yet|Requests this change addresses|Edit requests/);
  assert.ok(!reader._cardMenuItems(readView.card.rail.menuKey).some((a) => /request/.test(a.label)));
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

// QA 2026-09-24: "Up to date with main." followed, on the next line, by "The
// author must update this branch in their fork, then push the changes." The
// fork line went under every fork proposal's Main row, whatever the row said.
test('the fork instruction appears only when the fork actually needs updating', () => {
  const av = context();
  const fork = { ...failing, status: 'promoted', source: 'imported', check_state: 'passing',
    proposal_state: 'ready', imported_pr_head_repo: 'someone/fork', repo_url: 'https://github.com/org/app' };
  const footOf = (v) => {
    const main = v.body.details.ledger.find((r) => ['sync', 'behind', 'conflict', 'mergeability', 'main'].includes(r.key));
    return (main.foot || []).filter(Array.isArray).map((f) => f.map((x) => (typeof x === 'string' ? x : x.b)).join('')).join(' ');
  };
  const current = av._topicViewFor('proposal', { ...fork, freshness_behind_by: 0, freshness_checked_at: failing.created_at });
  assert.ok(current.body.details.ledger.some((r) => r.text.includes('Up to date with main.')));
  assert.doesNotMatch(footOf(current), /must update this branch/, 'an up-to-date fork is not told to update');
  const behind = av._topicViewFor('proposal', { ...fork, freshness_behind_by: 3, freshness_checked_at: failing.created_at });
  assert.match(footOf(behind), /must update this branch in their fork/, 'a fork that is behind still is');
});
