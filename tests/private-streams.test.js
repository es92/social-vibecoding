'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const { streamResource } = require('../src/services/http-stream-access');
const policy = require('../src/services/cli-api-policy');
const { DELEGATION_KINDS } = require('../src/services/mcp-connect-constants');
const poolModule = require('../src/db/pool');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function server(t, handler, { query = async () => true, options = {}, bearer = false } = {}) {
    let calls = 0;
    const previous = poolModule.getPool;
    poolModule.getPool = () => ({ query: async () => { calls += 1; return { rows: [{ allowed: await query(calls) }] }; } });
    const modulePath = require.resolve('../src/middleware/private-streams');
    delete require.cache[modulePath];
    const { privateStreamDelivery } = require(modulePath);
    const app = express();
    app.use(require('../src/middleware/response-compression').responseCompression());
    app.use((req, _res, next) => {
        req.user = { id: 1 };
        req.cookies = { session: 'synthetic-cookie' };
        if (bearer)
            req.cliAuthenticated = true;
        next();
    });
    app.use(privateStreamDelivery({}, { revalidateMs: 1000, authorizeTimeoutMs: 1000, ...options }));
    app.use(handler);
    const http = app.listen(0, '127.0.0.1');
    await new Promise(resolve => http.once('listening', resolve));
    t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); poolModule.getPool = previous; delete require.cache[modulePath]; });
    return { base: `http://127.0.0.1:${http.address().port}`, calls: () => calls };
}
const sse = res => { res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=100'); };
test('private SSE classifies current platform routes and rejects new/ambiguous scopes', () => {
    assert.deepEqual(streamResource('GET', '/api/sessions/1/events'), { kind: 'classic', id: 1, collab: false });
    assert.deepEqual(streamResource('POST', '/api/sessions/1/chat'), { kind: 'classic', id: 1, collab: true });
    assert.deepEqual(streamResource('GET', '/API/SESSIONS/1/EVENTS/'), { kind: 'classic', id: 1, collab: false });
    assert.deepEqual(streamResource('GET', '/api/agent-sessions/%31/events'), { kind: 'agent', id: 1 });
    assert.deepEqual(streamResource('POST', '/api/agent-sessions/1/turns'), { kind: 'agent', id: 1 });
    assert.deepEqual(streamResource('POST', '/api/apps/a%2Db/workshop/ask'), { kind: 'app', slug: 'a-b' });
    for (const path of ['/api/sessions/0/events', '/api/sessions/01/events', '/api/sessions/2147483648/events', '/api/sessions/1garbage/events', '/api/sessions/%2f/events', '/api/agent-sessions/%zz/events', '/api/apps/a%2Fb/workshop/ask', '/api/new-private-stream'])
        assert.equal(streamResource(path.includes('/apps/') ? 'POST' : 'GET', path), null, path);
});
test('hosted connector policies expose no SSE routes; adding one needs a streaming credential policy', () => {
    const paths = [
        ['GET', '/api/sessions/1/events'], ['POST', '/api/sessions/1/chat'],
        ['GET', '/api/agent-sessions/1/events'], ['POST', '/api/agent-sessions/1/turns'],
        ['POST', '/api/apps/example/workshop/ask'],
    ];
    for (const [method, path] of paths) {
        assert.equal(policy.isConnectorApiRequest(method, path), false, path);
        for (const kind of DELEGATION_KINDS)
            assert.equal(policy.isDelegatedApiRequest(kind, method, path), false, `${kind}: ${path}`);
    }
});
test('production installs the stream boundary immediately after authentication', () => {
    const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const auth = source.indexOf('app.use(authMiddleware(config));');
    const guard = source.indexOf("app.use(require('./src/middleware/private-streams').privateStreamDelivery(config));");
    assert.ok(auth >= 0 && guard > auth);
    assert.doesNotMatch(source.slice(auth + 'app.use(authMiddleware(config));'.length, guard), /app\.use\(/, 'no router may bypass delivery between auth and the stream boundary');
    for (const route of ['agentSessionRoutes', 'sessionRoutes', 'workshopAskRoutes'])
        assert.ok(source.indexOf(`app.use(${route}(config))`) > guard, route);
});
test('ordinary JSON responses bypass stream authorization and retain their bytes', async (t) => {
    const s = await server(t, (_req, res) => res.status(207).json({ marker: 'ordinary' }));
    const r = await fetch(s.base + '/api/sessions/1/events');
    assert.equal(r.status, 207);
    assert.deepEqual(await r.json(), { marker: 'ordinary' });
    assert.equal(s.calls(), 0);
});
test('one-shot end, UTF-8 framing, compression and private cache headers survive delivery', async (t) => {
    const body = 'event: token\ndata: {"text":"synthetic 🙂"}\n\n';
    const s = await server(t, (_req, res) => { sse(res); res.end(body); });
    const r = await fetch(s.base + '/api/sessions/1/events', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(await r.text(), body);
    assert.equal(r.headers.get('content-encoding'), null);
    assert.match(r.headers.get('cache-control'), /private/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(s.calls(), 1);
});
for (const rawHeaders of [false, true])
    test(`writeHead overload preserves SSE protection (${rawHeaders ? 'array' : 'object'})`, async (t) => {
        const s = await server(t, (_req, res) => {
            res.writeHead(200, 'OK', rawHeaders ? ['Content-Type', 'text/event-stream', 'Cache-Control', 'public'] : { 'Content-Type': 'text/event-stream', 'Cache-Control': 'public' });
            res.end('data: synthetic\n\n');
        });
        const r = await fetch(s.base + '/api/sessions/1/events');
        assert.equal(await r.text(), 'data: synthetic\n\n');
        assert.match(r.headers.get('cache-control'), /no-store/);
        assert.equal(s.calls(), 1);
    });
test('a burst shares a check without dropping frames, UTF-8 byte fragments or callbacks', async (t) => {
    let callbacks = 0;
    const data = Buffer.from('data: 🙂\n\n');
    const s = await server(t, (_req, res) => {
        sse(res);
        for (let i = 0; i < 100; i++) {
            res.write(data.subarray(0, 7), () => callbacks++);
            res.write(data.subarray(7), () => callbacks++);
        }
        res.end();
    });
    const r = await fetch(s.base + '/api/sessions/1/events');
    assert.equal(await r.text(), data.toString().repeat(100));
    await tick();
    assert.equal(callbacks, 200);
    assert.equal(s.calls(), 1);
});
test('an end chunk queued behind an authorization decision is discarded on refusal', async (t) => {
    const entered = gate(), release = gate();
    let done = false;
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n', () => { done = true; }); }, {
        query: async () => { entered.resolve(); await release.promise; return false; },
    });
    const response = fetch(s.base + '/api/sessions/1/events');
    await entered.promise;
    release.resolve();
    assert.equal(await (await response).text(), '');
    await tick();
    assert.equal(done, true);
});
test('bytes arriving during an authorized batch need a new snapshot', async (t) => {
    const entered = gate(), release = gate();
    let response;
    const s = await server(t, (_req, res) => { response = res; sse(res); res.write('data: allowed\n\n'); }, {
        query: async (n) => {
            if (n === 1) {
                entered.resolve();
                await release.promise;
                return true;
            }
            return false;
        },
    });
    const request = fetch(s.base + '/api/sessions/1/events');
    await entered.promise;
    response.end('data: FORBIDDEN_NEW_BATCH\n\n');
    release.resolve();
    assert.equal(await (await request).text(), 'data: allowed\n\n');
    assert.equal(s.calls(), 2);
});
for (const failure of ['denied', 'error', 'timeout'])
    test(`stream fails closed when authorization is ${failure}`, async (t) => {
        const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, {
            query: async () => {
                if (failure === 'error')
                    throw new Error('synthetic failure');
                if (failure === 'timeout')
                    return new Promise(() => { });
                return false;
            },
            options: { authorizeTimeoutMs: 30 },
        });
        assert.equal(await (await fetch(s.base + '/api/sessions/1/events')).text(), '');
    });
test('idle streams are revalidated and closed without needing another private event', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.write(':connected\n\n'); }, {
        query: async (n) => n === 1, options: { revalidateMs: 20 },
    });
    assert.equal(await (await fetch(s.base + '/api/sessions/1/events')).text(), ':connected\n\n');
    assert.equal(s.calls(), 2);
});
test('unclassified SSE cannot send bytes even to a valid user', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); });
    assert.equal(await (await fetch(s.base + '/api/new-private-stream')).text(), '');
    assert.equal(s.calls(), 0);
});
test('an unsupported connector cannot borrow an accompanying browser cookie', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, { bearer: true });
    assert.equal(await (await fetch(s.base + '/api/sessions/1/events')).text(), '');
    assert.equal(s.calls(), 0);
});
test('oversized pending output closes the stream with a bounded queue', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('x'.repeat(1024 * 1024 + 1)); });
    assert.equal(await (await fetch(s.base + '/api/sessions/1/events')).text(), '');
});
test('Express case-insensitive aliases cannot skip current stream authority', async (t) => {
    const s = await server(t, (_req, res) => { sse(res); res.end('data: FORBIDDEN\n\n'); }, { query: async () => false });
    assert.equal(await (await fetch(s.base + '/API/SESSIONS/1/EVENTS/')).text(), '');
    assert.equal(s.calls(), 1);
});
test('changing the MIME type cannot release an already guarded SSE body', async (t) => {
    const s = await server(t, (_req, res) => {
        sse(res);
        res.write('data: FORBIDDEN_FIRST_CHUNK\n\n');
        res.setHeader('Content-Type', 'application/json');
        res.end('FORBIDDEN_END_CHUNK');
    }, { query: async () => false });
    const response = await fetch(s.base + '/api/sessions/1/events');
    assert.equal(await response.text(), '');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(s.calls(), 1);
});
test('backpressure preserves a legitimate replay larger than the pending-output limit', async (t) => {
    const { waitForStreamDrain } = require('../src/services/http-stream-access');
    const frame = 'data: ' + 'x'.repeat(8192) + '\n\n';
    const s = await server(t, async (_req, res) => {
        sse(res);
        for (let i = 0; i < 256; i++) {
            if (res.write(frame) === false)
                await waitForStreamDrain(res);
        }
        res.end();
    });
    const r = await fetch(s.base + '/api/sessions/1/events');
    assert.equal(await r.text(), frame.repeat(256));
    assert.ok(s.calls() < 40, 'coalesce frames rather than querying once per frame');
});


test('a large SSE frame and concurrent heartbeat remain ordered without exceeding the pending budget', async (t) => {
    const { writeStreamChunk } = require('../src/services/http-stream-access');
    const body = 'data: ' + JSON.stringify({ text: '🙂'.repeat(300000) }) + '\n\n';
    const heartbeat = ': heartbeat\n\n';
    const next = 'data: {"done":true}\n\n';
    const s = await server(t, async (_req, res) => {
        sse(res);
        await Promise.all([writeStreamChunk(res, body), writeStreamChunk(res, heartbeat), writeStreamChunk(res, next)]);
        res.end();
    }, { options: { batchMs: 2 } });
    const r = await fetch(s.base + '/api/sessions/1/events');
    assert.equal(await r.text(), body + heartbeat + next);
    assert.ok(s.calls() > 1);
});

test('revocation during a large frame stops its remaining bytes and releases the producer', async (t) => {
    const { writeStreamChunk } = require('../src/services/http-stream-access');
    const prefix = 'data: ' + 'x'.repeat(150000);
    let delivered;
    const s = await server(t, async (_req, res) => {
        sse(res);
        delivered = await writeStreamChunk(res, prefix + 'FORBIDDEN_AFTER_REVOCATION\n\n');
        res.end();
    }, { query: async n => n === 1, options: { batchMs: 2 } });
    const r = await fetch(s.base + '/api/sessions/1/events');
    const body = await r.text();
    assert.ok(body.length > 0 && body.length < prefix.length);
    assert.ok(!body.includes('FORBIDDEN_AFTER_REVOCATION'));
    await tick();
    assert.equal(delivered, false);
});


test('heartbeats are skipped while a frame waits for drain, without extending the output queue', async (t) => {
    const { writeStreamChunk, writeStreamHeartbeat } = require('../src/services/http-stream-access');
    const entered = gate(), release = gate();
    const frame = 'data: ' + 'x'.repeat(120000) + '\n\n';
    let response;
    const s = await server(t, async (_req, res) => {
        response = res; sse(res);
        await writeStreamChunk(res, frame);
        res.end();
    }, { query: async n => { if (n === 1) { entered.resolve(); await release.promise; } return true; }, options: { batchMs: 2 } });
    const request = fetch(s.base + '/api/sessions/1/events');
    await entered.promise;
    const heartbeatResults = await Promise.all(Array.from({ length: 20 }, () => writeStreamHeartbeat(response, ': heartbeat\n\n')));
    assert.ok(heartbeatResults.every(value => value === false));
    release.resolve();
    assert.equal(await (await request).text(), frame);
});


test('a missing drain has a deadline and releases its producer and listeners', async () => {
    const { EventEmitter } = require('node:events');
    const { waitForStreamDrain } = require('../src/services/http-stream-access');
    const res = new EventEmitter();
    res.destroyed = false;
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        assert.equal(await waitForStreamDrain(res, { timeoutMs: 5 }), false);
        assert.equal(res.destroyed, true);
        for (const event of ['drain', 'finish', 'close', 'error']) assert.equal(res.listenerCount(event), 0);
    } finally { clearTimeout(keepAlive); }
});


test('explicit cancellation releases a heartbeat waiting on a slow response', async () => {
    const { EventEmitter } = require('node:events');
    const { writeStreamHeartbeat } = require('../src/services/http-stream-access');
    const controller = new AbortController();
    const res = new EventEmitter();
    res.destroyed = false;
    res.write = () => false;
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    const pending = writeStreamHeartbeat(res, ': heartbeat\n\n', { signal: controller.signal });
    await tick();
    controller.abort();
    assert.equal(await pending, false);
    assert.equal(res.destroyed, true);
    for (const event of ['drain', 'finish', 'close', 'error']) assert.equal(res.listenerCount(event), 0);
});
