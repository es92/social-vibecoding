// No gap without pictures after a new commit (18 Nov 2026). In 7 days 168
// finished shots runs on Homeroom's own app were replaced because the head
// moved, against 115 current passing ones, and every move hid the shots the
// card showed at once: the change page had no picture until the new head's
// run published, about seven minutes later, or never when it failed.
//
// Now the shots people last saw stay on the slot as the previous version's
// (shots_detail.previous) until the new head's publish, and a clean merge of
// main carries published shots onto the merged head as its checks' green
// verdict carries (the proposal machine's MECHANICAL_MOVES).
//
// The transitions and the domain writes, without a database (a fake
// transaction answers the writes' reads); the view and the card are pinned
// in tests/shots-view.test.js, tests/shots-ui.test.js and
// tests/needs-you-change-page.test.js.
//
// Run with: node --test tests/shots-previous-version.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shots, MECHANICAL_MOVES } = require('../src/workflow/shots/machine.ts');
const { NONE } = require('../src/workflow/kernel/index.ts');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHA = (c) => c.repeat(40);
const RUN = 'a'.repeat(32);
const OLD_RUN = 'b'.repeat(32);
const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const ctx = { now: new Date('2026-11-18T12:00:00Z'), key: 'session:42', version: 3 };

function published(head = SHA('1')) {
  return { name: 'published', data: {
    sessionId: 42, appId: 10, appSlug: 'usernode-2d5619', declared: { intent: { version: 1, stories: [] }, required: true },
    head, run: null, last: null, n: 2, cleaning: [],
  } };
}
const facts = ({ slotState = 'verified', runState = 'verified', runHead = SHA('1'), head = SHA('2') } = {}) => ({ session: {
  id: 42, appId: 10, appSlug: 'usernode-2d5619', status: 'promoted', source: null, head,
  pins: { imported: null, reviewed: head, handoff: null }, readyHeads: [head], agentBusy: false,
  slot: { state: slotState, runId: RUN, detail: { headSha: runHead }, run: { id: RUN, state: runState, head: runHead, failureCode: null } },
  temporaryWorker: false,
} });
const moved = (reason, head = SHA('2')) => ({ id: 9, type: 'HeadMoved', payload: { sessionId: 42, head, reason, pin: 'reviewed', from: null },
  source: { kind: 'message', from: { machine: 'proposal', key: 'session:42' } } });
const apply = (s, e, f) => machine.entryFor(s.name, e.type).to(s, e, f, ctx);

test('a clean merge of main carries published shots onto the merged head: no run is taken again', () => {
  assert.deepEqual([...MECHANICAL_MOVES].sort(), ['imported_head_mechanical', 'mechanical']);
  for (const reason of MECHANICAL_MOVES) {
    const out = apply(published(), moved(reason), facts());
    assert.equal(out.next.name, 'published', `${reason}: the shots stand`);
    assert.equal(out.next.data.head, SHA('2'), 'for the merged head');
    assert.equal(out.next.data.run, null, 'no run starts');
    const carried = out.writes.find((w) => w.type === 'carried');
    assert.deepEqual(carried, { type: 'carried', sessionId: 42, from: SHA('1'), head: SHA('2') });
    assert.ok(!out.writes.some((w) => w.type === 'declared'), 'the slot is not reset');
    assert.ok(out.writes.some((w) => w.type === 'botChange'), 'whoever waits hears it settled on the new head');
  }
  // The proposal machine's own constant is the same set.
  assert.match(read('src/workflow/proposal/machine.ts'),
    /const MECHANICAL_MOVES: ReadonlySet<string> = new Set\(\['mechanical', 'imported_head_mechanical'\]\);/);
});

test('anything else moves the slot as before: new code, a resolution, or shots that were not published', () => {
  for (const reason of [null, 'authored', 'resolved', 'unknown']) {
    const out = apply(published(), moved(reason), facts());
    assert.equal(out.next.name, 'waiting_for_preview', `${reason}: shot again`);
    assert.equal(out.writes[0].type, 'declared');
    assert.equal(out.writes[0].keepHead, true);
  }
  // A failed slot, or a slot whose row no longer says it published.
  const failed = { ...published(), name: 'failed' };
  assert.equal(apply(failed, moved('mechanical'), facts({ slotState: 'failed', runState: 'failed' })).next.name, 'waiting_for_preview');
  assert.equal(apply(published(), moved('mechanical'), facts({ slotState: 'planned' })).next.name, 'waiting_for_preview');
  // A move from another head than the one the shots stand for.
  const other = moved('mechanical');
  other.payload.from = SHA('9');
  assert.equal(apply(published(), other, facts()).next.name, 'waiting_for_preview');
});

test('the merged head being ready takes nothing again, and a first event adopts the carried head', () => {
  const out = apply(published(), moved('mechanical'), facts());
  const ready = { id: 10, type: 'HeadReady', payload: { sessionId: 42, head: SHA('2') },
    source: { kind: 'message', from: { machine: 'preview', key: 'session:42' } } };
  const after = apply(out.next, ready, facts());
  assert.equal(after.next, out.next, 'its preview being ready changes nothing');
  // From the row alone (the instance's first event): the carried slot names
  // the merged head, so the same HeadReady starts nothing.
  const f = facts();
  f.session.slot.detail = { headSha: SHA('2'), carriedFrom: SHA('1'), required: true,
    intent: { version: 1, impact: 'ui', stories: [{ id: 'x' }] } };
  const first = machine.entryFor(NONE, 'HeadReady').to({ name: NONE, data: null }, ready, f, ctx);
  assert.equal(first.next.name, 'published');
  assert.equal(first.next.data.head, SHA('2'));
  assert.equal(first.next.data.run, null, 'no run starts');
});

// A transaction that answers the writes' reads from a fixed row.
function fakeTx(slot) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM chat_sessions cs LEFT JOIN shot_runs r ON r\.id = cs\.shots_run_id/.test(sql)) return { rows: slot.declaredRead ? [slot.declaredRead] : [] };
      if (/SELECT \* FROM shot_runs WHERE id = \$1/.test(sql)) return { rows: slot.run ? [slot.run] : [] };
      if (/FROM chat_sessions WHERE id = \$1 AND shots_run_id = \$2/.test(sql)) return { rows: slot.showRead ? [slot.showRead] : [] };
      if (/FROM shot_artifacts WHERE run_id/.test(sql)) return { rows: [] };
      if (/SELECT cs\.app_id, a\.slug/.test(sql)) return { rows: [{ app_id: 10, slug: 'usernode-2d5619' }] };
      return { rows: [], rowCount: 1 };
    },
  };
}
const pushes = [];
const writeCtx = { push: (p) => pushes.push(p) };
const write = (type) => machine.writes.get(type);
const storedDetail = (tx) => {
  const update = tx.calls.find((c) => /^UPDATE chat_sessions SET shots_state = \$2/.test(c.sql));
  return update ? JSON.parse(update.params[2]) : null;
};
const declared = (head, state = 'planned') => ({ type: 'declared', sessionId: 42, head, keepHead: true, state,
  detail: { headSha: head, required: state !== 'not_required' }, cancelCode: 'superseded', cancelReason: 'x' });

test('a head move keeps the shots people last saw as the previous version\'s', async () => {
  // The slot showed shots published on the head it leaves.
  const tx = fakeTx({ declaredRead: { previous: null, run_id: RUN, run_state: 'verified', head_sha: SHA('1'), slot_head: SHA('1') } });
  await write('declared')(tx, declared(SHA('2')), writeCtx);
  assert.deepEqual(storedDetail(tx).previous, { runId: RUN, headSha: SHA('1') });
  assert.equal(storedDetail(tx).headSha, SHA('2'));
  // The read happens before the runs of other heads go stale.
  const order = tx.calls.map((c) => c.sql.slice(0, 40));
  assert.ok(order.findIndex((s) => s.startsWith('SELECT cs.shots_detail->\'previous\'')) < order.findIndex((s) => s.startsWith('UPDATE shot_runs')));

  // A second move before the new head's shots publish keeps the same ones.
  const again = fakeTx({ declaredRead: { previous: { runId: RUN, headSha: SHA('1') }, run_id: null, run_state: null, head_sha: null, slot_head: SHA('2') } });
  await write('declared')(again, declared(SHA('3')), writeCtx);
  assert.deepEqual(storedDetail(again).previous, { runId: RUN, headSha: SHA('1') });

  // Shots carried across a merge of main are kept by the run they were taken on.
  const carried = fakeTx({ declaredRead: { previous: null, run_id: RUN, run_state: 'verified', head_sha: SHA('1'), slot_head: SHA('2') } });
  await write('declared')(carried, declared(SHA('3')), writeCtx);
  assert.deepEqual(storedDetail(carried).previous, { runId: RUN, headSha: SHA('1') });
});

test('nothing is kept for the same head, a declaration that needs no shots, or shots that never published', async () => {
  const same = fakeTx({ declaredRead: { previous: null, run_id: RUN, run_state: 'verified', head_sha: SHA('1'), slot_head: SHA('1') } });
  await write('declared')(same, { ...declared(SHA('1')), keepHead: false }, writeCtx);
  assert.equal(storedDetail(same).previous, undefined, 'a new declaration of this version is not its previous version');
  const none = fakeTx({ declaredRead: { previous: { runId: RUN, headSha: SHA('1') }, run_id: null, run_state: null, head_sha: null, slot_head: null } });
  await write('declared')(none, declared(SHA('2'), 'not_required'), writeCtx);
  assert.equal(storedDetail(none).previous, undefined, 'nothing visible: no picture to keep');
  const failed = fakeTx({ declaredRead: { previous: null, run_id: RUN, run_state: 'failed', head_sha: SHA('1'), slot_head: SHA('1') } });
  await write('declared')(failed, declared(SHA('2')), writeCtx);
  assert.equal(storedDetail(failed).previous, undefined, 'a failed run has no pictures');
  const back = fakeTx({ declaredRead: { previous: { runId: OLD_RUN, headSha: SHA('2') }, run_id: null, run_state: null, head_sha: null, slot_head: null } });
  await write('declared')(back, declared(SHA('2')), writeCtx);
  assert.equal(storedDetail(back).previous, undefined, 'a head the kept shots are of is not their next version');
});

function runRow(state, head = SHA('2')) {
  return { id: OLD_RUN, session_id: 42, state, head_sha: head, base_sha: SHA('0'), intent: { version: 1, stories: [] },
    trace_summary: null, hard_verdict: null, failure_code: state === 'failed' ? 'shots_capture_incomplete' : null };
}
const shownDetail = (tx) => {
  const update = tx.calls.find((c) => /^UPDATE chat_sessions SET shots_state = \$2, shots_run_id = \$3/.test(c.sql));
  return update ? JSON.parse(update.params[3]) : null;
};

test('the run of the new head carries the previous version\'s shots until its own publish', async () => {
  const kept = { runId: RUN, headSha: SHA('1') };
  for (const state of ['provisioning', 'exploring', 'reviewing', 'failed', 'overridden']) {
    const tx = fakeTx({ run: runRow(state), showRead: { previous: kept, carried_from: null, head: SHA('2') } });
    await write('runMoved')(tx, { type: 'runMoved', runId: OLD_RUN, state, patch: {} }, writeCtx);
    assert.deepEqual(shownDetail(tx).previous, kept, `${state}: still shown`);
  }
  const done = fakeTx({ run: runRow('verified'), showRead: { previous: kept, carried_from: null, head: SHA('2') } });
  await write('runMoved')(done, { type: 'runMoved', runId: OLD_RUN, state: 'verified', patch: {} }, writeCtx);
  assert.equal(shownDetail(done).previous, undefined, 'its own published: the previous version\'s go');
});

test('a carried run keeps the merged head on the slot, and the carry names the run it was taken on', async () => {
  const tx = fakeTx({ run: runRow('verified', SHA('1')), showRead: { previous: null, carried_from: SHA('1'), head: SHA('2') } });
  await write('runMoved')(tx, { type: 'runMoved', runId: OLD_RUN, state: 'verified', patch: {} }, writeCtx);
  assert.equal(shownDetail(tx).headSha, SHA('2'));
  assert.equal(shownDetail(tx).carriedFrom, SHA('1'));

  const carry = fakeTx({});
  await write('carried')(carry, { type: 'carried', sessionId: 42, from: SHA('1'), head: SHA('2') }, writeCtx);
  const sql = carry.calls[0].sql;
  assert.match(sql, /jsonb_build_object\('headSha', \$2::text, 'carriedFrom', r\.head_sha\)/);
  assert.match(sql, /r\.state = 'verified' AND cs\.shots_state = 'verified'/);
  assert.doesNotMatch(sql, /shots_updated_at/, 'how long the slot has waited is left alone');
  assert.deepEqual(carry.calls[0].params, [42, SHA('2')]);
});

test('the readers follow: the artifact route, the public stills and the keeping of files', () => {
  const route = read('src/routes/shots.js');
  assert.match(route, /OR r\.head_sha = s\.shots_detail->>'carriedFrom'\)\)/);
  assert.match(route, /OR \(r\.id = s\.shots_detail->'previous'->>'runId'\s+AND s\.shots_state IS DISTINCT FROM 'verified'\s+AND r\.state IN \('verified', 'stale'\)\)\)/);
  const pub = read('src/services/shots-public.js');
  assert.match(pub, /OR \(r\.head_sha = s\.shots_detail->>'carriedFrom'/);
  assert.equal(pub.match(/AND \$\{AT_HEAD\}/g).length, 2, 'open and merged changes alike');
  const gc = read('src/services/shots-gc.js');
  assert.match(gc, /WHERE s\.id = r\.session_id AND s\.shots_detail->'previous'->>'runId' = r\.id/);
  assert.match(gc, /OR \(s\.id = r\.session_id AND s\.shots_detail->'previous'->>'runId' = r\.id\)/);
});
