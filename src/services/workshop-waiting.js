'use strict';

// #4772: what Homeroom bot is waiting on ONE viewer for, on one project, for
// the Workshop tab's "Waiting on you" (AppView._workshopView). Three kinds:
//
//   - plans: the bot's plan for a request of theirs (homeroom_bot_requesters)
//     that waits for their Build it: the request's newest run has
//     awaiting_go_at set and nothing built from it yet, the same reading
//     homeroom-bot-progress.js stageOf calls the 'plan' stage. A plan nobody
//     taps for a week stops waiting (homeroom-bot.js settleStalePlans), and
//     then it is not listed.
//   - questions: a question the bot asked them in their DM about a request
//     that is still open (homeroom_bot_dm_messages.question_status). A
//     question on the request's own discussion rides the request list as
//     `botAwaits` already (homeroom-bot-addressed.js waitingOn).
//   - talks: a change or a request whose discussion has messages from both
//     the viewer and the bot, the last of them within TALK_DAYS: a back and
//     forth they are in. `botLast` says who spoke last.
//
// Only the viewer's own: every row is a request recorded as theirs, a
// question asked of them, or a thread they wrote in. Never throws: a read
// that fails is nothing waiting, never a failed board.

const log = require('./logger');

/** How recent a back and forth with the bot must be to be listed. */
const TALK_DAYS = 3;
/** The most of each kind one answer carries. */
const MAX_EACH = 10;

const PLANS_SQL = `
  SELECT q.issue_number, run.awaiting_go_at AS at
    FROM homeroom_bot_requesters q
    JOIN LATERAL (
      SELECT awaiting_go_at, build_ok, build_session_id, proposal_session_id
        FROM homeroom_bot_runs
       WHERE app_id = q.app_id AND issue_number = q.issue_number
       ORDER BY id DESC LIMIT 1
    ) run ON TRUE
   WHERE q.app_id = $1 AND q.user_id = $2
     AND run.awaiting_go_at IS NOT NULL AND run.build_ok IS NULL
     AND run.build_session_id IS NULL AND run.proposal_session_id IS NULL
   ORDER BY run.awaiting_go_at DESC
   LIMIT $3`;

const QUESTIONS_SQL = `
  SELECT issue_number, MAX(created_at) AS at
    FROM homeroom_bot_dm_messages
   WHERE app_id = $1 AND user_id = $2 AND question_status = 'open'
   GROUP BY issue_number
   ORDER BY at DESC
   LIMIT $3`;

// Both sides' newest message in each change's or request's own discussion.
// A change counts while it is open (being built, paused, up for a vote or
// going in); a request's state is the client's to read off its list.
const TALKS_SQL = `
  WITH talk AS (
    SELECT m.thread_type, m.thread_ref,
           MAX(m.created_at) FILTER (WHERE m.user_id = $2) AS mine_at,
           MAX(m.created_at) FILTER (WHERE m.user_id = $3) AS bot_at
      FROM chat_messages m
     WHERE m.app_id = $1 AND m.thread_type IN ('session', 'issue')
       AND m.msg_type = 'message'
       AND m.deleted_at IS NULL AND m.moderation_hidden_at IS NULL
       AND m.user_id IN ($2, $3)
       AND m.created_at > NOW() - make_interval(days => $4)
     GROUP BY m.thread_type, m.thread_ref
  )
  SELECT t.thread_type, t.thread_ref, GREATEST(t.mine_at, t.bot_at) AS at, (t.bot_at >= t.mine_at) AS bot_last
    FROM talk t
    LEFT JOIN chat_sessions cs ON t.thread_type = 'session' AND cs.id = t.thread_ref AND cs.app_id = $1
   WHERE t.mine_at IS NOT NULL AND t.bot_at IS NOT NULL
     AND (t.thread_type = 'issue' OR cs.status IN ('active', 'paused', 'promoted', 'merging'))
   ORDER BY at DESC
   LIMIT $5`;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);

/** Nothing waiting. */
function none() {
  return { plans: [], questions: [], talks: [] };
}

/**
 * What the bot waits on `userId` for on `appId` ({ plans, questions, talks },
 * newest first). `botId` is the bot's account (homeroom-bot-dm.js
 * botAccount); without it, or for the bot itself, there are no talks.
 */
async function waitingOnViewer(pool, { appId, userId, botId = null }) {
  const out = none();
  if (!appId || !userId) return out;
  try {
    const { rows: plans } = await pool.query(PLANS_SQL, [appId, userId, MAX_EACH]);
    out.plans = plans.map((r) => ({ number: Number(r.issue_number), at: iso(r.at) }));
    const { rows: questions } = await pool.query(QUESTIONS_SQL, [appId, userId, MAX_EACH]);
    out.questions = questions.map((r) => ({ number: Number(r.issue_number), at: iso(r.at) }));
    if (botId && Number(botId) !== Number(userId)) {
      const { rows: talks } = await pool.query(TALKS_SQL, [appId, userId, botId, TALK_DAYS, MAX_EACH]);
      out.talks = talks.map((r) => ({
        type: r.thread_type === 'issue' ? 'issue' : 'session',
        ref: Number(r.thread_ref),
        at: iso(r.at),
        botLast: !!r.bot_last,
      }));
    }
  } catch (err) {
    log.warn('workshop', 'Could not read what Homeroom bot waits on the viewer for', { appId, err: err.message });
    return none();
  }
  return out;
}

/**
 * The ?demo=1 staging answer (routes/issues.js): one of each on the mock
 * requests, so the Workshop's Waiting on you is reviewable in a preview. A
 * plan on 900016, a question on 900015, and a back and forth on 900002, in
 * which Homeroom bot spoke last.
 */
function demoWaiting(now = Date.now()) {
  const ago = (h) => new Date(now - h * 3600 * 1000).toISOString();
  return {
    plans: [{ number: 900016, at: ago(1) }],
    questions: [{ number: 900015, at: ago(3) }],
    talks: [{ type: 'issue', ref: 900002, at: ago(2), botLast: true }],
  };
}

module.exports = { TALK_DAYS, MAX_EACH, waitingOnViewer, demoWaiting, PLANS_SQL, QUESTIONS_SQL, TALKS_SQL };
