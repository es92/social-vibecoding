'use strict';

// The translation step (frontend/locales/README.md, "Translations").
//
// Contributors write English only. This module is what fills
// frontend/locales/<language>/<namespace>.json for every language in
// config.json: it finds the entries a language is missing, or whose English
// changed since they were translated, asks a model for them with the
// message's description, the glossary and the language's style note, checks
// what comes back the way the build will (parameters, numbered tags, plural
// forms) and more strictly than the build does (whitespace, line breaks,
// names, punctuation), and writes what passes with the digest of the English
// it was translated from. What fails is left out: the build leaves a missing
// message out of the pack and the runtime shows it in English.
//
// It never runs in a build. Builds read whatever translations are committed;
// this runs on Homeroom (services/language-sync-runner.js) or by hand
// (scripts/language-sync.js), and its output is a commit people vote on.
//
// Everything here works on a checkout on disk and takes the model call as a
// parameter (`translate`), so tests drive it with a fake model.

const fs = require('node:fs');
const path = require('node:path');
const packs = require('../../scripts/language-packs');

const LOCALES = path.join('frontend', 'locales');
// Messages per model request. Small enough that one bad answer costs little
// and a response stays well inside its output budget; large enough that the
// system prompt (glossary, rules) is a small share of what is sent.
const CHUNK_SIZE = 60;
const MAX_TOKENS = 16000;
const MODEL = 'claude-sonnet-5-5';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

/** The English source with descriptions: { namespace: { key: { text, description } } }. */
function readEnglishEntries(root) {
  const directory = path.join(root, LOCALES, 'en');
  const english = {};
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    english[file.slice(0, -5)] = readJson(path.join(directory, file), {});
  }
  return english;
}

function readGlossary(root) {
  const glossary = readJson(path.join(root, LOCALES, 'glossary.json'), {});
  return {
    doNotTranslate: Array.isArray(glossary.doNotTranslate) ? glossary.doNotTranslate.filter((term) => typeof term === 'string') : [],
    terms: isObject(glossary.terms) ? glossary.terms : {},
    style: isObject(glossary.style) ? glossary.style : {},
  };
}

/**
 * What a language needs translated. An item is one plain message
 * ({ kind: 'text', key, english }) or one counted message with every plural
 * form the language uses ({ kind: 'plural', stem, forms: { category: english } }).
 *
 * A plain entry is needed when it is missing, out of date or unusable. A
 * counted message is needed whole when any of its forms is. An entry a person
 * corrected (`locked`) is left alone while its English still matches; once
 * the English changes, the correction no longer describes it.
 *
 * `onlyIds` (a Set of 'namespace:key', plural forms by their stem) narrows
 * the plan to those messages: a proposal's own new text.
 */
function planLanguage(root, language, { english = readEnglishEntries(root), onlyIds = null } = {}) {
  const items = [];
  for (const [namespace, entries] of Object.entries(english)) {
    const texts = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.text]));
    const translation = readJson(path.join(root, LOCALES, language, `${namespace}.json`), {});
    const current = isObject(translation) ? translation : {};
    const { required, groups } = packs.requiredMessages(texts, language);
    const counted = new Map();
    for (const [stem, keys] of groups) for (const key of keys) counted.set(key, stem);
    const wanted = (id) => !onlyIds || onlyIds.has(id);
    const needs = (key, text) => {
      const entry = current[key];
      const problem = packs.translationProblem(entry, text, counted.has(key));
      if (!problem) return false;
      // A locked entry that is still current but unusable is a person's
      // mistake to fix, not the step's to overwrite.
      return !(isObject(entry) && entry.locked === true && problem !== 'stale' && problem !== 'missing');
    };
    for (const [key, text] of Object.entries(required)) {
      if (counted.has(key)) continue;
      if (!wanted(`${namespace}:${key}`) || !needs(key, text)) continue;
      items.push({
        kind: 'text', id: `${namespace}:${key}`, namespace, key, english: text,
        description: entries[key]?.description || '',
      });
    }
    for (const [stem, keys] of groups) {
      if (!wanted(`${namespace}:${stem}`)) continue;
      if (!keys.some((key) => needs(key, required[key]))) continue;
      const forms = Object.fromEntries(keys.map((key) => [key.slice(stem.length + 1), required[key]]));
      const description = entries[`${stem}_other`]?.description || entries[`${stem}_one`]?.description || '';
      items.push({
        kind: 'plural', id: `${namespace}:${stem}`, namespace, stem, forms, description,
        english: { one: texts[`${stem}_one`], other: texts[`${stem}_other`] },
      });
    }
  }
  return items;
}

/**
 * The ids whose English a change added or reworded: what a proposal's own
 * translation pass covers. `before` and `after` are readEnglishEntries()
 * results (before: the proposal's merge base). Plural forms are reported by
 * their stem.
 */
function changedEnglishIds(before, after) {
  const ids = new Set();
  for (const [namespace, entries] of Object.entries(after)) {
    for (const [key, entry] of Object.entries(entries)) {
      if (before[namespace]?.[key]?.text === entry.text) continue;
      ids.add(`${namespace}:${key.replace(/_(zero|one|two|few|many|other)$/, '')}`);
      ids.add(`${namespace}:${key}`);
    }
  }
  return ids;
}

function termsFor(glossary, language) {
  const lines = [];
  for (const [term, entry] of Object.entries(glossary.terms)) {
    if (!isObject(entry) || typeof entry[language] !== 'string') continue;
    lines.push(`- "${term}" → "${entry[language]}"${entry.meaning ? ` (${entry.meaning})` : ''}`);
  }
  return lines;
}

/** The language's name in English, for the prompt ("Brazilian Portuguese"). */
function englishName(language, fallback) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || fallback; } catch { return fallback; }
}

/** The system prompt for one language. Identical across that language's requests, so it caches. */
function systemPrompt(language, languageName, glossary) {
  const terms = termsFor(glossary, language);
  const style = typeof glossary.style[language] === 'string' ? glossary.style[language] : '';
  const parts = [
    `You translate the interface of Homeroom, a web app where small communities build apps together and merge every change by a vote, from English into ${englishName(language, languageName)} (${language}, "${languageName}").`,
    'Each message is one complete piece of interface text, with a description of where it appears and what it does. Use the description to choose the right sense and register: a button is a short imperative, a title is a heading, a status line is a statement. A translator sees one message at a time, so translate each one so it reads correctly on its own.',
    [
      'Rules for every message:',
      '- Keep every {{parameter}} exactly as written, untranslated, each one exactly once: the same set of parameters as the English. Move a parameter wherever the grammar of the sentence needs it.',
      '- Keep numbered tags such as <0>…</0> and <1>…</1> with the same numbers, translating the words inside them. Add no other markup, no Markdown, no surrounding quotation marks.',
      '- No space at the start or end. Keep the same number of line breaks.',
      `- Never translate these names; write them exactly as they are: ${glossary.doNotTranslate.join(', ') || '(none)'}.`,
      '- Do not use an em dash (—) unless the English has one.',
      '- Keep the ellipsis character … where the English has it, and keep emoji as they are.',
      '- Use the conventions of the language for punctuation, capitalisation and quotation marks.',
      '- Keep it as short as the English where the language allows: much of this text sits on buttons and narrow phone screens.',
      '- A counted message gives its English forms and the plural categories the language uses; write a form for every category. {{count}} is the number: include it wherever the form needs to show the number.',
    ].join('\n'),
  ];
  if (style) parts.push(`Style: ${style}`);
  if (terms.length) parts.push(`Use these translations for Homeroom's own terms, inflected as the sentence needs:\n${terms.join('\n')}`);
  parts.push('Answer with JSON only: {"translations": [{"id": "...", "text": "..."}, {"id": "...", "forms": {"one": "...", "other": "..."}}]}, one entry for every id you were given.');
  return parts.join('\n\n');
}

function userPrompt(items) {
  return JSON.stringify({
    messages: items.map((item) => (item.kind === 'plural'
      ? {
        id: item.id,
        description: item.description,
        english: item.english,
        categories: Object.keys(item.forms),
      }
      : { id: item.id, description: item.description, english: item.english })),
  });
}

// Structured outputs (output_config.format) accept an object only when it is
// closed: every object says `additionalProperties: false`. An open map of
// strings (`additionalProperties: { type: 'string' }`) is refused, and that
// refusal failed every request this step sent, so no translation was ever
// written (#4641). A counted message's forms are therefore the six CLDR
// plural categories, each optional; acceptItem reads the ones the language
// uses and refuses an answer that leaves one out.
const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          forms: {
            type: 'object',
            properties: Object.fromEntries(PLURAL_CATEGORIES.map((category) => [category, { type: 'string' }])),
            additionalProperties: false,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

/** One model request per chunk of a language's items. */
function buildRequests(language, languageName, items, glossary, { chunkSize = CHUNK_SIZE } = {}) {
  const system = systemPrompt(language, languageName, glossary);
  const requests = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    requests.push({
      customId: `${language}-${requests.length}`,
      language,
      items: chunk,
      params: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt(chunk) }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      },
    });
  }
  return requests;
}

/** The translations in a model answer, by id. Anything unreadable is simply absent. */
function parseAnswer(text) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return out;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return out; }
  for (const entry of Array.isArray(parsed?.translations) ? parsed.translations : []) {
    if (!isObject(entry) || typeof entry.id !== 'string') continue;
    out.set(entry.id, entry);
  }
  return out;
}

const count = (text, pattern) => (text.match(pattern) || []).length;

/**
 * Why a translation of one English text cannot be used, or null. Everything
 * the build checks (packs.translationProblem), and what a reader would
 * notice that the build cannot see.
 */
function textProblem(english, text, { counted = false, doNotTranslate = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (text !== text.trim()) return 'space at an edge';
  const entry = { text, source: packs.hash(english) };
  if (packs.translationProblem(entry, english, counted)) return 'parameters or tags differ from the English';
  if (count(text, /\n/g) !== count(english, /\n/g)) return 'line breaks differ from the English';
  if (/ {2}/.test(text) && !/ {2}/.test(english)) return 'a double space';
  if (/—/.test(text) && !/—/.test(english)) return 'an em dash';
  if (/[<>]/.test(text.replace(/<\/?\d+>/g, '')) && !/[<>]/.test(english.replace(/<\/?\d+>/g, ''))) return 'markup';
  for (const name of doNotTranslate) {
    if (english.includes(name) && count(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))
      < count(english, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
      return `"${name}" is not written as it is`;
    }
  }
  if (text.length > english.length * 4 + 40) return 'far longer than the English';
  return null;
}

/**
 * Checks one answer for one item. Returns { entries: { key: text } } to write,
 * or { problem } to leave the message in English.
 */
function acceptItem(item, answer, glossary) {
  const options = { doNotTranslate: glossary.doNotTranslate };
  if (!answer) return { problem: 'no answer' };
  if (item.kind === 'text') {
    const problem = textProblem(item.english, answer.text, options);
    return problem ? { problem } : { entries: { [item.key]: answer.text } };
  }
  if (!isObject(answer.forms)) return { problem: 'no plural forms' };
  const entries = {};
  for (const [category, english] of Object.entries(item.forms)) {
    const problem = textProblem(english, answer.forms[category], { ...options, counted: true });
    if (problem) return { problem: `${category}: ${problem}` };
    entries[`${item.stem}_${category}`] = answer.forms[category];
  }
  return { entries };
}

/**
 * Writes accepted translations into <language>/<namespace>.json, each with
 * the digest of the English it was translated from, in the English file's
 * order. Entries no longer in English are dropped; a locked entry that is
 * still current is kept as it is.
 */
function writeLanguage(root, language, accepted, english = readEnglishEntries(root), collected = null) {
  const written = [];
  for (const [namespace, entries] of Object.entries(english)) {
    const updates = accepted[namespace] || {};
    const file = path.join(root, LOCALES, language, `${namespace}.json`);
    const current = readJson(file, {});
    const existing = isObject(current) ? current : {};
    const texts = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.text]));
    const { required } = packs.requiredMessages(texts, language);
    const next = {};
    for (const key of Object.keys(required)) {
      if (key in updates) {
        next[key] = { text: updates[key], source: packs.hash(required[key]) };
        // What was accepted, as the translation cache keeps it.
        if (collected) (collected[namespace] ||= {})[key] = next[key];
      } else if (key in existing) next[key] = existing[key];
    }
    if (!Object.keys(updates).length && JSON.stringify(next) === JSON.stringify(existing)) continue;
    if (!Object.keys(next).length && !fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    written.push(path.join(LOCALES, language, `${namespace}.json`));
  }
  return written;
}

/**
 * What a sync would send: for every configured language (or `languages`),
 * its plan and the requests that carry it. Deterministic for a given
 * checkout, which is what lets a Message Batch be submitted on one pass and
 * its answers matched to their messages on a later one.
 */
function prepareSync(root, { languages = null, onlyIds = null, chunkSize = CHUNK_SIZE } = {}) {
  const config = packs.readConfig(path.join(root, LOCALES));
  const glossary = readGlossary(root);
  const english = readEnglishEntries(root);
  const targets = Object.keys(config.languages)
    .filter((language) => language !== 'en' && (!languages || languages.includes(language)));
  const plans = new Map();
  const requests = [];
  for (const language of targets) {
    const items = planLanguage(root, language, { english, onlyIds });
    plans.set(language, items);
    if (items.length) requests.push(...buildRequests(language, config.languages[language], items, glossary, { chunkSize }));
  }
  return { config, glossary, english, targets, plans, requests };
}

/**
 * Plan, translate, check and write, for every configured language (or
 * `languages`). `translate(requests)` sends the requests and resolves to a
 * Map of customId -> { text } (the model's answer) or { error }. Items whose
 * answer fails a check are asked again once, on their own; what fails twice
 * stays English and is reported.
 *
 * Returns { files, entries, languages: { tag: { requested, written, failed: [{ id, problem }] } } },
 * where `entries` is what was accepted, language -> namespace -> key ->
 * { text, source } (the translation cache keeps exactly that).
 */
async function syncTranslations({
  root, translate, languages = null, onlyIds = null, chunkSize = CHUNK_SIZE, log = () => {},
  maxRetries = Infinity,
}) {
  const { config, glossary, english, targets, plans, requests } = prepareSync(root, { languages, onlyIds, chunkSize });
  const summary = { files: [], entries: {}, languages: {} };
  for (const [language, items] of plans) summary.languages[language] = { requested: items.length, written: 0, failed: [] };
  if (!requests.length) return summary;
  const total = [...plans.values()].reduce((sum, items) => sum + items.length, 0);
  log(`translating ${total} message(s) into ${targets.length} language(s)`);

  const accepted = new Map(targets.map((language) => [language, {}]));
  const keep = (language, item, entries) => {
    const byNamespace = accepted.get(language);
    byNamespace[item.namespace] = { ...(byNamespace[item.namespace] || {}), ...entries };
    summary.languages[language].written += 1;
  };

  let pending = requests;
  // What sent each retry back, so a message that is not retried still says
  // why it failed (a refused request reads as the API's own words).
  const retryProblems = new Map();
  for (let round = 0; round < 2 && pending.length; round += 1) {
    const answers = await translate(pending, { round });
    const retry = [];
    for (const request of pending) {
      const answer = answers.get(request.customId) || { error: 'no answer' };
      const parsed = answer.error ? new Map() : parseAnswer(answer.text);
      const failed = [];
      for (const item of request.items) {
        const result = acceptItem(item, parsed.get(item.id), glossary);
        if (result.entries) keep(request.language, item, result.entries);
        else failed.push({ item, problem: answer.error || result.problem });
      }
      if (!failed.length) continue;
      if (round === 0) {
        // Asked again one at a time: one malformed message no longer takes
        // its neighbours down with it.
        retry.push(...failed.map(({ item, problem }, index) => {
          const again = {
            ...buildRequests(request.language, config.languages[request.language], [item], glossary, { chunkSize: 1 })[0],
            customId: `${request.customId}-retry-${index}`,
          };
          retryProblems.set(again.customId, problem);
          return again;
        }));
      } else {
        for (const { item, problem } of failed) summary.languages[request.language].failed.push({ id: item.id, problem });
      }
    }
    // A whole round that failed (a batch that errored, a model refusing
    // everything) is not retried message by message: that would be one
    // request per message. Those stay English, and the next pass tries again.
    if (retry.length > maxRetries) {
      for (const request of retry) {
        const problem = retryProblems.get(request.customId);
        for (const item of request.items) {
          summary.languages[request.language].failed.push({ id: item.id, problem: problem ? `${problem}; not retried` : 'not retried' });
        }
      }
      log(`${retry.length} message(s) failed; too many to retry one at a time`);
      break;
    }
    pending = retry;
  }

  for (const language of targets) {
    summary.entries[language] = {};
    summary.files.push(...writeLanguage(root, language, accepted.get(language), english, summary.entries[language]));
  }
  return summary;
}

module.exports = {
  CHUNK_SIZE,
  MODEL,
  PLURAL_CATEGORIES,
  RESPONSE_SCHEMA,
  acceptItem,
  buildRequests,
  changedEnglishIds,
  parseAnswer,
  planLanguage,
  prepareSync,
  readEnglishEntries,
  readGlossary,
  syncTranslations,
  systemPrompt,
  textProblem,
  writeLanguage,
};
