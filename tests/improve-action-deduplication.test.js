'use strict';

// #1490: New change and Give feedback belong to Improve. The board's +
// retains its distinct actions on both desktop and touch, with the same gates.
//
// #1900 puts ONE of the two back: filing an issue. It had been folded into
// Improve's Give feedback, and people on the board could not find "create an
// issue" any more. The row opens the same dialog (App.openFeedbackModal, with
// the open app preselected), leads the first group, and is gated only on the
// writeable board — not on canCollaborate, which is import's gate. New change
// stayed Improve's alone until #852's review, which moved "Start a new change"
// off the foot of the hub and into the hub's ⋯, leading it (the Homeroom
// menu keeps its row): the same method, Improve.startSession, from both.
const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { decodeEntities } = require('./helpers/html-tokens');
const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const VIEW = read('public/js/app-view.js');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const PANEL = read('frontend/src/features/improve/actions.tsx');
// The "+" menu moved out of the frame into its own row component, which the
// Board and the Workshop render one-at-a-time — so the menu's rows are
// rendered from there now. Same markup, same props, one level less chrome.
const { DevActionsRow, DevPlusMenu } = loadTsx('frontend/src/features/dev-board/actions-row.tsx');
const BASE = {
  selfHosted: false, readOnly: false, canCollaborate: true, showsMembers: true,
  cardCls: '', cardHoverCls: '',
};
const board = (props = {}) => renderToHtml(createElement(DevActionsRow, { ...BASE, ...props }));
const actions = (html) => [...html.matchAll(/<button data-plus="([^"]+)"/g)].map((m) => m[1]);

test('the rendered + menu keeps only distinct actions, including app-management gates', () => {
  // B8: Suggest an improvement leads; Build it now is second.
  // #4045: "Settings & rules" is one row, its settings in the panel under it.
  assert.deepEqual(actions(board()), ['issue', 'new-change', 'import-pr', 'settings', 'members', 'rename', 'topics', 'secrets', 'fork']);
  assert.deepEqual(actions(board({ showsMembers: false })), ['issue', 'new-change', 'import-pr', 'settings', 'rename', 'topics', 'secrets', 'fork']);
  const platform = board({ selfHosted: true });
  assert.deepEqual(actions(platform), ['issue', 'new-change', 'import-pr', 'settings', 'members', 'rename', 'topics', 'secrets']);
  assert.match(platform, /Proposal approvals/);
  assert.match(platform, /Platform variables/);
  assert.doesNotMatch(platform, /Members &amp; visibility/);
});

test('read-only viewers still get only Fork, and no + button on the platform app', () => {
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork']);
  const platform = board({ selfHosted: true, readOnly: true, canCollaborate: false });
  assert.deepEqual(actions(platform), []);
  // The wrapper is `.dev-ws-plus` now — the "+" closes the Workshop's tab
  // strip, and app.css positions it there — and it is still hidden outright.
  assert.match(platform, /class="dev-ws-plus hidden"><button id="dev-plus-btn"/);
  // The same component is what the Workshop's strip renders, so the gate
  // holds there too, not only in the Board's row.
  const strip = renderToHtml(createElement(DevPlusMenu, {
    ...BASE, selfHosted: true, readOnly: true, canCollaborate: false,
  }));
  assert.match(strip, /^<div class="dev-ws-plus hidden"><button id="dev-plus-btn"/);
  assert.deepEqual(actions(strip), []);
});

test('hiding import leaves Suggest an improvement first, so the settings divider under it stays', () => {
  // #1490 gated the heading with the import row so that hiding the row could
  // not leave an empty heading. Since #1900 the group always holds the ask
  // row, so the settings divider under it is unconditional — and import's
  // own top border is what separates the two rows. The first group has no
  // heading any more: it is the menu's first, and "Settings & rules" says
  // where the rest begins.
  const html = board({ canCollaborate: false });
  // #4045: "Settings & rules" is one row now, its settings in a panel under it.
  assert.deepEqual(actions(html), ['issue', 'new-change', 'settings', 'members', 'rename', 'topics', 'secrets', 'fork']);
  assert.doesNotMatch(html, /data-plus-group="build"/);
  assert.doesNotMatch(html, /Add to the board/);
  const settings = html.match(/<button data-plus="settings" data-plus-group="settings"[^>]*>/);
  assert.ok(settings);
  assert.match(settings[0], /border-t/);
  const withImport = board();
  const importRow = withImport.match(/<button data-plus="import-pr"[^>]*>/);
  assert.match(importRow[0], /border-t/, 'import separates itself from the issue row above it');
  const firstRow = withImport.match(/<button data-plus="new-change"[^>]*>/);
  assert.doesNotMatch(firstRow[0], /border-t/, 'the first row of the group has no rule above it');
  const issueRow = withImport.match(/<button data-plus="issue"[^>]*>/);
  assert.doesNotMatch(issueRow[0], /border-t/, 'nor does Suggest an improvement, under it');
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
      // #1930: the touch sheet also borrows the row's glyph. A stand-in svg
      // that records what the sheet did to its copy — the clone must come
      // away without the Tailwind sizing classes.
      const hasGlyph = /<svg[\s>]/.test(body);
      node.querySelector = (selector) => {
        if (selector === 'svg') {
          if (!hasGlyph) return null;
          return {
            cloneNode: (deep) => {
              assert.equal(deep, true, 'the glyph is cloned deep, paths and all');
              const clone = { glyphOf: key, classRemoved: false };
              clone.removeAttribute = (name) => { if (name === 'class') clone.classRemoved = true; };
              return clone;
            },
          };
        }
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
    document: {
      getElementById: (id) => ({ 'dev-plus-btn': button, 'dev-plus-menu': menu })[id] || null,
      // QA 2026-09-24 Q18: _wirePlusMenu now binds its outside-click and
      // keyboard (Escape, arrows) dismissers on the document rather than on
      // the content node. Neither is exercised here; the clicks below are.
      addEventListener() {},
    },
    PlatformUI: { isTouch: () => touch, actionSheet: (sheet) => sheets.push(sheet) },
    Secrets: { openForCurrentApp: () => calls.push('secrets') },
    // The issue row opens the shared feedback dialog by name, in its
    // dev-context mode (#226) — the same call Improve.giveFeedback() makes.
    // Field-by-field: the options object is the vm realm's.
    App: {
      openFeedbackModal: (opts) => {
        assert.equal(opts?.fromDev, true, 'the dev-context mode');
        // #4236: no `target`, so "Where should this go?" opens with nothing
        // chosen; only `target: 'app'` preselects since #2707.
        assert.equal(opts?.target, undefined, 'no destination is preselected');
        // QA 2026-09-24: and the dialog is told what it was asked for, so it
        // is headed "Suggest an improvement" rather than "Send feedback".
        assert.equal(opts?.intent, 'issue', 'the dialog is headed with the row\'s own words');
        assert.deepEqual(Object.keys(opts), ['fromDev', 'intent']);
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
          'Suggest an improvement', 'Build it now', 'Import Feature from a PR', 'Settings & rules',
          'Members & approvals', 'App display name', 'Topics', 'App secrets', 'Make your own',
        ]);
        // #1930: every action row carries its own glyph, class-stripped.
        for (const item of sheet.actions.filter((a) => !a.heading)) {
          assert.ok(item.iconEl, `${item.label} carries its row's icon`);
          assert.equal(item.iconEl.classRemoved, true, `${item.label}'s icon drops its Tailwind classes`);
        }
        assert.ok(h.classes.has('hidden'), 'touch never opens the desktop dropdown');
        // Build it now is React's own onClick (the sheet's handler
        // clicks the row), so _wirePlusMenu dispatches the rest.
        // "Settings & rules" opens the settings as a sheet of their own
        // (#4045); this harness has no panel, so its rows stay on this one.
        // #4417: Topics is React's own onClick too, like Build it now.
        sheet.actions.filter((item) => !item.heading && !['Build it now', 'Settings & rules', 'Topics'].includes(item.label))[index].handler();
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

test('Suggest an improvement and Start a new change each exist once, and the read-only gate holds', () => {
  // ONE BUTTON AND ONE ROW (UI overhaul). The menu's well held two buttons,
  // Give feedback and New change, and people found both confusing. The
  // button is Suggest an improvement now (the same dialog). New change —
  // "Build it now" — left the menu with its Agent chats section (#4729); it
  // opens a new chat with Homeroom bot about the project.
  //
  // WHAT THIS FILE IS ABOUT is unchanged: each action exists ONCE and calls
  // ONE method, whichever surface it is on.
  const MENU = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.equal(PANEL.split('id="improve-row-feedback"').length - 1, 1, 'the button is here');
  assert.match(PANEL, /id="improve-row-feedback"\s+label=\{t\('agent:menu\.suggestImprovement'\)\}\s+onClick=\{\(\) => Improve\.giveFeedback\(\)\}/);
  assert.equal(message('agent:menu.suggestImprovement'), 'Suggest an improvement');
  assert.equal(PANEL.split('id="improve-row-new-session"').length - 1, 0, 'and it is alone in its well');
  assert.equal(MENU.split('id="improve-row-feedback"').length - 1, 0,
    'and not in two places — that id is what the outbox dot\'s writer selects');
  assert.ok(!MENU.includes('giveFeedback'),
    'the menu does not keep a second caller of the same method');
  assert.equal(MENU.split('id="improve-row-new-session"').length - 1, 0,
    'and the menu carries no start-a-change row any more (#4729)');
  // #852 review: the hub's ⋯ leads with it too, calling the same method, and
  // only on a writeable board (it is inside the menu's readOnly gate).
  const ROW = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.equal(ROW.split('data-plus="new-change"').length - 1, 1, 'one row in the ⋯');
  assert.match(ROW, /data-plus="new-change"[\s\S]{0,300}onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); void Improve\.startSession\(\); \}\}/);
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork'], 'and not for a read-only viewer');
  assert.doesNotMatch(VIEW, /querySelector\('\[data-plus="proposal"\]'\)/);
});

// ── #1900: asking for a change is on the board again ─────────────────────

test('Suggest an improvement is a real button[data-plus] row that leads the writeable menu', () => {
  const html = board();
  const row = html.match(/<button data-plus="issue"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(row, 'the row exists');
  // A <button>, so _wirePlusMenu's `button[data-plus]` walk hands it to the
  // touch action sheet as a tappable row — and the sheet reads its title by
  // name, which is what the marked span is for.
  assert.match(row[0], /<span data-plus-title="[^"]*"[^>]*>Suggest an improvement<\/span>/);
  assert.match(row[0], /Report a problem or idea without building it yourself/);
  assert.match(row[0], /<svg\b[^>]*aria-hidden="true"/, 'a glyph, decorative like the others');
  // It needs nothing of the viewer beyond a writeable board: present without
  // the collaborator bit, absent for the read-only viewer, who keeps Fork —
  // and on the platform app no "+" at all, as before.
  // B8: first, with Build it now under it, and ahead of the rest.
  assert.deepEqual(actions(html).slice(0, 2), ['issue', 'new-change'], 'it leads, Build it now second');
  assert.deepEqual(actions(board({ canCollaborate: false })).slice(0, 2), ['issue', 'new-change']);
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork']);
  assert.deepEqual(actions(board({ selfHosted: true, readOnly: true, canCollaborate: false })), []);
  // Nothing outside React lifts the dialog for it: the row is wired by the
  // same delegated handler as every other action, which opens the dialog by
  // its published name.
  assert.match(VIEW, /const issueBtn = menu\.querySelector\('\[data-plus="issue"\]'\);/);
  const wired = VIEW.slice(VIEW.indexOf('const issueBtn = '));
  // QA 2026-09-24: with `intent: 'issue'`, so the dialog is headed with the
  // row's own words ("Suggest an improvement") rather than "Send feedback".
  // #4236: and with no `target`, so the dialog asks where it goes with
  // neither destination chosen (#2707).
  assert.match(wired.slice(0, 700), /App\.openFeedbackModal\(\{ fromDev: true, intent: 'issue' \}\)/);
});

for (const touch of [false, true]) {
  test(`${touch ? 'the touch sheet' : 'the desktop dropdown'} routes Suggest an improvement to the feedback dialog, once, and closes`, () => {
    const h = menuHarness(touch);
    h.button.click();
    if (touch) {
      const sheet = h.sheets.at(-1);
      const item = sheet.actions.find((entry) => entry.label === 'Suggest an improvement');
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
      openFeedbackModal: (options) => calls.push(['feedback', options?.fromDev, options?.target]),
      switchTab: async (...args) => calls.push(['switch', ...args]),
      navigateToApp: async (...args) => {
        calls.push(['navigate', ...args]);
        sandbox.App.currentApp = args[0];
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // THE CONTROLLER PRESENTS NOTHING NOW (#2718 review): `open()` forwards to
  // the app-context sheet. Nor does it list sessions (16 Nov 2026), so it no
  // longer imports the words, the icons or the bell's open flag the list
  // needed: the store and the shell snapshot are all it reads.
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
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
  return { Improve: sandbox.Improve, App: sandbox.App, sandbox, calls, get navigation() { return navigation; } };
}

test('Give feedback still opens the shared dialog for the current app', async () => {
  const { Improve, calls } = improveHarness();
  await Improve.giveFeedback();
  // #4236: `fromDev` with no `target`, so the dialog asks where it goes
  // with neither destination chosen (#2707). Only a button that names the
  // app (`target: 'app'`) preselects it.
  assert.deepEqual(calls, [['close'], ['feedback', true, undefined]]);
});

test('#21: from another app Give feedback names no target: there is no open app for "This app" to mean', async () => {
  const { Improve, calls } = improveHarness('other');
  await Improve.giveFeedback();
  assert.deepEqual(calls, [['close'], ['feedback', undefined, undefined]]);
});

// #4730: the dialog's comment shortcut draws the page as it opens, so the
// menu must be gone from the screen before the open, not merely told to
// close. The other dialog rows (share, terminal) already wait this way.
test('#4730: Give feedback waits for the menu to be gone before opening the dialog', async () => {
  const { Improve, calls } = improveHarness();
  let release;
  Improve.close = () => new Promise((resolve) => { release = resolve; });
  const settled = Improve.giveFeedback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [], 'the dialog does not open while the menu is still leaving');
  release();
  await settled;
  assert.deepEqual(calls, [['feedback', true, undefined]]);
});

// #2770 sent New change straight to the app's classic unsent-change screen
// (/dev/sessions/new). Agent chats and dev chats are retired: it opens a new
// chat with Homeroom bot about the target app, whichever app is open, where
// the builder is chosen, and creates nothing itself.
for (const currentApp of ['demo', 'other']) {
  test(`New change opens a new chat with Homeroom bot about the target app from ${currentApp}`, () => {
    const h = improveHarness(currentApp);
    const { Improve, calls } = h;
    h.sandbox.location = { hash: '' };
    Improve.startSession();
    assert.equal(h.sandbox.location.hash, '#homeroom-bot/new?project=demo');
    assert.deepEqual(calls, [['close']], 'no board, no classic screen, and nothing is created by the click');
  });
}
