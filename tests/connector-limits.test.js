// The connector's own caps — specifically, what they MEASURE.
//
// #1248 → #1250 → here. The policy this module now keeps is: NO CLOCKS,
// ONLY CONCURRENCY. Nothing in it counts how many things a user started in
// the last hour or the last day; every bound asks how much they are doing
// right now, and each one is either the platform's own per-user cap or
// looser than it.
//
// The reason is that a window measures the wrong thing in both directions —
// it refuses work on a day whose earlier work has all merged, and it permits
// a pile of simultaneous unreviewed work — and, worse here, it has no
// counterpart in normal in-platform building, so it makes the connector
// strictly MORE limited than the same person clicking the same button in the
// browser. These tests pin those semantics rather than the numbers.
//
// Run with: node --test tests/connector-limits.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = require('../src/services/connector-limits');
const { effectiveSessionCaps } = require('../src/services/session-caps');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/services/connector-limits.js'), 'utf8'
);

// A pool that answers every count with the same number and records the SQL it
// was asked, so a test can assert on what the cap actually queries.
function poolCounting(n) {
  const asked = [];
  return {
    asked,
    query: async (sql, params) => {
      asked.push({ sql, params });
      return { rows: [{ cnt: String(n) }] };
    },
  };
}

const admin = { id: 7, canAdminWrite: true };
const ordinary = { id: 7, canAdminWrite: false };

test('the connector keeps no clocks', () => {
  // The single strongest guard in this file. A rate window anywhere in this
  // module is a limit normal platform building does not have, so the whole
  // category is banned rather than any particular one of them.
  assert.doesNotMatch(
    SRC, /INTERVAL/,
    'no rolling window may return to this module — bound what is open, never what was started'
  );
  assert.doesNotMatch(SRC, /forksPerHour|fallbackPerDay|proposalsPerDay/);
});

test('one literal survives, and it is a concurrency bound', () => {
  assert.deepEqual(Object.keys(limits.LIMITS), ['openTasks']);
  assert.ok(limits.LIMITS.openTasks > 0);
});

// ── Work orders held open at once ──────────────────────────────────────

test('starting work counts what is open, not what was recently started', async () => {
  const pool = poolCounting(0);
  await limits.checkOpenWorkOrders(pool, 7);
  const { sql, params } = pool.asked[0];
  assert.deepEqual(params, [7], 'scoped to the one user');
  assert.match(sql, /status = 'open'/, 'counts reservations still held');
  assert.match(
    sql, /expires_at > NOW\(\)/,
    'a work order somebody walked away from stops counting on its own'
  );
  // The denominator has to be the list the user can SEE. A shared session
  // (#1347) keeps its work order open on purpose, and the Improve panel
  // excludes those rows because the share already shows on the Dev board as
  // a session card — so counting them here charged a second, invisible
  // budget. The symptom was a user at this cap being told to "submit one"
  // while the panel listed nothing at all to submit.
  assert.match(
    sql, /session_id IS NULL/,
    'the same clause listOpenWorkOrders selects on, so the count matches the list'
  );
  assert.equal(pool.asked.length, 1, 'and that is the only bound on starting work');
});

test('a full set of work orders is refused, and the refusal is actionable', async () => {
  const result = await limits.checkOpenWorkOrders(poolCounting(limits.LIMITS.openTasks), 7);
  assert.equal(result.code, 'at_capacity');
  assert.match(result.message, /not yet submitted/);
  assert.match(result.message, /Submit one/, 'names something the user can do right now');
  // The old wording sent an agent away for a fixed period with nothing to do.
  assert.doesNotMatch(result.message, /in the last hour|24 hours|daily limit/);
});

test('one slot short of the cap still goes through', async () => {
  const result = await limits.checkOpenWorkOrders(
    poolCounting(limits.LIMITS.openTasks - 1), 7
  );
  assert.equal(result, null);
});

// ── The vote queue ─────────────────────────────────────────────────────

test('submitting is bounded by the platform proposal cap and nothing else', async () => {
  // The connector-only proposal cap counted a strict subset of this same
  // queue against a hard 5: it could never fire first for an ordinary user,
  // and it cut a full admin off below the browser's own ceiling.
  assert.equal(limits.checkOpenProposals, undefined, 'the second, connector-only cap is gone');

  const pool = poolCounting(0);
  await limits.checkPromotedCap(pool, {}, ordinary);
  assert.equal(pool.asked.length, 1, 'one query, one bound');
  assert.match(pool.asked[0].sql, /status IN \('promoted', 'merging'\)/);
  assert.doesNotMatch(
    pool.asked[0].sql, /external_agent/,
    'connector proposals are ordinary proposals and share the ordinary queue'
  );
});

test('a full admin gets the raised proposal ceiling through the connector too', async () => {
  const caps = effectiveSessionCaps({}, admin);
  assert.ok(caps.promotedSessions > effectiveSessionCaps({}, ordinary).promotedSessions);

  const atOrdinaryCap = poolCounting(effectiveSessionCaps({}, ordinary).promotedSessions);
  assert.equal(
    await limits.checkPromotedCap(atOrdinaryCap, {}, admin), null,
    'the browser would allow this, so the connector must too'
  );

  const full = await limits.checkPromotedCap(poolCounting(caps.promotedSessions), {}, admin);
  assert.equal(full.code, 'at_capacity');
  assert.match(full.message, new RegExp(`${caps.promotedSessions} PRs up for vote`));
});

// ── The platform-build fallback ────────────────────────────────────────

test('the fallback counts builds running, against the platform session cap', async () => {
  const pool = poolCounting(0);
  await limits.checkFallbackStart(pool, {}, ordinary);
  assert.equal(pool.asked.length, 1, 'the per-day quota is gone; only in-flight is counted');
  assert.match(pool.asked[0].sql, /headless_status = 'generating'/);

  const caps = effectiveSessionCaps({}, ordinary);
  const refused = await limits.checkFallbackStart(poolCounting(caps.activeSessions), {}, ordinary);
  assert.equal(refused.code, 'at_capacity');
  assert.match(refused.message, new RegExp(`${caps.activeSessions} Homeroom builds running`));
  assert.doesNotMatch(refused.message, /24 hours|daily limit/);

  // Same tiering as a dev session in the browser.
  assert.equal(
    await limits.checkFallbackStart(poolCounting(caps.activeSessions), {}, admin), null
  );
});

test('the fallback ceiling comes from session-caps, not a literal', () => {
  const block = SRC.slice(SRC.indexOf('async function checkFallbackStart'));
  assert.match(block, /effectiveSessionCaps\(config, user\)/);
  assert.match(block, /caps\.activeSessions/);
});

// ── Posture ────────────────────────────────────────────────────────────

test('the browser walkthrough and the connector share ONE limiter', () => {
  // "Prepare a work order for Claude Code" in the dev chat runs through the
  // same prepareWork as the connector's prepare_work, and both inject THIS
  // module as `limits`. That shared seam is what makes "the connector is
  // never more limited than the browser" checkable rather than aspirational,
  // so a cap can never be reintroduced on one surface alone.
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const rel of ['src/routes/dev-flow.js', 'src/services/mcp-tools.js']) {
    const src = read(rel);
    assert.match(src, /require\('\.[./]*(?:\.\.\/)?services\/connector-limits'\)|require\('\.\/connector-limits'\)/,
      `${rel} resolves the caps from the shared module`);
    assert.match(src, /limits: connectorLimits/, `${rel} injects it rather than its own numbers`);
  }
});

test('a cap that cannot be measured refuses rather than waves through', async () => {
  // Same posture across the whole module: these bound writes to GitHub and
  // to the vote queue, so an unavailable database is a reason to stop.
  const down = { query: async () => { throw new Error('db down'); } };
  assert.equal((await limits.checkOpenWorkOrders(down, 7)).code, 'platform_unavailable');
  assert.equal((await limits.checkPromotedCap(down, {}, ordinary)).code, 'platform_unavailable');
  assert.equal((await limits.checkFallbackStart(down, {}, ordinary)).code, 'platform_unavailable');
});
