// Tests for the anonymous-shell probe (src/services/shell-probe.js),
// which classifies each app's shell + API gate as public / gated / unknown for
// the landing page's app directory:
//   - classifyResponse: the pure decision table.
//   - probeUrl: live classification against a throwaway local server,
//     including same-origin redirect following, redirect caps, and
//     connection failures.
//   - probeApp: persists the verdict through the pool.
//
// Run with: node --test tests/shell-probe.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  classifyResponse,
  probeUrl,
  probeApp,
  selectDueApps,
  appShellUrl,
} = require('../src/services/shell-probe');

// ─── classifyResponse (pure) ──────────────────────────────────────

test('classify: 2xx is public', () => {
  assert.equal(classifyResponse(200, null, 'http://a:3000/'), 'public');
  assert.equal(classifyResponse(204, null, 'http://a:3000/'), 'public');
});

test('classify: 401/403 are gated', () => {
  assert.equal(classifyResponse(401, null, 'http://a:3000/'), 'gated');
  assert.equal(classifyResponse(403, null, 'http://a:3000/'), 'gated');
});

test('classify: off-origin redirect is gated (bounce to the platform)', () => {
  assert.equal(
    classifyResponse(302, 'https://social-vibecoding.usernodelabs.org/#login', 'http://a:3000/'),
    'gated'
  );
});

test('classify: a protocol or port change is off-origin too', () => {
  assert.equal(classifyResponse(302, 'https://a:3000/login', 'http://a:3000/'), 'gated');
  assert.equal(classifyResponse(302, 'http://a:4000/login', 'http://a:3000/'), 'gated');
});

test('classify: same-origin redirect is followed', () => {
  const verdict = classifyResponse(302, '/home.html', 'http://a:3000/');
  assert.deepEqual(verdict, { follow: 'http://a:3000/home.html' });
});

test('classify: 3xx without Location, bad Location, and 5xx are unknown', () => {
  assert.equal(classifyResponse(302, null, 'http://a:3000/'), 'unknown');
  assert.equal(classifyResponse(302, 'http://[broken', 'http://a:3000/'), 'unknown');
  assert.equal(classifyResponse(500, null, 'http://a:3000/'), 'unknown');
  assert.equal(classifyResponse(404, null, 'http://a:3000/'), 'unknown');
});

// ─── probeUrl (live, throwaway server) ────────────────────────────

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('probeUrl: open shell (200) → public', async () => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end('<html>hi</html>'); });
  try { assert.equal(await probeUrl(srv.url), 'public'); }
  finally { await srv.close(); }
});

for (const status of [401, 403]) {
  test(`probeUrl: a public index with an auth-required API (${status}) → gated (#1522)`, async () => {
    const requests = [];
    const srv = await serve((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      // The reported shape: static middleware serves index.html first, but
      // the default /api/ middleware still requires a platform identity.
      if (req.url === '/api/') { res.writeHead(status); res.end('Not authenticated'); return; }
      res.writeHead(200); res.end('<html>App shell</html>');
    });
    try {
      assert.equal(await probeUrl(srv.url), 'gated');
      assert.deepEqual(requests.map(r => r.url), ['/', '/api/']);
      for (const { headers } of requests) {
        for (const key of ['cookie', 'authorization', 'x-usernode-token', 'sec-fetch-dest']) {
          assert.equal(headers[key], undefined, `the probe stays anonymous: ${key}`);
        }
      }
    } finally { await srv.close(); }
  });
}

test('probeUrl: public static apps without an API stay public', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404); res.end('static app');
  });
  try { assert.equal(await probeUrl(srv.url), 'public'); }
  finally { await srv.close(); }
});

test('probeUrl: a missing shell is not confused with a missing API', async () => {
  const requests = [];
  const srv = await serve((req, res) => { requests.push(req.url); res.writeHead(404); res.end(); });
  try {
    assert.equal(await probeUrl(srv.url), 'unknown');
    assert.deepEqual(requests, ['/']);
  } finally { await srv.close(); }
});

test('probeUrl: an API failure is unknown, not proof of guest access', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(req.url === '/api/' ? 503 : 200); res.end();
  });
  try { assert.equal(await probeUrl(srv.url), 'unknown'); }
  finally { await srv.close(); }
});

test('probeUrl: an API redirect to sign-in is gated without following it', async () => {
  const requests = [];
  const srv = await serve((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/') res.writeHead(302, { location: 'https://platform.example/#login' });
    else res.writeHead(200);
    res.end();
  });
  try {
    assert.equal(await probeUrl(srv.url), 'gated');
    assert.deepEqual(requests, ['/', '/api/']);
  } finally { await srv.close(); }
});

test('probeUrl: same-origin API redirects still enforce the final auth verdict', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/api/') res.writeHead(302, { location: '/api/session' });
    else res.writeHead(req.url === '/api/session' ? 401 : 200);
    res.end();
  });
  try { assert.equal(await probeUrl(srv.url), 'gated'); }
  finally { await srv.close(); }
});

test('probeUrl: scaffold 401 "Open in Homeroom" page → gated', async () => {
  const requests = [];
  const srv = await serve((req, res) => { requests.push(req.url); res.writeHead(401); res.end('Open in Homeroom'); });
  try {
    assert.equal(await probeUrl(srv.url), 'gated');
    assert.deepEqual(requests, ['/'], 'a gated shell needs no second request');
  }
  finally { await srv.close(); }
});

test('probeUrl: same-origin redirect chain lands on 200 → public', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/home' }); res.end(); return; }
    res.writeHead(200); res.end('home');
  });
  try { assert.equal(await probeUrl(srv.url), 'public'); }
  finally { await srv.close(); }
});

test('probeUrl: off-origin redirect → gated', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(302, { location: 'https://platform.example/#login' }); res.end();
  });
  try { assert.equal(await probeUrl(srv.url), 'gated'); }
  finally { await srv.close(); }
});

test('probeUrl: same-origin redirect loop exceeds hop cap → unknown', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(302, { location: '/' }); res.end();
  });
  try { assert.equal(await probeUrl(srv.url), 'unknown'); }
  finally { await srv.close(); }
});

test('probeUrl: connection refused → unknown', async () => {
  // Grab a port that was just released so nothing is listening on it.
  const srv = await serve((req, res) => { res.end(); });
  await srv.close();
  assert.equal(await probeUrl(srv.url), 'unknown');
});

// ─── probeApp persistence ─────────────────────────────────────────

test('probeApp: writes the verdict + checked_at through the pool', async () => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end('open'); });
  const updates = [];
  const pool = {
    query: async (sql, params) => { updates.push({ sql: String(sql), params }); return { rows: [] }; },
  };
  try {
    // probeApp derives the URL from the slug via appShellUrl, which points
    // at the docker-network container name — unreachable from a unit test.
    // Point the slug's derived host at our local server by probing through
    // probeUrl-compatible plumbing: stub the app row and intercept via a
    // direct URL probe assertion above, then verify persistence here with
    // a slug whose container doesn't exist (verdict 'unknown').
    const verdict = await probeApp(pool, { id: 42, slug: 'no-such-container', anon_shell: 'unknown' });
    assert.equal(verdict, 'unknown');
    assert.equal(updates.length, 1);
    assert.match(updates[0].sql, /UPDATE apps SET anon_shell = \$1, anon_shell_checked_at = NOW\(\)/);
    assert.deepEqual(updates[0].params, ['unknown', 42]);
  } finally { await srv.close(); }
});

// ─── URL shape pin ────────────────────────────────────────────────

test('appShellUrl targets the shared-network container name on port 3000', () => {
  assert.equal(appShellUrl('my-app-ab12cd'), 'http://usernode-app-my-app-ab12cd:3000/');
});

test('selectDueApps: boot refreshes prior public verdicts without disturbing staging fixtures', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await selectDueApps(pool, true);
  await selectDueApps(pool);
  assert.equal(calls[0].params[1], true);
  assert.equal(calls[1].params[1], false, 'ordinary ticks keep the hourly recheck cadence');
  assert.match(calls[0].sql, /\$2::boolean AND anon_shell = 'public' AND anon_shell_checked_at <= NOW\(\)/);
  assert.match(calls[0].sql, /self_hosted IS NOT TRUE/);
  assert.match(calls[0].sql, /view_visibility = 'public'/);
});
