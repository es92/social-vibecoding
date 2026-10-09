'use strict';

// #4530: the Homeroom bot stays quiet on a request nobody is talking to it.
//
// Every new word on a request is a look again (classifyIssue reasons it
// 'changed'), and every look repeated its conclusion: the same question, the
// same "a person needs to decide this one", the same "couldn't find anything
// to build". On a request where people are working something out among
// themselves that was noise, and it tagged them each time.
//
// Now a look that would only repeat one of those notes speaks again only
// when the words since the bot's last note were for the bot:
//
//   - a mention of @homeroom_bot, in the discussion or on the GitHub issue;
//   - a Reply (homeroom-bot-dm wording) to one of the bot's messages there;
//   - anything written after a question the bot asked, which is taken as
//     the answer to it.
//
// When none of those happened the bot still reads and records what was said
// (the run's thread_seen_at, set with the run), so it does not read the same
// conversation over and over; it just posts nothing, and relays nothing to
// the requester's DM. The first look always speaks, and a look that
// concludes the request is ready to build still acts as before: only the
// repeat notes are held back. Never throws: when the check cannot be made
// the bot speaks as it did before this existed.
//
// The same test decides whether the bot is still waiting on people
// (waitingOn): its last note there is one of those, and nothing since was
// for it. "Ask Homeroom bot to build this" is refused then, and the
// request's card offers to answer the bot instead (routes/issues.js): the
// button used to start the same read again, which posted the same question
// again (number-guessing #52 got it three times in 35 minutes).

const log = require('./logger');
const { mentionPattern } = require('./homeroom-bot-holds');
const { OWN_STAMP_SLACK_MS } = require('./homeroom-bot-live');

// The note verdicts the gate covers (homeroom-bot.js actOnVerdict). A ready
// verdict always acts, and 'looking' is the once-per-issue announcement.
const NOTE_KINDS = Object.freeze(['question', 'person', 'empty']);

// With it, every GitHub comment the bot recorded posting on the request
// (live.post keeps each one's id): its own comments are its own by id as
// well as by login, which is read from the GitHub App's first installation
// and is not the bot's when that lookup fails or names another account.
const LAST_NOTE_SQL = `
  SELECT kind, created_at, thread_message_id,
         ARRAY(SELECT o.github_comment_id::text FROM homeroom_bot_posts o
                WHERE o.app_id = $1 AND o.issue_number = $2 AND o.github_comment_id IS NOT NULL) AS own_comment_ids
    FROM homeroom_bot_posts
   WHERE app_id = $1 AND issue_number = $2 AND kind <> 'looking'
   ORDER BY created_at DESC, id DESC LIMIT 1`;

// What people have said on the request since the bot's last note, oldest
// first. The bot's own messages and every synthetic writer are left out, so
// its own note and its later posts cannot answer themselves. A Reply is
// stored as metadata.quote.refMsgId (ws.js quote handling), joined to the
// row it quotes; quotes_bot is true when that row is one of the bot's.
const MESSAGES_SQL = `
  SELECT m.id, m.content, m.created_at, (q.user_id = $4) AS quotes_bot
    FROM chat_messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN chat_messages q
      ON (m.metadata->'quote'->>'refMsgId') ~ '^[0-9]+$'
     AND q.id = (m.metadata->'quote'->>'refMsgId')::int
   WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
     AND m.msg_type = 'message' AND m.deleted_at IS NULL
     AND u.is_synthetic IS NOT TRUE AND m.user_id <> $4
     AND m.created_at > $3
   ORDER BY m.created_at, m.id`;

// A time as milliseconds: pg hands timestamptz back as a Date.
const ms = (at) => (at instanceof Date ? at.getTime() : Date.parse(at));

/**
 * #4530: whether the GitHub issue changed since the bot's note in a way its
 * comments do not explain: its updated_at past the note and every comment
 * since it, by more than the moment GitHub takes to stamp a comment
 * (OWN_STAMP_SLACK_MS). An edit of the request, as a rule.
 */
function editedSince(lastNote, comments, updatedAt) {
  const noteMs = ms(lastNote.created_at);
  const stampMs = ms(updatedAt);
  if (!Number.isFinite(noteMs) || !Number.isFinite(stampMs)) return false;
  const explained = (comments || []).reduce((latest, c) => Math.max(latest, ms(c?.createdAt) || 0), noteMs);
  return stampMs > explained + OWN_STAMP_SLACK_MS;
}

/**
 * Pure: does anything since the bot's last note speak to the bot?
 *
 *   { speak: true,  why: 'first_note' }    the bot never posted a note here
 *   { speak: true,  why: 'not_waiting' }   (waitingOnly) its last word here
 *                                          is not one of NOTE_KINDS
 *   { speak: true,  why: 'mention' }       somebody mentioned @homeroom_bot
 *   { speak: true,  why: 'reply' }         somebody replied to its message
 *   { speak: true,  why: 'answer' }        an answer to a question it asked
 *   { speak: true,  why: 'edited' }        (waitingOnly) the request was
 *                                          edited since (editedSince)
 *   { speak: false, why: 'not_addressed' } people talking among themselves
 *
 * `messages` are the discussion rows since the note ({ body, createdAt,
 * quotesBot }); `comments` the GitHub issue's ({ author, body, createdAt,
 * id }), with its own comments skipped: by login, and by the ids it recorded
 * posting (`ownCommentIds`). Only words after the note count.
 *
 * `waitingOnly` is a look somebody asked for (Ask Homeroom bot to build
 * this): held only while the bot waits on its own note, exactly when the
 * button is refused (waitingOn), so an edit of the request (`updatedAt`,
 * the issue's) is news to it as well.
 */
function addressed({
  lastNote, messages = [], comments = [], botLogin = '', ownCommentIds = [], waitingOnly = false, updatedAt = null,
}) {
  if (!lastNote) return { speak: true, why: 'first_note' };
  if (waitingOnly && !NOTE_KINDS.includes(lastNote.kind)) return { speak: true, why: 'not_waiting' };
  const own = new Set((ownCommentIds || []).map(String));
  const sinceMs = Date.parse(lastNote.created_at);
  const since = Number.isFinite(sinceMs) ? sinceMs : 0;
  const after = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) > since;
  const mention = new RegExp(mentionPattern(), 'i');
  // The bot's GitHub login, without its [bot] suffix: a mention of it counts
  // on the issue as well, where its platform handle means nothing.
  const base = String(botLogin || '').toLowerCase().replace(/\[bot\]$/, '').trim();
  const loginMention = base
    ? new RegExp(`(^|[^a-z0-9_])@${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i')
    : null;
  const asked = lastNote.kind === 'question';
  let answered = false;
  for (const msg of messages) {
    if (!after(msg.createdAt)) continue;
    if (mention.test(String(msg.body || ''))) return { speak: true, why: 'mention' };
    if (msg.quotesBot) return { speak: true, why: 'reply' };
    answered = true;
  }
  for (const comment of comments) {
    if (!after(comment?.createdAt)) continue;
    if (comment?.id != null && own.has(String(comment.id))) continue;
    const author = String(comment?.author || '').toLowerCase().replace(/\[bot\]$/, '');
    if (base && author === base) continue;
    const body = String(comment?.body || '');
    if (mention.test(body) || (loginMention && loginMention.test(body))) return { speak: true, why: 'mention' };
    answered = true;
  }
  if (asked && answered) return { speak: true, why: 'answer' };
  if (waitingOnly && editedSince(lastNote, comments, updatedAt)) return { speak: true, why: 'edited' };
  return { speak: false, why: 'not_addressed' };
}

/** The bot's last note on a request and the words since it, for addressed(). Never throws on empty. */
async function loadAddressed(pool, { appId, issueNumber, botId }) {
  const note = await pool.query(LAST_NOTE_SQL, [appId, issueNumber]);
  const lastNote = note.rows[0] || null;
  if (!lastNote) return { lastNote: null, messages: [], ownCommentIds: [] };
  const { rows } = await pool.query(MESSAGES_SQL, [appId, issueNumber, lastNote.created_at, botId]);
  const messages = rows.map((row) => ({ body: row.content, createdAt: row.created_at, quotesBot: !!row.quotes_bot }));
  return { lastNote, messages, ownCommentIds: lastNote.own_comment_ids || [] };
}

/**
 * Combined: should the bot repeat its note on this request? The two queries
 * of loadAddressed, then addressed(). Never throws: a query that fails
 * speaks, keeping the behaviour this change found.
 */
async function shouldSpeak(pool, {
  appId, issueNumber, botId, comments = [], botLogin = '', waitingOnly = false, updatedAt = null,
}) {
  try {
    const { lastNote, messages, ownCommentIds } = await loadAddressed(pool, { appId, issueNumber, botId });
    return addressed({ lastNote, messages, comments, botLogin, ownCommentIds, waitingOnly, updatedAt });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not check whether the request addressed the bot; speaking as before', {
      appId, issueNumber, err: err.message,
    });
    return { speak: true, why: 'unknown' };
  }
}

// ── Waiting on people ────────────────────────────────────────────────────

/**
 * Pure: is the bot waiting on people here? Its last note is one of
 * NOTE_KINDS, nothing since was for it, and the request was not edited
 * since (addressed with waitingOnly, `updatedAt` the GitHub issue's).
 * Resolves { kind, messageId } (its note in the discussion, to reply to) or
 * null.
 */
function waitingOn({ lastNote, messages = [], comments = [], botLogin = '', ownCommentIds = [], updatedAt = null }) {
  if (!lastNote || !NOTE_KINDS.includes(lastNote.kind)) return null;
  if (addressed({ lastNote, messages, comments, botLogin, ownCommentIds, waitingOnly: true, updatedAt }).speak) return null;
  return { kind: lastNote.kind, messageId: Number(lastNote.thread_message_id) || null };
}

/**
 * Combined, for one request ("Ask Homeroom bot to build this",
 * homeroom-bot-dm.js askBotToBuild): waitingOn with the GitHub issue read
 * fresh and then its comments, so an answer left only on GitHub, or an edit
 * of the request, is news. GitHub is read only when the discussion leaves
 * the bot waiting. Never throws: whatever cannot be read leaves it not
 * waiting, and a look that then only repeats its note is still held by
 * actOnVerdict's gate.
 */
async function waitingOnRequest(pool, { appId, issueNumber, botId, github = null, repo = null }) {
  try {
    const { lastNote, messages, ownCommentIds } = await loadAddressed(pool, { appId, issueNumber, botId });
    if (!waitingOn({ lastNote, messages, ownCommentIds })) return null;
    if (!github || !repo) return null;
    const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, issueNumber, { fresh: true });
    if (!fetched?.issue) return null;
    // After the issue, as advanceSeen reads them: a comment that moved its
    // time is in this list.
    const read = await github.fetchIssueComments(repo.owner, repo.repo, issueNumber);
    if (!read || read.note || read.truncated) return null;
    const botLogin = await require('./homeroom-bot-live').botUsernameOf(github);
    return waitingOn({
      lastNote, messages, comments: read.comments || [], botLogin: botLogin || '', ownCommentIds,
      updatedAt: fetched.issue.updatedAt,
    });
  } catch (err) {
    log.warn('homeroom-bot', 'Could not check whether the bot is waiting on a request; not waiting', {
      appId, issueNumber, err: err.message,
    });
    return null;
  }
}

// The bot's last note on each of an app's requests, and what people said in
// each one's discussion since it, for waitingByIssue: MESSAGES_SQL for many
// requests at once.
const LAST_NOTES_SQL = `
  SELECT DISTINCT ON (issue_number) issue_number, kind, created_at, thread_message_id
    FROM homeroom_bot_posts
   WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND kind <> 'looking'
   ORDER BY issue_number, created_at DESC, id DESC`;

const MESSAGES_BY_ISSUE_SQL = `
  SELECT m.thread_ref AS issue_number, m.content, m.created_at, (q.user_id = $4) AS quotes_bot
    FROM chat_messages m
    JOIN unnest($2::int[], $3::timestamptz[]) AS s(n, since)
      ON m.thread_ref = s.n AND m.created_at > s.since
    JOIN users u ON u.id = m.user_id
    LEFT JOIN chat_messages q
      ON (m.metadata->'quote'->>'refMsgId') ~ '^[0-9]+$'
     AND q.id = (m.metadata->'quote'->>'refMsgId')::int
   WHERE m.app_id = $1 AND m.thread_type = 'issue'
     AND m.msg_type = 'message' AND m.deleted_at IS NULL
     AND u.is_synthetic IS NOT TRUE AND m.user_id <> $4
   ORDER BY m.created_at, m.id`;

/**
 * For the request list and a request's page (routes/issues.js
 * `botAwaits`): which of `issues` ({ number, updatedAt }) the bot is
 * waiting on, Map(number → { kind, messageId }). From the discussion and the
 * issue's updated_at alone, as the list reads no comments: a request whose
 * GitHub issue moved since the note keeps its Ask button, and the button
 * reads the comments (waitingOnRequest). Two queries for the whole list.
 * Never throws.
 */
async function waitingByIssue(pool, { appId, botId, issues = [] }) {
  const out = new Map();
  try {
    const byNumber = new Map();
    for (const issue of issues || []) {
      const n = Number(issue?.number);
      if (Number.isInteger(n) && n > 0) byNumber.set(n, issue);
    }
    if (!botId || !byNumber.size) return out;
    const { rows: notes } = await pool.query(LAST_NOTES_SQL, [appId, [...byNumber.keys()]]);
    const noted = notes.filter((row) => NOTE_KINDS.includes(row.kind));
    if (!noted.length) return out;
    const { rows } = await pool.query(MESSAGES_BY_ISSUE_SQL, [
      appId, noted.map((row) => Number(row.issue_number)), noted.map((row) => row.created_at), botId,
    ]);
    const said = new Map();
    for (const row of rows) {
      const n = Number(row.issue_number);
      if (!said.has(n)) said.set(n, []);
      said.get(n).push({ body: row.content, createdAt: row.created_at, quotesBot: !!row.quotes_bot });
    }
    for (const note of noted) {
      const n = Number(note.issue_number);
      const waiting = waitingOn({ lastNote: note, messages: said.get(n) || [], updatedAt: byNumber.get(n)?.updatedAt || null });
      if (waiting) out.set(n, waiting);
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read which requests the bot is waiting on', { appId, err: err.message });
  }
  return out;
}

module.exports = {
  NOTE_KINDS,
  addressed,
  loadAddressed,
  shouldSpeak,
  waitingOn,
  waitingOnRequest,
  waitingByIssue,
};
