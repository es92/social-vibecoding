'use strict';

// The coding agent's read-only Homeroom tools (#2779, spec:
// docs/agent-sessions.md, "Coding agent"): the per-turn `worker_read` grant
// execInWorker issues, the stdio bridge that serves it to the agent, and the
// two runners that wire the bridge in without ever writing the grant down.
//
// The bridge is run for real, as a child process, against a stand-in
// platform MCP endpoint built with the same SDK, so the allowlist, the
// bearer and the fail-soft start are all observed rather than read.
//
// Run with: node --test tests/worker-homeroom-read-mcp.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { z } = require('zod');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');

const { WORKER_READ_TOOLS } = require('../src/services/mcp-audiences');
const worker = require('../src/services/worker');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'worker', 'homeroom-read-mcp.js');
const CODEX_RUNNER = path.join(ROOT, 'worker', 'run-codex-agent.sh');
const CLAUDE_RUNNER = path.join(ROOT, 'worker', 'run-cc.sh');
const GRANT = `svmcd_${'A'.repeat(43)}`;

// ── The grant ──────────────────────────────────────────────────────────

test('the grant rides only on build and scout turns, on either backend', () => {
  const claude = (mode) => worker.buildTurnSecretEnv({
    mode, agentBackend: 'claude_code', workerSessionJwt: 'w', issuesReadJwt: 'i', anthropicProxyJwt: 'p',
    evidenceJwt: 'e', evidenceMemberToken: 'm', evidenceAdminToken: 'a',
    evidenceFullAdminToken: 'f', homeroomMcpToken: GRANT,
  });
  const codex = (mode) => worker.buildTurnSecretEnv({
    mode, agentBackend: 'codex_openrouter', workerPushJwt: 'w', issuesReadJwt: 'i', openrouterApiKey: 'k',
    evidenceJwt: 'e', evidenceMemberToken: 'm', evidenceAdminToken: 'a',
    evidenceFullAdminToken: 'f', homeroomMcpToken: GRANT,
  });
  for (const mode of ['build', 'scout']) {
    assert.equal(claude(mode).HOMEROOM_MCP_TOKEN, GRANT);
    assert.equal(codex(mode).HOMEROOM_MCP_TOKEN, GRANT);
  }
  assert.ok(!('HOMEROOM_MCP_TOKEN' in claude('sync')));
  assert.ok(!('HOMEROOM_MCP_TOKEN' in claude('evidence')));
  assert.ok(!('HOMEROOM_MCP_TOKEN' in codex('evidence')));
  const without = worker.buildTurnSecretEnv({
    mode: 'build', agentBackend: 'claude_code', workerSessionJwt: 'w', issuesReadJwt: 'i', anthropicProxyJwt: 'p',
  });
  assert.ok(!('HOMEROOM_MCP_TOKEN' in without), 'no grant, no variable');
});

test('execInWorker issues the grant after the prompt is written and revokes it on every exit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'worker.js'), 'utf8');
  const exec = src.slice(src.indexOf('async function execInWorker('), src.indexOf('\n// #361: synchronous read'));
  const mint = exec.indexOf('await mintHomeroomReadGrant(sessionId, mode)');
  assert.ok(mint > exec.indexOf('await writeTurnPrompt('), 'a failed prompt write has nothing to revoke');
  assert.ok(mint < exec.indexOf('buildTurnSecretEnv({'));
  const revokes = [...exec.matchAll(/await revokeHomeroomReadGrant\(sessionId, homeroomGrant\)/g)].map((m) => m.index);
  assert.equal(revokes.length, 3, 'a secret-env failure, a persist failure, and the finally');
  assert.ok(revokes[1] < exec.indexOf("throw err;\n  }\n\n  // Visible to the `finally`"), 'before the persist-failure throw');
  assert.ok(revokes[2] > exec.lastIndexOf('} finally {'), 'in the finally');

  const helper = src.slice(src.indexOf('async function mintHomeroomReadGrant('), src.indexOf('async function revokeHomeroomReadGrant('));
  assert.match(helper, /status IN \('active', 'promoted'\)/, 'only for a change the grant\'s liveness check would accept');
  assert.match(helper, /kind: 'worker_read'/);
  assert.match(helper, /catch \(err\) \{[\s\S]*return null;/, 'best effort: a turn never fails for want of it');
});

test('the bridge offers exactly the worker_read tools the platform allows', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const list = src.match(/HOMEROOM_READ_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
  const names = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), [...WORKER_READ_TOOLS].sort());
  const codex = fs.readFileSync(CODEX_RUNNER, 'utf8');
  const enabled = codex.match(/\[mcp_servers\.homeroom\][\s\S]*?enabled_tools = \[([^\]]*)\]/)[1];
  assert.deepEqual([...enabled.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort(), [...WORKER_READ_TOOLS].sort());
});

// ── The bridge, for real ───────────────────────────────────────────────

async function standInPlatform(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization || null });
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const mcp = new McpServer({ name: 'stand-in', version: '1.0.0' });
    for (const name of [...WORKER_READ_TOOLS, 'start_change', 'promote_change']) {
      mcp.registerTool(name, {
        description: `${name} (stand-in)`,
        inputSchema: { slug: z.string().optional() },
        outputSchema: { ok: z.boolean() },
      }, async (args) => {
        seen.push({ tool: name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name }) }], structuredContent: { ok: true } };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function bridgeClient(t, env) {
  const client = new Client({ name: 'agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    env: { PATH: process.env.PATH, NODE_PATH: path.join(ROOT, 'node_modules'), ...env },
    cwd: ROOT,
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('the bridge serves the six read tools as the grant, and nothing else', async (t) => {
  const platform = await standInPlatform(t);
  const client = await bridgeClient(t, { PLATFORM_URL: platform.url, HOMEROOM_MCP_TOKEN: GRANT });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...WORKER_READ_TOOLS].sort());
  assert.ok(tools.every((tool) => !tool.outputSchema), 'no output schema for the agent to trip over');

  const read = await client.request({ method: 'tools/call', params: { name: 'get_app', arguments: { slug: 'recipe-box' } } }, CallToolResultSchema);
  assert.equal(read.isError, undefined);
  assert.deepEqual(JSON.parse(read.content[0].text), { ok: true, tool: 'get_app' });
  assert.ok(platform.seen.some((s) => s.tool === 'get_app' && s.args.slug === 'recipe-box'));
  assert.ok(platform.seen.filter((s) => s.method === 'POST').every((s) => s.auth === `Bearer ${GRANT}`),
    'every call to the platform carries the turn\'s grant');

  const write = await client.request({ method: 'tools/call', params: { name: 'start_change', arguments: {} } }, CallToolResultSchema);
  assert.equal(write.isError, true);
  assert.equal(JSON.parse(write.content[0].text).code, 'not_allowed');
  assert.ok(!platform.seen.some((s) => s.tool === 'start_change'), 'a write never reaches the platform');
});

test('without a grant the bridge starts and offers nothing', async (t) => {
  const client = await bridgeClient(t, { PLATFORM_URL: 'http://127.0.0.1:9' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools, []);
  const call = await client.request({ method: 'tools/call', params: { name: 'get_app', arguments: {} } }, CallToolResultSchema);
  assert.equal(JSON.parse(call.content[0].text).code, 'not_available');
});

// ── The runners ────────────────────────────────────────────────────────

function codexEnv(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeroom-codex-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // A fake Codex that prints the grant it can see, then fails fast before
  // any commit or push.
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
cat >/dev/null
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"aggregated_output\\":\\"$HOMEROOM_MCP_TOKEN\\"}}"
exit 1
`);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'task');
  const catalog = path.join(dir, 'bundled-models.json');
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'gpt-test', base_instructions: 'You are Codex, an agent based on GPT-5. Rest.' }] }));
  return {
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt,
    BRANCH: 'smoke',
    MODE: mode,
    WORKER_JWT: 'jwt', SESSION_ID: '1', PLATFORM_URL: 'http://p',
    OPENROUTER_API_KEY: 'sk-or-v1-test', OPENROUTER_API_BASE: 'https://openrouter.ai/api/v1',
    AGENT_MODEL: 'z-ai/glm-5.3-flash', AGENT_MODEL_NAME: 'GLM',
    AGENT_MODEL_CONTEXT_WINDOW: '200000', AGENT_MODEL_SUPPORTS_TOOLS: '1',
    CODEX_BUNDLED_MODELS_PATH: catalog,
    WORKSPACE_DIR: ws, CODEX_HOME: path.join(dir, 'codex-home'),
  };
}

test('Codex gets the bridge on build and scout, with the grant named but never written', () => {
  for (const mode of ['build', 'scout']) {
    const env = { ...codexEnv(mode), HOMEROOM_MCP_TOKEN: GRANT };
    const run = spawnSync('sh', [CODEX_RUNNER], { env, encoding: 'utf8' });
    const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(config, /\[mcp_servers\.homeroom\]\ncommand = "node"\nargs = \["\/usr\/local\/bin\/homeroom-read-mcp\.js"\]\nenv_vars = \["HOMEROOM_MCP_TOKEN", "PLATFORM_URL"\]/);
    assert.match(config, /exclude = \["OPENROUTER_API_KEY", "HOMEROOM_MCP_TOKEN"\]/, 'model-launched commands do not inherit it');
    assert.ok(!config.includes(GRANT), `${mode}: the grant is never written to the config`);
    assert.ok(!run.stdout.includes(GRANT), `${mode}: the grant is scrubbed from the agent's output`);
    if (mode === 'scout') assert.doesNotMatch(config, /playwright/, 'scout stays browser-free');
  }
  const plain = codexEnv('build');
  spawnSync('sh', [CODEX_RUNNER], { env: plain, encoding: 'utf8' });
  const config = fs.readFileSync(path.join(plain.CODEX_HOME, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /mcp_servers\.homeroom/, 'no grant, no server');
  assert.match(config, /exclude = \["OPENROUTER_API_KEY"\]\n/);
});

function claudeArgs(mode, { grant = true, browser = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeroom-claude-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const argsLog = path.join(dir, 'args.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf '%s\\n' "$@" > "${argsLog}"
cat >/dev/null
echo '{"type":"result","result":"ok","session_id":"cc-1"}'
exit 0
`);
  // Build mode checks out and syncs the branch before it runs the agent.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'task');
  const systemPrompt = path.join(dir, 'system.txt');
  fs.writeFileSync(systemPrompt, 'conventions');
  const homeroomConfig = path.join(dir, 'homeroom-mcp.json');
  fs.copyFileSync(path.join(ROOT, 'worker', 'homeroom-mcp.json'), homeroomConfig);
  const browserConfig = path.join(dir, 'browser-mcp.json');
  if (browser) fs.writeFileSync(browserConfig, '{"mcpServers":{}}');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    MODE: mode, WORKSPACE_DIR: ws, WORKER_JWT: 'jwt',
    ...(mode === 'build' ? { SYSTEM_PROMPT_FILE: systemPrompt } : {}),
    HOMEROOM_MCP_CONFIG: homeroomConfig, BROWSER_MCP_CONFIG: browserConfig,
  };
  if (grant) env.HOMEROOM_MCP_TOKEN = GRANT; else delete env.HOMEROOM_MCP_TOKEN;
  spawnSync('sh', [CLAUDE_RUNNER], { env, encoding: 'utf8' });
  const args = fs.existsSync(argsLog) ? fs.readFileSync(argsLog, 'utf8').split('\n') : [];
  return { args, homeroomConfig, browserConfig };
}

test('Claude loads the bridge beside the browser on a build, and alone on a scout', () => {
  const scout = claudeArgs('scout');
  const at = scout.args.indexOf('--mcp-config');
  assert.deepEqual(scout.args.slice(at, at + 3), ['--mcp-config', scout.homeroomConfig, '--strict-mcp-config']);
  assert.ok(!scout.args.includes(scout.browserConfig), 'scout stays browser-free');

  const build = claudeArgs('build');
  const b = build.args.indexOf('--mcp-config');
  assert.deepEqual(build.args.slice(b, b + 4), ['--mcp-config', build.browserConfig, build.homeroomConfig, '--strict-mcp-config']);

  const plainScout = claudeArgs('scout', { grant: false });
  assert.ok(!plainScout.args.includes('--mcp-config'), 'no grant: a scout invocation is as before');
  const plainBuild = claudeArgs('build', { grant: false });
  const p = plainBuild.args.indexOf('--mcp-config');
  assert.deepEqual(plainBuild.args.slice(p, p + 3), ['--mcp-config', plainBuild.browserConfig, '--strict-mcp-config']);
  assert.ok(!claudeArgs('build').args.join(' ').includes(GRANT), 'the grant is never an argument');
});

test('the image carries the bridge and its secret-free config', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY homeroom-read-mcp\.js \/usr\/local\/bin\/homeroom-read-mcp\.js/);
  assert.match(dockerfile, /COPY homeroom-mcp\.json \/usr\/local\/share\/usernode\/homeroom-mcp\.json/);
  assert.match(dockerfile, /\/usr\/local\/bin\/homeroom-read-mcp\.js \\\n/);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'worker', 'homeroom-mcp.json'), 'utf8'));
  assert.deepEqual(config, { mcpServers: { homeroom: { command: 'node', args: ['/usr/local/bin/homeroom-read-mcp.js'] } } });
});

test('hosted build and scout prompts mention the tools; a local run does not', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sessions.js'), 'utf8');
  const uses = [...src.matchAll(/\$\{runLocally \? '' : `\\n\$\{HOMEROOM_READ_NOTE\}\\n`\}/g)];
  assert.equal(uses.length, 2, 'one in the scout prompt, one in the build prompt');
  const note = src.match(/const HOMEROOM_READ_NOTE = '([^\n]*)';/)[1];
  for (const name of WORKER_READ_TOOLS) assert.ok(note.includes(name), name);
  assert.match(note, /cannot write anything/);
  assert.match(note, /If they are not in your tool list this turn, carry on without them/);
});

test('a Homeroom bearer never reaches the host logs', () => {
  const { redactString } = require('../src/services/log-redaction');
  assert.equal(redactString(`grant ${GRANT} used`), 'grant **** used');
  assert.equal(redactString(`svmcp_${'b'.repeat(43)}`), '****');
});
