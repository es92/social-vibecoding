'use strict';

// The one versioned contract for a proposal's declared before/after changes.
// The author declares up to three changes; each names who is signed in, the
// screen sizes, where to start and the steps to reach it. This module is
// deliberately pure: routes, MCP tools and workers all call the same parser,
// so a declaration cannot become more permissive as it crosses a process
// boundary.

const { z } = require('zod');

const PLAN_VERSION = 1;
const MAX_STORIES = 3;
const MAX_VIEWPORTS = 2;
const MAX_STEPS = 40;
const MAX_TEXT = 1_000;
const MAX_LOCATOR_VALUE = 256;
const MAX_PATH = 512;

const IMPACTS = Object.freeze(['ui', 'motion', 'none']);
const PERSONAS = Object.freeze(['member', 'read_only_admin', 'full_admin']);
const ANIMATIONS = Object.freeze(['none', 'steps', 'motion']);
const CONTROLLED_FAILURE_LABEL = 'Controlled test: deliberately block the declared API GET on both revisions.';
const LOCATOR_KINDS = Object.freeze(['testId', 'role', 'label', 'placeholder', 'text', 'css']);

const ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/;
const VIEWPORT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/ig;
const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\b(?:sk|gh[pousr]|github_pat|glpat|xox[baprs]|AIza)[-_][A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
]);

class VisualEvidenceValidationError extends Error {
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues : [{ path: [], message: String(issues) }];
    super(normalized.map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : 'visualEvidence';
      return `${path}: ${issue.message}`;
    }).join('; '));
    this.name = 'VisualEvidenceValidationError';
    this.code = 'invalid_visual_evidence';
    this.issues = normalized.map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.map(String) : [],
      message: String(issue.message || 'Invalid value'),
    }));
  }
}

function singleLine(value) {
  return typeof value === 'string' && value.trim() === value
    && !CONTROL_RE.test(value) && !/[\r\n]/.test(value);
}

function textField(max = MAX_TEXT, min = 1) {
  return z.string().min(min).max(max).refine(singleLine, 'Must be a trimmed single line without control characters');
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH) return false;
  if (!singleLine(value) || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  if (ABSOLUTE_URL_RE.test(value) || /%2f%2f/i.test(value)) return false;
  try {
    const parsed = new URL(value, 'https://evidence.invalid');
    return parsed.origin === 'https://evidence.invalid'
      && !parsed.username && !parsed.password
      && ![...parsed.searchParams.keys()].some((key) => /^(?:token|access_token|auth|authorization|password|passwd|secret|api[_-]?key)$/i.test(key))
      && parsed.pathname.startsWith('/');
  } catch {
    return false;
  }
}

const relativePathSchema = z.string().max(MAX_PATH)
  .refine(validRelativePath, 'Must be one relative in-app path beginning with a single "/"')
  .refine((value) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* malformed escapes are rejected by validRelativePath */ }
    return !credentialLike(value) && !credentialLike(decoded);
  }, 'Must not contain credentials, tokens, or non-fixture email addresses');

function validControlledFailurePath(value) {
  if (!validRelativePath(value) || !value.startsWith('/api/') || value.includes('*')) return false;
  try {
    const parsed = new URL(value, 'https://evidence.invalid');
    return !parsed.hash && `${parsed.pathname}${parsed.search}` === value;
  } catch { return false; }
}

const controlledFailurePathSchema = relativePathSchema.refine(validControlledFailurePath,
  'Must be one exact, same-origin /api/ GET path (optional query, no fragment or wildcard)');

function credentialLike(value, fixtureDomains = ['example.test', 'example.invalid', 'test.invalid']) {
  const text = String(value || '');
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  EMAIL_RE.lastIndex = 0;
  let match;
  while ((match = EMAIL_RE.exec(text))) {
    if (!fixtureDomains.includes(String(match[1]).toLowerCase())) return true;
  }
  return false;
}

const locatorSchema = z.union([
  z.object({ by: z.literal('testId'), value: textField(MAX_LOCATOR_VALUE) }).strict(),
  z.object({
    by: z.literal('role'),
    role: textField(64),
    name: textField(MAX_LOCATOR_VALUE).optional(),
    exact: z.boolean().optional().default(true),
  }).strict(),
  z.object({ by: z.literal('label'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('placeholder'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('text'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('css'), value: textField(MAX_LOCATOR_VALUE) }).strict()
    .refine(({ value }) => !/^\s*(?:html|body|\*)\s*$/i.test(value), 'Unbounded root selectors are not allowed'),
]);

const viewportSchema = z.object({
  name: z.string().min(1).max(32).regex(VIEWPORT_RE),
  width: z.number().int().min(320).max(1920),
  height: z.number().int().min(480).max(1440),
}).strict();

const intentSchema = z.object({
  startPath: relativePathSchema,
  steps: z.array(textField(200)).min(1).max(MAX_STEPS),
  checkpoint: textField(500),
  focus: textField(200),
  // An explicit author declaration for a genuinely new screen/control. The
  // replay still has to capture and assert an honest stable parent on base;
  // this field only controls the reviewer-facing absence label. Missing
  // media is never inferred to mean absence.
  baseState: z.enum(['present', 'not_present']).default('present'),
  animation: z.enum(ANIMATIONS).default('none'),
  controlledFailurePath: controlledFailurePathSchema.optional(),
  // Optional shot-list hints from the author, who already reached this
  // state while building it. They steer the hosted capture agent straight to
  // the screen instead of rediscovering it from the diff; nothing here is
  // executed or trusted as proof.
  hints: z.object({
    setup: textField(500).optional(),
    expectText: z.array(textField(120)).min(1).max(5).optional(),
    focusTarget: locatorSchema.optional(),
  }).strict().optional(),
}).strict();

const storyIntentObject = z.object({
  id: z.string().min(1).max(96).regex(ID_RE),
  claim: textField(MAX_TEXT),
  persona: z.enum(PERSONAS),
  viewports: z.array(viewportSchema).min(1).max(MAX_VIEWPORTS),
  intent: intentSchema,
}).strict();

const storyIntentSchema = storyIntentObject.superRefine((story, ctx) => {
  if (story.intent.controlledFailurePath && story.intent.steps[0] !== CONTROLLED_FAILURE_LABEL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intent', 'steps', 0],
      message: `A controlled failure must begin its reviewer-visible steps with: ${CONTROLLED_FAILURE_LABEL}` });
  }
  const names = new Set();
  story.viewports.forEach((viewport, index) => {
    if (names.has(viewport.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['viewports', index, 'name'], message: 'Viewport names must be unique within a story' });
    }
    names.add(viewport.name);
  });
});

const semanticIntentSchema = z.object({
  version: z.literal(PLAN_VERSION),
  impact: z.enum(IMPACTS),
  rationale: textField(MAX_TEXT),
  stories: z.array(storyIntentSchema).max(MAX_STORIES).default([]),
}).strict().superRefine((intent, ctx) => {
  if (intent.impact === 'none' && intent.stories.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories'], message: 'No stories are allowed when impact is "none"' });
  }
  if (intent.impact !== 'none' && intent.stories.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories'], message: 'At least one evidence story is required for a visible change' });
  }
  const ids = new Set();
  intent.stories.forEach((story, index) => {
    if (ids.has(story.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'id'], message: 'Story ids must be unique' });
    }
    ids.add(story.id);
    if (intent.impact === 'ui' && story.intent.animation === 'motion') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'intent', 'animation'], message: 'The motion profile requires impact "motion"' });
    }
  });
});

function normalizeZodIssues(error) {
  // Zod includes submitted field names in some messages; diagnostics keep
  // only the expected field path and a fixed description.
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String),
    message: issue.code === 'unrecognized_keys'
      ? 'Unexpected field(s); use only the documented declaration fields'
      : issue.code === 'invalid_string' && issue.validation === 'regex'
        ? 'Use a lowercase slug with letters, digits, hyphens or underscores'
        : issue.code === 'invalid_union'
          ? `Expected a locator with "by" set to one of: ${LOCATOR_KINDS.join(', ')}`
          : issue.message,
  }));
}

function parseWith(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VisualEvidenceValidationError(normalizeZodIssues(parsed.error));
  return parsed.data;
}

function parseIntent(value) {
  return parseWith(semanticIntentSchema, value);
}

function safeParseIntent(value) {
  try { return { ok: true, value: parseIntent(value), errors: [] }; }
  catch (err) {
    if (!(err instanceof VisualEvidenceValidationError)) throw err;
    return { ok: false, value: null, errors: err.issues };
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// A change needs a clip when a still image cannot show it.
function needsClip(story) {
  return story?.intent?.animation === 'motion';
}

module.exports = {
  PLAN_VERSION,
  MAX_STORIES,
  MAX_VIEWPORTS,
  MAX_TEXT,
  MAX_LOCATOR_VALUE,
  MAX_PATH,
  IMPACTS,
  PERSONAS,
  ANIMATIONS,
  CONTROLLED_FAILURE_LABEL,
  LOCATOR_KINDS,
  VisualEvidenceValidationError,
  validRelativePath,
  credentialLike,
  parseIntent,
  safeParseIntent,
  canonicalJson,
  needsClip,
};
