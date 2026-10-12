// Behavioural tests for capture/capture.js runTests — the bounded parallel
// page pool that replaced the sequential per-check loop (#1019).
//
// Why the loop had to go: the manifest reader used to keep only the first 12
// declared checks, so a 241-check manifest ran 12 checks and dropped 229.
// Removing the cap makes the RUNTIME the binding constraint instead —
// production measures ~3.9s marginal per check, so 241 sequential checks is
// ~16 minutes of a merge gate nobody would wait for. The pool is what makes
// "run everything" affordable.
//
// Four properties matter and none are visible from the frame format alone,
// so they are tested against a fake browser (runTests takes its pages from
// whatever it is handed, so no Chromium is needed):
//
//   1. ISOLATED CONTEXTS — every group gets its own browser context: its own
//      WINDOW (a same-context tab is `visibilityState: 'hidden'`, where view
//      transitions abort with a pageerror and rAF-driven UI never presents)
//      and its own cookie jar (each group's navigation exchanges its own
//      ?token= deterministically — the shared-jar design raced concurrent
//      exchanges and the losers rendered the "Admins only" gate).
//   2. BOUNDED — at most `concurrency` pages are open at once, whatever the
//      suite size. Unbounded fan-out is an OOM-kill, which loses the whole
//      run rather than one check.
//   3. PER-CHECK DEADLINE — a check that hangs is recorded as a failure and
//      its slot is released, so one bad route can't hold a worker forever.
//   4. SENTINEL — the run states how far it got, so the platform can tell a
//      budget-truncated suite from a crashed container.
//
// Most cases use `mode: 'fast'`, where the fake navigation rejects: runTest
// then emits its frame immediately instead of paying SETTLE_MS +
// CONSOLE_ONLY_SETTLE_MS (2s) per check. The verdict is beside the point for
// dispatch mechanics, and a suite that took 2s × waves would be minutes long.
// One case runs the settling path so the happy shape is covered too.
//
// Run with: node --test tests/capture-pool.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTests, runTestGroup, groupTestsByUrl, groupTestsByDocument, groupTests, cohortsOf,
  hashGroupCap, poolSize, testTimeoutMs, testsDeadlineMs, setFrameSink, assertMaxMs,
  makeConsoleErrorSink,
} = require('../capture/capture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake browser. Mirrors the production shape (createBrowserContext →
// newPage), records page open/close so concurrency is observable, counts
// contexts so isolation is observable, and lets each test control how long
// a given check takes.
function makeBrowser({ delays = {}, log = [], mode = 'fast', missingSelectors = [] } = {}) {
  let open = 0;
  let peak = 0;
  let contexts = 0;
  let openContexts = 0;
  const newPage = async () => {
    open += 1;
    if (open > peak) peak = open;
    let closed = false;
    let url = '';
    return {
      on() {},
      async setViewport() {},
      async goto(u) {
        url = u;
        log.push({ call: 'goto', url: u, concurrent: open });
        const ms = delays[u];
        if (ms) await sleep(ms);
        if (mode === 'fast') throw new Error('fake: navigation refused');
        return { status: () => 200 };
      },
      async waitForNetworkIdle() {},
      async $(sel) { return missingSelectors.includes(sel) ? null : {}; },
      async evaluate() { return true; },
      async close() {
        if (!closed) { closed = true; open -= 1; }
        log.push({ call: 'close', url });
      },
    };
  };
  return {
    peak: () => peak,
    contexts: () => contexts,
    openContexts: () => openContexts,
    log,
    async createBrowserContext() {
      contexts += 1;
      openContexts += 1;
      let ctxClosed = false;
      return {
        newPage,
        async close() {
          if (!ctxClosed) { ctxClosed = true; openContexts -= 1; }
        },
      };
    },
    newPage,
  };
}

function suite(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: i, name: `check ${i}`, path: `/p${i}`, url: `http://staging/p${i}`,
  }));
}

// Redirect the frame sink into an array; the returned reader parses it.
function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => {
    const lines = chunks.join('').split('\n');
    const frames = [];
    let done = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('__USERNODE_TESTS_DONE__ ')) {
        done = {};
        for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) done[m[1]] = m[2];
        continue;
      }
      if (!lines[i].startsWith('__USERNODE_TEST__ ')) continue;
      const attrs = {};
      for (const m of lines[i].matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = JSON.parse(Buffer.from(lines[i + 1], 'base64').toString('utf8'));
      frames.push({ index: Number(attrs.index), status: attrs.status, ...payload });
    }
    return { frames, done };
  };
}

test('every declared check gets exactly one frame', async () => {
  const read = collect();
  const result = await runTests(makeBrowser(), suite(25), { concurrency: 6, testTimeoutMs: 5000 });
  const { frames, done } = read();
  assert.equal(frames.length, 25, 'one frame per check, no more and no fewer');
  assert.deepEqual(
    frames.map((f) => f.index).sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i),
    'and the frames cover every dispatched index'
  );
  assert.equal(result.ran, 25);
  assert.equal(done.ran, '25');
  assert.equal(done.expected, '25');
  assert.equal(done.deadline, '0');
});

test('every group runs in its own browser context, and all of them close', async () => {
  // Isolation is the load-bearing property (see the header): a same-context
  // tab is a HIDDEN document — view transitions abort with a pageerror and
  // rAF-driven UI never presents — and a shared cookie jar races concurrent
  // ?token= exchanges. One context per group means one window and one jar
  // per group. Contexts must also all be closed, or a long suite leaks
  // renderer memory the pool's page bound was supposed to cap.
  const read = collect();
  const browser = makeBrowser();
  await runTests(browser, suite(12), { concurrency: 8, testTimeoutMs: 5000 });
  read();
  assert.equal(browser.contexts(), 12, 'one context per URL group');
  assert.equal(browser.openContexts(), 0, 'and every context was closed');
});

test('concurrency is bounded by the pool size', async () => {
  const read = collect();
  const delays = {};
  for (let i = 0; i < 20; i += 1) delays[`http://staging/p${i}`] = 25;
  const browser = makeBrowser({ delays });
  await runTests(browser, suite(20), { concurrency: 4, testTimeoutMs: 5000 });
  read();
  assert.ok(browser.peak() <= 4,
    `at most 4 pages should be open at once, saw ${browser.peak()}`);
  assert.ok(browser.peak() > 1, 'and it really did run in parallel, not sequentially');
});

test('a hung check fails on the per-check deadline instead of wedging a worker', async () => {
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/p1': 600 } });
  const started = Date.now();
  const result = await runTests(browser, suite(4), { concurrency: 2, testTimeoutMs: 120 });
  const elapsed = Date.now() - started;
  // Let the abandoned navigation land before reading, so its late frame is
  // attributed to this test instead of leaking into the next one — and so
  // the dedupe below is actually exercised.
  await sleep(700);
  const { frames } = read();
  assert.ok(elapsed < 500, `the suite must not wait out the hung check, took ${elapsed}ms`);
  const hung = frames.find((f) => f.index === 1);
  assert.equal(hung.status, 'fail');
  assert.match(hung.failureReason, /did not finish within/,
    'and the reason says so plainly rather than blaming the assertion');
  assert.equal(frames.length, 4, 'the other checks still report');
  assert.equal(result.ran, 4);
});

test('a straggler cannot overwrite the verdict already recorded for it', async () => {
  // The timeout frame is written while runTest is still in flight. When it
  // finally finishes it emits its own frame for the same index — first writer
  // must win, or the platform sees two contradictory verdicts for one check
  // and keeps whichever landed last.
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/p0': 250 } });
  await runTests(browser, suite(1), { concurrency: 1, testTimeoutMs: 40 });
  await sleep(400);
  const { frames } = read();
  assert.equal(frames.length, 1, 'exactly one frame for the timed-out check');
  assert.equal(frames[0].status, 'fail');
  assert.match(frames[0].failureReason, /did not finish within/);
});

test('the global deadline stops dispatch and says so in the sentinel', async () => {
  const read = collect();
  const delays = {};
  for (let i = 0; i < 40; i += 1) delays[`http://staging/p${i}`] = 40;
  const browser = makeBrowser({ delays });
  const result = await runTests(browser, suite(40), {
    concurrency: 2, testTimeoutMs: 5000, deadlineMs: 300,
  });
  const { frames, done } = read();
  assert.ok(result.deadline, 'the run reports that it ran out of budget');
  assert.equal(done.deadline, '1');
  assert.ok(frames.length < 40, 'not every check got dispatched');
  assert.equal(done.ran, String(frames.length),
    'and the sentinel reports the count it actually produced');
  assert.equal(done.expected, '40', 'against the count it was asked for');
});

test('an empty suite still emits the sentinel', async () => {
  const read = collect();
  const result = await runTests(makeBrowser(), [], {});
  const { done } = read();
  assert.equal(result.ran, 0);
  assert.equal(done.ran, '0');
  assert.equal(done.expected, '0');
  assert.equal(done.deadline, '0');
});

test('checks that load cleanly pass, through the pool', async () => {
  // The one case on the settling path, so the happy shape is covered and not
  // just the dispatch mechanics.
  const read = collect();
  const browser = makeBrowser({ mode: 'ok' });
  await runTests(browser, suite(2), { concurrency: 2, testTimeoutMs: 20000 });
  const { frames, done } = read();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.equal(done.ran, '2');
  assert.equal(done.deadline, '0');
});

// ── URL grouping: one navigation per route, one frame per check ─────────

test('checks on the same URL share one navigation but keep their own verdicts', async () => {
  // The manifest clusters heavily (this repo: 234 checks over ~106 routes,
  // 46 on the dev screen alone) and navigation + settle is where the wall
  // clock goes. Grouping must not blur what each check means: same page,
  // independent assertions, independent frames.
  const read = collect();
  const log = [];
  const browser = makeBrowser({ log, mode: 'ok', missingSelectors: ['#gone'] });
  const tests = [
    { index: 0, name: 'a', path: '/shared', url: 'http://staging/shared', expectSelector: '#here' },
    { index: 1, name: 'b', path: '/shared', url: 'http://staging/shared', expectSelector: '#gone' },
    { index: 2, name: 'c', path: '/shared', url: 'http://staging/shared', expectText: 'welcome' },
    { index: 3, name: 'd', path: '/other', url: 'http://staging/other' },
  ];
  const result = await runTests(browser, tests, {
    concurrency: 4, testTimeoutMs: 20000,
    // #gone never appears; a tight ceiling keeps this dispatch-shape test fast.
    assertMaxMs: 100, assertPollMs: 25,
    // Check `b` fails, so the retry pass would legitimately add three more
    // navigations of its own. This test is about the shape of the MAIN
    // dispatch; the retry pass has its own test below.
    env: { ...process.env, TEST_RETRY_RUNS: '0' },
  });
  const { frames, done } = read();
  const gotos = log.filter((e) => e.call === 'goto');
  assert.equal(gotos.length, 2, 'two distinct URLs, two navigations — not four');
  assert.equal(frames.length, 4, 'but still one frame per check');
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass');
  assert.equal(byIndex.get(1).status, 'fail', 'the missing selector fails only its own check');
  assert.match(byIndex.get(1).failureReason, /#gone/);
  assert.equal(byIndex.get(2).status, 'pass');
  assert.equal(byIndex.get(3).status, 'pass');
  assert.equal(result.ran, 4, 'the sentinel counts checks, not navigations');
  assert.equal(done.ran, '4');
  assert.equal(done.expected, '4');
});

test('a failed check is asked again, alone, and the retries say what they are', async () => {
  // The retry pass, in the container. A check that failed is re-run on its
  // own cold document — not as another assertion against a page somebody
  // already loaded, which is what grouping would otherwise make of it.
  const read = collect();
  const log = [];
  const browser = makeBrowser({ log, mode: 'ok', missingSelectors: ['#gone'] });
  // Eight checks over two documents, one of them failing. One in eight is
  // comfortably under the ceiling that says "this is the change, not
  // flakiness" — with a two-check suite a single failure is fifty percent
  // and nothing would be asked again, which is the cap working.
  const tests = [
    { index: 0, name: 'a', path: '/shared', url: 'http://staging/shared', expectSelector: '#here' },
    { index: 1, name: 'b', path: '/shared', url: 'http://staging/shared', expectSelector: '#gone' },
    { index: 2, name: 'c', path: '/shared', url: 'http://staging/shared' },
    { index: 3, name: 'd', path: '/shared', url: 'http://staging/shared' },
    { index: 4, name: 'e', path: '/other', url: 'http://staging/other' },
    { index: 5, name: 'f', path: '/other', url: 'http://staging/other' },
    { index: 6, name: 'g', path: '/other', url: 'http://staging/other' },
    { index: 7, name: 'h', path: '/other', url: 'http://staging/other' },
  ];
  const result = await runTests(browser, tests, {
    concurrency: 4, testTimeoutMs: 20000, assertMaxMs: 100, assertPollMs: 25,
    env: { ...process.env, TEST_RETRY_RUNS: '3' },
  });
  const { frames, done } = read();

  // Two navigations for the two documents, then one per retry.
  assert.equal(log.filter((e) => e.call === 'goto').length, 5);

  const retries = frames.filter((f) => f.retryOf != null);
  assert.equal(retries.length, 3, 'the failing check, three more times');
  assert.deepEqual([...new Set(retries.map((f) => f.retryOf))], [1],
    'and only the failing one');
  assert.ok(retries.every((f) => f.index >= 1000000),
    'from a base that cannot collide with a declared index, which emitTest would drop');

  // The sentinel still counts declared checks. The platform reads these two
  // to decide whether every check reported, and a retry is a second opinion
  // on a check it already has, not another check.
  assert.equal(result.ran, 8);
  assert.equal(done.ran, '8');
  assert.equal(done.expected, '8');
});

test('a suite that is mostly red is the change, and nothing is asked again', async () => {
  const read = collect();
  const log = [];
  const browser = makeBrowser({ log, mode: 'ok', missingSelectors: ['#gone'] });
  const tests = [
    { index: 0, name: 'a', path: '/a', url: 'http://staging/a', expectSelector: '#gone' },
    { index: 1, name: 'b', path: '/b', url: 'http://staging/b', expectSelector: '#gone' },
    { index: 2, name: 'c', path: '/c', url: 'http://staging/c' },
  ];
  await runTests(browser, tests, {
    concurrency: 4, testTimeoutMs: 20000, assertMaxMs: 100, assertPollMs: 25,
    env: { ...process.env, TEST_RETRY_RUNS: '3' },
  });
  const { frames } = read();
  assert.equal(frames.filter((f) => f.retryOf != null).length, 0,
    'two of three red is well past the ceiling: asking again would only make '
    + 'a broken change a slow broken change');
  assert.equal(log.filter((e) => e.call === 'goto').length, 3);
});

test('a failed navigation fails every check that shared the URL', async () => {
  const read = collect();
  const browser = makeBrowser({ mode: 'fast' }); // every goto rejects
  const tests = [
    { index: 0, name: 'a', path: '/p', url: 'http://staging/p' },
    { index: 1, name: 'b', path: '/p', url: 'http://staging/p', expectSelector: '#x' },
  ];
  await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 5000 });
  const { frames } = read();
  assert.equal(frames.length, 2, 'both checks report');
  for (const f of frames) {
    assert.equal(f.status, 'fail');
    assert.match(f.failureReason, /Page failed to load/,
      'and the reason is the load, not a misattributed assertion');
  }
});

test('a hung group fails all its unreported checks on the scaled deadline', async () => {
  // The group deadline is testTimeoutMs for the checks, testTimeoutMs again
  // for the group's one navigation, and 1s per extra check (assertions are
  // cheap but not free). Two checks share the slow URL, so the budget here is
  // 120 + 120 + 1000 = 1240ms — the 2s hang must be cut off at that deadline,
  // and BOTH slow-URL checks must get a "did not finish" frame.
  const read = collect();
  const browser = makeBrowser({ delays: { 'http://staging/slow': 2000 } });
  const tests = [
    { index: 0, name: 'a', path: '/fast', url: 'http://staging/fast' },
    { index: 1, name: 'b', path: '/slow', url: 'http://staging/slow' },
    { index: 2, name: 'c', path: '/slow', url: 'http://staging/slow' },
  ];
  const started = Date.now();
  const result = await runTests(browser, tests, { concurrency: 2, testTimeoutMs: 120 });
  const elapsed = Date.now() - started;
  await sleep(2100); // let the abandoned navigation land before reading
  const { frames } = read();
  assert.ok(elapsed < 1600, `the suite must not wait out the hung group, took ${elapsed}ms`);
  assert.equal(frames.length, 3, 'every check still gets exactly one frame');
  for (const i of [1, 2]) {
    const f = frames.find((x) => x.index === i);
    assert.equal(f.status, 'fail');
    assert.match(f.failureReason, /did not finish within/);
  }
  assert.equal(result.ran, 3);
});

test('groupTestsByUrl preserves declaration order within and across groups', () => {
  const tests = [
    { index: 0, url: 'u1' }, { index: 1, url: 'u2' },
    { index: 2, url: 'u1' }, { index: 3, url: 'u3' },
  ];
  const groups = groupTestsByUrl(tests);
  assert.deepEqual(groups.map((g) => g.map((t) => t.index)), [[0, 2], [1], [3]],
    'first-appearance order across groups, declaration order within');
});

// ── Document grouping + the quiet-window settle (#1144) ─────────────────
//
// Per-URL grouping keyed on the fully resolved URL, so `…/dev#/a` and
// `…/dev#/b` were two cold loads of one document. This repo's 314 checks
// resolve to 158 URLs but only 73 documents, and at ~2s of unconditional
// settle per navigation over 8 lanes that was ~40s of a 72s capture spent
// asleep. Grouping by document and moving between hashes in-page removes the
// duplicate loads; the quiet window removes the sleep that is not needed.
//
// Two properties are load-bearing and neither is visible from the frame
// format: a hash cohort's console errors must not be blamed on its siblings,
// and a page that never goes quiet must still be cut off.

test('groupTestsByDocument shares a document across hashes and caps the cohorts', () => {
  const t = (index, url) => ({ index, url });
  const groups = groupTestsByDocument([
    t(0, 'http://s/dev#/a'), t(1, 'http://s/other'), t(2, 'http://s/dev#/b'),
    t(3, 'http://s/dev#/a'), t(4, 'http://s/dev'),
  ], { cap: 6 });
  assert.deepEqual(groups.map((g) => g.map((x) => x.index)), [[4, 0, 3, 2], [1]],
    'one group per document, ordered cohort-major (each hash\'s checks stay '
    + 'adjacent so the page is visited once per cohort), first-appearance '
    + 'order within and between cohorts — except the hash-less cohort (4), '
    + 'which leads because it is the one the cold load lands on');

  // The cap keeps one popular document from serialising into a single lane
  // and becoming the critical path while other workers sit idle.
  const many = Array.from({ length: 7 }, (_, i) => t(i, `http://s/dev#/${i}`));
  const capped = groupTestsByDocument(many, { cap: 3 });
  assert.deepEqual(capped.map((g) => g.length), [3, 3, 1],
    'overflow spills into further groups for the same document');
  assert.equal(hashGroupCap({}), 6, 'the default cap');
  assert.equal(hashGroupCap({ TEST_HASH_GROUP_CAP: '3' }), 3);
  assert.equal(hashGroupCap({ TEST_HASH_GROUP_CAP: 'lots' }), 6, 'garbage falls back');
});

test('the hash-less cohort always leads, and the kill-switch restores per-URL grouping', () => {
  // Clearing a fragment is not a same-document navigation — reaching the bare
  // document by writing location.hash would reload the page mid-group. So it
  // has to be the cold load.
  const cohorts = cohortsOf([
    { index: 0, url: 'http://s/dev#/a' },
    { index: 1, url: 'http://s/dev' },
    { index: 2, url: 'http://s/dev#/b' },
  ]);
  assert.deepEqual(cohorts.map((c) => c.hash), ['', '#/a', '#/b']);

  const tests = [{ index: 0, url: 'http://s/dev#/a' }, { index: 1, url: 'http://s/dev#/b' }];
  assert.equal(groupTests(tests, {}).length, 1, 'one document, one group');
  assert.equal(groupTests(tests, { TEST_GROUP_BY_DOCUMENT: '0' }).length, 2,
    'the flag restores a group per URL, with no deploy');
});

test('the BUILDER hoists the bare cohort too, so goto() lands on the leading cohort', () => {
  // The runner navigates once, to group[0].url, and treats the first cohort as
  // already loaded. If the builder emitted cohorts in declaration order while
  // the runner reordered them, a bare cohort declared second would be checked
  // against the FIRST cohort's fragment — every one of its assertions
  // evaluated on the wrong screen. The two orderings must be the same one.
  const groups = groupTests([
    { index: 0, url: 'http://s/dev#/a' },
    { index: 1, url: 'http://s/dev' },
    { index: 2, url: 'http://s/dev#/b' },
  ], {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].index, 1, 'the bare test leads the flattened group');
  assert.equal(cohortsOf(groups[0])[0].tests[0], groups[0][0],
    'and the runner agrees: cohort 0 starts at the test goto() will load');

  // Past the cap, the bare cohort must be in the FIRST chunk — chunking after
  // the hoist is what guarantees it.
  const many = [];
  for (let i = 0; i < 9; i += 1) many.push({ index: i, url: `http://s/dev#/h${i}` });
  many.push({ index: 9, url: 'http://s/dev' });
  const chunked = groupTests(many, { TEST_HASH_GROUP_CAP: '4' });
  assert.equal(chunked.length, 3, '10 cohorts at a cap of 4');
  assert.equal(chunked[0][0].index, 9, 'the bare cohort leads chunk one');
  for (const g of chunked) {
    assert.equal(cohortsOf(g)[0].tests[0], g[0],
      'every chunk leads with the cohort its own goto() lands on');
  }
});

// A page whose console output is under the test's control, so attribution can
// be observed. Mirrors the production listener shape (page.on('console', …)).
function makeEventPage({ onGoto, onHash } = {}) {
  const handlers = new Map();
  const page = {
    gotos: [], hashes: [],
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    consoleHandlers() { return handlers.get('console') || []; },
    emitError(text) {
      for (const fn of handlers.get('console') || []) {
        fn({ type: () => 'error', text: () => text, location: () => ({ url: 'app.js', lineNumber: 1 }) });
      }
    },
    // One request lifecycle event, which is what rolls the assert window.
    emitRequest() {
      for (const fn of handlers.get('response') || []) fn({});
    },
    async setViewport() {},
    async goto(u) {
      page.gotos.push(u);
      if (onGoto) onGoto(page);
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    async $() { return {}; },
    async evaluate(fn, arg) {
      // The hash switch is the only evaluate that touches location.
      if (typeof fn === 'function' && /location\.hash/.test(String(fn))) {
        page.hashes.push(arg);
        if (onHash) onHash(page, arg);
        return undefined;
      }
      return true;
    },
    async close() {},
  };
  return page;
}

test('cold checks separate document navigation from equivalent network-idle readiness', async () => {
  const read = collect();
  const calls = [];
  const page = makeEventPage();
  const goto = page.goto;
  page.goto = async (url, options) => {
    calls.push({ call: 'goto', options });
    return goto(url);
  };
  page.waitForNetworkIdle = async (options) => {
    calls.push({ call: 'network-idle', options });
  };

  await runTestGroup({ newPage: async () => page },
    [{ index: 0, name: 'history traversal', path: '/settings', url: 'http://s/#settings' }],
    { settleQuietMs: 0, settleMaxMs: 0 });

  const { frames } = read();
  assert.equal(frames[0].status, 'pass');
  assert.deepEqual(calls.map((entry) => entry.call), ['goto', 'network-idle'],
    'DOMContentLoaded completes before the independent idle observation starts');
  assert.equal(calls[0].options.waitUntil, 'domcontentloaded',
    'a later same-document history traversal cannot replace the document-load watcher');
  assert.equal(calls[0].options.timeout, 30000);
  assert.equal(calls[1].options.concurrency, 2,
    'the readiness threshold remains networkidle2, not the stricter networkidle0');
  assert.equal(calls[1].options.idleTime, 500);
  assert.ok(calls[1].options.timeout > 0 && calls[1].options.timeout <= 30000,
    'both phases share the existing navigation budget');
});

test('a hash cohort owns its own console errors, and load errors are shared', async () => {
  const read = collect();
  // Each error is raised asynchronously, as a page's are, but in a microtask
  // queued by the navigation itself, so it lands before the runner moves on
  // whatever the clock does. Timers of 40 and 60 ms fired after a 100 ms
  // settle window on a loaded checks pod (12 Oct 2026), and the cohort's
  // error went unheard.
  const page = makeEventPage({
    onGoto: (p) => queueMicrotask(() => p.emitError('boot exploded')),
    onHash: (p, h) => queueMicrotask(() => p.emitError(`broken in ${h}`)),
  });
  const group = [
    { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a' },
    { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b' },
  ];
  await runTestGroup({ newPage: async () => page }, group,
    { settleQuietMs: 100, settleMaxMs: 900 });
  const { frames } = read();
  assert.equal(page.gotos.length, 1, 'one cold load for the whole document');
  assert.deepEqual(page.hashes, ['#/b'], 'the second cohort is reached in-page');

  const a = frames.find((f) => f.index === 0);
  const b = frames.find((f) => f.index === 1);
  assert.deepEqual(a.consoleErrors.map((e) => e.message), ['boot exploded'],
    'the cold-load error belongs to every cohort — each would have seen it '
    + 'when it was its own navigation');
  assert.deepEqual(b.consoleErrors.map((e) => e.message), ['boot exploded', 'broken in #/b'],
    'but the error raised after the hash switch belongs to that cohort alone');
  assert.match(a.failureReason, /1 console error/);
  assert.match(b.failureReason, /2 console errors/);
});

// An Error argument reaches the listener as the text "JSHandle@error"; the
// handle's `evaluate` is how the runner reads the real error in the page.
function errorHandleMessage(error, delayMs = 0) {
  return {
    type: () => 'error',
    text: () => 'JSHandle@error',
    location: () => ({ url: 'http://s/shell/assets/shell.js', lineNumber: 48 }),
    args: () => [{
      evaluate: async (fn) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return fn(error);
      },
    }],
  };
}

test('an Error logged by console.error is recorded by its message and island, not as JSHandle@error', async () => {
  const pushed = [];
  const sink = makeConsoleErrorSink((kind, message, source) => pushed.push({ kind, message, source }));
  const prevWindow = globalThis.window;
  globalThis.window = { UsernodeReact: { islandErrors: [{ island: 'portal:gc-thread-messages', message: 'x is undefined' }] } };
  try {
    sink.onConsole(errorHandleMessage(new TypeError('x is undefined')));
    sink.onConsole(errorHandleMessage(new Error('other failure')));
    sink.onConsole({ type: () => 'error', text: () => 'plain text', location: () => null });
    await sink.settle();
  } finally {
    globalThis.window = prevWindow;
  }
  assert.equal(pushed.length, 3, 'two different Errors are two entries, not one deduped placeholder');
  const typeError = pushed.find((p) => p.message.startsWith('TypeError'));
  const other = pushed.find((p) => p.message.startsWith('Error: other'));
  assert.match(typeError.message, /^TypeError: x is undefined \[island portal:gc-thread-messages\]/);
  assert.match(typeError.message, /\n\s+at /, 'the stack frames follow the head');
  assert.match(other.message, /^Error: other failure(\n|$)/, 'no island tag when no boundary recorded it');
  assert.ok(pushed.some((p) => p.message === 'plain text'), 'text messages are recorded unchanged');
  assert.equal(typeError.source, 'http://s/shell/assets/shell.js:48');
});

test('an Error is resolved even when the console text already reads as its message', async () => {
  const pushed = [];
  const sink = makeConsoleErrorSink((kind, message) => pushed.push(message));
  const error = new RangeError('bad index');
  sink.onConsole({
    type: () => 'error',
    text: () => 'RangeError: bad index',
    location: () => null,
    args: () => [{ remoteObject: () => ({ type: 'object', subtype: 'error' }), evaluate: async (fn) => fn(error) }],
  });
  await sink.settle();
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^RangeError: bad index\n\s+at /, 'the stack is kept, not just the message');
});

test('an Error that fails to resolve in the page is still recorded', async () => {
  const pushed = [];
  const sink = makeConsoleErrorSink((kind, message) => pushed.push(message));
  sink.onConsole({
    type: () => 'error',
    text: () => 'JSHandle@error',
    location: () => null,
    args: () => [{ evaluate: async () => { throw new Error('Execution context was destroyed'); } }],
  });
  await sink.settle();
  assert.deepEqual(pushed, ['JSHandle@error']);
});

test('an Error still resolving at a hash switch counts against the cohort it fired in', async () => {
  const read = collect();
  const timers = [];
  const page = makeEventPage({
    onHash: (p, h) => {
      if (h === '#/a') {
        timers.push(setTimeout(() => {
          for (const fn of p.consoleHandlers()) fn(errorHandleMessage(new Error('a broke'), 150));
        }, 20));
      }
    },
  });
  const group = [
    { index: 0, name: 'bare', path: '/dev', url: 'http://s/dev' },
    { index: 1, name: 'a', path: '/dev', url: 'http://s/dev#/a' },
    { index: 2, name: 'b', path: '/dev', url: 'http://s/dev#/b' },
  ];
  try {
    await runTestGroup({ newPage: async () => page }, group,
      { settleQuietMs: 60, settleMaxMs: 400 });
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  const byIndex = new Map(read().frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass');
  assert.deepEqual(byIndex.get(1).consoleErrors.map((e) => e.message.split('\n')[0]), ['Error: a broke']);
  assert.equal(byIndex.get(2).status, 'pass', 'the slow resolution did not land in the next cohort');
});

test('a cohort that breaks does not fail the cohorts it shares a document with', async () => {
  const read = collect();
  // In a microtask of the hash switch, not on a 40 ms timer that can fire
  // after the 80 ms settle on a loaded pod (see the hash cohort test above).
  const page = makeEventPage({
    onHash: (p, h) => {
      if (h === '#/b') queueMicrotask(() => p.emitError('only b is broken'));
    },
  });
  const group = [
    { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a' },
    { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b' },
    { index: 2, name: 'c', path: '/dev', url: 'http://s/dev#/c' },
  ];
  await runTestGroup({ newPage: async () => page }, group,
    { settleQuietMs: 80, settleMaxMs: 600 });
  const { frames } = read();
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass');
  assert.equal(byIndex.get(1).status, 'fail');
  assert.equal(byIndex.get(2).status, 'pass',
    'a later cohort is not tainted by an earlier one — strictly better than '
    + 'the group-wide freeze this replaced');
});

// ── Grouping must not change a verdict (#1146) ──────────────────────────
//
// A page that renders a sub-route only when the DOCUMENT was loaded at that
// fragment. That is not a contrived shape: it is what every screen the
// grouped runner broke looks like — a `?shot=` deep link that scripts its
// interaction once at boot, an admin section painted from the boot restore,
// a tab strip that keeps whichever sub-route it was mounted on. Writing
// `location.hash` moves the URL and re-renders nothing.
function makeColdOnlyPage() {
  const page = {
    gotos: [], hashes: [], rendered: null,
    on() {},
    async setViewport() {},
    async goto(u) {
      page.gotos.push(u);
      const i = String(u).indexOf('#');
      page.rendered = i === -1 ? '' : String(u).slice(i);
      return { status: () => 200 };
    },
    async waitForNetworkIdle() {},
    // `#at-<fragment>` stands in for "the markup this sub-route renders".
    async $(sel) { return sel === `#at-${page.rendered}` ? {} : null; },
    async evaluate(fn, arg) {
      if (typeof fn === 'function' && /location\.hash/.test(String(fn))) {
        page.hashes.push(arg);
        return undefined;
      }
      return true;
    },
    async close() {},
  };
  return page;
}

const COLD_ONLY_GROUP = [
  { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a', expectSelector: '#at-#/a' },
  { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b', expectSelector: '#at-#/b' },
];

test('a cohort the hash switch did not render is re-judged on a real cold load', async () => {
  const read = collect();
  const page = makeColdOnlyPage();
  await runTestGroup({ newPage: async () => page }, COLD_ONLY_GROUP,
    { settleQuietMs: 20, settleMaxMs: 200 });
  const { frames } = read();
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass', 'cohort 0 is the cold load and was always fine');
  assert.equal(byIndex.get(1).status, 'pass',
    'cohort 1 asserted nothing after the hash switch, so it was re-run as the '
    + 'navigation the ungrouped runner would have made — batching is not '
    + 'allowed to decide a verdict');
  assert.deepEqual(page.hashes, ['#/b'], 'the cheap path is still tried first');
  assert.deepEqual(page.gotos, ['http://s/dev#/a', 'about:blank', 'http://s/dev#/b'],
    'and the fallback is a genuine cold load — a goto differing only in the '
    + 'fragment is a same-document navigation and would reload nothing');
});

test('a cohort that renders on a hash switch never pays for the fallback', async () => {
  const read = collect();
  const page = makeEventPage();          // its $() matches anything
  await runTestGroup({ newPage: async () => page },
    [
      { index: 0, name: 'a', path: '/dev', url: 'http://s/dev#/a', expectSelector: '#a' },
      { index: 1, name: 'b', path: '/dev', url: 'http://s/dev#/b', expectSelector: '#b' },
    ],
    { settleQuietMs: 20, settleMaxMs: 200 });
  const { frames } = read();
  assert.deepEqual(frames.map((f) => f.status), ['pass', 'pass']);
  assert.equal(page.gotos.length, 1,
    'one navigation for the whole document — #1144\'s win is untouched on a '
    + 'suite that passes, which is every suite that is meant to merge');
});

for (const lateConsoleError of [false, true]) {
  test(`cold fallback waits for delayed selector/text${lateConsoleError ? ' and catches late console errors' : ''}`, async () => {
    const read = collect();
    let loadedHash = '';
    let readyAt = Infinity;
    let timer;
    const page = makeEventPage({
      onGoto(p) {
        loadedHash = new URL(p.gotos.at(-1)).hash;
        if (loadedHash === '#/b') {
          readyAt = Date.now() + 250;
          if (lateConsoleError) timer = setTimeout(() => p.emitError('late hydration error'), 150);
        }
      },
    });
    page.$ = async (sel) => {
      if (sel === '#at-#/a' && loadedHash === '#/a') return {};
      return loadedHash === '#/b' && Date.now() >= readyAt ? {} : null;
    };
    const evaluate = page.evaluate;
    page.evaluate = async (fn, arg) => /location\.hash/.test(String(fn))
      ? evaluate(fn, arg) : Date.now() >= readyAt;
    try {
      await runTestGroup({ newPage: async () => page }, [
        COLD_ONLY_GROUP[0], { ...COLD_ONLY_GROUP[1], expectText: 'Hydrated screen' },
      ], { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 400, assertPollMs: 20 });
    } finally { clearTimeout(timer); }
    const row = read().frames.find((f) => f.index === 1);
    assert.equal(row.status, lateConsoleError ? 'fail' : 'pass');
    if (lateConsoleError) assert.match(JSON.stringify(row.consoleErrors), /late hydration error/);
    assert.deepEqual(page.gotos, ['http://s/dev#/a', 'about:blank', 'http://s/dev#/b']);
  });
}

test('cold fallback still fails a missing selector within a bounded window', async () => {
  const read = collect();
  const page = makeColdOnlyPage();
  const group = [COLD_ONLY_GROUP[0], { ...COLD_ONLY_GROUP[1], expectSelector: '#never' }];
  const started = Date.now();
  await runTestGroup({ newPage: async () => page }, group,
    { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 100, assertPollMs: 20 });
  const row = read().frames.find((f) => f.index === 1);
  assert.equal(row.status, 'fail');
  assert.match(row.failureReason, /#never/);
  assert.ok(Date.now() - started < 2000, 'fallback cannot wait indefinitely');
});

test('the cohort fallback can be switched off, and then the hash verdict stands', async () => {
  const read = collect();
  const page = makeColdOnlyPage();
  await runTestGroup({ newPage: async () => page }, COLD_ONLY_GROUP,
    { settleQuietMs: 20, settleMaxMs: 200, env: { TEST_COHORT_RELOAD_FALLBACK: '0' } });
  const { frames } = read();
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(1).status, 'fail');
  assert.match(byIndex.get(1).failureReason, /Expected element "#at-#\/b" was not found/);
  assert.equal(page.gotos.length, 1, 'no fallback navigation');
});

test('a page that never goes quiet is cut off at the settle ceiling', async () => {
  // The quiet window is what makes the common case fast; the ceiling is what
  // keeps a chatty page from holding a worker until the group deadline.
  const read = collect();
  let noisy = null;
  let n = 0;
  const page = makeEventPage({
    onGoto: (p) => { noisy = setInterval(() => p.emitError(`noise ${n += 1}`), 20); },
  });
  const started = Date.now();
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p' }],
      { settleQuietMs: 100, settleMaxMs: 400 });
  } finally {
    if (noisy) clearInterval(noisy);
  }
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.ok(elapsed >= 350, `it must wait out a still-noisy page, took ${elapsed}ms`);
  assert.ok(elapsed < 1200, `but not past the ceiling, took ${elapsed}ms`);
  assert.equal(frames[0].status, 'fail', 'and the errors it did see still count');
});

test('a quiet page settles well inside the ceiling', async () => {
  // The whole point: a document with nothing left to say used to pay a flat
  // 2000ms per navigation regardless.
  const read = collect();
  const page = makeEventPage();
  const started = Date.now();
  await runTestGroup({ newPage: async () => page },
    [{ index: 0, name: 'a', path: '/p', url: 'http://s/p' }],
    { settleQuietMs: 100, settleMaxMs: 2000 });
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.equal(frames[0].status, 'pass');
  assert.ok(elapsed < 900, `a silent page should not wait out the ceiling, took ${elapsed}ms`);
});

// ── Assertion polling (#1147 follow-up) ─────────────────────────────────
//
// The quiet-window settle judges a page as soon as it stops EMITTING —
// console output, page errors, request lifecycle. But timers, rAF work,
// IndexedDB reads and service-worker-served fetches emit none of those, so a
// screen can be "quiet" while it is still rendering. Under the flat 2s settle
// this was masked; the adaptive settle surfaced it as a wave of "Expected
// element was not found" failures on exactly the data-driven routes (#1147
// broke 20 of the repo's own declared checks this way). The fix: presence
// assertions POLL until they hold or a bounded deadline expires, instead of
// being evaluated once.

test('an element that renders after the quiet window still passes: assertions poll', async () => {
  const read = collect();
  let ready = false;
  let timer = null;
  const page = makeEventPage({
    // Nothing here bumps the activity clock — the page looks quiet while a
    // timer-driven render is still pending, exactly the failure mode.
    onGoto: () => { timer = setTimeout(() => { ready = true; }, 250); },
  });
  page.$ = async () => (ready ? {} : null);
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#late' }],
      { settleQuietMs: 50, settleMaxMs: 100, assertMaxMs: 2000, assertPollMs: 25 });
  } finally {
    clearTimeout(timer);
  }
  const { frames } = read();
  assert.equal(frames[0].status, 'pass',
    'a render that lands after the settle but inside the assertion deadline passes');
});

test('a hash cohort whose screen renders async still passes, selector and text', async () => {
  // Cohort switches are the tighter race: a hash write costs no navigation,
  // so the quiet window can close ~quietMs after the switch while the target
  // screen is still fetching and rendering.
  const read = collect();
  let ready = false;
  let timer = null;
  const page = makeEventPage({
    onHash: () => { timer = setTimeout(() => { ready = true; }, 200); },
  });
  const origEval = page.evaluate;
  page.evaluate = async (fn, arg) => {
    if (typeof fn === 'function' && /location\.hash/.test(String(fn))) return origEval(fn, arg);
    return ready; // the innerText probe: true only once the screen rendered
  };
  page.$ = async () => (ready ? {} : null);
  const group = [
    { index: 0, name: 'cold', path: '/dev', url: 'http://s/dev' },
    { index: 1, name: 'late', path: '/dev', url: 'http://s/dev#/late',
      expectSelector: '#table', expectText: 'Whole-season standings' },
  ];
  try {
    await runTestGroup({ newPage: async () => page }, group,
      { settleQuietMs: 50, settleMaxMs: 100, assertMaxMs: 2000, assertPollMs: 25 });
  } finally {
    clearTimeout(timer);
  }
  const { frames } = read();
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  assert.equal(byIndex.get(0).status, 'pass');
  assert.equal(byIndex.get(1).status, 'pass',
    'the cohort judged after a hash switch waits for its screen too');
});

test('a selector that never appears still fails, inside the assertion ceiling', async () => {
  const read = collect();
  const page = makeEventPage();
  page.$ = async () => null;
  const started = Date.now();
  await runTestGroup({ newPage: async () => page },
    [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#never' }],
    { settleQuietMs: 50, settleMaxMs: 100, assertMaxMs: 300, assertPollMs: 50 });
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.equal(frames[0].status, 'fail');
  assert.match(frames[0].failureReason, /Expected element "#never" was not found/,
    'the failure message keeps its historical shape');
  assert.ok(elapsed < 1500, `polling is bounded by the ceiling, took ${elapsed}ms`);
});

test('a check still waiting on the wire gets another window, floored and capped', async () => {
  // The failure this exists for: the element is not missing, its data is
  // still in flight, and eight pages are contending for one preview. A
  // fixed window judges it before the fetch lands.
  const read = collect();
  let ready = false;
  const timers = [];
  const page = makeEventPage();
  page.$ = async () => (ready ? {} : null);
  // Requests keep arriving past the fixed window; the element lands well
  // after it, and only the ROLLING window can still see it. It lands inside
  // the roll's own cap (three fixed windows, see ASSERT_ROLL_MAX_FACTOR),
  // which is the promise: data that is on the wire is caught, a poller that
  // never stops is not waited for.
  for (const at of [100, 220, 340, 460]) timers.push(setTimeout(() => page.emitRequest(), at));
  timers.push(setTimeout(() => { ready = true; page.emitRequest(); }, 500));
  const started = Date.now();
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'late data', path: '/p', url: 'http://s/p', expectSelector: '#badge' }],
      { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 200, assertPollMs: 20,
        groupDeadlineAt: Date.now() + 20000 });
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.equal(frames[0].status, 'pass',
    'the window rolled while the page was still fetching, so the badge was seen');
  assert.ok(elapsed > 200, `it outlived the fixed window (${elapsed}ms)`);
});

test('a silent missing element still fails on the fixed window, and console noise does not roll it', async () => {
  // The discrimination the rolling window has to make: no requests means
  // nothing is coming, so the old ceiling still applies. Console errors are
  // deliberately not enough — a page spewing them is broken, not loading.
  const read = collect();
  const page = makeEventPage();
  page.$ = async () => null;
  const timers = [];
  for (const at of [60, 120, 180, 240]) timers.push(setTimeout(() => page.emitError(`boom ${at}`), at));
  const started = Date.now();
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#never' }],
      { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 300, assertPollMs: 50,
        groupDeadlineAt: Date.now() + 20000 });
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  const elapsed = Date.now() - started;
  assert.equal(read().frames[0].status, 'fail');
  assert.ok(elapsed < 1500, `still bounded by the fixed window, took ${elapsed}ms`);
});

test('the rolling window never outlives the group budget, and never undercuts the fixed one', async () => {
  // #1710's two self-inflicted bugs, both pinned. A page that keeps
  // fetching forever must stop at the group's ceiling (minus the reserve
  // for writing frames) rather than manufacture a "did not finish" — and a
  // ceiling that has already passed must never hand back LESS than the
  // fixed window.
  const read = collect();
  const page = makeEventPage();
  page.$ = async () => null;
  const spam = setInterval(() => page.emitRequest(), 20);
  const started = Date.now();
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#never' }],
      { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 100, assertPollMs: 20,
        // 2400ms budget minus the 2000ms reserve → a ~400ms ceiling. The
        // roll cap is pushed out of the way so the GROUP ceiling is what
        // this half exercises; the cap has its own case below.
        assertRollMaxFactor: 100,
        groupDeadlineAt: Date.now() + 2400 });
  } finally {
    clearInterval(spam);
  }
  const capped = Date.now() - started;
  assert.equal(read().frames[0].status, 'fail');
  assert.ok(capped < 2400, `capped by the group ceiling, took ${capped}ms`);

  // Ceiling already in the past: the floor is what is left.
  const read2 = collect();
  const page2 = makeEventPage();
  page2.$ = async () => null;
  const spam2 = setInterval(() => page2.emitRequest(), 20);
  const started2 = Date.now();
  try {
    await runTestGroup({ newPage: async () => page2 },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#never' }],
      { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 300, assertPollMs: 20,
        groupDeadlineAt: Date.now() - 60000 });
  } finally {
    clearInterval(spam2);
  }
  const floored = Date.now() - started2;
  assert.equal(read2().frames[0].status, 'fail');
  assert.ok(floored >= 300, `the floor held the fixed window, took ${floored}ms`);
  assert.ok(floored < 1500, `and did not roll past it, took ${floored}ms`);
});

test('a page that never stops fetching is cut off at a few fixed windows, not at the group ceiling', async () => {
  // A screen that polls — a live feed, a status ticker — makes a request
  // inside every window, so an element that had not rendered on it used to
  // roll all the way to the group ceiling: 111s of one lane in a logged run,
  // ending in "did not finish" because the roll ate the budget the cold-load
  // fallback needed. The roll is now capped at ASSERT_ROLL_MAX_FACTOR fixed
  // windows; with a 100ms window and a 20s group budget that is ~300ms
  // here, not ~18s.
  const read = collect();
  const page = makeEventPage();
  page.$ = async () => null;
  const spam = setInterval(() => page.emitRequest(), 20);
  const started = Date.now();
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'ticker', path: '/p', url: 'http://s/p', expectSelector: '#never' }],
      { settleQuietMs: 20, settleMaxMs: 40, assertMaxMs: 100, assertPollMs: 20,
        groupDeadlineAt: Date.now() + 20000 });
  } finally {
    clearInterval(spam);
  }
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.equal(frames[0].status, 'fail');
  assert.match(frames[0].failureReason, /Expected element "#never" was not found/);
  assert.ok(elapsed >= 290, `it still rolled past the fixed window (${elapsed}ms)`);
  assert.ok(elapsed < 1500, `but was cut off at the roll cap, not the 18s ceiling (${elapsed}ms)`);
});

test('runTests hands each group its own ceiling', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'capture/capture.js'), 'utf8');
  assert.match(src, /const groupOpts = \{ \.\.\.settleOpts, groupDeadlineAt: now\(\) \+ groupBudgetMs \};/);
  assert.match(src, /runTestGroup\(browser, group, groupOpts\)/);
  assert.match(src, /const ASSERT_REPORT_RESERVE_MS = 2000;/);
  // Only request traffic rolls it.
  assert.match(src, /on\(ev, \(\) => \{ activity\.bump\(\); netActivity\.bump\(\); \}\);/);
  // And it rolls into at most three fixed windows, whatever the group's own
  // ceiling allows — the floor stays outermost.
  assert.match(src, /const ASSERT_ROLL_MAX_FACTOR = 3;/);
  assert.match(src, /Math\.min\(Date\.now\(\) \+ assertMax, groupCeilingAt, rollCeilingAt\)/);
});

test('the media pass and the suite share the browser side by side', () => {
  // main() is Chromium-bound, so its shape is pinned at the source: the
  // screenshot loop is started, NOT awaited, before the suite is dispatched,
  // and both are settled before the browser closes. Awaiting the loop first
  // would put the media pass's 6-14s back in front of every check; closing
  // on the first rejection would tear the suite down mid-flight and read
  // as a crashed container.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'capture/capture.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const shotsAt = main.indexOf('const shots = (async () => {');
  const suiteAt = main.indexOf('const suite = tests.length');
  const settleAt = main.indexOf('await Promise.allSettled([shots, suite])');
  const closeAt = main.indexOf('await browser.close()');
  assert.ok(shotsAt > 0 && suiteAt > shotsAt && settleAt > suiteAt && closeAt > settleAt,
    'shots started, suite started, both settled, then the browser closes');
  assert.ok(!/await shots\b/.test(main.slice(shotsAt, suiteAt)),
    'the shots are not awaited before the suite starts');
  assert.match(main, /if \(failed\) throw failed\.reason;/,
    'a media-pass failure is still surfaced, after both have settled');
});

test('the assertion deadline is shared by a cohort, not paid per failing check', async () => {
  // Ten missing selectors on one screen must not cost ten deadlines — the
  // group budget only grows per cohort, so the poll budget has to as well.
  const read = collect();
  const page = makeEventPage();
  page.$ = async () => null;
  const group = Array.from({ length: 10 }, (_, i) => ({
    index: i, name: `m${i}`, path: '/p', url: 'http://s/p', expectSelector: `#m${i}`,
  }));
  const started = Date.now();
  await runTestGroup({ newPage: async () => page }, group,
    { settleQuietMs: 50, settleMaxMs: 100, assertMaxMs: 300, assertPollMs: 50 });
  const elapsed = Date.now() - started;
  const { frames } = read();
  assert.equal(frames.length, 10);
  assert.ok(frames.every((f) => f.status === 'fail'));
  assert.ok(elapsed < 1500,
    `ten failing checks share one 300ms deadline, took ${elapsed}ms`);
});

test('a console error that fires while assertions poll still counts', async () => {
  // The flat 2s settle would have heard this error; the shorter settle must
  // not let it slip past just because it fired during the poll window.
  const read = collect();
  let timer = null;
  const page = makeEventPage({
    onGoto: (p) => { timer = setTimeout(() => p.emitError('late boom'), 250); },
  });
  page.$ = async () => null;
  try {
    await runTestGroup({ newPage: async () => page },
      [{ index: 0, name: 'a', path: '/p', url: 'http://s/p', expectSelector: '#x' }],
      { settleQuietMs: 50, settleMaxMs: 100, assertMaxMs: 600, assertPollMs: 50 });
  } finally {
    clearTimeout(timer);
  }
  const { frames } = read();
  assert.deepEqual(frames[0].consoleErrors.map((e) => e.message), ['late boom'],
    'the error that fired during polling is attributed to the cohort');
});

test('the assertion ceiling comes from env with a sane default', () => {
  assert.equal(assertMaxMs({}), 5000, 'the default ceiling');
  assert.equal(assertMaxMs({ TEST_ASSERT_MAX_MS: '900' }), 900);
  assert.equal(assertMaxMs({ TEST_ASSERT_MAX_MS: 'lots' }), 5000, 'garbage falls back');
});

test('pool bounds come from env with sane defaults and a hard ceiling', () => {
  // 8 → 16 when compositing moved off the SwiftShader GPU process and the
  // pool stopped being bound by its own container's CPU (see poolSize).
  assert.equal(poolSize({}), 16, 'the default pool');
  assert.equal(poolSize({ TEST_CONCURRENCY: '3' }), 3);
  assert.equal(poolSize({ TEST_CONCURRENCY: '0' }), 16, 'zero is not a pool');
  assert.equal(poolSize({ TEST_CONCURRENCY: 'lots' }), 16, 'garbage falls back');
  assert.equal(poolSize({ TEST_CONCURRENCY: '500' }), 24,
    'a ceiling, because each page is ~80-150 MiB of renderer and an OOM-kill '
    + 'loses the whole run rather than one check — tests/checks-budget.test.js '
    + 'pins that the container is sized for it');
  assert.equal(testTimeoutMs({}), 25000);
  assert.equal(testTimeoutMs({ TEST_TIMEOUT_MS: '900' }), 900);
  assert.equal(testTimeoutMs({ TEST_TIMEOUT_MS: '-1' }), 25000);
  // 470000 since #1417, moved with MAX_DECLARED_TESTS 430 → 480 and the
  // platform-side default in services/visuals.js; 520000 with 480 → 530;
  // 560000 with 530 → 560; 570000 with 560 → 580; 590000 with 580 → 600
  // (#1824); 620000 with 600 → 630 (#1876); 650000 with 630 → 660
  // (#1960). The three are asserted
  // equal to each other elsewhere (tests/checks-budget.test.js); this one
  // pins that the container's own fallback is the raised value, so a run
  // without the env var does not quietly apply the old shorter budget.
  assert.equal(testsDeadlineMs({}), 650000);
  assert.equal(testsDeadlineMs({ TESTS_DEADLINE_MS: '1000' }), 1000);
});

test('the suite deadline leaves headroom inside the container run timeout', () => {
  // The container is killed at RUN_TIMEOUT_MS. If the suite budget reached
  // that far the run would be killed mid-sentinel, and a budget-truncated
  // suite would be indistinguishable from a crash.
  const fs = require('node:fs');
  const path = require('node:path');
  const visualsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const runTimeout = Number(/const RUN_TIMEOUT_MS = (\d+) \* 1000/.exec(visualsSrc)[1]) * 1000;
  assert.ok(testsDeadlineMs({}) < runTimeout,
    'the suite budget must expire before the container is killed');
  assert.ok(runTimeout - testsDeadlineMs({}) >= 120000,
    'and with enough room left for the media pass that runs before it');
});

test('a group budgets its one navigation, so a lone check can outlast NAV_TIMEOUT_MS', () => {
  // The bug this pins: `perTestMs` is the PER-CHECK wall clock, but the group
  // budget spent it on the cold load, the settle AND the first check's
  // assertion together. Only checks PAST the first bought more time, so a
  // group of one — 146 of this repo's 236 declared routes — had to fit a
  // navigation into a budget that allowed nothing for it, while the runner's
  // own comment calls the navigation the expensive part and each extra check
  // milliseconds.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'capture/capture.js'), 'utf8');
  const formula = src.slice(src.indexOf('const groupBudgetMs = perTestMs'));
  assert.match(formula.slice(0, 240), /\+ navBudgetMs/,
    'the navigation every group performs has its own term');
  assert.match(src, /const navBudgetMs = Number\(o\.navBudgetMs\) > 0 \? Number\(o\.navBudgetMs\) : perTestMs;/,
    'defaulted to perTestMs so it scales with the knob callers already tune');

  // The property that makes a slow load REPORTABLE. NAV_TIMEOUT_MS bounds the
  // navigation; while it exceeded the group's whole budget the group race
  // always resolved first, so a page that was merely slow came back as "did
  // not finish within 25s" — which cannot tell a load that never landed from
  // an assertion that failed. A lone group's ceiling must now clear it.
  const navTimeout = Number(/const NAV_TIMEOUT_MS = (\d+);/.exec(src)[1]);
  const perTest = testTimeoutMs({});
  const loneGroupBudget = perTest + perTest; // one check, one cohort
  assert.ok(loneGroupBudget > navTimeout,
    `a single-check group gets ${loneGroupBudget}ms, which must exceed NAV_TIMEOUT_MS ${navTimeout}ms`);
});

test('#3978: a failed expectText names what was on the page', async () => {
  const read = collect();
  const browser = { newPage: async () => ({
    on() {}, async setViewport() {}, async goto() { return { status: () => 200 }; },
    async waitForNetworkIdle() {},
    async $(sel) { return sel === '#here' ? {} : null; },
    async evaluate(fn) {
      const src = String(fn);
      if (/includes\(/.test(src)) return false;
      if (/innerText/.test(src)) return '  Menu\n  Your apps\n  Board  ';
      return true;
    },
    async close() {},
  }) };
  await runTests(browser, [
    { index: 0, name: 'a', path: '/x', url: 'http://staging/x', expectText: 'welcome' },
  ], { concurrency: 1, testTimeoutMs: 20000, env: { ...process.env, TEST_RETRY_RUNS: '0' } });
  const frame = read().frames[0];
  assert.equal(frame.status, 'fail');
  assert.match(frame.failureReason, /Expected text "welcome" was not found on the page/);
  assert.match(frame.failureReason, /the page text was: "Menu Your apps Board"/,
    'the snippet is flattened and the caller can see what rendered instead');
});

test('#3978: an innerText probe that answers non-string leaves the reason alone', async () => {
  const read = collect();
  const browser = { newPage: async () => ({
    on() {}, async setViewport() {}, async goto() { return { status: () => 200 }; },
    async waitForNetworkIdle() {},
    async $(sel) { return sel === '#here' ? {} : null; },
    async evaluate(fn) {
      const src = String(fn);
      if (/includes\(/.test(src)) return false;
      if (/innerText/.test(src)) throw new Error('probe refused');
      return true;
    },
    async close() {},
  }) };
  await runTests(browser, [
    { index: 0, name: 'a', path: '/x', url: 'http://staging/x', expectText: 'welcome' },
  ], { concurrency: 1, testTimeoutMs: 20000, env: { ...process.env, TEST_RETRY_RUNS: '0' } });
  const frame = read().frames[0];
  assert.equal(frame.failureReason, 'Expected text "welcome" was not found on the page',
    'no snippet, and no "true" or error text posing as one');
});
