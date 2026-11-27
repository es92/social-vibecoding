// Each page reads what it draws, once.
//
// An audit of every platform page against production data found reads made
// only to be discarded or made twice. Pinned here:
//   - the Workshop asks /issues for its governance rows only (the rest are
//     request twins it filtered out on arrival: 325 rows, ~540 KB, on the
//     platform app), and without the flag the route answers every row;
//   - the service worker gives identical API reads asked for in the same
//     moment one network request; a later read, or any read after a write,
//     makes its own, and nothing is kept once a request settles;
//   - on the App tab the dev caches' warm-up waits for the app's frame;
//   - the chat composers warm their @/# candidates on focus, not on mount.
//
// Run with: node --test tests/page-payload-trims.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the Workshop asks /issues for governance rows only; the route keeps its old answer without the flag', () => {
  const route = read('src/routes/issues.js');
  assert.match(route, /function listedKinds\(raw\) \{\s*return raw === 'governance' \? \[\.\.\.require\('\.\.\/services\/governance-kinds'\)\.GOVERNANCE_KINDS\] : null;/);
  assert.match(route, /AND \(\$3::text\[\] IS NULL OR i\.kind = ANY\(\$3::text\[\]\)\)/);
  assert.match(route, /\[appId, req\.user\.id, listedKinds\(req\.query\.kinds\)\]/);
  const view = read('public/js/app-view.js');
  assert.match(view, /want\('issues'\) \? fetch\(`\/api\/apps\/\$\{slug\}\/issues\$\{AppView\._withDemo\('kinds=governance'\)\}`\)/);
  // The client's own filter stays: it is the list the server's constant is
  // checked against (tests/workshop-screen.test.js).
  assert.match(view, /\.filter\(\(i\) => i\.kind === 'secret_change' \|\| i\.kind === 'rename' \|\| i\.kind === 'close_issue'/);
});

test('reads asked for in the same moment share one network request; a late read or a write ends sharing', async () => {
  const src = read('public/sw.js');
  const fn = src.slice(src.indexOf('function sharedApiFetch'), src.indexOf('async function networkFirstApi'));
  assert.match(src, /const API_SHARE_WINDOW_MS = 100;/);
  assert.match(fn, /if \(open && now - open\.startedAt <= API_SHARE_WINDOW_MS\) \{/);
  assert.match(fn, /return entry\.pending\.then\(\(res\) => res\.clone\(\)\);/, 'every asker gets its own Response');
  assert.match(src, /startFetch: \(\) => sharedApiFetch\(event\.request\)\.then/);
  // Any write, a logout included, clears the map before anything else runs.
  const handler = src.slice(src.indexOf("self.addEventListener('fetch'"));
  assert.match(handler, /if \(req\.method !== 'GET' && req\.method !== 'HEAD'\) inflightApi\.clear\(\);/);
  assert.ok(handler.indexOf('inflightApi.clear();') < handler.indexOf('clearApiCaches()'));

  // The same logic, run against a clock and a network the test controls.
  const inflightApi = new Map();
  let now = 1000;
  const clock = { now: () => now };
  const answers = [];
  const fetch = () => new Promise((resolve) => { answers.push(resolve); });
  // eslint-disable-next-line no-new-func
  const sharedApiFetch = new Function('inflightApi', 'fetch', 'API_SHARE_WINDOW_MS', 'Date', `${fn}; return sharedApiFetch;`)(inflightApi, fetch, 100, clock);
  const req = new Request('https://x.example/api/notifications?limit=100');

  const a = sharedApiFetch(req);
  now += 40;
  const b = sharedApiFetch(req);
  assert.equal(answers.length, 1, 'two reads 40 ms apart share one request');

  now += 200;
  const late = sharedApiFetch(req);
  assert.equal(answers.length, 2, 'a read after the window starts its own request, though the first is still in flight');

  inflightApi.clear(); // what a write does
  const afterWrite = sharedApiFetch(req);
  assert.equal(answers.length, 3, 'a read after a write never joins a request from before it');

  answers.forEach((resolve, i) => resolve(new Response(JSON.stringify({ n: i + 1 }))));
  assert.deepEqual(await (await a).json(), { n: 1 });
  assert.deepEqual(await (await b).json(), { n: 1 });
  assert.deepEqual(await (await late).json(), { n: 2 });
  assert.deepEqual(await (await afterWrite).json(), { n: 3 });
  await new Promise((r) => setImmediate(r));
  assert.equal(inflightApi.size, 0, 'nothing is kept once requests settle');
});

test('on the App tab the dev caches warm after the app frame loads', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /if \(needsToken\) AppView\._prefetchDevDataAfterFrame\(slug\);\s*else AppView\.prefetchDevData\(slug\);/);
  assert.match(view, /_prefetchDevDataAfterFrame\(slug\) \{[\s\S]*?setTimeout\(start, AppView\.DEV_PREFETCH_CAP_MS\);/,
    'capped, so a frame that never loads does not hold it forever');
  assert.match(view, /if \(iframeId === 'app-iframe' && AppView\._afterAppFrameLoad\) AppView\._afterAppFrameLoad\(\);/);
});

test('the chat composers read their candidates when asked, not on every mount', () => {
  // One message box (27 Nov 2026): a project chat's `#` list (its open
  // requests and changes, two of the board's largest reads) is read the
  // first time somebody types `#`, and its `@` list the first time `@` is
  // asked; showing a chat reads neither.
  const gc = read('frontend/src/features/group-chat/composer.tsx');
  assert.match(gc, /if \(!held && before\.includes\('#'\)\) void loadChatRefs\(slug\)/);
  const sources = read('frontend/src/features/group-chat/chat-sources.ts');
  assert.match(sources, /ask: async \(query\) => \{\n\s+const entry = await loadChatPeople\(slug\);/);
  assert.doesNotMatch(gc, /useEffect/, 'nothing is read as the box mounts');
});
