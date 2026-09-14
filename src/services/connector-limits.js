'use strict';

// Hosted MCP connector — the caps that only exist for connector traffic.
//
// The connector deliberately does its work through the platform's own
// routes, so every cap those routes already enforce (daily credit budget,
// active-session cap, the global worker cap) applies to it for free. This
// module holds the ones that do NOT come for free.
//
// THE RULE THIS MODULE KEEPS: no clocks, only concurrency. Nothing here
// counts how many things you started in the last hour or the last day.
// Every bound below asks "how much is this user doing RIGHT NOW", and each
// one is either the platform's own cap resolved per requester, or looser
// than it. A connector caller must never be MORE limited than the same
// person clicking the same button in the browser — a rate window is the
// most reliable way to break that, because normal building has no
// equivalent anywhere, and because waiting out an hour is not something
// the user can act on. (#1250 made this argument for the vote queue; the
// hourly prepare_work bound and the fallback's daily quota were the rest
// of it.)
//
// What is left, and why it isn't free from the routes underneath:
//
//   1. The promoted-session cap. POST /api/sessions/:id/promote enforces it;
//      POST /api/apps/:slug/pr-import does not, because an import was
//      previously something a human did by hand, one at a time, from a
//      picker. submit_work reaches pr-import from a loop that a model can
//      run, so it has to apply the same bound the browser's promote path
//      applies — otherwise the connector becomes the way around it.
//   2. Work orders held open at once. prepare_work writes nothing to GitHub
//      — the user's own coding agent makes the fork and the branch — but a
//      confused model retrying it still mints task rows, each of which is a
//      work order somebody may act on, so a loop must not turn into an
//      unbounded pile of dead reservations. Deliberately looser than the
//      platform's own active-session cap: a work order is a piece of paper,
//      not a running machine, and it holds no worker while it sits.
//   3. The platform-build fallback, which spends the platform's own credits
//      (the primary path spends the user's coding-agent subscription
//      instead). Bounded by the SAME per-user session cap the browser
//      applies to a dev session, resolved through session-caps.
//
// Every check returns null when the request may proceed, or a plain
// { code, message } that the caller turns into a tool error. The wording is
// user-facing: it is read aloud by an assistant to somebody who cannot see
// the platform UI, so it says what to do next — and, because every bound
// here is a concurrency bound, "what to do next" is always something the
// user can do immediately rather than a period to wait out.

const log = require('./logger');
const { effectiveSessionCaps } = require('./session-caps');

// The one literal left in this module. Not a throughput knob — it is the
// point at which "the model is looping" becomes more likely than "the user
// is working". Everything else resolves from the platform's own caps.
const LIMITS = Object.freeze({
  openTasks: 10,           // un-submitted work orders held at once
});

function limitError(code, message) {
  return { code, message };
}

// A limiter that cannot run does not wave the request through: these bound
// writes to GitHub and to the vote queue, so an unavailable database is a
// reason to stop, not a reason to proceed.
async function countOr(pool, sql, params, label) {
  try {
    const { rows } = await pool.query(sql, params);
    return parseInt(rows[0].cnt, 10) || 0;
  } catch (err) {
    log.warn('connector-limits', 'cap query failed', { label, err: err.message });
    return null;
  }
}

const UNAVAILABLE = limitError(
  'platform_unavailable',
  'Homeroom could not check your limits just now. Try again shortly.'
);

// ── 1. The promoted-session cap ────────────────────────────────────────
//
// Mirrors routes/votes.js's promote handler exactly, including the wording,
// so a user hits one bound with one explanation regardless of which surface
// they came in through. Headless rows are excluded there and here.
//
// This is the ONLY bound on submit_work. There used to be a second,
// connector-only proposal cap beside it, counting the same queue with
// `external_agent IS NOT NULL` against a hard 5. It could never fire first
// for an ordinary user (same number, strict subset) and it cut a full admin
// off at 5 where the browser allows 8 — a connector-only penalty for doing
// exactly what the browser permits, which is the thing this module is not
// allowed to do.
async function checkPromotedCap(pool, config, user) {
  const caps = effectiveSessionCaps(config, user);
  const count = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
    [user.id],
    'promoted-cap'
  );
  if (count === null) return UNAVAILABLE;
  if (count >= caps.promotedSessions) {
    return limitError(
      'at_capacity',
      `You already have ${caps.promotedSessions} PRs up for vote. `
      + 'Wait for one to merge, or archive one first.'
    );
  }
  return null;
}

// ── 1b. The active-session cap, for shared in-progress work ────────────
//
// #1347 lets a connector share work to the IN-PROGRESS area instead of only
// submitting it for review. That card is a real dev session with a real
// staging preview behind it, so it costs a warm container — which is exactly
// what config.maxUserSessions already bounds for the browser's own "start a
// session" button (routes/sessions.js).
//
// So this reuses that bound rather than inventing a connector-only one. The
// promoted cap above says why: a connector doing what the browser permits
// must not be cut off earlier than the browser, and a full admin keeps the
// admin tier here as they do everywhere else. Headless rows are excluded, as
// they are in every other count in this module — an auto run holds no warm
// worker of the user's.
//
// Counted BEFORE the session row is inserted, so an over-cap share leaves no
// card behind and no branch copied into the app's repository.
async function checkActiveCap(pool, config, user) {
  const caps = effectiveSessionCaps(config, user);
  const count = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE`,
    [user.id],
    'active-cap'
  );
  if (count === null) return UNAVAILABLE;
  if (count >= caps.activeSessions) {
    return limitError(
      'at_capacity',
      `You already have ${caps.activeSessions} sessions open. Pause or archive one first, `
      + 'or submit this work for review instead of sharing it as in-progress.'
    );
  }
  return null;
}

// ── 2. prepare_work reservations ───────────────────────────────────────
//
// How many work orders are held open at once — a stock, and the only bound
// on starting work. `expires_at` is the one time term left in this module,
// and it is a row lifetime rather than a rate window: a work order somebody
// genuinely walked away from stops counting after fourteen days without the
// user having to do anything.
//
// Called AFTER prepareWork's idempotent reuse lookup, so re-rendering a work
// order the caller already holds is free even at the cap, and after the
// `restart` branch, so starting one over frees its own slot before the
// count is taken.
//
// `session_id IS NULL` — the same clause listOpenWorkOrders selects on, and
// that is the whole point: the denominator has to be the list the user can
// actually SEE. A work order the connector has shared (#1347) keeps its row
// open on purpose, and the Improve panel excludes it because the share
// already shows on the Dev board as a session card. Counting it here charged
// it a second budget as well, one with no card to pause and no row in any
// list — a user at this cap was told to "submit one" while the panel showed
// them nothing to submit.
//
// Nothing is widened by dropping them: sharing obeys checkActiveCap above,
// which is the real bound on a session with a live preview behind it. This
// cap is what it says it is — how many work orders are held open and NOT yet
// handed anywhere.
async function checkOpenWorkOrders(pool, userId) {
  const open = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM external_agent_tasks
      WHERE user_id = $1 AND status = 'open' AND expires_at > NOW()
        AND session_id IS NULL`,
    [userId],
    'open-tasks'
  );
  if (open === null) return UNAVAILABLE;
  if (open >= LIMITS.openTasks) {
    return limitError(
      'at_capacity',
      `You have ${LIMITS.openTasks} pieces of work started and not yet submitted, which is the limit. `
      + 'Submit one, or start one of them over, before starting another. A slot comes back as soon '
      + 'as one is submitted.'
    );
  }
  return null;
}

// ── 3. The platform-build fallback ─────────────────────────────────────
//
// This path spends the platform's credits rather than the user's own
// coding-agent subscription. The daily credit budget still applies
// underneath (the platform route consults limits.resolveBillingPath
// itself) — that is the spend meter, and it is the one the browser's own
// auto-build route relies on too, so nothing here needs to count a day's
// worth of builds.
//
// What is left is how many builds are RUNNING, bounded by the same per-user
// session cap the browser applies to a dev session, admin tier included.
async function checkFallbackStart(pool, config, user) {
  const caps = effectiveSessionCaps(config, user);
  const inFlight = await countOr(
    pool,
    `SELECT COUNT(*) AS cnt FROM chat_sessions
      WHERE user_id = $1 AND is_headless = TRUE AND headless_status = 'generating'`,
    [user.id],
    'fallback-in-flight'
  );
  if (inFlight === null) return UNAVAILABLE;
  if (inFlight >= caps.activeSessions) {
    return limitError(
      'at_capacity',
      `You already have ${caps.activeSessions} Homeroom builds running. `
      + 'Wait for one to finish before starting another.'
    );
  }
  return null;
}

module.exports = {
  LIMITS,
  checkPromotedCap,
  checkActiveCap,
  checkOpenWorkOrders,
  checkFallbackStart,
};
