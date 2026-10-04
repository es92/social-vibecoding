'use strict';

// #3736: activity cards in a person's DM with the Homeroom bot.
//
// Like a live activity on a phone: when the bot starts a piece of work for
// somebody, ONE card appears in their DM at that point in the conversation
// and follows that work in place (the step it is at, how long it has taken,
// where to open it) until it ends: a proposal up for a vote, a question
// asked, a hand-off to the group, a build that failed. The person can go on
// writing below it. The activity tray pinned above the transcript
// (homeroom-bot-tray.js) stays what it is: everything at once, and history.
//
// THE CARD IS A MESSAGE. The bot sends it when it starts reading a request
// of theirs (homeroom-bot.js runTriage, beside its "looking into it" post on
// the request, and skipped where that post is), so it sits in the
// transcript where the work began. Its words say what it is about, for the
// inbox preview, the bell and anything that does not draw the card; its
// structured part (`metadata.homeroomBot`, kind 'activity') names the
// request, which the client draws the card from
// (frontend/src/features/messages/bot-activity.tsx). It is recorded in
// homeroom_bot_dm_messages like the bot's other news about a request, so a
// reply quoting it is about that request, as a reply to any of them is.
//
// ONE PER REQUEST (B4). A piece of work is one look at a request, from the
// queue row it was claimed from to what came of it, and that row keys the
// card the first look sends. The next look at the same request (after an
// answer, a restart, a re-read) carries on in the SAME card rather than
// starting another further down (continueCard): the card's `lookAt` moves
// to when that look began, so it is read from then, and nothing new is sent,
// so nothing rings and the inbox keeps its order. Before, an answered
// question left a card saying "Needs you" above a second card reading on.
// The card stays where it first appeared; the tray above the transcript and
// the card itself show where the request is now. The bot's follow-ups on a
// proposal already up for a vote start no look (they return before the
// "looking" post): they answer what the group said on the proposal.
//
// WHAT IT SAYS IS READ, NEVER WRITTEN. Nothing updates a card as the work
// moves on; `cardsFor` reads each card's state from the platform's own
// records whenever it is asked:
//
//   - its OUTCOME is the first live run on the request after the card began
//     (and before the next card on the same request began): its verdict, and
//     for a build, the proposal it opened or the build that did not finish;
//   - with no outcome yet it is in progress, and how far along is
//     `progressFor`'s (homeroom-bot-progress.js), the derivation the bot
//     answers "how far along are you?" with: step N of M, what it is doing;
//   - with neither, nothing about it is in progress any more: it stopped.
//
// LIVE: the client reads it again on the events the tray reads on: the
// bot's news landing in the DM, and `homeroom_bot_work_changed` when the
// loop starts or ends work for this person.
//
// WORK ALREADY UNDER WAY (catchUpCards). The loop sends a card only when a
// look starts, beside its "looking" post, so some of the bot's work never
// had one: work that started before cards existed, a restart's second look
// at work that had none, a backlog pass that went on to build. The tray
// showed it and the transcript did not. When the person opens the DM, the
// client asks (POST, nothing in it) for every piece of their work that is
// under way, as the tray reads it, and has no card to get one, at the end
// of the transcript, saying it was started earlier. It is the same card:
// the same key for a look being read as the loop's own (so the two are one
// message), and the moment the work began in its metadata (`startedAt`), so
// the card is read from then and finds the run the work already has.
// Work that has a card, a restart of that look included, gets no second.
//
// ONE PERSON'S, ALWAYS. Every row is read by the signed-in person's own id:
// the route takes no user, conversation or message parameter. An app they
// can no longer view is left out, whatever the records say.

const log = require('./logger');
const appAccess = require('./app-access');
const { HOMEROOM_BOT_CARDS_LOCK } = require('./advisory-locks');

const KIND = 'activity';
// The most cards one read answers for, newest first. An older card keeps
// what its message says.
const MAX_CARDS = 30;

// A proposal people can open (the same states as homeroom-bot-tray.js).
const OPENABLE_PROPOSAL = new Set(['promoted', 'merging', 'merged']);

// What a card's piece of work came to. The client words each one.
const OUTCOMES = Object.freeze([
  'question', 'proposed', 'live', 'closed', 'blocked', 'build_failed',
  'person', 'empty', 'failed', 'held', 'stopped', 'answer', 'revise',
]);

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function settingsModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function progressModule(deps) { return deps.progress || require('./homeroom-bot-progress'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function issueHref(slug, issueNumber) {
  return `#app/${encodeURIComponent(slug)}/dev/issues/${Number(issueNumber)}`;
}

function proposalHref(slug, sessionId) {
  return `#app/${encodeURIComponent(slug)}/dev/proposals/${Number(sessionId)}`;
}

// ── Starting a card ──

/**
 * Pure: a card's words, for whatever does not draw the card itself. A card
 * `joined` to work already under way (catchUpCards) lands at the end of the
 * DM, after the work began, so it says the work was started earlier. A card
 * started by filing the request (#3767) says it was filed, not that the
 * work began: it may wait in the queue first, and the card says so.
 */
function cardText({ appName, issueNumber, issueTitle, firstVersion }, dm, {
  joined = false, filed = false, queued = false, lowAllowance = false,
} = {}) {
  const line = dm.requestLine({ appName, issueNumber, issueTitle, firstVersion });
  // The one place the weekly limit is mentioned before it is reached: under
  // a fifth of the week's building time left (dm.allowanceLow).
  const low = lowAllowance ? '\n\nYou\'re close to this week\'s building time.' : '';
  if (filed) return `${line}\n\nFiled. This card follows it from here.${low}`;
  // Started when the request is queued, before anything has begun on it
  // (homeroom-bot.js refreshApp): waiting is said, not left silent.
  if (queued) return `${line}\n\nWaiting for a free builder. This card follows it from here.${low}`;
  const it = firstVersion ? 'the first version' : 'this';
  return joined
    ? `${line}\n\nI started on ${it} earlier and I'm still working on it. This card updates as I go.`
    : `${line}\n\nI'm working on ${it} now. This card updates as I go.${low}`;
}

/** The key the card that follows one queue row's look is sent with. */
function jobCardKey(jobKey) {
  return `hrbot-activity-${jobKey}`;
}

/**
 * Send one card to `requester` (somebody the bot talks to in a DM) about
 * `issueNumber` on `app`, with `key`. `startedAt`, for a card that joins
 * work already under way, is when that work began: the card is read from
 * then (cardRows). Resolves what sendDm did, or null.
 */
async function sendCard(pool, {
  app, issueNumber, requester, bot, key, startedAt = null, filed = false, queued = false, lowAllowance = false, dm,
}) {
  const context = {
    appName: app.name || app.slug,
    issueNumber,
    issueTitle: requester.issueTitle || null,
    firstVersion: !!requester.firstVersion,
  };
  return dm.sendDm(pool, {
    bot,
    userId: requester.userId,
    content: cardText(context, dm, { joined: !!startedAt, filed, queued, lowAllowance }),
    metadata: {
      kind: KIND,
      appSlug: app.slug,
      appName: context.appName,
      issueNumber,
      ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
      ...(context.firstVersion ? { firstVersion: true } : {}),
      // B4: what they asked for, in their own words, which the card leads with.
      ...(typeof dm.askedLine === 'function' && dm.askedLine(requester.askedText)
        ? { askedText: dm.askedLine(requester.askedText) } : {}),
      // B3: a reply to it stays in the DM, for the bot to read: a card is
      // progress, not a question (homeroom-bot-dm.js MIRRORED_KINDS).
      ...(startedAt ? { startedAt } : {}),
    },
    idempotencyKey: key,
    // #3707: news about a request they started in the DM points back at it.
    replyToId: await dm.requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
  });
}

/** Record a sent card as the bot's news about its request, once. */
async function recordCard(pool, sent, { userId, appId, issueNumber }) {
  await pool.query(
    `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (message_id) DO NOTHING`,
    [sent.messageId, userId, sent.conversationId, appId, issueNumber, KIND],
  );
}

/**
 * B4: the card that already follows one of `userId`'s requests, its newest
 * still in the DM: { messageId, conversationId, lookAt }, or null.
 */
async function requestCard(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, m.metadata->'homeroomBot'->>'lookAt' AS look_at
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = 'activity'
      ORDER BY d.message_id DESC LIMIT 1`,
    [userId, appId, issueNumber],
  );
  if (!rows[0]) return null;
  return { messageId: Number(rows[0].message_id), conversationId: Number(rows[0].conversation_id) || null, lookAt: rows[0].look_at || null };
}

/**
 * B4: a new look at a request carries on in the card that already follows
 * it: its `lookAt` moves forward to when the look began (`lookAt`, now by
 * default), and every device reading the card hears it changed. Never moves
 * it back. Resolves the card as startCard does: { messageId, conversationId,
 * duplicate: true, continued: true }.
 */
async function continueCard(pool, card, { userId, lookAt = null, dm }) {
  const at = iso(lookAt) || new Date().toISOString();
  if ((!card.lookAt || card.lookAt < at) && typeof dm.setQuestionState === 'function') {
    await dm.setQuestionState(pool, card.messageId, { lookAt: at }, { conversationId: card.conversationId, userId });
  }
  return { messageId: card.messageId, conversationId: card.conversationId, duplicate: true, continued: true };
}

/**
 * The bot started a piece of work on one of `requester`'s requests: their
 * card, in their DM with it, when they are somebody it talks to there.
 * B4: a request that already has a card carries on in it (continueCard).
 * `jobKey` is the queue row the work was claimed from. #3767: a request
 * filed from the DM gets its card when it is filed (`filed`), under the key
 * the work will start from, so the start finds it already sent. A request
 * queued by the refresh gets its card then (`queued`), the same way, so the
 * wait before a builder is free is on the card rather than silent. Never
 * throws: a card that could not be sent costs the work nothing. Resolves
 * what sendDm did, or null.
 */
async function startCard(pool, { app, issueNumber, requester, bot, jobKey, settings = null, filed = false, queued = false, deps = {} }) {
  try {
    const n = Number(issueNumber);
    if (!app?.id || !bot?.id || !requester?.userId || !Number.isInteger(n) || n <= 0 || !jobKey) return null;
    const dm = dmModule(deps);
    const s = settings || await settingsModule(deps).readSettings(pool);
    if (!dm.hasBot(s, requester)) return null;
    const existing = await requestCard(pool, { userId: requester.userId, appId: app.id, issueNumber: n });
    if (existing) {
      // WP1 (#9): a build still waiting its turn or running is what the card
      // follows until it ends, whatever look began after it.
      const row = (await cardRows(pool, requester.userId)).find((r) => Number(r.message_id) === existing.messageId);
      if (row && !outcomeOf(row) && buildUnderWay(row)) {
        return { messageId: existing.messageId, conversationId: existing.conversationId, duplicate: true, continued: true };
      }
      return await continueCard(pool, existing, { userId: requester.userId, dm });
    }
    const lowAllowance = typeof dm.allowanceLow === 'function'
      ? await dm.allowanceLow(pool, s, requester.userId).catch(() => false) : false;
    const sent = await sendCard(pool, {
      app, issueNumber: n, requester, bot, key: jobCardKey(jobKey), filed, queued, lowAllowance, dm,
    });
    if (!sent?.messageId || sent.duplicate) return sent || null;
    await recordCard(pool, sent, { userId: requester.userId, appId: app.id, issueNumber: n });
    log.info('homeroom-bot-activity', 'Started an activity card', { app: app.slug, issueNumber: n, userId: requester.userId, filed, queued });
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-activity', 'Could not start an activity card', {
      app: app?.slug, issueNumber, userId: requester?.userId, err: err.message,
    });
    return null;
  }
}

// ── Reading the cards ──

/**
 * Pure: what one card's piece of work came to, from the first live run
 * after it began (the run_* columns of cardRows), or null while it is
 * still going: no run yet, or a build not finished.
 */
function outcomeOf(row) {
  if (!row.run_id) return null;
  // Held back by a cap: nothing was said or built, and a later look (a card
  // of its own) takes it up when there is room.
  if (row.cap_suppressed) return 'held';
  switch (row.verdict) {
    case 'ready':
      if (row.proposal_session_id) {
        if (row.proposal_status === 'merged') return 'live';
        // WP1: withdrawn (a duplicate of a merged proposal, noteRequestMerged)
        // reads as closed, never as still up for a vote.
        if (row.proposal_status === 'closed' || row.proposal_status === 'archived') return 'closed';
        return 'proposed';
      }
      if (row.build_ok === true) return 'proposed';
      if (row.build_ok === false) {
        // A build its request was closed before (homeroom-bot.js buildOne)
        // never started: the work stopped, nothing went wrong in it.
        if (/^skipped:/.test(String(row.build_error || ''))) return 'stopped';
        return /^blocked:/.test(String(row.build_error || '')) ? 'blocked' : 'build_failed';
      }
      return null;
    case 'question': case 'person': case 'empty': case 'failed': case 'answer': case 'revise':
      return row.verdict;
    default:
      return 'failed';
  }
}

/** Pure: when a finished card's work ended, where the records say. */
function endedAt(row, outcome) {
  if (['proposed', 'live', 'closed'].includes(outcome)) return iso(row.proposal_at);
  if (['blocked', 'build_failed', 'stopped'].includes(outcome)) return null;
  return iso(row.run_at);
}

/** Pure: where a card's links go. Its request always; its proposal once people can open it. */
function linksOf(row) {
  return {
    request: issueHref(row.slug, row.issue_number),
    proposal: row.proposal_session_id && OPENABLE_PROPOSAL.has(row.proposal_status)
      ? proposalHref(row.slug, row.proposal_session_id) : null,
  };
}

/**
 * Pure (WP1, #9): whether a card's run is a ready verdict whose build still
 * waits its turn or runs. Its card is working, whatever came after it.
 */
function buildUnderWay(row) {
  return !!row.run_id && row.verdict === 'ready' && row.build_ok == null && !row.proposal_session_id
    && !row.cap_suppressed && (!!row.build_waiting_at || row.build_status === 'active' || row.build_status === 'paused');
}

// The progress stages (homeroom-bot-progress.js) that are a ready verdict's
// build: its plan, the build, the proposal it opens.
const BUILD_STAGES = new Set(['build_queued', 'starting', 'planning', 'building', 'proposing']);

/**
 * Pure: one card, from its row and (while it has no outcome) the person's
 * progress entry for its request, or null when there is none.
 */
function cardOf(row, entry) {
  const base = {
    messageId: Number(row.message_id),
    // When its work began: the card's own moment, or for a card that joined
    // work already under way, when that work started. B4: a card that
    // carried on through several looks counts from the first.
    startedAt: iso(row.first_at || row.began || row.created_at),
    links: linksOf(row),
  };
  let outcome = outcomeOf(row);
  // WP1 (#9): a card whose build still waits or runs is working, even when
  // a newer card on the same request began or the request's progress says
  // something else: it used to read "Didn't finish" the moment a second look
  // at its request started, with its build healthy and nothing said.
  const building = !outcome && buildUnderWay(row);
  // B4: with one card per request, a newer look's progress (reading the
  // request again) is not this build's; the build's own stages are.
  if (building && (row.next_at || !entry || !BUILD_STAGES.has(entry.stage))) {
    return {
      ...base,
      state: 'working',
      stage: row.build_waiting_at && row.build_status == null ? 'build_queued' : 'building',
      step: null,
      of: null,
      stepName: null,
      doing: row.build_waiting_at && row.build_status == null ? 'ready to build; waiting its turn to be built' : 'building it',
      stepSince: null,
    };
  }
  // A newer card on the same request began without this one coming to
  // anything recorded, or nothing about it is in progress any more.
  if (!outcome && (row.next_at || !entry)) outcome = 'stopped';
  if (outcome) return { ...base, state: 'done', outcome, endedAt: endedAt(row, outcome) };
  return {
    ...base,
    state: 'working',
    stage: entry.stage || null,
    step: Number.isInteger(entry.step) ? entry.step : null,
    of: Number.isInteger(entry.of) ? entry.of : null,
    stepName: entry.stepName || null,
    doing: entry.doing || null,
    stepSince: entry.since || null,
    ...(Number.isFinite(entry.stepTimeLimitMinutes) ? { stepLimitMinutes: entry.stepTimeLimitMinutes } : {}),
    ...(entry.waitingOn ? { waitingOn: entry.waitingOn } : {}),
  };
}

/**
 * The person's newest cards, each with when its work began (`began`: its
 * own moment, or the `startedAt` a card that joined work under way carries)
 * and the first live run from then, before the next card on the same
 * request began. A build a restart cut short and sent back to be looked at
 * again (RESTARTED_BUILD_NOTE) is not what its work came to: that work goes
 * on in the look that follows, so the card reads past it.
 */
async function cardRows(pool, userId, limit = MAX_CARDS) {
  const { RESTARTED_BUILD_NOTE } = require('./homeroom-bot');
  const { rows } = await pool.query(
    `WITH stamped AS (
       SELECT d.message_id, d.app_id, d.issue_number, d.created_at,
              CASE WHEN m.metadata->'homeroomBot'->>'startedAt'
                        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
                   THEN (m.metadata->'homeroomBot'->>'startedAt')::timestamptz END AS started_at,
              CASE WHEN m.metadata->'homeroomBot'->>'lookAt'
                        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
                   THEN (m.metadata->'homeroomBot'->>'lookAt')::timestamptz END AS look_at
         FROM homeroom_bot_dm_messages d
         JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.kind = 'activity'
     ), cards AS (
       SELECT message_id, app_id, issue_number, created_at,
              COALESCE(started_at, created_at) AS first_at,
              COALESCE(look_at, started_at, created_at) AS began
         FROM stamped
     )
     SELECT c.message_id, c.app_id, c.issue_number, c.created_at, c.first_at, c.began, a.slug, a.name,
            nxt.began AS next_at,
            run.id AS run_id, run.verdict, run.build_ok, run.build_error, run.cap_suppressed,
            run.created_at AS run_at, run.proposal_session_id,
            run.live_build_waiting_at AS build_waiting_at, bs.status AS build_status,
            cs.status AS proposal_status, COALESCE(cs.promoted_at, cs.created_at) AS proposal_at
       FROM cards c
       JOIN apps a ON a.id = c.app_id
       LEFT JOIN LATERAL (
         SELECT n.began FROM cards n
          WHERE n.app_id = c.app_id AND n.issue_number = c.issue_number AND n.message_id > c.message_id
          ORDER BY n.message_id LIMIT 1
       ) nxt ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.id, r.verdict, r.build_ok, r.build_error, r.cap_suppressed, r.created_at, r.proposal_session_id,
                r.live_build_waiting_at, r.build_session_id
           FROM homeroom_bot_runs r
          WHERE r.app_id = c.app_id AND r.issue_number = c.issue_number AND r.mode = 'live'
            AND r.created_at >= c.began
            AND (nxt.began IS NULL OR r.created_at < nxt.began)
            AND NOT (r.build_ok IS FALSE AND right(COALESCE(r.build_error, ''), char_length($3::text)) = $3::text)
          ORDER BY r.id LIMIT 1
       ) run ON TRUE
       LEFT JOIN chat_sessions cs ON cs.id = run.proposal_session_id
       LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
      ORDER BY c.message_id DESC
      LIMIT $2`,
    [userId, limit, RESTARTED_BUILD_NOTE],
  );
  return rows;
}

// WP1 (#10): what a card shows, in the words the client draws it with
// (frontend/src/features/messages/bot-activity.tsx: its eyebrow and its
// status line), for the bot's model, which reads the DM as text and never
// sees a card. Without it the model answered "Nothing broke" beside a card
// that read "Didn't finish".
const OUTCOME_LABELS = Object.freeze({
  question: 'Asked you a question',
  proposed: 'Built it. Waiting for approval',
  live: 'Built it. It\'s live',
  closed: 'Built it. The change was closed',
  blocked: 'Can\'t build it as it\'s written',
  build_failed: 'Couldn\'t finish building it',
  person: 'Left it for the group to decide',
  empty: 'Found nothing to build yet',
  failed: 'Couldn\'t finish looking at it',
  held: 'Ready, but held back for now',
  stopped: 'Stopped before it finished',
  answer: 'Answered on the change',
  revise: 'Updated the change',
});
const OUTCOME_TONES = Object.freeze({
  proposed: 'done', live: 'done', answer: 'done', revise: 'done',
  question: 'you', blocked: 'you', empty: 'you',
  person: 'ended', held: 'ended', closed: 'ended',
  build_failed: 'trouble', failed: 'trouble', stopped: 'trouble',
});
const TONE_WORDS = Object.freeze({ done: 'Done', you: 'Needs you', ended: 'Ended', trouble: 'Didn\'t finish' });

/** Pure: a card (cardOf) as the person reads it, in one line, or null. */
function cardWords(card) {
  if (!card) return null;
  if (card.state === 'working') {
    const head = card.step && card.of
      ? `Step ${card.step} of ${card.of}${card.stepName ? ` · ${card.stepName}` : ''}`
      : 'Working on it';
    return `${head}: ${card.doing || 'working on it'}`;
  }
  if (card.state === 'done' && OUTCOME_LABELS[card.outcome]) {
    return `${TONE_WORDS[OUTCOME_TONES[card.outcome]]}: ${OUTCOME_LABELS[card.outcome]}`;
  }
  return null;
}

/** The slugs among `slugs` this person can still view. */
async function viewableSlugs(pool, user, slugs) {
  if (!slugs.length) return new Set();
  // The columns checkAppAccess reads (app-access.js ACCESS_COLUMNS), written
  // out so the query stays static SQL.
  const { rows } = await pool.query(
    `SELECT id, slug, created_by, self_hosted, collab_visibility, view_visibility, moderation_suspended_at
       FROM apps WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const allowed = new Set();
  for (const app of rows) {
    if (await appAccess.checkAppAccess(pool, app, user, 'view')) allowed.add(app.slug);
  }
  return allowed;
}

/**
 * The state of `user`'s activity cards, newest first: { cards }. Each is
 * { messageId, startedAt, links, state: 'working', step, of, stepName,
 * doing, ... } or { ..., state: 'done', outcome, endedAt }. Never anybody
 * else's: see the note at the top.
 */
async function cardsFor(pool, { user, settings = null, config = null, deps = {}, now = new Date() }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return { cards: [] };
  const rows = await cardRows(pool, userId);
  if (!rows.length) return { cards: [] };
  const allowed = await viewableSlugs(pool, user, [...new Set(rows.map((row) => row.slug))]);
  const shown = rows.filter((row) => allowed.has(row.slug));
  // How far along: read once, and only when a card is still going.
  const progress = new Map();
  if (shown.some((row) => !outcomeOf(row) && !row.next_at)) {
    const s = settings || await settingsModule(deps).readSettings(pool);
    const p = await progressModule(deps).progressFor(pool, {
      userId, settings: s, config,
      deps: { botSvc: deps.botSvc, creationPhase: deps.creationPhase, domain: null },
      now,
    });
    for (const entry of p.rightNow || []) {
      if (entry.project && entry.number) progress.set(`${entry.project}#${entry.number}`, entry);
    }
  }
  return {
    cards: shown.map((row) => cardOf(row, progress.get(`${row.slug}#${Number(row.issue_number)}`) || null)),
  };
}

// ── Work already under way without a card ──

// The stages of a request's own look (homeroom-bot-progress.js stageOf) in
// which the bot is working on it this minute: reading it, then the plan and
// the build a ready verdict starts. Each is one the tray lists under Now
// (homeroom-bot-tray.js, as 'looking' or 'building'). Not a request waiting
// in the queue (its card comes when its look starts) or a ready verdict
// waiting its turn to be built (when its build starts), not a follow-up on
// its proposal or a merge (the card before them ended at "proposal up"),
// and nothing waiting on the person, the group or a cap.
const UNDER_WAY_STAGES = Object.freeze(['reading', 'starting', 'planning', 'building', 'proposing']);
// The most of the person's cards looked through for the one that already
// follows a request. Their work under way is recent, and so is its card.
const COVER_LIMIT = 100;

/**
 * Pure: the piece of work one of the person's requests is (a `requestStates`
 * row and its stage), when it is under way and a card follows it:
 * `{ key, startedAt }`, or null.
 *
 *   - a look being read is its claimed queue row, keyed as the loop keys the
 *     card it sends when that look starts (startCard), so the two can only
 *     ever be one message. A backlog pass's look (`quietReasons`) is left
 *     alone while it reads, as the loop leaves it: most of a backlog is held,
 *     and says nothing until it has something to say;
 *   - a plan or build is the run whose ready verdict started it (its queue
 *     row is gone by then). That look began before the run was recorded, by
 *     the time it took (duration_ms).
 */
function pieceOf(row, state, { quietReasons = [] } = {}) {
  if (!row || !state || state.waitingOn || !UNDER_WAY_STAGES.includes(state.stage)) return null;
  if (state.stage === 'reading') {
    if (!row.queue_id || !row.started_at || quietReasons.includes(row.queue_reason)) return null;
    return { key: jobCardKey(row.queue_id), startedAt: iso(row.started_at) };
  }
  if (!row.run_id || !row.run_at) return null;
  const ran = Math.max(0, Number(row.run_duration_ms) || 0);
  const at = new Date(new Date(row.run_at).getTime() - ran);
  return { key: `hrbot-activity-run-${Number(row.run_id)}`, startedAt: iso(at) };
}

/**
 * Pure: the requests (`${appId}#${issueNumber}`) whose newest card still
 * follows their work, from cardRows' rows (newest first): it has come to
 * nothing yet (no run since it began, or a build not finished). A request
 * whose newest card has ended, or that has none, has no card for the work
 * under way on it now.
 */
function followedRequests(rows) {
  const seen = new Set();
  const followed = new Set();
  for (const row of rows) {
    const key = `${Number(row.app_id)}#${Number(row.issue_number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!outcomeOf(row)) followed.add(key);
  }
  return followed;
}

/** Run `work` holding the person's catch-up lock, or resolve null when another holds it. */
async function whileHolding(pool, userId, work) {
  const client = await pool.connect();
  let held = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [HOMEROOM_BOT_CARDS_LOCK, userId]);
    held = !!rows[0]?.acquired;
    if (!held) return null;
    return await work();
  } finally {
    if (held) await client.query('SELECT pg_advisory_unlock($1, $2)', [HOMEROOM_BOT_CARDS_LOCK, userId]).catch(() => {});
    client.release();
  }
}

/**
 * `user` (the signed-in person) opened their DM with the bot: every piece of
 * their work that is under way and has no card yet gets one, at the end of
 * the DM, saying it was started earlier (see the note at the top). Their own
 * work only, on a project the bot acts on for real that they can view, and
 * only when they are somebody it talks to there. Idempotent: a second call,
 * and the loop's own card for the same look, add nothing. Never throws.
 * Resolves { added }.
 */
async function catchUpCards(pool, { user, settings = null, deps = {}, now = new Date() }) {
  const none = { added: 0 };
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0 || user.isSynthetic) return none;
  try {
    const botSvc = settingsModule(deps);
    const dm = dmModule(deps);
    const liveSvc = liveModule(deps);
    const s = settings || await botSvc.readSettings(pool);
    // As the tray: nothing is under way while the bot is off, or on a
    // staging copy, which never acts.
    if (!dm.hasBot(s, user) || s.mode === 'off' || liveSvc.isStaging()) return none;
    const added = await whileHolding(pool, userId, async () => {
      const states = await progressModule(deps).requestStates(pool, { userId, settings: s, now });
      const quietReasons = [botSvc.APP_AGAIN_REASON].filter(Boolean);
      let wanted = states
        .map(({ row, state }) => ({ row, piece: pieceOf(row, state, { quietReasons }) }))
        .filter(({ row, piece }) => piece && liveSvc.isLiveFor(s, { slug: row.slug }));
      if (!wanted.length) return 0;
      // Recorded as theirs, the way the loop decides whose card it is (an
      // issue they filed that the loop has not recorded yet is not, yet).
      const { rows: theirs } = await pool.query(
        `SELECT app_id, issue_number, issue_title, first_version, asked_text
           FROM homeroom_bot_requesters WHERE user_id = $1`,
        [userId],
      );
      const recorded = new Map(theirs.map((r) => [`${Number(r.app_id)}#${Number(r.issue_number)}`, r]));
      const allowed = await viewableSlugs(pool, user, [...new Set(wanted.map(({ row }) => row.slug))]);
      const covered = await cardRows(pool, userId, COVER_LIMIT);
      const followed = followedRequests(covered);
      wanted = wanted.filter(({ row }) => {
        const key = `${Number(row.app_id)}#${Number(row.issue_number)}`;
        return recorded.has(key) && allowed.has(row.slug) && !followed.has(key);
      });
      if (!wanted.length) return 0;
      // B4: a request whose card has ended carries on in it, from when this
      // work began, rather than getting a second card at the end.
      const newest = new Map();
      for (const row of covered) {
        const key = `${Number(row.app_id)}#${Number(row.issue_number)}`;
        if (!newest.has(key)) newest.set(key, row);
      }
      const fresh = [];
      for (const item of wanted) {
        const card = newest.get(`${Number(item.row.app_id)}#${Number(item.row.issue_number)}`);
        if (!card) { fresh.push(item); continue; }
        await continueCard(pool, { messageId: Number(card.message_id), conversationId: null, lookAt: iso(card.began) }, {
          userId, lookAt: item.piece.startedAt, dm,
        }).catch((err) => log.warn('homeroom-bot-activity', 'Could not carry a card on', {
          app: item.row.slug, issueNumber: item.row.issue_number, userId, err: err.message,
        }));
      }
      wanted = fresh;
      if (!wanted.length) return 0;
      const bot = await dm.botAccount(pool);
      if (!bot) return 0;
      let count = 0;
      for (const { row, piece } of wanted) {
        const n = Number(row.issue_number);
        const mine = recorded.get(`${Number(row.app_id)}#${n}`);
        try {
          const sent = await sendCard(pool, {
            app: { id: row.app_id, slug: row.slug, name: row.name },
            issueNumber: n,
            requester: {
              userId, issueTitle: mine.issue_title || row.issue_title || null, firstVersion: !!mine.first_version,
              askedText: mine.asked_text || null,
            },
            bot, key: piece.key, startedAt: piece.startedAt, dm,
          });
          if (!sent?.messageId) continue;
          // Recorded even when it was sent before: a card whose record was
          // lost is found by the next read.
          await recordCard(pool, sent, { userId, appId: row.app_id, issueNumber: n });
          if (sent.duplicate) continue;
          count += 1;
          log.info('homeroom-bot-activity', 'Gave work already under way its activity card', {
            app: row.slug, issueNumber: n, userId, startedAt: piece.startedAt,
          });
        } catch (err) {
          log.warn('homeroom-bot-activity', 'Could not give work under way its card', {
            app: row.slug, issueNumber: n, userId, err: err.message,
          });
        }
      }
      return count;
    });
    return { added: added || 0 };
  } catch (err) {
    log.warn('homeroom-bot-activity', 'Could not catch up on activity cards', { userId, err: err.message });
    return none;
  }
}

// ── The staging demo ──

// The staging bot DM fixture's cards (staging-messages.js), by the key each
// was sent with: one being built now, one that ended in a proposal, and one
// that joins work already under way, sent when the viewer opens the DM
// (staging-messages.js ensureDemoUnderWayCard, catchUpCards' stand-in). A
// staging copy never runs the bot, so without them no card could be seen
// there. No project stands behind them, so they link nowhere.
const DEMO_CARD_KEYS = Object.freeze({
  working: 'staging-hrbot-activity-working',
  done: 'staging-hrbot-activity-done',
  underWay: 'staging-hrbot-activity-under-way',
});
// The demo's work already under way: the plan for request #15, begun before
// its card was there (the tray's demo lists it too, homeroom-bot-tray.js).
const DEMO_UNDER_WAY = Object.freeze({
  issueNumber: 15, issueTitle: 'Staging demo, add a search box', startedMinutesAgo: 38,
});

/** Pure: the demo cards' state, for the fixture's message ids. Times are relative to `now`. */
function demoState({ working = null, done = null, underWay = null }, now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  const links = { request: null, proposal: null };
  const cards = [];
  if (underWay) {
    cards.push({
      messageId: underWay, startedAt: ago(DEMO_UNDER_WAY.startedMinutesAgo), links, state: 'working', stage: 'planning',
      step: 2, of: 6, stepName: 'Write a plan', doing: 'writing the plan for the build', stepSince: ago(7), stepLimitMinutes: 20,
    });
  }
  if (working) {
    cards.push({
      messageId: working, startedAt: ago(9), links, state: 'working', stage: 'building',
      step: 3, of: 6, stepName: 'Build it', doing: 'building it', stepSince: ago(4), stepLimitMinutes: 30,
    });
  }
  if (done) {
    cards.push({ messageId: done, startedAt: ago(60 * 26 + 23), links, state: 'done', outcome: 'proposed', endedAt: ago(60 * 26) });
  }
  return { cards };
}

/** The demo cards in `user`'s own bot DM fixture, by the keys they were sent with. */
async function demoCards(pool, user, now = Date.now()) {
  if (!user?.id) return { cards: [] };
  const { rows } = await pool.query(
    `SELECT m.id, m.idempotency_key FROM conversation_messages m
       JOIN users b ON b.id = m.sender_id AND b.username = 'homeroom_bot' AND b.is_synthetic = TRUE
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.status = 'member'
      WHERE m.idempotency_key = ANY($2::text[])`,
    [user.id, Object.values(DEMO_CARD_KEYS)],
  );
  const id = (key) => Number(rows.find((row) => row.idempotency_key === key)?.id) || null;
  return demoState({
    working: id(DEMO_CARD_KEYS.working), done: id(DEMO_CARD_KEYS.done), underWay: id(DEMO_CARD_KEYS.underWay),
  }, now);
}

module.exports = {
  KIND,
  OUTCOMES,
  MAX_CARDS,
  UNDER_WAY_STAGES,
  DEMO_CARD_KEYS,
  DEMO_UNDER_WAY,
  cardText,
  jobCardKey,
  requestCard,
  continueCard,
  startCard,
  outcomeOf,
  endedAt,
  linksOf,
  buildUnderWay,
  cardOf,
  cardWords,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  TONE_WORDS,
  cardsFor,
  pieceOf,
  followedRequests,
  catchUpCards,
  demoState,
  demoCards,
};
