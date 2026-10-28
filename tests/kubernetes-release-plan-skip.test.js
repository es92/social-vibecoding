'use strict';

// The plan job's "Check whether this run can release" and "Select release
// work" steps, run as they are written in
// .github/workflows/build-kubernetes-images.yml against stand-ins for git, gh
// and helm.
//
// Runs on main are queued one at a time, and a run whose commit is no longer
// main's tip used to build all three images and then skip its publish. In a
// burst of merges the run that would release waited behind builds nobody
// used. A run behind the tip that the publish step could not let release
// ahead of it now builds nothing: the newest release already contains it, or
// that release's revision merged under RELEASE_EVERY_MINUTES before it. The
// tip always builds, and anything unreadable builds, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
const plan = workflow.jobs.plan.steps;
const behindStep = plan.find((s) => s.name === 'Check whether this run can release');
const selectStep = plan.find((s) => s.name === 'Select release work');
const publishStep = workflow.jobs.release.steps.find((s) => s.name === 'Check branch tip before publishing');

const sha = (c) => c.repeat(40);
const OLD = sha('a'); // the newest release's revision
const MINE = sha('b'); // this run's revision
const TIP = sha('c'); // main's tip now
const T0 = 1_791_200_000;

const STUBS = {
  git: `#!/usr/bin/env bash
[ "$1" = ls-remote ] || exit 2
[ -s "$STUB_TIP" ] || exit 2
printf '%s\\t%s\\n' "$(cat "$STUB_TIP")" "$4"
`,
  gh: `#!/usr/bin/env bash
path="$2"
case "$path" in
  */compare/*) pair="\${path##*/compare/}"; key="compare \${pair%%...*} \${pair##*...}";;
  */commits/*) key="date \${path##*/commits/}";;
  *) exit 2;;
esac
value="$(sed -n "s/^$key //p" "$STUB_GH" | tail -n 1)"
[ -n "$value" ] || exit 1
echo "$value"
`,
  helm: `#!/usr/bin/env bash
echo "$*" >> "$STUB_HELM_LOG"
[ -s "$STUB_HELM" ] || exit 1
cat "$STUB_HELM"
`,
};

function runBehind({ tip = TIP, gh = [], helm = `apiVersion: v2\nappVersion: ${OLD}\nversion: 0.1.1545001\n` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const files = {
    tip: path.join(dir, 'tip'), gh: path.join(dir, 'gh'), helm: path.join(dir, 'helm'),
    helmLog: path.join(dir, 'helm.log'), output: path.join(dir, 'output'), script: path.join(dir, 'step.sh'),
  };
  fs.writeFileSync(files.tip, tip || '');
  fs.writeFileSync(files.gh, gh.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(files.helm, helm || '');
  for (const f of ['helmLog', 'output']) fs.writeFileSync(files[f], '');
  fs.writeFileSync(files.script, behindStep.run);
  try {
    const res = spawnSync('bash', [files.script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REF: 'refs/heads/main', GITHUB_SHA: MINE, GITHUB_REPOSITORY: 'Usernode-Labs/social-vibecoding',
        GITHUB_REPOSITORY_OWNER: 'Usernode-Labs', GITHUB_OUTPUT: files.output,
        RELEASE_EVERY_MINUTES: String(behindStep.env.RELEASE_EVERY_MINUTES),
        STUB_TIP: files.tip, STUB_GH: files.gh, STUB_HELM: files.helm, STUB_HELM_LOG: files.helmLog,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = Object.fromEntries(fs.readFileSync(files.output, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { skip: out.skip === 'true', reason: out.reason || '', helmCalls: fs.readFileSync(files.helmLog, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// main moved on from this run's commit, the newest release is older than it,
// and the two revisions merged `minutes` apart.
const behind = (minutes) => [`compare ${OLD} ${MINE} ahead`, `date ${OLD} ${T0}`, `date ${MINE} ${T0 + minutes * 60}`];

test('the step runs only for pushes to main, and its interval is the publish step\'s', () => {
  assert.ok(behindStep && selectStep);
  assert.equal(behindStep.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(String(behindStep.env.RELEASE_EVERY_MINUTES), String(publishStep.env.RELEASE_EVERY_MINUTES));
  assert.ok(plan.indexOf(behindStep) < plan.indexOf(selectStep), 'decided before the release work is selected');
});

test('main\'s tip always builds', () => {
  assert.equal(runBehind({ tip: MINE, gh: behind(1) }).skip, false);
});

test('a run behind the tip that could not release ahead of it builds nothing', () => {
  const r = runBehind({ gh: behind(5) });
  assert.equal(r.skip, true);
  assert.match(r.reason, /^No build: main is at c{40}, whose run releases b{40}, and the newest release \(a{40}\) is under 15 minutes older/);
  assert.match(r.helmCalls, /show chart oci:\/\/ghcr\.io\/usernode-labs\/charts\/social-vibecoding-platform --version 0\.1\.\*/,
    'the registry the publish step reads, with the owner lowercased');
});

test('a run whose commit the newest release already contains builds nothing', () => {
  for (const status of ['behind', 'identical']) {
    const r = runBehind({ gh: [`compare ${OLD} ${MINE} ${status}`] });
    assert.equal(r.skip, true, status);
    assert.match(r.reason, /already contains b{40}/);
  }
});

test('a run behind the tip that may still release ahead of it builds, as the publish step allows', () => {
  assert.equal(runBehind({ gh: behind(15) }).skip, false, 'at the interval itself');
  assert.equal(runBehind({ gh: behind(66) }).skip, false);
});

test('anything that cannot be read builds, as before', () => {
  for (const [why, opts] of [
    ['tip unreadable', { tip: '', gh: behind(1) }],
    ['registry unreadable', { gh: behind(1), helm: '' }],
    ['no appVersion', { gh: behind(1), helm: 'apiVersion: v2\nversion: 0.1.1545001\n' }],
    ['compare unreadable', { gh: [`date ${OLD} ${T0}`, `date ${MINE} ${T0 + 60}`] }],
    ['diverged', { gh: [`compare ${OLD} ${MINE} diverged`, `date ${OLD} ${T0}`, `date ${MINE} ${T0 + 60}`] }],
    ['merge times unreadable', { gh: [`compare ${OLD} ${MINE} ahead`] }],
  ]) {
    assert.equal(runBehind(opts).skip, false, why);
  }
});

function runSelect(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-select-'));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  fs.writeFileSync(output, '');
  fs.writeFileSync(summary, '');
  try {
    const res = spawnSync('bash', ['-c', selectStep.run], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, CLAUDE_CODE_VERSION: '1.0.0', ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = fs.readFileSync(output, 'utf8');
    return { shouldRelease: /should_release=true/.test(out), matrix: /"component":"platform"/.test(out), summary: fs.readFileSync(summary, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Select release work: a run that can release builds and publishes; one that cannot, neither', () => {
  const normal = runSelect({ GITHUB_EVENT_NAME: 'push', BEHIND_SKIP: 'false' });
  assert.equal(normal.shouldRelease, true);
  assert.match(normal.summary, /Normal source release\./);
  const skipped = runSelect({ GITHUB_EVENT_NAME: 'push', BEHIND_SKIP: 'true', BEHIND_REASON: 'No build: main is at x.' });
  assert.equal(skipped.shouldRelease, false);
  assert.match(skipped.summary, /No build: main is at x\./);
  const dispatched = runSelect({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(dispatched.shouldRelease, true, 'a run dispatched by hand is never held back');
  // The build and the release job both follow should_release.
  assert.equal(workflow.jobs.build.if, "needs.plan.outputs.should_release == 'true'");
  assert.deepEqual([].concat(workflow.jobs.release.needs),
    ['build', 'scheduled-image-audit', 'security-lockfiles', 'security-regressions', 'preview-schema-compatibility']);
});
