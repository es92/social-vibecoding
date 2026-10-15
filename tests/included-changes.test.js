'use strict';

// A change that went live inside another one (services/included-changes.js).
//
// Flat 4B Chores, 5 Oct 2026: the Homeroom bot built the project's first
// version (PR 3) and, asked in the group chat to fix it, built the fix (PR 8)
// on PR 3's branch. PR 8 merged, squashed, with PR 3's commit in it. PR 3
// stayed open and kept asking for votes, request #1 stayed open, and the App
// tab kept saying the first version was being built over the live app.
//
// Now, when a change merges, every other change of the app up for a vote
// whose head commit is one of the merged pull request's own commits is
// marked merged as included in it, and what a merge does for a change is
// done for it. These tests pin the decision and the side effects with the
// database and GitHub stubbed; tests/included-changes-postgres.test.js runs
// it against the real schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const included = require('../src/services/included-changes');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const H3 = '3'.repeat(40);
const H5 = '5'.repeat(40);
const H8 = '8'.repeat(40);

const MERGED = {
  id: 6288, app_id: 41, pr_number: 8, pr_title: 'Fix mark as done in Jordan’s first version',
  repo_url: 'https://github.com/usernode-bot/flat-4b-chores-e98ecd', app_slug: 'flat-4b-chores-e98ecd',
  reviewed_head_sha: H8, status: 'merged',
};
const PR3 = {
  id: 6269, app_id: 41, user_id: 9, pr_number: 3, pr_title: 'First version of Flat 4B Chores',
  repo_url: MERGED.repo_url, app_slug: MERGED.app_slug, linked_issues: [1], status: 'merged',
  included_in_session_id: 6288,
};

function fakePool(handlers) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          const out = typeof rows === 'function' ? rows(params) : rows;
          return { rows: out, rowCount: out.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Every module the settle step touches, recording what it was asked.
function stubs({ commits = [H3, H8], listFails = false, busy = [] } = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args.filter((a) => !(a && typeof a.query === 'function'))]); return Promise.resolve(true); };
  const deps = {
    github: {
      isEnabled: () => true,
      listPullRequestCommitShas: async (owner, repo, n) => {
        calls.push(['listPullRequestCommitShas', owner, repo, n]);
        if (listFails) throw new Error('GitHub is down');
        return { shas: commits, complete: true };
      },
      createIssueComment: rec('createIssueComment'),
      closePR: rec('closePR'),
      closeIssue: rec('closeIssue'),
      noteIssuesClosed: (...args) => { calls.push(['noteIssuesClosed', ...args]); },
      unsuppressIssues: (...args) => { calls.push(['unsuppressIssues', ...args]); },
    },
    ws: { sendSystemMessage: rec('sendSystemMessage'), pushVoteUpdate: (data) => { calls.push(['pushVoteUpdate', data]); } },
    staging: { teardownStaging: rec('teardownStaging') },
    worker: { retireWorker: rec('retireWorker') },
    notifications: {
      createPrMergedNotification: async (_pool, args) => { calls.push(['createPrMergedNotification', args]); return []; },
      createVotedChangeMergedNotifications: async (_pool, args) => { calls.push(['createVotedChangeMergedNotifications', args]); return []; },
      hydrateAndPush: rec('hydrateAndPush'),
    },
    agentSessions: { noteChangeClosed: rec('noteChangeClosed') },
    bot: { noteRequestMerged: rec('noteRequestMerged') },
    dm: { noteProposalMerged: rec('noteProposalMerged') },
    journey: { recordChangeLive: rec('recordChangeLive') },
    watcher: {
      bustAndBroadcast: (args) => { calls.push(['bustAndBroadcast', args]); },
      closeTwinRows: (args) => { calls.push(['closeTwinRows', { appId: args.appId, numbers: args.numbers }]); },
      resolveSupersededProposals: (args) => { calls.push(['resolveSupersededProposals', { appId: args.appId, numbers: args.numbers }]); },
      withdrawBotProposals: (args) => { calls.push(['withdrawBotProposals', { appId: args.appId, numbers: args.numbers }]); },
    },
    isSessionBusy: (id) => busy.includes(id),
    resolveIssueBounty: async (_pool, args) => { calls.push(['resolveIssueBounty', args]); return { awarded: [], voided: [] }; },
  };
  return { deps, calls };
}

function poolFor({ candidates, marked = null } = {}) {
  return fakePool([
    [/FROM chat_sessions cs\s+WHERE cs\.app_id = \$1 AND cs\.id <> \$2/, candidates || []],
    [/UPDATE chat_sessions c\s+SET status = 'merged'/, (params) => (marked || params[1]).map((id) => ({ id }))],
    [/included_in_session_id = \$2/, () => [PR3]],
  ]);
}

test('containedIn: a head on the merged pull request\'s commits, and nothing else', () => {
  const candidates = [
    { id: 1, source: 'native', reviewed_head_sha: H3 },
    { id: 2, source: 'native', reviewed_head_sha: H5 },
    { id: 3, source: 'imported', imported_pr_head_sha: H3.toUpperCase(), reviewed_head_sha: null },
    { id: 4, source: 'native', reviewed_head_sha: null },
    { id: 5, source: 'native', reviewed_head_sha: 'not-a-sha' },
  ];
  assert.deepEqual(included.containedIn(candidates, [H8, H3]).map((c) => c.id), [1, 3],
    'native by its reviewed head, imported by its imported head, in any case');
  assert.deepEqual(included.containedIn(candidates, []), []);
  assert.deepEqual(included.containedIn(candidates, null), []);
});

test('the words: its pull request, its thread and its author, with no em dash', () => {
  const carrier = { id: 6288, pr_number: 8, pr_title: MERGED.pr_title };
  assert.equal(included.closingComment(carrier), 'Included in #8, which went live.');
  assert.equal(included.threadLine(PR3, carrier),
    'PR #3: First version of Flat 4B Chores went live as part of PR #8: Fix mark as done in Jordan’s first version, which was built on it. Its own vote is closed.');
  assert.equal(included.authorLine(carrier), 'Included in #8, which went live.');
  assert.equal(included.prLabel({ id: 4, pr_number: 3 }), 'PR #3');
  for (const s of [included.closingComment(carrier), included.threadLine(PR3, carrier), included.authorLine(carrier)]) {
    assert.doesNotMatch(s, /\u2014/);
  }
});

test('nothing is read or written when GitHub is off, or the merge has no pull request', async () => {
  const { deps, calls } = stubs();
  deps.github.isEnabled = () => false;
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  assert.deepEqual((await included.includeStackedChanges({ pool, session: MERGED, deps })).included, []);
  const out = await included.includeStackedChanges({ pool, session: { ...MERGED, pr_number: null }, deps: stubs().deps });
  assert.deepEqual(out.included, []);
  assert.equal(pool.queries.length, 0);
  assert.equal(calls.length, 0);
});

test('nothing else up for a vote costs no GitHub read', async () => {
  const { deps, calls } = stubs();
  const pool = poolFor({ candidates: [] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deps });
  assert.deepEqual(out.included, []);
  assert.equal(calls.length, 0, 'no list of commits read');
  assert.equal(pool.queries.length, 1, 'only the candidates read');
  // The candidates are the app's other changes up for a vote with a pull
  // request, no running turn and no secret value of their own waiting.
  const sql = pool.queries[0].sql;
  assert.match(sql, /cs\.status = 'promoted'/);
  assert.match(sql, /cs\.pr_number IS NOT NULL AND cs\.active_turn IS NULL/);
  assert.match(sql, /pending_secret_declarations/);
  assert.deepEqual(pool.queries[0].params, [41, 6288]);
});

test('a list GitHub cannot give includes nothing, and a busy change is never a candidate', async () => {
  const failing = stubs({ listFails: true });
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deps: failing.deps });
  assert.deepEqual(out.included, []);
  assert.ok(!pool.queries.some((q) => /UPDATE chat_sessions/.test(q.sql)), 'nothing marked');

  const busy = stubs({ busy: [6269] });
  const pool2 = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  assert.deepEqual((await included.includeStackedChanges({ pool: pool2, session: MERGED, deps: busy.deps })).included, []);
  assert.equal(busy.calls.length, 0, 'a turn running in this process: not read, not marked');
});

test('a change the merged one was built on is marked merged as included, and settled like a merge', async () => {
  const { deps, calls } = stubs({ commits: [H3, H8] });
  const pool = poolFor({
    candidates: [
      { id: 6269, source: 'native', reviewed_head_sha: H3 },
      { id: 6301, source: 'native', reviewed_head_sha: H5 },
    ],
  });
  const out = await included.includeStackedChanges({ config: { x: 1 }, pool, session: MERGED, sha: 'd'.repeat(40), deps });
  assert.deepEqual(out.included, [6269]);
  const mark = pool.queries.find((q) => /UPDATE chat_sessions c/.test(q.sql));
  assert.deepEqual(mark.params, [6288, [6269]], 'only the change whose head is on the list');
  // The same compare-and-set as the merge claim, and the merge's own time
  // and commit.
  assert.match(mark.sql, /c\.status = 'promoted' AND c\.active_turn IS NULL/);
  assert.match(mark.sql, /merged_at = COALESCE\(m\.merged_at, NOW\(\)\)/);
  assert.match(mark.sql, /merge_commit_sha = m\.merge_commit_sha/);
  assert.match(mark.sql, /included_in_session_id = m\.id/);
  assert.match(mark.sql, /WHERE m\.id = \$1 AND m\.status = 'merged'/);

  const [did] = await out.done;
  assert.deepEqual(did, { id: 6269, prClosed: true, requestsClosed: [1] });
  const names = calls.map((c) => c[0]);
  assert.deepEqual(names, [
    'listPullRequestCommitShas',
    'noteRequestMerged',
    'createIssueComment', 'closePR',
    'sendSystemMessage',
    'resolveIssueBounty', 'noteIssuesClosed', 'closeIssue', 'bustAndBroadcast', 'closeTwinRows', 'resolveSupersededProposals',
    'withdrawBotProposals',
    'teardownStaging', 'retireWorker', 'noteChangeClosed',
    'pushVoteUpdate',
    'createPrMergedNotification',
    'createVotedChangeMergedNotifications',
    'noteProposalMerged', 'recordChangeLive',
  ]);
  const call = (name) => calls.find((c) => c[0] === name);
  assert.deepEqual(call('listPullRequestCommitShas'), ['listPullRequestCommitShas', 'usernode-bot', 'flat-4b-chores-e98ecd', 8]);
  assert.deepEqual(call('createIssueComment'), ['createIssueComment', 'usernode-bot', 'flat-4b-chores-e98ecd', 3, 'Included in #8, which went live.']);
  assert.deepEqual(call('closePR'), ['closePR', 'usernode-bot', 'flat-4b-chores-e98ecd', 3]);
  assert.deepEqual(call('closeIssue'), ['closeIssue', 'usernode-bot', 'flat-4b-chores-e98ecd', 1]);
  const line = call('sendSystemMessage');
  assert.equal(line[1], 41);
  assert.equal(line[2], included.threadLine(PR3, { pr_number: 8, pr_title: MERGED.pr_title }));
  assert.deepEqual(line[4], { included: { sessionId: 6269, inSessionId: 6288, inPrNumber: 8 } });
  assert.deepEqual(line[5], { type: 'session', ref: 6269 }, 'in its own thread, never a channel');
  assert.deepEqual(call('resolveIssueBounty')[1], { appId: 41, sessionId: 6269, awardeeUserId: 9, issueNumber: 1 });
  assert.deepEqual(call('closeTwinRows')[1], { appId: 41, numbers: [1] });
  assert.deepEqual(call('withdrawBotProposals')[1], { appId: 41, numbers: [1] },
    'the bot\'s other proposals built for the closed request alone are withdrawn');
  assert.equal(call('noteChangeClosed')[1].outcome, 'merged');
  assert.deepEqual(call('createPrMergedNotification')[1],
    { userId: 9, appId: 41, sessionId: 6269, credits: 'Included in #8, which went live.' });
  assert.deepEqual(call('createVotedChangeMergedNotifications')[1],
    { appId: 41, sessionId: 6269, authorId: 9 }, 'its voters are told it is live too (#4787)');
  assert.deepEqual(call('pushVoteUpdate')[1],
    { sessionId: 6269, appSlug: 'flat-4b-chores-e98ecd', appId: 41, merged: true, includedIn: 6288 });
  assert.equal(call('noteRequestMerged')[1].id, 6269, 'the bot settles the included change\'s own request');
  assert.deepEqual(call('noteProposalMerged')[2], { config: { x: 1 }, sha: 'd'.repeat(40) });
  assert.deepEqual(call('recordChangeLive')[1], { config: { x: 1 }, session: PR3, sha: 'd'.repeat(40) });
});

test('after a merge whose deploy failed it is merged and closed, and nobody is told it is live', async () => {
  const { deps, calls } = stubs();
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deployed: false, deps });
  assert.deepEqual(out.included, [6269]);
  const [did] = await out.done;
  assert.deepEqual(did, { id: 6269, prClosed: true, requestsClosed: [1] });
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('closePR') && names.includes('closeIssue') && names.includes('pushVoteUpdate'));
  for (const quiet of ['createPrMergedNotification', 'createVotedChangeMergedNotifications', 'noteProposalMerged', 'recordChangeLive']) {
    assert.ok(!names.includes(quiet), `${quiet} waits for a deploy that did not happen`);
  }
});

test('#4787: a telling-its-voters step that fails is logged and the merge goes on', async () => {
  const { deps, calls } = stubs();
  deps.notifications.createVotedChangeMergedNotifications = async () => { throw new Error('db hiccup'); };
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deps });
  const [did] = await out.done;
  assert.deepEqual(did, { id: 6269, prClosed: true, requestsClosed: [1] });
  assert.ok(calls.some((c) => c[0] === 'noteProposalMerged'), 'the rest of the live work still ran');
});

test('a step that fails is logged and the rest go on', async () => {
  const { deps, calls } = stubs();
  deps.github.closePR = async () => { throw new Error('closed already'); };
  deps.github.closeIssue = async () => { const e = new Error('nope'); e.status = 403; throw e; };
  deps.bot.noteRequestMerged = async () => { throw new Error('db hiccup'); };
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deps });
  const [did] = await out.done;
  assert.deepEqual(did, { id: 6269, prClosed: false, requestsClosed: [] });
  assert.deepEqual(calls.find((c) => c[0] === 'unsuppressIssues'), ['unsuppressIssues', 'usernode-bot', 'flat-4b-chores-e98ecd', [1]],
    'a request GitHub would not close is shown again');
  assert.ok(!calls.some((c) => c[0] === 'bustAndBroadcast'), 'nothing closed, nothing broadcast as closed');
  assert.ok(calls.some((c) => c[0] === 'recordChangeLive'), 'the journey is still recorded');
});

test('a change another process started merging, or withdrew, is left as it is', async () => {
  const { deps, calls } = stubs();
  const pool = poolFor({ candidates: [{ id: 6269, source: 'native', reviewed_head_sha: H3 }], marked: [] });
  const out = await included.includeStackedChanges({ pool, session: MERGED, deps });
  assert.deepEqual(out.included, []);
  assert.deepEqual(await out.done, []);
  assert.deepEqual(calls.map((c) => c[0]), ['listPullRequestCommitShas']);
});

test('GitHub: the commits of a pull request, every page, in lowercase', async () => {
  const github = require('../src/services/github');
  const asked = [];
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ sha: `${n}${String(i).padStart(39, '0')}`.toUpperCase() }));
  github._setOctokitFactoryForTests(() => ({
    request: async (route, params) => {
      asked.push([route, params.pull_number, params.per_page, params.page]);
      return { data: params.page === 1 ? page('a', 100) : page('b', 3) };
    },
  }));
  try {
    const out = await github.listPullRequestCommitShas('usernode-bot', 'flat', 8);
    assert.equal(out.shas.length, 103);
    assert.equal(out.complete, true);
    assert.ok(out.shas.every((s) => s === s.toLowerCase()));
    assert.deepEqual(asked, [
      ['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', 8, 100, 1],
      ['GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', 8, 100, 2],
    ]);
    // GitHub lists at most 250: a full list may be short.
    github._setOctokitFactoryForTests(() => ({ request: async () => ({ data: page('c', 100) }) }));
    const capped = await github.listPullRequestCommitShas('usernode-bot', 'flat', 9);
    assert.equal(capped.shas.length, 300);
    assert.equal(capped.complete, false);
  } finally {
    github._setOctokitFactoryForTests(null);
  }
});

test('the merge marks them right after itself, before the bot\'s bookkeeping and the cascade', () => {
  const src = read('src/routes/votes.js');
  const start = src.indexOf('async function finalizeMerge(');
  const body = src.slice(start, src.indexOf('\nasync function checkAndMerge(', start));
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  const markedMerged = at("UPDATE chat_sessions SET status = 'merged', merged_at = NOW()");
  const inclusion = at("require('../services/included-changes').includeStackedChanges({");
  assert.ok(markedMerged < inclusion, 'the merged change is merged before it can carry another');
  assert.ok(inclusion < at("require('../services/homeroom-bot').noteRequestMerged(pool, session)"));
  assert.ok(inclusion < at('checkAndResolveConflicts(config, { app_id: session.app_id'));
  assert.match(body, /const inclusion = await require\('\.\.\/services\/included-changes'\)\.includeStackedChanges\(\{\s+config, pool, session, sha: deployedSha,\s+\}\);/);
  // Never a reason the merge fails.
  const block = body.slice(inclusion - 400, inclusion + 900);
  assert.match(block, /try \{[\s\S]*\} catch \(err\) \{\s+log\.warn\('votes', 'Including the changes this merge carried failed'/);
});

test('a merge whose deploy failed still marks what it carried, quietly', () => {
  const src = read('src/routes/votes.js');
  const at = src.indexOf("'Failed to mark session merged after post-merge error'");
  assert.ok(at > 0);
  const tail = src.slice(at, at + 1200);
  assert.match(tail, /await require\('\.\.\/services\/included-changes'\)\.includeStackedChanges\(\{\s+config, pool, session, deployed: false,\s+\}\);/);
  assert.match(tail, /catch \(e\) \{\s+log\.warn\('votes', 'Including the changes a merge carried failed after its deploy failed'/);
});

test('the change page reads the carrying change, undo refuses, and recovery skips it', () => {
  const src = read('src/routes/votes.js');
  const select = src.slice(src.indexOf('function mergedRowSelect()'), src.indexOf('function voteRoutes(config)'));
  assert.match(select, /cs\.included_in_session_id,\s+inc\.pr_number AS included_in_pr_number,\s+inc\.pr_title  AS included_in_pr_title,/);
  assert.match(select, /LEFT JOIN chat_sessions inc ON inc\.id = cs\.included_in_session_id`;/);
  const undo = src.slice(src.indexOf("router.post('/api/sessions/:id/undo'"), src.indexOf("router.post('/api/sessions/:id/admin-merge'"));
  assert.match(undo, /if \(session\.included_in_session_id\) \{\s+return res\.status\(409\)\.json\(\{\s+error: 'This change went live as part of another change\. Undo that change instead\.',/);
  assert.ok(undo.indexOf('included_in_session_id') < undo.indexOf('checkAndOpenRevert('), 'refused before a revert is opened');
  const recovery = read('src/services/merge-followup-recovery.js');
  assert.match(recovery, /WHERE cs\.status = 'merged' AND cs\.pr_number IS NOT NULL\s+AND cs\.included_in_session_id IS NULL/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS included_in_session_id INTEGER\s+REFERENCES chat_sessions\(id\) ON DELETE SET NULL;/);
});
