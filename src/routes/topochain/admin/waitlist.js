// Topochain v4 admin API — platform waitlist + block-producer queue
// (onboarding flow alignment). Reads are covered by the router-wide
// `adminReadGate` applied in ../admin.js; every mutating route is gated
// by `adminWriteGate`, matching users.js.
//
// Two queues, two release actions:
//   - Platform waitlist (`waitlist_signups`, keyed by EMAIL): "release"
//     marks the row released and grants `has_platform_access` to the
//     linked account if one exists — otherwise the grant happens
//     automatically when the email registers (services/waitlist.js).
//   - Block-producer queue (`users.bp_requested_at`): "release" sets
//     `bp_released_at`, which is what lets the mobile node enable its
//     block producer (surfaced via GET /api/v4/mobile/me).
// Plus a direct per-user access grant for accounts that never joined
// the waitlist.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const waitlist = require('../../../services/waitlist');
const { signalsFor } = require('../../../services/waitlist-signals');
const { sendWaitlistReleaseMail } = require('../../../services/topochain/mailer');
const { adminWriteGate } = require('./auth');
const { toIntId } = require('./util');
const { ok, fail, iso, paginate, meta, csvField } = require('../helpers');

function formatSignup(row) {
  return {
    id: Number(row.id),
    email: row.email,
    submitted_at: iso(row.submitted_at),
    released_at: iso(row.released_at),
    // NULL after a join means the address never followed the confirm link
    // in its mail — it was never proved able to receive mail at all, which
    // is worth seeing before releasing the row.
    confirmed_at: iso(row.confirmed_at),
    linked_user_id: row.linked_user_id != null ? Number(row.linked_user_id) : null,
    linked_username: row.linked_username ?? null,
    has_platform_access: row.has_platform_access ?? null,
    // The other half of the invite graph. `invited_count` (below, via
    // signals) says how many this row brought in; these two say who
    // brought THIS row in, which is the question an admin looking at a
    // referral chain actually has. The address is carried because the id
    // alone is unreadable on a screen that is keyed by email.
    invited_by: row.invited_by != null ? Number(row.invited_by) : null,
    invited_by_email: row.invited_by_email ?? null,
    // What happened to the "you're in" mail for an admitted row. Admitting
    // sends exactly one, and whether it actually left is otherwise
    // invisible here — an admin seeing "Admitted" with no mail behind it
    // was reading a half-finished action as a finished one. Null when
    // nothing was ever recorded, which is also every row in a staging
    // clone (mail_deliveries is staging:private).
    invite_email: row.invite_mail_status
      ? {
        status: row.invite_mail_status,
        created_at: iso(row.invite_mail_at),
        error: row.invite_mail_error ?? null,
      }
      : null,
    // Two-stage survey payload (versioned JSON — stage 1 at join, stage 2
    // merged in via the "Want in sooner?" form). Null for plain-email rows.
    answers: row.answers && typeof row.answers === 'object' ? row.answers : null,
    // What this signup actually DID, derived in one place
    // (services/waitlist-signals.js) so this screen and any future ranking
    // read the same facts. Facts only: there is deliberately no score.
    signals: signalsFor(row),
  };
}

// The `?status=` / `?only=` narrowing, shared by the list and the CSV export
// so a download always holds exactly the rows the screen's filters select.
// Every clause is a fixed literal chosen by an exact match — no request
// text reaches the SQL.
function waitlistWhere(query) {
  const status = typeof query.status === 'string' ? query.status : '';
  const only = typeof query.only === 'string' ? query.only : '';
  const clauses = [];
  if (status === 'pending') clauses.push('w.released_at IS NULL');
  else if (status === 'released') clauses.push('w.released_at IS NOT NULL');
  if (only === 'confirmed') clauses.push('w.confirmed_at IS NOT NULL');
  else if (only === 'invited') {
    clauses.push('EXISTS (SELECT 1 FROM waitlist_signups c WHERE c.invited_by = w.id)');
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// A handle as the file carries it: trimmed, and without a leading `@`
// (people type one into the self-reported fields; X's API never returns
// one), so a column can be matched against a list of handles directly.
function bareHandle(v) {
  return typeof v === 'string' ? v.trim().replace(/^@+/, '') : '';
}

// One export row, in file order (the header is EXPORT_HEADER). A verified
// handle is the one this SIGNUP proved through the waitlist's connect flow
// (answers.verified) first, and otherwise the identity connected on its
// linked ACCOUNT — `x_handle_source` says which, since only the first is
// the waitlist row's own claim.
//
// Every stage-1/stage-2 survey field the signup could have answered gets its
// own column (see services/waitlist-questions.js for the full shape): the
// "group" section covers what they're building and with whom
// (group_name/size/role/tools/need), and "loss" covers the platform-loss
// story (had_loss/loss_product/loss_kind/loss_story). Enum answers (group
// size/role/tools, loss had/kind) are exported as the raw stored code, same
// as `found_us` above, so the file matches what the row actually holds
// rather than a label that can be reworded later.
const EXPORT_HEADER = [
  'signup_id', 'email', 'status', 'signed_up_at', 'confirmed_at', 'admitted_at',
  'x_handle', 'x_handle_source', 'github_handle', 'linkedin_handle',
  'farcaster', 'discord', 'telegram', 'other_handle', 'referred_by_handle',
  'account_username', 'has_platform_access', 'came_from_email', 'brought_in',
  'country', 'city', 'found_us', 'found_us_detail', 'made_url', 'made_note',
  'group_name', 'group_size', 'group_role', 'group_tools', 'group_need',
  'had_loss', 'loss_product', 'loss_kind', 'loss_story', 'followed_claim',
];

function exportRow(r) {
  const a = plainObject(r.answers);
  const verified = plainObject(a.verified);
  const handles = plainObject(a.handles);
  const discovery = plainObject(a.discovery);
  const group = plainObject(a.group);
  const loss = plainObject(a.loss);
  const signupX = bareHandle(verified.x);
  const accountX = bareHandle(r.account_x_handle);
  return [
    Number(r.id),
    r.email,
    r.released_at ? 'admitted' : 'waiting',
    iso(r.submitted_at),
    iso(r.confirmed_at),
    iso(r.released_at),
    signupX || accountX,
    signupX ? 'waitlist' : (accountX ? 'account' : ''),
    bareHandle(verified.github) || bareHandle(r.account_github_handle),
    bareHandle(verified.linkedin),
    bareHandle(handles.farcaster),
    bareHandle(handles.discord),
    bareHandle(handles.telegram),
    bareHandle(handles.other),
    bareHandle(a.referrer_handle),
    r.linked_username || '',
    r.linked_username ? String(!!r.has_platform_access) : '',
    r.invited_by_email || '',
    Number(r.invited_count) || 0,
    a.country || '',
    a.city || '',
    discovery.source || '',
    discovery.detail || '',
    a.made_url || '',
    a.made_note || '',
    group.name || '',
    group.size || '',
    group.role || '',
    Array.isArray(group.tools) ? group.tools.join('; ') : '',
    group.need || '',
    loss.had || '',
    loss.product || '',
    Array.isArray(loss.kind) ? loss.kind.join('; ') : '',
    loss.story || '',
    a.followed_claim ? 'true' : '',
  ];
}

function formatBpUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    bp_requested_at: iso(row.bp_requested_at),
    bp_released_at: iso(row.bp_released_at),
    has_platform_access: row.has_platform_access,
  };
}

function waitlistAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/waitlist ────────────────────────────────────────
  // `?status=pending|released` filters; default lists everything,
  // pending first, oldest submission first within each group (FIFO —
  // the natural release order for a queue, and the only order this ships).
  //
  // `?only=confirmed|invited` narrows further, and `?sort=answered` is an
  // admin's manual lens over the same rows — how much someone filled in,
  // which is a coarse proxy and deliberately NOT a score. Nothing here
  // ranks the queue automatically.
  router.get('/api/v4/admin/waitlist', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      const where = waitlistWhere(req.query);

      // The key count is computed in SQL rather than from signalsFor
      // because the list is PAGINATED: sorting the 200 rows a page happens
      // to contain would order each page against itself. jsonb_object_keys
      // rejects a non-object and these rows come from a public endpoint
      // across several schema versions, so the typeof guard is
      // load-bearing. `_version` is counted along with the real sections;
      // for a coarse ordering that is fine.
      const answeredCount = `
        CASE WHEN jsonb_typeof(w.answers) = 'object'
             THEN (SELECT COUNT(*) FROM jsonb_object_keys(w.answers))
             ELSE 0 END`;
      const order = req.query.sort === 'answered'
        ? `ORDER BY (w.released_at IS NOT NULL),
                    (w.confirmed_at IS NOT NULL) DESC,
                    ${answeredCount} DESC,
                    w.submitted_at ASC, w.id ASC`
        : 'ORDER BY (w.released_at IS NOT NULL), w.submitted_at ASC, w.id ASC';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM waitlist_signups w ${where}`
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT w.id, w.email, w.submitted_at, w.released_at, w.confirmed_at,
                w.linked_user_id, w.answers, w.invited_by,
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id)
                  AS invited_count,
                p.email AS invited_by_email,
                u.username AS linked_username, u.has_platform_access,
                m.status AS invite_mail_status, m.created_at AS invite_mail_at,
                m.error AS invite_mail_error
           FROM waitlist_signups w
           LEFT JOIN users u ON u.id = w.linked_user_id
           LEFT JOIN waitlist_signups p ON p.id = w.invited_by
           LEFT JOIN LATERAL (
             SELECT d.status, d.created_at, d.error
               FROM mail_deliveries d
              WHERE d.recipient = w.email AND d.kind = 'waitlist_released'
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT 1
           ) m ON TRUE
          ${where}
          ${order}
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatSignup) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/waitlist/analytics ──────────────────────────────
  // Aggregate counts + a 30-day signup trend for the Analytics dashboard.
  // Read-only and cheap (a handful of aggregates plus one grouped count),
  // so it sits under the router-wide `adminReadGate` like the list route
  // above rather than `adminWriteGate` — nothing here exposes a row an
  // admin couldn't already see paging through the queue.
  //
  // Every figure is derived from columns the table actually has (no
  // invented "status" enum): `released_at` is waiting vs. admitted,
  // `confirmed_at` is whether the signup ever proved it could receive
  // mail, `linked_user_id` is whether a platform account is attached.
  router.get('/api/v4/admin/waitlist/analytics', async (req, res) => {
    try {
      const { rows: totalsRows } = await pool.query(
        `SELECT COUNT(*)::int AS "totalSignups",
                COUNT(*) FILTER (WHERE released_at IS NULL)::int AS waiting,
                COUNT(*) FILTER (WHERE released_at IS NOT NULL)::int AS admitted,
                COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed,
                COUNT(*) FILTER (WHERE linked_user_id IS NOT NULL)::int AS linked
           FROM waitlist_signups`
      );
      const totals = totalsRows[0];

      // 30-day daily trend, zero-filled so a quiet day is a real zero
      // rather than a missing point the chart would have to skip.
      const days = 30;
      const { rows: dailyRows } = await pool.query(
        `SELECT to_char(date_trunc('day', submitted_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count
           FROM waitlist_signups
          WHERE submitted_at >= NOW() - $1::interval
          GROUP BY 1`,
        [`${days} days`]
      );
      const byDay = new Map(dailyRows.map((r) => [r.day, r.count]));
      const series = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const day = d.toISOString().slice(0, 10);
        series.push({ day, count: byDay.get(day) || 0 });
      }

      return ok(res, {
        data: {
          totalSignups: totals.totalSignups,
          waiting: totals.waiting,
          admitted: totals.admitted,
          confirmed: totals.confirmed,
          linked: totals.linked,
          series,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist/analytics failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/waitlist/export-csv ─────────────────────────────
  // Every signup the `?status=` / `?only=` filters select, unpaginated, as
  // a CSV — newest signup first, which is the order someone cross-checking
  // recent requests for access wants. Carries the X handle a signup
  // connected (see exportRow for where it is read from).
  //
  // `adminWriteGate` on a GET, for the reason users.js's export-csv gives:
  // a view-only admin can read these rows page by page, but walking away
  // with the whole list as a file is a different exposure class.
  router.get('/api/v4/admin/waitlist/export-csv', adminWriteGate, async (req, res) => {
    try {
      const where = waitlistWhere(req.query);
      const { rows } = await pool.query(
        `SELECT w.id, w.email, w.submitted_at, w.released_at, w.confirmed_at,
                w.answers,
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id)
                  AS invited_count,
                p.email AS invited_by_email,
                u.username AS linked_username, u.has_platform_access,
                sx.handle AS account_x_handle,
                sg.handle AS account_github_handle
           FROM waitlist_signups w
           LEFT JOIN users u ON u.id = w.linked_user_id
           LEFT JOIN waitlist_signups p ON p.id = w.invited_by
           LEFT JOIN user_social_identities sx
             ON sx.user_id = w.linked_user_id AND sx.provider = 'x'
           LEFT JOIN user_social_identities sg
             ON sg.user_id = w.linked_user_id AND sg.provider = 'github'
          ${where}
          ORDER BY w.submitted_at DESC, w.id DESC`
      );

      const status = req.query.status === 'pending' || req.query.status === 'released'
        ? req.query.status : 'all';
      const day = new Date().toISOString().slice(0, 10);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="waitlist-${status}-${day}.csv"`);
      res.write(`${EXPORT_HEADER.join(',')}\n`);
      for (const r of rows) {
        res.write(`${exportRow(r).map(csvField).join(',')}\n`);
      }
      return res.end();
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist/export-csv failed', { message: err.message });
      if (!res.headersSent) return fail(res, 500, 'Internal server error.');
      return res.end();
    }
  });

  // ── POST /api/v4/admin/waitlist/:id/release ──────────────────────────
  // Idempotent: re-releasing keeps the original released_at. Works with
  // or without a linked account (see services/waitlist.js).
  router.post('/api/v4/admin/waitlist/:id/release', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Waitlist entry not found.');
      const released = await waitlist.releaseWaitlistSignup(pool, id);
      if (!released) return fail(res, 404, 'Waitlist entry not found.');
      log.info('topochain-admin', 'Waitlist entry released', {
        signupId: id, linkedUserId: released.linked_user_id, adminId: req.user?.id,
      });
      // "You're in" notification — first release only (re-releases are
      // idempotent no-ops and must not re-email). Degrades silently when
      // no mail transport is configured; never fails the release.
      if (released.newly_released) {
        await sendWaitlistReleaseMail(config, released.email, {
          hasAccount: released.linked_user_id != null,
          // #1548: lets the signup screen prefill the address and send the
          // code without a second step. An unguessable capability already
          // delivered to this address, so it carries nothing the recipient
          // does not already hold — and unlike the address itself it is safe
          // in a query string, which is what survives a link rewriter.
          moreToken: released.more_token || null,
        });
      }
      return ok(res, {
        data: {
          id: Number(released.id),
          email: released.email,
          released_at: iso(released.released_at),
          linked_user_id: released.linked_user_id != null ? Number(released.linked_user_id) : null,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/:id/release failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── DELETE /api/v4/admin/waitlist/:id ─────────────────────────────────
  // Removes one signup outright. `invited_by` is self-referential with
  // ON DELETE SET NULL, so deleting a row that referred others clears
  // their invited_by rather than failing or cascading further.
  router.delete('/api/v4/admin/waitlist/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Waitlist entry not found.');
      const { rows } = await pool.query(
        'DELETE FROM waitlist_signups WHERE id = $1 RETURNING id, email',
        [id]
      );
      if (!rows.length) return fail(res, 404, 'Waitlist entry not found.');
      log.info('topochain-admin', 'Waitlist entry deleted', {
        signupId: id, email: rows[0].email, adminId: req.user?.id,
      });
      return ok(res, { data: { id: Number(rows[0].id) } });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/waitlist/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/waitlist/bulk-delete ───────────────────────────
  // Deletes several signups at once, for the queue's multi-select. Ids
  // that don't parse or don't exist are silently skipped; the response
  // says how many rows were actually removed.
  router.post('/api/v4/admin/waitlist/bulk-delete', adminWriteGate, async (req, res) => {
    try {
      const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids = [...new Set(raw.map(toIntId).filter((n) => n != null))];
      if (!ids.length) return fail(res, 422, 'No valid waitlist entry ids given.');
      const { rows } = await pool.query(
        'DELETE FROM waitlist_signups WHERE id = ANY($1::bigint[]) RETURNING id',
        [ids]
      );
      log.info('topochain-admin', 'Waitlist entries bulk-deleted', {
        signupIds: rows.map((r) => Number(r.id)), adminId: req.user?.id,
      });
      return ok(res, { data: { deleted: rows.length } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/bulk-delete failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/grant-access ────────────────────────
  // Direct platform-access grant for an account that never joined the
  // waitlist. Idempotent.
  router.post('/api/v4/admin/users/:id/grant-access', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!rows.length) return fail(res, 404, 'User not found.');
      await waitlist.grantPlatformAccess(pool, id);
      log.info('topochain-admin', 'Platform access granted directly', { userId: id, adminId: req.user?.id });
      return ok(res, { data: { id, has_platform_access: true } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/grant-access failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/bp-queue ────────────────────────────────────────
  // Users who asked to produce blocks. `?status=pending|released`;
  // default everything, pending first, oldest request first.
  router.get('/api/v4/admin/bp-queue', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      let where = 'WHERE bp_requested_at IS NOT NULL';
      if (status === 'pending') where += ' AND bp_released_at IS NULL';
      else if (status === 'released') where += ' AND bp_released_at IS NOT NULL';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users ${where}`
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT id, username, email, display_name, bp_requested_at, bp_released_at,
                has_platform_access
           FROM users ${where}
          ORDER BY (bp_released_at IS NOT NULL), bp_requested_at ASC, id ASC
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatBpUser) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/bp-queue failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/release-bp ──────────────────────────
  // Manual block-producer key release. Idempotent. Allowed even if the
  // user never formally requested (bp_requested_at is backfilled) so an
  // admin can hand-pick producers.
  router.post('/api/v4/admin/users/:id/release-bp', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query(
        `UPDATE users
            SET bp_requested_at = COALESCE(bp_requested_at, NOW()),
                bp_released_at = COALESCE(bp_released_at, NOW())
          WHERE id = $1
          RETURNING id, username, email, display_name, bp_requested_at, bp_released_at,
                    has_platform_access`,
        [id]
      );
      if (!rows.length) return fail(res, 404, 'User not found.');
      log.info('topochain-admin', 'Block production released', { userId: id, adminId: req.user?.id });
      return ok(res, { data: formatBpUser(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/release-bp failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { waitlistAdminRoutes };
