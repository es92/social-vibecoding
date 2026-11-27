'use strict';

// Saved drafts in the chat with Homeroom bot: the list the agent chats had,
// for the person's own chat with the bot and its threads
// (frontend/src/features/messages/bot-drafts.ts, bot-drafts-list.tsx,
// composer.tsx).
//
//   1. The message box's rule: while the bot works there and words are
//      typed, Send's place is "Save draft" beside Stop, in the bot's chat
//      only. (Its whole table, with Stop's, is tests/messages-bot-stop.test.js.)
//   2. The box saves instead of sending then, from the button and from the
//      keyboard, and never presses Stop from a key. A draft is words only:
//      the files, the quoted reply and the attached item stay staged.
//   3. The list: its heading with the count and "on all your devices", a row
//      per draft with send, edit and delete, sending locked while the bot
//      works. Nothing with no drafts, and nothing on a first render.
//   4. The store: the server's list is the truth (no copy on the device),
//      the screen updates first, a full list refuses and evicts nothing,
//      what was typed is kept as another draft when a draft takes the box,
//      and writes to one list go in order.
//   5. Sending a draft is always a tap, never automatic.
//   6. The requests, and the event from the person's other devices.
//   7. The words, with the bot's name, as whole catalog entries.
//
// The server's part is tests/messages-bot-drafts-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const DRAFTS = read('frontend/src/features/messages/bot-drafts.ts');
const LIST = read('frontend/src/features/messages/bot-drafts-list.tsx');
const STORE = read('frontend/src/features/messages/store.ts');

const rule = loadTsx('frontend/src/features/messages/bot-stop.ts');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 1. The rule ──────────────────────────────────────────────────────────

test('the box\'s state: not working, working and empty, working with words, stopping; the bot\'s chat and any other', () => {
  const A = 71;
  const state = (botChat, answering, text, stopping = null) => {
    const words = !!text.trim();
    const input = { botChat, answering, words, empty: !words, stopping };
    return [rule.sendMode(input), rule.stopMode(input)];
  };
  // The chat with Homeroom bot.
  assert.deepEqual(state(true, null, ''), ['send', 'stop'], 'not working: Send (disabled by the box, nothing to send)');
  assert.deepEqual(state(true, null, 'make it blue'), ['send', 'stop'], 'not working, words: Send, as today');
  assert.deepEqual(state(true, A, ''), ['stop', 'stop'], 'working, empty: Stop alone');
  assert.deepEqual(state(true, A, '   '), ['stop', 'stop'], 'spaces are not words');
  assert.deepEqual(state(true, A, 'make it blue'), ['save', 'stop'], 'working, words: Save draft, beside a Stop that can be pressed');
  assert.deepEqual(state(true, A, '', A), ['stopping', 'stopping'], 'a Stop on its way, empty: Stopping');
  assert.deepEqual(state(true, A, 'make it blue', A), ['save', 'stopping'], 'a Stop on its way, words: still Save draft, beside "Stopping"');
  assert.deepEqual(state(true, null, 'make it blue', A), ['send', 'stop'], 'the answer ended: Send again');
  // Any other chat: a person, a group, a channel. Always Send, whoever is
  // typing there and whatever their event says.
  for (const answering of [null, A]) for (const text of ['', 'hello']) for (const stopping of [null, A]) {
    assert.equal(state(false, answering, text, stopping)[0], 'send', JSON.stringify({ answering, text, stopping }));
  }
});

// ── 2. The box ───────────────────────────────────────────────────────────

test('with words while the bot works, Send\'s place is Stop and a worded "Save draft"', () => {
  // One button in Send's place when it is Send; otherwise Stop, and beside
  // it the pill when there are words.
  const place = COMPOSER.slice(COMPOSER.indexOf("{sendKind === 'send' ? ("), COMPOSER.indexOf('{error ? <p role="alert"'));
  assert.match(place, /\{sendKind === 'send' \? \(\n\s+<button [^\n]*onClick=\{submit\}[^\n]*className="messages-send"[^\n]*\n\s+\) : \(\n\s+<button [^\n]*onClick=\{stopBot\}[^\n]*className="messages-send messages-send-stop"[^\n]*\n\s+\)\}\n\s+\{sendKind === 'save' \? \(\n\s+<Button\n/);
  const pill = place.slice(place.indexOf('<Button'));
  assert.match(pill, /type="button"\n\s+data-bot-save-draft=""\n\s+disabled=\{dictating \|\| !!uploading\}\n\s+onMouseDown=\{\(event\) => event\.preventDefault\(\)\}\n\s+onClick=\{submit\}/,
    'held by what holds Send, and the press keeps the field focused');
  // A green pill with the save glyph and the words. On a phone the row is
  // this box's 36px line, so the pill is that height with a little less
  // padding, and 40px from 768px.
  const ours = /className="(inline-flex h-9 shrink-0 [^"]*)"\n\s+aria-label=\{t\('messages:composer\.saveAsDraft'\)\}/.exec(pill)[1];
  assert.equal(ours, 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3 text-sm font-semibold hover:bg-emerald-700 md:h-10 md:px-3.5');
  assert.match(pill, /variant="unstyled"\n\s+ink="solid"/);
  assert.match(pill, /title=\{enterKey \? t\('messages:composer\.saveTitleShortcut'\) : t\('messages:composer\.saveTitle'\)\}/);
  assert.match(pill, /<SaveDraftIcon width=\{18\} height=\{18\} className="hidden md:block" aria-hidden="true" \/>\n\s+<span>\{t\('messages:composer\.saveDraft'\)\}<\/span>/,
    'words, not a round button in Send\'s place');
  // Said in words above what is typed, the moment it applies.
  assert.match(COMPOSER, /\{sendKind === 'save' \? \(\n\s+<p className="px-2 pb-1 text-\[13px\] text-zinc-600 dark:text-zinc-300" data-bot-save-note="">\n\s+<RichMessage id="messages:composer\.saveNote" components=\{\[<span className="font-semibold" \/>\]\} \/>/);
});

test('Enter and Cmd/Ctrl + Enter save in that state, and no key presses Stop', () => {
  // One key handler: lib/enter-sends.ts decides the key is a send (Enter
  // where there is a keyboard, Cmd/Ctrl + Enter anywhere), and submit
  // decides what a send is right now.
  const field = /<textarea ref=\{inputRef\}[^\n]*/.exec(COMPOSER)[0];
  assert.match(field, /if \(enterSends\(event\.nativeEvent\)\) \{ event\.preventDefault\(\); submit\(\); \}/);
  assert.equal((field.match(/saveTyped|stopBot|sendSavedDraft/g) || []).length, 0);
  const submit = COMPOSER.slice(COMPOSER.indexOf('function submit() {'), COMPOSER.indexOf('\n  }\n', COMPOSER.indexOf('function submit() {')));
  assert.match(submit, /^function submit\(\) \{\n\s+if \(dictating \|\| uploading \|\| \(!value\.trim\(\) && !attachments\.length && !object\)\) return;\n[^\n]*\n[^\n]*\n\s+if \(sendKind === 'save'\) \{ saveTyped\(\); return; \}\n/,
    'an empty box does nothing; words while the bot works are saved, before anything is sent');
  // One message box (27 Nov 2026): the box sends through its place, which
  // for a conversation is the store's send in this place (MessageComposer).
  assert.ok(submit.indexOf("if (sendKind === 'save')") < submit.indexOf('place.send(input)'));
  assert.match(COMPOSER, /send: \(input\) => send\(\{ \.\.\.input, threadRootId \}\),/);
  assert.doesNotMatch(submit, /stopBot/);
  // The keys the rule reads, with the box in the save state.
  const { enterSends } = loadTsx('frontend/src/lib/enter-sends.ts');
  assert.equal(enterSends({ key: 'Enter' }, false), true, 'Enter, where there is a keyboard');
  assert.equal(enterSends({ key: 'Enter', metaKey: true }, true), true, 'Cmd + Enter, anywhere');
  assert.equal(enterSends({ key: 'Enter', ctrlKey: true }, true), true, 'Ctrl + Enter, anywhere');
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, false), false, 'Shift + Enter is a new line');
  assert.equal(enterSends({ key: 'Enter' }, true), false, 'on a touch screen Enter is a new line: the button saves');
});

test('saving takes the words and nothing else: files, a quoted reply and an attached item stay staged', () => {
  const save = COMPOSER.slice(COMPOSER.indexOf('function saveTyped() {'), COMPOSER.indexOf('function sendSavedDraft('));
  assert.match(save, /const saved = saveBotDraft\(conversationId, threadRootId, value, \(text\) => \{/);
  // Refused (nothing typed, a full list): the words stay in the box.
  // The typing line is the place's (one message box, 27 Nov 2026).
  assert.match(save, /if \(!saved\) return;\n\s+setError\(''\); place\.typing\?\.\(false\);\n\s+setValue\(''\); setDraft\(scope, ''\);/);
  // Only the words are cleared.
  for (const staged of ['setAttachments', 'setDraftAttachments', 'updateAttachments', 'setObject', 'setChip', 'setReply', 'objectRef', 'setPrompt']) {
    assert.ok(!save.includes(staged), `${staged} is not touched by a save`);
  }
  assert.doesNotMatch(save, /\bsend\(/, 'and nothing is sent');
  // A save the server then refuses hands the words back: ahead of anything
  // typed since, or to the draft of the place they were typed in.
  assert.match(save, /if \(scopeRef\.current === startScope\) \{\n\s+const now = inputRef\.current\?\.value \|\| '';\n\s+const back = \(now\.trim\(\) \? `\$\{text\}\\n\\n\$\{now\}` : text\)\.slice\(0, 8000\);\n\s+setValue\(back\); setDraft\(startScope, back\);\n\s+\} else if \(!draftFor\(startScope\)\) \{\n\s+setDraft\(startScope, text\);/);
});

// ── 3. The list ──────────────────────────────────────────────────────────

const { BotSavedDrafts } = loadTsx('frontend/src/features/messages/bot-drafts-list.tsx');
const TWO = [{ id: 'd1', text: 'and make the header green', savedAt: null }, { id: 'd2', text: 'then <b>the footer</b>', savedAt: null }];
const listHtml = (props) => renderToHtml(createElement(BotSavedDrafts, { drafts: TWO, busy: false, onSend() {}, onEdit() {}, onDelete() {}, ...props }));

test('the list: a small heading with the count and "on all your devices", and a row per draft, oldest first', () => {
  const html = listHtml();
  assert.match(html, /^<section aria-label="Saved drafts" class="[^"]*" data-bot-drafts="2">/);
  // The heading is a line of text in the list, not a heading of the page.
  assert.doesNotMatch(html, /<h[1-6]|role="heading"/);
  assert.match(html, /<p class="[^"]*text-\[11px\][^"]*"><span class="font-semibold uppercase tracking-wide">Saved drafts \(2\)<\/span><span>· on all your devices<\/span>/);
  const rows = [...html.matchAll(/<li class="[^"]*" data-bot-draft="([^"]+)"><span dir="auto" class="[^"]*truncate[^"]*" title="([^"]*)">([^<]*(?:&[a-z]+;[^<]*)*)<\/span>/g)].map((m) => [m[1], m[3]]);
  assert.deepEqual(rows, [['d1', 'and make the header green'], ['d2', 'then &lt;b&gt;the footer&lt;/b&gt;']], 'as given, and as text');
  // Every control is named, and each row has the three.
  const names = [...html.matchAll(/<button type="button" class="[^"]*" aria-label="([^"]+)" title="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(names, [
    ['Send this draft', 'Send this draft now'], ['Edit this draft', 'Put this draft back in the box to edit'], ['Delete this draft', 'Delete this draft'],
    ['Send this draft', 'Send this draft now'], ['Edit this draft', 'Put this draft back in the box to edit'], ['Delete this draft', 'Delete this draft'],
  ]);
  assert.equal((html.match(/<svg[^>]*aria-hidden="true"/g) || []).length, 6, 'the glyphs are decoration');
  assert.match(html, /data-bot-drafts-ready="">Ready to send<\/span>/);
  assert.doesNotMatch(html, /disabled=""/);
  // One draft is counted as one.
  assert.match(listHtml({ drafts: TWO.slice(0, 1) }), /Saved drafts \(1\)/);
});

test('while the bot works there, sending is locked and says when it unlocks; editing and deleting are not', () => {
  const html = listHtml({ busy: true });
  assert.match(html, /data-bot-drafts-locked="">sending unlocks when Homeroom bot finishes<\/span>/);
  assert.doesNotMatch(html, /Ready to send/);
  const buttons = [...html.matchAll(/<button type="button" class="[^"]*" aria-label="([^"]+)" title="([^"]+)"( disabled="")?/g)].map((m) => [m[1], m[2], !!m[3]]);
  assert.deepEqual(buttons.slice(0, 3), [
    ['Send this draft', 'Homeroom bot is still working. You can send this when it finishes', true],
    ['Edit this draft', 'Put this draft back in the box to edit', false],
    ['Delete this draft', 'Delete this draft', false],
  ]);
  // A file on its way up or dictation running holds a send, as it holds Send.
  const held = [...listHtml({ held: true }).matchAll(/aria-label="Send this draft" title="Send this draft now"( disabled="")?/g)].map((m) => !!m[1]);
  assert.deepEqual(held, [true, true]);
  // The composer says so from what Stop reads: the bot answering in this place.
  assert.match(COMPOSER, /\{botChat \? <BotSavedDrafts drafts=\{savedDrafts\} busy=\{!!answering\} held=\{dictating \|\| !!uploading\} onSend=\{sendSavedDraft\} onEdit=\{editSavedDraft\} onDelete=\{\(draft\) => deleteBotDraft\(conversationId, threadRootId, draft\.id\)\} \/> : null\}/);
});

test('the list draws its boxes in Tailwind, in the platform\'s palette', () => {
  // The boxes: the list, its heading line, a row, a row's button.
  const boxes = [
    'mb-2 max-h-40 overflow-y-auto rounded-2xl bg-zinc-100 p-1.5 dark:bg-zinc-800/70',
    'flex flex-wrap items-baseline gap-x-1.5 px-2 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400',
    'flex items-center gap-0.5 rounded-xl bg-white py-0.5 ps-3 pe-0.5 dark:bg-zinc-900',
    'min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200',
    "'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors '",
    "'hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent '",
    'DraftSendIcon width={16} height={16}', 'DraftEditIcon width={16} height={16}', 'DraftTrashIcon width={16} height={16}',
  ];
  for (const box of boxes) {
    assert.ok(LIST.includes(box), `the list draws ${box}`);
  }
  // Tailwind only: no class of the dev chat's list, and nothing new in app.css.
  assert.doesNotMatch(LIST, /dc-drafts/);
  assert.doesNotMatch(read('public/css/app.css'), /bot-drafts|bot-draft-|bot-save/);
});

test('nothing with no drafts, nothing on a first render, and never outside the chat with Homeroom bot', () => {
  assert.equal(listHtml({ drafts: [] }), '', 'no list, so the box does not move for one');
  // The composer's first render: the store starts with nobody typing and no
  // list read (both arrive in effects), so the prerender and the hydration
  // draw the box as it always was.
  const composerHtml = ({ homeroomBot = true, typing = [], drafts = TWO } = {}) => {
    const snap = {
      route: { conversationId: 42 },
      active: { id: 42, kind: 'direct', title: 'Homeroom bot', membershipStatus: 'member', myRole: 'member', members: [], memberCount: 2, canSend: true, awaitingAcceptance: false, homeroomBot },
      messages: [], conversations: [], discussions: [],
    };
    const asked = [];
    const store = {
      channels: () => [], draftFor: () => '', draftAttachmentsFor: () => [], notifyTyping() {}, replyFor: () => null,
      scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setDraftAttachments() {}, setReply() {},
      takePendingShare: () => undefined, useMessagesSnapshot: () => snap, typingUsers: () => typing,
    };
    const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', {
      stubs: {
        './store': store,
        './api': { listBotDrafts: async (...args) => { asked.push(args); return drafts; }, strictId: () => null },
        '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
        '../../lib/use-auto-grow': { useAutoGrow() {} },
      },
    });
    return { html: renderToHtml(createElement(MessageComposer, {})), asked };
  };
  const working = [{ name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'writing' }, answering: 71 }];
  for (const options of [{}, { typing: working }, { homeroomBot: false }, { homeroomBot: false, typing: working }]) {
    const { html, asked } = composerHtml(options);
    assert.doesNotMatch(html, /data-bot-drafts|data-bot-draft|data-bot-save-draft|data-bot-save-note|Saved drafts|Save draft/, JSON.stringify(options));
    assert.deepEqual(asked, [], 'and nothing is read while rendering');
  }
  // The list is read in an effect, for the bot's chat on the route only.
  assert.match(COMPOSER, /const botChat = active\?\.homeroomBot === true && active\.id === conversationId;/);
  assert.match(COMPOSER, /const savedDrafts = useBotDrafts\(conversationId, threadRootId, botChat\);/);
  assert.match(DRAFTS, /const key = enabled && conversationId \? placeKey\(conversationId, threadRootId\) : '';\n\s+useEffect\(\(\) => \(key \? watchBotDrafts\(conversationId, threadRootId\) : undefined\), \[key, conversationId, threadRootId\]\);\n\s+return useSyncExternalStore\(subscribe, \(\) => \(key \? lists\.get\(key\) \|\| NONE : NONE\), \(\) => NONE\);/,
    'the server render and the hydration have no drafts');
});

// ── 4. The store ─────────────────────────────────────────────────────────

// The module over a stand-in server: one list per place, a cap of twenty,
// each request answered when the test says so.
function draftsStore({ lists = {}, hold = false } = {}) {
  const server = new Map(Object.entries(lists).map(([key, value]) => [key, [...value]]));
  const requests = [];
  const toasts = [];
  const held = [];
  let failing = null;
  const keyOf = (conversationId, rootId) => `${conversationId}:${rootId || 0}`;
  class MessagesApiError extends Error {
    constructor(status, text, code = null) { super(text); this.status = status; this.code = code; }
  }
  const answer = (name, conversationId, rootId, run) => new Promise((resolve, reject) => {
    const go = () => {
      requests.push([name, conversationId, rootId]);
      if (failing && failing.name === name) { const error = failing.error; failing = null; reject(error); return; }
      resolve(run());
    };
    if (hold) held.push(go); else go();
  });
  const api = {
    MessagesApiError,
    strictId: (value) => (/^[1-9]\d*$/.test(String(value ?? '')) ? Number(value) : null),
    listBotDrafts: (conversationId, rootId) => answer('list', conversationId, rootId, () => [...(server.get(keyOf(conversationId, rootId)) || [])]),
    saveBotDraft: (conversationId, rootId, draft) => answer('save', conversationId, rootId, () => {
      const key = keyOf(conversationId, rootId);
      const now = server.get(key) || [];
      if (!now.some((d) => d.id === draft.id)) {
        if (now.length >= 20) throw new MessagesApiError(409, 'That\'s 20 saved drafts. Send or delete one first', 'draft_cap');
        server.set(key, [...now, draft]);
      }
      return [...server.get(key)];
    }),
    deleteBotDraft: (conversationId, rootId, draftId) => answer('delete', conversationId, rootId, () => {
      const key = keyOf(conversationId, rootId);
      server.set(key, (server.get(key) || []).filter((d) => d.id !== draftId));
      return [...server.get(key)];
    }),
  };
  const mod = loadTsx('frontend/src/features/messages/bot-drafts.ts', {
    stubs: { './api': api, '../message-actions/clipboard': { toast: (text) => toasts.push(text) } },
  });
  return {
    mod, server, requests, toasts, held,
    fail: (name, error = new Error('offline')) => { failing = { name, error }; },
    texts: (conversationId = 42, rootId = null) => mod.botDraftsFor(conversationId, rootId).map((d) => d.text),
    MessagesApiError,
  };
}
const many = (count) => Array.from({ length: count }, (_, n) => ({ id: `s${n + 1}`, text: `draft ${n + 1}`, savedAt: null }));

test('Save shows the draft at once, keeps it on the server, and a full list refuses without evicting', async () => {
  const s = draftsStore({ lists: { '42:0': many(1) } });
  const stop = s.mod.watchBotDrafts(42, null);
  await settle();
  assert.deepEqual(s.texts(), ['draft 1'], 'the place\'s list, read from the server');

  assert.equal(s.mod.saveBotDraft(42, null, '   '), false, 'nothing typed, nothing saved');
  assert.equal(s.mod.saveBotDraft(0, null, 'no chat'), false);
  assert.deepEqual(s.toasts, []);
  assert.equal(s.mod.saveBotDraft(42, null, '  and make it blue  '), true);
  assert.deepEqual(s.texts(), ['draft 1', 'and make it blue'], 'shown at once, trimmed, newest last');
  assert.deepEqual(s.toasts, [message('messages:drafts.saved')]);
  await settle();
  assert.deepEqual(s.server.get('42:0').map((d) => d.text), ['draft 1', 'and make it blue']);
  assert.match(s.server.get('42:0')[1].id, /^d[0-9a-z]+$/, 'an id the server takes as an opaque token');
  assert.ok(Date.parse(s.server.get('42:0')[1].savedAt) > 0);

  // A thread's list is its own.
  assert.equal(s.mod.saveBotDraft(42, 9, 'in the thread'), true);
  await settle();
  assert.deepEqual(s.texts(42, 9), ['in the thread']);
  assert.deepEqual(s.texts(), ['draft 1', 'and make it blue']);

  // Twenty: refused in words, the box keeps its text, and nothing leaves.
  const full = draftsStore({ lists: { '42:0': many(20) } });
  full.mod.watchBotDrafts(42, null);
  await settle();
  assert.equal(full.mod.saveBotDraft(42, null, 'one too many'), false);
  assert.deepEqual(full.toasts, ['That’s 20 saved drafts. Send or delete one first']);
  assert.equal(full.toasts[0], message('messages:drafts.full', { count: 20 }));
  assert.deepEqual(full.texts(), many(20).map((d) => d.text), 'never an eviction');
  assert.ok(!full.requests.some(([name]) => name === 'save'), 'and the server is not asked');
  assert.equal(full.mod.MAX_SAVED_DRAFTS, 20);
  stop();
});

test('a save the server refuses hands the words back, and says why', async () => {
  const s = draftsStore({ lists: { '42:0': many(2) } });
  s.mod.watchBotDrafts(42, null);
  await settle();
  // The server could not be reached.
  let back = null;
  s.fail('save');
  assert.equal(s.mod.saveBotDraft(42, null, 'lost on the way', (text) => { back = text; }), true);
  assert.deepEqual(s.texts(), ['draft 1', 'draft 2', 'lost on the way']);
  await settle(); await settle();
  assert.equal(back, 'lost on the way', 'the box takes the words back');
  assert.deepEqual(s.texts(), ['draft 1', 'draft 2'], 'and the list is the server\'s again');
  assert.deepEqual(s.toasts, [message('messages:drafts.saved'), message('messages:drafts.saveFailed')]);
  // Another device filled the list first: the cap, in the same words.
  s.toasts.length = 0; back = null;
  s.fail('save', new s.MessagesApiError(409, 'That\'s 20 saved drafts. Send or delete one first', 'draft_cap'));
  assert.equal(s.mod.saveBotDraft(42, null, 'too late', (text) => { back = text; }), true);
  await settle(); await settle();
  assert.equal(back, 'too late');
  assert.deepEqual(s.toasts, [message('messages:drafts.saved'), message('messages:drafts.full', { count: 20 })]);
});

test('a draft takes the box: what was typed is kept as another draft first, and the two writes go in order', async () => {
  const s = draftsStore({ lists: { '42:0': many(3) }, hold: true });
  s.mod.watchBotDrafts(42, null);
  s.held.shift()();
  await settle();
  assert.deepEqual(s.texts(), ['draft 1', 'draft 2', 'draft 3']);

  // Sent or edited with words in the box (takeBotDraft is both).
  assert.equal(s.mod.takeBotDraft(42, null, 's2', '  half a thought  '), 'draft 2');
  assert.deepEqual(s.texts(), ['draft 1', 'draft 3', 'half a thought'], 'both shown at once');
  assert.deepEqual(s.toasts, [message('messages:drafts.keptTyped')]);
  // The delete is asked first; the save waits for its answer.
  await settle();
  assert.equal(s.held.length, 1);
  s.held.shift()();
  await settle();
  assert.deepEqual(s.requests.map(([name]) => name), ['list', 'delete']);
  assert.deepEqual(s.texts(), ['draft 1', 'draft 3', 'half a thought'], 'the delete\'s answer is not drawn over the draft still on its way');
  assert.equal(s.held.length, 1);
  s.held.shift()();
  await settle();
  assert.deepEqual(s.requests.map(([name]) => name), ['list', 'delete', 'save']);
  assert.deepEqual(s.texts(), ['draft 1', 'draft 3', 'half a thought']);
  assert.deepEqual(s.server.get('42:0').map((d) => d.text), ['draft 1', 'draft 3', 'half a thought']);

  // The same words as the draft, or nothing typed: nothing more is kept.
  s.toasts.length = 0;
  assert.equal(s.mod.takeBotDraft(42, null, 's1', 'draft 1'), 'draft 1');
  assert.equal(s.mod.takeBotDraft(42, null, 's3', ''), 'draft 3');
  await settle();
  while (s.held.length) { s.held.shift()(); await settle(); }
  assert.deepEqual(s.texts(), ['half a thought']);
  assert.deepEqual(s.toasts, []);
  // A draft that is no longer there (sent on another device) is not taken.
  assert.equal(s.mod.takeBotDraft(42, null, 's1', 'typed'), null);
  await settle();
  assert.equal(s.held.length, 0, 'and nothing typed is parked for it');

  // A list at the cap still has room for the typed words: the draft leaving makes it.
  const full = draftsStore({ lists: { '42:0': many(20) } });
  full.mod.watchBotDrafts(42, null);
  await settle();
  assert.equal(full.mod.takeBotDraft(42, null, 's5', 'typed meanwhile'), 'draft 5');
  await settle(); await settle();
  assert.equal(full.server.get('42:0').length, 20);
  assert.equal(full.server.get('42:0').at(-1).text, 'typed meanwhile');
});

test('Delete removes the draft and says so; a delete that fails puts the server\'s list back', async () => {
  const s = draftsStore({ lists: { '42:0': many(2) } });
  s.mod.watchBotDrafts(42, null);
  await settle();
  s.mod.deleteBotDraft(42, null, 's1');
  assert.deepEqual(s.texts(), ['draft 2'], 'gone at once');
  assert.deepEqual(s.toasts, [message('messages:drafts.deleted')]);
  await settle();
  assert.deepEqual(s.server.get('42:0').map((d) => d.id), ['s2']);
  s.mod.deleteBotDraft(42, null, 'never-there');
  assert.equal(s.toasts.length, 1, 'nothing to delete, nothing said');
  s.fail('delete');
  s.mod.deleteBotDraft(42, null, 's2');
  await settle(); await settle();
  assert.deepEqual(s.texts(), ['draft 2'], 'still on the server, so back on screen');
  assert.equal(s.toasts.at(-1), message('messages:drafts.deleteFailed'));
});

test('the server is the truth: nothing is kept on the device, and another device\'s change is read again', async () => {
  assert.doesNotMatch(DRAFTS, /localStorage|sessionStorage|indexedDB/, 'no copy on the device');
  const s = draftsStore({ lists: { '42:0': many(1), '42:9': many(2) } });
  const stop = s.mod.watchBotDrafts(42, null);
  await settle();
  const reads = () => s.requests.filter(([name]) => name === 'list').map(([, c, r]) => `${c}:${r || 0}`);
  assert.deepEqual(reads(), ['42:0']);
  // Saved on a phone: the event names the conversation and the place.
  s.server.set('42:0', [...many(1), { id: 'p1', text: 'from my phone', savedAt: null }]);
  s.mod.botDraftsChanged({ type: 'conversation_drafts_changed', conversationId: 42 });
  await settle();
  assert.deepEqual(s.texts(), ['draft 1', 'from my phone']);
  // A place no box is drawn for is not read: its list is read when it opens.
  s.mod.botDraftsChanged({ conversationId: 42, threadRootId: 9 });
  s.mod.botDraftsChanged({ conversationId: 77 });
  s.mod.botDraftsChanged({ conversationId: 'all' });
  s.mod.botDraftsChanged(null);
  await settle();
  assert.deepEqual(reads(), ['42:0', '42:0']);
  // The connection came back: every list on screen is read again.
  const stopThread = s.mod.watchBotDrafts(42, 9);
  await settle();
  s.mod.resyncBotDrafts();
  await settle();
  assert.deepEqual(reads(), ['42:0', '42:0', '42:9', '42:0', '42:9']);
  // The box went away: its place is no longer read.
  stop(); stopThread();
  s.mod.botDraftsChanged({ conversationId: 42 });
  s.mod.resyncBotDrafts();
  await settle();
  assert.equal(reads().length, 5);
  // A read that fails leaves the list as it was.
  const again = s.mod.watchBotDrafts(42, null);
  await settle();
  s.fail('list');
  s.mod.botDraftsChanged({ conversationId: 42 });
  await settle();
  assert.deepEqual(s.texts(), ['draft 1', 'from my phone']);
  again();

  // The socket's event reaches the module through the conversation store,
  // and the shell's socket hands it to that store.
  assert.match(STORE, /case 'conversation_drafts_changed':\n(?:\s+\/\/[^\n]*\n)+\s+botDraftsChanged\(event\);\n\s+break;/);
  assert.match(STORE, /export async function resync\(\): Promise<void> \{\n[^}]*resyncBotDrafts\(\);/);
  assert.match(read('public/js/app.js'), /case 'conversation_typing':\n(?:\s+\/\/[^\n]*\n)+\s+case 'conversation_drafts_changed':\n[\s\S]{0,300}?window\.UsernodeReact\?\.messages\?\.handleEvent\?\.\(data\);/);
});

// ── 5. Sending is always a tap ───────────────────────────────────────────

test('a draft is sent by a tap on its row, as a normal message there, and never on its own', () => {
  const send = COMPOSER.slice(COMPOSER.indexOf('function sendSavedDraft('), COMPOSER.indexOf('function editSavedDraft('));
  // Not while the bot works here, a file is on its way up or dictation runs.
  assert.match(send, /^function sendSavedDraft\(draft: SavedDraft\) \{\n\s+if \(answering \|\| dictating \|\| uploading\) return;\n\s+const text = takeBotDraft\(conversationId, threadRootId, draft\.id, value\);\n\s+if \(text == null\) return;/,
    'what was typed is kept as another draft first, and the draft leaves every device');
  // The store's own send, in this place: the words, with what is staged in
  // the box (files, the attached item; the quoted reply is the store's).
  // Through the place, whose send is the store's in this place (one message
  // box, 27 Nov 2026).
  assert.match(send, /const input = \{ content: text, attachmentIds: attachments\.map\(\(item\) => item\.id\), attachments, object: object \? referenceOf\(object\) : undefined \};\n\s+setValue\(''\); setAttachments\(\[\]\); setObject\(null\);\n\s+Promise\.resolve\(place\.send\(input\)\)/);
  // Its one caller is the row's button; the store never sends.
  assert.equal((COMPOSER.match(/sendSavedDraft\b/g) || []).length, 2, 'declared, and handed to the list');
  assert.match(LIST, /disabled=\{busy \|\| held\}\n\s+data-bot-draft-send=""\n\s+onMouseDown=\{\(event\) => event\.preventDefault\(\)\}\n\s+onClick=\{\(\) => onSend\(draft\)\}/);
  assert.doesNotMatch(DRAFTS, /\bsend\(|sendMessage|from '\.\/store'/, 'the drafts module cannot send, and knows nothing of the conversation store');
  // Nothing sends a draft when the bot finishes: no effect anywhere reads
  // the list to send from it.
  assert.doesNotMatch(COMPOSER, /useEffect\([^)]*\{[^}]*sendSavedDraft/);
  // Edit puts the words in the box with the caret at their end.
  const edit = COMPOSER.slice(COMPOSER.indexOf('function editSavedDraft('), COMPOSER.indexOf('const boxShown ='));
  assert.match(edit, /const text = takeBotDraft\(conversationId, threadRootId, draft\.id, value\);\n\s+if \(text == null\) return;\n\s+setValue\(text\); setDraft\(scope, text\);/);
  assert.match(edit, /emojiCaret\.current = text\.length;\n\s+inputRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
});

// ── 6. The requests ──────────────────────────────────────────────────────

test('the requests: the place\'s list read fresh, a save with its id, a delete by id', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, cache: init.cache });
    return new Response(JSON.stringify({ ok: true, max: 20, drafts: [{ id: 'd1', text: 'kept', savedAt: '2026-11-14T10:00:00.000Z' }, { id: '', text: 'no id' }, { id: 'd2' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const api = loadTsx('frontend/src/features/messages/api.ts');
    const kept = [{ id: 'd1', text: 'kept', savedAt: '2026-11-14T10:00:00.000Z' }];
    assert.deepEqual(await api.listBotDrafts(42), kept, 'a row without an id or words is not a draft');
    assert.deepEqual(await api.listBotDrafts(42, 9), kept);
    assert.deepEqual(await api.saveBotDraft(42, null, { id: 'd1', text: 'kept', savedAt: null }), kept);
    assert.deepEqual(await api.saveBotDraft(42, 9, { id: 'd3', text: 'in a thread', savedAt: null }), kept);
    assert.deepEqual(await api.deleteBotDraft(42, null, 'd1'), kept);
    assert.deepEqual(await api.deleteBotDraft(42, 9, 'd 1'), kept);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    { url: '/api/conversations/42/bot-drafts', method: 'GET', body: null, cache: 'no-store' },
    { url: '/api/conversations/42/bot-drafts?threadRootId=9', method: 'GET', body: null, cache: 'no-store' },
    { url: '/api/conversations/42/bot-drafts', method: 'POST', body: { id: 'd1', text: 'kept', savedAt: null }, cache: undefined },
    { url: '/api/conversations/42/bot-drafts', method: 'POST', body: { id: 'd3', text: 'in a thread', savedAt: null, threadRootId: 9 }, cache: undefined },
    { url: '/api/conversations/42/bot-drafts/d1', method: 'DELETE', body: null, cache: undefined },
    { url: '/api/conversations/42/bot-drafts/d%201?threadRootId=9', method: 'DELETE', body: null, cache: undefined },
  ]);
});

// ── 7. The words ─────────────────────────────────────────────────────────

test('the words, with the bot\'s name, as whole catalog entries', () => {
  const messages = JSON.parse(read('frontend/locales/en/messages.json'));
  // The agent chats' sentences, with "the agent" as "Homeroom bot" and this
  // catalog's apostrophe.
  const same = {
    'composer.saveDraft': 'Save draft',
    'composer.saveAsDraft': 'Save as draft',
    'drafts.label': 'Saved drafts',
    'drafts.heading_one': '<0>Saved drafts ({{count}})</0><1>· on all your devices</1>',
    'drafts.heading_other': '<0>Saved drafts ({{count}})</0><1>· on all your devices</1>',
    'drafts.ready': 'Ready to send',
    'drafts.send': 'Send this draft',
    'drafts.sendBusyTitle': 'Homeroom bot is still working. You can send this when it finishes',
    'drafts.sendTitle': 'Send this draft now',
    'drafts.edit': 'Edit this draft',
    'drafts.editTitle': 'Put this draft back in the box to edit',
    'drafts.delete': 'Delete this draft',
    'drafts.full_one': 'That’s {{count}} saved draft. Send or delete one first',
    'drafts.full_other': 'That’s {{count}} saved drafts. Send or delete one first',
    'drafts.saved': 'Draft saved. Send it whenever you’re ready',
    'drafts.keptTyped': 'Kept what you had typed as another draft',
    'drafts.deleted': 'Draft deleted',
    'drafts.saveFailed': 'Could not save that draft.',
    'drafts.deleteFailed': 'Could not delete that draft.',
  };
  for (const [id, text] of Object.entries(same)) {
    assert.equal(messages[id].text, text, id);
  }
  // Enter saves here, where the agent chats saved on Ctrl/Cmd + Enter.
  assert.equal(message('messages:composer.saveTitle'), 'Save this as a draft. It stays here until you send it');
  assert.equal(message('messages:composer.saveTitleShortcut'), 'Save this as a draft (Enter). It stays here until you send it');
  assert.equal(message('messages:composer.saveNote'), 'Homeroom bot is still working, so this will be <0>saved as a draft, not sent</0>. Send it from your drafts when it finishes.');
  assert.equal(message('messages:drafts.locked'), 'sending unlocks when Homeroom bot finishes');
  assert.equal(message('messages:drafts.heading', { count: 3 }), '<0>Saved drafts (3)</0><1>· on all your devices</1>');
  const added = Object.keys(messages).filter((id) => /^drafts\.|^composer\.save/.test(id));
  assert.equal(added.length, 23);
  for (const id of added) {
    assert.ok(messages[id].description.length > 40, `${id} says where it appears`);
    assert.doesNotMatch(messages[id].text, /—|\bthe agent\b|Claude/i, id);
  }
  // Every id the code asks for is one whole literal that the catalog has.
  const asked = new Set();
  for (const src of [COMPOSER, DRAFTS, LIST]) {
    for (const m of src.matchAll(/'(messages:(?:drafts|composer\.save)[A-Za-z.]*)'|id="(messages:(?:drafts|composer\.save)[A-Za-z.]*)"/g)) asked.add((m[1] || m[2]).slice('messages:'.length));
  }
  for (const id of asked) assert.ok(messages[id] || messages[`${id}_other`], `messages:${id} is in the catalog`);
  for (const id of added) assert.ok(asked.has(id.replace(/_(one|other)$/, '')), `messages:${id} is used`);
});
