'use strict';

// One versioned record for a diagram of a change (#4490), shared with the
// explanations of #4098: whichever request merges first adds this module and
// the renderer in frontend/src/lib/diagram/, and the other imports them. It is
// named for both uses, not for proposals.
//
// A diagram is DATA, never markup. An author (submit_work's `diagram`, a
// hosted build's `declare_diagram`) sends one of four fixed kinds, or Mermaid
// source for a change nobody sees, and Homeroom draws it. No SVG or HTML from
// an author or a model is ever inserted as given:
//
//   { version: 1, kind: 'rename',  from, to, places?: [..], note? }
//   { version: 1, kind: 'flow',    before: [..], after: [..], note? }
//   { version: 1, kind: 'changes', rows: [{ op: 'added'|'changed'|'removed', what, detail? }] }
//   { version: 1, kind: 'numbers', unit?, rows: [{ label, before, after }] }
//   { version: 1, kind: 'mermaid', source }
//
// The four fixed kinds are text only, so React escapes them and there is
// nothing to sanitise. Mermaid is text too; the browser draws it with the
// vendored library under strict settings and DOMPurify cleans the SVG
// (frontend/src/lib/diagram/mermaid.ts). These checks are the server's half:
// a record that fails is refused at submit with a readable error, never half
// drawn. The module is pure, like visible-changes.js, so a route, an MCP tool
// and a worker bridge all apply the same rule.

const VERSION = 1;
const FIXED_KINDS = Object.freeze(['rename', 'flow', 'changes', 'numbers']);
const KINDS = Object.freeze([...FIXED_KINDS, 'mermaid']);
const OPS = Object.freeze(['added', 'changed', 'removed']);

const LIMITS = Object.freeze({
  text: 60,
  unit: 12,
  places: 8,
  steps: 6,
  rows: 6,
  mermaidChars: 2000,
  mermaidLines: 40,
});

// The diagram types a Mermaid source may open with. Each is drawn without
// HTML labels; anything else (gantt, mindmap, the experimental kinds) is
// refused rather than discovered in a browser.
const MERMAID_TYPES = Object.freeze(['flowchart', 'graph', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram']);

// Words that reach outside the picture: interaction (click, href, callback)
// and URLs a link could carry. Refused anywhere in the source.
const MERMAID_FORBIDDEN = Object.freeze([
  [/%%\s*\{/, 'directives (%%{ … }%%) are not allowed: they can change how the diagram is drawn'],
  [/\bclick\b/i, '"click" is not allowed: a diagram is a picture, not a set of links'],
  [/\bhref\b/i, '"href" is not allowed: a diagram is a picture, not a set of links'],
  [/\bcallback\b/i, '"callback" is not allowed: a diagram is a picture, not a set of links'],
  [/javascript\s*:/i, '"javascript:" is not allowed'],
  [/\bdata\s*:\s*[a-z]+\/[a-z0-9.+-]+/i, 'data: URLs are not allowed'],
  // A style line (style, classDef, linkStyle) takes CSS; none may load
  // anything from elsewhere.
  [/url\s*\(/i, '"url(" is not allowed: a diagram loads nothing from elsewhere'],
  [/@import/i, '"@import" is not allowed'],
]);

// Arrows and the class-diagram relations, the only places a "<" or ">" may
// stand: "-->", "->>", "-.->", "==>", "<-->", "<|--", "--|>", "<<->>" and so
// on. Everything they leave behind is checked for a bare angle bracket, which
// is what an HTML tag would need.
const MERMAID_ARROW_RE = /(?:<<|<\|?)?[-=.]+(?:>>|\|?>)?/g;

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const KIND_WORDS = 'rename, flow, changes or numbers';

class DiagramValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagramValidationError';
    this.code = 'invalid_diagram';
  }
}

function fail(message) {
  throw new DiagramValidationError(message);
}

function text(value, path, { optional = false, max = LIMITS.text } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    fail(`${path}: required, 1 to ${max} characters`);
  }
  if (typeof value !== 'string') fail(`${path}: must be text`);
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) {
    if (optional) return undefined;
    fail(`${path}: required, 1 to ${max} characters`);
  }
  if (CONTROL_RE.test(v)) fail(`${path}: must not contain control characters`);
  if (v.length > max) fail(`${path}: at most ${max} characters (it has ${v.length})`);
  return v;
}

function list(value, path, { min = 1, max }) {
  if (value === undefined || value === null) {
    if (min === 0) return [];
    fail(`${path}: required, a list of ${min} to ${max}`);
  }
  if (!Array.isArray(value)) fail(`${path}: must be a list`);
  if (value.length < min || value.length > max) fail(`${path}: ${min} to ${max} entries (it has ${value.length})`);
  return value;
}

function onlyKeys(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${path}: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function finite(value, path) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${path}: must be a finite number`);
  return n;
}

/**
 * The Mermaid source checks, without Mermaid: size, the opening diagram
 * type, and no directive, interaction or tag. Returns the trimmed source.
 */
function checkMermaidSource(value, path = 'diagram.source') {
  if (typeof value !== 'string' || !value.trim()) fail(`${path}: required, Mermaid source text`);
  const source = value.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trim();
  if (source.length > LIMITS.mermaidChars) fail(`${path}: at most ${LIMITS.mermaidChars} characters (it has ${source.length})`);
  const lines = source.split('\n');
  if (lines.length > LIMITS.mermaidLines) fail(`${path}: at most ${LIMITS.mermaidLines} lines (it has ${lines.length})`);
  if (CONTROL_RE.test(source)) fail(`${path}: must not contain control characters`);
  const first = lines.find((l) => l.trim() && !/^\s*%%/.test(l)) || '';
  const type = first.trim().split(/[\s;]/)[0];
  if (!MERMAID_TYPES.includes(type)) {
    fail(`${path}: must open with one of ${MERMAID_TYPES.join(', ')} (it opens with "${type.slice(0, 30)}")`);
  }
  for (const [re, why] of MERMAID_FORBIDDEN) {
    if (re.test(source)) fail(`${path}: ${why}`);
  }
  if (/[<>]/.test(source.replace(MERMAID_ARROW_RE, ' '))) {
    fail(`${path}: "<" and ">" are allowed only in arrows; write labels as plain words`);
  }
  return source;
}

/**
 * Validate and normalise one diagram record. `impact` is the SAME
 * submission's declared visible-changes impact ('ui' | 'motion' | 'none', or
 * null when it declared none): Mermaid is accepted only when it is 'none',
 * because a change people can see has shots, and one of the four fixed kinds
 * says what else it needs in words anyone can read.
 */
function parseDiagram(value, { impact = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('diagram: must be an object with version 1 and a kind');
  if (value.version !== VERSION) fail('diagram.version: must be 1');
  const kind = value.kind;
  if (!KINDS.includes(kind)) fail(`diagram.kind: must be ${KIND_WORDS} (or mermaid, for a change nobody sees)`);
  switch (kind) {
    case 'rename': {
      onlyKeys(value, ['version', 'kind', 'from', 'to', 'places', 'note'], 'diagram');
      const from = text(value.from, 'diagram.from');
      const to = text(value.to, 'diagram.to');
      if (from === to) fail('diagram.to: must differ from diagram.from');
      const places = list(value.places, 'diagram.places', { min: 0, max: LIMITS.places })
        .map((p, i) => text(p, `diagram.places.${i}`));
      const note = text(value.note, 'diagram.note', { optional: true });
      return { version: VERSION, kind, from, to, ...(places.length ? { places } : {}), ...(note ? { note } : {}) };
    }
    case 'flow': {
      onlyKeys(value, ['version', 'kind', 'before', 'after', 'note'], 'diagram');
      const before = list(value.before, 'diagram.before', { max: LIMITS.steps }).map((s, i) => text(s, `diagram.before.${i}`));
      const after = list(value.after, 'diagram.after', { max: LIMITS.steps }).map((s, i) => text(s, `diagram.after.${i}`));
      if (before.join('\u0000') === after.join('\u0000')) fail('diagram.after: must differ from diagram.before');
      const note = text(value.note, 'diagram.note', { optional: true });
      return { version: VERSION, kind, before, after, ...(note ? { note } : {}) };
    }
    case 'changes': {
      onlyKeys(value, ['version', 'kind', 'rows'], 'diagram');
      const rows = list(value.rows, 'diagram.rows', { max: LIMITS.rows }).map((r, i) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`diagram.rows.${i}: must be { op, what, detail? }`);
        onlyKeys(r, ['op', 'what', 'detail'], `diagram.rows.${i}`);
        if (!OPS.includes(r.op)) fail(`diagram.rows.${i}.op: must be added, changed or removed`);
        const detail = text(r.detail, `diagram.rows.${i}.detail`, { optional: true });
        return { op: r.op, what: text(r.what, `diagram.rows.${i}.what`), ...(detail ? { detail } : {}) };
      });
      return { version: VERSION, kind, rows };
    }
    case 'numbers': {
      onlyKeys(value, ['version', 'kind', 'unit', 'rows'], 'diagram');
      const unit = text(value.unit, 'diagram.unit', { optional: true, max: LIMITS.unit });
      const rows = list(value.rows, 'diagram.rows', { max: LIMITS.rows }).map((r, i) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`diagram.rows.${i}: must be { label, before, after }`);
        onlyKeys(r, ['label', 'before', 'after'], `diagram.rows.${i}`);
        return {
          label: text(r.label, `diagram.rows.${i}.label`),
          before: finite(r.before, `diagram.rows.${i}.before`),
          after: finite(r.after, `diagram.rows.${i}.after`),
        };
      });
      return { version: VERSION, kind, ...(unit ? { unit } : {}), rows };
    }
    default: {
      onlyKeys(value, ['version', 'kind', 'source'], 'diagram');
      if (impact !== 'none') {
        fail(`diagram.kind: mermaid is only for a change nobody sees, declared with visibleChanges impact "none" in the same submission${impact ? ` (this one declares "${impact}")` : ' (this one declares no visibleChanges)'}. Use ${KIND_WORDS} instead.`);
      }
      return { version: VERSION, kind, source: checkMermaidSource(value.source) };
    }
  }
}

/** Whether a stored value is a record this version can draw (no throw). */
function storedDiagram(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    // A stored Mermaid record was accepted under its own submission's
    // impact; reading it back does not re-ask that question.
    return parseDiagram(value, { impact: 'none' });
  } catch {
    return null;
  }
}

/**
 * The text of a ```diagram fence (JSON) or a ```mermaid fence as a record,
 * for #4098's explanations and any Markdown that carries one. Throws as
 * parseDiagram does. A fence is read with impact 'none' allowed: it is not a
 * proposal's picture, and the renderer applies the same drawing rules.
 */
function fromFence(lang, body) {
  const l = String(lang || '').trim().toLowerCase();
  if (l === 'mermaid') return parseDiagram({ version: VERSION, kind: 'mermaid', source: body }, { impact: 'none' });
  if (l !== 'diagram') fail('fence: must be ```diagram or ```mermaid');
  let parsed;
  try { parsed = JSON.parse(String(body || '')); } catch { fail('fence: a ```diagram block must hold the diagram\'s JSON'); }
  return parseDiagram(parsed, { impact: 'none' });
}

// Plain text for GitHub, escaped the way pr-metadata escapes a claim, so an
// author's words cannot become a link, a mention or markup there.
function md(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/@/g, '@​')
    .replace(/[\\`*_[\]()<>|#]/g, '\\$&');
}

function figure(n, unit) {
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return unit ? `${s} ${unit}` : s;
}

const LABELS = Object.freeze({
  rename: 'Rename',
  flow: 'Before → after',
  changes: 'What changes',
  numbers: 'Numbers',
  mermaid: 'Diagram',
});

/**
 * The diagram as Markdown text: what a pull request body carries (GitHub
 * draws a ```mermaid block itself), and what a place that cannot draw a
 * diagram shows instead.
 */
function toMarkdown(diagram) {
  const d = storedDiagram(diagram);
  if (!d) return '';
  switch (d.kind) {
    case 'rename': {
      const lines = [`**Rename:** ${md(d.from)} → ${md(d.to)}${d.places ? ` (${d.places.map(md).join(', ')})` : ''}`];
      if (d.note) lines.push('', md(d.note));
      return lines.join('\n');
    }
    case 'flow': {
      const lines = [
        '**Before → after:**',
        '',
        `- Before: ${d.before.map(md).join(' → ')}`,
        `- After: ${d.after.map(md).join(' → ')}`,
      ];
      if (d.note) lines.push('', md(d.note));
      return lines.join('\n');
    }
    case 'changes':
      return ['**What changes:**', '',
        ...d.rows.map((r) => `- ${r.op[0].toUpperCase()}${r.op.slice(1)}: ${md(r.what)}${r.detail ? ` (${md(r.detail)})` : ''}`)].join('\n');
    case 'numbers':
      return ['**Numbers:**', '',
        ...d.rows.map((r) => `- ${md(r.label)}: ${md(figure(r.before, d.unit))} → ${md(figure(r.after, d.unit))}`)].join('\n');
    default:
      // The source passed checkMermaidSource, which leaves no fence in it.
      return ['```mermaid', d.source.replace(/```/g, ''), '```'].join('\n');
  }
}

const PR_MARKER_START = '<!-- usernode:diagram -->';
const PR_MARKER_END = '<!-- /usernode:diagram -->';

/**
 * The marker-delimited block a pull request body carries for a diagram, or
 * '' for none. `source` says where it came from, as the card's foot does.
 */
function prBlock(diagram, source = 'author') {
  const body = toMarkdown(diagram);
  if (!body) return '';
  const by = source === 'decision' ? 'From the group decision' : 'Diagram by the change\'s author';
  return [PR_MARKER_START, '## Diagram', '', body, '', `_${by}._`, PR_MARKER_END].join('\n');
}

/** Replace (or add, or with '' remove) the diagram block in a body. */
function upsertPrBlock(body, block) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(PR_MARKER_START);
  const end = base.indexOf(PR_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const head = base.slice(0, start).replace(/\n+$/, '');
    const tail = base.slice(end + PR_MARKER_END.length).replace(/^\n+/, '');
    return [head, block, tail].filter((p) => p && p.trim()).join('\n\n');
  }
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

function extractPrBlock(body) {
  const base = typeof body === 'string' ? body : '';
  const start = base.indexOf(PR_MARKER_START);
  const end = base.indexOf(PR_MARKER_END);
  return start !== -1 && end > start ? base.slice(start, end + PR_MARKER_END.length) : '';
}

module.exports = {
  VERSION,
  KINDS,
  FIXED_KINDS,
  OPS,
  LIMITS,
  LABELS,
  MERMAID_TYPES,
  DiagramValidationError,
  parseDiagram,
  storedDiagram,
  checkMermaidSource,
  fromFence,
  toMarkdown,
  prBlock,
  upsertPrBlock,
  extractPrBlock,
  PR_MARKER_START,
  PR_MARKER_END,
};
