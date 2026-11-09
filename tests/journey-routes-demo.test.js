'use strict';

// Under staging with ?demo=1 every admin Journey route answers a whole,
// labelled demo payload (#3369), in the same shape as the real one: the
// top-level keys pinned in tests/fixtures/journey-route-shapes.json, which
// tests/journey-routes.test.js checks the real payloads against.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'journey-route-shapes.json'), 'utf8'));

require('../src/db/pool').getPool = () => ({
  async query() { throw new Error('a demo answer must not read the database'); },
  async connect() { throw new Error('a demo answer must not read the database'); },
});
const express = require('express');
const { adminRoutes } = require('../src/routes/admin');

test('every Journey route has a labelled demo payload with the real shape', async (t) => {
  const appX = express();
  appX.use((req, _res, next) => { req.user = { id: 1, username: 'lead', isAdmin: true }; next(); });
  appX.use(adminRoutes({ jwtSecret: 'test' }));
  const server = appX.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paths = {
    summary: '/api/admin/journey/summary',
    cohorts: '/api/admin/journey/cohorts',
    firstMile: '/api/admin/journey/first-mile?admitted=2026-10-05',
    stages: '/api/admin/journey/stages',
    loops: '/api/admin/journey/loops',
    nextSteps: '/api/admin/journey/next-steps',
    person: '/api/admin/journey/people/900102',
    leftOut: '/api/admin/journey/left-out',
    creation: '/api/admin/journey/creation',
    pairs: '/api/admin/journey/pairs',
    firstSession: '/api/admin/journey/first-session',
  };
  for (const [key, p] of Object.entries(paths)) {
    const res = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}demo=1`);
    assert.equal(res.status, 200, key);
    const body = await res.json();
    assert.equal(body.demo, true, `${key} says it is a demo`);
    const keys = Object.keys(body).filter((k) => k !== 'demo').sort();
    assert.deepEqual(keys, Object.keys(pinned[key]).sort(), `${key}: same top-level keys as the real payload`);
  }
  // The first mile's onboard column: the first-run list as x of n per
  // person, none for the one stuck before the join screen, nothing without
  // an account.
  const mile = await (await fetch(`${base}/api/admin/journey/first-mile?admitted=2026-10-05&demo=1`)).json();
  assert.deepEqual(mile.people.map((p) => p.onboard && (p.onboard.shown ? `${p.onboard.done}/${p.onboard.total}` : 'no card')),
    ['3/5', '1/5', 'no card', null]);
  // #6540: where the cohort came from, counted once each by the earlier way
  // in, and each person's own two records.
  assert.deepEqual(mile.sources, [
    { way: 'invite', from: 'discord.com', people: 2 },
    { way: 'invite', from: 'none', people: 1 },
    { way: 'unknown', from: null, people: 1 },
  ]);
  assert.equal(mile.people[1].cameFrom.invite.referrerHost, 'discord.com');
  assert.equal(mile.people[1].cameFrom.waitlist.referrerHost, 'none');
  assert.equal((await (await fetch(`${base}/api/admin/journey/people/900102?demo=1`)).json()).cameFrom.invite.via, 'copied');
  const loops = await (await fetch(`${base}/api/admin/journey/loops?demo=1`)).json();
  assert.deepEqual(loops.change.atStep.hear_back, { status: 'coming' }, 'Hear back is coming in the demo too');

  // The demo keeps the real-person rule: the test account on its left-out
  // list is in none of its readings.
  const left = (await (await fetch(`${base}/api/admin/journey/left-out?demo=1`)).json()).people;
  assert.ok(left.some((p) => p.reason === 'test'));
  const named = JSON.stringify([
    await (await fetch(`${base}/api/admin/journey/stages?demo=1`)).json(),
    await (await fetch(`${base}/api/admin/journey/summary?demo=1`)).json(),
    loops,
  ]);
  for (const p of left) assert.equal(named.includes(`"userId":${p.userId}`), false, `${p.username} is left out of the demo`);

  // The creation path and the pairs narrow by cohort and by "all time" the
  // way the real readings do, and say "not recorded" before their records.
  const creation = await (await fetch(`${base}/api/admin/journey/creation?demo=1`)).json();
  assert.deepEqual(creation.steps.map((x) => [x.key, x.reached, x.of]),
    [['created', 5, 5], ['running', 5, 5], ['first_version', 3, 5], ['preview', 3, 5], ['change_live', 1, 5]]);
  assert.equal(creation.weeks.length, 8);
  assert.equal(creation.weeks[0].steps.find((x) => x.key === 'running').reached.recorded, false,
    'a week before the record began reads "not recorded", never 0');
  // #4895: where the time to running went, per stage and per newest project.
  assert.equal(creation.timing.of, 5);
  assert.equal(creation.timing.stages.find((x) => x.key === 'build').medianMs, 69000);
  assert.ok(creation.examples.every((x) => x.timing && x.timing.stages.build > 0));
  const cohort = await (await fetch(`${base}/api/admin/journey/creation?demo=1&cohort=2026-10-05`)).json();
  assert.ok(cohort.examples.every((x) => [900101, 900102, 900103].includes(x.userId)), 'a cohort narrows the examples');
  const allTime = await (await fetch(`${base}/api/admin/journey/creation?demo=1&week=all`)).json();
  assert.equal(allTime.week, 'all');
  const pairs = await (await fetch(`${base}/api/admin/journey/pairs?demo=1`)).json();
  assert.deepEqual([pairs.count, pairs.of, pairs.open, pairs.trend.length], [2, 4, 1, 8]);
  assert.ok(pairs.examples.every((x) => x.pair.length === 2 && ['invite', 'members'].includes(x.via)));
  const cohortPairs = await (await fetch(`${base}/api/admin/journey/pairs?demo=1&cohort=2026-09-24`)).json();
  assert.ok(cohortPairs.of <= pairs.of && cohortPairs.trend.every((t) => t.count <= t.of));
  assert.equal((await fetch(`${base}/api/admin/journey/pairs?demo=1&cohort=x`)).status, 400);

  // The invite funnel's sign-ins in their two ways (#4272), so the split
  // draws in a staging preview, its conversion past FUNNEL_RATE_FROM opens.
  const first = await (await fetch(`${base}/api/admin/journey/first-session?demo=1`)).json();
  assert.deepEqual([first.opens.opened, first.opens.signedIn, first.opens.signedInByInvite, first.opens.signedInAlready],
    [11, 5, 3, 2]);
  const firstAll = (await (await fetch(`${base}/api/admin/journey/first-session?demo=1&week=all`)).json()).opens;
  assert.equal(firstAll.signedInByInvite + firstAll.signedInAlready, firstAll.signedIn);
  assert.ok(firstAll.joined <= firstAll.signedIn && firstAll.signedIn <= firstAll.opened);
});
