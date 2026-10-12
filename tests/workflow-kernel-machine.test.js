'use strict';

// defineMachine's table validation and the kernel's pure helpers
// (src/workflow/kernel/machine.ts). No database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { defineMachine, NONE, ok, reject, canonicalHash } = require('../src/workflow/kernel/index.ts');
const { Signals } = require('../src/workflow/kernel/stream.ts');

const base = () => ({
  name: 'kt-valid',
  version: 1,
  events: { Open: (p) => p, Close: (p) => p },
  create: ['Open'],
  terminal: ['closed'],
  decode: (row) => ({ name: row.state, data: row.data }),
  authorize: { Open: () => ok(), Close: () => ok() },
  transitions: {
    [NONE]: { Open: { to: () => ({ next: { name: 'open', data: {} } }) } },
    open: { Open: { ignore: 'already_open' }, Close: { to: () => ({ next: { name: 'closed', data: {} } }) } },
    closed: { '*': { ignore: 'closed' } },
  },
});

test('a complete table defines a machine', () => {
  const m = defineMachine(base());
  assert.deepEqual([...m.states], ['open', 'closed']);
  assert.ok(m.events instanceof Map && m.transitions.get('open') instanceof Map, 'tables are Maps once defined');
  assert.deepEqual(m.entryFor('closed', 'Close'), { ignore: 'closed' });
  assert.deepEqual(m.entryFor(NONE, 'Close'), { ignore: 'no_instance' });
  // Work results are kernel events: a state that does not list them refuses them,
  // even under a wildcard ignore.
  assert.deepEqual(m.entryFor('closed', 'WorkSucceeded'), { ignore: 'unexpected_work_result' });
});

test('every state must handle or ignore every declared event', () => {
  const def = base();
  delete def.transitions.open.Open;
  assert.throws(() => defineMachine(def), /state open neither handles nor ignores Open/);
});

test('every declared event needs an authorize rule', () => {
  const def = base();
  delete def.authorize.Close;
  assert.throws(() => defineMachine(def), /no authorize rule for Close/);
});

test('table entries name declared events and states, and creating events start from (none)', () => {
  const unknown = base();
  unknown.transitions.open.Reopen = { to: () => ({}) };
  assert.throws(() => defineMachine(unknown), /undeclared event/);
  const noCreate = base();
  noCreate.transitions[NONE] = {};
  assert.throws(() => defineMachine(noCreate), /creating event Open has no transition/);
  const stray = base();
  stray.transitions[NONE].Close = { to: () => ({}) };
  assert.throws(() => defineMachine(stray), /not listed in create/);
  const terminal = base();
  terminal.terminal = ['gone'];
  assert.throws(() => defineMachine(terminal), /terminal state gone/);
  const kernelEvent = base();
  kernelEvent.events.WorkSucceeded = (p) => p;
  assert.throws(() => defineMachine(kernelEvent), /kernel event/);
  const noTo = base();
  noTo.transitions.open.Close = { guard: () => ok() };
  assert.throws(() => defineMachine(noTo), /neither `to` nor `ignore`/);
});

test('work results are authorised only from the service that ran the work', () => {
  const m = defineMachine(base());
  const event = (source) => ({ type: 'WorkSucceeded', payload: { workId: 'w1' }, source });
  assert.equal(m.check(event({ kind: 'service', workId: 'w1' }), undefined, {}), true);
  assert.deepEqual(m.check(event({ kind: 'service', workId: 'w2' }), undefined, {}), reject('not_a_service_result'));
  assert.deepEqual(m.check(event({ kind: 'route' }), undefined, {}), reject('not_a_service_result'));
});

test('the payload hash is canonical: key order does not matter, values do', () => {
  assert.equal(canonicalHash({ a: 1, b: { c: [1, 2], d: null } }), canonicalHash({ b: { d: null, c: [1, 2] }, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
  assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
});

test('inherited object keys are not events, rules or table entries', () => {
  const m = defineMachine(base());
  for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(m.events.has(type), false, type);
    assert.deepEqual(m.check({ type, payload: {}, source: { kind: 'route' } }, undefined, {}), reject('unknown_event'), type);
    assert.deepEqual(m.entryFor('open', type), { ignore: 'unknown_event' }, type);
  }
  assert.deepEqual(m.entryFor(NONE, 'toString'), { ignore: 'no_instance' });
});

test('an event notification wakes one sleeping slot, and is kept when none sleeps', async () => {
  const signals = new Signals({ connect: async () => { throw new Error('no database'); } }, { info() {}, warn() {}, error() {} });
  const woken = [];
  const slot = (n) => signals.sleep('wf_events', 5000).then(() => woken.push(n));
  const sleepers = [slot(1), slot(2)];
  signals.wake('wf_events', 'kt-counter');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(woken, [1], 'one slot, not every slot');
  signals.wake('wf_events', 'kt-counter');
  await Promise.all(sleepers);
  assert.deepEqual(woken, [1, 2]);
  // Nobody asleep: the next slot to sleep does not sleep through it.
  signals.wake('wf_events', 'kt-counter');
  const started = Date.now();
  await signals.sleep('wf_events', 5000);
  assert.ok(Date.now() - started < 100, 'the kept notification wakes it at once');
  // Other channels still wake everyone waiting on them.
  const outcomes = [signals.sleep('wf_outcome:7', 5000), signals.sleep('wf_outcome:7', 5000)];
  signals.wake('wf_outcome', '7');
  await Promise.all(outcomes);
  await signals.stop();
});

test('a sleeper can take only the notifications it wants', async () => {
  const signals = new Signals({ connect: async () => { throw new Error('no database'); } }, { info() {}, warn() {}, error() {} });
  let woke = false;
  const until = Date.now() + 5000;
  const sleeping = signals.sleep('wf_timer', 5000, (payload) => Number(payload) < until).then(() => { woke = true; });
  signals.wake('wf_timer', String(until + 60000));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(woke, false, 'a later deadline does not wake it');
  signals.wake('wf_timer', String(until - 1000));
  await sleeping;
  // Losing or regaining the connection wakes every sleeper, filter or not.
  const filtered = signals.sleep('wf_timer', 5000, () => false);
  signals.wakeAll();
  await filtered;
  await signals.stop();
});

// The LISTEN connection goes back to the pool once. A listener of ours left
// on it after stop() released it again when the idle connection errored (a
// test database dropped under it), and pg-pool throws on that, from inside
// the connection's error event.
test('the signal connection is released once, after stop() and after a lost connection alike', async () => {
  const { EventEmitter } = require('node:events');
  const fakeClient = () => {
    const client = new EventEmitter();
    client.releases = 0;
    client.query = async () => {};
    client.release = () => {
      client.releases += 1;
      if (client.releases > 1) throw new Error('Release called on client which has already been released to the pool.');
      // pg-pool watches an idle connection's errors itself.
      client.on('error', () => {});
    };
    return client;
  };
  const log = { info() {}, warn() {}, error() {} };

  const stopped = fakeClient();
  const signals = new Signals({ connect: async () => stopped }, log);
  await signals.start();
  assert.equal(signals.listening, true);
  await signals.stop();
  stopped.emit('error', new Error('terminating connection due to administrator command'));
  assert.equal(stopped.releases, 1, 'an error on the idle connection is the pool\'s');
  assert.equal(stopped.listenerCount('notification'), 0);

  const lost = fakeClient();
  const again = new Signals({ connect: async () => lost }, log);
  await again.start();
  lost.emit('error', new Error('connection terminated'));
  lost.emit('error', new Error('connection terminated, again'));
  assert.equal(lost.releases, 1, 'a connection that reports two errors goes back once');
  assert.equal(again.listening, false);
  await again.stop();
  assert.equal(lost.releases, 1);
});
