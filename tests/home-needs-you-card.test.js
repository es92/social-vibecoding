'use strict';

// Home's Needs you card: the second card of Home's side column, under the
// New project card, from 1280px.
//
//   1. It is drawn only while a vote waits on the viewer (the count Home's
//      Needs you tile and the tab badge read), and it is one link to Needs
//      you (`#needs`).
//   2. Its numbers come from the Needs you feed, read only where the column
//      is displayed: how many votes decide, how many are advisory, and the
//      communities that wait.
//   3. Zero says nothing: no advisory part when there is none.
//
// Run with: node --test tests/home-needs-you-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/needs-you-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const item = (id, slug, extra = {}) => ({
  kind: 'proposal', id, title: `Change ${id}`, app: { slug, name: slug.toUpperCase() }, ...extra,
});

test('the island mounts it under Standard (WIP) and the brand look, in a row of its own before Challenges', () => {
  const island = read('frontend/src/features/home/index.tsx');
  // The brand look takes the same row (Drea's review of #6699).
  // Standard (WIP) mounts it as soon as the look and the viewer are known, so its
  // place is held from the first paint; the brand look mounts it with the grid.
  assert.match(island, /const aside = wip \? viewer : brand && grid\.ready && !!grid\.create;/);
  assert.match(island, /\{wip \|\| brand \? \(\s*<div id="home-row" className="home-row">\s*\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NeedsYouCard \/>\s*<\/aside>\s*\) : null\}\s*<ChallengesSection \/>\s*<\/div>\s*\) : null\}/);
  assert.match(island, /\{wip \|\| brand \? null : <ChallengesSection \/>\}/, 'every other look keeps Challenges in its own place');
  // A row of its own, as wide as the column, placed right under Pinned projects.
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin-wip\] \.home-row > \.home-aside > \* \{ flex: 1 1 auto; min-width: 0; \}/);
  assert.match(css, /html\[data-skin-wip\] #home-screen \.home-main > \.home-row \{ display: contents; \}/);
  assert.match(css, /html\[data-skin-wip\] #home-screen \.home-row > \.home-aside \{ order: 1; \}/);
});

test('it is a section as Pinned projects is: its label line on the page, then one card, drawn from the waiting count', () => {
  const src = read(CARD);
  assert.match(src, /const \{ badgeNeeds \} = useStoreState\(communityScopeStore\)/);
  assert.match(src, /if \(!summary\) return null;/);
  assert.match(src, /<section id="home-needs-card" aria-label=\{t\('home:needsCard\.eyebrow'\)\} data-needs=\{String\(summary\.total\)\}>/);
  // The label, the count and a chevron are one link to all of Needs you, right after one another.
  assert.match(src, /<SectionHeading>\s*<WipHeadMore\s+id="home-needs-card-btn"\s+direction="right"\s+href="#needs"/);
  assert.match(src, /<span id="home-needs-card-title" className="wip-head-words">\{t\('home:needsCard\.eyebrow'\)\}<\/span>\s*<span className="wip-count" aria-hidden="true">\{summary\.total\}<\/span>\s*<\/WipHeadMore>/);
  assert.match(src, /label=\{more > 0 \? t\('home:needsCard\.seeAllCount', \{ count: summary\.total \}\) : t\('home:needsCard\.seeAll'\)\}/, 'it has no words of its own on screen, so its name says what it opens');
  assert.equal(message('home:needsCard.eyebrow'), 'Needs you');
  assert.equal(message('home:needsCard.seeAll'), 'See all');
  assert.equal(message('home:needsCard.seeAllCount_other'), 'See all {{count}}');
  // The number is a glyph beside the label; a screen reader gets the sentence.
  assert.match(src, /<span className="sr-only">\{t\('home:needsCard\.waiting', \{ count: summary\.total \}\)\}<\/span>/);
  assert.equal(message('home:needsCard.waiting_one'), '{{count}} decision waiting for your vote');
  assert.equal(message('home:needsCard.waiting_other'), '{{count}} decisions waiting for your vote');
  // The card holds the list alone.
  assert.match(src, /<WipCard className="wip-panel" data-tone="ask">\s*<ul className="wip-rows wip-rows-cols"/);
});

test('the feed is read at every width, and again when the count moves', () => {
  const src = read(CARD);
  assert.doesNotMatch(src, /matchMedia/, 'the card is drawn at every width, so nothing waits on one');
  assert.match(src, /if \(!waiting\) \{ setFeed\(null\); return undefined; \}/, 'nothing waits: nothing is read');
  assert.match(src, /sharedJson<\{ items\?: NeedsCardItem\[\] \}>\(`\/api\/workshop\/needs-feed\$\{demoQuery\(\)\}`, \{ fresh: true \}\)/);
  assert.match(src, /\}, \[waiting, known\]\);/);
  assert.match(src, /if \(!known\) return undefined;/, 'the list is read once the count is this load\'s own, not on the remembered one');
});

test('while the list is on its way the card holds its place, from what the last visit saw', () => {
  const src = read(CARD);
  const { NEEDS_HINT_KEY } = loadTsx(CARD);
  assert.equal(NEEDS_HINT_KEY, 'homeroom:needs-waiting');
  // The count of the last visit stands in until this load's is known, and is kept once it is.
  assert.match(src, /const \[hint\] = useState\(readNeedsHint\);/);
  assert.match(src, /const waiting = Math\.max\(0, known \? Number\(badgeNeeds\) \|\| 0 : hint\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(known\) writeNeedsHint\(Number\(badgeNeeds\) \|\| 0\); \}, \[known, badgeNeeds\]\);/);
  // Zero is removed, so somebody with nothing waiting gets no placeholder to flash and go.
  assert.match(src, /if \(count > 0\) window\.localStorage\.setItem\(NEEDS_HINT_KEY, String\(count\)\);\s*else window\.localStorage\.removeItem\(NEEDS_HINT_KEY\);/);
  // As many placeholder rows as wait, in the list's own columns, said once in words.
  assert.match(src, /\{!feed \? \(/);
  assert.match(src, /<WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label=\{t\('home:grid\.loading'\)\}>/);
  assert.match(src, /Array\.from\(\{ length: Math\.min\(summary\.total, NEEDS_ROWS\) \}, \(_, i\) => <li key=\{i\}><WipSkelRow \/><\/li>\)/);
});

test('the numbers: the count until the feed is read, then the feed\'s own split', () => {
  const { needsSummary, decides } = loadTsx(CARD);
  assert.equal(needsSummary(0, null), null, 'nothing waits: no card');
  assert.deepEqual(needsSummary(3, null), { total: 3, decide: 0, advisory: 0 }, 'the count alone, before the feed');
  assert.equal(needsSummary(3, []), null, 'a feed that came back empty: nothing to open');
  const feed = [item(1, 'a'), item(2, 'a', { advisory: true }), item(3, 'b', { uncounted: true }), item(4, 'c')];
  assert.deepEqual(needsSummary(9, feed), { total: 4, decide: 2, advisory: 2 }, 'the two parts add up to the total');
  assert.equal(decides(feed[0]), true);
  assert.equal(decides(feed[1]), false, 'outside the deciders');
  assert.equal(decides(feed[2]), false, 'a vote recorded but not counted');
});

test('the icons are the communities that wait: once each, in order, four at most', () => {
  const { waitingApps } = loadTsx(CARD);
  const feed = [item(1, 'a'), item(2, 'a'), item(3, 'b'), { kind: 'question', id: 4, title: 'q', app: null },
    item(5, 'c'), item(6, 'd'), item(7, 'e')];
  assert.deepEqual(waitingApps(feed).map((app) => app.slug), ['a', 'b', 'c', 'd']);
  assert.deepEqual(waitingApps(null), []);
});

test('what waits is a list in the look\'s columns, each row opening its project\'s Needs you', () => {
  const src = read(CARD);
  const { NEEDS_ROWS } = loadTsx(CARD);
  assert.equal(NEEDS_ROWS, 8, 'two lines of four on a wide screen; See all has the rest');
  assert.match(src, /<ul className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">/);
  assert.match(src, /href=\{slug \? placeHref\(slug, 'needs'\) : '#needs'\}/, 'a row is a link a new tab can open');
  assert.match(src, /win\.AppView\?\._landOnTab\?\.\(slug, 'needs'\);[\s\S]*?win\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/, 'and a plain tap lands on that place');
  // One pill a row: filled when the viewer's vote decides, plain when it is advisory.
  assert.match(src, /className=\{decides\(item\) \? 'wip-pill wip-pill-action' : 'wip-pill'\}/);
  assert.equal(message('home:needsCard.vote'), 'Vote');
  assert.equal(message('home:needsCard.advisoryPill'), 'Advisory');
  // As many columns as the look has room for, the number Challenges' cards read too.
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-rows-cols \{ grid-template-columns: repeat\(var\(--wip-cols, 1\), minmax\(0, 1fr\)\);/);
  // Four from 1024px, where Pinned projects' own four columns become rows: the lists share their lines.
  for (const [at, n] of [['640px', 2], ['1024px', 4]]) {
    assert.match(css, new RegExp(`@media \\(min-width: ${at}\\) \\{ html\\[data-skin-wip\\] \\{ --wip-cols: ${n}; \\} \\}`));
  }
  assert.match(css, /\.wip-poster \{\s*display: flex;\s*flex: 0 0 calc\(\(100% - \(var\(--wip-cols, 1\) - 1\) \* var\(--wip-col-gap\)\) \/ var\(--wip-cols, 1\)\);/, 'a challenge is one of the same columns');
});

test('a challenge is its picture, then its words beside it, in a row that pages with an arrow at each end', () => {
  const src = read('frontend/src/features/home/panels/challenges.tsx');
  assert.match(src, /className="wip-poster"[\s\S]{0,400}<WipChallengeArt[\s\S]{0,200}<span className="wip-item-text">/, 'the picture first, the words in their own column');
  // An arrow is drawn only while there is more that way, and names where it goes.
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-back" aria-label=\{t\('home:challenges\.scrollBack'\)\} onClick=\{\(\) => page\(-1\)\}/);
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-on" aria-label=\{t\('home:challenges\.scrollOn'\)\} onClick=\{\(\) => page\(1\)\}/);
  assert.equal(message('home:challenges.scrollBack'), 'Earlier challenges');
  assert.equal(message('home:challenges.scrollOn'), 'More challenges');
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-poster-art \{[^}]*width: var\(--wip-poster-art\);[^}]*height: var\(--wip-poster-art\);/);
  // A row and a poster keep a project tile's own padding, so the three lists' icons start on the same lines.
  assert.match(css, /\.wip-row \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
  assert.match(css, /\.wip-poster \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
});

test('the brand kit V2 tokens use yellow and green as marks, never as a row\'s ground, and a project\'s name is one size', () => {
  const css = read('public/css/app.css');
  const at = css.indexOf('html[data-skin-wip][data-wip-tokens="brand2"] {');
  const v2 = css.slice(at, css.indexOf('}', at));
  assert.match(v2, /--wip-label-mark: #ffee6f;/, 'yellow is the stroke under a title');
  assert.match(v2, /--wip-worth-bg: rgb\(169 207 151 \/ 0\.5\);/, 'green is the tag behind a challenge\'s points');
  assert.match(v2, /--wip-pill-bg: #000000;\s*--wip-pill-ink: #fffeea;/, 'what is pressed is cream on black');
  assert.doesNotMatch(v2, /--wip-(ask|goal)-bg/, 'no block of colour behind Needs you or Challenges');
  // The stroke is on a title's words alone: the kit gives plain words their own span.
  assert.match(read('frontend/src/features/home/wip-kit.tsx'), /typeof children === 'string' \? <span className="wip-head-words">\{children\}<\/span> : children/);
  // A plain pill in a card that asks reads the card's own ink (Advisory was pale on yellow in the dark).
  assert.match(css, /--wip-ink-soft: var\(--wip-ask-ink\);/);
  // One size at every width, outside any media query.
  assert.match(css, /\nhtml\[data-skin-wip\] #app-list \.app-card-title \{\s*font-size: var\(--wip-title-size\);/, 'at the start of a line: not inside a media query');
});
