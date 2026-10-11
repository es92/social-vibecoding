'use strict';

// Where the bot sends what it cannot build. A request to change how a
// project's changes are approved, or who can see it, is not code: its
// creator or admins set it in the Who can see & change it sheet (#4666), so
// the triage, the DM chat and the thread replies say where, instead of
// leaving it "for the group" (Homeroom Maps #30, read five times to the same
// answer). And something that already exists is answered with where to
// find it, not only that it exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SHEET = /⋯,\s+Settings & rules,\s+Who can see & change it/;

test('the triage sends an approval-rule or visibility change to the sheet, as a person verdict that says where', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /A request to change how this project's changes are approved \(who says yes, how many yeses, an owner's say\) or who can see it is not a code change: the project's creator or admins set it on the project's page, under ⋯, Settings & rules, Who can see & change it, and what they pick goes to the group as one proposal\. It is `person`, and `reason` says where it is changed and who can do it \(by name, when a WHO DECIDES note names them\)\./);
  assert.ok(triage.indexOf('Who can see & change it') > triage.indexOf('4. `person`'), 'under the person verdict');
  assert.ok(triage.indexOf('Who can see & change it') < triage.indexOf('Also state, whatever the verdict:'));
});

test('the DM chat and the thread replies say where those are set, and that it is not built', () => {
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, SHEET);
  assert.match(mayor, /A request to change them is not built: say where it is changed, and that its creator or admins\n {2}can do it\./);
  const voice = require('../src/services/homeroom-bot-voice').systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(voice, SHEET);
  assert.match(voice, /A request to change them is not built:\n {2}say so, and where\./);
});

test('"it already exists" says where to find it, in the words on screen, never a file name', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /- When something the request asks for already exists in the app, say where a person finds it, in the words they see on screen: the screen or tab, and the button or label to tap \(for example "open Profile, then Your votes"\), never a file name\./);
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, /When something they ask for already exists, say where they find it, in the words they see on screen: the\n {2}screen or tab and the button to tap\./);
  const voice = require('../src/services/homeroom-bot-voice').systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(voice, /When something asked for already exists,\n {2}say where people find it, in the words they see on screen/);
});
