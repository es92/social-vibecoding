'use strict';

/**
 * Invite links: /invite/<token>, a way into a community that anyone holding
 * the link can use (schema.sql, "Communities, stage 6: invite links").
 *
 *   createInvite  any member makes one for a project they are in. It lasts
 *                 DEFAULT_DAYS and works for DEFAULT_USES people unless they
 *                 choose otherwise, within the LIMITS.
 *   listInvites   the viewer's own live links (every live link, for someone
 *                 who manages the project).
 *   revokeInvite  its maker, a project admin or a platform admin turns it
 *                 off. People it queued who were not let in yet are cancelled
 *                 with it; people who already joined stay.
 *   preview       what a link shows before anyone signs in: the project's
 *                 name and icon, who invited you, how many are in it. A dead
 *                 link shows none of that, only why it is dead.
 *   redeem        following a link. Somebody with platform access joins on
 *                 the spot. Somebody without it (a new account, or one still
 *                 on the waitlist) joins on the spot too, as a PRIVATE MEMBER
 *                 (users.private_member_since): in this community now, on the
 *                 waitlist for making apps of their own, once they have a
 *                 verified phone (whenever phone sign-in is offered). A
 *                 redemption the link cannot grant now stays queued, and the
 *                 trigger in schema.sql applies it the moment they are let
 *                 in, however that happens.
 *
 * WHAT A LINK GRANTS is what its maker could grant: on a project where
 * building is by invitation it is the collaborator invite, accepted; anywhere
 * else it is membership. schema.sql's apply_community_invite() is the one
 * implementation, used both here and by that trigger.
 *
 * THE INVITE TREE IS RETIRED. A link used to be able to let somebody past
 * the waitlist outright, on one of its maker's lifetime skips (ten for the
 * people we let off the waitlist by hand, unlimited for admins), switched in
 * Admin → Waitlist. Private membership replaced it: everybody new a link
 * brings in joins its community as a private member, whoever made the link,
 * and is let in from the waitlist like anybody else. users.admitted_by and
 * invite_generation keep the history of who a skip let in.
 */

const crypto = require('crypto');
const log = require('./logger');
const events = require('./events');
const appAccess = require('./app-access');
const appAdmins = require('./app-admins');
const communities = require('./communities');

const DEFAULT_DAYS = 7;
const DEFAULT_USES = 25;
const LIMITS = Object.freeze({ minDays: 1, maxDays: 30, minUses: 1, maxUses: 100 });
// Live links one person may hold for one project at a time. Links are cheap
// to make; a cap keeps a single account from minting an unbounded supply.
const MAX_LIVE_PER_MAKER = 10;

// 16 random bytes, base64url: 22 characters. Anything else is not a token
// and never reaches the database.
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function isToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function invitePath(token) {
  return `/invite/${token}`;
}

// A link's note: the maker's own words for the people it goes to, shown on
// the page it opens and in its preview. Plain text in one paragraph, at most
// NOTE_MAX characters (schema.sql, community_invites_note_length).
const NOTE_MAX = 280;

/**
 * The note as stored: whitespace collapsed, control characters refused.
 * Returns { ok: true, note } (note is null for none) or { ok: false, error }.
 */
function cleanNote(value) {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== 'string') return { ok: false, error: 'A note must be text.' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return { ok: false, error: 'A note must be plain text.' };
  const note = value.replace(/\s+/g, ' ').trim();
  if (!note) return { ok: true, note: null };
  if ([...note].length > NOTE_MAX) return { ok: false, error: `A note is at most ${NOTE_MAX} characters.` };
  return { ok: true, note };
}

/** A whole number within [min, max], or `fallback` when none was given. */
function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

// WP-D: 0 asks for no limit: a link with no end date (`days: 0`) or for any
// number of people (`maxUses: 0`), stored as NULL, which works until it is
// turned off. The first session's invite asks for both: the project is the
// gift, so its link should outlive any week.
const NO_LIMIT = 0;
function isNoLimit(value) {
  return value === NO_LIMIT || value === String(NO_LIMIT);
}

/**
 * Why a link cannot be used, or null when it can. A link whose maker can no
 * longer grant what it grants (removed from the group, left the community,
 * account gone) reads as turned off: it died with their standing
 * (schema.sql, community_invite_maker_holds).
 */
function deadReason(invite, now = new Date()) {
  if (!invite) return 'unknown';
  if (invite.revoked_at || invite.maker_holds === false) return 'revoked';
  if (invite.expires_at != null && new Date(invite.expires_at) <= now) return 'expired';
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return 'used_up';
  return null;
}

// What a link grants on this project: 'collaborator' where building is by
// invitation, 'member' anywhere else. Mirrors apply_community_invite().
function grantFor(app) {
  return app.collab_visibility === 'private' && !app.self_hosted ? 'collaborator' : 'member';
}

/**
 * May `user` make a link for `app` (a row carrying ACCESS_COLUMNS and
 * community_id)? They must be able to grant what the link grants: a
 * collaborator where building is by invitation, a member elsewhere. Admins
 * may always.
 */
async function canCreate(pool, app, user) {
  if (!app || !user || app.community_id == null) return false;
  if (user.isAdmin) return true;
  if (grantFor(app) === 'collaborator') return appAccess.isCollaborator(pool, app.id, user.id);
  return communities.isMember(pool, app.id, user.id);
}

/** May `user` turn off `invite` (a row carrying created_by) on `app`? */
async function canRevoke(pool, app, invite, user) {
  if (!user || !invite) return false;
  if (user.canAdminWrite) return true;
  if (invite.created_by != null && invite.created_by === user.id) return true;
  return appAdmins.canManageApp(pool, app, user);
}

function serializeLink(row, viewerId) {
  return {
    id: row.id,
    token: row.token,
    path: invitePath(row.token),
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    createdBy: row.created_by_username || null,
    mine: row.created_by != null && row.created_by === viewerId,
    note: row.note || null,
  };
}

/**
 * Make a link. `app` carries ACCESS_COLUMNS, community_id and name. Returns
 * `{ ok: true, link }` or `{ ok: false, status, error }`.
 */
async function createInvite(pool, { app, user, days, maxUses, note }) {
  if (!(await canCreate(pool, app, user))) {
    return { ok: false, status: 403, error: 'Only people in this project can invite others to it.' };
  }
  const cleaned = cleanNote(note);
  if (!cleaned.ok) return { ok: false, status: 400, error: cleaned.error };
  const noEnd = isNoLimit(days);
  const anyone = isNoLimit(maxUses);
  const d = noEnd ? NO_LIMIT : clampInt(days, DEFAULT_DAYS, LIMITS.minDays, LIMITS.maxDays);
  const u = anyone ? NO_LIMIT : clampInt(maxUses, DEFAULT_USES, LIMITS.minUses, LIMITS.maxUses);
  if (d === null) {
    return { ok: false, status: 400, error: `A link lasts between ${LIMITS.minDays} and ${LIMITS.maxDays} days.` };
  }
  if (u === null) {
    return { ok: false, status: 400, error: `A link works for between ${LIMITS.minUses} and ${LIMITS.maxUses} people.` };
  }
  const { rows: live } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM community_invites
      WHERE app_id = $1 AND created_by = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW()) AND (max_uses IS NULL OR uses < max_uses)`,
    [app.id, user.id]
  );
  if ((live[0]?.n || 0) >= MAX_LIVE_PER_MAKER) {
    return { ok: false, status: 429, error: `You already have ${MAX_LIVE_PER_MAKER} live links for this project. Turn one off first.` };
  }
  const token = newToken();
  const { rows } = await pool.query(
    `INSERT INTO community_invites (token, community_id, app_id, created_by, max_uses, expires_at, note)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $6::int) END, $7)
     RETURNING id, token, created_by, max_uses, uses, expires_at, created_at, note`,
    [token, app.community_id, app.id, user.id, anyone ? null : u, noEnd ? null : d, cleaned.note]
  );
  events.record(pool, {
    type: events.EVENT_TYPES.INVITE_LINK_CREATED,
    userId: user.id,
    appId: app.id,
    metadata: { inviteId: rows[0].id, days: noEnd ? null : d, maxUses: anyone ? null : u, hasNote: !!cleaned.note },
  });
  return { ok: true, link: serializeLink({ ...rows[0], created_by_username: user.username }, user.id) };
}

/**
 * The live links for `app` the viewer may see: their own, or every live
 * link when they manage the project. Newest first.
 */
async function listInvites(pool, { app, user }) {
  const manages = !!user && (user.canAdminWrite || await appAdmins.canManageApp(pool, app, user));
  const { rows } = await pool.query(
    `SELECT i.id, i.token, i.created_by, i.max_uses, i.uses, i.expires_at, i.created_at, i.note,
            u.username AS created_by_username
       FROM community_invites i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1
        AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > NOW())
        AND (i.max_uses IS NULL OR i.uses < i.max_uses)
        AND ($3::boolean OR i.created_by = $2)
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 50`,
    [app.id, user?.id || null, manages]
  );
  return { links: rows.map((r) => serializeLink(r, user?.id)), manages };
}

/**
 * Whether `userId` has a live invite link for `app` (the same "live" as
 * listInvites: not turned off, not past its end, not used up). The hub reads
 * it to draw a project that is just theirs with open seats once a link is
 * out (#4045, 8 Oct 2026). It is the only trace a link leaves: copying or
 * sharing it happens on the person's device, and making the link is what
 * opening the invite pane does, so this says "a link was made", which is as
 * near to "went out" as the records get.
 */
async function hasLiveLink(pool, appId, userId) {
  if (!appId || !userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM community_invites
      WHERE app_id = $1 AND created_by = $2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses IS NULL OR uses < max_uses)
      LIMIT 1`,
    [appId, userId]
  );
  return rows.length > 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function inDays(ms) {
  const days = Math.max(1, Math.round(ms / DAY_MS));
  return days === 1 ? 'a day' : `${days} days`;
}

/**
 * WP-D: the one line on what joining means for the people a link brings,
 * said from the project's real rule (services/governance.js, and the default
 * gate's numbers in active-users.js), never written out by hand. Small on
 * purpose: information, not a warning. Pure; joiningRule reads its inputs.
 *
 * Under the default rule it is said for the people it counts: `people`, the
 * vote's own denominator (active-users.js getActiveUserStats: who uses it,
 * floored at two once it is a group), plus `invited`, the invites by
 * username still waiting, who count once they accept. Until anybody else is
 * in it, the maker and the first person they bring: "With one other person
 * using it". First-session run-through, 5 October 2026: that sentence was
 * all it ever said, with a second member in and a third invited.
 */
function joiningRuleText({ approvalsRequired = null, approverPolicy = 'anyone', locked = false, people = 1, invited = 0 } = {}) {
  const votes = require('./active-users');
  const admin = locked ? ' An admin has to say yes too.' : '';
  if (approvalsRequired != null) {
    const n = approvalsRequired;
    const whose = approverPolicy === 'invited' ? ' from its approvers' : '';
    return `A change goes live once it has ${n === 1 ? 'a yes' : `${n} yes votes`}${whose}.${admin}`;
  }
  if (approverPolicy === 'invited') return `A change goes live once its approvers back it.${admin}`;
  const waiting = Math.max(0, parseInt(invited, 10) || 0);
  const total = Math.max(2, (parseInt(people, 10) || 0) + waiting);
  const required = votes.requiredVotes(total, 0);
  const lazy = votes.lazyWindowMs(total, 1, 0);
  if (total === 2) {
    if (required <= 1) return `With one other person using it, a change goes live when either of you says yes.${admin}`;
    const wait = lazy == null ? '' : `, or ${inDays(lazy)} after one of you says yes if the other doesn't answer`;
    return `With one other person using it, a change goes live when you both say yes${wait}.${admin}`;
  }
  const headcount = waiting ? `${total} people in it, counting ${waiting} invited` : `${total} people using it`;
  const who = required <= 1 ? 'one of you says' : `${required} of you say`;
  const wait = lazy == null ? '' : `, or ${inDays(lazy)} after the first yes if nobody says no`;
  return `With ${headcount}, a change goes live when ${who} yes${wait}.${admin}`;
}

/**
 * joiningRuleText for `app` (carrying id and locked), with its rule and its
 * headcount read. Never throws; null when the rule cannot be read.
 */
async function joiningRule(pool, app) {
  try {
    const governance = require('./governance');
    const gov = await governance.getGovernance(pool, app.id);
    let people = 1;
    let invited = 0;
    if (gov.approvalsRequired == null && gov.approverPolicy !== 'invited') {
      const votes = require('./active-users');
      const [stats, { rows }] = await Promise.all([
        votes.getActiveUserStats(pool, app.id),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM app_collaborators WHERE app_id = $1 AND status = 'invited'`,
          [app.id]
        ),
      ]);
      people = stats.active;
      invited = rows[0]?.n || 0;
    }
    return joiningRuleText({ ...gov, locked: !!app.locked, people, invited });
  } catch (err) {
    log.warn('invites', 'Could not read the joining rule', { appId: app?.id, err: err.message });
    return null;
  }
}

/**
 * Turn a link off. Returns `{ ok: true, cancelled }` (how many people it had
 * queued who will now not join) or `{ ok: false, status, error }`. A link the
 * caller may not see answers 404, like any private thing here.
 */
async function revokeInvite(pool, { inviteId, user }) {
  const id = parseInt(inviteId, 10);
  if (!Number.isFinite(id)) return { ok: false, status: 404, error: 'Invite link not found' };
  const { rows } = await pool.query(
    `SELECT i.id, i.created_by, i.revoked_at, a.id AS app_id, a.slug, a.created_by AS app_created_by
       FROM community_invites i JOIN apps a ON a.id = i.app_id
      WHERE i.id = $1`,
    [id]
  );
  const row = rows[0];
  const app = row ? { id: row.app_id, slug: row.slug, created_by: row.app_created_by } : null;
  if (!row || !(await canRevoke(pool, app, row, user))) {
    return { ok: false, status: 404, error: 'Invite link not found' };
  }
  await pool.query(
    'UPDATE community_invites SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1',
    [id]
  );
  const { rows: cancelled } = await pool.query(
    `UPDATE community_invite_redemptions
        SET status = 'cancelled'
      WHERE invite_id = $1 AND status = 'queued' AND applied_at IS NULL
      RETURNING id`,
    [id]
  );
  events.record(pool, {
    type: events.EVENT_TYPES.INVITE_LINK_REVOKED,
    userId: user.id,
    appId: row.app_id,
    metadata: { inviteId: id, cancelled: cancelled.length },
  });
  return { ok: true, cancelled: cancelled.length };
}

// The link and its project, as preview and redeem read them. `lock` takes
// the row lock redeem needs; the caller holds a transaction.
async function loadInvite(db, token, { lock = false } = {}) {
  if (!isToken(token)) return null;
  const { rows } = await db.query(
    `SELECT i.id, i.token, i.community_id, i.app_id, i.created_by, i.max_uses, i.uses,
            i.expires_at, i.revoked_at, i.note,
            a.slug, a.name, a.icon_emoji, a.icon_image_id, a.created_by AS app_created_by,
            a.self_hosted, a.collab_visibility, a.view_visibility, a.community_id AS app_community_id,
            a.manifest_snapshot->>'description' AS description,
            u.username AS inviter, u.display_name AS inviter_display_name,
            community_invite_maker_holds(i.id) AS maker_holds
       FROM community_invites i
       JOIN apps a ON a.id = i.app_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.token = $1
      ${lock ? 'FOR UPDATE OF i' : ''}`,
    [token]
  );
  return rows[0] || null;
}

async function memberCount(db, communityId) {
  if (communityId == null) return 0;
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM community_members WHERE community_id = $1',
    [communityId]
  );
  return rows[0]?.n || 0;
}

/**
 * The picture a link's page shows of the project, or null. In order:
 *
 *   'shot'          the phone-shaped after-shot of the project's latest
 *                   merged change, as its members saw it on the change: what
 *                   the project actually looks like. Served only through the
 *                   link (GET /api/public/invites/:token/picture), and only
 *                   while the link is live.
 *   'illustration'  the Discover card's image, which its group chose to show
 *                   (and is already served to anyone by its id).
 *   'sketch'        WP-D: while it is built, the featured card its maker was
 *                   shown (services/app-sketch.js): its emoji, tagline and
 *                   points, which the page draws itself.
 *
 * A project with neither shows its icon and description instead.
 */
async function pictureFor(db, appId) {
  const { rows } = await db.query(
    `SELECT a.id
       FROM chat_sessions s
       JOIN shot_runs r ON r.id = s.shots_run_id AND r.state = 'verified'
       JOIN shot_artifacts a ON a.run_id = r.id
      WHERE s.app_id = $1 AND s.merged_at IS NOT NULL AND s.shots_state = 'verified'
        AND a.side = 'head' AND a.media = 'png' AND a.variant IN ('context', 'focus')
        AND a.width IS NOT NULL AND a.height IS NOT NULL AND a.height >= a.width
      ORDER BY s.merged_at DESC, (a.variant = 'context') DESC, a.width ASC, a.story_id ASC
      LIMIT 1`,
    [appId]
  );
  if (rows[0]) return { kind: 'shot', artifactId: rows[0].id };
  const { rows: ill } = await db.query(
    `SELECT f.id, f.dark_id
       FROM apps a JOIN app_illustrations f ON f.app_id = a.id
      WHERE a.id = $1 AND a.featured_illustration IS NOT NULL`,
    [appId]
  );
  if (ill[0]) return { kind: 'illustration', id: ill[0].id, darkId: ill[0].dark_id || null };
  // WP-D: a project still being built has no shot yet; the card its maker
  // was shown (services/app-sketch.js) stands in for it.
  const { rows: sketch } = await db.query(
    `SELECT design FROM app_sketches WHERE app_id = $1 AND status = 'ready'`,
    [appId]
  );
  const card = sketch[0] ? require('./app-sketch').cardOf(sketch[0].design) : null;
  if (card) return { kind: 'sketch', card };
  return null;
}

/**
 * The shot a live link's page shows, as { data, contentType, sha256 }, or
 * null: the link must be live and its project must have one (pictureFor).
 */
async function pictureBytes(pool, token) {
  const invite = await loadInvite(pool, token);
  if (deadReason(invite)) return null;
  const picture = await pictureFor(pool, invite.app_id);
  if (!picture || picture.kind !== 'shot') return null;
  const { rows } = await pool.query(
    'SELECT data, content_type, sha256 FROM shot_artifacts WHERE id = $1',
    [picture.artifactId]
  );
  if (!rows[0]) return null;
  return { data: rows[0].data, contentType: rows[0].content_type, sha256: rows[0].sha256 };
}

function pictureUrls(token, picture) {
  if (!picture) return null;
  if (picture.kind === 'shot') return { kind: 'shot', url: `/api/public/invites/${token}/picture`, darkUrl: null };
  if (picture.kind === 'sketch') return { kind: 'sketch', url: null, darkUrl: null, card: picture.card };
  return {
    kind: 'illustration',
    url: `/app-illustrations/${picture.id}`,
    darkUrl: picture.darkId ? `/app-illustrations/${picture.darkId}` : null,
  };
}

/**
 * Whether the project's first version is still on its way: Homeroom bot
 * builds it (homeroom_bot_first_versions) and no proposal for it has merged,
 * the first gate of homeroom-bot-dm.js firstVersionState without its
 * progress reads. While it is, the project is being made, not made: "Maya
 * is making Page Turners" on the invite page, its link preview, the
 * signed-in confirm and "You're in" (first-session run-through, 5 October
 * 2026). False for a project made any other way, and for a read that fails:
 * that is the line as it was.
 */
async function firstVersionPending(db, appId) {
  try {
    const { rows } = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM homeroom_bot_first_versions f
          WHERE f.app_id = $1 AND f.bot_builds = TRUE AND f.status IN ('waiting', 'filing', 'filed')
            AND NOT EXISTS (
              SELECT 1 FROM homeroom_bot_runs r
                JOIN chat_sessions cs ON cs.id = r.proposal_session_id
               WHERE r.app_id = f.app_id AND r.issue_number = f.issue_number AND cs.status = 'merged'
            )
       ) AS pending`,
      [appId]
    );
    return rows[0]?.pending === true;
  } catch (err) {
    log.warn('invites', 'Could not read whether a first version is on its way', { appId, err: err.message });
    return false;
  }
}

/**
 * What a link shows before anyone signs in. A live link discloses the
 * project's name, icon and one-line description, who invited you (and
 * whether they made it), their note, one picture of it (pictureFor) and how
 * many are in it — what the invite itself offers to share — and never the
 * project's address: that comes after joining. A dead or unknown link
 * discloses nothing but why.
 */
async function preview(pool, token) {
  const invite = await loadInvite(pool, token);
  const reason = deadReason(invite);
  if (reason) return { live: false, reason };
  const [count, picture, building] = await Promise.all([
    memberCount(pool, invite.community_id),
    pictureFor(pool, invite.app_id),
    firstVersionPending(pool, invite.app_id),
  ]);
  return {
    live: true,
    reason: null,
    project: {
      name: invite.name || invite.slug,
      iconEmoji: invite.icon_emoji || null,
      iconUrl: invite.icon_image_id ? `/app-icons/${invite.icon_image_id}` : null,
      description: invite.description || null,
      picture: pictureUrls(token, picture),
      // A public community: its Join asks for a username, not a name (a
      // public place never shows a provisional handle, usernames.js).
      public: invite.view_visibility === 'public',
    },
    inviter: invite.inviter || null,
    inviterName: invite.inviter_display_name || invite.inviter || null,
    // The person who sent it made the project: "Maya made Run Tracker", or,
    // while its first version is on its way (`building`), "Maya is making
    // Run Tracker".
    inviterMadeIt: invite.created_by != null && invite.created_by === invite.app_created_by,
    building,
    note: invite.note || null,
    memberCount: count,
    expiresAt: invite.expires_at instanceof Date ? invite.expires_at.toISOString() : invite.expires_at,
  };
}

// Whether `userId` already has what the link grants, so following it again
// changes nothing and spends no use.
async function alreadyHasGrant(db, invite, userId) {
  const app = { id: invite.app_id, collab_visibility: invite.collab_visibility, self_hosted: invite.self_hosted };
  if (grantFor(app) === 'collaborator') return appAccess.isCollaborator(db, invite.app_id, userId);
  return communities.isMember(db, invite.app_id, userId);
}

/**
 * The viewer's standing on a link, for the signed-in invite screen: the
 * preview, plus `mine` — 'joined' when they are in the project (however they
 * got there), 'queued' or 'cancelled' for a redemption still waiting or
 * called off, null when they have not followed it — and the project's slug
 * once they are in it.
 *
 * For somebody NOT in it yet, on a live link, how its project opens
 * instead of a question over Home (App._followInvite, #3700; entryFor):
 * `page`, that slug, when they may already open the project's page (a
 * public community), or `invitePreview` when they may not (a private
 * community), which the shell draws from this standing alone. A private
 * project's slug still comes only after joining. `showSelfHosted` is
 * whether the platform's own project's page is this viewer's to open.
 */
async function standing(pool, token, user, { showSelfHosted = false } = {}) {
  const base = await preview(pool, token);
  const invite = await loadInvite(pool, token);
  if (!invite || !user) return { ...base, mine: null, slug: null };
  const { rows } = await pool.query(
    'SELECT status, applied_at FROM community_invite_redemptions WHERE invite_id = $1 AND user_id = $2',
    [invite.id, user.id]
  );
  const inIt = await alreadyHasGrant(pool, invite, user.id);
  const mine = inIt ? 'joined' : (rows[0]?.status || null);
  // When THIS link joined them, so the shell can tell somebody it just let
  // in (the sign-in they came through followed it) from a member opening an
  // old link: only the first gets "You're in".
  const appliedAt = inIt && rows[0]?.status === 'joined' ? rows[0].applied_at : null;
  // Whether the account is about as old as its joining: made by the sign-up
  // this link opened, so "You're in" tells it what Homeroom is. A test
  // account, made ahead by an admin, is new on its first sign-in instead
  // (test-accounts.js onFirstRun).
  let newAccount = false;
  if (appliedAt) {
    const { rows: u } = await pool.query(
      `SELECT created_at >= $2::timestamptz - INTERVAL '1 hour' AS fresh FROM users WHERE id = $1`,
      [user.id, appliedAt]
    );
    newAccount = !!u[0]?.fresh || await require('./test-accounts').onFirstRun(pool, user.id, appliedAt);
  }
  const entry = !inIt && base.live ? await entryFor(pool, invite, user, showSelfHosted) : null;
  return {
    ...base,
    mine,
    slug: inIt ? invite.slug : null,
    page: entry ? entry.page : null,
    invitePreview: entry ? entry.invitePreview : null,
    joinedAt: appliedAt instanceof Date ? appliedAt.toISOString() : (appliedAt || null),
    newAccount,
  };
}

const NO_ENTRY = Object.freeze({ page: null, invitePreview: null });

/**
 * How a live link's project opens for `user`, who is not in it yet
 * (standing's `page` and `invitePreview`, #3700). One of:
 *
 *   page           its slug: they may open its page already (a public
 *                  community), so the shell opens it in its not-joined state;
 *   invitePreview  they may not (a private community): what its invite
 *                  preview draws beyond the link's own preview, which is the
 *                  colour its header wears. The preview is drawn from this
 *                  standing alone. It is not access: the app, its items, its
 *                  discussion, its members and its proposals stay behind
 *                  checkAppAccess, which this does not touch, until Join
 *                  follows the link;
 *   neither        a suspended app, one they blocked, the platform's own
 *                  project where its page's community read would not answer
 *                  them (routes/apps.js GET /community, `showSelfHosted`), or
 *                  a read that failed: the confirm, as before.
 *
 * Only ever asked for a LIVE link (deadReason, the rule redeem follows too):
 * a dead one shows nothing but why.
 */
async function entryFor(pool, invite, user, showSelfHosted) {
  if (invite.self_hosted && !showSelfHosted) return NO_ENTRY;
  try {
    const { rows } = await pool.query(`SELECT ${appAccess.ACCESS_COLUMNS}, icon_color FROM apps WHERE id = $1`, [invite.app_id]);
    const app = rows[0];
    if (!app || app.moderation_suspended_at) return NO_ENTRY;
    if (await appAccess.checkAppAccess(pool, app, user, 'view')) return { page: invite.slug, invitePreview: null };
    if (await require('./app-blocks').isBlocked(pool, user.id, app.id)) return NO_ENTRY;
    return { page: null, invitePreview: { iconColor: app.icon_color || null, audienceLabel: communities.AUDIENCE_LABELS.invited } };
  } catch (err) {
    log.warn('invites', 'Could not read how an invitee may open the project', { err: err.message });
    return NO_ENTRY;
  }
}

/**
 * Follow a link as `user` ({ id, isAdmin, hasPlatformAccess }). One
 * transaction, the link's row locked for its use count. `browser` is the
 * browser it was followed from (invite-activity.browserFrom), for the
 * maker's open notice. `requirePhone` is whether a private member must have
 * a verified phone (joinAsPrivateMember): the callers pass
 * firebase-phone-auth.offered(config).
 *
 * Returns `{ ok: true, status, slug, name, privateMember }`:
 *   status 'joined'  in the project now (slug set);
 *          'member'  was already in it; nothing spent (slug set);
 *          'queued'  the link could not grant it now (its maker no longer
 *                    holds the right, say, or a private member's phone is
 *                    missing): joins when let in (no slug);
 * or `{ ok: false, status: 404|410, reason }` for an unknown or dead link.
 *
 * Somebody without platform access joins too, as a PRIVATE MEMBER
 * (`privateMember`, users.private_member_since in schema.sql): in this
 * community now, on the waitlist for making apps of their own, whoever made
 * the link (the invite tree's skips are retired; see the header). A
 * redemption queued before private membership existed is applied the same
 * way when its link is followed again, without spending another use.
 */
async function redeem(pool, { token, user, browser = null, requirePhone = false }) {
  if (!user || !user.id) return { ok: false, status: 401, reason: 'signed_out' };
  if (!isToken(token)) return { ok: false, status: 404, reason: 'unknown' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invite = await loadInvite(client, token, { lock: true });
    if (!invite) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, reason: 'unknown' };
    }
    const name = invite.name || invite.slug;

    if (await alreadyHasGrant(client, invite, user.id)) {
      await client.query('COMMIT');
      return { ok: true, status: 'member', slug: invite.slug, name, privateMember: false };
    }
    const hasAccess = !!(user.hasPlatformAccess || user.isAdmin);
    // A public community never shows a provisional handle: the person picks
    // a username first (usernames.USERNAME_REQUIRED), and nothing is spent.
    if (invite.view_visibility === 'public'
        && await require('./usernames').isProvisional(client, user.id)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, reason: 'username_required' };
    }
    const { rows: prior } = await client.query(
      'SELECT id, status FROM community_invite_redemptions WHERE invite_id = $1 AND user_id = $2',
      [invite.id, user.id]
    );
    let redemptionId;
    if (prior[0] && prior[0].status === 'queued') {
      if (hasAccess) {
        await client.query('COMMIT');
        return { ok: true, status: 'queued', slug: null, name, privateMember: false };
      }
      // Queued before an invite could let somebody in as a private member:
      // its use is spent already, so following the link again applies it.
      redemptionId = prior[0].id;
    } else {
      const reason = deadReason(invite);
      if (reason) {
        await client.query('ROLLBACK');
        return { ok: false, status: 410, reason };
      }

      // A fresh row, or a cancelled one re-armed by a live link: either way it
      // spends one use of THIS link.
      const { rows: redemption } = await client.query(
        `INSERT INTO community_invite_redemptions (invite_id, user_id, status)
         VALUES ($1, $2, 'queued')
         ON CONFLICT (invite_id, user_id) DO UPDATE
           SET status = 'queued', applied_at = NULL, created_at = NOW()
         RETURNING id`,
        [invite.id, user.id]
      );
      await client.query('UPDATE community_invites SET uses = uses + 1 WHERE id = $1', [invite.id]);
      redemptionId = redemption[0].id;
    }

    let privateMember = false;
    if (hasAccess) {
      await client.query('SELECT apply_community_invite($1)', [redemptionId]);
    } else {
      privateMember = await joinAsPrivateMember(client, user.id, redemptionId, { requirePhone });
    }
    const { rows: after } = await client.query(
      'SELECT status FROM community_invite_redemptions WHERE id = $1',
      [redemptionId]
    );
    // Somebody who arrived by a link has their community: the join screen
    // a new account answers ("What communities do you want to join?",
    // services/onboarding.js) is not put between them and it. Answered
    // as 'invite' for the admin Journey page, and communities_onboarded_at
    // stays NULL. The Getting started card and the First-challenges gate
    // follow `getting_started_gate` alone (#4601), so a new account that
    // came by a link gets both like any other.
    await client.query(
      `UPDATE users
          SET needs_communities_choice = FALSE,
              getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                     || jsonb_build_object('join_answer', 'invite')
        WHERE id = $1 AND needs_communities_choice = TRUE`,
      [user.id]
    );
    await client.query('COMMIT');

    const status = after[0]?.status === 'joined' ? 'joined' : 'queued';
    if (status === 'joined') {
      appAccess.invalidateVisibility(invite.app_id, invite.slug);
      // WP-F: Homeroom bot says hello, once, when it builds for them.
      void require('./homeroom-bot-dm').greetJoiner(pool, {
        user, app: { id: invite.app_id, slug: invite.slug, name: invite.name },
      });
      // WP-E: the link's maker hears who came in by it, and the open that
      // brought them (from this browser, maybe signed out) is not news now.
      void require('./invite-activity').noteJoined(pool, { inviteId: invite.id, user, browser });
    }
    events.record(pool, {
      type: events.EVENT_TYPES.INVITE_LINK_REDEEMED,
      userId: user.id,
      appId: invite.app_id,
      metadata: { inviteId: invite.id, status, privateMember },
    });
    return {
      ok: true, status, slug: status === 'joined' ? invite.slug : null, name, privateMember,
      public: invite.view_visibility === 'public',
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Join `userId`, who has no platform access, to the community of the
 * redemption `redemptionId` as a PRIVATE MEMBER, inside the caller's
 * transaction. apply_community_invite does the joining, as it does for
 * everybody, and asks nothing about access; only once it has joined them is
 * the account marked (users.private_member_since, kept from the first link
 * that did it). A redemption it skipped (its maker lost the right to grant,
 * say) stays queued and marks nothing. Returns whether they are in.
 *
 * A private member signs up with a phone number: with `requirePhone` (phone
 * sign-in is offered), an account with no verified phone
 * (user_phone_identities, services/firebase-phone-auth.js) is not joined at
 * all, and its redemption stays queued, so it joins when let in off the
 * waitlist like any queued one. The invite's Join sheet starts with the
 * phone for that reason. Without phone sign-in set up, nothing could meet
 * the rule, so it is not asked.
 */
async function joinAsPrivateMember(client, userId, redemptionId, { requirePhone = false } = {}) {
  if (requirePhone) {
    const { rows: phone } = await client.query(
      'SELECT 1 FROM user_phone_identities WHERE user_id = $1',
      [userId]
    );
    if (!phone.length) return false;
  }
  await client.query('SELECT apply_community_invite($1)', [redemptionId]);
  const { rows } = await client.query(
    'SELECT status FROM community_invite_redemptions WHERE id = $1',
    [redemptionId]
  );
  if (rows[0]?.status !== 'joined') return false;
  const { rows: marked } = await client.query(
    `UPDATE users
        SET private_member_since = COALESCE(private_member_since, NOW())
      WHERE id = $1 AND has_platform_access = FALSE
      RETURNING id`,
    [userId]
  );
  return marked.length > 0;
}

/** The communities a person without access yet is queued to join. */
async function queuedFor(pool, userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (a.id) a.name, a.slug, u.username AS inviter
       FROM community_invite_redemptions x
       JOIN community_invites i ON i.id = x.invite_id
       JOIN apps a ON a.id = i.app_id
       LEFT JOIN users u ON u.id = i.created_by
      WHERE x.user_id = $1 AND x.status = 'queued' AND x.applied_at IS NULL
        AND i.revoked_at IS NULL
      ORDER BY a.id, x.created_at ASC`,
    [userId]
  );
  return rows.map((r) => ({ name: r.name || r.slug, inviter: r.inviter || null }));
}

/**
 * Follow again, as a private member, every link `userId` (no access yet) is
 * queued on: what an account made by email does once it adds the phone a
 * private member needs (routes/phone-auth.js /api/auth/phone-link/verify).
 * Through redeem itself, so a queued row is applied without spending a
 * second use, and the joining is told and recorded as any other. Returns
 * the communities joined, `[{ slug, name }]`, oldest link first. A link
 * that fails is logged and skipped: the rest still join.
 */
async function joinQueued(pool, userId) {
  const { rows: u } = await pool.query(
    'SELECT id, is_admin, has_platform_access FROM users WHERE id = $1',
    [userId]
  );
  if (!u[0] || u[0].is_admin || u[0].has_platform_access) return [];
  const user = { id: u[0].id, isAdmin: false, hasPlatformAccess: false };
  const { rows } = await pool.query(
    `SELECT i.token
       FROM community_invite_redemptions x
       JOIN community_invites i ON i.id = x.invite_id
      WHERE x.user_id = $1 AND x.status = 'queued' AND x.applied_at IS NULL
        AND i.revoked_at IS NULL
      ORDER BY x.created_at ASC`,
    [userId]
  );
  const joined = [];
  for (const { token } of rows) {
    try {
      const result = await redeem(pool, { token, user, requirePhone: true });
      if (result.ok && result.status === 'joined') joined.push({ slug: result.slug, name: result.name });
    } catch (err) {
      log.warn('invites', 'Joining a queued link failed', { userId, err: err.message });
    }
  }
  return joined;
}

// ── Carrying a link through sign-in ────────────────────────────────────
//
// /invite/<token> (routes/community-invites.js) leaves the token in an
// HttpOnly cookie, so the account a visitor signs up for or signs in to
// follows the link server-side, whatever the browser did in between —
// a new account cannot call the API from the waiting room, and the page it
// signs up on is not the page the link opened.
const INVITE_COOKIE = 'hr_invite';
const INVITE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function setInviteCookie(req, res, token) {
  res.cookie(INVITE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: INVITE_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearInviteCookie(res) {
  res.clearCookie(INVITE_COOKIE, { path: '/' });
}

/**
 * Follow the link a signing-in visitor carried, if any, as account `userId`,
 * and clear it. Never throws: signing in must not fail because a link did.
 * Returns `{ name, status, slug }` for the response to mention, or null.
 */
async function redeemCarried(pool, req, res, userId, { requirePhone = false } = {}) {
  const token = req.cookies?.[INVITE_COOKIE];
  if (!token) return null;
  clearInviteCookie(res);
  if (!isToken(token) || !userId) return null;
  try {
    const { rows } = await pool.query(
      'SELECT id, is_admin, has_platform_access FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return null;
    const user = { id: rows[0].id, isAdmin: !!rows[0].is_admin, hasPlatformAccess: !!rows[0].has_platform_access };
    // The admin Journey's invite funnel: signed up or in through this link.
    // Recorded before following it, while they are not in it yet; never
    // throws (journey-events.js).
    await require('./journey-events').noteInviteSignedIn(pool, { token, userId: user.id, carried: true });
    const browser = require('./invite-activity').browserFrom(req);
    const result = await redeem(pool, { token, user, browser, requirePhone });
    if (!result.ok) return null;
    return {
      name: result.name, status: result.status, slug: result.slug,
      privateMember: !!result.privateMember, public: !!result.public,
    };
  } catch (err) {
    log.warn('invites', 'Following a carried invite link failed', { userId, err: err.message });
    return null;
  }
}

/**
 * A sign-in that carried a link but does not follow it: an existing account
 * is asked first, by the shell (App._followInvite), unless this sign-in IS
 * the Join its page asked for. The carried copy is dropped, so nothing
 * follows it later without asking. The admin Journey's invite funnel still
 * counts the sign-in as one the link brought (#4272): they opened the link
 * signed out and signed in carrying it, and the shell's standing read after
 * it would otherwise take them for somebody already signed in. Recorded
 * before the sign-in answers, so that read finds it. Never throws; resolves
 * null, as redeemCarried does when it follows nothing.
 */
async function dropCarried(pool, req, res, userId) {
  const token = req.cookies?.[INVITE_COOKIE];
  clearInviteCookie(res);
  if (!token || !isToken(token) || !userId) return null;
  await require('./journey-events').noteInviteSignedIn(pool, { token, userId, carried: true });
  return null;
}

module.exports = {
  DEFAULT_DAYS,
  DEFAULT_USES,
  LIMITS,
  NOTE_MAX,
  cleanNote,
  pictureBytes,
  pictureFor,
  firstVersionPending,
  joiningRule,
  joiningRuleText,
  NO_LIMIT,
  MAX_LIVE_PER_MAKER,
  TOKEN_RE,
  INVITE_COOKIE,
  isToken,
  invitePath,
  deadReason,
  grantFor,
  canCreate,
  hasLiveLink,
  canRevoke,
  createInvite,
  listInvites,
  revokeInvite,
  preview,
  standing,
  redeem,
  queuedFor,
  joinQueued,
  setInviteCookie,
  clearInviteCookie,
  redeemCarried,
  dropCarried,
};
