'use strict';

// A change that went live inside another one (workflow/merge-followups/facts.ts).
//
// Flat 4B Chores, 5 Oct 2026: the Homeroom bot built the project's first
// version (PR 3) and, asked in the group chat to fix it, built the fix (PR 8)
// on PR 3's branch. PR 8 merged, squashed, with PR 3's commit in it. PR 3
// stayed open and kept asking for votes, request #1 stayed open, and the App
// tab kept saying the first version was being built over the live app.
//
// Now, when a change merges, every other change of the app up for a vote
// whose head commit is one of the merged pull request's own commits is
// included in it, and what a merge does for a change is done for it: the
// merge-followups workflow machine (tests/workflow-merge-followups-postgres
// .test.js, F8). These tests pin the pieces it uses here: the comparison,
// the words and GitHub's list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { includedIn } = require('../src/workflow/merge-followups/facts.ts');
const lines = require('../src/workflow/rules/included-lines.ts');

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

test('includedIn: a head on the merged pull request\'s commits, and nothing else', () => {
  const candidates = [
    { id: 1, source: 'native', reviewed_head_sha: H3 },
    { id: 2, source: 'native', reviewed_head_sha: H5 },
    { id: 3, source: 'imported', imported_pr_head_sha: H3.toUpperCase(), reviewed_head_sha: null },
    { id: 4, source: 'native', reviewed_head_sha: null },
    { id: 5, source: 'native', reviewed_head_sha: 'not-a-sha' },
  ];
  assert.deepEqual(includedIn(candidates, [H8, H3]), [{ id: 1, head: H3 }, { id: 3, head: H3 }],
    'native by its reviewed head, imported by its imported head, in any case, each named with that head in lowercase');
  assert.deepEqual(includedIn(candidates, [H8.toUpperCase(), H3.toUpperCase()]).map((c) => c.id), [1, 3],
    'the listed commits are compared in any case too');
  assert.deepEqual(includedIn(candidates, []), []);
  assert.deepEqual(includedIn(candidates, null), []);
});

test('the words: its pull request, its thread and its author, with no em dash', () => {
  const carrier = { id: 6288, pr_number: 8, pr_title: MERGED.pr_title };
  assert.equal(lines.closingComment(carrier), 'Included in #8, which went live.');
  assert.equal(lines.threadLine(PR3, carrier),
    'PR #3: First version of Flat 4B Chores went live as part of PR #8: Fix mark as done in Jordan’s first version, which was built on it. Its own vote is closed.');
  assert.equal(lines.authorLine(carrier), 'Included in #8, which went live.');
  assert.equal(lines.prLabel({ id: 4, pr_number: 3 }), 'PR #3');
  for (const s of [lines.closingComment(carrier), lines.threadLine(PR3, carrier), lines.authorLine(carrier)]) {
    assert.doesNotMatch(s, /\u2014/);
  }
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

test('the change page reads the carrying change, and undo refuses', () => {
  const src = read('src/routes/votes.js');
  const select = src.slice(src.indexOf('function mergedRowSelect('), src.indexOf('function voteRoutes(config)'));
  assert.match(select, /cs\.included_in_session_id,\s+inc\.pr_number AS included_in_pr_number,\s+inc\.pr_title  AS included_in_pr_title,/);
  assert.match(select, /LEFT JOIN chat_sessions inc ON inc\.id = cs\.included_in_session_id`;/);
  const undo = src.slice(src.indexOf("router.post('/api/sessions/:id/undo'"), src.indexOf("router.post('/api/sessions/:id/admin-merge'"));
  assert.match(undo, /if \(session\.included_in_session_id\) \{\s+return res\.status\(409\)\.json\(\{\s+error: 'This change went live as part of another change\. Undo that change instead\.',/);
  assert.ok(undo.indexOf('included_in_session_id') < undo.indexOf("op: 'revert.open'"), 'refused before a revert is opened');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS included_in_session_id INTEGER\s+REFERENCES chat_sessions\(id\) ON DELETE SET NULL;/);
});
