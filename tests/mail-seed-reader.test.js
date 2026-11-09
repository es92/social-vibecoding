'use strict';

// #6533: a change's email seeds are read as text, never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readSeeds } = require('../src/services/mail/seed-reader');
const { SEEDS } = require('../src/db/email-template-seeds');
const { ACTIONS } = require('../src/services/mail/actions');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const seedsText = read('src/db/email-template-seeds.js');
const actionsText = read('src/services/mail/actions.js');

test('today\'s seeds and actions read exactly what the running platform renders them from', () => {
  const out = readSeeds(seedsText, actionsText);
  assert.deepEqual(out.unreadable, []);
  for (const layout of SEEDS.layouts) {
    assert.deepEqual(out.layouts[layout.name], { name: layout.name, html: layout.html, text: layout.text });
  }
  for (const kind of Object.keys(SEEDS.templates)) {
    for (const field of ['layout', 'subject', 'preheader', 'why', 'html', 'text']) {
      assert.equal(out.templates[kind][field], SEEDS.templates[kind][field], `${kind}.${field}`);
    }
    assert.deepEqual(out.samples[kind], ACTIONS[kind].sample, `${kind}.sample`);
  }
});

test('a call, a spread or an unknown name marks that kind unreadable, and nothing is evaluated', () => {
  const seeds = (value) => `const SEEDS = { layouts: [], templates: { x: { layout: 'L', subject: ${value}, preheader: '', why: '', html: 'b', text: 'c' } } };`;
  assert.deepEqual(readSeeds(seeds('someCall()'), 'const ACTIONS = {};').unreadable, ['x']);
  assert.deepEqual(readSeeds(seeds('{ ...other }'), 'const ACTIONS = {};').unreadable, ['x']);
  // A statement in the text is just text: nothing runs it.
  const hostile = 'const SEEDS = { layouts: [], templates: {} }; process.exit(1);';
  assert.deepEqual(readSeeds(hostile, 'const ACTIONS = {};').templates, {});
});

test('a file too large to read gives nothing rather than guessing', () => {
  const big = 'x'.repeat(500 * 1024);
  assert.deepEqual(readSeeds(big, actionsText).templates, {});
});
