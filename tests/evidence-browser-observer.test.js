'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createObserver, lineTap, MARKER } = require('../worker/evidence-browser-observer');

test('browser boundary reports real pending/completion time and response shape without page content', () => {
  const events = [];
  let now = 0;
  const observer = createObserver({
    persona: 'member', origins: ['http://base.internal:3000', 'http://head.internal:3000'],
    hints: { intentPaths: ['/'], declaredPaths: ['/?demo=1#app/private/workshop'] },
    emit: (event) => events.push(event), now: () => now,
  });
  const privateUrl = 'http://base.internal:3000/?demo=1#app/private/workshop';
  observer.request(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: privateUrl, token: 'private-token' } },
  }));
  now = 20_000;
  observer.pending();
  now = 32_000;
  const content = '- heading "Private workshop"\n- button "Add"\n- link "Secret"';
  observer.response(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {
    content: [{ type: 'text', text: content }], isError: false,
  } }), { bytes: 200 });
  assert.deepEqual(events.map((event) => event.kind), [
    'browser_call_start', 'browser_call_pending', 'browser_call_end',
  ]);
  assert.equal(events[0].routeHint, 'declared_check');
  assert.equal(events[0].checkRank, 1);
  assert.equal(events[1].durationMs, 20_000);
  assert.equal(events[2].durationMs, 32_000);
  assert.equal(events[2].outcome, 'ok');
  assert.equal(events[2].headingCount, 1);
  assert.equal(events[2].buttonCount, 1);
  assert.equal(events[2].linkCount, 1);
  assert.equal(events[2].textChars, content.length);
  assert.doesNotMatch(JSON.stringify(events), /private|secret|workshop|demo=1|token/i);
});

test('browser boundary classifies tool failure and preserves an unfinished call on exit', () => {
  const events = [];
  let now = 1;
  const observer = createObserver({ persona: 'admin', origins: [],
    emit: (event) => events.push(event), now: () => now });
  observer.request(JSON.stringify({ id: 'one', method: 'tools/call',
    params: { name: 'browser_snapshot', arguments: {} } }));
  now = 40;
  observer.response(JSON.stringify({ id: 'one', result: { isError: true,
    content: [{ type: 'text', text: 'TimeoutError at private.example/path' }],
  } }), { bytes: 120 });
  observer.request(JSON.stringify({ id: 'two', method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: 'https://outside.invalid/secret' } } }));
  now = 100;
  observer.exit(143, 'SIGTERM');
  assert.equal(events[1].outcome, 'tool_error');
  assert.equal(events[1].errorClass, 'timeout');
  assert.equal(events[3].outcome, 'server_exit');
  assert.equal(events[3].durationMs, 60);
  assert.equal(events[4].kind, 'browser_server_exit');
  assert.equal(events[4].exitCode, 143);
  assert.doesNotMatch(JSON.stringify(events), /private|outside\.invalid|secret/i);
});

test('future browser tools remain visible without retaining their unrecognized names', () => {
  const events = [];
  const observer = createObserver({ persona: 'member', origins: [], emit: event => events.push(event) });
  observer.request(JSON.stringify({ id: 4, method: 'tools/call',
    params: { name: 'private_future_tool', arguments: { secret: 'private-token' } } }));
  observer.response(JSON.stringify({ id: 4, result: { content: [] } }), { bytes: 30 });
  assert.equal(events[0].tool, 'other');
  assert.equal(events[1].outcome, 'ok');
  assert.doesNotMatch(JSON.stringify(events), /private|future|token/i);
});

test('oversized screenshot responses still complete the browser call when the RPC id follows content', async () => {
  const events = [];
  const observer = createObserver({ persona: 'member', origins: [], emit: event => events.push(event) });
  observer.request(JSON.stringify({ id: 7, method: 'tools/call',
    params: { name: 'browser_take_screenshot', arguments: {} } }));
  const tap = lineTap((line, meta) => observer.response(line, meta));
  let forwardedBytes = 0;
  tap.on('data', chunk => { forwardedBytes += chunk.length; });
  const response = `${JSON.stringify({ jsonrpc: '2.0', result: { content: [
    { type: 'image', data: 'x'.repeat(2 * 1024 * 1024) },
  ] }, id: 7 })}\n`;
  tap.end(response);
  await once(tap, 'end');
  assert.equal(forwardedBytes, Buffer.byteLength(response));
  assert.equal(events[1].kind, 'browser_call_end');
  assert.equal(events[1].outcome, 'unparsed');
  assert.ok(events[1].responseBytes > 2 * 1024 * 1024);
  assert.deepEqual(events.filter(event => event.kind === 'browser_call_pending'), []);
});

test('observer forwards MCP JSON-RPC unchanged through a child server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-browser-observer-'));
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  fs.writeFileSync(diagnosticFile, '');
  try {
    const observerPath = path.join(__dirname, '..', 'worker', 'evidence-browser-observer.js');
    const stub = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'- heading \\"ok\\"'}]}})+'\\n')}});`;
    const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',origins:['http://base.internal','http://head.internal'],binary:process.execPath,args:['-e',${JSON.stringify(stub)}]});`;
    const child = spawn(process.execPath, ['-e', launcher], {
      env: { ...process.env, EVIDENCE_BROWSER_DIAGNOSTIC_FILE: diagnosticFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} } })}\n`);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), {
      jsonrpc: '2.0', id: 7,
      result: { content: [{ type: 'text', text: '- heading "ok"' }] },
    });
    const diagnostics = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line.slice(MARKER.length)));
    assert.deepEqual(diagnostics.map((event) => event.kind), [
      'browser_call_start', 'browser_call_end', 'browser_server_exit',
    ]);
    assert.equal(diagnostics[1].outcome, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer command-line entry point accepts the full-admin evidence persona', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-browser-observer-cli-'));
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  const stubPath = path.join(dir, 'mcp-server-playwright');
  fs.writeFileSync(diagnosticFile, '');
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: '- heading "ok"' }] } }) + '\\n');
  }
});
`, { mode: 0o755 });
  try {
    const observerPath = path.join(__dirname, '..', 'worker', 'evidence-browser-observer.js');
    const child = spawn(process.execPath, [observerPath, 'full_admin'], {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`,
        EVIDENCE_BROWSER_DIAGNOSTIC_FILE: diagnosticFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} } })}\n`);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    assert.equal(JSON.parse(Buffer.concat(stdout).toString()).id, 11);
    const diagnostics = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line.slice(MARKER.length)));
    assert.equal(diagnostics[0].persona, 'full_admin');
    assert.deepEqual(diagnostics.map(event => event.kind), [
      'browser_call_start', 'browser_call_end', 'browser_server_exit',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer exits after a client stops the browser while stdin remains open', async () => {
  const observerPath = path.join(__dirname, '..', 'worker', 'evidence-browser-observer.js');
  const stub = `process.stdin.on('data',chunk=>{const m=JSON.parse(chunk.toString());process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[]}})+'\\n')});`;
  const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',binary:process.execPath,args:['-e',${JSON.stringify(stub)}]});`;
  const child = spawn(process.execPath, ['-e', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let output = '';
    const response = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.trim()));
      });
      child.once('error', reject);
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'tools/call',
      params: { name: 'browser_tabs', arguments: { action: 'list' } } })}\n`);
    assert.equal((await response).id, 1);
    child.kill('SIGTERM');
    let timeout;
    const [code] = await Promise.race([
      once(child, 'close'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('observer did not exit')), 2000); }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(typeof code, 'number');
  } finally {
    child.kill('SIGKILL');
  }
});
