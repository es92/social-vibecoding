// The badge budget (app-view.js _cardBadgesHtml + the renderers' badge
// arrays), and the rule that UNSET metadata chips no longer render.
//
// A proposal card could carry up to fourteen badges at once. The
// card-as-pointer revision caps it at BADGE_MAX, plus the 💬 count pinned
// outside the cap (it's a count-with-shortcut, not a status signal), and
// everything demoted moves to the meta line, the pill's tooltip or the
// detail view.
//
// Run with: node --test tests/dev-card-badge-cap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { budgets, cardHtml, issueCardHtml, proposalCardHtml } = require('./lib/dev-card-html');

// The cap moved to the component with the markup it governs.
const { BADGE_MAX } = budgets();

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

// Count the badge-row children: the tinted chips plus the composite pill.
// The chips are their own full-width row (.dev-card-badges) below the head,
// so everything after the meta line is in scope.
function badgeCount(html) {
  const scope = html.slice(html.indexOf('</div>', html.indexOf('dev-card-meta')));
  const chips = (scope.match(/class="attr-chip |class="gc-vote-count |text-\[0\.65rem\]/g) || []).length;
  return chips;
}
const ATTRS = {
  priority: { top: 'high', count: 2 },
  category: { top: 'bug', count: 1 },
  assignee: { top: 'maya', count: 3 },
};

// ── The cap ─────────────────────────────────────────────────────────────

// The cap is card/dev-card.tsx's now, applied to the model's `badges`. A
// bare model with N numbered chips is the clearest way to see it.
const CHIPS = (n) => Array.from({ length: n }, (_, i) => ({
  t: 'chip', key: `c${i + 1}`, cls: 'marker', label: String(i + 1),
}));
const BANDS = (over) => cardHtml({
  key: 'k', cls: 'gc-vote-item', attrs: {}, icon: null,
  title: { text: 'T', title: 'T' }, meta: [], pill: null, linked: [], badges: [],
  chatCount: null, actions: [], rail: { chevron: false }, extra: [],
  dense: true, uncapped: false, ...over,
});
const kept = (html) => (html.match(/class="marker"/g) || []).length;

test('the status band slices to BADGE_MAX and pins 💬 outside it', () => {
  const html = BANDS({ badges: CHIPS(6), chatCount: 7 });
  assert.equal(kept(html), BADGE_MAX);
  assert.match(html, />1<\/span><span class="marker">2<\/span>/, 'kept in priority order');
  assert.doesNotMatch(html, /class="marker">5</, 'the fifth is dropped, not wrapped');
  assert.match(html, /dev-chat-badge/, '💬 rides outside the cap');
  assert.match(html, /data-count="7"/);
});

test('the builder drops falsy entries before the cap counts them', () => {
  const AppView = makeAppView();
  // `_attrChipSpecs` and the card builders `.filter(Boolean)` their chip
  // lists, so a conditioned-away badge costs no slot.
  const model = AppView._issueCardModel(ISSUE());
  assert.ok(model.badges.every(Boolean));
});

test('a null chat count omits the 💬 badge entirely, and a 0 count draws none at either size', () => {
  assert.doesNotMatch(BANDS({ badges: CHIPS(1), chatCount: null }), /dev-chat-badge/);
  // The dense card's facts row is emitted only with something visible in
  // it, and a live bump repaints from the model, so no hidden 0 waits there.
  assert.doesNotMatch(BANDS({ badges: CHIPS(1), chatCount: 0 }), /dev-chat-badge/);
  assert.match(BANDS({ badges: CHIPS(1), chatCount: 2 }), /<div class="dev-card-meta"><span class="dev-chat-badge/,
    'a real count rides the meta line with the tags, at both sizes');
  // The detail head draws nothing at 0 either: the count is the meta line's
  // at every size, and there only when there is one.
  assert.doesNotMatch(BANDS({ dense: false, badges: CHIPS(1), chatCount: 0 }), /dev-chat-badge/);
  assert.match(BANDS({ dense: false, badges: CHIPS(1), chatCount: 4 }), /<div class="dev-card-meta"><span class="dev-chat-badge/);
});

test('the detail head opts OUT of the cap (every chip must be reachable there)', () => {
  assert.equal(kept(BANDS({ badges: CHIPS(5), chatCount: 0 })), BADGE_MAX);
  assert.equal(kept(BANDS({ badges: CHIPS(5), chatCount: 0, uncapped: true })), 5);
});

// ── Unset chips no longer render ────────────────────────────────────────

test('a card with NO metadata carries no grey placeholder chips', () => {
  const AppView = makeAppView();
  const issueModel = AppView._issueCardModel(ISSUE());
  const issue = cardHtml(issueModel);
  assert.doesNotMatch(issue, /Set priority/);
  assert.doesNotMatch(issue, /Set category/);
  assert.doesNotMatch(issue, /Unassigned/);
  const prModel = AppView._proposalCardModel(PR());
  const pr = cardHtml(prModel);
  assert.doesNotMatch(pr, /Set priority/);
  assert.doesNotMatch(pr, /Set category/);
  assert.doesNotMatch(pr, /Unassigned/);
});

test('a SET value still renders its chip', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(ISSUE(ATTRS));
  const html = cardHtml(model);
  assert.match(html, /High/);
  assert.match(html, /Bug/);
  assert.match(html, /@maya/);
});

test('a partially-set card renders only what is set', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(ISSUE({ priority: { top: 'high', count: 1 } }));
  const html = cardHtml(model);
  assert.match(html, /High/);
  assert.doesNotMatch(html, /Set category/);
  assert.doesNotMatch(html, /Unassigned/);
});

test('the DETAIL head keeps the unset ones it can set, and who is on it only when somebody is', () => {
  const AppView = makeAppView();
  const headModel = AppView._issueCardModel(ISSUE(), { noNav: true });
  const head = cardHtml(headModel);
  assert.match(head, /Set priority/, 'the detail view is where metadata gets set');
  assert.match(head, /Set category/);
  // B10c: no grey "Unassigned" chip; the ⋯ row "Assign someone…" sets it.
  assert.doesNotMatch(head, /Unassigned|data-attr-field="assignee"/);
});

test('_attrChipSpecs: omitUnset and the field ORDER', () => {
  const AppView = makeAppView();
  // priority → assignee → category: who owns it reads before what kind of
  // work it is, which is also the badge-priority order.
  const arr = AppView._attrChipSpecs('issue', 5, ATTRS, {});
  assert.equal(arr.length, 3);
  assert.equal(arr[0].label.text, 'High');
  assert.equal(arr[1].label.text, '@maya');
  assert.equal(arr[2].label.text, 'Bug');
  // JSON round-trip: the specs come from a vm sandbox, so deepEqual would
  // compare across realms and fail on the constructor.
  assert.deepEqual(JSON.parse(JSON.stringify(arr.map((c) => c.field))),
    ['priority', 'assignee', 'category']);
  assert.equal(AppView._attrChipSpecs('issue', 5, {}, { omitUnset: true }).length, 0);
  assert.equal(AppView._attrChipSpecs('issue', 5, {}, {}).length, 2, 'B10c: an unset assignee draws no chip');
});

test('the setting entry points move into ⋯, wording by set/unset', () => {
  const AppView = makeAppView();
  const unset = menuLabels(AppView, issueCardHtml(AppView, ISSUE()));
  assert.ok(unset.includes('Set priority…'));
  assert.ok(unset.includes('Set category…'));
  assert.ok(unset.includes('Assign someone…'));
  const set = menuLabels(AppView, issueCardHtml(AppView, ISSUE(ATTRS)));
  assert.ok(set.includes('Change priority…'));
  assert.ok(set.includes('Change assignee…'));
});

test('read-only viewers get no attribute rows at all', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.equal(AppView._attrMenuItems('issue', 5, ATTRS).length, 0);
});

// ── The four badges that survive, in order ──────────────────────────────

test('proposal: the pill LEADS one merged status band; the chips ride the meta line', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR({ ...ATTRS, my_vote: 'yes', check_state: 'passing' }));
  const html = cardHtml(model);
  // History: the pill first led the badge row and counted against the cap,
  // then got a full-width row of its own (.dev-status-row) underneath. The
  // four-band card merges those two rows back into ONE reserved status band,
  // because two variable rows are what made card heights disagree. The pill
  // keeps its bar shape — it just flexes to whatever width the band leaves.
  assert.doesNotMatch(html, /dev-status-row/, '.dev-status-row is retired');
  assert.match(html, /dev-card-badges dev-card-status/, 'one merged band');
  assert.match(html, /dev-status-pill-block/, 'the pill keeps its bar treatment');
  // The TAGS — priority, assignee, category — moved up to the meta line
  // beside the number and the author (#1787): the band keeps what is a
  // STATE, and the pill is the card's headline state, so it leads it.
  const meta = html.slice(html.indexOf('class="dev-card-meta"'), html.indexOf('class="dev-card-badges dev-card-status"'));
  for (const chip of ['High', '@maya', 'Bug']) assert.ok(meta.includes(chip), `${chip} is on the meta line`);
  const band = html.slice(html.indexOf('class="dev-card-badges dev-card-status"'), html.indexOf('class="gc-card-actions"'));
  assert.doesNotMatch(band, /High|@maya|>Bug</, 'and not in the band');
  assert.match(band, /^class="dev-card-badges dev-card-status"[^>]*><span class="[^"]*dev-status-pill-block/, 'the pill leads the band');
  // The chips keep their own order on the meta line.
  assert.ok(meta.indexOf('High') < meta.indexOf('@maya'));
  assert.ok(meta.indexOf('@maya') < meta.indexOf('Bug'));
});

test('the detail head keeps the INLINE capsule, not a second full-width bar', () => {
  const AppView = makeAppView();
  const headModel = AppView._proposalCardModel(PR({ my_vote: 'yes', check_state: 'passing' }), { noNav: true });
  const head = cardHtml(headModel);
  assert.match(head, /gc-vote-count/, 'the pill is still there');
  assert.doesNotMatch(head, /dev-status-pill-block/, 'as a capsule — that page is already full width');
  // And no reserved band either: the detail head is the one non-dense caller,
  // so its rows still collapse when they have nothing to say.
  assert.doesNotMatch(head, /dev-card-status/);
});

test('the pill is exempt from the cap, so four chips still fit beside it', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel({
    number: 5, title: 'x', ...ATTRS,
    in_progress: { count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [], sessions: [{ sessionId: 1, username: 'maya', mine: false, status: 'active', busy: false, lastActivityAt: null }], target: null },
  });
  const html = cardHtml(model);
  // The one work-state chip + priority + assignee + category is exactly
  // BADGE_MAX — #1112 renamed the chip, it is still ONE badge.
  for (const chip of ['Being worked on · maya', 'High', '@maya', 'Bug']) {
    assert.ok(html.includes(chip), `${chip} survives the cap`);
  }
});

test('issue: the work-state chip is the band\'s; the three tags are the meta line\'s', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(ISSUE({
    ...ATTRS, in_progress: { count: 1, users: ['maya'], peopleTotal: 1, mine: false, claims: [], sessions: [{ sessionId: 1, username: 'maya', mine: false, status: 'active', busy: false, lastActivityAt: null }], target: null },
  }));
  const html = cardHtml(model);
  const meta = html.slice(html.indexOf('class="dev-card-meta"'), html.indexOf('class="dev-card-badges dev-card-status"'));
  const band = html.slice(html.indexOf('class="dev-card-badges dev-card-status"'), html.indexOf('class="gc-card-actions"'));
  assert.match(band, /Being worked on · maya/, 'the work state is a state: it stays in the band');
  assert.doesNotMatch(band, /High|@maya|>Bug</);
  for (const chip of ['High', '@maya', 'Bug']) assert.ok(meta.includes(chip), `${chip} rides the meta line`);
});

test('an over-budget proposal drops the LOWEST-priority chip, never the pill', () => {
  const AppView = makeAppView();
  // Pill + three chips = exactly four. Adding the In-progress signal (which
  // proposals don't carry) would be a fifth, so the cap is exercised via the
  // composer instead — but the pill must always survive on the card.
  const model = AppView._proposalCardModel(PR({ ...ATTRS, my_vote: 'yes', check_state: 'passing' }));
  const html = cardHtml(model);
  assert.match(html, /gc-vote-count/, 'the pill is never the one dropped');
  assert.match(html, /High/);
  assert.match(html, /Bug/, 'four badges exactly fit the budget');
});

// ── What moved to the meta line ─────────────────────────────────────────

test('proposal provenance reads on the meta line, not as badges', () => {
  const AppView = makeAppView();
  const model = AppView._proposalCardModel(PR({
    source: 'imported', imported_pr_author: 'octo', external_agent: 'codex',
    pr_title_fallback: true,
  }));
  const html = cardHtml(model);
  const meta = html.slice(html.indexOf('dev-card-meta'), html.indexOf('</div>', html.indexOf('dev-card-meta')) + 6);
  assert.match(meta, /imported from GitHub \(octo\)/);
  assert.match(meta, /built with Codex/);
  assert.match(meta, /auto-title pending/);
  // …and none of them as a chip.
  assert.doesNotMatch(html, /Imported PR/);
  assert.doesNotMatch(html, /Auto-title pending/);
  assert.doesNotMatch(html, /Platform maintenance/);
});

test('_proposalProvenanceWords is empty for an ordinary in-platform proposal', () => {
  const AppView = makeAppView();
  assert.equal(AppView._proposalProvenanceWords(PR()), '');
  assert.equal(AppView._proposalProvenanceWords(PR({ source: 'maintenance' })), 'platform maintenance');
});

test('the issue bounty count reads on the meta line, not as a ★ chip', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(ISSUE({ bounty_count: 3, title_fallback: true }));
  const html = cardHtml(model);
  // React renders the star as the character, not as the entity.
  assert.match(html, /dev-card-meta[\s\S]*?★ 3/);
  assert.match(html, /auto-title pending/);
});
