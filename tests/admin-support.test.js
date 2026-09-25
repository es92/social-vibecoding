'use strict';

// The Support admin section (#admin/support): registered like every other
// React section, built from AdminUI, writes gated on canWrite, and copy
// without em dashes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SUPPORT = read('frontend/src/features/admin/admin-support.tsx');
const CONSOLE = read('frontend/src/features/admin/admin-console.js');
const SECTIONS = read('frontend/src/features/admin/sections.ts');
const AUDIT = read('scripts/audit-react-ownership.mjs');
const DAPP = JSON.parse(read('dapp.json'));

function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const CODE = code(SUPPORT);

test('the section is registered and mounts through a legacy portal', () => {
  assert.match(CONSOLE, /support: 'AdminSupport'/);
  assert.match(SECTIONS, /import '\.\/admin-support\.tsx';/);
  assert.match(CODE, /render\(el: HTMLElement\) \{ host = el; mountLegacyPortal\(el, <Support \/>\); \}/);
  assert.match(CODE, /unmountLegacyPortal\(host\)/);
  assert.match(CODE, /\(window as any\)\.AdminSupport = AdminSupport/);
});

test('built from AdminUI and the shared detail parts, never shell primitives', () => {
  assert.doesNotMatch(SUPPORT, /@\/components\/ui\//);
  assert.match(SUPPORT, /from '\.\/admin-detail-parts\.tsx'/);
  assert.doesNotMatch(CODE, /\b(gray|indigo)-\d/);
});

test('the pinned ids exist', () => {
  for (const id of ['admin-support-search', 'admin-support-points', 'admin-support-header',
    'admin-support-glance', 'admin-support-events', 'admin-support-kudos',
    'admin-support-leaderboard', 'admin-support-timeline', 'admin-support-history',
    'admin-support-open-users', 'admin-support-back']) {
    assert.ok(SUPPORT.includes(`"${id}"`), `renders #${id}`);
  }
});

test('writes render only for admins with write access', () => {
  assert.match(CODE, /const canWrite = !!console_\(\)\?\.canWrite\(\);/);
  assert.match(CODE, /\{canWrite \? \(\s*<div className="mt-4">\s*<AdjustPointsForm/);
  assert.match(CODE, /const reversible = canWrite && a\.source === 'support_adjustment' && !a\.reversed && !isReversal;/);
  assert.match(CODE, /send\('POST', `\/api\/admin\/support\/users\/\$\{userId\}\/points-adjustment`/);
  assert.match(CODE, /send\('POST', `\/api\/admin\/support\/actions\/\$\{actionId\}\/reverse`/);
});

test('the search box commits on blur or Enter, not per keystroke', () => {
  assert.match(CODE, /id="admin-support-search"[^>]*defaultValue=/s);
  assert.match(CODE, /onBlur=\{\(e\) => run\(/);
  assert.doesNotMatch(CODE.slice(CODE.indexOf('id="admin-support-search"'), CODE.indexOf('Press Enter')), /onChange=/);
});

test('user-facing copy has no em dashes and no clickable addresses', () => {
  assert.ok(!/—|&mdash;|&#8212;|\\u2014/.test(CODE), 'no em dash in code or copy');
  assert.doesNotMatch(CODE, /<a\s/, 'no anchors: addresses and wallets render as text');
  assert.match(SUPPORT, /Earned|Lost/);
});

test('ownership audit and the declared check cover the section', () => {
  assert.ok(AUDIT.includes("{ sel: '#admin-section-content', when: '#admin/support' }"));
  assert.ok(AUDIT.includes("'#admin/support/900302'"));
  const checks = DAPP.tests.filter((t) => t.path.startsWith('/#admin/support'));
  assert.strictEqual(checks.length, 1);
  assert.strictEqual(checks[0].expectSelector, '#admin-support-points');
});
