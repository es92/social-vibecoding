'use strict';

/**
 * A PROJECT'S DISCUSSION: its #general, read as posts with replies.
 *
 * The hub's Discussion card (frontend/src/features/dev-board/workshop/
 * hub-discussion.tsx) draws a project's #general as posts: each message in
 * the channel's main stream is a post, and the reply thread under it (the
 * reply threads #2387 added) is its replies. Nothing is moved or rewritten
 * for that: a post is a main-stream message, a reply is a thread reply, and
 * both are written by the routes that wrote them before.
 *
 * ── What was said before Discussion ───────────────────────────────────
 *
 * #general was a chat until Discussion, so a busy one is hundreds of short
 * lines that were never meant as posts. The owner's rule (26 Nov 2026): a
 * channel with only a few messages from before keeps each as a post of its
 * own; with more than EARLIER_FOLD_AT of them, the whole history is one post,
 * "Earlier in #general", whose replies are those messages, oldest first.
 *
 * "Before" is the platform's `discussion_posts_since` marker
 * (src/db/reference-data.js), stamped once when Discussion arrived. This
 * module says, for one channel, how many main-stream messages people wrote
 * before it, between which dates, and the newest of them (`last_id`): a
 * reply written into "Earlier in #general" is a thread reply under that last
 * message, so it is kept in the model as every other reply is, and a reader
 * of the old chat finds it in that message's thread.
 *
 * Nothing here decides who may read the channel: the caller has already
 * checked that (routes/apps.js, the community read). The counts leave out
 * the authors the viewer blocked, as the stream itself does.
 */

/** More than this many messages from before Discussion become one post. */
const EARLIER_FOLD_AT = 8;

/** How long the marker is held before it is read again. */
const SINCE_TTL_MS = 60 * 1000;

let sinceCache = { value: null, at: 0 };

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The instant Discussion arrived, as an ISO string, or null when the marker
 * is missing (it is restored at the next boot). Held for a minute.
 */
async function discussionSince(pool) {
  if (sinceCache.at && Date.now() - sinceCache.at < SINCE_TTL_MS) return sinceCache.value;
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'discussion_posts_since'"
  );
  const value = rows[0] ? iso(String(rows[0].value).replace(/^"|"$/g, '')) : null;
  sinceCache = { value, at: Date.now() };
  return value;
}

/** For tests: forget the held marker. */
function resetDiscussionSinceForTest() {
  sinceCache = { value: null, at: 0 };
}

function shapeEarlier(row) {
  const count = Number(row && row.n) || 0;
  if (!count) return null;
  return {
    count,
    from: iso(row.first_at),
    to: iso(row.last_at),
    last_id: row.last_id == null ? null : Number(row.last_id),
  };
}

/**
 * An app channel's history from before Discussion: `{ count, from, to,
 * last_id }`, or null when there is none. Main-stream messages people wrote
 * (and spec shares, the other kind a thread may hang off), not deleted, not
 * hidden by moderation, by nobody the viewer blocked.
 */
async function earlierForApp(pool, appId, since, viewerId) {
  if (!appId || !since) return null;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at,
            MAX(m.id) AS last_id
       FROM chat_messages m
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.msg_type IN ('message', 'spec_share')
        AND m.deleted_at IS NULL
        AND m.moderation_hidden_at IS NULL
        AND m.created_at < $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.user_id
        )`,
    [appId, since, viewerId || null]
  );
  return shapeEarlier(rows[0]);
}

/** The same for a conversation channel: Homeroom's own #general. */
async function earlierForConversation(pool, conversationId, since, viewerId) {
  if (!conversationId || !since) return null;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at,
            MAX(m.id) AS last_id
       FROM conversation_messages m
      WHERE m.conversation_id = $1
        AND m.thread_root_id IS NULL
        AND m.msg_type = 'message'
        AND m.deleted_at IS NULL
        AND m.moderation_hidden_at IS NULL
        AND m.created_at < $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.sender_id
        )`,
    [conversationId, since, viewerId || null]
  );
  return shapeEarlier(rows[0]);
}

/**
 * What the community read carries for the hub's Discussion card:
 * `{ since, fold_at, earlier }`. `earlier` is the history from before
 * Discussion when there is any. Best-effort: a read that fails answers
 * `{ since, fold_at, earlier: null }`, so the card draws every message as a
 * post rather than the hub failing.
 */
async function discussionSummary(pool, { appId = null, conversationId = null, viewerId = null } = {}) {
  let since = null;
  try {
    since = await discussionSince(pool);
  } catch {
    return { since: null, fold_at: EARLIER_FOLD_AT, earlier: null };
  }
  let earlier = null;
  try {
    earlier = conversationId
      ? await earlierForConversation(pool, conversationId, since, viewerId)
      : await earlierForApp(pool, appId, since, viewerId);
  } catch {
    earlier = null;
  }
  return { since, fold_at: EARLIER_FOLD_AT, earlier };
}

// ── Most replies, across the whole room (part 2) ──────────────────────
//
// The card's "Sort by: Most replies" ranks every post since the fold, not
// only the ones a page of the stream happened to read: this answers which
// posts those are, busiest first, a page at a time, and the card reads each
// one's thread through the room's own routes (so what it draws keeps their
// shaping and their permissions). A post's count is its live replies,
// blocked people's left out as the thread leaves them out. Ties go to the
// latest activity, then the newer post.

/** The most posts one read of the ranking answers with. */
const RANKED_MAX = 20;

function shapeRanked(rows, limit) {
  return {
    posts: rows.slice(0, limit).map((r) => ({
      id: Number(r.id),
      reply_count: Number(r.reply_count) || 0,
      active_at: iso(r.active_at),
    })),
    more: rows.length > limit,
  };
}

function rankedArgs({ afterId = 0, limit = 8, offset = 0 } = {}) {
  const after = Number.isSafeInteger(Number(afterId)) && Number(afterId) > 0 ? Math.min(Number(afterId), 2147483647) : 0;
  const size = Math.min(RANKED_MAX, Math.max(1, Number(limit) || 8));
  const skip = Math.min(10000, Math.max(0, Number(offset) || 0));
  return { after, size, skip };
}

/** A project's #general (its app chat's main stream), busiest posts first. */
async function rankedInApp(pool, appId, opts = {}) {
  const { after, size, skip } = rankedArgs(opts);
  const { rows } = await pool.query(
    `SELECT m.id, COUNT(r.id)::int AS reply_count,
            GREATEST(m.created_at, COALESCE(MAX(r.created_at), m.created_at)) AS active_at
       FROM chat_messages m
       LEFT JOIN chat_messages r
         ON r.app_id = m.app_id
        AND r.thread_type = 'message' AND r.thread_ref = m.id
        AND r.deleted_at IS NULL AND r.moderation_hidden_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = r.user_id
        )
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.msg_type IN ('message', 'spec_share')
        AND m.deleted_at IS NULL
        AND m.moderation_hidden_at IS NULL
        AND m.id > $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.user_id
        )
      GROUP BY m.id
      ORDER BY reply_count DESC, active_at DESC, m.id DESC
      LIMIT $4 OFFSET $5`,
    [appId, after, opts.viewerId || null, size + 1, skip]
  );
  return shapeRanked(rows, size);
}

/** Homeroom's #general (a Messages conversation), busiest posts first. */
async function rankedInConversation(pool, conversationId, opts = {}) {
  const { after, size, skip } = rankedArgs(opts);
  const { rows } = await pool.query(
    `SELECT m.id, COUNT(r.id)::int AS reply_count,
            GREATEST(m.created_at, COALESCE(MAX(r.created_at), m.created_at)) AS active_at
       FROM conversation_messages m
       LEFT JOIN conversation_messages r
         ON r.conversation_id = m.conversation_id
        AND r.thread_root_id = m.id
        AND r.msg_type = 'message'
        AND r.deleted_at IS NULL AND r.moderation_hidden_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = r.sender_id
        )
      WHERE m.conversation_id = $1
        AND m.thread_root_id IS NULL
        AND m.msg_type = 'message'
        AND m.deleted_at IS NULL
        AND m.moderation_hidden_at IS NULL
        AND m.id > $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.sender_id
        )
      GROUP BY m.id
      ORDER BY reply_count DESC, active_at DESC, m.id DESC
      LIMIT $4 OFFSET $5`,
    [conversationId, after, opts.viewerId || null, size + 1, skip]
  );
  return shapeRanked(rows, size);
}

/** The platform's one #general conversation, Homeroom's own project's channel. */
async function generalConversationId(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM conversations
      WHERE kind = 'channel' AND channel_key = 'general' AND status = 'active'
      LIMIT 1`
  );
  return rows[0] ? Number(rows[0].id) : null;
}

module.exports = {
  EARLIER_FOLD_AT,
  RANKED_MAX,
  generalConversationId,
  rankedInApp,
  rankedInConversation,
  discussionSince,
  discussionSummary,
  earlierForApp,
  earlierForConversation,
  resetDiscussionSinceForTest,
};
