// `social-vibecoding agent run|status|detach` (#907) — the local half.
//
// The two properties worth a test that will fail loudly if someone
// "simplifies" this file later:
//
//   1. No credential crosses in either direction. This process never reads a
//      Claude Code credential and never forwards one; the platform never
//      sends one.
//   2. No push access is needed or used. Commits go up as a file-by-file
//      upload the platform reconstructs through its own GitHub App, so the
//      CLI must never run `git push`.
//
// Everything else here is protocol mechanics: the stop signal arrives as a
// 409 on a progress post, commits upload oldest-first, and the process always
// detaches on the way out.
//
// Run with: node --test tests/cli-agent-run.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agent = require('../src/cli/agent-command');
const claudeCode = require('../src/cli/agent-runtimes/claude-code');

const root = path.join(__dirname, '..');
const agentSource = fs.readFileSync(path.join(root, 'src/cli/agent-command.js'), 'utf8');
const runtimeSource = fs.readFileSync(
  path.join(root, 'src/cli/agent-runtimes/claude-code.js'), 'utf8'
);

function fakeIo() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdout: out, stderr: err };
}

// Records every call and answers from a queue keyed by path fragment.
function fakeApi(routes = {}) {
  const calls = [];
  return {
    calls,
    async call(method, pathname, body, opts) {
      calls.push({ method, pathname, body, opts });
      for (const [fragment, answer] of Object.entries(routes)) {
        if (pathname.includes(fragment)) {
          const value = typeof answer === 'function' ? answer(calls.length, body) : answer;
          return { ok: value.status < 400, status: value.status, data: value.data || null };
        }
      }
      return { ok: true, status: 200, data: {} };
    },
  };
}

// ── The two invariants ─────────────────────────────────────────────────────

test('the CLI never reads a Claude Code credential, from anywhere', () => {
  for (const [name, source] of [['agent-command', agentSource], ['runtime', runtimeSource]]) {
    for (const forbidden of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '.credentials.json',
      'security find-generic-password',
      'keychain',
    ]) {
      // The runtime adapter's header names these deliberately, as the list of
      // things it must not do. Only actual code may not mention them.
      const code = source.split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      assert.equal(code.includes(forbidden), false,
        `${name} must not reference ${forbidden} outside its comments`);
    }
  }
});

test('the CLI never pushes — commits reach the branch through the GitHub App', () => {
  assert.equal(/'push'/.test(agentSource), false, 'no git push argv');
  assert.equal(/git push/.test(agentSource.replace(/^\s*\/\/.*$/gm, '')), false);
  assert.match(agentSource, /collectCommitUpload/);
  assert.match(agentSource, /\/commit`/);
});

test('the runtime spawns the local binary and passes the prompt on stdin', () => {
  // A dispatch prompt (conventions + spec doc) routinely exceeds the 128 KiB
  // single-argument limit, which is why it cannot be an argv string.
  assert.match(runtimeSource, /child\.stdin\.end\(prompt/);
  assert.equal(runtimeSource.includes('shell: true'), false, 'never spawn through a shell');
  assert.match(runtimeSource, /'--print', '--verbose', '--output-format', 'stream-json'/);
});

test('the local runtime is safe-by-default, with the worker\'s posture opt-in', () => {
  assert.equal(claudeCode.DEFAULT_PERMISSION_MODE, 'acceptEdits');
  // This is someone's own laptop with their own files on it, not a disposable
  // container — --dangerously-skip-permissions must be asked for by name.
  assert.match(agentSource, /'--dangerously-skip-permissions'/);
  assert.match(agentSource, /skipPermissions = options\.dangerously_skip_permissions === true/);
});

// ── Protocol mechanics ─────────────────────────────────────────────────────

test('a 409 on a progress post is the stop signal, and it aborts the child', async () => {
  const api = fakeApi({ '/progress': { status: 409, data: { error: 'turn_not_running' } } });
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  assert.equal(reporter.signal.aborted, false);
  for (let i = 0; i < agent.PROGRESS_FLUSH_LINES; i += 1) reporter.add(`line ${i}`);
  await reporter.done();
  assert.equal(reporter.state.stopped, true);
  assert.equal(reporter.signal.aborted, true, 'the runtime adapter watches this signal');
});

test('a dropped progress post never fails the turn', async () => {
  const api = {
    calls: 0,
    async call() { this.calls += 1; throw new Error('network down'); },
  };
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  reporter.add('still working');
  await reporter.done(); // must not reject
  assert.equal(reporter.state.stopped, false, 'a network blip is not a stop');
});

test('progress is batched rather than one request per line', async () => {
  const api = fakeApi({ '/progress': { status: 204 } });
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  for (let i = 0; i < 5; i += 1) reporter.add(`line ${i}`);
  await reporter.done();
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body.lines.length, 5);
  assert.equal(api.calls[0].body.leaseId, '7');
});

test('a stopped turn posts no result — the platform already owns that row', async () => {
  const api = fakeApi({
    '/accept': { status: 200, data: {} },
    '/progress': { status: 409, data: { error: 'turn_not_running' } },
  });
  const io = fakeIo();
  const runtime = {
    RUNTIME_ID: 'claude-code',
    async run({ onProgress }) {
      for (let i = 0; i < agent.PROGRESS_FLUSH_LINES; i += 1) onProgress(`l${i}`);
      // Let the flush land, the way a real child does when it is killed.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return { exitCode: 143, isError: true, summary: '', stderr: '' };
    },
  };
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go' }, {
    repo: root, leaseId: '7', runtime, binary: 'claude', ask: async () => 'y',
  }, io);
  assert.equal(api.calls.some((c) => c.pathname.includes('/result')), false);
  assert.equal(api.calls.some((c) => c.pathname.includes('/commit')), false);
  assert.match(io.stdout.join(''), /stopped from the web page/i);
});

test('a turn the machine can no longer claim is skipped, not crashed on', async () => {
  const api = fakeApi({ '/accept': { status: 409, data: { error: 'turn_not_offered' } } });
  const io = fakeIo();
  let ran = false;
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go' }, {
    repo: root, leaseId: '7', binary: 'claude', ask: async () => 'y',
    runtime: { RUNTIME_ID: 'claude-code', async run() { ran = true; return {}; } },
  }, io);
  assert.equal(ran, false, 'never spend the user\'s subscription on a turn we do not hold');
  assert.match(io.stderr.join(''), /no longer waiting/i);
});

// ── Per-turn consent ───────────────────────────────────────────────────────

test('nothing runs until the operator says yes at their own keyboard', async () => {
  const api = fakeApi({ '/decline': { status: 200, data: {} } });
  const io = fakeIo();
  let ran = false;
  const runtime = { RUNTIME_ID: 'claude-code', async run() { ran = true; return {}; } };

  for (const answer of ['n', '', 'sure', 'Y E S', 'yep']) {
    api.calls.length = 0;
    // eslint-disable-next-line no-await-in-loop
    await agent.runOneTurn(api, { turnId: '11', prompt: 'go', mode: 'build' }, {
      repo: root, leaseId: '7', runtime, binary: 'claude', ask: async () => answer,
    }, io);
    assert.equal(ran, false, `"${answer}" must not start a turn`);
    // Not accepted, and the platform is told WHY so the chat can say
    // "Declined on your machine" rather than sitting on an offer timeout.
    assert.equal(api.calls.some((c) => c.pathname.includes('/accept')), false, answer);
    const declined = api.calls.find((c) => c.pathname.includes('/decline'));
    assert.ok(declined, `"${answer}" reports the decline`);
    assert.match(declined.body.reason, /Declined at the terminal/);
  }

  // Only an explicit yes runs it — and the confirmation happens BEFORE the
  // accept, because accepting is what makes the web page say "your machine is
  // working on it".
  api.calls.length = 0;
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go', mode: 'build' }, {
    repo: root, leaseId: '7', runtime, binary: 'claude', ask: async () => ' YES \n',
  }, io);
  assert.equal(ran, true);
  assert.match(api.calls[0].pathname, /\/accept$/);
});

test('a terminal with no interactive stdin is a decline, never an implied yes', async () => {
  // main.js's io.ask resolves null when process.stdin is not a TTY. That must
  // read as "nobody could confirm", because the alternative is Usernode
  // starting a process on a machine with nobody watching.
  const api = fakeApi({ '/decline': { status: 200, data: {} } });
  const io = fakeIo();
  let ran = false;
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go', mode: 'build' }, {
    repo: root, leaseId: '7', binary: 'claude', ask: async () => null,
    runtime: { RUNTIME_ID: 'claude-code', async run() { ran = true; return {}; } },
  }, io);
  assert.equal(ran, false);
  assert.match(
    api.calls.find((c) => c.pathname.includes('/decline')).body.reason,
    /no interactive terminal/
  );

  // …and so is a context with no `ask` wired at all.
  api.calls.length = 0;
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go', mode: 'build' }, {
    repo: root, leaseId: '7', binary: 'claude',
    runtime: { RUNTIME_ID: 'claude-code', async run() { ran = true; return {}; } },
  }, io);
  assert.equal(ran, false);
});

test('the confirmation shows what is being agreed to, bounded', async () => {
  const io = fakeIo();
  const asked = [];
  const consent = await agent.confirmTurn(
    { turnId: '11', prompt: `CODING TASK\n${'x'.repeat(5000)}\nlast line` },
    agent.MODES.build,
    { repo: '/home/dev/app', ask: async (q) => { asked.push(q); return 'n'; } },
    io
  );
  assert.equal(consent.ok, false);
  assert.match(asked[0], /\[y\/N\]/);
  const shown = io.stdout.join('');
  assert.match(shown, /Turn 11/);
  assert.match(shown, /coding turn/);
  assert.match(shown, /\/home\/dev\/app/, 'the operator sees WHICH checkout');
  assert.ok(
    shown.length < agent.CONFIRM_PREVIEW_CHARS + 800,
    'a 5000-char prompt is previewed, not dumped over the terminal'
  );
});

test('the confirmation says plainly which kind of turn it is', async () => {
  for (const [mode, wording] of [
    [agent.MODES.build, /write code in/],
    [agent.MODES.scout, /read \(no edits, no commits\) in/],
  ]) {
    const io = fakeIo();
    // eslint-disable-next-line no-await-in-loop
    await agent.confirmTurn({ turnId: '4', prompt: 'p' }, mode,
      { repo: '/r', ask: async () => 'n' }, io);
    assert.match(io.stdout.join(''), wording);
  }
});

// ── Scout / read-only turns ────────────────────────────────────────────────

// A read-only turn checks (and if necessary restores) the working tree, so it
// must never be pointed at this repo. One throwaway git repo, shared.
function tempRepo() {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-scout-'));
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  return { dir, run };
}

test('a scout turn runs the runtime read-only and never uploads a commit', async () => {
  const { dir } = tempRepo();
  const api = fakeApi({ '/accept': { status: 200, data: {} }, '/result': { status: 200, data: {} } });
  const io = fakeIo();
  let sawOptions = null;
  const spec = '# Sticky header\n\n## User-facing changes\n\nIt sticks.\n';
  const runtime = {
    RUNTIME_ID: 'claude-code',
    async run(options) {
      sawOptions = options;
      return { exitCode: 0, isError: false, summary: spec, stderr: '' };
    },
  };
  await agent.runOneTurn(api, { turnId: '11', prompt: 'draft it', mode: 'scout' }, {
    repo: dir, leaseId: '7', runtime, binary: 'claude', ask: async () => 'y',
    // Even an operator who asked for the worker's posture does not get it on a
    // turn the platform declared read-only.
    skipPermissions: true,
  }, io);

  assert.equal(sawOptions.readOnly, true, 'the adapter is told to run read-only');
  assert.equal(sawOptions.skipPermissions, false, 'and the opt-in is dropped for it');

  assert.equal(api.calls.some((c) => c.pathname.includes('/commit')), false,
    'a read-only turn never uploads a commit');
  const result = api.calls.find((c) => c.pathname.includes('/result'));
  assert.equal(result.body.status, 'completed');
  assert.equal(result.body.headSha, null, 'and never claims one');
  assert.equal(result.body.specMd, spec, 'the drafted spec is the product');
  assert.match(io.stdout.join(''), /drafted a \d+-line spec/);
});

test('a scout run that produced no spec text is a failure, not a silent success', async () => {
  const { dir } = tempRepo();
  const api = fakeApi({ '/accept': { status: 200, data: {} }, '/result': { status: 200, data: {} } });
  const io = fakeIo();
  await agent.runOneTurn(api, { turnId: '11', prompt: 'draft it', mode: 'scout' }, {
    repo: dir, leaseId: '7', binary: 'claude', ask: async () => 'y',
    runtime: {
      RUNTIME_ID: 'claude-code',
      async run() { return { exitCode: 0, isError: false, summary: '  \n ', stderr: '' }; },
    },
  }, io);
  const result = api.calls.find((c) => c.pathname.includes('/result'));
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.specMd, null);
  assert.match(result.body.error, /no spec text/);
});

test('a read-only turn that leaves the tree dirty restores it and never uploads it', async () => {
  const { dir, run } = tempRepo();
  const api = fakeApi({ '/accept': { status: 200, data: {} }, '/result': { status: 200, data: {} } });
  const io = fakeIo();
  await agent.runOneTurn(api, { turnId: '11', prompt: 'draft it', mode: 'scout' }, {
    repo: dir, leaseId: '7', binary: 'claude', ask: async () => 'y',
    runtime: {
      RUNTIME_ID: 'claude-code',
      async run() {
        // A tool that ignored the permission mode, or a stray temp file.
        fs.writeFileSync(path.join(dir, 'README.md'), 'edited by a read-only run\n');
        fs.writeFileSync(path.join(dir, 'scratch.txt'), 'oops\n');
        return { exitCode: 0, isError: false, summary: '# spec', stderr: '' };
      },
    },
  }, io);
  assert.equal(
    String(run('status', '--porcelain')).trim(), '',
    'the tree is restored rather than carried into a commit'
  );
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(api.calls.some((c) => c.pathname.includes('/commit')), false);
  assert.match(io.stderr.join(''), /read-only turn left/i);
});

test('the read-only mode is enforced by how the binary is invoked, not by the prompt', () => {
  // A prompt saying "do not edit" is a request. `plan` plus a disallowed-tools
  // list is the actual lock, and there are two of them so a permission-mode
  // rename cannot silently re-enable editing on someone's own checkout.
  assert.equal(claudeCode.READ_ONLY_PERMISSION_MODE, 'plan');
  assert.deepEqual(claudeCode.READ_ONLY_DISALLOWED_TOOLS,
    ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  assert.match(runtimeSource, /if \(readOnly\) \{[\s\S]{0,200}READ_ONLY_PERMISSION_MODE/);
  assert.match(runtimeSource, /--disallowedTools/);
  // readOnly is checked FIRST, so it can never be combined with
  // --dangerously-skip-permissions from any call site.
  const order = runtimeSource.indexOf('if (readOnly) {');
  assert.ok(order > 0 && order < runtimeSource.indexOf("'--dangerously-skip-permissions'"));
});

test('MODES covers exactly the wire values, and an unknown one falls back to build', () => {
  assert.deepEqual(Object.keys(agent.MODES).sort(), ['build', 'scout']);
  const localAgent = require('../src/services/local-agent');
  assert.deepEqual([...localAgent.TURN_MODES].sort(), Object.keys(agent.MODES).sort());
  assert.equal(agent.MODES.scout.readOnly, true);
  assert.equal(agent.MODES.build.readOnly, false);
  // An older CLI meeting a newer platform must not treat an unrecognised mode
  // as read-only-by-accident or writable-by-accident: it runs it as a build,
  // and the platform's own mode guards refuse anything inappropriate.
  assert.match(agentSource, /MODES\[turn\.mode\] \|\| MODES\.build/);
});

test('error codes are translated into something a person can act on', () => {
  const cases = {
    lease_held: /Detach it from Settings/,
    insufficient_scope: /social-vibecoding login/,
    tree_mismatch: /nothing was pushed/,
    lease_lost: /re-attach/i,
    session_not_attachable: /no longer taking coding turns/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.match(agent.describeError({ status: 409, data: { error: code } }), expected, code);
  }
  // An unknown code still says something, rather than "undefined".
  assert.equal(agent.describeError({ status: 500, data: {} }), 'HTTP 500');
  assert.equal(agent.describeError({ status: 503, data: { error: 'weird' } }), 'weird');
});

test('the label defaults to a bounded, single-segment hostname', () => {
  const label = agent.defaultLabel();
  assert.ok(label.length >= 1 && label.length <= 64);
  assert.equal(label.includes('.'), false, 'a FQDN is noise in a chat status line');
  // The server-side validator has to accept whatever this produces.
  assert.equal(require('../src/services/local-agent').isValidLabel(label), true);
});

test('run always detaches, even when the poll loop throws', () => {
  // A machine that exits without releasing its lease blocks the session for
  // the full TTL. The detach lives in a finally for exactly that reason.
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  const finallyBlock = runBlock.slice(runBlock.lastIndexOf('} finally {'));
  assert.match(finallyBlock, /\/api\/cli\/agent\/detach/);
  assert.match(finallyBlock, /clearInterval\(heartbeat\)/);
  assert.match(finallyBlock, /removeListener\('SIGINT'/);
});

test('the poll deadline is longer than the server\'s own long-poll window', () => {
  const localAgent = require('../src/services/local-agent');
  assert.ok(agent.POLL_DEADLINE_MS > localAgent.LONG_POLL_MS,
    'the server should answer its own poll, not have the client time it out');
  assert.equal(agent.HEARTBEAT_MS, localAgent.HEARTBEAT_MS);
});

test('agent run validates its session id before touching the network', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: () => ({ options: { session: '0' }, positional: [] }),
    state: { async selectedProfile() { throw new Error('should not be reached'); } },
    async authorizedToken() { throw new Error('should not be reached'); },
  };
  await assert.rejects(
    () => agent.agentCommand(['run'], io, deps),
    /canonical positive session ID/
  );
});

test('an unknown runtime is refused by name', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: () => ({ options: { session: '42', runtime: 'codex' }, positional: [] }),
    state: { async selectedProfile() { throw new Error('unreachable'); } },
    async authorizedToken() { throw new Error('unreachable'); },
  };
  await assert.rejects(() => agent.agentCommand(['run'], io, deps), /Unknown runtime 'codex'/);
});

test('agent detach insists on a canonical lease id', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: (args, allowed) => {
      assert.ok(allowed.has('--lease'));
      return { options: { lease: '007' }, positional: [] };
    },
    state: { async selectedProfile() { throw new Error('unreachable'); } },
    async authorizedToken() { throw new Error('unreachable'); },
  };
  await assert.rejects(() => agent.agentCommand(['detach'], io, deps), /canonical positive lease ID/);
});

test('an unknown subcommand shows the group usage', async () => {
  await assert.rejects(() => agent.agentCommand(['frobnicate'], fakeIo(), {}),
    /agent run\|status\|detach/);
});

// ── main.js wiring ─────────────────────────────────────────────────────────

test('the boolean flags parse as flags, not as options missing a value', () => {
  const main = require('../src/cli/main');
  assert.ok(main.VALUELESS_OPTIONS.has('--once'));
  assert.ok(main.VALUELESS_OPTIONS.has('--dangerously-skip-permissions'));
  const { options } = main.parseOptions(
    ['--session', '42', '--once'],
    new Set(['--session', '--once'])
  );
  assert.equal(options.session, '42');
  assert.equal(options.once, true);
});

test('a pre-#907 credential fails up front, not forty minutes into a poll', () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/cli/main.js'), 'utf8');
  const fn = mainSource.slice(
    mainSource.indexOf('async function authorizedToken'),
    mainSource.indexOf('async function authorizedToken') + 2000
  );
  assert.match(fn, /REQUIRED_SCOPES/);
  assert.match(agentSource, /authorizedToken/);
  // agent run calls it before attach, so an old grant re-prompts for consent
  // immediately instead of after the first turn arrives.
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  assert.ok(
    runBlock.indexOf('authorizedToken(profile') < runBlock.indexOf('/api/cli/agent/attach'),
    'authorize before attaching'
  );
});

test('the agent commands are documented in the CLI usage text', () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/cli/main.js'), 'utf8');
  for (const line of ['agent run', 'agent status', 'agent detach']) {
    assert.ok(mainSource.includes(line), `usage must mention \`${line}\``);
  }
});
