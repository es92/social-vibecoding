// #6585: the kind the public directory sorts a project under when its group
// never chose one (src/services/app-category.js, public-app-directory.js
// directoryCategory). The model is stubbed at its transport; the database at
// the pool, so what is tested here is this service's own logic. The query
// against a real database is tests/app-category-postgres.test.js.
//
// Run with: node --test tests/app-category.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const appCategory = require('../src/services/app-category');
const { directoryCategory } = require('../src/services/public-app-directory');
const llm = require('../src/services/llm');

function fakePool(rows) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/FROM apps a/i.test(sql)) {
        assert.match(sql, /app_inferred_categories/);
        return { rows };
      }
      if (/INSERT INTO app_inferred_categories/i.test(sql)) {
        writes.push(params);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${String(sql).slice(0, 80)}`);
    },
  };
}

async function withAnswer(answer, fn) {
  const calls = [];
  const openrouter = {
    calls,
    async streamChat(input) {
      calls.push(input);
      return {
        servedModel: 'z-ai/glm-5.3-flash',
        finishReason: 'tool_calls',
        toolCalls: [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify(answer) } }],
        usage: { inputTokens: 200, outputTokens: 10, costUsd: 0.00001 },
      };
    },
  };
  const prevDeps = llm._setHelperDepsForTests({ openrouter, key: 'sk-or-bot', config: {} });
  try {
    return await fn(calls);
  } finally {
    llm._setHelperDepsForTests(prevDeps);
  }
}

test('the directory kind: a chosen one wins, otherwise the inferred one, otherwise what was written', () => {
  assert.equal(directoryCategory(null, 'food'), 'food', 'no line: the inferred kind');
  assert.equal(directoryCategory('other', 'money'), 'money', 'the starting Other is not a choice');
  assert.equal(directoryCategory('games', 'money'), 'games', 'a kind the group chose is never overridden');
  assert.equal(directoryCategory('Games', 'money'), 'games', 'the chosen kind is read leniently');
  assert.equal(directoryCategory('nonsense', 'health'), 'health', 'an unknown line says nothing');
  assert.equal(directoryCategory(null, null), null, 'neither: no kind');
  assert.equal(directoryCategory('other', null), 'other', 'Other only when nothing fits either');
  assert.equal(directoryCategory('other', 'not-a-kind'), 'other');
});

test('only a real key other than other is a choice', () => {
  assert.equal(appCategory.isChosen('games'), true);
  assert.equal(appCategory.isChosen(' Money '), true);
  for (const not of [null, undefined, '', 'other', 'cooking', 3]) {
    assert.equal(appCategory.isChosen(not), false, JSON.stringify(not));
  }
});

test('the model: one key from the list, and Other when its answer is not one', async () => {
  await withAnswer({ category: 'food' }, async (calls) => {
    assert.equal(await appCategory.infer({ name: 'Recipe box', description: 'Recipes from the fridge.' }), 'food');
    const sent = calls[0];
    assert.equal(sent.timeoutMs, llm.HELPER_TIME_LIMIT_MS.app_category);
    assert.match(sent.messages[0].content, /food: recipes, baking, coffee/);
    assert.match(sent.messages[0].content, /money: budgets, trading, splitting bills, a till/);
    assert.match(sent.messages[0].content, /health: gym logs, runs, habits/);
    assert.match(sent.messages[0].content, /`other` only when the project fits none/);
    assert.match(sent.messages.at(-1).content, /Name: Recipe box/);
  });
  await withAnswer({ category: 'cooking' }, async () => {
    assert.equal(await appCategory.infer({ name: 'Pot luck', description: 'Who brings what to dinner.' }), 'other');
  });
  await withAnswer({}, async () => {
    assert.equal(await appCategory.infer({ name: 'Something', description: '' }), 'other');
  });
});

test('the sweep works out each eligible project and skips a chosen kind', async () => {
  const pool = fakePool([
    { id: 1, name: 'A game', slug: 'a-game', description: 'A game', category: 'games', inferred_source: null },
    { id: 2, name: 'Recipe box', slug: 'recipe-box', description: 'Recipes from the fridge.', category: null, inferred_source: null },
    { id: 3, name: 'Bill splitter', slug: 'bill-splitter', description: 'Split the bills.', category: 'other', inferred_source: 'an older description' },
  ]);
  await withAnswer({ category: 'food' }, async (calls) => {
    const out = await appCategory.sweep(pool);
    assert.deepEqual(out, { inferred: 2, failed: 0 });
    assert.equal(calls.length, 2, 'the chosen game is never asked about');
  });
  assert.deepEqual(pool.writes.map((w) => [w[0], w[1], w[2]]), [
    [2, 'food', 'Recipes from the fridge.'],
    [3, 'food', 'Split the bills.'],
  ]);
});

test('a sweep that cannot reach the model records a failure to retry a day later', async () => {
  const pool = fakePool([
    { id: 2, name: 'Recipe box', slug: 'recipe-box', description: 'Recipes.', category: null, inferred_source: null },
  ]);
  const prevDeps = llm._setHelperDepsForTests({
    openrouter: { async streamChat() { throw new Error('no provider'); } },
    key: 'sk-or-bot', config: {},
  });
  try {
    const out = await appCategory.sweep(pool);
    assert.deepEqual(out, { inferred: 0, failed: 1 });
    assert.deepEqual(pool.writes.map((w) => [w[0], w[1], w[2]]), [[2, null, 'Recipes.']],
      'a NULL category waits a day before it is tried again');
  } finally {
    llm._setHelperDepsForTests(prevDeps);
  }
});

test('a new project reuses the kind stored for the same description, without asking the model', async () => {
  const pool = fakePool([]);
  pool.query = async (sql, params) => {
    if (/SELECT category, source_description/i.test(sql)) {
      return { rows: [{ category: 'money', source_description: 'Split the bills.' }] };
    }
    if (/INSERT INTO app_inferred_categories/i.test(sql)) {
      pool.writes.push(params);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  await withAnswer({ category: 'food' }, async (calls) => {
    const category = await appCategory.forNewProject(pool, { id: 7, name: 'Split' }, 'Split the bills.');
    assert.equal(category, 'money');
    assert.equal(calls.length, 0, 'a stored answer for the same words is reused');
  });
  assert.equal(pool.writes.length, 0);
});

test('a new project the model cannot place starts as Other, and creation never fails on it', async () => {
  const pool = fakePool([]);
  pool.query = async (sql) => {
    if (/SELECT category, source_description/i.test(sql)) return { rows: [] };
    if (/INSERT INTO app_inferred_categories/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const prevDeps = llm._setHelperDepsForTests({
    openrouter: { async streamChat() { throw new Error('no provider'); } },
    key: 'sk-or-bot', config: {},
  });
  try {
    assert.equal(await appCategory.forNewProject(pool, { id: 7, name: 'Something' }, 'Words'), 'other');
  } finally {
    llm._setHelperDepsForTests(prevDeps);
  }
});

test('a new project waits only so long, then starts as Other', async () => {
  const pool = fakePool([]);
  pool.query = async (sql) => {
    if (/SELECT category, source_description/i.test(sql)) return { rows: [] };
    if (/INSERT INTO app_inferred_categories/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const prevDeps = llm._setHelperDepsForTests({
    // The call is paid for all the same and settles later; the maker does not wait.
    openrouter: {
      streamChat: () => new Promise((resolve) => setTimeout(() => resolve({
        servedModel: 'z-ai/glm-5.3-flash',
        finishReason: 'tool_calls',
        toolCalls: [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify({ category: 'food' }) } }],
        usage: {},
      }), 200)),
    },
    key: 'sk-or-bot', config: {},
  });
  try {
    const started = Date.now();
    const category = await appCategory.forNewProject(pool, { id: 7, name: 'Something' }, 'Words', { waitMs: 20 });
    assert.equal(category, 'other');
    assert.ok(Date.now() - started < 1000, 'it did not wait out the model');
  } finally {
    llm._setHelperDepsForTests(prevDeps);
  }
});
