// The Messages list in the one frame (frontend/src/features/messages/frame-
// list.tsx), version 2 of the screen tour's s15 and s20: the first tour's
// layout (the page's head, People as its tab, the conversations as the
// kit's one row) holding what the standard list holds: the product's search,
// a group's member count and "N new". It is the product's own list
// (./index.tsx ConversationList) with another face: the pane builds each row
// and hands them in. Agents was the second tab until it left Messages
// (16 Nov 2026).
//
// Run with: node --test tests/messages-frame-list.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const LIST = 'frontend/src/features/messages/frame-list.tsx';
const PANE = 'frontend/src/features/messages/index.tsx';

const row = (key, title, over) => ({
  key, lead: null, title, line: 'ignore', time: '4d ago', timeTitle: '7 Nov 2026, 10:02', fresh: null, status: null, active: false,
  href: `#messages/${key}`, onClick() {}, ...over,
});
const state = { loading: false, error: null, onRetry() {}, offline: false, empty: false, onStart() {}, searched: null };
const base = {
  people: [
    row('4', 'evan', { active: true }),
    row('9', 'Evan / Lukas / Salah / Drea', { line: '@evan: going to make some changes', fresh: '2 new', members: { count: 4, words: '4 members' } }),
    row('12', 'Bruno', { line: 'test (edit)', time: '14 Aug' }),
  ],
  unread: 2,
  query: '', onQuery() {}, onNew() {}, state,
};
const render = (over) => renderComponent(LIST, 'MessagesFrameList', { ...base, ...over }, { cache: false });
// A conversation's name is in the span that is cut short.
const titles = (html) => [...html.matchAll(/<span class="fr-t">(?:<span class="fr-cut">)?([^<]+)/g)].map((m) => m[1]);

test('the list is the kit\'s pane: the head with one sentence and one action, the People tab, the product\'s search under it', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-pane" data-messages-frame-list=""><div class="fr-scroll"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Messages<\/h1><p class="fr-purpose">People and groups you talk to\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>New message<\/button><\/div><\/div>/s);
  assert.match(html, /<nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">People<span class="fr-n">2<\/span><\/button><\/nav><div class="fr-search">/,
    'People, the one tab, says how many messages from people are unread, as the standard heading does');
  assert.doesNotMatch(html, /Agents|Changes your agents are building/, 'Agents is no tab of Messages any more');
  assert.match(html, /<input type="search" class="fr-v" placeholder="Search" aria-label="Search messages" value=""\/>/, 'the standard search\'s own words');
  assert.equal((html.match(/type="search"/g) || []).length, 1, 'one field, under the tabs at every width');
  const src = read(LIST);
  for (const id of ['messages:inbox.new.button', 'messages:inbox.section.people', 'messages:inbox.searchPlaceholder', 'messages:inbox.searchLabel']) {
    assert.ok(src.includes(`'${id}'`), `${id} is the standard list's own id`);
  }
  assert.doesNotMatch(src, /inbox\.section\.agents|inbox\.older|agentsPurpose|data-inbox-more|data-inbox-unseen|FrameInboxTab/, 'nothing of the Agents tab is left');
});

test('a conversation with something new ends in the blue pill, the others in a grey time; a group says how many are in it', () => {
  const html = render();
  assert.deepEqual(titles(html), ['evan', 'Evan / Lukas / Salah / Drea', 'Bruno'], 'People holds the conversations, in the order the pane hands them');
  assert.match(html, /<span class="fr-t"><span class="fr-cut">Evan \/ Lukas \/ Salah \/ Drea<\/span><span class="fr-pill fr-mini" role="img" aria-label="4 members" title="4 members"><svg[^>]*>.*?<\/svg>4<\/span><\/span><span class="fr-s">@evan: going to make some changes<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/s,
    'the count is the figure after a people glyph, and the words to a screen reader');
  assert.match(html, /<span class="fr-t"><span class="fr-cut">Bruno<\/span><\/span><span class="fr-s">test \(edit\)<\/span><\/span><span class="fr-meta" title="7 Nov 2026, 10:02">14 Aug<\/span>/, 'the time carries the whole instant');
  assert.equal((html.match(/data-kind="act"/g) || []).length, 1, 'blue only where something waits');
  assert.equal((html.match(/fr-mini/g) || []).length, 1, 'a direct message has no count');
  assert.match(render({ people: [row('5', 'helper', { tag: 'AI' })] }), /<span class="fr-t"><span class="fr-cut">helper<\/span><span class="fr-pill fr-mini" data-kind="none">AI<\/span><\/span>/, 'a bot\'s direct message keeps its badge');
  // A long group name is what gives way: the count after it keeps its place in the row (visual pass, v2 finding 5).
  const css = read('public/css/app.css');
  assert.ok(css.includes('html[data-skin] [data-messages-frame-list] .fr-row .fr-t:has(> .fr-cut) { display: flex; align-items: center; min-width: 0; }'));
  assert.ok(css.includes('html[data-skin] [data-messages-frame-list] .fr-row .fr-t > .fr-cut { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'));
});

test('the open conversation\'s row is lit, and every row is a link to its own address', () => {
  const html = render();
  assert.match(html, /<a class="fr-row fr-on" href="#messages\/4" aria-current="page" data-inbox-row="[^"]+">/);
  assert.equal((html.match(/<a class="fr-row/g) || []).length, 3);
  assert.equal((html.match(/class="fr-row fr-on"/g) || []).length, 1);
});

test('what the list says when it has nothing to list is the standard list\'s sentence', () => {
  const none = { people: [] };
  assert.match(render({ ...none, state: { ...state, empty: true } }), /<div class="fr-card fr-pad fr-text"><div class="fr-sub15">No messages yet<\/div><p class="fr-txt">Start a direct conversation or bring a group together\.<\/p><div class="fr-btnrow"><button type="button" class="fr-btn fr-quiet fr-sm">New conversation<\/button><\/div><\/div>/,
    'an empty inbox: the product\'s words and its one action');
  assert.match(render({ ...none, state: { ...state, searched: 'zz' } }), /<div class="fr-card fr-pad"><span data-inbox-search-empty="">No messages match “zz”\.<\/span><\/div>/, 'a search that matched nothing names what was typed');
  assert.match(render({ people: [], state }), /<div class="fr-card fr-pad">Nothing here yet\.<\/div>/, 'nothing listed and nothing read yet');
  const loading = render({ ...none, state: { ...state, loading: true } });
  assert.match(loading, /<p class="fr-txt" role="status" data-inbox-loading="">Loading conversations<\/p>/);
  assert.doesNotMatch(loading, /Nothing here yet|No messages yet/, 'nothing says "nothing" before the list has been read');
  const failed = render({ ...none, state: { ...state, error: 'Could not load conversations.' } });
  assert.match(failed, /<div class="fr-txt" role="status" data-inbox-failed="">Could not load conversations\. <button type="button" class="fr-link">Try again<\/button><\/div>/);
  assert.doesNotMatch(failed, /Nothing here yet/);
  // Try again pressed: the read is under way with no conversation in hand, and no tab says it is empty (visual pass, v2 finding 4).
  const retrying = render({ people: [], state: { ...state, reading: true } });
  assert.doesNotMatch(retrying, /Nothing here yet|No messages yet/);
  assert.match(read(PANE), /reading: !!snap\.loadingList && !snap\.conversations\.length,/);
  assert.match(render({ state: { ...state, offline: true } }), /<div class="fr-note fr-wait"><svg[^>]*>.*?<\/svg><div>Offline\. Queued messages retry when you reconnect\.<\/div><\/div>/s);
});

test('what the first tour invented is gone from the catalog, and the words are the standard list\'s', () => {
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  const frame = Object.keys(catalog).filter((id) => id.startsWith('frame.inbox.') || id.startsWith('frame.new.'));
  assert.deepEqual(frame.sort(), ['frame.inbox.none', 'frame.inbox.purpose'],
    'only the sentence under the title and an empty list\'s line are the frame\'s own');
  assert.doesNotMatch(read(LIST), /frame\.inbox\.(new|tabPeople|tabAgents|search|agentsSearch|agentsCount)/);
});

test('the list pane hands its own conversations to the kit list under a look, and only then', () => {
  const src = read(PANE);
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/);
  const block = src.slice(src.indexOf('  if (frame) {\n    const me = Number'), src.indexOf("aria-label={t('messages:inbox.listName')}"));
  assert.ok(block.length > 2000, 'the frame branch is one block ahead of the standard list');
  assert.match(block, /color=\{swatchFor\(face\?\.username \|\| name \|\| '\?'\)\}/, 'a person with no picture wears the colour they wear everywhere');
  assert.match(block, /const face = c\.kind === 'group' && !invited\s+\? c\.members\.find\(\(member\) => member\.status === 'member' && Number\(member\.id\) !== me\) \|\| null\s+: peer;/,
    'a group wears the face of someone in it who is not you');
  assert.match(block, /members: Number\.isFinite\(count\) && count > 0 \? \{ count, words: t\('messages:inbox\.memberCount', \{ count \}\) \} : null,/, 'the member count in GroupMemberCount\'s words; a zero says nothing');
  assert.match(block, /people=\{rowsOf\(found\)\}/, 'every conversation the search keeps, as the standard list draws them');
  assert.doesNotMatch(block, /shownInSection|agentsExpanded|onOlder|sessionRowState|frameTab/, 'no Agents tab to fold or switch to');
  assert.match(block, /unread=\{unreadFromPeople\}/, 'the People tab counts what the standard heading counts');
  assert.match(block, /empty: !snap\.loadingList && !snap\.error && !!snap\.listLoaded && !inbox\.length,/);
  assert.match(block, /onStart: \(\) => openDialog\('messagesCreate'\),/);
  assert.match(block, /<NewMessageSheet\s+choices=\{NEW_CHOICES\}\s+onPick=\{\(choice\) => \{ setFrameNew\(false\); window\.setTimeout\(\(\) => startNew\(choice\), 0\); \}\}/,
    'New message hands over to the product\'s own starts (tests/messages-frame-new.test.js)');
  assert.doesNotMatch(block, /known|createDirect|createGroup/, 'nothing is picked or created by the list any more');
  assert.match(src, /data-frame-list=""/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.messages-list-pane\[data-frame-list\] \{ flex: 0 0 520px; width: 520px; \}/, 'the list is the split\'s 520px pane');
  assert.match(css, /html\[data-skin\] \.messages-layout\.messages-list-page > \.messages-list-pane\[data-frame-list\] \{ max-width: none; margin: 0; \}/, 'with nothing open the list stays where it is');
  assert.match(css, /html\[data-skin\] \.messages-layout\.messages-list-page:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{ display: flex; \}/, 'and the pane beside it says nothing is open');
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{[^}]*border-inline-start: 1px solid var\(--fr-line\);/, 'one line between the two panes');
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{[^}]*border-top: 0;/, 'and no second: the pane is a dc-lift sheet whose top hairline drew a line under the header');
  // The kit's pane clips its scroll (`.fr-pane .fr-scroll { overflow:
  // hidden }`, in the compiled kit, which comes after the shell's rules at
  // the same weight), so on a phone the list could not scroll at all: the
  // shell's rule names the pane twice and wins, and the list pane scrolls.
  assert.match(css, /html\[data-skin\] \.fr\.fr-pane,\s*html\[data-skin\] \.fr\.fr-pane > \.fr-scroll \{ overflow: visible; \}/);
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) \{ background: none; backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none; border-radius: 0; border-top: 0; \}/, 'nor the strip the layout is: the tour\'s Messages sits flat under the header');
});
