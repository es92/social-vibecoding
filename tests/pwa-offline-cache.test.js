// Service-worker cache-durability + network-deadline contract (#1021).
//
// The reported bug had two independent causes and this file pins both:
//
//  1. The API cache name was derived from SW_VERSION, and activate()
//     deletes every `usernode-*` cache that isn't in ALL_CACHES. So every
//     routine service-worker bump silently wiped the cached
//     GET /api/auth/me — the one response an offline boot needs to know
//     the device is signed in. A user who had been offline-capable all
//     week was signed out by a deploy that had nothing to do with them.
//     Fix: a stable un-versioned name, plus a one-time migration of the
//     legacy `usernode-api-v*` names, plus eviction immunity for the
//     session entry (it is the smallest and most valuable thing in there,
//     and oldest-first trimming would eventually drop it).
//
//  2. Every strategy was network-first with NO deadline, so a socket that
//     opened and then stalled — the normal failure mode of a bad mobile
//     link, and the one where `navigator.onLine` still says true — held
//     the navigation and all ~70 shell scripts open indefinitely while a
//     complete cached copy sat unused. That is the reported white screen.
//     Fix: raceNetworkAndCache, a pure function so it can be tested here.
//
// sw.js detects Node via module.exports and skips all self.* wiring, so
// requiring it is safe.
//
// Run with: node --test tests/pwa-offline-cache.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const {
  classifyRequest,
  isImmuneApiRequest,
  isShellDocumentUrl,
  raceNetworkAndCache,
  bytesEqual,
  API_CACHE,
  ALL_CACHES,
  LEGACY_API_CACHE_RE,
  IMMUNE_API_PATHS,
  NAVIGATE_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  API_TIMEOUT_MS,
  apiTimeoutFor,
  isBootReadRequest,
  BOOT_READ_PATHS,
  BOOT_READ_PATTERNS,
  BOOT_API_TIMEOUT_MS,
  buildIdOf,
  buildTimeOf,
  shouldReplaceShellDocument,
  putShellDocumentIfNewer,
  SHELL_BUILD_TIME_HEADER,
} = require('../public/sw.js');

const SW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'
);
const ORIGIN = 'https://social-vibecoding.example';

// One strategy's source, bounded by the NEXT strategy rather than by a
// character count. A fixed-length slice silently runs past the end of a
// short function into its neighbour, which is how the assertion below that
// every tier writes to its cache passed while networkFirstNavigate — the
// one that did not — sat right in front of the one that did.
const STRATEGIES = ['networkFirstShell', 'networkFirstNavigate', 'networkFirstApi'];
const strategyBody = (fn) => {
  const start = SW_SRC.indexOf(`async function ${fn}(`);
  assert.ok(start !== -1, `${fn} not found in sw.js`);
  const ends = STRATEGIES
    .filter((other) => other !== fn)
    .map((other) => SW_SRC.indexOf(`async function ${other}(`, start))
    .filter((at) => at !== -1);
  return SW_SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
};

// A schedule() that fires deadlines on demand instead of on a clock, so
// these tests are instant and can't flake on a loaded machine.
function manualScheduler() {
  const pending = [];
  const schedule = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  schedule.fireAll = () => {
    for (const e of pending) if (!e.cancelled) e.fn();
  };
  schedule.pending = pending;
  return schedule;
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// ── 1. Cache naming and durability ───────────────────────────────────

test('the API cache name carries no SW version, so a bump cannot wipe it', () => {
  assert.equal(API_CACHE, 'usernode-api');
  assert.ok(!/v\d/.test(API_CACHE), `${API_CACHE} still looks versioned`);
  // The regression in full: activate() prunes by this list, so the API
  // cache must be a member of it under its stable name.
  assert.ok(ALL_CACHES.includes(API_CACHE));
});

test('the activate prune still deletes caches this worker does not own', () => {
  // The un-versioned name must not have turned the prune into a no-op —
  // stale SHELL caches from older versions still have to go.
  assert.ok(!ALL_CACHES.includes('usernode-shell-v1'));
  assert.ok(!ALL_CACHES.includes('usernode-immutable-v1'));
});

test('a shell upgrade preserves certified API partitions and discards unowned identity responses', async () => {
  const stores = new Map();
  const keyOf = request => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async request => entries.get(keyOf(request))?.clone(),
        put: async (request, response) => { entries.set(keyOf(request), response.clone()); },
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        delete: async request => entries.delete(keyOf(request)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
  const oldShell = await caches.open('usernode-shell-v36');
  await oldShell.put('/index.html', new Response('old document'));
  await oldShell.put('/shell/assets/shell.js', new Response('old full-width sorting pill'));
  await caches.open('usernode-immutable-v36');
  const api = await caches.open(API_CACHE);
  const session = JSON.stringify({ user: { id: 3, username: 'reviewer' } });
  await api.put('/api/auth/me', new Response(session));
  const scope = 'a'.repeat(64);
  const scopedKey = `/api/apps?__usernode_cache_scope=${scope}`;
  await api.put(scopedKey, new Response('{"fake":"permitted"}', { headers: {
    'X-Usernode-Cache-Scope': scope, 'sw-cached-at': String(Date.now()),
  } }));
  await caches.open('another-app-cache');

  const handlers = {};
  const lifecycle = [];
  vm.runInNewContext(SW_SRC, {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: async () => { lifecycle.push('skipWaiting'); },
      clients: { claim: async () => { lifecycle.push('claim'); } },
    },
    URL, Headers, Request, Response, caches, setTimeout, clearTimeout,
    // Staging can serve an unstamped shell at these same asset URLs.
    fetch: async request => new Response(keyOf(request).endsWith('/shell/assets/shell.js')
      ? 'new compact sorting button' : 'new shell asset'),
  });
  for (const name of ['install', 'activate']) {
    let completed;
    handlers[name]({ waitUntil: promise => { completed = promise; } });
    await completed;
  }

  const names = await caches.keys();
  assert.ok(!names.includes('usernode-shell-v36'), 'the previous renderer cache must be retired');
  assert.ok(!names.includes('usernode-immutable-v36'));
  const shell = await caches.open(names.find(name => name.startsWith('usernode-shell-')));
  assert.equal(await (await shell.match('/shell/assets/shell.js')).text(), 'new compact sorting button');
  assert.equal(await (await shell.match('/index.html')).text(), 'new shell asset');
  const retainedApi = await caches.open(API_CACHE);
  assert.equal(await retainedApi.match('/api/auth/me'), undefined, 'an unscoped legacy identity cannot be adopted');
  assert.equal(await (await retainedApi.match(scopedKey)).text(), '{"fake":"permitted"}');
  assert.ok(names.includes(API_CACHE));
  assert.ok(names.includes('another-app-cache'));
  assert.deepEqual(lifecycle, ['skipWaiting', 'claim']);
});

test('legacy version-named API caches are recognised for migration', () => {
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v6'));
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v7'));
  assert.ok(LEGACY_API_CACHE_RE.test('usernode-api-v12'));
  // Must not swallow the stable name itself, or the migration would try
  // to copy the cache onto itself and the logout wipe would be fine but
  // the prune list would get confused.
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-api'));
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-shell-v7'));
  assert.ok(!LEGACY_API_CACHE_RE.test('usernode-immutable-v7'));
});

test('migration runs on activate BEFORE the prune deletes the legacy names', () => {
  // Ordering is the whole point: prune-then-migrate would migrate nothing
  // and sign every upgrading device out offline.
  const activate = SW_SRC.slice(SW_SRC.indexOf("addEventListener('activate'"));
  const migrateAt = activate.indexOf('migrateLegacyApiCaches(');
  const pruneAt = activate.indexOf('caches.delete(n)');
  assert.ok(migrateAt > -1, 'activate does not call migrateLegacyApiCaches');
  assert.ok(pruneAt > -1, 'activate no longer prunes');
  assert.ok(migrateAt < pruneAt, 'migration must run before the prune');
});

test('no credential/session entry is retained by the API eviction policy', () => {
  assert.deepEqual(IMMUNE_API_PATHS, []);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me', ORIGIN), false);
  // Query strings and cache-busters must not defeat the immunity.
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me?t=1', ORIGIN), false);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/apps', ORIGIN), false);
  assert.equal(isImmuneApiRequest(ORIGIN + '/api/auth/me/extra', ORIGIN), false);
  assert.equal(isImmuneApiRequest('not a url', ORIGIN), false);
});

test('both eviction passes skip immune entries', () => {
  const trim = SW_SRC.slice(SW_SRC.indexOf('async function trimApiCache'));
  assert.match(trim.slice(0, 600), /isImmuneApiRequest/);
  const prune = SW_SRC.slice(SW_SRC.indexOf('async function pruneStaleApiEntries'));
  assert.match(prune.slice(0, 600), /isImmuneApiRequest/);
});

test('logout clears the legacy API caches too, not just the stable one', () => {
  // A device that logs out before the migration lands would otherwise
  // leave one user's cached responses readable by the next.
  const start = SW_SRC.indexOf('function clearApiCaches');
  const clear = SW_SRC.slice(start, SW_SRC.indexOf("self.addEventListener('activate'", start));
  assert.match(clear, /LEGACY_API_CACHE_RE/);
  assert.ok(!/caches\.delete\(API_CACHE\)/.test(SW_SRC),
    'a bare caches.delete(API_CACHE) would miss the legacy names');
});

// ── 2. Network deadline with cache fallback ──────────────────────────

test('a fast network response wins and nothing is served from cache', async () => {
  const schedule = manualScheduler();
  const res = await raceNetworkAndCache({
    startFetch: async () => 'network',
    matchCache: async () => { throw new Error('cache must not be consulted'); },
    timeoutMs: 1000,
    schedule,
  });
  assert.deepEqual(res, { response: 'network', fromCache: false, pending: null });
  // The deadline timer is cancelled, so a served response never leaves a
  // timer running for the life of the worker.
  assert.equal(schedule.pending[0].cancelled, true);
});

test('a stalled network is answered from cache at the deadline', async () => {
  const schedule = manualScheduler();
  const net = deferred();
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => 'cached',
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  const res = await promise;
  assert.equal(res.response, 'cached');
  assert.equal(res.fromCache, true);
  // The request is STILL IN FLIGHT and handed back so the caller can
  // event.waitUntil() it — the fresh copy still lands in the cache.
  assert.ok(res.pending, 'the in-flight request must be returned');
  net.resolve('network');
  assert.equal(await res.pending, 'network');
});

test('a stalled network with no cached copy still waits it out', async () => {
  // Cutting the request off at the deadline with nothing to show would
  // turn a slow load into a hard failure. The deadline only unlocks the
  // cache; it never shortens the request.
  const schedule = manualScheduler();
  const net = deferred();
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => undefined,
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  net.resolve('late network');
  const res = await promise;
  assert.deepEqual(res, { response: 'late network', fromCache: false, pending: null });
});

test('an outright network failure falls back to cache', async () => {
  const schedule = manualScheduler();
  const res = await raceNetworkAndCache({
    startFetch: async () => { throw new Error('offline'); },
    matchCache: async () => 'cached',
    timeoutMs: 1000,
    schedule,
  });
  assert.equal(res.response, 'cached');
  assert.equal(res.fromCache, true);
  assert.equal(res.pending, null);
  assert.equal(schedule.pending[0].cancelled, true);
});

test('a network failure with no cached copy rethrows', async () => {
  const schedule = manualScheduler();
  await assert.rejects(raceNetworkAndCache({
    startFetch: async () => { throw new Error('offline'); },
    matchCache: async () => undefined,
    timeoutMs: 1000,
    schedule,
  }), /offline/);
});

test('a failure AFTER the deadline still gets one last look at the cache', async () => {
  // Entry written by a concurrent request while we were waiting.
  const schedule = manualScheduler();
  const net = deferred();
  let calls = 0;
  const promise = raceNetworkAndCache({
    startFetch: () => net.promise,
    matchCache: async () => (++calls > 1 ? 'arrived late' : undefined),
    timeoutMs: 1000,
    schedule,
  });
  schedule.fireAll();
  net.reject(new Error('connection reset'));
  const res = await promise;
  assert.equal(res.response, 'arrived late');
  assert.equal(res.fromCache, true);
});

test('all three network-first strategies carry a deadline', () => {
  for (const ms of [NAVIGATE_TIMEOUT_MS, SHELL_TIMEOUT_MS, API_TIMEOUT_MS]) {
    assert.equal(typeof ms, 'number');
    // The lower bound used to be 1000ms for all three. It was a guard
    // against a deadline so short that the worker became cache-first by
    // accident — but for the SHELL that is now the deliberate design (see
    // the constants in sw.js): being one deploy behind for one load is
    // cheap, a blank screen is not, and a 200ms deadline still lets a
    // healthy conditional GET win and deliver the newest build on this
    // load. The guard stays, one floor lower, so a zero or a negative —
    // which would disable the network path outright — is still caught.
    assert.ok(ms >= 100 && ms <= 10000, `implausible deadline: ${ms}`);
  }
  // The API tier is the one where a stale answer is WRONG CONTENT rather
  // than an old build, so it must stay meaningfully more patient than the
  // shell AND above a typical mobile round trip. Below ~500ms it would be
  // cache-first for everyone not on wifi while still claiming to be
  // network-first.
  assert.ok(API_TIMEOUT_MS >= 500,
    'the API deadline must stay above a typical mobile round trip');
  assert.ok(API_TIMEOUT_MS > SHELL_TIMEOUT_MS,
    'the API tier must be more patient than the shell tier');

  for (const fn of ['networkFirstShell', 'networkFirstNavigate', 'networkFirstApi']) {
    const body = strategyBody(fn);
    assert.match(body, /raceNetworkAndCache/,
      `${fn} does not use the deadline helper`);
    if (fn === 'networkFirstNavigate') {
      assert.match(body, /pending \? pending\.then\(\(\) => cacheWrite\) : cacheWrite/,
        `${fn} drops the late document write instead of keeping it alive`);
      assert.match(body, /event\.waitUntil\(durableWrite/,
        `${fn} does not extend the fetch-event lifetime through that write`);
    } else {
      assert.match(body, /event\.waitUntil\(pending/,
        `${fn} drops the in-flight request instead of keeping it alive`);
    }
    // Keeping the request ALIVE is only half of it, and the half that is
    // easy to have without the other. raceNetworkAndCache deliberately
    // leaves the cache write to the caller's startFetch, so a strategy that
    // waits on `pending` and never stores the result serves a stale copy
    // for the life of the worker while still calling itself network-first.
    // That is exactly what networkFirstNavigate did. The write is spelled
    // differently in each tier — the API one goes through stampAndPut so
    // the entry carries its cached-at header — so accept either.
    assert.match(body, /cache\.put\(|stampAndPut\(cache|queueShellDocumentWrite\(cache/,
      `${fn}'s startFetch never writes the response to the cache`);
  }
});

// ── 2b. The cached document has to track the deploy ──────────────────
//
// install() writes /index.html into the shell cache exactly once per
// worker, and the navigation strategy reads that key on every load that
// misses the deadline — which, with the deadline deliberately set below a
// round trip, is most of them. So if the navigation never writes the key
// back, the cached shell freezes at whatever shipped the last time sw.js
// changed bytes, and no later deploy can dislodge it.
//
// The symptom that surfaced it: #1400 moved the body ground from bg-white
// to bg-zinc-100 without touching sw.js, so an ordinary load rendered the
// old white page while a hard refresh — which bypasses the worker — showed
// the new grey one, indefinitely.

test('the navigation writes the fresh document back under the read key', () => {
  const nav = SW_SRC.slice(
    SW_SRC.indexOf('async function networkFirstNavigate('),
    SW_SRC.indexOf('async function networkFirstApi(')
  );
  // The key is what matters, not merely that a put happens: matchCache
  // reads the fixed '/index.html', so storing under event.request would
  // fill the cache with per-route copies and leave the one key that is
  // actually read as stale as before.
  assert.match(nav, /queueShellDocumentWrite\(cache, res\.clone\(\)\)/,
    'the refreshed document must land on the key matchCache reads');
  assert.match(nav, /matchCache: \(\) => cache\.match\('\/index\.html'\)/,
    'and that key must still be the one read back');
  assert.doesNotMatch(nav, /startFetch: \(\) => fetch\(event\.request\),/,
    'a bare startFetch is the bug: nothing refreshes the cached shell');
});

test('the document write outlives the response that was rendered', () => {
  const nav = strategyBody('networkFirstNavigate');
  // The observed regression: the live network response painted the fixed UI,
  // but cache.put was fire-and-forget. The worker could be stopped as soon as
  // respondWith settled, leaving the old document behind for a later slow
  // navigation to paint. Keep the put separate from the response latency, but
  // explicitly extend the event through it.
  assert.match(nav, /let cacheWrite = Promise\.resolve\(false\);/);
  assert.match(nav, /const durableWrite = pending \? pending\.then\(\(\) => cacheWrite\) : cacheWrite;/);
  assert.match(nav, /event\.waitUntil\(durableWrite\.catch\(\(\) => \{\}\)\);/);
  assert.doesNotMatch(nav, /cache\.put\('\/index\.html', res\.clone\(\)\)\.catch/,
    'the old unowned, fire-and-forget write must not return');
});

test('only the real shell document may be stored as the shell', () => {
  // classifyRequest returns 'navigate' for far more than the shell's own
  // two URLs. #860's redirect stubs are ~1KB of location.replace(): the
  // right thing to SERVE the cached shell for offline, and a disaster to
  // STORE as it — every later cache-served navigation would get a stub
  // instead of the app, which is strictly worse than the staleness this
  // whole section fixes.
  for (const p of ['/', '/index.html']) {
    assert.equal(isShellDocumentUrl(`${ORIGIN}${p}`, ORIGIN), true, p);
  }
  for (const p of [
    '/login.html', '/register.html', '/dashboard.html', '/gallery.html',
    '/admin.html', '/status.html', '/debug.html', '/node-status.html',
    '/landing.html', '/waiting.html', '/admin-features.html',
    '/cli-authorize.html', '/connect-authorize.html', '/reports/tok',
  ]) {
    assert.equal(isShellDocumentUrl(`${ORIGIN}${p}`, ORIGIN), false, p);
  }
  // A query string or hash is still the shell — every SPA route is a hash
  // route, and /?return_to=… is the CLI authorize hand-off.
  assert.equal(isShellDocumentUrl(`${ORIGIN}/#app/x/dev`, ORIGIN), true);
  assert.equal(isShellDocumentUrl(`${ORIGIN}/?return_to=abc`, ORIGIN), true);
  // Cross-origin and unparseable inputs are refused rather than thrown on.
  assert.equal(isShellDocumentUrl('https://elsewhere.example/', ORIGIN), false);
  assert.equal(isShellDocumentUrl('::not a url::', ORIGIN), false);
});

test('a redirect or an error response is never stored as the shell', () => {
  const nav = SW_SRC.slice(
    SW_SRC.indexOf('async function networkFirstNavigate('),
    SW_SRC.indexOf('async function networkFirstApi(')
  );
  // Everything navigable that is not the shell bounces to '/' at the
  // server (middleware/auth.js), so the response reaching here for those
  // is a redirect — and a redirected 200 for /login.html carries the
  // stub's URL, not the shell's.
  assert.match(nav, /!res\.redirected/,
    'a followed redirect must not be mistaken for the shell document');
  assert.match(nav, /res\.ok/,
    'a 4xx/5xx error page must never replace the cached shell');
  assert.match(nav, /isShellDocumentUrl\(event\.request\.url, ORIGIN\)/,
    'the path guard must be applied to the request that was actually made');
});

// ── 3. One build per page load ───────────────────────────────────────
//
// The shell's assets are unhashed, so index.html does not pin the build its
// scripts come from. With every asset racing its own deadline, a connection
// hovering around the threshold could serve a cached document alongside
// freshly-fetched scripts — one load, two deploys. The navigation records
// its own outcome and the assets follow it.

test('the navigation publishes its cache/network verdict for the load', () => {
  const nav = SW_SRC.slice(SW_SRC.indexOf('async function networkFirstNavigate('));
  assert.match(nav.slice(0, 3600), /shellFromCacheThisLoad = fromCache/,
    'the navigation must record whether it was answered from cache');
});

test('shell assets follow the navigation instead of re-racing', () => {
  // The whole function, not a character budget: this used to slice the
  // first 2600 characters, which made the assertions below depend on how
  // much comment sat above them and failed the moment any was added.
  const body = strategyBody('networkFirstShell');
  assert.match(body, /if \(shellFromCacheThisLoad\)/,
    'shell assets must consult the load-wide verdict');
  // On that path the asset is returned straight from cache, and the network
  // copy is still fetched so the NEXT load is fresh. Scoped to that branch:
  // the build check below it deliberately has no revalidation.
  const slowLane = body.slice(0, body.indexOf('if (documentBuildThisLoad)'));
  assert.match(slowLane, /event\.waitUntil\(fetchAndCache\(\)/,
    'the cached-shell path must still refresh the cache in the background');
  // A brand-new asset (a deploy added one) has nothing cached to prefer, so
  // the flag must not be allowed to strand it.
  assert.match(body, /raceNetworkAndCache/,
    'a cache miss must still fall through to the network path');
});

test('the load-wide verdict defaults to the per-asset race', () => {
  // A worker restart mid-load resets module state. The default has to be
  // the OLD behaviour (race, fall back to cache), never "serve cache
  // blindly" — that would be a build the navigation never agreed to.
  assert.match(SW_SRC, /let shellFromCacheThisLoad = false;/,
    'the verdict must default to false (race), not true');
});

// ── 4. Late-arrival correction ───────────────────────────────────────
//
// A worker returns exactly ONE response per request. Serving a stale API
// answer is only safe because the page is told when the real answer lands
// and disagrees with what it was shown.

test('bytesEqual compares whole bodies', () => {
  const buf = (bytes) => new Uint8Array(bytes).buffer;
  assert.equal(bytesEqual(buf([1, 2, 3]), buf([1, 2, 3])), true);
  assert.equal(bytesEqual(buf([1, 2, 3]), buf([1, 2, 4])), false,
    'a changed byte must read as changed');
  assert.equal(bytesEqual(buf([1, 2]), buf([1, 2, 3])), false,
    'a length change must read as changed');
  assert.equal(bytesEqual(buf([]), buf([])), true);
});

test('a stale API answer that turns out to be wrong notifies the page', () => {
  // The whole strategy, bounded by its neighbour rather than a character
  // count that a new guard line would push matchCache past.
  const body = strategyBody('networkFirstApi');
  // The "did we serve stale?" flag is set inside matchCache, which resolves
  // before raceNetworkAndCache returns. Reading the returned `fromCache`
  // instead would leave a window in which a just-missed network response
  // found the flag still false and skipped a correction that was due.
  assert.match(body, /matchCache: async \(\) => \{[\s\S]*?served\.fromCache = true/,
    'the stale-serve flag must be set inside matchCache, not after the race');
  assert.match(body, /detectChange: served\.fromCache/,
    'the change comparison must only run on the stale-serve path');
  assert.match(body, /served\.fromCache && changed/,
    'a correction must require BOTH a stale serve and a real difference');
  assert.match(body, /notifyClients\(\{ type: 'api-updated'/,
    'the page must be told about the correction');
});

test('an ordinary fresh API load never posts a correction', () => {
  // detectChange is false unless we served stale, and stampAndPut returns
  // false when it is not asked — so the notify branch cannot fire on a
  // healthy connection, where every screen already has the live answer.
  const stamp = SW_SRC.slice(SW_SRC.indexOf('async function stampAndPut('));
  assert.match(stamp.slice(0, 1200), /\{ detectChange = false(?:, [^}]+)? \} = \{\}/,
    'change detection must be opt-in');
  assert.match(stamp.slice(0, 1200), /if \(detectChange\)/,
    'stampAndPut must skip the extra cache read when not asked');
});

test('boot bounds live identity confirmation before using a display-only snapshot', () => {
  const appJs = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8'
  );
  const boot = Number(/BOOT_SESSION_TIMEOUT_MS:\s*(\d+)/.exec(appJs)[1]);
  assert.ok(boot >= 1000 && boot <= 3000, 'a weak connection cannot hold the first screen indefinitely');
  assert.equal(classifyRequest('GET', 'https://example.test/api/auth/me', '', 'cors', 'https://example.test'), 'bypass');
});

// ── The reads that gate a first paint ────────────────────────────────────

test('the boot reads answer from cache immediately; everything else waits', () => {
  const O = 'https://example.test';
  // The exact list is what has no slug in it: the launcher (the app list, its
  // layout, the home panels) and the viewer's own running sessions, which the
  // dev board renders as its "In progress" rows.
  assert.deepEqual(BOOT_READ_PATHS, [
    '/api/apps', '/api/home-layout', '/api/home-panels', '/api/me/active-sessions',
  ]);
  assert.equal(BOOT_API_TIMEOUT_MS, 0, 'a cached copy is served on this tick');
  for (const p of BOOT_READ_PATHS) {
    assert.equal(apiTimeoutFor(`${O}${p}`, O), BOOT_API_TIMEOUT_MS, p);
    assert.equal(apiTimeoutFor(`${O}${p}?demo=1`, O), BOOT_API_TIMEOUT_MS,
      `${p} with a query string is the same read`);
  }

  // The per-app half. These are the dev board's whole first paint, and the
  // app record in front of them is the SERIAL GATE — AppView._loadDevData
  // cannot ask for any of the rest until it answers, so leaving it out would
  // have left the chain a round trip long and bought nothing.
  for (const p of [
    '/api/apps/usernode-2d5619',
    '/api/apps/usernode-2d5619/github-issues',
    '/api/apps/usernode-2d5619/issues',
    '/api/apps/usernode-2d5619/board-order',
    '/api/apps/usernode-2d5619/sessions',
    '/api/apps/usernode-2d5619/shared-sessions',
    '/api/apps/usernode-2d5619/topic-categories',
  ]) {
    assert.equal(apiTimeoutFor(`${O}${p}`, O), BOOT_API_TIMEOUT_MS, p);
    assert.equal(apiTimeoutFor(`${O}${p}?demo=1`, O), BOOT_API_TIMEOUT_MS,
      `${p} with a query string is the same read`);
  }

  // What stays on the patient deadline. `/messages` is the one that matters:
  // it is paginated, so a scroll-back mints a new key per page and none of
  // them is a screen's standing state. The patterns are anchored at both
  // ends, and this is what proves it.
  for (const p of [
    '/api/apps/usernode-2d5619/messages',
    // Polish board #3: the counts the project's hub states as facts (votes
    // and check states, what went live) take the ordinary deadline beside its
    // community record, so a warm open draws today's numbers once rather than
    // last visit's and then the swap.
    '/api/apps/usernode-2d5619/promoted',
    '/api/apps/usernode-2d5619/merged',
    '/api/apps/usernode-2d5619/promoted/9',
    '/api/apps/usernode-2d5619/issues/12/comments',
    '/api/notifications',
    '/api/conversations',
    '/api/home-layouts',
    // Never. It gates the whole boot and its cached copy can be
    // affirmatively wrong — a session that has since ended answers 401, and
    // an error response is never cached, so a cached 200 would paint the
    // signed-in shell with nothing left to correct it.
    '/api/auth/me',
  ]) {
    assert.equal(apiTimeoutFor(`${O}${p}`, O), API_TIMEOUT_MS, p);
  }

  // A URL the parser cannot make sense of must not fall into the fast lane.
  assert.equal(apiTimeoutFor('::::', undefined), API_TIMEOUT_MS);
  assert.equal(isBootReadRequest('::::', undefined), false);
  // Pathname-only, like its sibling isImmuneApiRequest: both are reached
  // only from networkFirstApi, which classifyRequest has already narrowed to
  // same-origin GETs. Asserted so the narrowing stays where it is rather
  // than being assumed here.
  assert.match(SW_SRC, /if \(u\.origin !== selfOrigin\) return 'bypass';/);

  // Every pattern is anchored, so none of them can match a longer path by
  // accident. Asserted structurally as well as by example above, because an
  // unanchored regex here is a silent widening of the lane.
  for (const re of BOOT_READ_PATTERNS) {
    assert.ok(re.source.startsWith('^') && re.source.endsWith('$'),
      `${re} must be anchored at both ends`);
  }
});

test('serving a stale boot read is only safe because the page is told', () => {
  // The whole trade — paint the previous session's screen now, correct it
  // when the network answers — rests on this notify path and on
  // App._onApiUpdated re-running the visible screen's loader. If either
  // goes, the fast lane must go with it.
  const body = strategyBody('networkFirstApi');
  assert.match(body, /const timeoutMs = [\s\S]*?laned \? BOOT_API_TIMEOUT_MS : API_TIMEOUT_MS;/,
    'the deadline is chosen per request');
  assert.match(body, /notifyClients\(\{ type: 'api-updated'/,
    'a late answer that disagrees is announced');
  assert.match(body, /served\.fromCache && changed/,
    'and only when the page was actually shown the stale bytes');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /_onApiUpdated\(\)/, 'the page listens for it');
  assert.match(app, /App\.refreshActiveScreen/, 'and re-runs the visible screen\'s loader');
  // Both screens the fast lane is for have a branch in that loader. Without
  // one, a corrected answer would sit in the cache until the next reload and
  // "instant" would just mean "wrong sooner".
  // Bounded by the DEFINITION that follows, not by the call inside this
  // function — `App._refreshLeaderboard();` is one of its own branches, and
  // slicing at that cut the last two branches (home's among them) off.
  const loader = app.slice(app.indexOf('refreshActiveScreen()'),
    app.indexOf('_refreshLeaderboard() {'));
  assert.match(loader, /AppView\._watchCreatingStatus\(AppView\.appData, \{ immediate: true \}\)/,
    'and a corrected creating record revalidates the open App tab');
  assert.match(loader, /AppView\.refreshDevData\('api-update'\)/, 'the board repaints');
  assert.match(loader, /Home\.load\(\)/, 'and so does home');
});

test('a correction does not answer itself from the cache it is correcting', () => {
  // The loop this guards: serve stale → notify → the page re-pulls → serve
  // the same stale copy → notify → … at about 600ms a lap, forever. Any
  // endpoint whose body varies per request does it the moment its deadline
  // reaches zero — staging's ?demo=1 fixtures re-derive timestamps on every
  // call, and so would a server-stamped `now` or a signed asset URL. Under
  // the 1s deadline the network simply won every lap and it never armed.
  // Declared beside the strategy rather than inside it — it has to outlive
  // one request to mean anything.
  assert.match(SW_SRC, /const correcting = new Set\(\);/);
  const body = strategyBody('networkFirstApi');
  // Consumed on read: exactly one lane-skipped request per correction. A
  // fresh read (#4177) consumes it too: it has a lane deadline of its own
  // (FRESH_BOOT_API_TIMEOUT_MS), and every page read is a fresh one.
  assert.match(body, /const laned = !correcting\.delete\(event\.request\.url\)/,
    'the mark is consumed when the deadline is chosen');
  assert.match(body, /if \(laned\) \{[\s\S]*?correcting\.add\(event\.request\.url\)/,
    'and set only by a LANE serve — a slow answer on the 1s deadline is not a loop');
  assert.match(body, /correcting\.size >= CORRECTING_MAX/, 'and the set is bounded');
});

test('a slow endpoint that differs every time is re-pulled from the network, not raced again', () => {
  // The loop the lane guard does not cover: an answer that loses the
  // ORDINARY deadline and differs on every request. The Workshop's /promoted
  // list carries each running check's live progress, so under load every
  // board re-pull was served stale, corrected, and re-pulled again — about
  // nine requests a second per visible tab, until Chrome refused new ones
  // (net::ERR_INSUFFICIENT_RESOURCES). A time-based cooldown is the wrong
  // cure: a second tab booting inside it would keep a stale screen with no
  // correction at all.
  assert.match(SW_SRC, /const awaitingNetwork = new Set\(\);/);
  assert.match(SW_SRC, /const CORRECTION_WAIT_MS = \d+;/);
  const body = strategyBody('networkFirstApi');
  assert.match(body, /const settling = awaitingNetwork\.delete\(event\.request\.url\);/,
    'the mark is consumed when the deadline is chosen, by a fresh read too');
  // The settling rule comes first, ahead of a fresh read's own deadline:
  // every page read is fresh (#4177), so a re-pull after a correction is one.
  assert.match(body, /const timeoutMs = settling \? CORRECTION_WAIT_MS\s*: fresh \? \(laned \? FRESH_BOOT_API_TIMEOUT_MS : FRESH_API_TIMEOUT_MS\)/,
    'and that request waits for the network instead of racing the cache');
  assert.match(body, /&& !settling\s*&& bootLaneApplies/, 'a settling request is never laned');
  assert.match(body, /\} else \{[\s\S]*?awaitingNetwork\.add\(event\.request\.url\)/,
    'set by a correction on the ordinary deadline, the case the lane guard skips');
  assert.match(body, /awaitingNetwork\.size >= CORRECTING_MAX/, 'and the set is bounded');
  assert.ok(!/lastCorrectionAt|CORRECTION_COOLDOWN_MS/.test(SW_SRC),
    'no time-based cooldown: it would strand a second tab on stale data');
});

// ── 2c. Fresh reads on a link that carries nothing ───────────────────────
//
// Offline findings, 2 Nov 2026: on a link that connects but passes nothing,
// a cold launch sat on Home's skeleton for over a minute while the saved apps
// sat in the API cache. Every page read is a fresh one (`reload`, from the
// identity wrapper), and a fresh read used to fall back only when the fetch
// REJECTED, which such a link never does. These drive the real worker
// (tests/lib/private-cache-worker.js) with deadlines fired on demand.

const harness = require('./lib/private-cache-worker');
const {
  FRESH_API_TIMEOUT_MS,
  FRESH_BOOT_API_TIMEOUT_MS,
  RETIRING_STATUSES,
  declinedAnswerRetiresCopy,
} = require('../public/sw.js');

function manualTimers() {
  const all = [];
  const timers = {
    setTimeout(fn, ms) { const t = { fn, ms, cancelled: false, fired: false }; all.push(t); return t; },
    clearTimeout(t) { if (t) t.cancelled = true; },
    live: () => all.filter((t) => !t.cancelled && !t.fired),
    fire() { for (const t of timers.live()) { t.fired = true; t.fn(); } },
    all,
  };
  return timers;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail(`timed out waiting for ${what}`);
}
// The worker's messages, copied out of its realm so deepEqual compares data.
const posted = (h) => h.messages.map((m) => ({ ...m }));
// Did the worker answer yet? Never awaits the answer itself.
function watch(promise) {
  const state = { settled: false, value: undefined };
  promise.then((value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; });
  return state;
}

// A worker holding one saved copy of `path`, made by an answer that came in
// time, and a network that now waits for the test to answer it.
async function savedCopyWorker(path = '/api/private-fixture', body = { fake: 'saved' }) {
  const timers = manualTimers();
  const h = harness.worker({ timers, fetcher: async () => harness.json(body) });
  await (await h.get(harness.A, path)).json();
  await h.drain();
  assert.equal(timers.live().length, 0, 'an answer in time leaves no deadline running');
  const held = deferred();
  h.setNetwork(() => held.promise);
  return { h, timers, held };
}

test('a fresh read with a saved copy is answered from it once the network misses the long deadline', async () => {
  const { h, timers, held } = await savedCopyWorker();
  const answer = watch(h.get(harness.A));
  await until(() => timers.live().length === 1, 'the deadline');
  assert.equal(timers.live()[0].ms, FRESH_API_TIMEOUT_MS, 'a fresh read gets the long deadline');
  await tick();
  assert.equal(answer.settled, false, 'nothing is served before the deadline');
  timers.fire();
  await until(() => answer.settled, 'the saved copy');
  assert.deepEqual(await answer.value.json(), { fake: 'saved' });
  assert.ok(answer.value.headers.get('sw-cached-at'), 'marked as the saved copy, as the offline fallback is');
  assert.equal(h.messages.length, 0, 'nothing to correct yet');

  // The request kept going. Its answer is stored, and the page is told.
  held.resolve(harness.json({ fake: 'current' }));
  await h.drain();
  const cache = await h.caches.open(API_CACHE);
  const keys = await cache.keys();
  assert.equal(keys.length, 1);
  assert.deepEqual(await (await cache.match(keys[0])).json(), { fake: 'current' },
    'the late answer replaces the saved copy under the usual rules');
  assert.deepEqual(posted(h), [{ type: 'api-updated', url: `${harness.ORIGIN}/api/private-fixture`, scope: harness.A }]);

  // The page's re-pull after that correction waits longer for the network,
  // so a body that changes on every answer cannot loop, and on the deadline
  // it would get the corrected copy rather than the old one.
  const again = deferred();
  h.setNetwork(() => again.promise);
  const repull = watch(h.get(harness.A));
  await until(() => timers.live().length === 1, 'the re-pull deadline');
  assert.ok(timers.live()[0].ms > FRESH_API_TIMEOUT_MS, 'a settling re-pull waits CORRECTION_WAIT_MS');
  timers.fire();
  await until(() => repull.settled, 'the corrected copy');
  assert.deepEqual(await repull.value.json(), { fake: 'current' });
  again.resolve(harness.json({ fake: 'current' }));
  await h.drain();
});

test('a fresh boot read waits the shorter boot deadline, and a refresh shuts that lane', async () => {
  const { h, timers, held } = await savedCopyWorker('/api/apps', { apps: ['saved'] });
  const answer = watch(h.get(harness.A, '/api/apps'));
  await until(() => timers.live().length === 1, 'the deadline');
  assert.equal(timers.live()[0].ms, FRESH_BOOT_API_TIMEOUT_MS);
  timers.fire();
  await until(() => answer.settled, 'the saved launcher');
  assert.deepEqual(await answer.value.json(), { apps: ['saved'] });

  // Sent the way the page sends it; h.message() would also wait out the
  // first request, which is still held.
  h.handlers.message({ data: { type: 'refresh-intent' }, waitUntil() {} });
  const pulled = watch(h.get(harness.A, '/api/apps'));
  await until(() => timers.live().length === 1, 'the pull deadline');
  assert.equal(timers.live()[0].ms, FRESH_API_TIMEOUT_MS, 'a pull pays the ordinary fresh deadline');
  held.resolve(harness.json({ apps: ['saved'] }));
  await until(() => pulled.settled, 'the pull');
  await h.drain();
  assert.equal(h.messages.length, 0, 'an identical late answer posts nothing');

  // The deadlines keep their order: a working link answers first.
  assert.ok(FRESH_BOOT_API_TIMEOUT_MS >= 1500 && FRESH_BOOT_API_TIMEOUT_MS < FRESH_API_TIMEOUT_MS);
  assert.ok(FRESH_API_TIMEOUT_MS > API_TIMEOUT_MS && FRESH_API_TIMEOUT_MS <= 5000,
    'long enough for a working link, and well inside the page\'s own read timeout');
});

test('a fresh read the network answers in time is the network\'s answer, exactly as before', async () => {
  const { h, timers, held } = await savedCopyWorker();
  const answer = watch(h.get(harness.A));
  await until(() => timers.live().length === 1, 'the deadline');
  held.resolve(harness.json({ fake: 'current' }));
  await until(() => answer.settled, 'the answer');
  assert.deepEqual(await answer.value.json(), { fake: 'current' });
  assert.equal(answer.value.headers.get('sw-cached-at'), null);
  await h.drain();
  assert.equal(timers.live().length, 0, 'the deadline is cancelled');
  assert.equal(h.messages.length, 0, 'the page already has this answer');
});

test('with no saved copy a fresh read waits for the network, however long it takes', async () => {
  const timers = manualTimers();
  const held = deferred();
  const h = harness.worker({ timers, fetcher: () => held.promise });
  const answer = watch(h.get(harness.A));
  await until(() => timers.live().length === 1, 'the deadline');
  timers.fire();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(answer.settled, false, 'the deadline unlocks nothing and cuts nothing off');
  held.resolve(harness.json({ fake: 'slow but real' }));
  await until(() => answer.settled, 'the network');
  assert.deepEqual(await answer.value.json(), { fake: 'slow but real' });

  // Another viewer's copy is never "a saved copy" for this one.
  const other = deferred();
  h.setNetwork(() => other.promise);
  const b = watch(h.get(harness.B));
  await until(() => timers.live().length === 1, 'B\'s deadline');
  timers.fire();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(b.settled, false, 'a different session waits for its own answer');
  other.resolve(harness.json({ fake: 'B' }, harness.B));
  await until(() => b.settled, 'B\'s answer');
  assert.deepEqual(await b.value.json(), { fake: 'B' });
});

test('no-store reads and the identity read are still the network\'s alone', async () => {
  const { h, timers } = await savedCopyWorker();
  const before = timers.all.length;
  let responded = false;
  const request = new Request(`${harness.ORIGIN}/api/private-fixture`, {
    cache: 'no-store', headers: { [harness.SCOPE_HEADER]: harness.A },
  });
  h.handlers.fetch({ request, waitUntil() {}, respondWith() { responded = true; } });
  assert.equal(responded, false, 'a no-store read never reaches the worker\'s cache');
  let me;
  h.handlers.fetch({
    request: new Request(`${harness.ORIGIN}/api/auth/me`, { cache: 'reload', headers: { [harness.SCOPE_HEADER]: harness.A } }),
    waitUntil() {}, respondWith(p) { me = p; p.catch(() => {}); },
  });
  assert.ok(me, 'the identity read is answered by the network directly');
  await tick();
  assert.equal(h.requests.at(-1).cache, 'no-store');
  assert.equal(timers.all.length, before, 'neither one races a deadline');
});

test('a late refusal retires the copy the page was shown, and tells the page', async (t) => {
  for (const [label, late, tells] of [
    ['403', () => harness.json({ error: 'FAKE_REVOKED' }, harness.A, { status: 403, policy: 'no-store' }), true],
    ['401', () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), true],
    ['no-store', () => harness.json({ fake: 'current' }, harness.A, { policy: 'private, no-store' }), true],
    ['another scope', () => harness.json({ fake: 'FAKE_OTHER' }, harness.B), true],
    ['503', () => harness.json({ error: 'FAKE_DOWN' }, harness.A, { status: 503, policy: 'no-store' }), false],
  ]) await t.test(label, async () => {
    const { h, timers, held } = await savedCopyWorker();
    const answer = watch(h.get(harness.A));
    await until(() => timers.live().length === 1, 'the deadline');
    timers.fire();
    await until(() => answer.settled, 'the saved copy');
    assert.deepEqual(await answer.value.json(), { fake: 'saved' });
    held.resolve(late());
    await h.drain();
    assert.equal((await (await h.caches.open(API_CACHE)).keys()).length, 0,
      'the entry is retired, as a refusal in time retires it');
    assert.deepEqual(posted(h), tells
      ? [{ type: 'api-updated', url: `${harness.ORIGIN}/api/private-fixture`, scope: harness.A }] : [],
    tells ? 'the page re-reads instead of keeping a copy it may no longer see'
      : 'a server error says nothing about the copy on screen');
  });
});

test('only answers that speak about the copy retire it on screen', () => {
  assert.deepEqual(RETIRING_STATUSES, [401, 403, 404, 410]);
  for (const status of RETIRING_STATUSES) assert.equal(declinedAnswerRetiresCopy({ status }), true, String(status));
  assert.equal(declinedAnswerRetiresCopy({ status: 200 }), true, 'a 200 the cache declined (policy, scope, type)');
  assert.equal(declinedAnswerRetiresCopy({ status: 200, redirected: true }), true);
  for (const status of [304, 408, 429, 500, 502, 503]) {
    assert.equal(declinedAnswerRetiresCopy({ status }), false, String(status));
  }
  assert.equal(declinedAnswerRetiresCopy(null), false);
});

test('a full API cache evicts ordinary entries before a screen\'s standing state', async () => {
  // Same 300-entry budget; only the ORDER changes. Reading one busy chat is
  // enough to matter: /api/apps/:slug/messages?before=… mints a new key per
  // page, so a long scroll-back walks the whole budget, and insertion order
  // alone would evict the board the reader is scrolling back inside of —
  // dropping that screen out of the fast lane with nothing on screen to
  // explain why it stopped being instant.
  const src = SW_SRC.slice(SW_SRC.indexOf('async function trimApiCache('));
  const body = src.slice(0, src.indexOf('\n  }\n') + 4);
  assert.match(body, /!isBootReadRequest\(k\.url, ORIGIN\)/);
  assert.match(body, /\.concat\(evictable\.filter\(\(k\) => isBootReadRequest\(k\.url, ORIGIN\)\)\)/,
    'boot reads go to the BACK of the eviction queue');
  // The immune entry still comes out of the queue entirely, before either
  // class — an offline session must outlive a full cache whatever else does.
  assert.match(body, /!isImmuneApiRequest\(k\.url, ORIGIN\)/);
});

// ── Which BUILD a cached shell asset belongs to ──────────────────────────

function shellDocument(build, builtAt, body = build || 'dev') {
  const headers = {};
  if (build) headers['X-Platform-Build'] = build;
  if (builtAt != null) headers['X-Platform-Build-Time'] = String(builtAt);
  return new Response(body, { headers });
}

function documentCache(initial = null) {
  let current = initial;
  return {
    async match(key) {
      assert.equal(key, '/index.html');
      return current;
    },
    async put(key, response) {
      assert.equal(key, '/index.html');
      current = response;
    },
    current: () => current,
  };
}

test('an older rollout response cannot replace a newer cached document', async () => {
  const newer = shellDocument('2222222', 2_000);
  const older = shellDocument('1111111', 1_000);
  const cache = documentCache(newer);

  assert.equal(shouldReplaceShellDocument(newer, older), false);
  assert.equal(await putShellDocumentIfNewer(cache, older), false);
  assert.equal(buildIdOf(cache.current()), '2222222');
  assert.equal(buildTimeOf(cache.current()), 2_000);
});

test('a newer document durably advances an older shell cache', async () => {
  const older = shellDocument('1111111', 1_000);
  const newer = shellDocument('2222222', 2_000);
  const cache = documentCache(older);

  assert.equal(shouldReplaceShellDocument(older, newer), true);
  assert.equal(await putShellDocumentIfNewer(cache, newer), true);
  assert.equal(buildIdOf(cache.current()), '2222222');
  assert.equal(buildTimeOf(cache.current()), 2_000);
});

test('build time, not SHA sort order, makes an intentional rollback current', () => {
  const lexicallyLaterSha = shellDocument('ffffffff', 1_000);
  const rebuiltRollback = shellDocument('0000000', 2_000);
  assert.equal(shouldReplaceShellDocument(lexicallyLaterSha, rebuiltRollback), true,
    'a rollback image is built later even though its source SHA points backward');
});

test('cross-build replacement fails closed without an ordering stamp', () => {
  assert.equal(shouldReplaceShellDocument(
    shellDocument('1111111', 1_000), shellDocument('2222222', null)
  ), false);
  assert.equal(shouldReplaceShellDocument(
    shellDocument('1111111', null), shellDocument('2222222', 2_000)
  ), false);
  assert.equal(SHELL_BUILD_TIME_HEADER, 'x-platform-build-time');
});

test('a stamped deploy may replace a legacy entry, while dev remains network-first', () => {
  const legacy = shellDocument(null, null);
  const deployed = shellDocument('1111111', 1_000);
  assert.equal(shouldReplaceShellDocument(legacy, deployed), true);
  assert.equal(shouldReplaceShellDocument(legacy, shellDocument(null, null, 'edited')), true);
  assert.equal(shouldReplaceShellDocument(deployed, legacy), false,
    'an unstamped response cannot move a deployed cache backward');
});

test('a shell asset carries the build it was served from', () => {
  const {
    shellBuildId,
    SHELL_BUILD_HEADER,
    SHELL_BUILD_TIME_HEADER: SERVER_BUILD_TIME_HEADER,
    applyShellBuildHeader,
    applyShellDocumentHeaders,
  } =
    require('../src/services/static-cache.js');
  assert.equal(SHELL_BUILD_HEADER, 'X-Platform-Build');
  assert.equal(SERVER_BUILD_TIME_HEADER, 'X-Platform-Build-Time');
  // A real deploy identity, in the shape GIT_SHA actually arrives in.
  assert.equal(shellBuildId({ GIT_SHA: 'A1B2C3D4E5F6' }), 'a1b2c3d4e5f6');
  assert.equal(shellBuildId({ GIT_SHA: ' abc1234 ' }), 'abc1234');
  // ABSENT, not "dev". `dev` never changes, so serving a cached asset on it
  // would pin a checkout to whatever the worker cached first and an edit to
  // public/js/app.js would stop showing up. No header means the worker falls
  // back to the race — which is the right behaviour for a checkout.
  assert.equal(shellBuildId({}), null);
  assert.equal(shellBuildId({ GIT_SHA: 'dev' }), null);
  assert.equal(shellBuildId({ GIT_SHA: 'not-a-sha' }), null);
  assert.equal(shellBuildId({ GIT_SHA: '' }), null);
  // And the setter only sets when there is something to set.
  const set = [];
  applyShellBuildHeader({ setHeader: (k, v) => set.push([k, v]) }, { GIT_SHA: 'abc1234' });
  assert.deepEqual(set, [['X-Platform-Build', 'abc1234']]);
  set.length = 0;
  applyShellBuildHeader({ setHeader: (k, v) => set.push([k, v]) }, {});
  assert.deepEqual(set, []);

  applyShellDocumentHeaders(
    { setHeader: (k, v) => set.push([k, v]) },
    __filename,
    { GIT_SHA: 'abc1234' }
  );
  assert.equal(set[0][0], 'X-Platform-Build');
  assert.equal(set[1][0], 'X-Platform-Build-Time');
  assert.match(set[1][1], /^\d+$/);
});

test('the header rides the same assets the revalidation policy covers', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Every revalidated shell response carries its build id; index.html also
  // carries the ordered build time used to reject a rollout downgrade.
  assert.match(server,
    /path\.basename\(filePath\) === 'index\.html'[\s\S]{0,120}?applyShellDocumentHeaders\(res, filePath\)/);
  assert.match(server, /else if \(cc\) \{\s*applyShellBuildHeader\(res\);/);
  // And the SPA fallback, which is the DOCUMENT — the reference every cached
  // asset is compared against on a load.
  assert.match(server,
    /res\.setHeader\('Cache-Control', shellAssetCacheControl\('index\.html'\)\);[\s\S]{0,300}?applyShellDocumentHeaders\(res, indexPath\);/);
});

test('a cached asset from the current build is served without a race', () => {
  const body = strategyBody('networkFirstShell');
  // The question the worker actually wants to ask. shellFromCacheThisLoad
  // answers "was the connection bad?" and was standing in for this one,
  // which put the shortcut on the wrong side of the trade: the document only
  // loses its race on a link slower than 200ms, so the shortcut fired only
  // when the network was BAD and ~34 assets each paid a deadline whenever it
  // was GOOD.
  assert.match(body, /if \(documentBuildThisLoad\) \{[\s\S]*?buildIdOf\(hit\) === documentBuildThisLoad/,
    'a cached asset stamped with the document\'s own build is served on this tick');
  // And NOTHING is fetched behind it. The revalidation that used to sit
  // here was justified as repairing an entry the server had changed under
  // the same build id — a state a deploy cannot produce, since a deploy is
  // what changes the id. It therefore only ever ran where the ids already
  // agreed and there was nothing to fetch, once per shell asset per load:
  // ~34 requests competing with the boot. Removing it moved the warm board
  // card from a 1621ms median to 1455ms at 4x CPU on a 150ms link.
  assert.match(body,
    /buildIdOf\(hit\) === documentBuildThisLoad\) return hit;/,
    'the matching entry is returned outright, with no revalidation behind it');
  // Scoped to THIS branch. The shellFromCacheThisLoad branch above keeps
  // its revalidation and must: it inspects nothing about the entry it
  // serves, so that fetch is the only thing that can repair an asset from
  // a build the server has moved past.
  const slowLane = body.slice(0, body.indexOf('if (documentBuildThisLoad)'));
  assert.match(slowLane, /event\.waitUntil\(fetchAndCache\(\)\.catch\(\(\) => \{\}\)\);\s*return hit;/,
    'the known-slow-connection branch still revalidates behind its response');
  // A DIFFERENT stamp is a deploy, and must fall through to the race — that
  // is what keeps a redeploy reaching a WebView on the next load, which is
  // the whole reason src/services/static-cache.js exists.
  assert.match(body, /timeoutMs: SHELL_TIMEOUT_MS/,
    'the race is still there for everything the fast path does not claim');
  // The comparison is against the CACHED entry, never against the request.
  assert.doesNotMatch(body, /buildIdOf\(event\.request\)/);
});

test('the document publishes the build its own assets are measured against', () => {
  const nav = strategyBody('networkFirstNavigate');
  assert.match(nav, /documentBuildThisLoad = buildIdOf\(response\);/,
    'read off the response actually SERVED — a cached document publishes the '
    + 'build it was cached at, not the one the network is still fetching');
  // Both per-load flags are set in the same place, from the same response, so
  // they cannot describe two different loads.
  assert.match(nav, /shellFromCacheThisLoad = fromCache;[\s\S]{0,600}?documentBuildThisLoad = buildIdOf\(response\);/);
  assert.match(SW_SRC, /let documentBuildThisLoad = null;/,
    'null is the safe default: no header, a restarted worker, or a document '
    + 'served before this shipped all fall back to the race');
  assert.match(SW_SRC, /const SHELL_BUILD_HEADER = 'x-platform-build';/,
    'lower-case: Headers.get is case-insensitive but the constant is read by eye');
});

test('the board does not wait on a token it never uses', () => {
  // /api/iframe-token is a short-lived credential and is hard-bypassed by
  // the worker, so it always costs a full round trip. It used to hide behind
  // the GET /api/apps/:slug it ran alongside; putting that read in the fast
  // lane made it the longest thing between a cached board and the screen.
  const view = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(view, /async open\(slug, \{ needsToken = true \} = \{\}\)/,
    'defaults to waiting, so every other caller is unchanged');
  assert.match(view, /if \(needsToken\) await tokenReady;/);
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // `!!tab` is load-bearing. Without an explicit tab the route came from the
  // launcher's CACHED record, and a record that still says self-hosted for an
  // app that no longer is lands on the App tab — which would then build its
  // iframe token-less.
  assert.match(app,
    /AppView\.open\(slug, \{ needsToken: !\(tab && initialRoute\.tab === 'dev'\) \}\)/);
});

test('a refresh of a board already on screen tells the worker it is not a boot', () => {
  // The boot lane answers a boot read from cache on a zero deadline and
  // corrects it later. Only pull-to-refresh used to say "this is a refresh",
  // so a correction's own re-pull and every live board refresh (a session or
  // checks event over the WS, the 20s checks poll) were laned too: served
  // stale, found different, corrected, re-pulled — the Workshop's /promoted
  // list carries live check progress, so under load that never settled and
  // each visible tab re-pulled its board about once a second until Chrome
  // refused new requests (net::ERR_INSUFFICIENT_RESOURCES).
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  const refreshActive = app.slice(app.indexOf('  refreshActiveScreen() {'));
  assert.match(refreshActive.slice(0, 1200),
    /if \(document\.hidden\) return;[\s\S]*?App\._announceRefreshIntent\(\);[\s\S]*?const visible =/,
    'a correction re-pull announces refresh intent before any loader runs');
  const refreshDev = view.slice(view.indexOf('  refreshDevData(kind, live = null) {'));
  assert.match(refreshDev.slice(0, 800), /App\._announceRefreshIntent\?\.\(\);/,
    'every live board refresh announces refresh intent');
  // And the worker honours it: an announced refresh is never laned.
  assert.match(SW_SRC, /function bootLaneApplies\(url, selfOrigin, now, refreshUntil\) \{\s*if \(refreshUntil && now < refreshUntil\) return false;/);
});
