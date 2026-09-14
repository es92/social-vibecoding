// #967: the "Built with Claude Code / Codex" provenance chip.
//
// A proposal that came in through the hosted MCP connector was written by
// the PROPOSER'S OWN coding agent, on their own subscription, in their own
// GitHub fork. The card says which agent, and the detail says on whose
// account — that is the whole point of the connector, and the reason a
// reviewer can trust that nobody's Homeroom credits paid for it.
//
// Two properties matter more than the pixels:
//
//   1. The label vocabulary is CLOSED. chat_sessions.external_agent is
//      written by services/external-agent-tasks.js from a fixed set, but a
//      provenance badge that renders whatever string reached the row is a
//      provenance badge worth spoofing. An unrecognised value must fall back
//      to the generic label, never print itself.
//   2. It sits ALONGSIDE "Imported PR", not instead of it. A connector
//      proposal *is* an import (source stays 'imported'), and every
//      imported-PR behaviour still applies; the two badges answer different
//      questions — how it got here, and who built it.
//
// Same vm-context harness as console-warning-card.test.js.
//
// Run with: node --test tests/external-agent-badge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { detailsHtml, proposalCardHtml } = require('./lib/dev-card-html');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8'
);
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
);

function makeAppView(userId) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.appData = { slug: 'recipe-box' };
  return AppView;
}

const ME = 42;
const connectorProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Add dark mode', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  source: 'imported', imported_pr_author: 'someone',
  external_agent: 'claude-code',
  ...over,
});

test('each known agent gets its own name', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView.externalAgentName('claude-code'), 'Claude Code');
  assert.equal(AppView.externalAgentName('codex'), 'Codex');
  assert.equal(AppView.externalAgentName('external'), 'an external coding agent');
});

test('an ordinary proposal has no agent chip at all', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView.externalAgentName(null), '');
  assert.equal(AppView.externalAgentName(undefined), '');
  assert.equal(AppView.externalAgentName(''), '');
  assert.equal(AppView.externalAgentBadgeHtml(null), '');
  const html = proposalCardHtml(AppView, connectorProposal({ external_agent: null }));
  assert.doesNotMatch(html, /Built with/);
});

test('an unrecognised value falls back — it never prints itself', () => {
  const AppView = makeAppView(ME);
  // The closed vocabulary is the point: the client maps a known value to a
  // known label rather than echoing whatever reached the column.
  assert.equal(AppView.externalAgentName('some-new-agent'), 'an external coding agent');
  const evil = '<img src=x onerror=alert(1)>';
  assert.equal(AppView.externalAgentName(evil), 'an external coding agent');
  const html = AppView.externalAgentBadgeHtml(evil);
  assert.doesNotMatch(html, /<img/, 'nothing from the value reaches the DOM');
  assert.doesNotMatch(html, /onerror/);
  assert.match(html, /Built with a coding agent/, 'and the chip is generic, not specific');

  const card = proposalCardHtml(AppView, connectorProposal({ external_agent: evil }));
  assert.doesNotMatch(card, /onerror=/);
});

// The card's provenance moved OFF the badge row and INTO the meta line: it
// cost a badge slot and doesn't change what you'd do next. Lower-cased there
// because it reads as prose beside the PR number and author, not as a chip.
// externalAgentBadgeHtml itself is unchanged and still asserted above — the
// closed vocabulary is what stops a provenance badge printing server data
// verbatim, and other surfaces still render it.
test('the card names the agent that built it, on the meta line', () => {
  const AppView = makeAppView(ME);
  const claude = proposalCardHtml(AppView, connectorProposal());
  assert.match(claude, /dev-card-meta[^<]*[\s\S]{0,400}?built with Claude Code/);
  const codex = proposalCardHtml(AppView, connectorProposal({ external_agent: 'codex' }));
  assert.match(codex, /built with Codex/);
  assert.doesNotMatch(codex, /Claude Code/);
});

test('the agent provenance reads alongside "imported", not instead of it', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, connectorProposal());
  // Both facts survive: one says how it got here, the other who built it.
  assert.match(html, /imported from GitHub/);
  assert.match(html, /built with Claude Code/);
  assert.ok(
    html.indexOf('imported from GitHub') < html.indexOf('built with Claude Code'),
    'provenance first, then authorship'
  );
  // Both sit in the meta line, ahead of the author and the timestamp, so the
  // sentence reads 'PR#N · imported from GitHub (x) · built with Y · alice · 2d'.
  assert.match(html, /dev-card-meta/);
  assert.doesNotMatch(html, /text-[0.65rem][^"]*">Built with/, 'no longer a badge chip');
});

test('a proposal built by a coding agent still behaves like an import', () => {
  const AppView = makeAppView(ME);
  // Owned by the viewer: an ordinary proposal would offer "Open session".
  // An imported one must not, connector-authored or otherwise — there is no
  // in-app dev session behind it.
  const html = proposalCardHtml(AppView, connectorProposal({ user_id: ME }));
  assert.doesNotMatch(html, /Open session/);
});

test('the detail says whose subscription paid for the code', () => {
  const AppView = makeAppView(ME);
  const html = detailsHtml(AppView, connectorProposal(), { majority: 1 });
  assert.match(html, /Built with <span class="font-medium">Claude Code<\/span>/);
  assert.match(html, /someone/);
  assert.match(html, /their own coding-agent subscription/);
  assert.match(html, /GitHub fork/);
  // The imported note is still there — it explains why there is no dev
  // session, which is just as true for connector work.
  assert.match(html, /Imported pull request/);
});

test('the detail note is absent for a proposal nobody’s agent built', () => {
  const AppView = makeAppView(ME);
  const html = detailsHtml(AppView, 
    connectorProposal({ external_agent: null }), { majority: 1 }
  );
  assert.doesNotMatch(html, /Built with/);
});

test('the badge’s data reaches the client — the column is selected', () => {
  // The chip is driven by cs.external_agent on the proposal rows, so both
  // the promoted list and the merged/detail list have to select it or the
  // badge silently disappears on one surface.
  const VOTES_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
  );
  const selects = VOTES_SRC.match(/cs\.external_agent/g) || [];
  assert.ok(selects.length >= 2, 'external_agent is selected on every proposal list');
});
