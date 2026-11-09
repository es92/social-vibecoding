'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { supported } = require('../scripts/check-node-runtime');
const { excepted, npmFindings, imageFindings } = require('../scripts/security-findings');
const ownership = require('../worker/process-ownership');

test('image runtime policy rejects vulnerable patches and unreviewed major migrations', () => {
  for (const version of ['v22.23.4', '22.23.5', '22.24.0']) assert.equal(supported(version), true);
  for (const version of ['22.23.3', '22.17.1', '20.19.5', '24.22.1', '22.23.4-rc.1', 'bad']) assert.equal(supported(version), false);
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes', 'worker/Dockerfile', 'capture/Dockerfile', 'src/services/template.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const stages = source.match(/^FROM node:.+$/gm);
    assert.ok(stages.length, file);
    for (const stage of stages) assert.match(stage, /^FROM node:22\.23\.4-(?:alpine|bookworm-slim)(?: AS \S+)?$/, file);
    assert.equal((source.match(/RUN npm install --global npm@11\.21\.1/g) || []).length, stages.length, file);
  }
});

test('security exceptions are exact, scoped to one advisory, and expire', () => {
  const now = Date.parse('2026-10-23');
  assert.equal(excepted('zod', '3.25.76', ['GHSA-mrhx-c7xc-m3w5'], now), true);
  assert.equal(excepted('zod', '3.25.75', ['GHSA-mrhx-c7xc-m3w5'], now), false);
  assert.equal(excepted('zod', '3.25.76', ['new-advisory'], now), false);
  assert.equal(excepted('zod', '3.25.76', ['CVE-2023-54404'], Date.parse('2026-11-22')), false);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], now, undefined, 'worker'), false);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], now, undefined, 'standalone'), true);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], Date.parse('2026-11-12'), undefined, 'standalone'), true);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], Date.parse('2026-11-13'), undefined, 'standalone'), false);
  assert.equal(excepted('decode-uri-component', '0.2.2', ['GHSA-qr28-fpjm-wq7f'], now), true);
  assert.equal(excepted('decode-uri-component', '0.2.3', ['GHSA-qr28-fpjm-wq7f'], now), false);
  assert.equal(excepted('decode-uri-component', '0.2.2', ['GHSA-qr28-fpjm-wq7f'], Date.parse('2026-11-28')), false);
  const audit = { metadata: { vulnerabilities: {} }, vulnerabilities: { pkg: {
    nodes: ['node_modules/pkg'], via: [{ severity: 'critical', url: 'https://github.com/advisories/GHSA-new' }],
  } } };
  assert.deepEqual(npmFindings(audit, { packages: { 'node_modules/pkg': { version: '1.0.0' } } }, now), ['pkg@1.0.0: GHSA-new']);
  assert.throws(() => npmFindings({ error: 'offline' }, {}), /Invalid/);
  assert.throws(() => imageFindings({ SchemaVersion: 2, Results: [] }), /Empty/);
  const scan = { SchemaVersion: 2, Results: [{ Target: 'node', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'pkg', InstalledVersion: '1', VulnerabilityID: 'CVE-new', FixedVersion: '2' },
  ] }] };
  assert.equal(imageFindings(scan, now).length, 1);
});

test('portable process metadata includes start time, user and command, including unusual Linux comm names', () => {
  const uid = process.getuid();
  const fields = Array(25).fill('0');
  fields[0] = 'S'; fields[1] = '2'; fields[2] = '42'; fields[19] = '123456';
  const fsImpl = { statSync: () => ({ uid }), readFileSync: (file) => file.endsWith('/stat')
    ? `42 (node (fixture)) ${fields.join(' ')}` : 'node\0server.js\0' };
  assert.deepEqual(ownership.readProcess(42, { platform: 'linux', fsImpl }), {
    pid: 42, ppid: 2, pgid: 42, uid, start: '123456', state: 'S', cmd: 'node server.js',
  });
  const command = 'node /a directory/server.js';
  const exec = (_file, _args, opts) => { assert.equal(opts.timeout, 1500); return `42 2 ${uid} 42 Fri Oct 23 20:00:00 2026 S ${command}\n`; };
  assert.deepEqual(ownership.readProcess(42, { platform: 'darwin', exec }), {
    pid: 42, ppid: 2, pgid: 42, uid, start: 'Fri Oct 23 20:00:00 2026', state: 'S', cmd: command,
  });
  assert.equal(ownership.readProcess(42, { platform: 'darwin', exec: () => { throw new Error('denied'); } }), null);
});

test('shutdown rechecks PID lifetime before escalation and refuses unreadable or foreign ownership', async () => {
  const record = { pid: 4242, uid: process.getuid(), start: 'original', cmd: 'node server.js', state: 'S' };
  const sent = [];
  let actual = record;
  const kill = (pid, signal) => { sent.push([pid, signal]); actual = { ...record, start: 'reused' }; };
  assert.equal(ownership.stopOwnedSync([record], { waitMs: 0, read: () => actual, kill }), 1);
  assert.deepEqual(sent, [[4242, 'SIGTERM']], 'never SIGKILL a PID that was reused during shutdown');
  assert.equal(await ownership.stopOwned([record], { waitMs: 0, read: () => null, kill }), 0);
  assert.equal(await ownership.stopOwned([{ ...record, uid: record.uid + 1 }], { waitMs: 0, read: () => record, kill }), 0);
  const stubborn = [];
  assert.equal(await ownership.stopOwned([record], { waitMs: 0, read: () => record, kill: (_p, sig) => stubborn.push(sig) }), 1);
  assert.deepEqual(stubborn, ['SIGTERM', 'SIGKILL']);
});

test('the real MCP SDK rejects oversized tool collections before schema validation and still accepts normal calls', async () => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = require('zod');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8');
  assert.match(source, /maxToolInputElements: 10_000/);
  assert.match(source, /router\.post\(MCP_PATH, jsonBody\('512kb'\)/);
  let validated = 0;
  const server = new McpServer({ name: 'bounded-test', version: '1' }, { maxToolInputElements: 10_000 });
  server.tool('bounded', { values: z.array(z.string().superRefine(() => { validated += 1; })) }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const refused = await client.callTool({ name: 'bounded', arguments: { values: Array(10_001).fill('x') } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /maximum of 10000 elements/);
    assert.equal(validated, 0, 'the bound applies before Zod expands validation issues');
    const accepted = await client.callTool({ name: 'bounded', arguments: { values: ['x', 'y'] } });
    assert.equal(accepted.isError, undefined);
    assert.equal(validated, 2);
  } finally { await client.close(); await server.close(); }
});

test('Express survives compressed frames with trailing data and ignores forged forwarding headers', async () => {
  const express = require('express');
  const http = require('node:http');
  const zlib = require('node:zlib');
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.post('/', (req, res) => res.json({ body: req.body, ip: req.ip }));
  app.use((err, _req, res, _next) => res.sendStatus(err.status || 400));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const send = (body, encoding) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
      headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'x-forwarded-for': '203.0.113.9' } }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]]) {
      await send(Buffer.concat([compress(Buffer.from('{"ok":true}')), Buffer.from('invalid-trailing-frame')]), encoding);
    }
    const good = await send(Buffer.from('{"ok":true}'), 'identity');
    assert.equal(good.status, 200);
    assert.equal(JSON.parse(good.data).ip, '127.0.0.1');
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /app\.set\('trust proxy', false\)/);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test('macOS listener inventory spares ancestors and foreign users and reads actual working directories', () => {
  const uid = process.getuid();
  const exec = (file, args) => {
    if (file === '/bin/ps') return [
      `10 1 ${uid} 10 Fri Oct 23 20:00:00 2026 S node hook.js`,
      `20 1 ${uid} 20 Fri Oct 23 20:00:00 2026 S node server.js`,
      `30 1 ${uid + 1} 30 Fri Oct 23 20:00:00 2026 S node server.js`,
    ].join('\n');
    if (args.includes('-iTCP')) return 'p10\np20\np30\n';
    assert.deepEqual(args.slice(0, 3), ['-a', '-p', '20']);
    return 'p20\nn/private/tmp/fixture with spaces\n';
  };
  const found = ownership.listeningProcesses({ platform: 'darwin', selfPid: 10, exec });
  assert.equal(found.spare.has(10), true);
  assert.deepEqual(found.procs.map((p) => [p.pid, p.cwd]), [[20, '/private/tmp/fixture with spaces']]);
});


// Evaluate the expressions from the checked-in workflow, so configuration
// changes exercise the real resolver and release dependency semantics.
function workflowExpression(value, context) {
  if (typeof value !== 'string') return value;
  return vm.runInNewContext(value.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context, { timeout: 500 });
}

test('the required security merge gate rejects every incomplete or unsuccessful dependency result', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  const required = require('../security/required-merge-checks.json');
  const lockfiles = workflow.jobs['security-lockfiles'];
  const images = workflow.jobs['security-images'];
  const gate = workflow.jobs['security-merge-gate'];
  assert.deepEqual(required, [gate.name, lockfiles.name,
    ...images.strategy.matrix.include.map(({ component }) => images.name.replace('${{ matrix.component }}', component))]);
  assert.deepEqual(gate.needs, ['security-lockfiles', 'security-images']);
  assert.deepEqual(gate.permissions, {});
  assert.equal(workflowExpression(gate.if, { github: { event_name: 'pull_request' }, always: () => true }), true);
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.equal(workflowExpression(gate.if, { github: { event_name: event }, always: () => true }), false);
  }
  assert.equal(images.if, "github.event_name == 'pull_request'");
  for (const job of [lockfiles, images, gate]) {
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
  }
  const check = gate.steps[0];
  assert.deepEqual(check.env, { LOCKFILES_RESULT: '${{ needs.security-lockfiles.result }}', IMAGES_RESULT: '${{ needs.security-images.result }}' });
  const run = (lockfiles, images) => spawnSync('sh', ['-c', check.run], {
    encoding: 'utf8', env: { ...process.env, LOCKFILES_RESULT: lockfiles, IMAGES_RESULT: images },
  });
  assert.equal(run('success', 'success').status, 0);
  for (const status of ['', 'pending', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    for (const [lockfiles, images] of [[status, 'success'], ['success', status]]) {
      const result = run(lockfiles, images);
      assert.equal(result.status, 1, `${lockfiles}/${images}`);
      assert.match(result.stdout, /All security checks must succeed before merging/);
    }
  }
  const audit = lockfiles.steps.find((s) => s.run === 'node scripts/security-audit.js');
  const releaseScan = workflow.jobs.build.steps.find((s) => s.name === 'Verify runtime and scan the exact image SBOM');
  const baseline = lockfiles.steps.find((s) => s.name === 'Fetch the baseline commit');
  const live = lockfiles.steps.find((s) => s.name === 'Read the live release');
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    for (const ref of ['refs/heads/main', 'refs/heads/feat/k8s', 'refs/heads/other', 'refs/pull/1/merge']) {
      const context = { github: { event_name: event, ref } };
      const protectedRelease = event !== 'pull_request' && ref === 'refs/heads/main';
      assert.equal(workflowExpression(audit.env.SECURITY_AUDIT_ONLY, context), protectedRelease ? '1' : '0');
      assert.equal(workflowExpression(baseline.if, context), !protectedRelease);
      assert.equal(workflowExpression(live.if, context), event !== 'pull_request' && ref !== 'refs/heads/main');
      assert.equal(workflowExpression(releaseScan.env.SECURITY_AUDIT_ONLY, context), ref === 'refs/heads/main' ? '1' : '0');
    }
  }
});

test('independent daily audits cover every image and publish data without issue-write permission', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/security-audit.yml'), 'utf8'));
  assert.equal(workflow.on.pull_request, undefined);
  assert.ok(workflow.on.schedule.length);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.scan.strategy.matrix.include.map((item) => item.component), ['platform', 'standalone', 'worker', 'capture', 'starter']);
  for (const job of Object.values(workflow.jobs)) assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.jobs.scan.permissions.issues, undefined);
  assert.deepEqual(workflow.jobs.report.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.report.needs, ['plan', 'scan']);
  assert.match(workflow.jobs.report.if, /always\(\).*!cancelled\(\)/, 'partial scans still publish discoveries, without resolving existing findings');
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions?.issues, undefined);
  assert.doesNotMatch(JSON.stringify(workflow), /GH_TOKEN|SECURITY_ALERT_ASSIGNEE|security-alerts/);
  assert.equal(workflow.jobs.report.steps.find((s) => s.uses === 'actions/upload-artifact@v4').with.name,
    'homeroom-security-audit-${{ github.run_attempt }}');
  const scan = workflow.jobs.scan.steps.find((s) => s.name === 'Scan the complete image');
  assert.equal(scan.env.SECURITY_AUDIT_ONLY, '1');
  assert.equal(scan.env.LIVE_DIGEST, '${{ needs.plan.outputs[matrix.component] }}', 'all jobs share one release snapshot');
  assert.match(scan.run, /sh scripts\/check-published-image\.sh/);
  assert.match(scan.run, /sh scripts\/check-image-security\.sh/);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const upload = workflow.jobs.scan.steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  const download = workflow.jobs.report.steps.find((s) => s.uses === 'actions/download-artifact@v4');
  assert.match(upload.with.name, /github\.run_attempt/);
  assert.match(download.with.pattern, /github\.run_attempt/, 'a retry cannot consume older clean artifacts');
});

test('publishing requires candidate gates while full daily audits cannot block unrelated releases', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  const release = workflow.jobs.release;
  const regressions = workflow.jobs['security-regressions'].steps.find((s) => s.run?.includes('tests/build-stop-hook.test.js'));
  assert.match(regressions.run, /tests\/security-gate-baseline\.test\.js/);
  assert.match(regressions.run, /tests\/security-audit-report\.test\.js/);
  assert.match(JSON.stringify(workflow.jobs['preview-schema-compatibility'].steps), /tests\/platform-signals-postgres\.test\.js/);
  assert.deepEqual(release.needs, ['build', ...GATES]);
  assert.equal(workflow.jobs['scheduled-image-audit'], undefined);
  assert.match(release.if, /!cancelled\(\)/);
  const allowed = (event, build, audit, cancelled = false, gates = 'success') => workflowExpression(release.if, {
    github: { event_name: event }, cancelled: () => cancelled,
    needs: { build: { result: build }, 'scheduled-image-audit': { result: audit },
      ...Object.fromEntries(GATES.map((gate) => [gate, { result: typeof gates === 'string' ? gates : gates[gate] }])) },
  });
  assert.equal(allowed('schedule', 'success', 'success'), true);
  for (const status of ['failure', 'cancelled', 'skipped']) {
    assert.equal(allowed('schedule', 'success', status), true, `independent audit ${status} does not gate publishing`);
  }
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(allowed(event, 'success', 'skipped'), true, event);
    for (const status of ['failure', 'cancelled', 'skipped']) assert.equal(allowed(event, status, 'skipped'), false);
  }
  assert.equal(allowed('pull_request', 'skipped', 'skipped'), false);
  assert.equal(allowed('schedule', 'success', 'success', true), false);
  // The gates run beside the image builds (28 Oct 2026), so publishing is
  // where they hold: every one must pass, on every event.
  for (const gate of GATES) {
    for (const status of ['failure', 'cancelled', 'skipped']) {
      for (const event of ['push', 'workflow_dispatch', 'schedule']) {
        assert.equal(allowed(event, 'success', event === 'schedule' ? 'success' : 'skipped', false, { ...Object.fromEntries(GATES.map((g) => [g, 'success'])), [gate]: status }), false, `${event}: ${gate} ${status}`);
      }
    }
  }
});

const GATES = ['security-lockfiles', 'security-regressions', 'preview-schema-compatibility'];

test('the gates run beside the image builds: they wait for the plan, skip a run that will not release, and run on every pull request', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  assert.deepEqual([].concat(workflow.jobs.build.needs), ['plan'], 'the builds wait for nothing else');
  for (const gate of GATES) {
    const job = workflow.jobs[gate];
    assert.deepEqual([].concat(job.needs), ['plan'], gate);
    const runs = (event, plan, shouldRelease) => workflowExpression(job.if, {
      github: { event_name: event }, cancelled: () => false,
      needs: { plan: { result: plan, outputs: { should_release: shouldRelease } } },
    });
    assert.equal(runs('pull_request', 'skipped', undefined), true, `${gate}: a pull request (no plan) still runs it`);
    assert.equal(runs('push', 'success', 'true'), true, `${gate}: a release runs it`);
    assert.equal(runs('push', 'success', 'false'), false, `${gate}: a run that will not release skips it`);
    assert.equal(runs('push', 'failure', undefined), false, `${gate}: no plan, no release, no gate`);
  }
});

test('visible-change arrays reject excessive lengths before Zod visits any elements', () => {
  const { parseIntent, VisibleChangesValidationError } = require('../src/services/visible-changes');
  const { intent } = require('./fixtures/shots');
  const oversized = (length) => {
    const values = Array(length);
    Object.defineProperty(values, 0, { get() { throw new Error('oversized element was visited'); } });
    return values;
  };
  const cases = [
    [4, ['stories'], (v, a) => { v.stories = a; }],
    [3, ['stories', '0', 'viewports'], (v, a) => { v.stories[0].viewports = a; }],
    [41, ['stories', '0', 'intent', 'steps'], (v, a) => { v.stories[0].intent.steps = a; }],
    [6, ['stories', '0', 'intent', 'hints', 'expectText'], (v, a) => { v.stories[0].intent.hints = { expectText: a }; }],
  ];
  for (const [length, expectedPath, assign] of cases) {
    const candidate = intent();
    assign(candidate, oversized(length));
    assert.throws(() => parseIntent(candidate), (err) => {
      assert.ok(err instanceof VisibleChangesValidationError);
      assert.deepEqual(err.issues, [{ path: expectedPath, message: `Array must contain at most ${length - 1} element(s)` }]);
      return true;
    });
  }
});

test('visible-change JSON under the HTTP byte limit is rejected within a bounded heap', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { parseIntent, VisibleChangesValidationError } = require(process.argv[1]);
    const input = JSON.stringify({version:1, impact:'ui', rationale:'fixture', stories:Array(140000).fill({})});
    assert.ok(Buffer.byteLength(input) < 512 * 1024);
    assert.throws(() => parseIntent(JSON.parse(input)), err => err instanceof VisibleChangesValidationError
      && err.issues.length === 1 && err.issues[0].path.join('.') === 'stories');
    process.stdout.write('bounded');
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script,
    path.join(__dirname, '../src/services/visible-changes.js')], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, 'bounded');
});


test('a stale launch cannot claim a newly reused orphan process group', () => {
  const uid = process.getuid();
  const root = { pid: 2000000000, pgid: 2000000000, uid, start: 'original', cmd: 'node old-wrapper.js', state: 'S' };
  const exec = (_file, args) => args.includes('-p') ? ''
    : `${root.pid + 1} 1 ${uid} ${root.pid} Fri Oct 23 20:00:00 2026 S node /another-workspace/server.js\n`;
  assert.deepEqual(ownership.processGroup(root, { platform: 'darwin', exec }), [],
    'no live original identity exists to authorize adopting these same-user group members');
});
