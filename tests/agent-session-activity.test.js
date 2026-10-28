'use strict';

// What an agent session is doing, marked in every list (#2779 follow-up).
//
//   1. A SPINNER while its turn runs (the lease is held, which covers a scout
//      or a build the turn dispatched), and a GREEN DOT once a turn finished
//      after the owner last read the conversation. Nothing otherwise.
//   2. The same mark in the platform mark's Continue rows and Messages, from
//      the same two fields the server sends (busy, doneUnseen). (The rail's
//      Recents drew it too, until #4417 retired Recents.)
//   3. The lists follow it live: a turn starting or ending, or the
//      conversation being read in another tab, pushes `agent_session_changed`
//      to the owner, and the list is read again (once per burst). Reading the
//      conversation marks it seen before the read answers, and the list's own
//      entry follows the conversation on screen at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('working is a spinner, finished-unseen a green dot, and nothing else is marked', () => {
  const { agentActivity } = loadTsx('frontend/src/features/agent-session/activity.ts');
  assert.equal(agentActivity({ busy: true }), 'working');
  assert.equal(agentActivity({ busy: true, doneUnseen: true }), 'working', 'working wins: it is not done yet');
  assert.equal(agentActivity({ busy: false, doneUnseen: true }), 'done');
  assert.equal(agentActivity({ busy: false, doneUnseen: false }), null);
  assert.equal(agentActivity(null), null);

  const { AgentActivityMark } = loadTsx('frontend/src/features/agent-session/activity-mark.tsx');
  const working = renderToHtml(createElement(AgentActivityMark, { activity: 'working' }));
  assert.match(working, /role="img" aria-label="Working" title="Working" data-agent-activity="working"/);
  assert.match(working, /<svg[^>]*class="h-3\.5 w-3\.5 animate-spin/);
  const done = renderToHtml(createElement(AgentActivityMark, { activity: 'done' }));
  assert.match(done, /aria-label="Finished"[^>]*data-agent-activity="done"[^>]*class="[^"]*rounded-full bg-green-500/,
    'the live-app dot\'s green');
  assert.equal(renderToHtml(createElement(AgentActivityMark, { activity: null })), '');
});

test('the mark\'s Continue rows and Messages both draw it', () => {

  const messages = read('frontend/src/features/messages/index.tsx');
  const mayorRow = messages.slice(messages.indexOf('function MayorSessionRow('), messages.indexOf('function AgentSessionThread('));
  assert.match(mayorRow, /const mark = agentActivity\(session\);/);
  // The mark menu's rows left with its Agent chats section (#4729); the
  // mark, the list that remains, is Messages'.
  assert.doesNotMatch(read('frontend/src/features/app-context/app-context-sheet.tsx'), /AgentActivityIcon/);
});

test('#3028: while a session works, its spinner replaces the row\'s icon rather than sitting beside it', () => {
  const { createElement, renderToHtml } = require('./lib/render-tsx');
  const { AgentWorkingIcon } = loadTsx('frontend/src/features/agent-session/activity-mark.tsx');
  const icon = renderToHtml(createElement(AgentWorkingIcon, { className: 'row-glyph' }));
  assert.match(icon, /^<svg class="animate-spin text-violet-600 dark:text-violet-400 row-glyph"[^>]*aria-hidden="true" data-agent-activity="working"/,
    'the same spinner, at the slot\'s size, decoration only');

  const messages = read('frontend/src/features/messages/index.tsx');
  const mayorRow = messages.slice(messages.indexOf('function MayorSessionRow('), messages.indexOf('function AgentSessionThread('));
  assert.match(mayorRow, /\{mark\s*\? <AgentActivityIcon activity=\{mark\} className="w-5 h-5" \/>\s*: <SparklesIcon className="w-5 h-5" \/>\}/);
  assert.match(mayorRow, /\{mark \? <span className="sr-only">\{t\(ACTIVITY_SAID\[mark\]\)\}<\/span> : null\}/,
    'the icon slot is aria-hidden, so the row still says "Working" or "Finished" in words');
});

test('#3076: the finished dot replaces the icon too, in the mark\'s Continue rows and Messages', () => {
  const { AgentDoneIcon, AgentActivityIcon } = loadTsx('frontend/src/features/agent-session/activity-mark.tsx');
  const dot = renderToHtml(createElement(AgentDoneIcon, { className: 'row-glyph' }));
  assert.match(dot, /^<span aria-hidden="true" data-agent-activity="done" class="inline-flex shrink-0 items-center justify-center row-glyph"><span class="h-2 w-2 rounded-full bg-green-500"><\/span><\/span>$/,
    'the live-app dot\'s green, centred in the slot it takes, decoration only');
  assert.match(renderToHtml(createElement(AgentActivityIcon, { activity: 'working', className: 'x' })), /^<svg class="animate-spin[^"]* x"/);
  assert.match(renderToHtml(createElement(AgentActivityIcon, { activity: 'done' })), /data-agent-activity="done"/);
  assert.equal(renderToHtml(createElement(AgentActivityIcon, { activity: null })), '');

  // The menu's rows are gone with the menu's Agent chats (#4729); the tile
  // in Messages' Agents list is where the state is drawn, and said in words.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(sheet, /AgentActivityMark|AgentActivityIcon/);

  // Messages' Agents list: the tile's sparkle gives way to the spinner or the
  // dot (it kept its icon while working before), and the name says which.
  const messages = read('frontend/src/features/messages/index.tsx');
  const mayorRow = messages.slice(messages.indexOf('function MayorSessionRow('), messages.indexOf('function AgentSessionThread('));
  assert.match(mayorRow, /<span className="messages-inbox-tile messages-inbox-agent-tile" aria-hidden="true">\s*\{mark\s*\? <AgentActivityIcon activity=\{mark\} className="w-5 h-5" \/>\s*: <SparklesIcon className="w-5 h-5" \/>\}/);
  assert.equal(message('messages:agent.row.activity.working'), ', working');
  assert.equal(message('messages:agent.row.activity.done'), ', finished');
  assert.match(mayorRow, /\{mark \? <span className="sr-only">\{t\(ACTIVITY_SAID\[mark\]\)\}<\/span> : null\}/);
  assert.doesNotMatch(mayorRow, /AgentActivityMark/, 'and no second mark where the unread count goes');
});

test('#3076: Messages draws the working spinner and the finished dot in the tile', () => {
  const { AgentActivityIcon } = loadTsx('frontend/src/features/agent-session/activity-mark.tsx');
  const tile = (activity) => renderToHtml(createElement('span', { className: 'messages-inbox-tile' },
    createElement(AgentActivityIcon, { activity, className: 'w-5 h-5' })));
  assert.match(tile('working'), /<span class="messages-inbox-tile"><svg class="animate-spin text-violet-600 dark:text-violet-400 w-5 h-5"/);
  assert.match(tile('done'), /<span class="messages-inbox-tile"><span aria-hidden="true" data-agent-activity="done" class="[^"]*w-5 h-5"><span class="h-2 w-2 rounded-full bg-green-500">/);
});

test('a burst of pushes is one read of the list, and the open conversation keeps its list entry current', async () => {
  const requests = [];
  let listDone = true;
  const session = (over) => ({
    id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, activeChange: null,
    busy: false, doneUnseen: listDone, lastActivityAt: null, createdAt: null, ...over,
  });
  // A signed-in member: the list waits for a viewer the endpoint will answer
  // (QA 2026-09-24 Q35, lib/platform-viewer.ts), which is `App.user`.
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {}, user: { id: 1 } }, UsernodeReact: {} };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url) => {
    requests.push(url);
    const body = url.startsWith('/api/agent-sessions?') || url === '/api/agent-sessions'
      ? { sessions: [session({ doneUnseen: listDone })], nextBefore: null }
      : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
        : /\/actions$/.test(url) ? { actions: [] }
          : { session: session({ doneUnseen: false }), turn: null };
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    await store.loadAgentSessions();
    assert.equal(store.getAgentSessionState().sessions[0].doneUnseen, true, 'finished while you were away');

    // Opening it reads it: the list's entry is the fresh one, dot gone.
    await store.openAgentSession({ id: 7, host: 'messages' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getAgentSessionState().sessions[0].doneUnseen, false, 'the list follows the conversation on screen');

    const lists = () => requests.filter((u) => /^\/api\/agent-sessions(\?|$)/.test(u)).length;
    const before = lists();
    store.agentSessionListChanged();
    store.agentSessionListChanged();
    store.agentSessionListChanged();
    assert.equal(lists(), before, 'not at once');
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(lists(), before + 1, 'one read for the burst');
    assert.equal(window.UsernodeReact.agentSession.listChanged, store.agentSessionListChanged, 'what app.js calls');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the push reaches the lists, and reading the conversation marks it seen before it answers', () => {
  const app = read('public/js/app.js');
  assert.match(app, /case 'agent_session_changed':[\s\S]{0,300}window\.UsernodeReact\?\.agentSession\?\.listChanged\?\.\(data\);/);
  const route = read('src/routes/agent-sessions.js');
  const get = route.slice(route.indexOf("router.get('/api/agent-sessions/:id'"));
  const seen = get.indexOf('agentSessions.markSeen(pool, { userId: req.user.id, id: req.params.id })');
  assert.ok(seen > 0 && seen < get.indexOf('agentSessions.getAgentSession('), 'seen first, so the answer carries no dot');
  assert.match(get.slice(0, 1600), /if \(cleared\) \{\s+require\('\.\.\/services\/ws'\)\.pushToUser\(req\.user\.id, \{ type: 'agent_session_changed'/,
    'the owner\'s other tabs clear their dot too');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS last_done_at TIMESTAMPTZ;/);
  assert.match(schema, /ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;/);
});
