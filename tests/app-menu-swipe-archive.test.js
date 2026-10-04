'use strict';

// A left swipe archives an agent session from the Homeroom menu (#3515).
//
// The request asked to DELETE a session from the platform mark's menu. There
// is no delete for an agent session: what puts one away is Archive, on the ⋯
// of the session's own screen (POST /api/agent-sessions/:id/archive), which
// takes it out of your lists, pauses its change and can be undone. So the
// swipe offers that one, in its word and with its confirm, and these tests
// pin the three things that make it the same action rather than a lookalike:
//
//   1. THE STORE: `archiveListedSession` asks the ⋯'s own question, posts to
//      the same route, takes the row out of every list at once and reads the
//      list again so the next session fills in. Cancel posts nothing; a
//      refusal says why in a toast and reads the list all the same.
//   2. THE ROW: each session row wears the kit's swipe (PlatformUI
//      .swipeActions, as the notifications' Saved and Invite rows do), on
//      touch only, after mount, detached on unmount, with Archive as the
//      destructive (full-swipe) action.
//   3. THE SLOT: the kit moves the element it is handed into a wrapper of its
//      own, so the <a> sits in a React-owned <div> the list places instead,
//      keyed so that a Cancel or a refusal renders the row again. The <a>
//      keeps its id, `data-context-row` and href.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const STORE = 'frontend/src/features/agent-session/store.ts';
const SHEET = 'frontend/src/features/app-context/app-context-sheet.tsx';

const listed = (id, over = {}) => ({
  id, title: `Session ${id}`, status: 'open', lastActivityAt: `2026-09-24T1${id}:00:00Z`,
  focusApp: null, activeChange: null, ...over,
});

// A store with three listed sessions and a server that answers the archive
// with `archive` (a response, or a function of the id that returns one).
async function harness({ answer = true, archive } = {}) {
  const requests = [];
  const toasts = [];
  const asked = [];
  let server = [listed(1), listed(2), listed(3)];
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {}, user: { id: 1 } },
    UsernodeReact: {},
    PlatformUI: {
      isTouch: () => true,
      toast: (message) => { toasts.push(message); },
      confirm: async (opts) => { asked.push(opts); return answer; },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    requests.push([method, url]);
    const archived = /^\/api\/agent-sessions\/(\d+)\/archive$/.exec(url);
    if (archived && method === 'POST') {
      const id = Number(archived[1]);
      if (archive) return archive(id);
      server = server.filter((s) => s.id !== id);
      return { ok: true, status: 200, json: async () => ({ session: listed(id, { status: 'archived' }) }) };
    }
    if (url === '/api/agent-sessions') {
      return { ok: true, status: 200, json: async () => ({ sessions: server, nextBefore: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const store = loadTsx(STORE);
  await store.loadAgentSessions();
  assert.deepEqual(store.getAgentSessionState().sessions.map((s) => s.id), [1, 2, 3]);
  requests.length = 0;
  return { store, requests, toasts, asked, setServer: (next) => { server = next; } };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.fetch;
}

// Let the list's re-read (fired, not awaited) land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('#3515: a swiped session is archived through the ⋯\'s own confirm and route, leaves the lists at once, and the list is read again', async () => {
  try {
    const { store, requests, asked } = await harness();
    const archived = await store.archiveListedSession(2);
    assert.equal(archived, true);
    assert.deepEqual(asked, [{
      title: 'Archive this session?',
      message: 'It leaves your lists and its change is paused. A change waiting for approval keeps its approvals, and you can unarchive the session at any time.',
      confirmLabel: 'Archive',
    }], 'the same question the session screen\'s ⋯ asks, word for word');
    assert.deepEqual(requests[0], ['POST', '/api/agent-sessions/2/archive'], 'Archive, not a delete: the route the ⋯ uses');
    assert.ok(!requests.some(([m]) => m === 'DELETE'), 'nothing is deleted');
    assert.deepEqual(store.getAgentSessionState().sessions.map((s) => s.id), [1, 3],
      'out of every list that reads `sessions` (the menu, Recents, Messages) without waiting for the re-read');
    await settle();
    assert.ok(requests.some(([m, u]) => m === 'GET' && u === '/api/agent-sessions'),
      'and the list is read again, so the next session fills the place it left');
  } finally {
    cleanup();
  }
});

test('#3515: Cancel archives nothing and says so to the row, which puts itself back', async () => {
  try {
    const { store, requests } = await harness({ answer: false });
    assert.equal(await store.archiveListedSession(2), false);
    assert.deepEqual(requests, [], 'no request at all');
    assert.deepEqual(store.getAgentSessionState().sessions.map((s) => s.id), [1, 2, 3]);
  } finally {
    cleanup();
  }
});

test('#3515: a refused archive says why in a toast, keeps the row, and reads the list again', async () => {
  try {
    const { store, requests, toasts, setServer } = await harness({
      archive: () => ({ ok: false, status: 404, json: async () => ({ error: 'Agent session not found or already archived' }) }),
    });
    // Another tab archived it first: the re-read is what takes it away.
    setServer([listed(1), listed(3)]);
    assert.equal(await store.archiveListedSession(2), false);
    assert.deepEqual(toasts, ['Agent session not found or already archived'], 'a list has no error line, so a toast says it');
    assert.deepEqual(store.getAgentSessionState().sessions.map((s) => s.id), [1, 2, 3], 'nothing is taken out on a refusal');
    await settle();
    assert.ok(requests.some(([m, u]) => m === 'GET' && u === '/api/agent-sessions'));
    assert.deepEqual(store.getAgentSessionState().sessions.map((s) => s.id), [1, 3], 'the re-read settles it');
  } finally {
    cleanup();
  }
});

test('#3515: the ⋯ and the swipe share one confirm, so the two cannot drift apart', () => {
  const store = read(STORE);
  assert.equal((store.match(/title: 'Archive this session\?'/g) || []).length, 1, 'the question is written once');
  const current = store.slice(store.indexOf('export async function archiveCurrentSession('), store.indexOf('export async function archiveListedSession('));
  assert.match(current, /const ok = await confirmArchive\(\);/);
  const listedFn = store.slice(store.indexOf('export async function archiveListedSession('), store.indexOf('export async function unarchiveCurrentSession('));
  assert.match(listedFn, /confirmArchive\(\)/);
  assert.match(listedFn, /api\.archiveSession\(id\)/);
  assert.match(listedFn, /sessions: current\.sessions\.filter\(\(s\) => s\.id !== id\)/);
  assert.match(listedFn, /\.\.\.\(current\.id === id \? \{ session \} : \{\}\)/,
    'the conversation on screen, if it is this one, takes the archived session, read-only with Unarchive');
});

test('#3515: each Agent sessions row wears the kit\'s swipe, on touch only, with Archive as its destructive action', () => {
  const sheet = read(SHEET);
  const row = sheet.slice(sheet.indexOf('function SessionRow('), sheet.indexOf('export function AppsSwitcherSheet('));
  assert.ok(row.length > 0, 'SessionRow sits between MenuRow and the sheet');
  assert.match(row, /if \(!el \|\| !ui\?\.isTouch\(\) \|\| !ui\.swipeActions\) return undefined;/,
    'a phone\'s gesture: no swipe for a mouse, and none without the kit');
  assert.match(row, /ui\.swipeActions\(el, \{\s*actions: \[\{\s*label: 'Archive',\s*destructive: true,/,
    'the ⋯\'s word, and the full swipe commits it');
  assert.match(row, /archiveListedSession\(row\.sessionId\)\.then\(\(archived\) => \{\s*if \(!archived\) setRound\(\(n\) => n \+ 1\);/,
    'a Cancel or a refusal renders the row again');
  assert.match(row, /return \(\) => swipe\.detach\(\);\s*\}, \[row\.sessionId, round\]\);/, 'detached when the row goes');
  assert.doesNotMatch(row, /label: 'Delete'/, 'nothing deletes an agent session');
  // Wired after mount, from an effect: the rows are not in the prerender.
  assert.match(row, /useEffect\(\(\) => \{\s*const el = rowRef\.current;/);
});

test('#3515: the kit wraps the row inside a React-owned slot, keyed for the row\'s return, and the <a> keeps its id and key', () => {
  const sheet = read(SHEET);
  const row = sheet.slice(sheet.indexOf('function SessionRow('), sheet.indexOf('export function AppsSwitcherSheet('));
  assert.match(row, /return \(\s*<div key=\{round\}>\s*<MenuRow\s+id=\{`app-menu-continue-\$\{index\}`\}\s+dataContextRow="continue-agent"\s+elRef=\{rowRef\}\s+href=\{row\.href\}/,
    'the slot is what the list places; the kit\'s wrapper lives inside it');
  assert.match(sheet, /\{continuing\.rows\.map\(\(row, index\) => \(\s*<SessionRow key=\{row\.key\} row=\{row\} index=\{index\} \/>\s*\)\)\}/,
    'one slot per session, keyed by the session, so React moves and removes the slot and never the wrapped <a>');
  const model = loadTsx('frontend/src/features/app-context/continue-model.ts');
  const { rows } = model.continueRows([listed(4), listed(6)]);
  assert.deepEqual(rows.map((r) => [r.key, r.sessionId, r.href]),
    [['agent:6', 6, '#messages/agent/6'], ['agent:4', 4, '#messages/agent/4']], 'a row carries the session it archives');
});
