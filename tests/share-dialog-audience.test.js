// The Share dialog says who the app's own address opens for (#3657) —
// frontend/src/features/dialogs/share.tsx.
//
// The link handed out is the app's own address for every audience; the
// sentence under the title is what changes. A private community or a Just
// you project opens for members only and offers "Invite people", which hands
// over to the Homeroom menu's invite pane once the dialog has gone. A public
// one opens for anyone with an account.
//
// Run with: node --test tests/share-dialog-audience.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const FILE = 'frontend/src/features/dialogs/share.tsx';
let cached = null;
const mod = () => (cached || (cached = loadTsx(FILE)));
const src = () => fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8');

test('a view-public app reads as public; everything else as members only', () => {
  const { shareAudience } = mod();
  assert.equal(shareAudience({ view_visibility: 'public', audience: 'open' }), 'public');
  assert.equal(shareAudience({ view_visibility: 'public' }), 'public');
  // A public community with invite-only building is still view-public.
  assert.equal(shareAudience({ view_visibility: 'public', collab_visibility: 'private' }), 'public');
  assert.equal(shareAudience({ view_visibility: 'private', audience: 'invited' }), 'members');
  assert.equal(shareAudience({ view_visibility: 'private', audience: 'solo' }), 'members');
  // Only the derived audience to hand: 'open' is exactly view-public.
  assert.equal(shareAudience({ audience: 'open' }), 'public');
  assert.equal(shareAudience({ audience: 'solo' }), 'members');
  // The stored column wins over a stale derived value.
  assert.equal(shareAudience({ view_visibility: 'private', audience: 'open' }), 'members');
  // Unknown never promises "anyone".
  assert.equal(shareAudience(null), 'members');
  assert.equal(shareAudience(undefined), 'members');
  assert.equal(shareAudience({}), 'members');
});

test('the copy for each audience', () => {
  const { SHARE_COPY } = mod();
  // The table holds message ids; the dialog reads them when it renders.
  assert.deepEqual({ ...SHARE_COPY }, { members: 'dialogs:share.audience.members', public: 'dialogs:share.audience.public' });
  assert.equal(message(SHARE_COPY.members), 'Only members can open it. Invite people to let them in.');
  assert.equal(message(SHARE_COPY.public), 'Anyone with a Homeroom account can open it.');
  for (const id of Object.values(SHARE_COPY)) {
    assert.doesNotMatch(message(id), /—/, 'no em dash in copy');
  }
});

test('the dialog no longer says the app decides who logs in', () => {
  const html = renderToHtml(createElement(mod().ShareDialog));
  assert.doesNotMatch(html, /outside the Homeroom platform/);
  assert.doesNotMatch(html, /Whether they need to log in is up to the app/);
  // Initial (closed) render is the members-only wording with its Invite
  // button, so the prerendered document never promises more than it should.
  assert.match(html, /Only members can open it\. Invite people to let them in\./);
  assert.match(html, /Invite people/);
  // The pinned ids are all still there.
  for (const id of ['share-modal', 'share-close', 'share-url-input', 'share-copy-btn', 'share-open-link']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});

test('Invite people waits for the dialog to go, then opens the invite pane', () => {
  const s = src();
  // The button marks the hand-off and closes; onClose (which runs once the
  // kit's exit has landed) performs it, so the menu's sheet is never asked
  // to present while this dialog is still being taken down.
  assert.match(s, /function invite\(\) \{\s*inviteNext\.current = true;\s*dialog\.close\(\);\s*\}/);
  assert.match(s, /if \(inviteNext\.current\) \{\s*inviteNext\.current = false;\s*openInvitePane\(\);/);
  // Straight onto the pane, once (tests/invite-sheet-once.test.js).
  assert.match(s, /void ctx\.openInvite\?\.\(\);/);
  // A fresh open never inherits a pending hand-off.
  assert.match(s, /onOpen: \(\) => \{\s*inviteNext\.current = false;/);
  // The Invite button only exists for the members-only audience.
  assert.match(s, /\{audience === 'members' \? \(\s*<Button/);
});

test('the link handed out is a public project’s page, else the app’s own address', () => {
  const s = src();
  // A public project's link is /app/<slug>, which previews with its name and
  // cover (tests/project-preview.test.js); any other is the app's address.
  assert.match(s, /const page = publicPageUrl\(window\.AppView\?\.appData\);/);
  assert.match(s, /window\.AppView\?\.appData\?\.url/);
  // Discover's Share hands out the same field.
  const browse = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/apps/browse.js'), 'utf8');
  assert.match(browse, /shareUrlFor\(app\) \{[\s\S]*?const raw = String\(app\.url\);/);
});
