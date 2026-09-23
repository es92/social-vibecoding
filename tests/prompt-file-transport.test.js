// Tests for the file-based dispatch prompt and hosted-Claude system-context
// transports (the prompt path originated in prod session 2538): the task
// prompt used to travel as a single `docker exec -e
// PROMPT=<value>` argument, and Linux caps one argv/env string at
// 128 KiB (MAX_ARG_STRLEN) — a session whose spec doc grew past ~60 KB
// (on top of the ~68 KB conventions block) E2BIG'd every dispatch before
// the exec existed. The prompt now travels via stdin into a file in the
// CC volume (worker.TURN_PROMPT_PATH) and run-cc.sh pipes it to the
// claude CLI from disk.
//
//   1. Unit tests for the pure prompt-file script builder (base64
//      round-trip at >200KB — the size class the old path could not
//      dispatch).
//   2. Behavioral tests of both required file writers against a mocked
//      docker.execShellStdin.
//   3. Source guards: execInWorker writes the prompt file BEFORE the
//      detached dispatch and no longer puts the prompt in the exec env;
//      run-cc.sh consumes the file on stdin, never as a `-p` argument.
//   4. describeTurnError maps E2BIG to actionable, non-"just retry"
//      language.
//
// Run with: node --test tests/prompt-file-transport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');
const {
  buildCodingAgentBuildGuidance,
  buildCodingAgentConventionsContext,
  buildHostedCodingWorkflowGuidance,
  buildCodingAgentSpecContext,
  canReuseHostedClaudeScoutSpec,
  describeTurnError,
} = require('../src/routes/sessions');
const { IN_LOOP_BROWSER_GUIDANCE } = require('../src/services/in-loop-browser');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Decode the prompt a buildTurnPromptScript-style script would write:
// concatenate the quoted chunks appended to the .b64 staging file.
function decodeScriptPayload(script) {
  const chunks = [...script.matchAll(/printf '%s' '([^']*)' >> \S+\.b64/g)]
    .map((m) => m[1]);
  return Buffer.from(chunks.join(''), 'base64').toString('utf8');
}

test('hosted Claude receives conventions once as system context, while unchanged backends keep them inline', () => {
  const conventions = 'SENTINEL platform rule\nsecond rule';

  const hosted = buildCodingAgentConventionsContext({ conventions });
  assert.match(hosted.systemPrompt, /SENTINEL platform rule/);
  assert.doesNotMatch(hosted.promptBlock, /SENTINEL platform rule/);
  assert.match(hosted.promptBlock, /supplied separately as authoritative\nsystem instructions/);

  const local = buildCodingAgentConventionsContext({ runLocally: true, conventions });
  assert.equal(local.systemPrompt, null);
  assert.match(local.promptBlock, /SENTINEL platform rule/);

  const codex = buildCodingAgentConventionsContext({ isCodexSession: true, conventions });
  assert.equal(codex.systemPrompt, null);
  assert.match(codex.promptBlock, /SENTINEL platform rule/);
});

test('hosted build guidance keeps proposal submission with the harness and evidence intent with the agent', () => {
  const hosted = buildHostedCodingWorkflowGuidance();
  assert.match(hosted, /HOSTED WORKER LIFECYCLE/);
  assert.match(hosted, /record_visual_evidence_intent/);
  assert.match(hosted, /harness handles push, pull request/);
  assert.match(hosted, /Do not run\s+that skill, the social-vibecoding CLI/);
  assert.match(hosted, /Do not create platform users or tokens/);
  assert.equal(buildHostedCodingWorkflowGuidance({ runLocally: true }), '');
  const sessionsSource = read('src/routes/sessions.js');
  assert.match(sessionsSource, /const workflowGuidance = buildHostedCodingWorkflowGuidance\(\{ runLocally \}\)/);
  assert.match(sessionsSource, /INSTRUCTIONS:\n\$\{workflowGuidance\}\n\$\{turnInstructions\}/);
});

test('hosted Claude references system build guidance while local and Codex share the reviewed inline contract', () => {
  const hosted = buildCodingAgentBuildGuidance({ authoritativeSystemContext: true });
  const local = buildCodingAgentBuildGuidance();
  const codex = buildCodingAgentBuildGuidance();
  const hostedText = `${hosted.browserGuidance}\n${hosted.testingGuidance}`;
  const localText = `${local.browserGuidance}\n${local.testingGuidance}`;

  assert.deepEqual(codex, local, 'local Claude and Codex retain the same inline block');
  assert.equal(local.browserGuidance, IN_LOOP_BROWSER_GUIDANCE);
  assert.equal(
    crypto.createHash('sha256').update(localText).digest('hex'),
    '8de7e32ac2790ff0522036cf962319799561359576cb95815abb01c88781cbcb',
    'the non-system-prompt backends retain their exact reviewed guidance',
  );
  assert.match(localText, /falls back to the home page and records that\n\s+default/);

  assert.match(hostedText, /authoritative system instructions/);
  assert.match(hostedText, /usernode-run-checks --changed/);
  assert.match(hostedText, /==== TESTING ====/);
  assert.match(hostedText, /one to three relative "path:" lines/);
  assert.match(hostedText, /The block must be LAST/);
  assert.doesNotMatch(hostedText, /A BLANK or empty-looking page/);
  assert.doesNotMatch(hostedText, /Standalone server pages/);
  assert.ok(
    localText.length - hostedText.length >= 7000,
    `hosted guidance should remove at least 7,000 repeated characters (saved ${localText.length - hostedText.length})`,
  );

  const conventions = read('src/prompts/app-conventions.md');
  assert.match(conventions, /## In-loop browser \(build turns\)/);
  assert.match(conventions, /## Proposal tests/);
  assert.match(conventions, /## Staging mock data/);
  assert.match(conventions, /### Make the changed screen URL-reachable/);

  for (const options of [{}, { runLocally: true }, { isCodexSession: true }]) {
    const context = buildCodingAgentConventionsContext({
      ...options,
      conventions: 'SENTINEL platform rule',
    });
    const guidance = buildCodingAgentBuildGuidance({
      authoritativeSystemContext: Boolean(context.systemPrompt),
    });
    assert.equal(
      context.systemPrompt !== null,
      guidance.browserGuidance !== IN_LOOP_BROWSER_GUIDANCE,
      'compact guidance is used exactly when the authoritative handbook is system context',
    );
  }
});

test('spec context keeps a complete user-level fallback and a content-free resumed reference', () => {
  const sentinel = 'SENTINEL exact saved spec\nwith a second line';
  const context = buildCodingAgentSpecContext({
    currentSpec: sentinel,
    specTaskReference: 'The coding task selects this turn',
  });

  assert.match(context.fullBlock, /SENTINEL exact saved spec/);
  assert.match(context.fullBlock, /authoritative for what to build/);
  assert.doesNotMatch(context.resumedBlock, /SENTINEL exact saved spec/);
  assert.match(context.resumedBlock, /immediately preceding assistant response/);
  assert.match(context.resumedBlock, /The coding task selects this turn/);
  assert.deepEqual(
    buildCodingAgentSpecContext({ currentSpec: '   ' }),
    { fullBlock: '', resumedBlock: '' },
  );
});

test('scout-to-build reuse requires the latest exact hosted-Claude publication receipt', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ reusable: true }] };
    },
  };

  assert.equal(await canReuseHostedClaudeScoutSpec(pool, 717, '# Exact spec'), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [717, '# Exact spec']);
  assert.match(calls[0].sql, /scoutConversationSpecExact/);
  assert.match(calls[0].sql, /agentBackend' = 'claude_code'/);
  assert.match(calls[0].sql, /NOT \(metadata \? 'runner'\)/);
  assert.match(calls[0].sql, /content = 'Claude Code progress'/);
  assert.match(calls[0].sql, /ORDER BY id DESC\s+LIMIT 1/);

  assert.equal(await canReuseHostedClaudeScoutSpec({
    query: async () => ({ rows: [{ reusable: false }] }),
  }, 717, '# Changed spec'), false);
  assert.equal(await canReuseHostedClaudeScoutSpec(pool, 717, ''), false);
  assert.equal(calls.length, 1, 'an empty spec never reaches the database');
});

// ── 1. buildTurnPromptScript ────────────────────────────────────────────

test('buildTurnPromptScript round-trips a >200KB prompt (the size the old argv path could not dispatch)', () => {
  // Realistic composition: conventions-block-sized text + spec-sized
  // text, with shell-hostile characters mixed in.
  const prompt = `USER REQUEST: "build it"\n'"\`$PATH\\ ${'x'.repeat(120000)}\n${'y'.repeat(120000)} — done`;
  assert.ok(Buffer.byteLength(prompt, 'utf8') > 200 * 1024 * 0.99);

  const script = worker.buildTurnPromptScript(prompt);
  assert.equal(decodeScriptPayload(script), prompt);

  // The staged base64 is decoded into the canonical prompt path and the
  // staging file is cleaned up.
  assert.match(script, new RegExp(`base64 -d < ${worker.TURN_PROMPT_PATH}\\.b64 > ${worker.TURN_PROMPT_PATH}\n`));
  assert.match(script, new RegExp(`rm -f ${worker.TURN_PROMPT_PATH}\\.b64`));
  assert.match(script, /^set -e\n/);
});

test('buildTurnPromptScript chunks the base64 payload (no single unbounded shell word)', () => {
  const script = worker.buildTurnPromptScript('z'.repeat(300 * 1024));
  const chunks = [...script.matchAll(/printf '%s' '([^']*)'/g)].map((m) => m[1]);
  assert.ok(chunks.length >= 2, 'large prompts split across multiple printf lines');
  for (const c of chunks) {
    assert.ok(c.length <= 64 * 1024, `chunk of ${c.length} exceeds the 64KiB bound`);
  }
});

test('buildTurnPromptScript base64 payload never contains quote characters (safe to single-quote)', () => {
  const script = worker.buildTurnPromptScript(`it's a "prompt" with \\'quotes\\'`);
  for (const [, payload] of script.matchAll(/printf '%s' '([^']*)'/g)) {
    assert.doesNotMatch(payload, /['"\\$]/);
  }
});

test('buildTurnSystemPromptScript round-trips the full conventions at its separate path', () => {
  const systemPrompt = `==== PLATFORM CONVENTIONS ====\n${'rules\n'.repeat(30000)}`;
  const script = worker.buildTurnSystemPromptScript(systemPrompt);

  assert.equal(decodeScriptPayload(script), systemPrompt);
  assert.match(script, new RegExp(
    `base64 -d < ${worker.TURN_SYSTEM_PROMPT_PATH}\\.b64 > ${worker.TURN_SYSTEM_PROMPT_PATH}\n`
  ));
  assert.doesNotMatch(script, new RegExp(`${worker.TURN_PROMPT_PATH}\\.b64`));
});

test('buildTurnResumeFallbackPromptScript round-trips the complete fresh-run prompt separately', () => {
  const fallbackPrompt = `FULL SPEC ${'f'.repeat(180 * 1024)}`;
  const script = worker.buildTurnResumeFallbackPromptScript(fallbackPrompt);

  assert.equal(decodeScriptPayload(script), fallbackPrompt);
  assert.match(script, new RegExp(
    `base64 -d < ${worker.TURN_RESUME_FALLBACK_PROMPT_PATH}\\.b64 > ${worker.TURN_RESUME_FALLBACK_PROMPT_PATH}\\n`
  ));
  assert.doesNotMatch(script, new RegExp(`${worker.TURN_PROMPT_PATH}\\.b64`));
  assert.doesNotMatch(script, new RegExp(`${worker.TURN_SYSTEM_PROMPT_PATH}\\.b64`));
});

// ── 2. writeTurnPrompt (mocked docker boundary) ─────────────────────────

test('writeTurnPrompt materializes the prompt via stdin into the session worker', async () => {
  const SID = 990001;
  worker.adoptWarmWorker(SID);

  const calls = [];
  const orig = docker.execShellStdin;
  docker.execShellStdin = async (containerName, script, opts) => {
    calls.push({ containerName, script, opts });
  };
  try {
    const prompt = `SPEC ${'s'.repeat(220 * 1024)}`;
    await worker.writeTurnPrompt(SID, prompt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].containerName, `usernode-worker-${SID}`);
    assert.equal(decodeScriptPayload(calls[0].script), prompt);
    assert.equal(calls[0].opts.label, 'writeTurnPrompt');
  } finally {
    docker.execShellStdin = orig;
    worker.evictWorker(SID);
  }
});

test('writeTurnPrompt rejects when no warm worker is registered (required file, unlike personal-files sync)', async () => {
  await assert.rejects(
    () => worker.writeTurnPrompt(990002, 'p'),
    /no warm worker registered/
  );
});

test('writeTurnSystemPrompt materializes required system context in the same worker volume', async () => {
  const SID = 990003;
  worker.adoptWarmWorker(SID);

  const calls = [];
  const orig = docker.execShellStdin;
  docker.execShellStdin = async (containerName, script, opts) => {
    calls.push({ containerName, script, opts });
  };
  try {
    const systemPrompt = `CONVENTIONS ${'c'.repeat(140 * 1024)}`;
    await worker.writeTurnSystemPrompt(SID, systemPrompt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].containerName, `usernode-worker-${SID}`);
    assert.equal(decodeScriptPayload(calls[0].script), systemPrompt);
    assert.equal(calls[0].opts.label, 'writeTurnSystemPrompt');
  } finally {
    docker.execShellStdin = orig;
    worker.evictWorker(SID);
  }
});

test('writeTurnSystemPrompt uses Kubernetes exec without invoking Docker', async () => {
  const SID = 990005;
  const runtimeName = `sv-worker-s${SID}`;
  worker.adoptWarmWorker(SID, runtimeName);

  const calls = [];
  const originalRuntime = process.env.WORKER_RUNTIME;
  const originalKubernetesExec = kubernetes.execInWorker;
  const originalKubernetesDelete = kubernetes.deleteWorker;
  const originalDockerExec = docker.execShellStdin;
  process.env.WORKER_RUNTIME = 'kubernetes';
  kubernetes.execInWorker = async (config, name, command, stdinText) => {
    calls.push({ config, name, command, stdinText });
  };
  docker.execShellStdin = async () => {
    throw new Error('Docker must not be invoked for a Kubernetes worker');
  };
  kubernetes.deleteWorker = async () => {};
  try {
    const systemPrompt = `CONVENTIONS ${'k'.repeat(140 * 1024)}`;
    await worker.writeTurnSystemPrompt(SID, systemPrompt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, runtimeName);
    assert.deepEqual(calls[0].command, ['sh', '-s']);
    assert.equal(decodeScriptPayload(calls[0].stdinText), systemPrompt);
    assert.equal(calls[0].config.kubernetes.workerNamespace, 'social-workers');
  } finally {
    await worker.evictWorker(SID);
    if (originalRuntime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = originalRuntime;
    kubernetes.execInWorker = originalKubernetesExec;
    kubernetes.deleteWorker = originalKubernetesDelete;
    docker.execShellStdin = originalDockerExec;
  }
});

test('writeTurnResumeFallbackPrompt materializes the complete fallback in the same worker volume', async () => {
  const SID = 990004;
  worker.adoptWarmWorker(SID);

  const calls = [];
  const orig = docker.execShellStdin;
  docker.execShellStdin = async (containerName, script, opts) => {
    calls.push({ containerName, script, opts });
  };
  try {
    const fallbackPrompt = `FULL SPEC ${'f'.repeat(160 * 1024)}`;
    await worker.writeTurnResumeFallbackPrompt(SID, fallbackPrompt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].containerName, `usernode-worker-${SID}`);
    assert.equal(decodeScriptPayload(calls[0].script), fallbackPrompt);
    assert.equal(calls[0].opts.label, 'writeTurnResumeFallbackPrompt');
  } finally {
    docker.execShellStdin = orig;
    worker.evictWorker(SID);
  }
});

// ── 3. Source guards — worker.js dispatch wiring ────────────────────────

test('execInWorker writes the prompt file before the detached dispatch and never puts the prompt in exec env', () => {
  const src = read('src/services/worker.js');

  // No `PROMPT: <value>` env entry anywhere — the env carries only the
  // short constant path.
  assert.doesNotMatch(src, /PROMPT:\s*prompt/);
  assert.match(src, /PROMPT_FILE:\s*TURN_PROMPT_PATH/);
  assert.match(src, /RESUME_FALLBACK_PROMPT_FILE:\s*resumeFallbackPrompt/);
  assert.match(src, /SYSTEM_PROMPT_FILE:\s*systemPrompt \? TURN_SYSTEM_PROMPT_PATH : ''/);

  // Ordering: the file write happens before the `docker exec -d`
  // dispatch inside execInWorker.
  const writeIdx = src.indexOf('await writeTurnPrompt(sessionId, prompt)');
  const dispatchIdx = src.indexOf("'exec', '-d',");
  assert.ok(writeIdx !== -1, 'execInWorker awaits writeTurnPrompt');
  assert.ok(dispatchIdx !== -1, 'detached dispatch present');
  assert.ok(writeIdx < dispatchIdx, 'prompt file is written before the dispatch args are built');
  const writeSystemIdx = src.indexOf('await writeTurnSystemPrompt(sessionId, systemPrompt)');
  assert.ok(writeSystemIdx !== -1 && writeSystemIdx < dispatchIdx,
    'required system context is written before detached dispatch');
  const writeFallbackIdx = src.indexOf(
    'await writeTurnResumeFallbackPrompt(sessionId, resumeFallbackPrompt)',
  );
  assert.ok(writeFallbackIdx !== -1 && writeFallbackIdx < dispatchIdx,
    'the complete fresh fallback is written before detached dispatch');

  // The detached wrapper removes the consumed prompt file when the turn
  // ends, except for the structured missing-thread hand-off: attempt two
  // (including restart recovery) still needs the exact original prompt.
  // This decision must finish before the exit marker releases the host to
  // launch attempt two; otherwise the old wrapper can delete its prompt.
  assert.match(src, /grep -qE [^\n]*agent_retry_fresh=1/);
  assert.match(src, /rm -f "\$PROMPT_FILE" 2>\/dev\/null; fi/);
  assert.match(src, /rm -f "\$RESUME_FALLBACK_PROMPT_FILE" 2>\/dev\/null; fi/);
  assert.match(src, /rm -f "\$SYSTEM_PROMPT_FILE" 2>\/dev\/null; fi/);
  assert.match(src, /filesToRemove\.push\([\s\S]*TURN_PROMPT_PATH,[\s\S]*TURN_SYSTEM_PROMPT_PATH,[\s\S]*TURN_RESUME_FALLBACK_PROMPT_PATH/,
    'durable recovery cleanup owns and removes all shared turn-context files');
  const retryDecisionIdx = src.indexOf('if ! grep -qE');
  const exitMarkerIdx = src.indexOf('__USERNODE_EXIT__ $TURN_EXIT');
  const promptCleanupIdx = src.indexOf('rm -f "$PROMPT_FILE" 2>/dev/null; fi');
  assert.ok(retryDecisionIdx !== -1 && retryDecisionIdx < promptCleanupIdx,
    'the retry marker is inspected before cleanup');
  assert.ok(promptCleanupIdx < exitMarkerIdx,
    'all prompt retention work finishes before the host-visible exit marker');
});

// ── 3b. Source guards — run-cc.sh consumption ───────────────────────────

test('run-cc.sh pipes the prompt file to claude on stdin, never as a -p argument', () => {
  const cc = read('worker/run-cc.sh');

  // The build/scout invocations read stdin from the file; an inline
  // `-p "$PROMPT"` would just move the 128KiB E2BIG inside the container.
  assert.doesNotMatch(cc, /-p "\$PROMPT"/);
  assert.doesNotMatch(cc, /\$\{PROMPT:\?/);
  const ordinaryPromptInvocations = cc.match(/--output-format stream-json < "\$PROMPT_FILE"/g) || [];
  assert.equal(ordinaryPromptInvocations.length, 2,
    'resume and ordinary fresh invocations read the normal prompt file');
  assert.match(cc, /--output-format stream-json < "\$RETRY_PROMPT_FILE"/,
    'the resume failure reads the selected complete fallback prompt');

  // Required-env guard: fail fast when the host did not materialize the
  // file (or wrote it empty).
  assert.match(cc, /\$\{PROMPT_FILE:\?PROMPT_FILE required\}/);
  assert.match(cc, /\[ -s "\$PROMPT_FILE" \] \|\| die "prompt file missing or empty/);
  assert.match(cc, /\[ -s "\$RESUME_FALLBACK_PROMPT_FILE" \]/);
  assert.match(cc, /RESUME_FALLBACK_PROMPT_FILE requires CLAUDE_RESUME_SESSION_ID/);

  // A supplied system-prompt path is required and applied to every physical
  // Claude invocation, including resume failure's fresh retry.
  assert.match(cc, /\{ \[ "\$MODE" = "build" \] \|\| \[ "\$MODE" = "evidence" \]; \} && \[ -z "\$SYSTEM_PROMPT_FILE" \]/,
    'hosted builds and evidence turns fail closed if system context is omitted');
  assert.match(cc, /\[ -s "\$SYSTEM_PROMPT_FILE" \]/);
  const systemPromptInvocations = cc.match(/\$SYSTEM_PROMPT_FLAGS --verbose/g) || [];
  assert.equal(systemPromptInvocations.length, 3,
    'resume, resume-retry-fresh, and fresh invocations all append system context');

  // The in-container sync-conflict prompt is small and locally built —
  // it legitimately stays an inline argument.
  assert.match(cc, /-p "\$SYNC_PROMPT"/);
});

test('run-cc.sh uses compact input for resume and the complete input for its fresh fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-system-prompt-'));
  const bin = path.join(dir, 'bin');
  const workspace = path.join(dir, 'workspace');
  const prompt = path.join(dir, 'prompt.txt');
  const fallbackPrompt = path.join(dir, 'fallback-prompt.txt');
  const systemPrompt = path.join(dir, 'system-prompt.txt');
  const invocationLog = path.join(dir, 'invocations.log');
  const inputLog = path.join(dir, 'input');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(prompt, 'compact: use the preceding scout spec');
  fs.writeFileSync(fallbackPrompt, 'complete: FULL SPEC and requested change');
  fs.writeFileSync(systemPrompt, 'authoritative platform rules');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$*" in
  *"rev-parse --abbrev-ref HEAD"*) echo test ;;
  *"rev-list --count"*) echo 0 ;;
  *"rev-parse HEAD"*) echo test-sha ;;
esac
exit 0
`);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf '%s\\n' "$*" >> "$INVOCATION_LOG"
COUNT=$(wc -l < "$INVOCATION_LOG" | tr -d ' ')
cat > "$INPUT_LOG.$COUNT"
if printf '%s\\n' "$*" | grep -q -- '--resume'; then exit 2; fi
echo '{"type":"result","result":"ok","session_id":"fresh-session"}'
exit 0
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  const result = spawnSync('sh', [path.join(__dirname, '..', 'worker', 'run-cc.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INVOCATION_LOG: invocationLog,
      INPUT_LOG: inputLog,
      PROMPT_FILE: prompt,
      RESUME_FALLBACK_PROMPT_FILE: fallbackPrompt,
      SYSTEM_PROMPT_FILE: systemPrompt,
      CLAUDE_RESUME_SESSION_ID: 'stale-session',
      MODE: 'build',
      BRANCH: 'test',
      SESSION_ID: '1',
      WORKER_JWT: 'test-worker-jwt',
      PLATFORM_URL: 'http://platform',
      WORKSPACE_DIR: workspace,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const invocations = fs.readFileSync(invocationLog, 'utf8').trim().split('\n');
  assert.equal(invocations.length, 2, 'one resume and one fresh physical invocation');
  for (const invocation of invocations) {
    assert.match(invocation, new RegExp(
      `--append-system-prompt-file ${systemPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    ));
  }
  assert.match(invocations[0], /--resume stale-session/);
  assert.doesNotMatch(invocations[1], /--resume/);
  assert.equal(fs.readFileSync(`${inputLog}.1`, 'utf8'), 'compact: use the preceding scout spec');
  assert.equal(fs.readFileSync(`${inputLog}.2`, 'utf8'), 'complete: FULL SPEC and requested change');
});

test('run-cc.sh refuses omitted or missing build system context before invoking Claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-missing-system-prompt-'));
  const bin = path.join(dir, 'bin');
  const workspace = path.join(dir, 'workspace');
  const prompt = path.join(dir, 'prompt.txt');
  const invocationLog = path.join(dir, 'invocations.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(prompt, 'shortened hosted build prompt');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf 'invoked\\n' >> "$INVOCATION_LOG"
exit 0
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    INVOCATION_LOG: invocationLog,
    PROMPT_FILE: prompt,
    MODE: 'build',
    BRANCH: 'test',
    SESSION_ID: '1',
    WORKER_JWT: 'test-worker-jwt',
    PLATFORM_URL: 'http://platform',
    WORKSPACE_DIR: workspace,
  };
  const omitted = spawnSync('sh', [path.join(__dirname, '..', 'worker', 'run-cc.sh')], {
    encoding: 'utf8', env: { ...baseEnv, SYSTEM_PROMPT_FILE: '' },
  });
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.stdout, /SYSTEM_PROMPT_FILE required for build mode/);

  const missingSystemPrompt = path.join(dir, 'does-not-exist.txt');
  const missing = spawnSync('sh', [path.join(__dirname, '..', 'worker', 'run-cc.sh')], {
    encoding: 'utf8', env: { ...baseEnv, SYSTEM_PROMPT_FILE: missingSystemPrompt },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /system prompt file missing or empty/);

  const validSystemPrompt = path.join(dir, 'system-prompt.txt');
  fs.writeFileSync(validSystemPrompt, 'authoritative platform rules');
  const missingFallbackPrompt = path.join(dir, 'does-not-exist-fallback.txt');
  const missingFallback = spawnSync('sh', [path.join(__dirname, '..', 'worker', 'run-cc.sh')], {
    encoding: 'utf8',
    env: {
      ...baseEnv,
      SYSTEM_PROMPT_FILE: validSystemPrompt,
      CLAUDE_RESUME_SESSION_ID: 'stale-session',
      RESUME_FALLBACK_PROMPT_FILE: missingFallbackPrompt,
    },
  });
  assert.notEqual(missingFallback.status, 0);
  assert.match(missingFallback.stdout, /resume fallback prompt file missing or empty/);
  assert.equal(fs.existsSync(invocationLog), false, 'Claude was never invoked');
});

// ── 4. describeTurnError E2BIG mapping ──────────────────────────────────

test('describeTurnError maps spawn E2BIG to actionable language, not the raw errno', () => {
  const friendly = describeTurnError(new Error('spawn E2BIG'));
  assert.doesNotMatch(friendly, /E2BIG/);
  assert.match(friendly, /too large/i);
  assert.match(friendly, /spec|attachment/i);
});

test('describeTurnError leaves unrelated errors verbatim', () => {
  assert.equal(describeTurnError(new Error('boom')), 'boom');
});
