// The four-band dev card (public/js/app-view.js + public/css/app.css).
//
// Every card on the dev board is now the same shape, top to bottom:
//
//   1 head    — type icon + title, clamped to TWO lines
//   2 meta    — the "PR#123 · author · 2h ago" subtitle, ONE line
//   3 status  — ONE merged band: the state bar, the Closes-#N pills and the
//               metadata chips, sharing a single row
//   4 actions — ONE row of action pills
//
// The point is alignment BETWEEN cards, not within one: a kanban column used
// to stack a card with a subtitle, three chips and a full-width tally row
// beside a card with a bare title, and nothing lined up. So bands 2 and 4 are
// RESERVED — they render, and hold their row open, even when the card has
// nothing to put in them — and bands 3–4 are CLIPPED rather than allowed to
// wrap, so a busy card loses its surplus pills whole instead of growing.
//
// Band 3 is the one exception, added by #1139: it is reserved whenever it has
// VISIBLE content, and stamped `data-empty="1"` (and hidden by CSS) when it
// has none. The reserve bought alignment between rows that, on most apps, are
// uniformly blank — an issue card can only fill the band if somebody voted an
// attribute, claimed it, commented or opened a close vote — so what it
// actually bought was 27px of empty band on every issue card. The element is
// still EMITTED when empty, because the action band's own cap is written as
// `.dev-card-status + .gc-card-actions` and removing the node would silently
// uncap it.
//
// Three things this file guards that are easy to break later:
//   • bands 2 and 4 reserve unconditionally on the board and collapse on the
//     detail head (`dense: false`), the one caller with no neighbour to align
//     to; band 3 additionally collapses when it is visually empty;
//   • the clip heights are FIXED (min === max), because a max-only height
//     would let a band with content collapse and take the alignment with it;
//   • band 3's empty flag comes from the render INPUTS, not the emitted HTML —
//     the 💬 badge ships at count 0 wearing Tailwind's `hidden`, so the band's
//     markup is never an empty string on an issue card.
//
// Companion files: dev-card-badge-cap.test.js owns which chips make it into
// band 3, card-action-layout.test.js owns which buttons make it into band 4,
// and dev-chip-geometry.test.js owns the chip box itself.
//
// Run with: node --test tests/dev-card-band-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cardHtml, closeIssueCardHtml, govCardHtml, issueCardHtml, mergedCardHtml, mySessionCardHtml, proposalCardHtml, sharedSessionCardHtml, actionHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const CARD_TSX = fs.readFileSync(path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'card', 'dev-card.tsx'), 'utf8');

// The bands are card/dev-card.tsx's since #1367's card chunk, driven by the
// model's inputs. A bare model is how the composer cases below reach them.
const BANDS = (over) => cardHtml({
  key: 'k', cls: 'gc-vote-item', attrs: {}, icon: null,
  title: { text: 'x', title: 'x' }, meta: [], pill: null, linked: [], badges: [],
  chatCount: null, actions: [], rail: { chevron: false }, extra: [],
  dense: true, uncapped: false, ...over,
});
const CHIP = (label, data) => ({ t: 'chip', key: label, cls: 'dev-badge', label, data });
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

const ME = 42;

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => '2h ago',
    App: { user: { id: ME, canAdminWrite: false } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>' },
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
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 2 };
  AppView._mergedCtx = { majority: 2 };
  AppView._visualsOpen = new Set();
  AppView._sharedById = {};
  AppView._govProposals = [];
  return AppView;
}

// ── Fixtures: one of every card type, in its THINNEST form ────────────────
//
// Deliberately bare — no subtitle content to speak of, no chips, no actions
// where the card type allows none. A thin card is what the reserve exists for,
// so it is what these tests render.

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'them',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});
const ISSUE = (over) => ({ number: 5, title: 'Something is wrong', ...over });
const GOV = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});
const MERGED = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'them', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 0, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});
const CLOSE_ROW = (over) => ({
  id: 9, chat_count: 0, created_at: '2026-06-01T00:00:00Z',
  up_count: 2, down_count: 0,
  payload: {
    issueNumber: 5, issueTitle: 'T', appliedAt: '2026-06-02T00:00:00Z',
    appliedBy: 'group-vote', required: 2,
  },
  ...over,
});

function everyCard(AppView) {
  return {
    proposal: proposalCardHtml(AppView, PR()),
    issue: issueCardHtml(AppView, ISSUE()),
    gov: govCardHtml(AppView, GOV()),
    merged: mergedCardHtml(AppView, MERGED(), 2),
    closeIssue: closeIssueCardHtml(AppView, CLOSE_ROW()),
    mySession: mySessionCardHtml(AppView, { id: 51, session_title: 'Mine', status: 'active' }),
    sharedSession: sharedSessionCardHtml(AppView, {
      id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
    }),
  };
}

// The band each card renders, in document order, by class.
//
// `( [^"]*)?` tolerates a band growing an extra class without this helper
// having to change — but NOT a longer first class, so `dev-card-head-main` is
// still correctly not a band. (#1139's empty flag rides as a data attribute,
// outside the class string, so it does not need the allowance; a later band
// that does grow a class will.)
function bandOrder(html) {
  const body = html.slice(html.indexOf('<div class="flex-1 min-w-0">'));
  const out = [];
  const re = /class="(dev-card-head|dev-card-meta|dev-card-badges dev-card-status|gc-card-actions)( [^"]*)?"/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

// ── Band 1–4: present, in order, on every card type ──────────────────────

test('every board card renders all four bands, in order', () => {
  const AppView = makeAppView();
  const want = ['dev-card-head', 'dev-card-meta',
    'dev-card-badges dev-card-status', 'gc-card-actions'];
  for (const [kind, html] of Object.entries(everyCard(AppView))) {
    assert.deepEqual(bandOrder(html).slice(0, 4), want,
      `${kind} card should open with head → meta → status → actions`);
  }
});

test('bands 2 and 4 reserve unconditionally: a bare card still emits them empty', () => {
  const AppView = makeAppView();
  // The settled close-issue row is the extreme case: no actions of any kind
  // (by design — a decided vote has nothing to offer) and no chips.
  const model = AppView._completedCloseIssueCardModel(CLOSE_ROW());
  const html = cardHtml(model);
  assert.match(html, /<div class="gc-card-actions"><\/div>/,
    'the action band renders EMPTY rather than not at all');
  assert.match(html, /class="dev-card-badges dev-card-status"/,
    'and the status band renders too — this card has a settled tally pill');
  assert.doesNotMatch(html, /data-empty/,
    'so it is NOT flagged empty');
  // A session card has no subtitle-less form, so use the raw composer for the
  // truly empty meta case.
  const bare = BANDS();
  assert.match(bare, /<div class="dev-card-meta"><\/div>/, 'empty meta band too');
  assert.match(bare, /<div class="gc-card-actions"><\/div>/);
});

// ── Band 3 only: reserved when it has content, flagged when it doesn't ────

test('#1139: an empty status band is still EMITTED, but flagged data-empty', () => {
  const AppView = makeAppView();
  const bare = BANDS();
  // Emitted — the action band's cap is `.dev-card-status + .gc-card-actions`,
  // so dropping the node would uncap the action row on exactly these cards,
  // and several dapp.json checks walk the same four-band chain.
  assert.match(bare,
    /<div class="dev-card-badges dev-card-status" data-empty="1"><\/div>/);
  // The class attribute is byte-identical either way: the flag is a data
  // attribute precisely so every existing selector keeps matching.
  assert.match(bandOrder(bare).join(','),
    /dev-card-badges dev-card-status/);
});

test('#1139: a bare issue card — nothing voted, claimed or said — is flagged', () => {
  const AppView = makeAppView();
  // The common case, and the one the issue was filed about: no attribute
  // votes, no claim, no close vote, an empty thread.
  const model = AppView._issueCardModel(ISSUE({ chatCount: 0 }));
  const html = cardHtml(model);
  const open = html.indexOf('class="dev-card-badges dev-card-status"');
  assert.ok(open > 0, 'the status row is still in the DOM');
  assert.match(html.slice(open, open + 120), /data-empty="1"/);
  // And it really is blank — no bar, no vote — and there is no facts row
  // under it either: a 0 count draws no badge on the dense card, so the
  // row that would hold it is not emitted at all.
  const band = html.slice(open, html.indexOf('<div class="gc-card-actions"', open));
  assert.doesNotMatch(band, /dev-card-facts|dev-chat-badge|dev-status-pill-block|Closes #/);
});

test('#1139: a 0 chat count is not content; a real one rides the meta line', () => {
  const AppView = makeAppView();
  const zero = BANDS({ chatCount: 0 });
  assert.match(zero, /data-empty="1"/, '💬 0 is invisible: the status row (no bar, no vote) is flagged');
  assert.doesNotMatch(zero, /dev-card-facts|dev-chat-badge/, 'and nothing is drawn to hold a hidden badge');
  const one = BANDS({ chatCount: 1 });
  assert.match(one, /<div class="dev-card-meta"><span class="dev-chat-badge/, 'one message is on the meta line, with the tags');
  assert.doesNotMatch(one, /dev-card-facts/);
  assert.match(one, /dev-card-status" data-empty="1"/,
    'the status row stays bare — the count is a fact about the item, not its state');
  // null/undefined mean "this card type has no thread badge at all".
  const none = BANDS({ chatCount: null });
  assert.match(none, /data-empty="1"/);
  assert.doesNotMatch(none, /dev-card-facts/);
});

test('#1139: each thing a card can say has one home — the bar in the status row, the chips in the facts row, the linkage on the meta line', () => {
  const AppView = makeAppView();
  const bar = BANDS({ pill: { state: { tier: 6, key: 't', label: '2/3', tone: 'progress', yes: 2, no: 0, majority: 3, advisory: 0, lock: false }, inline: false } });
  assert.doesNotMatch(bar, /data-empty/, 'a state bar fills the status row');
  assert.doesNotMatch(bar, /dev-card-facts/);
  const closes = BANDS({ linked: [{ t: 'issueChip', key: 'i4', n: 4, label: 'Closes #4', cls: 'dev-badge', title: 'i' }] });
  assert.match(closes, /<div class="dev-card-meta">[\s\S]*?data-issue-chip="4"[\s\S]*?<\/div><div class="dev-card-badges dev-card-status" data-empty="1">/,
    'Closes #N is the meta line\'s — what the item IS — and leaves the status row bare');
  assert.doesNotMatch(closes, /dev-card-facts/);
  const cases = {
    'one metadata chip': { badges: [CHIP('High')] },
    'a work-state chip': { badges: [CHIP('Started · maya', { 'data-work-state': 'paused' })] },
  };
  for (const [what, over] of Object.entries(cases)) {
    const html = BANDS(over);
    assert.match(html, /<div class="dev-card-badges dev-card-facts">/, `${what} is a facts row`);
    assert.match(html, /dev-card-status" data-empty="1"/, `${what} does not fill the status row`);
  }
  // A chip that has nothing to say is dropped by the BUILDER (every chip spec
  // returns null and the builders `.filter(Boolean)`), so an empty list is
  // what reaches the card — which is what makes this check enough.
  const bare = BANDS({ badges: [] });
  assert.match(bare, /data-empty="1"/);
  assert.doesNotMatch(bare, /dev-card-facts/);
});

test('#1139: the non-dense head omits a row holding only a hidden badge', () => {
  const AppView = makeAppView();
  // Reachable from a shared session's own discussion page, which passes
  // `chatCount: s.chat_count` with `noNav: true`. `badges` was non-empty (the
  // hidden 0-count 💬), so the old truthiness test rendered a 5px strip.
  const loose = BANDS({ dense: false, chatCount: 0 });
  assert.doesNotMatch(loose, /dev-card-badges/, 'no row at all');
  assert.doesNotMatch(loose, /data-empty/, 'and no flag needed — it collapses');
  // With a real count the badge rides the meta line, as on every card, and
  // the head still draws no badge row for it.
  const withChat = BANDS({ dense: false, chatCount: 3 });
  assert.match(withChat, /<div class="dev-card-meta"><span class="dev-chat-badge/);
  assert.doesNotMatch(withChat, /dev-card-badges|dev-card-status/);
});

test('#1139: bumpThreadBadge clears the flag when it reveals the badge', () => {
  // The one path that makes a pill visible without a repaint — so it is the
  // one path that has to un-hide the band itself.
  // It used to write the count, the tint, `hidden` and the band's flag onto
  // nodes the card renderer owns. All four are model fields now, so it bumps
  // the CACHE and repaints — and the flag comes back out of the render
  // inputs, which is the thing it cannot drift from.
  const bump = SRC.slice(SRC.indexOf('bumpThreadBadge(type, ref) {'));
  const body = bump.slice(0, bump.indexOf('\n  },'));
  assert.match(body, /_repaintCards\(\)/, 'it repaints from the bumped cache');
  assert.doesNotMatch(body, /classList\./, 'no in-place class write');
  assert.doesNotMatch(body, /removeAttribute\('data-empty'\)/, 'nor an in-place flag write');
  assert.match(CARD_TSX, /data-empty=\{pill \|\| voteBtn \? undefined : '1'\}/, 'the flag is computed at render');
});

test('bands are SIBLINGS of the head, so only the head is indented', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR());
  const html = cardHtml(model);
  // The head closes before the meta line opens — the meta/status/action bands
  // are not nested inside the icon's flex row.
  const head = html.indexOf('class="dev-card-head"');
  const main = html.indexOf('class="dev-card-head-main"');
  const meta = html.indexOf('class="dev-card-meta"');
  assert.ok(head < main && main < meta, 'head → head-main → meta');
  const headBlock = html.slice(head, meta);
  assert.doesNotMatch(headBlock, /dev-card-badges|gc-card-actions/,
    'nothing but the title shares the icon\'s row');
});

// ── Band 1: the title wraps in full ──────────────────────────────────────

test('a board title wraps in full: no clamp class, and no tooltip standing in for one', () => {
  // It clamped at two lines (with the full text in a `title` tooltip) so a
  // column of open cards kept one rhythm. A column holds one open card among
  // folded rows now, and the row's title has always wrapped in full: the
  // card's does the same, so the two sizes never disagree about the name.
  const AppView = makeAppView();
  const long = 'A deliberately enormous proposal title that runs well past two '
    + 'lines in a narrow kanban column so a clamp would have something to bite on';
  const model = AppView._proposalCardModel(PR({ pr_title: long }));
  const html = cardHtml(model);
  assert.match(html, /<div class="dev-card-title">/, 'the shared title cell, unclamped');
  assert.doesNotMatch(html, /dev-card-title-clamp/);
  assert.ok(!/class="dev-card-title"[^>]*\stitle="/.test(html), 'no tooltip: the text is all there');
  assert.ok(html.includes(long), 'the full title is in the DOM');
});

test('every board card type wraps its title in full', () => {
  const AppView = makeAppView();
  for (const [kind, html] of Object.entries(everyCard(AppView))) {
    assert.match(html, /<div class="dev-card-title"[^>]*>/, `${kind} card uses the shared title cell`);
    assert.doesNotMatch(html, /dev-card-title-clamp/, `${kind} card does not clamp`);
    assert.ok(!/class="dev-card-title"[^>]*\stitle="/.test(html), `${kind} card carries no tooltip`);
  }
});

// ── Band 3: one merged status band ───────────────────────────────────────

test('the status row holds the bar; the Closes pills and the chips ride the meta line', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR({
    linked_issues: [4],
    priority: { top: 'high', count: 1, myValue: null },
  }));
  const html = cardHtml(model);
  const open = html.indexOf('class="dev-card-badges dev-card-status"');
  assert.ok(open > 0, 'the status row exists');
  const band = html.slice(open, html.indexOf('<div class="gc-card-actions"', open));
  assert.match(band, /dev-status-pill-block/, 'state bar in the status row');
  assert.doesNotMatch(band, /Closes #4|High/, 'and nothing that is not a state');
  // The metadata chips are TAGS and the linkage is what the item IS: since
  // #1787 both ride the meta line beside the number and the author, which
  // wraps for them, on the open card and on the folded row alike.
  const meta = html.slice(html.indexOf('class="dev-card-meta"'), open);
  assert.match(meta, /dev-badge[^>]*>[\s\S]*?High/, 'the priority chip is on the meta line');
  assert.match(meta, /Closes #4/, 'and so is the linked-issue chip');
  // Only ONE status row per card: .dev-status-row is retired, and the
  // band break that once folded the facts under the bar inside one band is
  // gone too — the facts are a row of their own.
  assert.equal(html.split('dev-card-badges dev-card-status').length - 1, 1);
  assert.doesNotMatch(html, /dev-status-row|dev-card-band-break/);
});

test('Closes-#N rides the META line as a tag, beside the number', () => {
  // It left the meta line for the status band when the meta line was one
  // truncating line and a pill in it was the first thing cut. The meta line
  // wraps now, and "what this closes" is what the item is, like who it is
  // assigned to — so it sits with the tags, under the title, at both sizes.
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR({ linked_issues: [4] }));
  const html = cardHtml(model);
  const meta = html.slice(html.indexOf('class="dev-card-meta"'),
    html.indexOf('class="dev-card-badges dev-card-status"'));
  assert.match(meta, /Closes #4/);
  assert.doesNotMatch(html.slice(html.indexOf('dev-card-status')), /Closes #4/);
});

test('the state bar LEADS the status row and flexes rather than filling it', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR({
    linked_issues: [4],
    priority: { top: 'high', count: 1, myValue: null },
  }));
  const html = cardHtml(model);
  const band = html.indexOf('dev-card-badges dev-card-status');
  assert.match(html.slice(band, html.indexOf('<div class="gc-card-actions"', band)),
    /^dev-card-badges dev-card-status"><span class="[^"]*dev-status-pill-block/,
    'the bar leads the row — it is the card\'s headline state');
  assert.ok(html.indexOf('High') < band && html.indexOf('Closes #4') < band,
    'the tag and the linkage that used to trail it sit on the meta line above');
});

// ── dense: false — the one caller that opts out ──────────────────────────

test('the detail head (noNav) collapses its empty bands instead of reserving', () => {
  const AppView = makeAppView();
  const headModel = AppView._proposalCardModel(PR(), { noNav: true });
  const head = cardHtml(headModel);
  assert.doesNotMatch(head, /dev-card-status/, 'no reserved status band');
  assert.doesNotMatch(head, /dev-card-title-clamp/, 'and no two-line clamp');
  assert.match(head, /dev-card-title/, 'it still uses the shared title cell');
  // Its pill is the inline one, the one tag (dev-card.tsx ChangeTag), and it
  // is inside the (collapsible) badge row rather than a band of its own.
  assert.match(head, /data-state-tag=/);
  assert.doesNotMatch(head, /dev-status-pill-block/);
});

test('the composer\'s dense flag is what decides all of it', () => {
  const AppView = makeAppView();
  const dense = BANDS();
  const loose = BANDS({ dense: false });
  assert.doesNotMatch(dense, /dev-card-title-clamp/, 'no clamp at either size');
  assert.match(dense, /dev-card-meta/);
  assert.match(dense, /dev-card-status/);
  assert.match(dense, /gc-card-actions/);
  // Nothing to show → nothing rendered, exactly as before the four bands.
  assert.doesNotMatch(loose, /dev-card-meta/);
  assert.doesNotMatch(loose, /dev-card-badges/);
  assert.doesNotMatch(loose, /gc-card-actions/);
});

// ── The CSS geometry ─────────────────────────────────────────────────────

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('the title has no clamp rule left at either size', () => {
  // The two-line clamp and its reserved second line are gone with the class:
  // a rule that outlived its markup would be the next thing to fight.
  assert.ok(!/dev-card-title-clamp/.test(CSS), 'no .dev-card-title-clamp rule in app.css');
  assert.ok(!CARD_TSX.includes('dev-card-title-clamp'), 'and no such class rendered');
});

test('the meta band reserves — and caps — its single line', () => {
  const r = rule('.dev-card-meta');
  assert.match(r, /white-space: nowrap/, 'one line, truncated — never two');
  assert.match(r, /text-overflow: ellipsis/);
  assert.match(r, /overflow: hidden/);
  const min = parseFloat(r.match(/min-height:\s*([\d.]+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*([\d.]+)px/)[1]);
  const size = parseFloat(r.match(/font-size:\s*([\d.]+)px/)[1]);
  const lh = parseFloat(r.match(/line-height:\s*([\d.]+)/)[1]);
  assert.ok(Math.abs(min - size * lh) < 0.5,
    `min-height should be one ${size}px/${lh} line, got ${min}px`);
  // Same min === max contract as the other two reserved bands, and here it is
  // load-bearing for a reason the browser found: a subtitle carrying the
  // `#123` mono link is a mixed-font line box, which measured 17.09px against
  // 16.09px for a plain-text one. Reserving without capping let every linked
  // card push its status and action bands 1px below its neighbours'.
  assert.equal(min, max, 'reserved AND capped at one line');
});

test('the status band is a FIXED-height, clipping row', () => {
  const r = rule('.dev-card-badges.dev-card-status');
  const min = parseFloat(r.match(/min-height:\s*(\d+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*(\d+)px/)[1]);
  // min === max is the whole contract: max alone would let an empty band
  // collapse, and min alone would let a busy one grow.
  assert.equal(min, max, 'reserved AND capped at the same height');
  assert.match(r, /overflow: hidden/, 'the surplus row is hidden, not shrunk');
  // It composes with .dev-card-badges, which is what makes the children wrap
  // (so the overflow is a whole row rather than a half-cut pill).
  assert.match(rule('.dev-card-badges'), /flex-wrap: wrap/);
  assert.equal(min, parseFloat(rule('.dev-status-pill-block').match(/height:\s*(\d+)px/)[1]),
    'one row = the tallest child, the state bar');
});

test('#1139: a flagged-empty status band is hidden, not merely collapsed', () => {
  const r = rule('.dev-card-badges.dev-card-status[data-empty="1"]');
  assert.match(r, /display: none/,
    'display:none takes the 5px margin-top with it — a height of 0 would not');
  // Higher specificity than .dev-card-badges, so source order in app.css
  // cannot resurrect the margin.
  assert.ok(CSS.indexOf('\n.dev-card-badges {')
    < CSS.indexOf('\n.dev-card-badges.dev-card-status[data-empty="1"] {'),
    'and it comes after the base rule anyway');
  // THE regression this whole design exists to prevent: the action band's cap
  // is an adjacent-sibling rule, so the flagged band must stay in the DOM.
  // display:none preserves sibling adjacency; removing the node would not.
  // The facts row may sit between the status row and the band, so the cap
  // names either as the band's predecessor.
  const cap = rule(':is(.dev-card-status, .dev-card-facts) + .gc-card-actions');
  assert.match(cap, /max-height: 24px/, 'the action-band cap still exists…');
  assert.match(CARD_TSX,
    /className="dev-card-badges dev-card-status" data-empty=\{pill \|\| voteBtn \? undefined : '1'\}/,
    '…and the card still emits the status row either way, flag or no flag');
});

test('the action band is capped only where it follows a dense status or facts row', () => {
  const r = rule(':is(.dev-card-status, .dev-card-facts) + .gc-card-actions');
  const min = parseFloat(r.match(/min-height:\s*(\d+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*(\d+)px/)[1]);
  assert.equal(min, max, 'reserved AND capped');
  assert.equal(min, 24, "one row of .gc-vote-btn, whose box is 24px");
  assert.match(r, /overflow: hidden/);
  // The bare .gc-card-actions — the detail view's own list — keeps wrapping
  // freely. Capping it there would hide real actions on a page that has the
  // room for them.
  const bare = rule('.gc-card-actions');
  assert.doesNotMatch(bare, /max-height/);
  assert.match(bare, /flex-wrap: wrap/);
});

test('the kudos pill hugs its wrapper inside the capped action band', () => {
  // Kudos.renderButton hands back its 24px button inside an inline-block
  // positioning span (it anchors the absolute popover). An inline-block is
  // sized by a LINE box, so the span measured 25.5px and its font descender
  // pushed the button 1.5px down — clipped through its own bottom border in a
  // band with zero slack. inline-flex sizes the span by its child instead.
  const r = rule(':is(.dev-card-status, .dev-card-facts) + .gc-card-actions .kudos-wrap');
  assert.match(r, /display: inline-flex/);
  assert.match(r, /align-items: center/);
  // Scoped to the dense band: the detail view's kudos button sits in an
  // uncapped row, where the phantom line-box height changes nothing.
  assert.doesNotMatch(CSS, /\n\.kudos-wrap \{[^}]*inline-flex/);
});

test('the band\'s controls: Preview then the hamburger hold the right edge, and no rail rule remains', () => {
  // Whichever of the pair comes first carries the auto margin that pushes
  // both to the band's right edge, so a column of cards shows every
  // preview on one vertical line; the hamburger directly after a preview
  // drops its own, or two auto margins would split the free space between
  // them. The right-hand rail that used to hold the ⋯ up top and the eye at
  // the bottom has no rule left to fight either.
  const trigger = rule(':is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .dev-card-menu-btn');
  assert.match(trigger, /margin-inline-start: auto/);
  const preview = rule(':is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn-preview');
  assert.match(preview, /margin-inline-start: auto/);
  assert.match(rule(':is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn-preview + .dev-card-menu-btn'), /margin-inline-start: 0/);
  // #2585: the building state is that same pill in gray, so it holds the
  // same edge by the same two rules — and at the pill's height, not the
  // 28px the badge rule above it still hands .gc-checks-running-badge.
  const building = rule(':is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn-building');
  assert.match(building, /margin-inline-start: auto/);
  assert.match(building, /height: 24px/, 'the Preview pill\'s own height, so the band cannot shift');
  assert.match(rule(':is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn-building + .dev-card-menu-btn'), /margin-inline-start: 0/);
  assert.doesNotMatch(CSS, /\.dev-card-rail\s*[{>]/, 'no rail rule remains');
  assert.match(CARD_TSX, /gc-vote-btn gc-vote-btn-icon dev-card-menu-btn/,
    'the trigger is the icon pill variant, so it never outsizes a text pill');
  // The dead rule from an older placement must be gone too: nothing in the
  // band pushes a trailing icon pill.
  assert.doesNotMatch(CSS, /gc-card-actions > \.gc-vote-btn-icon/);
  const band = rule(':is(.dev-card-status, .dev-card-facts) + .gc-card-actions');
  assert.doesNotMatch(band, /justify-content/,
    'the band itself stays a plain left-aligned flex row');
});

test('the band ends with Preview, then the hamburger; the chevron stands alone on the right edge', () => {
  const AppView = makeAppView();
  const key = AppView._registerCardMenu('k:1', [{ label: 'Withdraw', act: () => {} }]);
  const eye = { state: 'live', sessionId: 1, url: 'u', title: 'p', iconOnly: true };
  const bandOf = (html) => { const m = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/); return m ? m[1] : ''; };
  // Round three took the preview out of the rail and made it a LABELLED pill
  // (the corner eye was the hardest thing on the card to hit); #1787 round
  // four moved it onto the facts line; this round seats it where the card's
  // other controls are — the right end of the action band, just before the
  // hamburger that took the ⋯'s place at the edge. The rail column went
  // with both: `rail.preview` — which the builders still hand over — is
  // drawn in the band, and the chevron is the card's only right-edge child.
  const full = BANDS({ rail: { menuKey: key, chevron: true, preview: eye } });
  assert.doesNotMatch(full, /dev-card-rail/);
  assert.match(bandOf(full), /<button [^>]*class="gc-vote-btn gc-vote-btn-preview"[^>]*>[\s\S]*?Preview<\/button><button [^>]*dev-card-menu-btn" data-card-menu="k:1"[^>]*>[\s\S]*?<\/button>$/,
    'the labelled Preview, then the hamburger closing the band');
  assert.doesNotMatch(full, /dev-card-status-end/, 'nothing on the facts line');
  assert.doesNotMatch(full, /gc-vote-btn-preview[^>]*gc-vote-btn-icon/, 'never the icon variant on a board card');
  assert.match(full, /<\/div><\/div><svg [^>]*class="w-4 h-4/, 'the chevron after the content column');

  // No preview → the band ends with the hamburger, and nothing is reserved.
  const noEye = BANDS({ rail: { menuKey: key, chevron: true, preview: null } });
  assert.match(bandOf(noEye), /dev-card-menu-btn" data-card-menu="k:1"[^>]*>[\s\S]*?<\/button>$/);
  assert.equal(noEye, BANDS({ rail: { menuKey: key, chevron: true } }));

  // A card with a preview but no menu (the shared-session card): the band
  // holds the preview alone, and the chevron still stands bare.
  const eyeOnly = BANDS({ rail: { chevron: true, preview: eye } });
  assert.doesNotMatch(eyeOnly, /dev-card-rail|data-card-menu/);
  assert.match(bandOf(eyeOnly), /^<button [^>]*gc-vote-btn-preview[^>]*>[\s\S]*?Preview<\/button>$/);
  assert.match(eyeOnly, /gc-vote-btn-preview[\s\S]*w-4 h-4/, 'preview in the band, chevron after it');
  assert.doesNotMatch(BANDS({ rail: { chevron: true } }), /dev-card-rail/, 'a lone chevron needs no column');
  assert.doesNotMatch(BANDS({ rail: { chevron: false } }), /dev-card-rail|w-4 h-4/);
});

test('no dense renderer puts the preview back in the action band', () => {
  // The three dense card types that have something to preview pass it to the
  // rail (a request's card lost its own with the headless run it previewed);
  // only the noNav (detail head) branch keeps it in the action list,
  // because that head has no chevron for the eye to sit under and its band is
  // uncapped and wrapping.
  // The model says it directly: `actionPreview` is only ever the noNav
  // branch, and every dense card hands its eye to the rail.
  const inBand = SRC.match(/actionPreview: [^,\n]*/g) || [];
  for (const c of inBand) {
    assert.match(c, /actionPreview: (null|noNav \? preview : null)/,
      `dense action band must not carry the preview: ${c}`);
  }
  const rails = SRC.match(/(preview: noNav \? null : preview|chevron: [^,]+, preview )/g) || [];
  assert.ok(rails.length >= 3,
    `expected the dense builders to pass a preview to the rail, saw ${rails.length}`);
});

test('the state bar flexes into whatever the chips leave, over a floor', () => {
  const r = rule('.dev-status-pill-block');
  assert.match(r, /flex: 1 1 auto/, 'it grows and shrinks — it is no longer a row');
  assert.match(r, /min-width: 7rem/, 'but never so narrow that the tally is unreadable');
  // max-width: 100% stays (it must not overflow its band); `width: 100%` is
  // the full-width row the merge removed.
  assert.doesNotMatch(r, /\n\s*width: 100%/, 'the full-width bar is gone');
  assert.match(r, /max-width: 100%/, 'it still cannot exceed the band');
});

test('the two legacy merge badges are boxed INSIDE the clipped band only', () => {
  // They size themselves from their own line-height, so in a clipped band they
  // were the one child that could wrap its label and be cut through the text.
  const r = rule('.dev-card-status > .gc-merging-badge,\n.dev-card-status > .gc-checks-running-badge');
  assert.match(r, /height: 20px/);
  assert.match(r, /box-sizing: border-box/);
  assert.match(r, /flex-shrink: 0/);
  // Scoped: the same classes are also an icon-sized preview state in the
  // action row and appear in the feed/home strips, which own their geometry.
  assert.doesNotMatch(CSS, /\n\.gc-merging-badge \{[^}]*height: 20px/);
});

test('.dev-status-row is retired — no rule, no reference', () => {
  assert.doesNotMatch(CSS, /dev-status-row/, 'the CSS rule is gone');
  assert.doesNotMatch(SRC, /dev-status-row/, 'and nothing renders the class');
});

test('a busy action pill draws the spinner arc beside its label and says it is busy', () => {
  // #6104: pressing Submit for review greys the button and swaps its label to
  // "Submitting…", but nothing on it moved, so the press looked ignored. The
  // model carries `busy` while the POST is in flight; the pill draws the same
  // arc and `aria-busy` the dev chat's changes card uses.
  const busy = actionHtml({ key: 'propose-change', cls: 'gc-vote-btn', label: 'Submitting…', disabled: true, busy: true });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"/);
  assert.match(busy, />\s*<\/span>Submitting…<\/button>/, 'the arc sits before the label');
  assert.match(busy, /class="gc-vote-btn gap-1\.5"/);
  assert.match(busy, /disabled/);

  // Without `busy` the pill is byte-for-byte what it was: no attribute, no
  // extra class, no span.
  const atRest = actionHtml({ key: 'propose-change', cls: 'gc-vote-btn', label: 'Submit for review' });
  assert.doesNotMatch(atRest, /aria-busy/);
  assert.doesNotMatch(atRest, /dc-status-spinner-arc/);
  assert.match(atRest, /^<button class="gc-vote-btn">/);
});

test('a change whose screenshots failed offers its author or an admin the retake in its band', () => {
  // #6551: the card carried "Couldn't take the screenshots" with no way to act
  // on it. The same retake the change page's ⋯ menu has now rides the band
  // for the author or an app admin, and folds into ⋯ when it does not fit.
  const AppView = makeAppView();
  const failed = {
    state: 'failed', failureCode: 'shots_capture_incomplete', repairAvailable: true,
    failureReason: 'The shots agent could not reach the dialog.',
  };
  const author = PR({ user_id: ME, shots: failed });
  const model = AppView._proposalCardModel(author);
  const retake = (model.actions || []).find((a) => a.key === 'shots-retake');
  assert.ok(retake, 'the author sees it');
  assert.equal(retake.act.fn, 'rerunShots');
  assert.equal(retake.act.args.length, 1);
  assert.equal(retake.act.args[0], author.id);
  assert.equal(retake.passNode, true);
  assert.equal(retake.cls, 'gc-vote-btn');
  assert.equal(retake.label, 'Take the screenshots again');
  assert.equal(retake.title, 'Take the before & after screenshots again on this exact build');
  assert.equal(model.actions[model.actions.length - 1].key, 'shots-retake', 'after the vote pills');
  const html = proposalCardHtml(AppView, author);
  assert.match(html, /<button class="gc-vote-btn" title="Take the before &amp; after screenshots again on this exact build"[^>]*data-act="rerunShots">Take the screenshots again<\/button>/);

  // An app admin sees it too, through the board's own context.
  AppView._proposalsCtx = { ...AppView._proposalsCtx, isAppAdmin: true };
  assert.ok((AppView._proposalCardModel(PR({ shots: failed })).actions || []).some((a) => a.key === 'shots-retake'));
  AppView._proposalsCtx = { majority: 2 };

  // Other readers get the failure tag and no button.
  const other = PR({ user_id: 999, shots: failed });
  assert.ok(!(AppView._proposalCardModel(other).actions || []).some((a) => a.key === 'shots-retake'));

  // The detail head keeps the page's ⋯ row instead.
  assert.ok(!(AppView._proposalCardModel(author, { noNav: true }).actions || []).some((a) => a.key === 'shots-retake'));
  // Merged cards are untouched.
  assert.ok(!(AppView._proposalCardModel({ ...author, status: 'merged' }).actions || []).some((a) => a.key === 'shots-retake'));
  // Nothing to press while the platform is already retrying, or when the run
  // has not failed.
  assert.ok(!(AppView._proposalCardModel(PR({ user_id: ME, shots: { ...failed, automaticRetryPending: true } })).actions || []).some((a) => a.key === 'shots-retake'));
  assert.ok(!(AppView._proposalCardModel(PR({ user_id: ME, shots: { state: 'verified', artifacts: [] } })).actions || []).some((a) => a.key === 'shots-retake'));
});
