'use strict';

// scripts/shots-dry-run.js takes before/after shots of declared changes on
// two local builds with a real preview agent. The run itself needs a browser
// and a model; these pin its argument contract and the contact sheet people
// judge from, which renders proposal text and so must escape it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, contactSheet } = require('../scripts/shots-dry-run');
const fixtures = require('./fixtures/visual-evidence');

test('the dry run needs a declaration and two origins, and takes exact commits only', () => {
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'http://127.0.0.1:1']), /--after is required/);
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'nope', '--after', 'http://x']), /--before must be a URL/);
  assert.throws(() => parseArgs(['--intent', 'i.json', '--before', 'http://a', '--after', 'http://b',
    '--base-sha', 'abc123']), /40-character/);
  assert.throws(() => parseArgs(['--intent', 'a', '--intent', 'b']), /repeated/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /Invalid/);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  const options = parseArgs(['--intent', 'i.json', '--before', 'http://127.0.0.1:4101/lists?x=1',
    '--after', 'http://127.0.0.1:4102', '--timeout-ms', '5']);
  assert.equal(options.before, 'http://127.0.0.1:4101');
  assert.equal(options.intentFile, path.resolve('i.json'));
  assert.equal(options.timeoutMs, 30_000, 'the budget has a floor');
  assert.deepEqual(options.playwrightMcp, ['npx', '-y', '@playwright/mcp@0.0.41']);
});

test('the contact sheet shows each change with its result and escapes proposal text', () => {
  const intent = fixtures.motionIntent();
  intent.stories[0].claim = 'Shows <img src=x onerror=alert(1)> suggestions';
  const summary = {
    readyCount: 1,
    stories: [
      { id: 'invite-suggestions', status: 'skipped', reason: 'Needs <b>data</b>' },
      { id: 'saved-toast', status: 'ready', files: 4 },
    ],
  };
  const files = new Map([
    ['saved-toast|desktop|base|context', 'saved-toast-desktop-before-screen.png'],
    ['saved-toast|desktop|head|context', 'saved-toast-desktop-after-screen.png'],
    ['saved-toast|desktop|base|animation', 'saved-toast-desktop-before-clip.webm'],
    ['saved-toast|desktop|head|animation', 'saved-toast-desktop-after-clip.webm'],
  ]);
  const html = contactSheet(intent, summary, files, {
    before: 'http://127.0.0.1:4101', after: 'http://127.0.0.1:4102',
    agentOutcome: 'finished', agentMs: 61_000, finalText: '<script>x</script>', toolCounts: {},
  });
  assert.ok(!html.includes('<img src=x'), 'a claim is text, never markup');
  assert.ok(!html.includes('<script>x'), 'the agent’s words are text too');
  assert.match(html, /Needs &lt;b&gt;data&lt;\/b&gt;/);
  assert.match(html, /<b class="skipped">skipped<\/b>/);
  assert.match(html, /<b class="ready">ready<\/b>/);
  assert.match(html, /<video src="shots\/saved-toast-desktop-before-clip\.webm" controls muted playsinline>/);
  assert.match(html, /<img src="shots\/saved-toast-desktop-after-screen\.png" alt="After · screen">/);
  assert.match(html, /1 of 2 ready · agent finished in 61 s/);
});
