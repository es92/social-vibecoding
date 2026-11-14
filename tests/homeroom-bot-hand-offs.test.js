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

test('#6252: a go-ahead from the person the note named is decided in the read, and not asked for again', () => {
  const bot = require('../src/services/homeroom-bot');
  assert.equal(bot.goAheadNote(null), null);
  assert.equal(bot.goAheadNote({}), null);
  const note = bot.goAheadNote({ by: 'evan' });
  assert.match(note, /^==== A GO-AHEAD FROM THEIR CHAT ====/);
  assert.match(note, /@evan, who your last note on this request named, said to go ahead in their private chat with you just now\./);
  assert.match(note, /is decided: judge the rest as usual\. Do not return `person` for it again\./);
  assert.match(note, /Database changes that are not append-only are still `person`, with `go_ahead` false; `reason` says what kind of change this is in plain words, that you do not build it yourself even with a go-ahead, and that a person has to build it \(for example with a coding agent\)\./);
  assert.match(note, /It never names the person who gave the go-ahead or anybody who said it in the third person, and never says somebody has to approve it\./);
  // #6430: the same go-ahead typed in the request's own discussion.
  const inThread = bot.goAheadNote({ by: 'evan', where: 'thread' });
  assert.match(inThread, /^==== A GO-AHEAD FROM THIS REQUEST'S DISCUSSION ====/);
  assert.match(inThread, /said to go ahead in this request's discussion just now, in reply to your last note\. Their words are below in the discussion\./);
  const decider = { requester: 'evan', members: 1, requesterDecides: true };
  const withGoAhead = bot.triagePromptFor({ seed: 'SEED', issueNumber: 13, decider, goAhead: { by: 'evan' } });
  assert.ok(withGoAhead.indexOf(note) > withGoAhead.indexOf(bot.deciderNote(decider)), 'after the decider note');
  assert.equal(bot.triagePromptFor({ seed: 'SEED', issueNumber: 13 }), bot.triagePromptFor({ seed: 'SEED', issueNumber: 13, goAhead: null }),
    'unchanged without a go-ahead, as the benchmark replays');
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
  assert.match(triage, /- `done`: true only with `person` or `empty`, when all it asks for already exists or is done; `reason` says where on screen, and its members are offered a vote to close it\./);
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, /When something they ask for already exists, say where they find it, in the words they see on screen: the\n {2}screen or tab and the button to tap\./);
  const voice = require('../src/services/homeroom-bot-voice').systemPrompt({ app: { name: 'Maps' }, place: { type: 'issue' }, tools: [] });
  assert.match(voice, /When something asked for already exists,\n {2}say where people find it, in the words they see on screen/);
});

test('#4501: a name that is not exactly the project\'s is a guess; case, spaces, punctuation and a slug\'s suffix are not', () => {
  const { guessedProject } = require('../src/services/homeroom-bot-mayor');
  const app = { name: 'Gym Tracker', slug: 'gym-tracker-9de81f' };
  assert.equal(guessedProject('Gym Trackr', app), 'Gym Trackr');
  assert.equal(guessedProject('the gym app', app), 'the gym app');
  for (const exact of ['Gym Tracker', 'gym tracker', 'GYM-TRACKER', 'gym-tracker-9de81f', 'gym-tracker', ' Gym  Tracker ']) {
    assert.equal(guessedProject(exact, app), null, exact);
  }
  assert.equal(guessedProject(undefined, app), null, 'nothing named, nothing to confirm');
  assert.equal(guessedProject('', app), null);
});

test('the DM chat passes the name as written and offers similar open requests; a thread names them too', () => {
  const mayor = require('../src/services/homeroom-bot-mayor').systemPrompt({ username: 'ann' });
  assert.match(mayor, /Pass the project's name as they wrote it \(named\): when it is not\n {2}exactly one of theirs, the card asks "Did you mean \.\.\.\?", so never say it is the closest match and carry on\./);
  assert.match(mayor, /When they answer No, another app, list the few of their projects \(my_projects\) whose names are closest and\n {2}ask which\./);
  assert.match(mayor, /When offer_request names similar open requests, say so and offer to add their words to one of\n {2}them \(comment_on_request\) instead\./);
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /const similar = await require\('\.\/request-similarity'\)\.openSimilar\(app, title, \{ github: ctx\.deps\?\.github \}\);/);
  assert.match(read('src/services/homeroom-bot-voice.js'), /const similar = await require\('\.\/request-similarity'\)\.openSimilar\(app, title, \{ github: ctx\.deps\?\.github \}\);/);
});
