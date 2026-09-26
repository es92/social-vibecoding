#!/usr/bin/env node
'use strict';

// Run the production browser/encoder against two exact commits of a local
// demo app, with no platform DB, GitHub, or model service.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const contract = require('../../src/services/visual-evidence-plan');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_FILE = path.join(__dirname, 'fixture-app.js');
const DEFAULT_PLAN = path.join(__dirname, 'plan.json');

function parseArgs(argv) {
  const options = { planFile: DEFAULT_PLAN, outputRoot: path.join(ROOT, '.local-visual-evidence') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan' && argv[i + 1]) options.planFile = path.resolve(argv[++i]);
    else if (argv[i] === '--output-dir' && argv[i + 1]) options.outputRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--help') options.help = true;
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  return options;
}

async function docker(args, timeout = 30_000) {
  const { stdout } = await execFileAsync('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

async function fixtureImageDigest() {
  const image = 'node:22-bookworm-slim';
  try { return await docker(['image', 'inspect', '--format', '{{.Id}}', image]); }
  catch {
    await docker(['pull', image], 180_000);
    return docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  }
}

async function startFixture(name, network, checkoutDir, side) {
  await docker([
    'run', '-d', '--rm', '--name', name, '--network', network,
    '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${checkoutDir},target=/app,readonly`,
    'node:22-bookworm-slim', 'node', '/app/app.js',
  ]);
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await docker(['exec', name, 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) })"], 5_000);
      return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${side} fixture did not become ready: ${lastError?.message || 'timeout'}`);
}

async function stopFixtures(names) {
  await Promise.all(names.map((name) => docker(['rm', '-f', name], 15_000).catch(() => {})));
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function git(args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  return stdout.trim();
}

async function createGitFixture() {
  const fixtureRoot = path.join(ROOT, '.local-visual-evidence');
  await fs.mkdir(fixtureRoot, { recursive: true });
  // Docker Desktop shares the workspace, but may not share macOS's temporary
  // directory with its daemon. Keep disposable checkouts under this ignored
  // workspace directory so bind mounts resolve on both host and daemon.
  const tempRoot = await fs.mkdtemp(path.join(fixtureRoot, '.fixture-'));
  try {
    const repoDir = path.join(tempRoot, 'repo');
    const source = await fs.readFile(FIXTURE_FILE, 'utf8');
    const before = 'suggestions.hidden = true; // LOCAL_EVIDENCE_CHANGE_POINT';
    const after = "suggestions.hidden = event.target.value.trim().toLowerCase() !== 'ma'; // LOCAL_EVIDENCE_CHANGE_POINT";
    if (source.split(before).length !== 2) throw new Error('Demo app change point is missing or duplicated.');
    const baseSource = source;
    const headSource = source.replace(before, after);
    await fs.mkdir(repoDir);
    await git(['init', '-q', '-b', 'main', repoDir]);
    const appFile = path.join(repoDir, 'app.js');
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Local Evidence', GIT_AUTHOR_EMAIL: 'local-evidence@example.invalid',
      GIT_COMMITTER_NAME: 'Local Evidence', GIT_COMMITTER_EMAIL: 'local-evidence@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    };
    await fs.writeFile(appFile, baseSource);
    await git(['-C', repoDir, 'add', 'app.js']);
    await git(['-C', repoDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Base invite dialog'], { env: commitEnv });
    const baseSha = await git(['-C', repoDir, 'rev-parse', 'HEAD']);
    await fs.writeFile(appFile, headSource);
    await git(['-C', repoDir, 'add', 'app.js']);
    await git(['-C', repoDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Suggest matching members'], { env: commitEnv });
    const headSha = await git(['-C', repoDir, 'rev-parse', 'HEAD']);
    const checkouts = { base: path.join(tempRoot, 'base'), head: path.join(tempRoot, 'head') };
    await git(['-C', repoDir, 'worktree', 'add', '-q', '--detach', checkouts.base, baseSha]);
    await git(['-C', repoDir, 'worktree', 'add', '-q', '--detach', checkouts.head, headSha]);
    return { tempRoot, repoDir, checkouts, baseSha, headSha, baseSource, headSource };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function exportReviewVideos(outputDir, pairedArtifacts) {
  const exports = [];
  // The Docker daemon sees the physical host path, which may differ from a
  // caller's symlinked path (notably /tmp on macOS).
  const mountDir = await fs.realpath(outputDir);
  for (const paired of pairedArtifacts) {
    const source = `${paired.storyId}-${paired.viewport}-paired-animation.webm`;
    for (const side of ['base', 'head']) {
      const filename = `${paired.storyId}-${paired.viewport}-${side}-review.webm`;
      // The first 36 pixels hold the shared stage title. Drop that strip so
      // each standalone review video begins with its own Before/After label.
      const crop = side === 'base' ? 'crop=iw/2:ih-36:0:36' : 'crop=iw/2:ih-36:iw/2:36';
      await docker([
        'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '--mount', `type=bind,source=${mountDir},target=/evidence`,
        'usernode-capture:latest', 'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-i', `/evidence/${source}`, '-vf', crop,
        '-an', '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-y',
        `/evidence/${filename}`,
      ], 120_000);
      const data = await fs.readFile(path.join(outputDir, filename));
      exports.push({ filename, side, contentType: 'video/webm', bytes: data.length,
        sha256: sha256(data), derivedFrom: source });
    }
  }
  return exports;
}

async function run(options) {
  const plan = contract.parseReplayPlan(JSON.parse(await fs.readFile(options.planFile, 'utf8')));
  const fixture = await createGitFixture();
  try { return await runWithFixture(options, plan, fixture); }
  finally { await fs.rm(fixture.tempRoot, { recursive: true, force: true }); }
}

async function runWithFixture(options, plan, fixture) {
  const runId = crypto.randomBytes(16).toString('hex');
  const network = `usernode-evidence-lab-${runId.slice(0, 8)}`;
  const names = { base: `${network}-base`, head: `${network}-head` };
  const containerNames = Object.values(names);
  const outputDir = path.join(options.outputRoot, runId);
  const imageDigest = await fixtureImageDigest();
  const provenance = {
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    fixtureFingerprint: sha256(fixture.baseSource + '\0' + fixture.headSource + '\0' + contract.canonicalJson(plan)),
    baseImageDigest: imageDigest,
    headImageDigest: imageDigest,
  };
  const origins = {
    base: `http://${names.base}:3000`,
    head: `http://${names.head}:3000`,
  };
  const inputFor = (pass) => ({
    runId, pass, publishArtifacts: pass === 2, plan, origins, provenance,
    authTokens: {
      member: 'local-member-fixture',
      read_only_admin: 'local-admin-fixture',
      full_admin: 'local-full-admin-fixture',
    },
    cookies: {},
    browser: { locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', deviceScaleFactor: 1 },
  });

  await docker(['network', 'create', '--driver', 'bridge', network]);
  try {
    // docker.js captures its shared network at require time. Select the
    // isolated lab network before loading the production replay launcher.
    process.env.DOCKER_NETWORK = network;
    const replay = require('../../src/services/visual-evidence-replay');
    const config = { captureRuntime: 'docker', visualEvidence: { maxRunMs: 240_000 } };
    const sessionId = Number.parseInt(runId.slice(0, 8), 16) + 1;
    const startPair = async () => {
      const results = await Promise.allSettled([
        startFixture(names.base, network, fixture.checkouts.base, 'base'),
        startFixture(names.head, network, fixture.checkouts.head, 'head'),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const onEvent = (event) => {
      if (event.type === 'viewport_started' || event.type === 'viewport_finished') {
        process.stdout.write(`pass ${event.pass}: ${event.type} ${event.storyId}/${event.viewport}\n`);
      }
    };

    const prepareCase = async () => {
      await stopFixtures(containerNames);
      await startPair();
      return { origins };
    };
    const first = await replay.runPassCases(config, sessionId, inputFor(1), { prepareCase, onEvent });
    const second = await replay.runPassCases(config, sessionId, inputFor(2), { prepareCase, onEvent });
    const verdict = replay.comparePasses(first, second, { plan, provenance, runId });
    if (!verdict.passed) throw new Error(`${verdict.code}: ${verdict.reason}`);

    await fs.mkdir(outputDir, { recursive: true });
    await git(['-C', fixture.repoDir, 'bundle', 'create', path.join(outputDir, 'fixture.bundle'), 'main']);
    const patch = await git(['-C', fixture.repoDir, 'diff', fixture.baseSha, fixture.headSha, '--', 'app.js']);
    await fs.writeFile(path.join(outputDir, 'change.patch'), `${patch}\n`);
    const artifacts = [];
    for (const artifact of second.artifacts) {
      const filename = `${artifact.storyId}-${artifact.viewport}-${artifact.side}-${artifact.variant}.${artifact.media}`;
      await fs.writeFile(path.join(outputDir, filename), artifact.data);
      artifacts.push({
        filename, storyId: artifact.storyId, viewport: artifact.viewport,
        side: artifact.side, variant: artifact.variant, media: artifact.media,
        contentType: artifact.contentType, bytes: artifact.bytes, sha256: artifact.sha256,
      });
    }
    const reviewExports = await exportReviewVideos(outputDir, artifacts.filter((artifact) => artifact.variant === 'animation'));
    await fs.writeFile(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const manifest = {
      version: 2, kind: 'local_git_fixture', runId,
      passed: true, planHash: contract.planHash(plan), provenance,
      fixture: { baseSha: fixture.baseSha, headSha: fixture.headSha,
        changePatch: 'change.patch', gitBundle: 'fixture.bundle' },
      replayPasses: [first.result, second.result],
      replayEvents: [{ pass: 1, events: first.events }, { pass: 2, events: second.events }],
      verdict, artifacts, reviewExports,
    };
    await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Captured ${artifacts.length} protocol artifacts and ${reviewExports.length} review videos after two matching passes.\n${outputDir}\n`);
    return { outputDir, artifacts, reviewExports };
  } finally {
    await stopFixtures(containerNames);
    await docker(['network', 'rm', network], 15_000).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run test:visual-evidence:local -- [--plan FILE] [--output-dir DIR]\n');
    return;
  }
  await run(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, docker, fixtureImageDigest, createGitFixture,
  startFixture, stopFixtures, exportReviewVideos, run,
};
