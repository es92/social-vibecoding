// Tests for #249 — meaningful default session names.
//
//  - llm.parseSessionTitleText: tolerant parsing (JSON shape, raw text,
//    fences/quotes), sanitization, length cap, throws on empty.
//  - services/session-title: first-message hook fires only when both
//    session_title and pr_number are unset; success persists with the
//    `pr_number IS NULL` guard and emits session_titled; failures
//    resolve null and touch nothing (never throw); the turn-end refresh
//    gathers the full request history + live spec.
//  - services/pr-metadata: both PR UPDATE statements mirror pr_title
//    into session_title.
//  - #1949 OpenRouter sessions: deterministicTitle is the shared,
//    LLM-free trim; titleFromFirstMessage names an untitled, PR-less
//    session from its first user message with no model call and no
//    spend, and an OpenRouter PR title equals that session name.
//
// Run with: node --test tests/session-title.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const llmReal = require('../src/services/llm');

// ---- parseSessionTitleText ----

test('parseSessionTitleText accepts the JSON shape', () => {
  assert.equal(llmReal.parseSessionTitleText('{"title": "Session naming defaults"}'), 'Session naming defaults');
});

test('parseSessionTitleText accepts fenced JSON', () => {
  assert.equal(
    llmReal.parseSessionTitleText('```json\n{"title": "Fix login redirect"}\n```'),
    'Fix login redirect'
  );
});

test('parseSessionTitleText accepts plain text and strips quotes/fences/trailing period', () => {
  assert.equal(llmReal.parseSessionTitleText('Leaderboard pagination'), 'Leaderboard pagination');
  assert.equal(llmReal.parseSessionTitleText('"Leaderboard pagination."'), 'Leaderboard pagination');
  assert.equal(llmReal.parseSessionTitleText('```\nLeaderboard pagination\n```'), 'Leaderboard pagination');
});

test('parseSessionTitleText collapses whitespace and newlines', () => {
  assert.equal(llmReal.parseSessionTitleText('  Fix   session\nnaming  '), 'Fix session naming');
});

test('parseSessionTitleText hard-caps at 256 chars', () => {
  const long = 'x'.repeat(400);
  assert.equal(llmReal.parseSessionTitleText(long).length, 256);
});

test('parseSessionTitleText throws on empty/unusable input', () => {
  assert.throws(() => llmReal.parseSessionTitleText(''));
  assert.throws(() => llmReal.parseSessionTitleText('   '));
  assert.throws(() => llmReal.parseSessionTitleText('"."'));
});

// ---- session-title service ----

// Stub ./llm and ./limits in require.cache, then force-load the subject.
function loadServiceWithStubs({ onGenerate, spends = [] }) {
  const llmPath = require.resolve('../src/services/llm');
  const limitsPath = require.resolve('../src/services/limits');
  const subjectPath = require.resolve('../src/services/session-title');
  const orig = {
    llm: require.cache[llmPath],
    limits: require.cache[limitsPath],
    subject: require.cache[subjectPath],
  };

  require.cache[llmPath] = {
    exports: {
      generateSessionTitle: async (args) => onGenerate(args),
      estimateCostCents: () => 0.01,
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[limitsPath] = {
    exports: { recordSpend: async (...a) => { spends.push(a); } },
    loaded: true, id: limitsPath, filename: limitsPath, paths: orig.limits ? orig.limits.paths : [],
  };
  delete require.cache[subjectPath];
  const subject = require('../src/services/session-title');

  const restore = () => {
    if (orig.llm) require.cache[llmPath] = orig.llm; else delete require.cache[llmPath];
    if (orig.limits) require.cache[limitsPath] = orig.limits; else delete require.cache[limitsPath];
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

function mockPool({ updateRowCount = 1, userRows = [], specMd = '' } = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/UPDATE chat_sessions SET session_title/.test(sql)) return { rowCount: updateRowCount, rows: [] };
      if (/FROM chat_session_messages/.test(sql)) return { rows: userRows };
      if (/SELECT spec_md FROM chat_sessions/.test(sql)) return { rows: [{ spec_md: specMd }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('headlessTitle derives "#N · title" and truncates to 256', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.headlessTitle(249, 'Session naming should default to meaningful identifiers'),
      '#249 · Session naming should default to meaningful identifiers');
    assert.equal(subject.headlessTitle(7, '  spaced \n out  '), '#7 · spaced out');
    assert.equal(subject.headlessTitle(7, 'x'.repeat(400)).length, 256);
    // Degraded fetch (no title) and bogus numbers -> null, branch fallback.
    assert.equal(subject.headlessTitle(7, ''), null);
    assert.equal(subject.headlessTitle(7, null), null);
    assert.equal(subject.headlessTitle(null, 'title'), null);
    assert.equal(subject.headlessTitle(0, 'title'), null);
  } finally {
    restore();
  }
});

test('maybeTitleFirstMessage titles a fresh session and emits session_titled', async () => {
  const captured = [];
  const spends = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => { captured.push(args); return { title: 'Session naming defaults', usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-haiku-4-5' }; },
    spends,
  });
  try {
    const pool = mockPool();
    const session = { id: 5, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'fix the session naming please',
      userId: 3, apiKey: null, send: (type, data) => events.push({ type, data }),
    });

    assert.equal(title, 'Session naming defaults');
    assert.deepEqual(captured[0].requests, ['fix the session naming please']);
    assert.equal(session.session_title, 'Session naming defaults');
    // The persist is guarded so a PR-mirrored title can't be clobbered.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/);
    assert.deepEqual(upd.params, ['Session naming defaults', 5]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Session naming defaults' } }]);
    // The Haiku call was debited to the requesting user.
    assert.equal(spends.length, 1);
    assert.equal(spends[0][1], 3);
  } finally {
    restore();
  }
});

test('maybeTitleFirstMessage skips when the session already has a title or a PR', async () => {
  let calls = 0;
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => { calls++; return { title: 'x' }; } });
  try {
    const pool = mockPool();
    assert.equal(await subject.maybeTitleFirstMessage({
      pool, session: { id: 1, session_title: 'Already named', pr_number: null }, message: 'hi',
    }), null);
    assert.equal(await subject.maybeTitleFirstMessage({
      pool, session: { id: 2, session_title: null, pr_number: 42 }, message: 'hi',
    }), null);
    assert.equal(calls, 0, 'no LLM call when title or PR already exists');
    assert.equal(pool.queries.length, 0, 'no DB writes either');
  } finally {
    restore();
  }
});

test('a failed generation resolves null and touches nothing (never throws)', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { throw new Error('LLM down'); },
  });
  try {
    const pool = mockPool();
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'do the thing', userId: 1, send: (t, d) => events.push(t),
    });
    assert.equal(title, null);
    assert.equal(session.session_title, null, 'session left untouched');
    assert.equal(events.length, 0, 'no event emitted');
    assert.equal(pool.queries.length, 0, 'no UPDATE attempted');
  } finally {
    restore();
  }
});

test('losing the race to a PR-mirrored title emits nothing', async () => {
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => ({ title: 'Slow early title', usage: undefined, model: 'claude-haiku-4-5' }),
  });
  try {
    // rowCount 0 = the guarded UPDATE matched nothing (PR landed meanwhile).
    const pool = mockPool({ updateRowCount: 0 });
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.maybeTitleFirstMessage({
      pool, session, message: 'do the thing', send: (t) => events.push(t),
    });
    assert.equal(title, null);
    assert.equal(session.session_title, null);
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

test('refreshFromHistory feeds the full request history + live spec to the LLM', async () => {
  const captured = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async (args) => { captured.push(args); return { title: 'Fix session naming defaults', usage: undefined, model: 'claude-haiku-4-5' }; },
  });
  try {
    const pool = mockPool({
      userRows: [{ content: "something's off with naming" }, { content: 'yes, default the titles' }],
      specMd: '# Spec: session naming',
    });
    const session = { id: 5, session_title: 'Old vague title', pr_number: null };
    const events = [];
    const title = await subject.refreshFromHistory({
      pool, session, userId: 3, send: (type, data) => events.push({ type, data }),
    });
    assert.equal(title, 'Fix session naming defaults');
    assert.deepEqual(captured[0].requests, ["something's off with naming", 'yes, default the titles']);
    assert.deepEqual(captured[0].specs, ['# Spec: session naming']);
    assert.equal(session.session_title, 'Fix session naming defaults');
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Fix session naming defaults' } }]);
  } finally {
    restore();
  }
});

// ---- #1949: deterministic OpenRouter titles ----

test('deterministicTitle trims markdown, collapses whitespace and caps at 72 chars', () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    assert.equal(subject.deterministicTitle('  Fix   the\nlogin  redirect  '), 'Fix the login redirect');
    assert.equal(subject.deterministicTitle('## Fix `login` [redirect](x) *now*'), 'Fix login redirect x now');
    assert.equal(subject.deterministicTitle('```js\nfoo()\n```'), '', 'a fenced block alone leaves nothing');
    assert.equal(subject.deterministicTitle(''), '');
    assert.equal(subject.deterministicTitle(null), '');
    const exact = 'x'.repeat(72);
    assert.equal(subject.deterministicTitle(exact), exact, '72 chars fit untouched');
    const long = `${'word '.repeat(20)}end`;
    const trimmed = subject.deterministicTitle(long);
    assert.equal(trimmed.length, 72);
    assert.ok(trimmed.endsWith('…'));
    assert.equal(trimmed, `${long.slice(0, 71).trimEnd()}…`);
  } finally {
    restore();
  }
});

test('titleFromFirstMessage names an untitled OpenRouter session from its first user message', async () => {
  let generateCalls = 0;
  const spends = [];
  const { subject, restore } = loadServiceWithStubs({
    onGenerate: async () => { generateCalls += 1; return { title: 'never' }; },
    spends,
  });
  try {
    // The FIRST user row wins over the turn's own message — a session
    // whose opening turn was refused or stopped is still named from its
    // opening ask, and that is the request the PR title comes from too.
    const pool = mockPool({ userRows: [{ content: 'Make the **leaderboard** paginate' }, { content: 'try again' }] });
    const session = { id: 5, session_title: null, pr_number: null };
    const events = [];
    const title = await subject.titleFromFirstMessage({
      pool, session, message: 'try again', send: (type, data) => events.push({ type, data }),
    });

    assert.equal(title, 'Make the leaderboard paginate');
    assert.equal(session.session_title, 'Make the leaderboard paginate');
    const sel = pool.queries.find((q) => /FROM chat_session_messages/.test(q.sql));
    assert.match(sel.sql, /role = 'user'/);
    assert.match(sel.sql, /ORDER BY id ASC LIMIT 1/);
    assert.deepEqual(sel.params, [5]);
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET session_title/.test(q.sql));
    assert.match(upd.sql, /pr_number IS NULL/, 'same guard as the Haiku path');
    assert.deepEqual(upd.params, ['Make the leaderboard paginate', 5]);
    assert.deepEqual(events, [{ type: 'session_titled', data: { sessionTitle: 'Make the leaderboard paginate' } }]);
    assert.equal(generateCalls, 0, 'no model call');
    assert.equal(spends.length, 0, 'nothing to debit');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage falls back to the turn message and skips when nothing is usable', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    // No stored row yet -> the turn's own message names the session.
    const pool = mockPool({ userRows: [] });
    const session = { id: 6, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({ pool, session, message: 'Add a dark mode toggle' }),
      'Add a dark mode toggle');
    assert.equal(session.session_title, 'Add a dark mode toggle');

    // Nothing readable at all -> no title, no UPDATE, branch name stays.
    const empty = mockPool({ userRows: [{ content: '```\ncode only\n```' }] });
    const bare = { id: 7, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({ pool: empty, session: bare, message: '   ' }), null);
    assert.equal(bare.session_title, null);
    assert.ok(!empty.queries.some((q) => /UPDATE chat_sessions/.test(q.sql)), 'no UPDATE attempted');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage skips titled and PR sessions without touching the DB', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const pool = mockPool();
    assert.equal(await subject.titleFromFirstMessage({
      pool, session: { id: 1, session_title: 'Already named', pr_number: null }, message: 'hi',
    }), null);
    assert.equal(await subject.titleFromFirstMessage({
      pool, session: { id: 2, session_title: null, pr_number: 42 }, message: 'hi',
    }), null);
    assert.equal(await subject.titleFromFirstMessage({ pool, session: null, message: 'hi' }), null);
    assert.equal(pool.queries.length, 0, 'no reads or writes');
  } finally {
    restore();
  }
});

test('titleFromFirstMessage never throws: a DB failure resolves null, a lost race emits nothing', async () => {
  const { subject, restore } = loadServiceWithStubs({ onGenerate: async () => ({}) });
  try {
    const broken = {
      async query() { throw new Error('db down'); },
    };
    const session = { id: 9, session_title: null, pr_number: null };
    const events = [];
    assert.equal(await subject.titleFromFirstMessage({
      pool: broken, session, message: 'do the thing', send: (t) => events.push(t),
    }), null);
    assert.equal(session.session_title, null, 'session left untouched');
    assert.equal(events.length, 0);

    // rowCount 0 = the guarded UPDATE matched nothing (PR landed meanwhile).
    const raced = mockPool({ updateRowCount: 0, userRows: [{ content: 'do the thing' }] });
    const late = { id: 10, session_title: null, pr_number: null };
    assert.equal(await subject.titleFromFirstMessage({
      pool: raced, session: late, message: 'do the thing', send: (t) => events.push(t),
    }), null);
    assert.equal(late.session_title, null);
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

// ---- applyPrMetadata mirrors pr_title into session_title ----

// Same stub shape as tests/pr-metadata.test.js.
function loadPrMetadataWithStubs({ githubCalls }) {
  const llmPath = require.resolve('../src/services/llm');
  const ghPath = require.resolve('../src/services/github');
  const subjectPath = require.resolve('../src/services/pr-metadata');
  const orig = { llm: require.cache[llmPath], gh: require.cache[ghPath], subject: require.cache[subjectPath] };

  require.cache[llmPath] = {
    exports: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      generatePrMetadata: async () => ({ title: 'PR title', body: 'Body', usage: undefined, model: 'claude-haiku-4-5' }),
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: async (owner, repo, opts) => { githubCalls.push({ type: 'create', opts }); return { number: 42, html_url: 'https://example/pr/42' }; },
      updatePR: async (owner, repo, num, opts) => { githubCalls.push({ type: 'update', num, opts }); },
    },
    loaded: true, id: ghPath, filename: ghPath, paths: orig.gh ? orig.gh.paths : [],
  };
  delete require.cache[subjectPath];
  const subject = require('../src/services/pr-metadata');
  const restore = () => {
    if (orig.llm) require.cache[llmPath] = orig.llm; else delete require.cache[llmPath];
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

function prMetadataMockPool() {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: 'x', metadata: {} }] };
      return { rows: [] };
    },
  };
}

test('the create-PR UPDATE mirrors pr_title into session_title', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const pool = prMetadataMockPool();
    const session = { id: 1, branch_name: 'feat/x', pr_number: null, session_title: 'Early haiku title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.match(upd.sql, /session_title = \$3/, 'create-path UPDATE writes session_title');
    assert.equal(upd.params[2], 'PR title');
    assert.equal(session.session_title, 'PR title', 'in-memory session mirrors too');
  } finally {
    restore();
  }
});

test('the update-PR UPDATE mirrors pr_title into session_title', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const pool = prMetadataMockPool();
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'old', session_title: 'old' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'update');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title/.test(q.sql));
    assert.match(upd.sql, /session_title = \$1/, 'update-path UPDATE writes session_title');
    assert.equal(upd.params[0], 'PR title');
    assert.equal(session.session_title, 'PR title');
  } finally {
    restore();
  }
});

test('an OpenRouter PR title is the session name titleFromFirstMessage gave it (#1949)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ githubCalls });
  try {
    const ask = 'Make the leaderboard paginate 20 rows at a time and add a sticky header row for the column names';
    const sessionTitles = require('../src/services/session-title');
    const expected = sessionTitles.deterministicTitle(ask);
    assert.equal(expected.length, 72, 'long enough to exercise the trim');

    const pool = prMetadataMockPool();
    pool.query = async function query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_messages/i.test(sql)) return { rows: [{ role: 'user', content: ask, metadata: {} }] };
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: '', linked_issues: [], pr_linked_issues_applied: [], testing_md: null, testing_path: null, pr_testing_applied: null }] };
      }
      return { rows: [] };
    };
    const session = {
      id: 12, branch_name: 'dev/evan-17890406', pr_number: null,
      agent_backend: 'codex_openrouter', session_title: expected,
    };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: ask, ccSummary: 'Paginated the leaderboard.', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(githubCalls[0].opts.title, expected, 'PR title == pre-PR session name');
    assert.equal(session.session_title, expected, 'the mirrored name is unchanged');
  } finally {
    restore();
  }
});
