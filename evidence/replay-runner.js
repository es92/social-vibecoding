#!/usr/bin/env node
'use strict';

// #2380 deterministic visual-evidence replay runtime.
//
// This process receives a validated plan plus run-scoped base/head origins on
// stdin. It never receives a model prompt and it never executes JavaScript
// supplied by a plan. One invocation is one clean replay pass; the platform
// provisions/restores the paired databases between pass 1 and pass 2 and
// publishes media only from pass 2.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let planContract;
try { planContract = require('../src/services/visual-evidence-plan'); }
catch (_) { planContract = require('./visual-evidence-plan'); }
const sessionBootstrap = require('../worker/session-bootstrap');
const hostedApps = require('../worker/evidence-hosted-origins');

const ARTIFACT_PREFIX = '__USERNODE_EVIDENCE_ARTIFACT__ ';
const EVENT_PREFIX = '__USERNODE_EVIDENCE__ ';
const MAX_CONSOLE_ITEMS = 50;
const MAX_DIAGNOSTIC_CHARS = 500;
const FOCUS_PADDING = 24;
const STEPS_FPS = 8;
const MOTION_FPS = 10;
const MAX_ANIMATION_SECONDS = 8;
const STEPS_TARGET_BYTES = 1_500_000;
const STEPS_MAX_BYTES = 4_000_000;
const MOTION_TARGET_BYTES = 2_000_000;
const MOTION_MAX_BYTES = 6_000_000;
const INITIAL_NAVIGATION_RETRY_DELAY_MS = 500;
const RETRYABLE_INITIAL_NAVIGATION = /\bnet::ERR_(NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)\b/i;
const CHECKPOINT_SETTLE_MS = 12_000;
const CHECKPOINT_MAX_SAMPLES = 6;
const CHECKPOINT_SCREENSHOT_MS = 6_000;

const CHROMIUM_ARGS = Object.freeze([
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--enable-webgl',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]);

class ReplayFailure extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ReplayFailure';
    this.code = code;
    this.detail = detail;
  }
}

function clip(value, max = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeDiagnosticText(value, max = MAX_DIAGNOSTIC_CHARS) {
  const redacted = String(value == null ? '' : value)
    .replace(/(\b(?:token|access_token|auth|authorization|password|secret|api[_-]?key|code|session)\s*=\s*)[^&\s"'<>)]*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]');
  return clip(redacted, max);
}

function boundedFailureDetail(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return safeDiagnosticText(value, 200);
  if (depth >= 6) return '[nested detail omitted]';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedFailureDetail(item, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).slice(0, 24)
    .filter(([key]) => !/^(?:token|authorization|cookie|password|secret|payload|data)$/i.test(key))
    .map(([key, item]) => [key, boundedFailureDetail(item, depth + 1)]));
}

function contextualFailure(error, context = {}) {
  const code = /^[A-Za-z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : 'replay_failed';
  const previous = boundedFailureDetail(error?.detail);
  return new ReplayFailure(code, safeDiagnosticText(error?.message || error), {
    ...context,
    ...(previous && typeof previous === 'object' && !Array.isArray(previous)
      ? previous : previous == null ? {} : { cause: previous }),
  });
}

function emitEvent(event) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

function emitArtifact(metadata, data) {
  process.stdout.write(`${ARTIFACT_PREFIX}${JSON.stringify({
    ...metadata,
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    data: data.toString('base64'),
  })}\n`);
}

function parseOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new ReplayFailure('invalid_origin', `${label} origin is invalid.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ReplayFailure('invalid_origin', `${label} origin must be a bare HTTP(S) origin.`);
  }
  return url.origin;
}

function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReplayFailure('invalid_input', 'Replay input must be an object.');
  if (!/^[0-9a-f]{32}$/.test(String(raw.runId || ''))) {
    throw new ReplayFailure('invalid_run_id', 'Replay input requires the exact evidence run id.');
  }
  const plan = planContract.parseReplayPlan(raw.plan);
  const pass = Number(raw.pass);
  if (![1, 2].includes(pass)) throw new ReplayFailure('invalid_pass', 'Replay pass must be 1 or 2.');
  let selection = null;
  if (raw.selection != null) {
    if (!raw.selection || typeof raw.selection !== 'object'
        || Object.keys(raw.selection).sort().join(',') !== 'storyId,viewport') {
      throw new ReplayFailure('invalid_selection', 'Replay selection must name one declared story and viewport.');
    }
    const story = plan.stories.find((item) => item.id === raw.selection.storyId);
    if (!story?.viewports.some((item) => item.name === raw.selection.viewport)) {
      throw new ReplayFailure('invalid_selection', 'Replay selection must name one declared story and viewport.');
    }
    selection = { storyId: raw.selection.storyId, viewport: raw.selection.viewport };
  }
  const baseOrigin = parseOrigin(raw.origins?.base, 'Base');
  const headOrigin = parseOrigin(raw.origins?.head, 'Head');
  if (baseOrigin === headOrigin) throw new ReplayFailure('identical_origins', 'Base and head origins must be distinct.');
  const provenance = raw.provenance || {};
  for (const key of ['baseSha', 'headSha']) {
    if (!/^[0-9a-f]{40}$/.test(String(provenance[key] || ''))) {
      throw new ReplayFailure('invalid_provenance', `${key} must be an exact lowercase commit SHA.`);
    }
  }
  if (!provenance.fixtureFingerprint || typeof provenance.fixtureFingerprint !== 'string') {
    throw new ReplayFailure('invalid_provenance', 'A paired fixture fingerprint is required.');
  }
  const authTokens = Object.fromEntries(['member', 'read_only_admin', 'full_admin'].map((persona) => {
    const token = raw.authTokens?.[persona];
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192
        || !/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new ReplayFailure('invalid_auth_tokens', `Replay input requires a bounded ${persona} fixture token.`);
    }
    return [persona, token];
  }));
  return {
    runId: raw.runId,
    pass,
    publishArtifacts: raw.publishArtifacts === true && pass === 2,
    diagnosticArtifacts: raw.diagnosticArtifacts === true && pass === 1,
    plan,
    planHash: planContract.planHash(plan),
    selection,
    origins: { base: baseOrigin, head: headOrigin },
    cookies: raw.cookies && typeof raw.cookies === 'object' ? raw.cookies : {},
    authTokens,
    provenance: {
      baseSha: provenance.baseSha,
      headSha: provenance.headSha,
      fixtureFingerprint: clip(provenance.fixtureFingerprint, 128),
      baseImageDigest: clip(provenance.baseImageDigest || '', 300) || null,
      headImageDigest: clip(provenance.headImageDigest || '', 300) || null,
      hostedAssetRevision: clip(provenance.hostedAssetRevision || '', 128) || null,
    },
    browser: {
      locale: clip(raw.browser?.locale || 'en-US', 35),
      timezoneId: clip(raw.browser?.timezoneId || 'UTC', 64),
      colorScheme: raw.browser?.colorScheme === 'dark' ? 'dark' : 'light',
      deviceScaleFactor: raw.browser?.deviceScaleFactor === 1 ? 1 : 2,
    },
  };
}

function locatorFor(page, spec, { includeHidden = false } = {}) {
  switch (spec.by) {
    case 'testId': return page.getByTestId(spec.value);
    case 'role': return page.getByRole(spec.role, {
      ...(spec.name == null ? {} : { name: spec.name, exact: spec.exact !== false }),
      ...(includeHidden ? { includeHidden: true } : {}),
    });
    case 'label': return page.getByLabel(spec.value, { exact: spec.exact !== false });
    case 'placeholder': return page.getByPlaceholder(spec.value, { exact: spec.exact !== false });
    case 'text': return page.getByText(spec.value, { exact: spec.exact !== false });
    case 'css': return page.locator(spec.value);
    default: throw new ReplayFailure('unsupported_locator', `Unsupported locator kind ${String(spec.by)}.`);
  }
}

async function requireOne(locator, description) {
  const count = await locator.count();
  if (count !== 1) {
    throw new ReplayFailure(
      'ambiguous_locator',
      `${description} matched ${count} elements; exactly one is required.`,
      { matchedCount: count }
    );
  }
  return locator;
}

async function roleCandidateHints(page, spec) {
  if (spec.by !== 'role' || !spec.name) return null;
  try {
    // A missing exact accessible name is often a stale recipe. Read only
    // short, redacted names of controls with the requested role; never dump
    // the DOM, input values, or the whole accessibility tree.
    const candidates = page.getByRole(spec.role, { includeHidden: true });
    const count = await candidates.count();
    const sample = await Promise.all(Array.from({ length: Math.min(count, 12) }, async (_, index) => {
      const candidate = candidates.nth(index);
      if (typeof candidate.ariaSnapshot !== 'function') return null;
      const [snapshot, visible] = await Promise.all([
        candidate.ariaSnapshot({ timeout: 1000 }).catch(() => ''),
        candidate.isVisible().catch(() => false),
      ]);
      const name = safeDiagnosticText(String(snapshot).split('\n')[0], 120);
      return name ? { name, visible } : null;
    }));
    return { candidateCount: count, candidates: sample.filter(Boolean).slice(0, 12) };
  } catch { return null; }
}

async function locatorSnapshot(page, spec, { includeCandidates = false } = {}) {
  const locator = locatorFor(page, spec);
  const attachedLocator = spec.by === 'role'
    ? locatorFor(page, spec, { includeHidden: true })
    : locator;
  const matchedCount = await locator.count().catch(() => null);
  const attachedCount = attachedLocator === locator
    ? matchedCount
    : await attachedLocator.count().catch(() => null);
  let visibleCount = null;
  if (Number.isInteger(attachedCount) && attachedCount <= 20) {
    visibleCount = 0;
    for (let index = 0; index < attachedCount; index++) {
      if (await attachedLocator.nth(index).isVisible().catch(() => false)) visibleCount += 1;
    }
  }
  return {
    kind: spec.by,
    ...(spec.by === 'role' ? { role: spec.role } : {}),
    matchedCount,
    attachedCount,
    visibleCount,
    ...(includeCandidates ? { roleHints: await roleCandidateHints(page, spec) } : {}),
  };
}

async function resolveOne(page, spec, description, {
  state = 'attached', timeoutMs = planContract.MAX_WAIT_MS,
} = {}) {
  const locator = locatorFor(page, spec);
  try {
    // Playwright locators are intentionally lazy and auto-wait. Counting
    // before this wait defeats that contract: a React/auth boot that has not
    // exposed the element yet is reported as zero matches immediately.
    await locator.first().waitFor({ state, timeout: timeoutMs });
  } catch (error) {
    const snapshot = await locatorSnapshot(page, spec, { includeCandidates: true });
    const count = snapshot.attachedCount;
    if (!Number.isInteger(count) && !Number.isInteger(snapshot.matchedCount)) throw error;
    if (Number.isInteger(count) && count > 1) {
      throw new ReplayFailure(
        'ambiguous_locator',
        `${description} matched ${count} elements; exactly one is required.`,
        { ...snapshot, waitState: state, timeoutMs }
      );
    }
    if (count === 1) {
      throw new ReplayFailure(
        'locator_not_visible',
        `${description} matched one element but it did not become ${state} within ${timeoutMs} ms.`,
        { ...snapshot, waitState: state, timeoutMs }
      );
    }
    throw new ReplayFailure(
      'locator_not_found',
      `${description} did not match an element within ${timeoutMs} ms.`,
      { ...snapshot, waitState: state, timeoutMs }
    );
  }
  const snapshot = await locatorSnapshot(page, spec);
  if (snapshot.matchedCount !== 1) {
    throw new ReplayFailure(
      'ambiguous_locator',
      `${description} matched ${snapshot.matchedCount} elements; exactly one is required.`,
      { ...snapshot, waitState: state, timeoutMs }
    );
  }
  return locator;
}

// A readiness wait only asks whether any matching element is visible. Keep
// interactions and checkpoint assertions strict, but do not reject a page
// because it has two headings or controls with the same accessible name.
async function waitForAnyVisible(page, spec, description, timeoutMs) {
  const locator = locatorFor(page, spec).filter({ visible: true });
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    // The element may have appeared between Playwright's timeout and this
    // diagnostic read. A visible match satisfies the wait even in that race.
    if (await locator.count().catch(() => 0)) return;
    const snapshot = await locatorSnapshot(page, spec, { includeCandidates: true });
    if (!Number.isInteger(snapshot.attachedCount)
        && !Number.isInteger(snapshot.matchedCount)) throw error;
    const present = Number(snapshot.attachedCount) > 0;
    throw new ReplayFailure(
      present ? 'locator_not_visible' : 'locator_not_found',
      present
        ? `${description} did not become visible within ${timeoutMs} ms.`
        : `${description} did not match an element within ${timeoutMs} ms.`,
      { ...snapshot, waitState: 'visible', timeoutMs }
    );
  }
}

// A hidden wait succeeds only once no matching element is visible. Filter
// before selecting the first match so a hidden duplicate cannot conceal a
// still-visible one. An absent match is also hidden, matching assertions.
async function waitForNotVisible(page, spec, description, timeoutMs) {
  const visible = locatorFor(page, spec, { includeHidden: true }).filter({ visible: true });
  try {
    await visible.first().waitFor({ state: 'hidden', timeout: timeoutMs });
  } catch (error) {
    if (await visible.count().catch(() => null) === 0) return;
    const snapshot = await locatorSnapshot(page, spec, { includeCandidates: true });
    if (!Number.isInteger(snapshot.attachedCount)
        && !Number.isInteger(snapshot.matchedCount)) throw error;
    throw new ReplayFailure(
      'locator_still_visible',
      `${description} remained visible after ${timeoutMs} ms.`,
      { ...snapshot, waitState: 'hidden', timeoutMs }
    );
  }
}

async function waitForVisibleText(page, text, description, timeoutMs) {
  return waitForAnyVisible(page, { by: 'text', value: text, exact: false }, description, timeoutMs);
}

function joinedUrl(origin, relativePath) {
  const url = new URL(relativePath, `${origin}/`);
  if (url.origin !== origin) throw new ReplayFailure('cross_origin_navigation', 'The replay plan attempted to leave its evidence origin.');
  return url.toString();
}

function authorizedUrl(origin, relativePath, token) {
  const url = new URL(joinedUrl(origin, relativePath));
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function replayNavigationToken(authToken, bootstrap) {
  // The bootstrap request has already exchanged this token for a session
  // cookie. Match the planner's ordinary browser navigation once that cookie
  // exists; ?token= also changes first-run UI such as the Home tour.
  return bootstrap.sessionCookieInstalled || bootstrap.cookieAlreadyPresent ? '' : authToken;
}

// A freshly reset internal service can change its network endpoint between
// session bootstrap and Chromium's first document request. Retry only that
// pre-document transport failure, never an app response, action, or assertion.
// The same plan still has to pass both independent clean replays.
async function navigateStart(page, url, onRetry = () => {}, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: planContract.MAX_WAIT_MS });
    } catch (error) {
      const code = RETRYABLE_INITIAL_NAVIGATION.exec(String(error?.message || ''))?.[1]?.toLowerCase();
      if (!code || attempt === 2) throw error;
      onRetry({ attempt: attempt + 1, code });
      await wait(INITIAL_NAVIGATION_RETRY_DELAY_MS);
    }
  }
}

function recoveredInitialDocumentFailure(request, page, startUrl, retryCodes) {
  if (!retryCodes?.size || !request?.isNavigationRequest?.()
      || request.resourceType?.() !== 'document') return false;
  try {
    if (request.frame() !== page.mainFrame()) return false;
    const requested = new URL(request.url());
    const start = new URL(startUrl);
    // URL fragments are local to the browser and never identify an HTTP
    // request. Match the exact origin, path and query (including the fixture
    // token) so an unrelated API or document failure cannot be suppressed.
    if (requested.origin !== start.origin || requested.pathname !== start.pathname
        || requested.search !== start.search) return false;
    const code = RETRYABLE_INITIAL_NAVIGATION.exec(String(request.failure()?.errorText || ''))?.[1]?.toLowerCase();
    return !!code && retryCodes.has(code);
  } catch { return false; }
}

function discardRecoveredInitialNavigationFailures(
  diagnostics, failures, page, startUrl, retryCodes, navigationStatus
) {
  if (navigationStatus < 200 || navigationStatus >= 400 || !retryCodes?.size) return 0;
  const recovered = new Set(failures
    .filter(({ request }) => recoveredInitialDocumentFailure(request, page, startUrl, retryCodes))
    .map(({ failure }) => failure));
  diagnostics.failedRequests = diagnostics.failedRequests.filter((failure) => !recovered.has(failure));
  return recovered.size;
}

function requestIdentity(url, method) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${String(method || 'GET').toUpperCase()} ${parsed.toString()}`;
  } catch { return null; }
}

// Chromium keeps requestfailed and console records after an app successfully
// retries the same request. Suppress only an ERR_NETWORK_CHANGED entry with a
// later 2xx/3xx response for the exact method and URL. Any unrecovered
// request, other network error, unrelated console error, or page exception
// still fails the replay. The two clean passes and UI assertions are unchanged.
function discardRecoveredNetworkChanges(diagnostics, failures, successes, consoleEvents) {
  const recovered = new Set();
  const unrecoveredKeys = new Set();
  const recordedFailures = new Set(diagnostics.failedRequests);
  for (const failure of failures) {
    if (!recordedFailures.has(failure.entry)) continue;
    const key = requestIdentity(failure.url, failure.method);
    const laterSuccess = key && successes.get(key) > failure.order;
    if (key && /\bnet::ERR_NETWORK_CHANGED\b/i.test(failure.error) && laterSuccess) {
      recovered.add(failure.entry);
    } else if (key) {
      unrecoveredKeys.add(key);
    }
  }
  diagnostics.failedRequests = diagnostics.failedRequests.filter((entry) => !recovered.has(entry));
  const recoveredKeys = new Set(failures.filter((failure) => recovered.has(failure.entry))
    .map((failure) => requestIdentity(failure.url, failure.method)));
  const recoveredConsole = new Set(consoleEvents.filter((event) => {
    const key = requestIdentity(event.url, event.method);
    return key && recoveredKeys.has(key) && !unrecoveredKeys.has(key)
      && /\bnet::ERR_NETWORK_CHANGED\b/i.test(event.message);
  }).map((event) => event.entry));
  diagnostics.consoleErrors = diagnostics.consoleErrors.filter((entry) => !recoveredConsole.has(entry));
  return { requests: recovered.size, consoleErrors: recoveredConsole.size };
}

function pageRouteIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.hash}`;
  } catch { return null; }
}

// A GET/HEAD fetch or XHR cancelled while the page navigates away belongs to
// the old screen. React cleanup can abort its fetch before the browser updates
// the route, so compare both the route at failure and the asserted checkpoint.
// Keep aborts on the checkpoint route, documents, assets, mutations, and every
// other network failure visible. UI assertions have already completed.
function discardCancelledReads(diagnostics, failures, consoleEvents, checkpointRoute = null) {
  const cancelled = new Set(failures.filter((failure) =>
    diagnostics.failedRequests.includes(failure.entry)
      && /\bnet::ERR_ABORTED\b/i.test(failure.error)
      && ['GET', 'HEAD'].includes(String(failure.method || '').toUpperCase())
      && ['fetch', 'xhr'].includes(failure.resourceType)
      && failure.startRoute && failure.endRoute
      && (failure.startRoute !== failure.endRoute
        || (checkpointRoute && failure.startRoute !== checkpointRoute))
  ).map((failure) => failure.entry));
  diagnostics.failedRequests = diagnostics.failedRequests.filter((entry) => !cancelled.has(entry));
  const cancelledKeys = new Set(failures.filter((failure) => cancelled.has(failure.entry))
    .map((failure) => requestIdentity(failure.url, failure.method)));
  const remainingKeys = new Set(failures.filter((failure) => diagnostics.failedRequests.includes(failure.entry))
    .map((failure) => requestIdentity(failure.url, failure.method)));
  const matchingConsole = new Set(consoleEvents.filter((event) => {
    const key = requestIdentity(event.url, event.method);
    return key && cancelledKeys.has(key) && !remainingKeys.has(key)
      && /\bnet::ERR_ABORTED\b/i.test(event.message);
  }).map((event) => event.entry));
  diagnostics.consoleErrors = diagnostics.consoleErrors.filter((entry) => !matchingConsole.has(entry));
  return { requests: cancelled.size, consoleErrors: matchingConsole.size };
}

function publicRelativePath(value) {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}${url.hash}`;
}

function redactedUrl(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) url.searchParams.set('token', '[redacted]');
    return url.toString();
  } catch { return clip(value, 300); }
}

function diagnosticLocation(value, origin) {
  try {
    const url = new URL(value);
    if (url.origin !== origin) return { sameOrigin: false };
    return {
      sameOrigin: true,
      pathname: safeDiagnosticText(url.pathname, 160),
      hash: safeDiagnosticText(url.hash, 160),
      queryKeys: [...new Set([...url.searchParams.keys()])]
        .filter((key) => key.toLowerCase() !== 'token')
        .slice(0, 20)
        .map((key) => safeDiagnosticText(key, 80)),
    };
  } catch { return { sameOrigin: false }; }
}

function diagnosticOriginKind(value, origin, hostedOrigins) {
  try {
    const source = new URL(value).origin;
    if (source === origin) return 'platform';
    if (hostedOrigins.has(source)) return 'hosted_app';
    return 'other_origin';
  } catch { return 'unknown'; }
}

function pageErrorOriginKind(error, origin, hostedOrigins) {
  // Playwright pageerror has no frame property. Chromium's first stack frame
  // normally names the throwing script. Retain only this fixed origin class,
  // never the URL, query, code, or stack itself.
  for (const line of String(error?.stack || '').split('\n').slice(1, 8)) {
    const source = line.match(/https?:\/\/[^\s)]+/)?.[0];
    if (source) return diagnosticOriginKind(source, origin, hostedOrigins);
  }
  return 'unknown';
}

async function failurePageState(page, context, origin, navigation = null) {
  const url = typeof page.url === 'function' ? page.url() : '';
  const location = diagnosticLocation(url, origin);
  const dom = await page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const landmarks = [...document.querySelectorAll(
      'main[id], [role="main"][id], [role="dialog"][id], [id$="-screen"]'
    )].filter(visible).map((element) => element.id)
      .filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 12);
    const controls = [...document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), [role="button"], [role="link"], [role="tab"]'
    )].filter(visible).slice(0, 80);
    return {
      readyState: document.readyState,
      bodyChildCount: document.body?.children.length ?? 0,
      visibleLandmarkIds: landmarks,
      visibleMainCount: [...document.querySelectorAll('main, [role="main"]')].filter(visible).length,
      visibleDialogCount: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
      visibleButtonCount: [...document.querySelectorAll('button')].filter(visible).length,
      visibleLinkCount: [...document.querySelectorAll('a[href]')].filter(visible).length,
      visibleIds: [...document.querySelectorAll('[id]')].filter(visible)
        .map((element) => element.id)
        .filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 30),
      visibleControlIds: controls.map((element) => element.id)
        .filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 20),
      visibleTestIds: [...document.querySelectorAll('[data-testid]')].filter(visible)
        .map((element) => element.getAttribute('data-testid'))
        .filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id || '')).slice(0, 20),
    };
  }).catch(() => null);
  const cookies = typeof context.cookies === 'function'
    ? await context.cookies(origin).catch(() => [])
    : [];
  return {
    ...location,
    navigationStatus: Number.isInteger(navigation?.status) ? navigation.status : null,
    readyState: dom?.readyState || null,
    bodyChildCount: Number.isInteger(dom?.bodyChildCount) ? dom.bodyChildCount : null,
    visibleLandmarkIds: Array.isArray(dom?.visibleLandmarkIds) ? dom.visibleLandmarkIds : [],
    visibleMainCount: Number.isInteger(dom?.visibleMainCount) ? dom.visibleMainCount : null,
    visibleDialogCount: Number.isInteger(dom?.visibleDialogCount) ? dom.visibleDialogCount : null,
    visibleButtonCount: Number.isInteger(dom?.visibleButtonCount) ? dom.visibleButtonCount : null,
    visibleLinkCount: Number.isInteger(dom?.visibleLinkCount) ? dom.visibleLinkCount : null,
    visibleIds: Array.isArray(dom?.visibleIds) ? dom.visibleIds.slice(0, 30) : [],
    visibleControlIds: Array.isArray(dom?.visibleControlIds) ? dom.visibleControlIds.slice(0, 20) : [],
    visibleTestIds: Array.isArray(dom?.visibleTestIds) ? dom.visibleTestIds.slice(0, 20) : [],
    cookieCount: cookies.length,
    sessionCookiePresent: cookies.some((cookie) => cookie?.name === 'session'),
  };
}

function failureBrowserDiagnostics(diagnostics) {
  return {
    expectedSandboxWarnings: diagnostics.expectedSandboxWarnings || 0,
    consoleErrorCount: diagnostics.consoleErrors.length,
    pageErrorCount: diagnostics.pageErrors.length,
    failedRequestCount: diagnostics.failedRequests.length,
    blockedRequestCount: diagnostics.blockedRequests.length,
    httpErrorCount: diagnostics.httpErrors.length,
    firstConsoleError: diagnostics.consoleErrors[0]?.message || null,
    firstPageError: diagnostics.pageErrors[0]?.message || null,
    firstFailedRequest: diagnostics.failedRequests[0] || null,
    firstBlockedRequest: diagnostics.blockedRequests[0] || null,
    firstHttpError: diagnostics.httpErrors[0] || null,
    consoleErrors: diagnostics.consoleErrors.slice(0, 5),
    pageErrors: diagnostics.pageErrors.slice(0, 5),
    failedRequests: diagnostics.failedRequests.slice(0, 5),
    blockedRequests: diagnostics.blockedRequests.slice(0, 5),
    httpErrors: diagnostics.httpErrors.slice(0, 10),
  };
}

function expectedPendingFrameWarning(message, source) {
  // The platform intentionally keeps its pending app iframe at about:blank
  // with sandbox="" until a vetted app URL is ready. Chromium reports this
  // exact blocked-script warning from the shell bundle; it is the security
  // boundary working, not an app exception. Keep counting it for diagnostics.
  return source?.sameOrigin === true && source.pathname === '/shell/assets/shell.js'
    && message === "Blocked script execution in 'about:blank' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.";
}

function expectedFinalPath(startPath, pageUrl, origin, side = 'page', { allowDeclaredHome = false } = {}) {
  const finalUrl = new URL(pageUrl);
  const finalPath = publicRelativePath(finalUrl);
  if (finalUrl.origin !== origin) {
    throw new ReplayFailure('cross_origin_navigation', `${side} ended outside its evidence origin.`);
  }
  if (startPath !== '/' && ((finalPath === '/' && !allowDeclaredHome)
      || /^\/(?:login|signin|error)(?:[/?#]|$)/i.test(finalPath))) {
    throw new ReplayFailure('unexpected_fallback', `${side} ended on ${finalPath} instead of its declared evidence state.`);
  }
  return finalPath;
}

async function settlePage(page, { motion = false } = {}) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }).catch(() => {});
  if (!motion) await page.waitForTimeout(150);
}

async function captureStableCheckpoint(page, network, { motion = false } = {}) {
  if (motion) {
    await settlePage(page, { motion: true });
    return { png: await page.screenshot({ type: 'png' }), stability: { mode: 'motion', sampleCount: 1 } };
  }
  // A locator can become visible before the rest of an asynchronous screen
  // has finished loading. Wait for its current reads, then require the actual
  // pixels to agree across three separated samples. This keeps static
  // evidence from freezing a partially painted route or modal backdrop.
  const networkStartedAt = Date.now();
  let networkQuiet = true;
  try { await network.quiet(3_000, 350); }
  catch (error) {
    // Polling may keep the network busy while the page is visually settled.
    // The pixel samples below are the actual checkpoint readiness test.
    if (error?.code !== 'network_not_quiet') throw error;
    networkQuiet = false;
  }
  const networkWaitMs = Date.now() - networkStartedAt;
  // Three samples are required for two agreeing pairs. The old three-second
  // wall deadline could expire after just two slow Chromium screenshots, so
  // a perfectly static page had no possible way to pass. Bound each capture
  // and the number of samples while allowing the required third sample.
  const startedAt = Date.now();
  const deadline = startedAt + CHECKPOINT_SETTLE_MS;
  let previous = null;
  let stablePairs = 0;
  const samples = [];
  while (samples.length < 3 || (Date.now() < deadline && samples.length < CHECKPOINT_MAX_SAMPLES)) {
    const settleStartedAt = Date.now();
    await settlePage(page);
    const settleMs = Date.now() - settleStartedAt;
    const screenshotStartedAt = Date.now();
    let png;
    try { png = await page.screenshot({ type: 'png', timeout: CHECKPOINT_SCREENSHOT_MS }); }
    catch {
      throw new ReplayFailure('checkpoint_capture_failed',
        'The browser could not capture the static checkpoint.',
        { sampleCount: samples.length, samples, networkQuiet, networkWaitMs,
          captureWaitMs: Date.now() - startedAt });
    }
    const screenshotMs = Date.now() - screenshotStartedAt;
    const hashStartedAt = Date.now();
    const hash = perceptualHash(png);
    const hashMs = Date.now() - hashStartedAt;
    const distance = previous == null ? null : hammingHex(previous, hash);
    samples.push({ settleMs, screenshotMs, hashMs, distance });
    stablePairs = distance != null && distance <= 2 ? stablePairs + 1 : 0;
    if (stablePairs >= 2) return { png, stability: {
      mode: 'static', sampleCount: samples.length, samples,
      networkQuiet, networkWaitMs, captureWaitMs: Date.now() - startedAt,
    } };
    previous = hash;
    await page.waitForTimeout(250);
  }
  throw new ReplayFailure('unstable_checkpoint',
    'The static screen kept changing at its checkpoint; wait for a real settled state before capturing.',
    { sampleCount: samples.length, samples, networkQuiet, networkWaitMs,
      captureWaitMs: Date.now() - startedAt });
}

function networkTracker(page) {
  const active = new Set();
  let lastActivity = Date.now();
  const start = (request) => { active.add(request); lastActivity = Date.now(); };
  const end = (request) => { active.delete(request); lastActivity = Date.now(); };
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return {
    async quiet(timeoutMs, quietMs = 350) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (active.size === 0 && Date.now() - lastActivity >= quietMs) return;
        await page.waitForTimeout(50);
      }
      throw new ReplayFailure('network_not_quiet', `Network did not become quiet within ${timeoutMs} ms.`);
    },
    close() {
      page.off('request', start); page.off('requestfinished', end); page.off('requestfailed', end);
    },
  };
}

async function executeAction(page, action, origin, network, authToken = '', controlledFailure = null,
  hostedAppState = null) {
  const startedAt = Date.now();
  switch (action.type) {
    case 'requestFailure':
      if (!controlledFailure || controlledFailure.path !== action.path) {
        throw new ReplayFailure('invalid_controlled_failure', 'Request failure does not match the accepted intent.');
      }
      controlledFailure.enabled = action.enabled;
      break;
    case 'navigate':
      await page.goto(authorizedUrl(origin, action.path, authToken), { waitUntil: 'domcontentloaded', timeout: planContract.MAX_WAIT_MS });
      break;
    case 'click':
      await (await resolveOne(page, action.target, action.id)).click({ timeout: planContract.MAX_WAIT_MS });
      break;
    case 'fill':
      await (await resolveOne(page, action.target, action.id)).fill(action.value, { timeout: planContract.MAX_WAIT_MS });
      break;
    case 'press': {
      const target = action.target ? await resolveOne(page, action.target, action.id) : page.keyboard;
      await target.press(action.key, { timeout: planContract.MAX_WAIT_MS });
      break;
    }
    case 'select':
      await (await resolveOne(page, action.target, action.id)).selectOption(action.value, { timeout: planContract.MAX_WAIT_MS });
      break;
    case 'check':
      await (await resolveOne(page, action.target, action.id)).check({ timeout: planContract.MAX_WAIT_MS });
      break;
    case 'uncheck':
      await (await resolveOne(page, action.target, action.id)).uncheck({ timeout: planContract.MAX_WAIT_MS });
      break;
    case 'hover':
      await (await resolveOne(page, action.target, action.id)).hover({ timeout: planContract.MAX_WAIT_MS });
      break;
    case 'drag':
      await (await resolveOne(page, action.from, `${action.id}.from`))
        .dragTo(await resolveOne(page, action.to, `${action.id}.to`), { timeout: planContract.MAX_WAIT_MS });
      break;
    case 'hoverViewport': {
      const viewport = page.viewportSize();
      if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
        throw new ReplayFailure('viewport_unavailable', `${action.id} viewport is unavailable.`);
      }
      await page.mouse.move(
        Math.min(viewport.width - 1, Math.round(viewport.width * action.xRatio)),
        Math.min(viewport.height - 1, Math.round(viewport.height * action.yRatio)));
      break;
    }
    case 'hoverPoint': {
      const box = await (await resolveOne(page, action.surface, action.id)).boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) throw new ReplayFailure('surface_not_visible', `${action.id} surface is not visible.`);
      await page.mouse.move(box.x + box.width * action.xRatio, box.y + box.height * action.yRatio);
      break;
    }
    case 'clickPoint': {
      const box = await (await resolveOne(page, action.surface, action.id)).boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) throw new ReplayFailure('surface_not_visible', `${action.id} surface is not visible.`);
      await page.mouse.click(box.x + box.width * action.xRatio, box.y + box.height * action.yRatio);
      break;
    }
    case 'dragPoints': {
      const box = await (await resolveOne(page, action.surface, action.id)).boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) throw new ReplayFailure('surface_not_visible', `${action.id} surface is not visible.`);
      await page.mouse.move(box.x + box.width * action.from.xRatio, box.y + box.height * action.from.yRatio);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * action.to.xRatio, box.y + box.height * action.to.yRatio, { steps: 8 });
      await page.mouse.up();
      break;
    }
    case 'scrollIntoView':
      await (await resolveOne(page, action.target, action.id)).scrollIntoViewIfNeeded({ timeout: planContract.MAX_WAIT_MS });
      break;
    case 'waitForHostedApp': {
      const deadline = Date.now() + action.timeoutMs;
      while (!hostedAppState?.loaded.has(action.slug) && Date.now() < deadline) {
        await page.waitForTimeout(50);
      }
      if (!hostedAppState?.loaded.has(action.slug)) {
        throw new ReplayFailure('hosted_app_not_loaded',
          `The ${action.slug} app document did not load successfully in the managed app frame.`,
          { appSlug: action.slug, loadedAppSlugs: [...(hostedAppState?.loaded.keys() || [])].slice(0, 10),
            trustedAppSlugs: [...(hostedAppState?.catalog?.values() || [])].slice(0, 20) });
      }
      break;
    }
    case 'scrollBy':
      await page.evaluate(({ x, y }) => window.scrollBy({ left: x, top: y, behavior: 'instant' }), { x: action.x, y: action.y });
      break;
    case 'waitFor':
      if (action.target) {
        if (action.state === 'hidden') await waitForNotVisible(page, action.target, action.id, action.timeoutMs);
        else await waitForAnyVisible(page, action.target, action.id, action.timeoutMs);
      }
      else if (action.text) await waitForVisibleText(page, action.text, action.id, action.timeoutMs);
      else if (action.path) await page.waitForURL((url) => url.origin === origin && publicRelativePath(url) === action.path, { timeout: action.timeoutMs });
      else await network.quiet(action.timeoutMs);
      break;
    default: throw new ReplayFailure('unsupported_action', `Unsupported action ${String(action.type)}.`);
  }
  return Date.now() - startedAt;
}

async function evaluateAssertion(page, assertion, origin) {
  if (assertion.type === 'url') {
    const url = new URL(page.url());
    const actual = publicRelativePath(url);
    if (url.origin !== origin || actual !== assertion.path) {
      throw new ReplayFailure('assertion_failed', `Expected path ${assertion.path}, received ${actual}.`);
    }
    return { type: assertion.type, passed: true, actual };
  }
  const locator = locatorFor(page, assertion.target);
  const count = await locator.count();
  const first = locator.first();
  let passed = false;
  let actual = null;
  switch (assertion.type) {
    case 'visible': passed = count === 1 && await first.isVisible(); break;
    case 'hidden':
      if (count === 1) actual = await first.isVisible();
      passed = count === 0 || (count === 1 && actual === false);
      break;
    case 'attached': passed = count === 1; break;
    case 'detached': passed = count === 0; break;
    case 'text':
      if (count === 1) actual = clip(await first.textContent(), planContract.MAX_LOCATOR_VALUE);
      passed = count === 1 && (assertion.exact ? actual === assertion.value : actual.includes(assertion.value));
      break;
    case 'count': actual = count; passed = count === assertion.count; break;
    case 'value':
      if (count === 1) actual = await first.inputValue().catch(() => null);
      passed = count === 1 && actual === assertion.value;
      break;
    case 'checked':
      if (count === 1) actual = await first.isChecked().catch(() => false);
      passed = count === 1 && actual === true;
      break;
    case 'focusWithin':
      if (count === 1) passed = await first.evaluate((element) => element === document.activeElement || element.contains(document.activeElement));
      break;
    default: throw new ReplayFailure('unsupported_assertion', `Unsupported assertion ${assertion.type}.`);
  }
  if (!passed) {
    throw new ReplayFailure('assertion_failed', `${assertion.type} assertion failed.`, { assertion, count, actual });
  }
  return { type: assertion.type, passed: true, count, ...(actual == null ? {} : { actual }) };
}

function actionLocatorSpecs(action) {
  return [action?.target, action?.from, action?.to, action?.surface]
    .filter((spec) => spec && typeof spec === 'object');
}

function paddedRect(rect, viewport, padding = FOCUS_PADDING) {
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  const right = Math.min(viewport.width, rect.x + rect.width + padding);
  const bottom = Math.min(viewport.height, rect.y + rect.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}

function centeredRect(rect, width, height, viewport) {
  const x = Math.max(0, Math.min(viewport.width - width, rect.x + rect.width / 2 - width / 2));
  const y = Math.max(0, Math.min(viewport.height - height, rect.y + rect.height / 2 - height / 2));
  return { x, y, width: Math.min(width, viewport.width), height: Math.min(height, viewport.height) };
}

function normalizeCropPair(baseRect, headRect, viewport, padding = FOCUS_PADDING) {
  const basePadded = paddedRect(baseRect, viewport, padding);
  const headPadded = paddedRect(headRect, viewport, padding);
  const width = Math.min(viewport.width, Math.max(basePadded.width, headPadded.width));
  const height = Math.min(viewport.height, Math.max(basePadded.height, headPadded.height));
  return {
    base: centeredRect(baseRect, width, height, viewport),
    head: centeredRect(headRect, width, height, viewport),
  };
}

async function cropPng(page, buffer, crop, viewport) {
  const result = await page.evaluate(async ({ data, crop: box, viewport: vp }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const sx = image.naturalWidth / vp.width;
    const sy = image.naturalHeight / vp.height;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.width * sx));
    canvas.height = Math.max(1, Math.round(box.height * sy));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, box.x * sx, box.y * sy, box.width * sx, box.height * sy,
      0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { data: buffer.toString('base64'), crop, viewport });
  return Buffer.from(result, 'base64');
}

function perceptualHash(buffer) {
  // Decoding in Chromium's canvas produced different hashes for byte-identical
  // PNGs in separate replay passes. Decode on the CPU so the reproducibility
  // check measures the screenshot rather than a GPU resampling decision.
  const { PNG } = require('pngjs');
  const { width, height, data } = PNG.sync.read(buffer);
  const cells = Array.from({ length: 8 }, (_, y) => Array.from({ length: 9 }, (_, x) => {
    let sum = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = Math.min(width - 1, Math.floor((x + (sx + 0.5) / 4) * width / 9));
      const py = Math.min(height - 1, Math.floor((y + (sy + 0.5) / 4) * height / 8));
      const offset = (py * width + px) * 4;
      sum += 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    }
    return sum / 16;
  }));
  let bits = '';
  for (const row of cells) for (let x = 0; x < 8; x++) {
    bits += row[x] > row[x + 1] + 0.5 ? '1' : '0';
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

function hammingHex(left, right) {
  let n = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (n) { count += Number(n & 1n); n >>= 1n; }
  return count;
}

async function composePairFrame(page, base, head, { label, width = 960 }) {
  await page.setViewportSize({ width, height: 640 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;background:#18181b;color:#fafafa;font:600 14px system-ui,sans-serif}
      main{width:${width}px;padding:10px}.stage{height:26px;display:flex;align-items:center;justify-content:center;color:#d4d4d8}
      .pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.side{min-width:0}.name{font-size:11px;color:#a1a1aa;margin:0 0 5px}
      img{display:block;width:100%;height:auto;max-height:570px;object-fit:contain;object-position:top;background:#09090b;border:1px solid #3f3f46;border-radius:6px}
    </style><main><div class="stage"></div><div class="pair"><div class="side"><p class="name">Before</p><img id="before"></div><div class="side"><p class="name">After</p><img id="after"></div></div></main>`);
    await page.evaluate(async ({ b, h, stage }) => {
      document.querySelector('.stage').textContent = stage;
      const before = document.querySelector('#before'); const after = document.querySelector('#after');
      before.src = `data:image/png;base64,${b}`; after.src = `data:image/png;base64,${h}`;
      await Promise.all([before.decode(), after.decode()]);
      const main = document.querySelector('main');
      const height = Math.ceil(main.getBoundingClientRect().height);
      document.documentElement.style.height = `${height}px`;
      document.body.style.height = `${height}px`;
    }, { b: base.toString('base64'), h: head.toString('base64'), stage: clip(label, 120) });
  const box = await page.locator('main').boundingBox();
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height: Math.min(640, Math.ceil(box.height)) } });
}

async function encodeWebm(frames, { fps, targetBytes, maxBytes }) {
  if (!frames.length) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usernode-evidence-'));
  try {
    const capped = frames.slice(0, fps * MAX_ANIMATION_SECONDS);
    await Promise.all(capped.map((frame, index) => fsp.writeFile(path.join(dir, `frame-${String(index).padStart(4, '0')}.png`), frame)));
    let result = null;
    for (const crf of [36, 42, 48]) {
      const output = path.join(dir, `animation-${crf}.webm`);
      try {
        await execFileAsync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps),
          '-i', path.join(dir, 'frame-%04d.png'), '-an', '-c:v', 'libvpx-vp9',
          '-deadline', 'good', '-cpu-used', '3', '-crf', String(crf), '-b:v', '0',
          '-pix_fmt', 'yuv420p', '-row-mt', '1', output,
        ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) {
        throw new ReplayFailure('animation_encode_failed', 'The evidence video encoder failed.', {
          frameCount: capped.length, fps, crf,
          exitCode: Number.isInteger(error.code) ? error.code : null,
          killed: error.killed === true,
          stderr: safeDiagnosticText(error.stderr || error.message, 300),
        });
      }
      result = await fsp.readFile(output);
      if (result.length <= targetBytes) break;
    }
    if (!result || result.length > maxBytes) {
      throw new ReplayFailure('animation_over_cap', `Animation exceeded its ${maxBytes}-byte cap.`, { bytes: result?.length || 0 });
    }
    return result;
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

const { trustedHostedAppOrigins, loadTrustedHostedAppOrigins } = hostedApps;

async function installOriginFence(context, allowedOrigins, diagnostics, controlledFailure = null,
  { loadHostedOrigins = null, hostedOrigins = new Set() } = {}) {
  const admittedFrames = new WeakSet();
  let trustedOrigins = null;
  const insideAdmittedFrame = (frame) => {
    for (let current = frame; current; current = current.parentFrame?.()) {
      if (admittedFrames.has(current)) return true;
    }
    return false;
  };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (/^(?:data|blob|about):/.test(url)) return route.continue();
    let origin;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin && allowedOrigins.has(origin)) {
      if (controlledFailure?.enabled && request.method() === 'GET'
          && new URL(url).pathname + new URL(url).search === controlledFailure.path) {
        controlledFailure.requests.add(request);
        controlledFailure.hits += 1;
        controlledFailure.urls.add(url);
        return route.abort('failed');
      }
      return route.continue();
    }
    // A child app is a different origin. Admit its actual document only when
    // the platform's own app catalog says it is a deployed, public app AND
    // the request comes from the managed app iframe. Subresources remain
    // restricted to that frame; arbitrary cross-origin requests stay fenced.
    let frame = null;
    try { frame = request.frame(); } catch { /* service worker or pre-frame request */ }
    if (origin && hostedOrigins.has(origin) && insideAdmittedFrame(frame)) return route.continue();
    if (origin && loadHostedOrigins && request.resourceType() === 'document' && frame?.parentFrame?.()) {
      let managedFrame = false;
      try { managedFrame = await frame.frameElement().then((element) => element.getAttribute('id')) === 'app-iframe'; }
      catch { /* an unmounted frame is never trusted */ }
      if (managedFrame) {
        if (!trustedOrigins) trustedOrigins = Promise.resolve().then(loadHostedOrigins);
        const catalog = await trustedOrigins;
        if (catalog.has(origin)) {
          admittedFrames.add(frame);
          hostedOrigins.add(origin);
          return route.continue();
        }
      }
    }
    if (diagnostics.blockedRequests.length < MAX_CONSOLE_ITEMS) {
      diagnostics.blockedRequests.push({
        origin: safeDiagnosticText(origin || 'invalid', 120),
        resourceType: safeDiagnosticText(request.resourceType(), 40),
        ...(frame?.parentFrame?.() ? { embedded: true } : {}),
      });
    }
    return route.abort('blockedbyclient');
  });
}

function discardExpectedControlledFailureConsole(diagnostics, consoleEvents, controlledFailure) {
  if (!controlledFailure?.hits) return 0;
  let discarded = 0;
  for (const { entry, url, message } of consoleEvents) {
    if (!controlledFailure.urls.has(url)
        || !/^Failed to load resource: net::ERR_(?:FAILED|BLOCKED_BY_CLIENT)$/i.test(message.trim())) continue;
    const index = diagnostics.consoleErrors.indexOf(entry);
    if (index < 0) continue;
    diagnostics.consoleErrors.splice(index, 1);
    discarded += 1;
  }
  return discarded;
}

async function addCookies(context, origin, values) {
  if (!Array.isArray(values) || !values.length) return;
  const hostname = new URL(origin).hostname;
  const cookies = values.slice(0, 10).map((cookie) => ({
    name: String(cookie.name || '').slice(0, 100),
    value: String(cookie.value || '').slice(0, 4096),
    domain: hostname,
    path: '/',
    httpOnly: cookie.httpOnly !== false,
    secure: origin.startsWith('https:'),
    sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'Lax',
  })).filter((cookie) => cookie.name && cookie.value);
  if (cookies.length) await context.addCookies(cookies);
}

const sessionCookieValue = sessionBootstrap.sessionCookieValue;

async function bootstrapInternalSession(context, origin, startPath, authToken, diagnostic = null) {
  return sessionBootstrap.bootstrapInternalSession(
    context, origin, authorizedUrl(origin, startPath, authToken), authToken,
    diagnostic, planContract.MAX_WAIT_MS
  );
}

async function startMotionCapture(page) {
  const client = await page.context().newCDPSession(page);
  const frames = [];
  const startedAt = Date.now();
  client.on('Page.screencastFrame', async (event) => {
    try {
      if (frames.length < MOTION_FPS * MAX_ANIMATION_SECONDS) {
        frames.push({ at: Date.now() - startedAt, data: Buffer.from(event.data, 'base64') });
      }
    } finally { await client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); }
  });
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return {
    frames,
    durationMs: 0,
    async stop() {
      if (this.durationMs) return;
      this.durationMs = Date.now() - startedAt;
      await client.send('Page.stopScreencast').catch(() => {});
      await client.detach().catch(() => {});
    },
  };
}

function screenshotFingerprint(result) {
  return crypto.createHash('sha256').update(JSON.stringify({
    path: result.path,
    assertions: result.assertions.map((item) => ({ type: item.type, passed: item.passed, actual: item.actual })),
    focus: Object.fromEntries(Object.entries(result.focusRect).map(([key, value]) => [key, Math.round(value)])),
    stages: result.stages.map((stage) => stage.stage),
    hostedAppsLoaded: result.hostedAppsLoaded,
  })).digest('hex');
}

async function runSide(browser, scratchPage, input, story, viewport, side) {
  const origin = input.origins[side];
  const authToken = input.authTokens[story.persona] || '';
  const sidePlan = story.replay[side === 'head' ? 'after' : 'before'];
  const animation = story.replay.checkpoint.animation;
  const motion = animation === 'motion';
  const recordInteraction = animation === 'steps';
  const diagnostics = {
    consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], httpErrors: [],
    expectedSandboxWarnings: 0,
  };
  const controlledFailure = story.intent.controlledFailurePath
    ? { path: story.intent.controlledFailurePath, enabled: false, hits: 0,
      requests: new WeakSet(), urls: new Set() }
    : null;
  const bootstrap = { attempted: false, cookieAlreadyPresent: false, sessionCookieInstalled: false, responseStatus: null };
  const hostedOrigins = new Set();
  const hostedAppState = { catalog: new Map(), loaded: new Map() };
  const eventBase = {
    runId: input.runId, pass: input.pass, storyId: story.id,
    viewport: viewport.name, side,
  };
  const sideStartedAt = Date.now();
  emitEvent({ type: 'side_started', ...eventBase });
  let context;
  let page;
  let setupPhase = 'create_context';
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: input.browser.deviceScaleFactor,
      locale: input.browser.locale,
      timezoneId: input.browser.timezoneId,
      colorScheme: input.browser.colorScheme,
      reducedMotion: motion ? 'no-preference' : 'reduce',
      serviceWorkers: 'block',
      // The bootstrap below installs the clone-local session cookie on the
      // platform origin. Never put its app-scoped token in context-wide
      // headers: an embedded app or redirect would receive that header too.
    });
    // A side may never fetch from or navigate to its counterpart. Keeping the
    // origins in one input is an orchestration convenience, not a permission
    // for base and head to observe each other.
    const allowedOrigins = new Set([origin]);
    setupPhase = 'install_origin_fence';
    await installOriginFence(context, allowedOrigins, diagnostics, controlledFailure, {
      hostedOrigins,
      loadHostedOrigins: async () => {
        hostedAppState.catalog = await loadTrustedHostedAppOrigins(context, origin);
        return hostedAppState.catalog;
      },
    });
    setupPhase = 'install_cookies';
    await addCookies(context, origin, input.cookies[side]);
    setupPhase = 'bootstrap_session';
    await bootstrapInternalSession(context, origin, sidePlan.startPath, authToken, bootstrap);
    emitEvent({ type: 'session_bootstrap', ...eventBase, ...bootstrap });
    setupPhase = 'install_capture_style';
    if (!motion) {
      await context.addInitScript(() => {
        const style = document.createElement('style');
        style.dataset.usernodeEvidence = '1';
        style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}';
        const attach = () => document.documentElement?.appendChild(style);
        if (document.documentElement) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
      });
    }
    setupPhase = 'new_page';
    page = await context.newPage();
  } catch (error) {
    emitEvent({
      type: 'side_failed', ...eventBase, phase: setupPhase,
      code: String(error?.code || 'replay_failed').slice(0, 64),
    });
    await context?.close().catch(() => {});
    throw contextualFailure(error, {
      storyId: story.id, viewport: viewport.name, side, phase: setupPhase, bootstrap,
    });
  }
  const network = networkTracker(page);
  const navigationToken = replayNavigationToken(authToken, bootstrap);
  const startUrl = authorizedUrl(origin, sidePlan.startPath, navigationToken);
  const initialNavigationFailures = [];
  const initialNavigationRetries = new Set();
  let initialNavigationPending = true;
  const networkFailures = [];
  const requestStartPages = new WeakMap();
  const successfulRequests = new Map();
  const consoleEvents = [];
  let networkOrder = 0;
  let recoveredNetworkChanges = 0;
  let cancelledReads = 0;
  let expectedFailureConsoleCount = 0;
  const assertCleanBrowser = () => {
    if (controlledFailure && controlledFailure.hits === 0) {
      throw new ReplayFailure('controlled_failure_unused',
        'The declared API request was never made while the controlled failure was enabled.');
    }
    expectedFailureConsoleCount += discardExpectedControlledFailureConsole(
      diagnostics, consoleEvents, controlledFailure
    );
    recoveredNetworkChanges += discardRecoveredNetworkChanges(
      diagnostics, networkFailures, successfulRequests, consoleEvents
    ).requests;
    cancelledReads += discardCancelledReads(
      diagnostics, networkFailures, consoleEvents, pageRouteIdentity(page.url())
    ).requests;
    if (diagnostics.consoleErrors.length || diagnostics.pageErrors.length
        || diagnostics.failedRequests.length || diagnostics.blockedRequests.length) {
      throw new ReplayFailure('browser_diagnostics',
        `${side} emitted browser errors, request failures, or attempted cross-origin traffic.`,
        diagnostics);
    }
  };
  page.on('console', (message) => {
    if (message.type() === 'error' && diagnostics.consoleErrors.length < MAX_CONSOLE_ITEMS) {
      const source = diagnosticLocation(message.location()?.url || '', origin);
      if (expectedPendingFrameWarning(message.text(), source)) {
        diagnostics.expectedSandboxWarnings += 1;
        return;
      }
      const entry = {
        message: safeDiagnosticText(message.text()),
        source,
        sourceKind: diagnosticOriginKind(message.location()?.url || '', origin, hostedOrigins),
      };
      diagnostics.consoleErrors.push(entry);
      consoleEvents.push({ entry, url: message.location()?.url || '', method: 'GET', message: message.text() });
    }
  });
  page.on('request', (request) => {
    requestStartPages.set(request, page.url());
  });
  page.on('pageerror', (error) => {
    if (diagnostics.pageErrors.length < MAX_CONSOLE_ITEMS) {
      diagnostics.pageErrors.push({
        message: safeDiagnosticText(error.message),
        sourceKind: pageErrorOriginKind(error, origin, hostedOrigins),
      });
    }
  });
  page.on('requestfailed', (request) => {
    if (controlledFailure?.requests.has(request)) return;
    let inspectedOrigin = false;
    try {
      const requestOrigin = new URL(request.url()).origin;
      inspectedOrigin = requestOrigin === origin || hostedOrigins.has(requestOrigin);
    } catch {}
    if (inspectedOrigin && diagnostics.failedRequests.length < MAX_CONSOLE_ITEMS) {
      const failure = {
        location: diagnosticLocation(request.url(), origin),
        error: safeDiagnosticText(request.failure()?.errorText || '', 120),
      };
      if (/\bnet::ERR_ABORTED\b/i.test(failure.error)) {
        failure.fromPage = diagnosticLocation(requestStartPages.get(request) || '', origin);
        failure.atPage = diagnosticLocation(page.url(), origin);
      }
      diagnostics.failedRequests.push(failure);
      if (initialNavigationPending) initialNavigationFailures.push({ request, failure });
      networkFailures.push({
        entry: failure, url: request.url(), method: request.method(),
        resourceType: request.resourceType(),
        startRoute: pageRouteIdentity(requestStartPages.get(request)),
        endRoute: pageRouteIdentity(page.url()),
        error: request.failure()?.errorText || '', order: ++networkOrder,
      });
    }
  });
  page.on('response', (response) => {
    const status = response.status();
    let responseOrigin = null;
    try { responseOrigin = new URL(response.url()).origin; } catch {}
    if (status >= 200 && status < 300 && hostedOrigins.has(responseOrigin)
        && response.request().resourceType() === 'document') {
      const slug = hostedAppState.catalog.get(responseOrigin);
      if (slug) hostedAppState.loaded.set(slug, responseOrigin);
    }
    if (status >= 200 && status < 400) {
      const key = requestIdentity(response.url(), response.request().method());
      if (key) successfulRequests.set(key, ++networkOrder);
    }
    if (status < 400 || diagnostics.httpErrors.length >= MAX_CONSOLE_ITEMS) return;
    const location = diagnosticLocation(response.url(), origin);
    let hostedOrigin = null;
    try { hostedOrigin = new URL(response.url()).origin; } catch {}
    if (location.sameOrigin || hostedOrigins.has(hostedOrigin)) {
      diagnostics.httpErrors.push({ status, location,
        ...(location.sameOrigin ? {} : { hostedOrigin: safeDiagnosticText(hostedOrigin, 120) }) });
    }
  });

  const stages = [];
  let motionCapture = null;
  let navigation = null;
  let failureLocatorSpecs = [];
  let failureStage = { phase: 'navigate_start' };
  try {
    emitEvent({ type: 'navigation_started', ...eventBase });
    const response = await navigateStart(page, startUrl, ({ attempt, code }) => {
      initialNavigationRetries.add(code);
      emitEvent({ type: 'navigation_retry', ...eventBase, attempt, code });
    });
    initialNavigationPending = false;
    navigation = {
      status: typeof response?.status === 'function' ? response.status() : null,
    };
    const recoveredRequestCount = discardRecoveredInitialNavigationFailures(
      diagnostics, initialNavigationFailures, page, startUrl,
      initialNavigationRetries, navigation.status
    );
    await settlePage(page, { motion });
    emitEvent({
      type: 'navigation_completed', ...eventBase,
      status: navigation.status,
      recoveredRequestCount,
      location: diagnosticLocation(page.url(), origin),
    });
    failureStage = { phase: 'capture_start' };
    stages.push({ stage: '__start__', image: await page.screenshot({ type: 'png' }) });
    failureStage = { phase: 'start_recording' };
    if (motion || recordInteraction) motionCapture = await startMotionCapture(page);

    const actionResults = [];
    const sideDeadline = Date.now() + planContract.MAX_SIDE_MS;
    for (const action of sidePlan.actions) {
      failureStage = { phase: 'action', actionId: action.id, actionStage: action.stage, actionType: action.type };
      failureLocatorSpecs = actionLocatorSpecs(action);
      emitEvent({
        type: 'action_started', ...eventBase,
        actionId: action.id, actionStage: action.stage, actionType: action.type,
      });
      if (Date.now() >= sideDeadline) throw new ReplayFailure('side_timeout', `${side} exceeded its ${planContract.MAX_SIDE_MS} ms budget.`);
      const durationMs = await executeAction(page, action, origin, network, navigationToken,
        controlledFailure, hostedAppState);
      await settlePage(page, { motion });
      actionResults.push({ id: action.id, stage: action.stage, type: action.type, durationMs, passed: true });
      emitEvent({
        type: 'action_completed', ...eventBase,
        actionId: action.id, actionStage: action.stage, actionType: action.type,
        durationMs, location: diagnosticLocation(page.url(), origin),
      });
      if (story.replay.checkpoint.animation === 'steps') {
        stages.push({ stage: action.stage, image: await page.screenshot({ type: 'png' }) });
      }
    }
    failureStage = { phase: 'stop_recording' };
    if (motionCapture) await motionCapture.stop();

    const assertionList = story.replay.checkpoint.assertions[side === 'head' ? 'after' : 'before'];
    failureStage = { phase: 'final_path' };
    const finalPath = expectedFinalPath(sidePlan.startPath, page.url(), origin, side, {
      allowDeclaredHome: assertionList.some((assertion) => assertion.type === 'url' && assertion.path === '/'),
    });

    const assertions = [];
    for (const [assertionIndex, assertion] of assertionList.entries()) {
      failureStage = { phase: 'assertion', assertionIndex, assertionType: assertion.type };
      failureLocatorSpecs = assertion.target ? [assertion.target] : [];
      emitEvent({ type: 'assertion_started', ...eventBase, assertionIndex, assertionType: assertion.type });
      assertions.push(await evaluateAssertion(page, assertion, origin));
      emitEvent({ type: 'assertion_completed', ...eventBase, assertionIndex, assertionType: assertion.type });
    }

    failureStage = { phase: 'focus' };
    const focusSpec = story.replay.checkpoint.focus[side === 'head' ? 'after' : 'before'];
    failureLocatorSpecs = [focusSpec];
    const focus = await requireOne(locatorFor(page, focusSpec), `${story.id} ${side} focus`);
    if (!await focus.isVisible()) throw new ReplayFailure('focus_not_visible', `${story.id} ${side} focus is not visible.`);
    const focusRect = await focus.boundingBox();
    if (!focusRect || focusRect.width < 8 || focusRect.height < 8) {
      throw new ReplayFailure('focus_too_small', `${story.id} ${side} focus is too small to review.`);
    }
    // A browser error is already decisive. Surface it before spending time on
    // screenshots so it cannot be hidden by a later checkpoint timeout.
    failureStage = { phase: 'browser_diagnostics' };
    assertCleanBrowser();
    failureStage = { phase: 'capture_checkpoint' };
    const { png: contextPng, stability } = await captureStableCheckpoint(page, network, { motion });
    emitEvent({ type: 'checkpoint_stability', ...eventBase, ...stability });
    stages.push({ stage: '__checkpoint__', image: contextPng });

    failureStage = { phase: 'browser_diagnostics' };
    assertCleanBrowser();
    const result = {
      side, storyId: story.id, viewport: viewport.name, path: finalPath,
      actionResults, assertions, focusRect, contextPng, stages,
      hostedAppsLoaded: [...hostedAppState.loaded.keys()].sort(),
      motionFrames: motionCapture
        ? [{ at: 0, data: stages[0].image }, ...motionCapture.frames,
          { at: motionCapture.durationMs, data: contextPng }]
        : [],
      recordedFrameCount: motionCapture?.frames.length || 0,
      diagnostics,
    };
    // The structural fingerprint proves the same route/actions/assertions and
    // focus geometry were reached. The perceptual hash separately binds the
    // verdict to rendered pixels while tolerating a couple of harmless raster
    // bits between clean Chromium runs.
    result.contextHash = perceptualHash(contextPng);
    result.fingerprint = screenshotFingerprint(result);
    emitEvent({
      type: 'side_finished', ...eventBase,
      durationMs: Date.now() - sideStartedAt,
      actionCount: actionResults.length, assertionCount: assertions.length,
      recordedFrameCount: result.recordedFrameCount,
      location: diagnosticLocation(page.url(), origin),
      httpErrorCount: diagnostics.httpErrors.length,
      recoveredNetworkChanges,
      cancelledReads,
      controlledFailureHits: controlledFailure?.hits || 0,
      expectedFailureConsoleCount,
      expectedSandboxWarnings: diagnostics.expectedSandboxWarnings,
    });
    return result;
  } catch (error) {
    const [pageState, targetStates] = await Promise.all([
      failurePageState(page, context, origin, navigation),
      Promise.all(failureLocatorSpecs.slice(0, 4).map((spec) =>
        locatorSnapshot(page, spec, { includeCandidates: true })))
        .catch(() => []),
    ]);
    emitEvent({
      type: 'side_failed', ...eventBase, ...failureStage,
      code: String(error?.code || 'replay_failed').slice(0, 64),
      message: safeDiagnosticText(error?.message || error, 200),
      location: diagnosticLocation(page.url(), origin),
    });
    throw contextualFailure(error, {
      storyId: story.id, viewport: viewport.name, side, ...failureStage,
      pageState,
      bootstrap,
      hostedAppSlugs: [...hostedAppState.loaded.keys()].slice(0, 10),
      targetStates,
      browserDiagnostics: failureBrowserDiagnostics(diagnostics),
    });
  } finally {
    if (motionCapture) await motionCapture.stop().catch(() => {});
    network.close();
    await context.close();
  }
}

async function buildStepsAnimation(scratchPage, base, head, viewport, checkpoint) {
  if (base.recordedFrameCount < 2 || head.recordedFrameCount < 2) {
    throw new ReplayFailure('no_visible_interaction',
      'The interaction did not yield a browser recording on both revisions; use screenshots for a static claim.',
      { baseFrames: base.recordedFrameCount, headFrames: head.recordedFrameCount });
  }
  const fullViewport = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const maxAt = Math.min(MAX_ANIMATION_SECONDS * 1000,
    Math.max(base.motionFrames.at(-1)?.at || 0, head.motionFrames.at(-1)?.at || 0));
  const frames = [];
  const changed = { base: false, head: false };
  let previousContent = null;
  for (let at = 0; at <= maxAt && frames.length < STEPS_FPS * MAX_ANIMATION_SECONDS; at += 1000 / STEPS_FPS) {
    const before = motionFrameAt(base.motionFrames, at)?.data;
    const after = motionFrameAt(head.motionFrames, at)?.data;
    const baseCrop = await cropPng(scratchPage, before, fullViewport, viewport);
    const headCrop = await cropPng(scratchPage, after, fullViewport, viewport);
    const content = [perceptualHash(baseCrop), perceptualHash(headCrop)];
    if (previousContent) {
      if (hammingHex(content[0], previousContent[0]) > 2) changed.base = true;
      if (hammingHex(content[1], previousContent[1]) > 2) changed.head = true;
    }
    previousContent = content;
    frames.push(await composePairFrame(scratchPage, baseCrop, headCrop, { label: checkpoint.label }));
  }
  if (!changed.base || !changed.head) {
    throw new ReplayFailure('no_visible_interaction',
      'The browser recording did not show interaction on both revisions; use screenshots for a static claim.',
      { baseFrames: base.recordedFrameCount, headFrames: head.recordedFrameCount,
        sampledFrames: frames.length, changed });
  }
  return {
    data: await encodeWebm(frames, { fps: STEPS_FPS, targetBytes: STEPS_TARGET_BYTES, maxBytes: STEPS_MAX_BYTES }),
    labels: [checkpoint.label],
  };
}

function motionFrameAt(frames, at) {
  if (!frames.length) return null;
  let best = frames[0];
  for (const frame of frames) {
    if (Math.abs(frame.at - at) < Math.abs(best.at - at)) best = frame;
  }
  return best;
}

async function buildMotionAnimation(scratchPage, base, head, crops, viewport, checkpoint) {
  const maxAt = Math.min(MAX_ANIMATION_SECONDS * 1000,
    Math.max(base.motionFrames.at(-1)?.at || 0, head.motionFrames.at(-1)?.at || 0));
  const frames = [];
  let previousContent = null;
  let changed = false;
  for (let at = 0; at <= maxAt && frames.length < MOTION_FPS * MAX_ANIMATION_SECONDS; at += 1000 / MOTION_FPS) {
    const before = motionFrameAt(base.motionFrames, at)?.data || base.contextPng;
    const after = motionFrameAt(head.motionFrames, at)?.data || head.contextPng;
    const baseCrop = await cropPng(scratchPage, before, crops.base, viewport);
    const headCrop = await cropPng(scratchPage, after, crops.head, viewport);
    const content = [perceptualHash(baseCrop), perceptualHash(headCrop)];
    if (previousContent && content.some((hash, index) =>
      hammingHex(hash, previousContent[index]) > 2)) changed = true;
    previousContent = content;
    frames.push(await composePairFrame(scratchPage, baseCrop, headCrop, { label: checkpoint.label }));
  }
  if (!changed) {
    throw new ReplayFailure('no_visible_motion',
      'The motion flow did not record changing visual frames; use screenshots for a static claim.',
      {
        baseFrames: base.recordedFrameCount,
        headFrames: head.recordedFrameCount,
        sampledFrames: frames.length,
        durationMs: maxAt,
      });
  }
  return {
    data: await encodeWebm(frames, { fps: MOTION_FPS, targetBytes: MOTION_TARGET_BYTES, maxBytes: MOTION_MAX_BYTES }),
    labels: [checkpoint.label],
  };
}

async function runReplay(browser, input) {
  const stories = [];
  const artifacts = [];
  emitEvent({ type: 'scratch_context_started', runId: input.runId, pass: input.pass });
  const scratchContext = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  let scratchPage;
  try { scratchPage = await scratchContext.newPage(); }
  catch (error) { await scratchContext.close().catch(() => {}); throw error; }
  emitEvent({ type: 'scratch_context_ready', runId: input.runId, pass: input.pass });
  try {
    for (const story of input.plan.stories) {
      for (const viewport of story.viewports) {
        if (input.selection && (input.selection.storyId !== story.id
            || input.selection.viewport !== viewport.name)) continue;
        emitEvent({ type: 'viewport_started', runId: input.runId, pass: input.pass, storyId: story.id, viewport: viewport.name });
        let phase = 'base';
        try {
          const base = await runSide(browser, scratchPage, input, story, viewport, 'base');
          phase = 'head';
          const head = await runSide(browser, scratchPage, input, story, viewport, 'head');
          phase = 'compose_focus';
          const crops = normalizeCropPair(base.focusRect, head.focusRect, viewport);
          const baseFocus = await cropPng(scratchPage, base.contextPng, crops.base, viewport);
          const headFocus = await cropPng(scratchPage, head.contextPng, crops.head, viewport);
          const baseFocusHash = perceptualHash(baseFocus);
          const headFocusHash = perceptualHash(headFocus);
          const storyResult = {
            id: story.id,
            viewport: viewport.name,
            base: { fingerprint: base.fingerprint, contextHash: base.contextHash, focusHash: baseFocusHash, path: base.path, actionResults: base.actionResults, assertions: base.assertions, focusRect: base.focusRect, cropRect: crops.base },
            head: { fingerprint: head.fingerprint, contextHash: head.contextHash, focusHash: headFocusHash, path: head.path, actionResults: head.actionResults, assertions: head.assertions, focusRect: head.focusRect, cropRect: crops.head },
          };
          stories.push(storyResult);
          if (input.publishArtifacts || input.diagnosticArtifacts) {
            artifacts.push(
              { storyId: story.id, viewport: viewport.name, side: 'base', variant: 'focus', media: 'png', contentType: 'image/png', width: Math.round(crops.base.width * input.browser.deviceScaleFactor), height: Math.round(crops.base.height * input.browser.deviceScaleFactor), focusRect: crops.base, data: baseFocus },
              { storyId: story.id, viewport: viewport.name, side: 'head', variant: 'focus', media: 'png', contentType: 'image/png', width: Math.round(crops.head.width * input.browser.deviceScaleFactor), height: Math.round(crops.head.height * input.browser.deviceScaleFactor), focusRect: crops.head, data: headFocus },
              { storyId: story.id, viewport: viewport.name, side: 'base', variant: 'context', media: 'png', contentType: 'image/png', width: viewport.width * input.browser.deviceScaleFactor, height: viewport.height * input.browser.deviceScaleFactor, focusRect: base.focusRect, data: base.contextPng },
              { storyId: story.id, viewport: viewport.name, side: 'head', variant: 'context', media: 'png', contentType: 'image/png', width: viewport.width * input.browser.deviceScaleFactor, height: viewport.height * input.browser.deviceScaleFactor, focusRect: head.focusRect, data: head.contextPng },
            );
            if (input.publishArtifacts && story.replay.checkpoint.animation !== 'none') {
              phase = 'encode_animation';
              emitEvent({
                type: 'animation_started', runId: input.runId, pass: input.pass,
                storyId: story.id, viewport: viewport.name,
                animation: story.replay.checkpoint.animation,
                baseFrames: base.recordedFrameCount, headFrames: head.recordedFrameCount,
              });
              const animation = story.replay.checkpoint.animation === 'motion'
                ? await buildMotionAnimation(scratchPage, base, head, crops, viewport, story.replay.checkpoint)
                : await buildStepsAnimation(scratchPage, base, head, viewport, story.replay.checkpoint);
              if (animation.data) artifacts.push({
                storyId: story.id, viewport: viewport.name, side: 'paired', variant: 'animation',
                media: 'webm', contentType: 'video/webm', width: 960, height: null,
                focusRect: { base: crops.base, head: crops.head }, stageLabels: animation.labels,
                data: animation.data,
              });
              emitEvent({
                type: 'animation_completed', runId: input.runId, pass: input.pass,
                storyId: story.id, viewport: viewport.name,
                animation: story.replay.checkpoint.animation,
                bytes: animation.data?.length || 0,
              });
            }
          }
        } catch (error) {
          throw contextualFailure(error, {
            storyId: story.id, viewport: viewport.name, phase,
            ...(['base', 'head'].includes(phase) ? { side: phase } : {}),
          });
        }
        emitEvent({ type: 'viewport_finished', runId: input.runId, pass: input.pass, storyId: story.id, viewport: viewport.name });
      }
    }
  } finally {
    await scratchContext.close();
  }
  return { stories, artifacts };
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  if (!chunks.length) throw new ReplayFailure('missing_input', 'Replay input is required on stdin.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReplayFailure('invalid_json', 'Replay input is not valid JSON.'); }
}

async function main({ chromium: injectedChromium, rawInput = null } = {}) {
  const input = validateInput(rawInput || await readInput());
  const chromium = injectedChromium || require('playwright-core').chromium;
  emitEvent({ type: 'started', runId: input.runId, pass: input.pass, planHash: input.planHash });
  emitEvent({ type: 'browser_launch_started', runId: input.runId, pass: input.pass });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      ...CHROMIUM_ARGS,
      ...(process.env.USERNODE_EVIDENCE_LOCAL_HOST_ALIAS === 'host.docker.internal'
        ? ['--host-resolver-rules=MAP localhost host.docker.internal'] : []),
    ],
  });
  emitEvent({ type: 'browser_launch_completed', runId: input.runId, pass: input.pass });
  try {
    const result = await runReplay(browser, input);
    for (const artifact of result.artifacts) {
      const { data, ...metadata } = artifact;
      emitArtifact({ runId: input.runId, pass: input.pass, ...metadata }, data);
    }
    emitEvent({
      type: 'result', runId: input.runId, pass: input.pass, planHash: input.planHash,
      passed: true, provenance: input.provenance, stories: result.stories,
      artifactCount: result.artifacts.length,
    });
  } finally { await browser.close(); }
}

if (require.main === module) {
  let rawIdentity = { runId: null, pass: null };
  readInput().then((raw) => {
    rawIdentity = { runId: raw?.runId, pass: raw?.pass };
    return main({ rawInput: raw });
  }).catch((err) => {
    emitEvent({
      type: 'result', runId: rawIdentity.runId, pass: rawIdentity.pass,
      passed: false, code: err.code || 'replay_failed',
      message: safeDiagnosticText(err.message || err), detail: err.detail || null,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  ReplayFailure,
  validateInput,
  locatorFor,
  locatorSnapshot,
  resolveOne,
  waitForAnyVisible,
  waitForNotVisible,
  waitForVisibleText,
  authorizedUrl,
  replayNavigationToken,
  navigateStart,
  discardRecoveredInitialNavigationFailures,
  discardRecoveredNetworkChanges,
  discardCancelledReads,
  discardExpectedControlledFailureConsole,
  trustedHostedAppOrigins,
  loadTrustedHostedAppOrigins,
  installOriginFence,
  expectedPendingFrameWarning,
  pageErrorOriginKind,
  executeAction,
  publicRelativePath,
  redactedUrl,
  sessionCookieValue,
  bootstrapInternalSession,
  failurePageState,
  expectedFinalPath,
  paddedRect,
  centeredRect,
  normalizeCropPair,
  hammingHex,
  captureStableCheckpoint,
  screenshotFingerprint,
  runReplay,
  contextualFailure,
  main,
  ARTIFACT_PREFIX,
  EVENT_PREFIX,
  STEPS_FPS,
  MOTION_FPS,
  STEPS_MAX_BYTES,
  MOTION_MAX_BYTES,
};
