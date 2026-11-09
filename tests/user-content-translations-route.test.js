// #6081: POST /api/translations.
//
// The endpoint's own rules, on a real Express stack: only a signed-in person
// may ask, a request carries one or two texts of 1 to 8000 characters, the
// target language falls back from what the page asked to the account's, the
// browser's and English, and a bound answers 429 (or 503) only when nothing
// could be served. A cached answer beside a blocked one still arrives as 200.
//
// The service's rules are tests/user-content-translations.test.js and its SQL
// is tests/user-content-translations-postgres.test.js; this stubs only the
// call the route makes.
//
// Run with: node --test tests/user-content-translations-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const { userContentTranslationRoutes } = require('../src/routes/user-content-translations');

const source = {
  files: {
    'config.json': { languages: { en: 'English', fr: 'Français', 'zh-CN': '简体中文', es: 'Español' } },
    'glossary.json': { doNotTranslate: [], terms: {}, style: {} },
  },
};

test('the translation endpoint', { timeout: 30000 }, async (t) => {
  let last = null;
  let outcome = null;
  const translate = async (_pool, args) => {
    last = args;
    return outcome || { results: args.texts.map(() => ({ state: 'translated', text: 'EN', from: 'es' })) };
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.get('x-signed-out')) req.user = { id: 7, locale: req.get('x-locale') || null };
    next();
  });
  app.use(userContentTranslationRoutes({}, { pool: {}, translate, source }));
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/translations`;
  const ask = (body, headers = {}) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  let res = await ask({ texts: ['Hello'] }, { 'x-signed-out': '1' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'sign_in_required' });

  res = await ask({ texts: [] });
  assert.equal(res.status, 400);
  res = await ask({ texts: ['a', 'b', 'c'] });
  assert.equal(res.status, 400);
  res = await ask({ texts: ['x'.repeat(8001)] });
  assert.equal(res.status, 400);
  res = await ask({ texts: ['   '] });
  assert.equal(res.status, 400);

  // The asked language first, then the account's, then the browser's, then English.
  res = await ask({ texts: ['x'], language: 'fr' }, { 'x-locale': 'es', 'accept-language': 'zh-CN' });
  assert.equal(res.status, 200);
  assert.equal(last.language, 'fr');
  await ask({ texts: ['x'], language: 'not a tag' }, { 'x-locale': 'es', 'accept-language': 'zh-CN' });
  assert.equal(last.language, 'es');
  await ask({ texts: ['x'] }, { 'accept-language': 'de, zh-CN;q=0.8' });
  assert.equal(last.language, 'zh-CN');
  await ask({ texts: ['x'] }, { 'accept-language': 'de' });
  assert.equal(last.language, 'en');

  outcome = { results: [{ state: 'failed' }], blocked: 'budget' };
  res = await ask({ texts: ['x'] });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'budget' });

  outcome = { results: [{ state: 'failed' }], blocked: 'translation_limit' };
  res = await ask({ texts: ['x'] });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'translation_limit' });

  outcome = { results: [{ state: 'failed' }], blocked: 'translation_unavailable' };
  res = await ask({ texts: ['x'] });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'translation_unavailable' });

  // #6525: the same bound on an automatic ask answers 200 with a failed
  // result per text. A chat translating itself as it is read must not put a
  // failed request in the browser's console, which is a console error to the
  // checks and reads as a broken page.
  outcome = { results: [{ state: 'failed' }], blocked: 'translation_unavailable' };
  res = await ask({ texts: ['x'], auto: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { language: 'en', results: [{ state: 'failed' }] });

  outcome = { results: [{ state: 'failed' }], blocked: 'translation_limit' };
  res = await ask({ texts: ['x'], auto: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { language: 'en', results: [{ state: 'failed' }] });

  // A cached text still arrives beside one the bound could not serve.
  outcome = {
    results: [{ state: 'translated', text: 'Bonjour', from: 'en' }, { state: 'failed' }],
    blocked: 'budget',
  };
  res = await ask({ texts: ['Hello', 'Fresh'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.language, 'en');
  assert.deepEqual(body.results, [{ state: 'translated', text: 'Bonjour', from: 'en' }, { state: 'failed' }]);
});
