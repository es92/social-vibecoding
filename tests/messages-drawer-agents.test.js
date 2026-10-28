'use strict';

// AGENT CHATS AND AGENT SESSIONS ON THE PHONE'S MESSAGES DRAWER (Evan, 18 Oct
// 2026).
//
// On a phone an agent chat and an agent session used to open on screens of
// their own (`#chat/<id>`, `#agent/<id>`), with no list beside them, so the
// drawer's swipe back had nothing to go back to. Now they are its second
// level, as a conversation is: the header names them in the words their own
// pane uses, the pane leaves its copy of that name out, and the list shows
// nothing peeking after one (it has no picture of an agent's pane to show).
// A dev session still opens on its project's page. The router's half is in
// tests/messages-agent-pane.test.js, the drawer's rule in nav-drawer.test.js.
//
// Run with: node --test tests/messages-drawer-agents.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('an agent thread is the second level, named by the screen, and leaves nothing peeking', () => {
  const drawer = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(drawer, /const level: 0 \| 1 = route\.conversationId \|\| route\.agent \? 1 : 0;/);
  assert.match(drawer, /const agentOpen = on && level === 1 && !!route\.agent;/);
  assert.match(drawer, /if \(agentOpen\) setPeek\(null\);/, 'the last thing open was an agent: nothing peeks');
  assert.match(drawer, /const words = agentOpen \? \(agentWords \|\| \{ title: '', sub: '' \}\) : named \? names\(named\)/);
});

test('the header says what the agent\'s own pane says', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  const words = index.slice(index.indexOf('export function agentThreadWords('), index.indexOf('function useAgentThreadWords('));
  // An agent session: its bar's heading and kind line (agent-session/index.tsx SessionBar).
  assert.match(words, /title: seen\.title \|\| translate\('agent:session\.bar\.newSession'\)/);
  assert.match(words, /sub: seen\.app \? translate\('agent:session\.bar\.kindStartedFrom', \{ app: seen\.app \}\) : translate\('agent:session\.bar\.kind'\)/);
  const bar = read('frontend/src/features/agent-session/index.tsx');
  assert.match(bar, /\{session\?\.title \|\| t\('agent:session\.bar\.newSession'\)\}/, 'the same heading as the bar');
  assert.match(bar, /t\('agent:session\.bar\.kindStartedFrom', \{ app: about\.focusApp\.name \}\)/, 'the same kind line');
  // Read from the store the pane draws from, for the thread the route names.
  const hook = index.slice(index.indexOf('function useAgentThreadWords('), index.indexOf('function ThreadHeader('));
  assert.match(hook, /sessionId === 'new' \? current\.id === null : current\.id === sessionId/);
  assert.match(hook, /if \(!agent \|\| agent\.kind === 'session'\) return null;/);
});

test('on the drawer an agent session\'s pane leaves its own name to the header', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\.messages-drawer \[data-agent-session-bar\] > div:first-child:not\(\[data-agent-session-pills\]\) \{ display: none; \}/);
  // Only under 768px: the rule sits in the drawer's phone block.
  const block = css.slice(css.indexOf('/* ── MESSAGES ON THE SAME DRAWER'));
  const phone = block.slice(block.indexOf('@media (max-width: 767.98px) {'));
  assert.ok(phone.indexOf('[data-agent-session-bar] > div:first-child') > 0);
  assert.ok(phone.indexOf('[data-agent-session-bar] > div:first-child') < phone.indexOf('\n}\n'), 'inside the phone block');
});
