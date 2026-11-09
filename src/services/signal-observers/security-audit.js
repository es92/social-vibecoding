'use strict';

// Consume the trusted daily workflow's data, never GitHub issues. Existing
// platform-signals owns native request creation, quiet windows and bot limits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { COMPONENTS, LEVELS, MAX_BYTES, finding, readReport } = require('../security-audit-report');
const DAY = 86400000;
const MAX_AGE = 36 * 3600000;
const WORKFLOW = '.github/workflows/security-audit.yml';
const REPORT_FILE = 'security-audit-report.json';
const PREVIOUS_SQL = `SELECT kind, subject, fixer, first_seen_at FROM platform_signals
  WHERE kind IN ('security', 'security_audit') AND state IN ('pending', 'open', 'clearing') AND app_id = $1`;
let cache = null;

function unzipReport(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('Oversized security archive');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeroom-security-'));
  try {
    const file = path.join(dir, 'report.zip');
    fs.writeFileSync(file, bytes);
    // execFileSync waits for exit even after a limit is exceeded. unzip handles
    // SIGTERM, so force this disposable child to stop; finally owns cleanup.
    return execFileSync('/usr/bin/unzip', ['-p', file, REPORT_FILE], {
      encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function download(location, { fetchImpl = fetch } = {}) {
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(?:^|\.)(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(url.hostname)) throw new Error('Unexpected artifact host');
  // No GitHub authorization or cookies are forwarded to the signed storage URL.
  const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error('Security artifact download unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Oversized security artifact');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function load(repo, { github = require('../github'), now = Date.now(), fetchImpl, unzip = unzipReport } = {}) {
  const octokit = await github.getReadOctokit(repo.owner);
  const base = { owner: repo.owner, repo: repo.repo };
  const { data } = await octokit.rest.actions.listWorkflowRuns({ ...base, workflow_id: 'security-audit.yml', branch: 'main', per_page: 1 });
  const run = data?.workflow_runs?.[0];
  if (!run) return { reason: 'missing', delay: MAX_AGE };
  const full = `${repo.owner}/${repo.repo}`;
  if (run.path !== WORKFLOW || run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)
    || run.head_repository?.full_name?.toLowerCase() !== full.toLowerCase()
    || !/^[a-f0-9]{40}$/.test(run.head_sha || '') || !Number.isSafeInteger(run.id) || run.id <= 0
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Untrusted security workflow');
  const ref = await octokit.rest.git.getRef({ ...base, ref: 'heads/main' });
  if (run.status !== 'completed') return { reason: 'running', delay: 3600000, run };
  const key = `${full}:${run.id}:${run.run_attempt}`;
  let report = cache?.key === key ? cache.report : null;
  if (!report) {
    const listed = await octokit.rest.actions.listWorkflowRunArtifacts({ ...base, run_id: run.id, per_page: 100 });
    const artifacts = (listed.data?.artifacts || []).filter((a) => a.name === `homeroom-security-audit-${run.run_attempt}` && !a.expired);
    if (artifacts.length !== 1) throw new Error('Security report artifact unavailable');
    const artifact = artifacts[0];
    if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || !Number.isFinite(artifact.size_in_bytes)
      || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_BYTES
      || (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha))) {
      throw new Error('Invalid security artifact identity');
    }
    const redirect = await octokit.rest.actions.downloadArtifact({ ...base, artifact_id: artifact.id,
      archive_format: 'zip', request: { redirect: 'manual' } });
    if (redirect.status !== 302 || !redirect.headers?.location) throw new Error('Security artifact redirect unavailable');
    const bytes = await download(redirect.headers.location, { fetchImpl });
    report = readReport(unzip(bytes), { repository: full, revision: run.head_sha,
      runId: run.id, runAttempt: run.run_attempt });
    cache = { key, report };
  }
  const ages = [report.generatedAt, ...report.components.map((c) => c.checkedAt)].map((at) => now - Date.parse(at));
  if (ages.some((age) => age < -300000)) throw new Error('Invalid security report clock');
  if (ages.some((age) => age > MAX_AGE)) return { reason: 'stale', delay: 0, run };
  return { report, run, complete: report.complete && run.conclusion === 'success' && ref.data?.object?.sha === run.head_sha,
    reason: !report.complete || run.conclusion !== 'success' ? 'incomplete' : null, delay: 0 };
}

const WHERE = {
  platform: 'Dockerfile.kubernetes', standalone: 'Dockerfile', worker: 'worker/Dockerfile',
  capture: 'capture/Dockerfile', starter: 'src/services/template.js',
};

function itemsFrom(result, previous, app, now) {
  const prior = new Map(previous.filter((r) => r.kind === 'security').map((r) => [r.subject?.advisory, r]));
  const groups = new Map();
  // Missing/incomplete/stale data retains every known finding, including rows
  // already clearing. Re-raising them cancels an unconfirmed resolution.
  if (!result.complete) for (const [id, row] of prior) groups.set(id, row.subject?.findings || []);
  for (const c of result.report?.components || []) for (const f of c.findings) {
    const values = groups.get(f.id) || [];
    groups.set(f.id, [...values, { ...f, component: c.component }]);
  }
  const items = [];
  for (const [id, raw] of groups) {
    const byPackage = new Map();
    for (const value of raw) {
      if (!COMPONENTS.includes(value.component)) throw new Error('Invalid retained security component');
      const f = { ...finding(value), component: value.component };
      const key = `${f.component}:${f.package}:${f.version}`;
      const old = byPackage.get(key);
      byPackage.set(key, old ? { ...f,
        severity: LEVELS[Math.max(LEVELS.indexOf(old.severity), LEVELS.indexOf(f.severity))],
        fixedVersion: f.fixedVersion || old.fixedVersion,
        ...(old.acceptedUntil && (!f.acceptedUntil || old.acceptedUntil < f.acceptedUntil) ? { acceptedUntil: old.acceptedUntil } : {}),
      } : f);
    }
    const findings = [...byPackage.values()].sort((a, b) => `${a.component}:${a.package}:${a.version}`.localeCompare(`${b.component}:${b.package}:${b.version}`));
    if (!findings.length) continue;
    const severity = LEVELS[Math.max(...findings.map((f) => LEVELS.indexOf(f.severity)))];
    const old = prior.get(id);
    const first = old?.first_seen_at ? new Date(old.first_seen_at).getTime() : now;
    let due = first + (severity === 'CRITICAL' ? DAY : 7 * DAY);
    if (Number.isFinite(Date.parse(old?.subject?.dueAt))) due = Math.min(due, Date.parse(old.subject.dueAt));
    for (const f of findings) if (f.acceptedUntil) due = Math.min(due, Date.parse(f.acceptedUntil));
    const fixer = findings.some((f) => f.fixedVersion) ? 'bot' : 'person';
    const materialKey = createHash('sha256').update(JSON.stringify({ findings, due, fixer })).digest('hex');
    // The shared evidence scrubber removes @mentions. Spell out an npm
    // scope as typed data so the bot still knows exactly which package.
    const packageName = (name) => name.replace(/^@([^/]+)\//, 'npm scope $1, package ');
    const lines = findings.map((f) => `${f.component}: ${packageName(f.package)} ${f.version}; fixed in ${f.fixedVersion || 'no published version'}${f.acceptedUntil ? `; reviewed exception until ${f.acceptedUntil}` : ''}.`);
    lines.push(`Severity: ${severity}. Remediation target: ${new Date(due).toISOString().slice(0, 10)}${due < now ? ' (overdue)' : ''}.`);
    if (result.run) lines.push(`Audit: https://github.com/${result.report?.repository || 'Usernode-Labs/social-vibecoding'}/actions/runs/${result.run.id}`);
    items.push({ kind: 'security', key: id, appId: app.id, fixer, title: `Security: ${id} affects Homeroom`,
      subject: { advisory: id, severity, findings, dueAt: new Date(due).toISOString(), materialKey,
        publishedKey: old?.subject?.publishedKey, publishedFixer: old?.subject?.publishedFixer,
        noFile: !['HIGH', 'CRITICAL'].includes(severity) },
      summary: `${id} affects Homeroom's dependencies. ${result.complete ? 'The audit is complete.' : 'Known findings are retained until a complete current audit can confirm resolution.'}`,
      done: 'A complete current audit no longer finds this advisory in any of the five Homeroom components.',
      evidence: { lines, where: [...new Set(findings.map((f) => WHERE[f.component]))] } });
  }
  const health = previous.find((r) => r.kind === 'security_audit');
  let delay = result.delay || 0;
  if (result.reason === 'running' && Number.isFinite(Date.parse(result.run?.run_started_at))) {
    const first = health?.first_seen_at ? new Date(health.first_seen_at).getTime() : now;
    delay = Math.max(0, Date.parse(result.run.run_started_at) + 3600000 - first);
  }
  if (result.reason) items.push({ kind: 'security_audit', key: 'unavailable', appId: app.id, fixer: 'person',
    title: 'Homeroom security audit needs attention', fileAfterMs: delay,
    subject: { materialKey: `${result.reason}:${result.run?.id || ''}:${result.run?.run_attempt || ''}`,
      publishedKey: health?.subject?.publishedKey },
    summary: 'The security audit cannot confirm the current dependency state. Existing remediation requests stay open.',
    done: 'A complete successful security audit is available again.',
    evidence: { lines: [`Assessment state: ${result.reason}.`], where: ['.github/workflows/security-audit.yml'] } });
  return { items, ok: new Set(result.complete ? ['security', 'security_audit'] : ['security_audit']) };
}

async function run(pool, { now = Date.now(), github, fetchImpl, unzip } = {}) {
  const { rows: [app] } = await pool.query('SELECT id, repo_url, github_repo_url, main_sha FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1');
  if (!app) return { items: [], ok: new Set() };
  const { rows: previous } = await pool.query(PREVIOUS_SQL, [app.id]);
  const repo = require('../repo-ref').parse(app.github_repo_url || app.repo_url);
  if (!repo || repo.host !== 'github') return itemsFrom({ reason: 'source_unavailable', delay: 0 }, previous, app, now);
  if (!require('../github-budget').budgetAllows('background')) throw new Error('Security audit read budget unavailable');
  let result;
  try {
    result = await load(repo, { github, now, fetchImpl, unzip });
    result.complete = result.complete && app.main_sha === result.run?.head_sha;
  } catch { result = { reason: 'read_failed', delay: 0 }; }
  return itemsFrom(result, previous, app, now);
}

module.exports = { run, load, itemsFrom, download, unzipReport, MAX_AGE, resetCache: () => { cache = null; } };
