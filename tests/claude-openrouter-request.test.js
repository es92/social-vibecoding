'use strict';

// #3296: worker/claude-openrouter-request.js lets Claude Code run an
// OpenRouter model without ever holding the user's key. These pin the
// adapter's policy (model pin, output cap, auth, routes, header allowlist),
// the environment Claude Code gets, redaction, and run-cc.sh driving it end
// to end against a stub `claude` and a fake OpenRouter.
//
// Run with: node --test tests/claude-openrouter-request.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { RUNNER_TEST_ENV } = require('./lib/runner-env');

const {
  startMessagesAdapter, applyTurnPolicy, pairToolIds, makeRedactor, claudeChildEnv, PROVIDER_PREFERENCES,
} = require('../worker/claude-openrouter-request');

const ROOT = path.join(__dirname, '..');
const GLM = 'z-ai/glm-5.3-flash';
const KEY = 'sk-or-v1-0123456789abcdef-user-key';

test('every request is pinned to the session model and capped at its output limit', () => {
  assert.deepEqual(
    applyTurnPolicy({ model: 'claude-haiku-4-5', max_tokens: 200_000, messages: [] },
      { model: GLM, maxOutputTokens: 64_000, countTokens: false }),
    { model: GLM, max_tokens: 64_000, messages: [], provider: PROVIDER_PREFERENCES },
  );
  // A smaller ask is kept; a missing or invalid one gets the cap.
  assert.equal(applyTurnPolicy({ max_tokens: 4096 }, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 4096);
  assert.equal(applyTurnPolicy({}, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 64_000);
  assert.equal(applyTurnPolicy({ max_tokens: -1 }, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 64_000);
  // Unknown catalog limit: the ask passes through unchanged.
  assert.equal(applyTurnPolicy({ max_tokens: 32_000 }, { model: GLM, maxOutputTokens: null }).max_tokens, 32_000);
  // A thinking budget the cap would invalidate is dropped, not sent as a 400.
  const clamped = applyTurnPolicy(
    { max_tokens: 100_000, thinking: { type: 'enabled', budget_tokens: 80_000 } },
    { model: GLM, maxOutputTokens: 32_000 },
  );
  assert.equal(clamped.max_tokens, 32_000);
  assert.equal(clamped.thinking, undefined);
  const kept = applyTurnPolicy(
    { max_tokens: 100_000, thinking: { type: 'enabled', budget_tokens: 8_000 } },
    { model: GLM, maxOutputTokens: 32_000 },
  );
  assert.deepEqual(kept.thinking, { type: 'enabled', budget_tokens: 8_000 });
  // count_tokens carries no max_tokens; only the model is pinned.
  assert.deepEqual(
    applyTurnPolicy({ model: 'x', messages: [] }, { model: GLM, maxOutputTokens: 10, countTokens: true }),
    { model: GLM, messages: [] },
  );
});

test('every model request prefers hosts that answer promptly, without excluding any or overriding a preference sent', () => {
  // A GLM build on 2026-10-06 sat on a host averaging 44 s a request until
  // its clock ran out. OpenRouter moves a host that misses these to the end
  // of its list; it never drops one, and price still decides among the rest.
  assert.deepEqual(PROVIDER_PREFERENCES, {
    preferred_max_latency: { p90: 15 },
    preferred_min_throughput: { p50: 30 },
  });
  assert.equal(Object.isFrozen(PROVIDER_PREFERENCES), true);
  const body = applyTurnPolicy({ max_tokens: 10, messages: [] }, { model: GLM, maxOutputTokens: 64_000 });
  assert.deepEqual(body.provider, PROVIDER_PREFERENCES);
  assert.equal(body.provider.sort, undefined, 'no sort or order: OpenRouter keeps balancing by price');
  assert.equal(body.provider.order, undefined);
  const asked = applyTurnPolicy({ max_tokens: 10, provider: { preferred_max_latency: 5, zdr: true } }, { model: GLM, maxOutputTokens: 64_000 });
  assert.deepEqual(asked.provider, { preferred_max_latency: 5, preferred_min_throughput: { p50: 30 }, zdr: true });
  assert.equal(applyTurnPolicy({ messages: [] }, { model: GLM, countTokens: true }).provider, undefined, 'counting tokens is not routed');
  // The Codex listener asks for the same.
  assert.deepEqual(require('../worker/codex-openrouter-request').PROVIDER_PREFERENCES, PROVIDER_PREFERENCES);
});

test('the thinking level is sent as output_config.effort, which OpenRouter maps for every model', () => {
  const body = applyTurnPolicy(
    { max_tokens: 10, output_config: { format: 'kept' }, thinking: { type: 'disabled' }, messages: [] },
    { model: GLM, maxOutputTokens: 10, reasoningEffort: 'xhigh' },
  );
  assert.deepEqual(body.output_config, { format: 'kept', effort: 'xhigh' });
  // thinking: disabled would switch reasoning off for a non-Anthropic model.
  assert.equal(body.thinking, undefined);
  // An adaptive or budgeted thinking stays: effort outranks it on OpenRouter.
  const adaptive = applyTurnPolicy(
    { max_tokens: 10, thinking: { type: 'adaptive' }, messages: [] },
    { model: GLM, maxOutputTokens: 10, reasoningEffort: 'low' },
  );
  assert.deepEqual(adaptive.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptive.output_config, { effort: 'low' });
  // No effort, or one outside the scale: the request is left to the model.
  for (const effort of [null, '', 'turbo']) {
    const untouched = applyTurnPolicy(
      { max_tokens: 10, thinking: { type: 'disabled' }, messages: [] },
      { model: GLM, maxOutputTokens: 10, reasoningEffort: effort },
    );
    assert.equal(untouched.output_config, undefined, String(effort));
    assert.deepEqual(untouched.thinking, { type: 'disabled' });
  }
  // count_tokens is not a generation.
  const count = applyTurnPolicy({ messages: [] }, { model: GLM, countTokens: true, reasoningEffort: 'high' });
  assert.equal(count.output_config, undefined);
});

test("Claude Code's Anthropic web search becomes OpenRouter's, capped", () => {
  const body = applyTurnPolicy({
    max_tokens: 10, messages: [],
    tools: [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 8, blocked_domains: ['example.test'] },
    ],
  }, { model: GLM, maxOutputTokens: 10 });
  assert.deepEqual(body.tools, [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    { type: 'openrouter:web_search', parameters: { max_uses: 5, excluded_domains: ['example.test'] } },
  ]);
  const allowed = applyTurnPolicy({
    messages: [],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2,
      allowed_domains: ['docs.example.test'], blocked_domains: ['x.example.test'] }],
  }, { model: GLM });
  assert.deepEqual(allowed.tools, [{
    type: 'openrouter:web_search', parameters: { max_uses: 2, allowed_domains: ['docs.example.test'] },
  }]);
  // Anything that is not Anthropic's web search tool passes untouched.
  const other = applyTurnPolicy({ messages: [], tools: [{ type: 'bash_20250124', name: 'bash' }] }, { model: GLM });
  assert.deepEqual(other.tools, [{ type: 'bash_20250124', name: 'bash' }]);
});

test('images and documents become a note, because OpenRouter models run on text', () => {
  const body = applyTurnPolicy({
    model: 'x', max_tokens: 10,
    messages: [
      { role: 'user', content: 'plain string content stays' },
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'screenshot taken' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        ] },
        { type: 'tool_result', tool_use_id: 't2', content: 'string result' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCCC' } },
      ] },
    ],
  }, { model: GLM, maxOutputTokens: 10 });
  assert.equal(body.messages[0].content, 'plain string content stays');
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'look' },
    { type: 'text', text: '[image omitted: this model reads text only]' },
  ]);
  assert.deepEqual(body.messages[2].content[0].content, [
    { type: 'text', text: 'screenshot taken' },
    { type: 'text', text: '[image omitted: this model reads text only]' },
  ]);
  assert.equal(body.messages[2].content[0].tool_use_id, 't1');
  assert.equal(body.messages[2].content[1].content, 'string result');
  assert.deepEqual(body.messages[2].content[2], { type: 'text', text: '[document omitted: this model reads text only]' });
  assert.ok(!JSON.stringify(body).includes('AAAA'));
});

// OpenRouter sends a non-Anthropic model's request in OpenAI's chat format,
// where each tool_result is a `tool` message carrying tool_call_id. One with
// an empty id fails the request: "400 messages[N]: tool messages must include
// a non-empty string tool_call_id" (GLM, 2026-10-04 and 2026-10-09).
function everyResultPaired(messages) {
  let calls = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant') {
      calls = message.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      for (const id of calls) assert.ok(typeof id === 'string' && id.trim(), 'every tool call has an id');
      continue;
    }
    for (const block of message.content.filter((b) => b.type === 'tool_result')) {
      assert.ok(typeof block.tool_use_id === 'string' && block.tool_use_id.trim(), 'every tool result has an id');
      assert.ok(calls.includes(block.tool_use_id), `${block.tool_use_id} answers a call just before it`);
      calls = calls.filter((id) => id !== block.tool_use_id);
    }
    assert.deepEqual(calls, [], 'and every call is answered');
    calls = [];
  }
}

test('a tool call and result with an empty or missing id are paired by an id made for them, the same on every request', () => {
  const conversation = () => [
    { role: 'user', content: 'Fix the button.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: '', name: 'Read', input: { file_path: 'a.js' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'b.js' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: '', content: 'a' },
      { type: 'tool_result', content: [{ type: 'text', text: 'b' }] },
    ] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'x' }] },
  ];
  const body = applyTurnPolicy({ messages: conversation() }, { model: GLM, countTokens: false });
  everyResultPaired(body.messages);
  assert.deepEqual(body.messages[1].content.slice(1).map((b) => b.id), ['toolu_hr_1_1', 'toolu_hr_1_2']);
  assert.deepEqual(body.messages[2].content.map((b) => b.tool_use_id), ['toolu_hr_1_1', 'toolu_hr_1_2'], 'results in order');
  assert.equal(body.messages[2].content[1].content[0].text, 'b', 'what the result said is kept');
  assert.equal(body.messages[3].content[0].id, 'toolu_ok', 'a good id is left alone');
  const again = applyTurnPolicy({ messages: conversation() }, { model: GLM, countTokens: true });
  assert.deepEqual(again.messages, body.messages, 'the same ids on the next request, so the cached prefix holds');
});

test('a tool result with no id and no call left to answer becomes text; one with an id is never touched', () => {
  const fine = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  assert.equal(pairToolIds(fine), fine);
  const out = pairToolIds([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '', content: 'lost' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't9', content: 'stray' },
      { type: 'tool_result', tool_use_id: ' ', content: 'extra' },
    ] },
  ]);
  assert.deepEqual(out[0].content, [{ type: 'text', text: '[a tool result that answers no tool call:\nlost]' }]);
  assert.deepEqual(out[2].content, [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 't9', content: 'stray' },
    { type: 'text', text: '[a tool result that answers no tool call:\nextra]' },
  ]);
  for (const message of out) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_result') assert.ok(block.tool_use_id.trim(), 'no result is left without an id');
    }
  }
});

test('the adapter sends OpenRouter a request whose every tool result carries its call\'s id', async (t) => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'gen-1', type: 'message', content: [] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const adapter = await startMessagesAdapter({
    baseUrl: `http://127.0.0.1:${upstream.address().port}/api/v1`, apiKey: KEY, model: GLM, localToken: 'local-token-0123456789',
  });
  t.after(() => adapter.close());
  const res = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local-token-0123456789' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '', content: 'a.js' }] },
    ] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  everyResultPaired(received.messages);
  assert.equal(received.messages[2].content[0].tool_use_id, 'toolu_hr_1_0');
});

test('Claude Code gets the adapter and a local token, never the key', () => {
  const env = claudeChildEnv({
    PATH: '/bin', OPENROUTER_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: 'stale', HOMEROOM_MCP_TOKEN: 'grant',
  }, { baseUrl: 'http://127.0.0.1:4000', localToken: 'local', model: GLM });
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(env.ANTHROPIC_API_KEY, 'local');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(env[name], GLM, name);
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  // The Homeroom bridge Claude spawns still needs its grant.
  assert.equal(env.HOMEROOM_MCP_TOKEN, 'grant');
  assert.equal(env.PATH, '/bin');
  assert.ok(!Object.values(env).includes(KEY));
});

test('Claude Code compacts a non-Anthropic model at 120k, or the model\'s window when smaller, and knows the real window', () => {
  const base = { baseUrl: 'http://127.0.0.1:4000', localToken: 'local', model: GLM };
  const glm = claudeChildEnv({ PATH: '/bin', AGENT_MODEL_CONTEXT_WINDOW: '1310720' }, base);
  assert.equal(glm.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '120000', 'a 1.3M GLM window is compacted at 120k, never at 1.2M');
  assert.equal(glm.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1310720');
  const small = claudeChildEnv({ AGENT_MODEL_CONTEXT_WINDOW: '100000' }, base);
  assert.equal(small.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000');
  const unknown = claudeChildEnv({ AGENT_MODEL_CONTEXT_WINDOW: '' }, base);
  assert.equal(unknown.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '120000', 'no catalog window: still compacted');
  assert.equal(unknown.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, 'and no window is made up');
  const chosen = claudeChildEnv({ AGENT_MODEL_CONTEXT_WINDOW: '1310720', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' }, base);
  assert.equal(chosen.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', 'a window already set is kept');
  const codex = fs.readFileSync(require.resolve('../worker/build-codex-model-catalog.js'), 'utf8');
  assert.match(codex, /const AUTO_COMPACT_TOKEN_LIMIT = 200_000;/, 'the same limit as Codex');
  assert.equal(require('../worker/claude-openrouter-request').AUTO_COMPACT_TOKEN_LIMIT, 200_000);
});

test('the compaction limit is per model family: Anthropic\'s at 200k, every other provider\'s at 120k', () => {
  const mod = require('../worker/claude-openrouter-request');
  assert.equal(mod.NON_ANTHROPIC_AUTO_COMPACT_TOKEN_LIMIT, 120_000);
  for (const model of ['anthropic/claude-sonnet-4.5', '~anthropic/claude-opus-latest']) {
    assert.equal(mod.autoCompactLimit(model), 200_000, model);
  }
  for (const model of [GLM, 'z-ai/glm-4.6', 'moonshotai/kimi-k2', 'openai/gpt-5', '', undefined]) {
    assert.equal(mod.autoCompactLimit(model), 120_000, String(model));
  }
  const base = { baseUrl: 'http://127.0.0.1:4000', localToken: 'local' };
  const claude = claudeChildEnv({ AGENT_MODEL_CONTEXT_WINDOW: '1000000' }, { ...base, model: 'anthropic/claude-sonnet-4.5' });
  assert.equal(claude.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000', 'Anthropic models unchanged');
  const glm = claudeChildEnv({ AGENT_MODEL_CONTEXT_WINDOW: '1310720' }, { ...base, model: GLM });
  assert.equal(glm.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '120000');
});

test('redaction is literal and ignores values too short to be secrets', () => {
  const redact = makeRedactor([KEY, 'a+b(c)*grant-value', 'short', null, undefined]);
  assert.equal(redact(`key=${KEY} and ${KEY}`), 'key=**** and ****');
  assert.equal(redact('token a+b(c)*grant-value end'), 'token **** end');
  assert.equal(redact('a short line'), 'a short line');
});

async function fakeOpenRouter(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const record = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    seen.push(record);
    handler(record, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"z-ai/glm-5.3-flash","usage":{"input_tokens":12,"output_tokens":1}}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

test('the adapter forwards Messages requests to OpenRouter with the key and streams the reply back', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => {
    if (record.url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":42}');
    } else sse(res);
  });
  const timing = [];
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, maxOutputTokens: 64_000,
    localToken: 'local-token', onTiming: (event) => timing.push(event),
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });

  const send = (pathname, { token = 'local-token', header = 'x-api-key', body } = {}) => fetch(`${adapter.baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-stainless-os': 'Linux',
      ...(header === 'x-api-key' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body || {
      model: 'claude-haiku-4-5', max_tokens: 200_000, stream: true,
      system: 'rules', messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  const reply = await send('/v1/messages?beta=true');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-request-id'), 'req-1');
  assert.match(await reply.text(), /message_stop/);
  const forwarded = upstream.seen[0];
  assert.equal(forwarded.url, '/api/v1/messages', 'the query string stays local');
  assert.equal(forwarded.headers.authorization, `Bearer ${KEY}`);
  assert.equal(forwarded.headers['x-api-key'], undefined, 'the local token never leaves the worker');
  assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
  assert.equal(forwarded.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(forwarded.headers['x-stainless-os'], undefined);
  assert.equal(forwarded.body.model, GLM);
  assert.equal(forwarded.body.max_tokens, 64_000);
  assert.deepEqual(forwarded.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(timing.map((event) => event.kind), [
    'provider_request_start', 'provider_response_headers', 'provider_response_first_byte',
    'provider_request_result', 'provider_request_end',
  ]);
  assert.equal(timing[0].inputItems, 1);
  assert.equal(timing[0].maxOutputTokens, 64_000);
  assert.deepEqual(timing[3], {
    kind: 'provider_request_result', requestOrdinal: 1, httpStatus: 200, outcome: 'ok', requestId: 'req-1',
    usage: { inputTokens: 12, outputTokens: 1 }, images: { sent: 0, moved: 0, omitted: 0 },
  });
  assert.equal(timing[4].outcome, 'ok');
  assert.ok(!JSON.stringify(timing).includes('hi'), 'timing carries sizes and counts, never content');

  // Bearer auth is accepted too; count_tokens is forwarded without a cap.
  const count = await send('/v1/messages/count_tokens', {
    header: 'authorization', body: { model: 'claude-sonnet-5', messages: [] },
  });
  assert.equal(count.status, 200);
  assert.deepEqual(await count.json(), { input_tokens: 42 });
  assert.equal(upstream.seen[1].url, '/api/v1/messages/count_tokens');
  assert.deepEqual(upstream.seen[1].body, { model: GLM, messages: [] });
  assert.equal(timing.length, 5, 'count_tokens is not a model request');

  // Wrong token, wrong route, wrong method: refused locally.
  const denied = await send('/v1/messages', { token: 'guess' });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.type, 'authentication_error');
  const missing = await send('/v1/complete');
  assert.equal(missing.status, 404);
  const get = await fetch(`${adapter.baseUrl}/v1/messages`, { headers: { 'x-api-key': 'local-token' } });
  assert.equal(get.status, 404);
  const bad = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': 'local-token' }, body: '[1,2]',
  });
  assert.equal(bad.status, 400);
  assert.equal(upstream.seen.length, 2, 'nothing refused locally reached OpenRouter');
});

test("each request's start and end say when, in ms since the listener started", async (t) => {
  // The platform reads a turn's journal again after a restart, so only the
  // turn's own clock says when a request ran (2026-10-07, worker.js
  // noteCodingRequestClock): atMs climbs, and the gap between one request's
  // end and the next one's start is the time the agent spent in its tools.
  const upstream = await fakeOpenRouter((record, res) => sse(res));
  const timing = [];
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, localToken: 'local-token',
    onTiming: (event) => timing.push(event),
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });
  const send = () => fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  }).then((reply) => reply.text());
  await send();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await send();
  const starts = timing.filter((e) => e.kind === 'provider_request_start');
  const ends = timing.filter((e) => e.kind === 'provider_request_end');
  assert.deepEqual(starts.map((e) => e.requestOrdinal), [1, 2]);
  assert.deepEqual(ends.map((e) => e.requestOrdinal), [1, 2]);
  for (const event of [...starts, ...ends]) {
    assert.ok(Number.isSafeInteger(event.atMs) && event.atMs >= 0, `${event.kind} carries atMs`);
  }
  for (let i = 0; i < 2; i++) {
    assert.ok(ends[i].atMs >= starts[i].atMs);
    assert.ok(Math.abs(ends[i].atMs - ends[i].durationMs - starts[i].atMs) <= 2,
      'an end is its start plus its duration, on the same clock');
  }
  assert.ok(starts[1].atMs >= ends[0].atMs + 10, 'the wait between requests shows between them');
  for (const event of timing.filter((e) => !['provider_request_start', 'provider_request_end'].includes(e.kind))) {
    assert.equal('atMs' in event, false, `${event.kind} is unchanged`);
  }
});

// ── What each request came to (G, 2026-10-05) ───────────────────────────

async function outcomeOf(t, handler) {
  const upstream = await fakeOpenRouter((record, res) => handler(res));
  const timing = [];
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, localToken: 'local-token',
    onTiming: (event) => timing.push(event),
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });
  const reply = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'secret prompt' }] }),
  });
  const text = await reply.text();
  return { reply, text, result: timing.find((e) => e.kind === 'provider_request_result'), timing };
}

test('a streamed reply names its generation and the provider OpenRouter routed it to', async (t) => {
  const { reply, text, result, timing } = await outcomeOf(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-9' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"gen-1759626000-abc","provider":"DeepInfra","model":"z-ai/glm-5.3-flash","usage":{"input_tokens":12}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"an error in the reply text"}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  assert.equal(reply.status, 200);
  assert.match(text, /an error in the reply text/, 'the reply reaches Claude Code unchanged');
  assert.deepEqual(result, {
    kind: 'provider_request_result', requestOrdinal: 1, httpStatus: 200, outcome: 'ok',
    requestId: 'req-9', generationId: 'gen-1759626000-abc', providerName: 'DeepInfra',
    usage: { inputTokens: 12 }, images: { sent: 0, moved: 0, omitted: 0 },
  });
  assert.ok(!JSON.stringify(timing).includes('secret prompt') && !JSON.stringify(timing).includes('reply text'),
    'never content');
});

test('a reply\'s token counts are its closing ones: OpenRouter fills them in only on message_delta', async (t) => {
  // As GLM's replies came through OpenRouter on 2026-10-06: message_start
  // says 0 input tokens, and the counts arrive with the closing message_delta.
  // A stopped turn is priced from these (worker.js), so they must be the
  // closing ones, cache reads and writes kept apart as Anthropic splits them.
  const { result, timing } = await outcomeOf(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"gen-3","provider":"Fireworks","model":"m","usage":{"input_tokens":0,"output_tokens":1}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1834,"output_tokens":712,"cache_read_input_tokens":96512,"cache_creation_input_tokens":0}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  assert.deepEqual(result.usage, { inputTokens: 1834, outputTokens: 712, cacheReadInputTokens: 96512, cacheWriteInputTokens: 0 });
  assert.equal(result.providerName, 'Fireworks');
  assert.ok(!JSON.stringify(timing).includes('done'), 'counts, never content');
});

test('a whole JSON reply reports its counts; a reply that reports none carries none', async (t) => {
  const json = await outcomeOf(t, (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen-4', type: 'message', usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 'x' } }));
  });
  assert.deepEqual(json.result.usage, { inputTokens: 20, outputTokens: 5 });
  const silent = await outcomeOf(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"gen-5","model":"m"}}\n\n');
  });
  assert.equal(silent.result.usage, undefined);
});

test('a refusal says its status, type, provider and a redacted message', async (t) => {
  // The 2026-10-04 refusal, as OpenRouter's envelope carries it; one that
  // echoed the key would never print it.
  const { reply, result } = await outcomeOf(t, (res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req-400' });
    res.end(JSON.stringify({ error: {
      code: 400,
      message: `messages[6]: tool messages must include a non-empty string tool_call_id (key ${KEY})`,
      metadata: { provider_name: 'Z.AI', raw: 'upstream detail' },
    } }));
  });
  assert.equal(reply.status, 400, 'still Claude Code\'s to read');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.outcome, 'http_error');
  assert.equal(result.requestId, 'req-400');
  assert.equal(result.providerName, 'Z.AI');
  assert.equal(result.errorType, '400');
  assert.match(result.errorMessage, /^messages\[6\]: tool messages must include a non-empty string tool_call_id/);
  assert.ok(!result.errorMessage.includes(KEY), 'the key is redacted');
  assert.match(result.errorMessage, /\*\*\*\*/);
});

test('an error event inside a stream is reported too', async (t) => {
  const { result } = await outcomeOf(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"gen-2","model":"m"}}\n\n');
    res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
  });
  assert.equal(result.generationId, 'gen-2');
  assert.equal(result.errorType, 'overloaded_error');
  assert.equal(result.errorMessage, 'Overloaded');
});

test('an OpenRouter refusal reaches Claude Code unchanged', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('{"error":{"code":402,"message":"Insufficient credits"}}');
  });
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, localToken: 'local-token',
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });
  const reply = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [] }),
  });
  assert.equal(reply.status, 402);
  assert.match(await reply.text(), /Insufficient credits/);
});

test('the adapter refuses a config it cannot enforce', async () => {
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: GLM, localToken: 't' }),
    /invalid_request_adapter_config/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, model: '', localToken: 't' }),
    /invalid_request_adapter_config/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'ftp://openrouter.ai/api/v1', apiKey: KEY, model: GLM, localToken: 't' }),
    /invalid_provider_url/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://u:p@openrouter.ai/api/v1', apiKey: KEY, model: GLM, localToken: 't' }),
    /invalid_provider_url/);
});

// ── run-cc.sh, end to end ─────────────────────────────────────────────

function runnerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openrouter-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const runtimeLog = path.join(dir, 'claude-runtime.json');
  const gitLog = path.join(dir, 'git-env.log');
  const keyFile = path.join(dir, 'leaked-key.txt');
  fs.writeFileSync(keyFile, KEY);
  // A stand-in for the claude CLI: records what it was given, makes one
  // Messages call through ANTHROPIC_BASE_URL as the real CLI would, then
  // prints a key it "found" to prove the journal is scrubbed.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
(async () => {
  const reply = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 999999, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  const text = await reply.text();
  fs.writeFileSync(${JSON.stringify(runtimeLog)}, JSON.stringify({
    args: process.argv.slice(2), prompt, status: reply.status, streamed: text.includes('message_stop'),
    baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY || null,
    haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'found ' + fs.readFileSync(${JSON.stringify(keyFile)}, 'utf8') }] } }));
  console.log(JSON.stringify({ type: 'result', result: 'done', session_id: 'cc-or-1', usage: { input_tokens: 5, output_tokens: 7 } }));
  process.exitCode = 0;
})();
`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "git \${OPENROUTER_API_KEY:-unset}" >> ${JSON.stringify(gitLog)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'find the bug');
  return { dir, bin, ws, prompt, runtimeLog, gitLog };
}

function runRunner(env) {
  return new Promise((resolve) => {
    const child = spawn('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('run-cc.sh runs an OpenRouter scout through the adapter with the key out of every other process', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => sse(res));
  t.after(() => upstream.close());
  const fx = runnerFixture();
  const env = {
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: fx.dir,
    ...RUNNER_TEST_ENV, PROMPT_FILE: fx.prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    MODE: 'scout', WORKSPACE_DIR: fx.ws,
    AGENT_PROVIDER: 'openrouter', MODEL: GLM, AGENT_MODEL: GLM,
    AGENT_MODEL_MAX_OUTPUT_TOKENS: '64000', AGENT_REASONING_EFFORT: 'xhigh',
    OPENROUTER_API_KEY: KEY, OPENROUTER_API_BASE: upstream.base,
    BROWSER_MCP_CONFIG: path.join(fx.dir, 'absent.json'),
  };
  const { code, out } = await runRunner(env);
  assert.equal(code, 0, out);

  const runtime = JSON.parse(fs.readFileSync(fx.runtimeLog, 'utf8'));
  assert.equal(runtime.prompt, 'find the bug', 'the prompt still arrives on stdin');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.streamed, true);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(runtime.apiKey, KEY);
  assert.equal(runtime.openrouterKey, null, 'Claude Code and its Bash never see the key');
  assert.equal(runtime.haiku, GLM);
  const at = runtime.args.indexOf('--model');
  assert.equal(runtime.args[at + 1], GLM);
  // A scout keeps the Anthropic scout's tool set; WebSearch stays, routed to
  // OpenRouter's own search by the adapter.
  const disallowed = runtime.args.indexOf('--disallowed-tools');
  assert.deepEqual(runtime.args.slice(disallowed, disallowed + 4),
    ['--disallowed-tools', 'Edit', 'Write', 'NotebookEdit']);
  assert.ok(!runtime.args.includes('WebSearch'));

  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(upstream.seen[0].body.model, GLM);
  assert.equal(upstream.seen[0].body.max_tokens, 64_000);
  assert.deepEqual(upstream.seen[0].body.output_config, { effort: 'xhigh' }, 'the thinking level reaches OpenRouter');

  assert.ok(!out.includes(KEY), 'the journal never carries the key');
  assert.match(out, /found \*\*\*\*/);
  assert.match(out, /__USERNODE_CODING_PROVIDER__ \{"kind":"provider_request_start"/);
  assert.match(out, /__USERNODE_RESULT__ cc_exit=0 .*mode=scout/);
  assert.ok(fs.readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).every((line) => line === 'git unset'),
    'git runs without the key in its environment');
});

test('run-cc.sh refuses OpenRouter modes and configs it cannot run safely', async () => {
  const fx = runnerFixture();
  const base = {
    PATH: `${fx.bin}:${process.env.PATH}`, HOME: fx.dir,
    ...RUNNER_TEST_ENV, PROMPT_FILE: fx.prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    WORKSPACE_DIR: fx.ws, WORKER_JWT: 'push', AGENT_PROVIDER: 'openrouter',
    MODEL: GLM, AGENT_MODEL: GLM, OPENROUTER_API_KEY: KEY,
  };
  const sync = await runRunner({ ...base, MODE: 'sync' });
  assert.notEqual(sync.code, 0);
  assert.match(sync.out, /__USERNODE_ERROR__ Claude over OpenRouter supports build and scout turns, not sync/);
  const noKey = await runRunner({ ...base, MODE: 'scout', OPENROUTER_API_KEY: '' });
  assert.match(noKey.out, /__USERNODE_ERROR__ OPENROUTER_API_KEY required/);
  const noModel = await runRunner({ ...base, MODE: 'scout', AGENT_MODEL: '' });
  assert.match(noModel.out, /__USERNODE_ERROR__ AGENT_MODEL required/);
  const unknown = await runRunner({ ...base, MODE: 'scout', AGENT_PROVIDER: 'bedrock' });
  assert.match(unknown.out, /__USERNODE_ERROR__ unknown AGENT_PROVIDER: bedrock/);
  assert.ok(!fs.existsSync(fx.runtimeLog), 'claude never started');
  // An Anthropic build still requires the separate system context; an
  // OpenRouter build carries it inline like a Codex build does.
  const anthropicBuild = await runRunner({ ...base, MODE: 'build', AGENT_PROVIDER: 'anthropic' });
  assert.match(anthropicBuild.out, /__USERNODE_ERROR__ SYSTEM_PROMPT_FILE required for build mode/);
});

test('the worker image ships the adapter beside the runner', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY claude-openrouter-request\.js \/usr\/local\/bin\/claude-openrouter-request\.js/);
  const runner = fs.readFileSync(path.join(ROOT, 'worker', 'run-cc.sh'), 'utf8');
  assert.match(runner, /node "\$\(dirname "\$0"\)\/claude-openrouter-request\.js" "\$@"/);
  // Still no platform relay, for either harness.
  assert.ok(!/internal\/openrouter/.test(runner));
  const adapter = fs.readFileSync(path.join(ROOT, 'worker', 'claude-openrouter-request.js'), 'utf8');
  assert.ok(!/internal\/openrouter|PLATFORM_URL/.test(adapter));
});

test('#3426: a model OpenRouter lists as taking images gets them; documents stay text', () => {
  const body = applyTurnPolicy({
    model: 'x', max_tokens: 10,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        ] },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCCC' } },
      ] },
    ],
  }, { model: GLM, maxOutputTokens: 10, imageInput: true });
  assert.deepEqual(body.messages[0].content[1].source.data, 'AAAA', 'the screenshot reaches the model');
  // And one a tool read, moved out of its tool result for a model that is
  // not Anthropic's (below).
  assert.deepEqual(body.messages[1].content[2].source.data, 'BBBB', 'and one a tool read');
  assert.deepEqual(body.messages[1].content[3], { type: 'text', text: '[document omitted: this model reads text only]' });
  // Only exactly true opens it.
  for (const imageInput of [undefined, false, '1', 1]) {
    const plain = applyTurnPolicy({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
      { model: GLM, maxOutputTokens: 10, imageInput });
    assert.equal(plain.messages[0].content[0].type, 'text', String(imageInput));
  }
  // The runner reads the worker's env: '1' only.
  const src = require('node:fs').readFileSync(require.resolve('../worker/claude-openrouter-request.js'), 'utf8');
  assert.match(src, /imageInput: env\.AGENT_MODEL_SUPPORTS_IMAGES === '1',/);
  assert.match(src, /model, maxOutputTokens, countTokens, reasoningEffort, imageInput, documentInput,/);
});

test('#3557: a model OpenRouter lists as taking files gets PDFs; any other gets a note', () => {
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCCC' } };
  const request = () => ({
    model: 'x', max_tokens: 10,
    messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [pdf] },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
    ],
  });
  const reads = applyTurnPolicy(request(), { model: GLM, maxOutputTokens: 10, documentInput: true });
  assert.deepEqual(reads.messages[0].content[0].content[0], pdf, 'a PDF the Read tool returned reaches the model');
  assert.equal(reads.messages[0].content[1].type, 'text', 'file input does not open images');
  for (const documentInput of [undefined, false, '1', 1]) {
    const plain = applyTurnPolicy(request(), { model: GLM, maxOutputTokens: 10, documentInput });
    assert.deepEqual(plain.messages[0].content[0].content[0],
      { type: 'text', text: '[document omitted: this model reads text only]' }, String(documentInput));
  }
  const src = require('node:fs').readFileSync(require.resolve('../worker/claude-openrouter-request.js'), 'utf8');
  assert.match(src, /documentInput: env\.AGENT_MODEL_SUPPORTS_FILES === '1',/);
});

// ── Images inside tool results, for a model that is not Anthropic's ──────
//
// Claude Code's Read and the browser's screenshot tool return their image
// inside a tool_result. A GLM 5.3 Flash build (App bench studio run 8, trial
// 1236) said its screenshot "returns empty": for another provider the tool
// message is text, so the image is moved after the tool results, where it is
// an ordinary image part, and a pointer is left in its place.

const png = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

function toolTurn() {
  return [
    { role: 'user', content: 'build it' },
    { role: 'assistant', content: [
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/app/light-phone.png' } },
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_shot', name: 'mcp__playwright__browser_take_screenshot', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_read', content: [png('READ')] },
      { type: 'tool_result', tool_use_id: 'toolu_bash', content: [{ type: 'text', text: 'a.js\nb.js' }], is_error: false },
      { type: 'tool_result', tool_use_id: 'toolu_shot', content: [
        { type: 'text', text: 'Took the screenshot' }, png('SHOT1'), png('SHOT2'),
      ], cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<system-reminder>keep going</system-reminder>' },
    ] },
  ];
}

const pointer = (n) => ({ type: 'text', text: `[image ${n} of this result follows after the tool results]` });

test('a non-Anthropic model gets each tool-result image after the tool results, labelled and in order, with a pointer left behind', () => {
  const original = toolTurn();
  const counts = { sent: 0, moved: 0, omitted: 0 };
  const body = applyTurnPolicy({ model: 'x', max_tokens: 10, messages: toolTurn() },
    { model: GLM, maxOutputTokens: 10, imageInput: true, imageCounts: counts });
  const [readResult, bashResult, shotResult, ...rest] = body.messages[2].content;
  // Tool results stay first, in their order, ids and flags untouched.
  assert.deepEqual(readResult, { type: 'tool_result', tool_use_id: 'toolu_read', content: [pointer(1)] });
  assert.equal(JSON.stringify(bashResult), JSON.stringify(original[2].content[1]), 'a result with no image is byte-identical');
  assert.deepEqual(shotResult, {
    type: 'tool_result', tool_use_id: 'toolu_shot',
    content: [{ type: 'text', text: 'Took the screenshot' }, pointer(1), pointer(2)],
    cache_control: { type: 'ephemeral' },
  });
  // Then each image, after a line naming the result it came from, before
  // whatever already followed the tool results.
  assert.deepEqual(rest, [
    { type: 'text', text: '[image 1 of the Read result (toolu_read):]' }, png('READ'),
    { type: 'text', text: '[image 1 of the mcp__playwright__browser_take_screenshot result (toolu_shot):]' }, png('SHOT1'),
    { type: 'text', text: '[image 2 of the mcp__playwright__browser_take_screenshot result (toolu_shot):]' }, png('SHOT2'),
    { type: 'text', text: '<system-reminder>keep going</system-reminder>' },
  ]);
  // Every other message is byte-for-byte what Claude Code sent.
  assert.equal(JSON.stringify(body.messages.slice(0, 2)), JSON.stringify(original.slice(0, 2)));
  assert.deepEqual(counts, { sent: 3, moved: 3, omitted: 0 });

  // A request whose tool results carry no image goes out exactly as sent,
  // and the same history rewrites the same way every time (prompt caching).
  const plain = [original[0], { role: 'user', content: [original[2].content[1], { type: 'text', text: 'hi' }, png('TOP')] }];
  const untouched = applyTurnPolicy({ messages: structuredClone(plain) }, { model: GLM, maxOutputTokens: 10, imageInput: true });
  assert.equal(JSON.stringify(untouched.messages), JSON.stringify(plain), 'an image already outside a tool result stays put');
  const again = applyTurnPolicy({ model: 'x', max_tokens: 10, messages: toolTurn() }, { model: GLM, maxOutputTokens: 10, imageInput: true });
  assert.equal(JSON.stringify(again.messages), JSON.stringify(body.messages));
  // An id the assistant turn does not name still gets a label.
  const orphan = applyTurnPolicy({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [png('X')] }] }] },
    { model: GLM, maxOutputTokens: 10, imageInput: true });
  assert.deepEqual(orphan.messages[0].content[1], { type: 'text', text: '[image 1 of the tool result (toolu_x):]' });
});

test('an Anthropic model keeps its tool-result images where they are; a text-only model still gets the note', () => {
  for (const model of ['anthropic/claude-sonnet-5', '~anthropic/claude-opus-latest']) {
    const counts = { sent: 0, moved: 0, omitted: 0 };
    const body = applyTurnPolicy({ model: 'x', max_tokens: 10, messages: toolTurn() },
      { model, maxOutputTokens: 10, imageInput: true, imageCounts: counts });
    assert.equal(JSON.stringify(body.messages), JSON.stringify(toolTurn()), model);
    assert.deepEqual(counts, { sent: 3, moved: 0, omitted: 0 }, model);
  }
  const counts = { sent: 0, moved: 0, omitted: 0 };
  const text = applyTurnPolicy({ model: 'x', max_tokens: 10, messages: toolTurn() },
    { model: GLM, maxOutputTokens: 10, imageInput: false, imageCounts: counts });
  const note = { type: 'text', text: '[image omitted: this model reads text only]' };
  assert.deepEqual(text.messages[2].content[0].content, [note]);
  assert.deepEqual(text.messages[2].content[2].content, [{ type: 'text', text: 'Took the screenshot' }, note, note]);
  assert.equal(text.messages[2].content.length, 4, 'nothing is moved');
  assert.deepEqual(counts, { sent: 0, moved: 0, omitted: 3 });
});

test("each request's result line says how many images it sent, moved and left out", async (t) => {
  const run = async (opts) => {
    const upstream = await fakeOpenRouter((record, res) => sse(res));
    const timing = [];
    const adapter = await startMessagesAdapter({
      baseUrl: upstream.base, apiKey: KEY, model: GLM, localToken: 'local-token',
      onTiming: (event) => timing.push(event), ...opts,
    });
    t.after(async () => { await adapter.close(); await upstream.close(); });
    const reply = await fetch(`${adapter.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 10, stream: true, messages: toolTurn() }),
    });
    await reply.text();
    return { forwarded: upstream.seen[0].body, result: timing.find((e) => e.kind === 'provider_request_result') };
  };
  const sees = await run({ imageInput: true });
  assert.deepEqual(sees.result.images, { sent: 3, moved: 3, omitted: 0 });
  assert.deepEqual(sees.forwarded.messages[2].content[4], png('READ'), 'what OpenRouter receives');
  const blind = await run({});
  assert.deepEqual(blind.result.images, { sent: 0, moved: 0, omitted: 3 });
  assert.ok(!JSON.stringify(sees.result).includes('READ'), 'counts, never content');
});
