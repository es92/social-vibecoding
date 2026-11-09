'use strict';
const fs = require('node:fs');
const exceptions = require('../security/exceptions.json');
function excepted(name, version, ids, now = Date.now(), entries = exceptions, component) {
  return entries.some((e) => e.package === name && e.versions.includes(version)
    && e.ids.some((id) => ids.includes(id)) && e.reason
    && (!e.components || e.components.includes(component))
    && Date.parse(`${e.expires}T00:00:00Z`) > now);
}

// A gate blocks only what a change introduces. A HIGH or CRITICAL finding the
// exceptions do not cover is `blocking` when its package, at that exact
// version, is not in the baseline (what is live, or a pull request's base),
// and `preexisting` when the baseline already ships it: a newly published
// advisory on a package production already runs is reported, not a reason to
// stop every release. With no baseline (`null`) every finding blocks.
function split(findings, baseline) {
  const blocking = [];
  const preexisting = [];
  for (const f of findings) (baseline && f.baselineKey !== null
    && baseline.has(f.baselineKey || `${f.name}@${f.version}`) ? preexisting : blocking).push(f.text);
  return { blocking: [...new Set(blocking)], preexisting: [...new Set(preexisting)] };
}

// Every package@version a lockfile installs.
function lockPackages(lock) {
  const set = new Set();
  for (const [key, entry] of Object.entries(lock?.packages || {})) {
    if (!key || !entry?.version) continue;
    set.add(`${key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`);
  }
  return set;
}

// Syft records go1.23.12, while Trivy reports 1.23.12 or v1.23.12.
// Normalize only a confirmed Go stdlib identity, never an npm namesake.
function goStdlibKey(name, version, purl) {
  if (name !== 'stdlib' || typeof version !== 'string') return null;
  const bare = version.replace(/^(?:go|v)(?=\d)/, '');
  if (!/^\d[0-9A-Za-z.+-]*$/.test(bare)
    || (purl !== `pkg:golang/stdlib@${version}` && purl !== `pkg:golang/stdlib@${bare}`)) return null;
  return `pkg:golang/stdlib@${bare}`;
}

// Every package identity an SPDX SBOM (BuildKit's attestation) lists.
function sbomPackages(sbom) {
  if (!sbom?.spdxVersion || !Array.isArray(sbom.packages) || !sbom.packages.length) throw new Error('Missing or empty baseline SPDX SBOM');
  return new Set(sbom.packages.filter((p) => p.name && p.versionInfo).map((p) => {
    const goKey = (Array.isArray(p.externalRefs) ? p.externalRefs : [])
      .filter((ref) => ref.referenceType === 'purl')
      .map((ref) => goStdlibKey(p.name, p.versionInfo, ref.referenceLocator)).find(Boolean);
    // Do not also keep an unqualified key: it could match a different ecosystem.
    return goKey || `${p.name}@${p.versionInfo}`;
  }));
}

function npmGate(audit, lock, { now, baseline = null } = {}) {
  if (!audit.metadata?.vulnerabilities || !audit.vulnerabilities || audit.error) throw new Error('Invalid or failed npm audit response');
  const findings = [];
  for (const [name, v] of Object.entries(audit.vulnerabilities)) {
    for (const advisory of v.via.filter((a) => typeof a === 'object' && /^(high|critical)$/.test(a.severity))) {
      const id = advisory.url?.split('/').pop();
      for (const node of v.nodes) {
        const version = lock.packages[node]?.version;
        if (!excepted(name, version, [id], now)) findings.push({ name, version, text: `${name}@${version}: ${id}` });
      }
    }
  }
  return split(findings, baseline);
}
function npmFindings(audit, lock, now) {
  return npmGate(audit, lock, { now }).blocking;
}

function imageGate(report, { now, component, baseline = null } = {}) {
  if (report.SchemaVersion !== 2 || !Array.isArray(report.Results) || report.Results.length === 0) throw new Error('Empty or invalid image scan');
  const findings = report.Results.flatMap((r) => (r.Vulnerabilities || [])
    .filter((v) => /^(HIGH|CRITICAL)$/.test(v.Severity) && v.FixedVersion
      && !excepted(v.PkgName, v.InstalledVersion, [v.VulnerabilityID, ...(v.References || []).map((u) => u.split('/').pop())], now, exceptions, component))
    .map((v) => ({ name: v.PkgName, version: v.InstalledVersion,
      // null means unconfirmed Go identity: never fall back to a raw npm key.
      baselineKey: v.PkgName === 'stdlib' && ['gobinary', 'gomod'].includes(r.Type)
        ? goStdlibKey(v.PkgName, v.InstalledVersion, v.PkgIdentifier?.PURL) : undefined,
      text: `${r.Target}: ${v.PkgName}@${v.InstalledVersion}: ${v.VulnerabilityID} (fix ${v.FixedVersion})` })));
  return split(findings, baseline);
}
function imageFindings(report, now, component) {
  return imageGate(report, { now, component }).blocking;
}

// Keep a machine-readable assessment alongside the complete scanner reports.
// Daily audits retain accepted/unfixable findings too; exceptions waive a gate,
// not the obligation to track a dependency that is still affected.
function imageAssessment(reports, { component, baseline = null, baselineName = null, audit = false, now = Date.now() }) {
  const blocking = new Set();
  const preexisting = new Set();
  const findings = new Map();
  for (const scan of reports) {
    const gate = imageGate(scan, { component, baseline, now });
    for (const text of gate.blocking) blocking.add(text);
    for (const text of gate.preexisting) preexisting.add(text);
    for (const result of scan.Results) for (const v of result.Vulnerabilities || []) {
      if (!v.VulnerabilityID || !v.PkgName || !v.InstalledVersion
        || !['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(v.Severity)) throw new Error('Incomplete vulnerability record');
      const exception = exceptions.find((e) => excepted(v.PkgName, v.InstalledVersion,
        [v.VulnerabilityID, ...(v.References || []).map((u) => u.split('/').pop())], now, [e], component));
      const item = { id: v.VulnerabilityID, package: v.PkgName, version: v.InstalledVersion,
        severity: v.Severity, fixedVersion: v.FixedVersion || null,
        ...(exception ? { acceptedUntil: exception.expires, acceptanceReason: exception.reason } : {}) };
      const key = `${item.id}:${item.package}:${item.version}`;
      const previous = findings.get(key);
      const levels = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      if (previous && levels.indexOf(previous.severity) > levels.indexOf(item.severity)) item.severity = previous.severity;
      item.fixedVersion ||= previous?.fixedVersion || null;
      findings.set(key, item);
    }
  }
  return { version: 1, component, complete: true, checkedAt: new Date(now).toISOString(),
    mode: audit ? 'audit' : 'regression', baseline: baselineName,
    status: audit ? (findings.size ? 'findings' : 'clean')
      : blocking.size ? 'regression' : preexisting.size ? 'existing_findings' : 'clean',
    blocking: audit ? [] : [...blocking], preexisting: [...preexisting], findings: [...findings.values()] };
}

function readImageReports(dir) {
  const path = require('node:path');
  return ['vulnerabilities.json', 'image-vulnerabilities.json']
    .filter((name) => fs.existsSync(path.join(dir, name)))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

function writeAssessment(dir, assessment) {
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'assessment.json'), JSON.stringify(assessment, null, 2));
}

// GitHub Actions annotations. The platform reads the first error annotation of
// a failed release job to say why a merged change has not gone live, so an
// error's message names the finding itself.
function escape(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function report(label, { blocking, preexisting, advisory = [] }, { log = console.log, baselineName = 'the baseline' } = {}) {
  for (const text of blocking) log(`::error title=${escape(`Security gate: ${label}`)}::${escape(text)}`);
  for (const text of preexisting) log(`::warning title=${escape(`Already shipped: ${label}`)}::${escape(`${text} (already in ${baselineName}; not introduced by this change)`)}`);
  for (const text of advisory) log(`::warning title=${escape(`Security finding: ${label}`)}::${escape(text)}`);
  if (process.env.GITHUB_STEP_SUMMARY && (blocking.length || preexisting.length || advisory.length)) {
    const lines = [`### ${label}`, ''];
    if (blocking.length) lines.push('**Blocking: introduced by this change**', '', ...blocking.map((t) => `- ${t}`), '');
    if (preexisting.length) lines.push(`**Already shipped in ${baselineName}: reported, not blocking**`, '', ...preexisting.map((t) => `- ${t}`), '');
    if (advisory.length) lines.push('**Security findings: advisory after merge**', '', ...advisory.map((t) => `- ${t}`), '');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

if (require.main === module) {
  // usage: security-findings.js <trivy-report.json> <component> [<baseline-spdx.json>]
  try {
    const [operation, dir, component, baselineFile, baselineName] = process.argv.slice(2);
    if (operation === '--unavailable') {
      writeAssessment(dir, { version: 1, component, complete: false, status: 'unavailable',
        checkedAt: new Date().toISOString(), reason: baselineFile || 'Scan or comparison unavailable', findings: [] });
      console.error(`::error title=${escape(`Security assessment unavailable: ${component}`)}::${escape(baselineFile || 'Scan or comparison unavailable')}`);
    } else if (operation === '--potential') {
      const reports = readImageReports(dir);
      if (!reports.length) throw new Error('No image scan reports');
      console.log(reports.reduce((count, scan) => count + imageFindings(scan, Date.now(), component).length, 0));
    } else if (operation === '--assess') {
      const reports = readImageReports(dir);
      if (!reports.length) throw new Error('No image scan reports');
      const baseline = baselineFile ? sbomPackages(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))) : null;
      const audit = process.env.SECURITY_AUDIT_ONLY === '1';
      const assessment = imageAssessment(reports, { component, baseline, baselineName, audit });
      assessment.revision = process.env.GITHUB_SHA || null;
      assessment.runId = process.env.GITHUB_RUN_ID || null;
      assessment.runAttempt = process.env.GITHUB_RUN_ATTEMPT || null;
      const reference = require('node:path').join(dir, 'image-reference.txt');
      assessment.image = fs.existsSync(reference) ? fs.readFileSync(reference, 'utf8').trim() : null;
      writeAssessment(dir, assessment);
      const advisory = audit ? assessment.findings.filter((f) => /^(HIGH|CRITICAL)$/.test(f.severity))
        .map((f) => `${f.package}@${f.version}: ${f.id} (${f.fixedVersion ? `fix ${f.fixedVersion}` : 'no fix available'})`) : [];
      report(`${component} image`, { ...assessment, advisory }, { baselineName: baselineName || 'the baseline' });
      if (assessment.blocking.length) process.exitCode = 1;
    } else {
      const [file, component, baselineFile] = process.argv.slice(2);
      const baseline = baselineFile ? sbomPackages(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))) : null;
      const result = imageGate(JSON.parse(fs.readFileSync(file, 'utf8')), { component, baseline });
      report(`${component} image`, result, { baselineName: baseline ? 'the live image' : 'the baseline' });
      if (result.blocking.length) { console.error(result.blocking.join('\n')); process.exitCode = 1; }
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { excepted, npmFindings, imageFindings, npmGate, imageGate, lockPackages, sbomPackages, report, imageAssessment };
