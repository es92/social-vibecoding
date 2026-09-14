// Picking "On-Platform" actually returns the session to the chat (#1348).
//
// This is a BEHAVIOURAL test on purpose. The bug it pins shipped once
// already, past a source-regex test that asserted the On-Platform branch
// cleared `build_venue` — which it did. The branch was right and the screen
// was still wrong, because `_launchpadVenue()` never reached the column:
//
//     _devFlowTarget()
//       if (flow.dismissed) return null;
//       if (flow.mode === 'wizard' && flow.agent) return {…}   ← answers here
//       …only now does it look at session.build_venue
//
// Picking a web venue sets that in-memory `mode` (via _devFlowFromCredits)
// and nothing on the way back cleared it, so the venue row ticked
// On-Platform, the backend switched underneath, and the launchpad stayed on
// screen. A regex over the source cannot see that; calling the function can.
//
// So this drives the real DevChat in a vm sandbox — the harness
// tests/credits-banner-render.test.js established — and asserts on what
// _launchpadVenue() actually answers, before and after.
//
// Run with: node --test tests/venue-return-to-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...rel) => fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
const SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const BUILD_VENUES_SRC = read('public', 'js', 'build-venues.js');
const LAUNCHPAD_SRC = read('frontend', 'src', 'features', 'dev-chat', 'launchpad.js');

function makeDevChat() {
  const noopEl = {
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, hasAttribute: () => false,
    getAttribute: () => null, focus: () => {}, scrollIntoView: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, insertAdjacentHTML: () => {}, remove: () => {},
    innerHTML: '', textContent: '', value: '', dataset: {},
  };
  const sandbox = {
    console,
    escapeHtml: (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: () => ({ ...noopEl }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    location: { search: '', hash: '', origin: 'https://example.test' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  // The launchpad question needs the venue list and the launchpad module;
  // DevFlowSelect only has to EXIST for _devFlowTarget to consider a
  // wizard at all, so it is stubbed rather than loaded.
  sandbox.DevFlowSelect = { wizardHtml: () => '<div data-flow-wizard="1"></div>' };
  sandbox.App = { user: { externalFlowsAvailable: true, devFlowPreference: null }, currentApp: 'x' };
  sandbox.PlatformUI = { toast: () => {}, hasKit: () => false, menu: () => Promise.resolve(null) };
  vm.createContext(sandbox);
  vm.runInContext(BUILD_VENUES_SRC, sandbox);
  vm.runInContext(LAUNCHPAD_SRC, sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat._resetDevFlow(7);
  DevChat.currentSession = {
    id: 7,
    status: 'active',
    build_venue: null,
    agent_backend: 'claude_code',
    external_agent: null,
    pr_number: null,
    session_title: 'Demo',
  };
  DevChat.sessions = [DevChat.currentSession];
  DevChat.messages = [];
  // renderChatView touches far more DOM than this harness stubs, and the
  // question here is what _launchpadVenue ANSWERS, not what it paints.
  DevChat.renderChatView = () => {};
  DevChat.renderMessages = () => {};
  DevChat._devFlowEnsureStatus = () => {};
  return { DevChat, sandbox };
}

test('the harness reproduces the bug: a web pick makes the launchpad stick', () => {
  const { DevChat } = makeDevChat();
  assert.equal(DevChat._launchpadVenue(), null, 'an ordinary session is a chat');

  // What picking "Claude or Codex WebUI" does.
  DevChat.currentSession.build_venue = 'web-claude-code';
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code', 'now it is a launchpad');

  // Clearing the COLUMN alone — the old fix — does not bring the chat back,
  // because _devFlowTarget answers from the in-memory wizard first. This
  // assertion is the bug, written down.
  DevChat.currentSession.build_venue = null;
  assert.equal(
    DevChat._launchpadVenue(), 'web-claude-code',
    'clearing build_venue alone must NOT be enough — if this ever passes as '
      + 'null, the short-circuit is gone and this test is guarding nothing',
  );
});

test('_devFlowReturnToChat brings the composer back', () => {
  const { DevChat } = makeDevChat();
  DevChat.currentSession.build_venue = 'web-claude-code';
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code');

  DevChat.currentSession.build_venue = null;
  DevChat._devFlowReturnToChat();
  assert.equal(DevChat._launchpadVenue(), null, 'the session is a chat again');
});

test('a saved dev_flow_preference is no longer a third way back in', () => {
  // It WAS the third way, and the reason `dismissed` had to be the lever
  // rather than a cleared `mode`: that branch read the user's stored default
  // and answered "wizard" on the very next paint. It also meant a launchpad
  // nothing had recorded, under a header that said On-Platform — so #1353
  // closed the door instead of out-ranking it, and `dismissed` now has only
  // the in-memory wizard left to clear. See tests/venue-surface-sync.test.js.
  const { DevChat, sandbox } = makeDevChat();
  sandbox.App.user.devFlowPreference = 'claude-code';
  assert.equal(DevChat._launchpadVenue(), null,
    'a standing preference is not a decision about THIS session');
  assert.equal(DevChat._currentVenueId(), 'usernode-claude',
    'and the header agrees, which is the whole point');

  // Picking the hand-off is still one click, and still comes back.
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code');
  DevChat._devFlowReturnToChat();
  assert.equal(DevChat._launchpadVenue(), null);
});

test('it also beats a stored own-tools venue coming back through the flow', () => {
  const { DevChat } = makeDevChat();
  DevChat.currentSession.build_venue = 'own-tools-pr';
  assert.equal(DevChat._launchpadVenue(), 'own-tools-pr');
  // own-tools is answered by the venue column, not the wizard — so the
  // column clear is what matters there, and the flow reset must not be
  // required to do it.
  DevChat.currentSession.build_venue = null;
  assert.equal(DevChat._launchpadVenue(), null);
});

test('picking a web venue again after returning still works', () => {
  // _devFlowFromCredits sets dismissed back to false, so the return is a
  // per-session decision and not a one-way door.
  const { DevChat } = makeDevChat();
  DevChat._devFlowFromCredits('claude-code', null);
  DevChat._devFlowReturnToChat();
  assert.equal(DevChat._launchpadVenue(), null);

  DevChat.currentSession.build_venue = 'web-codex';
  DevChat._devFlowFromCredits('codex', null);
  assert.equal(DevChat._launchpadVenue(), 'web-codex', 'the launchpad can be chosen again');
});

test('driving the REAL sheet: picking On-Platform returns the session to chat', () => {
  // The end-to-end one, and the only test here that would have caught the
  // original bug. The five above call _devFlowReturnToChat directly, so
  // they prove the method works — not that the pick handler calls it. This
  // one goes through BuildVenues.open, so the actual onPick callback runs.
  const { DevChat, sandbox } = makeDevChat();
  DevChat.currentSession.build_venue = 'web-claude-code';
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code', 'starting on a launchpad');

  // Stand in for the kit: capture the rows the sheet offers and click the
  // On-Platform one, exactly as a user would.
  let offered = null;
  sandbox.PlatformUI.hasKit = () => true;
  sandbox.PlatformUI.menu = (opts) => {
    offered = opts.items;
    const row = opts.items.find((i) => /On-Platform/.test(i.label));
    assert.ok(row, 'the sheet offers On-Platform');
    row.handler();
    return Promise.resolve(null);
  };
  DevChat.openVenueSheet();

  assert.ok(offered, 'the sheet actually opened');
  assert.equal(DevChat.currentSession.build_venue, null, 'the stored venue is cleared');
  assert.equal(
    DevChat._launchpadVenue(), null,
    'and the session is a chat again — this is the assertion that failed in '
      + 'production while the venue column was being cleared correctly',
  );
});

test('the On-Platform branch does all three things, in an order that works', () => {
  // Source-level, because the pick handler lives inside a menu callback the
  // harness cannot reach. It is a companion to the behavioural tests above,
  // not a substitute: the last regression passed a check like this one.
  const branch = SRC.match(/if \(row\.venue === null\) \{[\s\S]*?\n {8}\}/);
  assert.ok(branch, 'the On-Platform branch must exist');
  const clear = branch[0].indexOf('DevChat.currentSession.build_venue = null');
  const flow = branch[0].indexOf('_devFlowReturnToChat()');
  const paint = branch[0].indexOf('DevChat.renderChatView()');
  assert.ok(clear > -1, 'the stored venue is cleared');
  assert.ok(flow > -1, 'the in-memory walkthrough is cleared');
  assert.ok(paint > -1, 'and the pane repaints without waiting on the network');
  assert.ok(clear < flow && flow < paint,
    'both pieces of state must be settled BEFORE the repaint reads them');
});
