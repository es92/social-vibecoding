// #361: the "Changes ready" card (dc-pr-card) + "Submit for review" button
// must render whenever a turn produced a reviewable commit — driven by the
// staging-independent `changesReady` marker — NOT only when a staging
// preview built. This guards the three render shapes:
//   - changesReady + stagingFailed (no URL) → card, DISABLED Preview, Propose
//   - changesReady + stagingUrl            → full card (live Preview), Propose
//   - neither (a plain no-changes/spec/question status line) → NO card
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`). We load its
// source into a vm context, stub the browser globals it reaches at load
// (localStorage / document / window / fetch / navigator) plus the shared
// `escapeHtml`, drive DevChat.renderMessages() against a fake #dc-messages
// element whose innerHTML setter records the HTML, and assert on it.
//
// Run with: node --test tests/dev-chat-changes-ready-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeTranscriptBridge } = require('./lib/dev-transcript-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// Build a DevChat in a sandbox with a fake #dc-messages. #1078: the rows are
// a React island, so `renderMessages` publishes a view model rather than
// writing this element's innerHTML — the element is the portal's host and the
// markup comes back from the component. `renderMessages` still reads
// DevChat.messages + DevChat.currentSession, and is still what is under test.
function makeDevChat() {
  const t = makeTranscriptBridge();
  const messagesEl = {
    innerHTML: '',
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  const sandbox = {
    console, location: { search: '' }, URLSearchParams, App: { user: { id: 1 } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, dispatchEvent() {},
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    // #558: fetch is delegated through a mutable holder so promote tests can
    // swap in a deferred / failing implementation per-case; defaults to an
    // OK empty response (the shape the render tests rely on).
    fetch: async (...args) => sandbox.__fetchImpl(...args),
    // #558: promotePR() calls alert() on both failure paths; record calls so
    // tests can assert the message without a real dialog.
    alert: (msg) => { sandbox.__alerts.push(msg); },
    // Native-kit adoption: promotePR failure feedback is a PlatformUI
    // toast now — record it through the same __alerts sink.
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: (msg) => { sandbox.__alerts.push(msg); },
      alert: async (o) => { sandbox.__alerts.push((o && (o.message || o.title)) || o); return {}; },
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.__fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  sandbox.__alerts = [];
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.UsernodeReact = { devChat: t.bridge };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8') + '\n;globalThis.AppView = AppView;', sandbox);
  sandbox.AppView._renderTopicHead = () => {};
  sandbox.AppView._loadDevData = async () => {};
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // renderMarkdown is irrelevant to the card path; keep it cheap + safe.
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat, AppView: sandbox.AppView,
    alerts: sandbox.__alerts,
    setFetch(fn) { sandbox.__fetchImpl = fn; },
    getHtml() { return t.html(); },
    /** The last published view model, as plain data. */
    state: () => t.state(),
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || null;
      DevChat.renderMessages();
      return t.html();
    },
    // The card's five buttons carried inline onclicks, because an innerHTML
    // card had nowhere else to put a handler. A React card holds the closure,
    // so what a button DOES is read off the model.
    changesRow: () => t.state().rows.find((r) => r.t === 'changes'),
  };
}

const activeSession = (over) => ({
  id: 7, status: 'active', check_state: 'passing', pr_url: null, pr_number: null, ...over,
});

test('a CLI handoff reload derives the missing card from authoritative session state', () => {
  const { DevChat, render } = makeDevChat();
  const session = activeSession({
    id: 2969,
    source: 'cli_handoff',
    handoff_head_sha: 'a'.repeat(40),
    checks_commit_sha: 'a'.repeat(40),
    check_state: 'passing',
    checks_checked_at: '2026-08-04T10:00:00.000Z',
    staging_url: 'https://crypto-predictions--s2969.example.test',
    pr_number: 4,
    pr_url: 'https://github.com/usernode-bot/crypto-predictions/pull/4',
  });

  const hydrated = DevChat._hydrateChangesReadyFromSession(session, [
    { role: 'assistant', content: 'Local test results reported by the CLI agent.' },
  ]);
  assert.equal(hydrated.length, 2);
  assert.equal(hydrated[1]._derivedFromSession, true);
  assert.equal(hydrated[1].stagingUrl, session.staging_url);
  assert.equal(hydrated[1].changesReady, true);

  const html = render(hydrated, session);
  assert.match(html, /dc-pr-card/, 'the repaired session renders its Changes ready card');
  assert.match(html, /Preview staging/, 'the authoritative preview is available');
  assert.match(html, /PR #4/, 'the authoritative proposal link is available');
});

test('authoritative hydration never duplicates a persisted Changes ready card', () => {
  const { DevChat } = makeDevChat();
  const persisted = {
    id: 88, role: 'system', content: 'Staging deployed!',
    changesReady: true, stagingUrl: 'https://persisted.example.test',
  };
  const messages = [persisted];
  const hydrated = DevChat._hydrateChangesReadyFromSession(
    activeSession({ staging_url: 'https://current.example.test' }), messages
  );

  assert.equal(hydrated, messages, 'the original history array wins unchanged');
  assert.equal(hydrated.filter((m) => m.changesReady || m.stagingUrl).length, 1);
});

test('CLI terminal checks derive a card without a preview, but drafts and pending builds do not', () => {
  const { DevChat } = makeDevChat();
  const submitted = activeSession({
    source: 'cli_handoff', handoff_head_sha: 'b'.repeat(40), staging_url: null,
  });

  const failed = DevChat._hydrateChangesReadyFromSession(
    { ...submitted, check_state: 'error' }, []
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].changesReady, true);
  assert.equal(failed[0].stagingUrl, null);
  assert.match(failed[0].content, /checks need attention/i);

  assert.equal(DevChat._hydrateChangesReadyFromSession(
    { ...submitted, check_state: 'pending' }, []
  ).length, 0, 'an in-flight build does not claim changes are ready');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    activeSession({ source: 'cli_handoff', check_state: null, staging_url: null }), []
  ).length, 0, 'an untouched CLI draft does not get a card');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    activeSession({ check_state: 'passing', checks_commit_sha: 'c'.repeat(40) }), []
  ).length, 0, 'a non-CLI session needs an actual preview or persisted card');
  assert.equal(DevChat._hydrateChangesReadyFromSession(
    { ...submitted, status: 'archived', check_state: 'passing', staging_url: 'https://leaked.example.test' }, []
  ).length, 0, 'an archived teardown leak does not become a fresh interactive card');
});

test('changesReady WITHOUT stagingUrl renders the card with Propose + an ACTIVE (rebuild-on-click) Preview (#439)', () => {
  const { render, changesRow } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      stagingErrorName: 'MissingSecretsError', stagingMissingKeys: ['EXAMPLE_KEY'],
      _slug: 'aaa111',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'the Changes ready card renders');
  assert.match(html, /Submit for review/, 'Submit for review button present');
  // #439: the Preview button is now ACTIVE — clicking it triggers an
  // on-demand rebuild rather than being a disabled "proposing will rebuild
  // it" dead-end. The fallback URL is empty (no live/message URL yet).
  assert.doesNotMatch(html, /disabled[^>]*>Preview staging</, 'Preview staging is NOT disabled');
  assert.deepEqual(changesRow().preview, { enabled: true, url: '', title: '' },
    'Preview wired to rebuild-on-click, with no URL to rebuild from yet');
  // The old inline "proposing will rebuild it" note is gone — any failure
  // reason now surfaces in the preview loader on click instead.
  assert.doesNotMatch(html, /proposing will rebuild it/i, 'no stale disabled note');
});

test('a merged (previewGone) card keeps Preview disabled with the now-live tooltip (#439)', () => {
  const { render, changesRow } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging deployed!',
      changesReady: true, stagingUrl: 'https://preview.example.org',
      _slug: 'aaa222',
    },
  ], activeSession({ status: 'merged', merged_at: '2026-06-26T00:00:00Z' }));

  assert.match(html, /dc-pr-card/, 'card still renders post-merge');
  assert.match(html, /disabled[^>]*>Preview staging</, 'Preview is disabled once merged');
  assert.match(html, /now live in the app/i, 'tooltip explains the change is now live');
  assert.equal(changesRow().preview.enabled, false, 'no rebuild handler on a merged card');
});

test('stagingUrl renders the FULL card with a live Preview + Propose', () => {
  const { render, changesRow } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging deployed!',
      changesReady: true, stagingUrl: 'https://preview.example.org',
      _slug: 'bbb222',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'card renders');
  assert.match(html, /Submit for review/, 'Submit for review present');
  assert.deepEqual(changesRow().preview,
    { enabled: true, url: 'https://preview.example.org', title: '' }, 'live Preview button wired');
  assert.doesNotMatch(html, /disabled[^>]*>Preview staging</, 'Preview is NOT disabled when a URL exists');
});

test('a paused checked handoff retains its ready submission action in the workspace', () => {
  const h = makeDevChat();
  const messages = [{ role: 'system', content: 'Changes ready', changesReady: true,
    stagingUrl: 'https://preview.example.org', _slug: 'paused-ready' }];
  const html = h.render(messages, activeSession({ status: 'paused', source: 'cli_handoff',
    proposal_state: 'ready', check_state: 'passing' }));
  assert.equal(h.changesRow().propose.kind, 'ready');
  assert.match(html, /Submit for review/);
  assert.doesNotMatch(html, /disabled[^>]*>Submit for review</);
});

test('managed CLI handoff keeps Propose disabled until its authoritative state is ready (#1650)', () => {
  const h = makeDevChat();
  const messages = [{
    role: 'system', content: 'Staging deployed!', changesReady: true,
    stagingUrl: 'https://preview.example.org', _slug: 'managed-ready',
  }];
  const checking = activeSession({
    source: 'cli_handoff', proposal_state: 'checking', check_state: 'pending',
  });

  let html = h.render(messages, checking);
  // #2074: the reason names the condition that actually failed. This is the
  // managed-handoff contract — a tested, uploaded revision — not a generic
  // "finish the build", which is what it used to say for all five conditions
  // and is how a passing state got read as a broken button.
  assert.deepEqual(h.changesRow().propose, {
    kind: 'blocked', label: 'Submit for review',
    reason: 'This managed session needs staging and checks to finish before it can be submitted.',
  });
  assert.match(html, /disabled[^>]*title="This managed session needs staging and checks to finish/,
    'the unavailable action is disabled and explains why — naming ITS condition');
  assert.match(html, /Submit for review/, 'the action keeps its stable label');

  html = h.render(messages, { ...checking, proposal_state: 'ready', check_state: 'passing' });
  assert.deepEqual(h.changesRow().propose, { kind: 'ready' });
  assert.doesNotMatch(html, /disabled[^>]*>Submit for review</,
    'the same action enables when the server reports ready');
  assert.match(html, />Submit for review</);
});

test('live session refresh watches managed proposal readiness (#1650)', () => {
  assert.match(SRC, /const watch = \['status', 'check_state', 'proposal_state'/,
    'checks_ready refetches must copy the state that enables the button');
});

test('ordinary active sessions preserve their build-on-propose action (#1650)', () => {
  const h = makeDevChat();
  // Pushed, no PR and no preview yet — every push pends its checks first, so
  // the state is 'pending'. (All three blank is a branch nothing has reached,
  // which #2379 blocks.)
  h.render([{ role: 'system', content: 'Changes ready.', changesReady: true }],
    activeSession({ proposal_state: undefined, check_state: 'pending', staging_url: null }));
  assert.deepEqual(h.changesRow().propose, { kind: 'ready' });
});

test('a plain no-changes status line renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'No changes were made by Claude Code.', _slug: 'ccc333' },
  ], activeSession());

  assert.doesNotMatch(html, /dc-pr-card/, 'no card for a no-changes status');
  assert.doesNotMatch(html, /Submit for review/, 'no Propose button');
});

test('a spec/question status line (no marker) renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'Auto session drafted a spec.', _slug: 'ddd444' },
  ], activeSession());
  assert.doesNotMatch(html, /dc-pr-card/, 'spec/question outcomes keep their non-card guidance');
});

test('View on GitHub uses the message-carried prUrl when the session row lacks one', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      prNumber: 123, prUrl: 'https://github.com/x/y/pull/123',
      _slug: 'eee555',
    },
  ], activeSession({ pr_url: null, pr_number: null }));
  assert.match(html, /View on GitHub/, 'GitHub link rendered from the marker');
  assert.match(html, /pull\/123/, 'links to the carried PR url');
});

// ── #558: Propose-to-group button disable + spinner on click ──────────────
// promotePR(btn) must, the instant it's clicked, disable the button and swap
// its label for a spinner so a slow request can't be double-submitted; the
// success path re-renders it as a disabled completion, and both failure paths
// restore the button so the user can retry.

// #1078: the in-flight state moved off the button element and into the row
// model. It had to: `renderMessages` runs on every 3s status poll, so a
// repaint mid-request would have restored the label and cleared the re-entry
// guard — the double-submit #558 exists to stop.
test('promotePR disables the button and shows the spinner while the request is in flight (#558)', async () => {
  const h = makeDevChat();
  const cardOnScreen = () => h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm001' },
  ], activeSession({ id: 7 }));
  cardOnScreen();
  // Deferred fetch so we can inspect the card mid-flight.
  let release;
  h.setFetch(() => new Promise((res) => { release = () => res({ ok: true, json: async () => ({}) }); }));

  const p = h.DevChat.promotePR();

  assert.deepEqual(h.changesRow().propose, { kind: 'pending' },
    'the model says the request is in flight');
  const html = h.getHtml();
  assert.match(html, /class="dc-pr-btn dc-pr-btn-promote"[^>]*disabled/, 'button is disabled while pending');
  assert.match(html, /aria-busy="true"/, 'aria-busy set while pending');
  assert.match(html, /dc-status-spinner-arc[\s\S]*Proposing/, 'spinner and "Proposing…" in place of the label');

  release();
  await p;
});

test('promotePR re-entry guard: a second click while pending is a no-op (#558)', async () => {
  const h = makeDevChat();
  h.DevChat.currentSession = activeSession({ id: 7 });
  let calls = 0;
  let release;
  h.setFetch(() => { calls++; return new Promise((res) => { release = () => res({ ok: true, json: async () => ({}) }); }); });

  const p1 = h.DevChat.promotePR();   // takes the flag, fetch #1
  await h.DevChat.promotePR();        // flag held for this session → no fetch
  assert.equal(calls, 1, 'an in-flight request for this session blocks a second submit');

  release();
  await p1;
});

test('promotePR success locks and relabels the proposal button (#1602)', async () => {
  const h = makeDevChat();
  // A changes-ready card is on screen for the active session.
  h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm001' },
  ], activeSession({ id: 7 }));
  assert.match(h.getHtml(), /Submit for review/, 'button present before promote');

  h.setFetch(async () => ({ ok: true, json: async () => ({ prNumber: 42, prUrl: 'https://github.com/x/y/pull/42' }) }));
  await h.DevChat.promotePR();

  // status flipped to 'promoted' → the same affordance acknowledges completion
  // but can no longer issue a second request.
  assert.equal(h.DevChat.currentSession.status, 'promoted', 'session promoted');
  assert.match(h.getHtml(), /disabled[^>]*>Already proposed</,
    'button is disabled and relabeled after the successful re-render');
  assert.deepEqual(h.changesRow().propose, { kind: 'completed' });
});

test('an already-promoted session loads with a disabled completed proposal action (#1602)', () => {
  const h = makeDevChat();
  const html = h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm002' },
  ], activeSession({ id: 8, status: 'promoted', pr_number: 42 }));

  assert.match(html, /disabled[^>]*>Already proposed</,
    'the completion survives a fresh render rather than becoming clickable again');
  assert.doesNotMatch(html, />Submit for review</, 'the active label is gone');
  assert.deepEqual(h.changesRow().propose, { kind: 'completed' });
});

test('promotePR refuses a stale call for an already-proposed session (#1602)', async () => {
  const h = makeDevChat();
  let calls = 0;
  h.setFetch(async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  });
  h.DevChat.currentSession = activeSession({ status: 'promoted' });

  await h.DevChat.promotePR();

  assert.equal(calls, 0, 'no duplicate promotion request leaves the browser');
  assert.equal(h.DevChat.currentSession.status, 'promoted', 'no in-flight state was acquired');
});

test('merging and merged cards keep the proposal action completed (#1602)', () => {
  for (const status of ['merging', 'merged']) {
    const h = makeDevChat();
    const html = h.render([
      { role: 'system', content: 'Staging deployed!', changesReady: true,
        stagingUrl: 'https://preview.example.org', _slug: `prm-${status}` },
    ], activeSession({ id: 9, status }));
    assert.match(html, /disabled[^>]*>Already proposed</, `${status} remains locked`);
    assert.deepEqual(h.changesRow().propose, { kind: 'completed' });
  }
});

test('archived cards do not gain a proposal action (#1602)', () => {
  for (const status of ['archived']) {
    const h = makeDevChat();
    const html = h.render([
      { role: 'system', content: 'Changes were saved.', changesReady: true, _slug: `prm-${status}` },
    ], activeSession({ id: 10, status }));
    assert.doesNotMatch(html, /dc-pr-btn-promote/, `${status} has no proposal action`);
    assert.equal(h.changesRow().propose, null);
  }
});

test('promotePR failure (non-OK) re-enables the button and restores its label (#558)', async () => {
  const h = makeDevChat();
  const cardOnScreen = () => h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm001' },
  ], activeSession({ id: 7 }));
  cardOnScreen();
  h.setFetch(async () => ({ ok: false, json: async () => ({ error: 'Nope' }) }));

  await h.DevChat.promotePR();

  assert.deepEqual(h.changesRow().propose, { kind: 'ready' },
    'button re-enabled after a failed response');
  const html = h.getHtml();
  assert.match(html, />Submit for review</, 'original label restored');
  assert.doesNotMatch(html, /aria-busy/, 'aria-busy cleared');
  assert.doesNotMatch(html, /Proposing/, 'and the spinner is gone');
  assert.deepEqual(h.alerts, ['Nope'], 'server error surfaced via alert');
});

test('promotePR humanizes a stale proposal readiness rejection (#1650)', async () => {
  const h = makeDevChat();
  h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm-not-ready' },
  ], activeSession({ id: 7 }));
  h.setFetch(async () => ({
    ok: false,
    json: async () => ({ error: 'proposal_not_ready' }),
  }));

  await h.DevChat.promotePR();

  assert.deepEqual(h.alerts, [
    'This proposal is not ready yet. Wait for staging and checks to finish, then try again.',
  ]);
  assert.deepEqual(h.changesRow().propose, { kind: 'ready' },
    'a readiness race remains retryable after the friendly explanation');
});

test('promotePR failure (network error) re-enables the button and restores its label (#558)', async () => {
  const h = makeDevChat();
  const cardOnScreen = () => h.render([
    { role: 'system', content: 'Staging deployed!', changesReady: true,
      stagingUrl: 'https://preview.example.org', _slug: 'prm001' },
  ], activeSession({ id: 7 }));
  cardOnScreen();
  h.setFetch(async () => { throw new TypeError('boom'); });

  await h.DevChat.promotePR();

  assert.deepEqual(h.changesRow().propose, { kind: 'ready' },
    'button re-enabled after a thrown error');
  assert.match(h.getHtml(), />Submit for review</, 'original label restored');
  assert.deepEqual(h.alerts, ['Network error'], 'network error surfaced via alert');
});


test('embedded and historical build results retain their content without action controls', () => {
  const h = makeDevChat();
  h.render([{ role: 'system', content: 'Built the change', stagingUrl: 'https://preview.example', changesReady: true }],
    activeSession({ pr_number: 12, pr_url: 'https://github.com/example/app/pull/12', testing_md: 'Check the result.' }));
  const { renderComponent } = require('./lib/render-tsx');
  const render = (props) => renderComponent('frontend/src/features/dev-chat/transcript.tsx', 'ChangesCard', { r: h.changesRow(), ...props });
  for (const props of [{ embedded: true }, { historical: true }]) {
    const html = render(props);
    assert.match(html, /dc-pr-card/);
    assert.doesNotMatch(html, /dc-pr-card-actions|dc-pr-btn-promote|Preview staging|Test this change/);
  }
  assert.doesNotMatch(render({ embedded: true }), /href="https:\/\/github.com/);
  assert.match(render({}), /Preview staging/);
  assert.match(render({}), /Submit for review/);
});

test('card and standalone workspace share one pending submission and reject concurrent clicks', async () => {
  const h = makeDevChat();
  h.render([{ role: 'system', content: 'Built', changesReady: true }], activeSession());
  let resolve;
  let calls = 0;
  h.setFetch(() => { calls++; return new Promise((r) => { resolve = r; }); });
  const pending = h.AppView.runChangeAction(7, 'promote');
  await h.DevChat.promotePR();
  assert.equal(calls, 1);
  assert.equal(h.changesRow().propose.kind, 'pending');
  resolve({ ok: true, json: async () => ({}) });
  await pending;
  assert.equal(h.changesRow().propose.kind, 'completed');
  assert.equal(h.AppView._changeActions.size, 0);
});

// ── #1889: the card follows the latest iteration ──────────────────────
// A Changes card is persisted by the turn that landed the change, but its
// actions are the session's, and a later iteration that ended without a new
// card — a question answered, a stopped or failed run — left the only Submit
// for review mid-transcript. The transcript now draws the latest card after
// the last row once a later user turn follows it (its status line stays in
// the timeline), keeps it in its slot while a turn is in flight, and leaves a
// single-iteration session exactly as it was.

const count = (html, needle) => html.split(needle).length - 1;
const at = (html, needle) => {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `expected the markup to contain ${JSON.stringify(needle)}`);
  return i;
};

const CARD = {
  id: 1, role: 'system', content: 'Staging deployed!', changesReady: true,
  stagingUrl: 'https://preview.example.org',
};
const WRAP_UP = { id: 2, role: 'assistant', content: 'Preview it, or propose it to the group.' };
const ASK = { id: 3, role: 'user', content: 'Can it round to the nearest hour?' };
const ANSWER = { id: 4, role: 'assistant', content: 'Yes, past a day it rounds to the hour.' };
const withPr = (over) => activeSession({
  id: 7, pr_number: 12, pr_url: 'https://github.com/example/app/pull/12', ...over,
});

test('a single iteration keeps the card where its turn left it (#1889)', () => {
  const h = makeDevChat();
  const html = h.render([CARD, WRAP_UP], withPr());
  assert.ok(at(html, 'class="dc-pr-card"') < at(html, 'propose it to the group'),
    'the wrap-up bubble is the same turn, so the card stays above it');
  assert.equal(count(html, 'dc-pr-btn-promote'), 1);
  assert.equal(h.state().busy, false, 'the model says the chat is idle');
});

test('a later iteration moves the card, not its status line, to the bottom (#1889)', () => {
  const h = makeDevChat();
  const html = h.render([CARD, WRAP_UP, ASK, ANSWER], withPr());
  assert.ok(at(html, 'class="dc-pr-card"') > at(html, 'rounds to the hour'),
    'the card renders after the last row');
  assert.ok(at(html, 'Staging deployed!') < at(html, 'nearest hour'),
    'its status line stays in the timeline, where the change landed');
  assert.equal(count(html, 'class="dc-pr-card"'), 1, 'one card, not one per iteration');
  assert.equal(count(html, 'dc-pr-btn-promote'), 1, 'one Submit for review');
  assert.match(html, />Submit for review</);
  assert.match(html, /PR #12/, 'the card keeps its header');
  assert.match(html, /Preview staging/, 'and its other actions');
  assert.doesNotMatch(html, /Earlier build result|Current actions are/,
    'nothing is left behind as a stub');
  assert.deepEqual(h.changesRow().propose, { kind: 'ready' }, 'same model, same wiring');
});

test('the trailing card keeps the proposal action\'s lifecycle (#1889)', () => {
  // Completed on a promoted session, blocked with its reason on a failing
  // one, ready on a paused checked one — the model the in-place card renders from.
  let h = makeDevChat();
  let html = h.render([CARD, WRAP_UP, ASK, ANSWER], withPr({ status: 'promoted' }));
  assert.ok(at(html, 'class="dc-pr-card"') > at(html, 'rounds to the hour'));
  assert.match(html, /disabled[^>]*>Already proposed</);
  assert.deepEqual(h.changesRow().propose, { kind: 'completed' });

  h = makeDevChat();
  html = h.render([CARD, WRAP_UP, ASK, ANSWER], withPr({ check_state: 'failing' }));
  assert.ok(at(html, 'class="dc-pr-card"') > at(html, 'rounds to the hour'));
  assert.match(html, /disabled[^>]*title="The checks on this revision are failing/);
  assert.match(html, /Submit for review/, 'the blocked action keeps its label');

  h = makeDevChat();
  html = h.render([CARD, WRAP_UP, ASK, ANSWER], withPr({ status: 'paused' }));
  assert.ok(at(html, 'class="dc-pr-card"') > at(html, 'rounds to the hour'), 'the card still trails');
  assert.equal(h.changesRow().propose.kind, 'ready');
  assert.match(html, />Submit for review</);
});

test('a turn in flight keeps the card in its slot; it trails again once the turn settles (#1889)', () => {
  const h = makeDevChat();
  const session = withPr();
  // The user sends a third message: an optimistic row, with the turn running.
  const NEXT = { id: null, _slug: 'u3', role: 'user', content: 'Ship it with a tweak.' };
  h.DevChat.isStreaming = true;
  let html = h.render([CARD, WRAP_UP, ASK, ANSWER, NEXT], session);
  assert.equal(h.state().busy, true, 'the published model says a turn is running');
  assert.ok(at(html, 'class="dc-pr-card"') < at(html, 'Ship it with a tweak'),
    'the tail belongs to the run: the card is back in its turn\'s slot');
  assert.equal(count(html, 'dc-pr-btn-promote'), 1, 'and is still the only Submit for review');

  // The turn settles without a new card — a failed run.
  h.DevChat.isStreaming = false;
  const FAILED = {
    id: 6, role: 'system', turnError: true,
    content: 'This turn failed: the coding agent exited before writing a result. Send your message again to retry.',
  };
  html = h.render([CARD, WRAP_UP, ASK, ANSWER, { ...NEXT, id: 5 }, FAILED], session);
  assert.equal(h.state().busy, false);
  assert.ok(at(html, 'class="dc-pr-card"') > at(html, 'Send your message again'),
    'the card trails the failure');
  assert.equal(count(html, 'dc-pr-btn-promote'), 1);
});

test('a new card lands in its own turn and the earlier one becomes the record (#1889)', () => {
  const h = makeDevChat();
  const CARD2 = {
    id: 6, role: 'system', content: 'Staging deployed!', changesReady: true,
    stagingUrl: 'https://preview.example.org/2',
  };
  const html = h.render([CARD, WRAP_UP, ASK, CARD2], withPr());
  assert.equal(count(html, 'class="dc-pr-card"'), 2, 'both cards render');
  assert.equal(count(html, 'dc-pr-btn-promote'), 1, 'one Submit for review');
  assert.ok(at(html, 'dc-pr-btn-promote') > at(html, 'nearest hour'), 'on the newest card, in place');
  assert.match(html, /Earlier build result/, 'the first card is the record it always was');
});
