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

test('the triage sends an approval-rule or visibility change to the sheet, as a person verdict that says where and who', () => {
  const bot = require('../src/services/homeroom-bot');
  const named = bot.deciderNote({
    requester: 'evan', members: 19, requesterDecides: false,
    deciders: [{ username: 'ann', role: 'creator' }, { username: 'bo', role: 'admin' }],
  });
  assert.match(named, /- A request to change how this project's changes are approved \(who says yes, how many yeses\) or who can see it is not code: @ann or @bo can change it on the project's page, under ⋯, Settings & rules, Who can see & change it, as one proposal for the group\. It is `person`, and `reason` says where and who\./);
  assert.match(bot.deciderNote({ requester: 'ann', members: 19, requesterDecides: true, role: 'creator' }), /is not code: @ann can change it on the project's page/);
  assert.match(bot.deciderNote({ requester: 'ann', members: 1, requesterDecides: true }), /is not code: its creator or admins can change it/);
  // In the note, which a look on a project with somebody to name carries: the
  // triage prompt itself has no room to spare (a triage prompt stays small).
  assert.doesNotMatch(read('src/prompts/homeroom-bot-triage.md'), /Who can see & change it/);
});

test('the DM chat and the thread replies say where those are set, and that it is not built', () => {
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, SHEET);
  assert.match(mayor, /A request to change them is not built: say where it is changed, and that its creator or admins\n {2}can do it\./);
  const voice = require('../src/services/homeroom-bot-voice').systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(voice, SHEET);
  assert.match(voice, /A request to change them is not built:\n {2}say so, and where\./);
});

test('"it already exists" says where to find it, in the words on screen', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /Say which criterion fails, in one sentence\. If it already exists, `reason` says where on screen\.\n/);
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, /When something they ask for already exists, say where they find it, in the words they see on screen: the\n {2}screen or tab and the button to tap\./);
  const voice = require('../src/services/homeroom-bot-voice').systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(voice, /When something asked for already exists,\n {2}say where people find it, in the words they see on screen/);
});
