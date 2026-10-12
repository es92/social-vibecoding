// The duplicate "Generate proposal" button, and why it can no longer recur.
//
// An issue row used to render BOTH "Go to session" and a second "Generate
// proposal" button when a headless auto-solve run finished with a *question*
// outcome and the viewer had already cloned it — two competing actions for a
// proposal that already exists. The original fix was a \`!h.mySessionId\`
// guard on the append, and this file grepped the source for that guard.
//
// The card-as-pointer revision removes the shape of the bug rather than
// guarding it: an issue card now has exactly ONE state-driven primary action
// (_issuePrimaryActionHtml) and at most one "Generate proposal" row in its ⋯
// menu (_issueMenuItems), so two Generate affordances are not expressible.
// These tests pin that behaviourally — one primary, and never a re-run
// offered beside "Go to session".
//
// Run with: node --test tests/issue-generate-proposal-dedup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const {
  cardHtml, hasAction, issueCardHtml, detailActionsHtml,
} = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf-8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({}) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  return AppView;
}

const issue = (headless) => ({ number: 5, title: 'Fix the thing', headless });

// Count the HEADLESS text pills on the card face — this file's subject is that
// an issue never offers two ways to generate the same proposal at once, so the
// count must exclude pills that have nothing to do with the run. The card
// holds its handlers as closures now (#1367's card chunk), so this counts the
// MODEL's action specs and drops the in-progress claim toggle by the call it
// dispatches, which is what it was filtering on before.
const CLAIM = /^(markIssueInProgress|clearIssueClaim)$/;
function primaryCount(model) {
  return (model.actions || [])
    .filter((a) => !(a.act && CLAIM.test(a.act.fn))).length;
}
function menuLabels(AppView, model) {
  const key = model.rail && model.rail.menuKey;
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}

test('a question outcome the viewer has NOT cloned: one primary + one ⋯ re-run', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({ status: 'ready', outcome: 'question', sessionId: 91 }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1, 'exactly one headless pill on the card face');
  assert.match(html, /Answer &amp; regenerate/, 'the folded primary');
  // The band's other pill is the promoted claim toggle, which is not a second
  // way to do this — it is a different action entirely.
  assert.ok(hasAction(model, 'markIssueInProgress', 5));
  const generate = menuLabels(AppView, model).filter((l) => /^Start more work$/.test(l));
  assert.equal(generate.length, 1, 'exactly one Generate proposal affordance, in ⋯');
});

test('a question outcome the viewer HAS cloned: Go to session and NO re-run anywhere', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({
    status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92,
  }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1);
  assert.ok(hasAction(model, 'goToAutoSessionClone', 92));
  assert.match(html, />Go to session</);
  // The original bug, stated directly: no second Generate beside it.
  assert.ok(!menuLabels(AppView, model).some((l) => /^Generate proposal$/.test(l)),
    'the proposal already exists — offering a re-run here is the #150 bug');
  assert.ok(!hasAction(model, 'confirmAutoSession'), 'no re-run wiring on the card at all');
});

test('a run in flight offers neither a clone nor a re-run', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({ status: 'generating', sessionId: 93 }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1);
  // Homeroom's words: a change, never a proposal.
  assert.match(html, /disabled[^>]*>Drafting a change…/);
  assert.ok(!menuLabels(AppView, model).some((l) => /^Generate proposal$/.test(l)),
    'nothing to generate while one is already running');
});

test('every other outcome also yields exactly one primary', () => {
  const AppView = makeAppView();
  for (const outcome of ['spec', 'code', 'spec_code', undefined]) {
    const model = AppView._issueCardModel(issue({ status: 'ready', outcome, sessionId: 90 }));
    assert.equal(primaryCount(model), 1, `outcome ${outcome}: one primary`);
    assert.ok(hasAction(model, 'startFromAutoSession', 90));
  }
  // …and so does a never-started issue.
  const fresh = AppView._issueCardModel(issue(null));
  assert.equal(primaryCount(fresh), 1);
  assert.ok(hasAction(fresh, 'chooseIssueWork', 5));
});

// #17: the Homeroom bot building the request is the same shape as a run in
// flight: one primary, disabled, and nothing that would start the work a
// second time beside it.
test('the Homeroom bot building the request: one disabled primary, and no Start work anywhere', () => {
  const AppView = makeAppView();
  const bot = { what: 'building', since: '2026-10-03T10:00:00Z' };
  for (const [surface, opts] of [['board', undefined], ['head', { noNav: true }]]) {
    const model = AppView._issueCardModel({ ...issue(null), bot }, opts);
    assert.equal(primaryCount(model), 1, `${surface}: one primary`);
    assert.match(cardHtml(model), /disabled[^>]*>Homeroom bot is building…</, `${surface}: and it waits`);
    assert.ok(!hasAction(model, 'chooseIssueWork'), `${surface}: no Start work`);
    assert.ok(!menuLabels(AppView, model).some((l) => /^(Start more work|Generate proposal)$/.test(l)),
      `${surface}: none in ⋯ either`);
  }
  // Even beside a finished auto-solve run, whose primary would offer one.
  const model = AppView._issueCardModel({ ...issue({ status: 'ready', outcome: 'spec', sessionId: 90 }), bot });
  assert.equal(primaryCount(model), 1);
  assert.ok(!hasAction(model, 'startFromAutoSession'), 'the bot is building it already');
  assert.ok(!menuLabels(AppView, model).includes('Start more work'), 'nor in ⋯');
});

// ── Where "Answer & regenerate" goes ──────────────────────────────────
//
// A headless run does not post its questions to the issue — it drafts a
// spec and asks in its OWN transcript, then waits. So the button has to
// land in that session, and it can only do that for the person who started
// the run: /api/sessions/:id is owner-scoped, and DevChat.openSession
// returns silently on a non-ok response.
//
// The fallback for everybody else is the issue's discussion, which is a
// real navigation from the board and a no-op from the topic head — the head
// IS that discussion, and _issueCardModel draws both surfaces (the head via
// { noNav: true }). That no-op was the reported bug: the button did nothing.

test('my own run: the button opens the run\'s session', () => {
  const AppView = makeAppView();
  const h = { status: 'ready', outcome: 'question', sessionId: 91, mine: true };
  for (const [surface, opts] of [['board', undefined], ['head', { noNav: true }]]) {
    const model = AppView._issueCardModel(issue(h), opts);
    assert.ok(hasAction(model, 'openAutoRunSession', 91), `${surface}: opens the session`);
    assert.ok(!(model.actions || []).some((a) => a.act && a.act.fn === 'openTopic'),
      `${surface}: not the issue discussion`);
    assert.match(cardHtml(model), /Answer &amp; regenerate/, `${surface}: keeps the label`);
  }
});

test('the opener exists on AppView — the dispatcher looks it up by name', () => {
  const AppView = makeAppView();
  assert.equal(typeof AppView.openAutoRunSession, 'function',
    'dev-card.tsx call() resolves window.AppView[ref.fn]; a missing name is a silent no-op');
});

test("somebody else's run: board falls back to the issue, head draws nothing", () => {
  const AppView = makeAppView();
  const h = { status: 'ready', outcome: 'question', sessionId: 91, mine: false };

  const board = AppView._issueCardModel(issue(h));
  assert.ok(hasAction(board, 'openTopic', 'issue', 5), 'a real navigation from the board');
  assert.ok(!hasAction(board, 'openAutoRunSession'), 'never into a session it cannot open');

  const head = AppView._issueCardModel(issue(h), { noNav: true });
  const acts = (head.actions || []).map((a) => a.act).filter(Boolean);
  assert.ok(!acts.some((a) => a.fn === 'openTopic'),
    'the head must not offer "open this issue" — it IS this issue');
  assert.ok(!cardHtml(head).includes('Answer &amp; regenerate'),
    'and must not promise a navigation it cannot perform');
});

test('the head still offers exactly one Generate affordance, in its detail actions', () => {
  const AppView = makeAppView();
  const item = issue({ status: 'ready', outcome: 'question', sessionId: 91, mine: false });
  const head = AppView._issueCardModel(item, { noNav: true });
  assert.ok(!hasAction(head, 'confirmAutoSession'),
    'the head card must not grow its own re-run — the detail list owns it');
  assert.ok(!AppView._detailActionsView('issue', item).pills.some((p) => p.key === 'generate'),
    'no separate AI-build pill on the issue head');
  assert.equal(detailActionsHtml(AppView, 'issue', item).includes('Start AI build'), false);
});

// #2376: automated sessions are switched off for now. Start work no longer
// offers "Start AI build" — it goes straight to working with an agent. The vm
// sandbox defines no PlatformUI, so a chooser sheet would throw here.
test('Start work opens an agent session directly, with no AI-build choice', () => {
  const AppView = makeAppView();
  const opened = [];
  let autoRuns = 0;
  AppView.createPrForIssue = (n) => opened.push(n);
  AppView.confirmAutoSession = () => { autoRuns += 1; };

  AppView.chooseIssueWork(5);
  assert.deepEqual(opened, [5], 'Start work opens the interactive session');
  assert.equal(autoRuns, 0, 'never starts an automated run');
  assert.doesNotMatch(SRC, /['`]Start AI build|Start work → Start AI build/,
    'no label or hint offers the AI build any more');
});
