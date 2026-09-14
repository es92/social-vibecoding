'use strict';

// The closed VENUE vocabulary.
//
// Before this test the product had two different things called "Claude
// Code" — the platform backend (chat_sessions.agent_backend='claude_code')
// and the web hand-off (users.dev_flow_preference='claude-code') — offered
// in menus inches apart, plus a third `claude-code` as an external_agent
// provenance value. Choosing one when you meant the other cost real money
// on the wrong plan, and nothing in the codebase stopped the two labels
// converging again.
//
// So the label set is pinned here, in ONE place, across every module that
// owns a copy of it. Renaming a venue means editing this list on purpose.
// Note what is NOT asserted: the ids. `claude_code`, `claude-code`,
// `codex_openrouter` and friends are persisted values and stay exactly as
// they are — this is a copy change, not a schema change.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const registry = require('../src/agents/registry');

// The six venues, in group order: three that build in this chat, three that
// build somewhere else. Kept in sync with public/js/build-venues.js VENUES.
const VENUE_LABELS = {
  'usernode-claude': 'Homeroom · Claude',
  'usernode-openrouter': 'Homeroom · OpenRouter',
  local: 'Your computer · Homeroom session',
  'web-claude-code': 'Claude Code on the web',
  'web-codex': 'Codex on the web',
  'own-tools-pr': 'Your computer · your own tools',
};

// Labels that must NOT come back. Each one was ambiguous about WHERE the
// work happens, which is the whole failure this vocabulary fixes.
const RETIRED_LABELS = [
  'Claude Code (OpenRouter BYOK)',
  'Codex (OpenRouter BYOK)',
  'Codex via OpenRouter',
  'Build it here on Homeroom',
  'Build it with Claude Code',
  'Build it with Codex',
  'Carry on in Claude Code',
  'Carry on in Codex',
  'Use a coding tool on your computer',
  'Run this session on your computer',
];

// Load a public/js module the way the browser does — as a classic script
// against a bare `window` — rather than through require(). That is the
// environment the drift happens in, and it is the one where a module that
// reads window.BuildVenues has to find it. build-venues.js is evaluated
// into the same sandbox first, in the same order the shell loads it
// (tests/shell-script-order.test.js pins that order for real).
function loadBrowserModule(relPath, globalName) {
  const sandbox = { window: {}, module: { exports: {} }, document: undefined };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  for (const dep of ['public/js/build-venues.js', relPath]) {
    const src = fs.readFileSync(path.join(__dirname, '..', dep), 'utf8');
    sandbox.module = { exports: {} };
    vm.runInContext(src, sandbox, { filename: dep });
  }
  return sandbox.window[globalName] || sandbox.module.exports;
}

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('venue labels');

run('the backend registry uses the two in-chat venue labels', () => {
  assert.strictEqual(registry.BACKENDS.claude_code.label, VENUE_LABELS['usernode-claude']);
  assert.strictEqual(registry.BACKENDS.codex_openrouter.label, VENUE_LABELS['usernode-openrouter']);
  // Ids unchanged — the persisted values must not move with the copy.
  assert.strictEqual(registry.BACKENDS.claude_code.id, 'claude_code');
  assert.strictEqual(registry.BACKENDS.codex_openrouter.id, 'codex_openrouter');
});

run('build-venues.js is the single list and matches this vocabulary', () => {
  const BuildVenues = loadBrowserModule('public/js/build-venues.js', 'BuildVenues');
  const byId = new Map(BuildVenues.VENUES.map((v) => [v.id, v]));
  assert.strictEqual(byId.size, 6, 'expected exactly six venues');
  for (const [id, label] of Object.entries(VENUE_LABELS)) {
    assert.ok(byId.has(id), `missing venue ${id}`);
    assert.strictEqual(byId.get(id).label, label, `venue ${id} label drifted`);
  }
});

run('dev-flow-select titles are the three venues it owns', () => {
  const DevFlowSelect = loadBrowserModule('public/js/dev-flow-select.js', 'DevFlowSelect');
  // Array.from: FLOWS is built inside the vm realm, so its Array has a
  // different prototype and deepStrictEqual refuses it on identity alone.
  const titles = Array.from(DevFlowSelect.FLOWS.map((f) => f.title));
  assert.deepStrictEqual(titles, [
    VENUE_LABELS['usernode-claude'],
    VENUE_LABELS['web-claude-code'],
    VENUE_LABELS['web-codex'],
  ]);
});

run('credit-options offers the local pair as two distinct venues', () => {
  const CreditOptions = loadBrowserModule('public/js/credit-options.js', 'CreditOptions');
  // sessionBridgeEnabled since #1281: the CLI-lease venue is opt-in now, so
  // the flag has to be on for it to be in any list at all. What this test
  // pins is unchanged — that the two "on your computer" answers are two
  // distinct venues with the shared vocabulary's names, not one row saying
  // "use a coding tool on your computer" about both.
  const titles = CreditOptions.options({
    externalFlowsAvailable: true, sessionBridgeEnabled: true,
  }).map((o) => o.title);
  assert.ok(titles.includes(VENUE_LABELS.local), 'missing the CLI-lease venue');
  assert.ok(titles.includes(VENUE_LABELS['own-tools-pr']), 'missing the own-tools/PR venue');
  assert.ok(titles.includes(VENUE_LABELS['web-claude-code']));
  assert.ok(titles.includes(VENUE_LABELS['web-codex']));
  // Both local venues survive the no-external-flows deployment too.
  const offline = CreditOptions.options({
    externalFlowsAvailable: false, sessionBridgeEnabled: true,
  }).map((o) => o.title);
  assert.ok(offline.includes(VENUE_LABELS.local));
  assert.ok(offline.includes(VENUE_LABELS['own-tools-pr']));
});

run('session-options states no venue name of its own', () => {
  // The "⋯" menu used to enumerate the routes itself, one row per tool,
  // which is one of the two places the two "Claude Code"s were offered
  // inches apart. It carried a single door to the shared list after #1086,
  // and #1353 removed the button and the menu with it — what is left of the
  // module is the local-CLI card. So the guard is that the file names no
  // venue at all now: the card describes a lease, and the venue vocabulary
  // is build-venues.js's alone.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/session-options.js'), 'utf8');
  const code = stripComments(SRC);
  for (const label of Object.values(VENUE_LABELS)) {
    assert.ok(
      !code.includes(label),
      `session-options re-states the venue label ${label} instead of deferring to build-venues.js`,
    );
  }
});

// A retired label may legitimately appear inside a comment that EXPLAINS
// the rename — that is documentation, not a shipped string. Strip comments
// first so the guard looks only at code. Crude but sufficient: these are
// plain ES5 modules with no regex literals containing `//`.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

run('no retired label survives in any copy-owning module', () => {
  const files = [
    'src/agents/registry.js',
    'public/js/build-venues.js',
    'public/js/dev-flow-select.js',
    'public/js/credit-options.js',
    'public/js/session-options.js',
    'frontend/src/features/dev-chat/dev-chat.js',
  ];
  for (const rel of files) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    for (const retired of RETIRED_LABELS) {
      const quoted = [`'${retired}'`, `"${retired}"`, `\`${retired}\``];
      for (const needle of quoted) {
        assert.ok(
          !src.includes(needle),
          `${rel} still ships the retired label ${needle}`,
        );
      }
    }
  }
});
