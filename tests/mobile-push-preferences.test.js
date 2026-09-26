'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CATEGORY_DEFINITIONS,
  KIND_TO_CATEGORY,
  isKindEnabled,
  serializePreferences,
  validatePreferencePatch,
  readPreferences,
  writePreferences,
} = require('../src/services/mobile-push-preferences');
const notifications = require('../src/services/notifications');

const CURRENT_KINDS = [
  'conversation_invite', 'conversation_message', 'conversation_mention',
  'conversation_reply', 'conversation_reaction',
  // #2387: a reply in a conversation thread, beside the other Messages kinds.
  'conversation_thread_reply',
  'mention', 'reply', 'reaction', 'kudos', 'stale_pr', 'check_failed',
  'pr_proposed', 'spec_shared', 'collab_invite', 'collab_invite_accepted',
  'approver_invite', 'approver_invite_accepted', 'session_done',
  // #3181: a dev-session turn that stopped before finishing, beside the
  // one that finished, on the same developer_sessions switch.
  'session_stalled',
  'auto_solve_done',
  // #1405: a connector session put work somewhere, and a connector session is
  // holding for an answer. Both are "a coding session did something while you
  // were away", so both join developer_sessions rather than adding a category.
  'connector_submitted', 'agent_awaiting_input', 'test_alert',
  // #1374's five. Three are proposal lifecycle and join proposal_alerts; the
  // two app ones get the new app_alerts category. Note that being
  // push-eligible here is only the SECOND gate now —
  // services/notification-preferences.js decides whether the notification is
  // created at all, per user and per app, and two of these default off there.
  'proposal_vote', 'pr_merged', 'vote_digest', 'issue_opened', 'app_health',
  // #1688's two, both proposal lifecycle: the re-confirm ask after a
  // proposal you backed gets a new version, and the weekly card.
  'revision_recheck', 'weekly_digest',
  // #2387: a reply in an app-chat reply thread you started or joined. A
  // direct interaction, beside mention and reply.
  'thread_reply',
  // #2386's two: a friend request and its acceptance — one person reaching
  // you directly, so they join direct_interactions.
  'friend_request', 'friend_accept',
  // A server-wide cap nearing its ceiling, for full admins only. Joins
  // app_alerts beside app_health (services/platform-limit-alerts.js).
  'platform_limit',
];

test('every current inbox kind maps exactly once to one closed category', () => {
  const flattened = CATEGORY_DEFINITIONS.flatMap((category) => category.kinds);
  assert.deepEqual([...flattened].sort(), [...CURRENT_KINDS].sort());
  assert.equal(new Set(flattened).size, CURRENT_KINDS.length);
  for (const kind of CURRENT_KINDS) assert.equal(typeof KIND_TO_CATEGORY.get(kind), 'string');
  assert.equal(KIND_TO_CATEGORY.has('future_kind'), false);
  assert.equal(isKindEnabled('future_kind'), false);
});

test('category defaults match the product contract', () => {
  assert.deepEqual(
    Object.fromEntries(CATEGORY_DEFINITIONS.map((category) => (
      [category.key, category.defaultEnabled]
    ))),
    {
      messages: true,
      direct_interactions: true,
      invitations: true,
      shared_work: true,
      developer_sessions: true,
      proposal_alerts: true,
      app_alerts: true,
      lightweight_activity: false,
    }
  );
  assert.equal(isKindEnabled('mention'), true);
  assert.equal(isKindEnabled('reply'), true);
  assert.equal(isKindEnabled('reaction'), false);
  assert.equal(isKindEnabled('kudos'), false);
  for (const kind of CURRENT_KINDS.filter((value) => value.startsWith('conversation_'))) {
    assert.equal(isKindEnabled(kind), true, kind);
    assert.equal(isKindEnabled(kind, { messages: false }), false, kind);
  }
});

test('disabling blocks its kinds and re-enabling is prospective policy only', () => {
  assert.equal(isKindEnabled('mention', { direct_interactions: false }), false);
  assert.equal(isKindEnabled('reply', { direct_interactions: false }), false);
  assert.equal(isKindEnabled('mention', { direct_interactions: true }), true);

  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const trigger = schema.match(
    /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/
  )?.[0];
  assert.match(schema, /AFTER INSERT ON notifications/,
    'category state is evaluated only as a new inbox row is inserted');
  assert.doesNotMatch(trigger, /UPDATE notifications|SELECT[\s\S]*FROM notifications/,
    'the enqueue path never scans old inbox rows for backfill');
});

test('#2386: friend requests and acceptances ride the direct-interactions switch', () => {
  for (const kind of ['friend_request', 'friend_accept']) {
    assert.equal(KIND_TO_CATEGORY.get(kind), 'direct_interactions', kind);
    assert.equal(isKindEnabled(kind), true, `${kind} is on by default`);
    assert.equal(isKindEnabled(kind, { direct_interactions: false }), false, `${kind} follows the switch`);
    assert.equal(isKindEnabled(kind, { messages: false }), true, `${kind} is not a Messages kind`);
  }
});

test('#3181: a stalled session rides the developer-sessions switch, beside a finished one', () => {
  assert.equal(KIND_TO_CATEGORY.get('session_stalled'), 'developer_sessions');
  assert.equal(KIND_TO_CATEGORY.get('session_stalled'), KIND_TO_CATEGORY.get('session_done'));
  assert.equal(isKindEnabled('session_stalled'), true, 'on by default');
  assert.equal(isKindEnabled('session_stalled', { developer_sessions: false }), false,
    'turning session pushes off silences it too');
});

test('preference validation rejects malformed values and unknown categories', () => {
  assert.deepEqual(validatePreferencePatch({
    preferences: { direct_interactions: false, lightweight_activity: true },
  }), {
    details: {},
    values: { direct_interactions: false, lightweight_activity: true },
  });

  for (const body of [null, [], {}, { preferences: [] }, { preferences: {} }, {
    preferences: { direct_interactions: 'false' },
  }, {
    preferences: { future_category: true },
  }, {
    preferences: { direct_interactions: true }, extra: true,
  }]) {
    assert.notDeepEqual(validatePreferencePatch(body).details, {}, JSON.stringify(body));
  }
});

function preferencePool() {
  const accounts = new Map();
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).startsWith('INSERT INTO mobile_push_preferences')) {
        const account = accounts.get(String(params[0])) || {};
        params[1].forEach((key, index) => { account[key] = params[2][index]; });
        accounts.set(String(params[0]), account);
        return { rows: [] };
      }
      if (String(sql).includes('FROM mobile_push_preferences')) {
        const account = accounts.get(String(params[0])) || {};
        return {
          rows: Object.entries(account).map(([category, enabled]) => ({ category, enabled })),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('preferences are account-scoped and never mutate device registrations', async () => {
  const pool = preferencePool();
  await writePreferences(pool, 7, { direct_interactions: false });
  await writePreferences(pool, 8, { lightweight_activity: true });

  const first = await readPreferences(pool, 7);
  const second = await readPreferences(pool, 8);
  assert.equal(first.find((row) => row.key === 'direct_interactions').enabled, false);
  assert.equal(first.find((row) => row.key === 'lightweight_activity').enabled, false);
  assert.equal(second.find((row) => row.key === 'direct_interactions').enabled, true);
  assert.equal(second.find((row) => row.key === 'lightweight_activity').enabled, true);
  assert.ok(pool.calls.every((call) => !/mobile_push_registrations/.test(call.sql)),
    'account updates do not delete, recreate, or update phone registrations');

  const defaults = serializePreferences();
  // 7 → 8 with #1374's app_alerts. Every category must serialize, or one
  // silently loses its Settings row while still gating pushes.
  assert.equal(defaults.length, 8);
  assert.ok(defaults.every((row) => typeof row.enabled === 'boolean'));
});

test('one account preference applies across every independently eligible registration', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const trigger = schema.match(
    /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/
  )?.[0];
  assert.match(trigger, /preference\.user_id = NEW\.user_id/);
  assert.match(trigger, /r\.user_id = NEW\.user_id/);
  assert.match(trigger, /SELECT r\.id, r\.environment, r\.installation_id, r\.platform/);
  assert.match(trigger, /permission_status IN \('authorized', 'provisional'\)/,
    'the independent device master/permission switch remains required');
  assert.doesNotMatch(trigger, /LIMIT 1/,
    'all eligible registrations for the account receive the same category policy');
});

test('in-app inbox creation does not consult mobile-push preferences', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /^INSERT INTO notifications/);
      assert.doesNotMatch(sql, /mobile_push_preferences/);
      return { rows: [{
        id: 91, user_id: params[0], kind: 'reply', chat_message_id: params[2],
      }] };
    },
  };
  const rows = await notifications.createReplyNotification(pool, {
    appId: 4, replyMessageId: 12, senderId: 2, recipientId: 7,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'reply');
});
