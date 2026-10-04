// Tests for the read-only transcript renderer
// (public/js/session-transcript.js).
//
// session-transcript.js is a plain browser script (`window.SessionTranscript
// = {...}`); we load it into a vm context, stub the few globals it reaches,
// and assert on the returned HTML strings — same harness as
// tests/session-card-layout.test.js.
//
// The assertions that matter are the negative ones. This renderer's whole
// job is to show a conversation you cannot participate in, so the tests pin:
// no composer/form/send control anywhere, agent logs closed by default,
// attachment chips that are not links, and nothing rendered from metadata
// the server-side sanitiser would have stripped.
//
// Run with: node --test tests/session-transcript-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'session-transcript.js'),
  'utf8'
);

// Load the module fresh. `withDevChat: false` models the markdown fallback
// path (dev-chat.js absent / failed to load).
function load({ withDevChat = true } = {}) {
  const sandbox = { console };
  sandbox.window = sandbox;
  if (withDevChat) {
    // The real DevChat.renderMarkdown wraps content in markup; a marker
    // wrapper is enough to prove delegation happened.
    sandbox.DevChat = { renderMarkdown: (t) => `<md>${t}</md>` };
  }
  sandbox.relTime = () => '5 minutes ago';
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.SessionTranscript;
}

function payload(messages, sessionOver = {}) {
  return {
    session: {
      id: 5, username: 'alice', message_count: messages.length,
      status: 'paused', is_owner: false, can_fork: true, ...sessionOver,
    },
    messages,
    truncated: false,
  };
}

test('renders user and assistant turns with the owner name', () => {
  const ST = load();
  const html = ST.renderHtml(payload([
    { id: 1, role: 'user', content: 'Fix the cards', created_at: 'x', metadata: {} },
    { id: 2, role: 'assistant', content: 'On it.', created_at: 'x', metadata: {} },
  ]));
  assert.match(html, /dc-msg-user/);
  assert.match(html, /dc-msg-assistant/);
  assert.match(html, /alice/);
  assert.match(html, /<md>Fix the cards<\/md>/);
  assert.match(html, /<md>On it\.<\/md>/);
});

test('NO composer: nothing to type into, nothing to submit', () => {
  const ST = load();
  const html = ST.renderHtml(payload([
    { id: 1, role: 'user', content: 'hello', created_at: 'x', metadata: {} },
    { id: 2, role: 'assistant', content: 'hi', created_at: 'x', metadata: {} },
  ]));
  assert.doesNotMatch(html, /<textarea/i);
  assert.doesNotMatch(html, /<form/i);
  assert.doesNotMatch(html, /<input/i);
  assert.doesNotMatch(html, /type="submit"/i);
  assert.doesNotMatch(html, />\s*Send\s*</i);
  // No owner action buttons either (Report to platform / Dismiss / Propose).
  assert.doesNotMatch(html, /dc-pr-btn/);
  assert.doesNotMatch(html, /Report to platform/);
});

test('agent activity renders inside a <details> that is CLOSED by default', () => {
  const ST = load();
  const html = ST.renderHtml(payload([{
    id: 1, role: 'system', content: 'Claude Code is running', created_at: 'x',
    metadata: { progressLog: ['Reading a.js', 'Editing b.js'], ccOutput: 'Did the thing.' },
  }]));
  assert.match(html, /<details class="dc-cc-attached st-agent-details">/);
  // A reader is skimming a finished chat, not watching a live run — so the
  // long log must not be expanded. `open` would appear inside the tag.
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.match(html, /Reading a\.js/);
  assert.match(html, /Did the thing\./);
  assert.match(html, /2 steps/);
});

test('a row whose only metadata was stripped renders just its status line', () => {
  // What a ccLog row looks like after the sanitiser: content survives,
  // metadata is empty. No disclosure should be invented for it.
  const ST = load();
  const html = ST.renderHtml(payload([{
    id: 1, role: 'system', content: 'Claude Code log', created_at: 'x', metadata: {},
  }]));
  assert.match(html, /dc-status-line/);
  assert.match(html, /Claude Code log/);
  assert.doesNotMatch(html, /<details/);
});

test('nothing renders from metadata the sanitiser strips, even if it leaks through', () => {
  // Defence in depth: if a raw row ever reached this renderer (a caller
  // bypassing the route), it still must not paint ccLog or an action card.
  const ST = load();
  const html = ST.renderHtml(payload([{
    id: 1, role: 'system', content: 'Claude Code log', created_at: 'x',
    metadata: {
      ccLog: 'SECRET stderr',
      platformIssueDraft: { body: 'draft body', status: 'pending', msgId: 3 },
    },
  }]));
  assert.ok(!html.includes('SECRET stderr'), 'ccLog is never rendered');
  assert.ok(!html.includes('draft body'), 'platformIssueDraft is never rendered');
  assert.doesNotMatch(html, /data-platform-issue-msg/);
});

test('attachment chips are inert: names only, no href, no <img>', () => {
  const ST = load();
  const html = ST.renderHtml(payload([{
    id: 1, role: 'user', content: 'see this', created_at: 'x',
    metadata: { attachments: [{ filename: 'mockup.png', kind: 'image', sizeBytes: 4096 }] },
  }]));
  assert.match(html, /mockup\.png/);
  assert.match(html, /st-att-chip/);
  // The sanitiser strips attachment ids, so there is no URL to build — a
  // link shape would promise a download that 404s.
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /\/attachments\//);
  assert.match(html, /4 KB/);
});

test('spec previews render as static text with no "View full spec" link', () => {
  const ST = load();
  const html = ST.renderHtml(payload([{
    id: 1, role: 'system', content: 'Spec drafted', created_at: 'x',
    metadata: { specPreview: '# Spec\n\n- item', specVersion: 2, specLines: 3 },
  }]));
  assert.match(html, /Spec v2/);
  assert.match(html, /3 lines/);
  assert.match(html, /<md># Spec/);
  // A reader isn't authorised on GET /specs/:version unless it was
  // separately group-shared, so no affordance is offered.
  assert.doesNotMatch(html, /View full spec/);
  assert.doesNotMatch(html, /data-spec-version/);
});

test('escapes hostile content in status lines, names and filenames', () => {
  const ST = load();
  const html = ST.renderHtml(payload([
    {
      id: 1, role: 'system', content: '<img src=x onerror=alert(1)>', created_at: 'x',
      metadata: { progressLog: ['<script>bad()</script>'] },
    },
    {
      id: 2, role: 'user', content: 'hi', created_at: 'x',
      metadata: { attachments: [{ filename: '"><script>x</script>', kind: 'text', sizeBytes: 1 }] },
    },
  ], { username: '<b>alice</b>' }));
  // Assert on TAG openings, not on substrings like "onerror=" — that text
  // appears harmlessly inside `&lt;img src=x onerror=alert(1)&gt;`, which is
  // exactly the escaped (inert) form we want.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'status text is escaped, not stripped');
  assert.match(html, /&lt;script&gt;bad\(\)/, 'progress lines are escaped');
  assert.match(html, /&lt;b&gt;alice/, 'the owner name is escaped');
  // The filename lands in an attribute too, so quotes must be escaped there.
  assert.match(html, /title="&quot;&gt;&lt;script&gt;/);
});

test('empty and truncated states read clearly', () => {
  const ST = load();
  assert.match(ST.renderHtml(payload([])), /no messages yet/i);
  const long = { ...payload([{ id: 1, role: 'user', content: 'a', created_at: 'x', metadata: {} }]), truncated: true };
  assert.match(ST.renderHtml(long), /most recent part/i);
});

test('headerText labels both the collapsed and expanded states', () => {
  const ST = load();
  const s = { username: 'alice', message_count: 24 };
  assert.strictEqual(ST.headerText(s, { expanded: false }), 'Read the agent session (24 messages)');
  assert.strictEqual(ST.headerText(s, { expanded: true }), 'Agent session by alice · 24 messages');
  // NOT "· read-only": the toggle renders a `.st-readonly-tag` chip saying so
  // immediately after this line, and carrying it in both places printed
  // "read-only read-only" on every opened transcript.
  assert.doesNotMatch(ST.headerText(s, { expanded: true }), /read-only/);
  const HEAD = fs.readFileSync(path.join(
    __dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'topic', 'topic-head.tsx'), 'utf8');
  assert.match(HEAD, /className="st-readonly-tag">read-only</, 'the chip is the one that says it');
  // Singular, and a missing count degrades rather than printing "0 messages".
  assert.strictEqual(
    ST.headerText({ username: 'alice', message_count: 1 }, { expanded: true }),
    'Agent session by alice · 1 message', 'singular, and nothing after it');
  assert.strictEqual(ST.headerText({}, { expanded: false }), 'Read the agent session');
});

test('falls back to escaped text when DevChat markdown is unavailable', () => {
  const ST = load({ withDevChat: false });
  const html = ST.renderHtml(payload([{
    id: 1, role: 'user', content: 'a <b>bold</b> claim', created_at: 'x', metadata: {},
  }]));
  // Degrades to escaped text — never raw HTML from a message body.
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;b&gt;bold/);
});

test('is a pure string builder — no DOM or fetch needed', () => {
  // The vm sandbox has no document, window.fetch or DevChat.currentSession;
  // rendering must not reach for any of them.
  const ST = load();
  assert.doesNotThrow(() => ST.renderHtml(payload([
    { id: 1, role: 'user', content: 'x', created_at: 'x', metadata: {} },
    { id: 2, role: 'system', content: 'y', created_at: 'x', metadata: { progressLog: ['z'] } },
  ])));
  // Malformed input degrades instead of throwing.
  assert.doesNotThrow(() => ST.renderHtml(null));
  assert.doesNotThrow(() => ST.renderHtml({ messages: [null, { role: null }] }));
});

test('#2597: a running row reads "Coding agent is running", with the venue under it', () => {
  const ST = load();
  const html = ST.renderHtml(payload([
    { id: 1, role: 'system', content: 'Claude Code is running...', created_at: 'x', metadata: {} },
  ]));
  // The same heading the owner sees in the dev chat. A reader who was not in
  // the session is the last person to whom "Claude Code" vs "OpenRouter"
  // means anything, so the row says the event and captions the venue.
  assert.match(html, /Coding agent is running/);
  assert.doesNotMatch(html, /Claude Code is running/);
  assert.match(html, /class="dc-status-venue">Homeroom · Claude</);
  assert.match(html, /class="dc-status-line dc-status-line-captioned"/);
});

test('#2597: the venue comes from the metadata, or from the sentence itself', () => {
  const ST = load();
  // Recorded backend.
  let html = ST.renderHtml(payload([
    {
      id: 1, role: 'system', content: 'Claude Code is running...', created_at: 'x',
      metadata: { agentBackend: 'codex_openrouter' },
    },
  ]));
  assert.match(html, /class="dc-status-venue">Homeroom · OpenRouter</);
  // …and the fallback the rows written before it existed rely on.
  html = ST.renderHtml(payload([
    { id: 1, role: 'system', content: 'OpenRouter is running...', created_at: 'x', metadata: {} },
  ]));
  assert.match(html, /class="dc-status-venue">Homeroom · OpenRouter</);
  // Every other status line is left alone — no caption, no rewrite.
  html = ST.renderHtml(payload([
    { id: 1, role: 'system', content: 'Claude Code log', created_at: 'x', metadata: {} },
  ]));
  assert.match(html, /Claude Code log/);
  assert.doesNotMatch(html, /dc-status-venue/);
});
