'use strict';

// App templates (#3521): a new project starts from Empty, the scaffold every
// project always got. The four starters (social productivity, multimedia
// social, a 2D game and a 3D game) were deleted with the create dialog that
// offered them: Create opens "What do you want to make?", which describes a
// project for Homeroom bot to build or imports a GitHub repo
// (tests/create-front-door.test.js).
//
// What is pinned here, without a database:
//
//   1. THE ALLOW-LIST. POST /api/apps takes `template` from
//      services/app-templates.js's TEMPLATE_IDS and nothing else, which is
//      `empty` alone now; absent is `empty`; a deleted starter's id is
//      refused, not swapped.
//   2. EMPTY IS THE DEFAULT. Absent and `empty` write exactly the same
//      files (#4047 dropped the scaffold's Press! demo, so "always got" is
//      the static welcome screen, not the old one).
//   3. A ROW FROM A DELETED STARTER RETRIES AS EMPTY: app-creator reads an
//      id no longer on the list as the default, and the directory the
//      starters lived in is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appTemplates = require('../src/services/app-templates');
const { parseCreateOptions } = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');

const ROOT = path.join(__dirname, '..');
const DELETED = ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];

const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

test('the allow-list: Empty alone, the default; a deleted starter is refused', () => {
  assert.deepEqual([...appTemplates.TEMPLATE_IDS], ['empty']);
  assert.equal(appTemplates.DEFAULT_TEMPLATE, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo' }).template, 'empty', 'absent is Empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: '' }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: null }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'open', template: 'empty' }).template, 'empty');
  for (const bad of [...DELETED, 'chess', 'EMPTY', '../game-2d', 'toString', '__proto__', 42, ['game-2d'], { id: 'game-2d' }]) {
    assert.match(parseCreateOptions({ audience: 'solo', template: bad }).error, /^template must be one of: empty$/, String(bad));
  }
  for (const id of DELETED) assert.equal(appTemplates.get(id), null, id);
  // An import keeps its repository; Empty (or nothing) is still fine.
  assert.equal(parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.equal(parseCreateOptions({}, { imported: true }).template, 'empty');
  // The route reads the import flag and the template from the same call.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /createOptions\.parseCreateOptions\(req\.body, \{ imported: !!repoUrl \}\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'),
    /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
});

test('Empty is the scaffold every project always got, byte for byte', () => {
  const plain = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {});
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'empty' }), plain);
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: null }), plain);
  assert.ok(!plain.some((f) => f.path === 'api.js' || f.path === 'public/app.js'));
  const server = file(plain, 'server.js');
  // #4047: the scaffold ships no Press! demo any more — no demo endpoints
  // and no table; the starter screen is static. The server still listens.
  assert.doesNotMatch(server, /\/api\/press|\/api\/leaderboard|presses/);
  assert.match(server, /app\.listen\(port/);
  assert.doesNotMatch(server, /require\('\.\/api'\)/);
  assert.deepEqual(JSON.parse(file(plain, 'dapp.json')), { secrets: [] });
  // #4047: the welcome card opens with the app's thumbnail tile (no sketch,
  // no starter here, so the name's letter falls back the way the home tile
  // does).
  const emptyHtml = file(plain, 'public/index.html');
  assert.match(emptyHtml, /<div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ground text-title"><span class="text-muted">N<\/span><\/div>/);
  assert.doesNotMatch(emptyHtml, /Try the example|What's already working/);
  assert.throws(() => getTemplateFiles('Notes', 'notes', 'pg://x', null, { template: 'chess' }), /Unknown app template: chess/);
});

test('app-creator scaffolds from the row, and a deleted starter\'s row retries as Empty', () => {
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /function templateOf\(row\) \{\s*const t = row\?\.template;\s*return typeof t === 'string' && appTemplates\.isTemplate\(t\) \? t : appTemplates\.DEFAULT_TEMPLATE;/);
  assert.equal((creator.match(/template: templateOf\(appRow\)/g) || []).length, 2, 'both the GitHub and the local path');
  // What templateOf answers for a project made from a starter before they went.
  for (const id of DELETED) assert.equal(appTemplates.isTemplate(id), false, id);
});

test('the starters\' directory is gone, and nothing builds from it', () => {
  assert.equal(appTemplates.STARTERS_DIR, path.join(ROOT, 'app-templates'));
  assert.equal(fs.existsSync(appTemplates.STARTERS_DIR), false, 'app-templates/ is deleted with its starters');
  assert.deepEqual(appTemplates.starterFiles('empty'), []);
  for (const id of DELETED) assert.deepEqual(appTemplates.starterFiles(id), [], id);
  for (const f of ['Dockerfile', 'tailwind.config.js', '.dockerignore']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /app-templates/, f);
  }
});
