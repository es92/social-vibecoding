'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createObserver, createPointerParker, lineTap, MARKER } = require('../worker/shots-browser-observer');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-browser-observer-'));
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  fs.writeFileSync(diagnosticFile, '');
  try {
    const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
    const stub = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'- heading \\"ok\\"'}]}})+'\\n')}});`;
    const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',origins:['http://base.internal','http://head.internal'],binary:process.execPath,args:['-e',${JSON.stringify(stub)}]});`;
    const child = spawn(process.execPath, ['-e', launcher], {
      env: { ...process.env, SHOTS_BROWSER_DIAGNOSTIC_FILE: diagnosticFile },
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

// A persona's phone browser runs in the same observer as `<persona>_phone`,
// and reports as that persona, marked as the phone.
for (const persona of ['full_admin', 'guest', 'member_phone', 'admin_phone']) test(`observer command-line entry point accepts the ${persona} shots persona`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-browser-observer-cli-'));
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  const stubPath = path.join(dir, 'playwright-mcp');
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
    const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
    const child = spawn(process.execPath, [observerPath, persona], {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`,
        SHOTS_BROWSER_DIAGNOSTIC_FILE: diagnosticFile,
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
    const phone = persona.endsWith('_phone');
    for (const event of diagnostics) {
      assert.equal(event.persona, persona.replace(/_phone$/, ''));
      assert.equal(event.phone, phone ? true : undefined, `${event.kind} says which browser it was`);
    }
    assert.deepEqual(diagnostics.map(event => event.kind), [
      'browser_call_start', 'browser_call_end', 'browser_server_exit',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the observer wraps only a shots persona\'s browser or its phone browser', () => {
  const { browserName } = require('../worker/shots-browser-observer');
  assert.deepEqual(browserName('member'), { persona: 'member', phone: false });
  assert.deepEqual(browserName('full_admin_phone'), { persona: 'full_admin', phone: true });
  for (const value of ['read_only_admin', 'member_phone_phone', 'phone', 'member-phone', '', undefined]) {
    assert.equal(browserName(value), null, String(value));
  }
  const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
  const refused = require('node:child_process').spawnSync(process.execPath, [observerPath, 'member-phone'],
    { stdio: 'ignore' });
  assert.equal(refused.status, 2, 'anything else starts no browser');
});

// #4087: a button left under the pointer after a click was shot in its hover
// colour. The observer parks the pointer outside the page before a
// screenshot that follows a click, and keeps a pointer the agent placed.
const call = (id, name, args = {}) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name, arguments: args } })}\n`;

test('the observer moves the pointer off the page before a screenshot that follows a click', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-browser-park-'));
  const received = path.join(dir, 'received.log');
  try {
    const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
    const stub = `const fs=require('fs');process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);fs.appendFileSync(${JSON.stringify(received)},line+'\\n');const m=JSON.parse(line);process.stdout.write(JSON.stringify({result:{content:[{type:'text',text:'### Ran '+m.params.name}]},jsonrpc:'2.0',id:m.id})+'\\n')}});`;
    const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',binary:process.execPath,args:['-e',${JSON.stringify(stub)}]});`;
    const child = spawn(process.execPath, ['-e', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.end([
      call(1, 'browser_click', { element: 'Send code', ref: 'e5' }),
      call(2, 'browser_take_screenshot', { filename: 'a.png' }),
      call(3, 'browser_take_screenshot', { filename: 'b.png' }),
      call(4, 'browser_hover', { element: 'Reactions', ref: 'e9' }),
      call(5, 'browser_take_screenshot', { filename: 'c.png' }),
    ].join(''));
    const [code] = await once(child, 'close');
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    const sent = fs.readFileSync(received, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(sent.map((message) => message.params.name), [
      'browser_click', 'browser_mouse_move_xy', 'browser_take_screenshot',
      'browser_take_screenshot', 'browser_hover', 'browser_take_screenshot',
    ]);
    assert.deepEqual(sent[1].params.arguments, {
      x: -1, y: -1,
    });
    assert.match(sent[1].id, /^usernode-shots-park-[0-9a-f]{12}-\d+$/);
    // The agent sees exactly its own calls answered, never the move.
    const answers = Buffer.concat(stdout).toString().trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(answers.map((message) => message.id), [1, 2, 3, 4, 5]);
    assert.doesNotMatch(Buffer.concat(stdout).toString(), /mouse_move|usernode-shots-park/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pointer parker holds the screenshot until the move is answered, and not forever', async () => {
  const parker = createPointerParker({ timeoutMs: 30 });
  const forwarded = [];
  parker.input.on('data', (chunk) => forwarded.push(...chunk.toString().trim().split('\n').map((l) => JSON.parse(l))));
  const answered = [];
  parker.output.on('data', (chunk) => answered.push(chunk.toString()));
  parker.input.write(call(1, 'browser_mouse_click_xy', { element: 'x', x: 5, y: 5 }) + call(2, 'browser_take_screenshot'));
  parker.input.write(call(3, 'browser_snapshot'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forwarded.map((m) => m.params.name), ['browser_mouse_click_xy', 'browser_mouse_move_xy']);
  // The move's answer is dropped and releases the queue in order; a split
  // line is reassembled first.
  const answer = JSON.stringify({ result: { content: [] }, jsonrpc: '2.0', id: forwarded[1].id });
  parker.output.write(answer.slice(0, 10));
  parker.output.write(`${answer.slice(10)}\n${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forwarded.map((m) => m.params.name), [
    'browser_mouse_click_xy', 'browser_mouse_move_xy', 'browser_take_screenshot', 'browser_snapshot',
  ]);
  assert.deepEqual(answered.join('').trim().split('\n').map((l) => JSON.parse(l).id), [1]);
  // A move that is never answered lets the screenshot through after the timeout.
  parker.input.write(call(4, 'browser_drag') + call(5, 'browser_take_screenshot'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.at(-1).params.name, 'browser_mouse_move_xy');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(forwarded.at(-1).params.name, 'browser_take_screenshot');
  parker.close();
  // With no move outstanding, a large answer streams through untouched.
  const fresh = createPointerParker();
  const streamed = [];
  fresh.output.on('data', (chunk) => streamed.push(chunk.toString()));
  const big = `${JSON.stringify({ jsonrpc: '2.0', id: 6, result: { content: [{ type: 'image', data: 'A'.repeat(400_000) }] } })}\n`;
  fresh.output.write(big.slice(0, 300_000));
  assert.ok(streamed.join('').length > 0, 'the start of a large answer is not held');
  fresh.output.end(big.slice(300_000));
  await once(fresh.output, 'end').catch(() => {});
  assert.equal(streamed.join(''), big);
  fresh.close();
});

// A parker driven by hand: what it forwards to the browser, what it answers.
function parkerHarness(options = {}) {
  const events = [];
  const parker = createPointerParker({ nonce: 'n0', emit: (event) => events.push(event), ...options });
  const forwarded = [];
  const raw = [];
  parker.input.on('data', (chunk) => {
    raw.push(chunk);
    forwarded.push(...chunk.toString().trim().split('\n').map((line) => JSON.parse(line)));
  });
  const answered = [];
  parker.output.on('data', (chunk) => answered.push(chunk));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const names = () => forwarded.map((message) => message.params?.name);
  const answerIds = () => Buffer.concat(answered).toString().trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line).id);
  return { parker, events, forwarded, raw, answered, tick, names, answerIds };
}

test('the parker forwards a character split across stdin chunks byte for byte', async () => {
  const h = parkerHarness();
  const line = Buffer.from(call(1, 'browser_type', { element: 'Name', ref: 'e1', text: 'café 😀' }));
  const cut = line.indexOf(Buffer.from('😀')) + 2;
  h.parker.input.write(line.subarray(0, cut));
  h.parker.input.write(line.subarray(cut));
  await h.tick();
  assert.ok(Buffer.concat(h.raw).equals(line));
  assert.equal(h.forwarded[0].params.arguments.text, 'café 😀');
  h.parker.close();
});

test('an oversized park answer is still recognized and never reaches the agent', async () => {
  const h = parkerHarness();
  h.parker.input.write(call(1, 'browser_click', { element: 'Send', ref: 'e1' }) + call(2, 'browser_take_screenshot'));
  await h.tick();
  const parkId = h.forwarded[1].id;
  // The SDK writes the id last, after a result that can be large.
  const big = Buffer.from(`${JSON.stringify({ result: { content: [{ type: 'text', text: 'x'.repeat(400_000) }] }, jsonrpc: '2.0', id: parkId })}\n`);
  h.parker.output.write(big.subarray(0, 300_000));
  h.parker.output.write(big.subarray(300_000));
  await h.tick();
  assert.deepEqual(h.answerIds(), []);
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy', 'browser_take_screenshot']);
  assert.equal(h.events[0].outcome, 'ok');
  h.parker.close();
});

test('a failed or timed-out park keeps the pointer dirty, so the next screenshot parks again', async (t) => {
  // The park deadline is advanced by hand: a busy runner must not let 20ms of
  // real time settle the first park before its error answer is read.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = parkerHarness({ timeoutMs: 20 });
  h.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' }) + call(2, 'browser_take_screenshot'));
  await h.tick();
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: h.forwarded[1].id, result: { isError: true, content: [{ type: 'text', text: 'No open tab' }] } })}\n`);
  await h.tick();
  assert.deepEqual(h.answerIds(), [], 'the park error is not forwarded');
  assert.equal(h.names().at(-1), 'browser_take_screenshot');
  h.parker.input.write(call(3, 'browser_take_screenshot'));
  await h.tick();
  assert.equal(h.names().at(-1), 'browser_mouse_move_xy', 'the next screenshot retries the park');
  const lateId = h.forwarded.at(-1).id;
  t.mock.timers.tick(20);
  await h.tick();
  assert.equal(h.names().at(-1), 'browser_take_screenshot', 'a timeout lets the screenshot through');
  h.parker.input.write(call(4, 'browser_take_screenshot'));
  await h.tick();
  assert.equal(h.names().at(-1), 'browser_mouse_move_xy', 'and keeps the pointer dirty');
  assert.deepEqual(h.events.map((event) => event.outcome), ['tool_error', 'timeout']);
  // The timed-out move's late answer is still dropped.
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: lateId, result: { content: [] } })}\n`);
  await h.tick();
  assert.deepEqual(h.answerIds(), []);
  h.parker.close();
});

test('a client id that looks like a park id passes through, and only clicks dirty the pointer', async () => {
  const h = parkerHarness();
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'usernode-shots-park-n0-1', result: {} })}\n`);
  for (const [id, tool] of [[1, 'browser_fill_form'], [2, 'browser_select_option'],
    [3, 'browser_file_upload'], [4, 'browser_type'], [5, 'browser_take_screenshot']]) {
    h.parker.input.write(call(id, tool));
  }
  await h.tick();
  assert.deepEqual(h.answerIds(), ['usernode-shots-park-n0-1']);
  assert.deepEqual(h.names(), ['browser_fill_form', 'browser_select_option',
    'browser_file_upload', 'browser_type', 'browser_take_screenshot']);
  h.parker.close();
});

test('with clips recorded, the pointer is parked before the session closes', async () => {
  const h = parkerHarness({ parkBeforeClose: true });
  h.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' }) + call(2, 'browser_close'));
  await h.tick();
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy']);
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: h.forwarded[1].id, result: { content: [] } })}\n`);
  await h.tick();
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy', 'browser_close']);
  const plain = parkerHarness();
  plain.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' }) + call(2, 'browser_close'));
  await plain.tick();
  assert.deepEqual(plain.names(), ['browser_click', 'browser_close']);
  h.parker.close();
  plain.parker.close();
});

test('a hover places the pointer only once it succeeds, and only with no click since', async () => {
  const answer = (h, id, isError = false) => h.parker.output.write(
    `${JSON.stringify({ result: { isError, content: [] }, jsonrpc: '2.0', id })}\n`);
  // A failed hover leaves the click's pointer dirty.
  const failed = parkerHarness();
  failed.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' })
    + call(2, 'browser_hover', { element: 'b', ref: 'e2' }) + call(3, 'browser_take_screenshot'));
  await failed.tick();
  assert.deepEqual(failed.names(), ['browser_click', 'browser_hover'], 'the screenshot waits for the hover');
  answer(failed, 1);
  answer(failed, 2, true);
  await failed.tick();
  assert.deepEqual(failed.names().slice(2), ['browser_mouse_move_xy']);
  assert.deepEqual(failed.answerIds(), [1, 2], 'the hover answer still reaches the agent');
  failed.parker.close();
  // A successful hover keeps the pointer where the agent put it.
  const placed = parkerHarness();
  placed.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' })
    + call(2, 'browser_hover', { element: 'b', ref: 'e2' }) + call(3, 'browser_take_screenshot'));
  await placed.tick();
  answer(placed, 2);
  await placed.tick();
  assert.deepEqual(placed.names(), ['browser_click', 'browser_hover', 'browser_take_screenshot']);
  placed.parker.close();
  // A click after the hover wins, even when the hover answers later.
  const clicked = parkerHarness();
  clicked.parker.input.write(call(1, 'browser_hover', { element: 'b', ref: 'e2' })
    + call(2, 'browser_click', { element: 'a', ref: 'e1' }) + call(3, 'browser_take_screenshot'));
  await clicked.tick();
  answer(clicked, 1);
  await clicked.tick();
  assert.deepEqual(clicked.names(), ['browser_hover', 'browser_click', 'browser_mouse_move_xy']);
  clicked.parker.close();
});

test('while a screenshot waits for its park, the parker reads no further input', async () => {
  const h = parkerHarness();
  let first = false;
  let second = false;
  h.parker.input.write(call(1, 'browser_click', { element: 'a', ref: 'e1' }) + call(2, 'browser_take_screenshot'), () => { first = true; });
  h.parker.input.write(call(3, 'browser_snapshot'), () => { second = true; });
  await h.tick();
  assert.equal(first, false);
  assert.equal(second, false);
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy']);
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: h.forwarded[1].id, result: { content: [] } })}\n`);
  await h.tick();
  assert.equal(first, true);
  assert.equal(second, true);
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy', 'browser_take_screenshot', 'browser_snapshot']);
  h.parker.close();
});

test('a held answer past the cap streams on in its own chunks and is reported', async () => {
  const h = parkerHarness();
  h.parker.input.write(call(1, 'browser_hover', { element: 'b', ref: 'e2' }));
  await h.tick();
  const piece = Buffer.alloc(1024 * 1024, 'a');
  for (let i = 0; i < 9; i += 1) h.parker.output.write(piece);
  await h.tick();
  assert.equal(Buffer.concat(h.answered).length, 9 * piece.length);
  assert.ok(h.answered.every((chunk) => chunk.length <= piece.length), 'no second full copy');
  assert.deepEqual(h.events.map((event) => event.outcome), ['held_line_over_cap']);
  h.parker.close();
});

test('observer exits after a client stops the browser while stdin remains open', async () => {
  const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
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

// With the shots browser open to the public internet, the shots bridge
// publishes a shot only from the run's own address for its side. The
// observer is what knows where each screenshot was taken: Playwright reports
// the page after most tools, and names the file a screenshot was saved as.
test('the observer stamps each screenshot with the site it was taken on, and each session with every site it showed', (t) => {
  const boundary = require('../worker/shots-boundary');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-observer-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputDir = path.join(dir, 'member');
  fs.mkdirSync(outputDir);
  const events = [];
  const observer = createObserver({ persona: 'member', origins: [], emit: (event) => events.push(event), outputDir });
  let id = 0;
  const call = (name, text, { isError = false } = {}) => {
    id += 1;
    observer.request(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: {} } }));
    observer.response(JSON.stringify({ id, result: { content: [{ type: 'text', text }], isError } }), { bytes: 100 });
  };
  const pageState = (url) => `### Ran Playwright code\n\`\`\`js\nawait page.goto('${url}');\n\`\`\`\n### Page\n- Page URL: ${url}\n- Page Title: T\n### Snapshot\n\`\`\`yaml\n- heading "T"\n\`\`\``;
  const shot = (name, pixels) => {
    const file = path.join(outputDir, name);
    fs.writeFileSync(file, pixels);
    call('browser_take_screenshot', `### Result\n- [Screenshot of viewport](${file})\n### Ran Playwright code\n\`\`\`js\n// Screenshot viewport and save it as ${file}\nawait page.screenshot();\n\`\`\``);
  };
  const origin = (name, pixels) => boundary.screenshotOrigin(outputDir, name, Buffer.from(pixels));

  call('browser_navigate', pageState('http://head.internal:3000/lists?id=7'));
  shot('lists-after.png', 'head pixels');
  assert.equal(origin('lists-after.png', 'head pixels'), 'http://head.internal:3000');

  call('browser_navigate', pageState('https://example.com/'));
  shot('elsewhere.png', 'other pixels');
  assert.equal(origin('elsewhere.png', 'other pixels'), 'https://example.com');

  // A failed screenshot, or one saved outside the browser's directory, is not stamped.
  fs.writeFileSync(path.join(outputDir, 'failed.png'), 'x');
  call('browser_take_screenshot', `### Result\n- [Screenshot of viewport](${path.join(outputDir, 'failed.png')})`, { isError: true });
  assert.equal(origin('failed.png', 'x'), null);
  fs.mkdirSync(path.join(outputDir, 'nested'));
  fs.writeFileSync(path.join(outputDir, 'nested', 'deep.png'), 'x');
  call('browser_take_screenshot', `### Result\n- [Screenshot of viewport](${path.join(outputDir, 'nested', 'deep.png')})`);
  assert.deepEqual(fs.readdirSync(boundary.provenanceDir(outputDir)).sort(), ['elsewhere.png.json', 'lists-after.png.json']);

  // Closing the session records every site it showed, as its clip is written.
  call('browser_close', '### Open tabs\nNo open tabs. Use the "browser_navigate" tool to navigate to a page first.\n');
  assert.deepEqual(boundary.sessionOrigins(outputDir), ['http://head.internal:3000', 'https://example.com']);
  // The next session starts empty, and a screenshot before any page has no site.
  shot('blank.png', 'blank');
  assert.equal(origin('blank.png', 'blank'), null);
  call('browser_navigate', pageState('http://head.internal:3000/'));
  call('browser_close', '### Open tabs\nNo open tabs.\n');
  assert.deepEqual(boundary.sessionOrigins(outputDir), ['http://head.internal:3000']);
  // A second close ended no session: the record stands.
  call('browser_close', '### Open tabs\nNo open tabs.\n');
  assert.deepEqual(boundary.sessionOrigins(outputDir), ['http://head.internal:3000']);

  // None of this reaches the diagnostics.
  assert.doesNotMatch(JSON.stringify(events), /head\.internal|example\.com|lists|\.png/);
});

test('a screenshot result over the capture limit is still stamped from its leading text', async (t) => {
  const boundary = require('../worker/shots-boundary');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-observer-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputDir = path.join(dir, 'admin');
  fs.mkdirSync(outputDir);
  const observer = createObserver({ persona: 'admin', origins: [], emit: () => {}, outputDir });
  observer.request(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: {} } }));
  observer.response(JSON.stringify({ id: 1, result: { content: [{ type: 'text',
    text: '### Page\n- Page URL: http://base.internal:3000/admin\n- Page Title: Admin' }] } }), { bytes: 80 });

  const file = path.join(outputDir, 'admin-before.png');
  fs.writeFileSync(file, 'big screenshot');
  observer.request(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: {} } }));
  const tap = lineTap((line, meta) => observer.response(line, meta));
  tap.resume();
  tap.end(`${JSON.stringify({ jsonrpc: '2.0', result: { content: [
    { type: 'text', text: `### Result\n- [Screenshot of viewport](${file})\n### Ran Playwright code` },
    { type: 'image', data: 'x'.repeat(2 * 1024 * 1024), mimeType: 'image/png' },
  ] }, id: 2 })}\n`);
  await once(tap, 'end');
  assert.equal(boundary.screenshotOrigin(outputDir, 'admin-before.png', Buffer.from('big screenshot')),
    'http://base.internal:3000');
});

test('the page Playwright reports is its page state, else the current tab', () => {
  const { reportedPageUrl, savedScreenshotPath } = require('../worker/shots-browser-observer');
  assert.equal(reportedPageUrl('### Open tabs\n- 0: [A](http://a.internal/)\n- 1: (current) [B](https://b.example/x)\n### Page\n- Page URL: https://b.example/x\n'),
    'https://b.example/x');
  assert.equal(reportedPageUrl('### Result\n- 0: (current) [Home](http://head.internal:3000/#home)\n- 1: [Docs](https://docs.example/)\n'),
    'http://head.internal:3000/#home');
  assert.equal(reportedPageUrl('### Result\n- [Screenshot of viewport](/tmp/x.png)'), null);
  assert.equal(savedScreenshotPath('### Result\n- [Screenshot of the invite card](/out/member/a-b.png)\n### Ran'), '/out/member/a-b.png');
  assert.equal(savedScreenshotPath('{"text":"### Result\\n- [Screenshot of viewport](/out/member/c.jpeg)\\n### Ran'), '/out/member/c.jpeg');
  assert.equal(savedScreenshotPath('### Result\nClicked'), null);
});

test('the observer starts the installed Playwright server unless the dry run names another', () => {
  const { browserCommand } = require('../worker/shots-browser-observer');
  assert.deepEqual(browserCommand(undefined), ['playwright-mcp']);
  assert.deepEqual(browserCommand('not json'), ['playwright-mcp']);
  assert.deepEqual(browserCommand('[]'), ['playwright-mcp']);
  assert.deepEqual(browserCommand('["npx",""]'), ['playwright-mcp']);
  assert.deepEqual(browserCommand('["npx","@playwright/mcp@0.0.85"]'), ['npx', '@playwright/mcp@0.0.85']);
});

// upload_file (worker/shots-mcp.js) asks the observer to send the browser an
// upload the agent's own tools cannot: the parker queues it with the agent's
// calls and hands its answer back to the tool alone.
test('a shots tool\'s own call reaches the browser in turn, and its answer goes to the tool, never the agent', async () => {
  const h = parkerHarness();
  // Behind a screenshot that waits for its park.
  h.parker.input.write(call(1, 'browser_click', { element: 'Upload', ref: 'e1' }) + call(2, 'browser_take_screenshot'));
  await h.tick();
  const uploaded = h.parker.inject('browser_file_upload', { paths: ['/samples/landscape.png'] });
  await h.tick();
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy']);
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: h.forwarded[1].id, result: { content: [] } })}\n`);
  await h.tick();
  assert.deepEqual(h.names(), ['browser_click', 'browser_mouse_move_xy', 'browser_take_screenshot', 'browser_file_upload']);
  const injected = h.forwarded[3];
  assert.equal(injected.id, 'usernode-shots-control-n0-1');
  assert.deepEqual(injected.params.arguments, { paths: ['/samples/landscape.png'] });
  const page = '### Page\n- Page URL: http://head.internal/upload';
  h.parker.output.write([
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    JSON.stringify({ result: { content: [{ type: 'text', text: page }] }, jsonrpc: '2.0', id: injected.id }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }),
    '',
  ].join('\n'));
  assert.deepEqual(await uploaded, { outcome: 'ok', text: page });
  await h.tick();
  assert.deepEqual(h.answerIds(), [1, 2], 'the agent sees only its own calls answered');
  // A refusal is the tool's to report.
  const refused = h.parker.inject('browser_file_upload', {});
  await h.tick();
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: h.forwarded.at(-1).id,
    result: { isError: true, content: [{ type: 'text', text: 'No file chooser visible' }] } })}\n`);
  assert.deepEqual(await refused, { outcome: 'tool_error', text: 'No file chooser visible' });
  assert.deepEqual(h.answerIds(), [1, 2]);
  h.parker.close();
});

test('an injected call not answered in time is dropped when it is, and a closed browser answers at once', async () => {
  const h = parkerHarness();
  const late = h.parker.inject('browser_file_upload', { paths: ['/samples/table.csv'] }, { limitMs: 20 });
  await h.tick();
  const id = h.forwarded.at(-1).id;
  assert.deepEqual(await late, { outcome: 'timeout', text: '' });
  h.parker.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [] } })}\n`);
  await h.tick();
  assert.deepEqual(h.answerIds(), [], 'the late answer never reaches the agent');
  const pending = h.parker.inject('browser_file_upload', {});
  h.parker.close();
  assert.deepEqual(await pending, { outcome: 'browser_gone', text: '' });
  assert.deepEqual(await h.parker.inject('browser_file_upload', {}), { outcome: 'browser_gone', text: '' });
});

test('the observer chooses the sample files itself, on its own socket, for the turn\'s token only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-ctl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const samplesDir = path.join(dir, 'samples');
  require('../worker/shots-samples').writeSamples(samplesDir);
  const received = path.join(dir, 'received.log');
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  fs.writeFileSync(diagnosticFile, '');
  const token = 'e'.repeat(64);
  const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
  const stub = `const fs=require('fs');process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);fs.appendFileSync(${JSON.stringify(received)},line+'\\n');const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'### Ran '+m.params.name+' '+JSON.stringify(m.params.arguments)+'\\n### Page\\n- Page URL: http://head.internal/upload'}]}})+'\\n')}});`;
  const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',binary:process.execPath,args:['-e',${JSON.stringify(stub)}],controlDir:${JSON.stringify(dir)},controlToken:${JSON.stringify(token)},samplesDir:${JSON.stringify(samplesDir)},diagnosticFile:${JSON.stringify(diagnosticFile)}});`;
  const child = spawn(process.execPath, ['-e', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  t.after(() => child.kill('SIGKILL'));
  const socketPath = path.join(dir, 'member.sock');
  for (let i = 0; i < 300; i += 1) {
    try { if ((fs.statSync(socketPath).mode & 0o777) === 0o600) break; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const ask = (message) => new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(socketPath);
    let data = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('error', reject);
  });

  const answer = await ask({ token, action: 'upload', files: ['landscape.png', 'table.csv'] });
  const chosen = [path.join(samplesDir, 'landscape.png'), path.join(samplesDir, 'table.csv')];
  assert.deepEqual(answer, { ok: true, outcome: 'ok',
    text: `### Ran browser_file_upload ${JSON.stringify({ paths: chosen })}\n### Page\n- Page URL: http://head.internal/upload` });
  for (const [message, code] of [
    [{ token: 'f'.repeat(64), action: 'upload', files: ['landscape.png'] }, 'forbidden'],
    [{ action: 'upload', files: ['landscape.png'] }, 'forbidden'],
    [{ token, action: 'evaluate', files: [] }, 'unknown_action'],
    [{ token, action: 'upload', files: ['../state/member.json'] }, 'unknown_sample_file'],
    [{ token, action: 'upload', files: ['/etc/passwd'] }, 'unknown_sample_file'],
    [{ token, action: 'upload', files: 'landscape.png' }, 'invalid_sample_files'],
  ]) {
    const refused = await ask(message);
    assert.deepEqual([refused.ok, refused.code], [false, code], JSON.stringify(message));
  }
  // The browser was sent the one upload, with the samples' own paths, and the
  // agent's stream carried none of it.
  const sent = fs.readFileSync(received, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((message) => [message.params.name, message.params.arguments]),
    [['browser_file_upload', { paths: chosen }]]);
  assert.match(sent[0].id, /^usernode-shots-control-[0-9a-f]{12}-1$/);
  assert.equal(Buffer.concat(stdout).length, 0);
  const events = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line.slice(MARKER.length)));
  assert.deepEqual(events.filter((event) => event.kind === 'sample_upload'),
    [{ kind: 'sample_upload', persona: 'member', outcome: 'ok', count: 2 }]);
  assert.doesNotMatch(fs.readFileSync(diagnosticFile, 'utf8'), /landscape|samples/, 'no file names in the trace');

  child.stdin.end();
  child.kill('SIGTERM');
  await once(child, 'close');
  assert.equal(fs.existsSync(socketPath), false, 'the socket goes with the browser');
});

test('the observer opens no control without its directory and a well-formed token', () => {
  const { startControl } = require('../worker/shots-browser-observer');
  const parker = { inject: async () => ({ outcome: 'ok', text: '' }) };
  assert.equal(startControl({ dir: '', name: 'member', token: 'e'.repeat(64), parker }), null);
  assert.equal(startControl({ dir: os.tmpdir(), name: 'member', token: 'short', parker }), null);
  assert.equal(startControl({ dir: os.tmpdir(), name: '../member', token: 'e'.repeat(64), parker }), null);
});

test('a close-up is taken on the observer\'s own socket, saved under its own name, and stamped with the page it shows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-closeup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outDir = path.join(dir, 'member');
  fs.mkdirSync(outDir);
  const received = path.join(dir, 'received.log');
  const diagnosticFile = path.join(dir, 'diagnostics.log');
  fs.writeFileSync(diagnosticFile, '');
  const token = 'e'.repeat(64);
  const observerPath = path.join(__dirname, '..', 'worker', 'shots-browser-observer.js');
  // A browser that saves what it is asked to, and says which page it is on.
  const stub = `const fs=require('fs'),path=require('path');process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);fs.appendFileSync(${JSON.stringify(received)},line+'\\n');const m=JSON.parse(line);let text='### Page\\n- Page URL: http://head.internal/invite';if(m.params.name==='browser_take_screenshot'){const f=path.join(${JSON.stringify(outDir)},m.params.arguments.filename);fs.writeFileSync(f,'png');text='Took the close-up screenshot and saved it as '+f}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text}]}})+'\\n')}});`;
  const launcher = `require(${JSON.stringify(observerPath)}).start({persona:'member',binary:process.execPath,args:['-e',${JSON.stringify(stub)},'--','--output-dir',${JSON.stringify(outDir)}],controlDir:${JSON.stringify(dir)},controlToken:${JSON.stringify(token)},diagnosticFile:${JSON.stringify(diagnosticFile)}});`;
  const child = spawn(process.execPath, ['-e', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  t.after(() => child.kill('SIGKILL'));
  const socketPath = path.join(dir, 'member.sock');
  for (let i = 0; i < 300; i += 1) {
    try { if ((fs.statSync(socketPath).mode & 0o777) === 0o600) break; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The agent opened the after page.
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://head.internal/invite' } } })}\n`);
  for (let i = 0; i < 300 && !Buffer.concat(stdout).toString().includes('"id":1'); i += 1) await new Promise((r) => setTimeout(r, 10));
  const ask = (message) => new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(socketPath);
    let data = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('error', reject);
  });
  const answer = await ask({ token, action: 'closeup', rect: { x: 40, y: 30, w: 66, h: 40 }, scale: 8.23 });
  assert.equal(answer.ok, true);
  assert.match(answer.file, /^closeup-[0-9a-f]{16}\.png$/);
  const sent = fs.readFileSync(received, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(sent.at(-1).params, { name: 'browser_take_screenshot',
    arguments: { filename: answer.file, closeup: { x: 40, y: 30, width: 66, height: 40, scale: 8.2 } } });
  assert.equal(require('../worker/shots-boundary').screenshotOrigin(outDir, answer.file, fs.readFileSync(path.join(outDir, answer.file))),
    'http://head.internal', 'stamped with the page it shows');
  for (const message of [
    { token, action: 'closeup', rect: { x: 40, y: 30, w: 0, h: 40 }, scale: 4 },
    { token, action: 'closeup', rect: { x: 40, y: 30, w: 66, h: 40 }, scale: 1 },
    { token, action: 'closeup', rect: { x: 40, y: 30, w: 66, h: 40 }, scale: 17 },
    { token, action: 'closeup', rect: { x: '40', y: 30, w: 66, h: 40 }, scale: 4 },
  ]) assert.deepEqual(await ask(message), { ok: false, code: 'invalid_closeup' }, JSON.stringify(message));
  assert.equal((await ask({ token: 'f'.repeat(64), action: 'closeup', rect: { x: 1, y: 1, w: 1, h: 1 }, scale: 4 })).code, 'forbidden');
  // A dark shot (#6787): the page switched to dark where it stands, shot,
  // and switched back, all in this browser and none of it in the agent's
  // stream; stamped with the page it shows.
  const before = fs.readFileSync(received, 'utf8').trim().split('\n').length;
  const dark = await ask({ token, action: 'dark' });
  assert.equal(dark.ok, true);
  assert.equal(dark.lightRestored, true);
  assert.match(dark.file, /^dark-[0-9a-f]{16}\.png$/);
  const darkCalls = fs.readFileSync(received, 'utf8').trim().split('\n').slice(before).map((line) => JSON.parse(line).params);
  assert.deepEqual(darkCalls, [
    { name: 'browser_emulate_media', arguments: { colorScheme: 'dark' } },
    { name: 'browser_wait_for', arguments: { time: 0.6 } },
    { name: 'browser_take_screenshot', arguments: { filename: dark.file } },
    { name: 'browser_emulate_media', arguments: { colorScheme: 'light' } },
  ]);
  assert.equal(require('../worker/shots-boundary').screenshotOrigin(outDir, dark.file, fs.readFileSync(path.join(outDir, dark.file))),
    'http://head.internal', 'stamped with the page it shows');
  assert.equal((await ask({ token: 'f'.repeat(64), action: 'dark' })).code, 'forbidden');
  // The agent's stream carried only its own answer.
  assert.equal(Buffer.concat(stdout).toString().trim().split('\n').length, 1);
  const events = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line.slice(MARKER.length)));
  assert.deepEqual(events.filter((event) => event.kind === 'closeup'), [{ kind: 'closeup', persona: 'member', outcome: 'ok' }]);
  child.stdin.end();
  child.kill('SIGTERM');
  await once(child, 'close');
});
