// UI contract for the #800 model selector in frontend/src/features/dev-chat/dev-chat.js.
//
// Same approach as openSession-streaming-reset.test.js: dev-chat.js is a
// plain browser script (`const DevChat = {…}`), so we load its source
// into a vm context, expose DevChat, and drive the REAL renderChatView
// against a minimal fake DOM — asserting on the markup a user would see
// rather than on tokens in the source.
//
// What must hold:
//   1. No price text ($ / MTok) survives anywhere in the picker — that
//      was the whole point of the issue. Nor any measured figure: the
//      picker is entirely static editorial copy now.
//   2. Each option reads "<label>: <what kind of work it is for>", and
//      the copy positions Opus and Fable as peers (heavy coding vs.
//      design/taste) rather than a size ladder.
//   3. The composer paints NO caption under the dropdown (#1353 removed
//      it — the option the user picked already carries the guidance), while
//      the sentence itself survives for app-view's Generate-proposal popup,
//      where the list is met once.
//   4. Missing guidance degrades to bare labels — never a crash.
//   5. The guidance copy in dev-chat.js's seed map has not drifted from
//      src/services/models.js, which is authoritative.
//
// Run with: node --test tests/model-selector-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge } = require('./lib/dev-composer-html');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// ── Minimal fake DOM ────────────────────────────────────────────────
// Registry-backed like the streaming-reset harness (getElementById keeps
// returning the same handle across innerHTML rewrites), plus real
// listener capture and a real classList.toggle, so a class the composer
// toggles at runtime can be asserted.
function makeElement(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id,
    style: {},
    dataset: {},
    _attrs: {},
    _children: [],
    _listeners: listeners,
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    scrollTop: 0,
    className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !classes.has(x) : !!force;
        if (on) classes.add(x); else classes.delete(x);
        return on;
      },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    // Test seam: dispatch a captured listener.
    _fire(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    insertBefore(c) { this._children.push(c); return c; },
    replaceChildren() { this._children = []; },
    append() {}, prepend() {}, remove() {},
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, setSelectionRange() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
  };
}

function makeHarness() {
  // #1078: the whole composer is features/dev-chat/composer.tsx's, so
  // `renderChatView` writes an empty `#dc-composer-bar` and publishes a view
  // model into it. `html` below is the template's markup PLUS the rendered
  // composer, which is what a reader actually sees.
  const composer = makeComposerBridge();
  const registry = new Map();
  // #1191: the runner strip's markup is
  // features/dev-chat/composer-chrome.tsx's, so `_renderRunnerControls()`
  // publishes a { kind, label } view. `runnerHtml()` below renders the
  // component from it, so the assertions still read the strip as a reader
  // sees it — and the select's change handler is a prop, invoked directly.
  let runnerView = { kind: 'none', label: '' };
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
  };

  const storage = new Map();
  const sandbox = {
    console,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true },
    EventSource: class { constructor() { this.readyState = 1; } close() {} },
    URL,
    Blob: class { constructor() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    // Real-ish escaping so an assertion on "—" / "·" isn't defeated by a
    // pass-through stub, while still keeping the markup readable.
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    UsernodeReact: {
      devChat: {
        mountRunnerControls: () => {},
        publishRunner: (v) => { runnerView = v; },
        mountQuickReplies: () => {},
        publishQuickReplies: () => {},
        mountBudgetPill: () => {},
        publishBudgetPill: () => {},
        mountAttachStrip: () => {},
        publishAttachStrip: () => {},
      },
    },
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The runner strip publishes through the composer bridge too, so its own
  // capture below rides on the same object.
  sandbox.UsernodeReact = Object.assign({}, sandbox.UsernodeReact, {
    devChat: Object.assign({}, composer.bridge, {
      publishRunner: (v) => { runnerView = v; composer.bridge.publishRunner(v); },
    }),
  });

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize the heavy DOM plumbing renderChatView calls — none of it
  // touches the model row, and all of it wants a real document.
  for (const fn of [
    'renderMessages', 'refreshBudget', 'initScrollTracking', 'restoreSessionScroll',
    '_setupTextareaResize', '_setupKeyboardShortcuts', '_restoreDraft',
    'renderSessionList', '_loadSpecViewer', '_startHeartbeat', '_setNotifyOnDone',
    '_renderQuickReplies', '_wireQuickReplies',
    '_renderBanners', '_renderSessionHeader',
    '_setupAttachments', '_renderSavedDrafts', '_wireSavedDrafts', '_syncSaveDraftBtn',
  ]) DevChat[fn] = () => {};
  DevChat.currentSession = { id: 7, branch_name: 'dev/x', session_title: 'A change' };
  DevChat.messages = [];

  return {
    DevChat,
    getEl,
    composer,
    // The kit stub the module reads as `window.PlatformUI`. Exposed so a
    // test can swap in a menu recorder — dev-chat.js resolves it at call
    // time, and inside the vm context `window` IS this sandbox.
    kit: sandbox.PlatformUI,
    sandbox,
    runnerView: () => JSON.parse(JSON.stringify(runnerView)),
    runnerHtml: () => renderComponent(
      'frontend/src/features/dev-chat/composer-chrome.tsx', 'RunnerControlsView',
      JSON.parse(JSON.stringify(runnerView)),
    ),
  };
}

// The three-model map GET /api/models sends: label + guidance copy, and
// nothing measured. Mirrors src/services/models.js — the copy-drift guard
// at the bottom of this file is what keeps that true.
function guidanceMap() {
  return {
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      changeSize: {
        short: 'simple, small changes',
        long: 'One small thing at a time: a text tweak, a colour, a single file.',
      },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      changeSize: {
        short: 'general coding work',
        long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
      },
    },
    'claude-fable-5-1': {
      label: 'Fable 5.1',
      changeSize: {
        short: 'design, taste, and difficult coding',
        long: 'Design and taste (how a screen looks, reads, and feels) plus the most difficult coding work.',
      },
    },
  };
}

function render(overrides) {
  const h = makeHarness();
  h.DevChat.MODELS = (overrides && overrides.models) || guidanceMap();
  h.DevChat.selectedModel = (overrides && overrides.selected) || 'claude-opus-5';
  if (overrides && overrides.session) h.DevChat.currentSession = overrides.session;
  // build-venues.js is outside this focused harness. Mirror its ordinary
  // in-chat result so provider-specific composer controls are exercised.
  h.DevChat._currentVenueId = () => h.DevChat._isOpenRouterSession()
    ? 'usernode-openrouter'
    : 'usernode-claude';
  h.DevChat.renderChatView();
  return {
    ...h,
    html: h.getEl('dc-view').innerHTML + h.composer.html(),
    view: () => h.composer.state(),
  };
}

// ── 1. no price text anywhere ───────────────────────────────────────

test('the composer renders no price text at all (#800)', () => {
  const { html } = render();
  assert.ok(!html.includes('MTok'), 'found "MTok" in the composer markup');
  // Valid again now that the picker shows no measured cost figure either.
  assert.ok(!html.includes('$'), 'found a "$" in the composer markup');
});

test('the seed MODELS map carries no price and no measured figures', () => {
  const { DevChat } = makeHarness();
  for (const [id, meta] of Object.entries(DevChat.MODELS)) {
    assert.equal(meta.outputCostPerMTok, undefined, `${id} still seeds a price`);
    assert.equal(meta.stats, undefined, `${id} still seeds a stats block`);
  }
  // And Haiku is gone from the seed set too, so the dropdown never offers
  // it even before /api/models resolves.
  assert.ok(!('claude-haiku-4-5' in DevChat.MODELS));
});

// ── 2. option text: what kind of work, not how big ──────────────────

test('the composer\'s picker is a sheet button naming the model (#1589)', () => {
  // #1589's finding was about a CLOSED <select>: it shows the selected
  // option's own text, so the guidance set its width — 276px of a 344px
  // strip on a phone, which put the label above the control and the credit
  // meter below it. Names brought it to 89px and the row to one line.
  //
  // The control is a button opening the kit's menu now, so there are no
  // options in the markup at all — but the closed control is still exactly
  // the name, which is what that measurement was about.
  const { html } = render();
  assert.ok(!/<option/.test(html), `no native dropdown survives; got: ${html}`);
  assert.match(html, /<button[^>]*id="dc-model-select"[^>]*aria-haspopup="menu"/);
  assert.match(html, /<span class="dc-model-name">Opus 5<\/span>/);
  assert.ok(!html.includes('general coding work'),
    'the guidance belongs to the OPEN sheet — in the closed control it is '
    + 'the width problem #1589 measured.');
  assert.ok(!html.includes('simple, small changes'),
    'and the unselected models are not in the composer\'s markup at all.');
});

test('…and the sheet\'s rows carry the guidance the button cannot (2B)', () => {
  // The blurb comes back where there is room for it: one row, one line. It
  // is `changeSize.short` rather than `modelOptionText`, because the row
  // already opens with the name and the helper would repeat it.
  const { view } = render();
  assert.deepEqual(view().models.options, [
    { id: 'claude-sonnet-5', label: 'Sonnet 5', blurb: 'simple, small changes' },
    { id: 'claude-opus-5', label: 'Opus 5', blurb: 'general coding work' },
    {
      id: 'claude-fable-5-1',
      label: 'Fable 5.1',
      blurb: 'design, taste, and difficult coding',
    },
  ]);
  assert.equal(view().models.selectedLabel, 'Opus 5');
});

test('openModelSheet asks the kit, marks the current row, and picks (2B)', () => {
  // The mirror of openVenueSheet: the kit sets row labels with textContent,
  // so the blurb and the tick ride IN the label, and the tick trails the
  // row exactly as build-venues.js puts it.
  const h = makeHarness();
  h.DevChat.MODELS = guidanceMap();
  h.DevChat.selectedModel = 'claude-opus-5';
  h.DevChat._currentVenueId = () => 'usernode-claude';
  let opened = null;
  h.sandbox.PlatformUI = {
    hasKit: () => true,
    menu: (opts) => { opened = opts; return Promise.resolve(null); },
  };
  h.DevChat.openModelSheet(null);
  assert.ok(opened, 'the kit menu was never opened');
  assert.match(opened.title, /model/i);
  // `Array.from` rather than `.map`: `items` was built inside the vm
  // context, so its Array prototype is that realm's and deepEqual compares
  // prototypes.
  assert.deepEqual(Array.from(opened.items, (i) => i.label), [
    'Sonnet 5 \u2014 simple, small changes',
    'Opus 5 \u2014 general coding work \u2713',
    'Fable 5.1 \u2014 design, taste, and difficult coding',
  ]);
  opened.items[2].handler();
  assert.equal(h.DevChat.selectedModel, 'claude-fable-5-1');
});

test('openModelSheet is a no-op without the kit, exactly as the venue sheet is', () => {
  const h = makeHarness();
  h.DevChat.MODELS = guidanceMap();
  h.DevChat.selectedModel = 'claude-opus-5';
  h.DevChat._currentVenueId = () => 'usernode-claude';
  h.sandbox.PlatformUI = { hasKit: () => false, menu: () => {
    throw new Error('menu must not be reached without a kit');
  } };
  h.DevChat.openModelSheet(null);
  assert.equal(h.DevChat.selectedModel, 'claude-opus-5');
});

test('the declared checks follow the control they guard (#1589, 2B)', () => {
  // These two used to select `#dc-model-select option[value=…]`, one per
  // model. A sheet has no options in the document — only the SELECTED model
  // is on screen — so the pair became what a browser can still see: the
  // closed control is a menu button naming the model, and no native
  // dropdown is left in the composer. The guidance positioning they once
  // guarded is asserted on the shared helper below, and still rendered by
  // the Generate-proposal picker.
  const dapp = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const picker = dapp.tests.filter(
    (t) => (t.expectSelector || '').includes('dc-model-select')
      || (t.expectSelector || '').includes('#dc-composer-controls:not(:has(select))'));
  assert.equal(picker.length, 2, 'both picker checks are still declared');
  assert.ok(picker.some((t) => /aria-haspopup="menu"/.test(t.expectSelector)
    && t.expectText === 'Opus 5'), 'the closed control is still guarded');
  assert.ok(picker.some((t) => /:not\(:has\(select\)\)/.test(t.expectSelector)),
    'and so is the absence of the <select> this replaced');
  for (const t of picker) {
    assert.ok(!/coding work|design, taste/.test(t.expectText || ''),
      'a check asking for the guidance in the CLOSED control would fail on '
      + 'every build — it lives in the open sheet now');
  }
});

test('the guidance copy survives on the helper and proposal summaries stay concise', () => {
  // The positioning encoded by `changeSize.short` remains the same:
  // Sonnet = simple/small, Opus = general coding, Fable = design/taste plus
  // the most difficult coding. Generate proposal now renders the short value
  // as a separate summary instead of concatenating it into an option label.
  const { DevChat } = makeHarness();
  const text = (id) => DevChat.modelOptionText(DevChat.MODELS[id]);
  assert.equal(text('claude-sonnet-5'), 'Sonnet 5: simple, small changes');
  assert.equal(text('claude-opus-5'), 'Opus 5: general coding work');
  assert.equal(text('claude-fable-5-1'), 'Fable 5.1: design, taste, and difficult coding');
  const APP_VIEW = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
  );
  assert.match(APP_VIEW, /m\.changeSize && m\.changeSize\.short/,
    'the proposal summary reads the same authoritative short guidance');
  assert.doesNotMatch(APP_VIEW, /DevChat\.modelOptionText\(m\)/,
    'the dialog no longer builds a verbose select label');
});

test('OpenRouter sessions show their pinned model and never show the Claude model picker', () => {
  const { html } = render({
    session: {
      id: 7,
      branch_name: 'dev/openrouter',
      session_title: 'OpenRouter change',
      agent_backend: 'codex_openrouter',
      agent_model: 'anthropic/claude-sonnet-4.5',
    },
  });

  assert.match(html, /OpenRouter model:/);
  assert.match(html, /id="dc-openrouter-model"/);
  assert.match(html, /anthropic\/claude-sonnet-4\.5/);
  assert.match(html, /id="dc-openrouter-model-change"/);
  assert.match(html, /Browse models/);
  assert.match(html, /aria-label="Browse and filter OpenRouter models"/);
  assert.match(html, /All chat and coding in this session use anthropic\/claude-sonnet-4\.5 through OpenRouter and bill your OpenRouter key\./);

  assert.doesNotMatch(html, /Chat model:/);
  assert.doesNotMatch(html, /id="dc-model-select"/);
  assert.doesNotMatch(html, /Sonnet 5: simple, small changes/);
  assert.doesNotMatch(html, /Opus 5: general coding work/);
  assert.doesNotMatch(html, /Fable 5.1: design, taste, and difficult coding/);
});

test('the OpenRouter model button opens the provider-locked catalog', () => {
  const h = makeHarness();
  h.DevChat.currentSession = {
    id: 7,
    branch_name: 'dev/openrouter',
    agent_backend: 'codex_openrouter',
    agent_model: 'deepseek/deepseek-v4-flash',
  };
  h.DevChat._currentVenueId = () => 'usernode-openrouter';
  let calledWith = null;
  h.DevChat._switchCurrentCodingAgent = (...args) => { calledWith = args; };

  h.DevChat.renderChatView();
  // #1078: the button is the composer component's, so its click dispatches
  // into DevChat by NAME rather than through a listener bound per render.
  assert.match(h.composer.html(), /id="dc-openrouter-model-change"/,
    'the button renders');
  h.DevChat._onOpenRouterModelChange();

  assert.ok(calledWith, 'the Browse models button was not wired');
  assert.equal(calledWith[0], null);
  assert.equal(calledWith[1].fixedBackend, 'codex_openrouter');
});

test('no option implies a size ladder between Opus and Fable', () => {
  // The superseded copy positioned Fable as the "bigger" model. Opus is
  // now the general coding pick and Fable the taste pick, so those strings
  // must not come back. On the HELPER since #1589: the composer renders
  // names, so its markup would pass this vacuously.
  const { DevChat } = makeHarness();
  const all = Object.values(DevChat.MODELS).map((m) => DevChat.modelOptionText(m)).join(' | ');
  assert.ok(!all.includes('Fable 5.1: big or tricky work'));
  assert.ok(!all.includes('a few files'));
  // #809: Opus is the general-purpose coding model, not one reserved for
  // big or tricky changes — the old restrictive wording must not return.
  assert.ok(
    !all.includes('Opus 5: big or tricky coding'),
    'Opus option reverted to the superseded "big or tricky" framing'
  );
});

test('modelOptionText degrades to the bare label without guidance', () => {
  const { DevChat } = makeHarness();
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5' }), 'Opus 5');
  assert.equal(DevChat.modelOptionText({ label: 'Opus 5', changeSize: {} }), 'Opus 5');
  assert.equal(DevChat.modelOptionText(null), '');
});

// ── 3. the caption the composer no longer paints ────────────────────

test('the composer paints no model caption at all (#1353)', () => {
  // It said "Opus 5: best for anything from a quick fix to a multi-file
  // feature, a refactor, or debugging that needs real digging." directly
  // under an <option> reading "Opus 5: general coding work", on every
  // render of every session. Two sentences of the same advice, and the
  // longer one was between the picker and the text box.
  const { html, getEl, DevChat } = render({ selected: 'claude-opus-5' });
  assert.ok(!html.includes('dc-model-note'), 'no caption element is rendered');
  assert.ok(!html.includes('best for'), 'and none of its copy either');
  assert.equal(getEl('dc-model-note').textContent, '', 'nothing fills one after render');
  assert.equal(typeof DevChat._renderModelNote, 'undefined',
    'and the filler is gone rather than left pointing at an absent element');
});

test('the retired long-caption helper stays safe but Generate proposal no longer uses it', () => {
  const { DevChat } = makeHarness();
  assert.equal(
    DevChat.modelNoteText(DevChat.MODELS['claude-opus-5']),
    'Opus 5: best for anything from a quick fix to a multi-file feature, '
      + 'a refactor, or debugging that needs real digging.'
  );
  assert.equal(
    DevChat.modelNoteText(DevChat.MODELS['claude-sonnet-5']),
    'Sonnet 5: best for one small thing at a time: a text tweak, a colour, a single file.'
  );
  assert.equal(DevChat.modelNoteText({ label: 'Opus 5' }), '', 'no guidance, no sentence');
  assert.match(DevChat.MODEL_GUIDANCE_TOOLTIP, /general coding pick/);
  assert.match(DevChat.MODEL_GUIDANCE_TOOLTIP, /genuinely difficult/);
  assert.ok(
    !/Bigger models/i.test(DevChat.MODEL_GUIDANCE_TOOLTIP),
    'tooltip reverted to the superseded "bigger models cost more" framing'
  );
  const APP_VIEW = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
  );
  assert.doesNotMatch(APP_VIEW, /DevChat\.modelNoteText\(m\)/,
    'the simplified dialog does not render the redundant long caption');
});

test('the picker still follows the selection without a caption to update', () => {
  // The sheet's handler dispatches into `_onModelPicked` — which also
  // republishes, so the model carries the new selection AND the closed
  // control's label, rather than an element keeping either.
  const { DevChat, view } = render({ selected: 'claude-opus-5' });
  assert.equal(view().models.selected, 'claude-opus-5');
  assert.equal(view().models.selectedLabel, 'Opus 5');
  DevChat._onModelPicked('claude-fable-5-1');
  assert.equal(DevChat.selectedModel, 'claude-fable-5-1');
  assert.equal(view().models.selected, 'claude-fable-5-1');
  assert.equal(view().models.selectedLabel, 'Fable 5.1');
});

test('the Fable option owns difficult coding without displacing Opus as the general pick', () => {
  // The trio's positioning: Sonnet = simple/small, Opus = general
  // coding, Fable = design/taste plus the MOST difficult coding. Fable
  // gaining "difficult coding" must not revert Opus to a
  // big-or-tricky-only framing. Asserted on the helper since #1589 moved
  // this copy out of the composer's own markup.
  const { DevChat } = makeHarness();
  const text = (id) => DevChat.modelOptionText(DevChat.MODELS[id]);
  assert.equal(text('claude-fable-5-1'), 'Fable 5.1: design, taste, and difficult coding');
  assert.notEqual(text('claude-opus-5'), 'Opus 5: big or tricky coding');
  assert.equal(text('claude-opus-5'), 'Opus 5: general coding work');
});

// ── 4. missing guidance degrades, never crashes ─────────────────────

test('a model with no guidance renders a bare label', () => {
  // Since #1589 every composer option is a bare label; what this still pins
  // is that a meta with no `changeSize` reaches the picker at all rather
  // than rendering an empty option, and that no caption comes back with it.
  const models = { 'claude-opus-5': { label: 'Opus 5' } };
  const { html, view } = render({ models });

  assert.ok(html.includes('<span class="dc-model-name">Opus 5</span>'),
    'expected the bare label on the closed control');
  assert.deepEqual(view().models.options, [
    { id: 'claude-opus-5', label: 'Opus 5', blurb: '' }]);
  assert.ok(!html.includes('best for'));
});

test('an option with no label at all falls back to the model id', () => {
  // The composer reads `meta.label` directly now instead of going through
  // modelOptionText, so its own empty case has to be its own.
  const { html } = render({ models: { 'claude-opus-5': {} } });
  assert.ok(html.includes('<span class="dc-model-name">claude-opus-5</span>'),
    'an id is a worse name than "Opus 5" and a much better one than nothing');
});

test('a garbage MODELS entry does not throw the whole chat view', () => {
  assert.doesNotThrow(() => {
    render({ models: { 'claude-opus-5': { label: 'Opus 5', changeSize: null } } });
  });
});

// ── 5. copy-drift guard ─────────────────────────────────────────────
// The guidance copy lives in TWO places by design: src/services/models.js
// is authoritative, and dev-chat.js seeds a duplicate purely so the
// dropdown paints correctly before /api/models resolves. Nothing else in
// the suite would notice them diverging, and a drift would show users one
// string then silently swap it for another mid-load.

test('the dev-chat seed map matches src/services/models.js exactly', () => {
  const server = require('../src/services/models');
  const { DevChat } = makeHarness();

  assert.deepEqual(
    Object.keys(DevChat.MODELS).sort(),
    Object.keys(server.MODELS).sort(),
    'seed map and allowlist offer different models'
  );

  for (const [id, serverMeta] of Object.entries(server.MODELS)) {
    const seedMeta = DevChat.MODELS[id];
    assert.ok(seedMeta, `${id} missing from the dev-chat seed map`);
    assert.equal(seedMeta.label, serverMeta.label, `${id} label drifted`);
    assert.equal(
      seedMeta.changeSize.short, serverMeta.changeSize.short,
      `${id} changeSize.short drifted between models.js and dev-chat.js`
    );
    assert.equal(
      seedMeta.changeSize.long, serverMeta.changeSize.long,
      `${id} changeSize.long drifted between models.js and dev-chat.js`
    );
  }
});

// ── #907: the "Run on" runner controls, in the same composer row ────

test('the composer is byte-identical for a session with no machine attached', () => {
  const { html, getEl } = render();
  // The host span ships in the markup so nothing has to be inserted later,
  // and stays empty — .dc-runner:empty is display:none, so no gap appears.
  assert.ok(html.includes('id="dc-runner"'), 'the host span is in the composer');
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._renderRunnerControls();
  assert.equal(runnerHtml(), '', 'the strip draws nothing at all');
  // Nobody who never runs the CLI sees the words.
  assert.ok(!html.includes('Run on:'));
  assert.ok(!html.includes('Running on your machine'));
});

test('an attached machine gets a selector and a live chip', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local',
    localAgent: { leaseId: '7', label: "Evan's laptop", runtime: 'claude-code' },
  });
  const html = runnerHtml();
  assert.match(html, /Run on:/);
  assert.match(html, /<option value="local"[^>]*>Evan&#x27;s laptop<\/option>/);
  assert.match(html, /<option value="platform">Homeroom<\/option>/);
  assert.match(html, /Running on your machine/);
  // The chip explains the division of labour, because "running on your
  // machine" otherwise reads as "Homeroom has stopped doing anything".
  assert.match(html, /Homeroom still opens the PR/);
});

test('a label the user typed on their own machine is escaped, not interpreted', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local',
    localAgent: { leaseId: '7', label: '<img src=x onerror=alert(1)>' },
  });
  const html = runnerHtml();
  assert.ok(!html.includes('<img'), 'the label reached the DOM unescaped');
  assert.match(html, /&lt;img/);
  // It rides in a `title` too, which is the attribute context the string
  // renderer needed a separate escape for.
  assert.match(html, /title="The last turn ran on|title="Spec and coding turns in this session run on &lt;img/);
});

test('a machine that has gone leaves a past-tense chip, not a live one', () => {
  const { DevChat, runnerHtml } = makeHarness();
  DevChat._applyRunnerState({
    runner: 'local', runnerLabel: 'laptop', localAgent: { leaseId: '7', label: 'laptop' },
  });
  // The lease is gone but chat_sessions still remembers where the last turn
  // ran, which is what /status sends as runnerLabel.
  DevChat._applyRunnerState({ runner: 'local', runnerLabel: 'laptop', localAgent: null });
  const html = runnerHtml();
  assert.match(html, /dc-runner-chip-past/);
  assert.match(html, /Last turn: laptop/);
  // No selector: there is nothing left to select between.
  assert.ok(!html.includes('dc-runner-select'));
  assert.match(html, /the next turn runs on Homeroom/);
});

test('choosing Homeroom hands the session back and never leaves a half-set select', async () => {
  const { DevChat, runnerView } = makeHarness();
  const requests = [];
  let confirmed = true;
  DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '7', label: 'laptop' } });
  globalThis.__runnerFetch = null;
  DevChat._handBackToUsernode = async function patched() {
    const agent = DevChat._localAgent;
    if (!agent || agent.demo || !confirmed) return;
    requests.push(`DELETE /api/me/local-agents/${agent.leaseId}`);
    DevChat._localAgent = null;
    DevChat._renderRunnerControls();
  };
  // #1191: the handler is the select's onChange prop, so it is invoked
  // directly rather than through a listener registry.
  const { RunnerControlsView } = loadTsx('frontend/src/features/dev-chat/composer-chrome.tsx');
  const onChange = () => {
    const parts = RunnerControlsView(runnerView()).props.children;
    const select = parts.find((child) => child && child.props && child.props.id === 'dc-runner-select');
    assert.ok(select, 'the live strip renders a selector');
    return select.props.onChange;
  };
  const previous = global.window;
  global.window = { DevChat };
  try {
    const event = { target: { value: 'platform' } };
    onChange()(event);
    await new Promise((resolve) => setImmediate(resolve));
    // The select snaps back before the async work: a dropdown left reading
    // "Homeroom" while the lease is still held is a lie about where the next
    // turn goes.
    assert.equal(event.target.value, 'local');
    assert.deepEqual(requests, ['DELETE /api/me/local-agents/7']);

    // Selecting the machine that is already running it is a no-op.
    requests.length = 0;
    DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '8', label: 'desktop' } });
    onChange()({ target: { value: 'local' } });
    assert.deepEqual(requests, []);
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
});

test('the hand-back is the browser-side escape hatch, and refuses demo rows', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8'
  );
  const fn = source.slice(
    source.indexOf('  async _handBackToUsernode() {'),
    source.indexOf('  _sanitizeStoredModel() {')
  );
  // It must not require the machine to cooperate — the whole point is the
  // laptop that was closed without detaching.
  assert.match(fn, /method: 'DELETE'/);
  assert.match(fn, /res\.status !== 204 && res\.status !== 404/,
    'an already-gone lease is success, not an error toast');
  assert.match(fn, /agent\.demo/);
  assert.match(fn, /confirm\(/, 'detaching is destructive enough to confirm');
});

test('runner state is per session and never bleeds across a switch', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8'
  );
  // openSession clears all three before the /status read re-establishes them.
  assert.match(
    source,
    /DevChat\._runner = null;\n\s+DevChat\._runnerLabel = null;\n\s+DevChat\._localAgent = null;/
  );
  const { DevChat, getEl } = makeHarness();
  DevChat._applyRunnerState({ runner: 'local', localAgent: { leaseId: '7', label: 'laptop' } });
  DevChat._runner = null;
  DevChat._runnerLabel = null;
  DevChat._localAgent = null;
  DevChat._renderRunnerControls();
  assert.equal(getEl('dc-runner').innerHTML, '');
});
