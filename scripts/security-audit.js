'use strict';
// Audit all lockfiles, including development dependencies and vendored inputs.
//
// SECURITY_BASELINE_REVISION names the commit a finding is compared against:
// a pull request's base. SECURITY_AUDIT_ONLY=1 records findings without
// failing delivery after merge; scanner/response failures still fail.
// A finding on a package that commit already locks, at the same version, is
// reported as already shipped and does not fail the audit; with no readable
// baseline every finding fails, as before (scripts/security-findings.js).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { npmGate, lockPackages, report } = require('./security-findings');

function baselineLock(root, revision, dir) {
  if (!revision) return null;
  const file = dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`;
  const shown = spawnSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (shown.status !== 0) return null;
  try { return lockPackages(JSON.parse(shown.stdout)); } catch { return null; }
}

function main() {
  const root = path.join(__dirname, '..');
  const out = path.resolve(process.env.SECURITY_REPORT_DIR || 'security-reports');
  const revision = /^[a-f0-9]{40}$/.test(process.env.SECURITY_BASELINE_REVISION || '') ? process.env.SECURITY_BASELINE_REVISION : '';
  const baselineName = process.env.SECURITY_BASELINE_NAME || (revision ? revision.slice(0, 9) : 'the baseline');
  const auditOnly = process.env.SECURITY_AUDIT_ONLY === '1';
  fs.mkdirSync(out, { recursive: true });
  for (const [name, dir] of [['root', '.'], ['frontend', 'frontend'], ['starter', 'src/templates/node-app']]) {
    const assessmentFile = path.join(out, `${name}-gate.json`);
    fs.rmSync(assessmentFile, { force: true });
    try {
      const cwd = path.join(root, dir);
      const result = spawnSync('npm', ['audit', '--package-lock-only', '--include=dev', '--json'], {
        cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error || result.status === null || result.status > 1) throw new Error(result.error?.message || result.stderr || `audit exit ${result.status}`);
      fs.writeFileSync(path.join(out, `${name}-npm-audit.json`), result.stdout);
      const audit = JSON.parse(result.stdout);
      const baseline = auditOnly ? null : baselineLock(root, revision, dir);
      const gate = npmGate(audit, JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')), { baseline });
      if (!auditOnly && !baseline && gate.blocking.length) throw new Error(`Baseline comparison unavailable at ${baselineName}; retry or review`);
      const assessment = auditOnly ? { blocking: [], preexisting: [], advisory: gate.blocking } : gate;
      fs.writeFileSync(assessmentFile, JSON.stringify({ baseline: baseline ? revision : null,
        mode: auditOnly ? 'audit' : 'regression',
        status: auditOnly ? (assessment.advisory.length ? 'findings' : 'clean')
          : gate.blocking.length ? 'regression' : gate.preexisting.length ? 'existing_findings' : 'clean', ...assessment }, null, 2));
      console.log(`${name}: ${JSON.stringify(audit.metadata.vulnerabilities)}`);
      report(`${name} lockfile`, assessment, { baselineName });
      if (assessment.blocking.length) throw new Error(assessment.blocking.join('\n'));
    } catch (err) {
      if (!fs.existsSync(assessmentFile)) {
        fs.writeFileSync(assessmentFile, JSON.stringify({ status: 'unavailable', reason: err.message, blocking: [], preexisting: [] }, null, 2));
        console.error(`::error title=Security assessment unavailable: ${name} lockfile::Scan or baseline comparison failed; retry or review`);
      }
      console.error(`${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
if (require.main === module) main();
module.exports = { baselineLock };
