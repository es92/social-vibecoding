'use strict';

// #6358: a design turn draws a whole screen. The design profile raises the
// room a step gets and its clock, and a draw cut off at its limit is asked
// again with twice the design allowance. This runs the real
// homeroom-bot-mayor askModel with a fake transport, so what is pinned is the
// engine's own behaviour: the second request carries the larger allowance,
// both carry the design clock, and retryOutputTokens is never sent to a model.
//
// Run with: node --test tests/design-bot-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function turn(chat) {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    config: {},
    user: { id: 1 },
    message: { id: 2 },
    route: 1,
    avoid: [],
    failures: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    startedMs: Date.now(),
    sleep: async () => {},
    chat,
  };
}

test('#6358: a cut-off design draw is asked again with the design retry allowance', async () => {
  const sent = [];
  const chat = async (request) => {
    sent.push(request);
    if (sent.length === 1) throw Object.assign(new Error('cut off at its output limit'), { code: 'output_limit' });
    return { content: 'The whole page is here.', toolCalls: [], usage: {}, provider: 'test' };
  };
  const res = await mayor.askModel(turn(chat), {
    messages: [{ role: 'user', content: 'Draw the recipe home page' }],
    tools: [],
    toolChoice: 'auto',
    where: 'd1',
    maxOutputTokens: designBot.DESIGN_OUTPUT_TOKENS,
    retryOutputTokens: designBot.DESIGN_RETRY_OUTPUT_TOKENS,
    timeoutMs: designBot.DESIGN_REQUEST_TIMEOUT_MS,
  });

  assert.equal(res.content, 'The whole page is here.');
  assert.equal(sent.length, 2, 'the cut-off draw is asked again once');
  assert.equal(sent[0].maxOutputTokens, 16_000, 'a design step writes about four times what it did');
  assert.equal(sent[0].timeoutMs, 180_000, 'and may take three minutes');
  assert.equal(sent[1].maxOutputTokens, 32_000, 'a cut-off draw gets twice the design allowance');
  assert.equal(sent[1].timeoutMs, 180_000, 'and keeps the design clock');
  for (const request of sent) assert.equal('retryOutputTokens' in request, false, 'never sent to the model');
});

test('#6358: the design turn passes its profile\'s allowance, retry and clock to askModel', () => {
  assert.equal(designBot.DESIGN_OUTPUT_TOKENS, 16_000);
  assert.equal(designBot.DESIGN_RETRY_OUTPUT_TOKENS, 32_000);
  assert.equal(designBot.DESIGN_REQUEST_TIMEOUT_MS, 180_000);
  const src = read('src/services/design-bot.js');
  assert.match(src, /maxOutputTokens: DESIGN_OUTPUT_TOKENS,/);
  assert.match(src, /retryOutputTokens: DESIGN_RETRY_OUTPUT_TOKENS,/);
  assert.match(src, /timeoutMs: DESIGN_REQUEST_TIMEOUT_MS,/);
  // The picture-look request keeps its own short allowance.
  assert.match(src, /maxOutputTokens: Math\.min\(PICTURE_TOKENS \* pictures\.length \+ 200, DESIGN_OUTPUT_TOKENS\)/);
});
