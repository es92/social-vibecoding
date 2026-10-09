'use strict';

// The First challenges gate (services/topochain/challenge-onboarding.js).
//
// 2026-10-01 (evan's "one list" decision): the gate is FOUR challenges, up
// from three, because the Getting started card on Home is now the tour plus
// the season's First challenges (Join, Try, Vote, Suggest); "done" is the
// tour AND every one of them; and it applies only to a NEW account
// (`users.getting_started_gate`, set at sign-up) that has come through the
// join screen. An existing member and a signed-out visitor see the whole
// season and get no gate summary. Once a gated account's list is done the
// gate stays open (`getting_started_unlocked_at`), even if an admin adds an
// ONBOARDING challenge later. The fixtures below carry the viewer's three
// facts on every row, as loadOnboarding's join on `users` does.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  buildOnboarding, loadOnboarding, visibleChallenges, challengeCategory,
  isLocked, gateSummary, ONBOARDING_LIMIT,
} = require('../src/services/topochain/challenge-onboarding');

// A new account on its Getting started list, tour done: what most tests
// below are about. `viewer` overrides it.
const NEWCOMER = { gate: true, tour_done: true, unlocked: false };
const step = (id, extra = {}) => ({
  id, season_event_id: 10, challenge_template_id: id + 100,
  display_order: id, enabled: true, completed: false,
  metric_type: null, metric_target: null, activity_count: 0,
  ...NEWCOMER,
  ...extra,
});
const intro = (counts = [0, 0, 0, 0], viewer = {}) => [
  step(1, { metric_type: 'count', metric_target: 3, activity_count: counts[0], ...viewer }),
  step(2, { activity_count: counts[1], ...viewer }),
  step(3, { activity_count: counts[2], ...viewer }),
  step(4, { activity_count: counts[3], ...viewer }),
  step(5, viewer),
];

test('new users see exactly four introductory challenges out of the nine-card catalog', () => {
  assert.equal(ONBOARDING_LIMIT, 4, 'Join, Try, Vote and Suggest (2026-10-01)');
  const state = buildOnboarding(intro());
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
  assert.deepEqual(state.summary, { total: 4, completed: 0, unlocked: false, event_id: 10 });
  assert.equal(state.gated, true);
  assert.equal(isLocked(state), true);
  assert.deepEqual(visibleChallenges(Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })), state),
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
});

test('partial credit on the counted step cannot unlock persistent or weekly challenges', () => {
  const state = buildOnboarding(intro([2, 1, 1, 1]));
  assert.equal(state.summary.completed, 3);
  assert.equal(state.summary.unlocked, false);
  assert.deepEqual(state.progress.get(1), { done: false, current: 2, target: 3 });
});

test('all four completed steps unlock both groups and retain the completed introduction', () => {
  const state = buildOnboarding(intro([3, 1, 1, 1]));
  const items = Array.from({ length: 9 }, (_, i) => ({ id: i + 1 }));
  assert.equal(state.summary.unlocked, true);
  assert.equal(state.finished, true);
  assert.equal(state.opened, true, 'the read that first finds it done, which loadOnboarding records');
  assert.equal(visibleChallenges(items, state).length, 9);
  assert.equal(challengeCategory(1, 'ONBOARDING', state), 'ONBOARDING');
  assert.equal(challengeCategory(4, 'ONBOARDING', state), 'ONBOARDING');
  assert.equal(challengeCategory(5, 'ONBOARDING', state), 'PERSISTENT');
  assert.equal(challengeCategory(6, 'ONBOARDING', state), 'PERSISTENT');
  assert.equal(challengeCategory(7, 'WEEKLY', state), 'WEEKLY');
});

test('the tour is part of the list: every challenge done is not done until the tour is', () => {
  const state = buildOnboarding(intro([3, 1, 1, 1], { tour_done: false }));
  assert.equal(state.summary.completed, 4, 'the challenges\' own numbers leave the tour out');
  assert.equal(state.summary.unlocked, false, 'but the gate waits on it');
  assert.equal(state.finished, false);
  assert.equal(state.opened, false);
  // A tour finished with nothing else done opens nothing either.
  assert.equal(buildOnboarding(intro([0, 0, 0, 0])).summary.unlocked, false);
});

test('only a new account is gated: an existing member and a signed-out visitor see the whole season', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: i + 1 }));
  for (const [who, viewer] of [
    ['an existing member', { gate: false, tour_done: false, unlocked: false }],
    ['a signed-out visitor', { gate: null, tour_done: null, unlocked: null }],
  ]) {
    const state = buildOnboarding(intro([0, 0, 0, 0], viewer));
    assert.equal(state.gated, false, who);
    assert.equal(state.summary.unlocked, true, `${who}: nothing is locked`);
    assert.equal(isLocked(state), false, who);
    assert.equal(visibleChallenges(items, state).length, 9, `${who}: every challenge`);
    assert.equal(gateSummary(state), null, `${who}: and no gate summary to explain`);
    assert.equal(state.opened, false, `${who}: nothing to record`);
    // The grouping is everyone's: the first four are First challenges, the
    // rest of ONBOARDING is always open.
    assert.equal(challengeCategory(4, 'ONBOARDING', state), 'ONBOARDING', who);
    assert.equal(challengeCategory(5, 'ONBOARDING', state), 'PERSISTENT', who);
  }
  const newcomer = buildOnboarding(intro());
  assert.deepEqual(gateSummary(newcomer), newcomer.summary, 'a newcomer gets the summary');
});

test('once open, open for good: a challenge added later does not lock a finished account again', () => {
  // The account's list was done on an earlier read (getting_started_unlocked_at
  // set), and an admin has since put a new ONBOARDING challenge first.
  const rows = intro([3, 1, 1, 1], { unlocked: true });
  rows.unshift(step(9, { display_order: 0, unlocked: true }));
  const state = buildOnboarding(rows);
  assert.deepEqual(state.ids, [9, 1, 2, 3], 'the new one is a First challenge now');
  assert.equal(state.summary.completed, 3);
  assert.equal(state.gated, false, 'but the gate does not apply any more');
  assert.equal(state.summary.unlocked, true);
  assert.equal(state.finished, true, 'the card stays "all set"');
  assert.equal(state.opened, false, 'nothing to record again');
  assert.equal(visibleChallenges([{ id: 7 }], state).length, 1);
});

test('completed steps never rotate out and pull identity into onboarding', () => {
  const state = buildOnboarding(intro([3, 1, 0, 1]));
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
  assert.equal(state.summary.unlocked, false);
});

test('an explicit completion credit finishes a counted step even when awarded in one batch', () => {
  const rows = intro([1, 1, 1, 1]);
  rows[0].completion_recorded = true;
  const state = buildOnboarding(rows);
  assert.equal(state.summary.unlocked, true);
  assert.deepEqual(state.progress.get(1), { done: true, current: 3, target: 3 });
});

test('disabled, retired and unavailable steps do not block users or replace the original four', () => {
  for (const availability of [
    { enabled: false }, { completed: true },
    { schedule_end: '2020-01-01T00:00:00Z' },
    { schedule_start: '2100-01-01T00:00:00Z' },
  ]) {
    const rows = intro([0, 1, 1, 1]);
    Object.assign(rows[0], availability);
    const state = buildOnboarding(rows);
    assert.deepEqual(state.ids, [1, 2, 3, 4]);
    assert.equal(state.summary.total, 3);
    assert.equal(state.summary.unlocked, true);
    // The card lists only the steps that can be done.
    assert.deepEqual(state.steps.map((r) => r.id), [2, 3, 4]);
    // An organiser's completed flag did not create a personal completion.
    assert.equal(state.progress.get(1).done, false);
  }
});

test('selection follows organiser order and deduplicates repeated template instances', () => {
  const rows = intro();
  rows.push(step(9, { challenge_template_id: 101, display_order: 1 }));
  const state = buildOnboarding(rows.reverse());
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
});

test('seasons without onboarding keep their existing challenge lists', () => {
  const items = [{ id: 6, category: 'WEEKLY' }];
  assert.equal(buildOnboarding([]), null);
  assert.equal(visibleChallenges(items, null), items);
  assert.equal(gateSummary(null), null);
  assert.equal(isLocked(null), false);
});

test('event-scoped reads resolve onboarding across the season and reuse prior template credits', async () => {
  let query;
  const state = await loadOnboarding({ query: async (sql, params) => {
    query = { sql, params };
    return { rows: intro([3, 1, 1, 1], { unlocked: true }) };
  } }, 42, { eventId: 11 });
  assert.deepEqual(query.params, [42, 11]);
  assert.match(query.sql, /se\.season_id = \(SELECT season_id FROM season_events WHERE id = \$2\)/);
  assert.match(query.sql, /credited\.challenge_template_id = c\.challenge_template_id/);
  assert.match(query.sql, /ua\.user_id = \$1/);
  // The viewer's gate rides the same read: the flag alone decides, however
  // the account signed up (#4601), as it does for the card.
  assert.match(query.sql, /SELECT u\.getting_started_gate AS gate,/);
  assert.doesNotMatch(query.sql, /communities_onboarded_at/);
  assert.match(query.sql, /\(u\.tour_done_at IS NOT NULL\) AS tour_done/);
  assert.match(query.sql, /\(u\.getting_started_unlocked_at IS NOT NULL\) AS unlocked/);
  assert.match(query.sql, /FROM users u WHERE u\.id = \$1\s*\) viewer ON TRUE/);
  // And what the card draws: the challenge's words over its template's, the
  // points paid on the template, and the bound rule's measure.
  assert.match(query.sql, /COALESCE\(c\.goal, ct\.goal\) AS goal/);
  assert.match(query.sql, /COALESCE\(SUM\(ua\.points\), 0\) AS earned_points/);
  assert.match(query.sql, /SELECT r\.measure FROM challenge_scoring_rules r/);
  assert.equal(state.summary.unlocked, true);
});

test('the read that opens the gate records it, once, and a failed write never fails the read', async () => {
  const calls = [];
  let unlocked = false;
  let failWrite = true;
  const pool = { query: async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^UPDATE users SET getting_started_unlocked_at/.test(sql.trim())) {
      if (failWrite) throw new Error('connection reset');
      unlocked = true;
      return { rows: [] };
    }
    return { rows: intro([3, 1, 1, 1], { unlocked }) };
  } };
  // The write fails: the read still answers, with the gate open.
  let state = await loadOnboarding(pool, 7, { seasonId: 2 });
  assert.equal(state.summary.unlocked, true);
  assert.equal(calls.length, 2);
  // The next read tries again, and this time it lands.
  failWrite = false;
  state = await loadOnboarding(pool, 7, { seasonId: 2 });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].sql,
    'UPDATE users SET getting_started_unlocked_at = NOW() WHERE id = $1 AND getting_started_gate AND getting_started_unlocked_at IS NULL');
  assert.deepEqual(calls[3].params, [7]);
  assert.equal(unlocked, true);
  // From then on the account is not gated, and nothing is written.
  state = await loadOnboarding(pool, 7, { seasonId: 2 });
  assert.equal(calls.length, 5);
  assert.equal(state.gated, false);
  // A signed-out read never writes.
  const anon = { query: async (sql) => {
    assert.doesNotMatch(sql, /UPDATE/);
    return { rows: intro([3, 1, 1, 1], { gate: null, tour_done: null, unlocked: null }) };
  } };
  assert.equal((await loadOnboarding(anon, null, { seasonId: 2 })).gated, false);
});

// HTTP coverage of the actual list handlers. Authentication has dedicated
// suites; inject an authenticated identity here and exercise the same handler
// registered for web sessions and native tokens against one catalog/ledger.
//
// `viewer` is the account's gate facts (a newcomer by default; `unlocked`
// follows the write the opening read makes, as the column would), and
// `user: null` is a signed-out visitor.
function makeApp(counts = [0, 0, 0, 0], credits = {}, { viewer = NEWCOMER, user = { id: 7, username: 'viewer' } } = {}) {
  // `blocks` is the viewer's newest leaderboard snapshot for the event — the
  // only place a block score is ever written, and what challenge 9 below is
  // counted from.
  const state = { counts, credits, blocks: 0, viewer: { ...viewer }, writes: 0 };
  const rows = Array.from({ length: 9 }, (_, i) => {
    const id = i + 1;
    return {
      ...step(id), t_id: id + 100, t_category: id <= 5 ? 'ONBOARDING' : 'WEEKLY',
      t_goal: ['Try Three Apps', 'Propose a Change', 'Join Network Operation',
        'Identity Level 1', 'Identity Level 2'][i] || `Weekly ${id}`,
      t_task: 'Existing task', t_reward: '500 pts',
      // Challenge 9 is the block-production card (#2492): its metric counts
      // blocks, which never reach `user_activities`, so its progress can only
      // come from the snapshot read.
      metric_type: id === 1 ? 'count' : (id === 9 ? 'blocks_produced' : null),
      metric_target: id === 1 ? 3 : (id === 9 ? 500 : null),
      metric_label: id === 9 ? 'blocks' : null,
      event_type: 'season', event_name: 'Current season',
    };
  });
  const done = (id) => (state.counts[id - 1] || 0) >= (id === 1 ? 3 : 1);
  const pool = { query: async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('/* challenge event blocks */')) {
      return { rows: (params[1] || []).map((eventId) => ({ season_event_id: eventId, blocks: state.blocks })) };
    }
    if (sql.startsWith('/* challenge onboarding */')) {
      // No `users` row joins for a signed-out viewer: all three facts NULL.
      return { rows: params[0] === 7
        ? intro(state.counts, state.viewer)
        : intro([0, 0, 0, 0], { gate: null, tour_done: null, unlocked: null }) };
    }
    if (sql.startsWith('UPDATE users SET getting_started_unlocked_at')) {
      assert.deepEqual(params, [7]);
      state.writes += 1;
      if (state.viewer.gate) state.viewer.unlocked = true;
      return { rows: [] };
    }
    // The public list's scoring-cadence read (#3185). No rule scores anything
    // in this fixture, so every card's `scoring` is null.
    if (sql.startsWith('/* challenge scoring cadence */')) return { rows: [] };
    if (sql.includes('SELECT home_panels_hidden FROM users')) return { rows: [{ home_panels_hidden: [] }] };
    if (sql.includes('FROM seasons')) return { rows: [{ id: 2, name: 'Current season', internal: false }] };
    if (sql.startsWith('SELECT id, type, name')) return { rows: [{ id: 10, type: 'season' }, { id: 11, type: 'regular' }] };
    if (sql.startsWith('SELECT id') && sql.includes('FROM season_events')) {
      return { rows: [{ id: params[0], internal: false }] };
    }
    if (sql.includes('FROM challenges c')) {
      // The totals statement counts the open scope and the whole catalog in one
      // pass (#1824), so `AS all_total` is what identifies it now. Nothing here
      // models completion or scheduling windows, so both counts are the same.
      // The row query narrows its WHERE by the gate ($4); the totals statement
      // gates each aggregate ($3) and, only while locked, adds `hidden_count`.
      if (sql.includes('my_activity_count') || sql.includes('AS all_total')) {
        const totals = sql.includes('AS all_total');
        const allowed = totals
          ? (sql.includes('AS hidden_count') ? params[2] : null)
          : (sql.includes('AND c.id = ANY') ? params[3] : null);
        const selected = rows.filter((r) => !allowed || allowed.includes(r.id));
        if (totals) return { rows: [{
          total: selected.length, all_total: selected.length,
          done: selected.filter((r) => done(r.id)).length,
          open_rewards: selected.filter((r) => !done(r.id)).map((r) => r.t_reward),
          ...(allowed ? { hidden_count: rows.length - selected.length } : {}),
        }] };
        return { rows: [...selected].sort((a, b) => Number(done(a.id)) - Number(done(b.id)))
          .slice(0, params[2]).map((r) => ({ ...r, my_done: done(r.id), my_activity_count: 0 })) };
      }
      return { rows: params[0] === 11 ? rows.filter((r) => r.id > 5) : rows };
    }
    // The per-viewer credit count the challenge lists now attach to EVERY
    // challenge, not only the gate's three. `state.credits` maps a challenge
    // id to how many ledger rows the viewer has on it.
    if (sql.includes('FROM user_activities') && /GROUP BY (ua\.)?challenge_id/.test(sql)) {
      const ids = params[1] || [];
      return {
        rows: Object.entries(state.credits || {})
          .filter(([id]) => ids.includes(Number(id)))
          .map(([id, credits]) => ({ challenge_id: Number(id), credits })),
      };
    }
    // The personalised list loads the viewer's rows themselves and counts
    // them in JS, where the public list asks Postgres for the count. Two
    // shapes, one fixture.
    if (sql.includes('FROM user_activities')) {
      const ids = params[1] || [];
      const out = [];
      for (const [id, credits] of Object.entries(state.credits || {})) {
        if (!ids.includes(Number(id))) continue;
        for (let i = 0; i < credits; i += 1) {
          out.push({
            challenge_id: Number(id), points: 100, description: null,
            activity_at: new Date(),
          });
        }
      }
      return { rows: out };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  try {
    for (const [file, factory] of [
      ['topochain/public', 'topochainPublicRoutes'],
      ['topochain/mobile', 'topochainMobileRoutes'],
      ['home-panels', 'homePanelRoutes'],
    ]) {
      const modulePath = require.resolve(`../src/routes/${file}`);
      delete require.cache[modulePath];
      const router = require(modulePath)[factory]({ jwtSecret: 'fixture' });
      for (const layer of router.stack) {
        if (!layer.route?.methods.get) continue;
        const route = layer.route;
        if (['/api/v4/season-events/:seasonEventId/challenges', '/challenges-api/challenges',
          '/api/v4/mobile/challenges', '/api/v4/mobile/seasons', '/api/home-panels'].includes(route.path)) {
          app.get(route.path, route.stack.at(-1).handle);
        }
      }
    }
  } finally { poolModule.getPool = original; }
  return { app, state };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(async (path) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    });
  } finally { server.close(); }
}

test('public, web-session, and mobile lists unlock on the fourth completion', async () => {
  const { app, state } = makeApp([2, 1, 1, 1]);
  await withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges',
      '/challenges-api/challenges?season_id=2', '/api/v4/mobile/challenges?season_id=2']) {
      const locked = await get(path);
      assert.deepEqual(locked.data.map((c) => c.id), [1, 2, 3, 4]);
      assert.equal(locked.onboarding.completed, 3);
      assert.equal(locked.data[0].progress.done, false);
      // The web's event list says how many of its challenges the gate hides
      // and names the first few (the locked placeholder, 2026-10-01). The
      // native lists keep their exact summary shape.
      if (path.startsWith('/api/v4/season-events/')) {
        assert.equal(locked.onboarding.hidden_count, 5);
        assert.deepEqual(locked.onboarding.hidden_names, ['Identity Level 2', 'Weekly 6']);
      } else {
        assert.equal('hidden_count' in locked.onboarding, false, path);
        assert.equal('hidden_names' in locked.onboarding, false, path);
      }
    }
    // Scoped to THIS event: event 11 lists four weekly challenges, all hidden.
    const weekly = await get('/api/v4/season-events/11/challenges');
    assert.deepEqual(weekly.data, []);
    assert.equal(weekly.onboarding.hidden_count, 4);
    assert.equal(state.writes, 0, 'nothing recorded while the list is not done');
    state.counts = [3, 1, 1, 1];
    // The read that finishes the list opens the gate, says so, and records it.
    const opened = await get('/api/v4/season-events/10/challenges');
    assert.equal(opened.data.length, 9);
    assert.equal(opened.onboarding.unlocked, true);
    assert.equal('hidden_count' in opened.onboarding, false);
    assert.equal(state.writes, 1);
    // From then on the account is like any member's: every challenge, and no
    // gate summary, on every list.
    for (const path of ['/api/v4/season-events/10/challenges', '/api/v4/mobile/challenges?season_id=2']) {
      const unlocked = await get(path);
      assert.equal(unlocked.data.length, 9);
      assert.equal('onboarding' in unlocked, false, path);
      const identity = unlocked.data.find((c) => c.id === 5);
      assert.equal(identity.category || identity.activity_type.category, 'PERSISTENT');
      assert.equal(unlocked.data[0].progress.done, true);
    }
    assert.equal(state.writes, 1, 'recorded once');
  });
});

test('the tour holds the gate too: four challenges done, tour not taken, still locked', async () => {
  const { app } = makeApp([3, 1, 1, 1], {}, { viewer: { ...NEWCOMER, tour_done: false } });
  await withServer(app, async (get) => {
    const body = await get('/api/v4/season-events/10/challenges');
    assert.deepEqual(body.data.map((c) => c.id), [1, 2, 3, 4]);
    assert.deepEqual([body.onboarding.completed, body.onboarding.total, body.onboarding.unlocked], [4, 4, false]);
  });
});

test('an existing member and a signed-out visitor see the whole season, with no gate summary', async () => {
  for (const [who, opts] of [
    ['an existing member', { viewer: { gate: false, tour_done: false, unlocked: false } }],
    ['a member who never answered the join screen', { viewer: { gate: false, tour_done: true, unlocked: false } }],
    ['a signed-out visitor', { user: null }],
  ]) {
    const { app, state } = makeApp([0, 0, 0, 0], {}, opts);
    // eslint-disable-next-line no-await-in-loop
    await withServer(app, async (get) => {
      const paths = opts.user === null
        ? ['/api/v4/season-events/10/challenges']
        : ['/api/v4/season-events/10/challenges', '/challenges-api/challenges?season_id=2',
          '/api/v4/mobile/challenges?season_id=2', '/api/home-panels'];
      for (const path of paths) {
        const body = await get(path);
        const list = path === '/api/home-panels'
          ? body.panels.find((p) => p.key === 'challenges') : body;
        const rows = list.challenges || list.data;
        assert.equal(rows.length, 9, `${who}, ${path}: every challenge`);
        assert.equal('onboarding' in list, false, `${who}, ${path}: no gate to explain`);
        // The grouping is everyone's: four First challenges, the fifth always open.
        const fifth = rows.find((c) => c.id === 5);
        assert.equal(fifth.label || fifth.category || fifth.activity_type.category, 'PERSISTENT', `${who}, ${path}`);
      }
      assert.equal(state.writes, 0, `${who}: nothing to record`);
    });
  }
});

test('weekly-event selection and nested seasons cannot skip onboarding', async () => {
  const { app, state } = makeApp();
  await withServer(app, async (get) => {
    const weekly = await get('/api/v4/mobile/challenges?season_event_id=11');
    assert.deepEqual(weekly.data, []);
    assert.equal(weekly.onboarding.event_id, 10);
    const nested = await get('/api/v4/mobile/seasons?season_id=2');
    assert.equal(nested.data[0].season_challenges.length, 4);
    assert.equal(nested.data[0].events[1].challenges.length, 0);
    state.counts = [3, 1, 1, 1];
    const filtered = await get('/api/v4/mobile/seasons?season_id=2&challenge_category=PERSISTENT');
    assert.deepEqual(filtered.data[0].season_challenges.map((c) => c.challenge_id), [5]);
    assert.equal((await get('/api/v4/mobile/challenges?season_event_id=11')).data.length, 4);
  });
});

test('home counts and expanded lists respect the same gate and existing lifetime credits', async () => {
  const { app, state } = makeApp([2, 1, 1, 1]);
  await withServer(app, async (get) => {
    for (const path of ['/api/home-panels', '/api/home-panels?expand=challenges']) {
      const panel = (await get(path)).panels.find((p) => p.key === 'challenges');
      assert.equal(panel.total, 4);
      assert.equal(panel.done, 3);
      assert.equal(panel.points_remaining, 500);
      assert.deepEqual(panel.challenges.map((c) => c.id).sort(), [1, 2, 3, 4]);
      assert.equal(panel.onboarding.hidden_count, 5, path);
    }
    state.counts = [3, 1, 1, 1];
    let panel = (await get('/api/home-panels?expand=challenges')).panels.find((p) => p.key === 'challenges');
    assert.equal(panel.total, 9);
    assert.equal(panel.done, 4);
    assert.equal(panel.onboarding.unlocked, true, 'the opening read still says so');
    assert.equal('hidden_count' in panel.onboarding, false);
    assert.equal(panel.challenges.find((c) => c.id === 5).label, 'PERSISTENT');
    assert.equal(panel.challenges.find((c) => c.id === 1).progress.done, true);
    panel = (await get('/api/home-panels')).panels.find((p) => p.key === 'challenges');
    assert.equal('onboarding' in panel, false, 'and after it, no gate at all');
    assert.equal(panel.challenges.find((c) => c.id === 1).progress.done, true,
      'the lifetime answer still holds for the First challenges');
  });
});

test('a finished challenge outside the gate reports done, not merely started', () => {
  // The lists used to carry progress for the gate's three challenges alone,
  // because nothing credited the others without an admin typing it in. The
  // card reads `progress.done`, so a persistent challenge somebody had
  // finished AND been paid for showed "Started" for good. Automatic scoring
  // makes that the normal state of most of a season, so every challenge now
  // carries the viewer's progress.
  const { app, state } = makeApp([3, 1, 1, 1], { 6: 1, 7: 2 });
  return withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges', '/challenges-api/challenges?season_id=2']) {
      const body = await get(path);
      const byId = new Map(body.data.map((c) => [c.id, c]));
      assert.equal(byId.get(6).progress.done, true, `${path}: a credited weekly challenge is done`);
      assert.equal(byId.get(8).progress.done, false, `${path}: an uncredited one is not`);
    }
    // And the gate's own rows keep the onboarding service's answer.
    const body = await get('/api/v4/season-events/10/challenges');
    assert.equal(body.data.find((c) => c.id === 1).progress.current, 3);
    assert.equal(state.credits[6], 1);
  });
});

test('a block-production card carries the snapshot count, as Home always has (#2492)', () => {
  // The bug: block scores live in leaderboard snapshots and never in the
  // points ledger, so these lists attached no progress at all to a
  // `blocks_produced` challenge and its card drew a ring with nothing beside
  // it — while Home, reading the same snapshot, showed "180/500 blocks" for
  // the very same challenge. The row now carries the count itself.
  const { app, state } = makeApp([3, 1, 1, 1]);
  state.blocks = 180;
  return withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges',
      '/challenges-api/challenges?season_id=2', '/api/v4/mobile/challenges?season_id=2']) {
      const block = (await get(path)).data.find((c) => c.id === 9);
      assert.deepEqual(block.progress, { done: false, current: 180, target: 500 },
        `${path}: counted from the snapshot, not from ledger rows`);
    }
    // Nothing produced yet is still a FACT, which is what lets the card say
    // "Not started" rather than nothing at all.
    state.blocks = 0;
    const none = (await get('/api/v4/season-events/10/challenges')).data.find((c) => c.id === 9);
    assert.deepEqual(none.progress, { done: false, current: 0, target: 500 });
    // And a viewer at or past the target has finished it.
    state.blocks = 500;
    const done = (await get('/api/v4/mobile/challenges?season_id=2')).data.find((c) => c.id === 9);
    assert.deepEqual(done.progress, { done: true, current: 500, target: 500 });
  });
});

test('the snapshot read is one query, and the lists and Home share its SQL (#2492)', async () => {
  const onboarding = require('../src/services/topochain/challenge-onboarding');
  const panels = require('../src/routes/home-panels');
  assert.equal(panels.MY_BLOCKS_SQL, onboarding.NEWEST_EVENT_BLOCKS_SQL,
    'home-panels re-exports the shared subquery rather than keeping a second copy');

  let calls = 0;
  let query = null;
  const pool = { query: async (sql, params) => {
    calls += 1;
    query = { sql: sql.replace(/\s+/g, ' ').trim(), params };
    return { rows: [{ season_event_id: 10, blocks: '42' }, { season_event_id: 11, blocks: null }] };
  } };
  const blocks = await onboarding.loadEventBlocks(pool, 7, [10, 11, 10]);
  assert.equal(calls, 1, 'one query for the whole list, however many events it spans');
  assert.deepEqual(query.params, [7, [10, 11]], 'deduplicated, viewer first');
  assert.ok(query.sql.includes(onboarding.NEWEST_EVENT_BLOCKS_SQL.replace(/\s+/g, ' ')),
    'and it runs the same subquery Home embeds');
  assert.deepEqual([...blocks], [[10, 42], [11, null]]);

  // A signed-out viewer, or a list with no block card on it, asks nothing.
  calls = 0;
  assert.equal((await onboarding.loadEventBlocks(pool, null, [10])).size, 0);
  assert.equal((await onboarding.loadEventBlocks(pool, 7, [])).size, 0);
  assert.equal(calls, 0);
});
