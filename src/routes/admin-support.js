// Admin Support (#admin/support) — everything an admin needs to answer a
// participant's question about their account, on one screen: who they are,
// where their points came from, which events and seasons they are in, the
// kudos they gave and received, where they stand on both leaderboards, and
// a merged timeline of what they did.
//
// READ-ONLY BY DEFAULT. Every GET here is open to any admin (full or
// view-only), the same visibility the Users details view has. The only two
// writes are the points adjustment (A1) and its reversal (A2), both behind
// requireAdminWrite, both append-only: they add `user_activities` rows and
// never edit or delete one, and each leaves a `support_actions` row naming
// who did it and why.
//
// CREDENTIALS NEVER LEAVE THIS FILE, because they never enter it. Every
// query names its columns; nothing selects `users.*`, `onchain_accounts.*`
// or anything under the `credentials` schema. The columns that must never
// appear (password, the Anthropic key pair, the wallet-link token, an
// onchain account's secret key, the OpenRouter hash) are pinned absent by
// tests/admin-support-routes.test.js.
//
// Opening a user's support view writes a `view` row to support_actions (one
// per admin, per user, per hour) so staff access to personal data leaves an
// audit trail the user's Support history shows.
'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const limits = require('../services/limits');
const { computeOwnStanding } = require('../services/topochain/standings');
const { rankedUsers, weekStartUtc } = require('../services/leaderboard-users');
const {
  WEEKLY_KUDOS_LIMIT,
  WEEKLY_BOUNTY_LIMIT,
  countWeeklyKudosUsed,
  countWeeklyBountiesUsed,
} = require('../services/bounties');
const { ACTIVITY_SELECT, formatActivityRow } = require('./topochain/admin/user-activities');
const { iso, num } = require('./topochain/helpers');

const SEARCH_LIMIT = 20;
const PAGE = 50;
const LIST_LIMIT = 100;
const MAX_ADJUSTMENT = 100000;
const MIN_REASON = 10;
const MAX_REASON = 1000;
const MAX_TICKET = 200;

// Analytics event types the timeline shows, by filter chip. Everything else
// in `events` (sync_main, platform_env_changed, db_exported, …) is platform
// bookkeeping, not something a participant did. kudos_given and
// bounty_created are left out on purpose: the timeline reads those from
// pr_kudos and issue_bounties directly, which carry the proposal and status.
const PROPOSAL_EVENT_TYPES = [
  'pr_opened', 'pr_promoted', 'pr_merged', 'pr_vote_cast', 'pr_vote_received', 'dev_session_started',
];
const ACCOUNT_EVENT_TYPES = [
  'app_created', 'username_changed', 'collab_joined', 'approver_joined', 'chat_message_sent', 'dapp_active_day',
];
const TIMELINE_TYPES = ['all', 'points', 'kudos', 'proposals', 'account'];

function toId(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ILIKE treats % and _ as wildcards; a pasted address or handle means them
// literally.
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function eventStatus(startsAt, endsAt, now = Date.now()) {
  const s = startsAt ? new Date(startsAt).getTime() : null;
  const e = endsAt ? new Date(endsAt).getTime() : null;
  if (s != null && now < s) return 'upcoming';
  if (e != null && now > e) return 'ended';
  return 'running';
}

// The header's columns, named one by one. This list IS the credential
// boundary for the `users` table.
const HEADER_SQL = `
  SELECT u.id, u.username, u.display_name, u.email, u.telegram, u.discord,
         u.created_at, u.is_admin, u.admin_readonly, u.usernode_pubkey, u.exclude_podium,
         EXISTS (SELECT 1 FROM user_social_identities gh WHERE gh.user_id = u.id AND gh.provider = 'github') AS has_github,
         EXISTS (SELECT 1 FROM user_social_identities xi WHERE xi.user_id = u.id AND xi.provider = 'x') AS has_x,
         EXISTS (SELECT 1 FROM user_activities zk WHERE zk.user_id = u.id AND zk.source = 'zkpassport') AS has_zkpassport
    FROM users u
   WHERE u.id = $1`;

async function loadHeader(pool, id) {
  const { rows } = await pool.query(HEADER_SQL, [id]);
  const u = rows[0];
  if (!u) return null;
  const [{ rows: history }, { rows: deletion }] = await Promise.all([
    pool.query(
      `SELECT username, changed_at FROM username_history WHERE user_id = $1 ORDER BY changed_at DESC LIMIT 20`,
      [id]
    ),
    pool.query(`SELECT created_at, completed_at FROM account_deletions WHERE user_id = $1`, [id]),
  ]);
  const role = !u.is_admin ? 'user' : (u.admin_readonly ? 'view_admin' : 'admin');
  return {
    id: Number(u.id),
    username: u.username,
    display_name: u.display_name,
    email: u.email,
    telegram: u.telegram,
    discord: u.discord,
    created_at: iso(u.created_at),
    role,
    identity_tier: limits.identityTierFromFlags(u).tier,
    wallet: u.usernode_pubkey || null,
    exclude_podium: !!u.exclude_podium,
    previous_usernames: history.map((h) => ({ username: h.username, changed_at: iso(h.changed_at) })),
    deletion_requested_at: deletion[0] ? iso(deletion[0].created_at) : null,
  };
}

// Points per event: the ledger (user_activities) beside the latest
// leaderboard snapshot for the same event. The two disagree until the next
// aggregate, which is the most common "my points are missing" answer, so
// both numbers and the snapshot time go to the screen.
const POINTS_BY_EVENT_SQL = `
  WITH ledger AS (
    SELECT season_event_id, SUM(points) AS points, COUNT(*)::int AS n
      FROM user_activities WHERE user_id = $1 GROUP BY season_event_id
  ),
  snap AS (
    SELECT DISTINCT ON (season_event_id) season_event_id, rank, total_points, extra_points, snapshot_at
      FROM leaderboard_snapshots WHERE user_id = $1
     ORDER BY season_event_id, snapshot_at DESC, id DESC
  ),
  ids AS (SELECT season_event_id FROM ledger UNION SELECT season_event_id FROM snap)
  SELECT se.id AS season_event_id, se.name AS event_name, se.starts_at, se.ends_at,
         se.display_leaderboard, se.internal, se.season_id, s.name AS season_name,
         l.points AS ledger_points, COALESCE(l.n, 0) AS activity_count,
         sn.rank, sn.total_points AS leaderboard_points, sn.extra_points, sn.snapshot_at,
         EXISTS (
           SELECT 1 FROM user_enrollments ue
            WHERE ue.user_id = $1
              AND (ue.season_event_id = se.id OR (ue.season_event_id IS NULL AND ue.season_id = se.season_id))
         ) AS enrolled
    FROM ids
    JOIN season_events se ON se.id = ids.season_event_id
    LEFT JOIN seasons s ON s.id = se.season_id
    LEFT JOIN ledger l ON l.season_event_id = se.id
    LEFT JOIN snap sn ON sn.season_event_id = se.id
   ORDER BY se.starts_at DESC, se.id DESC`;

const ENROLLMENTS_SQL = `
  SELECT ue.id, ue.season_id, s.name AS season_name, s.starts_at AS season_starts_at, s.ends_at AS season_ends_at,
         ue.season_event_id, se.name AS event_name, se.starts_at, se.ends_at, ue.registered_at
    FROM user_enrollments ue
    JOIN seasons s ON s.id = ue.season_id
    LEFT JOIN season_events se ON se.id = ue.season_event_id
   WHERE ue.user_id = $1
   ORDER BY COALESCE(se.starts_at, s.starts_at) DESC, ue.id DESC`;

// Deliberately NOT public_key / secret_key / registration_code.
const ONCHAIN_SQL = `
  SELECT oa.id, oa.address, oa.tier, oa.is_used, oa.used_at, oa.season_id, s.name AS season_name,
         oa.season_event_id, se.name AS event_name
    FROM onchain_accounts oa
    LEFT JOIN seasons s ON s.id = oa.season_id
    LEFT JOIN season_events se ON se.id = oa.season_event_id
   WHERE oa.user_id = $1
   ORDER BY oa.id DESC`;

const KUDOS_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*)::int FROM pr_kudos pk JOIN chat_sessions cs ON cs.id = pk.session_id WHERE cs.user_id = $1) AS kudos_received,
    (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_user_id = $1 AND status = 'awarded') AS bounties_received,
    (SELECT COUNT(*)::int FROM pr_kudos WHERE giver_user_id = $1) AS kudos_given,
    (SELECT COUNT(*)::int FROM issue_bounties WHERE giver_user_id = $1) AS bounties_given`;

async function kudosRank(pool, id, window) {
  const rows = await rankedUsers(pool, { window, slim: true });
  const idx = rows.findIndex((r) => Number(r.user_id) === id);
  return idx >= 0 ? { rank: idx + 1, of: rows.length } : null;
}

// One `view` row per (admin, user, hour): enough to answer "who looked at
// this account and when" without a row per re-render.
async function recordView(pool, actorId, targetId) {
  await pool.query(
    `INSERT INTO support_actions (actor_user_id, target_user_id, action, created_at)
     SELECT $1, $2, 'view', NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM support_actions
         WHERE actor_user_id = $1 AND target_user_id = $2 AND action = 'view'
           AND created_at > NOW() - INTERVAL '1 hour'
      )`,
    [actorId, targetId]
  );
}

function timelineArms(type) {
  const arms = [];
  const want = (k) => type === 'all' || type === k;
  if (want('points')) {
    arms.push(`
      SELECT ua.activity_at AS at, 'points' AS kind, ua.source AS type, ua.points AS points,
             COALESCE(c.goal, ct.goal, ua.description, ua.activity_type) AS title,
             se.name AS detail, NULL::text AS app_name, NULL::text AS app_slug
        FROM user_activities ua
        JOIN season_events se ON se.id = ua.season_event_id
        LEFT JOIN challenges c ON c.id = ua.challenge_id
        LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
       WHERE ua.user_id = $1`);
  }
  if (want('kudos')) {
    arms.push(`
      SELECT pk.created_at, 'kudos', 'kudos_given', NULL::numeric, cs.pr_title, au.username, a.name, a.slug
        FROM pr_kudos pk
        JOIN chat_sessions cs ON cs.id = pk.session_id
        LEFT JOIN users au ON au.id = cs.user_id
        LEFT JOIN apps a ON a.id = cs.app_id
       WHERE pk.giver_user_id = $1`);
    arms.push(`
      SELECT pk.created_at, 'kudos', 'kudos_received', NULL::numeric, cs.pr_title, g.username, a.name, a.slug
        FROM pr_kudos pk
        JOIN chat_sessions cs ON cs.id = pk.session_id
        LEFT JOIN users g ON g.id = pk.giver_user_id
        LEFT JOIN apps a ON a.id = cs.app_id
       WHERE cs.user_id = $1`);
    arms.push(`
      SELECT ib.created_at, 'kudos', 'bounty_pledged', NULL::numeric,
             'Issue #' || ib.github_issue_number, ib.status, a.name, a.slug
        FROM issue_bounties ib
        LEFT JOIN apps a ON a.id = ib.app_id
       WHERE ib.giver_user_id = $1`);
    arms.push(`
      SELECT ib.awarded_at, 'kudos', 'bounty_awarded', NULL::numeric,
             'Issue #' || ib.github_issue_number, g.username, a.name, a.slug
        FROM issue_bounties ib
        LEFT JOIN users g ON g.id = ib.giver_user_id
        LEFT JOIN apps a ON a.id = ib.app_id
       WHERE ib.awarded_user_id = $1 AND ib.status = 'awarded'`);
  }
  if (want('proposals')) {
    arms.push(`
      SELECT e.created_at, 'proposals', e.event_type, NULL::numeric,
             cs.pr_title, COALESCE(e.metadata->>'prNumber', e.metadata->>'vote'), a.name, a.slug
        FROM events e
        LEFT JOIN chat_sessions cs ON cs.id = e.session_id
        LEFT JOIN apps a ON a.id = e.app_id
       WHERE e.user_id = $1 AND e.event_type = ANY('{${PROPOSAL_EVENT_TYPES.join(',')}}'::text[])`);
  }
  if (want('account')) {
    arms.push(`
      SELECT e.created_at, 'account', e.event_type, NULL::numeric,
             e.metadata->>'from', e.metadata->>'to', a.name, a.slug
        FROM events e
        LEFT JOIN apps a ON a.id = e.app_id
       WHERE e.user_id = $1 AND e.event_type = ANY('{${ACCOUNT_EVENT_TYPES.join(',')}}'::text[])`);
    arms.push(`
      SELECT ue.registered_at, 'account', 'enrolled', NULL::numeric,
             COALESCE(se.name, s.name), CASE WHEN ue.season_event_id IS NULL THEN 'season' ELSE 'event' END,
             NULL::text, NULL::text
        FROM user_enrollments ue
        JOIN seasons s ON s.id = ue.season_id
        LEFT JOIN season_events se ON se.id = ue.season_event_id
       WHERE ue.user_id = $1`);
  }
  return arms;
}

function formatAction(r) {
  return {
    id: Number(r.id),
    action: r.action,
    reason: r.reason,
    payload: r.payload || null,
    created_at: iso(r.created_at),
    actor: r.actor_user_id != null ? { id: Number(r.actor_user_id), username: r.actor_username } : null,
  };
}

function adminSupportRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use('/api/admin/support', adminMiddleware);

  // ── Search ────────────────────────────────────────────────────────────
  router.get('/api/admin/support/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const asId = /^\d+$/.test(q) ? toId(q) : null;
    if (!asId && q.length < 3) {
      return res.status(400).json({ error: 'Type at least 3 characters, or a user id.' });
    }
    const pattern = q.length >= 3 ? likePattern(q) : null;
    try {
      const { rows } = await pool.query(
        `WITH m AS (
           SELECT id AS user_id, 'id' AS matched_on, 0 AS prio FROM users WHERE $2::int IS NOT NULL AND id = $2
           UNION ALL SELECT id, 'username', 1 FROM users WHERE $1::text IS NOT NULL AND username ILIKE $1
           UNION ALL SELECT user_id, 'previous_username', 2 FROM username_history WHERE $1::text IS NOT NULL AND username ILIKE $1
           UNION ALL SELECT id, 'email', 3 FROM users WHERE $1::text IS NOT NULL AND email ILIKE $1
           UNION ALL SELECT id, 'telegram', 3 FROM users WHERE $1::text IS NOT NULL AND telegram ILIKE $1
           UNION ALL SELECT id, 'discord', 3 FROM users WHERE $1::text IS NOT NULL AND discord ILIKE $1
           UNION ALL SELECT id, 'display_name', 3 FROM users WHERE $1::text IS NOT NULL AND display_name ILIKE $1
           UNION ALL SELECT id, 'wallet', 4 FROM users WHERE $1::text IS NOT NULL AND usernode_pubkey ILIKE $1
           UNION ALL SELECT user_id, 'onchain_account', 4 FROM onchain_accounts
                      WHERE $1::text IS NOT NULL AND user_id IS NOT NULL AND (address ILIKE $1 OR public_key ILIKE $1)
         ),
         best AS (
           SELECT DISTINCT ON (user_id) user_id, matched_on, prio FROM m ORDER BY user_id, prio
         )
         SELECT u.id, u.username, u.display_name, u.created_at, b.matched_on
           FROM best b JOIN users u ON u.id = b.user_id
          ORDER BY b.prio, u.username
          LIMIT ${SEARCH_LIMIT}`,
        [pattern, asId]
      );
      res.json({
        results: rows.map((r) => ({
          id: Number(r.id),
          username: r.username,
          display_name: r.display_name,
          created_at: iso(r.created_at),
          matched_on: r.matched_on,
        })),
      });
    } catch (err) {
      log.error('admin-support', 'Search failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── The summary bundle ────────────────────────────────────────────────
  router.get('/api/admin/support/users/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    try {
      const header = await loadHeader(pool, id);
      if (!header) return res.status(404).json({ error: 'User not found.' });

      const weekStart = weekStartUtc();
      const [
        { rows: byEvent }, { rows: enrollments }, { rows: onchain }, { rows: kudosCounts },
        { rows: lastActive }, standing, kudosUsed, bountiesUsed, kudosWeek, kudosAll,
      ] = await Promise.all([
        pool.query(POINTS_BY_EVENT_SQL, [id]),
        pool.query(ENROLLMENTS_SQL, [id]),
        pool.query(ONCHAIN_SQL, [id]),
        pool.query(KUDOS_COUNTS_SQL, [id]),
        pool.query(`SELECT MAX(created_at) AS at FROM events WHERE user_id = $1`, [id]),
        computeOwnStanding(pool, { seasonId: null, userId: id }),
        countWeeklyKudosUsed(pool, id, weekStart),
        countWeeklyBountiesUsed(pool, id, weekStart),
        kudosRank(pool, id, 'week'),
        kudosRank(pool, id, 'all'),
      ]);

      try { await recordView(pool, req.user.id, id); } catch (err) {
        log.warn('admin-support', 'View audit write failed', { id, message: err.message });
      }

      const k = kudosCounts[0] || {};
      const points = byEvent.map((r) => ({
        season_event_id: Number(r.season_event_id),
        event_name: r.event_name,
        season_id: r.season_id != null ? Number(r.season_id) : null,
        season_name: r.season_name,
        starts_at: iso(r.starts_at),
        ends_at: iso(r.ends_at),
        status: eventStatus(r.starts_at, r.ends_at),
        internal: !!r.internal,
        display_leaderboard: !!r.display_leaderboard,
        ledger_points: num(r.ledger_points) ?? 0,
        activity_count: Number(r.activity_count) || 0,
        leaderboard_points: num(r.leaderboard_points),
        extra_points: num(r.extra_points),
        rank: r.rank != null ? Number(r.rank) : null,
        snapshot_at: iso(r.snapshot_at),
        enrolled: !!r.enrolled,
      }));
      const ledgerTotal = points.reduce((sum, p) => sum + p.ledger_points, 0);

      res.json({
        user: header,
        glance: {
          total_points: standing.own ? standing.own.total_points : 0,
          ledger_points: Math.round(ledgerTotal * 100) / 100,
          all_time_rank: standing.own ? standing.own.rank : null,
          participants: standing.totalParticipants,
          events_joined: standing.own ? standing.own.events_participated : 0,
          kudos_received: (k.kudos_received || 0) + (k.bounties_received || 0),
          last_active: lastActive[0] ? iso(lastActive[0].at) : null,
        },
        points,
        enrollments: enrollments.map((r) => ({
          id: Number(r.id),
          scope: r.season_event_id == null ? 'season' : 'event',
          season_id: Number(r.season_id),
          season_name: r.season_name,
          season_event_id: r.season_event_id != null ? Number(r.season_event_id) : null,
          event_name: r.event_name,
          starts_at: iso(r.season_event_id == null ? r.season_starts_at : r.starts_at),
          ends_at: iso(r.season_event_id == null ? r.season_ends_at : r.ends_at),
          status: r.season_event_id == null
            ? eventStatus(r.season_starts_at, r.season_ends_at)
            : eventStatus(r.starts_at, r.ends_at),
          registered_at: iso(r.registered_at),
        })),
        onchain_accounts: onchain.map((r) => ({
          id: Number(r.id),
          address: r.address,
          tier: r.tier,
          is_used: !!r.is_used,
          used_at: iso(r.used_at),
          season_id: r.season_id != null ? Number(r.season_id) : null,
          season_name: r.season_name,
          season_event_id: r.season_event_id != null ? Number(r.season_event_id) : null,
          event_name: r.event_name,
        })),
        kudos: {
          received: k.kudos_received || 0,
          bounties_received: k.bounties_received || 0,
          given: k.kudos_given || 0,
          bounties_given: k.bounties_given || 0,
          week: { kudos_used: kudosUsed, kudos_limit: WEEKLY_KUDOS_LIMIT, bounties_used: bountiesUsed, bounties_limit: WEEKLY_BOUNTY_LIMIT },
        },
        leaderboard: {
          programme: standing.own ? {
            rank: standing.own.rank,
            total_points: standing.own.total_points,
            extra_points: standing.own.extra_points,
            events_participated: standing.own.events_participated,
            participants: standing.totalParticipants,
          } : null,
          kudos_week: kudosWeek,
          kudos_all: kudosAll,
        },
      });
    } catch (err) {
      log.error('admin-support', 'Summary failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Points history ────────────────────────────────────────────────────
  router.get('/api/admin/support/users/:id/points', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    const eventId = req.query.season_event_id ? toId(req.query.season_event_id) : null;
    const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
    try {
      const params = [id];
      let where = 'WHERE ua.user_id = $1';
      if (eventId) { params.push(eventId); where += ` AND ua.season_event_id = $${params.length}`; }
      params.push(PAGE + 1, (page - 1) * PAGE);
      const [{ rows }, { rows: reversed }] = await Promise.all([
        pool.query(
          `${ACTIVITY_SELECT} ${where}
            ORDER BY ua.activity_at DESC, ua.id DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        ),
        pool.query(
          `SELECT metadata->>'reverses' AS id FROM user_activities
            WHERE user_id = $1 AND source = 'support_adjustment' AND metadata ? 'reverses'`,
          [id]
        ),
      ]);
      const reversedIds = new Set(reversed.map((r) => Number(r.id)));
      res.json({
        activities: rows.slice(0, PAGE).map((r) => {
          const a = formatActivityRow(r);
          // The v4 row carries the user's programme identifiers for the
          // list screen; this screen already has them in the header.
          delete a.user;
          return { ...a, reversed: reversedIds.has(a.id) };
        }),
        has_more: rows.length > PAGE,
        page,
      });
    } catch (err) {
      log.error('admin-support', 'Points history failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Recent activity ───────────────────────────────────────────────────
  router.get('/api/admin/support/users/:id/timeline', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    const type = TIMELINE_TYPES.includes(req.query.types) ? req.query.types : 'all';
    let before = null;
    if (req.query.before) {
      const t = Date.parse(req.query.before);
      if (!Number.isFinite(t)) return res.status(400).json({ error: 'Invalid before timestamp' });
      before = new Date(t).toISOString();
    }
    try {
      const arms = timelineArms(type);
      const { rows } = await pool.query(
        `SELECT * FROM (${arms.join('\n UNION ALL \n')}) AS t(at, kind, type, points, title, detail, app_name, app_slug)
          WHERE t.at IS NOT NULL AND ($2::timestamptz IS NULL OR t.at < $2)
          ORDER BY t.at DESC
          LIMIT $3`,
        [id, before, PAGE]
      );
      const items = rows.map((r) => ({
        at: iso(r.at),
        kind: r.kind,
        type: r.type,
        points: num(r.points),
        title: r.title,
        detail: r.detail,
        app: r.app_slug ? { name: r.app_name, slug: r.app_slug } : null,
      }));
      res.json({ items, nextBefore: items.length === PAGE ? items[items.length - 1].at : null });
    } catch (err) {
      log.error('admin-support', 'Timeline failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Kudos, itemised ───────────────────────────────────────────────────
  router.get('/api/admin/support/users/:id/kudos', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    try {
      const [received, awarded, given, pledged] = await Promise.all([
        pool.query(
          `SELECT pk.created_at AS at, g.username AS other, cs.pr_title AS title, cs.pr_number, a.name AS app_name, a.slug AS app_slug
             FROM pr_kudos pk
             JOIN chat_sessions cs ON cs.id = pk.session_id
             LEFT JOIN users g ON g.id = pk.giver_user_id
             LEFT JOIN apps a ON a.id = cs.app_id
            WHERE cs.user_id = $1
            ORDER BY pk.created_at DESC LIMIT ${LIST_LIMIT}`, [id]),
        pool.query(
          `SELECT ib.awarded_at AS at, g.username AS other, ib.github_issue_number, a.name AS app_name, a.slug AS app_slug
             FROM issue_bounties ib
             LEFT JOIN users g ON g.id = ib.giver_user_id
             LEFT JOIN apps a ON a.id = ib.app_id
            WHERE ib.awarded_user_id = $1 AND ib.status = 'awarded'
            ORDER BY ib.awarded_at DESC LIMIT ${LIST_LIMIT}`, [id]),
        pool.query(
          `SELECT pk.created_at AS at, au.username AS other, cs.pr_title AS title, cs.pr_number, a.name AS app_name, a.slug AS app_slug
             FROM pr_kudos pk
             JOIN chat_sessions cs ON cs.id = pk.session_id
             LEFT JOIN users au ON au.id = cs.user_id
             LEFT JOIN apps a ON a.id = cs.app_id
            WHERE pk.giver_user_id = $1
            ORDER BY pk.created_at DESC LIMIT ${LIST_LIMIT}`, [id]),
        pool.query(
          `SELECT ib.created_at AS at, ib.status, ib.github_issue_number, a.name AS app_name, a.slug AS app_slug
             FROM issue_bounties ib
             LEFT JOIN apps a ON a.id = ib.app_id
            WHERE ib.giver_user_id = $1
            ORDER BY ib.created_at DESC LIMIT ${LIST_LIMIT}`, [id]),
      ]);
      const app = (r) => (r.app_slug ? { name: r.app_name, slug: r.app_slug } : null);
      res.json({
        received: received.rows.map((r) => ({ at: iso(r.at), from: r.other, title: r.title, pr_number: r.pr_number, app: app(r) })),
        bounties_received: awarded.rows.map((r) => ({ at: iso(r.at), from: r.other, issue: r.github_issue_number, app: app(r) })),
        given: given.rows.map((r) => ({ at: iso(r.at), to: r.other, title: r.title, pr_number: r.pr_number, app: app(r) })),
        bounties_given: pledged.rows.map((r) => ({ at: iso(r.at), status: r.status, issue: r.github_issue_number, app: app(r) })),
        limit: LIST_LIMIT,
      });
    } catch (err) {
      log.error('admin-support', 'Kudos failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Support history ───────────────────────────────────────────────────
  router.get('/api/admin/support/users/:id/history', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    try {
      const { rows } = await pool.query(
        `SELECT sa.id, sa.action, sa.reason, sa.payload, sa.created_at, sa.actor_user_id, au.username AS actor_username
           FROM support_actions sa
           LEFT JOIN users au ON au.id = sa.actor_user_id
          WHERE sa.target_user_id = $1
          ORDER BY sa.created_at DESC, sa.id DESC
          LIMIT ${LIST_LIMIT}`,
        [id]
      );
      res.json({ actions: rows.map(formatAction) });
    } catch (err) {
      log.error('admin-support', 'History failed', { id, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Pickers for the adjustment form ───────────────────────────────────
  router.get('/api/admin/support/events', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT se.id, se.name, se.starts_at, se.ends_at, s.name AS season_name
           FROM season_events se LEFT JOIN seasons s ON s.id = se.season_id
          ORDER BY se.starts_at DESC, se.id DESC LIMIT 200`
      );
      res.json({
        events: rows.map((r) => ({
          id: Number(r.id), name: r.name, season_name: r.season_name,
          status: eventStatus(r.starts_at, r.ends_at),
        })),
      });
    } catch (err) {
      log.error('admin-support', 'Events list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/support/challenges', async (req, res) => {
    const eventId = toId(req.query.season_event_id);
    if (!eventId) return res.status(400).json({ error: 'season_event_id is required.' });
    try {
      const { rows } = await pool.query(
        `SELECT c.id, COALESCE(c.goal, ct.goal) AS goal, ct.category
           FROM challenges c LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE c.season_event_id = $1
          ORDER BY c.display_order, c.id`,
        [eventId]
      );
      res.json({ challenges: rows.map((r) => ({ id: Number(r.id), goal: r.goal, category: r.category })) });
    } catch (err) {
      log.error('admin-support', 'Challenges list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── A1: points adjustment ─────────────────────────────────────────────
  //
  // Append-only: one support_actions row (who, why, the inputs) and one
  // user_activities row pointing back at it. The leaderboard picks the
  // credit up at its next aggregate; this route does not trigger one.
  router.post('/api/admin/support/users/:id/points-adjustment', requireAdminWrite, async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found.' });
    const body = req.body || {};
    const eventId = toId(body.season_event_id);
    const challengeId = toId(body.challenge_id);
    const points = Math.round(Number(body.points) * 100) / 100;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const ticket = typeof body.ticket === 'string' && body.ticket.trim() ? body.ticket.trim() : null;
    if (!eventId) return res.status(422).json({ error: 'Choose an event.' });
    if (!challengeId) return res.status(422).json({ error: 'Choose a challenge.' });
    if (!Number.isFinite(points) || points === 0) return res.status(422).json({ error: 'Points must be a number other than 0.' });
    if (Math.abs(points) > MAX_ADJUSTMENT) return res.status(422).json({ error: `Points must be between -${MAX_ADJUSTMENT} and ${MAX_ADJUSTMENT}.` });
    if (reason.length < MIN_REASON) return res.status(422).json({ error: `Give a reason of at least ${MIN_REASON} characters.` });
    if (reason.length > MAX_REASON) return res.status(422).json({ error: `Keep the reason under ${MAX_REASON} characters.` });
    if (ticket && ticket.length > MAX_TICKET) return res.status(422).json({ error: `Keep the ticket reference under ${MAX_TICKET} characters.` });

    let client;
    try {
      client = await pool.connect();
      const { rows: userRows } = await client.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!userRows.length) return res.status(404).json({ error: 'User not found.' });
      const { rows: chRows } = await client.query(
        `SELECT c.id, c.season_event_id, ct.category
           FROM challenges c LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE c.id = $1`,
        [challengeId]
      );
      const challenge = chRows[0];
      if (!challenge || Number(challenge.season_event_id) !== eventId) {
        return res.status(422).json({ error: 'That challenge does not belong to the chosen event.' });
      }

      await client.query('BEGIN');
      try {
        const payload = { season_event_id: eventId, challenge_id: challengeId, points, ticket };
        const { rows: actionRows } = await client.query(
          `INSERT INTO support_actions (actor_user_id, target_user_id, action, reason, payload, created_at)
           VALUES ($1, $2, 'points_adjustment', $3, $4, NOW()) RETURNING id`,
          [req.user.id, id, reason, JSON.stringify(payload)]
        );
        const actionId = Number(actionRows[0].id);
        const { rows: actRows } = await client.query(
          `INSERT INTO user_activities
             (user_id, season_event_id, activity_type, points, description, metadata, activity_at,
              added_by, source, challenge_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, 'support_adjustment', $8, NOW(), NOW())
           RETURNING id`,
          [id, eventId, challenge.category || 'SUPPORT_ADJUSTMENT', points, reason,
            JSON.stringify({ kind: 'support_adjustment', support_action_id: actionId, reason, ticket }),
            req.user.id, challengeId]
        );
        const activityId = Number(actRows[0].id);
        await client.query(
          `UPDATE support_actions SET payload = payload || $2::jsonb WHERE id = $1`,
          [actionId, JSON.stringify({ activity_id: activityId })]
        );
        await client.query('COMMIT');
        res.status(201).json({ ok: true, action_id: actionId, activity_id: activityId });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      log.error('admin-support', 'Points adjustment failed', { id, message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (client) client.release();
    }
  });

  // ── A2: reverse an adjustment ─────────────────────────────────────────
  //
  // An equal and opposite adjustment pointing at the original. The partial
  // unique index on metadata->>'reverses' (schema.sql) makes a second
  // reversal of the same adjustment impossible even under a double click.
  router.post('/api/admin/support/actions/:actionId/reverse', requireAdminWrite, async (req, res) => {
    const actionId = toId(req.params.actionId);
    if (!actionId) return res.status(404).json({ error: 'Adjustment not found.' });
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < MIN_REASON) return res.status(422).json({ error: `Give a reason of at least ${MIN_REASON} characters.` });
    if (reason.length > MAX_REASON) return res.status(422).json({ error: `Keep the reason under ${MAX_REASON} characters.` });

    let client;
    try {
      client = await pool.connect();
      const { rows: actionRows } = await client.query(
        `SELECT id, target_user_id, payload FROM support_actions WHERE id = $1 AND action = 'points_adjustment'`,
        [actionId]
      );
      const action = actionRows[0];
      const activityId = action && action.payload ? toId(action.payload.activity_id) : null;
      if (!action || !activityId) return res.status(404).json({ error: 'Adjustment not found.' });
      const { rows: actRows } = await client.query(
        `SELECT id, user_id, season_event_id, challenge_id, activity_type, points
           FROM user_activities WHERE id = $1 AND source = 'support_adjustment'`,
        [activityId]
      );
      const original = actRows[0];
      if (!original) return res.status(404).json({ error: 'The adjusted points no longer exist.' });
      const { rows: already } = await client.query(
        `SELECT 1 FROM user_activities WHERE source = 'support_adjustment' AND metadata->>'reverses' = $1`,
        [String(activityId)]
      );
      if (already.length) return res.status(409).json({ error: 'This adjustment has already been reversed.' });

      const points = -(num(original.points) || 0);
      await client.query('BEGIN');
      try {
        const { rows: revRows } = await client.query(
          `INSERT INTO support_actions (actor_user_id, target_user_id, action, reason, payload, created_at)
           VALUES ($1, $2, 'points_reversal', $3, $4, NOW()) RETURNING id`,
          [req.user.id, original.user_id, reason,
            JSON.stringify({ reverses_action_id: actionId, reverses_activity_id: activityId, points })]
        );
        const revId = Number(revRows[0].id);
        const { rows: newRows } = await client.query(
          `INSERT INTO user_activities
             (user_id, season_event_id, activity_type, points, description, metadata, activity_at,
              added_by, source, challenge_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, 'support_adjustment', $8, NOW(), NOW())
           RETURNING id`,
          [original.user_id, original.season_event_id, original.activity_type, points, reason,
            JSON.stringify({ kind: 'support_adjustment', support_action_id: revId, reason, reverses: String(activityId) }),
            req.user.id, original.challenge_id]
        );
        await client.query(
          `UPDATE support_actions SET payload = payload || $2::jsonb WHERE id = $1`,
          [revId, JSON.stringify({ activity_id: Number(newRows[0].id) })]
        );
        await client.query('COMMIT');
        res.status(201).json({ ok: true, action_id: revId, activity_id: Number(newRows[0].id) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') return res.status(409).json({ error: 'This adjustment has already been reversed.' });
        throw err;
      }
    } catch (err) {
      log.error('admin-support', 'Reversal failed', { actionId, message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (client) client.release();
    }
  });

  return router;
}

module.exports = { adminSupportRoutes, likePattern, eventStatus, PROPOSAL_EVENT_TYPES, ACCOUNT_EVENT_TYPES };
