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
// It talks to everybody Homeroom has let in (hasBot). It was tried out one
// person at a time first, on a list an admin kept. What each person's
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
// How often a person the bot does not work for (an account not let in yet)
// hears why the bot does not answer: once a day is enough.
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
 * Whether the bot works for this person: builds the projects they describe,
 * brings their requests' news to their DM, and answers them there. That is
 * anybody who may use the platform (platform access, which an admin always
 * has), and never a synthetic account. A private member
 * (users.private_member_since) may: every read below takes
 * `has_platform_access` as "may use the platform", and req.user callers
 * fold `privateMember` in.
 * `person` is the signed-in user (req.user), or a requester (requesterFrom):
 * { username, isSynthetic, hasPlatformAccess, isAdmin }.
 * Pure. Whether the bot is switched on at all is its Mode's, not this: a
 * project described while it is off waits for it, and says so.
 */
function hasBot(settings, person) {
  if (!settings || !person?.username) return false;
  return !person.isSynthetic && !!(person.hasPlatformAccess || person.isAdmin || person.privateMember);
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
    askedText: row.asked_text || null,
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
 * A project was just made with no description to build from
 * (routes/apps.js): imported, forked, or created without one. When the bot
 * works for its maker it is recorded, so an import's backlog waits
 * (importedAt). Nothing is filed and nothing is said in the DM: there is no
 * first version to build. Resolves true when it was recorded.
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
  if (rowCount) log.info('homeroom-bot-dm', 'Project made without a description recorded for the bot', { app: app.slug, userId: user.id, origin });
  return rowCount > 0;
}

/**
 * When a project was imported by somebody the bot works for, or null: the
 * issues it arrived with are left until something happens on them after this.
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
 * is one (built, revised, merged), else the request itself. The news that
 * it went live opens the app with its own button (openAppAction), not a
 * card: an app card is one the bot can attach only to a project it can see,
 * and Page Turners (5 October), a group the bot is not in, got its "It's
 * live now." with no way in at all.
 */
function cardsFor(kind, dm, app, issueNumber) {
  const appId = Number(app?.id);
  if (!Number.isInteger(appId) || appId <= 0) return [];
  const sessionId = Number(dm?.sessionId);
  if ((kind === 'proposal' || kind === 'followup_revise' || kind === 'followup_failed' || kind === 'merged') && hasProposalCard(dm)) {
    return [{ type: 'proposal', appId, sessionId }];
  }
  const n = Number(issueNumber);
  return Number.isInteger(n) && n > 0 ? [{ type: 'issue', appId, issueNumber: n }] : [];
}

/**
 * Pure (5 October): the button that opens a project's app, on its App tab,
 * as the rest of the shell opens it (frontend/src/features/messages/
 * bot-shared.ts openAppTarget: App.openAppTab). An `open` button is drawn
 * from the message itself, so nothing about who the bot may see can keep it
 * off: the person it is for can open their own project. Null for no slug.
 */
function openAppAction({ slug, appName }) {
  if (typeof slug !== 'string' || !slug) return null;
  const name = clip(String(appName || slug).replace(/\s+/g, ' '), 40);
  return { id: 'open_app', label: `Open ${name}`, style: 'primary', type: 'open', target: `#app/${encodeURIComponent(slug)}/app` };
}

/**
 * Pure (#4231): the buttons under a NEW project's first version going live,
 * after its Open: its community page, where the project's hub is
 * (`#app/<slug>/workshop`, frontend/src/features/messages/bot-shared.ts
 * openAppTarget lands it on the hub), and Invite people, which the client
 * answers itself by opening the first-session invite sheet in place
 * (bot-question.tsx; an invite link is made from the browser, as the sheet
 * always makes it). Empty for no slug.
 */
function firstLiveActions({ slug }) {
  if (typeof slug !== 'string' || !slug) return [];
  return [
    { id: 'open_community', label: 'Open community', style: 'secondary', type: 'open', target: `#app/${encodeURIComponent(slug)}/workshop` },
    { id: 'invite_people', label: 'Invite people', style: 'secondary', type: 'invite' },
  ];
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
  // #4242: built, but nothing will offer it to try without a person.
  needs_look: 'stopped',
  // An update they asked for that did not happen ("your change stopped. I
  // said why in our chat", the stop's own words).
  followup_failed: 'stopped',
  // Live.
  merged: 'live',
  // An answer to what they wrote: the model's, and its offer to file.
  chat: 'reply', confirm: 'reply',
});

// WP-F: which stop a 'stopped' moment was (mobile-push-policy.js
// botMomentCopy and the bell's botMomentLine word each one).
const STOPPED_DETAIL = Object.freeze({
  build_failed: 'stopped_build',
  blocked: 'stopped_blocked',
  person: 'stopped_person',
  empty: 'stopped_empty',
  first_version_failed: 'stopped_first',
  preview_failed: 'stopped_preview',
  needs_look: 'stopped_look',
});

// WP-E: the notification kind each moment rings as, in the "Your builds" push
// category (mobile-push-preferences.js), so turning Messages off does not
// silence them. An answer to what somebody wrote ('reply') is a message.
const BUILD_KINDS = Object.freeze({
  question: 'build_needs_you',
  ready: 'build_ready',
  stopped: 'build_stopped',
  held: 'build_stopped',
  live: 'build_live',
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
  // WP-F: "live" only once the app answers on it (mergedText says the same);
  // until then it is going live.
  if (moment === 'live') {
    const soon = metadata?.live === false;
    if (metadata?.firstVersion) said = soon ? 'live_first_soon' : 'live_first';
    else if (soon) said = 'live_soon';
  }
  // WP-F: a stop says which one, so it can say what happened and what is next.
  if (moment === 'stopped' && STOPPED_DETAIL[metadata?.kind]) said = STOPPED_DETAIL[metadata.kind];
  if (moment === 'ready' && !metadata?.firstVersion && metadata?.appSlug) {
    if (await hasOthers(pool, null, metadata.appSlug)) said = 'ready_group';
  }
  // Built, but its shots show part of it failing: not "ready to try".
  if (moment === 'ready' && Array.isArray(metadata?.ready?.broken) && metadata.ready.broken.length) said = 'ready_broken';
  return `hrbot:${said}:${appName}`;
}

/**
 * B4: whether anybody but one person is in a project's community: who
 * approves a change to it, and how its news is worded. By id, or by slug.
 * Never throws; false when it cannot tell.
 */
async function hasOthers(pool, appId, appSlug = null) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id) AS members
       FROM apps a WHERE a.id = $1 OR ($1::int IS NULL AND a.slug = $2)`,
    [appId == null ? null : Number(appId), appSlug],
  ).catch(() => ({ rows: [] }));
  return (Number(rows?.[0]?.members) || 0) > 1;
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
    {
      metadata: metadata ? { [META]: metadata } : null, notify: !!rings, notificationDetail: detail,
      notificationKind: (rings && BUILD_KINDS[rings]) || null,
    });
  let result = await send(cards);
  if (!result && cards.length) {
    log.info('homeroom-bot-dm', 'Cards refused; sending the message without them', { userId, cards: cards.length });
    result = await send([]);
  }
  if (!result || result.error) {
    log.warn('homeroom-bot-dm', 'DM refused', { userId, error: result?.error || 'refused' });
    return null;
  }
  if (!result.duplicate && rings === 'ready') {
    // WP-E: "ready to try" by email when no phone can take the push.
    void require('./activity-mail').emailIfNoPush(pool, {
      userId, kind: 'build_ready', appName: metadata?.appName || null, appSlug: metadata?.appSlug || null,
      conversationId: opened.conversationId,
      // Built, but part of it failed when Homeroom tried it: not "ready to try".
      ...(Array.isArray(metadata?.ready?.broken) && metadata.ready.broken.length ? { notWorking: true } : {}),
    });
  }
  if (!result.duplicate) {
    await retireSuggestions(pool, {
      botId: bot.id, conversationId: opened.conversationId, keepMessageId: result.messageId ?? result.message?.id, userId,
    });
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
    `SELECT q.user_id, q.first_version, q.issue_title, q.asked_text, u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin
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
  // B4: in their own words, when they wrote it here: the description of the
  // request they filed on the platform (Suggest an improvement).
  const { rows } = await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
     SELECT $1, $2, u.id, $4,
            (SELECT LEFT(NULLIF(BTRIM(i.description), ''), 2000) FROM issues i
              WHERE i.app_id = $1 AND i.github_issue_number = $2 AND i.created_by = u.id
              ORDER BY i.id DESC LIMIT 1)
       FROM users u
      WHERE LOWER(u.username) = LOWER($3) AND u.is_synthetic = FALSE
     ON CONFLICT (app_id, issue_number) DO UPDATE SET issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title)
     RETURNING user_id, first_version, issue_title, asked_text`,
    [app.id, issueNumber, poster, title],
  );
  if (!rows.length) return null;
  // Who they are, as hasBot reads it.
  const { rows: who } = await pool.query(
    'SELECT u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [rows[0].user_id],
  );
  return requesterFrom({ ...rows[0], ...(who[0] || {}) }, { username: who[0]?.username || poster });
}

/** A person, as hasBot and noteOverAllowance read them, by id; null when there is none. */
async function personOf(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    'SELECT u.id AS user_id, u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
    [userId],
  );
  return rows[0] ? requesterFrom(rows[0]) : null;
}

async function requesterOf(pool, appId, issueNumber) {
  const { rows } = await pool.query(
    `SELECT q.user_id, q.first_version, q.issue_title, q.asked_text, u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin
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
 * (homeroom-bot-mayor.js start_request). #4097: led by the request's line
 * (requestLine), which Messages draws as its card, as the rest of its news
 * is; the words then say "it".
 */
function overAllowanceText({ line = null, appName, group = false }) {
  const said = group
    ? `You've used this week's building time. I'll start it on Monday, or someone else in ${appName} can ask me for it.`
    : 'You\'ve used this week\'s building time. I\'ll start it on Monday.';
  return line ? `${line}\n\n${said}` : said;
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
  const context = { appName, issueNumber, issueTitle: requester?.issueTitle || null, firstVersion: !!requester?.firstVersion };
  return sendDm(pool, {
    bot,
    userId: who.userId,
    replyToId: await requestStart(pool, { userId: who.userId, appId: app.id, issueNumber }),
    idempotencyKey: `hrbot-allowance-${who.userId}-${weekKey()}`,
    content: overAllowanceText({
      line: requestLine(context),
      appName,
      group: (Number(rows[0]?.members) || 0) > 1,
    }),
    metadata: {
      kind: 'allowance', appSlug: app.slug, appName, issueNumber,
      ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
      ...(context.firstVersion ? { firstVersion: true } : {}),
    },
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
    'SELECT u.id AS user_id, u.username, u.is_synthetic, (u.has_platform_access OR u.private_member_since IS NOT NULL) AS has_platform_access, u.is_admin FROM users u WHERE u.id = $1',
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

/**
 * Pure (B4): what somebody asked for, in their own words, as one line of
 * about `max` characters, cut at a word: what their activity card leads with.
 * Null for nothing.
 */
function askedLine(text, max = 120) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

function requestLine({ appName, issueNumber, issueTitle, firstVersion }) {
  if (firstVersion) return `**${appName}**, its first version`;
  return `**${appName}** · request #${issueNumber}${issueTitle ? `: ${clip(issueTitle, 140)}` : ''}`;
}

/** Pure (B6): whether a question post asks two questions at once. */
function twoQuestions(dm) {
  return Array.isArray(dm?.questions) && dm.questions.length > 1;
}

/** Pure (B6): the words above two questions' card. */
function questionLead(line, it, dm) {
  return `${line}\n\nI have ${twoQuestions(dm) ? 'two questions' : 'a question'} before I build ${it}:`;
}

/**
 * Pure: what ended a build that did not finish, as one of a few causes
 * ({ cause, times }). `reason` is the run's own record (homeroom-bot.js,
 * homeroom-bot-live.js), written for the platform: on 5 Oct 2026 a
 * requester read "the build ran past its time limit (finished after a
 * restart)". It is read for what happened and never quoted. "(finished
 * after a restart)" only says which process recorded it, never why it
 * ended: a build that ran too long or changed nothing is said as that.
 */
function buildFailedCause(reason) {
  const r = String(reason || '').replace(/\s*\(finished after a restart\)/g, '');
  const restarts = /restarted in the middle of each of its last (\d+) tries/.exec(r);
  if (restarts) return { cause: 'restarts', times: Number(restarts[1]) };
  if (/ran past its time limit/.test(r)) return { cause: 'time' };
  if (/restarted|by a restart/.test(r)) return { cause: 'restart' };
  if (/built but could not be proposed/.test(r)) return { cause: 'unproposed' };
  if (/produced no change/.test(r)) return { cause: 'no_change' };
  if (/could not start|would not start|could not open a session|could not create its branch/.test(r)) {
    return { cause: 'no_start' };
  }
  return { cause: 'other' };
}

// What the bot was doing when it stopped: building a request, or updating
// a change it had already built, after somebody asked for something
// different on it (homeroom-bot-followup.js revisionFailedText).
const FAILED_DOING = Object.freeze({
  build: Object.freeze({ verb: 'finish building', noun: 'build', starting: 'building' }),
  update: Object.freeze({ verb: 'update', noun: 'update', starting: 'updating' }),
});

// Each cause in words, two ways (5 Oct 2026). `me`: the bot to the person
// it was building for, in its DM. `bot`: about the bot, on the request
// itself, where everybody in the project reads it (homeroom-bot-live.js
// buildFailedText, also its GitHub comment), as the bot's other posts there
// are worded.
const FAILED_SAID = Object.freeze({
  me: Object.freeze({
    restarts: (d, it, n) => `I couldn't ${d.verb} ${it}: Homeroom restarted while I was working on it, ${n} times in a row.`,
    time: (d, it) => `I couldn't ${d.verb} ${it}: it took longer than I'm allowed.`,
    restart: (d, it) => `I couldn't ${d.verb} ${it}: Homeroom restarted while I was working on it.`,
    unproposed: (d, it) => `I built ${it}, but I couldn't put it up for approval.`,
    no_change: (d, it) => `I couldn't ${d.verb} ${it}: I ended up with no changes to show you.`,
    no_start: (d, it) => `I couldn't get started on ${d.starting} ${it}.`,
    other: (d, it) => `I couldn't ${d.verb} ${it}: something went wrong while I was working on it.`,
  }),
  bot: Object.freeze({
    restarts: (d, it, n) => `Homeroom bot couldn't ${d.verb} ${it}: Homeroom restarted in the middle of the ${d.noun}, ${n} times in a row.`,
    time: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: the ${d.noun} took longer than it's allowed.`,
    restart: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: Homeroom restarted in the middle of the ${d.noun}.`,
    unproposed: (d, it) => `Homeroom bot built ${it}, but couldn't put it up for approval.`,
    no_change: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: it ended up with no changes to show.`,
    no_start: (d, it) => `Homeroom bot couldn't get started on ${d.starting} ${it}.`,
    other: (d, it) => `Homeroom bot couldn't ${d.verb} ${it}: something went wrong during the ${d.noun}.`,
  }),
});

/**
 * Pure: why the bot stopped, in plain words, from the run's own record
 * (read by buildFailedCause, never quoted). `voice` is 'me' (the default:
 * the bot to the person it was for, in its DM) or 'bot' (about the bot, on
 * the request); `doing` is 'build' (the default) or 'update' (a change it
 * had built, which has nothing left to put up for approval).
 */
function failedWords(reason, { it = 'this', voice = 'me', doing = 'build' } = {}) {
  const read = buildFailedCause(reason);
  const d = FAILED_DOING[doing] || FAILED_DOING.build;
  const cause = d === FAILED_DOING.update && read.cause === 'unproposed' ? 'other' : read.cause;
  return (FAILED_SAID[voice] || FAILED_SAID.me)[cause](d, it, read.times);
}

/** Pure: why a build of `it` did not finish (failedWords), in the DM's voice or ('bot') on the request. */
function buildFailedWords(reason, it = 'this', voice = 'me') {
  return failedWords(reason, { it, voice, doing: 'build' });
}

/**
 * Pure (5 Oct 2026): why the bot could not update `it`, a change it had
 * built, after it was asked for something different on it: the same causes
 * as a build's, from the same reading of the run's record
 * (homeroom-bot.js runFollowUp: "the turn produced no change", "its change
 * could not be pushed", "the turn failed (...), so its change was not
 * kept"), said in the same two voices.
 */
function updateFailedWords(reason, it = 'this change', voice = 'me') {
  return failedWords(reason, { it, voice, doing: 'update' });
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
      // B6: two questions, asked at once (the card under it draws both).
      if (twoQuestions(dm)) return `${questionLead(line, it, dm)}\n\n${dm.questions.map((q, i) => `${i + 1}. ${clip(q.question, 300)}`).join('\n')}`;
      return `${line}\n\nI have a question before I build ${it}:\n\n${clip(dm.question, 2000)}`;
    case 'followup_ask':
      return `${line}\n\nI have a question before I update your change:\n\n${clip(dm.question, 2000)}`;
    case 'spec':
      return `${line}\n\nI'm building ${it} now. I'll message you here when it's ready to try.`;
    // #20 (WP3): the change's card under the message is its link (cardsFor
    // attaches it whenever the news names its session), so the text points
    // at the card. The address is written out only when there is no card:
    // beside one it was a raw URL next to the same link, in the DM and in
    // its push. B4: sent once it is ready to try (noteChangeReady), and in
    // plain words: on a project of theirs alone they approve it themselves;
    // with others in it, it goes live once it is approved.
    case 'proposal':
      // B7: the ready card, whose buttons say the rest (Try it, Approve).
      // A change part of which does not work says so first, plainly.
      if (dm.card && brokenWords(dm.card.broken).length) {
        const said = brokenWords(dm.card.broken).map((words) => words.replace(/[.\s]+$/, ''));
        const what = said.length === 1
          ? `one thing isn't working yet: ${said[0]}`
          : `${said.length} things aren't working yet: ${said.join('; ')}`;
        return dm.card.approve
          ? `${line}\n\nIt's built, but ${what}. Try it, and approve it only if you're happy with it as it is.`
          : `${line}\n\nIt's built, but ${what}. Try it to see.`;
      }
      if (dm.card) {
        return dm.card.approve
          ? `${line}\n\nIt's ready to try. Approve it when you're happy with it${dm.card.last ? ', and it goes live' : ''}.`
          : `${line}\n\nIt's ready to try. It goes live once it's approved.`;
      }
      if (hasProposalCard(dm)) {
        return context.group
          ? `${line}\n\nIt's ready to try. Open the change below to see the preview. It goes live once it's approved.`
          : `${line}\n\nIt's ready to try. Open the change below to see the preview, and approve it when you're happy with it.`;
      }
      return context.group
        ? `${line}\n\nIt's ready to try. See the preview here: ${dm.link}\n\nIt goes live once it's approved.`
        : `${line}\n\nIt's ready to try. See the preview, and approve it when you're happy with it: ${dm.link}`;
    case 'followup_revise': {
      let look = '';
      if (hasProposalCard(dm)) look = '\n\nTake another look at it below.';
      else if (dm.link) look = `\n\nTake another look: ${dm.link}`;
      return `${line}\n\nI updated your change after the latest replies: ${clip(dm.summary, 600)}${look}`;
    }
    case 'blocked':
      return `${line}\n\nI looked into this and can't build it as it's written: ${clip(dm.reason, 600)}\n\n`
        + 'Reply to this message with more detail and I\'ll look again.';
    case 'build_failed':
      // What happened in plain words, never the run's own record of it
      // (buildFailedWords), and what to do about it, as #3772 gave `person`:
      // "A person can pick it up from here" was a dead end for somebody who
      // was the person. A reply here, quoting this or not, is read by the
      // bot (it is not one of MIRRORED_KINDS), which starts the request
      // again (homeroom-bot-mayor.js start_request): on 5 Oct 2026 "Oh no,
      // can you try again?" had it building again within seconds.
      return `${line}\n\n${buildFailedWords(dm.reason, it)} Reply here and I'll try again.`;
    case 'followup_failed': {
      // 5 Oct 2026: an update to their change that did not happen, in plain
      // words (updateFailedWords), never the run's own record, and how to
      // try again that is sure to reach the bot: Ask for changes on the
      // change, which posts what they write in its discussion and puts its
      // follow-up first in the queue (homeroom-bot-mayor.js reviseAttached).
      // A reply here goes to the bot's chat model, which can send it on the
      // same way (revise_proposal) once it knows what to change, so the DM
      // names the way that does not depend on it.
      const change = context.firstVersion ? 'the first version' : 'your change';
      if (dm.canRevise === false) {
        return `${line}\n\nI couldn't update ${change}: I've already updated it as many times as I can on my own, `
          + 'so a person needs to make this one. It\'s as it was.';
      }
      const words = updateFailedWords(dm.reason, change, 'me');
      let next = `To try again, open it on ${context.appName} and tap Ask for changes.`;
      if (hasProposalCard(dm)) next = 'To try again, open it below and tap Ask for changes.';
      else if (dm.link) next = `To try again, open it and tap Ask for changes: ${dm.link}`;
      return `${line}\n\n${words} It's as it was. ${next}`;
    }
    case 'person':
      // #4239: about Homeroom itself, so nothing on this project can do it:
      // the offer to move it to Homeroom's own board follows (relayIssuePost).
      if (dm.platform) {
        return `${line}\n\nThis is about Homeroom itself rather than ${context.appName}, so no change to ${context.appName} `
          + `can do it, and I haven't built anything: ${clip(dm.reason, 600)}\n\n`
          + 'I can move it to Homeroom\'s own board, where the people who work on Homeroom look. Tap below to choose.';
      }
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
// B9: what the bot's news about a request says on the chat message it was
// asked in, if it was (homeroom-bot-chat.js): building, or stopped.
const CHAT_STATUS_OF_KIND = Object.freeze({
  spec: 'building', build_failed: 'stopped', blocked: 'stopped', person: 'stopped', empty: 'stopped',
});

async function relayIssuePost({
  pool, ws = null, app, issueNumber, kind, runId = null, postId = null, bot, dm, ready = false, key = null,
}) {
  if (CHAT_STATUS_OF_KIND[kind] && app?.id) {
    await require('./homeroom-bot-chat').noteRequestStatus(pool, { appId: app.id, issueNumber, status: CHAT_STATUS_OF_KIND[kind] });
  }
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
    // B4: whether others are in the project, for who approves it.
    group: kind === 'proposal' ? await hasOthers(pool, app.id) : false,
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
    // B6: two questions, answered together (the card above Build it).
    ...(kind === 'question' && twoQuestions(dm) ? {
      questions: dm.questions.slice(0, 2).map((q) => ({
        question: clip(q.question, 300),
        answers: (Array.isArray(q.answers) ? q.answers : []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 4),
      })),
      lead: questionLead(requestLine(context), context.firstVersion ? 'the first version' : 'this', dm),
    } : {}),
    ...(dm.link ? { link: dm.link } : {}),
    // Where it is stuck, what to tap (STUCK_ACTIONS).
    // #4239: not Go ahead on a request about Homeroom itself; its own
    // message offers the move instead.
    ...(STUCK_ACTIONS[kind] && !(kind === 'person' && dm.platform) ? { actions: STUCK_ACTIONS[kind], status: 'open' } : {}),
    // B7: a change ready to try, as a card with its buttons: whether it is
    // one person's project (the title), who else it waits on and how many of
    // them it needs, their words.
    ...(kind === 'proposal' && dm.card ? {
      ready: {
        group: !!context.group,
        last: !!dm.card.last,
        waitingOn: Array.isArray(dm.card.waitingOn) ? dm.card.waitingOn : [],
        ...(dm.card.more ? { more: Number(dm.card.more) } : {}),
        // How many more approvals it needs, and in all: with fewer than the
        // people listed, the card says how many and that any of them will do.
        ...(Number.isInteger(dm.card.missing) ? { missing: Number(dm.card.missing) } : {}),
        ...(Number.isInteger(dm.card.needed) ? { needed: Number(dm.card.needed) } : {}),
        // What its shots show not working (noteChangeReady), said on the card.
        ...(brokenWords(dm.card.broken).length ? { broken: brokenWords(dm.card.broken) } : {}),
      },
      sessionId: Number(dm.sessionId),
      epoch: Number(dm.epoch) || 0,
      actions: readyActions({ sessionId: dm.sessionId, epoch: dm.epoch, approve: !!dm.card.approve }),
      status: 'open',
      // #3870: what the change is, so the card says more than "is ready".
      ...(typeof dm.title === 'string' && dm.title.trim() ? { changeTitle: clip(dm.title.trim(), 200) } : {}),
      ...(requester.askedText ? { askedText: askedLine(requester.askedText) } : {}),
    } : {}),
  };
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content,
    withoutCards: dmText(kind, { ...dm, sessionId: null }, context),
    metadata,
    idempotencyKey: sendKey || (postId ? `hrbot-post-${postId}` : null),
    // B7: a ready card's Try it is its way to the change; it carries no card.
    objects: dm.card ? [] : cardsFor(kind, dm, app, issueNumber).filter((c) => !(shown && c.type === 'issue')),
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
    // B7: and a ready card about an older version of the change gives way.
    if (kind === 'proposal' && dm.card) {
      await closeOlderReadyCards(pool, { userId: requester.userId, appId: app.id, issueNumber, keepMessageId: sent.messageId, ws });
    }
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
  // #4239: and the offer to move a request about Homeroom itself to
  // Homeroom's own board, under its own buttons. Never throws.
  if (kind === 'person' && dm.platform) {
    await require('./homeroom-bot-move').offerMove(pool, {
      bot, userId: requester.userId, app, issueNumber, title: requester.issueTitle, reason: dm.reason,
      key: `${app.id}-${issueNumber}-${runId || postId || sent.messageId}`,
    });
  }
  return told;
}

// ── B6: a first version's plan ───────────────────────────────────────────
//
// A project's first version is not built the moment the bot has read its
// description: its creator gets the plan first (homeroom-bot.js awaitGo), 3
// to 5 plain bullets and up to two choices with the suggested answer
// marked, then Build it and Change something. Build it is a button the
// server decides once (decidePlanTap, through the same endpoint as every
// bot button, B3), from the DM or the App tab; Change something is a reply
// quoting the card (changePlan), kept private and read by the next look. A
// newer plan, a new look at the request and a week with no tap each close
// the card (closePlanCards); its bullets stay.

const PLAN_KIND = 'plan';
const BUILD_IT = 'Build it';
// A reply to a plan that says to go ahead, rather than what to change.
const PLAN_GO_WORDS = new Set([
  'build it', 'build', 'yes', 'yes please', 'go', 'go ahead', 'do it', 'ok', 'okay', 'looks good', 'looks great',
  'sounds good', 'build it please',
]);

/** Pure (#4488): whether words written under a plan say to go ahead (PLAN_GO_WORDS). */
function isPlanGoWord(text) {
  return PLAN_GO_WORDS.has(String(text || '').trim().toLowerCase().replace(/[.!\s]+$/, '').replace(/\s+/g, ' '));
}

/** Pure (B6): a plan card's words, for the inbox, the push and anything that does not draw the card. */
function planCardText({ appName, plan, issueNumber = null }) {
  const bullets = (plan?.bullets || []).map((b) => `- ${b}`).join('\n');
  const asks = (plan?.questions || []).length
    ? `\n\n${plan.questions.length === 1 ? 'One choice' : 'Two choices'} for you, or I'll go with what I suggest.`
    : '';
  // #4488: a complicated change on a project that already exists: its plan,
  // and its before and after screens, are on the request too.
  if (plan?.complicated) {
    const line = issueNumber ? `**${appName}** request #${issueNumber}` : `your request on **${appName}**`;
    return `Before I build ${line}, here's my plan:\n\n${bullets}${asks}\n\nIts before and after screens are on the request. `
      + `Tap ${BUILD_IT} when it looks right, or Change something.`;
  }
  return `Here's my plan for **${appName}**:\n\n${bullets}${asks}\n\nTap ${BUILD_IT} when it looks right, or Change something.`;
}

/** The plan cards a person was sent about one request, newest first, with their state. */
async function planCards(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, d.run_id, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = $4
      ORDER BY d.message_id DESC`,
    [userId, appId, issueNumber, PLAN_KIND],
  );
  return rows;
}

/**
 * B6: send a first version's plan to its creator, when they are somebody the
 * bot talks to: the card with its buttons (metadata.plan, actionId), a "needs
 * your answer" moment. Earlier plans for it now read "Replaced by a newer
 * plan". Resolves what sendDm did; { messageId: null, stop } when there is
 * nobody to send it to (`no_requester`, or `no_bot`: the requester is no
 * longer someone the bot works for); or null when the send failed.
 */
async function sendPlanCard(pool, { app, issueNumber, runId, plan, bot, ws = null }) {
  if (!bot?.id || !app?.id || !runId || !plan?.bullets?.length) return null;
  const settings = await settingsModule().readSettings(pool);
  const requester = await requesterOf(pool, app.id, issueNumber);
  // #4175: nobody to send it to is said apart from a send that failed: the
  // first stops its run at once, the second is tried again.
  if (!requester) return { messageId: null, stop: 'no_requester' };
  if (!hasBot(settings, requester)) return { messageId: null, stop: 'no_bot' };
  const name = app.name || app.slug;
  const questions = (plan.questions || []).slice(0, 2);
  const { rows: [action] } = await pool.query(
    `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title)
     VALUES ($1, $2, 'build_plan', $3) RETURNING id`,
    [requester.userId, app.id, clip(`The plan for ${name}`, 200)],
  );
  // #4488: a complicated change on an existing project: not a first version,
  // with its spec (read on the request, whose card goes under the plan).
  const complicated = plan.complicated === true;
  const sent = await sendDm(pool, {
    bot,
    userId: requester.userId,
    content: planCardText({ appName: name, plan: { bullets: plan.bullets, questions, complicated }, issueNumber }),
    idempotencyKey: `hrbot-plan-${runId}`,
    metadata: {
      kind: PLAN_KIND, appSlug: app.slug, appName: name, issueNumber: Number(issueNumber), firstVersion: !complicated,
      plan: {
        bullets: plan.bullets, questions,
        ...(complicated ? { complicated: true, ...(plan.spec ? { spec: plan.spec } : {}) } : {}),
      },
      actionId: Number(action.id), status: 'open',
    },
    ...(complicated ? { objects: cardsFor(PLAN_KIND, {}, app, issueNumber) } : {}),
    replyToId: await requestStart(pool, { userId: requester.userId, appId: app.id, issueNumber }),
  });
  if (!sent?.messageId) {
    await pool.query('UPDATE homeroom_bot_dm_actions SET status = \'failed\', error = $2 WHERE id = $1', [action.id, 'not_sent']);
    return null;
  }
  await pool.query(
    'UPDATE homeroom_bot_dm_actions SET message_id = $2, conversation_id = $3 WHERE id = $1',
    [action.id, sent.messageId, sent.conversationId],
  ).catch(() => {});
  if (sent.duplicate) return sent;
  try {
    // Older plans for it give way to this one, and a question it had is done.
    for (const card of await planCards(pool, { userId: requester.userId, appId: app.id, issueNumber })) {
      if (Number(card.message_id) === Number(sent.messageId) || card.meta?.status === 'answered' || card.meta?.replaced) continue;
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'replaced\' WHERE message_id = $1 AND status = \'open\'',
        [card.message_id],
      );
      await setQuestionState(pool, Number(card.message_id), { status: 'closed', replaced: true }, {
        ws, conversationId: card.conversation_id, userId: requester.userId,
      });
    }
    await closeOpenQuestions(pool, { userId: requester.userId, appId: app.id, issueNumber, ws });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_id) DO NOTHING`,
      [sent.messageId, requester.userId, sent.conversationId, app.id, issueNumber, PLAN_KIND, runId],
    );
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Sent a plan, but could not record it', { app: app.slug, issueNumber, err: err.message });
  }
  log.info('homeroom-bot-dm', 'Sent a first version\'s plan', { app: app.slug, issueNumber, userId: requester.userId, runId });
  return sent;
}

/**
 * B6: the cards of plans that stopped waiting (`runIds`): their buttons go on
 * every device. `stopped` (a week with no tap) says so and asks for a reply;
 * otherwise the card reads "No longer needed", until a newer plan replaces
 * it. Never throws.
 */
async function closePlanCards(pool, runIds, { stopped = false, ws = null } = {}) {
  const ids = (runIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT message_id, conversation_id, user_id FROM homeroom_bot_dm_messages
        WHERE kind = $2 AND run_id = ANY($1::int[])`,
      [ids, PLAN_KIND],
    );
    for (const row of rows) {
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = $2 WHERE message_id = $1 AND status = \'open\'',
        [row.message_id, stopped ? 'stopped' : 'closed'],
      );
      await setQuestionState(pool, Number(row.message_id), stopped ? { status: 'closed', stopped: true } : { status: 'closed' }, {
        ws, conversationId: row.conversation_id, userId: row.user_id,
      });
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not close a plan\'s card', { runs: ids, err: err.message });
    return 0;
  }
}

/**
 * B6: Build it, tapped under a plan (`action`, a `build_plan`), on any device:
 * decided once, as decideOfferTap decides an offer. `answers` are the choices
 * tapped, in order; one left untouched goes with the suggested answer. The
 * card then reads "Building it", with its answers, everywhere. Resolves { ok: true,
 * choice, label } or { ok: false, status, error }.
 */
async function decidePlanTap(pool, { user, action, choice, answers = [], deps = {} }) {
  if (choice !== 'build') return { ok: false, status: 400, error: 'choice must be build' };
  const { rows: [card] } = await pool.query(
    'SELECT run_id, conversation_id FROM homeroom_bot_dm_messages WHERE message_id = $1 AND user_id = $2 AND kind = $3',
    [action.message_id, user.id, PLAN_KIND],
  );
  if (!card?.run_id) return { ok: false, status: 404, error: 'No such choice' };
  const { rows: claimed } = await pool.query(
    `UPDATE homeroom_bot_dm_actions SET status = 'done', decided_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING id`,
    [action.id, user.id],
  );
  if (!claimed.length) return { ok: false, status: 409, error: 'already_decided' };
  const went = await (deps.botSvc || settingsModule()).goAhead(pool, {
    runId: Number(card.run_id), answers: Array.isArray(answers) ? answers.slice(0, 2) : [],
  });
  if (!went.ok) {
    await pool.query('UPDATE homeroom_bot_dm_actions SET status = \'failed\', error = $2 WHERE id = $1', [action.id, 'plan_gone']);
    return { ok: false, status: 409, error: 'plan_gone' };
  }
  await setQuestionState(pool, Number(action.message_id), {
    status: 'answered', chosen: 'build', answer: BUILD_IT, choices: went.chosen.map((c) => c.answer),
  }, { ws: deps.ws || null, conversationId: card.conversation_id, userId: user.id }).catch(() => {});
  // The build's progress shows under the plan, where they tapped: the
  // request's card moves here (homeroom-bot-activity.js cardUnderPlan), as
  // the bot's thanks for answering (#4392).
  try {
    const { rows: [app] } = await pool.query('SELECT id, slug, name, icon_emoji FROM apps WHERE id = $1', [went.appId]);
    const requester = await requesterOf(pool, went.appId, went.issueNumber);
    const bot = deps.bot || await botAccount(pool);
    if (app && requester && Number(requester.userId) === Number(user.id) && bot) {
      await require('./homeroom-bot-activity').cardUnderPlan(pool, {
        app, issueNumber: went.issueNumber, runId: Number(card.run_id), planMessageId: Number(action.message_id),
        requester, bot, deps: { ws: deps.ws || null },
      });
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not move the card under the plan', { runId: Number(card.run_id), err: err.message });
  }
  try { require('./homeroom-bot-tray').noteWorkChanged(user.id, deps); } catch { /* the tray re-reads on its own */ }
  return { ok: true, choice: 'build', label: BUILD_IT };
}

/**
 * B6: a reply quoting a plan card (Change something, or a reply to a plan
 * that stopped waiting): their words are kept with the plan, never posted,
 * and the request is read again first in line with them (homeroom-bot.js
 * planChangesFor), which sends a new plan. The card's buttons go. Resolves
 * what the bot said back.
 */
async function changePlan(pool, { bot, user, target, message, deps = {} }) {
  const text = String(message.content || '').trim();
  const { rows: [app] } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [target.app_id]);
  if (!app) return null;
  const name = app.name || app.slug;
  const issueNumber = Number(target.issue_number);
  const reply = (content) => sendDm(pool, {
    bot, userId: user.id, replyToId: message.id, idempotencyKey: `hrbot-plan-change-${message.id}`, content, moment: 'reply',
    metadata: { kind: 'ack', appSlug: app.slug, appName: name, issueNumber, firstVersion: true },
  });
  if (!text) return reply(`Write what you'd like changed in the plan as a message, and I'll plan ${name} again.`);
  // "Build it" (or "yes") written under the plan is its button.
  if (PLAN_GO_WORDS.has(text.toLowerCase().replace(/[.!\s]+$/, '').replace(/\s+/g, ' '))) {
    const { rows: [action] } = await pool.query(
      'SELECT * FROM homeroom_bot_dm_actions WHERE message_id = $1 AND user_id = $2 AND kind = \'build_plan\'',
      [target.message_id, user.id],
    );
    if (action?.status === 'open') {
      const went = await decidePlanTap(pool, { user, action, choice: 'build', answers: [], deps });
      // #4392: the thanks Build it sent under the plan is the answer, said
      // once; said as words alone only when that card could not be sent.
      if (went.ok) {
        const activity = require('./homeroom-bot-activity');
        const thanks = await activity.requestCard(pool, { userId: user.id, appId: app.id, issueNumber });
        if (thanks && thanks.messageId > Number(target.message_id)) {
          return { conversationId: thanks.conversationId, messageId: thanks.messageId, duplicate: true };
        }
        return reply(activity.thanksText(name));
      }
    }
  }
  // Built already, or being built: a change then is a change to it, once it is ready to try.
  const { rows: [newest] } = await pool.query(
    `SELECT build_ok, live_build_waiting_at, build_session_id, proposal_session_id FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND mode = 'live' ORDER BY id DESC LIMIT 1`,
    [app.id, issueNumber],
  );
  if (newest && newest.build_ok !== false
    && (newest.live_build_waiting_at || newest.build_session_id || newest.proposal_session_id)) {
    return reply(`I've already started building ${name}. Once it's ready to try, tell me here what to change.`);
  }
  // #4488: a complicated change's plan is the request's, shared with its
  // group: what to change is said there, and its next look plans it again.
  const { rows: [planned] = [] } = await pool.query('SELECT plan FROM homeroom_bot_runs WHERE id = $1', [target.run_id]);
  if (planned?.plan?.complicated === true) {
    return changeOnRequest(pool, { user, target, text, app, issueNumber, reply, deps });
  }
  await pool.query(
    `UPDATE homeroom_bot_runs
        SET plan_change = $2, awaiting_go_at = NULL, build_ok = COALESCE(build_ok, FALSE),
            build_error = COALESCE(build_error, 'skipped: its creator asked to change the plan')
      WHERE id = $1 AND build_session_id IS NULL AND proposal_session_id IS NULL`,
    [target.run_id, clip(text, 3000)],
  );
  await pool.query(
    'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'changed\' WHERE message_id = $1 AND status = \'open\'',
    [target.message_id],
  );
  await setQuestionState(pool, Number(target.message_id), { status: 'closed', changing: true }, {
    ws: deps.ws || null, conversationId: target.conversation_id, userId: user.id,
  });
  let queued = null;
  try {
    queued = await settingsModule().enqueueFront(pool, { appId: app.id, issueNumber, userId: user.id, reason: 'plan_change' });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not put a changed plan first', { app: app.slug, issueNumber, err: err.message });
  }
  // The request's card follows the new look from here.
  const requester = await requesterOf(pool, app.id, issueNumber);
  if (queued?.id && requester) {
    await require('./homeroom-bot-activity').startCard(pool, {
      app, issueNumber, bot, jobKey: Number(queued.id), queued: true, requester,
    });
  }
  log.info('homeroom-bot-dm', 'A first version\'s plan is planned again with its creator\'s words', {
    app: app.slug, issueNumber, userId: user.id,
  });
  return reply(`Thanks. I'll work that into a new plan for ${name} and send it here.`);
}

/**
 * #4488: Change something under a complicated change's plan: their words are
 * posted on the request's discussion as theirs (postOnRequest, which puts
 * it first in the bot's queue), the plan stops waiting and its card says
 * changes were asked for. Its next look plans it again with them, and the
 * new plan comes here and to the request. Resolves what the bot said back.
 */
async function changeOnRequest(pool, { user, target, text, app, issueNumber, reply, deps = {} }) {
  const line = `${app.name || app.slug} request #${issueNumber}`;
  const posted = await postOnRequest(pool, { user, target, text, reason: 'plan_change', deps });
  if (!posted.ok) return reply(`I couldn't post that on ${line}: ${posted.why}. Nothing was sent.`);
  await pool.query(
    `UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, build_ok = COALESCE(build_ok, FALSE),
            build_error = COALESCE(build_error, 'skipped: its requester asked to change the plan')
      WHERE id = $1 AND awaiting_go_at IS NOT NULL AND build_session_id IS NULL AND proposal_session_id IS NULL`,
    [target.run_id],
  );
  await pool.query(
    'UPDATE homeroom_bot_dm_actions SET status = \'declined\', decided_at = NOW(), error = \'changed\' WHERE message_id = $1 AND status = \'open\'',
    [target.message_id],
  );
  await setQuestionState(pool, Number(target.message_id), { status: 'closed', changing: true }, {
    ws: deps.ws || null, conversationId: target.conversation_id, userId: user.id,
  });
  log.info('homeroom-bot-dm', 'A complicated change\'s plan is planned again with its requester\'s words, posted on the request', {
    app: app.slug, issueNumber, userId: user.id,
  });
  return reply(`Thanks. I posted that on ${line}'s public discussion, and I'll plan it again with it and send the new plan here.`);
}

/**
 * #4488: a complicated change's plan its requester said Build it to on the
 * request itself: its card, wherever it was sent, says "Building it" with
 * the answers it went with. Never throws.
 */
async function markPlanBuilt(pool, runId, { chosen = [], ws = null } = {}) {
  try {
    const { rows } = await pool.query(
      'SELECT message_id, conversation_id, user_id FROM homeroom_bot_dm_messages WHERE kind = $2 AND run_id = $1',
      [Number(runId), PLAN_KIND],
    );
    for (const row of rows) {
      await pool.query(
        'UPDATE homeroom_bot_dm_actions SET status = \'done\', decided_at = NOW() WHERE message_id = $1 AND status = \'open\'',
        [row.message_id],
      );
      await setQuestionState(pool, Number(row.message_id), {
        status: 'answered', chosen: 'build', answer: BUILD_IT, choices: (chosen || []).map((c) => c.answer),
      }, { ws, conversationId: row.conversation_id, userId: row.user_id });
    }
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not mark a plan as built', { runId, err: err.message });
    return 0;
  }
}

/**
 * B6: the plan a first version waits on, for its App tab: { bullets,
 * questions, actionId, messageId, conversationId }, or null.
 */
async function waitingPlan(pool, { userId, appId, issueNumber }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, a.id AS action_id, m.metadata->'homeroomBot'->'plan' AS plan
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
       JOIN homeroom_bot_dm_actions a ON a.message_id = d.message_id AND a.status = 'open'
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = $4
      ORDER BY d.message_id DESC LIMIT 1`,
    [userId, appId, issueNumber, PLAN_KIND],
  );
  const row = rows[0];
  if (!row || !Array.isArray(row.plan?.bullets)) return null;
  return {
    bullets: row.plan.bullets,
    questions: Array.isArray(row.plan.questions) ? row.plan.questions : [],
    actionId: Number(row.action_id),
    messageId: Number(row.message_id),
    conversationId: Number(row.conversation_id) || null,
  };
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
 * its checks passed or skipped, and its before & after shots on that head
 * settled (shots-state.holdsReady): the shots agent tries what the change
 * says it does, and a change whose main action fails is not offered as
 * ready (Flat 4B Chores, whose "mark as done" answered a 500 on every tap
 * while its checks passed). Resolves { ready, epoch, waitingOnShots, broken },
 * `broken` being the declared changes those shots show failing
 * (shots-state.brokenOnHead), or null for no such change.
 */
async function changeReadiness(pool, sessionId, { now = Date.now() } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(
    `SELECT status, check_state, approval_epoch, source, reviewed_head_sha, imported_pr_head_sha,
            checks_commit_sha, handoff_head_sha, checks_checked_at,
            shots_state, shots_run_id, shots_detail, shots_updated_at,
            pr_title, pr_title_fallback, session_title
       FROM chat_sessions WHERE id = $1`, [id],
  );
  const row = rows[0];
  if (!row) return null;
  const shotsState = require('./shots-state');
  const head = require('./pr-vote-revision').visualHeadForSession(row);
  const checked = row.status === 'promoted' && READY_CHECKS.has(row.check_state);
  const waitingOnShots = checked && shotsState.holdsReady(row, head, { now });
  return {
    ready: checked && !waitingOnShots,
    epoch: Number(row.approval_epoch) || 0,
    waitingOnShots,
    broken: checked ? shotsState.brokenOnHead(row, head) : [],
    // #3870: what the change is, for its ready card: its proposal's title,
    // unless that is the placeholder written while titles could not be
    // made, else its session's.
    title: changeTitle(row),
  };
}

/** Pure (#3870): a change's own title, in one line, or null. */
function changeTitle(row) {
  const pr = !row?.pr_title_fallback && typeof row?.pr_title === 'string' ? row.pr_title.trim() : '';
  const own = pr || (typeof row?.session_title === 'string' ? row.session_title.trim() : '');
  return own ? clip(own.replace(/\s+/g, ' '), 200) : null;
}

/**
 * Pure: the short words a ready card uses for what does not work, one per
 * failed change, from shots-state.brokenOnHead's entries or from words
 * already made (the card's own `broken`).
 */
function brokenWords(broken) {
  return (Array.isArray(broken) ? broken : []).slice(0, 3)
    .map((b) => clip(String((typeof b === 'string' ? b : b?.claim) || '').replace(/\s+/g, ' '), 200)).filter(Boolean);
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
    if (!state?.ready) {
      if (state?.waitingOnShots) {
        log.info('homeroom-bot-dm', 'A change passed its checks; its requester hears once its before & after shots settle', { sessionId: id });
      }
      return null;
    }
    const { rows } = await pool.query(
      `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name
         FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
        WHERE r.proposal_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    if (!rows[0]) return null;
    const run = rows[0];
    // Its shots show part of it failing: the bot fixes that first, in the
    // same round a failing check gets (homeroom-bot.js noteProposalChecks,
    // once per head and within its revisions). Only when no such round is
    // due (it already looked at this head, has no revisions left, or is not
    // working on this app) does the card go out, saying what does not work.
    const broken = brokenWords(state.broken);
    if (broken.length) {
      const handedBack = await settingsModule().noteProposalChecks(pool, { sessionId: id }).catch(() => false);
      if (handedBack) {
        log.info('homeroom-bot-dm', 'A change\'s shots show part of it failing; the bot fixes it before its requester hears', {
          sessionId: id, failed: broken.length,
        });
        return null;
      }
    }
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const domain = deps.domain || require('./caddy').USERNODE_DOMAIN;
    const link = require('./homeroom-bot-live').proposalLink(domain, run.slug, id);
    // B7: what its asker can do on the card, and who else must approve it.
    const requester = await requesterOf(pool, run.id, Number(run.issue_number));
    const approval = await approvalState(pool, { sessionId: id, userId: requester?.userId || null }).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not read who approves a change (sending its card without Approve)', { sessionId: id, err: err.message });
      return null;
    });
    const waiting = approval
      ? await usernamesOf(pool, await needsYesFrom(pool, approval, { except: requester?.userId ? [requester.userId] : [] }))
      : [];
    const told = await relayIssuePost({
      pool, ws: deps.ws || null, app: { id: run.id, slug: run.slug, name: run.name }, issueNumber: Number(run.issue_number),
      kind: 'proposal', runId: Number(run.run_id), bot, ready: true, key: readyKey(id, state.epoch),
      dm: {
        link, sessionId: id, epoch: state.epoch,
        ...(state.title ? { title: state.title } : {}),
        card: {
          approve: !!(approval?.counts && !approval.already),
          last: !!approval?.last,
          // Nobody else is asked on a project of one; and never a long list.
          waitingOn: waiting.slice(0, 3),
          more: Math.max(waiting.length - 3, 0),
          // How many of them it needs (Page Turners, 5 October: two of
          // three, not all three), so the card can say any of them will do.
          ...(approval ? { missing: approval.missing, needed: approval.needed } : {}),
          // What its shots show not working, said on the card.
          ...(broken.length ? { broken } : {}),
        },
      },
    });
    // Nobody else is asked to approve a change part of which does not work:
    // its requester's card says what, and the bot's hand-off said so where
    // the group talks about it.
    if (approval && !broken.length) await noteApproversReady(pool, { sessionId: id, epoch: state.epoch, requesterId: requester?.userId || null, state: approval });
    // B9: and the chat message it was asked in, if it was, says Try it.
    await require('./homeroom-bot-chat').noteRequestStatus(pool, {
      appId: run.id, issueNumber: Number(run.issue_number), status: 'ready', sessionId: id,
    });
    return told;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change is ready', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * A proposal's before & after shots settled (shots-state.noteSettled: a run
 * published or failed, was waived, or will not start). A change of the
 * bot's that passed its checks was waiting on them: it is ready to try now,
 * or, when they show part of it failing, it goes back to the bot to fix
 * first (noteChangeReady). One indexed read for any other proposal. Never
 * throws.
 */
function noteShotsSettled(pool, sessionId, deps = {}) {
  return noteChangeReady(pool, sessionId, deps);
}

// How long after a held change's limit the bot's refresh (every five
// minutes) keeps asking: a few passes, so a short pause of the loop does not
// miss it.
const HELD_READY_WINDOW_MS = 20 * 60 * 1000;

/**
 * The bot's refresh: a change of the bot's that passed its checks
 * READY_HOLD_MS ago (and no more than HELD_READY_WINDOW_MS before that) may
 * have been waiting on shots that never settled; shots-state.holdsReady
 * stops waiting then, so asked again it is sent now. Every settle already
 * asks (noteShotsSettled); this is the backstop. Sending is idempotent per
 * approval epoch, so a change already told is not told twice. Resolves how
 * many were looked at; never throws.
 */
async function sweepHeldReady(pool, deps = {}) {
  try {
    const holdMs = require('./shots-state').READY_HOLD_MS;
    const { rows } = await pool.query(
      `SELECT cs.id FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
        WHERE u.username = $1 AND u.is_synthetic = TRUE
          AND cs.status = 'promoted' AND cs.check_state IN ('passing', 'skipped')
          AND cs.checks_checked_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond')
          AND cs.checks_checked_at > NOW() - (($2::bigint + $3::bigint) * INTERVAL '1 millisecond')
        ORDER BY cs.id LIMIT 20`,
      [BOT_USERNAME, holdMs, HELD_READY_WINDOW_MS],
    );
    for (const row of rows) await noteChangeReady(pool, row.id, deps);
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not look for changes held on their shots', { err: err.message });
    return 0;
  }
}

// ── B7: ready to try, and who approves it ───────────────────────────────

/**
 * B7: where approval of one change stands, for whoever asked for it
 * (`userId`): whose Yes counts on its project (governance.js: the approvers
 * a project names, else everybody), how many it needs and has, how many
 * more it needs (`missing`: 0 once it has them, the count behind the change
 * page's "1/2"), and whether this person's Yes counts, is in already, and
 * would be the last one needed. `gate` is the merge gate as it stands
 * (governance.governedGate, with the change's own explicit-approval flag,
 * so no clock is promised to a change that has none). Null for no such
 * change.
 */
async function approvalState(pool, { sessionId, userId = null }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const communities = require('./communities');
  const { rows: [session] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.approval_epoch, COALESCE(cs.promoted_at, cs.created_at) AS opened_at,
            COALESCE(cs.requires_explicit_approval, FALSE) AS explicit_approval,
            ${communities.audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}
              AS audience
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [id],
  );
  if (!session) return null;
  const governance = require('./governance');
  const { countedVotePredicateSql } = require('./pr-vote-revision');
  const gov = await governance.getGovernance(pool, session.app_id);
  const electorate = await governance.getElectorate(pool, session.app_id, gov);
  const gate = await governance.governedGate(pool, session.app_id, {
    kind: 'pr', id, openedAt: session.opened_at,
    explicitApproval: session.explicit_approval === true, authorId: session.user_id ?? null,
  });
  const { rows: yes } = await pool.query(
    `SELECT pv.user_id FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1 AND pv.vote = 'yes' AND ${countedVotePredicateSql('pv', 'cs')}`,
    [id],
  );
  const yesIds = new Set(yes.map((r) => Number(r.user_id)));
  const who = Number(userId) || null;
  const counts = !!who && (electorate.approverIds == null || electorate.approverIds.map(Number).includes(who));
  const already = !!who && yesIds.has(who);
  const needed = Math.max(Number(gate.required ?? gate.approvalsRequired ?? 1) || 1, 1);
  const have = Math.max(Number(gate.qualifiedYes) || 0, 0);
  const missing = gate.thresholdMet ? 0 : Math.max(needed - have, 1);
  return {
    session, gov, electorate, gate, yesIds, needed, have, missing,
    counts, already,
    last: counts && !already && have + 1 >= needed,
    audience: session.audience,
  };
}

/**
 * B7: who still has to approve a change before it goes live, for its "ready
 * to try" notification: the approvers its project names; otherwise, on a
 * project that is just one person's or a private community's, the people
 * active on it (or, when nobody is yet, its members). A public community
 * tells nobody this way (decided: everybody there could vote), unless it
 * names its approvers. Never the bot, a test account, whoever proposed it,
 * anybody whose Yes is in, or `except`. Resolves user ids.
 */
async function needsYesFrom(pool, state, { except = [] } = {}) {
  if (!state?.session) return [];
  const appId = Number(state.session.app_id);
  let ids;
  if (state.gov.approverPolicy === 'invited') {
    ids = state.electorate.adminFallback ? [] : state.electorate.approverIds;
  } else if (state.audience === 'open') {
    ids = [];
  } else {
    ids = await require('./active-users').listActiveUserIds(pool, appId);
    if (!ids.length) {
      const { rows } = await pool.query(
        `SELECT m.user_id FROM apps a JOIN community_members m ON m.community_id = a.community_id WHERE a.id = $1`,
        [appId],
      );
      ids = rows.map((r) => r.user_id);
    }
  }
  const skip = new Set([...state.yesIds, Number(state.session.user_id), ...except.map(Number)]);
  const wanted = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && !skip.has(n));
  if (!wanted.length) return [];
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
      WHERE u.id = ANY($1::int[]) AND u.is_synthetic = FALSE AND counts_toward_session_outcome(u.id, $2)`,
    [wanted, Number(state.session.id)],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Pure (B7): the buttons of a change's "ready to try" card: Try it (its
 * preview), Approve when the person's Yes counts and is not in yet (their
 * own Yes, cast from their own browser), and Change something (a reply to
 * the card). One is filled: Approve when there is one, else Try it.
 */
function readyActions({ sessionId, epoch, approve }) {
  const id = Number(sessionId);
  return [
    { id: 'try', label: 'Try it', style: approve ? 'secondary' : 'primary', type: 'preview', sessionId: id },
    ...(approve ? [{ id: 'approve', label: 'Approve', style: 'primary', type: 'vote', sessionId: id, epoch: Number(epoch) || 0 }] : []),
    { id: 'change', label: 'Change something', style: 'secondary', type: 'reply' },
  ];
}

/** Usernames, for "Waiting for approval from …". */
async function usernamesOf(pool, ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query('SELECT id, username FROM users WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r.username]));
  return ids.map((n) => byId.get(Number(n))).filter(Boolean);
}

/**
 * B7: tell the people whose Yes a change still needs that it is ready to
 * try, once per approval epoch: a `change_ready` notification (on by
 * default, and pushed), from whoever asked for it. Never its asker, who has
 * the card. Resolves the rows made. Never throws.
 */
async function noteApproversReady(pool, { sessionId, epoch, requesterId = null, state = null }) {
  try {
    const known = state || await approvalState(pool, { sessionId });
    if (!known) return [];
    const recipients = await needsYesFrom(pool, known, { except: requesterId ? [requesterId] : [] });
    if (!recipients.length) return [];
    const notifications = require('./notifications');
    const rows = await notifications.createChangeReadyNotifications(pool, {
      appId: Number(known.session.app_id), sessionId: Number(sessionId), sourceUserId: requesterId, recipientIds: recipients, epoch,
    });
    for (const row of rows) await notifications.hydrateAndPush(pool, row).catch(() => {});
    if (rows.length) log.info('homeroom-bot-dm', 'Told who must approve that a change is ready to try', { sessionId, people: rows.length });
    return rows;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell who must approve that a change is ready', { sessionId, err: err.message });
    return [];
  }
}

/**
 * Pure (B7): what happens next to a change once its person has said Yes,
 * for the line their ready card shows from then on ("You approved it. It
 * goes live …"). `gate` is the change's merge gate counted with their Yes
 * (approvalState), `waiting` the usernames of whoever else it still waits on
 * (needsYesFrom). Either it goes live in a minute or two, because nothing
 * more is needed (`soon`); or it needs `missing` more Yes votes (0 when it
 * has them and only its clock runs), `waitingOn` names up to three of the
 * people asked and `more` counts the rest, and `at` is when it goes live
 * anyway if nobody objects: the lazy-consensus window's end
 * (active-users.js lazyWindowMs, from when it went up for approval), or the
 * visibility window of a change that has its approvals. A change with
 * neither clock has no `at`. The client words it, in the reader's own time
 * zone (frontend/src/features/messages/bot-ready.tsx approvedLine).
 */
function goesLiveAfterYes(gate, waiting = []) {
  if (!gate) return null;
  if (gate.mergeable) return { soon: true };
  const clock = (gate.thresholdMet || gate.lazyArmed) && gate.windowEndsAt ? String(gate.windowEndsAt) : null;
  const missing = gate.thresholdMet
    ? 0
    : Math.max((Number(gate.required) || 1) - (Number(gate.qualifiedYes) || 0), 1);
  const names = missing ? waiting.filter((name) => typeof name === 'string' && name) : [];
  return { soon: false, at: clock, missing, waitingOn: names.slice(0, 3), more: Math.max(names.length - 3, 0) };
}

/** B7: goesLiveAfterYes for one change, read now, after `userId`'s Yes was recorded. Null when it cannot be read. */
async function goesLiveFor(pool, sessionId, userId) {
  const state = await approvalState(pool, { sessionId, userId });
  if (!state) return null;
  const waiting = await usernamesOf(pool, await needsYesFrom(pool, state, { except: [Number(userId)] }));
  return goesLiveAfterYes(state.gate, waiting);
}

/**
 * B7: `userId` said Yes to one of the bot's changes (routes/votes.js), from
 * its card, the change page or anywhere else: the "ready to try" cards they
 * were sent about it stop offering Approve, on every device, and say what
 * happens next instead (`goesLive`, goesLiveAfterYes). Resolves that, for
 * the vote's own answer to carry to the card that was tapped; null when no
 * card of theirs was waiting on this Yes, or when what happens next could
 * not be read (the card then words it from what it was sent with). Never
 * throws.
 */
async function noteApproved(pool, sessionId, userId, deps = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT d.message_id, d.conversation_id, m.metadata->'homeroomBot' AS meta
         FROM homeroom_bot_dm_messages d
         JOIN conversation_messages m ON m.id = d.message_id
         JOIN homeroom_bot_runs r ON r.id = d.run_id
        WHERE d.user_id = $1 AND d.kind = 'proposal' AND r.proposal_session_id = $2`,
      [userId, sessionId],
    );
    const open = rows.filter((row) => row.meta?.ready && row.meta.status === 'open');
    if (!open.length) return null;
    // Read once, for every card about it. A card still settles without it.
    const goesLive = await goesLiveFor(pool, sessionId, userId).catch((err) => {
      log.warn('homeroom-bot-dm', 'Could not read what happens next to an approved change', { sessionId, err: err.message });
      return null;
    });
    for (const row of open) {
      await setQuestionState(pool, Number(row.message_id), {
        status: 'answered', chosen: 'approve', answer: 'Approve', ...(goesLive ? { goesLive } : {}),
      }, {
        ws: deps.ws || null, conversationId: row.conversation_id, userId,
      });
    }
    return goesLive;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not settle a change\'s ready card after a Yes', { sessionId, userId, err: err.message });
    return null;
  }
}

/** B7: the "ready to try" cards sent about older versions of a change give way to the newest. */
async function closeOlderReadyCards(pool, { userId, appId, issueNumber, keepMessageId, ws = null }) {
  const { rows } = await pool.query(
    `SELECT d.message_id, d.conversation_id, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.user_id = $1 AND d.app_id = $2 AND d.issue_number = $3 AND d.kind = 'proposal' AND d.message_id <> $4`,
    [userId, appId, issueNumber, keepMessageId],
  );
  for (const row of rows) {
    if (!row.meta?.ready || row.meta.status !== 'open') continue;
    await setQuestionState(pool, Number(row.message_id), { status: 'closed', updated: true }, {
      ws, conversationId: row.conversation_id, userId,
    });
  }
}

// ── A ready card, read as it stands now ─────────────────────────────────
//
// A ready card is a message, sent once, and what it says about approval was
// true when it was sent. Page Turners, 5 October: the maker's card still
// said "It goes live when one more person approves" twenty minutes after the
// change went live, and "Needs 2 approvals from you, @priya or @mo" never
// moved as the others said Yes. So a ready card is read again whenever the
// DM reads its activity cards (homeroom-bot-activity.js cardsFor), on the
// same events: the bot's news landing in the DM (its "It's live now." is
// one), the loop's work changing (a merge or a close announces it,
// noteProposalChanged), and a vote on the change (noteVoted). What is read
// is where the change stands now and, while it is up for approval, who it
// still waits on and what happens next once the reader has said Yes.
// Nothing is written: the message keeps its words for the inbox and the push.

// The most ready cards one read answers for, newest first (an older one
// keeps what its message says), and the most changes up for approval whose
// approval it reads (a few reads of the project's rules each).
const MAX_READY_READS = 12;
const MAX_READY_APPROVALS = 4;

/** The reader's newest ready cards, each with its change and its app (with the columns app-access reads). */
async function readyRows(pool, userId) {
  const { rows } = await pool.query(
    `SELECT d.message_id, cs.id AS session_id, cs.status, cs.live_at,
            a.id, a.slug, a.name, a.created_by, a.self_hosted, a.collab_visibility, a.view_visibility,
            a.moderation_suspended_at
       FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id AND m.deleted_at IS NULL
       JOIN apps a ON a.id = d.app_id
       JOIN chat_sessions cs ON cs.app_id = d.app_id
        AND cs.id = (CASE WHEN m.metadata->'homeroomBot'->>'sessionId' ~ '^[1-9][0-9]{0,8}$'
                          THEN (m.metadata->'homeroomBot'->>'sessionId')::int END)
      WHERE d.user_id = $1 AND d.kind = 'proposal'
        AND jsonb_typeof(m.metadata->'homeroomBot'->'ready') = 'object'
      ORDER BY d.message_id DESC
      LIMIT $2`,
    [userId, MAX_READY_READS],
  );
  return rows;
}

/**
 * Pure: where a ready card's change stands, from a readyRows row: `live`
 * (merged), `going_live` (being merged), `closed` (closed without going
 * live), or `open` (still up for approval; its approval is read apart).
 * Null for anything else: the card keeps what it said.
 *
 * #4228: a live card has no button. The news that it went live comes right
 * after it with its own Open (noteProposalMerged), and the card's second
 * Open just above it was the same button twice.
 */
function readyStateOf(row) {
  const base = { messageId: Number(row.message_id) };
  // Merged is live once production runs it (chat_sessions.live_at); until
  // then it is going live, as while it merges.
  if (row.status === 'merged' && !row.live_at) return { ...base, state: 'going_live', actions: [] };
  if (row.status === 'merged') return { ...base, state: 'live', actions: [] };
  if (row.status === 'merging') return { ...base, state: 'going_live', actions: [] };
  if (row.status === 'closed' || row.status === 'archived') return { ...base, state: 'closed', actions: [] };
  if (row.status === 'promoted') return { ...base, state: 'open', actions: [] };
  return null;
}

/**
 * Where approval of one change stands for `userId`, as their card draws it:
 * how many more it needs and in all, whether theirs would be the last, whom
 * else it waits on (needsYesFrom, as the card was sent with), whether their
 * Yes is in and, once it is, what happens next (goesLiveAfterYes).
 */
async function readyApproval(pool, sessionId, userId) {
  const state = await approvalState(pool, { sessionId, userId });
  if (!state) return null;
  const names = state.missing === 0 ? [] : await usernamesOf(pool, await needsYesFrom(pool, state, { except: [Number(userId)] }));
  return {
    approval: {
      missing: state.missing,
      needed: state.needed,
      last: !!state.last,
      approved: !!state.already,
      waitingOn: names.slice(0, 3),
      more: Math.max(names.length - 3, 0),
    },
    ...(state.already ? { goesLive: goesLiveAfterYes(state.gate, names) } : {}),
  };
}

/**
 * The signed-in person's ready cards as they stand now (see the note above):
 * [{ messageId, state, actions, approval?, goesLive? }], newest first. Their
 * own cards only, on projects they can still view. A change whose approval
 * could not be read is left out, and its card says what it was sent with.
 */
async function readyStates(pool, { user }) {
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const rows = await readyRows(pool, userId);
  if (!rows.length) return [];
  const appAccess = require('./app-access');
  const viewable = new Map();
  const approvals = new Map();
  const out = [];
  for (const row of rows) {
    const appId = Number(row.id);
    if (!viewable.has(appId)) viewable.set(appId, await appAccess.checkAppAccess(pool, row, user, 'view').catch(() => false));
    if (!viewable.get(appId)) continue;
    const state = readyStateOf(row);
    if (!state) continue;
    if (state.state === 'open') {
      const sessionId = Number(row.session_id);
      if (!approvals.has(sessionId)) {
        if (approvals.size >= MAX_READY_APPROVALS) continue;
        approvals.set(sessionId, await readyApproval(pool, sessionId, userId).catch((err) => {
          log.warn('homeroom-bot-dm', 'Could not read where a ready card\'s change stands', { sessionId, err: err.message });
          return null;
        }));
      }
      const read = approvals.get(sessionId);
      if (!read) continue;
      Object.assign(state, read);
    }
    out.push(state);
  }
  return out;
}

/**
 * Somebody voted on a change (routes/votes.js). When it is one of the
 * bot's, whoever asked for it has their DM read again, so their ready card
 * says who it still waits on as it stands now (readyStates): it used to keep
 * the names it was sent with until the change went live. One indexed read
 * for any other change. Resolves the requester's id, or null. Never throws.
 */
async function noteVoted(pool, sessionId, deps = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query(
      `SELECT q.user_id
         FROM homeroom_bot_runs r
         JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
        WHERE r.proposal_session_id = $1
        ORDER BY r.id DESC LIMIT 1`,
      [id],
    );
    if (!rows.length) return null;
    require('./homeroom-bot-tray').noteWorkChanged(rows[0].user_id, deps);
    return Number(rows[0].user_id);
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not announce a vote on the bot\'s change', { sessionId: id, err: err.message });
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

/**
 * Pure (#4242): what the "needs a look" message says: `checks`, its checks
 * failed in a way that looks like the platform's (the bot leaves those for
 * the platform's own re-run, homeroom-bot.js noteProposalChecks); `built`,
 * its build finished and no change came of it.
 */
function needsLookText(line, why) {
  if (why === 'checks') {
    return `${line}\n\nI built it, but its checks failed in a way that looks like a problem on Homeroom's side, `
      + 'not in the change, so it isn\'t ready to try yet. Homeroom runs them again, and I\'ll tell you here if they pass. '
      + 'If nothing changes, the change needs a person to look at it.';
  }
  return `${line}\n\nI built it, but it didn't become a change you can try, and I can't fix that from here. `
    + 'It needs a person to look at it. Your request is still open.';
}

/**
 * #4242: one of the bot's builds came to nothing anybody will be told about
 * without a person: its proposal's checks failed on what looks like the
 * platform (`why` 'checks', by `sessionId`), or its build succeeded and no
 * proposal was recorded for it (`why` 'built', by `runId`). Its requester
 * hears it, ringing, once per approval epoch or per run, and the request's
 * activity card stops saying it is still being checked (homeroom-bot-
 * activity.js outcomeOf, which reads the row recorded here). Never throws.
 */
async function noteNeedsLook(pool, { sessionId = null, runId = null, why = 'checks', deps = {} } = {}) {
  const id = Number(why === 'checks' ? sessionId : runId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows } = why === 'checks'
      ? await pool.query(
        `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name, cs.status, cs.approval_epoch
           FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id JOIN chat_sessions cs ON cs.id = r.proposal_session_id
          WHERE r.proposal_session_id = $1
          ORDER BY r.id DESC LIMIT 1`,
        [id],
      )
      : await pool.query(
        `SELECT r.id AS run_id, r.issue_number, a.id, a.slug, a.name, NULL::text AS status, 0 AS approval_epoch
           FROM homeroom_bot_runs r JOIN apps a ON a.id = r.app_id
          WHERE r.id = $1 AND r.build_ok IS TRUE AND r.proposal_session_id IS NULL`,
        [id],
      );
    const run = rows[0];
    if (!run || (why === 'checks' && run.status !== 'promoted')) return null;
    const settings = await settingsModule().readSettings(pool);
    const issueNumber = Number(run.issue_number);
    const requester = await requesterOf(pool, run.id, issueNumber);
    if (!requester || !hasBot(settings, requester)) return null;
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const context = {
      appName: run.name || run.slug, issueNumber, issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
    };
    const sent = await sendDm(pool, {
      bot,
      userId: requester.userId,
      replyToId: await requestStart(pool, { userId: requester.userId, appId: run.id, issueNumber }),
      idempotencyKey: why === 'checks'
        ? `hrbot-needs-look-checks-${id}-${Number(run.approval_epoch) || 0}`
        : `hrbot-needs-look-built-${id}`,
      content: needsLookText(requestLine(context), why),
      metadata: {
        kind: 'needs_look', appSlug: run.slug, appName: context.appName, issueNumber,
        ...(context.firstVersion ? { firstVersion: true } : {}),
      },
      objects: why === 'checks' ? cardsFor('proposal', { sessionId: id }, { id: run.id }, issueNumber) : [],
    });
    if (sent?.messageId && !sent.duplicate) {
      await pool.query(
        `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
         VALUES ($1, $2, $3, $4, $5, 'needs_look', $6)
         ON CONFLICT (message_id) DO NOTHING`,
        [sent.messageId, requester.userId, sent.conversationId, run.id, issueNumber, Number(run.run_id) || null],
      );
      require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
      log.info('homeroom-bot-dm', 'Told the requester their change needs a look', {
        app: run.slug, issueNumber, why, sessionId: why === 'checks' ? id : null, runId: Number(run.run_id) || null,
      });
    }
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not tell the requester their change needs a look', { why, id, err: err.message });
    return null;
  }
}

// How long a build that succeeded may go without a proposal before its
// requester is told it needs a look, and how far back the bot's refresh
// looks for one (a few passes of it, so a short pause does not miss it).
const UNPROPOSED_AFTER_MS = 30 * 60 * 1000;
const UNPROPOSED_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * #4242: the bot's refresh: a live build of the bot's that succeeded and
 * recorded no proposal for UNPROPOSED_AFTER_MS (homeroom-bot.js
 * announceBuilt records it right after the build) came to nothing anybody
 * is told about, so its requester hears it needs a look (noteNeedsLook,
 * once per run). Resolves how many were looked at; never throws.
 */
async function sweepUnproposedBuilds(pool, deps = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT r.id FROM homeroom_bot_runs r
        WHERE r.mode = 'live' AND r.verdict = 'ready' AND r.build_ok IS TRUE AND r.proposal_session_id IS NULL
          AND r.created_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
          AND r.created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM homeroom_bot_dm_messages d WHERE d.run_id = r.id AND d.kind = 'needs_look'
          )
        ORDER BY r.id LIMIT 20`,
      [UNPROPOSED_AFTER_MS, UNPROPOSED_WINDOW_MS],
    );
    for (const row of rows) await noteNeedsLook(pool, { runId: row.id, why: 'built', deps });
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not look for builds that recorded no proposal', { err: err.message });
    return 0;
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
 * health could not be confirmed yet. `card`: a way to open the app goes
 * under it (its Open button, openAppAction).
 */
function mergedText({ line, appName, live, platform = false, card = true, change = false }) {
  // B7: a change to a project is "your change"; a first version is the project.
  const it = change ? 'Your change is' : 'It\'s';
  const said = live ? `${it} live now.` : `${it} going live now and will be ready in a few minutes.`;
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

function noteChatLive(pool, run) {
  return require('./homeroom-bot-chat').noteRequestStatus(pool, { appId: run.app_id, issueNumber: Number(run.issue_number), status: 'live' });
}

// WP-F: how often, and how far apart, a merged app that did not answer yet
// is read again before its chat chip says Live. One that never answers keeps
// the chip it had: it is not live.
const LATE_LIVE_TRIES = 5;
const LATE_LIVE_WAIT_MS = 60 * 1000;

/** The chip's Live, later: read the app again a few times, a minute apart. Never throws. */
function laterChatLive(pool, run, { config, sha, deps = {} }) {
  if (!config || !sha) return;
  const later = deps.later || ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  let tries = 0;
  const again = async () => {
    tries += 1;
    try {
      if (await liveAfterMerge(config, { ...run, id: run.app_id }, { sha, deps })) {
        await noteChatLive(pool, run);
        return;
      }
    } catch (err) {
      log.warn('homeroom-bot-dm', 'Could not read a merged app again', { app: run.slug, err: err.message });
    }
    if (tries < LATE_LIVE_TRIES) later(again, LATE_LIVE_WAIT_MS);
  };
  later(again, LATE_LIVE_WAIT_MS);
}

/**
 * Pure (#4238): what Homeroom bot says in a new project's channel when its
 * first version is made. Its Open button (openAppAction) is the way in.
 */
function firstVersionText({ appName, live }) {
  const ready = live ? '' : ' It will be ready to open in a few minutes.';
  return `I've made the first version of ${appName}!${ready} Let me know if you need anything else.`;
}

/**
 * #4238: the one line the bot writes in a project's channel (the group
 * chat), when its first version is made: ws.sendFirstVersionMessage, which
 * writes it once per project. Never throws: the DM still goes.
 */
async function announceFirstVersion(pool, run, { live = false, deps = {} } = {}) {
  try {
    const bot = deps.bot || await botAccount(pool);
    if (!bot) return null;
    const appName = run.name || run.slug;
    const open = openAppAction({ slug: run.slug, appName });
    const ws = deps.ws || require('./ws');
    return await ws.sendFirstVersionMessage(pool, run.app_id, {
      user: bot,
      content: firstVersionText({ appName, live }),
      metadata: { appSlug: run.slug, ...(open ? { actions: [open] } : {}) },
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not announce a first version in its channel', { app: run?.slug, err: err.message });
    return null;
  }
}

/**
 * A proposal the bot built is merged: its requester hears it in their DM.
 * #7 (WP3): `sha` is what the merge deployed (routes/votes.js finalizeMerge),
 * and "live now" waits for the app to answer its health check on it
 * (liveAfterMerge). The news carries a button that opens the app
 * (openAppAction) and the proposal's card, and records the app's address as
 * its link. The button is the message's own, so it is there even when the
 * card cannot be (a project the bot cannot see). Its ready card says it is
 * live by itself: that card reads where the change stands each time it is
 * read (readyStates), and this news landing is one of those times.
 *
 * `live: true` is the merge-followups workflow machine's word that production
 * runs a build containing the change: then nothing is probed, and nothing is
 * re-read later.
 */
async function noteProposalMerged(pool, session, { config = null, sha = null, live: known = null, deps = {} } = {}) {
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
  const platform = !!run.self_hosted;
  const live = known === true ? true : await liveAfterMerge(config, { ...run, id: run.app_id }, { sha, deps });
  // B9: the chat message it was asked in, if it was, says it is live, once
  // it is (WP-F): an app that did not answer yet is asked again a little
  // later. The platform's own app has no health check to read here, so its
  // chip moves on the merge, as it always did.
  if (live || platform) await noteChatLive(pool, run);
  else laterChatLive(pool, run, { config, sha, deps });
  const requester = await requesterOf(pool, run.app_id, run.issue_number);
  // #8: their activity tray reads again, whether or not the DM says it.
  if (requester) require('./homeroom-bot-tray').noteWorkChanged(requester.userId, deps);
  const settings = await settingsModule().readSettings(pool);
  // #4238: a new project's first version: the bot says so in its channel, once.
  if (requester?.firstVersion && !platform) await announceFirstVersion(pool, run, { live, deps });
  if (!requester || !hasBot(settings, requester)) return null;
  const bot = await botAccount(pool);
  if (!bot) return null;
  await closeOpenQuestions(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number });
  const context = {
    appName: run.name || run.slug, issueNumber: run.issue_number,
    issueTitle: requester.issueTitle, firstVersion: requester.firstVersion,
  };
  // The platform's own app has no app of its own to open: its proposal.
  const open = platform ? null : openAppAction({ slug: run.slug, appName: context.appName });
  // #4231: a new project's first version also offers its community and
  // inviting people to it.
  const actions = open ? [open, ...(context.firstVersion ? firstLiveActions({ slug: run.slug }) : [])] : [];
  return sendDm(pool, {
    bot,
    userId: requester.userId,
    replyToId: await requestStart(pool, { userId: requester.userId, appId: run.app_id, issueNumber: run.issue_number }),
    idempotencyKey: `hrbot-merged-${session.id}`,
    content: mergedText({
      line: requestLine(context), appName: context.appName, live, platform, card: !!open, change: !context.firstVersion,
    }),
    metadata: {
      kind: 'merged', appSlug: run.slug, appName: context.appName, issueNumber: run.issue_number,
      link: `#app/${encodeURIComponent(run.slug)}`, live,
      ...(context.firstVersion ? { firstVersion: true } : {}),
      ...(actions.length ? { actions } : {}),
    },
    objects: cardsFor('merged', { sessionId: session.id }, { id: run.app_id }, run.issue_number),
  });
}

// ── A person writing to the bot ──────────────────────────────────────────

const HELP_TEXT = [
  'I build things for you on Homeroom. Create a project and describe what it should do, or post a request on a',
  'project, and I\'ll take it from there. When I have a question I\'ll ask it here: tap one of my suggested',
  'answers or write your own.',
].join(' ');

// What somebody the bot does not answer is told: the people it does not
// work for are the accounts Homeroom has not let in yet (hasBot).
const NOT_ENABLED_TEXT = 'I\'m not taking requests from your account yet. I will as soon as Homeroom lets '
  + 'your account in.';

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
    `SELECT message_id, conversation_id, app_id, issue_number, kind, question_status, run_id
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
async function postOnProposal(pool, {
  user, app, sessionId, issueNumber, text, deps = {}, payerId = null, queueReason = 'dm_revise',
}) {
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
      appId: app.id, issueNumber: Number(issueNumber), userId: user.id, reason: queueReason,
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

// ── A No vote's line, on one of its own changes (#3977) ──────────────────
//
// A No comes with a line (#1688), and on a change the bot built that line
// is what it should fix. It used to stop at the vote row in the change's
// discussion, a system row the bot neither wakes on nor reads (its
// follow-up reads people's messages there, homeroom-bot.js runFollowUp).
// Now, while the change is still up for a vote, the line is handed to the
// bot exactly as Change something hands a DM: posted in that discussion as
// the voter's own reply (postOnProposal), with its follow-up queued first,
// which revises the change (clearing its votes, as any revision does) or
// asks one question. The vote row then reads "voted no" without the line,
// so the discussion shows it once, as theirs (routes/votes.js).

/**
 * Pure: the line a vote just recorded hands the bot, or null. A No, with
 * words sent with it now (not the earlier line a re-cast keeps), that moved
 * something: a new vote, a flip, or new words on the same No. A re-cast
 * with the same words (`unchanged`, the route's own test) hands nothing,
 * so one line is handed once.
 */
function voteLineFor({ vote, reason, unchanged }) {
  if (vote !== 'no' || unchanged) return null;
  const line = typeof reason === 'string' ? reason.trim() : '';
  return line || null;
}

/**
 * Where a No's line on `sessionId` goes, when every gate a reply's
 * follow-up meets holds now: the bot's own change, up for a vote (not
 * merging, merged or closed), answering a request, on a project the bot
 * works on and has not paused, revised fewer than MAX_REVISIONS times.
 * Resolves { app, sessionId, issueNumber }, or null and the line stays on
 * the vote row as it always has. Never throws.
 */
async function voteLineTarget(pool, { sessionId }) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const { rows: [row] } = await pool.query(
      `SELECT cs.linked_issues, a.id AS app_id, a.slug, a.name
         FROM chat_sessions cs
         JOIN users u ON u.id = cs.user_id
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1 AND u.username = $2 AND cs.status = 'promoted'
          AND cs.is_headless IS NOT TRUE`,
      [id, BOT_USERNAME],
    );
    if (!row) return null;
    const issueNumber = Array.isArray(row.linked_issues) ? Number(row.linked_issues[0]) : null;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
    const app = { id: Number(row.app_id), slug: row.slug, name: row.name };
    const settings = await settingsModule().readSettings(pool);
    if (!require('./homeroom-bot-live').isLiveFor(settings, app)
      || (settings?.pausedApps || []).includes(app.slug)) return null;
    const { rows: [revisions] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE proposal_session_id = $1 AND verdict = 'revise'`,
      [id],
    );
    if ((revisions?.n || 0) >= require('./homeroom-bot-followup').MAX_REVISIONS) return null;
    return { app, sessionId: id, issueNumber };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read where a No\'s line goes', { sessionId: id, err: err.message });
    return null;
  }
}

/**
 * Hand `line` to the bot as `user`'s reply on `target` (voteLineTarget).
 * Resolves postOnProposal's answer; { ok: false } when it could not be
 * posted, and the caller keeps the line on the vote row. Never throws.
 */
async function handVoteLine(pool, { user, target, line, deps = {} }) {
  try {
    return await postOnProposal(pool, {
      user, app: target.app, sessionId: target.sessionId, issueNumber: target.issueNumber,
      text: line, deps, queueReason: 'vote_no',
    });
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not hand a No\'s line to the bot', { sessionId: target?.sessionId, err: err.message });
    return { ok: false, why: 'something went wrong on my side' };
  }
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
  // B5: words that are one of its open prompts settle those buttons.
  await settlePrompt(pool, { botId: bot.id, userId: user.id, conversationId, content: message.content });
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

/** What noteUserMessage does with a message from somebody it works for, while the bot types. */
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
    // B6: a reply to a plan (Change something) plans it again with their words.
    if (target && target.kind === PLAN_KIND) return changePlan(pool, { bot, user, target, message, deps });
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
  // A message that carries one of the bot's own changes still waiting for
  // approval (the change page's Ask for changes) is about that change: it is
  // fixed there before it goes live, as Change something on its ready card
  // does, never filed as a new request. Null when a gate refused it, and the
  // model reads it with the card in front of it.
  if (typeof mayor.reviseAttached === 'function') {
    const revised = await mayor.reviseAttached(pool, config, { bot, user, settings, conversationId, message, deps: turnDeps });
    if (revised) return revised;
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

// ── A request filed elsewhere ────────────────────────────────────────────

// B8: how long the bot usually takes from starting on a request to its change
// being ready to try, when there is not enough of its own record to say.
const TYPICAL_BUILD_MINUTES = 8;

/**
 * B8: about how many minutes the bot takes from reading a request to the
 * change it builds going up: the median over its last 30 days, once it has
 * built at least five, else TYPICAL_BUILD_MINUTES. Never throws.
 */
async function typicalMinutes(pool) {
  const { rows } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (cs.promoted_at - r.created_at)) / 60.0
              + COALESCE(r.duration_ms, 0) / 60000.0) AS minutes,
            COUNT(*)::int AS built
       FROM homeroom_bot_runs r JOIN chat_sessions cs ON cs.id = r.proposal_session_id
      WHERE r.mode = 'live' AND cs.promoted_at IS NOT NULL AND cs.promoted_at >= r.created_at
        AND r.created_at > NOW() - INTERVAL '30 days'`,
  ).catch(() => ({ rows: [] }));
  const row = rows[0];
  if (!row || Number(row.built) < 5 || !Number.isFinite(Number(row.minutes))) return TYPICAL_BUILD_MINUTES;
  return Math.min(60, Math.max(2, Math.round(Number(row.minutes))));
}

// WP-E: the same answer for a screen that asks every few seconds while a
// first version is built (GET /api/apps/:slug), read at most every five
// minutes per process. It is a median over thirty days; it does not move
// faster than that.
const TYPICAL_CACHE_MS = 5 * 60 * 1000;
let typicalCache = null;
async function typicalMinutesCached(pool, now = Date.now()) {
  if (typicalCache && now - typicalCache.at < TYPICAL_CACHE_MS) return typicalCache.minutes;
  const minutes = await typicalMinutes(pool);
  typicalCache = { at: now, minutes };
  return minutes;
}

/**
 * B8: a request somebody filed through Suggest an improvement (routes/feedback.js),
 * told to the bot the way its own filing from a DM is (homeroom-bot-mayor.js
 * fileRequest): recorded as theirs, in their own words, and, on a project the
 * bot builds on, put first in its queue with its card in their DM. Resolves
 * { botWillBuild, typicalMinutes } for the confirmation, or null when they
 * are not somebody the bot talks to. Never throws.
 */
async function noteRequestFiled(pool, { app, user, issueNumber, title = null, askedText = null }) {
  try {
    const n = Number(issueNumber);
    if (!app?.id || !user?.id || user.isSynthetic || !Number.isInteger(n) || n <= 0) return null;
    const settings = await settingsModule().readSettings(pool);
    if (!hasBot(settings, user)) return null;
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id,
         issue_title = COALESCE(EXCLUDED.issue_title, homeroom_bot_requesters.issue_title),
         asked_text = COALESCE(EXCLUDED.asked_text, homeroom_bot_requesters.asked_text)`,
      [app.id, n, user.id, clip(title, 300) || null, clip(askedText, 2000) || null],
    );
    if (!require('./homeroom-bot-live').isLiveFor(settings, app)) return { botWillBuild: false };
    const queued = await settingsModule().enqueueFront(pool, {
      appId: app.id, issueNumber: n, userId: user.id, reason: 'asked', payerId: user.id,
    });
    const bot = await botAccount(pool);
    if (queued?.id && bot) {
      await require('./homeroom-bot-activity').startCard(pool, {
        app, issueNumber: n, bot, jobKey: Number(queued.id), settings, filed: true,
        requester: {
          userId: user.id, username: user.username, issueTitle: title, firstVersion: false, askedText,
          isSynthetic: !!user.isSynthetic, hasPlatformAccess: !!(user.hasPlatformAccess || user.privateMember), isAdmin: !!user.isAdmin,
        },
      });
    }
    log.info('homeroom-bot-dm', 'A request asked for on the platform goes to the bot first', { app: app.slug, issueNumber: n, userId: user.id });
    return { botWillBuild: true, typicalMinutes: await typicalMinutes(pool) };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not hand a filed request to the bot', { app: app?.slug, issueNumber, err: err.message });
    return null;
  }
}

// ── Asking it to build a request ─────────────────────────────────────────

/**
 * B8: whether a request's page offers `user` "Ask Homeroom bot to build
 * this": Homeroom bot is theirs, and it builds on `app`. Resolves
 * { typicalMinutes } or null. Never throws.
 */
async function botDoorFor(pool, app, user) {
  try {
    if (!app?.slug || !user?.id || user.isSynthetic) return null;
    const settings = await settingsModule().readSettings(pool);
    if (!hasBot(settings, user) || !require('./homeroom-bot-live').isLiveFor(settings, app)) return null;
    return { typicalMinutes: await typicalMinutes(pool) };
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not read whether the bot builds here', { app: app?.slug, err: err.message });
    return null;
  }
}

// #4530: what "Ask Homeroom bot to build this" answers while the bot is
// waiting on people about the request, by the kind of its last note.
const WAITING_TEXT = Object.freeze({
  question: 'Homeroom bot asked a question here and is waiting for an answer. Answer it in the request\'s discussion, and it reads the request again.',
  person: 'Homeroom bot said a person needs to decide this one. Reply to it in the request\'s discussion once that is settled, and it reads the request again.',
  empty: 'Homeroom bot found nothing to build here yet. Reply to it in the request\'s discussion with more to go on, and it reads the request again.',
});

/**
 * #4530: whether the bot is waiting on people about request `n` of `app`
 * (homeroom-bot-addressed.js waitingOnRequest), or null. Never throws.
 */
async function botWaitingOn(pool, app, n, deps = {}) {
  const bot = await botAccount(pool).catch(() => null);
  if (!bot) return null;
  const github = deps.github || require('./github');
  let repoUrl = app.repo_url;
  if (repoUrl === undefined) {
    const { rows } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]).catch(() => ({ rows: [] }));
    repoUrl = rows[0]?.repo_url || null;
  }
  const repo = repoUrl && typeof github.parseGithubUrl === 'function' && github.isEnabled?.() !== false
    ? github.parseGithubUrl(repoUrl) : null;
  return require('./homeroom-bot-addressed').waitingOnRequest(pool, {
    appId: app.id, issueNumber: n, botId: bot.id, github, repo,
  });
}

/**
 * B8: somebody pressed "Ask Homeroom bot to build this" on request
 * `issueNumber` of `app` (routes/issues.js): it goes first in the bot's
 * queue, paid from their building time (B2). The request stays its asker's:
 * whoever it is recorded for keeps it, and its card and news reach them; a
 * request nobody is recorded for becomes this person's. Resolves
 * { ok: true, typicalMinutes, mine } or { ok: false, status, error, code }.
 *
 * #4530: not while the bot is waiting on people there: its last note is a
 * question, "a person needs to decide", or "nothing to build", and nobody
 * has answered it, replied to it, mentioned it or edited the request since
 * (botWaitingOn). Asking then read the same request again and posted the
 * same note again (number-guessing #52: one question three times). It
 * answers 409 `awaiting_reply`, and the card offers to answer the bot
 * instead (public/js/app-view.js).
 */
async function askBotToBuild(pool, { app, user, issueNumber, deps = {} }) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'Invalid request number' };
  if (!app?.id || !user?.id || user.isSynthetic) return { ok: false, status: 403, error: 'forbidden' };
  const settings = await settingsModule().readSettings(pool);
  if (!hasBot(settings, user)) return { ok: false, status: 403, error: 'Homeroom bot is not on for you yet.' };
  if (!require('./homeroom-bot-live').isLiveFor(settings, app)) {
    return { ok: false, status: 409, error: 'Homeroom bot does not build on this project.', code: 'not_building' };
  }
  const busy = (await require('./homeroom-bot-progress').botWorkByIssue(pool, app.id)).get(n);
  if (busy) return { ok: false, status: 409, error: 'Homeroom bot is already on it.', code: 'already_building' };
  const waiting = await botWaitingOn(pool, app, n, deps);
  if (waiting) {
    return { ok: false, status: 409, error: WAITING_TEXT[waiting.kind] || WAITING_TEXT.question, code: 'awaiting_reply' };
  }
  let requester = await requesterOf(pool, app.id, n);
  if (!requester) {
    const { rows } = await pool.query(
      `SELECT title FROM issues WHERE app_id = $1 AND github_issue_number = $2 ORDER BY id DESC LIMIT 1`,
      [app.id, n],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
       VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, issue_number) DO NOTHING`,
      [app.id, n, user.id, clip(rows[0]?.title, 300) || null],
    );
    requester = await requesterOf(pool, app.id, n);
  }
  const queued = await settingsModule().enqueueFront(pool, {
    appId: app.id, issueNumber: n, userId: user.id, reason: 'asked', payerId: user.id,
  });
  // A look already started on it holds the row, and nothing is queued again.
  if (!queued?.id) return { ok: false, status: 409, error: 'Homeroom bot is already on it.', code: 'already_building' };
  const bot = await botAccount(pool);
  if (bot && requester) {
    await require('./homeroom-bot-activity').startCard(pool, {
      app, issueNumber: n, bot, jobKey: Number(queued.id), settings, queued: true, requester,
    });
  }
  log.info('homeroom-bot-dm', 'Asked to build a request from its page', { app: app.slug, issueNumber: n, userId: user.id });
  return { ok: true, typicalMinutes: await typicalMinutes(pool), mine: Number(requester?.userId) === Number(user.id) };
}

/**
 * #4530: which of `issues` ({ number, updatedAt }) on `appId` Homeroom bot
 * is waiting on people about, for the request list and a request's page
 * (routes/issues.js `botAwaits`): Map(number → { kind, messageId }). Never
 * throws.
 */
async function botWaitingByIssue(pool, appId, issues) {
  const bot = await botAccount(pool).catch(() => null);
  if (!bot) return new Map();
  return require('./homeroom-bot-addressed').waitingByIssue(pool, { appId, botId: bot.id, issues });
}

/**
 * B8: who each of `numbers` on `app` is being built for, for the request
 * page's note ("Ada asked Homeroom bot to build this"): Map(number →
 * { username, userId }). Never throws.
 */
async function askersOf(pool, appId, numbers) {
  const list = [...new Set((numbers || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    `SELECT q.issue_number, q.user_id, u.username FROM homeroom_bot_requesters q JOIN users u ON u.id = q.user_id
      WHERE q.app_id = $1 AND q.issue_number = ANY($2::int[])`,
    [appId, list],
  ).catch(() => ({ rows: [] }));
  return new Map(rows.map((r) => [Number(r.issue_number), { username: r.username, userId: Number(r.user_id) }]));
}

// ── Saying hello ─────────────────────────────────────────────────────────

// B5: the bot introduces itself once per person, ever, and offers a few
// questions to tap (B3 `prompt` buttons: a tap sends the words as theirs,
// and the bot answers them like any message). A maker hears it with their
// first project; anybody else with their first request, above its card.
const MAKER_HELLO = 'Hi, I\'m Homeroom bot. I build apps and changes from what you describe, and I\'ll message you '
  + 'when something\'s ready to try.';
const MAKER_PROMPTS = Object.freeze(['How long will this take?', 'What can I ask for?', 'How do I invite friends?']);
const MEMBER_PROMPTS = Object.freeze(['What else can I ask for?', 'How long will this take?']);

/** Pure: the hello somebody hears with their first request on a project they did not make. */
function memberHello(appName) {
  return `Hi, I'm Homeroom bot. I build the changes people in ${appName || 'this project'} ask for. Here's yours:`;
}

// WP-F: somebody who joins a community through an invite link meets the
// bot there too, once, if it builds for them: what it is and what to ask it.
const JOINER_PROMPTS = Object.freeze(['What can I ask for?', 'How does the group decide?']);

/** Pure: the hello somebody hears when they join `appName` by an invite link. */
function joinerHello(appName) {
  const name = appName || 'this project';
  return `Hi, I'm Homeroom bot, the AI that builds things for the groups on Homeroom. Welcome to ${name}! `
    + `When you'd like something in ${name} to change, tell me here or tap Suggest an improvement on its page. `
    + 'I\'ll build it, and the group tries it and decides whether it goes live.';
}

/**
 * WP-F: greet somebody who just joined a community through an invite link
 * (community-invites.js redeem), once ever, and only when the bot builds for
 * them and is switched on: a hello offering what it cannot do would be a
 * false claim. Quiet: it rings nothing. Never throws.
 */
async function greetJoiner(pool, { user, app }) {
  try {
    if (!user?.id || !app?.id) return null;
    const settings = await settingsModule().readSettings(pool);
    if (settings.mode === 'off') return null;
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic, (has_platform_access OR private_member_since IS NOT NULL) AS has_platform_access, is_admin FROM users WHERE id = $1', [user.id],
    );
    const person = rows[0];
    if (!person || !hasBot(settings, {
      username: person.username, isSynthetic: !!person.is_synthetic,
      hasPlatformAccess: !!person.has_platform_access, isAdmin: !!person.is_admin,
    })) return null;
    const bot = await botAccount(pool);
    if (!bot) return null;
    if (!await claimHello(pool, { userId: user.id, botId: bot.id, kind: 'joiner' })) return null;
    const name = app.name || app.slug;
    const hello = joinerHello(name);
    const sent = await sendDm(pool, {
      bot,
      userId: user.id,
      idempotencyKey: `hrbot-joiner-${user.id}`,
      content: hello,
      metadata: {
        kind: 'hello_joiner', appSlug: app.slug, appName: name,
        hello, actions: promptActions(JOINER_PROMPTS), status: 'open',
      },
    });
    if (sent) await noteHelloSent(pool, user.id, sent.messageId);
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not greet a joiner', { userId: user?.id, err: err.message });
    return null;
  }
}

/** Pure: `labels` as prompt buttons (types.ts HomeroomBotAction), at most three. */
function promptActions(labels) {
  return labels.slice(0, 3).map((label, i) => ({ id: `ask-${i + 1}`, label, style: 'secondary', type: 'prompt' }));
}

/*
 * What to tap where the bot's work on a request is stuck, instead of "reply
 * here" with nothing to press. A `quote` prompt is sent as the person's own
 * words, replying to the message, so it is about that request: on a build
 * that did not finish it reaches the bot's chat, which starts the request
 * again (homeroom-bot-mayor.js start_request); on a mirrored kind it is
 * posted on the request's public discussion, which the buttons say
 * (frontend/src/features/messages/bot-question.tsx). `reply` quotes the
 * message in the composer for them to write the detail it asks for.
 */
const STUCK_ACTIONS = Object.freeze({
  build_failed: Object.freeze([{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }]),
  blocked: Object.freeze([{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }]),
  empty: Object.freeze([{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }]),
  person: Object.freeze([{ id: 'go_ahead', label: 'Go ahead', style: 'primary', type: 'prompt', quote: true }]),
});

// A suggestion is something to say next, never a decision the bot waits on
// (an offer's File it, a ready card's Approve, a plan's Build it).
const SUGGESTION_TYPES = new Set(['prompt', 'reply']);

/** Pure: whether a bot message's buttons are all suggestions. */
function suggestsOnly(meta) {
  const actions = Array.isArray(meta?.actions) ? meta.actions : [];
  return actions.length > 0 && actions.every((action) => SUGGESTION_TYPES.has(action?.type));
}

/**
 * Only the newest message's suggestions stay live. Once the bot says
 * something new in a DM, the suggestion buttons on its older messages
 * (suggestsOnly) close, and Messages draws a closed suggestion as nothing
 * at all; they used to stay open until somebody typed one's exact words,
 * far up the chat. A question's answers, an offer, a plan or a ready card
 * keep their own lifecycle. Never throws.
 */
async function retireSuggestions(pool, { botId, conversationId, keepMessageId, userId = null, ws = null }) {
  if (!botId || !conversationId || !keepMessageId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, metadata FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND id < $3 AND deleted_at IS NULL
          AND metadata->'homeroomBot'->>'status' = 'open'
          AND jsonb_typeof(metadata->'homeroomBot'->'actions') = 'array'
        ORDER BY id DESC LIMIT 20`,
      [conversationId, botId, keepMessageId],
    );
    for (const row of rows) {
      if (!suggestsOnly(row.metadata?.[META])) continue;
      await setQuestionState(pool, Number(row.id), { status: 'closed' }, { ws, conversationId, userId });
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not retire older suggestions', { conversationId, err: err.message });
  }
}

/**
 * B5: claim `userId`'s one hello, as `kind` ('maker' or 'member'). True only
 * for the first claim: a second device, a retry or a later project gets
 * false. Somebody the bot already wrote to before hellos existed is
 * recorded as known and never greeted. Never throws.
 */
async function claimHello(pool, { userId, botId, kind }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO homeroom_bot_hellos (user_id, kind)
       SELECT $1::int, CASE WHEN EXISTS (
                SELECT 1 FROM conversation_messages m
                  JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
                  JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1::int
                 WHERE m.sender_id = $2::int
              ) THEN 'known' ELSE $3::text END
       ON CONFLICT (user_id) DO NOTHING
       RETURNING kind`,
      [Number(userId), Number(botId), kind],
    );
    return rows[0]?.kind === kind;
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not claim a hello (none sent)', { userId, err: err.message });
    return false;
  }
}

/** B5: which message a hello went out in, for the record. Never throws. */
async function noteHelloSent(pool, userId, messageId) {
  if (!messageId) return;
  await pool.query('UPDATE homeroom_bot_hellos SET message_id = $2 WHERE user_id = $1', [userId, messageId]).catch(() => {});
}

/**
 * B5: a person wrote the words of one of the bot's open prompts (tapped, or
 * typed): those buttons give way to "You asked: ..." on every device. Never
 * throws; resolves whether one was settled.
 */
async function settlePrompt(pool, { botId, userId, conversationId, content }) {
  const said = String(content || '').trim().toLowerCase();
  if (!said || !botId || !conversationId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT id, metadata FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND deleted_at IS NULL
          AND metadata->'homeroomBot'->>'status' = 'open'
          AND jsonb_typeof(metadata->'homeroomBot'->'actions') = 'array'
        ORDER BY id DESC LIMIT 5`,
      [conversationId, botId],
    );
    for (const row of rows) {
      const actions = row.metadata?.[META]?.actions || [];
      const hit = actions.find((a) => a?.type === 'prompt' && String(a.label || '').trim().toLowerCase() === said);
      if (!hit) continue;
      await setQuestionState(pool, Number(row.id), { status: 'answered', answer: hit.label, chosen: hit.id }, { conversationId, userId });
      return true;
    }
  } catch (err) {
    log.warn('homeroom-bot-dm', 'Could not settle a prompt', { userId, err: err.message });
  }
  return false;
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
  // B5: a maker's first project is where the bot says hello, once.
  const hello = await claimHello(pool, { userId: user.id, botId: bot.id, kind: 'maker' });
  const off = settings.mode === 'off' ? '\n\nI\'m switched off right now, so this waits until I\'m back on.' : '';
  const sent = await sendDm(pool, {
    bot,
    userId: user.id,
    idempotencyKey: `hrbot-create-${app.id}`,
    // B6: the plan comes first, and the build waits for their Build it.
    // #4097: the project's name is a line of its own, which Messages draws
    // as the project's card (frontend/src/features/messages/bot-head-card.tsx);
    // with the hello, after it.
    content: hello
      ? `${MAKER_HELLO}\n\n**${name}**\n\nI'm setting up ${name} now. Once it's ready I'll send you my plan here first, `
        + `then build its first version for you to try.${off}`
      : `**${name}**\n\nThanks! I'm setting up ${name} now. Once it's ready I'll send you my plan here first, `
        + `then build its first version for you to try.${off}`,
    metadata: {
      kind: 'first_version_started', appSlug: app.slug, appName: name,
      ...(hello ? { hello: MAKER_HELLO, actions: promptActions(MAKER_PROMPTS), status: 'open' } : {}),
    },
  });
  if (hello) await noteHelloSent(pool, user.id, sent?.messageId);
  log.info('homeroom-bot-dm', 'Project will be built from its description', { app: app.slug, userId: user.id });
  return sent ? { conversationId: sent.conversationId } : null;
}

/**
 * The request a project's description is filed as: its title and body.
 * Pure. Shared with the benchmark's taste eval (services/bench/taste.js),
 * whose first-version trials are given the same request the bot reads.
 */
function firstVersionIssue({ name, username, brief, botBuilds = true, card = null }) {
  return {
    title: clip(`First version of ${name}`, 200),
    body: [
      `**Source:** Homeroom user (${username})`,
      '',
      brief,
      '',
      // The first session's card (services/app-sketch.js), when it was made:
      // what its creator has already seen, a short summary of the idea. Never
      // a design: until 5 October 2026 it was a mock of a screen, and this
      // line told the build to make that screen.
      ...(card ? [
        `**Featured card:** while it was made, ${username} was shown a card of the idea`
          + `${card.committed ? ' (\`design/sketch.json\`)' : ''}: "${clip(card.tagline, 120)}"`
          + `${(card.points || []).length ? `, with the points ${card.points.map((p) => `"${clip(p, 100)}"`).join(', ')}` : ''}.`
          + ' It sums up the description above in a few words and shows no screen, so it sets no layout, words or'
          + ' colours. Build from the description; where the two differ, the description wins.',
        '',
      ] : []),
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
  const appSketch = require('./app-sketch');
  const sketchRow = await appSketch.readSketch(pool, row.app_id).catch(() => null);
  const cardRow = sketchRow && sketchRow.status === 'ready' ? appSketch.cardOf(sketchRow.design) : null;
  const card = cardRow ? { ...cardRow, committed: !!sketchRow.committed_at } : null;
  const { title, body } = firstVersionIssue({ name, username, brief: row.brief, botBuilds, card });
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
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
         VALUES ($1, $2, $3, $4, TRUE, $5)
         ON CONFLICT (app_id, issue_number) DO UPDATE SET user_id = EXCLUDED.user_id, first_version = TRUE,
           asked_text = COALESCE(homeroom_bot_requesters.asked_text, EXCLUDED.asked_text)`,
        // B4: the brief they wrote is what they asked for.
        [row.app_id, issueNumber, row.user_id, title, clip(row.brief, 2000) || null],
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
    // #3952: the people the creator's description names with @. Never rejects.
    (deps.notifications || require('./notifications')).notifyIssueMentions?.(pool, {
      appId: row.app_id, issueNumber, authorId: row.user_id, text: `${title}\n\n${body}`,
    });
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
 * Where approval of a first version that is ready to try stands, for one
 * person reading its App tab (firstVersionState below), so the screen can
 * say what it waits on rather than only that it waits:
 *
 *   sessionId    the change, for Try it (its preview) and See the change
 *   mustApprove  their Yes counts on the project (approvalState: its named
 *                approvers, else every member), is not in yet, and is
 *                still needed
 *   approved     their Yes counts and is in
 *   waitingOn    up to three of the people it still waits on, never the
 *                reader (needsYesFrom: who the "ready to try" notification
 *                asked), and `more` the rest; empty once no Yes is missing
 *   missing      how many more Yes votes it needs (0 when it has them)
 *   goesLiveAt   when it goes live anyway if nobody objects: the end of the
 *                merge clock that runs (active-users.js mergeGate: the
 *                lazy-consensus window while a Yes is missing, the
 *                visibility window once it has them), from when it went up
 *                for approval. Null when no clock runs (an "at least N"
 *                project, a change to protected settings, no Yes yet).
 *   soon         nothing more is needed: it goes live in a minute or two
 *
 * The gate is the change's real one, counted with its explicit-approval
 * flag so no clock is promised to a change that has none. Null for no such
 * change.
 */
async function firstVersionApproval(pool, sessionId, viewerId = null) {
  const viewer = Number(viewerId) || null;
  const state = await approvalState(pool, { sessionId, userId: viewer });
  if (!state) return null;
  const id = Number(state.session.id);
  const appId = Number(state.session.app_id);
  // approvalState's own gate when it carries one; else read here, with the
  // change's explicit-approval flag (governance.js applyNoTimerMerge).
  let gate = state.gate || null;
  if (!gate) {
    const { rows: [flags] } = await pool.query(
      'SELECT COALESCE(requires_explicit_approval, FALSE) AS explicit_approval FROM chat_sessions WHERE id = $1', [id],
    );
    gate = await require('./governance').governedGate(pool, appId, {
      kind: 'pr', id, openedAt: state.session.opened_at,
      explicitApproval: flags?.explicit_approval === true, authorId: state.session.user_id ?? null,
    });
  }
  const missing = gate.thresholdMet
    ? 0
    : Math.max((Number(gate.required) || 1) - (Number(gate.qualifiedYes) || 0), 1);
  // Voting is a member's (communities.requireSessionMembership), so a Yes
  // that would count is asked only of a member.
  const member = viewer ? await require('./communities').isMember(pool, appId, viewer) : false;
  const approved = state.counts && state.already;
  const waiting = missing
    ? await usernamesOf(pool, await needsYesFrom(pool, state, { except: viewer ? [viewer] : [] }))
    : [];
  const clock = (gate.thresholdMet || gate.lazyArmed) && gate.windowEndsAt ? new Date(gate.windowEndsAt) : null;
  return {
    sessionId: id,
    mustApprove: state.counts && !state.already && member && missing > 0,
    approved,
    waitingOn: waiting.slice(0, 3),
    more: Math.max(waiting.length - 3, 0),
    missing,
    goesLiveAt: clock && Number.isFinite(clock.getTime()) ? clock.toISOString() : null,
    soon: !!gate.mergeable,
  };
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
 * `{ userId, creator, conversationId, step, of, line, question, ready }`:
 * whose description it is, their DM with the bot, the step of
 * homeroom-bot-progress.js's FIRST_VERSION_STEPS, the build line its
 * thumbnail shows to whoever reads it (`deps.viewerId`; buildLineOf, #4053),
 * whether the bot waits on an answer from them, and whether its proposal is
 * up for the vote (ready to try). While it is ready, `approval` is where
 * approval of it stands for that reader (firstVersionApproval above), when
 * that could be read. While it is built and tested, `chosenPlan` is the plan
 * its maker chose (chosenPlanOf, #4396). GET /api/apps/:slug reads it
 * best-effort: a read that fails is no state, never a failed page.
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
                 AND cs.live_at IS NOT NULL
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
  const forCreator = deps.viewerId != null && Number(deps.viewerId) === Number(row.user_id);
  // The step, for Homeroom bot's chat, and the build line its thumbnail
  // shows this reader (#4053): "Your plan is ready to review" to the person
  // who started it, "Planning it" to everyone else, while the plan waits.
  const at = (stage, { question = false } = {}) => ({
    step: progress.stepNumber(stage, true),
    of: progress.FIRST_VERSION_STEPS.length,
    line: progress.buildLineOf(stage, { forCreator, question }),
  });
  const base = { userId: Number(row.user_id), creator: row.username || null, conversationId: Number(row.conversation_id) || null };
  if (row.status !== 'filed') {
    if (progress.setupOf(row).outcome) return null;
    return { ...base, ...at('setting_up'), question: false, ready: false };
  }
  const states = await progress.requestStates(pool, { userId: row.user_id });
  const found = states.find((s) => Number(s.row.app_id) === Number(row.app_id)
    && Number(s.row.issue_number) === Number(row.issue_number));
  if (found?.state) {
    // B6: the plan it waits on, for the creator to build from the App tab too.
    const plan = found.state.stage === 'plan'
      ? await waitingPlan(pool, { userId: row.user_id, appId: row.app_id, issueNumber: row.issue_number }).catch(() => null)
      : null;
    // A plan its creator asked to change is read again (changePlan puts it
    // first in line as 'plan_change'). That read is the plan being redone,
    // not the description being read for the first time, so it stays on the
    // plan's step rather than going back one. Its line is planning either way.
    const replanning = found.row?.queue_reason === 'plan_change'
      && (found.state.stage === 'queued' || found.state.stage === 'reading');
    const question = found.state.stage === 'question' && found.state.waitingOn === 'them';
    const ready = found.state.stage === 'vote';
    // Ready to try: who it waits on, for the App tab to say. A read that
    // fails leaves the screen as it was before it said so.
    const approval = ready && found.row?.proposal_session_id
      ? await firstVersionApproval(pool, found.row.proposal_session_id, deps.viewerId).catch((err) => {
        log.warn('homeroom-bot-dm', 'Could not read who a first version waits on', { appId: row.app_id, err: err.message });
        return null;
      })
      : null;
    const where = replanning ? { ...at('reading'), step: progress.stepNumber('plan', true) } : at(found.state.stage, { question });
    // #4396: the plan its maker chose, while it is built and tested, for
    // the members waiting on it (routes/apps.js sharedPlan cuts it). Build
    // it (homeroom-bot.js goAhead) keeps the plan on its run and marks it
    // `chosen`; nothing is read before the build step or once it is ready.
    const chosenPlan = !ready && !plan && !replanning
      && where.step >= progress.FIRST_VERSION_STEPS.indexOf('Building it') + 1
      ? await chosenPlanOf(pool, row.app_id, row.issue_number).catch(() => null)
      : null;
    return {
      ...base,
      ...where,
      question,
      ready,
      ...(plan ? { plan } : {}),
      ...(chosenPlan ? { chosenPlan } : {}),
      ...(approval ? { approval } : {}),
    };
  }
  // Filed, and nothing in progress: either it came to something, or the bot
  // has not picked it up yet (filing wakes it, and it reads it next).
  if (found && progress.outcomeOf(found.row)) return null;
  return { ...base, ...at('queued'), question: false, ready: false };
}

/**
 * #4396: the plan a first version's maker chose with Build it, the newest
 * run's that went ahead (goAhead writes `chosen` onto it): { bullets,
 * questions }, or null. The answers chosen are not read.
 */
async function chosenPlanOf(pool, appId, issueNumber) {
  const { rows: [run] } = await pool.query(
    `SELECT plan FROM homeroom_bot_runs
      WHERE app_id = $1 AND issue_number = $2 AND plan ? 'chosen'
      ORDER BY id DESC LIMIT 1`,
    [appId, issueNumber],
  );
  if (!run || !Array.isArray(run.plan?.bullets)) return null;
  return {
    bullets: run.plan.bullets,
    questions: Array.isArray(run.plan.questions) ? run.plan.questions : [],
  };
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
  BUILD_KINDS,
  momentOf,
  notificationDetail,
  askedLine,
  hasOthers,
  TYPICAL_BUILD_MINUTES,
  typicalMinutes,
  typicalMinutesCached,
  noteRequestFiled,
  botDoorFor,
  askBotToBuild,
  WAITING_TEXT,
  botWaitingByIssue,
  askersOf,
  MAKER_HELLO,
  joinerHello,
  greetJoiner,
  MAKER_PROMPTS,
  MEMBER_PROMPTS,
  memberHello,
  promptActions,
  STUCK_ACTIONS,
  suggestsOnly,
  retireSuggestions,
  claimHello,
  noteHelloSent,
  settlePrompt,
  READY_CHECKS,
  readyKey,
  changeReadiness,
  brokenWords,
  noteChangeReady,
  noteShotsSettled,
  sweepHeldReady,
  noteChangeStopped,
  needsLookText,
  noteNeedsLook,
  sweepUnproposedBuilds,
  MAX_BRIEF_CHARS,
  MIN_BRIEF_CHARS,
  HELP_TEXT,
  NOT_ENABLED_TEXT,
  hasBot,
  isEnabledFor,
  botAccount,
  PROJECT_ORIGINS,
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
  buildFailedWords,
  updateFailedWords,
  failedWords,
  twoQuestions,
  // B7: ready to try, and who approves it.
  approvalState,
  needsYesFrom,
  readyActions,
  noteApproversReady,
  noteApproved,
  goesLiveAfterYes,
  usernamesOf,
  // 5 October: a ready card read as it stands now, and the live news's way in.
  MAX_READY_READS,
  MAX_READY_APPROVALS,
  readyStateOf,
  readyStates,
  noteVoted,
  openAppAction,
  firstLiveActions,
  // B6: a first version's plan.
  PLAN_KIND,
  planCardText,
  planCards,
  sendPlanCard,
  closePlanCards,
  decidePlanTap,
  changePlan,
  changeOnRequest,
  markPlanBuilt,
  isPlanGoWord,
  waitingPlan,
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
  voteLineFor,
  voteLineTarget,
  handVoteLine,
  noteProposalMerged,
  firstVersionText,
  announceFirstVersion,
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
  firstVersionApproval,
  firstVersionState,
  suggestShortDescription,
  firstSentence,
};
