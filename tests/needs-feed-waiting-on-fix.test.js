'use strict';

// #6389: a change the viewer made, whose votes are in but whose tests fail or
// which conflicts with main, waits on their fix. The Needs you row says what
// it waits on instead of Vote. First for a change a coding agent submitted;
// every change since proposing stopped being its author's yes (11 Nov 2026).
//
// Run with: node --test tests/needs-feed-waiting-on-fix.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const overview = require('../src/routes/workshop-overview');

const row = (over = {}) => ({
  kind: 'proposal', id: 6358, app_id: 1, author_id: 42, external_agent: 'claude-code',
  yes: 1, votes_required: 1, other_yes: 1, requires_explicit_approval: false,
  check_state: 'passing', mergeability: 'clean', integration_merges_clean: true,
  merge_conflict_state: null, ...over,
});

test('#6389: waitingOnFix names tests failing, then a conflict, once the vote is in', () => {
  assert.deepEqual(overview.waitingOnFix(row({ check_state: 'failing' }), 42), ['checks']);
  assert.deepEqual(overview.waitingOnFix(row({ mergeability: 'conflict' }), 42), ['conflict']);
  assert.deepEqual(overview.waitingOnFix(row({ integration_merges_clean: false }), 42), ['conflict']);
  assert.deepEqual(overview.waitingOnFix(row({ merge_conflict_state: 'failed' }), 42), ['conflict']);
  assert.deepEqual(overview.waitingOnFix(row({ merge_conflict_state: 'conflict' }), 42), ['conflict']);
  assert.deepEqual(overview.waitingOnFix(row({ check_state: 'failing', mergeability: 'conflict' }), 42), ['checks', 'conflict']);
});

test('#6389: while the gate is not met the row is still a Vote', () => {
  assert.equal(overview.waitingOnFix(row({ yes: 0, check_state: 'failing' }), 42), null);
  assert.equal(overview.waitingOnFix(row({ check_state: 'failing' }), 7), null, 'somebody else\'s change');
  assert.deepEqual(overview.waitingOnFix(row({ external_agent: null, check_state: 'failing' }), 42), ['checks'],
    'one made on Homeroom waits on its fix the same way');
});

test('#6389: an explicit approval needs a Yes from another member', () => {
  const flagged = row({ requires_explicit_approval: true, other_yes: 0, check_state: 'failing' });
  assert.equal(overview.waitingOnFix(flagged, 42), null, 'its author\'s own Yes is not the member Yes');
  assert.deepEqual(overview.waitingOnFix({ ...flagged, other_yes: 1 }, 42), ['checks']);
});

test('#6389: with its votes in and nothing left to fix, the row leaves Needs you', () => {
  const met = row();
  assert.equal(overview.authorGateMet(met, 42), true);
  assert.equal(overview.authorGateMet({ ...met, external_agent: null }, 42), true, 'made on Homeroom too');
  assert.equal(overview.waitingOnFix(met, 42), null, 'nothing is left for them to fix');
});

test('#6389: the shaped row carries waitingOn and the tool it was made in', () => {
  const [item] = overview.shapeNeedsFeed([{
    ...row({ check_state: 'failing' }), waiting_on: ['checks'], slug: 'usernode',
    name: 'Homeroom', title: 'Guard apps', number: 6358, author: 'evan',
  }]);
  assert.deepEqual(item.waitingOn, ['checks']);
  assert.equal(item.agent, 'claude-code');
  const [plain] = overview.shapeNeedsFeed([{
    ...row(), waiting_on: null, slug: 'usernode', name: 'Homeroom', title: 'Plain', number: 1, author: 'evan',
  }]);
  assert.ok(!('waitingOn' in plain), 'a row that does not wait on a fix keeps its Vote');
  assert.ok(!('agent' in plain));
});
