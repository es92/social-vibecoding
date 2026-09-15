// Add-challenge form: the template picker fills the whole form (#1063).
//
// WHAT THIS PINS. The picker used to be a bare id-selector: an admin chose a
// template and every other field stayed empty, so the goal, task, reward,
// metric and CTA the template already defines had to be re-typed from the
// Challenge templates screen. Now picking one fills the form, and picking a
// DIFFERENT one fills it again.
//
// The second half is the part a source grep cannot see. Re-filling is not
// "write the new template's values"; it is "make the form show this template
// and nothing else", so a field the new template leaves null has to be
// CLEARED rather than skipped — otherwise the previous template's value
// survives the switch and gets saved as if it had been chosen.
//
// ── How this file changed in #1120 slice 34 ────────────────────────────
//
// The form was innerHTML, so every one of those rules could only be observed
// by writing into a DOM and reading it back: this file ran the whole shipped
// module inside a `vm` against a hand-written DOM shim and drove the real
// `change` handler.
//
// The form is React now, and each rule is a pure function in
// frontend/src/features/admin/topochain/challenge-fields.ts — which the
// component renders from and saves through. The tests call those functions
// directly. That is strictly more of the behaviour under test and none of the
// scaffolding: no shim to keep honest, and a failure points at the rule
// rather than at a fake element.
//
// Two of the seventeen tests are gone on purpose, because what they guarded
// cannot happen any more, and each is recorded at the end of this file.
// The address tests are unchanged in substance: the address is still
// admin-topochain.js's (_readSeasonEventsDeepLink / _syncHash), so they still
// run the router in a vm.
//
// Run with: node --test tests/challenge-template-prefill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, transpileTs } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');

// The rules under test, from the shipped module.
const FIELDS = loadTsx('frontend/src/features/admin/topochain/challenge-fields.ts');
const {
  CH_TEMPLATE_FIELDS, CH_EDIT_FIELDS, buildChallengeBody, templateById, templateFieldText,
  valuesFromTemplate,
} = FIELDS;

// ── Two staging-shaped templates, straight out of the seed ─────────────
//
// 900501 defines a metric; 900500 defines none. Switching between them is
// exactly the "the new template is silent about this field" case. 900501 also
// carries an illustration, which the Add-challenge form must NOT pick up — see
// the last section of the form tests below.
const TEMPLATE_WITH_METRIC = {
  id: 900501,
  category: 'onchain',
  goal: 'Send your first testnet transaction',
  task: 'Send a transaction on the testnet within the event window.',
  reward: '100 points',
  kind: 'SEND_TRANSACTION_CHALLENGE',
  description: 'Send-transaction challenge template.',
  requirements: null,
  reward_logic: null,
  schedule_start: '2026-03-01T00:00:00.000Z',
  schedule_end: null,
  cta_button: 'Open wallet',
  cta_label: 'Send it',
  cta_type: 'url',
  cta_link: 'https://example.com/wallet',
  mobile_cta_label: 'Open the wallet',
  mobile_cta_type: 'app',
  mobile_cta_link: 'usernode://wallet',
  metric_type: 'transactions_sent',
  metric_label: 'transactions',
  metric_target: 1,
  illustration: 'network-participation',
};

const TEMPLATE_BARE = {
  id: 900500,
  category: 'bug',
  goal: 'Report a reproducible bug',
  task: 'Find and file a reproducible bug against the testnet client.',
  reward: '50 points',
  kind: 'REPORT_BUG_CHALLENGE',
  description: null,
  requirements: null,
  reward_logic: null,
  schedule_start: null,
  schedule_end: null,
  cta_button: null,
  cta_label: null,
  cta_type: null,
  cta_link: null,
  mobile_cta_label: null,
  mobile_cta_type: null,
  mobile_cta_link: null,
  metric_type: null,
  metric_label: null,
  metric_target: null,
  illustration: null,
};

const TEMPLATES = [TEMPLATE_WITH_METRIC, TEMPLATE_BARE];

// The form's values after a fresh open, then after picking `id`. Display
// order is the operator's and is not part of the template contract, so it is
// carried the way the component carries it.
const openForm = () => ({ display_order: '0' });
const pick = (values, id) => ({
  ...valuesFromTemplate(templateById(TEMPLATES, id)),
  display_order: values.display_order ?? '0',
});

// ── The form's field inventory ─────────────────────────────────────────

test('the create form renders a control for every template-backed field', () => {
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/challenges.tsx'), 'utf8');
  for (const f of CH_TEMPLATE_FIELDS) {
    // Every field is rendered either by name or through the two helpers that
    // take the key — otherwise the prefill has nowhere to land.
    assert.ok(
      src.includes(`'${f.id}'`),
      `admin-topo-ch-f-${f.id} is rendered — otherwise the prefill has nowhere to write`,
    );
  }
  assert.ok(src.includes('id="admin-topo-ch-f-template"'), 'the template picker is rendered');
  assert.ok(src.includes("fieldId('display_order')"), 'display order is rendered');
  assert.match(src, /const fieldId = \(key: string\) => `admin-topo-ch-f-\$\{key\}`;/,
    'and every id is derived from the field key, so the two lists cannot drift');
});

test('every field starts empty — the fill is what puts values on screen', () => {
  const initial = openForm();
  for (const f of CH_TEMPLATE_FIELDS) {
    assert.equal(initial[f.id] ?? '', '', `${f.id} starts empty`);
  }
});

// ── Picking a template ─────────────────────────────────────────────────

test('picking a template fills every field that template defines', () => {
  const v = pick(openForm(), '900501');

  assert.equal(v.goal, 'Send your first testnet transaction');
  assert.equal(v.reward, '100 points');
  assert.equal(v.kind, 'SEND_TRANSACTION_CHALLENGE');
  assert.equal(v.task, 'Send a transaction on the testnet within the event window.');
  assert.equal(v.description, 'Send-transaction challenge template.');
  assert.equal(v.cta_button, 'Open wallet');
  assert.equal(v.cta_label, 'Send it');
  assert.equal(v.cta_type, 'url');
  assert.equal(v.cta_link, 'https://example.com/wallet');
  assert.equal(v.mobile_cta_label, 'Open the wallet');
  assert.equal(v.mobile_cta_type, 'app');
  assert.equal(v.mobile_cta_link, 'usernode://wallet');
  assert.equal(v.metric_type, 'transactions_sent');
  assert.equal(v.metric_label, 'transactions');
  assert.equal(v.metric_target, '1', 'a numeric template value crosses as a string');
  // An ISO instant has to land as a datetime-local value, or the input shows
  // nothing at all.
  assert.match(v.schedule_start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // Fields the template leaves null are empty, not "null".
  assert.equal(v.requirements, '');
  assert.equal(v.reward_logic, '');
  assert.equal(v.schedule_end, '');
});

// ── Switching template ────────────────────────────────────────────────

test('switching template re-fills, and CLEARS what the new one does not define', () => {
  const first = pick(openForm(), '900501');
  assert.equal(first.metric_type, 'transactions_sent', 'precondition: filled from the first template');

  const second = pick(first, '900500');
  assert.equal(second.goal, 'Report a reproducible bug', 'the new template overwrites');
  assert.equal(second.kind, 'REPORT_BUG_CHALLENGE');
  // 900500 defines no metric, no CTA and no schedule. None of the first
  // template's values may survive.
  for (const key of ['metric_type', 'metric_label', 'metric_target',
    'cta_button', 'cta_label', 'cta_type', 'cta_link',
    'mobile_cta_label', 'mobile_cta_type', 'mobile_cta_link',
    'schedule_start', 'schedule_end']) {
    assert.equal(second[key], '', `${key} is cleared, not left stale`);
  }
  // The rule stated once, rather than field by field: EVERY template field is
  // written on every pick.
  assert.deepEqual(
    CH_TEMPLATE_FIELDS.map((f) => f.id).filter((id) => !(id in second)),
    [], 'no template field is skipped on a re-fill',
  );
});

test('going back to no template empties the form', () => {
  const filled = pick(openForm(), '900501');
  const cleared = pick(filled, '');
  for (const f of CH_TEMPLATE_FIELDS) {
    assert.equal(cleared[f.id], '', `${f.id} is empty again`);
  }
});

test("display order is the operator's, so a template switch leaves it alone", () => {
  let v = { ...openForm(), display_order: '7' };
  v = pick(v, '900501');
  v = pick(v, '900500');
  assert.equal(v.display_order, '7',
    'no template defines display order — clearing it would throw away a real choice');
  assert.ok(!CH_TEMPLATE_FIELDS.some((f) => f.id === 'display_order'),
    'and it is deliberately not in the template field list');
});

// ── Saving ─────────────────────────────────────────────────────────────

// These columns are per-event overrides where null means "inherit the
// template". A challenge created before the prefill existed stored null in
// all of them, so it tracked later template edits — posting the whole filled
// form back would silently end that for every new challenge.
test('create posts only what the operator changed, so untouched fields keep inheriting', () => {
  const values = { ...pick(openForm(), '900501'), reward: '250 points' };
  const body = buildChallengeBody({
    isCreate: true, values, template: templateById(TEMPLATES, '900501'),
  });

  assert.equal(body.reward, '250 points', "the edited field is sent as this event's override");
  assert.equal(body.goal, null, 'the field left as the template filled it keeps inheriting');
  assert.equal(body.metric_type, null);
  assert.equal(body.metric_target, null);
  assert.equal(body.cta_type, null);
  assert.equal(body.mobile_cta_link, null);
  assert.equal(body.schedule_start, null, "including the dates, compared in the form's own format");
  assert.equal(body.requirements, null, 'a field the template leaves empty stays empty');
  assert.equal(body.display_order, 0);
});

test("an edited date and an edited number are sent in the API's types", () => {
  const values = {
    ...pick(openForm(), '900501'),
    schedule_start: '2026-10-02T09:30',
    metric_target: '5',
    requirements: 'A wallet with testnet funds.',
  };
  const body = buildChallengeBody({
    isCreate: true, values, template: templateById(TEMPLATES, '900501'),
  });
  assert.match(body.schedule_start, /^\d{4}-\d{2}-\d{2}T/, 'the datetime-local goes back out as an instant');
  assert.equal(body.metric_target, 5, 'numeric field is sent as a number');
  assert.equal(body.requirements, 'A wallet with testnet funds.');
  assert.equal(body.goal, null, 'and the untouched fields are still left inheriting');
});

test('edit still writes only the override keys the API reports back', () => {
  // What the challenges LIST reports for one challenge: the overrides, and
  // nothing from the template behind it.
  const values = {
    goal: 'Send two transactions',
    reward: '',
    kind: 'SEND_TRANSACTION_CHALLENGE',
    task: '',
    description: '',
    display_order: '2',
  };
  const body = buildChallengeBody({ isCreate: false, values, template: null });
  assert.deepEqual(Object.keys(body).sort(),
    ['description', 'display_order', 'goal', 'kind', 'reward', 'task']);
  assert.equal(body.goal, 'Send two transactions', 'the edit form shows and saves the override');
  assert.deepEqual(CH_EDIT_FIELDS.slice().sort(),
    ['description', 'goal', 'kind', 'reward', 'task'],
    'the metric and CTA fields are NOT editable there: the list endpoint reports no '
    + "challenge-level values for them, so showing the template's would save it as an override");
  // The rendered form has to agree with that list, or a field would be
  // editable and then silently dropped by the save.
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/challenges.tsx'), 'utf8');
  const editBranch = src.slice(src.indexOf('{existing ? ('), src.indexOf(') : ('));
  for (const key of ['metric_type', 'metric_target', 'cta_type', 'schedule_start']) {
    assert.ok(!editBranch.includes(`'${key}'`), `${key} is not rendered on the edit form`);
  }
  assert.ok(!editBranch.includes('admin-topo-ch-f-template'),
    'no template picker on an existing challenge');
});

// ── The template's illustration ────────────────────────────────────────
//
// One field on the Challenge TEMPLATE form picks the art every challenge
// stamped out of that template is drawn with. It was a dropdown; it is a
// gallery of tiles now (2026-09-15), and tests/illustration-gallery.test.js
// pins the gallery itself: its tiles, tones, markers, write gate and the
// SVG allowlist. What stays here is the part that belongs to the FORM, which
// did not change with the control: the value is still the slug string, it
// is template-level only by owner decision (so the challenge form above never
// copies it), and the template form round-trips it, including a stored slug
// the gallery does not list, which must survive an edit rather than being
// quietly saved over with null.

const TEMPLATES_ENTRY = 'frontend/src/features/admin/topochain/challenge-templates.tsx';
const TPL = loadTsx(TEMPLATES_ENTRY);
const GALLERY = loadTsx('frontend/src/features/admin/topochain/illustration-gallery.tsx');
const { renderToHtml, createElement } = require('./lib/render-tsx');

// The gallery as the form renders it, for an admin who can write. The console
// is not loaded under the static renderer, so AdminTopochain is stubbed for
// the one render and removed again.
const renderGallery = (value) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AdminTopochain: { canWrite: () => true } };
  try {
    return renderToHtml(createElement(GALLERY.IllustrationGallery, {
      id: 'admin-topo-tpl-f-illustration', value, onChange() {},
    }));
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
};
const checkedOf = (html) => [
  ...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*data-illustration="([^"]*)"/g),
].map((m) => m[1]);

// A stored template as GET /api/v4/admin/challenge-templates/:id returns it.
const storedTemplate = (illustration) => ({ ...TEMPLATE_WITH_METRIC, illustration });

test('the challenge form never copies the template illustration', () => {
  assert.ok(!CH_TEMPLATE_FIELDS.some((f) => f.id === 'illustration'),
    'there is no per-challenge override, so it is not a template-backed challenge field');
  const v = pick(openForm(), '900501');
  assert.ok(!('illustration' in v), 'picking a template with art does not put it on the challenge form');
  const body = buildChallengeBody({
    isCreate: true, values: v, template: templateById(TEMPLATES, '900501'),
  });
  assert.ok(!('illustration' in body), 'and a new challenge does not send one');
});

test('the template form renders the illustration field as the gallery', () => {
  assert.ok(TPL.ALL_FIELDS.some((f) => f.key === 'illustration' && f.kind === 'illustration'),
    'the field is in ALL_FIELDS, so the fill and the save both carry it');
  assert.ok(!('IllustrationPicker' in TPL), 'the dropdown picker is gone');
  const src = fs.readFileSync(path.join(root, TEMPLATES_ENTRY), 'utf8');
  assert.match(src, /<IllustrationGallery\n\s*id=\{fieldId\(f\.key\)\}/,
    'the gallery is handed the field id, admin-topo-tpl-f-illustration');
  assert.match(renderGallery(''), /<div id="admin-topo-tpl-f-illustration" role="radiogroup"/,
    'which its radio group carries');
  assert.deepEqual(checkedOf(renderGallery('')), [''], 'an empty value checks (none)');
});

test('a stored slug this build does not know is kept, not dropped', () => {
  const values = TPL.templateFormValues(storedTemplate('retired-art'));
  assert.equal(values.illustration, 'retired-art', 'the edit form pre-fills the stored slug as-is');
  assert.deepEqual(checkedOf(renderGallery(values.illustration)), ['retired-art'],
    'the gallery shows it checked rather than collapsing to (none)');
  assert.equal(TPL.buildTemplateBody(values).illustration, 'retired-art',
    'so saving an unrelated edit writes it back unchanged');
});

test('editing a template pre-fills its illustration, and save sends the pick', () => {
  assert.equal(TPL.templateFormValues(storedTemplate('try-three-apps')).illustration, 'try-three-apps');
  assert.deepEqual(checkedOf(renderGallery('try-three-apps')), ['try-three-apps']);
  assert.equal(TPL.templateFormValues(storedTemplate(null)).illustration, '',
    'no illustration fills as empty, not "null"');

  const values = { ...TPL.templateFormValues(storedTemplate(null)), illustration: 'block-production' };
  assert.equal(TPL.buildTemplateBody(values).illustration, 'block-production', 'the picked slug is sent');
});

test('an uploaded illustration round-trips as its slug', () => {
  const slug = `u-${'0123456789abcdef'.repeat(2)}`;
  const values = TPL.templateFormValues(storedTemplate(slug));
  assert.equal(values.illustration, slug);
  assert.deepEqual(checkedOf(renderGallery(slug)), [slug], 'checked before the upload list has loaded');
  assert.equal(TPL.buildTemplateBody(values).illustration, slug, 'and sent back unchanged');
});

test('(none) clears a stored illustration with null', () => {
  const values = { ...TPL.templateFormValues(storedTemplate('try-three-apps')), illustration: '' };
  const body = TPL.buildTemplateBody(values);
  assert.ok('illustration' in body, 'the key is sent on PUT, so the server applies the clear');
  assert.equal(body.illustration, null, 'as null, which the API reads as "clear" rather than "skip"');
});

// ── The address ────────────────────────────────────────────────────────
//
// Still admin-topochain.js's: `_readSeasonEventsDeepLink` parses the
// #admin/season-events/<id>[/new-challenge[/<templateId>]] tail and
// `_syncHash` writes it back. The screen seeds itself from that state and
// publishes into it, so these run the router, not the screen.

const TOPO_SRC = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-topochain.js'), 'utf8')
  .replace(/^import [\s\S]*?from '[^']*';$/gm, '');

const sandboxModule = (rel) => transpileTs(`frontend/src/features/admin/topochain/${rel}`)
  .replace(/^import [\s\S]*?from "[^"]*";$/gm, '')
  .replace(/^export /gm, '');

const TOKENS_SRC = sandboxModule('tokens.ts');
const API_SRC = sandboxModule('api.ts');

// The React seam and the class registry, stubbed: the router below touches
// neither, and a vm cannot render React.
const STUB_SRC = 'var TOPO_REACT_SCREENS = { seasons: { mount() {} } };\n'
  + 'function unmountLegacyPortal() {}\n'
  + 'function mountLegacyPortal() {}\n';

const ADMIN_UI_SRC = (() => {
  const consoleSrc = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
  const m = consoleSrc.match(/export const AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines the AdminUI registry');
  return m[0].replace(/^export const/, 'var');
})();

function loadRouter() {
  const location = { hash: '', search: '' };
  const history = {
    replaceState(_s, _t, url) { location.hash = url; },
  };
  const sandbox = {
    console, setTimeout, clearTimeout, location, history, URLSearchParams, URL, Date,
    navigator: { language: 'en-US' },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  sandbox.window = { document: sandbox.document, addEventListener() {}, removeEventListener() {} };
  vm.createContext(sandbox);
  vm.runInContext(ADMIN_UI_SRC, sandbox, { filename: 'admin-console.js#AdminUI' });
  vm.runInContext(TOKENS_SRC, sandbox, { filename: 'topochain/tokens.ts' });
  vm.runInContext(API_SRC, sandbox, { filename: 'topochain/api.ts' });
  vm.runInContext(STUB_SRC, sandbox, { filename: 'topochain/screens.tsx#stub' });
  vm.runInContext(TOPO_SRC, sandbox, { filename: 'admin-topochain.js' });
  const Topo = sandbox.window.AdminTopochain;
  assert.ok(Topo, 'AdminTopochain is mirrored onto window');
  return { Topo, location };
}

test('the Add-challenge form and its template are an address', () => {
  const { Topo, location } = loadRouter();
  Topo._sub = 'season-events';
  Topo._se.detailId = 900504;
  // What the screen publishes when the picker changes.
  Topo._ch.open = true;
  Topo._ch.templateId = '900501';
  location.hash = '#admin/seasons/season-events/900504/new-challenge';
  Topo._syncHash();
  // The write is always the CANONICAL single-level address (#1179) — the
  // legacy #admin/seasons/... starting hash self-heals on the same write.
  assert.equal(location.hash, '#admin/season-events/900504/new-challenge/900501',
    'the picked template is in the hash, so the filled form can be linked and screenshotted');
});

test('a deep link opens the form already filled from the named template', () => {
  const { Topo, location } = loadRouter();
  location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(Topo._se.detailId, 900504, 'the event segment opens the detail screen');
  assert.equal(Topo._ch.open, true);
  assert.equal(Topo._ch.pendingTemplateId, '900501');
  // And that pending id fills the form, through the same function the picker
  // uses — which is the whole of "already filled".
  const v = pick(openForm(), Topo._ch.pendingTemplateId);
  assert.equal(v.goal, 'Send your first testnet transaction');
});

test('an address with no nested segments resets the nested state', () => {
  const { Topo, location } = loadRouter();
  Topo._se.detailId = 900504;
  Topo._ch.open = true;
  Topo._ch.pendingTemplateId = '900501';
  location.hash = '#admin/seasons/season-events';
  Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(Topo._se.detailId, null, 'the event list, not whatever was open last time');
  assert.equal(Topo._ch.open, false);
  assert.equal(Topo._ch.pendingTemplateId, null);
});

test('the legacy #admin/topochain prefix deep-links the same nested screens', () => {
  const { Topo, location } = loadRouter();
  location.hash = '#admin/topochain/season-events/900504/new-challenge';
  Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(Topo._se.detailId, 900504);
  assert.equal(Topo._ch.open, true);
  assert.equal(Topo._ch.pendingTemplateId, null, 'no template named, so nothing is applied');
});

// Found in the browser: a second template opened from the same mounted
// console landed on the FIRST one. Entering the screen renders the event
// detail twice, and the detail's own _syncHash runs before the form (and its
// picker) exist. With the previous visit's templateId still in state, that
// early sync overwrote the address currently being read, and render #2 then
// parsed its own stale value back out of it — so the deep link was silently
// ignored in favour of whatever was picked last.
test('the address, not the last visit, decides which template a deep link fills', () => {
  const { Topo, location } = loadRouter();
  Topo._sub = 'season-events';
  Topo._se.detailId = 900504;
  // Where the previous visit left off.
  Topo._ch.templateId = '900500';
  Topo._ch.open = true;

  location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(Topo._ch.templateId, '900501',
    'reading the address adopts its template, so a stale one cannot be written back');

  // The event-detail render syncs the address BEFORE the form exists. The
  // legacy prefix self-heals to the canonical single-level address (#1179),
  // but the deep link's segments come through intact.
  Topo._syncHash();
  assert.equal(location.hash, '#admin/season-events/900504/new-challenge/900501',
    'that early sync leaves the deep link intact');

  // Render #2 re-reads it and must reach the same conclusion.
  Topo._readSeasonEventsDeepLink('season-events');
  assert.equal(Topo._ch.pendingTemplateId, '900501', 'the re-read is idempotent');
  assert.equal(pick(openForm(), Topo._ch.pendingTemplateId).goal,
    'Send your first testnet transaction',
    'and the form is filled from the template the address names');
});

test('a view-only admin cannot open the form, and the segment does not stick', () => {
  // The screen renders no form for a view-only admin — `{form != null && write}`
  // — and clears the segment rather than leaving the address promising one.
  const src = fs.readFileSync(
    path.join(root, 'frontend/src/features/admin/topochain/challenges.tsx'), 'utf8');
  assert.match(src, /\{form != null && write \? \(/, 'nothing is rendered without write access');
  assert.match(src,
    /if \(!write && topo\(\)\?\._ch\?\.open\) publishRoute\(\{ open: false, templateId: '' \}\);/,
    'and the /new-challenge segment is dropped');
  // publishRoute is what rewrites the address, so dropping the segment
  // reaches the URL and not just the state.
  assert.match(src, /function publishRoute\(\{[\s\S]*?t\._syncHash\(\);\n\}/,
    'publishRoute writes the router state and then re-syncs the hash');

  // And the router's own half: with `open` false the tail is not written.
  const { Topo, location } = loadRouter();
  Topo._sub = 'season-events';
  Topo._se.detailId = 900504;
  Topo._ch.open = false;
  location.hash = '#admin/seasons/season-events/900504/new-challenge/900501';
  Topo._syncHash();
  assert.equal(location.hash, '#admin/season-events/900504',
    'including from the address, which would otherwise promise a form that is not there');
});

// ── Two tests that were retired with the innerHTML form (#1120 slice 34) ──
//
// "the fill reaches the markup, not just the live value" pinned that
// `_setFieldValue` wrote BOTH `el.value` and the serialising attribute/text,
// because a form built as a string and then filled by property leaves its own
// markup showing the empty form. A controlled React input renders `value`
// from state — there is no second place for it to disagree, and
// `_setFieldValue` no longer exists.
//
// "a repaint during the templates request does not strand the form in a
// detached node" pinned a re-resolve of `#admin-topo-ch-form` after the
// awaited templates fetch, because the event detail can repaint while it is
// in flight and the captured div is then an orphan. The form is a child of
// the detail component now: a repaint unmounts it, and the response resolves
// into a component that no longer exists. That is the portal seam's
// structural answer to the whole class, and scripts/audit-react-ownership.mjs
// is what checks it stays true.
