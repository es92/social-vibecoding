'use strict';

// #6591: Home's pins and the community scope both read the joined
// communities and the votes waiting on every page load, a few milliseconds
// apart, so each was asked for twice. `sharedJson` (lib/shared-read.ts) gives
// a reader the request already on its way for the same address. It is not a
// cache: nothing is kept once the answer lands.
//
// Run with: node --test tests/shared-read.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** A fetch whose answers land when the test says so. */
function heldFetch() {
  const calls = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), init: init || {}, resolve, reject });
  });
  return calls;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test.afterEach(() => { delete globalThis.fetch; });

test('readers at the same moment share one request, and nothing is kept once it lands', async () => {
  const { sharedJson } = loadTsx('frontend/src/lib/shared-read.ts');
  const calls = heldFetch();
  const a = sharedJson('/api/apps?scope=joined');
  const b = sharedJson('/api/apps?scope=joined');
  const other = sharedJson('/api/workshop/counts');
  assert.equal(calls.length, 2, 'one request per address');
  calls[0].resolve(ok({ apps: [1] }));
  calls[1].resolve(ok({ counts: {} }));
  assert.deepEqual(await a, { apps: [1] });
  assert.equal(await b, await a, 'the same answer');
  assert.deepEqual(await other, { counts: {} });

  const later = sharedJson('/api/apps?scope=joined');
  assert.equal(calls.length, 3, 'a read after the answer landed asks the server again');
  calls[2].resolve(ok({ apps: [1, 2] }));
  assert.deepEqual(await later, { apps: [1, 2] });
});

test('a read that needs the current answer never joins one made without it', async () => {
  const { sharedJson } = loadTsx('frontend/src/lib/shared-read.ts');
  const calls = heldFetch();
  const plain = sharedJson('/api/workshop/counts');
  const fresh = sharedJson('/api/workshop/counts', { fresh: true });
  assert.equal(calls.length, 2, 'the fresh read made its own request');
  assert.equal(calls[0].init.cache, undefined);
  assert.equal(calls[1].init.cache, 'no-cache');
  assert.equal(calls[1].init.credentials, 'same-origin');
  // One that does not need it may join the fresh one.
  const joiner = sharedJson('/api/workshop/counts');
  assert.equal(calls.length, 2);
  calls[0].resolve(ok({ counts: { a: { needs: 1 } } }));
  calls[1].resolve(ok({ counts: { a: { needs: 2 } } }));
  assert.equal((await plain).counts.a.needs, 1);
  assert.equal((await fresh).counts.a.needs, 2);
  assert.equal((await joiner).counts.a.needs, 2);
});

test('a failed request fails for everyone sharing it, and the next read tries again', async () => {
  const { sharedJson } = loadTsx('frontend/src/lib/shared-read.ts');
  const calls = heldFetch();
  const a = sharedJson('/api/x');
  const b = sharedJson('/api/x');
  calls[0].resolve({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(a, /HTTP 503/);
  await assert.rejects(b, /HTTP 503/);
  const again = sharedJson('/api/x');
  assert.equal(calls.length, 2);
  calls[1].reject(new Error('offline'));
  await assert.rejects(again, /offline/);
  const third = sharedJson('/api/x');
  assert.equal(calls.length, 3);
  calls[2].resolve(ok({ fine: true }));
  assert.deepEqual(await third, { fine: true });
});

test('both stores read the joined communities and the counts through it', () => {
  const pins = read('frontend/src/features/home/home-pins-store.ts');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  assert.match(pins, /sharedJson<any>\('\/api\/apps\?scope=joined'\)/);
  assert.match(pins, /sharedJson<any>\('\/api\/workshop\/counts', \{ fresh: true \}\)/, 'Home still asks for the current numbers (request 6500)');
  assert.match(scope, /sharedJson<any>\(`\/api\/apps\?scope=joined\$\{q\.replace\('\?', '&'\)\}`\)/);
  assert.match(scope, /sharedJson<any>\(`\/api\/workshop\/counts\$\{q\}`, \{ fresh: force \}\)/, 'a forced read asks past the saved copy');
});

// The public directory is the slowest request the shell makes, and Home
// stays mounted behind every other screen: it is read when Home is shown.
test('Home reads the public directory only while it is the screen on show', () => {
  const join = read('frontend/src/features/home/home-join.tsx');
  assert.match(join, /const shown = useVisibility\('home-screen', true\);/);
  assert.match(join, /if \(!shown\) return undefined;\n\s+let live = true;/);
  assert.match(join, /\}, \[attempt, shown\]\);/);
  const frame = read('frontend/src/features/home/frame/home-frame.tsx');
  assert.match(frame, /if \(!pins\.ready \|\| !shown\) return undefined;/);
  assert.match(frame, /\}, \[pins\.ready, attempt, shown\]\);/);
});

// The session list Improve re-read while Messages or the bell was open, at
// most once every few seconds (#6591), went with its last surface, Messages'
// Agents section (16 Nov 2026): nothing re-reads it at all now.
test('nothing reloads the retired session list while state changes stream in', () => {
  const src = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(src, /_reloadSoon|loadSessions|_messagesOnScreen|RELOAD_MIN_GAP_MS/);
  assert.match(src, /onSessionStateChanged\(\) \{\n\s+Improve\.refreshWorking\(\);\n\s+\},/, 'a state change moves the mark\'s cue alone');
});
