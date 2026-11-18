'use strict';

// The pure parts of a before & after shots run's I/O (services/
// shots-orchestrator.js): the brief, the idle wait, the error classes, the
// trace. The steps themselves are tests/shots-run-steps-postgres.test.js;
// the decisions between them, the shots machine's
// (tests/workflow-shots-postgres.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visible-changes');
const shots = require('../src/services/shots-files');
const orchestrator = require('../src/services/shots-orchestrator');
const fixtures = require('./fixtures/shots');

test('shots and staging use the same UI file classifier', () => {
  const serverOnly = [
    'src/routes/notifications.js', 'src/services/mobile-push-badge.js',
    'tests/mobile-push-badge.test.js',
  ];
  assert.equal(orchestrator.uiFileHeuristic(serverOnly), false);
  assert.equal(orchestrator.uiFileHeuristic(['frontend/src/Shell.tsx']), true);
  assert.equal(orchestrator.uiFileHeuristic(['public/js/app-view.js']), true);
  assert.equal(orchestrator.uiFileHeuristic(['src/features/widgets/icon.svg']), true);
});

const RUN_ID = '1'.repeat(32);
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const provenance = {
  baseSha: BASE,
  headSha: HEAD,
  fixtureFingerprint: 'fixture-1',
  baseImageDigest: 'sha256:base',
  headImageDigest: 'sha256:head',
};

test('a child app\'s brief says no browser holds a role in the app, and to skip an owner-only screen at once', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-app-roles-'));
  try {
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [] }));
    const briefFor = (options) => orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: { pr_title: 'Seasonal theme picker' },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['public/app.js'], filesComplete: true,
        diffSummary: { text: '', fileCount: 1, truncated: false },
      },
      pair: { sides: { base: {}, head: { checkout } } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
      intent: contract.parseIntent(fixtures.intent()),
      ...options,
    });
    const child = briefFor({ childApp: true });
    assert.deepEqual(Object.keys(child.browsers).sort(), ['full_admin', 'guest', 'member', 'read_only_admin']);
    assert.equal(child.browsers.member.who, 'an ordinary signed-in person with no role in this app');
    for (const persona of ['read_only_admin', 'full_admin']) {
      assert.match(child.browsers[persona].who,
        /^a Homeroom administrator .*; this app is not told that, so it sees an ordinary signed-in person with no role in it$/);
    }
    assert.equal(child.browsers.full_admin.tool, 'browser_full_admin');
    assert.equal(child.appRoles.heldByAnyBrowser, false);
    assert.match(child.appRoles.note, /^No browser here is this app's creator, owner or one of its admins/);
    assert.match(child.appRoles.note, /never their role in it/);
    assert.match(child.appRoles.note, /never the app's own\s+people/);
    assert.match(child.appRoles.note, /an allowlist of usernames or ids/);
    assert.match(child.appRoles.note, /call skip_change for that change at once/);
    assert.match(child.appRoles.note, /do not try the other browsers/);
    assert.match(child.appRoles.note, /when hints\.setup says how to get it, do that first/);

    const homeroom = briefFor({});
    assert.equal('appRoles' in homeroom, false);
    assert.equal(homeroom.browsers.member.who, 'an ordinary member');
    assert.equal(homeroom.browsers.read_only_admin.who, 'an administrator with read-only rights');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// PR 4777 (a ready-made Study timer, 2026-10-12): two of its three changes
// were skipped because the shots member could not make a project. Now the
// personas can, but no copy can set a project up, so Homeroom's brief says
// what can be shot after Make it and to skip a change that needs a made
// project running at once, never as the change failing.
test('Homeroom\'s own brief says a project made on the copies never finishes setting up; a child app\'s says nothing', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-make-project-'));
  try {
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [] }));
    const briefFor = (options) => orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: { pr_title: 'A ready-made Study timer' },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['src/services/app-templates.js'], filesComplete: true,
        diffSummary: { text: '', fileCount: 1, truncated: false },
      },
      pair: { sides: { base: {}, head: { checkout } } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
      intent: contract.parseIntent(fixtures.intent()),
      ...options,
    });
    const own = briefFor({ selfApp: true });
    assert.deepEqual(own.makeProject, orchestrator.MAKE_PROJECT);
    assert.equal(own.makeProject.setupFinishes, false);
    const { note } = own.makeProject;
    assert.match(note, /^Make it on "What do you want to make\?" \(\/#create\) works on these copies for whoever has free app slots/);
    assert.match(note, /availableFixtures says who/);
    assert.match(note, /no rights to create its database, no image builder and no GitHub/);
    assert.match(note, /"Setting it up didn’t finish" and "Setup stopped before it was running" with Try again, on both addresses alike/,
      'in the words the screen uses, so the agent can wait for them');
    assert.match(note, /A remix stops the same way too, and importing a GitHub repository is refused/);
    assert.match(note, /not the change failing: never use outcome "failed" for it/);
    assert.match(note, /can be shot once the setup has stopped on both addresses/);
    assert.match(note, /call skip_change for it at once, saying these copies cannot set up\s+a new project/);
    assert.match(note, /five projects an hour on each\s+address, its phone browser included/);
    assert.doesNotMatch(note, /[—]/, 'no em dashes in model copy');

    assert.equal('makeProject' in briefFor({ childApp: true }), false, 'a child app makes no projects');
    assert.equal('makeProject' in briefFor({}), false);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// Every screen is also shot in dark mode (#4459), by the mode parameter
// each copy answers: an app built on Homeroom reads un-theme, Homeroom
// itself reads theme.
test('the brief\'s dark mode names the parameter the copy answers', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-dark-mode-'));
  try {
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [] }));
    const briefFor = (options) => orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: { pr_title: 'Dark mode shots' },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['public/app.js'], filesComplete: true,
        diffSummary: { text: '', fileCount: 1, truncated: false },
      },
      pair: { sides: { base: {}, head: { checkout } } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
      intent: contract.parseIntent(fixtures.intent()),
      ...options,
    });
    // save_shot takes the dark shots where the page stands (#6787); the
    // parameter is for the ones it leaves.
    assert.deepEqual(briefFor({ childApp: true }).darkMode, {
      param: 'un-theme', value: 'dark',
      note: 'save_shot takes the dark shots. For one it lists in darkLeft, add un-theme=dark to the start path\'s query.',
    });
    assert.deepEqual(briefFor({ selfApp: true }).darkMode, {
      param: 'theme', value: 'dark',
      note: 'save_shot takes the dark shots. For one it lists in darkLeft, add theme=dark to the start path\'s query.',
    });
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// PR 4626's notification for a reply in a topic's thread was skipped: "it
// needs a second account to reply to my message, and I can't sign in as
// another account" (2026-10-09). The other signed-in browsers are that
// account, and the brief says so, in fixed words.
test('the brief says another persona\'s browser can be the second account a change needs', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-second-account-'));
  try {
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [] }));
    const briefFor = (options) => orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: { pr_title: 'Reply threads in topics' },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['public/js/group-chat.js'], filesComplete: true,
        diffSummary: { text: '', fileCount: 1, truncated: false },
      },
      pair: { sides: { base: {}, head: { checkout } } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
      intent: contract.parseIntent(fixtures.intent()),
      ...options,
    });
    const own = briefFor({ selfApp: true });
    assert.deepEqual(own.secondAccount.personas, ['member', 'read_only_admin', 'full_admin']);
    assert.ok(own.secondAccount.personas.every((persona) => persona in own.browsers));
    assert.match(own.secondAccount.note, /^The member, read_only_admin and full_admin browsers are three different signed-in accounts\./);
    assert.match(own.secondAccount.note, /a reply to the member's message, a vote on\s+their change/);
    assert.match(own.secondAccount.note, /take that step in another of these browsers, the same way on the before and the after address, then shoot in the browser screenBrowsers names/);
    assert.match(own.secondAccount.note, /use full_admin when you can: it is a member of Homeroom's own project on these copies/);
    assert.match(own.secondAccount.note, /The guest browser is not signed in, so it cannot be that account\.$/);
    const child = briefFor({ childApp: true });
    assert.match(child.secondAccount.note, /three different signed-in accounts/);
    assert.doesNotMatch(child.secondAccount.note, /Homeroom's own project/, 'only Homeroom\'s copies make the full admin a member');
    assert.doesNotMatch(JSON.stringify(own.secondAccount), /[—]/, 'no em dashes in model copy');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// ── The shots brief ──────────────────────────────────────────────────────

test('shots brief ranks a relevant check beyond the first 80 manifest entries', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-checks-'));
  try {
    const tests = Array.from({ length: 100 }, (_, index) => ({
      name: `Generic screen ${index}`, path: `/screen-${index}`,
    }));
    tests.push({
      name: 'Workshop plus button closes the view tab strip',
      path: '/workshop', expectSelector: '.dev-ws-plus',
    });
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
    const intent = { stories: [{
      claim: 'The Workshop plus button sits below the tab strip.',
      intent: { steps: ['Open the Workshop'] },
    }] };
    const selected = orchestrator.declaredCheckSummary(checkout, intent);
    assert.equal(selected.length, 80);
    assert.equal(selected[0].path, '/workshop');
    assert.equal('testedAs' in selected[0], false, 'the system prompt names the checks\' persona once');
    assert.equal(orchestrator.declaredCheckSummary(checkout)[0].path, '/screen-0');
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('the brief names the declared changes, both addresses and revisions, and no fixture secrets', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-testing-route-'));
  const route = '/?demo=1&ws=status#app/demo/workshop';
  try {
    const tests = Array.from({ length: 100 }, (_, index) => ({
      name: `Generic screen ${index}`, path: `/screen-${index}`,
    }));
    tests.push({ name: 'View strip', path: route, expectSelector: '.dev-ws-plus' });
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
    const intent = contract.parseIntent(fixtures.intent());
    const fixtureEnv = { SESSION_SECRET: 'fixture-session-secret' };
    const brief = orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: {
        pr_title: 'Small spacing change', testing_path: route,
        testing_paths: [{ path: route, viewport: 'desktop' },
          { path: '/?token=secret.jwt#app/demo/workshop', viewport: 'phone' }],
        testing_md: 'Open the Workshop and inspect the view strip.',
      },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['frontend/src/Shell.tsx'], filesComplete: true,
        diffSummary: { text: 'diff --git a/frontend/src/Shell.tsx', fileCount: 1, truncated: false },
      },
      pair: {
        fixtureFingerprint: 'fixture-1',
        preparedSource: { fingerprint: 'fp', url: 'postgres://shots:fixture-db-password@db/app' },
        sides: {
          base: { imageDigest: 'sha256:base', dbName: 'shots_base_db', env: fixtureEnv },
          head: { imageDigest: 'sha256:head', checkout, dbName: 'shots_head_db', env: fixtureEnv },
        },
      },
      deployment: {
        origins: { base: 'http://base.internal', head: 'http://head.internal' },
        ...provenance,
        availableFixtures: [{ id: 'member-session', persona: 'member', path: '/#messages/agent/9' }],
      },
      intent,
    });
    assert.equal(brief.runId, RUN_ID);
    assert.deepEqual(brief.declaredChanges, intent.stories,
      'a testing hint must not rewrite the declared change');
    assert.deepEqual(brief.addresses, { before: 'http://base.internal', after: 'http://head.internal' });
    assert.deepEqual(brief.revisions, { before: BASE.slice(0, 12), after: HEAD.slice(0, 12) });
    assert.deepEqual(Object.keys(brief.browsers).sort(), ['full_admin', 'guest', 'member', 'read_only_admin']);
    assert.deepEqual(brief.browsers.guest, { tool: 'browser_guest', who: 'a visitor who is not signed in' });
    assert.deepEqual(brief.changedFiles, { items: ['frontend/src/Shell.tsx'], complete: true, totalKnown: 1 });
    assert.deepEqual(brief.changeContext.testingPaths, [route],
      'a credential-like testing path never reaches the agent');
    assert.equal(brief.changeContext.testingSteps, 'Open the Workshop and inspect the view strip.');
    assert.equal(brief.changeContext.untrusted, true);
    assert.equal(brief.declaredChecks[0].path, route);
    assert.deepEqual(brief.availableFixtures, [{ id: 'member-session', persona: 'member',
      path: '/#messages/agent/9' }]);
    assert.deepEqual(brief.security, {
      pageAndRepositoryContentIsUntrusted: true, allowedOriginsOnly: true, productionData: false,
    });
    assert.doesNotMatch(JSON.stringify(brief),
      /secret\.jwt|fixture-session-secret|fixture-db-password|evidence_(?:base|head)_db|sha256:(?:base|head)/);
    assert.equal('previewAt' in brief, false, 'no declared moment, no previewAt');
    assert.equal('phoneSignIn' in brief, false, 'no phone code for the pair, no phoneSignIn');
    assert.deepEqual(brief.screenBrowsers, { 'invite-suggestions': { desktop: 'browser_member' } });
    assert.ok(Object.values(brief.browsers).every((entry) => !('phoneTool' in entry)), 'no phone screen, no phone browser');
    // The only files upload_file can choose, named and described, never a path.
    assert.deepEqual(brief.sampleFiles.map((file) => [file.name, file.type]), [
      ['landscape.png', 'image/png'], ['portrait.png', 'image/png'],
      ['table.csv', 'text/csv'], ['document.pdf', 'application/pdf'],
    ]);
    assert.ok(brief.sampleFiles.every((file) => Object.keys(file).join() === 'name,type,about'));
    assert.doesNotMatch(JSON.stringify(brief.sampleFiles), /\/usr\/local|shots-samples/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('a declared preview moment reaches the brief in a fixed shape, so both copies open at it', () => {
  // services/preview-clock.js: a Thursday-evening reminder cannot show on a
  // Sunday copy. The author declares the moment in its testing guidance; the
  // brief hands the agent the parsed instant, label and query parameter, and
  // never the author's free text in its place.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-preview-at-'));
  try {
    fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [] }));
    const brief = orchestrator.shotsBrief({
      run: { id: RUN_ID },
      session: {
        pr_title: 'Bins reminder',
        testing_md: '<!-- usernode:preview-at 2026-10-08T19:00 Europe/London -->\n1. Open the rota.',
      },
      revision: {
        baseSha: BASE, headSha: HEAD, files: ['public/app.js'], filesComplete: true,
        diffSummary: { text: '', fileCount: 1, truncated: false },
      },
      pair: { sides: { base: {}, head: { checkout } } },
      deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
      intent: contract.parseIntent(fixtures.intent()),
    });
    assert.deepEqual(brief.previewAt, {
      at: '2026-10-08T18:00:00.000Z', label: 'Thursday 8 Oct, 7 pm', zone: 'Europe/London', param: 'un-now',
    });
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

// ── Workers, threads and backends ────────────────────────────────────────

// A merge retires the proposal's worker only once no shots run is using it
// (admin export 2026-10-02: a merge in the middle of a run killed the shots
// agent about 30 seconds later). That wait is the merge-followups machine's
// worker.retire work, which reads the run from its row: see
// tests/workflow-merge-followups-services.test.js and
// tests/workflow-merge-followups-postgres.test.js.

// ── Agent diagnostics and trace privacy ─────────────────────────────────

// ── Heartbeat, terminal metadata and storage fencing ────────────────────

test('a step\'s failure is said without the credentials its error carried', () => {
  const error = Object.assign(new Error('Request failed: token=secret.jwt api_key=topsecret'), {
    code: 'bad-code-with-punctuation',
  });
  assert.doesNotMatch(orchestrator.visibleError(error), /secret\.jwt|topsecret/);
});

// ── Scheduling and claiming ──────────────────────────────────────────────

test('revision resolution prefers the immutable recorded base and reviewed head', async () => {
  assert.equal(orchestrator.headForSession({
    reviewed_head_sha: HEAD,
    handoff_head_sha: 'c'.repeat(40),
    checks_commit_sha: 'd'.repeat(40),
  }), HEAD);
  let repoHeadCalls = 0;
  const refs = [];
  const result = await orchestrator.resolveRevisionContext({
    repo_url: 'https://github.com/acme/demo.git',
    handoff_base_sha: BASE,
    reviewed_head_sha: HEAD,
  }, null, {
    getRepoHead: async () => { repoHeadCalls += 1; throw new Error('must not move the base'); },
    compareRefs: async (_owner, _repo, ref) => {
      refs.push(ref);
      return { files: ['frontend/dialog.tsx'], filesComplete: true };
    },
    getProposalDiff: async (_owner, _repo, ref, budget) => {
      assert.equal(ref, `${BASE}...${HEAD}`);
      assert.equal(budget, 8000);
      return { diff: 'diff --git a/frontend/dialog.tsx b/frontend/dialog.tsx', fileCount: 1, truncated: false };
    },
  });
  assert.equal(repoHeadCalls, 0);
  assert.deepEqual(refs, [`${BASE}...${HEAD}`]);
  assert.equal(result.baseSha, BASE);
  assert.equal(result.headSha, HEAD);
  assert.equal(result.diffSummary.fileCount, 1);
  assert.match(result.diffSummary.text, /frontend\/dialog\.tsx/);
});

test('a platform change\'s recorded base from before empty previews gives way to where its head meets main', async () => {
  const MERGE_BASE = 'c'.repeat(40);
  const resolve = async (session, marker) => {
    const asked = [];
    const result = await orchestrator.resolveRevisionContext({
      repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git',
      handoff_base_sha: BASE, reviewed_head_sha: HEAD, ...session,
    }, null, {
      getFileContent: async (_owner, _repo, file, ref) => { asked.push(`${file}@${ref}`); return marker; },
      getRepoHead: async () => ({ defaultBranch: 'main' }),
      compareRefs: async (_owner, _repo, ref) => (ref === `main...${HEAD}` ? { mergeBaseSha: MERGE_BASE } : { files: [] }),
    });
    return { baseSha: result.baseSha, asked };
  };
  // An update with main left the recorded base behind: the before side
  // moves to the merge base, which carries the marker.
  assert.deepEqual(await resolve({ app_slug: 'usernode-2d5619' }, null),
    { baseSha: MERGE_BASE, asked: [`src/db/preview-boot.json@${BASE}`] });
  assert.equal((await resolve({ app_slug: 'usernode-2d5619' }, '{"startsEmpty":0}')).baseSha, MERGE_BASE);
  // A base that can boot empty stays, and no other app is asked about it.
  assert.equal((await resolve({ app_slug: 'usernode-2d5619' }, '{"startsEmpty":1}')).baseSha, BASE);
  assert.deepEqual(await resolve({ app_slug: 'some-app-1a2b3c' }, null), { baseSha: BASE, asked: [] });
  // A pinned base (a run's later steps, an eval's trial) is never moved.
  const pinned = await orchestrator.resolveRevisionContext({
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git', app_slug: 'usernode-2d5619', reviewed_head_sha: HEAD,
  }, null, {
    getFileContent: async () => { throw new Error('must not ask'); },
    compareRefs: async () => ({ files: [] }),
  }, { baseSha: BASE });
  assert.equal(pinned.baseSha, BASE);
});

test('paired resets are fenced by both exact revisions and immutable fixture provenance', () => {
  assert.equal(orchestrator.sameProvenance(provenance, provenance), true);
  assert.equal(orchestrator.sameProvenance({ ...provenance, headSha: 'c'.repeat(40) }, provenance), false);
  assert.equal(orchestrator.sameProvenance({ ...provenance, baseImageDigest: 'sha256:other' }, provenance), false);
});

// ── Stop ─────────────────────────────────────────────────────────────────

test('the trace keeps when the agent\'s startup reached each step, whatever the event window drops', () => {
  const metrics = orchestrator.newRunMetrics();
  metrics.startedAtMs = Date.now() - 5000;
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'worker_prepare_start' });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'get_brief' });
  const first = metrics.agentActivity.firstAtMs.tool_start;
  assert.ok(first >= 5000, 'measured from the run\'s start');
  metrics.startedAtMs -= 60_000;
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'save_shot' });
  assert.equal(metrics.agentActivity.firstAtMs.tool_start, first, 'the first time only');
  // A long run pushes the startup out of the event window; the milestones stay.
  for (let i = 0; i < 400; i += 1) orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_end', tool: 'save_shot' });
  const summary = orchestrator.traceSummary(metrics).agentActivity;
  assert.ok(!summary.events.some((event) => event.kind === 'worker_prepare_start'));
  assert.deepEqual(Object.keys(summary.firstAtMs).sort(), ['tool_start', 'worker_prepare_start']);
  assert.ok(!('tool_end' in summary.firstAtMs), 'only the startup steps are kept');
});

test('a failed shots sign-in reaches the trace and the failure reason with its stage and cause, and no URL', () => {
  const bootstrap = require('../worker/shots-browser-bootstrap.js');
  const { SessionBootstrapError } = require('../worker/session-bootstrap');
  // A Playwright timeout names the navigation URL, token included.
  const timeout = Object.assign(
    new Error('page.goto: Timeout 30000ms exceeded.\nnavigating to "http://sv-shots-b:3000/?token=SECRET-TOKEN"'),
    { name: 'TimeoutError' }
  );
  const event = bootstrap.failureEvent(timeout, {
    persona: 'member', side: 'head', stage: 'navigate', bootstrap: { attempted: true, responseStatus: 302 },
  });
  assert.deepEqual(event, {
    kind: 'auth_bootstrap', outcome: 'error', persona: 'member', side: 'head',
    failureStage: 'navigate', errorClass: 'timeout', attempted: true, responseStatus: 302,
  });
  const summary = bootstrap.failureSummary(event);
  assert.equal(summary,
    'shots browser authentication failed (member on head) while opening the app: timeout, HTTP 302');
  assert.ok(!JSON.stringify(event).includes('SECRET') && !summary.includes('SECRET')
    && !summary.includes('http://'), 'nothing is copied from the error text');

  // A controlled error keeps its code; an unknown stage reads as configuration.
  const cookie = bootstrap.failureEvent(
    new SessionBootstrapError('session_bootstrap_failed', 'The shots browser did not retain its private session cookie.'),
    { persona: 'full_admin', side: 'base', stage: 'exchange', bootstrap: { responseStatus: 502 } }
  );
  assert.equal(cookie.failureCode, 'session_bootstrap_failed');
  assert.equal(bootstrap.failureSummary(cookie),
    'shots browser authentication failed (full_admin on base) while exchanging the sign-in token: session_bootstrap_failed, HTTP 502');
  assert.equal(bootstrap.failureEvent(new Error('x'), { stage: 'nonsense' }).failureStage, 'configure');
  assert.equal(bootstrap.errorClass(new Error('net::ERR_CONNECTION_REFUSED at http://x')), 'network');

  // The trace keeps exactly those fields.
  const metrics = orchestrator.newRunMetrics();
  orchestrator.recordAgentDiagnostic(metrics, { ...event, failureCode: 'x y', note: 'dropped' });
  orchestrator.recordAgentDiagnostic(metrics, cookie);
  const [first, second] = orchestrator.traceSummary(metrics).agentActivity.events;
  assert.equal(first.failureStage, 'navigate');
  assert.equal(first.errorClass, 'timeout');
  assert.equal(first.outcome, 'error');
  assert.equal(first.responseStatus, 302);
  assert.equal(first.failureCode, undefined, 'a code that is not a fixed identifier is dropped');
  assert.equal(first.note, undefined);
  assert.equal(second.failureCode, 'session_bootstrap_failed');

  // The runner turns the summary into the run's failure reason.
  const runner = fs.readFileSync(path.join(__dirname, '../worker/run-cc.sh'), 'utf8');
  assert.match(runner, /export SHOTS_BOOTSTRAP_FAILURE_FILE="\$SHOTS_TMP\/browser-bootstrap\.failure"/);
  assert.match(runner, /\|\| die "\$\(head -c 300 "\$SHOTS_BOOTSTRAP_FAILURE_FILE"/);
});

test('the trace names the guest browser as the guest, never as another persona', () => {
  const metrics = orchestrator.newRunMetrics();
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'browser_call_start', persona: 'guest',
    callOrdinal: 1, tool: 'browser_navigate', side: 'head' });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'browser_server_exit', persona: 'guest', exitCode: 0 });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'browser_call_start', persona: 'visitor',
    callOrdinal: 2, tool: 'browser_navigate', side: 'head' });
  const events = orchestrator.traceSummary(metrics).agentActivity.events;
  assert.deepEqual(events.map((event) => event.persona), ['guest', 'guest', undefined]);
});

test('the trace keeps whether a hosted app\'s page load carried the persona identity, as a boolean only', () => {
  const metrics = orchestrator.newRunMetrics();
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'document_request', side: 'head', identityAttached: true });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'document_request', side: 'base', identityAttached: 'member.jwt' });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'get_brief', identityAttached: true });
  const [attached, junk, other] = orchestrator.traceSummary(metrics).agentActivity.events;
  assert.equal(attached.identityAttached, true);
  assert.equal(junk.identityAttached, undefined, 'anything but a boolean is dropped');
  assert.equal(other.identityAttached, undefined, 'and only a page load carries it');
});

test('the trace keeps that a page load was sent on to its address with the display token, and nothing else of it', () => {
  const metrics = orchestrator.newRunMetrics();
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'document_request', side: 'head',
    identityAttached: false, identityRedirect: true });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'document_request', side: 'base', identityRedirect: '/?token=x' });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'get_brief', identityRedirect: true });
  const [sent, junk, other] = orchestrator.traceSummary(metrics).agentActivity.events;
  assert.equal(sent.identityRedirect, true);
  assert.equal(sent.identityAttached, false);
  assert.equal(junk.identityRedirect, undefined, 'only true is kept, never the address');
  assert.equal(other.identityRedirect, undefined, 'and only a page load carries it');
});

test('the trace counts the shots proxy\'s refusals of a destination by reason only', () => {
  const metrics = orchestrator.newRunMetrics();
  for (const blockReason of ['private_address', 'port', 'dns']) {
    orchestrator.recordAgentDiagnostic(metrics, { kind: 'egress_blocked', blockReason });
  }
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'egress_blocked', blockReason: '10.0.0.5', host: 'internal.example' });
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'get_brief', blockReason: 'port' });
  const events = orchestrator.traceSummary(metrics).agentActivity.events;
  assert.deepEqual(events.map((event) => [event.kind, event.blockReason]), [
    ['egress_blocked', 'private_address'], ['egress_blocked', 'port'], ['egress_blocked', 'dns'],
    ['egress_blocked', undefined], ['tool_start', undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(events), /internal\.example|10\.0\.0\.5/);
});


test('the trace keeps the worker\'s memory as a summary of numbers, outside the agent\'s event ring', () => {
  const metrics = orchestrator.newRunMetrics();
  orchestrator.recordAgentDiagnostic(metrics, { kind: 'tool_start', tool: 'get_brief', sequence: 1 });
  const samples = [
    { usedMb: 900, limitMb: 2048, peakMb: 950, oomKills: 3, rssMb: { browser: 500, agent: 300, mcp: 60, proxy: 30, other: 10 }, browserProcesses: 4 },
    { usedMb: 2040, limitMb: 2048, peakMb: 2047, oomKills: 4, rssMb: { browser: 1500, agent: 390, mcp: 90, proxy: 30, other: 20 }, browserProcesses: 11 },
    { usedMb: 1200, limitMb: 2048, peakMb: 2047, oomKills: 5, rssMb: { browser: 700, agent: 'lots', mcp: -1, proxy: 30, other: 9e9, cmdline: 1 }, browserProcesses: 6 },
    { usedMb: '/proc/1/cmdline', limitMb: null, peakMb: null, oomKills: null, rssMb: null, browserProcesses: null, path: '/tmp/x' },
  ];
  for (const sample of samples) orchestrator.recordAgentDiagnostic(metrics, { kind: 'worker_memory', ...sample });
  const trace = orchestrator.traceSummary(metrics);
  assert.deepEqual(trace.agentActivity.events.map((event) => event.kind), ['tool_start'],
    'samples every few seconds would push the agent\'s own events out');
  const { lastAtMs, ...memory } = trace.workerMemory;
  assert.ok(Number.isSafeInteger(lastAtMs));
  assert.deepEqual(memory, {
    samples: 4, limitMb: 2048, peakUsedMb: 2040, lastUsedMb: null, containerPeakMb: 2047,
    peakRssMb: { browser: 1500, agent: 390, mcp: 90, proxy: 30, other: 20 }, peakBrowserProcesses: 11,
    oomKillsDuringTurn: 2,
  });
  assert.doesNotMatch(JSON.stringify(trace), /cmdline|tmp|proc/);
  // A run with no samples has no memory summary at all.
  assert.equal('workerMemory' in orchestrator.traceSummary(orchestrator.newRunMetrics()), false);
});

test('the trace counts the proxy\'s refusals by reason and kind of host', () => {
  const metrics = orchestrator.newRunMetrics();
  for (const event of [
    { blockReason: 'private_address', hostKind: 'pair_host' },
    { blockReason: 'private_address', hostKind: 'pair_host' },
    { blockReason: 'dns', hostKind: 'other' },
    { blockReason: 'port', hostKind: 'loopback' },
    { blockReason: 'private_address', hostKind: 'internal.example' },
    { blockReason: 'private_address' },
    { blockReason: '10.0.0.5', hostKind: 'pair_host' },
  ]) orchestrator.recordAgentDiagnostic(metrics, { kind: 'egress_blocked', ...event });
  const { agentActivity } = orchestrator.traceSummary(metrics);
  assert.deepEqual(agentActivity.egressBlocked, {
    'private_address:pair_host': 2, 'dns:other': 1, 'port:loopback': 1, 'private_address:unknown': 2,
  });
  assert.equal(agentActivity.events.at(-3).hostKind, undefined, 'an unknown kind of host is dropped');
  assert.doesNotMatch(JSON.stringify(agentActivity), /internal\.example|10\.0\.0\.5/);
});

// #4575: the shots run lost a race with the Homeroom bot's turn on the same
// session. The run waited for an idle session once, before building its
// copies, and the bot took the session while they built: the dispatch died
// with "execInWorker: durable active turn could not be persisted".
function sessionBusyError() {
  return Object.assign(new Error('execInWorker: another turn already owns this session'), {
    code: 'durable_turn_persist_failed', persistCode: 'session_busy', sessionBusy: true,
  });
}

test('only a busy agent reads as retryable, never a failed one', () => {
  assert.equal(orchestrator.agentBusyRetryable(sessionBusyError()), true);
  assert.equal(orchestrator.agentBusyRetryable({ code: 'TURN_IN_FLIGHT' }), true);
  assert.equal(orchestrator.agentBusyRetryable({ code: 'session_busy' }), true);
  assert.equal(orchestrator.agentBusyRetryable({ code: 'durable_retry_persist_failed' }), true);
  assert.equal(orchestrator.agentBusyRetryable({ code: 'shots_agent_failed' }), false);
  assert.equal(orchestrator.agentBusyRetryable({ code: 'shots_agent_timeout' }), false);
  assert.equal(orchestrator.agentBusyRetryable(null), false);
});

// ── A platform fault is recorded so the sweep can take the run again ──

test('a platform fault is read off the error, and GitHub\'s limit waits for its reset', () => {
  const now = Date.parse('2026-10-12T09:00:00Z');
  const fault = (error) => orchestrator.platformFault(error, { now });
  assert.deepEqual(fault({ shotsPlatformFault: 'database' }), { kind: 'database' });
  assert.deepEqual(fault({ shotsPlatformFault: 'clone' }), { kind: 'clone' });
  assert.deepEqual(fault({ code: 'shots_agent_failed', shotsExitCode: 1 }), { kind: 'agent_exit' });
  assert.deepEqual(fault(new Error("clone failed: Cloning into '.'... | fatal: could not read Username")),
    { kind: 'worker_bootstrap' });
  assert.deepEqual(fault(new Error('warm-ready timeout for usernode-worker-42')), { kind: 'worker_bootstrap' });
  // GitHub's hourly limit: once it has reset, with a minute to spare; within
  // the hour when the reset is not known.
  assert.deepEqual(fault({ code: 'github_rate_limited', retryAfterMs: 3 * 60_000 }),
    { kind: 'github_rate_limited', retryAt: now + 4 * 60_000 });
  assert.deepEqual(fault({ code: 'github_rate_limited' }),
    { kind: 'github_rate_limited', retryAt: now + 15 * 60_000 });
  assert.deepEqual(fault({ code: 'github_rate_limited', retryAfterMs: 5 * 3600_000 }),
    { kind: 'github_rate_limited', retryAt: now + 65 * 60_000 }, 'never more than the hour and a little');
  // #6598: GitHub did not answer when the shots run tried to start. Taken
  // again once, a few minutes on, by the recovery sweep.
  assert.deepEqual(fault({ code: 'github_unavailable' }),
    { kind: 'github_unavailable', retryAt: now + 5 * 60_000 });

  for (const error of [
    null,
    new Error('Image build failed'),
    // The wrapper dying is structural; the worker does not retry it either.
    new Error('warm wrapper exited before warm-ready (code=1)'),
    { code: 'shots_capture_incomplete' },
    { code: 'shots_change_failed' },
    { code: 'shots_stopped' },
    { code: 'visible_changes_conflict' },
    { shotsPlatformFault: 'not_a_kind' },
  ]) {
    assert.equal(fault(error), null, String(error?.code || error?.message || error?.shotsPlatformFault || error));
  }
});

// trace_summary.tokenUsage was null on every shots run (18 Nov 2026). The
// run adds up what its turn spent from whichever way the turn's end arrived:
// the dispatch's own usage (also for a turn that failed or ran out of time),
// or the result of a turn a restart followed, whose cost is in dollars.
test('a run\'s trace says what its agent spent, however the turn ended', () => {
  const live = orchestrator.newRunMetrics();
  orchestrator.addAgentUsage(live, { result: { exitCode: 0 }, usage: { inputTokens: 5, outputTokens: 7, costCents: 2 } });
  assert.deepEqual(orchestrator.traceSummary(live).tokenUsage, { inputTokens: 5, outputTokens: 7, costCents: 2 });

  const followed = orchestrator.newRunMetrics();
  orchestrator.addAgentUsage(followed, { result: { inputTokens: 10, cachedInputTokens: 900, outputTokens: 40, costUsd: 0.125 } });
  assert.deepEqual(orchestrator.traceSummary(followed).tokenUsage,
    { inputTokens: 10, cachedInputTokens: 900, outputTokens: 40, costCents: 12.5 });

  const stopped = orchestrator.newRunMetrics();
  orchestrator.addAgentUsage(stopped, { result: null, agentError: { code: 'shots_agent_timeout' },
    usage: { inputTokens: 30, cachedInputTokens: 500, outputTokens: 2, streamed: 1 } });
  assert.deepEqual(orchestrator.traceSummary(stopped).tokenUsage,
    { inputTokens: 30, cachedInputTokens: 500, outputTokens: 2, streamed: 1 });

  const none = orchestrator.newRunMetrics();
  orchestrator.addAgentUsage(none, { result: null, agentError: { code: 'shots_agent_failed' } });
  assert.equal(Object.hasOwn(orchestrator.traceSummary(none), 'tokenUsage'), false);
});
