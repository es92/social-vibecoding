// The focused topic head is repainted from a model, and two of its sections
// are filled by loaders the RENDERER calls on every paint: the vote roster
// (`_loadVoteRoster`, from `_voteRosterView`'s miss) and the shared-chat
// transcript (`_loadSessionTranscript`, from the expanded disclosure).
//
// Before the React conversion both loaders wrote into the DOM in place, so
// re-entering the renderer was never on the table. Painting from a model
// puts it on the table: a loader that repaints unconditionally closes a
// cycle with the renderer that called it.
//
//   render → load → (cached) paint → render → load → …
//
// The first pass through survives because it awaits its fetch, which
// unwinds the stack. The pass AFTER it finds the cache, stays synchronous,
// and blows the stack — which is what a shared session's page did, since it
// arrives with the transcript already expanded.
//
// The rule both loaders now follow: a loader a renderer calls per paint
// must not unconditionally re-enter that renderer. The roster guards with
// an in-flight set plus its cache; the transcript repaints only when the
// LABEL it exists to swap has actually changed.
//
// Run with: node --test tests/topic-head-loader-reentry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const APP_VIEW_SRC = read('app-view.js');
const SESSION_TRANSCRIPT_SRC = read('session-transcript.js');

function makeAppView(opts = {}) {
  const slot = { innerHTML: '' };
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => slot,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => (opts.fetchData || {}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${MERGE_STATUS_SRC}\n${SESSION_TRANSCRIPT_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`,
    sandbox
  );
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  return { AppView, slot };
}

// Stand in for the real `_renderTopicHead`, which rebuilds the model and, on
// an expanded transcript, ends with `_loadSessionTranscript(id)`. Counting
// its calls is how a cycle shows up as a number rather than as a crash.
function renderingSpy(AppView, load) {
  const calls = { n: 0 };
  AppView._renderTopicHead = () => {
    calls.n += 1;
    // A runaway cycle would recurse here forever; stop counting well before
    // the stack does, so a regression reports a count instead of a
    // RangeError from inside the test harness.
    if (calls.n > 50) return;
    load();
  };
  return calls;
}

const TRANSCRIPT = {
  session: { id: 32, username: 'alice', message_count: 9, can_fork: false },
  messages: [],
};

test('a cached transcript paint does not re-enter the renderer', async () => {
  const { AppView, slot } = makeAppView();
  AppView._transcriptOpen = 32;
  AppView._transcripts[32] = TRANSCRIPT;
  // The first paint has already run and cached the expanded label — which is
  // the state a repaint (checks poll, WS event) finds.
  AppView._transcriptLabels[32] = AppView._transcriptLabels[32]
    || 'Agent session by alice · 9 messages';

  const calls = renderingSpy(AppView, () => AppView._loadSessionTranscript(32));
  await AppView._loadSessionTranscript(32);

  assert.equal(calls.n, 0, 'an unchanged label repaints nothing');
  assert.notEqual(slot.innerHTML, '', 'the body is still filled on every paint');
});

test('the first cached paint repaints exactly once, to swap the label in', async () => {
  const { AppView } = makeAppView();
  AppView._transcriptOpen = 32;
  AppView._transcripts[32] = TRANSCRIPT;

  const calls = renderingSpy(AppView, () => AppView._loadSessionTranscript(32));
  await AppView._loadSessionTranscript(32);

  assert.equal(calls.n, 1, 'one repaint carries the expanded label, then it settles');
  assert.equal(
    AppView._transcriptLabels[32],
    'Agent session by alice · 9 messages'
  );
});

test('a fetched transcript settles too, with the renderer re-entering per paint', async () => {
  const { AppView } = makeAppView({ fetchData: TRANSCRIPT });
  AppView._transcriptOpen = 32;

  const calls = renderingSpy(AppView, () => AppView._loadSessionTranscript(32));
  await AppView._loadSessionTranscript(32);
  // Let the repaint's own (now cached) load run to completion.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(calls.n, 1);
});

test('the collapsed label is what the section shows until the payload lands', () => {
  const { AppView } = makeAppView();
  const item = { id: 32, transcript_shared: true, message_count: 9 };

  assert.equal(AppView._transcriptSectionView(item).label, 'Read the agent session (9 messages)');
  AppView._transcriptOpen = 32;
  AppView._transcriptLabels[32] = 'Agent session by alice · 9 messages';
  assert.equal(
    AppView._transcriptSectionView(item).label,
    'Agent session by alice · 9 messages',
    'and the cached expanded label survives a repaint'
  );
});

test('the vote roster loader is guarded against the same cycle', async () => {
  const { AppView } = makeAppView({
    fetchData: { yes: [], no: [], policy: 'anyone' },
  });

  const calls = renderingSpy(AppView, () => AppView._loadVoteRoster(7));
  await AppView._loadVoteRoster(7);
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(calls.n <= 2, `roster repaints settle (saw ${calls.n})`);
  assert.ok(AppView._voteRoster[7], 'and the roster is cached for the next paint');
  assert.equal(AppView._voteRosterInFlight.has(7), false, 'with the in-flight mark cleared');
});
