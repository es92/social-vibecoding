'use strict';

// Ask for changes attaches the change itself (first-session run-through,
// 5 October 2026).
//
// An invited flatmate pressed "Ask for changes" on a change Homeroom bot
// built and got a raw "Share item" form in their chat with the bot: the
// project not chosen (75 apps, theirs at position 53), the change's id typed
// in for them, and the chip it left on the composer read
// "flat-4b-chores-e98ecd · Proposa…". The change page knows the project and
// the change, so now (14 Nov 2026: there is no Main Chat to attach it in):
//
//   - app-view.js hands openBot the change with its project (id and slug)
//     and its pull request's number;
//   - openBot opens the private thread about a change it can name by that
//     number; any other complete item opens a new chat set to its project,
//     with the item attached in the new chat's box, the box asking "What
//     should change?" and the caret in it;
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
  const fn = view.slice(view.indexOf('  askBotForChanges(sessionId, title, number) {'), view.indexOf('  /** B8: whether Homeroom bot builds requests here'));
  assert.match(fn, /type: 'proposal', sessionId: Number\(sessionId\), title: title \|\| null,/);
  assert.match(fn, /appId: Number\(app\.id\) > 0 \? Number\(app\.id\) : undefined,/);
  assert.match(fn, /appSlug: app\.slug \|\| App\.currentApp \|\| undefined,/);
  assert.match(fn, /number: Number\(number\) > 0 \? Number\(number\) : undefined,/, 'its pull request\'s number, for the thread about it');
  assert.match(fn, /messages\.openBot\(reference\)/);
  // The change carries the name it has on every screen (AppView._changeTitle),
  // not its session's old one: the one model of a change's title order.
  assert.match(view, /act: \(\) => AppView\.askBotForChanges\(item\.id, AppView\._changeTitle\(item\), item\.pr_number\),/);
});

test('openBot opens the thread about a change it can name, and carries any other item into a new chat', async () => {
  const fakeApi = new Proxy({
    strictId: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null),
  }, { get: (t, k) => (k in t ? t[k] : () => { throw new Error(`api.${String(k)} not stubbed`); }) });
  const started = [];
  const went = [];
  let fails = false;
  const carry = loadTsx('frontend/src/features/messages/new-chat-carry.ts');
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: {
      './api': fakeApi,
      './new-chat-carry': carry,
      '../../lib/thread-about': {
        async startThreadAbout(slug, number, kind) {
          started.push([slug, number, kind]);
          if (fails) throw new Error('nope');
          return { rootId: 900, href: '#homeroom-bot/thread/900', holds: false };
        },
      },
      '../ai/door': { ...loadTsx('frontend/src/features/ai/door.ts'), goBotAddress: (href) => went.push(href) },
    },
  });
  assert.equal(message('messages:store.askForChangesPlaceholder'), 'What should change?');
  assert.equal(store.ASK_FOR_CHANGES_PLACEHOLDER, 'messages:store.askForChangesPlaceholder');

  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269, appSlug: 'flat-4b-chores-e98ecd' }), true);
  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269, appId: 12 }), true);
  assert.equal(store.stagedComplete({ type: 'proposal', sessionId: 6269 }), false, 'no project');
  assert.equal(store.stagedComplete({ type: 'proposal', appSlug: 'x' }), false, 'no change');
  assert.equal(store.stagedComplete({ type: 'issue', issueNumber: 4, appSlug: 'x' }), true);
  assert.equal(store.stagedComplete({ type: 'spec', sessionId: 4, appSlug: 'x' }), false, 'a spec needs its version');

  // A change named by its pull request's number: the private thread about it.
  const change = { type: 'proposal', sessionId: 6269, appId: 12, appSlug: 'flat-4b-chores-e98ecd', title: 'Show whose turn each chore is' };
  await store.openBot({ ...change, number: 31 });
  assert.deepEqual(started, [['flat-4b-chores-e98ecd', 31, 'change']]);
  assert.deepEqual(went, ['#homeroom-bot/thread/900']);
  assert.equal(carry.takeCarried(), null, 'nothing is carried into a thread that exists');

  // No number (or the thread could not be started): a new chat set to its
  // project, with the change attached in its box and the box asking.
  await store.openBot(change);
  assert.equal(started.length, 1, 'no number, no thread asked for');
  assert.equal(went[1], '#homeroom-bot/new?project=flat-4b-chores-e98ecd');
  assert.deepEqual(carry.takeCarried(), { object: change, placeholder: 'What should change?', words: null, start: null, send: false });
  assert.equal(carry.takeCarried(), null, 'once');
  fails = true;
  await store.openBot({ ...change, number: 31 });
  assert.equal(went[2], '#homeroom-bot/new?project=flat-4b-chores-e98ecd', 'a thread that could not be started falls back to the new chat');
  assert.deepEqual(carry.takeCarried(), { object: change, placeholder: 'What should change?', words: null, start: null, send: false }, 'its number is the door\'s, never the item\'s');

  // A group decision has no thread about it: the same new chat, carrying it.
  const decision = { type: 'governance', proposalId: 8, appSlug: 'flat-4b-chores-e98ecd', title: 'Close #4' };
  await store.openBot(decision);
  assert.equal(went[3], '#homeroom-bot/new?project=flat-4b-chores-e98ecd');
  assert.deepEqual(carry.takeCarried(), { object: decision, placeholder: 'What should change?', words: null, start: null, send: false });

  // A project alone: a new chat set to it, with nothing attached; nothing at all: a new chat.
  await store.openBot({ type: 'app', appSlug: 'plant-pal', title: 'Plant Pal' });
  assert.equal(went[4], '#homeroom-bot/new?project=plant-pal');
  assert.equal(carry.takeCarried(), null);
  await store.openBot({ type: 'proposal', sessionId: 6269 });
  assert.equal(went[5], '#homeroom-bot/new', 'an item that names no project carries nothing');
  assert.equal(carry.takeCarried(), null);
  await store.openBot();
  assert.equal(went[6], '#homeroom-bot/new');
  assert.equal(store.takePendingAttach, undefined, 'the bot chat\'s composer takes no attachment: there is none');
});

test('a carried item waits a moment for its new chat, and is taken once', () => {
  const carry = loadTsx('frontend/src/features/messages/new-chat-carry.ts');
  const item = { type: 'issue', appSlug: 'plant-pal', issueNumber: 4 };
  carry.carryToNewChat(item, 'What should change?', 1000);
  assert.deepEqual(carry.takeCarried(1000 + carry.CARRY_MS - 1), { object: item, placeholder: 'What should change?', words: null, start: null, send: false });
  assert.equal(carry.takeCarried(1000), null, 'once');
  carry.carryToNewChat(item, null, 1000);
  assert.equal(carry.takeCarried(1000 + carry.CARRY_MS), null, 'a door whose address opened no chat does not hand its item to a later one');
  carry.carryToNewChat(item, null, 1000);
  carry.carryToNewChat(null);
  assert.equal(carry.takeCarried(1000), null, 'taken back');
  // 24 Nov 2026: a project's Workshop box carries its words and the start it
  // chose (../frontend/src/features/dev-board/workshop/front-page.tsx), the
  // same way and for the same moment, and no item.
  carry.carryWordsToNewChat('Make the start button bigger', null, 1000);
  assert.deepEqual(carry.takeCarried(1000), { object: null, placeholder: null, words: 'Make the start button bigger', start: null, send: false });
  carry.carryWordsToNewChat('', 'fix', 1000);
  assert.deepEqual(carry.takeCarried(1000), { object: null, placeholder: null, words: null, start: 'fix', send: false }, 'a start alone');
  carry.carryWordsToNewChat('   ', null, 1000);
  assert.equal(carry.takeCarried(1000), null, 'blank words and no start carry nothing');
  carry.carryWordsToNewChat('x'.repeat(9000), 'live', 1000);
  assert.equal(carry.takeCarried(1000).words.length, 8000, 'no more than the box holds');
  carry.carryWordsToNewChat('Late', 'ask', 1000);
  assert.equal(carry.takeCarried(1000 + carry.CARRY_MS), null, 'and no later chat takes them');
});

test('the new chat takes the carried item: its chip, its prompt, the caret, and only the reference is sent', () => {
  const panel = read('frontend/src/features/messages/new-thread.tsx');
  assert.match(panel, /const held = takeCarried\(\);/);
  assert.match(panel, /preset = held\n\s+\? \{\n\s+project: fresh\?\.project \?\? null,\n\s+builder: fresh\?\.builder \|\| 'homeroom',\n\s+object: held\.object \|\| \(held\.words \|\| held\.start \? fresh\?\.object \|\| null : null\),\n\s+placeholder: held\.object \? held\.placeholder : \(fresh\?\.placeholder \?\? null\),\n\s+words: held\.words,\n\s+start: held\.start,\n\s+send: held\.send,\n\s+\}\n\s+: fresh \|\| null;/,
    'what a door carried is what the chat is about');
  // Words and a start (a project's Workshop box) go in the box as pressing that start would, ready to send.
  assert.match(panel, /const chosen = from\.start \? starts\.find\(\(start\) => start\.key === from\.start\) \|\| null : null;\n\s+const said = String\(from\.words \|\| ''\);\n\s+setWords\(\(chosen \? withStart\(said, chosen, starts\) : said\)\.slice\(0, 8000\)\);/);
  assert.match(panel, /useEffect\(\(\) => \{ if \(takeWords\(preset\)\) toField\(\); \}, \[\]\);/, 'once the starts are read, with the caret after them');
  assert.match(panel, /const \[object, setObject\] = useState<StagedObject \| null>\(\(\) => preset\?\.object \|\| null\);/);
  assert.match(panel, /<div className="messages-pending-object" data-bot-new-thread-object=\{object\.type\}>/);
  assert.match(panel, /\{pendingObjectLabel\(object, stagedCard\)\}/, 'the chip reads what a sent card reads');
  assert.match(panel, /<button type="button" onClick=\{\(\) => \{ setObject\(null\); setPrompt\(null\); \}\} aria-label=\{t\('messages:composer\.removeSharedItem'\)\}>×<\/button>/);
  assert.match(panel, /placeholder=\{own \? t\('messages:newThread\.builder\.placeholder'\) : \(object && prompt\) \|\| t\('messages:newThread\.placeholder'\)\}/);
  assert.match(panel, /\.\.\.\(object \? \{ object: referenceOf\(object\) \} : \{\}\),/, 'the staged title is never sent');
  assert.match(panel, /if \(takeWords\(preset\) \|\| preset\.object\) toField\(\);/, 'the caret is in the box');
  // The conversation composer keeps its own chip, for an item shared in a chat with people.
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.equal(message('messages:composer.placeholderThread'), 'Reply in thread…');
  assert.equal(message('messages:composer.placeholder'), 'Message…');
  assert.match(composer, /const threadPlaceholder = !botRequest \? t\('messages:composer\.placeholderThread'\)/);
  assert.match(composer, /\{pendingObjectLabel\(object, stagedCard\)\}/);
  assert.match(composer, /object: object \? referenceOf\(object\) : undefined/, 'the staged title is never sent');
  assert.match(composer, /api\.resolveLinkCards\(\[\{ type, appSlug, issueNumber, sessionId, proposalId \}\]\)/,
    'the chip reads what a sent card reads');
  assert.doesNotMatch(composer, /function objectLabel/, 'the slug-and-id label is gone');
  assert.doesNotMatch(composer, /takePendingAttach|usernode:messages-attach/, 'the one-shot that attached a change in Main Chat\'s box is gone');
  assert.doesNotMatch(read('frontend/src/features/messages/store.ts'), /usernode:messages-attach|pendingAttach/);
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
