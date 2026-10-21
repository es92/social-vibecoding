// A reply typed on a change's page vanished: the box emptied and nothing was
// posted, with no word of why (feedback, 21 Oct 2026: "the message just
// disappears").
//
// `GroupChat._app` is the app the module's last `mount()` was about, and the
// Messages screen and a project's Discussion tab mount it for whatever app
// they show. Nothing put it back when the app view then opened a topic page,
// so `mountThread` read the slug, and `send` the read-only flag, of that
// earlier app: a reply went out on another app's socket, where the server
// refuses a thread it does not have, or was dropped before it left because
// the earlier app's pane was read-only (Homeroom's archived discussion).
//
// The app view now names its own app when it mounts a topic thread, and that
// app is the mount's from then on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const gcJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'group-chat.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');

class Node extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.files = null;
    this.scrollHeight = 0;
  }
}

function load({ appView }) {
  const nodes = {
    'gc-thread-form': new Node('gc-thread-form'),
    'gc-thread-input': new Node('gc-thread-input'),
    'gc-thread-messages': new Node('gc-thread-messages'),
    'gc-thread-attach-btn': new Node('gc-thread-attach-btn'),
    'gc-thread-file-input': new Node('gc-thread-file-input'),
  };
  const container = new Node('dev-topic-thread');
  container.querySelector = (sel) => nodes[sel.replace(/^#/, '')] || null;
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: () => new Node(''),
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const window = { matchMedia: () => ({ matches: false }), UsernodeReact: {} };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    URL, URLSearchParams, EventTarget, Event, AbortController,
    document,
    window,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'maya' } },
    AppView: appView,
    PlatformUI: { attachScreenFx() {} },
    PlatformI18n: englishPlatformI18n(),
    console,
    fetch: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  const GroupChat = sandbox.__M.GroupChat;

  // One socket per app, each recording what was written on it.
  const sent = {};
  const socket = (slug) => ({ readyState: 1, send: (raw) => (sent[slug] = sent[slug] || []).push(JSON.parse(raw)) });
  const connected = [];
  GroupChat.connect = (slug) => {
    connected.push(slug);
    GroupChat.appSlug = slug;
    GroupChat.ws = socket(slug);
  };
  GroupChat._react = () => ({ mountThreadShell() {}, unmountTranscript() {} });
  GroupChat.renderThread = () => {};
  GroupChat.loadThreadHistory = () => {};
  GroupChat._renderQuotePreview = () => {};
  GroupChat._renderAttachStrip = () => {};
  GroupChat._autoGrowTextarea = () => {};
  GroupChat.sendTyping = () => {};
  return { GroupChat, nodes, container, sent, connected, socket };
}

// The Messages screen (or a project's Discussion tab) had mounted the module
// for `app`, and its socket is up.
function mountedBefore(GroupChat, socket, app) {
  GroupChat._app = app;
  GroupChat.appSlug = app.slug;
  GroupChat.ws = socket(app.slug);
}

function openChangePage(GroupChat, container, app) {
  GroupChat.mountThread({
    type: 'session', ref: 812, container, fullHeight: true, withHeader: true,
    language: 'change', placeholder: 'Reply…', readOnly: false, app,
  });
}

function typeAndSend(nodes, text) {
  nodes['gc-thread-input'].value = text;
  nodes['gc-thread-form'].dispatchEvent(new Event('submit', { cancelable: true }));
}

const TIC_TAC = { slug: 'tic-tac', name: 'Tic Tac', readOnly: false };

test('a reply on a change page posts to that change\'s app after Homeroom\'s read-only discussion was open', () => {
  const { GroupChat, nodes, container, sent, connected, socket } = load({
    appView: { appData: { slug: 'tic-tac', name: 'Tic Tac' }, readOnly: false },
  });
  mountedBefore(GroupChat, socket, { slug: 'usernode-2d5619', name: 'Homeroom', readOnly: true });
  openChangePage(GroupChat, container, TIC_TAC);
  assert.deepEqual(connected, ['tic-tac'], 'the socket moves to the change\'s app');
  typeAndSend(nodes, 'Can you fix what is failing in the checks you ran?');
  assert.equal(sent['usernode-2d5619'], undefined, 'nothing is written on the earlier app\'s socket');
  assert.equal(sent['tic-tac']?.length, 1, 'the reply is sent, once');
  assert.deepEqual(sent['tic-tac'][0].thread, { type: 'session', ref: 812 });
  assert.equal(sent['tic-tac'][0].content, 'Can you fix what is failing in the checks you ran?');
  assert.equal(GroupChat._appSlug(), 'tic-tac');
  assert.equal(GroupChat._readOnly(), false);
});

test('a reply on a change page never goes out on another app\'s socket', () => {
  const { GroupChat, nodes, container, sent, connected, socket } = load({
    appView: { appData: { slug: 'tic-tac', name: 'Tic Tac' }, readOnly: false },
  });
  mountedBefore(GroupChat, socket, { slug: 'garden-log', name: 'Garden log', readOnly: false });
  openChangePage(GroupChat, container, TIC_TAC);
  assert.deepEqual(connected, ['tic-tac']);
  typeAndSend(nodes, '@Homeroom bot can you help fix the failing test?');
  assert.equal(sent['garden-log'], undefined, 'garden-log has no change 812 and would refuse it');
  assert.equal(sent['tic-tac']?.length, 1);
});

test('a project whose main channel is read-only still takes replies on its change pages', () => {
  // Homeroom's own discussion is archived, but its proposals' and requests'
  // threads stay open (services/ws.js): the pane's read-only flag is not the
  // thread's.
  const { GroupChat, nodes, container, sent, connected, socket } = load({
    appView: { appData: { slug: 'usernode-2d5619', name: 'Homeroom' }, readOnly: false },
  });
  mountedBefore(GroupChat, socket, { slug: 'usernode-2d5619', name: 'Homeroom', readOnly: true });
  openChangePage(GroupChat, container, { slug: 'usernode-2d5619', name: 'Homeroom', readOnly: false });
  assert.deepEqual(connected, [], 'the same app\'s socket is kept');
  typeAndSend(nodes, 'Looks good to me');
  assert.equal(sent['usernode-2d5619']?.length, 1);
});

test('a reply thread opened beside a channel keeps the channel\'s app (Messages, a project\'s Discussion)', () => {
  const { GroupChat, nodes, container, sent, connected, socket } = load({
    appView: { appData: null, readOnly: false },
  });
  mountedBefore(GroupChat, socket, { slug: 'garden-log', name: 'Garden log', readOnly: false });
  GroupChat.mountThread({ type: 'message', ref: 4001, container, fullHeight: true, placeholder: 'Reply…' });
  assert.deepEqual(connected, []);
  typeAndSend(nodes, 'agreed');
  assert.deepEqual(sent['garden-log']?.[0]?.thread, { type: 'message', ref: 4001 });
  assert.equal(GroupChat._app.slug, 'garden-log');
});

// The app view's side: every topic thread it mounts names its own app.
function mountTopicThread({ devTopic, item, readOnly = false }) {
  const start = appViewJs.indexOf('  _mountTopicThread() {');
  const end = appViewJs.indexOf('\n  // Open a topic full-screen.', start);
  const method = appViewJs.slice(start, end).trim().replace(/,$/, '');
  const calls = [];
  const AppView = {
    _devTopic: devTopic,
    appData: { slug: 'tic-tac', name: 'Tic Tac' },
    readOnly,
    _findTopicItem: () => item,
    _sanitizeIssueNumbers: (list) => list.filter((n) => Number.isInteger(n) && n > 0),
  };
  vm.runInNewContext(`({ ${method} })._mountTopicThread.call(AppView)`, {
    AppView,
    App: { currentApp: 'tic-tac' },
    document: { getElementById: () => ({}) },
    PlatformI18n: englishPlatformI18n(),
    GroupChat: { mountThread: (opts) => calls.push(opts) },
  });
  assert.equal(calls.length, 1);
  return calls[0];
}

test('the app view names its own app on a change page and on a request page', () => {
  const change = mountTopicThread({
    devTopic: { kind: 'proposal', id: 812 },
    item: { id: 812, status: 'promoted', linked_issues: [22] },
  });
  assert.deepEqual({ ...change.app }, { slug: 'tic-tac', name: 'Tic Tac', readOnly: false });
  const request = mountTopicThread({ devTopic: { kind: 'issue', id: 22 }, item: { number: 22 } });
  assert.deepEqual({ ...request.app }, { slug: 'tic-tac', name: 'Tic Tac', readOnly: false });
  const reader = mountTopicThread({ devTopic: { kind: 'issue', id: 22 }, item: { number: 22 }, readOnly: true });
  assert.equal(reader.app.readOnly, true, 'a viewer who may not write here still may not');
});
