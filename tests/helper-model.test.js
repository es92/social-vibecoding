'use strict';

// The helper calls' model (src/services/llm.js helperMessage): GLM 5.3 Flash
// through OpenRouter first, on the Homeroom bot's key, with a time limit per
// helper, and Haiku 5.5 when GLM is late, fails or gives nothing usable.
// Pins the request GLM is sent, the fallback, the cases that never reach GLM
// (a BYOK key, HELPER_MODEL=haiku, no bot key, a picked model), a caller's
// cancel, the cost the answer is billed at, the telemetry pair, and that
// every helper the switch names goes through the path. And the model it is
// as an admin setting (services/helper-model.js): read through a short
// cache, blank or unreadable for GLM, thinking off on any other model,
// checked against the catalog when saved, and followed by small-change.js.
//
// Run with: node --test tests/helper-model.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm');
const llmTelemetry = require('../src/services/llm-telemetry');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function fakeOpenRouter(reply) {
  const calls = [];
  return {
    calls,
    async streamChat(input) {
      calls.push(input);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply(input);
      return {
        servedModel: 'z-ai/glm-5.3-flash',
        finishReason: 'tool_calls',
        toolCalls: reply === null ? [] : [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify(reply) } }],
        usage: { inputTokens: 400, outputTokens: 90, reasoningTokens: 60, costUsd: 0.00012 },
      };
    },
  };
}

function stubClient(text = '{"title":"From Haiku"}') {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { content: [{ type: 'text', text }], usage: { input_tokens: 300, output_tokens: 20 }, stop_reason: 'end_turn' };
      },
    },
  };
}

async function withHelpers({ reply, key = 'sk-or-bot', haikuText, model } = {}, fn) {
  const openrouter = fakeOpenRouter(reply);
  const client = stubClient(haikuText);
  const events = [];
  const prevDeps = llm._setHelperDepsForTests({ openrouter, key, model, config: { openrouterApiBase: 'https://or.test/api/v1' } });
  const prevClient = llm._setClientForTests(client);
  const prevEnabled = llmTelemetry._setEnabledForTests(true);
  const prevSink = llmTelemetry._setSinkForTests((e) => { events.push(e); });
  try {
    return await fn({ openrouter, client, events });
  } finally {
    llm._setHelperDepsForTests(prevDeps);
    llm._setClientForTests(prevClient);
    llmTelemetry._setEnabledForTests(prevEnabled);
    llmTelemetry._setSinkForTests(prevSink);
  }
}

test('GLM answers: the forced tool carries the helper schema, and Haiku is never asked', async () => {
  await withHelpers({ reply: { title: 'Plant watering reminders' } }, async ({ openrouter, client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['Remind us to water the plants'] });
    assert.equal(out.title, 'Plant watering reminders');
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.equal(out.usage.cost_usd, 0.00012, 'OpenRouter\'s own figure rides along');
    assert.equal(client.calls.length, 0);

    const sent = openrouter.calls[0];
    assert.equal(sent.model, llm.HELPER_MODEL);
    assert.equal(sent.apiKey, 'sk-or-bot');
    assert.equal(sent.baseUrl, 'https://or.test/api/v1');
    assert.equal(sent.reasoning, 'low');
    assert.equal(sent.timeoutMs, llm.HELPER_TIME_LIMIT_MS.session_title);
    assert.deepEqual(sent.toolChoice, { type: 'function', function: { name: 'answer' } });
    // #3772: not even `false`, which would route GLM 5.3 Flash to the one
    // provider that takes parallel_tool_calls.
    assert.equal(sent.parallelToolCalls, null);
    assert.equal('parallel_tool_calls' in require('../src/services/openrouter').buildRequest(sent), false);
    assert.deepEqual(sent.tools[0].function.parameters, llm.SESSION_TITLE_SCHEMA);
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].role, 'user');
    assert.equal(sent.maxOutputTokens, 64 + 1500, 'the Haiku ceiling plus room to think');

    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'openrouter');
    assert.equal(events[0].component, 'session_title');
    assert.equal(events[0].requested_model, 'z-ai/glm-5.3-flash');
    assert.equal(events[0].outcome, 'success');
    assert.equal(events[0].cost_source, 'provider_reported');
    assert.equal(events[0].attempt_number, 1);
  });
});

test('GLM late or failing: Haiku answers as attempt 2 of the same call', async () => {
  const late = Object.assign(new Error('timed out'), { code: 'timeout' });
  await withHelpers({ reply: late }, async ({ client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['Remind us to water the plants'] });
    assert.equal(out.title, 'From Haiku');
    assert.equal(out.model, 'claude-haiku-5-5');
    assert.equal(client.calls[0].model, 'claude-haiku-5-5');
    assert.equal(client.calls[0].max_tokens, 64, 'Haiku is asked for the same ceiling as before');
    assert.deepEqual(client.calls[0].thinking, { type: 'disabled' },
      'Haiku 5.5 thinks by default; off, so the 64 tokens are all answer');
    assert.equal(events.length, 2);
    const [glm, haiku] = events;
    assert.equal(glm.outcome, 'error');
    assert.equal(glm.error_class, 'timeout');
    assert.equal(haiku.provider, 'anthropic');
    assert.equal(haiku.attempt_number, 2);
    assert.equal(haiku.correlation_id, glm.correlation_id, 'one logical run');
  });
  // An answer with no usable tool call is not an answer.
  await withHelpers({ reply: null }, async ({ client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(out.model, 'claude-haiku-5-5');
    assert.equal(client.calls.length, 1);
    assert.equal(events[0].outcome, 'error');
  });
});

test('never GLM: a BYOK key, HELPER_MODEL=haiku, no bot key, a named Claude model', async () => {
  const params = { max_tokens: 64, messages: [{ role: 'user', content: 'x' }] };
  const defaults = { backend: 'helper', component: 'session_title' };
  await withHelpers({ reply: { title: 'GLM' } }, async ({ openrouter, client }) => {
    const byok = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, apiKey: 'sk-ant-own', defaults,
    });
    assert.equal(byok.model, 'claude-haiku-5-5');
    const named = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, defaults, model: 'claude-sonnet-5-5',
    });
    assert.deepEqual(client.calls[0].thinking, { type: 'disabled' }, 'BYOK Haiku is asked with thinking off too');
    assert.equal(named.model, 'claude-sonnet-5-5');
    assert.equal(client.calls[1].model, 'claude-sonnet-5-5');
    assert.equal(client.calls[1].thinking, undefined, 'a named model is sent as written');
    assert.equal(openrouter.calls.length, 0);

    const prev = process.env.HELPER_MODEL;
    process.env.HELPER_MODEL = 'haiku';
    try {
      assert.equal(llm.helperRoute(), 'haiku');
      const off = await llm.generateSessionTitle({ requests: ['x'] });
      assert.equal(off.model, 'claude-haiku-5-5');
      assert.equal(openrouter.calls.length, 0);
    } finally {
      if (prev === undefined) delete process.env.HELPER_MODEL; else process.env.HELPER_MODEL = prev;
    }
    assert.equal(llm.helperRoute(), 'glm', 'glm unless the switch says haiku');
  });
  await withHelpers({ reply: { title: 'GLM' }, key: null }, async ({ openrouter, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(out.model, 'claude-haiku-5-5');
    assert.equal(openrouter.calls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].attempt_number, 1, 'nothing was sent to GLM, so Haiku is the first attempt');
  });
});

test('a call the caller cancelled is not asked again of Haiku', async () => {
  const ctrl = new AbortController();
  const cancelled = (input) => { ctrl.abort(); throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); };
  await withHelpers({ reply: cancelled }, async ({ client }) => {
    await assert.rejects(
      () => llm.generateQuickReplies({ rules: '', context: 'c', signal: ctrl.signal }),
      (err) => err.name === 'AbortError',
    );
    assert.equal(client.calls.length, 0);
  });
});

test('structured helpers read GLM\'s answer with their existing parse', async () => {
  await withHelpers({ reply: { actionable: true, title: 'Fix the broken leaderboard sort' } }, async ({ openrouter }) => {
    const out = await llm.generateIssueTitle({ description: 'The leaderboard sorts wrong.' });
    assert.equal(out.title, 'Fix the broken leaderboard sort');
    assert.equal(out.actionable, true);
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.issue_title);
    assert.deepEqual(openrouter.calls[0].tools[0].function.parameters, llm.ISSUE_TITLE_SCHEMA);
    assert.equal(openrouter.calls[0].messages[0].role, 'user', 'no system message when the helper has none');
  });
  await withHelpers({ reply: { kind: 'change', title: 'Add a Sunday watering reminder' } }, async () => {
    const out = await llm.readChatAsk({ text: 'Can it remind us on Sundays?' });
    assert.equal(out.kind, 'change');
    assert.equal(out.title, 'Add a Sunday watering reminder');
  });
  await withHelpers({ reply: { estimate: 'maybe halfway', remaining_seconds: 240 } }, async () => {
    const out = await llm.estimateRunProgress({ userRequest: 'x', progressTail: ['Reading a.js'], elapsedMs: 60000 });
    assert.equal(out.remainingSeconds, 240);
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
  });
  await withHelpers({ reply: { verdict: 'pass', category: '', file: '', reason: 'Nothing against the rules.' } }, async ({ openrouter }) => {
    const out = await llm.reviewContentRules({ system: 's', diff: 'd', telemetryContext: { component: 'content_review' } });
    assert.equal(out.verdict, 'pass');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.content_review);
  });
  await withHelpers({ reply: { score: 180, reason: 'Clear steps.' } }, async ({ openrouter, events }) => {
    const out = await llm.gradeChallengeUnit({
      system: 'rubric', user: 'report', schema: { type: 'object', properties: { score: { type: 'integer' }, reason: { type: 'string' } }, required: ['score', 'reason'] },
      telemetryContext: { component: 'challenge_grade_feedback' },
    });
    assert.equal(out.score, 180);
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.challenge_grade);
    assert.equal(events[0].component, 'challenge_grade_feedback', 'the grader\'s own component is kept');
  });
  // The sketch is asked through the card schema app-sketch.js owns; with
  // none, it goes to Haiku as before.
  await withHelpers({ reply: { emoji: '🪴', tagline: 'Keep the plants alive', points: ['See who watered last'] } }, async ({ openrouter, client }) => {
    const sketch = require('../src/services/app-sketch');
    const out = await llm.generateAppSketch({ system: 's', user: 'u', schema: sketch.CARD_SCHEMA, maxTokens: 400 });
    assert.equal(JSON.parse(out.text).tagline, 'Keep the plants alive');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.app_sketch);
    await llm.generateAppSketch({ system: 's', user: 'u', maxTokens: 400 });
    assert.equal(openrouter.calls.length, 1);
    assert.equal(client.calls[0].model, 'claude-haiku-5-5');
  });
});

// Newcomer run five (13 Oct 2026): GLM answered the plan at Make it with a
// tool call (325 tokens, outcome success), the plan's parse refused it, and
// Haiku was never asked, because any JSON object counted as an answer.
const fvPlan = require('../src/services/first-version-plan');
const PLAN = Object.freeze({
  plan: ['Make a poll in a few taps', 'Everyone votes once', 'See who won'],
  choices: [{ question: 'Who can make a poll?', answers: ['Anyone in the club', 'Only you'] }],
  build_note: 'One screen: the open polls, newest first. Its primary action is New poll.',
  assumptions: ['Votes are anonymous'],
});
const askPlan = () => llm.generateFirstVersionPlan({
  system: 's', user: 'u', schema: fvPlan.PLAN_SCHEMA, validate: fvPlan.usableAnswer, maxTokens: 2000,
});

test('the plan at Make it: each answer its parse refuses is asked again of Haiku, with the plan\'s schema as structured output', async () => {
  const refused = {
    'no plan': { ...PLAN, plan: undefined },
    'an empty plan': { ...PLAN, plan: [] },
    'blank plan lines': { ...PLAN, plan: ['', '  ', '- '] },
    'a plan of objects': { ...PLAN, plan: [{ line: 'Make a poll' }, { line: 'Vote' }] },
    'a plan as a number': { ...PLAN, plan: 3 },
    'no build note': { ...PLAN, build_note: undefined },
    'a blank build note': { ...PLAN, build_note: '   ' },
    'a build note as an object': { ...PLAN, build_note: { screen: 'The open polls' } },
    'a build note of blank lines': { ...PLAN, build_note: ['', ' '] },
  };
  for (const [shape, reply] of Object.entries(refused)) {
    await withHelpers({ reply, haikuText: JSON.stringify(PLAN) }, async ({ openrouter, client, events }) => {
      const out = await askPlan();
      assert.equal(openrouter.calls.length, 1, shape);
      assert.equal(client.calls.length, 1, `${shape}: Haiku is asked`);
      assert.equal(out.model, 'claude-haiku-5-5', shape);
      assert.equal(fvPlan.parsePlanReply(out.text).bullets.length, 3, shape);
      assert.deepEqual(client.calls[0].output_config,
        { format: { type: 'json_schema', schema: llm.structuredOutputSchema(fvPlan.PLAN_SCHEMA) } }, shape);
      assert.equal(client.calls[0].max_tokens, 2000, shape);
      // The GLM attempt reads as the error it was, not a success.
      assert.deepEqual(events.map((e) => [e.provider, e.outcome, e.attempt_number]),
        [['openrouter', 'error', 1], ['anthropic', 'success', 2]], shape);
      assert.equal(events[0].component, 'first_version_plan');
    });
  }
});

test('the plan at Make it: a refused answer is logged by its shape, never its words', async () => {
  const log = require('../src/services/logger');
  const words = 'Polls for the Riverside running club';
  await withHelpers({ reply: { ...PLAN, plan: words, build_note: [] }, haikuText: JSON.stringify(PLAN) }, async () => {
    await askPlan();
  });
  const line = log.tail(20).find((e) => e.message === 'Helper model\'s answer was unusable; asking Haiku');
  assert.ok(line, 'logged');
  assert.equal(line.level, 'WARN');
  assert.deepEqual(line.data, {
    helper: 'first_version_plan',
    shape: { plan: `string(${words.length})`, choices: 'array(1: object)', build_note: 'array(0)', assumptions: 'array(1: string)' },
  });
  assert.doesNotMatch(JSON.stringify(line.data), /Riverside/);
});

test('the plan at Make it: a good GLM answer, or one in a shape the parse forgives, is never asked again', async () => {
  const forgiven = {
    'as asked': PLAN,
    'the plan as one string': { ...PLAN, plan: '- Make a poll in a few taps\n- Everyone votes once\n- See who won' },
    'the build note as lines': { ...PLAN, build_note: ['One screen: the open polls, newest first.', 'Its primary action is New poll.'] },
  };
  for (const [shape, reply] of Object.entries(forgiven)) {
    await withHelpers({ reply }, async ({ openrouter, client, events }) => {
      const out = await askPlan();
      assert.equal(client.calls.length, 0, `${shape}: no second call`);
      assert.equal(out.model, 'z-ai/glm-5.3-flash', shape);
      assert.deepEqual(fvPlan.parsePlanReply(out.text).bullets, ['Make a poll in a few taps', 'Everyone votes once', 'See who won'], shape);
      // GLM's tool carries the schema with its bounds; OpenRouter does not hold it to them.
      assert.deepEqual(openrouter.calls[0].tools[0].function.parameters, fvPlan.PLAN_SCHEMA, shape);
      assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.first_version_plan, shape);
      assert.deepEqual(events.map((e) => [e.provider, e.outcome]), [['openrouter', 'success']], shape);
    });
  }
});

// The 13 Oct replay of the plan at Make it (30 calls, production's prompt,
// schema and settings): usable answers took 268 to 705 output tokens; one
// ran away to the 3,500 ceiling and failed after 19 s; one wrote 1,533
// characters of its answer as text beside its tool call.
const glmReply = (over) => () => ({
  servedModel: 'z-ai/glm-5.3-flash',
  provider: 'Together',
  finishReason: 'tool_calls',
  content: '',
  toolCalls: [],
  usage: { inputTokens: 900, outputTokens: 320, reasoningTokens: 40, costUsd: 0.0002 },
  ...over,
});
const toolCall = (args) => [{ type: 'function', function: { name: 'answer', arguments: args } }];

test('the plan at Make it: GLM may write about 1,000 tokens, so a runaway fails in seconds; other helpers keep theirs', async () => {
  assert.equal(llm.HELPER_OUTPUT_LIMIT.first_version_plan, 1200);
  await withHelpers({ reply: PLAN }, async ({ openrouter, client }) => {
    await askPlan();
    assert.equal(openrouter.calls[0].maxOutputTokens, 1200, 'was 2,000 + 1,500 = 3,500');
    assert.equal(client.calls.length, 0);
  });
  await withHelpers({ reply: Object.assign(new Error('cut off'), { code: 'output_limit' }), haikuText: JSON.stringify(PLAN) }, async ({ client }) => {
    const out = await askPlan();
    assert.equal(out.model, 'claude-haiku-5-5', 'a runaway still goes to Haiku');
    assert.equal(client.calls[0].max_tokens, 2000, 'Haiku keeps the plan\'s own ceiling');
  });
  await withHelpers({ reply: { title: 'x' } }, async ({ openrouter }) => {
    await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(openrouter.calls[0].maxOutputTokens, 64 + 1500, 'a helper with no limit of its own is as it was');
  });
});

test('the plan at Make it: a near-empty tool call gives way to the plan written in the text', async () => {
  const log = require('../src/services/logger');
  const shapes = {
    'an empty tool call': { toolCalls: toolCall('{}') },
    'no tool call at all': { toolCalls: [] },
    'a tool call that is not JSON': { toolCalls: toolCall('{"plan": [') },
  };
  for (const [shape, over] of Object.entries(shapes)) {
    const reply = glmReply({ ...over, content: `Here is the plan.\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`` });
    await withHelpers({ reply }, async ({ client, events }) => {
      const out = await askPlan();
      assert.equal(client.calls.length, 0, `${shape}: no second call`);
      assert.equal(out.model, 'z-ai/glm-5.3-flash', shape);
      assert.deepEqual(JSON.parse(out.text), PLAN, shape);
      assert.equal(events[0].outcome, 'success', shape);
    });
  }
  const line = log.tail(20).find((e) => e.message === 'Helper model answered in its text, not its tool call');
  assert.deepEqual(line.data, { helper: 'first_version_plan', toolShape: null }, 'the last case had no tool answer');
  // The text is no better: Haiku, and the shape of what GLM did send.
  const bad = glmReply({ toolCalls: toolCall('{}'), content: JSON.stringify({ ...PLAN, plan: [] }) });
  await withHelpers({ reply: bad, haikuText: JSON.stringify(PLAN) }, async ({ client }) => {
    const out = await askPlan();
    assert.equal(client.calls.length, 1);
    assert.equal(out.model, 'claude-haiku-5-5');
  });
  const refused = log.tail(20).find((e) => e.message === 'Helper model\'s answer was unusable; asking Haiku');
  assert.deepEqual(refused.data, { helper: 'first_version_plan', shape: {} });
});

test('a helper with no validate never takes JSON from the text: nothing would check it', async () => {
  const reply = glmReply({ toolCalls: [], content: '{"title":"From the text"}' });
  await withHelpers({ reply, haikuText: '{"title":"From Haiku"}' }, async ({ client }) => {
    const out = await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(out.title, 'From Haiku');
    assert.equal(client.calls.length, 1);
  });
  assert.deepEqual(llm.helperTextAnswer('no json'), null);
  assert.deepEqual(llm.helperTextAnswer('a [1, 2] list'), null);
  assert.deepEqual(llm.helperTextAnswer('so: {"a": 1} done'), { a: 1 });
  assert.equal(llm.helperTextAnswer(null), null);
});

test('the routed host is recorded on each GLM attempt, answered or failed (run five\'s was unknown)', async () => {
  await withHelpers({ reply: glmReply({ toolCalls: toolCall(JSON.stringify(PLAN)) }) }, async ({ events }) => {
    await askPlan();
    assert.equal(events[0].provider, 'openrouter');
    assert.equal(events[0].served_provider, 'Together');
  });
  const failed = Object.assign(new Error('rate limited'), { code: 'rate_limited', provider: 'Modal' });
  await withHelpers({ reply: failed, haikuText: JSON.stringify(PLAN) }, async ({ events }) => {
    await askPlan();
    assert.equal(events[0].served_provider, 'Modal');
    assert.equal(Object.hasOwn(events[1], 'served_provider'), false, 'Haiku\'s attempt names no host');
  });
});

test('a validate that throws refuses the answer; a helper with no validate takes any object, as before', async () => {
  const params = { max_tokens: 64, messages: [{ role: 'user', content: 'x' }] };
  const defaults = { backend: 'helper', component: 'session_title' };
  await withHelpers({ reply: { title: 'GLM' } }, async ({ client }) => {
    const thrown = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, defaults,
      validate: () => { throw new Error('bad'); },
    });
    assert.equal(thrown.model, 'claude-haiku-5-5');
    const taken = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, defaults,
    });
    assert.equal(taken.model, 'z-ai/glm-5.3-flash');
    assert.deepEqual(taken.answer, { title: 'GLM' });
    assert.equal(client.calls.length, 1);
  });
});

test('structuredOutputSchema: the bounds Anthropic\'s structured output refuses come off, and nothing else', () => {
  assert.deepEqual(llm.structuredOutputSchema(fvPlan.PLAN_SCHEMA), {
    type: 'object',
    additionalProperties: false,
    properties: {
      plan: { type: 'array', items: { type: 'string' } },
      choices: fvPlan.PLAN_SCHEMA.properties.choices,
      build_note: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
    },
    required: ['plan', 'choices', 'build_note', 'assumptions'],
  });
  const nested = llm.structuredOutputSchema({
    type: 'object',
    properties: {
      minLength: { type: 'integer', minimum: 0, maximum: 9 },
      list: { type: 'array', minItems: 1, maxItems: 4, items: { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'null' }] } },
    },
  });
  assert.deepEqual(nested, {
    type: 'object',
    properties: {
      minLength: { type: 'integer' },
      list: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    },
  });
});

test('answerShape: each key\'s type and length, an array\'s item types, no values', () => {
  assert.deepEqual(llm.answerShape({ plan: 'abc', build_note: ['x', 1, 'y'], choices: [], n: null, o: { a: 1 }, b: true }), {
    plan: 'string(3)', build_note: 'array(3: string, number)', choices: 'array(0)', n: 'null', o: 'object(1)', b: 'boolean',
  });
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  const shape = llm.answerShape(many);
  assert.equal(Object.keys(shape).length, 17);
  assert.equal(shape['…'], '4 more');
  assert.deepEqual(llm.answerShape(null), { answer: 'null' });
});

test('the Workshop ask box: GLM\'s answer arrives whole; a picked model is asked as before', async () => {
  await withHelpers({ reply: { answer: 'It adds a reminder on Sundays.' } }, async ({ openrouter }) => {
    const tokens = [];
    const out = await llm.answerWorkshopQuestion({ contextJson: '{}', question: 'What does it do?', onToken: (t) => tokens.push(t) });
    assert.equal(out.text, 'It adds a reminder on Sundays.');
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.deepEqual(tokens, ['It adds a reminder on Sundays.']);
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.workshop_ask);
    assert.deepEqual(openrouter.calls[0].tools[0].function.parameters, llm.WORKSHOP_ASK_SCHEMA);
  });
  assert.equal(llm.WORKSHOP_ASK_MODEL, llm.HELPER_MODEL);
});

test('the bill: OpenRouter\'s figure when it gave one, else the published GLM price', () => {
  assert.equal(llm.estimateCostCents({ input_tokens: 1e6, output_tokens: 0, cost_usd: 0.0002 }, 'z-ai/glm-5.3-flash'), 0.02);
  const published = require('../src/services/model-costs').publishedPricing('z-ai/glm-5.3-flash');
  assert.equal(
    llm.estimateCostCents({ input_tokens: 1e6, output_tokens: 1e6, cost_usd: null }, 'z-ai/glm-5.3-flash'),
    (published.inputPricePerMillion + published.outputPricePerMillion) * 100,
  );
  assert.equal(llm.estimateCostCents({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-4-5'), 0.6, 'Claude rates unchanged');
});

test('Haiku 5.5 is billed on its own two rate cards, chosen by prompt length', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  // $0.10 / $0.50 per MTok up to 100K prompt tokens.
  near(llm.estimateCostCents({ input_tokens: 100000, output_tokens: 0 }, 'claude-haiku-5-5'), 1);
  near(llm.estimateCostCents({ input_tokens: 0, output_tokens: 1e6 }, 'claude-haiku-5-5'), 50);
  near(llm.estimateCostCents({ input_tokens: 100000, output_tokens: 1000 }, 'claude-haiku-5-5'), 1 + 0.05);
  // $0.50 / $2.50 above it, cached prompt tokens counted toward the length.
  near(llm.estimateCostCents({ input_tokens: 100001, output_tokens: 1000 }, 'claude-haiku-5-5'), 5.00005 + 0.25);
  near(llm.estimateCostCents({ input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 1000 }, 'claude-haiku-5-5'), 0.05 + 0.25);
});

test('withHelperThinking: thinking off on the Haiku fallback only, and never over a caller\'s own setting', () => {
  assert.equal(llm.HELPER_FALLBACK_MODEL, 'claude-haiku-5-5');
  assert.deepEqual(llm.withHelperThinking({ model: 'claude-haiku-5-5', max_tokens: 60 }).thinking, { type: 'disabled' });
  assert.equal(llm.withHelperThinking({ model: 'claude-sonnet-5-5' }).thinking, undefined);
  const own = { type: 'adaptive' };
  assert.equal(llm.withHelperThinking({ model: 'claude-haiku-5-5', thinking: own }).thinking, own);
  // The BYOK key check asks for one token, so it must not think either.
  assert.match(read('src/routes/auth.js'),
    /model: 'claude-haiku-5-5',\s+max_tokens: 1,\s+thinking: \{ type: 'disabled' \},/);
});

test('every helper the switch names goes through the path, and telemetry knows each by name', () => {
  const src = read('src/services/llm.js');
  for (const helper of Object.keys(llm.HELPER_TIME_LIMIT_MS)) {
    if (helper === 'workshop_ask') {
      assert.match(src, /askHelperModel\(\{\s+helper: 'workshop_ask',/);
    } else {
      assert.match(src, new RegExp(`helperMessage\\(\\{\\s+helper: '${helper}',`), `${helper} asks through helperMessage`);
    }
  }
  assert.equal((src.match(/'claude-haiku-5-5'/g) || []).length, 1, 'Haiku is named once, as the fallback');
  const components = read('src/services/llm-telemetry.js');
  for (const c of [...Object.keys(llm.HELPER_TIME_LIMIT_MS).filter((h) => h !== 'challenge_grade'), 'challenge_grade_feedback', 'challenge_grade_proposal']) {
    assert.ok(components.includes(`'${c}'`), `${c} is a telemetry component`);
  }

  const manifest = JSON.parse(read('dapp.json'));
  const entry = manifest.platform_env.find((e) => e.key === 'HELPER_MODEL');
  assert.equal(entry.default, 'glm');
  assert.match(entry.description, /haiku: Haiku 5\.5 only/);
  assert.equal(require('../src/services/app-sketch').SKETCH_MODEL, llm.HELPER_MODEL);
  assert.equal(require('../src/services/topochain/challenge-grader').GRADE_MODEL, llm.HELPER_MODEL);
  assert.match(read('src/services/mayor/pills.js'), /qrWithTimeout\(\(signal\) => llm\.generateQuickReplies\(\{[\s\S]*?signal,/,
    'the pills budget cancels the GLM attempt too');
});

// ── The helper model as an admin setting ────────────────────────────────

const helperModel = require('../src/services/helper-model');
const DS = 'deepseek/deepseek-v4.1-flash-1017';

function settingsPool({ value = null, fail = false, catalog = null } = {}) {
  const calls = [];
  const state = { value };
  return {
    calls,
    state,
    async query(sql, params) {
      const s = String(sql);
      calls.push({ s, params });
      if (fail) throw new Error('relation "platform_settings" does not exist');
      if (/FROM openrouter_model_catalog/.test(s)) return { rows: catalog ? [{ models: catalog }] : [] };
      if (/INSERT INTO platform_settings/.test(s)) {
        if (params[0] === helperModel.KEY) state.value = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/FROM platform_settings/.test(s)) return { rows: state.value == null ? [] : [{ value: state.value }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the helper model: the admin\'s when stored, else GLM; read once per cache window', async () => {
  const fresh = async (pool) => { helperModel.invalidate(); return helperModel.current(null, { pool }); };
  assert.equal(helperModel.BUILT_IN, llm.HELPER_MODEL, 'blank keeps the model the helpers always asked');
  assert.equal(await fresh(settingsPool({ value: DS })), DS);
  assert.equal(await fresh(settingsPool()), llm.HELPER_MODEL);
  assert.equal(await fresh(settingsPool({ value: '' })), llm.HELPER_MODEL);
  assert.equal(await fresh(settingsPool({ value: 'not a model' })), llm.HELPER_MODEL);
  assert.equal(await fresh(settingsPool({ fail: true })), llm.HELPER_MODEL, 'a read that fails keeps the helpers answering');
  helperModel.invalidate();
  assert.equal(await helperModel.current({}), llm.HELPER_MODEL, 'no database: the built-in model');

  const pool = settingsPool({ value: DS });
  helperModel.invalidate();
  await helperModel.current(null, { pool });
  pool.state.value = 'vendor/other';
  assert.equal(await helperModel.current(null, { pool }), DS, 'cached for CACHE_TTL_MS');
  assert.equal(pool.calls.length, 1);
  helperModel.invalidate();
  assert.equal(await helperModel.current(null, { pool }), 'vendor/other');
  helperModel.invalidate();
});

test('thinkingFor: GLM at low as before; any other model with its thinking off', () => {
  assert.equal(helperModel.thinkingFor('z-ai/glm-5.3-flash'), 'low');
  assert.equal(helperModel.thinkingFor('~z-ai/glm-5.3-flash'), 'low');
  assert.equal(helperModel.thinkingFor(DS), 'none');
  assert.equal(helperModel.thinkingFor('anthropic/claude-haiku-5.5'), 'none');
  const { buildRequest, reasoningEffort } = require('../src/services/openrouter');
  const base = { model: DS, messages: [{ role: 'user', content: 'hi' }], tools: [] };
  assert.deepEqual(buildRequest({ ...base, reasoning: 'none' }).reasoning, { enabled: false }, 'OpenRouter\'s switch for thinking off');
  assert.deepEqual(buildRequest({ ...base, reasoning: 'low' }).reasoning, { effort: 'low' });
  assert.throws(() => reasoningEffort('none'), /Invalid reasoning effort/,
    'thinking off is not an effort on the scale');
});

test('a helper model other than GLM is asked by name, with its thinking off, and recorded as asked', async () => {
  const reply = (input) => ({
    servedModel: input.model,
    finishReason: 'tool_calls',
    toolCalls: [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify({ title: 'Plant watering reminders' }) } }],
    usage: { inputTokens: 400, outputTokens: 40, reasoningTokens: 0, costUsd: 0.00006 },
  });
  await withHelpers({ reply, model: DS }, async ({ openrouter, client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['Remind us to water the plants'] });
    assert.equal(out.title, 'Plant watering reminders');
    assert.equal(out.model, DS);
    assert.equal(client.calls.length, 0);
    const sent = openrouter.calls[0];
    assert.equal(sent.model, DS);
    assert.equal(sent.reasoning, 'none');
    assert.equal(sent.maxOutputTokens, 64 + 1500, 'the same ceiling as GLM\'s');
    assert.equal(sent.timeoutMs, llm.HELPER_TIME_LIMIT_MS.session_title, 'and the same time limit');
    assert.equal(events[0].requested_model, DS);
    assert.equal(events[0].reasoning_effort, 'none');
  });
  // The plan at Make it keeps its tighter ceiling on any helper model.
  await withHelpers({ reply: null, model: DS }, async ({ openrouter }) => {
    await llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: { type: 'object' }, validate: () => false }).catch(() => {});
    assert.equal(openrouter.calls[0].maxOutputTokens, llm.HELPER_OUTPUT_LIMIT.first_version_plan);
    assert.equal(openrouter.calls[0].reasoning, 'none');
  });
});

test('a caller that names another model, or HELPER_MODEL=haiku, still never reaches the helper model', async () => {
  await withHelpers({ reply: { title: 'x' }, model: DS }, async ({ openrouter, client }) => {
    await llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: { type: 'object' }, model: 'claude-sonnet-5-5' }).catch(() => {});
    assert.equal(client.calls[0].model, 'claude-sonnet-5-5');
    const prev = process.env.HELPER_MODEL;
    process.env.HELPER_MODEL = 'haiku';
    try {
      await llm.generateSessionTitle({ requests: ['a'] });
    } finally {
      if (prev === undefined) delete process.env.HELPER_MODEL; else process.env.HELPER_MODEL = prev;
    }
    assert.equal(openrouter.calls.length, 0);
    assert.ok(client.calls.length >= 1);
  });
});

test('the bot settings carry it: patched, checked against the catalog, and followed at once', async () => {
  const bot = require('../src/services/homeroom-bot');
  assert.equal(bot.parseSettings([{ key: bot.KEY_HELPER_MODEL, value: DS }]).helperModel, DS);
  assert.equal(bot.parseSettings([{ key: bot.KEY_HELPER_MODEL, value: 'oops' }]).helperModel, '');
  assert.equal(bot.parseSettings([]).helperModel, '', 'blank is the built-in model');
  assert.deepEqual(bot.validateSettingsPatch({ helperModel: DS }).updates, [[bot.KEY_HELPER_MODEL, DS]]);
  assert.deepEqual(bot.validateSettingsPatch({ helperModel: null }).updates, [[bot.KEY_HELPER_MODEL, '']]);
  assert.match(bot.validateSettingsPatch({ helperModel: 'gpt; rm -rf' }).error, /^helperModel must be an OpenRouter model id/);

  const catalog = [
    { id: DS, supported_parameters: ['tools', 'reasoning'] },
    { id: 'vendor/no-tools', supported_parameters: ['temperature'] },
  ];
  const pool = settingsPool({ catalog });
  helperModel.invalidate();
  assert.equal(await helperModel.current(null, { pool }), llm.HELPER_MODEL);
  const missing = await bot.writeSettings(pool, { helperModel: 'vendor/not-listed' }, 1, {});
  assert.match(missing.error, /^Not in the OpenRouter catalog: vendor\/not-listed\. The helper model must/);
  assert.match((await bot.writeSettings(pool, { helperModel: 'vendor/no-tools' }, 1, {})).error, /every helper call answers through one/);
  assert.match((await bot.writeSettings(settingsPool(), { helperModel: DS }, 1, {})).error, /check the helper model against/);
  assert.equal(pool.calls.filter((c) => /INSERT INTO platform_settings/.test(c.s)).length, 0, 'a refused save writes nothing');

  assert.deepEqual(await bot.writeSettings(pool, { helperModel: DS }, 1, {}), { ok: true });
  assert.equal(await helperModel.current(null, { pool }), DS, 'this server follows the save at once');
  assert.deepEqual(await bot.writeSettings(pool, { helperModel: '' }, 1, {}), { ok: true }, 'blank needs no catalog');
  assert.equal(await helperModel.current(null, { pool }), llm.HELPER_MODEL);
  helperModel.invalidate();
});
