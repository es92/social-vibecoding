// Tests for the capture-outcome reliability slice (screenshot-reliability
// spec): persisted capture outcomes (capture_state / capture_detail on
// chat_sessions, shot_status / before_fell_back on session_visuals), the
// automatic desktop+mobile frame expansion (expandCapturePaths + the
// container's still-only targets), the over-cap webm → GIF-still-transcodes
// container behaviour surface (resolveTargets `still`), and the
// before-fell-back captions in the PR block and grouped shapes.
//
// Run with: node --test tests/capture-outcomes.test.js

// The verdict's writers: the preview machine's own (its transitions run them).
const rowStore = require('../src/workflow/preview/check-store.ts');
const test = require('node:test');
require('./lib/media-store').useMemoryMedia(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const visuals = require('../src/services/visuals');
const { resolveTargets, waitForScenarioReady } = require('../capture/capture');
const { buildVisualsBlock } = require('../src/services/pr-metadata');

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const DOMAIN = 'example.test';

// ── parseShots: fellback attribute ─────────────────────────────────────

test('parseShots reads fellback=1 into fellBack, defaulting to false', () => {
  const b64 = Buffer.from('PNG1').toString('base64');
  const withFlag = `__USERNODE_SHOT__ kind=before media=png status=200 bytes=4 index=0 fellback=1\n${b64}\n__USERNODE_SHOT_END__\n`;
  const without = `__USERNODE_SHOT__ kind=before media=png status=200 bytes=4 index=0\n${b64}\n__USERNODE_SHOT_END__\n`;
  assert.equal(visuals.parseShots(withFlag).shots[0].fellBack, true);
  assert.equal(visuals.parseShots(without).shots[0].fellBack, false);
});

// ── expandCapturePaths: both frames per path ───────────────────────────

// One target per path now, carrying the phone frame as a companion the
// container shoots from the SAME page — the indexes must stay exactly what
// the two-sibling-target shape produced (i*2 desktop, i*2+1 mobile), since
// they are what attributes each stored artifact to its rendered row.
test('expandCapturePaths emits one target per path, phone frame as a companion on the odd index', () => {
  const t = visuals.expandCapturePaths(['/', '/board']);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], {
    index: 0, path: '/', viewport: null, still: false,
    companion: { index: 1, viewport: 'mobile' },
  });
  assert.deepEqual(t[1], {
    index: 2, path: '/board', viewport: null, still: false,
    companion: { index: 3, viewport: 'mobile' },
  });
});

test('expandCapturePaths halves the page loads it asks for (one navigation per side per path)', () => {
  // The regression this guards: emitting a sibling mobile TARGET made the
  // container navigate twice per side, which is what took a two-route
  // proposal from 4 page loads to 8.
  const t = visuals.expandCapturePaths(['/', '/board', '/x']);
  assert.equal(t.length, 3);
  assert.ok(t.every((e) => e.still === false), 'no target is still-only any more');
  assert.deepEqual(t.map((e) => e.index), [0, 2, 4]);
  assert.deepEqual(t.map((e) => e.companion.index), [1, 3, 5]);
});

test('expandCapturePaths tolerates a non-array', () => {
  assert.deepEqual(visuals.expandCapturePaths(null), []);
});

// ── named visual-scenario route selection ─────────────────────────────

const SCENARIOS = [
  {
    id: 'settings.profile', visual: true,
    name: 'Profile editor', path: '/settings?demo=profile',
    expectSelector: '#profile-editor', expectText: 'Profile',
    impact: ['frontend/src/features/settings/**'],
  },
  {
    id: 'board.main', visual: true,
    name: 'Board', path: '/board?demo=1',
    expectSelector: '.board', expectText: null,
    impact: ['public/js/board-?.js', 'frontend/src/features/board/**'],
  },
];

test('deriveCapturePlan prefers submitted routes over matching scenarios', () => {
  const plan = visuals.deriveCapturePlan(
    { testing_paths: [{ path: '/exact', viewport: 'mobile' }] },
    SCENARIOS,
    ['frontend/src/features/settings/profile.tsx']
  );
  assert.deepEqual(plan, {
    paths: ['/exact'], pathDefaulted: false, routeSource: 'submitted', scenarios: [],
  });
});

test('deriveCapturePlan selects named executable flows by repository impact', () => {
  const plan = visuals.deriveCapturePlan(
    {}, SCENARIOS,
    ['docs/readme.md', 'frontend/src/features/settings/profile.tsx']
  );
  assert.equal(plan.routeSource, 'scenario');
  assert.deepEqual(plan.paths, ['/settings?demo=profile']);
  assert.equal(plan.scenarios[0].id, 'settings.profile');
  assert.equal(plan.scenarios[0].expectSelector, '#profile-editor');
  assert.match(plan.scenarios[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('deriveCapturePlan retains the labelled root default when no scenario matches', () => {
  assert.deepEqual(
    visuals.deriveCapturePlan({}, SCENARIOS, ['src/services/email.js']),
    { paths: ['/'], pathDefaulted: true, routeSource: 'default', scenarios: [] }
  );
  assert.equal(visuals.visualImpactMatches('frontend/**/profile-?.tsx', 'frontend/a/profile-x.tsx'), true);
  assert.equal(visuals.visualImpactMatches('frontend/*/profile.tsx', 'frontend/a/b/profile.tsx'), false);
});

test('the root default preserves UI screenshots without adding media to backend-only changes', () => {
  assert.equal(visuals.shouldCaptureMedia(true, 'default'), true);
  assert.equal(visuals.shouldCaptureMedia(false, 'default'), false);
  assert.equal(visuals.shouldCaptureMedia(false, 'submitted'), true);
  assert.equal(visuals.shouldCaptureMedia(false, 'scenario'), true);
  assert.equal(visuals.shouldCaptureMedia(true, 'default', {
    suppressLegacyMedia: true,
  }), false);
  assert.equal(visuals.shouldCaptureMedia(true, 'submitted', {
    suppressLegacyMedia: true,
  }), false);
});

test('the evidence kill switch stops v2 without reviving legacy review media', async () => {
  const pool = { query: async () => { throw new Error('kill switch must not query enrollment'); } };
  assert.equal(await visuals.suppressLegacyMediaForSession(pool, {
    shots: { enabled: false, collect: false },
  }, {}), true);
  assert.equal(visuals.shouldCaptureMedia(true, 'default', {
    suppressLegacyMedia: true,
  }), false);
});

test('UI-affecting captures report a change that owes a declaration, before choosing legacy media', () => {
  // The checks run reports it; the preview machine tells the shots machine
  // (UiUndeclared), whose slot says a declaration is needed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  assert.match(src, /config\.shots\?\.collect && uiAffecting && opts\.workflow\?\.report\)[\s\S]*report\.uiAffecting = true/);
  assert.doesNotMatch(src, /requireIntentForUiChange/);
});

// ── capture.js resolveTargets: the still-only flag ─────────────────────

test('resolveTargets carries still through, defaulting to false', () => {
  const env = {
    TARGETS: JSON.stringify([
      { index: 0, afterUrl: 'http://a/' },
      { index: 1, afterUrl: 'http://a/m', still: true, viewport: { width: 390, height: 844 } },
    ]),
  };
  const t = resolveTargets(env);
  assert.equal(t[0].still, false);
  assert.equal(t[1].still, true);
  assert.deepEqual(t[1].viewport, { width: 390, height: 844 });
});

test('the legacy scalar-env fallback is never still-only', () => {
  const t = resolveTargets({ AFTER_URL: 'http://a/' });
  assert.equal(t[0].still, false);
  assert.equal(t[0].companion, null);
});

// ── capture.js resolveTargets / parseCompanion: the companion frame ─────

test('resolveTargets parses a companion frame with its own capture index', () => {
  const env = {
    TARGETS: JSON.stringify([
      { index: 0, afterUrl: 'http://a/', companion: { index: 1, viewport: { width: 390, height: 844 } } },
    ]),
  };
  const t = resolveTargets(env);
  assert.deepEqual(t[0].companion, { index: 1, viewport: { width: 390, height: 844 } });
  // The target itself stays the full-media desktop frame.
  assert.equal(t[0].still, false);
  assert.equal(t[0].viewport, null);
});

test('resolveTargets carries a bounded visual-scenario readiness assertion', () => {
  const [target] = resolveTargets({
    TARGETS: JSON.stringify([{
      index: 0,
      afterUrl: 'http://a/settings',
      ready: { expectSelector: '  #profile-editor ', expectText: ' Profile ' },
    }]),
  });
  assert.deepEqual(target.ready, { expectSelector: '#profile-editor', expectText: 'Profile' });
});

test('a missing readiness assertion fails closed instead of taking an early screenshot', async () => {
  await assert.rejects(
    waitForScenarioReady({ $: async () => null }, { expectSelector: '#not-ready' }, { maxMs: 0 }),
    /Visual scenario was not ready: Expected element "#not-ready" was not found/
  );
  await waitForScenarioReady({ $: async () => ({}) }, { expectSelector: '#ready' }, { maxMs: 0 });
});

test('a malformed companion degrades to none rather than costing the target its shots', () => {
  const cases = [
    undefined,
    null,
    'mobile',
    { index: 1 },                                        // no viewport
    { viewport: { width: 390, height: 844 } },           // no index
    { index: -1, viewport: { width: 390, height: 844 } }, // negative index
    { index: 1, viewport: { width: 0, height: 844 } },    // out-of-bounds frame
    { index: 1, viewport: { width: 'x', height: 'y' } },  // non-numeric frame
  ];
  for (const companion of cases) {
    const t = resolveTargets({ TARGETS: JSON.stringify([{ index: 0, afterUrl: 'http://a/', companion }]) });
    assert.equal(t.length, 1, `target survives companion ${JSON.stringify(companion)}`);
    assert.equal(t[0].companion, null, `companion rejected: ${JSON.stringify(companion)}`);
    assert.equal(t[0].afterUrl, 'http://a/');
  }
});

test('an old orchestrator\'s sibling still-only target still resolves (rolling deploy)', () => {
  // The previous TARGETS shape: two entries per path, the odd one
  // `still: true`. A capture image carrying the companion support must keep
  // honouring it, because a rolling deploy pairs a new image with the old
  // orchestrator for one release.
  const env = {
    TARGETS: JSON.stringify([
      { index: 0, afterUrl: 'http://a/' },
      { index: 1, afterUrl: 'http://a/', still: true, viewport: { width: 390, height: 844 } },
    ]),
  };
  const t = resolveTargets(env);
  assert.equal(t.length, 2);
  assert.equal(t[1].still, true);
  assert.equal(t[1].companion, null);
  assert.deepEqual(t[1].viewport, { width: 390, height: 844 });
});

// ── storeArtifacts: shot_status, before_fell_back, over-cap collector ──

function fakePool() {
  const inserted = [];
  const client = {
    query: async (sql, params) => {
      if (/^INSERT INTO session_visuals/.test(sql)) inserted.push(params);
      return { rows: [] };
    },
    release: () => {},
  };
  return { inserted, connect: async () => client };
}

test('storeArtifacts persists shot_status and before_fell_back per row', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const targets = [{ index: 0, path: '/board' }];
  const shots = [
    { kind: 'before', media: 'png', status: 200, index: 0, fellBack: true, buf },
    { kind: 'after', media: 'png', status: 404, index: 0, buf },
  ];
  const stored = await visuals.storeArtifacts(pool, 7, 'abc', targets, shots);
  // $10 = shot_status, $11 = before_fell_back (0-indexed 9 / 10).
  assert.equal(pool.inserted[0][9], 200);
  assert.equal(pool.inserted[0][10], true);
  assert.equal(pool.inserted[1][9], 404);
  assert.equal(pool.inserted[1][10], false); // fellBack only sticks to "before" rows
  // The grouped shape carries the flag so renderers can caption the pair.
  assert.equal(stored.captures[0].beforeFellBack, true);
});

test('storeArtifacts leaves beforeFellBack absent when no before fell back', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const stored = await visuals.storeArtifacts(
    pool, 7, null, [{ index: 0, path: '/' }],
    [
      { kind: 'before', media: 'png', status: 200, index: 0, fellBack: false, buf },
      { kind: 'after', media: 'png', status: 200, index: 0, buf },
    ]
  );
  assert.ok(!('beforeFellBack' in stored.captures[0]));
});

test('storeArtifacts collects over-cap drops into the dropped array', async () => {
  const pool = fakePool();
  const big = Buffer.alloc(9 * 1024 * 1024); // over the 8MB webm cap
  const small = Buffer.from('x');
  const dropped = [];
  const stored = await visuals.storeArtifacts(
    pool, 7, null, [{ index: 0, path: '/' }],
    [
      { kind: 'after', media: 'png', status: 200, index: 0, buf: small },
      { kind: 'after', media: 'webm', status: 200, index: 0, buf: big },
    ],
    dropped
  );
  assert.ok(stored);
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0], { kind: 'after', media: 'webm', index: 0, bytes: big.length });
  assert.equal(pool.inserted.length, 1); // only the png was stored
});

test('storeArtifacts stores a null shot_status when the frame carried none', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  await visuals.storeArtifacts(
    pool, 7, null, [{ index: 0, path: '/' }],
    [{ kind: 'after', media: 'png', status: 0, index: 0, buf }]
  );
  assert.equal(pool.inserted[0][9], null);
});

test('storeArtifacts attributes a companion still to its parent route, mobile frame, and scenario', async () => {
  const pool = fakePool();
  const buf = Buffer.from('x');
  const scenario = { id: 'board.main', fingerprint: 'f'.repeat(64) };
  const stored = await visuals.storeArtifacts(
    pool, 7, 'a'.repeat(40),
    [{ index: 0, path: '/board?demo=1', scenario, companion: { index: 1 } }],
    [{ kind: 'after', media: 'png', status: 200, index: 1, buf }]
  );
  const params = pool.inserted[0];
  assert.equal(params[6], '/board?demo=1');
  assert.equal(params[7], 1);
  assert.equal(params[8], 'mobile');
  assert.equal(params[11], 'board.main');
  assert.equal(params[12], 'f'.repeat(64));
  assert.equal(stored.captures[0].path, '/board?demo=1');
  assert.equal(stored.captures[0].viewport, 'mobile');
  assert.equal(stored.captures[0].scenarioId, 'board.main');
});

test('every live session-event reader accepts the null payload that clears stale tiles', () => {
  const fs = require('node:fs');
  for (const file of ['../public/js/app.js', '../frontend/src/features/dev-chat/dev-chat.js']) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.match(source, /hasOwnProperty\.call\(data, 'visuals'\)/, file);
    assert.match(source, /currentSession\.visuals = data\.visuals \|\| null/, file);
    assert.doesNotMatch(source, /currentSession && data\.visuals/, file);
  }
});

// ── shapeAgg: object values (id + path + viewport + fellBack) ──────────

test('shapeAgg reads the object value form into labelled groups', () => {
  const shaped = visuals.shapeAgg({
    before_0_png: { id: ID_A, path: '/board', viewport: null, fellBack: true },
    after_0_png: { id: ID_B, path: '/board', viewport: null, fellBack: false },
  });
  assert.equal(shaped.captures.length, 1);
  assert.equal(shaped.captures[0].path, '/board');
  assert.equal(shaped.captures[0].beforeFellBack, true);
  assert.deepEqual(shaped.captures[0].before, { png: ID_A });
});

test('shapeAgg still accepts bare-id string values (legacy query)', () => {
  const shaped = visuals.shapeAgg({ before_0_png: ID_A, after_0_png: ID_B });
  assert.equal(shaped.captures[0].path, '/');
  assert.ok(!('beforeFellBack' in shaped.captures[0]));
});

test('shapeAgg ignores object values without a usable id', () => {
  assert.equal(visuals.shapeAgg({ after_0_png: { path: '/x' } }), null);
});

test('shapeAgg carries the mobile viewport label through the object form', () => {
  const shaped = visuals.shapeAgg({
    after_1_png: { id: ID_B, path: '/board', viewport: 'mobile', fellBack: false },
  });
  assert.equal(shaped.captures[0].viewport, 'mobile');
});

test('shapeAgg hides a commit-tagged artifact set from a newer proposal head', () => {
  const old = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const agg = {
    after_0_png: { id: ID_B, path: '/board', commit: old },
  };
  assert.equal(visuals.shapeAgg(agg, current), null);
  assert.equal(visuals.shapeAgg(agg, old).captures[0].path, '/board');
});

test('an exact-head read hides legacy captures whose revision cannot be proven', () => {
  const rows = [
    { kind: 'after', media: 'png', id: ID_B, capture_index: 0, commit_hash: null },
  ];
  assert.equal(visuals.groupRows(rows, 'b'.repeat(40)), null);
  assert.equal(visuals.groupRows(rows).captures[0].after.png, ID_B,
    'a legacy surface with no head still renders its legacy row');
});

// ── buildVisualsBlock: before-fell-back caption ────────────────────────

test('buildVisualsBlock captions a fell-back before pair', () => {
  const block = buildVisualsBlock({
    captures: [{
      index: 0, path: '/board', beforeFellBack: true,
      before: { png: ID_A }, after: { png: ID_B },
    }],
  }, DOMAIN);
  assert.ok(block.includes('| Before | After |'));
  assert.ok(block.includes('"Before" shows the production home page'));
});

test('buildVisualsBlock stays byte-identical without the flag', () => {
  const plain = buildVisualsBlock({
    captures: [{ index: 0, path: '/board', before: { png: ID_A }, after: { png: ID_B } }],
  }, DOMAIN);
  assert.ok(!plain.includes('shows the production home page'));
});

// ── storeCaptureOutcome ────────────────────────────────────────────────

test('storeCaptureOutcome writes state + detail + timestamp', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await rowStore.storeCaptureOutcome(pool, 42, 'partial', { pathDefaulted: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /capture_state = \$1/);
  assert.match(calls[0].sql, /captured_at = NOW\(\)/);
  assert.equal(calls[0].params[0], 'partial');
  assert.deepEqual(JSON.parse(calls[0].params[1]), { pathDefaulted: true });
  assert.equal(calls[0].params[2], 42);
});

// ── groupRows: before-only session must not produce a phantom card ──────

test('groupRows drops a group that has only a before side', () => {
  // The gallery lists proposals by their grouped captures; a session whose
  // rows are all "before" (prod shot fine, staging shot failed) has nothing
  // to show and must not render an empty card.
  assert.equal(visuals.groupRows([
    { kind: 'before', media: 'png', id: ID_A, index: 0, captured_path: '/board' },
    { kind: 'before', media: 'webm', id: ID_B, index: 0, captured_path: '/board' },
  ]), null);
});

test('groupRows keeps the groups that DO have an after alongside before-only ones', () => {
  const grouped = visuals.groupRows([
    { kind: 'before', media: 'png', id: ID_A, index: 0, captured_path: '/a' },
    { kind: 'before', media: 'png', id: ID_B, index: 1, captured_path: '/b' },
    { kind: 'after', media: 'png', id: ID_A, index: 1, captured_path: '/b' },
  ]);
  assert.equal(grouped.captures.length, 1);
  assert.equal(grouped.captures[0].index, 1);
  assert.equal(grouped.captures[0].path, '/b');
});

test('groupRows reads the DB column name before_fell_back as well as fellBack', () => {
  // The gallery endpoint aggregates raw column names; storeArtifacts passes
  // the camelCase form. Both must land on the same output flag.
  const fromDb = visuals.groupRows([
    { kind: 'before', media: 'png', id: ID_A, index: 0, before_fell_back: true },
    { kind: 'after', media: 'png', id: ID_B, index: 0 },
  ]);
  assert.equal(fromDb.captures[0].beforeFellBack, true);
});
