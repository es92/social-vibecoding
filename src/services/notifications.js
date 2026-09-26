// Notifications service: @mention parsing + persistence + WS push.
//
// The DB shape (`kind` column) is generic so different notification types
// share one table + pipeline. Kinds today: 'mention' (group-chat @mention),
// 'kudos' (PR kudos), 'reply' (#15 — someone quoted your message/PR in
// group chat), 'reaction' (#25 — someone reacted to your message;
// `detail` carries the emoji), 'stale_pr' (a promoted PR going quiet),
// 'pr_proposed' (a PR was promoted for voting — fanned out to the app's
// active users + creator + favoriters so they come vote; self-app PRs
// go to creator + favoriters only), 'session_done'
// (#161 — a dev-session turn finished after its owner left),
// 'session_stalled' (#3181 — a dev-session turn ended without finishing:
// an error, a timeout or a lost worker, or a system pause mid-turn),
// 'auto_solve_done' (#161 — a headless auto-solve run finished; `detail`
// holds the outcome: spec | code | spec_code (#170) | question | failed)
// and 'spec_shared' (#86 — someone privately shared a spec version with
// you; `detail` carries the version number as a string). Actionable managed
// OpenRouter failures use openrouter_key_review; openrouter_key_created is a
// historical render-only kind now that successful issuance is routine.
// #2387 adds 'thread_reply': a reply in an app-chat reply thread you started
// or replied in (chat_message_id is the reply; its thread_ref the root).
// 'platform_limit' tells full admins a server-wide cap (MAX_APPS,
// MAX_GLOBAL_SESSIONS) is nearly or completely used; `detail` carries the
// cap, level and figures (services/platform-limit-alerts.js).

const log = require('./logger');
const usernames = require('./usernames');
const { listActiveUserIds } = require('./active-users');
const notificationPreferences = require('./notification-preferences');

// Usernames in this app are [A-Za-z0-9_]+, length-restricted on signup.
// Match @token that is NOT preceded by a word character (so emails don't
// trigger mentions) and capture up to 32 chars.
const MENTION_RE = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;

// Platform conversations deliberately use their own kinds rather than the
// app-chat mention/reply/reaction kinds. That keeps routing, access checks,
// grouping, and mobile-push preferences from inheriting app-centric state.
const CONVERSATION_NOTIFICATION_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
  // #2387: a reply in a thread you started or replied in.
  'conversation_thread_reply',
]);
const CONVERSATION_KIND_SQL = [...CONVERSATION_NOTIFICATION_KINDS]
  .map((kind) => `'${kind}'`).join(', ');

// Conversation notification rows are useful only while their recipient may
// still open the referenced conversation. Invite history remains visible
// after acceptance, while an invited user may see only the invite itself.
// Removed/departed members match no row and therefore lose title/content as
// well as navigation metadata on list, exact lookup, and live hydration.
const CONVERSATION_ACCESS_SQL = `(
  (n.conversation_id IS NULL AND n.kind NOT IN (${CONVERSATION_KIND_SQL}))
  OR (
    n.conversation_id IS NOT NULL
    AND n.kind IN (${CONVERSATION_KIND_SQL})
    AND EXISTS (
      SELECT 1
        FROM conversation_members notification_member
        JOIN conversations notification_conversation
          ON notification_conversation.id = notification_member.conversation_id
         AND notification_conversation.status = 'active'
       WHERE notification_member.conversation_id = n.conversation_id
         AND notification_member.user_id = n.user_id
         AND (
           notification_member.status = 'member'
           OR (n.kind = 'conversation_invite' AND notification_member.status = 'invited')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM conversations direct_conversation
             JOIN conversation_direct_pairs direct_pair
               ON direct_pair.conversation_id = direct_conversation.id
             JOIN user_blocks direct_block
               ON (direct_block.blocker_id = direct_pair.user_low_id
                   AND direct_block.blocked_user_id = direct_pair.user_high_id)
                OR (direct_block.blocker_id = direct_pair.user_high_id
                   AND direct_block.blocked_user_id = direct_pair.user_low_id)
            WHERE direct_conversation.id = n.conversation_id
              AND direct_conversation.kind = 'direct'
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks sender_block
            WHERE sender_block.blocker_id = n.user_id
              AND sender_block.blocked_user_id = n.source_user_id
         )
    )
  )
)`;

// App discussion notifications carry chat_message_id; block applies to
// mentions, replies, and reactions even when the underlying post is visible.
const CHAT_SENDER_ACCESS_SQL = `(
  n.chat_message_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM user_blocks blocked
     WHERE blocked.blocker_id = n.user_id
       AND blocked.blocked_user_id = n.source_user_id
  )
)`;

// #2386: the two friend kinds. A friend_request row carries Accept / Decline
// only while it still ASKS something — the same sender's request to this
// recipient is still pending — so that is read live off `friendships` rather
// than remembered on the row: a request withdrawn, answered elsewhere or
// ended by a block stops offering buttons at once. FALSE for every other kind.
const FRIEND_NOTIFICATION_KINDS = new Set(['friend_request', 'friend_accept']);
const FRIEND_REQUEST_PENDING_SQL = `(n.kind = 'friend_request' AND EXISTS (
  SELECT 1 FROM friendships pending_friend
   WHERE pending_friend.user_low_id = LEAST(n.user_id, n.source_user_id)
     AND pending_friend.user_high_id = GREATEST(n.user_id, n.source_user_id)
     AND pending_friend.requester_id = n.source_user_id
     AND pending_friend.status = 'pending'
))`;

function parseMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.add(m[2].toLowerCase());
  }
  return [...out];
}

// Resolve `@name` captures to users. Reads the retired-handle ledger as
// well as `users`: once someone renames, their old handle is
// reserved forever, so `@alice` in a message written after alice became
// `ada` would otherwise resolve to nobody and the mention would silently
// do nothing. Nobody else can ever hold `alice`, so pointing it at ada is
// unambiguous. Named `names` here because `usernames` is now the module.
async function resolveUsers(pool, names) {
  if (!names.length) return [];
  return (await usernames.resolveHandles(pool, names))
    .map((r) => ({ id: r.id, username: r.username }));
}

// Visibility scoping: for a collab-private app, restrict a candidate
// recipient-id list to its collaborators (status='member'). Public-collab
// apps pass through unchanged. Keeps notification deep links from landing
// people on chats they can't read (mentions) or PRs they can't vote on
// (pr_proposed).
async function filterToCollaborators(pool, appId, userIds) {
  if (!appId || !userIds.length) return userIds;
  const { rows: appRows } = await pool.query(
    'SELECT collab_visibility FROM apps WHERE id = $1',
    [appId]
  );
  if (appRows[0]?.collab_visibility !== 'private') return userIds;
  const { rows } = await pool.query(
    `SELECT user_id FROM app_collaborators
      WHERE app_id = $1 AND status = 'member' AND user_id = ANY($2::int[])`,
    [appId, userIds]
  );
  const members = new Set(rows.map((r) => r.user_id));
  return userIds.filter((id) => members.has(id));
}

// Creates notification rows for every mention in `content` that resolves to
// a real user (excluding the sender). Returns the inserted notification rows
// joined with recipient + app info so callers can push them over WS.
async function createMentionNotifications(pool, { appId, chatMessageId, senderId, content }) {
  const names = parseMentions(content);
  if (!names.length) return [];

  const users = await resolveUsers(pool, names);
  // Self-mentions are allowed (useful for testing and also as a "remind
  // me" pattern). If this becomes noisy we can put it behind a flag.
  // For collab-private apps, drop mentioned users who aren't members —
  // their notification would deep-link to a chat they can't read.
  const allowedIds = new Set(
    await filterToCollaborators(pool, appId, users.map((u) => u.id))
  );
  const recipients = users.filter((u) => allowedIds.has(u.id));
  if (!recipients.length) return [];

  const values = [];
  const params = [];
  recipients.forEach((u, i) => {
    const base = i * 5;
    values.push(`($${base + 1}::int, $${base + 2}::int, $${base + 3}::int, $${base + 4}::int, $${base + 5}::varchar)`);
    params.push(u.id, appId, chatMessageId, senderId, 'mention');
  });

  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     SELECT v.user_id, v.app_id, v.chat_message_id, v.source_user_id, v.kind
       FROM (VALUES ${values.join(', ')}) AS v(user_id, app_id, chat_message_id, source_user_id, kind)
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks blocked
         WHERE blocked.blocker_id = v.user_id AND blocked.blocked_user_id = v.source_user_id
      )
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    params
  );
  return rows;
}

// #15: reply notification. Fired when a user quotes someone's message or
// PR in group chat. `replyMessageId` is the NEW reply message, so clicking
// the notification lands the recipient on the app's group chat where the
// reply lives. No-op for self-replies or authorless (system) targets.
async function createReplyNotification(pool, { appId, replyMessageId, senderId, recipientId }) {
  if (!recipientId || recipientId === senderId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     SELECT $1, $2, $3, $4, 'reply'
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks blocked
         WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = $4
      )
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, replyMessageId, senderId]
  );
  return rows;
}

// #2387: a reply in an app-chat reply thread (chat_messages thread_type
// 'message', thread_ref = the root). Addressed to the root's author and to
// everybody who replied earlier, minus:
//   * the sender;
//   * `excludeUserIds` — the people this same message already reached with a
//     more specific row (a 'mention', or a 'reply' for a quote). One row per
//     person per message, and the specific one wins;
//   * anybody blocked either way, and on a collab-private app anybody who is
//     no longer a member (their row would deep-link to a chat they cannot
//     read — filterToCollaborators, as for mentions);
//   * anybody who switched this app's "Replies to you" category off
//     (notification-preferences.js `thread_replies`, which gates this kind
//     alongside the quote-reply `reply` kind).
// Earlier repliers are read from live (non-deleted) replies: deleting your
// reply is the one way to step out of a thread.
async function createThreadReplyNotifications(pool, {
  appId, replyMessageId, rootId, senderId, excludeUserIds = [],
}) {
  if (!appId || !replyMessageId || !rootId) return [];
  const { rows: candidates } = await pool.query(
    `SELECT root.user_id
       FROM chat_messages root
      WHERE root.id = $1 AND root.app_id = $2 AND root.user_id IS NOT NULL
     UNION
     SELECT earlier.user_id
       FROM chat_messages earlier
      WHERE earlier.app_id = $2 AND earlier.thread_type = 'message'
        AND earlier.thread_ref = $1 AND earlier.id < $3
        AND earlier.user_id IS NOT NULL AND earlier.deleted_at IS NULL`,
    [rootId, appId, replyMessageId]
  );
  const skip = new Set([senderId, ...excludeUserIds].map(Number));
  let ids = [...new Set(candidates.map((r) => Number(r.user_id)))]
    .filter((id) => Number.isInteger(id) && !skip.has(id));
  if (!ids.length) return [];
  ids = await filterToCollaborators(pool, appId, ids);
  if (!ids.length) return [];
  ids = await notificationPreferences.filterUsersByCategory(pool, {
    userIds: ids, appId, categoryKey: 'thread_replies',
  });
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     SELECT recipient, $2, $3, $4, 'thread_reply'
       FROM UNNEST($1::int[]) AS recipient
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks blocked
         WHERE (blocked.blocker_id = recipient AND blocked.blocked_user_id = $4)
            OR (blocked.blocker_id = $4 AND blocked.blocked_user_id = recipient)
      )
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [ids, appId, replyMessageId, senderId]
  );
  return rows;
}

// ── #1374's four new notifications ───────────────────────────────────
//
// Each of these was a silence before this change. A new issue notified
// nobody, a proposal MERGING notified nobody, a vote on your own proposal
// notified nobody, and a failed deploy notified nobody. The per-app
// preference screen would have been three switches over two real
// notifications without them.
//
// All four gate through services/notification-preferences.js, which is what
// makes one switch govern the on-platform row and the phone push together:
// mobile_push_deliveries references notifications(id), so a row that is
// never created can never be pushed.

// A new issue on an app, to that app's stakeholders.
//
// The audience is deliberately the SAME one createPrProposedNotifications
// computes — active users, the creator and favoriters, minus the author,
// narrowed to collaborators on a collab-private app — because "who cares
// about this app" should not have two different answers depending on which
// kind of thing just happened. The self-app exception is here for the same
// reason too: everyone active on any app counts as active on the platform
// app, so without it filing an issue here would ping the entire user base.
//
// The issue NUMBER rides in `detail` rather than a column of its own.
// notifications has app_id, session_id, chat_message_id and conversation_id,
// and an issue is none of those; `detail` is the generic slot the schema
// already keeps for exactly this ("a notification kind that needs a small
// extra string"), and app_id + number is enough for the drawer to link.
async function createIssueOpenedNotifications(pool, { appId, issueNumber, authorId }) {
  if (!appId || !issueNumber) return [];

  const { rows: appRows } = await pool.query(
    'SELECT self_hosted FROM apps WHERE id = $1',
    [appId]
  );
  const selfHosted = !!appRows[0]?.self_hosted;
  const activeIds = selfHosted ? [] : await listActiveUserIds(pool, appId);

  const { rows: extraRows } = await pool.query(
    `SELECT created_by AS id FROM apps WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id AS id FROM app_favorites WHERE app_id = $1`,
    [appId]
  );

  let recipientIds = new Set([...activeIds, ...extraRows.map((r) => r.id)]);
  recipientIds.delete(authorId);
  recipientIds = new Set(await filterToCollaborators(pool, appId, [...recipientIds]));
  if (!recipientIds.size) return [];

  recipientIds = new Set(await notificationPreferences.filterUsersByCategory(pool, {
    userIds: [...recipientIds],
    appId,
    categoryKey: 'new_issues',
  }));
  if (!recipientIds.size) return [];

  // NOT EXISTS rather than a read-then-write, matching pr_proposed: two
  // concurrent creates of the same issue must not double-notify.
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
     SELECT u, $2, $3, 'issue_opened', $4::text
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u AND n.app_id = $2
          AND n.kind = 'issue_opened' AND n.detail = $4::text
      )
     RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
    [[...recipientIds], appId, authorId || null, String(issueNumber)]
  );
  return rows;
}

// Your proposal merged. Addressed to its author, and the one notification in
// this set that is unambiguously good news rather than a request to act.
//
// System-generated, so source_user_id stays null: a merge is the group's
// decision arriving, not a person doing something to you. `force` rides in
// `detail` so the drawer can tell an admin override apart from a vote that
// carried, which are the same event with very different meanings to the
// person who wrote the change.
// #1688: `credits` is the "Backed by alice and bob, shaped by carol." sentence
// for a merge the vote carried — it rides in `detail`, which a force merge
// uses for its own marker, so the two never meet.
async function createPrMergedNotification(pool, { userId, appId, sessionId, forced = false, credits = null }) {
  if (!userId || !sessionId) return [];
  if (!await notificationPreferences.allowsKind(pool, { userId, appId, kind: 'pr_merged' })) return [];
  const detail = forced
    ? 'forced'
    : (typeof credits === 'string' && credits.trim() ? credits.trim().slice(0, 255) : null);
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, NULL, 'pr_merged', $4
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3 AND n.kind = 'pr_merged'
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, detail]
  );
  return rows;
}

// #1688: a proposal this person had said yes to got a new version from its
// author, and their yes no longer counts until they look again. One row per
// (voter, session, epoch) — `detail` carries the epoch, so a second push
// asks again and a resumed tail does not. The author is never asked to
// re-confirm their own update, and a voter who muted the category is left
// alone: the roster on the proposal's page still names them.
async function createRevisionRecheckNotifications(pool, { appId, sessionId, authorId, voterIds, epoch }) {
  const ids = [...new Set((voterIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== Number(authorId)))];
  if (!ids.length || !sessionId) return [];
  const allowed = await notificationPreferences.filterUsersByCategory(pool, {
    userIds: ids, appId, categoryKey: 'revision_recheck',
  });
  if (!allowed.length) return [];
  const detail = `epoch:${Number.isFinite(Number(epoch)) ? Number(epoch) : 0}`;
  const values = [];
  const params = [appId, sessionId, authorId || null, detail];
  allowed.forEach((userId) => {
    params.push(userId);
    values.push(`($${params.length}, $1, $2, $3, 'revision_recheck', $4)`);
  });
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT v.user_id, v.app_id, v.session_id, v.source_user_id, v.kind, v.detail
       FROM (VALUES ${values.join(', ')}) AS v (user_id, app_id, session_id, source_user_id, kind, detail)
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = v.user_id AND n.session_id = v.session_id
           AND n.kind = 'revision_recheck' AND n.detail = v.detail
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    params
  );
  return rows;
}

// Somebody voted on a proposal of yours.
//
// NOT de-duplicated per session, unlike its neighbours: a vote is a discrete
// event and the second one is news, where a second "checks failed" for the
// same proposal is noise. It IS de-duplicated per (voter, session) though,
// because flipping a vote back and forth must not be a way to ping somebody
// repeatedly. The direction rides in `detail`.
async function createProposalVoteNotification(pool, { userId, appId, sessionId, voterId, vote }) {
  if (!userId || !sessionId || !voterId) return [];
  // Voting on your own proposal is allowed; notifying yourself about it is
  // not useful.
  if (userId === voterId) return [];
  if (!await notificationPreferences.allowsKind(pool, { userId, appId, kind: 'proposal_vote' })) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, $4, 'proposal_vote', $5
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'proposal_vote' AND n.source_user_id = $4
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, voterId, vote === 'no' ? 'no' : 'yes']
  );
  return rows;
}

// The app is unwell: a deploy failed, or it stopped running.
//
// Addressed to the people who can actually do something about it, which is
// the creator and the app's admins. That is also why `app_health` is the one
// preference category marked adminOnly: offering the switch to everybody
// else would be offering to mute something they were never going to get.
//
// De-duplicated on UNREAD rather than ever: a failure that is still unread
// should not stack, but once you have seen and cleared one, the NEXT failure
// is news again. Same rule check_failed uses.
//
// `detail` is a SHORT TOKEN, not a reason line: notifications.detail is
// VARCHAR(32), and 32 characters of a build failure ("Command failed: npm
// run build:sh") is a fragment rather than information. The drawer renders
// the copy from the token, and the full reason is on apps.last_failure,
// where an operator is going anyway.
async function createAppHealthNotification(pool, { appId, detail }) {
  if (!appId) return [];
  const { rows: recipientRows } = await pool.query(
    `SELECT created_by AS id FROM apps WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id AS id FROM app_admins WHERE app_id = $1`,
    [appId]
  );
  const ids = [...new Set(recipientRows.map((r) => r.id).filter(Boolean))];
  if (!ids.length) return [];

  const allowed = await notificationPreferences.filterUsersByCategory(pool, {
    userIds: ids,
    appId,
    categoryKey: 'app_health',
  });
  if (!allowed.length) return [];

  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
     SELECT u, $2, NULL, 'app_health', $3
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u AND n.app_id = $2
          AND n.kind = 'app_health' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
    // VARCHAR(32). See the note above the function: this is a short token,
    // not a reason line.
    [allowed, appId, (detail || '').slice(0, 32) || null]
  );
  return rows;
}

// #25: reaction notification. Fired when a user adds an emoji reaction to
// someone else's message. `messageId` is the reacted message (so clicking
// lands on the app's group chat); `emoji` rides in the `detail` column.
// No-op for self-reactions or authorless (system) targets.
async function createReactionNotification(pool, { appId, messageId, senderId, recipientId, emoji }) {
  if (!recipientId || recipientId === senderId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, $4, 'reaction', $5
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks blocked
         WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = $4
      )
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, messageId, senderId, (emoji || '').slice(0, 32)]
  );
  return rows;
}

// Stale-PR warning. Fired by the stale-promoted-PR sweeper when a PR
// proposed to the group has had no voting interest for the configured
// window. Addressed to the PR author (session.user_id) so they can nudge
// the group or merge/withdraw before the grace period elapses and it's
// auto-archived. System-generated, so source_user_id is null; references
// the session so the dropdown can render the PR title + a deep link.
async function createStalePrNotification(pool, { userId, appId, sessionId }) {
  if (!userId) return [];
  if (!await notificationPreferences.allowsKind(pool, { userId, appId, kind: 'stale_pr' })) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'stale_pr')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #237: staging preview failed to boot, so proposal checks can't run and the
// PR is merge-blocked. Addressed to the proposal owner (system-generated, so
// source_user_id is NULL). Same unread-dedup as session_done — at most one
// unread 'check_failed' per (user, session) — so the per-streak nudge can't
// pile up if the owner hasn't looked yet. The streak gate in
// staging-recovery.recordStagingBootFailure already limits this to once per
// failure streak; the dedup is belt-and-suspenders against re-fires.
async function createCheckFailedNotification(pool, { userId, appId, sessionId }) {
  if (!userId || !sessionId) return [];
  // #1374. allowsKind fails OPEN on a read error: the quiet failure mode of
  // this whole feature is a notification silently not arriving, and this one
  // is telling somebody their proposal cannot merge.
  if (!await notificationPreferences.allowsKind(pool, { userId, appId, kind: 'check_failed' })) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT $1, $2, $3, NULL, 'check_failed'
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'check_failed' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #161: dev-session completion notification (kind='session_done').
// Fired by the chat handler's done hook when the session owner armed
// notify_on_done (they left mid-turn), and unconditionally by
// server.js's resumeDetachedTurn (the pre-restart SSE is guaranteed
// dead, so nobody was watching). System-generated, so source_user_id
// is null. Unread dedup: at most one unread session_done per
// (user, session) — multiple completions while away collapse into the
// row the user hasn't seen yet (atomic via INSERT … WHERE NOT EXISTS,
// same pattern as createPrProposedNotifications).
async function createSessionDoneNotification(pool, { userId, appId, sessionId }) {
  if (!userId || !sessionId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT $1, $2, $3, NULL, 'session_done'
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'session_done' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #3181: the other way a dev-session turn ends (kind='session_stalled'). A
// turn that died on an error, a timeout or a lost worker, or a session the
// platform paused in the middle of one, used to end in silence: nothing said
// the work had stopped, and the owner found out when they next looked. The
// caller decides what counts as stalled; a stop the user pressed never does.
// Same shape and same unread dedup as session_done: at most one unread
// session_stalled per (user, session).
async function createSessionStalledNotification(pool, { userId, appId, sessionId }) {
  if (!userId || !sessionId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT $1, $2, $3, NULL, 'session_stalled'
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'session_stalled' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #1405 path A: a connector session put work somewhere (kind=
// 'connector_submitted'). Aimed at the TASK OWNER — the person whose agent did
// it — which is the exact inverse of createPrProposedNotifications' rule that
// "the proposer is always excluded".
//
// That rule is right for a human clicking Promote: you know what you just did.
// The connector breaks the assumption, because the proposer is an agent acting
// on your behalf while you may be nowhere near the screen. So this is a
// separate kind rather than a relaxation of that one — pr_proposed means "come
// vote" and fans out to collaborators; this means "your agent did a thing" and
// goes to one person.
//
// `detail` is which destination it took: 'submitted' (up for a vote) or
// 'shared' (#1347's in-progress area). Unread-deduped per session AND per
// detail, so sharing repeatedly onto the same card — which #1347 deliberately
// allows — notifies once, while a later submit of that same card still does.
async function createConnectorSubmittedNotification(pool, { userId, appId, sessionId, detail }) {
  if (!userId || !sessionId) return [];
  const kindDetail = (detail || 'submitted').slice(0, 32);
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, NULL, 'connector_submitted', $4::varchar
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'connector_submitted' AND n.detail IS NOT DISTINCT FROM $4
          AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId || null, sessionId, kindDetail]
  );
  return rows;
}

// #1405 path B: the agent said it is waiting on this user, and the wait has now
// been outstanding long enough to be worth a nudge (kind=
// 'agent_awaiting_input'). Created by the sweeper in
// services/connector-input-waits.js, never at arming time — the whole point of
// the delay is that somebody at their keyboard answers before this ever runs.
//
// No session: the question is about the CHAT, which the platform cannot see.
// `appId` is whatever app the agent named, and may be null.
//
// Deliberately NOT deduped on unread. Each row corresponds to one armed wait
// that survived its delay, and the arming side already guarantees at most one
// live wait per user (see the partial unique index in schema.sql) — so the
// bound lives where it can actually be enforced rather than here.
async function createAgentAwaitingInputNotification(pool, { userId, appId }) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, NULL, NULL, 'agent_awaiting_input')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId || null]
  );
  return rows;
}

// #161: headless auto-solve completion (kind='auto_solve_done').
// Always created at runHeadlessSession's terminal writes (no arming —
// starting an auto-solve opts you into its completion notification).
// `detail` carries the outcome: 'spec' | 'code' | 'spec_code' (#170) |
// 'question' | 'failed'.
// Same unread dedup as session_done so a resume re-fire can't double up.
async function createAutoSolveDoneNotification(pool, { userId, appId, sessionId, detail }) {
  if (!userId || !sessionId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, NULL, 'auto_solve_done', $4
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = $1 AND n.session_id = $3
          AND n.kind = 'auto_solve_done' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, (detail || '').slice(0, 32) || null]
  );
  return rows;
}

// #86: private spec share (kind='spec_shared'). Fired by the
// share-user endpoint after a NEW chat_session_spec_user_shares row is
// inserted (the endpoint skips this entirely on a duplicate share, so
// a recipient is pinged at most once per spec version). `session_id`
// points at the dev session — listForUser/hydrateAndPush already join
// chat_sessions, so prTitle/branchName ride along for the row label.
// `detail` carries the spec version as a string (same generic-detail
// pattern as 'reaction') so the click handler can open the exact
// version in the read-only spec panel.
async function createSpecSharedNotification(pool, { recipientId, appId, sessionId, sharerId, version }) {
  if (!recipientId || !sessionId || version == null) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, $4, 'spec_shared', $5)
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [recipientId, appId, sessionId, sharerId || null, String(version).slice(0, 32)]
  );
  return rows;
}

// Successful company-funded OpenRouter issuance is recorded on the managed
// key itself and visible in Admin > Users; it is not an actionable inbox
// event. Only a key that needs review creates a notification, and only full
// admins receive it because read-only admins cannot block, enable, delete, or
// reconcile the key. `detail` carries only the local managed-key id; the raw
// child key never enters the notification table, logs, WebSocket payload, or
// admin UI.
async function createManagedOpenRouterReviewNotifications(pool, {
  sourceUserId, managedKeyId,
}) {
  if (!sourceUserId || !managedKeyId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, source_user_id, kind, detail)
     SELECT admin.id, $1, 'openrouter_key_review', $2::varchar(32)
       FROM users admin
      WHERE admin.is_admin = TRUE
        AND admin.admin_readonly = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM notifications existing
           WHERE existing.user_id = admin.id
             AND existing.source_user_id = $1
             AND existing.kind = 'openrouter_key_review'
             AND existing.detail = $2::varchar(32)
             AND existing.read_at IS NULL
        )
     RETURNING id, user_id, source_user_id, kind, detail, created_at`,
    [sourceUserId, String(managedKeyId).slice(0, 32)],
  );
  return rows;
}

// A server-wide cap (MAX_APPS, MAX_GLOBAL_SESSIONS) reached its warning line
// or its ceiling — services/platform-limit-alerts.js decides when. Full
// admins only: they are the people who can raise a cap or free room under
// it, so a view-only admin is not paged about something they cannot act on.
// `detail` is that module's "<limit>_<level>:<used>:<cap>" token. No app:
// the cap belongs to the server, and an app_id would let opening the
// platform's own app mark the alert read unseen (markReadForApp).
//
// De-dupe: an admin still holding an UNREAD alert for the same cap and level
// gets no second one — the counts in the first are already stale, and a
// pile of them says nothing the first did not.
async function createPlatformLimitNotifications(pool, { detail }) {
  const token = String(detail || '').slice(0, 32);
  const sep = token.indexOf(':');
  if (sep <= 0) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, source_user_id, kind, detail)
     SELECT admin.id, NULL, 'platform_limit', $1::varchar(32)
       FROM users admin
      WHERE admin.is_admin = TRUE
        AND admin.admin_readonly = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM notifications existing
           WHERE existing.user_id = admin.id
             AND existing.kind = 'platform_limit'
             AND split_part(existing.detail, ':', 1) = $2
             AND existing.read_at IS NULL
        )
     RETURNING id, user_id, source_user_id, kind, detail, created_at`,
    [token, token.slice(0, sep)],
  );
  return rows;
}

async function notifyManagedOpenRouterReviewAdmins(pool, args) {
  const rows = await createManagedOpenRouterReviewNotifications(pool, args);
  await Promise.all(rows.map((row) => hydrateAndPush(pool, row)));
  return rows;
}

// Hydrate one freshly-inserted notification row with the same joins
// listForUser performs and push it to its recipient over WS as a
// notification_new. Best-effort: completion notifications ride inside
// SSE/turn pipelines that must never fail because of a push.
async function hydrateAndPush(pool, row) {
  if (!row || !row.id) return;
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.kind, n.user_id, n.read_at, n.created_at,
              n.app_id, a.slug AS app_slug, a.name AS app_name,
              n.chat_message_id,
              cm.content AS message_content,
              cm.thread_type, cm.thread_ref,
              n.session_id,
              cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
              cs.agent_session_id,
              n.conversation_id, c.kind AS conversation_kind,
              c.title AS conversation_title,
              n.conversation_message_id,
              conversation_message.content AS conversation_message_content,
              conversation_message.thread_root_id AS conversation_thread_root_id,
              su.username AS source_username,
              n.source_user_id,
              ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
              n.detail,
              pv.reason AS vote_reason
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
       LEFT JOIN chat_sessions cs ON cs.id = n.session_id
       LEFT JOIN conversations c ON c.id = n.conversation_id
       LEFT JOIN conversation_messages conversation_message
         ON conversation_message.id = n.conversation_message_id
       LEFT JOIN users su ON su.id = n.source_user_id
       LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
       WHERE n.id = $1 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}`,
      [row.id]
    );
    if (!rows.length) return;
    const { pushNotificationToUser } = require('./ws');
    pushNotificationToUser(rows[0].user_id, {
      type: 'notification_new',
      notification: serialize(rows[0]),
    });
  } catch (err) {
    log.warn('notifications', 'hydrateAndPush failed', { id: row.id, err: err.message });
  }
}

// PR-proposed (vote-request) notification. Fired when a session is
// promoted — the genuine "please come vote on this" moment, NOT raw PR
// creation (which happens automatically after the first commit and would
// be far noisier). References the session so the dropdown renders the PR
// title + a group-chat deep link, exactly like the kudos/stale_pr kinds.
//
// Targeting (deliberately narrower than "every registered user", which
// would be a platform-wide firehose since membership is global): the
// app's currently-active users (the people whose votes actually count
// per services/active-users.js), plus the app creator and anyone who
// favorited it — so stakeholders who aren't currently "active" still get
// nudged. The proposer is always excluded. For the platform self-app,
// active users are skipped entirely (see inline comment below) — only
// creator + favoriters are pinged.
//
// De-dupe: skips any recipient who already has a pr_proposed row for this
// session, so a re-promote (e.g. a PR that went stale then was proposed
// again) doesn't re-spam people who were already pinged. `source_user_id`
// is the proposer so the dropdown can render "@user proposed a PR…".
async function createPrProposedNotifications(pool, { appId, sessionId, proposerId }) {
  if (!appId || !sessionId) return [];

  // Self-app exception: active-users.js counts everyone active on ANY
  // app as "active" on the platform self-app (it has no App tab of its
  // own), so including activeIds here would ping the entire user base
  // on every platform self-edit PR. Scope those to opt-in stakeholders
  // only — creator + favoriters; favoriting the platform app is the
  // subscription. Child apps keep the active-users fan-out: active-on-
  // that-app is already a meaningful audience.
  const { rows: appRows } = await pool.query(
    'SELECT self_hosted FROM apps WHERE id = $1',
    [appId]
  );
  const selfHosted = !!appRows[0]?.self_hosted;
  const activeIds = selfHosted ? [] : await listActiveUserIds(pool, appId);

  // App creator + favoriters as a stakeholder floor. Either may already
  // be in activeIds; we dedupe via the Set below.
  const { rows: extraRows } = await pool.query(
    `SELECT created_by AS id FROM apps WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id AS id FROM app_favorites WHERE app_id = $1`,
    [appId]
  );

  let recipientIds = new Set([...activeIds, ...extraRows.map((r) => r.id)]);
  recipientIds.delete(proposerId);
  // Collab-private apps: only collaborators can vote, so only they get
  // nudged (a favoriter of a view-public/collab-private app would
  // otherwise be asked to vote on a PR they can't act on).
  recipientIds = new Set(await filterToCollaborators(pool, appId, [...recipientIds]));
  if (!recipientIds.size) return [];

  // #1374: drop the recipients who have muted new proposals for this app.
  // ONE query for the whole fan-out rather than one per recipient — this
  // list can be every active user of a busy app, and asking per person would
  // turn a single insert into hundreds of round trips.
  //
  // This category defaults OFF, so on a platform with no stored preferences
  // this returns nobody and the notification stops being sent at all. That
  // is the intended change, and the daily digest (services/vote-digest.js)
  // is what keeps the group's voting turnout from going with it.
  recipientIds = new Set(await notificationPreferences.filterUsersByCategory(pool, {
    userIds: [...recipientIds],
    appId,
    categoryKey: 'new_proposals',
  }));
  if (!recipientIds.size) return [];

  // INSERT ... SELECT with a NOT EXISTS guard so the per-recipient
  // de-dupe is atomic (no read-then-write race on concurrent promotes).
  const ids = [...recipientIds];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT u, $2, $3, $4, 'pr_proposed'
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u AND n.session_id = $3 AND n.kind = 'pr_proposed'
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [ids, appId, sessionId, proposerId || null]
  );
  return rows;
}

// Collaborator-invite notification (kind='collab_invite'). One row per
// outstanding invite; the actionable accept/decline UI lives in the
// drawer's pinned Invites section (driven by listPendingInvites below,
// the authoritative "still actionable" source) — this row is the badge
// bump + the history entry that remains after the invite resolves.
// #2161: someone with the standing to delete a shared app tried to, and the
// route refused the plain delete (the creator of a shared app, or a full
// admin who has not yet acknowledged the other contributors). The other
// contributors are told so the intent is not a surprise later. Unread-dedup
// per (recipient, app): a retried click while the first row is unread does
// not add a second one. `source_user_id` is the person who tried.
async function createAppDeleteAttemptNotifications(pool, { appId, actorId, recipientIds }) {
  const ids = [...new Set((recipientIds || []).filter((id) => id != null && id !== actorId))];
  if (!appId || !ids.length) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     SELECT r.user_id, $1, $2, 'app_delete_attempted'
       FROM unnest($3::int[]) AS r(user_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = r.user_id AND n.app_id = $1
           AND n.kind = 'app_delete_attempted' AND n.read_at IS NULL
      )
     RETURNING id, user_id, app_id, source_user_id, kind, created_at`,
    [appId, actorId ?? null, ids]
  );
  await Promise.all(rows.map((row) => hydrateAndPush(pool, row)));
  return rows;
}

// #2161: a full admin deleted a shared app over the other contributors'
// heads. By the time this runs the app row is gone, and notifications.app_id
// cascades with it, so the row carries NO app reference: the name rides in
// `detail` (widened to 255 for this, schema.sql) and the slug is only logged.
// `source_user_id` is the admin who deleted it.
async function createAppDeletedNotifications(pool, { appName, appSlug, actorId, recipientIds }) {
  const ids = [...new Set((recipientIds || []).filter((id) => id != null && id !== actorId))];
  if (!ids.length) return [];
  const name = String(appName || appSlug || 'an app').slice(0, 255);
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
     SELECT r.user_id, NULL, $1, 'app_deleted', $2
       FROM unnest($3::int[]) AS r(user_id)
     RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
    [actorId ?? null, name, ids]
  );
  await Promise.all(rows.map((row) => hydrateAndPush(pool, row)));
  return rows;
}

async function createCollabInviteNotification(pool, { appId, recipientId, inviterId }) {
  if (!recipientId || !appId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'collab_invite')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, inviterId || null]
  );
  return rows;
}

// Inviter feedback (kind='collab_invite_accepted'): "@x accepted your
// invite". Informational only — renders in the normal grouped list with
// the standard click-through, no buttons.
async function createCollabInviteAcceptedNotification(pool, { appId, recipientId, accepterId }) {
  if (!recipientId || !appId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'collab_invite_accepted')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, accepterId || null]
  );
  return rows;
}

// Approver-invite notification (kind='approver_invite', issue #646).
// Mirror of createCollabInviteNotification: badge bump + history row;
// the actionable accept/decline UI lives in the drawer's pinned
// Invites section (listPendingInvites below).
async function createApproverInviteNotification(pool, { appId, recipientId, inviterId }) {
  if (!recipientId || !appId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'approver_invite')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, inviterId || null]
  );
  return rows;
}

// Inviter feedback (kind='approver_invite_accepted'): "@x accepted your
// approver invite". Informational only, like collab_invite_accepted.
async function createApproverInviteAcceptedNotification(pool, { appId, recipientId, accepterId }) {
  if (!recipientId || !appId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'approver_invite_accepted')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, accepterId || null]
  );
  return rows;
}

// Pending invites for the drawer's pinned Invites section. Sourced from
// app_collaborators / app_approvers (NOT the notifications table) so
// the section is authoritative about what's still actionable — a
// collab_invite / approver_invite notification row alone can't tell
// whether the invite was already accepted/declined in another tab.
// Each row carries `kind: 'collab' | 'approver'` so the drawer wires
// the right accept/decline endpoints and copy.
async function listPendingInvites(pool, userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT 'collab' AS kind, ac.app_id, a.slug AS app_slug, a.name AS app_name,
            ac.created_at, inv.username AS invited_by
       FROM app_collaborators ac
       JOIN apps a ON a.id = ac.app_id
       LEFT JOIN users inv ON inv.id = ac.invited_by
      WHERE ac.user_id = $1 AND ac.status = 'invited'
     UNION ALL
     SELECT 'approver' AS kind, ap.app_id, a.slug AS app_slug, a.name AS app_name,
            ap.created_at, inv.username AS invited_by
       FROM app_approvers ap
       JOIN apps a ON a.id = ap.app_id
       LEFT JOIN users inv ON inv.id = ap.invited_by
      WHERE ap.user_id = $1 AND ap.status = 'invited'
      ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    kind: r.kind,
    appId: r.app_id,
    appSlug: r.app_slug,
    appName: r.app_name,
    invitedBy: r.invited_by,
    createdAt: r.created_at,
  }));
}

// Resolve (mark read) the collab_invite notification rows for one
// (user, app) pair — called when the invite is accepted, declined, or
// auto-resolved by the app going collab-public. Idempotent.
async function markInviteNotificationsRead(pool, userId, appId) {
  if (!userId || !appId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND kind = 'collab_invite' AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Same for approver_invite rows (issue #646) — accepted, declined,
// revoked, or auto-resolved by the app's policy flipping back to
// 'anyone'. Idempotent.
async function markApproverInviteNotificationsRead(pool, userId, appId) {
  if (!userId || !appId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND kind = 'approver_invite' AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Fetch up to `limit` recent notifications for a user, newest first.
// Joins app + sender + message content so the UI dropdown can render in a
// single round-trip.
//
// Kudos notifications reference a chat_session instead of a chat_message,
// so we join both tables and the FE renderer picks the right one based on
// `kind`. Both joins are LEFT so mentions still render fine without a
// session and kudos still render fine without a message.
//
// Pagination (scroll-to-load-more): pass `before = { createdAt, id }` to
// fetch the page strictly older than that cursor. We compare the
// `(created_at, id)` tuple so rows sharing a `created_at` don't get
// skipped or repeated across page boundaries — the id is a stable
// tiebreak. Ordering + the keyset comparison ride the existing
// idx_notifications_user_recent index on (user_id, created_at DESC).
// `kinds` narrows the page to a set of notification kinds. It exists for the
// bell's Messages tab: that tab is a client-side filter over the same feed, so
// paging it through the unfiltered cursor fetched 100 rows that were mostly
// something else and typically surfaced no new message at all. Filtering in
// SQL means one page of "older messages" IS a page of older messages.
//
// The filter is applied after the index, not by it: the ordering and the
// keyset comparison still ride idx_notifications_user_recent on
// (user_id, created_at DESC), and `kind` is a cheap equality check on the rows
// that index already produced.
async function listForUser(pool, userId, { limit = 100, before = null, kinds = null } = {}) {
  const params = [userId];
  let cursorClause = '';
  if (before && before.createdAt && before.id != null) {
    params.push(before.createdAt, before.id);
    // $2 = cursor created_at, $3 = cursor id.
    cursorClause = `AND (n.created_at, n.id) < ($2, $3)`;
  }
  let kindClause = '';
  if (Array.isArray(kinds) && kinds.length) {
    params.push(kinds);
    kindClause = `AND n.kind = ANY($${params.length})`;
  }
  params.push(limit);
  const limitIdx = params.length; // last param is the limit
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            n.session_id,
            cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            cs.agent_session_id,
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            conversation_message.thread_root_id AS conversation_thread_root_id,
            su.username AS source_username,
            n.source_user_id,
            ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
            n.detail,
            pv.reason AS vote_reason
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN conversations c ON c.id = n.conversation_id
     LEFT JOIN conversation_messages conversation_message
       ON conversation_message.id = n.conversation_message_id
     LEFT JOIN users su ON su.id = n.source_user_id
     LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
     WHERE n.user_id = $1 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}
     ${cursorClause}
     ${kindClause}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

// Fetch one notification through the same ownership and hydration boundary as
// the dropdown list. Native push carries only this opaque id; all private
// content is resolved here after the Social web session is authenticated.
async function getForUser(pool, userId, id) {
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            n.session_id,
            cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            cs.agent_session_id,
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            conversation_message.thread_root_id AS conversation_thread_root_id,
            su.username AS source_username,
            n.source_user_id,
            ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
            n.detail,
            pv.reason AS vote_reason
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
       LEFT JOIN chat_sessions cs ON cs.id = n.session_id
       LEFT JOIN conversations c ON c.id = n.conversation_id
       LEFT JOIN conversation_messages conversation_message
         ON conversation_message.id = n.conversation_message_id
       LEFT JOIN users su ON su.id = n.source_user_id
       LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
      WHERE n.id = $1 AND n.user_id = $2 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}`,
    [id, userId]
  );
  return rows[0] || null;
}

async function countUnread(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications AS n
      WHERE n.user_id = $1 AND n.read_at IS NULL
        AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}`,
    [userId]
  );
  return rows[0]?.c || 0;
}

// "Action-completed" registry — the reusable auto-dismiss mechanism.
//
// Each entry names a moment in the app where some user action resolves a
// set of notification kinds, and which notifications column scopes that
// action's target. Adding a new auto-dismiss is a one-line entry here plus
// a call to markReadForAction() at the action site — no new bespoke
// function per trigger.
//
//   vote_cast    — user voted on a PR; clears the vote-request nudge
//                  (pr_proposed) + the author's going-quiet warning
//                  (stale_pr) for that PR. Scoped by session_id.
//                  Triggered in src/routes/votes.js after the vote upsert.
//   message_sent — user posted a message in an app's group chat; clears
//                  every unread chat-actionable notification (mention /
//                  reply / reaction) they have for that app. Scoped by
//                  app_id. Triggered in src/services/ws.js on chat send.
//
// `kudos` is deliberately excluded from both: it reports kudos received
// and is resolved by clicking its own dropdown row, not by voting or
// posting. `scope` is the notifications column name — it comes from this
// hardcoded table, never from request input, so there is no
// SQL-injection surface in markReadForAction's interpolation.
const ACTION_COMPLETIONS = {
  // #1688: a vote also answers the re-confirm ask for that proposal — the
  // row's "Still yes" is a vote, and so is a plain Yes or No on the card.
  vote_cast: { kinds: ['pr_proposed', 'stale_pr', 'revision_recheck'], scope: 'session_id' },
  // #2387: 'thread_reply' is a chat-actionable kind like the other three —
  // posting in the app clears it, and it lights the message's unread dot.
  message_sent: { kinds: ['mention', 'reply', 'reaction', 'thread_reply'], scope: 'app_id' },
  // #161: opening a dev session is the canonical "user saw it" signal —
  // it resolves that session's completion notification even when the
  // user navigated there on their own. Triggered in GET /api/sessions/:id.
  // #3181: opening it also answers "it stopped before finishing".
  session_opened: { kinds: ['session_done', 'session_stalled'], scope: 'session_id' },
  // #161: cloning a ready auto-solve session resolves its completion
  // notification. Triggered in POST /api/sessions/:id/clone-headless,
  // scoped to the SOURCE (headless) session id.
  headless_cloned: { kinds: ['auto_solve_done'], scope: 'session_id' },
  // #2847: opening a proposal card, or touching anything on it, answers the
  // "New proposal" nudge the same way a vote does — the viewer has seen it.
  // Only pr_proposed: revision_recheck asks for a re-vote and stale_pr is the
  // author's warning, and looking at a card resolves neither. Triggered by
  // POST /api/notifications/read { session_id } from the dev board.
  proposal_opened: { kinds: ['pr_proposed'], scope: 'session_id' },
};

// The scope columns the registry is allowed to target. A defensive
// allowlist so a typo in ACTION_COMPLETIONS can never widen the set of
// interpolatable column names beyond these two.
const SCOPE_COLUMNS = new Set(['session_id', 'app_id']);

// Generic auto-dismiss primitive. Marks read (read_at = NOW(), never
// deletes — matching the rest of the system) every unread notification
// for `userId` whose registry-scoped column equals `scopeId` and whose
// kind is one the `action` resolves. The WHERE read_at IS NULL guard
// keeps it idempotent, so re-fires (re-votes, reconnect storms,
// already-read rows) are cheap no-ops. Returns the number of rows
// actually cleared so callers can decide whether to fan out a cross-tab
// refresh.
async function markReadForAction(pool, userId, action, scopeId) {
  const def = ACTION_COMPLETIONS[action];
  if (!def) throw new Error(`unknown notification action: ${action}`);
  if (!SCOPE_COLUMNS.has(def.scope)) throw new Error(`bad scope column: ${def.scope}`);
  if (!userId || !scopeId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND ${def.scope} = $2 AND kind = ANY($3) AND read_at IS NULL`,
    [userId, scopeId, def.kinds]
  );
  return rowCount || 0;
}

// #2779: an agent session's changes finish into the bell as session_done
// rows, and they are worked on in the conversation, not on a dev chat of
// their own — so opening the conversation is the "user saw it" signal for
// every one of them, the way opening a dev session is for its own. #3181: a
// change that stopped before finishing is answered the same way.
async function markReadForAgentSession(pool, userId, agentSessionId) {
  if (!userId || !agentSessionId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications n
        SET read_at = NOW()
       FROM chat_sessions cs
      WHERE n.user_id = $1 AND n.kind IN ('session_done', 'session_stalled') AND n.read_at IS NULL
        AND n.session_id = cs.id AND cs.agent_session_id = $2`,
    [userId, agentSessionId]
  );
  return rowCount || 0;
}

// Thin back-compat wrapper so src/routes/votes.js keeps calling the
// session-scoped vote dismiss unchanged.
async function markReadForSession(pool, userId, sessionId) {
  return markReadForAction(pool, userId, 'vote_cast', sessionId);
}

// Clear a single notification by the chat message it points at — the
// in-chat "click a dotted message" path. Scoped to the requesting user
// and to the chat-actionable kinds so clicking a message can't clear an
// unrelated kind that happens to reference it. Idempotent via WHERE
// read_at IS NULL; returns rows cleared.
async function markReadForMessage(pool, userId, chatMessageId) {
  if (!userId || !chatMessageId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND chat_message_id = $2
        AND kind = ANY($3) AND read_at IS NULL`,
    [userId, chatMessageId, ACTION_COMPLETIONS.message_sent.kinds]
  );
  return rowCount || 0;
}

// Given a page of chat message ids, return the subset that currently have
// an unread chat-actionable notification for `userId` — so the messages
// endpoint can flag which rows render an unread dot. Returns a Set of ids.
async function unreadMessageIdsForUser(pool, userId, messageIds) {
  if (!userId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return new Set();
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT chat_message_id
       FROM notifications
      WHERE user_id = $1
        AND chat_message_id = ANY($2::int[])
        AND kind = ANY($3)
        AND read_at IS NULL`,
    [userId, messageIds, ACTION_COMPLETIONS.message_sent.kinds]
  );
  return new Set(rows.map((r) => r.chat_message_id));
}

// Per-app mark-read — backs the notifications dropdown's per-group
// "Mark read" affordance (#84 grouping). Clears every unread
// notification this user has for one app, regardless of kind, in a
// single round-trip. Unlike markReadForAction (which is scoped to a
// fixed set of kinds tied to a user action), this is a deliberate
// "I've seen everything from this app" gesture, so it spans all kinds.
// Idempotent via the read_at IS NULL guard; returns rows cleared so the
// route can decide whether to fan out a cross-tab refresh.
async function markReadForApp(pool, userId, appId) {
  if (!userId || !appId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Per-conversation counterpart to markReadForApp. Conversation ids never
// fall back to app ids: the two notification domains remain disjoint even if
// their integer primary keys happen to be equal.
async function markReadForConversation(pool, userId, conversationId) {
  if (!userId || !conversationId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications n
        SET read_at = NOW()
      WHERE n.user_id = $1 AND n.conversation_id = $2 AND n.read_at IS NULL
        AND ${CONVERSATION_ACCESS_SQL}`,
    [userId, conversationId]
  );
  return rowCount || 0;
}

// Single-id and mark-all clears. Returns rows actually cleared (like the
// scoped helpers above) so the route can decide whether to fan out a
// cross-tab `notifications_changed` refresh.
async function markRead(pool, userId, { id, all = false, kinds = null, excludeKinds = null } = {}) {
  if (all) {
    // Optional kind scoping for the split drawers: the header cog's
    // "Mark all read" sends kinds=[the session-related set] so it only
    // clears its own rows; the bell's sends excludeKinds=[same set] so
    // it never clears the cog's. No scope = the historical clear-all.
    if (Array.isArray(kinds) && kinds.length) {
      const { rowCount } = await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL AND kind = ANY($2)`,
        [userId, kinds]
      );
      return rowCount || 0;
    }
    if (Array.isArray(excludeKinds) && excludeKinds.length) {
      const { rowCount } = await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL AND NOT (kind = ANY($2))`,
        [userId, excludeKinds]
      );
      return rowCount || 0;
    }
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    );
    return rowCount || 0;
  }
  if (!id) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId]
  );
  return rowCount || 0;
}

// App-chat kinds whose row is about ONE message, and so has a Messages
// address of its own (#2387).
const APP_CHAT_MESSAGE_KINDS = new Set(['mention', 'reply', 'reaction', 'thread_reply']);

// Where an app-chat message notification opens, in the client's Messages
// addresses: a reply-thread message opens its thread
// (`#messages/app/<slug>/thread/<rootId>`), a general-stream message opens
// on the message (`#messages/app/<slug>/m/<messageId>`). A topic-thread
// message (issue / proposal / governance) and every other kind answer null,
// and the client keeps routing those as it always has.
function notificationHref(row) {
  if (!row || !APP_CHAT_MESSAGE_KINDS.has(row.kind) || !row.app_slug) return null;
  const slug = encodeURIComponent(row.app_slug);
  if (row.thread_type === 'message' && row.thread_ref != null) {
    return `#messages/app/${slug}/thread/${Number(row.thread_ref)}`;
  }
  if (!row.thread_type && row.chat_message_id != null) {
    return `#messages/app/${slug}/m/${Number(row.chat_message_id)}`;
  }
  return null;
}

// Decorate a raw notification row with the fields the client dropdown wants.
// Keeps the wire format identical whether the notif is fresh (over WS) or
// loaded from history (`GET /api/notifications`).
//
// Kudos extension: sessionId / sessionTitle / prTitle / prNumber ride along
// whenever the row carries a session reference. The FE renderer keys off
// `kind` to decide which fields to use — kudos rows ignore chatMessageId /
// messageContent, mention rows ignore sessionId / prTitle.
function serialize(row) {
  const isConversation = CONVERSATION_NOTIFICATION_KINDS.has(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    readAt: row.read_at,
    createdAt: row.created_at,
    // Fail closed if a malformed conversation row also carries legacy app
    // references: private messaging must never route through or render as an
    // app chat notification.
    appId: isConversation ? null : row.app_id,
    appSlug: isConversation ? null : row.app_slug,
    appName: isConversation ? null : row.app_name,
    chatMessageId: isConversation ? null : row.chat_message_id,
    conversationId: isConversation ? row.conversation_id : null,
    conversationKind: isConversation ? (row.conversation_kind || null) : null,
    conversationTitle: isConversation ? (row.conversation_title || null) : null,
    conversationMessageId: isConversation ? row.conversation_message_id : null,
    // #2387: the thread the referenced message sits in (null: the main
    // stream). A thread alert opens #messages/<id>/thread/<root>.
    conversationThreadRootId: isConversation ? (row.conversation_thread_root_id ?? null) : null,
    messageContent: isConversation
      ? (row.conversation_message_content ?? null)
      : row.message_content,
    // #194 parity: when the referenced chat message lives in a topic
    // thread, these route the click to that topic instead of general chat.
    threadType: isConversation ? null : (row.thread_type || null),
    threadRef: !isConversation && row.thread_ref != null ? row.thread_ref : null,
    sessionId: isConversation ? null : row.session_id,
    // #971: the session's display name (schema.sql #249 — set from the first
    // interactive message, refreshed pre-PR, mirrored from pr_title once a PR
    // exists). Session-scoped renderers prefer it so a titled session never
    // shows its machine-generated branch name.
    sessionTitle: isConversation ? null : row.session_title,
    prTitle: isConversation ? null : row.pr_title,
    prNumber: isConversation ? null : row.pr_number,
    // #161: auto_solve_done rows route back to their issue row. branchName is
    // the last-resort label for session-scoped rows — only reached when the
    // session has neither a session title nor a PR title yet.
    headlessIssueNumber: isConversation ? null : row.headless_issue_number,
    branchName: isConversation ? null : row.branch_name,
    // #2779: the agent session a change was started from, so its completion
    // opens the conversation it is worked on in.
    agentSessionId: isConversation ? null : (row.agent_session_id || null),
    sourceUsername: row.source_username,
    detail: row.detail,
    // #1688: the line the voter left with their vote, read LIVE off their
    // row (a vote's notification is one per voter per proposal, so a later
    // edit of the line shows here without a second notification). Only the
    // vote row has a voter to read it from.
    voteReason: row.kind === 'proposal_vote' ? (row.vote_reason || null) : null,
    // #2387: the Messages address this row opens, when it has one.
    href: isConversation ? null : notificationHref(row),
    // #2386: who to answer, and whether there is still a question. Only on
    // the two friend kinds, so every other row's shape is unchanged.
    ...(FRIEND_NOTIFICATION_KINDS.has(row.kind) ? {
      sourceUserId: row.source_user_id || null,
      friendRequestPending: row.kind === 'friend_request' && !!row.friend_request_pending,
    } : {}),
  };
}

module.exports = {
  parseMentions,
  resolveUsers,
  createMentionNotifications,
  createReplyNotification,
  createThreadReplyNotifications,
  createReactionNotification,
  createStalePrNotification,
  createIssueOpenedNotifications,
  createPrMergedNotification,
  createProposalVoteNotification,
  createRevisionRecheckNotifications,
  createAppHealthNotification,
  createPlatformLimitNotifications,
  createCheckFailedNotification,
  createSessionDoneNotification,
  createSessionStalledNotification,
  createAutoSolveDoneNotification,
  createConnectorSubmittedNotification,
  createAgentAwaitingInputNotification,
  createSpecSharedNotification,
  createManagedOpenRouterReviewNotifications,
  notifyManagedOpenRouterReviewAdmins,
  hydrateAndPush,
  createPrProposedNotifications,
  createAppDeleteAttemptNotifications,
  createAppDeletedNotifications,
  createCollabInviteNotification,
  createCollabInviteAcceptedNotification,
  createApproverInviteNotification,
  createApproverInviteAcceptedNotification,
  listPendingInvites,
  markInviteNotificationsRead,
  markApproverInviteNotificationsRead,
  filterToCollaborators,
  listForUser,
  getForUser,
  countUnread,
  markRead,
  markReadForSession,
  markReadForAction,
  markReadForAgentSession,
  markReadForApp,
  markReadForConversation,
  markReadForMessage,
  unreadMessageIdsForUser,
  ACTION_COMPLETIONS,
  CONVERSATION_NOTIFICATION_KINDS,
  APP_CHAT_MESSAGE_KINDS,
  notificationHref,
  FRIEND_NOTIFICATION_KINDS,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
