// The build-flow picker and its guided walkthrough (#1049).
//
// public/js/dev-flow-select.js is pure render + wire: it never fetches, so
// every branch is reachable from node with no DOM and no server. That is the
// point of the split, and these tests are what it buys.
//
// The properties worth pinning:
//
//   1. exactly one step is 'current' — the first one that is not done. That
//      single rule is what makes the walkthrough RESUMABLE: nothing is
//      remembered on the client, so a person who closes the tab half-way
//      through and comes back must land on the same step, derived only from
//      what the server can see;
//   2. only the current step offers buttons (three live "Check again"s down
//      one card is noise, and acting on a later step out of order just
//      produces an error nobody needed);
//   3. the external pair disappears — rather than failing on click — when the
//      deployment or the app cannot support it; and
//   4. GitHub-supplied strings (a fork owner, a branch name, the platform's
//      own error text) are escaped, never injected.
//
// Run with: node --test tests/dev-flow-select.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DevFlowSelect = require('../public/js/dev-flow-select.js');

const AUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/auth.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);

// A status payload with every stage satisfied; individual tests knock pieces
// out to walk the person backwards through the flow.
function fullStatus(over) {
  return Object.assign({
    available: true,
    repo: { owner: 'usernode-apps', repo: 'demo' },
    github: { linked: true, login: 'octo-contributor', available: true },
    // Connected by default now: the connector is a REQUIREMENT, not the
    // advisory note it used to be, so without one the hand-off step is not the
    // hand-off step at all — it is "Connect Homeroom".
    connectors: { count: 2 },
    fork: {
      state: 'ready',
      owner: 'octo-contributor',
      repo: 'demo',
      url: 'https://api.github.com/repos/octo-contributor/demo',
      pageUrl: 'https://github.com/octo-contributor/demo',
    },
    // No `task`. Homeroom does not mint the work order any more: it hands over
    // instructions, and the agent asks what to build and mints its own.
    instructions: 'Ask the user what to build, then call prepare_work.',
    targetKind: null,
  }, over || {});
}

function stateOf(list) {
  return list.reduce((acc, step) => {
    acc[step.key] = step.state;
    return acc;
  }, {});
}

test('FLOWS is the allowlist plus the venue name, and nothing else', () => {
  assert.deepEqual(
    DevFlowSelect.FLOWS.map((f) => f.id),
    ['platform', 'claude-code', 'codex'],
    'building here stays first — it is what most people want and needs no setup'
  );
  for (const flow of DevFlowSelect.FLOWS) {
    assert.ok(flow.title.length > 0, `${flow.id} has a title`);
    // The blurbs and CTAs belonged to the picker card, and the picker is
    // gone: public/js/build-venues.js is the one place a venue is described
    // to the user, and it covers three venues this list cannot name. A
    // second description here is exactly the drift that made "Claude Code"
    // mean two products.
    assert.equal(flow.blurb, undefined, `${flow.id} must not re-describe its venue`);
    assert.equal(flow.cta, undefined, `${flow.id} must not carry its own CTA`);
  }
  assert.equal(typeof DevFlowSelect.pickerHtml, 'undefined',
    'the picker card is retired — the venue line above the composer replaced it');
  assert.equal(typeof DevFlowSelect.flowsFor, 'undefined',
    'and the gating that fed it went with it');
});

test('the flow ids match the server allowlist exactly', () => {
  // Three places have to agree: this list, DEV_FLOWS in src/routes/auth.js
  // (which validates POST /api/me/dev-flow) and the CHECK constraint on
  // users.dev_flow_preference. A fourth flow that lands in one only would
  // either be unsaveable or be rejected by Postgres.
  const declared = AUTH_SRC.match(/const DEV_FLOWS = \[([^\]]+)\]/);
  assert.ok(declared, 'src/routes/auth.js declares DEV_FLOWS');
  const serverFlows = declared[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(
    serverFlows,
    DevFlowSelect.FLOWS.map((f) => f.id),
    'DEV_FLOWS and DevFlowSelect.FLOWS must list the same flows'
  );

  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const check = schema.match(/dev_flow_preference IN \(([^)]+)\)/);
  assert.ok(check, 'schema.sql constrains users.dev_flow_preference');
  const dbFlows = check[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(dbFlows.sort(), serverFlows.slice().sort(),
    'the CHECK constraint must accept exactly the flows the route accepts');
});

test('picking a venue persists it, with no second question about it', () => {
  // The picker asked twice: once for the flow, once for "remember my
  // choice — don't ask again", unticked by default. So the common path
  // answered the same question in every new session. Opening the venue
  // sheet is already the deliberate act, so the save rides along with it.
  const devChat = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
  );
  assert.match(devChat, /_saveDevFlowPreference\(pick\.flow\)/,
    'a flow picked in the sheet becomes the saved default');
  assert.match(devChat, /'\/api\/me\/dev-flow'/, 'through the route that owns the column');
  assert.ok(!devChat.includes('data-flow-remember'),
    'and there is no "remember my choice" tick left to forget');
});

test('the external pair is withheld, not offered-then-failed', () => {
  // The gating moved to build-venues.js with the list itself; what stays
  // here is the copy that explains a withheld hand-off, which the
  // walkthrough still renders when the server says the flow cannot run.
  const html = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: { available: false, reason: 'no_repository' },
  });
  assert.match(html, /no GitHub repository yet/);
  assert.ok(!html.includes('data-flow-pick='), 'nothing here is pickable any more');
});

test('every reason code the status route can send becomes real copy', () => {
  // Two producers: the status route, and the dev chat's own fallback when
  // the read fails outright. A code with no copy would render an empty
  // explanation under a card offering one option.
  const codes = new Set();
  for (const rel of ['../src/routes/dev-flow.js', '../frontend/src/features/dev-chat/dev-chat.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    // Per LINE, because the route's reason is a ternary over three codes on
    // one line rather than three separate literals.
    for (const line of src.split('\n')) {
      if (!/\breason:/.test(line)) continue;
      for (const m of line.matchAll(/'([a-z_]+)'/g)) codes.add(m[1]);
    }
  }
  assert.ok(codes.size >= 3, `the route sends reason codes (got ${codes.size})`);
  for (const code of codes) {
    assert.ok(
      DevFlowSelect.unavailableNote(code).length > 0,
      `reason '${code}' has no user-facing copy in unavailableNote()`
    );
  }
});

test('only the current step offers buttons', () => {
  const list = DevFlowSelect.steps(
    fullStatus({ fork: null, task: null, branch: null }), 'codex'
  );
  for (const step of list) {
    if (step.state === 'current') continue;
    assert.deepEqual(step.actions, [], `${step.key} (${step.state}) offers no buttons`);
  }
});

test('the walkthrough resumes from the server alone', () => {
  // The same payload must always produce the same card: there is no client
  // memory to diverge from, which is what makes closing the tab safe.
  const status = fullStatus({ task: null, branch: null });
  assert.equal(
    DevFlowSelect.wizardHtml({ agent: 'claude-code', status }),
    DevFlowSelect.wizardHtml({ agent: 'claude-code', status }),
  );
  // And the agent survives a reload with no client state, because the task
  // row carries it (external-agent-tasks records the picked agent in
  // client_id, and the status route reads it back).
  const html = DevFlowSelect.wizardHtml({ status: fullStatus() });
  assert.match(html, /Building with Claude Code/,
    'with no agent passed, the open task names it');
});

test('a status still in flight says so instead of showing a wrong step', () => {
  const html = DevFlowSelect.wizardHtml({ agent: 'codex', status: null });
  assert.match(html, /Building with Codex/);
  assert.match(html, /Checking where you are/);
  assert.ok(!html.includes('data-flow-step='), 'no steps are guessed at');
});

test('an unavailable flow offers the way back to the platform', () => {
  const html = DevFlowSelect.wizardHtml({
    agent: 'claude-code',
    status: { available: false, reason: 'no_repository' },
  });
  assert.match(html, /no GitHub repository yet/);
  assert.match(html, /data-flow-action="cancel"/,
    'a dead end must offer "build here instead", not trap the user');
});

test('busy disables the buttons rather than reordering the card', () => {
  const status = fullStatus();
  const idle = DevFlowSelect.wizardHtml({ status });
  const busy = DevFlowSelect.wizardHtml({ status, busy: true });
  // #1281: scoped to the STEP actions. The vendor toggle above them always
  // renders the CURRENT vendor disabled — that button is a statement of
  // where you are rather than an offer — so a bare "no 'disabled' anywhere"
  // check now fails on correct markup. What this test is about is that an
  // in-flight request disables the action that started it, and that is
  // still exactly what is asserted.
  const stepButtons = (html) => html.match(/<button[^>]*data-flow-action="(?!vendor-)[^"]*"[^>]*>/g) || [];
  assert.ok(stepButtons(idle).length > 0, 'the idle card offers at least one step action');
  assert.ok(
    !stepButtons(idle).some((b) => /disabled/.test(b)),
    'no step action is disabled while idle',
  );
  assert.match(busy, /data-flow-action="copy"[^>]*disabled/,
    'the in-flight action is disabled, so it cannot be fired twice');
  // Same steps, same order — only the buttons change.
  assert.equal(
    (busy.match(/data-flow-step=/g) || []).length,
    (idle.match(/data-flow-step=/g) || []).length,
  );
});

test('errors and notices are shown in the card, not thrown away in a toast', () => {
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus(),
    error: 'GitHub rejected the request.',
    notice: 'Copied.',
  });
  assert.match(html, /dc-flow-error/);
  assert.match(html, /GitHub rejected the request\./);
  assert.match(html, /dc-flow-notice/);
  assert.match(html, /Copied\./);
});

test('the handoff step links the agent the user actually picked', () => {
  const claude = DevFlowSelect.wizardHtml({
    agent: 'claude-code', status: fullStatus(),
  });
  assert.match(claude, /https:\/\/claude\.ai\/code/);
  assert.match(claude, /Open Claude Code/);

  // The vendor comes from the picker alone now. It used to be read back off
  // the minted task's client_id, which no longer exists to read.
  const codex = DevFlowSelect.wizardHtml({
    agent: 'codex',
    status: fullStatus(),
  });
  assert.match(codex, /https:\/\/chatgpt\.com\/codex/);
  assert.match(codex, /Open Codex/);

  assert.equal(DevFlowSelect.agentLabel('claude-code'), 'Claude Code');
  assert.equal(DevFlowSelect.agentLabel('codex'), 'Codex');
  assert.equal(DevFlowSelect.agentLabel('mystery'), 'your coding agent');
  assert.equal(DevFlowSelect.agentUrl('mystery'), '',
    'an unknown agent gets no link rather than a broken one');
});

test('a failed fork read is reported honestly, not as "no fork"', () => {
  // inspectFork answers 'unknown' when GitHub could not be read. Telling
  // someone to fork a repository they have already forked sends them to a
  // page that offers no fork button — so the copy has to hedge.
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus({ fork: { state: 'unknown' }, task: null, branch: null }),
  });
  assert.match(html, /could not read GitHub/);
  assert.match(html, /data-flow-action="refresh"/);
  assert.ok(!html.includes('No fork yet'));
});

test('GitHub-supplied names are escaped, never injected', () => {
  // fork.owner/repo, task.branch and the work order all originate outside
  // the platform. The card must not be an HTML sink.
  const html = DevFlowSelect.wizardHtml({
    status: fullStatus({
      github: { linked: true, login: '<img src=x onerror="alert(1)">' },
      fork: { state: 'ready', owner: '<script>', repo: '"onmouseover="' },
      task: {
        id: 1,
        agent: 'codex',
        branch: '<b>evil</b>',
        baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        workOrder: '<img src=x onerror="alert(1)">',
      },
    }),
  });
  assert.ok(!html.includes('<img'), 'no raw tag survives');
  assert.ok(!html.includes('onerror="'), 'no attribute injection');
  assert.ok(!html.includes('<b>evil</b>'));
  assert.ok(html.includes('&lt;img'), 'it renders as escaped text instead');
});

test('a plain anchor is left to the browser', () => {
  // wire() acts on [data-flow-action] only: a click on an anchor carrying none
  // reaches no handler, so the browser's own hash navigation is what runs.
  const calls = [];
  const anchor = { tagName: 'A', getAttribute: (n) => (n === 'href' ? '#settings/connectors' : null), closest: () => null };
  const root = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    contains: () => true,
  };
  DevFlowSelect.wire(root, { onAction: (a) => calls.push(a) });
  let prevented = false;
  root.listeners.click({ target: anchor, preventDefault: () => { prevented = true; } });
  assert.deepEqual(calls, []);
  assert.equal(prevented, false);
});

// ── wire() ─────────────────────────────────────────────────────────────
//
// Minimal DOM stand-ins: enough to prove one handler is attached, that a
// real anchor's navigation is left to the browser (#1312) while still being
// reported to the caller, and that the non-anchor fallback still opens its
// data-flow-href.

function fakeRoot(box) {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { listeners.push(fn); },
    contains() { return true; },
    querySelector() { return box || null; },
  };
}

function clickOn(root, attrs) {
  root.listeners[0]({
    target: { closest: () => ({ getAttribute: (name) => (name in attrs ? attrs[name] : null) }) },
    preventDefault() {},
  });
}

test('wire() attaches one handler per node', () => {
  const root = fakeRoot();
  DevFlowSelect.wire(root, {});
  DevFlowSelect.wire(root, {});
  assert.equal(root.listeners.length, 1,
    're-rendering the card must not stack duplicate handlers');
});

test('a pick button is no longer something this module answers', () => {
  // The picker's rows are gone; wire() handles walkthrough actions only.
  // Left over markup (a stale render, a hand-written fixture) must not
  // quietly re-enter through the click handler.
  const seen = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });
  clickOn(root, { 'data-flow-pick': 'codex' });
  assert.deepEqual(seen, [], 'a data-flow-pick click reaches nothing');
});

test('a non-anchor node with a data-flow-href still opens it (fallback)', () => {
  // The rendered markup gives href actions a real <a> now, but wire() is
  // deliberately tolerant of straggler non-anchor markup (a stale render,
  // a fixture): a button carrying data-flow-href keeps the old scripted
  // trip out, and the action is reported either way.
  const seen = [];
  const opened = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });

  const originalWindow = global.window;
  global.window = { open: (url, target, features) => opened.push([url, target, features]) };
  try {
    clickOn(root, {
      'data-flow-action': 'open-agent',
      'data-flow-href': 'https://claude.ai/code',
    });
    clickOn(root, { 'data-flow-action': 'refresh' });
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }

  assert.deepEqual(opened, [['https://claude.ai/code', '_blank', 'noopener']],
    'the trip out is a new tab with noopener, so the chat survives it');
  assert.deepEqual(seen, ['open-agent', 'refresh'],
    'the caller still hears about the click, so it can re-poll on return');
});

test('an href action renders as a real anchor, never a scripted button (#1312)', () => {
  // A button that window.open()s never leaves the page on mobile: popup
  // heuristics eat the scripted open in mobile browsers, and the Homeroom
  // app's webview is bound to the platform's own domains, so github.com and
  // claude.ai can only leave for the system browser the way a plain
  // target="_blank" anchor does. "Fork on GitHub" was the report (#1312);
  // "Open Claude Code" / "Open Codex" share the path.
  const forkHtml = DevFlowSelect.wizardHtml({
    status: fullStatus({
      fork: { state: 'missing', owner: 'octo-contributor', repo: 'demo', pageUrl: 'https://github.com/usernode-apps/demo/fork' },
      task: null,
      branch: null,
    }),
  });
  const fork = forkHtml.match(/<a [^>]*data-flow-action="open-fork"[^>]*>/);
  assert.ok(fork, '"Fork on GitHub" is an anchor');
  assert.match(fork[0], /href="https:\/\/github\.com\/usernode-apps\/demo\/fork"/);
  assert.match(fork[0], /target="_blank"/, 'the trip out stays a new tab');
  assert.match(fork[0], /rel="noopener"/, 'and the chat survives it');
  assert.ok(!forkHtml.includes('data-flow-href'),
    'no scripted-open attribute remains for the browser-owned navigation');

  const handoffHtml = DevFlowSelect.wizardHtml({ status: fullStatus() });
  const agent = handoffHtml.match(/<a [^>]*data-flow-action="open-agent"[^>]*>/);
  assert.ok(agent, '"Open Claude Code" is an anchor too');
  assert.match(agent[0], /href="https:\/\/claude\.ai\/code"/);
  assert.match(handoffHtml, /<button [^>]*data-flow-action="copy"/,
    'actions with no destination stay buttons');
});

test('busy keeps the disabled-button rendering for href actions', () => {
  // An anchor cannot be disabled, and while a request is running the trip
  // out is supposed to be unavailable like every other action — so busy
  // falls back to the button form, exactly as before.
  const html = DevFlowSelect.wizardHtml({ status: fullStatus(), busy: true });
  assert.ok(!/<a [^>]*data-flow-action="open-agent"/.test(html));
  const btn = html.match(/<button [^>]*data-flow-action="open-agent"[^>]*>/);
  assert.ok(btn, 'the busy form is a button again');
  assert.match(btn[0], /disabled/);
});

test('an anchor click is left to the browser and still reported (#1312)', () => {
  // preventDefault or a scripted window.open here would take the navigation
  // back from the browser — the exact path mobile drops. The caller still
  // hears about the click so it can re-poll after the trip out.
  const seen = [];
  const opened = [];
  let prevented = 0;
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onAction: (action) => seen.push(action) });

  const originalWindow = global.window;
  global.window = { open: (...args) => opened.push(args) };
  try {
    const attrs = {
      'data-flow-action': 'open-fork',
      href: 'https://github.com/usernode-apps/demo/fork',
    };
    root.listeners[0]({
      target: {
        closest: () => ({
          tagName: 'A',
          getAttribute: (name) => (name in attrs ? attrs[name] : null),
        }),
      },
      preventDefault() { prevented += 1; },
    });
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }

  assert.deepEqual(seen, ['open-fork'], 'the caller can re-poll on return');
  assert.deepEqual(opened, [], 'no scripted open rides along with the navigation');
  assert.equal(prevented, 0, 'the browser keeps the activation');
});

test('a node with neither attribute is ignored', () => {
  const seen = [];
  const root = fakeRoot();
  DevFlowSelect.wire(root, { onPick: () => seen.push('pick'), onAction: () => seen.push('action') });
  root.listeners[0]({ target: { closest: () => null }, preventDefault() {} });
  assert.deepEqual(seen, []);
});

test('the dev chat wires the marker the wizard actually renders (#1304)', () => {
  // #1093 retired the picker card together with its data-flow-card="1"
  // marker, but the transcript wiring kept selecting [data-flow-card] — so
  // the walkthrough rendered with dead buttons: "Fork on GitHub" opened
  // nothing, "Copy work order" copied nothing, "Check again" checked
  // nothing. Pin the wiring selector to the attribute wizardHtml emits, in
  // every state it renders, so renaming either side breaks this test
  // instead of the card.
  for (const [name, state] of [
    ['loading', { agent: 'claude-code', status: null }],
    ['unavailable', { agent: 'claude-code', status: { available: false, reason: 'no_repository' } }],
    ['steps', { status: fullStatus() }],
  ]) {
    assert.match(DevFlowSelect.wizardHtml(state), /data-flow-wizard="1"/,
      `the ${name} card carries the marker the wiring selects`);
  }
  assert.match(DEV_CHAT_SRC, /querySelectorAll\('\[data-flow-wizard\]'\)/,
    'dev-chat.js must wire the marker the wizard renders');
  assert.ok(!DEV_CHAT_SRC.includes('[data-flow-card]'),
    'the picker marker is gone from the markup, so selecting it wires nothing');
});

test('the dev chat is the module\'s only consumer, and owns the fetching', () => {
  // The split this file relies on: DevFlowSelect renders, dev-chat.js talks
  // to the server. A fetch appearing in the module would make these tests
  // impossible to run.
  const MODULE_SRC = fs.readFileSync(
    path.join(__dirname, '../public/js/dev-flow-select.js'), 'utf8'
  );
  assert.ok(!/\bfetch\s*\(/.test(MODULE_SRC),
    'dev-flow-select.js must not fetch — the caller owns that');
  assert.match(DEV_CHAT_SRC, /DevFlowSelect\.wizardHtml\(/);
  assert.match(DEV_CHAT_SRC, /DevFlowSelect\.wire\(/);
  assert.match(DEV_CHAT_SRC, /dev-flow\/status/,
    'dev-chat.js reads the status the walkthrough is derived from');
});


// ── "Start over" (the stale-work-order fix) ─────────────────────────────
//
// It has to live on the HAND-OFF step. Step 3 is `done` for as long as a task
// exists — and the mapper gives buttons only to the step that is current — so
// a button placed there would never render. Step 4 is also where the user is
// actually standing when a stale work order is in front of them.


// ── Three steps, and the agent does the rest ────────────────────────────
//
// Homeroom used to mint the work order: the user typed a brief into step 3,
// two more steps walked them through copying it and coming back to press
// Submit, and a task sat in this tab tracking all of it. That tracking is what
// a stale work order got stuck in. The agent has the connector, so it asks
// what to build and mints its own.

test('the walkthrough is three steps and ends at the hand-off', () => {
  const list = DevFlowSelect.steps(fullStatus(), 'claude-code');
  assert.deepEqual(list.map((s) => s.key), ['github', 'fork', 'handoff']);
  // Terminal: nothing after it for this tab to know about, so it is never
  // `done` and always the step you land on once GitHub and the fork are.
  assert.equal(list[2].state, 'current');
  assert.ok(!list.some((s) => s.key === 'prepare' || s.key === 'submit'),
    'no brief to type and no Submit to come back for');
});

test('exactly one step is current, and it is the first unfinished one', () => {
  const cases = [
    // The fork has to be unset alongside: a later step that is genuinely
    // `done` stays `done`, and the mapper is right to say so.
    [{ github: { linked: false }, fork: null }, 'github'],
    [{ fork: null }, 'fork'],
    [{}, 'handoff'],
  ];
  for (const [over, expected] of cases) {
    const list = DevFlowSelect.steps(fullStatus(over), 'claude-code');
    const current = list.filter((s) => s.state === 'current');
    assert.equal(current.length, 1, `one current step for ${JSON.stringify(over)}`);
    assert.equal(current[0].key, expected);
    const at = list.indexOf(current[0]);
    list.forEach((step, i) => {
      if (i < at) assert.equal(step.state, 'done');
      if (i > at) assert.equal(step.state, 'todo');
    });
  }
});

test('the connector is a requirement, not a note beside the step', () => {
  // It used to be advisory copy under the hand-off step: paste anyway, come
  // back here to Submit. That is no longer possible — without the connector
  // the agent cannot call prepare_work, so it has no base commit and no task
  // id, and there is nothing useful to hand it.
  const none = DevFlowSelect.steps(fullStatus({ connectors: { count: 0 } }), 'claude-code')[2];
  assert.equal(none.title, 'Connect Homeroom');
  assert.deepEqual(none.actions.map((a) => a.action), ['link-connector', 'refresh']);
  assert.ok(!none.actions.some((a) => a.action === 'copy'),
    'nothing to copy until the agent can act on it');

  const some = DevFlowSelect.steps(fullStatus({ connectors: { count: 1 } }), 'claude-code')[2];
  assert.match(some.title, /^Hand it to /);
  assert.deepEqual(some.actions.map((a) => a.action), ['copy', 'open-agent']);
  assert.equal(some.actions[0].label, 'Copy instructions');
});

test('the hand-off says the agent asks, and that you do not come back', () => {
  const step = DevFlowSelect.steps(fullStatus(), 'claude-code')[2];
  assert.match(step.detail, /ask/i, 'it says the agent asks what to build');
  assert.match(step.detail, /do not come back here to finish/,
    'and that there is no Submit waiting in this tab');

  // A continuation names what it continues, so the agent updates that work
  // rather than opening a second copy beside it.
  for (const kind of ['session', 'proposal']) {
    const cont = DevFlowSelect.steps(fullStatus({ targetKind: kind }), 'claude-code')[2];
    assert.match(cont.detail, new RegExp(`the ${kind} this continues`));
    assert.match(cont.detail, /update to it rather than as a second copy/);
  }
  assert.doesNotMatch(step.detail, /this continues/, 'and an ordinary run says none of that');
});

test('the card renders the instructions, not a work order', () => {
  const html = DevFlowSelect.wizardHtml({
    agent: 'claude-code',
    status: fullStatus({ instructions: 'Ask the user what to build, then call prepare_work.' }),
  });
  assert.match(html, /Copy instructions/);
  assert.match(html, /Ask the user what to build, then call prepare_work\./,
    'the instructions are on the card, so a failed clipboard can be copied by hand');
  assert.ok(!/data-flow-brief/.test(html), 'no brief field: the agent asks instead');
  for (const gone of ['prepare', 'submit', 'submit-update', 'discard']) {
    assert.ok(!new RegExp(`data-flow-action="${gone}"`).test(html),
      `${gone} is not an action any more`);
  }
});

// #2088. The disclosure opened by default from #2041 on: the text seemed
// short enough to just read. In use the open box took over the card, on a
// phone the whole screen, and the button people press is Copy, which never
// reads the node. So it starts collapsed, and three things have to hold for
// that to be safe: the text is still on the card for a clipboard that
// refuses; the copy action carries it from the status payload rather than
// from the collapsed DOM; and the declared check asserts on the summary,
// because a collapsed body is not there to be seen, which is how dapp.json's
// other details-based checks are written too.
test('the instructions start collapsed, and the copy action does not need them open (#2088)', () => {
  const text = 'Ask the user what to build, then call prepare_work.';
  const html = DevFlowSelect.wizardHtml({
    agent: 'claude-code',
    status: fullStatus({ instructions: text }),
  });
  const details = html.match(/<details class="dc-flow-order"[^>]*>/);
  assert.ok(details, 'the instructions sit in a disclosure');
  assert.doesNotMatch(details[0], /\bopen\b/, 'and it starts collapsed');
  assert.match(html,
    /<details class="dc-flow-order"><summary>Instructions<\/summary><pre class="dc-flow-order-text" data-flow-order="1">/,
    'the summary is what shows; the text is one tap behind it');
  assert.ok(html.includes(`data-flow-order="1">${text}</pre></details>`),
    'the full text is still on the card, for a clipboard that refuses');

  // The copy action reads the status payload, never the node it renders
  // into: a collapsed <pre> has no rendered text to copy from.
  const from = DEV_CHAT_SRC.indexOf("if (action === 'copy')");
  const to = DEV_CHAT_SRC.indexOf("if (action === 'prepare')", from);
  assert.ok(from > 0 && to > from, 'the dev chat still answers the copy action');
  const copy = DEV_CHAT_SRC.slice(from, to);
  assert.match(copy, /flow\.status\.instructions/, 'copied from state');
  assert.doesNotMatch(copy, /data-flow-order|dc-flow-order|querySelector/,
    'never read back out of the DOM');

  // dapp.json's check on the disclosure: on the summary of a closed details,
  // not on the body text.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../dapp.json'), 'utf8'));
  const checks = manifest.tests.filter((t) => /dc-flow-order/.test(t.expectSelector || ''));
  assert.equal(checks.length, 1, 'one declared check pins the disclosure');
  assert.match(checks[0].expectSelector, /details\.dc-flow-order:not\(\[open\]\) > summary/,
    'it selects the summary of a collapsed disclosure');
  assert.equal(checks[0].expectText, 'Instructions',
    'and asserts the text that is visible with the body collapsed');
});
