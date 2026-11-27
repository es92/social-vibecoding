// Start editor: the app's live preview, one press from the app's own menu
// (27 Nov 2026).
//
// The Homeroom mark's menu over an open app leads with a card, under the
// yellow "Suggest an improvement": Start editor. Pressing it opens a new chat
// with Homeroom bot about that app and starts its live preview at once, as
// the new chat's own Live preview button would, so a draft of the app runs
// beside the chat. Until then that start was two screens away, in the
// project's Workshop or in New chat with the project picked.
//
//  - who is offered it: a signed-in person who may change the app, where New
//    chat offers its live preview, and never a newcomer whose menu leads with
//    Go to Homeroom (offersEditor);
//  - what a press does: the request is handed to the new chat right before
//    the address that opens it (startEditor);
//  - what the new chat does with it: sends the live start once the project's
//    name is read, and nothing when the chat has become something else
//    (liveAskNext, takeLiveAsk).
//
// Run with: node --test tests/app-menu-start-editor.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = 'frontend/src/features/app-context/app-context-sheet.tsx';
const NEW = 'frontend/src/features/messages/new-thread.tsx';
const CARRY = 'frontend/src/features/messages/new-chat-carry.ts';

const who = { slug: 'outreach', selfHosted: false, signedIn: true, isAdmin: false, readOnly: false, restricted: false, newcomer: false, platform: 'homeroom' };

test('Start editor is offered to a signed-in person who may change the app, where New chat offers its live preview', () => {
  const { offersEditor } = loadTsx('tests/fixtures/app-context-sheet-api.ts');
  assert.equal(offersEditor(who), true);
  assert.equal(offersEditor({ ...who, slug: null }), false, 'no app in context');
  assert.equal(offersEditor({ ...who, signedIn: false }), false, 'a visitor');
  assert.equal(offersEditor({ ...who, readOnly: true }), false, 'someone who can only read the app, a private member among them');
  assert.equal(offersEditor({ ...who, restricted: true }), false, 'a platform row the viewer is not served');
  assert.equal(offersEditor({ ...who, newcomer: true }), false, 'a newcomer has Go to Homeroom instead');
  // New chat's own rule (offersLive): Homeroom itself only for an admin, and no other self-hosted app.
  assert.equal(offersEditor({ ...who, slug: 'homeroom', selfHosted: true }), false);
  assert.equal(offersEditor({ ...who, slug: 'homeroom', selfHosted: true, isAdmin: true }), true);
  assert.equal(offersEditor({ ...who, selfHosted: true }), false);
  assert.equal(offersEditor({ ...who, slug: 'homeroom', selfHosted: true, isAdmin: true, platform: null }), false, 'before the platform has said its slug');
});

/**
 * The open menu as it draws once mounted, on the server renderer: the
 * after-mount effect runs in render, once per draw (the way
 * tests/private-member-shell.test.js draws it). `user` is who is signed in.
 */
function drawMenu({ user = { id: 7, username: 'evan' }, improve = {}, privateMember = false, open = true } = {}) {
  const React = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  let mountedOnce = false;
  const fake = {
    ...React,
    useEffect(fn, deps) {
      if (!mountedOnce && Array.isArray(deps) && deps.length === 0 && /setMounted\(true\)/.test(String(fn))) {
        mountedOnce = true;
        fn();
      }
    },
    useLayoutEffect() {},
  };
  const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts', { stubs: { react: fake } });
  const had = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  Object.defineProperty(globalThis, 'window', { value: { App: { user, _privateHomeVisited: () => true } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true, writable: true });
  const before = { improve: ui.improveStore.get(), context: ui.appContextStore.get(), nav: ui.navStore.get() };
  ui.improveStore.set({ ...before.improve, target: 'app', slug: 'outreach', name: 'Outreach', ...improve });
  ui.appContextStore.set({ ...before.context, open });
  ui.navStore.set({ privateMember });
  try {
    return renderToHtml(createElement(ui.AppsSwitcherSheet));
  } finally {
    ui.improveStore.set(before.improve);
    ui.appContextStore.set(before.context);
    ui.navStore.set({ privateMember: before.nav.privateMember });
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  }
}

test('the open menu leads its list with the Start editor card, in the menu\'s own card recipe', () => {
  assert.equal(message('agent:appContext.startEditor.title'), 'Start editor');
  assert.equal(message('agent:appContext.startEditor.sub'), 'Change it live with Homeroom bot');
  const html = drawMenu();
  assert.match(html, /<button id="app-menu-row-editor" type="button"/);
  assert.match(html, />Start editor</);
  assert.match(html, />Change it live with Homeroom bot</);
  // Under the one filled button, inside the list, before Go to community.
  const at = (needle) => html.indexOf(needle);
  assert.ok(at('id="improve-quick-actions"') < at('id="switcher-nav"'));
  assert.ok(at('id="switcher-nav"') < at('id="app-menu-editor-card"'));
  assert.ok(at('id="app-menu-editor-card"') < at('id="app-menu-row-workshop"'));
  // The Go to Homeroom card's recipe exactly, with the grey tile its second row has: no new style.
  const src = read(SHEET);
  const cardClass = 'mx-4 mt-1 mb-2 w-[calc(100%_-_2rem)] rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
  const tileClass = 'shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-[11px] bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200';
  for (const id of ['app-menu-homeroom-card', 'app-menu-editor-card']) {
    assert.ok(src.includes(`id="${id}"\n              className="${cardClass}"`), `${id} wears the card recipe`);
  }
  assert.equal(src.split(tileClass).length - 1, 2, 'the same tile as the card\'s Add to Home Screen row');
});

test('the card is not drawn where it is not offered, nor in the prerender', () => {
  assert.doesNotMatch(drawMenu({ user: null }), /app-menu-row-editor/, 'signed out');
  assert.doesNotMatch(drawMenu({ privateMember: true }), /app-menu-row-editor/, 'a private member');
  assert.doesNotMatch(drawMenu({ improve: { readOnly: true } }), /app-menu-row-editor/, 'read-only');
  assert.doesNotMatch(drawMenu({ improve: { selfHosted: true } }), /app-menu-row-editor/, 'a self-hosted app');
  assert.doesNotMatch(drawMenu({ open: false }), /app-menu-row-editor/, 'a closed menu');
  // The prerender is not mounted: no card, so the hydrating render matches it.
  const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
  const before = ui.improveStore.get();
  ui.improveStore.set({ ...before, target: 'app', slug: 'outreach', name: 'Outreach' });
  try {
    assert.doesNotMatch(renderToHtml(createElement(ui.AppsSwitcherSheet)), /app-menu-row-editor/);
  } finally {
    ui.improveStore.set(before);
  }
});

test('a press closes the menu, then hands the request over right before the address that opens the new chat', () => {
  const calls = [];
  const sheet = loadTsx(SHEET, {
    stubs: {
      '../messages/new-chat-carry': { carryLiveStartToNewChat: () => calls.push('carry') },
      '../ai/door': {
        botNewAddress: ({ project }) => `#homeroom-bot/new?project=${project}`,
        goBotAddress: (href) => calls.push(href),
      },
    },
  });
  sheet.startEditor('outreach');
  assert.deepEqual(calls, ['carry', '#homeroom-bot/new?project=outreach']);
  const src = read(SHEET);
  assert.match(src, /id="app-menu-row-editor"[\s\S]{0,400}onClick=\{\(\) => \{\n\s+const app = slug;\n\s+void AppContext\.dismissForNav\(\)\.then\(\(\) => startEditor\(app\)\);/,
    'the menu is put away first: the kit cannot present over a sheet it is still dismissing');
});

test('the request waits for its new chat as a carried item does: a moment, and once', () => {
  const carry = loadTsx(CARRY);
  carry.carryLiveStartToNewChat(1000);
  assert.deepEqual(carry.takeCarried(1000 + carry.CARRY_MS - 1), { object: null, placeholder: null, words: null, start: null, send: true });
  assert.equal(carry.takeCarried(1000), null, 'once');
  carry.carryLiveStartToNewChat(1000);
  assert.equal(carry.takeCarried(1000 + carry.CARRY_MS), null, 'a chat opened later starts nothing');
  // Every other door sends nothing for the person.
  carry.carryWordsToNewChat('', 'live', 1000);
  assert.equal(carry.takeCarried(1000).send, false);
  carry.carryToNewChat({ type: 'issue', appSlug: 'outreach', issueNumber: 4 }, null, 1000);
  assert.equal(carry.takeCarried(1000).send, false);
});

test('the new chat sends the live start once the project is named, and drops it when the chat has become something else', () => {
  const { liveAskNext } = loadTsx(NEW);
  const at = { asked: 'outreach', project: 'outreach', typed: false, own: false, named: true, ready: true, holding: false };
  assert.equal(liveAskNext(at), 'send');
  assert.equal(liveAskNext({ ...at, named: false }), 'wait', 'the message names the app, so its name is read first');
  assert.equal(liveAskNext({ ...at, ready: false }), 'wait');
  assert.equal(liveAskNext({ ...at, holding: true }), 'wait', 'a send or an upload under way');
  assert.equal(liveAskNext({ ...at, project: 'plant-pal' }), 'drop', 'another project was picked: nothing is sent for it');
  assert.equal(liveAskNext({ ...at, project: '' }), 'drop');
  assert.equal(liveAskNext({ ...at, typed: true }), 'drop', 'the person began a message of their own');
  assert.equal(liveAskNext({ ...at, own: true }), 'drop', 'their own Claude Code or ChatGPT has no live preview');
  assert.equal(liveAskNext({ ...at, asked: '' }), 'drop');

  const panel = read(NEW);
  // The request is taken once, so a new chat drawn again later sends nothing.
  assert.match(panel, /function takeLiveAsk\(\): string \{\n\s+if \(!preset\?\.send\) return '';\n\s+const asked = preset\.project \|\| '';\n\s+preset = \{ \.\.\.preset, send: false \};\n\s+return asked;\n\}/);
  assert.match(panel, /useEffect\(\(\) => \{ const asked = takeLiveAsk\(\); if \(asked\) setAutoLive\(asked\); \}, \[\]\);/, 'on the first render');
  assert.match(panel, /if \(takeWords\(preset\) \|\| preset\.object\) toField\(\);\n\s+setAutoLive\(takeLiveAsk\(\)\);/, 'and by a new chat already open');
  // It is the head's Live preview button's own send, with the same words.
  assert.match(panel, /const next = liveAskNext\(\{ asked: autoLive, project, typed: !!words\.trim\(\), own: !!own, named, ready: liveReady, holding \}\);\n\s+if \(next === 'wait'\) return;\n\s+setAutoLive\(''\);\n\s+if \(next === 'send'\) startLive\(\);/);
  assert.match(panel, /const startLive = \(\) => \{ if \(liveReady\) void send\(undefined, liveWords\); \};/);
});
