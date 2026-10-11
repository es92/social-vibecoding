'use strict';

// The translation cache: Homeroom's own interface text in the languages it
// ships, translated in the background and served at runtime, with no
// proposal per translation (frontend/locales/README.md, "Translations").
//
// Three layers, the first that has a message winning:
//   1. A committed catalog entry (frontend/locales/<language>/*.json) that is
//      still usable for the running English: what an earlier translation
//      proposal merged, or a person's correction marked "locked".
//   2. The cache (language_translations): what the translation step
//      (services/language-sync-runner.js) has translated since, kept by the
//      English it was translated from. A message is translated once per
//      wording; a deploy that does not change it reads it from here.
//   3. English, bundled into the shell, for anything neither has.
//
// The running build's English and committed catalogs are read from
// public/locales/.source.json (scripts/language-packs.js writeSource): the
// runtime image carries no frontend/. The packs and the languages offered are
// worked out by the build's own rules (collectCatalogs: parameters, tags,
// whole plural sets, minimumCoverage), once per cache version, and kept in
// memory. GET /api/languages names them; GET /locales/live/<pack> serves each
// pack under its content hash, so a browser keeps it until it changes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('./logger');
const packs = require('../../scripts/language-packs');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'public', 'locales', packs.SOURCE_FILE);
const LIVE_PREFIX = '/locales/live/';
// How long a process trusts its packs before asking whether the cache moved:
// another instance's translation pass is picked up within this.
const VERSION_TTL_MS = 60 * 1000;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

let sourceMemo = null;
/** The running build's catalogs (public/locales/.source.json), or null when it has none. */
function readSource(file = SOURCE_PATH) {
  try {
    const { mtimeMs } = fs.statSync(file);
    if (sourceMemo && sourceMemo.file === file && sourceMemo.mtimeMs === mtimeMs) return sourceMemo.source;
    const source = JSON.parse(fs.readFileSync(file, 'utf8'));
    sourceMemo = { file, mtimeMs, source };
    return source;
  } catch {
    return null;
  }
}

/** Changes whenever a translation is added. */
async function cacheVersion(pool) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n, MAX(created_at) AS at FROM language_translations',
  );
  return `${rows[0]?.n || 0}:${rows[0]?.at ? new Date(rows[0].at).getTime() : 0}`;
}

/** Every cached translation: language -> namespace -> key -> source -> text. */
async function cachedEntries(pool) {
  const { rows } = await pool.query(
    'SELECT language, namespace, key, source, text FROM language_translations ORDER BY created_at, key',
  );
  const out = {};
  for (const row of rows) {
    const byKey = ((out[row.language] ||= {})[row.namespace] ||= {});
    (byKey[row.key] ||= {})[row.source] = row.text;
  }
  return out;
}

/** English messages by namespace, from a materialized root. */
function englishTexts(directory) {
  const out = {};
  for (const file of fs.readdirSync(path.join(directory, 'en')).filter((name) => name.endsWith('.json'))) {
    const entries = JSON.parse(fs.readFileSync(path.join(directory, 'en', file), 'utf8'));
    out[file.slice(0, -5)] = Object.fromEntries(Object.entries(isObject(entries) ? entries : {})
      .filter(([, entry]) => isObject(entry) && typeof entry.text === 'string')
      .map(([key, entry]) => [key, entry.text]));
  }
  return out;
}

/**
 * Lays the cache over the committed catalogs in `root`: a message whose
 * committed entry cannot be used for the English as it is now (missing, out
 * of date or malformed) takes the cached translation of exactly that English,
 * when there is one. A usable committed entry is never replaced.
 */
function overlay(root, cached) {
  const directory = path.join(root, 'frontend/locales');
  const config = packs.readConfig(directory);
  const english = englishTexts(directory);
  for (const language of Object.keys(config.languages)) {
    if (language === 'en' || !cached?.[language]) continue;
    for (const [namespace, texts] of Object.entries(english)) {
      const fromCache = cached[language][namespace];
      if (!fromCache) continue;
      const file = path.join(directory, language, `${namespace}.json`);
      let committed = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (isObject(parsed)) committed = parsed;
      } catch { /* none yet */ }
      const { required, groups } = packs.requiredMessages(texts, language);
      const counted = new Set([...groups.values()].flat());
      let changed = false;
      for (const [key, text] of Object.entries(required)) {
        if (!packs.translationProblem(committed[key], text, counted.has(key))) continue;
        const source = packs.hash(text);
        const hit = fromCache[key]?.[source];
        if (typeof hit !== 'string') continue;
        committed[key] = { text: hit, source };
        changed = true;
      }
      if (!changed) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(committed, null, 2)}\n`);
    }
  }
}

/**
 * The running build's catalogs with the cache laid over them, written to a
 * fresh temporary directory (root/frontend/locales), for collectCatalogs and
 * the translation step. The caller removes it. Null without a source.
 */
async function liveRoot(pool, { source = module.exports.readSource(), cached = null } = {}) {
  if (!source) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-cache-'));
  try {
    packs.materializeSource(source, root);
    overlay(root, cached || await cachedEntries(pool));
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** The languages offered and their packs, from a root liveRoot wrote. Pure apart from reading it. */
function packsFrom(root) {
  const { config, namespaces, catalogs, report } = packs.collectCatalogs(root);
  const languages = packs.shippedLanguages(config, report);
  const manifest = {};
  const files = new Map();
  for (const [language, byNamespace] of Object.entries(catalogs)) {
    if (!(language in languages)) continue;
    manifest[language] = {};
    for (const [namespace, messages] of Object.entries(byNamespace)) {
      const bytes = Buffer.from(JSON.stringify(messages));
      const digest = packs.hash(bytes);
      const name = `${language}.${namespace}.${digest}.json`;
      files.set(name, bytes);
      manifest[language][namespace] = { url: `${LIVE_PREFIX}${name}`, hash: digest };
    }
  }
  const coverage = Object.fromEntries(Object.entries(report).map(([language, tally]) => [
    language, { translated: tally.translated, total: tally.total, ships: !!tally.ships },
  ]));
  return { languages, namespaces, manifest, files, coverage };
}

let memo = null;
let building = null;

/**
 * What the running build offers now: { languages, namespaces, manifest,
 * files, coverage }. Rebuilt when the cache or the build's catalogs change,
 * asked at most once a VERSION_TTL_MS. Null when this build has no source.
 */
async function live(pool, { now = Date.now(), source = module.exports.readSource() } = {}) {
  if (!source) return null;
  if (memo && memo.source === source && now - memo.checkedAt < VERSION_TTL_MS) return memo.value;
  if (building) return building;
  building = (async () => {
    const version = await cacheVersion(pool);
    if (memo && memo.source === source && memo.version === version) {
      memo.checkedAt = now;
      return memo.value;
    }
    const root = await liveRoot(pool, { source });
    try {
      const value = packsFrom(root);
      memo = { source, version, checkedAt: now, value };
      return value;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

/** One live pack's bytes by its file name, or null. */
async function pack(pool, name) {
  if (typeof name !== 'string' || !packs.PACK_NAME.test(name)) return null;
  const value = await live(pool);
  return value?.files.get(name) || null;
}

/**
 * Keeps what the translation step accepted: `entries` is language ->
 * namespace -> key -> { text, source }. A translation already cached for the
 * same English is left as it is. Resolves how many were added.
 */
async function saveTranslations(pool, entries, { model = null } = {}) {
  const rows = [];
  for (const [language, byNamespace] of Object.entries(entries || {})) {
    for (const [namespace, byKey] of Object.entries(byNamespace || {})) {
      for (const [key, entry] of Object.entries(byKey || {})) {
        if (!isObject(entry) || typeof entry.text !== 'string' || !/^[a-f0-9]{64}$/.test(String(entry.source))) continue;
        rows.push([language, namespace, key, entry.source, entry.text]);
      }
    }
  }
  if (!rows.length) return 0;
  let added = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { rowCount } = await pool.query(
      `INSERT INTO language_translations (language, namespace, key, source, text, model)
       SELECT l, n, k, s, t, $6 FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS u(l, n, k, s, t)
       ON CONFLICT (language, namespace, key, source) DO NOTHING`,
      [chunk.map((r) => r[0]), chunk.map((r) => r[1]), chunk.map((r) => r[2]), chunk.map((r) => r[3]), chunk.map((r) => r[4]), model],
    );
    added += rowCount || 0;
  }
  // This process serves the new packs at once; the others within VERSION_TTL_MS.
  memo = null;
  log.info('language-cache', 'Translations cached', { offered: rows.length, added });
  return added;
}

/** Forgets the packs this process worked out (tests, and a new build's source). */
function reset() {
  memo = null;
  sourceMemo = null;
}

module.exports = {
  LIVE_PREFIX,
  SOURCE_PATH,
  VERSION_TTL_MS,
  cacheVersion,
  cachedEntries,
  live,
  liveRoot,
  overlay,
  pack,
  packsFrom,
  readSource,
  reset,
  saveTranslations,
};
