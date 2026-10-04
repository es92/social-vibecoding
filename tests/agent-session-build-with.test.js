'use strict';

// The agent-session composer's "Build with" (#3078, #3079, #3080).
//
//   1. #3080: the button that attaches photos and files is a paperclip, not a
//      "+", and says so to a screen reader.
//   2. #3079: the model pill names the thinking level after the model, small
//      and muted, for a model that takes one: "GPT-5 High". The label block is
//      centred in the pill and the two words share a baseline.
//   3. #3078: the pill opens "Build with", a real tablist: Homeroom (the one
//      "Model" list, the thinking level, the credits) | Claude Code | Codex,
//      whose tabs are the hand-off itself (tests/agent-session-controls.test.js
//      pins its checks and its one button). "Build: Homeroom" left the bar.
//
// The instructions the hand-off copies carrying the chat's spec are pinned in
// tests/launchpad-instructions.test.js and tests/dev-flow-routes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const parts = loadTsx('frontend/src/features/agent-session/composer-parts.tsx');
const panel = read('frontend/src/features/agent-session/index.tsx');

test('#3080: attaching is a paperclip named "Attach photos or files"', () => {
  const composer = panel.slice(panel.indexOf('function Composer('), panel.indexOf('// ── The changes drawer'));
  const attach = composer.slice(composer.lastIndexOf('<button', composer.indexOf('data-agent-session-attach')), composer.indexOf('</button>', composer.indexOf('data-agent-session-attach')));
  assert.match(attach, /aria-label="Attach photos or files"/);
  assert.match(attach, /<PaperclipIcon className="h-5 w-5" aria-hidden="true" \/>/);
  assert.doesNotMatch(attach, /PlusIcon|<svg/, 'the kit\'s glyph, not a "+" and not a raw <svg>');
  assert.match(read('frontend/@/components/ui/icons.tsx'), /export const PaperclipIcon = stroked\(/);
});

test('#3079: the pill says the thinking level after the model, muted, centred, on one baseline', () => {
  const pill = (effort) => renderToHtml(createElement(parts.ModelPill, {
    label: 'GPT-5', effort, disabled: false, open: false, onOpen() {}, pillRef: { current: null },
  }));
  const high = pill('High');
  assert.match(high, /aria-label="Model: GPT-5, thinking High"/);
  assert.match(high, /^<button[^>]*class="inline-flex h-10 [^"]*items-center /, 'the label block is centred in the pill');
  // #3574: the block is one clipped, wrapping line, so a level with no room
  // beside the name wraps out of sight rather than squeezing the name
  // (tests/agent-session-model-pill-room.test.js).
  assert.match(high, /<span class="flex h-6 min-w-0 flex-wrap items-baseline justify-center gap-x-1\.5 overflow-hidden leading-6"><span class="truncate">GPT-5<\/span><span class="shrink-0 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-model-effort="true">High<\/span><\/span>/,
    'the two words share a baseline; the level is small, in paired muted ink');

  const none = pill('');
  assert.match(none, /aria-label="Model: GPT-5"/, 'a model with no thinking level: its name alone');
  assert.doesNotMatch(none, /data-agent-session-model-effort/);

  // Only for a model that takes a thinking level.
  const model = panel.slice(panel.indexOf('function useModelChoice('), panel.indexOf('function useCredit('));
  assert.match(model, /const effort = current && offersReasoning\(current, catalog\)/);
  // One source for the pill's level (#3079): model-choice.ts effortLabel,
  // which never falls back to a "Default" placeholder.
  assert.match(model, /effortLabel: effortLabel\(current, catalog\),/);
  assert.doesNotMatch(model, /effort\.options\.find\(/);
  assert.match(panel, /<ModelPill\s+label=\{model\.label\}\s+effort=\{model\.effortLabel\}/);
});

test('#3078: Build with is a tablist of Homeroom, Claude Code and Codex', () => {
  const draw = (tab) => renderToHtml(createElement(parts.BuildSheetBody, {
    tab, onTab() {}, onClose() {},
    homeroom: createElement('p', null, 'HOMEROOM-TAB'),
    handoff: createElement('p', null, 'HANDOFF-TAB'),
  }));
  const home = draw('homeroom');
  assert.match(home, />Build with<\/h2>/);
  assert.match(home, /role="tablist" aria-label="Build with"/);
  const tabs = [...home.matchAll(/<button type="button" role="tab" id="agent-session-build-tab-([a-z-]+)" aria-selected="(true|false)" aria-controls="agent-session-build-panel" tabindex="(0|-1)"[^>]*>([^<]+)<\/button>/g)]
    .map((m) => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(tabs, [
    ['homeroom', 'true', '0', 'Homeroom'],
    ['claude-code', 'false', '-1', 'Claude Code'],
    ['codex', 'false', '-1', 'Codex'],
  ], 'one tab in the Tab order: the selected one');
  assert.match(home, /role="tabpanel" id="agent-session-build-panel" aria-labelledby="agent-session-build-tab-homeroom"[^>]*>.*HOMEROOM-TAB/);
  assert.doesNotMatch(home, /HANDOFF-TAB/);

  const codex = draw('codex');
  assert.match(codex, /aria-selected="true" aria-controls="agent-session-build-panel" tabindex="0"[^>]*>Codex</);
  assert.match(codex, /aria-labelledby="agent-session-build-tab-codex"[^>]*>.*HANDOFF-TAB/);

  // Keyboard: the arrows, Home and End move the selection and the focus.
  const src = read('frontend/src/features/agent-session/composer-parts.tsx');
  assert.match(src, /event\.key === 'ArrowRight' \? \(at \+ 1\) % BUILD_TABS\.length/);
  assert.match(src, /event\.key === 'ArrowLeft' \? \(at \+ BUILD_TABS\.length - 1\) % BUILD_TABS\.length/);
  assert.match(src, /event\.key === 'Home' \? 0/);
  assert.match(src, /event\.key === 'End' \? BUILD_TABS\.length - 1/);
  assert.match(src, /aria-label="Build with"\s+className=\{desktop/, 'the sheet is named for what it is now');
});

test('#3078: the Homeroom tab says who builds it and lists the models once, under "Model"', () => {
  const body = renderToHtml(createElement(parts.ModelSheetBody, {
    options: parts.modelList([
      { value: 'openrouter:z-ai/glm-5', label: 'GLM 5', detail: 'about $0.42 for a typical change' },
      { value: 'anthropic:claude-sonnet-5-5', label: 'Sonnet 5.5' },
    ]),
    value: 'openrouter:z-ai/glm-5', onPick() {}, credit: null,
    effort: { value: '', options: [{ value: '', label: 'High', isDefault: true }], onPick() {} },
  }));
  assert.match(body, /^<div[^>]*><p[^>]*>The agent builds it here, on your Homeroom credits\.<\/p>/);
  assert.equal((body.match(/>Model<\/p>/g) || []).length, 1, 'one list');
  assert.doesNotMatch(body, />Claude Code<|>Codex</, 'no agent headings: those are the other tabs');
  assert.ok(body.indexOf('Sonnet 5.5') < body.indexOf('GLM 5'), 'Claude first, as before');
  assert.match(body, /about \$0\.42 for a typical change/, 'each model\'s cost line');
  assert.match(body, /data-agent-session-effort[^>]*>[\s\S]*?Thinking level[\s\S]*?High</, 'the thinking level row, as before');
});

test('#3078: a hand-off tab with nothing to hand over says so', () => {
  globalThis.window = { location: { hash: '', origin: 'https://h.example' }, addEventListener() {}, removeEventListener() {} };
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    const html = renderToHtml(createElement(api.HandoffPanel, { agent: 'claude-code', onClose() {} }));
    assert.match(html, /data-agent-session-handoff="claude-code"/);
    assert.match(html, /data-agent-session-handoff-empty[^>]*>There is nothing to hand over yet\./);
    assert.doesNotMatch(html, /—/, 'no em dash in the copy');
  } finally {
    delete globalThis.window;
  }
});
