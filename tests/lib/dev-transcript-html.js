'use strict';

// Render the dev chat's transcript the way the browser does.
//
// ── Why the tests need this ────────────────────────────────────────────
//
// `DevChat.renderMessages()` used to assign `#dc-messages.innerHTML`, and
// seven test files drove it inside a `vm` with a DOM stub whose `innerHTML`
// setter captured the string. #1078's transcript chunk split that in two:
// dev-chat.js builds a plain view MODEL (`_transcriptView`) and
// frontend/src/features/dev-chat/transcript.tsx renders it.
//
// So a test that used to say
//
//     DevChat.renderMessages(); return captured;
//
// says
//
//     DevChat.renderMessages(); return t.html();
//
// and keeps every assertion it already had. `renderMessages` stays the thing
// under test — it is what drains a pending estimate, pairs each progress log
// with its status line and decides which row a live turn is writing into —
// and the markup comes from the real component, so this composes the two
// halves exactly as the store does at runtime.
//
// ── The honest limits ──────────────────────────────────────────────────
//
// - Effects do not run (renderToStaticMarkup), and `useStoreState` reads the
//   store through `useSyncExternalStore`'s SERVER snapshot, which is the same
//   value. Nothing in the transcript loads data in an effect.
// - `window.DevChat` does not exist in the rendering realm, so a `<details>`
//   renders at its model's `defaultOpen` rather than at whatever a reader
//   last left it — which is the fresh-session state these tests are about.
// - React ESCAPES text children, and these sandboxes stub `escapeHtml` as
//   identity or as a real escaper. That is the point: the model carries RAW
//   text on every row the template escaped, and only the component escapes.
// - Attribute ORDER is React's, not the template literal's. Assertions that
//   pinned a whole tag were rewritten to pin the parts.

const { loadTsx, renderToHtml, createElement } = require('./render-tsx');

// The three ticker formatters are classic-script globals in the browser
// (public/js/cc-progress-summary.js), and the rows that tick read them off
// `globalThis`. Install the REAL ones so a derived label is the label the
// browser would draw, not a stub's idea of it.
for (const [name, fn] of Object.entries(require('../../public/js/cc-progress-summary.js'))) {
  if (typeof fn === 'function' && globalThis[name] === undefined) globalThis[name] = fn;
}

let api = null;
// ONE bundle per process, deliberately: each `loadTsx` entry is its own
// bundle, so a second one would hand this module a different `transcriptStore`
// object from the one the component subscribes to.
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-transcript-api.ts')));

const EMPTY = { rows: [], devFlowHtml: '', activity: null, busy: false };

/** The whole transcript, as html. `state` may be a cross-realm object. */
function transcriptHtml(state) {
  const m = mod();
  m.transcriptStore.set(JSON.parse(JSON.stringify(state || EMPTY)));
  return renderToHtml(createElement(m.DevChatTranscript, {}));
}

/**
 * The `window.UsernodeReact.devChat` a sandbox publishes into.
 *
 * Every method of the real bridge is here, because a sandbox that drives more
 * than the transcript reaches for its neighbours; only the four the transcript
 * uses record anything.
 */
function makeTranscriptBridge() {
  let state = EMPTY;
  let stream = { key: '', html: '' };
  let now = 0;
  let mounts = 0;
  let view = null;
  const noop = () => {};
  const bridge = {
    // #1078: `renderChatView` mounts the whole SCREEN and every region
    // below publishes into it, so a harness that drives it needs this
    // method to exist or the render bails on its first line.
    mountDevView: (_h, s) => { view = s; },
    publishDevView: (s) => { view = s; },
    mountTranscript: (_host, s) => { mounts += 1; state = s; },
    publishTranscript: (s) => { state = s; },
    publishStream: (s) => { stream = s; },
    publishNow: (n) => { now = n; },
    mountAttachStrip: noop, unmountAttachStrip: noop, publishAttachStrip: noop,
    mountBudgetPill: noop, publishBudgetPill: noop,
    mountQuickReplies: noop, publishQuickReplies: noop,
    mountRunnerControls: noop, publishRunner: noop,
    mountSessionList: noop, publishSessionList: noop,
    mountSessionHeader: noop, publishSessionHeader: noop,
    publishSpecViewer: noop,
    mountBanners: noop, publishBanners: noop,
  };
  return {
    bridge,
    /** The last published view model, as plain same-realm data. */
    state: () => JSON.parse(JSON.stringify(state)),
    /** The live bubble's last frame — `{ key, html }`. */
    stream: () => JSON.parse(JSON.stringify(stream)),
    /** The clock the 1s heartbeat last published. */
    now: () => now,
    /** How many times the portal was (re-)mounted rather than republished. */
    mounts: () => mounts,
    /** The whole screen's last published model. */
    view: () => (view ? JSON.parse(JSON.stringify(view)) : null),
    /** The last published model, rendered. */
    html: () => transcriptHtml(state),
  };
}

/** One row, rendered on its own — the model's `key` is enough to find it. */
function rowHtml(row) {
  const m = mod();
  return renderToHtml(createElement(m.Row, { r: JSON.parse(JSON.stringify(row)) }));
}

/** The 1s heartbeat's clock, for a row that re-derives a ticking label. */
function setTranscriptNow(now) {
  mod().nowStore.set({ now });
}

/** The live bubble's current frame, for `LiveContent`. */
function setStream(key, html) {
  mod().streamStore.set({ key, html });
}

module.exports = {
  transcriptHtml, makeTranscriptBridge, rowHtml, setTranscriptNow, setStream, api: mod,
};
