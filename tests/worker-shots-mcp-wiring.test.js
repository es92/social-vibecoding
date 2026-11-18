'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDir = path.join(__dirname, '..', 'worker');
const read = (name) => fs.readFileSync(path.join(workerDir, name), 'utf8');
const { browserAllowedOrigins, hostedAppSlugs, trustedHostedAppOrigins } = require('../worker/shots-hosted-origins');
const boundary = require('../worker/shots-boundary');
const hostedContract = require('../worker/shots-hosted-app-contract');

test('only the platform-owned hosted app for this exact run enters the shots catalog', () => {
  const runId = 'b'.repeat(32);
  const slug = hostedContract.hostedAppSlug(runId);
  const fixture = {
    id: hostedContract.HOSTED_APP_ID,
    slug,
    status: 'running',
    view_visibility: 'public',
    self_hosted: false,
    url: `https://${slug}.apps.example.invalid`,
    manifest_snapshot: hostedContract.hostedAppManifest(runId),
  };
  assert.deepEqual([...trustedHostedAppOrigins([fixture], 'https://platform.example.invalid', runId)],
    [[fixture.url, slug]]);
  assert.equal(trustedHostedAppOrigins([fixture], 'https://platform.example.invalid', 'c'.repeat(32)).size, 0);
  assert.equal(trustedHostedAppOrigins([{ ...fixture, id: 42 }], 'https://platform.example.invalid', runId).size, 0);
});

test('a public app with a repository on either host and a deployed revision is a versioned runtime', () => {
  const app = (repoUrl, sha = 'a'.repeat(40)) => ({
    slug: 'notes', status: 'running', view_visibility: 'public', self_hosted: false,
    url: 'https://notes.apps.example.invalid', repo_url: repoUrl, main_sha: sha,
  });
  const origins = (a) => [...trustedHostedAppOrigins([a], 'https://platform.example.invalid')];
  const admitted = [['https://notes.apps.example.invalid', 'notes']];
  assert.deepEqual(origins(app('https://github.com/usernode-bot/notes')), admitted);
  assert.deepEqual(origins(app('https://git.example.invalid/apps/notes')), admitted);
  assert.deepEqual(origins(app('https://git.example.invalid/apps/notes', null)), [], 'no deployed revision');
  assert.deepEqual(origins(app('https://git.example.invalid/apps')), [], 'not a repository address');
  assert.deepEqual(origins(app(null)), [], 'no repository');
});

test('planner origin list rejects stale or malformed hosted-app catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-origins-test-'));
  const file = path.join(dir, 'hosted.json');
  const base = 'http://base.example.invalid';
  const head = 'http://head.example.invalid';
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'https://app.example.invalid', slug: 'real-app' }],
    }));
    assert.deepEqual(browserAllowedOrigins(base, head, file), [base, head, 'https://app.example.invalid']);
    assert.deepEqual(hostedAppSlugs(file, base, head), ['real-app']);
    assert.throws(() => browserAllowedOrigins(base, head, ''), /path is missing/);
    assert.throws(() => browserAllowedOrigins(head, base, file), /does not match/);
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'http://127.0.0.1:3000/path', slug: 'real-app' }],
    }));
    assert.throws(() => browserAllowedOrigins(base, head, file), /origin is invalid/);
    fs.writeFileSync(file, JSON.stringify({
      version: 2, baseOrigin: base, headOrigin: head,
      apps: [{ origin: 'https://app.example.invalid', slug: 'real-app' },
        { origin: 'https://other.example.invalid', slug: 'real-app' }],
    }));
    assert.throws(() => hostedAppSlugs(file, base, head), /catalog entry is invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SHOTS_TOOLS = ['get_brief', 'save_shot', 'save_clip', 'skip_change', 'note_change', 'note_problem', 'fail_request',
  'control_request', 'upload_file'];
const RETIRED_TOOLS = /evidence_(?:get_context|run_plan|finish|capture|report_blocker|set_request_failure|reset_pair|reset_side)/;

// Run the real config writer against a temporary state directory.
// The clip recording a browser's own Playwright config asks for, if any.
function recordVideoOf(entry) {
  const at = entry.args.indexOf('--config');
  if (at < 0) return undefined;
  return JSON.parse(fs.readFileSync(entry.args[at + 1], 'utf8')).browser?.contextOptions?.recordVideo;
}

function writeConfig(dir, extra = {}) {
  const hostedFile = path.join(dir, 'hosted-origins.json');
  if (!fs.existsSync(hostedFile)) {
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid',
      headOrigin: 'http://head.example.invalid',
      apps: [{ origin: 'https://hosted.example.invalid', slug: 'hosted-app' }],
    }));
  }
  const output = path.join(dir, `mcp-${crypto.randomUUID()}.json`);
  const env = {
    ...process.env,
    SHOTS_BROWSER_STATE_DIR: path.join(dir, 'state'),
    SHOTS_PROXY_SERVER: 'http://127.0.0.1:17891',
    SHOTS_BASE_ORIGIN: 'http://base.example.invalid',
    SHOTS_HEAD_ORIGIN: 'http://head.example.invalid',
    SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
    SHOTS_DIR: path.join(dir, 'shots'),
  };
  delete env.SHOTS_RECORD_CLIPS;
  // An undefined value leaves that variable out entirely.
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  execFileSync(process.execPath, [path.join(workerDir, 'write-shots-mcp-config.js'), output], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { output, config: JSON.parse(fs.readFileSync(output, 'utf8')) };
}

test('the shots agent launches Playwright through the content-free timing observer', () => {
  const dockerfile = read('Dockerfile');
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');

  assert.match(dockerfile, /npm install -g @playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.match(dockerfile, /command -v playwright-mcp/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-shots-browser-mcp\.js/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-shots-browser-auth\.js/);
  assert.match(dockerfile, /COPY shots-mcp\.js \/usr\/local\/bin\/shots-mcp\.js/);
  assert.match(claudeRunner, /command -v playwright-mcp[^\n]*\n\s*\|\| die/);
  assert.match(dockerfile, /COPY shots-browser-observer\.js \/usr\/local\/bin\/shots-browser-observer\.js/);
  assert.match(claudeRunner, /SHOTS_BROWSER_DIAGNOSTIC_FILE/);
  // Every shots turn runs on Claude Code. The Codex runner has no shots
  // path: it refuses MODE=shots and starts no shots browser.
  assert.match(codexRunner, /\n\s+shots\) die "shots turns run on Claude Code \(run-cc\.sh\)" ;;\n/);
  assert.doesNotMatch(codexRunner, /shots-browser-observer\.js|SHOTS_BROWSER_DIAGNOSTIC_FILE|--proxy-server/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-config-test-'));
  try {
    const { config } = writeConfig(dir);
    for (const [server, state] of [
      ['browser_member', 'member.json'],
      ['browser_admin', 'read_only_admin.json'],
      ['browser_full_admin', 'full_admin.json'],
      ['browser_guest', 'guest.json'],
    ]) {
      const args = config.mcpServers[server].args;
      assert.equal(config.mcpServers[server].command, 'node');
      assert.equal(args[0], '/usr/local/bin/shots-browser-observer.js');
      assert.ok(args.includes(path.join(dir, 'state', state)));
      // No origin allowlist: the shots proxy is the boundary (shots-boundary.js).
      assert.ok(!args.includes('--allowed-origins'));
      assert.ok(args.includes('--no-sandbox'));
      assert.ok(args.includes('--caps'));
      assert.ok(args.includes('vision'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read('worker-run.sh'), /"--browser", "chromium", "--headless", "--isolated", "--no-sandbox"/);
  assert.match(claudeRunner, /SHOTS_HOSTED_ORIGINS_FILE/);
});

test('every shots browser, the guest\'s included, is denied the tools that run code or touch files', () => {
  const claudeRunner = read('run-cc.sh');
  const flags = /elif \[ "\$MODE" = "shots" \]; then[\s\S]*?PERMISSION_FLAGS="([^"]*)"/.exec(claudeRunner)?.[1];
  assert.ok(flags, 'the shots permission flags are found');
  const denied = new Set(flags.split(/\s+/));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-denied-tools-'));
  try {
    // Every phone browser too, whichever personas a run gives one.
    const servers = Object.keys(writeConfig(dir, {
      SHOTS_PHONE_PERSONAS: '["member","read_only_admin","full_admin","guest"]',
    }).config.mcpServers).filter((name) => name.startsWith('browser_'));
    assert.deepEqual(servers.sort(), ['browser_admin', 'browser_admin_phone', 'browser_full_admin',
      'browser_full_admin_phone', 'browser_guest', 'browser_guest_phone', 'browser_member', 'browser_member_phone']);
    for (const server of servers) {
      for (const tool of ['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe', 'browser_file_upload',
        'browser_drop']) {
        assert.ok(denied.has(`mcp__${server}__${tool}`), `${server} is denied ${tool}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The invited fixtures' browsers (#4437): a run's declared changes name
// their personas, so the config writer starts those servers only then, and
// the runner gives their directories and tokens to the bootstrap alone.
test('the invited fixtures\' browsers start only when a run names them', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  assert.match(worker,
    /browser_\(member\|admin\|full_admin\|guest\|invited_member\|invited_member_listed\)\(_phone\)\?\$/);
  const claudeRunner = read('run-cc.sh');
  assert.match(claudeRunner, /: "\$\{SHOTS_INVITED_MEMBER_TOKEN:=\}"/);
  assert.match(claudeRunner, /: "\$\{SHOTS_INVITED_MEMBER_LISTED_TOKEN:=\}"/);
  assert.match(claudeRunner, /mkdir -p "\$SHOTS_DIR\/invited_member"/);
  assert.match(claudeRunner, /mkdir -p "\$SHOTS_DIR\/invited_member_listed"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-invited-config-'));
  try {
    const plain = writeConfig(dir);
    assert.ok(!('browser_invited_member' in plain.config.mcpServers), 'no invited browser without the run naming one');
    const named = writeConfig(dir, {
      SHOTS_BROWSER_PERSONAS: '["member","read_only_admin","full_admin","guest","invited_member","invited_member_listed"]',
      SHOTS_PHONE_PERSONAS: '["invited_member_listed"]',
    });
    assert.ok(named.config.mcpServers.browser_invited_member);
    assert.ok(named.config.mcpServers.browser_invited_member_listed);
    // A phone browser reads its persona's saved state, so it starts only
    // beside the desktop browser the run also starts.
    assert.ok(named.config.mcpServers.browser_invited_member_listed_phone);
    assert.ok(!('browser_invited_member_phone' in named.config.mcpServers));
    // A list without the four ordinary personas is refused: those start on
    // every run.
    const fallback = writeConfig(dir, { SHOTS_BROWSER_PERSONAS: '["invited_member"]' });
    assert.ok(!('browser_invited_member' in fallback.config.mcpServers));
    assert.ok(fallback.config.mcpServers.browser_member);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guest browser is never signed in, and its optional token never outlives the bootstrap', () => {
  const claudeRunner = read('run-cc.sh');
  const bootstrap = read('shots-browser-bootstrap.js');
  // The bootstrap exchanges the three fixture tokens and writes the guest an
  // empty state; it never reads the guest token.
  assert.equal(require('../worker/shots-browser-bootstrap.js').SIGNED_OUT_STATE, '{"cookies":[],"origins":[]}\n');
  assert.match(bootstrap, /path\.join\(outputDir, 'guest\.json'\)/);
  assert.doesNotMatch(bootstrap, /SHOTS_GUEST_TOKEN/);
  assert.equal(require('../worker/shots-browser-bootstrap.js')
    .failureEvent(new Error('x'), { persona: 'guest', stage: 'storage_state' }).persona, 'guest');
  // Optional for the runner, its own proxy listener, and unset with the others.
  assert.match(claudeRunner, /: "\$\{SHOTS_GUEST_TOKEN:=\}"/);
  assert.match(claudeRunner, /"guest":17895/);
  assert.match(claudeRunner,
    /unset SHOTS_MEMBER_TOKEN SHOTS_ADMIN_TOKEN SHOTS_FULL_ADMIN_TOKEN SHOTS_GUEST_TOKEN \\?\n\s*SHOTS_INVITED_MEMBER_TOKEN SHOTS_INVITED_MEMBER_LISTED_TOKEN\n/);
});

test('on Homeroom\'s own pairs every signed-in persona makes the copies\' first-view demo data on both sides', async () => {
  const bootstrapModule = require('../worker/shots-browser-bootstrap.js');
  // The routes Homeroom's copies make first-view demo data on, with ?demo=1
  // (and only then), for the person asking: the conversations list makes the
  // staging Messages fixture, and opening the bot's DM its under-way card.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'conversations.js'), 'utf8');
  assert.match(routes, /router\.get\('\/api\/conversations', async \(req, res\) => \{\s*try \{\s*if \(isDemo\(req\)\) \{\s*await stagingMessages\.ensureFixtures\(pool, req\.user\);/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/activity', [^\n]*\n\s*try \{\s*if \(isDemo\(req\)\) return res\.json\(await stagingMessages\.ensureDemoUnderWayCard\(pool, req\.user\)\);/);
  assert.deepEqual(bootstrapModule.DEMO_DATA_REQUESTS.map(({ method, path: route }) => `${method} ${route}`), [
    'GET /api/conversations?demo=1',
    'POST /api/conversations/homeroom-bot/activity?demo=1',
  ]);
  // Only where the pair is the platform's own (worker.js sends '0' there)
  // and some path the run may open shows the demo.
  const hints = (paths) => JSON.stringify({ intentPaths: ['/#messages'], testingPaths: [], ...paths });
  const warms = (env) => bootstrapModule.warmsDemoData(env);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '0', SHOTS_NAVIGATION_HINTS: hints({ intentPaths: ['/?demo=1#messages'] }) }), true);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '0', SHOTS_NAVIGATION_HINTS: hints({ declaredPaths: ['/?x=2&demo=1'] }) }), true);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '0', SHOTS_NAVIGATION_HINTS: hints({ testingPaths: ['/?demo=10'] }) }), false);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '0', SHOTS_NAVIGATION_HINTS: hints({}) }), false);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '0', SHOTS_NAVIGATION_HINTS: '{' }), false);
  assert.equal(warms({ SHOTS_PLATFORM_ASSETS: '1', SHOTS_NAVIGATION_HINTS: hints({ intentPaths: ['/?demo=1'] }) }), false);
  assert.equal(warms({}), false);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  assert.match(worker, /SHOTS_PLATFORM_ASSETS: shotsPlatformAssets \? '1' : '0',/);
  const orchestrator = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'shots-orchestrator.js'), 'utf8');
  assert.match(orchestrator, /const selfApp = app\.slug === config\.selfAppSlug;[\s\S]*platformAssets: !selfApp,/);
  // Each persona, each side, before the browsers' storage is saved; never the guest.
  const bootstrap = read('shots-browser-bootstrap.js');
  const warm = bootstrap.indexOf('await warmDemoData(context, origin');
  assert.ok(warm > bootstrap.indexOf('for (const [index, origin] of origins.entries())'));
  assert.ok(warm < bootstrap.indexOf("progress.stage = 'storage_state';"));
  assert.match(bootstrap, /const warmDemo = warmsDemoData\(\);/);
  assert.match(bootstrap, /if \(warmDemo\) \{/);
  // As that persona (the context's own cookies), status only, and never fatal.
  const calls = [];
  const reports = [];
  const context = (answer) => ({
    request: {
      async fetch(url, options) {
        calls.push({ url, options });
        if (answer instanceof Error) throw answer;
        return { status: () => answer, dispose: async () => {} };
      },
    },
  });
  await bootstrapModule.warmDemoData(context(200), 'http://shots-base.invalid:3000', (r) => reports.push(r));
  await bootstrapModule.warmDemoData(context(404), 'http://shots-head.invalid:3000', (r) => reports.push(r));
  await bootstrapModule.warmDemoData(context(new Error('ECONNRESET http://shots-head.invalid')),
    'http://shots-head.invalid:3000', (r) => reports.push(r));
  assert.deepEqual(calls.map(({ url, options }) => `${options.method} ${url}`), [
    'GET http://shots-base.invalid:3000/api/conversations?demo=1',
    'POST http://shots-base.invalid:3000/api/conversations/homeroom-bot/activity?demo=1',
    'GET http://shots-head.invalid:3000/api/conversations?demo=1',
    'POST http://shots-head.invalid:3000/api/conversations/homeroom-bot/activity?demo=1',
    'GET http://shots-head.invalid:3000/api/conversations?demo=1',
    'POST http://shots-head.invalid:3000/api/conversations/homeroom-bot/activity?demo=1',
  ]);
  assert.ok(calls.every(({ options }) => options.maxRedirects === 0 && options.failOnStatusCode === false));
  assert.deepEqual(reports, [
    { outcome: 'ok', httpStatus: 200 }, { outcome: 'ok', httpStatus: 200 },
    { outcome: 'http_error', httpStatus: 404 }, { outcome: 'http_error', httpStatus: 404 },
    { outcome: 'network_error' }, { outcome: 'network_error' },
  ]);
  // The local dry-run pair does the same.
  const dryRun = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shots-dry-run-pair.js'), 'utf8');
  assert.match(dryRun, /await warmDemoData\(context, ORIGINS\[side\]\);/);
});

test('a shots turn carries a guest token only when the platform minted one', () => {
  const worker = require('../src/services/worker');
  const shots = (extra = {}) => worker.buildTurnSecretEnv({
    mode: 'shots', agentBackend: 'claude_code', anthropicProxyJwt: 'p', shotsJwt: 'e',
    shotsMemberToken: 'm', shotsAdminToken: 'a', shotsFullAdminToken: 'f', ...extra,
  });
  assert.equal('SHOTS_GUEST_TOKEN' in shots(), false, 'no guest token, no variable');
  assert.equal('SHOTS_GUEST_TOKEN' in shots({ shotsGuestToken: null }), false);
  assert.equal(shots({ shotsGuestToken: 'g' }).SHOTS_GUEST_TOKEN, 'g');
  assert.throws(() => shots({ shotsGuestToken: '' }), /shotsGuestToken required/,
    'an empty value is a bug upstream, not a token');
  // Never on any other turn.
  const build = worker.buildTurnSecretEnv({
    mode: 'build', agentBackend: 'claude_code', workerSessionJwt: 'w', issuesReadJwt: 'i',
    anthropicProxyJwt: 'p', shotsGuestToken: 'g',
  });
  assert.equal('SHOTS_GUEST_TOKEN' in build, false);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  assert.match(source, /shotsGuestToken: shotsAuthTokens\?\.guest \?\? null,/);
});

test('the browsers reach the public internet only through the shots proxy, and the catalog is still checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-egress-config-'));
  try {
    for (const assets of [undefined, '0', '1']) {
      const { config } = writeConfig(dir, { SHOTS_PLATFORM_ASSETS: assets });
      for (const server of ['browser_member', 'browser_admin', 'browser_full_admin', 'browser_guest']) {
        const args = config.mcpServers[server].args;
        assert.ok(!args.some((arg) => /allowed-origins|blocked-origins|tailwindcss/.test(arg)), server);
        assert.match(args[args.indexOf('--proxy-server') + 1], /^http:\/\/127\.0\.0\.1:\d+$/, server);
        // Loopback goes through the proxy too, which refuses it.
        assert.equal(args[args.indexOf('--proxy-bypass') + 1], '<-loopback>', server);
      }
    }
    // A catalog that does not match the run's pair still fails before any browser starts.
    fs.writeFileSync(path.join(dir, 'hosted-origins.json'), JSON.stringify({
      version: 2, baseOrigin: 'http://other.example.invalid', headOrigin: 'http://head.example.invalid', apps: [],
    }));
    assert.throws(() => writeConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The proxy, the observer and the bridge each load the boundary from the image.
  assert.match(read('Dockerfile'), /COPY shots-boundary\.js \/usr\/local\/bin\/shots-boundary\.js/);
  for (const file of ['shots-origin-proxy.js', 'shots-browser-observer.js', 'shots-mcp.js']) {
    assert.match(read(file), /require\('\.\/shots-boundary'\)/, file);
  }
});

test('the config writer gives each persona its own shots directory and records clips only when asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-shots-config-'));
  try {
    const shotsDir = path.join(dir, 'shots');
    const { output, config } = writeConfig(dir, {
      SHOTS_JWT: 'secret-shots-jwt', SHOTS_MEMBER_TOKEN: 'secret-member-token',
    });
    assert.deepEqual(Object.keys(config.mcpServers).sort(),
      ['browser_admin', 'browser_full_admin', 'browser_guest', 'browser_member', 'shots']);
    // The bridge is named "shots" (Claude sees mcp__shots__*) and its
    // credentials come from the environment, never from this file.
    assert.deepEqual(config.mcpServers.shots, { command: 'node', args: ['/usr/local/bin/shots-mcp.js'] });
    const text = fs.readFileSync(output, 'utf8');
    assert.doesNotMatch(text, /secret-shots-jwt|secret-member-token/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);

    for (const [server, persona] of [
      ['browser_member', 'member'], ['browser_admin', 'admin'], ['browser_full_admin', 'full_admin'],
      ['browser_guest', 'guest'],
    ]) {
      const args = config.mcpServers[server].args;
      assert.equal(args.filter((arg) => arg === '--output-dir').length, 1);
      assert.equal(args[args.indexOf('--output-dir') + 1], path.join(shotsDir, persona));
      assert.ok(fs.statSync(path.join(shotsDir, persona)).isDirectory(), `${persona} directory is created`);
      assert.equal(recordVideoOf(config.mcpServers[server]), undefined, 'no video unless a change is motion');
      assert.equal(Object.hasOwn(config.mcpServers[server].env, 'SHOTS_RECORD_CLIPS'), false);
      // Named files are saved in --output-dir (patch-playwright-mcp.js); the
      // workspace root, which inputs resolve against, is the samples the
      // observer starts the server in, never the agent client's.
      assert.ok(args.includes('--ignore-roots'));
      assert.equal(args[args.indexOf('--file-paths') + 1], 'absolute');
    }

    // Each browser's clip is its pages' video, saved into its own directory.
    const clips = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1' }).config;
    for (const [server, persona] of [['browser_member', 'member'], ['browser_admin', 'admin'],
      ['browser_full_admin', 'full_admin'], ['browser_guest', 'guest']]) {
      assert.deepEqual(recordVideoOf(clips.mcpServers[server]),
        { dir: path.join(shotsDir, persona), size: { width: 1280, height: 800 } });
      assert.equal(clips.mcpServers[server].args.filter((arg) => arg === '--config').length, 1);
      assert.equal(clips.mcpServers[server].env.SHOTS_RECORD_CLIPS, '1', 'the observer parks before a recorded close');
    }
    // Recorded at the motion screen's own size, so a phone clip fills its frame.
    const phone = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1', SHOTS_CLIP_SIZE: '390x844' }).config;
    assert.deepEqual(recordVideoOf(phone.mcpServers.browser_member).size, { width: 390, height: 844 });
    for (const odd of ['390', '390x844 --flag', '0x0', 'x']) {
      const fallback = writeConfig(dir, { SHOTS_RECORD_CLIPS: '1', SHOTS_CLIP_SIZE: odd }).config;
      assert.deepEqual(recordVideoOf(fallback.mcpServers.browser_member).size, { width: 1280, height: 800 }, odd);
    }
    assert.equal(recordVideoOf(writeConfig(dir, { SHOTS_CLIP_SIZE: '390x844' }).config.mcpServers.browser_member),
      undefined, 'a size alone records nothing');
    for (const value of ['0', 'true', 'yes', '']) {
      const off = writeConfig(dir, { SHOTS_RECORD_CLIPS: value }).config;
      for (const server of ['browser_member', 'browser_admin', 'browser_full_admin', 'browser_guest']) {
        assert.equal(recordVideoOf(off.mcpServers[server]), undefined,
          `SHOTS_RECORD_CLIPS=${JSON.stringify(value)} records nothing`);
      }
    }

    // Shots at the screen's own density are experimental: off unless the
    // run says so, every browser saves at 1x, as it always did.
    for (const value of [undefined, '0', 'true', '']) {
      const off = writeConfig(dir, { SHOTS_DEVICE_DENSITY: value, SHOTS_PHONE_PERSONAS: '["member"]' });
      for (const [server, entry] of Object.entries(off.config.mcpServers).filter(([name]) => name !== 'shots')) {
        assert.equal(entry.args.includes('--config'), false, `${server} ${value}`);
        assert.equal(Object.hasOwn(entry.env, 'SHOTS_SCREENSHOT_SCALE'), false, `${server} ${value}`);
      }
    }
    // On, every desktop browser draws at 3 device pixels per CSS pixel, from
    // a private config beside the MCP config (Playwright takes a density only
    // with a fixed viewport, the size the browser opened at before), and every
    // browser, the phone's included, saves at device scale.
    const dense = writeConfig(dir, { SHOTS_DEVICE_DENSITY: '1', SHOTS_PHONE_PERSONAS: '["member"]' });
    for (const server of ['browser_member', 'browser_admin', 'browser_full_admin', 'browser_guest']) {
      const args = dense.config.mcpServers[server].args;
      assert.equal(args.filter((arg) => arg === '--config').length, 1, server);
      const file = args[args.indexOf('--config') + 1];
      assert.equal(path.dirname(file), path.dirname(dense.output));
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
        { browser: { contextOptions: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 3 } } });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(args.includes('--device'), false, 'a desktop browser presents as no device');
    }
    for (const server of ['browser_member', 'browser_member_phone']) {
      assert.equal(dense.config.mcpServers[server].env.SHOTS_SCREENSHOT_SCALE, 'device', server);
    }
    assert.equal(dense.config.mcpServers.browser_member_phone.args.includes('--config'), false,
      'the phone\'s density is its device\'s');

    // Without a shots directory there is nowhere safe to save, so no config.
    for (const missing of [undefined, '']) {
      assert.throws(() => writeConfig(dir, { SHOTS_DIR: missing }), /inputs are incomplete/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #6379: the screenshot tool waits for a settled page only when the browser
// says so, and every shots browser, desktop and phone, says so.
test('every shots browser waits for a settled page before a screenshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-settle-config-'));
  try {
    for (const extra of [{}, { SHOTS_DEVICE_DENSITY: '1' }]) {
      const { config } = writeConfig(dir, { ...extra, SHOTS_PHONE_PERSONAS: '["member","guest"]' });
      const browsers = Object.entries(config.mcpServers).filter(([name]) => name.startsWith('browser_'));
      assert.deepEqual(browsers.map(([name]) => name).sort(),
        ['browser_admin', 'browser_full_admin', 'browser_guest', 'browser_guest_phone',
          'browser_member', 'browser_member_phone']);
      for (const [name, server] of browsers) {
        assert.equal(server.env.SHOTS_SCREENSHOT_SETTLE, '1', `${name} ${JSON.stringify(extra)}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a persona with a phone screen gets a phone browser: its sign-in, its proxy listener, a phone\'s device', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-phone-config-'));
  const ports = '{"member":17892,"read_only_admin":17893,"full_admin":17894,"guest":17895}';
  try {
    const shotsDir = path.join(dir, 'shots');
    // No phone screen, no phone browser.
    for (const value of [undefined, '[]']) {
      const { config } = writeConfig(dir, { SHOTS_PHONE_PERSONAS: value, SHOTS_PROXY_PERSONA_PORTS: ports });
      assert.deepEqual(Object.keys(config.mcpServers).filter((name) => name.endsWith('_phone')), [], String(value));
      for (const server of ['browser_member', 'browser_admin', 'browser_full_admin', 'browser_guest']) {
        assert.equal(config.mcpServers[server].args.includes('--device'), false, `${server} stays a desktop browser`);
      }
    }

    const { config } = writeConfig(dir, {
      SHOTS_PHONE_PERSONAS: '["member","read_only_admin","guest"]', SHOTS_PROXY_PERSONA_PORTS: ports,
    });
    assert.deepEqual(Object.keys(config.mcpServers).filter((name) => name.endsWith('_phone')).sort(),
      ['browser_admin_phone', 'browser_guest_phone', 'browser_member_phone'], 'only the personas named');
    for (const [desktop, persona] of [['browser_member', 'member'], ['browser_admin', 'admin'], ['browser_guest', 'guest']]) {
      const phone = config.mcpServers[`${desktop}_phone`];
      const desktopArgs = config.mcpServers[desktop].args;
      const args = phone.args;
      assert.equal(phone.command, 'node');
      assert.deepEqual(phone.env, config.mcpServers[desktop].env);
      // The same observer, under the phone browser's own name.
      assert.equal(args[0], '/usr/local/bin/shots-browser-observer.js');
      assert.equal(args[1], `${persona}_phone`);
      // Presents as an iPhone: Playwright's device descriptor sets its user
      // agent, touch, isMobile and screen density.
      assert.equal(args[args.indexOf('--device') + 1], 'iPhone 15');
      // Saves beside the persona's directory, never into it: one closed
      // session record per directory (shots-boundary.js).
      assert.equal(args[args.indexOf('--output-dir') + 1], path.join(shotsDir, `${persona}_phone`));
      assert.ok(fs.statSync(path.join(shotsDir, `${persona}_phone`)).isDirectory());
      // Everything else is the persona's own browser: the same storage state
      // (signed in as the same persona, or the guest's signed-out state), the
      // same proxy listener (the same identity on a hosted app), the same
      // init script and limits.
      const strip = (list) => list.filter((arg, index) => index > 1
        && !['--device', 'iPhone 15', '--output-dir', '--config'].includes(arg) && !arg.startsWith(shotsDir)
        && !/shots-browser-[a-z_]+\.json$/.test(arg));
      assert.deepEqual(strip(args), strip(desktopArgs), desktop);
      assert.equal(args[args.indexOf('--proxy-server') + 1], desktopArgs[desktopArgs.indexOf('--proxy-server') + 1]);
      assert.equal(args[args.indexOf('--storage-state') + 1], desktopArgs[desktopArgs.indexOf('--storage-state') + 1]);
    }
    assert.equal(fs.existsSync(path.join(shotsDir, 'full_admin_phone')), false, 'no directory for a browser that is not there');

    // The phone browsers record at the phone motion screens' size, the
    // others at theirs; a phone browser with no size of its own takes theirs.
    const clips = writeConfig(dir, { SHOTS_PHONE_PERSONAS: '["member"]', SHOTS_RECORD_CLIPS: '1',
      SHOTS_CLIP_SIZE: '1280x800', SHOTS_PHONE_CLIP_SIZE: '390x844' }).config;
    assert.deepEqual(recordVideoOf(clips.mcpServers.browser_member).size, { width: 1280, height: 800 });
    assert.deepEqual(recordVideoOf(clips.mcpServers.browser_member_phone),
      { dir: path.join(shotsDir, 'member_phone'), size: { width: 390, height: 844 } });
    // The phone's screen is still its device's: the config adds the video only.
    assert.ok(clips.mcpServers.browser_member_phone.args.includes('--device'));
    const shared = writeConfig(dir, { SHOTS_PHONE_PERSONAS: '["member"]', SHOTS_RECORD_CLIPS: '1',
      SHOTS_CLIP_SIZE: '1280x800', SHOTS_PHONE_CLIP_SIZE: '390' }).config;
    assert.deepEqual(recordVideoOf(shared.mcpServers.browser_member_phone).size, { width: 1280, height: 800 });
    assert.equal(recordVideoOf(writeConfig(dir, { SHOTS_PHONE_PERSONAS: '["member"]', SHOTS_PHONE_CLIP_SIZE: '390x844' })
      .config.mcpServers.browser_member_phone), undefined, 'a size alone records nothing');

    // A persona list the platform did not write is refused, not guessed at.
    for (const odd of ['["admin"]', '["member","../state"]', '"member"', '{}', 'not json']) {
      assert.throws(() => writeConfig(dir, { SHOTS_PHONE_PERSONAS: odd }), /inputs are invalid/, odd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Claude runner gives the shots bridge its directory; the Codex runner has no shots bridge', () => {
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  // Every shots turn takes shots now; nothing depends on a mode flag.
  assert.match(claudeRunner, /export SHOTS_DIR="\$SHOTS_TMP\/shots"/);
  assert.match(claudeRunner,
    /mkdir -p "\$SHOTS_DIR\/member" "\$SHOTS_DIR\/admin" "\$SHOTS_DIR\/full_admin" "\$SHOTS_DIR\/guest"/);
  assert.doesNotMatch(claudeRunner, /EVIDENCE_MODE/);
  assert.doesNotMatch(claudeRunner, /EVIDENCE_COMPLETION_REMINDER/);
  assert.doesNotMatch(claudeRunner, RETIRED_TOOLS);
  // Claude's MCP config is written after the directory exists.
  assert.ok(claudeRunner.indexOf('export SHOTS_DIR=')
    < claudeRunner.indexOf('node /usr/local/bin/write-shots-mcp-config.js'));

  // Every shots turn runs on Claude Code, so the Codex runner registers no
  // shots bridge and takes no shots directory.
  assert.doesNotMatch(codexRunner, /\[mcp_servers\.(?:shots|evidence|visual_evidence)\]|SHOTS_DIR|SHOTS_RECORD_CLIPS/);
  assert.doesNotMatch(codexRunner, RETIRED_TOOLS);
  for (const tool of SHOTS_TOOLS) assert.doesNotMatch(codexRunner, new RegExp(`"${tool}"`));

  // The platform turns the run's decision into the runner's 0/1 flag, and
  // refuses anything that is not a boolean.
  assert.match(workerSource, /shotsRecordClips = false,/);
  assert.match(workerSource, /SHOTS_RECORD_CLIPS: shotsRecordClips \? '1' : '0'/);
  assert.match(workerSource, /if \(typeof shotsRecordClips !== 'boolean'\) \{\n\s*throw new Error/);

  // The image smoke test exercises the same writer with clips on and proves
  // a named screenshot lands in the browser's shots directory.
  const smoke = read('verify-shots-browser-mcp.js');
  assert.match(smoke, /SHOTS_DIR: path\.join\(dir, 'shots'\)/);
  assert.match(smoke, /SHOTS_RECORD_CLIPS: '1'/);
  assert.match(smoke, /arguments: \{ filename: 'image-smoke\.png' \}/);
  assert.match(smoke, /fs\.existsSync\(path\.join\(outputDir, 'image-smoke\.png'\)\)/);
});

// Load worker/shots-mcp.js with the MCP SDK and zod replaced by recorders,
// so its tool handlers run for real against a temporary shots directory and a
// fake platform. Nothing is spawned and nothing leaves the process.
function loadBridge(env, platformFetch) {
  const tools = new Map();
  let serverInfo = null;
  class McpServer {
    constructor(info) { serverInfo = info; }
    registerTool(name, _spec, handler) { tools.set(name, handler); }
    connect() { return Promise.resolve(); }
  }
  const schema = new Proxy(function schemaStub() {}, {
    get: () => () => schema,
    apply: () => schema,
  });
  const bridgeRequire = (request) => {
    if (/@modelcontextprotocol\/sdk\/.*\/server\/mcp\.js$/.test(request)) return { McpServer };
    if (/@modelcontextprotocol\/sdk\/.*\/server\/stdio\.js$/.test(request)) return { StdioServerTransport: class {} };
    if (/\/zod$/.test(request)) return { z: schema };
    return require(request.startsWith('.') ? path.join(workerDir, request) : request);
  };
  const bridgeProcess = {
    env,
    exit: (code) => { throw new Error(`bridge exited ${code}`); },
    stderr: { write() {} },
  };
  const source = read('shots-mcp.js').replace(/^#!.*\n/, '');
  new Function('require', 'process', 'fetch', source)(bridgeRequire, bridgeProcess, platformFetch);
  return { tools, serverInfo };
}

function bridgeFixture(t, { declaredChanges, darkMode = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shotsDir = path.join(dir, 'shots');
  for (const persona of ['member', 'admin', 'full_admin', 'guest']) fs.mkdirSync(path.join(shotsDir, persona), { recursive: true });
  const hostedFile = path.join(dir, 'hosted-origins.json');
  fs.writeFileSync(hostedFile, JSON.stringify({
    version: 2, baseOrigin: 'http://base.example.invalid', headOrigin: 'http://head.example.invalid',
    apps: [{ origin: 'https://hosted.example.invalid', slug: 'hosted-app' }],
  }));
  const runId = 'a'.repeat(32);
  const context = {
    origins: { base: 'http://base.example.invalid', head: 'http://head.example.invalid' },
    addresses: { before: 'http://base.example.invalid', after: 'http://head.example.invalid' },
    declaredChanges: declaredChanges || [
      { id: 'invite-suggestions', persona: 'member', intent: { animation: 'steps' } },
      { id: 'saved-toast', persona: 'member', intent: { animation: 'motion' } },
      { id: 'admin-banner', persona: 'read_only_admin', intent: { animation: 'motion' } },
      {
        id: 'load-error', persona: 'member',
        intent: { animation: 'none', controlledFailurePath: '/api/lists/demo' },
      },
    ],
    ...(darkMode ? { darkMode } : {}),
  };
  const calls = [];
  const platformFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({
      origin: parsed.origin, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
      method: init.method || 'GET', headers: init.headers || {}, body: init.body,
    });
    let payload;
    if (parsed.pathname === '/__usernode_shots_control/request-failure') {
      payload = { enabled: JSON.parse(init.body).enabled, hitCount: 0 };
    } else if (parsed.pathname.endsWith('/context')) {
      payload = { ok: true, context };
    } else {
      payload = { ok: true, result: { accepted: parsed.pathname.split('/').pop() } };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = {
    PLATFORM_URL: 'http://platform.test:3000/',
    SHOTS_RUN_ID: runId,
    SHOTS_JWT: 'run-scoped-jwt',
    SHOTS_PROXY_SERVER: 'http://127.0.0.1:17891',
    SHOTS_PROXY_CONTROL_TOKEN: 'c'.repeat(64),
    SHOTS_DIR: shotsDir,
    SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
  };
  const { tools, serverInfo } = loadBridge(env, platformFetch);
  const call = async (name, args = {}) => {
    const result = await tools.get(name)(args);
    return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  return { dir, shotsDir, runId, env, calls, tools, serverInfo, call, platformFetch };
}

test('the shots bridge offers exactly nine tools and talks only to its own run', async (t) => {
  const bridge = bridgeFixture(t);
  assert.equal(bridge.serverInfo.name, 'usernode-before-after-shots');
  assert.deepEqual([...bridge.tools.keys()], SHOTS_TOOLS);
  assert.deepEqual([...read('shots-mcp.js').matchAll(/registerTool\('([a-z_]+)'/g)].map((match) => match[1]),
    SHOTS_TOOLS);

  const brief = await bridge.call('get_brief');
  assert.equal(brief.isError, false);
  assert.deepEqual(brief.value.eligibleHostedAppSlugs, ['hosted-app']);
  assert.equal(brief.value.declaredChanges.length, 4);

  const skip = await bridge.call('skip_change', { reason: 'Every screen shows a sign-in page.' });
  assert.equal(skip.isError, false);
  const one = await bridge.call('skip_change', { reason: 'Needs a second member.', change: 'invite-suggestions' });
  assert.equal(one.isError, false);
  const note = await bridge.call('note_change', { change: 'saved-toast', note: 'The undo link needs a second list.' });
  assert.equal(note.isError, false);
  // A problem noticed on the after build goes to its own route, with only
  // the fields the agent gave.
  const problem = await bridge.call('note_problem', {
    change: 'invite-suggestions', screen: 'phone', problem: 'The results table is cut off at the right edge.',
    alsoBefore: false, shot: 'screen',
  });
  assert.equal(problem.isError, false);
  const unsure = await bridge.call('note_problem', {
    change: 'invite-suggestions', screen: 'desktop', problem: 'The sort control overlaps a column heading.',
    alsoBefore: 'unknown',
  });
  assert.equal(unsure.isError, false);

  assert.deepEqual(bridge.calls.map((sent) => [sent.method, sent.origin, sent.path]), [
    ['GET', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/context`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/skip`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/skip`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/note`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/problem`],
    ['POST', 'http://platform.test:3000', `/api/internal/shots/${bridge.runId}/problem`],
  ]);
  assert.ok(bridge.calls.every((sent) => sent.headers.authorization === 'Bearer run-scoped-jwt'));
  assert.deepEqual(JSON.parse(bridge.calls[1].body), { change: null, reason: 'Every screen shows a sign-in page.' });
  assert.deepEqual(JSON.parse(bridge.calls[2].body), { change: 'invite-suggestions', reason: 'Needs a second member.' });
  assert.deepEqual(JSON.parse(bridge.calls[3].body), { change: 'saved-toast', note: 'The undo link needs a second list.' });
  assert.deepEqual(JSON.parse(bridge.calls[4].body), {
    change: 'invite-suggestions', screen: 'phone', problem: 'The results table is cut off at the right edge.',
    alsoBefore: false, shot: 'screen',
  });
  assert.deepEqual(JSON.parse(bridge.calls[5].body), {
    change: 'invite-suggestions', screen: 'desktop', problem: 'The sort control overlaps a column heading.',
    alsoBefore: 'unknown',
  });
  const problemTool = /registerTool\('note_problem', \{[\s\S]*?\n\}, async/.exec(read('shots-mcp.js'))[0];
  assert.match(problemTool, /not about the declared change itself/);
  assert.match(problemTool, /never a matter of taste, style or wording/);
  assert.match(problemTool, /"Also noticed" and changes nothing about the shots/);
  assert.match(problemTool, /At most five per run/);
  assert.match(problemTool, /problem: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(300\)/);
  // The agent must say whether the before build has it: left optional, it
  // was "unknown" for every problem noted in the proposals merged
  // 2026-10-09 to 10-12.
  assert.match(problemTool, /alsoBefore: z\.union\(\[z\.boolean\(\), z\.literal\('unknown'\)\]\)\s+\.describe\('true if your before shot of the same screen/);
  assert.doesNotMatch(problemTool, /alsoBefore: z\.union\(\[z\.boolean\(\), z\.literal\('unknown'\)\]\)\.optional\(\)/);
  assert.match(problemTool, /"unknown" only if you could not look/);
  assert.match(problemTool, /you shoot the before side of the same screen anyway, so look at that shot/);

  // A bridge without its run, token or platform refuses to start.
  for (const broken of [{ SHOTS_JWT: '' }, { SHOTS_RUN_ID: 'not-a-run' }, { PLATFORM_URL: 'file:///etc' }]) {
    assert.throws(() => loadBridge({ ...bridge.env, ...broken }, bridge.platformFetch), /bridge exited 1/);
  }
});

// The observer stamps each screenshot with the site it was taken on, and each
// closed session with every site it showed (shots-boundary.js); these stand
// in for it.
const HEAD = 'http://head.example.invalid';
const BASE = 'http://base.example.invalid';
function stamp(bridge, persona, name, pageUrl) {
  const outputDir = path.join(bridge.shotsDir, persona);
  boundary.stampScreenshot(outputDir, path.join(outputDir, name), pageUrl);
}
const uploads = (bridge) => bridge.calls.filter((sent) => sent.path.endsWith('/shot'));

test('save_shot publishes only a plain .png the browser saved in a persona directory', async (t) => {
  const bridge = bridgeFixture(t);
  const image = Buffer.from('png bytes the platform will check');
  fs.writeFileSync(path.join(bridge.shotsDir, 'admin', 'invite-desktop-after.png'), image);
  stamp(bridge, 'admin', 'invite-desktop-after.png', `${HEAD}/#invite`);
  const shot = { change: 'invite-suggestions', screen: 'desktop', side: 'after' };

  const saved = await bridge.call('save_shot', { shots: [{ ...shot, file: 'invite-desktop-after.png' }] });
  assert.equal(saved.isError, false);
  assert.equal(saved.value.saved, 1);
  assert.deepEqual(bridge.calls.map((sent) => sent.path),
    [`/api/internal/shots/${bridge.runId}/context`, `/api/internal/shots/${bridge.runId}/shot`],
    'the run\'s own addresses come from its brief');
  const [sent] = uploads(bridge);
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.query, { ...shot, kind: 'screen' });
  assert.equal(sent.headers['content-type'], 'application/octet-stream');
  assert.ok(Buffer.from(sent.body).equals(image));

  // The path the browser reported is reduced to its name inside the shots
  // directories; it cannot lead anywhere else.
  assert.equal((await bridge.call('save_shot', { shots: [{
    ...shot, kind: 'element', file: '../../state/invite-desktop-after.png',
  }] })).isError, false);
  assert.equal(uploads(bridge)[1].query.kind, 'element');
  assert.ok(Buffer.from(uploads(bridge)[1].body).equals(image));

  // Browser storage state, hidden or oddly named files, and links are never read.
  fs.writeFileSync(path.join(bridge.dir, 'member.json'), '{"cookies":["secret"]}');
  fs.writeFileSync(path.join(bridge.dir, 'outside.png'), image);
  fs.symlinkSync(path.join(bridge.dir, 'outside.png'), path.join(bridge.shotsDir, 'member', 'linked.png'));
  fs.writeFileSync(path.join(bridge.shotsDir, 'member', '.hidden.png'), image);
  for (const [file, code] of [
    ['../state/member.json', 'invalid_shot_file'],
    [path.join(bridge.dir, 'member.json'), 'invalid_shot_file'],
    ['.hidden.png', 'invalid_shot_file'],
    ['shot.png.txt', 'invalid_shot_file'],
    ['linked.png', 'shot_file_not_found'],
    ['outside.png', 'shot_file_not_found'],
    ['never-taken.png', 'shot_file_not_found'],
  ]) {
    const refused = await bridge.call('save_shot', { shots: [{ ...shot, file }] });
    assert.equal(refused.isError, true, `${file} must be refused`);
    assert.equal(refused.value.results[0].error.code, code, file);
  }
  assert.equal(uploads(bridge).length, 2, 'a refused file never reaches the platform');

  // Several files in one call, and one screenshot for two changes: each is
  // its own upload, and a refused one does not stop the rest.
  const batch = await bridge.call('save_shot', { shots: [
    { ...shot, file: 'invite-desktop-after.png' },
    { ...shot, change: 'saved-toast', file: 'invite-desktop-after.png' },
    { ...shot, kind: 'element', file: 'never-taken.png' },
  ] });
  assert.equal(batch.isError, false, 'something saved, so the call is not an error');
  assert.equal(batch.value.saved, 2);
  assert.equal(batch.value.refused, 1);
  assert.equal(batch.value.results[2].error.code, 'shot_file_not_found');
  assert.deepEqual(uploads(bridge).slice(2).map((sent) => sent.query.change), ['invite-suggestions', 'saved-toast']);
});

// The brief's dark shots (#4459): the browser opens the page with the mode
// parameter set, and save_shot says so when it uploads, so the run stores
// the file as a dark slot and not a retake of the light one.
test('save_shot forwards theme "dark" for a whole-screen shot taken in dark mode', async (t) => {
  const bridge = bridgeFixture(t);
  const image = Buffer.from('png bytes the platform will check');
  fs.writeFileSync(path.join(bridge.shotsDir, 'admin', 'invite-desktop-after-dark.png'), image);
  stamp(bridge, 'admin', 'invite-desktop-after-dark.png', `${HEAD}/?un-theme=dark#invite`);
  const shot = { change: 'invite-suggestions', screen: 'desktop', side: 'after', theme: 'dark' };

  const saved = await bridge.call('save_shot', { shots: [{ ...shot, file: 'invite-desktop-after-dark.png' }] });
  assert.equal(saved.isError, false);
  const [sent] = uploads(bridge);
  assert.deepEqual(sent.query, { change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'screen', theme: 'dark' });
  assert.ok(Buffer.from(sent.body).equals(image));

  // A light shot (the default) carries no theme in the query at all.
  const light = await bridge.call('save_shot', { shots: [{
    change: 'invite-suggestions', screen: 'desktop', side: 'after', theme: 'light', file: 'invite-desktop-after-dark.png',
  }] });
  assert.equal(light.isError, false);
  assert.equal('theme' in uploads(bridge)[1].query, false);

  // The tool takes the field for a whole-screen shot only, and describes why.
  const tool = /registerTool\('save_shot', \{[\s\S]*?\n\}, async/.exec(read('shots-mcp.js'))[0];
  assert.match(tool, /theme: z\.enum\(\['light', 'dark'\]\)\.optional\(\)/);
  assert.match(tool, /Set "dark" only for a whole-screen shot taken with the page in dark mode/);
  assert.match(tool, /for one it lists in darkLeft, take the dark shot yourself as the brief says and pass theme "dark"\. Element shots and clips are always light/);
});

test('save_shot publishes a shot only from its own side\'s address', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  const take = (name, pageUrl, pixels = name) => {
    fs.writeFileSync(path.join(member, name), pixels);
    if (pageUrl !== undefined) stamp(bridge, 'member', name, pageUrl);
  };
  const save = (side, file) => bridge.call('save_shot', { shots: [
    { change: 'invite-suggestions', screen: 'desktop', side, file },
  ] });

  take('before.png', `${BASE}/#home`);
  take('after.png', `${HEAD}/#home?x=1`);
  take('another-site.png', 'https://example.com/');
  take('blank.png', 'about:blank');
  take('unstamped.png');
  take('replaced.png', `${HEAD}/`);
  fs.writeFileSync(path.join(member, 'replaced.png'), 'a download that took its name');

  assert.equal((await save('before', 'before.png')).isError, false);
  assert.equal((await save('after', 'after.png')).isError, false);
  for (const [side, file] of [
    ['after', 'before.png'],
    ['before', 'after.png'],
    ['after', 'another-site.png'],
    ['after', 'blank.png'],
    ['after', 'unstamped.png'],
    ['after', 'replaced.png'],
  ]) {
    const refused = await save(side, file);
    assert.equal(refused.isError, true, `${side} ${file} must be refused`);
    assert.equal(refused.value.results[0].error.code, 'shot_not_on_app', `${side} ${file}`);
    assert.match(refused.value.results[0].error.message, new RegExp(`the ${side} address`));
  }
  assert.deepEqual(uploads(bridge).map((sent) => Buffer.from(sent.body).toString()), ['before.png', 'after.png']);
  assert.equal(bridge.calls.filter((sent) => sent.path.endsWith('/context')).length, 1, 'the brief is read once');
});

test('save_clip publishes the newest recording and retires every older one', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  const record = (dir, name, content, secondsAgo) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, when, when);
  };
  // What the observer writes as each recorded session closes, after its clip.
  const closed = (dir, ...pages) => boundary.recordSession(dir, pages);
  const clip = (change, side) => bridge.call('save_clip', { change, screen: 'desktop', side });
  const lastBody = () => Buffer.from(bridge.calls.at(-1).body).toString();

  // Only a declared motion change takes a clip, and nothing is read otherwise.
  assert.equal((await clip('invite-suggestions', 'before')).value.code, 'clip_not_needed');
  assert.equal((await clip('not-declared', 'before')).value.code, 'unknown_change');
  assert.equal((await clip('saved-toast', 'before')).value.code, 'clip_not_found');
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')));

  // The stills session closed first; the motion session after it.
  record(member, 'stills-session.webm', 'stills', 60);
  record(member, 'motion-before.webm', 'motion before', 10);
  record(member, 'notes.txt', 'not a clip', 0);
  closed(member, `${BASE}/#lists`);
  const before = await clip('saved-toast', 'before');
  assert.equal(before.isError, false);
  assert.deepEqual(bridge.calls.at(-1).query,
    { change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' });
  assert.equal(lastBody(), 'motion before');

  // Both were retired, so the stale stills session can never be published.
  assert.equal((await clip('saved-toast', 'after')).value.code, 'clip_not_found');
  // A second back: a file's own timestamps come from a coarser clock than Date.now().
  record(member, 'motion-after.webm', 'motion after', 1);
  closed(member, `${HEAD}/#lists`);
  assert.equal((await clip('saved-toast', 'after')).isError, false);
  assert.equal(lastBody(), 'motion after');

  // A read-only admin's browser records into the admin directory.
  const admin = path.join(bridge.shotsDir, 'admin');
  record(admin, 'banner.webm', 'admin banner', 1);
  closed(admin, `${BASE}/`);
  assert.equal((await clip('admin-banner', 'before')).isError, false);
  assert.equal(lastBody(), 'admin banner');

  // A link is not a recording.
  fs.writeFileSync(path.join(bridge.dir, 'elsewhere.webm'), 'not from this browser');
  fs.symlinkSync(path.join(bridge.dir, 'elsewhere.webm'), path.join(member, 'linked.webm'));
  assert.equal((await clip('saved-toast', 'after')).value.code, 'clip_not_found');
  assert.equal(uploads(bridge).length, 3);
});

test('the guest browser\'s shots and clips are read from its own directory', async (t) => {
  const bridge = bridgeFixture(t, { declaredChanges: [
    { id: 'signed-out-landing', persona: 'guest', intent: { animation: 'motion' } },
  ] });
  const guest = path.join(bridge.shotsDir, 'guest');
  fs.writeFileSync(path.join(guest, 'landing-desktop-after.png'), 'guest still');
  stamp(bridge, 'guest', 'landing-desktop-after.png', `${HEAD}/`);
  const saved = await bridge.call('save_shot', { shots: [{
    change: 'signed-out-landing', screen: 'desktop', side: 'after', file: 'landing-desktop-after.png',
  }] });
  assert.equal(saved.isError, false);
  assert.equal(Buffer.from(uploads(bridge).at(-1).body).toString(), 'guest still');

  const clipFile = path.join(guest, 'landing.webm');
  fs.writeFileSync(clipFile, 'guest clip');
  const when = new Date(Date.now() - 1000);
  fs.utimesSync(clipFile, when, when);
  boundary.recordSession(guest, [`${BASE}/`]);
  const clip = await bridge.call('save_clip', { change: 'signed-out-landing', screen: 'desktop', side: 'before' });
  assert.equal(clip.isError, false);
  assert.equal(Buffer.from(uploads(bridge).at(-1).body).toString(), 'guest clip');
});

test('a phone screen\'s shots and clips are read from its phone browser\'s directory', async (t) => {
  const bridge = bridgeFixture(t, { declaredChanges: [
    { id: 'install-strip', persona: 'member', intent: { animation: 'motion' } },
    { id: 'admin-sheet', persona: 'read_only_admin', intent: { animation: 'motion' } },
  ] });
  // As the brief names them: each change's phone screen in the persona's
  // phone browser, its desktop screen in the persona's own.
  const context = (await bridge.call('get_brief')).value;
  context.screenBrowsers = {
    'install-strip': { desktop: 'browser_member', phone: 'browser_member_phone' },
    'admin-sheet': { phone: 'browser_admin_phone' },
  };
  const platformFetch = bridge.platformFetch;
  const { tools } = loadBridge(bridge.env, async (url, init) => (new URL(url).pathname.endsWith('/context')
    ? new Response(JSON.stringify({ ok: true, context }), { status: 200 })
    : platformFetch(url, init)));
  const call = async (name, args) => {
    const result = await tools.get(name)(args);
    return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
  };
  const member = path.join(bridge.shotsDir, 'member');
  const memberPhone = path.join(bridge.shotsDir, 'member_phone');
  const adminPhone = path.join(bridge.shotsDir, 'admin_phone');
  for (const dir of [memberPhone, adminPhone]) fs.mkdirSync(dir);
  const record = (dir, name, content, secondsAgo, ...pages) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, when, when);
    if (pages.length) boundary.recordSession(dir, pages);
  };
  const lastBody = () => Buffer.from(uploads(bridge).at(-1).body).toString();

  // A still the phone browser saved, stamped by its own observer.
  fs.writeFileSync(path.join(memberPhone, 'strip-phone-after.png'), 'phone still');
  stamp(bridge, 'member_phone', 'strip-phone-after.png', `${HEAD}/`);
  const still = await call('save_shot', { shots: [
    { change: 'install-strip', screen: 'phone', side: 'after', file: 'strip-phone-after.png' },
  ] });
  assert.equal(still.isError, false);
  assert.equal(lastBody(), 'phone still');
  // Two browsers that saved the same name: the one saved last is the one meant.
  record(member, 'same-name.png', 'desktop, earlier', 30);
  stamp(bridge, 'member', 'same-name.png', `${HEAD}/`);
  record(memberPhone, 'same-name.png', 'phone, just now', 1);
  stamp(bridge, 'member_phone', 'same-name.png', `${HEAD}/`);
  assert.equal((await call('save_shot', { shots: [
    { change: 'install-strip', screen: 'phone', side: 'after', file: 'same-name.png' },
  ] })).isError, false);
  assert.equal(lastBody(), 'phone, just now');

  // The desktop browser's newer session never stands for the phone clip,
  // nor the phone browser's for the desktop one.
  record(memberPhone, 'phone-before.webm', 'phone clip', 20, `${BASE}/`);
  record(member, 'desktop-after.webm', 'desktop clip', 10, `${HEAD}/`);
  assert.equal((await call('save_clip', { change: 'install-strip', screen: 'phone', side: 'before' })).isError, false);
  assert.equal(lastBody(), 'phone clip');
  assert.equal((await call('save_clip', { change: 'install-strip', screen: 'desktop', side: 'after' })).isError, false);
  assert.equal(lastBody(), 'desktop clip');
  // The read-only admin's phone browser records into admin_phone.
  record(adminPhone, 'sheet.webm', 'admin phone clip', 1, `${HEAD}/`);
  assert.equal((await call('save_clip', { change: 'admin-sheet', screen: 'phone', side: 'after' })).isError, false);
  assert.equal(lastBody(), 'admin phone clip');
  // A brief without screenBrowsers reads the persona's own directory, as
  // before: the phone directory only when the brief names that browser.
  assert.equal((await bridge.call('save_clip', { change: 'install-strip', screen: 'phone', side: 'after' })).isError, false);
  assert.equal(lastBody(), 'desktop clip');
});

test('save_clip publishes a recording only when its whole session stayed on its side\'s address', async (t) => {
  const bridge = bridgeFixture(t);
  const member = path.join(bridge.shotsDir, 'member');
  // A second back by default: a file's own timestamps come from a coarser
  // clock than Date.now(), so a record written next could read as older.
  const recorded = (name, secondsAgo = 1) => {
    const file = path.join(member, name);
    fs.writeFileSync(file, name);
    const when = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(file, when, when);
  };
  const clip = (side) => bridge.call('save_clip', { change: 'saved-toast', screen: 'desktop', side });
  const refusedWith = async (side) => {
    const refused = await clip(side);
    assert.equal(refused.isError, true);
    assert.equal(refused.value.code, 'shot_not_on_app');
    return refused.value.message;
  };

  // No session record at all.
  recorded('first.webm');
  assert.match(await refusedWith('after'), /cannot be told/);
  // The session left the address, or it was the other side's.
  boundary.recordSession(member, [`${HEAD}/`, 'https://example.com/']);
  assert.match(await refusedWith('after'), /not taken on the after address/);
  boundary.recordSession(member, [`${HEAD}/`]);
  assert.match(await refusedWith('before'), /not taken on the before address/);
  // A clip newer than the record came from a session no record covers.
  recorded('second.webm', -5);
  assert.match(await refusedWith('after'), /cannot be told/);
  assert.equal(uploads(bridge).length, 0);

  // Recorded again on the address, it is published.
  const second = path.join(member, 'second.webm');
  const earlier = new Date(Date.now() - 1000);
  fs.utimesSync(second, earlier, earlier);
  boundary.recordSession(member, [`${HEAD}/#lists`]);
  assert.equal((await clip('after')).isError, false);
  assert.equal(Buffer.from(uploads(bridge)[0].body).toString(), 'second.webm');
});

test('fail_request only toggles an API path a change declared', async (t) => {
  const bridge = bridgeFixture(t);
  const refused = await bridge.call('fail_request', { path: '/api/other', enabled: true });
  assert.equal(refused.value.code, 'undeclared_controlled_failure');
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')));

  const enabled = await bridge.call('fail_request', { path: '/api/lists/demo', enabled: true });
  assert.deepEqual(enabled, { isError: false, value: { ok: true, path: '/api/lists/demo', enabled: true, hitCount: 0 } });
  const control = bridge.calls.at(-1);
  assert.equal(control.origin, 'http://127.0.0.1:17891');
  assert.equal(control.path, '/__usernode_shots_control/request-failure');
  assert.equal(control.headers['x-shots-control-token'], 'c'.repeat(64));
  assert.deepEqual(JSON.parse(control.body), { path: '/api/lists/demo', enabled: true });
});

// reloop PR 12's loading and error states and smart-cashier PR 2's skeleton
// went unshot (2026-10-09 to 10-12): no change declared the request, so the
// agent could not hold or fail it.
test('control_request holds or fails one exact API GET for a change, recorded before the proxy is told', async (t) => {
  const bridge = bridgeFixture(t);
  for (const [args, code] of [
    [{ change: 'invite-suggestions', path: 'http://head.example.invalid/api/items', mode: 'hold' }, 'invalid_request_path'],
    [{ change: 'invite-suggestions', path: '/api/items/*', mode: 'hold' }, 'invalid_request_path'],
    [{ change: 'invite-suggestions', path: '/lists/demo', mode: 'fail' }, 'invalid_request_path'],
    [{ change: 'invite-suggestions', path: '/api/items#top', mode: 'fail' }, 'invalid_request_path'],
    [{ change: 'someone-elses-change', path: '/api/items', mode: 'hold' }, 'unknown_change'],
  ]) {
    const refused = await bridge.call('control_request', args);
    assert.deepEqual([refused.isError, refused.value.code], [true, code], JSON.stringify(args));
  }
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')), 'nothing recorded, nothing told');

  const held = await bridge.call('control_request', { change: 'invite-suggestions', path: '/api/items?page=1', mode: 'hold' });
  assert.deepEqual(held, { isError: false, value: {
    ok: true, change: 'invite-suggestions', path: '/api/items?page=1', mode: 'hold', hitCount: 0,
  } });
  const [record, told] = bridge.calls.slice(-2);
  assert.equal(record.path, `/api/internal/shots/${bridge.runId}/condition`);
  assert.equal(record.headers.authorization, 'Bearer run-scoped-jwt');
  assert.deepEqual(JSON.parse(record.body), { change: 'invite-suggestions', kind: 'request_held', request: '/api/items?page=1' });
  assert.equal(told.origin, 'http://127.0.0.1:17891');
  assert.equal(told.path, '/__usernode_shots_control/request-failure');
  assert.equal(told.headers['x-shots-control-token'], 'c'.repeat(64));
  assert.deepEqual(JSON.parse(told.body), { path: '/api/items?page=1', mode: 'hold' });

  await bridge.call('control_request', { change: 'saved-toast', path: '/api/items', mode: 'fail' });
  assert.deepEqual(JSON.parse(bridge.calls.at(-2).body), { change: 'saved-toast', kind: 'request_failed', request: '/api/items' });
  // A change's own declared failure already says so in its steps, and "off"
  // does nothing to anyone: neither is recorded.
  for (const args of [
    { change: 'load-error', path: '/api/lists/demo', mode: 'fail' },
    { change: 'invite-suggestions', path: '/api/items?page=1', mode: 'off' },
  ]) {
    const before = bridge.calls.length;
    assert.equal((await bridge.call('control_request', args)).isError, false);
    assert.deepEqual(bridge.calls.slice(before).map((sent) => sent.path),
      [`/api/internal/shots/${bridge.runId}/context`, '/__usernode_shots_control/request-failure']);
    assert.deepEqual(JSON.parse(bridge.calls.at(-1).body), { path: args.path, mode: args.mode });
  }

  // A recording the platform refuses stops it before the proxy is told.
  const told2 = [];
  const refusing = loadBridge(bridge.env, async (url, init = {}) => {
    const parsed = new URL(url);
    told2.push(parsed.pathname);
    const payload = parsed.pathname.endsWith('/context') ? { ok: true, context: (await (await bridge.platformFetch(url)).json()).context }
      : { ok: false, code: 'invalid_condition', message: 'No.' };
    return new Response(JSON.stringify(payload), { status: payload.ok ? 200 : 400 });
  });
  const result = await refusing.tools.get('control_request')({ change: 'invite-suggestions', path: '/api/items', mode: 'hold' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'invalid_condition');
  assert.ok(!told2.includes('/__usernode_shots_control/request-failure'));
});

// pixora PR 3 (2026-10-10) went unshot: "no file-upload tool".
test('upload_file has the browser\'s observer choose sample files, recorded first, and takes no path', async (t) => {
  const bridge = bridgeFixture(t);
  const args = { change: 'invite-suggestions', browser: 'browser_member', files: ['landscape.png'] };
  assert.equal((await bridge.call('upload_file', args)).value.code, 'upload_unavailable', 'a turn without the control');

  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-ctl-'));
  const received = [];
  let reply = { ok: true, outcome: 'ok', text: '### Page state\n- Page URL: http://head.example.invalid/upload' };
  const observer = require('node:net').createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      received.push(JSON.parse(data));
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => observer.listen(path.join(ctl, 'member.sock'), resolve));
  t.after(() => { observer.close(); fs.rmSync(ctl, { recursive: true, force: true }); });
  const { tools } = loadBridge({ ...bridge.env, SHOTS_BROWSER_CONTROL_DIR: ctl, SHOTS_BROWSER_CONTROL_TOKEN: 'd'.repeat(64) },
    bridge.platformFetch);
  const upload = async (input) => {
    const result = await tools.get('upload_file')(input);
    return { isError: result.isError === true, content: result.content, value: JSON.parse(result.content[0].text) };
  };

  // Only sample names, each once, three at most, in a browser of the run.
  for (const files of [['../state/member.json'], ['landscape.png', 'landscape.png'],
    ['landscape.png', 'portrait.png', 'table.csv', 'document.pdf']]) {
    assert.equal((await upload({ ...args, files })).value.code, 'invalid_sample_files', JSON.stringify(files));
  }
  assert.equal((await upload({ ...args, browser: 'browser_other' })).value.code, 'unknown_browser');
  assert.equal((await upload({ ...args, change: 'someone-elses-change' })).value.code, 'unknown_change');
  assert.equal(received.length, 0);
  assert.ok(bridge.calls.every((sent) => sent.path.endsWith('/context')));

  const done = await upload(args);
  assert.equal(done.isError, false);
  assert.deepEqual(done.value, { ok: true, change: 'invite-suggestions', browser: 'browser_member', uploaded: ['landscape.png'] });
  assert.equal(done.content[1].text, reply.text, 'the browser\'s own answer follows, as after a click');
  assert.deepEqual(JSON.parse(bridge.calls.at(-1).body), { change: 'invite-suggestions', kind: 'sample_file', files: ['landscape.png'] });
  assert.equal(bridge.calls.at(-1).path, `/api/internal/shots/${bridge.runId}/condition`);
  assert.deepEqual(received, [{ action: 'upload', files: ['landscape.png'], token: 'd'.repeat(64) }]);

  // An empty list closes the chooser and records nothing.
  const recorded = bridge.calls.filter((sent) => sent.path.endsWith('/condition')).length;
  assert.equal((await upload({ ...args, files: [] })).isError, false);
  assert.equal(bridge.calls.filter((sent) => sent.path.endsWith('/condition')).length, recorded);
  assert.deepEqual(received.at(-1).files, []);

  // No chooser open: the agent is told what to do first.
  reply = { ok: false, outcome: 'tool_error',
    text: 'Error: The tool "browser_file_upload" can only be used when there is related modal state present.' };
  const closed = await upload(args);
  assert.equal(closed.isError, true);
  assert.match(closed.value.message, /^No file chooser is open in browser_member\. Click the page's upload control first/);
  // A browser this turn does not run.
  assert.equal((await upload({ ...args, browser: 'browser_admin_phone' })).value.code, 'browser_unavailable');

  const tool = /registerTool\('upload_file', \{[\s\S]*?\n\}, async/.exec(read('shots-mcp.js'))[0];
  assert.match(tool, /which you do not have/);
  assert.match(tool, /files: z\.array\(z\.enum\(samples\.SAMPLE_NAMES\)\)\.max\(samples\.MAX_FILES\)/);
  assert.match(tool, /browser: z\.enum\(BROWSER_SERVERS\)/);
});

test('the sample files are drawn into the image, and only the runner\'s own processes reach a browser\'s control', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile,
    /COPY shots-samples\.js \/usr\/local\/bin\/shots-samples\.js\nRUN node \/usr\/local\/bin\/shots-samples\.js \/usr\/local\/share\/usernode\/shots-samples\n/);
  // As root, before the image switches to the node user: read-only to the turn.
  assert.ok(dockerfile.indexOf('RUN node /usr/local/bin/shots-samples.js') < dockerfile.lastIndexOf('\nUSER node\n'));
  assert.equal(require('../worker/shots-samples').SAMPLES_DIR, '/usr/local/share/usernode/shots-samples');
  const runner = read('run-cc.sh');
  assert.match(runner, /export SHOTS_BROWSER_CONTROL_DIR="\$SHOTS_TMP\/ctl"\n/);
  assert.match(runner,
    /export SHOTS_BROWSER_CONTROL_TOKEN=\$\(node -e "process\.stdout\.write\(require\('crypto'\)\.randomBytes\(32\)\.toString\('hex'\)\)"\)\n/);
  assert.match(runner, /mkdir -m 700 "\$SHOTS_BROWSER_CONTROL_DIR" \|\| die/);
  assert.ok(runner.indexOf('export SHOTS_BROWSER_CONTROL_DIR=') < runner.indexOf('node /usr/local/bin/write-shots-mcp-config.js'),
    'before the browsers start');
  for (const file of ['shots-browser-observer.js', 'shots-mcp.js']) {
    assert.match(read(file), /require\('\.\/shots-samples'\)/, file);
  }
  // The dry run's copy of the bridge loads them from the repository.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shots-dry-run.js'), 'utf8'),
    /\.replace\("require\('\.\/shots-samples'\)",/);
});

test('a shots turn samples the worker\'s memory through the proxy, which the image carries', () => {
  // The image copies the sampler beside the proxy that loads it.
  assert.match(read('Dockerfile'), /COPY shots-memory\.js \/usr\/local\/bin\/shots-memory\.js/);
  assert.match(read('shots-origin-proxy.js'), /require\('\.\/shots-memory'\)/);
  // The runner asks for a sample every five seconds, before the proxy starts.
  const runner = read('run-cc.sh');
  const asked = runner.indexOf('export SHOTS_MEMORY_SAMPLE_MS=5000');
  assert.ok(asked > 0, 'the runner sets the interval');
  assert.ok(asked < runner.indexOf('node /usr/local/bin/shots-origin-proxy.js &'), 'before the proxy starts');
});

test('in a run taken at device density each saved still says its density: 3 from a phone browser and from a desktop one', async (t) => {
  for (const [density, expected] of [['1', { desktop: '3', phone: '3' }], [undefined, { desktop: undefined, phone: undefined }]]) {
    const bridge = bridgeFixture(t);
    const env = { ...bridge.env, ...(density ? { SHOTS_DEVICE_DENSITY: density } : {}) };
    const { tools } = loadBridge(env, bridge.platformFetch);
    const phoneDir = path.join(bridge.shotsDir, 'member_phone');
    fs.mkdirSync(phoneDir);
    fs.writeFileSync(path.join(bridge.shotsDir, 'member', 'wide.png'), 'desktop still');
    stamp(bridge, 'member', 'wide.png', `${HEAD}/`);
    fs.writeFileSync(path.join(phoneDir, 'narrow.png'), 'phone still');
    stamp(bridge, 'member_phone', 'narrow.png', `${HEAD}/`);
    const result = await tools.get('save_shot')({ shots: [
      { change: 'invite-suggestions', screen: 'desktop', side: 'after', file: 'wide.png' },
      { change: 'invite-suggestions', screen: 'phone', side: 'after', file: 'narrow.png' },
    ] });
    assert.equal(result.isError === true, false);
    const [wide, narrow] = uploads(bridge).slice(-2);
    assert.equal(wide.query.density, expected.desktop, `desktop, ${density}`);
    assert.equal(narrow.query.density, expected.phone, `phone, ${density}`);
  }
});

test('in a dense run, save_shot has the screen\'s browser take the close-ups wanted of the changes it saved', async (t) => {
  const bridge = bridgeFixture(t);
  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-ctl-'));
  const member = path.join(bridge.shotsDir, 'member');
  let stampAt = `${HEAD}/`;
  const asked = [];
  const observer = require('node:net').createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const message = JSON.parse(data);
      asked.push(message);
      const file = `closeup-${String(asked.length).padStart(16, '0')}.png`;
      fs.writeFileSync(path.join(member, file), `close-up ${asked.length}`);
      stamp(bridge, 'member', file, stampAt);
      socket.end(`${JSON.stringify({ ok: true, file })}\n`);
    });
  });
  await new Promise((resolve) => observer.listen(path.join(ctl, 'member.sock'), resolve));
  t.after(() => { observer.close(); fs.rmSync(ctl, { recursive: true, force: true }); });
  const wanted = [
    { change: 'invite-suggestions', screen: 'desktop', part: 1, rect: { x: 4, y: 4, w: 10, h: 10 }, scale: 6, saved: false },
    { change: 'invite-suggestions', screen: 'desktop', part: 2, rect: { x: 40, y: 4, w: 10, h: 10 }, scale: 5, saved: true },
    { change: 'admin-banner', screen: 'desktop', part: 1, rect: { x: 4, y: 4, w: 10, h: 10 }, scale: 6, saved: false },
  ];
  const platformFetch = async (url, init) => (new URL(url).pathname.endsWith('/closeups')
    ? (bridge.calls.push({ path: new URL(url).pathname }), new Response(JSON.stringify({ ok: true, result: { closeups: wanted } }), { status: 200 }))
    : bridge.platformFetch(url, init));
  const save = async (env) => {
    const { tools } = loadBridge({ ...bridge.env, SHOTS_BROWSER_CONTROL_DIR: ctl, SHOTS_BROWSER_CONTROL_TOKEN: 'd'.repeat(64), ...env },
      platformFetch);
    fs.writeFileSync(path.join(member, 'invite-desktop-after.png'), 'after still');
    stamp(bridge, 'member', 'invite-desktop-after.png', `${HEAD}/`);
    const result = await tools.get('save_shot')({ shots: [
      { change: 'invite-suggestions', screen: 'desktop', side: 'after', file: 'invite-desktop-after.png' },
    ] });
    return JSON.parse(result.content[0].text);
  };

  // A run not taken at device density asks for nothing.
  const plain = await save({});
  assert.equal(Object.hasOwn(plain, 'closeups'), false);
  assert.equal(bridge.calls.some((sent) => sent.path.endsWith('/closeups')), false);

  const dense = await save({ SHOTS_DEVICE_DENSITY: '1' });
  // Only the unsaved one of the change it saved, in that change's browser.
  assert.deepEqual(dense.closeups, [{ change: 'invite-suggestions', screen: 'desktop', part: 1, scale: 6, saved: true }]);
  assert.equal(Object.hasOwn(dense, 'closeupHint'), false);
  assert.deepEqual(asked.map(({ action, rect, scale }) => ({ action, rect, scale })),
    [{ action: 'closeup', rect: wanted[0].rect, scale: 6 }]);
  const upload = bridge.calls.at(-1);
  assert.equal(upload.path, `/api/internal/shots/${bridge.runId}/closeup`);
  assert.deepEqual(upload.query, { change: 'invite-suggestions', screen: 'desktop', part: '1' });
  assert.equal(Buffer.from(upload.body).toString(), 'close-up 1');

  // A close-up of the before address (the page moved on) is never sent, and the agent is told how to retake it.
  stampAt = `${BASE}/`;
  const moved = await save({ SHOTS_DEVICE_DENSITY: '1' });
  assert.deepEqual(moved.closeups, [{ change: 'invite-suggestions', screen: 'desktop', part: 1, scale: 6, saved: false, code: 'shot_not_on_app' }]);
  assert.match(moved.closeupHint, /Open its after state again, take the after screen shot again and save it/);
  assert.equal(bridge.calls.filter((sent) => sent.path.endsWith('/closeup')).length, 1, 'still only the first');
});

// #6787: a dark shot the agent took again by its own navigation was scrolled
// to another part of the page than its light one, so the card cropped the
// dark screen to the light one's outline and showed the wrong place. Now
// save_shot has the browser that took a light screen switch its page to dark
// where it stands, shoot it and switch it back (shots-browser-observer.js
// `dark`), and saves that as the screen's dark shot.
test('save_shot takes each light screen\'s dark shot where the page stands, and leaves the rest to the agent', async (t) => {
  const bridge = bridgeFixture(t, { darkMode: { param: 'theme', value: 'dark' } });
  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-ctl-'));
  const member = path.join(bridge.shotsDir, 'member');
  const asked = [];
  let answer = (n) => {
    const file = `dark-${String(n).padStart(16, '0')}.png`;
    fs.writeFileSync(path.join(member, file), `dark still ${n}`);
    stamp(bridge, 'member', file, `${HEAD}/`);
    return { ok: true, file, lightRestored: true };
  };
  const observer = require('node:net').createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      asked.push(JSON.parse(data));
      socket.end(`${JSON.stringify(answer(asked.length))}\n`);
    });
  });
  await new Promise((resolve) => observer.listen(path.join(ctl, 'member.sock'), resolve));
  t.after(() => { observer.close(); fs.rmSync(ctl, { recursive: true, force: true }); });
  let platformAnswer = (query) => ({ saved: true, change: query.change });
  const platformFetch = async (url, init) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/shot')) return bridge.platformFetch(url, init);
    bridge.calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init.body });
    return new Response(JSON.stringify({ ok: true, result: platformAnswer(Object.fromEntries(parsed.searchParams)) }),
      { status: 200 });
  };
  const { tools } = loadBridge({ ...bridge.env, SHOTS_BROWSER_CONTROL_DIR: ctl, SHOTS_BROWSER_CONTROL_TOKEN: 'd'.repeat(64) },
    platformFetch);
  const take = (name, when) => {
    fs.writeFileSync(path.join(member, name), name);
    stamp(bridge, 'member', name, `${HEAD}/`);
    fs.utimesSync(path.join(member, name), when, when);
  };
  const save = async (shots) => JSON.parse((await tools.get('save_shot')({ shots })).content[0].text);
  take('first-after.png', new Date(Date.now() - 60_000));
  take('second-after.png', new Date());
  const result = await save([
    { change: 'invite-suggestions', screen: 'desktop', side: 'after', file: 'first-after.png', showsPrivate: false },
    { change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'element', file: 'second-after.png' },
    { change: 'saved-toast', screen: 'desktop', side: 'after', file: 'second-after.png', showsPrivate: true },
    { change: 'admin-banner', screen: 'desktop', side: 'after', file: 'second-after.png' },
  ]);
  // One dark shot, of what the browser still shows: the screen it took last,
  // saved for each change that screen is saved for, with its privacy answer.
  assert.deepEqual(asked.map((message) => message.action), ['dark']);
  const darkUploads = uploads(bridge).filter((sent) => sent.query.theme === 'dark');
  assert.deepEqual(darkUploads.map((sent) => [sent.query.change, sent.query.kind, sent.query.showsPrivate]),
    [['saved-toast', 'screen', '1'], ['admin-banner', 'screen', undefined]]);
  assert.equal(Buffer.from(darkUploads[0].body).toString(), 'dark still 1');
  assert.deepEqual(result.dark, [
    { change: 'saved-toast', screen: 'desktop', side: 'after', saved: true },
    { change: 'admin-banner', screen: 'desktop', side: 'after', saved: true },
  ]);
  // The earlier screen is no longer on show: the agent takes its dark shot.
  assert.deepEqual(result.darkLeft, [{ change: 'invite-suggestions', screen: 'desktop', side: 'after' }]);
  assert.match(result.darkHint, /could not be taken where the page stands/);
  assert.ok(result.results.every((entry) => !Object.hasOwn(entry, 'showsPrivate')), 'the answer repeats no input');
  // The element shot listed before its screen shot went up after every
  // screen shot, so Homeroom checks it against the screen of its state; the
  // answer keeps the listed order.
  const lightUploads = uploads(bridge).filter((sent) => sent.query.theme !== 'dark');
  assert.deepEqual(lightUploads.map((sent) => sent.query.kind), ['screen', 'screen', 'screen', 'element']);
  assert.deepEqual(result.results.map((entry) => entry.kind), ['screen', 'element', 'screen', 'screen']);

  // A page that came out the same in dark does not follow the system's mode:
  // the rest of the turn's dark shots are the agent's, by the parameter.
  platformAnswer = (query) => (query.theme === 'dark' ? { saved: false, sameAsLight: true } : { saved: true });
  take('third-after.png', new Date());
  const same = await save([{ change: 'invite-suggestions', screen: 'desktop', side: 'after', file: 'third-after.png' }]);
  assert.deepEqual(same.dark, [{ change: 'invite-suggestions', screen: 'desktop', side: 'after', saved: false, sameAsLight: true }]);
  assert.match(same.darkHint, /did not change when its page was switched to dark where it stands/);
  take('fourth-after.png', new Date());
  const after = await save([{ change: 'saved-toast', screen: 'desktop', side: 'after', file: 'fourth-after.png' }]);
  assert.equal(asked.length, 2, 'no more dark shots are asked of the browser');
  assert.deepEqual(after.darkLeft, [{ change: 'saved-toast', screen: 'desktop', side: 'after' }]);

});

test('the browser observer takes a dark shot where the page stands and always switches it back', async () => {
  const observer = read('shots-browser-observer.js');
  const branch = /if \(message\.action === 'dark'\) \{[\s\S]*?\n    \}\n    if \(message\.action !== 'upload'\)/.exec(observer)[0];
  assert.match(branch, /parker\.inject\('browser_emulate_media', \{ colorScheme: 'dark' \}\)/);
  assert.match(branch, /parker\.inject\('browser_take_screenshot', \{ filename: file \}\)/);
  assert.match(branch, /\} finally \{\s+restored = await parker\.inject\('browser_emulate_media', \{ colorScheme: 'light' \}\);/);
  assert.match(branch, /onCloseup\?\.\(file\)/, 'stamped with the page it shows, as a close-up is');
  assert.match(branch, /const file = `dark-\$\{crypto\.randomBytes\(8\)\.toString\('hex'\)\}\.png`/);
});
