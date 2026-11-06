'use strict';

// The daily "Waiting for your approval" digest opens what it is about.
//
// On 4 October its row ("Waiting for your approval · 1 change") opened
// nothing: the digest is written with no app and no session
// (services/vote-digest.js), and the bell's router has no destination for a
// row without an app, so a tap, or a push, left the person on whatever screen
// was showing. Now a digest of ONE change names it, and opens that change;
// a digest of several opens the Communities screen's Needs you, which lists
// every vote owed across their projects.
//
// The REAL shipped notifications.js runs in a vm, as in
// tests/notifications-app-discussion.test.js.
//
// Run with: node --test tests/vote-digest-destination.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const voteDigest = require('../src/services/vote-digest');
const { buildNotificationCopy } = require('../src/services/mobile-push-policy');

const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8',
).replace(/^import \{ agoStamp \}.*$/m, '');

function load() {
  const calls = [];
  const location = { search: '', hash: '#messages/77' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, location,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: {
      user: { id: 1 },
      openAppTab: (slug, tab, opts) => { calls.push(['openAppTab', slug, tab, opts || null]); },
      navigateToProfileProposals: (kind) => { calls.push(['navigateToProfileProposals', kind]); },
      _isScreenVisible: () => false,
    },
    UsernodeReact: {
      workshop: { setTab: (tab) => calls.push(['setTab', tab]) },
      devBoard: { showVotes: (id) => calls.push(['showVotes', id]) },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  vm.runInContext(SRC, sandbox);
  const N = sandbox.Notifications;
  N._renderBadge = () => {};
  N.refresh = async () => true;
  N._markOneRead = () => {};
  N._dismissSheetForNav = () => calls.push(['dismiss']);
  return { N, calls, location };
}

const nav = (calls) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] !== 'dismiss')));

test('a digest of one change opens that change', () => {
  const { N, calls } = load();
  N.items = [{ id: 1, readAt: null, kind: 'vote_digest', detail: '1', appSlug: 'flat-4b-chores', sessionId: 40 }];
  N._onItemClick(1);
  // Run four (13 Oct): at its Votes card (tests/change-votes-in-view.test.js).
  // #6099: the row's own session id is carried as a typed topic ref, so the
  // digest opens exactly the change it names. It normalizes to the same page
  // the old `subTab: 'proposals'` spelling did.
  assert.deepEqual(nav(calls), [['showVotes', 40], ['openAppTab', 'flat-4b-chores', 'dev', { subTab: 'topic', ref: { kind: 'proposal', id: 40 } }]]);
  assert.equal(calls[0][0], 'dismiss', 'the sheet gets out of the way first');
});

// #5404: the Monday count of the changes you voted on names none of them.
test('the Monday row opens Your votes', () => {
  const { N, calls } = load();
  N.items = [{ id: 4, readAt: null, kind: 'voted_digest', detail: '3', appSlug: null, sessionId: null }];
  N._onItemClick(4);
  assert.deepEqual(nav(calls), [['navigateToProfileProposals', 'votes']]);
  assert.equal(calls[0][0], 'dismiss', 'the sheet gets out of the way first');
});

// Run four (13 Oct 2026): every row that asks for the reader's vote opens the
// change at its Votes card; a row about anything else opens it as before.
test('a row that asks for a vote opens the change at its Votes card', () => {
  for (const kind of ['pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready']) {
    const { N, calls } = load();
    N.items = [{ id: 3, readAt: null, kind, appSlug: 'club-votes', sessionId: 7, prNumber: 4, sessionStatus: 'promoted' }];
    N._onItemClick(3);
    assert.deepEqual(nav(calls)[0], ['showVotes', 7], kind);
    assert.equal(nav(calls)[1][0], 'openAppTab', kind);
  }
  for (const kind of ['pr_merged', 'kudos', 'check_failed', 'voted_change_merged']) {
    const { N, calls } = load();
    N.items = [{ id: 4, readAt: null, kind, appSlug: 'club-votes', sessionId: 7 }];
    N._onItemClick(4);
    assert.equal(nav(calls).some((c) => c[0] === 'showVotes'), false, kind);
  }
  // A ready-to-try whose change went live opens the app: nothing to vote on.
  const { N, calls } = load();
  N.items = [{ id: 5, readAt: null, kind: 'change_ready', appSlug: 'club-votes', sessionId: 7, sessionStatus: 'merged' }];
  N._onItemClick(5);
  assert.deepEqual(nav(calls), [['openAppTab', 'club-votes', 'app', null]]);
});

test('a digest of several opens Needs you, which lists them, instead of nothing', () => {
  const { N, calls, location } = load();
  N.items = [{ id: 2, readAt: null, kind: 'vote_digest', detail: '3', appSlug: null, sessionId: null }];
  N._onItemClick(2);
  // One Home (#6361): Needs you is a page of its own, #needs.
  assert.deepEqual(nav(calls), []);
  assert.equal(location.hash, '#needs', 'not the screen it was tapped on (the bot DM, on 4 October)');
});

test('the digest names its change when there is exactly one, and nothing when there are several', async () => {
  const sql = voteDigest.PENDING_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /CASE WHEN COUNT\(DISTINCT p\.id\) = 1 THEN MIN\(p\.id\) END AS only_session_id/);
  assert.match(sql, /CASE WHEN COUNT\(DISTINCT p\.id\) = 1 THEN MIN\(p\.app_id\) END AS only_app_id/);

  const prefs = require('../src/services/notification-preferences');
  const notifications = require('../src/services/notifications');
  const saved = { filter: prefs.filterUsersByCategory, push: notifications.hydrateAndPush };
  prefs.filterUsersByCategory = async (_pool, { userIds }) => userIds;
  notifications.hydrateAndPush = async () => {};
  const inserted = [];
  // Each digest is written in a transaction of its own, under its person's
  // lock, by an INSERT that checks again that none went out lately.
  const client = {
    async query(text, params) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || /pg_advisory_xact_lock/.test(text)) return { rows: [] };
      // It owes no email: mailed_at is written with the notice (#5794).
      assert.match(text, /INSERT INTO notifications \(user_id, app_id, session_id, source_user_id, kind, detail, mailed_at\)/);
      assert.match(text, /NOT EXISTS/);
      inserted.push(params.slice(0, 4));
      return { rows: [{ id: inserted.length, user_id: params[0] }] };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    async query() {
      return {
        rows: [
          { user_id: 1, pending: '1', only_session_id: 40, only_app_id: 5 },
          { user_id: 2, pending: '3', only_session_id: null, only_app_id: null },
        ],
      };
    },
  };
  try {
    const result = await voteDigest.sweep(pool);
    assert.equal(result.sent, 2);
  } finally {
    prefs.filterUsersByCategory = saved.filter;
    notifications.hydrateAndPush = saved.push;
  }
  assert.deepEqual(inserted, [[1, '1', 5, 40], [2, '3', null, null]]);
});

test('the push says where a tap goes', () => {
  assert.deepEqual(buildNotificationCopy('vote_digest', { detail: '1' }),
    { title: '1 change is waiting for your approval', body: 'Open it to try it and approve it' });
  assert.deepEqual(buildNotificationCopy('vote_digest', { detail: '3' }),
    { title: '3 changes are waiting for your approval', body: 'See them under Needs you in Communities' });
});
