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
// #4535 adds 'issue_thread_reply': a message in a request's discussion
// thread, to the request's filer and everybody who posted there before
// (chat_message_id is the message; thread_ref the issue number, which
// `detail` also carries).
// #3952 adds 'issue_mention': somebody named you with @ in a request they
// filed (`detail` is its number, like 'issue_opened'). #4271: it stands in
// for 'issue_opened' when you would get both (notifyIssueFiled).
// 'platform_limit' tells full admins a server-wide cap (MAX_APPS,
// MAX_GLOBAL_SESSIONS) is nearly or completely used; `detail` carries the
// cap, level and figures (services/platform-limit-alerts.js).
// 'platform_incident' (#4296) tells full admins about errors that should not
// happen: a daily digest of the previous day's counts per kind, or one kind
// past its hourly threshold; `detail` carries which, and the figures
// (services/platform-incident-alerts.js).
// 'channel_message' is a person's message in the discussion of a private
// project of 8 people or fewer, to the rest of its people: one row per
// discussion that folds later messages into a count in `detail`
// (services/group-channel-notify.js, which writes and clears it).
//
// 5 October (Page Turners): a row about a change, a digest or a first
// message says what is true NOW, read with the row (LIVE_ROW_COLUMNS_SQL):
// a "ready to try" whose change went live says Live, a "Waiting for your
// approval" digest counts only what still waits, and a first message Homeroom
// bot filed as a request says it asked for a change. A change that is
// decided settles what the bell still asked about it (settleDecidedChange).
// #4778: those asks also read as read LIVE off the change's own status
// (DECIDED_ASK_SETTLED_SQL), so a settle that never ran cannot leave a
// merged or closed proposal sitting unread in the bell for hours.
// The same day, a group's discussion row about a message the bot filed as a
// request said "@mo_t1006 in Page Turners" over it: it says they asked for a
// change too (FILED_MESSAGE_JOIN_SQL).

const log = require('./logger');
const notifyCopy = require('./homeroom-bot-notify-copy');
const usernames = require('./usernames');
const { listActiveUserIds } = require('./active-users');
const notificationPreferences = require('./notification-preferences');
const notificationBookmarks = require('./notification-bookmarks');
const { PARKED_NOTIFICATION_KINDS } = require('./kudos-parked');

// #5249: a parked feature's rows (kudos, while it is parked) are neither
// listed nor counted. Built from the frozen constant in kudos-parked.js,
// never from input, so interpolating it is safe; a static clause rather than
// a parameter, so every reader's own parameter numbering stays as it was.
// The rows stay in the table: flip the switch back and they come back.
const PARKED_KINDS_SQL = PARKED_NOTIFICATION_KINDS.length
  ? `n.kind NOT IN (${PARKED_NOTIFICATION_KINDS.map((k) => `'${k}'`).join(', ')})`
  : 'TRUE';

// Usernames in this app are [A-Za-z0-9_]+, length-restricted on signup.
// Match @token that is NOT preceded by a word character (so emails don't
// trigger mentions) and capture up to 32 chars.
const MENTION_RE = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;

// Platform conversations deliberately use their own kinds rather than the
// app-chat mention/reply/reaction kinds. That keeps routing, access checks,
// grouping, and mobile-push preferences from inheriting app-centric state.
// The Homeroom bot's account (conversations.js HOMEROOM_BOT_USERNAME).
const HOMEROOM_BOT_USERNAME = 'homeroom_bot';

const CONVERSATION_NOTIFICATION_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
  // #2387: a reply in a thread you started or replied in.
  'conversation_thread_reply',
  // WP-E: the Homeroom bot's message at one of its build moments, in your DM
  // with it (homeroom-bot-dm.js BUILD_KINDS). A conversation row like any
  // other message of the bot's; only its push category ("Your builds") is its
  // own, so turning Messages off does not silence it.
  'build_ready',
  'build_needs_you',
  'build_stopped',
  'build_live',
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
  NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
  AND (n.chat_message_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM user_blocks blocked
     WHERE blocked.blocker_id = n.user_id
       AND blocked.blocked_user_id = n.source_user_id
  ))
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

// How many of a "waiting for your approval" digest's changes still wait
// on its reader (src/workflow/rules/change-notifications.ts, where the rule
// is spelled out). Reads `n` (the notification).
const changeNotifications = require('../workflow/rules/change-notifications.ts');
const proposalNotifications = require('../workflow/rules/proposal-notifications.ts');
const { DIGEST_WAITING_SQL } = changeNotifications;

// 5 October (Page Turners): the asks about a change that its decision
// answers for everybody. Nobody is asked to vote on it, to say they still
// back it, or to revive it once it is live or closed, and a digest that
// named it alone has nothing left to count. "Ready to try" (change_ready) is
// settled apart, because a change that went live makes it news.
const { DECIDED_ASK_KINDS } = changeNotifications;

// #4778 (Page Turners): a row that asked something about a change reads as
// read once the change is decided, whether or not settleDecidedChange got to
// it (routes/votes.js, merge-followups/facts.ts, session-lifecycle.js and the
// merge-followups workflow all run it best-effort, so a missed settle used
// to leave a decided proposal sitting unread in the bell for hours).
// #4795 already hides a MERGED change's asks from the list and its count
// without the settle; this read covers what that does not: a CLOSED change's
// asks stay listed, shown read here, and a push-opened row of either kind
// resolves read. change_ready is left to settleDecidedChange. The kinds come
// from the frozen constant above, never from input, so interpolating them is
// safe; the EXISTS form needs no join, so countUnread can use it as-is, and
// it rides the existing chat_sessions primary key.
const DECIDED_ASK_SETTLED_SQL = `(n.kind IN (${DECIDED_ASK_KINDS.map((k) => `'${k}'`).join(', ')})
  AND n.session_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM chat_sessions decided
               WHERE decided.id = n.session_id
                 AND decided.status IN ('merged', 'archived')))`;

// The three things a row's subject has become since it was written, read
// with it (5 October): the status of the change a "ready to try" asked about
// (`session_status`, cs is chat_sessions on n.session_id), how many of a
// digest's changes still wait (`digest_waiting`), and the request a joiner's
// first message, or a message in a group's discussion, became when Homeroom
// bot filed it (`bot_request_number`, from FILED_MESSAGE_JOIN_SQL). Kept
// beside the joins they need in every read of the bell: the list, the exact
// lookup and the live push. A merged change that is not live yet reads as
// merging, which the bell words as going live: live_at is NULL (the
// merge-followups machine), or (#5064) it is a merge of Homeroom itself that
// the running build does not carry yet (a row the old merge path stamped
// live at once, while the platform's own release came minutes later): the
// build that serves is apps.main_sha, and a change merged after the one that
// build was merged from is still on its way. That is the
// board's own boundary (routes/votes.js annotateDeploymentState); no match
// for the running build reads as it always did, live.
const RELEASE_PENDING_SQL = `(COALESCE(cs.merged_at, cs.created_at), cs.id) > (
              SELECT COALESCE(running.merged_at, running.created_at), running.id
                FROM apps self_app
                JOIN chat_sessions running ON running.app_id = self_app.id AND running.status = 'merged'
                 AND LOWER(running.merge_commit_sha) = LOWER(self_app.main_sha)
               WHERE self_app.id = cs.app_id AND self_app.self_hosted
               ORDER BY COALESCE(running.merged_at, running.created_at) DESC, running.id DESC
               LIMIT 1)`;
const LIVE_ROW_COLUMNS_SQL = `CASE WHEN cs.status = 'merged' AND (cs.live_at IS NULL OR ${RELEASE_PENDING_SQL}) THEN 'merging' ELSE cs.status END AS session_status,
            CASE WHEN n.kind = 'vote_digest' THEN ${DIGEST_WAITING_SQL} END AS digest_waiting,
            bot_request.issue_number AS bot_request_number`;
// The kinds whose row carries `sessionStatus`: a "ready to try" (Live, Going
// live or Closed), and the author's and the voters' news that it went live.
const SESSION_STATUS_KINDS = new Set(['change_ready', 'pr_merged', 'voted_change_merged']);
// 'filed' and 'group' are a request in the writer's words; 'revise' asked to
// change one of the bot's changes before it went live. An offer not taken
// up, a question or a dismissed read is still just what they said. The two
// kinds of row that are about one person's message in a project's chat: a
// joiner's first message (to their invite's maker) and a group's discussion
// (channel_message, to the rest of the group; its message is the newest one
// folded in).
// #4417 follow-up: where a REPLY THREAD's first message is, for a row about
// a message in one (`cm`, a 'message' thread whose ref is that first
// message): the general stream (NULL) or one of the project's topic
// channels ('category', its ref the topic), so notificationHref opens the
// thread beside the channel it starts in. NULLs for every other row. The
// socket's own live-alert reads (services/ws.js) spell the same two columns
// out, so they stay static SQL.
const THREAD_ROOT_COLUMNS_SQL = `(SELECT thread_root.thread_type FROM chat_messages thread_root
              WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_type,
            (SELECT thread_root.thread_ref FROM chat_messages thread_root
              WHERE cm.thread_type = 'message' AND thread_root.id = cm.thread_ref) AS root_thread_ref`;

// #5580: what a notification is ABOUT, so the bell can fold one request's
// news into one story. The proposal: the row's own session, or the one whose
// discussion (or a reply thread under it) the message is in. The request: the
// one whose discussion the message is in, else the proposal's (the issue it
// was made from, or the first it links). Both NULL on rows about neither.
const STORY_SESSION_SQL = `COALESCE(n.session_id,
              CASE WHEN cm.thread_type = 'session' THEN cm.thread_ref END,
              (SELECT story_root.thread_ref FROM chat_messages story_root
                WHERE cm.thread_type = 'message' AND story_root.id = cm.thread_ref
                  AND story_root.thread_type = 'session'))`;
const STORY_COLUMNS_SQL = `${STORY_SESSION_SQL} AS story_session_id,
            COALESCE(
              CASE WHEN cm.thread_type = 'issue' THEN cm.thread_ref END,
              (SELECT story_root.thread_ref FROM chat_messages story_root
                WHERE cm.thread_type = 'message' AND story_root.id = cm.thread_ref
                  AND story_root.thread_type = 'issue'),
              (SELECT COALESCE(story_session.created_from_issue_number, story_session.linked_issues[1])
                 FROM chat_sessions story_session WHERE story_session.id = ${STORY_SESSION_SQL})
            ) AS story_issue_number,
            (SELECT bot_card.issue_number FROM homeroom_bot_dm_messages bot_card
              WHERE bot_card.message_id = conversation_message.thread_root_id) AS bot_thread_issue_number,
            (SELECT story_session.pr_number FROM chat_sessions story_session
              WHERE story_session.id = ${STORY_SESSION_SQL}) AS story_pr_number,
            (SELECT COALESCE(story_session.pr_title, story_session.session_title) FROM chat_sessions story_session
              WHERE story_session.id = ${STORY_SESSION_SQL}) AS story_title`;

// #5580: a plain message the bell leaves to the Messages screen (#18). The
// Homeroom bot's reply about a project is the exception: it carries that
// project (homeroom-bot-dm.js storyAppId), files under it, and counts.
const PLAIN_MESSAGE_SQL = `(n.kind = 'channel_message' OR (n.kind = 'conversation_message' AND n.app_id IS NULL))`;

const FILED_MESSAGE_JOIN_SQL = `LEFT JOIN chat_bot_requests bot_request
       ON n.kind IN ('first_message', 'channel_message') AND bot_request.chat_message_id = n.chat_message_id
      AND bot_request.kind IN ('filed', 'group', 'revise') AND bot_request.issue_number IS NOT NULL`;

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

  let users = await resolveUsers(pool, names);
  // B9: a platform account (the Homeroom bot) reads no notifications: a
  // mention of it is a request to it (homeroom-bot-chat.js), and the rows
  // written for it were never read.
  if (users.length) {
    const { rows: people } = await pool.query(
      'SELECT id FROM users WHERE id = ANY($1::int[]) AND is_synthetic = FALSE', [users.map((u) => u.id)],
    );
    const real = new Set(people.map((r) => r.id));
    users = users.filter((u) => real.has(u.id));
  }
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

// #4535: a message in a request's discussion thread (chat_messages
// thread_type 'issue', thread_ref = the GitHub issue number). Addressed to
// the request's filer and everybody who posted there before, minus:
//   * the sender;
//   * `excludeUserIds` — the people this same message already reached with a
//     more specific row (a 'mention', or a 'reply' for a quote). One row per
//     person per message, and the specific one wins, exactly as for a
//     'thread_reply' above;
//   * anybody blocked either way, and on a collab-private app anybody who is
//     no longer a member (filterToCollaborators, as for mentions);
//   * anybody who switched this app's "Replies to you" category off
//     (notification-preferences.js `thread_replies`), which gates this kind
//     alongside `reply` and `thread_reply`.
// The filer is whoever the platform has on record: `issues.created_by`,
// `homeroom_bot_requesters` (the bot filed it for them) or `feedback_reports`
// (the feedback pin). A request opened directly on GitHub has no filer on
// record, so only its earlier posters are notified — the body's Source line
// is deliberately not parsed, which would need a GitHub fetch on every send.
// Earlier posters are read from live (non-deleted) `message` rows only, so
// deleting your own posts steps you out of the thread, and the bot's system
// lines and status rows never make anyone a participant; a UNION with the
// users join also keeps the synthetic accounts themselves out.
async function createIssueThreadNotifications(pool, {
  appId, messageId, issueNumber, senderId, excludeUserIds = [],
}) {
  if (!appId || !messageId || !issueNumber) return [];
  // Match an app's repo owner/repo out of its repo_url, the way
  // homeroom-bot-mayor.js does; null when there is none to parse, in which
  // case the feedback_reports branch narrows to app_id alone.
  const { rows: appRows } = await pool.query(
    'SELECT repo_url FROM apps WHERE id = $1',
    [appId]
  );
  const m = String(appRows[0]?.repo_url || '')
    .match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  const owner = m ? m[1] : null;
  const repo = m ? m[2] : null;

  const { rows: candidates } = await pool.query(
    `SELECT i.created_by AS user_id
       FROM issues i
      WHERE i.app_id = $1 AND i.github_issue_number = $2 AND i.created_by IS NOT NULL
     UNION
     SELECT r.user_id
       FROM homeroom_bot_requesters r
      WHERE r.app_id = $1 AND r.issue_number = $2
     UNION
     SELECT f.user_id
       FROM feedback_reports f
      WHERE f.issue_number = $2 AND (f.app_id = $1 OR ($3::text IS NOT NULL
        AND LOWER(f.issue_owner) = LOWER($3) AND LOWER(f.issue_repo) = LOWER($4)))
     UNION
     SELECT earlier.user_id
       FROM chat_messages earlier
       JOIN users u ON u.id = earlier.user_id AND u.is_synthetic = FALSE
      WHERE earlier.app_id = $1 AND earlier.thread_type = 'issue'
        AND earlier.thread_ref = $2 AND earlier.id < $5
        AND earlier.msg_type = 'message'
        AND earlier.user_id IS NOT NULL AND earlier.deleted_at IS NULL`,
    [appId, Number(issueNumber), owner, repo, messageId]
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
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail)
     SELECT recipient, $2, $3, $4, 'issue_thread_reply', $5::text
       FROM UNNEST($1::int[]) AS recipient
      WHERE NOT EXISTS (
        SELECT 1 FROM user_blocks blocked
         WHERE (blocked.blocker_id = recipient AND blocked.blocked_user_id = $4)
            OR (blocked.blocker_id = $4 AND blocked.blocked_user_id = recipient)
      )
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
    [ids, appId, messageId, senderId, String(Number(issueNumber))]
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
//
// #4271: `mentioned` is who the request's own text already told
// ('issue_mention', notifyIssueFiled writes it first). Those people hear
// about this request once, from the row that says why they are told, unless
// that would cost them the only buzz they asked for (mentionStandsIn).
async function createIssueOpenedNotifications(pool, { appId, issueNumber, authorId, mentioned = [] }) {
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

  // #4271: after the new_issues switch, so only somebody who would have had
  // both rows is ever left out of this one.
  const told = (mentioned || []).map(Number).filter((id) => recipientIds.has(id));
  if (told.length) {
    for (const id of await mentionStandsIn(pool, told)) recipientIds.delete(id);
    if (!recipientIds.size) return [];
  }

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

// #4271: of the people a request's mention told, the ones it tells in place
// of 'issue_opened'. That is all of them but one case: somebody whose phone
// rings for a new request and not for a mention (Direct interactions off,
// App alerts on). For them the mention is a quiet row and this one is the
// buzz they asked for, so they keep both rows rather than lose the buzz.
// Read the way the push outbox reads it (enqueue_mobile_push_deliveries in
// db/schema.sql): each kind's category, their own switch for it or else its
// default. Everything else that decides a push (the phone, a muted project)
// is the same for both rows. Fails toward sending: a read that breaks
// leaves nobody out, which is the duplicate this replaces, not a silence.
async function mentionStandsIn(pool, userIds) {
  try {
    const { rows } = await pool.query(
      `SELECT u AS user_id, policy.kind,
              COALESCE(preference.enabled, policy.default_enabled) AS rings
         FROM UNNEST($1::int[]) AS u
         CROSS JOIN mobile_push_kind_categories policy
         LEFT JOIN mobile_push_preferences preference
           ON preference.user_id = u AND preference.category = policy.category
        WHERE policy.kind IN ('issue_mention', 'issue_opened')`,
      [userIds]
    );
    const rings = new Set(rows.filter((r) => r.rings).map((r) => `${r.user_id}:${r.kind}`));
    return userIds.filter((id) => rings.has(`${id}:issue_mention`) || !rings.has(`${id}:issue_opened`));
  } catch (err) {
    log.warn('notifications', 'Request mention push read failed', { err: err.message });
    return [];
  }
}

// #3952: what a request's markdown draws as code, blanked before its
// mentions are read: `@Component` in a snippet names nobody, and the page
// draws it as code rather than as a mention (group-chat.js
// renderRequestMentions). Fenced blocks (to their closing fence, or the end),
// then inline spans. The `@` guard safeMention adds on the way to GitHub
// comes out first, so text that already went through it reads the same.
function requestMentionText(text) {
  return String(text || '')
    .split('@​').join('@')
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

// #3952: somebody named you with @ in a request they filed (kind
// 'issue_mention'). A mention in a chat message, an issue's thread included,
// already rang ('mention', in services/ws.js); a request's own text went to
// GitHub and nowhere else, so "@snait lmk wyt" at the end of one reached
// nobody. `text` is the title and body as the author wrote them.
//
// The people are the chat mention's: real accounts (never the Homeroom bot),
// on a collab-private project only its members (filterToCollaborators), and
// nobody who blocked the author. Never the author: unlike a chat message, a
// request is not a "remind me" pad. Not gated per project
// (notification-preferences.js keeps a mention account-level), and pushed
// under Direct interactions beside 'mention'. The issue number rides in
// `detail`, as for issue_opened, and one row per person per request, so a
// filing path that runs twice does not ring twice.
async function createIssueMentionNotifications(pool, { appId, issueNumber, authorId, text }) {
  if (!appId || !issueNumber) return [];
  const names = parseMentions(requestMentionText(text));
  if (!names.length) return [];
  const users = await resolveUsers(pool, names);
  if (!users.length) return [];
  const { rows: people } = await pool.query(
    'SELECT id FROM users WHERE id = ANY($1::int[]) AND is_synthetic = FALSE',
    [users.map((u) => u.id)]
  );
  const ids = people.map((r) => r.id).filter((id) => Number(id) !== Number(authorId));
  const recipients = await filterToCollaborators(pool, appId, ids);
  if (!recipients.length) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
     SELECT u, $2, $3, 'issue_mention', $4::text
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
              SELECT 1 FROM user_blocks blocked
               WHERE blocked.blocker_id = u AND blocked.blocked_user_id = $3
            )
        AND NOT EXISTS (
              SELECT 1 FROM notifications n
               WHERE n.user_id = u AND n.app_id = $2
                 AND n.kind = 'issue_mention' AND n.detail = $4::text
            )
     RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
    [recipients, appId, authorId || null, String(issueNumber)]
  );
  return rows;
}

// The filing paths' one call (routes/feedback.js, routes/sessions.js,
// homeroom-bot-dm.js, feedback-reports.js; routes/issues.js and
// homeroom-bot-mayor.js go through notifyIssueFiled below): the rows
// above, then each one's live push. A path that knows only the repository
// (the platform's own, filed with the bot's token) passes `owner` and `repo`,
// and the project is looked up only once the text names somebody. Never
// rejects: the request is filed by the time this runs, and a notification
// must not fail it. Resolves the rows written.
async function notifyIssueMentions(pool, { appId = null, owner = null, repo = null, issueNumber, authorId, text }) {
  try {
    if (!issueNumber || !parseMentions(requestMentionText(text)).length) return [];
    let id = appId;
    if (!id && owner && repo) {
      id = (await require('./issue-announce').findAppByRepo(pool, owner, repo))?.id || null;
    }
    if (!id) return [];
    const rows = await createIssueMentionNotifications(pool, { appId: id, issueNumber, authorId, text });
    await Promise.all(rows.map((row) => hydrateAndPush(pool, row)));
    return rows;
  } catch (err) {
    log.warn('notifications', 'Request mention notifications failed', {
      appId, issueNumber, err: err.message,
    });
    return [];
  }
}

// #4271: the one call for a request filed on a project, where the people
// who follow its new requests are told as well as the people it names
// (routes/issues.js, homeroom-bot-mayor.js). Since #3952 somebody in both
// groups heard about one request twice, and their phone buzzed twice. The
// mention goes first, then 'issue_opened' to everyone it did not already
// tell (createIssueOpenedNotifications). Never rejects, like
// notifyIssueMentions. Resolves the rows of each kind written.
async function notifyIssueFiled(pool, { appId, issueNumber, authorId, text = '' }) {
  const mentions = await notifyIssueMentions(pool, { appId, issueNumber, authorId, text });
  let opened = [];
  try {
    opened = await createIssueOpenedNotifications(pool, {
      appId, issueNumber, authorId, mentioned: mentions.map((row) => row.user_id),
    });
    await Promise.all(opened.map((row) => hydrateAndPush(pool, row)));
  } catch (err) {
    log.warn('notifications', 'Issue-opened notifications failed', {
      appId, issueNumber, err: err.message,
    });
  }
  return { mentions, opened };
}

// #1688: a proposal this person had said yes to got a new version from its
// author, and their yes no longer counts until they look again. One row per
// (voter, session, epoch) — `detail` carries the epoch, so a second push
// asks again and a resumed tail does not. The author is never asked to
// re-confirm their own update, and a voter who muted the category is left
// alone: the roster on the proposal's page still names them.
//
// "One story": `detail` is "epoch:<n>", and ":@<name>" or ":you" after it
// when the update is one somebody asked Homeroom bot for (the newest of the
// change's asks it took up: homeroom_bot_change_asks), so the push says
// whose ask it was, and never "after your feedback" when it was not theirs.
// The epoch alone is what makes a row the same (`split_part`).
async function createRevisionRecheckNotifications(pool, { appId, sessionId, authorId, voterIds, epoch }) {
  const ids = [...new Set((voterIds || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== Number(authorId)))];
  if (!ids.length || !sessionId) return [];
  const allowed = await notificationPreferences.filterUsersByCategory(pool, {
    userIds: ids, appId, categoryKey: 'revision_recheck',
  });
  if (!allowed.length) return [];
  const base = `epoch:${Number.isFinite(Number(epoch)) ? Number(epoch) : 0}`;
  const asker = await updateAsker(pool, sessionId);
  const values = [];
  const params = [appId, sessionId, authorId || null, base];
  allowed.forEach((userId) => {
    params.push(userId);
    const who = !asker ? '' : (asker.id === Number(userId) ? ':you' : (asker.username ? `:@${asker.username}` : ''));
    params.push(`${base}${who}`);
    values.push(`($${params.length - 1}::int, $1::int, $2::int, $3::int, 'revision_recheck'::text, $${params.length}::text)`);
  });
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT v.user_id, v.app_id, v.session_id, v.source_user_id, v.kind, v.detail
       FROM (VALUES ${values.join(', ')}) AS v (user_id, app_id, session_id, source_user_id, kind, detail)
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = v.user_id AND n.session_id = v.session_id
           AND n.kind = 'revision_recheck'
           AND (n.detail = $4::text OR n.detail LIKE $4::text || ':%')
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    params
  );
  return rows;
}

// "One story": who asked Homeroom bot for the update to change `sessionId`
// (the newest ask on it the bot took up), as { id, username }, or null when
// nobody did (a person's own push, or a fix of its checks). Never throws.
async function updateAsker(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username
         FROM homeroom_bot_change_asks a
         JOIN users u ON u.id = a.asker_id
        WHERE a.session_id = $1 AND a.status <> 'queued'
        ORDER BY COALESCE(a.taken_at, a.created_at) DESC, a.id DESC
        LIMIT 1`,
      [Number(sessionId)]
    );
    return rows[0] ? { id: Number(rows[0].id), username: rows[0].username || null } : null;
  } catch (err) {
    log.warn('notifications', 'Could not read who asked for an update', { sessionId, err: err.message });
    return null;
  }
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

// The voter took their vote back (DELETE /api/sessions/:id/vote): the
// author's "X voted yes" row no longer says something true, read or unread,
// so it goes, as a retracted kudos' row does (routes/kudos.js). Resolves the
// ids of the people whose bell lost a row, for the caller to re-sync. A vote
// cast again after this notifies afresh: it is a new vote, and the shared
// vote limiter (rate-limits.js governanceVoteLimiter) bounds how often.
async function withdrawProposalVoteNotification(pool, { sessionId, voterId }) {
  if (!sessionId || !voterId) return [];
  const { rows } = await pool.query(
    `DELETE FROM notifications
      WHERE kind = 'proposal_vote' AND session_id = $1 AND source_user_id = $2
      RETURNING user_id`,
    [sessionId, voterId]
  );
  return [...new Set(rows.map((r) => r.user_id))];
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
// One copy, written by the proposal machine's review check
// (src/workflow/rules/proposal-notifications.ts); preferences fail open.
function createStalePrNotification(pool, { userId, appId, sessionId, detail = null }) {
  return proposalNotifications.createStalePrNotification(pool, { userId, appId, sessionId, detail },
    notificationPreferences.allowsKind);
}

// #237: staging preview failed to boot, so proposal checks can't run and the
// PR is merge-blocked. Addressed to the proposal owner (system-generated, so
// source_user_id is NULL). Same unread-dedup as session_done — at most one
// unread 'check_failed' per (user, session) — so the per-streak nudge can't
// pile up if the owner hasn't looked yet. The streak gate in
// staging-recovery.recordStagingBootFailure already limits this to once per
// failure streak; the dedup is belt-and-suspenders against re-fires.
// One copy, shared with the preview machine
// (src/workflow/rules/change-notifications.ts). #1374: allowsKind fails
// OPEN on a read error here: the quiet failure mode of this whole feature
// is a notification silently not arriving, and this one is telling
// somebody their proposal cannot merge.
function createCheckFailedNotification(pool, { userId, appId, sessionId }) {
  return changeNotifications.createCheckFailedNotification(pool, { userId, appId, sessionId },
    notificationPreferences.allowsKind);
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
// Two callers: submit_work (services/external-agent-tasks.js), and the
// promote route (routes/votes.js) when the owner's agent put the change up
// for the vote with a bearer token, as the local Homeroom CLI does (#3893).
//
// `detail` is which destination it took: 'submitted' (up for a vote) or
// 'shared' (#1347's in-progress area). Unread-deduped per session AND per
// detail, so sharing repeatedly onto the same card — which #1347 deliberately
// allows — notifies once, while a later submit of that same card still does.
// One copy (src/workflow/rules/proposal-notifications.ts): the proposal
// machine writes it when an agent puts its owner's change up for a vote.
function createConnectorSubmittedNotification(pool, { userId, appId, sessionId, detail }) {
  return proposalNotifications.createConnectorSubmittedNotification(pool, { userId, appId, sessionId, detail });
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

// #4296: errors that should not happen, counted (services/platform-incident-
// alerts.js decides when). Full admins only, no app, like platform_limit
// above. `detail` is that module's "digest:..." or "hour:<kind>:<n>" token.
//
// De-dupe: an admin who already got an alert starting `dedupePrefix` since
// `since` (today's digest; this kind's hour alert in the last hour) gets no
// second one, read or not: the promise is one digest a day and one alert per
// kind per hour.
async function createPlatformIncidentNotifications(pool, { detail, dedupePrefix, since }) {
  const token = String(detail || '').slice(0, 32);
  const prefix = String(dedupePrefix || '');
  const after = since instanceof Date ? since : new Date(since);
  if (!token || !prefix || !token.startsWith(prefix) || Number.isNaN(after.getTime())) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, source_user_id, kind, detail)
     SELECT admin.id, NULL, 'platform_incident', $1::varchar(32)
       FROM users admin
      WHERE admin.is_admin = TRUE
        AND admin.admin_readonly = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM notifications existing
           WHERE existing.user_id = admin.id
             AND existing.kind = 'platform_incident'
             AND LEFT(existing.detail, char_length($2)) = $2
             AND existing.created_at >= $3
        )
     RETURNING id, user_id, source_user_id, kind, detail, created_at`,
    [token, prefix, after],
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
    const hydrated = await hydrateNotification(pool, row.id);
    if (!hydrated) return;
    const { pushNotificationToUser } = require('./ws');
    pushNotificationToUser(hydrated.userId, { type: 'notification_new', notification: hydrated.notification });
  } catch (err) {
    log.warn('notifications', 'hydrateAndPush failed', { id: row.id, err: err.message });
  }
}

// One notification as the bell reads it, and whose it is, or null when the
// viewer may no longer see it. One read: a workflow transition calls it in
// its transaction and publishes the push itself.
async function hydrateNotification(q, id) {
  const { rows } = await q.query(
    `SELECT n.id, n.kind, n.user_id,
            CASE WHEN n.read_at IS NULL AND ${DECIDED_ASK_SETTLED_SQL}
                 THEN COALESCE(cs.merged_at, cs.archived_at, n.created_at)
                 ELSE n.read_at END AS read_at,
            n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            ${THREAD_ROOT_COLUMNS_SQL},
            ${STORY_COLUMNS_SQL},
            n.session_id,
            cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            cs.agent_session_id,
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            -- #3228: the inviter's note, read off the recipient's still-pending
            -- membership row, rides the invite row only.
            (SELECT invite_note FROM conversation_members inm
              WHERE inm.conversation_id = n.conversation_id
                AND inm.user_id = n.user_id AND inm.status = 'invited')
              AS conversation_invite_note,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            conversation_message.thread_root_id AS conversation_thread_root_id,
            su.username AS source_username,
            n.source_user_id,
            ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
            n.detail,
            pv.reason AS vote_reason,
            ${LIVE_ROW_COLUMNS_SQL}
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN conversations c ON c.id = n.conversation_id
     LEFT JOIN conversation_messages conversation_message
       ON conversation_message.id = n.conversation_message_id
     LEFT JOIN users su ON su.id = n.source_user_id
     LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
     ${FILED_MESSAGE_JOIN_SQL}
     WHERE n.id = $1 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}`,
    [id]
  );
  if (!rows.length) return null;
  return { userId: rows[0].user_id, notification: serialize(rows[0]) };
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
// One copy (src/workflow/rules/proposal-notifications.ts), written by the
// proposal machine when the proposal goes up for a vote. The audience is read
// through services/active-users.js and notification-preferences.js here, so a
// test that stubs either still reaches it.
function createPrProposedNotifications(pool, { appId, sessionId, proposerId }) {
  return proposalNotifications.createPrProposedNotifications(pool, { appId, sessionId, proposerId }, {
    activeIds: (db, id) => listActiveUserIds(db, id),
    byCategory: (db, q) => notificationPreferences.filterUsersByCategory(db, q),
  });
}

/**
 * B7: "<Name>'s change to <App> is ready to try" (kind 'change_ready'), to
 * the people whose Yes one of Homeroom bot's changes still needs
 * (homeroom-bot-dm.js needsYesFrom), from whoever asked for it. Once per
 * approval epoch (`detail`), so a new version asks again and a retry does
 * not. Its category is on by default and push-eligible.
 */
async function createChangeReadyNotifications(pool, { appId, sessionId, sourceUserId = null, recipientIds = [], epoch = 0 }) {
  if (!appId || !sessionId) return [];
  let ids = [...new Set((recipientIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (sourceUserId) ids = ids.filter((n) => n !== Number(sourceUserId));
  if (!ids.length) return [];
  ids = await notificationPreferences.filterUsersByCategory(pool, { userIds: ids, appId, categoryKey: 'changes_ready' });
  if (!ids.length) return [];
  const detail = `epoch:${Number(epoch) || 0}`;
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     SELECT u, $2, $3, $4, 'change_ready', $5::text
       FROM UNNEST($1::int[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = u AND n.session_id = $3 AND n.kind = 'change_ready' AND n.detail = $5::text
      )
        -- "One story": one ping per update. Somebody asked "Still good?"
        -- about this version (revision_recheck, same epoch) is not told
        -- again that it is ready to try.
        AND NOT EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = u AND n.session_id = $3 AND n.kind = 'revision_recheck'
           AND (n.detail = $5::text OR n.detail LIKE $5::text || ':%')
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [ids, appId, sessionId, sourceUserId || null, detail]
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

// `detail` is 'join' when the invite is to join the project (a private one,
// where being invited in is how you join it) rather than to build it
// (services/collab-invites.js); NULL otherwise, as on every row before it.
async function createCollabInviteNotification(pool, { appId, recipientId, inviterId, detail = null }) {
  if (!recipientId || !appId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, 'collab_invite', $4)
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
    [recipientId, appId, inviterId || null, detail || null]
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
//
// A collaborator invite also says what an invite link's page says
// (services/community-invites.js preview): whether it is an invitation to
// JOIN the project (`joins`: a private one, where being invited in is how
// you join; services/collab-invites.js) or only to build it, the inviter's
// note, and how many people are in it. An approver invite has none of them.
// #4740: `inCommunity` says the viewer is already one of the project's
// people (they joined through a link or the Join button while the build
// invite was still waiting), so the drawer words its meta line as "You're
// already in it" instead of a headcount the viewer is part of. FALSE for an
// approver invite, which has no community membership of its own to read.
async function listPendingInvites(pool, userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT 'collab' AS kind, ac.app_id, a.slug AS app_slug, a.name AS app_name,
            ac.created_at, inv.username AS invited_by,
            (a.view_visibility IS DISTINCT FROM 'public') AS joins,
            ac.invite_note AS note,
            (SELECT COUNT(*)::int FROM community_members m
              WHERE m.community_id = a.community_id) AS member_count,
            EXISTS (SELECT 1 FROM community_members m
              WHERE m.community_id = a.community_id AND m.user_id = $1) AS in_community
       FROM app_collaborators ac
       JOIN apps a ON a.id = ac.app_id
       LEFT JOIN users inv ON inv.id = ac.invited_by
      WHERE ac.user_id = $1 AND ac.status = 'invited'
     UNION ALL
     SELECT 'approver' AS kind, ap.app_id, a.slug AS app_slug, a.name AS app_name,
            ap.created_at, inv.username AS invited_by,
            FALSE AS joins, NULL::text AS note, NULL::int AS member_count,
            FALSE AS in_community
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
    joins: !!r.joins,
    note: r.note || null,
    memberCount: r.member_count == null ? null : Number(r.member_count),
    inCommunity: !!r.in_community,
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
//
// #4769: the drawer's Saved section reads the SAME feed query, with
// `savedOnly`: a bookmark join instead of the feed's `saved` flag, ordered
// by when each row was pinned, and without the merged-hidden clause — a
// merged change's ask was hidden from the FEED because the change behind it
// is gone, but this reader saved the row on purpose; the save is the
// instruction to keep showing it. Riding the one query keeps the saved rows
// on the same column list, ownership and hydration boundary as the feed, so
// a saved row serializes to exactly the shape the click branches route on.
//
// #5527: `unreadOnly` pages UNREAD rows only (routes/notifications.js
// `?unread=1`, the bell's Unread tab filling itself up to the badge). Its
// clause and countUnread's WHERE must stay the same set of filters — the
// two queries answer one question, "what is the bell counting", from two
// directions — so when either changes, the two MUST move together. The
// feed's own WHERE already carries everything else countUnread applies
// (CONVERSATION_ACCESS_SQL, CHAT_SENDER_ACCESS_SQL, PARKED_KINDS_SQL and
// the merged-hidden rule), which is why the clause here is only the read
// state and the settled decided-ask read.
async function listForUser(pool, userId, { limit = 100, before = null, kinds = null, savedOnly = false, unreadOnly = false } = {}) {
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
  // #5527: see the note above the function. No parameters — both halves are
  // interpolated constants, so every caller's parameter numbering is
  // untouched. read_at IS NULL is a cheap filter on the rows
  // idx_notifications_user_recent already produces, the same reasoning as
  // the kind filter above.
  // #18 (19 Oct 2026 polish board): and not a plain message, which the bell
  // leaves to the Messages tab (countUnreadSplit): what the bell counts is
  // `unread - messageUnread`, so that is what this pages.
  let unreadClause = '';
  if (unreadOnly) {
    unreadClause = `AND n.read_at IS NULL AND NOT ${DECIDED_ASK_SETTLED_SQL}
      AND NOT ${PLAIN_MESSAGE_SQL}`;
  }
  // #4795: a merged change is decided, so the rows that asked you to vote on
  // it or try it leave the list instead of staying as read entries somebody
  // taps and finds a merged page behind. `IS NOT DISTINCT FROM` so a row
  // with no session behind it (NULL cs.status) evaluates to false and is
  // kept, rather than to NULL and dropped by the NOT. The saved section
  // leaves the clause off (see the #4769 note above this function).
  // #5487: the news that the change went live (pr_merged to the author,
  // voted_change_merged to the voters) leaves with the asks, unread or read —
  // it only ever opened a merged page, and the phone push announced the
  // merge. cs.status = 'merged' also covers a change still going live
  // ('merging' is only derived in LIVE_ROW_COLUMNS_SQL). Rows with no
  // session behind it and messages people wrote are not in the kinds and
  // are never hidden; saved rows stay in the Saved section; the exact
  // lookup (a push opened) is not filtered.
  let mergedHiddenClause = '';
  if (!savedOnly) {
    params.push(MERGED_HIDDEN_KINDS);
    mergedHiddenClause = `AND NOT (n.kind = ANY($${params.length}::text[]) AND cs.status IS NOT DISTINCT FROM 'merged')`;
  }
  params.push(limit);
  const limitIdx = params.length; // last param is the limit
  const savedSelect = savedOnly
    ? `TRUE AS saved, nb.created_at AS saved_at`
    : `EXISTS (SELECT 1 FROM notification_bookmarks nb
                 WHERE nb.notification_id = n.id AND nb.user_id = $1) AS saved`;
  const savedJoin = savedOnly
    ? `JOIN notification_bookmarks nb ON nb.notification_id = n.id AND nb.user_id = $1`
    : '';
  const orderClause = savedOnly
    ? `ORDER BY nb.created_at DESC, n.id DESC`
    : `ORDER BY n.created_at DESC, n.id DESC`;
  const { rows } = await pool.query(
    `SELECT n.id, n.kind,
            CASE WHEN n.read_at IS NULL AND ${DECIDED_ASK_SETTLED_SQL}
                 THEN COALESCE(cs.merged_at, cs.archived_at, n.created_at)
                 ELSE n.read_at END AS read_at,
            n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            ${THREAD_ROOT_COLUMNS_SQL},
            ${STORY_COLUMNS_SQL},
            n.session_id,
            cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            cs.agent_session_id,
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            -- #3228: the inviter's note, read off the recipient's still-pending
            -- membership row, rides the invite row only.
            (SELECT invite_note FROM conversation_members inm
              WHERE inm.conversation_id = n.conversation_id
                AND inm.user_id = n.user_id AND inm.status = 'invited')
              AS conversation_invite_note,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            conversation_message.thread_root_id AS conversation_thread_root_id,
            su.username AS source_username,
            n.source_user_id,
            ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
            n.detail,
            pv.reason AS vote_reason,
            ${LIVE_ROW_COLUMNS_SQL},
            ${savedSelect}
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN conversations c ON c.id = n.conversation_id
     LEFT JOIN conversation_messages conversation_message
       ON conversation_message.id = n.conversation_message_id
     LEFT JOIN users su ON su.id = n.source_user_id
     LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
     ${FILED_MESSAGE_JOIN_SQL}
     ${savedJoin}
     WHERE n.user_id = $1 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}
       AND ${PARKED_KINDS_SQL}
     ${mergedHiddenClause}
     ${cursorClause}
     ${kindClause}
     ${unreadClause}
     ${orderClause}
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
    `SELECT n.id, n.kind,
            CASE WHEN n.read_at IS NULL AND ${DECIDED_ASK_SETTLED_SQL}
                 THEN COALESCE(cs.merged_at, cs.archived_at, n.created_at)
                 ELSE n.read_at END AS read_at,
            n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            ${THREAD_ROOT_COLUMNS_SQL},
            ${STORY_COLUMNS_SQL},
            n.session_id,
            cs.session_title, cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            cs.agent_session_id,
            n.conversation_id, c.kind AS conversation_kind,
            c.title AS conversation_title,
            -- #3228: the inviter's note, read off the recipient's still-pending
            -- membership row, rides the invite row only.
            (SELECT invite_note FROM conversation_members inm
              WHERE inm.conversation_id = n.conversation_id
                AND inm.user_id = n.user_id AND inm.status = 'invited')
              AS conversation_invite_note,
            n.conversation_message_id,
            conversation_message.content AS conversation_message_content,
            conversation_message.thread_root_id AS conversation_thread_root_id,
            su.username AS source_username,
            n.source_user_id,
            ${FRIEND_REQUEST_PENDING_SQL} AS friend_request_pending,
            n.detail,
            pv.reason AS vote_reason,
            ${LIVE_ROW_COLUMNS_SQL}
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
       LEFT JOIN chat_sessions cs ON cs.id = n.session_id
       LEFT JOIN conversations c ON c.id = n.conversation_id
       LEFT JOIN conversation_messages conversation_message
         ON conversation_message.id = n.conversation_message_id
       LEFT JOIN users su ON su.id = n.source_user_id
       LEFT JOIN pr_votes pv ON pv.session_id = n.session_id AND pv.user_id = n.source_user_id
       ${FILED_MESSAGE_JOIN_SQL}
      WHERE n.id = $1 AND n.user_id = $2 AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}
        AND ${PARKED_KINDS_SQL}`,
    [id, userId]
  );
  return rows[0] || null;
}

// #4769: the drawer's Saved section — this user's saved notifications,
// newest save first. It rides the feed query with `savedOnly` (see the
// note above listForUser), so a saved row serializes to exactly the shape
// the click branches route on.
async function listSavedForUser(pool, userId, { limit = notificationBookmarks.MAX_SAVED } = {}) {
  if (!userId) return [];
  return listForUser(pool, userId, { limit, savedOnly: true });
}

// Best-effort variant for the notifications payload: the drawer's saved
// section must never be the reason the whole dropdown 500s. Same contract
// as messageBookmarks.listForUserSafe.
async function listSavedForUserSafe(pool, userId, options) {
  try {
    return await listSavedForUser(pool, userId, options);
  } catch (err) {
    log.warn('notifications', 'saved notification list failed', { message: err.message });
    return [];
  }
}

async function countUnread(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications AS n
      WHERE n.user_id = $1 AND n.read_at IS NULL
        AND NOT ${DECIDED_ASK_SETTLED_SQL}
        AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}
        AND ${PARKED_KINDS_SQL}
        AND NOT (n.kind = ANY($2::text[]) AND EXISTS (
              SELECT 1 FROM chat_sessions s
               WHERE s.id = n.session_id AND s.status = 'merged'))`,
    [userId, MERGED_HIDDEN_KINDS]
  );
  return rows[0]?.c || 0;
}

// THE BELL LEAVES PLAIN MESSAGES TO THE MESSAGES TAB (#18 of the 19 Oct 2026
// polish board). One unread direct message showed as the bell's red 1, the
// Messages tab's grey 1 and a count on its row: one event, three numbers.
// #2912 kept messages in the bell on purpose, when the tab's count was new;
// with one meaning per badge now (red is the bell, grey is new to read, the
// accent is waiting on you) a message is the Messages tab's to count, and
// the bell counts what happened TO you: a mention, a reply to you, a
// thread you are in, news of your request. These two kinds are a plain
// message in a conversation or a channel and nothing more.
//
// The rows are still written (they push to a phone, and they still list in
// the bell's sheet), and `unread` still counts them: it is the home-screen
// icon's number too, which a push stamps from countUnread above. So the
// bell's figure is `unread - messageUnread`, both read in one query.
// listForUser's `unreadOnly` clause spells the same two kinds as literals.
const MESSAGE_KINDS = ['conversation_message', 'channel_message'];

async function countUnreadSplit(pool, userId) {
  const { rows } = await pool.query(
    `SELECT (COUNT(*) FILTER (WHERE ${PLAIN_MESSAGE_SQL}))::int AS m,
            COUNT(*)::int AS c FROM notifications AS n
      WHERE n.user_id = $1 AND n.read_at IS NULL
        AND NOT ${DECIDED_ASK_SETTLED_SQL}
        AND ${CONVERSATION_ACCESS_SQL} AND ${CHAT_SENDER_ACCESS_SQL}
        AND ${PARKED_KINDS_SQL}
        AND NOT (n.kind = ANY($2::text[]) AND EXISTS (
              SELECT 1 FROM chat_sessions s
               WHERE s.id = n.session_id AND s.status = 'merged'))`,
    [userId, MERGED_HIDDEN_KINDS]
  );
  return { unread: rows[0]?.c || 0, messageUnread: rows[0]?.m || 0 };
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
  // B7: and "ready to try", which asked for exactly that vote.
  vote_cast: { kinds: ['pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready'], scope: 'session_id' },
  // #2387: 'thread_reply' is a chat-actionable kind like the other three —
  // posting in the app clears it, and it lights the message's unread dot.
  // #4535: 'issue_thread_reply' joins it — posting in a request's
  // discussion reads it, so its rows clear the same way.
  message_sent: {
    kinds: ['mention', 'reply', 'reaction', 'thread_reply', 'issue_thread_reply'],
    scope: 'app_id',
  },
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

// 5 October (Page Turners): what the bell stops asking about a decided
// change, and the digests it was the last one waiting in
// (src/workflow/rules/change-notifications.ts). The merge-followups machine
// settles in its transaction and pushes what it touched itself; here,
// `push` (the default) tells everyone whose bell changed.
const { settleVoteDigests } = changeNotifications;

// #4795: the kinds whose rows are about one change and ask something about
// it, so once that change has MERGED the rows leave the bell's list instead
// of lingering as read entries somebody taps and finds a merged page behind.
// It is every ask the decision settles plus "ready to try" itself: a merged
// change is decided, so the vote it asked for is already in. A closed change
// keeps its rows in the list, where "ready to try" reads Closed.
// "One story": the requester's own "ready to try" from Homeroom bot
// (build_ready) too, once settleDecidedChange has linked it to its change.
// #5482: the remaining kinds that name a change are not asks, but tapping
// one hours later only opens the merged page too — a vote somebody cast
// (proposal_vote), testing that could not run (check_failed), the session's
// finish or stall (session_done, session_stalled), a headless run finished
// (auto_solve_done), work a connector put up (connector_submitted) and a
// spec shared privately (spec_shared). They join the list.
// #5487: so does the news that the change went live (pr_merged to its
// author, voted_change_merged to its voters), unread or read — the phone
// push announced the merge and tapping the row only opened a merged page.
// The change's own page and the hub's Recently live still say it went live;
// a saved row stays in the Saved section and a push-opened one still
// resolves through the exact lookup. Rows with no session behind them and
// messages people wrote (mention, reply, reaction, thread_reply) are not in
// this list and are never hidden.
const MERGED_HIDDEN_KINDS = Object.freeze([
  ...DECIDED_ASK_KINDS, 'change_ready', 'build_ready',
  'proposal_vote', 'check_failed', 'session_done', 'session_stalled',
  'auto_solve_done', 'connector_submitted', 'spec_shared',
  'pr_merged', 'voted_change_merged',
]);

async function settleDecidedChange(pool, sessionId, { status = null, push = true } = {}) {
  const touched = await changeNotifications.settleDecidedChange(pool, sessionId, { status });
  if (touched.length && push) {
    try {
      const { pushNotificationToUser } = require('./ws');
      for (const userId of touched) pushNotificationToUser(userId, { type: 'notifications_changed' });
    } catch (err) {
      log.warn('notifications', 'settled-change push failed', { sessionId, err: err.message });
    }
  }
  return touched;
}

/**
 * 5 October (Page Turners): message `chatMessageId` in a project's chat was
 * just filed as a request (homeroom-bot-chat.js record), seconds (a read of
 * it, or a "Suggest it") after it rang. The rows that told people about it
 * are pushed again as they read now: the joiner's first message to their
 * invite's maker ("Asked for a change", not "Said hi"), and the group's
 * discussion row whose newest message it still is ("@mo asked for a change
 * in Page Turners"). The client replaces each in place, unread or read as it
 * was; the push that rang already went. Found through the project's own
 * people, whose rows the per-user index holds. Never throws.
 */
async function refreshFiledMessage(pool, { appId, chatMessageId }) {
  const app = Number(appId);
  const message = Number(chatMessageId);
  if (!Number.isSafeInteger(app) || app <= 0 || !Number.isSafeInteger(message) || message <= 0) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT n.id FROM notifications n
        WHERE n.kind IN ('first_message', 'channel_message') AND n.chat_message_id = $2 AND n.app_id = $1
          AND n.user_id IN (SELECT m.user_id FROM apps a
                              JOIN community_members m ON m.community_id = a.community_id
                             WHERE a.id = $1)`,
      [app, message]
    );
    for (const row of rows) await hydrateAndPush(pool, row);
    return rows.length;
  } catch (err) {
    log.warn('notifications', 'filed-message refresh failed', { appId: app, err: err.message });
    return 0;
  }
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
const APP_CHAT_MESSAGE_KINDS = new Set(['mention', 'reply', 'reaction', 'thread_reply',
  // WP-E: somebody your invite brought said hi; it opens on what they said.
  'first_message',
  // A small group's discussion: it opens on the newest message it counts.
  'channel_message']);

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
    // #4417 follow-up: a reply thread that starts in one of the project's
    // topic channels opens beside that channel (THREAD_ROOT_COLUMNS_SQL).
    if (row.root_thread_type === 'category' && row.root_thread_ref != null) {
      return `#messages/app/${slug}/c/${Number(row.root_thread_ref)}/thread/${Number(row.thread_ref)}`;
    }
    return `#messages/app/${slug}/thread/${Number(row.thread_ref)}`;
  }
  if (!row.thread_type && row.chat_message_id != null) {
    return `#messages/app/${slug}/m/${Number(row.chat_message_id)}`;
  }
  // #4417: a message in one of the project's topic channels opens that
  // channel, on the message (the router takes it to the channel's place).
  if (row.thread_type === 'category' && row.thread_ref != null && row.chat_message_id != null) {
    return `#messages/app/${slug}/c/${Number(row.thread_ref)}/m/${Number(row.chat_message_id)}`;
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
  // #5580: the Homeroom bot's news about a project carries that project
  // (conversations.sendMessage's notificationAppId), so the bell files it
  // there. Only the project's name and id come through: it still routes,
  // reads and pushes as the conversation row it is.
  const botProject = isConversation && row.app_id != null && row.source_username === HOMEROOM_BOT_USERNAME;
  return {
    id: row.id,
    kind: row.kind,
    readAt: row.read_at,
    createdAt: row.created_at,
    // Fail closed if a malformed conversation row also carries legacy app
    // references: private messaging must never route through or render as an
    // app chat notification. The bot's own rows are the one exception above.
    appId: isConversation ? (botProject ? row.app_id : null) : row.app_id,
    appSlug: isConversation ? (botProject ? row.app_slug : null) : row.app_slug,
    appName: isConversation ? (botProject ? row.app_name : null) : row.app_name,
    // #5580: the request and proposal this row is about (STORY_COLUMNS_SQL),
    // which the sheet folds one story's news by. The bot's own rows name
    // their request in `detail`, or, for a reply in a request's thread, by
    // that thread's card; any other conversation row is about neither.
    storyIssueNumber: botProject
      ? (notifyCopy.parseBotDetail(row.detail)?.issueNumber || (row.bot_thread_issue_number != null ? Number(row.bot_thread_issue_number) : null))
      : (!isConversation && row.story_issue_number != null ? Number(row.story_issue_number) : null),
    storySessionId: !isConversation && row.story_session_id != null ? Number(row.story_session_id) : null,
    // The proposal's number and name, so a message in its discussion can say
    // what it is on ("on #5588").
    storyPrNumber: !isConversation && row.story_pr_number != null ? Number(row.story_pr_number) : null,
    storyTitle: !isConversation ? (row.story_title || null) : null,
    chatMessageId: isConversation ? null : row.chat_message_id,
    conversationId: isConversation ? row.conversation_id : null,
    conversationKind: isConversation ? (row.conversation_kind || null) : null,
    conversationTitle: isConversation ? (row.conversation_title || null) : null,
    // #3228: the inviter's note, on the invite row only — it is not part of
    // `detail`, which other parsers read (the hrbot prefix among them).
    conversationInviteNote: isConversation && row.kind === 'conversation_invite'
      ? (row.conversation_invite_note || null)
      : null,
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
    // 5 October: what the row's subject has become (LIVE_ROW_COLUMNS_SQL),
    // each only on the kind that reads it, so every other row's shape is
    // unchanged. Where the change a "ready to try" asked about stands now
    // ('promoted', 'merging', 'merged', 'archived', …); how many of a
    // digest's changes still wait on its reader; and the request a joiner's
    // first message, or a group's discussion message, became.
    // #5064: the rows that say a change went live read it too, so they say
    // "going live" until production runs it.
    ...(SESSION_STATUS_KINDS.has(row.kind) ? { sessionStatus: row.session_status || null } : {}),
    ...(row.kind === 'vote_digest' && row.digest_waiting != null
      ? { digestWaiting: Number(row.digest_waiting) } : {}),
    ...(row.kind === 'first_message' || row.kind === 'channel_message'
      ? { requestNumber: row.bot_request_number != null ? Number(row.bot_request_number) : null } : {}),
    // #4769: whether this row is in the user's saved set. Only the feed
    // page and the saved section select the flag (the exact lookup
    // doesn't), so it is false there — a false rather than absent keeps
    // the wire shape total. The saved section also selects WHEN the row
    // was pinned, which orders that section; the feed page never does.
    saved: !!row.saved,
    ...(row.saved_at ? { savedAt: row.saved_at } : {}),
  };
}

module.exports = {
  parseMentions,
  resolveUsers,
  createMentionNotifications,
  createReplyNotification,
  createThreadReplyNotifications,
  createIssueThreadNotifications,
  createReactionNotification,
  createStalePrNotification,
  createIssueOpenedNotifications,
  createIssueMentionNotifications,
  notifyIssueMentions,
  notifyIssueFiled,
  createProposalVoteNotification,
  withdrawProposalVoteNotification,
  createRevisionRecheckNotifications,
  createAppHealthNotification,
  createPlatformLimitNotifications,
  createPlatformIncidentNotifications,
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
  hydrateNotification,
  createPrProposedNotifications,
  createChangeReadyNotifications,
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
  listSavedForUser,
  listSavedForUserSafe,
  getForUser,
  countUnread,
  countUnreadSplit,
  MESSAGE_KINDS,
  PARKED_KINDS_SQL,
  markRead,
  markReadForSession,
  settleDecidedChange,
  settleVoteDigests,
  refreshFiledMessage,
  DECIDED_ASK_KINDS,
  MERGED_HIDDEN_KINDS,
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
  THREAD_ROOT_COLUMNS_SQL,
  FRIEND_NOTIFICATION_KINDS,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
