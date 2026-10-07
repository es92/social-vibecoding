'use strict';

// "What do you want to make?" is asked until it is answered (production,
// 5 Oct 2026). A new test account signed in through the story's sheet, was
// shown the make screen, made nothing and did not choose "Look around
// first"; the page was reloaded, and it landed on an empty Home for good.
// Being SHOWN the screen had answered it: the start was recorded as the join
// screen's answer (needs_communities_choice cleared), and the shell set its
// own copy of the flag false.
//
// Now showing it records only that it was asked, and the account's flag
// stays set until Make it or "Look around first". This file runs the client
// half: the join step (frontend/src/features/auth/communities-first-run.js)
// in a vm sandbox, one sandbox per boot of the shell, since a reload is a
// new document; the island's two answers (frontend/src/features/first-
// session/index.tsx) with stubbed globals; and the Journey line for
// somebody sitting on the question. The server half, against the real
// schema, is tests/first-session-persists-postgres.test.js.
//
// Run with: node --test tests/first-session-persists.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GATE = read('frontend/src/features/auth/communities-first-run.js');
const ISLAND = 'frontend/src/features/first-session/index.tsx';

// What /api/auth/me says of a brand-new account that has not answered.
const OWED = Object.freeze({
  id: 7, hasPlatformAccess: true, needsCommunitiesChoice: true, storyFirstSession: true, needsUsernameChoice: false,
});

/**
 * One boot of the signed-in shell, as app.js runs it: `App.user` set, then
 * `sv:authed`. From the session snapshot (a reload on a device that signed
 * in before) the session is unverified until `reconcile` brings the server's
 * user, which calls the join step again (app.js _reconcileSession).
 */
function boot({ user, fromSnapshot = false, pathname = '/' }) {
  const authed = [];
  const calls = [];
  const fetches = [];
  const saved = [];
  const window = {
    App: {
      user: null,
      _sessionFromSnapshot: false,
      _inviteTokenFromPath: (p) => (/^\/invite\/[A-Za-z0-9_-]{22}$/.test(p) ? p.slice(8) : null),
      saveSessionSnapshot: (u) => saved.push(JSON.parse(JSON.stringify(u))),
    },
    UsernodeReact: {
      firstSession: {
        make() { calls.push('make'); return true; },
        dismissMake() { calls.push('dismiss'); },
      },
    },
  };
  const document = {
    addEventListener(type, fn) { if (type === 'sv:authed') authed.push(fn); },
    documentElement: { classList: { contains: () => false } },
  };
  const sandbox = {
    window, document, console, URLSearchParams,
    location: { search: '', pathname },
    setTimeout: (fn) => { fn(); return 1; },
    fetch: async (url, init) => {
      fetches.push([url, init && init.body ? JSON.parse(init.body) : null]);
      return { ok: true, json: async () => ({ communities: [] }) };
    },
  };
  vm.runInNewContext(GATE, sandbox);
  window.App.user = { ...user };
  window.App._sessionFromSnapshot = fromSnapshot;
  const start = authed.map((fn) => fn());
  const inTheSameTick = calls.slice();
  return {
    window,
    gate: window.CommunitiesFirstRun,
    calls,
    fetches,
    saved,
    inTheSameTick,
    started: Promise.all(start),
    // The verified read lands: the server's user replaces the snapshot's.
    async reconcile(serverUser) {
      window.App._sessionFromSnapshot = false;
      window.App.user = { ...serverUser };
      await window.CommunitiesFirstRun.maybePrompt();
    },
  };
}

const STARTED = ['/api/me/first-session/started', { via: 'sign_in' }];

test('shown but not answered: the next boot opens the make screen again, from a reload, a new tab or a sign-in', async () => {
  // The first boot, with nothing before it (a sign-in): opened in the same
  // tick, recorded as asked.
  const first = boot({ user: OWED });
  await first.started;
  assert.deepEqual(first.inTheSameTick, ['make'], 'drawn before Home is painted');
  assert.deepEqual(first.fetches, [STARTED]);
  // Opening it answers nothing: the shell's copy of the account still owes
  // it, and so does the session snapshot written from that copy.
  assert.equal(first.window.App.user.needsCommunitiesChoice, true);
  assert.equal(first.gate.applies(), false, 'this document is done with the step');

  // A reload: the shell starts from the snapshot (the same user), and the
  // make screen is drawn in that tick again, before Home, with nothing
  // recorded while the session is unverified.
  const reload = boot({ user: first.window.App.user, fromSnapshot: true });
  await reload.started;
  assert.deepEqual(reload.inTheSameTick, ['make'], 'the same screen, not Home');
  assert.deepEqual(reload.fetches, []);
  // The server still says it is owed: the screen stays, and the start is
  // recorded (the server keeps only the first).
  await reload.reconcile(OWED);
  assert.deepEqual(reload.calls, ['make', 'make'], 'kept, never taken down and put back');
  assert.deepEqual(reload.fetches, [STARTED]);

  // A new tab, the phone app relaunched, or a sign-out and back in: a boot
  // with no snapshot reads the server first, and the server still owes it.
  const again = boot({ user: OWED });
  await again.started;
  assert.deepEqual(again.inTheSameTick, ['make']);
});

test('answered on another device: the make screen the snapshot drew goes once the session is confirmed', async () => {
  const run = boot({ user: OWED, fromSnapshot: true });
  await run.started;
  assert.deepEqual(run.inTheSameTick, ['make']);
  await run.reconcile({ ...OWED, needsCommunitiesChoice: false, storyFirstSession: false });
  assert.deepEqual(run.calls, ['make', 'dismiss']);
  assert.deepEqual(run.fetches, [], 'nothing recorded for a question already answered');
  assert.equal(run.gate.applies(), false);
});

test('a snapshot that says owed, a server that says a username comes first: the make screen waits for it', async () => {
  const run = boot({ user: OWED, fromSnapshot: true });
  await run.started;
  await run.reconcile({ ...OWED, needsUsernameChoice: true });
  assert.deepEqual(run.calls.slice(0, 2), ['make', 'dismiss'], 'taken down for the username step');
  // ...and asked after it, as a first sign-in with a username to choose is.
  assert.equal(run.calls[2], 'make');
});

test('somebody already in a group or with a project of their own, or an invitee, is never put on the make screen', async () => {
  // The server answers the join screen for a link (services/community-
  // invites.js), and says storyFirstSession false for an account that is
  // already somewhere (services/first-session.js asksWhatToMake).
  for (const user of [
    { ...OWED, needsCommunitiesChoice: false, storyFirstSession: false },
    { ...OWED, storyFirstSession: false },
  ]) {
    for (const fromSnapshot of [false, true]) {
      const run = boot({ user, fromSnapshot });
      await run.started;
      if (fromSnapshot) await run.reconcile(user);
      assert.ok(!run.calls.includes('make'), JSON.stringify({ user, fromSnapshot }));
      assert.ok(!run.fetches.some(([url]) => url === STARTED[0]));
    }
  }
  // On an invite's own address the invite is followed first, snapshot or not.
  const invited = boot({ user: OWED, fromSnapshot: true, pathname: '/invite/AAAAAAAAAAAAAAAAAAAAAA' });
  await invited.started;
  assert.deepEqual(invited.inTheSameTick, []);
});

test('the waiting room is untouched: no make screen before the account is let in', async () => {
  const waiting = { ...OWED, hasPlatformAccess: false };
  const run = boot({ user: waiting, fromSnapshot: true });
  await run.started;
  assert.deepEqual(run.inTheSameTick, []);
  assert.equal(run.gate.firstSessionNow(waiting), false);
  // `sv:authed` itself never fires in the waiting room (app.js enterAuthed
  // returns to AuthScreens.showWaiting first), and the start route stays
  // open to it so a story account's start is kept for the day it is let in.
  const app = read('public/js/app.js');
  assert.ok(app.indexOf('AuthScreens.showWaiting();') < app.indexOf("document.dispatchEvent(new CustomEvent('sv:authed'"));
});

test('an invite followed from the join step keeps this device\'s snapshot in step', async () => {
  const gate = read('frontend/src/features/auth/communities-first-run.js');
  assert.match(gate, /if \(await CommunitiesFirstRun\._joinedByInvite\(\)\) \{\s+CommunitiesFirstRun\._answered = true;\s+window\.App\.user\.needsCommunitiesChoice = false;\s+(?:\/\/[^\n]*\n\s+)*try \{ window\.App\.saveSessionSnapshot\?\.\(window\.App\.user\); \} catch \(_\) \{\}/);
});

// ── the island's two answers ────────────────────────────────────────────

async function withGlobals(globals, fn) {
  const prior = {};
  for (const key of Object.keys(globals)) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
}

test('Make it and "Look around first" each end it: on the account, the shell\'s copy, the snapshot, and this document', async () => {
  const island = loadTsx(ISLAND);
  assert.equal(island.LOOK_AROUND_PATH, '/api/me/first-session/look-around');
  const saved = [];
  const fetches = [];
  const errors = [];
  const window = { App: { user: { ...OWED }, saveSessionSnapshot: (u) => saved.push({ ...u }) } };
  await withGlobals({
    window,
    fetch: async (url, init) => { fetches.push([url, init.method, init.credentials]); return { ok: true }; },
  }, async () => {
    // Before an answer, the island opens it when asked.
    const modes = [];
    const setMode = (fn) => modes.push(fn({ kind: 'none' }));
    island.openMake(setMode, false);
    assert.deepEqual(modes, [{ kind: 'make' }]);

    island.noteAnswered();
    assert.equal(window.App.user.needsCommunitiesChoice, false);
    assert.equal(saved.length, 1, 'the snapshot is written, so the next boot does not draw it first');
    assert.equal(saved[0].needsCommunitiesChoice, false);
    // Not opened again in this document, whatever asks: a verified read
    // that lands before the server has the answer cannot bring it back.
    island.openMake(setMode, false);
    island.openMake(setMode, true);
    assert.deepEqual(modes, [{ kind: 'make' }]);

    await island.recordLookAround();
    assert.deepEqual(fetches, [['/api/me/first-session/look-around', 'POST', 'same-origin']]);
  });

  // A failed request leaves the question owed for the next boot, quietly.
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await withGlobals({ window, fetch: async () => { throw new TypeError('Failed to fetch'); } }, async () => {
      await island.recordLookAround();
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [], 'never a console.error, which fails proposal checks');

  const src = read(ISLAND);
  assert.match(src, /onMade=\{\(made\) => \{ noteAnswered\(\); setMode\(\{ kind: 'made', made \}\); \}\}/);
  assert.match(src, /onLookAround=\{\(\) => \{\s+noteAnswered\(\);\s+void recordLookAround\(\);\s+setMode\(\{ kind: 'none' \}\);\s+legacy\(\)\.App\?\.navigateHome\?\.\(\);\s+\}\}/);
  // The snapshot's screen is taken down only while it is still the make
  // screen: what Make it led to stays.
  // Nor the Create button's make screen, which nobody owes an answer to.
  assert.match(src, /dismissMake\(\): void \{\s+setMode\(\(prev\) => \(prev\.kind === 'make' && prev\.entry !== 'create' \? \{ kind: 'none' \} : prev\)\);/);
  // Made from Create, nothing is answered: the first session's question
  // stays the first session's (noteAnswered only on its own door).
  const fromCreate = src.slice(src.indexOf("if (mode.kind === 'make' && mode.entry === 'create') {"), src.indexOf("if (mode.kind === 'make') {"));
  assert.ok(fromCreate.length > 0, 'the Create door has its own branch');
  assert.doesNotMatch(fromCreate, /noteAnswered|recordLookAround/);
});

test('the admin Journey page says where somebody sits who was asked what to make and has not said', () => {
  const journey = require('../src/services/journey');
  const row = {
    user_id: 11, password_set: true, account_at: '2026-10-05T09:00:00Z', has_platform_access: true,
    access_at: '2026-10-05T09:00:00Z', opened_at: '2026-10-05T09:01:00Z', needs_username_choice: false,
    needs_communities_choice: true, first_act_at: null,
  };
  const asked = journey.firstMileSteps({ ...row, getting_started_seen: { first_session: 'sign_in' } }, new Date('2026-10-05T12:00:00Z'));
  assert.equal(asked.stuckAt, 'join');
  assert.equal(asked.stuckReason, 'Asked what to make, not answered');
  const never = journey.firstMileSteps(row, new Date('2026-10-05T12:00:00Z'));
  assert.equal(never.stuckReason, 'Join screen not answered');
  // Answered: still "not asked: <how it reached them>", the meaning it had.
  const answered = journey.firstMileSteps({
    ...row, needs_communities_choice: false,
    getting_started_seen: { first_session: 'story', join_answer: 'story', first_session_answer: 'looked_around' },
  }, new Date('2026-10-05T12:00:00Z'));
  assert.equal(answered.steps.find((s) => s.key === 'join').note, 'not asked: story');
});
