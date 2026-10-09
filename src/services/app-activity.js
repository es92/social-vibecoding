'use strict';

const crypto = require('crypto');
const appAccess = require('./app-access');
const log = require('./logger');

const ACTIVITY_MAX_PER_POST = 3600;
const ACTIVITY_MAX_PER_DAY = 86400;
// The current UTC day plus the previous seven UTC dates are accepted. Client
// queues expire at seven elapsed days; the extra calendar edge avoids dropping
// a legitimate slice solely because its local retry crossed midnight.
const ACTIVITY_MAX_AGE_DAYS = 7;
const ACTIVITY_MAX_ENTRIES = 8;
const ACTIVITY_RECEIPT_RETENTION_DAYS = 30;
const ACTIVITY_RECEIPT_CLEANUP_MS = 6 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let nextReceiptCleanupAt = 0;
let receiptCleanup = null;

function activitySeconds(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  if (rounded <= 0) return null;
  return Math.min(rounded, ACTIVITY_MAX_PER_POST);
}

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || utcDay(ms) !== value) return null;
  return ms;
}

/**
 * Parse either the legacy `{ seconds }` heartbeat or a receipt-backed batch.
 * New batches are intentionally strict: the stable receipt represents exact
 * immutable content, so a malformed or over-limit batch is refused wholesale.
 */
function parseActivityRequest(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Object.prototype.hasOwnProperty.call(body, 'batchId')) {
    const seconds = activitySeconds(body.seconds);
    return seconds === null ? null : { legacy: true, seconds };
  }
  if (body.version !== 1 || typeof body.batchId !== 'string' || !UUID_RE.test(body.batchId)) {
    return null;
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1
      || body.entries.length > ACTIVITY_MAX_ENTRIES) return null;

  const today = parseDay(utcDay(now));
  const earliest = today - ACTIVITY_MAX_AGE_DAYS * 86_400_000;
  const seen = new Set();
  const entries = [];
  let total = 0;
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const at = parseDay(raw.date);
    if (at === null || at < earliest || at > today || seen.has(raw.date)) return null;
    if (typeof raw.seconds !== 'number' || !Number.isSafeInteger(raw.seconds)
        || raw.seconds <= 0) return null;
    total += raw.seconds;
    if (total > ACTIVITY_MAX_PER_POST) return null;
    seen.add(raw.date);
    entries.push({ date: raw.date, seconds: raw.seconds });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return {
    legacy: false,
    batchId: body.batchId.toLowerCase(),
    entries,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

class ActivityRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function purgeActivityReceipts(pool) {
  const result = await pool.query(
    `DELETE FROM app_activity_receipts
      WHERE received_at < NOW() - ($1 || ' days')::interval`,
    [String(ACTIVITY_RECEIPT_RETENTION_DAYS)]
  );
  return result.rowCount || 0;
}

function maybePurgeActivityReceipts(pool, now = Date.now()) {
  if (receiptCleanup || now < nextReceiptCleanupAt) return receiptCleanup || Promise.resolve(0);
  nextReceiptCleanupAt = now + ACTIVITY_RECEIPT_CLEANUP_MS;
  receiptCleanup = purgeActivityReceipts(pool).catch((error) => {
    log.debug('apps', 'Activity receipt cleanup failed', { message: error.message });
    return 0;
  }).finally(() => { receiptCleanup = null; });
  return receiptCleanup;
}

// The cleanup a commit starts is not awaited: it runs on another pooled
// connection and can finish at any later point. A test awaits it before it
// ages a receipt that it expects its own purge call to delete.
function _awaitReceiptCleanupForTests() {
  return receiptCleanup || Promise.resolve(0);
}

/**
 * Store one parsed modern batch. Receipt, day totals and first-day events are
 * one transaction, so retrying after a committed response was lost is a no-op.
 */
async function recordActivityBatch(pool, { slug, user, request }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const app = await appAccess.getAppForUser(
      client, slug, user, 'view', appAccess.ACCESS_COLUMNS
    );
    if (!app) throw new ActivityRequestError('not_found', 'App not found');

    const receipt = await client.query(
      `INSERT INTO app_activity_receipts
         (user_id, app_id, batch_id, payload_sha256)
       VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (user_id, batch_id) DO NOTHING
       RETURNING batch_id`,
      [user.id, app.id, request.batchId, request.payloadHash]
    );
    if (!receipt.rowCount) {
      const prior = await client.query(
        `SELECT app_id, payload_sha256
           FROM app_activity_receipts
          WHERE user_id = $1 AND batch_id = $2::uuid`,
        [user.id, request.batchId]
      );
      const same = prior.rows[0]
        && Number(prior.rows[0].app_id) === Number(app.id)
        && prior.rows[0].payload_sha256 === request.payloadHash;
      if (!same) throw new ActivityRequestError('batch_id_reused', 'Batch ID was reused');
      await client.query('COMMIT');
      void maybePurgeActivityReceipts(pool);
      return { duplicate: true };
    }

    const scoring = { appId: app.id, userId: user.id, seconds: 0, daySeconds: 0 };
    for (const entry of request.entries) {
      const activity = await client.query(
        `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
         VALUES ($1, $2, $3, $4::date)
         ON CONFLICT (app_id, user_id, date)
         DO UPDATE SET seconds_spent = LEAST(
           app_activity.seconds_spent + EXCLUDED.seconds_spent, $5)
         RETURNING (xmax = 0) AS inserted, seconds_spent`,
        [app.id, user.id, entry.seconds, entry.date, ACTIVITY_MAX_PER_DAY]
      );
      // All occurrence days commit together. Pass their combined increment
      // and totals to the crossing guard once, after the transaction commits.
      scoring.seconds += entry.seconds;
      scoring.daySeconds += Number(activity.rows[0]?.seconds_spent) || 0;
      if (activity.rows[0]?.inserted) {
        await client.query(
          `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
           VALUES ($1, $2, 'dapp_active_day', $3::jsonb,
             $4::date::timestamp AT TIME ZONE 'UTC')`,
          [user.id, app.id, JSON.stringify({
            batchId: request.batchId,
            source: 'engaged_usage',
            timestampPrecision: 'day',
          }), entry.date]
        );
      }
    }
    await client.query('COMMIT');
    void maybePurgeActivityReceipts(pool);
    return { duplicate: false, scoring };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIVITY_MAX_AGE_DAYS,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_MAX_PER_DAY,
  ACTIVITY_MAX_PER_POST,
  ACTIVITY_RECEIPT_RETENTION_DAYS,
  ActivityRequestError,
  activitySeconds,
  parseActivityRequest,
  purgeActivityReceipts,
  recordActivityBatch,
  _awaitReceiptCleanupForTests,
};
