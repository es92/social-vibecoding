'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const {
  CLIENT_ID,
  CLIENT_NAME,
  IDENTITY_SCOPE,
  API_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  DEVICE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
} = require('../services/cli-auth-constants');
const {
  makeDeviceCode,
  makeAccessToken,
  isCanonicalSecret,
  hashSecret,
  tokenHint,
  makeUserCode,
  canonicalizeUserCode,
  isExactObject,
  hasExactScopes,
  noRequestPayload,
  parseCanonicalPositiveBigint,
  withTransaction,
  acquireUserLock,
  insertAudit,
  consumeSharedTokenBucket,
  assertNoDuplicateJsonKeys,
} = require('../services/cli-auth');
const { isCliApiPath } = require('../services/cli-api-policy');
const {
  READ_SCOPE: CONNECTOR_READ_SCOPE,
  WRITE_SCOPE: CONNECTOR_WRITE_SCOPE,
} = require('../services/mcp-connect-constants');
const { clientIp } = require('../services/client-ip');
// #907: the Settings "Local coding agent" block reads its list here, next to
// the CLI token list it sits under.
const localAgent = require('../services/local-agent');
const localAgentDemo = require('../services/local-agent-demo');
const log = require('../services/logger');

const APPROVAL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function isCliSurface(req) {
  const pathname = req.path;
  return pathname === '/cli/authorize'
    || pathname.startsWith('/api/cli/')
    || pathname === '/api/me/cli-tokens'
    || pathname.startsWith('/api/me/cli-tokens/');
}

// Is the CLI surface reachable at all in this deployment?
//
// THE ONE predicate — the two 404 gates below and the `cliAuthEnabled`
// capability flag on GET /api/auth/me all call it, so what the shell is
// told can never drift from what the server actually serves. That
// matters: the flag exists precisely so the Settings screen doesn't
// REQUEST a surface that is gated off (a 404 the client swallows is
// still a console error in the page, which fails proposal checks).
//
// Staging is deliberately excluded: a preview runs unreviewed PR code,
// and device-authorization / CLI token minting must not be reachable
// there. `config.cliAuthEnabled` carries the same exclusion (src/config.js
// derives it as `!staging`) plus the canonical-origin requirement; the
// explicit USERNODE_ENV check stays as defence in depth.
function isCliSurfaceEnabled(config) {
  return process.env.USERNODE_ENV !== 'staging' && !!config.cliAuthEnabled;
}

function cliAuthGate(config) {
  return (req, res, next) => {
    if (!isCliSurface(req)) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (!isCliSurfaceEnabled(config)) {
      return res.status(404).json({ error: 'not_found' });
    }
    return next();
  };
}

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

// Strict JSON body parser for the CLI surface: exact content-type, hard size
// cap, duplicate-key rejection. Parameterized by limit because the local
// coding-agent protocol (#907) posts progress batches and run summaries that
// legitimately exceed the 4kb every auth-flow payload fits in — the strictness
// is the point, not the specific number.
function jsonBody(limit) {
  return function parse(req, res, next) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    return express.json({
      limit,
      strict: true,
      verify(_request, _response, buffer) {
        assertNoDuplicateJsonKeys(buffer.toString('utf8'));
      },
    })(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'payload_too_large' });
      }
      return res.status(400).json({ error: 'invalid_request' });
    });
  };
}

const json4kb = jsonBody('4kb');

function rateLimited(res, retryAfter) {
  res.setHeader('Retry-After', String(Math.max(1, retryAfter || 1)));
  return res.status(429).json({ error: 'rate_limited' });
}

async function enforceBucket(pool, res, options) {
  try {
    const state = await consumeSharedTokenBucket(pool, options);
    if (!state.allowed) {
      rateLimited(res, state.retryAfter);
      return false;
    }
    return true;
  } catch {
    res.status(503).json({ error: 'temporarily_unavailable' });
    return false;
  }
}

function browserCsrf(config, req, res) {
  if (req.headers.origin !== config.cliAuthOrigin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

function readBearer(req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === 'authorization') {
      values.push(String(req.rawHeaders[i + 1] || ''));
    }
  }
  if (values.length === 0) return { error: 'missing_token' };
  if (values.length !== 1) return { error: 'invalid_token' };
  const match = /^Bearer (svcli_[A-Za-z0-9_-]{43})$/i.exec(values[0]);
  if (!match || !isCanonicalSecret(match[1], 'access')) {
    return { error: 'invalid_token' };
  }
  return { token: match[1] };
}

function bearerChallenge(res, error) {
  res.setHeader('WWW-Authenticate', `Bearer error="${error}"`);
  return res.status(401).json({ error });
}

function retainedTokenMiddleware(pool) {
  return async (req, res, next) => {
    const parsed = readBearer(req);
    if (parsed.error) return bearerChallenge(res, parsed.error);
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id, client_id, scopes, created_at, last_used_at,
                expires_at, revoked_at
           FROM cli_access_tokens
          WHERE token_hash = $1`,
        [hashSecret(parsed.token)]
      );
      if (!rows.length) return bearerChallenge(res, 'invalid_token');
      req.cliToken = rows[0];
      return next();
    } catch (err) {
      log.error('cli-auth', 'Retained token lookup failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  };
}

function activeTokenMiddleware(pool, scope, auditRoute) {
  const retained = retainedTokenMiddleware(pool);
  return [
    retained,
    async (req, res, next) => {
      const token = req.cliToken;
      const nowResult = await pool.query('SELECT clock_timestamp() AS now').catch(() => null);
      if (!nowResult) return res.status(503).json({ error: 'temporarily_unavailable' });
      const now = new Date(nowResult.rows[0].now);
      if (token.revoked_at) return bearerChallenge(res, 'revoked_token');
      if (now >= new Date(token.expires_at)) return bearerChallenge(res, 'expired_token');

      const rateOk = await enforceBucket(pool, res, {
        namespace: 'rpc-token',
        subject: String(token.id),
        ratePerMinute: 60,
        capacity: 60,
      });
      if (!rateOk) return undefined;

      let user;
      try {
        const { rows } = await pool.query(
          `SELECT id, username, is_admin, admin_readonly, app_quota,
                  ai_progress_estimate, locale
             FROM users WHERE id = $1`,
          [token.user_id]
        );
        if (!rows.length) return bearerChallenge(res, 'invalid_token');
        [user] = rows;
        const allowed = token.scopes.includes(scope);
        await insertAudit(pool, {
          eventType: 'token_used',
          occurredAt: now,
          userId: token.user_id,
          actorUserId: token.user_id,
          accessTokenId: token.id,
          scopes: token.scopes,
          outcome: allowed ? 'scope_authorized' : 'insufficient_scope',
          metadata: {
            method: req.method,
            route: typeof auditRoute === 'function' ? auditRoute(req) : auditRoute,
          },
        });
        if (!allowed) return res.status(403).json({ error: 'insufficient_scope' });
      } catch (err) {
        log.error('cli-auth', 'Token authorization audit failed', { message: err.message });
        return res.status(503).json({ error: 'temporarily_unavailable' });
      }

      req.user = {
        id: user.id,
        username: user.username,
        isAdmin: !!user.is_admin,
        adminReadonly: !!user.admin_readonly,
        canAdminWrite: !!user.is_admin && !user.admin_readonly,
        appQuota: user.app_quota ?? 0,
        aiProgressEstimate: !!user.ai_progress_estimate,
        locale: user.locale || null,
      };
      req.cliAuthenticated = true;
      pool.query(
        `UPDATE cli_access_tokens
            SET last_used_at = GREATEST(COALESCE(last_used_at, created_at), clock_timestamp())
          WHERE id = $1`,
        [token.id]
      ).catch((err) => {
        log.warn('cli-auth', 'last_used_at update failed', { message: err.message });
      });
      return next();
    },
  ];
}

function bearerIpGuard(pool, namespace = 'rpc-ip') {
  return async (req, res, next) => {
    const ok = await enforceBucket(pool, res, {
      namespace,
      subject: clientIp(req),
      ratePerMinute: 300,
      capacity: 300,
    });
    if (ok) next();
  };
}

// Is this request carrying a HOSTED CONNECTOR bearer (svmcp_…) rather than
// a CLI one (svcli_…)? The two credentials live in different tables with
// different policies, so the entry point routes on the token's shape.
function looksLikeConnectorBearer(req) {
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() !== 'authorization') continue;
    if (/^Bearer svmcp_/i.test(String(req.rawHeaders[i + 1] || ''))) return true;
  }
  return false;
}

// Connector chain. Deliberately NOT the CLI's `api:access` denylist: a token
// held by a third-party chat product gets an exhaustive, fail-closed
// allowlist of (method, path) pairs instead, so a new platform endpoint can
// never silently widen it.
//
// The tool handlers in services/mcp-tools.js reach the platform's ordinary
// routes through here over loopback, replaying the caller's own token —
// which is what makes "a connector can only do what this user can do" true
// by construction rather than by review.
function connectorApiBearerChain(config) {
  const pool = getPool(config);
  const { authenticateConnector, readConnectorBearer } = require('./mcp-remote');
  const { isConnectorApiRequest } = require('../services/cli-api-policy');
  // The tool handlers call these same routes over loopback, and every such
  // call arrives from the platform container's own address — so bucketing
  // them by IP would make one busy connector throttle every other one. Those
  // requests already paid a per-token budget at the /mcp edge, so the guard
  // is skipped for them and applied to everyone else. A direct external
  // caller holding a stolen token is bucketed normally.
  //
  // The check is on the real socket peer, never on a header: `trust proxy`
  // is off and only the configured proxy may supply req.clientIp, so a
  // request cannot claim to be loopback.
  const isInternalPeer = (req) => {
    const peer = (req.socket && req.socket.remoteAddress) || '';
    return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
      || (!!req.socket && peer === req.socket.localAddress);
  };

  return async (req, res, next) => {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!isInternalPeer(req)) {
      // enforceBucket answers the response itself on refusal (429 with
      // Retry-After) or on limiter failure (503) and returns false.
      const allowed = await enforceBucket(pool, res, {
        namespace: 'connector-ip',
        subject: clientIp(req),
        ratePerMinute: 300,
        capacity: 300,
      });
      if (!allowed) return undefined;
    }
    if (!isConnectorApiRequest(req.method, req.path)) {
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    const bearer = readConnectorBearer(req);
    if (bearer.error) {
      res.setHeader('WWW-Authenticate', `Bearer error="${bearer.error}"`);
      return res.status(401).json({ error: bearer.error });
    }
    let auth;
    try {
      auth = await authenticateConnector(pool, bearer.token);
    } catch (err) {
      log.error('cli-auth', 'connector token lookup failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    if (auth.error) {
      res.setHeader('WWW-Authenticate', `Bearer error="${auth.error}"`);
      return res.status(401).json({ error: auth.error });
    }
    // Writes need the write scope; reads need only the read scope. The
    // per-token request budget is enforced once, at the /mcp edge — these
    // loopback calls are downstream of a request that already paid it.
    const needsWrite = req.method !== 'GET';
    if (needsWrite && !auth.scopes.includes(CONNECTOR_WRITE_SCOPE)) {
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    if (!needsWrite && !auth.scopes.includes(CONNECTOR_READ_SCOPE)) {
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    req.user = auth.user;
    // The existing req.cliAuthenticated guards (issues.js's secret_change
    // refusal, the credential-management session check, the archive/vote
    // paths) all express "this is an automated non-browser caller", which
    // is exactly true here — so a connector inherits every one of them.
    req.cliAuthenticated = true;
    req.connectorClientId = auth.clientId;
    return next();
  };
}

function cliApiBearerAuth(config) {
  const pool = getPool(config);
  const chain = [
    bearerIpGuard(pool),
    (req, res, next) => {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return res.status(405).json({ error: 'method_not_allowed' });
      }
      return next();
    },
    ...activeTokenMiddleware(
      pool,
      API_SCOPE,
      (req) => req.path
    ),
  ];
  const connectorChain = [connectorApiBearerChain(config)];
  return (req, res, next) => {
    const hasAuthorization = req.rawHeaders.some(
      (value, index) => index % 2 === 0
        && String(value).toLowerCase() === 'authorization'
    );
    if (!hasAuthorization || !isCliApiPath(req.path)) return next();
    if (!isCliSurfaceEnabled(config)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'not_found' });
    }
    const active = looksLikeConnectorBearer(req) ? connectorChain : chain;
    const dispatch = (index, err) => {
      if (err) return next(err);
      if (index >= active.length) return next();
      try {
        const result = active[index](req, res, (nextError) => {
          dispatch(index + 1, nextError);
        });
        if (result && typeof result.catch === 'function') result.catch(next);
      } catch (error) {
        next(error);
      }
      return undefined;
    };
    return dispatch(0);
  };
}

function cliPreAuthRoutes(config) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const pool = getPool(config);

  router.use([
    '/api/cli',
    '/api/cli/*',
    '/api/me/cli-tokens',
    '/api/me/cli-tokens/*',
    '/cli/authorize',
  ], noStore);

  // The IP half of browser-code limits must run before cookie lookup.
  router.all(['/api/cli/device/approval', '/api/cli/device/approve'], async (req, res, next) => {
    const ok = await enforceBucket(pool, res, {
      namespace: 'approval-ip',
      subject: clientIp(req),
      ratePerMinute: 10,
      capacity: 10,
    });
    if (ok) next();
  });

  router.get('/cli/authorize', (_req, res) => {
    res.setHeader('Content-Security-Policy', APPROVAL_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.sendFile(path.join(__dirname, '../../public/cli-authorize.html'));
  });
  router.all('/cli/authorize', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.post('/api/cli/device/code', json4kb, async (req, res) => {
    if (!isExactObject(req.body, ['scopes'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (!hasExactScopes(req.body.scopes)) {
      return res.status(400).json({ error: 'invalid_scope' });
    }
    const ipAllowed = await enforceBucket(pool, res, {
      namespace: 'device-create-ip',
      subject: clientIp(req),
      ratePerMinute: config.cliDeviceCreateRatePerMinute || 10,
      capacity: config.cliDeviceCreateBurst || 20,
    });
    if (!ipAllowed) return undefined;

    try {
      const created = await withTransaction(pool, async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtextextended('cli-auth-device-admission', 0)
           )`
        );
        const { rows: countRows } = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE request_ip = $1::inet) AS ip_count,
             COUNT(*) AS global_count
           FROM cli_device_authorizations
          WHERE status IN ('pending', 'approved')
            AND clock_timestamp() < expires_at`,
          [clientIp(req)]
        );
        if (Number(countRows[0].ip_count) >= (config.cliDeviceLivePerIp || 10)
            || Number(countRows[0].global_count) >= (config.cliDeviceLiveGlobal || 10000)) {
          return { limited: true };
        }
        const { rows: nowRows } = await client.query('SELECT clock_timestamp() AS now');
        const now = nowRows[0].now;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const deviceCode = makeDeviceCode();
          const userCode = makeUserCode();
          const { rows } = await client.query(
            `INSERT INTO cli_device_authorizations
               (device_code_hash, user_code, client_id, scopes, request_ip,
                created_at, expires_at)
             VALUES ($1, $2, $3, $4::text[], $5::inet, $6,
                     $6::timestamptz + INTERVAL '10 minutes')
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [hashSecret(deviceCode), userCode, CLIENT_ID, REQUIRED_SCOPES, clientIp(req), now]
          );
          if (!rows.length) continue;
          await insertAudit(client, {
            eventType: 'authorization_started',
            occurredAt: now,
            deviceAuthorizationId: rows[0].id,
          });
          return { deviceCode, userCode };
        }
        throw new Error('device authorization collision retry exhausted');
      });
      if (created.limited) return rateLimited(res, 60);
      return res.json({
        device_code: created.deviceCode,
        user_code: created.userCode,
        verification_uri: `${config.cliAuthOrigin}/cli/authorize`,
        verification_uri_complete:
          `${config.cliAuthOrigin}/cli/authorize#code=${encodeURIComponent(created.userCode)}`,
        expires_in: DEVICE_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      });
    } catch (err) {
      log.error('cli-auth', 'Device authorization creation failed', {
        message: err.message.includes('collision') ? 'collision retry exhausted' : 'database unavailable',
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.post('/api/cli/device/token', json4kb, async (req, res) => {
    if (!isExactObject(req.body, ['device_code'])
        || typeof req.body.device_code !== 'string') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const ipAllowed = await enforceBucket(pool, res, {
      namespace: 'device-poll-ip',
      subject: clientIp(req),
      ratePerMinute: 120,
      capacity: 30,
    });
    if (!ipAllowed) return undefined;
    if (!isCanonicalSecret(req.body.device_code, 'device')) {
      return res.status(400).json({ error: 'expired_token' });
    }
    const deviceHash = hashSecret(req.body.device_code);
    try {
      const { rows: probeRows } = await pool.query(
        `SELECT user_id
           FROM cli_device_authorizations
          WHERE device_code_hash = $1
            AND status = 'approved'`,
        [deviceHash]
      );
      const userId = probeRows[0]?.user_id || null;
      const result = await withTransaction(pool, async (client) => {
        if (userId) await acquireUserLock(client, userId);
        const { rows } = await client.query(
          `SELECT *
             FROM cli_device_authorizations
            WHERE device_code_hash = $1
            FOR UPDATE`,
          [deviceHash]
        );
        if (!rows.length) return { error: 'expired_token' };
        const device = rows[0];
        const { rows: nowRows } = await client.query('SELECT clock_timestamp() AS now');
        const now = new Date(nowRows[0].now);
        if (now >= new Date(device.expires_at)) return { error: 'expired_token' };
        if (device.status === 'rejected' || device.status === 'cancelled') {
          return { error: 'access_denied' };
        }
        if (device.status === 'consumed') return { error: 'expired_token' };
        const prior = device.last_polled_at
          ? new Date(device.last_polled_at)
          : new Date(device.created_at);
        const tooSoon = now.getTime() - prior.getTime() < POLL_INTERVAL_SECONDS * 1000;
        await client.query(
          `UPDATE cli_device_authorizations
              SET last_polled_at = $2, poll_count = poll_count + 1
            WHERE id = $1`,
          [device.id, now]
        );
        if (tooSoon) return { error: 'slow_down' };
        if (device.status === 'pending') return { error: 'authorization_pending' };
        if (device.status !== 'approved' || !device.user_id) {
          return { error: 'expired_token' };
        }
        // Approval may have committed after the nonlocking probe. Do not
        // issue without the approver's advisory lock; the next poll will
        // observe the approved row before entering its transaction.
        if (!userId) return { error: 'authorization_pending' };

        for (let attempt = 0; attempt < 8; attempt += 1) {
          const accessToken = makeAccessToken();
          const { rows: tokenRows } = await client.query(
            `INSERT INTO cli_access_tokens
               (token_hash, token_hint, user_id, client_id, scopes,
                created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5::text[], $6,
                     $6::timestamptz + INTERVAL '30 days')
             ON CONFLICT DO NOTHING
             RETURNING id, expires_at`,
            [
              hashSecret(accessToken),
              tokenHint(accessToken),
              device.user_id,
              CLIENT_ID,
              device.scopes,
              now,
            ]
          );
          if (!tokenRows.length) continue;
          await insertAudit(client, {
            eventType: 'token_issued',
            occurredAt: now,
            userId: device.user_id,
            actorUserId: device.user_id,
            deviceAuthorizationId: device.id,
            accessTokenId: tokenRows[0].id,
            scopes: device.scopes,
          });
          await client.query(
            `UPDATE cli_device_authorizations
                SET status = 'consumed', consumed_at = $2
              WHERE id = $1`,
            [device.id, now]
          );
          return {
            accessToken,
            expiresAt: tokenRows[0].expires_at,
          };
        }
        throw new Error('access token collision retry exhausted');
      });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        scope: REQUIRED_SCOPE_TEXT,
        expires_in: ACCESS_TTL_SECONDS,
        expires_at: new Date(result.expiresAt).toISOString(),
      });
    } catch (err) {
      log.error('cli-auth', 'Device token exchange failed', {
        message: err.message.includes('collision') ? 'collision retry exhausted' : 'database unavailable',
      });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  const retainedIpGuard = async (req, res, next) => {
    const ok = await enforceBucket(pool, res, {
      namespace: 'retained-token-ip',
      subject: clientIp(req),
      ratePerMinute: 60,
      capacity: 60,
    });
    if (ok) next();
  };
  const retained = retainedTokenMiddleware(pool);

  router.all('/api/cli/token/status', (req, res, next) => {
    if (req.method !== 'GET') return res.status(400).json({ error: 'invalid_request' });
    next();
  });
  router.get('/api/cli/token/status', retainedIpGuard, (req, res, next) => {
    if (!noRequestPayload(req)) return res.status(400).json({ error: 'invalid_request' });
    next();
  }, retained, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT clock_timestamp() AS now');
      const status = req.cliToken.revoked_at
        ? 'revoked'
        : new Date(rows[0].now) >= new Date(req.cliToken.expires_at)
          ? 'expired'
          : 'valid';
      return res.json({
        status,
        client_id: req.cliToken.client_id,
        scopes: req.cliToken.scopes,
        created_at: new Date(req.cliToken.created_at).toISOString(),
        expires_at: new Date(req.cliToken.expires_at).toISOString(),
      });
    } catch (err) {
      log.error('cli-auth', 'Token status failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.all('/api/cli/token/current', (req, res, next) => {
    if (req.method !== 'DELETE') return res.status(400).json({ error: 'invalid_request' });
    next();
  });
  router.delete('/api/cli/token/current', retainedIpGuard, (req, res, next) => {
    if (!noRequestPayload(req)) return res.status(400).json({ error: 'invalid_request' });
    next();
  }, retained, async (req, res) => {
    try {
      let detached = null;
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `WITH db_now AS (SELECT clock_timestamp() AS now)
           UPDATE cli_access_tokens t
              SET revoked_at = db_now.now
             FROM db_now
            WHERE t.id = $1 AND t.revoked_at IS NULL
           RETURNING t.revoked_at`,
          [req.cliToken.id]
        );
        if (rows.length) {
          await insertAudit(client, {
            eventType: 'token_revoked',
            occurredAt: rows[0].revoked_at,
            userId: req.cliToken.user_id,
            actorUserId: req.cliToken.user_id,
            accessTokenId: req.cliToken.id,
            scopes: req.cliToken.scopes,
            metadata: { reason: 'self' },
          });
          // #907: a machine attached with this credential is detached by the
          // same act, inside the same transaction.
          detached = await localAgent.releaseLeasesForTokens(client, req.cliToken.id);
        }
      });
      localAgent.notifyReleased(detached);
      return res.status(204).end();
    } catch (err) {
      log.error('cli-auth', 'Self revocation failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.use('/api/cli/rpc/me', (req, res, next) => {
    if (req.path !== '/' && req.path !== '') return res.status(404).json({ error: 'not_found' });
    if (req.method !== 'GET' || req.originalUrl !== '/api/cli/rpc/me'
        || !noRequestPayload(req)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    next();
  });
  router.get(
    '/api/cli/rpc/me',
    bearerIpGuard(pool),
    ...activeTokenMiddleware(pool, IDENTITY_SCOPE, '/api/cli/rpc/me'),
    (req, res) => res.json({ user: { id: req.user.id, username: req.user.username } })
  );
  // Unknown global-RPC paths are resolved here, before cookie middleware,
  // so an ambient browser session cannot change their behavior.
  router.all('/api/cli/rpc/*', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // #907: the local coding-agent protocol. Mounted here — bearer-only, before
  // the terminal /api/cli 404 and before any cookie middleware — so it gets
  // the same no-store headers, the same staging gate, and the same "an
  // ambient browser session cannot influence this" property as device login.
  // Required lazily: cli-agent.js needs the middleware built above.
  // eslint-disable-next-line global-require
  const { cliAgentRoutes } = require('./cli-agent');
  router.use('/api/cli/agent', cliAgentRoutes(config, {
    pool,
    auth: { jsonBody, activeTokenMiddleware, bearerIpGuard },
  }));

  // The two browser-session device paths intentionally continue into cookie
  // auth. Every other unmatched CLI path terminates here so an ambient
  // session or the SPA fallback cannot change its behavior.
  router.use('/api/cli', (req, res, next) => {
    if (req.path === '/device/approval' || req.path === '/device/approve') {
      return next();
    }
    return res.status(404).json({ error: 'not_found' });
  });

  return router;
}

function encodeCursor(config, row) {
  const payload = Buffer.from(JSON.stringify({
    created_at: new Date(row.created_at).toISOString(),
    id: String(row.id),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

// Fabricated credential rows for the Settings screen's "CLI & coding-agent
// access" section in staging. cli_access_tokens is `staging:private`, so a
// staging clone copies the schema and none of the rows — without these the
// section reviews as an empty panel and its dapp.json test has nothing to
// assert on. Obviously-fake hints, no real ids (the client suppresses Revoke
// on `demo` rows), never reachable outside USERNODE_ENV=staging.
function demoCliTokens() {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  return [
    {
      id: 'staging-demo-cli-1',
      token_hint: 'svc_staging-demo…a1b2',
      client_id: 'social-vibecoding-cli',
      scopes: ['api'],
      created_at: iso(now - 3 * day),
      last_used_at: iso(now - 2 * 60 * 60 * 1000),
      expires_at: iso(now + 27 * day),
      revoked_at: null,
      status: 'valid',
      demo: true,
    },
    {
      id: 'staging-demo-cli-2',
      token_hint: 'svc_staging-demo…c3d4',
      client_id: 'claude-code',
      scopes: ['api'],
      created_at: iso(now - 21 * day),
      last_used_at: iso(now - 14 * day),
      expires_at: iso(now + 9 * day),
      revoked_at: iso(now - 10 * day),
      status: 'revoked',
      demo: true,
    },
  ];
}

function decodeCursor(config, value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  // HMAC-SHA256's unpadded base64url representation is exactly 43 ASCII
  // bytes. Validate that representation before timingSafeEqual: JS string
  // length counts UTF-16 code units, not encoded bytes, and the crypto API
  // throws when buffer sizes differ.
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret)
    .update(parts[0])
    .digest('base64url');
  const suppliedBuffer = Buffer.from(parts[1], 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  if (suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!isExactObject(parsed, ['created_at', 'id'])) return null;
    const id = parseCanonicalPositiveBigint(parsed.id);
    const date = new Date(parsed.created_at);
    if (!id || !Number.isFinite(date.getTime()) || date.toISOString() !== parsed.created_at) {
      return null;
    }
    return { id, createdAt: parsed.created_at };
  } catch {
    return null;
  }
}

function cliBrowserRoutes(config) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const pool = getPool(config);

  router.use([
    '/api/cli/device/approval',
    '/api/cli/device/approve',
    '/api/me/cli-tokens',
    '/api/me/cli-tokens/*',
    '/api/me/local-agents',
    '/api/me/local-agents/*',
  ], noStore);

  async function userRate(req, res, next) {
    // Both Settings lists share the generous settings bucket; only the
    // device-approval paths keep the tight one.
    const settings = req.path.startsWith('/api/me/cli-tokens')
      || req.path.startsWith('/api/me/local-agents');
    const ok = await enforceBucket(pool, res, {
      namespace: settings ? 'settings-user' : 'approval-user',
      subject: String(req.user.id),
      ratePerMinute: settings ? 60 : 10,
      capacity: settings ? 60 : 10,
    });
    if (ok) next();
  }

  router.get('/api/cli/device/approval', userRate, async (req, res) => {
    const keys = Object.keys(req.query || {});
    if (keys.length !== 1 || keys[0] !== 'user_code'
        || Array.isArray(req.query.user_code)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const code = canonicalizeUserCode(req.query.user_code);
    if (!code) return res.status(404).json({ error: 'invalid_or_expired_code' });
    try {
      const { rows } = await pool.query(
        `SELECT user_code, scopes, expires_at, status, user_id
           FROM cli_device_authorizations
          WHERE user_code = $1
            AND clock_timestamp() < expires_at`,
        [code]
      );
      const row = rows[0];
      if (!row
          || !['pending', 'approved'].includes(row.status)
          || (row.status === 'approved' && row.user_id !== req.user.id)) {
        return res.status(404).json({ error: 'invalid_or_expired_code' });
      }
      return res.json({
        user_code: row.user_code,
        client_name: CLIENT_NAME,
        scopes: row.scopes,
        expires_at: new Date(row.expires_at).toISOString(),
      });
    } catch (err) {
      log.error('cli-auth', 'Approval metadata failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.post('/api/cli/device/approve', userRate, json4kb, async (req, res) => {
    if (!browserCsrf(config, req, res)) return undefined;
    if (!isExactObject(req.body, ['user_code', 'decision'])
        || typeof req.body.user_code !== 'string'
        || !['approve', 'reject'].includes(req.body.decision)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const code = canonicalizeUserCode(req.body.user_code);
    if (!code) return res.status(404).json({ error: 'invalid_or_expired_code' });
    try {
      const outcome = await withTransaction(pool, async (client) => {
        await acquireUserLock(client, req.user.id);
        const sessionToken = req.cookies?.session;
        const { rows: sessionRows } = await client.query(
          `SELECT 1 FROM sessions
            WHERE token = $1 AND user_id = $2
              AND clock_timestamp() < expires_at`,
          [sessionToken || '', req.user.id]
        );
        if (!sessionRows.length) return { authLost: true };
        const { rows } = await client.query(
          `SELECT *
             FROM cli_device_authorizations
            WHERE user_code = $1
            FOR UPDATE`,
          [code]
        );
        const device = rows[0];
        if (!device) {
          return { invalid: true };
        }
        const { rows: nowRows } = await client.query('SELECT clock_timestamp() AS now');
        const now = nowRows[0].now;
        if (new Date(now) >= new Date(device.expires_at)) return { invalid: true };
        const wanted = req.body.decision === 'approve' ? 'approved' : 'rejected';
        if (device.status === wanted && device.user_id === req.user.id) {
          return { success: true };
        }
        if (['approved', 'rejected'].includes(device.status)
            && device.user_id === req.user.id) return { conflict: true };
        if (device.status !== 'pending' || device.user_id != null) return { invalid: true };
        await client.query(
          `UPDATE cli_device_authorizations
              SET status = $2,
                  user_id = $3,
                  approved_at = CASE WHEN $2 = 'approved'
                    THEN $4::timestamptz ELSE NULL END,
                  rejected_at = CASE WHEN $2 = 'rejected'
                    THEN $4::timestamptz ELSE NULL END
            WHERE id = $1`,
          [device.id, wanted, req.user.id, now]
        );
        await insertAudit(client, {
          eventType: wanted === 'approved'
            ? 'authorization_approved'
            : 'authorization_rejected',
          occurredAt: now,
          userId: req.user.id,
          actorUserId: req.user.id,
          deviceAuthorizationId: device.id,
          scopes: device.scopes,
        });
        return { success: true };
      });
      if (outcome.authLost) return res.status(401).json({ error: 'not_authenticated' });
      if (outcome.invalid) return res.status(404).json({ error: 'invalid_or_expired_code' });
      if (outcome.conflict) return res.status(409).json({ error: 'decision_conflict' });
      return res.status(204).end();
    } catch (err) {
      log.error('cli-auth', 'Approval decision failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.get('/api/me/cli-tokens', userRate, async (req, res) => {
    const allowed = new Set(['limit', 'cursor', 'demo']);
    const keys = Object.keys(req.query || {});
    if (keys.some((key) => !allowed.has(key))
        || keys.some((key) => Array.isArray(req.query[key]))) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    // Staging mock data: cli_access_tokens is `staging:private` (schema.sql),
    // so a staging clone always has an empty list and the Settings section
    // would review as a blank panel. ?demo=1 fabricates two rows without
    // touching the DB — same pattern as GET /api/me/llm-grants and
    // GET /api/me/agent-files, and a strict no-op in production.
    if (req.query.demo === '1' && process.env.USERNODE_ENV === 'staging') {
      return res.json({ tokens: demoCliTokens(), next_cursor: null, demo: true });
    }

    const limitText = req.query.limit == null ? '50' : req.query.limit;
    if (!/^[1-9][0-9]*$/.test(limitText)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || limit > 100) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const cursor = req.query.cursor == null
      ? null
      : decodeCursor(config, req.query.cursor);
    if (req.query.cursor != null && !cursor) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const params = [req.user.id, limit + 1];
    let cursorSql = '';
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorSql = 'AND (created_at, id) < ($3::timestamptz, $4::bigint)';
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, token_hint, client_id, scopes, created_at, last_used_at,
                expires_at, revoked_at, clock_timestamp() AS db_now
           FROM cli_access_tokens
          WHERE user_id = $1
            ${cursorSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        params
      );
      const more = rows.length > limit;
      const selected = rows.slice(0, limit);
      const tokens = selected.map((row) => ({
        id: String(row.id),
        token_hint: row.token_hint,
        client_id: row.client_id,
        scopes: row.scopes,
        created_at: new Date(row.created_at).toISOString(),
        last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        expires_at: new Date(row.expires_at).toISOString(),
        revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        status: row.revoked_at
          ? 'revoked'
          : new Date(row.db_now) >= new Date(row.expires_at) ? 'expired' : 'valid',
      }));
      return res.json({
        tokens,
        next_cursor: more ? encodeCursor(config, selected[selected.length - 1]) : null,
      });
    } catch (err) {
      log.error('cli-auth', 'Token list failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.delete('/api/me/cli-tokens/:id', userRate, async (req, res) => {
    if (!browserCsrf(config, req, res)) return undefined;
    if (!noRequestPayload(req)) return res.status(400).json({ error: 'invalid_request' });
    const id = parseCanonicalPositiveBigint(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_request' });
    try {
      let detached = null;
      const found = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `SELECT id, user_id, scopes, revoked_at
             FROM cli_access_tokens
            WHERE id = $1 AND user_id = $2
            FOR UPDATE`,
          [id, req.user.id]
        );
        if (!rows.length) return false;
        if (!rows[0].revoked_at) {
          const { rows: nowRows } = await client.query('SELECT clock_timestamp() AS now');
          const now = nowRows[0].now;
          await client.query(
            'UPDATE cli_access_tokens SET revoked_at = $2 WHERE id = $1',
            [id, now]
          );
          await insertAudit(client, {
            eventType: 'token_revoked',
            occurredAt: now,
            userId: req.user.id,
            actorUserId: req.user.id,
            accessTokenId: id,
            scopes: rows[0].scopes,
            metadata: { reason: 'settings' },
          });
          // #907: revoking from Settings also detaches whatever machine had
          // attached with this credential.
          detached = await localAgent.releaseLeasesForTokens(client, id);
        }
        return true;
      });
      localAgent.notifyReleased(detached);
      return found ? res.status(204).end() : res.status(404).json({ error: 'not_found' });
    } catch (err) {
      log.error('cli-auth', 'Settings revocation failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // #907: the machines currently holding a coding lease, for the Settings
  // "Local coding agent" block. Deliberately NOT under /api/me/cli-tokens and
  // NOT an isCliSurface() path: a lease is not a credential (it grants
  // nothing — it only says "this session's next turn goes to that machine"),
  // and unlike the token list it stays reviewable on staging, where the whole
  // CLI surface 404s.
  router.get('/api/me/local-agents', userRate, async (req, res) => {
    const keys = Object.keys(req.query || {});
    if (keys.some((key) => key !== 'demo') || Array.isArray(req.query.demo)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (localAgentDemo.isStagingDemo(req)) {
      return res.json({ agents: localAgentDemo.demoLocalAgents(), demo: true });
    }
    try {
      const rows = await localAgent.activeLeasesForUser(pool, req.user.id);
      return res.json({
        agents: rows.map((row) => ({
          ...localAgent.publicLease(row),
          appSlug: row.app_slug,
          appName: row.app_name,
          sessionTitle: row.session_title,
          branch: row.branch_name,
        })),
      });
    } catch (err) {
      log.error('cli-auth', 'Local agent list failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // Detach from the browser. The machine finds out on its next heartbeat and
  // stops long-polling; this is the escape hatch for a laptop that was closed
  // without running `social-vibecoding agent detach`, so it must not require
  // that laptop to cooperate.
  router.delete('/api/me/local-agents/:leaseId', userRate, async (req, res) => {
    if (!browserCsrf(config, req, res)) return undefined;
    if (!noRequestPayload(req)) return res.status(400).json({ error: 'invalid_request' });
    const leaseId = parseCanonicalPositiveBigint(req.params.leaseId);
    if (!leaseId) return res.status(400).json({ error: 'invalid_request' });
    try {
      const released = await localAgent.release(pool, {
        leaseId, userId: req.user.id, reason: 'settings',
      });
      return released ? res.status(204).end() : res.status(404).json({ error: 'not_found' });
    } catch (err) {
      log.error('cli-auth', 'Local agent detach failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  router.all([
    '/api/cli/device/approval',
    '/api/cli/device/approve',
    '/api/me/cli-tokens',
    '/api/me/cli-tokens/*',
    '/api/me/local-agents',
    '/api/me/local-agents/*',
  ], (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}

module.exports = {
  cliAuthGate,
  cliApiBearerAuth,
  cliPreAuthRoutes,
  cliBrowserRoutes,
  isCliSurface,
  isCliSurfaceEnabled,
  json4kb,
  jsonBody,
  // #907: the local coding-agent protocol reuses the exact bearer/scope/
  // rate-limit chain the rest of the CLI surface runs on, rather than
  // growing a parallel one that could drift out of step with it.
  activeTokenMiddleware,
  bearerIpGuard,
  readBearer,
  decodeCursor,
};
