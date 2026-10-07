'use strict';

// "Ask for a change" is "Suggest an improvement" (first-session run-through,
// 5 Oct 2026): the platform's front door for filing a request, in the words a
// first-time user would use. Evan: "Rename 'Ask for a Change' to 'Suggest an
// Improvement'".
//
// Pinned here:
//   - no user-facing string anywhere in the shell, the legacy modules, the
//     server or the app templates still says "ask for a change" (comments may,
//     where they record what a control used to be called);
//   - each door says the new words: the Homeroom menu's button, the dialog's
//     heading, the hub's ⋯ row, Your requests' button, the tour's step, the
//     bot's hello to a joiner, the Messages new-chat hint, and the starter
//     page and README of a new app;
//   - "Ask for changes" on a change Homeroom bot built is a different action
//     (it revises a change that is already built), and keeps its words.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OLD = /ask for a change\b/i;

// Comments out, strings and markup in. Line comments are taken only where
// `//` is not part of a URL (`https://`), so a link in a string survives.
function withoutComments(src, ext) {
  if (ext === '.html' || ext === '.md') return src.replace(/<!--[\s\S]*?-->/g, '');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(js|mjs|cjs|ts|tsx|html|md)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('no user-facing copy says "Ask for a change" any more', () => {
  const offenders = [];
  // (app-templates/ went with the four starters; read it if one comes back.)
  for (const dir of ['frontend/src', 'public/js', 'src', 'app-templates']) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const rel of walk(dir)) {
      const code = withoutComments(read(rel), path.extname(rel));
      code.split('\n').forEach((line, i) => {
        if (OLD.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'rename these to "Suggest an improvement" (or "suggest an improvement" in a sentence)');
});

test('every door to filing a request says Suggest an improvement', () => {
  assert.match(read('frontend/src/features/improve/actions.tsx'),
    /id="improve-row-feedback"\s+label="Suggest an improvement"/, 'the Homeroom menu\'s one button');
  assert.match(read('frontend/src/features/dialogs/feedback.tsx'),
    /<h2 className="text-lg font-bold">\s*Suggest an improvement\s*<\/h2>/, 'the dialog it opens, from every way in');
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'),
    /Reopen Suggest an improvement to finish it\./, 'the rescued-draft toast names it');
  const row = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(row, /data-plus="issue"[\s\S]{0,200}title="Suggest an improvement"/, 'the hub\'s ⋯ leads with it');
  assert.match(row, /'Suggest an improvement, import a PR or manage this app'/, 'and the ⋯ says so to a screen reader');
  const mine = read('frontend/src/features/profile/my-proposals.tsx');
  assert.match(mine, /data-profile-work-ask=""[\s\S]{0,200}>\s*Suggest an improvement\s*<\/Button>/, 'Your requests ends on it');
  assert.match(mine, /requests: 'You have not suggested an improvement yet\.'/, 'and says so when it is empty');
  assert.match(read('frontend/src/features/home/tour/tour-steps.ts'),
    /id: 'menu-actions',\s*title: 'Suggest an improvement',/, 'the tour names the button by its words');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /hint: 'Make an app or suggest an improvement'/, 'Messages\' new-chat menu');
  assert.match(read('frontend/src/features/dev-board/workshop/hub-cards.tsx'),
    /\{' to suggest an improvement\.'\}/, 'the hub\'s Your work, with nothing in progress');
  assert.match(read('src/services/homeroom-bot-dm.js'),
    /tell me here or tap Suggest an improvement on its page\./, 'the bot\'s hello to somebody who joined');
});

test('a new app\'s starter page and README send its maker to Suggest an improvement', () => {
  const template = read('src/services/template.js');
  assert.match(template, /then <strong class="font-semibold text-fg">Suggest an improvement<\/strong>\./);
  assert.equal(template.split('then **Suggest an improvement**, and describe').length - 1, 2, 'both READMEs');
  // The four starters' own pages said the same; they were deleted with the
  // create dialog (tests/app-templates.test.js).
});

test('Ask for changes on a built change is a different action, and keeps its words', () => {
  // It revises a change Homeroom bot already built (the viewer's chat with
  // the change attached), where Suggest an improvement files a new request.
  assert.match(read('public/js/app-view.js'), /key: 'ask-bot', cls: 'gc-vote-btn', label: 'Ask for changes',/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /open it below and tap Ask for changes\./);
});
