const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm session and capture settings reach the runtime as decimal strings, including zero', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'session-config-test', 'deploy/helm/social-vibecoding-platform',
    '--show-only', 'templates/platform.yaml', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  for (const [overrides, expected] of [
    [[], { MAX_GLOBAL_SESSIONS: '25', WORKER_IDLE_EVICTION_MS: '600000', SESSION_AUTOPAUSE_IDLE_MS: '300000', CAPTURE_CPUS: '8', SHOTS_ENABLED: 'true' }],
    [['--set', 'config.maxGlobalSessions=100,config.workerIdleEvictionMs=300000,config.sessionAutopauseIdleMs=0,config.captureCpus=6'],
      { MAX_GLOBAL_SESSIONS: '100', WORKER_IDLE_EVICTION_MS: '300000', SESSION_AUTOPAUSE_IDLE_MS: '0', CAPTURE_CPUS: '6', SHOTS_ENABLED: 'true' }],
    // The checks queue's cap (services/checks-queue.js); 0 turns it off.
    [['--set', 'config.checksMaxConcurrentRuns=0'],
      { MAX_GLOBAL_SESSIONS: '25', CAPTURE_CPUS: '8', CHECKS_MAX_CONCURRENT_RUNS: '0' }],
    [['--set', 'config.checksMaxConcurrentRuns=6'],
      { MAX_GLOBAL_SESSIONS: '25', CAPTURE_CPUS: '8', CHECKS_MAX_CONCURRENT_RUNS: '6' }],
    [['--set', 'platform.shotsEnabled=false'],
      { MAX_GLOBAL_SESSIONS: '25', WORKER_IDLE_EVICTION_MS: '600000', SESSION_AUTOPAUSE_IDLE_MS: '300000', CAPTURE_CPUS: '8', SHOTS_ENABLED: 'false' }],
    [['--set', 'config.previewSleepAfterMs=1800000,config.appSleepAfterMs=0,config.checkNodePoolRequired=true',
      '--set-string', 'config.checkNodePool=pool=checks'],
      { PREVIEW_SLEEP_AFTER_MS: '1800000', APP_SLEEP_AFTER_MS: '0', EARLY_UNIT_SUITE: '0' }],
  ]) {
    const rendered = execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' });
    const env = Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)]
      .map(([, key, value]) => [key, value]));
    assert.equal(env.PLATFORM_SIGNALS, 'shadow', 'other platform signals retain their mode');
    assert.equal(env.PLATFORM_SIGNALS_SECURITY_AUDIT, 'on', 'only security filing opts in');
    for (const [name, value] of Object.entries({
      CHECKS_MAX_CONCURRENT_RUNS: '4',
      ...expected, MAX_USER_SESSIONS: '3', MAX_USER_PROMOTED_SESSIONS: '5',
      MAX_ADMIN_USER_SESSIONS: '5', MAX_ADMIN_USER_PROMOTED_SESSIONS: '8',
      STAGING_IDLE_TEARDOWN_MS: '21600000',
      PREVIEW_SLEEP_AFTER_MS: '3600000', APP_SLEEP_AFTER_MS: '3600000',
      ...expected,
    })) {
      assert.equal(env[name], value, name);
      assert.equal(parseInt(env[name], 10), Number(value), `${name} application parsing`);
    }
    // The preview machine is the only path; its flag is no longer rendered.
    assert.equal(env.WF_PREVIEWS_ENABLED, undefined, 'WF_PREVIEWS_ENABLED is gone');
    assert.equal(env.EARLY_UNIT_SUITE, expected.EARLY_UNIT_SUITE,
      'required mode disables early suites; other modes preserve an imported switch');
  }
  const securityOff = execFileSync('helm', [...args, '--set-string', 'config.platformSignals.securityAudit=off'], { encoding: 'utf8' });
  assert.match(securityOff, /name: PLATFORM_SIGNALS_SECURITY_AUDIT, value: "off"/);
  assert.throws(() => execFileSync('helm', [...args, '--set',
    'config.checkNodePoolRequired=true,config.checksMaxConcurrentRuns=0',
    '--set-string', 'config.checkNodePool=pool=checks'], { encoding: 'utf8', stdio: 'pipe' }),
  /requires a positive config.checksMaxConcurrentRuns/);
});
