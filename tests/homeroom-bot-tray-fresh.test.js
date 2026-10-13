'use strict';

// #8 (WP3): the Homeroom bot's chat header said "Working on…" and "Last:
// stopped" long after the work had moved on. tests/homeroom-bot-tray.test.js
// pins what the tray says; this file pins when it reads:
//
//   - every read the tray makes after the DM opens asks the server, past the
//     service worker's offline copy (`fresh`, as the activity cards' reads
//     do); opening the DM is the one ordinary read, the worker's to correct;
//   - the worker's late correction (store.ts resync) reads the tray again;
//   - while the bot has work in hand and the page is in view, the tray reads
//     again every POLL_MS, and stops once nothing is in hand;
//   - work that only waits its turn says so (D6): one request, one story
//     draws it in the strip's In progress line as "in the queue".
//
// Run with: node --test tests/homeroom-bot-tray-fresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TRAY = 'frontend/src/features/messages/bot-work.tsx';
const API = 'frontend/src/features/messages/api.ts';
const STORE = 'frontend/src/features/messages/store.ts';
const realReact = require(require.resolve('react', { paths: [FRONTEND] }));

/** A React small enough to step through: the hooks the sync uses, effects included; the rest is React's own. */
function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let effects = [];
  const changed = (prev, next) => !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  function render() {
    cursor = 0;
    effects = [];
    renderFn();
    for (const run of effects) run();
  }
  const React = {
    ...realReact,
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      if (!s.fresh && !changed(s.deps, deps)) return;
      s.fresh = false;
      s.deps = deps;
      effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      slot(() => ({ unsubscribe: subscribe(() => render()) }));
      return getSnapshot();
    },
  };
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    render,
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}

const EMPTY = { now: [], needsYou: [], history: [] };
const queuedJob = {
  key: 'ear-trainer#3', appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: 3, title: 'Sort', firstVersion: false,
  phase: 'queued', step: 1, of: 6, stepName: 'Reading', doing: 'next in line to be read', since: null,
  href: null, links: { request: null, proposal: null, project: null }, earlier: [],
};

function loadSync(t, responses) {
  const saved = ['window', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const win = new EventTarget();
  const timers = new Map();
  let timerId = 0;
  win.setInterval = (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; };
  win.clearInterval = (id) => { timers.delete(id); };
  globalThis.window = win;
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const reads = [];
  const api = {
    getHomeroomBotWork(options) {
      reads.push(options);
      return Promise.resolve(responses.length ? responses.shift() : EMPTY);
    },
  };
  const fake = createFakeReact();
  const mod = loadTsx(TRAY, { stubs: { react: fake.React, './api': api, './store': { handleEvent() {} } } });
  return { mod, fake, reads, timers, win };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the tray reads fresh after the DM opens, polls while the bot has work in hand and the page is in view, and stops after', async (t) => {
  const busy = { ...EMPTY, now: [queuedJob] };
  const { mod, fake, reads, timers, win } = loadSync(t, [busy, busy, busy, busy, EMPTY]);
  const { POLL_MS } = loadTsx('frontend/src/features/messages/bot-activity-store.ts', {
    stubs: { './api': {}, './store': { handleEvent() {} }, react: fake.React },
  });
  let newsKey = 50;
  fake.mount(() => mod.BotWorkSync({ conversationId: 5, newsKey }));
  await settle();
  assert.deepEqual(reads, [{ fresh: false }], 'opening the DM: the one ordinary read, the worker\'s to correct');

  // Work in hand: asked again now and then, as the activity cards are.
  assert.equal(timers.size, 1);
  const [poll] = [...timers.values()];
  assert.equal(poll.ms, POLL_MS);
  poll.fn();
  await settle();
  assert.deepEqual(reads.at(-1), { fresh: true }, 'a poll asks the server');
  globalThis.document.visibilityState = 'hidden';
  poll.fn();
  await settle();
  assert.equal(reads.length, 2, 'not while the page is out of view');
  globalThis.document.visibilityState = 'visible';

  // The loop's announcement, and the bot's news in the DM: fresh.
  win.dispatchEvent(new Event('homeroom-bot-work-changed'));
  await settle();
  assert.deepEqual(reads.at(-1), { fresh: true });
  newsKey = 51;
  fake.render();
  await settle();
  assert.equal(reads.length, 4);
  assert.deepEqual(reads.at(-1), { fresh: true });

  // Nothing in hand any more: no more asking.
  [...timers.values()][0].fn();
  await settle();
  assert.equal(reads.length, 5);
  assert.deepEqual(reads.at(-1), { fresh: true });
  assert.equal(timers.size, 0, 'the poll stops once nothing is in hand');
  fake.unmount();
});

test('the tray\'s read passes `fresh` as cache: no-store, as every other re-read of the bot\'s does', async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    seen.push({ url, cache: init.cache });
    return { ok: true, json: async () => ({ now: [], needsYou: [], history: [] }) };
  };
  const api = loadTsx(API);
  await api.getHomeroomBotWork();
  await api.getHomeroomBotWork({ fresh: true });
  assert.deepEqual(seen, [
    { url: '/api/conversations/homeroom-bot/work', cache: undefined },
    { url: '/api/conversations/homeroom-bot/work', cache: 'no-store' },
  ]);
  // One request, one story: the strip's Approve reads the strip again
  // fresh once the yes is in (it has no retry button: the panel that had one
  // is gone, and the strip waits for its first read before it draws).
  assert.match(read('frontend/src/features/messages/bot-strip.tsx'), /if \(out\.ok\) \{ loadBotWork\(\); return; \}/);
});

test('the worker\'s late correction (resync) reads the tray and the cards again, through the event both re-read on', () => {
  const store = read(STORE);
  const resync = store.slice(store.indexOf('export async function resync('), store.indexOf('\n}', store.indexOf('export async function resync(')));
  assert.match(store, /import \{ WORK_CHANGED_EVENT(?:, [\w, ]+)? \} from '\.\/bot-shared';/);
  assert.match(resync, /if \(conversationId && onScreen\(conversationId\)\) \{[\s\S]*window\.dispatchEvent\(new CustomEvent\(WORK_CHANGED_EVENT\)\);\n {2}\}/,
    'only for the conversation on screen');
});

test('#8 (D6): work that only waits its turn says so; anything under way says what is being done', () => {
  // One request, one story: the header's status line is gone; each In
  // progress row of the activity drawer says what its request is doing
  // (bot-strip.tsx).
  const { doingWord, stripGroups } = loadTsx('frontend/src/features/messages/bot-strip.tsx');
  const job = (issueNumber, phase, stage = null) => ({ ...queuedJob, key: `ear-trainer#${issueNumber}`, issueNumber, title: `Request ${issueNumber}`, phase, stage });
  assert.equal(doingWord(job(3, 'queued')), 'in the queue');
  assert.equal(doingWord(job(3, 'follow_up_queued')), 'following up', 'a follow-up waiting its turn');
  assert.equal(doingWord(job(3, 'building', 'build_queued')), 'in the queue', 'a build waiting its turn');
  assert.equal(doingWord(job(3, 'building')), 'building');
  const rows = stripGroups({ now: [job(3, 'queued'), job(4, 'building'), job(5, 'follow_up_queued')], needsYou: [], history: [] }).progress;
  assert.deepEqual(rows.map((row) => row.state), ['in the queue', 'building', 'following up']);
});
