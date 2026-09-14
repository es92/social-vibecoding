'use strict';

// #896 — a coding turn recovered after a platform restart must end the way
// a normal turn ends: with the Mayor's wrap-up reply and its quick-reply
// pills, not a "Coding turn recovered after a platform restart." breadcrumb
// and silence.
//
// The pills AND the closing message on a dispatch turn come only from the
// phase-2 wrap-up in the live chat handler, which needs a request that a
// restart destroys. runRecoveredWrapUp re-issues that call off the boot
// path. These tests drive it directly against a mock pool and a stubbed
// llm, because the boot path itself would need the journal transport and
// the whole notification stack stood up.
//
// Run with: node --test tests/recovered-turn-wrapup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const recoveryPills = require('../src/services/recovery-pills');
const turnEffects = require('../src/services/turn-effects');

// ── require.cache stubbing (same shape as recovered-turn-spend) ─────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

// Load ../src/routes/sessions fresh with llm + limits stubbed.
//   chat — what llm.streamChat resolves to, or an Error to throw.
function loadSubject({ chat, llmEnabled = true, billing } = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    llm: require.resolve('../src/services/llm'),
    limits: require.resolve('../src/services/limits'),
    sessions: require.resolve('../src/routes/sessions'),
  };

  const chatCalls = [];
  const spendCalls = [];

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => null })],
    [paths.ws, stubModule(paths.ws, { broadcastGlobal: () => {}, pushNotificationToUser: () => 0 })],
    [paths.llm, stubModule(paths.llm, {
      isEnabled: () => llmEnabled,
      streamChat: async (args) => {
        chatCalls.push(args);
        if (chat instanceof Error) throw chat;
        return chat || {
          text: 'Sorted the leaderboard by score.',
          toolUses: [],
          usage: { input_tokens: 100, output_tokens: 40 },
          servedModel: 'claude-opus-5',
          rawContent: [],
        };
      },
      estimateCostCents: () => 7,
      FALLBACK_TARGET_MODEL: 'claude-sonnet-5',
    })],
    [paths.limits, stubModule(paths.limits, {
      resolveBillingPath: async () => billing || { apiKey: null, byok: false },
      recordSpend: async (_pool, userId, costCents, opts) => {
        spendCalls.push({ userId, costCents, byok: !!(opts && opts.byok) });
      },
      settleTurnSpend: async (pool, userId, costCents, opts = {}) => {
        const apply = async () => {
          spendCalls.push({ userId, costCents, byok: !!opts.turnByok });
          return opts.turnByok
            ? { platformCents: 0, byokCents: costCents }
            : { platformCents: costCents, byokCents: 0 };
        };
        if (!opts.turnId) return apply();
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: opts.turnId,
          effectKey: opts.effectKey || 'claude_spend',
          sessionId: opts.sessionId || null,
          run: apply,
        });
        return receipt.value;
      },
    })],
  ];
  delete require.cache[paths.sessions];
  const subject = require('../src/routes/sessions');

  return {
    subject, chatCalls, spendCalls,
    restore() {
      for (const [id, original] of originals) {
        if (original) require.cache[id] = original; else delete require.cache[id];
      }
      delete require.cache[paths.sessions];
    },
  };
}

// Mock pool: records inserts, answers the history + spec lookups.
function makePool({ history = [] } = {}) {
  const inserts = [];
  const receipts = new Map();
  const db = {
    inserts,
    receipts,
    query: async (sql, params = []) => {
      const text = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      const effectKey = `${params[0]}:${params[1]}`;
      if (/INSERT INTO turn_effects/i.test(text)) {
        if (receipts.has(effectKey)) return { rows: [], rowCount: 0 };
        receipts.set(effectKey, { state: 'pending', result: null });
        return { rows: [{ state: 'pending' }], rowCount: 1 };
      }
      if (/SELECT state, result FROM turn_effects/i.test(text)) {
        const row = receipts.get(effectKey);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/SELECT state FROM turn_effects/i.test(text)) {
        const row = receipts.get(effectKey);
        return { rows: row ? [{ state: row.state }] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE turn_effects/i.test(text)) {
        const row = receipts.get(effectKey);
        if (!row || row.state !== 'pending') return { rows: [], rowCount: 0 };
        row.state = 'completed';
        row.result = JSON.parse(params[2]);
        return { rows: [{ result: row.result }], rowCount: 1 };
      }
      if (/INSERT INTO chat_session_messages/i.test(text)) {
        inserts.push({
          role: /'assistant'/.test(text) ? 'assistant' : 'system',
          content: params[1],
          model: params[2],
          tokens: params[3],
          costCents: params[4],
          metadata: JSON.parse(String(params[5] ?? params[2] ?? '{}')),
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM chat_session_messages/i.test(text) && /ORDER BY id ASC/i.test(text)) {
        return { rows: history };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  db.connect = async () => ({ query: db.query, release() {} });
  return db;
}

const SESSION = {
  id: 510, user_id: 3, app_id: 1, app_name: 'Homeroom', app_self_hosted: true,
  pr_number: 893, pr_title: 'Sort the leaderboard', status: 'active',
};

const HISTORY = [
  { id: 1, role: 'user', content: 'Make the leaderboard sort by score', metadata: {} },
  { id: 2, role: 'assistant', content: "I'll have the coding agent do that.", metadata: {} },
  {
    id: 3, role: 'system', content: 'Claude Code finished',
    metadata: { ccOutput: 'Sorted rows by score descending.', ccOutcome: 'success' },
  },
];

async function run(opts = {}, callArgs = {}) {
  const harness = loadSubject(opts);
  const pool = makePool({ history: opts.history || HISTORY });
  const emits = [];
  try {
    let res;
    for (let i = 0; i < (callArgs.replays || 1); i += 1) {
      res = await harness.subject.runRecoveredWrapUp({
        pool,
        config: { dataEncryptionKey: 'k' },
        session: { ...SESSION, ...(callArgs.session || {}) },
        sessionId: 510,
        outcome: callArgs.outcome || 'code',
        dispatchSummary: callArgs.dispatchSummary
          || 'Commit abc12345 pushed to dev/evan-1. Opened PR #893. Staging redeployed: https://x.example',
        fallbackPillKind: callArgs.fallbackPillKind || 'code_done',
        turnModel: callArgs.turnModel === undefined ? 'claude-opus-5' : callArgs.turnModel,
        turnId: callArgs.turnId || null,
        emit: (event, data) => emits.push({ event, data }),
      });
    }
    return { res, pool, emits, ...harness };
  } finally {
    harness.restore();
  }
}

// ── the happy path: a normal-looking assistant reply ────────────────────

test('a recovered build turn ends on an ordinary Mayor assistant row', async () => {
  const { res, pool } = await run();

  assert.equal(res.ok, true);
  assert.equal(pool.inserts.length, 1, 'exactly one row: the wrap-up reply');
  const row = pool.inserts[0];
  assert.equal(row.role, 'assistant',
    'the closing message is an assistant bubble, not a grey system breadcrumb');
  assert.equal(row.content, 'Sorted the leaderboard by score.');
  assert.equal(row.model, 'claude-opus-5');
  assert.equal(row.tokens, 140);
  assert.equal(row.costCents, 7);
  // The restart is preserved for operators, not for the reader.
  assert.equal(row.metadata.recovered, true);
  assert.doesNotMatch(row.content, /restart|recover/i);
});

test('the wrap-up bills the session owner like a live turn does', async () => {
  const { spendCalls } = await run();
  assert.deepEqual(spendCalls, [{ userId: 3, costCents: 7, byok: false }]);
});

test('a durable wrap-up replay does not repeat its provider call, row, pills, or debit', async () => {
  const turnId = '00000000-0000-4000-8000-000000000510';
  const { pool, chatCalls, spendCalls, emits } = await run({}, {
    turnId,
    replays: 2,
  });

  assert.equal(chatCalls.length, 1, 'the paid Mayor call is at most once');
  assert.equal(pool.inserts.length, 1, 'the assistant row is exactly once');
  assert.equal(spendCalls.length, 1, 'the usage mutation is exactly once');
  assert.deepEqual(emits.map((e) => e.event), ['mayor_reasoning', 'quick_replies'],
    'a receipt replay emits no duplicate bubble or pill event');
  assert.deepEqual(
    [...pool.receipts.entries()].map(([key, row]) => [key, row.state]).sort(),
    [
      [`${turnId}:turn_wrapup_llm`, 'completed'],
      [`${turnId}:turn_wrapup_message`, 'completed'],
      [`${turnId}:turn_wrapup_pills`, 'completed'],
      [`${turnId}:turn_wrapup_spend`, 'completed'],
    ],
  );
});

test('a BYOK owner pays with their own key', async () => {
  const { spendCalls, chatCalls } = await run({ billing: { apiKey: 'sk-ant-own', byok: true } });
  assert.equal(chatCalls[0].apiKey, 'sk-ant-own');
  assert.deepEqual(spendCalls, [{ userId: 3, costCents: 7, byok: true }]);
});

// ── what the model is told ──────────────────────────────────────────────

test('the model is given the dispatch outcome and told not to mention the restart', async () => {
  const { chatCalls } = await run({}, { dispatchSummary: 'Commit deadbeef pushed to dev/evan-1.' });

  assert.equal(chatCalls.length, 1, 'exactly one wrap-up call per recovered turn');
  const note = chatCalls[0].messages[chatCalls[0].messages.length - 1];
  assert.equal(note.role, 'user', 'the outcome arrives as a synthetic user note (the tool_use died)');
  assert.match(note.content, /Commit deadbeef pushed to dev\/evan-1\./,
    'the wrap-up describes what actually happened, not a guess from the transcript');
  assert.match(note.content, /do NOT mention platform restarts, recovery, interruptions/,
    'the whole point of #896: the reply must read like any other finished build');
  assert.match(note.content, /suggest_replies/);
});

test('the transcript — including the agent\'s own summary — is replayed as context', async () => {
  const { chatCalls } = await run();
  const { messages } = chatCalls[0];

  assert.equal(messages[0].role, 'user');
  assert.match(String(messages[0].content), /Make the leaderboard sort by score/);
  // buildMayorMessages folds a ccOutput system row in under the completion
  // marker — the recovery persists that row before calling us, so the
  // wrap-up can describe what was built rather than inventing it.
  assert.ok(messages.some((m) => /\[CODING AGENT COMPLETED\]/.test(String(m.content))),
    "the coding agent's summary reaches the Mayor's context");
});

test('the wrap-up can suggest pills but cannot dispatch again', async () => {
  const { chatCalls } = await run();
  const toolNames = (chatCalls[0].tools || []).map((t) => t.name);
  assert.deepEqual(toolNames, ['suggest_replies'],
    'exposing a dispatch tool here would let a recovery start another build');
});

// ── pills ───────────────────────────────────────────────────────────────

test('pills come from the model when it calls suggest_replies', async () => {
  const modelPills = ['Preview the change', 'Propose it to the group'];
  const { pool, emits } = await run({
    chat: {
      text: 'Done — the leaderboard sorts by score now.',
      toolUses: [{ id: 't1', name: 'suggest_replies', input: { replies: modelPills } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      rawContent: [],
    },
  });

  assert.deepEqual(pool.inserts[0].metadata.quickReplies, modelPills);
  const pillEvent = emits.find((e) => e.event === 'quick_replies');
  assert.deepEqual(pillEvent.data.replies, modelPills);
});

test('pills fall back to the deterministic set when the model suggests none', async () => {
  const { pool } = await run({}, { fallbackPillKind: 'code_done' });
  assert.deepEqual(pool.inserts[0].metadata.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('code_done'),
    'the bar above the composer must never come back empty');
});

// ── live delivery ───────────────────────────────────────────────────────

test('an open tab gets the bubble then the pills, and never a "done"', async () => {
  const { emits } = await run();

  assert.deepEqual(emits.map((e) => e.event), ['mayor_reasoning', 'quick_replies'],
    'mayor_reasoning must land first — quick_replies attaches to the newest assistant bubble');
  assert.equal(emits[0].data.text, 'Sorted the leaderboard by score.');
  // A concurrent user turn could be streaming in that tab; 'done' would
  // tear its client-side streaming state down.
  assert.ok(!emits.some((e) => e.event === 'done'));
});

// ── degradation: recovery must survive a failed wrap-up ─────────────────

test('a failed model call still closes the turn with a static line and pills', async () => {
  const { res, pool, emits } = await run({ chat: new Error('anthropic 529 overloaded') });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'llm_failed');
  const row = pool.inserts[0];
  assert.equal(row.role, 'assistant');
  assert.equal(row.content, '_Done._');
  assert.deepEqual(row.metadata.quickReplies, recoveryPills.buildRecoveryQuickReplies('code_done'));
  assert.ok(emits.some((e) => e.event === 'mayor_reasoning'));
});

test('a configured-off LLM degrades the same way, without calling out', async () => {
  const { res, pool, chatCalls } = await run({ llmEnabled: false });

  assert.equal(res.reason, 'llm_disabled');
  assert.equal(chatCalls.length, 0);
  assert.equal(pool.inserts[0].content, '_Done._');
});

test('a recovered turn with no current payer closes without a provider call', async () => {
  const { res, pool, chatCalls, spendCalls } = await run({
    billing: {
      error: 'Connect GitHub or X to unlock platform-funded AI.',
      reason: 'verification_required',
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'billing_unavailable');
  assert.equal(chatCalls.length, 0, 'recovery does not bypass the current credit tier');
  assert.equal(spendCalls.length, 0);
  assert.equal(pool.inserts[0].content, '_Done._');
  assert.deepEqual(pool.inserts[0].metadata.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('code_done'));
});

test('the static fallback matches the outcome it is closing', async () => {
  const spec = await run({ chat: new Error('nope') }, { outcome: 'spec', fallbackPillKind: 'spec_done' });
  assert.match(spec.pool.inserts[0].content, /Spec updated/);
  assert.deepEqual(spec.pool.inserts[0].metadata.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('spec_done'));

  const failed = await run({ chat: new Error('nope') }, { outcome: 'push_failed', fallbackPillKind: 'push_failed' });
  assert.match(failed.pool.inserts[0].content, /didn't complete successfully/);

  const none = await run({ chat: new Error('nope') }, { outcome: 'no_changes' });
  assert.match(none.pool.inserts[0].content, /without changing anything/);
});

test('an empty model reply falls back rather than persisting a blank bubble', async () => {
  const { pool } = await run({
    chat: { text: '   ', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 }, rawContent: [] },
  });
  assert.equal(pool.inserts[0].content, '_Done._');
});

// A hallucinated [CODING AGENT COMPLETED] must never survive into a
// persisted assistant row — it would fake a coding run that never happened.
test('a faked completion marker is stripped from the wrap-up', async () => {
  const { pool } = await run({
    chat: {
      text: 'All set.\n\n[CODING AGENT COMPLETED]:\nfabricated run',
      toolUses: [], usage: { input_tokens: 1, output_tokens: 1 }, rawContent: [],
    },
  });
  assert.equal(pool.inserts[0].content, 'All set.');
});
