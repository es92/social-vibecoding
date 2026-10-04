'use strict';

// The agent session's composer and live turn (#2779 follow-up): what the dev
// chat's composer had that the conversation with the Mayor lacked.
//
//   1. SAVED DRAFTS (#798, #940). While the Mayor works, the one button is a
//      green Save: the text is parked in a per-account list, never sent on
//      its own, and sent later by a tap. The routes are the dev chat's
//      contract over a table of the conversation's own.
//   2. WHAT IS TYPED AND NOT SENT is kept per conversation in this browser.
//   3. STOP HANDS THE MESSAGE BACK to an empty box, as the dev chat's does.
//   4. EACH MODEL SAYS WHAT A TYPICAL CHANGE COSTS on it (#2570), never as a
//      bare amount.
//   5. A REPLY SAYS WHAT IT COST, and a turn that did not finish offers to try
//      again.
//   6. THE OUTLINE IS THE CARD'S, in every engine, and the Mayor at work is
//      three dots, not a box across the pane. The tab says "⏳ Thinking…".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. The drafts routes ───────────────────────────────────────────────

const OWNER = { id: 7, username: 'ada' };
const OTHER = { id: 8, username: 'bo' };

function mockPool(state) {
  const calls = [];
  const run = async (raw, params = []) => {
    const sql = String(raw).replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
    if (/FROM agent_sessions WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      const [id, userId] = params;
      return { rows: state.sessions.some((s) => s.id === id && s.user_id === userId) ? [{ id }] : [] };
    }
    if (/SELECT COUNT\(\*\)/.test(sql)) {
      const [id, draftId] = params;
      const mine = state.drafts.filter((d) => d.agent_session_id === id);
      return { rows: [{ total: mine.length, mine: mine.filter((d) => d.draft_id === draftId).length }] };
    }
    if (/INSERT INTO agent_session_drafts/.test(sql)) {
      const [id, userId, draftId, content, savedAt] = params;
      if (state.drafts.some((d) => d.agent_session_id === id && d.draft_id === draftId)) return { rows: [], rowCount: 0 };
      state.drafts.push({ agent_session_id: id, user_id: userId, draft_id: draftId, content, saved_at: savedAt || new Date(state.drafts.length * 1000) });
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM agent_session_drafts/.test(sql)) {
      const [id, draftId] = params;
      const before = state.drafts.length;
      state.drafts = state.drafts.filter((d) => !(d.agent_session_id === id && d.draft_id === draftId));
      return { rows: [], rowCount: before - state.drafts.length };
    }
    if (/FROM agent_session_drafts/.test(sql)) {
      const [id] = params;
      return { rows: state.drafts.filter((d) => d.agent_session_id === id).sort((a, b) => a.saved_at - b.saved_at) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { calls, query: run, connect: async () => ({ query: run, release() {} }) };
}

// The route reads the socket module when it pushes, so the stand-in stays in
// place for the whole test (withSocket), and the pool only while the route is
// built.
function withSocket(pushes, fn) {
  return async () => {
    const wsPath = require.resolve('../src/services/ws');
    const saved = require.cache[wsPath];
    require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: { pushToUser: (id, payload) => pushes.push([id, payload]) } };
    try {
      await fn();
    } finally {
      if (saved) require.cache[wsPath] = saved; else delete require.cache[wsPath];
    }
  };
}

function appWith(pool, user) {
  const poolPath = require.resolve('../src/db/pool');
  const routePath = require.resolve('../src/routes/agent-session-drafts');
  const saved = [poolPath, routePath].map((p) => [p, require.cache[p]]);
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => pool } };
  delete require.cache[routePath];
  const { agentSessionDraftsRoutes } = require('../src/routes/agent-session-drafts');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(agentSessionDraftsRoutes());
  for (const [p, entry] of saved) {
    if (entry) require.cache[p] = entry; else delete require.cache[p];
  }
  return app;
}

async function call(app, method, url, body) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const pushes = [];
test('drafts: owner only (a flat 404), idempotent saves under the cap, idempotent deletes, every device told', withSocket(pushes, async () => {
  const state = { sessions: [{ id: 5, user_id: 7 }], drafts: [] };
  const pool = mockPool(state);
  const app = appWith(pool, OWNER);

  assert.equal((await call(appWith(pool, OTHER), 'GET', '/api/agent-sessions/5/drafts')).status, 404,
    'someone else\'s conversation is indistinguishable from none');
  assert.equal((await call(app, 'GET', '/api/agent-sessions/nope/drafts')).status, 400);

  const saved = await call(app, 'POST', '/api/agent-sessions/5/drafts', { id: 'd1', text: '  make it blue  ' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.drafts.map((d) => [d.id, d.text]), [['d1', 'make it blue']]);
  assert.deepEqual(pushes.at(-1), [7, { type: 'agent_session_drafts_changed', agentSessionId: 5 }]);
  const again = await call(app, 'POST', '/api/agent-sessions/5/drafts', { id: 'd1', text: 'make it blue' });
  assert.equal(again.body.drafts.length, 1, 're-sending a stored draft is a no-op');

  assert.equal((await call(app, 'POST', '/api/agent-sessions/5/drafts', { id: 'bad id!', text: 'x' })).status, 400);
  assert.equal((await call(app, 'POST', '/api/agent-sessions/5/drafts', { text: '   ' })).status, 400);
  assert.equal((await call(appWith(pool, OTHER), 'POST', '/api/agent-sessions/5/drafts', { text: 'x' })).status, 404);

  for (let i = 2; i <= 20; i += 1) state.drafts.push({ agent_session_id: 5, user_id: 7, draft_id: `d${i}`, content: `n${i}`, saved_at: new Date(i * 1000) });
  const full = await call(app, 'POST', '/api/agent-sessions/5/drafts', { id: 'd21', text: 'one too many' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'draft_cap');
  assert.equal((await call(app, 'POST', '/api/agent-sessions/5/drafts', { id: 'd2', text: 'n2' })).status, 200,
    'a draft already stored never trips the cap');

  const gone = await call(app, 'DELETE', '/api/agent-sessions/5/drafts/d1');
  assert.equal(gone.status, 200);
  assert.ok(!gone.body.drafts.some((d) => d.id === 'd1'));
  const pushed = pushes.length;
  assert.equal((await call(app, 'DELETE', '/api/agent-sessions/5/drafts/d1')).status, 200, 'deleting twice is fine');
  assert.equal(pushes.length, pushed, 'and tells nobody, since nothing changed');
  assert.ok(pool.calls.some((c) => /FOR UPDATE/.test(c.sql)), 'the conversation row is the cap\'s lock');
}));

test('drafts: the dev chat\'s limits, a private table that follows its conversation, mounted and routed', () => {
  const route = read('src/routes/agent-session-drafts.js');
  assert.match(route, /require\('\.\/chat-drafts'\)/, 'one set of limits for both lists');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agent_session_drafts \([\s\S]*?REFERENCES agent_sessions\(id\) ON DELETE CASCADE[\s\S]*?PRIMARY KEY \(agent_session_id, draft_id\)/);
  assert.match(schema, /COMMENT ON TABLE agent_session_drafts IS 'staging:private';/);
  assert.match(read('server.js'), /app\.use\(agentSessionDraftsRoutes\(config\)\);/);
  assert.match(read('public/js/app.js'), /case 'agent_session_drafts_changed':\s*[\s\S]*?agentSession\?\.draftsChanged\?\.\(data\)/);
});

// ── The store: saving, sending, editing, Stop ──────────────────────────

function withBrowser(fn) {
  return async () => {
    const requests = [];
    const toasts = [];
    const storage = new Map();
    let drafts = [{ id: 'd1', text: 'older idea', savedAt: null }];
    globalThis.window = {
      location: { hash: '' },
      App: { setHeaderTitle() {} },
      UsernodeReact: {},
      PlatformUI: { toast: (m) => toasts.push(m) },
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
      },
    };
    globalThis.EventSource = class { close() {} };
    const session = {
      id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false,
      activeChange: null, changes: [], lastActivityAt: null, createdAt: null,
    };
    globalThis.fetch = withStateRead(async (url, init = {}) => {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push([method, url, body]);
      let answer;
      if (/\/drafts$/.test(url) && method === 'POST') {
        drafts = [...drafts, { id: body.id, text: body.text, savedAt: body.savedAt }];
        answer = { drafts };
      } else if (/\/drafts\/[^/]+$/.test(url) && method === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop());
        drafts = drafts.filter((d) => d.id !== id);
        answer = { drafts };
      } else if (/\/drafts$/.test(url)) answer = { drafts };
      else if (/\/messages\?/.test(url)) answer = { messages: [{ id: 1, role: 'user', content: 'first ask', metadata: {}, changeId: null, createdAt: null }], nextAfter: null };
      else if (/\/actions$/.test(url)) answer = { actions: [] };
      else if (/\/stop$/.test(url)) answer = { stopped: true };
      else if (/\/turns$/.test(url)) return { ok: false, status: 409, json: async () => ({ error: 'busy', busy: true }) };
      else answer = { session, turn: null };
      return { ok: true, status: 200, json: async () => answer };
    });
    try {
      const api = loadTsx('tests/fixtures/agent-session-api.ts');
      await fn({ api, requests, toasts });
    } finally {
      delete globalThis.window;
      delete globalThis.fetch;
      delete globalThis.EventSource;
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Save parks the text only while the Mayor works; a draft is sent by a tap once it is free', withBrowser(async ({ api, requests, toasts }) => {
  await api.openAgentSession({ id: 7, host: 'messages' });
  await settle();
  assert.deepEqual(api.getAgentSessionState().drafts.map((d) => d.text), ['older idea'], 'the conversation\'s list, read on open');

  assert.equal(api.saveComposerDraft('not now'), false, 'no turn running: the text is simply sent, not parked');
  api.handleEvent(7, { type: 'phase', phase: 'mayor' });
  assert.equal(api.saveComposerDraft('   '), false, 'nothing typed, nothing saved');
  assert.equal(api.saveComposerDraft('and make it blue'), true);
  assert.deepEqual(api.getAgentSessionState().drafts.map((d) => d.text), ['older idea', 'and make it blue'], 'shown at once');
  await settle();
  const post = requests.find(([m, u]) => m === 'POST' && u === '/api/agent-sessions/7/drafts');
  assert.equal(post[2].text, 'and make it blue');
  assert.match(post[2].id, /^d[0-9a-z]+$/);
  assert.match(toasts.at(-1), /Draft saved/);

  // Sending waits for the Mayor.
  await api.sendSavedDraft('d1');
  assert.ok(!requests.some(([m, u]) => m === 'DELETE' && /\/drafts\/d1$/.test(u)), 'refused mid-turn');

  // Stop: the waiting message comes back to the box.
  await api.stopAgentTurn();
  assert.equal(api.getAgentSessionState().returnedText, 'first ask');
  api.handleEvent(7, { type: 'done' });

  // Edit puts it back in the box, and what was typed there is kept.
  const text = api.editSavedDraft('d1', 'half a thought');
  assert.equal(text, 'older idea');
  await settle();
  assert.ok(requests.some(([m, u]) => m === 'DELETE' && u === '/api/agent-sessions/7/drafts/d1'));
  assert.ok(requests.some(([m, , b]) => m === 'POST' && b && b.text === 'half a thought'), 'the box\'s own text becomes a draft');

  // Another device changed the list: re-read.
  const reads = requests.filter(([m, u]) => m === 'GET' && /\/drafts$/.test(u)).length;
  api.agentSessionDraftsChanged({ agentSessionId: 7 });
  api.agentSessionDraftsChanged({ agentSessionId: 99 });
  await settle();
  assert.equal(requests.filter(([m, u]) => m === 'GET' && /\/drafts$/.test(u)).length, reads + 1, 'this conversation only');
  assert.equal(api.MAX_SAVED_DRAFTS, 20, 'the dev chat\'s cap');
}));

test('Stop hands back the message still waiting, or the newest one sent', () => {
  const { stoppedText } = loadTsx('tests/fixtures/agent-session-api.ts');
  const sending = (message) => [{ clientId: 'c1', message, shown: message, status: 'sending', error: '', createdAt: 1, attachmentKeys: [] }];
  const rows = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'system', content: 'Build started' },
  ];
  assert.equal(stoppedText({ outbox: sending('waiting'), messages: rows }), 'waiting', 'the message still on its way');
  assert.equal(stoppedText({ outbox: [], messages: rows }), 'second');
  assert.equal(stoppedText({ outbox: [], messages: [] }), null);
});

test('the composer keeps what was typed per conversation, and the drafts list offers its three acts', () => {
  const unsent = loadTsx('frontend/src/features/agent-session/unsent.ts');
  const storage = new Map();
  globalThis.window = { localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) } };
  try {
    unsent.writeUnsent(7, 'half typed');
    assert.equal(unsent.readUnsent(7), 'half typed');
    assert.equal(unsent.readUnsent('new'), '');
    unsent.writeUnsent(7, '  ');
    assert.equal(storage.size, 0, 'an emptied box leaves nothing behind');
    globalThis.window = { get localStorage() { throw new Error('blocked'); } };
    assert.equal(unsent.readUnsent(7), '', 'blocked storage: the composer alone holds it');
    assert.doesNotThrow(() => unsent.writeUnsent(7, 'x'));
  } finally {
    delete globalThis.window;
  }

  const { SavedDrafts } = loadTsx('tests/fixtures/agent-session-api.ts');
  const drafts = [{ id: 'd1', text: 'make it blue', savedAt: null }, { id: 'd2', text: 'and bigger', savedAt: null }];
  const busy = renderToHtml(createElement(SavedDrafts, { drafts, busy: true, onSend() {}, onEdit() {} }));
  assert.match(busy, /data-agent-session-drafts="2"/);
  assert.match(busy, />Saved drafts \(2\)</);
  assert.match(busy, /on all your devices/);
  assert.match(busy, /sending unlocks when the agent finishes/);
  assert.equal((busy.match(/aria-label="Send this draft"[^>]*disabled=""/g) || []).length, 2, 'no send mid-turn');
  const idle = renderToHtml(createElement(SavedDrafts, { drafts, busy: false, onSend() {}, onEdit() {} }));
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /aria-label="Edit this draft"/);
  assert.match(idle, /aria-label="Delete this draft"/);
  assert.equal(renderToHtml(createElement(SavedDrafts, { drafts: [], busy: false, onSend() {}, onEdit() {} })), '', 'no drafts, no row');

  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /data-agent-session-send="save"[\s\S]*?aria-label="Save as draft"/, 'the one button turns into Save');
  assert.match(panel, /const saving = running && !snapshot\.stopping && !!value\.trim\(\);/,
    'Save only with something typed, and never while stopping: Stop fills the box under its own click');
  assert.match(panel, /key="save"\s+type="submit"/, 'Save and Stop are different buttons, so a type flip never lands on one click');
  assert.match(panel, /if \(running\) \{\s*if \(saveComposerDraft\(text\)\) update\(''\);\s*return;\s*\}/, 'Enter mid-turn parks, never sends');
  assert.match(panel, /The agent is working\. Type your next message and save it for later\./);
});

// ── 4. What a typical change costs ─────────────────────────────────────

test('each model says what a typical change costs on it, never as a bare amount', () => {
  const choice = loadTsx('frontend/src/features/agent-session/model-choice.ts');
  const catalog = {
    anthropic: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
    anthropicDefault: 'claude-sonnet-5-5',
    defaultBackend: 'claude_code',
    savedOpenRouter: null,
    defaultReasoningEffort: null,
    codexAvailable: true,
    openrouter: [
      { id: 'z-ai/glm-5', name: 'GLM 5', isRecommended: true },
      { id: 'cheap/model', name: 'Cheap', isFavorite: true, inputPricePerMillion: 0.001, outputPricePerMillion: 0.002 },
      { id: 'priced/model', name: 'Priced', isFavorite: true, inputPricePerMillion: 1, outputPricePerMillion: 4 },
    ],
    recommendedOpenRouterId: 'z-ai/glm-5',
    notes: {
      typicalChange: { inputTokens: 2_500_000, outputTokens: 120_000 },
      models: {
        'claude-sonnet-5-5': { note: 'general coding work', estimateCents: 155 },
        'z-ai/glm-5': { note: null, estimateCents: 42 },
      },
    },
  };
  assert.deepEqual(choice.modelCost('claude-sonnet-5-5', catalog),
    { note: 'general coding work', perChange: 'about $1.55 for a typical change', compact: 'general coding work · about $1.55 for a typical change' });
  assert.equal(choice.modelCost('priced/model', catalog, catalog.openrouter[2]).perChange, 'about $2.98 for a typical change',
    'a model the platform does not curate: its catalog prices times the typical change');
  assert.equal(choice.modelCost('cheap/model', catalog, catalog.openrouter[1]).perChange, 'about <$0.01 for a typical change', 'never "$0.00"');
  assert.deepEqual(choice.modelCost('unknown', catalog), { note: '', perChange: '', compact: '' });
  assert.deepEqual(choice.modelCost('claude-sonnet-5-5', { ...catalog, notes: null }), { note: '', perChange: '', compact: '' }, 'no notes, no figure');

  const options = choice.pickerOptions(catalog, null);
  const sonnet = options.find((o) => o.value === 'anthropic:claude-sonnet-5-5');
  assert.equal(sonnet.detail, 'general coding work · about $1.55 for a typical change');
  assert.equal(options.find((o) => o.value === 'openrouter:z-ai/glm-5').detail, 'about $0.42 for a typical change');

  const parts = loadTsx('frontend/src/features/agent-session/composer-parts.tsx');
  const sheet = renderToHtml(createElement(parts.ModelSheetBody, {
    options: parts.modelList([{ ...sonnet, isDefault: true }]), value: sonnet.value, onPick() {}, effort: null, credit: null,
  }));
  assert.match(sheet, />Sonnet 5\.5<span[^>]*>default<\/span><\/span><span[^>]*>general coding work · about \$1\.55 for a typical change<\/span>/,
    'open: the cost under the name');
  const pill = renderToHtml(createElement(parts.ModelPill, { label: sonnet.label, disabled: false, open: false, onOpen() {}, pillRef: { current: null } }));
  assert.match(pill, /aria-label="Model: Sonnet 5\.5"/, 'closed: still "Model: X" to a screen reader');
  // #3008: the estimate is in the open list only. Beside the closed control
  // it read as a standing price under every message.
  assert.doesNotMatch(pill, /about/, 'closed: no estimate');
  assert.doesNotMatch(read('frontend/src/features/agent-session/index.tsx'), /data-agent-session-model-cost|typical change<\/span>/,
    'and nothing beside it');
  assert.match(read('frontend/src/features/agent-session/api.ts'), /read\('notes', '\/api\/model-notes'\)/, 'the dev chat\'s figures, from its route');
});

// ── 5. Reply costs, and a turn that did not finish ─────────────────────

test('a reply says what it cost, and a turn that did not finish offers to try again', () => {
  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  assert.equal(transcript.replyCostLabel({ costCents: 1.2, metadata: {} }), 'reply $0.012');
  assert.equal(transcript.replyCostLabel({ costCents: '0.5', metadata: { costEstimated: true } }), 'reply ~$0.005', 'an estimate says so');
  assert.equal(transcript.replyCostLabel({ costCents: 0, metadata: {} }), '');
  assert.equal(transcript.replyCostLabel({ costCents: null, metadata: {} }), '');

  const row = (id, role, content, metadata = {}, extra = {}) => ({ id, role, content, metadata, changeId: null, createdAt: null, ...extra });
  const items = transcript.buildTranscript([
    row(1, 'user', 'hi'),
    row(2, 'assistant', 'Hello', { quickReplies: ['Make it blue'] }, { costCents: 1.25 }),
  ]);
  const mayor = items.find((i) => i.kind === 'mayor');
  assert.equal(mayor.cost, 'reply $0.013');
  assert.equal(mayor.ended, null);
  assert.deepEqual(transcript.latestReplies(items), ['Make it blue'], 'its own suggestions first');

  const stopped = transcript.buildTranscript([row(1, 'user', 'hi'), row(2, 'assistant', 'Starting on', { stopped: true })]);
  assert.equal(stopped.at(-1).ended, 'stopped');
  assert.deepEqual(transcript.latestReplies(stopped), ['Try that again', 'What went wrong?']);
  const failed = transcript.buildTranscript([
    row(1, 'user', 'hi'),
    row(2, 'system', 'The last turn did not finish.', { agentSessionEvent: 'turn_failed' }),
  ]);
  assert.deepEqual(transcript.latestReplies(failed), ['Try that again', 'What went wrong?'], 'the dev chat\'s turn_failed pair');
  assert.deepEqual(transcript.latestReplies(transcript.buildTranscript([row(1, 'user', 'hi')])), []);

  const pills = read('src/services/recovery-pills.js');
  assert.match(pills, /turn_failed: Object\.freeze\(\['Try that again', 'What went wrong\?'\]\)/, 'the same pair the server offers');
  assert.match(read('src/services/mayor/agent-turn.js'), /mayor\.provider === 'openrouter' && cost > 0 \? \{ costEstimated: true \}/);
});

// ── 6. The outline, the dots, the tab ──────────────────────────────────

test('the outline is the card\'s in every engine; the Mayor at work is three dots; the tab says Thinking', () => {
  const css = read('public/css/app.css');
  assert.match(css, /form\.agent-session-composer:focus-within \{\s*border-color: var\(--accent\);\s*box-shadow: [^;]*0 0 0 1px var\(--accent\);/,
    'the ring on the whole card, over the dark theme\'s border utility too');
  assert.match(css, /\.agent-session-composer \.agent-session-composer-input \{\s*outline: none;\s*-webkit-appearance: none;\s*appearance: none;\s*box-shadow: none;\s*-webkit-tap-highlight-color: transparent;/,
    'two classes outrank preflight\'s :-moz-focusring, and WebKit draws no inner box');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.agent-session-typing-dot \{ animation: none;/);

  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /className="agent-session-composer flex flex-col/);
  assert.match(panel, /className="agent-session-composer-input /);
  assert.doesNotMatch(panel, /rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700/, 'the full-width bubble is gone');
  assert.match(panel, /<TypingDots \/>/);
  assert.match(panel, /<span className="sr-only">The agent is thinking<\/span>/, 'said to a screen reader when the dots say it alone');

  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /\|\| \(DevChat\._agentSessionThinking \? 'thinking' : null\)/, 'one title writer, one marker');
  assert.match(read('frontend/src/features/agent-session/store.ts'), /window\.DevChat\?\.setAgentSessionThinking\?\.\(thinking\)/);
});
