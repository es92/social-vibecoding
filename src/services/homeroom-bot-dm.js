'use strict';

// #3624: the Homeroom bot, in a DM.
//
// The bot already reads a request, asks one question when something real
// is missing, writes a spec, builds it and opens a proposal
// (homeroom-bot.js, homeroom-bot-live.js). It says all of that on the
// request itself: a GitHub comment and the request's Homeroom thread. This
// module brings the same news to the person the request is FOR, in their
// direct conversation with the bot, so somebody who is not a developer can
// build without opening the agent chat:
//
//   - a question the bot asks arrives in the DM with suggested answers to
//     tap (and the composer for anything else);
//   - an answer given in the DM is posted on the request's discussion, as
//     the person's own message, which is what wakes the bot to look again.
//     The DM says so under every question: the request stays the public
//     record, and nobody in the group is left out of a decision;
//   - "building", "ready to vote on" and "live" reach the DM too;
//   - a project created with a description is built by the bot: it files
//     the description as the project's first-version request once the
//     project is running, and the loop above takes it from there. (Anybody
//     else's description is filed the same way, as the project's first
//     request, and left to the group: the bot is not involved.) A project
//     they import, fork or create without a description is acted on for
//     real too, with nothing filed first.
//
// Stage 2 (homeroom-bot-mayor.js): anything else a person writes in the DM
// is read by the bot's model, which can say what the bot is working on for
// them, pass an answer on, or offer to file a new request (filed only on a
// tap). The bot's news carries cards for its request or proposal.
//
// #3707: what the bot says back to a person's message quotes it, the way
// a person's reply does, and its later news about a request they started
// in the DM quotes the message it started from. With several requests in
// flight in one DM, each answer points at what it answers.
//
// Who it talks to is a list an admin keeps (`homeroom_bot_dm_users`), so it
// can be tried one person at a time. A person can also put themselves on it,
// or take themselves off, in Settings -> Experimental (setDmMember in
// homeroom-bot.js); the list's cap holds either way. What each person's
// requests may cost the platform in a week is capped
// (`homeroom_bot_user_weekly_cents`, $50 to start), apart from their own
// allowance for agents.
//
// Never a reason anything else fails: every entry point here is called
// best-effort, after the request, the post or the merge it follows.

const log = require('./logger');
const conversations = require('./conversations');

const BOT_USERNAME = 'homeroom_bot';
const META = conversations.BOT_METADATA_KEY;

// The kinds of post that ask the requester something: their DM message
// carries suggested answers, and a reply without a quote answers the
// newest one still open.
const QUESTION_KINDS = new Set(['question', 'followup_ask']);
// B3: the news a reply quoting it is posted on the request's public
// discussion for: a question, and the three that ask for a reply to look
// again with ("Reply to this message with more detail"). A reply to anything
// else the bot said about a request (an activity card, a ready or live
// message) stays in the DM and is read by the bot: quoting a progress card
// to ask "can the reminder be at 9am?" used to post that on the request.
// The client's reply bar reads the same list (messages/bot-question.tsx).
const MIRRORED_KINDS = new Set([...QUESTION_KINDS, 'blocked', 'person', 'empty']);
// The most a project description may hold. Long enough for a real brief,
// short enough to be one request body.
const MAX_BRIEF_CHARS = 4000;
const MIN_BRIEF_CHARS = 10;
// How often a person who is not on the list hears why the bot does not
// answer: once a day is enough.
const NOT_ENABLED_KEY_HOURS = 24;
// A first version that could not be filed is tried again on the next
// sweep, this many times.
const MAX_FILE_ATTEMPTS = 3;
// How often somebody writing to the bot with nothing open hears its help.
const HELP_EVERY_MS = 10 * 60 * 1000;

// A staging copy never files a GitHub issue: like the bot's own live posts
// (homeroom-bot-live.js isLiveFor), that is an irreversible side effect of
// a preview.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lower(value) {
  return String(value || '').replace(/^@/, '').trim().toLowerCase();
}

// ── Who it talks to ──────────────────────────────────────────────────────

function settingsModule() {
  // Lazy: homeroom-bot.js requires this module from readSettings.
  return require('./homeroom-bot');
}

/**
 * Whether the bot talks to this username in a DM, by the settings alone.
 * Being on the list is the whole gate: the bot's Mode decides whether it
 * works at all (its loop idles while Off), not who it talks to, so a
 * project described while it is off waits for it, and says so.
 */
function isDmUser(settings, username) {
  if (!settings) return false;
  const list = Array.isArray(settings.dmUsers) ? settings.dmUsers : [];
  return !!username && list.includes(lower(username));
}

/**
 * Whether the bot works for this person: builds the projects they describe,
 * brings their requests' news to their DM, and answers them there. Under the
 * bot's audience (homeroom-bot.js KEY_AUDIENCE):
 *   - `list`: being on the list is the whole gate (isDmUser);
 *   - `everyone`: anybody who may use the platform (platform access, which
 *     an admin always has), and never a synthetic account.
 * `person` is the signed-in user (req.user), or a requester (requesterFrom):
 * { username, isSynthetic, hasPlatformAccess, isAdmin }.
 * Pure. Whether the bot is switched on at all is its Mode's, not this.
 */
function hasBot(settings, person) {
  if (!settings || !person?.username) return false;
  if (settings.audience === 'everyone') {
    return !person.isSynthetic && !!(person.hasPlatformAccess || person.isAdmin);
  }
  return isDmUser(settings, person.username);
}

/** Whether this signed-in person builds through the bot's DM (the create dialog asks). */
async function isEnabledFor(pool, user) {
  if (!user || user.isSynthetic) return false;
  const settings = await settingsModule().readSettings(pool);
  return hasBot(settings, user);
}

/**
 * A requester row, read with what hasBot needs about the person (u.username,
 * u.is_synthetic, u.has_platform_access, u.is_admin), as the rest of this
 * module passes it.
 */
function requesterFrom(row, overrides = {}) {
  return {
    userId: row.user_id,
    username: row.username,
    firstVersion: !!row.first_version,
    issueTitle: row.issue_title,
    isSynthetic: !!row.is_synthetic,
    hasPlatformAccess: !!row.has_platform_access,
    isAdmin: !!row.is_admin,
    ...overrides,
  };
}

async function botAccount(pool) {
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE username = $1 AND is_synthetic = TRUE',
    [BOT_USERNAME],
  );
  return rows[0] || null;
}

// How a project with nothing to build first came to be (homeroom_bot_dm_projects).
const PROJECT_ORIGINS = Object.freeze(['import', 'fork', 'blank']);

/**
 * The projects the bot acts on for real because somebody still on the list
 * made them, oldest first, with who: one it builds from a description
 * (origin 'description'), and one they imported, forked or created without
 * one. A first request the bot does not build (its creator was not on the
 * list when they made it) never makes a project live, and neither does
 * anything made before its maker was on the list.
 */
async function projectsMadeFor(pool, settings) {
  const users = Array.isArray(settings?.dmUsers) ? settings.dmUsers : [];
  if (!users.length) return [];
  const { rows } = await pool.query(
    `SELECT a.slug, a.name, u.username, p.origin
       FROM (
         SELECT app_id, user_id, 'description' AS origin, created_at
           FROM homeroom_bot_first_versions WHERE bot_builds
         UNION ALL
         SELECT app_id, user_id, origin, created_at FROM homeroom_bot_dm_projects
       ) p
       JOIN apps a ON a.id = p.app_id
       JOIN users u ON u.id = p.user_id
      WHERE LOWER(u.username) = ANY($1::text[])
      ORDER BY p.created_at, a.id`,
    [users],
  );
  return rows.filter((r) => typeof r.slug === 'string');
}

/** The slugs of projectsMadeFor: what readSettings calls firstVersionApps. */
async function firstVersionAppSlugs(pool, settings) {
  return [...new Set((await projectsMadeFor(pool, settings)).map((r) => r.slug))];
}

/**
 * A project was just made with no description to build from
 * (routes/apps.js): imported, forked, or created without one. When its
 * maker is on the list it is recorded, and the bot acts on it for real
 * while they stay there, as on a project it builds from a description.
 * Nothing is filed and nothing is said in the DM: there is no first
 * version to build. Resolves true when it was recorded.
 */
async function noteProjectMade(pool, { app, user, origin }) {
  if (!app?.id || !user?.id || !PROJECT_ORIGINS.includes(origin)) return false;
  const settings = await settingsModule().readSettings(pool);
  if (!hasBot(settings, user)) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO homeroom_bot_dm_projects (app_id, user_id, origin) VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO NOTHING`,
    [app.id, user.id, origin],
  );
  if (rowCount) log.info('homeroom-bot-dm', 'Project made by somebody on the list is live for the bot', { app: app.slug, userId: user.id, origin });
  return rowCount > 0;
}

/**
 * When a project was imported by somebody on the list, or null: the issues
 * it arrived with are left until something happens on them after this.
 */
async function importedAt(pool, appId) {
  const { rows } = await pool.query(
    `SELECT created_at FROM homeroom_bot_dm_projects WHERE app_id = $1 AND origin = 'import'`,
    [appId],
  );
  return rows[0]?.created_at || null;
}

// ── Sending ──────────────────────────────────────────────────────────────

// Cards under one bot message (Messages allows six; three is plenty).
const MAX_CARDS = 3;

/** Pure: whether a post's news carries its proposal's card (cardsFor below). */
function hasProposalCard(dm) {
  const sessionId = Number(dm?.sessionId);
  return Number.isInteger(sessionId) && sessionId > 0;
}

/**
 * #3624 stage 2: the card a post's news is about. The proposal once there
 * is one (built, revised, merged), else the request itself. #7 (WP3): the
 * news that it went live leads with the app itself, which is what there is
 * to open now (`dm.appCard`), then the proposal.
 */
function cardsFor(kind, dm, app, issueNumber) {
  const appId = Number(app?.id);
  if (!Number.isInteger(appId) || appId <= 0) return [];
  const sessionId = Number(dm?.sessionId);
  if ((kind === 'proposal' || kind === 'followup_revise' || kind === 'merged') && hasProposalCard(dm)) {
    const proposal = { type: 'proposal', appId, sessionId };
    return kind === 'merged' && dm.appCard ? [{ type: 'app', appId }, proposal] : [proposal];
  }
  const n = Number(issueNumber);
  return Number.isInteger(n) && n > 0 ? [{ type: 'issue', appId, issueNumber: n }] : [];
}

// What routes/conversations.js does after a send, done here because the
// service pushes nothing (the welcome DM does the same).
async function pushLive(pool, result, conversationId, { opened = false } = {}) {
  const ws = require('./ws');
  const notificationSvc = require('./notifications');
  for (const row of result.notifications || []) await notificationSvc.hydrateAndPush(pool, row);
  if (opened) ws.pushConversationEvent(result.memberIds, { type: 'conversation_membership_changed', conversationId });
  ws.pushConversationEvent(result.memberIds, {
    type: 'conversation_message_created',
    conversationId,
    messageId: result.message?.id ?? result.messageId,
    threadRootId: null,
  });
}

/**
 * #3707: the person's message a bot message may quote, or null. Only their
 * own, in this DM's main stream, and still there to read: a send refuses a
 * quote from another conversation outright, and a message deleted or
 * hidden by moderation is not one to put back in front of them.
 */
async function quotable(pool, conversationId, userId, messageId) {
  const id = conversations.strictId(messageId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND thread_root_id IS NULL
        AND deleted_at IS NULL AND moderation_hidden_at IS NULL`,
    [id, conversationId, userId],
  );
  return rows.length ? id : null;
}

/**
 * One message from the bot to a person, in their DM with it (opened if it
 * is not yet). `metadata` is the message's structured part, shown to the
 * reader as `metadata.homeroomBot`. `objects` are cards under it (#3624
 * stage 2): the request or proposal it is about, as Messages' shared
 * objects ({ type: 'issue', appId, issueNumber } / { type: 'proposal',
 * appId, sessionId }). A card the bot cannot attach (a private project it
 * is not in) never costs the message: it is sent without its cards.
 * `replyToId` (#3707) is the person's message this one answers, quoted
 * above it as a person's reply quotes; one that cannot be quoted (see
 * quotable) is left off, never the message. #20 (WP3): `withoutCards` is
 * what the message says when its cards cannot go with it, for a message
 * whose words point at a card ("open the proposal below"): with the link
 * written out instead.
 * Resolves { conversationId, messageId, duplicate } or null when the person
 * blocked the bot or left the chat.
 */
// ── When the bot rings ───────────────────────────────────────────────────

// B4: a message from the bot notifies (a bell row and a push) only at four
// moments in a request's life, and when it answers what the person just
// wrote to it ('reply'). A first version used to ring six times: "setting
// up", its card, the question, a second card, "it's built", "it's live".
// Everything else (its progress card, "I'm building it now", a restart, a
// revision, an ack) is stored and counts as unread, and rings nothing.
const MOMENTS = Object.freeze({
  // Needs your answer.
  question: 'question', followup_ask: 'question', plan: 'question',
  // Ready to try.
  proposal: 'ready', ready: 'ready',
  // Stopped: it did not finish, or waits on something only time or a person changes.
  build_failed: 'stopped', blocked: 'stopped', person: 'stopped', empty: 'stopped',
  first_version_failed: 'stopped', preview_failed: 'stopped', allowance: 'held', paused: 'held',
  // Live.
  merged: 'live',
  // An answer to what they wrote: the model's, and its offer to file.
  chat: 'reply', confirm: 'reply',
});

/** Pure: the moment a message of the bot's rings at, by its kind, or null. */
function momentOf(metadata) {
  return MOMENTS[metadata?.kind] || null;
}

/**
 * B4: what a ringing message's notification carries (notifications.detail),
 * for the push and the bell to word it by (mobile-push-policy.js
 * botMomentCopy): "hrbot:<moment>:<app name>". A first version that is live
 * is the project being live; a change to a project with others in it is
 * "your change to" it. Never throws.
 */
async function notificationDetail(pool, moment, metadata) {
  if (!moment) return null;
  const appName = clip(String(metadata?.appName || '').replace(/\s+/g, ' '), 80);
  let said = moment;
  if (moment === 'live' && metadata?.firstVersion) said = 'live_first';
  if (moment === 'ready' && !metadata?.firstVersion && metadata?.appSlug) {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members
         FROM apps a WHERE a.slug = $1`,
      [metadata.appSlug],
    ).catch(() => ({ rows: [] }));
    if ((Number(rows?.[0]?.members) || 0) > 1) said = 'ready_group';
  }
  return `hrbot:${said}:${appName}`;
}

/**
 * Send one message from the bot to `userId`, in their DM with it. `moment`
 * (B4): whether it rings, and as what ('reply' for an answer to what they
 * just wrote); left out, its kind decides (MOMENTS), and anything else is
 * silent.
 */
async function sendDm(pool, {
  bot, userId, content, metadata = null, idempotencyKey = null, objects = null, replyToId = null, withoutCards = null,
  moment = undefined,
}) {
  if (!bot?.id || !userId) return null;
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, userId);
  if (!opened) return null;
  const input = { content: clip(content, conversations.MAX_MESSAGE_LENGTH || 8000) };
  const key = conversations.normalizeIdempotencyKey(idempotencyKey);
  if (key) input.idempotency_key = key;
  const quote = await quotable(pool, opened.conversationId, userId, replyToId);
  if (quote) input.reply_to_id = quote;
  const cards = Array.isArray(objects) ? objects.filter(Boolean).slice(0, MAX_CARDS) : [];
  const rings = moment === undefined ? momentOf(metadata) : (moment || null);
  const detail = rings ? await notificationDetail(pool, rings, metadata) : null;
  const send = (withCards) => conversations.sendMessage(pool, { id: bot.id }, opened.conversationId,
    withCards.length
      ? { ...input, objects: withCards }
      : { ...input, ...(cards.length && withoutCards ? { content: clip(withoutCards, conversations.MAX_MESSAGE_LENGTH || 8000) } : {}) },
    { metadata: metadata ? { [META]: metadata } : null, notify: !!rings, notificationDetail: detail });
  let result = await send(cards);
  if (!result && cards.length) {
    log.info('homeroom-bot-dm', 'Cards refused; sending the message without them', { userId, cards: cards.length });
    result = await send([]);
  }
  if (!result || result.error) {
    log.warn('homeroom-bot-dm', 'DM refused', { userId, error: result?.error || 'refused' });
    return null;
  }
  if (!result.duplicate) {
    try {
      await pushLive(pool, result, opened.conversationId, { opened: opened.created });
    } catch (err) {
      // The message and its bell row are in; a missed live refresh catches
      // up on the next load.
      log.warn('homeroom-bot-dm', 'Live fan-out failed', { userId, err: err.message });
    }
  }
  return {
    conversationId: opened.conversationId,
    messageId: result.messageId ?? result.message?.id ?? null,
    duplicate: !!result.duplicate,
  };
}

// ── Typing, while the bot answers ────────────────────────────────────────

// #3684: from the moment the bot starts on a person's message until its
// answer is sent, it shows as typing in their DM. It is the same
// `conversation_typing` event a person's composer sends (routes/
// conversations.js), to the same audience, so the Messages screen draws
// "homeroom_bot is typing…" with nothing new. A reader drops a typing line
// it has not heard again within 6 seconds (frontend/src/features/messages/
// store.ts), and a model's answer can take minutes, so the bot says it again
// every TYPING_RENEW_MS. It stops when the answer is sent or the handling
// fails, and at the latest TYPING_MAX_MS after it started whatever the
// handling is still doing, so the bot is never left typing forever: once
// nothing renews it, every reader clears the line on its own.
const TYPING_RENEW_MS = 4000;
const TYPING_MAX_MS = 3 * 60 * 1000;

// conversation id -> { holders: Map<holder, deadline>, timer }. A person can
// write again while the bot still answers their last message (the model's
// turns run one after another): the line stays up until the last answer is
// out, rather than going off between them.
const typingNow = new Map();
// conversation id -> the send in flight: a conversation's typing events go
// out in order, so a quick answer's "stopped" never overtakes its "typing".
const typingSends = new Map();

async function pushTyping(pool, botId, conversationId, typing, ws) {
  try {
    await conversations.withLockedAudience(pool, { id: botId }, conversationId, (audience) => {
      ws.pushConversationEvent(audience, {
        type: 'conversation_typing', conversationId, userId: botId, typing,
      }, { excludeUserId: botId });
    });
  } catch (err) {
    // Ephemeral: a missed typing event costs nothing the answer needs.
    log.warn('homeroom-bot-dm', 'Typing event failed', { conversationId, typing, err: err.message });
  }
}

function sendTyping(pool, botId, conversationId, typing, ws) {
  const prior = typingSends.get(conversationId) || Promise.resolve();
  const next = prior.then(() => pushTyping(pool, botId, conversationId, typing, ws));
  typingSends.set(conversationId, next);
  next.then(() => { if (typingSends.get(conversationId) === next) typingSends.delete(conversationId); });
  return next;
}

/**
 * Show the bot typing in one conversation until the returned stop() is
 * called, or TYPING_MAX_MS passes. Never throws.
 */
function startTyping(pool, { botId, conversationId, ws = null }) {
  const id = Number(conversationId);
  if (!botId || !Number.isSafeInteger(id) || id <= 0) return async () => {};
  const io = ws || require('./ws');
  let entry = typingNow.get(id);
  if (!entry) {
    const created = { holders: new Map(), timer: null };
    created.end = () => {
      clearInterval(created.timer);
      if (typingNow.get(id) === created) typingNow.delete(id);
      return sendTyping(pool, botId, id, false, io);
    };
    created.timer = setInterval(() => {
      const now = Date.now();
      for (const [holder, deadline] of created.holders) if (now >= deadline) created.holders.delete(holder);
      if (!created.holders.size) {
        log.warn('homeroom-bot-dm', 'Stopped typing: the answer took too long', { conversationId: id });
        created.end();
        return;
      }
      // One renewal at a time: a slow database never queues them up.
      if (!typingSends.has(id)) sendTyping(pool, botId, id, true, io);
    }, TYPING_RENEW_MS);
    created.timer.unref?.();
    typingNow.set(id, created);
    created.first = sendTyping(pool, botId, id, true, io);
    entry = created;
  }
  const holder = Symbol('typing');
  entry.holders.set(holder, Date.now() + TYPING_MAX_MS);
  const stop = async () => {
    // Already timed out, or another answer is still being written.
    if (!entry.holders.delete(holder) || entry.holders.size) return;
    await entry.end();
  };
  // Settles once "typing" has gone out (whileTyping waits for it).
  stop.ready = entry.first || Promise.resolve();
  return stop;
}

// The longest the answer waits for its "typing" to go out first.
const TYPING_FIRST_WAIT_MS = 2000;

/** Run `work` with the bot typing in the conversation, and stop when it settles. */
async function whileTyping(pool, { botId, conversationId, ws = null }, work) {
  const stop = startTyping(pool, { botId, conversationId, ws });
  // "typing" goes out before anything the answer does: a quick answer's own
  // events (its quote answered, its message) used to reach the reader first
  // when the typing event's audience lookup was slower than the answer.
  let waited = null;
  await Promise.race([
    Promise.resolve(stop.ready).catch(() => {}),
    new Promise((resolve) => { waited = setTimeout(resolve, TYPING_FIRST_WAIT_MS); waited.unref?.(); }),
  ]);
  clearTimeout(waited);
  try {
    return await work();
  } finally {
    await stop();
  }
}

// ── Who a request is for ─────────────────────────────────────────────────

/**
 * The person a request is for, recorded the first time the live loop looks
 * at it: whoever filed it (homeroom-bot-live.js issuePoster), or for a
 * first version the creator it was filed for. Resolves { userId, username,
 * firstVersion, issueTitle } or null when nobody on Homeroom filed it.
 */
async function recordRequester(pool, { app, repo, issueNumber, issue = null }) {
  const title = issue?.title ? clip(issue.title, 300) : null;
  const { rows: found } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, u.username, u.is_synthetic, u.has_platform_access, u.is_admin
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [app.id, issueNumber],
  );
  if (found.length) {
    const row = found[0];
    if (title && title !== row.issue_title) {
      await pool.query(
        'UPDATE homeroom_bot_requesters SET issue_title = $3 WHERE app_id = $1 AND issue_number = $2',
        [app.id, issueNumber, title],
      ).catch(() => {});
    }
    return requesterFrom(row, { issueTitle: title || row.issue_title });
  }
  const live = require('./homeroom-bot-live');
  const poster = await live.issuePoster(pool, { app, repo, issueNumber, issue });
  if (!poster) return null;
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     SELECT $1, $2, u.id, $4 FROM users u
      WHERE LOWER(u.username) = LOWER($3) AND u.is_synthetic = FALSE
     ON CONFLICT (app_id, issue_number) DO UPDATE SET issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title)
     RETURNING user_id, first_version, issue_title`,
    [app.id, issueNumber, poster, title],
  );
  if (!rows.length) return null;
  // Who they are, as hasBot reads it.
  const { rows: who } = await pool.query(
    'SELECT u.username, u.is_synthetic, u.has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [rows[0].user_id],
  );
  return requesterFrom({ ...rows[0], ...(who[0] || {}) }, { username: who[0]?.username || poster });
}

/** A person, as hasBot and noteOverAllowance read them, by id; null when there is none. */
async function personOf(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    'SELECT u.id AS user_id, u.username, u.is_synthetic, u.has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [userId],
  );
  return rows[0] ? requesterFrom(rows[0]) : null;
}

async function requesterOf(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, u.username, u.is_synthetic, u.has_platform_access, u.is_admin
       FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = $2`,
    [appId, issueNumber],
  );
  return rows[0] ? requesterFrom(rows[0]) : null;
}

/**
 * #3707: the person's DM message a request of theirs started from, for the
 * bot's later news about it to quote. A request starts in the DM when File
 * it files the bot's offer, and the offer quotes the message it answered
 * (homeroom-bot-mayor.js offer). Null for a request filed anywhere else.
 */
async function requestStart(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT o.reply_to_id FROM homeroom_bot_dm_actions a
       JOIN conversation_messages o ON o.id = a.message_id
      WHERE a.user_id = $1 AND a.app_id = $2 AND a.issue_number = $3 AND a.status = 'done'
      ORDER BY a.id DESC
      LIMIT 1`,
    [userId, appId, issueNumber],
  );
  return rows[0]?.reply_to_id ?? null;
}

// ── The weekly allowance ─────────────────────────────────────────────────

/**
 * What one person's building time has cost the bot this week, in cents: the
 * triage, spec, build and follow-up turns they paid for. A run is theirs
 * when they are its payer (the person whose action started it), or, with no
 * payer recorded, when the request is theirs. A run the bot caused itself is
 * not charged (homeroom_bot_runs.charged) and counts for nobody, and the
 * bot's answers in their DM are not building time at all: chatting never
 * runs out. The week starts Monday 00:00 UTC, as every weekly limit on the
 * platform does (limits.weekStartUtc) and as weekKey reads it.
 */
async function weeklySpentCents(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(r.cost_usd, 0) + COALESCE(r.build_cost_usd, 0)), 0) AS usd
       FROM homeroom_bot_runs r
       LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
      WHERE r.charged AND COALESCE(r.payer_user_id, q.user_id) = $1 AND r.created_at >= $2`,
    [userId, require('./limits').weekStartUtc()],
  );
  return Math.round((Number(rows[0]?.usd) || 0) * 100);
}

// The share of a week's building time left under which the next start card
// says so (activity.js), and the bot's own status answer calls it low.
const ALLOWANCE_LOW_SHARE = 0.2;

/** Whether this person has less than ALLOWANCE_LOW_SHARE of their week left. False with no cap. */
async function allowanceLow(pool, settings, userId) {
  const cap = Number(settings?.userWeeklyCents);
  if (!userId || !Number.isFinite(cap) || cap <= 0) return false;
  return cap - await weeklySpentCents(pool, userId) < cap * ALLOWANCE_LOW_SHARE;
}

/** Whether this person's requests have used their week's allowance. 0 means no cap. */
async function overWeeklyAllowance(pool, settings, userId) {
  const cap = Number(settings?.userWeeklyCents);
  if (!userId || !Number.isFinite(cap) || cap <= 0) return false;
  return (await weeklySpentCents(pool, userId)) >= cap;
}

function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Pure: what the person whose building time is used up hears about the
 * request it holds. No amount: the limit is building time, not money, and
 * on a project with others in it, somebody else can ask for it on theirs
 * (homeroom-bot-mayor.js start_request).
 */
function overAllowanceText({ title, appName, group = false }) {
  const what = clip(title, 80) || 'this request';
  return group
    ? `You've used this week's building time. I'll start ${what} on Monday, or someone else in ${appName} can ask me for it.`
    : `You've used this week's building time. I'll start ${what} on Monday.`;
}

/**
 * Said once a week, to the person whose building time holds a request back
 * (its payer; the requester unless somebody else asked for it), when the bot
 * talks to them.
 */
async function noteOverAllowance(pool, { settings, requester, payer = null, app, issueNumber, bot }) {
  const who = payer || requester;
  if (!who || !hasBot(settings, who)) return null;
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members
       FROM apps a WHERE a.id = $1`,
    [app.id],
  ).catch(() => ({ rows: [] }));
  const appName = app.name || app.slug;
  return sendDm(pool, {
    bot,
    userId: who.userId,
    replyToId: await requestStart(pool, { userId: who.userId, appId: app.id, issueNumber }),
    idempotencyKey: `hrbot-allowance-${who.userId}-${weekKey()}`,
    content: overAllowanceText({
      title: requester?.issueTitle || `${appName} request #${issueNumber}`,
      appName,
      group: (Number(rows[0]?.members) || 0) > 1,
    }),
    metadata: { kind: 'allowance', appSlug: app.slug, appName, issueNumber },
  });
}

// What the person hears when the bot's own weekly budget (its users row,
// limits.checkBudget) stops work of theirs that was about to start.
const PAUSED_FOR_WEEK_TEXT = 'I\'ve paused for the rest of the week. Your request is saved and I\'ll pick it up on Monday.';

/**
 * The bot's own weekly budget is spent (homeroom-bot.js pauseOnBudget), and
 * work of this person's was next: they hear it once a week, whichever
 * request it was, rather than finding the bot quiet. Resolves what sendDm
 * did, or null for somebody the bot does not talk to.
 */
async function notePausedForWeek(pool, { settings, bot, userId }) {
  if (!bot?.id || !userId) return null;
  const { rows } = await pool.query(
    'SELECT u.id AS user_id, u.username, u.is_synthetic, u.has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [userId],
  );
  if (!rows[0] || !hasBot(settings, requesterFrom(rows[0]))) return null;
  return sendDm(pool, {
    bot,
    userId,
    idempotencyKey: `hrbot-paused-${userId}-${weekKey()}`,
    content: PAUSED_FOR_WEEK_TEXT,
    metadata: { kind: 'paused' },
  });
}

// WP1 (#9): what the person hears when a build the platform restarted under
// is started again (homeroom-bot.js completeRecoveredLive).
const RESTARTED_TEXT = 'My build was interrupted, so I\'ve started it again. Nothing you need to do.';

/**
 * WP1 (#9): a build of one of their requests was interrupted (a restart
 * took its worker, or cut its plan short) and the request was sent back to
 * be built again: its requester hears it once per run, so the card going
 * back a step is never a mystery. Resolves what sendDm did, or null.
 */
async function noteBuildRestarted(pool, { app, issueNumber, runId }) {
  if (!app?.id || !runId) return null;
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (!requester || !hasBot(settings, requester)) return null;
  const bot = await botAccount(pool);
  if (!bot) return null;
  const context = {
    appName: app.name || app.slug, issueNumber,
    issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
  };
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    replyToId: await requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
    idempotencyKey: `hrbot-restart-${Number(runId)}`,
    content: `${requestLine(context)}\n\n${RESTARTED_TEXT}`,
    metadata: { kind: 'restarted', appSlug: app.slug, appName: context.appName, issueNumber },
  });
}

// ── The request's news, in the DM ────────────────────────────────────────

function requestLine({ appName, issueNumber, issueTitle, firstVersion }) {
  if (firstVersion) return `**${appName}**, its first version`;
  return `**${appName}** · request #${issueNumber}${issueTitle ? `: ${clip(issueTitle, 140)}` : ''}`;
}

/**
 * The DM text for one of the bot's posts on a request, from the structured
 * `dm` its caller passed (homeroom-bot.js): plain words, no code. Returns
 * null for a kind the DM does not carry.
 */
function dmText(kind, dm, context) {
  const line = requestLine(context);
  const it = context.firstVersion ? 'the first version' : 'this';
  switch (kind) {
    case 'question':
      return `${line}\n\nI have a question before I build ${it}:\n\n${clip(dm.question, 2000)}`;
    case 'followup_ask':
      return `${line}\n\nI have a question before I change the proposal:\n\n${clip(dm.question, 2000)}`;
    case 'spec':
      return `${line}\n\nI'm building ${it} now. I'll message you here when it's ready to try.`;
    // #20 (WP3): the proposal's card under the message is its link (cardsFor
    // attaches it whenever the news names its session), so the text points
    // at the card. The address is written out only when there is no card:
    // beside one it was a raw URL next to the same link, in the DM and in
    // its push.
    case 'proposal':
      return hasProposalCard(dm)
        ? `${line}\n\nIt's built. Open the proposal below to try the preview and vote on it.\n\nIt goes live once it is approved.`
        : `${line}\n\nIt's built. Open the proposal to try the preview and vote on it: ${dm.link}\n\n`
          + 'It goes live once it is approved.';
    case 'followup_revise': {
      let look = '';
      if (hasProposalCard(dm)) look = '\n\nTake another look at it below.';
      else if (dm.link) look = `\n\nTake another look: ${dm.link}`;
      return `${line}\n\nI changed the proposal after the latest replies: ${clip(dm.summary, 600)}${look}`;
    }
    case 'blocked':
      return `${line}\n\nI looked into this and can't build it as it's written: ${clip(dm.reason, 600)}\n\n`
        + 'Reply to this message with more detail and I\'ll look again.';
    case 'build_failed':
      return `${line}\n\nI tried to build ${it} but couldn't finish (${clip(dm.reason, 300) || 'unknown reason'}). `
        + 'A person can pick it up from here.';
    case 'person':
      // #3772: and what to do about it. "Left for the group" was a dead end
      // for somebody who was the group: a reply here is posted on the
      // request, and the bot looks at it again with it.
      return `${line}\n\nThis needs a person to decide, so I haven't built it: ${clip(dm.reason, 600)}\n\n`
        + 'If you decide to go ahead (or the group does), reply to this message and say so, and I\'ll look at it again.';
    case 'followup_person':
      return `${line}\n\nThis needs a person to decide, so I've left it for the group: ${clip(dm.reason, 600)}`;
    case 'empty':
      return `${line}\n\nI couldn't find anything to build in this yet. Reply to this message with what you'd like `
        + 'changed and I\'ll look again.';
    // A cap on how many changes the bot keeps waiting for approval held a
    // request it would build (homeroom-bot.js actOnVerdict). The cap's own
    // refresh brings it back when there is room, so nothing is asked of them.
    case 'held_proposals_per_app':
      return `${line}\n\nI can't start ${it} yet because ${context.appName} already has ${Number(dm.limit) || 'several'} `
        + 'changes waiting. I\'ll start when one is done.';
    case 'held_proposals_total':
      return `${line}\n\nI can't start ${it} yet because I already have ${Number(dm.limit) || 'many'} changes waiting `
        + 'across Homeroom. I\'ll start when one is done.';
    default:
      return null;
  }
}

/**
 * Close the questions still open on a request: a newer post about it (a
 * new question, the proposal, a hand-off) means the old ones are not what
 * the bot is waiting on any more. Their chips go away.
 */
async function closeOpenQuestions(pool, { userId, appId, issueNumber, ws = null }) {
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_dm_messages SET question_status = 'closed'
      WHERE user_id = $1 AND app_id = $2 AND issue_number = $3 AND question_status = 'open'
      RETURNING message_id, conversation_id`,
    [userId, appId, issueNumber],
  );
  for (const row of rows) await setQuestionState(pool, row.message_id, { status: 'closed' }, { ws, conversationId: row.conversation_id, userId });
  return rows.length;
}

/**
 * The requester of a request when the bot tells them its news in a DM:
 * { userId, username }, or null. Whether the bot's post on the request then
 * leaves them untagged is for untaggedRequester, from what the DM did.
 */
async function dmRecipient(pool, appId, issueNumber) {
  const settings = await settingsModule().readSettings(pool);
  if (settings.audience !== 'everyone' && !settings.dmUsers?.length) return null;
  const requester = await requesterOf(pool, appId, issueNumber);
  return requester && hasBot(settings, requester)
    ? { userId: requester.userId, username: requester.username }
    : null;
}

/**
 * #3698: the requester the bot's post on a request leaves untagged, once
 * relayIssuePost has run for it (`told` is what it resolved). Decided by
 * what the DM actually did, not by who it would go to: the requester when
 * it reached them (it rang in their DM, and the post would ring twice), or
 * when they blocked the bot (nothing from it is for them). Resolves their
 * username, or null when the post tags them like anybody else: they left
 * the bot's DM, the DM was refused or the relay failed, and the news still
 * has to reach them once.
 */
async function untaggedRequester(pool, { appId, issueNumber, bot, told = null }) {
  // WP1 (#6): news that was stale by the time it was relayed reached
  // nobody's DM on purpose, and the post does not ring them about it either.
  // B4: nor does "it's built" while the requester waits to hear it is ready.
  if ((told?.messageId || told?.stale || told?.deferred) && told.username) return told.username;
  if (!bot?.id) return null;
  const recipient = await dmRecipient(pool, appId, issueNumber);
  if (!recipient) return null;
  return await conversations.blockedEitherWay(pool, bot.id, recipient.userId) ? recipient.username : null;
}

/** Update a DM question's state in the message itself, so the reader's chips follow. */
async function setQuestionState(pool, messageId, patch, { ws = null, conversationId = null, userId = null } = {}) {
  const { rows } = await pool.query(
    'SELECT metadata, conversation_id, sender_id FROM conversation_messages WHERE id = $1',
    [messageId],
  );
  if (!rows.length) return;
  const metadata = rows[0].metadata && typeof rows[0].metadata === 'object' ? rows[0].metadata : {};
  const bot = metadata[META] && typeof metadata[META] === 'object' ? metadata[META] : {};
  await conversations.setMessageMetadata(pool, messageId, { ...metadata, [META]: { ...bot, ...patch } });
  const io = ws || require('./ws');
  const members = [rows[0].sender_id, userId].filter(Boolean);
  io.pushConversationEvent(members, {
    type: 'conversation_message_updated', conversationId: conversationId || rows[0].conversation_id, messageId, threadRootId: null,
  });
}

// #3767: the news an activity card that is still the newest message about
// its request already says, so it is not sent again.
const CARD_SAYS = new Set(['spec']);

// WP1 (#6): the news of one build, which can be overtaken before it is told.
const BUILD_NEWS = new Set(['spec', 'proposal', 'build_failed']);

/**
 * WP1 (#6): why one build's news (BUILD_NEWS) is stale by the time it is
 * relayed, or null. Another run's proposal for the request is up for a
 * vote, being merged, or merged since this run's verdict: the request is
 * answered, and this run is a second build of it. Or, for its plan and its
 * failure, a newer look at the request overtook this run. On 3 October a
 * second build of Plant Pal #1 said "I'm building this now" after the first
 * had said "It's built". A proposal is never stale for being older than the
 * newest look: it is the one people vote on, and they hear it is built.
 */
async function staleBuildNews(pool, { appId, issueNumber, runId, kind }) {
  const { rows: [row] = [] } = await pool.query(
    `SELECT EXISTS (
              SELECT 1 FROM homeroom_bot_runs n
               WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.id > r.id AND n.mode = 'live'
            ) AS overtaken,
            (SELECT cs.id FROM homeroom_bot_runs o
               JOIN chat_sessions cs ON cs.id = o.proposal_session_id
              WHERE o.app_id = r.app_id AND o.issue_number = r.issue_number AND o.id <> r.id
                AND cs.id IS DISTINCT FROM r.proposal_session_id AND cs.id IS DISTINCT FROM r.build_session_id
                AND (cs.status IN ('promoted', 'merging') OR (cs.status = 'merged' AND cs.merged_at >= r.created_at))
              ORDER BY o.id LIMIT 1) AS other_proposal
       FROM homeroom_bot_runs r
      WHERE r.id = $1 AND r.app_id = $2 AND r.issue_number = $3`,
    [runId, appId, issueNumber],
  );
  if (!row) return null;
  if (row.other_proposal) return `proposal ${Number(row.other_proposal)} already answers the request`;
  if (kind !== 'proposal' && row.overtaken) return 'a newer look at the request overtook it';
  return null;
}

/**
 * #3767: whether a person's DM has an activity card for this request:
 * null, or { messageId, conversationId, current } where `current` is true
 * while the card is the newest thing the DM says about the request.
 */
async function cardShown(pool, userId, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, kind FROM homeroom_bot_dm_messages
      WHERE user_id = $1 AND app_id = $2 AND issue_number = $3
      ORDER BY message_id DESC LIMIT 20`,
    [userId, appId, issueNumber],
  );
  const card = rows.find((r) => r.kind === 'activity');
  if (!card) return null;
  return { messageId: card.message_id, conversationId: card.conversation_id, current: rows[0] === card };
}

/**
 * Called by the bot's post on a request (homeroom-bot-live.js `post`) when
 * the post carries `dm`: the same news, in the requester's DM, when they
 * are somebody the bot talks to there. Resolves what was sent, with who it
 * went to ({ conversationId, messageId, duplicate, userId, username }), or
 * null when nothing reached them.
 */
async function relayIssuePost({
  pool, ws = null, app, issueNumber, kind, runId = null, postId = null, bot, dm, ready = false, key = null,
}) {
  if (!dm || !bot?.id) return null;
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (!requester || !hasBot(settings, requester)) return null;
  const context = {
    appName: app.name || app.slug,
    appSlug: app.slug,
    issueNumber,
    issueTitle: requester.issueTitle,
    firstVersion: requester.firstVersion,
  };
  const content = dmText(kind, dm, context);
  if (!content) return null;
  // WP1 (#6): a build's news that something newer overtook is not sent.
  if (BUILD_NEWS.has(kind) && runId) {
    const stale = await staleBuildNews(pool, { appId: app.id, issueNumber, runId, kind }).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not check whether news is stale (sending it)', { app: app.slug, issueNumber, kind, err: err.message });
      return null;
    });
    if (stale) {
      log.info('homeroom-bot-dm', 'Stale news not sent', { app: app.slug, issueNumber, kind, runId, why: stale });
      return { conversationId: null, messageId: null, stale: true, userId: requester.userId, username: requester.username };
    }
  }
  // B4: "it's built" waits until it is ready to try: its preview is up and
  // its checks passed or were skipped (noteChangeReady, from every place a
  // check verdict lands). Said to the post as told, so the post does not tag
  // them either: they hear it once, when they can try it.
  let sendKey = key;
  if (kind === 'proposal' && !ready && hasProposalCard(dm)) {
    const state = await changeReadiness(pool, dm.sessionId);
    if (state && !state.ready) {
      log.info('homeroom-bot-dm', 'A change is up; its requester hears when it is ready to try', {
        app: app.slug, issueNumber, sessionId: Number(dm.sessionId) || null,
      });
      return { conversationId: null, messageId: null, deferred: true, userId: requester.userId, username: requester.username };
    }
    if (state) sendKey = readyKey(dm.sessionId, state.epoch);
  }
  // #3767: the request's activity card already shows it. While the card is
  // the newest thing in the DM about the request, "I'm building this now"
  // repeats it word for word, so it is not sent; and no news about the
  // request carries the request's card again under it. Said to the post as
  // told (it is in front of them), so the post does not tag them instead.
  const shown = await cardShown(pool, requester.userId, app.id, issueNumber);
  // B4: one card follows a request through every look, so while it has one,
  // that card says it, wherever it sits.
  if (shown && CARD_SAYS.has(kind)) {
    return {
      conversationId: shown.conversationId, messageId: shown.messageId, duplicate: true,
      userId: requester.userId, username: requester.username, card: true,
    };
  }
  const asks = QUESTION_KINDS.has(kind);
  const answers = asks ? (Array.isArray(dm.answers) ? dm.answers : []).filter((a) => typeof a === 'string' && a.trim()) : [];
  const metadata = {
    kind,
    appSlug: app.slug,
    appName: context.appName,
    issueNumber,
    ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
    ...(context.firstVersion ? { firstVersion: true } : {}),
    // A reply to this message is posted on the request, publicly.
    ...(MIRRORED_KINDS.has(kind) ? { mirrors: true } : {}),
    ...(asks ? { question: clip(dm.question, 2000), answers, status: 'open' } : {}),
    ...(dm.link ? { link: dm.link } : {}),
  };
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content,
    withoutCards: dmText(kind, { ...dm, sessionId: null }, context),
    metadata,
    idempotencyKey: sendKey || (postId ? `hrbot-post-${postId}` : null),
    objects: cardsFor(kind, dm, app, issueNumber).filter((c) => !(shown && c.type === 'issue')),
    // #3707: news about a request they started here points back at it.
    replyToId: await requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
  });
  if (!sent?.messageId) return null;
  const told = { ...sent, userId: requester.userId, username: requester.username };
  // The same post relayed again (a retry) was already sent and recorded.
  if (sent.duplicate) return told;
  // #3698: from here the DM is in front of them, so what follows failing
  // is logged rather than thrown: a relay that throws is one the post
  // makes up for by tagging them, and this one did reach them.
  try {
    // Whatever this post says, it is the request's news now: an older
    // question about it is not waiting for an answer any more.
    await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages
         (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, question_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (message_id) DO NOTHING`,
      [sent.messageId, requester.userId, sent.conversationId, app.id, issueNumber, kind, runId, asks ? 'open' : null],
    );
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Told the requester, but could not record it', {
      app: app.slug, issueNumber, kind, userId: requester.userId, err: err.message,
    });
    return told;
  }
  log.info('homeroom-bot-dm', 'Told the requester in their DM', {
    app: app.slug, issueNumber, kind, userId: requester.userId, question: asks,
  });
  return told;
}

// ── Ready to try ─────────────────────────────────────────────────────────

// B4: the check verdicts that make a change ready to try.
const READY_CHECKS = new Set(['passing', 'skipped']);

/** Pure: the key one change's "ready" is sent once under, per approval epoch. */
function readyKey(sessionId, epoch) {
  return `hrbot-ready-${Number(sessionId)}-${Number(epoch) || 0}`;
}

/**
 * B4: whether one of the bot's changes is ready to try: up for approval, with
 * its checks passed or skipped. Resolves { ready, epoch }, or null for no
 * such change.
 */
async function changeReadiness(pool, sessionId) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(
    'SELECT status, check_state, approval_epoch FROM chat_sessions WHERE id = $1', [id],
  );
  if (!rows[0]) return null;
  return {
    ready: rows[0].status === 'promoted' && READY_CHECKS.has(rows[0].check_state),
    epoch: Number(rows[0].approval_epoch) || 0,
  };
}

/**
 * B4: a check verdict landed on a change (visuals.noteBotChecksAfterChecks,
 * called from every place one does). When it is one of the bot's changes and
 * it is ready to try now, its requester hears so, once per approval epoch:
 * "It's built" used to go out the moment the change went up, often with its
 * checks still running. A failing verdict is the bot's own to fix, quietly
 * (homeroom-bot.js noteProposalChecks). Never throws; resolves what was sent.
 */
async function noteChangeReady(pool, sessionId, deps = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const state = await changeReadiness(pool, id);
    if (!state?.ready) return null;
    const { rows } = await pool.query(
      `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name
         FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
        WHERE r.proposal_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    if (!rows[0]) return null;
    const run = rows[0];
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const domain = deps.domain || require('./caddy').USERNODE_DOMAIN;
    const link = require('./homeroom-bot-live').proposalLink(domain, run.slug, id);
    return await relayIssuePost({
      pool, ws: deps.ws || null, app: { id: run.id, slug: run.slug, name: run.name }, issueNumber: Number(run.issue_number),
      kind: 'proposal', runId: Number(run.run_id), bot, dm: { link, sessionId: id }, ready: true, key: readyKey(id, state.epoch),
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change is ready', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * B4: one of the bot's changes cannot be tried yet for a reason that is not
 * the bot's to fix in it (`why`: 'preview', its preview did not start). Its
 * requester hears it once per approval epoch, as the "stopped" moment; the
 * retries go on, and "ready" follows if one of them works. Never throws.
 */
async function noteChangeStopped(pool, sessionId, { why = 'preview', deps = {} } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT r.issue_number, a.id, a.slug, a.name, cs.status, cs.approval_epoch
         FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id JOIN chat_sessions cs ON cs.id = r.proposal_session_id
        WHERE r.proposal_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    const run = rows[0];
    if (!run || run.status !== 'promoted') return null;
    const settings = await settingsModule().readSettings(pool);
    const requester = await requesterOf(pool, run.id, Number(run.issue_number));
    if (!requester || !hasBot(settings, requester)) return null;
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const context = {
      appName: run.name || run.slug, issueNumber: Number(run.issue_number),
      issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
    };
    return await sendDm(pool, {
      bot,
      userId: requester.userId,
      replyToId: await requestStart(pool, { userId: requester.userId, appId: run.id, issueNumber: context.issueNumber }),
      idempotencyKey: `hrbot-stopped-${why}-${id}-${Number(run.approval_epoch) || 0}`,
      content: `${requestLine(context)}\n\nI built it, but its preview didn't start, so it isn't ready to try yet. `
        + 'I\'m trying again, and I\'ll tell you here when it\'s ready.',
      metadata: {
        kind: 'preview_failed', appSlug: run.slug, appName: context.appName, issueNumber: context.issueNumber,
        ...(context.firstVersion ? { firstVersion: true } : {}),
      },
      objects: cardsFor('proposal', { sessionId: id }, { id: run.id }, context.issueNumber),
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change is stuck', { sessionId: id, err: err.message });
    return null;
  }
}

// #7 (WP3): how many times, and how far apart, a merged app's health is read
// before its requester is told it is live now.
const LIVE_PROBES = 3;
const LIVE_PROBE_WAIT_MS = 5000;

/**
 * #8 (WP3): one of the bot's proposals was promoted, merged, or closed:
 * whoever asked for the request it answers has their activity tray read
 * again (homeroom-bot-tray.js noteWorkChanged). The loop announces the work
 * it starts and finishes itself; these three ends happen outside it, and
 * the tray in an open DM kept saying "Working on…" past them. The build
 * session becomes the proposal, so a proposal just promoted is found by its
 * build too, before its run records it. Resolves the requester's id, or
 * null for a session that is not the bot's. Never throws.
 */
async function noteProposalChanged(pool, sessionId, deps = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT q.user_id
         FROM homeroom_bot_runs r
         JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
        WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    if (!rows.length) return null;
    require('./homeroom-bot-tray').noteWorkChanged(rows[0].user_id, deps);
    return Number(rows[0].user_id);
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not announce a change to the bot\'s proposal', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * Pure (#7, WP3): what the requester is told when the bot's proposal for
 * them merged. "Live now" only once the app answered its health check on
 * the build that merge deployed (`live`). The platform's own app
 * (`platform`) is released after the merge and outside this process, so it
 * merged and will be live in a few minutes, as the merge's own line in its
 * discussion says (routes/votes.js liveSoon); so is a child app whose
 * health could not be confirmed yet. `card`: the app's card goes under it.
 */
function mergedText({ line, appName, live, platform = false, card = true }) {
  const said = live ? 'It was approved and is live now.' : 'It was approved and merged, and it\'ll be live in a few minutes.';
  const open = card && !platform ? ` Open ${appName} below to try it${live ? '' : ' then'}.` : '';
  return `${line}\n\n${said}${open}`;
}

/**
 * #7 (WP3): whether a child app answers its health check after the merge
 * deployed `sha` (staging.rebuildProduction, which already waited for the
 * rollout). Read a few times, a few seconds apart, before it says no. No
 * config, no deployed SHA, or the platform's own app: no.
 */
async function liveAfterMerge(config, app, { sha = null, deps = {} } = {}) {
  if (!config || !app || app.self_hosted || !sha) return false;
  const runtime = deps.applicationRuntime || require('./application-runtime');
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  let ref;
  try { ref = runtime.productionRef(config, app); } catch { return false; }
  for (let attempt = 1; attempt <= LIVE_PROBES; attempt += 1) {
    if (await Promise.resolve(runtime.probeHealth(config, ref, { timeoutMs: 3000 })).catch(() => false)) return true;
    if (attempt < LIVE_PROBES) await sleep(LIVE_PROBE_WAIT_MS);
  }
  log.warn('homeroom-bot-dm', 'A merged app did not answer its health check; saying it will be live soon', { app: app.slug, sha });
  return false;
}

/**
 * A proposal the bot built is merged: its requester hears it in their DM.
 * #7 (WP3): `sha` is what the merge deployed (routes/votes.js finalizeMerge),
 * and "live now" waits for the app to answer its health check on it
 * (liveAfterMerge). The news carries the app's own card, to open it, and the
 * proposal's, and records the app's address as its link.
 */
async function noteProposalMerged(pool, session, { config = null, sha = null, deps = {} } = {}) {
  if (!session?.id) return null;
  const { rows } = await pool.query(
    `SELECT r.app_id, r.issue_number, a.slug, a.name, a.self_hosted, a.runtime_kind, a.runtime_name
       FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
      WHERE r.proposal_session_id = $1
      ORDER BY r.id DESC LIMIT 1`,
    [session.id],
  );
  if (!rows.length) return null;
  const run = rows[0];
  const requester = await requesterOf(pool, run.app_id, run.issue_number);
  // #8: their activity tray reads again, whether or not the DM says it.
  if (requester) require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
  const settings = await settingsModule().readSettings(pool);
  if (!requester || !hasBot(settings, requester)) return null;
  const bot = await botAccount(pool);
  if (!bot) return null;
  await closeOpenQuestions(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number });
  const context = {
    appName: run.name || run.slug, issueNumber: run.issue_number,
    issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
  };
  const platform = !!run.self_hosted;
  const live = await liveAfterMerge(config, { ...run, id: run.app_id }, { sha, deps });
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    replyToId: await requestStart(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number }),
    idempotencyKey: `hrbot-merged-${session.id}`,
    content: mergedText({ line: requestLine(context), appName: context.appName, live, platform }),
    withoutCards: mergedText({ line: requestLine(context), appName: context.appName, live, platform, card: false }),
    metadata: {
      kind: 'merged', appSlug: run.slug, appName: context.appName, issueNumber: run.issue_number,
      link: `#app/${encodeURIComponent(run.slug)}`, live,
      ...(context.firstVersion ? { firstVersion: true } : {}),
    },
    // The platform's own app has no app of its own to open: its proposal.
    objects: cardsFor('merged', { sessionId: session.id, appCard: !platform }, { id: run.app_id }, run.issue_number),
  });
}

// ── A person writing to the bot ──────────────────────────────────────────

const HELP_TEXT = [
  'I build things for you on Homeroom. Create a project and describe what it should do, or post a request on a',
  'project, and I\'ll take it from there. When I have a question I\'ll ask it here: tap one of my suggested',
  'answers or write your own.',
].join(' ');

// #3624: somebody not on the list can join it themselves, so the answer
// says where.
const NOT_ENABLED_TEXT = 'I\'m not taking your requests in messages yet. To try it, turn on Homeroom bot in '
  + 'Settings, under Experimental. Until then, post a request on a project\'s page and I\'ll answer it there.';

/** Whether this conversation is the person's direct conversation with the bot. */
async function isBotDirect(pool, conversationId, botId, userId) {
  const [low, high] = conversations.normalizePair(botId, userId);
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_direct_pairs
      WHERE conversation_id = $1 AND user_low_id = $2 AND user_high_id = $3`,
    [conversationId, low, high],
  );
  return rows.length > 0;
}

/** The bot message a person quoted, when it was about a request of theirs. */
async function quotedTarget(pool, userId, quotedId) {
  if (!quotedId) return null;
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status
       FROM homeroom_bot_dm_messages WHERE message_id = $1 AND user_id = $2`,
    [quotedId, userId],
  );
  return rows[0] || null;
}

/** The newest question the bot asked this person that is still open. */
async function newestOpenQuestion(pool, userId, { appId = null, issueNumber = null } = {}) {
  const { rows } = await pool.query(
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status
       FROM homeroom_bot_dm_messages
      WHERE user_id = $1 AND question_status = 'open'
        AND ($2::int IS NULL OR app_id = $2) AND ($3::int IS NULL OR issue_number = $3)
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`,
    [userId, appId, issueNumber],
  );
  return rows[0] || null;
}

/** The text a DM answer is posted on the request with. */
function mirroredText(content, { question = false } = {}) {
  return `${clip(content, 3500)}\n\n(${question ? 'Answered' : 'Sent'} in a chat with Homeroom bot.)`;
}

/**
 * Post a person's words on a request's discussion, as their own message:
 * an answer to the bot's open question there, or a reply about the request.
 * That is what wakes the bot, and the request goes to the front of its
 * queue (#3624 stage 2) so the answer is looked at next. `prepared` text
 * already says it was sent from the chat (#3768, the model's
 * comment_on_request); `reason` is the queue's. Resolves
 * { ok, app, line, question } or { ok: false, why, app, line }.
 */
async function postOnRequest(pool, { user, target, text, prepared = false, reason = 'dm_answer', deps = {} }) {
  const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  const app = apps[0];
  if (!app) return { ok: false, why: 'gone', app: null, line: null };
  const line = `${app.name || app.slug} request #${target.issue_number}`;
  const question = target.question_status === 'open';
  const ws = deps.ws || require('./ws');
  const content = prepared ? clip(text, 3900) : mirroredText(text, { question });
  const posted = await ws.handleMessage(
    pool,
    { user, appId: app.id, appSlug: app.slug, postedVia: null },
    { type: 'chat', content, thread: { type: 'issue', ref: Number(target.issue_number) } },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    log.warn('homeroom-bot-dm', 'Could not post a DM answer on its request', {
      app: app.slug, issueNumber: target.issue_number, userId: user.id, code: posted?.code || null,
    });
    const why = posted?.code === 'not_collaborator' || posted?.code === 'join_required'
      ? `you need to be a member of ${app.name || app.slug} to take part in its requests`
      : 'something went wrong on my side';
    return { ok: false, why, app, line, question };
  }
  if (question) {
    await pool.query(
      `UPDATE homeroom_bot_dm_messages
          SET question_status = 'answered', answered_at = NOW(), answer_message_id = $2
        WHERE message_id = $1`,
      [target.message_id, deps.answerMessageId || null],
    );
    await setQuestionState(pool, target.message_id, { status: 'answered', answer: clip(text, 300) }, {
      ws, conversationId: target.conversation_id, userId: user.id,
    });
  }
  try {
    await settingsModule().enqueueFront(pool, {
      appId: app.id, issueNumber: Number(target.issue_number), userId: user.id, reason,
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not put the answered request first', { app: app.slug, err: err.message });
  }
  log.info('homeroom-bot-dm', 'Posted a DM reply on its request', {
    app: app.slug, issueNumber: target.issue_number, userId: user.id, question,
  });
  return { ok: true, app, line, question };
}

/**
 * #3740: post a person's words in the discussion of the bot's own proposal,
 * as their own message: exactly what a reply typed there is, under the same
 * gates (somebody who may write in the project's discussion), and what the
 * bot's follow-up on that proposal reads (homeroom-bot.js runFollowUp). The
 * request it answers then goes to the front of the queue, as an answered
 * question's does, so the follow-up is next rather than after the next
 * sweep. Resolves { ok, queued } or { ok: false, why }. `queued` is false
 * while a follow-up on it runs right now (that run ends first, and the
 * reply is read after it), and null when it could not be put first: the
 * post still wakes the bot, as any reply there does.
 */
async function postOnProposal(pool, { user, app, sessionId, issueNumber, text, deps = {}, payerId = null }) {
  const ws = deps.ws || require('./ws');
  const posted = await ws.handleMessage(
    pool,
    { user, appId: app.id, appSlug: app.slug, postedVia: null },
    { type: 'chat', content: clip(text, 3900), thread: { type: 'session', ref: Number(sessionId) } },
  ).catch((err) => ({ ok: false, code: err.message }));
  if (!posted?.ok) {
    log.warn('homeroom-bot-dm', 'Could not post a DM change on its proposal', {
      app: app.slug, sessionId, userId: user.id, code: posted?.code || null,
    });
    const why = posted?.code === 'not_collaborator' || posted?.code === 'join_required'
      ? `you need to be a member of ${app.name || app.slug} to take part in its discussion`
      : 'something went wrong on my side';
    return { ok: false, why };
  }
  let queued = null;
  try {
    queued = !!(await settingsModule().enqueueFront(pool, {
      appId: app.id, issueNumber: Number(issueNumber), userId: user.id, reason: 'dm_revise',
      // Whoever asked for the change pays for it (homeroom-bot.js billingOf).
      payerId,
    }));
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not put the proposal\'s follow-up first', { app: app.slug, err: err.message });
  }
  log.info('homeroom-bot-dm', 'Posted a DM change on the bot\'s proposal', {
    app: app.slug, sessionId, issueNumber, userId: user.id, queued,
  });
  return { ok: true, queued };
}

/** The deterministic path: words posted on the request, and the bot says where. */
async function answerOnRequest(pool, { bot, user, target, message, deps = {} }) {
  const text = String(message.content || '').trim();
  const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  if (!apps[0]) return null;
  const line = `${apps[0].name || apps[0].slug} request #${target.issue_number}`;
  if (!text) {
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I can only pass words on to ${line} for now. Write your answer as a message.`,
      moment: 'reply',
    });
  }
  const posted = await postOnRequest(pool, { user, target, text, deps: { ...deps, answerMessageId: message.id } });
  if (!posted.ok) {
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
      content: `I couldn't post that on ${line}: ${posted.why}. Nothing was sent.`,
      moment: 'reply',
    });
  }
  return sendDm(pool, {
    bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-ack-${message.id}`,
    content: posted.question
      ? `Thanks. I posted your answer on ${line}'s public discussion and I'm looking at it again now.`
      : `I posted that on ${line}'s public discussion. I'll look at it again now.`,
    metadata: {
      kind: 'ack', appSlug: posted.app.slug, appName: posted.app.name || posted.app.slug,
      issueNumber: Number(target.issue_number),
    },
  });
}

/**
 * Called after a person's message lands in a conversation
 * (routes/conversations.js). When it is their DM with the bot:
 *   - a tap on File it / Not now under something the bot offered decides it
 *     (homeroom-bot-mayor.js);
 *   - a reply quoting one of the bot's messages about a request is posted on
 *     that request's discussion as their message (which wakes the bot), and
 *     the bot says where it went: a tapped answer always takes this path;
 *   - anything else is read by the bot's model (#3624 stage 2), which can
 *     say what it is working on for them, pass an answer on, or offer to
 *     file a new request. With that switched off, it is the answer to the
 *     newest open question, or else the bot's short help.
 * Whichever it is, what the bot says back quotes the message (#3707).
 * The bot shows as typing in the DM until its answer is sent (#3684).
 */
async function noteUserMessage(pool, config, { user, conversationId, message, deps = {} }) {
  if (!user?.id || !message?.id || user.isSynthetic) return null;
  const bot = deps.bot || await botAccount(pool);
  if (!bot || bot.id === user.id) return null;
  if (!(await isBotDirect(pool, conversationId, bot.id, user.id))) return null;
  const settings = await settingsModule().readSettings(pool);
  if (!hasBot(settings, user)) {
    const hour = Math.floor(Date.now() / (NOT_ENABLED_KEY_HOURS * 3600 * 1000));
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, content: NOT_ENABLED_TEXT, idempotencyKey: `hrbot-notyet-${user.id}-${hour}`,
      moment: 'reply',
    });
  }
  // #3684: typing from here until the answer is sent (whileTyping above).
  return whileTyping(pool, { botId: bot.id, conversationId, ws: deps.ws },
    () => answerUserMessage(pool, config, { bot, user, settings, conversationId, message, deps }));
}

/** What noteUserMessage does with a message from somebody on the list, while the bot types. */
async function answerUserMessage(pool, config, { bot, user, settings, conversationId, message, deps }) {
  const mayor = deps.mayor || require('./homeroom-bot-mayor');
  const quoted = message?.reply?.id || null;
  if (quoted) {
    const decided = await mayor.decideOffer(pool, config, { bot, user, settings, conversationId, message, deps });
    if (decided) return decided;
    // B3: only an answer to a question, or a reply a message asked for, goes
    // on the request; any other quote is for the bot (MIRRORED_KINDS).
    const target = await quotedTarget(pool, user.id, quoted);
    if (target && MIRRORED_KINDS.has(target.kind)) return answerOnRequest(pool, { bot, user, target, message, deps });
  }
  // #3772: "file it" typed under a draft decides it as the tap does. Typed,
  // it went to the model, which answered "Filed: … #14" for a request that
  // was never filed.
  let turnDeps = deps;
  if (!quoted && typeof mayor.decideTyped === 'function') {
    const typed = await mayor.decideTyped(pool, config, { bot, user, settings, conversationId, message, deps });
    if (typed?.sent) return typed.sent;
    if (typed?.decisionWithoutOffer) turnDeps = { ...deps, decisionWithoutOffer: true };
  }
  if (settings.dmChat !== false) {
    return mayor.runDmTurn(pool, config, { bot, user, settings, conversationId, message, deps: turnDeps });
  }
  // A quote of anything but a question is not an answer to some other open
  // question (MIRRORED_KINDS): without the model, it gets the help text.
  const target = quoted ? null : await newestOpenQuestion(pool, user.id);
  if (!target) {
    // Once in a while, not after every message.
    const window = Math.floor(Date.now() / HELP_EVERY_MS);
    return sendDm(pool, {
      bot, userId: user.id, replyToId: message.id, content: HELP_TEXT, idempotencyKey: `hrbot-help-${user.id}-${window}`,
      moment: 'reply',
    });
  }
  return answerOnRequest(pool, { bot, user, target, message, deps });
}

// ── A project built from its description ─────────────────────────────────

/** A description fit to build from, or null. */
function normalizeBrief(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < MIN_BRIEF_CHARS) return null;
  return text.slice(0, MAX_BRIEF_CHARS);
}

/**
 * A project was just created with a description (routes/apps.js): what the
 * create dialog asks as "What should it do?". Recorded, so it is filed as
 * the project's first request once the project is running, under its
 * creator's name. When the creator is somebody the bot talks to in a DM,
 * the bot builds that first version and the person is told in their DM;
 * for anybody else the request is filed and left to the group, with no DM.
 * Resolves { conversationId } when the bot builds it and said so, else null.
 */
async function startFirstVersion(pool, config, { app, user, brief }) {
  const text = normalizeBrief(brief);
  if (!text || !app?.id || !user?.id) return null;
  const settings = await settingsModule().readSettings(pool);
  const bot = hasBot(settings, user) ? await settingsModule().ensureBotUser(pool, config) : null;
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id) DO NOTHING`,
    [app.id, user.id, text, !!bot],
  );
  if (!bot) {
    log.info('homeroom-bot-dm', 'Project will file its description as its first request', { app: app.slug, userId: user.id });
    return null;
  }
  const name = app.name || app.slug;
  const sent = await sendDm(pool, {
    bot,
    userId: user.id,
    idempotencyKey: `hrbot-create-${app.id}`,
    content: `**${name}**\n\nThanks! I'm setting up ${name} now. Once it's ready I'll build its first version from your `
      + 'description and send it to you here to try. If anything is unclear, I\'ll ask you here first.'
      + (settings.mode === 'off' ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : ''),
    metadata: { kind: 'first_version_started', appSlug: app.slug, appName: name },
  });
  log.info('homeroom-bot-dm', 'Project will be built from its description', { app: app.slug, userId: user.id });
  return sent ? { conversationId: sent.conversationId } : null;
}

/**
 * The request a project's description is filed as: its title and body.
 * Pure. Shared with the benchmark's taste eval (services/bench/taste.js),
 * whose first-version trials are given the same request the bot reads.
 */
function firstVersionIssue({ name, username, brief, botBuilds = true }) {
  return {
    title: clip(`First version of ${name}`, 200),
    body: [
      `**Source:** Homeroom user (${username})`,
      '',
      brief,
      '',
      '---',
      botBuilds
        ? `${username} described this when they created the project. Homeroom bot is building its first version from it.`
        : `${username} described this when they created the project.`,
    ].join('\n'),
  };
}

/**
 * File one project's first request, once the project is running: a GitHub
 * issue under the creator's name and the platform's issue row. When the bot
 * builds it, the creator is recorded as its requester (so the bot's news
 * reaches their DM) and the bot is woken for it; otherwise nothing of the
 * bot's is touched. Claimed by a status flip, so two Pods (or the creation
 * hook and the sweep) file it once.
 */
async function fileFirstVersion(pool, config, appId, deps = {}) {
  if (isStaging() && !deps.allowStaging) return null;
  const { rows: claimed } = await pool.query(
    `UPDATE homeroom_bot_first_versions f
        SET status = 'filing', attempts = f.attempts + 1
       FROM apps a
      WHERE f.app_id = $1 AND a.id = f.app_id AND f.status = 'waiting'
        AND a.status = 'running' AND a.repo_url IS NOT NULL
      RETURNING f.app_id, f.user_id, f.brief, f.attempts, f.bot_builds, a.slug, a.name, a.repo_url`,
    [appId],
  );
  const row = claimed[0];
  if (!row) return null;
  const github = deps.github || require('./github');
  const ws = deps.ws || require('./ws');
  const { rows: people } = await pool.query('SELECT username FROM users WHERE id = $1', [row.user_id]);
  const username = people[0]?.username || 'unknown';
  const name = row.name || row.slug;
  const botBuilds = row.bot_builds !== false;
  const { title, body } = firstVersionIssue({ name, username, brief: row.brief, botBuilds });
  try {
    const parsed = (typeof github.parseGithubUrl === 'function' && github.parseGithubUrl(row.repo_url))
      || (() => {
        const m = String(row.repo_url).match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
        return m ? { owner: m[1], repo: m[2] } : null;
      })();
    if (!parsed || !github.isEnabled()) throw new Error('github_unavailable');
    const created = await github.createIssue(parsed.owner, parsed.repo, {
      title, body: typeof github.safeMention === 'function' ? github.safeMention(body) : body,
    });
    const issueNumber = Number(created?.number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('invalid issue number');
    try { github.noteIssueCreated?.(parsed.owner, parsed.repo, created); } catch {}
    const { rows: issueRows } = await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5) RETURNING id`,
      [row.app_id, issueNumber, title, body, row.user_id],
    );
    if (botBuilds) {
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id, first_version = TRUE`,
        [row.app_id, issueNumber, row.user_id, title],
      );
    }
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = $2, filed_at = NOW(), error = NULL
        WHERE app_id = $1`,
      [row.app_id, issueNumber],
    );
    await ws.sendSystemMessage(pool, row.app_id, `${username} created issue: "${title}" (#${issueNumber})`,
      'system', null, { type: 'issue', ref: issueNumber }).catch(() => {});
    ws.pushIssueUpdate({ action: 'created', appSlug: row.slug, appId: row.app_id, issueId: issueRows[0]?.id, kind: 'general' });
    if (botBuilds) settingsModule().noteIssueActivity({ appId: row.app_id, issueNumber, reason: 'created' });
    log.info('homeroom-bot-dm', 'Filed a first version', { app: row.slug, issueNumber, userId: row.user_id, botBuilds });
    return { issueNumber };
  } catch (err) {
    const final = row.attempts >= MAX_FILE_ATTEMPTS;
    await pool.query(
      `UPDATE homeroom_bot_first_versions SET status = $2, error = $3 WHERE app_id = $1`,
      [row.app_id, final ? 'failed' : 'waiting', clip(err.message, 300)],
    ).catch(() => {});
    log.warn('homeroom-bot-dm', 'Could not file a first version', { app: row.slug, err: err.message, final });
    if (final && botBuilds) {
      const bot = await botAccount(pool);
      if (bot) {
        await sendDm(pool, {
          bot, userId: row.user_id, idempotencyKey: `hrbot-filefail-${row.app_id}`,
          content: `**${name}**\n\nI couldn't start building ${name}'s first version. You can still post a request on `
            + 'its page, or start a change from there yourself.',
          metadata: { kind: 'first_version_failed', appSlug: row.slug, appName: name, firstVersion: true },
        }).catch(() => null);
      }
    }
    return null;
  }
}

/**
 * Every project waiting for its first request whose project is running now,
 * the bot's or not. The bot's loop runs it before its refresh, and the
 * leader runs it on its own timer (server.js), so a request the creation
 * hook missed is filed whether or not the bot is on.
 */
async function sweepFirstVersions(pool, config, deps = {}) {
  if (isStaging() && !deps.allowStaging) return 0;
  // A filing a restart interrupted is tried again, within its attempts.
  await pool.query(
    `UPDATE homeroom_bot_first_versions SET status = 'waiting'
      WHERE status = 'filing' AND attempts < $1 AND created_at < NOW() - INTERVAL '30 minutes'`,
    [MAX_FILE_ATTEMPTS],
  );
  const { rows } = await pool.query(
    `SELECT f.app_id FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.status = 'waiting' AND a.status = 'running' AND a.repo_url IS NOT NULL
      ORDER BY f.created_at
      LIMIT 20`,
  );
  let filed = 0;
  for (const r of rows) {
    if (await fileFirstVersion(pool, config, r.app_id, deps).catch(() => null)) filed += 1;
  }
  return filed;
}

/**
 * #15 (D9): whether the Homeroom bot is still building a project's first
 * version from its description, and where it is, for the App tab. While it
 * builds, the app's own page is the starter its repo was scaffolded with
 * (services/template.js), which says "Start a new change" to somebody whose
 * change is already being made; the shell shows this state instead.
 *
 * Building while the bot builds it (`bot_builds`) and either the request is
 * not filed yet (waiting or filing: the project is being set up), or it is
 * filed and no proposal for it has merged. Null once one has, once filing
 * failed, once the project failed to set up, and once the request came to
 * something other than a merge (the bot left it to the group, its build did
 * not succeed, its proposal was closed): then the app is what there is.
 *
 * `{ userId, creator, conversationId, step, of, stepName, question, ready }`:
 * whose description it is, their DM with the bot, the step of
 * homeroom-bot-progress.js's FIRST_VERSION_STEPS, whether the bot waits on
 * an answer from them, and whether its proposal is up for the vote (ready
 * to try). GET /api/apps/:slug reads it best-effort: a read that fails is
 * no state, never a failed page.
 */
async function firstVersionState(pool, appId, deps = {}) {
  if (!appId) return null;
  const { rows } = await pool.query(
    `SELECT f.app_id, f.user_id, f.status, f.issue_number, f.created_at,
            a.slug, a.name, a.status AS app_status, a.created_at AS app_created_at,
            u.username,
            EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
                JOIN chat_sessions cs ON cs.id = r.proposal_session_id
               WHERE r.app_id = f.app_id AND r.issue_number = f.issue_number AND cs.status = 'merged'
            ) AS merged,
            (SELECT p.conversation_id
               FROM users b
               JOIN conversation_direct_pairs p
                 ON p.user_low_id = LEAST(b.id, f.user_id) AND p.user_high_id = GREATEST(b.id, f.user_id)
               JOIN conversation_members m
                 ON m.conversation_id = p.conversation_id AND m.user_id = f.user_id AND m.status = 'member'
              WHERE b.username = $2 AND b.is_synthetic = TRUE
              LIMIT 1) AS conversation_id
       FROM homeroom_bot_first_versions f
       JOIN apps a ON a.id = f.app_id
       LEFT JOIN users u ON u.id = f.user_id
      WHERE f.app_id = $1 AND f.bot_builds = TRUE`,
    [appId, BOT_USERNAME],
  );
  const row = rows[0];
  if (!row || !['waiting', 'filing', 'filed'].includes(row.status) || row.merged) return null;
  const progress = deps.progress || require('./homeroom-bot-progress');
  const at = (stage) => {
    const step = progress.stepNumber(stage, true);
    return { step, of: progress.FIRST_VERSION_STEPS.length, stepName: step ? progress.FIRST_VERSION_STEPS[step - 1] : null };
  };
  const base = { userId: Number(row.user_id), creator: row.username || null, conversationId: Number(row.conversation_id) || null };
  if (row.status !== 'filed') {
    if (progress.setupOf(row).outcome) return null;
    return { ...base, ...at('setting_up'), question: false, ready: false };
  }
  const states = await progress.requestStates(pool, { userId: row.user_id });
  const found = states.find((s) => Number(s.row.app_id) === Number(row.app_id)
    && Number(s.row.issue_number) === Number(row.issue_number));
  if (found?.state) {
    return {
      ...base,
      ...at(found.state.stage),
      question: found.state.stage === 'question' && found.state.waitingOn === 'them',
      ready: found.state.stage === 'vote',
    };
  }
  // Filed, and nothing in progress: either it came to something, or the bot
  // has not picked it up yet (filing wakes it, and it reads it next).
  if (found && progress.outcomeOf(found.row)) return null;
  return { ...base, ...at('queued'), question: false, ready: false };
}

/** The create dialog's suggested one-line description, from the longer one. */
async function suggestShortDescription({ name, brief, max = 90, deps = {} }) {
  const text = normalizeBrief(brief);
  if (!text) return null;
  const llm = deps.llm || require('./llm');
  try {
    const out = await llm.generateShortDescription({ name, brief: text, max });
    if (out?.description) return { description: clip(out.description, max).slice(0, max), usage: out.usage, model: out.model };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Short description suggestion failed; using the first sentence', { err: err.message });
  }
  return { description: firstSentence(text, max), usage: null, model: null };
}

/** The description's first sentence, cut at a word to fit `max`. */
function firstSentence(text, max = 90) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.+?[.!?](?=\s|$)/) || [flat])[0].replace(/[.!?]+$/, '');
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

module.exports = {
  BOT_USERNAME,
  QUESTION_KINDS,
  MIRRORED_KINDS,
  MOMENTS,
  momentOf,
  notificationDetail,
  READY_CHECKS,
  readyKey,
  changeReadiness,
  noteChangeReady,
  noteChangeStopped,
  MAX_BRIEF_CHARS,
  MIN_BRIEF_CHARS,
  HELP_TEXT,
  NOT_ENABLED_TEXT,
  isDmUser,
  hasBot,
  isEnabledFor,
  botAccount,
  PROJECT_ORIGINS,
  projectsMadeFor,
  firstVersionAppSlugs,
  noteProjectMade,
  importedAt,
  sendDm,
  TYPING_RENEW_MS,
  TYPING_MAX_MS,
  startTyping,
  whileTyping,
  recordRequester,
  requesterOf,
  personOf,
  weeklySpentCents,
  overWeeklyAllowance,
  noteOverAllowance,
  overAllowanceText,
  allowanceLow,
  ALLOWANCE_LOW_SHARE,
  notePausedForWeek,
  PAUSED_FOR_WEEK_TEXT,
  weekKey,
  dmText,
  dmRecipient,
  untaggedRequester,
  requestLine,
  closeOpenQuestions,
  setQuestionState,
  relayIssuePost,
  staleBuildNews,
  noteBuildRestarted,
  RESTARTED_TEXT,
  cardsFor,
  quotedTarget,
  quotable,
  requestStart,
  newestOpenQuestion,
  postOnRequest,
  postOnProposal,
  noteProposalMerged,
  // #7, #8, #20 (WP3)
  LIVE_PROBES,
  LIVE_PROBE_WAIT_MS,
  hasProposalCard,
  mergedText,
  liveAfterMerge,
  noteProposalChanged,
  isBotDirect,
  mirroredText,
  noteUserMessage,
  normalizeBrief,
  firstVersionIssue,
  startFirstVersion,
  fileFirstVersion,
  sweepFirstVersions,
  firstVersionState,
  suggestShortDescription,
  firstSentence,
};
