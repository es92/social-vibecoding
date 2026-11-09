'use strict';

// #6534: the files Homeroom bot stores under its reply in a thread.
//
// The chat composer's own classifier decides what a file is, at most four
// files go under one reply, the app's storage cap is checked before a byte
// is stored, and a refusal stores nothing. The rows are unlinked until the
// reply is posted (ws.sendBotMessage), so a quiet turn leaves none attached.
//
// Run with: node --test tests/homeroom-bot-thread-attachments.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/services/homeroom-bot-thread-attachments').store;
const attachments = require('../src/services/attachments');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 1),
]);

function fakePool({ used = 0 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('COALESCE(SUM(size_bytes)')) return { rows: [{ total: String(used) }] };
      if (sql.includes('INSERT INTO chat_message_attachments')) return { rows: [] };
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const ctx = () => ({ app: { id: 5 }, bot: { id: 9 }, attached: [] });

test('a picture is stored as an ordinary chat attachment and pushed onto the reply', async () => {
  const pool = fakePool();
  const c = ctx();
  const out = await store(pool, c, [{ filename: 'Option A.png', data: PNG }]);
  assert.equal(out.ok, true);
  assert.equal(out.stored.length, 1);
  assert.equal(out.stored[0].kind, 'image');
  assert.equal(out.stored[0].filename, 'Option A.png');
  assert.deepEqual(c.attached, out.stored);
  const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO chat_message_attachments'));
  assert.equal(insert.params[1], 5, 'stored against the app');
  assert.equal(insert.params[2], 9, 'and the bot');
  assert.equal(insert.params[3], 'image');
  assert.ok(Buffer.isBuffer(insert.params[8]), 'the bytes travel with the row');
});

test('a file the composer would refuse stores nothing', async () => {
  const pool = fakePool();
  const c = ctx();
  const out = await store(pool, c, [{ filename: 'design.png', data: Buffer.from('not a png at all') }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /valid PNG/);
  assert.deepEqual(c.attached, []);
  assert.ok(!pool.queries.some((q) => q.sql.includes('INSERT INTO chat_message_attachments')));
});

test('a reply carries at most four files', async () => {
  const pool = fakePool();
  const c = { ...ctx(), attached: [{ id: 'a'.repeat(32) }, { id: 'b'.repeat(32) }, { id: 'c'.repeat(32) }] };
  const out = await store(pool, c, [
    { filename: 'one.png', data: PNG }, { filename: 'two.png', data: PNG },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.error, /at most 4 files/);
  assert.equal(c.attached.length, 3, 'what was already there stays');
});

test('a full project refuses before a byte is stored, naming the limit', async () => {
  const pool = fakePool({ used: attachments.MAX_APP_CHAT_BYTES });
  const out = await store(pool, ctx(), [{ filename: 'Option A.png', data: PNG }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /storage is full \(200 MB max\)/);
  assert.ok(!pool.queries.some((q) => q.sql.includes('INSERT INTO chat_message_attachments')));
});

test('an HTML design is stored as an html row, which opens only in the viewer', async () => {
  const pool = fakePool();
  const out = await store(pool, ctx(), [{ filename: 'design.html', data: Buffer.from('<html><body>Hi</body></html>') }]);
  assert.equal(out.ok, true);
  assert.equal(out.stored[0].kind, 'html');
});
