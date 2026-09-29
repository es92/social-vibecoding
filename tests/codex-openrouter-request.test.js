'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startRequestAdapter } = require('../worker/codex-openrouter-request');
const { buildCatalogFromEnvironment } = require('../worker/build-codex-model-catalog');
const codex = require('../src/agents/codex-openrouter');

const MODEL = 'z-ai/glm-5.3-flash';
const KEY = 'test-openrouter-key';

async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}

async function adapter(t, baseUrl, options = {}) {
  const instance = await startRequestAdapter({ baseUrl, apiKey: KEY, model: MODEL, maxOutputTokens: 32000, ...options });
  t.after(() => instance.close());
  return instance;
}

function request(instance, body, options = {}) {
  return fetch(`${instance.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...options,
  });
}

async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// Shaped like an actual @openai/codex 0.146.0 request with agents disabled:
// Codex's built-ins beside the preview agent's MCP servers, each sent as a
// namespace. Schemas/descriptions are intentionally omitted because the
// inventory relies only on type, namespace, and membership.
function codex0146ShotsTools() {
  return [
    { type: 'function', name: 'exec_command' },
    { type: 'function', name: 'write_stdin' },
    { type: 'function', name: 'list_mcp_resources' },
    { type: 'function', name: 'list_mcp_resource_templates' },
    { type: 'function', name: 'read_mcp_resource' },
    { type: 'function', name: 'update_plan' },
    { type: 'function', name: 'request_user_input' },
    { type: 'function', name: 'view_image' },
    { type: 'namespace', name: 'mcp__shots', tools: [
      { type: 'function', name: 'get_brief' },
      { type: 'function', name: 'save_shot' },
      { type: 'function', name: 'save_clip' },
      { type: 'function', name: 'skip_change' },
      { type: 'function', name: 'fail_request' },
    ] },
    { type: 'namespace', name: 'mcp__browser_member', tools: [
      { type: 'function', name: 'browser_navigate' },
      { type: 'function', name: 'browser_take_screenshot' },
      { type: 'function', name: 'browser_close' },
    ] },
    { type: 'namespace', name: 'mcp__browser_admin', tools: [
      { type: 'function', name: 'browser_navigate' },
      { type: 'function', name: 'browser_take_screenshot' },
    ] },
    { type: 'namespace', name: 'mcp__browser_full_admin', tools: [
      { type: 'function', name: 'browser_navigate' },
    ] },
    { type: 'function', name: 'get_goal' },
    { type: 'web_search' },
  ];
}

test('the wire cap is enforced on every GLM request, independently of history size', async t => {
  const calls = [];
  const base = await upstream(t, async (req, res) => {
    calls.push({ url: req.url, headers: req.headers, body: await json(req) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-glm-1' });
    res.end('{"id":"response-1"}');
  });
  const diagnostics = [];
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const original = {
    model: MODEL, stream: true, instructions: 'coding instructions',
    input: [{ role: 'user', content: 'Short request ☀' }],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' }, store: false, parallel_tool_calls: true,
  };
  const bodies = [
    original,
    { ...original, input: [{ role: 'user', content: 'long history '.repeat(20000) }] },
    { ...original, instructions: 'Summarize the conversation', max_output_tokens: 128000 },
    { ...original, max_output_tokens: 8000 },
  ];
  for (const body of bodies) {
    const response = await request(instance, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-glm-1');
    assert.deepEqual(await response.json(), { id: 'response-1' });
  }
  assert.deepEqual(calls.map(c => c.body.max_output_tokens), [32000, 32000, 32000, 8000]);
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i].url, '/api/v1/responses');
    assert.equal(calls[i].headers.authorization, `Bearer ${KEY}`);
    const { max_output_tokens: _cap, ...rest } = calls[i].body;
    const { max_output_tokens: _originalCap, ...expected } = bodies[i];
    assert.deepEqual(rest, expected, 'the adapter must preserve tools, history and reasoning');
  }
  assert.equal(diagnostics[0].maxOutputTokens, 32000);
  assert.equal(diagnostics[0].inputBytes, Buffer.byteLength(JSON.stringify(original.input)));
  assert.equal(diagnostics[0].inputItems, 1);
  assert.equal(diagnostics[0].httpStatus, 200);
  assert.equal(diagnostics[0].requestId, 'req-glm-1');
  assert.doesNotMatch(JSON.stringify(diagnostics), /test-openrouter-key|coding instructions|Short request|long history/);
});

// The preview agent's turn has no terminal tool: it saves shots as it goes
// and its turn simply ends. So the adapter forwards an evidence request's
// tool surface exactly as Codex sent it, and only describes it.
test('an evidence request keeps its whole tool surface and reports the shots inventory once', async t => {
  const calls = [];
  const base = await upstream(t, async (req, res) => {
    calls.push(await json(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'function_call', namespace: 'mcp__shots', name: 'save_shot' };
    res.end(`data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`);
  });
  const events = [];
  const instance = await adapter(t, base, {
    reportEvidenceToolConfig: true,
    onTiming: event => events.push(event),
  });
  const tools = codex0146ShotsTools();
  // A tool-free compaction call first: nothing to describe yet.
  const compaction = await request(instance, { model: MODEL, stream: true, input: [], tools: [] });
  assert.equal(compaction.status, 200);
  await compaction.text();
  for (let i = 0; i < 2; i++) {
    const response = await request(instance, {
      model: MODEL, stream: true, input: [], tools,
      tool_choice: 'auto', parallel_tool_calls: true,
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.tools, tools, 'Codex built-ins and every MCP server are forwarded');
    assert.equal(call.tool_choice, 'auto', 'the model is never forced to call a tool');
    assert.equal(call.parallel_tool_calls, true);
  }
  const starts = events.filter(event => event.kind === 'provider_request_start');
  assert.equal(starts.length, 3);
  for (const start of starts) {
    assert.equal('terminalToolChoiceRequired' in start, false);
    assert.equal('terminalToolDefinitionCount' in start, false);
  }
  const configs = events.filter(event => event.kind === 'provider_tool_config');
  assert.equal(configs.length, 1, 'the surface is described once, on the first request that has one');
  const [config] = configs;
  assert.equal(config.mcpServerCount, 4);
  assert.equal(config.toolDefinitionCount, 14);
  assert.equal(config.topLevelFunctionToolCount, 9);
  assert.equal(config.topLevelNamespaceToolCount, 4);
  assert.equal(config.topLevelOtherToolCount, 1);
  assert.equal(config.nestedToolDefinitionCount, 11);
  assert.equal(config.nestedFunctionToolCount, 11);
  assert.equal(config.shotsToolDefinitionCount, 5);
  assert.equal(config.briefToolAvailable, true);
  assert.equal(config.saveShotToolAvailable, true);
  assert.equal(config.skipChangeToolAvailable, true);
  assert.equal(config.browserMemberToolCount, 3);
  assert.equal(config.browserAdminToolCount, 2);
  assert.equal(config.browserFullAdminToolCount, 1);
  assert.equal(config.otherMcpServerCount, 0);
  assert.equal(config.forwardedToolDefinitionCount, 14);
  for (const gone of ['completionReminder', 'terminalToolChoiceRequired', 'toolSurfaceFiltered',
    'terminalToolWireFormat', 'removedToolDefinitionCount', 'evidenceToolDefinitionCount',
    'evidenceRunPlanAvailable', 'evidenceReportBlockerAvailable', 'evidenceGetContextAvailable']) {
    assert.equal(gone in config, false, `${gone} is not reported`);
  }
});

test('the shots inventory reads the older flat MCP encoding too', async t => {
  let providerBody;
  const base = await upstream(t, async (req, res) => {
    providerBody = await json(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"response-flat"}');
  });
  const events = [];
  const instance = await adapter(t, base, {
    reportEvidenceToolConfig: true,
    onTiming: event => events.push(event),
  });
  const tools = [
    { type: 'function', name: 'exec_command' },
    { type: 'function', name: 'mcp__shots__get_brief' },
    { type: 'function', name: 'mcp__shots__save_shot' },
    { type: 'function', name: 'mcp__shots__skip_change' },
    { type: 'function', name: 'mcp__browser_member__browser_navigate' },
  ];
  const response = await request(instance, { model: MODEL, tools });
  assert.equal(response.status, 200);
  assert.deepEqual(providerBody.tools, tools);
  assert.equal(providerBody.tool_choice, undefined);
  const config = events.find(event => event.kind === 'provider_tool_config');
  assert.equal(config.mcpServerCount, 2);
  assert.equal(config.shotsToolDefinitionCount, 3);
  assert.equal(config.briefToolAvailable, true);
  assert.equal(config.saveShotToolAvailable, true);
  assert.equal(config.skipChangeToolAvailable, true);
  assert.equal(config.browserMemberToolCount, 1);
  assert.equal(config.forwardedToolDefinitionCount, 5);
});

test('a shots tool served by another MCP server is not counted as available', async t => {
  const base = await upstream(t, async (req, res) => {
    await json(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const events = [];
  const instance = await adapter(t, base, {
    reportEvidenceToolConfig: true,
    onTiming: event => events.push(event),
  });
  // The retired server name, and a browser server that happens to carry a
  // tool of the same name: neither is the run-scoped shots bridge.
  const response = await request(instance, { model: MODEL, tools: [
    { type: 'namespace', name: 'mcp__evidence', tools: [
      { type: 'function', name: 'get_brief' },
      { type: 'function', name: 'evidence_run_plan' },
    ] },
    { type: 'namespace', name: 'mcp__browser_member', tools: [
      { type: 'function', name: 'save_shot' },
    ] },
  ] });
  assert.equal(response.status, 200);
  const config = events.find(event => event.kind === 'provider_tool_config');
  assert.equal(config.shotsToolDefinitionCount, 0);
  assert.equal(config.briefToolAvailable, false);
  assert.equal(config.saveShotToolAvailable, false);
  assert.equal(config.skipChangeToolAvailable, false);
  assert.equal(config.otherMcpServerCount, 1, 'the unknown server is counted, not trusted');
});

test('the tool surface is described only for an evidence turn', async t => {
  const base = await upstream(t, async (req, res) => {
    await json(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const events = [];
  const instance = await adapter(t, base, { onTiming: event => events.push(event) });
  const response = await request(instance, { model: MODEL, tools: codex0146ShotsTools() });
  assert.equal(response.status, 200);
  assert.equal(events.some(event => event.kind === 'provider_tool_config'), false);
});

test('evidence timing separates provider wait, first byte, and stream completion without content', async t => {
  const privateText = 'private model output';
  const base = await upstream(t, async (req, res) => {
    await json(req);
    await new Promise(resolve => setTimeout(resolve, 30));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ delta: privateText })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 30));
    res.end('data: [DONE]\n\n');
  });
  const events = [];
  const instance = await adapter(t, base, {
    onTiming: event => events.push(event), timingIntervalMs: 5,
  });
  const response = await request(instance, {
    model: MODEL, stream: true, input: [{ role: 'user', content: 'private input' }],
    instructions: 'private instructions', previous_response_id: 'private-response-id',
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /private model output/);
  assert.equal(events[0].kind, 'provider_request_start');
  assert.ok(events[0].payloadBytes > events[0].inputBytes + events[0].instructionBytes);
  assert.equal(events[0].inputBytes, Buffer.byteLength(JSON.stringify([
    { role: 'user', content: 'private input' },
  ])));
  assert.equal(events[0].instructionBytes, Buffer.byteLength(JSON.stringify('private instructions')));
  assert.equal(events[0].inputItems, 1);
  assert.equal(events[0].previousResponseLinked, true);
  assert.equal(events[0].maxOutputTokens, 32000);
  assert.ok(events.some(event => event.kind === 'provider_request_pending'
    && event.stage === 'await_headers'));
  assert.ok(events.some(event => event.kind === 'provider_request_pending'
    && event.stage === 'streaming' && event.responseBytes > 0 && event.chunkCount > 0));
  assert.deepEqual(events.filter(event => [
    'provider_response_headers', 'provider_response_first_byte', 'provider_request_end',
  ].includes(event.kind)).map(event => event.kind), [
    'provider_response_headers', 'provider_response_first_byte', 'provider_request_end',
  ]);
  assert.equal(events.at(-1).outcome, 'ok');
  assert.ok(events.at(-1).durationMs >= events.find(event => event.kind === 'provider_response_first_byte').durationMs);
  assert.ok(events.at(-1).responseBytes > 0);
  assert.equal(events.at(-1).httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(events), /private|api\/v1/i);
});

test('a real HTTP refusal is retried with the smaller limit on the wire and safe ledger evidence', async t => {
  // The attempt-loop's database behavior is covered in agent-ledger-codex;
  // this test connects its decision to the HTTP boundary without a paid call.
  const { codexMaxTokensRetry } = require('../src/routes/sessions');
  const caps = [];
  const routes = [];
  const base = await upstream(t, async (req, res) => {
    routes.push(req.url);
    if (req.url === '/api/v1/key') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: {
        limit: 100, limit_remaining: 85, limit_reset: 'weekly',
        label: 'private@example.test', hash: 'private-key-hash', usage: 15,
      } }));
      return;
    }
    const body = await json(req);
    caps.push(body.max_output_tokens);
    if (body.max_output_tokens > 16000) {
      res.writeHead(402, { 'content-type': 'application/json', 'x-request-id': 'req-refused' });
      res.end(JSON.stringify({ error: {
        message: `This request requires more credits, or fewer max_tokens. You requested up to ${body.max_output_tokens} tokens, but can only afford 16000.`,
      } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"response-retry"}');
    }
  });
  const state = codex.newCodexState();
  const first = await adapter(t, base, { onRequest: diagnostic => codex.normalizeCodexLine(JSON.stringify({
    type: 'usernode.openrouter.request', diagnostic,
  }), state) });
  const response = await request(first, { model: MODEL, input: [{ role: 'user', content: 'Hello' }] });
  assert.equal(response.status, 402);
  codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: (await response.json()).error }), state);
  const retry = codexMaxTokensRetry(state);
  assert.deepEqual(retry, { clamped: 12800 });
  // The same catalog path the runner uses supplies the next invocation.
  const catalog = buildCatalogFromEnvironment({
    AGENT_MODEL: MODEL, AGENT_MODEL_MAX_OUTPUT_TOKENS: String(retry.clamped),
  });
  const second = await adapter(t, base, { maxOutputTokens: catalog.models[0].max_output_tokens });
  const success = await request(second, { model: MODEL, input: [{ role: 'user', content: 'Hello' }] });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).id, 'response-retry');
  assert.deepEqual(caps, [32000, 12800]);
  assert.deepEqual(routes, ['/api/v1/responses', '/api/v1/key', '/api/v1/responses']);
  const evidence = codex.providerFailureDiagnostics(state);
  assert.equal(evidence.requestedOutputTokens, 32000);
  assert.equal(evidence.affordableOutputTokens, 16000);
  assert.equal(evidence.request.keyRemainingUsd, 85);
  assert.equal(evidence.request.keyLimitReset, 'weekly');
  assert.equal(evidence.request.requestId, 'req-refused');
  assert.doesNotMatch(JSON.stringify(evidence), /private@|private-key-hash|test-openrouter-key|Hello/);
});

test('streaming is forwarded before completion and cancellation closes the upstream request', async t => {
  let finish;
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const base = await upstream(t, async (req, res) => {
    await json(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n');
    finish = () => res.end('event: response.completed\ndata: {}\n\n');
    res.on('close', disconnected);
  });
  const instance = await adapter(t, base);
  const controller = new AbortController();
  const response = await request(instance, { model: MODEL, stream: true, input: [] }, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString(), /hello/);
  assert.equal(typeof finish, 'function', 'first chunk arrives while the upstream response is still open');
  controller.abort();
  await closed;
});

test('key lookup failure never replaces the original provider refusal', async t => {
  const diagnostics = [];
  const original = '{"error":{"message":"This request requires more credits, or fewer max_tokens."}}';
  const base = await upstream(t, (req, res) => {
    req.resume();
    res.writeHead(req.url.endsWith('/key') ? 403 : 402, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/key') ? '{"error":"lookup forbidden"}' : original);
  });
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const response = await request(instance, { model: MODEL, input: [] });
  assert.equal(response.status, 402);
  assert.equal(await response.text(), original);
  assert.equal(diagnostics[0].keyLookupStatus, 403);
  assert.equal(diagnostics[0].keyRemainingUsd, undefined);
});

test('HTTP and streamed 402 metadata identify the actual limiting budget with an unlimited key', async t => {
  for (const streamed of [false, true]) {
    for (const [source, reason, wording] of [
      ['openrouter_in_flight_budget', 'in_flight_budget_exhausted', /running or recently completed requests.*7 seconds/],
      ['openrouter_key_limit', null, /API key’s spending limit has been reached/],
      ['openrouter_credits', 'weight_exceeds_budget', /estimated cost.*even when the account has credit/],
    ]) {
      await t.test(`${streamed ? 'SSE' : 'HTTP'} ${source}`, async sub => {
        const payload = { error: { code: 402, message: 'Request refused', metadata: {
          limit_source: source, reason, remedy_hint: 'private freeform detail', raw: 'secret provider body',
        } } };
        const body = streamed ? `event: response.failed\r\ndata: ${JSON.stringify({
          type: 'response.failed', response: payload,
        })}\r\n\r\n` : JSON.stringify(payload);
        let keyCalls = 0;
        const base = await upstream(sub, (req, res) => {
          req.resume();
          if (req.url.endsWith('/key')) {
            keyCalls++;
            res.setHeader('content-type', 'application/json');
            res.end('{"data":{"limit":null,"limit_remaining":null}}');
            return;
          }
          res.writeHead(streamed ? 200 : 402, {
            'content-type': streamed ? 'text/event-stream' : 'application/json', 'retry-after': '7',
          });
          res.write(body.slice(0, 70));
          setImmediate(() => res.end(body.slice(70)));
        });
        const state = codex.newCodexState();
        const instance = await adapter(sub, base, { onRequest: diagnostic => {
          codex.normalizeCodexLine(JSON.stringify({ type: 'usernode.openrouter.request', diagnostic }), state);
        } });
        const response = await request(instance, { model: MODEL, input: [] });
        assert.equal(response.status, streamed ? 200 : 402);
        assert.equal(await response.text(), body, 'the provider response is forwarded byte for byte');
        const events = codex.normalizeCodexLine(JSON.stringify({
          type: 'turn.failed', error: { message: 'stream disconnected before completion: Request refused' },
        }), state);
        assert.equal(state.agentErrorCode, 'insufficient_credits', 'the recorded 402 survives a stripped CLI message');
        assert.equal(state.providerRequest.limitSource, source);
        assert.equal(state.providerRequest.keyLimitUsd, null, 'unlimited is not zero credit');
        assert.equal(state.providerRequest.keyRemainingUsd, null);
        assert.equal(keyCalls, 1, 'HTTP and body diagnostics share a single key lookup');
        assert.match(events[0].text, wording);
        assert.doesNotMatch(events[0].text, /out of credit|agent needs more|Top up/);
        assert.doesNotMatch(JSON.stringify(codex.providerFailureDiagnostics(state)), /private freeform|secret provider/);
      });
    }
  }
});

test('large SSE output stays intact and does not hide a later provider refusal', async t => {
  const text = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'λ'.repeat(80000) })}\n\n`;
  const refusal = `data: ${JSON.stringify({ type: 'error', error: {
    code: 402, message: 'provider refused', metadata: { provider_name: 'Test Provider' },
  } })}\n\n`;
  const base = await upstream(t, (req, res) => {
    req.resume();
    if (req.url.endsWith('/key')) { res.end('{"data":{"limit":null}}'); return; }
    res.setHeader('content-type', 'text/event-stream');
    res.write(text.slice(0, 70000));
    setImmediate(() => res.end(text.slice(70000) + refusal));
  });
  const diagnostics = [];
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const response = await request(instance, { model: MODEL, stream: true, input: [] });
  assert.equal(await response.text(), text + refusal);
  assert.equal(diagnostics.at(-1).providerName, 'Test Provider');
  assert.equal(diagnostics.at(-1).providerErrorStatus, 402);
  assert.doesNotMatch(JSON.stringify(diagnostics), /λ|provider refused/);
});

test('only the selected model and authenticated Responses requests reach the provider', async t => {
  let upstreamCalls = 0;
  const base = await upstream(t, (req, res) => {
    upstreamCalls++;
    req.resume();
    res.end('{}');
  });
  const instance = await adapter(t, base);
  const cases = [
    [{ model: 'another/model', input: [] }, {}, 400],
    [{ model: MODEL }, { headers: { authorization: 'Bearer wrong' } }, 401],
    [{ model: MODEL }, { headers: { authorization: `Bearer ${KEY}`, 'content-encoding': 'gzip' } }, 415],
    ...[0, -1, 1.5, '32000'].map(max_output_tokens => [{ model: MODEL, max_output_tokens }, {}, 400]),
  ];
  for (const [body, options, expected] of cases) {
    const response = await request(instance, body, options);
    assert.equal(response.status, expected);
    await response.body.cancel();
  }
  const wrongRoute = await fetch(`${instance.baseUrl}/key`);
  assert.equal(wrongRoute.status, 404);
  await wrongRoute.body.cancel();
  assert.equal(upstreamCalls, 0);
});

test('closing the invocation releases its listener', async t => {
  const base = await upstream(t, (req, res) => { req.resume(); res.end('{}'); });
  const instance = await startRequestAdapter({ baseUrl: base, apiKey: KEY, model: MODEL, maxOutputTokens: 32000 });
  await instance.close();
  // Use raw http so the suite's loopback fetch retry cannot hide lifecycle errors.
  await new Promise((resolve, reject) => {
    const req = http.get(`${instance.baseUrl}/responses`, () => reject(new Error('listener still open')));
    req.on('error', err => err.code === 'ECONNREFUSED' ? resolve() : reject(err));
  });
});

// ── Per-request usage, for a turn that never reaches turn.completed (#3038) ──

const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const COMPLETED_USAGE = {
  input_tokens: 1200, input_tokens_details: { cached_tokens: 800 },
  output_tokens: 90, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1290,
};

test('each finished request reports its usage as it ends, counts only, even when the final event is large', async t => {
  // The terminal event carries the whole response object. A long answer or
  // a big tool call makes it far larger than an error envelope, which is
  // exactly when losing its usage would hurt.
  const secret = 'model output that must not leave the worker ';
  const body = sse({ type: 'response.output_text.delta', delta: 'hello' })
    + sse({ type: 'response.completed', response: {
      id: 'resp-1', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: secret.repeat(5000) }] }],
      usage: COMPLETED_USAGE,
    } });
  assert.ok(body.length > 64 * 1024, 'bigger than the error-diagnostic cap');
  const base = await upstream(t, (req, res) => {
    req.resume();
    res.setHeader('content-type', 'text/event-stream');
    // Split into small writes so the event boundary search is exercised
    // across chunks.
    let i = 0;
    const next = () => {
      if (i >= body.length) { res.end(); return; }
      res.write(body.slice(i, i + 4096));
      i += 4096;
      setImmediate(next);
    };
    next();
  });
  const usages = [];
  const instance = await adapter(t, base, { onUsage: u => usages.push(u) });
  const response = await request(instance, { model: MODEL, stream: true, input: [] });
  assert.equal(await response.text(), body, 'the stream is forwarded byte for byte');
  assert.deepEqual(usages, [{ inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90, reasoningOutputTokens: 30 }]);
  assert.doesNotMatch(JSON.stringify(usages), /must not leave|resp-1/);
});

test('incomplete and failed responses report usage too; a stream cut off before its end reports none', async t => {
  let mode = 'incomplete';
  const base = await upstream(t, (req, res) => {
    req.resume();
    res.setHeader('content-type', 'text/event-stream');
    if (mode === 'incomplete') {
      res.end(sse({ type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 500, output_tokens: 4000 } } }));
    } else if (mode === 'failed') {
      res.end(sse({ type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 300, output_tokens: 0 } } }));
    } else {
      // A stream that stops mid-answer: what a stopped turn's last request
      // looks like. Nothing reports, which is why the turn's figure is a floor.
      res.end(sse({ type: 'response.output_text.delta', delta: 'partial' }));
    }
  });
  const usages = [];
  const instance = await adapter(t, base, { onUsage: u => usages.push(u) });
  await (await request(instance, { model: MODEL, stream: true, input: [] })).text();
  mode = 'failed';
  await (await request(instance, { model: MODEL, stream: true, input: [] })).text();
  mode = 'cut';
  await (await request(instance, { model: MODEL, stream: true, input: [] })).text();
  assert.deepEqual(usages.map(u => [u.inputTokens, u.outputTokens]), [[500, 4000], [300, 0]]);
});

test('a terminal event past the usage cap is forwarded untouched and simply unreported', async t => {
  const body = sse({ type: 'response.completed', response: {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(5 * 1024 * 1024) }] }],
    usage: COMPLETED_USAGE,
  } });
  const base = await upstream(t, (req, res) => {
    req.resume();
    res.setHeader('content-type', 'text/event-stream');
    res.end(body);
  });
  const usages = [];
  const instance = await adapter(t, base, { onUsage: u => usages.push(u) });
  const response = await request(instance, { model: MODEL, stream: true, input: [] });
  assert.equal((await response.text()).length, body.length);
  assert.deepEqual(usages, [], 'memory stays bounded; the figure is only ever lower, never wrong');
});

test('the invocation writes each usage as a content-free line the normalizer sums', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'worker', 'codex-openrouter-request.js'), 'utf8');
  assert.match(src, /onUsage: usage => process\.stdout\.write\(`\$\{JSON\.stringify\(\{ type: 'usernode\.openrouter\.usage', usage \}\)\}\\n`\)/);
});

test('relay usage lines sum per turn through the real worker parser, apart from the agent totals', () => {
  const worker = require('../src/services/worker');
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const feed = line => worker.parseLine(JSON.stringify(line), () => {}, state);
  feed({ type: 'usernode.openrouter.usage', usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 90, reasoningOutputTokens: 30 } });
  feed({ type: 'usernode.openrouter.usage', usage: { inputTokens: 1500, cachedInputTokens: 1100, outputTokens: 40, reasoningOutputTokens: null } });
  feed({ type: 'usernode.openrouter.usage', usage: { inputTokens: -5, outputTokens: 'lots' } });
  assert.deepEqual(state.relayUsage, {
    requests: 2, inputTokens: 2700, cachedInputTokens: 1900, outputTokens: 130, reasoningOutputTokens: 30,
  }, 'a malformed line is ignored rather than counted');
  assert.equal(state.inputTokens ?? null, null, "the agent's own totals are untouched: the ledger prices those");
  assert.equal(codex.newCodexState().relayUsage, null);
});
