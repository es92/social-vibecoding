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
  // Before/after shot diagnostics are read-only and the handler requires the
  // proposal owner or an app manager. A connector needs this exact route to
  // see why shots were skipped or failed without infrastructure credentials.
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
  // recheck_change (#2779): re-run the checks on a proposal's CURRENT commit.
  // No code moves and no vote is touched — it is the same act as the "Re-run
  // checks" button, and submit_work's `recheck: true` already reaches it
  // through the update route. The handler refuses anyone but the owner or a
  // write-admin, and a proposal that is no longer open.
  { method: 'POST', pattern: '/api/sessions/:id/recheck' },
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

// ── Delegated grants (#2779) ───────────────────────────────────────────
//
// A delegated token is the platform's OWN agent acting for the user, and each
// kind gets its own exhaustive list — never the external list above, and
// never the CLI denylist. The same fail-closed rule holds: a route not named
// for that kind is refused, whatever the token's scopes say.
//
// `agent_mayor` — the Mayor of an agent session. Every read its tools make,
// the request writes the external list already carries, and the change
// lifecycle of the user's own native changes: create, promote, resume,
// re-check, sync with main, withdraw. What is here and NOT on the external
// list is exactly the three routes the classic dev chat's own buttons call,
// each owner-scoped by its handler; and every write a Mayor makes is one the
// user confirmed first (the token for it is minted at that moment and lives
// for one action). Still nothing that votes, merges, touches settings,
// secrets or membership.
const AGENT_MAYOR_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps' },
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  { method: 'POST', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'DELETE', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/issues' },
  { method: 'GET', pattern: '/api/me/active-sessions' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
  { method: 'GET', pattern: '/api/sessions/:id/spec' },
  { method: 'PATCH', pattern: '/api/sessions/:id/linked-issues' },
  // The change lifecycle (start_change, promote_change, recheck_change,
  // sync_change, withdraw_change). start_change names the change on the
  // create itself, so the rename route is not on this list.
  { method: 'POST', pattern: '/api/apps/:slug/sessions' },
  { method: 'POST', pattern: '/api/sessions/:id/promote' },
  { method: 'POST', pattern: '/api/sessions/:id/resume' },
  { method: 'POST', pattern: '/api/sessions/:id/recheck' },
  { method: 'POST', pattern: '/api/sessions/:id/sync-main' },
  { method: 'POST', pattern: '/api/sessions/:id/archive' },
]);

// `worker_read` — the coding agent inside one change's worker. It runs the
// repository's own code with a shell, so assume it can read its token: GETs
// only, and only what its six read tools need. The bearer chain additionally
// pins every `:slug` to the grant's app and every `:id` to a change in that
// app (see delegatedRouteBinding), so the worst a leaked token does is read
// one app the user can already see.
const WORKER_READ_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
]);

const DELEGATED_ALLOWED_ROUTES = Object.freeze({
  agent_mayor: AGENT_MAYOR_ALLOWED_ROUTES,
  worker_read: WORKER_READ_ALLOWED_ROUTES,
});

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

// The delegated twin of isConnectorApiRequest: the same canonical-target
// wall underneath, then the kind's own list. An unknown kind reaches nothing.
function isDelegatedApiRequest(kind, method, pathname) {
  const routes = Object.prototype.hasOwnProperty.call(DELEGATED_ALLOWED_ROUTES, kind)
    ? DELEGATED_ALLOWED_ROUTES[kind] : null;
  if (!routes || typeof method !== 'string' || typeof pathname !== 'string') return false;
  if (canonicalApiTarget(pathname) !== pathname) return false;
  const upper = method.toUpperCase();
  return routes.some((route) => route.method === upper && matchesPattern(pathname, route.pattern));
}

// The app and change a delegated request names, read off the matched route
// pattern so the bearer chain can hold a bound grant to them. `slug` is the
// `:slug` segment and `sessionId` the numeric `:id` segment; null when the
// route has neither. A non-numeric `:id` is reported as NaN, which no change
// matches.
function delegatedRouteBinding(kind, method, pathname) {
  const routes = DELEGATED_ALLOWED_ROUTES[kind] || [];
  const upper = String(method || '').toUpperCase();
  const route = routes.find((r) => r.method === upper && matchesPattern(pathname, r.pattern));
  if (!route) return null;
  const actual = pathname.split('/');
  const expected = route.pattern.split('/');
  const binding = { slug: null, sessionId: null };
  expected.forEach((segment, i) => {
    if (segment === ':slug') binding.slug = actual[i];
    if (segment === ':id') binding.sessionId = /^[1-9]\d{0,9}$/.test(actual[i]) ? Number(actual[i]) : NaN;
  });
  return binding;
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
  AGENT_MAYOR_ALLOWED_ROUTES,
  WORKER_READ_ALLOWED_ROUTES,
  canonicalApiTarget,
  isCliApiPath,
  isConnectorApiRequest,
  isDelegatedApiRequest,
  delegatedRouteBinding,
  isCliCredentialManagementSession,
};
