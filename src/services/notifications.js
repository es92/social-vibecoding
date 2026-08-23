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
// 'auto_solve_done' (#161 — a headless auto-solve run finished; `detail`
// holds the outcome: spec | code | spec_code (#170) | question | failed)
// and 'spec_shared' (#86 — someone privately shared a spec version with
// you; `detail` carries the version number as a string).

const log = require('./logger');
const usernames = require('./usernames');
const { listActiveUserIds } = require('./active-users');

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
    )
  )
)`;

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
// well as `users` (#1336): once someone renames, their old handle is
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
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(u.id, appId, chatMessageId, senderId, 'mention');
  });

  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     VALUES ${values.join(', ')}
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
     VALUES ($1, $2, $3, $4, 'reply')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, replyMessageId, senderId]
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
     VALUES ($1, $2, $3, $4, 'reaction', $5)
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
              n.conversation_id, c.kind AS conversation_kind,
              c.title AS conversation_title,
              n.conversation_message_id,
              conversation_message.content AS conversation_message_content,
              su.username AS source_username,
              n.detail
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
       LEFT JOIN chat_sessions cs ON cs.id = n.session_id
       LEFT JOIN conversations c ON c.id = n.conversation_id
       LEFT JOIN conversation_messages conversation_message
         ON conversation_message.id = n.conversation_message_id
       LEFT JOIN users su ON su.id = n.source_user_id
       WHERE n.id = $1 AND ${CONVERSATION_ACCESS_SQL}`,
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
async function listForUser(pool, userId, { limit = 100, before = null } = {}) {
  const params = [userId];
  let cursorClause = '';
  if (before && before.createdAt && before.id != null) {
    params.push(before.createdAt, before.id);
    // $2 = cursor created_at, $3 = cursor id.
    cursorClause = `AND (n.created_at, n.id) < ($2, $3)`;
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
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            su.username AS source_username,
            n.detail
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN conversations c ON c.id = n.conversation_id
     LEFT JOIN conversation_messages conversation_message
       ON conversation_message.id = n.conversation_message_id
     LEFT JOIN users su ON su.id = n.source_user_id
     WHERE n.user_id = $1 AND ${CONVERSATION_ACCESS_SQL}
     ${cursorClause}
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
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            su.username AS source_username,
            n.detail
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
       LEFT JOIN chat_sessions cs ON cs.id = n.session_id
       LEFT JOIN conversations c ON c.id = n.conversation_id
       LEFT JOIN conversation_messages conversation_message
         ON conversation_message.id = n.conversation_message_id
       LEFT JOIN users su ON su.id = n.source_user_id
      WHERE n.id = $1 AND n.user_id = $2 AND ${CONVERSATION_ACCESS_SQL}`,
    [id, userId]
  );
  return rows[0] || null;
}

async function countUnread(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications AS n
      WHERE n.user_id = $1 AND n.read_at IS NULL
        AND ${CONVERSATION_ACCESS_SQL}`,
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
  vote_cast: { kinds: ['pr_proposed', 'stale_pr'], scope: 'session_id' },
  message_sent: { kinds: ['mention', 'reply', 'reaction'], scope: 'app_id' },
  // #161: opening a dev session is the canonical "user saw it" signal —
  // it resolves that session's completion notification even when the
  // user navigated there on their own. Triggered in GET /api/sessions/:id.
  session_opened: { kinds: ['session_done'], scope: 'session_id' },
  // #161: cloning a ready auto-solve session resolves its completion
  // notification. Triggered in POST /api/sessions/:id/clone-headless,
  // scoped to the SOURCE (headless) session id.
  headless_cloned: { kinds: ['auto_solve_done'], scope: 'session_id' },
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
    sourceUsername: row.source_username,
    detail: row.detail,
  };
}

module.exports = {
  parseMentions,
  resolveUsers,
  createMentionNotifications,
  createReplyNotification,
  createReactionNotification,
  createStalePrNotification,
  createCheckFailedNotification,
  createSessionDoneNotification,
  createAutoSolveDoneNotification,
  createSpecSharedNotification,
  hydrateAndPush,
  createPrProposedNotifications,
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
  markReadForApp,
  markReadForConversation,
  markReadForMessage,
  unreadMessageIdsForUser,
  ACTION_COMPLETIONS,
  CONVERSATION_NOTIFICATION_KINDS,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
