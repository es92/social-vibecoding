'use strict';

// The Me tab's "More" list: the navigation prototype's three rows —
// Challenges & standings, Kudos, Settings — each with a line under it that
// says what is behind it (`scrMe` in the prototype).
//
// #2718 made Challenges, Settings and the Admin console rows of the Profile
// screen, with the native node / wallet / staking readouts and Log out under
// them. The prototype's Me keeps three rows and puts the rest inside
// Settings (the spec's "Me, with Admin and Validator inside Settings"), so
// this pins the new shape and the four things that can go wrong on the way:
//
//   1. a destination reachable from nowhere, because a row left Me before its
//      new home existed (Admin and the native rows: tests/admin-console-entry-
//      row.test.js and tests/app-menu-wallet-validator.test.js pin Settings);
//   2. a button where an anchor belongs, which silently costs cmd-click,
//      middle-click, the context menu and drag-to-bookmark;
//   3. a row whose line claims something the data did not say;
//   4. Settings' line naming the admin console to an account without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const PANEL = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/profile/account-panel.tsx'), 'utf8');
// The code alone: the header explains where each moved row went, by name.
const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** One `<ListRow … />` element's source, from its opening tag to the next. */
function rowSource(src, id) {
  const at = src.indexOf(`id="${id}"`);
  const start = src.lastIndexOf('<ListRow', at);
  const next = src.indexOf('<ListRow', at);
  const end = next === -1 ? src.indexOf('</GroupedList>', at) : next;
  return src.slice(start, end);
}

const ROWS = [
  ['profile-row-challenges', '#leaderboard/challenges'],
  ['profile-row-kudos', '#leaderboard/kudos'],
  // #3186: the card over Me, by the address Profile.open() honours.
  ['profile-row-feedback', '#profile?feedback'],
  ['profile-row-settings', '#settings'],
];

test('the rows are anchors to their destinations', () => {
  for (const [id, href] of ROWS) {
    assert.ok(CODE.indexOf(`id="${id}"`) > 0, `#${id} must be a row of Me's "More" list`);
    const row = rowSource(CODE, id);
    assert.match(row, /as="a"/,
      `#${id} must be an anchor — cmd-click, middle-click, the context menu `
      + 'and drag-to-bookmark are the browser\'s to give, and only an anchor '
      + 'with an href gets them');
    assert.ok(row.includes(`href="${href}"`), `#${id} points at ${href}`);
    assert.match(row, /subtitle=/, `#${id} carries the line that says what is behind it`);
  }
});

test('in the prototype\'s order: Challenges & standings, Kudos, Your feedback, Settings', () => {
  const order = ROWS.map(([id]) => CODE.indexOf(`id="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the rows that moved to Settings are not on Me any more', () => {
  for (const gone of ['profile-row-admin', '<NodePillRow', '<WalletRow', '<StakingRow', 'Log out']) {
    assert.ok(!CODE.includes(gone), `${gone} lives in Settings now`);
  }
});

test('it renders the data\'s lines, and quiet fallbacks without them', () => {
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.MorePanel, {
    rows: { challenges: 'Season 3 · rank #3 · 2 of 7 done', kudos: '3 received' },
  }));
  assert.match(html, /id="profile-more"/);
  assert.match(html, /Challenges &amp; standings/);
  assert.match(html, /Season 3 · rank #3 · 2 of 7 done/);
  assert.match(html, /3 received/);
  const bare = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null } }));
  assert.match(bare, /This season’s challenges and standings/, 'no data, no invented rank');
  assert.match(bare, /Kudos on your proposals/, 'and no invented count');
});

test('Settings\' line names the console only for the capability', () => {
  // Read from the same published flag App.renderAdminButton writes — the
  // Admin row itself is in Settings now, and this line only describes it.
  assert.match(PANEL, /useVisibility\('switcher-row-admin', false\)/);
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null } }));
  assert.match(html, /Account, alerts, keys</, 'nothing published: no admin, no wallet');
  assert.doesNotMatch(html, /alerts, keys, (wallet, )?admin/);
});
