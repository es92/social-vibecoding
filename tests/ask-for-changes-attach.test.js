'use strict';

// Ask for changes attaches the change itself (first-session run-through,
// 5 October 2026).
//
// An invited flatmate pressed "Ask for changes" on a change Homeroom bot
// built and got a raw "Share item" form in their chat with the bot: the
// project not chosen (75 apps, theirs at position 53), the change's id typed
// in for them, and the chip it left on the composer read
// "flat-4b-chores-e98ecd · Proposa…". The change page knows the project and
// the change, so now:
//
//   - app-view.js hands openBot the change with its project (id and slug);
//   - openBot attaches a reference that names its project and itself on the
//     bot chat's composer directly, with the box asking "What should
//     change?" and the caret in it; anything less still opens the dialog;
//   - the chip reads as the card it becomes ("Change · <title> · <project> ·
//     waiting for approval"), from the server's own reading of it, and never
//     shows the short name or "Proposal";
//   - the Share item dialog, where it is still shown, opens on the app it
//     was opened from and lists the viewer's own projects first.
//
// Run with: node --test tests/ask-for-changes-attach.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the change page hands the change over with its project', () => {
  const view = read('public/js/app-view.js');
  const fn = view.slice(view.indexOf('  askBotForChanges(sessionId, title) {'), view.indexOf('  /** B8: whether Homeroom bot builds requests here'));
  assert.match(fn, /type: 'proposal', sessionId: Number\(sessionId\), title: title \|\| null,/);
  assert.match(fn, /appId: Number\(app\.id\) > 0 \? Number\(app\.id\) : undefined,/);
  assert.match(fn, /appSlug: app\.slug \|\| App\.currentApp \|\| undefined,/);
  assert.match(fn, /messages\.openBot\(reference\)/);
});

test('openBot attaches a complete change directly, and leaves anything less to the dialog', async () => {
  let opened = 0;
  const fakeApi = new Proxy({
    async openBotConversation() { opened += 1; return 77; },
    strictId: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null),
  }, { get: (t, k) => (k in t ? t[k] : () => { throw new Error(`api.${String(k)} not stubbed`); }) });
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': fakeApi } });
  assert.equal(message('messages:store.askForChangesPlaceholder'), 'What should change?');
  assert.equal(store.ASK_FOR_CHANGES_PLACEHOLDER, 'messages:store.askForChangesPlaceholder');

  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269, appSlug: 'flat-4b-chores-e98ecd' }), true);
  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269, appId: 12 }), true);
  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269 }), false, 'no project: the dialog asks');
  assert.equal(store.stagedComplete({ type: 'proposal', appSlug: 'x' }), false, 'no change');
  assert.equal(store.stagedComplete({ type: 'issue', issueNumber: 4, appSlug: 'x' }), true);
  assert.equal(store.stagedComplete({ type: 'spec', sessionId: 4, appSlug: 'x' }), false, 'a spec needs its version');

  const change = { type: 'proposal', sessionId: 6269, appId: 12, appSlug: 'flat-4b-chores-e98ecd', title: 'Show whose turn each chore is' };
  await store.openBot(change);
  assert.equal(opened, 1);
  assert.equal(store.takePendingShare(), undefined, 'no Share item dialog');
  assert.equal(store.takePendingAttach(5), null, 'only for the chat with the bot');
  assert.deepEqual(store.takePendingAttach(77), { object: change, placeholder: 'What should change?' });
  assert.equal(store.takePendingAttach(77), null, 'once');

  await store.openBot({ type: 'proposal', sessionId: 6269 });
  assert.equal(store.takePendingAttach(77), null);
  assert.deepEqual(store.takePendingShare(), { type: 'proposal', sessionId: 6269 }, 'an incomplete one is still chosen in the dialog');
});

test('the composer takes the attached change: its chip, its prompt, the caret, and only the reference is sent', () => {
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /window\.addEventListener\('usernode:messages-attach', attachPending\);/);
  assert.match(composer, /const pending = takePendingAttach\(conversationId\);/);
  assert.match(composer, /setObject\(pending\.object\); setPrompt\(pending\.placeholder\); setFocusWanted\(true\);/);
  assert.equal(message('messages:composer.placeholderThread'), 'Reply in thread…');
  assert.equal(message('messages:composer.placeholder'), 'Message…');
  // One request, one story: a thread's placeholder is chosen apart (a
  // request's thread in the chat with Homeroom bot says which request);
  // a room's thread keeps "Reply in thread…".
  assert.match(composer, /placeholder=\{inThread \? threadPlaceholder : \(prompt \|\| t\('messages:composer\.placeholder'\)\)\}/);
  assert.match(composer, /const threadPlaceholder = !botRequest \? t\('messages:composer\.placeholderThread'\)/);
  assert.match(composer, /\{pendingObjectLabel\(object, stagedCard\)\}/);
  assert.match(composer, /object: object \? referenceOf\(object\) : undefined/, 'the staged title is never sent');
  assert.match(composer, /api\.resolveLinkCards\(\[\{ type, appSlug, issueNumber, sessionId, proposalId \}\]\)/,
    'the chip reads what a sent card reads');
  assert.doesNotMatch(composer, /function objectLabel/, 'the slug-and-id label is gone');
  // The store's attach and the composer's listener meet on one event name.
  assert.match(read('frontend/src/features/messages/store.ts'), /new CustomEvent\('usernode:messages-attach'\)/);
});

test('the chip names the title and the project, never the short name or "Proposal"', () => {
  const { pendingObjectLabel } = loadTsx('frontend/src/features/messages/format.tsx');
  const object = { type: 'proposal', sessionId: 6269, appSlug: 'flat-4b-chores-e98ecd', title: 'Show whose turn each chore is' };
  const card = {
    type: 'proposal', available: true, appSlug: 'flat-4b-chores-e98ecd', sessionId: 6269,
    title: 'Show whose turn each chore is', subtitle: 'Flat 4B Chores', state: 'waiting for approval', author: null,
  };
  assert.equal(pendingObjectLabel(object, card), 'Change · Show whose turn each chore is · Flat 4B Chores · waiting for approval');
  assert.equal(pendingObjectLabel(object, null), 'Change · Show whose turn each chore is', 'before the server answers');
  assert.equal(pendingObjectLabel({ type: 'proposal', sessionId: 6269, appSlug: 'flat-4b-chores-e98ecd' }, null), 'Change');
  assert.equal(pendingObjectLabel(object, { ...card, available: false, title: null }), 'Change · Show whose turn each chore is');
  assert.equal(pendingObjectLabel({ type: 'issue', issueNumber: 4, appSlug: 'plant-pal' }, null), 'Request · #4');
  assert.equal(pendingObjectLabel({ type: 'app', appSlug: 'plant-pal' }, { type: 'app', available: true, title: 'Plant Pal', subtitle: 'Plant Pal', state: 'running' }),
    'App · Plant Pal', 'a project named once, without its container state');
  for (const label of [pendingObjectLabel(object, card), pendingObjectLabel(object, null)]) {
    assert.doesNotMatch(label, /flat-4b-chores-e98ecd|Proposal|6269/);
  }
});

test('the Share item dialog opens on the app it came from, the viewer\'s own projects first', () => {
  const { orderAppChoices, filterAppChoices, APP_GROUPS, prefilledAppId } = loadTsx('frontend/src/features/messages/share-dialog.tsx');
  const apps = [
    { id: 1, slug: 'alpha', name: 'Alpha', mine: false },
    { id: 2, slug: 'flat-4b-chores-e98ecd', name: 'Flat 4B Chores', mine: true },
    { id: 3, slug: 'beta', name: 'Beta', mine: false },
    { id: 4, slug: 'gamma', name: 'Gamma', mine: true },
  ];
  const { mine, others } = orderAppChoices(apps);
  assert.deepEqual(mine.map((a) => a.id), [2, 4]);
  assert.deepEqual(others.map((a) => a.id), [1, 3], 'each group in the server\'s order');
  assert.equal(prefilledAppId(apps, { appId: 3 }), 3);
  assert.equal(prefilledAppId(apps, { appSlug: 'flat-4b-chores-e98ecd' }), 2, 'by its short name when no id came');
  assert.equal(prefilledAppId(apps, { appSlug: 'nowhere' }), null);
  assert.equal(prefilledAppId([], { appId: 9 }), 9, 'an id is kept while the list loads');
  assert.equal(prefilledAppId(apps, null), null);
  const dialog = read('frontend/src/features/messages/share-dialog.tsx');
  // #3937: the dropdown's two option groups are the list's filter chips now,
  // and the list itself still leads with the viewer's own projects.
  assert.deepEqual(filterAppChoices(apps).map((a) => a.id), [2, 4, 1, 3]);
  assert.deepEqual(APP_GROUPS.map((g) => message(g.label)), ['All', 'Your projects', 'Other projects']);
  assert.match(dialog, /setAppId\(prefilledAppId\(apps, reference\)\);/);
  assert.match(dialog, /setAppId\(prefilledAppId\(apps, \{ appSlug: wantedSlug \}\)\);/, 'chosen once the list it is in loads');
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /mine: row\.is_member === true \|\| row\.is_collaborator === true,/, 'a project they are in, from GET \/api\/apps');
});
