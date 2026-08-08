'use strict';

const crypto = require('crypto');
const {
  CLIENT_ID,
  REQUIRED_SCOPES,
} = require('./cli-auth-constants');

const DEVICE_RE = /^svdev_[A-Za-z0-9_-]{43}$/;
const ACCESS_RE = /^svcli_[A-Za-z0-9_-]{43}$/;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// JSON.parse intentionally accepts duplicate object members. Security state
// requests and credential stores do not: a duplicated key is ambiguous to
// humans and to implementations in other languages. This small recursive
// scanner decodes object keys and rejects a duplicate at any nesting depth;
// JSON.parse remains the authority for all other JSON syntax.
function assertNoDuplicateJsonKeys(text) {
  let index = 0;
  const skipWhitespace = () => {
    while (/[\t\n\r ]/.test(text[index] || '')) index += 1;
  };
  const scanString = () => {
    const start = index;
    if (text[index] !== '"') throw new SyntaxError('expected JSON string');
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const scanValue = () => {
    skipWhitespace();
    if (text[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = scanString();
        if (keys.has(key)) throw new SyntaxError('duplicate JSON member');
        keys.add(key);
        skipWhitespace();
        if (text[index++] !== ':') throw new SyntaxError('expected colon');
        scanValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index++] !== ',') throw new SyntaxError('expected comma');
        skipWhitespace();
      }
      throw new SyntaxError('unterminated JSON object');
    }
    if (text[index] === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        scanValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index++] !== ',') throw new SyntaxError('expected comma');
      }
      throw new SyntaxError('unterminated JSON array');
    }
    if (text[index] === '"') {
      scanString();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(index)
    );
    if (!match) throw new SyntaxError('invalid JSON value');
    index += match[0].length;
  };
  scanValue();
  skipWhitespace();
  if (index !== text.length) throw new SyntaxError('trailing JSON data');
}

function parseStrictJson(text) {
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}

function makeOpaqueSecret(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function makeDeviceCode() {
  return makeOpaqueSecret('svdev_');
}

function makeAccessToken() {
  return makeOpaqueSecret('svcli_');
}

function isCanonicalSecret(value, kind) {
  if (typeof value !== 'string') return false;
  const re = kind === 'device' ? DEVICE_RE : ACCESS_RE;
  const prefixLength = kind === 'device' ? 6 : 6;
  if (!re.test(value)) return false;
  try {
    const decoded = Buffer.from(value.slice(prefixLength), 'base64url');
    return decoded.length === 32
      && decoded.toString('base64url') === value.slice(prefixLength);
  } catch {
    return false;
  }
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenHint(token) {
  return `svcli_…${token.slice(-4)}`;
}

function makeUserCode() {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) {
    raw += USER_CODE_ALPHABET[bytes[i] & 31];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function canonicalizeUserCode(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 32) {
    return null;
  }
  const compact = value.replace(/[\t\n\v\f\r \-]/g, '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function isExactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasExactScopes(scopes) {
  return Array.isArray(scopes)
    && scopes.length === REQUIRED_SCOPES.length
    && scopes.every((scope, index) => scope === REQUIRED_SCOPES[index]);
}

function noRequestPayload(req) {
  if (Object.keys(req.query || {}).length !== 0) return false;
  const length = req.headers['content-length'];
  const transfer = req.headers['transfer-encoding'];
  return !transfer && (length == null || length === '0');
}

function parseCanonicalPositiveBigint(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed > 9223372036854775807n) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function withTransaction(pool, fn) {
  // Route tests and a few embedded deployments provide a transaction-capable
  // query facade without pg.Pool#connect. Production pg pools always use a
  // dedicated checked-out client; the fallback still issues BEGIN/COMMIT.
  const checkedOut = typeof pool.connect === 'function';
  const client = checkedOut ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (checkedOut) client.release();
  }
}

async function acquireUserLock(client, userId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('cli-auth-user:' || $1::text, 0)
     )`,
    [userId]
  );
}

async function insertAudit(client, {
  eventType,
  occurredAt,
  userId = null,
  actorUserId = null,
  deviceAuthorizationId = null,
  accessTokenId = null,
  scopes = REQUIRED_SCOPES,
  outcome = 'success',
  metadata = {},
}) {
  await client.query(
    `INSERT INTO cli_auth_audit_events
       (event_type, occurred_at, user_id, actor_user_id,
        device_authorization_id, access_token_id, client_id, scopes,
        outcome, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::jsonb)`,
    [
      eventType,
      occurredAt,
      userId,
      actorUserId,
      deviceAuthorizationId,
      accessTokenId,
      CLIENT_ID,
      scopes,
      outcome,
      JSON.stringify(metadata),
    ]
  );
}

async function consumeSharedTokenBucket(pool, {
  namespace,
  subject,
  ratePerMinute,
  capacity,
}) {
  const key = crypto.createHash('sha256')
    .update(`${namespace}\0${subject}`, 'utf8')
    .digest('hex');
  try {
    return await withTransaction(pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('cli-auth-rate:' || $1, 0)
         )`,
        [key]
      );
      const { rows: nowRows } = await client.query(
        'SELECT clock_timestamp() AS now'
      );
      const now = new Date(nowRows[0].now);
      const { rows } = await client.query(
        `SELECT tokens, updated_at
           FROM cli_auth_rate_limits
          WHERE bucket_key = $1
          FOR UPDATE`,
        [key]
      );
      const priorTokens = rows.length ? Number(rows[0].tokens) : capacity;
      const priorTime = rows.length ? new Date(rows[0].updated_at) : now;
      const elapsedMinutes = Math.max(0, now.getTime() - priorTime.getTime()) / 60000;
      const available = Math.min(capacity, priorTokens + elapsedMinutes * ratePerMinute);
      const allowed = available >= 1;
      const remaining = allowed ? available - 1 : available;
      const retryAfter = allowed
        ? 0
        : Math.max(1, Math.ceil(((1 - available) / ratePerMinute) * 60));
      await client.query(
        `INSERT INTO cli_auth_rate_limits
         (bucket_key, tokens, updated_at, expires_at)
         VALUES ($1, $2, $3::timestamptz,
                 $3::timestamptz + INTERVAL '1 day')
         ON CONFLICT (bucket_key) DO UPDATE
           SET tokens = EXCLUDED.tokens,
               updated_at = EXCLUDED.updated_at,
               expires_at = EXCLUDED.expires_at`,
        [key, remaining, now]
      );
      return { allowed, retryAfter };
    });
  } catch (err) {
    err.cliRateLimitUnavailable = true;
    throw err;
  }
}

async function accountRecovery(client, {
  userId,
  actorUserId,
  updatePassword,
  mintSession,
}) {
  await acquireUserLock(client, userId);
  let userRows;
  if (updatePassword) {
    const updated = await updatePassword(client);
    userRows = updated?.rows || [];
  } else {
    const result = await client.query(
      `SELECT id, username, is_admin, admin_readonly
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    userRows = result.rows;
  }
  if (!userRows.length) return { found: false };

  await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

  const { rows: cancelled } = await client.query(
    `WITH db_now AS (SELECT clock_timestamp() AS now)
     UPDATE cli_device_authorizations d
        SET status = 'cancelled', cancelled_at = db_now.now
       FROM db_now
      WHERE d.user_id = $1
        AND d.status = 'approved'
        AND db_now.now < d.expires_at
     RETURNING d.id, d.scopes, d.cancelled_at`,
    [userId]
  );
  for (const row of cancelled) {
    await insertAudit(client, {
      eventType: 'authorization_cancelled',
      occurredAt: row.cancelled_at,
      userId,
      actorUserId,
      deviceAuthorizationId: row.id,
      scopes: row.scopes,
      metadata: { reason: 'account_recovery' },
    });
  }

  const { rows: revoked } = await client.query(
    `WITH db_now AS (SELECT clock_timestamp() AS now)
     UPDATE cli_access_tokens t
        SET revoked_at = db_now.now
       FROM db_now
      WHERE t.user_id = $1
        AND t.revoked_at IS NULL
        AND db_now.now < t.expires_at
     RETURNING t.id, t.scopes, t.revoked_at`,
    [userId]
  );
  for (const row of revoked) {
    await insertAudit(client, {
      eventType: 'token_revoked',
      occurredAt: row.revoked_at,
      userId,
      actorUserId,
      accessTokenId: row.id,
      scopes: row.scopes,
      metadata: { reason: 'account_recovery' },
    });
  }
  // #907: account recovery means "assume everything I had is compromised", so
  // every machine that attached with one of those credentials is detached in
  // the same transaction. Required for correctness, not just tidiness: a lease
  // that outlived recovery would keep routing that session's coding turns to
  // a machine the user no longer trusts.
  // eslint-disable-next-line global-require
  const localAgent = require('./local-agent');
  const detached = await localAgent.releaseLeasesForTokens(
    client, revoked.map((row) => row.id)
  );

  const session = mintSession ? await mintSession(client) : null;
  return {
    found: true,
    user: userRows[0],
    session,
    cancelled: cancelled.length,
    revoked: revoked.length,
    detached,
  };
}

async function cleanupCliAuth(pool) {
  return withTransaction(pool, async (client) => {
    const devices = await client.query(
      `DELETE FROM cli_device_authorizations
        WHERE (status IN ('pending', 'approved')
               AND clock_timestamp() >= expires_at + INTERVAL '24 hours')
           OR (status = 'consumed'
               AND clock_timestamp() >= consumed_at + INTERVAL '30 days')
           OR (status = 'rejected'
               AND clock_timestamp() >= rejected_at + INTERVAL '30 days')
           OR (status = 'cancelled'
               AND clock_timestamp() >= cancelled_at + INTERVAL '30 days')`
    );
    const tokens = await client.query(
      `DELETE FROM cli_access_tokens
        WHERE clock_timestamp() >=
          LEAST(expires_at, COALESCE(revoked_at, expires_at))
          + INTERVAL '90 days'`
    );
    const buckets = await client.query(
      `DELETE FROM cli_auth_rate_limits
        WHERE clock_timestamp() >= expires_at`
    );
    const audits = await client.query(
      `DELETE FROM cli_auth_audit_events
        WHERE occurred_at < clock_timestamp() - INTERVAL '1 year'`
    );
    return {
      deviceRows: devices.rowCount,
      tokenRows: tokens.rowCount,
      limiterRows: buckets.rowCount,
      auditRows: audits.rowCount,
    };
  });
}

module.exports = {
  DEVICE_RE,
  ACCESS_RE,
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
  accountRecovery,
  cleanupCliAuth,
  assertNoDuplicateJsonKeys,
  parseStrictJson,
};
