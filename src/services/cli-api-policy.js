'use strict';

const MAX_API_TARGET_BYTES = 2048;
const API_BASE = 'https://cli-api.invalid';
const DENIED_PREFIXES = Object.freeze([
  '/api/admin',
  '/api/app-llm',
  '/api/app-platform',
  '/api/app-storage',
  '/api/auth',
  '/api/cli',
  '/api/debug',
  '/api/iframe-token',
  '/api/internal',
  '/api/me/cli-tokens',
  '/api/node-status',
  '/api/v4',
]);
const DENIED_SEGMENTS = Object.freeze([
  'api-key',
  'llm-grant',
  'llm-grants',
  'password',
  'secret-declaration-pr',
  'secrets',
  'wallet-change-password',
  'wallet-link',
]);
const SECRET_DECLARATION_BRANCH_PREFIX = 'secret-declare/';

function hasPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function canonicalApiTarget(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || !value.startsWith('/')
      || value.startsWith('//')
      || Buffer.byteLength(value, 'utf8') > MAX_API_TARGET_BYTES
      || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value, API_BASE);
  } catch {
    return null;
  }
  if (url.origin !== API_BASE
      || url.hash
      || !url.pathname.startsWith('/api/')
      || url.pathname.includes('%')) {
    return null;
  }
  const lowerPathname = url.pathname.toLowerCase();
  const segments = lowerPathname.split('/');
  if (DENIED_PREFIXES.some((prefix) => hasPrefix(lowerPathname, prefix))
      || segments.some((segment) => DENIED_SEGMENTS.includes(segment))) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

function isCliApiPath(pathname) {
  return canonicalApiTarget(pathname) === pathname;
}

// ── Hosted MCP connector policy ────────────────────────────────────────
//
// The CLI's `api:access` is a DENYLIST: everything under /api/ except the
// prefixes above. That is the right shape for a credential the user holds
// in a checkout they control, and the wrong shape for a token a third-party
// chat product (Claude.ai, ChatGPT) holds on their behalf.
//
// Connector tokens are therefore governed by an exhaustive ALLOWLIST,
// fail-closed: a route that is not listed here is refused, so adding a new
// platform endpoint can never silently widen what a connector can reach.
// Each entry is a method plus a path pattern where `:param` matches exactly
// one non-empty segment.
//
// Note what is NOT here and must not be added casually: nothing that votes,
// merges, force-merges, withdraws, changes app settings or touches
// membership. A connector may describe apps, file a request, hand work to
// the user's own coding agent and turn the result into a proposal — the
// group still decides whether it ships.
const CONNECTOR_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps' },
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  // A request's GitHub comments — the other half of its discussion, read by
  // prepare_work so a work order carries the requirements that landed in the
  // replies rather than only the opening line. Read-only, and the route
  // itself is already clipped and access-checked.
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/issues' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
  { method: 'GET', pattern: '/api/sessions/:id/spec' },
  { method: 'GET', pattern: '/api/me/active-sessions' },
  // The proposal pipeline: submit_work turns a pushed branch into an
  // ordinary imported proposal, and the platform-build fallback runs an
  // unattended build and promotes its clone.
  { method: 'GET', pattern: '/api/apps/:slug/pr-import/preview' },
  { method: 'POST', pattern: '/api/apps/:slug/pr-import' },
  { method: 'POST', pattern: '/api/apps/:slug/issues/:number/headless-session' },
  { method: 'POST', pattern: '/api/sessions/:id/clone-headless' },
  { method: 'POST', pattern: '/api/sessions/:id/promote' },
]);

function matchesPattern(pathname, pattern) {
  const actual = pathname.split('/');
  const expected = pattern.split('/');
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) {
      if (!actual[i]) return false;
      continue;
    }
    if (expected[i] !== actual[i]) return false;
  }
  return true;
}

// A connector token may reach exactly the (method, path) pairs above — and
// only after the shared canonical-target check, so the denied prefixes and
// credential segments still apply as a second, independent wall.
function isConnectorApiRequest(method, pathname) {
  if (typeof method !== 'string' || typeof pathname !== 'string') return false;
  if (canonicalApiTarget(pathname) !== pathname) return false;
  const upper = method.toUpperCase();
  return CONNECTOR_ALLOWED_ROUTES.some(
    (route) => route.method === upper && matchesPattern(pathname, route.pattern)
  );
}

// Secret-declaration proposals use otherwise-generic session endpoints for
// voting, force-merging, withdrawal, and restoration. Those endpoints cannot
// be denied by pathname without also disabling ordinary PR workflows, so the
// route handlers use this immutable platform branch marker after loading the
// session. Browser requests are deliberately unaffected.
function isCliCredentialManagementSession(req, session) {
  return !!req?.cliAuthenticated
    && typeof session?.branch_name === 'string'
    && session.branch_name.startsWith(SECRET_DECLARATION_BRANCH_PREFIX);
}

module.exports = {
  MAX_API_TARGET_BYTES,
  DENIED_PREFIXES,
  DENIED_SEGMENTS,
  SECRET_DECLARATION_BRANCH_PREFIX,
  CONNECTOR_ALLOWED_ROUTES,
  canonicalApiTarget,
  isCliApiPath,
  isConnectorApiRequest,
  isCliCredentialManagementSession,
};
