'use strict';

// The two ends of an invite by @username, on screen.
//
// First-session run-through, 5 October 2026 (Page Turners). alex_t1005
// invited mo_t1006 by username from the made screen's invite sheet
// (frontend/src/features/first-session/made.tsx), and:
//
//   1. Send closed the sheet with nothing said. Now the sheet stays up and
//      says where the invite went, or, in its own words, why it did not.
//   2. Share invite opened again on "Come try it with me!", not alex's own
//      note. Now the note is kept per project on the device (else read back
//      from alex's own newest link), and the invite carries it.
//   4. mo's invite read "invited you to build", with no note and no
//      headcount (features/notifications). Now an invite into a private
//      project is an invitation to join it, with the note and "2 people are
//      in it", and its push says so too.
//   5. Accept dropped mo in the chat. Now an accept that joined them opens
//      "You're in" and the tour, through the bridge the invite link uses
//      (window.UsernodeReact.firstSession.welcome).
//
// The server half (the codes, the note, the welcome, the counted rule line)
// is tests/username-invite-join-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MADE = 'frontend/src/features/first-session/made.tsx';

function withStorage(entries, fn) {
  const saved = global.localStorage;
  const store = new Map(Object.entries(entries));
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  try { return fn(store); } finally {
    if (saved === undefined) delete global.localStorage; else global.localStorage = saved;
  }
}

const MADE_PROPS = {
  made: { slug: 'page-turners', name: 'Page Turners', emoji: '📚', description: null, example: null, conversationId: null },
  me: 'alex_t1005',
  onClose() {},
  onSent() {},
};

// ── 1. The made screen's sheet sends no invite by username any more ─────
//
// Evan, 5 October 2026: somebody who has just made their first project knows
// nobody on Homeroom yet, so the first invite is a link and nothing else. An
// invite by username is still sent from the project's Members dialog
// (features/dialogs/members-controller.js), and accepted as below.

test('1. the made screen\'s sheet is Share link alone; a username is invited from Members', () => {
  const made = loadTsx(MADE);
  assert.equal(made.sentLine, undefined);
  assert.equal(made.inviteError, undefined);
  const src = read(MADE);
  assert.doesNotMatch(src, /Invite by username|@username|\/invites`/);
  assert.match(src, /await postNote\(\);\s+onSent\(\);/);
  assert.match(src, /onSent=\{\(\) => \{ setSent\(true\); setInviting\(false\); \}\}/);
  assert.match(src, /role="status" data-first-session-invite-status=""/);
  assert.match(read('frontend/src/features/dialogs/members-controller.js'), /\/invites`/);
  withStorage({}, () => {
    const html = renderToHtml(createElement(made.InviteSheet, MADE_PROPS));
    assert.match(html, />Share link</);
    assert.doesNotMatch(html, /username/i);
  });
});

test('1. what they\'ll get: "is making" while its first version is not live', () => {
  const made = loadTsx(MADE);
  assert.equal(made.makerLine('alex_t1005', 'Page Turners', true), 'alex_t1005 is making Page Turners');
  assert.equal(made.makerLine('alex_t1005', 'Page Turners', false), 'alex_t1005 made Page Turners');
  withStorage({}, () => {
    assert.match(renderToHtml(createElement(made.InviteSheet, MADE_PROPS)), /data-first-session-invite-maker="" class="[^"]*">alex_t1005 is making Page Turners</,
      'being made unless told otherwise');
    assert.match(renderToHtml(createElement(made.InviteSheet, { ...MADE_PROPS, making: false })), />alex_t1005 made Page Turners</);
  });
  const src = read(MADE);
  // The shared link's title says the same.
  assert.match(src, /const title = makerLine\(me, made\.name, making\);/);
  // Live once a first version that was on its way is read as gone.
  assert.match(src, /if \(app\.firstVersion && !app\.firstVersion\.ready\) setBuilding\(true\);/);
  // A setup that stopped is not live either (tests/create-front-door.test.js).
  // An import is live once it runs (it has no first version).
  assert.match(src, /const making = imported \? appStatus !== 'running' : \(!!stalled \|\| !\(building && !fv\)\);/);
});

// ── 2. The note is remembered ───────────────────────────────────────────

test('2. the sheet opens on the maker\'s last note for that project', () => {
  const { InviteSheet, noteKey, openingNote, linkNote } = loadTsx(MADE);
  assert.equal(noteKey('page-turners'), 'usernode:first-session:note:page-turners');
  withStorage({}, () => {
    assert.equal(openingNote('page-turners', null), 'Come try it with me!', 'nothing kept: the default');
    assert.equal(openingNote('page-turners', 'Pick our next book!'), 'Pick our next book!', 'an example\'s own note');
    const html = renderToHtml(createElement(InviteSheet, MADE_PROPS));
    assert.match(html, /<textarea[^>]*>Come try it with me!<\/textarea>/);
  });
  withStorage({ 'usernode:first-session:note:page-turners': 'Fridays at mine, bring a book' }, () => {
    assert.equal(openingNote('page-turners', 'Pick our next book!'), 'Fridays at mine, bring a book');
    assert.equal(openingNote('another-project', null), 'Come try it with me!', 'per project');
    const html = renderToHtml(createElement(InviteSheet, MADE_PROPS));
    assert.match(html, /<textarea[^>]*>Fridays at mine, bring a book<\/textarea>/);
  });
  withStorage({ 'usernode:first-session:note:page-turners': '' }, () => {
    assert.equal(openingNote('page-turners', null), '', 'a note they cleared stays cleared');
  });
  // Nothing kept on this device: the newest note on one of their own links.
  assert.equal(linkNote([{ mine: false, note: 'not mine' }, { mine: true, note: null }, { mine: true, note: 'Read with us' }]), 'Read with us');
  assert.equal(linkNote([]), null);
  assert.equal(linkNote(undefined), null);
  const src = read(MADE);
  assert.match(src, /onChange=\{\(e\) => \{ ownNote\.current = true; setNote\(e\.target\.value\); keepNote\(made\.slug, e\.target\.value\); \}\}/);
  assert.match(src, /const fromLink = live && !ownNote\.current \? linkNote\(data\?\.links\) : null;/);
});

// ── 4 and 5. The invitee's end ──────────────────────────────────────────

const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const NOTIF_SRC = read('frontend/src/features/notifications/notifications.js').replace(/^import \{ agoStamp \}.*$/m, '');

function loadNotifications({ welcome } = {}) {
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams,
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      calls.push(['fetch', String(url)]);
      return { ok: true, json: async () => sandbox.acceptBody };
    },
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 3 }, _isScreenVisible: () => false },
    HomePanels: { ensureLoaded: (opts) => calls.push(['homePanels', !!(opts && opts.force)]) },
    UsernodeReact: {
      messages: { openDiscussion: (slug) => calls.push(['discussion', slug]) },
      ...(welcome ? { firstSession: { welcome: (info) => { calls.push(['welcome', JSON.parse(JSON.stringify(info))]); return welcome(info); } } } : null),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  vm.runInContext(NOTIF_SRC, sandbox);
  const N = sandbox.Notifications;
  N._renderBadge = () => {};
  N.refresh = async () => true;
  N._dismissSheetForNav = () => calls.push(['dismiss']);
  return { N, calls, sandbox };
}

const PENDING = {
  kind: 'collab', appId: 1, appSlug: 'page-turners', appName: 'Page Turners', invitedBy: 'alex_t1005',
  createdAt: new Date().toISOString(), joins: true, note: 'Come read with us!', memberCount: 2,
};

test('4. a group\'s invite is to join it, with the maker\'s note and how many are in it', () => {
  const { N } = loadNotifications();
  let state = null;
  N._store = { set: (patch) => { state = patch; } };
  N.invites = [
    PENDING,
    { ...PENDING, appId: 2, appSlug: 'open-library', appName: 'Open Library', joins: false, note: null, memberCount: 1 },
    { kind: 'approver', appId: 3, appSlug: 'arena', appName: 'Arena', invitedBy: 'dee', createdAt: PENDING.createdAt, joins: false, note: null, memberCount: null },
  ];
  N._renderInvites();
  const [join, build, approver] = JSON.parse(JSON.stringify(state.invites));
  assert.deepEqual([join.who, join.verb, join.appName, join.note, join.members],
    ['@alex_t1005', 'invited you to join', 'Page Turners', 'Come read with us!', '2 people are in it']);
  assert.deepEqual([build.verb, build.note, build.members], ['invited you to build', '', '1 person is in it'],
    'a project anyone can use but only its invited people build');
  assert.deepEqual([approver.verb, approver.note, approver.members], ['asked you to help approve changes to', '', '']);

  // The history row under Today says the same.
  const row = (detail) => N._rowView({ id: 9, kind: 'collab_invite', detail, readAt: null, createdAt: PENDING.createdAt,
    appSlug: 'page-turners', appName: 'Page Turners', sourceUsername: 'alex_t1005' }).label;
  assert.equal(row('join'), 'Invited you to join');
  assert.equal(row(null), 'Invited you to build with them');

  // And the row draws them, the note quoted as the link's page quotes it.
  const list = loadTsx('frontend/src/features/notifications/notifications-list.tsx', {
    stubs: {
      './notifications-store.js': {
        notificationsStore: { get: () => ({ saved: null, invites: [join, build], touch: false }), subscribe: () => () => {} },
      },
    },
  });
  const html = renderToHtml(createElement(list.NotificationsPinnedSections, {}));
  assert.match(html, /<span class="font-bold">@alex_t1005<\/span> invited you to join <span class="font-bold">Page Turners<\/span>/);
  assert.match(html, /<p data-invite-note=""[^>]*>“Come read with us!”<\/p>/);
  assert.match(html, /<span data-invite-members="">2 people are in it · <\/span>/);
  assert.equal((html.match(/data-invite-note=/g) || []).length, 1, 'no empty note on an invite without one');
});

test('4. an invite to join is pushed as one', () => {
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const context = { appName: 'Page Turners', sourceUsername: 'alex_t1005', detail: 'join' };
  assert.deepEqual(buildNotificationCopy('collab_invite', context),
    { title: '@alex_t1005 invited you to join Page Turners', body: 'Accept or decline in the app' });
  assert.deepEqual(buildNotificationCopy('collab_invite', { ...context, detail: null }),
    { title: '@alex_t1005 wants to build Page Turners with you', body: 'Join them to build it. Accept or decline in the app' },
    'an invite to build is worded as before');
});

test('5. Accept opens "You\'re in" and its tour, the link path\'s welcome', async () => {
  const welcome = {
    slug: 'page-turners', name: 'Page Turners', iconEmoji: '📚', iconUrl: null,
    inviterName: 'alex_t1005', inviterMadeIt: true, newAccount: false,
  };
  const { N, calls, sandbox } = loadNotifications({ welcome: () => true });
  sandbox.acceptBody = { ok: true, appSlug: 'page-turners', welcome };
  N.invites = [PENDING];
  await N._acceptInvite(1, 'page-turners', 'collab');
  const seen = JSON.parse(JSON.stringify(calls.filter((c) => c[0] !== 'fetch')));
  assert.deepEqual(seen, [['dismiss'], ['welcome', welcome], ['homePanels', true]],
    'the sheet goes, "You\'re in" opens, and Home\'s challenges are read fresh for the tour; no jump to the chat');
});

test('5. without a welcome, or once it has been shown, Accept opens the chat as before', async () => {
  for (const [label, body, shows] of [
    ['no welcome in the answer', { ok: true, appSlug: 'page-turners' }, () => true],
    ['already shown for this project', { ok: true, appSlug: 'page-turners', welcome: { slug: 'page-turners', name: 'Page Turners' } }, () => false],
  ]) {
    const { N, calls, sandbox } = loadNotifications({ welcome: shows });
    sandbox.acceptBody = body;
    N.invites = [PENDING];
    await N._acceptInvite(1, 'page-turners', 'collab');
    assert.deepEqual(calls.filter((c) => c[0] === 'discussion'), [['discussion', 'page-turners']], label);
  }
  // An approver invite never asks for it.
  const { N, calls, sandbox } = loadNotifications({ welcome: () => true });
  sandbox.acceptBody = { ok: true, appSlug: 'arena', welcome: { slug: 'arena', name: 'Arena' } };
  await N._acceptInvite(3, 'arena', 'approver');
  assert.ok(!calls.some((c) => c[0] === 'welcome'));
  assert.deepEqual(calls.filter((c) => c[0] === 'discussion'), [['discussion', 'arena']]);
});
