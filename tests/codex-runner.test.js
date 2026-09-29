'use strict';
// Runtime smoke test for worker/run-codex-agent.sh (review P5). Stubs a
// fake `codex` binary on PATH that emits authentic-shaped JSONL, runs the
// actual runner script, and asserts: prompt is read from the file (not a
// dead stdin), the thread id is extracted from thread.started and persists
// to the terminal result, and a fresh vs resume invocation are both correct.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { execFileSync, spawnSync, spawn } = require('child_process');
const { classifyResumeJsonl } = require('../worker/classify-codex-resume');
const {
  AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_BASE_INSTRUCTIONS,
  NEUTRAL_IDENTITY_INSTRUCTION,
  buildCatalogFromEnvironment,
  buildCodexModelCatalog,
  nameSelectedModel,
  neutralizeBundledBaseInstructions,
  MIN_MAX_OUTPUT_TOKENS,
  SAFE_MAX_OUTPUT_TOKENS,
} = require('../worker/build-codex-model-catalog');

const RUNNER = path.join(__dirname, '..', 'worker', 'run-codex-agent.sh');
const CLAUDE_RUNNER = path.join(__dirname, '..', 'worker', 'run-cc.sh');

test('worker runtime contract invalidates warm images from before the new runners', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'worker', 'Dockerfile'), 'utf8');
  const workerRun = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker-run.sh'), 'utf8');
  const workerHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');
  assert.match(dockerfile, /COPY classify-codex-resume\.js \/usr\/local\/bin\/classify-codex-resume\.js/);
  assert.match(dockerfile, /COPY build-codex-model-catalog\.js \/usr\/local\/bin\/build-codex-model-catalog\.js/);
  assert.match(dockerfile, /COPY codex-openrouter-request\.js \/usr\/local\/bin\/codex-openrouter-request\.js/);
  assert.match(dockerfile,
    /codex debug models --bundled > \/usr\/local\/share\/usernode-codex-bundled-models\.json/,
    'the image extracts only the pinned CLI catalog and never performs a build-time refresh');
  assert.match(dockerfile,
    /RUN install -d -m 700 \/var\/lib\/usernode-codex-bootstrap \\\n\s*&& CODEX_HOME=\/var\/lib\/usernode-codex-bootstrap \\\n\s*codex debug models --bundled/,
    'Codex receives an existing private home before the deterministic catalog export');
  assert.match(dockerfile,
    /Array\.isArray\(c\.models\).*base_instructions.*Codex model catalog has no base instructions/,
    'the image build validates the bundled catalog before accepting it');

  const match = workerHost.match(/const WORKER_BOOTSTRAP_ENV_VERSION = '(v\d+)'/);
  assert.ok(match, 'warm-worker contract version is declared');
  assert.ok(Number(match[1].slice(1)) >= 14,
    'pre-v14 containers omit output limits from OpenRouter requests and must be evicted');
  assert.match(workerHost,
    /labels\['usernode\.proxy'\] !== WORKER_BOOTSTRAP_ENV_VERSION/,
    'the warm path compares the persisted container contract label');
  const claudeRunner = fs.readFileSync(CLAUDE_RUNNER, 'utf8');
  assert.match(claudeRunner, /--append-system-prompt-file/,
    'the v7 runner consumes the system-prompt file required by the shortened build prompt');
  assert.match(workerRun, /rm -f \/home\/node\/\.claude\/codex-home\/config\.toml/,
    'a fixed bootstrap removes the v4-generated config from the persistent volume');
  assert.match(workerRun, /openrouter-model-catalog\.json/,
    'a fixed bootstrap removes stale per-model metadata from the persistent volume');
});

function makeEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-'));
  // fake codex on PATH
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'codex');
  fs.writeFileSync(fake, run);
  fs.chmodSync(fake, 0o755);
  // workspace + prompt
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'scout prompt');
  const invokeLog = path.join(dir, 'codex-invocations.log');
  const env = {
    INVOKE_LOG: invokeLog,
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt,
    BRANCH: 'smoke',
    MODE: 'scout',
    WORKER_JWT: 'jwt', SESSION_ID: '1', PLATFORM_URL: 'http://p',
    OPENROUTER_API_KEY: 'sk-or-v1-test', OPENROUTER_API_BASE: 'https://openrouter.ai/api/v1',
    AGENT_MODEL: 'openai/gpt-5.3-codex',
    AGENT_MODEL_NAME: 'GPT-5.3 Codex via OpenRouter',
    AGENT_MODEL_CONTEXT_WINDOW: '400000',
    AGENT_MODEL_MAX_OUTPUT_TOKENS: '128000',
    AGENT_MODEL_SUPPORTS_REASONING: '1',
    AGENT_MODEL_REASONING_EFFORTS: 'low,medium,high',
    AGENT_MODEL_SUPPORTS_TOOLS: '1',
    WORKSPACE_DIR: ws, CODEX_HOME: path.join(dir, 'codex-home'),
  };
  return { dir, env };
}

test('runner: fresh and resumed GLM invocations put catalog limits into actual HTTP requests', async t => {
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), key: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"mock-response"}');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  // Reproduce the pinned CLI's missing field at the HTTP boundary. This is
  // a fake executable, never a second agent or a request to a paid provider.
  const fakeCodex = `#!/usr/bin/env node
(async () => {
  for await (const chunk of process.stdin) { /* consume the prompt */ }
  const override = process.argv.find(a => a.startsWith('model_providers.usernode_openrouter.base_url='));
  if (!override) throw new Error('request adapter override missing');
  const base = JSON.parse(override.slice(override.indexOf('=') + 1));
  const response = await fetch(base + '/responses', {
    method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY },
    body: JSON.stringify({ model: process.env.AGENT_MODEL, input: [{ role: 'user', content: 'hello' }] }),
  });
  if (!response.ok) throw new Error(await response.text());
  await response.text();
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'mock-glm-thread' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }));
})().catch(err => { console.error(err.message); process.exitCode = 1; });
`;
  for (const [cap, thread] of [['128000', ''], ['12800', 'mock-glm-thread']]) {
    const { dir, env } = makeEnv(fakeCodex);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    env.OPENROUTER_API_BASE = `http://127.0.0.1:${provider.address().port}/api/v1`;
    env.AGENT_MODEL = 'z-ai/glm-5.3-flash';
    env.AGENT_MODEL_MAX_OUTPUT_TOKENS = cap;
    env.AGENT_THREAD_ID = thread;
    const result = await new Promise((resolve, reject) => {
      const child = spawn('sh', [RUNNER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
      t.after(() => { if (child.exitCode == null) child.kill(); });
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /agent_thread_id=mock-glm-thread/);
    assert.match(result.stdout, /"type":"usernode.openrouter.request"/);
    assert.match(result.stdout, /__USERNODE_CODING_PROVIDER__ \{"kind":"provider_request_start"/);
    assert.match(result.stdout, /__USERNODE_CODING_PROVIDER__ \{"kind":"provider_request_end"/);
    assert.doesNotMatch(result.stdout + result.stderr, /sk-or-v1-test/);
    const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(config.includes(env.OPENROUTER_API_BASE), 'the persistent config keeps the upstream URL');
    assert.ok(!config.includes(env.OPENROUTER_API_KEY), 'the key is never written to config');
  }
  assert.deepEqual(requests.map(r => r.body.max_output_tokens), [32000, 12800]);
  assert.ok(requests.every(r => r.body.model === 'z-ai/glm-5.3-flash'));
  assert.ok(requests.every(r => r.url === '/api/v1/responses'));
  assert.ok(requests.every(r => r.key === 'Bearer sk-or-v1-test'));
});

// The evidence turn's MCP servers, generated by the runner's own shell. The
// whole runner cannot start an evidence turn here: its origin proxy and
// browser bootstrap live at fixed image paths. So this runs the runner's
// exact config-writing branch, with only the hosted-origins helper pointed
// at the repository's copy of the same file.
function evidenceConfig(t, { recordClips }) {
  const source = fs.readFileSync(RUNNER, 'utf8');
  const escape = source.slice(source.indexOf('toml_escape() {'),
    source.indexOf('}\n', source.indexOf('toml_escape() {')) + 2);
  const branchStart = source.indexOf('elif [ "$MODE" = "evidence" ]; then\n');
  const branchEnd = source.indexOf('\n  fi\n  # #2779', branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart, 'the evidence config branch is found');
  const branch = source.slice(branchStart + 'elif [ "$MODE" = "evidence" ]; then\n'.length, branchEnd)
    .replace('/usr/local/bin/evidence-hosted-origins.js',
      path.join(__dirname, '..', 'worker', 'evidence-hosted-origins.js'));
  assert.ok(!branch.includes('/usr/local/bin/evidence-hosted-origins.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-evidence-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = 'http://base.example.invalid';
  const head = 'http://head.example.invalid';
  const hosted = path.join(dir, 'hosted-origins.json');
  fs.writeFileSync(hosted, JSON.stringify({ version: 2, baseOrigin: base, headOrigin: head, apps: [] }));
  const result = spawnSync('sh', ['-c', `die() { echo "__USERNODE_ERROR__ $*"; exit 1; }\n${escape}\n${branch}\n`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      EVIDENCE_BASE_ORIGIN: base, EVIDENCE_HEAD_ORIGIN: head,
      EVIDENCE_HOSTED_ORIGINS_FILE: hosted,
      EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
      EVIDENCE_BROWSER_STATE_DIR: path.join(dir, 'state'),
      EVIDENCE_SHOTS_DIR: path.join(dir, 'shots'),
      EVIDENCE_RECORD_CLIPS: recordClips,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { config: result.stdout, shots: path.join(dir, 'shots') };
}

test('runner: an evidence turn gets the shots bridge and a shots directory per browser', t => {
  const { config, shots } = evidenceConfig(t, { recordClips: '0' });
  assert.match(config, /\n\[mcp_servers\.shots\]\ncommand = "node"\nargs = \["\/usr\/local\/bin\/evidence-mcp\.js"\]\n/);
  assert.match(config,
    /\nenabled_tools = \["get_brief", "save_shot", "save_clip", "skip_change", "fail_request"\]\n/);
  const bridgeEnv = config.match(/\[mcp_servers\.shots\][\s\S]*?\nenv_vars = (\[[^\n]*\])/)[1];
  assert.deepEqual(JSON.parse(bridgeEnv), [
    'EVIDENCE_JWT', 'EVIDENCE_RUN_ID', 'PLATFORM_URL', 'EVIDENCE_PROXY_SERVER',
    'EVIDENCE_PROXY_CONTROL_TOKEN', 'EVIDENCE_HOSTED_ORIGINS_FILE', 'EVIDENCE_SHOTS_DIR',
  ], 'the bridge reads the shots directory and nothing names a capture mode');
  assert.doesNotMatch(config, /\[mcp_servers\.evidence\]|evidence_(?:get_context|run_plan|capture|finish|report_blocker)/);
  // Every persona's browser always saves into its own directory, whether or
  // not a clip is wanted, so a still is never lost for want of a flag.
  for (const [server, persona] of [['browser_member', 'member'], ['browser_admin', 'admin'],
    ['browser_full_admin', 'full_admin']]) {
    const args = JSON.parse(config.match(new RegExp(`\\[mcp_servers\\.${server}\\]\\ncommand = "node"\\nargs = (\\[[^\\n]*\\])`))[1]);
    const at = args.indexOf('--output-dir');
    assert.ok(at > 0, `${server} saves its shots`);
    assert.equal(args[at + 1], path.join(shots, persona));
    assert.ok(!args.some(arg => arg.startsWith('--save-video')), `${server} records no clip unless asked`);
  }
});

test('runner: a motion change records a clip in every persona\'s browser', t => {
  const { config, shots } = evidenceConfig(t, { recordClips: '1' });
  for (const [server, persona] of [['browser_member', 'member'], ['browser_admin', 'admin'],
    ['browser_full_admin', 'full_admin']]) {
    const args = JSON.parse(config.match(new RegExp(`\\[mcp_servers\\.${server}\\]\\ncommand = "node"\\nargs = (\\[[^\\n]*\\])`))[1]);
    assert.equal(args[args.indexOf('--output-dir') + 1], path.join(shots, persona));
    assert.equal(args.filter(arg => arg === '--save-video=1280x800').length, 1, `${server} records clips`);
  }
});

test('runner: evidence mode always boots its browsers and has no completion-reminder turn', () => {
  const source = fs.readFileSync(RUNNER, 'utf8');
  assert.doesNotMatch(source, /EVIDENCE_COMPLETION_REMINDER|EVIDENCE_MODE|tool_choice/);
  assert.match(source, /: "\$\{EVIDENCE_RECORD_CLIPS:=0\}"/, 'clips are off unless the dispatch asks');
  assert.match(source,
    /if \[ "\$MODE" = "evidence" \]; then\n\s+command -v mcp-server-playwright/,
    'the proxy and browser bootstrap run on every evidence turn');
  assert.match(source, /export EVIDENCE_SHOTS_DIR="\$EVIDENCE_TMP\/shots"/);
  assert.match(source,
    /mkdir -p "\$EVIDENCE_SHOTS_DIR\/member" "\$EVIDENCE_SHOTS_DIR\/admin" "\$EVIDENCE_SHOTS_DIR\/full_admin"/);
});

test('runner: an evidence turn refuses a clip flag that is not 0 or 1 before starting anything', () => {
  const { dir, env } = makeEnv('#!/bin/sh\necho "$*" >> "$INVOKE_LOG"\n');
  try {
    const systemPrompt = path.join(dir, 'system-prompt.txt');
    fs.writeFileSync(systemPrompt, 'Evidence system prompt');
    Object.assign(env, {
      MODE: 'evidence', SYSTEM_PROMPT_FILE: systemPrompt,
      EVIDENCE_JWT: 'test-evidence-jwt', EVIDENCE_RUN_ID: '1'.repeat(32),
      EVIDENCE_MEMBER_TOKEN: 'member-token', EVIDENCE_RECORD_CLIPS: 'yes',
    });
    const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /__USERNODE_ERROR__ EVIDENCE_RECORD_CLIPS must be 0 or 1/);
    assert.doesNotMatch(r.stdout, /__USERNODE_PHASE__ evidence_proxy/);
    assert.doesNotMatch(r.stdout + r.stderr, /member-token/);
    assert.equal(fs.existsSync(env.INVOKE_LOG), false, 'Codex never ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('request wrapper forwards Stop to Codex and releases its listener', async t => {
  const fakeCodex = `#!/usr/bin/env node
const override = process.argv.find(a => a.startsWith('model_providers.usernode_openrouter.base_url='));
const base = JSON.parse(override.slice(override.indexOf('=') + 1));
console.log(JSON.stringify({ type: 'test.ready', base }));
setInterval(() => {}, 1000);
`;
  const { dir, env } = makeEnv(fakeCodex);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(env.CODEX_HOME);
  fs.writeFileSync(path.join(env.CODEX_HOME, 'openrouter-model-catalog.json'), JSON.stringify(buildCatalogFromEnvironment(env)));
  const wrapper = path.join(__dirname, '..', 'worker', 'codex-openrouter-request.js');
  const child = spawn(process.execPath, [wrapper, 'exec', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const base = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error('wrapper exited before the fake Codex started')));
    require('node:readline').createInterface({ input: child.stdout }).on('line', line => {
      const event = JSON.parse(line);
      if (event.type === 'test.ready') resolve(event.base);
    });
  });
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  await new Promise((resolve, reject) => {
    const req = http.get(`${base}/responses`, () => reject(new Error('adapter listener survived Stop')));
    req.on('error', err => err.code === 'ECONNREFUSED' ? resolve() : reject(err));
  });
});

test('request wrapper preserves a killed Codex exit instead of reporting a user Stop', t => {
  const { dir, env } = makeEnv('#!/usr/bin/env node\nprocess.kill(process.pid, "SIGKILL");\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(env.CODEX_HOME);
  fs.writeFileSync(path.join(env.CODEX_HOME, 'openrouter-model-catalog.json'), JSON.stringify(buildCatalogFromEnvironment(env)));
  const wrapper = path.join(__dirname, '..', 'worker', 'codex-openrouter-request.js');
  const result = spawnSync(process.execPath, [wrapper, 'exec', '--json'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 137, result.stdout + result.stderr);
});

test('resume classifier accepts only an isolated structural missing-thread error', () => {
  assert.deepEqual(
    classifyResumeJsonl('{"type":"error","message":"thread not found"}\n'),
    { retryFresh: true, reason: 'thread_missing' },
  );
  assert.deepEqual(
    classifyResumeJsonl('{"type":"turn.failed","error":{"message":"local rollout unavailable"}}\n'),
    { retryFresh: true, reason: 'thread_missing' },
  );

  const commandOutputCollision = [
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'command_execution', aggregated_output: 'thread not found' },
    },
    { type: 'error', message: '401 Unauthorized' },
  ].map(JSON.stringify).join('\n');
  assert.equal(classifyResumeJsonl(commandOutputCollision).retryFresh, false);

  const alreadyResumed = [
    { type: 'thread.started', thread_id: 'existing-thread' },
    { type: 'error', message: 'session not found' },
  ].map(JSON.stringify).join('\n');
  assert.equal(classifyResumeJsonl(alreadyResumed).retryFresh, false);
  assert.equal(classifyResumeJsonl('fatal: thread not found\n').retryFresh, false,
    'unstructured stderr cannot authorize another paid request');
  const pinnedCliDiagnostic = [
    'WARNING: proceeding, even though we could not create PATH aliases: temporary test home',
    'Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)',
  ].join('\n');
  assert.equal(classifyResumeJsonl(pinnedCliDiagnostic).retryFresh, true,
    'the pinned pre-JSON local-rollout diagnostic remains recoverable');
  assert.equal(classifyResumeJsonl([
    '{"type":"error","message":"thread not found"}',
    'Error: 401 Unauthorized',
  ].join('\n')).retryFresh, false, 'a conflicting raw diagnostic fails closed');
});

test('runner: fresh scout turn reads prompt, extracts thread id, completes', () => {
  const fakeCodex = `#!/bin/sh
# Prove the prompt was delivered: fail if stdin is empty (review P4).
echo "$*" >> "$INVOKE_LOG"
INPUT=$(cat)
if [ -z "$INPUT" ]; then
  echo '{"type":"error","message":"No prompt provided via stdin"}'
  exit 1
fi
echo '{"type":"thread.started","thread_id":"smoke-123"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","message":"DONE"}}'
exit 0
`;
  const { env } = makeEnv(fakeCodex);
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex \(mode scout\)/, 'invokes fresh codex exec');
  assert.match(r.stdout, /"thread_id":"smoke-123"/, 'streams codex JSONL');
  assert.match(r.stdout, /agent_thread_id=smoke-123/, 'persists extracted thread id in result');
  assert.match(r.stdout, /mode=scout agent_backend=codex_openrouter/, 'terminal scout result');
  assert.match(
    fs.readFileSync(env.INVOKE_LOG, 'utf8').trim(),
    /^-c model_providers\.usernode_openrouter\.base_url="http:\/\/127\.0\.0\.1:\d+" exec --dangerously-bypass-approvals-and-sandbox - --json$/,
    'the externally-sandboxed worker bypasses Codex bwrap explicitly',
  );
});

test('runner: a scout that edits, creates or commits files leaves the tree as it found it (#2810)', () => {
  const fakeCodex = `#!/bin/sh
cat > /dev/null
echo "changed" > tracked.txt
echo "stray" > scout-notes.md
git add -A && git -c user.name=t -c user.email=t@t commit -qm "scout commit"
echo "uncommitted" > tracked.txt
echo '{"type":"thread.started","thread_id":"scout-ro"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","message":"## User-facing changes"}}'
exit 0
`;
  const { env } = makeEnv(fakeCodex);
  const git = (...args) => execFileSync('git', args, { cwd: env.WORKSPACE_DIR, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(env.WORKSPACE_DIR, 'tracked.txt'), 'original\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  // Untracked before the scout ran: not the scout's to remove.
  fs.writeFileSync(path.join(env.WORKSPACE_DIR, 'earlier.txt'), 'kept\n');

  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scout changed the repository; discarding its changes/);
  assert.match(r.stdout, /mode=scout agent_backend=codex_openrouter/, 'the scout still completes');
  assert.equal(git('rev-parse', 'HEAD').trim(), base, 'the scout commit is undone');
  assert.equal(fs.readFileSync(path.join(env.WORKSPACE_DIR, 'tracked.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(env.WORKSPACE_DIR, 'scout-notes.md')), false, 'a file the scout created is removed');
  assert.equal(fs.readFileSync(path.join(env.WORKSPACE_DIR, 'earlier.txt'), 'utf8'), 'kept\n');
});

test('runner: a read-only scout reports nothing to discard', () => {
  const fakeCodex = `#!/bin/sh
cat > /dev/null
echo '{"type":"thread.started","thread_id":"scout-clean"}'
exit 0
`;
  const { env } = makeEnv(fakeCodex);
  const git = (...args) => execFileSync('git', args, { cwd: env.WORKSPACE_DIR, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(env.WORKSPACE_DIR, 'tracked.txt'), 'original\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /scout changed the repository/);
});

test('runner: resume that fails NOT thread-missing does NOT retry fresh', () => {
  const fakeCodex = `#!/bin/sh
echo "$*" >> "$INVOKE_LOG"
while IFS= read -r _line; do :; done
echo '{"type":"error","message":"401 Unauthorized"}'
exit 1
`;
  const { env } = makeEnv(fakeCodex);
  env.AGENT_THREAD_ID = 'existing-thread';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  // Should NOT retry fresh, and should emit a terminal result.
  assert.match(r.stdout, /codex \(resume existing-thread/, 'invokes codex resume');
  assert.match(r.stdout, /NOT retrying fresh/, 'does NOT retry fresh on non-thread-missing failure');
  assert.match(r.stdout, /mode=scout agent_backend=codex_openrouter .* agent_thread_id=/, 'terminal result emitted');
  assert.match(
    fs.readFileSync(env.INVOKE_LOG, 'utf8').trim(),
    /^-c model_providers\.usernode_openrouter\.base_url="http:\/\/127\.0\.0\.1:\d+" exec resume --dangerously-bypass-approvals-and-sandbox existing-thread - --json$/,
  );
});

test('runner: resume that IS thread-missing asks the host for a fresh attempt', () => {
  const fakeCodex = `#!/bin/sh
echo "invocation" >> "$INVOKE_LOG"
INPUT=$(cat)
if [ -z "$INPUT" ]; then exit 1; fi
echo "Error: thread/resume: thread/resume failed: no rollout found for thread id $AGENT_THREAD_ID (code -32600)" >&2
exit 1
`;
  const { env } = makeEnv(fakeCodex);
  env.AGENT_THREAD_ID = 'missing-thread';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.match(r.stdout, /requesting fresh retry/, 'requests a host-managed fresh retry');
  assert.match(r.stdout, /agent_retry_fresh=1/, 'emits the structured retry signal');
  // One runner invocation must equal one physical Codex request. The host
  // creates attempt 2 (and its own ledger row) after parsing the signal.
  const invocations = fs.readFileSync(env.INVOKE_LOG, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(invocations.length, 1);
});

test('runner: missing-thread text in command output does not request a fresh attempt', () => {
  const fakeCodex = `#!/bin/sh
echo "invocation" >> "$INVOKE_LOG"
while IFS= read -r _line; do :; done
echo '{"type":"thread.started","thread_id":"existing-thread"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"thread not found"}}'
echo '{"type":"error","message":"401 Unauthorized"}'
exit 1
`;
  const { env } = makeEnv(fakeCodex);
  env.AGENT_THREAD_ID = 'existing-thread';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });

  assert.match(r.stdout, /NOT retrying fresh/);
  assert.doesNotMatch(r.stdout, /agent_retry_fresh=1/);
  const invocations = fs.readFileSync(env.INVOKE_LOG, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(invocations.length, 1);
});

test('runner: generated config is deterministic TOML and never expands the worker environment', () => {
  const fakeCodex = `#!/bin/sh
cat >/dev/null
exit 1
`;
  const { dir, env } = makeEnv(fakeCodex);
  env.MODE = 'build';
  env.AGENT_MODEL = 'z-ai/glm-5.3-flash';
  env.AGENT_MODEL_NAME = 'GLM 5.3 Flash';
  env.AGENT_MODEL_CONTEXT_WINDOW = '1048576';
  env.AGENT_REASONING_EFFORT = 'medium';
  env.CONFIG_INJECTION_SENTINEL = 'must-never-enter-codex-config';
  const bundledCatalogPath = path.join(dir, 'bundled-models.json');
  fs.writeFileSync(bundledCatalogPath, JSON.stringify({ models: [{
    slug: 'gpt-test',
    base_instructions: 'You are Codex, an agent based on GPT-5. Keep every repository tool instruction after the identity sentence.',
  }] }));
  env.CODEX_BUNDLED_MODELS_PATH = bundledCatalogPath;
  // Let build mode reach the shared config writer without needing a real
  // remote branch. Codex exits non-zero immediately afterward, before the
  // runner's commit/push block.
  const fakeGit = path.join(env.PATH.split(path.delimiter)[0], 'git');
  fs.writeFileSync(fakeGit, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeGit, 0o755);

  // A non-zero fake Codex keeps this focused on the real runner's
  // config-generation path; config generation is shared by scout/build.
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);

  const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  const catalogPath = path.join(env.CODEX_HOME, 'openrouter-model-catalog.json');
  assert.equal(config, [
    'model_provider = "usernode_openrouter"',
    'model = "z-ai/glm-5.3-flash"',
    `model_catalog_json = "${catalogPath}"`,
    'model_reasoning_effort = "medium"',
    '',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'apps = false',
    'plugins = false',
    '',
    '[shell_environment_policy]',
    'exclude = ["OPENROUTER_API_KEY"]',
    '',
    '[agents]',
    'enabled = false',
    '',
    '[model_providers.usernode_openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'env_key = "OPENROUTER_API_KEY"',
    // #2676: five silent stream retries turned one hard refusal into a
    // minute of identical "Reconnecting..." lines.
    'stream_max_retries = 3',
    'request_max_retries = 3',
    '',
    '[mcp_servers.playwright]',
    'command = "/usr/local/bin/mcp-server-playwright"',
    'args = ["--browser", "chromium", "--headless", "--isolated", "--no-sandbox", "--config", "/home/node/.usernode-playwright.json"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
    '',
    '[mcp_servers.visual_intent]',
    'command = "node"',
    'args = ["/usr/local/bin/build-evidence-mcp.js"]',
    'env_vars = ["WORKER_JWT", "SESSION_ID", "PLATFORM_URL"]',
    'enabled_tools = ["record_visual_evidence_intent"]',
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 30',
    '',
  ].join('\n'));
  assert.doesNotMatch(config, /CONFIG_INJECTION_SENTINEL|must-never-enter-codex-config/);
  assert.doesNotMatch(config, /(?:^|\n)(?:models|fallbacks)\s*=/m,
    'the direct OpenRouter config does not authorize model fallbacks');
  assert.doesNotMatch(config, /sk-or-v1-test/,
    'the provider credential is never persisted into the generated config');
  assert.equal(fs.statSync(path.join(env.CODEX_HOME, 'config.toml')).mode & 0o777, 0o600,
    'the generated config remains private to the worker user');

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].slug, 'z-ai/glm-5.3-flash');
  assert.equal(catalog.models[0].display_name, 'GLM 5.3 Flash');
  assert.equal(catalog.models[0].context_window, 1_048_576);
  assert.equal(catalog.models[0].auto_compact_token_limit, AUTO_COMPACT_TOKEN_LIMIT,
    'the installed metadata turns auto-compaction on');
  assert.equal(catalog.models[0].default_reasoning_level, 'medium');
  // #2120: the installed metadata names the selected model in the neutral
  // identity sentence and keeps every instruction after it.
  assert.equal(catalog.models[0].base_instructions,
    "You are Homeroom's repository coding agent, running on GLM 5.3 Flash (z-ai/glm-5.3-flash) "
    + 'through OpenRouter. Keep every repository tool instruction after the identity sentence.');
  assert.doesNotMatch(catalog.models[0].base_instructions, /\bGPT(?:[-\w.]*)?\b/i);
  assert.doesNotMatch(JSON.stringify(catalog), /CONFIG_INJECTION_SENTINEL|sk-or-v1-test/);
  assert.equal(fs.statSync(catalogPath).mode & 0o777, 0o600,
    'the generated model catalog remains private to the worker user');
});

test('OpenRouter model catalog removes only the bundled GPT identity sentence', () => {
  const bundled = [
    'You are Codex, an agent based on GPT-5.3-Codex.',
    'You and the user share one workspace. Keep the complete tool policy.',
  ].join(' ');
  assert.equal(
    neutralizeBundledBaseInstructions(bundled),
    `${NEUTRAL_IDENTITY_INSTRUCTION} You and the user share one workspace. Keep the complete tool policy.`,
  );

  const custom = 'You are a repository agent supplied by another runtime. Keep this exact policy.';
  assert.equal(neutralizeBundledBaseInstructions(custom), custom,
    'future non-Codex base prompts remain untouched');
});

test('OpenRouter model catalog neutralizes every identity phrasing the pinned CLI ships (#2120)', () => {
  // `codex debug models --bundled` at 0.146.0 leads its entries with one of
  // these three sentences. The builder copies the first entry, so a Codex
  // upgrade that reorders the catalog must not bring GPT back.
  const tail = ' You and the user share one workspace. Keep the complete tool policy.';
  for (const opening of [
    'You are Codex, an agent based on GPT-5.',
    'You are Codex, a coding agent based on GPT-5.',
    'You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.',
  ]) {
    assert.equal(neutralizeBundledBaseInstructions(`${opening}${tail}`),
      `${NEUTRAL_IDENTITY_INSTRUCTION}${tail}`, opening);
  }
  // Case, leading markdown and a dotted version do not defeat the match, and
  // the whitespace after the sentence is kept as shipped.
  assert.equal(
    neutralizeBundledBaseInstructions('\n\n**you are codex, an agent based on gpt-5.6.** Rest.'),
    `**${NEUTRAL_IDENTITY_INSTRUCTION}** Rest.`);
  assert.equal(
    neutralizeBundledBaseInstructions('# You are Codex, a coding agent based on GPT-5.\n\n# General\nAs an expert.'),
    `# ${NEUTRAL_IDENTITY_INSTRUCTION}\n\n# General\nAs an expert.`);
});

test('model catalog names the selected model in the identity sentence (#2120)', () => {
  const selected = { modelId: 'z-ai/glm-5.3-flash', displayName: 'Z.AI: GLM 5.3 Flash' };
  const named = "You are Homeroom's repository coding agent, running on Z.AI: GLM 5.3 Flash "
    + '(z-ai/glm-5.3-flash) through OpenRouter.';
  const tail = ' You and the user share one workspace. Keep the complete tool policy.';
  // The neutral sentence neutralize() leaves in front becomes the
  // model-naming form, and so does a bundled GPT sentence that reaches it
  // unneutralized; the text after it is byte-identical.
  assert.equal(nameSelectedModel(`${NEUTRAL_IDENTITY_INSTRUCTION}${tail}`, selected), `${named}${tail}`);
  assert.equal(nameSelectedModel(`You are Codex, an agent based on GPT-5.${tail}`, selected), `${named}${tail}`);
  assert.equal(nameSelectedModel(`You are Codex, a coding agent based on GPT-5.${tail}`, selected), `${named}${tail}`);
  assert.equal(
    nameSelectedModel(`You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.${tail}`, selected),
    `${named}${tail}`);
  // Leading whitespace/markdown and case survive around the replaced sentence.
  assert.equal(
    nameSelectedModel(`\n\n**${NEUTRAL_IDENTITY_INSTRUCTION.toUpperCase()}** Rest.`, selected),
    `\n\n**${named}** Rest.`);
  // The slug alone when the display name is missing or is the slug (any
  // case); a catalog display name is collapsed to one line and capped at 120
  // characters before it enters the prompt.
  const slugOnly = "You are Homeroom's repository coding agent, running on a/b through OpenRouter.";
  assert.equal(nameSelectedModel(NEUTRAL_IDENTITY_INSTRUCTION, { modelId: 'a/b' }), slugOnly);
  assert.equal(nameSelectedModel(NEUTRAL_IDENTITY_INSTRUCTION, { modelId: 'a/b', displayName: 'A/B' }), slugOnly);
  assert.equal(
    nameSelectedModel(NEUTRAL_IDENTITY_INSTRUCTION, { modelId: 'a/b', displayName: 'Name\nWith   newline' }),
    "You are Homeroom's repository coding agent, running on Name With newline (a/b) through OpenRouter.");
  assert.equal(
    nameSelectedModel(NEUTRAL_IDENTITY_INSTRUCTION, { modelId: 'a/b', displayName: 'x'.repeat(200) }),
    `You are Homeroom's repository coding agent, running on ${'x'.repeat(120)} (a/b) through OpenRouter.`);
  // Without any identity sentence the line is prepended, so the model is
  // never left without one.
  assert.equal(nameSelectedModel('Work carefully.\n\nRun the tests.', selected),
    `${named}\n\nWork carefully.\n\nRun the tests.`);

  // buildCodexModelCatalog applies it after neutralize(): the neutral
  // default and a bundled prompt loaded the way the runner loads it both
  // come out naming the model. The constants themselves stay neutral.
  assert.equal(
    buildCodexModelCatalog({ modelId: 'z-ai/glm-5.3-flash', displayName: 'Z.AI: GLM 5.3 Flash' })
      .models[0].base_instructions,
    `${named}${DEFAULT_BASE_INSTRUCTIONS.slice(NEUTRAL_IDENTITY_INSTRUCTION.length)}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-2120-'));
  const bundledCatalogPath = path.join(dir, 'bundled-models.json');
  fs.writeFileSync(bundledCatalogPath, JSON.stringify({ models: [{
    slug: 'gpt-5.6-sol',
    base_instructions: `You are Codex, an agent based on GPT-5.${tail}`,
  }] }));
  const fromEnvironment = buildCatalogFromEnvironment({
    CODEX_BUNDLED_MODELS_PATH: bundledCatalogPath,
    AGENT_MODEL: 'z-ai/glm-5.3-flash',
    AGENT_MODEL_NAME: 'Z.AI: GLM 5.3 Flash',
  });
  assert.equal(fromEnvironment.models[0].base_instructions, `${named}${tail}`);
  assert.doesNotMatch(fromEnvironment.models[0].base_instructions, /\bGPT(?:[-\w.]*)?\b/i);
  assert.equal(NEUTRAL_IDENTITY_INSTRUCTION, "You are Homeroom's repository coding agent.");
  assert.ok(DEFAULT_BASE_INSTRUCTIONS.startsWith(NEUTRAL_IDENTITY_INSTRUCTION));
  assert.doesNotMatch(DEFAULT_BASE_INSTRUCTIONS, /OpenRouter|GPT/);
});

test('model catalog omits reasoning levels for a non-reasoning OpenRouter model', () => {
  const catalog = buildCodexModelCatalog({
    modelId: 'vendor/plain-tools-model',
    displayName: 'Plain Tools Model',
    contextWindow: 64_000,
    supportsReasoning: false,
    reasoningEfforts: ['high'],
    selectedReasoningEffort: 'high',
    baseInstructions: 'Test coding instructions',
  });
  assert.equal(catalog.models[0].default_reasoning_level, null);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, []);
  assert.equal(catalog.models[0].context_window, 64_000);
});

test('runner: exact OpenRouter key is redacted before streamed JSONL', () => {
  const fakeCodex = `#!/bin/sh
while IFS= read -r _line; do :; done
echo 'Reading additional input from stdin...' >&2
echo '2026-08-10T00:00:00Z  WARN codex_core::responses_retry: internal retry detail' >&2
echo "{\"type\":\"thread.started\",\"thread_id\":\"redact-123\"}"
echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"$OPENROUTER_API_KEY\"}}"
exit 0
`;
  const { env } = makeEnv(fakeCodex);
  env.OPENROUTER_API_KEY = 'sk-or-v1-literal.with+regex[chars]';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /sk-or-v1-literal/, 'raw key never reaches stdout/journal stream');
  assert.doesNotMatch(r.stdout, /Reading additional input|codex_core::responses_retry/,
    'duplicate Codex implementation logs stay out of the user transcript');
  assert.match(r.stdout, /aggregated_output.*\*\*\*\*/, 'JSONL remains usable with a redaction marker');
  const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(config, /\[shell_environment_policy\][\s\S]*exclude = \["OPENROUTER_API_KEY"\]/,
    'model-launched commands do not inherit the provider credential');
});

test('runner: the redacted stream stays live after a very long line', {
  skip: spawnSync('sh', ['-c', 'command -v mawk'], { encoding: 'utf8' }).status !== 0
    && 'mawk (the worker image awk) is not installed',
}, async t => {
  // Session 4868: a 165,640-byte esbuild output line grew mawk's input buffer,
  // and the journal then advanced only in ~166 KB bursts, minutes apart.
  const fakeCodex = `#!/bin/sh
while IFS= read -r _line; do :; done
echo '{"type":"thread.started","thread_id":"stream-123"}'
printf '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"'
head -c 200000 /dev/zero | tr '\\0' x
echo '"}}'
echo '{"type":"item.started","item":{"id":"after-long-line"}}'
while [ ! -f "$RELEASE_FILE" ]; do sleep 0.05; done
exit 0
`;
  const { dir, env } = makeEnv(fakeCodex);
  // Run under mawk as the image does, whatever this host's default awk is.
  const mawk = spawnSync('sh', ['-c', 'command -v mawk'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(mawk, path.join(dir, 'bin', 'awk'));
  env.RELEASE_FILE = path.join(dir, 'release');
  const child = spawn('sh', [RUNNER], { env });
  t.after(() => { fs.writeFileSync(env.RELEASE_FILE, ''); child.kill(); });
  let out = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const streamed = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('after-long-line')) { clearTimeout(timer); resolve(true); }
    });
  });
  fs.writeFileSync(env.RELEASE_FILE, '');
  assert.equal(await closed, 0);
  assert.ok(streamed, 'the line after the long one reached the journal while Codex was still running');
});

test('Claude runner: scout succeeds without WORKER_JWT, while build still requires it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runner-'));
  const bin = path.join(dir, 'bin');
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'read the repo');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ -n "\${WORKER_JWT:-}" ]; then exit 9; fi
cat >/dev/null
echo '{"type":"result","result":"scout ok","session_id":"cc-scout"}'
exit 0
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt,
    BRANCH: 'smoke',
    SESSION_ID: '1',
    PLATFORM_URL: 'http://platform',
    MODE: 'scout',
    WORKSPACE_DIR: ws,
  };
  delete env.WORKER_JWT;

  const scout = spawnSync('sh', [CLAUDE_RUNNER], { env, encoding: 'utf8' });
  assert.equal(scout.status, 0, scout.stderr || scout.stdout);
  assert.match(scout.stdout, /mode=scout/, 'scout reaches its terminal result');

  const build = spawnSync('sh', [CLAUDE_RUNNER], {
    env: { ...env, MODE: 'build' }, encoding: 'utf8',
  });
  assert.notEqual(build.status, 0);
  assert.match(build.stdout, /WORKER_JWT required for build mode/);
});

// ── Reply-size ceiling (#2676) ────────────────────────────────────────
test('model catalog bounds the reply ceiling instead of inheriting the context window', () => {
  // The provider refused a whole request because the ceiling it inferred
  // (131,072) cost more than the account's remaining credit, and no reply
  // this session has ever needed is anywhere near that.
  const base = {
    modelId: 'z-ai/glm-5.3-flash',
    displayName: 'Z.AI: GLM 5.3 Flash',
    contextWindow: 200_000,
    baseInstructions: 'Test coding instructions',
  };
  assert.equal(SAFE_MAX_OUTPUT_TOKENS, 32_000);
  assert.equal(MIN_MAX_OUTPUT_TOKENS, 4_096);

  assert.equal(
    buildCodexModelCatalog(base).models[0].max_output_tokens,
    SAFE_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    buildCodexModelCatalog({ ...base, maxOutputTokens: 8_000 }).models[0].max_output_tokens,
    8_000,
  );
  // An oversized request is clamped down, a tiny one up, and the ceiling can
  // never exceed the window the reply has to fit inside.
  assert.equal(
    buildCodexModelCatalog({ ...base, maxOutputTokens: 900_000 }).models[0].max_output_tokens,
    SAFE_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    buildCodexModelCatalog({ ...base, maxOutputTokens: 10 }).models[0].max_output_tokens,
    MIN_MAX_OUTPUT_TOKENS,
  );
  assert.equal(
    buildCodexModelCatalog({ ...base, contextWindow: 9_000 }).models[0].max_output_tokens,
    9_000,
  );
});

test('a long-window model compacts at 200k tokens instead of 90% of its window', () => {
  // Codex 0.146.0 compacts once the whole active context reaches
  // min(auto_compact_token_limit, 90% of the context window). With null that
  // was ~1.18M tokens for GLM 5.3 Flash, which no change's thread reaches.
  const codexThreshold = (model) => Math.min(
    model.auto_compact_token_limit ?? Infinity,
    Math.floor((model.context_window * 9) / 10),
  );
  assert.equal(AUTO_COMPACT_TOKEN_LIMIT, 200_000);
  const glm = buildCodexModelCatalog({
    modelId: 'z-ai/glm-5.3-flash',
    displayName: 'Z.AI: GLM 5.3 Flash',
    contextWindow: 1_310_720,
    baseInstructions: 'Test coding instructions',
  }).models[0];
  assert.equal(glm.auto_compact_token_limit, 200_000);
  assert.equal(codexThreshold(glm), 200_000, 'not 1,179,648');

  // A window whose 90% is already lower keeps its own threshold.
  for (const [contextWindow, threshold] of [[128_000, 115_200], [200_000, 180_000], [64_000, 57_600]]) {
    const model = buildCodexModelCatalog({
      modelId: 'vendor/model', contextWindow, baseInstructions: 'Test coding instructions',
    }).models[0];
    assert.equal(codexThreshold(model), threshold, `${contextWindow}-token window`);
  }
});

test('the reply ceiling is taken from the environment the host already sets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-2676-'));
  const bundledCatalogPath = path.join(dir, 'bundled-models.json');
  fs.writeFileSync(bundledCatalogPath, JSON.stringify({ models: [] }));
  const catalog = buildCatalogFromEnvironment({
    CODEX_BUNDLED_MODELS_PATH: bundledCatalogPath,
    AGENT_MODEL: 'z-ai/glm-5.3-flash',
    AGENT_MODEL_NAME: 'Z.AI: GLM 5.3 Flash',
    AGENT_MODEL_MAX_OUTPUT_TOKENS: '12000',
  });
  assert.equal(catalog.models[0].max_output_tokens, 12_000);
});
