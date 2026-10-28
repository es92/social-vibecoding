'use strict';

// #2387 follow-up: FULL WIDTH on every discussion pane.
//
// The first cut of single-panel mode put a sidebar glyph at the LEFT of a
// conversation's title row, and only a conversation's and an app channel's.
// It now ends every discussion pane's header, just before ⋯ where there is
// one, as a full-screen control does: arrows out while the list is shown,
// arrows in once it is hidden. What is pinned here, each a way it quietly
// comes undone:
//
//   1. ONE CONTROL: its labels, `aria-pressed`, the glyph swap, and the two
//      classes dapp.json's checks and app.css select it by.
//   2. EVERY PANE CARRIES IT, AT THE RIGHT: a conversation or #general (before
//      ⋯), an app's channel, a dev session's bar, and the agent session's
//      panel, which takes it as `headerAction` rather than importing this
//      store.
//   3. IT DOES SOMETHING ON EVERY PANE: the layout folds the list for an
//      agent thread too, not only for a conversation or a channel.
//   4. IT STAYS PUT: hidden on a phone, and out of the way of a side pane.
//
// Run with: node --test tests/messages-full-width.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const SESSION = read('frontend/src/features/agent-session/index.tsx');
const ICONS = read('frontend/@/components/ui/icons.tsx');
const CSS = read('public/css/app.css');

/** The source of one top-level function in the Messages screen. */
function fn(name) {
  const start = SCREEN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = SCREEN.indexOf('\nfunction ', start + 1);
  const nextExport = SCREEN.indexOf('\nexport function ', start + 1);
  const end = [next, nextExport].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), SCREEN.length);
  return SCREEN.slice(start, end);
}

test('the toggle: "Full width" with arrows out, "Show the conversation list" with arrows in', () => {
  const toggle = fn('FullWidthToggle');
  assert.equal(message('messages:header.showList'), 'Show the conversation list');
  assert.equal(message('messages:header.fullWidth'), 'Full width');
  assert.match(toggle, /const label = collapsed \? t\('messages:header\.showList'\) : t\('messages:header\.fullWidth'\);/);
  assert.match(toggle, /className="messages-thread-action messages-list-toggle"/,
    'the disc every header action is, and the class the checks and app.css find it by');
  assert.match(toggle, /aria-pressed=\{collapsed\}/);
  assert.match(toggle, /aria-label=\{label\}\s+title=\{label\}/);
  assert.match(toggle, /onClick=\{\(\) => setListCollapsed\(!collapsed\)\}/);
  assert.match(toggle, /\{collapsed \? <ArrowsPointingInIcon aria-hidden="true" \/> : <ArrowsPointingOutIcon aria-hidden="true" \/>\}/,
    'the glyph is the verb a press performs');
  assert.doesNotMatch(SCREEN, /SidebarIcon/, 'the rail glyph is the platform sidebar\'s toggle, not this one');
  assert.doesNotMatch(SCREEN, /ListToggle/);

  assert.match(ICONS, /export const ArrowsPointingOutIcon = stroked\('ArrowsPointingOutIcon', 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'\);/);
  assert.match(ICONS, /export const ArrowsPointingInIcon = stroked\('ArrowsPointingInIcon', 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'\);/);
});

test('a conversation, a group and #general: at the right of the header, just before ⋯', () => {
  const header = fn('ThreadHeader');
  const at = header.indexOf('<FullWidthToggle />');
  assert.ok(at > 0, 'the conversation header carries it');
  assert.equal(header.indexOf('<FullWidthToggle />', at + 1), -1, 'once');
  assert.ok(at > header.indexOf('className="min-w-0 text-left flex-1"'), 'after the title, which takes the free width');
  assert.equal(message('messages:header.groupMembers'), 'Group members');
  assert.ok(at > header.indexOf("aria-label={t('messages:header.groupMembers')}"), 'after a group\'s members disc');
  // The ⋯ is a keyboard menu button with refs of its own (QA 2026-09-24 Q18).
  assert.equal(message('messages:header.actions'), 'Conversation actions');
  assert.match(header, /<FullWidthToggle \/>\s*<div className="relative" ref=\{menuWrapRef\}>\s*<button ref=\{menuBtnRef\} type="button" onClick=\{\(\) => setMenu\(\(open\) => !open\)\}[^>]*aria-label=\{t\('messages:header\.actions'\)\}/,
    'immediately before the ⋯ menu');
  // #3407: #general's way back to its hub leads the row; the toggle does not.
  assert.match(header, /<header className="messages-thread-header">\s*\{channel \? <PageBackButton /, 'no longer leading the row');
});

test('an app\'s channel: at the end of its header, where it draws nothing — a channel is always full width', () => {
  const pane = fn('AppDiscussionThread');
  assert.equal(message('messages:discussion.subtitle.everyone'), 'Everyone building this project');
  assert.equal(message('messages:discussion.subtitle.channel', { channel: 'notes' }), '#notes · Everyone building this project');
  assert.match(pane, /t\('messages:discussion\.subtitle\.everyone'\)\}\s*<\/span>\s*<\/span>\s*<FullWidthToggle \/>\s*<\/header>/);
  // #3407: the channel's way back to its hub leads the row, then the tile.
  assert.match(pane, /<header className="messages-thread-header">\s*<PageBackButton [^\n]*\/>\s*<AppIconLink\s+slug=\{slug\}\s+name=\{name\}\s+data-icon=/, 'no longer leading the row');
  // A channel is its community's room and opens with no list beside it, so
  // the toggle for that list stands down on it.
  assert.match(fn('FullWidthToggle'),
    /if \(snap\.route\.appSlug \|\| \(snap\.active\?\.kind === 'channel' && snap\.active\.id === snap\.route\.conversationId\)\) return null;/);
});

test('a dev session: in the pane\'s bar, after "Open full view"', () => {
  const pane = fn('AgentSessionThread');
  assert.equal(message('messages:agent.session.openFull'), 'Open full view');
  assert.match(pane, /<div className="messages-session-bar">\s*<a className="messages-session-full" href=\{full\}>\{t\('messages:agent\.session\.openFull'\)\}<\/a>\s*<FullWidthToggle \/>\s*<\/div>/);
  assert.match(CSS, /\.messages-session-bar \{\s*display: flex;\s*align-items: center;\s*justify-content: flex-end;\s*gap: 12px;/);
});

test('a Mayor session: handed to its panel, drawn at the end of its bar', () => {
  assert.match(fn('MayorSessionThread'), /<AgentSessionPanel embedded headerAction=\{<FullWidthToggle \/>\} \/>/);

  // The Mayor: the session bar's `action`, after Changes, the "Open app"
  // button (#2779 follow-up), and just before the session's ⋯, as on the
  // other panes.
  assert.match(SESSION, /export function AgentSessionPanel\(\{ embedded = false, headerAction = null \}: \{ embedded\?: boolean; headerAction\?: ReactNode \}\)/);
  assert.match(SESSION, /<SessionBar session=\{snapshot\.session\} about=\{about\} embedded=\{embedded\} action=\{headerAction\} \/>/);
  assert.match(SESSION, /\{t\('agent:session\.bar\.changes', \{ count \}\)\}\s*<\/button>\s*<OpenAppButton target=\{target\} \/>\s*\{action\}\s*<SessionMenu session=\{session\} \/>/);
});

test('the list folds for an agent thread too; a reply thread still belongs to a chat', () => {
  assert.match(SCREEN, /const chatOpen = !!\(snap\.route\.conversationId \|\| snap\.route\.appSlug\);\s*const discussionOpen = chatOpen \|\| !!snap\.route\.agent;/);
  assert.match(SCREEN, /\$\{\(snap\.listCollapsed && discussionOpen\) \|\| channelOpen \? ' messages-list-collapsed' : ''\}/,
    'a toggle that does nothing on half the panes is worse than none; a channel has no list beside it');
  assert.match(SCREEN, /\$\{chatOpen && snap\.route\.threadRootId \? ' messages-has-reply-thread' : ''\}/);
});

test('app.css: a desktop control that keeps its ink, and stays under the pointer', () => {
  assert.match(CSS, /\.messages-list-toggle \{ display: none; \}\s*@media \(min-width: 768px\) \{\s*\.messages-list-toggle \{ display: inline-flex; \}/,
    'a phone shows one pane at a time already');
  assert.match(CSS, /\.messages-layout\.messages-list-collapsed > \.messages-list-pane \{ display: none; \}/);
  assert.doesNotMatch(CSS, /\.messages-list-toggle\[aria-pressed="true"\]/, 'the glyph says the state; no accent on top');
  // Between 768 and 1600px an open reply thread has already moved the list.
  assert.match(CSS, /\.messages-layout\.messages-has-reply-thread \.messages-list-toggle \{ display: none; \}/);
  // So has a Mayor session's side pane (its spec or a preview) open beside its
  // chat, from 1024px up.
  assert.match(fn('FullWidthToggle'), /const specBeside = useSidePaneBeside\('messages'\);[\s\S]*if \(specBeside\) return null;/);
  assert.match(SCREEN, /className=\{`messages-list-pane \$\{specBeside \? 'hidden' : /);
});

// #4229: a strip too narrow for a readable conversation beside the list.
// Since the sidebar of rows starts at 768px (18 Oct 2026) the list is in the
// sidebar on every desktop window, never beside the conversation, so no
// desktop width is crowded: one pane at a time is a phone's alone.
test('one pane at a time on a phone; no desktop width is too narrow for the list beside the conversation', () => {
  const STORE = read('frontend/src/features/messages/store.ts');
  assert.doesNotMatch(STORE, /LIST_BESIDE_MIN_WIDTH|measureLayout|listCrowded|sidebarRowsUp/);
  assert.doesNotMatch(SCREEN, /measureLayout|messages-list-crowded/);
  assert.doesNotMatch(CSS, /messages-list-crowded/);
  // The way back to the list, on a phone.
  assert.match(STORE, /function listAside\(\): boolean \{\s*return isMobile\(\);\s*\}/);
  assert.match(STORE, /const thread = listAside\(\) && !!\(state\.route\.conversationId \|\| state\.route\.appSlug \|\| state\.route\.agent\);/);
  assert.match(STORE, /if \(!state\.route\.open \|\| !onThread \|\| !listAside\(\)\) return false;/);
});
