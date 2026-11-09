'use strict';

// WP-E: what an invite link brings back to the person who made it.
//
//   invite_opened   Somebody signed in opened the link (a count of people;
//                   never a name: nobody agreed to be named for looking).
//                   Clicking a link is not showing up (#4176), so an open
//                   signed out tells nobody: it is remembered, and recorded
//                   for the admin Journey, and the person is news once they
//                   open it signed in.
//   member_joined   A signed-in person joined through it.
//   first_message   Somebody who joined through it wrote in the project's
//                   chat for the first time ("said hi").
//
// And the leaked-link guard's two (community-invites.js GUARD, noteGuard
// below), each its own row, never folded into another:
//
//   invite_link_busy    one link brought in GUARD.noticeAt people within a
//                       day; once per link per window. Its row turns the
//                       link off in one tap.
//   invite_link_paused  one link reached GUARD.pauseAt and paused: new joins
//                       are refused until its maker opens it again, from the
//                       row or the invite pane.
//
// Their `detail` is "<inviteId>:<joins>"; the bell reads the link's state
// with the row (notifications.js INVITE_LINK_STATE_SQL), so a button is only
// offered while it still does something.
//
// Only the link's maker hears, and only about people who came by THEIR
// link; the invite page tells a visitor that the maker sees when they join
// (features/auth/invite-card.tsx). Time spent is never said.
//
// One push per kind, per project, per day: the first moment inserts a
// notification (which is what rings, schema.sql
// enqueue_mobile_push_deliveries is AFTER INSERT); the rest of that day's
// moments fold into it, as a count in `detail`, newest person first, and
// bring it back unread without ringing again. The bell words the count
// ("Sam and 2 others joined"), the push only ever the first.
//
// AN OPEN COUNTS A PERSON ONCE (5 October: one person opening a link four
// times read "4 people opened your invite"). Who opened is remembered per
// maker and project (community_invite_opens): an account when they were
// signed in, on any device, else the browser, by a random HttpOnly cookie
// kept only as its hash. Opening again changes nothing: no count, no unread,
// no push. A browser that opened it signed out was never on a notice, so
// the first time it opens the link signed in is the moment its person is
// news. And an open is only news until the person joins: their join
// through the maker's link takes them off the open notice (the notice goes
// when nobody is left on it), and "Joined through your invite" says it
// instead; somebody who signs up or in from the link and joins straight
// away is only ever that join. A person who opens signed out in two
// browsers is still two opens for the Journey until one of them signs in
// or joins: nothing can tell them apart before then.
//
// Everything here is best-effort and never throws: a join, a page view or a
// message must not fail because telling somebody about it did. The email is
// the exception: it is owed by the notice that rang (`mailed_at` NULL), and
// sent by the notice-mail clock as work that tries again (activity-mail.js).

const crypto = require('crypto');
const events = require('./events');
const log = require('./logger');
const arrivalSource = require('./arrival-source');

const KINDS = Object.freeze(['invite_opened', 'member_joined', 'first_message']);
// A first message counts as a hello for this long after joining. Past it, the
// maker has long since heard they joined, and "said hi" would be news about
// somebody who has been around for weeks.
const HELLO_WITHIN_DAYS = 30;

// The browser an open came from: a random value the invite page's reads set
// once, HttpOnly, and only ever stored as its SHA-256. It names nobody and
// says nothing about where the browser is; it only tells this browser's
// second open from somebody else's first.
const BROWSER_COOKIE = 'hr_iv';
const BROWSER_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BROWSER_VALUE_RE = /^[A-Za-z0-9_-]{22,64}$/;
// The cookie a browser was counted with before an open counted a person
// once (one per link, valued '1'): that browser has been told about already.
const LEGACY_COOKIE_PREFIX = 'hr_io_';

// Where the visitor came from (#6540): the invite page's request records the
// referring host and the link's own `via` tag here, HttpOnly, for one hour.
// It is read by the page's two API reads, which are what count the open, so
// the source travels with the open without the page having to send it. Only
// a host and a short tag are ever kept (`arrival-source.js`).
const SOURCE_COOKIE = 'hr_iv_src';
const SOURCE_COOKIE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Record where this visitor came from, when `source` holds anything to
 * record. `host` is a hostname or 'none' (looked for, none given); `via` is
 * the link's short tag. A null `source` leaves an existing cookie alone.
 */
function setSourceCookie(req, res, source) {
  if (!source) return;
  const host = source.referrerHost === 'none' ? 'none' : arrivalSource.hostOf(source.referrerHost);
  if (host !== 'none' && !host) return;
  const via = arrivalSource.cleanVia(source.via) || '';
  res.cookie(SOURCE_COOKIE, `${host}|${via}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers?.['x-forwarded-proto'] === 'https',
    maxAge: SOURCE_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

/** The source this request's browser carries, or null when it carries none. */
function sourceFrom(req) {
  const value = req?.cookies?.[SOURCE_COOKIE];
  if (typeof value !== 'string' || !value) return null;
  const [rawHost, rawVia] = value.split('|');
  const host = rawHost === 'none' ? 'none' : arrivalSource.hostOf(rawHost);
  if (host !== 'none' && !host) return null;
  return { referrerHost: host, via: arrivalSource.cleanVia(rawVia) };
}

/** This request's browser, as the hash an open is kept by, or null. */
function browserFrom(req) {
  const value = req?.cookies?.[BROWSER_COOKIE];
  if (typeof value !== 'string' || !BROWSER_VALUE_RE.test(value)) return null;
  return crypto.createHash('sha256').update(`invite-open:${value}`).digest('hex');
}

/** This request's browser, given a cookie first when it has none. */
function ensureBrowser(req, res) {
  const known = browserFrom(req);
  if (known) return known;
  const value = crypto.randomBytes(24).toString('base64url');
  res.cookie(BROWSER_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers?.['x-forwarded-proto'] === 'https',
    maxAge: BROWSER_COOKIE_MAX_AGE_MS,
    path: '/api',
  });
  // The rest of this request reads it as if it had arrived with it.
  if (req.cookies) req.cookies[BROWSER_COOKIE] = value;
  return browserFrom({ cookies: { [BROWSER_COOKIE]: value } });
}

/** Whether this browser was counted for the link `token` before. */
function countedBefore(req, token) {
  return !!(token && req?.cookies?.[`${LEGACY_COOKIE_PREFIX}${String(token).slice(0, 12)}`]);
}

function notifications() { return require('./notifications'); }

/**
 * Tell `userId` about one moment on `appId`: a new notification (it rings)
 * or, within a day of the last one of this kind there, that one counted up
 * and unread again (it does not). Resolves { row, fresh } or null.
 */
async function ring(pool, { userId, appId, kind, sourceUserId = null, chatMessageId = null }) {
  if (!KINDS.includes(kind) || !userId || !appId) return null;
  const client = await pool.connect();
  let row = null;
  let fresh = false;
  try {
    await client.query('BEGIN');
    // Two joins at once must not both ring: one key per (person, project, kind).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite-activity:${userId}:${appId}:${kind}`]);
    const { rows: bumped } = await client.query(
      `UPDATE notifications
          SET detail = (CASE WHEN detail ~ '^[0-9]{1,6}$' THEN detail::int ELSE 1 END + 1)::text,
              source_user_id = COALESCE($4, source_user_id),
              chat_message_id = COALESCE($5, chat_message_id),
              read_at = NULL
        WHERE id = (SELECT id FROM notifications
                     WHERE user_id = $1 AND app_id = $2 AND kind = $3
                       AND created_at > NOW() - INTERVAL '24 hours'
                     ORDER BY id DESC LIMIT 1)
        RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
      [userId, appId, kind, sourceUserId, chatMessageId],
    );
    row = bumped[0] || null;
    fresh = !row;
    if (!row) {
      // The day's first owes its email (activity-mail.js NOTICE_MAIL_KINDS):
      // `mailed_at` NULL, which the notice-mail clock sends.
      const { rows } = await client.query(
        `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, mailed_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN NULL ELSE NOW() END)
         RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
        [userId, appId, chatMessageId, sourceUserId, kind, require('./activity-mail').NOTICE_MAIL_KINDS.has(kind)],
      );
      row = rows[0];
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.warn('invite-activity', 'Could not tell a link\'s maker', { kind, appId, err: err.message });
    return null;
  } finally {
    client.release();
  }
  // After its connection went back: the bell's refresh reads the pool.
  await notifications().hydrateAndPush(pool, row);
  return { row, fresh };
}

/**
 * A signed-in person joined through `inviteId`. Its maker hears it, by
 * name, unless they are the one who joined, and the open that brought them
 * stops being news (settleOpen). `browser` is the browser they joined from
 * (browserFrom), which may be the one they opened the link in signed out.
 */
async function noteJoined(pool, { inviteId, user, browser = null }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.created_by, ci.app_id, a.slug, a.name, u.username
         FROM community_invites ci
         JOIN apps a ON a.id = ci.app_id
         LEFT JOIN users u ON u.id = $2
        WHERE ci.id = $1`,
      [inviteId, user?.id ?? null],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null || !user?.id || Number(invite.created_by) === Number(user.id)) return null;
    await settleOpen(pool, { makerId: invite.created_by, appId: invite.app_id, userId: user.id, browser });
    return await ring(pool, { userId: invite.created_by, appId: invite.app_id, kind: 'member_joined', sourceUserId: user.id });
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a join', { inviteId, err: err.message });
    return null;
  }
}

// An open notice's push waits this long, so somebody who opens the link and
// joins straight away (seconds signed in, a few minutes through signing up)
// rings once, as a join, and not first as "Someone opened your invite". The
// bell shows the open at once; only the phone waits. The push is
// mobile_push_deliveries rows, which go with the notice when a join removes
// it (ON DELETE CASCADE), so a withdrawn open never buzzes.
const OPEN_PUSH_DELAY_MINUTES = 15;

// One lock per maker and project for everything that writes their opens: an
// open, and a join that takes somebody off the open notice. The same key
// ring() takes for invite_opened.
const opensLock = (makerId, appId) => `invite-activity:${makerId}:${appId}:invite_opened`;

/**
 * The rows that are this person, by account or browser, for `makerId`'s
 * links to `appId`, locked, the account's own row first.
 */
async function openersOf(client, { makerId, appId, userId = null, browser = null }) {
  const { rows } = await client.query(
    `SELECT id, user_id, browser, notification_id, referrer_host, via
       FROM community_invite_opens
      WHERE maker_id = $1 AND app_id = $2
        AND (($3::int IS NOT NULL AND user_id = $3::int) OR ($4::text IS NOT NULL AND browser = $4::text))
      ORDER BY COALESCE(user_id = $3::int, FALSE) DESC, id
      FOR UPDATE`,
    [makerId, appId, userId, browser],
  );
  return rows;
}

/**
 * Make `rows` (openersOf) one row, the first, which learns the account and
 * browser it was missing. Inside the caller's transaction. Resolves the ids
 * of the open notices a removed row was counted on.
 */
async function mergeOpeners(client, rows, { userId = null, browser = null }) {
  const [keep, ...rest] = rows;
  const touched = new Set();
  for (const extra of rest) {
    await client.query('DELETE FROM community_invite_opens WHERE id = $1', [extra.id]);
    if (extra.notification_id != null) touched.add(Number(extra.notification_id));
  }
  // The first open's source wins; a gap in the kept row is filled from the
  // earliest row merged into it, so merging never loses where somebody came
  // from.
  const earliest = [...rest].sort((a, b) => a.id - b.id);
  const firstHost = keep.referrer_host != null ? keep.referrer_host
    : (earliest.find((r) => r.referrer_host != null) || {}).referrer_host ?? null;
  const firstVia = keep.via != null ? keep.via
    : (earliest.find((r) => r.via != null) || {}).via ?? null;
  await client.query(
    `UPDATE community_invite_opens
        SET user_id = COALESCE(user_id, $2::int), browser = COALESCE(browser, $3::text),
            referrer_host = COALESCE(referrer_host, $4::text), via = COALESCE(via, $5::text)
      WHERE id = $1`,
    [keep.id, userId, browser, firstHost, firstVia],
  );
  return touched;
}

/**
 * Set open notice `id` to the number of people on it; one nobody is left on
 * is removed. Inside the caller's transaction. Resolves the count left.
 */
async function recountOpenNotice(client, id) {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM community_invite_opens WHERE notification_id = $1',
    [id],
  );
  const n = rows[0]?.n || 0;
  if (n === 0) {
    await client.query(`DELETE FROM notifications WHERE id = $1 AND kind = 'invite_opened'`, [id]);
  } else {
    await client.query(
      `UPDATE notifications SET detail = $2 WHERE id = $1 AND kind = 'invite_opened'`,
      [id, n > 1 ? String(n) : null],
    );
  }
  return n;
}

/** The maker's bell, and their phone's badge, read again. */
function bellChanged(userId) {
  try {
    require('./ws').pushNotificationToUser(userId, { type: 'notifications_changed' });
  } catch (err) {
    log.warn('invite-activity', 'Could not refresh a maker\'s bell', { err: err.message });
  }
}

/**
 * `userId` joined through a link of `makerId`'s to `appId`, so their open is
 * not news any more: they come off the open notice they were counted on
 * (which goes when nobody is left on it, its waiting push with it), and keep
 * their row, with their account, so opening the link again stays quiet.
 * Never throws. Resolves the ids of the notices it changed.
 */
async function settleOpen(pool, { makerId, appId, userId, browser = null }) {
  const touched = new Set();
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opensLock(makerId, appId)]);
    const rows = await openersOf(client, { makerId, appId, userId, browser });
    if (rows.length) {
      for (const id of await mergeOpeners(client, rows, { userId, browser })) touched.add(id);
      if (rows[0].notification_id != null) {
        touched.add(Number(rows[0].notification_id));
        await client.query('UPDATE community_invite_opens SET notification_id = NULL WHERE id = $1', [rows[0].id]);
      }
      for (const id of touched) await recountOpenNotice(client, id);
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.warn('invite-activity', 'Could not settle an open on a join', { appId, err: err.message });
    return [];
  } finally {
    if (client) client.release();
  }
  if (touched.size) bellChanged(makerId);
  return [...touched];
}

/**
 * Put the opener row `openId` on `makerId`'s open notice for `appId`: the
 * day's notice, counted up and unread again without ringing again, or a new
 * one, which rings, its push waiting OPEN_PUSH_DELAY_MINUTES. Inside the
 * caller's transaction, which holds opensLock. Resolves { row, fresh }.
 */
async function tellMaker(client, { makerId, appId, openId }) {
  const { rows: latest } = await client.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND app_id = $2 AND kind = 'invite_opened'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY id DESC LIMIT 1`,
    [makerId, appId],
  );
  let noticeId = latest[0]?.id ?? null;
  const fresh = noticeId == null;
  if (fresh) {
    const { rows: made } = await client.query(
      `INSERT INTO notifications (user_id, app_id, kind) VALUES ($1, $2, 'invite_opened') RETURNING id`,
      [makerId, appId],
    );
    noticeId = made[0].id;
    await client.query(
      `UPDATE mobile_push_deliveries
          SET available_at = NOW() + make_interval(mins => $2::int)
        WHERE notification_id = $1 AND status = 'pending'`,
      [noticeId, OPEN_PUSH_DELAY_MINUTES],
    );
  }
  await client.query('UPDATE community_invite_opens SET notification_id = $2 WHERE id = $1', [openId, noticeId]);
  if (!fresh) {
    // Somebody new on today's notice: counted, and unread again, without
    // ringing again.
    await recountOpenNotice(client, noticeId);
    await client.query('UPDATE notifications SET read_at = NULL WHERE id = $1', [noticeId]);
  }
  const { rows: shown } = await client.query(
    `SELECT id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at
       FROM notifications WHERE id = $1`,
    [noticeId],
  );
  return { row: shown[0] || null, fresh };
}

/**
 * Somebody opened the live link `token`: counted once per person, never
 * named. `viewerId` is the signed-in visitor, when there is one: the maker
 * opening their own link, or somebody already in the community, is not news.
 * `browser` is the browser it was opened in (ensureBrowser); `seenBefore`
 * says that browser was counted for this link before opens were kept by
 * person (countedBefore), so it is remembered without being counted again.
 *
 * Only a signed-in open tells the maker (#4176). A signed-out one is
 * remembered by its browser and recorded for the admin Journey, and tells
 * nobody; when that browser opens the link signed in, not in the community
 * yet, its person is news then.
 *
 * Resolves { row, fresh } when the maker was told (`fresh`: it made the day's
 * notice, whose push waits OPEN_PUSH_DELAY_MINUTES), { row: null, fresh:
 * false } when they were not (anybody signed out, or somebody who had
 * opened it before), or null when nothing was counted.
 */
async function noteOpened(pool, { token, viewerId = null, browser = null, seenBefore = false, source = null }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.id, ci.created_by, ci.app_id, ci.community_id,
              ($2::int IS NOT NULL AND EXISTS (
                SELECT 1 FROM community_members m WHERE m.community_id = ci.community_id AND m.user_id = $2
              )) AS viewer_is_member
         FROM community_invites ci
        WHERE ci.token = $1 AND ci.revoked_at IS NULL AND ci.paused_at IS NULL
          AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
          AND (ci.max_uses IS NULL OR ci.uses < ci.max_uses)`,
      [token, viewerId],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null) return null;
    if (viewerId != null && (Number(viewerId) === Number(invite.created_by) || invite.viewer_is_member)) return null;
    // Nothing to know this person by again, so nothing to count once.
    if (viewerId == null && !browser) return null;
    const signedIn = viewerId != null;
    const makerId = invite.created_by;
    const appId = invite.app_id;
    const person = { makerId, appId, userId: viewerId, browser };

    const touched = new Set();
    // Somebody new: one open for the Journey, signed in or not.
    let counted = false;
    // The maker hears: { row, fresh } (tellMaker).
    let told = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opensLock(makerId, appId)]);
      const known = await openersOf(client, person);
      // Joined since the read above (a signed-in Join can follow the read
      // that counted it within a second, and its join may have been settled
      // first): remembered, and not news.
      const { rows: joinedSince } = !signedIn ? { rows: [] } : await client.query(
        `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2`,
        [invite.community_id, viewerId],
      );
      if (known.length) {
        // Opened before (here, on another device, or signed out in this
        // browser): one person, counted once. Only ever seen signed out,
        // they were never on a notice, so opening it signed in now is the
        // first the maker hears of them.
        const untold = signedIn && !joinedSince.length
          && known.every((r) => r.user_id == null && r.notification_id == null);
        for (const id of await mergeOpeners(client, known, person)) touched.add(id);
        for (const id of touched) await recountOpenNotice(client, id);
        if (untold) told = await tellMaker(client, { makerId, appId, openId: known[0].id });
      } else if (seenBefore || joinedSince.length) {
        await client.query(
          `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser, referrer_host, via)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [makerId, appId, viewerId, browser, source?.referrerHost ?? null, source?.via ?? null],
        );
      } else {
        counted = true;
        const { rows: made } = await client.query(
          `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser, referrer_host, via)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [makerId, appId, viewerId, browser, source?.referrerHost ?? null, source?.via ?? null],
        );
        if (signedIn) told = await tellMaker(client, { makerId, appId, openId: made[0].id });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (touched.size) bellChanged(makerId);
    // The admin Journey reads it too (journey.js firstSession, its invite
    // funnel): one event per person, signed in or out, whether or not the
    // maker heard.
    if (counted) {
      events.record(pool, {
        type: events.EVENT_TYPES.INVITE_OPENED,
        userId: viewerId ?? undefined,
        appId,
        metadata: { inviteId: invite.id, signedIn, referrerHost: source?.referrerHost ?? null, via: source?.via ?? null },
      });
    }
    if (!told || !told.row) return { row: null, fresh: false };
    await notifications().hydrateAndPush(pool, told.row);
    return told;
  } catch (err) {
    log.warn('invite-activity', 'Could not count an invite opened', { err: err.message });
    return null;
  }
}

const GUARD_KINDS = Object.freeze(['invite_link_busy', 'invite_link_paused']);

/**
 * The leaked-link guard noticed invite `inviteId` (`kind`, one of
 * GUARD_KINDS) after the join that made `joins`: its maker hears it, as a
 * row of its own that rings. Nobody else does here; the full admins see it
 * among the platform's unexpected events (community-invites.js tellGuard).
 * No email: what it asks for is a tap. Never throws; resolves the row, or
 * null.
 */
async function noteGuard(pool, { inviteId, kind, joins }) {
  if (!GUARD_KINDS.includes(kind)) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, app_id, kind, detail, mailed_at)
       SELECT ci.created_by, ci.app_id, $2, $3, NOW()
         FROM community_invites ci
        WHERE ci.id = $1 AND ci.created_by IS NOT NULL
       RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
      [inviteId, kind, `${Number(inviteId)}:${Math.max(0, Math.floor(Number(joins) || 0))}`],
    );
    const row = rows[0] || null;
    if (row) await notifications().hydrateAndPush(pool, row);
    return row;
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about the guard', { inviteId, kind, err: err.message });
    return null;
  }
}

/**
 * `userId` just wrote `chatMessageId` in `appId`'s chat. When it is their
 * first message there, within HELLO_WITHIN_DAYS of joining through
 * somebody's link, that somebody hears they said hi.
 */
async function noteFirstMessage(pool, { appId, userId, chatMessageId }) {
  try {
    if (!appId || !userId || !chatMessageId) return null;
    const { rows } = await pool.query(
      `SELECT ci.created_by, a.slug, a.name, u.username
         FROM community_invite_redemptions r
         JOIN community_invites ci ON ci.id = r.invite_id
         JOIN apps a ON a.id = ci.app_id
         JOIN users u ON u.id = r.user_id
        WHERE r.user_id = $1 AND ci.app_id = $2 AND r.status = 'joined'
          AND ci.created_by IS NOT NULL AND ci.created_by <> r.user_id
          AND COALESCE(r.applied_at, r.created_at) > NOW() - make_interval(days => $4::int)
          AND EXISTS (SELECT 1 FROM community_members m
                       WHERE m.community_id = ci.community_id AND m.user_id = ci.created_by)
          AND NOT EXISTS (SELECT 1 FROM chat_messages cm
                           WHERE cm.app_id = $2 AND cm.user_id = $1 AND cm.id <> $3)
        ORDER BY COALESCE(r.applied_at, r.created_at) DESC
        LIMIT 1`,
      [userId, appId, chatMessageId, HELLO_WITHIN_DAYS],
    );
    const hello = rows[0];
    if (!hello) return null;
    return await ring(pool, {
      userId: hello.created_by, appId, kind: 'first_message', sourceUserId: userId, chatMessageId,
    });
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a first message', { appId, err: err.message });
    return null;
  }
}

module.exports = {
  KINDS,
  GUARD_KINDS,
  noteGuard,
  HELLO_WITHIN_DAYS,
  OPEN_PUSH_DELAY_MINUTES,
  BROWSER_COOKIE,
  SOURCE_COOKIE,
  browserFrom,
  ensureBrowser,
  setSourceCookie,
  sourceFrom,
  countedBefore,
  ring,
  noteJoined,
  noteOpened,
  settleOpen,
  noteFirstMessage,
};
