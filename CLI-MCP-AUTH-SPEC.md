# Global CLI Authentication and Project-Local MCP

## Status

Implementation specification.

This feature lets a user authenticate a project-local CLI/MCP integration from
Codex or Claude Code with a browser approval flow:

```text
Coding agent → project-local MCP → global Homeroom API
                                ↘ device authorization in browser
```

This is global platform authentication. It is not dApp authentication and it
must not use iframe identity tokens.

## User experience

From a trusted checkout, the coding agent has a project-local MCP configured.
The user asks it to perform an operation that requires Homeroom access.

If the user is already authenticated locally, the MCP calls the global API.

If not, the MCP reports a structured `login_required` error. The agent runs:

```bash
node ./tools/social-vibecoding login
```

The command:

1. Requests a device authorization from Homeroom.
2. Prints a complete one-click verification URL and the display code.
3. Opens the complete URL when possible.
4. Waits for the user to authenticate and approve access.
5. Exchanges the approved device code for a CLI access token.
6. Stores the credential in the user's local credential store.
7. Exits successfully so the agent can retry the original MCP tool call.

The browser approval page uses the existing Homeroom account session. A user
who is already logged in proceeds directly to confirmation; otherwise the page
sends them through login and returns them to that request.

The token is never placed in the repository and is never returned to the
browser page.

## Scope

Included:

- Global device authorization endpoints on the platform.
- Browser approval page.
- CLI login, logout, status, and token-expiry behavior.
- Project-local MCP server launched by Codex or Claude Code over stdio.
- Global RPC authentication using a CLI bearer token.
- Token revocation, expiry, rate limits, and audit events.

Excluded:

- Per-dApp credentials.
- Reuse of iframe JWTs.
- Reuse of the browser `session` cookie.
- Changes to the native Homeroom bridge.
- OAuth client registration for third-party applications.

## Credential model

Use opaque random tokens, not JWTs.

The platform stores only SHA-256 hashes of tokens. The raw access token is
returned to the CLI once and stored only in the user's local credential store.

Secret formats are exact:

```text
device_code  = "svdev_" + base64url_without_padding(32 random bytes)
access_token = "svcli_" + base64url_without_padding(32 random bytes)
```

The resulting wire values are 49 ASCII characters and match
`^svdev_[A-Za-z0-9_-]{43}$` or `^svcli_[A-Za-z0-9_-]{43}$`. Validation also
base64url-decodes and re-encodes the suffix to require its canonical unpadded
form.

The server hashes the UTF-8 bytes of the complete prefixed value and stores the
lowercase 64-character SHA-256 hex digest. Generation uses the operating
system's cryptographically secure random source. A unique-hash collision
causes regeneration rather than an error response. Middleware rejects malformed
prefixes or lengths before database lookup without logging the supplied value.
Collision and database-error handling must not log SQL parameters or driver
error details that contain the colliding hash or user code.

The initial release has one server-defined first-party client:

```text
client_id:   social-vibecoding-cli
client_name: Homeroom CLI
```

The device-code endpoint does not accept a caller-supplied client identity.
Third-party client registration remains out of scope.

Required baseline schema (an equivalent idempotent migration is acceptable):

```sql
CREATE TABLE IF NOT EXISTS cli_device_authorizations (
  id BIGSERIAL PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE
    CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code TEXT NOT NULL UNIQUE
    CHECK (
      user_code = UPPER(user_code)
      AND user_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'
    ),
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CHECK (
      scopes = ARRAY['rpc:identity:read']::TEXT[]
      OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
    ),
  request_ip INET NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'approved', 'rejected', 'cancelled', 'consumed'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
    CHECK (expires_at = created_at + INTERVAL '10 minutes'),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  CHECK (
    (
      status = 'pending'
      AND user_id IS NULL
      AND approved_at IS NULL
      AND rejected_at IS NULL
      AND cancelled_at IS NULL
      AND consumed_at IS NULL
    )
    OR (
      status = 'approved'
      AND user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND rejected_at IS NULL
      AND cancelled_at IS NULL
      AND consumed_at IS NULL
    )
    OR (
      status = 'rejected'
      AND user_id IS NOT NULL
      AND approved_at IS NULL
      AND rejected_at IS NOT NULL
      AND cancelled_at IS NULL
      AND consumed_at IS NULL
    )
    OR (
      status = 'cancelled'
      AND user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND rejected_at IS NULL
      AND cancelled_at IS NOT NULL
      AND consumed_at IS NULL
    )
    OR (
      status = 'consumed'
      AND user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND rejected_at IS NULL
      AND cancelled_at IS NULL
      AND consumed_at IS NOT NULL
    )
  ),
  CHECK (approved_at IS NULL OR approved_at >= created_at),
  CHECK (rejected_at IS NULL OR rejected_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= approved_at),
  CHECK (consumed_at IS NULL OR consumed_at >= approved_at),
  CHECK (approved_at IS NULL OR approved_at < expires_at),
  CHECK (rejected_at IS NULL OR rejected_at < expires_at),
  CHECK (cancelled_at IS NULL OR cancelled_at < expires_at),
  CHECK (consumed_at IS NULL OR consumed_at < expires_at),
  CHECK (
    (last_polled_at IS NULL AND poll_count = 0)
    OR
    (last_polled_at IS NOT NULL
     AND last_polled_at >= created_at
     AND poll_count > 0)
  )
);

CREATE TABLE IF NOT EXISTS cli_access_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL
    CHECK (token_hint ~ '^svcli_…[A-Za-z0-9_-]{4}$'),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) <= 2
      AND scopes <@ ARRAY['rpc:identity:read', 'api:access']::TEXT[]
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at = created_at + INTERVAL '30 days'),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS cli_device_authorizations_expiry_idx
  ON cli_device_authorizations (expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_ip_state_idx
  ON cli_device_authorizations (request_ip, status, expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_state_expiry_idx
  ON cli_device_authorizations (status, expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_user_idx
  ON cli_access_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cli_access_tokens_expiry_idx
  ON cli_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_revoked_idx
  ON cli_access_tokens (revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS cli_auth_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'authorization_started',
      'authorization_approved',
      'authorization_rejected',
      'authorization_cancelled',
      'token_issued',
      'token_used',
      'token_revoked'
    )),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_authorization_id BIGINT,
  access_token_id BIGINT,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CHECK (
      (
        event_type IN ('token_used', 'token_revoked')
        AND cardinality(scopes) <= 2
        AND scopes <@ ARRAY['rpc:identity:read', 'api:access']::TEXT[]
      )
      OR
      (
        event_type NOT IN ('token_used', 'token_revoked')
        AND (
          scopes = ARRAY['rpc:identity:read']::TEXT[]
          OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
        )
      )
    ),
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (
      (event_type = 'token_used'
       AND outcome IN ('scope_authorized', 'insufficient_scope'))
      OR
      (event_type <> 'token_used' AND outcome = 'success')
    ),
  metadata JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (
    (event_type IN (
       'authorization_started',
       'authorization_approved',
       'authorization_rejected',
       'authorization_cancelled'
     ) AND device_authorization_id IS NOT NULL)
    OR
    (event_type = 'token_issued'
     AND device_authorization_id IS NOT NULL
     AND access_token_id IS NOT NULL)
    OR
    (event_type IN ('token_used', 'token_revoked')
     AND access_token_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS cli_auth_audit_events_time_idx
  ON cli_auth_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_user_idx
  ON cli_auth_audit_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_actor_idx
  ON cli_auth_audit_events (actor_user_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_device_transition_uidx
  ON cli_auth_audit_events (event_type, device_authorization_id)
  WHERE event_type IN (
    'authorization_started',
    'authorization_approved',
    'authorization_rejected',
    'authorization_cancelled'
  );
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_token_transition_uidx
  ON cli_auth_audit_events (event_type, access_token_id)
  WHERE event_type IN ('token_issued', 'token_revoked');

COMMENT ON TABLE cli_device_authorizations IS 'staging:private';
COMMENT ON TABLE cli_access_tokens IS 'staging:private';
COMMENT ON TABLE cli_auth_audit_events IS 'staging:private';
```

The device code is short-lived and single-use. Access tokens must initially
have a 30-day lifetime. The initial release has no refresh token and performs
no automatic refresh. An expired token requires a new explicit device login.
`expires_at` must never be null.

All server-side expiry checks use the database's fresh wall clock. A device
request or access token is expired when
`clock_timestamp() >= expires_at`; approval and exchange recheck with a fresh
value after acquiring any row lock, rather than relying on PostgreSQL's
transaction-start `CURRENT_TIMESTAMP`. Status and protected-RPC code use the
same boundary.

`token_hint` is exactly the literal `svcli_…` followed by the access token's
final four base64url characters, such as `svcli_…A1B2`. Settings responses may
return the hint, dates, client ID, and scopes, but never `token_hash`.
Every JSON timestamp in this specification is a UTC RFC 3339 string.

New device grants request this exact scope set:

```text
rpc:identity:read
api:access
```

`rpc:identity:read` authorizes exactly one route:

```http
GET /api/cli/rpc/me
```

The route returns the current platform identity loaded from `users` using the
token row's `user_id`; it never accepts a user ID from the request. Its initial
response is `{ "user": { "id": ..., "username": "..." } }`.
It accepts only the exact `GET` path with no trailing slash, query parameters,
or request body. `HEAD`, `OPTIONS`, and all other methods are rejected rather
than inheriting Express's automatic `HEAD` handling.

`api:access` authenticates the token's user to the platform's existing
user-facing JSON API. It does not bypass any app visibility, ownership, role,
lock, quota, or endpoint-specific authorization check. The bridge accepts
canonical same-origin `/api/` paths generically rather than maintaining an
endpoint registry, but it denies credential-management, internal service,
application-token, topochain, debug, admin, iframe-token, and other
non-user-facing namespaces. Platform operations such as creating/promoting an
app session may internally create a GitHub PR; the client never calls GitHub
directly.

The device-code endpoint rejects unknown, reordered, missing, or additional
scopes with `400 invalid_scope`; it never silently normalizes them. Every new
device request and token carries the exact two-scope set. The access-token and
audit schemas retain the identity-only subset solely for pre-expansion tokens;
using one against the generic API returns `403 insufficient_scope` and causes
the external login workflow to request fresh browser approval.

User codes use the 32-symbol uppercase alphabet shown in the table constraint
and the canonical `XXXX-XXXX` form. On input, the server removes ASCII
whitespace and hyphens, uppercases the value, validates exactly eight allowed
symbols, and reinserts the hyphen before lookup. It rejects raw input longer
than 32 UTF-8 bytes before normalization. Generation and storage use only
this canonical form. This makes the database's case-sensitive unique
constraint safe and makes case-insensitive input deterministic. A user-code
unique-constraint collision causes bounded regeneration; if regeneration is
exhausted, creation fails without returning either colliding code.

Expired unconsumed requests (`pending` or `approved`) are deleted 24 hours
after `expires_at`. Consumed, rejected, and account-recovery-cancelled device
requests are deleted 30 days after `consumed_at`, `rejected_at`, or
`cancelled_at`. Deleting a user cascades to any device request already bound to
that user and every one of that user's access-token rows, regardless of the
normal retention window; the independent audit record remains with user/actor
references set null.
Access-token rows are deleted 90 days after they first become inactive through
expiry or revocation—specifically, 90 days after
`LEAST(expires_at, COALESCE(revoked_at, expires_at))`—so status and audit
correlation continue to work during that window. A scheduled cleanup job
performs this retention.

`cli_auth_audit_events` is the authoritative security audit trail; the
best-effort product-analytics `events` service must not be used for this
purpose. Device and token IDs in the audit table deliberately have no foreign
keys, so cleanup of credential rows cannot erase their history. Audit rows are
retained for at least one year. The start, approve, reject, cancel, issue, and
revoke events are inserted in the same transaction as their corresponding state
changes; if an audit insert fails, that state change rolls back. For a known active
token reaching a protected RPC, bearer middleware inserts `token_used` with
allowlisted route and method metadata and outcome `scope_authorized` or
`insufficient_scope`. If that insert fails, it returns `503` instead of
dispatching the RPC or returning the scope decision. Audit metadata never
includes request bodies, raw codes, tokens, token hashes, cookies, or
authorization headers.

`user_id` is the affected credential owner. `actor_user_id` is the
authenticated approving/revoking user, the token owner for token use, or the
admin who initiated an account-recovery reset; it is null only when no actor
exists. Token issuance carries forward the browser approver as actor even
though the polling request is unauthenticated. User deletion nulls either
reference without deleting the event.

After any required row lock is acquired, a transition captures one fresh
`clock_timestamp()` and uses it for the state timestamp, related
`created_at`/`expires_at` calculation where applicable, and audit
`occurred_at`. The SQL defaults are defensive only; lock-waiting transactions
must not inherit stale transaction-start times.

The metadata allowlist is exact: start/approve/reject/issue events store `{}`,
`authorization_cancelled` stores only
`{ "reason": "account_recovery" }`, `token_revoked` stores only
`{ "reason": "self" }`,
`{ "reason": "settings" }`, or `{ "reason": "account_recovery" }`, and
`token_used` stores exactly the keys `method` and `route`. The identity RPC
stores `{ "method": "GET", "route": "/api/cli/rpc/me" }`; generic API use
stores one of the five allowed CLI methods (`GET`, `POST`, `PUT`, `PATCH`, or
`DELETE`) and the exact canonical user-facing API pathname selected by the
generic API policy, without its query string. The route is at most 2,048
characters and starts with `/api/`.
Device and access-token row IDs belong only in their dedicated audit columns.
Adding any metadata key requires a schema/security review. The partial unique
indexes make each actual state transition exactly once in the authoritative
trail; usage events remain repeatable.

All three tables are private platform-authentication state. The table comments
make staging database clones truncate them. The implementation must also add
all three names to `src/services/debug-access.js` `DENIED_TABLES`, so
production-debug SQL cannot read pending user codes, credential hashes, token
hints, request IPs, or the security audit trail. The schema/privacy tests must
keep those comments and deny-list entries in sync.

## Device authorization API

All paths below are platform routes, not child-app routes.

Each CLI-auth JSON POST uses a route-scoped parser with a 4 KiB body limit.
Malformed JSON or an oversized body returns `400 invalid_request` or `413`
respectively, without logging the body; the generic application parser must
not consume these requests first.

They are enabled only on a deployment's configured canonical production origin
and in explicit local-development mode. A self-app staging preview
(`USERNODE_ENV=staging`) must return `404` for `/cli/authorize`, every
`/api/cli/*` route, and `/api/me/cli-tokens*`, and must not mint, validate,
list, or revoke CLI credentials. This prevents a staging browser session
derived from iframe identity from becoming a global CLI authority. End-to-end
development uses local mode with a separate local origin and database.

The staging gate is mounted before CLI-auth body parsers, cookie/bearer
authentication, and static fallback. It matches every method on the exact
surfaces above and returns the same `404` without querying auth tables, so an
ambient staging session cannot change either behavior or timing.

The enablement decision comes from validated deployment configuration, never
the request host. Enabling the feature without a valid canonical origin is a
startup error, and the production value must equal the CLI's compiled-in
`production` profile origin. Local mode must be an explicit environment mode,
not something inferred merely from a loopback `Host` header.

### Start authorization

```http
POST /api/cli/device/code
Content-Type: application/json

{
  "scopes": ["rpc:identity:read", "api:access"]
}
```

Response:

```json
{
  "device_code": "svdev_...",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://usernode.example/cli/authorize",
  "verification_uri_complete": "https://usernode.example/cli/authorize#code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

Success is `200`. In the same transaction, the server sets `created_at` from
the database clock, `expires_at = created_at + 600 seconds`, stores the
request IP and requested scope, and inserts `authorization_started`.

The server assigns the fixed first-party client identity. A request containing
`client_id` or `client_name` is rejected with
`400 { "error": "invalid_request" }`. The endpoint requires a JSON object
whose only member is `scopes`, and that member must be exactly
`["rpc:identity:read", "api:access"]`; missing, reordered, duplicate,
additional, wrongly typed, or unknown members are rejected rather than
normalized. The
server stores only the hash of `device_code`. `user_code` is human-readable,
case-insensitive, non-ambiguous, canonicalized as described above, and
rate-limited.

The response's `verification_uri` is exactly the configured canonical origin
plus `/cli/authorize`. `verification_uri_complete` is exactly that URI plus
`#code=` and the canonical user code. The fragment is not sent in the initial
HTTP request or in a referrer.

`verification_uri` and browser-CSRF origin checks use the deployment's
configured canonical origin, never `Host`, `X-Forwarded-Host`, `Origin`, or
other request-controlled headers.

The endpoint is limited per source IP and by a configurable global ceiling.
The initial creation limiter is a token bucket refilling at 10 requests per
minute per IP with capacity 20. No IP may own more than 10 live unconsumed
requests (`pending` or `approved` and not expired), and no deployment may have
more than 10,000 such requests platform-wide. Admission for both live limits
must be atomic across server processes (for example, by a shared limiter or a
database transaction/advisory lock around count-and-insert), not a racy
application-side count. Exceeding a limit returns `429` with `Retry-After`.
Deployments may lower these limits.

`request_ip` is the canonical address used for those controls and is retained
only with the short-lived private device row. It comes from the framework's
resolved client address under an explicit trusted-proxy configuration; the
route must not trust arbitrary `X-Forwarded-For` or similar headers.

### Browser approval

```http
GET /cli/authorize
```

This page is publicly reachable so the CLI can direct the user to it. It must:

1. Serve only the approval-page shell before authentication; it does not query
   or reveal device-request state.
2. Accept the initiating CLI's canonical user code only from the exact
   single-value `#code=` fragment, remove the fragment from browser history
   before any network request, and never read a code from the query string.
3. Require the normal platform session before loading request details or
   approving.
4. Display the canonical user code, server-defined client name, and requested
   scopes on the confirmation view.
5. Warn: "Approve only if this code matches the Homeroom CLI or
   coding-agent session you started."
6. Use one generic invalid/expired response for failed code lookup.
7. Require an explicit **Authorize** click after showing the confirmation view.
8. Bind the authorization to `req.user.id`.
9. Use the CSRF controls below on the approval POST.
10. Refuse framing and third-party active content.

After loading, the page requests the cookie-session-authenticated metadata
endpoint:

```http
GET /api/cli/device/approval?user_code=ABCD-EFGH
```

It returns only the canonical user code, fixed client display name, scopes,
and expiry for a valid request. A pending request may be viewed by the
authenticated user who possesses its code; an approved request may be viewed
again only by its bound user. Rejected, cancelled, consumed, or expired
requests and an approved request presented by a different user all receive the
same generic invalid/expired result. If the endpoint returns `401`, the page
stores the fragment-supplied code in same-origin `sessionStorage` and starts
the login-return flow below. It clears that temporary value after approval,
rejection, invalid/expired lookup, or page expiry; it never uses
`localStorage`.

The metadata response is `200`; its generic invalid/expired result is
`404 { "error": "invalid_or_expired_code" }`. A successful first or idempotent
approval/rejection POST returns `204`; an opposite decision by the bound user
returns `409 { "error": "decision_conflict" }`.

If there is no platform session, the page redirects to:

```text
/login.html?return_to=%2Fcli%2Fauthorize
```

The login implementation honors a relative value whose PATH is on a short
allowlist: `/cli/authorize` and the MCP consent path `/connect/authorize`.
It resolves the value against its own origin and matches `url.pathname`, so
absolute, protocol-relative, and otherwise off-origin values are discarded.

The QUERY STRING is preserved, because the MCP consent request is carried in
one — client id, redirect uri, PKCE challenge and state — and an exact-string
allowlist could not have carried it. The FRAGMENT is always discarded. That is
a normalisation and not a security boundary: this page takes its launch code
from a fragment on first arrival but carries it across a sign-in in
`sessionStorage`, and the consent page never reads a fragment at all, so a
forwarded one would be a value nothing reads.

After login it returns to the approval page, which restores the launch code
from `sessionStorage`.

Approval endpoint:

```http
POST /api/cli/device/approve
Content-Type: application/json

{ "user_code": "ABCD-EFGH", "decision": "approve" }
```

The metadata endpoint accepts exactly one `user_code` query value. The POST
accepts exactly the two string members shown, with `decision` equal to
`approve` or `reject`; missing, repeated, additional, or wrongly typed input is
`400 invalid_request`. The confirmation page labels these explicit controls
**Authorize** and **Cancel**.

The approval endpoint is cookie-session authenticated. It requires
`Content-Type: application/json`, requires an `Origin` header exactly equal to
the configured platform origin in every enabled environment, rejects a present
`Sec-Fetch-Site` value other than `same-origin`, and does not enable
cross-origin CORS. These checks, together with the existing `SameSite=Lax`
session cookie, are the CSRF defense for this endpoint.

The page response sets a restrictive Content Security Policy containing
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors
'none'`, plus `Referrer-Policy: no-referrer` and
`X-Content-Type-Options: nosniff`. It uses external same-origin scripts and
styles, with no inline or third-party active content. The confirmation
controls must not be renderable in an iframe.

Metadata lookup and approval attempts share limits per IP and authenticated
user, initially 10 per minute for each key. Invalid, expired, or already
consumed codes return the same generic browser response.
The IP half runs on those exact paths before cookie-session database lookup;
the user half runs after `req.user` is established. This early guard does not
make either endpoint public or bypass its session requirement.

State changes use a row lock or conditional update. The valid transitions are:

```text
pending  → approved
pending  → rejected
approved → cancelled  (account recovery only)
approved → consumed   (token endpoint only)
```

Repeating the same approve or reject decision by the same authenticated user
returns success without changing the bound user. A different user receives the
generic invalid/expired response. An opposite decision after a terminal
browser decision returns `409 decision_conflict`. Expired or consumed requests
cannot transition; a cancelled request is terminal. Rejection or cancellation
causes future polling to stop.

The initial approve or reject transition atomically stores the authenticated
`user_id` and the corresponding `approved_at` or `rejected_at` timestamp.
Only that first effective transition emits its approval or rejection audit
event; an idempotent repeat does not create a second transition event.

### Poll for token

```http
POST /api/cli/device/token
Content-Type: application/json

{
  "device_code": "svdev_..."
}
```

This endpoint also requires a JSON object with exactly the one string member
`device_code`. Structural or content-type errors return `invalid_request`; a
correctly shaped but malformed or unknown code returns the same
`expired_token` response without a database lookup for malformed input.

Responses:

- `200`: `{ "access_token": "svcli_...", "token_type": "Bearer", "scope": "rpc:identity:read api:access", "expires_in": 2592000, "expires_at": "..." }`
- `400 authorization_pending`: approval has not happened.
- `400 slow_down`: polling is too frequent.
- `400 access_denied`: user rejected the request or account recovery cancelled
  an approved request.
- `400 expired_token`: device authorization expired or was consumed.

Error responses use a JSON body of the form:

```json
{ "error": "authorization_pending" }
```

The CLI waits at least the returned `interval` between polls. On `slow_down`,
it increases the interval by five seconds for the rest of that login attempt.
For `429`, it honors a valid `Retry-After` in addition to the active interval.
Retryable transport errors and `5xx` responses use bounded exponential backoff
with jitter. Certificate/hostname validation, redirect, response-size, or
protocol-shape errors are non-retryable and fail immediately. All waits are
capped by the device request's expiry and no recovery path polls faster than
the active interval.

The initial wait also applies before the first poll. Server enforcement treats
`created_at` as the prior poll time when `last_polled_at` is null.

Every known-device poll serializes the check and update of `last_polled_at` and
`poll_count`, including while the request is still pending. Concurrent polls
therefore cannot both pass the interval check. Unknown device hashes are
covered by the per-IP poll limiter.

The initial token-endpoint IP limiter is a token bucket refilling at 120
requests per minute with capacity 30. The per-device minimum begins at the
returned five-second interval and is enforced from the persisted polling
fields, so it is shared across processes. Limit state uses the same trusted
client-IP derivation as device creation.

After locking a known row, the endpoint applies decisions in this order:
expiry, terminal state (`rejected`, `cancelled`, or `consumed`), minimum poll
interval, then pending or approved handling. Rejected/cancelled maps to
`access_denied`, while consumed maps to `expired_token`. Thus a request that
observes a row consumed by another exchange returns `expired_token`, not
`slow_down`; a too-early request against a still-pending or approved row
returns `slow_down`.

When approved, token issuance and device-request consumption happen in one
database transaction. After the nonlocking approved-row read and per-user lock
described below, the transaction locks the device row with
`SELECT ... FOR UPDATE`, rechecks expiry, user, and state, inserts one
access-token row with
`expires_at = created_at + 2,592,000 seconds`, inserts `token_issued`, and
marks the request consumed before commit. A concurrent second poll must block
and then receive `expired_token`. The raw access token is returned only after
commit and exactly once.

### Revoke token

Add cookie-session-authenticated Settings endpoints:

```http
GET    /api/me/cli-tokens
DELETE /api/me/cli-tokens/:id
```

The list query is restricted to `user_id = req.user.id` and never returns a
token hash. It uses stable `(created_at, id)` keyset pagination, newest first,
with default `limit=50`, maximum 100, and an opaque validated `cursor`; no
other query fields are accepted. The response is
`{ "tokens": [...], "next_cursor": "..." }`, omitting or nulling
`next_cursor` on the final page. Each item returns only `id`, `token_hint`,
`client_id`, `scopes`, `created_at`, `last_used_at`, `expires_at`,
`revoked_at`, and the derived `valid`, `expired`, or `revoked` status. `id` is
serialized as a canonical decimal string so JavaScript never loses `BIGINT`
precision.

Deletion is an idempotent revocation update restricted by both token ID and
`req.user.id`; a nonexistent or another user's ID is returned as
`404`, while the first and repeated deletes of the user's retained row return
`204`. The `:id` parameter must be a canonical positive base-10 `BIGINT`
string; malformed or out-of-range input is `400 invalid_request` and is never
interpolated into SQL. DELETE accepts no query parameters or request body. The
Settings DELETE uses the same Origin and
`Sec-Fetch-Site` checks as browser approval. List and delete share an initial
limit of 60 requests per minute per authenticated user, with `429` and
`Retry-After` on excess.

Also add bearer-token self-service endpoints for the CLI:

```http
GET    /api/cli/token/status
DELETE /api/cli/token/current
Authorization: Bearer svcli_...
```

These two endpoints hash the supplied token and may look up an expired or
revoked row. Neither accepts query parameters or a request body. Status
returns only:

```json
{
  "status": "valid",
  "client_id": "social-vibecoding-cli",
  "scopes": ["rpc:identity:read", "api:access"],
  "created_at": "...",
  "expires_at": "..."
}
```

`status` is one of `valid`, `expired`, or `revoked`: a non-null `revoked_at`
takes precedence, otherwise the exact expiry boundary determines `expired`.
An unknown token returns `401 { "error": "invalid_token" }`. Self-revocation
sets `revoked_at` for the matching row and returns `204`; it is idempotent,
including for an already expired or revoked row. It never accepts a token ID
or user ID from the client.

The first effective Settings or self-revocation update and its
`token_revoked` audit event commit in one transaction. Repeating revocation of
an already revoked retained row succeeds without changing `revoked_at` or
inserting another transition event. Settings uses reason `settings`,
self-revocation (including CLI logout or compensating cleanup) uses reason
`self`, and both record the credential owner as subject and actor.

Ordinary browser logout and authenticated password changes keep independent
CLI credentials active. In contrast, existing account-recovery paths that
invalidate every browser session—admin password reset and wallet-proven
password reset—must also cancel every unexpired approved device request and
revoke every still-active CLI token for that user.
The password update, session invalidation/new recovery session where
applicable, device/token updates, one `authorization_cancelled` row per
affected device request, and one `token_revoked` row per affected token commit
in one database transaction; any audit failure rolls the recovery transaction
back. Those events use reason `account_recovery` and record the admin as actor
for admin reset or the recovered user as actor for wallet reset. Future “log
out all sessions” or account-compromise recovery flows must use the same
helper. Individual browser-session logout does not.

Approval, approved-device exchange, and account recovery share a
transaction-scoped advisory lock keyed by `user_id`, always acquired before
locking device/token rows. Approval revalidates that its cookie session still
exists after acquiring this lock. Exchange first reads the approved row to
learn its bound user, acquires the user lock, then locks/rechecks the device
row. Account recovery acquires the same user lock before deleting sessions,
cancelling devices, or selecting tokens. Therefore every race orders cleanly:
an exchange committed first is seen and revoked by recovery; recovery committed
first makes exchange return `access_denied`; and an in-flight approval cannot
re-authorize from a session that recovery just deleted.

Also provide:

```bash
social-vibecoding logout
social-vibecoding auth status
```

`logout` treats an environment credential and every persisted copy for the
selected origin as separate targets. It de-duplicates them if their raw values
are equal and attempts to revoke each distinct token. A persisted copy is
removed only after the server confirms that its value is revoked, expired, or
invalid. If the server is unreachable, the CLI retains that persisted copy so
revocation can be retried, exits nonzero, and warns that the remote token may
still be active.

Each distinct target has its own recorded outcome. A success for one target
never causes another target's persisted record to be removed; any partial
failure produces a nonzero exit after all safe revocation attempts have
finished.

An environment-provided token cannot be removed from the parent environment.
After confirmed revocation, the CLI tells the user to unset it and restart any
already running MCP process that inherited it. On a network failure it says
that the environment token may remain active and exits
nonzero. `logout --local-only` is the explicit recovery escape hatch: it
removes only the persisted copies for the selected origin without contacting
the server and warns that each server-side token remains active until expiry
or Settings revocation.

## CLI behavior

The CLI must have one executable with subcommands:

```text
social-vibecoding login
social-vibecoding logout
social-vibecoding auth status
social-vibecoding auth server add <profile> <origin>
social-vibecoding auth server use <profile>
social-vibecoding auth server list
social-vibecoding auth server remove <profile>
social-vibecoding codex setup [--profile <name>] [--forward-env-token]
social-vibecoding claude setup [--profile <name>]
social-vibecoding mcp
```

### Server selection and credential identity

The CLI has two immutable built-in profiles: `production` for the production
platform origin, and `local` for exactly `http://localhost:3000`. Other
self-hosted origins and local-development origins on a different port are added
to the user-level configuration with `auth server add`; arbitrary commands do
not accept a raw `--server` argument. Profile names must match
`^[a-z0-9][a-z0-9_-]{0,31}$`.

`login`, `logout`, `auth status`, and `mcp` accept `--profile <name>`. Without
it they use the user-level default selected by `auth server use`, falling back
to `production`. The built-in `local` profile is selectable but is not the
default. A repository-local MCP configuration may name a profile, but the name
resolves only through the user's configuration or the immutable built-ins; a
repository cannot define or replace its origin. The immutable `production` and
`local` profiles cannot be removed or overwritten.

User-level server configuration is stored outside the repository at
`~/.config/social-vibecoding/config.json` on POSIX hosts. Here `~` means the
login account's home directory resolved through the operating-system account
API, not a repository-controlled `HOME`, `XDG_CONFIG_HOME`, or command-line
override. Windows uses the per-user application-data known folder resolved by
the OS API. The directory and file use mode `0700`/`0600` on POSIX and an
equivalent current-user-only ACL on Windows:

```json
{
  "version": 1,
  "default_profile": "production",
  "profiles": {
    "lab": { "origin": "https://lab.usernode.example" }
  },
  "credential_backends": {}
}
```

Profile mutations are fail-safe:

- adding an unused name succeeds; adding the same name and origin is
  idempotent, while attempting to retarget an existing name is rejected;
- `auth server use` requires an existing profile;
- `production`, `local`, and the current default profile cannot be removed; and
- removing the last profile for an origin is rejected while any persisted
  credential copy or backend recovery marker for that origin exists. The user
  must revoke/remove that state first. Removing a profile never silently
  removes a credential.

A server origin:

- is serialized with standard URL-origin rules as
  `scheme://lowercase-host[:non-default-port]`, with no credentials, path,
  query, or fragment; input may have only an empty or root (`/`) path, and the
  stored form has no trailing slash;
- must use HTTPS, except `http://localhost`, `http://127.0.0.1`, and
  `http://[::1]` in development;
- must not be sourced or overridden by a repository file;
- is shown during login when it is not the compiled-in production origin.

CLI API requests do not follow redirects at all; any `3xx` response is an
error. The CLI validates that `verification_uri` is exactly the selected
profile's canonical origin plus `/cli/authorize` and that
`verification_uri_complete` is exactly the same URI with a `#code=` fragment
matching the separately returned canonical user code. It prints and opens only
that validated complete URI. It sends the device code and bearer token only to
the selected origin.

Every API call has a bounded initial connect timeout of 10 seconds, total
request timeout of 30 seconds, and response-body limit of 64 KiB; deployments
may lower them. Poll request deadlines are additionally capped by the device
expiry. The CLI parses only the documented JSON shape and safe error code and
never copies an arbitrary server response body into logs, MCP output, or an
exception that could echo credentials.

Credential lookup order:

1. `SOCIAL_VIBECODING_TOKEN` plus `SOCIAL_VIBECODING_SERVER` for automation.
2. The persisted backend recorded for the canonical origin in
   `config.json.credential_backends`.

Backend values are `native` or `file`; internal crash-recovery states
`native-pending` and `file-pending` may exist only while a write is being
completed or recovered. For an origin with no entry or credential, the first
login chooses native only after a successful capability probe. A definitive
“not supported/configured” result chooses the fallback file; a lock,
permission denial, timeout, or other ambiguous native-store error aborts
without selecting file.

Before reporting persisted state as `missing`, the CLI reconciles the marker
and stores under the state lock. A final backend marker with no corresponding
record is `credential_store_inconsistent`, not permission to create another
token; recovery is Settings plus the explicit warning path of
`logout --local-only`. If a record exists without a marker, the CLI adopts it
only after proving the other backend empty. An inaccessible possible backend
or two differing records fails closed and never becomes `missing`.

If `SOCIAL_VIBECODING_TOKEN` is set, `SOCIAL_VIBECODING_SERVER` is mandatory.
The server value is normalized with the same origin rules and must exactly
match the selected profile's origin. A missing or mismatched value is a fatal
configuration error before any network request; the CLI does not fall through
to persisted credentials. Environment credentials are never persisted.

`login` refuses to start a device flow while an environment token is present,
because any newly persisted token would remain shadowed. It reports the
environment credential's status when possible and tells the user to unset or
replace the variable. Other commands always report which credential source
(`environment`, `native-store`, or `fallback-file`) they used.

Native credential-store entries use service `social-vibecoding` and the
canonical server origin as the account key. Each native secret is a versioned
JSON record containing the token and the same non-secret metadata as the
fallback entry, so expiry checks do not require extracting information from
the opaque token. The fallback file at
`<user-config-directory>/credentials.json` is versioned and keyed by canonical
server origin:

```json
{
  "version": 1,
  "servers": {
    "https://usernode.example": {
      "access_token": "svcli_...",
      "expires_at": "2026-08-29T12:00:00Z",
      "scopes": ["rpc:identity:read", "api:access"],
      "client_id": "social-vibecoding-cli"
    }
  }
}
```

Backend selection is journaled under the state lock. Before an external
native/file credential write, the CLI durably records the corresponding
`*-pending` state; after writing and reading back the exact record, it commits
the final backend value. A process encountering `*-pending` inspects only the
named intended backend and either finishes or safely rolls back that operation;
it never falls through to the other backend. This closes the crash window
between config and credential-store writes.

Once selected, an unavailable native backend is an error rather than a reason
to use file, and a selected file backend remains usable without probing native
on every command. The initial release performs no automatic in-place backend
migration. After `logout` has confirmed and removed every copy for an origin, it
also removes that origin's backend marker; the next login probes afresh and may
select a newly available native store. `logout --local-only` likewise removes
the local copies and marker while preserving its remote-token warning.

If reconciliation discovers both stores populated for one origin, records
containing the same raw token use the selected copy without deleting the other,
then reconcile metadata against a successful server status and complete
de-duplication under the state lock. Differing raw tokens are a fatal
credential conflict for ordinary commands. `logout` is the recovery exception:
it treats both conflicting persisted values as distinct revocation targets and
removes each local copy only after that value is confirmed inactive. Settings
cleanup remains available if either value cannot be reached.

All credential and profile mutations, including native-store operations, use
one configuration-wide interprocess state lock. It is held from before reading
the relevant `config.json`, fallback file, and native entry until every
required write and post-write check finishes. Cross-store decisions such as
“remove the last profile only if no credential exists” are made while holding
this same lock. Profile removal also refuses while a live origin-operation lock
pins that profile or origin, and login revalidates the selected
profile-to-origin mapping under the state lock immediately before persistence.
If that revalidation fails, it performs compensating revocation instead of
writing an orphaned credential. Lock acquisition has a bounded timeout;
failure to acquire it aborts without writing.

File replacement remains atomic inside that critical section. Temporary and
target files are in the same directory, refuse symlink targets, and use mode
`0600`/directory mode `0700` on POSIX or the user-only Windows ACL above. The
implementation flushes the replacement before rename and flushes the directory
after rename where the platform supports it, using the equivalent durable
replace primitive on Windows. The state-lock file
and origin-operation lock files also reject symlinks and unsafe ownership, use
restrictive permissions or ACLs, and contain no credential or device code.
Temporary files have the same path and ownership checks. Concurrent login,
logout, or profile operations cannot silently lose another process's entry.

A credential replacement temporary file necessarily contains the new
credential, so it uses the same protection as the final file, never a
world-readable default. No backup copy is created. On failure or next startup
under the state lock, the CLI removes only its own recognized stale temporary
files without following links.

Malformed JSON, an unsupported file version, unsafe ownership/permissions, or
a symlink in either user-level store is a fatal configuration error. The CLI
must not silently reset, replace, or fall through past that store; it reports
the path and a remediation that contains no credential value.

Version-1 documents and native secret records are schema-validated before use:
duplicate/unknown members, a missing or nonexistent default profile,
noncanonical origin keys, invalid profile names, malformed token/timestamp
values, a client other than the fixed client, or a scope set other than the
initial exact set are fatal store errors. Validation never echoes the rejected
token or full record.

The CLI must never log the access token, include it in an error, or write it
to the repository. Login output may include the verification URL and user
code, but not the device code.

The login command must support non-interactive output:

```bash
social-vibecoding login --no-browser
```

This prints the URL and code and continues polling, so the command can be
run by the coding agent while the user approves in a browser.
Normal login passes the already validated bare URL to the platform opener as
one argument, never through shell interpolation. Failure to open a browser is
nonfatal: the CLI still prints the URL/code and continues exactly like
`--no-browser`.

The CLI makes one device-creation request per login attempt. It does not
blindly retry that POST after an ambiguous transport failure, because the
server may already have created a live request; it exits nonzero and lets the
short-lived row expire. A creation-time `429` is surfaced with its safe
retry-after delay. Polling an already received device code follows the
retry/backoff contract above.

Before starting device authorization, `login` checks the persisted credential
for the selected origin:

- a valid credential already containing the requested scopes makes login a
  successful no-op;
- a valid credential lacking a requested scope is retained and login refuses
  rotation with an instruction to complete `logout` first;
- a credential that the status endpoint confirms is invalid, expired, or
  revoked may be replaced; and
- any existing credential whose remote status cannot be checked is retained,
  regardless of its local expiry metadata, and login exits nonzero rather than
  risk orphaning a token because of network failure or clock skew.

The initial release does not rotate an active credential in place. A user who
intentionally wants a new token must complete `logout` first. One per-origin
origin-operation lock is held from preflight through credential persistence,
so a second login fails with `login_in_progress` before creating another
device request and concurrent logout/local removal cannot race a new token
into existence. `logout`, including `--local-only`, holds the same origin lock
through all of its remote decisions and local removals; it fails with
`operation_in_progress` if another operation owns the lock.

This long-lived origin lock is separate from the short configuration-wide
state-lock critical sections. At acquisition it records the operation, owner
process identity including process start identity where available, a random
attempt ID, start time, and a conservative `recover_after`. Login sets that
deadline at least as late as the maximum device-flow lifetime; logout uses its
bounded maximum network deadline. A stale operation may be recovered only
when the recorded owner is no longer the same live process and
`recover_after` has passed. The login rule also covers a crash between server
request creation and recording its returned expiry.
Lock handles are close-on-exec and are not inherited by the browser opener or
other child processes.

The lock filename uses a fixed lowercase SHA-256 hex digest of the canonical
origin rather than raw origin/profile text, so aliases for one origin
serialize together and no URL characters become a filesystem path.

After token exchange, local persistence is part of successful login. If native
or fallback storage fails, the CLI immediately attempts self-revocation of the
new token, never prints it, exits nonzero, and warns the user to revoke the
token in Settings if compensating revocation could not be confirmed.
Before persistence it validates the complete response: exact access-token
format, case-insensitive `Bearer` token type, exact space-delimited scope set,
the exact integer `expires_in` for the initial 30-day lifetime, and a parseable
RFC 3339 `expires_at`.
If a syntactically valid token was received but any other response field is
invalid, the CLI treats it as a protocol error and attempts the same
compensating self-revocation.
The same compensating path runs on orderly cancellation or a handled
termination signal after exchange. A response transport loss after the server
commits but before the CLI receives the raw token, or a forced process kill or
machine power loss before persistence, cannot be made atomic by this
hash-only, return-once protocol. The issued row remains visible by hint and
creation time in Settings and expires normally. If polling sees
`expired_token` after an ambiguous transport error, the CLI warns that this
may have happened, and documentation tells the user to revoke an unexpected
entry in Settings.

`auth status` first identifies the selected server. It reports `missing`
without a network call when no credential exists. For every existing
credential it calls the status endpoint so server state, not local clock skew,
authoritatively determines `valid`, `expired`, `revoked`, or `invalid`.
An unreachable server is reported as `unknown (server unreachable)`, not as
valid or logged out, and exits nonzero; it may separately show the non-
authoritative local expiry metadata.

## MCP server

The MCP server is project-local and launched by Codex or Claude Code over
stdio. It must not require an access token to initialize, because
initialization without a credential should produce a useful login path rather
than make the MCP unavailable.

`codex setup` materializes project-scoped MCP configuration at
`.codex/config.toml` using canonical absolute paths. Conceptually it writes:

```toml
approvals_reviewer = "user"

[mcp_servers.social_vibecoding]
command = "/absolute/path/to/the/current/node"
args = [
  "/absolute/path/to/this/checkout/tools/social-vibecoding",
  "mcp",
  "--profile",
  "production",
]
cwd = "/absolute/path/to/this/checkout"
enabled_tools = [
  "social_vibecoding.login_status",
  "social_vibecoding.whoami",
  "social_vibecoding.api_read",
  "social_vibecoding.api_write",
  "social_vibecoding.proposal_start",
  "social_vibecoding.proposal_append_context",
  "social_vibecoding.proposal_push_commit",
  "social_vibecoding.proposal_submit_build",
  "social_vibecoding.proposal_status",
  "social_vibecoding.proposal_recheck",
  "social_vibecoding.proposal_promote",
]

[mcp_servers.social_vibecoding.tools."social_vibecoding.proposal_promote"]
approval_mode = "prompt"

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "<same generated pinned-hook runner>"
additionalContextLimit = 256

[[hooks.PreToolUse]]
matcher = "(^Bash$|api_write$)"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "<generated Node -e runner that verifies the hook SHA-256 before loading it>"

[[hooks.PermissionRequest]]
matcher = "^Bash$"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "<same generated pinned-hook runner>"

[[hooks.PostToolUse]]
matcher = "proposal_promote$"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "<same generated pinned-hook runner>"
```

Proposal consent is a Codex client concern, not a second server-side approval
protocol. The dedicated `proposal_promote` MCP tool always uses Codex's manual
reviewer and `prompt` approval mode. A project `PreToolUse` hook rejects the
generic `api_write` promotion path and direct shell commands that visibly call
the promotion route. This is a client workflow guardrail, not a security
boundary against an adversarial agent or an opaque wrapper script.

The MCP subprocess may be unable to read the native credential store after the
tool is approved. In that case `proposal_promote` returns the exact canonical
host `argv` for its POST rather than a useless status-only command. A
`PostToolUse` hook records a private, short-lived receipt bound to the Codex
session, turn, proposal session ID, and exact `argv`; the first matching
`PreToolUse` invocation atomically claims it by tool-call ID, and later tool
calls cannot reuse it. `PermissionRequest` treats that claimed fallback as part
of the approval the user just gave instead of displaying a duplicate prompt.
The receipt grants no bearer token and expires after ten minutes. Other turns,
proposal IDs, commands, clients, and raw HTTP calls do not match it.

The server still performs authorization, ready/check state, and exact reviewed
head validation. It does not store or infer whether a human clicked a Codex
approval control. This client-side guardrail applies to Codex; another client
such as Claude needs its own equivalent approval policy if it requires the same
interaction guarantee.

Setup pins the hook file's SHA-256 into every generated hook command. A small
inline Node runner in the trusted command verifies that digest before loading
any code from the hook file and exits with the blocking status on a mismatch.
Changing the tracked hook therefore requires rerunning `codex setup`, which
changes the hook command definition and triggers Codex's normal hook trust
review for the new revision.

The same pinned file also runs on `UserPromptSubmit` and adds a short,
model-visible health attestation. The shared proposal skill expects that
separate attestation only in Codex CLI. If it is absent there because hooks are
disabled, untrusted, pending review, or blocked by policy, Codex CLI asks the
user to open `/hooks` and does not promote until a later prompt carries the
attestation. The check does not apply in ChatGPT desktop, which has no
`/hooks` command, and must not produce that warning there or in Claude Code.
This is a readiness signal, not a replacement for the `PreToolUse`
enforcement above.

For a self-hosted user profile, configuration may use
`--profile lab`; setup puts only that validated profile name in `args`. The
origin remains in user-level configuration.

The repository must include the launcher, but credentials remain outside the
repository.

`tools/social-vibecoding` is a Node entry point (with an optional POSIX
shebang). Setup derives the real checkout root from that entry point, resolves
the current Node executable, rejects symlink/path escapes, and never derives
either path from a repository-supplied environment variable. Absolute
`command`, script, and `cwd` values avoid host-specific MCP working-directory
behavior in Codex CLI, IDE, and desktop surfaces. The implementation uses a
compatible MCP SDK release pinned by the repository lockfile rather than
hand-rolling stdio framing.

The repository checks in `.codex/config.toml.example` and a `.gitignore` rule
for the materialized `.codex/config.toml`; machine-specific generated paths
are never committed. Setup uses an atomic write and refuses to overwrite an
existing non-generated config. If it owns the existing generated file, an
identical run is idempotent and a rerun may update moved checkout or Node
paths. Omitting `--profile` preserves its prior selection; an explicit
validated `--profile` changes it. On the first run, omission selects
`production` regardless of the user's general CLI default. Otherwise setup
prints a credential-free table for manual merge into that ignored local file
and exits nonzero. It refuses a target tracked by Git, and CI asserts that
neither the target nor its lock is tracked.

Setup requires the selected profile to resolve through the same user-level
rules as `mcp`, but materializes only its name. It refuses a symlink/reparse
point at `.codex`, the target, lock, or its temporary file. A bounded
setup-specific interprocess lock covers inspect-through-replace, and the write
uses the same-directory durable-replace discipline as other local state.
The lock is also gitignored. After creating or changing the table, setup tells
the user to restart/reload Codex. On the first prompt, the attestation check
asks the user to review and trust the exact promotion hook through `/hooks` if
it is not active; Codex does not run a new or changed non-managed project hook
before that review. Setup never claims that an already running MCP process has
adopted the new command, path, forwarded variables, profile, or hook.

The materialized table may contain only the launcher, arguments, absolute
checkout `cwd`, timeouts, and reviewed tool allowlist. It must not set `env`,
`bearer_token_env_var`, a credential/config-directory override, or any
token/server value. By default it also sets no `env_vars`. With the user's
explicit `--forward-env-token` opt-in, setup may add exactly
`SOCIAL_VIBECODING_TOKEN` and `SOCIAL_VIBECODING_SERVER` to `env_vars`; it
stores only those names, never their values. A user who needs automation
credentials configures the parent environment outside the repository. Codex
loads project-scoped MCP configuration only for a trusted project; the user
documentation must call out that trust decision.

`claude setup` registers the same canonical stdio command under the
`social_vibecoding` name using Claude Code's private, project-specific `local`
MCP scope:

```bash
claude mcp add-json --scope local social_vibecoding \
  '{"type":"stdio","command":"/absolute/path/to/node","args":["/absolute/path/to/checkout/tools/social-vibecoding","mcp","--profile","production"]}'
```

The command is executed directly without a shell. The JSON contains only the
canonical Node executable, checked-in launcher, `mcp` arguments, and validated
profile name; it contains no credential, origin, or environment value. Local
scope keeps the registration private to the user and current project and does
not require the separate approval Claude Code applies to shared `.mcp.json`
servers.

Because Claude Code owns its user-level configuration format, setup modifies
it only through the installed `claude mcp` CLI. The checkout stores an ignored,
credential-free `.claude/social-vibecoding-mcp.local.json` ownership marker.
Setup refuses a pre-existing same-named local server when that marker is
absent. With a valid marker, identical runs are idempotent, missing
registrations are repaired, and a moved checkout, Node path, or explicit
profile change replaces only the owned local registration. Without a marker or
explicit profile, the first run selects `production`, not the general CLI
default. If replacement fails, setup attempts to restore the marker's prior
registration. A bounded ignored lock and atomic durable marker write cover
each update. Symlinked, malformed, non-generated, or Git-tracked markers are
refused.

The checked-in root `CLAUDE.md` imports `AGENTS.md` for always-on repository
rules. Conditional API and proposal procedures live as portable skills in
`.agents/skills/`, with `.claude/skills/` linking to the same canonical
directory. Claude Code and Codex therefore receive the same production/local
selection, automatic setup/login, generic API, and untrusted-data guidance
without loading the full procedures on unrelated tasks. After registration,
setup tells the user to restart or reload Claude Code's MCP servers and never
claims that the current process has adopted the new configuration.

The repository-local launcher and MCP process are inside the credential trust
boundary: a modified launcher can act with every granted scope. The project
configuration must therefore invoke only the checked-in launcher from the
trusted checkout, and documentation must tell users not to authenticate from
an unreviewed checkout. The launcher must not accept a server origin from
project-local configuration; it may accept only a validated profile name that
resolves through an immutable built-in or user-level configuration.

In `mcp` mode, stdout is reserved exclusively for MCP protocol messages.
Diagnostics go to stderr through a redacting logger, and neither stream may
contain credential material. The process handles EOF and termination cleanly
without writing non-protocol text to stdout.

The MCP server must expose an unauthenticated diagnostic tool:

```text
social_vibecoding.login_status
```

It reports the selected profile name, canonical origin, and local/remote status
without returning credential material. A missing or malformed profile is
reported as a structured `configuration_error`; the MCP process still
initializes so the diagnostic remains callable, but protected tools return the
same non-retryable configuration error without making a network request.

Initialization returns concise server instructions telling the client agent to
use production unless the user explicitly requests local, invoke the generic
API tool first, execute a returned local-setup or login argument vector itself,
and retry once after health/approval. If a sandboxed stdio process cannot read
an existing native-store credential, the instructions instead require the
agent to execute the tool's returned API argument vector with host execution,
never retry the same MCP call, and use that external CLI path for later calls
in the same sandboxed session. It never asks the user to type those commands
and does not wait for login during initialization. All tools declare output
schemas. Diagnostic, identity, and GET tools use
`readOnlyHint: true`; the generic mutation tool uses `readOnlyHint: false`
and `destructiveHint: true`. All use `openWorldHint: false`.

Protected tools call a shared authenticated client. If no credential exists,
the tool returns a structured error:

```json
{
  "isError": true,
  "structuredContent": {
    "code": "login_required",
    "command": "node ./tools/social-vibecoding login --profile production",
    "argv": [
      "/absolute/path/to/node",
      "/absolute/path/to/checkout/tools/social-vibecoding",
      "login",
      "--profile",
      "production"
    ],
    "cwd": "/absolute/path/to/checkout",
    "profile": "production",
    "retryable": true
  },
  "content": [
    {
      "type": "text",
      "text": "Homeroom login is required. Run node ./tools/social-vibecoding login --profile production, then retry."
    }
  ]
}
```

`command` and `structuredContent.profile` always include the validated target
profile name, including `production`; for example,
`node ./tools/social-vibecoding login --profile lab`. `argv` and `cwd` contain
the runtime's canonical absolute Node, script, and checkout paths; the
placeholders above are illustrative. The client agent should invoke that argument vector
in that directory rather than reparsing the display string. This pins the
retry to the same origin if the user's default later changes. Profile names
are restricted by the CLI grammar above and are never interpolated as
arbitrary shell text. Human-readable command text uses platform-appropriate
quoting and strips control characters; `argv` remains authoritative.

An existing `native` backend may be readable by the host CLI but inaccessible
to a sandboxed Codex stdio process (for example, because the sandbox cannot
reach the desktop keyring service). For an API or proposal tool, that exact
native-store access failure returns `host_execution_required` with
`retryable: false`, `requires_host_execution: true`, and an exact canonical
`argv`/`cwd` for the equivalent `social-vibecoding api` call. The commit-upload
wrapper returns the corresponding `social-vibecoding proposal push` vector
immediately, without first probing a credential store it expects the sandbox
cannot reach. The display command contains placeholders rather than
interpolating the untrusted API path or request body; only the argument vector
is executable. The agent asks
for host execution once, consumes the CLI's JSON result, and uses the direct
CLI path for later Homeroom calls in the same sandboxed session. It must not
retry the doomed MCP call, start a second login, copy a bearer token into the
repository, or silently migrate the credential to the fallback file. Other
native-store errors remain fail-closed configuration errors. The MCP process
caches this access failure for that origin for its lifetime, so an accidental
later tool call returns the host vector without another keyring probe or
timeout.

`proposal_push_commit` requires an explicit absolute repository path because
the MCP server's own working directory is the Homeroom platform checkout, not
necessarily the app checkout. Its returned host command uses a two-minute HTTP
deadline for the bounded upload/GitHub reconstruction operation; ordinary API
calls retain the generic 30-second deadline.

The protected tools are:

```text
social_vibecoding.whoami
social_vibecoding.api_read
social_vibecoding.api_write
social_vibecoding.proposal_start
social_vibecoding.proposal_append_context
social_vibecoding.proposal_push_commit
social_vibecoding.proposal_submit_build
social_vibecoding.proposal_status
social_vibecoding.proposal_recheck
social_vibecoding.proposal_promote
```

`whoami` is backed only by `GET /api/cli/rpc/me` and
`rpc:identity:read`. `api_read` accepts a generic allowed API path and always
uses `GET`. `api_write` accepts `POST`, `PUT`, `PATCH`, or `DELETE`, an allowed
path, and an optional JSON body. Both API tools use `api:access`, preserve the
platform endpoint's HTTP status and JSON body, never accept an origin/header/
cookie/token input, and never call GitHub directly. This path-based bridge
means a new user-facing platform endpoint needs no CLI/MCP registry change.

The seven proposal tools are reviewed convenience wrappers around those same
user-facing APIs, not a hardcoded API registry. They preserve the browser Dev
workflow for work authored in a local Codex or Claude session:

1. The agent resolves the app, repository, and exact base SHA through Homeroom.
   It reuses an existing checkout only if its `HEAD` is that exact base SHA;
   otherwise it retrieves a shallow
   checkout, never the repository's full history: `git clone --depth 1` is
   sufficient when the remote default `HEAD` equals the base SHA; for any other
   base it initializes an empty repository and runs
   `git fetch --depth=1 origin <base-sha>` followed by a detached checkout of
   `FETCH_HEAD`. It verifies `git rev-parse HEAD` against the base SHA and
   deepens the checkout only when the requested work genuinely needs older
   history.
2. The agent inspects that checkout, writes a complete markdown spec before
   implementation, and calls `proposal_start` with the app, exact base SHA,
   stable request ID, spec, and durable history. Supply `external_agent` as
   `codex` or `claude-code` to identify the authoring tool (`external` when
   unknown). The HTTP body calls this optional field `externalAgent`; it is
   persisted in `external_agent` without changing the execution backend. Older
   clients remain compatible and display as External agent. Homeroom creates a native
   `source='cli_handoff'` Dev session and a platform-managed branch at that
   exact base. History contains exact user-visible requests and concise agent
   summaries, each with a stable event ID. It never contains hidden reasoning,
   secrets, credentials, or raw tool logs. Event IDs are unique per session,
   making retries idempotent. `proposal_start` fingerprints its full normalized
   request and atomically commits the session, initial spec, and initial
   history, so retrying remains read-only even after later local/web edits.
   The spec is stored in both the live session document and immutable spec
   history. The request ID and returned session ID remain the identity for
   retries, rebases, pushes, and check recovery. A new request ID for the same
   owner's linked pre-vote handoff returns `proposal_already_started` with the
   existing session. Only an explicitly supplied `supersedes_session_id` may
   replace it; Homeroom archives the named predecessor and inserts the
   lineage-linked successor in one transaction.
3. The agent implements and tests in its local checkout and creates one normal
   non-merge commit. It does not push the bot-owned branch with personal
   GitHub credentials and does not dispatch a web worker merely to obtain push
   access. `proposal_push_commit` returns an exact host CLI argument vector;
   the agent executes it outside the stdio sandbox. The CLI reads only the
   named committed Git objects, never the working tree, and sends the local
   commit/parent/tree identities plus a bounded base64 snapshot of its changed
   blobs and deletions to
   `POST /api/sessions/:id/proposal-handoff/commits`.
4. Homeroom uses the app's GitHub installation credential to reconstruct the
   changed tree on the managed branch. The current remote tip's tree must equal
   the local parent tree, and GitHub's reconstructed tree SHA must equal the
   tested local commit's tree SHA. Only then does Homeroom create a bot-owned
   commit and non-force advance the managed ref. The returned platform
   `headSha` may differ from the local commit SHA because author, committer, and
   message metadata differ; tree equality is the exact-code invariant. A
   subsequent local adjustment works because its local parent tree equals the
   preceding bot commit's tree even though their commit IDs differ. Commits are
   uploaded oldest-first when a local change spans more than one commit.
5. The agent passes that returned platform `headSha` to
   `proposal_submit_build`. Homeroom re-verifies ancestry and branch ownership,
   then runs the ordinary staging, preview, screenshot, and proposal-check
   pipeline against that exact bot-owned commit.
6. The agent polls `proposal_status` until `ready`, `failed`, or `stalled`.
   Status exposes the check phase, trigger, timestamp, commit staleness, and
   whether a live worker/build/capture still owns the run. `stalled` means the
   durable pending snapshot is overdue with no live owner; `proposal_recheck`
   rebuilds or re-runs checks on that same session. Failed code is revised with
   later fast-forward commits. `proposal_promote` first verifies the session is
   ready, then uses the existing Homeroom promotion route to create the app PR
   lazily and enter the normal vote flow; it never opens a GitHub PR directly.

The returned `webPath` opens the exact same native session on the web Dev
page. Continuing there is optional: its user/assistant transcript, spec,
branch, staging preview, checks, and later PR context are shared, but the local
agent can also complete the entire workflow through promotion without opening
the page. Opening or editing in the web page never transfers ownership or
changes provenance. Local and web turns may alternate on the same branch;
web-worker commits advance the ordinary `checks_commit_sha`, while
`handoff_head_sha` remains the audit record of the latest commit explicitly
submitted to staging by a local agent. `handoff_uploaded_sha` records the
newest reconstructed local tree separately; upload invalidates the prior
verdict and artifacts but does not overwrite `checks_commit_sha`, set
`handoff_head_sha`, or start a check. The previous checked SHA remains the
identity of any still-visible old preview until the new upload is submitted;
an uploaded-but-not-submitted commit is never presented as checked or ready.
`handoff_upload_checked_sha` snapshots that previous checked identity. An
unchanged value means the upload is still pending; a later web turn advances
`checks_commit_sha` and thereby supersedes it without destroying either audit
identity. A subsequent local upload snapshots the new web head and becomes the
pending branch tip normally.

`handoff_local_commit_sha` retains the corresponding local identity for audit;
status reports it as `localHeadSha`, while `uploadedHeadSha` and
`submittedHeadSha` are the bot-owned GitHub identities.

The commit-upload parser is isolated from the ordinary 100 KiB API parser and
accepts at most 200 changed paths, 4 MiB per blob, 8 MiB of decoded blob data,
and 8 KiB of commit message within a 12 MiB JSON envelope. Paths must be
relative canonical UTF-8 names outside `.git`; only regular, executable, and
symbolic-link blob modes are accepted. Empty, root, merge, submodule,
non-UTF-8-path, and over-limit commits fail locally before authentication.
The server independently repeats all payload, path, mode, base64, timestamp,
and size validation before any GitHub call. Upload is available only to an
authenticated CLI bearer whose user still has collaboration access to the
active handoff session.

Uploads are serialized with web/session work. The persisted expected branch
tip is compare-and-swapped after GitHub mutation, and GitHub ref updates use
`force: false`. A lost-response retry is recognized from an exact
`Usernode-Local-Commit` trailer and matching tip tree before another commit is
created; the database update is retryable after either side of that boundary.
An unrelated branch movement, parent-tree mismatch, or reconstructed-tree
mismatch fails closed and never rewrites the ref.

Before promotion, `checks_commit_sha` (falling back to `handoff_head_sha`
before the first check) identifies the exact revision whose staging preview
and checks are ready. Promotion re-reads the managed branch and refuses if it
no longer matches that checked head. The ordinary native-proposal promotion
path then records the live PR head in `reviewed_head_sha`; votes and the final
GitHub merge use that common native revision pin, including for CLI handoffs.

A late direct push therefore cannot be merged under earlier checks or votes.
The shared native revision reconciler advances `reviewed_head_sha`, removes
only votes stamped for the older revision, invalidates an older checks result,
and runs checks against the new head while the proposal remains in review. If
GitHub reports a moved head at merge time, the same reconciliation runs before
another vote or merge attempt. CLI handoffs do not carry a parallel
merge-specific state machine.

This is deliberately not the imported-PR path, whose Dev chat is read-only and
cannot preserve cross-surface continuation.

The API tools use the MCP server's pinned profile when `profile` is omitted.
They accept only the immutable `production` or `local` names as an explicit
per-call override. Server instructions and the shared `usernode-api` skill
require production by default and `local` only when the user's prompt
explicitly says local.

Before a local API call, MCP checks `http://localhost:3000/health`. If it is
not ready, it returns `local_setup_required` with `argv: ["make", "up"]` and
the canonical checkout `cwd`; the agent runs it, waits for health, and retries.
This never happens for a production request.

MCP treats all API-returned strings, including `username`, as untrusted data.
They stay in schema-validated structured fields; any companion text escapes
control characters and never presents returned data as instructions.

The MCP process pins the selected profile name at startup. Before every
diagnostic or protected tool call it re-reads user configuration, verifies
that the name still resolves to the same canonical origin, and reloads that
origin's credential. It must therefore observe login, logout, and token
replacement in persisted storage without a process restart, while profile removal becomes a
non-retryable `configuration_error` instead of silently continuing with stale
configuration.

A missing persisted credential, or an invalid, expired, or revoked persisted
credential, maps to the `login_required` shape. An invalid, expired, or revoked
environment credential instead returns a non-retryable
`environment_credential_invalid` result instructing the user to unset or
replace it and restart the MCP process; running device login cannot fix a
shadowing environment override. Environment variables are a process-start
snapshot, so an already running MCP cannot observe a parent-shell change.
Rate limits, audit unavailability, and other `5xx` responses are transient
service errors and must not be mislabeled as authentication failures.

Except for a locally malformed token, MCP does not classify a credential from
local expiry metadata alone. It sends the protected request once and uses the
server's response, so a fast client clock cannot turn a still-valid credential
into a false `login_required`.

An `insufficient_scope` response from a legacy identity-only credential maps
to retryable `reauthorization_required` with the external login vector. The
login command first confirms that the legacy credential is still valid and
refuses to rotate it implicitly. The client agent then runs `logout` for the
same validated profile, reruns the login vector, and waits for fresh browser
consent; it does not delegate those commands to the user. Any other role,
ownership, or object-level `403` is returned as the API response and never
triggers login.

Timeouts, DNS/connectivity failures, and `429` are bounded transient service
errors. TLS validation, redirect, oversized/malformed response, and unexpected
route/protocol errors are non-retryable `server_configuration_error` results;
neither class becomes `login_required`.

The MCP server must not automatically block waiting for browser approval from
inside its stdio process. This can deadlock the MCP client. Login is an
explicit CLI operation, after which the client agent retries the failed tool.

## Global API authentication

Do not modify browser session semantics. CLI bearer authentication has two
explicit middleware modes:

```http
Authorization: Bearer svcli_...
```

`loadRetainedCliToken` is used only by token status and self-revocation. It:

1. Requires exactly one syntactically valid `Authorization: Bearer <token>`
   credential and rejects duplicate headers, comma-joined credentials, other
   schemes, whitespace/control-character ambiguity, and malformed token
   format.
2. Hashes it.
3. Looks up any retained matching row, including expired or revoked rows.
4. Returns `invalid_token` for an unknown row.

It does not reject a known row because of expiry or revocation; the status and
revocation handlers need that state to implement their contract.
For these bearer endpoints, a missing credential is
`401 { "error": "missing_token" }`; a malformed, duplicate, or unknown
credential is `401 { "error": "invalid_token" }`. Both include an appropriate
`WWW-Authenticate: Bearer` challenge without reflecting input.

`requireActiveCliToken(scope)` is used only by protected RPC routes. It:

1. Performs the retained-token lookup.
2. Rejects expired or revoked rows.
3. Loads the current user from `users` using the stored `user_id` and builds
   `req.user`; no role, username, or authorization property is copied from the
   request or token.
4. Checks the route's exact required scope and durably records the allowlisted
   `token_used` outcome for both allowed and insufficient-scope decisions.
5. Dispatches only an allowed request whose audit insert succeeded.
6. Updates `last_used_at` asynchronously as non-authoritative usage metadata,
   using a monotonic `GREATEST` update so concurrent completions cannot move it
   backward; update failure never changes the already audited authorization
   decision.

An IP limiter runs before token lookup on all bearer endpoints. After a token
row is resolved, a second limiter keys protected RPC by access-token row ID.
Initial limits are 60 requests per minute per token and 300 per minute per IP;
self-status and self-revocation share a 60-per-minute per-IP bucket. Routes may
set lower limits. A limit failure returns
`429 { "error": "rate_limited" }` with `Retry-After` before inserting a
`token_used` audit event or updating `last_used_at`.

All security rate-limit and live-admission state is shared across server
replicas. A process-local limiter may be an additional defense but cannot be
the authoritative implementation of the documented limits. If the
authoritative limiter/admission backend is unavailable, the affected route
fails closed with `503 { "error": "temporarily_unavailable" }`; it never
silently runs without the control.

Protected RPC responses use `401` for missing, invalid, expired, or revoked
credentials. The JSON `error` is respectively `missing_token`,
`invalid_token`, `expired_token`, or `revoked_token`, and the response includes
an appropriate `WWW-Authenticate: Bearer` challenge without token material.
This lets the MCP map credential failures to one `login_required` result. Use
`403` with `{ "error": "insufficient_scope" }` for valid credentials lacking
the required scope. A scope check is necessary but not sufficient: every
future route must also enforce its current role and object-level authorization
from server-side data.

The global RPC router must be mounted after public/device routes and must
not accept iframe tokens, app tokens, or worker tokens.

No `/api/cli/*` route enables browser CORS. Public device endpoints ignore
ambient cookies, while browser-session endpoints use only the explicitly
documented cookie flow; bearer endpoints never fall back to a cookie.

### Route mounting

The current platform cookie middleware rejects unauthenticated API requests
and skips user resolution entirely for public paths. The CLI routes must
therefore be split and mounted in this order:

```text
1. Public, before cookie auth:
   POST /api/cli/device/code
   POST /api/cli/device/token
   GET  /cli/authorize

2. CLI bearer auth, before cookie auth:
   loadRetainedCliToken:
     GET    /api/cli/token/status
     DELETE /api/cli/token/current

   requireActiveCliToken(exactScope):
     /api/cli/rpc/*

3. Existing platform cookie auth middleware.

4. Browser-session auth:
   GET    /api/cli/device/approval
   POST   /api/cli/device/approve
   GET    /api/me/cli-tokens
   DELETE /api/me/cli-tokens/:id
```

Do not add the whole `/api/cli/` prefix to the existing public-path allowlist.
Each pre-auth router carries and enforces its own public or bearer
authentication contract.

### Browser cache and service worker

The existing service worker otherwise classifies authenticated `GET /api/*`
responses as cacheable API data. The implementation must update
`public/sw.js` so:

- every `/api/cli/` request and `/api/me/cli-tokens` request is classified as
  `bypass` (the latter means the exact collection path and every
  `/api/me/cli-tokens/…` item path, regardless of query);
- `/cli/authorize` is in `NO_FALLBACK_PAGES`, so an offline navigation never
  receives the cached SPA shell; and
- the service-worker version is bumped so the new classification reaches
  existing installations.

These client-side exclusions are required in addition to the server's
`Cache-Control: no-store` headers.

## Coding-agent retry contract

The MCP tool description should tell the client agent that `login_required` is
retryable. The expected interaction is:

```text
1. Agent calls MCP tool.
2. MCP returns login_required.
3. Agent runs the repository-local login command with user approval.
4. Login command waits for browser approval and exits 0.
5. Agent retries the original MCP tool once.
```

If login fails, the MCP tool must not retry repeatedly. Return the login error
and let the user decide whether to try again.

The browser approval itself cannot be fully autonomous: the user must still
approve access. The CLI/MCP integration can, however, keep the entire
orchestration inside the Codex or Claude Code session.

## Interaction with PR #840

PR #840 changes iframe identity tokens to app-scoped RS256 tokens and removes
the old shared `JWT_SECRET` authority. This feature must remain independent of
that mechanism:

- The CLI must not call `/api/iframe-token`.
- The CLI must not receive or use `IFRAME_JWT_PRIVATE_KEY`.
- CLI access tokens are global opaque bearer credentials.
- The global RPC API must not accept an iframe token as a substitute.

This keeps global platform identity separate from child-app identity.

## Security requirements

- Hash device and access tokens at rest.
- Use at least 256 bits of randomness for secrets.
- Expire device requests quickly, initially 10 minutes.
- Enforce a minimum polling interval and per-IP/device-code rate limits.
- Rate-limit device creation and browser user-code validation per IP and,
  after login, per user.
- Rate-limit bearer lookups per IP and protected RPC per token.
- Make device codes single-use after token issuance.
- Put only the short display code—not the device code or access token—in the
  complete URI fragment, remove it from history before network activity, and
  require the user to compare the displayed code before authorizing.
- Require explicit browser approval.
- Protect browser approval with CSRF controls.
- Do not reveal whether a guessed user code belongs to an active user.
- Provide server-side revocation.
- Cancel approved requests and revoke active CLI tokens during account-
  recovery flows that invalidate all browser sessions.
- Record audit events for authorization started, approved, rejected,
  recovery-cancelled, issued, used, and revoked. Put device/token row IDs only
  in their dedicated columns and keep metadata to the documented per-event
  allowlist; never include raw values or token hashes.
- Never place access tokens or device codes in URLs, logs, MCP tool output, or
  repository files. User codes may appear in the device JSON response,
  validated complete-URI fragment, CLI/browser display, authenticated metadata
  query, and approval JSON body. Every request logger must redact the metadata
  query value and approval body.
- Require HTTPS outside local development.
- Use normal hostname-verified TLS with the system trust store; the CLI has no
  insecure certificate or hostname-verification bypass.
- Use `Cache-Control: no-store` on every `/api/cli/*` response, CLI-token
  Settings response, and approval page.
- Canonically bind every stored credential and outbound bearer request to one
  server origin.
- Apply the documented retention job to expired device requests and inactive
  access tokens.
- Keep operational metrics aggregate and low-cardinality; never use raw or
  hashed codes/tokens, user codes, token hints, user IDs, or IP addresses as
  metric labels.

## Tests and acceptance criteria

### Platform tests

- Production and explicit local development expose the routes, while a
  self-app staging environment returns `404` for every CLI-auth surface.
- Feature enablement fails closed for a missing/mismatched canonical origin
  and cannot be enabled by spoofing a request `Host`.
- CLI-auth JSON routes enforce their dedicated 4 KiB parser before the generic
  parser and reject malformed/oversized bodies without logging them.
- Applying the schema twice succeeds, and token/device formats carry 256 random
  bits with only their full SHA-256 hex digests persisted; schema checks reject
  invalid state/timestamp/scope combinations.
- Applying the schema over an identity-only deployment expands all three scope
  constraints, including PostgreSQL's auto-named multi-column audit constraint;
  a transactional two-scope device/token/audit fixture then succeeds.
- Staging clones truncate all three CLI-auth tables, and the production-debug
  role cannot select any of them.
- Device-code creation returns both the canonical bare URL and the exact
  code-bearing fragment URL, while storing only the device-code hash.
- Request-controlled host/forwarding headers cannot change verification URLs
  or the canonical Origin policy.
- Device-code creation rejects caller-supplied client identity, accepts only
  the exact request shape and ordered
  `["rpc:identity:read", "api:access"]` set, and rejects missing, reordered,
  duplicate, or unknown scopes.
- Device-code creation is rate-limited and atomically caps live unconsumed
  requests, including approved requests; spoofed forwarding headers do not
  change the limiter key.
- Creation, polling, approval, Settings, and bearer security limits hold
  across multiple server replicas rather than resetting per process.
- Expired device requests cannot be approved or exchanged.
- Unknown/invalid device codes do not reveal account information.
- Lowercase, separator-free, and canonical forms of one user code resolve to
  exactly the same request; case variants can never exist as separate rows.
- Polling returns `authorization_pending` before approval.
- The client and server wait before the first poll; polling returns `slow_down`
  when abused and respects `429 Retry-After`.
- Concurrent pending polls cannot both pass the minimum-interval check.
- User-code metadata queries are redacted from request logs.
- The public approval shell reveals no request details before authentication;
  its metadata endpoint requires a valid platform session.
- The approval shell accepts only one fragment-supplied code, removes it from
  browser history before lookup, ignores query-supplied codes, and shows the
  canonical code plus the anti-phishing warning before authorization.
- In every enabled environment, approval rejects missing, foreign, or
  cross-site `Origin`/fetch metadata according to the CSRF contract.
- The approval page has the specified restrictive CSP/referrer/nosniff
  headers, cannot be framed, and loads no inline or third-party active content.
- Login returns only to the exact relative `/cli/authorize` path with no query
  or fragment, rejects all other `return_to` values, and clears temporary
  `sessionStorage` code state at the documented terminal points.
- Approval binds the request to the approving user.
- Repeated equal approval decisions by the same user are idempotent;
  conflicting decisions return `409`, and another user cannot reuse the
  decision.
- Rejected requests return `access_denied`.
- Account recovery cancels approved requests and makes their polls return
  `access_denied`.
- Token exchange is single-use and transactional.
- Two concurrent exchange requests produce exactly one access token.
- `rpc:identity:read` authorizes only `GET /api/cli/rpc/me`; query/body
  variants, trailing-slash variants, automatic `HEAD`, and unrelated CLI-RPC
  routes remain forbidden.
- `api:access` authenticates generic user-facing JSON API paths without
  bypassing existing route authorization; denied internal, credential,
  debug/admin, application-token, and topochain namespaces remain
  inaccessible.
- Generic API path canonicalization rejects origins, protocol-relative URLs,
  fragments, encoded path segments, control characters, and denied
  namespaces. GET and mutation tools carry accurate read/destructive
  annotations.
- Revoked and expired access tokens return `401` from protected RPC routes.
- Valid tokens with insufficient scope return `403`.
- User A's token authenticates as User A and never trusts a client-supplied user ID.
- User A cannot list or revoke User B's token by guessing its row ID.
- Self-status distinguishes valid, expired, revoked, and unknown tokens
  without exposing hashes.
- Self-revocation is idempotent and works for an expired token row.
- Admin/wallet recovery atomically invalidates sessions, cancels approved
  device requests, revokes active CLI tokens, and records the correct actor
  and reason; ordinary logout/password change does not revoke CLI tokens.
- Recovery racing approval or exchange cannot leave a post-recovery approved
  request or active token.
- Token-list responses use bounded stable pagination, expose only the
  allowlisted fields and derived status, and enforce list/delete rate limits
  plus decimal-ID ownership checks.
- Status and self-revocation use retained-token lookup, while protected RPC
  uses active-token enforcement.
- User deletion cascades bound device and access-token rows without deleting
  independent audit records, and retention cleanup removes rows at the
  documented ages.
- Every security state transition commits its audit row atomically; an audit
  failure rolls it back.
- A protected RPC is not dispatched when its `token_used` audit insert fails.
- Allowed and insufficient-scope decisions record their distinct
  `token_used` outcomes without request bodies or credential material.
- State-transition audit events are unique per device/token transition and
  actor/reason/usage metadata matches the exact per-event allowlist.
- Audit rows contain only allowlisted metadata, survive credential/user
  cleanup as specified, and are not removed before the one-year minimum.
- Bearer endpoint IP/token limits return `429` before usage auditing or
  `last_used_at` updates.
- Settings revocation rejects missing or cross-site Origin/fetch metadata.
- CLI routes reject duplicate/ambiguous bearer headers, ambient-cookie
  fallback, and browser CORS.
- Every CLI API, approval, and CLI-token Settings response sends
  `Cache-Control: no-store`.
- The service worker bypasses CLI/token-list APIs, gives `/cli/authorize` no
  offline fallback, and ships with a bumped cache version.

### CLI tests

- `login --no-browser` prints the complete verification URL/code and completes
  after approval.
- Browser login opens only the exact validated `verification_uri_complete`;
  the page consumes and removes its fragment before request lookup.
- Credentials are stored with safe permissions and are not printed.
- Repository-controlled home/config environment variables cannot redirect the
  user configuration or credential stores.
- Concurrent credential and profile updates preserve every origin and abort
  cleanly if their interprocess lock cannot be acquired.
- A profile cannot be removed during a pinned login, and login revalidates its
  mapping before persisting a token.
- Malformed, unsupported-version, symlinked, or permission-unsafe user stores
  fail closed without being reset or exposing their contents.
- Production, built-in local, and user-defined profiles resolve
  deterministically; the raw origin never comes from repository configuration.
- Profile names cannot be retargeted, protected/default profiles cannot be
  removed, and the last profile for an origin with a credential is retained.
- MCP and login select the same non-default user profile.
- An environment token is rejected before network access unless its mandatory
  server value exactly matches the selected profile's normalized origin.
- Device login refuses to create a shadowed persisted token while an
  environment credential is present.
- Native-store outages do not fall through to fallback credentials; equal
  duplicate copies reconcile safely, while `logout` can recover differing
  copies independently.
- Journaled per-origin backend selection recovers interrupted writes; a marker
  with a missing record or an inaccessible alternate store never becomes a
  false `missing` state that can mint a second token.
- Login is a no-op for an existing valid credential, refuses uncertain
  replacement, and requires logout before rotating an active token.
- Concurrent login attempts for one origin create only one device request.
- Concurrent login and logout/local removal for one origin serialize, and
  stale operation locks cannot be stolen while the recorded process is alive.
- A persistence failure after exchange triggers compensating revocation and
  never prints the newly issued token; invalid token-response metadata and
  handled post-exchange cancellation use the same path.
- An ambiguous lost exchange response followed by `expired_token` produces the
  documented Settings-revocation warning.
- The CLI rejects insecure non-loopback origins, every API redirect, a bare
  verification URL outside the selected origin's exact approval path, and a
  complete URI whose fragment does not exactly match the returned display code.
- `auth status` distinguishes missing, expired, revoked, invalid, valid, and
  server-unreachable states using authoritative server status for every
  existing credential.
- `logout` independently revokes distinct environment and persisted tokens and
  never deletes one after revoking only the other.
- When revocation is unreachable, `logout` retains the persisted credential,
  warns that remote credentials may remain active, and exits nonzero.
- `logout --local-only` removes only persisted state and emits the documented
  remote-token warning.
- The CLI exits nonzero for denied, expired, or interrupted login.

### MCP tests

- MCP initializes without credentials.
- In MCP mode stdout contains only protocol messages, all tools publish the
  documented output schemas/read-only annotations, and initialization
  instructions describe external login without blocking.
- A protected tool returns `login_required` when unauthenticated.
- A sandboxed API tool whose existing native backend is inaccessible returns
  one non-retryable `host_execution_required` result with the exact equivalent
  host CLI `argv`/`cwd`; read and write bodies round-trip without shell
  interpolation, and the response never suggests another MCP retry or login.
  A second tool call for that origin does not probe the keyring again.
- The returned login command always pins the MCP process's selected profile,
  including `production`, and is unaffected by later default-profile changes.
- Its authoritative login `argv`/`cwd` use canonical setup paths and remain
  safe when checkout paths contain spaces or shell metacharacters.
- After login, the same tool succeeds without restarting the MCP client.
- Invalid, expired, and revoked tokens each produce one login-required
  response, not an infinite retry loop.
- Unknown profiles remain diagnosable as non-retryable configuration errors
  without network access.
- Invalid environment credentials return a non-retryable environment-specific
  error with an MCP-restart instruction rather than an ineffective login
  command.
- Rate-limit and audit-unavailable responses remain transient service errors,
  not `login_required`.
- TLS/redirect/protocol failures remain non-retryable server-configuration
  errors, while bounded connectivity failures never masquerade as auth loss.
- MCP never exposes the raw bearer token in tool output.
- Control characters or instruction-like text in an API username remain
  escaped untrusted data and cannot corrupt MCP framing or server guidance.
- `social_vibecoding.whoami` calls only the identity-read endpoint;
  `api_read` and `api_write` cover allowed user-facing JSON APIs without a
  hardcoded per-endpoint registry or direct GitHub access.
- `proposal_push_commit` returns the canonical host `proposal push` vector
  without a native-store probe. The host CLI snapshots only the exact named
  one-parent commit, and its payload preserves blob bytes, deletions, modes,
  parent tree, and final tree without reading uncommitted working-tree data.
- Commit upload reconstructs through GitHub App credentials, rejects path/
  mode/base64/size violations, parent-tree or final-tree mismatches, stale
  branch tips, merge commits, and non-fast-forward ref races. It supports a
  second local commit whose parent commit SHA differs from the preceding bot
  SHA but whose parent tree is identical, and lost-response retries create no
  duplicate commit.
- Upload alone records an `uploaded` revision, invalidates any earlier check
  verdict, and starts no staging/check run; only `proposal_submit_build` may
  mark it pending and start staging.
- Production is selected unless the prompt explicitly requests local. A local
  call with no ready stack returns an authoritative `make up` vector, and a
  missing credential returns a login vector; the agent executes either itself
  and retries the original request after health or browser approval.
- Project-local configuration launches the checked-in CLI as `mcp` and may
  select only a validated profile name, never an origin, environment value, or
  nonallowlisted forwarded variable; its tool allowlist contains only the ten
  reviewed tools.
- `codex setup` writes canonical absolute Node/script/checkout paths to the
  ignored project config, works across Codex working-directory differences,
  is idempotent for its own file, and refuses symlinked or non-generated
  targets without overwriting them.
- `codex setup` pins approval review to the user for this project, configures
  `proposal_promote` to prompt, and installs a protected hook that rejects the
  direct generic-API and literal-shell promotion paths. An approved
  native-store fallback is limited to one exact host tool call, Codex session,
  turn, proposal ID, and a ten-minute window.
- A prompt-time health attestation lets Codex CLI detect that this hook is
  active; when the attestation is absent there, it asks the user to review
  `/hooks` and refuses proposal promotion until a later prompt proves the
  guard is active. ChatGPT desktop and Claude Code do not apply this CLI check.
- `claude setup` registers the same canonical credential-free command through
  `claude mcp` local scope, refuses an unowned same-name collision, repairs a
  missing owned registration, updates moved paths/profile selections with
  rollback, and maintains only an ignored atomic ownership marker in the
  checkout.
- Root `CLAUDE.md` imports the always-on `AGENTS.md`; `.claude/skills/`
  links to the canonical `.agents/skills/`, giving Claude Code and Codex the
  same on-demand setup, login, production/local selection, generic API, and
  retry guidance.
- Setup forwards no environment variables by default; its explicit opt-in
  forwards only the two documented variable names and never persists values.
- Setup emits the required MCP restart/reload instruction after a material
  configuration change.

## Implementation order

1. Add migrations, token hashing helpers, state constraints, durable security
   audit storage, and retention cleanup.
2. Implement rate-limited device-code creation, atomic polling, browser
   approval, safe login return, CSRF/security headers, environment gating, and
   their transactional audit writes.
3. Add locked origin-bound credential/profile storage and CLI login/status/
   self-revocation/logout commands.
4. Add retained-token and rate-limited active-token middleware, durable usage
   auditing, self-service token endpoints, `GET /api/cli/rpc/me`, and scoped
   bearer authentication for allowed user-facing JSON APIs; integrate the
   shared account-recovery cancellation/revocation helper.
5. Add paginated Settings token listing/revocation, service-worker exclusions,
   and ownership/cache tests.
6. Add `codex setup`, `claude setup`, their ignored machine-local ownership
   state, shared agent guidance, the project-local MCP server, identity tool,
   and generic read/mutation API tools.
7. Add automatic production/local selection guidance plus
   `local_setup_required`, `login_required`, and
   `reauthorization_required` retry contracts.
8. Add native CLI proposal handoff storage/routes, GitHub-App-backed exact-tree
   commit upload, pinned-commit branch adoption, shared transcript/spec
   context, staging/check orchestration, and the seven proposal workflow tools
   for Codex and Claude.
9. Add operational metrics and audit-retention monitoring.
