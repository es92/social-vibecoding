'use strict';

// One notification of every kind, sent to one test account
// (send_test_notifications, routes/test-accounts.js), so a tester holding a
// phone or a simulator signed in as that account sees every row the bell can
// draw and every push it can ring, and can debug how each one looks.
//
// What it exercises, and what it does not. Each row is INSERTed straight
// into `notifications`, as every creator in services/notifications.js does,
// so from there on it takes the real path: the enqueue_mobile_push_deliveries
// trigger and its gates (the kind's push category, the account's
// preferences, a live registration), the push worker and buildCopy's words
// for the banner, the live `notification_new` frame (hydrateAndPush), and
// the bell's own renderer and tap routing. What it skips is each creator's
// own decision of WHO to tell and when (its dedupe, a self-action's no-op):
// that is not how a notification looks, and every creator is tested where it
// lives.
//
// What a row points at is real, because the list and the worker drop a row
// whose references they cannot see (CONVERSATION_ACCESS_SQL, the worker's
// invalidReason):
//   * the account's own newest project, for every kind about a project. A
//     kind that needs one is skipped, with the reason, when the account has
//     none (create_test_account everyTemplate makes some). The kinds about a
//     message in its discussion point at its newest one (a reaction at the
//     account's own newest), and go without a message when it has none: a
//     channel is what people said, and Homeroom writes nothing into it
//     (tests/channel-activity.test.js), so a tester posts one first to see
//     a message's words in those rows and their pushes;
//   * a group conversation of the account's own, "Notification test", made
//     once and reused, with two new messages in it each time: one from the
//     admin who asked and one of the account's own, for a reaction. The
//     Messages kinds point at it, and so do Homeroom bot's build moments
//     (which ride a conversation too).
// The admin who asked is who did each thing ("@evan mentioned you").
// Nothing names a change: no change exists to name, so a change's kinds say
// "your change" and open the project's board. Only a test account can be
// sent to: the rows are fake, and every kind is sent, the admin-only ones
// included (their tap opens an admin screen a test account cannot see).
//
// Every kind is one row in its own statement, so each has its own time and
// the list keeps their order. `kudos` is parked (services/kudos-parked.js):
// neither listed nor pushed, so it is skipped with that reason.

const crypto = require('crypto');
const log = require('./logger');
const { PARKED_NOTIFICATION_KINDS } = require('./kudos-parked');

const CONVERSATION_TITLE = 'Notification test';
const PUSH_CATEGORIES = Object.freeze([
  'direct_interactions', 'invitations', 'shared_work', 'developer_sessions', 'proposal_alerts',
  'lightweight_activity', 'messages', 'app_alerts', 'builds', 'invite_activity',
]);

// Every kind, in the order they are sent, with what its row needs:
//   app       the account's project            chat   'any' | 'own' newest message in its discussion
//   actor     the admin who asked, as who did it conversation  the test conversation
//   bot       Homeroom bot as who did it        message 'actor' | 'own' message in the conversation
//   detail    the row's detail, in the form its creator writes
const KINDS = Object.freeze([
  // Someone talking to you, in a project's discussion.
  { kind: 'mention', app: true, chat: 'any', actor: true },
  { kind: 'reply', app: true, chat: 'any', actor: true },
  { kind: 'thread_reply', app: true, chat: 'any', actor: true },
  { kind: 'issue_thread_reply', app: true, chat: 'any', actor: true, detail: '1' },
  { kind: 'change_thread_reply', app: true, chat: 'any', actor: true, detail: '2' },
  { kind: 'issue_mention', app: true, actor: true, detail: '1' },
  { kind: 'channel_message', app: true, chat: 'any', actor: true },
  { kind: 'reaction', app: true, chat: 'own', actor: true, detail: '👍' },
  { kind: 'kudos', app: true, actor: true },
  { kind: 'friend_request', actor: true },
  { kind: 'friend_accept', actor: true },
  // Invitations.
  { kind: 'collab_invite', app: true, actor: true, detail: 'join' },
  { kind: 'collab_invite_accepted', app: true, actor: true },
  { kind: 'approver_invite', app: true, actor: true },
  { kind: 'approver_invite_accepted', app: true, actor: true },
  // A project's work.
  { kind: 'spec_shared', app: true, actor: true, detail: '1' },
  { kind: 'session_done', app: true },
  { kind: 'session_stalled', app: true },
  { kind: 'auto_solve_done', app: true, detail: 'code' },
  { kind: 'connector_submitted', app: true, detail: 'submitted' },
  { kind: 'agent_awaiting_input', app: true },
  // Changes and votes.
  { kind: 'pr_proposed', app: true, actor: true },
  { kind: 'change_ready', app: true, actor: true, detail: 'epoch:1' },
  { kind: 'proposal_vote', app: true, actor: true, detail: 'yes' },
  { kind: 'revision_recheck', app: true, actor: true, detail: 'epoch:1:you' },
  { kind: 'check_failed', app: true },
  { kind: 'stale_pr', app: true },
  { kind: 'pr_merged', app: true },
  { kind: 'voted_change_merged', app: true, detail: 'yes' },
  { kind: 'weekly_digest', app: false, detail: 'w:3:12:3' },
  { kind: 'vote_digest', detail: '3' },
  { kind: 'voted_digest', detail: '3' },
  // A project's own news.
  { kind: 'issue_opened', app: true, actor: true, detail: '1' },
  { kind: 'app_health', app: true, detail: 'deploy_failed' },
  { kind: 'invite_opened', app: true },
  { kind: 'member_joined', app: true, actor: true },
  // The leaked-link guard's two. Link 0 is nobody's, so the row offers no
  // button that would turn a real link off.
  { kind: 'invite_link_busy', app: true, detail: '0:20' },
  { kind: 'invite_link_paused', app: true, detail: '0:100' },
  { kind: 'project_opened', app: true },
  { kind: 'first_message', app: true, chat: 'any', actor: true },
  { kind: 'app_delete_attempted', app: true, actor: true },
  { kind: 'app_deleted', actor: true, detail: 'Notification test project' },
  // Messages.
  { kind: 'conversation_invite', conversation: true, actor: true },
  { kind: 'conversation_message', conversation: true, message: 'actor', actor: true },
  { kind: 'conversation_mention', conversation: true, message: 'actor', actor: true },
  { kind: 'conversation_reply', conversation: true, message: 'actor', actor: true },
  { kind: 'conversation_thread_reply', conversation: true, message: 'actor', actor: true },
  { kind: 'conversation_reaction', conversation: true, message: 'own', actor: true, detail: '👍' },
  // Homeroom bot's build moments.
  { kind: 'build_ready', conversation: true, bot: true },
  { kind: 'build_needs_you', conversation: true, bot: true },
  { kind: 'build_stopped', conversation: true, bot: true },
  { kind: 'build_live', conversation: true, bot: true },
  // The account's own.
  { kind: 'app_quota_changed', detail: '2:4' },
  { kind: 'app_quota_request_declined' },
  { kind: 'moderation_report', detail: 'A test report' },
  { kind: 'moderation_action', detail: 'A test action' },
  // Admins' (a test account is not one: its tap opens a screen it cannot see).
  { kind: 'app_quota_requested', actor: true },
  { kind: 'openrouter_key_review', actor: true },
  { kind: 'platform_limit', detail: 'apps_warn:8:10' },
  { kind: 'platform_incident', detail: 'digest:3' },
  // The Settings button's test push.
  { kind: 'test_alert' },
]);
const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));
const KIND_NAMES = Object.freeze(KINDS.map((k) => k.kind));

function refuse(status, code, message, extra) {
  const { TestAccountError } = require('./test-accounts');
  throw new TestAccountError(status, code, message, extra);
}

/** `kinds` from a request: absent is every kind, else each must be one. */
function parseKinds(value) {
  if (value == null) return KIND_NAMES.slice();
  if (!Array.isArray(value) || !value.length || value.length > KIND_NAMES.length) {
    refuse(400, 'invalid_request', 'kinds must be a list of notification kinds.', { field: 'kinds' });
  }
  const unknown = value.filter((k) => !BY_KIND.has(k));
  if (unknown.length) {
    refuse(400, 'unknown_kind', `Not a notification kind: ${unknown.map(String).join(', ')}.`, { field: 'kinds', kinds: KIND_NAMES });
  }
  return [...new Set(value)];
}

/**
 * The account's test conversation, made the first time: a group of its own,
 * owned by it, so it lists in its Messages and nobody else's.
 */
async function ensureConversation(client, userId) {
  const { rows: [found] } = await client.query(
    `SELECT c.id FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.status = 'member'
      WHERE c.kind = 'group' AND c.status = 'active' AND c.created_by = $1 AND c.title = $2
      ORDER BY c.id DESC LIMIT 1`,
    [userId, CONVERSATION_TITLE]
  );
  if (found) return found.id;
  const { rows: [made] } = await client.query(
    `INSERT INTO conversations (kind, title, created_by) VALUES ('group', $1, $2) RETURNING id`,
    [CONVERSATION_TITLE, userId]
  );
  await client.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, status, joined_at, responded_at)
     VALUES ($1, $2, 'owner', 'member', NOW(), NOW())`,
    [made.id, userId]
  );
  return made.id;
}

/**
 * Send `kinds` (every kind when absent) to test account `userId`, as full
 * admin `actorId`. Returns { userId, username, sent: [{ kind, notificationId,
 * listed, pushes }], skipped: [{ kind, reason }], project, projectMessage
 * (whether its discussion had a message for those kinds to show),
 * conversationId, registrations, pushCategoriesEnabled }.
 */
async function send(pool, { userId, kinds, allPushCategories = true } = {}, { actorId } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) refuse(403, 'forbidden', 'A full administrator is required.');
  if (!Number.isSafeInteger(userId) || userId <= 0) refuse(400, 'invalid_request', 'userId must be a test account\'s id.');
  if (typeof allPushCategories !== 'boolean') {
    refuse(400, 'invalid_request', 'allPushCategories must be true or false.', { field: 'allPushCategories' });
  }
  const wanted = parseKinds(kinds);
  const { rows: [target] } = await pool.query(
    'SELECT id, username, test_account_created_at, anonymised_at FROM users WHERE id = $1',
    [userId]
  );
  if (!target || !target.test_account_created_at || target.anonymised_at) {
    refuse(404, 'not_test_account', 'That account is not a live test account. Test notifications go only to an account create_test_account made.');
  }
  const specs = wanted.map((k) => BY_KIND.get(k));
  const run = crypto.randomBytes(3).toString('hex');

  // The fixtures, together: the project and its newest messages, the
  // conversation and its two new ones, and the push categories.
  const client = await pool.connect();
  let fx;
  try {
    await client.query('BEGIN');
    const { rows: [app] } = await client.query(
      `SELECT id, slug, name FROM apps WHERE created_by = $1 AND status <> 'error' ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    const { rows: [bot] } = await client.query("SELECT id FROM users WHERE username = 'homeroom_bot'");
    fx = { app: app || null, botId: bot ? bot.id : null, chat: {}, conversationId: null, message: {} };
    const say = (who) => (who === 'own'
      ? `A message of yours, for a test reaction (${run})`
      : `@${target.username} a test notification from Homeroom (${run})`);
    if (fx.app && specs.some((s) => s.chat)) {
      for (const who of ['any', 'own']) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: [m] } = await client.query(
          `SELECT id FROM chat_messages
            WHERE app_id = $1 AND thread_type IS NULL AND deleted_at IS NULL AND ($2::int IS NULL OR user_id = $2)
            ORDER BY id DESC LIMIT 1`,
          [fx.app.id, who === 'own' ? userId : null]
        );
        fx.chat[who] = m ? m.id : null;
      }
    }
    if (specs.some((s) => s.conversation)) {
      fx.conversationId = await ensureConversation(client, userId);
      for (const who of ['actor', 'own']) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: [m] } = await client.query(
          'INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id',
          [fx.conversationId, who === 'own' ? userId : actorId, say(who)]
        );
        fx.message[who] = m.id;
      }
    }
    if (allPushCategories) {
      await client.query(
        `INSERT INTO mobile_push_preferences (user_id, category, enabled)
         SELECT $1, c, TRUE FROM unnest($2::text[]) AS c
         ON CONFLICT (user_id, category) DO UPDATE SET enabled = TRUE, updated_at = NOW()`,
        [userId, PUSH_CATEGORIES]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const sent = [];
  const skipped = [];
  const { hydrateAndPush, hydrateNotification } = require('./notifications');
  for (const s of specs) {
    if (PARKED_NOTIFICATION_KINDS.includes(s.kind)) { skipped.push({ kind: s.kind, reason: 'parked' }); continue; }
    if (s.app && !fx.app) { skipped.push({ kind: s.kind, reason: 'needs_project' }); continue; }
    const source = s.bot ? fx.botId : (s.actor ? actorId : null);
    // eslint-disable-next-line no-await-in-loop
    const { rows: [row] } = await pool.query(
      `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail,
                                  conversation_id, conversation_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id`,
      [userId, s.app ? fx.app.id : null, s.chat ? fx.chat[s.chat] || null : null, source, s.kind, s.detail || null,
        s.conversation ? fx.conversationId : null, s.message ? fx.message[s.message] : null]
    );
    // eslint-disable-next-line no-await-in-loop
    const listed = !!(await hydrateNotification(pool, row.id));
    // eslint-disable-next-line no-await-in-loop
    await hydrateAndPush(pool, row);
    sent.push({ kind: s.kind, notificationId: row.id, listed });
  }

  // How many pushes each row queued: the trigger decided at its insert.
  const ids = sent.map((r) => r.notificationId);
  const { rows: queued } = ids.length ? await pool.query(
    'SELECT notification_id, COUNT(*)::int AS n FROM mobile_push_deliveries WHERE notification_id = ANY($1::int[]) GROUP BY 1',
    [ids]
  ) : { rows: [] };
  const pushes = new Map(queued.map((q) => [q.notification_id, q.n]));
  for (const r of sent) r.pushes = pushes.get(r.notificationId) || 0;
  const { rows: [{ n: registrations }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM mobile_push_registrations
      WHERE user_id = $1 AND session_expires_at > NOW() AND permission_status IN ('authorized', 'provisional')`,
    [userId]
  );

  log.info('test-notifications', 'Test notifications sent', {
    userId, by: actorId, sent: sent.length, skipped: skipped.length, registrations,
  });
  return {
    userId,
    username: target.username,
    sent,
    skipped,
    project: fx.app ? fx.app.slug : null,
    projectMessage: !!fx.chat.any,
    conversationId: fx.conversationId,
    registrations,
    pushCategoriesEnabled: allPushCategories,
  };
}

module.exports = { KINDS, KIND_NAMES, CONVERSATION_TITLE, PUSH_CATEGORIES, parseKinds, send };
