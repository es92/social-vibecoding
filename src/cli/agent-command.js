'use strict';

// `social-vibecoding agent run|status|detach` — the local half of #907.
//
// `agent run` attaches this machine to one Usernode dev session and then sits
// in a long poll. When someone types a message in that session's Dev chat, the
// platform hands the turn here instead of to a worker container: this process
// runs `claude` against a local checkout, streams progress back so the web
// page's progress card stays live, uploads each resulting commit through the
// platform's GitHub App, and reports the outcome. Everything after that —
// staging preview, checks, visuals, PR body — is the platform's normal tail.
//
// Two properties this file exists to preserve:
//
//   1. NO CREDENTIAL EVER CROSSES. The platform never sends an Anthropic key
//      and this process never looks for one; `claude` authenticates itself on
//      this machine exactly as it does interactively. In the other direction
//      the platform receives a prompt's worth of progress text and a commit —
//      never a token, never an env dump.
//   2. NO PUSH ACCESS IS NEEDED. Commits go up as a file-by-file upload that
//      Usernode reconstructs through its GitHub App, and it rejects the
//      result unless the reconstructed tree matches the local one byte for
//      byte. That is why this never runs `git push`, and why it must not be
//      "simplified" into one.
//
// These endpoints live under /api/cli/agent/*, which cli-api-policy
// deliberately excludes from the generic `api` command's allowlist — so this
// module talks to requestJson directly rather than going through
// callUserApi/canonicalApiTarget.

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requestJson, CliHttpError } = require('./http');
const { collectCommitUpload } = require('./git-upload');
const claudeCode = require('./agent-runtimes/claude-code');
// #1204: shared with the platform's own scout path — a runtime whose API
// stream drops reports it as its FINAL message, not in its exit code, and a
// read-only turn's final message is the spec we are about to upload.
// Dependency-free on purpose, so requiring a src/services module from the CLI
// pulls in nothing else.
const { agentApiFailure, describeAgentApiFailure } = require('../services/agent-result-text');

const RUNTIMES = new Map([[claudeCode.RUNTIME_ID, claudeCode]]);
const HEARTBEAT_MS = 30 * 1000;
// Slightly over the server's 30s long-poll window: the request should be
// answered by the server's own timer, not killed by ours.
const POLL_DEADLINE_MS = 45 * 1000;
const COMMIT_UPLOAD_DEADLINE_MS = 2 * 60 * 1000;
// Progress is batched rather than posted per line. A busy turn emits several
// lines a second; one HTTP request each would be silly, and the dev-chat card
// only repaints on poll anyway.
const PROGRESS_FLUSH_MS = 2000;
const PROGRESS_FLUSH_LINES = 25;
const DEFAULT_COMMIT_MESSAGE = 'Changes via Usernode';
const MAX_LABEL_CHARS = 64;
// How much of the dispatch prompt to show in the confirmation, so the operator
// is agreeing to something specific rather than to "a turn".
const CONFIRM_PREVIEW_CHARS = 700;

// What each turn mode means to this process. The platform picks the mode; the
// CLI's job is to run it with the right permissions and hand back the right
// kind of answer. Read-only turns never commit, never upload, and never leave
// the tree different from how they found it.
const MODES = {
  build: {
    label: 'coding turn',
    readOnly: false,
    verb: 'write code in',
  },
  scout: {
    label: 'read-only spec turn',
    readOnly: true,
    verb: 'read (no edits, no commits) in',
  },
};

function defaultLabel() {
  const host = String(os.hostname() || 'this machine').split('.')[0];
  return host.slice(0, MAX_LABEL_CHARS) || 'this machine';
}

function git(repo, args, { maxBuffer = 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer, shell: false, windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') throw new Error('git is required to run a local agent turn');
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  if (result.signal || result.status !== 0) {
    const detail = String(result.stderr || '').trim().split('\n')[0] || '';
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function gitOk(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  return !result.error && !result.signal && result.status === 0;
}

// The turn runs against whatever is on disk, so "whatever is on disk" has to
// be exactly the commit the platform thinks the session is at. Anything else
// and the agent edits the wrong code, or uploads a commit whose parent the
// platform will refuse.
function prepareCheckout(repo, { branch, headSha }, io) {
  const topLevel = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const dirty = git(topLevel, ['status', '--porcelain']).trim();
  if (dirty) {
    throw new Error(
      `${topLevel} has uncommitted changes. Commit or stash them first — a local agent turn starts from a clean tree so the commit it uploads is exactly the work it did.`
    );
  }
  const head = git(topLevel, ['rev-parse', 'HEAD']).trim();
  if (!headSha || head === headSha) return { repo: topLevel, head };

  // Behind (or on the wrong branch). Fetch just what is needed and move.
  io.out(`Checkout is at ${head.slice(0, 8)}; session is at ${headSha.slice(0, 8)} — fetching.\n`);
  if (!gitOk(topLevel, ['fetch', '--depth=1', 'origin', headSha])
      && !gitOk(topLevel, ['fetch', 'origin', branch])) {
    throw new Error(`Could not fetch ${headSha.slice(0, 8)} from origin. Check the remote and retry.`);
  }
  if (!gitOk(topLevel, ['cat-file', '-e', `${headSha}^{commit}`])) {
    throw new Error(`origin does not have ${headSha.slice(0, 8)} yet. Wait for the branch to publish, then retry.`);
  }
  git(topLevel, ['checkout', '-B', branch, headSha]);
  io.out(`Checked out ${branch} at ${headSha.slice(0, 8)}.\n`);
  return { repo: topLevel, head: headSha };
}

class AgentSession {
  constructor({ origin, token, io }) {
    this.origin = origin;
    this.token = token;
    this.io = io;
  }

  async call(method, pathname, body, { deadlineMs = 30000 } = {}) {
    return requestJson(this.origin, pathname, {
      method, body, token: this.token, deadlineMs,
    });
  }
}

function describeError(response) {
  const code = response?.data?.error;
  const map = {
    lease_held: 'Another machine is already attached to this session. Detach it from Settings → Local coding agent, or from that machine.',
    session_not_attachable: 'That session is no longer taking coding turns.',
    not_found: 'No such session, or it is not yours.',
    lease_lost: 'This machine\'s lease expired or was released. Run `agent run` again to re-attach.',
    turn_not_offered: 'That turn is no longer waiting for this machine.',
    turn_not_running: 'That turn already ended (it may have been stopped from the web page).',
    read_only_turn: 'That turn is read-only — it drafts a spec and cannot carry a commit.',
    insufficient_scope: 'This credential predates local coding agents. Run `social-vibecoding login` to re-authorize.',
    branch_moved: 'The branch moved underneath this turn. Re-run it.',
    tree_mismatch: 'The reconstructed commit did not match the local tree; nothing was pushed.',
    parent_tree_mismatch: 'The parent commit on the branch does not match the local parent; nothing was pushed.',
    github_unavailable: 'GitHub is not reachable from the platform right now.',
  };
  return map[code] || code || `HTTP ${response?.status}`;
}

// Everything a running turn needs to talk back to the platform: progress
// batching, the cooperative-stop signal that arrives as a 409 on the progress
// post, and the abort controller the runtime adapter watches.
function progressReporter(api, { turnId, leaseId }) {
  let pending = [];
  let timer = null;
  let inFlight = Promise.resolve();
  const controller = new AbortController();
  const state = { stopped: false };

  const post = async (lines) => {
    if (!lines.length || state.stopped) return;
    try {
      const response = await api.call(
        'POST', `/api/cli/agent/turns/${turnId}/progress`, { leaseId, lines }
      );
      // The one signal that says "the user pressed stop". The turn is no
      // longer running server-side, so kill the child rather than letting it
      // keep spending the user's subscription on work nobody will see.
      if (response.status === 409) {
        state.stopped = true;
        controller.abort();
      }
    } catch {
      // A dropped progress post must never fail the turn — the commit is what
      // matters. The next flush carries on.
    }
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const lines = pending;
    pending = [];
    inFlight = inFlight.then(() => post(lines));
    return inFlight;
  };

  return {
    state,
    signal: controller.signal,
    add(line) {
      pending.push(line);
      if (pending.length >= PROGRESS_FLUSH_LINES) { flush(); return; }
      if (timer) return;
      timer = setTimeout(flush, PROGRESS_FLUSH_MS);
      timer.unref?.();
    },
    async done() {
      await flush();
      await inFlight;
    },
  };
}

// Commit whatever the agent left in the tree, then upload every commit this
// turn produced, oldest first. Oldest-first matters: the platform reconstructs
// each commit on top of the previous one it built, so an out-of-order upload
// is rejected rather than silently reordered.
async function uploadTurnCommits(api, { repo, turnId, leaseId, startSha, commitMessage }, io) {
  if (git(repo, ['status', '--porcelain']).trim()) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', commitMessage || DEFAULT_COMMIT_MESSAGE]);
  }
  const list = git(repo, ['rev-list', '--reverse', `${startSha}..HEAD`])
    .split('\n').map((line) => line.trim()).filter(Boolean);
  let headSha = null;
  for (const localSha of list) {
    const { payload } = collectCommitUpload(repo, localSha);
    // eslint-disable-next-line no-await-in-loop
    const response = await api.call(
      'POST', `/api/cli/agent/turns/${turnId}/commit`,
      { leaseId, ...payload },
      { deadlineMs: COMMIT_UPLOAD_DEADLINE_MS }
    );
    if (!response.ok) throw new Error(`Commit upload failed: ${describeError(response)}`);
    headSha = response.data?.headSha || headSha;
    io.out(`  uploaded ${localSha.slice(0, 8)} → ${String(headSha).slice(0, 8)}\n`);
  }
  return { headSha, count: list.length };
}

// Ask the operator, at their own keyboard, before anything runs. This is the
// per-turn consent the whole design rests on: the platform can queue a turn,
// but it can never start a process on someone's machine. A terminal with no
// interactive stdin gets no consent — never an implied yes.
//
// Returns true to run, false to decline (with a reason for the chat).
async function confirmTurn(turn, mode, context, io) {
  const ask = context.ask;
  const preview = String(turn.prompt || '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 12)
    .join('\n')
    .slice(0, CONFIRM_PREVIEW_CHARS);
  io.out(
    `\n┌─ Turn ${turn.turnId} — ${mode.label}\n`
    + `│  Usernode wants to ${mode.verb} ${context.repo}\n`
    + `│\n${preview.split('\n').map((line) => `│  ${line}`).join('\n')}\n`
    + `└─\n`
  );
  const answer = ask ? await ask('Run this turn here? [y/N] ') : null;
  if (answer == null) {
    return {
      ok: false,
      reason: 'This machine has no interactive terminal, so nobody could confirm the turn.',
    };
  }
  if (/^y(es)?$/i.test(answer.trim())) return { ok: true };
  return { ok: false, reason: 'Declined at the terminal.' };
}

async function runOneTurn(api, turn, context, io) {
  const { repo, runtime, model, binary, skipPermissions, commitMessage } = context;
  const mode = MODES[turn.mode] || MODES.build;

  // Confirm BEFORE accepting: accepting is what tells the platform to start
  // streaming "your machine is working on it", and it must not say that about
  // a turn the operator has not agreed to.
  const consent = await confirmTurn(turn, mode, context, io);
  if (!consent.ok) {
    io.out(`Declined turn ${turn.turnId}.\n`);
    const declined = await api.call(
      'POST', `/api/cli/agent/turns/${turn.turnId}/decline`,
      { leaseId: context.leaseId, reason: consent.reason }
    );
    if (!declined.ok) io.err(`Could not report the decline: ${describeError(declined)}\n`);
    return;
  }

  const accepted = await api.call(
    'POST', `/api/cli/agent/turns/${turn.turnId}/accept`, { leaseId: context.leaseId }
  );
  if (!accepted.ok) {
    io.err(`Skipping turn ${turn.turnId}: ${describeError(accepted)}\n`);
    return;
  }
  io.out(`\n▶ Turn ${turn.turnId} — running ${runtime.RUNTIME_ID} in ${repo}`
    + `${mode.readOnly ? ' (read-only)' : ''}\n`);

  const reporter = progressReporter(api, { turnId: turn.turnId, leaseId: context.leaseId });
  const startSha = git(repo, ['rev-parse', 'HEAD']).trim();
  let outcome;
  try {
    outcome = await runtime.run({
      prompt: turn.prompt,
      cwd: repo,
      model,
      binary,
      // A read-only turn runs the runtime in its own read-only mode — the
      // adapter's job, not something enforced by hoping the prompt is obeyed.
      readOnly: mode.readOnly,
      // …and the operator's --dangerously-skip-permissions opt-in is ignored
      // for it. That flag exists to let a build edit freely; letting it also
      // unlock a turn the platform declared read-only would defeat the point.
      skipPermissions: mode.readOnly ? false : skipPermissions,
      signal: reporter.signal,
      onProgress: (line) => {
        io.out(`  ${line}\n`);
        reporter.add(line);
      },
    });
  } catch (err) {
    await reporter.done();
    await api.call('POST', `/api/cli/agent/turns/${turn.turnId}/result`, {
      leaseId: context.leaseId,
      status: 'failed',
      headSha: null,
      summary: '',
      error: err.message.slice(0, 400),
      specMd: null,
    }).catch(() => {});
    throw err;
  }
  await reporter.done();

  if (reporter.state.stopped) {
    io.out('Turn stopped from the web page.\n');
    // No result post: the platform already moved this turn to 'stopped' and
    // would reject the write. Any commits already uploaded stay on the branch,
    // which is the same thing a stopped worker turn leaves behind.
    return;
  }

  // --- read-only turns end here ------------------------------------------
  //
  // No commit, no upload, no branch change. The product is the drafted spec,
  // which the platform writes to the session's spec doc exactly as it does
  // for a worker-container scout. If the runtime left the tree dirty anyway
  // (a stray temp file, a tool that ignored the permission mode) that is
  // reported and the tree is restored — never uploaded.
  if (mode.readOnly) {
    let dirtyNote = '';
    const dirty = git(repo, ['status', '--porcelain']).trim();
    if (dirty) {
      io.err(`Read-only turn left ${dirty.split('\n').length} changed path(s); restoring the tree.\n`);
      try {
        git(repo, ['checkout', '--', '.']);
        git(repo, ['clean', '-fd']);
      } catch (err) {
        dirtyNote = ` (the tree was left dirty and could not be restored: ${err.message})`;
      }
    }
    const specMd = String(outcome.summary || '');
    // #1204: `claude` exits 0 when its API stream dies mid-answer — the
    // failure arrives as the closing message ("API Error: Connection lost
    // mid-response…"). Uploading that would overwrite the session's spec doc
    // with the notice, so it fails the turn instead and the platform keeps
    // the previous draft.
    const apiFailure = agentApiFailure(specMd);
    const failed = outcome.isError || !specMd.trim() || !!apiFailure;
    const result = await api.call('POST', `/api/cli/agent/turns/${turn.turnId}/result`, {
      leaseId: context.leaseId,
      status: failed ? 'failed' : 'completed',
      // Structurally impossible for a read-only turn — the platform refuses a
      // non-null head on one — and stated here so it stays that way.
      headSha: null,
      summary: '',
      error: (outcome.isError
        ? (outcome.stderr || `claude exited ${outcome.exitCode}`)
        : (apiFailure
          ? describeAgentApiFailure(apiFailure)
          : (specMd.trim() ? '' : 'The run produced no spec text.'))
      ).slice(0, 400) + dirtyNote || null,
      specMd: (specMd.trim() && !apiFailure) ? specMd : null,
    });
    if (!result.ok) io.err(`Could not report the turn result: ${describeError(result)}\n`);
    io.out(failed
      ? `✗ Turn ${turn.turnId} failed.\n`
      : `✓ Turn ${turn.turnId} done — drafted a ${specMd.split('\n').length}-line spec.\n`);
    return;
  }

  let uploaded = { headSha: null, count: 0 };
  let uploadError = null;
  try {
    uploaded = await uploadTurnCommits(api, {
      repo, turnId: turn.turnId, leaseId: context.leaseId, startSha, commitMessage,
    }, io);
  } catch (err) {
    uploadError = err.message;
  }

  const failed = uploadError || outcome.isError;
  const result = await api.call('POST', `/api/cli/agent/turns/${turn.turnId}/result`, {
    leaseId: context.leaseId,
    status: failed ? 'failed' : 'completed',
    headSha: uploaded.headSha,
    summary: outcome.summary || '',
    error: (uploadError
      || (outcome.isError ? (outcome.stderr || `claude exited ${outcome.exitCode}`) : '')
    ).slice(0, 400) || null,
    specMd: null,
  });
  if (!result.ok) io.err(`Could not report the turn result: ${describeError(result)}\n`);
  io.out(failed
    ? `✗ Turn ${turn.turnId} failed.\n`
    : `✓ Turn ${turn.turnId} done (${uploaded.count} commit${uploaded.count === 1 ? '' : 's'}).\n`);
}

async function agentRun(args, io, deps) {
  const { parseOptions, state, authorizedToken } = deps;
  const { options, positional } = parseOptions(args, new Set([
    '--session', '--repo', '--label', '--model', '--profile', '--runtime', '--binary',
    '--once', '--dangerously-skip-permissions',
  ]));
  if (positional.length || !options.session) {
    throw new Error(
      'Usage: agent run --session <id> [--repo <path>] [--label <name>] [--model <name>] [--once] [--dangerously-skip-permissions] [--profile <name>]'
    );
  }
  if (!/^[1-9]\d{0,9}$/.test(options.session) || Number(options.session) > 2147483647) {
    throw new Error('agent run requires a canonical positive session ID');
  }
  const once = options.once === true;
  const skipPermissions = options.dangerously_skip_permissions === true;

  const runtimeId = options.runtime || claudeCode.RUNTIME_ID;
  const runtime = RUNTIMES.get(runtimeId);
  if (!runtime) {
    throw new Error(`Unknown runtime '${runtimeId}'. Supported: ${[...RUNTIMES.keys()].join(', ')}`);
  }
  const binary = options.binary || runtime.DEFAULT_BINARY;
  const version = runtime.probe(binary);
  if (!version) {
    throw new Error(
      `Could not run \`${binary} --version\`. Install Claude Code and sign in with it before attaching a local agent.`
    );
  }
  const label = (options.label || defaultLabel()).slice(0, MAX_LABEL_CHARS);

  const profile = await state.selectedProfile(options.profile);
  const token = await authorizedToken(profile, io);
  const api = new AgentSession({ origin: profile.origin, token, io });

  const attached = await api.call('POST', '/api/cli/agent/attach', {
    sessionId: Number(options.session),
    label,
    runtime: runtimeId,
  });
  if (!attached.ok) throw new Error(describeError(attached));
  const lease = attached.data.lease;
  const session = attached.data.session;
  io.out(
    `Attached "${label}" to session ${session.sessionId} (${session.appSlug}) as ${runtimeId} ${version}.\n`
    + `Branch: ${session.branch}\n`
    + `Web:    ${profile.origin}${attached.data.webPath}\n`
  );

  const checkout = prepareCheckout(
    path.resolve(options.repo || process.cwd()), session, io
  );

  let running = true;

  // Keeps the lease alive. Its 120s TTL is four beats wide, so a laptop that
  // suspends is reliably swept and the session goes back to Usernode's own
  // agent instead of hanging on a machine that is not listening.
  const heartbeat = setInterval(() => {
    api.call('POST', '/api/cli/agent/heartbeat', { leaseId: lease.leaseId })
      .then((response) => {
        if (response.status === 409) {
          io.err('Lease lost — this machine is no longer attached.\n');
          running = false;
        }
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const onSignal = () => {
    if (!running) process.exit(130);
    io.out('\nDetaching…\n');
    running = false;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const context = {
    repo: checkout.repo,
    leaseId: lease.leaseId,
    runtime,
    binary,
    model: options.model,
    skipPermissions,
    commitMessage: DEFAULT_COMMIT_MESSAGE,
    // The keyboard the per-turn confirmation is read from. Injectable so tests
    // can drive it; in production it is main.js's readline wrapper.
    ask: deps.ask || io.ask,
  };

  io.out(
    `Waiting for a turn. Type in the Dev chat with "Run on: ${label}" selected. Ctrl-C to detach.\n`
    + 'Both spec (read-only) and coding turns come here, and each one asks before it runs.\n'
  );
  let failures = 0;
  try {
    while (running) {
      let next;
      try {
        // eslint-disable-next-line no-await-in-loop
        next = await api.call(
          'GET', `/api/cli/agent/turns/next?leaseId=${encodeURIComponent(lease.leaseId)}`,
          undefined, { deadlineMs: POLL_DEADLINE_MS }
        );
        failures = 0;
      } catch (err) {
        if (!(err instanceof CliHttpError)) throw err;
        // A laptop's network comes and goes. Back off a little and keep the
        // lease alive rather than tearing the whole attachment down.
        failures += 1;
        if (failures > 20) throw err;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, Math.min(15000, failures * 1000)); });
        continue;
      }
      if (next.status === 204) continue;
      if (next.status === 409) {
        io.err(`${describeError(next)}\n`);
        break;
      }
      if (!next.ok) {
        io.err(`${describeError(next)}\n`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 5000); });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await runOneTurn(api, next.data.turn, context, io);
      if (once) break;
    }
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await api.call('POST', '/api/cli/agent/detach', { leaseId: lease.leaseId }).catch(() => {});
    io.out('Detached. Turns for this session go back to Usernode\'s own agent.\n');
  }
  return 0;
}

async function agentStatus(args, io, deps) {
  const { parseOptions, state, authorizedToken } = deps;
  const { options, positional } = parseOptions(args, new Set(['--profile']));
  if (positional.length) throw new Error('agent status accepts no positional arguments');
  const profile = await state.selectedProfile(options.profile);
  const token = await authorizedToken(profile, io);
  const response = await requestJson(profile.origin, '/api/me/local-agents', { token });
  if (!response.ok) throw new Error(describeError(response));
  const agents = response.data?.agents || [];
  if (!agents.length) {
    io.out('No machines are attached to any of your sessions.\n');
    return 0;
  }
  for (const agent of agents) {
    io.out(
      `${agent.label} — session ${agent.sessionId} (${agent.appSlug || '?'}) `
      + `${agent.runtime}, last seen ${agent.lastSeenAt}\n`
    );
  }
  return 0;
}

async function agentDetach(args, io, deps) {
  const { parseOptions, state, authorizedToken } = deps;
  const { options, positional } = parseOptions(args, new Set(['--profile', '--lease']));
  if (positional.length || !options.lease) {
    throw new Error('Usage: agent detach --lease <id> [--profile <name>]');
  }
  if (!/^[1-9]\d{0,18}$/.test(options.lease)) {
    throw new Error('agent detach requires a canonical positive lease ID');
  }
  const profile = await state.selectedProfile(options.profile);
  const token = await authorizedToken(profile, io);
  const response = await requestJson(profile.origin, '/api/cli/agent/detach', {
    method: 'POST', token, body: { leaseId: options.lease },
  });
  if (!response.ok && response.status !== 204) throw new Error(describeError(response));
  io.out('Detached.\n');
  return 0;
}

async function agentCommand(args, io, deps) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'run') return agentRun(rest, io, deps);
  if (subcommand === 'status') return agentStatus(rest, io, deps);
  if (subcommand === 'detach') return agentDetach(rest, io, deps);
  throw new Error('Usage: agent run|status|detach …');
}

module.exports = {
  HEARTBEAT_MS,
  POLL_DEADLINE_MS,
  PROGRESS_FLUSH_LINES,
  CONFIRM_PREVIEW_CHARS,
  DEFAULT_COMMIT_MESSAGE,
  RUNTIMES,
  MODES,
  defaultLabel,
  describeError,
  prepareCheckout,
  progressReporter,
  confirmTurn,
  uploadTurnCommits,
  runOneTurn,
  agentCommand,
};
