#!/usr/bin/env node
'use strict';

// Builds the platform's language catalogs (frontend/locales/README.md).
//
// Two kinds of input, held to two different standards:
//
//   English source   frontend/locales/en/<namespace>.json. Authored by the
//                    person changing the UI, so a mistake in it is a bug in
//                    their change: it FAILS the build and the tests.
//   Translations     frontend/locales/<language>/<namespace>.json. Written by
//                    the translation step, never by the contributor. A
//                    missing, out-of-date or malformed entry is LEFT OUT of
//                    that language's pack and counted in the coverage report;
//                    the runtime shows English for that one message. A
//                    translation never fails a build.
//
// A language listed in config.json SHIPS (is offered in Settings, matched to a
// device and given packs) only once its translations cover at least
// `minimumCoverage` of the English messages. Until the translation step has
// filled it, a configured language is built into nothing and Homeroom stays
// in English for its readers; afterwards a message the step has not reached
// yet still falls back to English on its own.
//
// Output (all ignored by git and Docker, rebuilt by every shell build):
//
//   frontend/src/lib/i18n/catalogs.generated.json   bundled English + manifest
//   public/locales/<language>.<namespace>.<sha256>.json   one pack per pair
//   public/locales/.source.json   every catalog file as built, for the server:
//                    the translation cache (src/services/language-cache.js)
//                    reads the running build's English and committed
//                    translations from it, since the runtime image carries
//                    no frontend/. A dotfile, so it is never served.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PACK_NAME = /^[a-zA-Z-]+\.[a-z-]+\.[a-f0-9]{64}\.json$/;
const SOURCE_FILE = '.source.json';
// The catalog files the source carries: config, glossary, and every
// language's namespaces (English included).
const SOURCE_PATH = /^(?:config\.json|glossary\.json|[a-zA-Z-]+\/[a-z][a-z-]*\.json)$/;
const NAMESPACE = /^[a-z][a-z-]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PARAMETER = /^[a-z][A-Za-z0-9]*$/;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const parameters = (text) => [...text.matchAll(/{{\s*([^}]*?)\s*}}/g)].map((match) => match[1]).sort();

/** The numbered tags RichMessage renders. Any other markup is refused. */
function componentTags(text) {
  const stack = [];
  const tags = [];
  for (const match of text.matchAll(/<[^>]*>/g)) {
    const token = match[0];
    if (!/^<\/?\d+>$/.test(token)) throw new Error('only numbered tags such as <0>…</0> are allowed');
    if (token.startsWith('</')) {
      if (stack.pop() !== token.slice(2, -1)) throw new Error('tags are not balanced');
    } else {
      stack.push(token.slice(1, -1));
      tags.push(token.slice(1, -1));
    }
  }
  if (stack.length) throw new Error('a tag is not closed');
  return tags.sort();
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Why an English entry cannot ship, or null. */
function sourceProblem(key, entry) {
  if (!KEY.test(key)) return 'the key may use letters, digits, ".", "_" and "-" only';
  if (!isObject(entry)) return 'an entry is { "text": "…", "description": "…" }';
  const extra = Object.keys(entry).find((field) => !['text', 'description'].includes(field));
  if (extra) return `unknown field "${extra}"`;
  const { text, description } = entry;
  if (typeof text !== 'string' || !text) return 'text is missing';
  if (text !== text.trim()) {
    return 'text starts or ends with a space; write the whole message instead of a fragment';
  }
  if (typeof description !== 'string' || !description.trim()) {
    return 'description is missing; say in one line where the message appears';
  }
  for (const name of parameters(text)) {
    if (!PARAMETER.test(name)) return `parameter {{${name}}} must be a plain name such as {{email}}`;
    if (/^value\d*$/.test(name)) return `parameter {{${name}}} must say what it holds, such as {{email}}`;
  }
  try { componentTags(text); } catch (err) { return err.message; }
  return null;
}

function readSource(directory) {
  const errors = [];
  const english = {};
  let files = [];
  try {
    files = fs.readdirSync(path.join(directory, 'en')).filter((name) => name.endsWith('.json')).sort();
  } catch {
    errors.push('en: the English source directory is missing');
  }
  for (const file of files) {
    const namespace = file.slice(0, -5);
    if (!NAMESPACE.test(namespace)) { errors.push(`en/${file}: a namespace is lower-case letters and "-"`); continue; }
    let source;
    try { source = JSON.parse(fs.readFileSync(path.join(directory, 'en', file), 'utf8')); } catch (err) {
      errors.push(`en/${file}: ${err.message}`); continue;
    }
    if (!isObject(source)) { errors.push(`en/${file}: the catalog is an object of entries`); continue; }
    const messages = {};
    for (const [key, entry] of Object.entries(source)) {
      const problem = sourceProblem(key, entry);
      if (problem) errors.push(`en/${namespace}:${key}: ${problem}`);
      else messages[key] = entry.text;
    }
    // English has two plural forms; a count needs both.
    for (const key of Object.keys(messages)) {
      const pair = key.endsWith('_one') ? `${key.slice(0, -4)}_other`
        : key.endsWith('_other') ? `${key.slice(0, -6)}_one` : null;
      if (pair && !(pair in source)) errors.push(`en/${namespace}:${key}: a plural needs ${pair} too`);
    }
    english[namespace] = messages;
  }
  return { english, errors };
}

function readConfig(directory) {
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  if (!isObject(config) || config.sourceLanguage !== 'en' || !isObject(config.languages)
      || typeof config.languages.en !== 'string') {
    throw new Error('frontend/locales/config.json must name "en" as its sourceLanguage and list it in languages');
  }
  for (const [tag, name] of Object.entries(config.languages)) {
    let canonical = null;
    try { [canonical] = Intl.getCanonicalLocales(tag); } catch { /* reported below */ }
    if (canonical !== tag || typeof name !== 'string' || !name.trim()) {
      throw new Error(`frontend/locales/config.json: "${tag}" must be a canonical language tag with its own name`);
    }
  }
  if ('minimumCoverage' in config && !(typeof config.minimumCoverage === 'number'
      && config.minimumCoverage >= 0 && config.minimumCoverage <= 1)) {
    throw new Error('frontend/locales/config.json: minimumCoverage is a fraction from 0 to 1');
  }
  return config;
}

/** The share of a language's messages a translation must cover before it ships. */
const minimumCoverage = (config) => (typeof config.minimumCoverage === 'number' ? config.minimumCoverage : 0);

/** Whether a configured language's coverage lets it ship (`tally` from collectCatalogs). */
function covered(tally, config) {
  return tally.total > 0 && tally.translated / tally.total >= minimumCoverage(config);
}

/**
 * What a language must supply for one namespace: every plain message, and for
 * each counted message the plural forms that language actually uses.
 * `groups` maps a counted message to the keys that make it up.
 */
function requiredMessages(source, language) {
  const required = {};
  const groups = new Map();
  const counted = new Set(Object.keys(source).filter((key) => key.endsWith('_other'))
    .map((key) => key.slice(0, -6)).filter((stem) => `${stem}_one` in source));
  for (const [key, text] of Object.entries(source)) {
    if (!counted.has(key.replace(PLURAL_SUFFIX, ''))) required[key] = text;
  }
  for (const stem of counted) {
    const keys = [];
    for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
      const key = `${stem}_${category}`;
      required[key] = source[key] || source[`${stem}_${category === 'one' ? 'one' : 'other'}`];
      keys.push(key);
    }
    if (`${stem}_zero` in source && !keys.includes(`${stem}_zero`)) {
      required[`${stem}_zero`] = source[`${stem}_zero`];
      keys.push(`${stem}_zero`);
    }
    groups.set(stem, keys);
  }
  return { required, groups };
}

/**
 * 'missing' | 'stale' | 'invalid' for an entry that cannot be used, or null.
 *
 * A translation carries exactly the English text's parameters, with one
 * exception for a form of a counted message (`counted`): the number the form
 * was chosen by, `{{count}}`, is always handed to it, so a translation may
 * show it where English spells the number out ("an hour ago"), and may leave
 * it out where its own form already says it. Russian's `one` form is also
 * used for 21, 31 and 101: it has to be able to print the number.
 */
function translationProblem(entry, english, counted = false) {
  if (entry === undefined) return 'missing';
  if (!isObject(entry) || typeof entry.text !== 'string' || !entry.text.trim()) return 'invalid';
  if (Object.keys(entry).some((field) => !['text', 'source', 'locked'].includes(field))) return 'invalid';
  if ('locked' in entry && typeof entry.locked !== 'boolean') return 'invalid';
  if (entry.source !== hash(english)) return 'stale';
  const named = (text) => parameters(text).filter((name) => !(counted && name === 'count'));
  if (!sameList(named(entry.text), named(english))) return 'invalid';
  try {
    if (!sameList(componentTags(entry.text), componentTags(english))) return 'invalid';
  } catch { return 'invalid'; }
  return null;
}

/**
 * Reads every catalog. Throws for the English source; never for a translation.
 * `report[language]` lists what each language is missing, by reason.
 */
function collectCatalogs(root) {
  const directory = path.join(root, 'frontend/locales');
  const config = readConfig(directory);
  const { english, errors } = readSource(directory);
  if (errors.length) throw new Error(`The English source catalogs need fixing:\n${errors.join('\n')}`);
  const namespaces = Object.keys(english).sort();
  const catalogs = {};
  const report = {};
  for (const language of Object.keys(config.languages)) {
    if (language === 'en') continue;
    catalogs[language] = {};
    const tally = { total: 0, translated: 0, missing: [], stale: [], invalid: [], unknown: [] };
    for (const namespace of namespaces) {
      let translation = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, language, `${namespace}.json`), 'utf8'));
        if (isObject(parsed)) translation = parsed;
        else tally.invalid.push(`${namespace}:*`);
      } catch (err) {
        if (err.code !== 'ENOENT') tally.invalid.push(`${namespace}:*`);
      }
      const { required, groups } = requiredMessages(english[namespace], language);
      const messages = {};
      const unusable = new Set();
      const countedKeys = new Set([...groups.values()].flat());
      for (const [key, text] of Object.entries(required)) {
        tally.total += 1;
        const problem = translationProblem(translation[key], text, countedKeys.has(key));
        if (problem) { tally[problem].push(`${namespace}:${key}`); unusable.add(key); } else messages[key] = translation[key].text;
      }
      // A counted message is used whole or not at all: half a plural set
      // would mix this language's forms with English ones in one sentence.
      for (const keys of groups.values()) {
        if (keys.some((key) => unusable.has(key))) for (const key of keys) delete messages[key];
      }
      for (const key of Object.keys(translation)) {
        if (!(key in required)) tally.unknown.push(`${namespace}:${key}`);
      }
      tally.translated += Object.keys(messages).length;
      catalogs[language][namespace] = messages;
    }
    tally.ships = covered(tally, config);
    report[language] = tally;
  }
  return { config, namespaces, english, catalogs, report };
}

/** English and every configured language whose coverage lets it ship, in config order. */
function shippedLanguages(config, report) {
  return Object.fromEntries(Object.entries(config.languages)
    .filter(([language]) => language === 'en' || report[language]?.ships));
}

function buildLanguagePacks(root) {
  const { config, namespaces, english, catalogs, report } = collectCatalogs(root);
  const languages = shippedLanguages(config, report);
  const output = path.join(root, 'public/locales');
  fs.mkdirSync(output, { recursive: true });
  const manifest = {};
  const current = new Set();
  for (const [language, packs] of Object.entries(catalogs)) {
    // A language the translation step has not filled yet gets no pack: it is
    // not offered, so nothing would ever ask for one.
    if (!(language in languages)) continue;
    manifest[language] = {};
    for (const [namespace, messages] of Object.entries(packs)) {
      const bytes = JSON.stringify(messages);
      const digest = hash(bytes);
      const name = `${language}.${namespace}.${digest}.json`;
      current.add(name);
      fs.writeFileSync(path.join(output, name), bytes);
      manifest[language][namespace] = { url: `/locales/${name}`, hash: digest };
    }
  }
  // A local rebuild leaves no superseded pack behind. A pack a browser has
  // already cached keeps its immutable URL and bytes.
  for (const name of fs.readdirSync(output)) {
    if (PACK_NAME.test(name) && !current.has(name)) fs.unlinkSync(path.join(output, name));
  }
  const generated = path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json');
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(generated, JSON.stringify({ languages, namespaces, english, manifest }));
  writeSource(root, output);
  return { manifest, report, languages };
}

/**
 * Every catalog file as built, in one JSON document ({ files: { path: json } },
 * paths relative to frontend/locales), for a server whose image has no
 * frontend/ (public/locales/.source.json). Returns its path.
 */
function writeSource(root, output = path.join(root, 'public/locales')) {
  const directory = path.join(root, 'frontend/locales');
  const files = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (SOURCE_PATH.test(name)) {
        try { files[name] = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { /* a malformed translation is left out, as a build leaves it out */ }
      }
    }
  };
  walk('');
  fs.mkdirSync(output, { recursive: true });
  const target = path.join(output, SOURCE_FILE);
  fs.writeFileSync(target, JSON.stringify({ files }));
  return target;
}

/** Writes a source document's files back out as root/frontend/locales, for collectCatalogs and the translation step. */
function materializeSource(source, root) {
  const directory = path.join(root, 'frontend/locales');
  for (const [name, content] of Object.entries(source?.files || {})) {
    if (!SOURCE_PATH.test(name)) continue;
    const target = path.join(directory, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

/**
 * The coverage report. `limit` caps the keys listed per reason and language
 * (a language nobody has translated yet is every message missing); pass
 * Infinity for all of them.
 */
function formatReport(report, { limit = 25 } = {}) {
  const languages = Object.keys(report);
  if (!languages.length) return 'Only English is configured; there is no translation coverage to report.';
  const lines = [];
  for (const language of languages) {
    const { total, translated, missing, stale, invalid, unknown, ships } = report[language];
    const percent = total ? Math.floor((translated / total) * 100) : 100;
    lines.push(`${language}: ${translated} of ${total} translated (${percent}%), `
      + `${missing.length} missing, ${stale.length} stale, ${invalid.length} invalid`
      + (unknown.length ? `, ${unknown.length} no longer in English` : '')
      + (ships === false ? ', not offered yet' : ''));
    for (const [reason, keys] of [['missing', missing], ['stale', stale], ['invalid', invalid]]) {
      for (const key of keys.slice(0, limit)) lines.push(`  ${reason}  ${key}`);
      if (keys.length > limit) lines.push(`  ${reason}  … and ${keys.length - limit} more`);
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  try {
    if (process.argv.includes('--report')) {
      const limit = process.argv.includes('--all') ? Infinity : undefined;
      console.log(formatReport(collectCatalogs(root).report, { limit }));
    } else if (process.argv.includes('--check')) {
      const { config, namespaces, report } = collectCatalogs(root);
      console.log(`[language-packs] English source is valid: ${namespaces.length} namespace(s), `
        + `${Object.keys(config.languages).length} configured language(s), `
        + `${Object.keys(shippedLanguages(config, report)).length} shipped`);
    } else {
      buildLanguagePacks(root);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  PACK_NAME, SOURCE_FILE, buildLanguagePacks, collectCatalogs, componentTags, formatReport, hash, materializeSource,
  minimumCoverage, parameters, readConfig, requiredMessages, shippedLanguages, translationProblem, writeSource,
};
