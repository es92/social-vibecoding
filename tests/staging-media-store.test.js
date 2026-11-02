'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const media = require('../src/services/media-store');
const { createStagingMediaStore } = require('../src/services/staging-media-store');

const read = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test('preview fixture objects survive store recreation and serve exact ranges without bucket access', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'staging-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = Buffer.from('0123456789');
  const key = media.objectKey(data);
  const store = createStagingMediaStore({ directory });
  assert.equal(await store.statObject(key), null);
  await Promise.all([store.putObject(key, data), store.putObject(key, data)]);
  assert.equal((await store.statObject(key)).size, data.length);
  const recreated = createStagingMediaStore({ directory });
  assert.deepEqual(await read(await recreated.getObjectStream(key)), data);
  assert.equal((await read(await recreated.getObjectStream(key, { start: 3, end: 6 }))).toString(), '3456');
  assert.equal((await fs.readdir(directory)).length, 1, 'no partial temporary files remain');
  await assert.rejects(store.putObject('../../outside', data), /Invalid media object key/);
  await assert.rejects(read(await store.getObjectStream(media.objectKey(Buffer.from('missing')))), { code: 'ENOENT' });
});

test('only a staging process selects the preview-local store', (t) => {
  const previous = process.env.USERNODE_ENV;
  t.after(() => { if (previous === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = previous; });
  process.env.USERNODE_ENV = 'staging';
  // Even supplied settings never send preview fixtures to production S3.
  const store = media.getStore({ mediaStorageEndpoint: 'invalid-for-s3' });
  assert.equal(typeof store.putObject, 'function');
  process.env.USERNODE_ENV = 'production';
  assert.equal(media.getStore({}), null);
});
