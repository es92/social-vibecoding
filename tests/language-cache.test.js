'use strict';

// The translation cache (src/services/language-cache.js) and its routes
// (src/routes/languages.js): what the shell is offered, and in which words,
// from the running build's catalogs with the cached translations laid over
// them. frontend/locales/README.md, "Translations", is the contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { hash, writeSource } = require('../scripts/language-packs');
const cache = require('../src/services/language-cache');

const says = (text) => ({ text, description: 'Fixture message.' });
const from = (english, text, extra = {}) => ({ text, source: hash(english), ...extra });
const ENGLISH = {
  hello: says('Hello {{name}}'),
  leave: says('Leave'),
  join: says('Join'),
  items_one: says('{{count}} item'),
  items_other: says('{{count}} items'),
};

/** A build's catalogs (its .source.json), from `translations` committed beside ENGLISH. */
function sourceFor(t, { translations = {}, english = ENGLISH, minimumCoverage = 0.95 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-cache-src-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data));
  };
  put('config.json', { sourceLanguage: 'en', minimumCoverage, languages: { en: 'English', es: 'Español' } });
  put('glossary.json', { doNotTranslate: [] });
  put('en/core.json', english);
  for (const [language, catalog] of Object.entries(translations)) put(`${language}/core.json`, catalog);
  return JSON.parse(fs.readFileSync(writeSource(root, path.join(root, 'out')), 'utf8'));
}

/** A pool whose language_translations holds `rows`; counts its reads. */
function poolWith(rows) {
  const db = { rows: [...rows], reads: 0, versions: 0 };
  return {
    db,
    async query(sql, params = []) {
      const text = String(sql);
      if (/SELECT COUNT\(\*\)::int AS n/.test(text)) {
        db.versions += 1;
        return { rows: [{ n: db.rows.length, at: db.rows.length ? new Date(1700000000000 + db.rows.length) : null }] };
      }
      if (/SELECT language, namespace, key, source, text FROM language_translations/.test(text)) { db.reads += 1; return { rows: [...db.rows] }; }
      if (/INSERT INTO language_translations/.test(text)) {
        params[0].forEach((language, i) => db.rows.push({ language, namespace: params[1][i], key: params[2][i], source: params[3][i], text: params[4][i] }));
        return { rows: [], rowCount: params[0].length };
      }
      return { rows: [] };
    },
  };
}
const row = (key, english, text) => ({ language: 'es', namespace: 'core', key, source: hash(english), text });
const ALL_SPANISH = [
  row('hello', 'Hello {{name}}', 'Hola {{name}}'), row('leave', 'Leave', 'Salir'), row('join', 'Join', 'Unirse'),
  row('items_one', '{{count}} item', '{{count}} elemento'), row('items_many', '{{count}} items', '{{count}} de elementos'),
  row('items_other', '{{count}} items', '{{count}} elementos'),
];
const packOf = (value, language = 'es') => JSON.parse(value.files.get(value.manifest[language].core.url.slice(cache.LIVE_PREFIX.length)));

test('the cache fills what the committed catalogs lack, for the English as it is now; a usable committed entry wins', async (t) => {
  cache.reset();
  const source = sourceFor(t, {
    translations: {
      es: {
        // Committed and current: wins over the cache.
        leave: from('Leave', 'Abandonar', { locked: true }),
        // Committed from English that has changed since: the cache's newer one is used.
        join: from('Join us', 'Únete a nosotros'),
      },
    },
  });
  const pool = poolWith([
    ...ALL_SPANISH,
    // A translation of English this build no longer has: never used.
    row('hello', 'Hello there {{name}}', 'Hola por ahí {{name}}'),
  ]);
  const value = await cache.live(pool, { source });
  assert.deepEqual(value.languages, { en: 'English', es: 'Español' });
  const pack = packOf(value);
  assert.equal(pack.leave, 'Abandonar', 'committed wins');
  assert.equal(pack.join, 'Unirse', 'a stale committed entry gives way to the cached translation of the current English');
  assert.equal(pack.hello, 'Hola {{name}}');
  assert.deepEqual([pack.items_one, pack.items_many, pack.items_other], ['{{count}} elemento', '{{count}} de elementos', '{{count}} elementos']);
  assert.deepEqual(value.coverage.es, { translated: 6, total: 6, ships: true });
  // Each pack is served under the SHA-256 of its bytes, which the shell checks.
  for (const [name, bytes] of value.files) {
    assert.match(name, /^es\.core\.[a-f0-9]{64}\.json$/);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), name.split('.')[2]);
  }
  assert.equal(value.manifest.es.core.url, `/locales/live/${[...value.files.keys()][0]}`);
});

test('a language is offered only once the two together cover minimumCoverage, and a count only with all its forms', async (t) => {
  cache.reset();
  const source = sourceFor(t);
  const partial = await cache.live(poolWith(ALL_SPANISH.filter((r) => r.key !== 'items_many')), { source });
  assert.deepEqual(partial.languages, { en: 'English' }, '3 of 6 is short of 95%');
  assert.equal(partial.manifest.es, undefined);
  assert.deepEqual(partial.coverage.es, { translated: 3, total: 6, ships: false });
  cache.reset();
  const low = sourceFor(t, { minimumCoverage: 0.5 });
  const shipped = await cache.live(poolWith(ALL_SPANISH.filter((r) => r.key !== 'items_many')), { source: low });
  assert.equal(shipped.languages.es, 'Español');
  assert.equal(packOf(shipped).items_one, undefined, 'half a plural set is left out whole');
});

test('the packs are worked out once per cache version; a new translation shows at once on this server', async (t) => {
  cache.reset();
  const source = sourceFor(t);
  const pool = poolWith(ALL_SPANISH.filter((r) => r.key !== 'join'));
  const first = await cache.live(pool, { source, now: 1000 });
  assert.equal(pool.db.reads, 1);
  assert.equal(await cache.live(pool, { source, now: 2000 }), first, 'within the TTL nothing is asked');
  assert.equal(pool.db.versions, 1);
  assert.equal(await cache.live(pool, { source, now: 1000 + cache.VERSION_TTL_MS + 1 }), first, 'the same version is not rebuilt');
  assert.equal(pool.db.reads, 1);
  assert.equal(await cache.saveTranslations(pool, { es: { core: { join: { text: 'Unirse', source: hash('Join') } } } }), 1);
  const after = await cache.live(pool, { source, now: 3000 });
  assert.equal(packOf(after).join, 'Unirse');
  assert.equal(await cache.saveTranslations(pool, { es: { core: { join: { text: 'x', source: 'not-a-hash' } } } }), 0, 'never an entry without its English');
});

test('no source, no languages: the build\'s own catalogs stand', async () => {
  cache.reset();
  assert.equal(await cache.live(poolWith([]), { source: null }), null);
  assert.equal(await cache.pack(poolWith([]), '../../etc/passwd'), null);
});

test('GET /api/languages and the packs it names, for anyone, before sign-in', async (t) => {
  cache.reset();
  const source = sourceFor(t);
  const pool = poolWith(ALL_SPANISH);
  const poolId = require.resolve('../src/db/pool');
  const saved = require.cache[poolId];
  require.cache[poolId] = { id: poolId, filename: poolId, loaded: true, exports: { getPool: () => pool } };
  const sourceStub = t.mock.method(cache, 'readSource', () => source);
  t.after(() => { if (saved) require.cache[poolId] = saved; else delete require.cache[poolId]; sourceStub.mock.restore(); });
  delete require.cache[require.resolve('../src/routes/languages')];
  const express = require('express');
  const app = express();
  app.use(require('../src/routes/languages').languageRoutes({}));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await fetch(`${base}/api/languages`);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(body.languages, { en: 'English', es: 'Español' });
  const packResponse = await fetch(`${base}${body.manifest.es.core.url}`);
  assert.equal(packResponse.status, 200);
  assert.match(packResponse.headers.get('cache-control'), /immutable/);
  const bytes = Buffer.from(await packResponse.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), body.manifest.es.core.hash);
  assert.equal((await fetch(`${base}/locales/live/es.core.${'0'.repeat(64)}.json`)).status, 404);
  const server_ = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server_.indexOf("languageRoutes(config)") < server_.indexOf('app.use(authMiddleware'), 'mounted before sign-in is required');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/routes/languages.js'), 'utf8'),
    new RegExp(`router\\.get\\('${cache.LIVE_PREFIX}:name'`), 'the pack route is the prefix the manifest names');
});
