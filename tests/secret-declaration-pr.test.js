// Tests for the secret-DECLARATION manifest PR flavor in
// src/services/rename-pr.js (createSecretDeclarationPR).
//
// This is the manifest half of "add a brand-new variable from the App
// secrets panel". Three things must hold:
//
//  1. IT WRITES THE RIGHT BLOCK. A child app's key goes in `secrets`; the
//     platform's goes in `platform_env`. Getting this backwards is
//     SILENTLY wrong — a tunable in the platform's `secrets` block can be
//     stored and the platform will never read it (app-conventions.md
//     "Editing the PLATFORM itself").
//  2. IT PRESERVES WHAT'S ALREADY THERE. The mutation appends; existing
//     entries and unrelated manifest fields survive untouched.
//  3. THE VALUE IS NEVER IN THE PR. A PR body and a group-chat message
//     are public content; the value belongs in the encrypted store only.
//
// The mutation and the copy are pulled out of the real module (its
// `mutate` runs against a plain object, so no GitHub or DB is needed) by
// stubbing createManifestPR's collaborators — see captureOpts below.
//
// Run with: node --test tests/secret-declaration-pr.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renamePr = require('../src/services/rename-pr');

const root = path.join(__dirname, '..');
const renamePrJs = fs.readFileSync(path.join(root, 'src/services/rename-pr.js'), 'utf8');

const APP = { id: 1, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo' };
const ACTOR = { id: 5, username: 'alice' };

// Run createSecretDeclarationPR with GitHub + the DB + the broadcast
// fan-out stubbed, and hand back the `opts` it passed to its shared core
// so the mutation and the copy can be asserted directly.
async function captureOpts(t, args, existingManifest = { secrets: [] }) {
  const github = require('../src/services/github');
  const events = require('../src/services/events');
  const ws = require('../src/services/ws');
  const activeUsers = require('../src/services/active-users');
  const notifications = require('../src/services/notifications');

  const pushed = [];
  t.mock.method(github, 'getFileContent', async () => JSON.stringify(existingManifest));
  t.mock.method(github, 'createBranch', async () => ({}));
  t.mock.method(github, 'pushFiles', async (owner, repo, files) => { pushed.push(...files); });
  t.mock.method(github, 'createPR', async () => ({ number: 77, html_url: 'https://github.test/pr/77' }));
  t.mock.method(events, 'record', () => {});
  t.mock.method(ws, 'sendSystemMessage', async () => {});
  t.mock.method(ws, 'pushVoteUpdate', () => {});
  t.mock.method(ws, 'pushNotificationToUser', () => {});
  t.mock.method(activeUsers, 'getActiveUserStats', async () => ({ active: 4, majority: 3 }));
  t.mock.method(notifications, 'createPrProposedNotifications', async () => []);

  const chat = [];
  const pool = {
    query: async (sql) => {
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 123 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  t.mock.method(ws, 'sendSystemMessage', async (p, appId, text) => { chat.push(text); });

  const result = await renamePr.createSecretDeclarationPR({}, pool, APP, args, ACTOR);
  const written = pushed.find((f) => f.path === 'dapp.json');
  return {
    result,
    chat,
    manifest: JSON.parse(written.content),
    content: written.content,
  };
}

const DECL = {
  description: 'Token for the thing',
  required: true,
  private: true,
  default: null,
  staging_default: 'staging-dummy',
  group: 'General',
};

test('an app-scope declaration appends to `secrets`, preserving existing entries', async (t) => {
  const { manifest } = await captureOpts(t, {
    scope: 'app', key: 'NEW_TOKEN', declaration: DECL, hasValue: true,
  }, {
    name: 'Demo',
    secrets: [{ key: 'EXISTING', description: 'kept', required: false }],
    tests: [{ name: 'home', path: '/' }],
  });

  assert.equal(manifest.secrets.length, 2);
  assert.deepEqual(manifest.secrets[0], { key: 'EXISTING', description: 'kept', required: false },
    'an existing entry is untouched');
  assert.deepEqual(manifest.secrets[1], {
    key: 'NEW_TOKEN',
    description: 'Token for the thing',
    required: true,
    private: true,
    staging_default: 'staging-dummy',
  });
  assert.equal(manifest.name, 'Demo', 'unrelated manifest fields survive');
  assert.equal(manifest.tests.length, 1);
  assert.ok(!('platform_env' in manifest), 'an app declaration never creates a platform_env block');
});

test('a platform-scope declaration appends to `platform_env` with its group', async (t) => {
  const { manifest } = await captureOpts(t, {
    scope: 'platform',
    key: 'NEW_TUNABLE',
    declaration: {
      description: 'How long the sweeper waits',
      required: false,
      private: false,
      default: '60000',
      staging_default: 'ignored-for-platform',
      group: 'Sessions',
    },
    hasValue: false,
  }, { platform_env: [{ key: 'LOG_LEVEL', group: 'Platform', default: 'INFO' }], secrets: [] });

  assert.equal(manifest.platform_env.length, 2);
  assert.deepEqual(manifest.platform_env[1], {
    key: 'NEW_TUNABLE',
    group: 'Sessions',
    description: 'How long the sweeper waits',
    default: '60000',
  });
  assert.ok(!('staging_default' in manifest.platform_env[1]),
    'platform_env has no staging_default — nothing there reaches a container');
  assert.equal(manifest.secrets.length, 0, 'the `secrets` block is not touched');
});

test('empty optional fields are omitted rather than written as empty strings', async (t) => {
  const { manifest } = await captureOpts(t, {
    scope: 'app',
    key: 'MINIMAL',
    declaration: { description: '', required: false, private: false, default: null, staging_default: null },
    hasValue: false,
  });
  assert.deepEqual(manifest.secrets[0], { key: 'MINIMAL' },
    'a bare declaration commits a bare entry — no null/"" noise in the diff');
});

test('the block is created when the manifest has none', async (t) => {
  const { manifest } = await captureOpts(t, {
    scope: 'platform', key: 'FIRST_ONE', declaration: { group: 'General' }, hasValue: false,
  }, { name: 'Homeroom' });
  assert.deepEqual(manifest.platform_env, [{ key: 'FIRST_ONE', group: 'General' }]);
});

test('a key already on main is replaced, not duplicated', async (t) => {
  // The route's collision check reads the manifest SNAPSHOT, which lags a
  // dev-session edit that merged but hasn't deployed. Replacing keeps the
  // committed file valid either way (app-manifest.read drops duplicates,
  // but a duplicate is still a confusing diff).
  const { manifest } = await captureOpts(t, {
    scope: 'app', key: 'DUPE', declaration: { description: 'new text' }, hasValue: false,
  }, { secrets: [{ key: 'DUPE', description: 'old text' }, { key: 'OTHER' }] });

  assert.equal(manifest.secrets.filter((s) => s.key === 'DUPE').length, 1);
  assert.equal(manifest.secrets[0].description, 'new text');
  assert.equal(manifest.secrets[1].key, 'OTHER', 'position and siblings are preserved');
});

test('the PR body and chat line describe the declaration but never the value', async (t) => {
  const { content, chat, result } = await captureOpts(t, {
    scope: 'app', key: 'NEW_TOKEN', declaration: DECL, hasValue: true,
  });
  assert.equal(result.prNumber, 77);

  // The value the panel would have collected. Nothing public may contain it.
  const SECRET_VALUE = 'sk-live-do-not-publish';
  const published = [content, ...chat].join('\n');
  assert.ok(!published.includes(SECRET_VALUE));

  const github = require('../src/services/github');
  const prCall = github.createPR.mock.calls[0].arguments[2];
  assert.match(prCall.title, /Declare app secret "NEW_TOKEN"/);
  assert.match(prCall.body, /required: true/);
  assert.match(prCall.body, /private: true/);
  assert.match(prCall.body, /staging_default/);
  assert.match(prCall.body, /applied when this PR merges/,
    'a reader has to know the value lands on merge');
  assert.match(prCall.body, /not in this PR/,
    'and that the value deliberately is not in the diff');
  assert.match(chat.join('\n'), /proposed adding the app secret NEW_TOKEN \(value included\)/);
});

test('a declaration-only proposal says so instead of promising a value', async (t) => {
  const { chat } = await captureOpts(t, {
    scope: 'platform', key: 'DOC_ONLY', declaration: { default: '5', group: 'General' }, hasValue: false,
  });
  const github = require('../src/services/github');
  const prCall = github.createPR.mock.calls[0].arguments[2];
  assert.match(prCall.body, /No value accompanies this proposal/);
  assert.ok(!/value included/.test(chat.join('\n')));
});

test('the flavor rides the shared manifest-PR core with no explicit-approval flag', () => {
  // Text-pinned: `explicitApproval: true` switches off the time-based
  // merge paths (issue #788, for privilege-granting changes). A secret
  // declaration grants nobody anything, so it must merge like any other
  // proposal — and this is cheaper to pin than to exercise.
  const fn = renamePrJs.slice(
    renamePrJs.indexOf('async function createSecretDeclarationPR('),
    renamePrJs.indexOf('// Returns the open declaration PR session')
  );
  assert.ok(fn.length, 'createSecretDeclarationPR not found');
  assert.match(fn, /return createManifestPR\(/, 'reuses the shared core, so the vote plumbing is identical');
  assert.match(fn, /explicitApproval: false/);
  assert.match(fn, /branchPrefix: 'secret-declare'/);
  assert.match(fn, /eventMetadata: \{ secretDeclaration: true, scope, key \}/);
});

test('findSecretDeclarationPr dedupes per KEY, over live proposals only', () => {
  const fn = renamePrJs.slice(
    renamePrJs.indexOf('async function findSecretDeclarationPr('),
    renamePrJs.indexOf('// Returns the open admins-change PR session')
  );
  assert.match(fn, /branch_name LIKE 'secret-declare\/%'/);
  assert.match(fn, /pr_title = \$2/, 'scoped to one key, not one-per-app like visibility/governance');
  assert.match(fn, /status IN \('promoted', 'merging'\)/);
});

test('the PR title distinguishes the two scopes', () => {
  assert.equal(renamePr.secretDeclarationPrTitle('app', 'K'), 'Declare app secret "K"');
  assert.equal(renamePr.secretDeclarationPrTitle('platform', 'K'), 'Declare platform variable "K"');
});
