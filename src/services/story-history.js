'use strict';

// #5580: what happened on the request or proposal a bell notification is
// about, for the history a card in the Notifications sheet opens to.
//
// There is no timeline table to read: a request's and a proposal's story is
// their Discussion threads (chat_messages, thread_type 'issue' / 'session'),
// where the platform writes its own lines (votes, a promote, an update that
// cleared votes, going live, a withdrawal, a plan) beside what people said.
// So the history is those threads, newest first: the request's own, and the
// threads of every proposal made from it or linking it. Each line becomes a
// typed step the sheet words itself. The lines the platform writes carry
// their meaning in metadata where they have it (a vote, an update, a merge,
// a plan) and in their text where they do not (who voted, a request filed);
// the patterns below are the ones the Discussion view reads them by
// (public/js/group-chat.js _threadEvent).

const { parkedSystemLineSql } = require('./kudos-parked');
const notifyCopy = require('./homeroom-bot-notify-copy');

const MAX_STEPS = 40;
const MAX_WORDS = 140;
const MAX_SESSIONS = 10;

// Lines that say the platform is working, not that anything happened.
const NOISE_RES = [
  /staging preview/i,
  /automated checks (are|run)/i,
  /\bis being built\b/i,
];

function clip(text, max = MAX_WORDS) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

// One Discussion line as a step, or null when it says nothing a history
// needs. `actor` is a username (or null for the platform); the sheet says
// "You" when it is the viewer.
function stepOf(row) {
  const at = row.created_at;
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const text = String(row.content || '');
  const by = row.username || null;
  if (meta.merged) return { at, kind: 'live' };
  if (meta.headChanged) return { at, kind: 'updated' };
  if (meta.voteRetracted) {
    const m = /^(\S+) took back their vote/.exec(text);
    return { at, kind: 'vote_taken_back', actor: m ? m[1] : null };
  }
  if (row.msg_type === 'vote') {
    const voted = /^(\S+) voted (yes|no)\b/.exec(text);
    if (voted) {
      const reason = meta.vote && typeof meta.vote.reason === 'string' ? clip(meta.vote.reason) : '';
      return { at, kind: 'vote', actor: voted[1], vote: voted[2], ...(reason ? { words: reason } : {}) };
    }
    const promoted = /^(\S+) promoted /.exec(text);
    if (promoted) return { at, kind: 'proposed', actor: promoted[1] };
  }
  if (row.msg_type === 'spec_share') {
    const title = meta.specShare && typeof meta.specShare.title === 'string' ? clip(meta.specShare.title) : '';
    return { at, kind: 'plan', actor: by, ...(title ? { words: title } : {}) };
  }
  if (row.msg_type === 'system' || !row.user_id) {
    if (NOISE_RES.some((re) => re.test(text))) return null;
    const asked = /^(\S+) created issue:/.exec(text);
    if (asked) return { at, kind: 'asked', actor: asked[1] };
    const closing = /^(\S+) proposed closing issue/.exec(text);
    if (closing) return { at, kind: 'close_proposed', actor: closing[1] };
    if (/closed by group vote/i.test(text)) return { at, kind: 'closed' };
    if (/\bwithdrew\b|\bwas withdrawn\b/i.test(text)) return { at, kind: 'withdrawn' };
    return { at, kind: 'note', words: clip(text) };
  }
  const words = clip(text);
  if (!words) return null;
  return { at, kind: 'comment', actor: by, words };
}

// The request and proposal a notification row is about: the story columns
// the bell's reads select (notifications.js STORY_COLUMNS_SQL), else the
// request number the bot's own rows and the request kinds carry in
// `detail`, else, for the bot's reply in a request's thread, that thread's
// request.
async function storyOf(_pool, row) {
  let issueNumber = positiveInt(row.story_issue_number);
  const sessionId = positiveInt(row.story_session_id);
  if (!issueNumber) {
    const bot = notifyCopy.parseBotDetail(row.detail);
    if (bot && bot.issueNumber) issueNumber = bot.issueNumber;
  }
  if (!issueNumber && ['issue_opened', 'issue_mention', 'issue_thread_reply'].includes(row.kind)
      && /^\d+$/.test(String(row.detail || ''))) {
    issueNumber = positiveInt(row.detail);
  }
  if (!issueNumber) issueNumber = positiveInt(row.bot_thread_issue_number);
  return { issueNumber, sessionId };
}

// The history itself: { issueNumber, sessionIds, steps } with steps newest
// first, or null when the row is about no request or proposal.
async function historyFor(pool, { appId, issueNumber = null, sessionId = null }) {
  if (!appId || (!issueNumber && !sessionId)) return null;
  let issue = issueNumber;
  const sessions = new Set(sessionId ? [sessionId] : []);
  if (!issue && sessionId) {
    // A proposal's story is its request's too: the one it was made from, or
    // the first it links.
    const { rows: [s] = [] } = await pool.query(
      `SELECT COALESCE(created_from_issue_number, linked_issues[1]) AS issue
         FROM chat_sessions WHERE id = $1 AND app_id = $2`,
      [sessionId, appId],
    );
    issue = s ? positiveInt(s.issue) : null;
  }
  if (issue) {
    const { rows } = await pool.query(
      `SELECT id FROM chat_sessions
        WHERE app_id = $1 AND (created_from_issue_number = $2 OR $2 = ANY(linked_issues))
        ORDER BY id DESC LIMIT ${MAX_SESSIONS}`,
      [appId, issue],
    );
    for (const s of rows) sessions.add(Number(s.id));
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata, m.created_at
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1
        AND ((m.thread_type = 'issue' AND m.thread_ref = $2)
          OR (m.thread_type = 'session' AND m.thread_ref = ANY($3::int[])))
        AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL
        AND ${parkedSystemLineSql('m')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${MAX_STEPS * 2}`,
    [appId, issue || 0, [...sessions]],
  );
  const steps = rows.map(stepOf).filter(Boolean).slice(0, MAX_STEPS);
  return { issueNumber: issue || null, sessionIds: [...sessions], steps };
}

module.exports = { historyFor, storyOf, stepOf, MAX_STEPS };
