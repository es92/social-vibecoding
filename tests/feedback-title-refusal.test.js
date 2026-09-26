// #3193: the model's refusal text must never become a feedback issue's
// title. Four requests on the platform's own board (#3130, #3107, #3106,
// #3105) were filed under a reply such as "I need more information to
// create a meaningful GitHub issue title…" because generateIssueTitle
// returned whatever text came back.
//
// These run the REAL generateIssueTitle behind a stubbed Anthropic client,
// through both routes that call it:
//
//  - POST /api/feedback files the issue under the reporter's own words
//    ("Feedback: Lfg"), reports titleFallback: false, bills the call, and
//    queues no title heal: a retry would only get the same answer;
//  - a failed call still files with the old template and queues a heal,
//    exactly as before;
//  - POST /api/feedback/title previews the title that would be filed.
//
// Run with: node --test tests/feedback-title-refusal.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Override collaborators BEFORE requiring the route module (same pattern
// as tests/feedback-custom-title.test.js).
const poolMod = require('../src/db/pool');
let poolQueries = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return { rows: [] };
  },
});

const llm = require('../src/services/llm');

const limits = require('../src/services/limits');
let spendCalls = [];
limits.resolveBillingPath = async () => ({ apiKey: null, byok: false });
limits.recordSpend = async (pool, userId, costCents, opts) => {
  spendCalls.push({ userId, costCents, opts });
};

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

// Platform-target feedback files via a raw fetch to api.github.com with
// the PAT; stub it and capture the POSTed body.
process.env.GITHUB_BOT_TOKEN = 'test-pat';
let ghCreates = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    ghCreates.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 88, html_url: 'https://github.com/plat/repo/issues/88' }),
    };
  }
  return realFetch(url, opts);
};

const { feedbackRoutes } = require('../src/routes/feedback');
const express = require('express');

// The Anthropic client generateIssueTitle talks to. `reply` is what the
// model sends back; null makes the call fail outright.
let reply = null;
let modelCalls = 0;
llm._setClientForTests({
  messages: {
    create: async () => {
      modelCalls++;
      if (reply === null) throw new Error('credit balance is too low');
      return {
        content: [{ type: 'text', text: reply }],
        usage: { input_tokens: 40, output_tokens: 30 },
        stop_reason: 'end_turn',
      };
    },
  },
});

// #3106's published title, as the request list shows it.
const LFG_REFUSAL = 'I need more context to create an appropriate issue title. "Lfg" (looking for group) is too vague. Could you provide details about:\n\n- What specific problem needs to be fixed or feature needs to be add';
// #3107's.
const PRAISE_REFUSAL = 'I need feedback describing a problem or issue to create a GitHub issue title. The statement "I like this website" is positive feedback without any specific problem or improvement request. Please provi';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, path, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const queuedHeal = () => poolQueries.some((q) => /INSERT INTO title_heal_queue/.test(q.sql));

beforeEach(() => {
  poolQueries = [];
  ghCreates = [];
  spendCalls = [];
  modelCalls = 0;
  reply = null;
});

test('a refusal sent as plain text files under the reporter\'s words, with no heal queued', async () => {
  reply = LFG_REFUSAL;
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback', { description: 'Lfg' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Feedback: Lfg');
    assert.equal(body.titleFallback, false);
    assert.equal(ghCreates.length, 1);
    assert.equal(ghCreates[0].title, 'Feedback: Lfg');
    assert.doesNotMatch(ghCreates[0].title, /I need|issue title|\n/);
    assert.equal(modelCalls, 1);
    assert.equal(spendCalls.length, 1, 'the model call is still billed');
    assert.ok(!queuedHeal(), 'no title_heal_queue row: a retry gets the same answer');
  } finally {
    server.close();
  }
});

test('a structured non-actionable reply files under the reporter\'s words', async () => {
  reply = JSON.stringify({ actionable: false, title: '' });
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback', { description: 'I like this website' });
    const body = await res.json();
    assert.equal(body.title, 'Feedback: I like this website');
    assert.equal(ghCreates[0].title, 'Feedback: I like this website');
    assert.ok(!queuedHeal());
  } finally {
    server.close();
  }
});

test('an actionable reply is filed under the model\'s title as before', async () => {
  reply = JSON.stringify({ actionable: true, title: 'Fix leaderboard sort on mobile' });
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback', { description: 'The leaderboard sorts wrong on my phone' });
    const body = await res.json();
    assert.equal(body.title, 'Fix leaderboard sort on mobile');
    assert.equal(body.titleFallback, false);
    assert.equal(ghCreates[0].title, 'Fix leaderboard sort on mobile');
    assert.ok(!queuedHeal());
  } finally {
    server.close();
  }
});

test('a failed call still files with the fallback template and queues a heal', async () => {
  reply = null;
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback', { description: 'Lfg' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, llm.FEEDBACK_FALLBACK_TITLE);
    assert.equal(body.titleFallback, true);
    assert.equal(ghCreates[0].title, llm.FEEDBACK_FALLBACK_TITLE);
    assert.ok(queuedHeal(), 'the sweeper retries once the model is back');
  } finally {
    server.close();
  }
});

test('the title preview shows the reporter\'s words instead of a refusal', async () => {
  reply = PRAISE_REFUSAL;
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback/title', { description: 'I like this website' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Feedback: I like this website');
    assert.equal(spendCalls.length, 1);
  } finally {
    server.close();
  }
});
