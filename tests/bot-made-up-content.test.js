'use strict';

// B10 and B22 (overnight audit, 1 Nov 2026): what the bot makes up.
//   B10: a plan's fifth line was "Fake demo people so the week looks
//   filled", and its preview printed them as "staging-demo-priya".
//   B22: a drawn first screen dated its week in June, in November.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('B10: a plan has no line about the made-up rows its preview is filled with', () => {
  const triage = read('src/prompts/homeroom-bot-triage.md');
  assert.match(triage, /No file names, code, tests, catalogs or other build steps: those belong in `build_note`\. Nor the made-up rows or people its preview is filled with to try it: that is how the build shows it, not something people will see or do, and never a line of its own\./);
});

test('B10: a seeded person is printed by a plain made-up name, never an id-shaped handle', () => {
  const conventions = read('src/prompts/app-conventions.md').replace(/\s+/g, ' ');
  assert.match(conventions, /\*\*Made-up people read as people\.\*\* Where the screen prints a seeded person's name, it prints a plain made-up name \("Priya", "Sam"\), never an id-shaped handle such as `staging-demo-priya`/);
});

test('B22: the drawing is told today and the weekdays\' dates around it', () => {
  const designBot = require('../src/services/design-bot');
  const prompt = designBot.designPrompt({ username: 'ada', surface: 'new', now: new Date('2026-11-02T10:00:00Z') });
  assert.match(prompt, /- Any date on the screen is a real one around today, Monday 2 November 2026 \(2026-11-02\), UTC, read off this calendar, never\n  made up from another month:\n  November 2026: Mondays 2, 9, 16, 23, 30;/);
  assert.match(prompt, /\n  December 2026: Mondays 7, 14, 21, 28;/);
  assert.doesNotMatch(prompt, /—/, 'no em dash');
});

// B10 follow-up (decided 2 Nov 2026): the label people read on preview data
// is "Sample data"; "staging" names Homeroom's environment, not anything on
// their screen. Homeroom's own demo fixtures and id-shaped slugs
// (staging-demo-user) are not labels and keep their names.
test('B10: builds are told to label preview data "Sample data", never "Staging demo"', () => {
  const sources = [
    'src/prompts/app-conventions.md', 'src/services/prompts.js',
    'src/services/homeroom-bot-live.js', 'src/services/first-version-early-look.js',
  ].map(read);
  for (const text of sources) assert.doesNotMatch(text, /Staging demo/);
  const conventions = sources[0].replace(/\s+/g, ' ');
  assert.match(conventions, /The screen says "Sample data" once, plainly and visibly/);
  assert.match(conventions, /The people trying a preview never see the word "staging": it names Homeroom's environment, not anything on their screen\./);
  assert.match(conventions, /`staging-demo-user`/, 'an id-shaped slug keeps its name');
});
