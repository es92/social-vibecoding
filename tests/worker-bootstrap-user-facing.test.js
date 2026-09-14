// What the user is told when the coding agent never starts.
//
// Before this change a failed clone reached the dev chat as the literal
// string "clone failed" — no subject, no verb, no statement about whether
// any code had been touched. Two users read it as a GitHub permissions
// problem and spent real budget re-running the turn against a path that
// holds no credentials to be wrong (the worker clones anonymously). A third
// signal was missing entirely: the Mayor never learned the dispatch had
// failed, because the throw escaped to the chat handler's generic catch, so
// it could not say anything useful either.
//
// Run with: node --test tests/worker-bootstrap-user-facing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { describeTurnError } = require('../src/routes/sessions.js');
const SOURCE = fs.readFileSync('src/routes/sessions.js', 'utf8');

// ── describeTurnError: the four bootstrap branches ──────────────────────

test('a clone failure says what happened, that nothing changed, and what git said', () => {
  const msg = describeTurnError(new Error(
    "clone failed: fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com"
  ));
  assert.match(msg, /cloning the repository/);
  assert.match(msg, /no code was changed/);
  // The detail the old message threw away.
  assert.match(msg, /Could not resolve host: github\.com/);
  // And the fact the platform already tried, so "just retry" is not the
  // advice — the retry already happened.
  assert.match(msg, /already retried/);
  assert.notEqual(msg, 'clone failed');
});

test('a checkout failure does not suggest retrying, because retrying will not help', () => {
  const msg = describeTurnError(new Error(
    "checkout failed: fatal: a branch named 'dev/x' already exists"
  ));
  assert.match(msg, /checking out/);
  assert.match(msg, /no code was changed/);
  assert.match(msg, /Retrying will not help/);
  assert.match(msg, /already exists/);
});

test('a warm-ready timeout is the one that IS worth trying again', () => {
  const msg = describeTurnError(new Error('warm-ready timeout for usernode-worker-42'));
  assert.match(msg, /timed out/);
  assert.match(msg, /Try again/);
  // The container name is host-side plumbing, not something to hand a user.
  assert.doesNotMatch(msg, /usernode-worker-42/);
});

test('a wrapper that died with no marker says where to look instead of guessing', () => {
  const msg = describeTurnError(new Error('warm wrapper exited before warm-ready (code=1)'));
  assert.match(msg, /before it was ready/);
  assert.match(msg, /no code was changed/);
  assert.match(msg, /platform log/);
});

test('a bootstrap failure with no detail after the prefix reads as a sentence', () => {
  // `clip` can legitimately produce nothing (a command that failed silently).
  const msg = describeTurnError(new Error('clone failed'));
  assert.match(msg, /cloning the repository/);
  assert.doesNotMatch(msg, /Git reported: *\./, 'no dangling empty detail clause');
  assert.doesNotMatch(msg, /: *$/);
});

test('non-bootstrap errors are untouched by the new branch', () => {
  const before = describeTurnError(new Error('Cannot bootstrap worker for a/b: repo is private. Homeroom requires public repositories.'));
  assert.doesNotMatch(before, /cloning the repository/);
  assert.doesNotMatch(describeTurnError(new Error('boom')), /coding agent failed while/);
});

test('the new copy carries no em dashes', () => {
  // Platform convention: an em dash in user-facing copy is the strongest
  // tell that a string was machine-written. Covers every encoding, because a
  // sweep for the raw character alone misses the entities.
  const messages = [
    'clone failed: fatal: nope',
    'checkout failed: fatal: nope',
    'warm-ready timeout for usernode-worker-1',
    'warm wrapper exited before warm-ready (code=1)',
  ].map((m) => describeTurnError(new Error(m)));
  for (const msg of messages) {
    assert.ok(!/[—]|&mdash;|&#8212;/.test(msg), `em dash in: ${msg}`);
  }
});

// ── Routing: the Mayor is told, not just the toast ──────────────────────

test('both dispatch paths catch ensureWorker and return a tool_result', () => {
  // The defect was structural: neither call site was inside a try, so the
  // throw escaped past the Mayor entirely to the chat handler's generic
  // catch. Two call sites, two catches, one shared helper.
  const guarded = SOURCE.match(/containerName = await worker\.ensureWorker\(/g) || [];
  assert.equal(guarded.length, 2, 'runScoutTool and runClaudeCodeTool');
  const routed = SOURCE.match(/return await workerBootstrapFailureResult\(err, \{/g) || [];
  assert.equal(routed.length, 2, 'each one routes its failure back to the Mayor');
  // And nothing kept the old unguarded const form.
  assert.doesNotMatch(SOURCE, /const containerName = runLocally \? null : await worker\.ensureWorker/);
});

test('the failure result is an is_error tool_result that states the branch is unchanged', () => {
  const helper = SOURCE.slice(SOURCE.indexOf('async function workerBootstrapFailureResult'));
  const body = helper.slice(0, helper.indexOf('\nasync function describeStagingFailure'));
  assert.match(body, /isError: true/);
  assert.match(body, /the branch is unchanged/);
  // Same teardown the other pre-dispatch bailouts do, in the same order —
  // these gates fire outside the big try's finally, so nothing else does it.
  const del = body.indexOf('activeWorkers.delete(session.id)');
  const clear = body.indexOf('workerProgress.clear(session.id)');
  const ret = body.indexOf('return {');
  assert.ok(del > 0 && clear > del && ret > clear, 'teardown before the return');
  // The user sees the same sentence the Mayor is handed, not a second
  // wording invented for the toast.
  assert.match(body, /const friendly = describeTurnError\(err\)/);
  assert.match(body, /send\('error', \{ error: friendly \}\)/);
  // The diagnostics the harvest collected reach the platform log here.
  assert.match(body, /bootstrapLog/);
  assert.match(body, /phase:/);
  assert.match(body, /attempts:/);
});

test('runLocally still bypasses the worker entirely', () => {
  // A local run has no container to bootstrap, so it must not enter the
  // guarded block at all — the catch would otherwise be dead code that a
  // future refactor mistakes for the only path.
  const guards = SOURCE.match(/let containerName = null;\n  if \(!runLocally\) \{/g) || [];
  assert.equal(guards.length, 2);
});

// ── the staging fixture renders the real strings, not paraphrases ───────

test('the staging failure cards carry exactly what describeTurnError produces', () => {
  // The fixture exists because a bootstrap failure cannot be triggered on
  // demand in staging: it needs a clone to fail inside a container. That
  // makes the seeded copy the only thing a reviewer ever reads, so it has
  // to be the same sentence the code emits — a hand-written paraphrase
  // would go stale the first time the wording changes and nobody would
  // notice, because the card it feeds is the review surface itself.
  const migrate = fs.readFileSync('src/db/migrate.js', 'utf8');
  const fixture = migrate.slice(
    migrate.indexOf('async function seedStagingBootstrapFailure'),
    migrate.indexOf("log.warn('db', 'Staging bootstrap-failure seeding failed'")
  );
  assert.ok(fixture.length > 0, 'fixture present');

  const clone = describeTurnError(new Error(
    "clone failed: fatal: unable to access 'https://github.com/Usernode-Labs/social-vibecoding.git/': Could not resolve host: github.com"
  ));
  const checkout = describeTurnError(new Error(
    "checkout failed: fatal: a branch named 'staging-demo/bootstrap-failure' already exists"
  ));
  // The seeded literals are split across concatenated lines and escape the
  // apostrophe in "session's"; compare on the JS string the fixture builds.
  // Adjacent literals are concatenated in source order, so joining them
  // with nothing reproduces each card's full sentence contiguously.
  const seeded = [...fixture.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
    .join('');
  assert.ok(seeded.includes(clone), 'the clone card is not the string the code emits');
  assert.ok(seeded.includes(checkout), 'the checkout card is not the string the code emits');
});

test('the fixture is a strict no-op outside staging and never fails boot', () => {
  const migrate = fs.readFileSync('src/db/migrate.js', 'utf8');
  const fixture = migrate.slice(
    migrate.indexOf('async function seedStagingBootstrapFailure'),
    migrate.indexOf("log.warn('db', 'Staging bootstrap-failure seeding failed'")
  );
  assert.match(fixture, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  // Idempotent: re-runs on every staging boot.
  assert.match(fixture, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(fixture, /metadata->'bootstrapFailure' IS NOT NULL/);
  // Seeded rows belong to the fixture session, never to whoever opened the
  // preview, and they are labelled as demo content.
  assert.match(fixture, /Staging demo:/);
  assert.match(fixture, /source: 'staging-seed'/);
});
