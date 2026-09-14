'use strict';

// #1490: New change and Give feedback belong to Improve. The board's +
// retains its distinct actions on both desktop and touch, with the same gates.
//
// #1900 puts ONE of the two back: filing an issue. It had been folded into
// Improve's Give feedback, and people on the board could not find "create an
// issue" any more. The row opens the same dialog (App.openFeedbackModal, with
// the open app preselected), leads the first group, and is gated only on the
// writeable board — not on canCollaborate, which is import's gate. New change
// stays Improve's alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { decodeEntities } = require('./helpers/html-tokens');
const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const VIEW = read('public/js/app-view.js');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const PANEL = read('frontend/src/features/improve/improve-panel.tsx');
// The "+" menu moved out of the frame into its own row component, which the
// Board and the Workshop render one-at-a-time — so the menu's rows are
// rendered from there now. Same markup, same props, one level less chrome.
const { DevActionsRow } = loadTsx('frontend/src/features/dev-board/actions-row.tsx');
const BASE = {
  selfHosted: false, readOnly: false, canCollaborate: true, showsMembers: true,
  cardCls: '', cardHoverCls: '',
};
const board = (props = {}) => renderToHtml(createElement(DevActionsRow, { ...BASE, ...props }));
const actions = (html) => [...html.matchAll(/<button data-plus="([^"]+)"/g)].map((m) => m[1]);

test('the rendered + menu keeps only distinct actions, including app-management gates', () => {
  assert.deepEqual(actions(board()), ['issue', 'import-pr', 'members', 'rename', 'secrets', 'fork']);
  assert.deepEqual(actions(board({ showsMembers: false })), ['issue', 'import-pr', 'rename', 'secrets', 'fork']);
  const platform = board({ selfHosted: true });
  assert.deepEqual(actions(platform), ['issue', 'import-pr', 'members', 'rename', 'secrets']);
  assert.match(platform, /Proposal approvals/);
  assert.match(platform, /Platform variables/);
  assert.doesNotMatch(platform, /Members &amp; visibility/);
});

test('read-only viewers still get only Fork, and no + button on the platform app', () => {
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork']);
  const platform = board({ selfHosted: true, readOnly: true, canCollaborate: false });
  assert.deepEqual(actions(platform), []);
  assert.match(platform, /class="relative ml-auto hidden"><button id="dev-plus-btn"/);
});

test('hiding import leaves File an issue under the heading, so neither the heading nor the divider goes', () => {
  // #1490 gated the heading with the import row so that hiding the row could
  // not leave an empty heading. Since #1900 the group always holds File an
  // issue, so the heading is unconditional and the settings divider under it
  // is too — and import's own top border is what separates the two rows.
  const html = board({ canCollaborate: false });
  assert.deepEqual(actions(html), ['issue', 'members', 'rename', 'secrets', 'fork']);
  assert.match(html, /data-plus-group="build"[^>]*>Add to the board</);
  const settings = html.match(/<div data-plus-group="settings"[^>]*>/);
  assert.ok(settings);
  assert.match(settings[0], /border-t/);
  const withImport = board();
  const importRow = withImport.match(/<button data-plus="import-pr"[^>]*>/);
  assert.match(importRow[0], /border-t/, 'import separates itself from the issue row above it');
  const issueRow = withImport.match(/<button data-plus="issue"[^>]*>/);
  assert.doesNotMatch(issueRow[0], /border-t/, 'the first row of the group has no rule above it');
});

// Only the DOM operations _wirePlusMenu needs. The nodes and labels come
// from the real rendered component, not a second hard-coded menu fixture.
function clickTarget() {
  const node = new EventTarget();
  node.click = () => node.dispatchEvent(new Event('click'));
  return node;
}

function menuHarness(touch) {
  const text = (html) => decodeEntities(html.replace(/<[^>]+>/g, ''));
  const html = board();
  const nodes = [...html.matchAll(/<(button data-plus|div data-plus-group)="([^"]+)"[^>]*>([\s\S]*?)<\/(?:button|div)>/g)]
    .map(([, kind, key, body]) => {
      const node = clickTarget();
      node.key = key;
      node.isAction = kind === 'button data-plus';
      node.textContent = text(body);
      node.hasAttribute = (attr) => attr === 'data-plus' && node.isAction;
      const title = body.match(/<span data-plus-title="[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      node.querySelector = (selector) => {
        assert.equal(selector, '[data-plus-title]');
        assert.ok(title, `action ${key} has a marked title`);
        return { textContent: text(title[1]) };
      };
      return node;
    });
  const button = clickTarget();
  const attributes = {};
  button.setAttribute = (name, value) => { attributes[name] = value; };
  const classes = new Set(['hidden']);
  const menu = {
    classList: {
      add: (name) => classes.add(name),
      toggle: (name) => {
        if (classes.delete(name)) return false;
        classes.add(name);
        return true;
      },
    },
    querySelectorAll: (selector) => {
      assert.equal(selector, 'button[data-plus], [data-plus-group]');
      return nodes;
    },
    querySelector: (selector) => {
      const key = selector.match(/^\[data-plus="([^"]+)"\]$/)?.[1];
      assert.ok(key, `supported row selector: ${selector}`);
      return nodes.find((node) => node.isAction && node.key === key) || null;
    },
  };
  const calls = [];
  const sheets = [];
  const sandbox = {
    console, AbortController,
    addEventListener() {},
    document: { getElementById: (id) => ({ 'dev-plus-btn': button, 'dev-plus-menu': menu })[id] || null },
    PlatformUI: { isTouch: () => touch, actionSheet: (sheet) => sheets.push(sheet) },
    Secrets: { openForCurrentApp: () => calls.push('secrets') },
    // The issue row opens the shared feedback dialog by name, in its
    // dev-context mode (#226) — the same call Improve.giveFeedback() makes.
    // Field-by-field: the options object is the vm realm's.
    App: {
      openFeedbackModal: (opts) => {
        assert.equal(opts?.fromDev, true, 'the open app is preselected as the target');
        assert.deepEqual(Object.keys(opts), ['fromDev']);
        calls.push('issue');
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW, sandbox);
  const { AppView } = sandbox;
  AppView.refreshDevChatSecretsState = () => {};
  for (const [method, action] of Object.entries({
    openImportPrModal: 'import-pr', openMembersModal: 'members',
    promptRename: 'rename', promptFork: 'fork',
  })) AppView[method] = () => calls.push(action);
  const content = clickTarget();
  AppView._wirePlusMenu(content);
  AppView._wirePlusMenu(content); // Re-render wiring must not double dispatch.
  return { button, nodes, classes, attributes, calls, sheets };
}

for (const touch of [false, true]) {
  test(`${touch ? 'touch sheet' : 'desktop dropdown'} dispatches each remaining action once`, () => {
    const h = menuHarness(touch);
    const expected = ['issue', 'import-pr', 'members', 'rename', 'secrets', 'fork'];
    for (const [index, action] of expected.entries()) {
      h.button.click();
      if (touch) {
        assert.equal(h.sheets.length, index + 1, 'one sheet per click after re-wiring');
        const sheet = h.sheets.at(-1);
        assert.deepEqual(Array.from(sheet.actions, (item) => item.label), [
          'Add to the board', 'File an issue', 'Import Feature from a PR', 'Settings & rules',
          'Members & visibility', 'App display name', 'App secrets', 'Fork this app',
        ]);
        assert.ok(h.classes.has('hidden'), 'touch never opens the desktop dropdown');
        sheet.actions.filter((item) => !item.heading)[index].handler();
      } else {
        assert.equal(h.attributes['aria-expanded'], 'true');
        assert.equal(h.classes.has('hidden'), false);
        h.nodes.find((node) => node.key === action).click();
        assert.equal(h.sheets.length, 0);
      }
      assert.deepEqual(h.calls, expected.slice(0, index + 1));
      assert.equal(h.attributes['aria-expanded'], 'false');
      assert.ok(h.classes.has('hidden'), 'the action closes the menu');
    }
  });
}

test('Improve retains one wired quick action per feature and the New change read-only gate', () => {
  for (const [id, label, handler] of [
    ['feedback', 'Give feedback', 'giveFeedback'],
    ['new-session', 'New change', 'startSession'],
  ]) {
    assert.equal(PANEL.split(`id="improve-row-${id}"`).length - 1, 1);
    assert.match(PANEL, new RegExp(`id="improve-row-${id}"\\s+label="${label}"\\s+onClick=\\{\\(\\) => Improve\\.${handler}\\(\\)\\}`));
  }
  assert.match(PANEL, /state\.readOnly \? null : \(\s*<QuickAction\s+id="improve-row-new-session"/);
  assert.doesNotMatch(VIEW, /querySelector\('\[data-plus="proposal"\]'\)/);
});

// ── #1900: File an issue is on the board again ───────────────────────────

test('File an issue is a real button[data-plus] row that leads the writeable menu', () => {
  const html = board();
  const row = html.match(/<button data-plus="issue"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(row, 'the row exists');
  // A <button>, so _wirePlusMenu's `button[data-plus]` walk hands it to the
  // touch action sheet as a tappable row — and the sheet reads its title by
  // name, which is what the marked span is for.
  assert.match(row[0], /<span data-plus-title="[^"]*"[^>]*>File an issue<\/span>/);
  assert.match(row[0], /Report a problem or idea without building it yourself/);
  assert.match(row[0], /<svg\b[^>]*aria-hidden="true"/, 'a glyph, decorative like the others');
  // It needs nothing of the viewer beyond a writeable board: present without
  // the collaborator bit, absent for the read-only viewer, who keeps Fork —
  // and on the platform app no "+" at all, as before.
  assert.equal(actions(html)[0], 'issue', 'it leads the menu');
  assert.equal(actions(board({ canCollaborate: false }))[0], 'issue');
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork']);
  assert.deepEqual(actions(board({ selfHosted: true, readOnly: true, canCollaborate: false })), []);
  // Nothing outside React lifts the dialog for it: the row is wired by the
  // same delegated handler as every other action, which opens the dialog by
  // its published name.
  assert.match(VIEW, /const issueBtn = menu\.querySelector\('\[data-plus="issue"\]'\);/);
  const wired = VIEW.slice(VIEW.indexOf('const issueBtn = '));
  assert.match(wired.slice(0, 700), /App\.openFeedbackModal\(\{ fromDev: true \}\)/);
});

for (const touch of [false, true]) {
  test(`${touch ? 'the touch sheet' : 'the desktop dropdown'} routes File an issue to the feedback dialog, once, and closes`, () => {
    const h = menuHarness(touch);
    h.button.click();
    if (touch) {
      const sheet = h.sheets.at(-1);
      const item = sheet.actions.find((entry) => entry.label === 'File an issue');
      assert.ok(item && !item.heading, 'the sheet carries it as an action, not a heading');
      item.handler();
    } else {
      h.nodes.find((node) => node.key === 'issue').click();
    }
    assert.deepEqual(h.calls, ['issue']);
    assert.equal(h.attributes['aria-expanded'], 'false');
    assert.ok(h.classes.has('hidden'), 'the action closes the menu');
  });
}

function improveHarness(currentApp = 'demo') {
  const calls = [];
  const store = makeStoreStub({ slug: 'demo' });
  const sandbox = {
    console, Promise,
    App: {
      currentApp,
      openFeedbackModal: (options) => calls.push(['feedback', options?.fromDev]),
      switchTab: async (...args) => calls.push(['switch', ...args]),
      navigateToApp: async (...args) => {
        calls.push(['navigate', ...args]);
        sandbox.App.currentApp = args[0];
      },
    },
    AppView: { createProposal: () => calls.push(['new-change', sandbox.App.currentApp]) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor() {} },
      '../../lib/kit-surface': { adoptKitSurface: () => null },
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.Improve = Improve;',
  });
  sandbox.Improve.close = () => calls.push(['close']);
  // startSession deliberately fires routing without returning its promise.
  // Capture that real promise so assertions wait for cross-realm async work.
  let navigation;
  const withApp = sandbox.Improve._withApp;
  sandbox.Improve._withApp = (...args) => (navigation = withApp(...args));
  return { Improve: sandbox.Improve, App: sandbox.App, calls, get navigation() { return navigation; } };
}

test('Give feedback still opens the shared dialog for the current app', () => {
  const { Improve, calls } = improveHarness();
  Improve.giveFeedback();
  assert.deepEqual(calls, [['close'], ['feedback', true]]);
});

for (const currentApp of ['demo', 'other']) {
  test(`New change starts one session on the target app from ${currentApp}`, async () => {
    const h = improveHarness(currentApp);
    const { Improve, calls } = h;
    Improve.startSession();
    await h.navigation;
    assert.deepEqual(calls, [
      ['close'],
      currentApp === 'demo' ? ['switch', 'dev', null, 'forum'] : ['navigate', 'demo', 'dev', null, 'forum'],
      ['new-change', 'demo'],
    ]);
  });
}

test('New change does not create a session if the viewer navigates away first', async () => {
  const h = improveHarness();
  const { Improve, App, calls } = h;
  let finishRoute;
  App.switchTab = () => new Promise((resolve) => { finishRoute = resolve; });
  Improve.startSession();
  assert.deepEqual(calls, [['close']]);
  App.currentApp = 'other';
  finishRoute();
  await h.navigation;
  assert.deepEqual(calls, [['close']]);
});
