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

const log = require('./logger');
const live = require('./homeroom-bot-live');

// The bot's posts this module writes (homeroom_bot_posts.kind).
const LEAVING_KIND = 'held_by_person';
const GOING_KIND = 'going_ahead';
const MENTION_WINDOW_HOURS = 24;

// The holds a mention can see past. A proposal up for a vote is not one.
const PASSABLE = new Set(['claim', 'session']);

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
  const tail = 'It will reply here with a question, a note or a proposal.';
  if (!holders.length) return `Homeroom bot is taking this up now, as asked. ${tail}`;
  return `${asker || 'Somebody'} asked Homeroom bot to build this anyway, so it is taking it up now. ${tail}`;
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
 * that looks for one matches it identically: @homeroom_bot, and not
 * @homeroom_bot_x or the tail of an email address.
 *
 * #4610: and its display name, "@Homeroom bot", which is what the composer
 * writes when a person picks the bot from its list: with a zero-width
 * character after the @ (U+200B, or a joiner) so the name does not link as
 * somebody else's handle. Used as a JavaScript RegExp and a Postgres `~*`
 * pattern alike, so the zero-width characters are literal, not escapes.
 */
const ZERO_WIDTH = '\u200b\u200c\u200d\u2060';
function mentionPattern() {
  return `(^|[^a-z0-9_])@(${live.BOT_USERNAME}|[${ZERO_WIDTH}]?homeroom bot)([^a-z0-9_-]|$)`;
}

/** Recent mentions of the bot by people, in the discussions of `numbers`, oldest first. */
async function recentMentions(pool, appId, numbers, { windowHours = MENTION_WINDOW_HOURS } = {}) {
  const { rows } = await pool.query(
    `SELECT m.thread_ref AS n, m.id, m.created_at, u.username
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
      if (verdict.action === 'leave') {
        await live.post({
          pool, github, ws, app, repo, issueNumber: n, kind: LEAVING_KIND,
          text: leavingText(verdict.holds, now), sender: bot, senderId: bot.id, mention: asker,
          notifications: deps.notifications || null,
        });
        log.info('homeroom-bot', 'Left a held request to its holders', { app: app.slug, issueNumber: n, asker });
        continue;
      }
      // Going ahead: whoever held it hears, unless they asked not to be tagged here.
      const holderNames = holdsByPerson(verdict.others).map((hold) => hold.username).filter(Boolean);
      const quiet = await optedOut(pool, app.id, n, holderNames);
      const tagged = holderNames.filter((name) => !quiet.has(name.toLowerCase()));
      await live.post({
        pool, github, ws, app, repo, issueNumber: n, kind: GOING_KIND,
        text: goingText({ asker, holders: holderNames }), sender: bot, senderId: bot.id,
        mentions: holderNames.length ? tagged : [asker], notifications: deps.notifications || null,
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

module.exports = {
  LEAVING_KIND,
  GOING_KIND,
  MENTION_WINDOW_HOURS,
  ageText,
  mentionPattern,
  holdsByPerson,
  leavingText,
  goingText,
  decide,
  recentMentions,
  answerMentions,
  goneAhead,
};
