'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const replay = require('../evidence/replay-runner');
const { plan } = require('./fixtures/visual-evidence');

function input(overrides = {}) {
  return {
    runId: 'a'.repeat(32),
    pass: 2,
    publishArtifacts: true,
    origins: { base: 'http://base-evidence:3000', head: 'http://head-evidence:3000' },
    provenance: {
      baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40),
      fixtureFingerprint: 'fixture-123', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head',
    },
    authTokens: { member: 'member.jwt', read_only_admin: 'admin.jwt' },
    plan: plan(),
    ...overrides,
  };
}

test('runner accepts a validated pair and only publishes artifacts on pass two', () => {
  const parsed = replay.validateInput(input());
  assert.equal(parsed.pass, 2);
  assert.equal(parsed.publishArtifacts, true);
  assert.match(parsed.planHash, /^[0-9a-f]{64}$/);
  const first = replay.validateInput(input({ pass: 1 }));
  assert.equal(first.publishArtifacts, false);
});

test('runner refuses identical, credential-bearing, or non-origin targets', () => {
  assert.throws(() => replay.validateInput(input({ runId: 'not-a-run' })), { code: 'invalid_run_id' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://same:3000', head: 'http://same:3000' } })), { code: 'identical_origins' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://user:pass@base:3000', head: 'http://head:3000' } })), { code: 'invalid_origin' });
  assert.throws(() => replay.validateInput(input({ origins: { base: 'http://base:3000/path', head: 'http://head:3000' } })), { code: 'invalid_origin' });
  assert.throws(() => replay.validateInput(input({ provenance: { ...input().provenance, baseSha: 'moving-main' } })), { code: 'invalid_provenance' });
  assert.throws(() => replay.validateInput(input({ authTokens: { member: 'member.jwt' } })), { code: 'invalid_auth_tokens' });
});

test('runner refuses undeclared home, auth, error, and cross-origin fallbacks', () => {
  const origin = 'http://base-evidence:3000';
  assert.equal(replay.expectedFinalPath('/settings', `${origin}/settings?tab=profile`, origin), '/settings?tab=profile');
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.equal(replay.expectedFinalPath('/settings', `${origin}/`, origin, 'base', { allowDeclaredHome: true }), '/');
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/login`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.throws(() => replay.expectedFinalPath('/settings', `${origin}/error?code=500`, origin, 'base'), { code: 'unexpected_fallback' });
  assert.throws(() => replay.expectedFinalPath('/settings', 'http://outside:3000/settings', origin, 'base'), { code: 'cross_origin_navigation' });
});

test('element resolution waits for a late accessible target before counting matches', async () => {
  let ready = false;
  const calls = [];
  const visibleLocator = {
    first: () => ({
      waitFor: async (options) => {
        calls.push(['wait', options.state, options.timeout]);
        ready = true;
      },
    }),
    count: async () => {
      calls.push(['visible-count']);
      return ready ? 1 : 0;
    },
    nth: () => ({ isVisible: async () => ready }),
  };
  const includingHiddenLocator = {
    count: async () => 1,
    nth: () => ({ isVisible: async () => ready }),
  };
  const page = {
    getByRole: (_role, options) => options.includeHidden
      ? includingHiddenLocator
      : visibleLocator,
  };

  const resolved = await replay.resolveOne(page, {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  }, 'wait-browse-button', { state: 'visible', timeoutMs: 5000 });

  assert.equal(resolved, visibleLocator);
  assert.deepEqual(calls[0], ['wait', 'visible', 5000]);
  assert.equal(calls.some(([name]) => name === 'visible-count'), true);
});

test('element resolution distinguishes a hidden role target from a missing target', async () => {
  const visibleLocator = {
    first: () => ({ waitFor: async () => { throw new Error('timeout'); } }),
    count: async () => 0,
    nth: () => ({ isVisible: async () => false }),
  };
  const includingHiddenLocator = {
    count: async () => 1,
    nth: () => ({ isVisible: async () => false }),
  };
  const page = {
    getByRole: (_role, options) => options.includeHidden
      ? includingHiddenLocator
      : visibleLocator,
  };

  await assert.rejects(replay.resolveOne(page, {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  }, 'wait-browse-button', { state: 'visible', timeoutMs: 5000 }), (error) => {
    assert.equal(error.code, 'locator_not_visible');
    assert.deepEqual(error.detail, {
      kind: 'role', role: 'button', matchedCount: 0, attachedCount: 1,
      visibleCount: 0, roleHints: { candidateCount: 1, candidates: [] },
      waitState: 'visible', timeoutMs: 5000,
    });
    return true;
  });
});

test('a stale accessible name reports nearby controls without leaking values', async () => {
  const missing = {
    first: () => ({ waitFor: async () => { throw new Error('timeout'); } }),
    count: async () => 0,
    nth: () => ({ isVisible: async () => false }),
  };
  const controls = [
    '- button "Browse all apps"',
    '- button "Contact alice@example.com token=secret.jwt"',
  ];
  const candidates = {
    count: async () => controls.length,
    nth: (index) => ({
      ariaSnapshot: async () => controls[index],
      isVisible: async () => index === 0,
    }),
  };
  const page = { getByRole: (_role, options) => options.name ? missing : candidates };
  await assert.rejects(replay.resolveOne(page, {
    by: 'role', role: 'button', name: 'Browse', exact: true,
  }, 'open-browse', { state: 'visible', timeoutMs: 25 }), (error) => {
    assert.equal(error.code, 'locator_not_found');
    assert.deepEqual(error.detail.roleHints.candidates[0], { name: controls[0], visible: true });
    assert.doesNotMatch(JSON.stringify(error.detail), /alice@example\.com|secret\.jwt/);
    return true;
  });
});

test('failure diagnostics describe browser state without exposing tokens or cookie values', async () => {
  const page = {
    url: () => 'http://base-evidence:3000/?token=secret.jwt&shot=test#waiting',
    evaluate: async () => ({
      readyState: 'complete', bodyChildCount: 4,
      visibleLandmarkIds: ['auth-waitlist-screen'],
      visibleMainCount: 1, visibleDialogCount: 0,
      visibleButtonCount: 2, visibleLinkCount: 3,
    }),
  };
  const context = {
    cookies: async () => [{ name: 'session', value: 'never-emit-this' }],
  };
  const state = await replay.failurePageState(
    page, context, 'http://base-evidence:3000', { status: 200 }
  );
  assert.equal(state.navigationStatus, 200);
  assert.equal(state.sessionCookiePresent, true);
  assert.deepEqual(state.queryKeys, ['shot']);
  assert.deepEqual(state.visibleLandmarkIds, ['auth-waitlist-screen']);
  assert.doesNotMatch(JSON.stringify(state), /secret\.jwt|never-emit-this/);
});

test('browser contexts forward the app-scoped token and failures never expose it', async () => {
  let contexts = 0;
  const options = [];
  const browser = { newContext: async (value) => {
    options.push(value);
    contexts += 1;
    if (contexts === 1) return { newPage: async () => ({}), close: async () => {} };
    throw new Error('newContext failed at http://base-evidence:3000/?token=secret.jwt');
  } };
  await assert.rejects(replay.runReplay(browser, replay.validateInput(input())), (error) => {
    assert.equal(error.code, 'replay_failed');
    assert.equal(error.detail.storyId, 'invite-suggestions');
    assert.equal(error.detail.viewport, 'desktop');
    assert.equal(error.detail.phase, 'create_context');
    assert.equal(error.detail.side, 'base');
    assert.doesNotMatch(error.message, /secret\.jwt/);
    return true;
  });
  assert.deepEqual(options[1].extraHTTPHeaders, { 'x-usernode-token': 'member.jwt' });
});

test('internal HTTP replay bootstraps the clone-local platform session cookie', async () => {
  const calls = [];
  let cookies = [];
  const response = {
    status: () => 200,
    headersArray: () => [
      { name: 'set-cookie', value: 'other=ignored; Path=/' },
      { name: 'Set-Cookie', value: 'session=clone-session-token; Path=/; HttpOnly; Secure; SameSite=Lax' },
    ],
    dispose: async () => { calls.push(['dispose']); },
  };
  const context = {
    cookies: async (origin) => {
      calls.push(['cookies', origin]);
      return cookies;
    },
    request: {
      get: async (url, options) => {
        calls.push(['get', url, options]);
        return response;
      },
    },
    addCookies: async (values) => {
      calls.push(['addCookies', values]);
      cookies = values;
    },
  };

  const diagnostic = {};
  assert.equal(await replay.bootstrapInternalSession(
    context, 'http://base-evidence:3000', '/?fixture=1#apps', 'member.jwt', diagnostic
  ), true);
  assert.deepEqual(diagnostic, {
    attempted: true, responseStatus: 200, sessionCookieInstalled: true,
  });
  const get = calls.find(([name]) => name === 'get');
  assert.equal(new URL(get[1]).searchParams.get('token'), 'member.jwt');
  assert.deepEqual(get[2].headers, { 'x-usernode-token': 'member.jwt' });
  assert.equal(get[2].maxRedirects, 0);
  assert.deepEqual(cookies, [{
    name: 'session', value: 'clone-session-token', url: 'http://base-evidence:3000',
    httpOnly: true, secure: false, sameSite: 'Lax',
  }]);
  assert.equal(calls.some(([name]) => name === 'dispose'), true);
});

test('session bootstrap accepts only a bounded session cookie value', () => {
  assert.equal(replay.sessionCookieValue([
    { name: 'set-cookie', value: 'theme=light; Path=/' },
    { name: 'set-cookie', value: 'session=abc.def_123==; Secure; HttpOnly' },
  ]), 'abc.def_123==');
  assert.equal(replay.sessionCookieValue([
    { name: 'set-cookie', value: 'theme=light; Path=/' },
  ]), null);
  assert.throws(() => replay.sessionCookieValue([
    { name: 'set-cookie', value: 'session=bad,value; Secure' },
  ]), { code: 'invalid_session_cookie' });
});

test('a failed browser action identifies its plan action and stage', async () => {
  const replayPlan = plan();
  replayPlan.stories[0].intent.animation = 'none';
  replayPlan.stories[0].replay.checkpoint.animation = 'none';
  let contexts = 0;
  const handlers = {};
  const page = {
    on: (name, callback) => { handlers[name] = callback; }, off: () => {},
    goto: async () => {
      handlers.response?.({
        status: () => 404,
        url: () => 'http://base-evidence:3000/favicon.ico',
      });
      handlers.response?.({
        status: () => 401,
        url: () => 'http://base-evidence:3000/api/members?token=member.jwt',
      });
      return { status: () => 200 };
    },
    evaluate: async () => ({
      readyState: 'complete', bodyChildCount: 5,
      visibleLandmarkIds: ['members-screen'], visibleIds: ['members-screen', 'browse-all-apps'],
      visibleControlIds: ['browse-all-apps'],
      visibleTestIds: ['members-trigger'],
    }),
    waitForTimeout: async () => {}, screenshot: async () => Buffer.from('png'),
    url: () => 'http://base-evidence:3000/?token=member.jwt',
    getByRole: () => ({
      first: () => ({ waitFor: async () => { throw new Error('timeout'); } }),
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
  };
  const browser = { newContext: async () => {
    contexts += 1;
    if (contexts === 1) return { newPage: async () => ({}), close: async () => {} };
    return {
      route: async () => {}, addInitScript: async () => {},
      cookies: async () => [{ name: 'session' }],
      newPage: async () => page, close: async () => {},
    };
  } };
  await assert.rejects(replay.runReplay(browser, replay.validateInput(input({ plan: replayPlan }))), (error) => {
    assert.equal(error.code, 'locator_not_found');
    assert.deepEqual(Object.fromEntries(['storyId', 'viewport', 'side', 'phase', 'actionId', 'actionStage', 'actionType']
      .map((key) => [key, error.detail[key]])), {
      storyId: 'invite-suggestions', viewport: 'desktop', side: 'base',
      phase: 'action', actionId: 'open-members', actionStage: 'members', actionType: 'click',
    });
    assert.equal(error.detail.pageState.sameOrigin, true);
    assert.equal(error.detail.pageState.queryKeys.includes('token'), false);
    assert.deepEqual(error.detail.pageState.visibleIds, ['members-screen', 'browse-all-apps']);
    assert.deepEqual(error.detail.pageState.visibleControlIds, ['browse-all-apps']);
    assert.deepEqual(error.detail.pageState.visibleTestIds, ['members-trigger']);
    assert.equal(error.detail.browserDiagnostics.firstHttpError.status, 404);
    assert.deepEqual(error.detail.browserDiagnostics.httpErrors.map((item) => item.status), [404, 401]);
    assert.deepEqual(error.detail.browserDiagnostics.httpErrors[1].location.queryKeys, []);
    assert.doesNotMatch(JSON.stringify(error.detail.browserDiagnostics), /member\.jwt/);
    assert.deepEqual(error.detail.targetStates[0], {
      kind: 'role', role: 'button', matchedCount: 0, attachedCount: 0, visibleCount: 0,
      roleHints: { candidateCount: 0, candidates: [] },
    });
    return true;
  });
});

test('focus crops use the same dimensions and remain within the viewport', () => {
  const viewport = { width: 1280, height: 800 };
  const pair = replay.normalizeCropPair(
    { x: 10, y: 20, width: 300, height: 200 },
    { x: 900, y: 650, width: 360, height: 130 },
    viewport,
  );
  assert.equal(pair.base.width, pair.head.width);
  assert.equal(pair.base.height, pair.head.height);
  for (const crop of Object.values(pair)) {
    assert.ok(crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= viewport.width);
    assert.ok(crop.y + crop.height <= viewport.height);
  }
});

test('perceptual hash distance is a bounded bit count', () => {
  assert.equal(replay.hammingHex('0000000000000000', '0000000000000000'), 0);
  assert.equal(replay.hammingHex('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(replay.hammingHex('0000000000000000', '0000000000000003'), 2);
});

test('capture image contains the separate evidence runtime and its pinned dependencies', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'capture/Dockerfile'), 'utf8');
  assert.match(dockerfile, /playwright-core@1\.55\.1/);
  assert.match(dockerfile, /pngjs@7\.0\.0/);
  assert.match(dockerfile, /COPY evidence\/replay-runner\.js \/app\/evidence-replay\.js/);
  assert.match(dockerfile, /COPY src\/services\/visual-evidence-plan\.js \/app\/visual-evidence-plan\.js/);
  const visuals = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  assert.match(visuals, /capture\/Dockerfile/);
});

test('image transforms share one explicitly-owned scratch context', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'evidence/replay-runner.js'), 'utf8');
  assert.doesNotMatch(runner, /browser\.newPage\(/);
  assert.match(runner, /const scratchContext = await browser\.newContext/);
  assert.match(runner, /finally \{\s*await scratchContext\.close\(\);\s*\}/);
});
