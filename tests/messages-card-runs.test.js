'use strict';

// Three Messages fixes filed together by the platform admin:
//
//   #2884 — a conversation that is mostly shared cards folds a run of three
//           or more consecutive cards into the first one and a "… N more"
//           row that expands the rest in place. A plain message between two
//           cards breaks the run. (An app's channel folded its proposal cards
//           too, until Homeroom stopped writing any into a channel.)
//   #2882 — the composer has one outline, the card's: the field inside it
//           draws no edge of its own in any engine.
//   #2883 — on a desktop the transcript reads one step down the existing
//           type scale (17 → 15, 15 → 13); the phone keeps its reading size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/css/app.css');
const RUNS = 'frontend/src/lib/card-runs.ts';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

// ── The rule ──────────────────────────────────────────────────────────

test('three or more cards in a row are a run; two are not', () => {
  const { cardRunStarts, CARD_RUN_MIN } = loadTsx(RUNS);
  assert.equal(CARD_RUN_MIN, 3);
  const isCard = (c) => c === 'c';
  const runs = (s) => Object.fromEntries(cardRunStarts([...s], isCard));
  assert.deepEqual(runs('ccc'), { 0: 3 });
  assert.deepEqual(runs('cc'), {}, 'two cards are just two cards');
  assert.deepEqual(runs('mcccccm'), { 1: 5 });
  assert.deepEqual(runs('cccmccc'), { 0: 3, 4: 3 }, 'a plain message between cards breaks the run');
  assert.deepEqual(runs('ccmcc'), {}, 'and what is left on each side is too short to fold');
  assert.deepEqual(runs(''), {});
});

test('the caller can break a run on something that is not a row, such as a day divider', () => {
  const { cardRunStarts } = loadTsx(RUNS);
  const items = [{ day: 1 }, { day: 1 }, { day: 2 }, { day: 2 }, { day: 2 }];
  const runs = cardRunStarts(items, () => true, (a, b) => a.day === b.day);
  assert.deepEqual(Object.fromEntries(runs), { 2: 3 });
});

test('the folded row says how many it holds', () => {
  const { cardRunLabel } = loadTsx(RUNS);
  assert.equal(cardRunLabel(4), '… 4 more');
});

// ── An app's channel: nothing to fold ─────────────────────────────────

test('an app\'s channel no longer folds: Homeroom writes no proposal cards into it', () => {
  // A channel is what people said (services/ws.js sendSystemMessage), so the
  // run of proposal cards #2884 folded there does not occur; the transcript
  // draws every row it has, wherever it is mounted.
  const tsx = read(TRANSCRIPT);
  assert.doesNotMatch(tsx, /foldCards|cardRunStarts|gc-card-run/);
  const mount = read('frontend/src/features/group-chat/mount.ts');
  assert.match(mount, /mountLegacyPortal\(host, createElement\(Transcript, \{ source: key \}\)\);/);
  assert.doesNotMatch(CSS, /\.gc-card-run/);
});

// ── A conversation: #general, a group, a DM ───────────────────────────

test('a conversation folds messages that are only a shared item, never ones a person wrote in', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const fn = src.slice(src.indexOf('function isCardMessage'), src.indexOf('function dayKey'));
  assert.match(fn, /message\.objects\.length > 0 && !message\.content && !message\.attachments\.length\s*\n\s*&& !message\.reply && !message\.pending && !message\.failed/);
  assert.match(src, /cardRunStarts\(snap\.messages, isCardMessage, \(a, b\) => dayKey\(a\) === dayKey\(b\)\)/, 'a day divider breaks a run');
  assert.match(src, /className="messages-card-run-more"\s*\n\s*data-card-run-more=\{hidden\}/);
});

test('the #general demo carries a run of four cards for the declared check', () => {
  const src = read('src/services/staging-messages.js');
  for (const id of [9100406, 9100407, 9100408, 9100409]) assert.match(src, new RegExp(`\\[${id}, \\d+, '`));
});

// ── #2882 / #2883: the stylesheet ─────────────────────────────────────

function rule(selector, from = 0) {
  const i = CSS.indexOf(`\n${selector} {`, from);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('#2882: neither composer field draws an edge of its own; the card keeps its ring', () => {
  // One message box (27 Nov 2026): the group chat's card and field
  // (`.gc-composer-card .gc-composer-input`) are Messages' own now.
  for (const selector of ['.messages-composer-input']) {
    const body = rule(selector);
    assert.match(body, /-webkit-appearance: none;\s*\n\s*appearance: none;\s*\n\s*box-shadow: none;/, `${selector} resets the native box`);
    assert.match(body, /-webkit-tap-highlight-color: transparent;/);
  }
  assert.match(rule('.messages-composer-input'), /\n\s*outline: none;/);
  assert.match(rule('.messages-composer-card:focus-within'), /0 0 0 2px var\(--accent\)/, 'the outer outline stays');
});

test('#2883: from 768px up the transcript steps down the existing scale, and the phone keeps 17px', () => {
  const at = CSS.indexOf('#2883: THE TRANSCRIPT READS ONE STEP DOWN');
  assert.ok(at >= 0);
  const block = CSS.slice(CSS.indexOf('@media (min-width: 768px) {', at), CSS.indexOf('\n}\n', at));
  assert.match(block, /\.messages-message-head \{ min-height: 20px; font-size: 0\.9375rem; \}/);
  assert.match(block, /\.messages-message-head time ~ span \{ font-size: 0\.8125rem; \}/);
  assert.match(block, /\.messages-markdown\.gc-msg-content \{ font-size: 0\.9375rem; line-height: 1\.4; \}/);
  assert.match(block, /\.messages-composer-input \{ font-size: 0\.9375rem; \}/);
  assert.match(block, /\.messages-edit textarea \{ font-size: 0\.9375rem; \}/);
  // In rem, so Settings > Accessibility's Text size reaches the transcript: 0.9375rem and 0.8125rem are 15 and 13 at the default size.
  for (const size of block.match(/font-size: [\d.]+(?:px|rem)/g)) assert.match(size, /font-size: (0\.9375|0\.8125)rem/, 'nothing off the scale');
  assert.match(rule('.messages-markdown.gc-msg-content'), /font-size: 1\.0625rem;/, 'the phone keeps its reading size');
});
