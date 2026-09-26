'use strict';

// POST /api/apps's creation choices (communities, stage 3): who the project
// is for, who is invited, and who approves. src/services/create-options.js is
// pure, so every rule is pinned here; tests/create-audience-postgres.test.js
// drives the route itself against the real schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const options = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');

test('an audience resolves to the two visibility columns it implies', () => {
  const parse = (audience) => options.parseCreateOptions({ audience });
  assert.deepEqual(
    [parse('solo'), parse('invited'), parse('open')].map((o) => [o.collabVisibility, o.viewVisibility]),
    [['private', 'private'], ['private', 'private'], ['public', 'public']],
    'Just me and A group are private; A community is open to see and to build',
  );
  assert.equal(parse('solo').audience, 'solo');
  assert.match(options.parseCreateOptions({ audience: 'public' }).error, /audience must be/);
});

test('a body with no audience keeps today\'s two fields, defaults and rule', () => {
  const legacy = options.parseCreateOptions({});
  assert.equal(legacy.audience, null);
  assert.deepEqual([legacy.collabVisibility, legacy.viewVisibility], ['public', 'public']);
  const inviteOnly = options.parseCreateOptions({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.deepEqual([inviteOnly.collabVisibility, inviteOnly.viewVisibility], ['private', 'public'],
    '"public to use, invite-only building" is still reachable by an older client');
  assert.equal(options.parseCreateOptions({ collabVisibility: 'public', viewVisibility: 'private' }).error,
    'An app that everyone can build cannot be private to view');
  // apps.js validates the visibility-PR route with the same function.
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(route, /const validateVisibilityCombo = createOptions\.visibilityComboError;/);
});

test('invitees are usernames, for a group only, deduplicated and bounded', () => {
  const group = options.parseCreateOptions({ audience: 'invited', invitees: [' @Ada ', 'ada', 'grace', '', '@'] });
  assert.deepEqual(group.invitees, ['Ada', 'grace'], '@ and case do not make a second invite');
  assert.match(options.parseCreateOptions({ audience: 'solo', invitees: ['ada'] }).error, /Only a group/);
  assert.match(options.parseCreateOptions({ audience: 'open', invitees: ['ada'] }).error, /Only a group/);
  assert.deepEqual(options.parseCreateOptions({ audience: 'open', invitees: [] }).invitees, [],
    'an empty list is no invites, not an error');
  assert.match(options.parseCreateOptions({ audience: 'invited', invitees: 'ada' }).error, /list of usernames/);
  const many = Array.from({ length: options.MAX_INVITEES + 1 }, (_, i) => `u${i}`);
  assert.match(options.parseCreateOptions({ audience: 'invited', invitees: many }).error, /at most 20/);
});

test('who approves is dapp.json\'s own block, read strictly', () => {
  const gov = (governance, extra = {}) => options.parseCreateOptions({ audience: 'open', governance, ...extra });
  assert.equal(gov(undefined).governance, null, 'absent is the default rule');
  assert.equal(gov({ approvers: 'anyone', approvals: 'default' }).governance, null,
    'the default rule, spelled out, is still the default');
  assert.deepEqual(gov({ approvers: 'invited' }).governance, { approverPolicy: 'invited', approvalsRequired: null });
  assert.deepEqual(gov({ approvers: 'invited', approvals: { atLeast: 2 } }).governance,
    { approverPolicy: 'invited', approvalsRequired: 2 },
    'people I pick, then at least N of their yes votes');
  assert.match(gov({ approvers: 'admins' }).error, /approvers must be/);
  assert.match(gov({ approvers: 'invited', approvals: { atLeast: 0 } }).error, /atLeast/);
  assert.match(gov({ approvers: 'invited', approvals: { atLeast: 51 } }).error, /atLeast/);
  assert.match(options.parseCreateOptions({ governance: { approvers: 'invited' } }, { imported: true }).error,
    /imported repo/, 'an import\'s own dapp.json decides');
});

test('the new repository\'s dapp.json carries a non-default rule, and only then', () => {
  const dapp = (governance) => JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { governance })
    .find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(dapp(null), { secrets: [] }, 'a default project\'s manifest is unchanged');
  assert.deepEqual(dapp({ approverPolicy: 'anyone', approvalsRequired: null }), { secrets: [] });
  assert.deepEqual(dapp({ approverPolicy: 'invited', approvalsRequired: null }),
    { secrets: [], governance: { approvers: 'invited', approvals: 'default' } });
  assert.deepEqual(dapp({ approverPolicy: 'invited', approvalsRequired: 3 }),
    { secrets: [], governance: { approvers: 'invited', approvals: { atLeast: 3 } } });
  // What it writes is what the manifest reader reads back.
  const { readGovernance } = require('../src/services/app-manifest');
  assert.deepEqual(readGovernance(dapp({ approverPolicy: 'invited', approvalsRequired: 3 })),
    { approvers: 'invited', approvals: 3 });
  const creator = fs.readFileSync(path.join(__dirname, '../src/services/app-creator.js'), 'utf8');
  assert.equal((creator.match(/\{ governance: governanceOf\(appRow\), description: descriptionOf\(appRow\) \}/g) || []).length, 2,
    'both template paths (GitHub and local) pass the row\'s rule and its line');
});

test('"What is it?" is one optional line, tidied and bounded, for a new project only', () => {
  const desc = (description, opts) => options.parseCreateOptions({ audience: 'open', description }, opts);
  assert.equal(desc(undefined).description, null);
  assert.equal(desc('   ').description, null, 'blank is no line');
  assert.equal(desc('  A shared\n\tlist  for our house ').description, 'A shared list for our house');
  assert.equal(desc('x'.repeat(options.DESCRIPTION_MAX)).description.length, 100);
  assert.match(desc('x'.repeat(101)).error, /100 characters or fewer/);
  assert.match(desc(42).error, /line of text/);
  assert.match(desc('A fork of ours', { imported: true }).error, /own dapp\.json describes it/);
});

test('the new repository\'s dapp.json and CLAUDE.md carry the line, and only when there is one', () => {
  const files = (description) => getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { description });
  const dapp = (description) => JSON.parse(files(description).find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(dapp(null), { secrets: [] });
  assert.deepEqual(dapp('Shared notes for the house'), { description: 'Shared notes for the house', secrets: [] });
  const both = JSON.parse(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {
    description: 'Shared notes', governance: { approverPolicy: 'invited', approvalsRequired: null },
  }).find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(Object.keys(both), ['description', 'secrets', 'governance']);
  const about = (description) => {
    const claude = files(description).find((f) => f.path === 'CLAUDE.md').content;
    return claude.slice(claude.indexOf('## About Notes'), claude.indexOf('## App-specific conventions'));
  };
  assert.match(about('Shared notes for the house'), /^## About Notes\n\nShared notes for the house\n\n/);
  assert.doesNotMatch(about(null), /Shared notes/);
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  assert.match(route, /UPDATE apps SET manifest_snapshot = \$1 WHERE id = \$2 RETURNING \*`,\s*\[JSON\.stringify\(\{ description, secrets: \[\] \}\), appRow\.id\]/,
    'the route seeds the line where app-creator (and a Retry) reads it');
});
