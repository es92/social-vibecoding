'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDir = path.join(__dirname, '..', 'worker');
const read = (name) => fs.readFileSync(path.join(workerDir, name), 'utf8');
const { browserAllowedOrigins, hostedAppSlugs, trustedHostedAppOrigins } = require('../worker/evidence-hosted-origins');
const hostedContract = require('../worker/evidence-hosted-app-contract');

test('only the platform-owned hosted app for this exact run enters the evidence catalog', () => {
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

test('planner origin list rejects stale or malformed hosted-app catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-origins-test-'));
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

test('both evidence backends launch Playwright through the content-free timing observer', () => {
  const dockerfile = read('Dockerfile');
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');
  const evidenceMcp = read('evidence-mcp.js');
  const command = 'node';

  assert.match(dockerfile, /npm install -g @playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.match(dockerfile, /command -v mcp-server-playwright/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-evidence-browser-mcp\.js/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-evidence-browser-auth\.js/);
  assert.match(claudeRunner, /command -v mcp-server-playwright[^\n]*\n\s*\|\| die/);
  assert.match(codexRunner, /command -v mcp-server-playwright[^\n]*\n\s*\|\| die/);
  assert.match(dockerfile, /COPY evidence-browser-observer\.js \/usr\/local\/bin\/evidence-browser-observer\.js/);
  assert.ok((codexRunner.match(/command = "node"/g) || []).length >= 2);
  assert.equal((codexRunner.match(/evidence-browser-observer\.js/g) || []).length, 3);
  assert.match(claudeRunner, /EVIDENCE_BROWSER_DIAGNOSTIC_FILE/);
  assert.match(codexRunner, /EVIDENCE_BROWSER_DIAGNOSTIC_FILE/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-config-test-'));
  try {
    const output = path.join(dir, 'mcp.json');
    const hostedFile = path.join(dir, 'hosted-origins.json');
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid',
      headOrigin: 'http://head.example.invalid',
      apps: [{ origin: 'https://hosted.example.invalid', slug: 'hosted-app' }],
    }));
    execFileSync(process.execPath, [path.join(workerDir, 'write-evidence-mcp-config.js'), output], {
      env: {
        ...process.env,
        EVIDENCE_BROWSER_STATE_DIR: path.join(dir, 'state'),
        EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
        EVIDENCE_BASE_ORIGIN: 'http://base.example.invalid',
        EVIDENCE_HEAD_ORIGIN: 'http://head.example.invalid',
        EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
      },
    });
    const config = JSON.parse(fs.readFileSync(output, 'utf8'));
    for (const [server, state] of [
      ['browser_member', 'member.json'],
      ['browser_admin', 'read_only_admin.json'],
      ['browser_full_admin', 'full_admin.json'],
    ]) {
      assert.equal(config.mcpServers[server].command, command);
      assert.equal(config.mcpServers[server].args[0], '/usr/local/bin/evidence-browser-observer.js');
      assert.ok(config.mcpServers[server].args.includes(path.join(dir, 'state', state)));
      assert.ok(config.mcpServers[server].args.includes('http://base.example.invalid;http://head.example.invalid;https://hosted.example.invalid'));
      assert.ok(config.mcpServers[server].args.includes('--no-sandbox'));
      assert.ok(config.mcpServers[server].args.includes('--caps'));
      assert.ok(config.mcpServers[server].args.includes('vision'));
    }
    assert.equal((codexRunner.match(/"--no-sandbox"/g) || []).length, 4);
    assert.match(read('worker-run.sh'), /"--browser", "chromium", "--headless", "--isolated", "--no-sandbox"/);
    assert.match(claudeRunner, /EVIDENCE_HOSTED_ORIGINS_FILE/);
    assert.match(codexRunner, /EVIDENCE_HOSTED_ORIGINS_FILE/);
    assert.match(codexRunner, /env_vars = \[[^\n]*"EVIDENCE_HOSTED_ORIGINS_FILE"/);
    assert.match(codexRunner, /evidence-hosted-origins\.js/);
    assert.doesNotMatch(codexRunner, /enabled_tools = \[[^\n]*"evidence_reset_pair"/);
    assert.doesNotMatch(codexRunner, /enabled_tools = \[[^\n]*"evidence_reset_side"/);
    assert.doesNotMatch(evidenceMcp, /registerTool\('evidence_reset_pair'/);
    assert.doesNotMatch(evidenceMcp, /request\('\/reset-pair'/);
    assert.doesNotMatch(evidenceMcp, /registerTool\('evidence_reset_side'/);
    assert.match(evidenceMcp, /registerTool\('evidence_report_blocker'/);
    assert.match(evidenceMcp, /status: 'failed', reason/);
    assert.match(codexRunner,
      /enabled_tools = \["evidence_run_plan", "evidence_report_blocker"\]/);
    assert.match(codexRunner,
      /EVIDENCE_COMPLETION_REMINDER" != "1"/);
    assert.equal((codexRunner.match(/"browser_mouse_move_xy"/g) || []).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture mode saves each persona\'s named screenshots where only the evidence bridge reads them', () => {
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');
  const evidenceMcp = read('evidence-mcp.js');
  for (const runner of [claudeRunner, codexRunner]) {
    assert.match(runner, /if \[ "\$\{EVIDENCE_MODE:-\}" = "capture" \]; then\n\s*export EVIDENCE_SHOTS_DIR="\$EVIDENCE_TMP\/shots"/);
    assert.match(runner, /mkdir -p "\$EVIDENCE_SHOTS_DIR\/member" "\$EVIDENCE_SHOTS_DIR\/admin" "\$EVIDENCE_SHOTS_DIR\/full_admin"/);
  }
  assert.match(codexRunner, /\[mcp_servers\.evidence\][\s\S]*?env_vars = \[[^\n]*"EVIDENCE_MODE", "EVIDENCE_SHOTS_DIR"\]/);
  assert.match(codexRunner, /enabled_tools = \["evidence_get_context", "evidence_set_request_failure", "evidence_run_plan", "evidence_capture", "evidence_report_blocker"\]/);
  assert.equal((codexRunner.match(/"--timeout-navigation", "30000"%s\]\\n'/g) || []).length, 3);
  for (const variable of ['SHOTS_MEMBER', 'SHOTS_ADMIN', 'SHOTS_FULL_ADMIN']) {
    assert.match(codexRunner, new RegExp(`"\\$ESCAPED_PROXY" "\\$${variable}"`));
  }

  // The bridge offers the capture tool only in capture mode, and the replay
  // tool only outside it, so one turn never sees both contracts.
  assert.match(evidenceMcp, /const captureMode = process\.env\.EVIDENCE_MODE === 'capture';/);
  assert.match(evidenceMcp, /if \(captureMode\) \{\n\s*server\.registerTool\('evidence_capture'/);
  assert.match(evidenceMcp, /if \(!captureMode\) server\.registerTool\('evidence_run_plan'/);
  // A filename is reduced to its basename and must be a plain .png inside a
  // persona's output directory; storage state is never reachable.
  assert.match(evidenceMcp, /const name = path\.basename\(String\(file \|\| ''\)\);/);
  assert.match(evidenceMcp, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,150\}\\\.png\$/);
  assert.match(evidenceMcp, /for \(const persona of \['member', 'admin', 'full_admin'\]\)/);
  assert.match(evidenceMcp, /fs\.lstatSync\(candidate\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-capture-config-'));
  try {
    const hostedFile = path.join(dir, 'hosted-origins.json');
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid', headOrigin: 'http://head.example.invalid', apps: [],
    }));
    const env = {
      ...process.env,
      EVIDENCE_BROWSER_STATE_DIR: path.join(dir, 'state'),
      EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
      EVIDENCE_BASE_ORIGIN: 'http://base.example.invalid',
      EVIDENCE_HEAD_ORIGIN: 'http://head.example.invalid',
      EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
    };
    const write = (extra) => {
      const output = path.join(dir, `mcp-${Object.keys(extra).length}.json`);
      execFileSync(process.execPath, [path.join(workerDir, 'write-evidence-mcp-config.js'), output], {
        env: { ...env, ...extra },
      });
      return JSON.parse(fs.readFileSync(output, 'utf8'));
    };
    const replay = write({ EVIDENCE_SHOTS_DIR: '' });
    for (const server of ['browser_member', 'browser_admin', 'browser_full_admin']) {
      assert.equal(replay.mcpServers[server].args.includes('--output-dir'), false);
    }
    const shots = path.join(dir, 'shots');
    const captureConfig = write({ EVIDENCE_SHOTS_DIR: shots, EVIDENCE_MODE: 'capture' });
    for (const [server, persona] of [
      ['browser_member', 'member'], ['browser_admin', 'admin'], ['browser_full_admin', 'full_admin'],
    ]) {
      const args = captureConfig.mcpServers[server].args;
      assert.equal(args[args.indexOf('--output-dir') + 1], path.join(shots, persona));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
