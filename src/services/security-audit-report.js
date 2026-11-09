'use strict';

// Shared CI/runtime contract. Only typed dependency facts reach a native
// request; scanner descriptions, paths and arbitrary annotations stay out.
const COMPONENTS = Object.freeze(['platform', 'standalone', 'worker', 'capture', 'starter']);
const LEVELS = Object.freeze(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const MAX_BYTES = 1024 * 1024;
const IMAGE = /^(?:sha256:[a-f0-9]{64}|ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+~!^*<>=-]{0,199}$/;

function identity(value, expected) {
  if (value.version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(value.repository || '')
    || !/^[a-f0-9]{40}$/.test(value.revision || '') || !/^\d+$/.test(value.runId || '')
    || !/^\d+$/.test(value.runAttempt || '')) throw new Error('Invalid security audit identity');
  for (const key of ['repository', 'revision', 'runId', 'runAttempt']) {
    if (expected[key] != null && (key === 'repository'
      ? value[key].toLowerCase() !== String(expected[key]).toLowerCase()
      : value[key] !== String(expected[key]))) throw new Error('Security audit identity mismatch');
  }
}

function finding(raw) {
  if (!raw || !/^(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9-]{8,}|GO-\d{4}-\d{3,})$/.test(raw.id || '')
    || !/^[A-Za-z0-9@][A-Za-z0-9._/@+-]{0,199}$/.test(raw.package || '')
    || !VERSION.test(raw.version || '') || !LEVELS.includes(raw.severity)
    || (raw.fixedVersion && (typeof raw.fixedVersion !== 'string' || raw.fixedVersion.length > 500
      || !raw.fixedVersion.split(/,\s*/).every((v) => VERSION.test(v))))
    || (raw.acceptedUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(raw.acceptedUntil) || !Number.isFinite(Date.parse(raw.acceptedUntil))))) {
    throw new Error('Invalid security finding');
  }
  return { id: raw.id, package: raw.package, version: raw.version, severity: raw.severity,
    fixedVersion: raw.fixedVersion || null, ...(raw.acceptedUntil ? { acceptedUntil: raw.acceptedUntil } : {}) };
}

function component(raw) {
  if (!raw || !COMPONENTS.includes(raw.component) || !IMAGE.test(raw.image || '') || !Array.isArray(raw.findings)
    || raw.findings.length > 1000 || raw.status !== (raw.findings.length ? 'findings' : 'clean')
    || !Number.isFinite(Date.parse(raw.checkedAt))) throw new Error('Incomplete security component');
  return { component: raw.component, image: raw.image, status: raw.status, checkedAt: raw.checkedAt,
    findings: raw.findings.map(finding) };
}

function fromAssessments(assessments, context) {
  identity({ version: 1, ...context }, context);
  const found = new Map();
  const invalid = new Set();
  let unknown = false;
  for (const raw of assessments) {
    const name = raw?.component;
    if (!COMPONENTS.includes(name)) { unknown = true; continue; }
    try {
      if (found.has(name) || raw.version !== 1 || raw.mode !== 'audit' || raw.complete !== true
        || raw.revision !== context.revision || raw.runId !== context.runId || raw.runAttempt !== context.runAttempt) {
        throw new Error('Invalid component provenance');
      }
      found.set(name, component(raw));
    } catch { invalid.add(name); }
  }
  for (const name of invalid) found.delete(name);
  const unavailable = COMPONENTS.filter((name) => !found.has(name));
  return { version: 1, repository: context.repository, revision: context.revision,
    runId: context.runId, runAttempt: context.runAttempt, generatedAt: new Date(context.now ?? Date.now()).toISOString(),
    complete: unavailable.length === 0 && !unknown, unavailable, components: [...found.values()] };
}

function readReport(text, expected = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Security report exceeds its limit');
  const raw = JSON.parse(text);
  identity(raw, expected);
  if (!Number.isFinite(Date.parse(raw.generatedAt)) || !Array.isArray(raw.components) || raw.components.length > COMPONENTS.length
    || typeof raw.complete !== 'boolean') throw new Error('Invalid security report');
  const components = raw.components.map(component);
  const names = new Set(components.map((c) => c.component));
  if (names.size !== components.length || (raw.complete && names.size !== COMPONENTS.length)) throw new Error('Incomplete security report');
  return { version: 1, repository: raw.repository, revision: raw.revision, runId: raw.runId, runAttempt: raw.runAttempt,
    generatedAt: raw.generatedAt, complete: raw.complete, components,
    unavailable: COMPONENTS.filter((name) => !names.has(name)) };
}

module.exports = { COMPONENTS, LEVELS, MAX_BYTES, IMAGE, finding, fromAssessments, readReport };
