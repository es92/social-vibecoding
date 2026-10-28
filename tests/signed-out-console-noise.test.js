// QA 2026-09-24 Q35: the signed-out landing and the waiting room ask no
// member-only API.
//
// The shell is one document for everyone, so stores mounted on every page
// fetched `/api/models` and `/api/agent-sessions` (and, until it was
// removed, Global Chat's bootstrap) for signed-out visitors (four 401s, each a red
// "Failed to load resource" line on every anonymous screen) and for
// waiting-room accounts (403s). They now wait for a viewer the endpoints
// answer (frontend/src/lib/platform-viewer.ts) and load on `sv:authed`, the
// authed boot's once-per-document event, when there was none at mount.
//
// Run with: node --test tests/signed-out-console-noise.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function world(user) {
  const listeners = {};
  const doc = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  const win = { App: { user }, UsernodeReact: {}, location: { hash: '' }, PlatformUI: { toast: () => {} } };
  const requests = [];
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const body = { sessions: [], models: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const authed = () => { for (const fn of listeners['sv:authed'] || []) fn(); };
  return { win, requests, authed, listeners };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.fetch;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('signed out: no member request, and the load runs once the authed shell boots', async () => {
  const w = world(null);
  try {
    const agent = loadTsx('frontend/src/features/agent-session/store.ts');
    await agent.loadAgentSessions();
    await agent.loadAgentSessions(); // a second caller (recents, the app sheet)
    await agent.loadModelCatalog();
    await settle();
    assert.deepEqual(w.requests, [], 'nothing asked for a signed-out document');
    assert.equal((w.listeners['sv:authed'] || []).length, 2, 'one deferred load per load, not one per caller');

    // A reload-free sign-in: App.user lands, then sv:authed fires.
    w.win.App.user = { id: 1, username: 'ada', hasPlatformAccess: true };
    w.authed();
    await settle();
    await settle();
    assert.ok(w.requests.includes('/api/agent-sessions'));
    assert.ok(w.requests.includes('/api/models'));
  } finally { cleanup(); }
});

test('the waiting room: an account without platform access asks nothing', async () => {
  const w = world({ id: 2, username: 'queued', hasPlatformAccess: false });
  try {
    const agent = loadTsx('frontend/src/features/agent-session/store.ts');
    await agent.loadAgentSessions();
    await agent.loadModelCatalog();
    // sv:authed does not fire for a waiting-room session, and if it did the
    // gate would still hold.
    w.authed();
    await settle();
    assert.deepEqual(w.requests, []);
  } finally { cleanup(); }
});

test('a member loads straight away, as before', async () => {
  // `hasPlatformAccess` absent is a member too: app.js gates on `=== false`
  // so an older cached user without the field is never locked out.
  const w = world({ id: 3, username: 'member' });
  try {
    const agent = loadTsx('frontend/src/features/agent-session/store.ts');
    await agent.loadAgentSessions();
    await settle();
    assert.ok(w.requests.includes('/api/agent-sessions'));
  } finally { cleanup(); }
});

test('DevChat asks for /api/models only for such a viewer, else on sv:authed', () => {
  const src = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(src, /const hasPlatformViewer = \(\) => !!\(window\.App && window\.App\.user\s+&& window\.App\.user\.hasPlatformAccess !== false\);/);
  assert.match(src, /if \(hasPlatformViewer\(\)\) DevChat\.loadModels\(\);\s+else if \(typeof document !== 'undefined'\) \{\s+document\.addEventListener\('sv:authed'/);
  assert.doesNotMatch(src, /\n  DevChat\.loadModels\(\);\n\}/, 'no unconditional boot fetch');
});
