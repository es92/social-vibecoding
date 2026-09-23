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
  'credentials',
  'llm-grant',
  'llm-grants',
  'password',
  'secret-declaration-pr',
  'secrets',
  'wallet-change-password',
  'wallet-link',
]);
// Coding-agent model/preference routes are also credential-adjacent:
// a CLI bearer token must not set the default backend or list models
// under another user's key.
const DENIED_PREFIXES_EXTRA = Object.freeze([
  '/api/me/coding-agent',
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
      || DENIED_PREFIXES_EXTRA.some((prefix) => hasPrefix(lowerPathname, prefix))
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
//
// The demo-mode entries at the end of the list are the one deliberate
// exception to that first sentence. The comment above them says exactly what
// makes them safe, and tests/mcp-connector-policy.test.js pins it.
const CONNECTOR_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps' },
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  // A request's GitHub comments — the other half of its discussion, read by
  // prepare_work so a work order carries the requirements that landed in the
  // replies rather than only the opening line. Read-only, and the route
  // itself is already clipped and access-checked.
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  // Marking a request as being worked on, and handing it back (#1225). A
  // local coding agent has reached these two through the CLI's denylist
  // `api:access` since claims existed; a connector session — which is where
  // the agent that actually builds the thing increasingly lives — could not,
  // so its work was invisible on the board and two people could start the
  // same request without either seeing the other.
  //
  // On the list because a claim decides nothing: it is platform-local (no
  // GitHub write), it names only the CALLER (the route refuses a foreign
  // userId unless the caller is a write-admin), it expires on its own, and
  // clearing it is one call away. It is coordination data, not authority —
  // an issue holds many concurrent claims and holding one grants nothing.
  // release_request never sends the `userId` body the DELETE route accepts
  // from a write-admin, so a connector only ever clears its own claim.
  { method: 'POST', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'DELETE', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/issues' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
  { method: 'GET', pattern: '/api/sessions/:id/spec' },
  // Post-creation issue association (#2028). The route is owner-scoped for
  // connectors, accepts only bounded issue-number deltas, and changes no code
  // or vote. The tool uses the browser's same doorway instead of gaining a
  // parallel metadata writer.
  { method: 'PATCH', pattern: '/api/sessions/:id/linked-issues' },
  { method: 'GET', pattern: '/api/me/active-sessions' },
  // The proposal pipeline: submit_work turns a pushed branch into an
  // ordinary imported proposal, and the platform-build fallback runs an
  // unattended build and promotes its clone.
  { method: 'GET', pattern: '/api/apps/:slug/pr-import/preview' },
  { method: 'POST', pattern: '/api/apps/:slug/pr-import' },
  // Advancing a proposal that is already up for a vote (#1054), from a branch
  // in the author's own fork. Allowlisted because the connector is where the
  // agent that wrote the code lives — a failing check gates merge, and until
  // this route existed the cheapest possible fixer of its own failing test had
  // no way to land the fix. The route itself refuses everything that is not
  // the caller's own open proposal.
  { method: 'POST', pattern: '/api/apps/:slug/proposals/:id/update-from-fork' },
  // The proposal owner supplies a typed UI flow. The platform itself runs
  // the exact-revision replay and verifies the resulting media; this grants
  // no ability to publish a screenshot or declare evidence verified.
  { method: 'POST', pattern: '/api/apps/:slug/proposals/:id/evidence/plan' },
  // Evidence diagnostics are read-only and the handler requires the proposal
  // owner or an app manager. A connector needs this exact route to retrieve
  // the replay plan and trace without infrastructure credentials.
  { method: 'GET', pattern: '/api/apps/:slug/proposals/:id/evidence/diagnostics' },
  // Sharing work to the IN-PROGRESS area instead of putting it to a vote
  // (#1347). Allowlisted for the same reason as the route above: the agent
  // that wrote the code lives in the connector, and until this existed its
  // only destination was a group vote — so work still moving had to be either
  // invisible or prematurely up for review. The route creates a session owned
  // by the caller and hands it to the same fork-attribution gate every other
  // hand-off goes through; it can write nothing that is not the caller's own.
  { method: 'POST', pattern: '/api/apps/:slug/work/share-in-progress' },
  { method: 'POST', pattern: '/api/apps/:slug/issues/:number/headless-session' },
  { method: 'POST', pattern: '/api/sessions/:id/clone-headless' },
  { method: 'POST', pattern: '/api/sessions/:id/promote' },
  // submit_work's `propose: true` reopens a paused session before promoting
  // it — an external update usually lands on a paused one. Owner-scoped like
  // promote: the handler's probe and its resuming UPDATE both match
  // (id, user_id), so a connector can only ever reopen the caller's own
  // session (see the owner-scope tests beside promote's).
  { method: 'POST', pattern: '/api/sessions/:id/resume' },
  // Demo mode (routes/demo-mode.js): the one deliberate exception to the
  // note above, so it is worth being exact. These five let a connected agent
  // drive a RECORDING of the proposal flow: a synthetic partner proposes,
  // votes, and is reset between takes. Two of them do what nothing else on
  // this list does — demo/vote casts a vote and demo/reset moves an app's
  // main — and the reason they may is entirely the handler's gate, which the
  // policy tests pin: every one of these routes refuses unless the app is in
  // demo mode AND the caller is its creator AND a full platform admin (both
  // fences — never an admin's override on somebody else's app), and the
  // platform's own app can never be in demo mode. Through them a connector
  // reaches only an app its user owns and has switched into a mode whose
  // settings say a synthetic partner is acting on it. The general vote
  // route (/api/sessions/:id/vote) stays off this list, as it always has.
  { method: 'POST', pattern: '/api/apps/:slug/demo-mode' },
  { method: 'GET', pattern: '/api/apps/:slug/demo' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/propose' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/promote' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/vote' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/reset' },
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
