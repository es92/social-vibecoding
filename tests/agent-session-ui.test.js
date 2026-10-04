'use strict';

// The agent-session screen (#2779 step 4, docs/agent-sessions.md).
//
// What the user sees in a conversation with the Mayor is decided in one pure
// module, features/agent-session/transcript.ts, so the rules are pinned here
// rather than in a browser:
//
//   1. A CARD SHOWS EXACTLY WHAT IT WILL RUN. Its rows are its input, labelled,
//      and an input it cannot label is still shown rather than dropped.
//   2. A CARD PAST ITS EXPIRY IS EXPIRED even when the server has not swept it
//      yet: a Confirm that the server will refuse is not offered.
//   3. ONE OUTCOME, SAID ONCE. The action_result / action_dismissed note is
//      written for the Mayor (which reads text); under a card the transcript
//      draws, the card's own outcome line says it, so the note is skipped.
//   4. EACH WRITER MAPS TO ONE KIND: conversation events are dividers, a
//      coding-agent run (its start, progress, log and end rows) is ONE run
//      item named for the agent that actually ran, a drafted spec is a spec
//      item, a live preview is a preview item, anything else is a quiet note.
//   5. REPLY SUGGESTIONS BELONG TO THE LAST THING SAID, and only while it is
//      last.
//
// The inbox half: an agent session is an agent conversation, listed under
// Agents on the one clock, never under People.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const LATER = '2026-09-01T13:00:00Z';
const EARLIER = '2026-09-01T11:00:00Z';

const card = (over = {}) => ({
  id: 'a1',
  toolName: 'promote_change',
  title: 'Put the change up for the group vote',
  input: { changeId: 12, title: 'Dark mode', linkedIssues: [4, 7] },
  expiresAt: LATER,
  ...over,
});
const row = (id, role, content, metadata = {}, changeId = null) => ({
  id, role, content, metadata, changeId, createdAt: null,
});

test('a card lists exactly the input it will run with, labelled', () => {
  assert.deepEqual(
    transcript.cardRows({ slug: 'notes', changeId: 12, linkedIssues: [4, 7], body: '  two\n lines ', empty: '', none: null }),
    [['App', 'notes'], ['Change', '#12'], ['Links', 'Request #4, Request #7'], ['Details', 'two lines']],
  );
  // A key with no label of its own is still shown, humanised, never dropped.
  assert.deepEqual(transcript.cardRows({ baseBranch: 'main', dry_run: true }), [['Base Branch', 'main'], ['Dry run', 'true']]);
  // Long values are clipped for the card; the server holds the full input.
  const [[, long]] = transcript.cardRows({ body: 'x'.repeat(500) });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});

test('a pending card past its expiry is drawn expired; a decided one keeps its state and says its outcome', () => {
  const none = new Map();
  assert.equal(transcript.cardView(card(), none, NOW).status, 'pending');
  assert.equal(transcript.cardView(card({ expiresAt: EARLIER }), none, NOW).status, 'expired');

  const done = new Map([['a1', {
    id: 'a1', toolName: 'promote_change', title: '', status: 'done', expiresAt: EARLIER,
    result: { ok: true, text: 'raw', structured: { nextStep: 'The vote is open.' } },
  }]]);
  const view = transcript.cardView(card({ expiresAt: EARLIER }), done, NOW);
  assert.equal(view.status, 'done', 'a decided card is not re-labelled expired');
  assert.equal(view.outcome, 'The vote is open.');
});

test('the transcript maps each writer to one kind, and says a card outcome once', () => {
  const items = transcript.buildTranscript([
    row(1, 'user', 'Add dark mode to notes'),
    row(2, 'system', 'Started change #12', { agentSessionEvent: 'change_started' }, 12),
    row(3, 'assistant', 'Here is the plan.', { confirmations: [card()], quickReplies: ['Go ahead', ' '] }),
    row(4, 'system', 'Confirmed: Put the change up', { agentSessionEvent: 'action_result', actionId: 'a1', ok: true }),
    row(5, 'system', 'Confirmed elsewhere', { agentSessionEvent: 'action_result', actionId: 'zz', ok: false }),
    row(6, 'system', 'Built it', { ccOutput: 'Added a toggle.', ccOutcome: 'no_changes' }, 12),
    row(7, 'system', 'Preview is live', { stagingUrl: 'https://pr-9.example.test', prNumber: 9 }, 12),
    row(8, 'system', 'Preview (not a link)', { stagingUrl: 'javascript:alert(1)' }, 12),
    row(9, 'system', 'The turn failed', { agentSessionEvent: 'turn_failed' }),
    row(10, 'system', '   '),
  ], [], NOW);

  assert.deepEqual(items.map((i) => i.kind), ['user', 'divider', 'mayor', 'note', 'run', 'preview', 'note', 'note']);
  const [, divider, mayor, foreign, agent, preview, unsafe, failed] = items;
  assert.equal(divider.event, 'change_started');
  assert.deepEqual(mayor.quickReplies, ['Go ahead'], 'a blank suggestion is not a button');
  assert.equal(mayor.cards.length, 1);
  assert.ok(!items.some((i) => i.key === 'm4'), "the drawn card's own outcome note is not repeated under it");
  assert.equal(foreign.tone, 'error', 'an outcome for a card this transcript does not draw is still said');
  assert.equal(agent.status, 'no_changes');
  assert.equal(agent.output, 'Added a toggle.');
  assert.equal(agent.changeId, 12);
  assert.equal(preview.url, 'https://pr-9.example.test');
  assert.equal(preview.prNumber, 9);
  assert.equal(unsafe.kind, 'note', 'only an http(s) preview URL becomes a link');
  assert.equal(failed.tone, 'error');
});

test('a coding-agent run is one card named for the agent that ran, and a drafted spec is a card of its own', () => {
  const codex = { agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash' };
  const scout = transcript.buildTranscript([
    row(1, 'assistant', 'I\'ll have the scout draft the spec now.'),
    row(2, 'system', 'Scouting the repo for context (z-ai/glm-5.3-flash)...', codex, 12),
    row(3, 'system', 'Scout reading the codebase...', codex, 12),
    // Every agent writes this row's content as "Claude Code progress"; only
    // its metadata says which one ran, so its words are never shown.
    row(4, 'system', 'Claude Code progress', { progressLog: ['Reading src/feed.js', 'Drafting the spec'], ...codex }, 12),
    row(5, 'system', 'Scout drafted a 93-line spec from the codebase.', {
      specPreview: '## Thumbnails\nShow an image per item.', specLines: 93, specVersion: 2, durationMs: 81000, ...codex,
    }, 12),
    row(6, 'assistant', 'The spec is drafted.'),
  ]);
  assert.deepEqual(scout.map((i) => i.kind), ['mayor', 'run', 'spec', 'mayor'], 'no loose lines');
  const [, run, spec] = scout;
  assert.equal(run.mode, 'scout');
  assert.equal(run.status, 'done');
  assert.equal(run.agent, 'Codex · glm-5.3-flash', 'an OpenRouter change runs Codex, and says so');
  assert.deepEqual(run.log, ['Reading src/feed.js', 'Drafting the spec']);
  assert.equal(transcript.runHeading(run), 'Wrote the spec');
  assert.equal(transcript.durationLabel(run.durationMs), '1m 21s');
  assert.ok(!JSON.stringify(scout).includes('Claude Code progress'));
  assert.deepEqual([spec.changeId, spec.version, spec.lines], [12, 2, 93]);
  assert.equal(spec.preview, '## Thumbnails\nShow an image per item.', 'its lines kept, since it is rendered as markdown');

  const claude = { agentBackend: 'claude_code', agentModel: 'claude-opus-5-5' };
  const build = transcript.buildTranscript([
    row(1, 'system', 'Spinning up coding agent (Opus)...', claude, 12),
    row(2, 'system', 'Claude Code is running...', claude, 12),
    row(3, 'system', 'Claude Code progress', { progressLog: ['Editing feed.js'], ...claude }, 12),
    row(4, 'system', 'PR #9 created', {}, 12),
    row(5, 'system', 'Staging deployed!', { stagingUrl: 'https://pr-9.example.test', prNumber: 9 }, 12),
    row(6, 'system', 'Claude Code finished', { ccOutput: 'Added thumbnails.', ccOutcome: 'success', durationMs: 5000, ...claude }, 12),
  ]);
  assert.deepEqual(build.map((i) => i.kind), ['run', 'preview']);
  assert.equal(build[0].agent, 'Claude Code · Opus 5.5');
  assert.deepEqual(build[0].steps, ['PR #9 created'], 'the run\'s own steps fold into it');
  assert.equal(build[0].status, 'done');
  assert.equal(transcript.runHeading(build[0]), 'Built the change');

  // A run still going is drawn running only while one is live; one that never
  // wrote its end is drawn as ended, never spinning forever.
  const unfinished = [
    row(1, 'system', 'Starting OpenRouter (glm-5.3-flash)...', codex, 12),
    row(2, 'system', 'OpenRouter is running...', codex, 12),
  ];
  assert.equal(transcript.buildTranscript(unfinished, [], Date.now(), { liveRun: true })[0].status, 'running');
  assert.equal(transcript.buildTranscript(unfinished)[0].status, 'ended');

  // A failed run ends there, and its sentence is still said.
  const failedRun = transcript.buildTranscript([
    ...unfinished,
    row(3, 'system', 'This turn failed: the worker went away.', { turnError: true }, 12),
  ]);
  assert.deepEqual(failedRun.map((i) => [i.kind, i.status || i.tone]), [['run', 'failed'], ['note', 'error']]);

  assert.equal(transcript.prettyModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(transcript.agentLabel({ localAgentLabel: 'MacBook' }), 'MacBook · your machine');
  assert.equal(transcript.agentLabel({}), '');
});

test('the screen draws a run as the dev chat\'s run card and a spec as a card that opens the spec over the conversation', async () => {
  const { createElement, renderToHtml } = require('./lib/render-tsx');
  const codex = { agentBackend: 'codex_openrouter', agentModel: 'z-ai/glm-5.3-flash' };
  const session = { id: 7, title: 'Thumbnails', status: 'open', focusApp: null, focusContext: {}, agent: null, activeChange: null, busy: false, lastActivityAt: null, createdAt: null };
  const messages = [
    row(2, 'system', 'Scouting the repo for context (z-ai/glm-5.3-flash)...', codex, 12),
    row(3, 'system', 'Scout reading the codebase...', codex, 12),
    row(4, 'system', 'Claude Code progress', { progressLog: ['Reading src/feed.js'], ...codex }, 12),
    row(5, 'system', 'Scout drafted a 93-line spec from the codebase.', { specPreview: 'Show an image per item.', specLines: 93, specVersion: 2, ...codex }, 12),
  ];
  const requests = [];
  globalThis.window = { location: { hash: '#agent/7' }, App: {}, UsernodeReact: {}, PlatformUI: { toast: () => {} } };
  globalThis.fetch = withStateRead(async (url) => {
    requests.push(url);
    const body = /\/messages\?/.test(url) ? { messages, nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : url === '/api/sessions/12/spec' ? { spec: '# Thumbnails v3', versions: [{ version: 3 }, { version: 2 }] }
          : url === '/api/sessions/12/specs/2' ? { spec: { version: 2, content: '# Thumbnails v2' } }
            : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'screen' });
    // The panel's server render is its empty first paint by design, so the
    // cards are rendered from the items the panel would draw.
    const drawn = api.buildTranscript(api.getAgentSessionState().messages);
    const html = drawn.map((item) => renderToHtml(item.kind === 'run'
      ? createElement(api.RunCard, { run: item })
      : createElement(api.SpecCard, { item }))).join('');
    assert.match(html, /class="dc-cc-attached"/, 'the dev chat\'s own run card');
    assert.match(html, /data-agent-session-run="done"/);
    assert.match(html, /Wrote the spec/);
    assert.match(html, /Codex · glm-5\.3-flash/, 'captioned with the agent that ran');
    assert.doesNotMatch(html, /Claude Code progress|Scout reading the codebase/, 'no loose lines');
    assert.match(html, /class="dc-spec-preview-card"[^>]*data-agent-session-spec="2"/);
    assert.match(html, /Spec v2 · 93 lines/);

    // The card opens the version it names, over the conversation.
    await api.openSpec(12, 2);
    const sheet = api.getAgentSessionState().specSheet;
    assert.deepEqual([sheet.changeId, sheet.version, sheet.versions, sheet.text, sheet.phase], [12, 2, [3, 2], '# Thumbnails v2', 'ready']);
    assert.ok(requests.includes('/api/sessions/12/specs/2'), 'an older version is read by its number');
    await api.openSpec(12);
    assert.equal(api.getAgentSessionState().specSheet.text, '# Thumbnails v3', 'the latest by default');
    api.closeSpec();
    assert.equal(api.getAgentSessionState().specSheet, null);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('reply suggestions belong to the last thing said, and only while it is last', () => {
  const said = transcript.buildTranscript([row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] })]);
  assert.deepEqual(transcript.latestReplies(said), ['Notes', 'Recipes']);
  const answered = transcript.buildTranscript([
    row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] }),
    row(2, 'user', 'Notes'),
  ]);
  assert.deepEqual(transcript.latestReplies(answered), []);
});

test('the header pill and the live line say where things stand in words', () => {
  assert.equal(transcript.changeStatusLabel('active'), 'In progress');
  assert.equal(transcript.changeStatusLabel('paused'), 'In progress', 'paused is bookkeeping, never shown');
  assert.equal(transcript.changeStatusLabel('promoted'), 'Waiting for approval');
  assert.equal(transcript.changeStatusLabel(null), 'No active change');
  assert.equal(transcript.changeStatusLabel('active', true), 'Building');
  assert.equal(transcript.toolActivity('dispatch_coding_agent'), 'The coding agent is building');
  // A write tool the list does not name is one that ends in a card.
  assert.equal(transcript.toolActivity('start_change'), 'Preparing a confirmation');
});

test('an agent session is an agent conversation in the inbox: under Agents on the one clock, never under People', () => {
  const base = {
    conversations: [{ id: 1, lastActivityAt: '2026-09-01T10:00:00Z' }],
    discussions: [],
    agents: [],
    sessions: [{ key: 's1', lastActivityAt: '2026-09-01T09:00:00Z' }],
    mayors: [{ id: 7, lastActivityAt: '2026-09-01T11:00:00Z' }, { id: 8, lastActivityAt: null }],
  };
  const all = inbox.buildInbox({ ...base, filter: 'all' });
  assert.deepEqual(all.map((e) => e.key), ['mayor:7', 'person:1', 'session:s1', 'mayor:8']);
  assert.ok(all.filter((e) => e.kind === 'mayor').every((e) => e.section === 'chats'));
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'agents' }).map((e) => e.key), ['mayor:7', 'session:s1', 'mayor:8']);
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'people' }).map((e) => e.key), ['person:1']);
  assert.equal(inbox.admits('channels', 'mayor'), false);
});

test('the screen is reachable by address, on a phone and in the desktop Messages pane', () => {
  const app = read('public/js/app.js');
  const messages = read('frontend/src/features/messages/store.ts');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="AgentSessionScreen"/);
  assert.match(app, /'agent-session-screen'/);
  assert.match(app, /navigateToAgentSession\(/);
  assert.match(messages, /kind === 'agent'/);
  // The address the store hands out is the Messages one; app.js swaps it
  // for the full screen on a phone.
  assert.match(read('frontend/src/features/agent-session/store.ts'), /#messages\/agent\/\$\{id\}/);
});

test('New change opens an UNSENT conversation: nothing is created, in the side panel beside a running app or by address elsewhere', async () => {
  // The panel's own rules (an app on its App tab, a desktop-width window, the
  // top document) are tests/side-panel.test.js's; here the store only has to
  // ASK it first, with the hint riding along, and navigate as it always has
  // when it declines.
  const taken = [];
  let accept = true;
  const win = {
    location: { hash: '' },
    UsernodeReact: { sidePanel: { take: (route, hint) => { taken.push([route, hint]); return accept; } } },
    App: {},
    PlatformUI: { toast: () => {} },
  };
  const requests = [];
  globalThis.window = win;
  globalThis.fetch = withStateRead(async (url, init) => {
    requests.push([url, init && init.method]);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.startAgentSession({ slug: 'notes-ab12', entry: 'improve' });
    assert.deepEqual(requests, [], 'opening New change writes nothing');
    assert.deepEqual(taken, [['messages/agent/new', { agentHint: { slug: 'notes-ab12', entry: 'improve' } }]],
      'the panel is asked first, and the hint rides into its document');
    assert.equal(win.location.hash, '', 'and the top window stays on the running app');

    accept = false;
    store.startAgentSession({ slug: 'notes-ab12', entry: 'improve' });
    assert.equal(win.location.hash, '#messages/agent/new', 'declined: the unsent address is followed as before');
    assert.deepEqual(requests, []);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('the first message creates the session with the hint and the model picked meanwhile, then takes its address in place', async () => {
  const replaced = [];
  let restored = 0;
  const win = {
    location: { hash: '#agent/new' },
    history: { state: null, replaceState: (_state, _unused, url) => { replaced.push(url); win.location.hash = url; } },
    App: { restoreFromHash: () => { restored += 1; }, setHeaderTitle: () => {} },
    UsernodeReact: {},
    PlatformUI: { toast: () => {} },
  };
  const session = {
    id: 7, title: null, status: 'open', focusApp: { id: 3, slug: 'notes-ab12', name: 'Notes' }, focusContext: { entry: 'improve' },
    agent: { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null },
    activeChange: null, busy: false, lastActivityAt: null, createdAt: null,
  };
  const requests = [];
  globalThis.window = win;
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    requests.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    const body = url.startsWith('/api/agent-sessions/draft')
      ? { draft: { focusApp: session.focusApp, focusContext: { entry: 'improve' } } }
      : url === '/api/agent-sessions' ? { session }
        : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
          : /\/actions$/.test(url) ? { actions: [] }
            : { session, turn: null };
    return { ok: true, status: 200, body: null, json: async () => body };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.prepareAgentDraft({ slug: 'notes-ab12', entry: 'improve' });
    await store.openAgentSession({ id: 'new', host: 'screen' });
    await new Promise((resolve) => setImmediate(resolve));
    let state = store.getAgentSessionState();
    assert.equal(state.id, null);
    assert.deepEqual(state.draft.focusApp, session.focusApp, 'what it is about is previewed, not saved');
    assert.deepEqual(requests.map(([url, method]) => [url, method]), [['/api/agent-sessions/draft?slug=notes-ab12&entry=improve', 'GET']]);
    assert.equal(store.agentSessionController.currentId(), 'new');

    await store.chooseAgent({ backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null });
    assert.equal(requests.length, 1, 'a pick on an unsent conversation is held, not sent');

    await store.sendAgentMessage('Add dark mode');
    const create = requests.find(([url, method]) => url === '/api/agent-sessions' && method === 'POST');
    assert.deepEqual(create[2], {
      hint: { slug: 'notes-ab12', entry: 'improve' },
      agent: { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null },
    });
    const turn = requests.findIndex(([url]) => url === '/api/agent-sessions/7/turns');
    assert.ok(turn > requests.indexOf(create), 'created first, then the message is posted to it');
    assert.equal(requests[turn][2].message, 'Add dark mode');
    assert.match(requests[turn][2].clientMessageId, /^c[0-9a-z]{8,63}$/,
      'with the screen\'s own id for it, so a retried send is recognised, not answered twice');
    assert.deepEqual(Object.keys(requests[turn][2]).sort(), ['clientMessageId', 'message']);
    assert.deepEqual(replaced, ['#agent/7'], 'the unsent address becomes the session\'s own, in place');
    assert.equal(restored, 1, 'and the router hears it');
    state = store.getAgentSessionState();
    assert.equal(state.id, 7);
    assert.equal(state.draft, null);
    assert.equal(store.agentSessionController.currentId(), 7);

    // Routed again by that address, the store keeps what it has: the same
    // conversation, not a reload that would drop a turn in flight. It only
    // reads what it may have missed.
    const before = requests.length;
    const kept = store.getAgentSessionState();
    await store.openAgentSession({ id: 7, host: 'screen' });
    assert.ok(requests.slice(before).every(([, method]) => (method || 'GET') === 'GET'), 'reads, and nothing sent again');
    assert.equal(store.getAgentSessionState().id, 7);
    assert.equal(store.getAgentSessionState().messages, kept.messages, 'nothing it held was dropped for the read');

    // New change again from here starts a fresh unsent conversation, even
    // where the address it goes to does not change.
    win.location.hash = '#messages/agent/new';
    await store.openAgentSession({ id: 'new', host: 'messages' });
    store.startAgentSession({ slug: 'recipes-cd34', entry: 'messages' });
    assert.deepEqual(store.getAgentSessionState().draft.hint, { slug: 'recipes-cd34', entry: 'messages' });
    await store.openAgentSession({ id: 7, host: 'screen' });

    // On a session, a pick is saved at once and applies from the next turn.
    await store.chooseAgent({ backend: 'claude_code', model: 'claude-sonnet-5-5', reasoningEffort: null });
    const patch = requests.find(([url, method]) => url === '/api/agent-sessions/7/agent' && method === 'PATCH');
    assert.deepEqual(patch[2], { backend: 'claude_code', model: 'claude-sonnet-5-5', reasoningEffort: null });
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

// Start work on a request card used to open a conversation that said nothing
// about the request, with an empty box. The card's hint now carries the
// title; the screen names the request and offers its first message, and the
// server is sent exactly the hint it resolves, no title.
test('a conversation started from a request names it and offers its first message', () => {
  const seed = loadTsx('frontend/src/features/agent-session/request-seed.ts');
  assert.deepEqual(
    seed.draftRequest({ slug: 'notes-ab12', issueNumber: 12, entry: 'issue', issueTitle: '  Dark\n mode   toggle ' }),
    { number: 12, title: 'Dark mode toggle' },
  );
  assert.equal(
    seed.requestSeed({ slug: 'notes-ab12', issueNumber: 12, issueTitle: 'Dark mode toggle' }),
    'Work on request #12: "Dark mode toggle"',
  );
  // The number alone still names it, when the board had not loaded the title.
  assert.deepEqual(seed.draftRequest({ slug: 'notes-ab12', issueNumber: 12 }), { number: 12, title: null });
  assert.equal(seed.requestSeed({ slug: 'notes-ab12', issueNumber: 12, issueTitle: '   ' }), 'Work on request #12');
  // A title is one line of a message, not the whole box.
  const long = seed.draftRequest({ issueNumber: 3, issueTitle: 'x'.repeat(500) }).title;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  // Anything else starts blank, as New change always has.
  for (const hint of [null, undefined, {}, { slug: 'notes-ab12', entry: 'improve' }, { issueNumber: 0 }, { issueNumber: 'x' }, { proposalId: 4, slug: 'a' }]) {
    assert.equal(seed.draftRequest(hint), null);
    assert.equal(seed.requestSeed(hint), '');
  }

  const api = loadTsx('frontend/src/features/agent-session/api.ts');
  assert.deepEqual(
    api.serverHint({ slug: 'notes-ab12', issueNumber: 12, entry: 'issue', issueTitle: 'Dark mode toggle' }),
    { slug: 'notes-ab12', issueNumber: 12, entry: 'issue' },
    'the title is the screen\'s: the server takes only what it resolves',
  );
  assert.equal(api.serverHint(null), null);

  const screen = read('frontend/src/features/agent-session/index.tsx');
  assert.match(screen, /data-agent-session-request=\{request\.number\}/, 'the unsent conversation says which request it is for');
  assert.match(screen, /setValue\(saved \|\| seed\)/, 'the box offers the seed only when nothing was typed');
  assert.match(screen, /if \(request\) return \[\];/, 'no starter pill replaces the request\'s first message');
});

test('Start work: the title never reaches the server, and the box drops what an earlier unsent conversation left', async () => {
  const stored = new Map([['usernode:agent-session-unsent:new', 'left over from another New change']]);
  const win = {
    location: { hash: '#messages/agent/new' },
    history: { state: null, replaceState: (_state, _unused, url) => { win.location.hash = url; } },
    App: { restoreFromHash: () => {}, setHeaderTitle: () => {} },
    UsernodeReact: {},
    PlatformUI: { toast: () => {} },
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)); },
      removeItem: (key) => { stored.delete(key); },
    },
  };
  const focusApp = { id: 3, slug: 'notes-ab12', name: 'Notes' };
  const session = {
    id: 9, title: null, status: 'open', focusApp, focusContext: { entry: 'issue', issueNumber: 12 },
    agent: null, activeChange: null, busy: false, lastActivityAt: null, createdAt: null,
  };
  const requests = [];
  globalThis.window = win;
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    requests.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    const body = url.startsWith('/api/agent-sessions/draft')
      ? { draft: { focusApp, focusContext: { entry: 'issue', issueNumber: 12 } } }
      : url === '/api/agent-sessions' ? { session }
        : /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
          : /\/actions$/.test(url) ? { actions: [] }
            : { session, turn: null };
    return { ok: true, status: 200, body: null, json: async () => body };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    const hint = { slug: 'notes-ab12', issueNumber: 12, entry: 'issue', issueTitle: 'Dark mode toggle' };
    store.prepareAgentDraft(hint);
    await store.openAgentSession({ id: 'new', host: 'messages' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stored.has('usernode:agent-session-unsent:new'), false, 'the request\'s first message wins over stale unsent text');
    const state = store.getAgentSessionState();
    assert.equal(state.draft.hint.issueTitle, 'Dark mode toggle', 'the screen keeps the title to name the request');
    assert.deepEqual(state.draft.focusApp, focusApp);
    assert.deepEqual(requests.map(([url]) => url), ['/api/agent-sessions/draft?slug=notes-ab12&issueNumber=12&entry=issue']);

    await store.sendAgentMessage('Work on request #12: "Dark mode toggle"');
    const create = requests.find(([url, method]) => url === '/api/agent-sessions' && method === 'POST');
    assert.deepEqual(create[2], { hint: { slug: 'notes-ab12', issueNumber: 12, entry: 'issue' } },
      'created with the request in its focus, so the Mayor reads, links and claims it');

    // A plain New change afterwards leaves unsent text alone.
    stored.set('usernode:agent-session-unsent:new', 'typed in a plain New change');
    store.startAgentSession({ entry: 'messages' });
    await store.openAgentSession({ id: 'new', host: 'messages' });
    assert.equal(stored.get('usernode:agent-session-unsent:new'), 'typed in a plain New change');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('an unsent conversation routed twice still takes its preview (the phone showed "Any app")', async () => {
  // A phone routes Start work to Messages and then to the full screen. The
  // second pass keeps the draft; it used to claim the load too, so the
  // preview the first pass asked for was dropped and the bar said "Any app".
  const focusApp = { id: 3, slug: 'notes-ab12', name: 'Notes' };
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  globalThis.window = { location: { hash: '#messages/agent/new' }, App: { setHeaderTitle: () => {} }, UsernodeReact: {}, PlatformUI: { toast: () => {} } };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url) => {
    if (url.startsWith('/api/agent-sessions/draft')) {
      await pending;
      return { ok: true, status: 200, json: async () => ({ draft: { focusApp, focusContext: { entry: 'issue', issueNumber: 12 } } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    store.prepareAgentDraft({ slug: 'notes-ab12', issueNumber: 12, entry: 'issue', issueTitle: 'Dark mode toggle' });
    await store.openAgentSession({ id: 'new', host: 'messages' });
    const draft = store.getAgentSessionState().draft;
    await store.openAgentSession({ id: 'new', host: 'screen' });
    assert.equal(store.getAgentSessionState().draft, draft, 'the same draft, kept');
    assert.equal(store.getAgentSessionState().host, 'screen');
    answer();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.getAgentSessionState().draft.focusApp, focusApp, 'the preview lands after the second pass');
    assert.equal(store.getAgentSessionState().draft.hint.issueTitle, 'Dark mode toggle');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('a message the server refuses stays in the conversation as Not sent, with the reason, instead of vanishing', async () => {
  const session = { id: 7, title: null, status: 'open', focusApp: null, focusContext: {}, agent: null, activeChange: null, busy: false, lastActivityAt: null, createdAt: null };
  globalThis.window = { location: { hash: '#agent/7' }, App: {}, UsernodeReact: {}, PlatformUI: { toast: () => {} } };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url) => {
    if (/\/turns$/.test(url)) return { ok: false, status: 503, json: async () => ({ error: 'LLM not configured' }) };
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null } : /\/actions$/.test(url) ? { actions: [] } : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    await store.openAgentSession({ id: 7, host: 'screen' });
    await store.sendAgentMessage('Add dark mode');
    const state = store.getAgentSessionState();
    // Said once, under the message it is about, not as a red line of its own.
    assert.equal(state.error, '');
    assert.deepEqual(state.outbox.map((item) => [item.shown, item.status, item.error]), [['Add dark mode', 'failed', 'LLM not configured']]);
    assert.equal(state.returnedText, null, 'nothing is put back in the box behind the user\'s back');
    assert.equal(state.turn.running, false);
    // Edit puts it back to reword; the row goes.
    const clientId = state.outbox[0].clientId;
    assert.equal(store.editOutbox(clientId), 'Add dark mode');
    assert.deepEqual(store.getAgentSessionState().outbox, []);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the picker offers the platform\'s models, keeps the conversation\'s own, and carries reasoning only where offered', () => {
  const choice = loadTsx('frontend/src/features/agent-session/model-choice.ts');
  const catalog = {
    anthropic: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }],
    anthropicDefault: 'claude-opus-5-5',
    defaultBackend: 'claude_code',
    savedOpenRouter: { model: 'moonshot/kimi-k3', reasoningEffort: 'low' },
    defaultReasoningEffort: 'medium',
    codexAvailable: true,
    openrouter: [
      { id: 'z-ai/glm-5', name: 'GLM 5', isRecommended: true, supportsReasoning: true },
      { id: 'moonshot/kimi-k3', name: 'Kimi K3', supportsReasoning: true },
      { id: 'plain/model', name: 'Plain', supportsReasoning: false, isFavorite: true },
      { id: 'other/model', name: 'Other' },
    ],
    recommendedOpenRouterId: 'z-ai/glm-5',
  };
  assert.deepEqual(choice.pickerOptions(catalog, null).map((o) => o.value), [
    'openrouter:z-ai/glm-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5',
    'openrouter:moonshot/kimi-k3', 'openrouter:plain/model',
  ], 'recommended first, then Claude, then what this account uses; not the whole catalog');
  assert.ok(choice.pickerOptions(catalog, { backend: 'codex_openrouter', model: 'gone/model', reasoningEffort: null })
    .some((o) => o.value === 'openrouter:gone/model'), 'the conversation\'s own model is always an option');
  assert.deepEqual(choice.pickerOptions({ ...catalog, codexAvailable: false }, null).map((o) => o.value),
    ['anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5'], 'no OpenRouter where it is not offered');

  // No choice of its own: the default, as the server resolves it.
  assert.deepEqual(choice.effectiveChoice(null, catalog), { backend: 'claude_code', model: 'claude-opus-5-5', reasoningEffort: null });
  assert.deepEqual(choice.effectiveChoice(null, { ...catalog, defaultBackend: 'codex_openrouter' }),
    { backend: 'codex_openrouter', model: 'moonshot/kimi-k3', reasoningEffort: 'low' });
  assert.deepEqual(choice.effectiveChoice({ backend: 'claude_code', model: null, reasoningEffort: null }, catalog).model, 'claude-opus-5-5');

  const onKimi = { backend: 'codex_openrouter', model: 'moonshot/kimi-k3', reasoningEffort: 'high' };
  assert.deepEqual(choice.choiceFromValue('openrouter:z-ai/glm-5', catalog, onKimi),
    { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' }, 'the effort carries to a model that offers one');
  assert.deepEqual(choice.choiceFromValue('openrouter:plain/model', catalog, onKimi),
    { backend: 'codex_openrouter', model: 'plain/model', reasoningEffort: null }, 'and is dropped where it is not');
  assert.deepEqual(choice.choiceFromValue('anthropic:claude-sonnet-5-5', catalog, onKimi),
    { backend: 'claude_code', model: 'claude-sonnet-5-5', reasoningEffort: null });
  assert.equal(choice.choiceFromValue('bogus', catalog, null), null);
  assert.equal(choice.offersReasoning(onKimi, catalog), true);
  assert.equal(choice.offersReasoning({ backend: 'claude_code', model: 'claude-sonnet-5-5', reasoningEffort: null }, catalog), false);
  assert.deepEqual(choice.effortOptions(catalog).map((o) => [o.value, o.label, !!o.isDefault]), [
    ['minimal', 'Minimal', false], ['low', 'Low', false], ['', 'Medium', true], ['high', 'High', false], ['xhigh', 'Extra high', false],
  ], 'the server\'s own effort list; the default effort IS the follow-the-default option, not a second entry');
  assert.deepEqual(choice.effortOptions({ ...catalog, defaultReasoningEffort: null }).map((o) => [o.value, o.label, !!o.isDefault])[0],
    ['', 'Default', true], 'with no default known, a plain Default');
  assert.equal(choice.effortValue({ ...onKimi, reasoningEffort: 'medium' }, catalog), '', 'naming the default is following it');
  assert.equal(choice.effortValue(onKimi, catalog), 'high');
  assert.equal(choice.effortValue({ ...onKimi, reasoningEffort: null }, catalog), '');
  // #3079: the closed pill names the thinking level; nothing where none applies.
  assert.equal(choice.effortLabel(onKimi, catalog), 'High');
  assert.equal(choice.effortLabel({ ...onKimi, reasoningEffort: null }, catalog), 'Medium', 'following the default names it');
  assert.equal(choice.effortLabel({ ...onKimi, reasoningEffort: null }, { ...catalog, defaultReasoningEffort: null }), '', 'no level known, no placeholder');
  assert.equal(choice.effortLabel({ backend: 'claude_code', model: 'claude-sonnet-5-5', reasoningEffort: null }, catalog), '', 'a model without thinking levels');
  assert.equal(choice.effortLabel({ backend: 'codex_openrouter', model: 'plain/model', reasoningEffort: 'high' }, catalog), '', 'nor one that does not reason');
  assert.deepEqual(choice.pickerOptions(catalog, null).filter((o) => o.isDefault).map((o) => o.value), ['anthropic:claude-opus-5-5'],
    'the model a conversation with no choice runs on is the one marked default');
});

test('the model pill names the model; the sheet lists the models, marks the default, and ticks the one in use', () => {
  const { createElement, renderToHtml } = require('./lib/render-tsx');
  const parts = loadTsx('frontend/src/features/agent-session/composer-parts.tsx');
  const pill = renderToHtml(createElement(parts.ModelPill, { label: 'Opus 5.5', disabled: false, open: false, onOpen() {}, pillRef: { current: null } }));
  assert.match(pill, /aria-label="Model: Opus 5\.5"/, 'a screen reader hears what the pill is for');
  assert.match(pill, /aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.match(pill, /<span class="truncate">Opus 5\.5<\/span>/, 'closed: the model alone, no "(default)"');

  const options = [
    { value: 'anthropic:claude-sonnet-5-5', label: 'Sonnet 5.5', detail: 'about $6.20 for a typical change' },
    { value: 'anthropic:claude-opus-5-5', label: 'Opus 5.5', isDefault: true },
    { value: 'openrouter:z-ai/glm-5', label: 'GLM 5' },
  ];
  const list = parts.modelList(options);
  assert.deepEqual(list.map((o) => o.label), ['Sonnet 5.5', 'Opus 5.5', 'GLM 5'], 'Claude, then OpenRouter, in one list');
  const body = renderToHtml(createElement(parts.ModelSheetBody, {
    options: list, value: 'anthropic:claude-sonnet-5-5', onPick() {}, credit: null,
    effort: { value: 'high', options: [{ value: 'high', label: 'High', isDefault: true }, { value: 'xhigh', label: 'Extra high' }], onPick() {} },
  }));
  assert.match(body, /data-agent-session-model-option="anthropic:claude-sonnet-5-5"[^>]*>[\s\S]*?Sonnet 5\.5[\s\S]*?about \$6\.20 for a typical change/);
  assert.match(body, /aria-pressed="true"[^>]*data-agent-session-model-option="anthropic:claude-sonnet-5-5"/, 'the model in use is ticked');
  assert.equal((body.match(/aria-pressed="true"/g) || []).length, 1, 'and only it');
  assert.match(body, /Opus 5\.5<span[^>]*>default<\/span>/, 'open: "default" after the default');
  assert.match(body, /data-agent-session-effort[^>]*>[\s\S]*?Thinking level[\s\S]*?High</, 'the thinking level is one row, closed');
  assert.doesNotMatch(body, /Extra high/, 'its choices open under it on a tap');
  assert.doesNotMatch(body, /data-agent-session-sheet-credits/, 'no allowance, no credits card');

  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /value: effortValue\(current, catalog\)/);
  assert.doesNotMatch(panel, /next message<\/span>|data-agent-session-model-note|`Thinking: /, 'no "applies from your next message", no "Thinking:"');
});

test('the unsent address is routed on every surface', () => {
  const app = read('public/js/app.js');
  assert.match(app, /if \(id === 'new'\) return \{ kind: 'agent', id: 'new' \};/, '#messages/agent/new is an agent session, not a chat');
  assert.match(app, /if \(parts\[1\] === 'new'\) \{\s*App\.navigateToAgentSession\('new'\);/);
  const messages = loadTsx('frontend/src/features/messages/store.ts');
  assert.deepEqual(messages.validAgentThread({ kind: 'agent', id: 'new' }), { kind: 'agent', id: 'new' });
  assert.equal(messages.fullScreenAddress({ kind: 'agent', id: 'new' }), '#agent/new');
  // Leaving the pane deactivates only the conversation it still shows: the
  // unsent one becomes its session under the pane, and is not torn down.
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /const same = id === 'new' \? current\.id === null : current\.id === id;/);
});

test('"Open app" targets the conversation\u2019s app, hides for self-hosted and no-app, and docks the chat beside it', async () => {
  const { createElement, renderToHtml } = require('./lib/render-tsx');
  const { OpenAppButton, openAppTarget } = loadTsx('frontend/src/features/agent-session/index.tsx');

  // Target resolution: active change first, then the focus app.
  assert.deepEqual(
    openAppTarget({ appSlug: 'notes-ab12', appName: 'Notes', appSelfHosted: false }, null),
    { slug: 'notes-ab12', name: 'Notes' },
  );
  assert.deepEqual(
    openAppTarget(null, {
      focusApp: { id: 3, slug: 'recipes-cd34', name: 'Recipes', selfHosted: false, iconUrl: null, iconEmoji: null },
      focusContext: {},
    }),
    { slug: 'recipes-cd34', name: 'Recipes' },
  );
  // Homeroom itself: nothing to open. No app at all: same.
  assert.equal(openAppTarget({ appSlug: 'usernode-2d5619', appSelfHosted: true }, null), null);
  assert.equal(
    openAppTarget(null, {
      focusApp: { id: 4, slug: 'platform', name: 'Platform', selfHosted: true, iconUrl: null, iconEmoji: null },
      focusContext: {},
    }),
    null,
  );
  assert.equal(openAppTarget(null, null), null);

  // The button carries the tile mark, the words, and the hidden lg:inline-flex
  // width gate (the same breakpoint the side panel appears at).
  const html = renderToHtml(createElement(OpenAppButton, {
    target: { slug: 'notes-ab12', name: 'Notes' },
  }));
  assert.match(html, /data-agent-session-open-app/);
  assert.match(html, /data-open-app="notes-ab12"/);
  assert.match(html, /hidden lg:inline-flex/);
  assert.match(html, /Open app/);
  assert.match(html, /app-icon-tile|svg/, 'the tile mark rides with it');
  assert.equal(renderToHtml(createElement(OpenAppButton, { target: null })), '',
    'no app, no button');

  // The click sequence: pend the panel page, then openAppTab. In the panel's
  // own document it forwards the App tab and never touches the address.
  const pendCalls = [];
  const openTabCalls = [];
  const forwardCalls = [];
  const hashSets = [];
  globalThis.window = {
    location: { hash: '#agent/7' },
    UsernodeReact: {
      agentSession: { currentId: () => 7 },
      sidePanel: { pend: (route) => { pendCalls.push(route); return true; } },
      sidePanelEmbed: { openApp: (slug) => { forwardCalls.push(slug); } },
    },
    App: { openAppTab: (slug, tab) => { openTabCalls.push([slug, tab]); } },
  };
  try {
    const openApp = loadTsx('frontend/src/features/agent-session/open-app.ts');
    await openApp.openFocusedApp({ slug: 'notes-ab12', name: 'Notes' });
    assert.deepEqual(pendCalls, ['agent/7'], 'the panel page is planted first');
    assert.deepEqual(openTabCalls, [['notes-ab12', 'app']], 'then the app opens, its App tab');
    assert.deepEqual(forwardCalls, [], 'the top document does not forward');

    globalThis.document = {
      documentElement: { classList: { contains: (c) => c === 'in-side-panel' } },
    };
    try {
      await openApp.openFocusedApp({ slug: 'other-app' });
      assert.deepEqual(forwardCalls, ['other-app'], 'docked: the App tab is forwarded up');
      assert.deepEqual(openTabCalls, [['notes-ab12', 'app']], 'the frame never opens an app itself');
      assert.deepEqual(pendCalls, ['agent/7'], 'and never writes the top address');
    } finally {
      delete globalThis.document;
    }
  } finally {
    delete globalThis.window;
  }
});

test('QA Q23: opened twice by a cold deep link, a missing session still says it is missing', async () => {
  // `#agent/<id>` opens the session from the screen's own effect AND from
  // app.js's router. The second call used to take a new load version and
  // return, so the first call's 404 belonged to nobody: the full screen stayed
  // blank while the Messages pane, opened once, said "Agent session not found".
  globalThis.window = { location: { hash: '#agent/404' }, App: {}, UsernodeReact: {}, PlatformUI: { toast: () => {} } };
  globalThis.EventSource = class { close() {} };
  const requests = [];
  globalThis.fetch = withStateRead(async (url) => {
    requests.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: false, status: 404, json: async () => ({ error: 'Agent session not found' }) };
  });
  try {
    const store = loadTsx('frontend/src/features/agent-session/store.ts');
    const first = store.openAgentSession({ id: 404, host: 'screen' });
    const second = store.openAgentSession({ id: 404, host: 'screen', drawer: true });
    await Promise.all([first, second]);
    const state = store.getAgentSessionState();
    assert.equal(state.phase, 'error');
    assert.equal(state.error, 'Agent session not found');
    assert.equal(state.drawerOpen, true, 'the second call still carries what it asked for');
    assert.equal(requests.filter((url) => url === '/api/agent-sessions/404').length, 1,
      'and it is loaded once, not twice');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});
