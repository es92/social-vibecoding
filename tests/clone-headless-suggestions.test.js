// Route test for POST /api/sessions/:id/clone-headless (src/routes/
// sessions.js, #32) — the load-bearing Part B fix. When the source auto
// session ended in a question, the appended follow-up message (which
// becomes the last non-system row) must carry the question turn's
// metadata.suggestions forward so the suggested-answer chips render under
// it. spec/code/spec_code clones have no questions, so their follow-up
// must stay chip-free (metadata = {}).
//
// Harness shape mirrors tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module (sessions.js destructures it at
// require time), stub the side-effect modules (events/notifications), mount
// the router on a real express app, and inject req.user. The pool stub is
// programmable per-test and captures the follow-up INSERT so we can assert
// the metadata column directly.
//
// Run with: node --test tests/clone-headless-suggestions.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let handler = async () => ({ rows: [] });
let captured = [];
const stubPool = {
  query: (sql, params) => {
    captured.push({ sql, params });
    return handler(sql, params);
  },
};
poolMod.getPool = () => stubPool;

// Side effects we don't exercise here — keep them no-ops so the route's
// happy path doesn't fan out into real queries/notifications.
const events = require('../src/services/events');
events.record = () => Promise.resolve();
const notifications = require('../src/services/notifications');
notifications.markReadForAction = async () => 0;
const github = require('../src/services/github');
github.isEnabled = () => false;

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({ maxUserSessions: 5, maxGlobalSessions: 100 }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const SUGGESTIONS = [
  { question: 'Which header?', answers: ['The top bar', 'The app view header'] },
  { question: 'What does "nicer" mean?', answers: ['Tidier spacing', 'A bolder refresh'] },
];

// A programmable pool stub that walks the clone-headless query sequence.
// `outcome` sets src.headless_outcome; `suggestionsRow` is what the
// "most recent assistant message with suggestions" lookup returns.
function makeHandler({ outcome, suggestionsRow }) {
  return async (sql) => {
    if (/FROM chat_sessions cs\s+JOIN apps a/.test(sql)) {
      return {
        rows: [{
          id: 1,
          app_id: 11,
          app_slug: 'demo',
          app_name: 'Demo App',
          repo_url: null, // no owner/name → branch + title fetch skipped
          // appAccess.sessionCollabGuard selects both visibility columns
          // alongside the session; checkAppAccess THROWS without them.
          collab_visibility: 'public',
          view_visibility: 'public',
          is_headless: true,
          headless_status: 'ready',
          headless_outcome: outcome,
          headless_issue_number: 42,
          branch_name: 'auto/issue-42',
          spec_md: '',
          linked_issues: [],
          testing_md: null,
          testing_path: null,
          testing_paths: null,
          cc_session_id: null,
          session_title: '#42 · Make the header nicer',
        }],
      };
    }
    if (/COUNT\(\*\) as cnt FROM chat_sessions/.test(sql)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) {
      return { rows: [{ id: 99, app_id: 11, app_slug: 'demo', user_id: 7 }] };
    }
    if (/INSERT INTO chat_session_messages[\s\S]*SELECT/.test(sql)) {
      return { rows: [] }; // convo copy
    }
    if (/INSERT INTO chat_session_specs/.test(sql)) {
      return { rows: [] };
    }
    // The forwarded-suggestions lookup (only issued on the question path).
    if (/SELECT metadata FROM chat_session_messages/.test(sql)) {
      return { rows: suggestionsRow ? [suggestionsRow] : [] };
    }
    // The follow-up INSERT — the row under test.
    if (/INSERT INTO chat_session_messages \(session_id, role, content, metadata\)/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

async function clone(server) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/1/clone-headless`, {
    method: 'POST',
  });
  return { res, body: await res.json() };
}

function followUpInsert() {
  return captured.find((c) =>
    /INSERT INTO chat_session_messages \(session_id, role, content, metadata\)/.test(c.sql));
}

test("question clone forwards the question turn's suggestions onto the follow-up", async () => {
  captured = [];
  handler = makeHandler({
    outcome: 'question',
    suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
  });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);

    const ins = followUpInsert();
    assert.ok(ins, 'follow-up INSERT was issued');
    const meta = JSON.parse(ins.params[2]);
    assert.deepStrictEqual(meta.suggestions, SUGGESTIONS);

    // The lookup query must be scoped to non-empty suggestions arrays.
    const lookup = captured.find((c) => /SELECT metadata FROM chat_session_messages/.test(c.sql));
    assert.ok(lookup, 'suggestions lookup was issued on the question path');
    assert.match(lookup.sql, /jsonb_array_length/);
    assert.match(lookup.sql, /ORDER BY id DESC/);
  } finally {
    server.close();
  }
});

test('question clone with no source suggestions writes an empty-metadata follow-up', async () => {
  captured = [];
  handler = makeHandler({ outcome: 'question', suggestionsRow: null });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);
    const ins = followUpInsert();
    assert.ok(ins);
    assert.deepStrictEqual(JSON.parse(ins.params[2]), {});
  } finally {
    server.close();
  }
});

// #330: spec/code/spec_code clones must carry NO chips (they have no
// questions) but DO carry outcome-appropriate next-step quick-reply pills,
// so the cloned follow-up never lands with an empty pill bar.
const EXPECTED_PILLS = {
  spec: ['Build the spec', 'Revise the spec', 'What will this change?'],
  code: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
  spec_code: ['Propose it to the group', 'Revise the spec', 'Make a tweak'],
};

for (const outcome of ['spec', 'code', 'spec_code']) {
  test(`${outcome} clone carries next-step pills, no chips, and skips the lookup`, async () => {
    captured = [];
    handler = makeHandler({
      outcome,
      // Even if a suggestions row existed, the non-question path must not
      // query for or forward it.
      suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
    });
    const server = await startServer();
    try {
      const { res } = await clone(server);
      assert.strictEqual(res.status, 201);

      const ins = followUpInsert();
      assert.ok(ins, 'follow-up INSERT was issued');
      const meta = JSON.parse(ins.params[2]);
      assert.deepStrictEqual(meta.quickReplies, EXPECTED_PILLS[outcome]);
      assert.strictEqual(meta.suggestions, undefined, 'no answer chips off the question path');
      // Pills must respect the shared sanitizeQuickReplies envelope.
      assert.ok(meta.quickReplies.length <= 3, '≤3 pills');
      for (const p of meta.quickReplies) assert.ok(p.length <= 80, '≤80 chars per pill');

      const lookup = captured.find((c) => /SELECT metadata FROM chat_session_messages/.test(c.sql));
      assert.strictEqual(lookup, undefined, 'suggestions lookup must be skipped off the question path');
    } finally {
      server.close();
    }
  });
}

test('question clone carries chips but no pills', async () => {
  captured = [];
  handler = makeHandler({
    outcome: 'question',
    suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
  });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);
    const ins = followUpInsert();
    const meta = JSON.parse(ins.params[2]);
    assert.deepStrictEqual(meta.suggestions, SUGGESTIONS);
    assert.strictEqual(meta.quickReplies, undefined, 'pills suppressed on the question path');
  } finally {
    server.close();
  }
});

// #647: every row the clone copies is stamped with metadata.inheritedFrom
// (the auto session's id) so the dev-chat renderer can collapse the
// inherited Claude Code disclosures by default. The appended follow-up row
// must NOT carry it — that message belongs to the human session.
test('the conversation copy stamps inheritedFrom on every copied row', async () => {
  captured = [];
  handler = makeHandler({ outcome: 'code', suggestionsRow: null });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);

    const copy = captured.find((c) =>
      /INSERT INTO chat_session_messages[\s\S]*SELECT/.test(c.sql));
    assert.ok(copy, 'the conversation copy was issued');
    assert.match(copy.sql, /jsonb_build_object\('inheritedFrom', \$2::int\)/,
      'the source session id is stamped onto each copied row');
    // Pre-existing metadata must survive the stamp (the copied rows carry
    // progressLog / ccOutput / suggestions the renderer still needs), and a
    // NULL metadata column must not swallow the whole object.
    assert.match(copy.sql, /COALESCE\(metadata, '\{\}'::jsonb\) \|\|/,
      'existing metadata is preserved and NULL is coalesced');
    // $2 is the source session id in this query (session_id = $2).
    assert.strictEqual(copy.params[1], 1, 'stamped with the source session id');

    const ins = followUpInsert();
    assert.ok(ins, 'follow-up INSERT was issued');
    assert.strictEqual(JSON.parse(ins.params[2]).inheritedFrom, undefined,
      'the appended follow-up is not marked as inherited');
  } finally {
    server.close();
  }
});
