#!/usr/bin/env node
'use strict';

// Take before/after shots of declared changes on two builds that are already
// running, with a real preview agent, outside Homeroom. Everything between the
// agent and the saved files is the production code: the preview agent's
// prompts, the shots bridge (worker/evidence-mcp.js), the internal routes and
// the run control. The browsers are Playwright MCP with the worker's flags.
// What differs from a hosted run: the builds, their data and sign-in are
// whatever the caller started, and the agent is the local `claude` CLI.
//
//   node scripts/shots-dry-run.js --intent intent.json \
//     --before http://127.0.0.1:4101 --after http://127.0.0.1:4102 \
//     [--state-dir DIR] [--repo . --base-sha SHA --head-sha SHA]
//
// Writes <out>/index.html (the shots side by side), result.json, the saved
// files, and agent.jsonl (the agent's stream). No database, no network other
// than the two builds and the model, and nothing is published anywhere.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PERSONAS = Object.freeze({
  member: { dir: 'member', server: 'browser_member' },
  read_only_admin: { dir: 'admin', server: 'browser_admin' },
  full_admin: { dir: 'full_admin', server: 'browser_full_admin' },
});
// The same MCP browser tools a hosted turn is denied (worker/run-cc.sh).
const DENIED_BROWSER_TOOLS = ['browser_evaluate', 'browser_run_code', 'browser_file_upload', 'browser_install'];

function usage() {
  return `Usage: node scripts/shots-dry-run.js --intent FILE --before URL --after URL [options]

  --intent FILE          version-1 visualEvidence declaration (JSON)
  --before URL           origin of the build without the change
  --after URL            origin of the build with the change
  --state-dir DIR        Playwright storage state per persona: member.json,
                         read_only_admin.json, full_admin.json (signed-in
                         cookies for both origins); a missing file means that
                         persona's browser starts signed out
  --out DIR              output directory (default .shots-dry-run/<time>)
  --repo DIR             git checkout holding both commits, for the brief's
                         changed files and diff (default: this repository)
  --base-sha SHA         before commit (for the brief)
  --head-sha SHA         after commit (for the brief)
  --head-checkout DIR    checkout of the after commit, for its declared checks
  --title TEXT           proposal title, shown to the agent as untrusted context
  --testing-steps TEXT   proposal testing steps, likewise
  --model ID             model for the preview agent (default: your claude default)
  --timeout-ms N         agent budget (default 480000, the hosted default)
  --playwright-mcp CMD   how to start Playwright MCP (default "npx -y @playwright/mcp@0.0.41")
  --browser NAME         browser for Playwright MCP (default chromium)
  --executable-path P    browser binary, when Playwright's own is not installed
  --claude-args "..."    extra arguments for claude (for example --bare)
  --agent-command FILE   run this node script as the agent instead of claude;
                         it receives the MCP config path as its argument
`;
}

function parseArgs(argv) {
  const flags = new Set(['--intent', '--before', '--after', '--state-dir', '--out', '--repo',
    '--base-sha', '--head-sha', '--head-checkout', '--title', '--testing-steps', '--model',
    '--timeout-ms', '--playwright-mcp', '--browser', '--executable-path', '--claude-args',
    '--agent-command']);
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!flags.has(key) || argv[i + 1] == null || values[key] != null) {
      throw new Error(`Invalid or repeated argument ${key}.\n\n${usage()}`);
    }
    values[key] = argv[++i];
  }
  for (const key of ['--intent', '--before', '--after']) {
    if (!values[key]) throw new Error(`${key} is required.\n\n${usage()}`);
  }
  const origin = (value, key) => {
    try { return new URL(value).origin; } catch { throw new Error(`${key} must be a URL.`); }
  };
  for (const key of ['--base-sha', '--head-sha']) {
    if (values[key] && !/^[0-9a-f]{40}$/.test(values[key])) {
      throw new Error(`${key} must be a full 40-character commit SHA.`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    intentFile: path.resolve(values['--intent']),
    before: origin(values['--before'], '--before'),
    after: origin(values['--after'], '--after'),
    stateDir: values['--state-dir'] ? path.resolve(values['--state-dir']) : null,
    out: path.resolve(values['--out'] || path.join(ROOT, '.shots-dry-run', stamp)),
    repo: path.resolve(values['--repo'] || ROOT),
    baseSha: values['--base-sha'] || null,
    headSha: values['--head-sha'] || null,
    headCheckout: values['--head-checkout'] ? path.resolve(values['--head-checkout']) : null,
    title: values['--title'] || null,
    testingSteps: values['--testing-steps'] || null,
    model: values['--model'] || null,
    timeoutMs: Math.max(30_000, Number(values['--timeout-ms']) || 480_000),
    playwrightMcp: (values['--playwright-mcp'] || 'npx -y @playwright/mcp@0.0.41').split(/\s+/).filter(Boolean),
    browser: values['--browser'] || 'chromium',
    executablePath: values['--executable-path'] || null,
    claudeArgs: (values['--claude-args'] || '').split(/\s+/).filter(Boolean),
    agentCommand: values['--agent-command'] ? path.resolve(values['--agent-command']) : null,
  };
}

// What the hosted run reads from GitHub, read from a local checkout instead.
function revisionContext(options) {
  const unknown = { baseSha: options.baseSha || 'unknown-before', headSha: options.headSha || 'unknown-after',
    files: [], filesComplete: false, diffSummary: null };
  if (!options.baseSha || !options.headSha) return unknown;
  try {
    const git = (...args) => execFileSync('git', ['-C', options.repo, ...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = git('diff', '--name-only', `${options.baseSha}...${options.headSha}`)
      .split('\n').filter(Boolean);
    const diff = git('diff', `${options.baseSha}...${options.headSha}`);
    return {
      baseSha: options.baseSha,
      headSha: options.headSha,
      files,
      filesComplete: true,
      diffSummary: { text: diff.slice(0, 8_000), fileCount: files.length, truncated: diff.length > 8_000 },
    };
  } catch (error) {
    process.stderr.write(`Could not read ${options.baseSha}...${options.headSha} in ${options.repo}: ${error.message}\n`);
    return unknown;
  }
}

// The bridge requires its dependencies from the worker image's global
// install. Point a copy at this repository's own (same pinned versions).
function localBridge(runtimeDir) {
  const source = fs.readFileSync(path.join(ROOT, 'worker', 'evidence-mcp.js'), 'utf8')
    .replaceAll('/usr/local/lib/node_modules/', `${path.join(ROOT, 'node_modules')}/`)
    .replace("require('./evidence-hosted-origins')",
      `require(${JSON.stringify(path.join(ROOT, 'worker', 'evidence-hosted-origins.js'))})`);
  const file = path.join(runtimeDir, 'evidence-mcp.js');
  fs.writeFileSync(file, source, { mode: 0o600 });
  return file;
}

function browserServer(options, persona, shotsDir, recordClips) {
  const statePath = options.stateDir ? path.join(options.stateDir, `${persona}.json`) : null;
  const [command, ...prefix] = options.playwrightMcp;
  return {
    command,
    args: [
      ...prefix,
      '--browser', options.browser, '--headless', '--isolated', '--no-sandbox', '--caps', 'vision',
      ...(statePath && fs.existsSync(statePath) ? ['--storage-state', statePath] : []),
      '--allowed-origins', `${options.before};${options.after}`,
      '--block-service-workers', '--image-responses', 'allow',
      '--timeout-action', '10000', '--timeout-navigation', '30000',
      '--output-dir', path.join(shotsDir, PERSONAS[persona].dir),
      ...(recordClips ? ['--save-video=1280x800'] : []),
      ...(options.executablePath ? ['--executable-path', options.executablePath] : []),
    ],
    env: { PATH: process.env.PATH || '' },
  };
}

function toolCalls(streamFile) {
  const counts = {};
  let finalText = null;
  let text = '';
  try { text = fs.readFileSync(streamFile, 'utf8'); } catch { return { counts, finalText }; }
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use') counts[block.name] = (counts[block.name] || 0) + 1;
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') finalText = event.result.slice(0, 4000);
  }
  return { counts, finalText };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function contactSheet(intent, summary, fileNames, meta) {
  const results = new Map(summary.stories.map((story) => [story.id, story]));
  const cell = (label, name, video) => (name
    ? (video
      ? `<figure><figcaption>${label}</figcaption><video src="shots/${escapeHtml(name)}" controls muted playsinline></video></figure>`
      : `<figure><figcaption>${label}</figcaption><a href="shots/${escapeHtml(name)}"><img src="shots/${escapeHtml(name)}" alt="${label}"></a></figure>`)
    : `<figure><figcaption>${label}</figcaption><div class="none">none</div></figure>`);
  const changes = intent.stories.map((story) => {
    const result = results.get(story.id) || {};
    const rows = story.viewports.map((viewport) => {
      const find = (side, variant) => fileNames.get(`${story.id}|${viewport.name}|${side}|${variant}`);
      const rowsFor = [['context', 'screen', false], ['focus', 'element', false], ['animation', 'clip', true]]
        .filter(([variant]) => find('base', variant) || find('head', variant))
        .map(([variant, word, video]) => `<div class="pair">${cell(`Before · ${word}`, find('base', variant), video)}${cell(`After · ${word}`, find('head', variant), video)}</div>`);
      return `<h3>${escapeHtml(viewport.name)} ${viewport.width}×${viewport.height}</h3>${rowsFor.join('') || '<p class="none">No shots saved.</p>'}`;
    }).join('');
    return `<section><h2>${escapeHtml(story.claim)}</h2>
      <p class="meta"><b class="${result.status === 'ready' ? 'ready' : 'skipped'}">${escapeHtml(result.status || 'unknown')}</b>
      · ${escapeHtml(story.id)} · ${escapeHtml(story.persona)} · animation ${escapeHtml(story.intent.animation)}</p>
      ${result.reason ? `<p class="reason">${escapeHtml(result.reason)}</p>` : ''}
      <p class="steps">${story.intent.steps.map(escapeHtml).join(' → ')}</p>${rows}</section>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><title>Before/after shots dry run</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#fafafa;color:#18181b}
section{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:16px;margin:0 0 20px}
h2{font-size:16px;margin:0 0 4px}h3{font-size:13px;margin:14px 0 6px;color:#52525b}
.pair{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}figure{flex:1 1 380px;margin:0;min-width:0}
figcaption{font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;margin-bottom:4px}
img,video{width:100%;border:1px solid #e4e4e7;border-radius:8px;background:#27272a}
.none{color:#a1a1aa;padding:24px;border:1px dashed #d4d4d8;border-radius:8px;text-align:center}
.meta{color:#52525b;margin:0}.ready{color:#15803d}.skipped{color:#b45309}.reason{background:#fffbeb;padding:8px;border-radius:8px}
.steps{color:#52525b}pre{white-space:pre-wrap;background:#f4f4f5;padding:12px;border-radius:8px}</style>
<h1>Before/after shots dry run</h1>
<p>${escapeHtml(meta.before)} → ${escapeHtml(meta.after)} · ${summary.readyCount} of ${intent.stories.length} ready · agent ${escapeHtml(meta.agentOutcome)} in ${Math.round(meta.agentMs / 1000)} s</p>
${changes}
<h2>Agent's last words</h2><pre>${escapeHtml(meta.finalText || '(none)')}</pre>
<h2>Tool calls</h2><pre>${escapeHtml(JSON.stringify(meta.toolCounts, null, 2))}</pre>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  // Secrets for this process only: the run-scoped token is signed and
  // checked inside it.
  process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || process.env.WORKER_JWT_SECRET;
  // The internal routes module opens a pool lazily; the shots routes never
  // touch it, so a pool that refuses every query keeps this database-free.
  require('../src/db/pool').getPool = () => ({ query: async () => { throw new Error('No database in a dry run.'); } });
  const express = require('express');
  const planContract = require('../src/services/visual-evidence-plan');
  const control = require('../src/services/visual-evidence-control');
  const platformJwt = require('../src/services/platform-jwt');
  const { internalRoutes } = require('../src/routes/internal');
  const orchestrator = require('../src/services/visual-evidence-orchestrator');
  const agent = require('../src/services/visual-evidence-agent');
  const shots = require('../src/services/visual-evidence-shots');

  const intent = planContract.parseIntent(JSON.parse(fs.readFileSync(options.intentFile, 'utf8')));
  if (intent.impact === 'none' || !intent.stories.length) {
    throw new Error('This declaration has no visible change, so there is nothing to shoot.');
  }
  const recordClips = intent.stories.some(planContract.needsClip);
  const runtimeDir = path.join(options.out, 'runtime');
  const shotsDir = path.join(runtimeDir, 'shots');
  for (const persona of Object.values(PERSONAS)) {
    fs.mkdirSync(path.join(shotsDir, persona.dir), { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(options.out, 'shots'), { recursive: true });

  const runId = crypto.randomBytes(16).toString('hex');
  const sessionId = 1;
  const revision = revisionContext(options);
  const brief = orchestrator.shotsBrief({
    run: { id: runId },
    session: { pr_title: options.title, testing_md: options.testingSteps },
    revision,
    pair: { sides: { head: { checkout: options.headCheckout || '/nonexistent' } } },
    deployment: { origins: { base: options.before, head: options.after }, availableFixtures: [] },
    intent,
  });
  const registration = control.registerRun({
    runId, sessionId, intent, context: brief, expiresAt: Date.now() + options.timeoutMs + 120_000,
  });

  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const platformUrl = `http://127.0.0.1:${server.address().port}`;

  const hostedFile = path.join(runtimeDir, 'hosted-origins.json');
  fs.writeFileSync(hostedFile, JSON.stringify({
    version: 2, baseOrigin: options.before, headOrigin: options.after, apps: [],
  }), { mode: 0o600 });
  const mcpConfig = path.join(runtimeDir, 'mcp.json');
  fs.writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: {
    shots: {
      command: process.execPath,
      args: [localBridge(runtimeDir)],
      env: {
        PATH: process.env.PATH || '',
        PLATFORM_URL: platformUrl,
        EVIDENCE_RUN_ID: runId,
        EVIDENCE_JWT: platformJwt.signEvidenceToken({ runId, sessionId }),
        EVIDENCE_SHOTS_DIR: shotsDir,
        EVIDENCE_HOSTED_ORIGINS_FILE: hostedFile,
      },
    },
    ...Object.fromEntries(Object.entries(PERSONAS).map(([persona, { server: name }]) =>
      [name, browserServer(options, persona, shotsDir, recordClips)])),
  } }, null, 2)}\n`, { mode: 0o600 });

  const streamFile = path.join(options.out, 'agent.jsonl');
  const stream = fs.createWriteStream(streamFile);
  const startedAt = Date.now();
  let child;
  if (options.agentCommand) {
    child = spawn(process.execPath, [options.agentCommand, mcpConfig], { stdio: ['ignore', 'pipe', 'inherit'] });
  } else {
    // An empty working directory keeps any project CLAUDE.md, settings or
    // .mcp.json out of the turn; --strict-mcp-config loads only ours.
    const cwd = fs.mkdtempSync(path.join(runtimeDir, 'cwd-'));
    const servers = Object.values(PERSONAS).map((p) => p.server);
    const args = [
      '--print', '--verbose', '--output-format', 'stream-json',
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      '--append-system-prompt', agent.SYSTEM_PROMPT,
      // No built-in tools at all: a hosted turn has no shell, file or web
      // tools either. Only the shots and browser servers are allowed.
      '--tools', '',
      '--allowedTools', ['mcp__shots', ...servers.map((s) => `mcp__${s}`)].join(','),
      '--disallowedTools', servers.flatMap((s) => DENIED_BROWSER_TOOLS.map((t) => `mcp__${s}__${t}`)).join(','),
      ...(options.model ? ['--model', options.model] : []),
      ...options.claudeArgs,
    ];
    child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.end(agent.TASK_PROMPT);
  }
  child.stdout.pipe(stream);
  process.stdout.write(`Preview agent started (run ${runId.slice(0, 8)}); streaming to ${streamFile}\n`);
  let agentOutcome = 'finished';
  const timer = setTimeout(() => { agentOutcome = 'timed out'; child.kill('SIGTERM'); }, options.timeoutMs);
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (agentOutcome === 'finished' && exitCode !== 0) agentOutcome = `exited ${exitCode}`;
  const agentMs = Date.now() - startedAt;
  await new Promise((resolve) => stream.end(resolve));

  // The same fold the hosted run publishes from.
  const summary = registration.control.summary();
  const fileNames = new Map();
  const side = { base: 'before', head: 'after' };
  const kind = { context: 'screen', focus: 'element', animation: 'clip' };
  for (const [, file] of registration.control.saved) {
    const name = `${file.storyId}-${file.viewport}-${side[file.side]}-${kind[file.variant]}.${file.media}`;
    fs.writeFileSync(path.join(options.out, 'shots', name), file.data);
    fileNames.set(`${file.storyId}|${file.viewport}|${file.side}|${file.variant}`, name);
  }
  const { counts: toolCounts, finalText } = toolCalls(streamFile);
  const result = {
    runId,
    before: options.before,
    after: options.after,
    revisions: { before: revision.baseSha, after: revision.headSha },
    agent: { outcome: agentOutcome, exitCode, ms: agentMs, model: options.model || 'claude default',
      toolCounts, finalText },
    published: summary.verdict.passed,
    readyCount: summary.readyCount,
    changes: summary.stories,
    savedFiles: [...fileNames.values()],
    manifestHash: summary.manifestHash,
    mode: shots.SHOTS_MODE,
  };
  fs.writeFileSync(path.join(options.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(options.out, 'index.html'), contactSheet(intent, summary, fileNames,
    { before: options.before, after: options.after, agentOutcome, agentMs, finalText, toolCounts }));
  registration.unregister();
  server.close();
  process.stdout.write(`${JSON.stringify({ published: result.published, ready: result.readyCount,
    of: intent.stories.length, agent: agentOutcome, seconds: Math.round(agentMs / 1000),
    changes: summary.stories.map((s) => `${s.id}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`),
    open: path.join(options.out, 'index.html') }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, revisionContext, contactSheet };
