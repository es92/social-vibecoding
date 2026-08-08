'use strict';

// Claude Code runtime adapter for `social-vibecoding agent run` (#907).
//
// The single job of this file: take a dispatch prompt from the platform, run
// it through the `claude` binary that is ALREADY installed and ALREADY logged
// in on this machine, and stream a human-readable progress line for each
// thing the agent does.
//
// What it deliberately does NOT do, and must never start doing:
//
//   * read ~/.claude.json, ~/.claude/.credentials.json, the macOS keychain,
//     or any other place a Claude Code credential lives;
//   * read ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN out of the
//     environment and forward it anywhere;
//   * send any part of the local environment back to the platform.
//
// The whole point of running the turn locally is that the subscription stays
// on the user's machine. `claude` finds its own credential the same way it
// does when the user runs it by hand; this adapter just spawns it. If you
// ever find yourself needing the token here, the design has gone wrong.
//
// The prompt goes in on STDIN, not as an argv string: a dispatch prompt
// carrying conventions plus a spec doc regularly exceeds the 128 KiB single-
// argument limit, which is the same reason worker/run-cc.sh pipes it.

const { spawn, spawnSync } = require('node:child_process');

const RUNTIME_ID = 'claude-code';
const DEFAULT_BINARY = 'claude';
// Safe by default: this is someone's own laptop, with their own files on it,
// not a disposable container. acceptEdits lets the agent edit the checkout it
// was pointed at without a prompt, which is the whole job, while still
// stopping short of the worker's --dangerously-skip-permissions. `agent run
// --dangerously-skip-permissions` opts into the worker's behavior explicitly.
const DEFAULT_PERMISSION_MODE = 'acceptEdits';
// A scout / spec turn is read-only, and that is enforced by how the binary is
// invoked rather than by trusting the prompt to be obeyed. `plan` is Claude
// Code's own read-only mode; the disallowed-tools list is the second lock, so
// a future permission-mode rename cannot silently re-enable editing on
// someone's own checkout.
const READ_ONLY_PERMISSION_MODE = 'plan';
const READ_ONLY_DISALLOWED_TOOLS = Object.freeze([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);

function probe(binary = DEFAULT_BINARY) {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim().slice(0, 200) || 'unknown';
}

// One line of progress for a tool call, matching the vocabulary the platform
// worker already emits so the dev-chat progress card reads identically no
// matter which machine produced it.
function toolLabel(block) {
  const input = block.input || {};
  if (block.name === 'Read' && input.file_path) return `Reading ${input.file_path}`;
  if (block.name === 'Write' && input.file_path) return `Writing ${input.file_path}`;
  if ((block.name === 'Edit' || block.name === 'MultiEdit') && input.file_path) {
    return `Editing ${input.file_path}`;
  }
  if (block.name === 'Bash' && input.command) {
    return `$ ${String(input.command).substring(0, 150)}`;
  }
  return `Using ${block.name}`;
}

function summarizeToolResult(block) {
  if (block.is_error) return 'error';
  const raw = block.content;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  if (!text) return 'ok';
  const lines = text.split('\n');
  if (lines.length > 3) return `${lines.length} lines`;
  const last = [...lines].reverse().find((l) => l.trim()) || '';
  const trimmed = last.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function applyEvent(event, state, emit) {
  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    state.sessionId = state.sessionId || event.session_id;
    return;
  }
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        state.lastText = block.text;
        emit(block.text.substring(0, 300));
      } else if (block.type === 'thinking' && block.thinking) {
        const first = block.thinking.split('\n').find((l) => l.trim()) || '';
        const clipped = first.trim().slice(0, 200);
        if (clipped) emit(`… ${clipped}`);
      } else if (block.type === 'tool_use') {
        const label = toolLabel(block);
        emit(label);
        if (block.id) state.toolUses.set(block.id, block.name);
      }
    }
    return;
  }
  if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const summary = summarizeToolResult(block);
      const name = block.tool_use_id ? state.toolUses.get(block.tool_use_id) : null;
      if (name) {
        emit(`  ⎿ ${name}: ${summary}`);
        state.toolUses.delete(block.tool_use_id);
      } else {
        emit(`  ⎿ ${summary}`);
      }
    }
    return;
  }
  if (event.type === 'result') {
    state.lastText = event.result || state.lastText;
    if (event.is_error) state.isError = true;
  }
}

// Split a growing buffer on newlines, keeping the partial tail. stream-json
// emits one complete JSON object per line, but a chunk boundary lands wherever
// the pipe felt like putting it.
function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      // A single unterminated line should not grow without bound if the
      // child decides to write a megabyte with no newline in it.
      if (buffer.length > 1024 * 1024) buffer = buffer.slice(-4096);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

/**
 * Run one turn.
 *
 * @param {object} options
 * @param {string} options.prompt      Dispatch prompt from the platform.
 * @param {string} options.cwd         The checkout to run in.
 * @param {string} [options.model]     Passed straight through to --model.
 * @param {string} [options.binary]    Which executable to spawn.
 * @param {string} [options.permissionMode]
 * @param {boolean} [options.skipPermissions]
 * @param {boolean} [options.readOnly] Run in plan mode with editing tools off.
 * @param {(line: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal] Aborting kills the child.
 * @returns {Promise<{exitCode:number,isError:boolean,summary:string,stderr:string}>}
 */
function run({
  prompt,
  cwd,
  model,
  binary = DEFAULT_BINARY,
  permissionMode = DEFAULT_PERMISSION_MODE,
  skipPermissions = false,
  readOnly = false,
  onProgress = () => {},
  signal,
} = {}) {
  const state = { lastText: '', isError: false, sessionId: null, toolUses: new Map() };
  const args = ['--print', '--verbose', '--output-format', 'stream-json'];
  // readOnly wins over skipPermissions unconditionally. The caller already
  // drops the flag for a read-only turn; this makes it impossible to combine
  // them by mistake from anywhere else, because the combination would let a
  // turn the platform declared read-only write to the user's files.
  if (readOnly) {
    args.push('--permission-mode', READ_ONLY_PERMISSION_MODE);
    args.push('--disallowedTools', READ_ONLY_DISALLOWED_TOOLS.join(','));
  } else if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', permissionMode);
  }
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // Inherited as-is. Note what is NOT happening here: nothing is added
        // to, read out of, or forwarded from this environment.
        env: process.env,
      });
    } catch (err) {
      reject(new Error(`Could not start ${binary}: ${err.message}`));
      return;
    }

    let stderr = '';
    let settled = false;
    const stdout = lineSplitter((line) => {
      const text = line.trim();
      if (!text) return;
      try {
        applyEvent(JSON.parse(text), state, onProgress);
      } catch {
        // Not stream-json — a plain log line from the binary. Pass short
        // ones through; a wall of output is noise in a progress card.
        if (text.length < 500) onProgress(text);
      }
    });

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
      // If it ignores SIGTERM, stop being polite. The user asked for this
      // turn to stop, and a wedged agent holding the checkout is worse than
      // a hard kill.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener?.('abort', onAbort);
      reject(err.code === 'ENOENT'
        ? new Error(`Could not find the \`${binary}\` command on this machine. Install Claude Code and make sure \`${binary}\` is on your PATH.`)
        : err);
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener?.('abort', onAbort);
      stdout.flush();
      resolve({
        exitCode: code == null ? -1 : code,
        signal: sig || null,
        isError: state.isError || code !== 0,
        summary: state.lastText || '',
        stderr: stderr.trim(),
      });
    });

    try {
      child.stdin.end(prompt, 'utf8');
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  RUNTIME_ID,
  DEFAULT_BINARY,
  DEFAULT_PERMISSION_MODE,
  READ_ONLY_PERMISSION_MODE,
  READ_ONLY_DISALLOWED_TOOLS,
  probe,
  toolLabel,
  summarizeToolResult,
  applyEvent,
  lineSplitter,
  run,
};
