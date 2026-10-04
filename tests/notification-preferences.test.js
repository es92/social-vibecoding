// Per-app notification preferences (#1374).
//
// The request was "make notifications configurable per app". What it turned
// into, once the requester settled the open question, is a gate on whether a
// notification is CREATED — not on whether an existing one may reach a phone.
// That distinction is the whole design, so it is what this file pins:
//
//   1. ONE SWITCH, BOTH PLACES. mobile_push_deliveries references
//      notifications(id), so suppressing the row suppresses the push with it.
//      The property that makes that true is that every kind this layer gates
//      is also push-eligible — otherwise a category could be "on" here and
//      still never reach a phone, which is exactly the drift the requester
//      asked to avoid.
//   2. THREE LAYERS, IN ORDER. per-app row, then account-wide row, then the
//      category's own default. The middle one exists because a nullable
//      app_id gives it for free and "quiet everywhere except these two apps"
//      is otherwise a row per app the user will ever open.
//   3. FAILING OPEN. The quiet failure mode of this whole feature is a
//      notification silently not arriving. Every uncertain path sends.
//
// Run with: node --test tests/notification-preferences.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../src/services/notification-preferences');
const { ALLOWED_KINDS } = require('../src/services/mobile-push-preferences');
const voteDigest = require('../src/services/vote-digest');

// ── 1. One switch, both places ──────────────────────────────────────────

test('every gated kind is also push-eligible, or the two could disagree', () => {
  // THE invariant behind "always in sync". A kind gated here but missing
  // from the closed push policy would be a category a person can turn ON
  // that still never reaches their phone.
  const missing = [...prefs.GATED_KINDS].filter((kind) => !ALLOWED_KINDS.has(kind));
  assert.deepEqual(missing, []);
});

test('the nine app categories are the ones that were agreed', () => {
  // #1688 adds two: the re-confirm ask after a proposal you backed gets a
  // new version, and the weekly "this week on <app>" card. B7 adds the
  // first: a change you can approve is ready to try, on by default.
  assert.deepEqual([...prefs.APP_CATEGORY_KEYS], [
    'changes_ready', 'new_proposals', 'new_issues', 'proposal_status',
    'thread_replies', 'proposal_votes', 'revision_recheck', 'weekly_digest', 'app_health',
  ]);
});

test('a kind belongs to exactly one category', () => {
  // The module throws at load on a duplicate, so reaching here proves it;
  // this also pins that the map is not empty, which a broken build could
  // otherwise satisfy silently.
  assert.ok(prefs.GATED_KINDS.size >= 9);
  for (const kind of prefs.GATED_KINDS) {
    assert.equal(typeof prefs.categoryForKind(kind), 'string', kind);
  }
});

// ── 2. Three layers, in order ───────────────────────────────────────────

test('new proposals and new issues default OFF, everything else ON', () => {
  // The two the requester asked to be quiet by default. `new_proposals`
  // is the behaviour change: before this it fired at everyone with the app
  // in "Your apps" with no way to turn it off.
  assert.equal(prefs.isKindEnabled('pr_proposed', {}), false);
  assert.equal(prefs.isKindEnabled('issue_opened', {}), false);

  for (const kind of ['change_ready', 'check_failed', 'stale_pr', 'pr_merged', 'reply', 'proposal_vote', 'app_health']) {
    assert.equal(prefs.isKindEnabled(kind, {}), true, kind);
  }
});

test('the daily digest is ON by default, which is what makes muting safe', () => {
  // If this ever defaults off, muting new-proposal pings costs the group its
  // voting turnout with nothing replacing it.
  assert.equal(prefs.isKindEnabled('vote_digest', {}), true);
});

test('a per-app row beats an account row beats the default', () => {
  const account = { accountOverrides: { new_proposals: true } };
  assert.equal(prefs.isKindEnabled('pr_proposed', account), true, 'account layer overrides the default');

  const both = { appOverrides: { new_proposals: false }, accountOverrides: { new_proposals: true } };
  assert.equal(prefs.isKindEnabled('pr_proposed', both), false, 'the per-app row wins');

  const onlyApp = { appOverrides: { new_proposals: true } };
  assert.equal(prefs.isKindEnabled('pr_proposed', onlyApp), true);
});

test('an absent override is not the same as one set to the default', () => {
  // The distinction the dialog's "Follow my default" depends on: absence
  // INHERITS, so it keeps following if a default ever changes.
  const inherited = prefs.serializeAppCategories({ isAdmin: true });
  assert.equal(inherited.find((c) => c.key === 'new_proposals').source, 'default');

  const explicit = prefs.serializeAppCategories({
    appOverrides: { new_proposals: false }, isAdmin: true,
  });
  assert.equal(explicit.find((c) => c.key === 'new_proposals').source, 'app');
  assert.equal(explicit.find((c) => c.key === 'new_proposals').enabled, false);

  const fromAccount = prefs.serializeAppCategories({
    accountOverrides: { new_proposals: true }, isAdmin: true,
  });
  assert.equal(fromAccount.find((c) => c.key === 'new_proposals').source, 'account');
  assert.equal(fromAccount.find((c) => c.key === 'new_proposals').enabled, true);
});

// ── 3. Failing open ─────────────────────────────────────────────────────

test('a kind this layer knows nothing about is never suppressed', () => {
  // Mentions, invitations and conversation messages are account-level and
  // must keep working exactly as they did. Defaulting the unknown to "send"
  // is also what keeps a NEW kind working the day it is added rather than
  // silently vanishing until somebody remembers this file.
  for (const kind of ['mention', 'collab_invite', 'conversation_message', 'kudos', 'future_kind']) {
    assert.equal(prefs.isKindEnabled(kind, {}), true, kind);
    assert.equal(prefs.isKindEnabled(kind, { appOverrides: { anything: false } }), true, kind);
  }
});

test('a preference read that throws still sends the notification', async () => {
  const exploding = { query: async () => { throw new Error('database on fire'); } };
  assert.equal(
    await prefs.allowsKind(exploding, { userId: 1, appId: 2, kind: 'check_failed' }),
    true,
    'a broken preference read must not swallow "your checks failed"'
  );
});

test('an unknown category resolves to false rather than throwing', () => {
  assert.equal(prefs.resolveEnabled('not_a_category', {}), false);
});

// ── Admin-only categories ───────────────────────────────────────────────

test('app health is offered to admins and hidden from everybody else', () => {
  // Not a permission check: the notification itself only ever goes to the
  // creator and admins, so offering the switch to anyone else would be
  // offering to mute something they were never going to receive.
  const asAdmin = prefs.serializeAppCategories({ isAdmin: true }).map((c) => c.key);
  const asUser = prefs.serializeAppCategories({ isAdmin: false }).map((c) => c.key);
  assert.ok(asAdmin.includes('app_health'));
  assert.ok(!asUser.includes('app_health'));
  assert.equal(asUser.length, asAdmin.length - 1);
});

test('the account roll-up carries both layers and marks which are per-app', () => {
  const rows = prefs.serializeAccountCategories({ accountOverrides: { new_issues: true } });
  const digest = rows.find((row) => row.key === 'vote_digest');
  const issues = rows.find((row) => row.key === 'new_issues');
  assert.equal(digest.appScoped, false, 'the digest has no app dimension');
  assert.equal(issues.appScoped, true);
  assert.equal(issues.enabled, true);
  assert.equal(issues.source, 'account');
  // adminOnly rows stay out of the ACCOUNT list too: it is shown to
  // everybody, and whether you administer an app is per app.
  assert.ok(!rows.some((row) => row.key === 'app_health'));
});

// ── Validation and writes ───────────────────────────────────────────────

test('null is a valid value, because clearing an override is a real action', () => {
  const { details, values } = prefs.validatePreferencePatch({
    preferences: { new_proposals: null },
  });
  assert.deepEqual(details, {});
  assert.deepEqual(values, { new_proposals: null });
});

test('an unknown or non-boolean category is refused before any write', () => {
  for (const preferences of [
    { not_a_category: true },
    { new_proposals: 'yes' },
    { new_proposals: 1 },
  ]) {
    const { details } = prefs.validatePreferencePatch({ preferences });
    assert.ok(Object.keys(details).length, JSON.stringify(preferences));
  }
});

test('allowedKeys refuses a category this caller may not set', () => {
  // How the route stops a non-admin storing an app_health preference.
  const { details } = prefs.validatePreferencePatch(
    { preferences: { app_health: false } },
    { allowedKeys: ['new_proposals'] }
  );
  assert.ok(details.app_health);
});

test('writing clears the touched keys first, so null really removes the row', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [] };
    },
  };
  await prefs.writeOverrides(pool, 7, 42, { new_proposals: true, new_issues: null });

  const del = calls.find((c) => c.sql.startsWith('DELETE FROM notification_preferences'));
  assert.ok(del, 'both set and cleared keys are deleted first');
  assert.deepEqual(del.params[1].sort(), ['new_issues', 'new_proposals']);
  // NULL-safe equality, because app_id IS NULL is the account-wide layer and
  // `= NULL` would match nothing.
  assert.match(del.sql, /app_id IS NOT DISTINCT FROM \$3/);

  const insert = calls.find((c) => c.sql.startsWith('INSERT INTO notification_preferences'));
  assert.deepEqual(insert.params[2], ['new_proposals'], 'only the boolean is re-inserted');
});

test('the fan-out filter resolves many users in one query', async () => {
  // What makes gating pr_proposed affordable: that fan-out can be every
  // active user of a busy app, and a query each would turn one insert into
  // hundreds of round trips.
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push(params);
      return { rows: [
        { user_id: 2, app_id: 42, enabled: true },
        { user_id: 3, app_id: null, enabled: true },
        { user_id: 4, app_id: 42, enabled: false },
      ] };
    },
  };
  const allowed = await prefs.filterUsersByCategory(pool, {
    userIds: [1, 2, 3, 4], appId: 42, categoryKey: 'new_proposals',
  });
  assert.equal(calls.length, 1, 'one query for the whole fan-out');
  // 1 has no row and new_proposals defaults off; 2 is opted in per app; 3 is
  // opted in account-wide; 4 is explicitly off for this app.
  assert.deepEqual(allowed, [2, 3]);
});

test('the fan-out filter short-circuits with nobody to ask about', async () => {
  const pool = { query: async () => { throw new Error('should not be called'); } };
  assert.deepEqual(await prefs.filterUsersByCategory(pool, {
    userIds: [], appId: 1, categoryKey: 'new_proposals',
  }), []);
});

// ── The daily digest ────────────────────────────────────────────────────

test('the digest gap is under a day, so an hourly sweep cannot skip one', () => {
  // A strict 24 would drift each person's digest an hour later every day
  // until it lapped and missed a day entirely.
  assert.ok(voteDigest.MIN_GAP_HOURS < 24);
  assert.equal(voteDigest.INTERVAL_MS, 60 * 60 * 1000);
});

test('the digest counts only proposals the reader can actually act on', () => {
  const sql = voteDigest.PENDING_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /cs\.status = 'promoted'/, 'only open proposals');
  assert.match(sql, /s\.user_id IS DISTINCT FROM p\.author_id/, 'never your own');
  assert.match(sql, /FROM pr_votes v/, 'never one you already voted on');
  assert.match(sql, /kind = 'vote_digest'/, 'and not if you had one recently');
});

test('the digest is capped, because a huge number is not a to-do list', () => {
  assert.ok(voteDigest.MAX_COUNT > 0 && voteDigest.MAX_COUNT <= 99);
});
