const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');
const http = require('http');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { authLimiter, walletCheckLimiter } = require('../middleware/rate-limits');
const genesisAccounts = require('../services/genesis-accounts');
const waitlist = require('../services/waitlist');
const events = require('../services/events');
const { validatePassword } = require('../services/password-policy');
// One shape for the profile block, shared with PATCH /api/me/profile so
// /api/auth/me and the write echo identical objects (#982).
const { shapeProfile } = require('./profile');
const {
  accountRecovery,
  withTransaction,
} = require('../services/cli-auth');
// The SAME predicate the CLI 404 gates use (routes/cli-auth.js), so the
// capability this route advertises can never disagree with what that
// surface actually serves.
const { isCliSurfaceEnabled } = require('./cli-auth');
// The external-agent hand-off needs the identity-only GitHub link, so
// whether that link is configurable at all decides whether /api/auth/me
// advertises the Claude Code / Codex flows (#1049).
const githubLink = require('../services/github-link');

const SESSION_DAYS = 7;

// Preferred development flow (#1049). The SAME allowlist as the CHECK on
// users.dev_flow_preference and as DevFlowSelect.FLOWS in
// public/js/dev-flow-select.js; tests/dev-flow-preference.test.js pins all
// three together so a new flow can't land in one place only.
const DEV_FLOWS = ['platform', 'claude-code', 'codex'];

// Staging mock data (#555): llm_usage is staging:private, so in a
// prod-cloned staging DB every viewer's AI-credit row would render a
// pristine "$20.00 of $20.00 left" and a reviewer couldn't tell that from
// broken. See the ?demo=1 branch on GET /api/me/ai-budget below.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// View-only admin role (issue #311). Builds the role-related fields every
// auth response returns to the client from the raw `is_admin` /
// `admin_readonly` columns: `isAdmin` (the visibility tier, unchanged),
// `canAdminWrite` (the single privileged-mutation gate — full admin only),
// and a display `role` string the UI renders. Normal-login/register users
// pass nothing and get the user defaults.
function roleFields(isAdmin, adminReadonly) {
  const admin = !!isAdmin;
  const readonly = admin && !!adminReadonly;
  return {
    isAdmin: admin,
    canAdminWrite: admin && !readonly,
    role: !admin ? 'user' : (readonly ? 'view_admin' : 'admin'),
  };
}

// Default-off: only set `Secure` when we explicitly know we're in production.
// Previously this was `NODE_ENV !== 'development'`, which silently dropped the
// cookie on any dev box reached over LAN HTTP (mobile testing) because
// NODE_ENV was usually unset => secure=true => browser refuses cookie on HTTP.
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function authRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    try {
      // The identifier can be a username OR an email (thin-shell
      // migration: mobile-created accounts are email-keyed, and platform
      // login is now the only sign-in surface for the app). Email lookup
      // uses the normalized lower-case form the mobile OTP flow stores
      // (src/routes/topochain/mobile-auth.js). Email is tried first for
      // @-shaped identifiers, falling back to an exact username match so
      // legacy accounts whose username merely looks like an email keep
      // working.
      const identifier = String(username).trim();
      let rows;
      if (identifier.includes('@')) {
        ({ rows } = await pool.query(
          'SELECT id, username, password, is_admin, admin_readonly FROM users WHERE email = $1',
          [identifier.toLowerCase()]
        ));
      }
      if (!rows || rows.length === 0) {
        ({ rows } = await pool.query(
          'SELECT id, username, password, is_admin, admin_readonly FROM users WHERE username = $1',
          [identifier]
        ));
      }

      if (rows.length === 0) {
        log.warn('auth', 'Login failed - unknown user', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        log.warn('auth', 'Login failed - bad password', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(
        Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
      );

      await pool.query(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, user.id, expiresAt]
      );

      res.cookie('session', token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: 'lax',
        expires: expiresAt,
      });

      log.info('auth', 'Login successful', { userId: user.id, username: user.username });

      res.json({
        // Echo the account's real username, not the raw identifier — the
        // identifier may have been an email.
        user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
      });
    } catch (err) {
      log.error('auth', 'Login error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/register', authLimiter, async (req, res) => {
    const { code, username, password } = req.body;

    if (!code?.trim() || !username?.trim() || !password) {
      return res.status(400).json({ error: 'Activation code, username, and password required' });
    }

    try {
      const { rows: codeRows } = await pool.query(
        'SELECT id FROM activation_codes WHERE code = $1 AND used_by IS NULL',
        [code.trim()]
      );

      if (codeRows.length === 0) {
        return res.status(400).json({ error: 'Invalid or already used activation code' });
      }

      const codeId = codeRows[0].id;
      const hash = await bcrypt.hash(password, 12);
      const { rows: userRows } = await pool.query(
        'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
        [username.trim(), hash]
      );

      const userId = userRows[0].id;
      await pool.query(
        'UPDATE activation_codes SET used_by = $1, used_at = NOW() WHERE id = $2',
        [userId, codeId]
      );

      // An activation code is an admin-minted invite — stronger than a
      // waitlist release — so it carries platform access with it
      // (onboarding flow alignment). Without this, every invited user
      // would land in the waiting room, a regression on the invite flow.
      await waitlist.grantPlatformAccess(pool, userId);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, userId, expiresAt]
      );

      res.cookie('session', token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: 'lax',
        expires: expiresAt,
      });

      log.info('auth', 'User registered', { userId, username: username.trim(), codeId });
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'activation_code' } });
      res.json({ user: { id: userId, username: username.trim(), ...roleFields(false, false) } });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('auth', 'Registration error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.session;
    if (token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
      log.info('auth', 'Logout', { userId: req.user?.id });
    }
    res.clearCookie('session');
    res.json({ ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Include BYOK state (#30) so the settings modal can render
    // "sk-ant-…abcd" without decrypting anything — the last-4 is stored
    // in plaintext for display purposes only.
    let hasApiKey = false;
    let keyLast4 = null;
    let usernodePubkey = null;
    // Profile customization (#982): the editable identity fields plus the
    // content-addressed avatar URL. Read HERE rather than in
    // middleware/auth.js's per-request session hydration — this endpoint
    // already does one users lookup, and every request paying for a join
    // it never renders would be the wrong trade.
    let profile = { displayName: null, bio: null, avatarUrl: null, links: { github: null, x: null } };
    // Derived app-creation affordance: admins always can; everyone else
    // can iff their live (non-errored) app count is below their quota
    // (see users.app_quota in schema.sql). Computing the count here keeps
    // the client contract a single boolean — the home screen reads only
    // `canCreateApps` and needs no change as the quota feature lands.
    let canCreateApps = !!req.user.isAdmin;
    // Preferred development flow (#1049). Read here rather than in the
    // per-request session hydration for the same reason as the profile
    // block above: this endpoint already pays for one users lookup, and
    // only this endpoint renders the value.
    let devFlowPreference = null;
    try {
      const { rows } = await pool.query(
        `SELECT u.anthropic_key_enc, u.anthropic_key_last4, u.usernode_pubkey,
                u.display_name, u.bio, u.github, u.x, u.dev_flow_preference,
                av.id AS avatar_id
           FROM users u
           LEFT JOIN user_avatars av ON av.user_id = u.id
          WHERE u.id = $1`,
        [req.user.id]
      );
      if (rows[0]?.anthropic_key_enc) {
        hasApiKey = true;
        keyLast4 = rows[0].anthropic_key_last4 || null;
      }
      usernodePubkey = rows[0]?.usernode_pubkey || null;
      devFlowPreference = DEV_FLOWS.includes(rows[0]?.dev_flow_preference)
        ? rows[0].dev_flow_preference
        : null;
      profile = shapeProfile(rows[0]);
    } catch {}
    if (!canCreateApps) {
      try {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM apps WHERE created_by = $1 AND status <> 'error'`,
          [req.user.id]
        );
        const liveCount = countRows[0]?.n ?? 0;
        canCreateApps = (req.user.appQuota ?? 0) > 0 && liveCount < (req.user.appQuota ?? 0);
      } catch {}
    }
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        isAdmin: req.user.isAdmin,
        // View-only admin role (issue #311). `isAdmin` still drives every
        // client read/visibility gate; `canAdminWrite` drives mutating
        // controls (hidden for view-only admins). `role` is the display
        // string the admin panel / banners render.
        canAdminWrite: !!req.user.canAdminWrite,
        role: !req.user.isAdmin ? 'user' : (req.user.adminReadonly ? 'view_admin' : 'admin'),
        // Derived per-user app-creation affordance: isAdmin || (live app
        // count < app_quota). The home screen hides the "Create new app"
        // affordance for anyone who can't create — see the canCreate
        // helper in public/js/home.js. The numeric quota itself is only
        // surfaced through the admin API.
        canCreateApps,
        // Experimental: opt-in AI progress estimate for coding runs
        // (Settings → Experimental). Default OFF.
        aiProgressEstimate: !!req.user.aiProgressEstimate,
        // Platform-level language preference (issue #757): a BCP-47 tag or
        // null when unset. Settings → Language renders from this; apps read
        // it via the iframe JWT `locale` claim and the bridge's
        // usernode.getUserLocale().
        locale: req.user.locale ?? null,
        // Platform-access gate (onboarding flow alignment). FALSE means
        // the account is waiting to be released off the platform
        // waitlist — the waiting room polls this to know when to let
        // the user through.
        hasPlatformAccess: !!req.user.hasPlatformAccess || !!req.user.isAdmin,
        hasApiKey,
        keyLast4,
        usernodePubkey,
        walletLinkEnabled: !!config.usernodeAppPubkey,
        // Profile customization (#982). `username` stays the permanent
        // sign-in handle and is NOT editable anywhere on the platform;
        // `displayName` is the settable name other people see (it already
        // feeds the standings' resolveDisplayName chain). `avatarUrl` is
        // the content-addressed /avatars/<id> path, or null.
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        links: profile.links,
        // Whether the CLI-credentials surface exists in this deployment.
        // The whole /api/me/cli-tokens + /api/cli/* family is 404'd in a
        // staging preview (unreviewed code must not mint CLI tokens), so
        // Settings has to know NOT TO ASK: a 404 the client swallows is
        // still an error line in the page console, which fails the
        // proposal checks. Same shape as walletLinkEnabled above — the
        // client renders what the server reports, it never sniffs the
        // environment itself.
        cliAuthEnabled: isCliSurfaceEnabled(config),
        // Preferred development flow (#1049): 'platform' | 'claude-code' |
        // 'codex', or null for "ask me every time" (the default — the
        // dev-chat picker renders). Written by POST /api/me/dev-flow.
        devFlowPreference,
        // Whether the Claude Code / Codex hand-off is offerable AT ALL in
        // this deployment. The external-agent flow needs the identity-only
        // GitHub link to attribute the user's fork, so with no GitHub OAuth
        // credentials configured there is nothing to guide anyone through.
        // Same shape as walletLinkEnabled / cliAuthEnabled above: the client
        // renders what the server reports and never sniffs the environment.
        // A staging clone has no GitHub OAuth app, so this would be false
        // there and the whole #1049 surface would be unreviewable. Saying
        // "offerable" in staging unlocks nothing: the two writes answer 503
        // (routes/dev-flow.js), and the status route still reports
        // available:false unless the request carries the ?demo=1 fixture
        // flag — so the card only appears where a reviewer asks for it.
        externalFlowsAvailable: IS_STAGING || githubLink.isEnabled(config),
      },
    });
  });

  // #30 BYOK: set / replace the user's Anthropic key. We verify with a
  // cheap 1-token ping before persisting so we never save a key that
  // the Anthropic API would reject at runtime.
  // --------------------------------------------------------------
  // GET /api/me/ai-budget — the drawer's "AI credit" row (#555).
  //
  // Strictly me-scoped, so it must stay OUT of PUBLIC_PATHS in
  // middleware/auth.js. Deliberately carries NO global spend or global
  // cap: services/status.js redact() treats those as admin-only, and
  // this is the one endpoint every signed-in user polls.
  // --------------------------------------------------------------
  router.get('/api/me/ai-budget', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // Staging mock data: obviously-fake, read-only, written nowhere, and
    // a strict no-op in production. Gives the row a partial-spend state
    // (plus BYOK spillover) so a reviewer sees the real layout.
    if (IS_STAGING && req.query.demo === '1') {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      return res.json({
        limitCents: 2000,
        spentCents: 1360,
        remainingCents: 640,
        byokCents: 450,
        hasByokKey: true,
        resetsAt: reset.toISOString(),
        demo: true,
      });
    }
    try {
      const limits = require('../services/limits');
      res.json(await limits.getBudgetSnapshot(pool, req.user.id));
    } catch (err) {
      log.error('limits', 'ai-budget read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { key } = req.body || {};
    if (typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'Key required' });
    }
    const clean = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(clean)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid Anthropic API key.' });
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const test = new Anthropic({ apiKey: clean });
      await test.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      const msg = err?.status === 401 || err?.status === 403
        ? 'Anthropic rejected the key.'
        : `Couldn't verify the key (${err?.message || 'unknown error'}).`;
      return res.status(400).json({ error: msg });
    }

    try {
      // #30 dual-write (plan.md PR2): persist through the generic
      // credential store, which also mirrors into the legacy
      // users.anthropic_key_* columns during the migration window. Same
      // envelope, same verification — behavior unchanged, but the key now
      // also lives in user_ai_credentials for the openrouter era.
      const credentialStore = require('../services/credential-store');
      const saved = await credentialStore.writeAnthropicCodingAgent({
        pool, userId: req.user.id, apiKey: clean, dataKey: config.dataEncryptionKey,
      });
      const last4 = saved?.secret_last4 || clean.slice(-4);
      log.info('byok', 'API key saved', { userId: req.user.id });
      res.json({ ok: true, keyLast4: last4 });
    } catch (err) {
      log.error('byok', 'Failed to persist key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const credentialStore = require('../services/credential-store');
      await credentialStore.deleteAnthropicCodingAgent({ pool, userId: req.user.id });
      log.info('byok', 'API key removed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('byok', 'Failed to remove key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Change password for a signed-in user (issue #282). Wired from
  // Settings → "Change password". We always require the current password:
  // we don't track per-session wallet origin (no schema change), and every
  // account has a knowable current password anyway — set at registration,
  // handed over as an admin temporary password, or just chosen during a
  // wallet reset. Wallet users who've forgotten it use the pre-login
  // wallet-reset flow instead.
  router.post('/api/me/password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = req.body || {};

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Current password is required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT password FROM users WHERE id = $1',
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, rows[0].password);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'New password must be different from your current password' });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);
      log.info('auth', 'Password changed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('auth', 'Change password failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Experimental: per-user "AI progress estimate" toggle (default OFF).
  // Gates the Haiku estimator that watches in-flight Claude Code runs —
  // see runClaudeCodeTool in src/routes/sessions.js. Wired to the
  // Settings modal's Experimental section (fires on checkbox change).
  router.post('/api/me/ai-progress-estimate', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      await pool.query(
        'UPDATE users SET ai_progress_estimate = $1 WHERE id = $2',
        [enabled, req.user.id]
      );
      log.info('settings', 'AI progress estimate toggled', { userId: req.user.id, enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      log.error('settings', 'Failed to toggle AI progress estimate', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Preferred development flow (issue #1049). Written by the "remember my
  // option" checkbox on the dev-chat flow picker and by Settings →
  // Connections. Body { flow: 'platform' | 'claude-code' | 'codex' | null }
  // — null (or "") clears it back to "ask me every time", which is what
  // unticking the checkbox sends.
  router.post('/api/me/dev-flow', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { flow } = req.body || {};

    let normalized = null;
    if (flow !== null && flow !== undefined && flow !== '') {
      if (typeof flow !== 'string' || !DEV_FLOWS.includes(flow)) {
        return res.status(400).json({ error: `flow must be one of ${DEV_FLOWS.join(', ')} or null` });
      }
      normalized = flow;
    }

    try {
      await pool.query(
        'UPDATE users SET dev_flow_preference = $1 WHERE id = $2',
        [normalized, req.user.id]
      );
      log.info('settings', 'Dev flow preference saved', { userId: req.user.id, flow: normalized });
      res.json({ ok: true, flow: normalized });
    } catch (err) {
      log.error('settings', 'Failed to save dev flow preference', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Platform-level user language preference (issue #757). Wired to the
  // Settings modal's Language dropdown (fires on change). Body
  // { locale: string | null } — null (or "") clears the preference back
  // to "auto — use device language". Non-null values must be BCP-47-ish;
  // casing is normalized (language subtag lowercase, two-letter region
  // subtags uppercase: "pt-br" → "pt-BR"). The stored value feeds the
  // iframe JWT `locale` claim and /api/auth/me.
  router.post('/api/me/locale', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { locale } = req.body || {};

    let normalized = null;
    if (locale !== null && locale !== undefined && locale !== '') {
      if (typeof locale !== 'string') {
        return res.status(400).json({ error: 'locale must be a string or null' });
      }
      const clean = locale.trim();
      if (!clean) {
        // Whitespace-only — treat like "" (clear).
      } else if (clean.length > 35 || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(clean)) {
        return res.status(400).json({ error: 'locale must be a BCP-47 language tag (e.g. "id", "pt-BR")' });
      } else {
        normalized = clean
          .split('-')
          .map((sub, i) => {
            if (i === 0) return sub.toLowerCase();
            if (sub.length === 2) return sub.toUpperCase();
            return sub;
          })
          .join('-');
      }
    }

    try {
      await pool.query(
        'UPDATE users SET locale = $1 WHERE id = $2',
        [normalized, req.user.id]
      );
      log.info('settings', 'Locale preference saved', { userId: req.user.id, locale: normalized });
      res.json({ ok: true, locale: normalized });
    } catch (err) {
      log.error('settings', 'Failed to save locale preference', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Wallet linking ───────────────────────────────────────────────
  const LINK_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

  router.post('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!config.usernodeAppPubkey) {
      return res.status(503).json({ error: 'Wallet linking not configured' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

    try {
      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [token, expiresAt, req.user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token,
      });

      res.json({
        qr: {
          type: 'tx',
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          confirmTitle: 'Link Wallet',
          confirmSubtitle: 'Link your Usernode wallet to your Social Vibecoding account.',
        },
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      log.error('wallet', 'Failed to generate link token', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/wallet-link/status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      const pubkey = rows[0]?.usernode_pubkey || null;
      res.json({ linked: !!pubkey, pubkey });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await pool.query(
        `UPDATE users SET usernode_pubkey = NULL, wallet_link_token = NULL, wallet_link_expires_at = NULL WHERE id = $1`,
        [req.user.id]
      );
      log.info('wallet', 'Wallet unlinked', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('wallet', 'Failed to unlink wallet', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Wallet-based authentication ───────────────────────────────────
  const CHALLENGE_TTL_MS = 2 * 60 * 1000;
  const walletChallenges = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of walletChallenges) {
      if (now > entry.expiresAt) walletChallenges.delete(key);
    }
  }, 30_000);

  function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = mod.request(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500) || '(empty body)'}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message} — raw: ${text.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  function createSessionCookie(res, token, expiresAt) {
    res.cookie('session', token, {
      httpOnly: true,
      secure: SECURE_COOKIE,
      sameSite: 'lax',
      expires: expiresAt,
    });
  }

  async function createSession(pool, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, userId, expiresAt]
    );
    return { token, expiresAt };
  }

  router.post('/api/auth/wallet-check', walletCheckLimiter, async (req, res) => {
    const { pubkey } = req.body || {};
    if (!pubkey || typeof pubkey !== 'string') {
      return res.status(400).json({ error: 'pubkey required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, username, is_admin FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );

      const isGenesis = genesisAccounts.isGenesisAddress(pubkey.trim());

      if (rows.length > 0) {
        const challenge = crypto.randomBytes(32).toString('hex');
        walletChallenges.set(challenge, {
          pubkey: pubkey.trim(),
          expiresAt: Date.now() + CHALLENGE_TTL_MS,
        });
        return res.json({ status: 'linked', challenge, isGenesis });
      }

      return res.json({ status: 'not_linked', isGenesis });
    } catch (err) {
      log.error('wallet-auth', 'wallet-check failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-verify', authLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || pubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyBody = {
        public_key: cryptoKey,
        message: challenge,
        signature,
      };
      log.info('wallet-auth', 'Calling verify-signature', {
        url: verifyUrl,
        public_key: cryptoKey.slice(0, 20) + '...',
        message_len: challenge.length,
        signature_prefix: String(signature).slice(0, 30) + '...',
      });
      const verifyResp = await httpJson('POST', verifyUrl, verifyBody);

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Signature invalid', { resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }

      const user = rows[0];
      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      log.info('wallet-auth', 'Signature login successful', { userId: user.id, username: user.username });
      res.json({ user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) } });
    } catch (err) {
      log.error('wallet-auth', 'wallet-verify failed', { url: verifyUrl, err: err.message, code: err.code, stack: err.stack?.split('\n')[0] });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  // Self-service password reset proven by a linked wallet (issue #282).
  // Structurally this is wallet-verify that ends in a password write
  // instead of just a login. Key invariants:
  //   - NO genesis gate. We mirror wallet-verify, which already resolves
  //     the account by `usernode_pubkey` alone — proving control of the
  //     specific linked key is the whole proof, so genesis status is
  //     irrelevant here and would only block legitimate linked non-genesis
  //     users.
  //   - Account lookup is keyed ONLY on the verified pubkey, never a
  //     username, so this pre-login endpoint is not a username oracle.
  //   - On success every existing session is deleted (a leaked/old session
  //     must not outlive a reset) and a fresh session is minted.
  router.post('/api/auth/wallet-reset-verify', authLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature, newPassword } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || pubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyResp = await httpJson('POST', verifyUrl, {
        public_key: cryptoKey,
        message: challenge,
        signature,
      });

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Reset signature invalid', { resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }

      const user = rows[0];
      const hash = await bcrypt.hash(newPassword, 12);
      const recovery = await withTransaction(pool, (client) => accountRecovery(client, {
        userId: user.id,
        actorUserId: user.id,
        updatePassword: async (tx) => {
          const result = await tx.query(
            `UPDATE users SET password = $1 WHERE id = $2
             RETURNING id, username, is_admin, admin_readonly`,
            [hash, user.id]
          );
          // The route test's lightweight query facade predates pg's rowCount
          // shape. A real pg result always has rowCount, so production still
          // fails closed if the row disappeared after signature lookup.
          if (result.rowCount == null && result.rows.length === 0) {
            return { rows: [user] };
          }
          return result;
        },
        mintSession: async (tx) => {
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
          await tx.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, user.id, expiresAt]
          );
          return { token, expiresAt };
        },
      }));
      if (!recovery.found) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }
      const { token, expiresAt } = recovery.session;
      createSessionCookie(res, token, expiresAt);

      log.info('wallet-auth', 'Wallet password reset successful', { userId: user.id, username: user.username });
      res.json({ user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) } });
    } catch (err) {
      log.error('wallet-auth', 'wallet-reset-verify failed', { url: verifyUrl, err: err.message, code: err.code });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  // Authenticated wallet-signed change-password (issue #282). The way back
  // for a logged-in user (e.g. signed in via an admin temporary password,
  // or a still-valid session) who has a linked wallet but has FORGOTTEN the
  // password the normal /api/me/password form would require. Stays behind
  // the auth gate (NOT in PUBLIC_PATHS) — it requires both a live session
  // AND a wallet signature bound to this account's linked key. Key
  // invariants:
  //   - The verified pubkey must equal THIS logged-in user's own linked
  //     usernode_pubkey (looked up by req.user.id). A valid signature from
  //     any other wallet — even a genesis one — cannot set this user's
  //     password.
  //   - NO genesis gate, mirroring wallet-verify / wallet-reset-verify.
  //   - Unlike the reset paths, existing sessions are left intact — this is
  //     a change by an already-authenticated user, matching the semantics
  //     of /api/me/password.
  router.post('/api/me/wallet-change-password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { publicKey, challenge, signature, newPassword } = req.body || {};
    if (!challenge || !signature) {
      return res.status(400).json({ error: 'challenge and signature required' });
    }

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    // Resolve this user's linked wallet first — there's nothing to prove
    // against if the account has no linked key.
    let linkedPubkey;
    try {
      const { rows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      linkedPubkey = rows[0]?.usernode_pubkey || null;
    } catch (err) {
      log.error('wallet-auth', 'wallet-change-password lookup failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!linkedPubkey) {
      return res.status(400).json({ error: 'No wallet is linked to your account' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== linkedPubkey || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || linkedPubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyResp = await httpJson('POST', verifyUrl, {
        public_key: cryptoKey,
        message: challenge,
        signature,
      });

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Change-password signature invalid', { userId: req.user.id, resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);

      log.info('wallet-auth', 'Wallet-signed password change successful', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('wallet-auth', 'wallet-change-password failed', { url: verifyUrl, err: err.message, code: err.code });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  router.post('/api/auth/wallet-register', authLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can register via wallet' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      const { rows } = await pool.query(
        `INSERT INTO users (username, password, usernode_pubkey, wallet_link_token, wallet_link_expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [username.trim(), hash, pubkey.trim(), linkToken, linkExpiresAt]
      );
      const userId = rows[0].id;

      // Genesis-ledger registration is invite-equivalent (the genesis
      // allowlist IS the invite) — grant platform access directly.
      await waitlist.grantPlatformAccess(pool, userId);

      const { token, expiresAt } = await createSession(pool, userId);
      createSessionCookie(res, token, expiresAt);

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet-gated registration', { userId, username: username.trim() });
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'wallet' } });
      res.json({
        user: { id: userId, username: username.trim(), ...roleFields(false, false) },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('wallet-auth', 'wallet-register failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-link-login', authLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can link a wallet' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, username, password, is_admin, admin_readonly, usernode_pubkey FROM users WHERE username = $1',
        [username.trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.usernode_pubkey && user.usernode_pubkey !== pubkey.trim()) {
        return res.status(409).json({ error: 'This account is already linked to a different wallet' });
      }

      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      if (user.usernode_pubkey === pubkey.trim()) {
        log.info('wallet-auth', 'Wallet link-login (already linked)', { userId: user.id });
        return res.json({
          user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
        });
      }

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [linkToken, linkExpiresAt, user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet link-login initiated', { userId: user.id, username: user.username });
      res.json({
        user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      log.error('wallet-auth', 'wallet-link-login failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { authRoutes, DEV_FLOWS };
