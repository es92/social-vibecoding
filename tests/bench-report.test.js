'use strict';

// #3654: the benchmark's statistics and its chart. pass^k counts a task only
// when every attempt is graded; the paired interval is reproducible from its
// seed and resamples apps, not tasks; the Pareto frontier keeps what nothing
// beats on both cost and accuracy; a run's row keeps platform faults out of
// accuracy and counts every attempt's cost; and the chart marks the frontier
// and names each model in words beside its point.

const test = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../src/services/bench/stats');
const report = require('../src/services/bench/report');

test('percentiles, and pass^k over tasks with all k attempts graded', () => {
  assert.equal(stats.percentile([10, 20, 30, 40], 50), 25);
  assert.equal(stats.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95).toFixed(2), '9.55');
  assert.equal(stats.percentile([], 50), null);
  const attempts = new Map([
    [1, ['pass', 'pass', 'pass']],
    [2, ['pass', 'fail', 'pass']],
    [3, ['pass', 'pass', 'pending']],
    [4, ['pass', 'pass']],
  ]);
  assert.deepEqual(stats.passHatK(attempts, 3), { k: 3, tasks: 2, passAll: 1, value: 0.5 },
    'a task waiting for a grade, or short of attempts, is not counted');
});

test('the paired difference: its mean, and an interval that is the same for the same seed', () => {
  const pairs = [];
  const rand = stats.mulberry32(42);
  for (let i = 0; i < 30; i += 1) pairs.push({ task: i, app: `app${i % 5}`, a: rand() < 0.7 ? 1 : 0, b: rand() < 0.5 ? 1 : 0 });
  const one = stats.pairedDiff(pairs, { seed: 7 });
  const two = stats.pairedDiff(pairs, { seed: 7 });
  assert.deepEqual(one, two, 'deterministic for a seed');
  assert.equal(one.n, 30);
  assert.equal(one.apps, 5);
  assert.ok(one.low <= one.diff && one.diff <= one.high, `${one.low} <= ${one.diff} <= ${one.high}`);
  // One app holding every difference: resampling apps can only draw that app,
  // so the interval collapses to its mean; resampling tasks would not.
  const lone = stats.pairedDiff([{ task: 1, app: 'a', a: 1, b: 0 }, { task: 2, app: 'a', a: 0, b: 0 }], { seed: 1 });
  assert.deepEqual([lone.low, lone.high], [0.5, 0.5]);
  assert.deepEqual(stats.pairedDiff([]), { n: 0, apps: 0, diff: null, low: null, high: null });
});

test('the Pareto frontier keeps what nothing beats on both cost and accuracy', () => {
  const frontier = stats.paretoFrontier([
    { key: 'cheap', cost: 0.01, accuracy: 0.6 },
    { key: 'mid', cost: 0.05, accuracy: 0.8 },
    { key: 'dominated', cost: 0.06, accuracy: 0.7 },
    { key: 'best', cost: 0.5, accuracy: 0.95 },
    { key: 'pricey-worse', cost: 0.6, accuracy: 0.9 },
    { key: 'ungraded', cost: 0.01, accuracy: null },
  ]);
  assert.deepEqual([...frontier].sort(), ['best', 'cheap', 'mid']);
});

test('a row: platform faults out of accuracy, timeouts in it, every attempt\'s cost counted', () => {
  const t = (task, status, final, cost, ms = 1000) => ({ task_id: task, status, final, cost_usd: cost, duration_ms: ms });
  const row = report.summarize([
    t(1, 'ok', 'pass', 0.1), t(1, 'ok', 'pass', 0.1), t(1, 'ok', 'pass', 0.1),
    t(2, 'ok', 'fail', 0.2), t(2, 'timeout', 'fail', 0.3, 9000), t(2, 'infra_fail', 'excluded', 0),
    t(3, 'not_applicable', 'excluded', null, null),
  ], { stage: 'triage', k: 3 });
  assert.equal(row.accuracy, 3 / 5);
  assert.equal(row.timeoutRate, 1 / 6);
  assert.equal(row.infraRate, 1 / 6);
  assert.equal(row.notApplicable, 1);
  assert.equal(Math.round(row.costUsd * 100) / 100, 0.8);
  assert.equal(Math.round(row.costPerTask * 100) / 100, 0.4, 'two tasks attempted');
  assert.equal(Math.round(row.costPerAttempt * 1000) / 1000, 0.133, 'six attempts, the platform fault included');
  assert.equal(Math.round(row.costPerSuccess * 1000) / 1000, 0.267, 'failed attempts included in the cost of a success');
  assert.ok(row.costPerSuccess >= row.costPerAttempt, 'a success never costs less than an attempt');
  assert.deepEqual(row.passK, { k: 3, tasks: 1, passAll: 1, value: 1 });
});

test('the chart: the frontier filled and joined, each point named in words, a title for each', () => {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ParetoChart, BenchmarkArea } = loadTsx('frontend/src/features/admin/admin-homeroom-bench.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)) }),
      },
    },
  });
  const models = [{ id: 'a/cheap', label: 'Cheap' }, { id: 'b/best', label: 'Best' }, { id: 'c/meh', label: 'Meh' }];
  const html = renderToHtml(createElement(ParetoChart, {
    models,
    points: [
      { key: 't|a/cheap', stage: 'triage', model: 'a/cheap', cost: 0.01, accuracy: 0.6, frontier: true },
      { key: 't|b/best', stage: 'triage', model: 'b/best', cost: 0.3, accuracy: 0.9, frontier: true },
      { key: 't|c/meh', stage: 'triage', model: 'c/meh', cost: 0.4, accuracy: 0.5, frontier: false },
    ],
  }));
  assert.match(html, /id="admin-homeroom-bench-pareto"/);
  assert.equal((html.match(/data-frontier="true"/g) || []).length, 2);
  assert.match(html, /<polyline/);
  for (const name of ['Cheap', 'Best', 'Meh']) assert.match(html, new RegExp(`>${name}</text>`), `${name} is labelled in words`);
  assert.match(html, /<title>Best: 90% at \$0\.300 an attempt, on the frontier<\/title>/);
  assert.match(renderToHtml(createElement(ParetoChart, { models, points: [] })), /No graded results at this stage yet/);
  // Its first render, before any data: the cards' hosts, and nothing else.
  const area = renderToHtml(createElement(BenchmarkArea, { canWrite: true }));
  for (const id of ['admin-homeroom-bench', 'admin-homeroom-bench-intro', 'admin-homeroom-bench-suites', 'admin-homeroom-bench-runs']) {
    assert.match(area, new RegExp(`id="${id}"`));
  }
});
