// #4517: a reply typed on one request's page was posted to another request's
// thread — the one opened earlier in the same visit.
//
// The topic page's thread shell is React's (thread-shell.tsx, mounted by
// `mountThreadShell`), so going from one request's page to another's in the
// same `#dev-topic-thread` host keeps the SAME form and textarea nodes.
// `GroupChat.mountThread` binds its submit, input, keydown and attachment
// listeners to those nodes, each closing over the mount's `{ type, ref }`.
// Nothing unbound the previous mount's, so the first page's submit handler
// ran first, sent the text to ITS thread and emptied the box, and the page on
// screen's own handler then found nothing to send.
//
// This replays that visit — open #4486, open #4417 in the same host, quote a
// message there and send — and requires the one write to name #4417.
//
// One message box (27 Nov 2026): the box is Messages' own now, and the
// module binds nothing to it. Each mount hands the shell the thread it is
// for (`mountThreadShell` props), the box sends through GroupChat.send with
// that thread, and a re-render with new props is the whole of a "rewire".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n } = require('./lib/platform-i18n');

const gcJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');

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
  click() { this.dispatchEvent(new Event('click')); }
}

function load() {
  // The nodes React keeps across a re-render of the shell.
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
    App: { user: { id: 1, username: 'evan' } },
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

  const sent = [];
  GroupChat.appSlug = 'usernode-2d5619';
  GroupChat._appSlug = () => 'usernode-2d5619';
  GroupChat.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  const mounts = [];
  GroupChat._react = () => ({ mountThreadShell(host, props) { mounts.push(props); }, unmountTranscript() {} });
  GroupChat.renderThread = () => {};
  GroupChat.loadThreadHistory = () => {};
  GroupChat._renderQuotePreview = () => {};
  GroupChat._renderAttachStrip = () => {};
  GroupChat._autoGrowTextarea = () => {};
  GroupChat.sendTyping = () => {};
  return { GroupChat, nodes, container, sent, mounts };
}

function openRequest(GroupChat, container, number) {
  GroupChat.mountThread({
    type: 'issue', ref: number, container, fullHeight: true, withHeader: true,
    language: 'request', placeholder: 'Reply…',
  });
}

// What the box does with a press of Send: the place's send, with the thread
// of the latest mount's props (the box the page on screen draws).
function typeAndSend(GroupChat, mounts, text) {
  GroupChat.send(text, mounts[mounts.length - 1].thread, []);
}

test('a reply sent after moving between request pages goes to the request on screen', () => {
  const { GroupChat, container, sent, mounts } = load();
  openRequest(GroupChat, container, 4486);
  typeAndSend(GroupChat, mounts, 'plan v1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].thread, { type: 'issue', ref: 4486 });

  // Over to #4417's page, in the same host: React keeps the box, with new props.
  openRequest(GroupChat, container, 4417);
  GroupChat.replyDraft = { source: 'message', refMsgId: 901, author: 'Bruno', snippet: 'Not sure, I think it would be something like this' };
  GroupChat.replyDraftScope = 'thread';
  typeAndSend(GroupChat, mounts, 'a quote-reply to Bruno');

  assert.equal(sent.length, 2, 'exactly one write for the one send');
  assert.deepEqual(sent[1].thread, { type: 'issue', ref: 4417 }, 'written to the thread on screen');
  assert.equal(sent[1].content, 'a quote-reply to Bruno');
  assert.ok(sent[1].quote, 'the staged quote rides along with it');
});

test('the module binds nothing to the box: no listener outlives a mount', () => {
  const { GroupChat, nodes, container } = load();
  let bound = 0;
  // The box's own nodes (the transcript's host takes the quote handlers).
  for (const node of ['gc-thread-form', 'gc-thread-input', 'gc-thread-attach-btn', 'gc-thread-file-input'].map((id) => nodes[id])) {
    const add = node.addEventListener.bind(node);
    node.addEventListener = (...args) => { bound += 1; add(...args); };
  }
  openRequest(GroupChat, container, 4486);
  openRequest(GroupChat, container, 4417);
  openRequest(GroupChat, container, 4417);
  const inBox = bound;
  assert.equal(inBox, 0, 'the box wires itself');
  assert.doesNotMatch(gcJs, /_rewireThreadComposer|_threadComposerWiring/);
});

test('each mount hands the box its own thread and project', () => {
  const { GroupChat, container, mounts } = load();
  openRequest(GroupChat, container, 4486);
  openRequest(GroupChat, container, 4417);
  assert.deepEqual(mounts.map((m) => `${m.slug} ${m.thread.type}:${m.thread.ref}`), [
    'usernode-2d5619 issue:4486', 'usernode-2d5619 issue:4417',
  ]);
});
