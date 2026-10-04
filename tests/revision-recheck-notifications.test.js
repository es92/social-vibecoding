'use strict';

// #1688: the "Still good?" ask, and the two new notification kinds end to end.
//
//   1. the producer (services/notifications.js createRevisionRecheckNotifications):
//      one row per prior Yes voter per version of the proposal, the author
//      never asked to re-confirm their own push, a muted voter left alone;
//   2. serialize: a vote row carries the voter's line, read live off their
//      vote; no other kind does;
//   3. the bell's rows (features/notifications/notifications.js _rowView):
//      "Still good?" with its own "Still yes" button until read, the Friday
//      row, the vote row quoting the line, the merge row naming the people;
//   4. the row's button re-casts the Yes through AppView.castVote with no
//      line of its own — the server carries the earlier one — and marks the
//      row read;
//   5. the phone's banner for each (services/mobile-push-policy.js).
//
// Run with: node --test tests/revision-recheck-notifications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const filtered = [];
stubModule('../src/services/notification-preferences', {
  filterUsersByCategory: async (_pool, args) => {
    filtered.push(args);
    return args.userIds.filter((id) => id !== 10); // 10 muted the category
  },
  allowsKind: async () => true,
});

const notifications = require('../src/services/notifications');

function makePool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/INSERT INTO notifications/.test(s)) {
        return {
          rows: params.slice(4).map((userId, i) => ({
            id: 500 + i, user_id: userId, app_id: params[0], session_id: params[1],
            source_user_id: params[2], kind: 'revision_recheck', detail: params[3],
          })),
        };
      }
      return { rows: [] };
    },
  };
}

// ── 1. The producer ───────────────────────────────────────────────────

test('one ask per prior Yes voter per version; the author is never asked, a muted voter is left alone', async () => {
  filtered.length = 0;
  const pool = makePool();
  const rows = await notifications.createRevisionRecheckNotifications(pool, {
    appId: 5, sessionId: 41, authorId: 7, voterIds: [8, 7, 10, '8', 12], epoch: 5,
  });
  assert.deepEqual(filtered, [{ userIds: [8, 10, 12], appId: 5, categoryKey: 'revision_recheck' }],
    'de-duplicated, the author dropped, then the category filter');
  assert.equal(pool.queries.length, 1);
  const [insert] = pool.queries;
  assert.deepEqual(insert.params, [5, 41, 7, 'epoch:5', 8, 12], 'the epoch is the detail: a second push asks again');
  assert.match(insert.sql, /\(\$5, \$1, \$2, \$3, 'revision_recheck', \$4\), \(\$6, \$1, \$2, \$3, 'revision_recheck', \$4\)/);
  assert.match(insert.sql, /WHERE NOT EXISTS \([\s\S]*n\.kind = 'revision_recheck' AND n\.detail = v\.detail/,
    'and a resumed tail does not ask twice for the same version');
  assert.deepEqual(rows.map((r) => r.user_id), [8, 12]);
});

test('nobody to ask: no filter, no query', async () => {
  filtered.length = 0;
  const pool = makePool();
  assert.deepEqual(await notifications.createRevisionRecheckNotifications(pool, { appId: 5, sessionId: 41, authorId: 7, voterIds: [], epoch: 1 }), []);
  assert.deepEqual(await notifications.createRevisionRecheckNotifications(pool, { appId: 5, sessionId: 41, authorId: 7, voterIds: [7], epoch: 1 }), []);
  assert.deepEqual(await notifications.createRevisionRecheckNotifications(pool, { appId: 5, sessionId: null, authorId: 7, voterIds: [8], epoch: 1 }), []);
  assert.equal(filtered.length, 0);
  assert.equal(pool.queries.length, 0);
  // Everybody muted: filtered, then nothing written.
  assert.deepEqual(await notifications.createRevisionRecheckNotifications(pool, { appId: 5, sessionId: 41, authorId: 7, voterIds: [10], epoch: 1 }), []);
  assert.equal(pool.queries.length, 0);
});

// ── 2. The serialized row ─────────────────────────────────────────────

test('serialize: only the vote row carries the voter\'s line, read off their vote', () => {
  const base = {
    id: 1, kind: 'proposal_vote', read_at: null, created_at: '2026-09-18T12:00:00.000Z', app_id: 5,
    app_slug: 'notes', app_name: 'Notes', session_id: 41, pr_title: 'Tighten the header', pr_number: 42,
    source_username: 'ada', detail: 'no', vote_reason: 'The new colors clash on mobile.',
  };
  assert.equal(notifications.serialize(base).voteReason, 'The new colors clash on mobile.');
  assert.equal(notifications.serialize({ ...base, vote_reason: null }).voteReason, null);
  assert.equal(notifications.serialize({ ...base, vote_reason: '' }).voteReason, null);
  const merged = notifications.serialize({ ...base, kind: 'pr_merged', detail: 'Backed by alice.', vote_reason: 'stray' });
  assert.equal(merged.voteReason, null, 'a join that happened to match is not a vote\'s line');
  assert.equal(merged.detail, 'Backed by alice.');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/notifications.js'), 'utf8');
  const joins = src.match(/LEFT JOIN pr_votes pv ON pv\.session_id = n\.session_id AND pv\.user_id = n\.source_user_id/g) || [];
  assert.equal(joins.length, 3, 'the list, the single fetch and the push hydration all read it live');
});

// ── 3. The bell's rows ────────────────────────────────────────────────

let N = null;
function controller() {
  if (N) return N;
  if (!globalThis.window) globalThis.window = globalThis;
  loadTsx('frontend/src/features/notifications/notifications.js');
  N = globalThis.window.Notifications;
  assert.equal(typeof N._rowView, 'function');
  return N;
}
const AT = new Date(Date.now() - 4 * 60 * 1000).toISOString();
const ROW = { id: 1, createdAt: AT, readAt: null, appName: 'Notes', appSlug: 'notes', sourceUsername: 'ada', sessionId: 41, prTitle: 'Tighten the header spacing', prNumber: 42 };
const subjectOf = (view) => view.segments.map((s) => (s.t === 'who' ? `@${s.v}` : s.v)).join(' ');

test('"Still good?" is its own row, with a "Still yes" button until it is read', () => {
  const view = controller()._rowView({ ...ROW, kind: 'revision_recheck' });
  assert.equal(view.label, 'Still good?');
  assert.equal(subjectOf(view), 'Tighten the header spacing');
  assert.equal(view.by, 'ada', 'the author who pushed');
  assert.equal(view.icon, '\u{1F501}');
  assert.deepEqual(view.actions, [{ key: 'still_yes', label: 'Still yes', primary: true }]);
  const read = controller()._rowView({ ...ROW, kind: 'revision_recheck', readAt: AT });
  assert.deepEqual(read.actions, [], 'once read — by the button or by opening it — the button goes');
  const unnamed = controller()._rowView({ ...ROW, kind: 'revision_recheck', prTitle: null, prNumber: null, sessionTitle: null });
  assert.equal(subjectOf(unnamed), 'a change you backed');
});

test('the Friday row counts the week; the vote row quotes the line; the merge row names the people', () => {
  const week = controller()._rowView({ ...ROW, kind: 'weekly_digest', detail: '3:2', sourceUsername: null });
  assert.equal(week.label, 'This week on Notes');
  assert.equal(subjectOf(week), '3 changes went live · 2 changes are waiting for approval');
  assert.equal(week.icon, '\u{1F4F0}');
  assert.equal(subjectOf(controller()._rowView({ ...ROW, kind: 'weekly_digest', detail: '1:1' })), '1 change went live · 1 change is waiting for approval');
  assert.equal(subjectOf(controller()._rowView({ ...ROW, kind: 'weekly_digest', detail: '0:0' })), 'Nothing landed this week');
  assert.equal(subjectOf(controller()._rowView({ ...ROW, kind: 'weekly_digest', detail: null })), 'Nothing landed this week');

  const no = controller()._rowView({ ...ROW, kind: 'proposal_vote', detail: 'no', voteReason: ' The new colors clash on mobile. ' });
  assert.equal(no.label, 'Voted no');
  assert.equal(subjectOf(no), 'Tighten the header spacing “The new colors clash on mobile.”');
  const yes = controller()._rowView({ ...ROW, kind: 'proposal_vote', detail: 'yes', voteReason: null });
  assert.equal(yes.label, 'Voted yes');
  assert.equal(subjectOf(yes), 'Tighten the header spacing', 'no line, no quote');

  const merged = controller()._rowView({ ...ROW, kind: 'pr_merged', detail: 'Backed by alice and bob, shaped by carol.' });
  assert.equal(merged.label, 'Live');
  assert.equal(subjectOf(merged), 'Tighten the header spacing Backed by alice and bob, shaped by carol.');
  const forced = controller()._rowView({ ...ROW, kind: 'pr_merged', detail: 'forced' });
  assert.equal(forced.label, 'Made live by an admin');
  assert.equal(subjectOf(forced), 'Tighten the header spacing', 'the override marker is not a sentence');
  assert.equal(subjectOf(controller()._rowView({ ...ROW, kind: 'pr_merged', detail: null })), 'Tighten the header spacing');

  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/notifications/notifications.js'), 'utf8');
  assert.match(src, /'pr_merged', 'proposal_vote', 'vote_digest', 'revision_recheck',/, 'a proposal kind: opens the proposal');
});

// ── 4. The button ─────────────────────────────────────────────────────

test('"Still yes" re-casts the Yes with no line of its own, and marks the row read', async () => {
  const Notifications = controller();
  const calls = [];
  const marked = [];
  let refreshed = 0;
  globalThis.window.AppView = { castVote: async (...args) => { calls.push(args); } };
  Notifications.items = [{ id: 1, kind: 'revision_recheck', sessionId: 41 }];
  Notifications._markOneRead = (id) => { marked.push(id); };
  Notifications.refresh = () => { refreshed += 1; };
  assert.equal(await Notifications._onRowAction(1, 'still_yes'), true);
  assert.deepEqual(calls, [[41, 'yes', null, { reason: null }]],
    'no epoch (the server names the current one) and null for the line: nothing is asked');
  assert.deepEqual(marked, [1]);
  assert.equal(refreshed, 1);
  assert.equal(await Notifications._onRowAction(99, 'still_yes'), false, 'an unknown row does nothing');
  assert.equal(calls.length, 1);

  const sheet = fs.readFileSync(path.join(__dirname, '../frontend/src/features/notifications/notifications-sheet.tsx'), 'utf8');
  assert.match(sheet, /data-notif-action=\{a\.key\}/, 'the screen draws a row\'s actions as real buttons');
  assert.match(sheet, /controller\(\)\?\._onRowAction\(view\.id, a\.key\)/);
  // #3538: both row shapes are built into `row` and returned inside the slot
  // that carries the clear, so the actions shape is a branch of a ternary
  // rather than an early return. Same <div> around the row's own button.
  assert.match(sheet, /const actions = view\.actions \|\| \[\];\s+const row = actions\.length \? \(\s+<div/,
    'beside the row, never a button inside a button');
});

// ── 5. The phone ──────────────────────────────────────────────────────

test('the banners: still good, this week, the quoted line, the named merge', () => {
  const { buildMessage } = require('../src/services/mobile-push-policy');
  const INPUT = {
    token: 'opaque-fcm-token', notificationId: 42, kind: 'session_done', environment: 'production',
    installationId: '123e4567-e89b-12d3-a456-426614174000', userId: 7, expiresAt: new Date(Date.now() + 60_000),
  };
  const CONTEXT = {
    appName: 'MyPage', conversationTitle: null, sourceUsername: 'alice', messageContent: null,
    sessionTitle: 'Fix login redirect loop', prTitle: null, branchName: null, detail: null,
  };
  const banner = (kind, context) => buildMessage({ ...INPUT, kind, context }).notification;

  assert.deepEqual(banner('revision_recheck', CONTEXT), {
    title: 'Still good? "Fix login redirect loop" was updated · MyPage',
    body: '@alice pushed an update after your feedback. One tap keeps your yes',
  });
  assert.deepEqual(banner('revision_recheck', {}), {
    title: 'Still good? A change you backed was updated',
    body: 'A new version was pushed after your feedback. One tap keeps your yes',
  });
  assert.deepEqual(banner('weekly_digest', { ...CONTEXT, detail: '3:1' }), {
    title: 'This week on MyPage',
    body: '3 changes went live. One change is waiting for approval',
  });
  assert.deepEqual(banner('weekly_digest', { ...CONTEXT, detail: '1:0' }), { title: 'This week on MyPage', body: '1 change went live.' });
  assert.deepEqual(banner('weekly_digest', { ...CONTEXT, detail: '0:2' }), { title: 'This week on MyPage', body: 'Nothing landed this week. 2 changes are waiting for approval' });
  assert.deepEqual(banner('weekly_digest', {}), { title: 'This week', body: 'Nothing landed this week.' });

  assert.deepEqual(banner('proposal_vote', { ...CONTEXT, detail: 'no', voteReason: 'The new colors clash on mobile.' }), {
    title: '@alice voted no on "Fix login redirect loop" · MyPage',
    body: '“The new colors clash on mobile.”',
  });
  assert.deepEqual(banner('proposal_vote', { ...CONTEXT, detail: 'yes' }), {
    title: '@alice voted yes on "Fix login redirect loop" · MyPage',
    body: 'Open the change to see their vote',
  });
  const long = banner('proposal_vote', { ...CONTEXT, detail: 'no', voteReason: 'x'.repeat(280) }).body;
  assert.ok(long.startsWith('“') && long.endsWith('”') && long.length <= 142, `a banner, not a paragraph: ${long.length}`);

  assert.deepEqual(banner('pr_merged', { ...CONTEXT, detail: 'Backed by alice and bob, shaped by carol.' }), {
    title: '"Fix login redirect loop" is live · MyPage',
    body: 'The vote carried. Backed by alice and bob, shaped by carol.',
  });
  assert.deepEqual(banner('pr_merged', { ...CONTEXT, detail: 'forced' }), {
    title: '"Fix login redirect loop" is live · MyPage',
    body: 'An admin made it live. Your change is live',
  });
  assert.deepEqual(banner('pr_merged', CONTEXT), {
    title: '"Fix login redirect loop" is live · MyPage',
    body: 'The vote carried. Your change is live',
  });
  // #2897: the platform's own merge is released after it, so its banner
  // promises the change rather than claiming it is already running.
  assert.deepEqual(banner('pr_merged', { ...CONTEXT, appSelfHosted: true }), {
    title: '"Fix login redirect loop" was approved · MyPage',
    body: 'The vote carried. Your change will be live in a few minutes',
  });
  assert.deepEqual(banner('pr_merged', { ...CONTEXT, appSelfHosted: true, detail: 'forced' }), {
    title: '"Fix login redirect loop" was approved · MyPage',
    body: 'An admin approved it. Your change will be live in a few minutes',
  });
  assert.equal(
    banner('pr_merged', { ...CONTEXT, appSelfHosted: true, detail: 'Backed by alice and bob.' }).body,
    'The vote carried. Backed by alice and bob.',
    'the named merge makes no deploy claim either way',
  );
});
