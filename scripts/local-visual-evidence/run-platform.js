#!/usr/bin/env node
'use strict';

// Exercise the durable Homeroom evidence lifecycle against the local Postgres
// database. The app, commits, issue, and proposal are disposable lab data;
// exact-revision replay and artifact storage use the production services.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const contract = require('../../src/services/visual-evidence-plan');
const lab = require('./run');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const PLAN_FILE = path.join(__dirname, 'plan.json');
const DB_URL = 'postgres://usernode:localdev@127.0.0.1:5440/usernode';

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function assertLocalConfig() {
  const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  if (!/^USERNODE_LOCAL_DEV=1$/m.test(env)
      || !/^DATABASE_URL=postgres:\/\/usernode:localdev@db:5432\/usernode$/m.test(env)) {
    throw new Error('Local evidence config is missing. Run npm run visual-evidence:local-setup before testing.');
  }
}

async function assertLocalPlatform() {
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(5_000) });
  if (!response.ok || (await response.json()).status !== 'ok') {
    throw new Error('Local Homeroom is not healthy. Start it with make up.');
  }
}

async function seedLocalProposal(pool, fixture) {
  const { rows: users } = await pool.query(
    'SELECT id FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE ORDER BY id LIMIT 1'
  );
  if (!users[0]) throw new Error('Local Homeroom has no writable admin fixture user.');
  const userId = users[0].id;
  const slug = `local-evidence-${crypto.randomBytes(4).toString('hex')}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: apps } = await client.query(
      `INSERT INTO apps (name, slug, status, repo_url, created_by, collab_visibility, view_visibility)
       VALUES ('Local Evidence Demo', $1, 'paused', 'https://github.com/local/evidence-demo', $2, 'public', 'public')
       RETURNING id`,
      [slug, userId]
    );
    const appId = apps[0].id;
    const { rows: issues } = await client.query(
      `INSERT INTO issues (app_id, title, description, kind, created_by)
       VALUES ($1, 'Suggest matching members while inviting',
         'Local evidence fixture: show a username suggestion after typing ma in the Invite dialog.',
         'general', $2) RETURNING id`,
      [appId, userId]
    );
    const { rows: sessions } = await client.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, status, source, pr_title, spec_md,
          handoff_base_sha, reviewed_head_sha, staging_commit_sha)
       VALUES ($1, $2, 'active', 'local', $3, $4, $5, $6, $6)
       RETURNING id`,
      [appId, userId, 'Suggest matching members while inviting',
        'Local Git fixture with exact before/after commits and an author-submitted visual replay plan.',
        fixture.baseSha, fixture.headSha]
    );
    await client.query('COMMIT');
    return { appId, slug, issueId: issues[0].id, sessionId: sessions[0].id, userId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function localEnvironment(fixture, network, imageDigest, fingerprint) {
  const names = {
    base: `${network}-base`,
    head: `${network}-head`,
  };
  const origins = {
    base: `http://${names.base}:3000`,
    head: `http://${names.head}:3000`,
  };
  const provenance = {
    baseSha: fixture.baseSha, headSha: fixture.headSha,
    fixtureFingerprint: fingerprint,
    baseImageDigest: imageDigest, headImageDigest: imageDigest,
  };
  return {
    async preparePair(_config, { run }) {
      return {
        runId: run.id, fixtureFingerprint: fingerprint,
        sides: {
          base: { sha: fixture.baseSha, checkout: fixture.checkouts.base, imageDigest },
          head: { sha: fixture.headSha, checkout: fixture.checkouts.head, imageDigest },
        },
      };
    },
    async resetPair() {
      await lab.stopFixtures(Object.values(names));
      const results = await Promise.allSettled([
        lab.startFixture(names.base, network, fixture.checkouts.base, 'base'),
        lab.startFixture(names.head, network, fixture.checkouts.head, 'head'),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return { ...provenance, origins };
    },
    async cleanupPair() { await lab.stopFixtures(Object.values(names)); },
  };
}

async function exportRun(pool, runId, seeded, fixture, plan, view, traceSummary) {
  const outputDir = path.join(ROOT, '.local-visual-evidence', `platform-${runId}`);
  await fs.mkdir(outputDir, { recursive: true });
  const { rows } = await pool.query(
    `SELECT story_id, viewport, side, variant, media, content_type, bytes, sha256, data
       FROM visual_evidence_artifacts WHERE run_id = $1
       ORDER BY story_id, viewport, side, variant`,
    [runId]
  );
  const artifacts = [];
  for (const row of rows) {
    const filename = `${row.story_id}-${row.viewport}-${row.side}-${row.variant}.${row.media}`;
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    if (sha256(data) !== row.sha256 || data.length !== row.bytes) {
      throw new Error(`Stored artifact ${filename} failed its digest/size check.`);
    }
    await fs.writeFile(path.join(outputDir, filename), data);
    artifacts.push({ filename, storyId: row.story_id, viewport: row.viewport,
      side: row.side, variant: row.variant, media: row.media,
      contentType: row.content_type, bytes: data.length, sha256: row.sha256 });
  }
  const reviewExports = await lab.exportReviewVideos(
    outputDir, artifacts.filter((artifact) => artifact.variant === 'animation')
  );
  await execFileAsync('git', ['-C', fixture.repoDir, 'bundle', 'create',
    path.join(outputDir, 'fixture.bundle'), 'main']);
  const { stdout: patch } = await execFileAsync('git', ['-C', fixture.repoDir,
    'diff', fixture.baseSha, fixture.headSha, '--', 'app.js']);
  await fs.writeFile(path.join(outputDir, 'change.patch'), patch);
  await fs.writeFile(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const manifest = {
    version: 1, kind: 'local_platform_git_fixture',
    runId, appSlug: seeded.slug, appId: seeded.appId,
    issueId: seeded.issueId, sessionId: seeded.sessionId,
    baseSha: fixture.baseSha, headSha: fixture.headSha,
    state: view?.state, planHash: contract.planHash(plan),
    view, traceSummary, artifacts, reviewExports,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDir, artifacts, reviewExports };
}

async function main() {
  await assertLocalConfig();
  await assertLocalPlatform();
  const plan = contract.parseReplayPlan(JSON.parse(await fs.readFile(PLAN_FILE, 'utf8')));
  const intent = contract.semanticIntentFromPlan(plan);
  const fixture = await lab.createGitFixture();
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const network = `usernode-evidence-platform-${crypto.randomBytes(4).toString('hex')}`;
  let networkCreated = false;
  try {
    const imageDigest = await lab.fixtureImageDigest();
    const fingerprint = sha256(fixture.baseSource + '\0' + fixture.headSource + '\0' + contract.canonicalJson(plan));
    await lab.docker(['network', 'create', '--driver', 'bridge', network]);
    networkCreated = true;
    // docker.js reads this once during import. The platform's normal network
    // remains untouched; only this process's replay containers use the lab.
    process.env.DOCKER_NETWORK = network;
    const state = require('../../src/services/visual-evidence-state');
    const orchestrator = require('../../src/services/visual-evidence-orchestrator');
    const viewService = require('../../src/services/visual-evidence-view');
    const seeded = await seedLocalProposal(pool, fixture);
    await state.recordIntent(pool, seeded.sessionId, intent, { headSha: fixture.headSha });
    const { stdout: patch } = await execFileAsync('git', ['-C', fixture.repoDir,
      'diff', fixture.baseSha, fixture.headSha, '--', 'app.js']);
    const injected = {
      github: {
        async compareRefs() { return { mergeBaseSha: fixture.baseSha, files: ['app.js'], filesComplete: true }; },
        async getProposalDiff() { return { diff: patch, fileCount: 1, truncated: false }; },
      },
      environment: localEnvironment(fixture, network, imageDigest, fingerprint),
      identities: {
        async mintEvidenceAuthTokens() {
          return {
            member: 'local-member-fixture',
            read_only_admin: 'local-admin-fixture',
            full_admin: 'local-full-admin-fixture',
          };
        },
      },
      worker: { isInFlight() { return false; } },
    };
    const config = { captureRuntime: 'docker', visualEvidence: {
      execute: true, maxRunMs: 240_000, maxAgentMs: 240_000,
    } };
    const scheduled = await orchestrator.scheduleForSession(config, {
      pool, sessionId: seeded.sessionId, headSha: fixture.headSha,
      trigger: 'author-plan', authorPlan: plan,
      onProgress(message) { process.stdout.write(`${message}\n`); },
    }, injected);
    if (!scheduled.scheduled) throw new Error(`Local proposal evidence did not start: ${scheduled.reason}`);
    await scheduled.promise;
    const { rows: sessions } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [seeded.sessionId]);
    const view = await viewService.getForSession(pool, sessions[0], seeded.slug);
    if (view?.state !== 'verified' || view.artifacts?.length !== 5) {
      throw new Error(`Local proposal evidence was incomplete: ${view?.state || 'missing'} (${view?.artifacts?.length || 0} artifacts).`);
    }
    const { rows: runs } = await pool.query(
      'SELECT trace_summary FROM visual_evidence_runs WHERE id = $1', [scheduled.runId]
    );
    const traceSummary = runs[0]?.trace_summary;
    if (traceSummary?.runs !== 2 || traceSummary?.agentAttempts !== 0) {
      throw new Error('Local evidence did not complete two passes without a model agent.');
    }
    const exported = await exportRun(pool, scheduled.runId, seeded, fixture, plan, view, traceSummary);
    process.stdout.write(`Local proposal ${seeded.sessionId}, issue ${seeded.issueId}: verified five artifacts and exported ${exported.reviewExports.length} review videos.\n${exported.outputDir}\n`);
  } finally {
    await lab.stopFixtures([`${network}-base`, `${network}-head`]);
    if (networkCreated) {
      await lab.docker(['network', 'rm', network], 15_000).catch(() => {});
    }
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertLocalConfig, assertLocalPlatform, seedLocalProposal, localEnvironment, exportRun, main };
