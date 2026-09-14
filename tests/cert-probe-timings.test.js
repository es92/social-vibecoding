// #767: caddy.probeEdge — phase timings and cert introspection.
//
// The old warmCert was one opaque pass/fail with a 120s bound, sized for
// the on-demand ZeroSSL era. probeEdge replaces it with a measured probe:
// TCP connect / TLS handshake / first byte split apart, plus the issuer,
// serial and expiry of the cert actually served. That is what answers "did
// the cert path get slower after the provider switch".
//
// Tests run against a real local TLS server with a self-signed wildcard
// cert, so getPeerCertificate() returns the genuine node shape rather than
// a hand-rolled fake. CADDY_HOST is pointed at 127.0.0.1 and the probe's
// hardcoded :443 is redirected by stubbing https.request's port.
//
// Run with: node --test tests/cert-probe-timings.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Generate a self-signed wildcard cert with openssl. Returns null if
// openssl isn't available so the suite skips rather than fails.
let keypair = null;
function wildcardCert() {
  if (keypair !== undefined && keypair !== null) return keypair;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certprobe-'));
  const keyPath = path.join(dir, 'k.pem');
  const certPath = path.join(dir, 'c.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '30',
      '-subj', '/O=Homeroom Test CA/CN=*.example.test',
      '-addext', 'subjectAltName=DNS:*.example.test,DNS:example.test',
    ], { stdio: 'ignore' });
  } catch {
    keypair = null;
    return null;
  }
  keypair = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  return keypair;
}

// Start a TLS server and make caddy.js's probe reach it: the probe
// hardcodes port 443, so wrap https.request to rewrite the port.
async function withServer(handler, fn) {
  const pair = wildcardCert();
  if (!pair) return 'skip';
  const server = https.createServer({ key: pair.key, cert: pair.cert }, handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const ids = {
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/caddy'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const logs = [];
  stub(ids.logger, {
    info: (cat, msg, data) => logs.push({ level: 'info', cat, msg, data }),
    warn: (cat, msg, data) => logs.push({ level: 'warn', cat, msg, data }),
    error: (cat, msg, data) => logs.push({ level: 'error', cat, msg, data }),
    debug() {},
  });

  const realRequest = https.request;
  https.request = (opts, cb) => realRequest({ ...opts, port }, cb);
  const prevHost = process.env.CADDY_HOST;
  process.env.CADDY_HOST = '127.0.0.1';

  delete require.cache[ids.subject];
  const caddy = require(ids.subject);

  try {
    return await fn(caddy, logs, server);
  } finally {
    https.request = realRequest;
    if (prevHost === undefined) delete process.env.CADDY_HOST;
    else process.env.CADDY_HOST = prevHost;
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    await new Promise((r) => server.close(r));
  }
}

test('handshakeOnly reports timings and cert facts without sending a request', async (t) => {
  let sawRequest = false;
  const out = await withServer((req, res) => { sawRequest = true; res.end('hi'); }, async (caddy) => {
    return caddy.probeEdge('app.example.test');
  });
  if (out === 'skip') return t.skip('openssl unavailable');

  assert.equal(out.ok, true);
  assert.equal(out.code, null, 'handshake-only mode never gets an HTTP status');
  assert.equal(sawRequest, false, 'handshakeOnly must not send a request line');

  // Monotonic phase timings: connect happens before the handshake finishes,
  // and everything lands inside the total.
  assert.equal(typeof out.timings.connectMs, 'number');
  assert.equal(typeof out.timings.tlsMs, 'number');
  assert.equal(typeof out.timings.totalMs, 'number');
  assert.ok(out.timings.connectMs >= 0);
  assert.ok(out.timings.tlsMs >= 0);
  assert.ok(out.timings.connectMs + out.timings.tlsMs <= out.timings.totalMs + 5);
  assert.equal(out.timings.ttfbMs, null, 'no request means no first byte');

  // Cert facts read off the live handshake.
  assert.ok(out.cert, 'peer certificate must be summarized');
  assert.equal(out.cert.subject, '*.example.test');
  assert.match(out.cert.issuer, /Homeroom Test CA/);
  assert.ok(out.cert.serialNumber, 'serial identifies a re-issue / provider change');
  assert.ok(out.cert.validTo);
  assert.equal(typeof out.cert.daysToExpiry, 'number');
  assert.ok(out.cert.daysToExpiry > 0 && out.cert.daysToExpiry <= 30);
  assert.equal(out.cert.isWildcard, true);
  assert.equal(out.cert.sanMatched, true, 'app.example.test is covered by *.example.test');
  assert.equal(out.tlsReused, false);
});

test('handshakeOnly:false completes the request and reports a status + ttfb', async (t) => {
  const out = await withServer((req, res) => { res.statusCode = 204; res.end(); }, async (caddy) => {
    return caddy.probeEdge('app.example.test', { handshakeOnly: false });
  });
  if (out === 'skip') return t.skip('openssl unavailable');

  assert.equal(out.ok, true);
  assert.equal(out.code, 204);
  assert.equal(typeof out.timings.ttfbMs, 'number');
  assert.ok(out.timings.ttfbMs >= out.timings.connectMs);
  assert.ok(out.cert, 'cert facts are collected in full-request mode too');
});

test('sanMatched is false for a host the cert does not cover', async (t) => {
  const out = await withServer((req, res) => res.end(), async (caddy) => {
    // One-level wildcard: *.example.test does not cover a deeper label.
    return caddy.probeEdge('deep.app.example.test');
  });
  if (out === 'skip') return t.skip('openssl unavailable');
  assert.equal(out.ok, true, 'rejectUnauthorized is off — we observe, not abort');
  assert.equal(out.cert.sanMatched, false);
});

test('warmCert stays a back-compat wrapper over probeEdge', async (t) => {
  const out = await withServer((req, res) => res.end(), async (caddy) => {
    const seen = [];
    const r = await caddy.warmCert('app.example.test', {
      onResult: (err, code) => seen.push({ err, code }),
    });
    return { r, seen };
  });
  if (out === 'skip') return t.skip('openssl unavailable');

  // Old shape preserved for the seven existing call sites...
  assert.equal(out.r.ok, true);
  assert.ok('code' in out.r);
  assert.equal(out.r.error, null);
  // ...plus the new fields.
  assert.ok(out.r.timings);
  assert.ok(out.r.cert);
  // The onResult callback contract is unchanged.
  assert.equal(out.seen.length, 1);
  assert.equal(out.seen[0].err, null);
});

test('a probe logs one line carrying the durations and issuer', async (t) => {
  const out = await withServer((req, res) => res.end(), async (caddy, logs) => {
    await caddy.probeEdge('app.example.test');
    return logs;
  });
  if (out === 'skip') return t.skip('openssl unavailable');

  const line = out.find((l) => l.msg === 'Edge probe');
  assert.ok(line, 'a healthy probe logs at info');
  assert.equal(line.cat, 'caddy');
  assert.equal(line.data.hostname, 'app.example.test');
  assert.equal(typeof line.data.totalMs, 'number');
  assert.equal(typeof line.data.tlsMs, 'number');
  assert.match(line.data.issuer, /Homeroom Test CA/);
  assert.equal(typeof line.data.daysToExpiry, 'number');
});

test('an empty hostname resolves ok:false instead of throwing', async (t) => {
  const out = await withServer((req, res) => res.end(), async (caddy) => caddy.probeEdge(''));
  if (out === 'skip') return t.skip('openssl unavailable');
  assert.equal(out.ok, false);
  assert.ok(out.error instanceof Error);
});

// summarizeCert / matchesName are pure, so they get direct coverage of the
// edge cases a live handshake can't easily produce.
test('matchesName implements one-level wildcard matching', () => {
  const caddy = require('../src/services/caddy');
  assert.equal(caddy.matchesName('*.a.b', 'x.a.b'), true);
  assert.equal(caddy.matchesName('*.a.b', 'x.y.a.b'), false, 'wildcards cover one label only');
  assert.equal(caddy.matchesName('*.a.b', 'a.b'), false, 'a wildcard does not cover the apex');
  assert.equal(caddy.matchesName('a.b', 'a.b'), true);
  assert.equal(caddy.matchesName('A.B', 'a.b'), true, 'hostnames are case-insensitive');
});

test('summarizeCert tolerates a missing / malformed certificate', () => {
  const caddy = require('../src/services/caddy');
  assert.equal(caddy.summarizeCert(null, 'a.b'), null);
  assert.equal(caddy.summarizeCert({}, 'a.b'), null, 'an empty peer cert object is not a cert');
  const partial = caddy.summarizeCert({ subject: { CN: 'a.b' } }, 'a.b');
  assert.equal(partial.subject, 'a.b');
  assert.equal(partial.validTo, null);
  assert.equal(partial.daysToExpiry, null);
  assert.equal(partial.isWildcard, false);
});

// Keep the TLS/X509 imports honest — unused imports here would mean the
// wildcard-cert fixture silently stopped being exercised.
test('the fixture really is a wildcard certificate', (t) => {
  const pair = wildcardCert();
  if (!pair) return t.skip('openssl unavailable');
  const x = new X509Certificate(pair.cert);
  assert.match(x.subject, /\*\.example\.test/);
  assert.ok(tls.rootCertificates.length >= 0);
});


for (const [runtime, override, expected] of [
  ['kubernetes', null, 'preview.example.test'],
  ['kubernetes', 'ingress.internal', 'ingress.internal'],
  ['docker', null, 'caddy'],
]) {
  test(`edge probe routes ${runtime} with override ${override}`, async (t) => {
    const prior = { APP_RUNTIME: process.env.APP_RUNTIME, CADDY_HOST: process.env.CADDY_HOST };
    process.env.APP_RUNTIME = runtime;
    if (override) process.env.CADDY_HOST = override; else delete process.env.CADDY_HOST;
    t.after(() => { for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    let options;
    t.mock.method(https, 'request', opts => { options = opts; throw new Error('test connection'); });
    await require('../src/services/caddy').probeEdge('preview.example.test');
    assert.equal(options.host, expected);
    assert.equal(options.servername, 'preview.example.test');
    assert.equal(options.headers.Host, 'preview.example.test');
    assert.equal(options.port, 443);
  });
}
