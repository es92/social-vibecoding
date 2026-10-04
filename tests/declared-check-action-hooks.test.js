// dapp.json's declared checks reach two Dev-board action pills BY NAME.
//
// Both assert the same kind of thing — that a particular action is offered in
// the card's action BAND, where a reader sees it, rather than demoted into the
// ⋯ menu:
//
//   #dev-body [data-issue-row] .gc-card-actions
//     .gc-vote-btn[data-act="markIssueInProgress"]
//   #dev-kanban-col-inprogress [data-session-chip] .gc-card-actions
//     .gc-vote-btn[data-act="_setSessionShared"]
//
// They used to match `[onclick*="…"]`, because the handler was an inline
// `onclick="AppView.markIssueInProgress(12)"` string. The React conversion
// replaced those strings with closures and took the attribute — the checks'
// only hook — with it. `data-act` puts the answer the model already carries
// (`ActionSpec.act.fn`) back in the markup, and both checks select on that.
//
// This file is the local half of that contract: it reads the real dapp.json
// entries, renders the real card models, and asserts the selector each check
// declares actually resolves. A rename on either side fails here rather than
// on the platform, where the same failure costs a build and a vote.
//
// Run with: node --test tests/declared-check-action-hooks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { issueCardHtml, mySessionCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const DAPP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));

const ME = 42;

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: ME } },
    Kudos: { renderButton: () => '', attach: () => {} },
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
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

/** The declared check whose selector mentions `fn`, or a failure naming it. */
function declaredCheck(fn) {
  const hit = (DAPP.tests || []).find((t) => (t.expectSelector || '').includes(fn));
  assert.ok(hit, `dapp.json still declares a check reaching ${fn}`);
  return hit;
}

/** The action band of a card's HTML, or '' when it rendered none. */
function actionBand(html) {
  const m = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>\s*(?:<div|<\/div)/);
  return m ? m[1] : '';
}

test('the two declared checks select on data-act, not on an inline onclick', () => {
  for (const t of DAPP.tests || []) {
    assert.doesNotMatch(
      t.expectSelector || '',
      /onclick/,
      `"${t.name}" still matches an inline handler the conversion removed`
    );
  }
  assert.match(declaredCheck('markIssueInProgress').expectSelector, /\[data-act="markIssueInProgress"\]/);
  assert.match(declaredCheck('_setSessionShared').expectSelector, /\[data-act="_setSessionShared"\]/);
});

test('an unclaimed issue card offers "I\'ll work on this" in the action band', () => {
  const check = declaredCheck('markIssueInProgress');
  const html = issueCardHtml(makeAppView(), {
    number: 12, title: 'Cards are cramped on mobile', user_id: 7, username: 'someone',
    created_at: '2026-08-21T00:00:00Z', labels: [],
  });

  const band = actionBand(html);
  assert.match(band, /data-act="markIssueInProgress"/, 'the claim pill is on the card FACE');
  assert.match(band, /I&#x27;ll work on this/, `and carries the check's expectText: ${check.expectText}`);
  assert.equal(check.expectText, 'I\'ll work on this');
});

test('the claim pill flips to a release pill once the claim is yours', () => {
  // The check's selector must keep resolving across a whole board, and a
  // board holds both states — so the two must be distinguishable, which is
  // exactly what `data-act` names.
  const html = issueCardHtml(makeAppView(), {
    number: 12, title: 'Cards are cramped on mobile', user_id: 7, username: 'someone',
    created_at: '2026-08-21T00:00:00Z', labels: [],
    in_progress: { claims: [{ user_id: ME, username: 'me', mine: true }] },
  });

  const band = actionBand(html);
  assert.match(band, /data-act="clearIssueClaim"/);
  assert.doesNotMatch(band, /data-act="markIssueInProgress"/);
});

test("your own private session card offers its visibility toggle in the band", () => {
  const AppView = makeAppView();
  const base = {
    id: 990001, user_id: ME, username: 'me', status: 'active',
    session_title: 'Widget language', created_at: '2026-08-21T00:00:00Z',
    last_activity_at: '2026-08-21T00:00:00Z',
  };

  const privateBand = actionBand(mySessionCardHtml(AppView, base));
  assert.match(privateBand, /data-act="_setSessionShared"/);
  assert.match(privateBand, /Make visible/);

  const sharedBand = actionBand(mySessionCardHtml(AppView, { ...base, shared_at: '2026-08-21T00:00:00Z' }));
  assert.match(sharedBand, /data-act="_setSessionShared"/, 'and stays reachable once shared');
  assert.match(sharedBand, /Hide/);
});

test('an imported session card has no visibility toggle to offer', () => {
  // Its head lives in someone else's fork, so there is nothing to make
  // visible — the band carries "Put up for vote" instead. Pinned so the
  // selector above is never "fixed" by stamping data-act on every button.
  const band = actionBand(mySessionCardHtml(makeAppView(), {
    id: 990002, user_id: ME, username: 'me', status: 'active', source: 'imported',
    imported_pr_author: 'someone', session_title: 'Imported PR',
    created_at: '2026-08-21T00:00:00Z', last_activity_at: '2026-08-21T00:00:00Z',
  }));

  assert.doesNotMatch(band, /data-act="_setSessionShared"/);
  assert.match(band, /data-act="promoteImportedSession"/);
});

test('a pill with no action carries no hook', () => {
  // `data-act` is the name of the method the pill CALLS. A disabled
  // explain-itself pill ("Close proposed") calls nothing, so an empty
  // attribute there would make the selector lie.
  const CARD_TSX = fs.readFileSync(path.join(
    __dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'card', 'dev-card.tsx'), 'utf8');
  assert.match(CARD_TSX, /data-act=\{a\.act\?\.fn\}/,
    'the attribute is derived from the model, not spelled out per pill');
});
