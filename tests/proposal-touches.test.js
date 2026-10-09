'use strict';

// #4490: "What it touches", the picture a change shows when it has no shots
// and no diagram: path → area rules, the summary's shape, and the refresh
// that reads a moved head once and only for that head.

const test = require('node:test');
const assert = require('node:assert/strict');

const touches = require('../src/services/proposal-touches');

test('each path lands in one area, the specific rule first', () => {
  const cases = {
    'frontend/src/features/dev-board/workshop/workshop.tsx': 'screens',
    'public/css/app.css': 'screens',
    'public/js/app-view.js': 'screens',
    'src/routes/votes.js': 'server',
    'src/services/diagram.js': 'server',
    'server.js': 'server',
    'worker/visible-changes-mcp.js': 'server',
    'src/db/schema.sql': 'database',
    'src/db/migrate.js': 'database',
    'migrations/001.sql': 'database',
    'tests/diagram.test.js': 'tests',
    'frontend/src/lib/x.test.ts': 'tests',
    'docs/proposal-visuals/before-after-shots.md': 'docs',
    'README.md': 'docs',
    'package.json': 'other',
    'dapp.json': 'other',
  };
  for (const [file, area] of Object.entries(cases)) assert.equal(touches.areaOf(file), area, file);
});

test('the summary counts files and lines per area, in a fixed order, keeping empty areas', () => {
  const out = touches.summarize([
    { filename: 'src/services/a.js', additions: 10, deletions: 2 },
    { filename: 'src/routes/b.js', additions: 1, deletions: 1 },
    { filename: 'tests/a.test.js', additions: 30, deletions: 0 },
  ]);
  assert.equal(out.version, 1);
  assert.equal(out.files, 3);
  assert.deepEqual(out.areas.map((a) => a.key), ['screens', 'server', 'database', 'tests', 'docs', 'other']);
  assert.deepEqual(out.areas.find((a) => a.key === 'server'), { key: 'server', label: 'Server', files: 2, lines: 14 });
  assert.equal(out.areas.find((a) => a.key === 'screens').files, 0);
  assert.equal(touches.summarize([]), null);
  assert.equal(touches.storedTouches(out).files, 3);
  assert.equal(touches.storedTouches({ version: 2, areas: [] }), null);
});

test('a moved head is read once, in the background, and stored for that head', async () => {
  const writes = [];
  const pool = { query: async (sql, params) => { writes.push({ sql, params }); return { rowCount: 1 }; } };
  let compares = 0;
  const github = {
    compareFiles: async (owner, repo, basehead) => {
      compares += 1;
      assert.equal(owner, 'Usernode-Labs');
      assert.equal(repo, 'social-vibecoding');
      assert.match(basehead, /^main\.\.\.[0-9a-f]{40}$/);
      return { files: [{ filename: 'src/services/a.js', additions: 3, deletions: 1 }] };
    },
  };
  const head = 'a'.repeat(40);
  const rows = [
    { id: 1, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', pr_touches_sha: head, head },
    { id: 2, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git', pr_touches_sha: null, head },
    { id: 3, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', pr_touches_sha: null, head: null },
  ];
  assert.equal(touches.scheduleRefresh(pool, rows, { github }), 1, 'only the row whose head moved');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(compares, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE chat_sessions SET pr_touches = \$2::jsonb, pr_touches_sha = \$3/);
  assert.equal(writes[0].params[0], 2);
  assert.equal(JSON.parse(writes[0].params[1]).areas.find((a) => a.key === 'server').files, 1);
  assert.equal(writes[0].params[2], head);
});

test('a failed read stores nothing and never throws', async () => {
  const pool = { query: async () => { throw new Error('should not write'); } };
  const github = { compareFiles: async () => { throw new Error('GitHub unreachable'); } };
  const ok = await touches.refreshOne(pool, { sessionId: 9, repoUrl: 'https://github.com/o/r', headSha: 'b'.repeat(40) }, { github });
  assert.equal(ok, false);
  assert.equal(await touches.refreshOne(pool, { sessionId: 9, repoUrl: 'nope', headSha: 'b'.repeat(40) }, { github }), false);
});
