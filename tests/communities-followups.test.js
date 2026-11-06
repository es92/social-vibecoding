'use strict';

// Follow-ups to the communities hub (#3269, #3270, #3271; #3268 alongside):
//
//   - the Communities screen's "Show N more" reveals five at a time
//     (features/workshop/index.tsx sectionFold, pinned in
//     tests/workshop-screen.test.js);
//   - its Needs you tab is one feed of every decision owed, mixed across
//     projects, one card per screen (features/workshop/needs-reel.tsx, GET
//     /api/workshop/needs-feed in src/routes/workshop-overview.js);
//   - on a phone its all-apps chip is the header's title
//     (features/header/header-title.tsx).
//
// The feed's query is run against a real schema in
// tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const route = require('../src/routes/workshop-overview');

test('#3270, #3488: the feed\'s rows are a project\'s own Needs you rows, each carrying its project', () => {
  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const app = { slug: 'my garden', name: 'Garden', icon_url: null, icon_emoji: null };
  assert.equal(reel.plainSummary('## What\n\n- Adds **rating** sort\n- See [the docs](https://x.y)\n\n```js\nx()\n```'),
    'What Adds rating sort See the docs', 'a paragraph, not a document');
  assert.equal(reel.plainSummary(null), '');
  const [change, decision, unrevised] = reel.reelRows([
    { kind: 'proposal', id: 8, title: 'Sort', summary: '**Adds** a sort', author: 'ada', number: 12, epoch: 3, at: null, yes: 2, no: 1, app },
    { kind: 'governance', id: 9, title: '', summary: null, author: null, number: null, epoch: null, at: null, yes: null, no: null, app },
    { kind: 'proposal', id: 10, title: 'Tags', summary: null, author: null, number: null, epoch: null, at: null, yes: 0, no: 0, app },
  ], (md) => `<p>${md}</p>`);
  // A change: the platform's own vote, with the approval epoch the server
  // checks (#2038), exactly as _cardVoteButtonSpecs builds it.
  assert.deepEqual(change.yes.act, { fn: 'castVote', args: [8, 'yes', 3] });
  assert.deepEqual(change.no.act, { fn: 'castVote', args: [8, 'no', 3] });
  assert.deepEqual(unrevised.yes.act.args, [10, 'yes'], 'no epoch, no third argument');
  assert.equal(change.kind, 'vote');
  assert.equal(change.card.attrs['data-proposal-row'], '8');
  assert.equal(change.summary, 'Adds a sort');
  assert.equal(change.descriptionHtml, '<p>**Adds** a sort</p>', 'the sheet renders the Markdown itself');
  assert.deepEqual(change.askAbout, { kind: 'proposal', ref: 8 });
  assert.deepEqual(change.thread, { type: 'session', ref: 8 });
  assert.deepEqual(change.tally, { yes: 2, no: 1 });
  assert.equal(change.app, app);
  assert.equal(change.card.rail.menuKey, '', 'the ⋯ is Open card alone, which an empty key still reaches');
  // A group decision: no pair, so its vote sheet opens its page.
  assert.equal(decision.yes, null);
  assert.equal(decision.no, null);
  assert.equal(decision.card.attrs['data-gov-row'], '9');
  assert.equal(decision.card.title.text, 'A group decision');
  assert.deepEqual(decision.askAbout, { kind: 'gov', ref: 9 });
  assert.deepEqual(decision.thread, { type: 'governance', ref: 9 });
});


test('#3516: on a phone the Communities feed ends where the screen\'s clearance begins', () => {
  // "Some elements get hidden under the resume app banner." The feed was
  // `calc(100dvh - 180px - var(--browser-banner-h, 0px))`, a guess that knew a
  // 56px bar and nothing else: not the parked app's strip, not an installed
  // iPhone's insets, not the "Get the app" banner (whose token is 0 on this
  // screen). Measured at 390x844 with an app parked, the feed ran to 828px
  // against the strip's top at 736 in a phone browser and to 827 against 716
  // installed, so the rail's Try it and More sat under the strip and the bar —
  // and a drag on the feed cannot move the screen behind it:
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-needs-scroll \{[^}]*overscroll-behavior: contain;/,
    'why the foot could not be scrolled into view');
  // Declarations only: the comment over the new rule quotes the old one.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /100dvh - 180px/, 'the guess is gone');
  const base = css.match(/\n\.workshop-needs-feed \{([^}]*)\}/);
  assert.ok(base, 'the base rule is still there');
  assert.doesNotMatch(base[1], /(^|[^-])height:/, 'and sets no height of its own');

  // The chain: the screen, its column and the pane flex, and the feed takes
  // what is left above the screen's padding, less the deck's own air. Phone
  // only; every link grows and none shrinks (a shrinking link leaves the feed
  // overflowing it, and padding follows in-flow children — the #3053 trap).
  const phone = css.match(/@media \(max-width: 767\.98px\) \{\n  #workshop-screen:not\(\.hidden\):has\(> div > \[data-workshop-pane="needs"\]\) \{[\s\S]*?\n\}\n/);
  assert.ok(phone, 'the phone block, guarded by :not(.hidden)');
  const block = phone[0];
  assert.match(block, /#workshop-screen:not\(\.hidden\):has\(> div > \[data-workshop-pane="needs"\]\) \{\n    display: flex; flex-direction: column;\n  \}/,
    'an id-specific display must never outrank .hidden: the pane stays mounted on other screens');
  assert.match(block, /#workshop-screen > div:has\(> \[data-workshop-pane="needs"\]\) \{\n    flex: 1 0 auto; width: 100%;\n    display: flex; flex-direction: column;\n    padding-bottom: var\(--ws-gap\);\n  \}/);
  assert.match(block, /#workshop-screen \[data-workshop-pane="needs"\] \{\n    flex: 1 0 auto;\n    display: flex; flex-direction: column;\n  \}/);
  assert.match(block, /#workshop-screen \[data-workshop-pane="needs"\] > \.workshop-needs-feed \{ flex: 1 0 0px; \}/);
  assert.doesNotMatch(block, /min-height: 0|flex-shrink: 1|flex: 1 1/, 'no link may shrink');
  // The desktop keeps its own line, 8px off the floor, with no strip there.
  assert.match(css, /@media \(min-width: 768px\) \{[^@]*?\.workshop-needs-feed \{ height: calc\(100dvh - 124px - var\(--browser-banner-h, 0px\)\); \}/);

  // What the chain stands on. The markup the selectors walk: the screen, its
  // one column, then the pane with the feed in it.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /id="workshop-screen"\s+className="hidden flex-1 overflow-y-auto platform-safe-scroll"/,
    'the screen scrolls itself and carries the clearance');
  assert.match(screen, /style=\{\{ position: 'relative' \}\}\s*>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="max-w-2xl mx-auto pb-8" data-workshop-panes="">/,
    'its first element is the column');
  // v3: the feed is its own page at every width again, as on a phone; from
  // 1024px it was drawn beside the list (D) until the sidebar nested its
  // second columns.
  assert.match(screen, /\{state\.tab === 'needs' \? \(\n\s*<div data-workshop-pane="needs">/);
  // And the clearance counts the strip: one token for the bar and the strip,
  // read by every screen through .platform-safe-scroll.
  assert.match(css, /\.platform-safe-scroll \{[^}]*padding-bottom: max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\) !important;/);
  assert.match(css, /html:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\n  --platform-tabs-h: calc\(52px \+ 56px \+ var\(--platform-tabs-inset, 0px\)\);/);
  // Communities is not a page the document scrolls in a phone browser, which
  // is why its root is a bounded scroller in both layouts.
  assert.match(read('frontend/src/lib/browser-scroll.ts'),
    /const PAGES = \['home-screen', 'leaderboard-screen', 'profile-screen', 'settings-screen'\];/);
});

test('#3270: the feed reads the owed populations for member projects only, newest first, bounded', () => {
  const sql = route.NEEDS_FEED_SQL;
  assert.match(sql, /EXISTS \(SELECT 1 FROM community_members cm\s+WHERE cm\.community_id = a\.community_id AND cm\.user_id = \$1\)/,
    'a vote is a member\'s, so the feed is the viewer\'s projects');
  assert.match(sql, /ORDER BY o\.at DESC NULLS LAST, o\.id DESC\s+LIMIT \$4/, 'mixed by recency, not grouped by project');
  assert.match(sql, /cs\.approval_epoch AS epoch/);
  assert.ok(route.NEEDS_FEED_MAX > 0 && route.NEEDS_FEED_MAX <= 100);
  const shaped = route.shapeNeedsFeed([{
    slug: 'garden', name: 'Garden', icon_image_id: 'abc', icon_emoji: null,
    kind: 'proposal', id: '8', title: 'Sort', summary: '  ', author: 'ada', number: 12, epoch: 3,
    at: new Date('2026-09-20T10:00:00Z'), yes: 2, no: 0,
  }]);
  assert.deepEqual(shaped, [{
    kind: 'proposal', id: 8, title: 'Sort', summary: null, author: 'ada', number: 12, epoch: 3,
    at: '2026-09-20T10:00:00.000Z', yes: 2, no: 0,
    // A proposal row without a live preview says so (feedStagingUrl).
    staging_url: null,
    app: { slug: 'garden', name: 'Garden', icon_url: '/app-icons/abc', icon_emoji: null },
  }]);
  // ?demo=1 on staging: the real rows first, then the demo cards, never twice.
  const real = [{ kind: 'proposal', id: 1, app: { slug: 'x' } }];
  const merged = route.withDemoNeedsFeed(real);
  assert.equal(merged[0], real[0]);
  assert.equal(merged.length, 1 + route.DEMO_NEEDS_FEED.length);
  assert.ok(route.DEMO_NEEDS_FEED.every((it) => it.id < 0), 'a demo card can never vote on a real proposal');
  assert.ok(route.DEMO_NEEDS_FEED.some((it) => it.kind === 'governance'));
});

test('#3271, #852: the Communities screen\'s header is its switcher, at every width', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  // Up to the sidebar of rows (D, 18 Oct 2026), which lists the
  // communities itself: there the title is the screen's name.
  assert.match(header, /const allAppsSwitcher = screen === 'workshop-screen' && !sidebarRows;/);
  assert.match(header, /id="header-scope-switch"[\s\S]{0,400}aria-controls="community-switcher"[\s\S]{0,200}onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/,
    'it opens Your communities (#852)');
  assert.doesNotMatch(header, /usePhone|PHONE_QUERY/, 'no width in it any more');
  // The in-page chip is gone: the bar is the one place it lives.
  assert.doesNotMatch(read('frontend/src/features/workshop/index.tsx'), /AllAppsScope|id="workshop-scope"/);
  assert.doesNotMatch(read('public/css/app.css'), /#workshop-scope\b/);
});
