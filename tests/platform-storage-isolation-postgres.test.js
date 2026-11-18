'use strict';

// Exercise the actual src/routes/app-files.js relay and
// src/services/app-files.js SQL against PostgreSQL. No production rows or
// objects are used. The access gate is already covered by app-files-route;
// this fixture isolates environment/app/uploader selection and stale relays.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const express = require('express');
const poolModule = require('../src/db/pool');
let query;
poolModule.getPool = () => ({ query: (...args) => query(...args) });
const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async (_pool, slug) => slug === 'fixture-app' ? { id: 7 } : null;
const { appFileShellRoutes } = require('../src/routes/app-files');
const { PER_USER_PER_APP_CAP } = require('../src/services/app-files');
const HEADER = { 'X-Usernode-App-Bridge': 'isolated-v2' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

test('storage relays isolate preview rows in PostgreSQL', async (t) => {
  const configured = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
  const client = new Client({ connectionString: configured || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await client.connect(); } catch (err) {
    await client.end().catch(() => {});
    if (configured) throw err;
    return t.skip(`Local PostgreSQL unavailable: ${err.code}`);
  }
  const schema = `storage_isolation_${crypto.randomBytes(8).toString('hex')}`;
  let server;
  const removed = [];
  let queries = 0;
  const store = { async removeFile(appId, id) { removed.push([appId, id]); }, async putFile() {} };
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE app_files (
      id TEXT PRIMARY KEY, app_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      filename TEXT NOT NULL DEFAULT 'fixture.png', content_type TEXT NOT NULL DEFAULT 'image/png',
      size_bytes INTEGER NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', staging BOOLEAN NOT NULL DEFAULT FALSE,
      owner TEXT NOT NULL DEFAULT 'user', sha256 TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Each app's file allowance (apps.file_storage_cap_bytes; NULL is the default).
    await client.query('CREATE TABLE apps (id INTEGER PRIMARY KEY, file_storage_cap_bytes BIGINT)');
    await client.query('INSERT INTO apps (id) VALUES (7), (8)');
    for (const [letter, app, user, size, staging] of [
      ['a', 7, 5, 10, false], ['b', 7, 5, 20, true], ['c', 7, 6, 30, false],
      ['d', 8, 5, 99, false], ['e', 7, 6, 50, true],
    ]) {
      await client.query('INSERT INTO app_files (id, app_id, user_id, size_bytes, staging) VALUES ($1, $2, $3, $4, $5)', [letter.repeat(32), app, user, size, staging]);
    }
    query = (...args) => { queries++; return client.query(...args); };
    const web = express();
    web.use((req, _res, next) => { req.user = { id: 5, username: 'fixture-user' }; next(); });
    web.use(appFileShellRoutes({}, { store }));
    server = web.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const call = async (path, { method = 'GET', headers = HEADER, body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/fixture-app/files${path}`, { method, headers, body });
      return { status: response.status, body: await response.json() };
    };
    const exists = async letter => (await client.query('SELECT 1 FROM app_files WHERE id = $1', [letter.repeat(32)])).rowCount === 1;

    await t.test('old or absent parent protocol refuses before SQL or object-store work', async () => {
      for (const headers of [{}, { 'X-Usernode-App-Bridge': 'v1' }]) {
        for (const [path, method] of [['/usage', 'GET'], ['?filename=fixture.png', 'POST'], [`/${'a'.repeat(32)}`, 'DELETE']]) {
          const result = await call(path, { method, headers });
          assert.equal(result.status, 403);
          assert.equal(result.body.code, 'bridge_refresh_required');
        }
      }
      assert.equal(queries, 0);
      assert.deepEqual(removed, []);
    });
    await t.test('usage is scoped to app and preview environment', async () => {
      for (const [staging, appBytes, userBytes] of [['0', 40, 10], ['1', 70, 20]]) {
        const result = await call(`/usage?staging=${staging}`);
        assert.equal(result.status, 200);
        assert.equal(result.body.appBytes, appBytes);
        assert.equal(result.body.userBytes, userBytes);
      }
    });
    await t.test('preview cannot delete production, or production delete preview', async () => {
      assert.equal((await call(`/${'a'.repeat(32)}?staging=1`, { method: 'DELETE' })).status, 404);
      assert.equal((await call(`/${'b'.repeat(32)}?staging=0`, { method: 'DELETE' })).status, 404);
      assert.equal(await exists('a'), true);
      assert.equal(await exists('b'), true);
      assert.deepEqual(removed, []);
    });
    await t.test('environment isolation retains app and uploader checks', async () => {
      assert.equal((await call(`/${'d'.repeat(32)}?staging=0`, { method: 'DELETE' })).status, 404);
      assert.equal((await call(`/${'e'.repeat(32)}?staging=1`, { method: 'DELETE' })).status, 404);
      assert.deepEqual(removed, []);
    });
    await t.test('both environments can still delete their own files', async () => {
      assert.equal((await call(`/${'b'.repeat(32)}?staging=1`, { method: 'DELETE' })).status, 200);
      assert.equal(await exists('b'), false);
      assert.equal(await exists('a'), true);
      assert.equal((await call(`/${'a'.repeat(32)}?staging=0`, { method: 'DELETE' })).status, 200);
      assert.deepEqual(removed, [[7, 'b'.repeat(32)], [7, 'a'.repeat(32)]]);
    });
    await t.test('preview upload stays stamped, with quotas spanning both environments', async () => {
      const result = await call('?filename=fixture.png&staging=1', {
        method: 'POST', headers: { ...HEADER, 'Content-Type': 'application/octet-stream' }, body: PNG,
      });
      assert.equal(result.status, 200);
      assert.equal((await client.query('SELECT staging FROM app_files WHERE id = $1', [result.body.id])).rows[0].staging, true);
      await client.query('INSERT INTO app_files (id, app_id, user_id, size_bytes) VALUES ($1, 7, 5, $2)', ['f'.repeat(32), PER_USER_PER_APP_CAP]);
      const full = await call('?filename=fixture.png&staging=1', {
        method: 'POST', headers: { ...HEADER, 'Content-Type': 'application/octet-stream' }, body: PNG,
      });
      assert.equal(full.status, 400);
      assert.equal(full.body.code, 'user_quota_exceeded');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
