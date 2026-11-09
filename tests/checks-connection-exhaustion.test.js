// Connection exhaustion is 'error', not 'failing' (#1771).
//
// A preview whose queries throw because the SHARED Postgres has no
// connection left produces exactly the artefacts of a broken commit: 500s
// on every route, an assertion failure on every declared check. One
// proposal came back with 65 failures all citing one endpoint. Nothing in
// the diff was wrong, nothing anywhere named the cause, and the author's
// card showed a red X next to their name.
//
// This is the same shape as #1381's unreachable origin, one layer down: the
// origin resolved and the container answered, it just could not reach its
// database. So it gets the same treatment, guarded by the same every-row
// rule, and the same three surfaces have to agree about it:
//
//   - the CHECKS pipeline, when the app boots and then answers 500s;
//   - the BOOT path, when the app cannot get a connection at startup and
//     never becomes healthy at all;
//   - the AUTHOR, who is told about neither, because neither is theirs
//     (the preview machine's prepareFailed write).
//
// Run with: node --test tests/checks-connection-exhaustion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/^[ \t]*\/\/.*$/gm, '');

const {
  mentionsConnectionLimit, connectionExhaustionMessage,
} = require('../src/db/connection-census');
const { connectionExhaustionDetail } = require('../src/services/visuals');
const {
  summarizeBootFailure, bootFailureIsInfrastructure, MAX_REASON,
} = require('../src/services/deploy-failure');

const ORIGIN = 'http://usernode-staging-recipe-box--4102:3000';
const SATURATED = { max: 100, used: 99, idle: 61, free: 1, saturated: true, topDatabases: [] };
const CALM = { max: 100, used: 31, idle: 20, free: 69, saturated: false, topDatabases: [] };

function row(name, { pass = false, errors = [], failureReason = '' } = {}) {
  return {
    name, path: `/${name}`, status: pass ? 'pass' : 'fail',
    consoleErrors: errors, failureReason,
  };
}

// What the browser sees: the app answered, it just answered 500. The page
// never quotes the database, which is why the census has to exist at all.
const FIVE_HUNDRED = [{ kind: 'load', message: 'page returned HTTP 500', source: ORIGIN }];

// ── The text ─────────────────────────────────────────────────────────────

test('both halves of the wall are recognised in a log blob', () => {
  for (const text of [
    'error: sorry, too many clients already',
    'FATAL:  remaining connection slots are reserved for non-replication superuser connections',
    'FATAL: too many connections for database "app_recipe_box_staging_s4102_9ab31c"',
    'error: connection failed (SQLSTATE 53300)',
  ]) {
    assert.equal(mentionsConnectionLimit(text), true, `should recognise: ${text}`);
  }
  // The per-database ceiling this issue adds is the same event scoped to one
  // preview, so it must read as infrastructure too, not as that preview's
  // own misbehaviour.
  assert.equal(mentionsConnectionLimit('error: relation "posts" does not exist'), false);
  assert.equal(mentionsConnectionLimit('too many redirects'), false);
  assert.equal(mentionsConnectionLimit(''), false);
  assert.equal(mentionsConnectionLimit(null), false);
});

test('the message leads with the thing the author needs and fits the field', () => {
  const detail = connectionExhaustionMessage(SATURATED, { where: 'ran its checks' });
  // check_error_detail is 280 chars and is rendered on the proposal card.
  assert.ok(detail.length <= MAX_REASON, `${detail.length} chars must fit ${MAX_REASON}`);
  assert.match(detail, /^Infrastructure problem, not this change/,
    'the first clause is the one that stops the author re-reading their diff');
  assert.match(detail, /99 of 100 server connections in use/, 'the evidence rides along');
  assert.match(detail, /retry/i, 'and what happens next');
  // Platform convention: no em dashes in user-facing copy.
  assert.doesNotMatch(detail, /—|&mdash;|&#8212;/, 'user-facing copy carries no em dash');
  // A census cannot always be taken on a server that is out of connections,
  // so the sentence has to work without one.
  const bare = connectionExhaustionMessage(null, { where: 'started' });
  assert.match(bare, /while the preview started\./, 'reads as a sentence with no figures');
  assert.doesNotMatch(bare, /undefined|NaN|\(\)/);
});

// ── The checks pipeline ──────────────────────────────────────────────────

test('every row failing on a saturated server is an infrastructure verdict', () => {
  const detail = connectionExhaustionDetail(
    [row('home', { errors: FIVE_HUNDRED }), row('board', { errors: FIVE_HUNDRED })],
    { origin: ORIGIN, census: SATURATED }
  );
  assert.ok(detail, 'a starved preview must be distinguishable from a broken diff');
  assert.match(detail, /Infrastructure problem, not this change/);
});

test('a row that NAMES the limit is enough on its own', () => {
  // No census — the server may already be refusing the census query itself.
  const named = connectionExhaustionDetail(
    [row('home', { failureReason: 'FATAL: sorry, too many clients already' })],
    { origin: ORIGIN, census: null }
  );
  assert.ok(named, 'proof does not need corroboration');
  const viaConsole = connectionExhaustionDetail(
    [row('home', { errors: [{ kind: 'console', message: 'error: sorry, too many clients already' }] })],
    { origin: ORIGIN, census: null }
  );
  assert.ok(viaConsole, 'wherever the complaint surfaced');
});

test('ONE failing route among passing ones stays the diff\'s problem', () => {
  // The load-bearing guard, inherited from #1381. A preview that served
  // other routes had a working database, so this route is the author's bug
  // however busy the server was when it ran.
  const detail = connectionExhaustionDetail(
    [row('home', { pass: true }), row('board', { errors: FIVE_HUNDRED })],
    { origin: ORIGIN, census: SATURATED }
  );
  assert.equal(detail, null);
  // And it holds even when the failing row names the limit: an app that
  // exhausts its OWN clone's ceiling on one endpoint is leaking connections,
  // which is precisely the bug a check should catch.
  const leaky = connectionExhaustionDetail(
    [row('home', { pass: true }), row('report', { failureReason: 'too many connections for database' })],
    { origin: ORIGIN, census: SATURATED }
  );
  assert.equal(leaky, null);
});

test('a total wipeout on a calm server is still the diff\'s problem', () => {
  // Without either piece of evidence this is just a broken commit, and
  // re-labelling it would let real failures through the merge gate.
  assert.equal(connectionExhaustionDetail(
    [row('home', { errors: FIVE_HUNDRED }), row('board', { errors: FIVE_HUNDRED })],
    { origin: ORIGIN, census: CALM }
  ), null);
  assert.equal(connectionExhaustionDetail([], { census: SATURATED }), null,
    'no rows is a different failure, already handled as error by classifyTests');
});

test('the run block flips the verdict, and only from failing', () => {
  const src = stripComments(read('src/services/visuals.js'));
  const at = src.indexOf("if (checksResult.state !== 'passing') {");
  assert.ok(at > 0, 'the census sampling block must still exist');
  const block = src.slice(at, at + 1600);
  assert.match(block, /connectionExhaustionDetail\(containerRows, \{ origin: stagingOrigin, census \}\)/);
  assert.match(block, /checksResult\.state === 'failing'/,
    "an 'error' run is already right; a 'passing' one is never overridden");
  assert.match(block, /checksResult\.state = 'error';/);
  assert.match(block, /checksResult\.errorDetail = detail;/);
  // Synthesized rows never loaded a page, so they must not vote on whether
  // every row failed — the same exclusion #1381 makes.
  assert.match(block, /checksResult\.results\.filter\(\(r\) => !extraRows\.includes\(r\)\)/);
  // storeChecks stays a pure write: two other suites pin its query order.
  const writers = read('src/workflow/preview/check-store.ts');
  const store = writers.slice(writers.indexOf('async function storeChecks('), writers.indexOf('async function storeChecksSkipped'));
  assert.ok(store.length > 0, 'the verdict writer is where it is read from');
  assert.doesNotMatch(store, /connectionCensus|connectionExhaustionDetail/,
    'the persistence path gains no query');
});

// ── The boot path ────────────────────────────────────────────────────────

test('a container that never got a connection reports the cause, not the symptom', () => {
  const err = {
    healthcheckFailed: true,
    containerStatus: 'exited',
    containerLogs: [
      '> recipe-box@1.0.0 start',
      '> node server.js',
      'error: sorry, too many clients already',
      '    at /app/node_modules/pg-pool/index.js:45:11',
    ].join('\n'),
  };
  assert.equal(bootFailureIsInfrastructure(err), true);
  const reason = summarizeBootFailure(err);
  assert.match(reason, /Infrastructure problem, not this change/,
    'the most specific error line is true and still the wrong answer');
  assert.ok(reason.length <= MAX_REASON);
});

test('the complaint is found wherever the container put it', () => {
  // A crash on first query lands in the logs; a `docker run` the daemon
  // refused lands on stderr; a rejected execFile buries it in the message.
  assert.equal(bootFailureIsInfrastructure({ stderr: 'FATAL: too many connections for role "x_owner"' }), true);
  assert.equal(bootFailureIsInfrastructure({ message: 'Command failed: docker run ...\nsorry, too many clients already' }), true);
  assert.equal(bootFailureIsInfrastructure(null), false);
});

test('an ordinary boot failure is untouched', () => {
  const err = {
    healthcheckFailed: true,
    containerStatus: 'exited',
    containerLogs: 'error: relation "posts" does not exist',
  };
  assert.equal(bootFailureIsInfrastructure(err), false);
  // Byte-compatible with the pre-#1771 shape: [status] + most specific line.
  assert.equal(summarizeBootFailure(err), '[exited] error: relation "posts" does not exist');
});

test('classify carries the marker without changing the persisted record', () => {
  const { classify } = require('../src/services/deploy-failure');
  const err = {
    healthcheckFailed: true,
    containerLogs: 'FATAL: sorry, too many clients already',
  };
  const out = classify(err);
  assert.equal(out.stage, 'healthcheck', 'still a healthcheck failure — that is what happened');
  assert.equal(out.infrastructure, true);
  assert.match(out.reason, /Infrastructure problem/);
  // apps.last_failure destructures { stage, reason, log }: the marker is for
  // the live decision, not for the row.
  const { record } = require('../src/services/deploy-failure');
  assert.deepEqual(Object.keys(record(err)).sort(), ['at', 'log', 'reason', 'sha', 'stage']);
});

// ── The author ───────────────────────────────────────────────────────────

test('an infrastructure boot failure blocks the merge but does not nudge the author', () => {
  // The prepare reports the failure with the marker; the preview machine's
  // prepareFailed domain write records it. #6149 made a policy refusal during a
  // release a platform fault too, so it keeps the retries and the quiet card.
  const services = stripComments(read('src/workflow/preview/services.ts'));
  assert.match(services, /const infrastructure = rollout \|\| !!legacy\('services\/deploy-failure'\)\.bootFailureIsInfrastructure\(err\);/);
  const src = stripComments(read('src/workflow/preview/machine.ts'));
  const fn = src.slice(src.indexOf('async prepareFailed('));
  const body = fn.slice(0, fn.indexOf('\n  },\n') + 5);
  // Still recorded as 'error' with the detail: the proposal stays blocked
  // and the card still says why. Only the nudge is skipped. #6536 gave that
  // verdict the build's own first error as a result row when there is one; an
  // infrastructure failure printed no build error, so it still stores none.
  assert.match(body, /state: 'error', results/);
  assert.match(body, /const buildError = w\.buildError && w\.buildError\.excerpt \? w\.buildError : null;/,
    'only a build error of its own becomes a row');
  const guard = body.indexOf('if (!stored || w.infrastructure) return;');
  assert.ok(guard > 0, 'the early return must exist');
  assert.ok(guard > body.indexOf('store.storeChecks('), 'the verdict is written first');
  assert.ok(guard < body.indexOf('check_error_notified_at = NOW()'),
    'nothing is stamped, so a later failure that is the author\'s still tells them once');
  assert.ok(guard < body.indexOf('createCheckFailedNotification'),
    'and the return lands before the notification the author cannot act on');
  assert.ok(guard < body.indexOf('Staging preview failed to start, so automated checks'),
    'and before the thread post');
});

// ── What the author actually reads ───────────────────────────────────────
//
// The sentence is only worth writing if it reaches a screen. It did not:
// the 'error' verdict card rendered a fixed pair of lines and never looked
// at check_error_detail, so every one of these runs read as "the staging
// build or the test run itself broke" — which is the accusation this issue
// is about, in the one place the author is guaranteed to see.

const vm = require('node:vm');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
      hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext([
    read('public/js/merge-status.js'),
    read('public/js/session-transcript.js'),
    read('public/js/app-view.js'),
    ';globalThis.__AppView = AppView;',
  ].join('\n'), sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}

const cardLines = (pr) => {
  const notes = makeAppView()._checksStatusNotes({ status: 'promoted', ...pr });
  assert.equal(notes.length, 1, 'the error verdict is one note box');
  assert.equal(notes[0].key, 'checks');
  assert.equal(notes[0].tone, 'error');
  return notes[0].rows.map((r) => r.parts.join(''));
};

test('the checks card leads with the recorded reason when there is one', () => {
  const detail = connectionExhaustionMessage(SATURATED, { where: 'ran its checks' });
  const lines = cardLines({ check_state: 'error', check_error_detail: detail });
  assert.equal(lines[0], detail, 'the attribution is the first thing read, not a footnote');
  // The generic sentence would flatly contradict it, so it is gone.
  assert.ok(!lines.some((l) => l.includes('the test run itself broke')));
  // What stays true either way: the merge is blocked, and a push re-runs it.
  assert.match(lines.join(' '), /Merge is blocked until checks pass/);
});

test('an error with nothing recorded still explains itself', () => {
  const lines = cardLines({ check_state: 'error' });
  assert.match(lines[0], /The staging build or the test run itself broke/);
  assert.match(lines.join(' '), /Merge is blocked until checks pass/);
  // An empty string is the same as nothing — a blank leading line would be
  // worse than the generic sentence.
  assert.match(cardLines({ check_state: 'error', check_error_detail: '' })[0],
    /The staging build or the test run itself broke/);
});

test('a long reason is capped rather than filling the card', () => {
  const lines = cardLines({ check_state: 'error', check_error_detail: 'x'.repeat(4000) });
  assert.equal(lines[0].length, 280, 'same cap the skipped verdict uses');
});

test('the demo fixture shows the real sentence, from the function that writes it', () => {
  const src = read('src/routes/votes.js');
  assert.match(src, /connectionExhaustionMessage\(\s*\{ max: 100, used: 98 \}/,
    'a hand-copied string in the fixture would drift from the copy in production');
  const decl = src.indexOf("mk(9000045");
  assert.ok(decl > 0, 'the fixture proposal must exist for the dapp.json check to reach it');
  const row = src.slice(decl, decl + 700);
  assert.match(row, /check_state: 'error'/);

  // And the browser check points at that row.
  const declared = JSON.parse(read('dapp.json')).tests
    .filter((t) => t.path.includes('9000045'));
  assert.equal(declared.length, 1);
  assert.equal(declared[0].expectText, 'Infrastructure problem, not this change');
  assert.match(declared[0].expectSelector, /data-note="checks"/);
});
