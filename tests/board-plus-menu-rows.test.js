// The board's "+" menu is shaped like the app chip's menu (#1615).
//
// Two lists of destinations hang off the same header, and they were drawn as
// two different kinds of object: the chip's menu is a leading glyph, `gap-3`,
// `px-5` and a 44px row; the "+" menu was a bare title-over-subtitle block
// with `px-3` and no glyph at all.
//
// What this change deliberately does NOT copy is the chip menu's single-line
// row. Every action here has a subtitle that says what it does ("Renames are
// proposals, applied once voted in"), and those lines are why the menu is
// legible; dropping them to match a shape would be a worse menu.
//
// The load-bearing detail is the touch path. `AppView._wirePlusMenu` builds a
// native action sheet from these rows and used to read
// `node.querySelector('span')` for each label — the title only by accident of
// source order. This layout needs a wrapper around the text column, so the
// title is marked `data-plus-title` and the sheet reads that.
//
// Run with: node --test tests/board-plus-menu-rows.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const FRAME = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dev-board/actions-row.tsx'), 'utf8');
const APP_VIEW = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
const CHIP_SHEET = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/app-context/app-context-sheet.tsx'), 'utf8');

test('the row shell borrows the chip menu’s geometry', () => {
  const shell = FRAME.match(/const PLUS_ROW_CLS =[\s\S]*?';/)[0];
  for (const cls of ['flex items-start gap-3', 'px-5', 'min-h-[44px]', 'hover:bg-zinc-50']) {
    assert.ok(shell.includes(cls), `row shell carries ${cls}`);
  }
  // The chip's menu is where those values come from, so they must still be
  // there to have been copied FROM.
  const chipRow = CHIP_SHEET.match(/const ROW = [\s\S]*?';/)[0];
  assert.ok(chipRow.includes('gap-3'));
  assert.ok(chipRow.includes('px-5'));
  assert.ok(chipRow.includes('min-h-[44px]'));
});

test('every action row has a glyph, and every glyph is decoration', () => {
  const menu = FRAME.slice(FRAME.indexOf('id="dev-plus-menu"'));
  const rows = menu.match(/<PlusRow\b/g) || [];
  // Twelve calls for eleven rows: the members row is written as two, one per
  // label pair, because tests/dev-plus-menu.test.js reads the two branches
  // separately to prove the self-hosted wording never leaks into the other.
  // "Make it private" (a public community's, on the hub) left the hero for
  // this menu in the UI overhaul's follow-up, and "Start a new change" left
  // the foot of the hub for its top (#852 review). "Suggest to <original>"
  // is a version owner's (./suggest-back-dialog.tsx), and "Updates from
  // <original>" any version's (docs/plans/versions.md). #4045: "Make it
  // public" and Leave left the hero's row for it too (Leave was the Joined
  // pill). #4045: "Settings & rules" is a row too, the one that opens the
  // settings, and Make your own is written twice: last in the settings sheet,
  // and alone on the
  // menu of a read-only viewer, who has no settings. #4405: Custom domain,
  // under App settings, for whoever manages the project. #4417: Topics,
  // after the display name, the other change that is a proposal to dapp.json.
  // #4666: "Make it public" and "Make it private" became one row, "Who can
  // see & change it", which opens the sheet that sets both who can see it and
  // how its changes are approved. 18 Oct 2026: Pin to sidebar, a member's,
  // after "Import a pull request". One Home (#6361): the two Home pins, the
  // app's and the community's, before it. 11 Nov 2026: See what visitors
  // see, first, on a public project's hub.
  assert.equal(rows.length, 22,
    'visitor-view, new-change, issue, import-pr, home-app, home-community, pin, settings, who-decides, leave, app-settings, domain, featured-illustration, members x2, rename, topics, secrets, updates, suggest-back, fork x2');
  const icons = menu.match(/icon=\{<([A-Za-z]+Icon) className=\{PLUS_ICON_CLS\} aria-hidden="true" \/>\}/g) || [];
  assert.equal(icons.length, rows.length, 'one glyph per row, all aria-hidden');
  // No <button data-plus> survives outside the shared shell — a hand-written
  // row would miss both the glyph column and the title marker.
  assert.doesNotMatch(menu, /<button\s+data-plus=/);
});

test('the subtitles survive: this is not the chip menu’s one-line row', () => {
  const menu = FRAME.slice(FRAME.indexOf('id="dev-plus-menu"'));
  // Each subtitle is a catalog entry now: the row wires its id, and the
  // English catalog holds the words.
  assert.match(menu, /data-plus="rename"[\s\S]{0,160}sub=\{t\('project:menu\.rename\.sub'\)\}/);
  assert.equal(message('project:menu.rename.sub'), 'Renames are proposals, applied once voted in');
  assert.match(menu, /data-plus="issue"[\s\S]{0,240}sub=\{t\('project:menu\.suggest\.sub'\)\}/);
  assert.equal(message('project:menu.suggest.sub'), 'Report a problem or idea without building it yourself');
  assert.match(menu, /data-plus="import-pr"[\s\S]{0,240}sub=\{t\('project:menu\.importPr\.sub'\)\}/);
  assert.match(message('project:menu.importPr.sub'), /^Your computer · your own tools\. You have already built it/);
  assert.match(menu, /title=\{t\('project:menu\.remix\.title'\)\}\s+sub=\{t\('project:menu\.remix\.sub'\)\}/);
  assert.deepEqual([message('project:menu.remix.title'), message('project:menu.remix.sub')], ['Make your own', 'Your own version to change']);
  assert.match(FRAME, /const PLUS_SUB_CLS = 'block text-xs/);
});

test('App settings is an access surface for app managers, not only deleters (#2304)', () => {
  const settings = FRAME.slice(FRAME.indexOf('data-plus="app-settings"') - 300);
  assert.match(settings.slice(0, 700), /appData\?\.can_manage && !selfHosted/);
  assert.match(settings.slice(0, 900), /sub=\{t\('project:menu\.appSettings\.sub'\)\}/);
  assert.equal(message('project:menu.appSettings.sub'), 'Manage who can use and build this app');
  assert.match(FRAME, /title=\{t\('project:menu\.members\.title'\)\}/);
  assert.equal(message('project:menu.members.title'), 'Members & approvals');
  assert.doesNotMatch(FRAME, /title="Members &amp; visibility"/);
});

test('the touch action sheet reads the title by name, not by position', () => {
  // The regression this prevents: a glyph or a wrapper arriving before the
  // title would have labelled every sheet row with the wrong text, or ''.
  assert.match(FRAME, /data-plus-title/);
  assert.match(APP_VIEW, /node\.querySelector\('\[data-plus-title\]'\)/);
  // The old positional lookup stays as a fallback, so a row that has not been
  // marked yet still gets a label rather than none.
  const sheet = APP_VIEW.slice(APP_VIEW.indexOf("querySelector('[data-plus-title]')"));
  assert.match(sheet.slice(0, 400), /\|\|\s*node\.querySelector\('span'\)/);
});

test('the touch action sheet carries each row\u2019s glyph, as the desktop menu does (#1930)', () => {
  const fn = APP_VIEW.slice(APP_VIEW.indexOf('  _wirePlusMenu(content) {'));
  const touch = fn.slice(0, fn.indexOf('PlatformUI.actionSheet(') + 3000);
  // Every action row in the frame leads with an icon; the sheet takes it.
  assert.match(FRAME, /icon=\{<[A-Za-z]+Icon className=\{PLUS_ICON_CLS\}/);
  // A clone, because the kit adopts iconEl into the sheet and the original
  // lives in the hidden desktop menu — stripped of its Tailwind sizing, which
  // would otherwise outrank the kit's own row-icon size.
  assert.match(touch, /const glyph = node\.querySelector\('svg'\)\?\.cloneNode\(true\);/);
  assert.match(touch, /if \(glyph\) glyph\.removeAttribute\('class'\);/);
  assert.match(touch, /iconEl: glyph \|\| undefined,/);
});

test('the secrets row keeps its legacy-owned state leaf inside the title', () => {
  // AppView.refreshDevChatSecretsState writes #dc-secrets-state, so it must
  // stay a node React renders empty and never writes again — and it must stay
  // INSIDE the marked title, or the sheet label would drop the count.
  const secrets = FRAME.slice(FRAME.indexOf('data-plus="secrets"'));
  const row = secrets.slice(0, secrets.indexOf('dividerCls'));
  assert.match(row, /data-plus-title/);
  assert.match(row, /id="dc-secrets-state"/);
  assert.ok(row.indexOf('data-plus-title') < row.indexOf('id="dc-secrets-state"'));
});

// ── See what visitors see (the hand-off of 11 Nov 2026) ──────────────────

test('See what visitors see leads the menu on a member\'s public project, plain, and opens the visitor\'s page over the hub', () => {
  const menu = FRAME.slice(FRAME.indexOf('id="dev-plus-menu"'));
  assert.ok(menu.indexOf('data-plus="visitor-view"') > 0, 'the row is there');
  assert.ok(menu.indexOf('data-plus="visitor-view"') < menu.indexOf('data-plus="issue"'), 'first, ahead of Suggest an improvement');
  const row = menu.slice(menu.indexOf('{visitorView ? ('), menu.indexOf('data-plus="issue"'));
  assert.match(row, /<PlusRow\s+data-plus="visitor-view"\s+icon=\{<EyeIcon className=\{PLUS_ICON_CLS\} aria-hidden="true" \/>\}/);
  assert.doesNotMatch(row, /^\s+lit$/m, 'plain: Suggest an improvement stays the one lit row');
  assert.match(row, /onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); setVisiting\(true\); \}\}/);
  // With it above, Suggest an improvement takes the divider.
  assert.match(menu, /data-plus="issue"\s+lit[\s\S]*?dividerCls=\{visitorView \? PLUS_ROW_DIVIDER_CLS : ''\}/);
  // The page, portalled like the menu's other sheets.
  assert.match(FRAME, /\{visiting && visitorView \? createPortal\(<VisitorView key=\{visitorView\.slug\} slug=\{visitorView\.slug\} onClose=\{\(\) => setVisiting\(false\)\} \/>, document\.body\) : null\}/);
  // A member's, on a public project: a private one has no page for
  // visitors, and the platform's own is not in the public directory.
  const workshop = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
  assert.match(workshop, /visitorView=\{!actions\.selfHosted && community\?\.is_member && community\.audience === 'open' \? \{ slug \} : null\}/);
  assert.equal(message('project:menu.visitorView.title'), 'See what visitors see');
  assert.equal(message('project:menu.visitorView.sub'), "The page before joining: the preview, the featured illustration and what's up for a vote");
});
