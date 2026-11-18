'use strict';

// #6100: a closed change says why. The proposal machine keeps the reason it
// closed with (chat_sessions.close_reason), and the two places its author
// looks word it from one set of catalog sentences (core:change.closedWhy.*):
//
//   - the change's page: the hero reads "Closed" (a closed change's row is
//     'archived'), and the Votes card's closed note adds the sentence;
//   - the bell: the author's "Closed" row, and a "Ready to try" row whose
//     change has closed since.
//
// A reason this build does not know, or a close from before reasons were
// kept, shows what it always did. The server side is
// tests/workflow-proposal-postgres.test.js (P13, P13b).
//
// Run with: node --test tests/change-close-reason.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadAppView } = require('./lib/app-view-vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const BELL_SRC = read('frontend/src/features/notifications/notifications.js').replace(/^import \{ agoStamp \}.*$/m, '');

function loadBell() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '', hash: '#home' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '', getElementById: () => null, addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }), body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 1 }, openAppTab: () => {}, _isScreenVisible: () => false },
    UsernodeReact: { workshop: { setTab: () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(BELL_SRC, sandbox);
  return sandbox.Notifications;
}

// The reasons the machine words in a closed change's thread: each has a
// sentence here too.
const CODES = (() => {
  const fn = /function closedLine\([\s\S]*?\n\}/.exec(read('src/workflow/proposal/machine.ts'));
  assert.ok(fn, 'closedLine still exists');
  return [...fn[0].matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
})();

// A closed change as its details read hands it over.
const closed = (over) => ({
  id: 7, app_slug: 'demo-app', user_id: 1, username: 'ada', session_title: 'Dark mode for the reading list',
  status: 'archived', created_at: '2026-10-20T00:00:00Z', close_reason: 'auto-rejected', ...over,
});
const subject = (view) => view.segments.map((s) => s.v).join(' ');

test('the page says Closed, and its Votes card says why', () => {
  const AppView = loadAppView();
  const view = AppView._changeVotesView(closed(), {});
  assert.equal(view.figure, message('changes:page.votes.figure.closed'), 'no tally for a change nobody can vote on');
  assert.deepEqual([...view.note], [
    message('changes:page.votes.note.closed'),
    message('core:change.closedWhy.autoRejected'),
  ], 'the note it had, then why');
  assert.equal(AppView._topicHeroView('proposal', closed()).status, message('changes:page.hero.status.closed'),
    'the hero says Closed, not the raw word archived');
});

test('an unknown or missing reason keeps the plain note', () => {
  const AppView = loadAppView();
  for (const reason of [null, undefined, 'unknown', 'constructor', 'a-reason-from-a-newer-build']) {
    const view = AppView._changeVotesView(closed({ close_reason: reason }), {});
    assert.deepEqual([...view.note], [message('changes:page.votes.note.closed')], String(reason));
  }
});

test('the author\'s Closed row names the change and gives the reason', () => {
  const N = loadBell();
  const row = (extra) => ({
    id: 7, kind: 'change_closed', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Demo', appSlug: 'demo', sessionId: 42, prTitle: 'Dark mode for the reading list',
    sessionStatus: 'archived', closeReason: 'auto-rejected', ...extra,
  });
  const view = N._rowView(row());
  assert.equal(view.label, message('notifications:row.changeClosed.label'));
  assert.equal(subject(view), `Dark mode for the reading list ${message('core:change.closedWhy.autoRejected')}`);
  assert.equal(view.needsYou, false, 'there is nothing left to do');
  for (const reason of [null, 'unknown', 'constructor']) {
    assert.equal(subject(N._rowView(row({ closeReason: reason }))), 'Dark mode for the reading list', String(reason));
  }
  assert.equal(subject(N._rowView(row({ prTitle: null }))),
    `${message('notifications:row.changeClosed.yourChange')} ${message('core:change.closedWhy.autoRejected')}`);
});

test('a Ready to try row that closed gives the same reason', () => {
  const N = loadBell();
  const row = (extra) => ({
    id: 8, kind: 'change_ready', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Demo', appSlug: 'demo', sourceUsername: 'alex', sessionId: 42,
    sessionStatus: 'archived', prTitle: 'Water reminders', closeReason: 'red-checks', ...extra,
  });
  const view = N._rowView(row());
  assert.equal(view.label, message('notifications:row.changeReady.closed'));
  assert.equal(subject(view), `Water reminders ${message('core:change.closedWhy.redChecks')}`);
  assert.equal(subject(N._rowView(row({ closeReason: null }))), 'Water reminders', 'an older close keeps the plain row');
});

test('every reason the machine words has a sentence on the page and in the bell, the same one', () => {
  const AppView = loadAppView();
  const N = loadBell();
  assert.ok(CODES.length >= 18, `closedLine's reasons were read (${CODES.length})`);
  for (const code of CODES) {
    const id = AppView.CLOSE_REASON_IDS[code];
    assert.ok(id, `the page words ${code}`);
    const view = N._rowView({
      id: 1, kind: 'change_closed', createdAt: new Date().toISOString(), readAt: null,
      appName: 'Demo', appSlug: 'demo', sessionId: 42, prTitle: 'A change', closeReason: code,
    });
    assert.equal(view.segments.length, 2, `the bell words ${code}`);
    assert.equal(view.segments[1].v, message(id), `${code}: one sentence in both places`);
  }
});

test('the server hands both places the reason, and the kind follows Your proposals', () => {
  const svc = read('src/services/notifications.js');
  assert.match(svc, /cs\.close_reason AS close_reason,/);
  assert.match(svc, /SESSION_STATUS_KINDS\.has\(row\.kind\) \? \{ closeReason: row\.close_reason \|\| null \} : \{\}/);
  assert.match(read('src/routes/sessions.js'), /cs\.shots_detail, cs\.shots_updated_at,\n\s+cs\.close_reason,/);
  const prefs = require('../src/workflow/rules/notification-preferences.ts');
  assert.equal(prefs.categoryForKind('change_closed'), 'proposal_status');
});
