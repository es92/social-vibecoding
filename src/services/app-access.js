// Shared per-app visibility gate (collaborator & viewer privacy).
//
// Two access levels, checked against apps.collab_visibility /
// apps.view_visibility + the app_collaborators membership table:
//   'view'   — may see the app exists and use it (home list, App tab).
//   'collab' — may participate in building it (group chat, dev sessions,
//              voting, issues, kudos).
// Rules (see schema.sql for the invariants):
//   - admins always pass (both levels);
//   - a 'public' visibility passes for everyone;
//   - a 'private' visibility requires an app_collaborators row with
//     status='member' (a pending 'invited' row grants nothing).
// Callers respond 404 (not 403) on a null/false result, matching the
// existing self_hosted precedent so private apps aren't enumerable.

const log = require('./logger');

const ACCESS_COLUMNS = 'id, slug, created_by, self_hosted, collab_visibility, view_visibility';

// Credential-bearing `apps` columns that must NEVER reach an HTTP
// response. Kept in sync with the `staging:private` tags in
// src/db/schema.sql — a new secret-bearing column added there MUST be
// added here too (tests/app-secret-exposure.test.js cross-checks the
// schema tags against this list, mirroring debug-access.js's
// DENIED_COLUMNS/prod-debug-access.test.js pattern). This is a
// defense-in-depth denylist layered on TOP of explicit non-secret SQL
// column lists at the call sites below — the SQL layer is what keeps
// these values from ever leaving Postgres; this is the fail-closed net
// for the day a response site regresses to `SELECT *`.
const SECRET_APP_COLUMNS = ['db_password', 'llm_proxy_token', 'storage_api_token'];

// Shallow-copies `row` with every SECRET_APP_COLUMNS key removed.
// Safe to call on a row that already lacks them (no-op) or on
// something that isn't a plain row at all.
function stripAppSecrets(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const col of SECRET_APP_COLUMNS) delete out[col];
  return out;
}

// Every current `apps` column EXCEPT the SECRET_APP_COLUMNS above —
// the explicit allowlist client-facing SELECTs should use instead of
// `SELECT *` / `SELECT a.*`, so secrets never leave Postgres for those
// queries in the first place. Update this alongside SECRET_APP_COLUMNS
// (and schema.sql) whenever an `apps` column is added or removed.
const NON_SECRET_APP_COLUMNS = [
  'id', 'name', 'slug', 'repo_url', 'container_id', 'status', 'retry_count',
  'created_by', 'created_at', 'main_sha', 'main_pr_number', 'last_deploy_at',
  'manifest_snapshot', 'last_failure', 'locked', 'self_hosted',
  'collab_visibility', 'view_visibility', 'approver_policy',
  'approvals_required', 'screenshot_device_scale', 'icon_emoji',
  'icon_image_id', 'featured_illustration', 'forked_from', 'admin_usernames',
  'directory_review_status', 'directory_reviewed_at', 'directory_reviewed_sha',
  'main_check_state', 'main_check_sha', 'main_check_at', 'main_check_detail',
  'main_check_resumed_sha',
];

// `NON_SECRET_APP_COLUMNS` rendered as a bare comma-joined column list
// (for `SELECT <cols> FROM apps`) or, with a table alias, prefixed for
// use in a joined query (`SELECT <cols> FROM apps a JOIN ...`).
function nonSecretAppColumnList(alias = null) {
  return NON_SECRET_APP_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');
}

async function isCollaborator(pool, appId, userId) {
  if (!userId || !appId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM app_collaborators WHERE app_id = $1 AND user_id = $2 AND status = 'member'`,
    [appId, userId]
  );
  return rows.length > 0;
}

// `app` must carry id + collab_visibility + view_visibility (SELECT * or
// ACCESS_COLUMNS both work). Returns boolean, or THROWS when the row it is
// handed cannot answer the question — see below.
//
// FAIL-CLOSED ON A MISSING COLUMN, and this is the structural fix for a
// real bug. This function used to read the visibility column off the row
// and treat a missing/falsy value as public ("legacy rows mid-migration
// may briefly lack the column"). That default turned every caller that
// projected the column away into a silent, total privacy bypass: the RSA
// cutover's /api/iframe-token gate passed a trimmed `'id, slug'` list, so
// every app looked public and any authenticated user could mint an
// app-identity token for a view-private app they cannot even see. The
// endpoint's own comment claimed an existence-hiding 404 while handing out
// tokens. Nothing failed; nothing logged.
//
// A caller that cannot supply the visibility columns has a bug, and the
// only safe answer is to refuse loudly. So: absent key, or present but
// falsy, throws. `apps.collab_visibility` / `apps.view_visibility` are
// NOT NULL DEFAULT 'public' (see schema.sql), so a legitimate row always
// carries a non-empty string — there is no honest caller this rejects, and
// throwing on falsy rather than merely on absent is the stricter invariant.
//
// Blast radius is deliberate and bounded: getAppForUser and the two
// id-scoped router guards below all sit inside route-level try/catch blocks
// that answer 500. The ws.js handshake maps failures to a denied connection,
// while its per-message write gate catches and drops the write with a
// structured internal result. Both paths fail closed, never with an
// unhandled rejection.
//
// The check runs BEFORE the admin short-circuit on purpose. Admins are
// exactly who the screenshot and proposal-checks runners authenticate as,
// so a trimmed projection that only broke for non-admins would keep
// slipping through the paths most likely to exercise it.
async function checkAppAccess(pool, app, user, level = 'view') {
  if (!app) return false;
  const column = level === 'collab' ? 'collab_visibility' : 'view_visibility';
  const vis = app[column];
  if (!vis) {
    throw new Error(
      `app-access: cannot check '${level}' access — the app row is missing `
      + `\`${column}\` (got ${JSON.stringify(vis)}). Select it (use `
      + 'ACCESS_COLUMNS) rather than trimming the projection.'
    );
  }
  if (user?.isAdmin) return true;
  if (vis === 'public') return true;
  return isCollaborator(pool, app.id, user?.id);
}

// Resolve an app by slug AND enforce `level` access for `user` in one
// call. Returns the row or null (caller 404s). `columns` defaults to *
// so existing routes keep their full row.
async function getAppForUser(pool, slug, user, level = 'view', columns = '*') {
  const { rows } = await pool.query(`SELECT ${columns} FROM apps WHERE slug = $1`, [slug]);
  if (!rows.length) return null;
  const app = rows[0];
  if (!(await checkAppAccess(pool, app, user, level))) return null;
  return app;
}

// Method-aware level for the id-scoped router guards below (#621):
// reads (GET/HEAD) only need 'view' access — non-collaborators get a
// read-only look at the dev surface — while every mutation keeps the
// 'collab' bar. Safe because the sensitive GETs behind these guards
// carry their own row-level scoping (owner-only session/spec/events/
// attachment queries); the guard's job is just the app-level privacy
// wall.
function guardLevelFor(req) {
  return req.method === 'GET' || req.method === 'HEAD' ? 'view' : 'collab';
}

// Express middleware factory for routers that address an app through a
// chat-session id (/api/sessions/:id/...). Resolves session → app and
// enforces view access on reads / collab access on writes; 404 on deny
// so private sessions aren't enumerable. A missing session falls
// through to the route's own lookup (which already 404s with its
// route-specific wording).
function sessionCollabGuard(pool) {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return next();
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.collab_visibility, a.view_visibility
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1`,
        [id]
      );
      if (!rows.length) return next();
      if (!(await checkAppAccess(pool, rows[0], req.user, guardLevelFor(req)))) {
        return res.status(404).json({ error: 'Session not found' });
      }
      return next();
    } catch (err) {
      log.error('app-access', 'session guard failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Same idea for routers addressing an app through an internal issue id
// (/api/issues/:id/...).
function issueCollabGuard(pool) {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return next();
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.collab_visibility, a.view_visibility
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [id]
      );
      if (!rows.length) return next();
      if (!(await checkAppAccess(pool, rows[0], req.user, guardLevelFor(req)))) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      return next();
    } catch (err) {
      log.error('app-access', 'issue guard failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ── WS broadcast filtering support ────────────────────────────────────
//
// broadcastGlobal-style events for a view-private app must only reach
// admins + members. ws.js asks here per event; a 10s in-process TTL
// cache (same pattern as services/limits.js) keeps it one query per app
// per window instead of one per event. Membership/visibility writes call
// invalidateVisibility() so changes propagate immediately.

const VIS_CACHE_TTL_MS = 10_000;
const visCacheById = new Map();   // appId -> { at, viewPrivate, memberIds:Set }
const slugToId = new Map();       // slug -> { at, appId }
const hostVisBySlug = new Map();  // slug -> { at, appId, viewPrivate } (edge gate)

function invalidateVisibility(appId, slug) {
  if (appId != null) visCacheById.delete(Number(appId));
  if (slug) {
    slugToId.delete(slug);
    hostVisBySlug.delete(slug);
  }
  // Slug entries are tiny and TTL-bounded; a stale slug->id mapping is
  // harmless (ids never re-point), so no full sweep needed.
}

async function getWsVisibility(pool, { appId = null, appSlug = null } = {}) {
  const now = Date.now();
  let id = appId != null ? Number(appId) : null;
  if (id == null && appSlug) {
    const hit = slugToId.get(appSlug);
    if (hit && now - hit.at < VIS_CACHE_TTL_MS) {
      id = hit.appId;
    } else {
      const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [appSlug]);
      if (!rows.length) return null;
      id = rows[0].id;
      slugToId.set(appSlug, { at: now, appId: id });
    }
  }
  if (id == null) return null;

  const cached = visCacheById.get(id);
  if (cached && now - cached.at < VIS_CACHE_TTL_MS) return cached;

  const { rows } = await pool.query('SELECT view_visibility FROM apps WHERE id = $1', [id]);
  if (!rows.length) return null;
  const viewPrivate = rows[0].view_visibility === 'private';
  let memberIds = new Set();
  if (viewPrivate) {
    const { rows: members } = await pool.query(
      `SELECT user_id FROM app_collaborators WHERE app_id = $1 AND status = 'member'`,
      [id]
    );
    memberIds = new Set(members.map((r) => r.user_id));
  }
  const entry = { at: now, viewPrivate, memberIds };
  visCacheById.set(id, entry);
  return entry;
}

// ── Edge (subdomain) gate support ─────────────────────────────────────
//
// Caddy forward_auths every *.<domain> request to GET /__caddy/access
// (src/routes/internal.js). These helpers keep that hot path cheap:
// parseAppHost maps a request host to the owning app slug, and
// getHostVisibility answers "is this slug's app view-private?" from a
// 10s TTL cache so the view-public fast path costs ~zero DB work.

const platformJwt = require('./platform-jwt');
const { USERNODE_DOMAIN, USERNODE_APPS_DOMAIN } = require('./caddy');

// Short-lived grant the apex /__access/authorize route (routes/apps.js)
// mints from a real platform session; the edge gate (/__caddy/access in
// routes/internal.js) exchanges it for the per-host scoped access
// cookie. 120s is plenty for one redirect hop (TTL lives with the signer).
//
// Signed with EDGE_JWT_SECRET — its own authority, never handed to any
// container — and carries a `pur` claim the gate re-checks, so a grant
// can't be replayed as the longer-lived access cookie.
function mintAccessGrant({ uid, appId, host }) {
  return platformJwt.signEdgeGrant({ uid, appId, host });
}

// Map a request host to its app slug. Handles production hosts
// (`<slug>.<domain>`), per-PR staging previews (`<slug>--s<id>.<domain>`,
// plus the legacy `--<hash>` suffix) — staging previews clone prod data,
// so they inherit the prod app's visibility. Returns
// { slug, label } or null for hosts that aren't a routable app subdomain.
function parseAppHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (host === USERNODE_DOMAIN) return null;
  const suffix = '.' + USERNODE_APPS_DOMAIN;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  // Only single-level subdomains are routable (the Caddy wildcard
  // matches one label).
  if (!label || label.includes('.')) return null;
  const staging = label.match(/^([a-z0-9-]+?)--s\d+(?:--[a-z0-9]+)?$/);
  const slug = staging ? staging[1] : label;
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return { slug, label, host };
}

async function getHostVisibility(pool, slug) {
  const now = Date.now();
  const cached = hostVisBySlug.get(slug);
  if (cached && now - cached.at < VIS_CACHE_TTL_MS) {
    return cached.appId == null ? null : cached;
  }
  const { rows } = await pool.query(
    'SELECT id, view_visibility FROM apps WHERE slug = $1',
    [slug]
  );
  if (!rows.length) {
    // Negative-cache unknown slugs too — probes shouldn't each cost a query.
    hostVisBySlug.set(slug, { at: now, appId: null, viewPrivate: false });
    return null;
  }
  const entry = {
    at: now,
    appId: rows[0].id,
    viewPrivate: rows[0].view_visibility === 'private',
  };
  hostVisBySlug.set(slug, entry);
  return entry;
}

// "May this user view this (view-private) app?" — admins or members.
// Rides the same member-id cache the WS filter uses, so membership
// revocation propagates within the TTL (or instantly via
// invalidateVisibility at the mutation sites).
async function isViewMember(pool, appId, userId) {
  if (!Number.isInteger(userId)) return false;
  const info = await getWsVisibility(pool, { appId });
  if (!info) return false;          // app deleted
  if (!info.viewPrivate) return true; // flipped public since lookup
  if (info.memberIds.has(userId)) return true;
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return !!rows[0]?.is_admin;
}

module.exports = {
  ACCESS_COLUMNS,
  SECRET_APP_COLUMNS,
  NON_SECRET_APP_COLUMNS,
  stripAppSecrets,
  nonSecretAppColumnList,
  isCollaborator,
  checkAppAccess,
  getAppForUser,
  guardLevelFor,
  sessionCollabGuard,
  issueCollabGuard,
  getWsVisibility,
  invalidateVisibility,
  parseAppHost,
  getHostVisibility,
  isViewMember,
  mintAccessGrant,
};
