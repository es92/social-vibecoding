// dapp.json's optional top-level `category` (#3962): what kind of app a
// project is, which Discover's "Filter by type" chips read from the manifest
// snapshot. One fixed list (app-manifest.js APP_CATEGORIES), read leniently
// like `visibility`: an unknown value is ignored, never a failed deploy.
//
// Run with: node --test tests/app-manifest-category.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');
const { getTemplateFiles } = require('../src/services/template');

test('the list is the nine kinds, in the chips\' order', () => {
  assert.deepEqual(Array.from(appManifest.APP_CATEGORIES),
    ['games', 'social', 'tools', 'learning', 'creative', 'money', 'health', 'food', 'other']);
  assert.ok(Object.isFrozen(appManifest.APP_CATEGORIES));
});

test('readCategory keeps a listed kind and ignores anything else', () => {
  const read = (category) => appManifest.readCategory({ category });
  for (const key of appManifest.APP_CATEGORIES) assert.equal(read(key), key);
  for (const key of ['money', 'health', 'food']) assert.equal(read(key), key, `${key} is a real kind`);
  assert.equal(read(' Money '), 'money', 'case and edge space are forgiven');
  assert.equal(read(undefined), null, 'absent says nothing');
  assert.equal(read(null), null);
  for (const bad of ['game', 'casino', '', 3, ['games'], { key: 'games' }]) {
    assert.equal(read(bad), null, JSON.stringify(bad));
  }
  assert.equal(appManifest.readCategory(null), null);
});

test('read() carries the category into the manifest snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-category-'));
  try {
    assert.equal(appManifest.read(dir).category, null, 'no dapp.json');
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({ category: 'learning', secrets: [] }));
    assert.equal(appManifest.read(dir).category, 'learning');
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({ category: 'nope', secrets: [] }));
    assert.equal(appManifest.read(dir).category, null);
    fs.writeFileSync(path.join(dir, 'dapp.json'), '{not json');
    assert.equal(appManifest.read(dir).category, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new project starts with a category line its group can change', () => {
  const dapp = (template, category) => JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template, category })
    .find((f) => f.path === 'dapp.json').content);
  assert.equal(dapp(null).category, 'other');
  assert.equal(appManifest.readCategory(dapp(null)), 'other', 'what it writes is what the reader keeps');
  const games = require('../src/services/app-templates').TEMPLATE_IDS.filter((id) => id.startsWith('game-'));
  assert.ok(games.length > 0);
  for (const id of games) assert.equal(dapp(id).category, 'games', id);
});

test('a new project starts with the kind its idea implies, and a game starter is still a game', () => {
  const dapp = (template, category) => JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template, category })
    .find((f) => f.path === 'dapp.json').content);
  for (const category of ['money', 'health', 'food', 'learning']) {
    assert.equal(dapp(null, category).category, category);
  }
  assert.equal(dapp(null, 'not-a-kind').category, 'other', 'an invalid one writes the starting Other');
  assert.equal(dapp(null, null).category, 'other');
  const games = require('../src/services/app-templates').TEMPLATE_IDS.filter((id) => id.startsWith('game-'));
  for (const id of games) assert.equal(dapp(id, 'food').category, 'games', `${id} stays a game`);
});
