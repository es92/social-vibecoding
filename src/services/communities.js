// Communities: who a project belongs to, and who is in it.
//
// Every app belongs to exactly one community (apps.community_id; see the
// "Communities" block at the end of src/db/schema.sql). While the two are
// one-to-one — stage 0 of the community model — a community is shown as
// its only project: its name, its icon, its page. What this module adds is
// the part that is already a community's rather than an app's:
//
//   MEMBERSHIP. Joining is what lets a person TAKE PART: start a change,
//   propose it, file a request, vote (on proposals and on requests) and post
//   in the app's chat. The gates are below — requireAppMembership,
//   requireSessionMembership, requireIssueMembership and chatNeedsJoin for
//   the WebSocket — each mounted on the write route it guards. Reading and
//   using an app stay on its own view/collab visibility
//   (services/app-access.js), which this does not replace: the collab guard
//   still decides whether you may be here at all, and this decides whether
//   you have joined.
//
//   AUDIENCE. Who a community is for: 'solo' (Just you), 'invited' (Private
//   community) or 'open' (Public community). Derived from the app, never
//   stored — see audienceSql.
//
// The vote THRESHOLD counts active MEMBERS: services/active-users.js
// intersects its activity rule with this table, so the people a proposal
// needs votes from are the people who are allowed to cast them.

const log = require('./logger');
const appAccess = require('./app-access');
const appAdmins = require('./app-admins');
const { positiveId } = require('./row-id');
const homePins = require('./home-pins');

// The three audiences, in the order the Workshop lists them.
const AUDIENCES = Object.freeze(['open', 'invited', 'solo']);

// What each audience is called on screen. Internal names stay internal:
// "community" is the container, and people see it as one of these.
const AUDIENCE_LABELS = Object.freeze({
  open: 'Public community',
  invited: 'Private community',
  solo: 'Just you',
});

// The audience of the community `alias` (an `apps` row) belongs to, as a SQL
// expression. `members` is an expression for its member count.
//
//   view-public                           → 'open'   anyone can find and join it
//   private, with anyone beyond one person → 'invited' a member or a pending
//                                                    invite makes it a group
//   anything else                         → 'solo'
//
// A pending invite counts because the moment you invite someone is the
// moment you have decided the project is not just yours; waiting for them to
// accept before the label changed would read as the invite not having gone.
function audienceSql(alias, members) {
  return `CASE
    WHEN ${alias}.view_visibility = 'public' THEN 'open'
    WHEN COALESCE(${members}, 0) > 1
      OR EXISTS (SELECT 1 FROM app_collaborators ic
                  WHERE ic.app_id = ${alias}.id AND ic.status = 'invited') THEN 'invited'
    ELSE 'solo'
  END`;
}

async function isMember(pool, appId, userId) {
  if (!appId || !userId) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
      WHERE a.id = $1 AND m.user_id = $2`,
    [appId, userId]
  );
  return rows.length > 0;
}

// The viewer's standing in the app's community, as the community card and
// the Join button need it. `app` must carry `id`.
async function getMembership(pool, app, userId) {
  const { rows } = await pool.query(
    `SELECT a.community_id,
            (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id)
              AS member_count,
            EXISTS (SELECT 1 FROM community_members m
                     WHERE m.community_id = a.community_id AND m.user_id = $2) AS is_member,
            ${audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}
              AS audience,
            (a.created_by IS NOT NULL AND a.created_by = $2) AS is_creator
       FROM apps a
      WHERE a.id = $1`,
    [app.id, userId || null]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    community_id: row.community_id,
    member_count: row.member_count,
    is_member: !!row.is_member,
    is_creator: !!row.is_creator,
    audience: row.audience,
    audience_label: AUDIENCE_LABELS[row.audience] || AUDIENCE_LABELS.open,
  };
}

// Join the community `app` belongs to, and pin the COMMUNITY to Home (One
// Home, #6361: services/home-pins.js). Its app is not pinned: pinning an app
// is its own act now, and the client offers "Pin its app too" once the join
// lands. Neither pin joins anybody any more (one-home-pins.sql dropped the
// app_favorites trigger).
async function join(pool, app, userId) {
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, source)
       SELECT a.community_id, $2, 'joined' FROM apps a
        WHERE a.id = $1 AND a.community_id IS NOT NULL
     ON CONFLICT (community_id, user_id) DO NOTHING`,
    [app.id, userId]
  );
  if (app.community_id) {
    await homePins.pinCommunity(pool, app.community_id, userId);
  } else {
    await pool.query(
      `INSERT INTO home_community_pins (community_id, user_id, position)
       SELECT a.community_id, $2, COALESCE((SELECT MAX(position) + 1 FROM home_community_pins WHERE user_id = $2), 0)
         FROM apps a WHERE a.id = $1 AND a.community_id IS NOT NULL
       ON CONFLICT (user_id, community_id) DO NOTHING`,
      [app.id, userId]
    );
  }
}

// Leave. One transaction, three rows: the membership, the collaborator row
// (on a private app that is your access — leaving it is the point, and the
// confirm says so), and the community's pin on Home. The app's own pin
// (app_favorites) stays: One Home (#6361) keeps a pinned app where it is. The creator cannot leave: an app with
// no creator in its community would have nobody who can invite anyone back,
// which is a state no screen explains. Returns { ok } or { error, status }.
async function leave(pool, app, userId) {
  if (app.created_by && app.created_by === userId) {
    return { ok: false, status: 409, error: 'You started this project, so you can’t leave it.' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM community_members m USING apps a
        WHERE a.id = $1 AND m.community_id = a.community_id AND m.user_id = $2`,
      [app.id, userId]
    );
    await client.query(
      'DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
      [app.id, userId]
    );
    await client.query(
      `DELETE FROM home_community_pins p USING apps a
        WHERE a.id = $1 AND p.community_id = a.community_id AND p.user_id = $2`,
      [app.id, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // A private app's WS audience is its members; drop the cached answer so
  // the next broadcast stops reaching someone who just left.
  appAccess.invalidateVisibility(app.id, app.slug);
  return { ok: true };
}

// The refusal a non-member gets from a gated route. 403, not the 404 the
// visibility guards answer with: by the time this runs the app is one the
// caller may see, so there is nothing to hide, and the client needs the
// code to offer Join in place of a dead end.
/**
 * A PRIVATE MEMBER's vote on a PUBLIC app (view_visibility 'public'), which
 * is refused: they use public apps, and vote in their own private groups,
 * even when a public community's link is what brought them in. Read from
 * the rows, not req.user, so every caller is held to it. Returns the refusal
 * body, or null when the vote may go ahead. schema.sql's
 * counts_toward_outcome keeps such a vote out of every tally and
 * denominator as well.
 */
async function privateVoteRefusal(pool, appId, userId) {
  if (!appId || !userId) return null;
  const { rows } = await pool.query(
    `SELECT 1 FROM users u, apps a
      WHERE u.id = $2 AND a.id = $1
        AND u.private_member_since IS NOT NULL
        AND NOT u.has_platform_access AND NOT u.is_admin
        AND a.view_visibility = 'public'`,
    [appId, userId]
  );
  if (!rows.length) return null;
  return {
    error: 'You can use public apps, but voting on them opens once you are let in off the waitlist.',
    code: 'private_member_public_vote',
  };
}

/**
 * A vote on a PUBLIC app from an account the verified-identity rule holds
 * (schema.sql public_vote_needs_identity: the rule is on, and the voter is
 * neither verified, by a phone, GitHub and X, or zkPassport, nor let in
 * before it was switched on). Refused before anything is recorded, so the
 * Vote button can offer the verification instead of a vote that would not
 * count; counts_toward_outcome leaves such a vote out of every tally too.
 * Returns the refusal body, or null when the vote may go ahead.
 */
async function identityVoteRefusal(pool, appId, userId) {
  if (!appId || !userId) return null;
  const { rows } = await pool.query(
    'SELECT public_vote_needs_identity($1, $2) AS needs',
    [userId, appId]
  );
  if (rows[0]?.needs !== true) return null;
  return {
    error: 'Votes on public apps count from verified accounts. Verify your phone number, or link both GitHub and X in Settings.',
    code: 'identity_required',
  };
}

// #4378: making a project PUBLIC needs a verified owner, so each person
// counts once on the public side. The same predicate the vote routes'
// refusal rests on (identity_needed, inside public_vote_needs_identity): a
// verified account, one let in before the rule, or the rule off all pass.
// The same response shape, so the client opens the same verify sheet.
async function identityPublicRefusal(pool, userId) {
  if (!userId) return null;
  const { rows } = await pool.query('SELECT identity_needed($1) AS needs', [userId]);
  if (rows[0]?.needs !== true) return null;
  return {
    error: 'Public projects need a verified owner. Verify your phone number, or link both GitHub and X in Settings.',
    code: 'identity_required',
  };
}

function joinRequiredBody(app) {
  const name = app.name || app.slug || 'this project';
  return {
    error: `Join ${name} to take part: members start changes, file requests, vote and chat there.`,
    code: 'join_required',
    app: { slug: app.slug, name },
  };
}

// The columns every gate below reads, off an `apps` row aliased `a`, with
// `$2` the caller's user id.
const GATE_COLUMNS = `a.id, a.slug, a.name, a.community_id, a.created_by, a.collab_visibility, a.view_visibility,
                EXISTS (SELECT 1 FROM community_members m
                         WHERE m.community_id = a.community_id AND m.user_id = $2) AS is_member`;

// Whether `app` (a row carrying GATE_COLUMNS) should be refused with
// join_required for `user`. Only ever TRUE for someone who could otherwise
// take part — see the notes on requireSessionMembership (below) for the
// three ways it answers false. `manage` is for a write only the creator or
// an app admin may make (a proposal about who sees, builds or decides): they
// are the ones asked, whether or not they build here, since joining needs
// only view access (POST /api/apps/:slug/membership); anyone else gets the
// route's own refusal.
async function refusesToJoin(pool, app, user, { manage = false } = {}) {
  if (!app || user?.isAdmin) return false;
  if (app.community_id == null || app.is_member) return false;
  if (!manage) return appAccess.checkAppAccess(pool, app, user, 'collab');
  return (await appAccess.checkAppAccess(pool, app, user, 'view'))
    && appAdmins.canManageApp(pool, app, user);
}

// The same gate as middleware over a resolved row, for the three route
// gates below, which differ only in how they find the app.
function gate(pool, findApp, what, opts) {
  return async (req, res, next) => {
    if (req.user?.isAdmin) return next();
    try {
      const app = await findApp(req);
      if (await refusesToJoin(pool, app, req.user, opts)) return res.status(403).json(joinRequiredBody(app));
      return next();
    } catch (err) {
      log.error('communities', `membership guard failed (${what})`, { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// For `/api/apps/:slug/...` write routes: starting a change, filing a
// request, importing a pull request, posting to the app's chat over HTTP,
// proposing a settings change (`{ manage: true }` for the ones only the
// creator or an app admin may propose).
// A slug that does not resolve falls through to the route's own 404.
function requireAppMembership(pool, opts = {}) {
  return gate(pool, async (req) => {
    if (!req.params.slug) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.slug = $1`,
      [req.params.slug, req.user?.id || null]
    );
    return rows[0] || null;
  }, 'app', opts);
}

// For `/api/issues/:id/...` write routes: voting on a request or a
// governance proposal.
function requireIssueMembership(pool) {
  return gate(pool, async (req) => {
    const id = parseInt(req.params.id, 10);
    // Out of int4 range falls through too: Postgres would reject the cast.
    if (!Number.isFinite(id) || id < 1 || id > 2147483647) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS} FROM issues i JOIN apps a ON a.id = i.app_id WHERE i.id = $1`,
      [id, req.user?.id || null]
    );
    return rows[0] || null;
  }, 'issue');
}

// B8: Suggest an improvement (POST /api/feedback) files a request on the app its
// body names rather than one in the path: the same gate, by slug. Returns the
// join_required body to answer with, or null to let it through.
async function appNeedsJoin(pool, slug, user, opts = {}) {
  if (!slug || user?.isAdmin) return null;
  const { rows } = await pool.query(
    `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.slug = $1`,
    [slug, user?.id || null]
  );
  const app = rows[0];
  return (await refusesToJoin(pool, app, user, opts)) ? joinRequiredBody(app) : null;
}

// The WebSocket chat write (src/services/ws.js, a 'chat' message). Returns
// the join_required body to send back to that one client, or null to let the
// message through. Only 'chat' is gated: typing indicators and reactions are
// not posting, and a Join prompt on a keystroke would be a trap.
async function chatNeedsJoin(pool, appId, user) {
  if (!appId || user?.isAdmin) return null;
  const { rows } = await pool.query(
    `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.id = $1`,
    [appId, user?.id || null]
  );
  const app = rows[0];
  return (await refusesToJoin(pool, app, user)) ? joinRequiredBody(app) : null;
}

// #general is the Homeroom community's channel, so posting there is for the
// members of that community, like posting in any app's chat. Reading stays
// open: the room is still every signed-in person's to read, and the refusal
// is the same join_required answer, which the client turns into Join.
// `selfAppSlug` names the platform's own app (config.selfAppSlug). Null for
// any other conversation, an admin, or a platform row that is missing.
async function generalNeedsJoin(pool, conversationId, user, selfAppSlug) {
  if (!user || user.isAdmin || !selfAppSlug) return null;
  const { rows: room } = await pool.query(
    `SELECT 1 FROM conversations
      WHERE id = $1 AND kind = 'channel' AND channel_key = 'general'`,
    [conversationId]
  );
  if (!room.length) return null;
  const { rows } = await pool.query(
    `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.slug = $1`,
    [selfAppSlug, user.id]
  );
  const app = rows[0];
  return (await refusesToJoin(pool, app, user)) ? joinRequiredBody(app) : null;
}

// The platform's own project discussion was its channel until #general
// became the Homeroom community's. It is kept, read-only: people read it
// and nobody posts in its main stream or its reply threads (a proposal's or
// a request's own thread is not the channel and stays open).
async function channelArchived(pool, appId) {
  if (!appId) return false;
  const { rows } = await pool.query('SELECT self_hosted FROM apps WHERE id = $1', [appId]);
  return rows[0]?.self_hosted === true;
}

const CHANNEL_MOVED = 'This discussion is read-only now: Homeroom\'s channel is #general.';

// For session-addressed routes (/api/sessions/:id/...): proposing, voting,
// cloning a headless run. The rules every gate here shares are stated once,
// on this one. Each answers only "has the caller joined": a caller without
// collab access falls through to whichever guard or route refuses them, so
// a gate is safe on either side of appAccess.sessionCollabGuard.
//
// Admins pass, as they pass every access check: they are who the
// screenshot and proposal-checks runners sign in as.
//
// FAILS OPEN on an app with no community. schema.sql gives every app one
// (a trigger on insert, a backfill for the rest), so this is a row caught
// between the two on its first boot — and refusing every vote on it would
// be a regression nobody asked for. A missing session falls through to the
// route's own 404, as the collab guard's does.
//
// And the third: someone who may not build here at all is the collab
// guard's to refuse, with its existence-hiding 404. Answering them with a
// 403 that names the app would disclose a private one — and the CLI handoff
// router mounts this ahead of the guard, so no gate here assumes the guard
// already ran.
function requireSessionMembership(pool) {
  return gate(pool, async (req) => {
    // A malformed id falls through without a query: every mount answers it
    // with 404 (the collab guard, or the handoff route's own id check).
    const id = positiveId(req.params.id);
    if (!id) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS} FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [id, req.user?.id || null]
    );
    const row = rows[0] || null;
    // The Homeroom bot proposing what it built on an app in its live list
    // (app-access.isBotOwnSession): an admin's listing is its standing
    // there, not membership. Only a request carrying the marker is asked,
    // and for it there is no app to refuse.
    if (row && req.user?.[appAccess.HOMEROOM_BOT_PROPOSAL]
        && await appAccess.isBotOwnSession(pool, req.user, id)) return null;
    return row;
  }, 'session');
}

// The members the community card shows by name: most recent first, capped.
// Names only — the roster with roles and invites is the Members & approvals
// dialog's, which this card opens.
async function listMembers(pool, appId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, m.source, m.joined_at
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
       JOIN users u ON u.id = m.user_id
      WHERE a.id = $1
      ORDER BY (m.source = 'creator') DESC, m.joined_at DESC, u.id
      LIMIT $2`,
    [appId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name || null,
    source: r.source,
  }));
}

// The community's channel — the app's general discussion (`chat_messages`
// with a null thread type) — as the community card's one row for it: the
// last thing said, by whom, and how many messages from others arrived since
// the viewer last read it. The same three facts, with the same exclusions
// (deleted messages, people the viewer has blocked), as the per-app rows
// src/routes/messages-overview.js used to put in the Messages list, which
// this row replaces. Unread is 0 without a read cursor, as it is there:
// a viewer who has never opened the channel has no "since".
async function channelSummary(pool, appId, userId) {
  // The newest few, for the hub's preview; the newest of them is the row's
  // "last thing said" as before.
  const { rows: latest } = await pool.query(
    `SELECT m.id, m.content, m.created_at, u.username
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.user_id
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 3`,
    [appId, userId || null]
  );
  const { rows: unread } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM chat_messages m
       JOIN app_chat_reads rc ON rc.app_id = m.app_id AND rc.user_id = $2
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.id > rc.last_read_message_id
        AND m.deleted_at IS NULL
        AND m.user_id IS NOT NULL AND m.user_id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.user_id
        )`,
    [appId, userId || null]
  );
  const last = latest[0] || null;
  return {
    last_message: last ? last.content : null,
    last_at: last ? last.created_at : null,
    last_by: last ? last.username || null : null,
    unread_count: unread[0]?.n || 0,
    recent: recentRows(latest),
  };
}

// Oldest first, as a transcript reads.
function recentRows(rows) {
  return rows.slice().reverse().map((r) => ({
    id: Number(r.id),
    content: r.content || '',
    created_at: r.created_at,
    by: r.username || null,
  }));
}

// #general, as the Homeroom community's channel: the platform's one
// channel (`conversations`, kind 'channel', key 'general') is the room the
// platform's own project talks in. The same three facts as channelSummary,
// read from that domain's tables with its own rules: main stream only, no
// deleted message, nobody the viewer blocked, and unread behind the
// viewer's read cursor (a viewer who has never opened it has none). Null
// when the room does not exist, which a fresh database seeds it with.
async function generalChannelSummary(pool, userId) {
  const { rows: room } = await pool.query(
    `SELECT id FROM conversations
      WHERE kind = 'channel' AND channel_key = 'general' AND status = 'active'
      LIMIT 1`
  );
  if (!room[0]) return null;
  const conversationId = room[0].id;
  const { rows: latest } = await pool.query(
    `SELECT m.id, m.content, m.created_at, u.username
       FROM conversation_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        AND m.thread_root_id IS NULL
        AND m.deleted_at IS NULL
        AND m.msg_type = 'message'
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.sender_id
        )
      ORDER BY m.id DESC
      LIMIT 3`,
    [conversationId, userId || null]
  );
  let unreadCount = 0;
  if (userId) {
    const { rows: unread } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM conversation_members cm
         JOIN conversation_messages m ON m.conversation_id = cm.conversation_id
        WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND cm.status = 'member'
          AND m.id > COALESCE(cm.last_read_message_id, 0)
          AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
          AND m.msg_type = 'message'
          AND m.sender_id IS DISTINCT FROM $2
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks blocked
             WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.sender_id
          )`,
      [conversationId, userId]
    );
    unreadCount = unread[0]?.n || 0;
  }
  const last = latest[0] || null;
  return {
    conversation_id: conversationId,
    last_message: last ? last.content : null,
    last_at: last ? last.created_at : null,
    last_by: last ? last.username || null : null,
    unread_count: unreadCount,
    recent: recentRows(latest),
  };
}

// How many people did something here this week and how many changes went
// live in the last thirty days, as numbers alone: the hub's people row reads
// them with the names below, and a visitor's page (services/public-project.js)
// reads them without any name.
async function activityCounts(pool, appId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(DISTINCT who.user_id)::int FROM (
          SELECT m.user_id FROM chat_messages m
           WHERE m.app_id = $1 AND m.user_id IS NOT NULL
             AND m.created_at > NOW() - INTERVAL '7 days'
          UNION
          SELECT s.user_id FROM chat_sessions s
           WHERE s.app_id = $1 AND s.user_id IS NOT NULL
             AND s.created_at > NOW() - INTERVAL '7 days'
          UNION
          SELECT v.user_id FROM pr_votes v
            JOIN chat_sessions s ON s.id = v.session_id
           WHERE s.app_id = $1 AND v.user_id IS NOT NULL
             AND v.created_at > NOW() - INTERVAL '7 days'
        ) who JOIN users u ON u.id = who.user_id AND u.is_synthetic IS NOT TRUE) AS active_week,
       (SELECT COUNT(*)::int FROM chat_sessions s
         WHERE s.app_id = $1 AND s.status = 'merged'
           AND COALESCE(s.merged_at, s.created_at) > NOW() - INTERVAL '30 days') AS shipped_month`,
    [appId]
  );
  return {
    active_week: rows[0]?.active_week || 0,
    shipped_month: rows[0]?.shipped_month || 0,
  };
}

// The hub's people row: how many people did something here this week (said
// something in the channel, started a change, or voted on one) and up to
// five of them by name; also each of the last fourteen days, and how many
// changes shipped in the last thirty days. People only: a synthetic account
// (the Homeroom bot, which opens changes and, since #3288, posts ordinary
// messages) is never counted or named as somebody active here.
async function activitySummary(pool, appId) {
  // THE TREND: people active on each of the last fourteen days, oldest
  // first, the same three kinds of taking part as the week's count. Days
  // with nobody are zero rather than missing, so the bars keep their places.
  const { rows: days } = await pool.query(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(DISTINCT who.user_id)::int AS n
       FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, INTERVAL '1 day') AS d(day)
       LEFT JOIN (SELECT w.user_id, w.day FROM (
         SELECT m.user_id, m.created_at::date AS day FROM chat_messages m
          WHERE m.app_id = $1 AND m.user_id IS NOT NULL
            AND m.created_at >= CURRENT_DATE - 13
         UNION
         SELECT s.user_id, s.created_at::date FROM chat_sessions s
          WHERE s.app_id = $1 AND s.user_id IS NOT NULL
            AND s.created_at >= CURRENT_DATE - 13
         UNION
         SELECT v.user_id, v.created_at::date FROM pr_votes v
           JOIN chat_sessions s ON s.id = v.session_id
          WHERE s.app_id = $1 AND v.user_id IS NOT NULL
            AND v.created_at >= CURRENT_DATE - 13
       ) w JOIN users u ON u.id = w.user_id AND u.is_synthetic IS NOT TRUE
       ) who ON who.day = d.day::date
      GROUP BY d.day
      ORDER BY d.day`,
    [appId]
  );
  const counts = await activityCounts(pool, appId);
  // WHO, BY NAME: the hub's faces row ("evan, talha, zura and 35 more"),
  // up to five of the people the week's count counts, the most recently
  // active first. The same three kinds of taking part over the same seven
  // days, and the same people-only join, so a name here is always one of
  // `active_week`.
  const { rows: people } = await pool.query(
    `SELECT u.id, u.username, u.display_name
       FROM (
         SELECT m.user_id, m.created_at AS at FROM chat_messages m
          WHERE m.app_id = $1 AND m.user_id IS NOT NULL
            AND m.created_at > NOW() - INTERVAL '7 days'
         UNION ALL
         SELECT s.user_id, s.created_at FROM chat_sessions s
          WHERE s.app_id = $1 AND s.user_id IS NOT NULL
            AND s.created_at > NOW() - INTERVAL '7 days'
         UNION ALL
         SELECT v.user_id, v.created_at FROM pr_votes v
           JOIN chat_sessions s ON s.id = v.session_id
          WHERE s.app_id = $1 AND v.user_id IS NOT NULL
            AND v.created_at > NOW() - INTERVAL '7 days'
       ) who JOIN users u ON u.id = who.user_id AND u.is_synthetic IS NOT TRUE
      GROUP BY u.id, u.username, u.display_name
      ORDER BY MAX(who.at) DESC, u.id
      LIMIT $2`,
    [appId, ACTIVE_PEOPLE_SHOWN]
  );
  return {
    ...counts,
    daily: days.map((d) => ({ day: d.day, n: d.n })),
    active_people: people.map((p) => ({ id: p.id, username: p.username, display_name: p.display_name || null })),
  };
}

// How many of the week's people the hub names (its faces row).
const ACTIVE_PEOPLE_SHOWN = 5;

// UNCHOSEN COMMUNITIES: the ones whose votes do not put a number on the
// Communities tab for this viewer (5 Oct 2026).
//
// Every account with platform access is put in the platform's own
// community, Homeroom, the moment it is let in (`source = 'auto'`, the
// users_join_platform_community trigger in schema.sql), and every change
// proposed to the platform is a vote it owes from then on. So a brand-new
// account that had joined nothing and been asked nothing opened its first
// session under an accent "5" or "8" on the Communities tab: a number that
// asked for it, about a community it never chose, competing with "What do
// you want to make?".
//
// A community is UNCHOSEN when the viewer is in it only that way, by
// 'auto', and has not yet TAKEN PART in it: no vote on one of its changes
// or decisions, no change of their own there, no request or decision they
// filed, no message in its channel (Homeroom's is #general; its old
// project discussion counts too), and no pin of it on Home. The first of
// any of those is the person choosing it, and from then on its votes count
// on the tab like any other community's. The membership source alone is
// not enough: the one-time backfill wrote 'auto' for every existing account
// it had no other reason for, people who had voted there long before
// included.
//
// A pin is the stake the bell already reads for Homeroom: its "come and
// vote" ping and the daily vote digest go to the platform's creator and
// pinners only (services/notifications.js createPrProposedNotifications,
// services/vote-digest.js), so a newcomer's bell never carried these votes
// and the tab now agrees with it.
//
// Joining by hand (Join, an invite link) writes 'joined', never 'auto', and
// creating, collaborating and pinning write their own sources, so a
// community somebody chose is never unchosen; leaving Homeroom and joining
// it again is choosing it too. This changes ONLY the tab's count
// (frontend/src/features/workshop/community-scope.ts `tabVotes`): the votes
// stay in Needs you, on the Communities list, in the switcher and on the
// community's own page, where the person goes to look.
const UNCHOSEN_COMMUNITIES_SQL = `
  SELECT a.slug
    FROM community_members m
    JOIN apps a ON a.community_id = m.community_id
   WHERE m.user_id = $1
     AND m.source = 'auto'
     AND NOT EXISTS (SELECT 1 FROM pr_votes v JOIN chat_sessions s ON s.id = v.session_id
                      WHERE v.user_id = $1 AND s.app_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM issue_votes v JOIN issues i ON i.id = v.issue_id
                      WHERE v.user_id = $1 AND i.app_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.user_id = $1 AND s.app_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.created_by = $1 AND i.app_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM chat_messages c WHERE c.user_id = $1 AND c.app_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM app_favorites f
                      WHERE f.user_id = $1 AND f.app_id = a.id AND NOT f.hidden)
     AND NOT (a.self_hosted AND EXISTS (
           SELECT 1 FROM conversations g
             JOIN conversation_messages gm ON gm.conversation_id = g.id
            WHERE g.kind = 'channel' AND g.channel_key = 'general' AND gm.sender_id = $1))
`;

/** The slugs of the viewer's unchosen communities (UNCHOSEN_COMMUNITIES_SQL), as a Set. */
async function unchosenCommunities(pool, userId) {
  if (!userId) return new Set();
  const { rows } = await pool.query(UNCHOSEN_COMMUNITIES_SQL, [userId]);
  return new Set(rows.map((row) => row.slug));
}

module.exports = {
  appNeedsJoin,
  channelSummary,
  generalChannelSummary,
  activitySummary,
  activityCounts,
  generalNeedsJoin,
  channelArchived,
  CHANNEL_MOVED,
  AUDIENCES,
  AUDIENCE_LABELS,
  privateVoteRefusal,
  identityVoteRefusal,
  identityPublicRefusal,
  audienceSql,
  isMember,
  getMembership,
  join,
  leave,
  joinRequiredBody,
  requireAppMembership,
  requireSessionMembership,
  requireIssueMembership,
  chatNeedsJoin,
  listMembers,
  UNCHOSEN_COMMUNITIES_SQL,
  unchosenCommunities,
};
