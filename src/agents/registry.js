'use strict';

// Backend registry for the platform's coding agents (plan.md §3/§4-PR1).
//
// Today there is exactly one backend — claude_code — which owns the
// worker lifecycle, the stream-json parser, session continuity, billing,
// and the UI. Adding codex_openrouter in later PRs must NOT fork that
// ownership into a maze of if/else; instead each backend is described
// here, and worker.js / progress / billing / UI resolve through this
// single source of truth.
//
// PR1 seeds only `claude_code`. `codex_openrouter` is added by PR5 (the
// worker adapter). Fields are intentionally minimal now and extended as
// later PRs land.
const DEFAULT_BACKEND = 'claude_code';

// Backend descriptor shape:
//   id          stable backend id (persisted in chat_sessions.agent_backend)
//   label       human name shown in the UI. VENUE-first (#1087 follow-up):
//               every selector in the product now names WHERE the work
//               happens, and two of the six venues are these backends. The
//               old labels ("Claude Code", "Codex (OpenRouter BYOK)") named
//               the tool, which collided head-on with the web hand-off's
//               "Claude Code" and with the `claude-code` external-agent id.
//               The ids are UNCHANGED — only the copy moves.
//   provider    upstream provider (anthropic | openrouter)
//   runner      worker entrypoint that runs this agent (PR5 adds codex)
//   claudeLike  true when the runner emits Claude stream-json + cc_*
//               result fields (used to keep the legacy parser working)
const BACKENDS = {
  claude_code: {
    id: 'claude_code',
    label: 'Homeroom · Claude',
    provider: 'anthropic',
    runner: '/usr/local/bin/run-cc.sh',
    claudeLike: true,
  },
  codex_openrouter: {
    id: 'codex_openrouter',
    label: 'Homeroom · OpenRouter',
    provider: 'openrouter',
    runner: '/usr/local/bin/run-codex-agent.sh',
    claudeLike: false,
  },
};

function isBackend(b) {
  return typeof b === 'string' && Object.prototype.hasOwnProperty.call(BACKENDS, b);
}

// Resolve a backend id, FAILING CLOSED on unknown non-empty values.
//
// Only an ABSENT value (null / undefined / '') means "no explicit choice,
// use the platform default" (e.g. a freshly-created session that predates
// the agent_backend column, or a legacy row). Any other non-empty string
// that is not a known backend is a configuration/typo/version-skew error
// and MUST NOT silently dispatch claude_code — that could route a
// should-be-Codex session onto Anthropic (plan.md review F6).
function resolveBackend(b) {
  if (b == null || b === '') return DEFAULT_BACKEND;
  if (isBackend(b)) return b;
  throw new Error(`registry: unknown backend '${b}'`);
}

function getBackend(b) {
  return BACKENDS[resolveBackend(b)] || null;
}

function listBackends() {
  return Object.values(BACKENDS);
}

function providerFor(b) {
  return getBackend(b)?.provider || null;
}

// The runner entrypoint invoked inside the worker container (via
// `docker exec ... sh -c ...$RUNNER...`). Backend-neutral callers should
// prefer this over a hardcoded /usr/local/bin/run-cc.sh so the Codex
// runner can be selected in PR5 without touching worker.js dispatch.
function runnerFor(b) {
  return getBackend(b)?.runner || null;
}

module.exports = {
  DEFAULT_BACKEND,
  BACKENDS,
  isBackend,
  resolveBackend,
  getBackend,
  listBackends,
  providerFor,
  runnerFor,
};
