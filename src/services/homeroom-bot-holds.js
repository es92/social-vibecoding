'use strict';

// #3751: the Homeroom bot, mentioned on a request a person holds.
//
// The bot never competes with a person who started on a request: a live
// claim, a person's session on it or their proposal for it keeps the bot
// off it (homeroom-bot.js issueHolders, classifyIssue). #4190: a claim made
// once the bot is already on the request is not a hold: the bot finishes
// and delivers, and only a claim made before it started keeps it off.
//
// It used to keep off SILENTLY, so "@homeroom_bot try again?" on a request somebody had claimed
// three days earlier came to nothing, and the person asking could not tell
// why (Todo List #75).
//
// Now a mention on such a request gets one answer, in its discussion:
//
//   - WHO HOLDS IT, and since when: "chinchan8 claimed this request 3 days
//     ago, so Homeroom bot is leaving it to them."
//   - and THE WAY ON: "If you still want Homeroom bot to build it, mention it
//     here again and it will go ahead." A later mention does exactly that:
//     the bot says it is taking the request up, tagging whoever held it so
//     they know, and from then on treats the request as its own to work on,
//     as usual (triage, a question, a build). A hold that starts AFTER that
//     (a new claim, a session worked on since) keeps it off again.
//
// A proposal up for a vote is the exception: the bot leaves that to the vote
// and offers no way past it, since building a second proposal for the same
// request would only split it. A person who holds the request themselves and
// mentions the bot is asking it to go ahead, so it does, at once.
//
// One answer per mention, never one for a comment that does not mention the
// bot, and only on apps the bot acts on for real (the refresh calls this on
// live apps only). Mentions older than MENTION_WINDOW_HOURS are left alone,
// so nothing from before this existed is answered late.
//
// 17 Oct 2026: the refresh decides the answer; the request's place says it
// (its bot-voice machine, src/workflow/bot-voice/): the answer's row is
// written, pending, with the decision to say it, and its work says it
// (sayHeld), strictly, until it has. So a pending answer is one certain to
// be said, and `decide` reads it as said: a crash after deciding can no
// longer leave a go-ahead whose holders were never told.

const log = require('./logger');
const live = require('./homeroom-bot-live');

// The bot's posts this module writes (homeroom_bot_posts.kind).
const LEAVING_KIND = 'held_by_person';
const GOING_KIND = 'going_ahead';
const MENTION_WINDOW_HOURS = 24;

// The holds a mention can see past. A proposal up for a vote is not one. A
// `signal` is a problem the platform filed for a person to fix
// (services/platform-signals.js heldIssues).
const PASSABLE = new Set(['claim', 'session', 'signal']);

function toMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function same(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/** Pure: "3 days ago", "an hour ago", "earlier". */
function ageText(since, now = new Date()) {
  const ms = toMs(since);
  if (!ms) return 'earlier';
  const minutes = Math.max(0, Math.floor((now.getTime() - ms) / 60000));
  if (minutes < 60) return 'less than an hour ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'a day ago' : `${days} days ago`;
}

/** Pure: one hold, as a clause. */
function holdClause(hold, now) {
  const who = hold.username || 'Somebody';
  // B10a: plain words, as every shared screen says it.
  if (hold.kind === 'proposal') return `${who}'s change for it is waiting for approval`;
  if (hold.kind === 'session') return `${who} has a change in progress for it (last worked on ${ageText(hold.since, now)})`;
  if (hold.kind === 'signal') return `Homeroom filed this problem for a person to fix (${ageText(hold.since, now)})`;
  return `${who} claimed this request ${ageText(hold.since, now)}`;
}

/**
 * Pure: the people holding a request, one hold each (the most telling:
 * a proposal, then a session, then a claim), newest first.
 */
function holdsByPerson(holds) {
  const rank = { proposal: 3, session: 2, claim: 1 };
  const byName = new Map();
  for (const hold of holds) {
    const key = String(hold.username || '').toLowerCase();
    const seen = byName.get(key);
    if (!seen || (rank[hold.kind] || 0) > (rank[seen.kind] || 0)) byName.set(key, hold);
  }
  return [...byName.values()].sort((a, b) => toMs(b.since) - toMs(a.since));
}

/** Pure: what the bot says when it is leaving a request to the people holding it. */
function leavingText(holds, now = new Date()) {
  const people = holdsByPerson(holds);
  const shown = people.slice(0, 2).map((hold) => holdClause(hold, now));
  const more = people.length > 2 ? `, and ${people.length - 2} more` : '';
  // Usernames are written as they are, so the sentence may start lower case.
  const opener = shown.length ? `${shown.join(' and ')}${more}` : 'Somebody is working on this';
  if (people.some((hold) => !PASSABLE.has(hold.kind))) {
    return `${opener}, so Homeroom bot is leaving it to the vote.`;
  }
  return `${opener}, so Homeroom bot is leaving it to them. If you still want Homeroom bot to build it, `
    + 'mention it here again and it will go ahead.';
}

/** Pure: what the bot says when it goes ahead. */
function goingText({ asker, holders = [] }) {
  const tail = 'It will reply here with a question, a note or a change to vote on.';
  if (!holders.length) return `Homeroom bot is taking this up now, as asked. ${tail}`;
  return `${asker || 'Somebody'} asked Homeroom bot to build this anyway, so it is taking it up now. ${tail}`;
}

/**
 * Pure (16 Oct 2026, H4): whether a mention of the bot asks for the request
 * to be closed, or says it is done, rather than asking the bot to build it.
 * On #4572 "@Homeroom bot I think this is done, and can be closed" was read
 * as a go-ahead by its own holder, and the bot answered "I'm taking this up
 * now" and built nothing. Such a mention is left to the bot's voice, which
 * offers a vote on closing the request (homeroom-bot-voice.js
 * offer_close_request). Conservative: a mention that also asks for a build
 * ("build it", "go ahead", "take it up") is still a go-ahead.
 */
const CLOSE_WORDS = /\bclos(?:e|ed|ing)\b|\b(?:is|it's|its|was|already|been|now)\s+(?:done|fixed|shipped|resolved|merged|live)\b|\bno longer needed\b|\bnot needed any ?more\b/i;
const BUILD_WORDS = /\b(?:build|make|implement)\s+(?:it|this|that)\b|\bgo ahead\b|\btake (?:it|this) up\b|\bstart (?:on )?(?:it|this)\b/i;
function asksToClose(text) {
  const words = String(text || '');
  return CLOSE_WORDS.test(words) && !BUILD_WORDS.test(words);
}

/**
 * Pure: what to do about one request a person holds, from its holds, the
 * recent mentions of the bot in its discussion (oldest first) and the
 * bot's own answers there so far (`notes`: { kind, created_at }).
 *
 *   { action: 'clear' }            a go-ahead already covers every hold
 *   { action: 'go', mention, others }  a mention asks the bot to go ahead
 *   { action: 'leave', mention, holds } answer the mention with who holds it
 *   { action: 'none' }             nothing new to answer
 */
function decide({ holds = [], mentions = [], notes = [] }) {
  const lastOf = (kind) => notes.filter((n) => n.kind === kind).reduce((t, n) => Math.max(t, toMs(n.created_at)), 0);
  const goneAt = lastOf(GOING_KIND);
  const leftAt = lastOf(LEAVING_KIND);
  // A go-ahead covers the holds that were there when it was given.
  const active = holds.filter((hold) => !goneAt || toMs(hold.since) > goneAt);
  if (!active.length) return { action: 'clear' };
  const answeredAt = Math.max(goneAt, leftAt);
  const pending = mentions.filter((m) => toMs(m.created_at) > answeredAt);
  if (!pending.length) return { action: 'none' };
  const mention = pending[pending.length - 1];
  // A mention asking to close it is not a go-ahead: the voice answers it.
  if (asksToClose(mention.content)) return { action: 'none', closing: true };
  const others = active.filter((hold) => !same(hold.username, mention.username));
  // Holding it yourself and asking is asking it to go ahead.
  if (!others.length) return { action: 'go', mention, others };
  if (others.some((hold) => !PASSABLE.has(hold.kind))) return { action: 'leave', mention, holds: others };
  // A mention after the bot said who holds it is the "build it anyway".
  if (leftAt && leftAt > goneAt) return { action: 'go', mention, others };
  return { action: 'leave', mention, holds: others };
}

/**
 * #4530: the text of the regex a mention of the bot matches, so every place
 * that looks for one matches it identically: @homeroom_bot and @homeroombot,
 * and not @homeroom_bot_x or the tail of an email address.
 *
 * #4610: and its display name, "@Homeroom bot", which is what the composer
 * writes when a person picks the bot from its list: with a zero-width
 * character after the @ (U+200B, or a joiner) so the name does not link as
 * somebody else's handle. Used as a JavaScript RegExp and a Postgres `~*`
 * pattern alike, so the zero-width characters are literal, not escapes.
 */
const ZERO_WIDTH = '\u200b\u200c\u200d\u2060';
function mentionPattern() {
  return `(^|[^a-z0-9_])@(${live.BOT_USERNAME}|homeroombot|[${ZERO_WIDTH}]?homeroom bot)([^a-z0-9_-]|$)`;
}

/** Recent mentions of the bot by people, in the discussions of `numbers`, oldest first. */
async function recentMentions(pool, appId, numbers, { windowHours = MENTION_WINDOW_HOURS } = {}) {
  const { rows } = await pool.query(
    `SELECT m.thread_ref AS n, m.id, m.created_at, u.username, m.content
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = ANY($2::int[])
        AND m.msg_type = 'message' AND m.deleted_at IS NULL
        AND u.is_synthetic IS NOT TRUE
        AND m.content ~* $3
        AND m.created_at > NOW() - make_interval(hours => $4)
      ORDER BY m.created_at, m.id`,
    [appId, numbers, mentionPattern(), windowHours],
  );
  return rows;
}

/** The bot's answers so far on `numbers`, oldest first. */
async function answers(pool, appId, numbers) {
  const { rows } = await pool.query(
    `SELECT issue_number, kind, created_at FROM homeroom_bot_posts
      WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND kind = ANY($3::text[])
      ORDER BY created_at, id`,
    [appId, numbers, [LEAVING_KIND, GOING_KIND]],
  );
  return rows;
}

/** The people among `names` who asked the bot to stop tagging them on this request. */
async function optedOut(pool, appId, issueNumber, names) {
  if (!names.length) return new Set();
  const { rows } = await pool.query(
    `SELECT u.username FROM homeroom_bot_mention_optouts o JOIN users u ON u.id = o.user_id
      WHERE o.app_id = $1 AND o.issue_number = $2`,
    [appId, issueNumber],
  );
  return new Set(rows.map((r) => String(r.username).toLowerCase()));
}

function group(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const n = Number(row[key]);
    if (!map.has(n)) map.set(n, []);
    map.get(n).push(row);
  }
  return map;
}

/**
 * Answer the mentions of the bot on the requests people hold on one live
 * app (`holders`: issue number → holds, from issueHolders), and return the
 * numbers the bot may take up after all: the ones a go-ahead covers. Never
 * throws: a failure leaves every hold in place, as before.
 */
async function answerMentions(pool, { app, repo, github, bot, holders, deps = {}, now = new Date() }) {
  const cleared = new Set();
  try {
    const numbers = [...holders.keys()];
    if (!numbers.length || !bot?.id || !repo) return cleared;
    const [mentionRows, noteRows] = await Promise.all([
      recentMentions(pool, app.id, numbers),
      answers(pool, app.id, numbers),
    ]);
    const mentions = group(mentionRows, 'n');
    const notes = group(noteRows, 'issue_number');
    const ws = deps.ws || require('./ws');
    for (const n of numbers) {
      const verdict = decide({ holds: holders.get(n) || [], mentions: mentions.get(n) || [], notes: notes.get(n) || [] });
      if (verdict.action === 'clear') { cleared.add(n); continue; }
      if (verdict.action === 'none') continue;
      const asker = verdict.mention.username;
      const owe = deps.owe || ((args) => require('../workflow/platform.ts').heldAnswerOwed(pool, args));
      if (verdict.action === 'leave') {
        await owe({
          appId: Number(app.id), issueNumber: n, kind: LEAVING_KIND, text: leavingText(verdict.holds, now),
          mentionId: Number(verdict.mention.id), mention: asker, mentions: [],
        });
        log.info('homeroom-bot', 'Left a held request to its holders', { app: app.slug, issueNumber: n, asker });
        continue;
      }
      // Going ahead: whoever held it hears, unless they asked not to be tagged here.
      const holderNames = holdsByPerson(verdict.others).map((hold) => hold.username).filter(Boolean);
      const quiet = await optedOut(pool, app.id, n, holderNames);
      const tagged = holderNames.filter((name) => !quiet.has(name.toLowerCase()));
      await owe({
        appId: Number(app.id), issueNumber: n, kind: GOING_KIND, text: goingText({ asker, holders: holderNames }),
        mentionId: Number(verdict.mention.id), mention: null, mentions: holderNames.length ? tagged : [asker],
      });
      log.info('homeroom-bot', 'Going ahead on a held request, as asked', { app: app.slug, issueNumber: n, asker, holders: holderNames });
      cleared.add(n);
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Could not answer mentions on held requests', { app: app?.slug, err: err.message });
  }
  return cleared;
}

/**
 * Say the answer to a mention on a held request (the request's bot-voice
 * machine's `voice.post` work): its post, written pending when the answer
 * was decided, taken up and said strictly (homeroom-bot-live.js post), so a
 * retry says only what had not gone out. Throws on a failure a retry can
 * cure. Resolves { postId } or { skipped }.
 */
async function sayHeld(pool, { appId, issueNumber, kind, text, mention = null, mentions = [], deps = {} }) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [Number(appId)]);
  if (!app) return { skipped: 'gone' };
  const repo = (deps.botSvc || require('./homeroom-bot')).parseRepo(app.repo_url);
  if (!repo) return { skipped: 'no_repo' };
  const bot = await (deps.dm || require('./homeroom-bot-dm')).botAccount(pool);
  if (!bot) throw new Error('Homeroom bot is not available');
  const out = await live.post({
    pool, github: deps.github || require('./github'), ws: deps.ws || require('./ws'), app, repo, issueNumber: Number(issueNumber),
    kind, text, sender: bot, senderId: bot.id, mention, mentions, notifications: deps.notifications || null,
    strict: true, takeUpPending: true,
  });
  return { postId: out?.postId ?? null };
}

/**
 * The numbers among `holders` a go-ahead already covers (decide's 'clear'),
 * for the paths that skip held requests without answering mentions: the
 * admin's "Triage again". Never throws.
 */
async function goneAhead(pool, appId, holders) {
  const cleared = new Set();
  try {
    const numbers = [...holders.keys()];
    if (!numbers.length) return cleared;
    const notes = group(await answers(pool, appId, numbers), 'issue_number');
    for (const n of numbers) {
      if (decide({ holds: holders.get(n) || [], notes: notes.get(n) || [] }).action === 'clear') cleared.add(n);
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read go-aheads on held requests', { appId, err: err.message });
  }
  return cleared;
}

// ── A request the bot had promised, taken on by a person ────────────────
//
// 16 Oct 2026: the bot tells a requester it will build their request (it
// found it ready and waits for a free slot, or its plan waits for their
// Build it), and then a person takes it on: their own change on it, or a
// claim made before #4190's rule covers it. The bot steps aside, as above,
// and used to say nothing, so the requester went on waiting for a build that
// was never coming (#5169's card still said "I'll start when a slot frees"
// a day after it was taken). It tells them once, in their chat with it.

// Of `$2`, the requests of app `$1` people hold whose newest live run is
// that promise, still standing, with who asked for each (never a project's
// first version), and not yet told: the DM's idempotency key (TAKEN_KEY),
// looked up here so a refresh does not try again every pass. `$3` the bot.
const PROMISED_SQL = `
  SELECT q.issue_number, q.user_id, q.issue_title, u.username AS requester, r.id AS run_id
    FROM homeroom_bot_requesters q
    JOIN users u ON u.id = q.user_id
    JOIN LATERAL (
      SELECT id, verdict, cap_suppressed, awaiting_go_at, build_ok, proposal_session_id
        FROM homeroom_bot_runs
       WHERE app_id = q.app_id AND issue_number = q.issue_number AND mode = 'live'
       ORDER BY id DESC LIMIT 1
    ) r ON TRUE
   WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[]) AND q.first_version IS NOT TRUE
     AND r.verdict = 'ready' AND r.build_ok IS NULL AND r.proposal_session_id IS NULL
     AND (r.cap_suppressed IS NOT NULL OR r.awaiting_go_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM conversation_members cm
                       JOIN conversation_messages m ON m.conversation_id = cm.conversation_id
                      WHERE cm.user_id = q.user_id AND m.sender_id = $3
                        AND m.idempotency_key = 'hrbot-taken-' || q.app_id || '-' || q.issue_number || '-' || q.user_id || '-' || r.id)`;

/** The DM's idempotency key: once per person, request and promise (the run that made it). */
function takenKey(appId, issueNumber, userId, runId) {
  return `hrbot-taken-${Number(appId)}-${Number(issueNumber)}-${Number(userId)}-${Number(runId)}`;
}

/** Pure: what the bot tells the requester when somebody took on what it had promised. */
function takenText({ title, username }) {
  const what = title ? `“${String(title).slice(0, 120)}”` : 'Your request';
  const who = username ? `@${username}` : 'Somebody';
  return `${what}: ${who} has taken it on, so I'm leaving it to them. `
    + 'If you would still like me to build it, mention me on the request.';
}

/**
 * Tell each requester whose request the bot had promised and a person has
 * since taken on (`holders`: issueHolders' Map), once, and re-read their
 * tray. Who holds it is the first holder who is not the requester: a
 * requester holding their own request is not told about themselves. Live
 * apps only (the refresh calls it there). Best effort, never throws;
 * resolves how many were told.
 */
async function tellTaken(pool, { app, bot, holders, deps = {} }) {
  let told = 0;
  const numbers = [...(holders?.keys() || [])];
  if (!numbers.length || !bot?.id || !app?.id) return 0;
  try {
    const { rows } = await pool.query(PROMISED_SQL, [Number(app.id), numbers, Number(bot.id)]);
    if (!rows.length) return 0;
    const dm = deps.dm || require('./homeroom-bot-dm');
    const tray = deps.workChanged || require('./bot-work-changed');
    for (const row of rows) {
      const n = Number(row.issue_number);
      const who = (holders.get(n) || []).find((h) => h.username && !same(h.username, row.requester));
      if (!who) continue;
      const sent = await dm.sendDm(pool, {
        bot,
        userId: Number(row.user_id),
        content: takenText({ title: row.issue_title, username: who.username }),
        metadata: {
          kind: 'request_taken', appSlug: app.slug, appName: app.name || app.slug, issueNumber: n,
          requestTitle: row.issue_title || null, said: 'taken', takenBy: who.username,
        },
        idempotencyKey: takenKey(app.id, n, row.user_id, row.run_id),
      }).catch((err) => {
        log.warn('homeroom-bot', 'Could not tell a requester somebody took their request on', { app: app.slug, n, err: err.message });
        return null;
      });
      if (sent && !sent.duplicate) {
        told += 1;
        tray.noteWorkChanged(Number(row.user_id));
      }
    }
  } catch (err) {
    log.warn('homeroom-bot', 'Could not tell requesters about requests taken on', { app: app?.slug, err: err.message });
  }
  return told;
}

module.exports = {
  LEAVING_KIND,
  GOING_KIND,
  MENTION_WINDOW_HOURS,
  ageText,
  mentionPattern,
  holdsByPerson,
  leavingText,
  goingText,
  asksToClose,
  decide,
  recentMentions,
  answerMentions,
  sayHeld,
  goneAhead,
  PROMISED_SQL,
  takenKey,
  takenText,
  tellTaken,
};
