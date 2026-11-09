'use strict';

// The security gates block only what a change introduces (29 Oct 2026): a
// finding on a package the baseline (a pull request's base, or what is live)
// already ships at the same version is reported, not failed. Every release
// on main had failed for hours on an advisory published that afternoon
// against decode-uri-component 0.2.2, which production already ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { npmGate, npmFindings, imageGate, imageFindings, lockPackages, sbomPackages, report, imageAssessment } = require('../scripts/security-findings');
const { buildBaseline } = require('../scripts/security-image-baseline');
const { baselineLock } = require('../scripts/security-audit');
const { parseReleaseValues, liveRelease } = require('../scripts/live-release');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-29T19:00:00Z');

// An npm audit of the root lockfile, as `npm audit --json` shapes it.
function audit(name, node, severity = 'high', id = 'GHSA-qr28-fpjm-wq7f') {
  return {
    metadata: { vulnerabilities: { high: 1 } },
    vulnerabilities: { [name]: { nodes: [node], via: [{ severity, url: `https://github.com/advisories/${id}` }] } },
  };
}
const LOCK = { packages: {
  '': { name: 'social-vibecoding' },
  'node_modules/minio': { version: '8.0.7' },
  'node_modules/query-string': { version: '7.1.3' },
  'node_modules/query-string/node_modules/decode-uri-component': { version: '0.2.2' },
  'node_modules/@scope/pkg': { version: '1.0.0' },
} };

test('a lockfile lists every package@version it installs, nested and scoped', () => {
  assert.deepEqual([...lockPackages(LOCK)].sort(),
    ['@scope/pkg@1.0.0', 'decode-uri-component@0.2.2', 'minio@8.0.7', 'query-string@7.1.3']);
  assert.equal(lockPackages(null).size, 0);
});

test('a finding on a package the baseline already ships is reported, not blocking', () => {
  const findings = audit('decode-uri-component', 'node_modules/query-string/node_modules/decode-uri-component', 'high', 'GHSA-new-advisory');
  const shipped = npmGate(findings, LOCK, { now: NOW, baseline: lockPackages(LOCK) });
  assert.deepEqual(shipped, { blocking: [], preexisting: ['decode-uri-component@0.2.2: GHSA-new-advisory'] });
  // The change upgraded into it, or added it: blocking.
  const before = lockPackages({ packages: { 'node_modules/decode-uri-component': { version: '0.2.1' } } });
  assert.deepEqual(npmGate(findings, LOCK, { now: NOW, baseline: before }).blocking, ['decode-uri-component@0.2.2: GHSA-new-advisory']);
  // No baseline: every finding blocks, as before.
  assert.deepEqual(npmGate(findings, LOCK, { now: NOW }).blocking, ['decode-uri-component@0.2.2: GHSA-new-advisory']);
  assert.deepEqual(npmFindings(findings, LOCK, NOW), ['decode-uri-component@0.2.2: GHSA-new-advisory'], 'the strict wrapper keeps its meaning');
  // Moderate findings never gate.
  const moderate = audit('decode-uri-component', 'node_modules/query-string/node_modules/decode-uri-component', 'moderate', 'GHSA-new-advisory');
  assert.deepEqual(npmGate(moderate, LOCK, { now: NOW }), { blocking: [], preexisting: [] });
});

test('an exception still lets an introduced finding through', () => {
  const excepted = audit('zod', 'node_modules/zod', 'high', 'GHSA-mrhx-c7xc-m3w5');
  const lock = { packages: { 'node_modules/zod': { version: '3.25.76' } } };
  assert.deepEqual(npmGate(excepted, lock, { now: Date.parse('2026-10-29'), baseline: new Set() }), { blocking: [], preexisting: [] });
});

test('an image finding on a package the live image already ships is reported, not blocking', () => {
  const scan = { SchemaVersion: 2, Results: [{ Target: 'usr/local/bin/node', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'libssl3', InstalledVersion: '3.0.15-1~deb12u1', VulnerabilityID: 'CVE-2026-1', FixedVersion: '3.0.16-1~deb12u1' },
    { Severity: 'CRITICAL', PkgName: 'newlib', InstalledVersion: '1.0.0', VulnerabilityID: 'CVE-2026-2', FixedVersion: '1.0.1' },
    { Severity: 'HIGH', PkgName: 'unfixable', InstalledVersion: '1.0.0', VulnerabilityID: 'CVE-2026-3' },
  ] }] };
  const live = sbomPackages({ spdxVersion: 'SPDX-2.3', packages: [
    { name: 'libssl3', versionInfo: '3.0.15-1~deb12u1' }, { name: 'unfixable', versionInfo: '1.0.0' }, { name: 'noversion' },
  ] });
  assert.deepEqual(imageGate(scan, { now: NOW, component: 'platform', baseline: live }), {
    blocking: ['usr/local/bin/node: newlib@1.0.0: CVE-2026-2 (fix 1.0.1)'],
    preexisting: ['usr/local/bin/node: libssl3@3.0.15-1~deb12u1: CVE-2026-1 (fix 3.0.16-1~deb12u1)'],
  });
  assert.equal(imageFindings(scan, NOW, 'platform').length, 2, 'the strict wrapper still blocks both fixable findings');
  assert.throws(() => sbomPackages({ spdxVersion: 'SPDX-2.3', packages: [] }), /Missing or empty baseline SPDX SBOM/);
});

// The identity shapes in the failed worker scan of esbuild@0.25.12.
const goInventory = (version = 'go1.23.12', purl = `pkg:golang/stdlib@${version.replace(/^(go|v)/, '')}`) => sbomPackages({
  spdxVersion: 'SPDX-2.3', packages: [{ name: 'stdlib', versionInfo: version,
    externalRefs: purl ? [{ referenceType: 'purl', referenceLocator: purl }] : [] }],
});
const goScan = (version = 'v1.23.12', type = 'gobinary', purl = `pkg:golang/stdlib@${version}`) => ({ SchemaVersion: 2, Results: [{
  Type: type, Target: 'esbuild/bin/esbuild', Vulnerabilities: [{
    PkgName: 'stdlib', InstalledVersion: version, PkgIdentifier: { PURL: purl },
    Severity: 'HIGH', VulnerabilityID: 'CVE-2025-68121', FixedVersion: '1.25.7',
  }],
}] });

test('confirmed Go stdlib versions compare across scanner prefixes without changing the reported facts', () => {
  for (const baselineVersion of ['go1.23.12', '1.23.12', 'v1.23.12']) {
    const baseline = goInventory(baselineVersion);
    assert.deepEqual([...baseline], ['pkg:golang/stdlib@1.23.12']);
    for (const version of ['go1.23.12', '1.23.12', 'v1.23.12']) for (const type of ['gobinary', 'gomod']) {
      const scan = goScan(version, type);
      const result = imageGate(scan, { component: 'worker', baseline, now: NOW });
      assert.equal(result.blocking.length, 0, `${baselineVersion} -> ${type} ${version}`);
      assert.deepEqual(result.preexisting, [`esbuild/bin/esbuild: stdlib@${version}: CVE-2025-68121 (fix 1.25.7)`]);
      const assessment = imageAssessment([scan], { component: 'worker', baseline, now: NOW });
      assert.equal(assessment.status, 'existing_findings');
      assert.equal(assessment.findings[0].version, version, 'retain the raw scanner version');
      assert.deepEqual(imageAssessment([scan], { component: 'worker', baseline, audit: true, now: NOW }).findings, assessment.findings);
    }
    assert.equal(imageGate(goScan('v1.23.13'), { baseline, now: NOW }).blocking.length, 1, 'a different patch version blocks');
  }
  assert.equal(imageGate(goScan(), { now: NOW }).blocking.length, 1, 'no baseline remains strict');
  assert.equal(imageFindings(goScan(), NOW, 'worker').length, 1, 'the strict wrapper still blocks');
});

test('Go stdlib prefix comparison requires matching Go metadata on both sides', () => {
  for (const purl of [null, 'pkg:npm/stdlib@1.23.12', 'pkg:golang/stdlib@1.23.13']) {
    assert.equal(imageGate(goScan(), { baseline: goInventory('v1.23.12', purl), now: NOW }).blocking.length, 1,
      'a confirmed Go candidate cannot fall back to an unqualified baseline');
  }
  for (const [type, purl] of [['gobinary', null], ['gobinary', 'pkg:golang/stdlib@1.23.13'],
    ['gobinary', 'pkg:npm/stdlib@v1.23.12'], ['node-pkg', 'pkg:golang/stdlib@v1.23.12'], [null, 'pkg:golang/stdlib@v1.23.12']]) {
    assert.equal(imageGate(goScan('v1.23.12', type, purl), { baseline: goInventory('v1.23.12'), now: NOW }).blocking.length, 1,
      'a candidate without confirmed Go identity cannot match the qualified baseline');
  }
});

test('Go stdlib baselines cannot waive an npm namesake in either comparison direction', () => {
  for (const version of ['go1.23.12', '1.23.12', 'v1.23.12']) {
    const goBaseline = goInventory(version);
    const npmBaseline = goInventory(version, `pkg:npm/stdlib@${version}`);
    for (const type of ['node-pkg', 'npm']) {
      assert.equal(imageGate(goScan(version, type, `pkg:npm/stdlib@${version}`), { baseline: goBaseline, now: NOW }).blocking.length, 1);
    }
    assert.equal(imageGate(goScan(version), { baseline: npmBaseline, now: NOW }).blocking.length, 1,
      'a Go candidate cannot match an npm-only baseline at the same raw version');
    for (const type of ['gobinary', 'gomod']) for (const purl of [null, `pkg:npm/stdlib@${version}`, 'pkg:golang/stdlib@1.23.13']) {
      assert.equal(imageGate(goScan(version, type, purl), { baseline: npmBaseline, now: NOW }).blocking.length, 1,
        'an unconfirmed Go candidate cannot fall back to an npm baseline');
    }
    const lock = { packages: { 'node_modules/stdlib': { version } } };
    const findings = audit('stdlib', 'node_modules/stdlib');
    assert.equal(npmGate(findings, lock, { baseline: goBaseline, now: NOW }).blocking.length, 1);
    assert.equal(npmGate(findings, lock, { baseline: lockPackages(lock), now: NOW }).preexisting.length, 1, 'exact npm lock comparison is unchanged');
  }
  const lock = { packages: { 'node_modules/stdlib': { version: 'v1.23.12' } } };
  const oldLock = { packages: { 'node_modules/stdlib': { version: 'go1.23.12' } } };
  assert.equal(npmGate(audit('stdlib', 'node_modules/stdlib'), lock, { baseline: lockPackages(oldLock), now: NOW }).blocking.length, 1,
    'npm lock versions do not gain Go prefix normalization');
});

test('the gate writes the annotations the platform reads to say why a release is blocked', () => {
  const lines = [];
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-summary-')), 'summary.md');
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    report('root lockfile', { blocking: ['a@1.0.0: GHSA-x'], preexisting: ['b@2.0.0: GHSA-y'] },
      { log: (line) => lines.push(line), baselineName: 'the live release (a5f91bc5f)' });
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previous;
  }
  assert.deepEqual(lines, [
    '::error title=Security gate: root lockfile::a@1.0.0: GHSA-x',
    '::warning title=Already shipped: root lockfile::b@2.0.0: GHSA-y (already in the live release (a5f91bc5f); not introduced by this change)',
  ]);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /\*\*Blocking: introduced by this change\*\*\n\n- a@1\.0\.0: GHSA-x/);
  assert.match(text, /\*\*Already shipped in the live release \(a5f91bc5f\): reported, not blocking\*\*\n\n- b@2\.0\.0: GHSA-y/);
});

test('the baseline lockfile is read at the baseline commit; one that cannot be read is no baseline', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-baseline-'));
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'frontend'));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify(LOCK));
  fs.writeFileSync(path.join(repo, 'frontend', 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/react': { version: '19.2.0' } } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  assert.ok(baselineLock(repo, sha, '.').has('decode-uri-component@0.2.2'));
  assert.deepEqual([...baselineLock(repo, sha, 'frontend')], ['react@19.2.0']);
  assert.equal(baselineLock(repo, sha, 'src/templates/node-app'), null, 'no lockfile there at that commit');
  assert.equal(baselineLock(repo, 'f'.repeat(40), '.'), null, 'a commit the clone does not have');
  assert.equal(baselineLock(repo, '', '.'), null);
});

// The values.release.yaml the release job packages, as the live chart held it.
const VALUES = [
  '# Generated by .github/workflows/build-kubernetes-images.yml.',
  'release:',
  '  sourceRevision: "a5f91bc5ff8ebc2c255754663d48e62b699bcbea"',
  'platform:',
  '  image:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-platform',
  `    digest: sha256:${'f'.repeat(64)}`,
  '  workerImage:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-worker',
  `    digest: sha256:${'7'.repeat(64)}`,
  '  captureImage:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-capture',
  `    digest: sha256:${'4'.repeat(64)}`,
  '',
].join('\n');

test('what is live comes off the newest stable chart, and an unreadable chart is no baseline', () => {
  const live = {
    revision: 'a5f91bc5ff8ebc2c255754663d48e62b699bcbea',
    platform: `sha256:${'f'.repeat(64)}`, worker: `sha256:${'7'.repeat(64)}`, capture: `sha256:${'4'.repeat(64)}`,
  };
  assert.deepEqual(parseReleaseValues(VALUES), live);
  assert.equal(parseReleaseValues(VALUES.replace(/ {2}captureImage:[\s\S]*$/, '')), null, 'a digest missing');
  assert.equal(parseReleaseValues(VALUES.replace(/sourceRevision: .*/, 'sourceRevision: "main"')), null);

  const calls = [];
  const helm = (file, args) => {
    calls.push([file, ...args]);
    const dir = args[args.indexOf('--untardir') + 1];
    fs.mkdirSync(path.join(dir, 'social-vibecoding-platform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'social-vibecoding-platform', 'values.release.yaml'), VALUES);
    return { status: 0 };
  };
  assert.deepEqual(liveRelease('usernode-labs', { run: helm }), live);
  assert.deepEqual(calls[0].slice(0, 5), ['helm', 'pull', 'oci://ghcr.io/usernode-labs/charts/social-vibecoding-platform', '--version', '0.1.*'],
    'the newest stable chart: the one the plan job reads as published');
  assert.equal(liveRelease('usernode-labs', { run: () => ({ status: 1 }) }), null);
});

test('PR findings block against the exact base; post-merge findings are advisory', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  const step = (job, name) => workflow.jobs[job].steps.find((s) => s.name === name);
  // PRs and other release branches retain a lockfile baseline. Only protected
  // main can use advisory findings after its required pre-merge scans.
  const lockfiles = workflow.jobs['security-lockfiles'];
  const baseline = step('security-lockfiles', 'Fetch the baseline commit');
  assert.equal(baseline.if, "github.event_name == 'pull_request' || github.ref != 'refs/heads/main'");
  assert.equal(step('security-lockfiles', 'Read the live release').if, "github.event_name != 'pull_request' && github.ref != 'refs/heads/main'");
  assert.equal(baseline.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(baseline.env.LIVE_SHA, '${{ steps.live.outputs.revision }}');
  assert.match(baseline.run, /git fetch --no-tags --depth=1 origin "\$revision"/);
  const auditStep = lockfiles.steps.find((s) => s.run === 'node scripts/security-audit.js');
  assert.deepEqual(auditStep.env, {
    SECURITY_BASELINE_REVISION: '${{ steps.baseline.outputs.revision }}',
    SECURITY_BASELINE_NAME: '${{ steps.baseline.outputs.name }}',
    SECURITY_AUDIT_ONLY: "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && '1' || '0' }}",
  });
  // PR images use the exact PR base, including standalone and starter.
  const prScan = step('security-images', 'Build and scan the finished image');
  assert.equal(prScan.env.SECURITY_BASELINE_REVISION, '${{ github.event.pull_request.base.sha }}');
  assert.equal(prScan.env.SECURITY_SCAN_PLATFORM, 'linux/amd64');
  assert.equal(prScan.env.SECURITY_AUDIT_ONLY, undefined, 'PRs retain the blocking scanner default');
  assert.equal(workflow.jobs['security-images'].steps.some((s) => s.uses?.startsWith('actions/cache')), false,
    'PR-written inventories cannot be persisted then reused by a later revision');
  const releaseScan = step('build', 'Verify runtime and scan the exact image SBOM');
  assert.equal(releaseScan.env.SECURITY_AUDIT_ONLY, "${{ github.ref == 'refs/heads/main' && '1' || '0' }}");
  assert.equal(releaseScan.env.LIVE_DIGEST, '${{ steps.live.outputs[matrix.component] }}');
  assert.match(releaseScan.run, /export BASELINE_IMAGE="ghcr\.io\/\$REGISTRY_OWNER\/social-vibecoding-\$\{\{ matrix\.component \}\}@\$LIVE_DIGEST"/);
  assert.match(releaseScan.run, /sh scripts\/check-published-image\.sh "\$IMAGE" "\$REPORT" "\$\{\{ matrix\.component \}\}"/);
  // Releases retain the immutable released-image comparison.
  for (const job of ['build']) {
    const names = workflow.jobs[job].steps.map((s) => s.name || s.uses);
    assert.ok(names.indexOf('Read the live release') > names.indexOf('azure/setup-helm@v4'), `${job}: helm is set up first`);
  }
  // The image check passes the baseline SBOM to the findings, and only when read.
  const check = fs.readFileSync(path.join(ROOT, 'scripts/check-image-security.sh'), 'utf8');
  assert.match(check, /docker buildx imagetools inspect "\$BASELINE_IMAGE" --format '\{\{json \.SBOM\}\}'/);
  assert.match(check, /node scripts\/security-findings\.js --assess "\$out" "\$component" "\$baseline"/);
  assert.match(check, /elif \[ -n "\$\{SECURITY_BASELINE_REVISION:-\}" \]/);
});

// A fake `docker` that records each call and writes what the scan steps read:
// Trivy's reports into the mounted /output, an SBOM attestation, a saved tar.
function fakeDocker(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "${path.join(dir, 'calls.log')}"
out=; prev=; report=
for a in "$@"; do
  case "$prev" in -v) case "$a" in *:/output) out="\${a%:/output}" ;; esac ;; --output) report="\${a#/output/}" ;; -o) [ "$a" = spdx-json ] || touch "$a" ;; esac
  prev="$a"
done
case "$*" in
  *"image inspect"*) echo "sha256:${'e'.repeat(64)}" ;;
  *"anchore/syft"*) cat "${path.join(dir, 'baseline.json')}" ;;
  *"imagetools inspect"*) cat "${path.join(dir, 'attestation.json')}" ;;
  *"--entrypoint node"*) cat > /dev/null; [ "\${FAKE_RUNTIME_FAILURE:-}" != 1 ] || exit 8; echo '{}' ;;
  *" image --skip-db-update"*) [ "\${FAKE_IMAGE_SCAN_FAILURE:-}" != 1 ] || exit 9; cp "${path.join(dir, 'report.json')}" "$out/$report" ;;
  *" sbom "*) cp "${path.join(dir, 'report.json')}" "$out/$report" ;;
esac
`, { mode: 0o755 });
  return bin;
}

test('an image with the same digest as the live image is not pulled, saved or rescanned, and cannot block', () => {
  const live = 'ghcr.io/usernode-labs/social-vibecoding-worker@sha256:' + 'c'.repeat(64);
  const other = 'ghcr.io/usernode-labs/social-vibecoding-worker@sha256:' + 'd'.repeat(64);
  const sbom = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'libssl3', versionInfo: '3.0.15-1~deb12u1' }] };
  // A fixable HIGH on a package the image ships: only the live image's own
  // SBOM makes it "already shipped".
  const report = { SchemaVersion: 2, Results: [{ Target: 'worker', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'libssl3', InstalledVersion: '3.0.15-1~deb12u1', VulnerabilityID: 'CVE-2026-9', FixedVersion: '3.0.16-1~deb12u1' },
  ] }] };
  const run = (image, baselineImage, attestation) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-'));
    const out = path.join(dir, 'out');
    fs.writeFileSync(path.join(dir, 'sbom.spdx.json'), JSON.stringify(sbom));
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(dir, 'attestation.json'), JSON.stringify(attestation));
    const res = spawnSync('sh', ['scripts/check-image-security.sh', image, out, path.join(dir, 'sbom.spdx.json'), 'worker'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeDocker(dir)}:${process.env.PATH}`, BASELINE_IMAGE: baselineImage, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') },
    });
    return { res, dir, out, calls: fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') };
  };

  // The live image, reused: no probe, no save, no second SBOM read; it passes.
  const same = run(live, live, {});
  assert.equal(same.res.status, 0, same.res.stderr);
  assert.doesNotMatch(same.calls, /--entrypoint node/, 'not run for the runtime probes');
  assert.doesNotMatch(same.calls, /image save/, 'not saved to a tar');
  assert.doesNotMatch(same.calls, /imagetools inspect/, 'its own SBOM is the live SBOM');
  assert.match(same.calls, / sbom --skip-db-update/, 'the SBOM scan still runs');
  assert.match(same.res.stdout, /::notice title=worker image is the live image::Same digest as the live image \(sha256:c{64}\)/);
  assert.match(same.res.stdout, /::warning title=Already shipped: worker image::worker: libssl3@3\.0\.15-1~deb12u1: CVE-2026-9/);
  assert.ok(fs.existsSync(path.join(same.out, 'live-image.txt')));
  assert.match(fs.readFileSync(path.join(same.dir, 'summary.md'), 'utf8'), /### worker image\n\nSame digest as the live image/);

  // A different image keeps every check, against the live image's attestation.
  const changed = run(other, live, { SPDX: sbom });
  assert.equal(changed.res.status, 0, changed.res.stderr);
  assert.equal((changed.calls.match(/--entrypoint node/g) || []).length, 2, 'both runtime probes');
  assert.match(changed.calls, /image save -o/);
  assert.match(changed.calls, /imagetools inspect ghcr\.io\/usernode-labs\/social-vibecoding-worker@sha256:c{64}/);
  assert.match(changed.calls, / image --skip-db-update/, 'the full-image scan');
  assert.ok(!fs.existsSync(path.join(changed.out, 'live-image.txt')));

  // A different image with no readable live SBOM blocks on the finding.
  const strict = run(other, live, {});
  assert.equal(strict.res.status, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(strict.out, 'assessment.json'))).status, 'unavailable');
  assert.match(strict.res.stderr, /Security assessment unavailable/);
  assert.doesNotMatch(strict.res.stdout, /Security gate: worker image/, 'failed comparison does not invent a regression');
});

test('unchanged vulnerable Buildx warns; an introduced version blocks; audits retain unfixable and accepted findings', () => {
  const scan = { SchemaVersion: 2, Results: [{ Target: 'buildx', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.59.0', VulnerabilityID: 'CVE-2026-78661', FixedVersion: '0.62.0' },
    { Severity: 'CRITICAL', PkgName: 'unfixable', InstalledVersion: '1', VulnerabilityID: 'CVE-2026-12345' },
    { Severity: 'HIGH', PkgName: 'decode-uri-component', InstalledVersion: '0.2.2', VulnerabilityID: 'CVE-2026-118664', FixedVersion: '0.5.1' },
  ] }] };
  const unchanged = imageAssessment([scan], { component: 'standalone', baseline: new Set(['golang.org/x/net@v0.59.0']), now: NOW });
  assert.equal(unchanged.status, 'existing_findings');
  assert.equal(unchanged.blocking.length, 0);
  assert.equal(unchanged.preexisting.length, 1);
  const changed = imageAssessment([scan], { component: 'standalone', baseline: new Set(['golang.org/x/net@v0.58.0']), now: NOW });
  assert.equal(changed.status, 'regression');
  assert.equal(changed.blocking.length, 1);
  const full = imageAssessment([scan, scan], { component: 'standalone', audit: true, now: NOW });
  assert.equal(full.findings.length, 3, 'deduplicate SBOM/full-image matches but retain all risk categories');
  assert.equal(full.blocking.length, 0);
  assert.equal(full.findings.find((f) => f.id === 'CVE-2026-118664').acceptedUntil, '2026-11-28');
  const lower = JSON.parse(JSON.stringify(scan));
  lower.Results[0].Vulnerabilities[0].Severity = 'LOW';
  const merged = imageAssessment([scan, lower], { component: 'standalone', audit: true, now: NOW });
  assert.equal(merged.findings.find((f) => f.id === 'CVE-2026-78661').severity, 'HIGH', 'a second report cannot downgrade the alert');
  assert.throws(() => imageAssessment([{ SchemaVersion: 2, Results: [] }], { component: 'standalone' }), /invalid image scan/);
});

test('a failed full-image scan invalidates an earlier clean assessment and cannot resolve an alert', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'assessment.json'), JSON.stringify({ complete: true, status: 'clean' }));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'image' }] }));
  const sbom = path.join(dir, 'sbom.json');
  fs.writeFileSync(sbom, '{}');
  const result = spawnSync('sh', ['scripts/check-image-security.sh', 'fixture', out, sbom, 'standalone'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${fakeDocker(dir)}:${process.env.PATH}`, FAKE_IMAGE_SCAN_FAILURE: '1', SECURITY_AUDIT_ONLY: '1' },
  });
  assert.equal(result.status, 9);
  const data = JSON.parse(fs.readFileSync(path.join(out, 'assessment.json')));
  assert.equal(data.complete, false);
  assert.equal(data.status, 'unavailable');
  assert.match(data.reason, /full-image scan/);
});

test('a clean candidate skips baseline builds; a potential finding generates a fresh exact-base inventory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-lazy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'buildx' }] }));
  const sbom = path.join(dir, 'sbom.json');
  fs.writeFileSync(sbom, '{}');
  const bin = fakeDocker(dir);
  const source = path.join(dir, 'base-source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "${path.join(dir, 'git-calls.log')}"
if [ "$1" = archive ]; then tar -cf "$4" -C "${source}" .; fi
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SECURITY_BASELINE_REVISION: 'a'.repeat(40),
    SECURITY_SCAN_PLATFORM: 'linux/amd64', SECURITY_AUDIT_ONLY: '', GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
  const run = (folder) => spawnSync('sh', ['scripts/check-image-security.sh', 'fixture', path.join(dir, folder), sbom, 'standalone'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(run('clean').status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'git-calls.log')), false, 'no baseline is needed for a clean candidate');
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{ name: 'golang.org/x/net', versionInfo: 'v0.59.0' }] }));
  fs.writeFileSync(reportFile, JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'buildx', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'golang.org/x/net', InstalledVersion: 'v0.59.0', VulnerabilityID: 'CVE-2026-78661', FixedVersion: '0.62.0' },
  ] }] }));
  const result = run('finding');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baseline.*built/);
  assert.match(fs.readFileSync(path.join(dir, 'git-calls.log'), 'utf8'), /archive.*aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'finding', 'assessment.json'))).status, 'existing_findings');
});

test('baseline generation pins the exact commit and architecture, validates output and reports timing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-base-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = path.join(dir, 'summary.md');
  t.after(() => { if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previousSummary; });
  const calls = [];
  const revision = 'b'.repeat(40);
  const inventory = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'x', versionInfo: '1' }] };
  const run = (file, args) => {
    calls.push([file, args]);
    if (file === 'sh') fs.writeFileSync(args[2], JSON.stringify(inventory));
  };
  const opts = { component: 'standalone', revision, output: path.join(dir, 'out.json'), platform: 'linux/amd64', run };
  assert.ok(buildBaseline(opts).ms >= 0);
  assert.ok(calls.some(([file, args]) => file === 'git' && args[0] === 'archive' && args.at(-1) === revision));
  assert.ok(calls.some(([file, args]) => file === 'docker' && args.includes('--platform') && args.includes('linux/amd64')));
  assert.deepEqual(JSON.parse(fs.readFileSync(opts.output)), inventory);
  assert.throws(() => buildBaseline({ ...opts, revision: 'main' }), /Invalid baseline/);
  assert.throws(() => buildBaseline({ ...opts, platform: 'linux/386' }), /Invalid baseline/);
});

test('an unavailable lockfile baseline is an assessment failure rather than an invented dependency regression', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-lock-unavailable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(audit('minio', 'node_modules/minio', 'high', 'GHSA-new')));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncat "${path.join(dir, 'audit.json')}"\n`, { mode: 0o755 });
  const out = path.join(dir, 'reports');
  const result = spawnSync(process.execPath, ['scripts/security-audit.js'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      SECURITY_BASELINE_REVISION: 'f'.repeat(40), SECURITY_REPORT_DIR: out },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Security assessment unavailable/);
  assert.doesNotMatch(result.stdout, /Security gate: root lockfile/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'root-gate.json'))).blocking, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'root-gate.json'))).status, 'unavailable');
});

test('post-merge lockfile findings warn without a baseline, but failed or malformed audits still fail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-lock-advisory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const auditFile = path.join(dir, 'audit.json');
  fs.writeFileSync(auditFile, JSON.stringify(audit('minio', 'node_modules/minio', 'high', 'GHSA-new')));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncat "${auditFile}"\nexit "\${FAKE_AUDIT_EXIT:-1}"\n`, { mode: 0o755 });
  const out = path.join(dir, 'reports');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SECURITY_AUDIT_ONLY: '1',
    SECURITY_BASELINE_REVISION: 'f'.repeat(40), SECURITY_REPORT_DIR: out, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
  const run = (extra = {}) => spawnSync(process.execPath, ['scripts/security-audit.js'], { cwd: ROOT, encoding: 'utf8', env: { ...env, ...extra } });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning title=Security finding: root lockfile::minio@.*: GHSA-new/);
  assert.doesNotMatch(result.stdout, /::error|Already shipped/);
  const assessment = JSON.parse(fs.readFileSync(path.join(out, 'root-gate.json')));
  assert.equal(assessment.mode, 'audit');
  assert.equal(assessment.status, 'findings');
  assert.deepEqual(assessment.blocking, []);
  assert.equal(assessment.advisory.length, 1);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Security findings: advisory after merge/);
  assert.equal(run({ FAKE_AUDIT_EXIT: '2' }).status, 1, 'audit execution errors still fail');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'root-gate.json'))).status, 'unavailable');
  fs.writeFileSync(auditFile, '{}');
  assert.equal(run().status, 1, 'an invalid audit is not a clean or advisory verdict');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'root-gate.json'))).status, 'unavailable');
});

test('the same image finding blocks a PR and warns after merge while runtime and scanner failures still fail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-image-advisory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const scan = { SchemaVersion: 2, Results: [{ Target: 'worker', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'stdlib', InstalledVersion: 'v1.23.12', VulnerabilityID: 'CVE-fixture', FixedVersion: '1.27.3' },
  ] }] };
  fs.writeFileSync(path.join(out, 'vulnerabilities.json'), JSON.stringify(scan));
  const env = { ...process.env, SECURITY_AUDIT_ONLY: '0', GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
  const strict = spawnSync(process.execPath, ['scripts/security-findings.js', '--assess', out, 'worker'], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(strict.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'assessment.json'))).status, 'regression');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(scan));
  const sbom = path.join(dir, 'sbom.json');
  fs.writeFileSync(sbom, '{}');
  const bin = fakeDocker(dir);
  const run = (extra = {}) => spawnSync('sh', ['scripts/check-image-security.sh', 'fixture', out, sbom, 'worker'], {
    cwd: ROOT, encoding: 'utf8', env: { ...env, PATH: `${bin}:${process.env.PATH}`, SECURITY_AUDIT_ONLY: '1', ...extra },
  });
  const advisory = run();
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.match(advisory.stdout, /::warning title=Security finding: worker image::stdlib@v1\.23\.12: CVE-fixture/);
  const assessment = JSON.parse(fs.readFileSync(path.join(out, 'assessment.json')));
  assert.equal(assessment.status, 'findings');
  assert.equal(assessment.complete, true);
  assert.deepEqual(assessment.blocking, []);
  assert.equal(assessment.findings[0].id, 'CVE-fixture');
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /--entrypoint node/);
  assert.match(calls, / image --skip-db-update/);
  assert.doesNotMatch(calls, /imagetools inspect|anchore\/syft/, 'post-merge audits do not need a baseline');
  assert.equal(run({ FAKE_RUNTIME_FAILURE: '1' }).status, 8);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'assessment.json'))).status, 'unavailable');
  assert.equal(run({ FAKE_IMAGE_SCAN_FAILURE: '1' }).status, 9);
  fs.writeFileSync(path.join(dir, 'report.json'), '{}');
  assert.equal(run().status, 1, 'invalid scan reports still fail');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'assessment.json'))).status, 'unavailable');
});
