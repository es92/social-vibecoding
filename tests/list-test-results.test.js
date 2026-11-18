// The Workshop's lists carry each proposal's FAILING checks and count the
// passing ones (src/services/list-test-results.js).
//
// Measured on production, a row per declared check made GET /promoted 1.9 MB
// for 8 open proposals and /merged 5.1 MB for its first 20 — 97% passing rows
// that no card reads. Pinned here:
//   - the helper keeps every non-passing row (the aggregate "N checks did not
//     finish" row included) and counts the rest;
//   - it is opt-in: without `?results=failing` every route answers exactly as
//     before, so the CLI, the connector and agents are untouched;
//   - the shell asks for it everywhere it reads these lists, by one spelling;
//   - the checks verdict renders the same count and summary from a list row as
//     from the item's full row, and never counts a pass twice once the full
//     row is merged over the list row.
//
// Run with: node --test tests/list-test-results.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { failingResultsOnly, forListing, wantsFailingResults } = require('../src/services/list-test-results');
const listResults = require('../src/services/list-test-results');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const pass = (i) => ({ index: i, name: `check ${i}`, path: `/#r${i}`, status: 'pass', flakeRate: null });
const RESULTS = [
  ...Array.from({ length: 40 }, (_, i) => pass(i)),
  { index: 40, name: 'Feed renders', path: '/feed', status: 'fail', failureReason: 'timed out' },
  { index: -1, name: '3 checks did not finish in the run budget', path: '', status: 'fail', advisory: true, count: 3 },
];
const ROW = { id: 7, check_state: 'failing', test_results: RESULTS };

test('the list form keeps what did not pass and counts what did', () => {
  const out = failingResultsOnly(ROW);
  assert.equal(out.test_results.length, 2);
  assert.deepEqual(out.test_results.map((r) => r.status), ['fail', 'fail']);
  assert.equal(out.test_results[1].count, 3, 'the aggregate row keeps its weight');
  assert.equal(out.test_results_omitted, 40);
  assert.equal(ROW.test_results.length, 42, 'a copy: the stored row is never mutated');
  // Nothing to drop, nothing changes — no stray zero on rows with no passes.
  const none = { id: 8, test_results: [RESULTS[40]] };
  assert.equal(failingResultsOnly(none), none);
  assert.equal(failingResultsOnly({ id: 9 }).test_results_omitted, undefined);
  assert.equal(failingResultsOnly(null), null);
});

test('it is opt-in by ?results=failing and nothing else', () => {
  assert.equal(wantsFailingResults({ query: { results: 'failing' } }), true);
  assert.equal(wantsFailingResults({ query: {} }), false);
  assert.equal(wantsFailingResults({ query: { results: 'all' } }), false);
  const rows = [ROW];
  assert.equal(forListing({ query: {} }, rows), rows, 'without the flag the rows are answered as they are');
  assert.equal(forListing({ query: { results: 'failing' } }, rows)[0].test_results.length, 2);
});

test('every Workshop list route passes its rows through it', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /promoted: listTestResults\.forListing\(req, rows, \{ slim: true \}\)/);
  assert.match(votes, /merged: listTestResults\.forListing\(req, rows, \{ slim: true \}\)/);
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /sessions: listTestResults\.forListing\(req, sessions\),\s*totals, externalTasks/,
    '/api/me/active-sessions: the imported rows kept their raw results by contract');
  assert.match(sessions, /res\.json\(\{ sessions: listTestResults\.forListing\(req, sessions\) \}\)/,
    '/shared-sessions');
  // The Workshop reads its own sessions only for the archived ones.
  assert.match(sessions, /AND \(\$3::text IS NULL OR status = \$3\)/);
  assert.match(sessions, /req\.query\.status === 'archived' \? 'archived' : null/);
});

test('the shell asks for the list form, by one spelling', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /_withDemo\(query\) \{\s*return `\?\$\{query\}\$\{AppView\._demoQS\(\) \? '&demo=1' : ''\}`;/);
  assert.match(view, /want\('promoted'\) \? fetch\(`\/api\/apps\/\$\{slug\}\/promoted\$\{AppView\._withDemo\('results=failing'\)\}`\)/);
  assert.match(view, /fetch\(`\/api\/apps\/\$\{slug\}\/promoted\?results=failing`\),\s*fetch\(`\/api\/apps\/\$\{slug\}\/merged\?results=failing`\)/,
    'the chat tab\'s vote state');
  assert.match(view, /const params = \['results=failing'\];/, 'every page of /merged');
  assert.match(view, /const activeQs = AppView\._withDemo\('results=failing&include_imported=1'\);/);
  assert.match(view, /shared-sessions\$\{AppView\._withDemo\('results=failing'\)\}/);
  assert.match(view, /sessions\$\{AppView\._withDemo\('status=archived'\)\}/);
  assert.match(read('public/js/group-chat.js'), /\/promoted\?results=failing/);
  assert.match(read('frontend/src/features/dev-board/card/ref-typeahead.tsx'), /\/promoted\?results=failing/);
});

function loadAppView() {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

test('the verdict reads the same from a list row as from the full row', () => {
  const AppView = loadAppView();
  const full = AppView._checksVerdictView(ROW);
  const list = AppView._checksVerdictView(failingResultsOnly(ROW));
  assert.equal(list.summary, full.summary);
  assert.equal(list.heading, full.heading);
  assert.equal(list.passCount, full.passCount);
  assert.equal(full.passCount, 40);
  assert.equal(list.foldPasses, full.foldPasses);
  assert.deepEqual(list.failures.map((r) => r.name), full.failures.map((r) => r.name));
  assert.equal(list.passes.length, 0, 'the names arrive with the item\'s own row');
  assert.equal(full.passes.length, 40);
});

test('a passing proposal still has a verdict from its list row', () => {
  const AppView = loadAppView();
  const green = { id: 3, check_state: 'passing', test_results: RESULTS.slice(0, 40) };
  const list = AppView._checksVerdictView(failingResultsOnly(green));
  assert.ok(list, 'not the null a row with no results gets');
  assert.equal(list.summary, AppView._checksVerdictView(green).summary);
});

test('the full row merged over a list row is not counted twice', () => {
  const AppView = loadAppView();
  // topic-head merges the item's own read OVER the cached list row, so the
  // list row's count survives beside the full list.
  const merged = { ...failingResultsOnly(ROW), ...ROW };
  assert.equal(merged.test_results_omitted, 40);
  const v = AppView._checksVerdictView(merged);
  assert.equal(v.passCount, 40);
  assert.equal(v.summary, AppView._checksVerdictView(ROW).summary);
});

test('#3978: a list row drops the excerpts, the item row keeps them', () => {
  // An excerpt is read where the change is being judged — the item page and
  // the connector — never on a board card. The strip below is shallow and
  // per-row: the stored row keeps its excerpts untouched.
  const unitRow = {
    index: -3, name: 'Repo unit suite (npm test) passes', path: 'package.json', status: 'fail',
    failureReason: 'tests/a.test.js (1): t1 | # fail 1',
    failureDetails: [{ file: 'tests/a.test.js', test: 't1', excerpt: "error: 'boom'" }],
    failureDetailsTruncated: false,
  };
  const row = { id: 11, check_state: 'failing', test_results: [...RESULTS, unitRow] };
  const listed = forListing({ query: { results: 'failing' } }, [row])[0].test_results
    .find((r) => r.index === -3);
  assert.equal(listed.failureDetails, undefined, 'the list projection drops the excerpts');
  assert.equal(listed.failureDetailsTruncated, undefined);
  assert.match(listed.failureReason, /tests\/a\.test\.js \(1\): t1/, 'the grouped reason survives');
  assert.deepEqual(row.test_results[row.test_results.length - 1].failureDetails,
    [{ file: 'tests/a.test.js', test: 't1', excerpt: "error: 'boom'" }],
    'the stored row is untouched');
  // forItem reads through failingResultsOnly, which deliberately keeps them:
  // the item page's verdict fold renders them.
  const item = failingResultsOnly(row).test_results.find((r) => r.index === -3);
  assert.equal(item.failureDetails.length, 1);
});

// ── #6793: the list form is made in the database ───────────────────────

const LISTING = { query: { results: 'failing' } };
const UNIT_PASS = { index: -3, name: 'Repo unit suite (npm test) passes', path: 'package.json', status: 'pass' };

test('#6793: a list selects the list form only when asked; everyone else reads the stored column', () => {
  assert.equal(listResults.resultsSelect({ query: {} }, 'cs'), 'cs.test_results');
  const sql = listResults.resultsSelect(LISTING, 'cs');
  assert.match(sql, /AS test_results_listed/);
  assert.match(sql, /jsonb_array_elements\(cs\.test_results\) WITH ORDINALITY/, 'one pass, in the stored order');
  assert.match(sql, /- 'failureDetails' - 'failureDetailsTruncated'/, 'a list row carries no excerpts');
  assert.match(sql, /ELSE cs\.test_results END AS test_results$/, 'a column that is not an array reads as it did');
});

test('#6793: the routes ask Postgres for the list form and unpack it', () => {
  const votes = read('src/routes/votes.js');
  const has = (text, why) => assert.ok(votes.includes(text), why || text);
  has("cs.check_state, ${listTestResults.resultsSelect(req, 'cs')}, cs.checks_checked_at", '/promoted');
  has("mergedRowSelect({ results: listTestResults.resultsSelect(req, 'cs') })", '/merged');
  has('listTestResults.unpackListed(rows);');
  has('listTestResults.unpackListed(prRows);');
  assert.ok(votes.includes('`${mergedRowSelect()}'), 'one proposal\'s own read keeps the stored column');
  has('...listTestResults.listedRowForServer(row),', 'the merge requirements still see the unit suite');
  const sessions = read('src/routes/sessions.js');
  assert.equal((sessions.match(/results: listTestResults\.resultsSelect\(req, 'cs'\)/g) || []).length, 2,
    'active sessions and shared sessions: the imported rows are trimmed in the database too');
});

test('#6793: unpacking gives the fields the JavaScript filter gave', () => {
  const stored = [pass(0), pass(1), { name: 'Feed renders', status: 'fail' },
    { ...pass(2), passedOnRetry: true }];
  const want = forListing(LISTING, [{ id: 1, test_results: stored }])[0];
  const [row] = listResults.unpackListed([{ id: 1, test_results: null, test_results_listed: {
    kept: [{ name: 'Feed renders', status: 'fail' }], omitted: 3, noted: [{ ...pass(2), passedOnRetry: true }], unit: null,
  } }]);
  assert.deepEqual(row, want);
  const [none] = listResults.unpackListed([{ id: 2, test_results: null, test_results_listed: { kept: [], omitted: 0, noted: null, unit: null } }]);
  assert.deepEqual(none, { id: 2, test_results: [] }, 'nothing passed: no count, as before');
  const odd = { id: 3, test_results: { odd: true }, test_results_listed: null };
  assert.deepEqual(listResults.unpackListed([odd])[0], { id: 3, test_results: { odd: true } });
  const untouched = { id: 4, test_results: stored };
  assert.equal(listResults.unpackListed([untouched])[0].test_results, stored, 'a row read without the fragment is left alone');
});

test('#6793: a passing unit suite still counts for the merge requirements, and is never sent', () => {
  const { passedIn } = require('../src/services/unit-suite');
  const [row] = listResults.unpackListed([{ id: 1, check_state: 'passing', test_results: null,
    test_results_listed: { kept: [], omitted: 800, noted: null, unit: UNIT_PASS } }]);
  assert.equal(passedIn(row.test_results), false, 'the list form leaves the passing row out');
  assert.equal(passedIn(listResults.listedRowForServer(row).test_results), true, 'the server reads it back');
  const sent = forListing(LISTING, [row], { slim: true })[0];
  assert.equal('test_results_unit_row' in sent, false);
  assert.deepEqual(sent.test_results, []);
  assert.equal(sent.test_results_omitted, 800);
  const failed = { id: 2, test_results: [{ ...UNIT_PASS, status: 'fail' }], test_results_unit_row: { ...UNIT_PASS, status: 'fail' } };
  assert.equal(listResults.listedRowForServer(failed), failed, 'a failing suite is already in the kept rows');
});

test('#6793: a slim list row keeps the one shots fact a card reads and drops the merge record', () => {
  const row = { id: 1, pr_body: 'kept: search and the description panel read it',
    shots_detail: { headSha: 'abc', intent: { version: 1, impact: 'none', rationale: 'long', stories: [1, 2] }, shotResults: [1] },
    integration_merged_tree: 'tree', merge_requirements: { steps: [1] }, mergeRequirements: { steps: [2] },
    integration: { state: 'clean' }, test_results: [] };
  const [sent] = forListing(LISTING, [row], { slim: true });
  assert.deepEqual(sent.shots_detail, { intent: { impact: 'none' } });
  assert.equal('integration_merged_tree' in sent, false);
  assert.equal('merge_requirements' in sent, false);
  assert.deepEqual(sent.mergeRequirements, { steps: [2] }, 'what the card draws from is derived before, and stays');
  assert.deepEqual(sent.integration, { state: 'clean' });
  assert.equal(sent.pr_body, row.pr_body);
  assert.equal(forListing(LISTING, [{ id: 2, shots_detail: { intent: {} } }], { slim: true })[0].shots_detail, null);
  assert.equal(forListing({ query: {} }, [row], { slim: true })[0], row, 'without the flag nothing is trimmed');
  assert.equal(forListing(LISTING, [row])[0].shots_detail, row.shots_detail, 'only the board\'s own lists are slimmed');
});
