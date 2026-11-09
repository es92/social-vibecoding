'use strict';

// #6533: showing a change is offered in its thread, and its two offers say
// what they do.

const test = require('node:test');
const assert = require('node:assert/strict');

const voice = require('../src/services/homeroom-bot-voice');

const names = (place, flags) => voice.toolsFor(place, flags).map((tool) => tool.function.name);

test('show_change is offered in a change\'s thread, whichever change it is', () => {
  for (const flags of [{ ownChange: true }, { ownChange: false, otherChange: true }]) {
    const offered = names({ type: 'session', ref: 77 }, flags);
    assert.ok(offered.includes('show_change'));
    assert.ok(offered.includes('list_change_files'));
  }
  assert.ok(names({ type: 'issue', ref: 6490 }, { requestChange: true }).includes('show_change'));
});

test('the shots offer and the plan offer say what they do', () => {
  assert.equal(voice.offerActions('run_shots', 5)[0].label, 'Take the shots');
  assert.equal(voice.offerActions('run_shots', 5)[1].label, 'Not now');
  const plan = voice.offerActions('post_pictures_plan', 5, { issueNumber: 6490 });
  assert.equal(plan[0].label, 'Post as a plan on request #6490');
  assert.equal(plan[1].label, 'Not now');
});
