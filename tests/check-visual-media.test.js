'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const media = require('../src/services/media-store');
const { metadata } = require('../src/services/check-visual-media');
const { useMemoryMedia } = require('./lib/media-store');

const request = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  http.request(url, { headers, method }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: Buffer.concat(chunks) }));
    response.on('error', reject);
  }).on('error', reject).end();
});

test('check visuals preserve Express validators and range responses when bytes move to storage', async (t) => {
  const store = useMemoryMedia(t);
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const key = media.objectKey(data);
  const meta = metadata(data);
  await store.putObject(key, data, 'video/webm');
  let absent = false;
  const pool = { query: async () => ({ rows: absent ? [] : [{ content_type: 'video/webm', object_key: key, bytes: meta.bytes, legacy_etag: meta.legacyEtag }] }) };
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  const app = express();
  app.use(require('../src/routes/visuals').visualsRoutes({}, { store }));
  // The reference is Express res.send, which generated the existing tags.
  // Expected slices/statuses below are explicit rather than another parser.
  let expected = { status: 200 };
  app.get('/expected', (req, res) => {
    res.set('Content-Type', 'video/webm');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');
    res.status(expected.status);
    if (expected.status === 416) return res.set('Content-Range', `bytes */${data.length}`).end();
    if (expected.status === 206) res.set('Content-Range', `bytes ${expected.start}-${expected.end}/${data.length}`);
    return res.send(expected.status === 206 ? data.subarray(expected.start, expected.end + 1) : data);
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin + '/visuals/' + 'a'.repeat(32);
  const compare = async (headers = {}, method = 'GET') => {
    const reference = await request(origin + '/expected', headers, method);
    const actual = await request(url, headers, method);
    assert.equal(actual.status, reference.status);
    assert.deepEqual(actual.data, reference.data);
    for (const h of ['content-type', 'content-length', 'etag', 'cache-control', 'accept-ranges', 'content-range', 'x-content-type-options']) {
      assert.equal(actual.headers[h], reference.headers[h], `${h}: ${JSON.stringify(headers)}`);
    }
    return actual;
  };
  {
    for (const [header, result] of [
      [null, { status: 200 }], ['nonsense', { status: 200 }], ['bytes=1-2,4-5', { status: 200 }],
      ['bytes=3-7', { status: 206, start: 3, end: 7 }], ['bytes=30-', { status: 206, start: 30, end: 35 }],
      ['bytes=-5', { status: 206, start: 31, end: 35 }], ['bytes=30-999', { status: 206, start: 30, end: 35 }],
      ['bytes=999-', { status: 416 }], ['bytes=-0', { status: 416 }],
    ]) {
      expected = result;
      await compare(header ? { range: header } : {});
    }
    expected = { status: 200 };
    await compare({}, 'HEAD');
    const before = store.calls.length;
    assert.equal((await compare({ 'if-none-match': meta.legacyEtag })).status, 304);
    assert.equal(store.calls.length, before, 'full-body 304 opens no object');
    expected = { status: 206, start: 3, end: 7 };
    const reference = await request(origin + '/expected');
    await compare({ range: 'bytes=3-7', 'if-none-match': reference.headers.etag });
  }
  assert.deepEqual(store.calls.filter((c) => c.op === 'get' && c.range).map((c) => c.range), [
    { start: 3, end: 7 }, { start: 30, end: 35 }, { start: 31, end: 35 }, { start: 30, end: 35 }, { start: 3, end: 7 },
  ]);
  absent = true;
  const before = store.calls.length;
  assert.equal((await request(url)).status, 404);
  assert.equal((await request(origin + '/visuals/not-an-id')).status, 404);
  assert.equal(store.calls.length, before);
  absent = false; store.files.delete(key);
  const broken = await request(url);
  assert.equal(broken.status, 500);
  assert.equal(broken.headers['cache-control'], undefined);
  assert.equal(broken.headers.etag, undefined);
});
