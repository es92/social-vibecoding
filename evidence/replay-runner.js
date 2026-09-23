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
  const authTokens = Object.fromEntries(['member', 'read_only_admin'].map((persona) => {
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
    plan,
    planHash: planContract.planHash(plan),
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

async function executeAction(page, action, origin, network, authToken = '') {
  const startedAt = Date.now();
  switch (action.type) {
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
    case 'scrollBy':
      await page.evaluate(({ x, y }) => window.scrollBy({ left: x, top: y, behavior: 'instant' }), { x: action.x, y: action.y });
      break;
    case 'waitFor':
      if (action.target) await resolveOne(page, action.target, action.id, { state: 'visible', timeoutMs: action.timeoutMs });
      else if (action.text) await page.getByText(action.text, { exact: true }).first().waitFor({ state: 'visible', timeout: action.timeoutMs });
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
    case 'hidden': passed = count === 0 || (count === 1 && !await first.isVisible()); break;
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

async function installOriginFence(context, allowedOrigins, diagnostics) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (/^(?:data|blob|about):/.test(url)) return route.continue();
    let origin;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin && allowedOrigins.has(origin)) return route.continue();
    if (diagnostics.blockedRequests.length < MAX_CONSOLE_ITEMS) {
      diagnostics.blockedRequests.push({
        origin: safeDiagnosticText(origin || 'invalid', 120),
        resourceType: safeDiagnosticText(request.resourceType(), 40),
      });
    }
    return route.abort('blockedbyclient');
  });
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

function sessionCookieValue(headers) {
  for (const header of headers || []) {
    if (String(header?.name || '').toLowerCase() !== 'set-cookie') continue;
    const first = String(header.value || '').split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator < 0 || first.slice(0, separator).trim() !== 'session') continue;
    const value = first.slice(separator + 1).trim();
    // RFC 6265 cookie-octet, bounded before the value ever reaches
    // Playwright. Never include the rejected value in an error.
    if (!value || value.length > 4096
        || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) {
      throw new ReplayFailure('invalid_session_cookie', 'The evidence origin returned an invalid session cookie.');
    }
    return value;
  }
  return null;
}

async function bootstrapInternalSession(context, origin, startPath, authToken, diagnostic = null) {
  if (diagnostic) diagnostic.attempted = origin.startsWith('http:');
  if (!origin.startsWith('http:')) return false;
  const existing = await context.cookies(origin);
  if (existing.some((cookie) => cookie.name === 'session')) {
    if (diagnostic) diagnostic.cookieAlreadyPresent = true;
    return false;
  }

  let response;
  try {
    // The request cannot follow a redirect to another origin. Its only job
    // is to let a staging self-app exchange the short-lived, app-scoped JWT
    // for a local session row before page JavaScript starts cookie-only API
    // calls. Ordinary apps that do not set a session cookie remain on the
    // x-usernode-token path below.
    response = await context.request.get(authorizedUrl(origin, startPath, authToken), {
      headers: { 'x-usernode-token': authToken },
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: planContract.MAX_WAIT_MS,
    });
    if (diagnostic) diagnostic.responseStatus = response.status();
    const value = sessionCookieValue(await Promise.resolve(response.headersArray()));
    if (!value) return false;
    try {
      // The app deliberately emitted Secure because it runs in production
      // mode. Evidence reaches the same private service directly over HTTP,
      // so install the already-authenticated clone-local session with the
      // transport bit adjusted only for this isolated browser context.
      await context.addCookies([{
        name: 'session', value, url: origin, httpOnly: true,
        secure: false, sameSite: 'Lax',
      }]);
    } catch (_) {
      throw new ReplayFailure('session_bootstrap_failed', 'The evidence browser could not install its private session cookie.');
    }
    const installed = await context.cookies(origin);
    if (!installed.some((cookie) => cookie.name === 'session')) {
      throw new ReplayFailure('session_bootstrap_failed', 'The evidence browser did not retain its private session cookie.');
    }
    if (diagnostic) diagnostic.sessionCookieInstalled = true;
    return true;
  } finally {
    await response?.dispose?.().catch(() => {});
  }
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
  };
  const bootstrap = { attempted: false, cookieAlreadyPresent: false, sessionCookieInstalled: false, responseStatus: null };
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
      // Evidence environments are deliberately reachable only over their
      // private in-cluster HTTP origins. A production-mode self-app answers
      // the initial token-bearing request with a Secure session cookie, which
      // Chromium must reject on HTTP. Forward the same app-scoped credential
      // through the standard app request header as well, so later API requests
      // stay authenticated even when that cookie cannot be stored. The origin
      // fence installed below prevents this context from sending any request
      // outside the one evidence side.
      extraHTTPHeaders: { 'x-usernode-token': authToken },
    });
    // A side may never fetch from or navigate to its counterpart. Keeping the
    // origins in one input is an orchestration convenience, not a permission
    // for base and head to observe each other.
    const allowedOrigins = new Set([origin]);
    setupPhase = 'install_origin_fence';
    await installOriginFence(context, allowedOrigins, diagnostics);
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
  page.on('console', (message) => {
    if (message.type() === 'error' && diagnostics.consoleErrors.length < MAX_CONSOLE_ITEMS) {
      diagnostics.consoleErrors.push({
        message: safeDiagnosticText(message.text()),
        source: diagnosticLocation(message.location()?.url || '', origin),
      });
    }
  });
  page.on('pageerror', (error) => {
    if (diagnostics.pageErrors.length < MAX_CONSOLE_ITEMS) {
      diagnostics.pageErrors.push({ message: safeDiagnosticText(error.message) });
    }
  });
  page.on('requestfailed', (request) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(request.url()).origin === origin; } catch {}
    if (sameOrigin && diagnostics.failedRequests.length < MAX_CONSOLE_ITEMS) {
      diagnostics.failedRequests.push({
        location: diagnosticLocation(request.url(), origin),
        error: safeDiagnosticText(request.failure()?.errorText || '', 120),
      });
    }
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400 || diagnostics.httpErrors.length >= MAX_CONSOLE_ITEMS) return;
    const location = diagnosticLocation(response.url(), origin);
    if (location.sameOrigin) diagnostics.httpErrors.push({ status, location });
  });

  const stages = [];
  let motionCapture = null;
  let navigation = null;
  let failureLocatorSpecs = [];
  let failureStage = { phase: 'navigate_start' };
  try {
    emitEvent({ type: 'navigation_started', ...eventBase });
    const response = await page.goto(authorizedUrl(origin, sidePlan.startPath, authToken), {
      waitUntil: 'domcontentloaded', timeout: planContract.MAX_WAIT_MS,
    });
    navigation = {
      status: typeof response?.status === 'function' ? response.status() : null,
    };
    await settlePage(page, { motion });
    emitEvent({
      type: 'navigation_completed', ...eventBase,
      status: navigation.status,
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
      const durationMs = await executeAction(page, action, origin, network, authToken);
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
    await settlePage(page, { motion });
    failureStage = { phase: 'capture_checkpoint' };
    const contextPng = await page.screenshot({ type: 'png' });
    stages.push({ stage: '__checkpoint__', image: contextPng });

    failureStage = { phase: 'browser_diagnostics' };
    if (diagnostics.consoleErrors.length || diagnostics.pageErrors.length
        || diagnostics.failedRequests.length || diagnostics.blockedRequests.length) {
      throw new ReplayFailure(
        'browser_diagnostics',
        `${side} emitted browser errors, request failures, or attempted cross-origin traffic.`,
        diagnostics
      );
    }
    const result = {
      side, storyId: story.id, viewport: viewport.name, path: finalPath,
      actionResults, assertions, focusRect, contextPng, stages,
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
          if (input.publishArtifacts) {
            artifacts.push(
              { storyId: story.id, viewport: viewport.name, side: 'base', variant: 'focus', media: 'png', contentType: 'image/png', width: Math.round(crops.base.width * input.browser.deviceScaleFactor), height: Math.round(crops.base.height * input.browser.deviceScaleFactor), focusRect: crops.base, data: baseFocus },
              { storyId: story.id, viewport: viewport.name, side: 'head', variant: 'focus', media: 'png', contentType: 'image/png', width: Math.round(crops.head.width * input.browser.deviceScaleFactor), height: Math.round(crops.head.height * input.browser.deviceScaleFactor), focusRect: crops.head, data: headFocus },
              { storyId: story.id, viewport: viewport.name, side: 'base', variant: 'context', media: 'png', contentType: 'image/png', width: viewport.width * input.browser.deviceScaleFactor, height: viewport.height * input.browser.deviceScaleFactor, focusRect: base.focusRect, data: base.contextPng },
              { storyId: story.id, viewport: viewport.name, side: 'head', variant: 'context', media: 'png', contentType: 'image/png', width: viewport.width * input.browser.deviceScaleFactor, height: viewport.height * input.browser.deviceScaleFactor, focusRect: head.focusRect, data: head.contextPng },
            );
            if (story.replay.checkpoint.animation !== 'none') {
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
    args: CHROMIUM_ARGS,
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
  authorizedUrl,
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
