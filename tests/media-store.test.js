'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const media = require('../src/services/media-store');
const { memoryMediaStore } = require('./lib/media-store');

const CONFIG = {
  mediaStorageEndpoint: 'https://example.invalid', mediaStorageBucket: 'platform-media',
  mediaStorageAccessKey: 'test-access', mediaStorageSecretKey: 'test-secret',
};
const body = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test('media configuration is complete and independent of app file settings', () => {
  assert.equal(media.createMediaStore({ storageEndpoint: 'http://app-files.invalid', storageBucket: 'app-files',
    storageAccessKey: 'app-user', storageSecretKey: 'app-secret' }), null);
  for (const key of Object.keys(CONFIG)) {
    assert.throws(() => media.createMediaStore({ ...CONFIG, [key]: '' }), /requires an endpoint, bucket and both keys/);
  }
  for (const url of ['ftp://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/path']) {
    assert.throws(() => media.createMediaStore({ ...CONFIG, mediaStorageEndpoint: url }), /Invalid MEDIA_STORAGE_ENDPOINT/);
  }
  assert.equal(media.createMediaStore(CONFIG).bucket, 'platform-media');
});

test('raw object wrapper uses the media bucket, forwards byte ranges and never creates it', async () => {
  const calls = [];
  const client = {
    putObject: async (...args) => calls.push(['put', ...args]),
    getObject: async (...args) => { calls.push(['get', ...args]); return Readable.from([Buffer.from('abcd')]); },
    getPartialObject: async (...args) => { calls.push(['partial', ...args]); return Readable.from([Buffer.from('bc')]); },
    statObject: async (...args) => { calls.push(['stat', ...args]); return { size: 4 }; },
    removeObject: async (...args) => calls.push(['remove', ...args]),
    listObjectsV2: (...args) => { calls.push(['list', ...args]); return Readable.from([{ name: 'key' }]); },
  };
  const store = media.createMediaStore(CONFIG, { client });
  await store.putObject('key', Buffer.from('abcd'), 'video/webm');
  assert.equal((await body(await store.getObjectStream('key'))).toString(), 'abcd');
  assert.equal((await body(await store.getObjectStream('key', { start: 1, end: 2 }))).toString(), 'bc');
  assert.deepEqual(await store.statObject('key'), { size: 4 });
  await store.removeObject('key');
  for await (const object of store.objects('media/', 'after')) assert.equal(object.name, 'key');
  assert.deepEqual(calls.map((c) => c[0]), ['put', 'get', 'partial', 'stat', 'remove', 'list']);
  assert.ok(calls.every((c) => c[1] === 'platform-media'));
  assert.deepEqual(calls[2], ['partial', 'platform-media', 'key', 1, 2]);
  assert.deepEqual(calls[5], ['list', 'platform-media', 'media/', true, 'after']);
});

test('stat only treats a missing object as absent; bucket and permission failures propagate', async () => {
  const error = { code: 'NoSuchKey' };
  const store = media.createMediaStore(CONFIG, { client: { statObject: async () => { throw error; } } });
  assert.equal(await store.statObject('key'), null);
  error.code = 'NoSuchBucket';
  await assert.rejects(store.statObject('key'), (err) => err === error);
  error.code = 'AccessDenied';
  await assert.rejects(store.statObject('key'), (err) => err === error);
});

test('immutable SHA-256 upload takes the registry lock before I/O and deduplicates retries', async () => {
  const store = memoryMediaStore();
  const data = Buffer.from('hello');
  const key = 'media/sha256/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const tx = { query: async (sql, params) => {
    assert.match(sql, /INSERT INTO media_objects/);
    assert.deepEqual(params, [key]);
    assert.equal(store.calls.filter((c) => c.op === 'put').length, 0);
  } };
  assert.equal(await media.put(tx, store, data, 'image/png'), key);
  assert.equal(await media.put({ query: async () => {} }, store, data), key);
  assert.equal(store.calls.filter((c) => c.op === 'put').length, 1);
  assert.equal((await media.bytes(store, { object_key: key, data: null })).toString(), 'hello');
  assert.equal((await body(await media.stream(store, key, { start: 1, end: 3 }))).toString(), 'ell');
  store.files.get(key).data = Buffer.from('wrong size');
  await assert.rejects(media.put({ query: async () => {} }, store, data), /size mismatch/);
});

test('reads require a key and never fall back to database bytes', async () => {
  await assert.rejects(media.bytes(memoryMediaStore(), { object_key: null, data: Buffer.from('old') }), /Invalid media object key/);
  await assert.rejects(media.bytes(null, { object_key: media.objectKey(Buffer.from('x')), data: Buffer.from('old') }),
    { code: 'media_storage_unavailable' });
  await assert.rejects(media.bytes(memoryMediaStore(), { object_key: media.objectKey(Buffer.from('x')), data: Buffer.from('old') }),
    { code: 'NoSuchKey' });
  await assert.rejects(media.stream(memoryMediaStore(), 'some/other/prefix'), /Invalid media object key/);
});

test('unconfigured cleanup skips; listing is paged and young or unknown objects never reach the database', async () => {
  assert.deepEqual(await media.sweep(null, null), { skipped: 'unconfigured' });
  const store = memoryMediaStore();
  await store.putObject(media.objectKey(Buffer.from('a')), Buffer.from('a'));
  await store.putObject(media.objectKey(Buffer.from('b')), Buffer.from('b'));
  store.files.set(media.PREFIX + 'unknown', { data: Buffer.from('x'), lastModified: new Date(0) });
  const pool = { connect: async () => { throw new Error('should not touch the database'); } };
  const one = await media.sweep(pool, store, { limit: 1 });
  assert.equal(one.examined, 1); assert.equal(one.removed, 0); assert.ok(one.after);
  const rest = await media.sweep(pool, store, { after: one.after });
  assert.deepEqual(rest, { examined: 2, removed: 0, after: '' });
  const stopped = await media.sweep(pool, store, { after: one.after, shouldStop: () => true });
  assert.deepEqual(stopped, { examined: 0, removed: 0, after: one.after });
});
