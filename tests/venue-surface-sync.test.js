// The session type and the screen under it are ONE answer (#1353).
//
// A session states where it is being built in its header — the venue
// dropdown, top right (#1348) — and the sheet behind it ticks the coarse
// choice that venue belongs to. Underneath, the same session renders either
// a composer or a launchpad. Those were two derivations:
//
//     _currentVenueId()   → BuildVenues.currentVenue(the session's columns)
//     _launchpadVenue()   → …that, OR a wizard target derived from the
//                            user's saved dev_flow_preference
//
// and the second knew something the first did not. So a fresh session,
// belonging to anyone who had ever picked a web venue once (picking one
// saves the preference), opened saying "On-Platform" over the Claude Code
// walkthrough. The only way out was to pick another venue and come back,
// which set an in-memory `dismissed` flag — per tab, so a reload put the
// launchpad straight back.
//
// This is a BEHAVIOURAL test, for the reason tests/venue-return-to-chat.js
// spells out: the previous fix in this area was guarded by a regex over the
// source, which cannot see two correct-looking functions disagreeing. This
// one drives the real DevChat in a vm sandbox and asserts the two answers
// against each other, across every state that used to be able to split
// them.
//
// Run with: node --test tests/venue-surface-sync.test.js

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
  DevChat.renderChatView = () => {};
  DevChat.renderMessages = () => {};
  DevChat._devFlowEnsureStatus = () => {};
  return { DevChat, sandbox };
}

// The invariant, in one place: whatever the header says this session is,
// the screen under it has to be that. A launchpad venue gets a launchpad; an
// in-chat venue gets the composer.
function assertAgrees(DevChat, sandbox, because) {
  const venue = DevChat._currentVenueId();
  const surface = DevChat._launchpadVenue();
  const isHandoff = sandbox.Launchpad.isLaunchpad(venue);
  assert.equal(
    surface, isHandoff ? venue : null,
    `${because}: the header says ${venue} and the screen is `
      + `${surface || 'the composer'}`,
  );
  return { venue, surface };
}

test('a saved web default no longer opens a launchpad over an On-Platform header', () => {
  // The bug, exactly as reported: the window starts saying On-Platform and
  // shows the WebUI screen, and you have to change type and change back.
  const { DevChat, sandbox } = makeDevChat();
  sandbox.App.user.devFlowPreference = 'claude-code';

  const { venue } = assertAgrees(DevChat, sandbox, 'a saved claude-code default');
  assert.equal(venue, 'usernode-claude',
    'nothing has been chosen for THIS session, so it is an ordinary chat');
  assert.equal(DevChat._launchpadVenue(), null, 'and it opens on the composer');
  // The walkthrough must not arrive in the transcript by the other door
  // either — that would be the same mismatch, one element lower.
  assert.equal(DevChat._devFlowTarget(), null);
  assert.equal(DevChat._devFlowHtml(), '');
});

test('the saved default survives a reload, so the fix has to as well', () => {
  // The old escape hatch was `dismissed`, which lives in the tab. Re-opening
  // the session is a fresh _resetDevFlow, and the preference is still set —
  // which is why "pick another venue and come back" had to be done again
  // every single time.
  const { DevChat, sandbox } = makeDevChat();
  sandbox.App.user.devFlowPreference = 'codex';
  DevChat._resetDevFlow(7);
  assertAgrees(DevChat, sandbox, 'a reopened session with a saved codex default');
  assert.equal(DevChat._launchpadVenue(), null);
});

test('picking a hand-off in this tab moves the header with the screen', () => {
  // The other half of "synced": choosing the WebUI venue must not leave the
  // header claiming On-Platform. Nothing is stored yet at this point — the
  // pick is in memory until _persistBuildVenue answers — and the header has
  // to state it anyway, because the launchpad is already on screen.
  const { DevChat, sandbox } = makeDevChat();
  DevChat._devFlowFromCredits('claude-code', null);
  const { venue } = assertAgrees(DevChat, sandbox, 'a hand-off picked in this tab');
  assert.equal(venue, 'web-claude-code');
  assert.equal(sandbox.BuildVenues.currentChoice({ current: venue }), 'web-agent',
    'and the sheet ticks the WebUI row, not On-Platform');
});

test('every stored venue paints the surface it names', () => {
  const { DevChat, sandbox } = makeDevChat();
  for (const [stored, expected] of [
    ['web-claude-code', 'web-claude-code'],
    ['web-codex', 'web-codex'],
    ['own-tools-pr', 'own-tools-pr'],
    [null, null],
  ]) {
    DevChat.currentSession.build_venue = stored;
    const { surface } = assertAgrees(DevChat, sandbox, `build_venue=${stored}`);
    assert.equal(surface, expected);
  }
});

test('an in-chat venue is a chat, whatever else is true of the session', () => {
  // A saved web default in every case, because that is the input that used
  // to be able to turn any of these into a launchpad the header denied.
  const cases = [
    ['an OpenRouter session', (dc) => { dc.currentSession.agent_backend = 'codex_openrouter'; }],
    ['a leased session', (dc) => { dc._localAgent = { label: 'Laptop', leaseId: 'l1' }; }],
    ['a session with a PR', (dc) => { dc.currentSession.pr_number = 12; }],
    ['a session with messages', (dc) => { dc.messages = [{ role: 'user', content: 'hi' }]; }],
    ['a paused session', (dc) => { dc.currentSession.status = 'paused'; }],
  ];
  for (const [because, mutate] of cases) {
    const { DevChat, sandbox } = makeDevChat();
    sandbox.App.user.devFlowPreference = 'claude-code';
    mutate(DevChat);
    assertAgrees(DevChat, sandbox, because);
    assert.equal(DevChat._launchpadVenue(), null, `${because} keeps its composer`);
  }
});

test('an imported proposal is its own venue, and says so', () => {
  const { DevChat, sandbox } = makeDevChat();
  DevChat.currentSession.source = 'imported';
  const { venue } = assertAgrees(DevChat, sandbox, 'an imported proposal');
  assert.equal(venue, 'own-tools-pr');
  assert.equal(DevChat._launchpadVenue(), 'own-tools-pr');
});

test('"Build here instead" clears the stored venue, not just this tab', () => {
  // The launchpad's own way back. Setting `dismissed` alone left the column
  // saying web-claude-code, so the header went on naming the web and the
  // next paint put the launchpad back — the same split, from the other end.
  const { DevChat, sandbox } = makeDevChat();
  DevChat.currentSession.build_venue = 'web-claude-code';
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code', 'starting on a launchpad');

  DevChat._devFlowAction('cancel');

  assert.equal(DevChat.currentSession.build_venue, null, 'the column is cleared');
  assertAgrees(DevChat, sandbox, 'after choosing to build here');
  assert.equal(DevChat._launchpadVenue(), null, 'and the composer is back');
});

test('the ?shot=launchpad deep link moves both answers together', () => {
  // A staging reviewer has no session of their own to hand over, so the URL
  // names the venue. It has to reach the HEADER too, or the screenshot shows
  // a launchpad under a header that denies it.
  const { DevChat, sandbox } = makeDevChat();
  sandbox.location.search = '?shot=launchpad&venue=web-codex';
  const { venue } = assertAgrees(DevChat, sandbox, 'a ?shot=launchpad URL');
  assert.equal(venue, 'web-codex');
});
