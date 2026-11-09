'use strict';

// #6228: what the bot is doing with a person's reply, as a thread can say it
// live. It reads the records that already exist (on a request its newest run
// and queue row, everywhere the bot voice's turns, the bot's own messages)
// and answers one of three states:
//
//   will_read   the bot will read the reply in a moment (the read started or
//               is queued, or the reply is new enough that its refresh sees it)
//   reading     a read of the reply is under way
//   quiet       the bot was spoken to, read the reply, and had nothing to add
//
// #6538: a place is `{ type, ref }` (ref null for the main channel), as the
// voice names it, so a change's discussion, a channel, a topic and a reply
// thread say the same thing a request's thread does. Outside a request there
// is no build stage: the state comes from the voice alone.
//
// Nothing here decides anything: the turn and the look read the same records
// they always did, and this only says out loud where they stand. It never
// throws: it is called from message handling and from the bot's own turn on
// best-effort paths.

const log = require('./logger');

const QUIET_MS = 60 * 1000;

// Every place the voice answers in (src/workflow/rules/bot-replies.ts).
const PLACE_TYPES = new Set(['session', 'issue', 'chat', 'category', 'message']);

/**
 * #6538: a place from either spelling: `{ place }`, or the request-only
 * `{ issueNumber }` the older callers still pass. Null when it names nothing
 * the voice has a place in (a governance vote's thread, say).
 */
function placeFrom({ place, issueNumber }) {
  if (place && typeof place === 'object' && place.type) {
    const type = String(place.type);
    if (!PLACE_TYPES.has(type)) return null;
    if (type === 'chat') return { type, ref: null };
    const ref = Number(place.ref);
    return Number.isInteger(ref) && ref > 0 ? { type, ref } : null;
  }
  const ref = Number(issueNumber);
  return Number.isInteger(ref) && ref > 0 ? { type: 'issue', ref } : null;
}

const ms = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure (#6228): the status a thread shows for one reply, or null when there
 * is nothing to say.
 *
 *   stage      stageOf's answer for the request ({ stage, reply, waiting })
 *   replyId    the newest person's reply in the place
 *   replyAt    when that reply was written
 *   botAfter   whether the bot posted in the place after that reply
 *   voice      the place's newest voice turns, newest first
 *   voiceOwed  whether the bot would answer that reply (gate)
 *   answerable #6538: whether the bot is answering at all here; a running
 *              turn is "reading" only then, so a turn that reads an ordinary
 *              channel message never lights the line
 *   now        the clock
 */
function statusOf({ stage = null, replyId = null, replyAt = null, botAfter = false, voice = [], voiceOwed = false, answerable = true, now = new Date() }) {
  const id = Number(replyId);
  if (!Number.isInteger(id) || id <= 0) return null;
  // The answer is there: nothing left to say about the reply.
  if (botAfter) return null;
  const turns = Array.isArray(voice) ? voice : [];
  const replyTime = ms(replyAt);
  // A turn running since the reply: the bot is reading it now.
  const running = answerable
    ? turns.find((t) => !t.finished_at && (replyTime == null || (ms(t.started_at) ?? 0) >= replyTime))
    : null;
  const reading = !!(stage && stage.stage === 'reading' && stage.reply === true && stage.waiting !== true);
  if (running || reading) return 'reading';
  // The read is queued (or about to be): the bot will read it in a moment.
  const waiting = !!(stage && stage.stage === 'reading' && stage.reply === true && stage.waiting === true);
  if (waiting || voiceOwed) return 'will_read';
  // The newest finished turn read the reply and chose not to answer, having
  // been spoken to (speaker_id), in the last minute.
  const last = turns.find((t) => t.finished_at);
  const nowMs = ms(now) ?? Date.now();
  if (last && last.outcome === 'quiet' && Number(last.speaker_id) > 0
    && Number(last.through_message_id) >= id
    && nowMs - (ms(last.finished_at) ?? 0) <= QUIET_MS) {
    return 'quiet';
  }
  return null;
}

/** Latest two voice turns of a place, newest first. */
async function voiceTurns(pool, placeKeyValue) {
  const { rows } = await pool.query(
    `SELECT started_at, finished_at, outcome, speaker_id, through_message_id
       FROM homeroom_bot_voice_turns
      WHERE place_key = $1
      ORDER BY id DESC LIMIT 2`,
    [placeKeyValue],
  );
  return rows;
}

const EMPTY_READ = Object.freeze({ status: null, replyId: null, authorId: null });

/** The newest message a person wrote in a place (a request's read is its own). */
async function newestPersonMessage(pool, appId, place) {
  const where = place.type === 'chat'
    ? 'm.thread_type IS NULL'
    : 'm.thread_type = $2 AND m.thread_ref = $3';
  const params = place.type === 'chat' ? [appId] : [appId, place.type, place.ref];
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id, m.created_at
       FROM chat_messages m JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND ${where}
        AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic IS NOT TRUE
      ORDER BY m.id DESC LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

/**
 * Whether the bot posted an answer to `replyId` in this place. A channel's
 * answer lands in the reply thread under the message, so for `chat` the
 * bot's message in that thread is the answer.
 */
async function botAnswered(pool, appId, place, replyId) {
  const { rows } = await pool.query(
    place.type === 'chat'
      ? `SELECT 1 FROM chat_messages m JOIN users u ON u.id = m.user_id
          WHERE m.app_id = $1 AND m.thread_type = 'message' AND m.thread_ref = $2
            AND m.id > $2 AND m.deleted_at IS NULL AND u.is_synthetic = TRUE
          LIMIT 1`
      : `SELECT 1 FROM chat_messages m JOIN users u ON u.id = m.user_id
          WHERE m.app_id = $1 AND m.thread_type = $2 AND m.thread_ref = $3
            AND m.id > $4 AND m.deleted_at IS NULL AND u.is_synthetic = TRUE
          LIMIT 1`,
    place.type === 'chat' ? [appId, replyId] : [appId, place.type, place.ref, replyId],
  );
  return rows.length > 0;
}

/**
 * #6538: where the bot stands in a place outside a request, from the voice
 * alone: the newest person's message, the place's turns and whether the bot
 * answered it.
 */
async function placeReadStatus(pool, appId, place, { answerable = true, now = new Date() } = {}) {
  const { placeKey } = require('./homeroom-bot-voice');
  const message = await newestPersonMessage(pool, appId, place);
  if (!message) return EMPTY_READ;
  const replyId = Number(message.id);
  const [turns, answered] = await Promise.all([
    voiceTurns(pool, placeKey(appId, place)),
    botAnswered(pool, appId, place, replyId),
  ]);
  return {
    status: statusOf({
      stage: null,
      replyId,
      replyAt: message.created_at,
      botAfter: answered,
      voice: turns,
      answerable,
      now,
    }),
    replyId,
    authorId: message.user_id == null ? null : Number(message.user_id),
  };
}

/**
 * Read where the bot stands on the newest reply in a place: `{ status,
 * replyId, authorId }`. `status` is statusOf's, or null. `place` is
 * `{ type, ref }`; `issueNumber` still names a request (`{ type: 'issue',
 * ref }`), as the older callers pass it.
 */
async function readStatus(pool, { appId, place, issueNumber, answerable = true, now = new Date() }) {
  const id = Number(appId);
  const p = placeFrom({ place, issueNumber });
  if (!Number.isInteger(id) || id <= 0 || !p) return EMPTY_READ;
  if (p.type !== 'issue') return placeReadStatus(pool, id, p, { answerable, now });
  const number = Number(p.ref);
  const progress = require('./homeroom-bot-progress');
  const { REQUEST_ROWS_SQL } = require('./homeroom-bot-track');
  const { placeKey } = require('./homeroom-bot-voice');
  const { rows } = await pool.query(REQUEST_ROWS_SQL, [id, [number]]);
  const row = rows[0];
  if (!row) return EMPTY_READ;
  const replyId = row.reply_id == null ? null : Number(row.reply_id);
  if (!replyId) return EMPTY_READ;
  const stage = progress.stageOf(row, { now });
  const [turns, after] = await Promise.all([
    voiceTurns(pool, placeKey(id, { type: 'issue', ref: number })),
    pool.query(
      `SELECT 1 FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = $2
          AND m.id > $3 AND m.deleted_at IS NULL AND u.is_synthetic = TRUE
        LIMIT 1`,
      [id, number, replyId],
    ),
  ]);
  return {
    status: statusOf({
      stage,
      replyId,
      replyAt: row.reply_at,
      botAfter: after.rows.length > 0,
      voice: turns,
      answerable,
      now,
    }),
    replyId,
    authorId: row.reply_user_id == null ? null : Number(row.reply_user_id),
  };
}

async function appRow(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url, created_by, self_hosted, community_id,
            collab_visibility, view_visibility, moderation_suspended_at
       FROM apps WHERE id = $1`,
    [Number(appId)],
  );
  return rows[0] || null;
}

async function personRow(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT id, username, is_synthetic, has_platform_access, is_admin, private_member_since
       FROM users WHERE id = $1`,
    [Number(userId)],
  );
  const u = rows[0];
  if (!u) return null;
  return {
    id: Number(u.id),
    username: u.username,
    isSynthetic: !!u.is_synthetic,
    hasPlatformAccess: !!u.has_platform_access,
    isAdmin: !!u.is_admin,
    privateMember: !u.has_platform_access && !u.is_admin && u.private_member_since != null,
  };
}

/**
 * Whether the bot would answer `messageId` in the place (the voice's own
 * gate), which tells a "nothing to add" from a message nobody wrote to it.
 * A read or a gate failure counts as false. `place` is `{ type, ref }`;
 * `issueNumber` still names a request.
 */
async function wouldAnswer(pool, { appId, place, issueNumber, messageId }) {
  try {
    const p = placeFrom({ place, issueNumber });
    if (!p) return false;
    const voice = require('./homeroom-bot-voice');
    const dm = require('./homeroom-bot-dm');
    const botSvc = require('./homeroom-bot');
    const { rows } = await pool.query(
      `SELECT m.id, m.user_id, m.content, m.msg_type, m.metadata, m.created_at, m.posted_via,
              m.thread_type, m.thread_ref, NULL::timestamptz AS deleted_at
         FROM chat_messages m WHERE m.id = $1 AND m.app_id = $2 AND m.deleted_at IS NULL`,
      [Number(messageId), Number(appId)],
    );
    const row = rows[0];
    if (!row) return false;
    const [app, bot, settings, speaker] = await Promise.all([
      appRow(pool, appId),
      dm.botAccount(pool),
      botSvc.readSettings(pool),
      personRow(pool, row.user_id),
    ]);
    if (!app || !bot) return false;
    const decided = await voice.gate(pool, { app, place: p, row, bot, settings, speaker });
    return decided.speak === true;
  } catch (err) {
    log.warn('homeroom-bot-reply-status', 'Could not tell whether the bot would answer', {
      appId, issueNumber, err: err.message,
    });
    return false;
  }
}

/**
 * Say where the bot stands on the newest reply in a place: broadcast it to
 * the project's chat sockets (and, on a request, nudge the Homeroom bot
 * page's lists for the requester and the person who replied). `place` is
 * `{ type, ref }`; `issueNumber` still names a request. Outside a request,
 * `answerable` (or the gate, when it is not given) decides whether a running
 * voice turn is the bot answering this message at all, and `skipEmpty` keeps
 * a status-less read off the wire. Best-effort: a failure is logged, never
 * thrown. Resolves the status it broadcast, or null.
 */
async function publish(pool, {
  appId, place, issueNumber, voiceOwed = false, answerable, skipEmpty = false, deps = {},
}) {
  const id = Number(appId);
  const p = placeFrom({ place, issueNumber });
  if (!Number.isInteger(id) || id <= 0 || !p) return null;
  try {
    const ws = deps.ws || require('./ws');
    let owed = answerable;
    if (p.type !== 'issue' && owed === undefined) {
      const message = await newestPersonMessage(pool, id, p);
      owed = message ? await wouldAnswer(pool, { appId: id, place: p, messageId: message.id }) : false;
    }
    const read = await readStatus(pool, {
      appId: id, place: p, answerable: owed === undefined ? true : owed,
    });
    // A reply the bot would answer, while no stage reads as waiting for it,
    // is still "will read": the refresh has not queued it yet.
    const status = read.status || (voiceOwed && read.replyId ? 'will_read' : null);
    if (skipEmpty && !status) return null;
    ws.broadcast(id, {
      type: 'bot_status',
      thread: placeOfFrame(p),
      status,
      authorId: read.authorId,
      replyId: read.replyId,
    });
    // A request's page also re-reads its track, and its requester hears.
    if (p.type !== 'issue' || !read.replyId) return status;
    const tray = deps.workChanged || require('./bot-work-changed');
    const dm = deps.dm || require('./homeroom-bot-dm');
    const people = new Set();
    try {
      const requester = await dm.requesterOf(pool, id, Number(p.ref));
      if (requester?.userId) people.add(Number(requester.userId));
      else if (requester?.id) people.add(Number(requester.id));
    } catch { /* the requester is not known: the reply's author still hears */ }
    if (read.authorId) people.add(Number(read.authorId));
    for (const userId of people) tray.noteWorkChanged(userId, { ws });
    return status;
  } catch (err) {
    log.warn('homeroom-bot-reply-status', 'Could not publish the reply status', {
      appId, issueNumber, place: p, err: err.message,
    });
    return null;
  }
}

/** The frame's `thread`: `{ type, ref }`, its ref null for the main channel. */
function placeOfFrame(place) {
  return { type: place.type, ref: place.type === 'chat' ? null : Number(place.ref) };
}

module.exports = {
  QUIET_MS,
  statusOf,
  readStatus,
  wouldAnswer,
  publish,
};
