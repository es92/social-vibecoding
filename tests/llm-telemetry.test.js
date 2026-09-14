'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm');
const telemetry = require('../src/services/llm-telemetry');
const worker = require('../src/services/worker');
const agentTurn = require('../src/services/agent-turn');
const {
  runCodexAttemptLoop,
  _recordLocalCodingInvocationForTests: recordLocalCodingInvocation,
} = require('../src/routes/sessions');

function fakeStream(message) {
  return {
    on() {},
    finalMessage: async () => {
      if (message instanceof Error) throw message;
      return message;
    },
  };
}

function fakeEventStream(message, events = []) {
  const handlers = new Map();
  return {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    finalMessage: async () => {
      for (const event of events) {
        for (const callback of handlers.get('streamEvent') || []) callback(event);
      }
      if (message instanceof Error) throw message;
      return message;
    },
  };
}

function streamClient(responses) {
  const calls = [];
  const invoke = (kind, params, options) => {
    calls.push({ kind, params, options });
    if (!responses.length) throw new Error('no canned response');
    return fakeStream(responses.shift());
  };
  return {
    calls,
    messages: { stream: (params, options) => invoke('plain', params, options) },
    beta: { messages: { stream: (params, options) => invoke('beta', params, options) } },
  };
}

function finalMessage(overrides = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 12, output_tokens: 4 },
    ...overrides,
  };
}

async function withTelemetrySink(fn) {
  const rows = [];
  const priorEnabled = telemetry._setEnabledForTests(true);
  const priorSink = telemetry._setSinkForTests((row) => { rows.push(row); });
  try {
    return await fn(rows);
  } finally {
    telemetry._setSinkForTests(priorSink);
    telemetry._setEnabledForTests(priorEnabled);
  }
}

async function withClient(client, fn) {
  const prior = llm._setClientForTests(client);
  try { return await fn(); } finally { llm._setClientForTests(prior); }
}

test('stream telemetry leaves the complete Anthropic request object unchanged', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([finalMessage()]);
    const messages = [{ role: 'user', content: 'unchanged message' }];
    const tools = [{ name: 'read_only_tool', description: 'unchanged', input_schema: { type: 'object' } }];
    const toolChoice = { type: 'auto' };
    await withClient(client, () => llm.streamChat({
      messages,
      systemPrompt: 'unchanged system',
      model: 'claude-opus-5',
      tools,
      toolChoice,
      telemetryContext: {
        appId: 7,
        sessionId: 11,
        backend: 'mayor',
        component: 'mayor_phase_1',
      },
    }));

    assert.deepEqual(client.calls[0].params, {
      model: 'claude-opus-5',
      max_tokens: 8192,
      system: 'unchanged system',
      messages,
      stream: true,
      tools,
      tool_choice: toolChoice,
    });
    assert.equal('telemetryContext' in client.calls[0].params, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].component, 'mayor_phase_1');
  });
});

test('Anthropic cache usage is preserved and absent usage stays null', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([
      finalMessage({
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 20,
          output_tokens: 9,
        },
      }),
      finalMessage({ usage: undefined }),
    ]);
    await withClient(client, async () => {
      await llm.streamChat({
        messages: [], systemPrompt: 's', model: 'claude-opus-5',
        telemetryContext: { component: 'mayor_phase_1' },
      });
      await llm.streamChat({
        messages: [], systemPrompt: 's', model: 'claude-opus-5',
        telemetryContext: { component: 'mayor_phase_2' },
      });
    });
    assert.deepEqual({
      input: rows[0].input_tokens,
      cacheRead: rows[0].cache_read_input_tokens,
      cacheWrite: rows[0].cache_write_input_tokens,
      output: rows[0].output_tokens,
    }, { input: 100, cacheRead: 70, cacheWrite: 20, output: 9 });
    assert.equal(rows[1].input_tokens, null);
    assert.equal(rows[1].cache_read_input_tokens, null);
    assert.equal(rows[1].cache_write_input_tokens, null);
    assert.equal(rows[1].output_tokens, null);
    assert.equal(rows[1].cost_usd, null);
    assert.equal(rows[1].cost_source, 'unavailable');
  });
});

test('recommended-model retry records two correlated physical attempts', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([
      finalMessage({
        model: 'claude-fable-5-1',
        stop_reason: 'refusal',
        stop_details: { recommended_model: 'claude-opus-5' },
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      }),
      finalMessage({ model: 'claude-opus-5' }),
    ]);
    await withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-fable-5-1',
      telemetryContext: { component: 'mayor_phase_1' },
    }));
    assert.equal(client.calls.length, 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.attempt_number), [1, 2]);
    assert.equal(rows[0].outcome, 'refusal');
    assert.equal(rows[1].outcome, 'success');
    assert.equal(rows[0].correlation_id, rows[1].correlation_id);
    assert.notEqual(rows[0].invocation_key, rows[1].invocation_key);
  });
});

test('server-side fallback iterations become separate model-invocation events', async () => {
  await withTelemetrySink(async (rows) => {
    const response = finalMessage({
      model: 'claude-opus-5',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-5' } },
        { type: 'text', text: 'served by fallback' },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 8,
        iterations: [
          {
            type: 'message', model: 'claude-fable-5-1',
            input_tokens: 10, cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2, output_tokens: 1,
          },
          {
            type: 'fallback_message', model: 'claude-opus-5',
            input_tokens: 20, cache_read_input_tokens: 6,
            cache_creation_input_tokens: 3, output_tokens: 7,
          },
        ],
      },
    });
    const client = streamClient([response]);
    await withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-fable-5-1',
      telemetryContext: { component: 'headless_decision' },
    }));
    assert.equal(client.calls.length, 1, 'provider API request shape is unchanged');
    assert.equal(rows.length, 2, 'two provider model iterations are measured');
    assert.deepEqual(rows.map((row) => row.requested_model), ['claude-fable-5-1', 'claude-fable-5-1']);
    assert.deepEqual(rows.map((row) => row.served_model), ['claude-fable-5-1', 'claude-opus-5']);
    assert.deepEqual(rows.map((row) => row.input_tokens), [10, 20]);
    assert.deepEqual(rows.map((row) => row.cache_read_input_tokens), [4, 6]);
    assert.equal(rows[0].duration_ms, null, 'enclosing duration is not duplicated');
    assert.notEqual(rows[1].duration_ms, null);
  });
});

test('direct helpers emit their fixed provider-neutral component labels', async () => {
  await withTelemetrySink(async (rows) => {
    const responses = [
      { ...finalMessage(), content: [{ type: 'text', text: '{"title":"Telemetry baseline"}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"title":"Add telemetry","body":"Measured","summary":"Usage is visible."}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"estimate":"maybe halfway","remaining_seconds":120}' }] },
      { ...finalMessage(), content: [{ type: 'tool_use', name: 'suggest_replies', input: { replies: ['Continue'] } }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"replies":["Continue"]}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: 'Add usage telemetry' }] },
      { ...finalMessage(), content: [{
        type: 'text',
        text: '{"narrative":"Steady progress.","highlights":[],"risks":[],"owners":[]}',
      }] },
    ];
    const helperCalls = [];
    const client = { messages: { create: async (...args) => {
      helperCalls.push(args);
      return responses.shift();
    } } };
    const ctx = { appId: 2, sessionId: 3 };
    await withClient(client, async () => {
      await llm.generateSessionTitle({ requests: ['measure'], telemetryContext: ctx });
      await llm.generatePrMetadata({ userRequest: 'measure', ccSummary: 'done', telemetryContext: ctx });
      await llm.estimateRunProgress({ userRequest: 'measure', progressTail: [], elapsedMs: 1, steps: 0, telemetryContext: ctx });
      await llm.requireQuickReplies({
        rules: 'specific', context: 'reply', model: 'claude-opus-5',
        tool: { name: 'suggest_replies' }, telemetryContext: ctx,
      });
      await llm.generateQuickReplies({ rules: 'specific', context: 'reply', telemetryContext: ctx });
      await llm.generateIssueTitle({ description: 'measure usage', telemetryContext: ctx });
      await llm.generateReportSummary({ inputJson: '{}', appName: 'App', knownUsernames: [], telemetryContext: ctx });
    });
    assert.deepEqual(rows.map((row) => row.component), [
      'session_title', 'pr_metadata', 'progress_estimate', 'quick_replies',
      'quick_replies', 'issue_title', 'report_summary',
    ]);
    assert.ok(rows.every((row) => row.backend === 'helper'));
    assert.deepEqual(helperCalls.map((args) => args.length), [1, 1, 1, 2, 1, 1, 1],
      'telemetry preserves each helper SDK call arity, including an explicit undefined options arg');
    assert.equal(rows[6].output_format, 'json_schema');
    assert.equal(rows[6].max_output_tokens, 2000);
    assert.ok(rows[6].request_system_characters > 0);
  });
});

test('Anthropic telemetry captures complete content-free request, response, cache, and latency shape', async () => {
  await withTelemetrySink(async (rows) => {
    const response = finalMessage({
      content: [
        { type: 'thinking', thinking: 'think' },
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 't1', name: 'safe_tool', input: { secret: 'not stored' } },
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'not stored' } },
        { type: 'redacted_thinking', data: 'not stored' },
      ],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 20,
          ephemeral_1h_input_tokens: 10,
        },
        output_tokens: 9,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        service_tier: 'priority',
        inference_geo: 'us',
      },
    });
    const calls = [];
    const client = {
      messages: {
        stream(params, options) {
          calls.push({ params, options });
          return fakeEventStream(response, [{ type: 'content_block_start' }]);
        },
      },
      beta: { messages: { stream() { throw new Error('unexpected beta call'); } } },
    };
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not stored' } },
          {
            type: 'tool_result', tool_use_id: 'old',
            content: [{ type: 'text', text: 'tool text', cache_control: { type: 'ephemeral' } }],
          },
        ],
      },
      { role: 'assistant', content: [
        { type: 'text', text: 'prior' },
        { type: 'tool_use', id: 'prior-tool', name: 'safe_tool', input: { secret: 'not stored' } },
      ] },
    ];
    const system = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const tools = [{
      name: 'safe_tool', description: 'description',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }];
    await withClient(client, () => llm.streamChat({
      messages,
      systemPrompt: system,
      model: 'claude-opus-5',
      tools,
      toolChoice: { type: 'auto' },
      telemetryContext: { component: 'mayor_phase_1' },
    }));

    assert.equal(calls.length, 1);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual({
      mode: row.request_mode,
      messages: row.request_message_count,
      users: row.request_user_message_count,
      assistants: row.request_assistant_message_count,
      blocks: row.request_content_block_count,
      text: row.request_text_characters,
      userText: row.request_user_text_characters,
      assistantText: row.request_assistant_text_characters,
      toolResultText: row.request_tool_result_text_characters,
      thinkingText: row.request_thinking_characters,
      system: row.request_system_characters,
      tools: row.request_tool_definition_count,
      priorToolCalls: row.request_tool_call_count,
      toolResults: row.request_tool_result_count,
      images: row.request_image_count,
      cachePoints: row.request_cache_breakpoint_count,
      cache5m: row.request_cache_5m_breakpoint_count,
      cache1h: row.request_cache_1h_breakpoint_count,
    }, {
      mode: 'stream', messages: 2, users: 1, assistants: 1, blocks: 7,
      text: 22, userText: 14, assistantText: 5, toolResultText: 9,
      thinkingText: 0, system: 3, tools: 1, priorToolCalls: 1, toolResults: 1, images: 1,
      cachePoints: 4, cache5m: 2, cache1h: 2,
    });
    assert.ok(row.request_payload_characters > row.request_text_characters);
    assert.ok(row.request_tool_schema_characters > 0);
    assert.equal(row.max_output_tokens, 8192);
    assert.equal(row.tool_choice_mode, 'auto');
    assert.equal(row.output_format, 'text');
    assert.deepEqual({
      blocks: row.response_content_block_count,
      textBlocks: row.response_text_block_count,
      textCharacters: row.response_text_characters,
      toolCalls: row.response_tool_call_count,
      serverTools: row.response_server_tool_call_count,
      thinkingBlocks: row.response_thinking_block_count,
      thinkingCharacters: row.response_thinking_characters,
      redacted: row.response_redacted_thinking_block_count,
    }, {
      blocks: 5, textBlocks: 1, textCharacters: 4, toolCalls: 1,
      serverTools: 1, thinkingBlocks: 1, thinkingCharacters: 5, redacted: 1,
    });
    assert.equal(row.cache_write_5m_input_tokens, 20);
    assert.equal(row.cache_write_1h_input_tokens, 10);
    assert.equal(row.server_web_search_count, 2);
    assert.equal(row.server_web_fetch_count, 1);
    assert.equal(row.service_tier, 'priority');
    assert.equal(row.inference_region, 'us');
    assert.equal(row.provider_turn_count, 1);
    assert.equal(row.provider_model_count, 1);
    assert.notEqual(row.provider_duration_ms, undefined);
    assert.notEqual(row.time_to_first_output_ms, undefined);
    const serialized = JSON.stringify(row);
    for (const secret of ['not stored', 'safe_tool', 'tool text', 'hello']) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

test('telemetry failure and kill switch cannot fail or alter an LLM turn', async () => {
  const priorEnabled = telemetry._setEnabledForTests(true);
  const priorSink = telemetry._setSinkForTests(() => { throw Object.assign(new Error('db down'), { code: '08006' }); });
  const client = streamClient([finalMessage()]);
  try {
    const result = await withClient(client, () => llm.streamChat({
      messages: [{ role: 'user', content: 'still works' }],
      systemPrompt: 'same',
      model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    }));
    assert.equal(result.text, 'done');
    assert.equal(client.calls.length, 1);

    let called = 0;
    telemetry._setSinkForTests(() => { called += 1; });
    telemetry._setEnabledForTests(false);
    assert.equal(await telemetry.record(null, { provider: 'anthropic' }), false);
    assert.equal(telemetry.collectionComponent('coding_agent_build'), null);
    assert.equal(called, 0);

    let diagnosticReads = 0;
    const contentBlock = { type: 'text' };
    Object.defineProperty(contentBlock, 'text', {
      enumerable: true,
      get() { diagnosticReads += 1; return 'private'; },
    });
    const disabledClient = streamClient([finalMessage()]);
    const disabledResult = await withClient(disabledClient, () => llm.streamChat({
      messages: [{ role: 'user', content: [contentBlock] }],
      systemPrompt: 'same', model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    }));
    assert.equal(disabledResult.text, 'done');
    assert.equal(diagnosticReads, 0,
      'the kill switch skips request-shape traversal, not only persistence');

    telemetry._setEnabledForTests(true);
    assert.equal(telemetry.collectionComponent('coding_agent_build'), 'coding_agent_build');
    assert.equal(telemetry.collectionComponent('user supplied text'), null);
    assert.equal(await telemetry.record(null, {
      provider: 'anthropic',
      requestedModel: { toString() { throw new Error('unexpected value'); } },
    }), false, 'normalization failures are swallowed too');
    assert.equal(called, 0);
  } finally {
    telemetry._setSinkForTests(priorSink);
    telemetry._setEnabledForTests(priorEnabled);
  }
});

test('an aborted Anthropic request is counted as cancelled without storing its error', async () => {
  await withTelemetrySink(async (rows) => {
    const aborted = new Error('provider detail must not be stored');
    aborted.name = 'AbortError';
    const client = streamClient([aborted]);
    await assert.rejects(withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    })), (error) => error === aborted);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'cancelled');
    assert.equal(rows[0].stop_reason, 'cancelled');
    assert.equal(JSON.stringify(rows[0]).includes(aborted.message), false);
  });
});

test('the strict telemetry allowlist drops content and credentials', () => {
  const row = telemetry.normalizeEvent({
    provider: 'anthropic', backend: 'mayor', component: 'mayor_phase_1',
    prompt: 'secret prompt', messages: ['secret'], output: 'secret output',
    apiKey: 'sk-secret', rawError: 'secret error', filename: '/private/file',
    correlationId: 'accidental user sentence', requestedModel: 'prompt pasted here',
    toolName: 'secret tool', toolInput: { secret: true }, toolResult: 'secret result',
    requestTextCharacters: 123, responseTextCharacters: 45,
    providerDurationMs: 10, toolCallCount: 2, errorClass: 'rate_limited',
  });
  for (const forbidden of [
    'prompt', 'messages', 'output', 'apiKey', 'rawError', 'filename',
    'toolName', 'toolInput', 'toolResult',
  ]) {
    assert.equal(Object.hasOwn(row, forbidden), false);
  }
  assert.equal(row.correlation_id, null);
  assert.equal(row.requested_model, null);
  assert.equal(row.request_text_characters, 123);
  assert.equal(row.response_text_characters, 45);
  assert.equal(row.error_class, 'rate_limited');
  assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') < 4096,
    'the complete allowlisted event stays compact');

  const diagnostics = telemetry.normalizeDiagnostics({
    prompt: 'secret', rawError: 'secret', toolInput: { secret: true },
    requestMode: 'agent_resume', requestTextCharacters: 500,
    toolCallCount: 7, usageResetDetected: false,
  });
  assert.deepEqual(diagnostics, {
    request_mode: 'agent_resume',
    request_text_characters: 500,
    tool_call_count: 7,
    usage_reset_detected: false,
  });
});

test('Anthropic errors are classified without persisting provider error details', async () => {
  await withTelemetrySink(async (rows) => {
    const error = Object.assign(new Error('sensitive provider message'), { status: 429 });
    const client = streamClient([error]);
    await assert.rejects(withClient(client, () => llm.streamChat({
      messages: [{ role: 'user', content: 'private request' }],
      systemPrompt: 'private system',
      model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    })), (thrown) => thrown === error);
    assert.equal(rows[0].outcome, 'error');
    assert.equal(rows[0].error_class, 'rate_limited');
    assert.equal(rows[0].request_message_count, 1);
    assert.equal(JSON.stringify(rows[0]).includes(error.message), false);
    assert.equal(JSON.stringify(rows[0]).includes('private request'), false);
  });
});

test('Claude coding-agent cost remains known while all token fields remain null', async () => {
  await withTelemetrySink(async (rows) => {
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '11111111-1111-4111-8111-111111111111',
      result: { costUsd: 1.25, exitCode: 0, agentModel: null },
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_headless',
      startedAt: new Date(),
      durationMs: 1234,
      attemptNumber: 2,
      correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost_usd, 1.25);
    assert.equal(rows[0].cost_source, 'provider_reported');
    assert.equal(rows[0].input_tokens, null);
    assert.equal(rows[0].cache_read_input_tokens, null);
    assert.equal(rows[0].cache_write_input_tokens, null);
    assert.equal(rows[0].output_tokens, null);
    assert.equal(rows[0].reasoning_output_tokens, null);
    assert.equal(rows[0].attempt_number, 2);
    assert.equal(rows[0].correlation_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const zeroCostState = worker.newWatchState();
    worker.parseLine(JSON.stringify({ type: 'result', cost_usd: 0 }), () => {}, zeroCostState);
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '22222222-2222-4222-8222-222222222222',
      result: zeroCostState,
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 12,
    });
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '33333333-3333-4333-8333-333333333333',
      result: { costUsd: 0, exitCode: 0 },
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 12,
    });
    assert.equal(rows[1].cost_usd, 0, 'provider-reported zero remains known zero');
    assert.equal(rows[1].cost_source, 'provider_reported');
    assert.equal(rows[2].cost_usd, null, 'legacy default zero without provider evidence is unavailable');
    assert.equal(rows[2].cost_source, 'unavailable');

    const billingPrecedence = worker.newWatchState();
    worker.parseLine(JSON.stringify({
      type: 'result', cost_usd: 0, total_cost_usd: 2.5,
    }), () => {}, billingPrecedence);
    assert.equal(billingPrecedence.costUsd, 2.5,
      'telemetry does not alter the existing Claude billing precedence');
    assert.equal(billingPrecedence.providerCostSeen, true);
  });
});

test('Claude coding-agent records reported run usage, failure reason, and mixed billing', async () => {
  await withTelemetrySink(async (rows) => {
    const state = worker.newWatchState();
    state.telemetryDiagnosticsEnabled = true;
    worker.parseLine(JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      total_cost_usd: 3.25,
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 30,
        output_tokens: 45,
        output_tokens_details: { thinking_tokens: 12 },
      },
    }), () => {}, state);
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '44444444-4444-4444-8444-444444444444',
      result: state,
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 50,
      byokCents: 25,
    });

    assert.equal(rows.length, 1);
    assert.equal(state.usageSeen, true);
    assert.deepEqual({
      input: rows[0].input_tokens,
      cacheRead: rows[0].cache_read_input_tokens,
      cacheWrite: rows[0].cache_write_input_tokens,
      output: rows[0].output_tokens,
      reasoning: rows[0].reasoning_output_tokens,
    }, { input: 120, cacheRead: 900, cacheWrite: 30, output: 45, reasoning: 12 });
    assert.equal(rows[0].outcome, 'error');
    assert.equal(rows[0].stop_reason, 'error_max_turns');
    assert.equal(rows[0].billing_path, 'anthropic_mixed');
    assert.equal(rows[0].cost_usd, 3.25);
  });
});

test('Claude coding-agent telemetry captures run latency, turns, tool workload, and response shape', async () => {
  await withTelemetrySink(async (rows) => {
    const state = worker.newWatchState();
    state.telemetryDiagnosticsEnabled = true;
    state.providerStartedMs = Date.now() - 100;
    state.requestMode = 'agent_resume';
    state.requestMessageCount = 1;
    state.requestUserMessageCount = 1;
    state.requestContentBlockCount = 1;
    state.requestTextCharacters = 1234;
    state.requestUserTextCharacters = 1234;
    state.requestSystemCharacters = 9876;
    state.requestPayloadCharacters = 11110;
    worker.parseLine(JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'runtime-session',
      tools: ['Read', 'Bash', 'Task'],
      mcp_servers: [{ name: 'private-server' }],
      agents: ['private-agent'], skills: ['private-skill'], plugins: ['private-plugin'],
    }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 7777 },
    }), () => {}, state);
    worker.parseLine(JSON.stringify({ type: 'rate_limit_event', private: 'not stored' }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'summary' },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/private/path' } },
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'secret command' } },
          { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/private/edit' } },
          { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: 'private pattern' } },
          { type: 'tool_use', id: 'task-1', name: 'Task', input: { prompt: 'private task' } },
          { type: 'tool_use', id: 'web-1', name: 'WebSearch', input: { query: 'private query' } },
          { type: 'tool_use', id: 'search-1', name: 'ToolSearch', input: { query: 'private tools' } },
          { type: 'tool_use', id: 'mcp-1', name: 'mcp__private_tool', input: { value: 'private' } },
        ],
      },
    }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: 'private file content' },
        { type: 'tool_result', tool_use_id: 'bash-1', content: 'private error', is_error: true },
      ] },
    }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      cost_usd: 2.5,
      duration_ms: 9000,
      duration_api_ms: 5000,
      num_turns: 4,
      modelUsage: {
        'claude-opus-5': { contextWindow: 200000 },
        'claude-haiku-4-5': { context_window: 100000 },
      },
      permission_denials: [{ tool_name: 'Bash', reason: 'private' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }), () => {}, state);
    state.exitCode = 0;
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '88888888-8888-4888-8888-888888888888',
      result: state,
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 10_000,
    });

    const row = rows[0];
    assert.equal(row.request_mode, 'agent_resume');
    assert.equal(row.request_text_characters, 1234);
    assert.equal(row.request_user_text_characters, 1234);
    assert.equal(row.request_system_characters, 9876);
    assert.equal(row.request_payload_characters, 11110);
    assert.equal(row.provider_duration_ms, 5000);
    assert.equal(row.agent_reported_duration_ms, 9000);
    assert.ok(row.time_to_first_output_ms >= 0);
    assert.equal(row.provider_turn_count, 4);
    assert.equal(row.stop_reason, 'end_turn');
    assert.equal(row.provider_model_count, 2);
    assert.equal(row.model_context_window_tokens, 200000);
    assert.equal(row.request_tool_definition_count, 3);
    assert.equal(row.request_mcp_server_count, 1);
    assert.equal(row.request_agent_definition_count, 1);
    assert.equal(row.request_skill_count, 1);
    assert.equal(row.request_plugin_count, 1);
    assert.equal(row.context_compaction_count, 1);
    assert.equal(row.context_compaction_pre_tokens_max, 7777);
    assert.equal(row.provider_rate_limit_event_count, 1);
    assert.equal(row.provider_retry_count, undefined,
      'Claude does not expose transport retries, so absence stays unavailable');
    assert.equal(row.response_content_block_count, 10);
    assert.equal(row.response_text_block_count, 1);
    assert.equal(row.response_text_characters, 7);
    assert.equal(row.response_thinking_block_count, 1);
    assert.equal(row.response_thinking_characters, 9);
    assert.equal(row.response_tool_call_count, 8);
    assert.equal(row.tool_call_count, 8);
    assert.equal(row.tool_result_count, 2);
    assert.equal(row.tool_error_count, 1);
    assert.equal(row.distinct_tool_count, 8);
    assert.equal(row.permission_denial_count, 1);
    assert.equal(row.command_count, 1);
    assert.equal(row.file_read_count, 1);
    assert.equal(row.distinct_file_read_count, 1);
    assert.equal(row.file_search_count, 1);
    assert.equal(row.file_change_count, 1);
    assert.equal(row.distinct_file_change_count, 1);
    assert.equal(row.mcp_call_count, 1);
    assert.equal(row.subagent_call_count, 1);
    assert.equal(row.web_tool_call_count, 1);
    assert.equal(row.tool_search_count, 1);
    const serialized = JSON.stringify(row);
    for (const secret of [
      '/private/path', '/private/edit', 'secret command', 'private file content',
      'private error', 'private-server', 'private-agent', 'private-skill',
      'private-plugin', 'private task', 'private query', 'mcp__private_tool',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

test('Codex/OpenRouter JSONL produces the same content-free agent workload contract', () => {
  const state = worker.newWatchState();
  state.telemetryDiagnosticsEnabled = true;
  state.agentBackend = 'codex_openrouter';
  state.providerStartedMs = Date.now() - 50;
  const progress = () => {};
  for (const event of [
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'private command' } },
    { type: 'item.completed', item: {
      id: 'c1', type: 'command_execution', aggregated_output: 'private output',
      exit_code: 1, status: 'failed',
    } },
    { type: 'item.started', item: { id: 'r1', type: 'file_read', path: '/private/read.js' } },
    { type: 'item.completed', item: {
      id: 'r1', type: 'file_read', path: '/private/read.js', status: 'completed',
    } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [
      { kind: 'edit', path: '/private/a.js' },
      { kind: 'write', path: '/private/b.js' },
    ] } },
    { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', tool: 'private_tool' } },
    { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', status: 'completed' } },
    { type: 'error', message: 'Reconnecting... 1/5 (private transport detail)' },
    { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'private final answer' } },
  ]) {
    worker.parseLine(JSON.stringify(event), progress, state);
  }
  assert.equal(state.toolCallCount, 4);
  assert.equal(state.responseToolCallCount, 4);
  assert.equal(state.toolResultCount, 4);
  assert.equal(state.toolErrorCount, 1);
  assert.equal(state.commandCount, 1);
  assert.equal(state.fileReadCount, 1);
  assert.equal(state.fileChangeCount, 2);
  assert.equal(state.mcpCallCount, 1);
  assert.equal(state.providerRetryCount, 1);
  assert.equal(state.telemetryToolNames.size, 4);
  assert.equal(state.telemetryFileReads.size, 1);
  assert.equal(state.telemetryFileChanges.size, 2);
  assert.equal(state.responseTextBlockCount, 1);
  assert.equal(state.responseTextCharacters, 'private final answer'.length);
  assert.ok(state.timeToFirstOutputMs >= 0);
  const normalized = telemetry.normalizeDiagnostics(state);
  const serialized = JSON.stringify(normalized);
  for (const secret of [
    'private command', 'private output', '/private/read.js', '/private/a.js',
    'private_tool', 'private transport detail', 'private final answer',
  ]) assert.equal(serialized.includes(secret), false);
});

test('Claude coding-agent billing keeps platform and full BYOK paths distinct', async () => {
  await withTelemetrySink(async (rows) => {
    const result = { costUsd: 1, providerCostSeen: true, exitCode: 0 };
    const base = {
      sessionId: 42,
      result,
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_scout',
      startedAt: new Date(),
      durationMs: 10,
    };
    worker._recordClaudeCodingRunForTests({
      ...base, turnId: '55555555-5555-4555-8555-555555555555',
    });
    worker._recordClaudeCodingRunForTests({
      ...base, turnId: '66666666-6666-4666-8666-666666666666', directByok: true,
    });
    worker._recordClaudeCodingRunForTests({
      ...base, turnId: '77777777-7777-4777-8777-777777777777', byokCents: 100,
    });
    assert.deepEqual(rows.map((row) => row.billing_path), [
      'platform', 'anthropic_byok', 'anthropic_byok',
    ]);
  });
});

test('an accepted local run that disconnects is measured, while an unaccepted offer is not', async () => {
  await withTelemetrySink(async (rows) => {
    const base = {
      id: 99,
      prompt: 'private local prompt',
      created_at: new Date('2026-08-17T10:00:00.000Z'),
      accepted_at: new Date('2026-08-17T10:00:02.000Z'),
      finished_at: new Date('2026-08-17T10:00:12.000Z'),
      summary: 'private local result',
    };
    recordLocalCodingInvocation(null, {
      session: { id: 42, app_id: 7 }, turnId: 99, turn: base,
      outcome: 'abandoned', component: 'coding_agent_build',
      attemptNumber: 1, correlationId: 'local-run-1',
    });
    recordLocalCodingInvocation(null, {
      session: { id: 42, app_id: 7 }, turnId: 100,
      turn: { ...base, id: 100, accepted_at: null },
      outcome: 'abandoned', component: 'coding_agent_build',
      attemptNumber: 2, correlationId: 'local-run-1',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'local');
    assert.equal(rows[0].outcome, 'error');
    assert.equal(rows[0].error_class, 'network');
    assert.equal(rows[0].queue_duration_ms, 2000);
    assert.equal(rows[0].duration_ms, 10000);
    assert.equal(rows[0].request_text_characters, 'private local prompt'.length);
    assert.equal(rows[0].request_user_text_characters, 'private local prompt'.length);
    assert.equal(rows[0].response_text_characters, 'private local result'.length);
    assert.equal(JSON.stringify(rows[0]).includes('private local'), false);
  });
});

test('the aggregate report normalizes OpenRouter per-attempt deltas and preserves unavailable values', async () => {
  const captured = [];
  let queryNumber = 0;
  const pool = {
    async query(sql, params) {
      captured.push({ sql, params });
      queryNumber += 1;
      if (queryNumber === 2) {
        return { rows: [{
          day: '2026-08-17', invocation_count: '2', logical_run_count: '1',
          retry_invocation_count: '1',
          fallback_served_count: '0', success_count: '1', error_count: '1',
          cancelled_count: '0', refusal_count: '0', input_tokens: null,
          cache_read_input_tokens: '0', cache_write_input_tokens: null,
          output_tokens: '8', reasoning_output_tokens: null,
          total_known_cost_usd: '0.12', known_cost_available_count: '1',
          median_duration_ms: '100', p95_duration_ms: '190',
          diagnostic_metrics: {
            request_payload_characters: {
              availableCount: 2, total: 2000, average: 1000, median: 900, p95: 1500,
            },
          },
          category_counts: { request_mode: { agent_new: 1, agent_resume: 1 } },
        }] };
      }
      return { rows: [{
        provider: 'openrouter', backend: 'coding_agent', component: 'coding_agent_build',
        requested_model: 'z-ai/glm-5.3-flash', served_model: null, billing_path: 'openrouter_byok',
        invocation_count: '2', logical_run_count: '1', retry_invocation_count: '1', fallback_served_count: '0',
        success_count: '1', error_count: '1', cancelled_count: '0', refusal_count: '0',
        input_tokens: null, cache_read_input_tokens: '0', cache_write_input_tokens: null,
        output_tokens: '8', reasoning_output_tokens: null,
        total_known_cost_usd: '0.12000000', unavailable_cost_count: '1', cache_hit_rate: '0',
        input_tokens_available_count: '0', cache_read_input_tokens_available_count: '2',
        cache_write_input_tokens_available_count: '0', output_tokens_available_count: '1',
        reasoning_output_tokens_available_count: '0', known_cost_available_count: '1',
        duration_available_count: '2', billing_path_attributed_count: '2', cache_read_hit_count: '0',
        median_duration_ms: '100', p95_duration_ms: '190',
        average_cost_usd: '0.12', median_cost_usd: '0.12', p95_cost_usd: '0.12',
        provider_reported_cost_count: '0', platform_estimate_cost_count: '0', catalog_estimate_cost_count: '1',
        overall_logical_run_count: '1',
        terminal_reason_counts: { end_turn: 1, agent_error: 1 },
        diagnostic_metrics: {
          request_payload_characters: {
            availableCount: 2, total: 2000, average: 1000, median: 900, p95: 1500,
          },
          tool_call_count: {
            availableCount: 1, total: 7, average: 7, median: 7, p95: 7,
          },
        },
        category_counts: {
          request_mode: { agent_new: 1, agent_resume: 1 },
          error_class: { provider: 1 },
          usage_reset_detected: { false: 2 },
        },
      }] };
    },
  };
  const report = await telemetry.aggregateReport(pool, { days: 14 });
  assert.equal(captured.length, 2, 'group and daily aggregates are read independently');
  for (const query of captured) {
    assert.deepEqual(query.params.slice(0, 2), [telemetry.EVENT_TYPE, '14']);
    assert.ok(query.params[2].includes('request_payload_characters'));
    assert.ok(query.params[2].includes('context_compaction_count'));
    assert.ok(query.params[2].includes('subagent_call_count'));
    assert.ok(query.params[3].includes('error_class'));
    assert.match(query.sql, /FROM agent_turns a/);
    assert.match(query.sql, /e\.app_id AS app_id/);
    assert.match(query.sql, /s\.app_id AS app_id/);
    assert.match(query.sql, /provider_input_tokens_total IS NULL THEN NULL ELSE a\.input_tokens/);
    assert.match(query.sql, /a\.routed_model AS served_model/,
      'served model is reported only when it was actually observed');
    assert.doesNotMatch(query.sql, /COALESCE\(a\.routed_model, a\.requested_model\)/,
      'the requested slug is not presented as provider-observed routing');
    assert.match(query.sql, /a\.metadata \? 'telemetry_component'/);
    assert.match(query.sql, /jsonb_each_text/);
    assert.doesNotMatch(query.sql, /prompt|messages|error_detail|user_id/);
  }
  assert.match(captured[0].sql, /COUNT\(input_tokens\) AS input_tokens_available_count/);
  assert.match(captured[0].sql, /AVG\(cost_usd\) AS average_cost_usd/);
  assert.match(captured[0].sql, /jsonb_object_agg\(terminal_reason, reason_count\)/);
  assert.match(captured[0].sql, /NULLIF\(a\.error_code, ''\)/);
  assert.equal(report.groups[0].tokens.input, null);
  assert.equal(report.groups[0].tokens.cacheReadInput, 0);
  assert.equal(report.groups[0].availabilityCounts.cacheReadInputTokens, 2);
  assert.equal(report.groups[0].availabilityCounts.inputTokens, 0);
  assert.deepEqual(report.groups[0].terminalReasonCounts, { end_turn: 1, agent_error: 1 });
  assert.equal(report.groups[0].costSourceCounts.catalogEstimate, 1);
  assert.equal(report.groups[0].costSourceCounts.providerReported, 0);
  assert.equal(report.groups[0].logicalRunCount, 1);
  assert.equal(report.groups[0].retryInvocationCount, 1);
  assert.equal(report.groups[0].requestedModel, 'z-ai/glm-5.3-flash');
  assert.equal(report.groups[0].servedModel, null,
    'the report does not invent a provider-served model from the request');
  assert.deepEqual(report.groups[0].knownCostUsd, {
    average: 0.12, median: 0.12, p95: 0.12,
  });
  assert.deepEqual(report.groups[0].diagnostics.requestPayloadCharacters, {
    availableCount: 2, total: 2000, average: 1000, median: 900, p95: 1500,
  });
  assert.deepEqual(report.groups[0].categoryCounts.requestMode, {
    agent_new: 1, agent_resume: 1,
  });
  assert.equal(report.summary.invocationCount, 2);
  assert.equal(report.summary.logicalRunCount, 1);
  assert.equal(report.summary.retryInvocationCount, 1);
  assert.equal(report.summary.retryRate, 1);
  assert.equal(report.summary.tokens.input, null);
  assert.equal(report.summary.tokens.cacheReadInput, 0);
  assert.equal(report.summary.cacheHitRate, 0);
  assert.equal(report.summary.billingPathCounts.openrouter_byok, 2);
  assert.deepEqual(report.summary.terminalReasonCounts, { end_turn: 1, agent_error: 1 });
  assert.equal(report.summary.diagnostics.requestPayloadCharacters.total, 2000);
  assert.equal(report.summary.metricCoverage.requestPayloadCharacters, 1);
  assert.deepEqual(report.summary.categoryCounts.errorClass, { provider: 1 });
  assert.equal(report.daily[0].day, '2026-08-17');
  assert.equal(report.daily[0].logicalRunCount, 1);
  assert.equal(report.daily[0].diagnostics.requestPayloadCharacters.p95, 1500);
  assert.deepEqual(report.daily[0].categoryCounts.requestMode, {
    agent_new: 1, agent_resume: 1,
  });
  assert.equal(report.timeframe.timezone, 'UTC');
  assert.equal(Object.hasOwn(report.groups[0], 'appId'), false);
  assert.equal(Object.hasOwn(report.groups[0], 'sessionId'), false);
  await assert.rejects(() => telemetry.aggregateReport(pool, { days: 0 }), /between 1 and 90/);
  await assert.rejects(() => telemetry.aggregateReport(pool, { days: 91 }), /between 1 and 90/);
});

test('OpenRouter telemetry excludes a durable intent that never physically dispatched', async () => {
  const originalStart = agentTurn.startCodexAttempt;
  const originalComplete = agentTurn.completeCodexAttempt;
  const starts = [];
  const completions = [];
  agentTurn.startCodexAttempt = async (args) => {
    starts.push(args);
    return { turnUuid: `attempt-${starts.length}`, journal: `/tmp/attempt-${starts.length}` };
  };
  agentTurn.completeCodexAttempt = async (args) => {
    completions.push(args);
    return { updated: true };
  };
  const run = (providerDispatched) => runCodexAttemptLoop({
    pool: {},
    session: { id: 9, agent_config_version: 1 },
    userId: 12,
    isCodexSession: true,
    turnModel: 'openai/gpt-5.3-codex',
    mode: 'build',
    telemetryComponent: 'coding_agent_headless',
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter',
      agentModel: 'openai/gpt-5.3-codex',
      agentReasoningEffort: 'high',
      pricingSnapshot: { available: false },
    }),
    dispatchOnce: async () => ({ exitCode: providerDispatched ? 0 : 143, providerDispatched }),
    retryPredicate: () => false,
  });
  try {
    await run(false);
    await run(true);
    assert.equal(completions[0].telemetryComponent, null,
      'a pre-dispatch cancellation is not an invocation');
    assert.equal(completions[1].telemetryComponent, 'coding_agent_headless');
    assert.equal(starts[1].model, 'openai/gpt-5.3-codex');
    assert.equal(starts[1].reasoningEffort, 'high');
  } finally {
    agentTurn.startCodexAttempt = originalStart;
    agentTurn.completeCodexAttempt = originalComplete;
  }
});

test('Mayor/headless call sites carry every required phase label', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/sessions.js'), 'utf8');
  for (const component of [
    'mayor_phase_1', 'mayor_data_iteration', 'mayor_phase_2',
    'headless_decision', 'headless_wrapup',
    'coding_agent_scout', 'coding_agent_build', 'coding_agent_headless',
  ]) {
    assert.match(src, new RegExp(`['"]${component}['"]`), `${component} is attributed at its caller`);
  }
  const maintenance = fs.readFileSync(path.join(__dirname, '../src/services/fleet-maintenance.js'), 'utf8');
  assert.match(maintenance, /component: 'fleet_maintenance'/);
});

test('schema makes invocation event replay idempotent', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_events_llm_invocation_key/);
  assert.match(schema, /WHERE event_type = 'llm_invocation' AND metadata \? 'invocation_key'/);
});

test('coding-agent component context is persisted for retry and restart attribution', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/services/worker.js'), 'utf8');
  const sessionSource = fs.readFileSync(path.join(__dirname, '../src/routes/sessions.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const field of [
    'telemetryComponent', 'telemetryCorrelationId', 'telemetryAttemptNumber',
    'telemetryRequestMode', 'telemetryRequestTextCharacters',
    'telemetryRequestSystemCharacters', 'telemetryRequestPayloadCharacters',
    'telemetryModelContextWindowTokens', 'telemetryModelMaxOutputTokens',
  ]) {
    assert.match(workerSource, new RegExp(field));
    assert.match(sessionSource, new RegExp(field));
    assert.match(serverSource, new RegExp(field));
  }
});

test('admin report is protected, defaults to 14 days, and bounds the timeframe', async () => {
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  const originalAggregate = telemetry.aggregateReport;
  const calls = [];
  poolModule.getPool = () => ({ query: async () => ({ rows: [] }) });
  telemetry.aggregateReport = async (_pool, args) => {
    calls.push(args);
    return { timeframe: { days: args.days }, groups: [] };
  };

  // admin.js destructures getPool at import time, so load it only after the
  // test pool is installed.
  delete require.cache[require.resolve('../src/routes/admin')];
  const { adminRoutes } = require('../src/routes/admin');
  const express = require('express');
  let currentUser = { id: 1, isAdmin: false, canAdminWrite: false };
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({}));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/admin/llm-telemetry`, { redirect: 'manual' });
    // adminMiddleware preserves the admin console's existing unauthenticated
    // redirect behavior when mounted on this router. The important invariant
    // here is that the request never reaches the aggregate query.
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(calls.length, 0);

    currentUser = { id: 2, isAdmin: true, canAdminWrite: false };
    response = await fetch(`${base}/api/admin/llm-telemetry`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).timeframe.days, 14);

    response = await fetch(`${base}/api/admin/llm-telemetry?days=7`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).timeframe.days, 7);

    for (const invalid of ['0', '91', '1.5', 'abc']) {
      response = await fetch(`${base}/api/admin/llm-telemetry?days=${invalid}`);
      assert.equal(response.status, 400);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    telemetry.aggregateReport = originalAggregate;
    poolModule.getPool = originalGetPool;
    delete require.cache[require.resolve('../src/routes/admin')];
  }
});
