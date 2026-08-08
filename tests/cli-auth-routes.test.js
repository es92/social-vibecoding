'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');
const queries = [];
const pool = {
  async query(sql, params) {
    queries.push({ sql, params });
    if (/clock_timestamp\(\) AS now/.test(sql)) {
      return { rows: [{ now: new Date() }], rowCount: 1 };
    }
    if (/FROM cli_auth_rate_limits/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  },
};
poolModule.getPool = () => pool;

delete require.cache[require.resolve('../src/routes/cli-auth')];
const {
  cliAuthGate,
  cliPreAuthRoutes,
  isCliSurfaceEnabled,
} = require('../src/routes/cli-auth');

const config = {
  cliAuthEnabled: true,
  cliAuthOrigin: 'https://social-vibecoding.usernodelabs.org',
  cliDeviceCreateRatePerMinute: 10,
  cliDeviceCreateBurst: 20,
  cliDeviceLivePerIp: 10,
  cliDeviceLiveGlobal: 10000,
};

function startApp() {
  const app = express();
  app.set('trust proxy', false);
  app.use(cliAuthGate(config));
  app.use(cliPreAuthRoutes(config));
  app.use((_req, res) => res.status(418).json({ error: 'fallback' }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function base(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('staging gate is authoritative before the approval shell and database', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  queries.length = 0;
  const server = await startApp();
  try {
    for (const pathname of [
      '/cli/authorize',
      '/api/cli/device/code',
      '/api/me/cli-tokens/42',
    ]) {
      const response = await fetch(`${base(server)}${pathname}`, {
        method: pathname.includes('device/code') ? 'POST' : 'GET',
        headers: pathname.includes('device/code')
          ? { 'Content-Type': 'application/json' } : {},
        body: pathname.includes('device/code') ? '{}' : undefined,
      });
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    }
    assert.equal(queries.length, 0);
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
    server.close();
  }
});

// ── The advertised capability must match the gate ────────────────────
//
// The Settings screen has to know NOT to request the CLI surface where
// it is gated off: a 404 the client swallows is still an error line in
// the page console, and the proposal checks fail any route that logs
// one. That only works if what GET /api/auth/me advertises and what the
// gate actually serves come from ONE predicate — hence
// isCliSurfaceEnabled, asserted here against both inputs it reads.

test('isCliSurfaceEnabled is false in staging and whenever cliAuthEnabled is off', () => {
  const previous = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    assert.equal(isCliSurfaceEnabled({ cliAuthEnabled: true }), false,
      'a staging preview must never expose the CLI surface — unreviewed PR '
      + 'code must not be able to mint CLI tokens');

    process.env.USERNODE_ENV = 'production';
    assert.equal(isCliSurfaceEnabled({ cliAuthEnabled: false }), false,
      'a deployment without a valid canonical CLI origin serves no CLI surface');
    assert.equal(isCliSurfaceEnabled({ cliAuthEnabled: true }), true,
      'production with CLI auth configured serves it');
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('the gate 404s exactly when isCliSurfaceEnabled says so', async () => {
  // Pins the two to the same answer through the real middleware, so a
  // future edit to one can't silently diverge from the other.
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const server = await startApp();
  try {
    assert.equal(isCliSurfaceEnabled({ cliAuthEnabled: true }), false);
    const response = await fetch(`${base(server)}/api/me/cli-tokens?limit=50`);
    assert.equal(response.status, 404,
      'the gate and the advertised capability must agree');
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
    server.close();
  }
});

test('the settings screen skips the request when the surface is unavailable', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8'
  );

  assert.match(settings, /_cliAuthAvailable\(\)\s*\{/,
    'settings.js must resolve the capability before fetching');
  assert.match(settings, /cliAuthEnabled !== false/,
    'only an explicit false suppresses the request — unknown/older shells '
    + 'must behave exactly as before');

  // The gate has to sit BEFORE the fetch, or the console error still
  // happens. Anchor on the load function and check the order.
  const fn = settings.slice(settings.indexOf('async _loadCliTokens(reset)'));
  const gateAt = fn.indexOf('await this._cliAuthAvailable()');
  const fetchAt = fn.indexOf('/api/me/cli-tokens');
  assert.ok(gateAt > -1, '_loadCliTokens must consult the capability');
  assert.ok(fetchAt > -1, '_loadCliTokens must still fetch when available');
  assert.ok(gateAt < fetchAt,
    'the capability check must precede the fetch — a request issued and '
    + 'then handled still logs a console error');

  // The 404 branch stays as the backstop for a stale shell.
  assert.match(fn.slice(0, fetchAt + 2000), /response\.status === 404/,
    'the graceful 404 handling must remain');
});

test('/api/auth/me advertises the CLI capability from the shared predicate', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const auth = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8'
  );
  assert.match(auth, /isCliSurfaceEnabled/,
    'auth.js must import the gate\'s own predicate, not re-derive it');
  assert.match(auth, /cliAuthEnabled: isCliSurfaceEnabled\(config\)/,
    'the me payload must carry the flag the Settings screen reads');
  assert.ok(!/cliAuthEnabled:\s*!!config\.cliAuthEnabled/.test(auth),
    'must not advertise config.cliAuthEnabled directly — that misses the '
    + 'staging exclusion the gate applies');
});

test('approval shell is state-free, noncacheable, and frame protected', async () => {
  const previous = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  queries.length = 0;
  const server = await startApp();
  try {
    const response = await fetch(`${base(server)}/cli/authorize`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /Authorize CLI access/);
    assert.equal(queries.length, 0);
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
    server.close();
  }
});

test('device creation parser rejects malformed, duplicate, and oversized JSON before DB use', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    for (const body of [
      '{"scopes":',
      '{"scopes":[],"scopes":["rpc:identity:read"]}',
    ]) {
      const response = await fetch(`${base(server)}/api/cli/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const oversized = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['x'.repeat(5000)] }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

test('client identity injection is invalid_request while unsupported scopes are invalid_scope', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    let response = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopes: ['rpc:identity:read'],
        client_id: 'other',
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });

    response = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['rpc:read'] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_scope' });
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

test('unknown RPC paths terminate before cookie middleware fallthrough', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    for (const pathname of ['/api/cli/rpc/not-a-tool', '/api/cli/not-a-route']) {
      const response = await fetch(`${base(server)}${pathname}`, {
        headers: { Cookie: 'session=ambient-browser-cookie' },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'not_found' });
    }
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

// ── #907: the local-agent surfaces ─────────────────────────────────────────

test('the agent protocol is behind the same staging gate as the rest of the CLI', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  queries.length = 0;
  const server = await startApp();
  try {
    for (const pathname of [
      '/api/cli/agent/attach',
      '/api/cli/agent/heartbeat',
      '/api/cli/agent/turns/next',
      '/api/cli/agent/detach',
    ]) {
      const response = await fetch(`${base(server)}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    }
    assert.equal(queries.length, 0, 'the gate answers before any database work');
  } finally {
    server.close();
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('the Settings machine list is deliberately not a CLI surface', async () => {
  // A lease grants nothing — it only says which machine the next coding turn
  // of one session goes to. Keeping it off isCliSurface() is what makes the
  // Settings block reviewable on staging, where the credential surfaces 404.
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const server = await startApp();
  try {
    const response = await fetch(`${base(server)}/api/me/local-agents`);
    // 418 is this harness's "nothing matched" fallback: the gate let it past
    // rather than 404ing it, and the browser router (not mounted here) owns it.
    assert.equal(response.status, 418);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('the agent protocol never falls through to browser cookie handling', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    // An unauthenticated request must get the bearer challenge, and an
    // unknown agent path must terminate — never reach an ambient session.
    const unknown = await fetch(`${base(server)}/api/cli/agent/not-a-route`, {
      headers: { Cookie: 'session=ambient-browser-cookie' },
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found' });

    const attach = await fetch(`${base(server)}/api/cli/agent/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'session=ambient-browser-cookie' },
      body: JSON.stringify({ sessionId: 1, label: 'laptop' }),
    });
    assert.equal(attach.status, 401);
    assert.match(attach.headers.get('www-authenticate') || '', /Bearer/);
  } finally {
    server.close();
  }
});

test('both local-agent browser routes are no-store and terminate on a bad method', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/cli-auth.js'), 'utf8');
  // Lists a route can silently fall out of. The list membership IS the
  // behaviour: miss the noStore entry and a machine list gets cached by a
  // proxy; miss the router.all entry and a stray verb reaches the SPA shell.
  for (const list of [/\], noStore\);/, /\], \(_req, res\) => \{\n\s+res\.status\(404\)/]) {
    const at = source.search(list);
    assert.ok(at > 0);
  }
  // Two list memberships (noStore, terminal 404) plus the GET handler itself.
  assert.equal((source.match(/^\s+'\/api\/me\/local-agents',$/gm) || []).length, 2);
  assert.equal((source.match(/^\s+'\/api\/me\/local-agents\/\*',$/gm) || []).length, 2);
  assert.match(source, /router\.get\('\/api\/me\/local-agents', userRate/);
  assert.match(source, /router\.delete\('\/api\/me\/local-agents\/:leaseId', userRate/);
});
