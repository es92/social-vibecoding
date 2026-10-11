'use strict';

// The translation step (services/language-sync.js) and Homeroom's sweep that
// runs it (services/language-sync-runner.js) into the translation cache
// (services/language-cache.js), against a fake model and a fake pool.
// frontend/locales/README.md, "Translations", is the contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../src/services/language-sync');
const runner = require('../src/services/language-sync-runner');
const { buildLanguagePacks, hash, writeSource } = require('../scripts/language-packs');
const languageCache = require('../src/services/language-cache');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const says = (text, description = 'Fixture message.') => ({ text, description });
const from = (english, text, extra = {}) => ({ text, source: hash(english), ...extra });

const ENGLISH = {
  'greeting.hello': says('Hello {{name}}', 'Heading on the home screen. {{name}} is the reader\'s username.'),
  'button.leave': says('Leave', 'Button on a community\'s menu: the reader stops being a member.'),
  'terms.read': says('Read <0>the terms</0> of Homeroom.', 'Sentence on the sign-up screen; <0> is a link.'),
  'items_one': says('{{count}} item', 'Count of items in a list.'),
  'items_other': says('{{count}} items', 'Count of items in a list.'),
};

function checkout(t, { languages = { en: 'English', es: 'Español' }, english = ENGLISH, translations = {}, glossary = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  };
  put('config.json', { sourceLanguage: 'en', minimumCoverage: 0.95, languages });
  put('glossary.json', glossary || {
    doNotTranslate: ['Homeroom'],
    terms: { community: { meaning: 'What a person joins.', es: 'comunidad' } },
    style: { es: 'Address the reader as "tú".' },
  });
  put('en/core.json', english);
  for (const [language, catalog] of Object.entries(translations)) put(`${language}/core.json`, catalog);
  return { root, put, readLanguage: (language) => JSON.parse(fs.readFileSync(path.join(root, 'frontend/locales', language, 'core.json'), 'utf8')) };
}

/** A model that answers every message in its request with `answer(item)`. */
function fakeModel(answer) {
  const calls = [];
  const translate = async (requests) => {
    calls.push(requests);
    const answers = new Map();
    for (const request of requests) {
      const translations = request.items.map((item) => ({ id: item.id, ...answer(item, request, calls.length) }));
      answers.set(request.customId, { text: JSON.stringify({ translations }), usage: { input_tokens: 1000, output_tokens: 100 } });
    }
    return answers;
  };
  return { calls, translate };
}

const SPANISH = {
  'core:greeting.hello': { text: 'Hola {{name}}' },
  'core:button.leave': { text: 'Salir' },
  'core:terms.read': { text: 'Lee <0>los términos</0> de Homeroom.' },
  'core:items': { forms: { one: '{{count}} elemento', many: '{{count}} de elementos', other: '{{count}} elementos' } },
};

test('a language is asked for what it is missing, what is out of date, and every form of a count', (t) => {
  const { root } = checkout(t, {
    translations: {
      es: {
        'greeting.hello': from('Hello {{name}}', 'Hola {{name}}'),
        // Translated from English that has since changed.
        'button.leave': from('Exit', 'Salir'),
        'items_one': from('{{count}} item', '{{count}} elemento'),
        'items_other': from('{{count}} items', '{{count}} elementos'),
      },
    },
  });
  const items = sync.planLanguage(root, 'es');
  assert.deepEqual(items.map((item) => item.id).sort(), ['core:button.leave', 'core:items', 'core:terms.read']);
  const plural = items.find((item) => item.kind === 'plural');
  assert.deepEqual(Object.keys(plural.forms).sort(), ['many', 'one', 'other'], 'Spanish counts in three forms; the missing `many` asks for the set');
  assert.deepEqual(plural.english, { one: '{{count}} item', other: '{{count}} items' });
  assert.match(items.find((item) => item.id === 'core:button.leave').description, /stops being a member/, 'each message travels with its description');
  // A proposal's own messages only.
  assert.deepEqual(sync.planLanguage(root, 'es', { onlyIds: new Set(['core:terms.read']) }).map((item) => item.id), ['core:terms.read']);
});

test('a person\'s correction is left alone until the English it corrects changes', (t) => {
  const { root } = checkout(t, {
    translations: {
      es: {
        'greeting.hello': from('Hello {{name}}', '¡Hola, {{name}}!', { locked: true }),
        'button.leave': from('Exit', 'Salir', { locked: true }),
      },
    },
  });
  const ids = sync.planLanguage(root, 'es').map((item) => item.id);
  assert.ok(!ids.includes('core:greeting.hello'), 'locked and current: kept');
  assert.ok(ids.includes('core:button.leave'), 'locked but stale: the English moved on');
});

test('a sync writes what passes the checks, with the digest of its English, and the build then ships the language', async (t) => {
  const { root, readLanguage } = checkout(t);
  const model = fakeModel((item) => SPANISH[item.id]);
  const summary = await sync.syncTranslations({ root, translate: model.translate });
  assert.deepEqual(summary.languages.es, { requested: 4, written: 4, failed: [] });
  assert.deepEqual(summary.files, [path.join('frontend', 'locales', 'es', 'core.json')]);
  const written = readLanguage('es');
  assert.deepEqual(written['greeting.hello'], { text: 'Hola {{name}}', source: hash('Hello {{name}}') });
  assert.deepEqual(written.items_many, { text: '{{count}} de elementos', source: hash('{{count}} items') }, 'a form English lacks is translated from its `other`');
  assert.deepEqual(Object.keys(written).slice(0, 3), ['greeting.hello', 'button.leave', 'terms.read'], 'in the English order');
  assert.deepEqual(Object.keys(written).slice(3).sort(), ['items_many', 'items_one', 'items_other'], 'then each count, every form');
  const { report, languages } = buildLanguagePacks(root);
  assert.equal(report.es.translated, report.es.total);
  assert.deepEqual(languages, { en: 'English', es: 'Español' }, 'covered, so offered');
  // Nothing left to do: a second pass sends nothing.
  const again = fakeModel(() => assert.fail('nothing should be asked'));
  assert.equal((await sync.syncTranslations({ root, translate: again.translate })).files.length, 0);
});

test('an answer that fails a check is asked again on its own once, and stays English if it fails twice', async (t) => {
  const { root, readLanguage } = checkout(t);
  const model = fakeModel((item, request, call) => {
    if (item.id === 'core:greeting.hello') return call === 1 ? { text: 'Hola {{nombre}}' } : SPANISH[item.id];
    if (item.id === 'core:button.leave') return { text: 'Salir — ahora' };
    return SPANISH[item.id];
  });
  const summary = await sync.syncTranslations({ root, translate: model.translate });
  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls[1].map((request) => request.items.map((item) => item.id)), [['core:greeting.hello'], ['core:button.leave']], 'one message per retry');
  assert.equal(summary.languages.es.written, 3);
  assert.deepEqual(summary.languages.es.failed, [{ id: 'core:button.leave', problem: 'an em dash' }]);
  assert.equal(readLanguage('es')['button.leave'], undefined, 'left out, so it shows in English');
  assert.equal(readLanguage('es')['greeting.hello'].text, 'Hola {{name}}');
});

test('a round that failed wholesale is not retried one message at a time', async (t) => {
  const { root } = checkout(t);
  const model = fakeModel(() => ({ text: '' }));
  const summary = await sync.syncTranslations({ root, translate: model.translate, maxRetries: 2 });
  assert.equal(model.calls.length, 1, 'no second round');
  assert.equal(summary.languages.es.written, 0);
  assert.equal(summary.languages.es.failed.length, 4);
  assert.deepEqual(summary.languages.es.failed.map((f) => f.problem), [
    'empty; not retried', 'empty; not retried', 'empty; not retried', 'no plural forms; not retried',
  ], 'the reason that sent each one back is kept');
});

test('the answer schema is one structured outputs accept: every object is closed (#4641)', () => {
  // An open map (`additionalProperties: { type: 'string' }`) is refused by
  // the API, which failed every request the step ever sent.
  const objects = [];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') objects.push(where);
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${where} is closed`);
    for (const [key, child] of Object.entries(node.properties || {})) walk(child, `${where}.${key}`);
    if (node.items) walk(node.items, `${where}[]`);
  };
  walk(sync.RESPONSE_SCHEMA, 'answer');
  assert.deepEqual(objects, ['answer', 'answer.translations[]', 'answer.translations[].forms']);
  const forms = sync.RESPONSE_SCHEMA.properties.translations.items.properties.forms;
  assert.deepEqual(Object.keys(forms.properties), ['zero', 'one', 'two', 'few', 'many', 'other']);
  assert.equal(forms.required, undefined, 'each form is optional: a language uses only some');
  // Every category a configured language counts in has a slot.
  const configured = Object.keys(JSON.parse(read('frontend/locales/config.json')).languages);
  for (const language of configured) {
    for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
      assert.ok(sync.PLURAL_CATEGORIES.includes(category), `${language} ${category}`);
    }
  }
});

test('what the checks refuse', () => {
  const ok = (english, text, options) => assert.equal(sync.textProblem(english, text, options), null, text);
  const refuses = (english, text, pattern, options) => assert.match(String(sync.textProblem(english, text, options)), pattern, text);
  ok('Hello {{name}}', 'Hola {{name}}');
  refuses('Hello {{name}}', 'Hola {{nombre}}', /parameters or tags/);
  refuses('Hello {{name}}', ' Hola {{name}}', /space at an edge/);
  refuses('Read <0>this</0>', 'Lee <b>esto</b>', /parameters or tags/);
  refuses('One\nTwo', 'Uno Dos', /line breaks/);
  refuses('Saved', 'Guardado — listo', /em dash/);
  refuses('Join Homeroom', 'Únete a Hogar', /"Homeroom" is not written as it is/, { doNotTranslate: ['Homeroom'] });
  refuses('Hi', 'x'.repeat(60), /far longer/);
  refuses('Hi', '', /empty/);
  ok('{{count}} hours ago', 'il y a une heure', { counted: true });
});

test('a request carries the language, its style, its terms and the names to keep, and caches its system prompt', (t) => {
  const { root } = checkout(t, { languages: { en: 'English', 'pt-BR': 'Português (Brasil)' } });
  const glossary = sync.readGlossary(root);
  const items = sync.planLanguage(root, 'pt-BR');
  const requests = sync.buildRequests('pt-BR', 'Português (Brasil)', items, glossary, { chunkSize: 2 });
  assert.equal(requests.length, 2, 'four messages, two a request');
  const [first] = requests;
  assert.equal(first.params.model, sync.MODEL);
  assert.equal(sync.MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(first.params.system[0].cache_control, { type: 'ephemeral' });
  assert.match(first.params.system[0].text, /into Brazilian Portuguese \(pt-BR/);
  assert.match(first.params.system[0].text, /Never translate these names; write them exactly as they are: Homeroom\./);
  assert.equal(first.params.output_config.format.type, 'json_schema');
  const sent = JSON.parse(first.params.messages[0].content);
  assert.deepEqual(Object.keys(sent.messages[0]).sort(), ['description', 'english', 'id']);
  // The shipped glossary names each of Homeroom's terms in every configured language.
  const shipped = JSON.parse(read('frontend/locales/glossary.json'));
  const configured = Object.keys(JSON.parse(read('frontend/locales/config.json')).languages).filter((tag) => tag !== 'en');
  for (const [term, entry] of Object.entries(shipped.terms)) {
    for (const language of configured) assert.equal(typeof entry[language], 'string', `${term} in ${language}`);
  }
  for (const language of configured) assert.equal(typeof shipped.style[language], 'string', `a style note for ${language}`);
});

test('a change\'s own messages are the ones whose English it added or reworded', () => {
  const before = { core: { a: says('A'), b: says('B'), n_one: says('{{count}} n'), n_other: says('{{count}} ns') } };
  const after = { core: { a: says('A'), b: says('B, reworded'), c: says('C'), n_one: says('{{count}} n'), n_other: says('{{count}} things') } };
  const ids = sync.changedEnglishIds(before, after);
  assert.ok(ids.has('core:b') && ids.has('core:c') && ids.has('core:n'));
  assert.ok(!ids.has('core:a'));
});

test('no build calls a model: the builder and the shell build never load the translation step', () => {
  for (const file of ['scripts/language-packs.js', 'frontend/scripts/build-shell.mjs', 'scripts/ensure-shell-artifacts.js']) {
    assert.doesNotMatch(read(file), /language-sync|services\/llm/, file);
  }
});

// ── The sweep ──────────────────────────────────────────────────────────

/**
 * Homeroom's sweep over a running build: its catalogs as the build wrote them
 * (scripts/language-packs.js writeSource), the translation cache in a fake
 * pool, and a fake model. `deploy(english)` is a new build with new English.
 */
function platform(t, { translations = {}, english = ENGLISH, state = null } = {}) {
  const repo = checkout(t, { translations, english });
  const db = { state, cache: [], spend: 0 };
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/SELECT value FROM platform_settings WHERE key = \$1/.test(text) && params[0] === runner.STATE_KEY) {
        return { rows: db.state ? [{ value: JSON.stringify(db.state) }] : [] };
      }
      if (/INSERT INTO platform_settings/.test(text)) { db.state = JSON.parse(params[1]); return { rows: [] }; }
      if (/SELECT COUNT\(\*\)::int AS n, MAX\(created_at\) AS at FROM language_translations/.test(text)) {
        return { rows: [{ n: db.cache.length, at: db.cache.length ? new Date(1700000000000 + db.cache.length) : null }] };
      }
      if (/SELECT language, namespace, key, source, text FROM language_translations/.test(text)) return { rows: [...db.cache] };
      if (/INSERT INTO language_translations/.test(text)) {
        let added = 0;
        params[0].forEach((language, i) => {
          const row = { language, namespace: params[1][i], key: params[2][i], source: params[3][i], text: params[4][i] };
          if (db.cache.some((r) => r.language === row.language && r.namespace === row.namespace && r.key === row.key && r.source === row.source)) return;
          db.cache.push(row);
          added += 1;
        });
        return { rows: [], rowCount: added };
      }
      if (/INSERT INTO system_token_usage/.test(text)) { db.spend += Number(params[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const sourceOf = () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'language-source-'));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    return JSON.parse(fs.readFileSync(writeSource(repo.root, out), 'utf8'));
  };
  const model = fakeModel((item) => SPANISH[item.id]);
  const batches = [];
  const llm = {
    isEnabled: () => true,
    translateCatalogDirect: model.translate,
    async submitCatalogBatch(requests) { batches.push({ requests, status: 'in_progress' }); return { id: `batch_${batches.length}` }; },
    async catalogBatchStatus(id) { return { status: batches[Number(id.split('_')[1]) - 1].status }; },
    async catalogBatchAnswers(id) { return model.translate(batches[Number(id.split('_')[1]) - 1].requests); },
  };
  const deps = { llm, source: sourceOf() };
  languageCache.reset();
  return {
    repo, db, pool, deps, batches, model,
    deploy: (next) => { repo.put('en/core.json', next); deps.source = sourceOf(); languageCache.reset(); },
    cached: (key) => db.cache.filter((row) => row.key === key),
    run: () => runner.runOnce({ config: {}, pool, deps }),
  };
}

test('the sweep translates what the running build is missing into the cache, and proposes nothing', async (t) => {
  const p = platform(t);
  const result = await p.run();
  // Three messages and Spanish's three forms of the count.
  assert.equal(result.cached, 6);
  assert.deepEqual(p.cached('button.leave').map((row) => [row.language, row.text, row.source]), [['es', 'Salir', hash('Leave')]]);
  assert.deepEqual(p.cached('items_many').map((row) => row.text), ['{{count}} de elementos']);
  assert.ok(p.db.spend > 0, 'the spend counts against the system budget');
  assert.equal(p.db.state.proposal, undefined, 'no proposal');
  assert.doesNotMatch(read('src/services/language-sync-runner.js'), /createPR|pushFiles|INSERT INTO chat_sessions/, 'nothing that opens one');
  // And the shell is offered Spanish from the cache at once.
  const live = await languageCache.live(p.pool, { source: p.deps.source });
  assert.deepEqual(live.languages, { en: 'English', es: 'Español' });
  assert.equal(JSON.parse(live.files.get(live.manifest.es.core.url.split('/').pop()))['button.leave'], 'Salir');
});

test('a deploy that does not change the English translates nothing again; new English is translated alone', async (t) => {
  const p = platform(t);
  await p.run();
  assert.deepEqual(await p.run(), { skipped: 'unchanged' });
  // Another instance, or the state lost: the cache already has it all.
  p.db.state = null;
  assert.deepEqual(await p.run(), { skipped: 'nothing_missing' });
  SPANISH['core:button.join'] = { text: 'Unirse' };
  t.after(() => { delete SPANISH['core:button.join']; });
  p.deploy({ ...ENGLISH, 'button.join': says('Join', 'Button: become a member.') });
  const calls = p.model.calls.length;
  const again = await p.run();
  assert.equal(again.cached, 1);
  assert.deepEqual(p.model.calls.slice(calls).flat().flatMap((request) => request.items.map((item) => item.id)), ['core:button.join'],
    'only the new message is asked for');
  // A reworded message is translated again, under its new English.
  SPANISH['core:button.leave'] = { text: 'Abandonar' };
  t.after(() => { SPANISH['core:button.leave'] = { text: 'Salir' }; });
  p.deploy({ ...ENGLISH, 'button.join': says('Join', 'Button: become a member.'), 'button.leave': says('Leave the community', 'Button on a community\'s menu.') });
  await p.run();
  assert.deepEqual(p.cached('button.leave').map((row) => [row.text, row.source]), [['Salir', hash('Leave')], ['Abandonar', hash('Leave the community')]]);
});

test('a committed translation wins over the cache, and the step does not translate it again', async (t) => {
  const p = platform(t, { translations: { es: { 'button.leave': from('Leave', 'Abandonar', { locked: true }) } } });
  await p.run();
  assert.deepEqual(p.cached('button.leave'), [], 'already committed');
  const live = await languageCache.live(p.pool, { source: p.deps.source });
  assert.equal(JSON.parse(live.files.get(live.manifest.es.core.url.split('/').pop()))['button.leave'], 'Abandonar');
});

test('a whole language goes as a Message Batch; its answers are kept once it ends, and only for English it was asked about', async (t) => {
  const english = { ...ENGLISH };
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) english[`bulk.m${i}`] = says(`Message ${i}`, 'Bulk fixture message.');
  const p = platform(t, { english });
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) SPANISH[`core:bulk.m${i}`] = { text: `Mensaje ${i}` };
  t.after(() => { for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) delete SPANISH[`core:bulk.m${i}`]; });
  const submitted = await p.run();
  assert.equal(submitted.submitted, 'batch_1');
  assert.equal(p.db.state.batch.english['core:bulk.m3'], runner.englishOf({ english: 'Message 3' }));
  assert.deepEqual(await p.run(), { waiting: 'batch_1' });
  p.batches[0].status = 'ended';
  // A deploy while it ran: one message reworded, one added before the rest,
  // so every request after it carries other messages than it did.
  p.deploy({ 'a.first': says('First', 'Added at the top.'), ...english, 'bulk.m3': says('Message three', 'Bulk fixture message.') });
  SPANISH['core:a.first'] = { text: 'Primero' };
  t.after(() => { delete SPANISH['core:a.first']; });
  const calls = p.model.calls.length;
  const kept = await p.run();
  assert.ok(kept.cached > runner.DIRECT_LIMIT, 'the batch\'s answers are kept, matched by message');
  assert.equal(p.db.state.batch, undefined);
  const askedAgain = p.model.calls.slice(calls + 1).flat().flatMap((request) => request.items.map((item) => item.id)).sort();
  assert.deepEqual(askedAgain, ['core:a.first', 'core:bulk.m3'], 'what the batch was not asked about is asked on its own');
  assert.deepEqual(p.cached('bulk.m3').map((row) => row.source), [hash('Message three')], 'never under English it was not asked about');
  // The batch was asked from the English before the deploy, so the next pass
  // reads the new English again rather than calling it unchanged; the cache
  // already has all of it.
  assert.notEqual(p.db.state.checkedDigest, runner.sourceDigest(p.deps.source));
  assert.deepEqual(await p.run(), { skipped: 'nothing_missing' });
});

test('a pass that could use nothing says why, in the state an admin reads, and caches nothing (#4641)', async (t) => {
  const p = platform(t);
  const refused = '400 output_config.format.schema: additionalProperties must be false';
  p.deps.llm.translateCatalogDirect = async (requests) => new Map(requests.map((request) => [request.customId, { error: refused }]));
  const result = await p.run();
  assert.equal(result.nothingUsable, true);
  assert.equal(p.db.cache.length, 0);
  assert.equal(p.db.state.checkedDigest, runner.sourceDigest(p.deps.source));
  const { lastPass } = p.db.state;
  assert.equal(lastPass.requested, 4);
  assert.equal(lastPass.written, 0);
  assert.equal(lastPass.failed, 4);
  assert.equal(lastPass.problems[0].count, 4);
  assert.match(lastPass.problems[0].problem, /additionalProperties must be false/, 'the API\'s own words, not "no answer"');
  const status = await runner.status(p.pool, { deps: { cache: { live: async () => null } } });
  assert.deepEqual(status.lastPass, lastPass);
});

test('a pass that wrote translations records what it used too', async (t) => {
  const p = platform(t);
  await p.run();
  assert.deepEqual(
    { requested: p.db.state.lastPass.requested, written: p.db.state.lastPass.written, failed: p.db.state.lastPass.failed },
    { requested: 4, written: 4, failed: 0 },
  );
  assert.deepEqual(p.db.state.lastPass.problems, []);
});

test('a build without its catalogs\' source translates nothing', async () => {
  const result = await runner.runOnce({
    config: {}, pool: { query: async () => ({ rows: [] }) }, deps: { llm: { isEnabled: () => true }, source: null },
  });
  assert.deepEqual(result, { skipped: 'no_source' });
});

test('the sweep is idle without a key, off with LANGUAGE_SYNC_ENABLED=false, and runs only on the leader', () => {
  const before = process.env.LANGUAGE_SYNC_ENABLED;
  try {
    process.env.LANGUAGE_SYNC_ENABLED = 'false';
    assert.equal(runner.isEnabled(), false);
    delete process.env.LANGUAGE_SYNC_ENABLED;
    assert.equal(runner.isEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.LANGUAGE_SYNC_ENABLED; else process.env.LANGUAGE_SYNC_ENABLED = before;
  }
  const server = read('server.js');
  const leader = server.indexOf("require('./src/services/fixed-check-sync').start(config, getPool(config));");
  assert.ok(server.indexOf("require('./src/services/language-sync-runner').start(config, getPool(config));") > leader);
  assert.match(server, /const languageSyncStop = require\('\.\/src\/services\/language-sync-runner'\)\.stop\(\);/);
  assert.match(server, /Promise\.all\(\[[^\]]*languageSyncStop[^\]]*\]\)/);
});

test('no key, no pass', async () => {
  const result = await runner.runOnce({ config: {}, pool: { query: async () => ({ rows: [] }) }, deps: { llm: { isEnabled: () => false } } });
  assert.deepEqual(result, { skipped: 'no_key' });
});
