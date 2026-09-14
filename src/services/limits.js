'use strict';

const log = require('./logger');
const turnEffects = require('./turn-effects');
// #1788: the weekly cap reuses the platform's existing week boundary
// (Monday 00:00 UTC) rather than inventing a second one. This helper is
// the same one the weekly kudos allowance and the leaderboard's "week"
// window use, and it agrees with Postgres date_trunc('week', ...).
const { weekStartUtc } = require('./leaderboard-users');

// Daily LLM-spend caps. Both values live in `platform_settings` and are
// admin-tunable from /admin (see src/routes/admin.js endpoints
// /api/admin/limits + /api/admin/users/:id/daily-limit). Reads here are
// cached for CACHE_TTL_MS so a chat-heavy hour doesn't hammer Postgres
// for the same two rows on every turn; admin writes call invalidate()
// to flip the cache forward immediately.
//
// Per-user override: users.daily_limit_cents (NULL = use platform
// default). Lets admins grant trusted users a higher cap without
// raising it for everyone.

const KEY_USER  = 'user_daily_limit_cents';
const KEY_GLOBAL = 'global_daily_limit_cents';
// #361: dedicated daily cap for platform-driven merge-conflict / sync
// resolution turns. Lives in platform_settings like the other two and
// is admin-tunable from /admin. Defaults to $25/day (2500 cents).
const KEY_SYSTEM = 'system_tokens_daily_limit_cents';
// #1788: per-user WEEKLY cap, layered on top of the daily one. Same
// storage (platform_settings), same 10s cache, same per-user override
// pattern (users.weekly_limit_cents, NULL = platform default). Either cap
// set to 0 — or missing — means "this cap does not apply"; see
// resolveCaps() for the full four-way table.
const KEY_WEEKLY = 'user_weekly_limit_cents';

const CREDIT_POLICY_LEGACY = 'legacy';
const CREDIT_POLICY_TIERED = 'tiered';
// Identity - Layer 1: one verified GitHub OR X account unlocks $10/day.
// Provider proofs replace one another; they do not stack.
const TIER_ONE_LIMIT_CENTS = 1000;

const CACHE_TTL_MS = 10_000;
const cache = new Map();

// #593: the point at which the UI starts saying "you're nearly out" instead
// of just showing a number. One definition, sent to the client in the budget
// payloads below so the meter, the drawer row and the warning banner cannot
// disagree with each other — or with a later change here.
const LOW_BALANCE_PCT = 80;

// Every user-facing sentence about the daily allowance names the same
// boundary, so the boundary itself is computed in one place. Midnight UTC:
// llm_usage is keyed on CURRENT_DATE, which is what actually rolls over.
function dailyResetAt() {
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
}

// Human-readable names for the two boundaries. Every sentence the product
// says about a reset comes from one of these, so a message can never
// promise midnight when the weekly cap is what actually bound the turn.
const DAILY_RESET_LABEL = 'midnight UTC';
const WEEKLY_RESET_LABEL = 'Monday 00:00 UTC';

// The weekly counterpart of dailyResetAt(): the NEXT Monday 00:00 UTC.
// Derived from weekStartUtc so the reset instant and the SQL window can
// never drift apart — start of this week plus exactly seven days.
function weeklyResetAt(now = new Date()) {
  const start = weekStartUtc(now);
  const reset = new Date(`${start}T00:00:00.000Z`);
  reset.setUTCDate(reset.getUTCDate() + 7);
  return reset.toISOString();
}

function fromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function toCache(key, value) {
  cache.set(key, { value, at: Date.now() });
}

function invalidate(...keys) {
  if (!keys.length) cache.clear();
  for (const k of keys) cache.delete(k);
}

async function readSettingCents(pool, key, fallback) {
  const cached = fromCache(key);
  if (cached != null) return cached;
  try {
    const { rows } = await pool.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [key]
    );
    const raw = rows[0]?.value;
    const n = raw != null ? parseInt(raw, 10) : NaN;
    const value = Number.isFinite(n) && n >= 0 ? n : fallback;
    toCache(key, value);
    return value;
  } catch (err) {
    // platform_settings may not exist yet on the very first boot
    // before migrate() has run, or if a manual `pg_dump` restore wiped
    // the table mid-flight. Falling back to the legacy hardcoded value
    // keeps chat working until the next request, by which point the
    // schema will have caught up.
    log.warn('limits', 'platform_settings read failed; using fallback', { key, err: err.message, fallback });
    return fallback;
  }
}

async function getGlobalLimitCents(pool) {
  return readSettingCents(pool, KEY_GLOBAL, 20000);
}

async function getDefaultUserLimitCents(pool) {
  return readSettingCents(pool, KEY_USER, 2500);
}

// #1788: the platform-default weekly cap. The fallback is seven times the
// daily fallback, matching what the schema seeds on a fresh deploy — so a
// platform_settings read failure degrades to the same allowance the row
// would have held rather than to an accidental cut-off.
async function getDefaultUserWeeklyLimitCents(pool) {
  return readSettingCents(pool, KEY_WEEKLY, 17500);
}

// #361: the system-tokens daily cap (cents). Same 10s-cached read as the
// other two caps; admin writes call invalidate(KEY_SYSTEM).
async function getSystemTokensLimitCents(pool) {
  return readSettingCents(pool, KEY_SYSTEM, 2500);
}

function identityCreditPolicy() {
  return process.env.IDENTITY_CREDIT_POLICY === CREDIT_POLICY_TIERED
    ? CREDIT_POLICY_TIERED
    : CREDIT_POLICY_LEGACY;
}

// Resolve the user's allowance and explain where it came from. Explicit
// admin overrides always win. In legacy mode, a NULL override retains the
// existing platform default. In tiered mode, either verified provider gets
// exactly the Layer-1 amount and an unverified account gets zero.
//
// Tiered reads fail closed: inability to prove eligibility must never turn
// into the old default allowance. BYOK remains available through
// resolveBillingPath(), which resolves it after this platform-funded gate.
async function getUserCreditEntitlement(pool, userId) {
  const policy = identityCreditPolicy();
  if (policy === CREDIT_POLICY_LEGACY) {
    let row = null;
    try {
      const { rows } = await pool.query(
        'SELECT daily_limit_cents, weekly_limit_cents FROM users WHERE id = $1',
        [userId]
      );
      row = rows[0] || null;
    } catch (err) {
      log.warn('limits', 'user override read failed; using legacy default', {
        userId, err: err.message,
      });
    }
    // #1788: the weekly allowance is resolved independently of the daily
    // one — a user may hold an override for either, both or neither.
    const weekly = await resolveWeeklyEntitlement(pool, row);
    const override = row?.daily_limit_cents;
    if (override != null && Number.isFinite(Number(override)) && Number(override) >= 0) {
      return {
        policy,
        tier: 'override',
        source: 'admin_override',
        limitCents: Number(override),
        verificationRequired: false,
        entitlementAvailable: true,
        ...weekly,
      };
    }
    return {
      policy,
      tier: 'legacy',
      source: 'default',
      limitCents: await getDefaultUserLimitCents(pool),
      verificationRequired: false,
      entitlementAvailable: true,
      ...weekly,
    };
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.daily_limit_cents,
              u.weekly_limit_cents,
              EXISTS (
                SELECT 1
                  FROM user_social_identities usi
                 WHERE usi.user_id = u.id
              ) AS has_social_identity
         FROM users u
        WHERE u.id = $1`,
      [userId]
    );
    const row = rows[0];
    if (!row) throw new Error('user not found');
    const weekly = await resolveWeeklyEntitlement(pool, row);
    const override = row.daily_limit_cents;
    if (override != null && Number.isFinite(Number(override)) && Number(override) >= 0) {
      return {
        policy,
        tier: 'override',
        source: 'admin_override',
        limitCents: Number(override),
        verificationRequired: false,
        entitlementAvailable: true,
        ...weekly,
      };
    }
    if (row.has_social_identity) {
      return {
        policy,
        tier: 'social',
        source: 'identity',
        limitCents: TIER_ONE_LIMIT_CENTS,
        verificationRequired: false,
        entitlementAvailable: true,
        ...weekly,
      };
    }
    return {
      policy,
      tier: 'unverified',
      source: 'identity',
      limitCents: 0,
      verificationRequired: true,
      entitlementAvailable: true,
      ...weekly,
    };
  } catch (err) {
    log.warn('limits', 'identity entitlement read failed; refusing platform credits', {
      userId, err: err.message,
    });
    return {
      policy,
      tier: 'unavailable',
      source: 'unavailable',
      limitCents: 0,
      verificationRequired: false,
      entitlementAvailable: false,
      // Eligibility could not be read at all, so nothing is granted on
      // either axis — checkBudget refuses before any cap arithmetic runs.
      weeklyLimitCents: 0,
      weeklySource: 'unavailable',
    };
  }
}

// #1788: per-user weekly allowance + where it came from, resolved from the
// same `users` row the daily entitlement read. Mirrors the daily override
// rule exactly: an explicit non-negative value wins, NULL falls back to the
// platform default. A missing row (read failure) also falls back, which is
// the non-punitive direction — an unreadable override must not silently
// become a cut-off.
async function resolveWeeklyEntitlement(pool, row) {
  const override = row?.weekly_limit_cents;
  if (override != null && Number.isFinite(Number(override)) && Number(override) >= 0) {
    return { weeklyLimitCents: Number(override), weeklySource: 'admin_override' };
  }
  return {
    weeklyLimitCents: await getDefaultUserWeeklyLimitCents(pool),
    weeklySource: 'default',
  };
}

// #1788: the whole daily/weekly interaction, in one place, so checkBudget,
// getBudgetSnapshot, the worker Anthropic proxy and the app LLM proxy can
// never disagree about it. Four cases:
//
//   daily > 0, weekly > 0  → both apply; the turn stops at whichever is
//                            exhausted first.
//   daily 0/unset          → weekly only. No daily ceiling at all: the
//                            week's allowance may be spent in one day.
//   weekly 0/unset         → daily only. Today's behaviour, unchanged.
//   both 0/unset           → NOTHING applies, so nothing is granted. With
//                            no ceiling of either kind the safe reading is
//                            "no platform credits", not "unlimited".
//
// The zero-means-disabled reinterpretation is deliberately scoped to caps
// an admin actually set: only `admin_override` and `default` sources may be
// switched off that way. An identity-derived 0 (tiered policy, unverified
// account) keeps applying, so a weekly allowance can never unlock credits
// that identity verification is meant to gate.
function resolveCaps(entitlement = {}) {
  const dailyLimitCents = Number(entitlement.limitCents) || 0;
  const dailySource = entitlement.source;
  const dailyOptional = dailySource === 'admin_override' || dailySource === 'default';

  const weeklyLimitCents = Number(entitlement.weeklyLimitCents) || 0;
  const weeklySource = entitlement.weeklySource;
  const weeklyOptional = weeklySource === 'admin_override' || weeklySource === 'default';

  return {
    dailyApplies: dailyOptional ? dailyLimitCents > 0 : true,
    dailyLimitCents,
    dailySource: dailySource || null,
    weeklyApplies: weeklyOptional ? weeklyLimitCents > 0 : false,
    weeklyLimitCents,
    weeklySource: weeklySource || null,
  };
}

// Week-to-date platform-key spend for one user (cents), over the current
// Monday-00:00-UTC week. Reads the SAME daily ledger the daily cap reads —
// llm_usage is one row per (user_id, date), so a weekly figure is a sum,
// not a second table. BYOK spend is excluded, exactly as it is daily.
async function getWeeklySpentCents(pool, userId, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_cost_cents), 0) AS total
       FROM llm_usage
      WHERE user_id = $1 AND date >= $2`,
    [userId, weekStartUtc(now)]
  );
  return parseFloat(rows[0]?.total || 0);
}

// The per-user weekly cap actually in force (cents), for the two proxies'
// cached gates. 0 means "no weekly cap applies".
async function getEffectiveUserWeeklyLimitCents(pool, userId) {
  const caps = resolveCaps(await getUserCreditEntitlement(pool, userId));
  return caps.weeklyApplies ? caps.weeklyLimitCents : 0;
}

async function getEffectiveUserLimitCents(pool, userId) {
  const entitlement = await getUserCreditEntitlement(pool, userId);
  return entitlement.limitCents;
}

// Decision gate for "may this user incur another LLM call right now?".
// Mirrors the legacy checkBudget() in src/routes/sessions.js so callers
// can swap in this module without changing behaviour. Returns either
// `{ ok: true, userRemaining, globalRemaining }` or
// `{ error: '...user-facing message...' }`.
async function checkBudget(pool, userId) {
  const entitlement = await getUserCreditEntitlement(pool, userId);
  const userLimit = entitlement.limitCents;
  if (!entitlement.entitlementAvailable) {
    return {
      error: 'Credit eligibility could not be verified. Try again shortly.',
      reason: 'entitlement_unavailable',
      ...entitlement,
    };
  }
  const globalLimit = await getGlobalLimitCents(pool);
  const caps = resolveCaps(entitlement);

  const { rows: userRows } = await pool.query(
    'SELECT total_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE',
    [userId]
  );
  const userSpent = parseFloat(userRows[0]?.total_cost_cents || 0);
  if (caps.dailyApplies && userSpent >= userLimit) {
    if (entitlement.verificationRequired) {
      return {
        error: 'Connect GitHub or X in Settings to unlock $10.00/day of Homeroom credits.',
        reason: 'verification_required',
        ...entitlement,
      };
    }
    return {
      error: `Daily limit reached ($${(userLimit / 100).toFixed(2)}). Resets at ${DAILY_RESET_LABEL}.`,
      reason: 'user_limit',
      ...entitlement,
    };
  }

  // #1788: the weekly ceiling, checked after the daily one so a user who is
  // out on BOTH is told about the shorter wait first.
  let weeklySpent = 0;
  if (caps.weeklyApplies) {
    try {
      weeklySpent = await getWeeklySpentCents(pool, userId);
    } catch (err) {
      // Same tolerance the rest of this gate has for a bookkeeping read:
      // an unreadable ledger must not turn into a refusal. The proxies'
      // mid-stream kill still bounds runaway spend.
      log.warn('limits', 'weekly spend read failed; allowing turn', {
        userId, err: err.message,
      });
    }
    if (weeklySpent >= caps.weeklyLimitCents) {
      return {
        error: `Weekly limit reached ($${(caps.weeklyLimitCents / 100).toFixed(2)}). Resets ${WEEKLY_RESET_LABEL}.`,
        reason: 'weekly_limit',
        ...entitlement,
      };
    }
  }

  // Neither cap applies. Not "unlimited" — an account with no ceiling of
  // any kind has no allowance to draw on, so it fails closed. BYOK still
  // works: resolveBillingPath resolves the user's own key after this gate.
  if (!caps.dailyApplies && !caps.weeklyApplies) {
    return {
      error: 'No AI allowance is configured for this account. An admin can set a daily or weekly cap in the admin console.',
      reason: 'no_allowance',
      ...entitlement,
    };
  }

  const { rows: globalRows } = await pool.query(
    'SELECT SUM(total_cost_cents) as total FROM llm_usage WHERE date = CURRENT_DATE'
  );
  const globalSpent = parseFloat(globalRows[0]?.total || 0);
  if (globalSpent >= globalLimit) {
    // #593: says WHEN, like the per-user message above. "Try again
    // tomorrow" left the reader guessing at the boundary — and guessing
    // wrong, since it is a UTC one and most readers are not on UTC.
    return {
      error: 'Global daily limit reached: the platform\'s shared AI budget for today is spent. Resets at midnight UTC.',
      reason: 'global_limit',
      ...entitlement,
    };
  }

  return {
    ok: true,
    ...entitlement,
    userLimit,
    globalLimit,
    userRemaining: userLimit - userSpent,
    globalRemaining: globalLimit - globalSpent,
    weeklyLimit: caps.weeklyApplies ? caps.weeklyLimitCents : null,
    weeklySpent,
    weeklyRemaining: caps.weeklyApplies
      ? Math.max(0, caps.weeklyLimitCents - weeklySpent)
      : null,
  };
}

// #555: read-only view of "where does this user stand today?", for the
// drawer's AI-credit row. Deliberately NOT checkBudget(): that one is a
// gate and collapses to `{ error }` the moment the cap is hit — which is
// exactly the state the UI most needs numbers for ("$0.00 of $20.00
// left" is the interesting render, not a blank). So this always returns
// the full figures and never decides anything.
//
// byokCents is reported but is NOT subtracted from the allowance: that
// spend went to the user's own key and no cap has ever counted it (#119).
async function getBudgetSnapshot(pool, userId) {
  const entitlement = await getUserCreditEntitlement(pool, userId);
  const caps = resolveCaps(entitlement);
  const limitCents = entitlement.limitCents;
  let spentCents = 0;
  let byokCents = 0;
  let hasByokKey = false;
  let weeklySpentCents = 0;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(lu.total_cost_cents, 0) AS total_cost_cents,
              COALESCE(lu.byok_cost_cents, 0)  AS byok_cost_cents,
              (u.anthropic_key_enc IS NOT NULL) AS has_byok_key
         FROM users u
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
        WHERE u.id = $1`,
      [userId]
    );
    if (rows[0]) {
      spentCents = parseFloat(rows[0].total_cost_cents || 0);
      byokCents = parseFloat(rows[0].byok_cost_cents || 0);
      hasByokKey = !!rows[0].has_byok_key;
    }
  } catch (err) {
    // A display read must never 500 the drawer. Fall back to "nothing
    // spent" — the limit itself is still accurate.
    log.warn('limits', 'budget snapshot read failed', { userId, err: err.message });
  }
  if (caps.weeklyApplies) {
    try {
      weeklySpentCents = await getWeeklySpentCents(pool, userId);
    } catch (err) {
      log.warn('limits', 'weekly snapshot read failed', { userId, err: err.message });
    }
  }

  // #1788: report the BINDING cap in the fields the client already reads.
  // The meter, the drawer row and the warning banner all key off
  // limitCents/spentCents/remainingCents, and public/js/credit-options.js
  // maps limitCents === 0 to the red "exhausted" state — so a user whose
  // daily cap is deliberately switched off must never see a literal 0 here
  // while their weekly allowance still has headroom. Whichever applicable
  // cap has the least room left is the one that will actually stop the next
  // turn, so that is the one worth showing.
  const dailyRemaining = Math.max(0, limitCents - spentCents);
  const weeklyRemaining = Math.max(0, caps.weeklyLimitCents - weeklySpentCents);
  const weeklyBinds = caps.weeklyApplies
    && (!caps.dailyApplies || weeklyRemaining < dailyRemaining);
  const capWindow = weeklyBinds ? 'weekly' : (caps.dailyApplies ? 'daily' : 'none');

  return {
    creditPolicy: entitlement.policy,
    tier: entitlement.tier,
    limitSource: entitlement.source,
    verificationRequired: entitlement.verificationRequired,
    entitlementAvailable: entitlement.entitlementAvailable,
    tierLimitCents: TIER_ONE_LIMIT_CENTS,
    limitCents: weeklyBinds ? caps.weeklyLimitCents : limitCents,
    spentCents: weeklyBinds ? weeklySpentCents : spentCents,
    remainingCents: weeklyBinds ? weeklyRemaining : dailyRemaining,
    byokCents,
    hasByokKey,
    // The boundary the binding cap actually resets on, matching the
    // sentence checkBudget's message promises for that same cap.
    resetsAt: weeklyBinds ? weeklyResetAt() : dailyResetAt(),
    lowBalancePct: LOW_BALANCE_PCT,
    // #1788: which window the figures above describe, and the breakdown
    // behind them, so a caller that wants both can have both.
    capWindow,
    windowLabel: weeklyBinds ? 'This week' : 'Today',
    resetLabel: weeklyBinds ? WEEKLY_RESET_LABEL : DAILY_RESET_LABEL,
    dailyApplies: caps.dailyApplies,
    dailyLimitCents: limitCents,
    dailySpentCents: spentCents,
    weeklyApplies: caps.weeklyApplies,
    weeklyLimitCents: caps.weeklyLimitCents,
    weeklySpentCents,
  };
}

// Shared BYOK key lookup + decrypt (#30/#212). Previously duplicated in
// routes/sessions.js (loadUserApiKey + an inline copy in the chat route)
// and services/sync-main.js — now the single home, used by
// resolveBillingPath below. Returns the decrypted key string or null
// (missing key, decrypt failure — both mean "no key on file").
async function loadUserApiKey(pool, userId, dataKey) {
  try {
    const { rows } = await pool.query(
      'SELECT anthropic_key_enc FROM users WHERE id = $1',
      [userId]
    );
    if (rows[0]?.anthropic_key_enc) {
      const secrets = require('./secrets');
      const key = secrets.decrypt(rows[0].anthropic_key_enc, dataKey);
      if (!key) {
        log.warn('limits', 'BYOK key decryption failed; treating as no key', { userId });
      }
      return key || null;
    }
  } catch (err) {
    log.warn('limits', 'Failed to load user API key', { userId, err: err.message });
  }
  return null;
}

// #212: decide who pays for the next billable unit (a chat turn, a
// headless phase, a sync run). LIMIT-FIRST: the shared daily allowance
// is consumed while it has headroom; the user's own BYOK key (#30)
// takes over only once the budget — their per-user cap OR the global
// cap — is exhausted. Returns exactly one of:
//   { apiKey: null, byok: false }   — budget headroom: bill the
//     platform key (counts against the daily caps via recordSpend).
//   { apiKey: '<key>', byok: true } — budget exhausted and a BYOK key
//     is on file: bill the user's own key (display-only bucket).
//   { error: '...' }                — budget exhausted, no usable key:
//     the same user-facing message checkBudget produces today.
// Key decryption failures keep the existing tolerance (warn + treat as
// "no key") — which now means a 429 once the cap is hit, instead of
// the old silent payer switch.
async function resolveBillingPath(pool, dataKey, userId) {
  const budget = await checkBudget(pool, userId);
  if (!budget.error) return { apiKey: null, byok: false };
  const apiKey = await loadUserApiKey(pool, userId, dataKey);
  if (apiKey) return { apiKey, byok: true };
  // #463: this branch is only reachable with NO usable key on file, so
  // the BYOK hint is always accurate here. checkBudget itself stays
  // hint-free — it also runs on paths where the caller has a key.
  return {
    error: `${budget.error} Add your own Anthropic API key in Settings to keep going.`,
    reason: budget.reason || null,
    verificationRequired: !!budget.verificationRequired,
  };
}

// Daily-ledger upsert shared by every spend site (Mayor turns, Claude
// Code dispatches, PR-metadata Haiku calls, feedback titles). Routes
// the cost into the bucket matching who paid Anthropic (#119):
//   byok: false → total_cost_cents (counts against the daily caps)
//   byok: true  → byok_cost_cents  (billed to the user's own key once
//                 the daily allowance ran out — see resolveBillingPath;
//                 display only, checkBudget never reads it)
// No-ops on a missing user or non-positive cost, and swallows+logs DB
// errors — billing bookkeeping must never fail the request that
// incurred the spend (same tolerance the call sites had inline).
async function recordSpend(pool, userId, costCents, { byok = false } = {}) {
  if (!userId || !(costCents > 0)) return;
  const column = byok ? 'byok_cost_cents' : 'total_cost_cents';
  try {
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, ${column}) VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (user_id, date) DO UPDATE SET ${column} = llm_usage.${column} + EXCLUDED.${column}`,
      [userId, costCents]
    );
  } catch (err) {
    log.warn('limits', 'Failed to record llm_usage spend', { userId, costCents, byok, err: err.message });
  }
}

async function recordSpendRequired(client, userId, costCents, { byok = false } = {}) {
  if (!userId || !(costCents > 0)) return;
  const column = byok ? 'byok_cost_cents' : 'total_cost_cents';
  await client.query(
    `INSERT INTO llm_usage (user_id, date, ${column}) VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_id, date) DO UPDATE SET ${column} = llm_usage.${column} + EXCLUDED.${column}`,
    [userId, costCents],
  );
}

// #1088: claim the once-per-UTC-day right to TELL this user that their own
// Anthropic key took over. Returns true for the caller that won the claim and
// false for everyone after it, until llm_usage rolls to the next `date` — which
// is exactly when the free allowance resets, so the marker expires by
// construction and needs no sweeper.
//
// It has to be an upsert, not a bare UPDATE: a *global* cap crossing can switch
// a user who has spent nothing today and so has no llm_usage row yet. The
// conditional DO UPDATE ... WHERE byok_notice_at IS NULL makes the whole thing
// one statement, so concurrent proxy calls (or processes) can't both win.
//
// Unlike recordSpend, a DB error here fails QUIET rather than open: suppressing
// a notice is the fix this issue asked for, and the always-visible credit meter
// still tells the story.
async function claimByokSwitchNotice(pool, userId) {
  if (!userId) return false;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO llm_usage (user_id, date, byok_notice_at) VALUES ($1, CURRENT_DATE, NOW())
       ON CONFLICT (user_id, date) DO UPDATE SET byok_notice_at = NOW()
         WHERE llm_usage.byok_notice_at IS NULL
       RETURNING id`,
      [userId]
    );
    return rowCount === 1;
  } catch (err) {
    log.warn('limits', 'Failed to claim BYOK switch notice', { userId, err: err.message });
    return false;
  }
}

function splitTurnSpend(totalCents, { turnByok = false, byokObservedCents = 0 } = {}) {
  const total = Number(totalCents);
  if (!Number.isFinite(total) || !(total > 0)) {
    return { platformCents: 0, byokCents: 0 };
  }
  if (turnByok) return { platformCents: 0, byokCents: total };
  const observed = Number(byokObservedCents);
  const byokCents = Math.min(Number.isFinite(observed) && observed > 0 ? observed : 0, total);
  return { platformCents: total - byokCents, byokCents };
}

// #664: turn-end settlement for a CC turn that may have SWITCHED payers
// mid-flight. The worker Anthropic proxy falls back to the user's own
// key per-call once the daily allowance is exhausted, so a single turn
// can carry both platform-billed and BYOK-billed calls. Attributing the
// whole turn to one bucket would either leak pre-switch platform spend
// out of the capped bucket (ledger never reaches the cap → every turn
// burns platform money before switching) or over-count the user's
// key spend against their allowance. Split instead:
//   turnByok: true  → the whole turn ran on the user's key (dispatch-time
//     BYOK, proxy never involved) → all of it lands in the byok bucket.
//   turnByok: false → platform-dispatched turn; `byokObservedCents` is
//     the proxy's per-call tally of switched spend (an SSE-tee estimate,
//     clamped to the turn total — CC's self-reported costUsd is the
//     authoritative sum). Remainder is platform spend.
// Returns { platformCents, byokCents } so call sites can emit per-bucket
// usage events. New durable turns supply turnId: the debit and its receipt
// then commit in one transaction and recovery can replay the stored split
// without incrementing llm_usage twice. Legacy callers keep the tolerant
// best-effort behavior until their old active_turn records have drained.
async function settleTurnSpend(pool, userId, totalCents, {
  turnByok = false,
  byokObservedCents = 0,
  turnId = null,
  sessionId = null,
  effectKey = 'claude_agent_spend',
} = {}) {
  if (!userId) {
    return { platformCents: 0, byokCents: 0 };
  }
  const split = splitTurnSpend(totalCents, { turnByok, byokObservedCents });
  const { platformCents, byokCents } = split;
  if (!(platformCents > 0) && !(byokCents > 0)) return split;

  if (turnId) {
    const receipt = await turnEffects.runDbEffect({
      pool,
      turnId,
      effectKey,
      sessionId,
      run: async (client) => {
        if (platformCents > 0) {
          await recordSpendRequired(client, userId, platformCents, { byok: false });
        }
        if (byokCents > 0) {
          await recordSpendRequired(client, userId, byokCents, { byok: true });
        }
        return split;
      },
    });
    return receipt.value || split;
  }

  if (platformCents > 0) await recordSpend(pool, userId, platformCents, { byok: false });
  if (byokCents > 0) await recordSpend(pool, userId, byokCents, { byok: true });
  return split;
}

// #361: gate for "may the platform incur another merge-conflict /
// sync-resolution turn right now?". Reads today's accumulated
// system-token spend and compares to the system cap. Returns
// `{ ok: true, remaining }` or `{ error: '...user-facing message...' }`
// mirroring checkBudget's shape so call sites can branch the same way.
async function checkSystemBudget(pool) {
  const limit = await getSystemTokensLimitCents(pool);
  let spent = 0;
  try {
    const { rows } = await pool.query(
      'SELECT cost_cents FROM system_token_usage WHERE date = CURRENT_DATE'
    );
    spent = parseFloat(rows[0]?.cost_cents || 0);
  } catch (err) {
    // Table may not exist yet on first boot before migrate() runs, or a
    // transient DB hiccup — fail open (treat as headroom) so housekeeping
    // isn't blocked by bookkeeping. The mid-stream proxy gate still caps
    // runaway spend.
    log.warn('limits', 'system_token_usage read failed; allowing turn', { err: err.message });
    return { ok: true, remaining: limit };
  }
  if (spent >= limit) {
    return { error: `System token budget reached ($${(limit / 100).toFixed(2)}). Resets at midnight UTC.` };
  }
  return { ok: true, remaining: limit - spent };
}

// #361: daily-ledger upsert for system-token spend. One row per day,
// keyed on date (no user). Same swallow-and-log tolerance as recordSpend
// — billing bookkeeping must never fail the turn that incurred it.
async function recordSystemSpend(pool, costCents) {
  if (!(costCents > 0)) return;
  try {
    await pool.query(
      `INSERT INTO system_token_usage (date, cost_cents) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (date) DO UPDATE
         SET cost_cents = system_token_usage.cost_cents + EXCLUDED.cost_cents,
             updated_at = NOW()`,
      [costCents]
    );
  } catch (err) {
    log.warn('limits', 'Failed to record system_token_usage spend', { costCents, err: err.message });
  }
}

module.exports = {
  getGlobalLimitCents,
  getDefaultUserLimitCents,
  getDefaultUserWeeklyLimitCents,
  getSystemTokensLimitCents,
  checkSystemBudget,
  recordSystemSpend,
  getEffectiveUserLimitCents,
  getEffectiveUserWeeklyLimitCents,
  getWeeklySpentCents,
  resolveCaps,
  getUserCreditEntitlement,
  identityCreditPolicy,
  getBudgetSnapshot,
  dailyResetAt,
  weeklyResetAt,
  weekStartUtc,
  DAILY_RESET_LABEL,
  WEEKLY_RESET_LABEL,
  LOW_BALANCE_PCT,
  checkBudget,
  loadUserApiKey,
  resolveBillingPath,
  recordSpend,
  claimByokSwitchNotice,
  settleTurnSpend,
  invalidate,
  KEY_USER,
  KEY_GLOBAL,
  KEY_WEEKLY,
  KEY_SYSTEM,
  CREDIT_POLICY_LEGACY,
  CREDIT_POLICY_TIERED,
  TIER_ONE_LIMIT_CENTS,
};
