'use strict';

const log = require('./logger');

// #555 — "how much Anthropic credit is left?" for the drawer's status pane.
//
// THE THING TO KNOW FIRST: Anthropic does not publish a credit balance.
// The Admin API exposes members, workspaces, API keys, the usage report,
// the cost report and rate-limit reports — and nothing that says "you
// have $X of prepaid credit remaining" (the spend-limits endpoints are
// Claude-Enterprise-only, which this org is not). So the number is
// DERIVED, and the derivation needs one operator-supplied figure:
//
//   remaining = balance an admin recorded − billed spend since that date
//
// The balance + its as-of date live in `platform_settings` under the two
// keys below and are set from the admin console's Limits section. Their
// ABSENCE is meaningful — it is the "not configured yet" state — which is
// why they are deliberately NOT seeded in db/schema.sql.
//
// Spend comes from GET /v1/organizations/cost_report, which needs an
// ADMIN API key (`sk-ant-admin…`) — a different credential from
// config.anthropicApiKey, and one that never leaves this process: only
// derived cent figures are ever returned to a caller. Without that key we
// fall back to the platform's own ledgers and label the result an
// estimate, so the row degrades rather than disappearing.
//
// Caveat worth remembering when the numbers look slightly generous:
// cost_report excludes Priority Tier spend by design.

const KEY_BALANCE = 'anthropic_credit_balance_cents';
const KEY_AS_OF = 'anthropic_credit_as_of';

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic asks integrations to identify themselves so they can see
// usage patterns; harmless either way.
const USER_AGENT = 'Homeroom/1.0 (+https://social-vibecoding.usernodelabs.org)';

const FETCH_TIMEOUT_MS = 8000;
// cost_report caps a page at 31 daily buckets, so a long window pages.
// 24 pages ≈ 2 years — a backstop, not an expected limit. Hitting it is
// logged AND flagged on the payload (`partial`): a silently truncated
// window would read as "you've spent less than you have".
const MAX_PAGES = 24;
// Anthropic's guidance is at most one poll a minute, and the data itself
// lags real usage by ~5 minutes, so a per-drawer-open fetch would be both
// rude and pointless. Every admin opening the menu shares this.
const CACHE_TTL_MS = 15 * 60 * 1000;

// { key, at, value } — `key` binds the entry to the settings that produced
// it, so re-recording the balance can never serve the old arithmetic.
let cache = null;

function invalidate() {
  cache = null;
}

function cacheKey(balanceCents, asOf) {
  return `${balanceCents}|${asOf}`;
}

// Read the two settings rows. Returns null when either is missing or
// unusable — that is the "not configured" state, not an error.
async function readSettings(pool) {
  let rows;
  try {
    ({ rows } = await pool.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1)',
      [[KEY_BALANCE, KEY_AS_OF]]
    ));
  } catch (err) {
    // platform_settings may not exist yet on a very first boot, before
    // migrate() has run. Same tolerance as services/limits.js.
    log.warn('anthropic-credits', 'platform_settings read failed', { err: err.message });
    return null;
  }
  const map = new Map((rows || []).map((r) => [r.key, r.value]));
  const balanceCents = Number(map.get(KEY_BALANCE));
  const asOf = String(map.get(KEY_AS_OF) || '').slice(0, 10);
  if (!Number.isFinite(balanceCents) || balanceCents < 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;
  return { balanceCents, asOf };
}

// End of the window: tomorrow 00:00Z, so today's partial day is included.
function endingAt() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
}

// Sum every `amount` in every bucket of the cost report over
// [asOf, tomorrow). `amount` is a decimal string already denominated in
// the currency's LOWEST unit — cents — so "123.45" is $1.23 and there is
// no ×100 to do here.
async function fetchAnthropicSpendCents(adminKey, asOf) {
  let spentCents = 0;
  let page = null;
  let partial = false;
  let pages = 0;

  for (;;) {
    const params = new URLSearchParams({
      starting_at: `${asOf}T00:00:00Z`,
      ending_at: endingAt(),
      bucket_width: '1d',
      limit: '31',
    });
    if (page) params.set('page', page);

    const resp = await fetch(
      `${ANTHROPIC_UPSTREAM}/v1/organizations/cost_report?${params.toString()}`,
      {
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'user-agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`cost_report ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = await resp.json();

    for (const bucket of json?.data || []) {
      for (const result of bucket?.results || []) {
        // Currency is documented as always USD; if that ever changes we
        // must not silently add foreign units to a dollar total.
        if (result?.currency && result.currency !== 'USD') {
          log.warn('anthropic-credits', 'skipping non-USD cost row', { currency: result.currency });
          continue;
        }
        const amount = Number(result?.amount);
        if (Number.isFinite(amount)) spentCents += amount;
      }
    }

    pages += 1;
    if (!json?.has_more || !json?.next_page) break;
    if (pages >= MAX_PAGES) {
      partial = true;
      log.warn('anthropic-credits', 'cost_report pagination cap hit — spend is under-counted', {
        pages, asOf, maxPages: MAX_PAGES,
      });
      break;
    }
    page = json.next_page;
  }

  return { spentCents, partial };
}

// Fallback when no admin key is configured: the platform's OWN ledgers.
// This is list-price rather than billed price and misses any org spend
// that didn't flow through this platform, hence `source: 'local-estimate'`
// and the "estimated" label in the UI.
//
// byok_cost_cents is deliberately excluded — that spend is billed to
// users' own Anthropic keys and never touches the org's credit.
async function localLedgerSpendCents(pool, asOf) {
  let spentCents = 0;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_cost_cents), 0) AS cents
         FROM llm_usage WHERE date >= $1::date`,
      [asOf]
    );
    spentCents += parseFloat(rows[0]?.cents || 0);
  } catch (err) {
    log.warn('anthropic-credits', 'llm_usage sum failed', { err: err.message });
  }
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(cost_cents), 0) AS cents
         FROM system_token_usage WHERE date >= $1::date`,
      [asOf]
    );
    spentCents += parseFloat(rows[0]?.cents || 0);
  } catch (err) {
    log.warn('anthropic-credits', 'system_token_usage sum failed', { err: err.message });
  }
  return spentCents;
}

// The one entry point. NEVER throws — a route can serialise the result
// straight out. Shape:
//   { configured: false }                          — nothing recorded yet
//   { configured: true, balanceCents, asOf, spentCents, remainingCents,
//     source, fetchedAt, partial?, stale?, error? }
async function getCredits(pool, config, { force = false } = {}) {
  const settings = await readSettings(pool);
  if (!settings) return { configured: false };

  const { balanceCents, asOf } = settings;
  const key = cacheKey(balanceCents, asOf);
  const now = Date.now();
  if (!force && cache && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const adminKey = (config && config.anthropicAdminKey) || '';
  try {
    let spentCents;
    let partial = false;
    let source;
    if (adminKey) {
      ({ spentCents, partial } = await fetchAnthropicSpendCents(adminKey, asOf));
      source = 'anthropic';
    } else {
      spentCents = await localLedgerSpendCents(pool, asOf);
      source = 'local-estimate';
    }
    const value = {
      configured: true,
      balanceCents,
      asOf,
      spentCents,
      remainingCents: balanceCents - spentCents,
      source,
      fetchedAt: new Date(now).toISOString(),
      partial,
    };
    cache = { key, at: now, value };
    return value;
  } catch (err) {
    log.warn('anthropic-credits', 'credit refresh failed', { err: err.message });
    // A stale figure beats a blank row: keep serving the last good one
    // (without refreshing its timestamp) and let the UI say so.
    if (cache && cache.key === key) {
      return { ...cache.value, stale: true, error: err.message };
    }
    return { configured: true, balanceCents, asOf, error: err.message };
  }
}

module.exports = {
  getCredits,
  invalidate,
  KEY_BALANCE,
  KEY_AS_OF,
  MAX_PAGES,
  CACHE_TTL_MS,
};
