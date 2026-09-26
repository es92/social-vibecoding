'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const environment = require('../src/services/visual-evidence-environment');
const runtime = require('../src/services/application-runtime');
const dbManager = require('../src/services/db-manager');
const fixtures = require('../src/services/visual-evidence-fixtures');

test('evidence resource names are deterministic, side-specific, and bounded', () => {
  const runId = '0123456789abcdef0123456789abcdef';
  assert.equal(environment.runtimeName(runId, 'base', 'docker'), 'usernode-evidence-0123456789abcdef-base');
  assert.equal(environment.runtimeName(runId, 'head', 'kubernetes'), 'sv-evidence-0123456789abcdef-h');
  assert.ok(environment.runtimeName(runId, 'base', 'kubernetes').length <= 63);
  assert.notEqual(environment.runtimeName(runId, 'base'), environment.runtimeName(runId, 'head'));
  assert.throws(() => environment.runtimeName(runId, 'other'), /invalid/i);
});

test('evidence image tags key the exact revision and recipe', () => {
  const sha = 'a'.repeat(40);
  const tag = environment.dockerImageName({ id: 42 }, sha);
  assert.equal(tag, `usernode-evidence-42:${'a'.repeat(16)}-${environment.IMAGE_RECIPE}`);
  assert.throws(() => environment.dockerImageName({ id: 42 }, 'main'), /exact 40-character/);
});

test('only the Homeroom self-app evidence runtime bypasses the server app cap', () => {
  const config = { selfAppSlug: 'usernode-2d5619' };
  assert.deepEqual(environment.evidenceCapacityEnv(config, { slug: 'usernode-2d5619' }), {
    MAX_APPS: '0',
  });
  assert.deepEqual(environment.evidenceCapacityEnv(config, { slug: 'another-app' }), {});
});

test('only canonical HTTPS GitHub repositories are accepted', () => {
  assert.deepEqual(environment.repoParts('https://github.com/Usernode-Labs/example.git'), {
    owner: 'Usernode-Labs', repo: 'example',
  });
  assert.throws(() => environment.repoParts('git@github.com:owner/repo.git'), /HTTPS GitHub/);
  assert.throws(() => environment.repoParts('https://example.com/owner/repo'), /HTTPS GitHub/);
});

test('parallel cleanup waits for every sibling before surfacing a failure', async () => {
  const order = [];
  let release;
  const slow = new Promise((resolve) => { release = () => { order.push('slow'); resolve('ok'); }; });
  const pending = environment.allSettledValues([
    slow,
    Promise.reject(new Error('boom')),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await assert.rejects(pending, /boom/);
  assert.deepEqual(order, ['slow']);
});

test('each paired reset serializes clones and adds the same member fixture to both revisions', async () => {
  const original = {
    remove: runtime.remove, deploy: runtime.deploy, appOrigin: runtime.appOrigin,
    clone: dbManager.cloneFromPreparedSource, connectionUrl: dbManager.connectionUrl,
    fullAdmin: fixtures.ensureFullAdminIdentity,
    inspect: fixtures.canCopyMemberAgentSession, copy: fixtures.copyMemberAgentSession,
  };
  const runId = '2'.repeat(32);
  const slug = 'usernode-2d5619';
  const pair = {
    app: { slug }, runId, sessionId: 42,
    preparedSource: { fingerprint: 'source-fingerprint' },
    sides: Object.fromEntries(['base', 'head'].map((side) => [side, {
      dbName: dbManager.evidenceDbName(slug, runId, side), runtimeName: `evidence-${side}`,
      sha: side === 'base' ? 'a'.repeat(40) : 'b'.repeat(40),
      imageRef: `image-${side}`, imageDigest: `digest-${side}`, env: {},
    }])),
  };
  const order = [];
  const deployedEnvs = [];
  let cloneActive = false;
  try {
    runtime.remove = async () => {};
    runtime.deploy = async (_config, spec) => {
      deployedEnvs.push(spec.env);
      return { runtimeName: spec.runtimeName };
    };
    runtime.appOrigin = (_config, deployment) => `http://${deployment.runtimeName}`;
    dbManager.cloneFromPreparedSource = async (_source, dbName, { onProgress }) => {
      assert.equal(cloneActive, false, 'the next clone must wait for the prior redaction pass');
      cloneActive = true;
      order.push(dbName);
      onProgress('copy_template');
      await new Promise((resolve) => setImmediate(resolve));
      onProgress('scrub_private');
      cloneActive = false;
      return { password: 'disposable' };
    };
    dbManager.connectionUrl = (dbName) => `postgres://fixture@db/${dbName}`;
    fixtures.ensureFullAdminIdentity = async ({ side }) => ({
      id: fixtures.FULL_ADMIN_PROFILE, persona: 'full_admin', path: '/#admin/users', side,
    });
    fixtures.canCopyMemberAgentSession = async () => true;
    fixtures.copyMemberAgentSession = async ({ side }) => ({ id: fixtures.PROFILE,
      persona: 'member', path: '/#messages/agent/990899', side });
    const progress = [];
    const deployment = await environment.resetPair({ selfAppSlug: slug }, pair,
      { onProgress: (event) => progress.push(event.stage) });
    assert.deepEqual(order, [pair.sides.base.dbName, pair.sides.head.dbName]);
    assert.deepEqual(progress.slice(0, 6), [
      'clone_base', 'clone_base_copy_template', 'clone_base_scrub_private',
      'clone_head', 'clone_head_copy_template', 'clone_head_scrub_private',
    ]);
    assert.equal(deployment.availableFixtures.length, 2);
    assert.equal(deployment.availableFixtures[0].persona, 'full_admin');
    assert.equal(deployment.availableFixtures[1].persona, 'member');
    assert.equal(deployedEnvs.length, 2);
    assert.ok(deployedEnvs.every((env) => env.MAX_APPS === '0'));
    assert.ok(progress.includes('seed_evidence_identities'));
    assert.equal(deployment.fixtureFingerprint, crypto.createHash('sha256')
      .update(`source-fingerprint\n${fixtures.FULL_ADMIN_PROFILE}+${fixtures.PROFILE}`).digest('hex'));
  } finally {
    runtime.remove = original.remove;
    runtime.deploy = original.deploy;
    runtime.appOrigin = original.appOrigin;
    dbManager.cloneFromPreparedSource = original.clone;
    dbManager.connectionUrl = original.connectionUrl;
    fixtures.ensureFullAdminIdentity = original.fullAdmin;
    fixtures.canCopyMemberAgentSession = original.inspect;
    fixtures.copyMemberAgentSession = original.copy;
  }
});
