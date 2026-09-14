// Card action contract (app-view.js) — the CARD-AS-POINTER budget.
//
// #404 routed every action through one flat .gc-card-actions row and
// DELIBERATELY rejected an overflow menu; the original version of this file
// pinned that by asserting the ABSENCE of gc-overflow-btn / gc-action-menu.
// The card-as-pointer revision REVERSES that decision, so this file now pins
// the opposite contract:
//
//   • every text pill the card has, in one band that shows as many as fit
//     its line and folds the rest into the menu (there is no count cap),
//   • one labelled Preview affordance closing that band (a read-only
//     viewer, who gets no vote buttons, still has a visible affordance),
//   • one menu trigger — the hamburger at the band's right edge — carrying
//     every demoted action as a descriptor,
//   • and NO trigger at all when a card has nothing to demote.
//
// assertNoOverflowMachinery is gone; assertCardActionContract replaces it.
// Permission rules are unchanged — an action only ever MOVED between the card
// face, the ⋯ menu and the detail view, so every per-viewer-role case from
// the original file is preserved, just re-pointed at wherever the action now
// lives.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the markup —
// same harness as archive-proposal-card.test.js. Since #1367's card chunk
// the markup comes from card/dev-card.tsx rendered over the module's view
// model, which ./lib/dev-card-html.js composes.
//
// Run with: node --test tests/card-action-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  cardHtml, govCardHtml, hasAction, issueCardHtml, mergedCardHtml, proposalCardHtml,
} = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(userId, opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: !!(opts && opts.admin) } },
    // Kudos is a CONTROLLER HOST on the card now — the card renders an
    // empty `[data-kudos-host]` and `_fillKudosHosts` writes this in. Its
    // presence is asserted through that host.
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>', attach: () => {} },
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
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// How many text pills the card face actually rendered. The overflow trigger
// carries .gc-vote-btn-icon and the Preview pill .gc-vote-btn-preview, so
// neither counts: one is a corner affordance, the other is not an action on
// the change. The kudos slot DOES: it is a promoted pill like any other, it
// is just a controller host that `_fillKudosHosts` writes the button into.
// The vote pair is NOT in the band any more — it is `.dev-vote-btn`, one
// button in the status band beside the bar (round three) — so it is not a
// primary either.
function primaryCount(html) {
  const row = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  if (!row) return 0;
  const buttons = row[1].match(/<button[^>]*>/g) || [];
  const kudos = row[1].match(/data-kudos-host=/g) || [];
  return buttons.filter((b) => !/gc-vote-btn-icon|gc-vote-btn-preview/.test(b)).length + kudos.length;
}

// The ⋯ trigger's registry key, or null when the card rendered no menu.
function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}

// The descriptor labels the card registered, in order.
function menuLabels(AppView, html) {
  const key = menuKeyOf(html);
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}

// Does the registered menu carry an item whose label matches, and is it
// actionable (has an `act` closure) unless we expected it disabled?
function menuHas(AppView, html, re, opts) {
  const key = menuKeyOf(html);
  if (!key) return false;
  const it = (AppView._cardMenus[key] || []).find((x) => re.test(x.label));
  if (!it) return false;
  if (opts && opts.disabled) return !!it.disabled;
  return !!it.act;
}

// The card-as-pointer contract: the pills the card has, and a menu trigger
// exactly when there is something behind it.
function assertCardActionContract(AppView, html, expect) {
  const e = expect || {};
  const n = primaryCount(html);
  if (e.primary !== undefined) {
    assert.equal(n, e.primary, `expected ${e.primary} primary pill(s), saw ${n}`);
  }
  const labels = menuLabels(AppView, html);
  if (e.menu === false) {
    assert.equal(menuKeyOf(html), null, 'no ⋯ trigger when nothing is demoted');
  } else if (e.menu === true) {
    assert.notEqual(menuKeyOf(html), null, '⋯ trigger present');
    assert.ok(labels.length > 0, '⋯ menu carries at least one descriptor');
  }
  if (e.previewIcon !== undefined) {
    // Round three: the board card's preview is a LABELLED pill — the eye and
    // the word — because the 24px eye in the corner was the hardest thing on
    // the card to hit. It never wears `gc-vote-btn-icon` now.
    const hasPreview = /gc-vote-btn-preview/.test(html);
    assert.equal(hasPreview, e.previewIcon,
      e.previewIcon ? 'labelled Preview affordance present' : 'no Preview affordance');
    if (hasPreview) {
      assert.doesNotMatch(html, /gc-vote-btn-preview[^>]*gc-vote-btn-icon|gc-vote-btn-icon[^>]*gc-vote-btn-preview/,
        'the board preview is the labelled pill, not the icon variant');
      // It sits at the band's right end, just before the hamburger that
      // closes the band: the band is where the card's controls are, and the
      // pair sits flush at its right edge. (It closed the facts line for a
      // round; that seat is empty now.)
      const band = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
      assert.ok(band && /gc-vote-btn-preview/.test(band[1]), 'the labelled Preview pill is in the action band');
      if (menuKeyOf(html)) {
        assert.match(band[1], /gc-vote-btn-preview[^>]*>[\s\S]*?<\/button><button [^>]*dev-card-menu-btn"[^>]*data-card-menu=[^>]*>[\s\S]*?<\/button>$/,
          'Preview, then the hamburger closing the band');
      } else {
        assert.match(band[1], /gc-vote-btn-preview[^>]*>[\s\S]*?<\/button>$/, 'with no menu, Preview closes the band');
      }
      assert.doesNotMatch(html, /dev-card-status-end[^>]*>[\s\S]*?gc-vote-btn-preview/, 'not on the facts line');
    }
  }
  // The demoted actions must NOT also sit on the card face.
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Withdraw</, 'Withdraw is not a card pill');
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Admin merge</, 'Admin merge is not a card pill');
}

// ── The action band (card/dev-card.tsx) ──────────────────────────────────

// A bare model, for the layout-only cases below.
const MODEL = (over) => ({
  key: 'k', cls: 'gc-vote-item', attrs: {}, icon: null,
  title: { text: 'T', title: 'T' }, meta: [], pill: null, linked: [], badges: [],
  chatCount: null, actions: [], rail: { chevron: false }, extra: [],
  dense: true, uncapped: false, ...over,
});
const pill = (label) => ({ key: label, cls: 'gc-vote-btn', label });

test('the action band wraps the primary pills in the shared container', () => {
  const html = cardHtml(MODEL({ actions: [pill('A'), pill('B')] }));
  assert.match(html, /<div class="gc-card-actions">/, 'uses the shared container');
  assert.match(html, />A</);
  assert.match(html, />B</);
});

// There is no count cap any more. The cap was three text pills, then the
// band's fourth was dropped at render time; now every pill renders, each
// marked foldable, and the band's own measurement (useFoldedActions) hides
// the ones its line cannot hold and lists them in the menu instead. So the
// markup carries all of them, and the preview after them.
test('the action band renders every pill, each foldable, and the preview after them', () => {
  const html = cardHtml(MODEL({
    actions: [pill('A'), pill('B'), pill('C'), pill('D')],
    actionPreview: { state: 'live', sessionId: 1, url: 'u', title: 'p', iconOnly: true },
  }));
  for (const [i, l] of ['A', 'B', 'C', 'D'].entries()) {
    assert.match(html, new RegExp(`<button class="gc-vote-btn" data-fold="${i + 1}">${l}<`),
      `${l} renders, foldable — the first included`);
  }
  assert.equal(primaryCount(html), 4);
  assert.match(html, />D<\/button><button [^>]*gc-vote-btn-preview/, 'and the preview follows them');
  // No trigger: nothing is registered behind this bare model's band.
  assert.equal(menuKeyOf(html), null);
});

test('the hamburger sits at the right end of the action band; the card has no rail', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal());
  const html = cardHtml(model);
  // The trigger was a ⋯ in a right-edge column (.dev-card-rail) with the
  // chevron centred below it. It is the band's own "more" now — the menu is
  // where the pills that do not fit the band go — so it sits at the end of
  // that row, and the column is gone: the chevron is the card's only
  // right-edge child.
  assert.doesNotMatch(html, /dev-card-rail/);
  const actions = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  assert.ok(actions && /data-card-menu/.test(actions[1]), 'the trigger is inside the action band');
  assert.match(actions[1], /dev-card-menu-btn"[^>]*>[\s\S]*?<\/button>$/, 'as its last child when there is no preview');
  assert.ok(html.indexOf('data-card-menu') < html.indexOf('M9 5l7 7-7 7'), 'and the chevron after the content column');
  assert.match(html, /aria-haspopup="true"/);
  assert.match(html, /aria-label="More actions"/);
});

test('no ⋯ when there is nothing to demote', () => {
  const AppView = makeAppView(ME);
  assert.equal(menuKeyOf(cardHtml(MODEL())), null);
  // _registerCardMenu drops falsy descriptors before deciding, so a caller
  // may inline conditionals without growing a dead trigger.
  assert.equal(AppView._registerCardMenu('k', []), '');
  assert.equal(AppView._registerCardMenu('k', [null, false, undefined]), '');
  assert.equal(menuKeyOf(cardHtml(MODEL({ rail: { chevron: false, menuKey: '' } }))), null);
});

// Only the title is indented beside the type icon. Everything else — the
// meta line included — is a sibling of the head, so it starts at the card's
// own padding edge and gets its full width.
test('the head holds the icon and the title, and nothing else', () => {
  const AppView = makeAppView(ME);
  const html = cardHtml(MODEL({
    icon: AppView._devCardIcon('issue'),
    title: { text: 'The title', title: 'The title' },
    meta: [{ t: 'text', s: 'PR#1 · someone · 2h ago' }],
    badges: [AppView._attrChipSpec('priority', 'issue', 1, { top: 'high', count: 1 }, true)],
    chatCount: 3,
    actions: [pill('a')],
    extra: [{ t: 'note', key: 'n', text: 'note', workState: 'k' }],
  }));
  const head = html.slice(html.indexOf('dev-card-head"'), html.indexOf('dev-card-meta'));
  assert.match(head, /rounded-lg/, 'the icon leads the head');
  assert.match(head, /dev-card-title/, 'the title sits beside it');
  for (const cls of ['dev-card-meta', 'dev-card-badges',
    'gc-card-actions', 'data-work-note']) {
    assert.ok(!head.includes(cls), `${cls} is NOT inside the head`);
  }
  // …and in this order under it, meta first: it is the title's subtitle. The
  // pill no longer has a row of its own (.dev-status-row is retired) — it
  // LEADS the status band, which is the same band the chips ride.
  const order = ['dev-card-head"', 'dev-card-meta', 'dev-card-badges',
    'gc-card-actions', 'data-work-note'];
  const at = order.map((c) => html.indexOf(c));
  assert.ok(at.every((i) => i >= 0), 'every band renders');
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, `bands out of order: ${order}`);
});

// A dense card RESERVES the band even with nothing in it (that is the
// four-band contract); the detail head collapses it instead.
test('the action band: empty renders an empty band, or none on the detail head', () => {
  assert.match(cardHtml(MODEL({ actions: [] })), /<div class="gc-card-actions"><\/div>/);
  assert.doesNotMatch(cardHtml(MODEL({ actions: [], dense: false })), /gc-card-actions/);
});

// ── Issue card ───────────────────────────────────────────────────────────

const baseIssue = (over) => ({ number: 5, title: 'Fix the thing', ...over });

test('issue card: the state-driven primary + the in-progress toggle; kudos / close stay in ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue());
  const html = cardHtml(model);
  assert.match(html, /gc-card-actions/, 'shared action row present');
  // The state-driven primary for a never-started issue.
  assert.ok(hasAction(model, 'chooseIssueWork', 5), 'the primary is wired');
  assert.match(html, />Start work</);
  // …plus the promoted claim toggle. The card reserves an action band on
  // every row now, and this issue card had one button to put in it; claiming
  // is what a reader does with an issue before writing any code, and the
  // chip it toggles is right above it in the status band.
  assert.ok(hasAction(model, 'markIssueInProgress', 5), 'the claim toggle is wired');
  assert.match(html, />Claim this issue</);
  assertCardActionContract(AppView, html, { primary: 2, menu: true, previewIcon: false });
  // Generating a headless proposal spends the viewer's credits, so it is a
  // chosen ⋯ action rather than the card's most prominent button.
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/), 'AI building is in the Start work chooser');
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'Pledge kudos in ⋯');
  assert.ok(menuHas(AppView, html, /Propose to close/), 'Propose to close in ⋯');
  assert.ok(menuHas(AppView, html, /Set priority/), 'Set priority… in ⋯');
  // Promoted, so it is NOT also a menu row — one action, one place.
  assert.ok(!menuHas(AppView, html, /Claim this issue/),
    'the claim toggle is on the face, so not duplicated in ⋯');
  // …and the ones that stayed demoted are not on the card face.
  assert.ok(!hasAction(model, 'giveIssueBounty'), 'no kudos pill');
  assert.ok(!hasAction(model, 'promptCloseIssue'), 'no close pill');
});

// The other half of the toggle: a claim the viewer already holds renders as
// "Release my claim", keyed off `mine` exactly as the menu row it replaced.
test('issue card: the promoted claim toggle flips to Clear for the viewer\'s own claim', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    in_progress: { claims: [{ mine: true, username: 'me' }] },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'clearIssueClaim', 5), 'the release toggle is wired');
  assert.match(html, />Release my claim</);
  assert.ok(!hasAction(model, 'markIssueInProgress'), 'not both states at once');
  assert.ok(!menuHas(AppView, html, /Release my claim/), 'and not duplicated in ⋯');
});

// A read-only viewer can't claim anything, so the promoted button is absent
// exactly like the ⋯ row it replaced (which is itself inside the
// `if (!readOnly)` block) — the promotion changes where an action lives, never
// who may take it.
test('issue card (read-only): no claim pill at all', () => {
  const AppView = makeAppView(ME);
  // AppView.readOnly is a derived getter, so read-only is expressed the only
  // way it can be: through appData.can_collaborate.
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._issueCardModel(baseIssue());
  const html = cardHtml(model);
  assert.doesNotMatch(html, /markIssueInProgress|clearIssueClaim/,
    'no claim affordance for a read-only viewer');
  AppView.appData = null;
});

test('issue card: a ready headless run IS the primary, replacing Start work', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'startFromAutoSession', 90), 'contextual ready run is the primary');
  assert.match(html, />Review spec/, 'and it wears the contextual label');
  assert.ok(!hasAction(model, 'chooseIssueWork'), 'Start work is superseded, not stacked beside it');
  // Two primaries: the state-driven one, plus the promoted claim toggle.
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'kudos still reachable, from ⋯');
});

test('issue card: a question outcome folds TWO competing pills into one primary', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91 },
  }));
  const html = cardHtml(model);
  // Previously this row rendered the clone action AND a second "Generate
  // proposal" pill side by side. Now: one "Answer & regenerate" primary,
  // with the re-run in ⋯.
  assert.match(html, /Answer &amp; regenerate/, 'single folded primary');
  // Two pills in the band, but only ONE of them is about the headless run: the
  // fold is still a fold. The second is the promoted claim toggle.
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /^Start more work$/), 're-run reachable from ⋯');
});

test('issue card: a run the viewer already cloned offers no competing re-run', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92 },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'goToAutoSessionClone', 92));
  assert.match(html, />Go to session</);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/),
    'no re-run beside "Go to session" — the proposal already exists (#150)');
});

test('issue card: a generating run disables the primary and hides Generate', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'generating', sessionId: 93 },
  }));
  const html = cardHtml(model);
  assert.match(html, /disabled[^>]*>Generating proposal/);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/), 'nothing to generate while one runs');
});

test('issue card: read-only viewer gets no primary, keeps a read-safe ⋯', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._issueCardModel(baseIssue({ htmlUrl: 'https://github.com/o/r/issues/5' }));
  const html = cardHtml(model);
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
  // join(), not deepEqual: the vm context has its own Array prototype, so
  // deepStrictEqual on a cross-realm array fails on the prototype alone.
  assert.equal(menuLabels(AppView, html).join('|'), 'Share to Messages|Open on GitHub',
    'only the read-safe rows survive for a read-only viewer');
  AppView.appData = null;
});

// ── Proposal card ──────────────────────────────────────────────────────────

const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('proposal card: the vote is ONE button beside the bar, and the band is empty', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal());
  const html = cardHtml(model);
  // The model still carries the pair — same calls, same reviewed revision —
  // and the card draws them as one `.dev-vote-btn` in the STATUS band, beside
  // the state bar, whose picker lists the two (card/dev-card.tsx VoteButton).
  assert.ok(hasAction(model, 'castVote', 7, 'yes'));
  assert.ok(hasAction(model, 'castVote', 7, 'no'));
  assert.doesNotMatch(html, /gc-vote-btn-yes|gc-vote-btn-no/, 'no Yes/No pills on the face');
  const band = html.match(/<div class="dev-card-badges dev-card-status">([\s\S]*?)<\/div><div class="gc-card-actions"/);
  assert.ok(band, 'the status band precedes the action band');
  assert.match(band[1], /dev-status-pill-block[\s\S]*<button [^>]*class="dev-vote-btn" data-vote-btn="open"[^>]*aria-haspopup="menu"/,
    'the bar, then the vote button, in the status band');
  assert.match(band[1], /data-vote-btn="open"[^>]*>Vote</, '"Vote" until the viewer has voted');
  assert.match(band[1], /dev-vote-caret/, 'and a caret, so it reads as changeable');
  // The viewer's cast vote is the button's face, and still changeable.
  const voted = cardHtml(AppView._proposalCardModel(baseProposal({ my_vote: 'yes' })));
  assert.match(voted, /class="dev-vote-btn dev-vote-btn-yes" data-vote-btn="yes"[^>]*>[\s\S]*?Yes</,
    'a Yes vote fills the button');
  assert.match(voted, /data-vote-btn="yes"[^>]*title="You voted Yes\. Press to change your vote\."/);
  const votedNo = cardHtml(AppView._proposalCardModel(baseProposal({ my_vote: 'no' })));
  assert.match(votedNo, /class="dev-vote-btn dev-vote-btn-no" data-vote-btn="no"/);
  // And Explore is back in ⋯ (#1787 round four), so the band on a live
  // foreign proposal is the vote and nothing else.
  assert.ok(!html.includes('gc-explore-chat-btn'), 'Explore is not a face pill');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'it is a ⋯ row');
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
});

test('the detail head takes the same one vote button (topic page, round three)', () => {
  const AppView = makeAppView(ME);
  const html = cardHtml(AppView._proposalCardModel(baseProposal(), { noNav: true }));
  assert.doesNotMatch(html, /gc-vote-btn-yes|gc-vote-btn-no/);
  assert.match(html, /class="dev-vote-btn" data-vote-btn="open"/);
  assert.match(html, /dev-card-topic/, 'and wears the topic card class the shared rules dress');
});

test('proposal card: read-only viewer keeps the icon Preview and loses Yes/No', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._proposalCardModel(baseProposal({ staging_url: 'https://stg.example' }));
  const html = cardHtml(model);
  assert.ok(!hasAction(model, 'castVote'), 'no vote buttons for a read-only viewer');
  assert.doesNotMatch(html, /dev-vote-btn/, 'and no vote button either');
  // Without the preview this card would carry no visible affordance at all
  // for someone who cannot vote.
  assertCardActionContract(AppView, html, { primary: 0, previewIcon: true });
  assert.match(html, /aria-label="Open preview"/, 'the pill has a real accessible name');
  AppView.appData = null;
});

test('proposal card (admin, not author): Admin merge / kudos stay in ⋯, Explore does not', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._proposalCardModel(baseProposal({ staging_url: 'https://stg.example' }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'swapToStagingForSession', 7), 'Preview present, as the pill');
  // primary: 0 — the vote is a status-band button, Explore is a ⋯ row and
  // the preview closes the facts line, so a proposal card's action band is
  // empty and `.gc-card-actions:empty` collapses it.
  assertCardActionContract(AppView, html, { primary: 0, menu: true, previewIcon: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /kudos/i), 'kudos in ⋯');
  // One action, one place, and since #1787 round four that place is ⋯.
  assert.ok(!html.includes('gc-explore-chat-btn'), 'no Explore pill on the card face');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore in ⋯');
});

test('proposal card (author): Open session + Withdraw move to ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal({ user_id: ME }));
  const html = cardHtml(model);
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/),
    'owners reach the Mayor via Open session, so no Explore row on their own PR');
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
});

// #1045 was about the owner of an IMPORTED proposal: there is no in-app
// session behind it, so "Open session" must not render — and precisely
// because of that, Explore DOES reach this card. "An owner reaches the Mayor
// from their own session" (#313/#827) has no session to point at here, so
// without it the owner of a PR they imported gets no AI affordance at all.
// _showExplorePill is the shared predicate: not-mine OR mine-but-imported.
// WHERE it is offered is a separate question, and since #1787 round four the
// answer on a card is ⋯ rather than the face.
test('proposal card (author of an imported PR): Withdraw and Explore in ⋯, no session', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal({ user_id: ME, source: 'imported' }));
  const html = cardHtml(model);
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
  assert.ok(!menuHas(AppView, html, /Open session/), 'no dev session behind an imported PR');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/),
    'Explore in ⋯ — the owner\'s only AI affordance (#1045)');
  assert.ok(!html.includes('gc-explore-chat-btn'), 'one action, one place: not also a face pill');
  assert.match(html, /gc-card-actions/, 'the reserved band is still emitted, and empty');
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
});

// ── Governance card ──────────────────────────────────────────────────────

const baseGov = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('gov card: Yes/No are the primaries, Admin merge + Withdraw go to ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._govCardModel(baseGov({ created_by: ME }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'castIssueVote', 11, 'up'), 'castIssueVote');
  assert.ok(hasAction(model, 'castIssueVote', 11, 'down'), 'castIssueVote');
  assert.match(html, /class="dev-vote-btn" data-vote-btn="open"/, 'the same one-button vote as a code proposal');
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
});

test('gov card: a settled row renders the frozen pill and NO ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._govCardModel(baseGov({
    status: 'applied', payload: { issueNumber: 5, appliedAt: '2026-06-02T00:00:00Z', required: 3 },
    kind: 'close_issue',
  }));
  const html = cardHtml(model);
  assert.ok(!hasAction(model, 'castIssueVote'), 'the vote is history');
  assertCardActionContract(AppView, html, { primary: 0, menu: false });
});

test('gov card: non-admin non-creator sees only yes/no, and no ⋯ at all', () => {
  const AppView = makeAppView(ME);
  const model = AppView._govCardModel(baseGov());
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'castIssueVote', 11, 'up'), 'castIssueVote');
  assert.ok(!menuHas(AppView, html, /Admin merge/), 'no admin merge for non-admin');
  assert.ok(!menuHas(AppView, html, /Withdraw/), 'no withdraw for non-creator');
  // Nothing to demote → no dead ⋯ button.
  assertCardActionContract(AppView, html, { primary: 0, menu: false });
});

// ── Merged card ────────────────────────────────────────────────────────────

const baseMerged = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'someone', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 1, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

// A merged card has no vote to take, so its reserved action band would sit
// empty. Kudos is what a reader actually wants to do with a change that landed,
// so it is the one promoted onto this card's face.
test('merged card: kudos is the single promoted pill; Undo / Explore stay in ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._mergedCardModel(baseMerged({ my_vote: 'yes' }), 1);
  const html = cardHtml(model);
  // The "You voted X" box is gone from the card face — the pill's tooltip
  // and the detail view's vote roster carry that now.
  assert.doesNotMatch(html, /gc-vote-voted-box/, 'no "You voted X" box on the board');
  assertCardActionContract(AppView, html, { primary: 1, menu: true });
  // Kudos is a controller host: the card renders the slot, and
  // `_fillKudosHosts` writes Kudos.renderButton's markup into it.
  assert.match(html, /gc-card-actions[\s\S]*?data-kudos-host="8"/,
    'the kudos slot fills the band');
  assert.ok(menuHas(AppView, html, /Undo/), 'Undo in ⋯');
  assert.ok(!menuHas(AppView, html, /kudos/i), 'kudos is on the face, so not also in ⋯');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore in dev chat in ⋯');
});

// Read-only: the promotion moves an action, it does not grant one.
test('merged card (read-only): no kudos pill, band still rendered', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._mergedCardModel(baseMerged(), 1);
  const html = cardHtml(model);
  assertCardActionContract(AppView, html, { primary: 0 });
  assert.match(html, /gc-card-actions/, 'the band is reserved even when empty');
  AppView.appData = null;
});

test('merged card: revert status reads on the META LINE, not as an action', () => {
  const AppView = makeAppView(ME);
  const model = AppView._mergedCardModel(baseMerged({
    revert_session_id: 9, revert_status: 'merged', revert_pr_number: 900,
  }), 1);
  const html = cardHtml(model);
  assert.match(html, /dev-card-meta[\s\S]*?Undone by PR#900/,
    'the revert relationship is a FACT about the change, so it lives in the meta line');
  assert.ok(!menuHas(AppView, html, /^Undo$/), 'no Undo once a revert exists');
});

// ── voteButtonsHtml: group-chat collapsed-vote path unchanged ──────────────

test('voteButtonsHtml: collapseVoted returns the read-only "You voted X" box', () => {
  const AppView = makeAppView(ME);
  const yes = AppView.voteButtonsHtml(baseProposal({ my_vote: 'yes' }), { collapseVoted: true });
  assert.match(yes, /gc-vote-voted-box gc-vote-voted-box-yes/);
  assert.match(yes, />You voted Yes</);
  // A non-promoted PR with no vote collapses to nothing.
  const none = AppView.voteButtonsHtml(baseProposal({ status: 'merged' }), { collapseVoted: true });
  assert.equal(none, '');
});

test('voteButtonsHtml: full set concatenates Preview/Yes/No/Admin (group-chat row)', () => {
  const AppView = makeAppView(ME, { admin: true });
  // voteButtonsHtml is NOT the card's builder — it is the group chat's
  // inline activity row, the work drawer and the home strip, all still
  // innerHTML surfaces. It keeps its onclick attributes.
  const html = AppView.voteButtonsHtml(baseProposal({ staging_url: 'https://stg' }));
  assert.match(html, /swapToStagingForSession/, 'Preview');
  assert.match(html, /castVote\(7, 'yes'\)/, 'Yes');
  assert.match(html, /castVote\(7, 'no'\)/, 'No');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge');
});

test('native vote controls and request carry the approval epoch', async () => {
  // #2038: the vote is pinned to the epoch the card was rendered at, not to
  // the commit. A commit changes every time the platform brings a proposal up
  // to date with main, and a guard that compared commits rejected the next
  // voter's click on every one of those merges — for code the platform had
  // just certified was unchanged.
  const AppView = makeAppView(ME);
  const html = AppView.voteButtonsHtml(baseProposal({ approval_epoch: 3 }));
  assert.match(html, /castVote\(7, 'yes', 3\)/);
  assert.match(html, /castVote\(7, 'no', 3\)/);

  // Imported proposals carry an epoch too: an imported head moving is always
  // an author push, so the epoch is exactly the right thing to compare.
  const importedHtml = AppView.voteButtonsHtml(baseProposal({
    source: 'imported', approval_epoch: 5, imported_pr_head_sha: 'b'.repeat(40),
  }));
  assert.match(importedHtml, /castVote\(7, 'yes', 5\)/);

  let request = null;
  AppView.__sandbox.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes', 3);
  assert.equal(request.url, '/api/sessions/7/vote');
  assert.deepEqual(JSON.parse(request.options.body), {
    vote: 'yes', expectedEpoch: 3,
  });
});

// ── #1924: a vote leaves "Needs your vote" on the click ───────────────

test('#1924: castVote sets my_vote and repaints before the request, and keeps it on success', async () => {
  const AppView = makeAppView(ME);
  const pr = { id: 7, status: 'promoted', my_vote: null };
  AppView._proposals = [pr];
  const seen = [];
  AppView._repaintDevBody = () => { seen.push(`repaint:${pr.my_vote}`); };
  AppView.refreshDevData = () => { seen.push('refresh'); };
  AppView.__sandbox.PlatformUI = { toast: () => {} };
  AppView.__sandbox.fetch = async () => {
    seen.push(`fetch:${pr.my_vote}`);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes');
  assert.equal(seen.join(' '), 'repaint:yes fetch:yes refresh',
    'the card is repainted as voted before the network round-trip');
  assert.equal(pr.my_vote, 'yes');
});

test('#1924: a refused vote puts the old value back and repaints', async () => {
  const AppView = makeAppView(ME);
  const pr = { id: 7, status: 'promoted', my_vote: null };
  AppView._proposals = [pr];
  const repaints = [];
  let toast = null;
  AppView._repaintDevBody = () => { repaints.push(pr.my_vote); };
  AppView.refreshDevData = () => {};
  AppView.__sandbox.PlatformUI = { toast: (m) => { toast = m; } };
  AppView.__sandbox.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'Voting has closed' }) });
  await AppView.castVote(7, 'yes');
  assert.equal(pr.my_vote, null, 'rolled back');
  assert.equal(repaints.join(','), 'yes,', 'optimistic repaint, then the rollback repaint');
  assert.equal(toast, 'Voting has closed');

  // A network failure rolls back the same way.
  AppView.__sandbox.fetch = async () => { throw new Error('offline'); };
  await AppView.castVote(7, 'no');
  assert.equal(pr.my_vote, null);
});

test('#1924: re-casting the same vote does not repaint optimistically', async () => {
  const AppView = makeAppView(ME);
  const pr = { id: 7, status: 'promoted', my_vote: 'yes' };
  AppView._proposals = [pr];
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  AppView.refreshDevData = () => {};
  AppView.__sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await AppView.castVote(7, 'yes');
  assert.equal(repaints, 0);
  assert.equal(pr.my_vote, 'yes');
});

test('a rejected vote re-arms from the epoch the server named', async () => {
  // One head move used to produce TWO identical rejections: the refresh was
  // fired without being awaited and the click lock was released first, so an
  // impatient second click re-sent the same stale stamp (#2038 F8).
  const AppView = makeAppView(ME);
  const sent = [];
  let call = 0;
  AppView.__sandbox.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    call += 1;
    if (call === 1) {
      return {
        ok: false, status: 409,
        json: async () => ({ error: 'changed', approvalEpoch: 9 }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes', 3);
  await AppView.castVote(7, 'yes', 3);
  assert.deepEqual(sent.map((b) => b.expectedEpoch), [3, 9],
    'the second click must carry the epoch the rejection named, not the stale one');
});
