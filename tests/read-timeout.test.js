'use strict';

// frontend/src/lib/read-timeout.ts: a page read with no answer is given up.
//
// On a network that passes nothing the browser still says it is online, and
// a request neither answers nor fails: Home sat on its skeleton and a
// conversation on "Loading messages…" for a minute or more, with no offline
// banner, and a read begun then held its screen after the network came back
// (offline test, 2 Nov 2026). A same-origin GET under /api/ now gives up when
// no response has arrived in READ_TIMEOUT_MS, rejecting as a network failure
// does, and nudges the connectivity probe. Driven with a fake window whose
// fetch never answers unless told to, and Node's mock timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const MOD = 'frontend/src/lib/read-timeout.ts';
const ORIGIN = 'https://app.onhomeroom.com';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function harness(t, { offline = false, timers = true } = {}) {
  if (timers) t.mock.timers.enable({ apis: ['setTimeout'] });
  const mod = loadTsx(MOD);
  const calls = [];
  const nudges = [];
  const win = {
    location: { href: `${ORIGIN}/`, origin: ORIGIN },
    Offline: { isOffline: () => offline, nudge: () => nudges.push(1) },
    fetch: (input, init) => new Promise((resolve, reject) => {
      const call = { input, init, resolve, reject };
      calls.push(call);
      const signal = init && init.signal;
      if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  mod.installReadTimeout(win);
  return { mod, win, calls, nudges };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a read with no answer is given up as a network failure, and the probe is nudged', async (t) => {
  const h = harness(t);
  const pending = h.win.fetch('/api/apps');
  let outcome = null;
  pending.then(() => { outcome = 'resolved'; }, (error) => { outcome = error; });
  t.mock.timers.tick(h.mod.READ_TIMEOUT_MS - 1);
  await tick();
  assert.equal(outcome, null, 'not before the limit');
  t.mock.timers.tick(1);
  await tick();
  assert.ok(outcome instanceof TypeError, 'rejected the way a fetch the network refused is');
  assert.equal(outcome.name, 'TypeError', 'callers that test the name see a network failure');
  assert.equal(h.mod.isReadTimeout(outcome), true);
  assert.equal(h.calls[0].init.signal.aborted, true, 'and the request that went out is aborted');
  assert.equal(h.nudges.length, 1);
  assert.equal(h.mod.READ_TIMEOUT_MS, 15_000);
});

test('a read that answers in time is the caller\'s, body and all', async (t) => {
  const h = harness(t);
  const pending = h.win.fetch('/api/apps', { cache: 'no-cache' });
  t.mock.timers.tick(5_000);
  const body = { ok: true, status: 200, json: async () => ({ apps: [] }) };
  h.calls[0].resolve(body);
  const res = await pending;
  assert.equal(res, body);
  assert.equal(h.calls[0].init.cache, 'no-cache', 'the caller\'s init goes out as it was');
  t.mock.timers.tick(60_000);
  assert.equal(h.calls[0].init.signal.aborted, false, 'the limit ends when the headers land');
  assert.deepEqual(await res.json(), { apps: [] });
  assert.equal(h.nudges.length, 0);
});

test('the caller\'s own signal still cancels, and a cancel is not a network failure', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const pending = h.win.fetch('/api/conversations/5', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.calls[0].init.signal.aborted, true, 'the request that went out is aborted');
  assert.equal(h.nudges.length, 0, 'a cancel does not nudge the probe');

  // A body read after the headers stays cancellable by the caller too.
  const later = new AbortController();
  const second = h.win.fetch(new Request(`${ORIGIN}/api/apps`, { signal: later.signal }));
  h.calls[1].resolve({ ok: true, status: 200 });
  await second;
  later.abort();
  assert.equal(h.calls[1].init.signal.aborted, true);

  // And the limit never aborts the caller's own controller.
  const mine = new AbortController();
  const third = h.win.fetch('/api/apps', { signal: mine.signal });
  t.mock.timers.tick(h.mod.READ_TIMEOUT_MS);
  await assert.rejects(third, TypeError);
  assert.equal(mine.signal.aborted, false);
});

test('writes, other origins, /health, the admin console and event streams are never bounded', async (t) => {
  const h = harness(t);
  const unbounded = [
    ['/api/conversations/5/messages', { method: 'POST', body: '{}' }],
    ['https://example.com/api/apps', undefined],
    ['/health', undefined],
    ['/api/admin/overview', undefined],
    ['/api/v4/admin/users', undefined],
    ['/api/sessions/7/stream', { headers: { Accept: 'text/event-stream' } }],
    ['/api/apps', { readTimeout: false }],
  ];
  const pending = unbounded.map(([url, init]) => h.win.fetch(url, init));
  for (const p of pending) p.catch(() => {});
  t.mock.timers.tick(10 * 60_000);
  await tick();
  assert.equal(h.calls.length, unbounded.length);
  for (const call of h.calls) {
    assert.ok(!call.init || !call.init.signal, `${call.input} carries no limit`);
    assert.ok(!call.init || !('readTimeout' in call.init), 'the option is not passed on');
  }
});

test('a caller with a longer limit of its own keeps it', async (t) => {
  const h = harness(t);
  const pending = h.win.fetch('/api/apps/demo/messages?limit=50', { readTimeout: 30_000 });
  let outcome = null;
  pending.catch((error) => { outcome = error; });
  t.mock.timers.tick(29_999);
  await tick();
  assert.equal(outcome, null, 'the page\'s 15 s does not cut it short');
  t.mock.timers.tick(1);
  await tick();
  assert.ok(outcome instanceof TypeError);
  assert.ok(!('readTimeout' in h.calls[0].init));
});

test('a same-origin request that fails outright nudges the probe, unless it already says offline', async (t) => {
  const h = harness(t);
  const write = h.win.fetch('/api/conversations/5/messages', { method: 'POST', body: '{}' });
  h.calls[0].reject(new TypeError('Load failed'));
  await assert.rejects(write, /Load failed/);
  assert.equal(h.nudges.length, 1, 'a write that could not go out says the same as a read');

  const answered = h.win.fetch('/api/apps');
  h.calls[1].resolve({ ok: false, status: 500 });
  assert.equal((await answered).status, 500);
  assert.equal(h.nudges.length, 1, 'an answer, even a failed one, is not a network failure');

  const offline = harness(t, { offline: true, timers: false });
  const read = offline.win.fetch('/api/apps');
  offline.calls[0].reject(new TypeError('Load failed'));
  await assert.rejects(read, TypeError);
  assert.equal(offline.nudges.length, 0, 'offline already: the probe\'s own loop is watching');
});

test('it is installed outermost, after every other fetch wrapper', () => {
  const main = read('frontend/src/main.tsx');
  const at = (step) => main.indexOf(`bootStep('${step}'`);
  assert.ok(at('installReadTimeout') > 0);
  for (const inner of ['installApiCacheIdentity', 'installJoinRequired', 'installAdultGate', 'installSessionRenewalRetry']) {
    assert.ok(at(inner) > 0 && at(inner) < at('installReadTimeout'), `${inner} is inside it`);
  }
  assert.ok(at('installReadTimeout') < at('hydrate'), 'and before anything can read');
});

test('through the real wrappers, a native identity check begun on a dead network gives way', async (t) => {
  // ./api-cache-identity.ts makes every read wait on one /api/auth/me after a
  // native session renewal. Begun on a dead network, it held every later read
  // for as long as the web view kept it open, the network's return included.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { installApiCacheIdentity } = loadTsx('frontend/src/lib/api-cache-identity.ts');
  const { installSessionRenewalRetry } = loadTsx('frontend/src/lib/session-renewal-retry.ts');
  const { installReadTimeout, READ_TIMEOUT_MS } = loadTsx(MOD);
  const A = 'a'.repeat(64);
  let cookie = `usernode_api_scope=${A}`;
  let dead = true;
  const sent = [];
  const renewal = { epoch: 0, settled: null };
  const win = {
    document: { get cookie() { return cookie; }, set cookie(value) { cookie = value.split(';')[0]; } },
    location: { href: `${ORIGIN}/`, origin: ORIGIN, reload() {} },
    addEventListener() {},
    localStorage: { setItem() {} },
    NativeChrome: { webSessionRenewal: () => ({ ...renewal }) },
    Offline: { isOffline: () => false, nudge() {} },
    fetch: (req, init) => {
      sent.push(new URL(req.url).pathname);
      if (dead) {
        return new Promise((_resolve, reject) => {
          const signal = (init && init.signal) || req.signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const me = new URL(req.url).pathname === '/api/auth/me';
      return Promise.resolve(new Response(JSON.stringify(me ? { user: { id: 101 } } : { fake: 'current' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Usernode-Cache-Scope': A,
          'X-Usernode-Cache-Expires': new Date(Date.now() + 86400_000).toISOString(),
        },
      }));
    },
  };
  installApiCacheIdentity(win);
  installSessionRenewalRetry(win);
  installReadTimeout(win);
  win.UsernodeReact.apiCache.setViewer(101);
  renewal.epoch += 1;

  const first = win.fetch('/api/private');
  first.catch(() => {});
  await tick();
  assert.deepEqual(sent, ['/api/auth/me'], 'the read waits on the identity check');
  t.mock.timers.tick(READ_TIMEOUT_MS);
  await tick();
  await assert.rejects(first, TypeError);

  dead = false;
  const second = await win.fetch('/api/private');
  assert.deepEqual(await second.json(), { fake: 'current' }, 'the next read is not stuck behind it');
  assert.deepEqual(sent, ['/api/auth/me', '/api/auth/me', '/api/private']);
});
