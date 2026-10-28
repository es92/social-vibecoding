'use strict';

// test:changed: always (one read of src/**; the guard below is about callers it cannot name in advance)

// #3772, again on 5 October 2026: the OpenRouter transport
// (src/services/openrouter.js) asks for require_parameters, so
// any parallel_tool_calls it sends, `false` included, routes the call only to
// providers that take that parameter. For GLM 5.3 Flash that is one of its
// thirty-three (Inceptron): every call becomes that one provider's, its 429s
// and slow answers included, with nowhere to fail over.
//
// The DM was fixed first (homeroom-bot-mayor.js askModel). The model
// helpers (llm.js askHelperModel, #3932) and the small-change tag
// (small-change.js, #3918) then copied `parallelToolCalls: false` and hit it
// again: feedback titles timed out or were rate-limited. A caller that
// wants parallel calls says `true`, and only for a model that takes them;
// everyone else passes null.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no caller sends parallel_tool_calls: false through the OpenRouter transport', () => {
  const offenders = sources(path.join(ROOT, 'src'))
    .filter((file) => /parallelToolCalls:\s*false\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, [], 'pass null: false is still sent, and narrows the model to the providers that take it');
});

test('null leaves the field out, and the transport asks OpenRouter to honour every field it sends', () => {
  const { buildRequest } = require('../src/services/openrouter');
  const base = { model: 'z-ai/glm-5.3-flash', reasoning: 'low', messages: [], tools: [] };
  assert.equal('parallel_tool_calls' in buildRequest({ ...base, parallelToolCalls: null }), false);
  assert.equal(buildRequest(base).provider.require_parameters, true,
    'if this ever changes, the rule above can relax');
});
