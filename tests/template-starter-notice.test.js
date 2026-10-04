// The scaffolded app must announce itself as a starter template (#1373).
//
// A freshly created app used to deploy as a bare "Press!" demo that looked
// like the finished product — nothing on screen said it was placeholder
// content or that tapping Improve is how you build the real app. The
// scaffold now ships a template welcome screen: a "Starter template" hero,
// a "What's already working" explainer, and the demo reframed as a
// clearly-labelled example card — plus a repo README and a CLAUDE.md
// instruction so the coding agent removes the template wholesale when the
// first real feature is built.
//
// The template messaging is wrapped in sentinel comments
// (usernode-starter-notice@1), following the usernode-dev-console@1
// precedent, so agents/tooling can locate and excise the block.
//
// Run with: node --test tests/template-starter-notice.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');

function files() {
  return getTemplateFiles('My App', 'my-app-123', 'pg://x');
}

function file(list, p) {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
}

test('index.html carries the starter-notice sentinel block before the example card', () => {
  const html = file(files(), 'public/index.html');

  const open = html.indexOf('<!-- usernode-starter-notice@1');
  const close = html.indexOf('<!-- /usernode-starter-notice@1 -->');
  assert.ok(open !== -1, 'opening sentinel comment present');
  assert.ok(close !== -1, 'closing sentinel comment present');
  assert.ok(open < close, 'sentinels are ordered open → close');

  // Exactly one block: the sentinel name appears once per comment.
  const occurrences = html.match(/usernode-starter-notice@1/g) || [];
  assert.equal(occurrences.length, 2, 'exactly one sentinel pair');

  // The template messaging lives inside the block…
  const block = html.slice(open, close);
  assert.match(block, /Starter template/, 'hero badge names the starter template');
  // #3573: it named the Improve pill, which #2718 retired. It names the
  // Homeroom mark's menu and its row now, by the row's own label.
  // B8: changing it is asking Homeroom bot, through the menu's Ask for a change.
  assert.match(block, /To change this app, ask Homeroom bot: tap the <strong[^>]*>Homeroom icon<\/strong>, then <strong[^>]*>Ask for a change<\/strong>\./,
    'hero copy names the Homeroom icon and its Ask for a change button');
  assert.doesNotMatch(block, /Improve/, 'no Improve button to point at any more');
  assert.match(block, /What's already working/, 'explainer card inside the sentinel block');
  // #1418: the welcome copy is product-focused — it describes the outcome,
  // never the AI that produces it.
  assert.ok(!block.includes('Claude'), 'welcome copy does not name Claude');

  // …and precedes the labelled example card.
  const example = html.indexOf('Try the example');
  assert.ok(example !== -1, 'example card is labelled');
  assert.ok(close < example, 'sentinel block precedes the example card');
  assert.match(html, /This example will be replaced/,
    'example card carries the will-be-replaced tag');
});

test('the demo contract survives the redesign', () => {
  const html = file(files(), 'public/index.html');

  // The inline script looks these up by id; each must exist exactly once.
  for (const id of ['press-btn', 'count', 'leaderboard']) {
    const matches = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.equal(matches.length, 1, `exactly one element with id="${id}"`);
  }
  assert.ok(html.includes("document.getElementById('press-btn')"),
    'the demo script still wires the press button');
  assert.match(html, /Leaderboard/, 'the leaderboard heading survives');
});

test('the scaffold ships a README that names the app and the template state', () => {
  const readme = file(files(), 'README.md');
  assert.match(readme, /^# My App/m, 'README titled with the app name');
  assert.match(readme, /Starter template/, 'README states this is the starter template');
  // #3573: Start a new change in the Homeroom mark's menu, not the retired
  // Improve pill (#2718).
  assert.match(readme, /To change this app, ask Homeroom bot: open the app on Homeroom, tap the\nHomeroom icon in the header, then \*\*Ask for a change\*\*, and describe the\napp you want/,
    'README says asking Homeroom bot is how to replace it');
  assert.doesNotMatch(readme, /Improve/);
  assert.match(readme, /rewrite this README/i,
    'README instructs its own rewrite once the real app exists');
  // #1418: the product promise never names Claude as the actor. "Claude Code"
  // (the developer tool) and the CLAUDE.md filename are the only sanctioned
  // mentions, so a bare "Claude" not followed by " Code" is a regression.
  assert.ok(!/Claude(?! Code)/.test(readme),
    'README mentions Claude only as the "Claude Code" tool name');
});

// #3573: the starter page and README send a new app's creator to a control
// by name, so the names are the platform's own. If the row or the mark is
// renamed, the template's copy has to follow it (new repos only; existing
// apps keep the copy they were scaffolded with).
test('the starter copy names the row the Homeroom mark\'s menu really has', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  // B8: the menu leads with Ask for a change; making it yourself is its own row.
  assert.match(read('frontend/src/features/improve/actions.tsx'), /id="improve-row-feedback"\s+label="Ask for a change"/,
    'the menu still has Ask for a change');
  assert.match(sheet, /id="improve-row-new-session"[\s\S]{0,600}label="Build it yourself"/,
    'and the agent-session row is called Build it yourself');
  assert.match(read('frontend/src/features/header/platform-mark.tsx'), /aria-label="Homeroom menu"/,
    'the header control is still the Homeroom mark');
});

test('CLAUDE.md instructs the agent to remove the template wholesale', () => {
  const claude = file(files(), 'CLAUDE.md');
  assert.match(claude, /usernode-starter-notice@1/, 'names the sentinel');
  assert.match(claude, /REPLACE the template/i, 'instructs replacement, not accretion');
  assert.match(claude, /usernode-dev-console@1/,
    'reminds the agent to keep the dev-console forwarder');
});
