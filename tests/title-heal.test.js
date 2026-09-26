// Tests for the title auto-heal path:
//  - llm.stripLoneSurrogates — the sanitizer that keeps one malformed
//    character in old chat history from poisoning PR-metadata calls.
//  - pr-metadata fallback marking — pr_title_fallback is persisted TRUE
//    when the fallback template fires, never downgrades an existing real
//    title, and clears on successful regeneration.
//  - services/title-heal — the sweeper that retries generation for
//    fallback-titled PRs and queued feedback issues.
//
// Run with: node --test tests/title-heal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ---- stripLoneSurrogates (pure; real llm.js, no client needed) ----

test('stripLoneSurrogates keeps valid pairs, drops lone surrogates', () => {
  const { stripLoneSurrogates } = require('../src/services/llm');
  // Valid surrogate pair (emoji) passes through untouched.
  assert.equal(stripLoneSurrogates('hello \u{1F44D} world'), 'hello \u{1F44D} world');
  // Lone high surrogate (truncated emoji) is dropped.
  assert.equal(stripLoneSurrogates('abc\uD83Ddef'), 'abcdef');
  // Lone low surrogate is dropped.
  assert.equal(stripLoneSurrogates('abc\uDE00def'), 'abcdef');
  // High surrogate at end-of-string (nothing to pair with) is dropped.
  assert.equal(stripLoneSurrogates('abc\uD83D'), 'abc');
  // Two highs in a row: first is lone (dropped), second pairs with the low.
  assert.equal(stripLoneSurrogates('a\uD83D\uD83D\uDE00b'), 'a\uD83D\uDE00b');
  // Non-strings coerce safely.
  assert.equal(stripLoneSurrogates(null), '');
  assert.equal(stripLoneSurrogates(undefined), '');
  assert.equal(stripLoneSurrogates(42), '42');
});

// ---- pr-metadata fallback marking ----
//
// Same require.cache stubbing pattern as tests/pr-metadata.test.js: swap
// ./llm and ./github before loading the unit under test.

function loadPrMetadataWithStubs({ generate, githubCalls }) {
  const llmPath = require.resolve('../src/services/llm');
  const ghPath = require.resolve('../src/services/github');
  const subjectPath = require.resolve('../src/services/pr-metadata');
  const orig = {
    llm: require.cache[llmPath],
    gh: require.cache[ghPath],
    subject: require.cache[subjectPath],
  };

  require.cache[llmPath] = {
    exports: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      generatePrMetadata: generate,
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: async (owner, repo, opts) => {
        githubCalls.push({ type: 'create', owner, repo, opts });
        return { number: 42, html_url: 'https://example/pr/42' };
      },
      updatePR: async (owner, repo, num, opts) => {
        githubCalls.push({ type: 'update', owner, repo, num, opts });
      },
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

function mockPool() {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return {
          rows: [{
            spec_md: '', linked_issues: [], pr_linked_issues_applied: [],
            testing_md: null, testing_path: null, pr_testing_applied: null,
            pr_visuals_applied: null, pr_summary_md: null,
          }],
        };
      }
      if (/FROM chat_session_messages/i.test(sql)) {
        return { rows: [{ role: 'user', content: 'Build it', metadata: {} }] };
      }
      return { rows: [] };
    },
  };
}

const boom = async () => { throw new Error('credits exhausted'); };

test('fallback on a NEW PR persists pr_title_fallback = TRUE', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ generate: boom, githubCalls });
  try {
    const pool = mockPool();
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Build it', ccSummary: 'Did it', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(githubCalls[0].opts.title, "evan's changes");
    assert.equal(res.prTitle, "evan's changes");
    assert.equal(session.pr_title_fallback, true, 'session flag set in place');
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.ok(/pr_title_fallback = \$8/.test(upd.sql), 'flag column in the new-PR write');
    assert.equal(upd.params[7], true, 'flag persisted TRUE');
  } finally {
    restore();
  }
});

test('fallback on an EXISTING PR with a real title never downgrades it', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ generate: boom, githubCalls });
  try {
    const pool = mockPool();
    const session = {
      id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u',
      pr_title: 'Add dark-mode toggle', pr_title_fallback: false,
    };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 0, 'no GitHub call — the real title is kept');
    assert.equal(res.prTitle, 'Add dark-mode toggle');
    assert.equal(session.pr_title_fallback, false, 'not marked — the live title is fine');
    assert.ok(!pool.queries.some((q) => /pr_title_fallback = TRUE/.test(q.sql)));
  } finally {
    restore();
  }
});

test('fallback on an EXISTING PR already carrying the template marks the row', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({ generate: boom, githubCalls });
  try {
    const pool = mockPool();
    // e.g. a legacy row created before the flag existed.
    const session = {
      id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u',
      pr_title: "evan's changes", pr_title_fallback: false,
    };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 0, 'no GitHub call needed — title unchanged');
    assert.equal(session.pr_title_fallback, true);
    assert.ok(pool.queries.some((q) => /SET pr_title_fallback = TRUE/.test(q.sql)));
  } finally {
    restore();
  }
});

test('successful regeneration clears pr_title_fallback on the PR update', async () => {
  const githubCalls = [];
  const { subject, restore } = loadPrMetadataWithStubs({
    generate: async () => ({ title: 'Add dark-mode toggle', body: 'Body', summary: '', usage: undefined, model: 'claude-haiku-4-5' }),
    githubCalls,
  });
  try {
    const pool = mockPool();
    const session = {
      id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u',
      pr_title: "evan's changes", pr_title_fallback: true,
    };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'update');
    assert.equal(githubCalls[0].opts.title, 'Add dark-mode toggle');
    assert.equal(res.prTitle, 'Add dark-mode toggle');
    assert.equal(session.pr_title_fallback, false);
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title = \$1/.test(q.sql));
    assert.ok(/pr_title_fallback = FALSE/.test(upd.sql), 'flag cleared in the same write');
  } finally {
    restore();
  }
});

// ---- services/title-heal ----

function loadTitleHealWithStubs({ llm: llmStub, github: ghStub, prMetadata: pmStub, ws: wsStub }) {
  const paths = {
    llm: require.resolve('../src/services/llm'),
    gh: require.resolve('../src/services/github'),
    pm: require.resolve('../src/services/pr-metadata'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/title-heal'),
  };
  const orig = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, require.cache[p]]));

  const install = (p, exports, key) => {
    require.cache[p] = {
      exports, loaded: true, id: p, filename: p,
      paths: orig[key] ? orig[key].paths : [],
    };
  };
  install(paths.llm, llmStub, 'llm');
  install(paths.gh, ghStub, 'gh');
  install(paths.pm, pmStub, 'pm');
  install(paths.ws, wsStub, 'ws');
  delete require.cache[paths.subject];
  const subject = require('../src/services/title-heal');

  const restore = () => {
    for (const [k, p] of Object.entries(paths)) {
      if (k === 'subject') { delete require.cache[p]; if (orig[k]) require.cache[p] = orig[k]; continue; }
      if (orig[k]) require.cache[p] = orig[k]; else delete require.cache[p];
    }
  };
  return { subject, restore };
}

const noopWs = { pushVoteUpdate: () => {}, pushIssueUpdate: () => {} };

test('healIssueTitles: success retitles the issue, deletes the queue row, announces', async () => {
  // The PAT-vs-installation fallback now lives in github.patchIssueTitle
  // (#556) — the sweeper just calls it.
  const ghCalls = [];
  const wsCalls = [];
  const { subject, restore } = loadTitleHealWithStubs({
    llm: {
      isEnabled: () => true,
      generateIssueTitle: async ({ description }) => {
        assert.equal(description, 'The button is broken on mobile');
        return { title: 'Fix broken button on mobile', usage: undefined, model: 'claude-haiku-4-5' };
      },
    },
    github: {
      safeMention: (s) => s,
      patchIssueTitle: async (owner, repo, n, title) => { ghCalls.push({ owner, repo, n, title }); },
      invalidateIssuesCache: () => {},
    },
    prMetadata: {},
    ws: { pushVoteUpdate: () => {}, pushIssueUpdate: (d) => wsCalls.push(d) },
  });
  try {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM title_heal_queue/.test(sql)) {
          return { rows: [{ id: 5, owner: 'acme', repo: 'app', issue_number: 12, description: 'The button is broken on mobile', attempts: 0 }] };
        }
        if (/SELECT id, slug, repo_url FROM apps/.test(sql)) {
          return { rows: [{ id: 3, slug: 'my-app', repo_url: 'https://github.com/acme/app' }] };
        }
        return { rows: [] };
      },
    };
    const res = await subject.healIssueTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 1 });
    assert.deepEqual(ghCalls, [{ owner: 'acme', repo: 'app', n: 12, title: 'Fix broken button on mobile' }]);
    assert.ok(queries.some((q) => /DELETE FROM title_heal_queue/.test(q.sql)), 'queue row deleted');
    assert.equal(wsCalls.length, 1, 'issue_update announced');
    assert.equal(wsCalls[0].appSlug, 'my-app');
    assert.equal(wsCalls[0].issueNumber, 12);
  } finally {
    restore();
  }
});

test('healIssueTitles: a refusal reply is never PATCHed; the reporter\'s words are, and the row is done (#3193)', async () => {
  // The real generateIssueTitle behind a stubbed client, answering with
  // #3105's published refusal as the request list shows it.
  const realLlm = require('../src/services/llm');
  const prevClient = realLlm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'I need more information to create a meaningful GitHub issue title. "Lfg" (looking for group) doesn\'t describe a specific problem or feature request.\n\nCould you provide details about what needs to be f' }],
        usage: { input_tokens: 40, output_tokens: 30 },
        stop_reason: 'end_turn',
      }),
    },
  });
  const ghCalls = [];
  const { subject, restore } = loadTitleHealWithStubs({
    llm: { isEnabled: () => true, generateIssueTitle: realLlm.generateIssueTitle },
    github: {
      safeMention: (s) => s,
      patchIssueTitle: async (owner, repo, n, title) => { ghCalls.push(title); },
      invalidateIssuesCache: () => {},
    },
    prMetadata: {},
    ws: noopWs,
  });
  try {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM title_heal_queue/.test(sql)) {
          return { rows: [{ id: 5, owner: 'acme', repo: 'app', issue_number: 12, description: 'Lfg', attempts: 0 }] };
        }
        return { rows: [] };
      },
    };
    const res = await subject.healIssueTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 1 });
    assert.deepEqual(ghCalls, ['Feedback: Lfg']);
    assert.ok(queries.some((q) => /DELETE FROM title_heal_queue/.test(q.sql)), 'queue row deleted');
    assert.ok(!queries.some((q) => /UPDATE title_heal_queue/.test(q.sql)), 'no backoff retry');
  } finally {
    restore();
    realLlm._setClientForTests(prevClient);
  }
});

test('healIssueTitles: failure backs off; final attempt abandons the row', async () => {
  delete process.env.GITHUB_BOT_TOKEN;
  const { subject, restore } = loadTitleHealWithStubs({
    llm: {
      isEnabled: () => true,
      generateIssueTitle: async () => { throw new Error('still no credits'); },
    },
    github: { safeMention: (s) => s, patchIssueTitle: async () => {}, invalidateIssuesCache: () => {} },
    prMetadata: {},
    ws: noopWs,
  });
  try {
    // First failure: attempts 0 → 1, row kept with a future next_attempt_at.
    let queries = [];
    let pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM title_heal_queue/.test(sql)) {
          return { rows: [{ id: 5, owner: 'acme', repo: 'app', issue_number: 12, description: 'd', attempts: 0 }] };
        }
        return { rows: [] };
      },
    };
    let res = await subject.healIssueTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 0 });
    const upd = queries.find((q) => /UPDATE title_heal_queue/.test(q.sql));
    assert.ok(upd, 'backoff update issued');
    assert.equal(upd.params[1], 1, 'attempts bumped to 1');
    assert.ok(!queries.some((q) => /DELETE FROM title_heal_queue/.test(q.sql)));

    // At the attempt cap: the row is abandoned (deleted, no backoff update).
    queries = [];
    pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM title_heal_queue/.test(sql)) {
          return { rows: [{ id: 5, owner: 'acme', repo: 'app', issue_number: 12, description: 'd', attempts: subject.MAX_ISSUE_ATTEMPTS - 1 }] };
        }
        return { rows: [] };
      },
    };
    res = await subject.healIssueTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 0 });
    assert.ok(queries.some((q) => /DELETE FROM title_heal_queue/.test(q.sql)), 'row abandoned at the cap');
    assert.ok(!queries.some((q) => /UPDATE title_heal_queue/.test(q.sql)));
  } finally {
    restore();
  }
});

test('healPrTitles: re-drives applyPrMetadata and broadcasts when the flag clears', async () => {
  const applied = [];
  const wsCalls = [];
  const { subject, restore } = loadTitleHealWithStubs({
    llm: { isEnabled: () => true },
    github: { safeMention: (s) => s, patchIssueTitle: async () => {}, invalidateIssuesCache: () => {} },
    prMetadata: {
      applyPrMetadata: async ({ session, repoOwner, repoName, username, userId }) => {
        applied.push({ sessionId: session.id, repoOwner, repoName, username, userId });
        // Simulate a successful heal: applyPrMetadata clears the flag in place.
        session.pr_title = 'Regenerated title';
        session.pr_title_fallback = false;
        return { prNumber: session.pr_number, prUrl: 'u', prTitle: 'Regenerated title' };
      },
    },
    ws: { pushVoteUpdate: (d) => wsCalls.push(d), pushIssueUpdate: () => {} },
  });
  try {
    const pool = {
      async query(sql) {
        if (/pr_title_fallback = TRUE/.test(sql)) {
          return {
            rows: [{
              id: 7, app_id: 3, pr_number: 42, pr_title: "evan's changes",
              pr_title_fallback: true, branch_name: 'feat/x', status: 'promoted',
              heal_app_slug: 'my-app', heal_repo_url: 'https://github.com/acme/app',
              heal_username: 'evan',
            }],
          };
        }
        return { rows: [] };
      },
    };
    const res = await subject.healPrTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 1 });
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0], { sessionId: 7, repoOwner: 'acme', repoName: 'app', username: 'evan', userId: null });
    assert.equal(wsCalls.length, 1, 'vote_update broadcast so open panels refetch');
    assert.equal(wsCalls[0].sessionId, 7);
    assert.equal(wsCalls[0].appSlug, 'my-app');
  } finally {
    restore();
  }
});

test('healPrTitles: no broadcast when the heal attempt falls back again', async () => {
  const wsCalls = [];
  const { subject, restore } = loadTitleHealWithStubs({
    llm: { isEnabled: () => true },
    github: { safeMention: (s) => s, patchIssueTitle: async () => {}, invalidateIssuesCache: () => {} },
    prMetadata: {
      applyPrMetadata: async ({ session }) => {
        // LLM still down: the flag stays TRUE (fallback fired again).
        session.pr_title_fallback = true;
        return { prNumber: session.pr_number, prUrl: 'u', prTitle: session.pr_title };
      },
    },
    ws: { pushVoteUpdate: (d) => wsCalls.push(d), pushIssueUpdate: () => {} },
  });
  try {
    const pool = {
      async query(sql) {
        if (/pr_title_fallback = TRUE/.test(sql)) {
          return {
            rows: [{
              id: 7, app_id: 3, pr_number: 42, pr_title: "evan's changes",
              pr_title_fallback: true, branch_name: 'feat/x', status: 'promoted',
              heal_app_slug: 'my-app', heal_repo_url: 'https://github.com/acme/app',
              heal_username: 'evan',
            }],
          };
        }
        return { rows: [] };
      },
    };
    const res = await subject.healPrTitles(pool);
    assert.deepEqual(res, { scanned: 1, healed: 0 });
    assert.equal(wsCalls.length, 0);
  } finally {
    restore();
  }
});
