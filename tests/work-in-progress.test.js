'use strict';

// Where your work in progress is (#2779 follow-up).
//
// Four lists said four different things about the same work: the Workshop
// listed a paused session, Messages and the bell hid it, Recents never listed
// sessions at all, and the platform mark's menu listed nothing. The rules are
// one set now, and "paused" is the platform's bookkeeping rather than a state
// anybody is shown or asked to manage:
//
//   1. PAUSED IS NEVER SHOWN AND NEVER ASKED FOR. A session pauses by itself a
//      few idle minutes after it was used, the least recently used one pauses
//      when new work needs its slot, and opening or messaging a session
//      resumes it. No list hides it, no label names it, no error asks the
//      user to pause something.
//   2. A CONVERSATION STANDS FOR THE CHANGES IT STARTED: they are opened
//      through it, and not listed again beside it.
//   3. The platform mark's menu offers your five most recent agent sessions,
//      on every app and on Home, then "Show more" when there are others,
//      and every session that is working, as Recents shows it (#3073);
//      Recents lists agent sessions on its one clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const model = loadTsx('frontend/src/features/app-context/continue-model.ts');
const recents = loadTsx('frontend/src/features/nav/recents.ts');

const conversation = (over = {}) => ({
  id: 7, title: 'Dark mode', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z',
  focusApp: { slug: 'notes' }, activeChange: { appSlug: 'notes', status: 'paused', title: 'Dark mode toggle' },
  ...over,
});
test('the mark\'s Continue rows: agent sessions only, newest first, paused like any other', () => {
  const { rows, more } = model.continueRows([
    conversation(),
    conversation({ id: 8, title: null, lastActivityAt: '2026-09-24T11:00:00Z', activeChange: { appSlug: 'notes', status: 'active', title: null }, busy: true }),
    conversation({ id: 11, title: null, lastActivityAt: '2026-09-24T12:00:00Z', activeChange: null }),
    conversation({ id: 10, status: 'archived' }),
    conversation({ id: 12, lastActivityAt: '2026-09-24T09:00:00Z', activeChange: null, doneUnseen: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ['agent:8', 'agent:7', 'agent:12']);
  assert.equal(more, false, 'every one of them is shown');
  assert.deepEqual(rows.map((r) => r.href), ['#messages/agent/8', '#messages/agent/7', '#messages/agent/12'],
    'a conversation opens itself');
  assert.equal(rows[0].title, 'Agent session', 'an untitled conversation still says what it is');
  assert.ok(!rows.some((r) => r.key === 'agent:11'), 'one nothing was said in yet is not work in progress');
  assert.equal(rows[1].detail, 'In progress', 'a paused change reads as the work in progress it is');
  assert.deepEqual(rows.map((r) => r.activity), ['working', null, 'done'], 'each with the lists\' mark');
});

test('each Agent sessions row says the app it is on and where it stands, under its title', () => {
  const { rows } = model.continueRows([
    conversation({ id: 1, lastActivityAt: '2026-09-24T12:00:00Z', activeChange: { appSlug: 'run', appName: 'Run Club', status: 'active', title: 'x' } }),
    conversation({ id: 2, lastActivityAt: '2026-09-24T11:00:00Z', focusApp: { slug: 'run', name: 'Run Club' }, activeChange: { appSlug: 'run', status: 'promoted', title: 'y' } }),
    conversation({ id: 3, lastActivityAt: '2026-09-24T10:00:00Z', focusApp: null, activeChange: { appSlug: null, status: 'active', title: 'z' } }),
  ]);
  assert.deepEqual(rows.map((r) => r.sub), ['Run Club · in progress', 'Run Club · waiting for approval', 'In progress'],
    'the change\'s app, else the one it started from; alone, where it stands');
  assert.equal(model.agentSub('Notes', 'Agent session'), 'Notes · agent session');
});

test('the mark\'s Continue rows: every app\'s sessions, the five newest, and whether there are more', () => {
  // Not only the app the menu is open on: another app's session, one whose
  // change names no app, and one with only a focus app are all yours.
  const { rows } = model.continueRows([
    conversation({ id: 1, lastActivityAt: '2026-09-24T10:00:00Z' }),
    conversation({ id: 2, lastActivityAt: '2026-09-24T11:00:00Z', activeChange: { appSlug: 'recipes', status: 'active', title: 'x' } }),
    conversation({ id: 3, lastActivityAt: '2026-09-24T12:00:00Z', focusApp: null, activeChange: { appSlug: null, status: 'active', title: 'y' } }),
    conversation({ id: 4, lastActivityAt: '2026-09-24T09:00:00Z', focusApp: { slug: 'recipes' }, activeChange: null }),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ['agent:3', 'agent:2', 'agent:1', 'agent:4']);

  const many = Array.from({ length: 7 }, (_, i) => conversation({
    id: i + 1, lastActivityAt: `2026-09-24T1${i}:00:00Z`,
  }));
  const list = model.continueRows(many);
  assert.equal(model.CONTINUE_MAX, 5);
  assert.deepEqual(list.rows.map((r) => r.key), ['agent:7', 'agent:6', 'agent:5', 'agent:4', 'agent:3'],
    'the five most recent');
  assert.equal(list.more, true, 'and there are more');
  assert.equal(model.continueRows(many.slice(0, 5)).more, false, 'exactly five is all of them');
  assert.deepEqual(model.continueRows([]), { rows: [], more: false });
  assert.doesNotMatch(read('frontend/src/features/app-context/continue-model.ts'), /=== slug|appOf\(/,
    'no per-app filter left');
  assert.doesNotMatch(read('frontend/src/features/app-context/continue-model.ts'), /improve/i, 'classic changes are the Workshop\'s, one row up');
});

test('#3073: a working session is always among the Continue rows, as it is in Recents', () => {
  // Five newer sessions used to push a working one out of the menu's rows
  // while Recents (thirty rows, same clock) still showed it spinning.
  const sessions = [
    conversation({ id: 1, lastActivityAt: '2026-09-24T08:00:00Z', busy: true }),
    ...Array.from({ length: 6 }, (_, i) => conversation({ id: i + 2, lastActivityAt: `2026-09-24T1${i}:00:00Z` })),
  ];
  const list = model.continueRows(sessions);
  assert.deepEqual(list.rows.map((r) => r.key), ['agent:7', 'agent:6', 'agent:5', 'agent:4', 'agent:1'],
    'the working one takes a place, the newest others fill the rest, newest first');
  assert.equal(list.rows[4].activity, 'working');
  assert.equal(list.more, true);

  const recentsRows = recents.buildRecents({ apps: [], conversations: [], discussions: [], agents: [], agentSessions: sessions });
  const spinning = (rows) => rows.filter((r) => r.activity === 'working').map((r) => r.href);
  assert.deepEqual(spinning(list.rows), spinning(recentsRows), 'the two lists spin for the same sessions');

  const allWorking = Array.from({ length: 7 }, (_, i) => conversation({ id: i + 1, lastActivityAt: `2026-09-24T1${i}:00:00Z`, busy: true }));
  const busy = model.continueRows(allWorking);
  assert.equal(busy.rows.length, 7, 'every working session is listed');
  assert.equal(busy.more, false);
  assert.equal(model.continueRows(sessions.slice(1, 6)).more, false, 'five idle ones are still all of them');
});

test('#3073: only the newest read of the list is published, so an older answer cannot stop a spinner', async () => {
  const answers = [];
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {}, user: { id: 1 } }, UsernodeReact: {} };
  globalThis.fetch = (url) => new Promise((resolve) => {
    answers.push((sessions) => resolve({ ok: true, status: 200, json: async () => ({ sessions, nextBefore: null }) }));
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    const first = store.loadAgentSessions();
    const second = store.loadAgentSessions();
    answers[1]([conversation({ busy: true })]);
    await second;
    answers[0]([conversation({ busy: false })]);
    await first;
    assert.equal(store.getAgentSessionState().sessions[0].busy, true, 'the older answer, landing last, is dropped');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('#3071: a menu row writes its address before the menu closes, so closing cannot take it back', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const fn = sheet.slice(sheet.indexOf('function followThenDismiss('), sheet.indexOf('function MenuRow('));
  assert.match(fn, /e\.preventDefault\(\);\s*\/\/[^\n]*\n\s*if \(window\.location\.hash !== href\) window\.location\.hash = href;\s*AppContext\.dismissForNav\(\);/,
    'the address first, synchronously; then the release, which finds the page off its record');
  assert.match(fn, /if \(e\.defaultPrevented \|\| e\.nativeEvent\.defaultPrevented \|\| e\.button !== 0 \|\| e\.metaKey/,
    'a click the side panel took, or a modified one, only closes the menu');
  const row = sheet.slice(sheet.indexOf('function MenuRow('), sheet.indexOf('export function AppsSwitcherSheet('));
  assert.match(row, /if \(onClick\) \{ onClick\(e\); return; \}\s*followThenDismiss\(e, href\);/,
    'every plain row, the Continue rows among them');
  assert.match(sheet, /setMessagesFilter\('agents'\);\s*followThenDismiss\(e, '#messages'\);/, 'and "Show more"');
});

test('the mark\'s menu: the app\'s own rows first, then Agent sessions, the sessions after mount only, with "Show more" when there are more', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /const continuing = mounted && view === 'menu'\s*\? continueRows\(agentSessions \|\| \[\]\)\s*: \{ rows: \[\], more: false \};/,
    'never in the prerender (the hydrating render matches it), and not keyed on the app');
  assert.match(sheet, /if \(open && window\.App\?\.user\) void loadAgentSessions\(\);/,
    'for any signed-in viewer: the flag never hides a conversation that exists');
  const at = (id) => sheet.indexOf(`id="${id}"`);
  assert.ok(at('app-menu-row-workshop') < at('app-menu-row-about')
    && at('app-menu-row-about') < at('app-menu-sessions')
    && at('app-menu-sessions') < at('improve-row-new-session')
    && at('improve-row-new-session') < at('app-menu-continue'),
    'Go to community and About are the app\'s section; Agent sessions follow, led by Start a new change');
  assert.match(sheet, /<div className=\{SECTION\}>Agent sessions<\/div>/, 'it was "Continue"');
  assert.doesNotMatch(sheet, />Continue</);
  // Each session says what app it is on and where it stands, under its title.
  assert.match(sheet, /label=\{row\.title\}\s+sub=\{row\.sub\}/);
  assert.match(sheet, /\{continuing\.more \? \(\s*<a\s+id="app-menu-continue-all"\s+href="#messages"\s+className=\{CONTINUE_ALL\}[\s\S]{0,200}setMessagesFilter\('agents'\)[\s\S]{0,200}>\s*Show more\s*<ChevronRightIcon /,
    'only when there are more, and it opens Messages\' Agents list');
  // #3405: a link under the list in the action accent, not one more row.
  assert.match(sheet, /const CONTINUE_ALL = 'inline-flex[^;]*text-violet-700 dark:text-violet-300/);
  assert.doesNotMatch(sheet, /<MenuRow\s+id="app-menu-continue-all"/);
  assert.doesNotMatch(sheet, /See all sessions/);
  assert.match(sheet, /<AgentActivityIcon activity=\{row\.activity\} className="h-5 w-5" \/>/);
  assert.doesNotMatch(sheet, /See all your work|continue-change/);
});

test('Recents lists open agent sessions on its one clock', () => {
  const items = recents.buildRecents({
    apps: [],
    conversations: [{ id: 3, kind: 'direct', title: 'x', lastActivityAt: '2026-09-24T09:30:00Z', unreadCount: 0, peer: { id: 2, username: 'bo' } }],
    discussions: [],
    agents: [],
    agentSessions: [
      { id: 7, title: 'Dark mode', status: 'open', lastActivityAt: '2026-09-24T10:00:00Z' },
      { id: 8, title: null, status: 'open', lastActivityAt: null, createdAt: '2026-09-24T08:00:00Z', activeChange: { id: 41 } },
      { id: 10, title: null, status: 'open', lastActivityAt: '2026-09-24T12:00:00Z', activeChange: null },
      { id: 9, title: 'Old', status: 'archived', lastActivityAt: '2026-09-24T11:00:00Z' },
    ],
  });
  assert.deepEqual(items.map((i) => [i.key, i.href]), [
    ['agent-session:7', '#messages/agent/7'],
    ['conversation:3', '#messages/3'],
    ['agent-session:8', '#messages/agent/8'],
  ]);
  assert.equal(items[2].label, 'New session');
  assert.ok(!items.some((i) => i.key === 'agent-session:10'), 'an empty one is not history');
  const list = read('frontend/src/features/nav/recents-list.tsx');
  assert.match(list, /if \(viewer\) void loadAgentSessions\(\);/);
});

test('Messages and the bell list paused sessions, and a conversation\'s change opens the conversation', () => {
  const improve = read('frontend/src/features/improve/improve-controller.js');
  assert.doesNotMatch(improve, /isParked/, 'no list filters paused work out');
  assert.doesNotMatch(improve, /return 'Paused'/, 'and no row says "Paused"');
  assert.match(improve, /href: session\.agent_session_id\s*\? `#messages\/agent\/\$\{session\.agent_session_id\}`/);
});

test('"paused" is shown nowhere, and nobody is asked to pause or resume anything', () => {
  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  assert.equal(transcript.changeStatusLabel('paused'), 'In progress');
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /'Parked'/);
  assert.doesNotMatch(read('public/js/app-view.js'), /label: 'paused'/, 'no paused chip on the Workshop card');
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(devChat, /key: 'pause', label: 'Pause'/);
  assert.doesNotMatch(devChat, /key: 'resume', label: 'Resume'/);
  assert.match(devChat, /key: 'free', label: 'Free worker'/, 'a promoted session can still free its worker');
  for (const file of ['src/routes/sessions.js', 'src/routes/proposal-handoff.js', 'src/services/connector-limits.js']) {
    assert.doesNotMatch(read(file), /Pause or archive one first|Pause one first/, `${file} never asks the user to pause`);
  }
  const prompt = read('src/services/mayor/agent-prompt.js');
  assert.doesNotMatch(prompt, /parking/);
  assert.match(prompt, /change\.status === 'paused' \? 'active'/, 'the Mayor is never told a change is paused');
});

test('new work at the cap pauses the user\'s least recently used session instead of refusing', async () => {
  const lifecycle = require('../src/services/session-lifecycle');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await lifecycle.freeUserSlot({ pool, userId: 7 }), { freed: false });
  const pick = calls[0];
  assert.match(pick.sql, /WHERE user_id = \$1 AND status = 'active' AND id <> \$2/);
  assert.match(pick.sql, /ORDER BY last_activity_at ASC/);
  assert.deepEqual(pick.params, [7, 0, false], 'headless runs are not the user\'s to give up');
  await lifecycle.freeUserSlot({ pool, userId: 7, excludeSessionId: 41, includeHeadless: true });
  assert.deepEqual(calls[1].params, [7, 41, true]);
  assert.match(lifecycle.USER_SLOTS_BUSY, /busy finishing turns/);

  const sessions = read('src/routes/sessions.js');
  const create = sessions.slice(sessions.indexOf("router.post('/api/apps/:slug/sessions'"));
  assert.match(create.slice(0, 6000), /sessionLifecycle\.freeUserSlot\(\{ pool, userId: req\.user\.id \}\)/);
  assert.equal((sessions.match(/sessionLifecycle\.freeUserSlot\(/g) || []).length, 3,
    'create, clone and resume all free a slot the same way (fork is retired, #2779)');
  assert.match(read('src/routes/proposal-handoff.js'), /sessionLifecycle\.freeUserSlot\(/);
  assert.match(read('src/services/connector-limits.js'), /lifecycle\.freeUserSlot\(\{ pool, userId: user\.id \}\)/);
});

test('a message to a paused session resumes it, with every rule the resume route keeps', () => {
  const sessions = read('src/routes/sessions.js');
  const chat = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/chat'"));
  const resumeAt = chat.indexOf('await resumePausedSession({');
  assert.ok(resumeAt > 0 && resumeAt < chat.indexOf("error: 'Active session not found'"),
    'resumed before the session is looked for again, never refused as not found');
  assert.match(chat.slice(0, resumeAt), /status = 'paused'\s+AND is_headless = FALSE AND source IS DISTINCT FROM 'imported'/);
  assert.match(chat.slice(0, resumeAt), /pausedRows\[0\]\.agent_session_id != null\) \{\s+return res\.status\(409\)/,
    'a change an agent session owns is refused before anything is resumed');
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/resume'"));
  assert.match(route.slice(0, 600), /await resumePausedSession\(\{ pool, config, user: req\.user, sessionId \}\)/,
    'one implementation for the route and the chat');
  const syncMain = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/sync-main'"));
  assert.match(syncMain.slice(0, 2000), /session\.status === 'paused'[\s\S]{0,200}resumePausedSession/);
  assert.equal(typeof require('../src/routes/sessions').resumePausedSession, 'function');
});

test('an agent session\'s finished run opens the conversation from the bell and from an alert', () => {
  const notifications = read('src/services/notifications.js');
  assert.equal((notifications.match(/cs\.agent_session_id,/g) || []).length, 3, 'every notification read carries it');
  assert.match(notifications, /agentSessionId: isConversation \? null : \(row\.agent_session_id \|\| null\)/);
  const client = read('frontend/src/features/notifications/notifications.js');
  // #3181: a change that stopped before finishing opens the same place.
  assert.match(client, /const sessionTurnEnd = item\.kind === 'session_done' \|\| item\.kind === 'session_stalled';/);
  assert.match(client, /sessionTurnEnd && item\.agentSessionId[\s\S]{0,200}#messages\/agent\//);
  assert.match(client, /n\.agentSessionId \? 'The coding agent finished' : 'Session finished'/);
  assert.match(read('public/js/dev-alerts.js'), /if \(info && info\.agentSessionId\) return `#messages\/agent\/\$\{info\.agentSessionId\}`;/);
  assert.equal(typeof require('../src/services/session-bus').subscriberCount, 'function');
});

test('opening the conversation answers its changes\' finished rows, however the user got there', async () => {
  const { markReadForAgentSession } = require('../src/services/notifications');
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 2 }; } };
  assert.equal(await markReadForAgentSession(pool, 4, 12), 2);
  assert.match(calls[0].sql, /n\.kind IN \('session_done', 'session_stalled'\) AND n\.read_at IS NULL\s+AND n\.session_id = cs\.id AND cs\.agent_session_id = \$2/);
  assert.deepEqual(calls[0].params, [4, 12]);
  assert.equal(await markReadForAgentSession(pool, 4, null), 0, 'nothing to answer without a conversation');
  const route = read('src/routes/agent-sessions.js');
  const get = route.slice(route.indexOf("router.get('/api/agent-sessions/:id'"));
  assert.match(get.slice(0, 2400), /notifications\.markReadForAgentSession\(pool, req\.user\.id, session\.id\)/);
});
