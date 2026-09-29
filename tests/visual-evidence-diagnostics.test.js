'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');

test('evidence worker reports the last browser tool without retaining its inputs or results', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  const progress = () => {};
  const privateUrl = 'https://example.invalid/?token=private-token';
  worker.parseLine('__USERNODE_PHASE__ evidence_browser_bootstrap', progress, state);
  worker.parseLine(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'private-session',
    mcp_servers: [
      { name: 'shots' }, { name: 'browser_member' }, { name: 'browser_admin' },
      { name: 'browser_full_admin' },
    ],
    tools: ['mcp__shots__get_brief', 'mcp__shots__save_shot',
      'mcp__shots__skip_change', 'private-tool-definition'],
  }), progress, state);
  worker.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', private: 'private-token' } }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'private-tool-id',
      name: 'mcp__browser_member__browser_navigate', input: { url: privateUrl },
    }] },
  }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'private-tool-id', is_error: true,
      content: `Page said private-token at ${privateUrl}`,
    }] },
  }), progress, state);

  assert.deepEqual(events, [
    { kind: 'runner_phase', phase: 'evidence_browser_bootstrap' },
    { kind: 'provider_init', mcpServerCount: 4, toolDefinitionCount: 4,
      briefToolAvailable: true, saveShotToolAvailable: true,
      skipChangeToolAvailable: true,
      browserMemberToolCount: 0, browserAdminToolCount: 0, browserFullAdminToolCount: 0 },
    { kind: 'first_stream' },
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'browser_navigate', persona: 'member' },
    { kind: 'tool_end', sequence: 1, tool: 'browser_navigate', persona: 'member', outcome: 'error' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|example\.invalid|session|url/i);
});

test('provider init distinguishes unavailable shots tools from absent tool metadata', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  // The retired evidence tools do not count as the shots tools.
  worker.parseLine(JSON.stringify({
    type: 'system', subtype: 'init', tools: ['mcp__browser_member__browser_navigate',
      'mcp__evidence__evidence_get_context', 'mcp__evidence__evidence_capture'],
  }), () => {}, state);
  assert.deepEqual(events, [{
    kind: 'provider_init', mcpServerCount: null, toolDefinitionCount: 3,
    briefToolAvailable: false, saveShotToolAvailable: false,
    skipChangeToolAvailable: false,
    browserMemberToolCount: 1, browserAdminToolCount: 0, browserFullAdminToolCount: 0,
  }]);

  const missing = [];
  const missingState = worker.newWatchState();
  missingState.evidenceDiagnosticObserver = (event) => missing.push(event);
  worker.parseLine(JSON.stringify({ type: 'system', subtype: 'init' }), () => {}, missingState);
  assert.deepEqual(missing, [{
    kind: 'provider_init', mcpServerCount: null, toolDefinitionCount: null,
    briefToolAvailable: null, saveShotToolAvailable: null,
    skipChangeToolAvailable: null,
    browserMemberToolCount: null, browserAdminToolCount: null,
    browserFullAdminToolCount: null,
  }]);
});

test('the brief result reports its shape and normal model exit without retaining content', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  const progress = () => {};
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'context-call', name: 'mcp__shots__get_brief', input: {},
    }] },
  }), progress, state);
  const context = {
    declaredChanges: [{ id: 'one' }, { id: 'two' }],
    addresses: { before: 'http://base.invalid', after: 'http://head.invalid' },
    revisions: { before: 'a'.repeat(12), after: 'b'.repeat(12) },
    secret: 'private-token',
  };
  worker.parseLine(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'context-call', is_error: false,
      content: [{ type: 'text', text: JSON.stringify(context) }],
    }] },
  }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'result', subtype: 'success', stop_reason: 'end_turn',
    result: 'No browser steps were performed. private-token', is_error: false,
  }), progress, state);
  assert.deepEqual(events, [
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'get_brief' },
    { kind: 'context_result', outcome: 'ok', responseCharacters: JSON.stringify(context).length,
      jsonValid: true, declaredChangesPresent: true, addressesPresent: true,
      revisionsPresent: true, storyCount: 2 },
    { kind: 'tool_end', sequence: 1, tool: 'get_brief', outcome: 'ok' },
    { kind: 'provider_result', outcome: 'ok', resultSubtype: 'success', providerStopReason: 'end_turn' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-token|base\.invalid|head\.invalid/);
});

test('the shots tools are named in diagnostics; the retired evidence tools are not', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  const names = ['get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request',
    'evidence_get_context', 'evidence_run_plan', 'evidence_finish', 'evidence_capture', 'evidence_report_blocker'];
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: names.map((name, index) => ({
      type: 'tool_use', id: `call-${index}`, name: `mcp__shots__${name}`, input: { change: 'private-change' },
    })) },
  }), () => {}, state);
  assert.deepEqual(events.filter((event) => event.kind === 'tool_start').map(({ tool }) => tool), [
    'get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request',
    'other', 'other', 'other', 'other', 'other',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-change/);
});

test('evidence diagnostics classify unknown tools and phases without copying their names', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  worker.parseLine('__USERNODE_PHASE__ secret-phase private-token', () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'x', name: 'private-token', input: { password: 'private-token' },
    }] },
  }), () => {}, state);
  assert.deepEqual(events, [
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'other' },
  ]);
});

test('Codex MCP events report the tool lifecycle without recording its arguments', () => {
  const events = [];
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  worker.parseLine(JSON.stringify({ type: 'turn.started' }), () => {}, state);
  worker.parseLine(`__USERNODE_EVIDENCE_PROVIDER__ ${JSON.stringify({
    kind: 'provider_tool_config', mcpServerCount: 4, toolDefinitionCount: 13,
    topLevelFunctionToolCount: 8, topLevelNamespaceToolCount: 4,
    topLevelCustomToolCount: 0, topLevelOtherToolCount: 1,
    nestedToolDefinitionCount: 58, nestedFunctionToolCount: 58,
    nestedCustomToolCount: 0, nestedOtherToolCount: 0,
    shotsToolDefinitionCount: 5, otherMcpServerCount: 0,
    forwardedToolDefinitionCount: 13,
    briefToolAvailable: true, saveShotToolAvailable: true,
    skipChangeToolAvailable: true,
    browserMemberToolCount: 18, browserAdminToolCount: 18,
    browserFullAdminToolCount: 18,
  })}`, () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'item.started', item: {
      id: 'private-item', type: 'mcp_tool_call',
      tool: 'shots.get_brief', arguments: { token: 'private-token' },
    },
  }), () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'item.completed', item: {
      id: 'private-item', type: 'mcp_tool_call',
      tool: 'shots.get_brief', status: 'completed',
      result: { token: 'private-token' },
    },
  }), () => {}, state);
  assert.deepEqual(events, [
    { kind: 'provider_init' },
    { kind: 'provider_tool_config', mcpServerCount: 4, toolDefinitionCount: 13,
      topLevelFunctionToolCount: 8, topLevelNamespaceToolCount: 4,
      topLevelCustomToolCount: 0, topLevelOtherToolCount: 1,
      nestedToolDefinitionCount: 58, nestedFunctionToolCount: 58,
      nestedCustomToolCount: 0, nestedOtherToolCount: 0,
      shotsToolDefinitionCount: 5, otherMcpServerCount: 0,
      forwardedToolDefinitionCount: 13,
      briefToolAvailable: true, saveShotToolAvailable: true,
      skipChangeToolAvailable: true,
      browserMemberToolCount: 18, browserAdminToolCount: 18,
      browserFullAdminToolCount: 18 },
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'get_brief' },
    { kind: 'tool_end', sequence: 1, tool: 'get_brief', outcome: 'ok' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test('navigation diagnostics identify paired sides and repeated routes without storing URLs', () => {
  const events = [];
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.evidenceOrigins = { base: 'http://base.internal:3000', head: 'http://head.internal:3000' };
  state.evidenceNavigationHints = {
    intentPaths: ['/'], declaredPaths: ['/?token=private#app/private-route'],
  };
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  const navigate = (id, url) => {
    worker.parseLine(JSON.stringify({ type: 'item.started', item: {
      id, type: 'mcp_tool_call', tool: 'browser_member.browser_navigate',
      arguments: { url },
    } }), () => {}, state);
    worker.parseLine(JSON.stringify({ type: 'item.completed', item: {
      id, type: 'mcp_tool_call', tool: 'browser_member.browser_navigate', status: 'completed',
    } }), () => {}, state);
  };
  navigate('base', 'http://base.internal:3000/?token=private#app/private-route');
  navigate('head', 'http://head.internal:3000/?token=private#app/private-route');
  navigate('other', 'https://outside.invalid/secret');
  const calls = events.filter((event) => event.kind === 'tool_start');
  assert.deepEqual(calls.map(({ side, routeOrdinal }) => ({ side, routeOrdinal })), [
    { side: 'base', routeOrdinal: 1 },
    { side: 'head', routeOrdinal: 1 },
    { side: 'outside', routeOrdinal: undefined },
  ]);
  assert.equal(events.filter((event) => event.kind === 'tool_end')[1].routeOrdinal, 1);
  assert.equal(calls[0].routeHint, 'declared_check');
  assert.equal(calls[0].checkRank, 1);
  assert.doesNotMatch(JSON.stringify(events), /private|outside\.invalid|token|secret/i);
});

test('worker forwards evidence provider timing without exposing it as agent text', () => {
  const events = [];
  const progress = [];
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.evidenceDiagnosticObserver = event => events.push(event);
  worker.parseLine('__USERNODE_EVIDENCE_PROVIDER__ '+ JSON.stringify({
    kind: 'provider_request_pending', requestOrdinal: 2,
    stage: 'await_headers', durationMs: 15_000,
  }), line => progress.push(line), state);
  assert.deepEqual(events, [{ kind: 'provider_request_pending', requestOrdinal: 2,
    stage: 'await_headers', durationMs: 15_000 }]);
  assert.deepEqual(progress, []);
});
