'use strict';

// B9: mention Homeroom bot in a project's group chat.
//
// A member writes "@Homeroom bot could it remind us on Sundays?" in the
// project's chat (or picks "Make this a request" on a message of their own).
// The message stays theirs, word for word, and the bot never writes a line
// into the chat. Instead:
//
//   - a quick read (llm.readChatAsk) decides whether it asks for a change.
//     A change is filed at once as a request in their words, through the
//     same path a request offered in the bot's chat is (mayor.fileRequest);
//     a question or a chat is pointed at the bot's own chat; when it could
//     be either, they are asked first. "Make this a request" skips the read:
//     the person chose;
//   - how it is going rides on the message itself, as metadata everybody in
//     the room sees (`botRequest: { issueNumber, status }`, a
//     `bot_request_status` frame): reading, building, ready (Try it), live.
//     When the work stops, the chip goes for everybody else, and the
//     requester's own card and their chat with the bot say what happened;
//   - the requester alone gets a card under their message ("Only you can see
//     this"), pushed to their own sockets and read back from
//     chat_bot_requests (GET /api/apps/:slug/my-bot-requests), never from
//     chat_messages, so no reader of the room can see it.
//
// Only a message a person typed, in the room's main stream, and never an
// edit or a message a connector posted (E7). Membership is the room's own
// gate (communities.chatNeedsJoin). The socket has no rate limit, so filings
// are capped per person by a count.
//
// WP-C: somebody NEW to a project (joined in the last two weeks, nothing
// asked for there yet) need not know to mention the bot. When a message of
// theirs reads as an idea for the app, their card offers to suggest it to the
// group ("Suggest it" / "Not now"); Suggest it files it as a request in their
// name, like any other, whether or not the bot is theirs. At most two offers
// per person per project, never on a message a few words long, and the reads
// behind them are budgeted per person and per hour. The first request
// somebody files says, once, that it stays on the project with their name.
//
// Fix in place (5 October): a mention asking to fix something the bot built
// that is still waiting for approval (a project's first version, most often)
// changes THAT change instead of filing a new request, which the bot would
// have built from the app's main as one more competing version. Which change
// is decided without the model where the message says so (a link to it, a
// reply to a message that carries it, "the first version" when one of them
// is, or its title word for word); otherwise the read is offered the bot's
// pending changes by id beside filing (llm.readChatAsk `changes`), and may
// answer "revise" naming one. The fix goes through the DM's own
// revise_proposal (homeroom-bot-mayor.js reviseProposal), every gate
// included: the words are posted in that change's discussion, under the
// person's name, and the bot's follow-up on it is queued first. The row is
// 'revise' (with the change in `session_id`), the chip on the message says
// Fixing for everybody in the room until the change is ready again, and the
// card says "Got it. I'll fix that in the first version before it goes live."
//
// The card follows its request. What it says is read from the platform's own
// records whenever it is asked for (cardsOf: the request's newest run, as the
// DM's activity card reads it, homeroom-bot-activity.js outcomeOf; the bot's
// change for it, its checks and who still has to approve it), never written
// as the work moves on. Every moment that moves a chip pushes the requester
// their cards again, and the chat reads them again while one is still going.
// The same read puts a chip right that a missed moment left behind.
//
// Held for the first version (5 October, Page Turners): while a project's
// first version is not live, nothing else on it starts (homeroom-bot.js
// FIRST_VERSION_PENDING_SQL). A request filed then waits in the queue, and
// its DM card said so while the chat said "Usually about 10 minutes" and
// Reading. Now such a request is at its own stage, waiting_first_version,
// decided by the bot's own rule (firstVersionHolds, heldForFirstVersion) for
// a request queued and not started: its card says it waits for the first
// version, as the DM does, and its chip says Waiting from the moment it is
// filed. When the first version merges, the loop is woken for what waited
// and picks the request up; that moment (noteRequestStatus 'reading')
// pushes the card and moves the chip on, and a read of the cards after the
// hold ends puts back a Waiting chip no moment moved (chipFor).

const log = require('./logger');

// "@homeroom_bot" and the display form "@Homeroom bot" are both the bot.
const BOT_MENTION_RE = /(^|[^\w])@(homeroom_bot\b|homeroom\s+bot\b)/i;
const BOT_MENTION_ALL_RE = /(^|[^\w])@(?:homeroom_bot\b|homeroom\s+bot\b)[,:]?\s*/gi;
// Filings one person may make from chats in an hour.
const FILINGS_PER_HOUR = 10;
const MAX_TITLE = 120;

// WP-C: the newcomer's offer.
const OFFER_WITHIN_DAYS = 14;
const OFFERS_PER_PROJECT = 2;
const OFFER_MIN_WORDS = 4;
// The reads an offer costs: per person per day, and for everybody per hour.
const OFFER_READS_PER_DAY = 6;
const OFFER_READS_PER_HOUR = 120;
const offerReads = { people: new Map(), hour: { at: 0, n: 0 } };

/**
 * Pure (on the counters above): take one offer read for `userId` at `now`,
 * or false when their day's or everybody's hour's are spent.
 */
function takeOfferRead(userId, now = Date.now(), budget = offerReads) {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  if (now - budget.hour.at >= HOUR) budget.hour = { at: now, n: 0 };
  let mine = budget.people.get(userId);
  if (!mine || now - mine.at >= DAY) mine = { at: now, n: 0 };
  if (budget.hour.n >= OFFER_READS_PER_HOUR || mine.n >= OFFER_READS_PER_DAY) return false;
  budget.hour.n += 1;
  mine.n += 1;
  budget.people.set(userId, mine);
  if (budget.people.size > 5000) budget.people.delete(budget.people.keys().next().value);
  return true;
}

// What the chip on a message can say. `stopped` takes the chip away.
// `fixing`: a fix asked for on one of the bot's changes waiting for approval.
// `waiting_first_version`: a request held until the project's first version
// is live (stageOf).
const STATUSES = new Set(['reading', 'building', 'ready', 'live', 'fixing', 'waiting_first_version']);

// Fix in place: a link to one of a project's changes, in either spelling the
// router reads (`/app/<slug>/dev/proposals/12`, `#app/<slug>/dev/proposals/12`),
// or by its pull request's number (`/app/<slug>/dev/changes/34`, #4367).
const PROPOSAL_LINK_RE = /(?:^|[/#])app\/([a-z0-9][a-z0-9-]{0,254})\/dev\/(proposals|changes)\/([1-9]\d{0,9})(?!\d)/gi;
const FIRST_VERSION_RE = /\bfirst\s+version\b/i;
// The most of the bot's pending changes the read is offered.
const MAX_OFFERED_CHANGES = 5;
// A change's checks that leave it ready to try (homeroom-bot-dm.js READY_CHECKS).
const READY_CHECKS = new Set(['passing', 'skipped']);
// The most cards one read works out who still has to approve for.
const MAX_APPROVAL_READS = 10;

// What a card says about where its request stands (cardsOf). A request:
// waiting_first_version (queued, held until the project's first version is
// live), reading (waiting for or being read), waiting (ready, waiting for a
// free builder), building, question (the bot asked one, in its chat), checking
// (built, its checks running), proposed (built, waiting for approval),
// approved (approved, going live), live, closed, person (left to the group),
// stopped (it did not finish). A fix: fixing (posted, the bot's follow-up
// queued or running), then checking, proposed, approved, live, or asked /
// answered / person / stopped when the follow-up ended without a change.
const CARD_STAGES = Object.freeze([
  'waiting_first_version',
  'reading', 'waiting', 'building', 'question', 'checking', 'proposed', 'approved', 'live', 'closed', 'person', 'stopped',
  'fixing', 'asked', 'answered',
]);

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }
function mayorModule(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function wsModule(deps) { return deps.ws || require('./ws'); }

/** Pure: whether a message mentions Homeroom bot. */
function mentionsBot(text) {
  return BOT_MENTION_RE.test(String(text || ''));
}

/** Pure: a message's words without the mention, which is what was asked. */
function askedWords(text) {
  return String(text || '').replace(BOT_MENTION_ALL_RE, '$1').replace(/\s+/g, ' ').trim();
}

/** Pure: a request's title when the read gave none: its first sentence, trimmed. */
function fallbackTitle(words) {
  const first = String(words || '').split(/(?<=[.!?])\s/)[0].replace(/[?.!]+$/, '').trim();
  const text = first || 'A request from the chat';
  const capped = text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Whether Homeroom bot answers `user` on `app`: { builds } (whether it
 * builds on the project, else a request is filed for the group), or null
 * when it is not on for them. Never throws.
 */
async function botFor(pool, { app, user, settings = null, deps = {} }) {
  try {
    if (!app?.id || !user?.id || user.isSynthetic) return null;
    const s = settings || await botModule(deps).readSettings(pool);
    if (!dmModule(deps).hasBot(s, user)) return null;
    return { builds: !!liveModule(deps).isLiveFor(s, app), settings: s };
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read whether Homeroom bot answers here', { app: app?.slug, err: err.message });
    return null;
  }
}

/**
 * WP-C: whether `user` is new to `app` and has asked for nothing there yet,
 * so a message of theirs that reads as an idea is offered as a request:
 * { builds, settings } for filing it (builds only when the bot is theirs and
 * builds here), or null. Never throws.
 */
async function newcomerHere(pool, { app, user, deps = {} }) {
  try {
    if (!app?.id || !user?.id || user.isSynthetic) return null;
    if (!await isNewcomer(pool, app.id, user.id)) return null;
    return await filingFor(pool, { app, user, deps });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read whether somebody is new here', { app: app?.slug, err: err.message });
    return null;
  }
}

/** WP-C: the one query behind newcomerHere, cheap enough for every message. */
async function isNewcomer(pool, appId, userId) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM chat_bot_requests r WHERE r.app_id = a.id AND r.requester_id = $2) AS asked,
            EXISTS (SELECT 1 FROM issues i WHERE i.app_id = a.id AND i.created_by = $2) AS requested
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id AND m.user_id = $2
      WHERE a.id = $1 AND a.created_by IS DISTINCT FROM $2
        AND m.joined_at > NOW() - make_interval(days => $3::int)`,
    [appId, userId, OFFER_WITHIN_DAYS],
  );
  const row = rows[0];
  return !!row && !row.requested && row.asked < OFFERS_PER_PROJECT;
}

/**
 * How a request of `user`'s on `app` is filed when they took an offer: as
 * the bot's own when the bot is theirs (botFor), else for the group.
 */
async function filingFor(pool, { app, user, deps = {} }) {
  const here = await botFor(pool, { app, user, deps });
  if (here) return here;
  const settings = await botModule(deps).readSettings(pool);
  return { builds: false, settings };
}

/**
 * The card under a request's message, for its requester alone. Pure.
 * `state` is where its request stands now (cardsOf), for a request the bot
 * builds or a fix.
 */
function cardOf(row, { builds = true, typicalMinutes = null, first = false, state = null, firstVersion = false } = {}) {
  const group = builds === false && row.kind === 'filed';
  return {
    messageId: Number(row.chat_message_id),
    kind: row.kind,
    title: row.title || null,
    issueNumber: row.issue_number == null ? null : Number(row.issue_number),
    ...(row.kind === 'filed' && Number.isFinite(typicalMinutes) ? { typicalMinutes } : {}),
    ...(group ? { kind: 'group' } : {}),
    // WP-C: their first request on the project, which says it stays.
    ...(first && row.issue_number != null && row.kind !== 'revise' ? { first: true } : {}),
    // Fix in place: the change a fix was asked on, and whether it is the
    // project's first version (the card says so rather than its title).
    ...(row.session_id != null ? { sessionId: Number(row.session_id) } : {}),
    ...(firstVersion ? { firstVersion: true } : {}),
    ...(state && !group ? { state } : {}),
  };
}

/** WP-C: the number of `user`'s first request on `appId`, or null. */
async function firstRequestOf(pool, appId, userId) {
  const { rows } = await pool.query(
    'SELECT MIN(github_issue_number)::int AS n FROM issues WHERE app_id = $1 AND created_by = $2',
    [appId, userId],
  );
  return rows[0]?.n ?? null;
}

/** Send a requester their card, on every tab they have open. */
function pushCard(userId, appSlug, card, deps = {}) {
  try {
    wsModule(deps).pushToUser(userId, { type: 'bot_request_card', appSlug, card });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not push a chat request card', { userId, err: err.message });
  }
}

/**
 * Set the chip on a request's message for everybody in its room
 * (`status`: one of STATUSES; anything else takes it away).
 * The status survives an edit (the edit path keeps metadata). Never throws.
 */
async function setStatus(pool, { appId, messageId, issueNumber, status, sessionId = null, deps = {} }) {
  try {
    const value = STATUSES.has(status)
      ? { issueNumber: Number(issueNumber), status, ...(sessionId ? { sessionId: Number(sessionId) } : {}) }
      : null;
    const { rows } = await pool.query(
      `UPDATE chat_messages
          SET metadata = CASE WHEN $3::jsonb IS NULL THEN COALESCE(metadata, '{}'::jsonb) - 'botRequest'
                              ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('botRequest', $3::jsonb) END
        WHERE id = $1 AND app_id = $2
        RETURNING id`,
      [messageId, appId, value ? JSON.stringify(value) : null],
    );
    if (!rows.length) return false;
    wsModule(deps).broadcast(Number(appId), { type: 'bot_request_status', messageId: Number(messageId), botRequest: value });
    return true;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not set a chat request\'s status', { appId, messageId, err: err.message });
    return false;
  }
}

/**
 * B4's moments, on the message a request was asked in: its request moved
 * to `status` (reading when the bot starts on it, building, ready with its
 * change, live; `stopped` takes the chip away). Called by the bot wherever
 * those moments happen; a request not asked in a chat is nothing here.
 * Fix in place: a fix asked on the request's change ('revise') wears the
 * chip its change's records give it (cardsOf), not the moment's, but for
 * Live, which waits for the app to answer. Either way the requester's card
 * follows. Never throws.
 */
async function noteRequestStatus(pool, { appId, issueNumber, status, sessionId = null, deps = {} }) {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, a.slug AS app_slug FROM chat_bot_requests r JOIN apps a ON a.id = r.app_id
        WHERE r.app_id = $1 AND r.issue_number = $2 AND r.kind IN ('filed', 'revise')`,
      [appId, issueNumber],
    );
    for (const row of rows) {
      if (row.kind !== 'filed' && status !== 'live') continue;
      await setStatus(pool, {
        appId, messageId: row.chat_message_id, issueNumber, status,
        sessionId: row.kind === 'revise' ? row.session_id : sessionId, deps,
      });
    }
    await followCards(pool, { rows, deps });
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not move a chat request\'s status', { appId, issueNumber, status, err: err.message });
    return 0;
  }
}

// ── Where a request stands, for its card (and its chip) ──

/**
 * What the records say about each of `rows` (filed or revise, with a
 * number): the request's newest live run since it was asked (as the DM's
 * activity card reads one; a fix reads only its change's own turns), the
 * bot's change for it (a fix's own), whether it waits in the queue (and
 * whether that wait is for the project's first version: `held_first_version`,
 * heldFirstVersion), whether it is a first version, and the chip its message
 * wears. By message id.
 */
async function stateRows(pool, rows, { botId = null, deps = {} } = {}) {
  const ids = rows
    .filter((row) => row.issue_number != null && (row.kind === 'filed' || row.kind === 'revise'))
    .map((row) => Number(row.chat_message_id));
  if (!ids.length) return new Map();
  const { RESTARTED_BUILD_NOTE } = require('./homeroom-bot');
  const { rows: found } = await pool.query(
    `SELECT r.chat_message_id, r.kind, r.issue_number, r.app_id, m.metadata->'botRequest' AS chip,
            (q.id IS NOT NULL) AS queued,
            (q.id IS NOT NULL AND q.started_at IS NULL) AS queue_waiting, q.reason AS queue_reason,
            (COALESCE(rq.first_version, FALSE) OR fv.app_id IS NOT NULL) AS first_version,
            iss.status AS issue_status,
            run.id AS run_id, run.verdict, run.build_ok, run.build_error, run.cap_suppressed,
            run.proposal_session_id, run.live_build_waiting_at AS build_waiting_at, bs.status AS build_status,
            COALESCE(rs.id, fs.id) AS session_id, COALESCE(rs.status, fs.status) AS session_status,
            COALESCE(rs.check_state, fs.check_state) AS check_state
       FROM chat_bot_requests r
       JOIN chat_messages m ON m.id = r.chat_message_id
       LEFT JOIN homeroom_bot_queue q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
       LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = r.app_id AND rq.issue_number = r.issue_number
       LEFT JOIN homeroom_bot_first_versions fv ON fv.app_id = r.app_id AND fv.issue_number = r.issue_number
       LEFT JOIN LATERAL (
         SELECT i.status FROM issues i
          WHERE i.app_id = r.app_id AND i.github_issue_number = r.issue_number
          ORDER BY i.id DESC LIMIT 1
       ) iss ON TRUE
       LEFT JOIN LATERAL (
         SELECT x.id, x.verdict, x.build_ok, x.build_error, x.cap_suppressed, x.proposal_session_id,
                x.live_build_waiting_at, x.build_session_id
           FROM homeroom_bot_runs x
          WHERE x.app_id = r.app_id AND x.issue_number = r.issue_number AND x.mode = 'live'
            AND x.created_at >= r.created_at
            AND (r.kind <> 'revise' OR x.proposal_session_id = r.session_id)
            AND NOT (x.build_ok IS FALSE AND right(COALESCE(x.build_error, ''), char_length($3::text)) = $3::text)
          ORDER BY x.id DESC LIMIT 1
       ) run ON TRUE
       LEFT JOIN chat_sessions bs ON bs.id = run.build_session_id
       LEFT JOIN chat_sessions rs ON r.kind = 'revise' AND rs.id = r.session_id
       LEFT JOIN LATERAL (
         SELECT s.id, s.status, s.check_state FROM chat_sessions s
          WHERE r.kind = 'filed' AND s.app_id = r.app_id AND s.user_id = $2 AND s.is_headless = FALSE
            AND r.issue_number = ANY(s.linked_issues)
          ORDER BY (s.status IN ('promoted', 'merging', 'merged')) DESC, s.id DESC
          LIMIT 1
       ) fs ON TRUE
      WHERE r.chat_message_id = ANY($1::int[])`,
    [ids, Number(botId) || 0, RESTARTED_BUILD_NOTE],
  );
  await heldFirstVersion(pool, found, { deps });
  return new Map(found.map((row) => [Number(row.chat_message_id), row]));
}

/**
 * Mark each of stateRows' `found` rows a request (not a fix) that waits in
 * the queue, not started, while its project's first version is not live:
 * `held_first_version`. The bot's own rule decides, as its read lane does
 * (homeroom-bot.js firstVersionHolds, heldForFirstVersion): never the first
 * version's own request, nor an admin's Run now. A request with the bot's
 * change already up (a follow-up, which is not held) is read as that change
 * before this is (stageOf). A read that fails holds nothing: the card says
 * what it said before.
 */
async function heldFirstVersion(pool, found, { deps = {} } = {}) {
  const waiting = found.filter((row) => row.kind === 'filed' && row.queue_waiting);
  if (!waiting.length) return;
  const given = botModule(deps);
  const bot = typeof given.firstVersionHolds === 'function' && typeof given.heldForFirstVersion === 'function'
    ? given : require('./homeroom-bot');
  let holds;
  try {
    holds = await bot.firstVersionHolds(pool, waiting.map((row) => Number(row.app_id)));
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read whether a first version holds chat requests', { err: err.message });
    return;
  }
  for (const row of waiting) {
    row.held_first_version = bot.heldForFirstVersion(holds, {
      appId: row.app_id, issueNumber: row.issue_number, firstVersion: !!row.first_version, reason: row.queue_reason || null,
    });
  }
}

/**
 * Pure: where one request (or fix) stands, from its stateRows row: one of
 * CARD_STAGES. A merged change is live once its chip says so (the app
 * answered after the merge: homeroom-bot-dm.js liveAfterMerge), approved
 * until then. A request held for its project's first version
 * (`held_first_version`, stateRows) waits for it, whatever it came to
 * before it was queued again.
 */
function stageOf(row, { activity = null } = {}) {
  const status = row.session_status || null;
  if (status === 'merged') return row.chip?.status === 'live' ? 'live' : 'approved';
  if (status === 'merging') return 'approved';
  if (status === 'closed' || status === 'archived') return 'closed';
  const ready = status === 'promoted' && READY_CHECKS.has(row.check_state);
  if (row.kind === 'revise') {
    // Not up for approval any more, and not approved: nothing to change.
    if (status !== 'promoted') return 'stopped';
    // Its follow-up waits or runs (again, when somebody wrote since).
    if (!row.run_id || row.queued) return 'fixing';
    if (row.verdict === 'revise') return ready ? 'proposed' : 'checking';
    if (row.verdict === 'question') return 'asked';
    if (row.verdict === 'answer') return 'answered';
    if (row.verdict === 'person') return 'person';
    return 'stopped';
  }
  if (status === 'promoted') return ready ? 'proposed' : 'checking';
  if (status === 'active' || status === 'paused') return 'building';
  if (String(row.issue_status || '') === 'closed') return 'closed';
  if (row.held_first_version) return 'waiting_first_version';
  if (!row.run_id) return 'reading';
  const a = activity || require('./homeroom-bot-activity');
  // Its run's own change, if it has one, was read above as the request's.
  const run = { ...row, proposal_session_id: null };
  const outcome = a.outcomeOf(run);
  if (!outcome) {
    if (a.buildUnderWay(run)) return row.build_waiting_at && row.build_status == null ? 'waiting' : 'building';
    return row.verdict === 'ready' ? 'building' : 'reading';
  }
  switch (outcome) {
    case 'question': return row.queued ? 'reading' : 'question';
    case 'held': return 'waiting';
    // #4242: built and not offered yet reads as it did, being checked.
    case 'proposed': case 'answer': case 'revise': case 'checking': case 'needs_look': case 'going_live': return 'checking';
    case 'person': return row.queued ? 'reading' : 'person';
    default: return row.queued ? 'reading' : 'stopped';
  }
}

/**
 * Pure: the chip a request's message should wear for `stage`, when its
 * records settle it: Try it once its change is ready, none once it ended
 * without one, Fixing while a fix waits, Waiting while it is held for the
 * project's first version. `undefined` leaves the chip the moments gave it
 * (reading, building, and Live, which only the app's answer after a merge
 * says). `have`, the chip it wears now: a Waiting chip whose hold ended
 * before a moment moved it on (the loop not free yet, or a pick-up that
 * says nothing) becomes the one the request would wear, and a Reading chip
 * whose request is being built, or is past it, says Building. The
 * production run-through of 5 Oct 2026 saw the chip in the project's chat
 * say Reading for the whole build while the requester's own card said
 * "Building it now": the moment that moves it was missed, and nothing put
 * it right. A chip never moves back to Reading from here.
 */
function chipFor(row, stage, have = null) {
  const issueNumber = Number(row.issue_number);
  const sessionId = row.session_id != null ? Number(row.session_id) : null;
  if (stage === 'proposed' && sessionId) return { issueNumber, status: 'ready', sessionId };
  if (['closed', 'stopped', 'person', 'asked', 'answered'].includes(stage)) return null;
  if (stage === 'fixing' && row.kind === 'revise') return { issueNumber, status: 'fixing', ...(sessionId ? { sessionId } : {}) };
  if (stage === 'waiting_first_version') return { issueNumber, status: 'waiting_first_version' };
  if (have?.status === 'waiting_first_version' && ['reading', 'waiting', 'question'].includes(stage)) {
    return { issueNumber, status: 'reading' };
  }
  if (['waiting_first_version', 'reading'].includes(have?.status) && ['building', 'checking', 'approved'].includes(stage)) {
    return { issueNumber, status: 'building' };
  }
  return undefined;
}

/** Pure: whether a chip already says what `want` says. */
function sameChip(have, want) {
  if (!have || !want) return !have && !want;
  return have.status === want.status && Number(have.sessionId || 0) === Number(want.sessionId || 0)
    && Number(have.issueNumber || 0) === Number(want.issueNumber || 0);
}

/**
 * Who still has to approve change `sessionId`, for `viewer`'s card: the same
 * reading as the DM's ready card (homeroom-bot-dm.js approvalState,
 * needsYesFrom). { youApprove, waitingOn, more, missing, needed }: `missing`
 * is how many more approvals it needs (0 once it has them) and `needed` how
 * many in all, so a change that needs two of three people says any of them
 * will do (frontend/src/features/messages/approval-words.ts). A public
 * community names nobody: everybody there could vote.
 */
async function approvalOf(pool, { sessionId, viewer, deps = {} }) {
  const dm = dmModule(deps);
  const state = await dm.approvalState(pool, { sessionId, userId: viewer.id });
  if (!state) return null;
  const open = state.audience === 'open' && state.gov?.approverPolicy !== 'invited';
  // Nobody is waited on once it has the approvals it needs.
  const ids = state.missing === 0 ? [] : await dm.needsYesFrom(pool, state, { except: [viewer.id] });
  const { rows } = ids.length
    ? await pool.query('SELECT username FROM users WHERE id = ANY($1::int[]) ORDER BY username', [ids])
    : { rows: [] };
  const names = rows.map((r) => r.username).filter(Boolean);
  return {
    youApprove: !open && !!(state.counts && !state.already),
    waitingOn: names.slice(0, 3),
    more: Math.max(names.length - 3, 0),
    missing: state.missing,
    needed: state.needed,
  };
}

/**
 * The cards of `rows` (one person's, on one project), each with where its
 * request stands now. `reconcile` also puts right a chip a missed moment
 * left behind (chipFor), for everybody in the room. Never throws for a
 * record it cannot read: that card says what it said before.
 */
async function cardsOf(pool, { appId, user, rows, builds = true, typical = true, deps = {}, reconcile = false }) {
  const followed = rows.filter((row) => row.issue_number != null && (row.kind === 'filed' || row.kind === 'revise'));
  let states = new Map();
  if (followed.length) {
    try {
      const bot = await dmModule(deps).botAccount(pool);
      states = await stateRows(pool, followed, { botId: bot?.id || null, deps });
    } catch (err) {
      log.warn('homeroom-bot-chat', 'Could not read where chat requests stand', { appId, err: err.message });
    }
  }
  const stages = new Map();
  for (const [id, state] of states) stages.set(id, stageOf(state, { activity: deps.activity || null }));
  const stageOfRow = (row) => stages.get(Number(row.chat_message_id)) || null;
  const typicalMinutes = typical && rows.some((row) => row.kind === 'filed' && (stageOfRow(row) || 'reading') === 'reading')
    ? await dmModule(deps).typicalMinutes(pool).catch(() => null) : null;
  const first = rows.some((row) => row.issue_number != null && row.kind !== 'revise')
    ? await firstRequestOf(pool, appId, user.id).catch(() => null) : null;
  const approvals = new Map();
  for (const row of rows.filter((r) => stageOfRow(r) === 'proposed').slice(0, MAX_APPROVAL_READS)) {
    const state = states.get(Number(row.chat_message_id));
    if (!state?.session_id) continue;
    const approval = await approvalOf(pool, { sessionId: state.session_id, viewer: user, deps }).catch((err) => {
      log.warn('homeroom-bot-chat', 'Could not read who approves a change (card without names)', { sessionId: state.session_id, err: err.message });
      return null;
    });
    if (approval) approvals.set(Number(row.chat_message_id), approval);
  }
  if (reconcile) {
    for (const row of followed) {
      const state = states.get(Number(row.chat_message_id));
      const stage = stageOfRow(row);
      if (!state || !stage) continue;
      const want = chipFor({ ...row, session_id: state.session_id ?? row.session_id }, stage, state.chip);
      if (want === undefined || sameChip(state.chip, want)) continue;
      await setStatus(pool, {
        appId, messageId: row.chat_message_id, issueNumber: row.issue_number,
        status: want ? want.status : 'stopped', sessionId: want?.sessionId || null, deps,
      });
    }
  }
  const sessionOf = (row) => states.get(Number(row.chat_message_id))?.session_id ?? row.session_id ?? null;
  // Approved and merged into the platform's own app, not live yet: it waits
  // for the platform's next release (services/release-watch.js), and the
  // card says when ("Merged; goes live in the next release (about 8
  // minutes)"). Any other approved change is left out of the answer and its
  // card says "It's going live", as before. One read, only for those.
  const approved = rows.filter((row) => stageOfRow(row) === 'approved' && sessionOf(row)).map((row) => Number(sessionOf(row)));
  const releases = approved.length ? await require('./release-watch').releasesFor(pool, approved) : new Map();
  return rows.map((row) => {
    const id = Number(row.chat_message_id);
    const stateRow = states.get(id);
    const stage = stageOfRow(row);
    const sessionId = sessionOf(row);
    const release = stage === 'approved' && sessionId ? releases.get(Number(sessionId)) : null;
    const state = stage ? {
      stage,
      ...(sessionId ? { sessionId: Number(sessionId) } : {}),
      ...(approvals.get(id) || {}),
      ...(release ? { release } : {}),
    } : null;
    return cardOf(row, {
      builds: row.kind === 'group' ? false : builds,
      // Held for the first version, nobody knows how long it waits.
      typicalMinutes: stage === 'waiting_first_version' ? null : typicalMinutes,
      first: first != null && Number(row.issue_number) === first,
      state,
      firstVersion: !!stateRow?.first_version,
    });
  });
}

/**
 * Push every requester of `rows` (chat_bot_requests rows of one request,
 * with `app_slug`) their cards again, as they stand now, and put their
 * chips right. Never throws.
 */
async function followCards(pool, { rows, deps = {} }) {
  const byPerson = new Map();
  for (const row of rows) {
    const key = Number(row.requester_id);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(row);
  }
  for (const [userId, theirs] of byPerson) {
    try {
      const cards = await cardsOf(pool, {
        appId: theirs[0].app_id, user: { id: userId }, rows: theirs, deps, reconcile: true,
      });
      for (const card of cards) pushCard(userId, theirs[0].app_slug, card, deps);
    } catch (err) {
      log.warn('homeroom-bot-chat', 'Could not bring a chat request\'s card up to date', { userId, err: err.message });
    }
  }
}

/**
 * Record what came of one message, once: the first word on a message wins,
 * and an edit or a second mention files nothing more. Resolves the row as
 * it stands.
 */
async function record(pool, {
  messageId, appId, userId, kind, issueNumber = null, title = null, sessionId = null, replace = false,
}) {
  const params = [messageId, appId, userId, kind, issueNumber, title ? String(title).slice(0, 300) : null, sessionId];
  const { rows } = replace
    ? await pool.query(
      `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number, title, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_message_id) DO UPDATE
         SET kind = EXCLUDED.kind, issue_number = EXCLUDED.issue_number, title = EXCLUDED.title,
             session_id = EXCLUDED.session_id, updated_at = NOW()
       RETURNING *`,
      params,
    )
    : await pool.query(
      `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number, title, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_message_id) DO NOTHING
       RETURNING *`,
      params,
    );
  const row = rows[0] || null;
  // 5 October (Page Turners): a joiner's first message is often what they
  // ask for, and their invite's maker was told they said hi the moment it
  // was sent, seconds (or a "Suggest it") before it became a request; the
  // rest of a small group heard "@mo_t1006 in Page Turners" over it. Those
  // rows are pushed again as they read now, asking for a change
  // (notifications.refreshFiledMessage). Never throws.
  if (row && row.issue_number != null && ['filed', 'group', 'revise'].includes(row.kind)) {
    await require('./notifications').refreshFiledMessage(pool, { appId, chatMessageId: messageId });
  }
  return row;
}

/** How many requests this person filed from chats in the last hour. */
async function filedLately(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_bot_requests
      WHERE requester_id = $1 AND issue_number IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
  );
  return rows[0]?.n || 0;
}

/**
 * File one message as a request in its writer's words: the issue, its card
 * in their chat with the bot (whose See progress the chat card opens), and
 * the chip on the message. Resolves the card.
 */
async function fileMessage(pool, config, { app, user, messageId, words, title, here, deps = {} }) {
  const mayor = mayorModule(deps);
  const filed = await mayor.fileRequest(pool, config, {
    user, app, title, details: words, settings: here.settings, deps, askedText: words,
    footer: `Asked in ${app.name || app.slug}'s chat by @${user.username}.`, reason: 'chat_request',
  });
  const row = await record(pool, {
    messageId, appId: app.id, userId: user.id, kind: here.builds ? 'filed' : 'group',
    issueNumber: filed.issueNumber, title, replace: true,
  });
  // Where it stands as it is filed: held for the project's first version
  // (stageOf), its card and its chip say so from the start, never Reading.
  const [card] = await cardsOf(pool, { appId: app.id, user, rows: [row], builds: here.builds, typical: here.builds, deps });
  if (here.builds) {
    const status = card?.state?.stage === 'waiting_first_version' ? 'waiting_first_version' : 'reading';
    await setStatus(pool, { appId: app.id, messageId, issueNumber: filed.issueNumber, status, deps });
    if (filed.queueId) {
      const bot = await dmModule(deps).botAccount(pool);
      if (bot) {
        await require('./homeroom-bot-activity').startCard(pool, {
          app, issueNumber: filed.issueNumber, bot, jobKey: filed.queueId, settings: here.settings, filed: true,
          requester: {
            userId: user.id, username: user.username, issueTitle: title, firstVersion: false, askedText: words,
            isSynthetic: !!user.isSynthetic, hasPlatformAccess: !!(user.hasPlatformAccess || user.privateMember), isAdmin: !!user.isAdmin,
          },
          deps: { dm: dmModule(deps) },
        });
      }
    }
  }
  log.info('homeroom-bot-chat', 'Filed a request asked for in a project\'s chat', {
    app: app.slug, issueNumber: filed.issueNumber, userId: user.id, builds: here.builds,
    ...(card?.state?.stage === 'waiting_first_version' ? { waitsForFirstVersion: true } : {}),
  });
  return card;
}

// ── Fix in place: a mention asking to fix one of the bot's pending changes ──

/**
 * The bot's own changes on a project that are up for approval and not live
 * yet, newest first, one per request (its newest): { id, issueNumber,
 * title, firstVersion }.
 */
async function pendingChanges(pool, { appId, botId }) {
  if (!botId) return [];
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (cs.linked_issues[1]) cs.id, cs.pr_number, cs.linked_issues[1] AS issue_number,
              COALESCE(cs.session_title, cs.pr_title, q.issue_title) AS title,
              (COALESCE(q.first_version, FALSE) OR fv.app_id IS NOT NULL) AS first_version
         FROM chat_sessions cs
         LEFT JOIN homeroom_bot_requesters q ON q.app_id = cs.app_id AND q.issue_number = cs.linked_issues[1]
         LEFT JOIN homeroom_bot_first_versions fv ON fv.app_id = cs.app_id AND fv.issue_number = cs.linked_issues[1]
        WHERE cs.app_id = $1 AND cs.user_id = $2 AND cs.status = 'promoted' AND cs.is_headless = FALSE
          AND cardinality(cs.linked_issues) > 0
        ORDER BY cs.linked_issues[1], cs.id DESC
     ) pending
     ORDER BY id DESC
     LIMIT 10`,
    [appId, botId],
  );
  return rows.map((r) => ({
    id: Number(r.id), issueNumber: Number(r.issue_number), title: r.title || null, firstVersion: !!r.first_version,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
  }));
}

/**
 * What the message `messageId` replies to names: changes (the vote card the
 * bot's posts carry, a shared spec, a chip's Try it, a fix asked there) and
 * requests (a chip's, one asked there). { sessionIds, issueNumbers }.
 */
async function quotedRefs(pool, { appId, messageId }) {
  const { rows } = await pool.query(
    `SELECT q.metadata, r.issue_number, r.session_id
       FROM chat_messages m
       JOIN chat_messages q ON q.app_id = m.app_id
        AND q.id = CASE WHEN m.metadata->'quote'->>'refMsgId' ~ '^[0-9]{1,9}$'
                        THEN (m.metadata->'quote'->>'refMsgId')::int END
       LEFT JOIN chat_bot_requests r ON r.chat_message_id = q.id
      WHERE m.id = $1 AND m.app_id = $2 AND q.deleted_at IS NULL`,
    [messageId, appId],
  );
  const row = rows[0];
  if (!row) return { sessionIds: [], issueNumbers: [] };
  const meta = row.metadata || {};
  const ids = (list) => [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return {
    sessionIds: ids([meta.vote?.sessionId, meta.specShare?.sessionId, meta.botRequest?.sessionId, row.session_id]),
    issueNumbers: ids([meta.botRequest?.issueNumber, row.issue_number]),
  };
}

/** Pure: words as compared with a title: lower case, letters and digits. */
function plainWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Pure: the pending change (pendingChanges) a message asks about when it
 * says so itself, or null for the read to decide. In order: a link to one of
 * them in its words; the message it replies to; "the first version" when one
 * of them is the project's first version; or its title, word for word, when
 * exactly one title is in the words. { change, why }.
 */
function pickChange({ words, changes = [], slug = null, quoted = null }) {
  if (!changes.length) return null;
  const byId = (id) => changes.find((c) => c.id === Number(id)) || null;
  for (const m of String(words || '').matchAll(PROPOSAL_LINK_RE)) {
    if (slug && m[1].toLowerCase() !== String(slug).toLowerCase()) continue;
    const hit = m[2] === 'changes'
      ? changes.find((c) => c.prNumber != null && c.prNumber === Number(m[3])) || null
      : byId(m[3]);
    if (hit) return { change: hit, why: 'link' };
  }
  for (const id of quoted?.sessionIds || []) {
    const hit = byId(id);
    if (hit) return { change: hit, why: 'reply' };
  }
  for (const n of quoted?.issueNumbers || []) {
    const hit = changes.find((c) => c.issueNumber === Number(n));
    if (hit) return { change: hit, why: 'reply' };
  }
  if (FIRST_VERSION_RE.test(String(words || ''))) {
    const firsts = changes.filter((c) => c.firstVersion);
    if (firsts.length === 1) return { change: firsts[0], why: 'first_version' };
  }
  const said = ` ${plainWords(words)} `;
  const named = changes.filter((c) => {
    const title = plainWords(c.title);
    return title.split(' ').length >= 2 && said.includes(` ${title} `);
  });
  return named.length === 1 ? { change: named[0], why: 'title' } : null;
}

/** Pure: the pending changes as the read is offered them, by id ("c1", ...). */
function offeredChanges(changes) {
  return changes.slice(0, MAX_OFFERED_CHANGES).map((c, i) => ({ id: `c${i + 1}`, title: c.title, firstVersion: !!c.firstVersion }));
}

/**
 * Send one message's words to the bot's pending change `change`, through the
 * DM's own revise_proposal (homeroom-bot-mayor.js reviseProposal) with all of
 * its gates: posted in the change's discussion under their name, and the
 * bot's follow-up on it queued first. The message wears Fixing for everybody
 * in the room. Resolves { card }; a gate that refused resolves
 * { refused, card } with the card that says so, and nothing is recorded.
 */
async function reviseFromMessage(pool, config, { app, user, messageId, words, title, change, here, deps = {} }) {
  const bot = await dmModule(deps).botAccount(pool);
  if (!bot) throw new Error('no_bot_account');
  const ctx = {
    user, bot, config, settings: here.settings, userText: words, cards: [],
    // The mayor names the DM module dmSvc.
    deps: { ...deps, ...(deps.dm ? { dmSvc: deps.dm } : {}) },
  };
  const done = await mayorModule(deps).reviseProposal(pool, ctx, { proposal: change.id, change: title || words });
  if (!done?.ok) {
    log.info('homeroom-bot-chat', 'A fix asked for in a chat was refused', {
      app: app.slug, sessionId: change.id, userId: user.id, why: done?.error || null,
    });
    return {
      refused: true,
      card: {
        messageId: Number(messageId), kind: 'revise_refused', title: change.title || null, issueNumber: change.issueNumber,
        sessionId: change.id, ...(change.firstVersion ? { firstVersion: true } : {}),
      },
    };
  }
  const row = await record(pool, {
    messageId, appId: app.id, userId: user.id, kind: 'revise', issueNumber: change.issueNumber,
    title: change.title, sessionId: change.id, replace: true,
  });
  await setStatus(pool, { appId: app.id, messageId, issueNumber: change.issueNumber, status: 'fixing', sessionId: change.id, deps });
  log.info('homeroom-bot-chat', 'Sent a fix asked for in a project\'s chat to the bot\'s change', {
    app: app.slug, sessionId: change.id, issueNumber: change.issueNumber, userId: user.id,
  });
  const [card] = await cardsOf(pool, { appId: app.id, user, rows: [row], deps });
  return { card };
}

/**
 * The bot's pending changes on `app` a message may be asking about, and the
 * one it names itself (pickChange), when the bot builds here. Never throws.
 */
async function changesAsked(pool, { app, messageId, words, deps = {} }) {
  try {
    const bot = await dmModule(deps).botAccount(pool);
    const changes = await pendingChanges(pool, { appId: app.id, botId: bot?.id || null });
    if (!changes.length) return { changes, picked: null };
    const quoted = await quotedRefs(pool, { appId: app.id, messageId }).catch(() => null);
    return { changes, picked: pickChange({ words, changes, slug: app.slug, quoted }) };
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not read the bot\'s pending changes (filing as before)', { app: app.slug, err: err.message });
    return { changes: [], picked: null };
  }
}

/**
 * One message asked Homeroom bot for something: decide what it is (unless
 * `chosen`, the person picked "Make this a request" or File it) and act.
 * Resolves { ok, card } or { ok: false, status, error, code }.
 */
async function askFromMessage(pool, config, { app, user, messageId, content, chosen = false, deps = {} }) {
  const { rows: [already] } = await pool.query('SELECT * FROM chat_bot_requests WHERE chat_message_id = $1', [messageId]);
  // WP-C: Suggest it, under an offer this person was made, files it whether
  // or not the bot is theirs.
  const offered = chosen && already?.kind === 'offer' && Number(already.requester_id) === Number(user.id);
  const here = offered
    ? await filingFor(pool, { app, user, deps })
    : await botFor(pool, { app, user, deps });
  if (!here) return { ok: false, status: 403, error: 'Homeroom bot is not on for you yet.', code: 'not_enabled' };
  if (already && (already.issue_number != null || !chosen)) {
    const [card] = await cardsOf(pool, { appId: app.id, user, rows: [already], builds: here.builds, typical: here.builds, deps });
    return { ok: true, card, already: true };
  }
  const words = askedWords(content);
  if (!words) return { ok: false, status: 400, error: 'There is nothing in the message to ask for.', code: 'empty' };
  if (await filedLately(pool, user.id) >= FILINGS_PER_HOUR) {
    const card = { messageId: Number(messageId), kind: 'busy', title: null, issueNumber: null };
    pushCard(user.id, app.slug, card, deps);
    return { ok: false, status: 429, error: 'You\'ve asked me for a lot in the last hour. Try again in a little while.', code: 'busy', card };
  }
  let kind = 'change';
  // WP-C: File it / Suggest it keeps the title the card already showed.
  let title = chosen && already?.title ? already.title : null;
  // Fix in place: the bot's pending change this message asks to fix, if any.
  let target = null;
  if (!chosen) {
    const asked = here.builds ? await changesAsked(pool, { app, messageId, words, deps }) : { changes: [], picked: null };
    const offered = offeredChanges(asked.changes);
    try {
      const read = await (deps.readAsk || require('./llm').readChatAsk)({
        text: words, appName: app.name || app.slug, ...(offered.length ? { changes: offered } : {}),
      });
      kind = read?.kind || 'unsure';
      title = read?.title || null;
      // A change it names itself is that change, whichever the read thought;
      // otherwise the one the read named, of those it was offered.
      if (kind === 'revise' || (kind === 'change' && asked.picked)) {
        const named = offered.findIndex((o) => o.id === read?.change);
        target = asked.picked?.change || (named >= 0 ? asked.changes[named] : null);
        kind = target ? 'revise' : 'change';
      }
    } catch (err) {
      // No read: ask them, rather than file something they may not have meant.
      log.warn('homeroom-bot-chat', 'Could not read a message to Homeroom bot (asking first)', { app: app.slug, err: err.message });
      kind = 'unsure';
    }
  }
  if (kind === 'question' || kind === 'unsure') {
    const row = await record(pool, {
      messageId, appId: app.id, userId: user.id, kind, title: kind === 'unsure' ? (title || fallbackTitle(words)) : null,
    });
    const card = cardOf(row || { chat_message_id: messageId, kind, title: null, issue_number: null });
    pushCard(user.id, app.slug, card, deps);
    return { ok: true, card };
  }
  if (kind === 'revise' && target) {
    try {
      const out = await reviseFromMessage(pool, config, { app, user, messageId, words, title, change: target, here, deps });
      pushCard(user.id, app.slug, out.card, deps);
      return out.refused
        ? { ok: false, status: 409, error: 'I couldn\'t change it just now.', code: 'revise_refused', card: out.card }
        : { ok: true, card: out.card };
    } catch (err) {
      log.warn('homeroom-bot-chat', 'Could not send a fix asked for in a chat', { app: app.slug, userId: user.id, err: err.message });
      const card = { messageId: Number(messageId), kind: 'failed', title: null, issueNumber: null };
      pushCard(user.id, app.slug, card, deps);
      return { ok: false, status: 502, error: 'I couldn\'t send it just now. Try again in a minute.', code: 'revise_failed', card };
    }
  }
  try {
    const card = await fileMessage(pool, config, {
      app, user, messageId, words, title: title || fallbackTitle(words), here, deps,
    });
    pushCard(user.id, app.slug, card, deps);
    return { ok: true, card };
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not file a request asked for in a chat', { app: app.slug, userId: user.id, err: err.message });
    const card = { messageId: Number(messageId), kind: 'failed', title: null, issueNumber: null };
    pushCard(user.id, app.slug, card, deps);
    return { ok: false, status: 502, error: 'I couldn\'t file it just now. Try again in a minute.', code: 'file_failed', card };
  }
}

/** A project, as filing a request on it reads it. */
async function appRow(pool, appId) {
  const { rows } = await pool.query('SELECT id, slug, name, repo_url, self_hosted FROM apps WHERE id = $1', [appId]);
  return rows[0] || null;
}

/** A person, as hasBot and filing read them. */
async function personRow(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, username, is_synthetic AS "isSynthetic", (has_platform_access OR private_member_since IS NOT NULL) AS "hasPlatformAccess", is_admin AS "isAdmin"
       FROM users WHERE id = $1 AND anonymised_at IS NULL`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Called by the room (services/ws.js) after a person's message is stored
 * and broadcast. When it mentions Homeroom bot, in the main stream, typed by
 * a person, it is asked; anything else is nothing here. Never throws.
 */
async function noteChatMessage(pool, config, { appId, userId, messageId, content, thread = null, postedVia = null, deps = {} }) {
  try {
    if (thread || postedVia === 'agent' || !appId || !userId) return null;
    const mentioned = mentionsBot(content);
    // WP-C: an unmentioned message is read only for somebody new (maybeOffer).
    if (!mentioned && (wordCount(content) < OFFER_MIN_WORDS || !await isNewcomer(pool, appId, userId))) return null;
    // The room's socket knows little of either: read what filing needs.
    const [app, user] = await Promise.all([appRow(pool, appId), personRow(pool, userId)]);
    if (!app || !user) return null;
    if (!mentioned) return await maybeOffer(pool, { app, user, messageId, content, deps });
    return await askFromMessage(pool, config, { app, user, messageId, content, deps });
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not hand a chat message to Homeroom bot', { app: app?.slug, messageId, err: err.message });
    return null;
  }
}

/** Pure: how many words a message has. */
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * WP-C: a message from somebody new to the project, not addressed to the
 * bot. When it reads as an idea for the app, their card offers to suggest it
 * to the group. Resolves the card, or null. Never throws.
 */
async function maybeOffer(pool, { app, user, messageId, content, deps = {} }) {
  try {
    const words = String(content || '').replace(/\s+/g, ' ').trim();
    if (wordCount(words) < OFFER_MIN_WORDS) return null;
    const here = await newcomerHere(pool, { app, user, deps });
    if (!here) return null;
    if (!(deps.takeOfferRead || takeOfferRead)(Number(user.id))) return null;
    const read = await (deps.readAsk || require('./llm').readChatAsk)({
      text: words, appName: app.name || app.slug, toBot: false,
    });
    if (read?.kind !== 'change') return null;
    const row = await record(pool, {
      messageId, appId: app.id, userId: user.id, kind: 'offer', title: read.title || fallbackTitle(words),
    });
    if (!row) return null;
    const card = cardOf(row);
    pushCard(user.id, app.slug, card, deps);
    log.info('homeroom-bot-chat', 'Offered to suggest a newcomer\'s idea', { app: app.slug, userId: user.id, messageId });
    return card;
  } catch (err) {
    log.warn('homeroom-bot-chat', 'Could not offer to suggest a message', { app: app?.slug, messageId, err: err.message });
    return null;
  }
}

/**
 * "Make this a request" (or File it under the card that asked first), on a
 * message of the person's own in the room's main stream: the same as a
 * mention, without the read, since they chose. `dismiss` is Not now.
 */
async function requestFromMessage(pool, config, { app, user, messageId, dismiss = false, deps = {} }) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 404, error: 'Message not found' };
  const { rows: [message] } = await pool.query(
    `SELECT id, user_id, content, thread_type, msg_type, deleted_at, posted_via
       FROM chat_messages WHERE id = $1 AND app_id = $2`,
    [id, app.id],
  );
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Message not found' };
  if (Number(message.user_id) !== Number(user.id) || message.msg_type !== 'message' || message.thread_type) {
    return { ok: false, status: 403, error: 'Only a message of your own in the chat can be made a request.' };
  }
  if (dismiss) {
    await pool.query(
      `UPDATE chat_bot_requests SET kind = 'dismissed', updated_at = NOW()
        WHERE chat_message_id = $1 AND requester_id = $2 AND kind IN ('unsure', 'question', 'offer')`,
      [id, user.id],
    );
    return { ok: true, dismissed: true };
  }
  return askFromMessage(pool, config, { app, user, messageId: id, content: message.content, chosen: true, deps });
}

/**
 * The cards of one person's requests asked in one project's chat, for their
 * chat to draw under their own messages again after a reload. Theirs alone.
 */
async function myRequests(pool, { app, user, deps = {} }) {
  const here = await botFor(pool, { app, user, deps });
  const { rows } = await pool.query(
    `SELECT * FROM chat_bot_requests
      WHERE app_id = $1 AND requester_id = $2 AND kind <> 'dismissed'
      ORDER BY chat_message_id DESC LIMIT 100`,
    [app.id, user.id],
  );
  // Each says where its request stands now, and a chip a missed moment
  // left behind is put right for the room.
  const cards = await cardsOf(pool, {
    appId: app.id, user, rows, builds: true, typical: !!here?.builds, deps, reconcile: true,
  });
  return {
    bot: !!here,
    builds: !!here?.builds,
    cards,
  };
}

module.exports = {
  appRow,
  personRow,
  BOT_MENTION_RE,
  FILINGS_PER_HOUR,
  OFFER_WITHIN_DAYS,
  OFFERS_PER_PROJECT,
  OFFER_MIN_WORDS,
  OFFER_READS_PER_DAY,
  OFFER_READS_PER_HOUR,
  takeOfferRead,
  newcomerHere,
  isNewcomer,
  maybeOffer,
  wordCount,
  mentionsBot,
  askedWords,
  fallbackTitle,
  botFor,
  cardOf,
  approvalOf,
  CARD_STAGES,
  stageOf,
  chipFor,
  cardsOf,
  pendingChanges,
  quotedRefs,
  pickChange,
  offeredChanges,
  reviseFromMessage,
  setStatus,
  noteRequestStatus,
  noteChatMessage,
  askFromMessage,
  requestFromMessage,
  myRequests,
  record,
};
