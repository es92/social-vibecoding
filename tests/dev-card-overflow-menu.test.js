// The card overflow (⋯) menu — app-view.js _cardMenuTriggerHtml /
// _toggleCardMenu / the per-card-type descriptor builders.
//
// #404 deliberately rejected an overflow menu and every action sat inline.
// The card-as-pointer revision reverses that, so this file pins the menu's
// contract: descriptors (not HTML) so one list renders as both an anchored
// dropdown and a touch action sheet, a stable registry key per card, no
// trigger when there is nothing to demote, and the SAME permission rules the
// pills had — an action only ever MOVED.
//
// Run with: node --test tests/dev-card-overflow-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');
const {
  cardHtml, closeIssueCardHtml, govCardHtml, hasAction, issueCardHtml, mergedCardHtml, mySessionCardHtml, proposalCardHtml, sharedSessionCardHtml,
} = require('./lib/dev-card-html');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const ME = 42;

function makeAppView(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: o.userId != null ? o.userId : ME, canAdminWrite: !!o.admin } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>',
      attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => !!o.touch, actionSheet: (spec) => { sandbox.__sheet = spec; },
      toast: () => {} },
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // #1191: the menu's ROWS are features/dev-board/card-menu.tsx's, published
  // through this bridge. Everything these tests are about — which descriptors
  // a card offers, the host, the re-anchor, the touch action sheet — is still
  // app-view.js's, so the bridge just records what was published.
  sandbox.publishedMenuRows = [];
  sandbox.UsernodeReact = {
    devBoard: {
      mountCardMenu: () => {},
      publishCardMenu: (rows) => { sandbox.publishedMenuRows = rows; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: o.majority != null ? o.majority : 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  if (o.readOnly) AppView.appData = { slug: 'x', can_collaborate: false };
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});

function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}
function menuItems(AppView, html) {
  const k = menuKeyOf(html);
  return k ? (AppView._cardMenus[k] || []) : [];
}
function menuLabels(AppView, html) {
  return menuItems(AppView, html).map((it) => it.label);
}

const ISSUE = (over) => ({ number: 5, title: 'Fix the thing', ...over });

// A card model with nothing but a rail, for the trigger cases above.
const BARE = (over) => ({
  key: 'k', cls: 'gc-vote-item', attrs: {}, icon: null,
  title: { text: 'T', title: 'T' }, meta: [], pill: null, linked: [], badges: [],
  chatCount: null, actions: [], rail: { chevron: false }, extra: [],
  dense: true, uncapped: false, ...over,
});
const GOV = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

// ── The trigger ─────────────────────────────────────────────────────────

// The trigger's MARKUP is card/dev-card.tsx's rail; the registry — which a
// descriptor's `act` closure cannot leave — is still app-view.js's, and
// `_registerCardMenu` is the seam: it returns the key the rail stamps as
// `data-card-menu`, or '' when there is nothing to demote.
test('no ⋯ trigger when there is nothing to demote', () => {
  const AppView = makeAppView();
  assert.equal(AppView._registerCardMenu('k', []), '');
  assert.equal(AppView._registerCardMenu('k', null), '');
  // Falsy entries are dropped, so callers can inline conditionals.
  assert.equal(AppView._registerCardMenu('k', [null, false, undefined]), '');
  assert.equal(menuKeyOf(cardHtml(BARE({ rail: { chevron: true, menuKey: '' } }))), null);
});

test('the trigger registers its descriptors under a stable key', () => {
  const AppView = makeAppView();
  const key = AppView._registerCardMenu('proposal:7', [{ label: 'A', act: () => {} }]);
  assert.equal(key, 'proposal:7');
  assert.equal(AppView._cardMenus['proposal:7'].length, 1);
  const html = cardHtml(BARE({ rail: { chevron: false, menuKey: key } }));
  assert.match(html, /data-card-menu="proposal:7"/);
  assert.match(html, /aria-haspopup="true"/);
  assert.match(html, /aria-label="More actions"/);
  assert.match(html, /gc-vote-btn-icon/, 'the icon pill variant, so it never outsizes a text pill');
  assert.match(html, /dev-card-menu-btn/, 'and the corner-placement class');
});

test('the trigger sits at the right end of the action band on every card type that has one', () => {
  const AppView = makeAppView({ admin: true });
  AppView._sharedById = {};
  const cards = {
    proposal: proposalCardHtml(AppView, PR()),
    issue: issueCardHtml(AppView, ISSUE({ htmlUrl: 'https://gh/i/5' })),
    gov: govCardHtml(AppView, GOV()),
    merged: mergedCardHtml(AppView, PR({ status: 'merged', chat_count: 0 }), 3),
    session: mySessionCardHtml(AppView, { id: 51, session_title: 'Mine', status: 'active' }),
  };
  for (const [kind, html] of Object.entries(cards)) {
    assert.match(html, /dev-card-head-main/, `${kind}: uses the shared head`);
    // The trigger was a ⋯ in a right-edge column (.dev-card-rail). It is the
    // band's own "more" now — the hamburger after the card's pills, pushed
    // to the band's right edge, because the menu is where the pills that do
    // not fit the band go — and the column is gone.
    assert.doesNotMatch(html, /dev-card-rail/, `${kind}: no rail`);
    const actions = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
    assert.ok(actions && /data-card-menu/.test(actions[1]), `${kind}: trigger inside the action band`);
    assert.ok(actions[1].lastIndexOf('data-act=') < actions[1].indexOf('data-card-menu'),
      `${kind}: after every pill`);
    // Never inside the badge row (where the 💬 lives).
    const badgeRow = html.match(/<div class="dev-card-badges[^"]*"[^>]*>[\s\S]*?<\/div>/);
    if (badgeRow) {
      assert.ok(!/data-card-menu/.test(badgeRow[0]),
        `${kind}: the trigger cannot collide with the 💬 badge`);
    }
  }
});

test('a card with no ⋯ still gets its chevron, with no empty rail around it', () => {
  const AppView = makeAppView();
  // Exercise the generic empty-menu rail; shared sessions now offer View checks.
  const model = AppView._sharedSessionCardModel({
    id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
  });
  model.rail.menuKey = '';
  const html = cardHtml(model);
  assert.equal(menuKeyOf(html), null);
  assert.doesNotMatch(html, /dev-card-rail/);
  assert.match(html, /M9 5l7 7-7 7/, 'the chevron survives on its own');

  // Give that same card a preview and there is STILL no column: the preview
  // is a labelled pill closing the action band, so the chevron stays the
  // only thing on the right edge.
  const withPreviewModel = AppView._sharedSessionCardModel({
    id: 71, session_title: 'Theirs', username: 'them', user_id: 9, staging_url: 'https://s',
  });
  withPreviewModel.rail.menuKey = '';
  const withPreview = cardHtml(withPreviewModel);
  assert.equal(menuKeyOf(withPreview), null, 'still nothing demoted');
  assert.doesNotMatch(withPreview, /dev-card-rail/);
  assert.match(withPreview, /class="dev-card-badges dev-card-status"[^>]*><\/div><div class="gc-card-actions"><button [^>]*gc-vote-btn-preview[^>]*>[\s\S]*?Preview<\/button><\/div><\/div><svg [^>]*class="w-4 h-4/,
    'the Preview pill is the band\'s only content, and the bare chevron follows the content column');
});

test('an applied close-issue card has no ⋯ and no action row at all', () => {
  const AppView = makeAppView();
  const model = AppView._completedCloseIssueCardModel({
    id: 9, chat_count: 0, created_at: '2026-06-01T00:00:00Z', up_count: 2, down_count: 0,
    payload: { issueNumber: 5, issueTitle: 'T', appliedAt: '2026-06-02T00:00:00Z', appliedBy: 'group-vote', required: 2 },
  });
  const html = cardHtml(model);
  assert.equal(menuKeyOf(html), null);
  // The four-band card RESERVES an action band on every dense card, so this
  // one now renders an empty .gc-card-actions rather than none: the point is
  // that a settled vote has nothing to offer, not that the card is shorter
  // than its neighbours in the same column.
  assert.match(html, /<div class="gc-card-actions"><\/div>/, 'reserved, and empty');
  assert.doesNotMatch(html, /gc-card-actions">\s*<button/, 'no actions inside it');
  assert.match(html, /dev-status-pill-block/, 'and it does get the tally bar');
});

test('a repaint under the same key OVERWRITES rather than accumulating', () => {
  const AppView = makeAppView();
  AppView._registerCardMenu('proposal:7', [{ label: 'A', act: () => {} }]);
  AppView._registerCardMenu('proposal:7', [{ label: 'B', act: () => {} }, { label: 'C', act: () => {} }]);
  assert.equal(AppView._cardMenus['proposal:7'].map((i) => i.label).join('|'), 'B|C');
});

test('the registry resets rather than growing without bound', () => {
  const AppView = makeAppView();
  AppView._cardMenuSeq = 4001;
  AppView._cardMenus['stale:1'] = [{ label: 'old' }];
  AppView._registerCardMenu(null, [{ label: 'fresh', act: () => {} }]);
  assert.equal(AppView._cardMenus['stale:1'], undefined, 'the runaway backstop cleared it');
  assert.equal(AppView._cardMenuSeq, 1);
});

// ── Per-card-type × per-viewer-role allocation ──────────────────────────

test('proposal, foreign, plain collaborator', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, proposalCardHtml(AppView, PR()));
  assert.ok(!labels.some((l) => /Admin merge/.test(l)), 'not an admin');
  assert.ok(!labels.some((l) => /Open session|Withdraw/.test(l)), 'not the author');
  // Explore is a ⋯ row again (#1787 round four): a door to a side conversation
  // about the proposal rather than one of the things you do to it, and the
  // widest pill on the card when it rode the face.
  assert.ok(labels.some((l) => /Explore in dev chat/.test(l)), 'offered from ⋯');
  assert.ok(!proposalCardHtml(AppView, PR()).includes('gc-explore-chat-btn'),
    '…and nowhere on the face');
  assert.ok(labels.some((l) => /kudos/i.test(l)));
  assert.ok(labels.some((l) => /Set priority/.test(l)));
});

test('proposal, platform admin: Admin merge is offered and marked danger', () => {
  const AppView = makeAppView({ admin: true });
  const model = AppView._proposalCardModel(PR());
  const html = cardHtml(model);
  const item = menuItems(AppView, html).find((i) => /Admin merge/.test(i.label));
  assert.ok(item, 'offered');
  assert.ok(item.danger, 'a vote bypass is a danger row');
  assert.match(item.title, /bypassing the vote/);
});

test('proposal, app admin: Admin merge, except on an admins-changing PR', () => {
  const AppView = makeAppView();
  AppView._proposalsCtx = { majority: 3, isAppAdmin: true };
  const ordinary = menuLabels(AppView, proposalCardHtml(AppView, PR()));
  assert.ok(ordinary.some((l) => /Admin merge/.test(l)), 'app admins may force-merge');
  // Self-escalation carve-out: an app admin cannot force-merge a proposal
  // that edits the admins block.
  const escalating = menuLabels(AppView, proposalCardHtml(AppView, 
    PR({ requires_explicit_approval: true })));
  assert.ok(!escalating.some((l) => /Admin merge/.test(l)));
});

test('proposal, author: Open session + Withdraw, and no Explore', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, proposalCardHtml(AppView, PR({ user_id: ME })));
  assert.ok(labels.some((l) => /Open session/.test(l)));
  assert.ok(labels.some((l) => /^Withdraw$/.test(l)));
  assert.ok(!labels.some((l) => /Explore in dev chat/.test(l)));
});

test('proposal, author, imported PR: no Open session (there is no in-app session)', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, proposalCardHtml(AppView, 
    PR({ user_id: ME, source: 'imported' })));
  assert.ok(!labels.some((l) => /Open session/.test(l)));
});

test('proposal, read-only viewer: only read-safe rows survive', () => {
  const AppView = makeAppView({ readOnly: true, admin: true });
  const labels = menuLabels(AppView, proposalCardHtml(AppView, PR({ pr_url: 'https://gh/pr/7' })));
  assert.equal(labels.join('|'), 'Share to Messages|View PR on GitHub');
});

test('issue and proposal menus share their exact card references to Messages', () => {
  const AppView = makeAppView({ readOnly: true });
  AppView.appData = { id: 10, slug: 'usernode-2d5619', can_collaborate: false };
  const shared = [];
  AppView.__sandbox.UsernodeReact.messages = {
    share: (reference) => { shared.push(JSON.parse(JSON.stringify(reference))); },
  };

  const issueMenu = menuItems(AppView, issueCardHtml(
    AppView, ISSUE({ number: 1956, htmlUrl: 'https://gh/i/1956' }), { noNav: true },
  ));
  const proposalMenu = menuItems(AppView, proposalCardHtml(
    AppView, PR({ id: 4209, pr_url: 'https://gh/pr/4209' }), { noNav: true },
  ));
  const issueShare = issueMenu.find((item) => item.label === 'Share to Messages');
  const proposalShare = proposalMenu.find((item) => item.label === 'Share to Messages');

  assert.ok(issueShare, 'read-only issue topic cards remain shareable');
  assert.ok(proposalShare, 'read-only proposal topic cards remain shareable');
  assert.equal(issueShare.icon, 'share');
  assert.equal(proposalShare.icon, 'share');
  issueShare.act();
  proposalShare.act();
  assert.deepEqual(shared, [
    { type: 'issue', issueNumber: 1956, appId: 10, appSlug: 'usernode-2d5619' },
    { type: 'proposal', sessionId: 4209, appId: 10, appSlug: 'usernode-2d5619' },
  ]);
});

test('proposal: Retry preview only after a preview error', () => {
  const AppView = makeAppView();
  assert.ok(!menuLabels(AppView, proposalCardHtml(AppView, PR({ staging_url: 'https://s' })))
    .some((l) => /Retry preview/.test(l)));
  assert.ok(menuLabels(AppView, proposalCardHtml(AppView, PR({ staging_error: 'boom' })))
    .some((l) => /Retry preview/.test(l)));
});

test('proposal: Before/after only when captures exist, and it opens the detail view', () => {
  const AppView = makeAppView();
  assert.ok(!menuLabels(AppView, proposalCardHtml(AppView, PR()))
    .some((l) => /Before\/after/.test(l)));
  const withVisualsModel = AppView._proposalCardModel(PR({
    // A real capture set: 32-hex artifact ids are what the tile renderer accepts.
    visuals: { before: { png: 'a'.repeat(32) }, after: { png: 'b'.repeat(32) } },
  }));
  const withVisuals = cardHtml(withVisualsModel);
  const item = menuItems(AppView, withVisuals).find((i) => /Before\/after/.test(i.label));
  assert.ok(item, 'offered when there is something to show');
  // The captures live on the detail view now; the row pre-expands them there.
  let opened = null;
  AppView.openTopic = (kind, id) => { opened = [kind, id]; };
  item.act();
  assert.ok(AppView._visualsOpen.has(7), 'pre-expanded');
  assert.equal(opened.join(':'), 'proposal:7');
});

test('merged proposal: Undo, and never twice over a revert', () => {
  const AppView = makeAppView();
  const merged = (over) => PR({ status: 'merged', chat_count: 0, ...over });
  assert.ok(menuLabels(AppView, mergedCardHtml(AppView, merged(), 3))
    .some((l) => /^Undo$/.test(l)));
  // Undoing a revert would be an infinite undo-undo loop.
  assert.ok(!menuLabels(AppView, mergedCardHtml(AppView, merged({ revert_of_session_id: 4 }), 3))
    .some((l) => /^Undo$/.test(l)));
  // A revert already exists — its status reads on the meta line instead.
  assert.ok(!menuLabels(AppView, mergedCardHtml(AppView, 
    merged({ revert_session_id: 9, revert_pr_number: 900 }), 3))
    .some((l) => /^Undo$/.test(l)));
});

test('merged proposal: completed-task attributes stay editable for collaborators', () => {
  const AppView = makeAppView();
  const populatedModel = AppView._mergedCardModel(PR({
    status: 'merged', chat_count: 0,
    priority: { top: 'high', count: 1 },
    assignee: { top: 'snait', count: 1 },
    category: { top: 'feature', count: 1 },
  }), 3);
  const populated = cardHtml(populatedModel);

  for (const field of ['priority', 'assignee', 'category']) {
    assert.match(populated, new RegExp(`<button[^>]+data-attr-field="${field}"`),
      `${field} is an interactive chip after merge`);
  }

  const unset = menuLabels(AppView, mergedCardHtml(AppView, 
    PR({ status: 'merged', chat_count: 0 }), 3));
  assert.ok(unset.includes('Set priority…'));
  assert.ok(unset.includes('Assign someone…'));
  assert.ok(unset.includes('Set category…'));

  // The completed task's detail header has no overflow menu, so all three
  // unset controls remain directly visible there.
  const detailModel = AppView._proposalCardModel(PR({ status: 'merged', chat_count: 0 }), { noNav: true });
  const detail = cardHtml(detailModel);
  assert.match(detail, /Set priority/);
  assert.match(detail, /Unassigned/);
  assert.match(detail, /Set category/);
  assert.equal((detail.match(/data-attr-chip/g) || []).length, 3);
});

test('merged proposal: completed-task attributes remain read-only without collaboration access', () => {
  const AppView = makeAppView({ readOnly: true });
  const model = AppView._mergedCardModel(PR({
    status: 'merged', chat_count: 0,
    priority: { top: 'high', count: 1 },
    assignee: { top: 'snait', count: 1 },
    category: { top: 'feature', count: 1 },
  }), 3);
  const html = cardHtml(model);

  assert.doesNotMatch(html, /data-attr-chip/, 'populated chips are non-interactive spans');
  const labels = menuLabels(AppView, html);
  assert.ok(!labels.some((label) => /priority|assignee|category/i.test(label)),
    'no attribute mutation entries leak into the menu');
});

test('issue: the full demoted set, and Open on GitHub last', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, issueCardHtml(AppView, 
    ISSUE({ htmlUrl: 'https://gh/i/5' })));
  assert.equal(labels[0], 'Pledge kudos');
  assert.ok(labels.some((l) => /Pledge kudos/.test(l)));
  // The claim toggle is PROMOTED to the action band, so it left the menu.
  assert.ok(!labels.some((l) => /Claim this issue/.test(l)), 'promoted onto the face');
  assert.ok(hasAction(AppView._issueCardModel(ISSUE()), 'markIssueInProgress'),
    'and is wired on the face instead');
  assert.ok(labels.some((l) => /Propose to close/.test(l)));
  assert.equal(labels[labels.length - 1], 'Open on GitHub');
});

test('issue: a disabled row still EXPLAINS itself rather than vanishing', () => {
  const AppView = makeAppView();
  // An open close proposal: the row stays, disabled, saying why.
  AppView._govProposals = [{ kind: 'close_issue', status: 'open', payload: { issueNumber: 5 } }];
  const closed = menuItems(AppView, issueCardHtml(AppView, ISSUE()))
    .find((i) => /Close proposed/.test(i.label));
  assert.ok(closed.disabled);
  assert.match(closed.title, /up for vote/);
  assert.ok(!closed.act, 'a disabled row carries no handler');

  // Weekly kudos allowance spent.
  AppView._govProposals = [];
  AppView._ghIssuesMeta = { myRemaining: 0 };
  const kudos = menuItems(AppView, issueCardHtml(AppView, ISSUE()))
    .find((i) => /Pledge kudos/.test(i.label));
  assert.ok(kudos.disabled);
  assert.match(kudos.title, /allowance spent/);
});

test('gov: Admin merge / View campaign / Withdraw by role', () => {
  const AppView = makeAppView({ admin: true });
  const mine = menuLabels(AppView, govCardHtml(AppView, GOV({ created_by: ME })));
  assert.equal(mine.join('|'), 'Admin merge|Withdraw');

  const campaign = menuLabels(AppView, govCardHtml(AppView, GOV({
    kind: 'maintenance_campaign', payload: { campaignId: 3 },
  })));
  assert.equal(campaign.join('|'), 'Admin merge|View campaign');

  // A rename proposal is not admin-appliable, so a non-creator admin gets
  // nothing and therefore no ⋯ at all.
  const renameModel = AppView._govCardModel(GOV({ kind: 'rename', payload: { newName: 'X' } }));
  const rename = cardHtml(renameModel);
  assert.equal(menuKeyOf(rename), null);
});

test('own session: visibility, chat-sharing, discussion and Archive', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 2 } };
  const sess = (over) => ({ id: 51, session_title: 'Mine', status: 'active', ...over });

  // Visibility is PROMOTED to the action band now (the four-band card reserves
  // one, and this is the single thing you do to your own session), so it is a
  // pill on the face and NOT a ⋯ row. Everything else stays demoted.
  const privHtmlModel = AppView._mySessionCardModel(sess());
  const privHtml = cardHtml(privHtmlModel);
  assert.ok(hasAction(privHtmlModel, '_setSessionShared', 51, true));
  assert.match(privHtml, /gc-card-actions[\s\S]*?>Make visible</);
  assert.equal(menuLabels(AppView, privHtml).join('|'), 'View checks|Archive',
    'a private session has nowhere for a reader to reach its chat from');

  const visHtmlModel = AppView._mySessionCardModel(sess({ shared_at: '2026-06-01T00:00:00Z' }));

  const visHtml = cardHtml(visHtmlModel);
  assert.ok(hasAction(visHtmlModel, '_setSessionShared', 51, false), 'the same pill, flipped');
  assert.match(visHtml, /gc-card-actions[\s\S]*?>Hide</);
  assert.equal(menuLabels(AppView, visHtml).join('|'),
    'Share chat|Open public discussion (2)|View checks|Archive');

  const shared = menuItems(AppView, mySessionCardHtml(AppView, 
    sess({ shared_at: '2026-06-01T00:00:00Z', transcript_shared_at: '2026-06-01T01:00:00Z' })));
  assert.ok(shared.some((i) => /Chat shared/.test(i.label)));
  assert.ok(shared.find((i) => /Archive/.test(i.label)).danger, 'Archive is a danger row');
});

// The ⋯ on a session card sits INSIDE the card's own tap-to-open target, so
// the card-open handler has to skip it. It does that by bailing on any
// `a, button, input, form` ancestor (#dev-body's delegated click), which only
// holds while the trigger is a real <button> — an <a> or a <div role=button>
// would fall straight through to "open the session".
test('session cards: the ⋯ trigger is a <button>, so the card-open handler skips it', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const ownModel = AppView._mySessionCardModel({ id: 51, session_title: 'Mine', status: 'active' });
  const own = cardHtml(ownModel);
  // The trigger is inside the card element, not a sibling of it.
  assert.match(own, /data-session-chip="51"/);
  assert.match(own, /<button[^>]*class="[^"]*dev-card-menu-btn[^"]*"[^>]*data-card-menu="session:51"/,
    'a <button>, which the card-open handler’s a/button/input/form guard skips');
  // And the handler it has to survive really does carry that guard.
  assert.match(SRC, /if \(e\.target\.closest\('a, button, input, form'\)\) return;/);
});

test('someone else’s shared session offers check inspection without owner actions', () => {
  const AppView = makeAppView();
  const model = AppView._sharedSessionCardModel({
    id: 990001, session_title: 'Theirs', username: 'other', status: 'active',
  });
  const html = cardHtml(model);
  assert.match(html, /data-shared-session-row="990001"/);
  assert.equal(menuLabels(AppView, html).join('|'), 'View checks', 'inspection is public; visibility/archive remain owner-only');
});

// ── Surviving a repaint ─────────────────────────────────────────────────
//
// The regression this pins: the board repaints on its own schedule (session
// poll, headless poll, every websocket push), every repaint replaces
// #dev-body's innerHTML, and the repaint paths used to answer that by
// CLOSING any open ⋯ menu. On the In-progress column — where session rows
// churn constantly — the menu was torn off the screen within the same tap
// that opened it, which reads as "the ⋯ doesn't work, it just opens the
// session". The menu is body-mounted and position:fixed, so a repaint never
// touches it; only its trigger is replaced, and re-pointing at the successor
// is all that was ever needed.

// A DOM stub with just enough surface for _reanchorCardMenu: triggers that
// carry a dataset, and a menu element that can be measured and positioned.
function fakeTrigger(key) {
  return {
    dataset: { cardMenu: key },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 380, right: 400 }),
  };
}
function fakeMenu() {
  return { innerHTML: '', style: {}, parentNode: { removeChild() {} }, offsetWidth: 200, offsetHeight: 120 };
}
function withDom(AppView, triggers) {
  const sb = AppView.__sandbox;
  sb.window.innerWidth = 1280;
  sb.window.innerHeight = 800;
  sb.document.querySelectorAll = (sel) => (sel === '[data-card-menu]' ? triggers : []);
}

test('an open menu survives a repaint and re-anchors to the new trigger', () => {
  const AppView = makeAppView();
  const oldTrigger = fakeTrigger('session:51');
  const newTrigger = fakeTrigger('session:51');
  const menu = fakeMenu();
  AppView._cardMenus['session:51'] = [{ label: 'Hide', icon: 'hide', act: () => {} }];
  AppView._openCardMenu = { key: 'session:51', el: menu, trigger: oldTrigger };
  withDom(AppView, [fakeTrigger('proposal:7'), newTrigger]);

  AppView._reanchorCardMenu();

  assert.ok(AppView._openCardMenu, 'still open — a background refresh is not a dismissal');
  assert.equal(AppView._openCardMenu.trigger, newTrigger, 're-pointed at the repainted card');
  assert.equal(newTrigger.attrs['aria-expanded'], 'true');
  assert.match(menu.style.top, /px$/, 're-positioned against the new trigger');
});

test('re-anchoring refreshes the rows from the newly-registered descriptors', () => {
  const AppView = makeAppView();
  const trigger = fakeTrigger('session:51');
  const menu = fakeMenu();
  AppView._cardMenus['session:51'] = [{ label: 'Make visible', icon: 'visible', act: () => {} }];
  AppView._openCardMenu = { key: 'session:51', el: menu, trigger };
  withDom(AppView, [trigger]);

  // The repaint re-registers under the same key — here the session flipped
  // to visible, so the row's wording and its whole action set changed.
  AppView._cardMenus['session:51'] = [
    { label: 'Hide', icon: 'hide', act: () => {} },
    { label: 'Archive', icon: 'archive', danger: true, act: () => {} },
  ];
  AppView._reanchorCardMenu();

  // The rows are re-PUBLISHED, not re-rendered into the node: the host and its
  // one delegated click listener survive the repaint, which is the whole
  // reason the menu is usable on a board that refreshes under it.
  const rows = AppView.__sandbox.publishedMenuRows;
  assert.deepEqual(rows.map((r) => r.label), ['Hide', 'Archive'], 'no stale row left behind');
  assert.deepEqual(rows.map((r) => r.danger), [false, true]);
});

test('re-anchoring closes the menu when the card itself is gone', () => {
  const AppView = makeAppView();
  AppView._cardMenus['session:51'] = [{ label: 'Hide', act: () => {} }];
  AppView._openCardMenu = { key: 'session:51', el: fakeMenu(), trigger: fakeTrigger('session:51') };
  // Archived / filtered out / merged away: the repaint rendered no such card.
  withDom(AppView, [fakeTrigger('proposal:7')]);

  AppView._reanchorCardMenu();
  assert.equal(AppView._openCardMenu, null, 'nothing left to act on');
});

test('_reanchorCardMenu is a no-op with no menu open', () => {
  const AppView = makeAppView();
  AppView._openCardMenu = null;
  withDom(AppView, []);
  AppView._reanchorCardMenu();          // must not throw
  assert.equal(AppView._openCardMenu, null);
});

// Source guard: the three repaint entry points must END in a re-anchor and
// must NOT re-acquire a blanket dismissal. Every one of them replaces the
// innerHTML an open menu's trigger lives in, so a `_closeCardMenu()` added
// back to any of them silently restores the original bug.
test('every repaint path re-anchors instead of dismissing', () => {
  // _repaintPmView was a third repaint path until THE UI OVERHAUL retired the
  // PM view; the two left are the Feed's and the board's.
  for (const fn of ['_repaintDevBody()', '_repaintKanbanBoard()']) {
    const start = SRC.indexOf(`\n  ${fn} {`);
    assert.ok(start > 0, `expected ${fn}`);
    const body = SRC.slice(start, SRC.indexOf('\n  },', start));
    assert.match(body, /_reanchorCardMenu\(\)/, `${fn} must re-anchor an open menu`);
    assert.doesNotMatch(body, /AppView\._closeCardMenu\(\)/,
      `${fn} must not dismiss the ⋯ menu — a background repaint is not a user action`);
  }
});

// The other half of the same bug: the headless poll repainted the whole board
// every 8 seconds whether or not anything had moved, so even one surviving
// menu would have been re-filled on a timer for no reason. #1038 deleted that
// timer outright — the board now flips the card from the pushed session_state
// event — so the guard is simply that it stays deleted.
test('no timer repaints the board on a schedule (headless poll stays retired)', () => {
  assert.doesNotMatch(SRC, /_syncHeadlessPolling\s*\(\)\s*\{/,
    'an unconditional repaint on a timer churns the board (and any open ⋯ menu)');
});

// ── Presentation: dropdown vs action sheet ──────────────────────────────

test('touch presents the SAME descriptors as an action sheet', () => {
  const AppView = makeAppView({ touch: true });
  let ran = false;
  AppView._cardMenus['k'] = [
    { label: 'Do it', icon: 'merge', act: () => { ran = true; } },
    { label: 'Inert', icon: 'close', disabled: true },
    { label: 'Nuke', icon: 'withdraw', danger: true, act: () => {} },
  ];
  AppView._toggleCardMenu({ dataset: { cardMenu: 'k' }, setAttribute: () => {} });
  const sheet = AppView.__sandbox.__sheet;
  assert.ok(sheet, 'an action sheet was presented, not an anchored dropdown');
  // Disabled rows carry no handler, so they are not offered as sheet actions.
  // The kit's sheet takes a plain string per row, so the descriptor's icon
  // rides in as a label prefix — the SAME glyph the dropdown draws in its
  // leading column, resolved from the one descriptor.
  const I = AppView.MENU_ICONS;
  assert.equal(sheet.actions.map((a) => a.label).join('|'),
    `${I.merge}  Do it|${I.withdraw}  Nuke`);
  assert.equal(sheet.actions[1].destructive, true);
  sheet.actions[0].handler();
  assert.ok(ran, 'the descriptor\'s own closure runs');
  assert.equal(AppView._openCardMenu, null, 'no dropdown state on the touch path');
});

test('a menu with no actionable rows still presents nothing on touch', () => {
  const AppView = makeAppView({ touch: true });
  AppView.__sandbox.__sheet = null;
  AppView._cardMenus['empty'] = [];
  AppView._toggleCardMenu({ dataset: { cardMenu: 'empty' }, setAttribute: () => {} });
  assert.equal(AppView.__sandbox.__sheet, null);
});

// ── Leading icons ───────────────────────────────────────────────────────
//
// One vocabulary, keyed by MEANING and resolved from the descriptor, so the
// anchored dropdown and the touch sheet cannot drift apart and the same
// action wears the same glyph on every card type.

// Every descriptor a card can produce, across all five card types and the
// roles that unlock the privileged rows.
function everyDescriptor(AppView) {
  AppView._sharedById = { 51: { id: 51, chat_count: 2 } };
  const out = [];
  const collect = (html) => out.push(...menuItems(AppView, html));
  collect(proposalCardHtml(AppView, PR({
    pr_url: 'https://gh/pr/7', staging_error: 'boom',
    visuals: { before: { png: 'a'.repeat(32) }, after: { png: 'b'.repeat(32) } },
  })));
  collect(proposalCardHtml(AppView, PR({ user_id: ME, pr_url: 'https://gh/pr/7' })));
  collect(mergedCardHtml(AppView, PR({ status: 'merged', chat_count: 0, pr_url: 'https://gh/pr/7' }), 3));
  collect(issueCardHtml(AppView, ISSUE({ htmlUrl: 'https://gh/i/5' })));
  collect(issueCardHtml(AppView, ISSUE({
    number: 6, htmlUrl: 'https://gh/i/6', my_bounty: 1,
    in_progress: { claims: [{ mine: true }] },
  })));
  collect(govCardHtml(AppView, GOV({ created_by: ME })));
  collect(govCardHtml(AppView, GOV({ kind: 'maintenance_campaign', payload: { campaignId: 3 } })));
  collect(mySessionCardHtml(AppView, { id: 51, session_title: 'Mine', status: 'active' }));
  collect(mySessionCardHtml(AppView, {
    id: 51, session_title: 'Mine', status: 'active',
    shared_at: '2026-06-01T00:00:00Z', transcript_shared_at: '2026-06-01T01:00:00Z',
  }));
  return out;
}

test('every descriptor on every card type declares an icon from the vocabulary', () => {
  const AppView = makeAppView({ admin: true });
  const all = everyDescriptor(AppView);
  assert.ok(all.length > 20, `expected the full descriptor inventory, got ${all.length}`);
  const missing = all.filter((it) => !it.icon).map((it) => it.label);
  assert.deepEqual(missing, [], 'no row falls back to the default bullet');
  const unknown = all.filter((it) => !AppView.MENU_ICONS[it.icon])
    .map((it) => `${it.label} → ${it.icon}`);
  assert.deepEqual(unknown, [], 'every icon key resolves in MENU_ICONS');
});

test('the same action wears the same glyph on every card type', () => {
  const AppView = makeAppView({ admin: true });
  const byLabel = new Map();
  for (const it of everyDescriptor(AppView)) {
    const glyph = AppView._menuIconGlyph(it);
    if (byLabel.has(it.label)) {
      assert.equal(byLabel.get(it.label), glyph, `${it.label} drifted between card types`);
    }
    byLabel.set(it.label, glyph);
  }
  // The three that genuinely repeat across card types.
  assert.equal(byLabel.get('Admin merge'), AppView.MENU_ICONS.merge);
  assert.equal(byLabel.get('Withdraw'), AppView.MENU_ICONS.withdraw);
  assert.equal(byLabel.get('View PR on GitHub'), AppView.MENU_ICONS.github);
  assert.equal(byLabel.get('Open on GitHub'), AppView.MENU_ICONS.github);
});

test('an unknown or absent icon key still gets a glyph, so the column never collapses', () => {
  const AppView = makeAppView();
  assert.equal(AppView._menuIconGlyph({ label: 'x' }), AppView.MENU_ICONS.default);
  assert.equal(AppView._menuIconGlyph({ label: 'x', icon: 'nope' }), AppView.MENU_ICONS.default);
});

test('the dropdown draws the glyph in a decorative leading column', () => {
  const AppView = makeAppView();
  let menuEl = null;
  const sandbox = AppView.__sandbox;
  sandbox.document.createElement = () => (menuEl = {
    className: '', innerHTML: '', style: {}, offsetWidth: 200, offsetHeight: 120,
    setAttribute: () => {}, addEventListener: () => {},
    querySelector: () => null,
  });
  sandbox.window.innerWidth = 1280;
  sandbox.window.innerHeight = 800;
  AppView._cardMenus['k'] = [{ label: 'Withdraw', icon: 'withdraw', danger: true, act: () => {} }];
  AppView._toggleCardMenu({
    dataset: { cardMenu: 'k' }, setAttribute: () => {},
    getBoundingClientRect: () => ({ top: 100, bottom: 120, right: 400, left: 380 }),
  });
  assert.ok(menuEl, 'a dropdown was built');
  // The glyph is chosen here and drawn by features/dev-board/card-menu.tsx, so
  // the check runs end to end: the published row carries the glyph, and the
  // component puts it in its own aria-hidden span beside the label.
  assert.deepEqual(AppView.__sandbox.publishedMenuRows.map((r) => r.glyph),
    [AppView.MENU_ICONS.withdraw]);
  const menuHtml = renderComponent(
    'frontend/src/features/dev-board/card-menu.tsx', 'CardMenuView',
    { rows: JSON.parse(JSON.stringify(AppView.__sandbox.publishedMenuRows)) },
  );
  assert.match(menuHtml,
    new RegExp(`<span class="dev-card-menu-icon" aria-hidden="true">${AppView.MENU_ICONS.withdraw}</span>`),
    'glyph in its own aria-hidden span');
  assert.match(menuHtml, /<span class="dev-card-menu-label">Withdraw<\/span>/,
    'the LABEL is still the accessible name — the glyph is not part of it');
});

test('the ✨ that used to live inside the Explore label is now its icon', () => {
  const AppView = makeAppView();
  // Read off a MERGED card: a live proposal promotes Explore onto its face, so
  // the merged board is where the ⋯ row still lives.
  const item = menuItems(AppView, mergedCardHtml(AppView, 
    PR({ status: 'merged', chat_count: 0 }), 3))
    .find((i) => /Explore in dev chat/.test(i.label));
  assert.equal(item.label, 'Explore in dev chat', 'no glyph baked into the label');
  assert.equal(AppView._menuIconGlyph(item), AppView.MENU_ICONS.explore);
});
