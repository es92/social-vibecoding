'use strict';
// Homeroom's sync with main (worker/run-cc.sh, MODE=sync): a Claude-resolved
// merge is checked before it is pushed (#6536). On 4 Nov 2026 a resolution
// dropped the leading `/` of a doc comment in a .tsx file; the tree had no
// conflict markers, so it was committed and pushed, and every preview build
// then failed on "Unexpected `**`" with nothing saying the sync caused it.
//
// A temporary repository, a stub `claude` on PATH and a stub esbuild in the
// checkout stand in for the worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUN_CC = path.join(ROOT, 'worker', 'run-cc.sh');
const BRANCH = 'dev/homeroom_bot-6536';
const FILE = 'frontend/src/feature.tsx';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BROKEN = "export const address = '/feature';\n** This page's address: where a thread opened from it comes back to. */\n";
const CLEAN = "export const address = '/feature';\n/** This page's address: where a thread opened from it comes back to. */\n";

// A stand-in for the model: resolves the conflict by replacing the file.
// STUB_MODE says what its turns leave behind:
//   broken  always the dropped comment opener
//   clean   always a parsing resolution
//   fix     broken on the resolution turn, clean when asked to fix parsing
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
fs.appendFileSync(process.env.STUB_LOG, prompt + '\\n----\\n');
const broken = ${JSON.stringify(BROKEN)};
const clean = ${JSON.stringify(CLEAN)};
const fixing = /do not parse|no longer parse/.test(prompt);
const mode = process.env.STUB_MODE || 'broken';
fs.writeFileSync(${JSON.stringify(FILE)}, mode === 'clean' ? clean : mode === 'fix' && fixing ? clean : broken);
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'cc-1',
  usage: { input_tokens: 1, output_tokens: 1 } }));
`;

// The frontend's pinned esbuild, in miniature: a transform that refuses the
// one thing the dropped opener breaks. The sync gate finds it in the
// checkout first, as it finds the real one.
const STUB_ESBUILD = `module.exports = { transformSync(source) {
  const lines = String(source).split('\\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\\s*\\*\\* /.test(lines[i])) {
      const err = new Error('Transform failed');
      err.errors = [{ text: 'Unexpected "**"', location: { line: i + 1, column: 0 } }];
      throw err;
    }
  }
  return { code: '' };
} };
`;

// A branch and main that each changed the same .tsx file, so the merge
// conflicts on it, and the stub's resolution decides what it becomes.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-parse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  fs.mkdirSync(path.dirname(path.join(seed, FILE)), { recursive: true });
  fs.writeFileSync(path.join(seed, FILE), CLEAN);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'baseline');
  git(seed, 'switch', '-qc', BRANCH);
  fs.writeFileSync(path.join(seed, FILE), "export const address = '/branch';\n/** Branch's doc. */\n");
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'branch');
  git(seed, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(seed, FILE), "export const address = '/main';\n/** Main's doc. */\n");
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'main');
  git(seed, 'push', '-q', 'origin', 'main', BRANCH);
  const ws = path.join(dir, 'ws');
  git(dir, 'clone', '-q', '-b', BRANCH, origin, ws);
  // The checkout's own esbuild, ignored by the repository as node_modules is.
  const esbuild = path.join(ws, 'frontend', 'node_modules', 'esbuild');
  fs.mkdirSync(esbuild, { recursive: true });
  fs.writeFileSync(path.join(esbuild, 'package.json'), JSON.stringify({ name: 'esbuild', main: 'index.js' }));
  fs.writeFileSync(path.join(esbuild, 'index.js'), STUB_ESBUILD);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), STUB_CLAUDE);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'Sync with main');
  return { dir, ws, bin, prompt, log: path.join(dir, 'claude.log'), branchHead: git(ws, 'rev-parse', 'HEAD') };
}

function sync(fx, extra = {}) {
  const ran = spawnSync('sh', [RUN_CC], { encoding: 'utf8', env: {
    ...ENV, PATH: `${fx.bin}:${process.env.PATH}`, HOME: fx.dir,
    PROMPT_FILE: fx.prompt, WORKSPACE_DIR: fx.ws, MODE: 'sync', BRANCH, SESSION_ID: '6536',
    PLATFORM_URL: 'http://127.0.0.1:1', WORKER_JWT: 'test-worker-jwt', STUB_LOG: fx.log,
    AGENT_PROVIDER: 'anthropic',
    USERNODE_CGROUP_DIR: path.join(fx.dir, 'absent-cgroup'),
    ...extra,
  } });
  const out = `${ran.stdout}${ran.stderr}`;
  return { code: ran.status, out,
    result: out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')) || '',
    prompts: fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8').split('\n----\n').filter(Boolean) : [] };
}

test('a resolution that does not parse gets one more turn, then aborts as a conflict naming the file', (t) => {
  const fx = fixture(t);
  const ran = sync(fx, { STUB_MODE: 'broken' });
  assert.equal(ran.code, 0, ran.out);
  assert.equal(ran.prompts.length, 2, 'the resolution turn, then the parse-fix turn');
  assert.match(ran.prompts[0], /Resolve every conflict marker/);
  assert.match(ran.prompts[1], /do not parse/);
  assert.match(ran.prompts[1], new RegExp(`${FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2:1: Unexpected`));
  assert.match(ran.result, /sync_result=conflict/);
  assert.match(ran.result, new RegExp(`conflict_files=.*${FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(ran.out, /resolved tree does not parse: .*feature\.tsx/);
  assert.equal(git(fx.ws, 'rev-parse', 'HEAD'), fx.branchHead, 'HEAD is unchanged: nothing was committed');
  assert.equal(git(fx.ws, 'status', '--porcelain'), '', 'the merge was aborted');
  assert.doesNotMatch(git(fx.ws, 'log', '-1', '--format=%s'), /Claude-resolved/);
});

test('a resolution that parses commits and pushes as it did before', (t) => {
  const fx = fixture(t);
  const ran = sync(fx, { STUB_MODE: 'clean' });
  assert.equal(ran.code, 0, ran.out);
  assert.equal(ran.prompts.length, 1, 'no second turn');
  assert.match(ran.result, /sync_result=resolved/);
  assert.match(ran.result, /conflict_files=frontend\/src\/feature\.tsx/);
  assert.equal(git(fx.ws, 'log', '-1', '--format=%s'), 'Merge origin/main via Homeroom sync (Claude-resolved)');
  assert.equal(fs.readFileSync(path.join(fx.ws, FILE), 'utf8'), CLEAN);
});

test('a second turn that fixes the file lets the sync through', (t) => {
  const fx = fixture(t);
  const ran = sync(fx, { STUB_MODE: 'fix' });
  assert.equal(ran.code, 0, ran.out);
  assert.equal(ran.prompts.length, 2);
  assert.match(ran.result, /sync_result=resolved/);
  assert.equal(fs.readFileSync(path.join(fx.ws, FILE), 'utf8'), CLEAN);
});
