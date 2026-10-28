'use strict';

// #2813: agent threads open BESIDE the Messages list on a desktop.
//
// DMs, groups and app channels already opened in the pane next to the
// conversation list. The agent kinds did not: an agent chat went to its own
// screen and an app's dev session to the app view
// (`#app/<slug>/dev/sessions/<id>`), so picking one took the list away.
//
// What is pinned here, each a way the feature quietly comes undone:
//
//   1. THE ROWS LINK TO THE INBOX'S OWN ADDRESSES, `#messages/agent/<id>`
//      and `#messages/session/<slug>/<id>`, and the store validates both.
//   2. ON A PHONE A DEV SESSION KEEPS ITS FULL-SCREEN BEHAVIOUR: the router
//      swaps its address in place (replaceState, then routes the new one)
//      for the app view's, and records the session's origin so its chevron
//      comes back to the inbox. An agent session opens in the inbox there
//      too, as the second level of its drawer (Evan, 18 Oct 2026), and its
//      own screen's addresses are swapped for the inbox's.
//   3. ONE THREAD IS OPEN — an agent thread clears a conversation and a
//      discussion, and hides the list on a phone like any other thread.
//   4. GLOBAL CHAT'S OLD ADDRESSES OPEN THE INBOX: it was removed, and
//      `#chat`, `#chat/<id>` and `#messages/agent/<uuid>` now land on
//      `#messages` rather than on a thread nothing can draw.
//   5. THE DEV SESSION IS MOUNTED, NOT RE-IMPLEMENTED: a constant host that
//      AppView fills with the same session view the app view shows, and
//      that is retired only while no app view has taken over.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const APP = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');

const store = loadTsx('frontend/src/features/messages/store.ts');

test('agent threads have inbox addresses, and a phone has the full-screen ones', () => {
  const agent = { kind: 'agent', id: 12 };
  const session = { kind: 'session', slug: 'notes-ab12', id: 42 };
  assert.equal(store.agentThreadAddress(agent), '#messages/agent/12');
  assert.equal(store.agentThreadAddress(session), '#messages/session/notes-ab12/42');
  assert.equal(store.fullScreenAddress(agent), '#agent/12');
  assert.equal(store.fullScreenAddress(session), '#app/notes-ab12/dev/sessions/42');
});

test('the store validates an agent thread out of the address bar', () => {
  assert.deepEqual(store.validAgentThread({ kind: 'agent', id: 7 }), { kind: 'agent', id: 7 });
  assert.deepEqual(store.validAgentThread({ kind: 'agent', id: 'new' }), { kind: 'agent', id: 'new' });
  assert.deepEqual(
    store.validAgentThread({ kind: 'session', slug: 'notes-ab12', id: 7 }),
    { kind: 'session', slug: 'notes-ab12', id: 7 },
  );
  for (const bad of [
    null,
    // A Global Chat thread was one; it was removed, and its kind with it.
    { kind: 'chat', id: '5f0c2a1e-8d7b-4c2a-9e11-0b6f3f3c9a10' },
    { kind: 'agent', id: 0 },
    { kind: 'session', slug: 'notes', id: 0 },
    { kind: 'session', slug: 'notes', id: 2_147_483_648 },
    { kind: 'session', slug: '<b>', id: 3 },
    { kind: 'other', id: 'x' },
  ]) {
    assert.equal(store.validAgentThread(bad), null, JSON.stringify(bad));
  }
});

test('one thread is open: an agent thread yields to a conversation or a discussion', () => {
  assert.match(STORE, /const nextAgent = nextId \|\| nextSlug \? null : validAgentThread\(agent\);/);
  // #2387: a reply thread and a message link ride on the route too, and
  // are cleared with it.
  assert.match(STORE, /route: \{ open: true, conversationId: nextId, appSlug: nextSlug, agent: nextAgent, threadRootId: nextRoot, focusMessageId: nextFocus \}/);
  assert.match(STORE, /route: \{ open: false, conversationId: null, appSlug: null, agent: null, threadRootId: null, focusMessageId: null \}/);
  // On a phone the list hides behind an agent thread as behind any other.
  assert.match(SCREEN, /snap\.route\.conversationId \|\| snap\.route\.appSlug \|\| snap\.route\.agent \? 'hidden md:flex' : 'flex'/);
  assert.match(STORE, /const onThread = !!state\.route\.conversationId \|\| !!state\.route\.appSlug \|\| !!state\.route\.agent;/);
});

test('the rows link to the inbox addresses and mark the open one', () => {
  assert.match(SCREEN, /const href = agentThreadAddress\(thread\);[\s\S]*?href=\{href\}\s*data-inbox-agent-session=\{session\.id\}/);
  assert.match(SCREEN, /href: agentThreadAddress\(\{ kind: 'session', slug: session\.appSlug, id: session\.id \}\)/);
  assert.match(SCREEN, /active=\{open\?\.kind === 'agent' && open\.id === session\.id\}/);
  assert.match(SCREEN, /active=\{open\?\.kind === 'session' && open\.id === session\.id\}/);
  // The row no longer records the session's origin itself: on a desktop the
  // session is not left for, and on a phone the router records it.
  assert.doesNotMatch(SCREEN, /onNavigate=\{\(\) => \{\s*if \(session\.kind === 'session'\) Improve\.enterSessionFrom/);
});

test('#4729: the Agents list folds its archived chats behind Show archived at its foot', () => {
  // The toggle, a quiet link like "N older chats", shows for somebody who
  // has had an agent session on the Agents list with no query — search does
  // not cover the archived — and after mount only, so the hydrating render
  // matches the prerender.
  assert.match(SCREEN, /id="messages-show-archived"/);
  assert.match(SCREEN, /className="messages-inbox-older"\s*aria-expanded=\{archivedOpen\}/);
  assert.match(SCREEN, /const showArchivedToggle = mounted && !!agentChatsShown && !snap\.folded\.includes\('agents'\) && !searching;/);
  // Under all of the open ones: once "N older chats" has shown the rest,
  // at the foot of the Agents card.
  assert.match(SCREEN, /const archive = section === 'agents' && showArchivedToggle && \(!older \|\| agentsExpanded\);/);
  assert.match(SCREEN, /\{olderShown\.map\(inboxRow\)\}\s*\{archive \? archivedToggle : null\}\s*<\/div>/);
  assert.match(SCREEN, /\{archivedOpen \? t\('messages:inbox\.archived\.hide'\) : t\('messages:inbox\.archived\.show'\)\}/);
  // Opening it reads the archived list from the same route the open list
  // reads, ?status=archived, and reads it again on EVERY open, so a session
  // archived or unarchived meanwhile is where it now belongs.
  assert.match(read('frontend/src/features/agent-session/api.ts'),
    /export async function listArchivedSessions\(\)[\s\S]{0,400}'\/api\/agent-sessions\?status=archived&limit=50'/);
  assert.match(SCREEN, /useEffect\(\(\) => \{\s*if \(archivedOpen\) readArchived\(\);\s*\}, \[archivedOpen, readArchived\]\);/);
  // The open group is a section like the others: headed, carded, with its
  // own empty line and the list's error-and-retry shape, and its rows mark
  // the one that is open.
  assert.match(SCREEN, /<h3 className="messages-section-head" data-inbox-section="archived">\{t\('messages:inbox\.archived\.heading'\)\}<\/h3>/);
  assert.match(SCREEN, /<div className="messages-section-card" data-inbox-card="archived">/);
  assert.match(SCREEN, /active=\{open\?\.kind === 'agent' && open\.id === session\.id\}/);
  assert.match(SCREEN, /<div className="messages-state"><p>\{t\('messages:inbox\.archived\.empty'\)\}<\/p><\/div>/);
  assert.match(SCREEN, /archivedError \? \(\s*<div className="messages-state messages-state-error">/);
  // The words, in English, in the catalog.
  assert.equal(message('messages:inbox.archived.show'), 'Show archived');
  assert.equal(message('messages:inbox.archived.hide'), 'Hide archived');
  assert.equal(message('messages:inbox.archived.heading'), 'Archived');
  assert.equal(message('messages:inbox.archived.empty'), 'No archived agent chats.');
});

test('the router opens agent threads in the pane, and on a phone swaps only a dev session away', () => {
  const at = APP.indexOf('const agent = App._messagesAgentThread(parts);');
  assert.ok(at > 0, 'the #messages route reads agent threads');
  const block = APP.slice(at, APP.indexOf('App.navigateToMessages(null, null, agent);', at));
  assert.match(block, /if \(agent\.kind === 'session' && !window\.matchMedia\('\(min-width: 768px\)'\)\.matches\) \{/);
  assert.match(block, /Improve\.enterSessionFrom\?\.\('#messages'\)/);
  assert.match(block, /App\.restoreFromHash\(\);/);
  assert.match(block, /`#app\/\$\{encodeURIComponent\(agent\.slug\)\}\/dev\/sessions\/\$\{agent\.id\}`/);
  assert.doesNotMatch(block, /`#agent\//, 'an agent session stays in the inbox on a phone');
  // Their own screens' addresses come to the inbox on a phone, a ?flow= with them.
  assert.match(APP, /_agentToInbox\(address, fragQuery\) \{\s*if \(App\.embeddedPanel \|\| window\.matchMedia\('\(min-width: 768px\)'\)\.matches\) return false;/);
  assert.match(APP, /history\.replaceState\(null, '', App\._rootUrl\(`\$\{address\}\$\{fragQuery \? `\?\$\{fragQuery\}` : ''\}`\)\);/);
  assert.match(APP, /if \(parts\.length === 2 && parts\[0\] === 'agent'\s*&& \(parts\[1\] === 'new' \|\| App\._numericSegment\(parts\[1\]\) != null\)\s*&& App\._agentToInbox\(`#messages\/agent\/\$\{parts\[1\]\}`, fragQuery\)\) return;/,
    'an agent session or a new one; #agent/<id>/changes keeps its screen');
  // #2387: a fourth argument carries a reply thread or a message link.
  assert.match(APP, /navigateToMessages\(conversationId, appSlug, agent, extras\) \{/);
  assert.match(APP, /messages\.route\?\.\(conversationId \|\| null, appSlug \|\| null, agent \|\| null, more\);/);
  assert.match(APP, /_messagesAgentThread\(parts\) \{[\s\S]*?parts\[1\] === 'agent'[\s\S]*?parts\[1\] === 'session'/);
});

test('Global Chat\'s old addresses open the inbox, at #messages', () => {
  // `#chat` and `#chat/<id>`: the inbox, whatever the viewport.
  assert.match(APP, /if \(parts\[0\] === 'chat'\) \{\s*(?:\/\/[^\n]*\n\s*)*App\._retiredChatToInbox\(\);\s*return;\s*\}/);
  // `#messages/agent/<uuid>`: a number or `new` names an agent session, and
  // nothing else names a thread any more.
  assert.match(APP, /if \(agent\) \{[\s\S]*?\n        \}\n(?:\s*\/\/[^\n]*\n)*\s*if \(parts\[1\] === 'agent' && parts\[2\]\) \{\s*App\._retiredChatToInbox\(\);\s*return;\s*\}/);
  const thread = APP.slice(APP.indexOf('  _messagesAgentThread(parts) {'));
  assert.doesNotMatch(thread.slice(0, thread.indexOf('\n  },')), /kind: 'chat'/);
  // The old address is replaced, so a reload or Back does not route it again.
  const retired = APP.slice(APP.indexOf('  _retiredChatToInbox() {'));
  assert.match(retired.slice(0, retired.indexOf('\n  },')),
    /history\.replaceState\(history\.state, '', App\._rootUrl\('#messages'\)\);[\s\S]*App\.navigateToMessages\(null\);/);
  assert.doesNotMatch(APP, /navigateToGlobalChat|_inGlobalChat|global-chat-screen/);
});

test('the dev session is mounted into a host, like a discussion', () => {
  assert.match(SCREEN, /view\.mountSessionInHost\(el, \{ slug, sessionId: id \}\)/);
  assert.match(SCREEN, /view\?\.unmountSessionHost\?\.\(el\);/);
  assert.match(SCREEN, /<div ref=\{host\} className="messages-session-host flex-1 min-h-0" hidden=\{phase === 'unavailable'\} \/>/);
  assert.match(SCREEN, /Open full view/);

  assert.match(APP_VIEW, /async mountSessionInHost\(host, \{ slug, sessionId \} = \{\}\) \{/);
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.mountSessionShell\(host\);\s*const result = await AppView\.renderDevChatTab\(sessionId, \{ embedded: true \}\);/);
  // The container follows the pane only while no app view is up.
  assert.match(APP_VIEW, /if \(embedded && !\(typeof App !== 'undefined' && App\.currentApp\) && embedded\.isConnected\) \{/);
  // Teardown never undoes an app view that has taken over.
  const unmount = APP_VIEW.slice(APP_VIEW.indexOf('unmountSessionHost(host) {'));
  assert.match(unmount.slice(0, 600), /if \(typeof App !== 'undefined' && App\.currentApp\) return;[\s\S]*?DevChat\.reset\(\);/);
  // No Board to fall back to in the pane.
  assert.match(APP_VIEW, /if \(embedded\) return 'unavailable';/);
  // DevChat's work-order flow reads the session's app, not the app view's.
  assert.doesNotMatch(DEV_CHAT, /const slug = App\.currentApp;/);
  assert.match(DEV_CHAT, /_appSlug\(\) \{/);
});
