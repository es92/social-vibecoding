'use strict';

// A change's head is untrusted code, so the emails it adds or rewords are
// never run: this reads the two files that hold them as plain text, and
// understands only the shapes those files are written in. Anything it cannot
// follow marks that kind `unreadable` instead of guessing.
//
//   const NAME = <string expression>;         a layout's parts, resolved once
//   const SEEDS = { layouts: [...], templates: { kind: { ... } } };
//   const ACTIONS = { kind: { label: '...', sample: { ... } } };
//
// It handles string and template literals, `+` concatenation, `${NAME}` for a
// top-level const, `${ACTIONS.kind.label}` read from the same ref's actions
// text, and `${PRODUCTION_ORIGIN}` from the running platform. A `sample:` is a
// plain object of strings, numbers, booleans, null and nested plain objects or
// arrays. Nothing here is ever evaluated.

const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const { ACTIONS: RUNNING_ACTIONS } = require('./actions');

const OPAQUE = Symbol('opaque');
const MAX_BYTES = 400 * 1024;

class Reader {
  constructor(text) {
    this.src = String(text || '');
    this.pos = 0;
  }

  ws() {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos += 1;
      if (this.src.startsWith('//', this.pos)) {
        const end = this.src.indexOf('\n', this.pos);
        this.pos = end === -1 ? this.src.length : end + 1;
        continue;
      }
      if (this.src.startsWith('/*', this.pos)) {
        const end = this.src.indexOf('*/', this.pos + 2);
        this.pos = end === -1 ? this.src.length : end + 2;
        continue;
      }
      return;
    }
  }

  peek() { this.ws(); return this.src[this.pos] || ''; }

  take(value) {
    this.ws();
    if (!this.src.startsWith(value, this.pos)) return false;
    this.pos += value.length;
    return true;
  }

  ident() {
    this.ws();
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  skipBalanced(open, close) {
    this.take(open);
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === "'" || ch === '"' || ch === '`') { this.string(ch); continue; }
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      this.pos += 1;
    }
  }

  string(quote) {
    // Called with the quote char at this.pos.
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' })[next] ?? next ?? '';
        this.pos += 2;
        continue;
      }
      if (ch === quote) { this.pos += 1; return out; }
      out += ch;
      this.pos += 1;
    }
    throw new Error('Unclosed string');
  }

  template(scope) {
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' })[next] ?? next ?? '';
        this.pos += 2;
        continue;
      }
      if (ch === '`') { this.pos += 1; return out; }
      if (ch === '$' && this.src[this.pos + 1] === '{') {
        this.pos += 2;
        const value = this.expression(scope, { interpolation: true });
        this.ws();
        if (!this.take('}')) throw new Error('Unclosed interpolation');
        if (value === OPAQUE) return OPAQUE;
        out += String(value ?? '');
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('Unclosed template');
  }

  expression(scope, { interpolation = false } = {}) {
    const value = this.primary(scope, { interpolation });
    this.ws();
    if (this.peek() === '+') {
      this.pos += 1;
      const right = this.expression(scope, { interpolation });
      if (value === OPAQUE || right === OPAQUE) return OPAQUE;
      return `${value ?? ''}${right ?? ''}`;
    }
    return value;
  }

  member(name, scope) {
    this.ws();
    if (this.peek() === '.') {
      this.pos += 1;
      const key = this.ident();
      if (key === null) return OPAQUE;
      // ACTIONS.kind.label, read from this ref's own actions text (or the
      // running registry when this file is the running one).
      if (name === 'ACTIONS' && scope.actions && Object.hasOwn(scope.actions, key)) {
        return this.member(`${name}.${key}`, { ...scope, base: scope.actions[key] });
      }
      if (scope.base && Object.hasOwn(scope.base, key)) return scope.base[key];
      // An unknown name: consume the rest of the chain, so the enclosing
      // object still finds its comma.
      while (this.peek() === '.') { this.pos += 1; this.ident(); }
      return OPAQUE;
    }
    if (name === 'PRODUCTION_ORIGIN') return PRODUCTION_ORIGIN;
    if (scope.consts && Object.hasOwn(scope.consts, name)) return scope.consts[name];
    return OPAQUE;
  }

  primary(scope, { interpolation = false } = {}) {
    this.ws();
    const ch = this.src[this.pos] || '';
    if (ch === "'" || ch === '"') return this.string(ch);
    if (ch === '`') return this.template(scope);
    if (ch === '{') return this.object(scope);
    if (ch === '[') return this.array(scope);
    if (ch === '(') {
      // An arrow function's parameters, or a parenthesised value.
      const save = this.pos;
      this.skipBalanced('(', ')');
      this.ws();
      if (this.take('=>')) { this.skipValue(); return OPAQUE; }
      this.pos = save + 1;
      const value = this.expression(scope);
      this.take(')');
      return value;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+(?:\.\d+)?/.exec(this.src.slice(this.pos));
      if (m) { this.pos += m[0].length; return Number(m[0]); }
    }
    const word = this.ident();
    if (word === null) { this.pos += 1; return OPAQUE; }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === 'undefined') return undefined;
    // A function or a call is not read: it is not a value a template prints.
    if (word === 'function') { this.skipBalanced('{', '}'); return OPAQUE; }
    this.ws();
    if (this.src.startsWith('=>', this.pos)) { this.pos += 2; this.skipValue(scope); return OPAQUE; }
    if (this.peek() === '(') { this.skipBalanced('(', ')'); this.ws(); if (this.take('=>')) this.skipValue(scope); return OPAQUE; }
    return this.member(word, scope);
  }

  skipValue() {
    this.ws();
    if (this.peek() === '{') { this.skipBalanced('{', '}'); return; }
    if (this.peek() === '[') { this.skipBalanced('[', ']'); return; }
    if (this.peek() === '(') { this.skipBalanced('(', ')'); return; }
    this.primary({});
  }

  object(scope) {
    if (!this.take('{')) return OPAQUE;
    const out = {};
    for (;;) {
      this.ws();
      if (this.take('}')) return out;
      if (this.take('...')) { this.skipValue(scope); this.take(','); continue; }
      const ch = this.src[this.pos] || '';
      const key = ch === "'" || ch === '"' ? this.string(ch)
        : ch === '`' ? this.template(scope) : this.ident();
      if (key === null) return OPAQUE;
      this.ws();
      if (!this.take(':')) {
        // Shorthand: a name whose value is itself.
        out[key] = scope.consts && Object.hasOwn(scope.consts, key) ? scope.consts[key] : OPAQUE;
        this.take(',');
        continue;
      }
      out[key] = this.expression(scope, { property: key });
      this.ws();
      this.take(',');
    }
  }

  array(scope) {
    if (!this.take('[')) return OPAQUE;
    const out = [];
    for (;;) {
      this.ws();
      if (this.take(']')) return out;
      out.push(this.expression(scope));
      this.ws();
      this.take(',');
    }
  }
}

/** Pure: the top-level `const NAME = <expression>;` declarations, in order. */
function constsOf(text, actions) {
  const reader = new Reader(text);
  const consts = {};
  for (;;) {
    reader.ws();
    if (reader.pos >= reader.src.length) break;
    const word = reader.ident();
    if (word !== 'const' && word !== 'let' && word !== 'var') {
      if (word === null) { reader.pos += 1; continue; }
      // Skip the rest of an unknown statement.
      const end = reader.src.indexOf(';', reader.pos);
      reader.pos = end === -1 ? reader.src.length : end + 1;
      continue;
    }
    const name = reader.ident();
    if (name === null) {
      // A destructuring declaration is not a value a template prints.
      if (reader.peek() === '{' || reader.peek() === '[') {
        const close = reader.peek() === '{' ? '}' : ']';
        reader.skipBalanced(reader.peek(), close);
        while (reader.pos < reader.src.length && reader.src[reader.pos] !== ';') reader.pos += 1;
        reader.take(';');
        continue;
      }
      break;
    }
    if (!reader.take('=')) { reader.pos += 1; continue; }
    const value = reader.expression({ consts, actions });
    consts[name] = value;
    while (reader.pos < reader.src.length && reader.src[reader.pos] !== ';' && reader.src[reader.pos] !== '\n') reader.pos += 1;
    reader.take(';');
  }
  return consts;
}

/** Pure: the actions file's `label` and `sample` for each kind it may read. */
function actionsOf(text) {
  const reader = new Reader(text);
  let start = -1;
  for (;;) {
    reader.ws();
    const word = reader.ident();
    if (word === null) { if (reader.pos >= reader.src.length) break; reader.pos += 1; continue; }
    if (word !== 'const') continue;
    const name = reader.ident();
    if (name === 'ACTIONS' && reader.take('=')) { start = reader.pos; break; }
  }
  const actions = {};
  if (start === -1) return actions;
  reader.pos = start;
  const parsed = reader.object({ consts: {}, actions: {} });
  if (parsed === OPAQUE || !parsed || typeof parsed !== 'object') return actions;
  for (const [kind, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || value === OPAQUE) continue;
    const label = typeof value.label === 'string' ? value.label : null;
    const sample = plain(value.sample) ? value.sample : null;
    actions[kind] = { label, sample };
  }
  return actions;
}

/** Pure: `true` when a value is plain data (no expression the reader could not follow). */
function plain(value) {
  if (value === OPAQUE) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(plain);
  if (value && typeof value === 'object') return Object.values(value).every(plain);
  return value === undefined;
}

/**
 * Pure: what a change's two files say about its emails:
 * `{ layouts, templates: { kind: { layout, subject, preheader, why, html, text } },
 *    samples: { kind }, labels: { kind }, unreadable: [kind] }`.
 */
function readSeeds(seedsText, actionsText) {
  const empty = { layouts: {}, templates: {}, samples: {}, labels: {}, unreadable: [] };
  if (String(seedsText || '').length > MAX_BYTES || String(actionsText || '').length > MAX_BYTES) return empty;
  const actions = actionsOf(actionsText);
  const consts = constsOf(seedsText, actions);
  const seeds = consts.SEEDS;
  if (!seeds || typeof seeds !== 'object' || seeds === OPAQUE) return empty;

  const layouts = {};
  for (const layout of Array.isArray(seeds.layouts) ? seeds.layouts : []) {
    if (!layout || typeof layout !== 'object' || typeof layout.name !== 'string') continue;
    if (typeof layout.html !== 'string' || typeof layout.text !== 'string') continue;
    layouts[layout.name] = { name: layout.name, html: layout.html, text: layout.text };
  }

  const templates = {};
  const samples = {};
  const labels = {};
  const unreadable = [];
  for (const [kind, template] of Object.entries(seeds.templates && typeof seeds.templates === 'object' ? seeds.templates : {})) {
    const fields = {};
    let bad = !template || typeof template !== 'object' || template === OPAQUE;
    for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
      const value = template?.[field];
      if (typeof value === 'string') fields[field] = value;
      else { fields[field] = ''; if (value !== undefined) bad = true; }
    }
    if (typeof template?.layout !== 'string') bad = true;
    // A kind the file builds with a helper call (codeAction) cannot be read
    // as text; the running platform's own sample stands in, which is safe:
    // it is Homeroom's code, never the change's.
    const running = Object.hasOwn(RUNNING_ACTIONS, kind) ? RUNNING_ACTIONS[kind] : null;
    const sample = actions[kind]?.sample === undefined || actions[kind]?.sample === null
      ? running?.sample
      : actions[kind].sample;
    if (bad || !plain(sample === undefined ? {} : sample)) { unreadable.push(kind); continue; }
    templates[kind] = { layout: template.layout, ...fields };
    samples[kind] = sample === undefined ? {} : sample;
    const label = actions[kind]?.label || (typeof running?.label === 'string' ? running.label : null);
    if (typeof label === 'string') labels[kind] = label;
  }
  return { layouts, templates, samples, labels, unreadable };
}

module.exports = { readSeeds, actionsOf, constsOf, Reader, OPAQUE, MAX_BYTES };
