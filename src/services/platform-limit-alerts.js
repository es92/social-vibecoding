'use strict';

// Early warning for the platform's server-wide caps.
//
// Two ceilings bound the whole server rather than one person or one app:
//
//   apps      MAX_APPS — every non-errored app on the host. A hard wall:
//             past it, POST /api/apps and /fork answer 429 "This server is
//             at its app limit" to everyone but full admins.
//   sessions  MAX_GLOBAL_SESSIONS — active + promoted coding workers. A soft
//             wall: at it, starting or reopening a session pauses somebody
//             else's idle one, and 429s "Platform is at capacity" when
//             nothing is idle.
//
// Until now the first anybody heard of either was a user reading that
// refusal and asking an admin to raise the limit. This module measures each
// cap and tells the full admins (the only people who can raise one) twice
// on the way up: once at PLATFORM_LIMIT_WARN_PERCENT of the cap, and again
// when the cap is reached.
//
// `decide()` below is the whole policy, pure, so
// tests/platform-limit-alerts.test.js pins every transition without a
// database:
//
//   ok --(>= warn line)--> warn --(>= cap)--> full
//
// Upward transitions notify; downward ones only re-arm, and only once the
// count has fallen a margin (REARM_RATIO) under the line it crossed. The
// margin is the point. The session count moves every minute, and without it
// a server idling at the warning line would page every admin each time one
// session paused and another started. The same rule keeps "full" from
// repeating when one app is deleted and the next one created.
//
// The level last reached is kept per cap in platform_limit_alerts, read and
// written under a row lock in the same transaction that inserts the
// notifications, so the leader's sweep and a create route racing it cannot
// both claim the same crossing.
//
// Evaluated in two places: the leader's sweep (server.js,
// startPlatformLimitSweeper) for both caps, and — for apps only — right
// after a create or fork succeeds or is refused at the cap, so the alert
// does not wait for the next sweep.
//
// STAGING: a preview's users table is a clone of production's, so a
// notification there would reach real admins' phones about a throwaway
// copy. The level is still recorded; the notifications are skipped (same
// stance as services/app-storage-cap.js).

const log = require('./logger');
const { withTransaction } = require('./cli-auth');

const DEFAULT_WARN_PERCENT = 80;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A level re-arms once the count is this far under the line it crossed.
const REARM_RATIO = 0.9;

const LEVELS = Object.freeze(['ok', 'warn', 'full']);
const RANK = Object.freeze({ ok: 0, warn: 1, full: 2 });

// The caps this watches. `count` must be the exact query the enforcing
// route uses, so the alert can never disagree with the refusal.
const LIMITS = Object.freeze([
  Object.freeze({
    key: 'apps',
    envKey: 'MAX_APPS',
    cap: (config) => Number(config && config.maxApps),
    async count(pool) {
      // routes/apps.js POST /api/apps and /fork; services/app-allowance.js.
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`
      );
      return Number(rows[0] && rows[0].n);
    },
  }),
  Object.freeze({
    key: 'sessions',
    envKey: 'MAX_GLOBAL_SESSIONS',
    cap: (config) => Number(config && config.maxGlobalSessions),
    async count(pool) {
      // routes/sessions.js — the global-cap probe every start/resume runs.
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM chat_sessions
          WHERE status IN ('active', 'promoted')
            AND source IS DISTINCT FROM 'imported'
            AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)`
      );
      return Number(rows[0] && rows[0].n);
    },
  }),
]);
const LIMIT_BY_KEY = new Map(LIMITS.map((limit) => [limit.key, limit]));

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// Read at call time so a value set in the Platform variables panel applies
// on the first sweep after the deploy that carries it, and tests can set it
// without re-requiring the module. Declared in dapp.json's platform_env.
function warnPercent() {
  const n = parseInt(process.env.PLATFORM_LIMIT_WARN_PERCENT || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : DEFAULT_WARN_PERCENT;
}

// The count at which each level begins, or null when the cap is off
// (MAX_APPS <= 0 disables the app cap; a non-number is treated the same).
function lines(cap, percent) {
  const c = Number(cap);
  if (!Number.isFinite(c) || c <= 0) return null;
  const whole = Math.floor(c);
  return { warn: Math.max(1, Math.ceil((whole * percent) / 100)), full: whole };
}

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'ok';
}

/**
 * The policy, pure. Given the count, the cap, the warning percent and the
 * level last recorded, returns the level to record now and the level to
 * notify about (null for none).
 *
 *   - a rise to a higher level notifies that level (a jump from ok straight
 *     to full notifies only full);
 *   - staying put notifies nothing;
 *   - a fall re-arms a level only once the count is under
 *     REARM_RATIO x that level's line, and never notifies;
 *   - a cap that is off records ok, so switching it back on starts clean.
 */
function decide({ used, cap, percent = DEFAULT_WARN_PERCENT, level }) {
  const at = lines(cap, percent);
  const stored = normalizeLevel(level);
  if (!at) return { level: 'ok', notify: null };
  const n = Number.isFinite(Number(used)) && Number(used) > 0 ? Number(used) : 0;
  const raw = n >= at.full ? 'full' : (n >= at.warn ? 'warn' : 'ok');
  if (RANK[raw] > RANK[stored]) return { level: raw, notify: raw };
  if (RANK[raw] === RANK[stored]) return { level: stored, notify: null };
  let held = stored;
  if (held === 'full' && n < at.full * REARM_RATIO) held = 'warn';
  if (held === 'warn' && n < at.warn * REARM_RATIO) held = 'ok';
  return { level: held, notify: null };
}

// notifications.detail token: "<limit>_<level>:<used>:<cap>", e.g.
// "apps_warn:40:50". The drawer and the push copy parse it back; neither
// shows it raw. Figures are clamped to seven digits so the widest token
// ("sessions_full:9999999:9999999", 29) stays inside the 32 characters every
// creator keeps to.
const MAX_FIGURE = 9999999;

function figure(n) {
  return Math.min(MAX_FIGURE, Math.max(0, Math.floor(Number(n) || 0)));
}

function detailToken(key, level, used, cap) {
  return `${key}_${level}:${figure(used)}:${figure(cap)}`;
}

const DETAIL_RE = /^(apps|sessions)_(warn|full):(\d{1,7}):(\d{1,7})$/;

function parseDetail(detail) {
  const m = DETAIL_RE.exec(String(detail || ''));
  if (!m) return null;
  return { limit: m[1], level: m[2], used: Number(m[3]), cap: Number(m[4]) };
}

// Resolved at call time so a test can swap either without a database.
function defaultCreate(db, args) {
  return require('./notifications').createPlatformLimitNotifications(db, args);
}
function defaultPublish(pool, row) {
  return require('./notifications').hydrateAndPush(pool, row);
}

/**
 * Measure one cap and apply `decide()` to it. Returns
 * { key, used, cap, level, notified } and never notifies twice for one
 * crossing, however many callers race it.
 *
 * deps.create   overrides notifications.createPlatformLimitNotifications
 * deps.publish  overrides notifications.hydrateAndPush
 * deps.staging  overrides the USERNODE_ENV check
 */
async function evaluate(pool, config, key, deps = {}) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit) throw new Error(`unknown platform limit: ${key}`);
  const cap = limit.cap(config);
  const percent = warnPercent();
  const used = await limit.count(pool);
  if (!Number.isFinite(used) || used < 0) throw new Error(`bad ${key} count`);
  const staging = deps.staging ?? isStaging();
  const create = deps.create || defaultCreate;
  const publish = deps.publish || defaultPublish;

  const outcome = await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO platform_limit_alerts (limit_key) VALUES ($1)
       ON CONFLICT (limit_key) DO NOTHING`,
      [key]
    );
    const { rows } = await db.query(
      'SELECT level FROM platform_limit_alerts WHERE limit_key = $1 FOR UPDATE',
      [key]
    );
    const decision = decide({ used, cap, percent, level: rows[0] && rows[0].level });
    await db.query(
      `UPDATE platform_limit_alerts
          SET level = $2, used = $3, cap = $4, measured_at = NOW(),
              notified_at = CASE WHEN $5::boolean THEN NOW() ELSE notified_at END
        WHERE limit_key = $1`,
      [key, decision.level, used, Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null,
        !!decision.notify]
    );
    let inserted = [];
    if (decision.notify && !staging) {
      inserted = await create(db, {
        detail: detailToken(key, decision.notify, used, cap),
      });
    }
    return { decision, inserted };
  });

  if (outcome.decision.notify) {
    log.info('platform-limits', 'Platform limit crossed', {
      limit: key, level: outcome.decision.notify, used, cap, percent,
      recipients: outcome.inserted.length, staging,
    });
  }
  for (const row of outcome.inserted) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
  return {
    key, used, cap, level: outcome.decision.level,
    notified: outcome.decision.notify, recipients: outcome.inserted.length,
  };
}

/** Evaluate every cap. Never throws; errors are collected per cap. */
async function sweep(pool, config, deps = {}) {
  const summary = { results: [], errors: [] };
  for (const limit of LIMITS) {
    try {
      summary.results.push(await evaluate(pool, config, limit.key, deps));
    } catch (err) {
      summary.errors.push(`${limit.key}: ${err.message}`);
      log.warn('platform-limits', 'Platform limit check failed', { limit: limit.key, err: err.message });
    }
  }
  return summary;
}

/**
 * Fire-and-forget for request paths: evaluate one cap after the response
 * has been decided, never throw, never delay the caller. A no-op when the
 * cap is off, so route tests that mount with `maxApps: 0` never see it.
 */
function nudge(pool, config, key) {
  const limit = LIMIT_BY_KEY.get(key);
  if (!limit || !lines(limit.cap(config), DEFAULT_WARN_PERCENT)) return;
  Promise.resolve()
    .then(() => evaluate(pool, config, key))
    .catch((err) => {
      log.warn('platform-limits', 'Platform limit nudge failed', { limit: key, err: err.message });
    });
}

module.exports = {
  LIMITS,
  REARM_RATIO,
  SWEEP_INTERVAL_MS,
  DEFAULT_WARN_PERCENT,
  warnPercent,
  lines,
  decide,
  detailToken,
  parseDetail,
  evaluate,
  sweep,
  nudge,
};
