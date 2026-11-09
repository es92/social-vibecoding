// Unit tests for services/deploy-failure.js (#416): the shared
// build/deploy failure classifier behind apps.last_failure and the
// "View build log" panel. Pins the contracts the UI + persist paths
// rely on: stage detection from the error markers docker.js attaches
// (healthcheckFailed / buildFailed / cloneFailed), last-error-line
// extraction, ANSI stripping, and the 280-char / 16 kB caps. Also
// pins that visuals.summarizeBootFailure still returns the legacy
// string shape after its move here.
//
// Run with: node --test tests/deploy-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const deployFailure = require('../src/services/deploy-failure');

test('healthcheck failure picks the last error-ish container-log line', () => {
  const err = new Error('Healthcheck failed after 30 attempts: usernode-app-x');
  err.healthcheckFailed = true;
  err.containerStatus = 'exited (exit=1)';
  err.containerLogs = [
    '> start',
    '> node server.js',
    "Error: Cannot find module './lib/dapp-server'",
    'Require stack:',
    '- /app/server.js',
  ].join('\n');

  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'healthcheck');
  // Last matching error line wins, with the container status prefixed —
  // same shape the staging checks pipeline stores in check_error_detail.
  assert.equal(out.reason, "[exited (exit=1)] Error: Cannot find module './lib/dapp-server'");
  assert.ok(out.log.includes("Cannot find module './lib/dapp-server'"));
});

test('build failure extracts the stderr tail and prefixes "Build failed:"', () => {
  const err = new Error('Command failed: docker build …');
  err.buildFailed = true;
  err.buildLog = [
    'Step 1/4 : FROM node:20-alpine',
    'Sending build context…',
    'ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory',
  ].join('\n');

  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'build');
  assert.ok(out.reason.startsWith('Build failed:'));
  assert.ok(out.reason.includes('failed to read dockerfile'));
  assert.ok(out.log.includes('Step 1/4'));
});

test('build timeout (err.killed) synthesizes the timeout reason', () => {
  const err = new Error('Command failed');
  err.buildFailed = true;
  err.killed = true;
  err.buildLog = 'Step 3/9 : RUN npm ci';
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'build');
  assert.equal(out.reason, 'Build timed out after 5 minutes');
});

test('cloneFailed marker maps to the clone stage with err.message fallback', () => {
  const err = new Error("fatal: repository 'https://github.com/x/y.git' not found");
  err.cloneFailed = true;
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'clone');
  assert.ok(out.reason.includes('not found'));
});

test('unmarked errors classify as other, no .stderr needed (timeout/ENOENT shape)', () => {
  const err = new Error('spawn git ENOENT');
  const out = deployFailure.classify(err);
  assert.equal(out.stage, 'other');
  assert.equal(out.reason, 'spawn git ENOENT');
  assert.equal(out.log, '');
});

test('ANSI escapes are stripped and the log tail is capped at 16 kB', () => {
  const noisy = `\x1b[31mred error line\x1b[0m`;
  assert.equal(deployFailure.truncateLog(noisy), 'red error line');

  const huge = 'x'.repeat(20 * 1024) + '\nfinal line';
  const tail = deployFailure.truncateLog(huge);
  assert.ok(tail.length <= deployFailure.MAX_LOG);
  assert.ok(tail.endsWith('final line'));
});

test('reason is capped at 280 chars with an ellipsis', () => {
  const err = new Error('e'.repeat(500));
  const out = deployFailure.classify(err);
  assert.equal(out.reason.length, deployFailure.MAX_REASON);
  assert.ok(out.reason.endsWith('…'));
});

test('record() carries stage/reason/log plus timestamp and sha', () => {
  const err = new Error('boom');
  err.buildFailed = true;
  err.buildLog = 'ERROR: something failed';
  const rec = deployFailure.record(err, { sha: 'abc1234def' });
  assert.equal(rec.stage, 'build');
  assert.equal(rec.sha, 'abc1234def');
  assert.ok(!Number.isNaN(new Date(rec.at).getTime()));
});

test('syntheticRecord() shapes watchdog/kickoff failures', () => {
  const rec = deployFailure.syntheticRecord('timeout', 'App creation timed out after 5 minutes');
  assert.equal(rec.stage, 'timeout');
  assert.equal(rec.reason, 'App creation timed out after 5 minutes');
  assert.equal(rec.log, '');
  assert.equal(rec.sha, null);
});

test('summarizeBootFailure keeps the legacy string shape (containerStatus prefix, message fallback)', () => {
  // Via the shared module…
  const err = new Error('Healthcheck failed after 30 attempts: x');
  err.containerStatus = 'exited (exit=137)';
  err.containerLogs = 'JavaScript heap out of memory\ncannot allocate';
  const s = deployFailure.summarizeBootFailure(err);
  assert.equal(s, '[exited (exit=137)] cannot allocate');

  // …and no-logs errors fall back to err.message.
  const bare = deployFailure.summarizeBootFailure(new Error('plain failure'));
  assert.equal(bare, 'plain failure');
});

test('a refused `docker run` surfaces the daemon reason, not the argv', () => {
  // execFile formats its rejection message as `Command failed: <argv>\n<stderr>`,
  // and a `docker run` argv is every -e env var — kilobytes of it. The reason
  // budget is 280 chars, so the author used to see nothing but a truncated
  // command line. The container never started, so there are no containerLogs;
  // the daemon's explanation is only ever on stderr.
  const argv = `docker run -d --name usernode-staging-x--1 --hostname usernode-staging-x--1 ${
    Array.from({ length: 40 }, (_, i) => `-e SOME_LONG_ENV_VAR_${i}=some-fairly-long-value-${i}`).join(' ')
  } usernode-staging-x:abc123`;
  const stderr = 'docker: Error response from daemon: failed to create task for container: '
    + 'failed to create shim task: OCI runtime create failed: runc create failed: '
    + 'unable to start container process: error during container init: '
    + 'sethostname: invalid argument: unknown.';
  const err = new Error(`Command failed: ${argv}\n${stderr}`);
  err.stderr = stderr;
  err.stdout = '';

  const reason = deployFailure.summarizeBootFailure(err);
  assert.match(reason, /sethostname/,
    'the daemon said why it refused; that is the only useful part');
  assert.ok(!reason.startsWith('Command failed: docker run'),
    'the argv must not eat the whole reason budget');
  assert.ok(reason.length <= 280);

  // Same error with no .stderr property still recovers the tail from the
  // message, because execFile has already appended stderr there.
  const noStderr = new Error(`Command failed: ${argv}\n${stderr}`);
  assert.match(deployFailure.summarizeBootFailure(noStderr), /sethostname/);

  // And it flows through classify(), which is what persists last_failure.
  const classified = deployFailure.classify(err);
  assert.match(classified.reason, /sethostname/);
});

test('containerLogs still win over stderr when the container did boot', () => {
  // A crash-on-boot has both: the logs are the app's own message and stay
  // the better answer. Only a container that never started falls to stderr.
  const err = new Error('Command failed: docker run -d --name x\nsome docker noise');
  err.stderr = 'some docker noise';
  err.containerLogs = 'Error: connect ECONNREFUSED 127.0.0.1:5432';
  assert.equal(
    deployFailure.summarizeBootFailure(err),
    'Error: connect ECONNREFUSED 127.0.0.1:5432'
  );
});

// 21 Oct 2026: GitHub's secondary limit refused new repositories, and the
// made screen showed GitHub's text about scraping and its terms of service.
test('a new repository GitHub refused for going too fast is said in words; other repository failures keep GitHub\'s', () => {
  const slowDown = Object.assign(new Error('You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later. For more on scraping GitHub and how it may affect your rights, please review our Terms of Service'),
    { status: 403, repoFailed: true });
  const slow = deployFailure.record(slowDown, { stage: 'repo' });
  assert.equal(slow.stage, 'repo');
  assert.equal(slow.reason, deployFailure.REPO_SLOW_DOWN);
  assert.doesNotMatch(slow.reason, /Terms of Service/);
  const hourly = deployFailure.record(Object.assign(new Error('API rate limit exceeded for user'), { status: 403, repoFailed: true }), { stage: 'repo' });
  assert.equal(hourly.reason, 'GitHub repo creation failed: API rate limit exceeded for user');
  // Only a repository's: the same words from a build are the build's own line.
  const elsewhere = deployFailure.record(Object.assign(new Error('secondary rate limit'), {}), { stage: 'other' });
  assert.equal(elsewhere.reason, 'secondary rate limit');
});

// #6536: PR 6256 sat with no preview build from 4 Nov because a sync broke a
// .tsx file's comment and every build failed with only "BackoffLimitExceeded".
// The Pod log had the real error; the checks never read it.
test('a failed build says its own first error, with the file and line', () => {
  const err = new Error('BuildKit Job bk-10 failed: BackoffLimitExceeded');
  err.buildFailed = true;
  err.buildLog = [
    'vite v5.4.21 building for production...',
    'transforming...',
    '✓ 1482 modules transformed.',
    '✗ Build failed in 1.2s',
    'error during build:',
    'frontend/src/features/ai/index.tsx:104:1: ERROR: Unexpected "**"',
    '    at failureErrorWithLog (/app/node_modules/esbuild/lib/main.js:1472:15)',
  ].join('\n');

  const build = deployFailure.firstBuildError(err);
  assert.equal(build.line, 'frontend/src/features/ai/index.tsx:104:1: ERROR: Unexpected "**"',
    'the specific file:line:col line wins over Vite\'s heading');
  assert.match(build.excerpt, /error during build:/);
  assert.match(build.excerpt, /index\.tsx:104:1/);
  assert.doesNotMatch(build.excerpt, /failureErrorWithLog/, 'the stack after the error is not kept');

  assert.equal(deployFailure.summarizeBootFailure(err),
    'The preview build failed: frontend/src/features/ai/index.tsx:104:1: ERROR: Unexpected "**"');
});

test('a failed build\'s log is scrubbed before it is kept', () => {
  const err = new Error('build failed');
  err.buildFailed = true;
  err.buildLog = 'ERROR: unable to push with token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const build = deployFailure.firstBuildError(err);
  assert.ok(build);
  assert.doesNotMatch(build.line, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.doesNotMatch(build.excerpt, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(build.line, /\*{4}/);
});

test('a timed-out build, or a log with no error line, keeps the reason it had', () => {
  const timedOut = new Error('Command failed');
  timedOut.buildFailed = true;
  timedOut.killed = true;
  timedOut.buildLog = 'Step 3/9 : RUN npm ci';
  assert.equal(deployFailure.firstBuildError(timedOut), null);
  const killed = deployFailure.classify(timedOut);
  assert.equal(killed.reason, 'Build timed out after 5 minutes');

  const quiet = new Error('Job bk-10 failed: BackoffLimitExceeded');
  quiet.buildFailed = true;
  quiet.buildLog = 'Step 1/4 : FROM node:22\nStep 2/4 : RUN npm ci';
  assert.equal(deployFailure.firstBuildError(quiet), null);
  assert.equal(deployFailure.summarizeBootFailure(quiet), 'Job bk-10 failed: BackoffLimitExceeded');
});

