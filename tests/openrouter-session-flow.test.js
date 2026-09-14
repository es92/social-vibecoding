'use strict';

// Coherence guards for the OpenRouter session flow. These deliberately pin
// the provider boundaries in the route source: OpenRouter must branch before
// any Anthropic gate, call its selected model directly, and remain direct in
// unattended/recovery paths as well as the ordinary chat UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessions = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8',
);
const appView = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8',
);
const settings = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8',
);
const server = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'),
  'utf8',
);

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('interactive OpenRouter chat bypasses Claude billing and the Mayor', () => {
  const route = between(
    sessions,
    "router.post('/api/sessions/:id/chat'",
    '// ===== Spec stage endpoints',
  );
  assert.match(route, /const isOpenRouterSession/);
  assert.match(route, /if \(!isOpenRouterSession\) \{\s*billing = await limits\.resolveBillingPath/);

  const direct = between(
    route,
    '// OpenRouter is a complete, single-provider session path.',
    '// Fable 5 classifier fallback',
  );
  assert.match(direct, /runClaudeCodeTool\(\{/);
  assert.match(direct, /directSessionTurn: true/);
  assert.match(direct, /openRouterDirect: true/);
  assert.doesNotMatch(direct, /llm\./);
  assert.doesNotMatch(direct, /resolveBillingPath/);
  // #1949: the session IS named here, but only by the deterministic,
  // payer-free trim — never by the Haiku titler the Claude path uses.
  assert.match(direct, /sessionTitles\.titleFromFirstMessage\(/);
  assert.doesNotMatch(direct, /sessionTitles\.(?:maybeTitleFirstMessage|refreshFromHistory|generateAndApply)/);
  assert.ok(
    route.indexOf('// OpenRouter is a complete, single-provider session path.')
      < route.indexOf('if (!llm.isEnabled())'),
    'OpenRouter branches before the Anthropic availability gate',
  );

  // #2118: the direct reply carries the ledger's estimate of what the turn
  // cost, flagged as one, and its usage receipt follows the reply it belongs
  // to — sent earlier it lands on a bubble the next status line discards.
  assert.match(direct, /INSERT INTO chat_session_messages \(session_id, role, content, model, cost_cents, metadata\)/);
  assert.match(direct, /costEstimated: true/);
  const reply = direct.indexOf("send('mayor_reasoning', { text: directText })");
  const receipt = direct.indexOf("send('usage', { costCents: directCostCents");
  assert.ok(reply !== -1 && receipt > reply, 'the usage receipt follows the reply');
  assert.match(direct, /estimated: true/);
});

test('direct OpenRouter prompt supports chat replies as well as repository changes', () => {
  const tool = between(
    sessions,
    'async function runClaudeCodeTool({',
    '// `prodDebug` (default false',
  );
  assert.match(tool, /there is no separate chat model/);
  assert.match(tool, /asks for information, analysis, status, or an explanation/);
  assert.match(tool, /directSessionTurn && result\.exitCode === 0/);
  assert.match(tool, /directChatReply \? ccText/);
  // #2118: the tool hands a direct turn's ledger estimate back to its caller
  // instead of sending the receipt itself, and never bills it to Claude.
  assert.match(tool, /codexEstimatedCostUsd = routed\.estimatedCostUsd/);
  assert.match(tool, /!directSessionTurn && codexEstimatedCostUsd/);
  assert.match(tool, /estimatedCostCents: codexEstimatedCostUsd/);
});

test('Generate proposal follows the saved OpenRouter provider without Claude credits', () => {
  const flow = between(
    appView,
    'async confirmAutoSession(issueNumber)',
    '// Singleton confirm popup for Generate proposal',
  );
  assert.match(flow, /_prepareDefaultCodingAgentForBuild/);
  assert.match(flow, /defaultBackend === 'codex_openrouter'/);
  assert.match(flow, /coding-agent\/models\?backend=codex_openrouter/);
  assert.match(flow, /backend: 'codex_openrouter'/);
  assert.match(flow, /provider === 'openrouter'/);

  const modal = between(
    appView,
    '_showAutoSessionModal(issueNumber, models, preselect, modalOptions = {})',
    '// "Start session from proposal"',
  );
  assert.match(modal, /openrouterCredentialSource === 'usernode_managed'/);
  assert.match(modal, /Uses your included daily credits/);
  assert.match(modal, /Uses your OpenRouter account/);
  assert.doesNotMatch(modal, /onFavorite|onRefresh|Experimental/);
});

test('OpenRouter headless and recovery paths do not resolve Anthropic billing', () => {
  const headless = between(
    sessions,
    'async function runHeadlessSession({',
    'async function runRecoveredWrapUp({',
  );
  const directHeadless = between(
    headless,
    "if (registry.resolveBackend(session.agent_backend) === 'codex_openrouter')",
    "await setHeadlessStep(pool, session.id, 'planning')",
  );
  assert.match(directHeadless, /directSessionTurn: true/);
  assert.match(directHeadless, /runClaudeCodeTool/);
  assert.doesNotMatch(directHeadless, /llm\./);
  assert.doesNotMatch(directHeadless, /resolveBillingPath/);

  const recovery = between(
    sessions,
    '// A recovered OpenRouter turn keeps the same single-provider contract',
    'if (!llm.isEnabled())',
  );
  assert.match(recovery, /provider: 'openrouter'/);
  assert.doesNotMatch(recovery, /llm\./);
  assert.doesNotMatch(recovery, /resolveBillingPath/);
});

test('settings and restart recovery use OpenRouter as the user-facing provider name', () => {
  const settingsCopy = between(
    settings,
    '_normalizeOpenRouterCopy() {',
    '_formatOpenRouterPrice(value)',
  );
  assert.match(settingsCopy, /heading\.textContent = 'OpenRouter'/);
  assert.match(settingsCopy, /all chat and coding in an OpenRouter session/);
  assert.match(settingsCopy, /do not use your platform Claude allowance/);
  assert.doesNotMatch(settingsCopy, /Codex/);

  const recoveryIdentity = between(
    server,
    'function recoveredAgentIdentity',
    'async function adoptOrphanWorker',
  );
  assert.match(recoveryIdentity, /isOpenRouter \? 'OpenRouter' : 'Claude Code'/);
  const recoveredFinalize = between(
    server,
    'async function finalizeRecoveredTurn({',
    'async function resumeDetachedTurn(',
  );
  assert.match(recoveredFinalize, /directOpenRouterReply/);
  assert.match(recoveredFinalize, /recoveryAgent\.name/);
  assert.doesNotMatch(recoveredFinalize, /'Claude Code (?:finished|made no changes|did not complete)'/);
});
