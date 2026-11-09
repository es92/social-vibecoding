// #6081: the Translate control on a request and in a message's ⋯ menu, and
// the line under translated words.
// #6525: a chat's messages ask for their translation by themselves as they
// come into view, through a queue that keeps under the route's limits.
//
// What this pins:
//   1. THE ANSWER, as words: a translated text is shown, text already in the
//      reader's language says so, and a failure leaves the original.
//   2. THE WAY BACK: Show original and Show translation each flip the line,
//      and the button beside Show more exists only on someone else's request.
//   3. THE MENU: Translate is one row of the ⋯ menu, only on someone else's
//      message with words, and it becomes the way back once translated.
//   4. THE COPY: every id these screens ask for exists in English.
//   5. WHAT IS WORTH ASKING: emoji, links, names and code alone are not.
//   6. THE AUTOMATIC ANSWER: shown when there is something to show, and
//      otherwise quiet.
//   7. THE QUEUE: few on their way at once, few started a minute, nothing
//      after a 429, and a known answer costs no request.
//   8. THE ROW asks for itself only when it is someone else's words and it is
//      on screen.
//
// Run with: node --test tests/translate-toggle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TRANSLATE = 'frontend/src/features/messages/translate.tsx';
const ROW = 'frontend/src/features/messages/message-row.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';

const mod = loadTsx(TRANSLATE);

test('the answer says what the words are doing', () => {
  assert.deepEqual(mod.viewOf(null, ['Hello']), { state: 'idle', texts: ['Hello'], from: null });

  const shown = mod.viewOf([{ state: 'translated', text: 'Bonjour', from: 'en' }], ['Hello']);
  assert.equal(shown.state, 'shown');
  assert.deepEqual(shown.texts, ['Bonjour']);
  assert.equal(shown.from, 'en');

  const same = mod.viewOf([{ state: 'same' }], ['Hello']);
  assert.equal(same.state, 'same');
  assert.deepEqual(same.texts, ['Hello']);

  const failed = mod.viewOf([{ state: 'failed' }], ['Hello']);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.texts, ['Hello']);

  // A title already in the language, the words translated: the pair reads
  // as one, each part as it should be.
  const mixed = mod.viewOf([{ state: 'same' }, { state: 'translated', text: 'Bonjour', from: 'en' }], ['Title', 'Hello']);
  assert.equal(mixed.state, 'shown');
  assert.deepEqual(mixed.texts, ['Title', 'Bonjour']);
});

test('the line under the words says how to go back, or why it stayed', () => {
  const note = (state, from = null) => renderToHtml(createElement(mod.TranslateNote, {
    view: { state, from, toggle() {} },
  }));

  assert.equal(note('idle'), '');
  assert.match(note('pending'), /Translating…/);
  assert.match(note('failed'), /Couldn&#x27;t translate this/);
  assert.match(note('limit'), /You&#x27;ve translated a lot today/);
  assert.match(note('same'), /Already in English/);
  assert.match(note('shown', 'zh-CN'), /Translated from Chinese/);
  assert.match(note('shown', 'zh-CN'), /Show original/);
  assert.match(note('original', 'zh-CN'), /Show translation/);
  // A source the model did not name still says the words were translated.
  assert.match(note('shown', null), /Translated/);
});

test('the request page offers Translate only on someone else’s request, beside Show more', () => {
  const src = read(HEAD);
  assert.match(src, /const canTranslate = !!myUsername && !!r\.asker && r\.asker !== myUsername && sources\.length > 0;/);
  assert.match(src, /const translation = useTranslate\(sources, \{ enabled: canTranslate \}\);/);
  assert.match(src, /translate=\{!canTranslate \|\| editing \|\| \(translation\.state !== 'idle' && translation\.state !== 'pending'\) \? null : \(/);
  assert.match(src, /className="dev-ws-reveal dev-ws-reveal-start touch-target-32 dev-request-more"/);
  // #6081: the note line is drawn in every state but idle, "Translating…"
  // included, so the words say what is happening while the model answers.
  assert.match(src, /note=\{!canTranslate \|\| translation\.state === 'idle' \? undefined : <TranslateNote view=\{translation\}/);
  // The translated title and words replace the originals, in the same places.
  assert.match(src, /const shownTitle = translation\.state === 'shown' && titleAt >= 0 \? translation\.texts\[titleAt\] : r\.title;/);
  assert.match(src, /const shownBody = translation\.state === 'shown' && bodyAt >= 0 \? translation\.texts\[bodyAt\] : null;/);
  assert.match(src, /const bodyHtml = useMemo\(\(\) => \(shownBody == null \? r\.bodyHtml : translatedWords\(shownBody\)\), \[shownBody, r\.bodyHtml\]\);/);
});

test('a message gets Translate in its ⋯ menu, only when someone else wrote it', () => {
  const src = read(ROW);
  // A person's words only: the bot's cards and the platform's notices are
  // not user-generated content, and the bot already writes in the reader's
  // language.
  assert.match(src, /const canTranslate = !mine && !message\.sender\.bot && !message\.system\s*&& !!message\.content && !message\.deleted && !message\.moderated;/);
  assert.match(src, /const translation = useTranslate\(message\.content \? \[message\.content\] : \[\], \{\s*enabled: canTranslate,/);
  assert.match(src, /if \(canTranslate\) \{/);
  assert.match(src, /key: 'translate', label, icon: GlobeIcon, disabled: translation\.state === 'pending'/);
  assert.match(src, /const translatedBody = translation\.state === 'shown' && !editing\s*\? <>\{quote\}<MessageMarkdown content=\{translation\.texts\[0\]\}/);
  assert.match(src, /<TranslateNote view=\{translation\} className="mt-1" \/>/);
});

test('the request view carries the markdown its words were built from', () => {
  assert.match(read('public/js/app-view.js'), /bodyMarkdown: words\.text,/);
  assert.match(read('frontend/src/features/dev-board/topic/model.ts'), /bodyMarkdown: string;/);
});

test('every id these screens ask for exists in English', () => {
  const ids = [
    'messages:row.menu.translate',
    'messages:row.menu.showOriginal',
    'messages:row.menu.showTranslation',
    'messages:translate.from',
    'messages:translate.translated',
    'messages:translate.pending',
    'messages:translate.failed',
    'messages:translate.same',
    'messages:translate.showOriginal',
    'messages:translate.showTranslation',
    'messages:translate.limit',
    'project:topic.request.words.translate',
  ];
  for (const id of ids) assert.ok(message(id), id);
});

// ── #6525: automatic translation ────────────────────────────────────────

const IOS = { useMessages: () => () => '' };

/**
 * Just enough React for several hooks at once. A bundled hook calls the React
 * it was loaded with, so one environment is made per loaded module; each
 * mount is a component with its own hooks, and its state re-renders it.
 */
function fakeReact() {
  const instances = new Set();
  let current = null;

  const changed = (before, after) => !before || !after
    || before.length !== after.length || before.some((v, i) => !Object.is(v, after[i]));

  function render(inst) {
    current = inst;
    inst.cursor = 0;
    inst.pending = [];
    inst.last = inst.renderFn();
    const runs = inst.pending;
    inst.pending = [];
    for (const run of runs) run();
    current = null;
  }
  function schedule(inst) {
    if (inst.unmounted || inst.scheduled) return;
    inst.scheduled = true;
    queueMicrotask(() => {
      inst.scheduled = false;
      if (!inst.unmounted) render(inst);
    });
  }
  function slot(init) {
    const inst = current;
    const i = inst.cursor++;
    if (!(i in inst.slots)) inst.slots[i] = init();
    return inst.slots[i];
  }

  const React = {
    useRef(value) { return slot(() => ({ current: value })); },
    useState(value) {
      const inst = current;
      const state = slot(() => ({ value }));
      if (!state.set) {
        state.set = (next) => {
          const v = typeof next === 'function' ? next(state.value) : next;
          if (Object.is(v, state.value)) return;
          state.value = v;
          schedule(inst);
        };
      }
      return [state.value, state.set];
    },
    useCallback(fn, deps) {
      const inst = current;
      const i = inst.cursor++;
      if (!inst.slots[i] || changed(inst.slots[i].deps, deps)) inst.slots[i] = { deps, value: fn };
      return inst.slots[i].value;
    },
    useEffect(fn, deps) {
      const inst = current;
      const i = inst.cursor++;
      const previous = inst.slots[i];
      if (previous && !changed(previous.deps, deps)) return;
      inst.slots[i] = { deps, cleanup: null };
      inst.pending.push(() => {
        if (previous && typeof previous.cleanup === 'function') previous.cleanup();
        const cleanup = fn();
        inst.slots[i].cleanup = typeof cleanup === 'function' ? cleanup : null;
      });
    },
  };
  React.useLayoutEffect = React.useEffect;

  function mount(renderFn) {
    const inst = { slots: [], cursor: 0, pending: [], renderFn, last: undefined, scheduled: false, unmounted: false };
    instances.add(inst);
    render(inst);
    return {
      view: () => inst.last,
      unmount() {
        inst.unmounted = true;
        for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup();
      },
    };
  }

  return {
    React,
    mount,
    unmountAll() { for (const inst of instances) if (!inst.unmounted) { inst.unmounted = true; for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup(); } },
  };
}

const answer = (results, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ results }),
});

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// A fresh module per case: its ANSWERS and its queue belong to that copy.
function hookModule(t, fetchImpl) {
  const env = fakeReact();
  const loaded = loadTsx(TRANSLATE, { stubs: { react: env.React, '../../lib/i18n/react': IOS } });
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = saved; env.unmountAll(); });
  return { mod: loaded, mount: env.mount };
}

function noteOf(view) {
  const noteMod = loadTsx(TRANSLATE);
  return renderToHtml(createElement(noteMod.TranslateNote, {
    view: { state: view.state, from: view.from, toggle() {} },
  }));
}

test('worthAsking: only words someone could read in another language', () => {
  const { worthAsking } = mod;
  for (const text of ['', '   ', '🙂🔥', 'https://example.com/a?b=c', 'www.example.com', '@nisa', '#42', '`npm test`', '```\nconst a = 1;\n```', '🙂 https://x.test/1']) {
    assert.equal(worthAsking(text), false, JSON.stringify(text));
  }
  for (const text of ['Pagi semua', 'Merhaba arkadaşlar', 'こんにちは', 'update 2 is out', 'Hi @nisa, thanks!']) {
    assert.equal(worthAsking(text), true, JSON.stringify(text));
  }
});

test('an automatic answer with nothing to show stays quiet', async (t) => {
  const cases = [
    ['same', answer([{ state: 'same' }])],
    ['a failure', answer([{ state: 'failed' }], 500)],
    ['the daily limit', answer([], 429)],
  ];
  const texts = ['Pagi semua', 'Bonsoir tout le monde', 'Hola a todos'];
  for (let i = 0; i < cases.length; i += 1) {
    const [name, response] = cases[i];
    const { mod: m, mount } = hookModule(t, async () => response);
    const component = mount(() => m.useTranslate([texts[i]], { auto: true }));
    assert.equal(component.view().askAuto(), true, name);
    await settle();
    const after = component.view();
    assert.equal(after.state, 'idle', `${name}: the words stay as written`);
    assert.deepEqual(after.texts, [texts[i]], name);
    assert.equal(noteOf(after), '', `${name}: no line under the words`);
  }
});

test('an automatic translation shows, with the line naming its language', async (t) => {
  let sent = null;
  const { mod: m, mount } = hookModule(t, async (_url, init) => {
    sent = JSON.parse(init.body);
    return answer([{ state: 'translated', text: 'Morning everyone', from: 'id' }]);
  });
  const component = mount(() => m.useTranslate(['Pagi semua'], { auto: true }));
  assert.equal(component.view().state, 'idle', 'the first render is the original words');
  component.view().askAuto();
  await settle();
  const view = component.view();
  assert.equal(view.state, 'shown');
  assert.deepEqual(view.texts, ['Morning everyone']);
  assert.equal(view.origin, 'auto');
  // #6525: the request says it is the page translating itself, so a bound
  // that stops it answers quietly instead of with a console-visible error.
  assert.equal(sent.auto, true);
  assert.deepEqual(sent.texts, ['Pagi semua']);
  const note = noteOf(view);
  assert.match(note, /Translated from Indonesian/);
  assert.match(note, /Show original/);
});

test('a tapped daily limit still says so, and a tap is the tap origin', async (t) => {
  let sent = null;
  const { mod: m, mount } = hookModule(t, async (_url, init) => {
    sent = JSON.parse(init.body);
    return answer([], 429);
  });
  const component = mount(() => m.useTranslate(['Pagi semua'], { auto: true }));
  component.view().ask();
  await settle();
  assert.equal(component.view().origin, 'tap');
  assert.equal(component.view().state, 'limit');
  assert.match(noteOf(component.view()), /You&#x27;ve translated a lot today/);
  // A tap keeps the status it had (#6081): only an automatic ask is quiet.
  assert.equal(sent.auto, undefined);
});

test('the queue: two on their way at once, twenty a minute, none after a 429', async (t) => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  let started = 0;
  let active = 0;
  let most = 0;
  let mode = 'defer';
  const waiting = [];
  const { mod: m, mount } = hookModule(t, () => {
    started += 1;
    if (mode === 'limit') return Promise.resolve(answer([], 429));
    if (mode === 'same') return Promise.resolve(answer([{ state: 'same' }]));
    active += 1;
    most = Math.max(most, active);
    return new Promise((resolve) => {
      waiting.push(() => {
        active -= 1;
        resolve(answer([{ state: 'same' }]));
      });
    });
  });

  const askText = (text) => mount(() => m.useTranslate([text], { auto: true })).view().askAuto();
  async function drain() {
    while (waiting.length) {
      waiting.shift()();
      await settle(3);
    }
  }

  for (let i = 0; i < 25; i += 1) assert.equal(askText(`message number ${i}`), true);
  assert.equal(started, 2, 'only two requests are on their way at once');
  await drain();
  assert.equal(most, 2, 'never more than two in flight');
  assert.equal(started, 20, 'the twenty a minute are started, the rest wait');

  // The window turns over: the rows still waiting go then.
  now += 61_000;
  assert.equal(askText('a message after the minute'), true);
  await drain();
  assert.equal(started, 26, 'the held-back rows started once the minute passed');

  // A 429 drops what waits and stops every ask for a minute.
  mode = 'limit';
  started = 0;
  for (let i = 0; i < 3; i += 1) askText(`burst ${i}`);
  await settle();
  const afterLimit = started;
  assert.ok(afterLimit <= 2, 'the two in flight may answer 429');
  askText('while paused');
  await settle();
  assert.equal(started, afterLimit, 'nothing starts for a minute after a 429');
  now += 30_000;
  askText('still paused');
  await settle();
  assert.equal(started, afterLimit, 'half a minute is still paused');
  now += 31_000;
  mode = 'same';
  askText('after the pause');
  await settle();
  assert.ok(started > afterLimit, `past the minute, asking resumes (started ${started}, afterLimit ${afterLimit})`);
});

test('a known answer costs no request', async (t) => {
  let calls = 0;
  const { mod: m, mount } = hookModule(t, async () => {
    calls += 1;
    return answer([{ state: 'translated', text: 'Hello', from: 'id' }]);
  });
  const first = mount(() => m.useTranslate(['Pagi semua'], { auto: true }));
  first.view().askAuto();
  await settle();
  assert.equal(calls, 1);

  const second = mount(() => m.useTranslate(['Pagi semua'], { auto: true }));
  assert.equal(second.view().askAuto(), true);
  await settle();
  assert.equal(calls, 1, 'the session remembers the answer');
  assert.equal(second.view().state, 'shown');
});

test('a chat row asks for itself, but only for someone else’s words and only on screen', () => {
  const src = read(ROW);
  assert.match(src, /const canTranslate = !mine && !message\.sender\.bot && !message\.system\s*&& !!message\.content && !message\.deleted && !message\.moderated;/);
  assert.match(src, /const autoTranslate = canTranslate\s*&& !message\.pending && !message\.queued && !message\.failed\s*&& typeof window !== 'undefined' && !!window\.App\?\.user && worthAsking\(message\.content\);/);
  assert.match(src, /auto: autoTranslate,/);
  assert.match(src, /const article = useRef<HTMLElement>\(null\);/);
  assert.match(src, /return observeAutoTranslate\(el, askAuto\);/);
  assert.match(src, /<article ref=\{article\}/);
  // #6081 keeps its answer: a request's words are asked for on a tap only.
  assert.doesNotMatch(read(HEAD), /auto:/);
});
