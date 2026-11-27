'use strict';

// Task 2148: the Stop button in the chat with Homeroom bot
// (frontend/src/features/messages/bot-stop.ts, composer.tsx). A tester sent
// the wrong prompt and could only wait: the send button was only on or off.
//
//   1. The rule, as its whole table: Stop only in the viewer's own chat with
//      the bot, only while the bot is answering in the place on screen, only
//      with nothing to send; "Stopping" once pressed, until the answer ends.
//      With words typed while it works there, Send's place is "Save draft"
//      beside Stop (saved drafts: tests/messages-bot-drafts.test.js).
//   2. What the bot is answering comes from its typing event, and is kept on
//      its entry among those typing.
//   3. The composer draws it: the same disc as Send, a filled square, named
//      for a screen reader, Send again in a first render and with a person.
//   4. The keyboard never stops the bot: Enter sends (or saves a draft while
//      the bot works), Escape is as it was.
//   5. Its press asks the server about that one message.
//
// The server's part is in tests/homeroom-bot-stop.test.js and
// tests/homeroom-bot-stop-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const CSS = read('public/css/app.css');

const rule = loadTsx('frontend/src/features/messages/bot-stop.ts');

// ── 1. The rule ──────────────────────────────────────────────────────────

test('Send, Save, Stop or Stopping: the whole table', () => {
  const A = 71; // the message the bot is answering in the place on screen
  const rows = [
    // botChat, answering, words, empty, stopping → what takes Send's place
    // In the chat with Homeroom bot, the bot working, nothing to send: Stop.
    [true, A, false, true, null, 'stop'],
    // Pressed, and on its way: Stopping.
    [true, A, false, true, A, 'stopping'],
    // With words in the box it is "Save draft" (beside Stop): what is typed
    // while the bot works is saved, not sent. Whether or not a Stop is on
    // its way, and whatever else is staged with the words.
    [true, A, true, false, null, 'save'],
    [true, A, true, false, A, 'save'],
    // A file or an item alone (no words) is not a draft: Send, as it was.
    [true, A, false, false, null, 'send'],
    [true, A, false, false, A, 'send'],
    // The bot is not working here (it never was, or the answer ended): Send.
    [true, null, false, true, null, 'send'],
    [true, null, true, false, null, 'send'],
    [true, null, false, false, null, 'send'],
    // The Stop's answer ended, so its typing cleared: Send, not Stopping.
    [true, null, false, true, A, 'send'],
    [true, null, true, false, A, 'send'],
    // A Stop pressed for one answer does not hold the next one's button.
    [true, 72, false, true, A, 'stop'],
    [true, 72, true, false, A, 'save'],
    [true, 72, false, false, A, 'send'],
    // Any other conversation (a person, a group, a channel): always Send,
    // whoever is typing there and whatever is in the box.
    [false, A, false, true, null, 'send'],
    [false, A, false, true, A, 'send'],
    [false, A, true, false, null, 'send'],
    [false, A, true, false, A, 'send'],
    [false, A, false, false, null, 'send'],
    [false, null, false, true, null, 'send'],
    [false, null, true, false, null, 'send'],
  ];
  for (const [botChat, answering, words, empty, stopping, want] of rows) {
    assert.equal(rule.sendMode({ botChat, answering, words, empty, stopping }), want,
      JSON.stringify({ botChat, answering, words, empty, stopping }));
  }
  // Every combination of the five is one of the four. Anything but Send only
  // ever in the bot's chat with the bot answering; Stop or Stopping only
  // with an empty box; Save only with words.
  for (const botChat of [true, false]) for (const answering of [null, A, 72]) for (const words of [true, false]) for (const empty of [true, false]) for (const stopping of [null, A, 72]) {
    if (words && empty) continue; // words in the box are something to send
    const mode = rule.sendMode({ botChat, answering, words, empty, stopping });
    assert.ok(['send', 'save', 'stop', 'stopping'].includes(mode));
    if (mode !== 'send') assert.ok(botChat && answering);
    if (mode === 'stop' || mode === 'stopping') assert.ok(empty && !words);
    if (mode === 'save') assert.ok(words);
    if (botChat && answering && words) assert.equal(mode, 'save');
    if (mode === 'stopping') assert.equal(stopping, answering);
  }
  // The Stop button itself, alone or beside "Save draft": pressable, or on
  // its way for the answer it was pressed for.
  assert.equal(rule.stopMode({ answering: A, stopping: null }), 'stop');
  assert.equal(rule.stopMode({ answering: A, stopping: A }), 'stopping');
  assert.equal(rule.stopMode({ answering: 72, stopping: A }), 'stop');
  assert.equal(rule.stopMode({ answering: null, stopping: null }), 'stop');
  assert.equal(rule.STOPPING_MAX_MS, 15000, '"Stopping" gives way to Send after 15 seconds at the latest');
});

// ── 2. What the bot is answering ─────────────────────────────────────────

test('what the bot is answering is its typing entry\'s, in the place on screen', () => {
  const person = { name: 'ada', unnamed: false };
  assert.equal(rule.answeringIn([]), null, 'nobody types on a first render: Send');
  assert.equal(rule.answeringIn([person]), null, 'a person typing is not the bot working');
  // The bot typing with no message named: an answer that cannot be stopped
  // (an older server's event), so no Stop is offered that would do nothing.
  assert.equal(rule.answeringIn([{ name: 'Homeroom bot', unnamed: false, bot: true, doing: null }]), null);
  assert.equal(rule.answeringIn([person, { name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'writing' }, answering: 71 }]), 71);

  // The store keeps it on the bot's entry: named by its newest event, and
  // kept through one that names none.
  const store = loadTsx('frontend/src/features/messages/store.ts');
  const first = store.botTypist(undefined, 'Homeroom bot', null, 71);
  assert.deepEqual(first, { name: 'Homeroom bot', unnamed: false, bot: true, doing: null, answering: 71 });
  assert.equal(store.botTypist(first, 'Homeroom bot', store.botDoingOf({ kind: 'writing' }), null).answering, 71);
  assert.equal(store.botTypist(first, 'Homeroom bot', null, 72).answering, 72);
  assert.equal('answering' in store.botTypist(undefined, 'Homeroom bot', null), false, 'none named, none kept');
  const src = read('frontend/src/features/messages/store.ts');
  assert.match(src, /\? botTypist\(prior\?\.bot \? prior : undefined, shown, botDoingOf\(event\.doing\), api\.strictId\(event\.answering\) \|\| null\)/,
    'read from the typing event as a strict id');
  // The server names it on the bot's typing events only for an answer that
  // can be stopped (its DM machine's work).
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /\.\.\.\(typing && answering \? \{ answering \} : \{\}\),/);
  assert.match(dm, /answering: deps\.stop \? message\.id : null \},/);
});

// ── 3. The composer ──────────────────────────────────────────────────────

function composerHtml({ homeroomBot = true, typing = [], threadRootId = null } = {}) {
  const asked = [];
  const snap = {
    route: { conversationId: 42 },
    active: {
      id: 42, kind: 'direct', title: 'Homeroom bot', membershipStatus: 'member', myRole: 'member', members: [], memberCount: 2,
      canSend: true, awaitingAcceptance: false, homeroomBot,
    },
    messages: [], conversations: [], discussions: [],
  };
  const store = {
    channels: () => [], draftFor: () => '', draftAttachmentsFor: () => [], notifyTyping() {}, replyFor: () => null,
    scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setDraftAttachments() {}, setReply() {},
    takePendingShare: () => undefined, useMessagesSnapshot: () => snap,
    typingUsers: (conversationId, rootId = null) => { asked.push([conversationId, rootId]); return typing; },
  };
  const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', {
    stubs: {
      './store': store,
      './api': {},
      '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
      '../../lib/use-auto-grow': { useAutoGrow() {} },
    },
  });
  return { html: renderToHtml(createElement(MessageComposer, threadRootId ? { threadRootId } : {})), asked };
}
const BOT_WORKING = [{ name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'writing' }, answering: 71 }];
const lastButton = (html) => /<button[^>]*class="messages-send[^"]*"[^>]*>.*?<\/button>/.exec(html)[0];

test('while the bot works on your message and the box is empty, Send\'s place is Stop', () => {
  const { html, asked } = composerHtml({ typing: BOT_WORKING });
  const button = lastButton(html);
  assert.match(button, /^<button type="button" class="messages-send messages-send-stop" data-bot-stop="stop" aria-label="Stop Homeroom bot" title="Stop Homeroom bot">/);
  assert.doesNotMatch(button, /disabled/, 'it can be pressed');
  assert.match(button, /<span class="h-3\.5 w-3\.5 rounded-sm bg-current" aria-hidden="true"><\/span><\/button>$/, 'a filled square, as the agent session\'s Stop is');
  assert.doesNotMatch(button, /<svg/, 'not the arrow');
  assert.equal((html.match(/class="messages-send/g) || []).length, 1, 'one button in Send\'s place, never two');
  assert.deepEqual(asked, [[42, null]], 'it reads who types in the main chat');
  // In a thread it reads that thread's typing: the bot working in the main
  // chat is not the bot working here.
  const thread = composerHtml({ typing: BOT_WORKING, threadRootId: 9 });
  assert.deepEqual(thread.asked, [[42, 9]]);
  assert.match(lastButton(thread.html), /data-bot-stop="stop"/);
  // The accessible names are the catalog's.
  assert.equal(message('messages:composer.stop'), 'Stop Homeroom bot');
  assert.equal(message('messages:composer.stopping'), 'Stopping');
  assert.equal(message('messages:composer.stopFailed'), 'Homeroom bot wasn’t stopped. Try again.');
});

test('a first render, a bot that is not working and any other conversation draw Send', () => {
  const send = /^<button type="button" disabled="" class="messages-send" aria-label="Send message">/;
  // Nothing types on a first render (the store starts empty): the prerender
  // and the hydration draw the Send they always drew.
  assert.match(lastButton(composerHtml().html), send);
  assert.doesNotMatch(composerHtml().html, /data-bot-stop|messages-send-stop/);
  // The bot typing an answer that cannot be stopped.
  assert.match(lastButton(composerHtml({ typing: [{ name: 'Homeroom bot', unnamed: false, bot: true, doing: null }] }).html), send);
  // A person's conversation, whoever types there and whatever their event says.
  assert.match(lastButton(composerHtml({ homeroomBot: false, typing: BOT_WORKING }).html), send);
  assert.match(lastButton(composerHtml({ homeroomBot: false, typing: [{ name: 'sam', unnamed: false, answering: 71 }] }).html), send);
});

test('the composer decides with the rule, from what is in the box, and "Stopping" ends with the answer or after its cap', () => {
  assert.match(COMPOSER, /const answering = conversationId \? answeringIn\(typingUsers\(conversationId, threadRootId\)\) : null;/);
  // The viewer's own chat with the bot, and the one the route is on.
  assert.match(COMPOSER, /const botChat = active\?\.homeroomBot === true && active\.id === conversationId;/);
  assert.match(COMPOSER, /const sendKind = sendMode\(\{\n\s+botChat,\n\s+answering,\n\s+words: !!value\.trim\(\),\n\s+empty: !value\.trim\(\) && !attachments\.length && !object && !uploading && !dictating,\n\s+stopping: stoppingFor,\n\s+\}\);/,
    'words make it Save; a file (attached or on its way up), an item or dictation alone keep it Send');
  assert.match(COMPOSER, /const stopKind = stopMode\(\{ answering, stopping: stoppingFor \}\);/);
  // The answer ended, or another began: no longer "Stopping". Else the cap.
  assert.match(COMPOSER, /if \(stoppingFor !== answering\) \{ setStoppingFor\(null\); return undefined; \}\n\s+const timer = window\.setTimeout\(\(\) => setStoppingFor\(null\), STOPPING_MAX_MS\);\n\s+return \(\) => window\.clearTimeout\(timer\);/);
  // The disabled state is "Stopping", by name.
  assert.match(COMPOSER, /disabled=\{stopKind === 'stopping'\} className="messages-send messages-send-stop" data-bot-stop=\{stopKind\} aria-label=\{t\(stopKind === 'stopping' \? 'messages:composer\.stopping' : 'messages:composer\.stop'\)\}/);
  // The same disc as Send, so it keeps Send's size and its 44px target; an
  // empty field fades Send, never a Stop that can be pressed.
  assert.match(CSS, /\n\.messages-composer-card:not\(\[data-gc-files\]\):has\(textarea:placeholder-shown\) \.messages-send\.messages-send-stop:not\(:disabled\) \{ opacity: 1; \}\n/);
  assert.match(CSS, /\n\.messages-send:disabled \{ opacity: \.35; \}\n/, '"Stopping" is the faded disc a disabled Send is');
  assert.doesNotMatch(CSS, /\.messages-send-stop[^{]*\{[^}]*(?:width|height|background|color)\s*:/, 'no size or colour of its own');
});

// ── 4. The keyboard ──────────────────────────────────────────────────────

test('only a press of the button stops the bot: Enter sends or saves, an empty box sends nothing, Escape is as it was', () => {
  // The one caller of stopBot is the Stop button's click.
  assert.equal((COMPOSER.match(/stopBot\b/g) || []).length, 2, 'declared, and pressed');
  assert.match(COMPOSER, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\} onClick=\{stopBot\} disabled=\{stopKind === 'stopping'\}/,
    'and the press keeps the field focused, as Send\'s does');
  // The field's keys: Enter is submit, which returns at once on an empty
  // box, and with words while the bot works saves them as a draft.
  const field = /<textarea ref=\{inputRef\}[^\n]*/.exec(COMPOSER)[0];
  // Escape takes down the staged reply through the place (one message box,
  // 27 Nov 2026), which in a conversation is setReply(scope, null).
  assert.match(field, /if \(enterSends\(event\.nativeEvent\)\) \{ event\.preventDefault\(\); submit\(\); \} else if \(event\.key === 'Escape' && reply\) place\.cancelReply\?\.\(\);/);
  assert.match(COMPOSER, /cancelReply: \(\) => setReply\(scope, null\),/);
  assert.doesNotMatch(field, /stop/i);
  assert.match(COMPOSER, /function submit\(\) \{\n\s+if \(dictating \|\| uploading \|\| \(!value\.trim\(\) && !attachments\.length && !object\)\) return;\n[^\n]*\n[^\n]*\n\s+if \(sendKind === 'save'\) \{ saveTyped\(\); return; \}/);
  const submit = COMPOSER.slice(COMPOSER.indexOf('function submit() {'), COMPOSER.indexOf('\n  }\n', COMPOSER.indexOf('function submit() {')));
  assert.doesNotMatch(submit, /stopBot/, 'no key reaches Stop');
  // Send is the button it was (the suites that pin it read the first one).
  assert.match(COMPOSER, /<button type="button" onMouseDown=\{\(event\) => event\.preventDefault\(\)\} onClick=\{submit\} disabled=\{dictating \|\| !!uploading \|\| \(!value\.trim\(\) && !attachments\.length && !object\)\} className="messages-send" aria-label=\{t\('messages:composer\.send'\)\}/);
});

// ── 5. The press ─────────────────────────────────────────────────────────

test('a press asks the server to stop the answer to that one message, once', async () => {
  const press = COMPOSER.slice(COMPOSER.indexOf('function stopBot() {'), COMPOSER.indexOf('const boxShown ='));
  assert.match(press, /if \(!conversationId \|\| !answering \|\| stoppingFor === answering\) return;/, 'not twice for one answer');
  assert.match(press, /setStoppingFor\(stopped\);\n\s+api\.stopBotAnswer\(conversationId, stopped\)/);
  // Nothing was being answered any more, or the server was not reached: Send again.
  assert.match(press, /\.then\(\(stopping\) => \{ if \(!stopping\) setStoppingFor\(\(now\) => \(now === stopped \? null : now\)\); \}\)/);
  assert.match(press, /setError\(t\('messages:composer\.stopFailed'\)\);/);

  // The request itself.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ ok: true, stopping: calls.length === 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const api = loadTsx('frontend/src/features/messages/api.ts');
    assert.equal(await api.stopBotAnswer(42, 71), true);
    assert.equal(await api.stopBotAnswer(42, 71), false, 'the answer had ended');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/conversations\/42\/bot-stop(\?|$)/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { messageId: 71 });
});
