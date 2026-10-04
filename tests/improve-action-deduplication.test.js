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
  // B8: Ask for a change leads; Build it yourself is second.
  assert.deepEqual(actions(board()), ['issue', 'new-change', 'import-pr', 'members', 'rename', 'secrets', 'fork']);
  assert.deepEqual(actions(board({ showsMembers: false })), ['issue', 'new-change', 'import-pr', 'rename', 'secrets', 'fork']);
  const platform = board({ selfHosted: true });
  assert.deepEqual(actions(platform), ['issue', 'new-change', 'import-pr', 'members', 'rename', 'secrets']);
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

test('hiding import leaves Ask for a change first, so the settings divider under it stays', () => {
  // #1490 gated the heading with the import row so that hiding the row could
  // not leave an empty heading. Since #1900 the group always holds the ask
  // row, so the settings divider under it is unconditional — and import's
  // own top border is what separates the two rows. The first group has no
  // heading any more: it is the menu's first, and "Settings & rules" says
  // where the rest begins.
  const html = board({ canCollaborate: false });
  assert.deepEqual(actions(html), ['issue', 'new-change', 'members', 'rename', 'secrets', 'fork']);
  assert.doesNotMatch(html, /data-plus-group="build"/);
  assert.doesNotMatch(html, /Add to the board/);
  const settings = html.match(/<div data-plus-group="settings"[^>]*>/);
  assert.ok(settings);
  assert.match(settings[0], /border-t/);
  const withImport = board();
  const importRow = withImport.match(/<button data-plus="import-pr"[^>]*>/);
  assert.match(importRow[0], /border-t/, 'import separates itself from the issue row above it');
  const firstRow = withImport.match(/<button data-plus="new-change"[^>]*>/);
  assert.doesNotMatch(firstRow[0], /border-t/, 'the first row of the group has no rule above it');
  const issueRow = withImport.match(/<button data-plus="issue"[^>]*>/);
  assert.doesNotMatch(issueRow[0], /border-t/, 'nor does Ask for a change, under it');
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
        // #21: `target: 'app'` is what preselects the open app since #2707.
        assert.equal(opts?.target, 'app', 'the open app is preselected as the target');
        // QA 2026-09-24: and the dialog is told what it was asked for, so it
        // is headed "Ask for a change" rather than "Send feedback".
        assert.equal(opts?.intent, 'issue', 'the dialog is headed with the row\'s own words');
        assert.deepEqual(Object.keys(opts), ['fromDev', 'target', 'intent']);
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
          'Ask for a change', 'Build it yourself', 'Import Feature from a PR', 'Settings & rules',
          'Members & approvals', 'App display name', 'App secrets', 'Fork this app',
        ]);
        // #1930: every action row carries its own glyph, class-stripped.
        for (const item of sheet.actions.filter((a) => !a.heading)) {
          assert.ok(item.iconEl, `${item.label} carries its row's icon`);
          assert.equal(item.iconEl.classRemoved, true, `${item.label}'s icon drops its Tailwind classes`);
        }
        assert.ok(h.classes.has('hidden'), 'touch never opens the desktop dropdown');
        // Build it yourself is React's own onClick (the sheet's handler
        // clicks the row), so _wirePlusMenu dispatches the rest.
        sheet.actions.filter((item) => !item.heading && item.label !== 'Build it yourself')[index].handler();
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

test('Ask for a change and Start a new change each exist once, and the read-only gate holds', () => {
  // ONE BUTTON AND ONE ROW (UI overhaul). The menu's well held two buttons,
  // Give feedback and New change, and people found both confusing. The
  // button is Ask for a change now (the same dialog), and New change is
  // "Start a new change" under Agent sessions in the menu's list, because
  // what it opens is an agent session.
  //
  // WHAT THIS FILE IS ABOUT is unchanged: each action exists ONCE and calls
  // ONE method, whichever surface it is on.
  const MENU = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.equal(PANEL.split('id="improve-row-feedback"').length - 1, 1, 'the button is here');
  assert.match(PANEL, /id="improve-row-feedback"\s+label="Ask for a change"\s+onClick=\{\(\) => Improve\.giveFeedback\(\)\}/);
  assert.equal(PANEL.split('id="improve-row-new-session"').length - 1, 0, 'and it is alone in its well');
  assert.equal(MENU.split('id="improve-row-feedback"').length - 1, 0,
    'and not in two places — that id is what the outbox dot\'s writer selects');
  assert.ok(!MENU.includes('giveFeedback'),
    'the menu does not keep a second caller of the same method');
  assert.equal(MENU.split('id="improve-row-new-session"').length - 1, 1);
  // B8: the row is Build it yourself, beside Ask for a change going to Homeroom bot.
  assert.match(MENU, /id="improve-row-new-session"[\s\S]{0,160}onClick=\{\(\) => Improve\.startSession\(\)\}[\s\S]{0,480}label="Build it yourself"/);
  // A read-only viewer may not start a change, as the button's gate was.
  assert.match(MENU, /\{readOnly \? null : \(\s*<button\s+id="improve-row-new-session"/);
  // #852 review: the hub's ⋯ leads with it too, calling the same method, and
  // only on a writeable board (it is inside the menu's readOnly gate).
  const ROW = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.equal(ROW.split('data-plus="new-change"').length - 1, 1, 'one row in the ⋯');
  assert.match(ROW, /data-plus="new-change"[\s\S]{0,300}onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); void Improve\.startSession\(\); \}\}/);
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork'], 'and not for a read-only viewer');
  assert.doesNotMatch(VIEW, /querySelector\('\[data-plus="proposal"\]'\)/);
});

// ── #1900: asking for a change is on the board again ─────────────────────

test('Ask for a change is a real button[data-plus] row that leads the writeable menu', () => {
  const html = board();
  const row = html.match(/<button data-plus="issue"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(row, 'the row exists');
  // A <button>, so _wirePlusMenu's `button[data-plus]` walk hands it to the
  // touch action sheet as a tappable row — and the sheet reads its title by
  // name, which is what the marked span is for.
  assert.match(row[0], /<span data-plus-title="[^"]*"[^>]*>Ask for a change<\/span>/);
  assert.match(row[0], /Report a problem or idea without building it yourself/);
  assert.match(row[0], /<svg\b[^>]*aria-hidden="true"/, 'a glyph, decorative like the others');
  // It needs nothing of the viewer beyond a writeable board: present without
  // the collaborator bit, absent for the read-only viewer, who keeps Fork —
  // and on the platform app no "+" at all, as before.
  // B8: first, with Build it yourself under it, and ahead of the rest.
  assert.deepEqual(actions(html).slice(0, 2), ['issue', 'new-change'], 'it leads, Build it yourself second');
  assert.deepEqual(actions(board({ canCollaborate: false })).slice(0, 2), ['issue', 'new-change']);
  assert.deepEqual(actions(board({ readOnly: true, canCollaborate: false })), ['fork']);
  assert.deepEqual(actions(board({ selfHosted: true, readOnly: true, canCollaborate: false })), []);
  // Nothing outside React lifts the dialog for it: the row is wired by the
  // same delegated handler as every other action, which opens the dialog by
  // its published name.
  assert.match(VIEW, /const issueBtn = menu\.querySelector\('\[data-plus="issue"\]'\);/);
  const wired = VIEW.slice(VIEW.indexOf('const issueBtn = '));
  // QA 2026-09-24: with `intent: 'issue'`, so the dialog is headed with the
  // row's own words ("Ask for a change") rather than "Send feedback". #21:
  // and with `target: 'app'`, the one thing that preselects the open app
  // since #2707; `fromDev` alone opened the dialog asking which one.
  assert.match(wired.slice(0, 700), /App\.openFeedbackModal\(\{ fromDev: true, target: 'app', intent: 'issue' \}\)/);
});

for (const touch of [false, true]) {
  test(`${touch ? 'the touch sheet' : 'the desktop dropdown'} routes Ask for a change to the feedback dialog, once, and closes`, () => {
    const h = menuHarness(touch);
    h.button.click();
    if (touch) {
      const sheet = h.sheets.at(-1);
      const item = sheet.actions.find((entry) => entry.label === 'Ask for a change');
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
    AppView: { createProposal: () => calls.push(['new-change', sandbox.App.currentApp]) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // The one surface still listing these sessions. Flip `sheet.open` in a
  // test that needs the reload gate open; it is the notifications sheet's
  // flag, not the Improve panel's — that panel retired (#2718 review).
  const sheet = { open: false };
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor() {} },
      // THE CONTROLLER PRESENTS NOTHING NOW (#2718 review). It adopted the
      // Improve panel's root through lib/kit-surface and swept the other
      // sheets through lib/sheet-controller; the panel retired, `open()`
      // forwards to the app-context sheet, and both stubs went with it. What
      // it does import is the notifications sheet's own open flag — the one
      // surface still listing these sessions, and the gate on reloading them.
      '../notifications/notifications-sheet-store.js': {
        notificationsSheetStore: { get: () => sheet, subscribe: () => () => {} },
      },
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

test('Give feedback still opens the shared dialog for the current app', () => {
  const { Improve, calls } = improveHarness();
  Improve.giveFeedback();
  // #21: `target: 'app'` preselects the app the change is for. Since #2707
  // `fromDev` alone opens the dialog asking which one, which is what "Ask
  // for a change" from inside an app did.
  assert.deepEqual(calls, [['close'], ['feedback', true, 'app']]);
});

test('#21: from another app Give feedback names no target: there is no open app for "This app" to mean', () => {
  const { Improve, calls } = improveHarness('other');
  Improve.giveFeedback();
  assert.deepEqual(calls, [['close'], ['feedback', undefined, undefined]]);
});

// #2770 sent New change straight to the app's classic unsent-change screen
// (/dev/sessions/new). #2779: classic sessions are no longer created, so it
// opens an unsent agent session focused on the target app, whichever app is
// open, and navigates nowhere else itself.
for (const currentApp of ['demo', 'other']) {
  test(`New change opens an agent session on the target app from ${currentApp}`, () => {
    const h = improveHarness(currentApp);
    const { Improve, calls } = h;
    const started = [];
    h.sandbox.UsernodeReact = { agentSession: { start: (hint) => { started.push(JSON.parse(JSON.stringify(hint))); } } };
    Improve.startSession();
    assert.deepEqual(started, [{ slug: 'demo', entry: 'improve' }]);
    assert.deepEqual(calls, [['close']], 'no board, no classic screen, and nothing is created by the click');
  });
}
