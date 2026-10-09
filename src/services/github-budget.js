'use strict';

// GitHub's REST budget, as GitHub itself reports it on every response.
//
// The platform talks to GitHub with a few credentials, and each one has its
// own hourly budget:
//
//   pat                    the bot's personal access token (GITHUB_BOT_TOKEN):
//                          5,000 requests an hour, shared by everything the
//                          platform does with it. On 2026-10-04 it ran out,
//                          and new proposals and before/after shots failed
//                          until the hour reset.
//   installation:<owner>   a GitHub App installation token: its own budget,
//                          5,000 an hour and more for a larger installation.
//   anonymous              an unauthenticated read: 60 an hour per IP.
//
// Every response, success or error, carries x-ratelimit-limit, -remaining,
// -reset, -used and -resource, and those headers are the only authoritative
// figure there is. Nothing here counts requests itself; record() keeps the
// newest figures per credential and resource.
//
// IN MEMORY, PER PROCESS, ON PURPOSE. The platform runs one replica by
// default. The headers report the credential's account-wide count, not this
// process's share, so another replica's requests still show up in the next
// response this one sees. A restart starts with nothing known, which reads as
// "allowed" below: the first response fills it in.
//
// Two questions are answered from it:
//
//   backgroundHold() / budgetAllows('background')
//       Timer-driven work (the drift poller, the merge follow-up sweep, the
//       Homeroom bot's passes, ...) asks before it spends any. While the known
//       core budget of the credential it would use is under RESERVE_RATIO of
//       the limit and the reset is still ahead, the answer is no, and one log
//       line per credential per window says so. What people start is never
//       held back: it does not ask, so it keeps the reserve.
//
//   rateLimitNotice(err)
//       The plain-words sentence for a request GitHub refused because the
//       hourly budget is used up, with when it resets. Local time is not known
//       server-side, so it says "in about N minutes".
//
// services/platform-limit-alerts.js reads alertFigures() to tell the full
// admins when a credential's core budget falls under a fifth and when it is
// used up, and GET /api/admin/github-budget serves snapshot() to Admin, Limits.
//
// GitHub's figures say how much of an hour is used, not by what. On
// 2026-10-09 the bot token ran out twice in an evening and nobody could say
// which feature had spent it, so noteRequest() also counts every request
// this process sends, per credential, by endpoint and by the code that asked
// for it (see "Who spent it" below).

const path = require('node:path');
const log = require('./logger');

// Background work waits once less than this share of the limit is left.
const RESERVE_RATIO = 0.15;
// Two responses whose reset times are closer than this are the same window.
// A new window resets about an hour after the previous one, so a minute is
// a wide margin either way.
const SAME_WINDOW_MS = 60 * 1000;

// credential -> Map<resource, { limit, remaining, used, resetAt, observedAt }>
const state = new Map();
// Which credential answered the reads routed by services/github.js
// getReadOctokit (GITHUB_READS_VIA_APP), since this process started: the
// App installation, or the bot token, and why the bot token. `noInstallation`
// names the owners whose reads went to the bot token because the App is not
// installed on them: installing it there is the fix, and only an owner of
// that account can do it.
// (A null-prototype map: an owner is any GitHub login, "constructor" too.)
const reads = { installation: 0, pat: 0, patReasons: {}, noInstallation: Object.create(null) };
// Owners counted in reads.noInstallation, at most; the rest are counted
// under '(others)'.
const NO_INSTALLATION_OWNERS_MAX = 20;
// "<credential>@<resetAt>" for the windows already logged as held.
const heldLogged = new Set();

function toInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

// Octokit hands headers over as a plain object with lowercase keys; fetch
// hands over a Headers instance.
function headerGetter(headers) {
  if (!headers || typeof headers !== 'object') return () => null;
  if (typeof headers.get === 'function') return (name) => headers.get(name);
  return (name) => {
    const v = headers[name];
    return v == null ? null : String(v);
  };
}

function normalizeCredential(credential) {
  const c = String(credential || '').trim();
  if (c === 'pat' || c === 'anonymous') return c;
  const m = /^installation:([A-Za-z0-9_.-]{1,100})$/.exec(c);
  return m ? `installation:${m[1].toLowerCase()}` : null;
}

function parse(headers) {
  const get = headerGetter(headers);
  const limit = toInt(get('x-ratelimit-limit'));
  const remaining = toInt(get('x-ratelimit-remaining'));
  const reset = toInt(get('x-ratelimit-reset'));
  if (limit == null || remaining == null || reset == null || limit <= 0) return null;
  const used = toInt(get('x-ratelimit-used'));
  const resource = String(get('x-ratelimit-resource') || 'core').trim().toLowerCase().slice(0, 32) || 'core';
  return {
    resource,
    limit,
    remaining: Math.max(0, remaining),
    used: used == null ? Math.max(0, limit - remaining) : Math.max(0, used),
    resetAt: reset * 1000,
  };
}

/**
 * Record one response's rate-limit headers for a credential. Accepts a fetch
 * Headers or an Octokit headers object, from a success or an error. Returns
 * the entry now held for that resource, or null when the response carried no
 * figures (a network error, a non-GitHub stub).
 *
 * Responses can land out of order. Within one window the remaining figure
 * only falls, so the lowest one wins; a response from an older window never
 * replaces a newer one.
 */
function record(credential, headers, { now = Date.now() } = {}) {
  const cred = normalizeCredential(credential);
  if (!cred) return null;
  const figures = parse(headers);
  if (!figures) return null;
  let byResource = state.get(cred);
  if (!byResource) {
    byResource = new Map();
    state.set(cred, byResource);
  }
  const prev = byResource.get(figures.resource);
  if (prev) {
    if (figures.resetAt <= prev.resetAt - SAME_WINDOW_MS) return prev;
    if (Math.abs(figures.resetAt - prev.resetAt) < SAME_WINDOW_MS && figures.remaining >= prev.remaining) {
      prev.limit = figures.limit;
      prev.observedAt = now;
      return prev;
    }
  }
  const entry = {
    limit: figures.limit,
    remaining: figures.remaining,
    used: figures.used,
    resetAt: figures.resetAt,
    observedAt: now,
  };
  byResource.set(figures.resource, entry);
  return entry;
}

/** The core figures for a credential, or null when nothing is known. */
function core(credential, { now = Date.now() } = {}) {
  const cred = normalizeCredential(credential);
  const entry = cred && state.get(cred) && state.get(cred).get('core');
  if (!entry) return null;
  // A window whose reset has passed is a full budget again, whatever the
  // last response in it said.
  const expired = entry.resetAt <= now;
  return {
    credential: cred,
    limit: entry.limit,
    remaining: expired ? entry.limit : entry.remaining,
    used: expired ? 0 : entry.used,
    resetAt: entry.resetAt,
    observedAt: entry.observedAt,
    expired,
  };
}

/**
 * Whether the credential's core budget is known to be used up for the
 * current window: nothing left and the reset still ahead.
 */
function isExhausted(credential, { now = Date.now() } = {}) {
  const c = core(credential, { now });
  return !!(c && !c.expired && c.remaining <= 0);
}

/**
 * Count one routed read: 'installation', or 'pat' with the reason the bot
 * token answered it (no_installation, budget_used_up, status_403, ...).
 */
function noteRead(source, reason = null, { owner = null } = {}) {
  if (source === 'installation') {
    reads.installation += 1;
    return;
  }
  reads.pat += 1;
  const why = String(reason || 'unknown').slice(0, 32);
  reads.patReasons[why] = (reads.patReasons[why] || 0) + 1;
  if (why === 'no_installation' && owner) {
    let who = String(owner).slice(0, 100);
    const known = Object.keys(reads.noInstallation);
    // Logins are case-insensitive: one owner is one entry, as first seen.
    const same = known.find((k) => k.toLowerCase() === who.toLowerCase());
    if (same) who = same;
    else if (known.length >= NO_INSTALLATION_OWNERS_MAX) who = '(others)';
    reads.noInstallation[who] = (reads.noInstallation[who] || 0) + 1;
  }
}

// ── Who spent it ──────────────────────────────────────────────────────
//
// Per credential and resource, the requests this process sent in GitHub's
// current window (and the one before it), by endpoint and by caller.
//
// The caller is read off the request's async stack: the first two frames
// outside services/github.js, this file and node_modules, as "function
// (file)". No call site has to name itself, so a new caller is counted the
// day it ships. The endpoint is the route template ("GET
// /repos/{owner}/{repo}/pulls/{pull_number}"), so a thousand proposals are
// one row, not a thousand.
//
// What the counts do NOT cover is reported too: GitHub's `used` for the
// window, less what was already used when this process first saw it, less
// what it counted, is what something else spent in the meantime: another
// replica, a copy of the token handed to a container, or a request that
// does not go through services/github.js.
//
// A 304 answer to a conditional request is free on GitHub's side, so it is
// counted apart.

// Rows (caller x endpoint) kept per window; anything past that is counted
// in one '(other callers)' row, so a pathological caller cannot grow it.
const SPEND_MAX_ROWS = 200;
// Callers and endpoints per caller in snapshot().
const SPEND_TOP_CALLERS = 12;
const SPEND_TOP_ENDPOINTS = 4;
const OTHER_CALLERS = '(other callers)';

// "<credential>|<resource>" -> { current, previous }, each a window:
// { resetAt, baseline, maxUsed, counted, free, rows: Map<key, row> }
const spend = new Map();

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Frames that are the GitHub plumbing itself, not who asked.
const PLUMBING = [
  `${path.sep}src${path.sep}services${path.sep}github.js`,
  `${path.sep}src${path.sep}services${path.sep}github-budget.js`,
  `${path.sep}node_modules${path.sep}`,
];

function frameOf(line) {
  // "at async fn (/abs/file.js:1:2)", "at fn (/abs/file.js:1:2)",
  // "at /abs/file.js:1:2", "at async Promise.all (index 0)".
  const m = /^\s*at (?:async )?(?:(.+?) \()?((?:file:\/\/)?\/[^():]+|[A-Za-z]:\\[^():]+):(\d+):\d+\)?$/.exec(line);
  if (!m) return null;
  const file = m[2].replace(/^file:\/\//, '');
  if (PLUMBING.some((p) => file.includes(p))) return null;
  if (!file.startsWith(REPO_ROOT)) return null;
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/').replace(/^src\//, '');
  const fn = (m[1] || '').replace(/^Object\.|^Timeout\.|^Immediate\./, '').trim();
  return fn && !/^<anonymous>$/.test(fn) ? `${fn} (${rel})` : `${rel}:${m[3]}`;
}

/**
 * Who is asking, from the current (async) stack: "fn (file)", or
 * "fn (file) ← fn (file)" with the frame that called it. Call it before the
 * request's first await so the asking frames are still on the stack.
 */
function callerFromStack() {
  const limit = Error.stackTraceLimit;
  let stack = '';
  try {
    Error.stackTraceLimit = 40;
    stack = String(new Error().stack || '');
  } catch (_) {
    return 'unknown';
  } finally {
    Error.stackTraceLimit = limit;
  }
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const f = frameOf(line);
    if (f && f !== frames[frames.length - 1]) frames.push(f);
    if (frames.length === 2) break;
  }
  return frames.length ? frames.join(' ← ') : 'unknown';
}

// "GET /repos/{owner}/{repo}/pulls/{pull_number}" from an Octokit route
// template, or from a literal URL ("https://api.github.com/repos/o/r/
// issues/7?per_page=100" -> "GET /repos/{owner}/{repo}/issues/{n}").
function endpointOf(method, url) {
  const verb = String(method || 'GET').toUpperCase();
  let p = String(url || '');
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch (_) { /* keep it as given */ }
  p = p.split('?')[0];
  const parts = p.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    const prev = parts[i - 1];
    if (prev === 'repos' && i === 2 && !seg.startsWith('{')) { out.push('{owner}', '{repo}'); i += 1; continue; }
    if (['contents', 'ref', 'refs', 'matching-refs', 'compare'].includes(prev) && !seg.startsWith('{')) {
      out.push(prev === 'contents' ? '{path}' : (prev === 'compare' ? '{basehead}' : '{ref}'));
      break;
    }
    if (/^\d+$/.test(seg)) out.push('{n}');
    else if (/^[0-9a-f]{40}$/i.test(seg)) out.push('{sha}');
    else if (prev === 'branches' && seg && !seg.startsWith('{')) out.push('{branch}');
    else out.push(seg);
  }
  return `${verb} ${out.join('/').slice(0, 160)}`;
}

function newWindow(figures, free) {
  return {
    resetAt: figures.resetAt,
    // What was already used when this process first saw the window.
    baseline: Math.max(0, figures.used - (free ? 0 : 1)),
    maxUsed: figures.used,
    counted: 0,
    free: 0,
    rows: new Map(),
  };
}

/**
 * Count one request that GitHub answered, against the window its own
 * headers name. `caller` comes from callerFromStack(), taken before the
 * request was sent; `status` is the answer's. A response without figures (a
 * network error, a stub) reached nothing that counts, so it is not counted.
 */
function noteRequest(credential, { method = 'GET', url = '', caller = 'unknown', status = 0, headers = null } = {}) {
  const cred = normalizeCredential(credential);
  if (!cred) return;
  const figures = parse(headers);
  if (!figures) return;
  const key = `${cred}|${figures.resource}`;
  let slot = spend.get(key);
  const free = Number(status) === 304;
  if (!slot) {
    slot = { current: newWindow(figures, free), previous: null };
    spend.set(key, slot);
  } else if (figures.resetAt >= slot.current.resetAt + SAME_WINDOW_MS) {
    slot.previous = slot.current;
    slot.current = newWindow(figures, free);
  } else if (figures.resetAt <= slot.current.resetAt - SAME_WINDOW_MS) {
    // A late answer from the window before: it belongs there, if anywhere.
    if (!slot.previous || Math.abs(figures.resetAt - slot.previous.resetAt) >= SAME_WINDOW_MS) return;
  }
  const w = Math.abs(figures.resetAt - slot.current.resetAt) < SAME_WINDOW_MS ? slot.current : slot.previous;
  const endpoint = endpointOf(method, url);
  let rowKey = `${caller}\u0000${endpoint}`;
  if (!w.rows.has(rowKey) && w.rows.size >= SPEND_MAX_ROWS) rowKey = `${OTHER_CALLERS}\u0000*`;
  let row = w.rows.get(rowKey);
  if (!row) {
    row = rowKey.startsWith(`${OTHER_CALLERS}\u0000`)
      ? { caller: OTHER_CALLERS, endpoint: '*', count: 0, free: 0 }
      : { caller, endpoint, count: 0, free: 0 };
    w.rows.set(rowKey, row);
  }
  if (free) {
    row.free += 1;
    w.free += 1;
  } else {
    row.count += 1;
    w.counted += 1;
  }
  w.maxUsed = Math.max(w.maxUsed, figures.used);
  // Answers land out of order. The lowest `used` any of them carries is the
  // first of this process's requests GitHub counted, so one less than it is
  // what was spent before this process joined the window.
  w.baseline = Math.max(0, Math.min(w.baseline, figures.used - (free ? 0 : 1)));
}

// One window, for snapshot(): the top callers with their top endpoints.
function spendSummary(w, { now = Date.now() } = {}) {
  if (!w) return null;
  const byCaller = new Map();
  for (const row of w.rows.values()) {
    let c = byCaller.get(row.caller);
    if (!c) {
      c = { caller: row.caller, count: 0, free: 0, endpoints: [] };
      byCaller.set(row.caller, c);
    }
    c.count += row.count;
    c.free += row.free;
    c.endpoints.push({ endpoint: row.endpoint, count: row.count, free: row.free });
  }
  const callers = [...byCaller.values()]
    .sort((a, b) => (b.count - a.count) || (b.free - a.free) || a.caller.localeCompare(b.caller));
  const top = callers.slice(0, SPEND_TOP_CALLERS).map((c) => ({
    ...c,
    endpoints: c.endpoints
      .sort((a, b) => (b.count - a.count) || (b.free - a.free) || a.endpoint.localeCompare(b.endpoint))
      .slice(0, SPEND_TOP_ENDPOINTS),
  }));
  const rest = callers.slice(SPEND_TOP_CALLERS);
  return {
    resetAt: new Date(w.resetAt).toISOString(),
    expired: w.resetAt <= now,
    counted: w.counted,
    free: w.free,
    usedBeforeCounting: w.baseline,
    notCounted: Math.max(0, w.maxUsed - w.baseline - w.counted),
    callers: top,
    otherCallers: rest.length ? { callers: rest.length, count: rest.reduce((n, c) => n + c.count, 0) } : null,
  };
}

function installationCredentials() {
  return [...state.keys()].filter((c) => c.startsWith('installation:'));
}

// The credential(s) background work spends: the bot token when one is
// configured (services/github.js getOctokit prefers it), else the App
// installation for `owner`, or every known installation when no owner is
// named.
function backgroundCredentials(owner) {
  if (process.env.GITHUB_BOT_TOKEN) return ['pat'];
  if (owner) return [normalizeCredential(`installation:${owner}`)].filter(Boolean);
  return installationCredentials();
}

function reserveFor(limit) {
  return Math.ceil(limit * RESERVE_RATIO);
}

/**
 * Null when background GitHub work may go ahead, else why not:
 * { credential, remaining, limit, reserve, resetAt, retryInMs }.
 * Logs once per credential per window when it first holds.
 */
function backgroundHold({ credential = null, owner = null, now = Date.now() } = {}) {
  const creds = credential ? [normalizeCredential(credential)].filter(Boolean) : backgroundCredentials(owner);
  for (const cred of creds) {
    const c = core(cred, { now });
    if (!c || c.expired) continue;
    const reserve = reserveFor(c.limit);
    if (c.remaining >= reserve) continue;
    const hold = {
      credential: cred,
      remaining: c.remaining,
      limit: c.limit,
      reserve,
      resetAt: c.resetAt,
      retryInMs: Math.max(0, c.resetAt - now),
    };
    const key = `${cred}@${c.resetAt}`;
    if (!heldLogged.has(key)) {
      heldLogged.add(key);
      if (heldLogged.size > 64) heldLogged.delete(heldLogged.values().next().value);
      log.warn('github-budget', 'Holding background GitHub work until the hourly budget resets', {
        credential: cred,
        remaining: c.remaining,
        limit: c.limit,
        reserve,
        resetInMinutes: Math.ceil(hold.retryInMs / 60000),
      });
    }
    return hold;
  }
  return null;
}

/**
 * Whether work of this kind may spend GitHub budget now. Only 'background'
 * is ever held back; anything else (a person's request) is always allowed.
 */
function budgetAllows(kind = 'background', opts = {}) {
  if (kind !== 'background') return true;
  return !backgroundHold(opts);
}

/**
 * The figures the platform-limit alert measures, for one credential class:
 * 'pat' for the bot token, 'installation' for the App (the most-used of its
 * installations). { used, cap } with both 0 when nothing is known.
 */
function alertFigures(kind, { now = Date.now() } = {}) {
  const creds = kind === 'installation' ? installationCredentials() : [normalizeCredential(kind)];
  let best = { used: 0, cap: 0 };
  let bestRatio = -1;
  for (const cred of creds) {
    const c = cred && core(cred, { now });
    if (!c) continue;
    const ratio = c.limit > 0 ? c.used / c.limit : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = { used: Math.min(c.used, c.limit), cap: c.limit };
    }
  }
  return best;
}

/**
 * Everything recorded, for the admin read: one row per credential and
 * resource, the bot token first, core first within each.
 */
function snapshot({ now = Date.now() } = {}) {
  const rows = [];
  for (const [credential, byResource] of state) {
    for (const [resource, e] of byResource) {
      const expired = e.resetAt <= now;
      const slot = spend.get(`${credential}|${resource}`);
      rows.push({
        credential,
        kind: credential === 'pat' ? 'pat' : (credential === 'anonymous' ? 'anonymous' : 'installation'),
        owner: credential.startsWith('installation:') ? credential.slice('installation:'.length) : null,
        resource,
        limit: e.limit,
        remaining: e.remaining,
        used: e.used,
        resetAt: new Date(e.resetAt).toISOString(),
        resetInSeconds: Math.max(0, Math.round((e.resetAt - now) / 1000)),
        observedAt: new Date(e.observedAt).toISOString(),
        expired,
        held: resource === 'core' && !expired && e.remaining < reserveFor(e.limit),
        spend: spendSummary(slot && slot.current, { now }),
        previousSpend: spendSummary(slot && slot.previous, { now }),
      });
    }
  }
  const order = { pat: 0, installation: 1, anonymous: 2 };
  rows.sort((a, b) => (order[a.kind] - order[b.kind])
    || a.credential.localeCompare(b.credential)
    || (a.resource === 'core' ? -1 : 0) - (b.resource === 'core' ? -1 : 0)
    || a.resource.localeCompare(b.resource));
  return {
    reservePercent: Math.round(RESERVE_RATIO * 100),
    credentials: rows,
    reads: {
      installation: reads.installation,
      pat: reads.pat,
      patReasons: { ...reads.patReasons },
      noInstallation: { ...reads.noInstallation },
    },
  };
}

/**
 * Fixed sample figures in snapshot()'s shape, for a platform preview, which
 * has no GitHub token and so never records any (routes/admin.js). One
 * credential under the reserve, so the preview shows the held state too.
 */
function demoSnapshot({ now = Date.now() } = {}) {
  const row = (credential, limit, remaining, resetMin) => {
    const resetAt = now + resetMin * 60 * 1000;
    return {
      credential,
      kind: credential === 'pat' ? 'pat' : 'installation',
      owner: credential.startsWith('installation:') ? credential.slice('installation:'.length) : null,
      resource: 'core',
      limit,
      remaining,
      used: limit - remaining,
      resetAt: new Date(resetAt).toISOString(),
      resetInSeconds: resetMin * 60,
      observedAt: new Date(now - 20 * 1000).toISOString(),
      expired: false,
      held: remaining < reserveFor(limit),
      spend: null,
      previousSpend: null,
    };
  };
  const caller = (name, count, endpoints) => ({
    caller: name,
    count,
    free: 0,
    endpoints: endpoints.map(([endpoint, n]) => ({ endpoint, count: n, free: 0 })),
  });
  const pat = row('pat', 5000, 612, 23);
  pat.spend = {
    resetAt: pat.resetAt,
    expired: false,
    counted: 3605,
    free: 140,
    usedBeforeCounting: 0,
    notCounted: 783,
    callers: [
      caller('recoverStuckMerges (server.js)', 1490, [['GET /repos/{owner}/{repo}/pulls/{pull_number}', 1490]]),
      caller('syncImportedProposal (services/pr-import-sync.js)', 1122, [
        ['GET /repos/{owner}/{repo}/pulls/{pull_number}', 801],
        ['GET /repos/{owner}/{repo}/compare/{basehead}', 321],
      ]),
      caller('sweepBranches (services/bench/lane.js)', 640, [['DELETE /repos/{owner}/{repo}/git/refs/{ref}', 640]]),
      caller('checkAndMerge (routes/votes.js)', 353, [['PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', 353]]),
    ],
    otherCallers: null,
  };
  return {
    reservePercent: Math.round(RESERVE_RATIO * 100),
    credentials: [
      pat,
      row('installation:usernode-labs', 12500, 11870, 41),
    ],
    reads: {
      installation: 6630,
      pat: 1490,
      patReasons: { no_installation: 1490 },
      noInstallation: { 'Sample-Org': 1490 },
    },
  };
}

// ── Saying what happened ──────────────────────────────────────────────

/**
 * Whether `err` is GitHub refusing a request because a primary (hourly)
 * budget is used up: a 403 or 429 that says x-ratelimit-remaining: 0, or
 * GitHub's own "API rate limit exceeded" wording when the headers are gone
 * (an error passed along as a message). A secondary (per-minute) limit keeps
 * remaining above zero and is not this.
 */
function isRateLimitError(err) {
  if (!err) return false;
  const status = Number(err.status || (err.response && err.response.status)) || 0;
  const get = headerGetter(err.response && err.response.headers);
  if ((status === 403 || status === 429) && get('x-ratelimit-remaining') === '0') return true;
  return /\bAPI rate limit exceeded\b/i.test(String(err.message || err));
}

// When the budget that refused `err` resets, in ms from now, or null when
// nothing says. The error's own header first, then the bot token's recorded
// window (the credential nearly every refusal comes from).
function resetInMs(err, { now = Date.now() } = {}) {
  const get = headerGetter(err && err.response && err.response.headers);
  const reset = toInt(get('x-ratelimit-reset'));
  if (reset != null && reset * 1000 > now) return reset * 1000 - now;
  for (const cred of [...backgroundCredentials(), 'pat']) {
    const c = core(cred, { now });
    if (c && !c.expired && c.remaining === 0) return c.resetAt - now;
  }
  return null;
}

function aboutMinutes(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m === 1 ? 'about a minute' : `about ${m} minutes`;
}

/**
 * "GitHub's hourly limit for Homeroom is used up. It resets in about 12
 * minutes." for a rate-limit refusal, else null.
 */
function rateLimitNotice(err, { now = Date.now() } = {}) {
  if (!isRateLimitError(err)) return null;
  const ms = resetInMs(err, { now });
  const when = ms == null ? 'It resets within the hour.' : `It resets in ${aboutMinutes(ms)}.`;
  return `GitHub's hourly limit for Homeroom is used up. ${when}`;
}

/** Seconds until the refusing budget resets, or null (for a Retry-After). */
function rateLimitRetryAfterSeconds(err, { now = Date.now() } = {}) {
  if (!isRateLimitError(err)) return null;
  const ms = resetInMs(err, { now });
  return ms == null ? null : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * The body of a route's 503 `github_unavailable`: the bare code as before,
 * plus `message` (and `retryAfterSeconds`) when the refusal was the hourly
 * budget, so a CLI or connector can say what really happened.
 */
function githubUnavailableBody(err, { now = Date.now() } = {}) {
  const message = rateLimitNotice(err, { now });
  if (!message) return { error: 'github_unavailable' };
  const retryAfterSeconds = rateLimitRetryAfterSeconds(err, { now });
  return { error: 'github_unavailable', message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

function _resetForTests() {
  state.clear();
  heldLogged.clear();
  spend.clear();
  reads.installation = 0;
  reads.pat = 0;
  reads.patReasons = {};
  reads.noInstallation = Object.create(null);
}

module.exports = {
  RESERVE_RATIO,
  record,
  core,
  isExhausted,
  noteRead,
  noteRequest,
  callerFromStack,
  endpointOf,
  snapshot,
  demoSnapshot,
  alertFigures,
  backgroundHold,
  budgetAllows,
  isRateLimitError,
  rateLimitNotice,
  rateLimitRetryAfterSeconds,
  githubUnavailableBody,
  _resetForTests,
};
