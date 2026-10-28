'use strict';

const crypto = require('node:crypto');
const events = require('./events');
const usernames = require('./usernames');
const leftOut = require('./journey-left-out');
const usageAnalytics = require('./usage-analytics');
const { scrubText } = require('./platform-signal-evidence');

const MAX_BATCH_EVENTS = 25;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DURATION_MS = 30 * 60 * 1000;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{15,79}$/;
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BUILD_RE = /^(?:[0-9a-f]{7,40}|dev)$/;

// The seven representative journeys #3553 instruments for its failure
// report. That report (aggregate below) reads only these, so the navigation
// codes added for the admin Journey page (#3369) never change its numbers.
const JOURNEY_SCREENS = Object.freeze(new Set([
  'shell_boot', 'app_detail', 'app_discussion', 'feedback_dialog',
  'report_dialog', 'change_workspace', 'preview',
  // The first-session plan: "Get a ping when it's ready?" in the Homeroom
  // app (NativeChrome.askForPing), the ask its push_permission answers.
  'ping_ask',
  // The notification ask at its other moments (frontend/src/features/
  // notify-ask/): an invite sent, a suggestion, a reply, a community, a
  // project opening. Which moment is the account's record
  // (services/notification-asks.js), not this event's.
  'notify_ask',
]));
// Navigation (#3369): one code per screen root the shell reveals, so a
// person's path can be read in the order they took it. `app` is the running
// app; `project` is the platform's own surface about one app (its hub,
// Workshop, discussion, a change). Named roots only: never an address, a
// conversation or anything inside an app.
//
// The first-run sheets and the welcome tour are steps too: drawn over a
// screen, they are where a newcomer is, and "shown, not answered" is read
// from them. Each reports itself; closing one re-reports the screen under it.
//
// `assistant` was Global Chat's screen. Nothing reports it since Global Chat
// was removed, but it stays a code so the visits already recorded still read
// as steps (journey.js) and as landings in the page-load report.
const NAV_SCREENS = Object.freeze(new Set([
  'home', 'discover', 'communities', 'challenges', 'profile', 'my_proposals',
  'settings', 'messages', 'assistant', 'agent_session', 'app', 'project',
  'username_sheet', 'terms_sheet', 'join_sheet', 'tour',
]));
const SCREENS = Object.freeze(new Set([...JOURNEY_SCREENS, ...NAV_SCREENS]));
// How a person arrived at a navigation screen. `returned` marks the screen
// re-reported when the app comes back to the foreground after a long break:
// the phone app keeps one page open for days, so without it two days of use
// would read as one visit.
const VIAS = Object.freeze(new Set(['own', 'nudged', 'handed', 'address', 'back', 'returned']));
const SCHEMA_VERSIONS = Object.freeze(new Set([1, 2]));
const ACTIONS = Object.freeze(new Set([
  'shell_boot', 'app_detail_load', 'app_discussion_load',
  'feedback_submit', 'content_report_submit', 'change_create', 'preview_open',
  // The answer to the ping ask: success is allowed, failure (access_denied)
  // is the phone's permission refused, cancelled is "Not now". A guardrail
  // of the first-session plan: how often pushes are denied.
  'push_permission',
  // A request/proposal/governance page opened from a link (#4524): the
  // measure the fast-open work reports against. Keep identical with the
  // client's ACTIONS.
  'topic_load',
]));
const KINDS = Object.freeze(new Set([
  'screen_visit', 'action_attempt', 'action_outcome', 'repeated_action',
  'loading_timeout', 'navigation_abandonment', 'recovery', 'boot_failure',
  // The page was hidden or closed while a navigation screen was showing: the
  // end of the last screen of a visit, so time on it is known.
  'screen_hidden',
  // One measured full page load (#4965): a duration credited to the first
  // real screen the shell showed, or shell_boot when none did before it
  // ended.
  'page_load',
  // A script error after boot (platform signals, wave 2): a fixed name, a
  // placeholder-only template, this origin's own frame and their hash, on
  // the screen showing. services/signal-observers/client-errors.js files
  // the ones several visits hit; topic-figures.js counts the visits.
  'client_error',
]));
const OUTCOMES = Object.freeze(new Set(['success', 'failure', 'cancelled']));
const ERROR_CODES = Object.freeze(new Set([
  'access_denied', 'app_blocked', 'boot_incomplete', 'boot_rejection',
  'boot_resource_failed', 'boot_script_error', 'boot_step_failed',
  'conflict', 'invalid_response', 'network', 'not_found', 'offline',
  'rate_limited', 'server_error', 'target_unavailable', 'unavailable',
  'unknown',
]));
const EVENT_KEYS = Object.freeze([
  'id', 'visitId', 'attemptId', 'kind', 'screen', 'action', 'outcome',
  'errorCode', 'durationMs', 'appSlug', 'build', 'occurredAt', 'sequence',
  'via', 'errorName', 'template', 'frame',
]);

// ── client_error ────────────────────────────────────────────────────────
//
// Exactly these fields, and nothing a person could have typed except the
// template, which arrives with every value already a placeholder and is
// made so again here before it is stored: the request a run of them files
// (signal-observers/client-errors.js) is public. Keep the name list, the
// two patterns, the template rules and the code identical with
// public/js/ui-telemetry.js (tests/client-errors.test.js holds them to each
// other).
const CLIENT_ERROR_KEYS = Object.freeze([
  'id', 'visitId', 'kind', 'screen', 'errorCode', 'errorName', 'template', 'frame',
  'build', 'occurredAt', 'sequence',
]);
const CLIENT_ERROR_ONLY_KEYS = Object.freeze(['errorName', 'template', 'frame']);
const CLIENT_ERROR_NAMES = Object.freeze(new Set([
  'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError', 'InternalError', 'DOMException',
  'AbortError', 'NotAllowedError', 'NotFoundError', 'NotSupportedError',
  'InvalidStateError', 'SecurityError', 'QuotaExceededError', 'NetworkError',
  'TimeoutError', 'DataCloneError', 'InvalidAccessError',
  'HierarchyRequestError', 'InvalidCharacterError', 'NotReadableError',
  'OperationError',
]));
const CLIENT_ERROR_CODE_RE = /^js_[a-z0-9]{6,16}$/;
// The first frame in this origin's own scripts, without origin, build
// prefix or query: `/js/app.js:12:34`, `/shell/assets/shell.js:1:2345`.
const CLIENT_ERROR_FRAME_RE = /^\/(?:js|shell\/assets)\/[A-Za-z0-9_.\/-]{1,160}:\d{1,7}:\d{1,7}$/;
const MAX_TEMPLATE_CHARS = 120;

function isClientErrorFrame(value) {
  return typeof value === 'string' && CLIENT_ERROR_FRAME_RE.test(value)
    && !value.includes('..') && !value.includes('//');
}

// Lone surrogates out: Postgres refuses them in jsonb.
function wellFormed(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { out += text[i] + text[i + 1]; i += 1; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += text[i];
  }
  return out;
}

function clipTemplate(text) {
  return text.length > MAX_TEMPLATE_CHARS
    ? `${wellFormed(text.slice(0, MAX_TEMPLATE_CHARS - 1))}\u2026` : text;
}

function templatePass(text) {
  let out = text
    // Control, bidi and zero-width characters say nothing about an error.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi, '[url]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/"[^"]*"/g, '[string]')
    .replace(/`[^`]*`/g, '[string]')
    .replace(/[\u201c\u2018][^\u201d\u2019]*[\u201d\u2019]/g, '[string]');
  // A single quote opens a string only where it is not an apostrophe
  // ("can't"); repeated, because a replaced string can open the next.
  for (let i = 0; i < 20; i += 1) {
    const next = out.replace(/(^|[^A-Za-z0-9])'[^']*'/g, '$1[string]');
    if (next === out) break;
    out = next;
  }
  out = out
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b0x[0-9a-f]+\b/gi, '[hex]')
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{6,}\b/gi, '[hex]')
    .replace(/(^|[^A-Za-z0-9])\d+(?:[.,]\d+)*/g, '$1[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return clipTemplate(wellFormed(out));
}

/** Pure: an error's message as a template, placeholders for every value. */
function normalizeErrorTemplate(raw) {
  let out = templatePass(wellFormed(String(raw == null ? '' : raw).slice(0, 2000)));
  for (let i = 0; i < 3; i += 1) {
    const next = templatePass(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Pure: a short stable hash (cyrb53, base 36, 11 characters). */
function errorHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}

/**
 * Pure: the code a script error is grouped by: its name, its template and
 * its frame's file (never the line and column, which move with every build
 * of the shell bundle, so one bug keeps one code across releases).
 */
function clientErrorCode(errorName, template, frame) {
  const path = String(frame || '').replace(/:\d+:\d+$/, '');
  return `js_${errorHash(`${errorName}|${template}|${path}`)}`;
}

/** Pure: the template as stored: normalized again, scrubbed, bounded. */
function storedErrorTemplate(raw) {
  return clipTemplate(wellFormed(scrubText(normalizeErrorTemplate(raw)).replace(/\s+/g, ' ').trim()));
}

class TelemetryValidationError extends Error {}

// Which language a person's browser asks for first, so the languages Homeroom
// ships can be chosen from the people who use it (#3659). The client sends
// nothing new: this reads the Accept-Language header of the request that
// delivers a batch, and insertBatch notes it on that batch's shell start.
// Kept to language, script and region ("es-MX", "zh-Hant-TW"): a tag's
// variants and extensions say more about a device than a language list needs.
const BROWSER_LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;
const MAX_ACCEPT_LANGUAGE_LENGTH = 512;

function browserLanguage(header) {
  if (typeof header !== 'string' || !header || header.length > MAX_ACCEPT_LANGUAGE_LENGTH) return null;
  let best = null;
  for (const part of header.split(',')) {
    const [range, ...parameters] = part.split(';').map((piece) => piece.trim());
    const weight = parameters.find((piece) => /^q=/i.test(piece));
    const q = weight === undefined ? 1 : Number(weight.slice(2));
    // Listed first wins a tie, which is how browsers order equal preferences.
    if (!range || range === '*' || !(q > 0) || q > 1 || (best && q <= best.q)) continue;
    best = { range, q };
  }
  if (!best) return null;
  let locale;
  try { locale = new Intl.Locale(best.range); } catch { return null; }
  const tag = [locale.language, locale.script, locale.region].filter(Boolean).join('-');
  return BROWSER_LANGUAGE_RE.test(tag) ? tag : null;
}

// Browser checks use real authenticated sessions so protected screens can be
// exercised. Their fixed handles are the authoritative boundary: role is not
// one, because human full/view admins still produce useful journey evidence.
function isEligibleUser(user) {
  return !!user?.id && !usernames.isServiceIdentity(user.username);
}

// Eligible, switched "Share usage analytics" on in Settings (#5097: off
// unless they did, services/usage-analytics.js), and has not objected to
// being recorded (#3369: an admin adds them to the Journey page's left-out
// list as "objected"). This is the answer /api/auth/me sends as
// uiTelemetryEligible and the collector enforces.
async function isRecordable(pool, user) {
  if (!isEligibleUser(user)) return false;
  if (!(await usageAnalytics.sharesUsageAnalytics(pool, user.id))) return false;
  return !(await leftOut.hasObjected(pool, user.id));
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new TelemetryValidationError(`${label} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new TelemetryValidationError(`${label} contains unsupported field: ${extra}`);
}

function opaqueId(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new TelemetryValidationError(`${label} must be an opaque id`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TelemetryValidationError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function oneOf(value, allowed, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new TelemetryValidationError(`${label} is not allowlisted`);
  }
  return value;
}

function eventTimestamp(value, nowMs) {
  if (typeof value !== 'string' || value.length > 32) {
    throw new TelemetryValidationError('event.occurredAt must be an RFC3339 timestamp');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)
      || ms < nowMs - MAX_EVENT_AGE_MS
      || ms > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new TelemetryValidationError('event.occurredAt is outside the accepted window');
  }
  return new Date(ms).toISOString();
}

// A script error after boot: its own fields, and none of an attempt's.
function parseClientError(value, index, nowMs) {
  const label = `events[${index}]`;
  exactKeys(value, CLIENT_ERROR_KEYS, label);
  const screen = oneOf(value.screen, SCREENS, `${label}.screen`);
  if (typeof value.errorCode !== 'string' || !CLIENT_ERROR_CODE_RE.test(value.errorCode)) {
    throw new TelemetryValidationError(`${label}.errorCode is not a script error code`);
  }
  const errorName = oneOf(value.errorName, CLIENT_ERROR_NAMES, `${label}.errorName`);
  if (typeof value.template !== 'string' || value.template.length > MAX_TEMPLATE_CHARS) {
    throw new TelemetryValidationError(`${label}.template must be at most ${MAX_TEMPLATE_CHARS} characters`);
  }
  let frame = null;
  if (value.frame != null) {
    if (!isClientErrorFrame(value.frame)) {
      throw new TelemetryValidationError(`${label}.frame must be a frame in this origin's own scripts`);
    }
    frame = value.frame;
  }
  const template = storedErrorTemplate(value.template);
  // The code is the collector's own, from what it was sent (before the
  // scrub, as the client computed it), so a client cannot file one error
  // under another's code. An honest client sent this same code; one whose
  // copy of the rules drifted is regrouped here rather than refused, which
  // would drop its whole batch.
  const errorCode = clientErrorCode(errorName, normalizeErrorTemplate(value.template), frame);
  if (!template && !frame) {
    throw new TelemetryValidationError('client_error requires a template or a frame');
  }
  let build = null;
  if (value.build != null) {
    if (typeof value.build !== 'string' || !BUILD_RE.test(value.build)) {
      throw new TelemetryValidationError(`${label}.build is invalid`);
    }
    build = value.build;
  }
  return {
    eventId: opaqueId(value.id, `${label}.id`),
    visitId: opaqueId(value.visitId, `${label}.visitId`),
    attemptId: null,
    kind: 'client_error',
    screen,
    action: null,
    outcome: null,
    errorCode,
    durationMs: null,
    appSlug: null,
    build,
    occurredAt: eventTimestamp(value.occurredAt, nowMs),
    sequence: integer(value.sequence, `${label}.sequence`, 1, 1_000_000),
    via: null,
    errorName,
    template,
    frame,
  };
}

function parseEvent(value, index, nowMs) {
  exactKeys(value, EVENT_KEYS, `events[${index}]`);
  const kind = oneOf(value.kind, KINDS, `events[${index}].kind`);
  if (kind === 'client_error') return parseClientError(value, index, nowMs);
  const scriptOnly = CLIENT_ERROR_ONLY_KEYS.find((key) => value[key] != null);
  if (scriptOnly) {
    throw new TelemetryValidationError(`${scriptOnly} is only valid on a client_error`);
  }
  const screen = oneOf(value.screen, SCREENS, `events[${index}].screen`);
  const action = oneOf(value.action, ACTIONS, `events[${index}].action`, true);
  const outcome = oneOf(value.outcome, OUTCOMES, `events[${index}].outcome`, true);
  const errorCode = oneOf(value.errorCode, ERROR_CODES, `events[${index}].errorCode`, true);
  const attemptId = opaqueId(value.attemptId, `events[${index}].attemptId`, true);
  const via = oneOf(value.via, VIAS, `events[${index}].via`, true);
  if (via && !(kind === 'screen_visit' && NAV_SCREENS.has(screen))) {
    throw new TelemetryValidationError('via is only valid on a navigation screen_visit');
  }
  if (kind === 'screen_hidden' && (!NAV_SCREENS.has(screen) || attemptId || action || outcome
      || errorCode || value.durationMs != null)) {
    throw new TelemetryValidationError('screen_hidden is a bare mark on a navigation screen');
  }

  if (kind === 'action_attempt' && (!action || !attemptId)) {
    throw new TelemetryValidationError('action_attempt requires action and attemptId');
  }
  if (['action_outcome', 'loading_timeout', 'navigation_abandonment', 'recovery', 'repeated_action']
    .includes(kind) && (!action || !attemptId)) {
    throw new TelemetryValidationError(`${kind} requires action and attemptId`);
  }
  if (kind === 'action_outcome' && !outcome) {
    throw new TelemetryValidationError('action_outcome requires outcome');
  }
  if (kind !== 'action_outcome' && outcome) {
    throw new TelemetryValidationError('outcome is only valid for action_outcome');
  }
  if (kind === 'boot_failure' && (!errorCode || screen !== 'shell_boot')) {
    throw new TelemetryValidationError('boot_failure requires a safe errorCode on shell_boot');
  }
  if (errorCode && kind !== 'boot_failure'
      && !(kind === 'action_outcome' && outcome === 'failure')) {
    throw new TelemetryValidationError('errorCode is only valid for failures');
  }

  let appSlug = null;
  if (value.appSlug != null) {
    if (typeof value.appSlug !== 'string' || !APP_SLUG_RE.test(value.appSlug)) {
      throw new TelemetryValidationError(`events[${index}].appSlug is invalid`);
    }
    appSlug = value.appSlug;
  }
  let build = null;
  if (value.build != null) {
    if (typeof value.build !== 'string' || !BUILD_RE.test(value.build)) {
      throw new TelemetryValidationError(`events[${index}].build is invalid`);
    }
    build = value.build;
  }
  const durationMs = value.durationMs == null ? null
    : integer(value.durationMs, `events[${index}].durationMs`, 0, MAX_DURATION_MS);
  if (kind === 'screen_visit' && (attemptId || action || outcome || errorCode || durationMs != null)) {
    throw new TelemetryValidationError('screen_visit cannot carry action details');
  }
  if (kind === 'action_attempt' && (outcome || errorCode || durationMs != null)) {
    throw new TelemetryValidationError('action_attempt cannot carry an outcome');
  }
  if (kind === 'action_outcome' && durationMs == null) {
    throw new TelemetryValidationError('action_outcome requires durationMs');
  }
  if (kind === 'action_outcome' && outcome === 'failure' && !errorCode) {
    throw new TelemetryValidationError('failed action_outcome requires a safe errorCode');
  }
  if (['loading_timeout', 'navigation_abandonment', 'recovery'].includes(kind)
      && durationMs == null) {
    throw new TelemetryValidationError(`${kind} requires durationMs`);
  }
  if (kind === 'repeated_action' && durationMs != null) {
    throw new TelemetryValidationError('repeated_action cannot carry durationMs');
  }
  // A page load (#4965) is one bare duration on the screen it is credited to:
  // only the screen name and the milliseconds are sent, nothing about a
  // visit or an attempt is known.
  if (kind === 'page_load' && !(NAV_SCREENS.has(screen) || screen === 'shell_boot')) {
    throw new TelemetryValidationError('page_load is a duration on a landing screen');
  }
  if (kind === 'page_load' && (attemptId || action || outcome || errorCode || via)) {
    throw new TelemetryValidationError('page_load is a bare duration');
  }
  if (kind === 'page_load' && durationMs == null) {
    throw new TelemetryValidationError('page_load requires durationMs');
  }
  if (kind === 'boot_failure' && (action !== 'shell_boot' || !attemptId || durationMs != null)) {
    throw new TelemetryValidationError('boot_failure requires the shell_boot attempt');
  }
  return {
    eventId: opaqueId(value.id, `events[${index}].id`),
    visitId: opaqueId(value.visitId, `events[${index}].visitId`),
    attemptId,
    kind,
    screen,
    action,
    outcome,
    errorCode,
    durationMs,
    appSlug,
    build,
    occurredAt: eventTimestamp(value.occurredAt, nowMs),
    sequence: integer(value.sequence, `events[${index}].sequence`, 1, 1_000_000),
    via,
  };
}

function parseBatch(body, { nowMs = Date.now() } = {}) {
  if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > MAX_BODY_BYTES) {
    throw new TelemetryValidationError('batch is too large');
  }
  exactKeys(body, ['schemaVersion', 'batchId', 'events', 'delivery'], 'body');
  // Version 2 adds navigation (#3369). Version 1 stays accepted: a shell
  // cached before it shipped keeps reporting its failures, and the Journey
  // page reads a person with no navigation rows as "no navigation data".
  if (!SCHEMA_VERSIONS.has(body.schemaVersion)) {
    throw new TelemetryValidationError('schemaVersion must be 1 or 2');
  }
  const batchId = opaqueId(body.batchId, 'batchId');
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_BATCH_EVENTS) {
    throw new TelemetryValidationError(`events must contain 1-${MAX_BATCH_EVENTS} records`);
  }
  exactKeys(body.delivery, ['failedBatches', 'droppedEvents'], 'delivery');
  const delivery = {
    failedBatches: integer(body.delivery.failedBatches, 'delivery.failedBatches', 0, 10_000),
    droppedEvents: integer(body.delivery.droppedEvents, 'delivery.droppedEvents', 0, 10_000),
  };
  const parsed = body.events.map((value, index) => parseEvent(value, index, nowMs));
  const ids = new Set(parsed.map((event) => event.eventId));
  if (ids.size !== parsed.length) throw new TelemetryValidationError('event ids must be unique within a batch');
  return { batchId, events: parsed, delivery };
}

function eventMetadata(event, language = null) {
  const metadata = {
    eventId: event.eventId,
    visitId: event.visitId,
    kind: event.kind,
    screen: event.screen,
    sequence: event.sequence,
  };
  for (const key of ['attemptId', 'action', 'outcome', 'errorCode', 'durationMs', 'build', 'via',
    'errorName', 'template', 'frame']) {
    if (event[key] != null) metadata[key] = event[key];
  }
  // Once per shell start is all browserLanguages() reads.
  if (language && event.kind === 'screen_visit' && event.screen === 'shell_boot') {
    metadata.language = language;
  }
  return metadata;
}

// `language` is browserLanguage() of the delivering request, or null.
async function insertBatch(pool, userId, batch, { language = null } = {}) {
  const client = await pool.connect();
  let accepted = 0;
  try {
    await client.query('BEGIN');
    for (const event of batch.events) {
      const result = await client.query(
        `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
         VALUES ($1, (SELECT id FROM apps WHERE slug = $2), $3, $4::jsonb, $5::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, event.appSlug, events.EVENT_TYPES.UI_EXPERIENCE,
          JSON.stringify(eventMetadata(event, language)), event.occurredAt]
      );
      accepted += result.rowCount || 0;
    }
    const receipt = await client.query(
      `INSERT INTO events (user_id, event_type, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, events.EVENT_TYPES.UI_TELEMETRY_DELIVERY, JSON.stringify({
        batchId: batch.batchId,
        submitted: batch.events.length,
        accepted,
        failedBatches: batch.delivery.failedBatches,
        droppedEvents: batch.delivery.droppedEvents,
      })]
    );
    if (!receipt.rowCount) {
      // A lost success response makes the client retry the same batch with
      // increased loss counters. Preserve the original accepted count while
      // letting that later delivery evidence reach the coverage report.
      await client.query(
        `UPDATE events SET metadata = metadata || jsonb_build_object(
           'failedBatches', GREATEST(COALESCE((metadata->>'failedBatches')::int, 0), $4::int),
           'droppedEvents', GREATEST(COALESCE((metadata->>'droppedEvents')::int, 0), $5::int)
         )
         WHERE user_id = $1 AND event_type = $2 AND metadata->>'batchId' = $3`,
        [userId, events.EVENT_TYPES.UI_TELEMETRY_DELIVERY, batch.batchId,
          batch.delivery.failedBatches, batch.delivery.droppedEvents]
      );
    }
    await client.query('COMMIT');
    return { accepted, duplicate: accepted === 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function safeServerError(status, message) {
  if (status === 429) return 'rate_limited';
  if (status === 403 || status === 401) return 'access_denied';
  if (status === 404 && /target unavailable/i.test(String(message || ''))) return 'target_unavailable';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

function requestOpaqueId(req, header) {
  const value = req && typeof req.get === 'function' ? req.get(header) : null;
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

async function recordServerFailure(pool, req, { screen, action, status, message }) {
  if (!isEligibleUser(req?.user) || !SCREENS.has(screen) || !ACTIONS.has(action)) return;
  if (!(await isRecordable(pool, req.user))) return;
  const metadata = {
    eventId: crypto.randomUUID(),
    visitId: requestOpaqueId(req, 'x-ui-visit-id') || crypto.randomUUID(),
    attemptId: requestOpaqueId(req, 'x-ui-attempt-id'),
    kind: 'server_failure',
    screen,
    action,
    errorCode: safeServerError(status, message),
    source: 'server',
  };
  if (!metadata.attemptId) delete metadata.attemptId;
  return events.record(pool, {
    type: events.EVENT_TYPES.UI_EXPERIENCE,
    userId: req.user.id,
    metadata,
  });
}

function daysWindow(raw) {
  const value = Number(raw || 14);
  return [1, 7, 14, 30, 90].includes(value) ? value : 14;
}

// People per browser language over the window: each person once, under the
// language of their most recent shell start. The same people the failure
// report counts (no service identities, nobody who objected to recording,
// since neither is ever stored), admins left out unless asked for.
async function browserLanguages(pool, { days = 14, includeAdmins = false } = {}) {
  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (e.user_id) e.user_id, e.metadata->>'language' AS language
         FROM events e JOIN users u ON u.id = e.user_id
        WHERE e.event_type = 'ui_experience'
          AND e.metadata->>'kind' = 'screen_visit'
          AND e.metadata->>'screen' = 'shell_boot'
          AND e.metadata ? 'language'
          AND e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND ($3::boolean OR NOT u.is_admin)
          AND NOT (LOWER(u.username) = ANY($2::text[]))
        ORDER BY e.user_id, e.created_at DESC, e.id DESC
     )
     SELECT language, COUNT(*)::int AS people
       FROM latest GROUP BY language ORDER BY people DESC, language`,
    [days, [...usernames.SERVICE_IDENTITIES], !!includeAdmins]
  );
  const languages = rows.map((row) => ({ language: row.language, people: Number(row.people) }));
  return { days, people: languages.reduce((sum, row) => sum + row.people, 0), languages };
}

// Page load times (#4965): one duration per full page load, credited to the
// first real screen the shell showed. shell_boot rows are the loads that
// ended before any screen did. The same cohort rules as the failure report:
// no service identities, nobody who objected, admins left out unless asked
// for.
async function pageLoads(pool, { days = 14, includeAdmins = false } = {}) {
  const adminClause = includeAdmins ? '' : 'AND NOT u.is_admin';
  const loadScreens = [...NAV_SCREENS, 'shell_boot'];
  const loadBase = `e.created_at >= NOW() - ($1::int * INTERVAL '1 day') ${adminClause}
    AND NOT (LOWER(u.username) = ANY($2::text[]))
    AND e.metadata->>'screen' = ANY($3::text[])
    AND e.metadata->>'kind' = 'page_load'`;
  const percentiles = `ROUND(percentile_cont(0.5)
      WITHIN GROUP (ORDER BY (e.metadata->>'durationMs')::int))::int AS p50_ms,
    ROUND(percentile_cont(0.95)
      WITHIN GROUP (ORDER BY (e.metadata->>'durationMs')::int))::int AS p95_ms`;
  const [byScreen, total] = await Promise.all([
    pool.query(
      `SELECT e.metadata->>'screen' AS screen,
         COUNT(*)::int AS loads,
         COUNT(DISTINCT e.user_id)::int AS people,
         ${percentiles}
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_experience' AND ${loadBase}
       GROUP BY e.metadata->>'screen' ORDER BY loads DESC, screen ASC`,
      [days, [...usernames.SERVICE_IDENTITIES], loadScreens]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS loads,
         COUNT(DISTINCT e.user_id)::int AS people,
         ${percentiles}
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_experience' AND ${loadBase}`,
      [days, [...usernames.SERVICE_IDENTITIES], loadScreens]
    ),
  ]);
  const row = (r) => ({
    screen: r.screen,
    loads: Number(r.loads),
    people: Number(r.people),
    p50Ms: r.p50_ms == null ? null : Number(r.p50_ms),
    p95Ms: r.p95_ms == null ? null : Number(r.p95_ms),
  });
  return {
    days,
    total: { ...row(total.rows[0] || { loads: 0, people: 0, p50_ms: null, p95_ms: null }), screen: null },
    screens: byScreen.rows.map(row),
  };
}

async function aggregate(pool, { days = 14, includeAdmins = false } = {}) {
  const adminClause = includeAdmins ? '' : 'AND NOT u.is_admin';
  const params = [days, [...usernames.SERVICE_IDENTITIES]];
  const base = `e.created_at >= NOW() - ($1::int * INTERVAL '1 day') ${adminClause}
    AND NOT (LOWER(u.username) = ANY($2::text[]))`;
  // Observations are read for the seven journeys only. Navigation rows share
  // the event type (#3369) and would otherwise inflate visits, reporting
  // users and the screen list. Delivery receipts cannot be split by screen,
  // so they count every record a client sent.
  const uiParams = [...params, [...JOURNEY_SCREENS]];
  // Page-load rows (#4965) share the event type too, but they are credited
  // only to the navigation screens and shell_boot, never to a journey
  // screen, so the screen list here leaves them out of the failure report.
  const uiBase = `${base} AND e.metadata->>'screen' = ANY($3::text[])`;
  const [overall, journeys, screens, contexts, errors, delivery] = await Promise.all([
    pool.query(
      `WITH ui AS (
         SELECT e.id AS row_id, e.user_id, e.metadata
           FROM events e JOIN users u ON u.id = e.user_id
          WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), attempts AS (
         SELECT user_id, metadata->>'attemptId' AS id
           FROM ui WHERE metadata->>'kind' IN ('action_attempt','server_failure')
             AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), terminals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR(metadata->>'outcome' = 'failure') AS failed,
           BOOL_OR(metadata->>'outcome' = 'cancelled') AS cancelled
           FROM ui WHERE metadata->>'kind' = 'action_outcome' AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), signals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'kind' = 'server_failure') AS server_failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned,
           BOOL_OR(metadata->>'kind' = 'repeated_action') AS repeated,
           BOOL_OR(metadata->>'kind' = 'recovery') AS recovered
           FROM ui WHERE metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), cohort AS (
         SELECT a.user_id, a.id, t.id IS NOT NULL AS has_client_terminal,
           COALESCE(t.succeeded, FALSE) AND NOT COALESCE(t.failed, FALSE)
             AND NOT COALESCE(s.server_failed, FALSE) AS succeeded,
           COALESCE(t.failed, FALSE) OR COALESCE(s.server_failed, FALSE) AS failed,
           COALESCE(t.cancelled, FALSE) AS cancelled,
           COALESCE(s.server_failed, FALSE) AS server_failed,
           COALESCE(s.timed_out, FALSE) AS timed_out,
           COALESCE(s.abandoned, FALSE) AS abandoned,
           COALESCE(s.repeated, FALSE) AS repeated,
           COALESCE(s.recovered, FALSE) AS recovered
           FROM attempts a
           LEFT JOIN terminals t ON t.user_id = a.user_id AND t.id = a.id
           LEFT JOIN signals s ON s.user_id = a.user_id AND s.id = a.id
       )
       SELECT
         (SELECT COUNT(*) FROM ui
           WHERE metadata->>'kind' = 'screen_visit')::int AS visits,
         (SELECT COUNT(DISTINCT user_id) FROM ui)::int AS reporting_users,
         COUNT(*)::int AS attempts,
         COUNT(*) FILTER (WHERE has_client_terminal OR server_failed)::int AS terminal_attempts,
         COUNT(*) FILTER (WHERE NOT has_client_terminal AND NOT server_failed)::int AS unresolved_attempts,
         (SELECT COUNT(*) FROM terminals t WHERE NOT EXISTS (
           SELECT 1 FROM attempts a WHERE a.user_id = t.user_id AND a.id = t.id))::int AS orphan_terminal_attempts,
         COUNT(*) FILTER (WHERE failed)::int AS failures,
         COUNT(*) FILTER (WHERE cancelled AND NOT failed AND NOT succeeded)::int AS cancellations,
         COUNT(*) FILTER (WHERE timed_out)::int AS timeouts,
         COUNT(*) FILTER (WHERE abandoned)::int AS abandonments,
         COUNT(*) FILTER (WHERE repeated)::int AS repeats,
         COUNT(*) FILTER (WHERE recovered)::int AS recoveries,
         (SELECT COUNT(*) FROM ui WHERE metadata->>'kind' = 'server_failure')::int AS server_failures,
         (SELECT COUNT(DISTINCT user_id) FROM ui WHERE
           (metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'failure')
           OR metadata->>'kind' IN ('boot_failure','loading_timeout','navigation_abandonment','server_failure'))::int AS affected_users
       FROM cohort`, uiParams),
    pool.query(
      `WITH ui AS (
         SELECT e.user_id, e.metadata FROM events e JOIN users u ON u.id = e.user_id
          WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), attempts AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           COALESCE(MIN(metadata->>'action') FILTER (WHERE metadata->>'kind' = 'action_attempt'),
             MIN(metadata->>'action')) AS action
           FROM ui WHERE metadata->>'kind' IN ('action_attempt','server_failure')
             AND metadata ? 'attemptId' AND metadata ? 'action'
           GROUP BY user_id, metadata->>'attemptId'
       ), outcomes AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR(metadata->>'outcome' = 'failure') AS client_failed,
           BOOL_OR(metadata->>'outcome' = 'cancelled') AS cancelled,
           MAX((metadata->>'durationMs')::int) FILTER
             (WHERE metadata->>'outcome' IN ('success','failure') AND metadata ? 'durationMs') AS duration_ms
           FROM ui WHERE metadata->>'kind' = 'action_outcome' AND metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), signals AS (
         SELECT user_id, metadata->>'attemptId' AS id,
           BOOL_OR(metadata->>'kind' = 'server_failure') AS server_failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned,
           BOOL_OR(metadata->>'kind' = 'repeated_action') AS repeated,
           BOOL_OR(metadata->>'kind' = 'recovery') AS recovered
           FROM ui WHERE metadata ? 'attemptId'
           GROUP BY user_id, metadata->>'attemptId'
       ), cohort AS (
         SELECT a.user_id, a.action, o.id IS NOT NULL AS has_client_terminal,
           COALESCE(o.succeeded, FALSE) AND NOT COALESCE(s.server_failed, FALSE) AS succeeded,
           COALESCE(o.client_failed, FALSE) OR COALESCE(s.server_failed, FALSE) AS failed,
           COALESCE(o.cancelled, FALSE) AS cancelled, o.duration_ms,
           COALESCE(s.server_failed, FALSE) AS server_failed,
           COALESCE(s.timed_out, FALSE) AS timed_out,
           COALESCE(s.abandoned, FALSE) AS abandoned,
           COALESCE(s.repeated, FALSE) AS repeated,
           COALESCE(s.recovered, FALSE) AS recovered
           FROM attempts a
           LEFT JOIN outcomes o ON o.user_id = a.user_id AND o.id = a.id
           LEFT JOIN signals s ON s.user_id = a.user_id AND s.id = a.id
       ), actions AS (
         SELECT action, COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE has_client_terminal OR server_failed)::int AS terminal_attempts,
           COUNT(*) FILTER (WHERE succeeded)::int AS successes,
           COUNT(*) FILTER (WHERE failed)::int AS failures,
           COUNT(*) FILTER (WHERE cancelled AND NOT failed AND NOT succeeded)::int AS cancellations,
           COUNT(*) FILTER (WHERE timed_out)::int AS timeouts,
           COUNT(*) FILTER (WHERE abandoned)::int AS abandonments,
           COUNT(*) FILTER (WHERE repeated)::int AS repeats,
           COUNT(*) FILTER (WHERE recovered)::int AS recoveries,
           COUNT(DISTINCT user_id) FILTER (WHERE failed OR timed_out OR abandoned)::int AS affected_users,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE (succeeded OR failed) AND duration_ms IS NOT NULL))::int AS p50_ms,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE (succeeded OR failed) AND duration_ms IS NOT NULL))::int AS p95_ms
           FROM cohort GROUP BY action
       )
       SELECT *, (successes + failures)::int AS failure_denominator,
         CASE WHEN successes + failures > 0
           THEN ROUND(100.0 * failures / (successes + failures), 1)::float ELSE NULL END AS failure_rate
       FROM actions ORDER BY failures DESC, timeouts DESC, attempts DESC, action ASC`, uiParams),
    pool.query(
      `SELECT e.metadata->>'screen' AS screen,
         COUNT(*)::int AS visits,
         COUNT(DISTINCT e.user_id)::int AS users
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_experience' AND ${uiBase}
         AND e.metadata->>'kind' = 'screen_visit'
       GROUP BY e.metadata->>'screen' ORDER BY visits DESC, screen ASC`, uiParams),
    pool.query(
      `WITH ui AS (
         SELECT e.id AS row_id, e.user_id, e.app_id, e.metadata
           FROM events e JOIN users u ON u.id = e.user_id
           WHERE e.event_type = 'ui_experience' AND ${uiBase}
       ), per_attempt AS (
         SELECT user_id,
           COALESCE(metadata->>'attemptId', 'event-' || row_id::text) AS identity,
           MAX(app_id) AS app_id, MAX(metadata->>'build') AS build,
           BOOL_OR(metadata->>'kind' = 'action_attempt') AS attempted,
           BOOL_OR(metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'success') AS succeeded,
           BOOL_OR((metadata->>'kind' = 'action_outcome' AND metadata->>'outcome' = 'failure')
             OR metadata->>'kind' = 'server_failure') AS failed,
           BOOL_OR(metadata->>'kind' = 'loading_timeout') AS timed_out,
           BOOL_OR(metadata->>'kind' = 'navigation_abandonment') AS abandoned
           FROM ui GROUP BY user_id, COALESCE(metadata->>'attemptId', 'event-' || row_id::text)
       )
       SELECT a.slug AS app_slug, p.build,
         COUNT(*) FILTER (WHERE p.attempted)::int AS attempts,
         COUNT(*) FILTER (WHERE p.succeeded AND NOT p.failed)::int AS successes,
         COUNT(*) FILTER (WHERE p.failed)::int AS failures,
         COUNT(*) FILTER (WHERE p.timed_out)::int AS timeouts,
         COUNT(*) FILTER (WHERE p.abandoned)::int AS abandonments,
         COUNT(DISTINCT p.user_id) FILTER (WHERE p.failed OR p.timed_out OR p.abandoned)::int AS affected_users
       FROM per_attempt p LEFT JOIN apps a ON a.id = p.app_id
       GROUP BY a.slug, p.build
       HAVING COUNT(*) FILTER (WHERE p.failed OR p.timed_out OR p.abandoned) > 0
       ORDER BY failures DESC, timeouts DESC, abandonments DESC, affected_users DESC
       LIMIT 20`, uiParams),
    pool.query(
      `WITH coded AS (
         SELECT e.id, e.user_id, e.metadata, e.created_at,
           CASE WHEN e.metadata->>'kind' IN ('action_outcome','server_failure')
                  AND e.metadata ? 'attemptId'
             THEN 'attempt-' || e.user_id::text || '-' || (e.metadata->>'attemptId')
             ELSE 'event-' || e.id::text END AS identity,
           ROW_NUMBER() OVER (
             PARTITION BY CASE WHEN e.metadata->>'kind' IN ('action_outcome','server_failure')
                    AND e.metadata ? 'attemptId'
               THEN 'attempt-' || e.user_id::text || '-' || (e.metadata->>'attemptId')
               ELSE 'event-' || e.id::text END
             ORDER BY (e.metadata->>'kind' = 'server_failure') DESC, e.created_at DESC
           ) AS rank
         FROM events e JOIN users u ON u.id = e.user_id
         WHERE e.event_type = 'ui_experience' AND ${uiBase} AND e.metadata ? 'errorCode'
       )
       SELECT metadata->>'errorCode' AS error_code,
         COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS affected_users
       FROM coded WHERE rank = 1
       GROUP BY metadata->>'errorCode' ORDER BY count DESC, error_code ASC LIMIT 12`, uiParams),
    pool.query(
      `SELECT COUNT(*)::int AS receipts, COUNT(DISTINCT e.user_id)::int AS reporting_users,
         COALESCE(SUM((e.metadata->>'submitted')::int), 0)::int AS submitted,
         COALESCE(SUM((e.metadata->>'accepted')::int), 0)::int AS accepted,
         COALESCE(SUM((e.metadata->>'failedBatches')::int), 0)::int AS failed_batches,
         COALESCE(SUM((e.metadata->>'droppedEvents')::int), 0)::int AS dropped_events,
         MIN(e.created_at) AS first_receipt_at, MAX(e.created_at) AS latest_receipt_at
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.event_type = 'ui_telemetry_delivery' AND ${base}`, params),
  ]);
  const d = delivery.rows[0] || {};
  const receipts = Number(d.receipts || 0);
  const dropped = Number(d.dropped_events || 0);
  const failed = Number(d.failed_batches || 0);
  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    coverage: {
      state: receipts === 0 ? 'none' : (dropped > 0 || failed > 0 ? 'loss_observed' : 'reporting'),
      receipts,
      reportingUsers: Number(d.reporting_users || 0),
      submittedRecords: Number(d.submitted || 0),
      acceptedRecords: Number(d.accepted || 0),
      failedBatchesRecovered: failed,
      droppedRecordsReported: dropped,
      firstReceiptAt: d.first_receipt_at || null,
      latestReceiptAt: d.latest_receipt_at || null,
      limitation: 'Client delivery can be absent. No receipts means no observed coverage, not zero failures.',
    },
    overview: overall.rows[0] || {},
    journeys: journeys.rows,
    screens: screens.rows,
    contexts: contexts.rows,
    errors: errors.rows,
  };
}

module.exports = {
  ACTIONS,
  CLIENT_ERROR_CODE_RE,
  CLIENT_ERROR_FRAME_RE,
  CLIENT_ERROR_NAMES,
  MAX_TEMPLATE_CHARS,
  JOURNEY_SCREENS,
  NAV_SCREENS,
  VIAS,
  ERROR_CODES,
  KINDS,
  MAX_BATCH_EVENTS,
  MAX_BODY_BYTES,
  OUTCOMES,
  SCREENS,
  TelemetryValidationError,
  aggregate,
  browserLanguage,
  browserLanguages,
  daysWindow,
  insertBatch,
  isEligibleUser,
  isRecordable,
  clientErrorCode,
  normalizeErrorTemplate,
  parseBatch,
  pageLoads,
  recordServerFailure,
  safeServerError,
  storedErrorTemplate,
};
